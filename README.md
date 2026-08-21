# fake-minecraft

A voxel sandbox for Roblox, with a bridge that syncs this repository straight
into Roblox Studio.

## Quick start

```bash
npm run install-plugin   # copy the bridge plugin into Roblox Studio
npm run serve            # watch src/ and serve it to Studio
```

In Studio, open **Plugins → Bridge**, click **Connect**, and the contents of
`src/` appear in the DataModel. Save a file in your editor and Studio updates a
moment later; click **Pull Studio edits to disk** to send changes the other way.

Full setup, file-to-instance mapping rules and the HTTP API are in
[docs/BRIDGE.md](docs/BRIDGE.md).

## Layout

```
bridge.project.json   which directory maps to which place in the DataModel
server/               the bridge server (Node, no dependencies)
plugin/               the Roblox Studio plugin, one file
scripts/              plugin installer
src/shared/           world model, registries, protocol
src/server/           authoritative world, streaming, inventories, saves
src/client/           meshing, rendering, tools, interface
test/                 bridge end-to-end test, and the game logic suite
```

## The game

An endless voxel world: five biomes over noise terrain with caves, ore veins and
trees; twenty block types; mining with tools that matter; a 36-slot inventory
with a 3x3 crafting grid; dropped items; a day/night cycle; and datastore saves
of everything a player changed.

Chunks are 16 x 64 x 16, stored a byte per block and streamed to each client
run-length encoded — about 1.7 KB for a chunk of 16,384 blocks. The client
culls every hidden block and greedily merges the rest into boxes, so a chunk
draws as roughly 300 parts instead of 16,384. The server owns all block data and
validates every change, down to timing break speed against the held tool.

[docs/GAME.md](docs/GAME.md) is the architecture, module by module.

## Tests

```bash
npm test          # the bridge, end to end, plus the game logic suite
```

The game suite runs the pure Luau modules headlessly against a stub of the
Roblox API. It needs [luau](https://github.com/luau-lang/luau/releases) on your
PATH and skips itself politely if it is missing.
