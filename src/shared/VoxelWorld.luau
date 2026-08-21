--!strict
--[[
	A sparse voxel store plus the conversions between voxel coordinates and
	world space. The server owns the authoritative instance; the client keeps
	its own copy so it can preview placements without a round trip.
]]

local WorldConfig = require(script.Parent.WorldConfig)

export type Coordinate = { x: number, y: number, z: number }

local VoxelWorld = {}
VoxelWorld.__index = VoxelWorld

export type VoxelWorld = typeof(setmetatable(
	{} :: { voxels: { [string]: number }, count: number },
	VoxelWorld
))

local function key(x: number, y: number, z: number): string
	return string.format("%d,%d,%d", x, y, z)
end

function VoxelWorld.new(): VoxelWorld
	return setmetatable({ voxels = {}, count = 0 }, VoxelWorld)
end

function VoxelWorld.get(self: VoxelWorld, x: number, y: number, z: number): number
	return self.voxels[key(x, y, z)] or 0
end

function VoxelWorld.set(self: VoxelWorld, x: number, y: number, z: number, blockId: number)
	local index = key(x, y, z)
	local existing = self.voxels[index]

	if blockId == 0 then
		if existing then
			self.voxels[index] = nil
			self.count -= 1
		end
		return
	end

	if not existing then
		self.count += 1
	end
	self.voxels[index] = blockId
end

function VoxelWorld.isOccupied(self: VoxelWorld, x: number, y: number, z: number): boolean
	return self.voxels[key(x, y, z)] ~= nil
end

function VoxelWorld.forEach(self: VoxelWorld, callback: (x: number, y: number, z: number, blockId: number) -> ())
	for index, blockId in self.voxels do
		local x, y, z = string.match(index, "(-?%d+),(-?%d+),(-?%d+)")
		callback(tonumber(x) :: number, tonumber(y) :: number, tonumber(z) :: number, blockId)
	end
end

--[[ Centre of the given voxel, in world space. ]]
function VoxelWorld.toWorld(x: number, y: number, z: number): Vector3
	local size = WorldConfig.BlockSize
	return Vector3.new(x * size, y * size, z * size)
end

--[[ The voxel that contains the given world position. ]]
function VoxelWorld.toVoxel(position: Vector3): Coordinate
	local size = WorldConfig.BlockSize
	return {
		x = math.round(position.X / size),
		y = math.round(position.Y / size),
		z = math.round(position.Z / size),
	}
end

--[[
	The voxel a click lands on. `normal` picks the neighbouring cell when
	placing, and the hit cell itself when breaking.
]]
function VoxelWorld.voxelFromHit(position: Vector3, normal: Vector3, place: boolean): Coordinate
	local size = WorldConfig.BlockSize
	local offset = if place then normal * (size * 0.5) else -normal * (size * 0.5)
	return VoxelWorld.toVoxel(position + offset)
end

return VoxelWorld
