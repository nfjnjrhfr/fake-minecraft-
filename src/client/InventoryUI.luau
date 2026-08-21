--!strict
--[[
	The inventory window: 27 storage slots, the hotbar row, and a 3x3 crafting
	grid. Clicks are sent to the server and the window redraws from the reply,
	so the panel can never disagree with what the player actually owns.
]]

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local UserInputService = game:GetService("UserInputService")

local Shared = ReplicatedStorage:WaitForChild("FakeMinecraft")
local Signal = require(Shared:WaitForChild("Signal"))
local WorldConfig = require(Shared:WaitForChild("WorldConfig"))

local InventoryClient = require(script.Parent.InventoryClient)
local UiKit = require(script.Parent.UiKit)

local GRID = WorldConfig.CraftGridSize
local HOTBAR = WorldConfig.HotbarSlots
local STORAGE_ROWS = math.floor((WorldConfig.InventorySlots - HOTBAR) / HOTBAR)

local InventoryUI = {}

local player = Players.LocalPlayer
local gui: ScreenGui
local window: Frame
local cursorSlot: UiKit.Slot
local mainSlots: { UiKit.Slot } = {}
local craftSlots: { UiKit.Slot } = {}
local resultSlot: UiKit.Slot
local open = false

InventoryUI.opened = Signal.new()
InventoryUI.closed = Signal.new()

local function shiftHeld(): boolean
	return UserInputService:IsKeyDown(Enum.KeyCode.LeftShift) or UserInputService:IsKeyDown(Enum.KeyCode.RightShift)
end

local function bindSlot(slot: UiKit.Slot, container: string, index: number)
	slot.button.MouseButton1Click:Connect(function()
		if shiftHeld() then
			InventoryClient.quickMove(container, index)
		else
			InventoryClient.click(container, index, 1)
		end
	end)

	slot.button.MouseButton2Click:Connect(function()
		InventoryClient.click(container, index, 2)
	end)
end

local function grid(parent: Instance, name: string, columns: number, count: number, offset: number, container: string, store: { UiKit.Slot })
	local holder = Instance.new("Frame")
	holder.Name = name
	holder.BackgroundTransparency = 1
	holder.Size = UDim2.fromOffset(
		columns * (UiKit.SlotSize + UiKit.SlotPadding),
		math.ceil(count / columns) * (UiKit.SlotSize + UiKit.SlotPadding)
	)
	holder.Parent = parent

	local layout = Instance.new("UIGridLayout")
	layout.CellSize = UDim2.fromOffset(UiKit.SlotSize, UiKit.SlotSize)
	layout.CellPadding = UDim2.fromOffset(UiKit.SlotPadding, UiKit.SlotPadding)
	layout.SortOrder = Enum.SortOrder.LayoutOrder
	layout.Parent = holder

	for index = 1, count do
		local slot = UiKit.slot(holder, index)
		bindSlot(slot, container, offset + index)
		store[offset + index] = slot
	end

	return holder
end

local function buildWindow(parent: Instance)
	window = UiKit.panel("Inventory", parent)
	window.AnchorPoint = Vector2.new(0.5, 0.5)
	window.Position = UDim2.fromScale(0.5, 0.5)
	window.Size = UDim2.fromOffset(
		HOTBAR * (UiKit.SlotSize + UiKit.SlotPadding) + 40,
		(STORAGE_ROWS + 1) * (UiKit.SlotSize + UiKit.SlotPadding) + GRID * (UiKit.SlotSize + UiKit.SlotPadding) + 120
	)
	window.Visible = false

	local padding = Instance.new("UIPadding")
	padding.PaddingTop = UDim.new(0, 16)
	padding.PaddingLeft = UDim.new(0, 20)
	padding.PaddingRight = UDim.new(0, 20)
	padding.PaddingBottom = UDim.new(0, 16)
	padding.Parent = window

	local layout = Instance.new("UIListLayout")
	layout.Padding = UDim.new(0, 12)
	layout.SortOrder = Enum.SortOrder.LayoutOrder
	layout.Parent = window

	-- Crafting row: the 3x3 grid, an arrow, and the result.
	local craftRow = Instance.new("Frame")
	craftRow.Name = "CraftRow"
	craftRow.BackgroundTransparency = 1
	craftRow.LayoutOrder = 1
	craftRow.Size = UDim2.new(1, 0, 0, GRID * (UiKit.SlotSize + UiKit.SlotPadding))
	craftRow.Parent = window

	local craftLayout = Instance.new("UIListLayout")
	craftLayout.FillDirection = Enum.FillDirection.Horizontal
	craftLayout.VerticalAlignment = Enum.VerticalAlignment.Center
	craftLayout.Padding = UDim.new(0, 16)
	craftLayout.SortOrder = Enum.SortOrder.LayoutOrder
	craftLayout.Parent = craftRow

	grid(craftRow, "CraftGrid", GRID, GRID * GRID, 0, "craft", craftSlots)

	local arrow = UiKit.label("→", craftRow)
	arrow.Size = UDim2.fromOffset(30, UiKit.SlotSize)
	arrow.TextSize = 26
	arrow.LayoutOrder = 2

	local resultHolder = Instance.new("Frame")
	resultHolder.BackgroundTransparency = 1
	resultHolder.Size = UDim2.fromOffset(UiKit.SlotSize, UiKit.SlotSize)
	resultHolder.LayoutOrder = 3
	resultHolder.Parent = craftRow

	resultSlot = UiKit.slot(resultHolder, 1)
	resultSlot.button.MouseButton1Click:Connect(function()
		InventoryClient.takeResult(shiftHeld())
	end)

	local divider = Instance.new("Frame")
	divider.Name = "Divider"
	divider.BackgroundColor3 = UiKit.SlotBorder
	divider.BorderSizePixel = 0
	divider.LayoutOrder = 2
	divider.Size = UDim2.new(1, 0, 0, 2)
	divider.Parent = window

	local storage = grid(window, "Storage", HOTBAR, STORAGE_ROWS * HOTBAR, HOTBAR, "main", mainSlots)
	storage.LayoutOrder = 3

	local hotbar = grid(window, "HotbarRow", HOTBAR, HOTBAR, 0, "main", mainSlots)
	hotbar.LayoutOrder = 4

	local hint = UiKit.label("E close    shift+click move stack    right click split    Q drop", window)
	hint.LayoutOrder = 5
	hint.Size = UDim2.new(1, 0, 0, 18)
	hint.TextSize = 12
	hint.TextTransparency = 0.35

	-- The held stack rides on the mouse and must draw over everything.
	local cursorHolder = Instance.new("Frame")
	cursorHolder.Name = "Cursor"
	cursorHolder.BackgroundTransparency = 1
	cursorHolder.Size = UDim2.fromOffset(UiKit.SlotSize, UiKit.SlotSize)
	cursorHolder.ZIndex = 50
	cursorHolder.Visible = false
	cursorHolder.Parent = parent

	cursorSlot = UiKit.slot(cursorHolder, 1)
	cursorSlot.frame.BackgroundTransparency = 1
	cursorSlot.frame.ZIndex = 50
	cursorSlot.swatch.ZIndex = 51
	cursorSlot.count.ZIndex = 52
	cursorSlot.button.Active = false
	cursorSlot.button.Visible = false

	local border = cursorSlot.frame:FindFirstChild("Border")
	if border then
		border:Destroy()
	end
end

local function redraw()
	for slot = 1, WorldConfig.InventorySlots do
		local widget = mainSlots[slot]
		if widget then
			UiKit.paint(widget, InventoryClient.get("main", slot))
			UiKit.setSelected(widget, slot == InventoryClient.selected())
		end
	end

	for slot = 1, GRID * GRID do
		local widget = craftSlots[slot]
		if widget then
			UiKit.paint(widget, InventoryClient.get("craft", slot))
		end
	end

	UiKit.paint(resultSlot, InventoryClient.result())

	local cursor = InventoryClient.cursor()
	UiKit.paint(cursorSlot, cursor)
	cursorSlot.frame.Parent.Visible = cursor ~= nil and open
end

function InventoryUI.setOpen(value: boolean)
	if open == value then
		return
	end

	open = value
	window.Visible = open
	redraw()

	if open then
		InventoryUI.opened:fire()
	else
		InventoryUI.closed:fire()
	end
end

function InventoryUI.start()
	gui = Instance.new("ScreenGui")
	gui.Name = "FakeMinecraftInventory"
	gui.ResetOnSpawn = false
	gui.IgnoreGuiInset = true
	gui.ZIndexBehavior = Enum.ZIndexBehavior.Sibling
	gui.Parent = player:WaitForChild("PlayerGui")

	buildWindow(gui)
	redraw()

	InventoryClient.changed:connect(redraw)

	UserInputService.InputBegan:Connect(function(input, processed)
		if processed then
			return
		end

		if input.KeyCode == Enum.KeyCode.E then
			InventoryUI.setOpen(not open)
		elseif input.KeyCode == Enum.KeyCode.Escape and open then
			InventoryUI.setOpen(false)
		elseif input.KeyCode == Enum.KeyCode.Q and not open then
			InventoryClient.drop("main", InventoryClient.selected())
		end
	end)

	RunService.RenderStepped:Connect(function()
		if not open then
			return
		end

		local holder = cursorSlot.frame.Parent :: Frame
		if holder.Visible then
			local mouse = UserInputService:GetMouseLocation()
			holder.Position = UDim2.fromOffset(
				mouse.X - UiKit.SlotSize / 2,
				mouse.Y - UiKit.SlotSize / 2
			)
		end
	end)
end

return InventoryUI
