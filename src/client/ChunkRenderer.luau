--!strict
--[[
	Draws the meshed chunks as parts, on a frame budget.

	Rebuilding a chunk allocates nothing in the steady state: parts come from a
	pool and are reconfigured in place, so walking around does not churn
	thousands of Instances.
]]

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local Workspace = game:GetService("Workspace")

local Shared = ReplicatedStorage:WaitForChild("FakeMinecraft")
local BlockRegistry = require(Shared:WaitForChild("BlockRegistry"))
local Coordinates = require(Shared:WaitForChild("Coordinates"))

local ChunkMesher = require(script.Parent.ChunkMesher)
local WorldMirror = require(script.Parent.WorldMirror)

local FRAME_BUDGET = 0.006 -- seconds of meshing per frame
local POOL_LIMIT = 6000

local ChunkRenderer = {}

type Rendered = {
	model: Folder,
	parts: { BasePart },
}

local rendered: { [string]: Rendered } = {}
local queue: { [string]: boolean } = {}
local queueOrder: { string } = {}
local pool: { BasePart } = {}

local container: Folder
local poolContainer: Folder

local function takePart(): BasePart
	local part = table.remove(pool)
	if part then
		return part
	end

	local created = Instance.new("Part")
	created.Anchored = true
	created.CastShadow = false
	created.TopSurface = Enum.SurfaceType.Smooth
	created.BottomSurface = Enum.SurfaceType.Smooth
	return created
end

local function releasePart(part: BasePart)
	if #pool >= POOL_LIMIT then
		part:Destroy()
		return
	end

	part.Parent = poolContainer
	table.insert(pool, part)
end

local function enqueue(key: string)
	if queue[key] then
		return
	end
	queue[key] = true
	table.insert(queueOrder, key)
end

local function applyBox(part: BasePart, box: ChunkMesher.Box)
	local block = BlockRegistry.get(box.blockId)
	if not block then
		return
	end

	local position, size = ChunkMesher.boxToPart(box)

	part.Size = size
	part.Position = position
	part.Name = block.name
	part.Color = block.color
	part.Material = block.material
	part.Transparency = block.transparency
	part.CanCollide = block.collidable
	part.CanQuery = block.collidable
	part.CanTouch = false
end

local function renderChunk(cx: number, cz: number)
	local key = Coordinates.chunkKey(cx, cz)
	local chunk = WorldMirror.getChunk(cx, cz)

	if not chunk then
		ChunkRenderer.unload(cx, cz)
		return
	end

	local boxes = ChunkMesher.build(chunk, WorldMirror.getBlock)

	local existing = rendered[key]
	if not existing then
		local model = Instance.new("Folder")
		model.Name = "Chunk " .. key
		model.Parent = container
		existing = { model = model, parts = {} }
		rendered[key] = existing
	end

	local parts = existing.parts

	for index, box in boxes do
		local part = parts[index]
		if not part then
			part = takePart()
			parts[index] = part
		end
		applyBox(part, box)
		part.Parent = existing.model
	end

	-- Hand back whatever the new mesh did not need.
	for index = #parts, #boxes + 1, -1 do
		releasePart(parts[index])
		parts[index] = nil
	end
end

function ChunkRenderer.unload(cx: number, cz: number)
	local key = Coordinates.chunkKey(cx, cz)
	local existing = rendered[key]
	if not existing then
		return
	end

	for _, part in existing.parts do
		releasePart(part)
	end
	existing.model:Destroy()
	rendered[key] = nil
end

function ChunkRenderer.pendingCount(): number
	return #queueOrder
end

function ChunkRenderer.renderedCount(): number
	local count = 0
	for _ in rendered do
		count += 1
	end
	return count
end

--[[ True once the chunk containing `position` has been drawn: the client tells
     the server this before it lets the player fall. ]]
function ChunkRenderer.hasRendered(cx: number, cz: number): boolean
	return rendered[Coordinates.chunkKey(cx, cz)] ~= nil
end

function ChunkRenderer.start()
	container = Instance.new("Folder")
	container.Name = "VoxelWorld"
	container.Parent = Workspace

	poolContainer = Instance.new("Folder")
	poolContainer.Name = "VoxelWorldPool"
	poolContainer.Parent = Workspace

	WorldMirror.chunkChanged:connect(function(cx: number, cz: number)
		enqueue(Coordinates.chunkKey(cx, cz))
	end)

	WorldMirror.chunkRemoved:connect(function(cx: number, cz: number)
		local key = Coordinates.chunkKey(cx, cz)
		queue[key] = nil
		ChunkRenderer.unload(cx, cz)
	end)

	RunService.RenderStepped:Connect(function()
		local deadline = os.clock() + FRAME_BUDGET

		while #queueOrder > 0 and os.clock() < deadline do
			local key = table.remove(queueOrder, 1) :: string
			if queue[key] then
				queue[key] = nil
				local cx, cz = Coordinates.parseChunkKey(key)
				local ok, err = pcall(renderChunk, cx, cz)
				if not ok then
					warn("[ChunkRenderer] " .. tostring(err))
				end
			end
		end
	end)
end

return ChunkRenderer
