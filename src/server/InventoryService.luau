--!strict
--[[
	Owns every player's inventory, hotbar selection and crafting grid. The
	client sends clicks; this decides what they mean and replies with the truth.
]]

local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Shared = ReplicatedStorage:WaitForChild("FakeMinecraft")
local Inventory = require(Shared:WaitForChild("Inventory"))
local ItemRegistry = require(Shared:WaitForChild("ItemRegistry"))
local Recipes = require(Shared:WaitForChild("Recipes"))
local Remotes = require(Shared:WaitForChild("Remotes"))
local WorldConfig = require(Shared:WaitForChild("WorldConfig"))

local DropService = require(script.Parent.DropService)

local GRID_SLOTS = WorldConfig.CraftGridSize * WorldConfig.CraftGridSize

local InventoryService = {}

export type State = {
	main: Inventory.Inventory,
	craft: Inventory.Inventory,
	selected: number,
	dirty: boolean,
}

local states: { [Player]: State } = {}
local inventorySync = Remotes.get("InventorySync")

function InventoryService.track(player: Player, saved: any)
	local state: State = {
		main = Inventory.new(WorldConfig.InventorySlots),
		craft = Inventory.new(GRID_SLOTS),
		selected = 1,
		dirty = false,
	}

	if type(saved) == "table" then
		state.main:deserialize(saved.slots)
		local selected = tonumber(saved.selected)
		if selected then
			state.selected = math.clamp(math.floor(selected), 1, WorldConfig.HotbarSlots)
		end
	end

	states[player] = state
	InventoryService.sync(player)
end

function InventoryService.forget(player: Player)
	states[player] = nil
end

function InventoryService.get(player: Player): State?
	return states[player]
end

function InventoryService.serialize(player: Player): any
	local state = states[player]
	if not state then
		return nil
	end
	return { slots = state.main:serialize(), selected = state.selected }
end

--[[ Ids in the crafting grid, row-major, for the recipe matcher. ]]
local function gridOf(state: State): { number? }
	local grid: { number? } = {}
	for slot = 1, GRID_SLOTS do
		local stack = state.craft:get(slot)
		grid[slot] = if stack then stack.id else nil
	end
	return grid
end

local function craftResult(state: State): Inventory.Stack?
	local recipe = Recipes.match(gridOf(state))
	if not recipe then
		return nil
	end
	return { id = recipe.resultId, count = recipe.resultCount }
end

function InventoryService.sync(player: Player)
	local state = states[player]
	if not state then
		return
	end

	local cursor = state.main.cursor
	inventorySync:FireClient(
		player,
		state.main:serialize(),
		if cursor then { cursor.id, cursor.count } else nil,
		state.craft:serialize(),
		craftResult(state),
		state.selected
	)
	state.dirty = false
end

function InventoryService.addItem(player: Player, itemId: number, count: number): number
	local state = states[player]
	if not state then
		return count
	end

	local leftover = state.main:add(itemId, count)
	if leftover < count then
		InventoryService.sync(player)
	end
	return leftover
end

function InventoryService.selectedStack(player: Player): Inventory.Stack?
	local state = states[player]
	if not state then
		return nil
	end
	return state.main:get(state.selected)
end

function InventoryService.consumeSelected(player: Player, count: number): boolean
	local state = states[player]
	if not state then
		return false
	end

	local removed = state.main:removeFromSlot(state.selected, count)
	if removed > 0 then
		InventoryService.sync(player)
	end
	return removed >= count
end

local function containerOf(state: State, container: string): Inventory.Inventory?
	if container == "main" then
		return state.main
	elseif container == "craft" then
		return state.craft
	end
	return nil
end

--[[ The cursor belongs to the player, not to one container, so it is lent to
     whichever inventory is being clicked and taken straight back. ]]
local function withCursor(state: State, inventory: Inventory.Inventory, action: () -> boolean): boolean
	inventory.cursor = state.main.cursor
	local changed = action()
	state.main.cursor = inventory.cursor
	if inventory ~= state.main then
		inventory.cursor = nil
	end
	return changed
end

local function onClick(player: Player, container: string, slot: number, button: number)
	local state = states[player]
	if not state or type(slot) ~= "number" or type(button) ~= "number" then
		return
	end

	local inventory = containerOf(state, container)
	if not inventory then
		return
	end

	local changed = withCursor(state, inventory, function()
		return inventory:click(math.floor(slot), if button == 2 then 2 else 1)
	end)

	if changed then
		InventoryService.sync(player)
	end
end

local function onQuickMove(player: Player, container: string, slot: number)
	local state = states[player]
	if not state or type(slot) ~= "number" then
		return
	end

	slot = math.floor(slot)
	local changed = false

	if container == "craft" then
		local stack = state.craft:get(slot)
		if stack then
			local leftover = state.main:add(stack.id, stack.count)
			state.craft:set(slot, if leftover > 0 then { id = stack.id, count = leftover } else nil)
			changed = leftover < stack.count
		end
	elseif container == "main" then
		local hotbar = WorldConfig.HotbarSlots
		if slot <= hotbar then
			changed = state.main:quickMove(slot, hotbar + 1, state.main.size)
		else
			changed = state.main:quickMove(slot, 1, hotbar)
		end
	end

	if changed then
		InventoryService.sync(player)
	end
end

local function takeCraftResult(player: Player, takeAll: boolean)
	local state = states[player]
	if not state then
		return
	end

	local crafted = 0
	local limit = if takeAll then 64 else 1

	while crafted < limit do
		local result = craftResult(state)
		if not result then
			break
		end

		if takeAll then
			if not state.main:hasRoomFor(result.id, result.count) then
				break
			end
			state.main:add(result.id, result.count)
		else
			local cursor = state.main.cursor
			if cursor then
				if cursor.id ~= result.id then
					break
				end
				if cursor.count + result.count > ItemRegistry.maxStack(result.id) then
					break
				end
				cursor.count += result.count
			else
				state.main.cursor = { id = result.id, count = result.count }
			end
		end

		for slot = 1, GRID_SLOTS do
			state.craft:removeFromSlot(slot, 1)
		end
		crafted += 1
	end

	if crafted > 0 then
		InventoryService.sync(player)
	end
end

local function onDropStack(player: Player, container: string, slot: number)
	local state = states[player]
	if not state or type(slot) ~= "number" then
		return
	end

	local inventory = containerOf(state, container)
	if not inventory then
		return
	end

	local stack = inventory:get(math.floor(slot))
	if not stack then
		return
	end

	inventory:set(math.floor(slot), nil)
	DropService.dropFromPlayer(player, stack.id, stack.count)
	InventoryService.sync(player)
end

--[[ Anything still on the cursor or in the crafting grid goes back to the
     inventory - or on the floor - when the window closes or the player leaves. ]]
function InventoryService.returnLooseItems(player: Player)
	local state = states[player]
	if not state then
		return
	end

	local cursor = state.main.cursor
	if cursor then
		local leftover = state.main:add(cursor.id, cursor.count)
		if leftover > 0 then
			DropService.dropFromPlayer(player, cursor.id, leftover)
		end
		state.main.cursor = nil
	end

	for slot = 1, GRID_SLOTS do
		local stack = state.craft:get(slot)
		if stack then
			local leftover = state.main:add(stack.id, stack.count)
			if leftover > 0 then
				DropService.dropFromPlayer(player, stack.id, leftover)
			end
			state.craft:set(slot, nil)
		end
	end

	InventoryService.sync(player)
end

function InventoryService.start()
	Remotes.get("InventoryClick").OnServerEvent:Connect(function(player, container, slot, button)
		onClick(player, tostring(container), slot :: any, button :: any)
	end)

	Remotes.get("QuickMove").OnServerEvent:Connect(function(player, container, slot)
		onQuickMove(player, tostring(container), slot :: any)
	end)

	Remotes.get("CraftResult").OnServerEvent:Connect(function(player, takeAll)
		takeCraftResult(player, takeAll == true)
	end)

	Remotes.get("DropStack").OnServerEvent:Connect(function(player, container, slot)
		onDropStack(player, tostring(container), slot :: any)
	end)

	Remotes.get("SelectSlot").OnServerEvent:Connect(function(player, slot)
		local state = states[player]
		if not state or type(slot) ~= "number" then
			return
		end
		state.selected = math.clamp(math.floor(slot), 1, WorldConfig.HotbarSlots)
	end)

	DropService.pickedUp:connect(function(player: Player, itemId: number, count: number)
		InventoryService.addItem(player, itemId, count)
	end)

	DropService.canAccept = function(player: Player, itemId: number, count: number): boolean
		local state = states[player]
		return state ~= nil and state.main:hasRoomFor(itemId, count)
	end
end

return InventoryService
