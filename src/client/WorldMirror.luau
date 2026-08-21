--!strict
--[[
	The client's copy of the world. Chunks arrive encoded from the server; this
	decodes them, answers block lookups for meshing and raycasting, and says
	which chunks need redrawing.
]]

local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Shared = ReplicatedStorage:WaitForChild("FakeMinecraft")
local BlockRegistry = require(Shared:WaitForChild("BlockRegistry"))
local Chunk = require(Shared:WaitForChild("Chunk"))
local ChunkCodec = require(Shared:WaitForChild("ChunkCodec"))
local Coordinates = require(Shared:WaitForChild("Coordinates"))
local Remotes = require(Shared:WaitForChild("Remotes"))
local Signal = require(Shared:WaitForChild("Signal"))
local WorldConfig = require(Shared:WaitForChild("WorldConfig"))

local WorldMirror = {}

local chunks: { [string]: Chunk.Chunk } = {}

WorldMirror.chunkChanged = Signal.new()
WorldMirror.chunkRemoved = Signal.new()

function WorldMirror.getChunk(cx: number, cz: number): Chunk.Chunk?
	return chunks[Coordinates.chunkKey(cx, cz)]
end

function WorldMirror.getBlock(x: number, y: number, z: number): number
	if y < 0 or y >= WorldConfig.WorldHeight then
		return BlockRegistry.Air
	end

	local cx, cz = Coordinates.chunkOf(x, z)
	local chunk = chunks[Coordinates.chunkKey(cx, cz)]
	if not chunk then
		return BlockRegistry.Air
	end

	local lx, lz = Coordinates.localOf(x, z)
	return chunk:get(lx, y, lz)
end

function WorldMirror.isSolid(x: number, y: number, z: number): boolean
	return BlockRegistry.isSolid(WorldMirror.getBlock(x, y, z))
end

function WorldMirror.isLoaded(cx: number, cz: number): boolean
	return chunks[Coordinates.chunkKey(cx, cz)] ~= nil
end

function WorldMirror.loadedCount(): number
	local count = 0
	for _ in chunks do
		count += 1
	end
	return count
end

--[[ Faces on a chunk border depend on the neighbour, so a new or changed chunk
     makes its neighbours stale too. ]]
local function markNeighbours(cx: number, cz: number)
	for _, offset in { { 1, 0 }, { -1, 0 }, { 0, 1 }, { 0, -1 } } do
		local neighbour = chunks[Coordinates.chunkKey(cx + offset[1], cz + offset[2])]
		if neighbour then
			WorldMirror.chunkChanged:fire(neighbour.cx, neighbour.cz)
		end
	end
end

function WorldMirror.start()
	Remotes.get("ChunkData").OnClientEvent:Connect(function(cx: number, cz: number, payload: string)
		local chunk = chunks[Coordinates.chunkKey(cx, cz)] or Chunk.new(cx, cz)

		if not ChunkCodec.decodeInto(chunk, payload) then
			warn(string.format("[WorldMirror] malformed chunk %d,%d", cx, cz))
			return
		end

		chunks[Coordinates.chunkKey(cx, cz)] = chunk
		WorldMirror.chunkChanged:fire(cx, cz)
		markNeighbours(cx, cz)
	end)

	Remotes.get("ChunkUnload").OnClientEvent:Connect(function(cx: number, cz: number)
		local key = Coordinates.chunkKey(cx, cz)
		if chunks[key] then
			chunks[key] = nil
			WorldMirror.chunkRemoved:fire(cx, cz)
			markNeighbours(cx, cz)
		end
	end)

	Remotes.get("BlockUpdate").OnClientEvent:Connect(function(x: number, y: number, z: number, blockId: number)
		WorldMirror.setBlock(x, y, z, blockId)
	end)
end

--[[
	Writes a block locally. The client does this itself the instant a player
	breaks or places, so the world responds without a round trip; the server's
	BlockUpdate then confirms it or puts it back.
]]
function WorldMirror.setBlock(x: number, y: number, z: number, blockId: number): boolean
	if y < 0 or y >= WorldConfig.WorldHeight then
		return false
	end

	local cx, cz = Coordinates.chunkOf(x, z)
	local chunk = chunks[Coordinates.chunkKey(cx, cz)]
	if not chunk then
		return false
	end

	local lx, lz = Coordinates.localOf(x, z)
	if chunk:get(lx, y, lz) == blockId then
		return false
	end

	chunk:set(lx, y, lz, blockId)
	WorldMirror.chunkChanged:fire(cx, cz)

	-- A block on a chunk edge changes the neighbour's visible faces.
	if lx == 0 or lx == WorldConfig.ChunkSizeX - 1 or lz == 0 or lz == WorldConfig.ChunkSizeZ - 1 then
		markNeighbours(cx, cz)
	end

	return true
end

return WorldMirror
