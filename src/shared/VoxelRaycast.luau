--!strict
--[[
	Amanatides and Woo's voxel traversal: walks the grid cell by cell instead of
	sampling along the ray, so it never steps over a block and never reports a
	face it did not actually cross.
]]

local WorldConfig = require(script.Parent.WorldConfig)

local BLOCK = WorldConfig.BlockSize

export type Hit = {
	x: number,
	y: number,
	z: number,
	blockId: number,
	-- The neighbouring cell the ray came from: where a placed block goes.
	previousX: number,
	previousY: number,
	previousZ: number,
	normal: Vector3,
	distance: number,
}

local VoxelRaycast = {}

local function boundary(origin: number, cell: number, direction: number): number
	if direction > 0 then
		return (cell + 1 - origin) / direction
	elseif direction < 0 then
		return (cell - origin) / direction
	end
	return math.huge
end

--[[
	`isSolid(x, y, z)` decides what stops the ray. `maxDistance` is in studs.
]]
function VoxelRaycast.cast(
	isSolid: (x: number, y: number, z: number) -> boolean,
	origin: Vector3,
	direction: Vector3,
	maxDistance: number
): Hit?
	if direction.Magnitude == 0 then
		return nil
	end

	local unit = direction.Unit
	local start = origin / BLOCK
	local limit = maxDistance / BLOCK

	local x = math.floor(start.X)
	local y = math.floor(start.Y)
	local z = math.floor(start.Z)

	local stepX = math.sign(unit.X)
	local stepY = math.sign(unit.Y)
	local stepZ = math.sign(unit.Z)

	local tMaxX = boundary(start.X, x, unit.X)
	local tMaxY = boundary(start.Y, y, unit.Y)
	local tMaxZ = boundary(start.Z, z, unit.Z)

	local tDeltaX = if unit.X ~= 0 then math.abs(1 / unit.X) else math.huge
	local tDeltaY = if unit.Y ~= 0 then math.abs(1 / unit.Y) else math.huge
	local tDeltaZ = if unit.Z ~= 0 then math.abs(1 / unit.Z) else math.huge

	if isSolid(x, y, z) then
		return {
			x = x, y = y, z = z,
			blockId = 0,
			previousX = x, previousY = y, previousZ = z,
			normal = Vector3.zero,
			distance = 0,
		}
	end

	local travelled = 0
	-- One iteration per cell crossed; the cap is a guard against a ray that
	-- somehow never advances.
	for _ = 1, math.ceil(limit * 3) + 3 do
		local previousX, previousY, previousZ = x, y, z
		local normal: Vector3

		if tMaxX <= tMaxY and tMaxX <= tMaxZ then
			travelled = tMaxX
			x += stepX
			tMaxX += tDeltaX
			normal = Vector3.new(-stepX, 0, 0)
		elseif tMaxY <= tMaxZ then
			travelled = tMaxY
			y += stepY
			tMaxY += tDeltaY
			normal = Vector3.new(0, -stepY, 0)
		else
			travelled = tMaxZ
			z += stepZ
			tMaxZ += tDeltaZ
			normal = Vector3.new(0, 0, -stepZ)
		end

		if travelled > limit then
			return nil
		end

		if y < 0 or y >= WorldConfig.WorldHeight then
			if (y < 0 and stepY <= 0) or (y >= WorldConfig.WorldHeight and stepY >= 0) then
				return nil
			end
			continue
		end

		if isSolid(x, y, z) then
			return {
				x = x, y = y, z = z,
				blockId = 0,
				previousX = previousX, previousY = previousY, previousZ = previousZ,
				normal = normal,
				distance = travelled * BLOCK,
			}
		end
	end

	return nil
end

return VoxelRaycast
