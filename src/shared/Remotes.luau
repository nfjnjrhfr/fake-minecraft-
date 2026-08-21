--!strict
--[[ The whole client/server protocol, in one list. ]]

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")

local FOLDER_NAME = "FakeMinecraftRemotes"

local EVENTS = {
	-- Server -> client
	"ChunkData", -- (cx, cz, encodedBlocks)
	"ChunkUnload", -- (cx, cz)
	"BlockUpdate", -- (x, y, z, blockId)
	"InventorySync", -- (slots, cursor, craftGrid, craftResult)
	"WorldReady", -- ()
	"Notice", -- (message)

	-- Client -> server
	"BreakStart", -- (x, y, z)
	"BreakBlock", -- (x, y, z)
	"PlaceBlock", -- (x, y, z) - the block placed is whatever the hotbar has selected
	"SelectSlot", -- (slot)
	"InventoryClick", -- (container, slot, button)
	"QuickMove", -- (container, slot)
	"CraftResult", -- (takeAll: boolean)
	"DropStack", -- (container, slot)
	"ClientReady", -- () the client has meshed the chunks around its spawn
}

local Remotes = {}

Remotes.Names = EVENTS

local function ensureFolder(): Instance
	local existing = ReplicatedStorage:FindFirstChild(FOLDER_NAME)
	if existing then
		return existing
	end

	local folder = Instance.new("Folder")
	folder.Name = FOLDER_NAME

	for _, name in EVENTS do
		local remote = Instance.new("RemoteEvent")
		remote.Name = name
		remote.Parent = folder
	end

	folder.Parent = ReplicatedStorage
	return folder
end

--[[ On the server this creates the remotes; on the client it waits for them. ]]
function Remotes.get(name: string): RemoteEvent
	assert(table.find(EVENTS, name), "unknown remote " .. name)

	if RunService:IsServer() then
		local folder = ensureFolder()
		local remote = folder:FindFirstChild(name)
		if not remote then
			local created = Instance.new("RemoteEvent")
			created.Name = name
			created.Parent = folder
			remote = created
		end
		return remote :: RemoteEvent
	end

	local folder = ReplicatedStorage:WaitForChild(FOLDER_NAME, 60)
	assert(folder, "the server never created " .. FOLDER_NAME)
	local remote = folder:WaitForChild(name, 30)
	assert(remote, "the server never created the remote " .. name)
	return remote :: RemoteEvent
end

return Remotes
