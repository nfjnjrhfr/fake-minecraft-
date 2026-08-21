#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { URL } = require('url');

const { loadProject } = require('./lib/project');
const { buildSnapshot } = require('./lib/snapshot');
const { Watcher } = require('./lib/watcher');

const PROTOCOL_VERSION = 1;
const LONG_POLL_TIMEOUT_MS = 25000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;

function log(message) {
  const now = new Date().toTimeString().slice(0, 8);
  process.stdout.write('[' + now + '] ' + message + require('os').EOL);
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

class BridgeServer {
  constructor(project) {
    this.project = project;
    this.revision = 0;
    this.snapshot = { nodes: [], warnings: [], byRelPath: new Map() };
    this.waiters = new Set();
    this.watcher = new Watcher(
      project.mappings.map((mapping) => mapping.dir),
      () => this.refresh('files changed on disk')
    );
  }

  start() {
    this.refresh('initial scan');
    this.watcher.start();

    this.httpServer = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        sendJson(res, 500, { error: err.message });
      });
    });

    this.httpServer.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        log('Port ' + this.project.port + ' is already in use. Is another bridge running?');
        process.exit(1);
      }
      throw err;
    });

    this.httpServer.listen(this.project.port, '127.0.0.1', () => {
      log('Bridge for "' + this.project.name + '" listening on http://localhost:' + this.project.port);
      log('Open Roblox Studio, click Plugins > Bridge > Connect, and start editing.');
    });
  }

  refresh(reason) {
    const snapshot = buildSnapshot(this.project);
    this.snapshot = snapshot;
    this.revision += 1;

    for (const warning of snapshot.warnings) {
      log('warning: ' + warning);
    }
    log('rev ' + this.revision + ' - ' + snapshot.nodes.length + ' instances (' + reason + ')');

    this.flushWaiters();
  }

  flushWaiters() {
    for (const waiter of Array.from(this.waiters)) {
      this.waiters.delete(waiter);
      clearTimeout(waiter.timer);
      sendJson(waiter.res, 200, this.snapshotPayload());
    }
  }

  snapshotPayload() {
    return {
      protocolVersion: PROTOCOL_VERSION,
      projectName: this.project.name,
      revision: this.revision,
      nodes: this.snapshot.nodes,
    };
  }

  async handle(req, res) {
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/api/info') {
      sendJson(res, 200, {
        protocolVersion: PROTOCOL_VERSION,
        projectName: this.project.name,
        revision: this.revision,
        instanceCount: this.snapshot.nodes.length,
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/snapshot') {
      sendJson(res, 200, this.snapshotPayload());
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/poll') {
      this.handlePoll(url, res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/pull') {
      await this.handlePull(req, res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/log') {
      await this.handleLog(req, res);
      return;
    }

    sendJson(res, 404, { error: 'Unknown endpoint ' + req.method + ' ' + url.pathname });
  }

  handlePoll(url, res) {
    const since = Number(url.searchParams.get('since') || 0);
    if (since !== this.revision) {
      sendJson(res, 200, this.snapshotPayload());
      return;
    }

    const waiter = { res, timer: null };
    waiter.timer = setTimeout(() => {
      this.waiters.delete(waiter);
      sendJson(res, 200, { protocolVersion: PROTOCOL_VERSION, revision: this.revision, unchanged: true });
    }, LONG_POLL_TIMEOUT_MS);

    res.on('close', () => {
      this.waiters.delete(waiter);
      clearTimeout(waiter.timer);
    });

    this.waiters.add(waiter);
  }

  /** Studio -> disk. Only paths the bridge already syncs may be written. */
  async handlePull(req, res) {
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch (err) {
      sendJson(res, 400, { error: 'Invalid JSON body: ' + err.message });
      return;
    }

    const files = Array.isArray(payload && payload.files) ? payload.files : [];
    const written = [];
    const rejected = [];

    for (const file of files) {
      const relPath = String(file && file.relPath || '');
      const node = this.snapshot.byRelPath.get(relPath);

      if (!node) {
        rejected.push({ relPath, reason: 'not a file managed by this bridge' });
        continue;
      }

      const absolute = path.resolve(this.project.root, relPath);
      if (!absolute.startsWith(this.project.root + path.sep)) {
        rejected.push({ relPath, reason: 'path escapes the project directory' });
        continue;
      }

      const source = typeof file.source === 'string' ? file.source : '';
      if (source === node.source) {
        continue;
      }

      try {
        fs.writeFileSync(absolute, source, 'utf8');
        written.push(relPath);
      } catch (err) {
        rejected.push({ relPath, reason: err.message });
      }
    }

    for (const relPath of written) {
      log('pulled from Studio: ' + relPath);
    }
    for (const item of rejected) {
      log('refused pull of ' + item.relPath + ': ' + item.reason);
    }

    if (written.length > 0) {
      this.watcher.resync();
      this.refresh('pulled ' + written.length + ' file(s) from Studio');
    }

    sendJson(res, 200, { written, rejected, revision: this.revision });
  }

  async handleLog(req, res) {
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch (err) {
      sendJson(res, 400, { error: 'Invalid JSON body: ' + err.message });
      return;
    }

    const level = String(payload && payload.level || 'info');
    const message = String(payload && payload.message || '');
    log('studio/' + level + ': ' + message);
    sendJson(res, 200, { ok: true });
  }
}

function buildToDisk(project, outputPath) {
  const snapshot = buildSnapshot(project);
  for (const warning of snapshot.warnings) {
    log('warning: ' + warning);
  }

  const payload = {
    protocolVersion: PROTOCOL_VERSION,
    projectName: project.name,
    revision: 1,
    nodes: snapshot.nodes,
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2), 'utf8');
  log('Wrote ' + snapshot.nodes.length + ' instances to ' + outputPath);
}

function parseArgs(argv) {
  const args = { command: 'serve', project: 'bridge.project.json', output: 'build/snapshot.json', port: null };
  const rest = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--project' || arg === '-p') {
      args.project = argv[i += 1];
    } else if (arg === '--port') {
      args.port = Number(argv[i += 1]);
    } else if (arg === '--output' || arg === '-o') {
      args.output = argv[i += 1];
    } else if (arg === '--help' || arg === '-h') {
      args.command = 'help';
    } else {
      rest.push(arg);
    }
  }

  if (rest.length > 0 && args.command !== 'help') {
    args.command = rest[0];
  }
  return args;
}

function printHelp() {
  process.stdout.write([
    'Roblox Studio bridge',
    '',
    'Usage:',
    '  node server/bridge.js serve [--project bridge.project.json] [--port 34873]',
    '  node server/bridge.js build [--output build/snapshot.json]',
    '',
    'serve  Watch the mapped directories and stream changes to the Studio plugin.',
    'build  Write a one-off snapshot of the project as JSON.',
    '',
  ].join(require('os').EOL));
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === 'help') {
    printHelp();
    return;
  }

  let project;
  try {
    project = loadProject(args.project);
  } catch (err) {
    log(err.message);
    process.exit(1);
  }

  if (args.port) {
    project.port = args.port;
  }

  if (args.command === 'build') {
    buildToDisk(project, path.resolve(project.root, args.output));
    return;
  }

  if (args.command !== 'serve') {
    log('Unknown command "' + args.command + '"');
    printHelp();
    process.exit(1);
  }

  new BridgeServer(project).start();
}

if (require.main === module) {
  main();
}

module.exports = { BridgeServer, PROTOCOL_VERSION };
