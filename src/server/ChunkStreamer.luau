--!strict
--[[
	Decides which chunks each player has, and keeps them up to date.

	Chunks are generated and sent nearest-first, a couple per tick, so a joining
	player gets the ground under their feet before the horizon.
]]

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")

local Shared = ReplicatedStorage:WaitForChild("FakeMinecraft")
local ChunkCodec = require(Shared:WaitForChild("ChunkCodec"))
local Coordinates = require(Shared:WaitForChild("Coordinates"))
local Remotes = require(Shared:WaitForChild("Remotes"))
local WorldConfig = require(Shared:WaitForChild("WorldConfig"))

local WorldService = require(script.Parent.WorldService)

local ChunkStreamer = {}

type Tracker = {
	sent: { [string]: boolean },
	centre: Vector3,
	streaming: boolean,
}

local trackers: { [Player]: Tracker } = {}
local chunkData = Remotes.get("ChunkData")
local chunkUnload = Remotes.get("ChunkUnload")
local blockUpdate = Remotes.get("BlockUpdate")

--[[ Chunk offsets within the render distance, nearest first. Computed once. ]]
local RING: { { number } } = {}
do
	local radius = WorldConfig.RenderDistance
	for dx = -radius, radius do
		for dz = -radius, radius do
			local distance = math.sqrt(dx * dx + dz * dz)
			if distance <= radius + 0.5 then
				table.insert(RING, { dx, dz, distance })
			end
		end
	end
	table.sort(RING, function(a, b)
		return a[3] < b[3]
	end)
end

local function playerPosition(player: Player): Vector3?
	local character = player.Character
	local root = character and character:FindFirstChild("HumanoidRootPart")
	return if root then (root :: BasePart).Position else nil
end

function ChunkStreamer.track(player: Player)
	trackers[player] = { sent = {}, centre = Vector3.zero, streaming = false }
end

function ChunkStreamer.forget(player: Player)
	trackers[player] = nil
end

--[[ Sends every chunk within the render distance of `position`, and waits for
     it. Used to hold a spawning player until there is ground under them. ]]
function ChunkStreamer.preload(player: Player, position: Vector3): number
	local tracker = trackers[player]
	if not tracker then
		return 0
	end

	local cx, cz = Coordinates.worldToChunk(position)
	local sent = 0

	for _, offset in RING do
		if not player.Parent then
			break
		end
		if offset[3] <= 2.5 then
			local key = Coordinates.chunkKey(cx + offset[1], cz + offset[2])
			if not tracker.sent[key] then
				local chunk = WorldService.ensureChunk(cx + offset[1], cz + offset[2])
				chunkData:FireClient(player, chunk.cx, chunk.cz, ChunkCodec.encode(chunk))
				tracker.sent[key] = true
				sent += 1
			end
		end
	end

	return sent
end

local function streamPlayer(player: Player, tracker: Tracker)
	local position = playerPosition(player)
	if not position then
		return
	end

	tracker.centre = position
	local cx, cz = Coordinates.worldToChunk(position)
	local budget = WorldConfig.ChunksPerTick

	for _, offset in RING do
		if budget <= 0 then
			break
		end

		local targetX, targetZ = cx + offset[1], cz + offset[2]
		local key = Coordinates.chunkKey(targetX, targetZ)

		if not tracker.sent[key] then
			local chunk = WorldService.ensureChunk(targetX, targetZ)
			if not player.Parent then
				return
			end

			chunkData:FireClient(player, chunk.cx, chunk.cz, ChunkCodec.encode(chunk))
			tracker.sent[key] = true
			budget -= 1
		end
	end

	-- Drop what the player has walked away from.
	local unloadDistance = WorldConfig.UnloadDistance
	for key in tracker.sent do
		local keyX, keyZ = Coordinates.parseChunkKey(key)
		local dx, dz = keyX - cx, keyZ - cz
		if math.sqrt(dx * dx + dz * dz) > unloadDistance then
			tracker.sent[key] = nil
			chunkUnload:FireClient(player, keyX, keyZ)
		end
	end
end

--[[ Chunks nobody can see are saved and dropped from memory. ]]
local function collectChunks()
	local needed: { [string]: boolean } = {}

	for _, tracker in trackers do
		for key in tracker.sent do
			needed[key] = true
		end
	end

	local stale: { { number } } = {}
	WorldService.eachChunk(function(chunk)
		if not needed[chunk:key()] then
			table.insert(stale, { chunk.cx, chunk.cz })
		end
	end)

	for _, coordinate in stale do
		WorldService.unloadChunk(coordinate[1], coordinate[2])
	end
end

function ChunkStreamer.start()
	WorldService.blockChanged:connect(function(x: number, y: number, z: number, blockId: number)
		local cx, cz = Coordinates.chunkOf(x, z)
		local key = Coordinates.chunkKey(cx, cz)

		for player, tracker in trackers do
			if tracker.sent[key] then
				blockUpdate:FireClient(player, x, y, z, blockId)
			end
		end
	end)

	Players.PlayerRemoving:Connect(function(player)
		ChunkStreamer.forget(player)
	end)

	task.spawn(function()
		local sinceCollect = 0

		while true do
			local elapsed = task.wait(WorldConfig.StreamInterval)
			sinceCollect += elapsed

			for player, tracker in trackers do
				if not tracker.streaming then
					tracker.streaming = true
					task.spawn(function()
						local ok, err = pcall(streamPlayer, player, tracker)
						if not ok then
							warn("[ChunkStreamer] " .. tostring(err))
						end
						tracker.streaming = false
					end)
				end
			end

			if sinceCollect >= 10 then
				sinceCollect = 0
				collectChunks()
			end
		end
	end)

	if RunService:IsStudio() then
		print("[ChunkStreamer] started, render distance " .. WorldConfig.RenderDistance .. " chunks")
	end
end

return ChunkStreamer
