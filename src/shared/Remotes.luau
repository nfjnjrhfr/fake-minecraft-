--!strict
--[[
	Creates (server) or waits for (client) the remotes the block tools use.
]]

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")

local FOLDER_NAME = "FakeMinecraftRemotes"
local REMOTE_NAMES = { "PlaceBlock", "BreakBlock", "WorldReady" }

local Remotes = {}

local function serverFolder(): Folder
	local folder = ReplicatedStorage:FindFirstChild(FOLDER_NAME)
	if not folder then
		local created = Instance.new("Folder")
		created.Name = FOLDER_NAME
		created.Parent = ReplicatedStorage
		folder = created
	end

	for _, name in REMOTE_NAMES do
		if not folder:FindFirstChild(name) then
			local remote = Instance.new("RemoteEvent")
			remote.Name = name
			remote.Parent = folder
		end
	end

	return folder :: Folder
end

function Remotes.get(name: string): RemoteEvent
	if RunService:IsServer() then
		return serverFolder():WaitForChild(name) :: RemoteEvent
	end

	local folder = ReplicatedStorage:WaitForChild(FOLDER_NAME, 30)
	assert(folder, "The server never created " .. FOLDER_NAME)
	return folder:WaitForChild(name, 30) :: RemoteEvent
end

return Remotes
