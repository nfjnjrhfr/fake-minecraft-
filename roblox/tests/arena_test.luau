local GameConfig = require("../src/ReplicatedStorage/GameConfig")

local plan = GameConfig.buildArenaPlan()
local fails = 0
local function check(ok, msg)
	if not ok then fails += 1 print("FAIL: " .. msg) end
end

print(("blocks: %d"):format(#plan))
check(#plan > 10, "plan should not be trivial")

-- 1. every block is mirrored across X (blocks on x=0 are their own mirror)
local function key(b)
	-- normalise -0 to 0 so a mirrored centre block matches itself
	local x = b.x == 0 and 0 or b.x
	return ("%s|%.2f|%.2f|%.2f|%.2f|%.2f|%.2f"):format(b.kind, x, b.y, b.z, b.sx, b.sy, b.sz)
end
local seen = {}
for _, b in plan do
	seen[key(b)] = (seen[key(b)] or 0) + 1
end
for _, b in plan do
	local mirror = { kind = b.kind, x = -b.x, y = b.y, z = b.z, sx = b.sx, sy = b.sy, sz = b.sz }
	check(seen[key(mirror)] ~= nil, ("no mirror for %s at x=%.1f y=%.1f"):format(b.kind, b.x, b.y))
end

-- 2. no duplicated/overlapping identical blocks, and all sizes are sane
for k, count in seen do
	check(count == 1, "duplicate block: " .. k)
end
for _, b in plan do
	check(b.sx > 0 and b.sy > 0 and b.sz > 0, "non-positive size on " .. b.kind)
	check(b.kind ~= nil and GameConfig.KINDS[b.kind] ~= nil, "unknown kind " .. tostring(b.kind))
	check(b.y - b.sy / 2 > GameConfig.RING_OUT_Y, ("%s hangs below the kill plane"):format(b.kind))
end

-- 3. every spawn point stands on solid ground it can actually land on
for i, sp in GameConfig.spawnPoints() do
	local supported = false
	for _, b in plan do
		local top = b.y + b.sy / 2
		if top <= sp.y + 0.01
			and math.abs(sp.x - b.x) <= b.sx / 2
			and math.abs(sp.z - b.z) <= b.sz / 2
			and top > sp.y - 12 then
			supported = true
		end
	end
	check(supported, ("spawn %d (%.0f, %.0f) has no floor under it"):format(i, sp.x, sp.z))
end

-- 4. the two main spawns are symmetric opposites
local sp = GameConfig.spawnPoints()
check(sp[1].x == -sp[2].x and sp[1].z == sp[2].z, "main spawns are not mirrored")

-- 5. there is a real gap between the centre and side islands (fall hazard)
local coveredAtY0 = function(x)
	for _, b in plan do
		if b.kind == "grass" and math.abs(x - b.x) <= b.sx / 2 then return true end
	end
	return false
end
check(coveredAtY0(0), "centre island missing")
check(coveredAtY0(GameConfig.SPAWN_X), "side island missing under spawn")
check(not coveredAtY0(34), "expected a gap at x=34")

print(fails == 0 and "ALL ARENA CHECKS PASSED" or (fails .. " CHECK(S) FAILED"))
