// @ts-check
/**
 * Krakel's phone page: joining, the lobby (the VIP's settings), picking
 * a word and drawing it (pens in colour, an eraser, undo; the page is
 * kept while it is drawn, so a reload loses nothing), then for each
 * drawing on stage its replay with the guess typed below it (a wrong
 * guess locks for a moment), a heart for the favourite, the place of
 * one's own drawing, scores. Everything it shows comes from the party's
 * view (`{ roster, room, me }`); everything it does is an action.
 */

import { blockEmoji, PartyClient } from "/_tvpipe/lib/client.js";
import { watchFit } from "./fit.js";
import { browserLang, LANGS, pickLang } from "./i18n.js";
import { drawInk, ERASER, fit, GRID, Live, MAX_POINTS, MAX_STROKES, PALETTE, progressAt, Replay, WIDTHS } from "./ink.js";
import { strings } from "./strings.js";

/** The size buttons' dots, px. */
const DOTS = [5, 10, 17, 26];
const MAX_GUESS = 28;
/** The points of a stroke are at least this far apart (grid units). */
const STEP = 4;

// A controller, not a document: no pinch or double-tap zoom, no selection.
for (const type of ["gesturestart", "gesturechange", "gestureend"]) document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
document.addEventListener("touchmove", (e) => e.touches.length > 1 && e.preventDefault(), { passive: false });
document.addEventListener("dblclick", (e) => e.preventDefault(), { passive: false });
document.addEventListener("selectstart", (e) => {
  const t = e.target instanceof Element ? e.target : /** @type {Node} */ (e.target).parentElement;
  if (!t?.closest("input")) e.preventDefault();
});

// The visible height (the keyboard takes the rest): full-screen layouts fit it.
function appHeight() {
  const hgt = window.visualViewport?.height ?? window.innerHeight;
  document.documentElement.style.setProperty("--app-h", `${Math.round(hgt)}px`);
  if (document.body.classList.contains("full")) window.scrollTo(0, 0);
}
window.visualViewport?.addEventListener("resize", appHeight);
window.addEventListener("resize", appHeight);
appHeight();

const client = PartyClient.fromLocation();
// No emoji in names, answers or clues (the host drops them too).
blockEmoji();
const app = /** @type {HTMLElement} */ (document.getElementById("app"));
const banner = /** @type {HTMLElement} */ (document.getElementById("banner"));
const who = /** @type {HTMLElement} */ (document.getElementById("who"));

// ---------------------------------------------------------------------------
// The language: the room's, the same on every phone (the words and the
// guesses are in it; the host page or the VIP sets it); before joining,
// the browser's.

function roomLang() {
  const l = client.view?.room?.lang;
  return typeof l === "string" ? pickLang(l) : browserLang();
}
let lang = roomLang();
let t = strings(lang);
document.documentElement.lang = lang;
function useLang() {
  const l = roomLang();
  if (l === lang) return false;
  lang = l;
  t = strings(l);
  document.documentElement.lang = l;
  return true;
}

let shown = "";
/** @type {(() => void) | null} called on every view while the screen stays */
let refresh = null;
/** @type {(() => void) | null} sends what there is when time is up */
let autoSubmit = null;
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
/** @param {...(Node | null)} nodes */
function show(...nodes) {
  app.replaceChildren(...nodes.filter((n) => n !== null));
}
/** @param {string | null} text */
function setBanner(text) {
  banner.hidden = !text;
  banner.textContent = text ?? "";
}
const SVG_NS = "http://www.w3.org/2000/svg";
/** @param {string} d */
function icon(d) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  for (const part of d.split("|")) {
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("d", part);
    svg.append(p);
  }
  return svg;
}
const TRASH = "M4 7h16|M9 7V4h6v3|M6 7l1 13h10l1-13";
const UNDO = "M9 14L4 9l5-5|M4 9h10a6 6 0 0 1 0 12h-3";
const RUBBER = "M4 16l9-10 7 6-7 8H8z|M9 11l6 6";
const HEART = "M12 20s-7-4.6-7-10a4 4 0 0 1 7-2.4A4 4 0 0 1 19 10c0 5.4-7 10-7 10z";

/** A player's colour from the room (`colors` by id). */
function colorOf(/** @type {string | undefined} */ id) {
  const c = id ? client.view?.room?.colors?.[id] : undefined;
  return typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c) ? c : "#7c8696";
}
/** @param {{ id?: string, name?: string, color?: string } | null | undefined} p */
function avatar(p) {
  const c = typeof p?.color === "string" && /^#[0-9a-f]{6}$/i.test(p.color) ? p.color : colorOf(p?.id);
  return h("span", { class: "avatar", style: { "--c": c } }, [...(p?.name ?? "?")][0]?.toUpperCase() ?? "?");
}
/** A name from the roster. */
function nameOf(/** @type {string} */ id) {
  return (client.view?.roster ?? []).find((/** @type {any} */ r) => r.id === id)?.name ?? "?";
}

/** A short buzz, where phones do that. @param {number | number[]} ms */
function buzz(ms) {
  try {
    navigator.vibrate?.(ms);
  } catch {}
}

// ---------------------------------------------------------------------------
// Fields

/** A canvas to measure text with. @type {CanvasRenderingContext2D | null} */
let ruler = null;

/**
 * Keeps what is typed in a field readable whole: when the text gets
 * longer than the field, its font gets smaller (down to `min` px)
 * instead of the text scrolling out of sight.
 * @param {HTMLInputElement} input
 * @param {number} [min]
 */
function fitField(input, min = 12) {
  input.style.fontSize = "";
  input.style.letterSpacing = "";
  const text = input.value;
  if (!text || !input.clientWidth) return;
  const cs = getComputedStyle(input);
  const base = parseFloat(cs.fontSize);
  ruler ??= document.createElement("canvas").getContext("2d");
  if (!ruler || !base) return;
  ruler.font = `${cs.fontWeight} ${base}px ${cs.fontFamily}`;
  const shown = cs.textTransform === "uppercase" ? text.toUpperCase() : text;
  const spacing = parseFloat(cs.letterSpacing) || 0;
  const width = (ruler.measureText(shown).width + spacing * [...shown].length) * 1.04;
  const room = input.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 2;
  if (width <= room || room <= 0) return;
  input.style.fontSize = `${Math.max(min, (base * room) / width).toFixed(2)}px`;
}
// Every field: while typing, and when it comes into view with text in it.
document.addEventListener("input", (e) => e.target instanceof HTMLInputElement && fitField(e.target));
document.addEventListener("focusin", (e) => e.target instanceof HTMLInputElement && fitField(e.target));

// ---------------------------------------------------------------------------
// Joining

/** @param {string} [error] @param {string} [typed] */
function joinForm(error = "", typed) {
  shown = "join";
  refresh = null;
  const input = /** @type {HTMLInputElement} */ (h("input", { id: "name", maxlength: 16, autocapitalize: "words", enterkeyhint: "go", autocomplete: "off", required: true }));
  const err = h("p", { class: "error" }, error);
  input.value = typed ?? client.saved?.name ?? localStorage.getItem("krakel:name") ?? "";
  const form = h(
    "form",
    {
      autocomplete: "off",
      onsubmit: async (/** @type {Event} */ e) => {
        e.preventDefault();
        const name = input.value.trim();
        if (!name) return;
        try {
          localStorage.setItem("krakel:name", name);
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
  show(logo(), h("section", { class: "card pop" }, h("h1", {}, t.joinTitle), form));
  if (!input.value) input.focus();
}

function logo() {
  return h("div", { class: "logo" }, ...[..."Krakel"].map((c, i) => h("span", { style: { "--i": String(i) } }, c)));
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

client.on("status", (s) => {
  if (s === "reconnecting") setBanner(t.reconnecting);
  else if (s === "open") setBanner(null);
});
client.on("bye", (reason) => {
  const text = reason === "kicked" ? t.kicked : reason === "replaced" ? t.replaced : reason === "room-closed" ? t.roomClosed : null;
  if (!text) return;
  shown = "bye";
  refresh = null;
  for (const c of cleanups) c();
  cleanups = [];
  document.body.classList.remove("full");
  setBanner(null);
  show(logo(), h("section", { class: "card" }, h("p", { class: "big" }, text)));
});
client.on("view", (view) => render(view));

// ---------------------------------------------------------------------------
// Views

/** @param {any} me @param {any} room */
function keyOf(me, room) {
  const d = me.done ? 1 : 0;
  switch (me.task) {
    case "draw":
    case "vote":
      return `${me.task}:${room.round}:${d}`;
    case "guess":
      return `guess:${me.key}:${me.right ? 1 : 0}`;
    case "artist":
    case "result":
      return `${me.task}:${me.key}`;
    default:
      return `${me.task}:${room.round ?? ""}`;
  }
}

/** @param {Record<string, any>} view */
function render(view) {
  const me = view.me ?? {};
  const room = view.room ?? {};
  const mine = (view.roster ?? []).find((/** @type {any} */ r) => r.id === client.you?.id);
  if (useLang()) shown = "";
  const scoreText = typeof me.score === "number" && me.task !== "lobby" && me.of > 0 ? ` · ${t.n(me.score)}` : "";
  who.replaceChildren(...(mine ? [h("span", { class: "dot", style: { "--c": colorOf(mine.id) } }), h("b", {}, `${mine.vip ? "★ " : ""}${mine.name}`), scoreText] : []));
  const key = keyOf(me, room);
  if (key !== shown) {
    shown = key;
    refresh = null;
    autoSubmit = null;
    for (const c of cleanups) c();
    cleanups = [];
    document.body.classList.toggle("full", (me.task === "draw" && !me.done) || me.task === "guess" || me.task === "artist");
    appHeight();
    build(view);
  }
  refresh?.();
}

/** @param {Record<string, any>} view */
function build(view) {
  const me = view.me ?? {};
  const room = view.room ?? {};
  switch (me.task) {
    case "lobby":
      return lobby();
    case "wait":
      return show(h("section", { class: "card pop" }, h("p", { class: "big" }, me.note === "game" ? t.waitGame : t.waitRound)));
    case "draw":
      return me.done ? handedIn(room) : draw(me, room);
    case "guess":
    case "artist":
      return stage(me, room);
    case "result":
      return result(me);
    case "vote":
      return me.done ? heartGiven(me) : vote(me, room);
    case "ranked":
      return ranked(me);
    case "scores":
      return scoreCard(me, room);
    case "final":
      return final();
    default:
      return show(h("section", { class: "card" }, h("p", { class: "big" }, t.lookTv)));
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
  /** @type {{ key: string, buttons: HTMLButtonElement[], values: any[], line: HTMLElement | null }[]} */
  // The host page's settings, the same choices (the game checks them; none during a game).
  const items = [];
  const box = h("div", { class: "settings" }, h("h2", {}, t.settings));
  const add = (/** @type {string} */ key, /** @type {any[]} */ values, /** @type {string[]} */ labels, /** @type {string} */ title, /** @type {boolean} */ withLine) => {
    const buttons = values.map((v, i) => /** @type {HTMLButtonElement} */ (h("button", { type: "button", onclick: () => act("settings", { [key]: v }, err).catch(() => {}) }, labels[i])));
    const line = withLine ? h("p", { class: "line" }) : null;
    box.append(h("div", { class: "setting" }, h("label", {}, title), h("div", { class: "seg" }, ...buttons), line));
    items.push({ key, buttons, values, line });
  };
  add("lang", [...LANGS], LANGS.map((l) => strings(l).langName), t.langLabel, false);
  add("rounds", [1, 2, 3, 4], ["1", "2", "3", "4"], t.roundsLabel, false);
  add("drawTime", [60, 90, 120, 180], [60, 90, 120, 180].map(t.minutes), t.drawLabel, false);
  add("guessTime", [30, 45, 60, 90], [30, 45, 60, 90].map(t.seconds), t.guessLabel, false);
  add("mixed", [false, true], [t.modeCategory, t.modeMixed], t.modeLabel, true);
  add("hints", [true, false], [t.hintsOn, t.hintsOff], t.hintsLabel, true);
  add("lockout", [0, 2, 4, 8], [t.lockNone, "2 s", "4 s", "8 s"], t.lockLabel, true);
  add("late", ["wait", "closed"], [t.lateWait, t.lateClosed], t.lateLabel, true);
  const update = () => {
    const room = client.view?.room ?? {};
    box.hidden = !isVip();
    for (const it of items) {
      const cur = room[it.key];
      it.buttons.forEach((b, i) => b.classList.toggle("on", it.values[i] === cur));
      // Only the languages there are words for.
      if (it.key === "lang") it.buttons.forEach((b, i) => (b.disabled = Array.isArray(room.langs) && !room.langs.includes(it.values[i])));
      if (it.key === "hints" && it.line) it.line.textContent = t.hintsLine[cur ? 1 : 0];
      if (it.key === "mixed" && it.line) it.line.textContent = t.modeLine[cur ? 1 : 0];
      if (it.key === "lockout" && it.line) it.line.textContent = t.lockLine(cur ?? 0);
      if (it.key === "late" && it.line) it.line.textContent = t.lateLine[cur === "closed" ? 1 : 0];
    }
  };
  return { box, update };
}

function lobby() {
  const err = h("p", { class: "error" });
  const list = h("div", { class: "chips" });
  const hint = h("p", { class: "muted small" });
  const start = /** @type {HTMLButtonElement} */ (h("button", { class: "btn", id: "start", onclick: () => act("start", null, err).catch(() => {}) }, t.start));
  const set = settings(err);
  const rulesLine = h("p", { class: "small muted" });
  show(
    h("section", { class: "card pop lobby" }, h("h1", {}, t.youreIn), h("h2", {}, t.players), list, start, err, hint, rulesLine, set.box),
    h("section", { class: "card plain" }, h("h2", { style: { "margin-top": "0" } }, t.howTitle), h("ol", { class: "how" }, ...t.how.map((x) => h("li", {}, x)))),
  );
  refresh = () => {
    const v = client.view;
    const roster = v.roster ?? [];
    const vip = isVip();
    const min = v.room?.minPlayers ?? 3;
    const ready = roster.filter((/** @type {any} */ r) => r.connected).length;
    list.replaceChildren(
      ...roster.map((/** @type {any} */ r) =>
        h(
          "span",
          { class: `chip${r.connected ? "" : " away"}` },
          h("span", { class: "dot", style: { "--c": colorOf(r.id) } }),
          r.name,
          r.vip ? h("small", {}, t.vip) : null,
          vip && r.id !== client.you?.id ? h("button", { type: "button", "aria-label": `✕ ${r.name}`, onclick: () => act("kick", { id: r.id }, err).catch(() => {}) }, "✕") : null,
        ),
      ),
    );
    start.hidden = !vip;
    start.disabled = ready < min;
    hint.textContent = vip ? (ready < min ? t.vipWait(min - ready) : t.vipReady) : t.waitVip;
    const room = v.room ?? {};
    rulesLine.textContent = t.rulesLine(room.rounds ?? 2, room.drawTime ?? 120, room.guessTime ?? 45, room.hints !== false, !!room.mixed);
    rulesLine.hidden = vip;
    set.update();
  };
}

function final() {
  const me = client.view?.me ?? {};
  const err = h("p", { class: "error" });
  const again = /** @type {HTMLButtonElement} */ (h("button", { class: "btn", id: "start", onclick: () => act("start", null, err).catch(() => {}) }, t.playAgain));
  const set = settings(err);
  show(
    h(
      "section",
      { class: "card pop" },
      h("h1", {}, me.rank === 1 && me.of > 0 ? t.won : t.gameOver),
      h("p", { class: "score" }, t.n(me.score ?? 0), h("small", {}, t.points)),
      h("p", { class: "muted" }, me.of ? t.rank(me.rank ?? 0, me.of) : ""),
      again,
      err,
      set.box,
    ),
  );
  refresh = () => {
    again.hidden = !isVip();
    set.update();
  };
}

// ---------------------------------------------------------------------------
// The clock

/**
 * A time bar and the seconds, ticking until the deadline.
 * @param {number} deadline
 * @param {number} [from] when the time starts to run (default: now)
 */
function clock(deadline, from) {
  const bar = h("div", { class: "timebar" }, h("i"));
  const secs = h("span", { class: "secs" });
  const total = Math.max(1000, deadline - (from ?? client.now()));
  const fill = /** @type {HTMLElement} */ (bar.firstChild);
  const tick = () => {
    const ms = deadline - client.now();
    fill.style.transform = `scaleX(${Math.max(0, Math.min(1, ms / total))})`;
    secs.textContent = String(Math.max(0, Math.ceil(Math.min(ms, total) / 1000)));
    const low = ms < 10_000;
    bar.classList.toggle("low", low);
    secs.classList.toggle("low", low && ms > 0);
    if (ms < 900) autoSubmit?.();
  };
  tick();
  const timer = setInterval(tick, 200);
  cleanups.push(() => clearInterval(timer));
  return { bar, secs };
}

// ---------------------------------------------------------------------------
// The page being drawn, kept on the phone: a reload or a locked screen loses nothing.

const DRAFT_KEY = "krakel:draft";

/** @returns {{ room: string, round: number, choice: number | null, strokes: number[][] } | null} */
function loadDraft() {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "null");
    return d && typeof d === "object" && Array.isArray(d.strokes) ? d : null;
  } catch {
    return null;
  }
}

/** @param {number} round @param {number | null} choice @param {number[][]} strokes */
function saveDraft(round, choice, strokes) {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ room: client.room, round, choice, strokes }));
  } catch {}
}

/** The draft of this room's round, if there is one. @param {any} room */
function draftOf(room) {
  const d = loadDraft();
  return d && d.room === client.room && d.round === room.round ? d : null;
}

// ---------------------------------------------------------------------------
// Drawing: pens in colour, an eraser, four widths, undo.

class Pad {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    /** @type {number[][]} */
    this.strokes = [];
    this.points = 0;
    this.color = 1;
    /** @type {number} */
    this.width = WIDTHS[1];
    /** @type {Live | null} */
    this.live = null;
    this.locked = false;
    this.onchange = () => {};
    this.onfull = () => {};
    const f = fit(canvas);
    this.ctx = f.ctx;
    this.size = f.size;
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(canvas);
    cleanups.push(() => ro.disconnect());
    canvas.addEventListener("pointerdown", (e) => this.down(e));
    canvas.addEventListener("pointermove", (e) => this.move(e));
    canvas.addEventListener("pointerup", () => this.up());
    canvas.addEventListener("pointercancel", () => this.up());
    for (const type of ["touchstart", "touchmove", "touchend"]) canvas.addEventListener(type, (e) => e.preventDefault(), { passive: false });
    this.redraw();
  }
  /** @param {number[][]} strokes */
  load(strokes) {
    this.strokes = strokes;
    this.points = strokes.reduce((n, s) => n + (s.length - 2) / 2, 0);
    this.redraw();
  }
  resize() {
    const f = fit(this.canvas);
    this.ctx = f.ctx;
    this.size = f.size;
    this.redraw();
  }
  redraw() {
    drawInk(this.ctx, { strokes: this.strokes }, 0, 0, this.size);
  }
  get full() {
    return this.strokes.length >= MAX_STROKES || this.points >= MAX_POINTS;
  }
  /** @param {PointerEvent} e */
  at(e) {
    const r = this.canvas.getBoundingClientRect();
    const k = GRID / r.width;
    return [Math.round(Math.min(GRID, Math.max(0, (e.clientX - r.left) * k))), Math.round(Math.min(GRID, Math.max(0, (e.clientY - r.top) * k)))];
  }
  /** @param {PointerEvent} e */
  down(e) {
    if (this.locked || this.live) return;
    e.preventDefault();
    if (this.full) return this.onfull();
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {}
    const [x, y] = this.at(e);
    const s = [this.color, this.width, x, y];
    this.strokes.push(s);
    this.points++;
    this.live = new Live(this.ctx, s, this.size / GRID);
  }
  /** @param {PointerEvent} e */
  move(e) {
    const live = this.live;
    if (!live) return;
    e.preventDefault();
    for (const ev of e.getCoalescedEvents?.() ?? [e]) {
      if (this.points >= MAX_POINTS) {
        this.up();
        return this.onfull();
      }
      const [x, y] = this.at(ev);
      const s = live.s;
      if (Math.hypot(x - s[s.length - 2], y - s[s.length - 1]) < STEP) continue;
      s.push(x, y);
      this.points++;
      live.add();
    }
  }
  up() {
    if (!this.live) return;
    this.live.end();
    this.live = null;
    this.onchange();
  }
  clear() {
    this.strokes = [];
    this.points = 0;
    this.redraw();
    this.onchange();
  }
  undo() {
    if (this.live) return;
    const s = this.strokes.pop();
    if (!s) return;
    this.points -= (s.length - 2) / 2;
    this.redraw();
    this.onchange();
  }
}

/**
 * A button that asks once more before it acts (`sure` for a moment).
 * @param {HTMLButtonElement} button
 * @param {string} sure
 * @param {() => void} go
 * @param {() => boolean} [ask] whether to ask at all (default: always)
 */
function twice(button, sure, go, ask = () => true) {
  const was = [...button.childNodes];
  /** @type {ReturnType<typeof setTimeout> | 0} */
  let armed = 0;
  const disarm = () => {
    if (armed) clearTimeout(armed);
    armed = 0;
    button.classList.remove("arm");
    button.replaceChildren(...was);
  };
  button.addEventListener("click", () => {
    if (armed || !ask()) {
      disarm();
      return go();
    }
    button.classList.add("arm");
    button.textContent = sure;
    armed = setTimeout(disarm, 2400);
  });
  cleanups.push(disarm);
}

/** @param {any} me @param {any} room */
function draw(me, room) {
  const { bar, secs } = clock(me.deadline ?? 0);
  const canvas = /** @type {HTMLCanvasElement} */ (h("canvas", { class: "pad" }));
  const err = h("p", { class: "error" });
  const choices = /** @type {string[]} */ (Array.isArray(me.choices) ? me.choices : []);
  const draft = draftOf(room);
  /** @type {number | null} */
  let choice = choices.length <= 1 ? 0 : draft && typeof draft.choice === "number" && draft.choice < choices.length ? draft.choice : null;
  const wordEl = h("span", { class: "word", "data-fit": "1" }, "…");
  const swap = /** @type {HTMLButtonElement} */ (h("button", { class: "swap", type: "button" }, t.change));
  // Each word's category: the round's, or in a mixed round its own.
  const cats = /** @type {string[]} */ (Array.isArray(me.categories) ? me.categories : []);
  const label = h("span", { class: "label", "data-fit": "1" });
  const tag = h("div", { class: "wordtag" }, label, h("span", { class: "wordline" }, wordEl, swap));
  const hint = h("p", { class: "ontop" }, t.firstHint);
  const paper = h("div", { class: "paperbox" }, canvas, hint);
  const done = /** @type {HTMLButtonElement} */ (h("button", { class: "btn", id: "done", type: "button" }, t.done));
  const palette = h("div", { class: "palette" });
  const sizes = h("div", { class: "sizes" });
  const undo = /** @type {HTMLButtonElement} */ (h("button", { class: "tool", type: "button", "aria-label": t.undoBtn, onclick: () => pad.undo() }, icon(UNDO)));
  const clear = /** @type {HTMLButtonElement} */ (h("button", { class: "tool", type: "button", "aria-label": t.clear }, icon(TRASH)));
  const tools = h("div", { class: "tools" }, sizes, undo, clear, done);
  show(h("section", { class: "full-grid drawing" }, bar, h("div", { class: "top" }, tag, secs), h("div", { class: "padbox" }, paper), palette, tools), err);
  const pad = new Pad(canvas);
  if (draft) pad.load(draft.strokes);

  const colorButtons = PALETTE.map((c, i) =>
    h("button", { type: "button", class: i === ERASER ? "rubber" : "", "aria-label": t.colors[i], style: { "--c": c }, onclick: () => pickColor(i) }, i === ERASER ? icon(RUBBER) : null),
  );
  // The pens first, the eraser last.
  palette.append(...colorButtons.slice(1), colorButtons[0]);
  const widthButtons = WIDTHS.map((w, i) =>
    h("button", { type: "button", "aria-label": t.sizes[i], onclick: () => pickWidth(i) }, h("i", { style: { width: `${DOTS[i]}px`, height: `${DOTS[i]}px` } })),
  );
  sizes.append(...widthButtons);
  const pickColor = (/** @type {number} */ i) => {
    pad.color = i;
    colorButtons.forEach((b, j) => b.classList.toggle("on", i === j));
    sizes.style.setProperty("--c", i === ERASER ? "#b9bcc4" : PALETTE[i]);
  };
  const pickWidth = (/** @type {number} */ i) => {
    pad.width = WIDTHS[i];
    widthButtons.forEach((b, j) => b.classList.toggle("on", i === j));
  };
  pickColor(1);
  pickWidth(1);

  twice(clear, t.clearSure, () => pad.clear());
  // Done asks once while there is a lot of time left: it cannot be taken back.
  twice(done, t.doneSure, () => void submit(), () => (me.deadline ?? 0) - client.now() > 15_000);

  // The TV shows how much everyone drew (never what).
  let inkAt = 0;
  const ink = () => {
    inkAt = Date.now();
    client.input({ ink: pad.points });
  };
  /** @type {ReturnType<typeof setTimeout> | 0} */
  let saver = 0;
  const save = () => {
    saver = 0;
    saveDraft(room.round, choice, pad.strokes);
  };
  /** @type {HTMLElement | null} the words to pick from, while they are open */
  let box = null;
  const changed = () => {
    undo.disabled = clear.disabled = pad.strokes.length === 0;
    swap.hidden = choices.length <= 1 || pad.strokes.length > 0 || !!box;
    if (pad.strokes.length > 0) hint.classList.add("gone");
    if (Date.now() - inkAt >= 400) ink();
    saver ||= setTimeout(save, 600);
  };
  pad.onchange = changed;
  pad.onfull = () => {
    err.textContent = t.inkOut;
    setTimeout(() => err.textContent === t.inkOut && (err.textContent = ""), 3000);
  };
  const onHide = () => {
    if (saver) clearTimeout(saver);
    save();
  };
  document.addEventListener("visibilitychange", onHide);
  window.addEventListener("pagehide", onHide);
  cleanups.push(() => {
    document.removeEventListener("visibilitychange", onHide);
    window.removeEventListener("pagehide", onHide);
    if (saver) clearTimeout(saver);
  });

  // The words to pick from: cards over the pad until one is taken.
  const ask = () => {
    pad.locked = true;
    done.disabled = true;
    hint.hidden = true;
    label.textContent = room.mixed ? t.drawA : `${cats[0] ?? ""} · ${t.drawA}`;
    box = h(
      "div",
      { class: `choices n${choices.length}` },
      h("div", { class: "h" }, t.pick),
      ...choices.map((c, i) =>
        h(
          "button",
          {
            type: "button",
            onclick: () => {
              choice = i;
              taken();
              save();
            },
          },
          h("b", { "data-fit": "1" }, c),
          room.mixed ? h("small", { "data-fit": "1" }, cats[i] ?? "") : null,
        ),
      ),
      h("div", { class: "sub" }, room.mixed ? t.pickHintMixed : t.pickHint),
    );
    paper.append(box);
    swap.hidden = true;
  };
  const taken = () => {
    box?.remove();
    box = null;
    hint.hidden = false;
    swap.hidden = choices.length <= 1 || pad.strokes.length > 0;
    wordEl.textContent = choices[choice ?? 0] ?? "";
    label.textContent = `${cats[choice ?? 0] ?? ""} · ${t.drawA}`;
    pad.locked = false;
    done.disabled = false;
  };
  swap.addEventListener("click", () => {
    if (pad.strokes.length === 0 && !box) ask();
  });
  if (choice === null) ask();
  else taken();
  changed();

  let sent = false;
  const submit = async () => {
    if (sent) return;
    sent = true;
    done.disabled = true;
    pad.up();
    pad.locked = true;
    onHide();
    try {
      await act("draw", { strokes: pad.strokes, choice: choice ?? 0 }, err);
    } catch {
      sent = false;
      done.disabled = false;
      pad.locked = false;
    }
  };
  autoSubmit = () => void submit();
}

/** Handed in: the page, and waiting for the others. @param {any} room */
function handedIn(room) {
  const d = draftOf(room);
  const canvas = /** @type {HTMLCanvasElement} */ (h("canvas", { class: "thumb" }));
  const word = client.view?.me?.choices?.[d?.choice ?? 0];
  show(
    h(
      "section",
      { class: "card pop center" },
      h("h1", {}, t.doneTitle),
      d ? h("div", { class: "sheet tilt" }, canvas) : null,
      word ? h("p", { class: "caption" }, h("small", {}, t.yourWord), h("b", { "data-fit": "2" }, word)) : null,
      h("p", { class: "muted" }, t.doneLine),
    ),
  );
  if (d)
    requestAnimationFrame(() => {
      const f = fit(canvas);
      drawInk(f.ctx, d, 0, 0, f.size);
    });
}

// ---------------------------------------------------------------------------
// A drawing on stage: its replay, and the guess typed below it (or, for
// its artist and for those who have it, who has it so far).

/** The word's letters as blanks. @param {string} shape */
function blanks(shape) {
  const box = h("div", { class: "blanks", "data-fit": "w", "aria-label": t.letters([...shape].filter((c) => c === "_").length) });
  for (const word of shape.split(" ")) {
    const w = h("span", { class: "w" });
    for (const c of word) w.append(c === "_" ? h("i") : h("b", {}, c));
    box.append(w);
  }
  return box;
}

/** @param {any} me @param {any} room */
function stage(me, room) {
  const spot = room.spot ?? {};
  const artist = me.task === "artist";
  const guessing = me.task === "guess" && !me.right;
  const { bar, secs } = clock(spot.end ?? 0, spot.start ?? 0);
  const canvas = /** @type {HTMLCanvasElement} */ (h("canvas", { class: "view" }));
  const cover = h("div", { class: "cover" }, h("span", {}, t.ready));
  const paper = h("div", { class: "paperbox" }, canvas, cover);
  const count = h("span", { class: "count" });
  const head = h(
    "div",
    { class: "top" },
    avatar(spot.artist),
    h("div", { class: "what" }, h("span", { class: "label", "data-fit": "1" }, `${room.category ?? ""} · ${spot.index ?? 1}/${spot.of ?? 1}`), h("span", { class: "text" }, artist ? t.yoursUp : t.krakelOf(spot.artist?.name ?? ""))),
    secs,
  );
  const foot = h("div", { class: "foot" });
  show(h("section", { class: `full-grid staging${guessing ? " guessing" : ""}` }, bar, head, h("div", { class: "padbox" }, paper), foot));

  // The replay, in step with the TV's.
  const replay = new Replay(canvas, spot.drawing);
  const ro = new ResizeObserver(() => replay.resize());
  ro.observe(canvas);
  let raf = 0;
  let last = -1;
  const frame = () => {
    raf = requestAnimationFrame(frame);
    const now = client.now();
    const p = progressAt(now, spot.start ?? 0, spot.end ?? 0);
    cover.hidden = now >= (spot.start ?? 0);
    if (p === last && replay.done >= 0) return;
    last = p;
    replay.draw(p);
  };
  raf = requestAnimationFrame(frame);
  cleanups.push(() => {
    cancelAnimationFrame(raf);
    ro.disconnect();
  });

  const have = () => {
    const got = /** @type {string[]} */ (client.view?.room?.got ?? []);
    count.textContent = t.have(got.length, spot.asked ?? 0);
    return got;
  };

  if (artist) {
    const list = h("p", { class: "has" });
    foot.append(h("div", { class: "myword" }, h("small", {}, t.yourWord), h("b", { "data-fit": "1" }, me.word ?? "")), list, count);
    refresh = () => {
      const got = have();
      list.textContent = got.length === 0 ? t.nobodyYet : t.hasIt(got.map(nameOf));
    };
    return;
  }
  if (!guessing) {
    foot.append(h("div", { class: "gotit pop" }, h("b", {}, "✓"), h("span", {}, t.gotIt), h("strong", {}, `+${t.n(me.points ?? 0)}`), me.first ? h("em", {}, t.first) : null), count);
    refresh = () => void have();
    return;
  }

  const input = /** @type {HTMLInputElement} */ (
    h("input", { maxlength: MAX_GUESS, placeholder: t.guessPlaceholder, enterkeyhint: "send", autocapitalize: "none", autocomplete: "off", autocorrect: "off", spellcheck: "false", lang, "aria-label": t.whatIsIt })
  );
  const send = /** @type {HTMLButtonElement} */ (h("button", { class: "btn", type: "submit" }, t.send));
  const form = h("form", { class: "guess-form", autocomplete: "off" }, input, send);
  const feedback = h("p", { class: "feedback" });
  foot.append(h("div", { class: "hintrow" }, spot.shape ? blanks(spot.shape) : h("span", { class: "label" }, t.whatIsIt), count), feedback, form);
  let lockedUntil = me.lockedUntil ?? 0;
  let sending = false;
  const tick = () => {
    const now = client.now();
    const early = now < (spot.start ?? 0);
    const over = now > (spot.end ?? 0);
    const locked = now < lockedUntil;
    send.disabled = sending || early || over || locked;
    send.classList.toggle("locked", locked);
    send.textContent = locked ? t.lockedFor(Math.ceil((lockedUntil - now) / 1000)) : t.send;
    form.classList.toggle("locked", locked);
    if (over && !input.disabled) {
      input.disabled = true;
      input.blur();
      feedback.textContent = t.timeUp;
      feedback.className = "feedback";
    }
  };
  const timer = setInterval(tick, 100);
  cleanups.push(() => clearInterval(timer));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    input.focus();
    const text = input.value.trim();
    tick();
    if (!text || send.disabled) return;
    sending = true;
    tick();
    input.value = "";
    fitField(input);
    try {
      const r = /** @type {any} */ (await client.act("guess", { key: me.key, text }));
      if (r?.verdict === "right") return buzz([30, 40, 80]);
      lockedUntil = r?.lockedUntil ?? 0;
      feedback.textContent = r?.verdict === "close" ? t.close(text) : t.wrong(text);
      feedback.className = `feedback ${r?.verdict === "close" ? "close" : "wrong"}`;
      form.classList.remove("shake");
      void form.offsetWidth;
      form.classList.add("shake");
      buzz(60);
    } catch (x) {
      const code = /** @type {any} */ (x)?.code;
      if (code === "locked" || code === "not-yet") {
        input.value = text;
        fitField(input);
      }
      else if (code !== "not-now" && code !== "already") feedback.textContent = message(x);
    } finally {
      sending = false;
      tick();
    }
  });
  refresh = () => {
    lockedUntil = Math.max(lockedUntil, client.view?.me?.lockedUntil ?? 0);
    have();
    tick();
  };
}

/** After a drawing: the word, and what it paid. @param {any} me */
function result(me) {
  const pts = me.points ?? 0;
  show(
    h(
      "section",
      { class: `card pop center${me.mine ? " mine" : me.right ? " right" : " missed"}` },
      h("h2", { style: { "margin-top": "0" } }, me.mine ? t.yourDrawing : t.by(me.artist ?? "")),
      h("p", { class: "caption" }, h("small", {}, t.itWas), h("b", { "data-fit": "2" }, me.word ?? "")),
      pts > 0 ? h("p", { class: "score" }, `+${t.n(pts)}`) : null,
      me.mine ? h("p", { class: "big" }, t.named(me.got ?? 0, me.guessers ?? 0)) : me.right ? (me.first ? h("p", { class: "big" }, t.first) : null) : h("p", { class: "big" }, t.missed),
    ),
  );
}

// ---------------------------------------------------------------------------
// The hearts: every drawing of the round, one heart to give.

/** @param {any} me @param {any} room */
function vote(me, room) {
  const gallery = /** @type {any[]} */ (room.gallery ?? []);
  const err = h("p", { class: "error" });
  /** @type {string | null} */
  let pick = null;
  const confirm = /** @type {HTMLButtonElement} */ (h("button", { class: "btn heart", type: "button", disabled: true }, t.give));
  /** @type {{ id: string, el: HTMLElement }[]} */
  const cards = [];
  /** @type {(() => void)[]} */
  const paints = [];
  const grid = h("div", { class: "cands" });
  for (const g of gallery) {
    const mine = g.id === client.you?.id;
    const c = /** @type {HTMLCanvasElement} */ (h("canvas"));
    const el = h(
      "button",
      {
        class: `cand${mine ? " mine" : ""}`,
        type: "button",
        disabled: mine,
        "data-id": g.id,
        onclick: () => {
          pick = g.id;
          for (const x of cards) x.el.classList.toggle("on", x.id === g.id);
          confirm.disabled = false;
          confirm.textContent = t.giveTo(g.artist?.name ?? "");
        },
      },
      c,
      h("span", { class: "w", "data-fit": "1" }, g.word ?? ""),
      h("span", { class: "by" }, h("span", { class: "dot", style: { "--c": g.artist?.color ?? colorOf(g.id) } }), mine ? t.mineTag : (g.artist?.name ?? "")),
      h("span", { class: "hrt" }, icon(HEART)),
    );
    cards.push({ id: g.id, el });
    grid.append(el);
    paints.push(() => {
      const f = fit(c);
      drawInk(f.ctx, g.drawing, 0, 0, f.size);
    });
  }
  confirm.addEventListener("click", async () => {
    if (!pick) return;
    confirm.disabled = true;
    try {
      await act("vote", { id: pick }, err);
      buzz(30);
    } catch {
      confirm.disabled = false;
    }
  });
  const { bar, secs } = clock(me.deadline ?? 0);
  show(h("section", { class: "voting" }, bar, h("div", { class: "top" }, h("div", { class: "what" }, h("h1", { style: { margin: "6px 0 0" } }, t.heartTitle)), secs), h("p", { class: "small", style: { margin: "0 0 10px" } }, t.heartHelp), grid, h("div", { class: "verdict-bar" }, confirm, err)));
  requestAnimationFrame(() => {
    for (const p of paints) p();
  });
}

/** @param {any} me */
function heartGiven(me) {
  show(h("section", { class: "card pop center" }, h("div", { class: "bigheart" }, icon(HEART)), h("p", { class: "big" }, me.choice ? t.given : t.noHeart)));
}

/** The place of one's own drawing. @param {any} me */
function ranked(me) {
  if (me.place == null) return show(h("section", { class: "card pop center" }, h("h2", { style: { "margin-top": "0" } }, t.rankedTitle), h("p", { class: "big" }, t.blankPage)));
  show(
    h(
      "section",
      { class: `card pop center place p${Math.min(4, me.place)}` },
      h("h2", { style: { "margin-top": "0" } }, t.rankedTitle),
      h("p", { class: "caption" }, h("b", { "data-fit": "2" }, me.word ?? "")),
      h("p", { class: "score", "data-fit": "1" }, t.place(me.place, me.drawings ?? 1)),
      h("p", { class: "big" }, t.pointsN(me.points ?? 0, "+")),
      me.hearts > 0 ? h("p", { class: "heartline" }, icon(HEART), t.hearts(me.hearts)) : null,
      me.fav > 0 ? h("p", { class: "fav" }, `${t.favourite} +${t.n(me.fav)}`) : null,
    ),
  );
}

// ---------------------------------------------------------------------------
// Scores

/** @param {any} me @param {any} room */
function scoreCard(me, room) {
  const e = me.earned ?? {};
  const kinds = /** @type {const} */ (["drawn", "guessed", "first", "favourite"]);
  show(
    h(
      "section",
      { class: "card pop" },
      h("h2", { style: { "margin-top": "0" } }, `${t.roundN(room.round ?? 1)} · ${t.thisRound}`),
      h("p", { class: "score" }, `+${t.n(me.delta ?? 0)}`),
      h("ul", { class: "gains" }, ...kinds.filter((k) => e[k] > 0).map((k) => h("li", {}, h("span", {}, t.kinds[k]), h("b", {}, `+${t.n(e[k])}`)))),
      h("p", { class: "total" }, `${t.pointsN(me.score ?? 0)} · ${me.of ? t.rank(me.rank ?? 0, me.of) : ""}`),
    ),
  );
}

watchFit();

// Keep the screen on while playing.
async function wake() {
  try {
    await /** @type {any} */ (navigator).wakeLock?.request("screen");
  } catch {}
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void wake();
});

// ---------------------------------------------------------------------------

/** @type {HTMLElement} */ (app.querySelector(".big")).textContent = t.connecting;
if (!client.room || !client.key) {
  show(logo(), h("section", { class: "card" }, h("p", { class: "big" }, t.scanToJoin)));
} else if (client.canResume) {
  client.connect().then(wake, (e) => joinForm(e?.code === "no-player" ? "" : message(e)));
} else {
  joinForm();
}
