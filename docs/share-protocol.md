# Share page protocol (`tvpipe share`)

The protocol between tvpipe and a capture script (`crates/tvpipe/src/browser/capture.js`)
running in a browser: tvpipe's share page (`tvpipe share`), the page
tvpipe's own browser shows and injects the script into (`tvpipe share URL`),
or the capture page tvpipe's own browser opens to capture the desktop
(`tvpipe screen`, [`screen.md`](screen.md)).
Version 1. Using them: [Sharing the screen](https://tvpipe.party/manual/screen/) and
[A web page on the TV](https://tvpipe.party/manual/web-page/).

## Transport

- tvpipe listens on `127.0.0.1` only, on any free port (the URL has a
  new token every run anyway; `--port` is the `--to browser` player's),
  and prints `http://127.0.0.1:PORT/?t=TOKEN`. `TOKEN` is 16 random bytes
  in hex, new for every run.
- `GET /?t=TOKEN`: the share page. `GET /screen?t=TOKEN`: the capture
  page of `tvpipe screen` (`screen.html`: `capture.js` and a status line;
  tvpipe starts the capture in it). `GET /capture.js`: the capture script
  (static, no token). `GET /fonts/NAME.woff2`: the page's fonts
  (`crates/tvpipe/src/browser/fonts/`, static, no token). `GET /ws?t=TOKEN`: the
  WebSocket (RFC 6455, no extensions, no subprotocol). Every request
  needs a `Host` of `127.0.0.1:PORT`, `localhost:PORT` or `[::1]:PORT`
  (421 otherwise: DNS rebinding), the page and the socket need the token
  (403).
- `http://127.0.0.1` is a secure context in Chrome, Safari and Firefox, so
  `getDisplayMedia` and WebCodecs are available without TLS.
- Largest message: 16 MiB.
- `tvpipe share --tunnel` also serves the page on a public https host
  ([tunnels.md](tunnels.md)) with its own per-run token; there the socket
  also needs `https://HOST` as `Origin`, and the link answers `410` once
  `--tunnel-ttl` (default 60 min) is over. A `capture` from there waits
  for the local user's `y` (or `--yes`) before the receivers connect; the
  page shows `status` `connecting` meanwhile, and a share turned down gets
  `end` and a close. A remote share has a playout delay of at least
  300 ms.

## Flow

```
page                                    tvpipe
 |<------------------------------ channel |  (on connect: the media socket's key)
 |-- hello ------------------------------>|
 |<-------------------------------- config |  (once the receivers are resolved)
 |<-------------------------------- status |  (any time)
 |   user picks a surface (getDisplayMedia)
 |-- capture ---------------------------->|  tvpipe connects the receivers
 |<---------------------------------- plan |
 |   worker: media socket, `media` + key ->|  (optional, see Media socket)
 |<------------------------------- media --|
 |-- record h264-config, h264, audio ... ->|  (video over the media socket if any)
 |<------------------------------ keyframe |  (any time, coalesced)
 |-- stats ------------------------------>|  (every 2 s)
 |-- ended ------------------------------>|  share stopped: tvpipe ends
 |<----------------------------------- end |  or tvpipe stopped first
```

Several pages may connect; the first `capture` wins, later ones get
`busy` and are closed (1008). A page that ends (or closes) before the
`plan` frees the slot for another capture. After the plan, the page
closing its socket or sending `ended` ends the session (after one playout
delay, like the end of a file).

**Rejoin mode** (`tvpipe share URL`): the source page is a document
in tvpipe's own browser, and a navigation, a reload or a crash replaces
it. There, the newest page that sends `capture` is the source (nobody
gets `busy`); a source page that goes away mid-stream does not end the
session, and the next one gets the same `plan` (its `content` placed for
its own capture size) and continues the stream. Because `pts_us` is
wall-clock time, the timeline has a gap and no jump. Its first records
are an `h264-config` and a keyframe (the warm-up rule below); an SPS that
differs from the first one in more than its VUI ends the session (Chrome
on macOS changes the VUI's transfer characteristics between its first
keyframes, which is accepted). The session ends when tvpipe gives up on
the browser or the browser was closed.

## Text messages (JSON objects with a `type`)

Page → tvpipe:

| type | fields |
|---|---|
| `hello` | `version` (1), `clock` (the page's media clock, µs), `agent` (user agent), `features` (what the browser has; informational) |
| `capture` | `width`, `height` (of the first frame; the track's settings if none comes within 1.5 s), `fps` (or null), `audio` (bool: an audio track was shared), `surface` (`browser`/`window`/`monitor`), `label` |
| `stats` | `fps`, `sourceFps`, `kbps`, `targetKbps` (the current `bitrate`), `audioKbps`, `audioPeak` (the loudest sample since the last stats, 0–1), `encodeMs`, `dropped`, `paced` (skipped for the cadence), `repeated`, `keyRequests`, `queue`, `buffered`, `codec`, `width`, `height` (logged at `--debug`; sound that stays at peak 0 for 10 s is noted once) |
| `ended` | `reason` |
| `log` | `level` (`error`/`warn`/`info`), `message` (shown in tvpipe's log) |
| `media` | `key`: the first message of a *media socket* (below), not of a page |

tvpipe → page:

| type | fields |
|---|---|
| `channel` | `key` (32 hex digits): what this page's media socket says; sent first, to every socket |
| `config` | `version`, `fps` (what to ask getDisplayMedia for), `audio` (whether to ask for audio), `sampleRate`, `channels` (the PCM tvpipe wants), `receivers` (names) |
| `status` | `state` (`waiting`, `connecting`, `streaming`), `message`, `receivers` |
| `plan` | `width`, `height` (encode size), `content` (`{x, y, width, height}`: where the capture goes, black around it), `fps`, `bitrate` (bit/s), `keyInterval` (frames between IDRs), `audio` (`{sampleRate, channels}` or null: send no audio) |
| `keyframe` | — make the next frame an IDR (soon: a still screen re-encodes its last frame) |
| `bitrate` | `bitrate` (bit/s): encode at this from now on (adaptive bitrate: the encoder is configured again with only the bitrate changed, no new stream); a page that shares later gets it in its `plan` |
| `media` | — the media socket's key was taken; records may follow on it |
| `busy` | — another page is the source |
| `end` | `reason`: tvpipe stopped (Ctrl-C, receivers gone, an error) |

Unknown types are ignored by both sides.

## Binary messages

Each is exactly one SLRW record ([`slrw.md`](slrw.md)): `u8 kind | u64le
pts_us | u32le len | payload`, `len` = message length − 13.

| kind | payload |
|---|---|
| 4 `h264-config` | `u8 format` (0: avcC from `VideoEncoder` metadata `decoderConfig.description`) + data. Sent before the first chunk and again only when it changes. |
| 3 `h264` | `u8 flags` (bit 0: key, bit 1: Annex B) + one access unit (`EncodedVideoChunk` data; AVCC with the avcC's length size, or Annex B when the encoder gave no avcC) |
| 2 `audio` | s16le interleaved PCM at the plan's rate and channels (~10 ms per record) |
| 0 `end` | empty (accepted; `ended` is preferred) |

Other kinds are an error and end the session. `pts_us` is the page's
media clock (`performance.timeOrigin + performance.now()` in µs) for audio
and video alike. tvpipe takes media time 0 from the first record it keeps
and times audio by its sample count (resyncing on drift over 50 ms), as
for games.

Receivers show every frame at its timestamp, so the timestamps say when
a picture was *captured*, at an even cadence, not when the script got to
it (the page's thread, busy with the page, hands frames on tens of ms
late and unevenly; stamped on arrival, a 30 fps share had frames 31 to
93 ms apart, docs/measurements.md):

- **Capture time** (`L.captureClock`): a `VideoFrame`'s own `timestamp`
  (Chrome: its capture time, steady to ±0.3 ms), moved onto the media
  clock by the smallest arrival delay seen (creeping up 2 µs a frame for
  clocks that drift); the arrival time when the timestamp goes back, is
  missing or is a second off.
- **Cadence** (`L.pacer`): frames go on a grid one plan interval apart. A
  frame takes the next slot when it was captured up to 0.4 intervals
  before it or half an interval after it, the nearest slot after a gap,
  and is skipped when earlier (a source faster than the plan: of a 60 Hz
  source every other frame, never alternating). The grid follows the
  frames' phase by an eighth of each one's offset. Keyframes asked for
  while frames flow are the next captured frame; a still source's last
  picture is encoded again (`force`, never skipped) only when no frame
  came for 2 intervals (keyframes) or 250 ms (repeats).
- **Audio** (`L.audioClock`): by the sample count from the first chunk's
  arrival minus its length; moved earlier when a chunk arrives before its
  counted end, later when one is a second late (a gap) or every chunk of
  two seconds came over 20 ms after its counted end.

The surfaces of `@tvpipe/party` (`npm/party/src/surface.ts`) use the
same pacer and audio clock.

The H.264 must have no B-frames (decode order = presentation order). The
script asks for Constrained Baseline first (then Main, High), at the
smallest level that fits the plan, with `latencyMode: "realtime"`
(browsers check only the frame size against the level: 4K60 must ask for
5.2 itself; Chrome's hardware encoder on macOS writes the level asked
for).

## Stream size and shape

Receivers stretch what they get to fill their screen (a projector showed
a 16:10 capture stretched to 16:9). So:

- **Shape:** the stream has the receivers' screen shape: Cast from the
  ANSWER's `display` (`aspectRatio`, else `dimensions`), AirPlay from the
  SETUP canvas; a TV that does not say counts as 16:9. With several
  shapes, the most common wins (a tie: 16:9) and tvpipe warns that the
  others stretch. Browser players (`--to browser`) have no screen shape
  (they fit any picture into their window): next to a TV they take its
  shape, alone the stream keeps the capture's shape (no bars; `tvpipe
  browser`: the page's, 16:9 or `--size`).
- **Size:** the smallest frame of that shape that holds the capture at
  1:1 (no upscaling), shrunk to the tightest receiver limit. Cast is
  offered up to 1920x1080@60 (or `--size`/`--fps`/`--bitrate`), and its
  ANSWER constraints narrow that (also its `maxPixelsPerSecond`: the
  size shrinks, the frame rate stays; an ANSWER without constraints under
  an offer above 1080p counts as openscreen's 1080p30 at 10 Mbit/s);
  AirPlay's limit is its canvas. `--size` sets the frame exactly. The
  frame rate is `--fps` or 30.
- **`share URL`:** the page is laid out at `--size` (CSS pixels; default
  the receivers' shape within 1920x1080) and rendered at `--resolution`
  (`auto`: up to 1080p; `720p`, `1080p`, `4k`): tvpipe's Chromium-based
  browser gets the device scale factor that fills the resolution's box
  within the receivers' limits, and a headless screen of exactly that
  many pixels, so the tab is captured at the stream's size
  (docs/playshare-design.md §9.1). An explicit 1080p or 4K lets an
  AirPlay receiver go up to its decoder maximum (docs/airplay-mirroring.md
  §2.6). The SDK without `Options::resolution` keeps the page the
  stream's size at scale 1.
- **Picture:** the capture is centered inside at its own aspect ratio
  (`browser::layout::place`, the same arithmetic as `place` in
  `capture.js`, checked against each other by the Chrome test); the page
  draws it into an OffscreenCanvas of the output size. If the capture
  changes size mid-stream (a resized window) the page recomputes the
  rectangle; the stream's size never changes.
- **Pixels:** square. Browsers' H.264 carries no sample aspect ratio (seen
  in Chrome); tvpipe warns if a stream says otherwise.

## Encoder warm-up

The first pictures of a hardware encoder can come out most of a second
after capture (VideoToolbox in Chrome: ~0.9 s). Starting the timeline on
them made Cast's in-flight window overflow at once. Until it has sent a
keyframe, the page discards chunks: non-key ones, and keyframes more than
150 ms late (it asks its encoder for another), for at most 3 s.

## Flow control

tvpipe reads records as fast as the session takes them; when it falls
behind, the socket backs up. The page drops source frames *before* the
encoder while `WebSocket.bufferedAmount` (the media socket's, when there
is one) exceeds 4 MiB or the encoder has more than 2 frames queued, so
the stream stays decodable. Audio records are dropped above the same
threshold.

## Media socket

A video engine in a worker sends its records (`h264-config`, `h264`)
over a WebSocket of its own, so they never wait for the page's thread
(with the page's own work in 10–40 ms tasks, records through the page
reached tvpipe up to 38 ms after capture, through the worker's socket
within 7 ms). tvpipe sends every socket `channel` with a key of its own
first; the worker opens the same `/ws?t=TOKEN` URL and sends `media` with
its page's key before anything else. tvpipe answers `media`, takes the
socket's records as the page's (while the page is the source) and closes
it when the page goes. A wrong key is closed with 1008. The worker
configures its encoder only once the socket is taken (or after 1 s
without an answer, then the page sends its records), so records never
switch paths mid-stream. Audio stays on the page's socket.

## Browsers

| | Chrome / Edge | Safari 26 (macOS 26) | Firefox 160 |
|---|---|---|---|
| getDisplayMedia offers | tabs, windows, screens | windows, screens (no tabs) | windows, screens (no tabs) |
| Sound | tab audio; with a screen the system's (Windows, macOS 14.2+; Linux only with a feature switch), with a window its app's (Windows 11, macOS 14.2+): [`screen.md`](screen.md) | none | none (`share URL`: the tab's sound, see below) |
| Video engine | worker (a MediaStreamTrackProcessor's `readable` moved to it) | worker (track moved to a worker, MediaStreamTrackProcessor there) | page (`<video>` + VideoFrame) |
| Tested | headless, CDP-driven, real tab capture | WebDriver, synthetic stream (picker needs a human) | headless, BiDi-driven, its own tab captured (below) |

- The engine runs in a worker whenever the browser can transfer the video
  track to one (`postMessage(track, [track])` and MediaStreamTrackProcessor,
  VideoEncoder, OffscreenCanvas in the worker), or else a
  MediaStreamTrackProcessor's `readable` made on the page (Chrome, which
  cannot transfer tracks; its frames then reach the worker without the
  page's thread): a worker is not throttled while the share page is a
  background tab, which it is in Safari when the user shares the Safari
  window and switches to the tab to show, and is not held up by the page
  `share URL` captures (a game's TV page). The same engine code runs on
  the page otherwise.
- Safari/Firefox: the page asks for no audio (a refused constraint could
  not be retried without a new click) and hints `displaySurface: "window"`,
  and the page explains: share the Safari window (or the screen), then
  switch to the tab; or drag the tab into its own window first.
- Firefox has no MediaStreamTrackProcessor and cannot transfer a
  MediaStreamTrack to a worker, so its engine runs on the page: a hidden
  `<video>` plays the track and a VideoFrame is made of it per
  `requestVideoFrameCallback`, or on the worker-driven timer while that
  is quiet (a background tab: the test measured 30 fps with the share
  page hidden). Its VideoEncoder (Firefox 130+) takes H.264 Constrained
  Baseline, Main and High with `avc: {format: "avc"}` and
  `latencyMode: "realtime"`; the AudioWorklet and the OffscreenCanvas
  padding work as in the other browsers. On Linux (Firefox 160) its avcC
  writes each parameter set's NAL header twice (`67 67 42 c0 …`,
  `68 68 …`; issue #6); tvpipe drops the repeated byte
  (`AvcConfig::undouble_headers`, for every encoded SLRW config record).
- Firefox's getDisplayMedia shows its own picker (windows and screens;
  `displaySurface`, `preferCurrentTab`, `selfBrowserSurface`, `systemAudio`
  and audio are not supported, per MDN's compatibility data). With
  `media.navigator.permission.disabled` it skips the picker and shares
  the primary screen (what `TVPIPE_TEST_FIREFOX_SCREEN=1` tests).
- Clocks are `performance.timeOrigin + performance.now()` so page and
  worker timestamps agree.

Checking Firefox's picker by hand (the automated test cannot press it):

1. `tvpipe -v share --to browser --open` (or `--to` a TV); open the
   printed URL in Firefox 130 or later. The page shows the box "Firefox
   can share a window or the whole screen, but not a single tab, and no
   sound", and no "Keep tab audio playing here".
2. Press **Share…**. Firefox's panel offers windows and the entire
   screen, no tabs and no sound. On macOS the first time, Firefox needs
   the Screen Recording permission (System Settings › Privacy &
   Security), and a restart of Firefox.
3. Pick this Firefox window. The player tab (or the TV) shows it within
   a second; tvpipe logs `capturing window WxH@30` and about 30 fps.
4. Switch the shared window to another tab with motion (a video). The
   picture keeps moving at about 30 fps while the share page is in the
   background (`-v`: `fps from the page`).
5. Resize the window: the picture is recomputed and stays centered with
   black bars; the stream's size does not change.
6. Stop with **Stop Sharing** in Firefox's sharing indicator: tvpipe ends
   (`the share was stopped in the browser`).

## Capture script API

`capture.js` defines `globalThis.tvpipeCapture`:

```js
const c = tvpipeCapture.connect(wsUrl, {
  preferCurrentTab: true,          // getDisplayMedia hint (headless mode)
  selfBrowserSurface: 'include',   // default 'exclude' (the share page)
  localAudio: false,               // keep playing tab audio locally
  surface: 'monitor',              // the picker's preselected kind (displaySurface)
  windowAudio: 'window',           // a window's sound: its app's ('window'), 'system', 'exclude'
  profiles: ['42E0', '4D40', '6400'],
  worker: true,                    // false: keep the video engine on the page
});
c.on('config' | 'status' | 'plan' | 'capture' | 'stats' | 'log' | 'error' | 'end' | 'close' | 'open', fn);
await c.captureDisplay();  // getDisplayMedia from the config, then share()
await c.share(stream);     // or any MediaStream (canvas.captureStream(), ...)
c.stop(reason);
```

`captureDisplay()` must run with transient user activation (a click; or
CDP `Runtime.evaluate` with `userGesture: true` plus Chrome's
auto-accept flags in the headless mode).

`tvpipe share URL` evaluates `capture.js` and then `crates/tvpipe/src/browser/headless.js`
in the page after every navigation. That one is called with the WebSocket
URL and connect options (default: `preferCurrentTab`,
`selfBrowserSurface: 'include'`, no local audio; `tvpipe screen` passes
`surface`, `windowAudio: 'window'`, `selfBrowserSurface: 'exclude'` and
local audio) and calls `captureDisplay()` once the `config` arrives; its
state is in `globalThis.__tvpipe` (`connecting`, `capturing`, `sharing`,
`ended` with an `error`, and `stopped` when the user stopped the capture
in the browser: `Capture.stoppedInBrowser`), which tvpipe polls. The tab must be allowed to reach
`ws://127.0.0.1`: tvpipe bypasses the page's CSP (`Page.setBypassCSP`)
and grants every origin Chrome's Local Network Access permission
(`loopbackNetwork`; without it an https page fails with
`net::ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS`). On a `file://` page
(an opaque origin) the audio worklet is loaded from a `data:` URL, since
a `blob:` one fails there.

**Firefox** (`--browser firefox`, or the only browser installed) is
driven over WebDriver BiDi (`crates/tvpipe/src/browser/bidi.rs`,
`crates/tvpipe/src/browser/headless/firefox.rs`); Firefox no longer has the DevTools
protocol. Its getDisplayMedia cannot share the current tab, but the
older getUserMedia sources still exist behind preferences tvpipe's
profile sets (`launch::FIREFOX_PREFS`): `{video: {mediaSource:
"browser"}}` captures the calling tab's viewport (cross-site iframes
included, at the size `browsingContext.setViewport` gives it, also in a
visible window on a 2x screen) and `{audio: {mediaSource:
"audioCapture"}}` the sound the tab plays, without a prompt
(`media.navigator.permission.disabled`). `captureDisplay()` takes that
path in Firefox when `preferCurrentTab` is set; it needs transient
activation like getDisplayMedia (`script.evaluate` with
`userActivation: true`). The captured sound keeps playing locally, so the
profile mutes Firefox's output (`media.volume_scale` 0; the capture is
taken before the volume). The capture includes what the page itself
plays, so the worklet's output must not reach the page's destination
(that cycle is silenced by Firefox's audio graph): in Firefox it goes to
a MediaStreamAudioDestinationNode. BiDi has no `setBypassCSP`: tvpipe
intercepts the tab's responses (`network.addIntercept`, phase
`responseStarted`) and lets each continue without its
`Content-Security-Policy` headers, answered on the connection's reader
thread so the page never waits for the keeper; a policy in a `<meta>`
tag still applies. Local Network Access is off in the profile
(`network.lna.*`).
