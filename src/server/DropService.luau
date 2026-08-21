--!strict
--[[
	Dropped items: small spinning blocks that a player walks into to collect.
	They are anchored server parts, so pickup is decided here, not on a client.
]]

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local Workspace = game:GetService("Workspace")

local Shared = ReplicatedStorage:WaitForChild("FakeMinecraft")
local BlockRegistry = require(Shared:WaitForChild("BlockRegistry"))
local Coordinates = require(Shared:WaitForChild("Coordinates"))
local ItemRegistry = require(Shared:WaitForChild("ItemRegistry"))
local Signal = require(Shared:WaitForChild("Signal"))
local WorldConfig = require(Shared:WaitForChild("WorldConfig"))

local WorldService = require(script.Parent.WorldService)

local DROP_SIZE = WorldConfig.BlockSize * 0.28
local MERGE_RADIUS = 4
local PICKUP_DELAY = 0.6

local DropService = {}

type Drop = {
	part: BasePart,
	itemId: number,
	count: number,
	spawnedAt: number,
	restingY: number,
}

local drops: { Drop } = {}
local container: Folder

DropService.pickedUp = Signal.new()

--[[ Replaced by InventoryService: drops are not collected by a full inventory. ]]
DropService.canAccept = function(_player: Player, _itemId: number, _count: number): boolean
	return true
end

local function makePart(itemId: number, position: Vector3): BasePart
	local item = ItemRegistry.get(itemId)

	local part = Instance.new("Part")
	part.Name = if item then item.name else "Item"
	part.Size = Vector3.one * DROP_SIZE
	part.Anchored = true
	part.CanCollide = false
	part.CanQuery = false
	part.CastShadow = false
	part.Position = position
	part.Color = if item then item.color else Color3.fromRGB(200, 200, 200)

	local block = if item and item.blockId then BlockRegistry.get(item.blockId) else nil
	part.Material = if block then block.material else Enum.Material.SmoothPlastic
	if block then
		part.Transparency = block.transparency
	end

	part:SetAttribute("ItemId", itemId)
	part.Parent = container
	return part
end

--[[ The first free cell above `y`, so drops do not sink into the terrain. ]]
local function restingHeight(x: number, y: number, z: number): number
	for offset = 0, 4 do
		if not WorldService.isSolid(x, y + offset, z) then
			return y + offset
		end
	end
	return y + 4
end

function DropService.spawn(x: number, y: number, z: number, itemId: number, count: number)
	if count <= 0 or not ItemRegistry.exists(itemId) then
		return
	end

	-- Fold into a nearby drop of the same item rather than littering.
	local centre = Coordinates.voxelToWorld(x, y, z)
	for _, drop in drops do
		if drop.itemId == itemId and (drop.part.Position - centre).Magnitude <= MERGE_RADIUS then
			local maxStack = ItemRegistry.maxStack(itemId)
			if drop.count + count <= maxStack then
				drop.count += count
				drop.part:SetAttribute("Count", drop.count)
				return
			end
		end
	end

	local restingVoxelY = restingHeight(x, y, z)
	local position = Coordinates.voxelToWorld(x, restingVoxelY, z)
	local part = makePart(itemId, position)
	part:SetAttribute("Count", count)

	table.insert(drops, {
		part = part,
		itemId = itemId,
		count = count,
		spawnedAt = os.clock(),
		restingY = position.Y,
	})
end

function DropService.dropFromPlayer(player: Player, itemId: number, count: number)
	local character = player.Character
	local root = character and character:FindFirstChild("HumanoidRootPart")
	if not root then
		return
	end

	local origin = (root :: BasePart).Position + (root :: BasePart).CFrame.LookVector * WorldConfig.BlockSize
	local x, y, z = Coordinates.worldToVoxel(origin)
	DropService.spawn(x, y, z, itemId, count)
end

local function collect(drop: Drop, player: Player): boolean
	if not DropService.canAccept(player, drop.itemId, drop.count) then
		return false
	end

	DropService.pickedUp:fire(player, drop.itemId, drop.count)
	drop.part:Destroy()
	return true
end

local function update(elapsed: number)
	local now = os.clock()
	local spin = CFrame.Angles(0, now * 1.6, 0) * CFrame.Angles(math.rad(20), 0, 0)

	for index = #drops, 1, -1 do
		local drop = drops[index]

		if not drop.part.Parent then
			table.remove(drops, index)
			continue
		end

		if now - drop.spawnedAt > WorldConfig.DropLifetime then
			drop.part:Destroy()
			table.remove(drops, index)
			continue
		end

		local bob = math.sin(now * 2.5 + index) * 0.15
		drop.part.CFrame = CFrame.new(drop.part.Position.X, drop.restingY + bob, drop.part.Position.Z) * spin

		if now - drop.spawnedAt >= PICKUP_DELAY then
			for _, player in Players:GetPlayers() do
				local character = player.Character
				local root = character and character:FindFirstChild("HumanoidRootPart")
				local near = root
					and ((root :: BasePart).Position - drop.part.Position).Magnitude <= WorldConfig.DropPickupRadius
				if near then
					if collect(drop, player) then
						table.remove(drops, index)
						break
					end
				end
			end
		end
	end

	local _ = elapsed
end

function DropService.start()
	container = Instance.new("Folder")
	container.Name = "Drops"
	container.Parent = Workspace

	local accumulated = 0
	RunService.Heartbeat:Connect(function(delta)
		accumulated += delta
		-- Pickup checks do not need to run at frame rate.
		if accumulated < 0.1 then
			return
		end
		accumulated = 0
		update(delta)
	end)
end

return DropService
