# How the game works

A voxel sandbox: an endless generated world of blocks that players mine, place
and craft. This is the architecture behind it.

## The split

The server owns the world data. The client owns the pixels.

```
  server                                    client
  ──────                                    ──────
  WorldService     chunks in memory
  TerrainGenerator generates from the seed
  ChunkStreamer    ──── encoded chunks ───► WorldMirror   decodes and stores
  BlockService     ◄─── break / place ──── BlockTool      raycasts the grid
  InventoryService ◄─── slot clicks ─────  InventoryUI    draws, never decides
  DropService          item entities        ChunkMesher   merges blocks to boxes
  PersistenceService   datastore            ChunkRenderer draws them as parts
```

Terrain exists as parts **only on each client**. That sounds wrong for
collision, until you remember Roblox simulates a player's character on that
player's own machine: the blocks they see are the blocks they stand on. The
server keeps the block data and validates every change, so nothing is trusted
to the client except its own rendering.

## Chunks

The world is 16 x 64 x 16 chunks, one byte per block in a `buffer` — 16 KiB
each. A Luau table of 16,384 numbers would cost megabytes per chunk; the buffer
costs exactly 16,384 bytes and serialises directly.

Chunks are never saved wholesale. Generation is a pure function of the seed and
the coordinates, so only the blocks a *player* changed need storing: `Chunk`
records those in an `edits` table, and loading a chunk means regenerating it and
replaying the edits.

**On the wire**, a chunk is run-length encoded with varint run lengths. Terrain
is long runs of the same block, so a generated chunk goes from 16,384 bytes to
about 1,700 — a measured 9:1, checked by the test suite.

## Meshing

Drawing one part per block would be 16,384 parts per chunk. `ChunkMesher` does
two things about that:

1. **Cull the hidden.** A block whose six neighbours are all opaque is never
   drawn. Underground, that is nearly everything — a solid 6³ cube meshes as its
   152-block shell and nothing else.
2. **Merge the rest.** What survives is grown greedily into boxes: along X, then
   Z, then Y, for as long as every block in the slab is the same type and also
   visible.

A generated chunk comes out as roughly 300 parts. `ChunkRenderer` builds them on
a 6 ms-per-frame budget from a part pool, so walking around does not allocate.

## Interaction

Aiming does **not** cast at parts — the mesher merged many blocks into one part,
so a part hit says nothing about which block was hit. `VoxelRaycast` walks the
grid cell by cell (Amanatides and Woo), returning the block hit, the face
normal, and the cell in front of it for placing.

Breaking is two messages: `BreakStart` when the button goes down, `BreakBlock`
when the client thinks it is done. The server times the gap against the block's
hardness and the held tool, and rejects anything faster than it should be —
sending the block back to that client to undo the prediction.

Placing checks reach, that the target cell is free, and that no player is
standing in it.

## Inventory and crafting

`Inventory` holds the slots and implements the click rules (left click takes or
places a whole stack, right click splits or places one, same-item clicks merge,
different-item clicks swap). The server owns one per player; the client keeps a
replica it only ever *draws*. Every click is a remote call, and the panel
redraws from the reply, so the UI cannot disagree with what the player owns.

Recipes are shaped or shapeless. Shaped ones match anywhere in the 3x3 grid: the
bounding box of what the player placed is compared against the pattern, so a
2x2 recipe works in any corner.

## Persistence

`PersistenceService` wraps the datastore with retries and, if datastores are
unavailable (Studio without API access), falls back to memory so the game still
runs. Player inventories save on leave, on shutdown, and every two minutes;
chunk edits save when a chunk unloads and on the same autosave tick.

## Files

| Module | Does |
| ------ | ---- |
| `shared/WorldConfig` | Every tunable number |
| `shared/Coordinates` | World, voxel and chunk space conversions |
| `shared/Chunk` | Block storage, edits, height map |
| `shared/ChunkCodec` | Run-length codec for the wire and the datastore |
| `shared/TerrainGenerator` | Biomes, height, caves, ore veins, trees |
| `shared/BlockRegistry` | Block types and their properties |
| `shared/ItemRegistry` | Items, tools, break times, harvest tiers |
| `shared/Inventory` | Slots, stacking, click semantics |
| `shared/Recipes` | Crafting recipes and the grid matcher |
| `shared/VoxelRaycast` | Grid traversal for aiming |
| `shared/Remotes` | The whole client/server protocol |
| `shared/Signal` | Lightweight events without argument copying |
| `server/WorldService` | The authoritative world |
| `server/ChunkStreamer` | Who has which chunks |
| `server/BlockService` | Validated breaking and placing |
| `server/InventoryService` | Inventories, hotbar, crafting |
| `server/DropService` | Dropped items and pickup |
| `server/PersistenceService` | Datastores, with a memory fallback |
| `server/DayNightService` | The day cycle |
| `client/WorldMirror` | The client's copy of the world |
| `client/ChunkMesher` | Culling and greedy box merging |
| `client/ChunkRenderer` | Parts, pooled and budgeted |
| `client/BlockTool` | Aiming, breaking, placing |
| `client/InventoryClient` | The replica of the server's inventory |
| `client/InventoryUI` | The inventory window |
| `client/Hud` | Crosshair, hotbar, notices, F3 debug |
| `client/UiKit` | Shared widgets |

## Controls

| Input | Action |
| ----- | ------ |
| Left click (hold) | Break the block you are looking at |
| Right click | Place the selected block |
| 1-9, mouse wheel | Choose a hotbar slot |
| E | Open and close the inventory |
| Shift + click | Move a whole stack |
| Right click (in inventory) | Split a stack, or place one item |
| Q | Drop the selected stack |
| F3 | Position, chunk and render stats |

## Tests

```bash
npm test
```

`test/game.test.js` bundles the pure modules with a stub of the Roblox API and
runs them under the standalone [Luau](https://github.com/luau-lang/luau/releases)
interpreter — 95 assertions covering coordinates, chunk storage, the codec,
terrain determinism, meshing (coverage, no overlaps, culling), raycasting, break
times and harvest tiers, inventory click rules, and recipe matching. If `luau`
is not installed the suite says so and skips; the bridge tests still run.
