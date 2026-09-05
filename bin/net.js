#!/usr/bin/env node
// The client for the simulated internet: dig, ping, traceroute, get, search,
// post and an interactive browser.

import readline from 'node:readline';
import { createWorld } from '../src/world.js';
import { Browser } from '../src/browser.js';
import { NetworkError } from '../src/host.js';
import { parseUrl } from '../src/url.js';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';

// Flags that never take a value, so `--trace get mine.net` still runs `get`.
const BOOLEAN_FLAGS = new Set(['trace', 'no-color', 'help']);

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const [key, inline] = arg.slice(2).split('=');
      if (inline !== undefined) flags[key] = inline;
      else if (BOOLEAN_FLAGS.has(key)) flags[key] = true;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[key] = argv[++i];
      else flags[key] = true;
    } else if (arg === '-c') {
      flags.count = argv[++i];
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

const { flags, positional } = parseArgs(process.argv.slice(2));
const command = positional[0] ?? 'help';
const args = positional.slice(1);

const color = Boolean(process.stdout.isTTY) && flags.color !== 'never' && !flags['no-color'];
const width = Number(flags.width ?? 76);
const paint = (code, text) => (color ? `${code}${text}${RESET}` : String(text));

const world = createWorld({
  seed: flags.seed ? Number(flags.seed) : undefined,
  lossScale: flags.loss !== undefined ? Number(flags.loss) : 1,
});
const { net } = world;
if (flags.trace) net.logging = true;

const client = world.net.nodes.get(String(flags.from ?? 'laptop'));
if (!client || client.kind !== 'host') {
  console.error(`no such client host: ${flags.from}. Try --from laptop or --from phone.`);
  process.exit(1);
}

const isIp = (text) => /^\d+\.\d+\.\d+\.\d+$/.test(text);

async function addressOf(target) {
  if (isIp(target)) return target;
  const hostname = target.includes('/') ? parseUrl(target).hostname : target;
  return client.resolve(hostname);
}

function printTrace() {
  if (!flags.trace) return;
  console.log(paint(DIM, `\n--- packet log (${net.log.length} events) ---`));
  for (const { time, event, ...rest } of net.log) {
    const detail = Object.entries(rest)
      .map(([key, value]) => `${key}=${value}`)
      .join(' ');
    console.log(paint(DIM, `${String(time).padStart(6)}ms  ${event.padEnd(16)} ${detail}`));
  }
  net.log = [];
}

function showPage(page, { header = true } = {}) {
  if (header) {
    console.log(
      paint(DIM, `${page.url}  ${paint(BOLD, page.status)} · ${page.ip} · ${page.ms}ms round trip`),
    );
    console.log(paint(DIM, '─'.repeat(width)));
  }
  console.log(page.text);
  if (page.links.length) {
    console.log(paint(DIM, '─'.repeat(width)));
    console.log(paint(DIM, `${page.links.length} links · type a number to follow one`));
  }
}

const commands = {
  async help() {
    console.log(`${paint(BOLD, 'net')} — a client for a simulated internet

  ${paint(CYAN, 'net demo')}                     take the tour
  ${paint(CYAN, 'net browse [url]')}             interactive browser (default: mine.net)
  ${paint(CYAN, 'net get <url>')}                fetch and render one page
  ${paint(CYAN, 'net search <words...>')}        query the search engine
  ${paint(CYAN, 'net post <thread> <who> <text>')} reply on the forum
  ${paint(CYAN, 'net dig <hostname>')}           ask the resolver for an address
  ${paint(CYAN, 'net ping <host|ip> [-c n]')}    echo probes with real round trips
  ${paint(CYAN, 'net traceroute <host|ip>')}     the path your packets take
  ${paint(CYAN, 'net map')}                      the topology and its link weather
  ${paint(CYAN, 'net sites')}                    what is hosted here

Options
  --from laptop|phone   which machine you are sitting at (default: laptop)
  --loss <scale>        multiply every link's loss rate (0 disables loss)
  --seed <n>            reseed the loss PRNG
  --trace               dump the packet log after the command
  --width <n>           render width (default 76)
  --no-color            plain text output`);
  },

  async sites() {
    console.log(paint(BOLD, 'hosted sites'));
    for (const site of world.sites) {
      const ip = net.hostnames.get(site.hostname);
      const host = net.byIp(ip);
      console.log(
        `  ${site.hostname.padEnd(20)} ${paint(DIM, ip.padEnd(12))} ${site.title.padEnd(22)} ${paint(
          DIM,
          `${host.name} @ ${host.location}`,
        )}`,
      );
    }
  },

  async map() {
    console.log(paint(BOLD, 'routers'));
    for (const node of net.nodes.values()) {
      if (node.kind !== 'router') continue;
      const neighbours = net
        .linksOf(node.name)
        .map((link) => `${link.other(node.name)}(${link.latency}ms)`)
        .join(' ');
      console.log(`  ${node.name.padEnd(12)} ${paint(DIM, node.ip.padEnd(10))} ${node.location.padEnd(16)} ${paint(DIM, neighbours)}`);
    }
    console.log(`\n${paint(BOLD, 'hosts')}`);
    for (const node of net.nodes.values()) {
      if (node.kind !== 'host') continue;
      const upstream = net.linksOf(node.name)[0];
      console.log(`  ${node.name.padEnd(12)} ${paint(DIM, node.ip.padEnd(10))} ${paint(DIM, `via ${upstream.other(node.name)}`)}`);
    }
    console.log(`\n${paint(BOLD, 'links')}`);
    for (const link of net.links) {
      console.log(
        `  ${`${link.a} ↔ ${link.b}`.padEnd(30)} ${String(`${link.latency}ms`).padStart(7)} ${paint(
          DIM,
          `${(link.loss * 100).toFixed(1)}% loss`,
        )}`,
      );
    }
  },

  async dig([name]) {
    if (!name) throw new Error('usage: net dig <hostname>');
    const answer = await net.settle(client.request(client.dnsIp, 53, { name }, { timeout: 800, retries: 4 }));
    console.log(`; resolver ${client.dnsIp} (${net.byIp(client.dnsIp).name})`);
    console.log(`${name.padEnd(24)} A   ${answer.ip ?? paint(DIM, 'NXDOMAIN')}`);
  },

  async ping([target]) {
    if (!target) throw new Error('usage: net ping <hostname|ip>');
    const ip = await net.settle(addressOf(target));
    const count = Number(flags.count ?? 4);
    console.log(`PING ${target} (${ip}) from ${client.name}`);

    const rtts = [];
    for (let i = 0; i < count; i++) {
      const reply = await net.settle(client.ping(ip));
      if (!reply) console.log(`  seq=${i} ${paint(DIM, 'timed out')}`);
      else {
        rtts.push(reply.rtt);
        console.log(`  seq=${i} from ${reply.from} time=${reply.rtt}ms${reply.type === 'echo-reply' ? '' : ` (${reply.type})`}`);
      }
    }

    const lost = count - rtts.length;
    const avg = rtts.length ? Math.round(rtts.reduce((a, b) => a + b, 0) / rtts.length) : 0;
    console.log(
      `--- ${count} sent, ${rtts.length} received, ${Math.round((lost / count) * 100)}% loss` +
        (rtts.length ? `, rtt min/avg/max = ${Math.min(...rtts)}/${avg}/${Math.max(...rtts)} ms` : ''),
    );
  },

  async traceroute([target]) {
    if (!target) throw new Error('usage: net traceroute <hostname|ip>');
    const ip = await net.settle(addressOf(target));
    console.log(`traceroute to ${target} (${ip}), 20 hops max`);
    const hops = await net.settle(client.traceroute(ip));
    for (const hop of hops) {
      console.log(
        `  ${String(hop.ttl).padStart(2)}  ${hop.name.padEnd(14)} ${paint(DIM, (hop.ip ?? '').padEnd(12))} ${
          hop.rtt === null ? '*' : `${hop.rtt}ms`
        }`,
      );
    }
  },

  async get([url]) {
    if (!url) throw new Error('usage: net get <url>');
    const browser = new Browser(client, { width, color });
    const page = await net.settle(browser.load(url));
    showPage(page);
  },

  async search(words) {
    if (!words.length) throw new Error('usage: net search <words...>');
    const query = words.join(' ');
    const browser = new Browser(client, { width, color });
    const page = await net.settle(browser.load(`search.mine.net/?q=${encodeURIComponent(query)}`));
    showPage(page);
  },

  async post([thread, author, ...rest]) {
    if (!thread || !rest.length) throw new Error('usage: net post <thread-id> <author> <text...>');
    const browser = new Browser(client, { width, color });
    const page = await net.settle(
      browser.load(`forum.mine.net/threads/${thread}`, {
        method: 'POST',
        body: { author: author ?? 'anonymous', text: rest.join(' ') },
      }),
    );
    showPage(page);
  },

  async demo() {
    const browser = new Browser(client, { width, color });
    const step = (text) => console.log(`\n${paint(BOLD, `▸ ${text}`)}\n`);

    step(`you are on ${client.name} (${client.ip}) in ${client.location}`);
    await commands.dig(['www.mine.net']);

    step('how far away is the front page?');
    await commands.traceroute(['www.mine.net']);

    step('open it');
    showPage(await net.settle(browser.load('mine.net')));

    step('search for something');
    showPage(await net.settle(browser.load('search.mine.net/?q=creeper+cat')));

    step('follow the first result');
    showPage(await net.settle(browser.follow(1)));

    step('and the network under all of that');
    showPage(await net.settle(browser.load('status.mine.net')));

    console.log(`\n${paint(DIM, 'Now try: net browse')}`);
  },

  async browse([url]) {
    const browser = new Browser(client, { width, color });
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    // Read lines ourselves rather than with rl.question: piped input reaches
    // EOF long before the first page has finished loading.
    const queued = [];
    let waiting = null;
    let closed = false;
    rl.on('line', (line) => {
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve(line);
      } else {
        queued.push(line);
      }
    });
    rl.on('close', () => {
      closed = true;
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve(null);
      }
    });
    const ask = (prompt) =>
      new Promise((resolve) => {
        if (queued.length) return resolve(queued.shift());
        if (closed) return resolve(null);
        process.stdout.write(prompt);
        waiting = resolve;
      });

    console.log(paint(DIM, 'commands: <number> follow · b back · r reload · <url> open · q quit'));
    try {
      showPage(await net.settle(browser.load(url ?? 'mine.net')));
    } catch (error) {
      console.error(paint(DIM, String(error.message)));
    }

    for (;;) {
      const answer = await ask(paint(CYAN, '\nnet> '));
      if (answer === null) break;
      const input = answer.trim();
      if (!input) continue;
      if (input === 'q' || input === 'quit' || input === 'exit') break;

      try {
        if (input === 'b' || input === 'back') showPage(await net.settle(browser.back()));
        else if (input === 'r' || input === 'reload') showPage(await net.settle(browser.reload()));
        else if (/^\d+$/.test(input)) showPage(await net.settle(browser.follow(Number(input))));
        else if (input === 'links') {
          for (const link of browser.page?.links ?? []) console.log(`  [${link.index}] ${link.label} → ${link.href}`);
        } else showPage(await net.settle(browser.load(input)));
      } catch (error) {
        console.error(paint(DIM, error instanceof NetworkError ? `network: ${error.message}` : String(error.message)));
      }
    }
    rl.close();
  },
};

const handler = commands[command];
if (!handler) {
  console.error(`unknown command: ${command}`);
  await commands.help();
  process.exit(1);
}

try {
  await handler(args);
  printTrace();
} catch (error) {
  if (error instanceof NetworkError) console.error(`network: ${error.message}`);
  else console.error(String(error?.message ?? error));
  process.exit(1);
}
