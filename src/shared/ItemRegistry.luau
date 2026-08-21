--!strict
--[[
	Items are what an inventory holds. Ids 0..99 are block items and share the
	block's id exactly; ids 200+ are things that are not blocks (tools,
	materials). Keeping block items id-identical means placing a block is just
	`setBlock(x, y, z, itemId)`.
]]

local BlockRegistry = require(script.Parent.BlockRegistry)
local WorldConfig = require(script.Parent.WorldConfig)

export type Item = {
	id: number,
	name: string,
	displayName: string,
	maxStack: number,
	blockId: number?,
	toolClass: string?,
	toolTier: number,
	-- Multiplies break speed when the tool matches the block's tool class.
	toolSpeed: number,
	color: Color3,
}

local items: { [number]: Item } = {}
local byName: { [string]: Item } = {}

local function displayNameOf(name: string): string
	local spaced = string.gsub(name, "(%l)(%u)", "%1 %2")
	return spaced
end

local function define(id: number, name: string, options: {
	maxStack: number?,
	blockId: number?,
	toolClass: string?,
	toolTier: number?,
	toolSpeed: number?,
	color: Color3?,
})
	assert(items[id] == nil, "duplicate item id " .. id)

	local item: Item = {
		id = id,
		name = name,
		displayName = displayNameOf(name),
		maxStack = options.maxStack or WorldConfig.StackSize,
		blockId = options.blockId,
		toolClass = options.toolClass,
		toolTier = options.toolTier or 0,
		toolSpeed = options.toolSpeed or 1,
		color = options.color or Color3.fromRGB(200, 200, 200),
	}

	items[id] = item
	byName[name] = item
end

-- Every placeable block becomes an item with the same id.
for _, blockName in BlockRegistry.all() do
	local block = assert(BlockRegistry.byName(blockName))
	if block.id ~= BlockRegistry.Air and block.hardness >= 0 then
		define(block.id, block.name, { blockId = block.id, color = block.color })
	end
end

-- Materials.
define(210, "Coal", { color = Color3.fromRGB(48, 48, 50) })
define(211, "IronIngot", { color = Color3.fromRGB(216, 200, 190) })
define(212, "GoldIngot", { color = Color3.fromRGB(240, 205, 96) })
define(213, "Diamond", { color = Color3.fromRGB(107, 226, 224) })
define(214, "Stick", { color = Color3.fromRGB(150, 118, 74) })

-- Tools. Tier gates which ores drop; speed decides how fast they break.
local function defineToolSet(baseId: number, prefix: string, tier: number, speed: number, color: Color3)
	define(baseId, prefix .. "Pickaxe", { maxStack = 1, toolClass = "pickaxe", toolTier = tier, toolSpeed = speed, color = color })
	define(baseId + 1, prefix .. "Axe", { maxStack = 1, toolClass = "axe", toolTier = tier, toolSpeed = speed, color = color })
	define(baseId + 2, prefix .. "Shovel", { maxStack = 1, toolClass = "shovel", toolTier = tier, toolSpeed = speed, color = color })
end

defineToolSet(220, "Wooden", 1, 2, Color3.fromRGB(178, 142, 91))
defineToolSet(230, "Stone", 2, 4, Color3.fromRGB(126, 126, 128))
defineToolSet(240, "Iron", 3, 6, Color3.fromRGB(216, 200, 190))
defineToolSet(250, "Diamond", 3, 9, Color3.fromRGB(107, 226, 224))

local ItemRegistry = {}

function ItemRegistry.get(id: number): Item?
	return items[id]
end

function ItemRegistry.byName(name: string): Item?
	return byName[name]
end

function ItemRegistry.id(name: string): number
	local item = byName[name]
	assert(item, "unknown item " .. name)
	return item.id
end

function ItemRegistry.exists(id: number): boolean
	return items[id] ~= nil
end

function ItemRegistry.maxStack(id: number): number
	local item = items[id]
	return if item then item.maxStack else WorldConfig.StackSize
end

function ItemRegistry.isPlaceable(id: number): boolean
	local item = items[id]
	return item ~= nil and item.blockId ~= nil
end

--[[ How long `itemId` (possibly nil, meaning bare hands) takes on a block. ]]
function ItemRegistry.breakTime(blockId: number, itemId: number?): number
	local block = BlockRegistry.get(blockId)
	if not block or block.hardness < 0 then
		return math.huge
	end
	if block.hardness == 0 then
		return 0
	end

	local item = if itemId then items[itemId] else nil
	local speed = 1
	if item and block.toolClass and item.toolClass == block.toolClass then
		speed = item.toolSpeed
	end

	return block.hardness / speed
end

--[[ Whether a block broken with this item drops anything. ]]
function ItemRegistry.canHarvest(blockId: number, itemId: number?): boolean
	local block = BlockRegistry.get(blockId)
	if not block then
		return false
	end
	if block.minTier <= 0 then
		return true
	end

	local item = if itemId then items[itemId] else nil
	if not item or item.toolClass ~= block.toolClass then
		return false
	end
	return item.toolTier >= block.minTier
end

return ItemRegistry
