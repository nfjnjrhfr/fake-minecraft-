--[[
	GameConfig — shared tuning values and the arena blueprint.

	Kept free of Roblox instance APIs on purpose: the arena plan is pure data
	(plain numbers and strings), so the server can build it and it can also be
	unit-tested outside of Studio.
]]

local GameConfig = {}

-- world -----------------------------------------------------------------
GameConfig.BLOCK = 6                 -- stud size of one "voxel"
GameConfig.RING_OUT_Y = -80          -- below this you have fallen off the map
GameConfig.RING_OUT_DAMAGE = 35
GameConfig.SPAWN_X = 62              -- both spawn pads sit at +/- this X

-- match -----------------------------------------------------------------
GameConfig.MAX_HEALTH = 100
GameConfig.ROUNDS_TO_WIN = 3
GameConfig.ROUND_SECONDS = 90
GameConfig.COUNTDOWN_SECONDS = 3
GameConfig.INTERMISSION_SECONDS = 5

-- sword -----------------------------------------------------------------
GameConfig.SWORD_DAMAGE = 13
GameConfig.SWORD_COOLDOWN = 0.42
GameConfig.SWORD_RANGE = 10
GameConfig.SWORD_KNOCKBACK = 46

-- snowball --------------------------------------------------------------
GameConfig.SNOWBALL_DAMAGE = 10
GameConfig.SNOWBALL_COOLDOWN = 0.34
GameConfig.SNOWBALL_SPEED = 95
GameConfig.SNOWBALL_LIFETIME = 5
GameConfig.SNOWBALL_KNOCKBACK = 26
GameConfig.MAX_AMMO = 8
GameConfig.AMMO_REGEN = 1.6          -- seconds per +1

-- placeable blocks ------------------------------------------------------
GameConfig.MAX_BLOCKS = 10
GameConfig.BLOCK_COOLDOWN = 0.22
GameConfig.BLOCK_REGEN = 2.2
GameConfig.BLOCK_LIFETIME = 25

-- colours / materials for every block kind used by the blueprint --------
GameConfig.KINDS = {
	grass = { color = { 124, 194, 67 }, material = "Grass" },
	dirt = { color = { 160, 106, 63 }, material = "Ground" },
	stone = { color = { 154, 160, 168 }, material = "Slate" },
	wood = { color = { 169, 122, 68 }, material = "WoodPlanks" },
	leaf = { color = { 79, 155, 60 }, material = "Grass" },
	plank = { color = { 201, 162, 106 }, material = "WoodPlanks" },
	bedrock = { color = { 75, 79, 87 }, material = "Rock" },
}

--[[
	Returns the arena as a flat list of blocks:
	{ kind = "grass", x, y, z, sx, sy, sz }

	Everything is built on the +X side and mirrored to -X, so the two spawns
	are guaranteed to face an identical stage. Blocks centred on X = 0 are
	their own mirror and are only emitted once.
]]
function GameConfig.buildArenaPlan()
	local plan = {}
	local DEPTH = 48

	local function add(kind, x, y, z, sx, sy, sz)
		table.insert(plan, { kind = kind, x = x, y = y, z = z, sx = sx, sy = sy, sz = sz })
	end

	local function addPair(kind, x, y, z, sx, sy, sz)
		add(kind, x, y, z, sx, sy, sz)
		if math.abs(x) > 0.001 then
			add(kind, -x, y, z, sx, sy, sz)
		end
	end

	-- three islands separated by two bottomless gaps
	local function island(cx, width)
		addPair("grass", cx, -1, 0, width, 2, DEPTH)
		addPair("dirt", cx, -6, 0, width, 8, DEPTH)
		addPair("stone", cx, -18, 0, width, 16, DEPTH)
	end

	island(0, 56)     -- centre island, x in [-28, 28]
	island(62, 44)    -- side islands, x in [40, 84] (and mirrored)

	-- unbreakable core so the middle can never be removed
	add("bedrock", 0, -28, 0, 56, 4, DEPTH)

	-- cover pillars near the middle
	for i = 0, 2 do
		addPair("stone", 12, 3 + i * 6, 0, 6, 6, 6)
	end

	-- floating platforms: low, mid and one high centre platform
	addPair("wood", 20, 14, -8, 26, 2, 14)
	addPair("stone", 46, 20, 8, 24, 2, 14)
	addPair("plank", 30, 30, 0, 20, 2, 12)
	add("plank", 0, 40, 0, 24, 2, 14)

	-- decorative trees on the outer islands
	addPair("wood", 76, 9, -14, 4, 18, 4)
	addPair("leaf", 76, 21, -14, 16, 10, 16)

	return plan
end

-- Spawn pads. The server points each fighter at the middle of the arena.
function GameConfig.spawnPoints()
	return {
		{ x = GameConfig.SPAWN_X, y = 5, z = 0 },
		{ x = -GameConfig.SPAWN_X, y = 5, z = 0 },
		{ x = GameConfig.SPAWN_X, y = 5, z = -16 },
		{ x = -GameConfig.SPAWN_X, y = 5, z = -16 },
	}
end

return GameConfig
