--!strict
--[[
	The client's replica of its inventory. Never edited locally: it is redrawn
	from whatever the server last sent, and every interaction is a remote call.
]]

local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Shared = ReplicatedStorage:WaitForChild("FakeMinecraft")
local Remotes = require(Shared:WaitForChild("Remotes"))
local Signal = require(Shared:WaitForChild("Signal"))
local WorldConfig = require(Shared:WaitForChild("WorldConfig"))

export type Stack = { id: number, count: number }

local InventoryClient = {}

local main: { [number]: Stack } = {}
local craft: { [number]: Stack } = {}
local cursor: Stack? = nil
local result: Stack? = nil
local selected = 1

InventoryClient.changed = Signal.new()

local function unpackSlots(data: { { number } }?): { [number]: Stack }
	local slots: { [number]: Stack } = {}
	if not data then
		return slots
	end

	for _, entry in data do
		local slot, id, count = entry[1], entry[2], entry[3]
		if slot and id and count then
			slots[slot] = { id = id, count = count }
		end
	end
	return slots
end

function InventoryClient.get(container: string, slot: number): Stack?
	if container == "craft" then
		return craft[slot]
	end
	return main[slot]
end

function InventoryClient.cursor(): Stack?
	return cursor
end

function InventoryClient.result(): Stack?
	return result
end

function InventoryClient.selected(): number
	return selected
end

function InventoryClient.selectedStack(): Stack?
	return main[selected]
end

function InventoryClient.selectSlot(slot: number)
	local clamped = math.clamp(slot, 1, WorldConfig.HotbarSlots)
	if clamped == selected then
		return
	end

	selected = clamped
	Remotes.get("SelectSlot"):FireServer(clamped)
	InventoryClient.changed:fire()
end

function InventoryClient.cycleSelection(direction: number)
	local hotbar = WorldConfig.HotbarSlots
	InventoryClient.selectSlot((selected - 1 + direction) % hotbar + 1)
end

function InventoryClient.click(container: string, slot: number, button: number)
	Remotes.get("InventoryClick"):FireServer(container, slot, button)
end

function InventoryClient.quickMove(container: string, slot: number)
	Remotes.get("QuickMove"):FireServer(container, slot)
end

function InventoryClient.takeResult(takeAll: boolean)
	Remotes.get("CraftResult"):FireServer(takeAll)
end

function InventoryClient.drop(container: string, slot: number)
	Remotes.get("DropStack"):FireServer(container, slot)
end

function InventoryClient.start()
	Remotes.get("InventorySync").OnClientEvent:Connect(function(
		slots: { { number } }?,
		cursorData: { number }?,
		craftData: { { number } }?,
		craftResult: Stack?,
		selectedSlot: number?
	)
		main = unpackSlots(slots)
		craft = unpackSlots(craftData)
		cursor = if cursorData then { id = cursorData[1], count = cursorData[2] } else nil
		result = craftResult
		selected = math.clamp(selectedSlot or selected, 1, WorldConfig.HotbarSlots)

		InventoryClient.changed:fire()
	end)
end

return InventoryClient
