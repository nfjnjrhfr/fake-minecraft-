--!strict
--[[ Every block type in the game, keyed by its numeric id. ]]

export type Block = {
	id: number,
	name: string,
	color: Color3,
	material: Enum.Material,
	transparency: number,
}

local AIR = 0

local blocks: { [number]: Block } = {}
local byName: { [string]: Block } = {}

local function define(id: number, name: string, color: Color3, material: Enum.Material, transparency: number?)
	local block: Block = {
		id = id,
		name = name,
		color = color,
		material = material,
		transparency = transparency or 0,
	}
	blocks[id] = block
	byName[name] = block
end

define(1, "Grass", Color3.fromRGB(106, 170, 80), Enum.Material.Grass)
define(2, "Dirt", Color3.fromRGB(134, 96, 67), Enum.Material.Ground)
define(3, "Stone", Color3.fromRGB(128, 128, 128), Enum.Material.Slate)
define(4, "Sand", Color3.fromRGB(219, 207, 163), Enum.Material.Sand)
define(5, "Wood", Color3.fromRGB(143, 108, 63), Enum.Material.WoodPlanks)
define(6, "Leaves", Color3.fromRGB(72, 138, 55), Enum.Material.Grass, 0.25)
define(7, "Glass", Color3.fromRGB(210, 235, 245), Enum.Material.Glass, 0.6)

local BlockRegistry = {}

BlockRegistry.Air = AIR

function BlockRegistry.get(id: number): Block?
	return blocks[id]
end

function BlockRegistry.fromName(name: string): Block?
	return byName[name]
end

function BlockRegistry.isPlaceable(id: number): boolean
	return blocks[id] ~= nil
end

--[[ Ids in hotbar order, so the client and server agree on what "slot 3" is. ]]
function BlockRegistry.hotbar(): { number }
	return { 1, 2, 3, 4, 5, 6, 7 }
end

return BlockRegistry
