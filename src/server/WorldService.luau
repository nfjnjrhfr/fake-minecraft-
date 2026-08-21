--!strict
--[[
	The authoritative world. Holds the loaded chunks, generates them on demand,
	and is the only place a block ever changes.
]]

local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Shared = ReplicatedStorage:WaitForChild("FakeMinecraft")
local BlockRegistry = require(Shared:WaitForChild("BlockRegistry"))
local Chunk = require(Shared:WaitForChild("Chunk"))
local Coordinates = require(Shared:WaitForChild("Coordinates"))
local Signal = require(Shared:WaitForChild("Signal"))
local TerrainGenerator = require(Shared:WaitForChild("TerrainGenerator"))
local WorldConfig = require(Shared:WaitForChild("WorldConfig"))

local Persistence = require(script.Parent.PersistenceService)

local WorldService = {}

local chunks: { [string]: Chunk.Chunk } = {}
local loading: { [string]: boolean } = {}

WorldService.blockChanged = Signal.new()
WorldService.chunkLoaded = Signal.new()

function WorldService.isChunkLoaded(cx: number, cz: number): boolean
	return chunks[Coordinates.chunkKey(cx, cz)] ~= nil
end

function WorldService.getLoadedChunk(cx: number, cz: number): Chunk.Chunk?
	return chunks[Coordinates.chunkKey(cx, cz)]
end

--[[
	Loads a chunk, generating it and replaying its saved player edits. Yields on
	first load because it hits the datastore, so callers must be in a coroutine.
]]
function WorldService.ensureChunk(cx: number, cz: number): Chunk.Chunk
	local key = Coordinates.chunkKey(cx, cz)

	local existing = chunks[key]
	if existing then
		return existing
	end

	-- Another coroutine got here first; wait for it rather than generating twice.
	if loading[key] then
		repeat
			task.wait()
		until chunks[key] or not loading[key]

		local loaded = chunks[key]
		if loaded then
			return loaded
		end
	end

	loading[key] = true

	local chunk = Chunk.new(cx, cz)
	TerrainGenerator.generate(chunk)

	local edits = Persistence.loadChunkEdits(cx, cz)
	if edits and next(edits) then
		chunk:applyEdits(edits)
	end

	chunks[key] = chunk
	loading[key] = nil

	WorldService.chunkLoaded:fire(chunk)
	return chunk
end

function WorldService.getBlock(x: number, y: number, z: number): number
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

function WorldService.isSolid(x: number, y: number, z: number): boolean
	return BlockRegistry.isSolid(WorldService.getBlock(x, y, z))
end

--[[ Returns false when the chunk is not loaded or the block is unchanged. ]]
function WorldService.setBlock(x: number, y: number, z: number, blockId: number): boolean
	if y < 0 or y >= WorldConfig.WorldHeight then
		return false
	end
	if not BlockRegistry.exists(blockId) then
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
	WorldService.blockChanged:fire(x, y, z, blockId)
	return true
end

function WorldService.unloadChunk(cx: number, cz: number)
	local key = Coordinates.chunkKey(cx, cz)
	local chunk = chunks[key]
	if not chunk then
		return
	end

	if chunk.dirty then
		Persistence.saveChunkEdits(chunk)
	end
	chunks[key] = nil
end

function WorldService.saveDirtyChunks()
	for _, chunk in chunks do
		if chunk.dirty then
			Persistence.saveChunkEdits(chunk)
		end
	end
end

function WorldService.eachChunk(callback: (chunk: Chunk.Chunk) -> ())
	for _, chunk in chunks do
		callback(chunk)
	end
end

return WorldService
