'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_PORT = 34873;

/**
 * Loads a `bridge.project.json` file and normalises it into the shape the rest
 * of the server works with.
 *
 * The `tree` field maps a Roblox instance path onto a directory on disk:
 *
 *   { "ReplicatedStorage/Shared": "src/shared" }
 */
function loadProject(projectPath) {
  const absolute = path.resolve(projectPath);
  let raw;

  try {
    raw = JSON.parse(fs.readFileSync(absolute, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`No project file at ${absolute}`);
    }
    throw new Error(`Could not parse ${absolute}: ${err.message}`);
  }

  const root = path.dirname(absolute);
  const tree = raw.tree || {};
  const mappings = Object.keys(tree).map((robloxPath) => {
    const parts = robloxPath.split('/').map((part) => part.trim()).filter(Boolean);
    if (parts.length === 0) {
      throw new Error(`Empty Roblox path in ${absolute}`);
    }

    const dir = path.resolve(root, tree[robloxPath]);
    if (!dir.startsWith(root + path.sep) && dir !== root) {
      throw new Error(`Path "${tree[robloxPath]}" escapes the project directory`);
    }

    return { robloxPath: parts, dir };
  });

  if (mappings.length === 0) {
    throw new Error(`Project ${absolute} has an empty "tree"`);
  }

  return {
    name: raw.name || path.basename(root),
    port: Number(raw.servePort) || DEFAULT_PORT,
    projectPath: absolute,
    root,
    mappings,
  };
}

module.exports = { loadProject, DEFAULT_PORT };
