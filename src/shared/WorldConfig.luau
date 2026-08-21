--!strict
--[[ Tunables shared by the server world generator and the client tools. ]]

return table.freeze({
	-- Size of one voxel in studs.
	BlockSize = 3,
	-- The world spans WorldRadius blocks either side of the origin.
	WorldRadius = 24,
	-- Terrain height range, in blocks.
	MinHeight = 2,
	MaxHeight = 10,
	-- How deep below the surface blocks are actually rendered as parts.
	RenderDepth = 3,
	-- How far a player can reach to place or break a block, in studs.
	MaxReach = 40,
	-- Seed for the terrain noise. Change it to get a different world.
	Seed = 1337,
})
