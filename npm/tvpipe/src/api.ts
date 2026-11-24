/**
 * The functions: discover, pair, unpair, play, testPattern, preview,
 * share, stream, version.
 */

import { execFile } from "node:child_process";

import { resolveBinary, type BinaryOptions } from "./binary.ts";
import { TvpipeError } from "./errors.ts";
import type { DevicesEvent, RawDevice, StartedEvent, TunnelProvider, TvpipeEvent } from "./events.ts";
import { TvpipeProcess, type ProcessOptions } from "./process.ts";
import { PageSession, PlaySession, Session, type SessionOptions } from "./session.ts";
import { StreamSession, type AudioSpec, type VideoSpec } from "./stream.ts";

// ---------------------------------------------------------------------------
// Devices

/** A receiver on the network. */
export interface Device {
  name: string;
  /** e.g. `AppleTV14,1`, `Chromecast`. */
  model: string | undefined;
  addresses: string[];
  protocols: ("airplay" | "cast")[];
  /** Whether it can show video (Cast video or AirPlay mirroring). */
  video: boolean;
  /** AirPlay: whether tvpipe has a pairing for it (`undefined`: not AirPlay). */
  paired: boolean | undefined;
  /** AirPlay: whether it asks for a PIN (pair it first). */
  pin: boolean | undefined;
  /** AirPlay: it shows no PIN, its AirPlay password is what `onPin` returns. */
  passwordPin: boolean | undefined;
  /** AirPlay: only members of its Apple Home may use it (`home-only`). */
  homeOnly: boolean | undefined;
  /** What `discover --json` says, camelCased. */
  airplay: Record<string, unknown> | undefined;
  raop: Record<string, unknown> | undefined;
  cast: Record<string, unknown> | undefined;
}

export interface DiscoverOptions extends ProcessOptions {
  /** How long to browse (ms, default 3000). */
  timeout?: number | undefined;
  /** Also browse from these local IPv4 addresses. */
  interfaces?: string[] | undefined;
  signal?: AbortSignal | undefined;
}

function toDevice(d: RawDevice): Device {
  const ap = d.airplay ?? d.raop;
  const protocols: Device["protocols"] = [];
  if (ap) protocols.push("airplay");
  if (d.cast) protocols.push("cast");
  const bool = (o: Record<string, unknown> | undefined, k: string) =>
    typeof o?.[k] === "boolean" ? (o[k] as boolean) : undefined;
  return {
    name: d.name,
    model: d.model,
    addresses: d.addresses ?? [],
    protocols,
    video: bool(d.cast, "video") === true || bool(d.airplay, "mirroring") === true,
    paired: ap ? (bool(d.airplay, "paired") ?? bool(d.raop, "paired") ?? false) : undefined,
    pin: ap ? (bool(d.airplay, "pin") ?? bool(d.raop, "pin")) : undefined,
    passwordPin: ap ? (bool(d.airplay, "password_pin") ?? bool(d.raop, "password_pin") ?? false) : undefined,
    homeOnly: ap ? (bool(d.airplay, "home_only") ?? bool(d.raop, "home_only") ?? false) : undefined,
    airplay: d.airplay,
    raop: d.raop,
    cast: d.cast,
  };
}

/** Receivers on the local network (AirPlay and Cast, merged per device). */
export async function discover(options: DiscoverOptions = {}): Promise<Device[]> {
  const args = ["discover", "--timeout", String((options.timeout ?? 3000) / 1000)];
  for (const i of options.interfaces ?? []) args.push("--interface", i);
  const proc = new TvpipeProcess(args, options);
  let found: DevicesEvent | undefined;
  proc.on("event", (ev) => {
    if (ev.type === "devices") found = ev;
  });
  const abort = () => proc.stop(1000);
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    const exit = await proc.exited;
    if (options.signal?.aborted) throw abortError(options.signal);
    if (exit.code !== 0 || !found) throw proc.error("discovery failed");
    return found.devices.map(toDevice);
  } finally {
    options.signal?.removeEventListener("abort", abort);
  }
}

// ---------------------------------------------------------------------------
// Pairing

/** What `onPin` gets: the receiver that shows the PIN. */
export interface PinRequest {
  name: string;
  address: string;
  /** It shows no PIN and has an AirPlay password: return the password. */
  password: boolean;
}

/** Asked for the PIN the TV shows; return it (or throw to cancel). */
export type PinCallback = (request: PinRequest) => string | Promise<string>;

export interface PairOptions extends ProcessOptions {
  /** Asked for the PIN the TV shows. */
  onPin?: PinCallback | undefined;
  /** A receiver with a fixed PIN (no PIN on screen). */
  pin?: string | undefined;
  signal?: AbortSignal | undefined;
}

export interface PairResult {
  name: string;
  model: string | undefined;
  /** The credentials file (the tvpipe command always has one). */
  file: string | undefined;
}

/**
 * Pairs with an AirPlay receiver (Apple TV): the TV shows a PIN, `onPin`
 * returns it. The pairing is stored in tvpipe's config directory (shared
 * with the CLI; see `configDir`).
 */
export async function pair(target: string | Device, options: PairOptions = {}): Promise<PairResult> {
  const name = typeof target === "string" ? target : target.name;
  if (options.signal?.aborted) throw abortError(options.signal);
  const args = ["pair", name];
  if (options.pin !== undefined) args.push("--pin", options.pin);
  const proc = new TvpipeProcess(args, options);
  let paired: PairResult | undefined;
  let cancelled: unknown;
  proc.on("event", (ev) => {
    if (ev.type === "paired") paired = { name: ev.name, model: ev.model, file: ev.file };
    if (ev.type === "pin-required") {
      const onPin = options.onPin;
      if (!onPin) {
        const what = ev.password === true ? "asks for its AirPlay password" : "shows a PIN";
        cancelled = new TvpipeError("pin-missing", `${ev.name} ${what}: pass onPin to pair()`, { device: ev.name });
        proc.endInput();
        return;
      }
      Promise.resolve()
        .then(() => onPin({ name: ev.name, address: ev.address, password: ev.password === true }))
        .then(
          (pin) => {
            // As returned but for a line ending: tvpipe trims a PIN itself,
            // a password may have spaces.
            proc.command({ type: "pin", pin: String(pin).replace(/[\r\n]+$/, "") });
          },
          (err: unknown) => {
            cancelled = err;
            proc.endInput();
          },
        );
    }
  });
  const abort = () => {
    cancelled = abortError(options.signal!);
    void proc.stop(1000);
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    const exit = await proc.exited;
    if (cancelled) throw cancelled;
    if (exit.code !== 0 || !paired) throw proc.error("pairing failed");
    return paired;
  } finally {
    options.signal?.removeEventListener("abort", abort);
    proc.endInput();
  }
}

/** Forgets the pairing with a receiver. Resolves with the names forgotten. */
export async function unpair(target: string | Device, options: ProcessOptions = {}): Promise<string[]> {
  const proc = new TvpipeProcess(["unpair", typeof target === "string" ? target : target.name], options);
  const names: string[] = [];
  proc.on("event", (ev) => {
    if (ev.type === "unpaired") names.push(ev.name);
  });
  const exit = await proc.exited;
  if (exit.code !== 0) throw proc.error("unpair failed");
  return names;
}

// ---------------------------------------------------------------------------
// Sessions

/** A receiver: a name (`"Living Room"`, a unique prefix), `airplay:NAME`, `cast:NAME`, an address, `"browser"`, or a discovered device. */
export type Target = string | Device;

export interface PlayerOptions {
  /** Port on 127.0.0.1 (default 0: any free port; the CLI's stable one is 8765). */
  port?: number | undefined;
  /** Open the page in the default browser. */
  open?: boolean | undefined;
  /** Start streaming once a tab watches. */
  waitForViewer?: boolean | undefined;
  /** A new URL token (old URLs stop working). */
  newToken?: boolean | undefined;
  /**
   * Also on a public https link for people elsewhere (`session.publicUrl`):
   * `true` is Cloudflare, or name the provider. `play`/`preview`/`testPattern` only.
   */
  tunnel?: boolean | TunnelProvider | undefined;
  /** With `tunnel`: new viewers get in for this many minutes only. */
  tunnelTtl?: number | undefined;
}

function tunnelArgs(tunnel: boolean | TunnelProvider | undefined, ttl: number | undefined): string[] {
  if (!tunnel) {
    if (ttl !== undefined) throw new TvpipeError("invalid-argument", "`tunnelTtl` needs `tunnel`");
    return [];
  }
  const args = [tunnel === true ? "--tunnel" : `--tunnel=${tunnel}`];
  if (ttl !== undefined) args.push("--tunnel-ttl", String(ttl));
  return args;
}

export interface CommonOptions extends ProcessOptions, SessionOptions {
  /**
   * Where to stream. Omitted: the only receiver with video on the
   * network (an error lists them when there are several).
   */
  to?: Target | Target[] | undefined;
  /** Playout delay in ms, the same on every receiver (5–2000). */
  latency?: number | undefined;
  /** Output size limit. */
  size?: string | { width: number; height: number } | undefined;
  fps?: number | undefined;
  /** Video bitrate in kbit/s. */
  bitrate?: number | undefined;
  /** `false`: video only. */
  audio?: boolean | undefined;
  /** Seconds a receiver that dropped out is reconnected (default 120, 0: off). */
  reconnect?: number | undefined;
  /** The `browser` receiver's page. */
  player?: PlayerOptions | undefined;
  /** Asked for an AirPlay PIN when a receiver needs pairing; the session then starts again. */
  onPin?: PinCallback | undefined;
  /** How long to look for a receiver when `to` is omitted (ms, default 3000). */
  discoverTimeout?: number | undefined;
}

export type Encoder = "auto" | "builtin" | "x264" | "videotoolbox" | "nvenc" | "qsv" | "vaapi" | "mf";

export interface PlayOptions extends CommonOptions {
  loop?: boolean | undefined;
  /** Pace the input in real time (default: files yes, live sources no). */
  realtime?: boolean | undefined;
  encoder?: Encoder | undefined;
  /** Path to ffmpeg (default: `$TVPIPE_FFMPEG`, then `PATH`). */
  ffmpeg?: string | undefined;
}

/** A file path, a URL, or ffmpeg input arguments (capture devices). */
export type Input = string | URL | { ffmpeg: string[] };

function targetName(t: Target): string {
  return typeof t === "string" ? t : t.name;
}

/** `to` resolved: the only video receiver when none was given. */
async function targets(options: CommonOptions): Promise<string[]> {
  if (options.to !== undefined) {
    const list = (Array.isArray(options.to) ? options.to : [options.to]).map(targetName);
    if (list.length === 0) throw new TvpipeError("invalid-argument", "`to` is empty");
    return list;
  }
  const devices = (await discover({ ...options, timeout: options.discoverTimeout ?? 3000 })).filter((d) => d.video);
  if (devices.length === 1) return [devices[0]!.name];
  if (devices.length === 0) {
    throw new TvpipeError(
      "no-receivers",
      "no AirPlay or Cast receiver with video found on the network; pass `to` (a name, an address, or \"browser\" for a browser tab)",
    );
  }
  const names = devices.map((d) => d.name);
  throw new TvpipeError(
    "ambiguous-receiver",
    `found ${devices.length} receivers, pass \`to\` to pick one or more: ${names.map((n) => JSON.stringify(n)).join(", ")}`,
    { details: { devices } },
  );
}

function commonArgs(to: string[], o: CommonOptions): string[] {
  const args: string[] = [];
  for (const t of to) args.push("--to", t);
  if (o.latency !== undefined) args.push("--latency", String(Math.round(o.latency)));
  if (o.size !== undefined) args.push("--size", typeof o.size === "string" ? o.size : `${o.size.width}x${o.size.height}`);
  if (o.fps !== undefined) args.push("--fps", String(o.fps));
  if (o.bitrate !== undefined) args.push("--bitrate", String(Math.round(o.bitrate)));
  if (o.audio === false) args.push("--no-audio");
  if (o.reconnect !== undefined) args.push("--reconnect", String(o.reconnect));
  if (to.some((t) => t.toLowerCase() === "browser")) {
    const p = o.player ?? {};
    args.push("--port", String(p.port ?? 0));
    if (p.open) args.push("--open");
    if (p.waitForViewer) args.push("--wait-for-viewer");
    if (p.newToken) args.push("--new-token");
    args.push(...tunnelArgs(p.tunnel, p.tunnelTtl));
  } else if (o.player) {
    throw new TvpipeError("invalid-argument", "`player` options need a \"browser\" receiver in `to`");
  }
  return args;
}

function playArgs(o: PlayOptions): string[] {
  const args: string[] = [];
  if (o.loop) args.push("--loop");
  if (o.realtime === true) args.push("--realtime");
  if (o.realtime === false) args.push("--no-realtime");
  if (o.encoder) args.push("--encoder", o.encoder);
  if (o.ffmpeg) args.push("--ffmpeg", o.ffmpeg);
  return args;
}

function abortError(signal: AbortSignal): TvpipeError {
  return new TvpipeError("aborted", "aborted", { cause: signal.reason });
}

type Ready = (ev: TvpipeEvent) => boolean;

/**
 * Starts a session and resolves once `ready` saw its event; with `onPin`,
 * pairs a receiver that needs it and starts once more.
 */
async function start<S extends Session>(
  options: CommonOptions,
  build: (to: string[]) => string[],
  make: (proc: TvpipeProcess) => S,
  ready: Ready,
): Promise<S> {
  if (options.signal?.aborted) throw abortError(options.signal);
  const to = await targets(options);
  const paired = new Set<string>();
  for (;;) {
    try {
      return await startOnce(options, build(to), make, ready);
    } catch (err) {
      const device = err instanceof TvpipeError && err.code === "pairing-required" ? err.device : undefined;
      if (!device || !options.onPin || paired.has(device)) throw err;
      paired.add(device);
      await pair(device, { ...options, onPin: options.onPin });
    }
  }
}

export async function startOnce<S extends Session>(
  options: CommonOptions,
  args: string[],
  make: (proc: TvpipeProcess) => S,
  ready: Ready,
): Promise<S> {
  const proc = new TvpipeProcess(args, options);
  const session = make(proc);
  return new Promise<S>((resolve, reject) => {
    let settled = false;
    const settle = (f: () => void) => {
      if (!settled) {
        settled = true;
        session.off("event", onEvent);
        f();
      }
    };
    const onEvent = (ev: TvpipeEvent) => {
      if (ready(ev)) settle(() => resolve(session));
    };
    session.on("event", onEvent);
    session.done.then(
      () =>
        settle(() =>
          reject(
            options.signal?.aborted
              ? abortError(options.signal)
              : new TvpipeError("closed", "the session ended before it started", { log: session.log }),
          ),
        ),
      (err: unknown) => settle(() => reject(options.signal?.aborted ? abortError(options.signal) : err)),
    );
  });
}

const isStarted: Ready = (ev) => ev.type === "started";

/**
 * Plays a file, URL or capture device. Resolves once streaming started;
 * the session ends at the end of the input (`done`) or with `stop()`.
 * Files and URLs with a length seek and pause ({@link PlaySession}).
 */
export function play(input: Input, options: PlayOptions = {}): Promise<PlaySession> {
  const inputArgs =
    typeof input === "object" && !(input instanceof URL) ? ["--", ...input.ffmpeg] : [String(input)];
  return start(
    options,
    (to) => ["play", ...commonArgs(to, options), ...playArgs(options), ...inputArgs],
    (proc) => new PlaySession(proc, options),
    isStarted,
  );
}

/** The built-in test pattern (a clock, a frame counter, a beep and flash every second); no ffmpeg needed. */
export function testPattern(options: PlayOptions = {}): Promise<Session> {
  return start(
    options,
    (to) => ["debug", "pattern", ...commonArgs(to, options), ...playArgs(options)],
    (proc) => new Session(proc, options),
    isStarted,
  );
}

/**
 * Plays to a browser tab on this computer (`to: "browser"` plus whatever
 * `to` adds); `session.playerUrl` is the page. Without input: the test pattern.
 */
export function preview(input: Input, options?: PlayOptions): Promise<PlaySession>;
export function preview(input?: undefined, options?: PlayOptions): Promise<Session>;
export function preview(input?: Input, options: PlayOptions = {}): Promise<Session> {
  const extra = options.to === undefined ? [] : Array.isArray(options.to) ? options.to : [options.to];
  const opts = { ...options, to: ["browser", ...extra.filter((t) => targetName(t).toLowerCase() !== "browser")] };
  return input === undefined ? testPattern(opts) : play(input, opts);
}

export interface ShareOptions extends CommonOptions {
  /** Open the share page (without URL) or the `browser` player page. */
  open?: boolean | undefined;
  /** With URL: show the browser window (e.g. to log in). */
  visible?: boolean | undefined;
  /** With URL: keep the browser profile (logins) in this directory. */
  profile?: string | undefined;
  /** With URL: reload the page every this many minutes. */
  reload?: number | undefined;
  /** With URL: the Chromium-based browser to run (default: `$TVPIPE_BROWSER`, Chrome, Edge, …). */
  browser?: string | undefined;
  /**
   * Without URL: also put the share page on a public https link
   * (`session.publicUrl`; resolves once it works): someone elsewhere can
   * share their screen. `true` is Cloudflare, or name the provider.
   */
  tunnel?: boolean | TunnelProvider | undefined;
  /** With `tunnel`: the link lets people in for this many minutes (default 60, 0: no limit). */
  tunnelTtl?: number | undefined;
  /**
   * With `tunnel`: show remote shares without asking. Required for them to
   * show at all: tvpipe asks on a terminal, which an SDK session has not.
   */
  yes?: boolean | undefined;
}

/**
 * Shares a web page (rendered by a headless Chromium of tvpipe's own;
 * `session.navigate(url)` shows another one in the same tab) or, without
 * URL, whatever a person picks on the share page (`session.shareUrl`;
 * resolves once that page listens).
 */
export function share(url: string | URL, options: ShareOptions): Promise<PageSession>;
export function share(options: ShareOptions): Promise<Session>;
export function share(a: string | URL | ShareOptions, b?: ShareOptions): Promise<Session> {
  const url = typeof a === "string" || a instanceof URL ? String(a) : undefined;
  const options = (url === undefined ? a : b) as ShareOptions;
  const build = (to: string[]) => {
    if (options.player?.tunnel) {
      throw new TvpipeError("invalid-argument", "`share` puts the share page on a link (`tunnel`), not the player");
    }
    const args = ["share", ...commonArgs(to, options)];
    if (options.open) args.push("--open");
    if (url !== undefined && options.tunnel) {
      throw new TvpipeError("invalid-argument", "`tunnel` is for `share()` without URL");
    }
    args.push(...tunnelArgs(options.tunnel, options.tunnelTtl));
    if (options.yes) args.push("--yes");
    if (url !== undefined) {
      if (options.visible) args.push("--visible");
      if (options.profile) args.push("--profile", options.profile);
      if (options.reload !== undefined) args.push("--reload", String(options.reload));
      if (options.browser) args.push("--browser", options.browser);
      args.push(url);
    }
    return args;
  };
  return start(
    options,
    build,
    (proc) => (url !== undefined ? new PageSession(proc, options) : new Session(proc, options)),
    url !== undefined ? isStarted : options.tunnel ? (ev) => ev.type === "tunnel" : (ev) => ev.type === "share-page",
  );
}

export interface StreamOptions extends Omit<CommonOptions, "audio"> {
  video: VideoSpec;
  audio?: AudioSpec | undefined;
  /**
   * Raw frames: the encoder (default `builtin`: no ffmpeg, keyframes on
   * demand; `auto` and the others use ffmpeg).
   */
  encoder?: Encoder | undefined;
  ffmpeg?: string | undefined;
  /** Raw frames: drop while this many frames wait in the pipe (default 2). */
  maxQueuedFrames?: number | undefined;
}

/**
 * Streams frames the program makes: raw pixels (`writeVideo`, a canvas),
 * PCM (`writeAudio`), or H.264 (`writeH264`, WebCodecs `writeChunk`).
 * Resolves once the receivers are connected; write from then on.
 */
export async function stream(options: StreamOptions): Promise<StreamSession> {
  const v = options.video;
  if (!(v.width > 0 && v.height > 0 && v.width % 2 === 0 && v.height % 2 === 0)) {
    throw new TvpipeError("invalid-argument", "video width and height must be positive and even");
  }
  if (!(v.fps > 0)) throw new TvpipeError("invalid-argument", "video fps must be positive");
  const encoded = "codec" in v;
  const pixfmt = encoded ? "h264" : (v.format ?? "rgba");
  // `audio` is a spec here, not CommonOptions' boolean.
  const common: CommonOptions = { ...options, audio: undefined };
  const build = (to: string[]) => {
    const args = ["play", ...commonArgs(to, common), "--raw-video", `${v.width}x${v.height}@${v.fps}:${pixfmt}`];
    const a = options.audio;
    if (a) args.push("--raw-audio", `${a.sampleRate}:${a.channels}:s16le`);
    if (!encoded) args.push("--encoder", options.encoder ?? "builtin");
    if (options.ffmpeg) args.push("--ffmpeg", options.ffmpeg);
    args.push("-");
    return args;
  };
  return start(
    common,
    build,
    (proc) =>
      new StreamSession(proc, {
        ...options,
        video: v,
        audio: options.audio,
        latencyMs: options.latency,
      }),
    (ev) => ev.type === "connected",
  );
}

// ---------------------------------------------------------------------------

/** The binary's version (`tvpipe --version`). */
export function version(options: BinaryOptions = {}): Promise<string> {
  const binary = resolveBinary(options);
  return new Promise((resolve, reject) => {
    execFile(binary, ["--version"], { windowsHide: true }, (err, stdout) => {
      if (err) reject(new TvpipeError("binary-missing", `cannot run ${binary}: ${err.message}`, { cause: err }));
      else resolve(stdout.trim().replace(/^tvpipe\s+/, ""));
    });
  });
}

export type { StartedEvent };
