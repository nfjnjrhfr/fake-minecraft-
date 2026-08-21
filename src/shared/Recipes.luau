--!strict
--[[
	Crafting recipes and the matcher for a 3x3 grid.

	Shaped recipes are written as rows of key characters and matched anywhere in
	the grid: a 2x2 recipe fits in any corner. Shapeless recipes only care about
	the multiset of ingredients.
]]

local ItemRegistry = require(script.Parent.ItemRegistry)

export type Recipe = {
	kind: string, -- "shaped" | "shapeless"
	width: number,
	height: number,
	-- Row-major cells for shaped recipes; nil means "must be empty".
	cells: { number? },
	-- Ingredient id -> count, for shapeless recipes.
	ingredients: { [number]: number }?,
	resultId: number,
	resultCount: number,
}

local GRID = 3

local recipes: { Recipe } = {}

local function shaped(rows: { string }, key: { [string]: string }, result: string, count: number)
	local height = #rows
	local width = 0
	for _, row in rows do
		width = math.max(width, #row)
	end

	local cells: { number? } = {}
	for y = 1, height do
		local row = rows[y]
		for x = 1, width do
			local character = string.sub(row, x, x)
			local index = (y - 1) * width + x
			if character == "" or character == " " then
				cells[index] = nil
			else
				local itemName = key[character]
				assert(itemName, "recipe key " .. character .. " has no item")
				cells[index] = ItemRegistry.id(itemName)
			end
		end
	end

	table.insert(recipes, {
		kind = "shaped",
		width = width,
		height = height,
		cells = cells,
		ingredients = nil,
		resultId = ItemRegistry.id(result),
		resultCount = count,
	})
end

local function shapeless(inputs: { string }, result: string, count: number)
	local ingredients: { [number]: number } = {}
	for _, itemName in inputs do
		local id = ItemRegistry.id(itemName)
		ingredients[id] = (ingredients[id] or 0) + 1
	end

	table.insert(recipes, {
		kind = "shapeless",
		width = 0,
		height = 0,
		cells = {},
		ingredients = ingredients,
		resultId = ItemRegistry.id(result),
		resultCount = count,
	})
end

-- Materials ------------------------------------------------------------------
shapeless({ "Log" }, "Planks", 4)
shaped({ "P", "P" }, { P = "Planks" }, "Stick", 4)
shaped({ "PP", "PP" }, { P = "Planks" }, "CraftingTable", 1)
shaped({ "CC", "CC" }, { C = "Cobblestone" }, "Stone", 1)
shaped({ "SSS", "SSS", "SSS" }, { S = "Sand" }, "Sandstone", 4)
shapeless({ "Sand", "Coal" }, "Glass", 1)
shaped({ "GG", "GG" }, { G = "GoldIngot" }, "Glowstone", 1)

-- Tools ----------------------------------------------------------------------
local TOOL_HEADS = {
	{ key = "P", material = "Planks", prefix = "Wooden" },
	{ key = "C", material = "Cobblestone", prefix = "Stone" },
	{ key = "I", material = "IronIngot", prefix = "Iron" },
	{ key = "D", material = "Diamond", prefix = "Diamond" },
}

for _, head in TOOL_HEADS do
	local key = { [head.key] = head.material, S = "Stick" }
	shaped({ head.key .. head.key .. head.key, " S ", " S " }, key, head.prefix .. "Pickaxe", 1)
	shaped({ head.key .. head.key, head.key .. "S", " S" }, key, head.prefix .. "Axe", 1)
	shaped({ head.key, "S", "S" }, key, head.prefix .. "Shovel", 1)
end

local Recipes = {}

Recipes.GridSize = GRID

--[[ Bounding box of the filled cells in a 3x3 grid. ]]
local function bounds(grid: { number? }): (number, number, number, number, number)
	local minX, minY, maxX, maxY = GRID + 1, GRID + 1, 0, 0
	local filled = 0

	for y = 1, GRID do
		for x = 1, GRID do
			if grid[(y - 1) * GRID + x] then
				filled += 1
				minX = math.min(minX, x)
				maxX = math.max(maxX, x)
				minY = math.min(minY, y)
				maxY = math.max(maxY, y)
			end
		end
	end

	return minX, minY, maxX, maxY, filled
end

local function matchesShaped(recipe: Recipe, grid: { number? }, offsetX: number, offsetY: number): boolean
	for y = 1, GRID do
		for x = 1, GRID do
			local actual = grid[(y - 1) * GRID + x]
			local recipeX = x - offsetX + 1
			local recipeY = y - offsetY + 1

			local expected: number? = nil
			if recipeX >= 1 and recipeX <= recipe.width and recipeY >= 1 and recipeY <= recipe.height then
				expected = recipe.cells[(recipeY - 1) * recipe.width + recipeX]
			end

			if actual ~= expected then
				return false
			end
		end
	end
	return true
end

local function matchesShapeless(recipe: Recipe, grid: { number? }): boolean
	local counts: { [number]: number } = {}
	for _, id in grid do
		if id then
			counts[id] = (counts[id] or 0) + 1
		end
	end

	local ingredients = recipe.ingredients
	if not ingredients then
		return false
	end

	for id, needed in ingredients do
		if counts[id] ~= needed then
			return false
		end
		counts[id] = nil
	end

	return next(counts) == nil
end

--[[
	`grid` is 9 entries, row-major, each an item id or nil. Counts do not matter:
	a recipe consumes one of each filled cell.
]]
function Recipes.match(grid: { number? }): Recipe?
	local minX, minY, _, _, filled = bounds(grid)
	if filled == 0 then
		return nil
	end

	for _, recipe in recipes do
		if recipe.kind == "shapeless" then
			if matchesShapeless(recipe, grid) then
				return recipe
			end
		elseif matchesShaped(recipe, grid, minX, minY) then
			return recipe
		end
	end

	return nil
end

function Recipes.all(): { Recipe }
	return recipes
end

return Recipes
