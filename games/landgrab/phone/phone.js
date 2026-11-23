// @ts-check
/**
 * Landgrab's phone page: joining, the lobby (the VIP's settings), the
 * plan, the battle, the end. The phone has no room for the TV's map:
 * planning, the map is the interface (the whole world, or flown close to
 * a territory and its neighbours): placing, a tap on one's territory and
 * + −; then a tap where armies set out from, a tap where they go, the
 * amount, on to the next. A bar under the map says what the tap did and
 * what comes next; Ready waits in a dock. Colour means a holder and nothing
 * else; one's own orders are white. The battle: what the TV plays now,
 * from one's own side (the dice in step with the TV, the result when
 * the TV shows it), the close-up, one's own events and the standings.
 * Everything it shows comes from the party's view (`{ roster, room, me
 * }`); everything it does is an action.
 */

import { blockEmoji, PartyClient } from "/_tvpipe/lib/client.js";
import { armiesFor, winChance } from "../game/odds.js";
import { armiesAlong, CASH_ARMIES, checkPlan, losses, MAX_ORDERS, planArmies, STARS_TO_CASH } from "../game/rules.js";
import { FAST_PACE, PACE, timeline } from "../game/timeline.js";
import { parseWorld } from "../game/world.js";
import { watchFit } from "./fit.js";
import { browserLang, pickLang } from "./i18n.js";
import { between, drawMap, frameView, pickAt, WILD } from "./minimap.js";
import { strings } from "./strings.js";

/** @typedef {import("../game/world.js").World} World */
/** @typedef {{ own: string[], arm: number[] }} Board */
/** @typedef {{ from: string, to: string, n: number }} Order */
/** @typedef {import("./minimap.js").View} MapView */
/** @typedef {import("./minimap.js").Arrow} Arrow */

// A controller, not a document: no pinch or double-tap zoom, no selection.
for (const type of ["gesturestart", "gesturechange", "gestureend"]) document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
document.addEventListener("touchmove", (e) => e.touches.length > 1 && e.preventDefault(), { passive: false });
document.addEventListener("dblclick", (e) => e.preventDefault(), { passive: false });
document.addEventListener("selectstart", (e) => {
  const tg = e.target instanceof Element ? e.target : /** @type {Node} */ (e.target).parentElement;
  if (!tg?.closest("input")) e.preventDefault();
});

const client = PartyClient.fromLocation();
// No emoji in names, answers or clues (the host drops them too).
blockEmoji();
const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
const app = $("app");
const bar = $("bar");
const hud = $("hud");
const banner = $("banner");
const who = $("who");
const langButton = /** @type {HTMLButtonElement} */ ($("lang"));
const dock = $("dock");

// The header's and the dock's heights, for the plan's map and for scrolling under the header.
const sizes = new ResizeObserver(() => {
  document.documentElement.style.setProperty("--bar-h", `${bar.offsetHeight}px`);
  document.documentElement.style.setProperty("--dock-h", `${dock.hidden ? 0 : dock.offsetHeight}px`);
});
sizes.observe(bar);
sizes.observe(dock);

/** @type {World | null} */
let world = null;
const worldLoaded = fetch(new URL("../data/world.txt", import.meta.url))
  .then((r) => r.text())
  .then((text) => {
    world = parseWorld(text);
    if (client.view?.me?.task) {
      shown = "";
      render(client.view);
    }
  });

// ---------------------------------------------------------------------------
// The language: the phone's own choice, else the room's, else the browser's.

const LANG_KEY = "landgrab:lang";
function ownLang() {
  try {
    const v = localStorage.getItem(LANG_KEY);
    return v ? pickLang(v) : null;
  } catch {
    return null;
  }
}
function roomLang() {
  const l = client.view?.room?.lang;
  return typeof l === "string" ? pickLang(l) : browserLang();
}
let lang = ownLang() ?? roomLang();
let t = strings(lang);
document.documentElement.lang = lang;
function useLang() {
  const l = ownLang() ?? roomLang();
  if (l === lang) return false;
  lang = l;
  t = strings(l);
  document.documentElement.lang = l;
  return true;
}
langButton.addEventListener("click", () => {
  const next = lang === "de" ? "en" : "de";
  try {
    if (next === roomLang()) localStorage.removeItem(LANG_KEY);
    else localStorage.setItem(LANG_KEY, next);
  } catch {}
  if (!useLang()) return;
  if (shown === "join") joinForm("", /** @type {HTMLInputElement | null} */ (document.getElementById("name"))?.value);
  else if (client.view?.me) {
    shown = "";
    render(client.view);
  }
});

let shown = "";
/** @type {(() => void) | null} called on every view while the screen stays */
let refresh = null;
/** @type {(() => void)[]} cleanups of the screen on show */
let cleanups = [];

// ---------------------------------------------------------------------------
// DOM helpers: text always as text.

/**
 * @param {string} tag
 * @param {Record<string, any>} [attrs]
 * @param {...(Node | string | null | undefined | false)} kids
 * @returns {HTMLElement}
 */
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "style" && typeof v === "object") for (const [p, x] of Object.entries(v)) el.style.setProperty(p, String(x));
    else if (v === true) el.setAttribute(k, "");
    else if (v !== false && v != null) el.setAttribute(k, String(v));
  }
  for (const kid of kids) if (kid) el.append(kid);
  return el;
}
/** Nodes without the missing ones. @param {...(Node | string | null | undefined | false)} xs @returns {(Node | string)[]} */
const only = (...xs) => /** @type {(Node | string)[]} */ (xs.filter((x) => x !== null && x !== undefined && x !== false));
/** @param {...(Node | null | false)} nodes */
function show(...nodes) {
  app.replaceChildren(.../** @type {Node[]} */ (nodes.filter((n) => n)));
}
/** @param {string | null} text */
function setBanner(text) {
  banner.hidden = !text;
  banner.textContent = text ?? "";
}
/** The header: the game's name and the player (`null`), or a screen's own (the plan's clock, the battle's progress). @param {...Node} nodes */
function setHud(...nodes) {
  bar.classList.toggle("hud-on", nodes.length > 0);
  hud.hidden = nodes.length === 0;
  hud.replaceChildren(...nodes);
}

/** A holder's colour from the room (`colors` by id); the wild lands parchment. */
function colorOf(/** @type {string | undefined} */ id) {
  if (!id) return WILD;
  const c = client.view?.room?.colors?.[id];
  return typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c) ? c : "#7c8696";
}
/** A name from the roster (or the standings, for players who left). */
function nameOf(/** @type {string} */ id) {
  if (!id) return t.wild;
  return (client.view?.roster ?? []).find((/** @type {any} */ r) => r.id === id)?.name ?? (client.view?.room?.players ?? []).find((/** @type {any} */ s) => s.id === id)?.name ?? "?";
}
const me = () => /** @type {string} */ (client.you?.id ?? "");
/** A territory's name in the phone's language. @param {string | number} x */
function tName(x) {
  const terr = typeof x === "number" ? world?.territories[x] : world?.byId.get(x);
  return terr ? terr.name[lang] : String(x);
}
const tIndex = (/** @type {string} */ id) => world?.byId.get(id)?.index ?? -1;
const tId = (/** @type {number} */ i) => world?.territories[i]?.id ?? "";
/** Every territory's index (a frame for the whole world). */
const allLand = () => world?.territories.map((x) => x.index) ?? [];
const dot = (/** @type {string} */ color) => h("span", { class: "dot", style: { "--c": color } });

/** A short buzz, where phones do that. @param {number | number[]} ms */
function buzz(ms) {
  try {
    navigator.vibrate?.(ms);
  } catch {}
}

// ---------------------------------------------------------------------------
// Joining

/** @param {string} [error] @param {string} [typed] */
function joinForm(error = "", typed) {
  shown = "join";
  refresh = null;
  dock.hidden = true;
  setHud();
  langButton.hidden = false;
  langButton.textContent = t.otherLang;
  const input = /** @type {HTMLInputElement} */ (h("input", { id: "name", maxlength: 16, autocapitalize: "words", enterkeyhint: "go", autocomplete: "off", required: true }));
  const err = h("p", { class: "error" }, error);
  let saved = "";
  try {
    saved = localStorage.getItem("landgrab:name") ?? "";
  } catch {}
  input.value = typed ?? client.saved?.name ?? saved;
  const form = h(
    "form",
    {
      autocomplete: "off",
      onsubmit: async (/** @type {Event} */ e) => {
        e.preventDefault();
        const name = input.value.trim();
        if (!name) return;
        try {
          localStorage.setItem("landgrab:name", name);
        } catch {}
        err.textContent = "";
        try {
          await client.join(name);
        } catch (x) {
          joinForm(message(x), name);
        }
      },
    },
    h("label", { for: "name" }, t.yourName),
    input,
    h("button", { class: "btn", type: "submit" }, t.join),
    err,
  );
  show(logo(true), h("section", { class: "card pop" }, h("h1", { "data-fit": "2" }, t.joinTitle), form));
  if (!input.value) input.focus();
}

/** @param {boolean} [tag] with the tagline */
function logo(tag = false) {
  return h("div", { class: "logo-wrap" }, h("div", { class: "logo" }, h("span", {}, "Land"), h("b", {}, "grab")), tag ? h("p", { class: "tagline" }, t.tagline) : null);
}

/** @param {any} e */
function message(e) {
  switch (e?.code) {
    case "name-taken":
      return t.nameTaken;
    case "name-invalid":
      return t.pickAnother;
    case "full":
      return t.full;
    case "locked":
    case "in-progress":
      return t.closed;
    case "bad-key":
      return t.badKey;
    case "no-room":
      return t.noRoom;
    default:
      return (typeof e?.code === "string" ? t.errors[e.code] : undefined) ?? e?.message ?? String(e);
  }
}

client.on("status", (st) => {
  if (st === "reconnecting") setBanner(t.reconnecting);
  else if (st === "open") setBanner(null);
});
client.on("bye", (reason) => {
  const text = reason === "kicked" ? t.kicked : reason === "replaced" ? t.replaced : reason === "room-closed" ? t.roomClosed : null;
  if (!text) return;
  shown = "bye";
  refresh = null;
  for (const c of cleanups) c();
  cleanups = [];
  dock.hidden = true;
  setHud();
  setBanner(null);
  show(logo(), h("section", { class: "card center" }, h("p", { class: "big" }, text)));
});
client.on("view", (view) => render(view));

// ---------------------------------------------------------------------------
// Views

/** @param {any} me @param {any} room */
function keyOf(me, room) {
  return `${me.task}:${room.round ?? ""}`;
}

/** @param {Record<string, any>} view */
function render(view) {
  const m = view.me ?? {};
  const room = view.room ?? {};
  const mine = (view.roster ?? []).find((/** @type {any} */ r) => r.id === client.you?.id);
  if (useLang()) shown = "";
  // Not in yet (the join form is up): nothing to show.
  if (!m.task && shown === "join") return;
  who.replaceChildren(...(mine ? [dot(colorOf(mine.id)), h("b", {}, mine.name), mine.vip ? h("small", { class: "vip" }, t.vip) : ""] : []));
  if (!world) {
    if (shown !== "loading") show(h("section", { class: "card center" }, h("p", { class: "big" }, "…")));
    shown = "loading";
    return;
  }
  const key = keyOf(m, room);
  if (key !== shown) {
    shown = key;
    refresh = null;
    for (const c of cleanups) c();
    cleanups = [];
    dock.hidden = true;
    setHud();
    langButton.hidden = !(m.task === "lobby" || m.task === "final");
    langButton.textContent = t.otherLang;
    build(view);
    scrollTo(0, 0);
  }
  refresh?.();
}

/** @param {Record<string, any>} view */
function build(view) {
  const m = view.me ?? {};
  switch (m.task) {
    case "lobby":
      return lobby();
    case "wait":
      return show(logo(), h("section", { class: "card pop center" }, h("p", { class: "big" }, t.waitRound), h("p", { class: "muted" }, t.lookTv)));
    case "plan":
      return planScreen();
    case "watch":
      return watchScreen();
    case "final":
      return final();
    default:
      return show(h("section", { class: "card center" }, h("p", { class: "big" }, t.lookTv)));
  }
}

/** @param {string} type @param {any} data @param {HTMLElement} [err] */
async function act(type, data, err) {
  if (err) err.textContent = "";
  try {
    return await client.act(type, data);
  } catch (e) {
    if (err) err.textContent = message(e);
    throw e;
  }
}

const isVip = () => !!(client.view?.roster ?? []).find((/** @type {any} */ r) => r.id === client.you?.id)?.vip;

// ---------------------------------------------------------------------------
// Lobby and final: players, the VIP's settings, start.

/** @param {HTMLElement} err */
function settings(err) {
  /** @type {{ key: string, buttons: HTMLButtonElement[], values: any[] }[]} */
  const items = [];
  const box = h("div", { class: "settings" }, h("h2", {}, t.settings));
  const add = (/** @type {string} */ key, /** @type {any[]} */ values, /** @type {string[]} */ labels, /** @type {string} */ title) => {
    const buttons = values.map((v, i) => /** @type {HTMLButtonElement} */ (h("button", { type: "button", onclick: () => act("settings", { [key]: v }, err).catch(() => {}) }, labels[i])));
    box.append(h("div", { class: "setting" }, h("label", {}, title), h("div", { class: "seg" }, ...buttons)));
    items.push({ key, buttons, values });
  };
  add("rounds", [6, 8, 10, 12, 24], ["6", "8", "10", "12", "24"], t.roundsLabel);
  add("planTime", [45, 60, 90, 120], [45, 60, 90, 120].map(t.seconds), t.planLabel);
  const update = () => {
    const room = client.view?.room ?? {};
    box.hidden = !isVip();
    for (const it of items) it.buttons.forEach((b, i) => b.classList.toggle("on", it.values[i] === room[it.key]));
  };
  return { box, update };
}

/** The how-to-play card. */
function howTo() {
  return h(
    "section",
    { class: "card plain how" },
    h("h2", {}, t.howTitle),
    h("ol", {}, ...t.how.map(([head, text], i) => h("li", {}, h("i", { class: "hexnum" }, String(i + 1)), h("div", {}, h("b", {}, head), h("span", {}, text))))),
  );
}

function lobby() {
  const err = h("p", { class: "error" });
  const list = h("div", { class: "chips" });
  const hint = h("p", { class: "hint" });
  const start = /** @type {HTMLButtonElement} */ (h("button", { class: "btn", id: "start", onclick: () => act("start", null, err).catch(() => {}) }, t.start));
  const set = settings(err);
  show(
    logo(),
    h("section", { class: "card pop lobby" }, h("h1", {}, t.youreIn), h("h2", {}, t.generals), list, start, hint, err, set.box),
    howTo(),
  );
  refresh = () => {
    const v = client.view;
    const roster = v.roster ?? [];
    const vip = isVip();
    const min = v.room?.minPlayers ?? 2;
    const ready = roster.filter((/** @type {any} */ r) => r.connected).length;
    list.replaceChildren(
      ...roster.map((/** @type {any} */ r) =>
        h(
          "span",
          { class: `chip${r.connected ? "" : " away"}${r.id === me() ? " me" : ""}`, style: { "--c": colorOf(r.id) } },
          dot(colorOf(r.id)),
          h("span", {}, r.name),
          r.vip ? h("small", {}, t.vip) : null,
          vip && r.id !== client.you?.id ? h("button", { type: "button", class: "kick", "aria-label": `✕ ${r.name}`, onclick: () => act("kick", { id: r.id }, err).catch(() => {}) }, "✕") : null,
        ),
      ),
    );
    start.hidden = !vip;
    start.disabled = ready < min;
    hint.textContent = vip ? (ready < min ? t.vipWait(min - ready) : t.vipReady) : t.waitVip;
    set.update();
  };
}

function final() {
  const w = /** @type {World} */ (world);
  const m = client.view?.me ?? {};
  const room = client.view?.room ?? {};
  const err = h("p", { class: "error" });
  const again = /** @type {HTMLButtonElement} */ (h("button", { class: "btn", id: "start", onclick: () => act("start", null, err).catch(() => {}) }, t.playAgain));
  const waitNote = h("p", { class: "hint" }, t.vipAgain);
  const set = settings(err);
  const fin = room.final ?? {};
  const table = /** @type {any[]} */ (fin.table ?? []);
  const canvas = /** @type {HTMLCanvasElement} */ (h("canvas", { class: "minimap world" }));
  const awards = Object.entries(/** @type {Record<string, { id: string, n: number } | null>} */ (fin.awards ?? {})).filter(([k, a]) => a && t.awards[k]);
  const won = m.rank === 1;
  show(
    h(
      "section",
      { class: `card pop hero${won ? " won" : ""}`, style: { "--c": colorOf(me()) } },
      m.rank ? h("div", { class: "medal" }, h("b", {}, String(m.rank))) : null,
      h("h1", { "data-fit": "2" }, won ? t.won : t.gameOver),
      h("p", { class: "muted" }, [m.rank ? t.rank(m.rank, m.of) : "", t.by[fin.by] ?? ""].filter(Boolean).join(" · ")),
    ),
    h("div", { class: "mapbox" }, canvas),
    table.length
      ? h(
          "section",
          { class: "card" },
          h(
            "ol",
            { class: "table" },
            ...table.map((s, i) =>
              h("li", { class: s.id === me() ? "mine" : "", style: { "--c": s.color ?? colorOf(s.id) } }, h("span", { class: "rk" }, String(i + 1)), dot(s.color ?? colorOf(s.id)), h("span", { class: "name", "data-fit": "1" }, s.name), h("span", { class: "num" }, h("b", {}, String(s.lands)), h("small", {}, t.armies(s.armies)))),
            ),
          ),
        )
      : null,
    awards.length
      ? h(
          "section",
          { class: "card awards" },
          h("h2", {}, t.awardsTitle),
          ...awards.map(([k, a]) => {
            const [title, line] = t.awards[k] ?? ["", () => ""];
            const id = /** @type {{ id: string, n: number }} */ (a).id;
            return h("div", { class: `award${id === me() ? " mine" : ""}`, style: { "--c": colorOf(id) } }, h("i", { class: `aw aw-${k}` }), h("div", {}, h("b", {}, title), h("span", {}, `${nameOf(id)} · ${line(/** @type {{ n: number }} */ (a).n)}`)));
          }),
        )
      : null,
    h("section", { class: "card" }, again, waitNote, err, set.box),
  );
  if (won) buzz([30, 60, 30, 60, 120]);
  const draw = () => {
    if (room.board) drawMap(canvas, w, room.board, colorOf, { me: me(), frame: allLand(), pad: 0.6 });
  };
  refresh = () => {
    const vip = isVip();
    again.hidden = !vip;
    waitNote.hidden = vip;
    set.update();
    draw();
  };
  addEventListener("resize", draw);
  cleanups.push(() => removeEventListener("resize", draw));
}

// ---------------------------------------------------------------------------
// The clock

/** A time bar and the seconds, ticking until the deadline. @param {number} deadline */
function clock(deadline) {
  const timebar = h("div", { class: "timebar" }, h("i"));
  const secs = h("span", { class: "hud-clock" });
  const total = Math.max(1000, deadline - client.now());
  const fill = /** @type {HTMLElement} */ (timebar.firstChild);
  let last = -1;
  const tick = () => {
    const ms = deadline - client.now();
    fill.style.transform = `scaleX(${Math.max(0, Math.min(1, ms / total))})`;
    const n = Math.max(0, Math.ceil(ms / 1000));
    if (n !== last) {
      last = n;
      secs.textContent = `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
      const low = ms < 10_000;
      timebar.classList.toggle("low", low);
      secs.classList.toggle("low", low);
      if (n <= 5 && n > 0 && !draft.ready) buzz(15);
    }
  };
  tick();
  const id = setInterval(tick, 200);
  cleanups.push(() => clearInterval(id));
  return { timebar, secs };
}

// ---------------------------------------------------------------------------
// The plan: the map is the interface. Place: tap one's territory, + −.
// Then orders: tap where armies set out from, tap where they go, confirm
// the amount; on to the next.

/**
 * The plan being made on this phone: placements, orders, stars cashed,
 * ready; sent to the host (whole) after each change.
 */
let draft = { round: -1, place: /** @type {Record<string, number>} */ ({}), orders: /** @type {Order[]} */ ([]), cash: false, ready: false };
/** The step: 0 place, 1 orders. */
let step = 0;
/** The selected territory (-1: none): where to place, where armies set out from (or a foe to attack). */
let sel = -1;
/** Where the map looks: a territory and its neighbours (-1: the whole world). */
let look = -1;
/** The route whose amount is being chosen. @type {{ from: string, to: string, n: number } | null} */
let choosing = null;
/** The amount's slider is held: the bar is not rebuilt under the finger. */
let holding = false;
/** A word for the last tap that did nothing (nothing to send from there). */
let notice = "";

const calm = () => globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
const easeInOut = (/** @type {number} */ x) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);

/**
 * A canvas's camera: it flies from frame to frame (`key` names the one
 * it flies to; the same key again only draws). The canvas may change
 * size (the bar under it grows): the camera keeps its middle and flies on
 * from there. `draw` draws the canvas at a camera.
 */
function camera() {
  /** @type {MapView} */
  const none = { s: 1, ox: 0, oy: 0 };
  /** @type {{ key: string, from: MapView, to: MapView, view: MapView, t0: number, ms: number, cw: number, ch: number, raf: number, draw: ((v: MapView, rest: boolean) => void) | null }} */
  const c = { key: "", from: none, to: none, view: none, t0: 0, ms: 0, cw: 0, ch: 0, raf: 0, draw: null };
  const at = () => (c.ms > 0 ? Math.min(1, (performance.now() - c.t0) / c.ms) : 1);
  const now = () => (at() < 1 ? between(c.from, c.to, easeInOut(at()), c.cw, c.ch) : c.view);
  const frame = () => {
    if (c.raf) cancelAnimationFrame(c.raf);
    c.raf = 0;
    if (!c.draw) return;
    const k = at();
    c.view = k >= 1 ? c.to : between(c.from, c.to, easeInOut(k), c.cw, c.ch);
    c.draw(c.view, k >= 1);
    if (k < 1) c.raf = requestAnimationFrame(frame);
  };
  return {
    get view() {
      return c.view;
    },
    get key() {
      return c.key;
    },
    /** @param {string} key @param {MapView} target @param {number} cw @param {number} ch @param {(v: MapView, rest: boolean) => void} draw */
    fly(key, target, cw, ch, draw) {
      c.draw = draw;
      if (!c.key) Object.assign(c, { key, from: target, to: target, view: target, ms: 0, cw, ch });
      else {
        const v = now();
        const resized = cw !== c.cw || ch !== c.ch;
        // Where it is, on the canvas as it is now.
        const mx = (c.cw / 2 - v.ox) / v.s;
        const my = (c.ch / 2 - v.oy) / v.s;
        const from = { s: v.s, ox: cw / 2 - mx * v.s, oy: ch / 2 - my * v.s };
        if (key !== c.key || resized) Object.assign(c, { key, from, to: target, t0: performance.now(), ms: calm() ? 0 : key !== c.key ? 450 : 200, cw, ch });
        else c.to = target;
      }
      frame();
    },
    stop() {
      if (c.raf) cancelAnimationFrame(c.raf);
      Object.assign(c, { key: "", raf: 0, draw: null });
    },
  };
}

function planBoard() {
  return /** @type {Board} */ (client.view?.room?.board ?? { own: [], arm: [] });
}
function budget() {
  const m = client.view?.me ?? {};
  return Number(m.reinf?.total ?? 0) + (draft.cash ? CASH_ARMIES : 0);
}
const placed = () => Object.values(draft.place).reduce((s, n) => s + n, 0);
const leftToPlace = () => budget() - placed();
const isMine = (/** @type {number} */ i) => planBoard().own[i] === me();
/** Armies on each territory with what is placed there (before the orders). */
const startArmies = () => planArmies(/** @type {World} */ (world), planBoard(), draft.place);
/** Armies on each territory after each order, in order (moves arriving). */
const alongNow = () => armiesAlong(/** @type {World} */ (world), planBoard(), me(), draft.place, draft.orders);
/** Armies on a territory with what is placed there. @param {string} id */
const have = (id) => (planBoard().arm[tIndex(id)] ?? 0) + (draft.place[id] ?? 0);
/** Armies on a territory once one's orders went (moves in arrived, armies sent out gone). @param {string} id */
const endOf = (id) => (alongNow().at(-1) ?? startArmies()).get(id) ?? 0;

/**
 * The most an order on a route can take. A new one goes last: what is
 * left then, one staying (armies moved in by earlier orders march on).
 * One there already: its own amount and what every later order out of
 * the same territory leaves over.
 * @param {string} from @param {string} to
 */
function maxFor(from, to) {
  const k = draft.orders.findIndex((o) => o.from === from && o.to === to);
  const after = alongNow();
  if (k < 0) return Math.max(0, ((after.at(-1) ?? startArmies()).get(from) ?? 0) - 1);
  let slack = Infinity;
  draft.orders.forEach((o, j) => {
    if (j >= k && o.from === from) slack = Math.min(slack, (after[j]?.get(from) ?? 0) - 1);
  });
  return (draft.orders[k]?.n ?? 0) + Math.max(0, slack);
}

/** Orders that ask for more than there is then (placements taken back, an order changed) shrink or go. */
function trimOrders() {
  const board = planBoard();
  const arm = startArmies();
  draft.orders = draft.orders.flatMap((o) => {
    const there = arm.get(o.from) ?? 0;
    const n = Math.min(o.n, there - 1);
    if (n <= 0) return [];
    arm.set(o.from, there - n);
    if (board.own[tIndex(o.to)] === me()) arm.set(o.to, (arm.get(o.to) ?? 0) + n);
    return [{ ...o, n }];
  });
}

let sendTimer = /** @type {ReturnType<typeof setTimeout> | undefined} */ (undefined);
/** Sends the plan (soon: a few taps in a row are one message). @param {boolean} [now] */
function sendPlan(now = false) {
  clearTimeout(sendTimer);
  const go = () => {
    const err = /** @type {HTMLElement | null} */ (document.getElementById("plan-err"));
    const plan = { place: draft.place, orders: draft.orders, cash: draft.cash, ready: draft.ready };
    const m = client.view?.me ?? {};
    // The rules the host checks with, here first: a plan this phone sends is one the host takes.
    try {
      if (world) checkPlan(world, planBoard(), me(), Number(m.reinf?.total ?? 0), Number(m.stars ?? 0), plan);
    } catch (e) {
      if (err) err.textContent = message(e);
      return;
    }
    if (err) err.textContent = "";
    act("plan", plan, err ?? undefined).catch(() => {
      draft.ready = false;
      redraw();
    });
  };
  if (now) go();
  else sendTimer = setTimeout(go, 250);
}

/** A change to the plan: un-ready, redraw, send. */
function changed() {
  draft.ready = false;
  trimOrders();
  redraw();
  sendPlan();
}

/** @type {() => void} */
let redraw = () => {};

/** Places one more army (or `n`) on one's own territory. @param {string} id @param {number} [n] */
function placeOn(id, n = 1) {
  const k = Math.min(n, leftToPlace());
  if (k <= 0) return;
  draft.place[id] = (draft.place[id] ?? 0) + k;
  buzz(8);
  changed();
}
/** Takes one placed army back. @param {string} id */
function unplace(id) {
  const n = draft.place[id] ?? 0;
  if (!n) return;
  if (n === 1) delete draft.place[id];
  else draft.place[id] = n - 1;
  changed();
}

/** A territory's strongest neighbour of another player, `{ id, own, n }`, or null. @param {string} id */
function worstFoe(id) {
  const board = planBoard();
  /** @type {{ id: string, own: string, n: number } | null} */
  let best = null;
  for (const nb of world?.byId.get(id)?.neighbors ?? []) {
    const i = tIndex(nb);
    const own = board.own[i] ?? "";
    if (!own || own === me()) continue;
    const n = board.arm[i] ?? 0;
    if (!best || n > best.n) best = { id: nb, own, n };
  }
  return best;
}

/** The plan's orders as white arrows (attacks solid, moves dashed). @returns {Arrow[]} */
function orderArrows() {
  const board = planBoard();
  return draft.orders.map((o) => ({ from: tIndex(o.from), to: tIndex(o.to), n: o.n, kind: /** @type {"atk" | "move"} */ (board.own[tIndex(o.to)] === me() ? "move" : "atk") }));
}

/** To a step, nothing selected (the map stays where it looks). @param {number} k */
function goStep(k) {
  step = k;
  sel = -1;
  choosing = null;
  holding = false;
  notice = "";
  redraw();
}

/** Chooses the amount for a route (the order there, or a new one with all there is). @param {string} from @param {string} to */
function chooseRoute(from, to) {
  const existing = draft.orders.find((o) => o.from === from && o.to === to);
  const max = maxFor(from, to);
  if (!existing && (max <= 0 || draft.orders.length >= MAX_ORDERS)) {
    notice = draft.orders.length >= MAX_ORDERS ? t.ordersFull : t.nothingFrom(tName(from));
    sel = tIndex(from);
    return redraw();
  }
  step = 1;
  sel = tIndex(from);
  notice = "";
  choosing = { from, to, n: existing?.n ?? max };
  redraw();
}

function planScreen() {
  const w = /** @type {World} */ (world);
  const room = client.view?.room ?? {};
  const m = client.view?.me ?? {};
  if (draft.round !== room.round) {
    // A new round, or the page came back: start from what the host has.
    const p = m.plan ?? {};
    draft = { round: room.round, place: { ...(p.place ?? {}) }, orders: [...(p.orders ?? [])], cash: !!p.cash, ready: !!p.ready };
    sel = -1;
    look = -1;
    choosing = null;
    notice = "";
    step = Number(m.reinf?.total ?? 0) - Object.values(draft.place).reduce((s, n) => s + n, 0) > 0 ? 0 : 1;
  }
  const c = clock(Number(m.deadline ?? 0));
  const steps = h("nav", { class: "steps" });
  setHud(h("div", { class: "hud-row" }, h("span", { class: "hud-round" }, dot(colorOf(me())), h("span", { "data-fit": "1" }, t.round(room.round ?? 1, room.rounds ?? 1))), c.secs), steps, c.timebar);

  const canvas = /** @type {HTMLCanvasElement} */ (h("canvas", { class: "minimap plan" }));
  const cam = camera();
  const worldBtn = h("button", { type: "button", class: "world-btn", onclick: () => ((look = -1), (sel = -1), (choosing = null), (notice = ""), redraw()) }, t.world);
  canvas.addEventListener("click", (e) => {
    const r = canvas.getBoundingClientRect();
    const ti = pickAt(w, cam.view, e.clientX - r.left, e.clientY - r.top);
    if (ti >= 0) tapMap(ti);
  });
  const bar = h("section", { class: "planbar" });
  const err = h("p", { class: "error", id: "plan-err" });
  show(h("div", { class: "mapbox planmap" }, canvas, worldBtn), err, bar);
  document.body.classList.add("planning");
  // The bar under the map grows and shrinks: the map follows.
  const sized = new ResizeObserver(() => drawPlanMap());
  sized.observe(canvas);
  cleanups.push(() => sized.disconnect(), () => cam.stop());

  const readyline = h("div", { class: "readyline" });
  const readyBtn = /** @type {HTMLButtonElement} */ (h("button", { class: "btn ready", type: "button", id: "ready" }));
  readyBtn.addEventListener("click", () => {
    draft.ready = !draft.ready;
    if (draft.ready) {
      choosing = null;
      sel = -1;
      buzz([20, 40, 20]);
    }
    redraw();
    sendPlan(true);
  });
  dock.replaceChildren(readyline, readyBtn);
  dock.hidden = false;

  /** A tap on the map. Far out it also looks closer. @param {number} ti */
  const tapMap = (ti) => {
    const id = tId(ti);
    const far = cam.view.s < 6;
    notice = "";
    if (step === 0) {
      if (far || !isMine(ti)) look = ti;
      if (!isMine(ti)) sel = -1;
      // The selected one again: one more army.
      else if (sel === ti && !far) placeOn(id);
      else sel = ti;
      return redraw();
    }
    if (choosing) {
      // Out of the amount; a tap on the route's target only that.
      const back = ti === tIndex(choosing.to);
      choosing = null;
      if (back) return redraw();
    }
    const cur = w.territories[sel];
    if (cur && ti !== sel && cur.neighbors.includes(id)) {
      if (isMine(sel)) return chooseRoute(cur.id, id);
      if (isMine(ti)) return chooseRoute(id, cur.id);
    }
    if (ti === sel) sel = -1;
    else {
      sel = ti;
      look = ti;
      if (isMine(ti) && maxFor(id, "") <= 0 && !draft.orders.some((o) => o.from === id)) notice = t.nothingFrom(tName(id));
    }
    redraw();
  };

  /** Where the map looks: a territory and its neighbours, or the world. */
  const mapFrame = () => {
    const terr = w.territories[look];
    if (terr) return { key: `f:${look}`, frame: [look, ...terr.neighbors.map(tIndex)], pad: 1.2, max: 22 };
    return { key: "world", frame: allLand(), pad: 0.6, max: 22 };
  };

  const drawPlanMap = () => {
    const board = planBoard();
    const f = mapFrame();
    const cw = canvas.clientWidth || 320;
    const ch = canvas.clientHeight || 200;
    const target = frameView(w, cw, ch, f.frame, f.pad, f.max);
    worldBtn.hidden = f.key === "world";
    const selT = w.territories[sel];
    // Orders: the selection and its neighbours stand out, the rest dims.
    const around = step === 1 && selT ? new Set([sel, ...selT.neighbors.map(tIndex)]) : null;
    const draw = (/** @type {MapView} */ v, /** @type {boolean} */ rest) => {
      const close = v.s >= 6;
      // The badges: before placing, what is there; ordering, what one's territories will have once the orders went.
      const end = step === 1 ? (alongNow().at(-1) ?? startArmies()) : null;
      /** @type {Map<number, string>} */
      const labels = new Map();
      if (close) for (const x of w.territories) labels.set(x.index, String(end && board.own[x.index] === me() ? (end.get(x.id) ?? 0) : (board.arm[x.index] ?? 0)));
      /** @type {Map<number, number>} */
      const plus = new Map();
      if (step === 0) for (const [id, n] of Object.entries(draft.place)) plus.set(tIndex(id), n);
      let arrows = orderArrows();
      if (choosing) {
        const ch2 = choosing;
        arrows = arrows.filter((a) => a.from !== tIndex(ch2.from) || a.to !== tIndex(ch2.to));
        arrows.push({ from: tIndex(ch2.from), to: tIndex(ch2.to), n: ch2.n, kind: isMine(tIndex(ch2.to)) ? "move" : "atk" });
      }
      // Names on the land close up: what is around where it looks.
      /** @type {Set<number>} */
      const named = new Set();
      if (close) {
        for (const x of [look, sel]) {
          const tt = w.territories[x];
          if (!tt) continue;
          named.add(x);
          for (const nb of tt.neighbors) named.add(tIndex(nb));
        }
      }
      drawMap(canvas, w, board, colorOf, {
        view: v,
        sel,
        dim: !!around,
        hi: around ?? undefined,
        labels,
        plus,
        arrows,
        me: me(),
        names: named.size && v.s >= target.s * 0.75 ? new Map([...named].map((i) => [i, tName(i)])) : undefined,
        strong: new Set(choosing ? [tIndex(choosing.from), tIndex(choosing.to)] : [sel]),
        regionNames: rest && f.key === "world" ? new Map(w.continents.map((x) => [x.id, x.name[lang]])) : undefined,
      });
      // Where the camera rests, for the live tests' taps on a territory (test/live/taps.ts).
      if (rest) canvas.dataset["view"] = `${v.s},${v.ox},${v.oy}`;
      else delete canvas.dataset["view"];
    };
    cam.fly(f.key, target, cw, ch, draw);
  };

  // ---- The bar under the map: what the tap did, what to do next.

  const cashButton = () => {
    const stars = Number(client.view?.me?.stars ?? 0);
    if (stars < STARS_TO_CASH && !draft.cash) return null;
    return h(
      "button",
      {
        type: "button",
        class: `cash${draft.cash ? " on" : ""}`,
        onclick: () => {
          draft.cash = !draft.cash;
          if (!draft.cash) {
            // Placements over the smaller budget come off the last ones placed.
            let over = placed() - budget();
            for (const id of Object.keys(draft.place).reverse()) {
              if (over <= 0) break;
              const take = Math.min(over, draft.place[id] ?? 0);
              draft.place[id] = (draft.place[id] ?? 0) - take;
              if (!draft.place[id]) delete draft.place[id];
              over -= take;
            }
          } else buzz([10, 30, 10]);
          changed();
        },
      },
      h("span", { class: "stars3" }, "★★★"),
      h("span", { "data-fit": "1" }, draft.cash ? `✓ ${t.cashed(CASH_ARMIES)}` : t.cash(CASH_ARMIES)),
    );
  };

  const xSel = () => h("button", { type: "button", class: "x", "aria-label": t.close, onclick: () => ((sel = -1), (choosing = null), (notice = ""), redraw()) }, "✕");
  /** The selection's line: holder's dot, name, a word under it. @param {number} i @param {string | Node} meta */
  const head = (i, meta) => h("div", { class: "bar-head" }, dot(colorOf(planBoard().own[i])), h("div", { class: "title" }, h("h2", { "data-fit": "1" }, tName(i)), h("p", { class: "meta", "data-fit": "2" }, meta)));

  const placeBar = () => {
    const board = planBoard();
    const left = leftToPlace();
    const next = h("button", { type: "button", class: `btn small next${left > 0 ? " ghost" : ""}`, onclick: () => goStep(1) }, t.nextMove);
    if (sel >= 0 && isMine(sel)) {
      const id = tId(sel);
      const f = worstFoe(id);
      const danger = !!f && winChance(f.n - 1, have(id)) >= 0.5;
      return only(
        h(
          "div",
          { class: "bar-row" },
          head(sel, danger && f ? h("span", { class: "warn" }, t.threatNear(tName(f.id), f.n)) : left > 0 ? t.tapAgain : t.allPlaced),
          h("span", { class: `count${draft.place[id] ? " row" : ""}` }, ...(draft.place[id] ? [h("small", {}, `${board.arm[sel] ?? 0} →`)] : []), h("b", {}, String(have(id)))),
          xSel(),
        ),
        h(
          "div",
          { class: "bar-row" },
          h("button", { type: "button", class: "step-btn", "aria-label": `− ${tName(id)}`, disabled: !draft.place[id], onclick: () => unplace(id) }, "−"),
          h("button", { type: "button", class: "step-btn plus", "aria-label": `+ ${tName(id)}`, disabled: left <= 0, onclick: () => placeOn(id) }, "+"),
          left > 1 ? h("button", { type: "button", class: "mini all", onclick: () => placeOn(id, left) }, t.placeAll(left)) : null,
          h("span", { class: "left" }, left > 0 ? t.leftN(left) : `✓ ${t.allPlaced}`),
        ),
        left === 0 ? next : null,
      );
    }
    return only(
      h("div", { class: "bar-row" }, h("div", { class: "title" }, h("h2", {}, left > 0 ? t.placeN(left) : `✓ ${t.allPlaced}`), h("p", { class: "meta" }, left > 0 ? t.tapOwn : t.allPlacedNext))),
      client.view?.me?.rise ? h("p", { class: "note" }, "⚑ ", t.rose(tName(client.view.me.rise))) : null,
      cashButton(),
      next,
    );
  };

  /** Existing orders out of a territory, as chips: a tap changes one, ✕ takes it back. @param {string} id */
  const orderChips = (id) => {
    const mine = draft.orders.filter((o) => o.from === id);
    if (!mine.length) return null;
    return h(
      "div",
      { class: "chips orders" },
      ...mine.map((o) =>
        h(
          "span",
          { class: "ochip" },
          h("button", { type: "button", class: "oc-main", onclick: () => chooseRoute(o.from, o.to) }, `${isMine(tIndex(o.to)) ? "➜" : "⚔"} ${o.n} ${tName(o.to)}`),
          h(
            "button",
            {
              type: "button",
              class: "oc-x",
              "aria-label": t.remove,
              onclick: () => {
                draft.orders = draft.orders.filter((x) => x !== o);
                changed();
              },
            },
            "✕",
          ),
        ),
      ),
    );
  };

  const ordersBar = () => {
    const board = planBoard();
    if (choosing) return amountBar(choosing);
    const terr = w.territories[sel];
    if (terr && isMine(sel)) {
      const free = maxFor(terr.id, "");
      return only(
        h("div", { class: "bar-row" }, head(sel, notice || (free > 0 ? t.tapTarget : t.nothingFrom(terr.name[lang]))), h("span", { class: "count" }, h("b", {}, String(endOf(terr.id))), h("small", {}, t.freeShort(free))), xSel()),
        orderChips(terr.id),
      );
    }
    if (terr) {
      const holder = board.own[sel] ?? "";
      const borders = terr.neighbors.some((nb) => board.own[tIndex(nb)] === me());
      return only(h("div", { class: "bar-row" }, head(sel, borders ? t.tapAttackFrom : t.noBorder), h("span", { class: "count" }, h("b", {}, String(board.arm[sel] ?? 0)), h("small", {}, holder ? nameOf(holder) : t.wild)), xSel()));
    }
    const n = draft.orders.length;
    return only(
      h("div", { class: "bar-row" }, h("div", { class: "title" }, h("h2", {}, t.stepMove), h("p", { class: "meta" }, notice || t.tapFrom)), n ? h("span", { class: "count" }, h("b", {}, String(n)), h("small", {}, t.ordersWord(n))) : null),
      leftToPlace() > 0 ? h("button", { type: "button", class: "mini back", onclick: () => goStep(0) }, t.backToPlace(leftToPlace())) : null,
    );
  };

  /** The amount for a route: its two ends and the odds, quick amounts, the slider, confirm. @param {{ from: string, to: string, n: number }} ch */
  const amountBar = (ch) => {
    const board = planBoard();
    const ti = tIndex(ch.to);
    const enemy = board.own[ti] !== me();
    const existing = draft.orders.find((o) => o.from === ch.from && o.to === ch.to);
    const max = Math.max(1, maxFor(ch.from, ch.to));
    ch.n = Math.max(1, Math.min(ch.n, max));
    const def = board.arm[ti] ?? 0;
    const slider = /** @type {HTMLInputElement} */ (h("input", { type: "range", min: 1, max, value: ch.n, step: 1, "aria-label": t.armies(ch.n) }));
    const oddsBar = h("i");
    const oddsText = h("span", { "data-fit": "1" });
    const send = /** @type {HTMLButtonElement} */ (h("button", { type: "button", class: "btn small send" }));
    /** @type {[string, number][]} */
    const quickVals = [];
    if (max >= 3) quickVals.push([t.half, Math.ceil(max / 2)]);
    const safe = enemy ? armiesFor(def, 0.8, max) : 0;
    if (safe > 0 && safe < max && !quickVals.some(([, n]) => n === safe)) quickVals.push([t.safe, safe]);
    quickVals.push([t.all, max]);
    quickVals.sort((a, b) => a[1] - b[1]);
    const quick = quickVals.map(([label, n]) => /** @type {HTMLButtonElement} */ (h("button", { type: "button", class: "q", onclick: () => setN(n) }, h("span", {}, label), h("b", {}, String(n)))));
    const update = () => {
      slider.value = String(ch.n);
      send.replaceChildren(h("span", { "data-fit": "1" }, `${enemy ? "⚔" : "➜"} ${enemy ? t.attackWith(ch.n) : t.moveWith(ch.n)}`));
      quick.forEach((b, k) => b.classList.toggle("on", quickVals[k]?.[1] === ch.n));
      if (enemy) {
        const p = winChance(ch.n, def);
        const pct = Math.round(p * 100);
        oddsBar.style.width = `${Math.max(3, pct)}%`;
        oddsText.textContent = pct < 5 ? t.hopeless : t.winChance(pct, p >= 0.7 ? t.odds.good : p >= 0.4 ? t.odds.even : t.odds.bad);
      }
    };
    const setN = (/** @type {number} */ n) => {
      ch.n = Math.max(1, Math.min(max, n));
      update();
      // The map's arrow carries the amount.
      drawPlanMap();
    };
    slider.addEventListener("input", () => setN(Number(slider.value)));
    const hold = () => (holding = true);
    const release = () => (holding = false);
    slider.addEventListener("pointerdown", hold);
    slider.addEventListener("touchstart", hold, { passive: true });
    for (const ev of ["pointerup", "pointercancel", "touchend", "change"]) slider.addEventListener(ev, release);
    send.addEventListener("click", () => {
      const o = draft.orders.find((x) => x.from === ch.from && x.to === ch.to);
      if (o) o.n = ch.n;
      else if (draft.orders.length < MAX_ORDERS) draft.orders.push({ from: ch.from, to: ch.to, n: ch.n });
      // On to the next: nothing selected, the map stays where it looks.
      choosing = null;
      sel = -1;
      buzz(20);
      changed();
    });
    update();
    const end = (/** @type {string} */ id, /** @type {number} */ n) => h("span", { class: "end" }, dot(colorOf(board.own[tIndex(id)])), h("span", { class: "name", "data-fit": "1" }, tName(id)), h("b", {}, String(n)));
    return only(
      h("div", { class: "route-head" }, end(ch.from, max + 1), h("i", { class: "via" }, enemy ? "⚔" : "➜"), end(ch.to, enemy ? def : have(ch.to))),
      enemy ? h("div", { class: "odds" }, h("span", { class: "obar" }, oddsBar), oddsText) : null,
      max >= 2 ? h("div", { class: "amount-row" }, h("button", { type: "button", class: "mini", "aria-label": "−", onclick: () => setN(ch.n - 1) }, "−"), slider, h("button", { type: "button", class: "mini", "aria-label": "+", onclick: () => setN(ch.n + 1) }, "+")) : null,
      quick.length > 1 ? h("div", { class: "quick" }, ...quick) : null,
      h(
        "div",
        { class: "amount-actions" },
        h("button", { type: "button", class: "btn small ghost", onclick: () => ((choosing = null), redraw()) }, t.cancel),
        existing
          ? h(
              "button",
              {
                type: "button",
                class: "btn small ghost",
                onclick: () => {
                  draft.orders = draft.orders.filter((o) => o !== existing);
                  choosing = null;
                  sel = -1;
                  changed();
                },
              },
              t.removeShort,
            )
          : null,
        send,
      ),
    );
  };

  redraw = () => {
    const v = client.view ?? {};
    const left = leftToPlace();
    document.body.classList.toggle("is-ready", draft.ready);

    // The two steps, each with what it still wants.
    const badges = [left > 0 ? h("b", {}, String(left)) : h("b", { class: "ok" }, "✓"), draft.orders.length ? h("b", {}, String(draft.orders.length)) : null];
    steps.replaceChildren(
      ...[t.stepPlace, t.stepMove].map((label, k) =>
        h("button", { type: "button", class: `stp${step === k ? " on" : ""}`, "aria-current": step === k ? "step" : false, onclick: () => goStep(k) }, h("i", {}, String(k + 1)), h("span", { "data-fit": "1" }, label), badges[k]),
      ),
    );

    if (!holding) bar.replaceChildren(...(step === 0 ? placeBar() : ordersBar()));
    drawPlanMap();

    // Ready: who is, and the button.
    const players = /** @type {any[]} */ (v.room?.players ?? []).filter((s) => !s.out && !s.gone);
    const nReady = players.filter((s) => s.ready).length;
    readyline.replaceChildren(
      h("span", { class: "rdots" }, ...players.map((s) => h("i", { class: s.ready ? "on" : "", style: { "--c": colorOf(s.id) }, title: s.name }, s.ready ? "✓" : ""))),
      h("small", {}, t.whoReady(nReady, players.length)),
    );
    readyBtn.classList.toggle("on", draft.ready);
    readyBtn.replaceChildren(
      ...only(
        h("span", { class: "main" }, draft.ready ? `✓ ${t.readyDone}` : t.ready),
        draft.ready ? h("span", { class: "sub" }, t.readyChange) : left > 0 ? h("span", { class: "sub", "data-fit": "1" }, t.readyLeft(left)) : null,
      ),
    );
  };
  refresh = () => redraw();
  cleanups.push(
    () => (redraw = () => {}),
    () => document.body.classList.remove("is-ready", "planning"),
  );
}

// ---------------------------------------------------------------------------
// The battle: what the TV plays now, from one's own side

/**
 * An event's marks on the TV (`timeline.ts`), from its length and scale:
 * the pace whose length matches, else the normal pace stretched.
 * @param {any} ev @param {number} ms @param {number} scale
 * @returns {[string, number, number][]}
 */
function marksOf(ev, ms, scale) {
  for (const pace of [PACE, FAST_PACE]) {
    const m = timeline(ev, pace, scale);
    const end = m[m.length - 1];
    if (end && Math.abs(end[1] + end[2] - ms) <= 40) return m;
  }
  const m = timeline(ev, PACE, 1);
  const end = m[m.length - 1];
  const k = end ? ms / Math.max(1, end[1] + end[2]) : 1;
  return m.map(([n, a, l]) => [n, a * k, l * k]);
}

/** When (ms into the event) the TV shows its result. @param {any} ev @param {[string, number, number][]} marks */
function revealAt(ev, marks) {
  const outro = marks.find(([n]) => n === "outro");
  if (outro) return outro[1];
  const last = marks[marks.length - 1];
  if (!last) return 0;
  return ev.type === "place" ? last[2] * 0.45 : last[1] + last[2] * 0.7;
}

function watchScreen() {
  const w = /** @type {World} */ (world);
  const m0 = client.view?.me ?? {};
  const room0 = client.view?.room ?? {};
  const prog = h("span", { class: "hud-prog" });
  const progBar = h("div", { class: "timebar battlebar" }, h("i"));
  const phaseLabel = h("span", { class: "hud-phase" }, t.battle);
  setHud(h("div", { class: "hud-row" }, h("span", { class: "hud-round" }, dot(colorOf(me())), h("span", { "data-fit": "1" }, t.round(room0.round ?? 1, room0.rounds ?? 1))), phaseLabel, prog), progBar);
  const now = h("section", { class: "now card" });
  const canvas = /** @type {HTMLCanvasElement} */ (h("canvas", { class: "minimap close" }));
  const tally = h("div", { class: "tally" });
  const feed = h("ol", { class: "feed" });
  const table = h("ol", { class: "table" });
  show(
    m0.out ? h("section", { class: "card out pop" }, h("p", { class: "big" }, t.out)) : null,
    now,
    h("div", { class: "mapbox" }, canvas),
    h("section", { class: "card" }, h("div", { class: "card-head" }, h("h2", {}, t.yourBattles), tally), feed),
    h("section", { class: "card" }, h("h2", {}, t.standings), table),
  );

  // The lands each had when the battle began (the standings' + and −).
  /** @type {Map<string, number> | null} */
  let startLands = null;
  /** The event on the TV: its index, when it arrived, its marks, when its result shows. */
  let cur = { i: -2, at: 0, marks: /** @type {[string, number, number][]} */ ([]), reveal: Infinity, told: false };
  let lastKey = "";
  let seenFeed = -1;

  const step = () => client.view?.room?.step ?? null;
  const elapsed = () => performance.now() - cur.at;
  /** The board as the TV shows it: the event's result only once the TV shows it. */
  const shownBoard = () => {
    const b = /** @type {Board} */ (client.view?.room?.board ?? { own: [], arm: [] });
    const st = step();
    if (!st?.ev || elapsed() >= cur.reveal) return b;
    const out = { own: [...b.own], arm: [...b.arm] };
    for (const [i, own, arm] of st.ev.was ?? []) (out.own[i] = own), (out.arm[i] = arm);
    return out;
  };
  /** Whether a feed item is shown (its event's result is on the TV). @param {any} f */
  const told = (f) => {
    const st = step();
    if (typeof f.i !== "number" || f.i < 0 || !st) return true;
    return f.i < st.i || (f.i === st.i && elapsed() >= cur.reveal);
  };

  const draw = () => {
    const v = client.view ?? {};
    const st = step();
    const board = shownBoard();
    if (!startLands && (!st || st.i === 0)) {
      startLands = new Map();
      const b0 = /** @type {Board} */ (v.room?.board ?? { own: [] });
      const first = st?.ev?.was ?? [];
      const own = [...b0.own];
      for (const [i, o] of first) own[i] = o;
      for (const o of own) if (o) startLands.set(o, (startLands.get(o) ?? 0) + 1);
    }
    if (st) {
      prog.textContent = `${Math.min(st.i + 1, st.of)}/${st.of}`;
      /** @type {HTMLElement} */ (progBar.firstChild).style.transform = `scaleX(${st.of ? Math.min(1, (st.i + (elapsed() >= cur.reveal ? 1 : 0.5)) / st.of) : 0})`;
    } else {
      const started = cur.i >= 0;
      prog.textContent = "";
      phaseLabel.textContent = started ? t.roundOver : t.battle;
      /** @type {HTMLElement} */ (progBar.firstChild).style.transform = `scaleX(${started ? 1 : 0})`;
    }

    // The close-up of the event (the world before the first and after the last).
    const ev = st?.ev;
    /** @type {Arrow[]} */
    const arrows = [];
    /** @type {Map<number, string>} */
    const labels = new Map();
    /** @type {Map<number, string>} */
    const names = new Map();
    let frame = allLand();
    let pad = 0.6;
    if (ev && (ev.type === "attack" || ev.type === "move" || ev.type === "clash")) {
      const [a, b] = ev.type === "clash" ? [ev.a, ev.b] : [ev.from, ev.to];
      const near = new Set([a, b, ...(w.territories[a]?.neighbors ?? []).map(tIndex), ...(w.territories[b]?.neighbors ?? []).map(tIndex)]);
      frame = [a, b];
      pad = 3;
      for (const i of near) labels.set(i, String(board.arm[i] ?? 0));
      names.set(a, tName(a)).set(b, tName(b));
      // In the mover's colour, as on the TV.
      arrows.push({ from: a, to: b, kind: ev.type === "move" ? "move" : "atk", color: colorOf(ev.p) });
      if (ev.type === "clash") arrows.push({ from: b, to: a, kind: "atk", color: colorOf(ev.q) });
    } else if (ev?.type === "place") {
      for (const [i, p, n] of ev.add ?? []) if (p === me()) labels.set(i, `+${n}`);
    }
    drawMap(canvas, w, board, colorOf, { frame, pad, maxScale: 15, labels, names, strong: new Set(names.keys()), arrows, me: me(), sel: ev && ev.type !== "place" ? (ev.type === "clash" ? ev.b : ev.to) : -1, hi: new Set(labels.keys()) });

    // What happened to one's own armies, as far as the TV got.
    const items = /** @type {any[]} */ (v.me?.feed ?? []).filter(told);
    if (items.length !== seenFeed) {
      seenFeed = items.length;
      feed.replaceChildren(...(items.length ? [...items].reverse().map(feedItem) : [h("li", { class: "muted" }, t.nothingYet)]));
      const took = items.filter((f) => f.type === "attack" && f.won).length + items.filter((f) => f.type === "clash" && f.won).length;
      const lost = items.filter((f) => f.type === "defend" && !f.won).length;
      const beat = items.reduce((s, f) => s + (f.type === "attack" || f.type === "defend" ? (f.beat ?? 0) : 0), 0);
      tally.replaceChildren(
        h("span", { class: "good" }, h("b", {}, String(took)), ` ${t.tally.took}`),
        h("span", { class: "bad" }, h("b", {}, String(lost)), ` ${t.tally.lost}`),
        h("span", {}, h("b", {}, String(beat)), ` ${t.tally.beat}`),
      );
    }

    // The standings, from the board the TV shows.
    const players = /** @type {any[]} */ (v.room?.players ?? []);
    const count = new Map();
    const armies = new Map();
    board.own.forEach((o, i) => {
      if (!o) return;
      count.set(o, (count.get(o) ?? 0) + 1);
      armies.set(o, (armies.get(o) ?? 0) + (board.arm[i] ?? 0));
    });
    const rows = players.map((s) => ({ id: s.id, name: s.name ?? nameOf(s.id), lands: count.get(s.id) ?? 0, armies: armies.get(s.id) ?? 0 })).sort((a, b) => b.lands - a.lands || b.armies - a.armies);
    const total = board.own.length || 1;
    const key = JSON.stringify(rows);
    if (key !== lastKey) {
      lastKey = key;
      table.replaceChildren(
        ...rows.map((s, k) => {
          const d = startLands ? s.lands - (startLands.get(s.id) ?? 0) : 0;
          return h(
            "li",
            { class: s.id === me() ? "mine" : "", style: { "--c": colorOf(s.id), "--share": `${(s.lands / total) * 100}%` } },
            h("span", { class: "rk" }, String(k + 1)),
            dot(colorOf(s.id)),
            h("span", { class: "name", "data-fit": "1" }, s.name),
            d ? h("span", { class: `delta ${d > 0 ? "up" : "down"}` }, d > 0 ? `+${d}` : String(d)) : null,
            h("span", { class: "num" }, h("b", {}, String(s.lands)), h("small", {}, t.armies(s.armies))),
          );
        }),
      );
    }
  };

  /** The card of the event on the TV: who against whom, the dice as the TV throws them, the result when it shows. */
  const nowCard = () => {
    const st = step();
    const ev = st?.ev;
    if (!ev) {
      const done = cur.i >= 0;
      now.className = "now card";
      now.replaceChildren(h("p", { class: "now-tag" }, t.onTv), h("p", { class: "now-title" }, done ? t.roundOver : t.lineUp), h("p", { class: "muted small" }, t.watchTv));
      return;
    }
    const tau = elapsed();
    const revealed = tau >= cur.reveal;
    const mine = ev.p === me() || ev.foe === me() || ev.q === me() || (ev.type === "clash" && ev.then?.foe === me());
    /** @type {{ tag: string, title: string, result: string, good: boolean | null }} */
    const c = { tag: t.onTv, title: "", result: "", good: null };
    /** @type {HTMLElement | null} */
    let fight = null;
    const side = (/** @type {string} */ p, /** @type {number} */ terr, /** @type {number} */ n, /** @type {string} */ cls) =>
      h("div", { class: `side ${cls}`, style: { "--c": colorOf(p) } }, h("span", { class: "who", "data-fit": "1" }, p === me() ? t.you : nameOf(p)), h("span", { class: "where", "data-fit": "1" }, tName(terr)), h("b", { class: "n" }, String(Math.max(0, n))));
    /** Dice and armies left at `tau` for throws named `prefix:k` (`then`: the attack after a clash). @param {any} rolls @param {string} prefix @param {boolean} headOn @param {number} a @param {number} d */
    const thrown = (rolls, prefix, headOn, a, d) => {
      /** @type {[number[], number[]] | null} */
      let last = null;
      let k = 0;
      let rolling = false;
      for (const [name, start, len] of cur.marks) {
        if (!name.startsWith(`${prefix}:`) || tau < start) continue;
        const roll = rolls[k];
        if (!roll) break;
        last = roll;
        rolling = !revealed && tau < start + len * 0.35;
        if (tau >= start + len * 0.6 || revealed) {
          const [la, ld] = losses(roll, headOn);
          (a -= la), (d -= ld);
        }
        k++;
      }
      if (revealed) {
        for (; k < rolls.length; k++) {
          const [la, ld] = losses(rolls[k], headOn);
          (a -= la), (d -= ld);
        }
      }
      return { last, a, d, started: k > 0, rolling };
    };
    /** The throw's dice, each side's in its colour. */
    const dice = (/** @type {[number[], number[]] | null} */ roll, /** @type {boolean} */ rolling, /** @type {string} */ pa, /** @type {string} */ pd) =>
      h(
        "div",
        { class: `dice${rolling ? " rolling" : ""}`, style: { "--ca": colorOf(pa), "--cd": colorOf(pd) } },
        h("span", { class: "att" }, ...(roll ? roll[0] : [6, 6, 6]).map((x) => h("i", { class: "die" }, String(x)))),
        h("span", { class: "def" }, ...(roll ? roll[1] : [6, 6]).map((x) => h("i", { class: "die" }, String(x)))),
      );
    switch (ev.type) {
      case "place": {
        const n = (ev.add ?? []).filter((/** @type {any[]} */ x) => x[1] === me()).reduce((/** @type {number} */ s, /** @type {any[]} */ x) => s + x[2], 0);
        c.title = t.now.place;
        c.result = n ? t.now.placeYou(n) : "";
        c.good = n ? true : null;
        break;
      }
      case "move":
        c.tag = ev.p === me() ? t.now.youMove : c.tag;
        c.title = t.now.move(nameOf(ev.p));
        fight = h("div", { class: "vs" }, side(ev.p, ev.from, ev.n, "att"), h("div", { class: "mid" }, h("span", { class: "arrow" }, "➜")), side(ev.p, ev.to, (ev.was?.[1]?.[2] ?? 0) + (revealed ? ev.n : 0), "def"));
        c.result = revealed && ev.p === me() ? t.now.marched : "";
        break;
      case "attack": {
        const atMe = ev.p === me();
        const onMe = ev.foe === me();
        c.tag = atMe ? t.now.youAttack : onMe ? t.now.youDefend : c.tag;
        c.title = t.now.attack(nameOf(ev.p));
        const r = thrown(ev.rolls, "roll", false, ev.n, ev.def);
        fight = h("div", { class: "vs" }, side(ev.p, ev.from, r.a, "att"), h("div", { class: "mid" }, r.started ? dice(r.last, r.rolling, ev.p, ev.foe) : h("span", { class: "swords" }, "⚔")), side(ev.foe, ev.to, r.d, "def"));
        if (revealed) {
          if (atMe) (c.result = ev.won ? t.now.youTook : t.now.youFailed), (c.good = ev.won);
          else if (onMe) (c.result = ev.won ? t.now.youLost : t.now.youHeld), (c.good = !ev.won);
          else c.result = ev.won ? t.now.taken(tName(ev.to)) : t.now.held(tName(ev.to));
        }
        break;
      }
      case "clash": {
        const inClash = ev.p === me() || ev.q === me();
        c.tag = inClash ? t.now.youClash : ev.then?.foe === me() ? t.now.youDefend : c.tag;
        c.title = t.now.clash;
        const then = ev.then;
        const thenStarted = then && cur.marks.some(([n, s]) => n.startsWith("roll:") && tau >= s);
        if (then && (thenStarted || revealed)) {
          const r = thrown(then.rolls, "roll", false, then.n, then.def);
          fight = h("div", { class: "vs" }, side(then.p, then.from, r.a, "att"), h("div", { class: "mid" }, r.started ? dice(r.last, r.rolling, then.p, then.foe) : h("span", { class: "swords" }, "⚔")), side(then.foe, then.to, r.d, "def"));
        } else {
          const r = thrown(ev.rolls, "clash", true, ev.na, ev.nb);
          fight = h("div", { class: "vs" }, side(ev.p, ev.a, r.a, "att"), h("div", { class: "mid" }, r.started ? dice(r.last, r.rolling, ev.p, ev.q) : h("span", { class: "swords" }, "✶")), side(ev.q, ev.b, r.d, "def"));
        }
        if (revealed) {
          if (!then) c.result = t.now.bounced;
          else if (then.p === me()) (c.result = then.won ? t.now.youTook : t.now.youFailed), (c.good = then.won);
          else if (then.foe === me()) (c.result = then.won ? t.now.youLost : t.now.youHeld), (c.good = !then.won);
          else if (inClash) (c.result = t.now.youFailed), (c.good = false);
          else c.result = then.won ? t.now.taken(tName(then.to)) : t.now.held(tName(then.to));
        }
        break;
      }
    }
    if (revealed && !cur.told) {
      cur.told = true;
      if (mine && c.good === true) buzz(ev.continent ? [30, 50, 30, 50, 90] : [35]);
      else if (mine && c.good === false) buzz(ev.out === me() ? [200, 80, 200] : [60, 50, 60]);
    }
    now.className = `now card${mine ? " mine" : ""}${c.good === true ? " good" : c.good === false ? " bad" : ""}`;
    now.style.setProperty("--c", colorOf(me()));
    now.replaceChildren(
      ...only(
      h("p", { class: "now-tag" }, c.tag),
      h("p", { class: "now-title", "data-fit": "1" }, c.title),
      fight,
      c.result ? h("p", { class: "now-result pop", "data-fit": "1" }, c.result) : null,
      revealed && ev.continent && mine ? h("p", { class: "now-extra" }, t.feed.continent(w.continents.find((x) => x.id === ev.continent)?.name[lang] ?? "")) : null,
      ),
    );
  };

  let wasRevealed = false;
  let lastCard = "";
  const tick = () => {
    const st = step();
    const i = st ? st.i : cur.i >= 0 ? 1e9 : -2;
    if (i !== cur.i) {
      const marks = st?.ev && typeof st.ms === "number" ? marksOf(st.ev, st.ms, Number(st.scale ?? 1)) : [];
      cur = { i, at: performance.now(), marks, reveal: st?.ev ? (marks.length ? revealAt(st.ev, marks) : Infinity) : 0, told: false };
      wasRevealed = false;
      draw();
    }
    const revealed = elapsed() >= cur.reveal;
    if (revealed !== wasRevealed) {
      wasRevealed = revealed;
      draw();
    }
    // The card changes with the throws: redraw it when what it shows changes.
    const tau = elapsed();
    const k = `${cur.i}:${revealed}:${cur.marks.map(([, s, l]) => (tau < s ? 0 : tau < s + l * 0.35 ? 1 : tau < s + l * 0.6 ? 2 : 3)).join("")}`;
    if (k !== lastCard) {
      lastCard = k;
      nowCard();
    }
  };
  refresh = () => {
    tick();
    draw();
  };
  const id = setInterval(tick, 80);
  const onResize = () => draw();
  addEventListener("resize", onResize);
  cleanups.push(() => clearInterval(id), () => removeEventListener("resize", onResize));
}

/** @param {any} f */
function feedItem(f) {
  const w = /** @type {World} */ (world);
  const foe = nameOf(f.foe ?? "");
  let icon = "•";
  let text = "";
  let cls = "";
  switch (f.type) {
    case "place":
      (icon = "+"), (text = t.feed.place(tName(f.to), f.n));
      break;
    case "move":
      (icon = "➜"), (text = t.feed.move(tName(f.from), tName(f.to), f.n));
      break;
    case "attack":
      icon = "⚔";
      cls = f.won ? "good" : "bad";
      text = f.won ? t.feed.took(tName(f.to), foe, f.lost ?? 0) : t.feed.failed(tName(f.to), foe, f.beat ?? 0);
      break;
    case "defend":
      icon = "⛨";
      cls = f.won ? "good" : "bad";
      text = f.won ? t.feed.held(tName(f.to), foe) : t.feed.lostLand(tName(f.to), foe);
      break;
    case "clash":
      icon = "✶";
      cls = f.won ? "good" : "bad";
      text = f.won ? t.feed.clashWon(foe, f.lost ?? 0) : t.feed.clashLost(foe);
      break;
    case "cancel":
      (icon = "∅"), (text = t.feed.cancel(tName(f.from), tName(f.to)));
      break;
    case "out":
      (icon = "☠"), (cls = "bad"), (text = t.feed.out);
      break;
    case "continent":
      (icon = "♛"), (cls = "good gold"), (text = t.feed.continent(w.continents.find((c) => c.id === f.continent)?.name[lang] ?? ""));
      break;
  }
  return h("li", { class: `pop ${cls}` }, h("span", { class: "icon" }, icon), h("span", { class: "text" }, text));
}

// ---------------------------------------------------------------------------

watchFit();
// The maps' badges are drawn in the display face: again once it is there.
document.fonts?.addEventListener("loadingdone", () => refresh?.());
void worldLoaded;
if (client.canResume) {
  client.connect().catch(() => joinForm());
} else {
  joinForm();
}
