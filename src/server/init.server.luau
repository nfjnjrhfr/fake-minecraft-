--!strict
--[[
	Server entry point: starts the services and owns the player lifecycle.

	The terrain only exists as parts on each client, but a player's character is
	simulated by that same client, so the blocks they see are the blocks they
	stand on. The server keeps the block data and decides every change.
]]

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Workspace = game:GetService("Workspace")

local Shared = ReplicatedStorage:WaitForChild("FakeMinecraft")
local Coordinates = require(Shared:WaitForChild("Coordinates"))
local ItemRegistry = require(Shared:WaitForChild("ItemRegistry"))
local Remotes = require(Shared:WaitForChild("Remotes"))
local TerrainGenerator = require(Shared:WaitForChild("TerrainGenerator"))
local WorldConfig = require(Shared:WaitForChild("WorldConfig"))

local BlockService = require(script.BlockService)
local ChunkStreamer = require(script.ChunkStreamer)
local DayNightService = require(script.DayNightService)
local DropService = require(script.DropService)
local InventoryService = require(script.InventoryService)
local PersistenceService = require(script.PersistenceService)
local WorldService = require(script.WorldService)

local SPAWN_RADIUS = 24 -- studs of jitter, so players do not stack up
local READY_TIMEOUT = 12

local worldReady = Remotes.get("WorldReady")
local clientReady = Remotes.get("ClientReady")
local readyPlayers: { [Player]: boolean } = {}

local STARTER_KIT = {
	{ "WoodenPickaxe", 1 },
	{ "WoodenAxe", 1 },
	{ "WoodenShovel", 1 },
	{ "Planks", 16 },
	{ "CraftingTable", 1 },
}

--[[ The template baseplate would sit in the middle of the world. ]]
local function clearTemplateGeometry()
	for _, child in Workspace:GetChildren() do
		if child:IsA("BasePart") and (child.Name == "Baseplate" or child.Name == "SpawnLocation") then
			child:Destroy()
			print("[FakeMinecraft] removed the template " .. child.Name)
		end
		if child:IsA("SpawnLocation") then
			child:Destroy()
		end
	end
end

local function spawnPointFor(player: Player): Vector3
	local angle = (player.UserId % 360) * math.pi / 180
	local offsetX = math.floor(math.cos(angle) * SPAWN_RADIUS / WorldConfig.BlockSize)
	local offsetZ = math.floor(math.sin(angle) * SPAWN_RADIUS / WorldConfig.BlockSize)
	local height = TerrainGenerator.spawnHeight(offsetX, offsetZ)
	return Coordinates.voxelToWorld(offsetX, height, offsetZ)
end

--[[
	Hold the character still until its client has the chunks under it, otherwise
	the player falls through a world that has not been meshed yet.
]]
local function placeCharacter(player: Player, character: Model)
	local root = character:WaitForChild("HumanoidRootPart", 10) :: BasePart?
	if not root then
		return
	end

	local humanoid = character:FindFirstChildOfClass("Humanoid")
	local position = spawnPointFor(player)

	root.Anchored = true
	root.CFrame = CFrame.new(position)

	ChunkStreamer.preload(player, position)
	worldReady:FireClient(player)

	local deadline = os.clock() + READY_TIMEOUT
	while not readyPlayers[player] and os.clock() < deadline and player.Parent do
		task.wait(0.2)
	end

	if root.Parent then
		root.Anchored = false
		root.CFrame = CFrame.new(position)
		if humanoid then
			humanoid:ChangeState(Enum.HumanoidStateType.Freefall)
		end
	end
end

local function onPlayerAdded(player: Player)
	ChunkStreamer.track(player)

	local saved = PersistenceService.loadPlayer(player.UserId)
	InventoryService.track(player, saved)

	if saved == nil then
		for _, entry in STARTER_KIT do
			InventoryService.addItem(player, ItemRegistry.id(entry[1] :: string), entry[2] :: number)
		end
	end

	player.CharacterAdded:Connect(function(character)
		task.spawn(placeCharacter, player, character)
	end)

	if player.Character then
		task.spawn(placeCharacter, player, player.Character)
	end
end

local function savePlayer(player: Player)
	local data = InventoryService.serialize(player)
	if data then
		PersistenceService.savePlayer(player.UserId, data)
	end
end

local function onPlayerRemoving(player: Player)
	InventoryService.returnLooseItems(player)
	savePlayer(player)
	InventoryService.forget(player)
	ChunkStreamer.forget(player)
	readyPlayers[player] = nil
end

local function start()
	clearTemplateGeometry()
	Workspace.FallenPartsDestroyHeight = -120

	DropService.start()
	InventoryService.start()
	BlockService.start()
	ChunkStreamer.start()
	DayNightService.start()

	clientReady.OnServerEvent:Connect(function(player)
		readyPlayers[player] = true
	end)

	Players.PlayerAdded:Connect(onPlayerAdded)
	Players.PlayerRemoving:Connect(onPlayerRemoving)

	for _, player in Players:GetPlayers() do
		task.spawn(onPlayerAdded, player)
	end

	-- Autosave: player inventories, then any chunk a player has changed.
	task.spawn(function()
		while true do
			task.wait(WorldConfig.AutosaveInterval)

			for _, player in Players:GetPlayers() do
				savePlayer(player)
			end
			WorldService.saveDirtyChunks()
		end
	end)

	game:BindToClose(function()
		for _, player in Players:GetPlayers() do
			savePlayer(player)
		end
		WorldService.saveDirtyChunks()
	end)

	print(string.format(
		"[FakeMinecraft] world ready - seed %d, %s",
		WorldConfig.Seed,
		PersistenceService.describe()
	))
end

start()
