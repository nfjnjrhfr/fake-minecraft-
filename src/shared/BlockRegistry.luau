--!strict
--[[
	Every block type. Ids are bytes: a chunk stores one per voxel, so ids must
	stay in 0..255 and must never be renumbered once a world has been saved.
]]

export type Block = {
	id: number,
	name: string,
	color: Color3,
	material: Enum.Material,
	transparency: number,
	-- Solid blocks stop movement and hide the faces of their neighbours.
	solid: boolean,
	collidable: boolean,
	-- Seconds to break bare-handed. 0 means instant, -1 means unbreakable.
	hardness: number,
	toolClass: string?,
	-- Tool tier needed for the block to drop anything at all.
	minTier: number,
	-- Item id this block drops; defaults to the block's own item.
	drop: number?,
	dropCount: number,
	lightEmission: number,
}

local AIR = 0

local blocks: { [number]: Block } = {}
local byName: { [string]: Block } = {}
local names: { string } = {}

local function define(id: number, name: string, options: {
	color: Color3,
	material: Enum.Material,
	transparency: number?,
	solid: boolean?,
	collidable: boolean?,
	hardness: number?,
	toolClass: string?,
	minTier: number?,
	drop: number?,
	dropCount: number?,
	lightEmission: number?,
})
	assert(blocks[id] == nil, "duplicate block id " .. id)
	assert(id >= 0 and id <= 255, "block id out of byte range: " .. id)

	local block: Block = {
		id = id,
		name = name,
		color = options.color,
		material = options.material,
		transparency = options.transparency or 0,
		solid = if options.solid == nil then true else options.solid,
		collidable = if options.collidable == nil then true else options.collidable,
		hardness = options.hardness or 0.5,
		toolClass = options.toolClass,
		minTier = options.minTier or 0,
		drop = options.drop,
		dropCount = options.dropCount or 1,
		lightEmission = options.lightEmission or 0,
	}

	blocks[id] = block
	byName[name] = block
	table.insert(names, name)
end

define(AIR, "Air", {
	color = Color3.new(),
	material = Enum.Material.Air,
	transparency = 1,
	solid = false,
	collidable = false,
	hardness = 0,
})

define(1, "Bedrock", {
	color = Color3.fromRGB(38, 38, 40),
	material = Enum.Material.Basalt,
	hardness = -1,
})

define(2, "Stone", {
	color = Color3.fromRGB(126, 126, 128),
	material = Enum.Material.Slate,
	hardness = 1.5,
	toolClass = "pickaxe",
	minTier = 1,
	drop = 15, -- cobblestone
})

define(3, "Dirt", {
	color = Color3.fromRGB(134, 96, 67),
	material = Enum.Material.Ground,
	hardness = 0.5,
	toolClass = "shovel",
})

define(4, "Grass", {
	color = Color3.fromRGB(106, 170, 80),
	material = Enum.Material.Grass,
	hardness = 0.6,
	toolClass = "shovel",
	drop = 3, -- dirt
})

define(5, "Sand", {
	color = Color3.fromRGB(219, 207, 163),
	material = Enum.Material.Sand,
	hardness = 0.5,
	toolClass = "shovel",
})

define(6, "Gravel", {
	color = Color3.fromRGB(136, 130, 127),
	material = Enum.Material.Pebble,
	hardness = 0.6,
	toolClass = "shovel",
})

define(7, "Water", {
	color = Color3.fromRGB(58, 118, 209),
	material = Enum.Material.Water,
	transparency = 0.55,
	solid = false,
	collidable = false,
	hardness = -1,
})

define(8, "Log", {
	color = Color3.fromRGB(109, 84, 51),
	material = Enum.Material.Wood,
	hardness = 2,
	toolClass = "axe",
})

define(9, "Leaves", {
	color = Color3.fromRGB(74, 140, 56),
	material = Enum.Material.LeafyGrass,
	transparency = 0.2,
	hardness = 0.2,
	drop = AIR, -- leaves drop nothing
})

define(10, "Planks", {
	color = Color3.fromRGB(178, 142, 91),
	material = Enum.Material.WoodPlanks,
	hardness = 1.6,
	toolClass = "axe",
})

define(11, "CoalOre", {
	color = Color3.fromRGB(84, 84, 86),
	material = Enum.Material.Slate,
	hardness = 2.5,
	toolClass = "pickaxe",
	minTier = 1,
	drop = 210, -- coal item
})

define(12, "IronOre", {
	color = Color3.fromRGB(190, 152, 122),
	material = Enum.Material.Slate,
	hardness = 3,
	toolClass = "pickaxe",
	minTier = 2,
	drop = 211, -- iron ingot
})

define(13, "GoldOre", {
	color = Color3.fromRGB(232, 193, 84),
	material = Enum.Material.Slate,
	hardness = 3,
	toolClass = "pickaxe",
	minTier = 3,
	drop = 212, -- gold ingot
})

define(14, "DiamondOre", {
	color = Color3.fromRGB(107, 226, 224),
	material = Enum.Material.Slate,
	hardness = 4.5,
	toolClass = "pickaxe",
	minTier = 3,
	drop = 213, -- diamond
})

define(15, "Cobblestone", {
	color = Color3.fromRGB(110, 110, 112),
	material = Enum.Material.Cobblestone,
	hardness = 2,
	toolClass = "pickaxe",
	minTier = 1,
})

define(16, "Glass", {
	color = Color3.fromRGB(210, 235, 245),
	material = Enum.Material.Glass,
	transparency = 0.65,
	hardness = 0.3,
	drop = AIR,
})

define(17, "Snow", {
	color = Color3.fromRGB(238, 244, 250),
	material = Enum.Material.Snow,
	hardness = 0.3,
	toolClass = "shovel",
})

define(18, "Sandstone", {
	color = Color3.fromRGB(203, 187, 140),
	material = Enum.Material.Sandstone,
	hardness = 1.6,
	toolClass = "pickaxe",
	minTier = 1,
})

define(19, "CraftingTable", {
	color = Color3.fromRGB(149, 108, 62),
	material = Enum.Material.WoodPlanks,
	hardness = 1.8,
	toolClass = "axe",
})

define(20, "Glowstone", {
	color = Color3.fromRGB(248, 224, 150),
	material = Enum.Material.Neon,
	hardness = 0.4,
	lightEmission = 1,
})

local BlockRegistry = {}

BlockRegistry.Air = AIR

function BlockRegistry.get(id: number): Block?
	return blocks[id]
end

function BlockRegistry.byName(name: string): Block?
	return byName[name]
end

--[[ Throws for unknown blocks: callers that know the name are asserting it. ]]
function BlockRegistry.id(name: string): number
	local block = byName[name]
	assert(block, "unknown block " .. name)
	return block.id
end

function BlockRegistry.exists(id: number): boolean
	return blocks[id] ~= nil
end

function BlockRegistry.isSolid(id: number): boolean
	local block = blocks[id]
	return block ~= nil and block.solid
end

function BlockRegistry.isBreakable(id: number): boolean
	local block = blocks[id]
	return block ~= nil and block.id ~= AIR and block.hardness >= 0
end

--[[ Opaque blocks hide their neighbours' faces; glass and water do not. ]]
function BlockRegistry.isOpaque(id: number): boolean
	local block = blocks[id]
	return block ~= nil and block.id ~= AIR and block.transparency == 0
end

function BlockRegistry.all(): { string }
	return table.clone(names)
end

return BlockRegistry
