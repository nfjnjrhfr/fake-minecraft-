--!strict
--[[
	Deterministic world generation. Everything here is a pure function of the
	seed and the block coordinates, so a chunk regenerates identically on every
	server: only player edits ever need to be saved.
]]

local BlockRegistry = require(script.Parent.BlockRegistry)
local Chunk = require(script.Parent.Chunk)
local Coordinates = require(script.Parent.Coordinates)
local WorldConfig = require(script.Parent.WorldConfig)

local SIZE_X = WorldConfig.ChunkSizeX
local SIZE_Z = WorldConfig.ChunkSizeZ
local HEIGHT = WorldConfig.WorldHeight
local SEA = WorldConfig.SeaLevel
local SEED = WorldConfig.Seed

local AIR = BlockRegistry.Air
local BEDROCK = BlockRegistry.id("Bedrock")
local STONE = BlockRegistry.id("Stone")
local DIRT = BlockRegistry.id("Dirt")
local GRASS = BlockRegistry.id("Grass")
local SAND = BlockRegistry.id("Sand")
local SANDSTONE = BlockRegistry.id("Sandstone")
local GRAVEL = BlockRegistry.id("Gravel")
local WATER = BlockRegistry.id("Water")
local LOG = BlockRegistry.id("Log")
local LEAVES = BlockRegistry.id("Leaves")
local SNOW = BlockRegistry.id("Snow")
local COAL = BlockRegistry.id("CoalOre")
local IRON = BlockRegistry.id("IronOre")
local GOLD = BlockRegistry.id("GoldOre")
local DIAMOND = BlockRegistry.id("DiamondOre")

export type Biome = {
	name: string,
	surface: number,
	filler: number,
	baseHeight: number,
	amplitude: number,
	treeChance: number,
	snowLine: number,
}

local BIOMES: { [string]: Biome } = {
	Plains = { name = "Plains", surface = GRASS, filler = DIRT, baseHeight = 26, amplitude = 5, treeChance = 0.012, snowLine = HEIGHT },
	Forest = { name = "Forest", surface = GRASS, filler = DIRT, baseHeight = 28, amplitude = 7, treeChance = 0.075, snowLine = HEIGHT },
	Desert = { name = "Desert", surface = SAND, filler = SANDSTONE, baseHeight = 25, amplitude = 4, treeChance = 0, snowLine = HEIGHT },
	Mountains = { name = "Mountains", surface = STONE, filler = STONE, baseHeight = 34, amplitude = 18, treeChance = 0.01, snowLine = 42 },
	Tundra = { name = "Tundra", surface = SNOW, filler = DIRT, baseHeight = 27, amplitude = 6, treeChance = 0.02, snowLine = 0 },
}

local TerrainGenerator = {}

TerrainGenerator.Biomes = BIOMES

--[[ 32-bit xorshift over the block coordinates: a stable pseudo-random value
     in [0, 1) for any point in the world. ]]
local function hash(x: number, y: number, z: number, salt: number): number
	local n = (x * 73856093 + y * 19349663 + z * 83492791 + salt * 15485863 + SEED) % 4294967296
	n = bit32.bxor(n, bit32.lshift(n, 13))
	n = bit32.bxor(n, bit32.rshift(n, 17))
	n = bit32.bxor(n, bit32.lshift(n, 5))
	return n / 4294967296
end

--[[ Fractal Brownian motion over Perlin noise, in [-1, 1]. ]]
local function fbm(x: number, z: number, scale: number, octaves: number, salt: number): number
	local total = 0
	local amplitude = 1
	local frequency = scale
	local normalisation = 0

	for _ = 1, octaves do
		total += math.noise(x * frequency, z * frequency, SEED + salt) * amplitude
		normalisation += amplitude
		amplitude *= 0.5
		frequency *= 2
	end

	return math.clamp(total / normalisation * 2, -1, 1)
end

function TerrainGenerator.biomeAt(x: number, z: number): Biome
	local temperature = fbm(x, z, WorldConfig.BiomeScale, 2, 11)
	local humidity = fbm(x, z, WorldConfig.BiomeScale, 2, 29)
	local relief = fbm(x, z, WorldConfig.BiomeScale * 0.6, 2, 47)

	if relief > 0.45 then
		return BIOMES.Mountains
	end
	if temperature < -0.35 then
		return BIOMES.Tundra
	end
	if temperature > 0.35 and humidity < 0 then
		return BIOMES.Desert
	end
	if humidity > 0.15 then
		return BIOMES.Forest
	end
	return BIOMES.Plains
end

function TerrainGenerator.heightAt(x: number, z: number): number
	local biome = TerrainGenerator.biomeAt(x, z)
	local base = fbm(x, z, WorldConfig.TerrainScale, 4, 3)
	local detail = fbm(x, z, WorldConfig.DetailScale, 2, 7) * 0.25

	local height = biome.baseHeight + (base + detail) * biome.amplitude
	return math.clamp(math.floor(height + 0.5), WorldConfig.MinSurface, WorldConfig.MaxSurface)
end

--[[ Caves: 3D noise thresholded into tunnels, closed off near the surface so
     the world does not look eaten from above. ]]
local function isCave(x: number, y: number, z: number, surface: number): boolean
	if y < 2 or y > surface - 3 then
		return false
	end

	local scale = WorldConfig.CaveScale
	local value = math.abs(math.noise(x * scale, y * scale * 1.6, z * scale + SEED))
	local threshold = WorldConfig.CaveThreshold * (1 - math.clamp((y - 4) / 40, 0, 0.45))
	return value > threshold
end

--[[
	Ores come in veins, not sprinkles. A coarse 4x4x4 lattice decides which
	cells hold a vein and of what, and roughly half the blocks inside a chosen
	cell become ore. Clumps are better to mine, and they keep the chunk's
	run-length encoding short - scattered single blocks would shred it.
]]
local VEIN_CELL = 4

local VEINS = {
	{ ore = DIAMOND, maxDepth = 14, cellChance = 0.004, fill = 0.4 },
	{ ore = GOLD, maxDepth = 30, cellChance = 0.012, fill = 0.45 },
	{ ore = IRON, maxDepth = 40, cellChance = 0.032, fill = 0.5 },
	{ ore = COAL, maxDepth = 44, cellChance = 0.06, fill = 0.5 },
	{ ore = GRAVEL, maxDepth = 44, cellChance = 0.018, fill = 0.6 },
}

local function oreAt(x: number, y: number, z: number): number?
	if y > 44 then
		return nil
	end

	local cellX = math.floor(x / VEIN_CELL)
	local cellY = math.floor(y / VEIN_CELL)
	local cellZ = math.floor(z / VEIN_CELL)
	local cellRoll = hash(cellX, cellY, cellZ, 101)

	local threshold = 0
	for _, vein in VEINS do
		if y <= vein.maxDepth then
			threshold += vein.cellChance
			if cellRoll < threshold then
				return if hash(x, y, z, 211) < vein.fill then vein.ore else nil
			end
		end
	end

	return nil
end

local function plantTree(chunk: Chunk.Chunk, lx: number, ly: number, lz: number, height: number)
	for offset = 0, height - 1 do
		chunk:setRaw(lx, ly + offset, lz, LOG)
	end

	local crown = ly + height - 1
	for dx = -2, 2 do
		for dz = -2, 2 do
			for dy = -1, 1 do
				local distance = math.abs(dx) + math.abs(dz) + math.abs(dy)
				local inCrown = distance <= 3 and not (dx == 0 and dz == 0 and dy <= 0)
				if inCrown and chunk:get(lx + dx, crown + dy, lz + dz) == AIR then
					chunk:setRaw(lx + dx, crown + dy, lz + dz, LEAVES)
				end
			end
		end
	end

	chunk:setRaw(lx, crown + 2, lz, LEAVES)
end

function TerrainGenerator.generate(chunk: Chunk.Chunk)
	local originX, originZ = Coordinates.chunkOrigin(chunk.cx, chunk.cz)

	for lx = 0, SIZE_X - 1 do
		local worldX = originX + lx

		for lz = 0, SIZE_Z - 1 do
			local worldZ = originZ + lz
			local biome = TerrainGenerator.biomeAt(worldX, worldZ)
			local surface = TerrainGenerator.heightAt(worldX, worldZ)
			local underwater = surface < SEA

			for y = 0, math.max(surface, SEA) do
				local blockId = AIR

				if y <= math.floor(hash(worldX, 0, worldZ, 5) * WorldConfig.BedrockDepth) then
					blockId = BEDROCK
				elseif y > surface then
					blockId = if y <= SEA then WATER else AIR
				elseif isCave(worldX, y, worldZ, surface) then
					blockId = AIR
				elseif y == surface then
					if underwater then
						blockId = SAND
					elseif y >= biome.snowLine then
						blockId = SNOW
					else
						blockId = biome.surface
					end
				elseif y >= surface - 3 then
					blockId = if underwater then SAND else biome.filler
				else
					blockId = oreAt(worldX, y, worldZ) or STONE
				end

				if blockId ~= AIR then
					chunk:setRaw(lx, y, lz, blockId)
				end
			end

			-- Decorations sit on top of finished columns.
			if not underwater and surface + 6 < HEIGHT and biome.treeChance > 0 then
				local top = chunk:get(lx, surface, lz)
				local canPlant = top == GRASS or top == SNOW
				if canPlant and lx >= 2 and lx < SIZE_X - 2 and lz >= 2 and lz < SIZE_Z - 2 then
					if hash(worldX, 0, worldZ, 61) < biome.treeChance then
						plantTree(chunk, lx, surface + 1, lz, 4 + math.floor(hash(worldX, 1, worldZ, 62) * 3))
					end
				end
			end
		end
	end

	chunk:buildHeightMap()
end

--[[ A safe place to drop a player: the first air gap above the terrain. ]]
function TerrainGenerator.spawnHeight(x: number, z: number): number
	return math.max(TerrainGenerator.heightAt(x, z), SEA) + 2
end

return TerrainGenerator
