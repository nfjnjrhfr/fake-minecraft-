--!strict
--[[
	Generates the voxel world and applies the block edits players request.
	Every change a player makes is validated here; the client is never trusted.
]]

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Workspace = game:GetService("Workspace")

local Shared = ReplicatedStorage:WaitForChild("FakeMinecraft")
local BlockRegistry = require(Shared:WaitForChild("BlockRegistry"))
local Remotes = require(Shared:WaitForChild("Remotes"))
local VoxelWorld = require(Shared:WaitForChild("VoxelWorld"))
local WorldConfig = require(Shared:WaitForChild("WorldConfig"))

local world = VoxelWorld.new()
local parts: { [string]: BasePart } = {}

local container = Instance.new("Folder")
container.Name = "VoxelWorld"
container.Parent = Workspace

local function partKey(x: number, y: number, z: number): string
	return string.format("%d,%d,%d", x, y, z)
end

local function renderBlock(x: number, y: number, z: number, blockId: number)
	local block = BlockRegistry.get(blockId)
	if not block then
		return
	end

	local index = partKey(x, y, z)
	local part = parts[index]

	if not part then
		local created = Instance.new("Part")
		created.Name = block.name
		created.Anchored = true
		created.Size = Vector3.one * WorldConfig.BlockSize
		created.Position = VoxelWorld.toWorld(x, y, z)
		created.TopSurface = Enum.SurfaceType.Smooth
		created.BottomSurface = Enum.SurfaceType.Smooth
		created:SetAttribute("Voxel", index)
		created.Parent = container
		parts[index] = created
		part = created
	end

	part.Name = block.name
	part.Color = block.color
	part.Material = block.material
	part.Transparency = block.transparency
end

local function unrenderBlock(x: number, y: number, z: number)
	local index = partKey(x, y, z)
	local part = parts[index]
	if part then
		part:Destroy()
		parts[index] = nil
	end
end

local function heightAt(x: number, z: number): number
	local scale = 0.08
	local noise = math.noise(x * scale, z * scale, WorldConfig.Seed)
	local normalised = math.clamp((noise + 1) / 2, 0, 1)
	local span = WorldConfig.MaxHeight - WorldConfig.MinHeight
	return WorldConfig.MinHeight + math.floor(normalised * span + 0.5)
end

local function surfaceBlock(height: number): number
	if height <= WorldConfig.MinHeight + 1 then
		return assert(BlockRegistry.fromName("Sand")).id
	end
	return assert(BlockRegistry.fromName("Grass")).id
end

local function generateWorld()
	local radius = WorldConfig.WorldRadius
	local dirt = assert(BlockRegistry.fromName("Dirt")).id
	local stone = assert(BlockRegistry.fromName("Stone")).id

	for x = -radius, radius do
		for z = -radius, radius do
			local height = heightAt(x, z)
			local lowest = math.max(height - WorldConfig.RenderDepth + 1, 0)

			for y = lowest, height do
				local blockId = if y == height
					then surfaceBlock(height)
					elseif y >= height - 1 then dirt
					else stone

				world:set(x, y, z, blockId)
				renderBlock(x, y, z, blockId)
			end
		end

		-- Yield now and then so world generation does not stall the heartbeat.
		if x % 8 == 0 then
			task.wait()
		end
	end

	print(string.format("[FakeMinecraft] Generated %d blocks", world.count))
end

local function characterPosition(player: Player): Vector3?
	local character = player.Character
	local root = character and character:FindFirstChild("HumanoidRootPart")
	return if root then (root :: BasePart).Position else nil
end

local function withinReach(player: Player, x: number, y: number, z: number): boolean
	local origin = characterPosition(player)
	if not origin then
		return false
	end
	return (VoxelWorld.toWorld(x, y, z) - origin).Magnitude <= WorldConfig.MaxReach
end

local function isCoordinate(value: any): boolean
	return typeof(value) == "number" and value == math.floor(value) and math.abs(value) <= 512
end

local placeBlock = Remotes.get("PlaceBlock")
local breakBlock = Remotes.get("BreakBlock")
local worldReady = Remotes.get("WorldReady")

placeBlock.OnServerEvent:Connect(function(player, x, y, z, blockId)
	if not (isCoordinate(x) and isCoordinate(y) and isCoordinate(z)) then
		return
	end
	if typeof(blockId) ~= "number" or not BlockRegistry.isPlaceable(blockId) then
		return
	end
	if y < 0 or world:isOccupied(x, y, z) or not withinReach(player, x, y, z) then
		return
	end

	world:set(x, y, z, blockId)
	renderBlock(x, y, z, blockId)
end)

breakBlock.OnServerEvent:Connect(function(player, x, y, z)
	if not (isCoordinate(x) and isCoordinate(y) and isCoordinate(z)) then
		return
	end
	if not world:isOccupied(x, y, z) or not withinReach(player, x, y, z) then
		return
	end

	world:set(x, y, z, 0)
	unrenderBlock(x, y, z)
end)

local function spawnAboveTerrain(player: Player)
	local character = player.Character or player.CharacterAdded:Wait()
	local root = character:WaitForChild("HumanoidRootPart", 10) :: BasePart?
	if not root then
		return
	end

	local height = heightAt(0, 0)
	root.CFrame = CFrame.new(VoxelWorld.toWorld(0, height + 3, 0))
end

Players.PlayerAdded:Connect(function(player)
	player.CharacterAdded:Connect(function()
		spawnAboveTerrain(player)
	end)
	if player.Character then
		spawnAboveTerrain(player)
	end
	worldReady:FireClient(player)
end)

generateWorld()

for _, player in Players:GetPlayers() do
	worldReady:FireClient(player)
end
