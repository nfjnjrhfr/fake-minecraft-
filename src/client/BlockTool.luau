--!strict
--[[
	Aiming, breaking and placing.

	The target is found by walking the voxel grid, not by casting at parts: the
	greedy mesher merges many blocks into one part, so a part hit would not tell
	us which block was hit.
]]

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local UserInputService = game:GetService("UserInputService")
local Workspace = game:GetService("Workspace")

local Shared = ReplicatedStorage:WaitForChild("FakeMinecraft")
local BlockRegistry = require(Shared:WaitForChild("BlockRegistry"))
local Coordinates = require(Shared:WaitForChild("Coordinates"))
local ItemRegistry = require(Shared:WaitForChild("ItemRegistry"))
local Remotes = require(Shared:WaitForChild("Remotes"))
local VoxelRaycast = require(Shared:WaitForChild("VoxelRaycast"))
local WorldConfig = require(Shared:WaitForChild("WorldConfig"))

local InventoryClient = require(script.Parent.InventoryClient)
local WorldMirror = require(script.Parent.WorldMirror)

local BlockTool = {}

local player = Players.LocalPlayer
local camera = Workspace.CurrentCamera

local highlight: BasePart
local crack: BasePart

local target: VoxelRaycast.Hit? = nil
local breaking = false
local placing = false
local progress = 0
local swingSent = false
local lastPlaceAt = 0
local enabled = true

local breakStart = Remotes.get("BreakStart")
local breakBlock = Remotes.get("BreakBlock")
local placeBlock = Remotes.get("PlaceBlock")

function BlockTool.setEnabled(value: boolean)
	enabled = value
	if not enabled then
		breaking = false
		placing = false
		progress = 0
	end
end

function BlockTool.currentTarget(): VoxelRaycast.Hit?
	return target
end

local function buildAdornments()
	highlight = Instance.new("Part")
	highlight.Name = "BlockHighlight"
	highlight.Anchored = true
	highlight.CanCollide = false
	highlight.CanQuery = false
	highlight.CanTouch = false
	highlight.CastShadow = false
	highlight.Transparency = 1
	highlight.Size = Vector3.one * WorldConfig.BlockSize
	highlight.Parent = Workspace

	local box = Instance.new("SelectionBox")
	box.Adornee = highlight
	box.Color3 = Color3.fromRGB(20, 20, 20)
	box.LineThickness = 0.03
	box.SurfaceTransparency = 1
	box.Parent = highlight

	crack = Instance.new("Part")
	crack.Name = "BlockCrack"
	crack.Anchored = true
	crack.CanCollide = false
	crack.CanQuery = false
	crack.CanTouch = false
	crack.CastShadow = false
	crack.Color = Color3.new()
	crack.Material = Enum.Material.SmoothPlastic
	crack.Transparency = 1
	crack.Size = Vector3.one * (WorldConfig.BlockSize * 1.02)
	crack.Parent = Workspace
end

local function aimRay(): (Vector3, Vector3)
	local viewport = camera.ViewportSize
	local position = if UserInputService.MouseBehavior == Enum.MouseBehavior.LockCenter
		then Vector2.new(viewport.X / 2, viewport.Y / 2)
		else UserInputService:GetMouseLocation()

	local ray = camera:ViewportPointToRay(position.X, position.Y)
	return ray.Origin, ray.Direction
end

--[[ Water and air do not stop the ray; everything else does. ]]
local function isTargetable(x: number, y: number, z: number): boolean
	return BlockRegistry.isSolid(WorldMirror.getBlock(x, y, z))
end

local function updateTarget()
	if not enabled then
		target = nil
		highlight.Transparency = 1
		crack.Transparency = 1
		return
	end

	local origin, direction = aimRay()
	local hit = VoxelRaycast.cast(isTargetable, origin, direction, WorldConfig.MaxReach)

	local changed = (hit == nil) ~= (target == nil)
	if hit and target then
		changed = hit.x ~= target.x or hit.y ~= target.y or hit.z ~= target.z
	end

	target = hit

	if hit then
		highlight.Position = Coordinates.voxelToWorld(hit.x, hit.y, hit.z)
		highlight.Transparency = 0.98
	else
		highlight.Transparency = 1
	end

	if changed then
		progress = 0
		swingSent = false
		crack.Transparency = 1
	end
end

local function updateBreaking(delta: number)
	if not breaking or not target then
		progress = 0
		swingSent = false
		crack.Transparency = 1
		return
	end

	local hit = target
	local blockId = WorldMirror.getBlock(hit.x, hit.y, hit.z)
	if not BlockRegistry.isBreakable(blockId) then
		crack.Transparency = 1
		return
	end

	if not swingSent then
		swingSent = true
		breakStart:FireServer(hit.x, hit.y, hit.z)
	end

	local selected = InventoryClient.selectedStack()
	local duration = ItemRegistry.breakTime(blockId, if selected then selected.id else nil)

	progress += delta
	local fraction = if duration <= 0 then 1 else math.clamp(progress / duration, 0, 1)

	crack.Position = Coordinates.voxelToWorld(hit.x, hit.y, hit.z)
	crack.Transparency = 1 - fraction * 0.55

	if fraction >= 1 then
		breakBlock:FireServer(hit.x, hit.y, hit.z)
		-- Predict the break so the world reacts now; the server sends the block
		-- back if it disagrees.
		WorldMirror.setBlock(hit.x, hit.y, hit.z, BlockRegistry.Air)
		progress = 0
		swingSent = false
		crack.Transparency = 1
	end
end

--[[ Refuse a placement that would land inside the player, before asking. ]]
local function fitsAround(x: number, y: number, z: number): boolean
	local character = player.Character
	if not character then
		return true
	end

	local centre = Coordinates.voxelToWorld(x, y, z)
	local half = WorldConfig.BlockSize * 0.5

	for _, part in character:GetChildren() do
		if part:IsA("BasePart") then
			local offset = part.Position - centre
			local reach = half + math.max(part.Size.X, part.Size.Y, part.Size.Z) * 0.5
			if math.abs(offset.X) < reach and math.abs(offset.Y) < reach and math.abs(offset.Z) < reach then
				return false
			end
		end
	end

	return true
end

local function tryPlace()
	if not enabled or not target then
		return
	end

	local now = os.clock()
	if now - lastPlaceAt < WorldConfig.PlaceCooldown then
		return
	end

	local stack = InventoryClient.selectedStack()
	if not stack or not ItemRegistry.isPlaceable(stack.id) then
		return
	end

	local hit = target
	local x, y, z = hit.previousX, hit.previousY, hit.previousZ
	if y < 0 or y >= WorldConfig.WorldHeight then
		return
	end
	if BlockRegistry.isSolid(WorldMirror.getBlock(x, y, z)) or not fitsAround(x, y, z) then
		return
	end

	lastPlaceAt = now
	placeBlock:FireServer(x, y, z)
end

function BlockTool.start()
	buildAdornments()

	UserInputService.InputBegan:Connect(function(input, processed)
		if processed or not enabled then
			return
		end

		if input.UserInputType == Enum.UserInputType.MouseButton1 then
			breaking = true
		elseif input.UserInputType == Enum.UserInputType.MouseButton2 then
			placing = true
			tryPlace()
		end
	end)

	UserInputService.InputEnded:Connect(function(input)
		if input.UserInputType == Enum.UserInputType.MouseButton1 then
			breaking = false
			progress = 0
			swingSent = false
			crack.Transparency = 1
		elseif input.UserInputType == Enum.UserInputType.MouseButton2 then
			placing = false
		end
	end)

	RunService.RenderStepped:Connect(function(delta)
		camera = Workspace.CurrentCamera
		updateTarget()
		updateBreaking(delta)

		if placing then
			tryPlace()
		end
	end)
end

return BlockTool
