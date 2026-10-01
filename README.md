# BrowserSpoofer

Opens N (default 4) isolated Chromium sessions at a URL. Each session goes through its own proxy, so each one has its own exit IP.

## Setup

```sh
npm run setup                          # installs Playwright + Chromium
cp proxies.example.txt proxies.txt     # then add your proxies (one per session)
cp .env.example .env                   # then fill in NORD_USER / NORD_PASS
node src/index.js --install-browsers   # optional: Chrome 155/152/151 so sessions run different versions
```

`proxies.txt` lines can use `${VAR}` placeholders filled from `.env`, so credentials live in one place:
`https://${NORD_USER}:${NORD_PASS}@uk6007.proxy.nordvpn.com:89`

## Usage

```sh
node src/index.js https://example.com             # 4 sessions, random proxies from the list
node src/index.js example.com -n 5 --fresh        # 5 sessions, wiped profiles
node src/index.js example.com --screen 2560x1440  # tile for a larger display
node src/index.js --check                         # test every proxy in the list, open nothing
node src/index.js example.com --no-noise          # this Mac's real canvas/WebGL/audio output (see below)
```

Sessions launch one at a time, each a random 0-5 seconds after the previous one finished launching.

Ctrl+C closes every session.

## What each session gets

| | |
|---|---|
| **Own process + profile** | `profiles/session-NN/`: cookies, storage, cache and logins are kept separate and persist between runs (`--fresh` resets them) |
| **Own IP** | its proxy from `proxies.txt`; the real exit IP is checked through the proxy before launch. Authenticated proxies go through a local relay (127.0.0.1) that adds the credentials, because letting Playwright answer the proxy's password challenge switches Chrome's cache off and adds `Pragma`/`Cache-Control: no-cache` to every request |
| **Matching locale** | timezone, `navigator.language` and `Accept-Language` come from the exit IP's location. Each session has its own language list (e.g. `en-GB,en-US,en` / `en-GB,en` / `en-GB,en,fr`), set in the profile so Chrome itself generates `Accept-Language` in its normal header position and `navigator.languages` agrees. Sessions sharing a UK IP zone get the UK's own zone names (London, Jersey, Guernsey, Isle of Man), never another country's; further sessions share London |
| **No WebRTC leak** | non-proxied UDP is disabled so WebRTC can't expose your real IP |
| **Own Mac model** | each session is a different real Apple-silicon Mac configuration (10 models). Everything matches that model: CPU core count, WebGL GPU name, display (resolution, available area under the menu bar and Dock, 24/30-bit color, Retina), battery (laptops drain and charge over time, desktops have none) and a shipped macOS release it supports. Models are limited to ones sold with 16-24GB, because memory (`navigator.deviceMemory`, `Device-Memory` header) is always this Mac's real value. Screen size and window position are emulated by Chrome itself, so CSS media queries and `screenX/Y` agree, and every window sits inside its claimed screen |
| **Own Chrome version** | sessions run on genuinely different Chrome builds: Playwright's bundled Chromium, your installed Google Chrome, and official Chrome for Testing builds in `browsers/` (`--install-browsers 155,152,151`). The version most users are on goes first, then nearest versions. Each session's UA, client hints, navigator properties and features all come from a real engine, so they agree; the client hints carry a real stable build of that version (from Google's release history), the Mac's macOS version and `arm`. Applied to pages, iframes, popups, workers and service workers. A profile last used by a newer Chrome is moved aside (`session-NN.chrome-<version>.bak`) rather than opened by an older one |
| **PDF setting** | every other session has Chrome's real "Download PDFs instead of opening them" setting on, so `navigator.plugins` is empty and `pdfViewerEnabled` false there (5 PDF viewer plugins elsewhere) |
| **Native headers** | every request header and client hint a site can receive before JavaScript runs either carries the session's values or matches what the page's JavaScript reports, and headers are sent in the same order as an unmodified Chrome |
| **Own keyboard layout** | `navigator.keyboard.getLayoutMap()` reports a real macOS layout: British for most UK sessions, U.S. for every third (and outside the UK), generated from macOS's own layout data with the call Chrome uses. Actual key presses still come from this Mac's layout, which only differs for the few keys around Return and Shift |
| **Own audio and media devices** | each Mac model's audio output sample rate (`AudioContext` runs at it for real) and its set of media devices: a Mac mini on a plain monitor has no camera or microphone, so `enumerateDevices` lists only its speaker and asking for the others fails with `NotFoundError`, as on a real one |
| **Matching CPU speed** | a session claiming a chip slower than this Mac's is slowed down to that chip's speed with Chrome's CPU throttling. One claiming a faster chip can't be sped up |
| **Not marked as automated** | launched without `--enable-automation` and with Chrome's automation marker switched off, so `navigator.webdriver` is `false` |
| **Patches look built-in** | every replaced function and getter keeps the original's name, length and shape, reports `[native code]` from `Function.prototype.toString` (also when asked from another frame), still throws "Illegal invocation" when misused, and errors thrown through it have no extra stack frames |
| **Own canvas** | canvas and WebGL readouts (`toDataURL`, `toBlob`, `getImageData`, `readPixels`, `OffscreenCanvas.convertToBlob`) carry a small per-session variation at edges and anti-aliasing, where real machines differ; solid fills read back exact. Stable across runs (`--fresh` gives a new one) |
| **Own audio** | audio fingerprints (`AudioBuffer.getChannelData`/`copyFromChannel`, `AnalyserNode.getFloatFrequencyData`) carry an inaudible per-session variation, stable across runs |
| **Own fonts** | the full macOS font set is always present (as on every Mac); each session adds its own combination of commonly installed font sets (sessions 1-4: none, Microsoft Office, Adobe, developer fonts; Google Fonts from session 6, since common detection lists don't include them), and fonts from sets it doesn't have are hidden |
| **Workers too** | the Mac model, canvas, WebGL and font changes also apply inside blob: workers (dedicated, module, shared and nested), which is how fingerprinting scripts use workers. Workers loaded from an http(s) URL and service workers still see the real core count, fonts and canvas |
| **Own look** | sessions cycle through settings a real Chrome user can change: dark appearance, Large font size, and 110%/125% page zoom, applied natively through Chrome's own preferences (`--uniform` to disable) |
| **Tiled window** | windows are laid out in a grid across the screen, each a slightly different size |
| **Page-change alert** | sound + notification + window raised when a session moves to a different page (`--no-alert` to disable) |

## Limits

- **Memory** is always this Mac's real 16GB. Chrome sends it in the `Device-Memory` header, and nothing can change that. 16GB is the most common Mac configuration.
- **Speed**: CPU and GPU speed are this Mac's. Sessions claiming an M3 or M4 run at M2 speed, and only CPU (not GPU) can be slowed.
- **Rendering**: canvas, WebGL and audio output is this Mac's (M2, macOS 26) with a small per-session variation on top; Chrome can't render as another GPU or macOS version. Apple-silicon Macs on the same macOS and Chrome version mostly produce identical canvas output, so a varied result matches no real Mac a site has seen, while the real one matches millions. `--no-noise` turns the variation off: sessions on the same Chrome version then share this Mac's real output.
- **TCP/IP fingerprint**: an HTTP proxy opens its own TCP connection to the site, so the site sees the proxy server's network stack (Linux), not a Mac's, whatever the browser says. Only a proxy that runs on a Mac would fix that; nothing in the browser can.

## Safety checks

- If any proxy fails the IP check, **nothing launches**. A session never falls back to your real connection.
- If two sessions share an exit IP, the run aborts unless you pass `--allow-duplicate-ips`.

## Proxy notes

- You need at least one proxy per session. Each run picks a random set from the list. With a rotating-gateway provider, write a single line containing `{n}` (see `proxies.example.txt`).
- NordVPN rate-limits proxy logins: after a burst of connections, servers answer 407 even with correct credentials. Don't run `--check` repeatedly; wait and retry.
- Chromium doesn't support SOCKS5 **with username/password**. For authenticated proxies, use the provider's HTTP endpoint.
- Per-session client hints, `Accept-Language` and screen emulation rely on a small hook into Playwright's internals (`calculateUserAgentMetadata`, its `acceptLanguage` override and Chromium `_updateViewport`). If a Playwright update changes them, sessions fall back to the real values and a warning is printed.
- The per-session Chrome builds are fetched at launch from Google's public version history (`versionhistory.googleapis.com`), from this machine rather than through the proxies. If that fails, every session reports the engine's own build.
