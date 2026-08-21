--!strict
--[[ Shared look and feel for the HUD and the inventory window. ]]

local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Shared = ReplicatedStorage:WaitForChild("FakeMinecraft")
local BlockRegistry = require(Shared:WaitForChild("BlockRegistry"))
local ItemRegistry = require(Shared:WaitForChild("ItemRegistry"))

local UiKit = {}

UiKit.SlotSize = 54
UiKit.SlotPadding = 4
UiKit.Panel = Color3.fromRGB(28, 28, 32)
UiKit.SlotBackground = Color3.fromRGB(52, 52, 58)
UiKit.SlotBorder = Color3.fromRGB(20, 20, 24)
UiKit.Highlight = Color3.fromRGB(255, 255, 255)
UiKit.Text = Color3.fromRGB(240, 240, 240)

export type Slot = {
	frame: Frame,
	swatch: Frame,
	count: TextLabel,
	button: TextButton,
}

function UiKit.panel(name: string, parent: Instance): Frame
	local frame = Instance.new("Frame")
	frame.Name = name
	frame.BackgroundColor3 = UiKit.Panel
	frame.BackgroundTransparency = 0.08
	frame.BorderSizePixel = 0
	frame.Parent = parent

	local corner = Instance.new("UICorner")
	corner.CornerRadius = UDim.new(0, 6)
	corner.Parent = frame

	local stroke = Instance.new("UIStroke")
	stroke.Color = UiKit.SlotBorder
	stroke.Thickness = 2
	stroke.Parent = frame

	return frame
end

function UiKit.label(text: string, parent: Instance): TextLabel
	local label = Instance.new("TextLabel")
	label.BackgroundTransparency = 1
	label.Font = Enum.Font.GothamMedium
	label.TextColor3 = UiKit.Text
	label.TextSize = 14
	label.Text = text
	label.Parent = parent
	return label
end

--[[ One inventory cell: a coloured swatch for the item and a stack count. ]]
function UiKit.slot(parent: Instance, layoutOrder: number): Slot
	local frame = Instance.new("Frame")
	frame.Size = UDim2.fromOffset(UiKit.SlotSize, UiKit.SlotSize)
	frame.BackgroundColor3 = UiKit.SlotBackground
	frame.BorderSizePixel = 0
	frame.LayoutOrder = layoutOrder
	frame.Parent = parent

	local corner = Instance.new("UICorner")
	corner.CornerRadius = UDim.new(0, 4)
	corner.Parent = frame

	local stroke = Instance.new("UIStroke")
	stroke.Name = "Border"
	stroke.Color = UiKit.SlotBorder
	stroke.Thickness = 2
	stroke.Parent = frame

	local swatch = Instance.new("Frame")
	swatch.Name = "Swatch"
	swatch.AnchorPoint = Vector2.new(0.5, 0.5)
	swatch.Position = UDim2.fromScale(0.5, 0.5)
	swatch.Size = UDim2.fromOffset(UiKit.SlotSize - 18, UiKit.SlotSize - 18)
	swatch.BackgroundColor3 = Color3.new()
	swatch.BackgroundTransparency = 1
	swatch.BorderSizePixel = 0
	swatch.Parent = frame

	local swatchCorner = Instance.new("UICorner")
	swatchCorner.CornerRadius = UDim.new(0, 3)
	swatchCorner.Parent = swatch

	local count = Instance.new("TextLabel")
	count.Name = "Count"
	count.AnchorPoint = Vector2.new(1, 1)
	count.Position = UDim2.new(1, -4, 1, -2)
	count.Size = UDim2.fromOffset(30, 16)
	count.BackgroundTransparency = 1
	count.Font = Enum.Font.GothamBold
	count.TextColor3 = UiKit.Text
	count.TextStrokeTransparency = 0.2
	count.TextSize = 13
	count.TextXAlignment = Enum.TextXAlignment.Right
	count.Text = ""
	count.Parent = frame

	local button = Instance.new("TextButton")
	button.Name = "Click"
	button.Size = UDim2.fromScale(1, 1)
	button.BackgroundTransparency = 1
	button.Text = ""
	button.AutoButtonColor = false
	button.Parent = frame

	return { frame = frame, swatch = swatch, count = count, button = button }
end

--[[ Draws a stack into a slot, or empties it when `stack` is nil. ]]
function UiKit.paint(slot: Slot, stack: { id: number, count: number }?)
	if not stack then
		slot.swatch.BackgroundTransparency = 1
		slot.count.Text = ""
		return
	end

	local item = ItemRegistry.get(stack.id)
	if not item then
		slot.swatch.BackgroundTransparency = 1
		slot.count.Text = "?"
		return
	end

	slot.swatch.BackgroundColor3 = item.color
	slot.swatch.BackgroundTransparency = 0

	-- Tools read as a narrow bar so they do not look like a block.
	local isTool = item.toolClass ~= nil
	slot.swatch.Size = if isTool
		then UDim2.fromOffset(math.floor(UiKit.SlotSize * 0.3), UiKit.SlotSize - 16)
		else UDim2.fromOffset(UiKit.SlotSize - 18, UiKit.SlotSize - 18)

	local block = if item.blockId then BlockRegistry.get(item.blockId) else nil
	slot.swatch.BackgroundTransparency = if block then block.transparency * 0.6 else 0

	slot.count.Text = if stack.count > 1 then tostring(stack.count) else ""
end

function UiKit.setSelected(slot: Slot, selected: boolean)
	local stroke = slot.frame:FindFirstChild("Border") :: UIStroke?
	if stroke then
		stroke.Color = if selected then UiKit.Highlight else UiKit.SlotBorder
		stroke.Thickness = if selected then 3 else 2
	end
end

function UiKit.displayName(itemId: number): string
	local item = ItemRegistry.get(itemId)
	return if item then item.displayName else "Unknown"
end

return UiKit
