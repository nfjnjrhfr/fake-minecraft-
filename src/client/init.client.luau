--!strict
--[[
	Block tools: highlights the voxel under the mouse, breaks it on left click
	and places the selected hotbar block on right click. Number keys 1-7 pick
	the block; the server has the final say on both actions.
]]

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local UserInputService = game:GetService("UserInputService")

local Shared = ReplicatedStorage:WaitForChild("FakeMinecraft")
local BlockRegistry = require(Shared:WaitForChild("BlockRegistry"))
local Remotes = require(Shared:WaitForChild("Remotes"))
local VoxelWorld = require(Shared:WaitForChild("VoxelWorld"))
local WorldConfig = require(Shared:WaitForChild("WorldConfig"))

local player = Players.LocalPlayer
local mouse = player:GetMouse()

local placeBlock = Remotes.get("PlaceBlock")
local breakBlock = Remotes.get("BreakBlock")

local hotbar = BlockRegistry.hotbar()
local selectedSlot = 1

--------------------------------------------------------------------------------
-- Selection highlight
--------------------------------------------------------------------------------

local highlight = Instance.new("SelectionBox")
highlight.LineThickness = 0.04
highlight.Color3 = Color3.fromRGB(255, 255, 255)
highlight.SurfaceTransparency = 0.9
highlight.Parent = player:WaitForChild("PlayerGui")

local function targetPart(): BasePart?
	local target = mouse.Target
	if not target or not target:GetAttribute("Voxel") then
		return nil
	end

	local character = player.Character
	if character and target:IsDescendantOf(character) then
		return nil
	end

	local origin = character and character:FindFirstChild("HumanoidRootPart") :: BasePart?
	if origin and (target.Position - origin.Position).Magnitude > WorldConfig.MaxReach then
		return nil
	end

	return target
end

RunService.RenderStepped:Connect(function()
	highlight.Adornee = targetPart()
end)

--------------------------------------------------------------------------------
-- Hotbar
--------------------------------------------------------------------------------

local gui = Instance.new("ScreenGui")
gui.Name = "FakeMinecraftHotbar"
gui.ResetOnSpawn = false
gui.Parent = player:WaitForChild("PlayerGui")

local bar = Instance.new("Frame")
bar.AnchorPoint = Vector2.new(0.5, 1)
bar.Position = UDim2.new(0.5, 0, 1, -18)
bar.Size = UDim2.fromOffset(#hotbar * 52, 52)
bar.BackgroundColor3 = Color3.fromRGB(24, 24, 24)
bar.BackgroundTransparency = 0.35
bar.BorderSizePixel = 0
bar.Parent = gui

local barLayout = Instance.new("UIListLayout")
barLayout.FillDirection = Enum.FillDirection.Horizontal
barLayout.SortOrder = Enum.SortOrder.LayoutOrder
barLayout.Parent = bar

local slots: { Frame } = {}

for index, blockId in hotbar do
	local block = BlockRegistry.get(blockId)
	if not block then
		continue
	end

	local slot = Instance.new("Frame")
	slot.Size = UDim2.fromOffset(52, 52)
	slot.BackgroundColor3 = block.color
	slot.BorderSizePixel = 0
	slot.LayoutOrder = index
	slot.Parent = bar

	local stroke = Instance.new("UIStroke")
	stroke.Thickness = 2
	stroke.Color = Color3.fromRGB(255, 255, 255)
	stroke.Transparency = 1
	stroke.Parent = slot

	local label = Instance.new("TextLabel")
	label.Size = UDim2.fromScale(1, 1)
	label.BackgroundTransparency = 1
	label.Font = Enum.Font.SourceSansBold
	label.TextSize = 14
	label.TextColor3 = Color3.fromRGB(255, 255, 255)
	label.TextStrokeTransparency = 0.4
	label.TextYAlignment = Enum.TextYAlignment.Bottom
	label.Text = string.format("%d\n%s", index, block.name)
	label.Parent = slot

	slots[index] = slot
end

local function selectSlot(index: number)
	if not hotbar[index] then
		return
	end
	selectedSlot = index

	for slotIndex, slot in slots do
		local stroke = slot:FindFirstChildOfClass("UIStroke")
		if stroke then
			stroke.Transparency = if slotIndex == index then 0 else 1
		end
	end
end

selectSlot(1)

--------------------------------------------------------------------------------
-- Input
--------------------------------------------------------------------------------

--[[ Picks the voxel to break (the one hit) or to place into (its neighbour). ]]
local function hitVoxel(place: boolean)
	local part = targetPart()
	if not part then
		return
	end

	local coordinate
	if place then
		-- Snap the hit offset to its dominant axis so blocks stack cleanly.
		local offset = mouse.Hit.Position - part.Position
		local absolute = Vector3.new(math.abs(offset.X), math.abs(offset.Y), math.abs(offset.Z))
		local axis = if absolute.X >= absolute.Y and absolute.X >= absolute.Z
			then Vector3.new(math.sign(offset.X), 0, 0)
			elseif absolute.Y >= absolute.Z then Vector3.new(0, math.sign(offset.Y), 0)
			else Vector3.new(0, 0, math.sign(offset.Z))

		coordinate = VoxelWorld.toVoxel(part.Position + axis * WorldConfig.BlockSize)
	else
		coordinate = VoxelWorld.toVoxel(part.Position)
	end

	if place then
		placeBlock:FireServer(coordinate.x, coordinate.y, coordinate.z, hotbar[selectedSlot])
	else
		breakBlock:FireServer(coordinate.x, coordinate.y, coordinate.z)
	end
end

UserInputService.InputBegan:Connect(function(input, processed)
	if processed then
		return
	end

	if input.UserInputType == Enum.UserInputType.MouseButton1 then
		hitVoxel(false)
	elseif input.UserInputType == Enum.UserInputType.MouseButton2 then
		hitVoxel(true)
	elseif input.UserInputType == Enum.UserInputType.Keyboard then
		local digit = string.match(input.KeyCode.Name, "^%a*(%d)$")
		if digit then
			selectSlot(tonumber(digit) :: number)
		end
	end
end)
