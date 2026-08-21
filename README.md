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
src/shared/           modules replicated to both sides
src/server/           world generation and block validation
src/client/           block tools and hotbar
test/                 end-to-end test of the bridge
```

## The game

`src/` holds a small voxel scaffold to sync: noise-generated terrain built out
of parts, seven block types, and left/right click to break and place blocks
with a hotbar on keys 1-7. The server owns the voxel data and validates every
edit — reach distance, block id, and whether the target cell is free — so the
client can only ask, never assert.

## Tests

```bash
npm test
```
