--!strict
--[[
	Client entry point.

	The chunks the server sends are meshed and drawn here, and because Roblox
	simulates a character on its own player's machine, those local parts are
	what the player actually walks on.
]]

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local StarterGui = game:GetService("StarterGui")
local UserInputService = game:GetService("UserInputService")

local Shared = ReplicatedStorage:WaitForChild("FakeMinecraft")
local Coordinates = require(Shared:WaitForChild("Coordinates"))
local Remotes = require(Shared:WaitForChild("Remotes"))

local BlockTool = require(script.BlockTool)
local ChunkRenderer = require(script.ChunkRenderer)
local Hud = require(script.Hud)
local InventoryClient = require(script.InventoryClient)
local InventoryUI = require(script.InventoryUI)
local WorldMirror = require(script.WorldMirror)

local READY_TIMEOUT = 15

local player = Players.LocalPlayer
local clientReady = Remotes.get("ClientReady")

local function hideCoreGui()
	local function trySet(coreGuiType: Enum.CoreGuiType, enabled: boolean)
		pcall(function()
			StarterGui:SetCoreGuiEnabled(coreGuiType, enabled)
		end)
	end

	trySet(Enum.CoreGuiType.Backpack, false)
	trySet(Enum.CoreGuiType.Health, false)
	trySet(Enum.CoreGuiType.PlayerList, false)
end

--[[ Tell the server we have ground to stand on: it is holding the character
     still until then. ]]
local function reportReadyWhenDrawn()
	local deadline = os.clock() + READY_TIMEOUT

	while os.clock() < deadline do
		local character = player.Character
		local root = character and character:FindFirstChild("HumanoidRootPart")

		if root then
			local cx, cz = Coordinates.worldToChunk((root :: BasePart).Position)
			if ChunkRenderer.hasRendered(cx, cz) then
				break
			end
		end

		task.wait(0.15)
	end

	clientReady:FireServer()
end

local function bindInventoryFocus()
	InventoryUI.opened:connect(function()
		BlockTool.setEnabled(false)
		UserInputService.MouseBehavior = Enum.MouseBehavior.Default
		UserInputService.MouseIconEnabled = true
	end)

	InventoryUI.closed:connect(function()
		BlockTool.setEnabled(true)
	end)
end

local function start()
	hideCoreGui()

	WorldMirror.start()
	ChunkRenderer.start()
	InventoryClient.start()
	BlockTool.start()
	Hud.start()
	InventoryUI.start()
	bindInventoryFocus()

	Remotes.get("WorldReady").OnClientEvent:Connect(function()
		task.spawn(reportReadyWhenDrawn)
	end)

	-- A respawn re-anchors the character server-side, so report again.
	player.CharacterAdded:Connect(function()
		task.spawn(reportReadyWhenDrawn)
	end)

	if RunService:IsStudio() then
		print("[FakeMinecraft] client started")
	end
end

start()
