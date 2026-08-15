--[[
	BattleServer — arena, round flow and all combat resolution.

	The client is only ever allowed to say "I pressed sword / snowball / block";
	every cooldown, stock count, hit test and damage number is decided here.
]]

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local Debris = game:GetService("Debris")

local GameConfig = require(ReplicatedStorage:WaitForChild("GameConfig"))

-- we drive spawning ourselves so a dead fighter stays dead until next round
Players.CharacterAutoLoads = false

-- ---------------------------------------------------------------- remotes
local remotes = ReplicatedStorage:FindFirstChild("BlockBrawlRemotes")
if not remotes then
	remotes = Instance.new("Folder")
	remotes.Name = "BlockBrawlRemotes"
	remotes.Parent = ReplicatedStorage
end

local actionEvent = Instance.new("RemoteEvent")
actionEvent.Name = "Action"
actionEvent.Parent = remotes

local stateEvent = Instance.new("RemoteEvent")
stateEvent.Name = "State"
stateEvent.Parent = remotes

-- ---------------------------------------------------------------- arena
local arenaFolder = nil

local function makeBlock(kind, cframe, size, parent)
	local spec = GameConfig.KINDS[kind] or GameConfig.KINDS.stone
	local part = Instance.new("Part")
	part.Name = kind
	part.Anchored = true
	part.Size = size
	part.CFrame = cframe
	part.Color = Color3.fromRGB(spec.color[1], spec.color[2], spec.color[3])
	part.Material = Enum.Material[spec.material]
	part.TopSurface = Enum.SurfaceType.Smooth
	part.BottomSurface = Enum.SurfaceType.Smooth
	part.Parent = parent
	return part
end

local function buildArena()
	if arenaFolder then
		arenaFolder:Destroy()
	end
	arenaFolder = Instance.new("Folder")
	arenaFolder.Name = "Arena"
	arenaFolder.Parent = workspace

	for _, b in GameConfig.buildArenaPlan() do
		makeBlock(b.kind, CFrame.new(b.x, b.y, b.z), Vector3.new(b.sx, b.sy, b.sz), arenaFolder)
	end

	-- invisible spawn pads so a default respawn also lands on the stage
	for i, sp in GameConfig.spawnPoints() do
		local pad = Instance.new("SpawnLocation")
		pad.Name = "Spawn" .. i
		pad.Anchored = true
		pad.CanCollide = false
		pad.Transparency = 1
		pad.Size = Vector3.new(6, 1, 6)
		pad.CFrame = CFrame.new(sp.x, sp.y, sp.z)
		pad.Neutral = true
		pad.Duration = 0
		pad.Parent = arenaFolder
	end
end

-- slightly floaty gravity so a jump clears a 6-stud block comfortably
workspace.Gravity = 130

-- clear whatever the empty baseplate template shipped with
for _, inst in workspace:GetChildren() do
	if inst.Name == "Baseplate" or inst:IsA("SpawnLocation") then
		inst:Destroy()
	end
end
buildArena()

-- ---------------------------------------------------------------- state
local phase = "waiting" -- waiting | countdown | playing | roundEnd | matchEnd
local announce = "等待第二位玩家加入…"
local timeLeft = 0

local playerState = {} -- [player] = { rounds, ammo, blocks, alive, lastSword, lastSnow, lastBlock }

local function stateFor(player)
	local st = playerState[player]
	if not st then
		st = {
			rounds = 0,
			ammo = GameConfig.MAX_AMMO,
			blocks = GameConfig.MAX_BLOCKS,
			alive = false,
			lastSword = 0,
			lastSnow = 0,
			lastBlock = 0,
			ammoClock = 0,
			blockClock = 0,
		}
		playerState[player] = st
	end
	return st
end

local function humanoidOf(player)
	local char = player.Character
	if not char then
		return nil, nil
	end
	local humanoid = char:FindFirstChildOfClass("Humanoid")
	local root = char:FindFirstChild("HumanoidRootPart")
	if not humanoid or not root or humanoid.Health <= 0 then
		return nil, nil
	end
	return humanoid, root
end

local function aliveFighters()
	local list = {}
	for _, player in Players:GetPlayers() do
		local st = playerState[player]
		local humanoid = humanoidOf(player)
		if st and st.alive and humanoid then
			table.insert(list, player)
		end
	end
	return list
end

-- ---------------------------------------------------------------- broadcast
local function broadcast()
	local fighters = {}
	for _, player in Players:GetPlayers() do
		local st = stateFor(player)
		local humanoid = humanoidOf(player)
		table.insert(fighters, {
			name = player.DisplayName,
			userId = player.UserId,
			hp = humanoid and math.floor(humanoid.Health + 0.5) or 0,
			maxHp = GameConfig.MAX_HEALTH,
			rounds = st.rounds,
			alive = st.alive and humanoid ~= nil,
		})
	end

	for _, player in Players:GetPlayers() do
		local st = stateFor(player)
		stateEvent:FireClient(player, {
			phase = phase,
			announce = announce,
			timeLeft = math.max(0, math.floor(timeLeft)),
			roundsToWin = GameConfig.ROUNDS_TO_WIN,
			fighters = fighters,
			ammo = math.floor(st.ammo),
			maxAmmo = GameConfig.MAX_AMMO,
			blocks = math.floor(st.blocks),
			maxBlocks = GameConfig.MAX_BLOCKS,
		})
	end
end

-- ---------------------------------------------------------------- combat
local function damagePlayer(target, amount, knockDir)
	if phase ~= "playing" then
		return
	end
	local humanoid, root = humanoidOf(target)
	if not humanoid or not root then
		return
	end
	humanoid:TakeDamage(amount)
	if knockDir then
		root.AssemblyLinearVelocity = knockDir * GameConfig.SWORD_KNOCKBACK + Vector3.new(0, 24, 0)
	end
end

local function playerFromPart(part)
	local model = part:FindFirstAncestorOfClass("Model")
	while model do
		local player = Players:GetPlayerFromCharacter(model)
		if player then
			return player
		end
		model = model:FindFirstAncestorOfClass("Model")
	end
	return nil
end

local function swingSword(player)
	local st = stateFor(player)
	local now = os.clock()
	if now - st.lastSword < GameConfig.SWORD_COOLDOWN then
		return
	end
	local humanoid, root = humanoidOf(player)
	if not humanoid or not root then
		return
	end
	st.lastSword = now

	local reach = GameConfig.SWORD_RANGE
	local hitBox = root.CFrame * CFrame.new(0, 0, -reach * 0.5)
	local params = OverlapParams.new()
	params.FilterType = Enum.RaycastFilterType.Exclude
	params.FilterDescendantsInstances = { player.Character }

	local parts = workspace:GetPartBoundsInBox(hitBox, Vector3.new(8, 9, reach), params)
	local alreadyHit = {}
	local connected = false

	for _, part in parts do
		local victim = playerFromPart(part)
		if victim and victim ~= player and not alreadyHit[victim] then
			alreadyHit[victim] = true
			connected = true
			local _, victimRoot = humanoidOf(victim)
			local dir = Vector3.new(0, 0, 0)
			if victimRoot then
				dir = (victimRoot.Position - root.Position) * Vector3.new(1, 0, 1)
				if dir.Magnitude > 0.01 then
					dir = dir.Unit
				end
			end
			damagePlayer(victim, GameConfig.SWORD_DAMAGE, dir)
		end
	end

	-- a miss mines one player-placed block instead, so walls are not permanent
	if not connected then
		for _, part in parts do
			if part:GetAttribute("Placed") then
				part:Destroy()
				if st.blocks < GameConfig.MAX_BLOCKS then
					st.blocks = math.min(GameConfig.MAX_BLOCKS, st.blocks + 1)
				end
				break
			end
		end
	end
end

local function throwSnowball(player)
	local st = stateFor(player)
	local now = os.clock()
	if now - st.lastSnow < GameConfig.SNOWBALL_COOLDOWN or st.ammo < 1 then
		return
	end
	local humanoid, root = humanoidOf(player)
	if not humanoid or not root then
		return
	end
	st.lastSnow = now
	st.ammo -= 1

	local look = root.CFrame.LookVector
	local ball = Instance.new("Part")
	ball.Name = "Snowball"
	ball.Shape = Enum.PartType.Ball
	ball.Size = Vector3.new(2, 2, 2)
	ball.Color = Color3.fromRGB(240, 248, 255)
	ball.Material = Enum.Material.Sand
	ball.CanCollide = false
	ball.CFrame = CFrame.new(root.Position + look * 4 + Vector3.new(0, 1.5, 0))
	ball.AssemblyLinearVelocity = look * GameConfig.SNOWBALL_SPEED + Vector3.new(0, 22, 0)
	ball.Parent = workspace
	Debris:AddItem(ball, GameConfig.SNOWBALL_LIFETIME)

	local spent = false
	local conn = nil
	conn = ball.Touched:Connect(function(other)
		if spent then
			return
		end
		if other:IsDescendantOf(player.Character) then
			return
		end
		spent = true
		if conn then
			conn:Disconnect()
		end
		local victim = playerFromPart(other)
		if victim and victim ~= player then
			local dir = ball.AssemblyLinearVelocity * Vector3.new(1, 0, 1)
			if dir.Magnitude > 0.01 then
				dir = dir.Unit
			end
			damagePlayer(victim, GameConfig.SNOWBALL_DAMAGE, dir * 0.55)
		end
		ball:Destroy()
	end)
end

local function placeBlock(player)
	local st = stateFor(player)
	local now = os.clock()
	if now - st.lastBlock < GameConfig.BLOCK_COOLDOWN or st.blocks < 1 then
		return
	end
	local humanoid, root = humanoidOf(player)
	if not humanoid or not root then
		return
	end

	local size = GameConfig.BLOCK
	local function snap(v)
		return math.floor(v / size + 0.5) * size
	end

	local look = root.CFrame.LookVector * Vector3.new(1, 0, 1)
	if look.Magnitude < 0.01 then
		return
	end
	local target = root.Position + look.Unit * (size * 1.5) - Vector3.new(0, 1, 0)
	local pos = Vector3.new(snap(target.X), snap(target.Y), snap(target.Z))

	-- refuse to place inside anything, including another player
	local params = OverlapParams.new()
	params.FilterType = Enum.RaycastFilterType.Exclude
	params.FilterDescendantsInstances = { player.Character }
	local blocked = workspace:GetPartBoundsInBox(CFrame.new(pos), Vector3.new(size - 0.8, size - 0.8, size - 0.8), params)
	if #blocked > 0 then
		return
	end

	st.lastBlock = now
	st.blocks -= 1

	local part = makeBlock("plank", CFrame.new(pos), Vector3.new(size, size, size), arenaFolder)
	part:SetAttribute("Placed", true)
	Debris:AddItem(part, GameConfig.BLOCK_LIFETIME)
end

local ACTIONS = {
	sword = swingSword,
	snowball = throwSnowball,
	block = placeBlock,
}

actionEvent.OnServerEvent:Connect(function(player, action)
	if phase ~= "playing" then
		return
	end
	local st = playerState[player]
	if not st or not st.alive then
		return
	end
	local handler = typeof(action) == "string" and ACTIONS[action]
	if handler then
		handler(player)
	end
end)

-- ---------------------------------------------------------------- round flow
local function freeze(player, frozen)
	local humanoid = humanoidOf(player)
	if humanoid then
		-- set both jump properties: which one applies depends on UseJumpPower
		humanoid.WalkSpeed = frozen and 0 or 18
		humanoid.JumpPower = frozen and 0 or 50
		humanoid.JumpHeight = frozen and 0 or 7.2
	end
end

-- puts a fighter on their own pad, facing the middle of the arena
local function placeAtSpawn(player, spawnIndex)
	local points = GameConfig.spawnPoints()
	local sp = points[((spawnIndex - 1) % #points) + 1]
	local char = player.Character
	if not char then
		return
	end
	local pos = Vector3.new(sp.x, sp.y + 3, sp.z)
	char:PivotTo(CFrame.lookAt(pos, Vector3.new(0, pos.Y, sp.z)))
	local root = char:FindFirstChild("HumanoidRootPart")
	if root then
		root.AssemblyLinearVelocity = Vector3.new(0, 0, 0)
	end
end

local function spawnFighter(player, index)
	local st = stateFor(player)
	st.spawnIndex = index

	player:LoadCharacter()
	local char = player.Character or player.CharacterAdded:Wait()
	local humanoid = char:WaitForChild("Humanoid")
	humanoid.MaxHealth = GameConfig.MAX_HEALTH
	humanoid.Health = GameConfig.MAX_HEALTH

	placeAtSpawn(player, index)

	st.alive = true
	st.ammo = GameConfig.MAX_AMMO
	st.blocks = GameConfig.MAX_BLOCKS

	humanoid.Died:Connect(function()
		st.alive = false
	end)
end

local function ringOutCheck()
	if phase ~= "playing" then
		return
	end
	for _, player in Players:GetPlayers() do
		local st = playerState[player]
		local humanoid, root = humanoidOf(player)
		if st and st.alive and humanoid and root and root.Position.Y < GameConfig.RING_OUT_Y then
			-- costly, but it only ends the round if it finishes you off
			humanoid:TakeDamage(GameConfig.RING_OUT_DAMAGE)
			if humanoid.Health > 0 then
				placeAtSpawn(player, st.spawnIndex or 1)
			end
		end
	end
end

local function regenStocks(dt)
	if phase ~= "playing" then
		return
	end
	for _, player in Players:GetPlayers() do
		local st = stateFor(player)
		st.ammoClock += dt
		if st.ammoClock >= GameConfig.AMMO_REGEN then
			st.ammoClock = 0
			st.ammo = math.min(GameConfig.MAX_AMMO, st.ammo + 1)
		end
		st.blockClock += dt
		if st.blockClock >= GameConfig.BLOCK_REGEN then
			st.blockClock = 0
			st.blocks = math.min(GameConfig.MAX_BLOCKS, st.blocks + 1)
		end
	end
end

RunService.Heartbeat:Connect(function(dt)
	ringOutCheck()
	regenStocks(dt)
end)

local function healthiestPlayer()
	local best, bestHp = nil, -1
	for _, player in Players:GetPlayers() do
		local humanoid = humanoidOf(player)
		local hp = humanoid and humanoid.Health or -1
		if hp > bestHp then
			best, bestHp = player, hp
		end
	end
	return best
end

local function runRound()
	buildArena()
	phase = "countdown"
	announce = "準備…"
	timeLeft = GameConfig.ROUND_SECONDS

	local index = 0
	for _, player in Players:GetPlayers() do
		index += 1
		-- a player leaving mid-spawn must not take the round loop down with it
		local ok, err = pcall(spawnFighter, player, index)
		if not ok then
			warn("[BlockBrawl] 無法生成玩家 " .. player.Name .. ": " .. tostring(err))
		else
			freeze(player, true)
		end
	end
	broadcast()

	for i = GameConfig.COUNTDOWN_SECONDS, 1, -1 do
		announce = tostring(i)
		broadcast()
		task.wait(1)
	end

	for _, player in Players:GetPlayers() do
		freeze(player, false)
	end
	phase = "playing"
	announce = "開始!"
	broadcast()

	while timeLeft > 0 and #aliveFighters() > 1 and #Players:GetPlayers() > 1 do
		task.wait(0.2)
		timeLeft -= 0.2
		if announce ~= "" and timeLeft < GameConfig.ROUND_SECONDS - 1 then
			announce = ""
		end
		broadcast()
	end

	-- decide the round
	local alive = aliveFighters()
	local winner = nil
	if #alive == 1 then
		winner = alive[1]
	elseif #alive > 1 then
		winner = healthiestPlayer()
	end

	phase = "roundEnd"
	if winner then
		local st = stateFor(winner)
		st.rounds += 1
		announce = winner.DisplayName .. " 拿下這回合!"
		if st.rounds >= GameConfig.ROUNDS_TO_WIN then
			phase = "matchEnd"
			announce = "🏆 " .. winner.DisplayName .. " 獲勝!"
		end
	else
		announce = "平手!"
	end
	broadcast()

	task.wait(GameConfig.INTERMISSION_SECONDS)

	if phase == "matchEnd" then
		for _, player in Players:GetPlayers() do
			stateFor(player).rounds = 0
		end
	end
end

task.spawn(function()
	while true do
		if #Players:GetPlayers() < 2 then
			phase = "waiting"
			announce = "等待第二位玩家加入…"
			timeLeft = 0
			broadcast()
			task.wait(1)
		else
			-- one bad round must never end the match loop for the whole server
			local ok, err = pcall(runRound)
			if not ok then
				warn("[BlockBrawl] 回合發生錯誤: " .. tostring(err))
				phase = "roundEnd"
				announce = ""
				task.wait(2)
			end
		end
	end
end)

-- ---------------------------------------------------------------- players
Players.PlayerAdded:Connect(function(player)
	stateFor(player)
	-- let people walk around between rounds; the round start re-spawns them
	if phase ~= "playing" then
		spawnFighter(player, #Players:GetPlayers())
	end
	broadcast()
end)

Players.PlayerRemoving:Connect(function(player)
	playerState[player] = nil
end)
