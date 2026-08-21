--[[ Tests for the game logic that does not need a running Roblox engine. ]]

local passed = 0
local failed = 0
local currentSuite = ""

local function suite(name)
	currentSuite = name
	print("\n" .. name)
end

local function check(label, condition, detail)
	if condition then
		passed += 1
		print("  ok   " .. label)
	else
		failed += 1
		print("  FAIL " .. label .. (if detail then "  (" .. tostring(detail) .. ")" else ""))
	end
end

local function equal(label, actual, expected)
	check(label, actual == expected, string.format("got %s, expected %s", tostring(actual), tostring(expected)))
end

local BlockRegistry = __require("BlockRegistry")
local Chunk = __require("Chunk")
local ChunkCodec = __require("ChunkCodec")
local ChunkMesher = __require("ChunkMesher")
local Coordinates = __require("Coordinates")
local Inventory = __require("Inventory")
local ItemRegistry = __require("ItemRegistry")
local Recipes = __require("Recipes")
local Signal = __require("Signal")
local TerrainGenerator = __require("TerrainGenerator")
local VoxelRaycast = __require("VoxelRaycast")
local WorldConfig = __require("WorldConfig")

-- Coordinates -----------------------------------------------------------------
suite("Coordinates")
do
	local roundTrips = true
	for _, point in { { 0, 0, 0 }, { 15, 63, 15 }, { 7, 30, 2 }, { 1, 1, 14 } } do
		local index = Coordinates.index(point[1], point[2], point[3])
		local x, y, z = Coordinates.fromIndex(index)
		if x ~= point[1] or y ~= point[2] or z ~= point[3] then
			roundTrips = false
		end
	end
	check("index <-> fromIndex round trips", roundTrips)

	local indices = {}
	local unique = true
	for y = 0, WorldConfig.WorldHeight - 1 do
		for z = 0, WorldConfig.ChunkSizeZ - 1 do
			for x = 0, WorldConfig.ChunkSizeX - 1 do
				local index = Coordinates.index(x, y, z)
				if indices[index] then
					unique = false
				end
				indices[index] = true
			end
		end
	end
	check("every voxel maps to its own index", unique)

	equal("chunkOf handles negatives", Coordinates.chunkOf(-1, -17), -1)
	local _, cz = Coordinates.chunkOf(-1, -17)
	equal("chunkOf rounds down on z", cz, -2)

	local lx, lz = Coordinates.localOf(-1, -17)
	equal("localOf stays in range on x", lx, 15)
	equal("localOf stays in range on z", lz, 15)

	local world = Coordinates.voxelToWorld(3, 4, 5)
	local vx, vy, vz = Coordinates.worldToVoxel(world)
	check("world space round trips", vx == 3 and vy == 4 and vz == 5, tostring(world))

	local key = Coordinates.chunkKey(-3, 12)
	local kx, kz = Coordinates.parseChunkKey(key)
	check("chunk keys parse back", kx == -3 and kz == 12, key)
end

-- Chunk -----------------------------------------------------------------------
suite("Chunk")
do
	local chunk = Chunk.new(2, -1)
	local stone = BlockRegistry.id("Stone")

	chunk:setRaw(1, 1, 1, stone)
	equal("setRaw stores the block", chunk:get(1, 1, 1), stone)
	check("setRaw is not an edit", not chunk:hasEdits())

	chunk:set(2, 5, 3, stone)
	equal("set stores the block", chunk:get(2, 5, 3), stone)
	check("set records an edit", chunk:hasEdits())
	check("set marks the chunk dirty", chunk.dirty)
	equal("height tracks the top block", chunk:height(2, 3), 5)

	chunk:set(2, 5, 3, BlockRegistry.Air)
	equal("clearing a column drops its height", chunk:height(2, 3), -1)

	equal("out of bounds reads are air", chunk:get(-1, 0, 0), 0)
	chunk:set(99, 99, 99, stone)
	check("out of bounds writes are ignored", true)

	local edited = Chunk.new(2, -1)
	edited:set(4, 7, 9, stone)

	local replica = Chunk.new(2, -1)
	replica:applyEdits(edited.edits)
	equal("edits replay onto another chunk", replica:get(4, 7, 9), stone)
	equal("replaying rebuilds the height map", replica:height(4, 9), 7)
end

-- ChunkCodec ------------------------------------------------------------------
suite("ChunkCodec")
do
	local chunk = Chunk.new(0, 0)
	TerrainGenerator.generate(chunk)

	local payload = ChunkCodec.encode(chunk)
	local decoded = ChunkCodec.decode(0, 0, payload)
	check("a generated chunk decodes", decoded ~= nil)

	local identical = true
	if decoded then
		for index = 0, Coordinates.VolumePerChunk - 1 do
			if buffer.readu8(decoded.blocks, index) ~= buffer.readu8(chunk.blocks, index) then
				identical = false
				break
			end
		end
	end
	check("round trip preserves every voxel", identical)

	local raw = Coordinates.VolumePerChunk
	check(
		string.format("encoding shrinks the chunk (%d -> %d bytes)", raw, #payload),
		#payload < raw / 8
	)

	check("a truncated payload is rejected", ChunkCodec.decode(0, 0, string.sub(payload, 1, 7)) == nil)
	check("a payload of the wrong length is rejected", ChunkCodec.decode(0, 0, "xx") == nil)

	local edits = { [5] = 3, [900] = 7 }
	local encodedEdits = ChunkCodec.decodeEdits(ChunkCodec.encodeEdits(edits))
	check("edits round trip", encodedEdits[5] == 3 and encodedEdits[900] == 7)
end

-- Terrain ---------------------------------------------------------------------
suite("TerrainGenerator")
do
	local first = Chunk.new(3, 4)
	local second = Chunk.new(3, 4)
	TerrainGenerator.generate(first)
	TerrainGenerator.generate(second)

	local deterministic = true
	for index = 0, Coordinates.VolumePerChunk - 1 do
		if buffer.readu8(first.blocks, index) ~= buffer.readu8(second.blocks, index) then
			deterministic = false
			break
		end
	end
	check("the same chunk generates identically twice", deterministic)

	check("the chunk is not empty", not first:isEmpty())
	check("generation records no edits", not first:hasEdits())

	local bedrockEverywhere = true
	local surfaceInRange = true
	local solidGround = true

	for lx = 0, WorldConfig.ChunkSizeX - 1 do
		for lz = 0, WorldConfig.ChunkSizeZ - 1 do
			if first:get(lx, 0, lz) ~= BlockRegistry.id("Bedrock") then
				bedrockEverywhere = false
			end

			local height = first:height(lx, lz)
			if height < WorldConfig.MinSurface or height >= WorldConfig.WorldHeight then
				surfaceInRange = false
			end

			-- No floating column: there is something under the top block.
			if first:get(lx, math.max(height - 1, 0), lz) == BlockRegistry.Air then
				solidGround = false
			end
		end
	end

	check("bedrock covers the bottom layer", bedrockEverywhere)
	check("every column tops out in range", surfaceInRange)
	check("no column floats above a hole", solidGround)

	local heights = {}
	for x = -40, 40, 8 do
		table.insert(heights, TerrainGenerator.heightAt(x, 0))
	end
	local varies = false
	for _, height in heights do
		if height ~= heights[1] then
			varies = true
		end
	end
	check("terrain height actually varies", varies)

	check("spawn height is above the surface", TerrainGenerator.spawnHeight(0, 0) > TerrainGenerator.heightAt(0, 0))
end

-- Meshing ---------------------------------------------------------------------
suite("ChunkMesher")
do
	local chunk = Chunk.new(0, 0)
	local stone = BlockRegistry.id("Stone")

	-- A solid 4 x 1 x 4 slab: one box, because every block shares a face.
	for lx = 0, 3 do
		for lz = 0, 3 do
			chunk:setRaw(lx, 10, lz, stone)
		end
	end
	chunk:buildHeightMap()

	local function blockAt(x, y, z)
		if x < 0 or x > 15 or z < 0 or z > 15 then
			return BlockRegistry.Air
		end
		return chunk:get(x, y, z)
	end

	local boxes = ChunkMesher.build(chunk, blockAt)
	equal("a flat slab merges into one box", #boxes, 1)
	if boxes[1] then
		check("the box covers the slab", boxes[1].sizeX == 4 and boxes[1].sizeY == 1 and boxes[1].sizeZ == 4,
			string.format("%dx%dx%d", boxes[1].sizeX, boxes[1].sizeY, boxes[1].sizeZ))
	end

	-- A solid cube: only the shell is visible, the middle is never drawn.
	local cube = Chunk.new(0, 0)
	for lx = 0, 5 do
		for ly = 5, 10 do
			for lz = 0, 5 do
				cube:setRaw(lx, ly, lz, stone)
			end
		end
	end
	cube:buildHeightMap()

	local function cubeAt(x, y, z)
		if x < 0 or x > 15 or z < 0 or z > 15 then
			return BlockRegistry.Air
		end
		return cube:get(x, y, z)
	end

	local cubeBoxes = ChunkMesher.build(cube, cubeAt)
	local covered = 0
	local seen = {}
	local overlaps = false

	for _, box in cubeBoxes do
		for x = box.x, box.x + box.sizeX - 1 do
			for y = box.y, box.y + box.sizeY - 1 do
				for z = box.z, box.z + box.sizeZ - 1 do
					local key = string.format("%d,%d,%d", x, y, z)
					if seen[key] then
						overlaps = true
					end
					seen[key] = true
					covered += 1
				end
			end
		end
	end

	check("boxes never overlap", not overlaps)
	check(
		string.format("the hidden core is culled (%d of 216 blocks drawn)", covered),
		covered < 216 and covered >= 152
	)

	local realChunk = Chunk.new(1, 1)
	TerrainGenerator.generate(realChunk)
	local originX, originZ = Coordinates.chunkOrigin(1, 1)
	local realBoxes = ChunkMesher.build(realChunk, function(x, y, z)
		return realChunk:get(x - originX, y, z - originZ)
	end)
	check(
		string.format("a generated chunk meshes into %d parts, not %d blocks", #realBoxes, Coordinates.VolumePerChunk),
		#realBoxes > 0 and #realBoxes < 2000
	)
end

-- Raycasting ------------------------------------------------------------------
suite("VoxelRaycast")
do
	local solid = { ["5,2,0"] = true }
	local function isSolid(x, y, z)
		return solid[string.format("%d,%d,%d", x, y, z)] == true
	end

	local scale = WorldConfig.BlockSize
	local origin = Vector3.new(0.5 * scale, 2.5 * scale, 0.5 * scale)
	local hit = VoxelRaycast.cast(isSolid, origin, Vector3.new(1, 0, 0), 40)

	check("the ray finds the block", hit ~= nil)
	if hit then
		check("it hits the right cell", hit.x == 5 and hit.y == 2 and hit.z == 0,
			string.format("%d,%d,%d", hit.x, hit.y, hit.z))
		check("the previous cell is the one before it", hit.previousX == 4 and hit.previousY == 2 and hit.previousZ == 0)
		check("the normal faces the ray", hit.normal.X == -1 and hit.normal.Y == 0 and hit.normal.Z == 0)
		check("the distance is about right", math.abs(hit.distance - 4.5 * scale) < scale)
	end

	check("nothing is hit through empty space", VoxelRaycast.cast(isSolid, origin, Vector3.new(0, 1, 0), 40) == nil)
	check("range is respected", VoxelRaycast.cast(isSolid, origin, Vector3.new(1, 0, 0), scale * 2) == nil)

	local diagonal = VoxelRaycast.cast(function(x, y, z)
		return x == 3 and y == 5 and z == 3
	end, Vector3.new(0.5 * scale, 2.5 * scale, 0.5 * scale), Vector3.new(1, 1, 1), 60)
	check("a diagonal ray still lands on a cell", diagonal ~= nil)
end

-- Items and breaking ----------------------------------------------------------
suite("ItemRegistry")
do
	local stone = BlockRegistry.id("Stone")
	local bare = ItemRegistry.breakTime(stone, nil)
	local wooden = ItemRegistry.breakTime(stone, ItemRegistry.id("WoodenPickaxe"))
	local diamond = ItemRegistry.breakTime(stone, ItemRegistry.id("DiamondPickaxe"))

	check("a pickaxe beats bare hands on stone", wooden < bare, string.format("%.2f vs %.2f", wooden, bare))
	check("a better pickaxe is faster still", diamond < wooden)
	check("the wrong tool is no faster", ItemRegistry.breakTime(stone, ItemRegistry.id("WoodenAxe")) == bare)
	check("bedrock never breaks", ItemRegistry.breakTime(BlockRegistry.id("Bedrock"), ItemRegistry.id("DiamondPickaxe")) == math.huge)

	local diamondOre = BlockRegistry.id("DiamondOre")
	check("bare hands do not harvest diamond", not ItemRegistry.canHarvest(diamondOre, nil))
	check("a wooden pickaxe does not harvest diamond", not ItemRegistry.canHarvest(diamondOre, ItemRegistry.id("WoodenPickaxe")))
	check("an iron pickaxe does harvest diamond", ItemRegistry.canHarvest(diamondOre, ItemRegistry.id("IronPickaxe")))
	check("dirt needs no tool", ItemRegistry.canHarvest(BlockRegistry.id("Dirt"), nil))

	check("every block item shares its block id", ItemRegistry.get(stone) ~= nil and ItemRegistry.get(stone).blockId == stone)
	check("air is not an item", not ItemRegistry.exists(BlockRegistry.Air))
end

-- Inventory -------------------------------------------------------------------
suite("Inventory")
do
	local dirt = ItemRegistry.id("Dirt")
	local stone = ItemRegistry.id("Stone")

	local inventory = Inventory.new(9)
	equal("adding fits in one slot", inventory:add(dirt, 30), 0)
	equal("the stack landed in slot 1", inventory:get(1).count, 30)

	inventory:add(dirt, 40)
	equal("a partial stack fills up first", inventory:get(1).count, WorldConfig.StackSize)
	equal("the rest spills over", inventory:get(2).count, 70 - WorldConfig.StackSize)

	local small = Inventory.new(1)
	equal("a full inventory reports the leftover", small:add(dirt, 100), 100 - WorldConfig.StackSize)
	check("a full inventory has no room", not small:hasRoomFor(stone, 1))

	equal("remove takes from the end", inventory:remove(dirt, 10), 10)
	equal("counting sums every slot", inventory:countOf(dirt), 60)

	-- Click semantics.
	local bag = Inventory.new(9)
	bag:set(1, { id = dirt, count = 20 })

	bag:click(1, 1)
	check("a left click picks the stack up", bag.cursor ~= nil and bag.cursor.count == 20)
	check("the slot is now empty", bag:get(1) == nil)

	bag:click(2, 1)
	check("a left click puts it back down", bag:get(2) ~= nil and bag:get(2).count == 20)
	check("the cursor is empty again", bag.cursor == nil)

	bag:click(2, 2)
	check("a right click takes half", bag.cursor ~= nil and bag.cursor.count == 10)
	equal("and leaves half", bag:get(2).count, 10)

	bag:click(3, 2)
	equal("a right click places one", bag:get(3).count, 1)
	equal("and keeps the rest", bag.cursor.count, 9)

	bag:set(4, { id = stone, count = 5 })
	bag:click(4, 1)
	check("clicking a different item swaps", bag:get(4) ~= nil and bag:get(4).id == dirt)
	check("the other item is now held", bag.cursor ~= nil and bag.cursor.id == stone)

	local merge = Inventory.new(9)
	merge:set(1, { id = dirt, count = WorldConfig.StackSize })
	merge.cursor = { id = dirt, count = 5 }
	check("a click on a full stack of the same item does nothing", not merge:click(1, 1))
	equal("and nothing is lost", merge.cursor.count, 5)

	-- Quick move between the hotbar and storage.
	local moving = Inventory.new(36)
	moving:set(1, { id = dirt, count = 12 })
	check("quick move finds a home", moving:quickMove(1, 10, 36))
	check("the source is empty", moving:get(1) == nil)
	check("the target holds the stack", moving:get(10) ~= nil and moving:get(10).count == 12)

	-- Serialisation.
	local saved = moving:serialize()
	local restored = Inventory.new(36)
	restored:deserialize(saved)
	check("a saved inventory restores", restored:get(10) ~= nil and restored:get(10).count == 12)

	local hostile = Inventory.new(36)
	hostile:deserialize({ { 1, 999999, 500 }, { 99, dirt, 5 }, { 2, dirt, 9999 } })
	check("unknown items are dropped on load", hostile:get(1) == nil)
	check("out of range slots are dropped on load", hostile:get(99) == nil)
	equal("oversized stacks are clamped", hostile:get(2).count, WorldConfig.StackSize)
end

-- Crafting --------------------------------------------------------------------
suite("Recipes")
do
	local function emptyGrid()
		return { nil, nil, nil, nil, nil, nil, nil, nil, nil }
	end

	local log = ItemRegistry.id("Log")
	local planks = ItemRegistry.id("Planks")
	local stick = ItemRegistry.id("Stick")
	local cobble = ItemRegistry.id("Cobblestone")

	local grid = emptyGrid()
	grid[5] = log
	local recipe = Recipes.match(grid)
	check("one log makes planks", recipe ~= nil and recipe.resultId == planks)
	equal("four of them", recipe.resultCount, 4)

	grid = emptyGrid()
	grid[1] = planks
	grid[4] = planks
	local sticks = Recipes.match(grid)
	check("two stacked planks make sticks", sticks ~= nil and sticks.resultId == stick)

	-- The same shape anywhere in the grid is the same recipe.
	grid = emptyGrid()
	grid[5] = planks
	grid[8] = planks
	local moved = Recipes.match(grid)
	check("the shape is matched wherever it sits", moved ~= nil and moved.resultId == stick)

	grid = emptyGrid()
	grid[1] = planks
	grid[2] = planks
	local sideways = Recipes.match(grid)
	check("rotating the shape is a different recipe", sideways == nil or sideways.resultId ~= stick)

	grid = emptyGrid()
	grid[1] = cobble
	grid[2] = cobble
	grid[3] = cobble
	grid[5] = stick
	grid[8] = stick
	local pickaxe = Recipes.match(grid)
	check("cobble and sticks make a stone pickaxe", pickaxe ~= nil and pickaxe.resultId == ItemRegistry.id("StonePickaxe"))

	grid[9] = cobble
	check("a stray ingredient breaks the recipe", Recipes.match(grid) == nil)

	check("an empty grid makes nothing", Recipes.match(emptyGrid()) == nil)

	local reachable = 0
	for _, entry in Recipes.all() do
		if entry.resultId then
			reachable += 1
		end
	end
	check(string.format("%d recipes are defined", reachable), reachable >= 18)
end

-- Signal ----------------------------------------------------------------------
suite("Signal")
do
	local signal = Signal.new()
	local seen = {}

	local connection = signal:connect(function(value)
		table.insert(seen, value)
	end)
	signal:fire("a")
	connection:disconnect()
	signal:fire("b")

	equal("a handler receives what is fired", seen[1], "a")
	equal("a disconnected handler stops", #seen, 1)

	local safe = Signal.new()
	safe:connect(function()
		error("boom")
	end)
	local after = false
	safe:connect(function()
		after = true
	end)
	safe:fire()
	check("one failing handler does not stop the others", after)
end

-- Summary ---------------------------------------------------------------------
print(string.format("\n%d passed, %d failed", passed, failed))
if failed > 0 then
	error(string.format("%d test(s) failed", failed), 0)
end
