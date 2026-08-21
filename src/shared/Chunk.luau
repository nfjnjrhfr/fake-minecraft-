--!strict
--[[
	A column of the world, 16 x WorldHeight x 16 blocks, stored as one byte per
	voxel in a buffer. A table of that size would cost megabytes per chunk.
]]

local Coordinates = require(script.Parent.Coordinates)
local WorldConfig = require(script.Parent.WorldConfig)

local VOLUME = Coordinates.VolumePerChunk
local HEIGHT = WorldConfig.WorldHeight
local SIZE_X = WorldConfig.ChunkSizeX
local SIZE_Z = WorldConfig.ChunkSizeZ

local Chunk = {}
Chunk.__index = Chunk

export type Chunk = typeof(setmetatable(
	{} :: {
		cx: number,
		cz: number,
		blocks: buffer,
		-- Voxel index -> block id, for everything a player changed. This is all
		-- that has to be saved: the rest regenerates from the seed.
		edits: { [number]: number },
		heightMap: buffer,
		dirty: boolean,
	},
	Chunk
))

function Chunk.new(cx: number, cz: number): Chunk
	return setmetatable({
		cx = cx,
		cz = cz,
		blocks = buffer.create(VOLUME),
		edits = {},
		heightMap = buffer.create(SIZE_X * SIZE_Z),
		dirty = false,
	}, Chunk)
end

function Chunk.get(self: Chunk, lx: number, ly: number, lz: number): number
	if not Coordinates.inBounds(lx, ly, lz) then
		return 0
	end
	return buffer.readu8(self.blocks, Coordinates.index(lx, ly, lz))
end

--[[ Writes a block without recording it as a player edit: used by generation. ]]
function Chunk.setRaw(self: Chunk, lx: number, ly: number, lz: number, blockId: number)
	if not Coordinates.inBounds(lx, ly, lz) then
		return
	end
	buffer.writeu8(self.blocks, Coordinates.index(lx, ly, lz), blockId)
end

--[[ Writes a block and remembers it, so it survives a restart. ]]
function Chunk.set(self: Chunk, lx: number, ly: number, lz: number, blockId: number)
	if not Coordinates.inBounds(lx, ly, lz) then
		return
	end

	local index = Coordinates.index(lx, ly, lz)
	if buffer.readu8(self.blocks, index) == blockId then
		return
	end

	buffer.writeu8(self.blocks, index, blockId)
	self.edits[index] = blockId
	self.dirty = true
	self:refreshColumn(lx, lz)
end

function Chunk.applyEdits(self: Chunk, edits: { [number]: number })
	for index, blockId in edits do
		if index >= 0 and index < VOLUME then
			buffer.writeu8(self.blocks, index, blockId)
			self.edits[index] = blockId
		end
	end
	self:buildHeightMap()
end

--[[ Highest non-air block in a column, or -1 for an empty column. ]]
function Chunk.height(self: Chunk, lx: number, lz: number): number
	if lx < 0 or lx >= SIZE_X or lz < 0 or lz >= SIZE_Z then
		return -1
	end
	return buffer.readu8(self.heightMap, lz * SIZE_X + lx) - 1
end

function Chunk.refreshColumn(self: Chunk, lx: number, lz: number)
	for ly = HEIGHT - 1, 0, -1 do
		if buffer.readu8(self.blocks, Coordinates.index(lx, ly, lz)) ~= 0 then
			buffer.writeu8(self.heightMap, lz * SIZE_X + lx, ly + 1)
			return
		end
	end
	buffer.writeu8(self.heightMap, lz * SIZE_X + lx, 0)
end

function Chunk.buildHeightMap(self: Chunk)
	for lx = 0, SIZE_X - 1 do
		for lz = 0, SIZE_Z - 1 do
			self:refreshColumn(lx, lz)
		end
	end
end

function Chunk.isEmpty(self: Chunk): boolean
	for lx = 0, SIZE_X - 1 do
		for lz = 0, SIZE_Z - 1 do
			if self:height(lx, lz) >= 0 then
				return false
			end
		end
	end
	return true
end

function Chunk.hasEdits(self: Chunk): boolean
	return next(self.edits) ~= nil
end

function Chunk.key(self: Chunk): string
	return Coordinates.chunkKey(self.cx, self.cz)
end

return Chunk
