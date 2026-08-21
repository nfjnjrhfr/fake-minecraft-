--!strict
--[[ A full day every WorldConfig.DayLengthSeconds, with the sky tinted to match. ]]

local Lighting = game:GetService("Lighting")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")

local Shared = ReplicatedStorage:WaitForChild("FakeMinecraft")
local WorldConfig = require(Shared:WaitForChild("WorldConfig"))

local DAY_AMBIENT = Color3.fromRGB(120, 122, 130)
local NIGHT_AMBIENT = Color3.fromRGB(38, 42, 58)

local DayNightService = {}

local elapsed = 0

function DayNightService.timeOfDay(): number
	return (elapsed / WorldConfig.DayLengthSeconds * 24) % 24
end

--[[ 0 at midnight, 1 at noon. ]]
local function daylight(clockTime: number): number
	return math.clamp(math.sin((clockTime / 24) * math.pi * 2 - math.pi / 2) * 0.5 + 0.5, 0, 1)
end

function DayNightService.start()
	Lighting.GlobalShadows = true
	Lighting.Brightness = 2.4
	Lighting.EnvironmentDiffuseScale = 0.4
	Lighting.FogEnd = WorldConfig.RenderDistance * WorldConfig.ChunkSizeX * WorldConfig.BlockSize
	Lighting.FogStart = Lighting.FogEnd * 0.55

	-- Start mid-morning rather than at midnight.
	elapsed = WorldConfig.DayLengthSeconds * (8 / 24)

	RunService.Heartbeat:Connect(function(delta)
		elapsed += delta

		local clockTime = DayNightService.timeOfDay()
		Lighting.ClockTime = clockTime

		local light = daylight(clockTime)
		Lighting.Ambient = NIGHT_AMBIENT:Lerp(DAY_AMBIENT, light)
		Lighting.OutdoorAmbient = NIGHT_AMBIENT:Lerp(DAY_AMBIENT, light)
		Lighting.FogColor = Color3.fromRGB(18, 22, 34):Lerp(Color3.fromRGB(168, 196, 224), light)
	end)
end

return DayNightService
