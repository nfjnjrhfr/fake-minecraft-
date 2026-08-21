# The Roblox Studio bridge

This repository syncs into Roblox Studio over a small local bridge, so the
game's code can live in git and be edited in any editor.

```
   your editor            bridge server                 Roblox Studio
   ───────────            ─────────────                 ─────────────
   src/**/*.luau  ──────► node server/bridge.js  ──────► plugin ──► DataModel
                          (watches, long polls)  ◄────── plugin ◄── your Studio edits
```

## Setup, once

1. Install the plugin into Studio:

   ```bash
   npm run install-plugin
   ```

   That copies `plugin/RobloxStudioBridge.server.luau` into the local Roblox
   Studio plugins folder. Studio loads it right away. If the script cannot
   work out the folder for your system, copy the file there yourself:

   | System  | Plugins folder                              |
   | ------- | ------------------------------------------- |
   | Windows | `%LOCALAPPDATA%\Roblox\Plugins`             |
   | macOS   | `~/Documents/Roblox/Plugins`                |

2. In Studio, open the **Plugins** tab and click **Bridge**. A panel opens on
   the right.

## Everyday use

```bash
npm run serve          # or: node server/bridge.js serve
```

Then click **Connect** in the Bridge panel. Studio now mirrors `src/` and keeps
mirroring it: save a file, and the change lands in the DataModel a moment later.

| Button                      | What it does                                                     |
| --------------------------- | ---------------------------------------------------------------- |
| Connect / Disconnect        | Starts or stops watching the server.                             |
| Sync now                    | Forces a full re-sync, without waiting for a file change.        |
| Pull Studio edits to disk   | Writes the source of every synced script back into `src/`.       |

The bridge never touches instances it did not create. Every instance it manages
carries a `RobloxStudioBridge` attribute; anything without that attribute is
left exactly as you built it, and the plugin logs a warning instead of
overwriting it.

## How files map onto instances

`bridge.project.json` maps directories onto places in the DataModel:

```json
{
  "name": "fake-minecraft",
  "servePort": 34873,
  "tree": {
    "ReplicatedStorage/FakeMinecraft": "src/shared",
    "ServerScriptService/FakeMinecraft": "src/server",
    "StarterPlayer/StarterPlayerScripts/FakeMinecraft": "src/client"
  }
}
```

Inside a mapped directory:

| On disk               | In Studio                       |
| --------------------- | ------------------------------- |
| `Foo.luau`            | `ModuleScript` named `Foo`      |
| `Foo.server.luau`     | `Script` named `Foo`            |
| `Foo.client.luau`     | `LocalScript` named `Foo`       |
| `bar/` (a directory)  | `Folder` named `bar`            |
| `bar/init.luau`       | `bar` becomes a `ModuleScript`  |
| `bar/init.server.luau`| `bar` becomes a `Script`        |
| `bar/init.client.luau`| `bar` becomes a `LocalScript`   |

`.lua` works everywhere `.luau` does. Files with any other extension are
ignored, and deleting a file deletes the instance it created.

## Server API

The plugin is just one client of a plain HTTP API on `127.0.0.1`, so anything
else — a build script, an editor extension, another agent — can drive Studio
the same way.

| Endpoint                  | Purpose                                                                   |
| ------------------------- | ------------------------------------------------------------------------- |
| `GET /api/info`           | Handshake: protocol version, project name, current revision.              |
| `GET /api/snapshot`       | The full instance list, parents before children.                          |
| `GET /api/poll?since=N`   | Long poll. Blocks up to 25s, returns a snapshot as soon as `N` is stale.  |
| `POST /api/pull`          | `{ files: [{ relPath, source }] }` — writes Studio's edits back to disk.  |
| `POST /api/log`           | `{ level, message }` — prints a line from Studio in the server terminal.  |

`POST /api/pull` only accepts paths that are already part of the current
snapshot, so Studio cannot write outside the mapped directories.

For a one-off export without running a server:

```bash
node server/bridge.js build --output build/snapshot.json
```

## Checking it still works

```bash
npm test
```

That boots a real server on port 34899 and drives it the way the plugin does:
mapping rules, long polling, pull-back, deletion, and the path checks that stop
a pull from escaping the project.

## Troubleshooting

**"Could not reach http://localhost:34873"** — the server is not running, or it
is on another port. Start it with `npm run serve`, and make sure the URL in the
panel matches the port the server printed.

**Nothing happens when files change** — check the server terminal. Each rescan
prints a `rev N - M instances` line; if it does not, the file lives outside a
mapped directory or has an extension the bridge ignores.

**"… is not managed by the bridge - skipping"** — an instance of that name
already exists in the place file. Delete it in Studio (or rename it) and click
**Sync now**; the bridge will then create and own it.

**Port already in use** — another bridge is still running. Stop it, or start
this one with `--port 34874` and enter the matching URL in the panel.
