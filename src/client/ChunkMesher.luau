--!strict
--[[
	Turns a chunk into as few boxes as possible.

	Two passes matter here. Blocks with an opaque neighbour on all six sides are
	never drawn at all - that removes almost everything underground. What is
	left is merged greedily into boxes: grow along X, then Z, then Y, for as
	long as every block in the slab is the same type and also visible.

	A 16 x 64 x 16 chunk is 16,384 blocks and comes out as a few hundred parts.
]]

local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Shared = ReplicatedStorage:WaitForChild("FakeMinecraft")
local BlockRegistry = require(Shared:WaitForChild("BlockRegistry"))
local Chunk = require(Shared:WaitForChild("Chunk"))
local Coordinates = require(Shared:WaitForChild("Coordinates"))
local WorldConfig = require(Shared:WaitForChild("WorldConfig"))

local SIZE_X = WorldConfig.ChunkSizeX
local SIZE_Z = WorldConfig.ChunkSizeZ
local HEIGHT = WorldConfig.WorldHeight
local VOLUME = Coordinates.VolumePerChunk

export type Box = {
	-- Minimum corner, in world voxel coordinates.
	x: number,
	y: number,
	z: number,
	sizeX: number,
	sizeY: number,
	sizeZ: number,
	blockId: number,
}

local ChunkMesher = {}

--[[ Reused between chunks: meshing runs constantly while a player walks. ]]
local visited = buffer.create(VOLUME)
local exposed = buffer.create(VOLUME)

local function isExposed(index: number): boolean
	return buffer.readu8(exposed, index) == 1
end

local function markExposure(chunk: Chunk.Chunk, getBlock: (number, number, number) -> number)
	buffer.fill(exposed, 0, 0, VOLUME)

	local originX, originZ = Coordinates.chunkOrigin(chunk.cx, chunk.cz)

	for ly = 0, HEIGHT - 1 do
		for lz = 0, SIZE_Z - 1 do
			for lx = 0, SIZE_X - 1 do
				local index = Coordinates.index(lx, ly, lz)
				local blockId = buffer.readu8(chunk.blocks, index)
				if blockId == BlockRegistry.Air then
					continue
				end

				local worldX = originX + lx
				local worldZ = originZ + lz

				-- A face is visible when the block beyond it is not opaque.
				local visible = not BlockRegistry.isOpaque(getBlock(worldX + 1, ly, worldZ))
					or not BlockRegistry.isOpaque(getBlock(worldX - 1, ly, worldZ))
					or not BlockRegistry.isOpaque(getBlock(worldX, ly + 1, worldZ))
					or not BlockRegistry.isOpaque(getBlock(worldX, ly - 1, worldZ))
					or not BlockRegistry.isOpaque(getBlock(worldX, ly, worldZ + 1))
					or not BlockRegistry.isOpaque(getBlock(worldX, ly, worldZ - 1))

				if visible then
					buffer.writeu8(exposed, index, 1)
				end
			end
		end
	end
end

local function claimed(index: number): boolean
	return buffer.readu8(visited, index) == 1
end

--[[ Can this cell join a box of `blockId`? ]]
local function available(chunk: Chunk.Chunk, lx: number, ly: number, lz: number, blockId: number): boolean
	local index = Coordinates.index(lx, ly, lz)
	return buffer.readu8(chunk.blocks, index) == blockId
		and not claimed(index)
		and isExposed(index)
end

function ChunkMesher.build(chunk: Chunk.Chunk, getBlock: (number, number, number) -> number): { Box }
	buffer.fill(visited, 0, 0, VOLUME)
	markExposure(chunk, getBlock)

	local originX, originZ = Coordinates.chunkOrigin(chunk.cx, chunk.cz)
	local boxes: { Box } = {}

	for ly = 0, HEIGHT - 1 do
		for lz = 0, SIZE_Z - 1 do
			for lx = 0, SIZE_X - 1 do
				local index = Coordinates.index(lx, ly, lz)
				local blockId = buffer.readu8(chunk.blocks, index)

				if blockId == BlockRegistry.Air or claimed(index) or not isExposed(index) then
					continue
				end

				-- Grow along X.
				local width = 1
				while lx + width < SIZE_X and available(chunk, lx + width, ly, lz, blockId) do
					width += 1
				end

				-- Grow along Z, one full row at a time.
				local depth = 1
				while lz + depth < SIZE_Z do
					local rowFits = true
					for offsetX = 0, width - 1 do
						if not available(chunk, lx + offsetX, ly, lz + depth, blockId) then
							rowFits = false
							break
						end
					end
					if not rowFits then
						break
					end
					depth += 1
				end

				-- Grow upwards, one full slab at a time.
				local height = 1
				while ly + height < HEIGHT do
					local slabFits = true
					for offsetZ = 0, depth - 1 do
						for offsetX = 0, width - 1 do
							if not available(chunk, lx + offsetX, ly + height, lz + offsetZ, blockId) then
								slabFits = false
								break
							end
						end
						if not slabFits then
							break
						end
					end
					if not slabFits then
						break
					end
					height += 1
				end

				for offsetY = 0, height - 1 do
					for offsetZ = 0, depth - 1 do
						for offsetX = 0, width - 1 do
							buffer.writeu8(visited, Coordinates.index(lx + offsetX, ly + offsetY, lz + offsetZ), 1)
						end
					end
				end

				table.insert(boxes, {
					x = originX + lx,
					y = ly,
					z = originZ + lz,
					sizeX = width,
					sizeY = height,
					sizeZ = depth,
					blockId = blockId,
				})
			end
		end
	end

	return boxes
end

--[[ Part geometry for a box, in world space. ]]
function ChunkMesher.boxToPart(box: Box): (Vector3, Vector3)
	local scale = WorldConfig.BlockSize
	local size = Vector3.new(box.sizeX, box.sizeY, box.sizeZ) * scale
	local position = Vector3.new(
		(box.x + box.sizeX / 2) * scale,
		(box.y + box.sizeY / 2) * scale,
		(box.z + box.sizeZ / 2) * scale
	)
	return position, size
end

return ChunkMesher
