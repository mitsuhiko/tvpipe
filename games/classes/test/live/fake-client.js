// The preview's stand-in for `/_tvpipe/lib/client.js` (test/live/preview.ts
// serves it there): everything of the real client (`qrSvg`, `joinText`,
// `blockEmoji`, …, from `/_tvpipe/lib/real/`, which is npm/party/dist),
// but a `PartyClient` that connects nowhere and emits the canned views of
// a fixture (test/live/fixtures/NAME.json, picked by `?fixture=NAME`).
//
// A fixture: { screen, room?, me?, you?, roster?, away?, join?, steps?, wait? }
// - `screen` is `party.screen` (the TV's view), `room` `party.room` (a
//   phone's; default: `screen` without the TV's own fields), `me`
//   `player.state`, `you` the phone's player id;
// - `roster` (default: everyone in `screen.people`, the first the VIP;
//   `away: [ids]` are not connected);
// - `join` is filled in by the preview's server (the QR code);
// - `resume: false`: `canResume` is false (a phone shows its join form;
//   `join(name)` then emits the views as `connect()` does);
// - `steps: [{ at: ms, screen?, room?, me? }]`: later changes (merged;
//   `null` removes a field);
// - any string "now", "now+1500" or "now-800" is a time on the host's
//   clock, from when the page loaded.
//
// What the page sends (`act`) lands in `window.__preview.acts`.

export * from "./real/client.js";
import { joinText, qrSvg } from "./real/client.js";
import { RejoinBadge } from "./real/rejoin.js";

const search = new URLSearchParams(location.search);
const hash = new URLSearchParams(location.hash.slice(1));
const NAME = search.get("fixture") ?? hash.get("fixture") ?? "lobby";
const LANG = search.get("lang");
// `canResume` must answer at once, before the fixture arrives: the preview puts a fixture's `resume: false` in the link.
const RESUME = search.get("resume") !== "0";
const T0 = Date.now();

/** @type {{ acts: { type: string, data: unknown }[], fixture: string, ready: boolean, error?: string }} */
const state = { acts: [], fixture: NAME, ready: false };
/** @type {any} */ (window).__preview = state;

/** @param {any} v @returns {any} */
function times(v) {
  if (typeof v === "string") {
    const m = /^now([+-]\d+)?$/.exec(v);
    return m ? T0 + Number(m[1] ?? 0) : v;
  }
  if (Array.isArray(v)) return v.map(times);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, times(x)]));
  return v;
}

/** @param {any} into @param {any} from */
function merge(into, from) {
  const out = { ...into };
  for (const [k, v] of Object.entries(from ?? {})) {
    if (v === null) delete out[k];
    else if (v && typeof v === "object" && !Array.isArray(v) && out[k] && typeof out[k] === "object" && !Array.isArray(out[k])) out[k] = merge(out[k], v);
    else out[k] = v;
  }
  return out;
}

const TV_ONLY = ["players", "progress", "bellAt"];

export class PartyClient {
  /** @param {any} [opts] */
  static fromLocation(opts = {}) {
    return new PartyClient({ ...opts, role: opts.role ?? hash.get("role") ?? "player" });
  }

  /** @type {Map<string, Set<Function>>} */
  #on = new Map();
  /** @type {Promise<any>} */
  #fixture;
  /** @type {any} */
  #fix = null;
  /** @type {any} */
  view = null;
  status = "idle";
  carried = null;
  tvDelay = 0;
  /** @type {any} */
  rejoinBadge = null;

  /** @param {any} [opts] */
  constructor(opts = {}) {
    this.role = opts.role ?? "player";
    if (this.role !== "player" && opts.rejoinBadge !== false) this.rejoinBadge = new RejoinBadge(document, { qrSvg, joinText }, opts.rejoinBadge || {});
    this.#fixture = fetch(`/_preview/fixtures/${encodeURIComponent(NAME)}.json${LANG ? `?lang=${LANG}` : ""}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`fixture ${NAME}: ${r.status}`))))
      .then(times)
      .then((f) => {
        // A join form waits for nobody: the page is ready as it is.
        if (!RESUME) state.ready = true;
        return f;
      });
  }

  get joinVisible() {
    return this.rejoinBadge?.suppressed ?? false;
  }
  set joinVisible(on) {
    if (this.rejoinBadge) this.rejoinBadge.suppressed = on;
  }
  get canResume() {
    return RESUME;
  }
  get you() {
    return this.#fix?.you ?? null;
  }
  now() {
    return Date.now();
  }
  hostNow() {
    return Date.now();
  }
  /** @param {string} type @param {Function} fn */
  on(type, fn) {
    if (!this.#on.has(type)) this.#on.set(type, new Set());
    this.#on.get(type)?.add(fn);
    return () => this.#on.get(type)?.delete(fn);
  }
  /** @param {string} type @param {Function} fn */
  off(type, fn) {
    this.#on.get(type)?.delete(fn);
  }
  /** @param {string} type @param {...unknown} args */
  #emit(type, ...args) {
    for (const fn of this.#on.get(type) ?? []) fn(...args);
  }

  /** @param {any} f */
  #views(f) {
    const screen = f.screen ?? {};
    const people = screen.people ?? {};
    const away = new Set(f.away ?? []);
    const roster = f.roster ?? Object.entries(people).map(([id, p], i) => ({ id, name: /** @type {any} */ (p).name, vip: i === 0, connected: !away.has(id) }));
    if (this.role === "player") {
      const room = f.room ?? Object.fromEntries(Object.entries(screen).filter(([k]) => !TV_ONLY.includes(k)));
      return { roster, room, me: f.me ?? {} };
    }
    return { roster, screen, join: f.join ?? null };
  }

  async connect() {
    try {
      const f = await this.#fixture;
      this.#fix = f;
      this.status = "open";
      this.#emit("status", "open");
      this.#emit("welcome", { you: f.you ?? null });
      this.#show(f);
      let cur = f;
      for (const step of f.steps ?? []) {
        setTimeout(() => {
          cur = { ...cur, screen: merge(cur.screen, step.screen), room: step.room || cur.room ? merge(cur.room ?? {}, step.room) : undefined, me: merge(cur.me ?? {}, step.me) };
          this.#show(cur);
        }, step.at ?? 0);
      }
      state.ready = true;
    } catch (e) {
      state.error = String(e);
      console.error(String(e));
    }
  }

  /** @param {any} f */
  #show(f) {
    this.view = this.#views(f);
    this.rejoinBadge?.update(this.view);
    this.#emit("view", this.view);
  }

  /** @param {string} _name */
  async join(_name) {
    return this.connect();
  }
  /** @param {string} type @param {unknown} [data] */
  async act(type, data) {
    state.acts.push({ type, data });
    console.info(`act ${type} ${JSON.stringify(data ?? {})}`);
    return this.#fix?.replies?.[type] ?? null;
  }
  input() {}
  carry() {}
  leave() {}
  close() {}
  drop() {}
}
