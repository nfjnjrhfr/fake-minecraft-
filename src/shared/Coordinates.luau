--!strict
--[[ Conversions between world space, voxel space and chunk space. ]]

local WorldConfig = require(script.Parent.WorldConfig)

local SIZE_X = WorldConfig.ChunkSizeX
local SIZE_Z = WorldConfig.ChunkSizeZ
local HEIGHT = WorldConfig.WorldHeight
local BLOCK = WorldConfig.BlockSize

local Coordinates = {}

Coordinates.VolumePerChunk = SIZE_X * SIZE_Z * HEIGHT

--[[ Index into a chunk's flat block buffer. X varies fastest, then Z, then Y,
     so a flat layer of one block type is one contiguous run. ]]
function Coordinates.index(lx: number, ly: number, lz: number): number
	return (ly * SIZE_Z + lz) * SIZE_X + lx
end

function Coordinates.fromIndex(index: number): (number, number, number)
	local lx = index % SIZE_X
	local rest = (index - lx) / SIZE_X
	local lz = rest % SIZE_Z
	local ly = (rest - lz) / SIZE_Z
	return lx, ly, lz
end

function Coordinates.inBounds(lx: number, ly: number, lz: number): boolean
	return lx >= 0 and lx < SIZE_X and ly >= 0 and ly < HEIGHT and lz >= 0 and lz < SIZE_Z
end

function Coordinates.chunkOf(x: number, z: number): (number, number)
	return math.floor(x / SIZE_X), math.floor(z / SIZE_Z)
end

function Coordinates.localOf(x: number, z: number): (number, number)
	return x - math.floor(x / SIZE_X) * SIZE_X, z - math.floor(z / SIZE_Z) * SIZE_Z
end

function Coordinates.chunkOrigin(cx: number, cz: number): (number, number)
	return cx * SIZE_X, cz * SIZE_Z
end

function Coordinates.chunkKey(cx: number, cz: number): string
	return string.format("%d,%d", cx, cz)
end

function Coordinates.parseChunkKey(key: string): (number, number)
	local cx, cz = string.match(key, "(-?%d+),(-?%d+)")
	return tonumber(cx) :: number, tonumber(cz) :: number
end

--[[ Centre of a voxel, in world space. ]]
function Coordinates.voxelToWorld(x: number, y: number, z: number): Vector3
	return Vector3.new((x + 0.5) * BLOCK, (y + 0.5) * BLOCK, (z + 0.5) * BLOCK)
end

function Coordinates.worldToVoxel(position: Vector3): (number, number, number)
	return math.floor(position.X / BLOCK), math.floor(position.Y / BLOCK), math.floor(position.Z / BLOCK)
end

function Coordinates.worldToChunk(position: Vector3): (number, number)
	local x, _, z = Coordinates.worldToVoxel(position)
	return Coordinates.chunkOf(x, z)
end

return Coordinates
