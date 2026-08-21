#!/usr/bin/env node
// Runs the game's pure Luau modules under the standalone Luau interpreter.
//
// The modules expect to be ModuleScripts inside a Roblox DataModel, so this
// bundles them - prelude, then every module wrapped in a loader function, then
// the specs - into one script and hands it to `luau`.
//
// Run with: npm run test:game   (needs `luau` on PATH; skips if it is missing)

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_DIRS = ['src/shared', 'src/client', 'src/server'];
const OUTPUT = path.join(ROOT, 'build', 'game.test.bundle.luau');

// Modules that reach for a live DataModel and cannot run headless.
const SKIP = new Set(['Remotes', 'WorldService', 'ChunkStreamer', 'BlockService',
  'InventoryService', 'DropService', 'PersistenceService', 'DayNightService',
  'ChunkRenderer', 'BlockTool', 'Hud', 'InventoryUI', 'InventoryClient', 'UiKit', 'WorldMirror']);

function collectModules() {
  const modules = [];

  for (const dir of SOURCE_DIRS) {
    const full = path.join(ROOT, dir);
    if (!fs.existsSync(full)) continue;

    for (const file of fs.readdirSync(full).sort()) {
      if (!file.endsWith('.luau') || file.startsWith('init.')) continue;

      const name = file.replace(/\.luau$/, '');
      if (SKIP.has(name)) continue;

      modules.push({ name, source: fs.readFileSync(path.join(full, file), 'utf8') });
    }
  }

  return modules;
}

function bundle(modules) {
  const parts = [fs.readFileSync(path.join(__dirname, 'luau/prelude.luau'), 'utf8')];

  for (const { name, source } of modules) {
    // `export type` is only legal at the top level of a real module; inside the
    // loader function it has to be a plain type alias.
    const body = source.replace(/^export type/gm, 'type');
    parts.push(`__registerModule("${name}", function(script)\n${body}\nend)`);
  }

  parts.push(fs.readFileSync(path.join(__dirname, 'luau/specs.luau'), 'utf8'));
  return parts.join('\n\n');
}

function main() {
  const luau = process.env.LUAU_BIN || 'luau';
  const probe = spawnSync(luau, ['--version'], { encoding: 'utf8' });

  if (probe.error) {
    console.log('luau is not installed - skipping the game logic tests.');
    console.log('Get it from https://github.com/luau-lang/luau/releases, or set LUAU_BIN.');
    return;
  }

  const modules = collectModules();
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, bundle(modules), 'utf8');
  console.log(`bundled ${modules.length} modules -> ${path.relative(ROOT, OUTPUT)}`);

  const result = spawnSync(luau, [OUTPUT], { stdio: 'inherit' });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

main();
