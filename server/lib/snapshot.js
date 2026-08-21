'use strict';

const fs = require('fs');
const path = require('path');

const SCRIPT_EXTENSIONS = ['.luau', '.lua'];

/**
 * Turns a file name into the instance it represents.
 *   Foo.server.luau -> Script named "Foo"
 *   Foo.client.luau -> LocalScript named "Foo"
 *   Foo.luau        -> ModuleScript named "Foo"
 * Returns null for files the bridge does not sync.
 */
function classifyFile(fileName) {
  const ext = path.extname(fileName);
  if (!SCRIPT_EXTENSIONS.includes(ext)) {
    return null;
  }

  const stem = fileName.slice(0, -ext.length);
  if (stem.endsWith('.server')) {
    return { name: stem.slice(0, -'.server'.length), className: 'Script' };
  }
  if (stem.endsWith('.client')) {
    return { name: stem.slice(0, -'.client'.length), className: 'LocalScript' };
  }
  return { name: stem, className: 'ModuleScript' };
}

/** Finds the `init` file of a directory, which turns the folder into a script. */
function findInitFile(entries) {
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const classified = classifyFile(entry.name);
    if (classified && classified.name === 'init') {
      return { fileName: entry.name, className: classified.className };
    }
  }
  return null;
}

function readSource(filePath, warnings) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    warnings.push(`Could not read ${filePath}: ${err.message}`);
    return '';
  }
}

function walkDirectory(dir, robloxPath, ctx) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    ctx.warnings.push(`Could not read directory ${dir}: ${err.message}`);
    return;
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));

  const init = findInitFile(entries);
  if (init) {
    const filePath = path.join(dir, init.fileName);
    ctx.nodes.push({
      path: robloxPath,
      className: init.className,
      source: readSource(filePath, ctx.warnings),
      relPath: path.relative(ctx.root, filePath).split(path.sep).join('/'),
    });
  } else {
    ctx.nodes.push({ path: robloxPath, className: 'Folder' });
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) {
      continue;
    }

    if (entry.isDirectory()) {
      walkDirectory(path.join(dir, entry.name), robloxPath.concat(entry.name), ctx);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const classified = classifyFile(entry.name);
    if (!classified) {
      continue;
    }
    if (init && entry.name === init.fileName) {
      continue;
    }

    const filePath = path.join(dir, entry.name);
    ctx.nodes.push({
      path: robloxPath.concat(classified.name),
      className: classified.className,
      source: readSource(filePath, ctx.warnings),
      relPath: path.relative(ctx.root, filePath).split(path.sep).join('/'),
    });
  }
}

/**
 * Builds the full instance list the Studio plugin applies to the DataModel.
 * Parents always appear before their children, so the plugin can apply the
 * list in order without any extra sorting.
 */
function buildSnapshot(project) {
  const ctx = { nodes: [], warnings: [], root: project.root };
  const containers = new Set();

  for (const mapping of project.mappings) {
    // Ancestors of a mapped path (e.g. StarterPlayerScripts) must exist, but
    // the bridge never creates or owns them — it only reaches into them.
    for (let i = 1; i < mapping.robloxPath.length; i += 1) {
      containers.add(mapping.robloxPath.slice(0, i).join('/'));
    }

    if (!fs.existsSync(mapping.dir)) {
      ctx.warnings.push(`Mapped directory ${mapping.dir} does not exist`);
      continue;
    }

    walkDirectory(mapping.dir, mapping.robloxPath, ctx);
  }

  const seen = new Set();
  const nodes = ctx.nodes.filter((node) => {
    const key = node.path.join('/');
    if (containers.has(key) || seen.has(key)) {
      if (!containers.has(key)) {
        ctx.warnings.push(`Two files map onto the same instance: ${key}`);
      }
      return false;
    }
    seen.add(key);
    return true;
  });

  const byRelPath = new Map();
  for (const node of nodes) {
    if (node.relPath) {
      byRelPath.set(node.relPath, node);
    }
  }

  return { nodes, warnings: ctx.warnings, byRelPath };
}

module.exports = { buildSnapshot, classifyFile };
