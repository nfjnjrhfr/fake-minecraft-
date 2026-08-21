--[[
	Enough of the Roblox API to run the game's pure modules under the plain
	Luau interpreter. Anything a test touches has to behave like the real thing;
	anything it does not touch is allowed to be a stub.
]]

-- Vector3 ---------------------------------------------------------------------
local Vector3Meta = {}
Vector3Meta.__index = function(self, key)
	if key == "Magnitude" then
		return math.sqrt(self.X * self.X + self.Y * self.Y + self.Z * self.Z)
	elseif key == "Unit" then
		local length = math.sqrt(self.X * self.X + self.Y * self.Y + self.Z * self.Z)
		return Vector3.new(self.X / length, self.Y / length, self.Z / length)
	end
	return rawget(Vector3Meta, key)
end
Vector3Meta.__add = function(a, b) return Vector3.new(a.X + b.X, a.Y + b.Y, a.Z + b.Z) end
Vector3Meta.__sub = function(a, b) return Vector3.new(a.X - b.X, a.Y - b.Y, a.Z - b.Z) end
Vector3Meta.__unm = function(a) return Vector3.new(-a.X, -a.Y, -a.Z) end
Vector3Meta.__eq = function(a, b) return a.X == b.X and a.Y == b.Y and a.Z == b.Z end
Vector3Meta.__tostring = function(a) return string.format("(%.2f, %.2f, %.2f)", a.X, a.Y, a.Z) end
Vector3Meta.__mul = function(a, b)
	if type(b) == "number" then
		return Vector3.new(a.X * b, a.Y * b, a.Z * b)
	elseif type(a) == "number" then
		return Vector3.new(b.X * a, b.Y * a, b.Z * a)
	end
	return Vector3.new(a.X * b.X, a.Y * b.Y, a.Z * b.Z)
end
Vector3Meta.__div = function(a, b)
	if type(b) == "number" then
		return Vector3.new(a.X / b, a.Y / b, a.Z / b)
	end
	return Vector3.new(a.X / b.X, a.Y / b.Y, a.Z / b.Z)
end

Vector3 = {}
function Vector3.new(x, y, z)
	return setmetatable({ X = x or 0, Y = y or 0, Z = z or 0 }, Vector3Meta)
end
Vector3.zero = Vector3.new(0, 0, 0)
Vector3.one = Vector3.new(1, 1, 1)

Vector2 = { new = function(x, y) return { X = x or 0, Y = y or 0 } end }

-- Color3 ----------------------------------------------------------------------
local Color3Meta = {}
Color3Meta.__index = Color3Meta
function Color3Meta.Lerp(self, other, alpha)
	return Color3.new(
		self.R + (other.R - self.R) * alpha,
		self.G + (other.G - self.G) * alpha,
		self.B + (other.B - self.B) * alpha
	)
end

Color3 = {}
function Color3.new(r, g, b)
	return setmetatable({ R = r or 0, G = g or 0, B = b or 0 }, Color3Meta)
end
function Color3.fromRGB(r, g, b)
	return Color3.new((r or 0) / 255, (g or 0) / 255, (b or 0) / 255)
end

-- Enum ------------------------------------------------------------------------
local function enumFamily(family)
	return setmetatable({}, {
		__index = function(self, key)
			local value = { Name = key, Family = family }
			rawset(self, key, value)
			return value
		end,
	})
end

Enum = setmetatable({}, {
	__index = function(self, key)
		local family = enumFamily(key)
		rawset(self, key, family)
		return family
	end,
})

-- Services --------------------------------------------------------------------
local MODULES = {}
local LOADED = {}

--[[ Any instance in the fake tree answers to WaitForChild and to plain
     indexing, and every leaf doubles as a handle the fake require accepts. ]]
local function moduleHandle(name)
	return setmetatable({ __module = name }, {
		__index = function(_, key)
			if key == "WaitForChild" or key == "FindFirstChild" then
				return function(_, child)
					return moduleHandle(child)
				end
			end
			if key == "Name" then
				return name
			end
			return moduleHandle(key)
		end,
	})
end

local FOLDER = moduleHandle("FakeMinecraft")

local SERVICES = {
	ReplicatedStorage = FOLDER,
	RunService = { IsServer = function() return true end, IsStudio = function() return true end },
	Players = { GetPlayers = function() return {} end },
	Workspace = {},
	Lighting = {},
}

game = {
	GetService = function(_, name)
		return SERVICES[name] or {}
	end,
	FindFirstChild = function(_, name)
		return SERVICES[name]
	end,
	BindToClose = function() end,
}

workspace = SERVICES.Workspace

function __registerModule(name, loader)
	MODULES[name] = loader
end

function __require(name)
	if LOADED[name] ~= nil then
		return LOADED[name]
	end

	local loader = MODULES[name]
	if not loader then
		error("test harness has no module named " .. tostring(name), 2)
	end

	LOADED[name] = loader({ Parent = FOLDER, Name = name })
	return LOADED[name]
end

require = function(target)
	if type(target) == "table" and target.__module then
		return __require(target.__module)
	end
	error("unexpected require target in tests", 2)
end

-- Odds and ends ---------------------------------------------------------------
task = {
	wait = function() return 0 end,
	spawn = function(fn, ...) fn(...) end,
	delay = function(_, fn, ...) fn(...) end,
}

warn = function(...)
	local parts = {}
	for index = 1, select("#", ...) do
		parts[index] = tostring(select(index, ...))
	end
	print("[warn] " .. table.concat(parts, " "))
end

typeof = typeof or type

--[[ Roblox's math.noise is Perlin; this is value noise with the same shape:
     smooth, deterministic, roughly [-0.5, 0.5]. Terrain tests care that it is
     continuous and repeatable, not that it matches Roblox bit for bit. ]]
local function valueAt(x, y, z)
	local n = (x * 374761393 + y * 668265263 + z * 1442695040 + 12345) % 4294967296
	n = bit32.bxor(n, bit32.rshift(n, 13))
	n = bit32.bxor(n, bit32.lshift(n, 7))
	n = bit32.bxor(n, bit32.rshift(n, 17))
	return n / 4294967296 * 2 - 1
end

local function fade(t)
	return t * t * t * (t * (t * 6 - 15) + 10)
end

--[[ The standard library is frozen, so `math` is shadowed with a table that
     adds noise and falls through to the real one for everything else. ]]
local realMath = math
math = setmetatable({}, { __index = realMath })

math.noise = function(x, y, z)
	x, y, z = x or 0, y or 0, z or 0

	local x0, y0, z0 = math.floor(x), math.floor(y), math.floor(z)
	local fx, fy, fz = fade(x - x0), fade(y - y0), fade(z - z0)

	local function lerp(a, b, t)
		return a + (b - a) * t
	end

	local function along(dz)
		local x00 = lerp(valueAt(x0, y0, z0 + dz), valueAt(x0 + 1, y0, z0 + dz), fx)
		local x10 = lerp(valueAt(x0, y0 + 1, z0 + dz), valueAt(x0 + 1, y0 + 1, z0 + dz), fx)
		return lerp(x00, x10, fy)
	end

	return lerp(along(0), along(1), fz) * 0.5
end
