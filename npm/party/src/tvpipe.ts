/**
 * The local API of `tvpipe game play` (docs/playshare-design.md §5): the
 * launcher and the host page talk to tvpipe with it. One WebSocket
 * (`/_tvpipe/api`, the session cookie or `?t=TOKEN`): calls, events, and
 * the relay of the phones' connections once the host attaches.
 *
 *   const tvpipe = await Tvpipe.connect();
 *   const party = await tvpipe.party({ lateJoin: "wait" });   // the host
 *   await party.cast();                                      // the TV page on the chosen TVs
 *   await party.changeCast();                                // the cast picker: other TVs, resolution
 *   await tvpipe.showGamePicker();                           // the games list: the next game
 */

import { Emitter } from "./emitter.ts";
import { Party, type PartyOptions, type Player } from "./party.ts";
import { showPairDialog } from "./pair-dialog.ts";
import { frameLink } from "./frame.ts";
import { showRejoinDialog } from "./rejoin-dialog.ts";
import { isWeb } from "./mode.ts";
import { TvpipeRelay, type Relay } from "./relay.ts";
import { WebHub } from "./webhub.ts";
import { LOCAL_PREFIX, localScreen, ScreenCaster } from "./screens.ts";
import { captureAudio, SurfaceEncoder, type CanvasSource, type EncoderOptions, type SurfaceInfo } from "./surface.ts";

export interface Pages {
  host: string;
  tv: string;
  phone: string;
  launcher?: string;
}

export interface TunnelInfo {
  /** `off`, `starting`, `up`, `failed`. */
  state: string;
  provider?: string;
  /** `https://HOST/` once up. */
  url?: string;
  error?: string;
}

/**
 * The TV picture's resolution (docs/playshare-design.md §9.1): the TV page
 * keeps its layout, tvpipe renders it at this size. `auto`: what the TVs
 * take, at most 1080p.
 */
export type Resolution = "auto" | "720p" | "1080p" | "2160p";

/** What the launcher (or the cast picker) chose. */
export interface Selection {
  devices: string[];
  /** `null`: the game's `tv.resolution` is `fixed`. */
  resolution: Resolution | null;
}

/** `info`: the game and how phones reach it. */
export interface Info {
  name: string;
  title: string;
  players: { min: number; max: number };
  /** Absolute paths on the local origin. */
  pages: Pages;
  tv: { width: number; height: number; resolution: "choice" | "fixed" } | null;
  /** The resolutions people may choose (empty: the game's is fixed). */
  resolutions: Resolution[];
  /**
   * `frame`: the frame page (`https://tvpipe.party/p`, docs/short-links.md)
   * phones open the tunnel's join link in; absent when tvpipe's short
   * links are off (and from an older tvpipe). `web`: tvpipe.party in the
   * browser (docs/browser-party-design.md), `url` its `/r/`.
   */
  phone: { url: string; mode: "tunnel" | "lan" | "local" | "web"; lan?: string; frame?: string };
  tunnel: TunnelInfo;
  /** `http://127.0.0.1:PORT`. */
  local: string;
  version: string;
  /**
   * Test mode (`tvpipe game play --dev`): the host page may offer its
   * test tools (bots: dummy players that join and play). An older
   * tvpipe has none: not in test mode.
   */
  dev?: boolean;
  /**
   * The room of the run: every game's party has this code and join key,
   * so the join link stays from game to game (docs/game-switching.md).
   * An older tvpipe has none: the party makes its own.
   */
  room?: { code: string; key: string };
  /** The run's games counted: 1 for the first. */
  game?: number;
}

/** `game`: another game is in tvpipe's slot; pages go to `url`. */
export interface NextGame {
  name: string;
  title: string;
  /** The new game's host page when TVs are chosen, else its launcher. */
  url: string;
}

/** A receiver the launcher can pick. */
export interface Device {
  name: string;
  /** `browser`: a tab on this computer (no TV needed). */
  kind: "airplay" | "cast" | "both" | "browser";
  model?: string;
  title?: string;
  /** AirPlay: shows a PIN (or takes its password for one) and has no pairing here yet. */
  needsPairing?: boolean;
  /** AirPlay: its Apple Home lets only its members use it; no pairing helps. */
  homeOnly?: boolean;
  paired?: boolean;
  /** The TV's display lag as measured by the launcher's Sync (`setDisplayLag`), ms. */
  displayMs?: number;
}

export interface PairStatus {
  device: string;
  state: "connecting" | "pin" | "done" | "failed";
  /** With `pin`: the TV shows no code; its password is what to type. */
  password?: boolean;
  error?: string;
}

export interface ReceiverStatus {
  name: string;
  /** What people call it (web mode's screens: "This screen", …). */
  title?: string;
  protocol?: string;
  /** `connected`, `failed`, `lost`, `reconnected`, `gave-up`, `ended`, `stopped`. */
  state: string;
  error?: string;
  code?: string;
  /**
   * Once connected: the playout delay it shows video with, ms after the
   * frame was drawn (Cast's target delay, AirPlay's video lead, the
   * player page's delay); the TV's own lag comes on top.
   */
  delayMs?: number;
  /** That lag, when it was measured for this TV (`setDisplayLag`), ms. */
  displayMs?: number;
}

/**
 * What a TV adds to its receiver's playout delay, ms: its own picture
 * processing (not in game mode) and the receiver's output. Measured: an
 * Apple TV 4K at a 100 ms lead showed frames ~250 ms after they were
 * made (docs/measurements.md).
 */
export const TV_DISPLAY_MS = 120;
/** From a change in the host to the frame that shows it: a page renders, the frame is captured, ms. */
export const TV_RENDER_MS = 30;

/**
 * How far the picture of a cast or surface is behind the host, ms: the
 * slowest connected receiver's delay, with the TV's lag and a frame of
 * rendering: as measured for that TV (`displayMs`, which has both), else
 * {@link TV_DISPLAY_MS} and {@link TV_RENDER_MS} (the `browser` receiver
 * has no TV). `undefined` when no receiver is connected.
 */
export function tvDelayOf(status: CastStatus): number | undefined {
  if (status.state === "stopped" || status.state === "failed") return undefined;
  let max: number | undefined;
  for (const r of status.receivers ?? []) {
    if ((r.state !== "connected" && r.state !== "reconnected") || typeof r.delayMs !== "number") continue;
    const lag = typeof r.displayMs === "number" ? r.displayMs : TV_RENDER_MS + (r.protocol === "browser" ? 0 : TV_DISPLAY_MS);
    const d = r.delayMs + lag;
    max = Math.max(max ?? 0, d);
  }
  return max;
}

export interface CastStatus {
  state: "starting" | "streaming" | "failed" | "stopped";
  receivers?: ReceiverStatus[];
  /** The page of the `browser` receiver. */
  player?: string;
  /** The resolution asked for (none: the game's own size). */
  resolution?: Resolution;
  error?: string;
  to?: string[];
}

export interface TvpipeEvents {
  devices: [devices: Device[]];
  pair: [status: PairStatus];
  cast: [status: CastStatus];
  tunnel: [tunnel: TunnelInfo];
  /** tvpipe is ending: a second to say goodbye. */
  closing: [];
  /** Another page took the relay over. */
  detached: [];
  /** A surface's state (`id` and the status). */
  surface: [status: CastStatus & { id: number }];
  /**
   * Another game is in the slot (docs/game-switching.md): phones went to
   * their join link, this page goes to `url` right after (top-level
   * pages; set {@link Tvpipe.followGames} to `false` to go yourself).
   */
  game: [next: NextGame];
  /** The API socket closed. */
  close: [];
}

/** A refused call. */
export class TvpipeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "TvpipeError";
    this.code = code;
  }
}

export interface ConnectOptions {
  /** Default: `/_tvpipe/api` on the page's origin. */
  url?: string;
  /** The API token (pages have the session cookie instead). */
  token?: string;
  /** Default the global one. */
  WebSocket?: typeof WebSocket;
}

/** tvpipe's standard launcher. */
const LAUNCHER = "/_tvpipe/launcher/";
/** The page the launcher casts to a TV to sync it (`flashsync.ts`). */
export const TVSYNC_PAGE = "/_tvpipe/tvsync/";
/** The message the launcher in change mode sends its parent page. */
export const PICKER_MESSAGE = "tvpipe:cast-picker";
/** tvpipe's games list. */
export const GAME_PICKER = "/_tvpipe/picker/";
/** Web mode's games list in the dialog: tvpipe.party's games page (site/static/games.js). */
const WEB_GAME_PICKER = "/games/?switch";
/** The message the games list in a dialog sends its parent page (`{type, done}`). */
export const GAME_PICKER_MESSAGE = "tvpipe:game-picker";

type Waiter = { resolve: (v: any) => void; reject: (e: Error) => void };

/**
 * What answers a {@link Tvpipe}'s calls: tvpipe's API socket, or in web
 * mode `WebHub` (docs/browser-party-design.md), in the page.
 */
export interface TvpipeTransport {
  call(method: string, params: Record<string, unknown>): Promise<any>;
  /** `relay.attach`: the connections of phones and screens. */
  relay(): Promise<Relay>;
  close(): void;
  readonly closed: boolean;
  /** Set by `Tvpipe`: an event (`devices`, `cast`, `game`, …). */
  onevent: ((type: string, data: unknown) => void) | undefined;
  /** Set by `Tvpipe`: the transport ended. */
  onclose: (() => void) | undefined;
  /** Web mode: the page's party (extra screens get its watch link; Quit closes it). */
  hosted?(party: HostedParty): void;
  /** Web mode: the games list picked `game` (Other game): the room goes on with it. */
  switchGame?(game: { name: string; release?: string | undefined }): Promise<void>;
}

/** tvpipe's API socket (docs/playshare-design.md §5). */
class SocketTransport implements TvpipeTransport {
  readonly #ws: WebSocket;
  #n = 0;
  readonly #calls = new Map<number, Waiter>();
  #relay: TvpipeRelay | undefined;
  closed = false;
  onevent: ((type: string, data: unknown) => void) | undefined;
  onclose: (() => void) | undefined;

  constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.onerror = null;
    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") this.#onText(ev.data);
      else if (ev.data instanceof ArrayBuffer) this.#relay?.handleBinary(new Uint8Array(ev.data));
    };
    ws.onclose = () => {
      this.closed = true;
      const err = new TvpipeError("closed", "the connection to tvpipe closed");
      for (const w of this.#calls.values()) w.reject(err);
      this.#calls.clear();
      this.#relay?.handleDetach();
      this.onclose?.();
    };
  }

  #onText(text: string): void {
    let msg: Record<string, any>;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof msg !== "object" || msg === null) return;
    if (msg["t"] === "reply") {
      const w = this.#calls.get(msg["n"]);
      if (!w) return;
      this.#calls.delete(msg["n"]);
      if (msg["ok"]) w.resolve(msg["value"]);
      else w.reject(new TvpipeError(msg["error"]?.code ?? "failed", msg["error"]?.message ?? "failed"));
      return;
    }
    if (msg["t"] === "event") {
      if (msg["type"] === "closing") this.#relay?.onclosing?.();
      this.onevent?.(String(msg["type"]), msg["data"]);
      return;
    }
    this.#relay?.handleControl(msg);
  }

  call(method: string, params: Record<string, unknown>): Promise<any> {
    if (this.closed) return Promise.reject(new TvpipeError("closed", "the connection to tvpipe closed"));
    const n = ++this.#n;
    return new Promise((resolve, reject) => {
      this.#calls.set(n, { resolve, reject });
      this.#ws.send(JSON.stringify({ t: "call", n, method, params }));
    });
  }

  async relay(): Promise<Relay> {
    const r = await this.call("relay.attach", {});
    const ws = this.#ws;
    this.#relay = new TvpipeRelay(
      {
        sendText: (t) => ws.send(t),
        sendBinary: (d) => ws.send(d),
      },
      r.public,
    );
    return this.#relay;
  }

  close(): void {
    this.#ws.close();
  }
}

export class Tvpipe extends Emitter<TvpipeEvents> {
  /** Connects to tvpipe's API. */
  static connect(opts: ConnectOptions = {}): Promise<Tvpipe> {
    // tvpipe.party's build: answered in the page (docs/browser-party-design.md).
    if (isWeb() && !opts.url) return Promise.resolve(new Tvpipe(new WebHub()));
    let url = opts.url;
    if (!url) {
      const loc = globalThis.location;
      url = `${loc.protocol === "https:" ? "wss:" : "ws:"}//${loc.host}/_tvpipe/api`;
    }
    if (opts.token) url += `${url.includes("?") ? "&" : "?"}t=${encodeURIComponent(opts.token)}`;
    const WS = opts.WebSocket ?? globalThis.WebSocket;
    const ws = new WS(url);
    ws.binaryType = "arraybuffer";
    return new Promise((resolve, reject) => {
      ws.onopen = () => resolve(new Tvpipe(new SocketTransport(ws)));
      ws.onerror = () => reject(new TvpipeError("connect", `cannot reach tvpipe at ${url!.replace(/t=[^&]*/, "t=…")}`));
    });
  }

  readonly #transport: TvpipeTransport;
  /**
   * Whether a top-level page goes to the next game's page by itself when
   * another game is picked (the `game` event). Default `true`.
   */
  followGames = true;

  /** A `Tvpipe` on another transport (`connect()` makes the usual ones). */
  constructor(transport: TvpipeTransport) {
    super();
    this.#transport = transport;
    transport.onevent = (type, data) => this.#event(type, data);
    transport.onclose = () => this.emit("close");
  }

  /** Whether this is web mode's (answered in the page, docs/browser-party-design.md). */
  get web(): boolean {
    return this.#transport instanceof WebHub;
  }

  get closed(): boolean {
    return this.#transport.closed;
  }

  #event(type: string, data: unknown): void {
    switch (type) {
      case "devices":
        this.emit("devices", Array.isArray(data) ? data : []);
        return;
      case "pair":
        this.emit("pair", data as PairStatus);
        return;
      case "cast":
        this.emit("cast", data as CastStatus);
        return;
      case "tunnel":
        this.emit("tunnel", data as TunnelInfo);
        return;
      case "closing":
        this.emit("closing");
        return;
      case "detached":
        this.emit("detached");
        return;
      case "surface":
        this.emit("surface", data as CastStatus & { id: number });
        return;
      case "game":
        this.#nextGame(data as NextGame);
        return;
    }
  }

  #nextGame(next: NextGame): void {
    this.emit("game", next);
    const g = globalThis as any;
    if (!this.followGames || !g.location || typeof next?.url !== "string" || !next.url.startsWith("/")) return;
    // In a frame (the cast picker, a preview) the page around it goes.
    if (g.window && g.window.top !== g.window) return;
    g.location.assign(next.url);
  }

  /** Calls an API method (docs/playshare-design.md §5). */
  call<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.#transport.call(method, params);
  }

  info(): Promise<Info> {
    return this.call("info");
  }

  /** Starts (or stops) discovery; `devices` events follow. Resolves with the list so far. */
  watchDevices(on = true): Promise<Device[]> {
    return this.call("devices.watch", { on });
  }

  /**
   * The launcher's choice, kept by tvpipe across the navigation to the
   * host page: the TVs and the resolution (default: unchanged).
   */
  async select(devices: string[], opts: { resolution?: Resolution | undefined } = {}): Promise<Selection> {
    const params: Record<string, unknown> = { devices };
    if (opts.resolution) params["resolution"] = opts.resolution;
    return this.call("select", params);
  }

  /** The chosen TVs. */
  async selection(): Promise<string[]> {
    return (await this.chosen()).devices;
  }

  /** The chosen TVs and resolution. */
  chosen(): Promise<Selection> {
    return this.call("selection");
  }

  /** AirPlay PIN pairing: `pair` events say when the PIN is wanted. */
  async pair(device: string): Promise<void> {
    await this.call("pair.start", { device });
  }

  async pairPin(device: string, pin: string): Promise<void> {
    await this.call("pair.pin", { device, pin });
  }

  async pairCancel(device: string): Promise<void> {
    await this.call("pair.cancel", { device });
  }

  /**
   * Pairs an AirPlay TV in a dialog over this page: it asks the TV for a
   * code and people type what it shows. Resolves `true` once paired,
   * `false` when cancelled. {@link HostedParty} shows it by itself when
   * a cast fails because a TV needs pairing.
   */
  async showPairing(device: string): Promise<boolean> {
    if (!globalThis.document) throw new TvpipeError("unsupported", "the pairing dialog needs a page");
    return showPairDialog(this, device);
  }

  /**
   * Keeps a TV's display lag (`ms`; `null` forgets it): how much later
   * than a phone it shows a picture beyond its playout delay, as the
   * launcher's Sync measures it (`flashsync.ts`). tvpipe stores it
   * per TV; devices and cast statuses carry it as `displayMs`, and a
   * party's `tvDelay` follows.
   */
  async setDisplayLag(device: string, ms: number | null): Promise<void> {
    await this.call("tvsync.set", { device, displayMs: ms === null ? null : Math.round(ms) });
  }

  /**
   * Casts a page of this game (a path with its fragment) to `to`, at
   * `resolution` (default: the selection's). Replaces a running cast;
   * for the same TVs and picture the page goes into its tab instead (the
   * TVs keep their sessions).
   */
  cast(opts: { page: string; to?: string[] | undefined; resolution?: Resolution | undefined }): Promise<CastStatus> {
    const params: Record<string, unknown> = { page: opts.page };
    if (opts.to) params["to"] = opts.to;
    if (opts.resolution) params["resolution"] = opts.resolution;
    return this.call("cast.start", params);
  }

  /**
   * The cast picker (docs/playshare-design.md §7.1): the launcher (the
   * game's own, else tvpipe's) in a dialog over this page, to choose
   * other TVs or another resolution while the game runs. It saves the
   * choice (`select`); resolves with it, or `null` when cancelled. The
   * caller casts again (`HostedParty.changeCast` does both).
   */
  async showCastPicker(): Promise<Selection | null> {
    const doc = globalThis.document;
    if (!doc) throw new TvpipeError("unsupported", "the cast picker needs a page");
    const info = await this.info();
    const src = `${info.pages.launcher ?? LAUNCHER}?mode=change`;
    return new Promise((resolve) => {
      const dialog = doc.createElement("dialog");
      dialog.className = "tvpipe-cast-picker";
      dialog.style.cssText =
        "padding:0;border:0;border-radius:12px;width:min(760px,94vw);height:min(680px,90vh);overflow:hidden;background:transparent;box-shadow:0 20px 60px rgb(0 0 0 / 40%)";
      const frame = doc.createElement("iframe");
      frame.title = "Change the TVs";
      frame.src = src;
      frame.style.cssText = "display:block;width:100%;height:100%;border:0";
      dialog.append(frame);
      const done = (sel: Selection | null) => {
        removeEventListener("message", onMessage);
        dialog.close();
        dialog.remove();
        resolve(sel);
      };
      const onMessage = (ev: MessageEvent) => {
        if (ev.source !== frame.contentWindow || ev.origin !== globalThis.location.origin) return;
        const d = ev.data as { type?: unknown; selection?: Selection | null } | null;
        if (d?.type !== PICKER_MESSAGE) return;
        done(d.selection ?? null);
      };
      addEventListener("message", onMessage);
      dialog.addEventListener("cancel", (ev) => {
        ev.preventDefault();
        done(null);
      });
      doc.body.append(dialog);
      dialog.showModal();
    });
  }

  async stopCast(): Promise<void> {
    await this.call("cast.stop");
  }

  /**
   * tvpipe's games list in a dialog over this page
   * (docs/game-switching.md): the games on this computer and the online
   * ones, the current one marked. Resolves `true` once another game was
   * picked (tvpipe swaps it in, and the `game` event takes this page
   * there), `false` when cancelled. In web mode the list is tvpipe.party's
   * games page (`/games/?switch&current=NAME`), which names the game, and
   * this page's `WebHub` switches.
   */
  async showGamePicker(): Promise<boolean> {
    const doc = globalThis.document;
    if (!doc) throw new TvpipeError("unsupported", "the games list needs a page");
    const current = isWeb() ? ((await this.info().catch(() => null))?.name ?? "") : "";
    return new Promise((resolve) => {
      const dialog = doc.createElement("dialog");
      dialog.className = "tvpipe-game-picker";
      dialog.style.cssText =
        "padding:0;border:0;border-radius:12px;width:min(1000px,96vw);height:min(760px,92vh);overflow:hidden;background:transparent;box-shadow:0 20px 60px rgb(0 0 0 / 40%)";
      const frame = doc.createElement("iframe");
      frame.title = "Pick another game";
      frame.src = isWeb() ? `${WEB_GAME_PICKER}${current ? `&current=${encodeURIComponent(current)}` : ""}` : `${GAME_PICKER}?mode=switch`;
      frame.style.cssText = "display:block;width:100%;height:100%;border:0";
      dialog.append(frame);
      const done = (picked: boolean) => {
        removeEventListener("message", onMessage);
        dialog.close();
        dialog.remove();
        resolve(picked);
      };
      const onMessage = (ev: MessageEvent) => {
        if (ev.source !== frame.contentWindow || ev.origin !== globalThis.location.origin) return;
        const d = ev.data as { type?: unknown; picked?: unknown; game?: { name?: unknown; release?: unknown } } | null;
        if (d?.type !== GAME_PICKER_MESSAGE) return;
        // Web mode: the list names the game and this page switches (no tvpipe to do it).
        const game = d.game;
        const switchGame = this.#transport.switchGame;
        if (d.picked === true && switchGame && typeof game?.name === "string") {
          const release = typeof game.release === "string" ? game.release : undefined;
          void switchGame.call(this.#transport, { name: game.name, release }).catch((err) => console.error(err));
        }
        done(d.picked === true);
      };
      addEventListener("message", onMessage);
      dialog.addEventListener("cancel", (ev) => {
        ev.preventDefault();
        done(false);
      });
      doc.body.append(dialog);
      dialog.showModal();
    });
  }

  /**
   * A short link to the tunnel's join link `url` (docs/short-links.md):
   * tvpipe registers it at tvpipe.party (`code`: the code to ask for, the
   * room's). Rejects with `unavailable` without a tunnel, with
   * `--no-short-link` or when the service fails.
   */
  shortLink(url: string, code: string): Promise<{ url: string; code: string }> {
    return this.call("shortlink", { url, code });
  }

  /** A QR code made by tvpipe: `size` modules, `rows` of "0"/"1". */
  qr(text: string): Promise<{ size: number; rows: string[] }> {
    return this.call("qr", { text });
  }

  /**
   * Opens a surface: tvpipe streams what an encoder sends to `to`
   * (default: the selection). A worker can connect a `SurfaceEncoder`
   * with the answer.
   */
  openSurface(opts: {
    width: number;
    height: number;
    fps?: number | undefined;
    to?: string[] | undefined;
    audio?: boolean | undefined;
    bitrate?: number | undefined;
  }): Promise<SurfaceInfo> {
    const params: Record<string, unknown> = { width: opts.width, height: opts.height, fps: opts.fps ?? 30 };
    if (opts.to) params["to"] = opts.to;
    if (opts.audio) params["audio"] = true;
    if (opts.bitrate) params["bitrate"] = opts.bitrate;
    return this.call("surface.open", params);
  }

  async closeSurface(id: number): Promise<void> {
    await this.call("surface.close", { id });
  }

  /**
   * A canvas on TVs without a browser in between
   * (docs/playshare-design.md §17): opens a surface of the canvas's size
   * and encodes it here. `audio`: a Web Audio node whose sound goes along.
   */
  async surface(opts: EncoderOptions & {
    canvas: CanvasSource;
    fps?: number | undefined;
    to?: string[] | undefined;
    audio?: { context: AudioContext; node: AudioNode } | undefined;
  }): Promise<SurfaceEncoder> {
    const info = await this.openSurface({
      width: opts.canvas.width,
      height: opts.canvas.height,
      fps: opts.fps,
      to: opts.to,
      audio: !!opts.audio,
      bitrate: opts.bitrate,
    });
    const enc = new SurfaceEncoder(info, opts.canvas, opts);
    if (opts.audio && info.audio) {
      const stop = await captureAudio(opts.audio.context, opts.audio.node, info.audio.channels, (pcm, pts) => enc.pushAudio(pcm, pts));
      enc.on("end", stop);
    }
    enc.on("end", () => void this.closeSurface(info.id).catch(() => {}));
    await enc.ready;
    return enc;
  }

  /** Ends playshare (the TVs stop, phones are told). */
  async quit(): Promise<void> {
    await this.call("quit").catch(() => {});
  }

  /** Becomes the relay's host: phones' connections come here (tvpipe's relay, or web mode's `WebRtcRelay`). */
  relay(): Promise<Relay> {
    return this.#transport.relay();
  }

  /** The host: a party on the relay, its links and QR code, casting. */
  async party(options: HostedPartyOptions = {}): Promise<HostedParty> {
    const info = await this.info();
    const relay = await this.relay();
    const party = new HostedParty(this, info, relay, options);
    this.#transport.hosted?.(party);
    await party.refreshJoin();
    return party;
  }

  /** Closes the API socket (tvpipe ends after a while without a page). */
  close(): void {
    this.#transport.close();
  }
}

/** A party's links. */
export interface PartyLinks {
  /**
   * What phones open (the QR code): public with a tunnel, then on the
   * frame page (`https://tvpipe.party/p#…`) when tvpipe has short links.
   */
  join: string;
  /** The TV page with the screen key: a path on the local origin, for `cast`. */
  tv: string;
  /** A read-only screen on this computer (an `<iframe>` preview in the host page). */
  watch: string;
}

/** The error code of a receiver that needs pairing first (AirPlay with a PIN). */
export const PAIRING_REQUIRED = "pairing-required";

export interface HostedPartyOptions extends PartyOptions {
  /**
   * When a TV of {@link HostedParty.cast} fails because it needs pairing
   * (an AirPlay TV that shows a PIN, or one that forgot its pairing):
   * pairs it (resolving `true` once paired), then the party casts again.
   * Default: {@link Tvpipe.showPairing}, a dialog over the page; `false`:
   * the cast just fails.
   */
  pair?: ((device: string) => Promise<boolean>) | false;
}

/**
 * One status of two casts (the app's TVs and its local screen,
 * `local:this` / `local:cable`): their receivers together; streaming
 * when either streams. An idle one (stopped, nothing in it) leaves the
 * other as it is.
 */
export function mergeCast(a: CastStatus, b: CastStatus): CastStatus {
  const idle = (s: CastStatus) => s.state === "stopped" && !s.error && !s.receivers?.length;
  if (idle(b)) return a;
  if (idle(a)) return b;
  const states = [a.state, b.state];
  const state = states.includes("streaming") ? "streaming" : states.includes("starting") ? "starting" : states.includes("failed") ? "failed" : "stopped";
  const out: CastStatus = { state, receivers: [...(a.receivers ?? []), ...(b.receivers ?? [])] };
  const to = [...(a.to ?? []), ...(b.to ?? [])];
  if (to.length) out.to = to;
  const error = a.error ?? b.error;
  if (error) out.error = error;
  const player = a.player ?? b.player;
  if (player) out.player = player;
  const resolution = a.resolution ?? b.resolution;
  if (resolution) out.resolution = resolution;
  return out;
}

/** The receivers of a cast status that failed because they need pairing. */
export function needsPairing(status: CastStatus): string[] {
  return (status.receivers ?? []).filter((r) => r.state === "failed" && r.code === PAIRING_REQUIRED).map((r) => r.name);
}

/** A {@link Party} in a host page, with tvpipe behind it. */
export class HostedParty extends Party {
  readonly tvpipe: Tvpipe;
  readonly info: Info;
  readonly relay: Relay;
  links: PartyLinks;
  /** The delay of each picture on TVs (`cast`, `surface:ID`), for `tvDelay`. */
  readonly #pictures = new Map<string, number>();
  readonly #pair: ((device: string) => Promise<boolean>) | false;
  /** Set while this party's `cast.start` call runs (its `starting` event comes before the reply). */
  #starting = false;
  /** The running cast is this party's (not, say, the cast picker's sync page). */
  #mine = false;
  /** What the running cast was asked for, to cast it again once paired. */
  #castArgs: { to: string[] | undefined; resolution: Resolution | undefined } | null = null;
  /** The TVs paired (or offered pairing) since the last `cast()`: once each. */
  readonly #offered = new Set<string>();
  #pairing = false;
  /**
   * The app's screens beside its TVs (`local:this`: the TV page over the
   * host page; `local:cable`: in a window on the other screen), shown
   * here by screens.ts; the TV page goes through tvpipe's relay as on a TV.
   */
  readonly #local = new ScreenCaster({ prefix: LOCAL_PREFIX });
  #localPage: string | undefined;
  /** The last statuses of tvpipe's cast and of the local screen. */
  #remote: CastStatus = { state: "stopped" };
  #localStatus: CastStatus = { state: "stopped" };
  readonly #castListeners = new Set<(s: CastStatus) => void>();

  constructor(tvpipe: Tvpipe, info: Info, relay: Relay, options: HostedPartyOptions) {
    const { pair, ...rest } = options;
    super({ maxPlayers: info.players.max, code: info.room?.code, joinKey: info.room?.key, ...rest });
    this.tvpipe = tvpipe;
    this.info = info;
    this.relay = relay;
    this.#pair = pair ?? (globalThis.document ? (device) => tvpipe.showPairing(device) : false);
    this.listen(relay);
    const tv = `${info.pages.tv}#r=${this.code}&k=${this.screenKey}&role=screen`;
    this.links = {
      join: this.#phoneLinks().join,
      tv,
      // Web mode: the host page's preview over the local transport (`local=1`).
      watch: `${info.local}${info.pages.tv}#r=${this.code}&k=${this.watchKey}&role=watch${info.phone.mode === "web" ? "&local=1" : ""}`,
    };
    tvpipe.on("tunnel", (t) => {
      if (t.state === "up" && t.url) {
        this.info.phone = { ...this.info.phone, url: t.url, mode: "tunnel" };
        void this.refreshJoin();
      }
    });
    tvpipe.on("cast", (s) => {
      // A new cast (its first event names its TVs): this party's while its call runs.
      if (s.state === "starting" && s.to !== undefined) this.#mine = this.#starting;
      this.#picture("cast", s);
      this.#remote = s;
      this.#castChanged();
      if (this.#mine) void this.#pairFailed(s);
    });
    this.#local.onstatus = (s) => {
      this.#localStatus = s;
      this.#castChanged();
    };
    tvpipe.on("surface", (s) => this.#picture(`surface:${s.id}`, s));
  }

  /**
   * A picture's status: `tvDelay` follows the slowest picture on a TV
   * (kept while one restarts; gone when it stops).
   */
  #picture(key: string, s: CastStatus): void {
    const d = tvDelayOf(s);
    if (d !== undefined) this.#pictures.set(key, d);
    else if (s.state !== "starting") this.#pictures.delete(key);
    this.followTv(Math.max(0, ...this.#pictures.values()));
  }

  /**
   * The join link on tvpipe's listener (`direct`) and what phones open
   * (`join`): the frame page's link for a tunnel's (tvpipe.party/p#…,
   * docs/short-links.md), else the same.
   */
  #phoneLinks(): { direct: string; join: string } {
    const base = this.info.phone.url;
    const direct = `${base.endsWith("/") ? base : `${base}/`}?r=${this.code}#k=${this.joinKey}`;
    const framed = this.info.phone.mode === "tunnel" ? frameLink(this.info.phone.frame, direct) : null;
    return { direct, join: framed ?? direct };
  }

  #refreshes = 0;

  /**
   * Makes the join link and its QR code (again: after the tunnel came up).
   * With a tunnel the link is the frame page's (`tvpipe.party/p#…`) and
   * the short link (`joinInfo.short`) follows in the background:
   * `screen-view` fires when it is there.
   */
  async refreshJoin(): Promise<void> {
    const n = ++this.#refreshes;
    const { direct, join } = this.#phoneLinks();
    const mode = this.info.phone.mode;
    this.links = { ...this.links, join };
    let qr: { size: number; rows: string[] } | null = null;
    try {
      qr = await this.tvpipe.qr(join);
    } catch {}
    if (n !== this.#refreshes) return;
    // The short link of the same link stays while it is asked for again.
    const keep = this.joinInfo.url === join ? this.joinInfo.short : undefined;
    this.joinInfo = { code: this.code, url: join, qr, mode, ...(keep ? { short: keep } : {}) };
    if (mode !== "tunnel" && mode !== "web") return;
    // tvpipe registers its own link (the service redirects to the frame page);
    // web mode's room has its registered one.
    void this.tvpipe.shortLink(direct, this.code).then(
      (r) => {
        if (n === this.#refreshes && r.url !== this.joinInfo.short) this.joinInfo = { ...this.joinInfo, short: r.url };
      },
      () => {},
    );
  }

  /**
   * Shows `player`'s rejoin code over the host page (a dialog): the QR
   * code of {@link Party.rejoinLink} and a link to copy, for a phone
   * that lost its way back (another browser, a new phone). It closes
   * when the player is back (resolving `true`), when they leave, or by
   * hand (`false`). Put it beside away players (`!player.connected`).
   */
  async showRejoin(player: Player): Promise<boolean> {
    const link = this.rejoinLink(player);
    if (!link || !globalThis.document) throw new TvpipeError("unavailable", "no join link or no page");
    let qr: { size: number; rows: string[] } | null = null;
    try {
      qr = await this.tvpipe.qr(link);
    } catch {}
    return showRejoinDialog(this, player, link, qr);
  }

  /**
   * Casts the TV page to `to` (default: what the launcher chose). A TV
   * that needs pairing is paired (the `pair` option, a dialog by
   * default), then the page is cast again: `cast` events tell.
   */
  cast(to?: string[], opts: { resolution?: Resolution | undefined } = {}): Promise<CastStatus> {
    this.#offered.clear();
    return this.#cast({ to, resolution: opts.resolution });
  }

  /**
   * What the TV picture is on: tvpipe's cast and the local screen
   * together ({@link mergeCast}).
   */
  get castStatus(): CastStatus {
    return mergeCast(this.#remote, this.#localStatus);
  }

  /** Calls `fn` with {@link castStatus} whenever it changes; returns the unsubscribe. */
  onCastChange(fn: (s: CastStatus) => void): () => void {
    this.#castListeners.add(fn);
    return () => this.#castListeners.delete(fn);
  }

  #castChanged(): void {
    const s = this.castStatus;
    for (const fn of [...this.#castListeners]) fn(s);
  }

  async #cast(args: { to: string[] | undefined; resolution: Resolution | undefined }): Promise<CastStatus> {
    this.#castArgs = args;
    // The app's local screens (`local:this`, `local:cable`) are this page's to show.
    let to = args.to;
    let all = to;
    if (!all) {
      try {
        const chosen = await this.tvpipe.chosen();
        if (Array.isArray(chosen?.devices)) all = chosen.devices;
      } catch {}
    }
    const locals = (all ?? []).map(localScreen).filter((x) => x !== undefined);
    const local = locals.includes("cable") ? "cable" : locals[0];
    if (local) to = all!.filter((d) => !localScreen(d));
    await this.#showLocal(local);
    if (local && to!.length === 0) {
      // Only here: a cast of earlier TVs stops.
      if (this.#remote.state === "starting" || this.#remote.state === "streaming") await this.tvpipe.stopCast().catch(() => {});
      return this.castStatus;
    }
    this.#starting = true;
    try {
      const status = await this.tvpipe.cast({ page: this.links.tv, to, resolution: args.resolution });
      if (this.#mine) void this.#pairFailed(status);
      return local ? mergeCast(status, this.#localStatus) : status;
    } finally {
      this.#starting = false;
    }
  }

  /** The TV page on the local screen (`undefined`: none); a running one stays. */
  async #showLocal(kind: "this" | "cable" | undefined): Promise<void> {
    if (!kind) {
      this.#local.stop();
      this.#localPage = undefined;
      return;
    }
    const s = this.#localStatus;
    if (s.state === "streaming" && s.to?.[0] === `${LOCAL_PREFIX}${kind}` && this.#localPage === this.links.tv) return;
    this.#localPage = this.links.tv;
    await this.#local.start(kind, this.links.tv);
  }

  /** Pairs the TVs of this party's cast that failed for want of it, once each, then casts again. */
  async #pairFailed(status: CastStatus): Promise<void> {
    const pair = this.#pair;
    if (!pair || this.#pairing || !this.#castArgs) return;
    const devices = needsPairing(status).filter((d) => !this.#offered.has(d));
    if (devices.length === 0) return;
    this.#pairing = true;
    let paired = false;
    try {
      for (const d of devices) {
        this.#offered.add(d);
        try {
          if (await pair(d)) paired = true;
        } catch {
          // No dialog: the cast's failure stays.
        }
      }
    } finally {
      this.#pairing = false;
    }
    if (!paired || !this.#castArgs) return;
    await this.#cast(this.#castArgs).catch(() => {});
  }

  /**
   * The cast picker over the host page, then the TV page on what was
   * chosen (no TVs: the cast stops). `null` when cancelled.
   */
  async changeCast(): Promise<CastStatus | null> {
    const sel = await this.tvpipe.showCastPicker();
    if (!sel) return null;
    if (sel.devices.length === 0) {
      await this.stopCast();
      return { state: "stopped" };
    }
    return this.cast();
  }

  stopCast(): Promise<void> {
    this.#castArgs = null;
    this.#local.stop();
    this.#localPage = undefined;
    return this.tvpipe.stopCast();
  }
}
