--[[
	BattleClient — the HUD plus the on-screen action buttons.

	Movement and jumping already have a virtual thumbstick on touch devices:
	that is Roblox's built-in mobile control, so this script only has to add
	the three game actions (sword / snowball / block). ContextActionService
	gives us a real touch button and a keyboard key from the same binding.
]]

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local ContextActionService = game:GetService("ContextActionService")
local UserInputService = game:GetService("UserInputService")

local player = Players.LocalPlayer
local playerGui = player:WaitForChild("PlayerGui")

local remotes = ReplicatedStorage:WaitForChild("BlockBrawlRemotes")
local actionEvent = remotes:WaitForChild("Action")
local stateEvent = remotes:WaitForChild("State")

local TOUCH = UserInputService.TouchEnabled

-- ---------------------------------------------------------------- helpers
local function new(className, props, parent)
	local inst = Instance.new(className)
	for key, value in props do
		inst[key] = value
	end
	inst.Parent = parent
	return inst
end

-- ---------------------------------------------------------------- hud
local gui = new("ScreenGui", {
	Name = "BlockBrawlHud",
	ResetOnSpawn = false,
	IgnoreGuiInset = true,
	ZIndexBehavior = Enum.ZIndexBehavior.Sibling,
}, playerGui)

local roster = new("Frame", {
	Name = "Roster",
	BackgroundTransparency = 1,
	Position = UDim2.new(0, 16, 0, 16),
	Size = UDim2.new(0, 300, 0, 200),
}, gui)

new("UIListLayout", {
	Padding = UDim.new(0, 8),
	SortOrder = Enum.SortOrder.LayoutOrder,
}, roster)

local timerLabel = new("TextLabel", {
	Name = "Timer",
	BackgroundColor3 = Color3.fromRGB(16, 19, 26),
	BackgroundTransparency = 0.25,
	Position = UDim2.new(0.5, -46, 0, 12),
	Size = UDim2.new(0, 92, 0, 40),
	Font = Enum.Font.Code,
	TextSize = 28,
	TextColor3 = Color3.fromRGB(255, 255, 255),
	Text = "90",
}, gui)

local announceLabel = new("TextLabel", {
	Name = "Announce",
	BackgroundTransparency = 1,
	Position = UDim2.new(0.5, -300, 0.34, 0),
	Size = UDim2.new(0, 600, 0, 60),
	Font = Enum.Font.LuckiestGuy,
	TextSize = 42,
	TextColor3 = Color3.fromRGB(255, 255, 255),
	TextStrokeTransparency = 0.4,
	Text = "",
}, gui)

local stocks = new("Frame", {
	Name = "Stocks",
	BackgroundTransparency = 1,
	AnchorPoint = Vector2.new(0.5, 1),
	Position = UDim2.new(0.5, 0, 1, -14),
	Size = UDim2.new(0, 420, 0, 46),
}, gui)

local ammoLabel = new("TextLabel", {
	BackgroundTransparency = 1,
	Size = UDim2.new(1, 0, 0, 22),
	Font = Enum.Font.Code,
	TextSize = 18,
	TextXAlignment = Enum.TextXAlignment.Center,
	TextColor3 = Color3.fromRGB(223, 243, 255),
	TextStrokeTransparency = 0.5,
	Text = "雪球 ●●●●●●●●",
}, stocks)

local blockLabel = new("TextLabel", {
	BackgroundTransparency = 1,
	Position = UDim2.new(0, 0, 0, 22),
	Size = UDim2.new(1, 0, 0, 22),
	Font = Enum.Font.Code,
	TextSize = 18,
	TextXAlignment = Enum.TextXAlignment.Center,
	TextColor3 = Color3.fromRGB(233, 196, 143),
	TextStrokeTransparency = 0.5,
	Text = "方塊 ■■■■■■■■■■",
}, stocks)

-- one row per fighter, rebuilt only when the roster actually changes
local rows = {}

local function ensureRow(index)
	if rows[index] then
		return rows[index]
	end

	local frame = new("Frame", {
		Name = "Fighter" .. index,
		BackgroundColor3 = Color3.fromRGB(16, 19, 26),
		BackgroundTransparency = 0.3,
		Size = UDim2.new(0, 300, 0, 46),
		LayoutOrder = index,
	}, roster)

	local name = new("TextLabel", {
		BackgroundTransparency = 1,
		Position = UDim2.new(0, 8, 0, 2),
		Size = UDim2.new(1, -16, 0, 18),
		Font = Enum.Font.Code,
		TextSize = 15,
		TextXAlignment = Enum.TextXAlignment.Left,
		TextColor3 = Color3.fromRGB(255, 255, 255),
		Text = "",
	}, frame)

	local barBg = new("Frame", {
		BackgroundColor3 = Color3.fromRGB(42, 47, 58),
		Position = UDim2.new(0, 8, 0, 22),
		Size = UDim2.new(1, -16, 0, 14),
	}, frame)

	local barFill = new("Frame", {
		BackgroundColor3 = Color3.fromRGB(74, 163, 255),
		BorderSizePixel = 0,
		Size = UDim2.new(1, 0, 1, 0),
	}, barBg)

	local pips = new("TextLabel", {
		BackgroundTransparency = 1,
		AnchorPoint = Vector2.new(1, 0),
		Position = UDim2.new(1, -8, 0, 2),
		Size = UDim2.new(0, 120, 0, 18),
		Font = Enum.Font.Code,
		TextSize = 15,
		TextXAlignment = Enum.TextXAlignment.Right,
		TextColor3 = Color3.fromRGB(255, 216, 77),
		Text = "",
	}, frame)

	rows[index] = { frame = frame, name = name, fill = barFill, pips = pips }
	return rows[index]
end

local function repeatString(str, count)
	local out = ""
	for _ = 1, count do
		out ..= str
	end
	return out
end

stateEvent.OnClientEvent:Connect(function(payload)
	timerLabel.Text = string.format("%02d", payload.timeLeft or 0)
	timerLabel.TextColor3 = (payload.timeLeft or 0) <= 10 and Color3.fromRGB(255, 107, 92)
		or Color3.fromRGB(255, 255, 255)
	announceLabel.Text = payload.announce or ""

	local fighters = payload.fighters or {}
	for index, info in fighters do
		local row = ensureRow(index)
		local isYou = info.userId == player.UserId
		row.frame.Visible = true
		row.name.Text = (isYou and "▶ " or "  ") .. info.name .. (info.alive and "" or "  (陣亡)")
		row.name.TextColor3 = isYou and Color3.fromRGB(124, 194, 67) or Color3.fromRGB(255, 255, 255)
		row.fill.Size = UDim2.new(math.clamp(info.hp / info.maxHp, 0, 1), 0, 1, 0)
		row.fill.BackgroundColor3 = isYou and Color3.fromRGB(74, 163, 255) or Color3.fromRGB(255, 107, 92)
		row.pips.Text = repeatString("★", info.rounds)
			.. repeatString("☆", math.max(0, (payload.roundsToWin or 3) - info.rounds))
	end
	for index = #fighters + 1, #rows do
		rows[index].frame.Visible = false
	end

	ammoLabel.Text = "雪球 " .. repeatString("●", payload.ammo or 0)
		.. repeatString("○", math.max(0, (payload.maxAmmo or 8) - (payload.ammo or 0)))
	blockLabel.Text = "方塊 " .. repeatString("■", payload.blocks or 0)
		.. repeatString("□", math.max(0, (payload.maxBlocks or 10) - (payload.blocks or 0)))
end)

-- ---------------------------------------------------------------- actions
-- sword and snowball repeat while held (the server's cooldowns pace them),
-- so a touch player never has to machine-gun the screen
local held = { sword = false, snowball = false }

local function bind(action, title, key, position, repeatable)
	local function handler(_, inputState)
		if inputState == Enum.UserInputState.Begin then
			actionEvent:FireServer(action)
			if repeatable then
				held[action] = true
			end
		elseif inputState == Enum.UserInputState.End or inputState == Enum.UserInputState.Cancel then
			if repeatable then
				held[action] = false
			end
		end
		return Enum.ContextActionResult.Pass
	end

	ContextActionService:BindAction("BB_" .. action, handler, true, key)
	ContextActionService:SetTitle("BB_" .. action, title)
	ContextActionService:SetPosition("BB_" .. action, position)
end

bind("sword", "劍", Enum.KeyCode.F, UDim2.new(1, -160, 1, -180), true)
bind("snowball", "雪", Enum.KeyCode.G, UDim2.new(1, -90, 1, -250), true)
bind("block", "磚", Enum.KeyCode.R, UDim2.new(1, -240, 1, -110), false)

-- make the touch buttons finger-sized instead of the small default
if TOUCH then
	task.defer(function()
		local buttonGui = playerGui:FindFirstChild("ContextActionGui")
		local frame = buttonGui and buttonGui:FindFirstChild("ContextButtonFrame")
		if not frame then
			return
		end
		for _, button in frame:GetChildren() do
			if button:IsA("ImageButton") then
				button.Size = UDim2.new(0, 92, 0, 92)
				local label = button:FindFirstChildWhichIsA("TextLabel")
				if label then
					label.TextSize = 30
					label.Font = Enum.Font.GothamBold
				end
			end
		end
	end)
end

local heldAccumulator = 0
RunService.Heartbeat:Connect(function(dt)
	heldAccumulator += dt
	if heldAccumulator < 0.1 then
		return
	end
	heldAccumulator = 0
	for action, isHeld in held do
		if isHeld then
			actionEvent:FireServer(action)
		end
	end
end)
