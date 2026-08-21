--!strict
--[[ Crosshair, hotbar, notices and the debug readout. ]]

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local UserInputService = game:GetService("UserInputService")

local Shared = ReplicatedStorage:WaitForChild("FakeMinecraft")
local Coordinates = require(Shared:WaitForChild("Coordinates"))
local Remotes = require(Shared:WaitForChild("Remotes"))
local WorldConfig = require(Shared:WaitForChild("WorldConfig"))

local BlockTool = require(script.Parent.BlockTool)
local ChunkRenderer = require(script.Parent.ChunkRenderer)
local InventoryClient = require(script.Parent.InventoryClient)
local UiKit = require(script.Parent.UiKit)
local WorldMirror = require(script.Parent.WorldMirror)

local Hud = {}

local player = Players.LocalPlayer
local slots: { UiKit.Slot } = {}
local nameLabel: TextLabel
local noticeLabel: TextLabel
local debugLabel: TextLabel
local debugVisible = false
local noticeUntil = 0
local frameDelta = 1 / 60

local function buildCrosshair(parent: Instance)
	local holder = Instance.new("Frame")
	holder.AnchorPoint = Vector2.new(0.5, 0.5)
	holder.Position = UDim2.fromScale(0.5, 0.5)
	holder.Size = UDim2.fromOffset(18, 18)
	holder.BackgroundTransparency = 1
	holder.Parent = parent

	for _, axis in { "X", "Y" } do
		local bar = Instance.new("Frame")
		bar.AnchorPoint = Vector2.new(0.5, 0.5)
		bar.Position = UDim2.fromScale(0.5, 0.5)
		bar.Size = if axis == "X" then UDim2.fromOffset(18, 2) else UDim2.fromOffset(2, 18)
		bar.BackgroundColor3 = Color3.fromRGB(245, 245, 245)
		bar.BackgroundTransparency = 0.25
		bar.BorderSizePixel = 0
		bar.Parent = holder
	end
end

local function buildHotbar(parent: Instance)
	local hotbar = Instance.new("Frame")
	hotbar.Name = "Hotbar"
	hotbar.AnchorPoint = Vector2.new(0.5, 1)
	hotbar.Position = UDim2.new(0.5, 0, 1, -22)
	hotbar.Size = UDim2.fromOffset(
		WorldConfig.HotbarSlots * (UiKit.SlotSize + UiKit.SlotPadding) + UiKit.SlotPadding,
		UiKit.SlotSize + UiKit.SlotPadding * 2
	)
	hotbar.BackgroundColor3 = UiKit.Panel
	hotbar.BackgroundTransparency = 0.25
	hotbar.BorderSizePixel = 0
	hotbar.Parent = parent

	local corner = Instance.new("UICorner")
	corner.CornerRadius = UDim.new(0, 6)
	corner.Parent = hotbar

	local layout = Instance.new("UIListLayout")
	layout.FillDirection = Enum.FillDirection.Horizontal
	layout.HorizontalAlignment = Enum.HorizontalAlignment.Center
	layout.VerticalAlignment = Enum.VerticalAlignment.Center
	layout.Padding = UDim.new(0, UiKit.SlotPadding)
	layout.SortOrder = Enum.SortOrder.LayoutOrder
	layout.Parent = hotbar

	for index = 1, WorldConfig.HotbarSlots do
		local slot = UiKit.slot(hotbar, index)
		slot.button.Activated:Connect(function()
			InventoryClient.selectSlot(index)
		end)
		slots[index] = slot
	end

	nameLabel = UiKit.label("", parent)
	nameLabel.AnchorPoint = Vector2.new(0.5, 1)
	nameLabel.Position = UDim2.new(0.5, 0, 1, -(UiKit.SlotSize + 34))
	nameLabel.Size = UDim2.fromOffset(320, 20)
	nameLabel.Font = Enum.Font.GothamBold
	nameLabel.TextStrokeTransparency = 0.4
	nameLabel.TextTransparency = 1
end

local function buildNotice(parent: Instance)
	noticeLabel = UiKit.label("", parent)
	noticeLabel.AnchorPoint = Vector2.new(0.5, 0)
	noticeLabel.Position = UDim2.new(0.5, 0, 0, 24)
	noticeLabel.Size = UDim2.fromOffset(420, 22)
	noticeLabel.Font = Enum.Font.GothamBold
	noticeLabel.TextStrokeTransparency = 0.35
	noticeLabel.TextTransparency = 1
end

local function buildDebug(parent: Instance)
	debugLabel = UiKit.label("", parent)
	debugLabel.Position = UDim2.fromOffset(14, 12)
	debugLabel.Size = UDim2.fromOffset(360, 108)
	debugLabel.Font = Enum.Font.Code
	debugLabel.TextSize = 13
	debugLabel.TextXAlignment = Enum.TextXAlignment.Left
	debugLabel.TextYAlignment = Enum.TextYAlignment.Top
	debugLabel.TextStrokeTransparency = 0.4
	debugLabel.Visible = false
end

local function redraw()
	local selected = InventoryClient.selected()

	for index = 1, WorldConfig.HotbarSlots do
		local slot = slots[index]
		UiKit.paint(slot, InventoryClient.get("main", index))
		UiKit.setSelected(slot, index == selected)
	end

	local stack = InventoryClient.selectedStack()
	if stack then
		nameLabel.Text = UiKit.displayName(stack.id)
		nameLabel.TextTransparency = 0
	else
		nameLabel.TextTransparency = 1
	end
end

function Hud.notice(message: string)
	noticeLabel.Text = message
	noticeLabel.TextTransparency = 0
	noticeUntil = os.clock() + 3
end

local function updateDebug()
	if not debugVisible then
		return
	end

	local character = player.Character
	local root = character and character:FindFirstChild("HumanoidRootPart")
	local position = if root then (root :: BasePart).Position else Vector3.zero
	local x, y, z = Coordinates.worldToVoxel(position)
	local cx, cz = Coordinates.chunkOf(x, z)

	local target = BlockTool.currentTarget()
	local targetText = if target
		then string.format("%d, %d, %d", target.x, target.y, target.z)
		else "none"

	debugLabel.Text = table.concat({
		string.format("xyz     %d, %d, %d", x, y, z),
		string.format("chunk   %d, %d", cx, cz),
		string.format("looking %s", targetText),
		string.format("chunks  %d loaded / %d drawn / %d queued", WorldMirror.loadedCount(), ChunkRenderer.renderedCount(), ChunkRenderer.pendingCount()),
		string.format("fps     %d", math.floor(1 / math.max(frameDelta, 1e-4))),
	}, "\n")
end

function Hud.start()
	local gui = Instance.new("ScreenGui")
	gui.Name = "FakeMinecraftHud"
	gui.ResetOnSpawn = false
	gui.IgnoreGuiInset = true
	gui.ZIndexBehavior = Enum.ZIndexBehavior.Sibling
	gui.Parent = player:WaitForChild("PlayerGui")

	buildCrosshair(gui)
	buildHotbar(gui)
	buildNotice(gui)
	buildDebug(gui)
	redraw()

	InventoryClient.changed:connect(redraw)

	RunService.RenderStepped:Connect(function(delta)
		-- Smoothed so the readout is legible rather than flickering.
		frameDelta += (delta - frameDelta) * 0.1
	end)

	Remotes.get("Notice").OnClientEvent:Connect(function(message: string)
		Hud.notice(tostring(message))
	end)

	UserInputService.InputBegan:Connect(function(input, processed)
		if processed then
			return
		end

		if input.UserInputType == Enum.UserInputType.Keyboard then
			local digit = tonumber(string.match(input.KeyCode.Name, "^%a*(%d)$"))
			if digit and digit >= 1 and digit <= WorldConfig.HotbarSlots then
				InventoryClient.selectSlot(digit)
			elseif input.KeyCode == Enum.KeyCode.F3 then
				debugVisible = not debugVisible
				debugLabel.Visible = debugVisible
			end
		elseif input.UserInputType == Enum.UserInputType.MouseWheel then
			InventoryClient.cycleSelection(if input.Position.Z > 0 then -1 else 1)
		end
	end)

	task.spawn(function()
		while true do
			task.wait(0.25)
			if noticeUntil > 0 and os.clock() > noticeUntil then
				noticeLabel.TextTransparency = 1
				noticeUntil = 0
			end
			updateDebug()
		end
	end)
end

return Hud
