--!strict
--[[ Every tunable number in the game lives here. ]]

return table.freeze({
	-- Geometry -------------------------------------------------------------
	BlockSize = 3, -- studs per block
	ChunkSizeX = 16,
	ChunkSizeZ = 16,
	WorldHeight = 64, -- blocks, y = 0 .. WorldHeight - 1
	SeaLevel = 22,
	BedrockDepth = 2,

	-- Generation -----------------------------------------------------------
	Seed = 20250821,
	TerrainScale = 0.014,
	DetailScale = 0.06,
	CaveScale = 0.075,
	CaveThreshold = 0.42,
	BiomeScale = 0.004,
	MinSurface = 8,
	MaxSurface = 46,

	-- Streaming ------------------------------------------------------------
	RenderDistance = 4, -- chunks sent around a player
	UnloadDistance = 6, -- chunks are dropped past this
	ChunksPerTick = 2, -- generation/send budget per streaming tick
	StreamInterval = 0.35,

	-- Interaction ----------------------------------------------------------
	MaxReach = 24, -- studs
	PlaceCooldown = 0.15,
	BreakLeniency = 0.75, -- fraction of the expected break time the server accepts

	-- Inventory ------------------------------------------------------------
	StackSize = 64,
	HotbarSlots = 9,
	InventorySlots = 36, -- hotbar included; slots 1..9 are the hotbar
	CraftGridSize = 3,

	-- World feel -----------------------------------------------------------
	DayLengthSeconds = 720,
	DropLifetime = 300,
	DropPickupRadius = 6,

	-- Persistence ----------------------------------------------------------
	AutosaveInterval = 120,
	DataStoreRetries = 4,
})
