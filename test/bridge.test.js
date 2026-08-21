#!/usr/bin/env node
// End-to-end test: drives a real bridge server the way the Studio plugin does.
// Run with: npm test
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BASE = 'http://127.0.0.1:34899';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (p) => (await fetch(BASE + p)).json();
const post = async (p, body) =>
  (await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();

(async () => {
  const server = spawn('node', ['server/bridge.js', 'serve', '--port', '34899'], { cwd: ROOT, stdio: 'inherit' });
  const fail = (msg) => { console.error('FAIL: ' + msg); server.kill(); process.exit(1); };
  await wait(700);

  const info = await get('/api/info');
  console.log('info:', JSON.stringify(info));
  if (info.protocolVersion !== 1) fail('bad protocol version');

  const snap = await get('/api/snapshot');
  const paths = snap.nodes.map((n) => n.path.join('/'));
  console.log('nodes:\n  ' + paths.join('\n  '));
  for (const expected of [
    'ReplicatedStorage/FakeMinecraft',
    'ReplicatedStorage/FakeMinecraft/Chunk',
    'ServerScriptService/FakeMinecraft',
    'StarterPlayer/StarterPlayerScripts/FakeMinecraft',
  ]) if (!paths.includes(expected)) fail('missing node ' + expected);

  if (paths.includes('StarterPlayer/StarterPlayerScripts')) fail('bridge should not own the container instance');
  const nested = snap.nodes.find((n) => n.path.join('/') === 'ServerScriptService/FakeMinecraft/WorldService');
  if (!nested || nested.className !== 'ModuleScript') fail('modules beside an init file should become its children');

  const serverNode = snap.nodes.find((n) => n.path.join('/') === 'ServerScriptService/FakeMinecraft');
  if (serverNode.className !== 'Script') fail('init.server.luau should map to a Script, got ' + serverNode.className);
  const clientNode = snap.nodes.find((n) => n.path.join('/') === 'StarterPlayer/StarterPlayerScripts/FakeMinecraft');
  if (clientNode.className !== 'LocalScript') fail('init.client.luau should map to a LocalScript');
  const moduleNode = snap.nodes.find((n) => n.path.join('/') === 'ReplicatedStorage/FakeMinecraft/Chunk');
  if (moduleNode.className !== 'ModuleScript') fail('shared module should be a ModuleScript');
  if (!moduleNode.source.includes('Chunk.new')) fail('module source not delivered');

  // Long poll must block while nothing changes, then fire on a file change.
  const started = Date.now();
  const pollPromise = get('/api/poll?since=' + snap.revision);
  await wait(400);
  const probe = path.join(ROOT, 'src/shared/Probe.luau');
  fs.writeFileSync(probe, 'return "hello from disk"\n');
  const polled = await pollPromise;
  const elapsed = Date.now() - started;
  console.log('poll returned rev', polled.revision, 'after', elapsed + 'ms');
  if (polled.revision <= snap.revision) fail('poll did not advance the revision');
  if (elapsed < 400) fail('poll returned before the file changed');
  const probeNode = polled.nodes.find((n) => n.path.join('/') === 'ReplicatedStorage/FakeMinecraft/Probe');
  if (!probeNode) fail('new file did not appear in the snapshot');

  // Pull: Studio-side edit is written back to disk.
  const pull = await post('/api/pull', { files: [{ relPath: probeNode.relPath, source: 'return "edited in Studio"\n' }] });
  console.log('pull:', JSON.stringify(pull));
  if (fs.readFileSync(probe, 'utf8').trim() !== 'return "edited in Studio"') fail('pull did not write to disk');

  // Pull must refuse anything outside the synced file set.
  const evil = await post('/api/pull', { files: [{ relPath: '../../etc/passwd', source: 'pwned' }, { relPath: 'README.md', source: 'pwned' }] });
  console.log('rejected:', JSON.stringify(evil.rejected));
  if (evil.written.length !== 0) fail('pull wrote a file outside the synced set');
  if (!fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').includes('#')) fail('README was clobbered');

  // Deleting a file removes the node.
  fs.unlinkSync(probe);
  await wait(700);
  const after = await get('/api/snapshot');
  if (after.nodes.some((n) => n.path.join('/').endsWith('/Probe'))) fail('deleted file still in snapshot');
  console.log('delete propagated, rev', after.revision);

  const logged = await post('/api/log', { level: 'warn', message: 'hello from the plugin' });
  if (!logged.ok) fail('log endpoint failed');

  const unknown = await fetch(BASE + '/api/nope');
  if (unknown.status !== 404) fail('unknown endpoint should 404');

  server.kill();
  console.log('\nALL CHECKS PASSED');
})().catch((err) => { console.error(err); process.exit(1); });
