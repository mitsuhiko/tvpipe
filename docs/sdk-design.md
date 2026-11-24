# Node SDK design (`@tvpipe/sdk` on npm)

Status: implemented (the decisions at the end). The machine interface's
reference is [`machine.md`](machine.md); the SDK's user documentation is
[`npm/tvpipe/README.md`](../npm/tvpipe/README.md). Goal: `npm install @tvpipe/sdk` and stream to an Apple TV, a
Chromecast or a browser tab from Node without knowing about the binary:
files, URLs, the test pattern, web pages, and frames a program makes itself
(a canvas, raw RGBA, encoded H.264), with audio.

Three parts:

1. **The machine interface** of the binary (`--machine`): JSON events on
   stdout, commands on stdin, stop when the parent goes away. Small,
   versioned (protocol 1), useful for any language, not only Node.
2. **The TypeScript SDK** (`npm/tvpipe/`): spawns the binary, speaks the
   machine interface, offers a promise/event API. Zero runtime
   dependencies, erasable TypeScript only.
3. **Packaging**: `@tvpipe/sdk` plus six `@tvpipe/<os>-<cpu>` packages with
   the binaries, published from `release.yml` in lockstep with the crate.

## 1. API

```ts
import { discover, play, testPattern, preview, share, stream, pair } from "@tvpipe/sdk";

// Receivers on the network.
const devices = await discover({ timeout: 3000 });
// [{ name: "Living Room", model: "AppleTV14,1", protocols: ["airplay"],
//    addresses: ["192.168.1.20"], paired: true, airplay: {...}, cast: undefined }]

// A file or URL (ffmpeg needed unless it passes through unchanged).
const s = await play("movie.mp4", { to: "Living Room", loop: true });
s.on("receiver", (r) => console.log(r.name, r.state)); // connected/lost/reconnected/…
await s.done;               // resolves with the end info; rejects on failure
await s.stop();             // clean teardown (the TV leaves mirroring)

// Built-in pattern, no ffmpeg.
await using t = await testPattern({ to: ["Kitchen", "browser"] });
console.log(t.playerUrl);   // http://127.0.0.1:PORT/?t=… for `browser`

preview("movie.mp4", { open: true });          // = play(…, { to: "browser" })
share("https://status.example.com", { to: "TV", reload: 30 }); // headless browser
share({ to: "TV" });        // the share page; `s.shareUrl` is the page to open

// Frames from code: raw pixels + PCM.
const live = await stream({
  to: "Living Room",
  video: { width: 1280, height: 720, fps: 30, format: "rgba" },
  audio: { sampleRate: 48000, channels: 2 },        // s16le; Float32Array accepted
});
live.writeVideo(rgbaBytes);            // pts defaults to "now" since start
live.writeAudio(int16OrFloat32, ptsUs);
live.writeCanvas(canvas);              // node-canvas, skia-canvas, @napi-rs/canvas, OffscreenCanvas-like
const loop = live.drawLoop(canvas, (ctx, timeMs) => draw(ctx, timeMs)); // paced at fps
await live.end();                      // drain: the tail plays, then teardown
// or: await live.stop()               // stop now

// Encoded H.264 (e.g. WebCodecs `VideoEncoder` output, a hardware encoder).
const enc = await stream({ to: "TV", video: { width: 1920, height: 1080, fps: 60, codec: "h264" } });
enc.on("keyframe", () => encoder.encode(frame, { keyFrame: true }));
enc.writeChunk(chunk, metadata);       // duck-typed EncodedVideoChunk + metadata.decoderConfig
enc.writeH264(accessUnit, { keyframe: true, ptsUs, annexB: false });
enc.writeH264Config(avcC);

// AirPlay pairing (the TV shows a PIN).
await pair("Living Room", { onPin: async (device) => await askUser(device) });
await play("x.mp4", { to: "Living Room", onPin: askUser }); // pairs on demand, then plays
```

### Module surface

| Function | CLI | Resolves |
|---|---|---|
| `discover(opts?)` | `discover --json` | `Device[]` |
| `pair(target, { onPin?, pin? })` | `pair` | `{ name, id }` |
| `unpair(target)` | `unpair` | `void` |
| `play(input, opts)` | `play` | `PlaySession` once streaming started: `seek`, `seekBy`, `pause`, `resume` send the machine interface's commands (docs/playback.md) |
| `testPattern(opts)` | `debug pattern` | `Session` |
| `preview(input?, opts?)` | `preview` | `Session` (`playerUrl` set) |
| `share(url?, opts)` | `share [URL]` | `Session` (`shareUrl` without URL); with URL a `PageSession`, whose `navigate(url)` sends the machine interface's `navigate` |
| `stream(opts)` | `play … -` (SLRW) | `StreamSession` once receivers are connected |
| `version(opts?)` / `resolveBinary(opts?)` | `--version` | string / path |

`input` for `play`: a path, a URL, or `{ ffmpeg: string[] }` (capture
arguments after `--`).

`to` everywhere: `string | Device | Array<string | Device>`; strings are the
CLI's forms (`"Living Room"`, `"airplay:Living Room"`, `"192.168.1.20"`,
`"browser"`). A `Device` becomes its name (forced to `airplay:` when it
only has AirPlay video).

Common options (camelCase of the CLI's): `latency` (ms), `size`
(`"1280x720"` or `{width,height}`), `fps`, `bitrate` (kbit/s), `encoder`,
`audio: false`, `reconnect` (s), `loop`, `realtime`, `ffmpeg` (path),
`player: { port, open, waitForViewer, newToken }` for `browser`, plus
process options: `binary`, `configDir` (→ `TVPIPE_CONFIG_DIR`), `env`,
`signal` (AbortSignal → `stop()`), `verbose` (`-v`), `stopTimeout` (ms,
default 5000), `onPin`. The default player port is `0` (any free port) in
the SDK, not 8765, so parallel sessions and tests never clash; pass
`player: { port: 8765 }` for the stable URL.

### `Session`

```ts
interface Session extends AsyncDisposable {
  readonly pid: number;
  readonly receivers: ReadonlyMap<string, ReceiverInfo>; // latest state per receiver
  readonly playerUrl?: string;   // `browser` receiver page
  readonly shareUrl?: string;    // `share` without URL
  readonly info?: StartedInfo;   // plan: video size/fps/bitrate, audio, latency, route
  readonly done: Promise<EndInfo>;
  stop(): Promise<EndInfo>;      // graceful, escalates (below)
  kill(): void;                  // hard, no teardown
  on(event, listener) / off / once   // node:events EventEmitter, typed
  events(): AsyncIterable<TvpipeEvent>;
}
```

Events (the machine interface's, camelCased; listeners are optional):
`receiver` ({ name, protocol, state: "connected" | "failed" | "lost" |
"reconnected" | "gave-up" | "ended" | "stopped", error? }), `viewer`
(browser tabs), `started`, `stats` (1 Hz: frames sent, per-receiver
pushed/dropped), `keyframe` (stream with H.264), `log` ({ level, message }),
`end`, `error`. An `error` event never throws when unhandled (unlike plain
EventEmitter): failures reject `done` and the start promise instead.

`done` rejects with a `TvpipeError` (`code`: `pairing-required`,
`not-found`, `unsupported`, `usage`, `ffmpeg-missing`, …, `exitCode`,
`stderr` tail). `stop()` after the end is a no-op returning the same
`EndInfo`. `await using` calls `stop()`.

### `StreamSession`

```ts
interface StreamSession extends Session {
  writeVideo(frame: ArrayBufferView | ArrayBuffer, ptsUs?: number | bigint): boolean;
  writeAudio(pcm: Int16Array | Float32Array | Uint8Array, ptsUs?: number | bigint): boolean;
  writeCanvas(canvas: CanvasLike, ptsUs?: number | bigint): boolean;
  drawLoop(canvas: CanvasLike, draw: (ctx, timeMs: number) => void): { stop(): void };
  writeH264(au: Uint8Array, o: { keyframe: boolean; ptsUs?: number | bigint; annexB?: boolean }): boolean;
  writeH264Config(cfg: Uint8Array, format?: "avcc" | "annexb"): void;
  writeChunk(chunk: EncodedVideoChunkLike, metadata?: { decoderConfig?: { description?: BufferSource } }): boolean;
  readonly dropped: { video: number };   // frames skipped under backpressure
  drain(): Promise<void>;                // until the pipe took everything queued
  end(): Promise<EndInfo>;               // `end` record: drain, then teardown
}
```

- **Timestamps**: microseconds; omitted = `performance.now()` since the
  stream started (fine for live sources). Must increase per track.
- **Backpressure**: video is dropped, not queued, while more than
  `maxQueuedVideoFrames` (default 2) frames' worth of bytes sit unwritten in
  the pipe; `writeVideo` then returns `false` and counts it. Audio,
  configuration and H.264 access units are never dropped (dropping one
  access unit breaks the GOP; a busy H.264 stream gets `false` from
  `drain`-style backpressure instead and the caller decides). A live loop
  stays real time and memory stays bounded; a producer that wants every
  frame awaits `drain()`.
- **Canvas** (duck-typed, no dependency): `getContext("2d").getImageData(0,
  0, w, h).data` (node-canvas, skia-canvas, @napi-rs/canvas,
  OffscreenCanvas), sized to the stream; a canvas of another size is an
  error. Pixels go as `rgba`; alpha is ignored.
- **WebCodecs**: `chunk.type === "key"`, `chunk.timestamp` (µs),
  `chunk.copyTo(buf)`; `metadata.decoderConfig.description` (avcC) is sent
  as `h264-config` when present. Configure the encoder with
  `avc: { format: "avc" }` (AVCC) or `"annexb"` (`annexB: true` per chunk
  is detected from the start code).
- **Float audio** is converted to s16le (clamped); `Uint8Array` is taken as
  s16le bytes.

### Pairing from code

- `pair(target, { onPin })`: runs `tvpipe --machine pair TARGET`; on the
  `pin-required` event the SDK awaits `onPin({ name, address, password })` and sends
  the PIN back; a rejected or aborted `onPin` cancels pairing. `pin:
  "1234"` is for receivers with a fixed PIN (`--pin`).
- `play`/`testPattern`/`share`/`stream` with `onPin`: when the session
  fails before streaming with `code: "pairing-required"`, the SDK pairs
  that receiver with `onPin` and starts the session once more. Without
  `onPin` the error surfaces (`TvpipeError`, `code` and `device`).
- Credentials stay where the CLI keeps them (`credentials.txt` in the
  config directory, the same pairing for CLI and SDK). `configDir` (or
  `TVPIPE_CONFIG_DIR`) points elsewhere, e.g. an app's own data directory.
  `discover()` marks AirPlay devices with `paired` (a new field in
  `discover --json`).

## 2. The machine interface (binary side)

A global flag `--machine` (protocol version 1). It changes only the stdio
contract; options and behaviour of the commands stay as they are.

### Events: stdout, one JSON object per line

(As implemented, with `devices` and `unpaired` added and the codes listed:
[`machine.md`](machine.md).)

The first line is always `hello`; the last line before exit is `end` (or
`error`, then the exit status). Logs move from stderr to `log` events
(stderr keeps only what is printed before `main` runs, i.e. argument parse
errors, and panics). Fields are snake_case JSON; readers ignore unknown
types and fields; new fields and types do not bump the protocol.

| `type` | When | Fields |
|---|---|---|
| `hello` | start | `protocol` (1), `version`, `command` |
| `log` | every log line at the active level | `level`, `module`, `message` |
| `receiver` | state changes | `name`, `protocol` (`cast`/`airplay`/`browser`), `state` (`connected`, `failed`, `lost`, `reconnected`, `gave-up`, `ended`, `stopped`), `error` (message, `failed`/`lost`/`gave-up`) |
| `player` | the `browser` page listens | `name`, `url` |
| `viewer` | a tab connects/leaves | `name`, `tab`, `state` (`connected`/`disconnected`) |
| `share-page` | `share` without URL listens | `url` |
| `connected` | every receiver connected (the input opens next; SLRW is read from here on) | `receivers` (names) |
| `started` | the input is open, frames flow | `route` (`passthrough`/`ffmpeg`/`builtin`/`encoded`/`browser`), `video` (`codec`, `width`, `height`, `fps`, `bitrate_kbps`), `audio` (array of `{codec, sample_rate, channels}`), `latency_ms` |
| `keyframe` | a receiver needs an IDR (encoded SLRW, control flag set) | — |
| `stats` | every second while streaming | `elapsed_ms`, `video_frames`, `audio_frames`, `receivers` (`name`, `pushed`, `dropped`, `dropped_full`, `dropped_waiting`) |
| `pin-required` | `pair` needs the TV's PIN, or its AirPlay password | `name`, `address`, `password` |
| `paired` | `pair` succeeded | `name`, `id`, `file` (the credentials path) |
| `end` | the session is over | `reason` (`eof`, `stopped`, `receivers-gone`), `receivers` (`name`, `end`: `stopped`/`ended`/`failed`, `error`, the stats) |
| `error` | the command fails | `kind` (`io`, `auth`, `not-found`, `unsupported`, `usage`, `process`, …), `code` (optional, stable: `pairing-required`, `home-only`, `forbidden`, `password-unsupported`, `ffmpeg-missing`, `no-receiver`), `message`, `device` (when about one receiver) |

In machine mode the keyframe back channel (`keyframe\n` on stdout, see
`docs/slrw.md`) becomes the `keyframe` event; nothing else is written to
stdout. `discover --json` is unchanged (it already is machine output) apart
from the new `paired`, `password_pin` and `home_only` fields.

### Commands: stdin, SLRW framing

In machine mode stdin is always SLRW (`docs/slrw.md`): the magic, then
records. One record kind is added, **kind 6 `command`**: `pts_us` ignored,
payload one UTF-8 JSON object (at most 64 KiB):

| Command | |
|---|---|
| `{"type":"stop"}` | stop now, without draining: like Ctrl-C, but exit status 0 |
| `{"type":"pin","pin":"1234"}` | the answer to `pin-required` |

Unknown commands are logged and ignored. Kind 6 is an error outside
machine mode.

A thread (the *stdin router*) owns stdin from the start:

- Command records are handled at once, whatever the session is doing
  (resolving, connecting, `--wait-for-viewer`, streaming).
- With SLRW input (`play -`), media records are handed to the input once it
  opens (after `connected`), through a bounded queue (backpressure reaches
  the writer as a full pipe). Records that arrive before the input opens
  are dropped (live frames would be stale anyway), except the last
  `h264-config` and the last `control`, which are passed on first; with the
  back channel on, a `keyframe` event follows right when the input opens.
- **EOF** (the parent closed the pipe, exited or crashed): with SLRW input
  that is open, the end of the stream (the tail plays, then teardown, as
  today); otherwise a stop request. This is the watchdog: tvpipe never
  outlives its parent, and the receivers still get their TEARDOWN/STOP.
- Without SLRW input, media records are an error (logged, ignored).

Why stdin and not a control socket or signals: stdin is the one channel
that exists on every OS, needs no port or token, and its EOF is the
parent-death signal for free. Windows has no SIGINT/SIGTERM for a child
without a console; `GenerateConsoleCtrlEvent` needs process groups and
consoles that a library cannot assume. Commands share the pipe with media,
so a `stop` waits behind at most the router's queue (a few frames) while
the input is consuming; when the input is wedged the SDK escalates.

### Exit status

0: ended or stopped (also by `stop` command or stdin EOF); 1: error (an
`error` event was written); 130: Ctrl-C/SIGTERM (unchanged).

### Rust changes, concretely

- `cli.rs`: global `--machine`.
- `src/machine.rs` (new, platform-neutral): the enabled flag, `emit(Value)`
  (one locked `writeln!` per event via `codec::json`), protocol constant,
  the stdin router (record reader on `media::slrw`, command parsing, a
  `claim()` that turns it into the `Read` for the SLRW input, PIN channel).
- `log.rs`: in machine mode lines become `log` events.
- `media::slrw::Kind::Command` (6), accepted only through the router.
- Emission points: `main` (hello, error with kind/code), `session.rs`
  (connect results, `connected`, `started`, a 1 s stats tick in
  `stream`, `end`), `session/rejoin.rs` (lost/reconnected/gave-up),
  `browser/player.rs` (player URL, viewers), `browser/share.rs` (page
  URL), the back channel writer (`keyframe`), `airplay/pair.rs`
  (`pin-required` through the router's PIN channel, `paired`),
  `net/discover.rs` (`paired`).
- `error.rs`: an optional stable `code` on `Error` (set where the cases are
  known: pairing required, ffmpeg missing, no receiver named …).
- `interrupt::request()` gains the "stop, exit 0" path for the command.
- Tests: router unit tests (commands mid-stream, pre-open drop with config
  kept, EOF both ways, malformed records never panic), event JSON shapes,
  a `play_with` session against the fake receivers checking the event
  sequence, `pair` against the fake pairing server with a PIN command.
- Docs: `docs/machine.md` (the protocol above), a line in `docs/slrw.md`
  for kind 6.

## 3. Process lifecycle (SDK)

- **Spawn**: `spawn(binary, ["--machine", …args], { stdio: "pipe",
  windowsHide: true })`, `env` with `TVPIPE_CONFIG_DIR` when given. The SDK
  writes the SLRW magic first thing (every command).
- **Readiness**: `hello` must arrive (protocol 1, else a clear version
  error); `play`/`testPattern`/`share URL` resolve on `started`, `stream`
  resolves on `connected` (the input opens only when frames come, e.g. the
  encoded route reads the first keyframe), `share` without URL resolves on
  `share-page`. Exit or `error` before that rejects with `TvpipeError`.
- **Stop**: `stop()` sends `{"type":"stop"}` and closes stdin; after
  `stopTimeout` (5 s) without exit: `SIGTERM` (Unix; tvpipe still tears
  down) and after 2 s more `SIGKILL` (Windows: `TerminateProcess` right
  away, the only option). `end()` (streams) writes the `end` record and
  closes stdin, then waits like `stop()` with the latency added.
- **Parent death**: covered by the stdin-EOF watchdog on every OS (Node
  exiting, crashing or being killed closes the pipe). The SDK adds no exit
  hooks; the child is `ref`'d while a session runs (`unref()` available).
- **AbortSignal**: abort → `stop()`; an already-aborted signal rejects
  before spawning.
- **Logs**: `log` events are re-emitted; the SDK keeps the last ~50 lines
  (and stderr) for error messages.
- **Windows**: binary is `tvpipe.exe`; pipes are binary-safe (no
  PowerShell in between); `windowsHide`; no signals (above).

## 4. Binary resolution

1. `binary` option, 2. `TVPIPE_BINARY` env var, 3. the platform package
`@tvpipe/${process.platform}-${process.arch}` resolved with
`createRequire(import.meta.url).resolve(pkg + "/package.json")` →
`bin/tvpipe[.exe]`. Not found: `TvpipeError` with code
`binary-missing` naming the package, the platform, and the fixes
(`npm install` without `--no-optional`/`--omit=optional`, or
`TVPIPE_BINARY=/path/to/tvpipe`). Unsupported platform (e.g. FreeBSD,
32-bit): the same with the list of supported ones. No silent `PATH`
fallback (a different version would speak another protocol); `TVPIPE_BINARY=$(which tvpipe)`
is the explicit way. The `hello` event checks the protocol.

The main package also has a `bin` named `tvpipe` (`npx -p @tvpipe/sdk
tvpipe …`), a small JS shim that runs the resolved binary with inherited
stdio and its exit status.

## 5. Packaging

```
npm/
  tvpipe/                     the SDK (source of the `@tvpipe/sdk` package)
    package.json              type: module, engines node >= 22, exports, bin;
                              the version is the crate's (CI checks); the
                              optionalDependencies are added when staging
    tsconfig.json             erasableSyntaxOnly, rewriteRelativeImportExtensions,
                              declaration, declarationMap
    src/*.ts                  imports use .ts extensions
    test/*.test.ts            node --test, run straight from source
    examples/canvas-tone.ts
    README.md
  scripts/
    build-packages.mjs        stage packages: npm/dist/sdk (built JS + .d.ts + src,
                              optionalDependencies @tvpipe/* pinned to the version),
                              npm/dist/tvpipe-<os>-<cpu> (@tvpipe/<os>-<cpu>: the binary
                              from a release archive, or --local PATH, LICENSE files)
    publish-packages.mjs      npm publish in order (platforms first), skipping
                              versions already published; --dry-run, --provenance
```

- **TypeScript**: erasable syntax only (no enums, namespaces, parameter
  properties, emitting decorators); `tsc` (devDependency) builds `dist/*.js`
  + `.d.ts` + maps. Ships `dist/` and `src/` (go-to-definition lands in
  readable source). Node does not strip types inside `node_modules`, so the
  `exports` point at `dist/*.js`; `.ts` sources are for tests and reading.
  ESM only (Node ≥ 22.12 can `require()` it).
- **Platform packages**: `@tvpipe/darwin-arm64`, `darwin-x64`, `linux-x64`,
  `linux-arm64`, `win32-x64`, `win32-arm64`; `os`/`cpu` fields, `files:
  ["bin", "LICENSE", "LICENSES"]`, license `Apache-2.0 AND
  LGPL-3.0-or-later` (the binary includes the FairPlay module), mode 0755.
  Linux uses the static musl binaries, so glibc and musl distributions both
  work and no `libc` field is needed. The SDK package itself is
  Apache-2.0.
- **Versions in lockstep**: every package has the crate's version; the
  SDK's optionalDependencies pin it exactly. Prereleases (`0.2.0-rc.1`) get
  the `next` dist-tag.
- **Release job** (`release.yml`, `npm` job after `build` and `release`):
  downloads the six archives, builds and type-checks the SDK, runs its
  tests against the linux-x64 release binary, stages the packages and
  `npm pack`s them, then:
  - tag push: `publish-packages.mjs --provenance`: `npm publish
    --provenance --access public` for the six platform packages first, then
    `@tvpipe/sdk`, authenticated by **npm trusted publishing** (OIDC; job
    permission `id-token: write`, npm ≥ 11.5.1, no token anywhere); an
    already published version is skipped so a rerun completes.
  - `workflow_dispatch` (dry run): `npm publish --dry-run` and the
    tarballs kept as the `npm-dry-run` workflow artifact.
- **One-time setup** (done by the maintainers, not by CI): the npm org
  `tvpipe` owns the `@tvpipe/*` scope; the seven packages were published
  once by hand (trusted publishing can only be configured for packages
  that exist), then each got a trusted publisher: GitHub repository
  `mitsuhiko/tvpipe`, workflow `release.yml`, no environment
  (`npm trust github <pkg> --repo mitsuhiko/tvpipe --file release.yml
  --allow-publish`; this needs the owner's 2FA, a token cannot do it).
  Until 0.3.0 the trusted publishers were in fact missing: the OIDC
  exchange failed, npm fell back to setup-node's placeholder token and the
  publish died with a 404 (0.1.2 and 0.2.0 were published by hand;
  `publish-packages.mjs` now names the likely cause). They were set up for
  0.3.0, whose packages CI published. `npm trust list <pkg>` shows a
  package's configuration; a new package needs the same first publish by
  hand and the same command.
- **Releasing**: bump the version in `Cargo.toml`, `Cargo.lock` and
  `npm/tvpipe/package.json` together (CI fails when they differ), tag
  `vX.Y.Z`.
- CI (`ci.yml`): an `sdk` job (Linux/macOS/Windows) building the debug
  binary and running `node --test` with `TVPIPE_BINARY` set.

## 6. Tests

`node --test` from source (`npm/tvpipe/test/`), against `target/debug/tvpipe`
(`TVPIPE_BINARY`, built by `cargo build` first):

- binary resolution and its errors; SLRW encoding known answers.
- `testPattern({ to: "browser" })`: hello → started, `playerUrl`; a
  WebSocket client (Node's global `WebSocket`) receives `config` and video
  records; `stop()` → `end` with reason `stopped`, exit 0.
- `stream()` raw RGBA + PCM to `browser`: frames arrive at the viewer,
  backpressure drops are counted, `end()` drains.
- `stream()` encoded H.264: `keyframe` events (the binary's built-in
  encoder is not reachable from Node, so the fixture is a short H.264
  elementary stream, `npm/tvpipe/test/fixtures/testsrc-64x48-30.h264`,
  made with ffmpeg/x264 with access unit delimiters).
- watchdog: killing the Node side's pipe ends tvpipe; AbortSignal;
  `await using`.
- `pair()` against tvpipe's fake pairing server is Rust-side only (it
  lives in the test binary); the SDK's PIN path is tested with a stub
  binary (a small Node script that speaks the protocol).
- `discover()`, receiver choice without `to`, pairing with `onPin` and on
  demand, protocol mismatch: against the stub binary (Unix only; Windows
  cannot spawn a script without a shell).

Example (`examples/canvas-tone.ts`): a moving RGBA test card (no canvas
library) and a 440 Hz tone to `--to browser`, printing the player URL.

## 7. Docs

- `npm/tvpipe/README.md` (the npm page): install, the examples above,
  platform notes (ffmpeg only for files/capture, receivers, pairing,
  configuration), the API reference in short.
- README.md: a short "Node.js" section linking to it.
- A manual page for the website (`site/manual/node.md` or text handed to
  the website session).

## Decisions

1. The flag is `--machine`.
2. In machine mode logs are only `log` events; the SDK re-emits them
   (`session.on("log")`) and can mirror them to stderr (`logs` option).
3. The SDK's player port defaults to 0 (any free port); `player: { port }`
   overrides it.
4. `stream()` uses the built-in encoder by default (no ffmpeg, keyframes
   on demand); `encoder: "auto" | "x264" | …` opts into ffmpeg.
5. `ci.yml` has an `sdk` job on Linux, macOS and Windows.
6. Without `to`, sessions use the only receiver with video on the network;
   otherwise `no-receivers` or `ambiguous-receiver` (listing them).
7. Package names: `@tvpipe/sdk` and `@tvpipe/<os>-<cpu>`. npm refused the
   unscoped `tvpipe` as too similar to the existing `unpipe`; the command
   line shim keeps the name `tvpipe` (`npx -p @tvpipe/sdk tvpipe`).
