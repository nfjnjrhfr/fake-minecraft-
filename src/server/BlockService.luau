--!strict
--[[
	Breaking and placing, validated. The client asks; nothing here trusts it.

	Breaking is two steps - BreakStart then BreakBlock - so the server can time
	the swing and reject a client that claims to have mined stone instantly.
]]

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Shared = ReplicatedStorage:WaitForChild("FakeMinecraft")
local BlockRegistry = require(Shared:WaitForChild("BlockRegistry"))
local Coordinates = require(Shared:WaitForChild("Coordinates"))
local ItemRegistry = require(Shared:WaitForChild("ItemRegistry"))
local Remotes = require(Shared:WaitForChild("Remotes"))
local WorldConfig = require(Shared:WaitForChild("WorldConfig"))

local DropService = require(script.Parent.DropService)
local InventoryService = require(script.Parent.InventoryService)
local WorldService = require(script.Parent.WorldService)

local BlockService = {}

type Swing = {
	x: number,
	y: number,
	z: number,
	startedAt: number,
	itemId: number?,
}

local swings: { [Player]: Swing } = {}
local lastPlace: { [Player]: number } = {}
local notice = Remotes.get("Notice")

local function isInteger(value: any): boolean
	return type(value) == "number" and value == math.floor(value) and math.abs(value) < 1e6
end

local function rootOf(player: Player): BasePart?
	local character = player.Character
	local root = character and character:FindFirstChild("HumanoidRootPart")
	return root :: BasePart?
end

local function withinReach(player: Player, x: number, y: number, z: number): boolean
	local root = rootOf(player)
	if not root then
		return false
	end

	local centre = Coordinates.voxelToWorld(x, y, z)
	return (centre - root.Position).Magnitude <= WorldConfig.MaxReach
end

local function chunkIsLoaded(x: number, z: number): boolean
	local cx, cz = Coordinates.chunkOf(x, z)
	return WorldService.isChunkLoaded(cx, cz)
end

--[[ A block may not appear inside a player: their own body, or anyone else's. ]]
local function blockedByCharacter(x: number, y: number, z: number): boolean
	local centre = Coordinates.voxelToWorld(x, y, z)
	local half = WorldConfig.BlockSize * 0.5

	for _, player in Players:GetPlayers() do
		local character = player.Character
		if character then
			for _, part in character:GetChildren() do
				if part:IsA("BasePart") then
					local offset = part.Position - centre
					local reach = half + math.max(part.Size.X, part.Size.Y, part.Size.Z) * 0.5
					if math.abs(offset.X) < reach and math.abs(offset.Y) < reach and math.abs(offset.Z) < reach then
						return true
					end
				end
			end
		end
	end

	return false
end

local function onBreakStart(player: Player, x: any, y: any, z: any)
	if not (isInteger(x) and isInteger(y) and isInteger(z)) then
		return
	end
	if not withinReach(player, x, y, z) or not chunkIsLoaded(x, z) then
		return
	end

	local selected = InventoryService.selectedStack(player)
	swings[player] = {
		x = x,
		y = y,
		z = z,
		startedAt = os.clock(),
		itemId = if selected then selected.id else nil,
	}
end

local function onBreakBlock(player: Player, x: any, y: any, z: any)
	if not (isInteger(x) and isInteger(y) and isInteger(z)) then
		return
	end

	local swing = swings[player]
	if not swing or swing.x ~= x or swing.y ~= y or swing.z ~= z then
		return
	end
	if not withinReach(player, x, y, z) or not chunkIsLoaded(x, z) then
		return
	end

	local blockId = WorldService.getBlock(x, y, z)
	if not BlockRegistry.isBreakable(blockId) then
		return
	end

	local expected = ItemRegistry.breakTime(blockId, swing.itemId)
	local elapsed = os.clock() - swing.startedAt
	if elapsed < expected * WorldConfig.BreakLeniency then
		-- Too fast to be real: make the client re-sync and try again.
		Remotes.get("BlockUpdate"):FireClient(player, x, y, z, blockId)
		return
	end

	if not WorldService.setBlock(x, y, z, BlockRegistry.Air) then
		return
	end

	swings[player] = nil

	local block = BlockRegistry.get(blockId)
	if block and ItemRegistry.canHarvest(blockId, swing.itemId) then
		local dropId = if block.drop ~= nil then block.drop else blockId
		if dropId ~= BlockRegistry.Air and ItemRegistry.exists(dropId) then
			DropService.spawn(x, y, z, dropId, block.dropCount)
		end
	end
end

local function onPlaceBlock(player: Player, x: any, y: any, z: any)
	if not (isInteger(x) and isInteger(y) and isInteger(z)) then
		return
	end
	if y < 0 or y >= WorldConfig.WorldHeight then
		return
	end

	local now = os.clock()
	if now - (lastPlace[player] or 0) < WorldConfig.PlaceCooldown then
		return
	end
	if not withinReach(player, x, y, z) or not chunkIsLoaded(x, z) then
		return
	end

	local stack = InventoryService.selectedStack(player)
	if not stack then
		return
	end

	local item = ItemRegistry.get(stack.id)
	local blockId = item and item.blockId
	if not blockId then
		return
	end

	local existing = WorldService.getBlock(x, y, z)
	if BlockRegistry.isSolid(existing) then
		return
	end

	if blockedByCharacter(x, y, z) then
		notice:FireClient(player, "There is not enough room there")
		return
	end

	if not WorldService.setBlock(x, y, z, blockId) then
		return
	end

	lastPlace[player] = now
	InventoryService.consumeSelected(player, 1)
end

function BlockService.start()
	Remotes.get("BreakStart").OnServerEvent:Connect(onBreakStart)
	Remotes.get("BreakBlock").OnServerEvent:Connect(onBreakBlock)
	Remotes.get("PlaceBlock").OnServerEvent:Connect(onPlaceBlock)

	Players.PlayerRemoving:Connect(function(player)
		swings[player] = nil
		lastPlace[player] = nil
	end)
end

return BlockService
