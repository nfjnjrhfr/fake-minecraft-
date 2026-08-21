--!strict
--[[
	Datastore access, with retries and an in-memory fallback.

	Studio without API access, and any run where the datastore is down, must
	still be playable - so every failure degrades to memory rather than
	throwing. `available` reports which mode we ended up in.
]]

local DataStoreService = game:GetService("DataStoreService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")

local Shared = ReplicatedStorage:WaitForChild("FakeMinecraft")
local Chunk = require(Shared:WaitForChild("Chunk"))
local ChunkCodec = require(Shared:WaitForChild("ChunkCodec"))
local Coordinates = require(Shared:WaitForChild("Coordinates"))
local WorldConfig = require(Shared:WaitForChild("WorldConfig"))

local WORLD_STORE = "FakeMinecraftWorld_v1"
local PLAYER_STORE = "FakeMinecraftPlayers_v1"

local PersistenceService = {}

local worldStore: DataStore? = nil
local playerStore: DataStore? = nil
local available = false

local memoryWorld: { [string]: string } = {}
local memoryPlayers: { [number]: any } = {}

do
	local ok, err = pcall(function()
		worldStore = DataStoreService:GetDataStore(WORLD_STORE)
		playerStore = DataStoreService:GetDataStore(PLAYER_STORE)
	end)

	if ok and worldStore and playerStore then
		available = true
	else
		warn("[Persistence] datastores unavailable, saving to memory only: " .. tostring(err))
	end
end

PersistenceService.available = available

--[[ Retries with a widening delay: datastore errors are usually throttling. ]]
local function retry<T>(label: string, action: () -> T): (boolean, T?)
	local delay = 0.5

	for attempt = 1, WorldConfig.DataStoreRetries do
		local ok, result = pcall(action)
		if ok then
			return true, result
		end

		if attempt == WorldConfig.DataStoreRetries then
			warn(string.format("[Persistence] %s failed after %d attempts: %s", label, attempt, tostring(result)))
		else
			task.wait(delay)
			delay *= 2
		end
	end

	return false, nil
end

local function chunkKeyFor(cx: number, cz: number): string
	return "chunk_" .. Coordinates.chunkKey(cx, cz)
end

function PersistenceService.loadChunkEdits(cx: number, cz: number): { [number]: number }?
	local key = chunkKeyFor(cx, cz)

	if not available then
		local payload = memoryWorld[key]
		return if payload then ChunkCodec.decodeEdits(payload) else nil
	end

	local store = worldStore :: DataStore
	local ok, payload = retry("load " .. key, function()
		return store:GetAsync(key)
	end)

	if not ok or type(payload) ~= "string" then
		return nil
	end
	return ChunkCodec.decodeEdits(payload)
end

function PersistenceService.saveChunkEdits(chunk: Chunk.Chunk)
	local key = chunkKeyFor(chunk.cx, chunk.cz)
	local payload = ChunkCodec.encodeEdits(chunk.edits)

	-- Clear the flag first: an edit landing during the save marks it again,
	-- so the next pass picks it up instead of the write silently winning.
	chunk.dirty = false

	if not available then
		memoryWorld[key] = payload
		return
	end

	local store = worldStore :: DataStore
	local ok = retry("save " .. key, function()
		store:SetAsync(key, payload)
		return true
	end)

	if not ok then
		chunk.dirty = true
	end
end

function PersistenceService.loadPlayer(userId: number): any
	if not available then
		return memoryPlayers[userId]
	end

	local store = playerStore :: DataStore
	local ok, data = retry("load player " .. userId, function()
		return store:GetAsync("player_" .. userId)
	end)

	return if ok then data else nil
end

function PersistenceService.savePlayer(userId: number, data: any)
	if not available then
		memoryPlayers[userId] = data
		return
	end

	local store = playerStore :: DataStore
	retry("save player " .. userId, function()
		store:SetAsync("player_" .. userId, data)
		return true
	end)
end

--[[ Studio runs get a private world so testing never touches live data. ]]
function PersistenceService.describe(): string
	if not available then
		return "memory only (no datastore access)"
	end
	return if RunService:IsStudio() then "datastore (Studio)" else "datastore"
end

return PersistenceService
