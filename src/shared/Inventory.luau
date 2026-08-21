--!strict
--[[
	Slot storage plus the click semantics players expect. The server owns one of
	these per player and is the only thing that mutates it; the client renders a
	replica.
]]

local ItemRegistry = require(script.Parent.ItemRegistry)
local WorldConfig = require(script.Parent.WorldConfig)

export type Stack = { id: number, count: number }

local Inventory = {}
Inventory.__index = Inventory

export type Inventory = typeof(setmetatable(
	{} :: { size: number, slots: { [number]: Stack }, cursor: Stack? },
	Inventory
))

function Inventory.new(size: number?): Inventory
	return setmetatable({
		size = size or WorldConfig.InventorySlots,
		slots = {},
		cursor = nil,
	}, Inventory)
end

local function stackOf(id: number, count: number): Stack?
	if count <= 0 then
		return nil
	end
	return { id = id, count = count }
end

function Inventory.get(self: Inventory, slot: number): Stack?
	return self.slots[slot]
end

function Inventory.set(self: Inventory, slot: number, stack: Stack?)
	if slot < 1 or slot > self.size then
		return
	end
	if stack and stack.count > 0 then
		self.slots[slot] = stack
	else
		self.slots[slot] = nil
	end
end

function Inventory.countOf(self: Inventory, itemId: number): number
	local total = 0
	for _, stack in self.slots do
		if stack.id == itemId then
			total += stack.count
		end
	end
	return total
end

--[[ Adds items, filling partial stacks first. Returns what did not fit. ]]
function Inventory.add(self: Inventory, itemId: number, count: number): number
	if not ItemRegistry.exists(itemId) or count <= 0 then
		return count
	end

	local maxStack = ItemRegistry.maxStack(itemId)
	local remaining = count

	for slot = 1, self.size do
		if remaining <= 0 then
			break
		end
		local stack = self.slots[slot]
		if stack and stack.id == itemId and stack.count < maxStack then
			local room = maxStack - stack.count
			local moved = math.min(room, remaining)
			stack.count += moved
			remaining -= moved
		end
	end

	for slot = 1, self.size do
		if remaining <= 0 then
			break
		end
		if not self.slots[slot] then
			local moved = math.min(maxStack, remaining)
			self.slots[slot] = { id = itemId, count = moved }
			remaining -= moved
		end
	end

	return remaining
end

--[[ Removes up to `count` of an item. Returns how many were actually removed. ]]
function Inventory.remove(self: Inventory, itemId: number, count: number): number
	local removed = 0

	for slot = self.size, 1, -1 do
		if removed >= count then
			break
		end
		local stack = self.slots[slot]
		if stack and stack.id == itemId then
			local taken = math.min(stack.count, count - removed)
			stack.count -= taken
			removed += taken
			if stack.count <= 0 then
				self.slots[slot] = nil
			end
		end
	end

	return removed
end

function Inventory.removeFromSlot(self: Inventory, slot: number, count: number): number
	local stack = self.slots[slot]
	if not stack then
		return 0
	end

	local taken = math.min(stack.count, count)
	stack.count -= taken
	if stack.count <= 0 then
		self.slots[slot] = nil
	end
	return taken
end

function Inventory.hasRoomFor(self: Inventory, itemId: number, count: number): boolean
	local maxStack = ItemRegistry.maxStack(itemId)
	local room = 0

	for slot = 1, self.size do
		local stack = self.slots[slot]
		if not stack then
			room += maxStack
		elseif stack.id == itemId then
			room += maxStack - stack.count
		end
		if room >= count then
			return true
		end
	end

	return false
end

--[[
	One click on a slot, with the stack the player is holding on the mouse.
	`button` is 1 for a whole-stack click and 2 for the half/one-at-a-time click.
	Returns true when anything changed.
]]
function Inventory.click(self: Inventory, slot: number, button: number): boolean
	if slot < 1 or slot > self.size then
		return false
	end

	local held = self.cursor
	local stack = self.slots[slot]

	if button == 2 then
		if not held then
			if not stack then
				return false
			end
			local half = math.ceil(stack.count / 2)
			self.cursor = stackOf(stack.id, half)
			self.slots[slot] = stackOf(stack.id, stack.count - half)
			return true
		end

		if not stack then
			self.slots[slot] = { id = held.id, count = 1 }
			held.count -= 1
			self.cursor = if held.count > 0 then held else nil
			return true
		end

		if stack.id == held.id and stack.count < ItemRegistry.maxStack(stack.id) then
			stack.count += 1
			held.count -= 1
			self.cursor = if held.count > 0 then held else nil
			return true
		end

		return false
	end

	if not held then
		if not stack then
			return false
		end
		self.cursor = stack
		self.slots[slot] = nil
		return true
	end

	if not stack then
		self.slots[slot] = held
		self.cursor = nil
		return true
	end

	if stack.id == held.id then
		local maxStack = ItemRegistry.maxStack(stack.id)
		local moved = math.min(maxStack - stack.count, held.count)
		if moved <= 0 then
			-- Both stacks are full: swapping them would be a no-op.
			return false
		end
		stack.count += moved
		held.count -= moved
		self.cursor = if held.count > 0 then held else nil
		return true
	end

	self.slots[slot] = held
	self.cursor = stack
	return true
end

--[[ Moves a whole stack to the first slot that will take it, the way a
     shift-click does. ]]
function Inventory.quickMove(self: Inventory, slot: number, rangeStart: number, rangeEnd: number): boolean
	local stack = self.slots[slot]
	if not stack then
		return false
	end

	local maxStack = ItemRegistry.maxStack(stack.id)
	local moved = false

	for target = rangeStart, rangeEnd do
		if stack.count <= 0 then
			break
		end
		if target ~= slot then
			local other = self.slots[target]
			if other and other.id == stack.id and other.count < maxStack then
				local amount = math.min(maxStack - other.count, stack.count)
				other.count += amount
				stack.count -= amount
				moved = true
			end
		end
	end

	if stack.count > 0 then
		for target = rangeStart, rangeEnd do
			if target ~= slot and not self.slots[target] then
				self.slots[target] = { id = stack.id, count = stack.count }
				stack.count = 0
				moved = true
				break
			end
		end
	end

	if stack.count <= 0 then
		self.slots[slot] = nil
	end
	return moved
end

function Inventory.clear(self: Inventory)
	table.clear(self.slots)
	self.cursor = nil
end

--[[ Compact form for the wire and the datastore. ]]
function Inventory.serialize(self: Inventory): { { number } }
	local out: { { number } } = {}
	for slot = 1, self.size do
		local stack = self.slots[slot]
		if stack then
			table.insert(out, { slot, stack.id, stack.count })
		end
	end
	return out
end

function Inventory.deserialize(self: Inventory, data: { { number } }?)
	self:clear()
	if not data then
		return
	end

	for _, entry in data do
		local slot, id, count = entry[1], entry[2], entry[3]
		if slot and id and count and slot >= 1 and slot <= self.size and ItemRegistry.exists(id) then
			local capped = math.clamp(count, 1, ItemRegistry.maxStack(id))
			self.slots[slot] = { id = id, count = capped }
		end
	end
end

return Inventory
