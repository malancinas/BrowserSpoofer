#!/usr/bin/env node
// Open N isolated browser sessions, each routed through its own proxy / exit IP.
//
//   node src/index.js https://example.com            # 4 sessions (default)
//   node src/index.js https://example.com -n 5 --fresh
//   node src/index.js --check                        # test every proxy, open nothing

const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const tls = require('tls');
const { execFile, execFileSync } = require('child_process');

// Three fixes to Playwright, made as it loads. Sessions are told apart by their
// `baseURL` option, an inert per-session marker (see launchSession): all sessions send
// the same UA string, so that can't identify them.
// - Client hints: Playwright fills in Sec-CH-UA* headers and navigator.userAgentData by
//   guessing from the UA string (on a Mac: an Intel CPU, a "10_15_7" OS version, no
//   browser brands). The hook hands it the session's complete hints instead.
// - Accept-Language: Playwright's `locale` option overrides it, which makes Chrome send
//   the header in a different position (right after User-Agent instead of last) and as a
//   single language. The hook drops that part, so Chrome generates the header itself
//   from the profile's language list; `locale` still sets Intl.
// - Screen: with viewport: null Playwright skips screen emulation, so CSS media queries
//   (device-width/height) and window.screenX/Y report the real display. The hook has
//   Chrome emulate the session's screen size and window position natively, for every
//   top-level page before its scripts run, while the viewport keeps following the window.
// If a Playwright update moves any of these spots, the hook isn't installed and sessions
// aren't spoofed (with a warning).
const SESSION_OVERRIDES = new Map(); // baseURL marker -> { metadata, metrics }
let playwrightHooked = false;
{
  const Module = require('module');
  const loadJs = Module._extensions['.js'];
  const bundle = path.join('playwright-core', 'lib', 'coreBundle.js');
  const metadataMarker = 'function calculateUserAgentMetadata(options) {';
  const languageMarker = 'acceptLanguage: options.locale,'; // page and service worker overrides
  const viewportMarker = [
    '        assert(this._isMainFrame());',
    '        const options = this._crPage._browserContext._options;',
    '        const emulatedSize = this._page.emulatedSize();',
  ].join('\n');
  Module._extensions['.js'] = function (module, filename) {
    if (!filename.endsWith(bundle)) return loadJs(module, filename);
    let src = fs.readFileSync(filename, 'utf8');
    const count = marker => src.split(marker).length - 1;
    if (count(metadataMarker) === 1 && count(languageMarker) === 2 && count(viewportMarker) === 1) {
      const lookup = 'globalThis.__browserSpoofer?.get(options.baseURL)';
      src = src.replace(metadataMarker, `${metadataMarker}\n  const spoofed = ${lookup};\n  if (spoofed) return spoofed.metadata;`);
      src = src.replaceAll(languageMarker, `acceptLanguage: ${lookup} ? undefined : options.locale,`);
      src = src.replace(viewportMarker, viewportMarker.replace('        const emulatedSize', [
        `        const spoofed = ${lookup};`,
        '        if (spoofed) {',
        '          await this._client.send("Emulation.setDeviceMetricsOverride", spoofed.metrics);',
        '          return;',
        '        }',
        '        const emulatedSize',
      ].join('\n')));
      globalThis.__browserSpoofer = SESSION_OVERRIDES;
      playwrightHooked = true;
    }
    module._compile(src, filename);
  };
}
const { chromium, request } = require('playwright');

const ROOT = path.resolve(__dirname, '..');

// ---------- CLI ----------

function parseArgs(argv) {
  const opts = {
    url: null,
    count: 4,
    proxies: path.join(ROOT, 'proxies.txt'),
    profiles: path.join(ROOT, 'profiles'),
    headless: false,
    fresh: false,
    allowDuplicateIps: false,
    check: false,
    installBrowsers: null,
    alert: true,
    uniform: false,
    noise: true,
    screenW: 1920,
    screenH: 1080,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '-n' || a === '--count') opts.count = parseInt(next(), 10);
    else if (a === '-p' || a === '--proxies') opts.proxies = path.resolve(next());
    else if (a === '--profiles') opts.profiles = path.resolve(next());
    else if (a === '--headless') opts.headless = true;
    else if (a === '--fresh') opts.fresh = true;
    else if (a === '--allow-duplicate-ips') opts.allowDuplicateIps = true;
    else if (a === '--check') opts.check = true;
    else if (a === '--install-browsers') {
      opts.installBrowsers = argv[i + 1] && /^[\d,]+$/.test(argv[i + 1]) ? next().split(',') : ['155', '152', '151'];
    }
    else if (a === '--no-alert') opts.alert = false;
    else if (a === '--uniform') opts.uniform = true;
    else if (a === '--no-noise') opts.noise = false;
    else if (a === '--screen') [opts.screenW, opts.screenH] = next().split('x').map(Number);
    else if (a === '-h' || a === '--help') usage(0);
    else if (!a.startsWith('-') && !opts.url) opts.url = a;
    else { console.error(`Unknown argument: ${a}`); usage(1); }
  }
  if (opts.check || opts.installBrowsers) return opts;
  if (!opts.url) usage(1);
  if (!/^https?:\/\//i.test(opts.url)) opts.url = `https://${opts.url}`;
  if (!Number.isInteger(opts.count) || opts.count < 1) {
    console.error('--count must be a positive integer'); process.exit(1);
  }
  return opts;
}

function usage(code) {
  console.log(`Usage: node src/index.js <url> [options]
       node src/index.js --check
       node src/index.js --install-browsers [155,152,151]

Options:
  -n, --count <N>          Number of isolated sessions (default 4)
  -p, --proxies <file>     Proxy list file (default ./proxies.txt)
      --profiles <dir>     Where per-session profiles are stored (default ./profiles)
      --fresh              Wipe each session's profile before launching
      --headless           Run without visible windows
      --screen <WxH>       Screen size used to tile windows (default 1920x1080)
      --allow-duplicate-ips  Launch even if two sessions share an exit IP
      --check              Test every proxy in the list and report; opens no windows
      --install-browsers [majors]
                           Download official Chrome builds of these major versions into
                           ./browsers, so sessions can run on different Chrome versions
      --no-alert           Don't notify when a window moves to a new page
      --uniform            Same default look in every window (no dark/large-text/zoom variants)
      --no-noise           No canvas/WebGL/audio variation: show this Mac's real rendering
  -h, --help               Show this help`);
  process.exit(code);
}

// ---------- Proxies ----------

// proxies.txt: one proxy per line, e.g.
//   http://user:pass@1.2.3.4:8080
//   socks5://5.6.7.8:1080
// A single line containing {n} is treated as a template for rotating-gateway
// providers and expanded once per session (n = 1..count).
// ${VAR} is replaced with the (URL-encoded) value of VAR from .env / the environment,
// so credentials live in one place: https://${NORD_USER}:${NORD_PASS}@host:89
// With all=true every proxy is returned (used by --check) instead of a random subset.
function loadProxies(file, count, all = false) {
  if (!fs.existsSync(file)) {
    throw new Error(`Proxy file not found: ${file}\nCopy proxies.example.txt to proxies.txt and add your proxies.`);
  }
  const lines = fs.readFileSync(file, 'utf8')
    .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
    .map(expandEnv);

  if (lines.length === 1 && lines[0].includes('{n}')) {
    return Array.from({ length: count }, (_, i) => lines[0].replaceAll('{n}', String(i + 1)));
  }
  if (all) return lines;
  if (lines.length < count) {
    throw new Error(`Need ${count} proxies for ${count} isolated IPs, but ${file} has ${lines.length}.`);
  }
  return shuffle(lines).slice(0, count);
}

function expandEnv(line) {
  return line.replace(/\$\{(\w+)\}/g, (_, name) => {
    const v = process.env[name];
    if (!v) throw new Error(`${name} is not set. Add it to ${path.join(ROOT, '.env')} (see .env.example).`);
    return encodeURIComponent(v);
  });
}

// Minimal .env loader: KEY=value lines; existing environment variables win.
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = raw.match(/^\s*([A-Za-z_]\w*)\s*=\s*(.*?)\s*$/);
    if (!m || raw.trim().startsWith('#')) continue;
    const val = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
}

// Fisher-Yates, so each run picks a random subset of the proxy list.
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Playwright wants credentials split out of the server URL.
function toPlaywrightProxy(proxyUrl) {
  const u = new URL(proxyUrl.includes('://') ? proxyUrl : `http://${proxyUrl}`);
  const proxy = { server: `${u.protocol}//${u.hostname}:${u.port}` };
  if (u.username) proxy.username = decodeURIComponent(u.username);
  if (u.password) proxy.password = decodeURIComponent(u.password);
  return proxy;
}

// When Playwright handles proxy credentials it intercepts every request to answer the
// auth challenge, and that switches Chrome's cache off: every request then carries
// `Pragma: no-cache` and `Cache-Control: no-cache`, which real Chrome only sends on a
// forced reload. So an authenticated proxy is put behind a local relay instead: Chrome
// talks to the relay with no credentials (no interception, normal caching and headers)
// and the relay adds Proxy-Authorization on its way to the real proxy. Listens on
// 127.0.0.1 only. Proxies without credentials are used directly.
function startProxyRelay(proxy) {
  if (!proxy.username || !/^https?:$/.test(new URL(proxy.server).protocol)) return Promise.resolve(proxy);
  const up = new URL(proxy.server);
  const upPort = Number(up.port) || (up.protocol === 'https:' ? 443 : 80);
  const auth = 'Basic ' + Buffer.from(`${proxy.username}:${proxy.password || ''}`).toString('base64');
  const connectUpstream = () => (up.protocol === 'https:'
    ? tls.connect({ host: up.hostname, port: upPort, servername: up.hostname })
    : net.connect({ host: up.hostname, port: upPort }));

  const server = http.createServer((req, res) => {
    // Plain-http request (absolute URL): forward it to the real proxy with the
    // credentials added, keeping the browser's header names and order.
    const raw = [];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (req.rawHeaders[i].toLowerCase() !== 'proxy-authorization') raw.push(req.rawHeaders[i], req.rawHeaders[i + 1]);
    }
    const upstream = (up.protocol === 'https:' ? require('https') : http).request({
      host: up.hostname, port: upPort, servername: up.hostname, method: req.method, path: req.url,
      headers: [...raw, 'Proxy-Authorization', auth], agent: false,
    }, upRes => {
      res.writeHead(upRes.statusCode, upRes.statusMessage, upRes.rawHeaders);
      upRes.pipe(res);
    });
    upstream.on('error', () => res.destroy());
    req.pipe(upstream);
  });
  // HTTPS and WebSocket traffic: tunnel through the real proxy's CONNECT.
  server.on('connect', (req, client, head) => {
    const upstream = connectUpstream();
    const fail = () => { client.destroy(); upstream.destroy(); };
    upstream.on('error', fail);
    client.on('error', fail);
    upstream.write(`CONNECT ${req.url} HTTP/1.1\r\nHost: ${req.url}\r\nProxy-Authorization: ${auth}\r\n\r\n`);
    let buf = Buffer.alloc(0);
    const onData = chunk => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      upstream.off('data', onData);
      const status = buf.subarray(0, buf.indexOf('\r\n')).toString();
      if (!/^HTTP\/1\.[01] 200/.test(status)) {
        client.end(`${status.replace(/^HTTP\/1\.[01]/, 'HTTP/1.1')}\r\n\r\n`);
        return upstream.destroy();
      }
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      const rest = buf.subarray(end + 4);
      if (rest.length) client.write(rest);
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    };
    upstream.on('data', onData);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () =>
    resolve({ server: `http://127.0.0.1:${server.address().port}` })));
}

// ---------- Exit-IP lookup ----------

// Ask a geo-IP service *through the proxy* which IP the outside world sees.
async function lookupExitIp(proxy) {
  const ctx = await request.newContext({ proxy, timeout: 20000, ignoreHTTPSErrors: true });
  const getJson = async url => {
    const res = await ctx.get(url);
    if (res.status() === 407) throw new Error('proxy rejected the username/password (407) - check your credentials');
    if (!res.ok()) throw new Error(`HTTP ${res.status()} from ${url}`);
    return res.json();
  };
  try {
    const endpoints = [
      async () => {
        const j = await getJson('https://ipinfo.io/json');
        return { ip: j.ip, country: j.country, city: j.city, timezone: j.timezone };
      },
      // Plain HTTP, so a 407 from the proxy surfaces as a status rather than a vague "aborted".
      async () => {
        const j = await getJson('http://ip-api.com/json');
        return { ip: j.query, country: j.countryCode, city: j.city, timezone: j.timezone };
      },
    ];
    let lastErr;
    for (const fn of endpoints) {
      try {
        const info = await fn();
        if (info.ip) return info;
      } catch (e) { lastErr = e; }
    }
    if (lastErr && /aborted/.test(lastErr.message)) {
      // Chromium's request stack reports a CONNECT 407 as a bare "aborted".
      throw new Error('proxy refused the connection - usually rejected credentials (407), '
        + 'or the provider rate-limiting logins; wait a while and retry');
    }
    throw lastErr || new Error('no IP returned');
  } finally {
    await ctx.dispose();
  }
}

// ---------- Per-session identity ----------

const COUNTRY_LOCALE = {
  US: 'en-US', GB: 'en-GB', CA: 'en-CA', AU: 'en-AU', NZ: 'en-NZ', IE: 'en-IE',
  DE: 'de-DE', AT: 'de-AT', CH: 'de-CH', FR: 'fr-FR', BE: 'fr-BE', ES: 'es-ES',
  MX: 'es-MX', AR: 'es-AR', IT: 'it-IT', NL: 'nl-NL', PT: 'pt-PT', BR: 'pt-BR',
  PL: 'pl-PL', SE: 'sv-SE', NO: 'nb-NO', DK: 'da-DK', FI: 'fi-FI', JP: 'ja-JP',
  KR: 'ko-KR', CN: 'zh-CN', TW: 'zh-TW', HK: 'zh-HK', TH: 'th-TH', VN: 'vi-VN',
  IN: 'en-IN', SG: 'en-SG', PH: 'en-PH', ID: 'id-ID', TR: 'tr-TR', RU: 'ru-RU',
  UA: 'uk-UA', ZA: 'en-ZA',
};

// The Mac each session presents as, by session index. Every value is one a real
// configuration of that model reports in Chrome:
// - Memory: navigator.deviceMemory and the Device-Memory header always carry this
//   machine's real RAM (16GB here; nothing can change the header), so every model is
//   one sold with 16-24GB, which Chrome rounds to 16. That rules out Max and Ultra
//   chips (36GB+).
// - Pixel density: devicePixelRatio is this Mac's real Retina value (2) and can't be
//   changed without blurring the window, so every display is a Retina one: built-in
//   screens, Apple displays, or a 4K monitor in a scaled ("looks like") mode.
// - Cores: navigator.hardwareConcurrency is the chip's real CPU core count. Apple
//   silicon Macs with 16-24GB only come in 8, 10, 11, 12 and 14 cores, so cores
//   repeat across sessions.
// - Screen: sizes are each display's default "looks like" resolution. The menu bar is
//   25px, or 37-39px on notched MacBooks (39 measured on this Mac at 1710x1112); the
//   Dock is 65px (measured) at the bottom or left, or hidden. Built-in and Apple
//   displays report 30-bit color, third-party 4K monitors 24-bit.
// - macOS: a release Apple has shipped (from `softwareupdate --list-full-installers`)
//   that the chip supports, mostly current patch levels.
// - Audio and media devices: MacBooks, the iMac and the Studio Display have a camera,
//   microphone and speakers; a Mac mini on a plain 4K monitor has only its speaker.
//   sampleRate is the output device's rate (48kHz for built-in and display speakers,
//   44.1kHz for the Mac minis' external speakers).
const MACS = [
  { name: 'MacBook Air 13" M2', chip: 'M2', cores: 8, laptop: true, macos: '26.7.1',
    sampleRate: 48000, mic: true, camera: true,
    screen: { width: 1470, height: 956, availLeft: 0, availTop: 37, availWidth: 1470, availHeight: 854, colorDepth: 30 } },
  { name: 'MacBook Pro 14" M3 Pro', chip: 'M3 Pro', cores: 11, laptop: true, macos: '27.0.1',
    sampleRate: 48000, mic: true, camera: true,
    screen: { width: 1512, height: 982, availLeft: 0, availTop: 38, availWidth: 1512, availHeight: 944, colorDepth: 30 } },
  { name: 'Mac mini M4 + 4K monitor', chip: 'M4', cores: 10, laptop: false, macos: '15.8.1',
    sampleRate: 44100, mic: false, camera: false,
    screen: { width: 1920, height: 1080, availLeft: 0, availTop: 25, availWidth: 1920, availHeight: 990, colorDepth: 24 } },
  { name: 'MacBook Pro 16" M1 Pro', chip: 'M1 Pro', cores: 10, laptop: true, macos: '26.6.2',
    sampleRate: 48000, mic: true, camera: true,
    screen: { width: 1728, height: 1117, availLeft: 65, availTop: 38, availWidth: 1663, availHeight: 1079, colorDepth: 30 } },
  { name: 'iMac 24" M3', chip: 'M3', cores: 8, laptop: false, macos: '15.8.0',
    sampleRate: 48000, mic: true, camera: true,
    screen: { width: 2240, height: 1260, availLeft: 0, availTop: 25, availWidth: 2240, availHeight: 1170, colorDepth: 30 } },
  { name: 'MacBook Air 13" M4', chip: 'M4', cores: 10, laptop: true, macos: '27.0.0',
    sampleRate: 48000, mic: true, camera: true,
    screen: { width: 1470, height: 956, availLeft: 0, availTop: 37, availWidth: 1470, availHeight: 919, colorDepth: 30 } },
  { name: 'Mac mini M4 Pro + Studio Display', chip: 'M4 Pro', cores: 14, laptop: false, macos: '26.7.0',
    sampleRate: 48000, mic: true, camera: true,
    screen: { width: 2560, height: 1440, availLeft: 0, availTop: 25, availWidth: 2560, availHeight: 1350, colorDepth: 30 } },
  { name: 'MacBook Pro 14" M2 Pro', chip: 'M2 Pro', cores: 12, laptop: true, macos: '14.8.9',
    sampleRate: 48000, mic: true, camera: true,
    screen: { width: 1512, height: 982, availLeft: 0, availTop: 38, availWidth: 1512, availHeight: 879, colorDepth: 30 } },
  { name: 'MacBook Air 15" M3', chip: 'M3', cores: 8, laptop: true, macos: '27.0.1',
    sampleRate: 48000, mic: true, camera: true,
    screen: { width: 1710, height: 1112, availLeft: 0, availTop: 39, availWidth: 1710, availHeight: 1008, colorDepth: 30 } },
  { name: 'Mac mini M2 Pro + 4K monitor', chip: 'M2 Pro', cores: 12, laptop: false, macos: '15.7.9',
    sampleRate: 44100, mic: false, camera: false,
    screen: { width: 2560, height: 1440, availLeft: 0, availTop: 25, availWidth: 2560, availHeight: 1415, colorDepth: 24 } },

];


// How each session renders pages, by session index, using only settings a real Chrome
// user can change, applied through the profile's own preferences so Chrome renders them
// natively: dark appearance, Settings > Appearance > Font size (Large = 20px), and the
// default page zoom (Chrome's 110% and 125% steps; zoom raises devicePixelRatio and
// shrinks the CSS viewport exactly as real zoom does).
const LOOKS = [
  { name: 'default' },
  { name: 'dark', dark: true },
  { name: 'large text', fontSize: 20 },
  { name: 'zoom 110%', zoom: 1.1 },
  { name: 'dark + zoom 110%', dark: true, zoom: 1.1 },
  { name: 'large text + zoom 110%', fontSize: 20, zoom: 1.1 },
  { name: 'dark + large text', dark: true, fontSize: 20 },
  { name: 'zoom 125%', zoom: 1.25 },

];

// Keyboard layouts, as navigator.keyboard.getLayoutMap() reports them on a Mac with
// this one's (ISO) keyboard. Generated with UCKeyTranslate from macOS's own layout data,
// the call Chrome makes; the same method reproduces this Mac's real map exactly. Keys
// a layout leaves blank aren't in the map. Letters, digits and the common punctuation
// keys are the same in both.
const KEYBOARD_LAYOUTS = {
  British: { Backquote: '`', Backslash: '\\', IntlBackslash: '§', IntlRo: '`', IntlYen: '§' },
  'U.S.': { Backquote: '`', Backslash: '\\', IntlBackslash: '§' }, // also macOS's "ABC"
};

// UK sessions mostly use the British layout and every third the U.S. one, as UK Mac
// owners do; elsewhere U.S. (layouts with dead keys aren't modelled).
function keyboardFor(index, locale) {
  const name = locale === 'en-GB' && index % 3 !== 2 ? 'British' : 'U.S.';
  const map = { ...KEYBOARD_LAYOUTS[name] };
  for (const c of 'abcdefghijklmnopqrstuvwxyz') map[`Key${c.toUpperCase()}`] = c;
  for (let d = 0; d < 10; d++) map[`Digit${d}`] = String(d);
  Object.assign(map, { BracketLeft: '[', BracketRight: ']', Comma: ',', Equal: '=', Minus: '-',
    Period: '.', Quote: "'", Semicolon: ';', Slash: '/' });
  return { name, map };
}

// Approximate Geekbench 6 single-core scores. A session claiming a chip slower than
// this Mac's is slowed down to that chip's speed (Chrome's CPU throttling), so script
// timing matches the claim; nothing can make a session faster than this Mac.
const CHIP_SPEED = { M1: 2350, 'M1 Pro': 2380, M2: 2600, 'M2 Pro': 2650, M3: 3050, 'M3 Pro': 3100, M4: 3700, 'M4 Pro': 3900 };
let hostChipCache;
function hostChip() {
  if (hostChipCache === undefined) {
    try {
      hostChipCache = execFileSync('sysctl', ['-n', 'machdep.cpu.brand_string'], { encoding: 'utf8' })
        .match(/Apple (M\d(?: Pro| Max| Ultra)?)/)[1];
    } catch { hostChipCache = null; }
  }
  return hostChipCache;
}
function cpuThrottleFor(chip) {
  const host = CHIP_SPEED[hostChip()];
  const claimed = CHIP_SPEED[chip];
  return host && claimed && claimed < host ? Math.round((host / claimed) * 100) / 100 : 1;
}

// ---------- Browser engines ----------
//
// Each session runs on a real Chrome build, and different sessions on different
// versions where possible: a real engine's UA, client hints, navigator properties,
// WebGL extensions and features all agree with each other, which no amount of patching
// one engine can achieve. Engines are Playwright's bundled Chromium, the installed
// Google Chrome, and official Chrome for Testing builds in ./browsers
// (--install-browsers). All are Chrome builds; Chrome for Testing just lacks the
// "Google Chrome" brand, which the client-hint override adds back.

const BROWSERS_DIR = path.join(ROOT, 'browsers');
const SYSTEM_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function versionOf(executable) {
  try {
    return execFileSync(executable, ['--version'], { encoding: 'utf8', timeout: 15000 }).match(/\d+\.\d+\.\d+\.\d+/)[0];
  } catch {
    return null;
  }
}

// Every usable engine, one per major version (a real Google Chrome wins over a
// Chrome for Testing build of the same major).
function findEngines() {
  const candidates = [{ path: SYSTEM_CHROME, kind: 'Google Chrome' }, { path: chromium.executablePath(), kind: 'bundled' }];
  try {
    for (const dir of fs.readdirSync(BROWSERS_DIR)) {
      candidates.push({ path: path.join(BROWSERS_DIR, dir, 'chrome-mac-arm64', 'Google Chrome for Testing.app',
        'Contents', 'MacOS', 'Google Chrome for Testing'), kind: 'Chrome for Testing' });
    }
  } catch {}
  const byMajor = new Map();
  for (const c of candidates) {
    if (!fs.existsSync(c.path)) continue;
    const version = versionOf(c.path);
    if (!version) continue;
    const major = Number(version.split('.')[0]);
    if (!byMajor.has(major)) byMajor.set(major, { ...c, version, major });
  }
  return [...byMajor.values()];
}

// Chrome's public release history for the Mac stable channel (fetched from this
// machine, not through the proxies): real full version numbers per major, and the
// major most users are currently on.
async function stableReleases() {
  const api = 'https://versionhistory.googleapis.com/v1/chrome/platforms/mac/channels/stable/versions';
  try {
    const [all, live] = await Promise.all([
      fetch(`${api}?pageSize=120`, { signal: AbortSignal.timeout(8000) }).then(r => r.json()),
      fetch(`${api}/all/releases?filter=endtime%3Dnone`, { signal: AbortSignal.timeout(8000) }).then(r => r.json()),
    ]);
    const current = live.releases.reduce((a, b) => (b.fraction > a.fraction ? b : a)).version;
    return { versions: all.versions.map(v => v.version), currentMajor: Number(current.split('.')[0]) };
  } catch {
    return null;
  }
}

// Engines in the order sessions get them: the version most users are on first, then
// by distance from it (one behind, one ahead, two behind, ...), as real version spread
// looks. Each engine carries the real full versions of its major it may report.
async function planEngines() {
  const engines = findEngines();
  const stable = await stableReleases();
  const current = stable ? stable.currentMajor : Math.max(...engines.map(e => e.major));
  engines.sort((a, b) => Math.abs(a.major - current) - Math.abs(b.major - current) || a.major - b.major);
  for (const e of engines) {
    const real = stable ? stable.versions.filter(v => v.startsWith(`${e.major}.`)) : [];
    e.releases = real.length ? real : [e.version];
  }
  return engines;
}

// --install-browsers: download official Chrome for Testing builds of the given majors,
// choosing for each the newest build that also shipped as a real stable release.
async function installBrowsers(majors) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('--install-browsers supports Apple-silicon Macs only.');
  const known = (await fetch('https://googlechromelabs.github.io/chrome-for-testing/known-good-versions-with-downloads.json')
    .then(r => r.json())).versions;
  const stable = new Set((await stableReleases())?.versions || []);
  fs.mkdirSync(BROWSERS_DIR, { recursive: true });
  for (const major of majors) {
    const builds = known.filter(v => v.version.startsWith(`${major}.`)
      && (v.downloads.chrome || []).some(d => d.platform === 'mac-arm64'));
    const build = builds.filter(v => stable.has(v.version)).pop() || builds.pop();
    if (!build) { console.log(`  Chrome ${major}: no mac-arm64 build available`); continue; }
    const dir = path.join(BROWSERS_DIR, `chrome-${build.version}`);
    if (fs.existsSync(dir)) { console.log(`  Chrome ${build.version}: already installed`); continue; }
    const url = build.downloads.chrome.find(d => d.platform === 'mac-arm64').url;
    console.log(`  Chrome ${build.version}: downloading ${url}`);
    const zip = path.join(BROWSERS_DIR, `chrome-${build.version}.zip`);
    fs.writeFileSync(zip, Buffer.from(await (await fetch(url)).arrayBuffer()));
    execFileSync('ditto', ['-x', '-k', zip, dir]); // ditto keeps the app bundle's signature intact
    fs.rmSync(zip);
  }
  console.log('\nAvailable engines:');
  for (const e of findEngines()) console.log(`  Chrome ${e.version.padEnd(16)} ${e.kind}`);
}

// Chrome won't open a profile last used by a newer version. If a session's profile is
// newer than its engine, it's moved aside (not deleted) and the session starts fresh.
function prepareProfile(profileDir, engine) {
  let last;
  try { last = fs.readFileSync(path.join(profileDir, 'Last Version'), 'utf8').trim(); } catch { return; }
  if (Number(last.split('.')[0]) <= engine.major) return;
  const backup = `${profileDir}.chrome-${last}.bak`;
  fs.renameSync(profileDir, backup);
  fs.mkdirSync(profileDir, { recursive: true });
  console.warn(`  ${path.basename(profileDir)}: profile was from Chrome ${last}, newer than this session's Chrome `
    + `${engine.version}; moved to ${path.basename(backup)}`);
}

// Chromium's "GREASE" brand: its name, version and the order of the brand list all
// derive from the major version, exactly as Chromium generates them.
function brandList(major, brands) {
  const chars = [' ', '(', ':', '-', '.', '/', ')', ';', '=', '?', '_'];
  const grease = {
    brand: `Not${chars[major % chars.length]}A${chars[(major + 1) % chars.length]}Brand`,
    version: ['8', '99', '24'][major % 3],
  };
  const all = [grease, ...brands];
  const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  const out = [];
  orders[major % 6].forEach((slot, i) => { out[slot] = all[i]; });
  return out;
}

// The UA string and matching client hints for a session.
// Always the engine's own major version; the full version is one of that major's real
// stable releases (`round` counts how many earlier sessions share this engine, so they
// report different ones).
function userAgentFor(round, mac, releases) {
  const full = releases[round % releases.length];
  const major = Number(full.split('.')[0]);
  const short = brandList(major, [{ brand: 'Chromium', version: String(major) }, { brand: 'Google Chrome', version: String(major) }]);
  return {
    label: `Chrome ${full}`,
    userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
    metadata: {
      brands: short,
      fullVersionList: short.map(b => ({ brand: b.brand, version: /Chrom/.test(b.brand) ? full : `${b.version}.0.0.0` })),
      fullVersion: full,
      platform: 'macOS',
      platformVersion: mac.macos,
      architecture: 'arm',
      bitness: '64',
      model: '',
      mobile: false,
      wow64: false,
      formFactors: ['Desktop'],
    },
  };
}

// Time zones with the same clock as a given zone, all year round, for sessions whose
// exit IPs share a zone. A zone that doesn't match the IP's location is a red flag,
// so a session only ever moves to another zone of the same country with identical
// offsets and DST dates. Only the UK is listed (all of proxies.txt is UK): its Crown
// Dependencies have their own zone names (Chrome reports Europe/Belfast as
// Europe/London, so it's left out). Further sessions share a zone rather than getting
// one from another country.
const SAME_CLOCK_ZONES = {
  'Europe/London': ['Europe/Jersey', 'Europe/Guernsey', 'Europe/Isle_of_Man'],
};

// Give each session its exit IP's time zone, moving later sessions that would share
// one onto the next unused same-clock zone. Returns zones by session order.
function assignTimezones(zones) {
  const used = new Set();
  return zones.map(zone => {
    const pick = [zone, ...(SAME_CLOCK_ZONES[zone] || [])].find(z => !used.has(z)) || zone;
    used.add(pick);
    return pick;
  });
}

// The language list each session's browser is set to, by session index: it drives the
// Accept-Language header (Chrome adds the q-values) and navigator.languages, which must
// agree. All start with the exit IP's locale; the rest vary the way real users' lists
// do. The first 10 sessions never share a list.
function languagesFor(index, locale) {
  const base = locale.split('-')[0];
  const extras = ['fr', 'es', 'de', 'pl', 'it'].filter(l => l !== base);
  const variants = base === 'en'
    ? [[locale, 'en-US', 'en'], [locale, 'en'], [locale], [locale, 'en-US'], [locale, 'en', 'en-US'],
      [locale, 'en-US', 'en', extras[0]], [locale, 'en', extras[1]], [locale, 'en', extras[2]],
      [locale, 'en-US', 'en', extras[3]], [locale, 'en', extras[0], extras[1]]]
    : [[locale, base], [locale, base, 'en-US', 'en'], [locale], [locale, base, 'en'], [locale, 'en-US', 'en'],
      [locale, base, 'en-GB', 'en'], [locale, base, 'en', extras[0]], [base, locale, 'en'],
      [locale, base, 'en-US'], [locale, base, extras[0], 'en']];
  return [...new Set(variants[index % variants.length])];
}

// Chrome reads these settings from the profile's Preferences at startup. Deep-merged,
// so the rest of the profile's settings are kept.
function writePrefs(profileDir, patch) {
  const file = path.join(profileDir, 'Default', 'Preferences');
  let prefs = {};
  try { prefs = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const merge = (into, from) => {
    for (const [k, v] of Object.entries(from)) {
      into[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(into[k] && typeof into[k] === 'object' ? into[k] : {}, v) : v;
    }
    return into;
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(merge(prefs, patch)));
}

// A session's language list, look and PDF handling, as Chrome preferences. Zoom is
// stored as a zoom level (log base 1.2 of the factor) for the default storage partition.
// Every other session has Chrome's "Download PDFs instead of opening them" setting on,
// the one real setting that changes navigator.plugins (empty instead of Chrome's five
// PDF viewer entries) and navigator.pdfViewerEnabled.
function prefsFor(languages, look, downloadPdfs) {
  return {
    plugins: { always_open_pdf_externally: downloadPdfs },
    intl: { accept_languages: languages.join(','), selected_languages: languages.join(',') },
    webkit: { webprefs: { default_font_size: look.fontSize || 16 } },
    partition: { default_zoom_level: { x: Math.log(look.zoom || 1) / Math.log(1.2) } },
  };
}

// Deterministic per session index so a profile keeps the same identity across runs.
function identityFor(index, geo, uniform) {
  return {
    mac: MACS[index % MACS.length],
    screen: MACS[index % MACS.length].screen,
    locale: COUNTRY_LOCALE[geo.country] || 'en-US',
    timezoneId: geo.timezone || 'UTC',
    look: uniform ? LOOKS[0] : LOOKS[index % LOOKS.length],
  };
}

// Runs first in the session script and gives the patches below (as `s`) a way to
// replace built-in functions and getters that looks like the original:
// - Each stand-in is a Proxy of the original, so its name, length, missing `prototype`,
//   not being a constructor and property layout are all the original's.
// - A stand-in getter runs the original first, so calling it on the wrong object still
//   throws "Illegal invocation".
// - Function.prototype.toString reports stand-ins (and itself) as `[native code]` with
//   the original's name, also when called from another same-origin frame.
// - An error thrown through a stand-in has the frames of this script cut from its stack
//   (everything down to the trap), so it reads as if the original had thrown it.
function makeStealth() {
  const { apply, construct, defineProperty, getOwnPropertyDescriptor, getPrototypeOf } = Reflect;
  const OwnFunction = Function;
  const nativeToString = Function.prototype.toString;
  const natives = new WeakMap(); // stand-in -> what toString reports for it
  const lookup = WeakMap.prototype.get;
  const remember = WeakMap.prototype.set;

  const clean = err => {
    try {
      const lines = err.stack.split('\n');
      const first = lines.findIndex(l => /^\s+at /.test(l));
      let last = -1;
      lines.forEach((l, i) => { if (l.includes('SpooferTrap.')) last = i; });
      if (first >= 0 && last >= first) err.stack = [...lines.slice(0, first), ...lines.slice(last + 1)].join('\n');
    } catch {}
    return err;
  };
  // The Proxy handler. Its class name marks its frames in stack traces for `clean`.
  class SpooferTrap {
    constructor(onCall, onConstruct) { this.onCall = onCall; this.onConstruct = onConstruct; }
    apply(target, that, args) {
      try { return this.onCall ? this.onCall(target, that, args) : apply(target, that, args); } catch (e) { throw clean(e); }
    }
    construct(target, args, newTarget) {
      try { return this.onConstruct(target, args, newTarget); } catch (e) { throw clean(e); }
    }
  }
  const standIn = (original, onCall, onConstruct) => {
    const proxy = new Proxy(original, new SpooferTrap(onCall, onConstruct));
    apply(remember, natives, [proxy, apply(nativeToString, original, [])]);
    return proxy;
  };

  const toString = standIn(nativeToString, (target, that, args) => {
    const known = apply(lookup, natives, [that]);
    if (known !== undefined) return known;
    // A function from another frame: that frame's own (patched) toString knows it.
    if (typeof that === 'function' && !(that instanceof OwnFunction)) {
      const theirs = getPrototypeOf(that)?.toString;
      if (typeof theirs === 'function' && theirs !== toString) return apply(theirs, that, args);
    }
    return apply(target, that, args);
  });
  defineProperty(Function.prototype, 'toString', { ...getOwnPropertyDescriptor(Function.prototype, 'toString'), value: toString });

  return {
    // obj[key](...args) becomes fn(original, this, args). Returns the stand-in.
    method(obj, key, fn) {
      const d = getOwnPropertyDescriptor(obj, key);
      if (!d || typeof d.value !== 'function') return null;
      const proxy = standIn(d.value, fn);
      defineProperty(obj, key, { ...d, value: proxy });
      return proxy;
    },
    // Reading obj[key] returns fn(this), after the original getter has run.
    getter(obj, key, fn) {
      const d = getOwnPropertyDescriptor(obj, key);
      if (!d || typeof d.get !== 'function') return;
      defineProperty(obj, key, { ...d, get: standIn(d.get, (target, that, args) => {
        apply(target, that, args);
        return fn(that);
      }) });
    },
    // `new obj[key](...args)` becomes fn(Original, args, newTarget); calling it without
    // `new` still throws as before.
    constructor(obj, key, fn) {
      const Original = obj[key];
      if (typeof Original !== 'function') return;
      const proxy = standIn(Original, null, fn);
      defineProperty(obj, key, { ...getOwnPropertyDescriptor(obj, key), value: proxy });
      defineProperty(Original.prototype, 'constructor', { ...getOwnPropertyDescriptor(Original.prototype, 'constructor'), value: proxy });
    },
    construct,
  };
}

// Part of the session script (see sessionScript). Playwright's `screen` option is
// ignored with viewport: null, so window.screen is overridden here instead.
function applyScreen(scr, s) {
  if (!self.Screen) return; // workers have no screen
  const props = {
    width: scr.width, height: scr.height,
    availWidth: scr.availWidth, availHeight: scr.availHeight,
    availLeft: scr.availLeft, availTop: scr.availTop,
    colorDepth: scr.colorDepth, pixelDepth: scr.colorDepth,
  };
  for (const [key, value] of Object.entries(props)) s.getter(Screen.prototype, key, () => value);
}

// Per-session random seed, stored in the profile so a session's canvas output and font
// list are stable across runs; --fresh wipes the profile and so picks a new one.
// (Older profiles stored it as spoofer-canvas-seed.json; it's carried over.)
function sessionSeedFor(profileDir) {
  const file = path.join(profileDir, 'spoofer-seed.json');
  for (const f of [file, path.join(profileDir, 'spoofer-canvas-seed.json')]) {
    try {
      const { seed } = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (f !== file) fs.renameSync(f, file);
      return seed;
    } catch {}
  }
  const seed = Math.floor(Math.random() * 0xffffffff) >>> 0;
  fs.writeFileSync(file, JSON.stringify({ seed }));
  return seed;
}

// Fonts. Every Mac has the full macOS font set and nothing removes it, so all of it
// stays. What differs between real Macs is fonts that apps and users add on top. Each
// session gets its own combination of these common sets (the first 10 sessions never
// share one); fonts from sets a session doesn't have are hidden, in case this machine
// has them installed.
const FONT_SETS = {
  office: [['Calibri', 'sans'], ['Calibri Light', 'sans'], ['Cambria', 'serif'], ['Cambria Math', 'serif'],
    ['Candara', 'sans'], ['Consolas', 'mono'], ['Constantia', 'serif'], ['Corbel', 'sans'],
    ['Century Gothic', 'sans'], ['Franklin Gothic Medium', 'sans'], ['Gill Sans MT', 'sans']],
  adobe: [['Myriad Pro', 'sans'], ['Minion Pro', 'serif']],
  google: [['Roboto', 'sans'], ['Open Sans', 'sans'], ['Lato', 'sans'], ['Montserrat', 'sans'], ['Source Sans Pro', 'sans']],
  dev: [['Fira Code', 'mono'], ['JetBrains Mono', 'mono'], ['Source Code Pro', 'mono'], ['Hack', 'mono']],
};
// Sessions 1-4 get sets that common font-detection lists (e.g. amiunique's) can tell
// apart; Google Fonts aren't on those lists, so that set starts at session 6.
const FONT_SETUPS = [[], ['office'], ['adobe'], ['dev'], ['office', 'adobe'], ['google'],
  ['dev', 'google'], ['office', 'google'], ['office', 'dev'], ['adobe', 'google']];
// An added font is rendered with one of macOS's own fonts of the same kind, so text
// measurement (how detection works) sees a real font that differs from the defaults.
// CSS local() needs PostScript names (e.g. local('Menlo') doesn't resolve).
const STAND_INS = {
  sans: ['AvenirNext-Regular', 'GillSans', 'Optima-Regular', 'Verdana', 'TrebuchetMS'],
  serif: ['Charter-Roman', 'Baskerville', 'HoeflerText-Regular', 'Palatino-Roman', 'Cochin'],
  mono: ['Menlo-Regular', 'Monaco', 'AndaleMono', 'PTMono-Regular'],
};

function fontsFor(index) {
  const sets = FONT_SETUPS[index % FONT_SETUPS.length];
  const add = [];
  const hide = [];
  for (const [name, fonts] of Object.entries(FONT_SETS)) {
    fonts.forEach(([family, kind], i) => {
      if (sets.includes(name)) add.push([family, STAND_INS[kind][i % STAND_INS[kind].length]]);
      else hide.push(family);
    });
  }
  return { sets, add, hide };
}

// Part of the session script.
// - Hidden fonts: a face whose unicode-range covers no real character shadows any
//   installed copy, so text in that family falls through to the next font and
//   width-measuring detection (DOM, canvas, OffscreenCanvas) sees it as not installed.
// - Added fonts: in pages, an @font-face rule placed before any of the page's own
//   stylesheets, so a site serving its own web font under the same name still gets its
//   font; in workers (no stylesheets), a FontFace.
function applyFonts({ add, hide }) {
  const fontSet = self.document ? document.fonts : self.fonts;
  if (!fontSet || !self.FontFace) return;
  for (const family of hide) {
    const face = new FontFace(family, "local('Arial')", { unicodeRange: 'U+10FFFF' });
    fontSet.add(face);
    face.load().catch(() => {});
  }
  if (!self.document) {
    for (const [family, local] of add) {
      const face = new FontFace(family, `local('${local}')`);
      fontSet.add(face);
      face.load().catch(() => {});
    }
    return;
  }
  const css = add.map(([family, local]) => `@font-face { font-family: '${family}'; src: local('${local}'); }`).join('\n');
  const inject = () => {
    const style = document.createElement('style');
    style.textContent = css;
    document.documentElement.insertBefore(style, document.documentElement.firstChild);
    for (const [family] of add) document.fonts.load(`16px '${family}'`).catch(() => {}); // load early
  };
  if (document.documentElement) { inject(); return; }
  new MutationObserver((_, obs) => {
    if (!document.documentElement) return;
    obs.disconnect();
    inject();
  }).observe(document, { childList: true });
}

// Part of the session script: report the session's CPU core count. No navigator
// properties are removed: every real Chrome of this version has all of them. In
// workers it's WorkerNavigator.
function applyCores(cores, s) {
  s.getter((self.Navigator || self.WorkerNavigator).prototype, 'hardwareConcurrency', () => cores);
}

// Battery behaviour per session. Desktop Macs report Chrome's no-battery values (always
// charging at 100%). Laptops follow a repeating day-like cycle - unplugged and draining
// down to a low point, charging back up, then sitting plugged in at 100% - with the
// drain rate, low point, idle time and where in the cycle "now" falls all taken from
// the session seed. The cycle is driven by the clock, so every tab, reload and run of a
// session agrees, and the level changes over time like a real battery.
function batteryFor(mac, seed) {
  if (!mac.laptop) return { desktop: true };
  const pick = n => {
    let h = Math.imul(seed ^ Math.imul(n, 0x2545f491), 0x9e3779b1);
    h ^= h >>> 16;
    return (h >>> 0) / 0x100000000; // 0..1
  };
  return {
    desktop: false,
    drainHours: 6 + pick(1) * 6,       // full -> empty rate: 6-12h of use
    low: 0.12 + pick(2) * 0.28,        // plugs in at 12-40%
    chargeHours: 1.5 + pick(3) * 1,    // empty -> full: 1.5-2.5h
    pluggedHours: 0.5 + pick(4) * 4,   // sits on the charger at 100% for 0.5-4.5h
    phase: pick(5),                    // where in the cycle the session is
  };
}

// Part of the session script: report this session's battery through BatteryManager
// (navigator.getBattery()). Real battery events still fire, and handlers read these
// values. Times are whole minutes in seconds, as Chrome reports them on macOS.
function applyBattery(b, s) {
  if (!self.BatteryManager) return;
  const dateNow = Date.now; // captured before page scripts can replace it
  const state = () => {
    if (b.desktop) return { charging: true, level: 1, chargingTime: 0, dischargingTime: Infinity };
    const H = 3600;
    const drain = (1 - b.low) * b.drainHours * H; // seconds unplugged
    const charge = (1 - b.low) * b.chargeHours * H; // seconds charging
    const plugged = b.pluggedHours * H;
    const period = drain + charge + plugged;
    const t = (dateNow.call(Date) / 1000 + b.phase * period) % period;
    const minutes = sec => Math.max(60, Math.round(sec / 60) * 60);
    if (t < drain) {
      const level = 1 - (t / drain) * (1 - b.low);
      return { charging: false, level: Math.round(level * 100) / 100, chargingTime: Infinity,
        dischargingTime: minutes(level * b.drainHours * H) };
    }
    if (t < drain + charge) {
      const level = b.low + ((t - drain) / charge) * (1 - b.low);
      return { charging: true, level: Math.round(level * 100) / 100,
        chargingTime: minutes((1 - level) * b.chargeHours * H), dischargingTime: Infinity };
    }
    return { charging: true, level: 1, chargingTime: 0, dischargingTime: Infinity };
  };
  for (const key of ['charging', 'level', 'chargingTime', 'dischargingTime']) {
    s.getter(BatteryManager.prototype, key, () => state()[key]);
  }
}

// Part of the session script. Audio fingerprinting renders a fixed sound (typically an
// oscillator through a compressor in an OfflineAudioContext) and hashes the samples;
// the exact float values differ slightly between machines. Here, the first time a
// page reads an AudioBuffer channel (getChannelData / copyFromChannel), ~1 in 8
// non-zero samples is scaled by 1 +/- 2^-20, chosen from the session seed and the
// sample's position: inaudible, stable within a session, different between sessions.
// AnalyserNode float frequency data gets the same treatment on every read.
function applyAudioNoise(seed, s) {
  if (!self.AudioBuffer) return;
  const pick = (channel, i) => {
    let h = Math.imul(seed ^ Math.imul(i, 0x9e3779b1) ^ Math.imul(channel + 1, 0x85ebca6b), 0xc2b2ae35);
    h ^= h >>> 15;
    return h;
  };
  const nudge = (data, channel, scale) => {
    for (let i = 0; i < data.length; i++) {
      const h = pick(channel, i);
      if (data[i] !== 0 && (h & 7) === 0) data[i] *= 1 + (h & 8 ? scale : -scale);
    }
  };

  const origGetChannelData = AudioBuffer.prototype.getChannelData;
  const done = new WeakMap(); // buffer -> Set of channels already nudged
  // getChannelData returns the buffer's live storage, so nudge it once per channel;
  // later writes by the page (e.g. filling a buffer) are left alone.
  const ensure = (buffer, channel) => {
    let set = done.get(buffer);
    if (!set) done.set(buffer, (set = new Set()));
    const data = Reflect.apply(origGetChannelData, buffer, [channel]);
    if (!set.has(channel)) {
      set.add(channel);
      nudge(data, channel, 2 ** -20);
    }
    return data;
  };
  s.method(AudioBuffer.prototype, 'getChannelData', (orig, buffer, args) => {
    Reflect.apply(orig, buffer, args); // throws as usual for a bad channel
    return ensure(buffer, Number(args[0]) >>> 0);
  });
  s.method(AudioBuffer.prototype, 'copyFromChannel', (orig, buffer, args) => {
    try { ensure(buffer, Number(args[1]) >>> 0); } catch {} // invalid channel: let the original throw
    return Reflect.apply(orig, buffer, args);
  });

  if (self.AnalyserNode) {
    s.method(AnalyserNode.prototype, 'getFloatFrequencyData', (orig, node, args) => {
      const result = Reflect.apply(orig, node, args);
      nudge(args[0], 99, 2 ** -18);
      return result;
    });
  }
}

// Part of the session script: the audio output's sample rate. Chrome runs an
// AudioContext at the output device's rate unless the page asks for one, so a context
// created without a sampleRate gets the session's; Chrome then genuinely runs at that
// rate (resampling to the real device), so sampleRate, baseLatency and the audio
// itself all agree.
function applyAudioOutput(sampleRate, s) {
  if (!self.AudioContext) return;
  s.constructor(self, 'AudioContext', (Original, args, newTarget) => {
    const [options, ...rest] = args;
    const isDict = options === undefined || options === null || typeof options === 'object';
    if (isDict && (options == null || options.sampleRate === undefined)) {
      // Inherit from the page's options, so its other fields (latencyHint, sinkId) still apply.
      args = [Object.assign(Object.create(options ?? null), { sampleRate }), ...rest];
    }
    return s.construct(Original, args, newTarget);
  });
}

// Part of the session script: which media devices the Mac has. Chrome lists one entry
// per kind of device present (labels and IDs stay empty until the site gets
// permission); a Mac mini with a plain monitor has no camera or microphone, so those
// kinds are left out, and asking for them fails as Chrome does when none exist.
function applyMediaDevices({ mic, camera }, s) {
  if (!self.MediaDevices) return;
  const hidden = new Set([...(mic ? [] : ['audioinput']), ...(camera ? [] : ['videoinput'])]);
  if (!hidden.size) return;
  const then = Promise.prototype.then;
  s.method(MediaDevices.prototype, 'enumerateDevices', (orig, devices, args) =>
    Reflect.apply(then, Reflect.apply(orig, devices, args), [list => list.filter(d => !hidden.has(d.kind))]));
  s.method(MediaDevices.prototype, 'getUserMedia', (orig, devices, args) => {
    const c = args[0];
    if (c && ((c.audio && !mic) || (c.video && !camera))) {
      return Promise.reject(new DOMException('Requested device not found', 'NotFoundError'));
    }
    return Reflect.apply(orig, devices, args);
  });
}

// Part of the session script: the keyboard layout (navigator.keyboard.getLayoutMap()).
// Every KeyboardLayoutMap Chrome hands out keeps its own key order; the values become
// the session's layout's, and keys that layout doesn't produce (U.S. has no IntlRo or
// IntlYen) are dropped, as Chrome drops them.
function applyKeyboard(layout, s) {
  if (!self.KeyboardLayoutMap) return;
  const { apply, getPrototypeOf } = Reflect;
  const has = key => Object.prototype.hasOwnProperty.call(layout, key);
  const proto = KeyboardLayoutMap.prototype;
  const origKeys = proto.keys;
  const orders = new WeakMap(); // real map -> its keys this layout has, in Chrome's order
  const order = map => {
    let keys = orders.get(map);
    if (!keys) {
      keys = [...apply(origKeys, map, [])].filter(has);
      orders.set(map, keys);
    }
    return keys;
  };
  s.method(proto, 'get', (orig, map, args) => {
    const real = apply(orig, map, args);
    return real !== undefined && has(String(args[0])) ? layout[String(args[0])] : undefined;
  });
  s.method(proto, 'has', (orig, map, args) => apply(orig, map, args) && has(String(args[0])));
  s.getter(proto, 'size', map => order(map).length);
  s.method(proto, 'forEach', (orig, map, args) => {
    const [callback, thisArg] = args;
    if (typeof callback !== 'function') return apply(orig, map, args); // throws as usual
    for (const key of order(map)) apply(callback, thisArg, [layout[key], key, map]);
  });

  // Iterators stay Chrome's own objects; their results are swapped as they're read.
  const iterators = new WeakMap(); // iterator -> { keys, kind, i }
  let iteratorProto = null;
  const iterate = kind => (orig, map, args) => {
    const it = apply(orig, map, args);
    if (!iteratorProto) {
      iteratorProto = getPrototypeOf(it);
      s.method(iteratorProto, 'next', (origNext, that, nextArgs) => {
        const st = iterators.get(that);
        if (!st) return apply(origNext, that, nextArgs);
        if (st.i >= st.keys.length) return { value: undefined, done: true };
        const key = st.keys[st.i++];
        return { value: st.kind === 'keys' ? key : st.kind === 'values' ? layout[key] : [key, layout[key]], done: false };
      });
    }
    iterators.set(it, { keys: order(map), kind, i: 0 });
    return it;
  };
  const sameAsEntries = proto[Symbol.iterator] === proto.entries;
  const entries = s.method(proto, 'entries', iterate('entries'));
  s.method(proto, 'keys', iterate('keys'));
  s.method(proto, 'values', iterate('values'));
  if (sameAsEntries && entries) {
    Object.defineProperty(proto, Symbol.iterator, { ...Object.getOwnPropertyDescriptor(proto, Symbol.iterator), value: entries });
  } else {
    s.method(proto, Symbol.iterator, iterate('entries'));
  }
}

// Part of the session script. Whenever a page reads pixels back from a canvas
// (toDataURL, toBlob, getImageData, OffscreenCanvas.convertToBlob, WebGL readPixels),
// some pixels get one color channel nudged by 1. Real machines differ only where
// colors change (text and shape edges, anti-aliasing, gradients); solid fills read
// back exactly everywhere, and fingerprinting scripts check that. So only opaque
// pixels that differ from a horizontal neighbour are candidates, ~1 in 8 of them,
// chosen from the session seed and the pixel's position: the same drawing always reads
// back the same within a session but differently between sessions. The visible canvas
// itself is never modified.
function applyCanvasNoise(seed, s) {
  const differs = (data, i, j) => data[i] !== data[j] || data[i + 1] !== data[j + 1]
    || data[i + 2] !== data[j + 2] || data[i + 3] !== data[j + 3];
  // `coord(col, row)` maps a pixel of the read to canvas coordinates. Edges are judged
  // on the original pixels, then all chosen pixels are nudged.
  const noiseRows = (data, width, rows, coord) => {
    const hits = [];
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < width; col++) {
        const i = (row * width + col) * 4;
        if (i + 3 >= data.length) break;
        if (data[i + 3] !== 255) continue;
        const [x, y] = coord(col, row);
        let h = Math.imul(seed ^ Math.imul(x, 0x9e3779b1) ^ Math.imul(y, 0x85ebca6b), 0xc2b2ae35);
        h ^= h >>> 15;
        if ((h & 7) !== 0) continue;
        if ((col > 0 && differs(data, i, i - 4)) || (col < width - 1 && differs(data, i, i + 4))) {
          hits.push(i + ((h >>> 3) % 3));
        }
      }
    }
    for (const k of hits) data[k] ^= 1;
  };
  // Rows top-down from (left, top), as getImageData returns them.
  const noise = (data, left, top, width) =>
    noiseRows(data, width, Math.ceil(data.length / 4 / width), (col, row) => [left + col, top + row]);

  const origGetImageData = new Map();
  for (const Ctx of [self.CanvasRenderingContext2D, self.OffscreenCanvasRenderingContext2D]) {
    if (!Ctx) continue;
    origGetImageData.set(Ctx, Ctx.prototype.getImageData);
    s.method(Ctx.prototype, 'getImageData', (orig, ctx, args) => {
      const img = Reflect.apply(orig, ctx, args);
      const [sx, sy, sw, sh] = args;
      noise(img.data, sw < 0 ? sx + sw : sx, sh < 0 ? sy + sh : sy, img.width);
      return img;
    });
  }

  // Copy a canvas onto a scratch canvas (a <canvas> when exporting an element, an
  // OffscreenCanvas otherwise) with noise applied, for the export methods.
  const noisyCopy = (canvas, asElement) => {
    const { width, height } = canvas;
    if (!width || !height) return null;
    let copy;
    if (asElement) {
      copy = document.createElement('canvas');
      copy.width = width;
      copy.height = height;
    } else {
      copy = new OffscreenCanvas(width, height);
    }
    const ctx = copy.getContext('2d');
    ctx.drawImage(canvas, 0, 0);
    const img = origGetImageData.get(ctx.constructor).call(ctx, 0, 0, width, height);
    noise(img.data, 0, 0, width);
    ctx.putImageData(img, 0, 0);
    return copy;
  };
  // The original runs on the noisy copy; with a bad `this` it runs on that and throws.
  const exportNoisy = asElement => (orig, canvas, args) => {
    let copy = null;
    try { copy = noisyCopy(canvas, asElement); } catch {}
    return Reflect.apply(orig, copy || canvas, args);
  };
  if (self.HTMLCanvasElement) {
    s.method(HTMLCanvasElement.prototype, 'toDataURL', exportNoisy(true));
    s.method(HTMLCanvasElement.prototype, 'toBlob', exportNoisy(true));
  }
  if (self.OffscreenCanvas) s.method(OffscreenCanvas.prototype, 'convertToBlob', exportNoisy(false));

  // WebGL readPixels returns rows bottom-up; convert to top-down canvas coordinates so a
  // pixel gets the same noise however it's read. Only RGBA/UNSIGNED_BYTE into an array
  // (what fingerprinting uses) is touched; reads into a pixel buffer are left alone.
  for (const Ctx of [self.WebGLRenderingContext, self.WebGL2RenderingContext]) {
    if (!Ctx) continue;
    s.method(Ctx.prototype, 'readPixels', (orig, gl, args) => {
      const result = Reflect.apply(orig, gl, args);
      const [x, y, width, height, format, type, pixels, offset] = args;
      if (format === gl.RGBA && type === gl.UNSIGNED_BYTE && ArrayBuffer.isView(pixels) && width > 0) {
        const data = new Uint8Array(pixels.buffer, pixels.byteOffset + (offset || 0) * pixels.BYTES_PER_ELEMENT);
        const bufH = gl.drawingBufferHeight;
        noiseRows(data, width, height, (col, row) => [x + col, bufH - 1 - (y + row)]);
      }
      return result;
    });
  }
}

// Part of the session script: report this session's Apple chip as the WebGL GPU (UNMASKED_RENDERER_WEBGL via WEBGL_debug_renderer_info), in the exact
// format Chrome uses on Apple silicon.
function applyWebGLRenderer(chip, s) {
  const renderer = `ANGLE (Apple, ANGLE Metal Renderer: Apple ${chip}, Unspecified Version)`;
  const UNMASKED_RENDERER_WEBGL = 0x9246;
  for (const Ctx of [self.WebGLRenderingContext, self.WebGL2RenderingContext]) {
    if (!Ctx) continue;
    s.method(Ctx.prototype, 'getParameter', (orig, gl, args) => {
      const value = Reflect.apply(orig, gl, args);
      // Only replace a real answer: Chrome returns null until the page has enabled
      // WEBGL_debug_renderer_info on this context.
      return args[0] === UNMASKED_RENDERER_WEBGL && typeof value === 'string' ? renderer : value;
    });
  }
}

// Part of the session script: make workers run the session script too. Init scripts
// only run in documents, so new Worker()/SharedWorker() on a blob: URL - how
// fingerprinting scripts create workers - is redirected to a copy of that blob with the
// session script prepended. A blob worker's URL is already opaque, so nothing else about
// the worker changes. Workers loaded from an http(s) URL are left as they are (see
// README). Runs inside workers as well, so nested workers are covered.
function applyWorkerHook(sessionFn, s) {
  const prelude = `(${sessionFn})();\n`;
  const blobs = new Map();   // blob: URL -> Blob, recorded as they're created
  const wrapped = new Map(); // blob: URL -> blob: URL of the copy with the prelude
  const origCreate = URL.createObjectURL;
  s.method(URL, 'createObjectURL', (orig, that, args) => {
    const url = Reflect.apply(orig, that, args);
    if (args[0] instanceof Blob) blobs.set(url, args[0]);
    return url;
  });
  s.method(URL, 'revokeObjectURL', (orig, that, args) => {
    const result = Reflect.apply(orig, that, args);
    blobs.delete(String(args[0]));
    return result;
  });
  const wrap = url => {
    const key = String(url);
    // Reuse the copy per URL, so two SharedWorkers on the same URL still share.
    if (wrapped.has(key)) return wrapped.get(key);
    const blob = key.startsWith('blob:') && blobs.get(key);
    if (!blob) return url;
    const copy = origCreate.call(URL, new Blob([prelude, blob], { type: 'text/javascript' }));
    wrapped.set(key, copy);
    return copy;
  };
  for (const name of ['Worker', 'SharedWorker']) {
    if (!self[name]) continue;
    s.constructor(self, name, (Original, args, newTarget) =>
      s.construct(Original, args.length ? [wrap(args[0]), ...args.slice(1)] : args, newTarget));
  }
}

// One script with all of a session's patches, run in every page and frame (as an init
// script) and in every blob: worker (via applyWorkerHook). makeStealth runs first and is
// passed to every patch; each patch is isolated so one failing in some environment
// doesn't stop the rest.
function sessionScript(calls) {
  const body = calls.map(([fn, arg]) => `  try { (${fn})(${JSON.stringify(arg)}, s); } catch {}`).join('\n');
  return `(function spooferSession() {\n  let s;\n  try { s = (${makeStealth})(); } catch { return; }\n${body}\n`
    + `  try { (${applyWorkerHook})(spooferSession, s); } catch {}\n})();`;
}

// Grid-tile windows across the screen so all sessions are visible. Each window is
// shrunk a little inside its tile by a per-index amount (up to ~70x50px, distinct for
// the first 8 sessions) so no two sessions report the same window/viewport size.
function windowRect(index, count, screenW, screenH) {
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  const tileW = Math.floor(screenW / cols);
  const tileH = Math.floor(screenH / rows);
  return {
    x: (index % cols) * tileW,
    y: Math.floor(index / cols) * tileH,
    w: tileW - (index * 23) % 70,
    h: tileH - (index * 17) % 50,
  };
}

// ---------- Launch ----------

async function launchSession(i, opts, proxy, geo) {
  const id = identityFor(i, geo, opts.uniform);
  const profileDir = path.join(opts.profiles, `session-${String(i + 1).padStart(2, '0')}`);
  if (opts.fresh) fs.rmSync(profileDir, { recursive: true, force: true });
  fs.mkdirSync(profileDir, { recursive: true });

  // The window must fit on the claimed screen, and the position Chrome reports for it
  // must place it there: its spot in the real grid, scaled into the claimed screen's
  // available area.
  // (Chrome won't make a window smaller than 500x375, whatever it's asked for.)
  const rect = windowRect(i, opts.count, opts.screenW, opts.screenH);
  rect.w = Math.min(Math.max(rect.w, 500), id.screen.availWidth);
  rect.h = Math.min(Math.max(rect.h, 375), id.screen.availHeight);
  const place = (pos, size, realSpan, start, span) =>
    start + Math.round((span - size) * Math.min(1, pos / Math.max(1, realSpan - size)));

  id.languages = languagesFor(i, id.locale);
  id.fonts = fontsFor(i);
  id.engine = opts.engines[i % opts.engines.length];
  prepareProfile(profileDir, id.engine);
  id.downloadPdfs = i % 2 === 1;
  id.keyboard = keyboardFor(i, id.locale);
  id.cpuThrottle = cpuThrottleFor(id.mac.chip);
  writePrefs(profileDir, prefsFor(id.languages, id.look, id.downloadPdfs));
  // Inert per-session marker the Playwright hook looks sessions up by (relative URLs
  // aren't used, so it never affects navigation).
  const marker = `http://session-${String(i + 1).padStart(2, '0')}.browser-spoofer.invalid/`;
  if (opts.spoof) {
    id.ua = userAgentFor(Math.floor(i / opts.engines.length), id.mac, id.engine.releases);
    SESSION_OVERRIDES.set(marker, {
      metadata: id.ua.metadata,
      metrics: {
        width: 0, height: 0, deviceScaleFactor: 0, mobile: false, // viewport follows the window
        screenWidth: id.screen.width,
        screenHeight: id.screen.height,
        positionX: place(rect.x, rect.w, opts.screenW, id.screen.availLeft, id.screen.availWidth),
        positionY: place(rect.y, rect.h, opts.screenH, id.screen.availTop, id.screen.availHeight),
      },
    });
  }

  // launchPersistentContext = separate Chromium process + separate on-disk profile
  // (cookies, localStorage, IndexedDB, cache, service workers) per session.
  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath: id.engine.path,
    headless: opts.headless,
    proxy: proxy && await startProxyRelay(proxy),
    locale: id.locale,
    timezoneId: id.timezoneId,
    viewport: null, // let the page fill the (tiled) window
    baseURL: marker,
    ...(id.ua && { userAgent: id.ua.userAgent }),
    colorScheme: id.look.dark ? 'dark' : 'light',
    // Current Playwright no longer adds this, but older and future versions might.
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      // Playwright's control pipe (--remote-debugging-pipe) also marks the browser as
      // automated; this turns that off, so navigator.webdriver is false as in a normal
      // Chrome.
      '--disable-blink-features=AutomationControlled',
      // Dark: dark browser UI, plus Chromium's auto-dark for sites without a dark theme.
      ...(id.look.dark ? ['--force-dark-mode', '--blink-settings=forceDarkModeEnabled=true'] : []),
      // The browser's own default UA too, for requests it makes before Playwright's
      // per-page override applies (e.g. downloading a service worker's script).
      ...(id.ua ? [`--user-agent=${id.ua.userAgent}`] : []),
      `--window-position=${rect.x},${rect.y}`,
      `--window-size=${rect.w},${rect.h}`,
      // Keep WebRTC from exposing the real local/public IP outside the proxy.
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });
  const seed = sessionSeedFor(profileDir);
  id.battery = batteryFor(id.mac, seed);
  await context.addInitScript({
    content: sessionScript([
      [applyScreen, id.screen],
      ...(opts.noise ? [[applyCanvasNoise, seed]] : []),
      [applyWebGLRenderer, id.mac.chip],
      [applyFonts, id.fonts],
      [applyCores, id.mac.cores],
      [applyBattery, id.battery],
      ...(opts.noise ? [[applyAudioNoise, seed]] : []),
      [applyAudioOutput, id.mac.sampleRate],
      [applyMediaDevices, { mic: id.mac.mic, camera: id.mac.camera }],
      [applyKeyboard, id.keyboard.map],
    ]),
  });
  // Chrome's CPU throttling is per tab, so it's applied to every tab as it opens.
  if (id.cpuThrottle > 1) {
    const throttle = p => context.newCDPSession(p)
      .then(cdp => cdp.send('Emulation.setCPUThrottlingRate', { rate: id.cpuThrottle }))
      .catch(() => {});
    await Promise.all(context.pages().map(throttle));
    context.on('page', throttle);
  }

  const page = context.pages()[0] || await context.newPage();
  page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: 60000 })
    .catch(e => console.warn(`  [${i + 1}] navigation error: ${e.message.split('\n')[0]}`));
  if (opts.alert && !opts.headless) watchForPageChange(page, i + 1);

  return { context, id, profileDir };
}

// Alert (sound + notification + bring window to front) when a session lands on a
// different page, e.g. leaves a waiting room. Reloads of the same page are ignored,
// and redirects in the first 20s after launch are treated as part of the initial load.
function watchForPageChange(page, label) {
  const key = u => { try { const x = new URL(u); return x.host + x.pathname; } catch { return u; } };
  let current = null;
  setTimeout(() => { current = key(page.url()); }, 20000);
  page.on('framenavigated', frame => {
    if (frame !== page.mainFrame() || current === null) return;
    const next = key(frame.url());
    if (next === current) return;
    current = next;
    console.log(`\n>>> Session ${label} moved to a new page: ${frame.url()}\n`);
    page.bringToFront().catch(() => {});
    notify(`Session ${label} moved to a new page`, frame.url());
  });
}

function notify(title, body) {
  if (process.platform !== 'darwin') { process.stdout.write('\x07'); return; }
  const esc = t => t.replace(/["\\]/g, '\\$&');
  execFile('osascript', ['-e', `display notification "${esc(body)}" with title "${esc(title)}" sound name "Glass"`], () => {});
  execFile('afplay', ['/System/Library/Sounds/Glass.aiff'], () => {});
}

// --check: test every proxy in the list, print a report, open nothing.
async function checkAll(opts) {
  const raw = loadProxies(opts.proxies, opts.count, true);
  console.log(`Checking all ${raw.length} proxies in ${opts.proxies}...\n`);
  const results = await Promise.all(raw.map(async r => {
    const proxy = toPlaywrightProxy(r);
    const host = new URL(proxy.server).hostname;
    try { return { host, geo: await lookupExitIp(proxy) }; }
    catch (e) { return { host, err: e.message.split('\n')[0] }; }
  }));
  const seen = new Map();
  for (const { host, geo, err } of results) {
    if (err) { console.log(`  FAIL  ${host.padEnd(28)} ${err}`); continue; }
    const dup = seen.has(geo.ip) ? `  (same IP as ${seen.get(geo.ip)})` : '';
    seen.set(geo.ip, host);
    console.log(`  OK    ${host.padEnd(28)} ${geo.ip.padEnd(15)} ${geo.city || '?'}, ${geo.country || '?'}${dup}`);
  }
  const ok = results.filter(r => !r.err).length;
  console.log(`\n${ok}/${results.length} working, ${seen.size} distinct IPs. Each run needs ${opts.count}.`);
  process.exit(ok >= opts.count ? 0 : 1);
}

async function main() {
  loadDotEnv(path.join(ROOT, '.env'));
  const opts = parseArgs(process.argv.slice(2));
  if (opts.check) return checkAll(opts);
  if (opts.installBrowsers) return installBrowsers(opts.installBrowsers);
  const rawProxies = loadProxies(opts.proxies, opts.count);
  const proxies = rawProxies.map(toPlaywrightProxy);

  console.log(`Checking exit IPs for ${opts.count} proxies...`);
  const geos = await Promise.all(proxies.map((p, i) =>
    lookupExitIp(p).then(
      geo => ({ ok: true, geo }),
      err => ({ ok: false, err: `${p.server}: ${err.message.split('\n')[0]}` }),
    ).then(r => ({ ...r, i }))));

  const failed = geos.filter(g => !g.ok);
  if (failed.length) {
    console.error('\nThese proxies did not respond; refusing to launch so no session falls back to your real IP:');
    failed.forEach(f => console.error(`  [${f.i + 1}] ${f.err}`));
    console.error('\nRun with --check to see which proxies in the list are working.');
    process.exit(1);
  }

  const byIp = new Map();
  geos.forEach(g => byIp.set(g.geo.ip, [...(byIp.get(g.geo.ip) || []), g.i + 1]));
  const dupes = [...byIp].filter(([, ids]) => ids.length > 1);
  if (dupes.length) {
    console.warn('\nSessions sharing an exit IP:');
    dupes.forEach(([ip, ids]) => console.warn(`  ${ip} -> sessions ${ids.join(', ')}`));
    if (!opts.allowDuplicateIps) {
      console.error('Aborting. Use distinct proxies, or pass --allow-duplicate-ips.');
      process.exit(1);
    }
  }

  opts.engines = await planEngines();
  opts.spoof = playwrightHooked;
  if (!opts.spoof) {
    console.warn('\nWarning: could not set per-session client hints and screens (Playwright internals '
      + 'changed); sessions will report the real ones.');
  }
  console.log(`\nChrome versions available: ${opts.engines.map(e => e.major).join(', ')}`
    + (opts.engines.length < opts.count ? ` (fewer than ${opts.count} sessions, so some share a version;`
      + ' add more with --install-browsers)' : ''));

  console.log(`\nLaunching ${opts.count} isolated sessions -> ${opts.url}\n`);
  const zones = assignTimezones(geos.map(g => g.geo.timezone || 'UTC'));
  // Ctrl+C works during the staggered launch too: it closes whatever is open so far.
  const sessions = [];
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    console.log('\nClosing sessions...');
    await Promise.allSettled(sessions.map(s => s.context.close()));
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // One at a time, each a random 0-5s after the previous one finished launching, so the
  // sessions don't all arrive at the site in the same instant.
  let open = 0;
  let launched = false;
  for (const { geo, i } of geos) {
    if (sessions.length) {
      const wait = Math.random() * 5000;
      console.log(`       (next session in ${(wait / 1000).toFixed(1)}s)`);
      await new Promise(r => setTimeout(r, wait));
    }
    if (closing) return;
    const s = await launchSession(i, opts, proxies[i], { ...geo, timezone: zones[i] });
    sessions.push(s);
    open++;
    // Exit once the user has closed every window manually.
    s.context.on('close', () => { if (--open === 0 && launched && !closing) process.exit(0); });
    console.log(`  [${String(i + 1).padStart(2)}] ${geo.ip.padEnd(15)} ${(geo.city || '?') + ', ' + (geo.country || '?')}`
      + `  tz=${s.id.timezoneId}  locale=${s.id.locale}  look=${s.id.look.name}`
      + `\n       mac=${s.id.mac.name} (${s.id.mac.cores} cores, macOS ${s.id.mac.macos})`
      + `  ua=${s.id.ua ? s.id.ua.label : `real Chrome ${s.id.engine.version}`}  pdf=${s.id.downloadPdfs ? 'download' : 'viewer'}`
      + `  screen=${s.id.screen.width}x${s.id.screen.height}@${s.id.screen.colorDepth}bit`
      + `\n       fonts=+${s.id.fonts.sets.join('+') || 'none'}  languages=${s.id.languages.join(',')}`
      + `  keyboard=${s.id.keyboard.name}  audio=${s.id.mac.sampleRate / 1000}kHz`
      + `  media=${s.id.mac.camera ? 'camera+mic+speaker' : 'speaker only'}`
      + (s.id.cpuThrottle > 1 ? `  cpu=slowed ${s.id.cpuThrottle}x to ${s.id.mac.chip} speed` : ''));
  }
  launched = true;
  if (open === 0) process.exit(0);

  console.log('\nAll sessions running. Press Ctrl+C to close them all.');
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
