// @ts-check
/**
 * Garble's phone page: joining, the lobby and the final screen (the VIP's
 * settings: all of the host page's), picking the first word, guessing
 * what a picture is now, drawing the dealt word on top of it (the old ink
 * a shade lighter; undo for your own strokes when the room allows it),
 * passing on, reactions during the reveal, the vote for the best move,
 * scores. Everything it shows comes from the party's view (`{ roster,
 * room, me }`); everything it does is an action.
 */

import { blockEmoji, PartyClient } from "/_tvpipe/lib/client.js";
import { watchFit } from "./fit.js";
import { browserLang, format, LANGS, pickLang } from "./i18n.js";
import { drawInk, drawLayers, fit, GRID, INK, Live, MAX_POINTS, MAX_STROKES, OLD_INK, WIDTHS } from "./ink.js";
import { strings } from "./strings.js";

/** The pens' buttons: a dot per width (WIDTHS, game/ink.ts). */
const DOTS = [7, 13, 22];
/** The longest guess (MAX_GUESS, game/rules.ts). */
const MAX_GUESS = 28;
/** The earlier layers of a best-move candidate, under its own in colour. */
const FADED = "#cdc6b6";

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
// The language: the room's, the same on every phone (the host page or the
// VIP sets it); before joining, the browser's.

function roomLang() {
  const l = client.view?.room?.lang;
  return typeof l === "string" ? pickLang(l) : browserLang();
}
let lang = roomLang();
let t = strings(lang);
let fmt = format(lang);
document.documentElement.lang = lang;
function useLang() {
  const l = roomLang();
  if (l === lang) return false;
  lang = l;
  t = strings(l);
  fmt = format(l);
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
/** @type {CanvasRenderingContext2D | null} */
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
  const text = input.value;
  if (!text || !input.clientWidth) return;
  const cs = getComputedStyle(input);
  const base = parseFloat(cs.fontSize);
  ruler ??= document.createElement("canvas").getContext("2d");
  if (!ruler || !base) return;
  ruler.font = `${cs.fontWeight} ${base}px ${cs.fontFamily}`;
  const spacing = parseFloat(cs.letterSpacing) || 0;
  const width = (ruler.measureText(text).width + spacing * [...text].length) * 1.04;
  const room = input.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 2;
  if (width <= room || room <= 0) return;
  input.style.fontSize = `${Math.max(min, (base * room) / width).toFixed(2)}px`;
}
// Every field: while typing, when it comes into view with text in it, and when the screen turns or the keyboard comes up.
document.addEventListener("input", (e) => e.target instanceof HTMLInputElement && fitField(e.target));
document.addEventListener("focusin", (e) => e.target instanceof HTMLInputElement && fitField(e.target));
addEventListener("resize", () => {
  for (const input of document.querySelectorAll("input")) fitField(input);
});
// Words players read (data-fit): smaller instead of cut off or broken.
watchFit();

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
const PENCIL = "M4 20l1-5L16 4l4 4L9 19z|M14 6l4 4";

/** A player's colour from the room (`colors` by id). */
function colorOf(/** @type {string | undefined} */ id) {
  const c = id ? client.view?.room?.colors?.[id] : undefined;
  return typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c) ? c : "#7c8696";
}
/** @param {{ id?: string, name?: string, color?: string } | null | undefined} p */
function avatar(p) {
  const c = typeof p?.color === "string" ? p.color : colorOf(p?.id);
  return h("span", { class: "avatar", style: { "--c": c } }, [...(p?.name ?? "?")][0]?.toUpperCase() ?? "?");
}

// ---------------------------------------------------------------------------
// Joining

/** @param {string} [error] @param {string} [typed] */
function joinForm(error = "", typed) {
  shown = "join";
  refresh = null;
  const input = /** @type {HTMLInputElement} */ (h("input", { id: "name", maxlength: 16, autocapitalize: "words", enterkeyhint: "go", autocomplete: "off", required: true }));
  const err = h("p", { class: "error" }, error);
  input.value = typed ?? client.saved?.name ?? localStorage.getItem("garble:name") ?? "";
  const form = h(
    "form",
    {
      autocomplete: "off",
      onsubmit: async (/** @type {Event} */ e) => {
        e.preventDefault();
        const name = input.value.trim();
        if (!name) return;
        try {
          localStorage.setItem("garble:name", name);
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
  show(logo(), h("section", { class: "card tilt" }, h("h1", {}, t.joinTitle), form));
  if (!input.value) input.focus();
}

function logo() {
  return h("div", { class: "logo" }, ...[..."Garble"].map((c, i) => h("span", { class: i === 3 ? "red" : "", style: { "--r": `${[-4, 3, -2, 4, -3, 2][i]}deg` } }, c)));
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
    case "guess":
      return `${me.task}:${room.round}:${me.step}:${d}`;
    case "watch":
      return `watch:${room.round}:${me.index}`;
    case "vote":
      return `vote:${room.round}:${d}`;
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
  const scoreText = typeof me.score === "number" && me.task !== "lobby" && me.of > 0 ? ` · ${fmt.n(me.score)}` : "";
  who.replaceChildren(...(mine ? [h("span", { class: "dot", style: { "--c": colorOf(mine.id) } }), h("b", {}, `${mine.vip ? "★ " : ""}${mine.name}`), scoreText] : []));
  const key = keyOf(me, room);
  if (key !== shown) {
    shown = key;
    refresh = null;
    autoSubmit = null;
    for (const c of cleanups) c();
    cleanups = [];
    document.body.classList.toggle("full", (me.task === "draw" || me.task === "guess") && !me.done);
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
      return show(h("section", { class: "card" }, h("p", { class: "big" }, me.note === "game" ? t.waitGame : t.waitRound)));
    case "draw":
      return me.done ? passed(me) : draw(me);
    case "guess":
      return me.done ? passed(me) : guess(me);
    case "watch":
      return watch(me);
    case "vote":
      return me.done ? votedCard() : vote(me, room);
    case "best":
      return best(me);
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
  // The host page's settings (host/host.ts), in its order.
  /** @type {{ key: string, buttons: HTMLButtonElement[], values: any[], line: HTMLElement | null }[]} */
  const items = [];
  const box = h("div", {}, h("h2", {}, t.settings));
  const add = (/** @type {string} */ key, /** @type {any[]} */ values, /** @type {string[]} */ labels, /** @type {string} */ title, /** @type {boolean} */ withLine) => {
    const buttons = values.map((v, i) => /** @type {HTMLButtonElement} */ (h("button", { type: "button", onclick: () => act("settings", { [key]: v }, err).catch(() => {}) }, labels[i])));
    const line = withLine ? h("p", { class: "line" }) : null;
    box.append(h("div", { class: "setting" }, h("label", {}, title), h("div", { class: "seg" }, ...buttons), line));
    items.push({ key, buttons, values, line });
  };
  add("lang", [...LANGS], LANGS.map((l) => strings(l).langName), t.langLabel, false);
  add("rounds", [1, 2, 3, 4], ["1", "2", "3", "4"], t.roundsLabel, false);
  add("length", [3, 5, 7], ["3", "5", "7"], t.lengthLabel, true);
  add("timers", ["normal", "fast"], [t.normal, t.fast], t.timersLabel, false);
  add("late", ["wait", "closed"], [t.lateWait, t.lateClosed], t.lateLabel, true);
  add("undo", [false, true], [t.off, t.on], t.undoLabel, true);
  const update = () => {
    const room = client.view?.room ?? {};
    box.hidden = !isVip();
    for (const it of items) {
      const cur = room[it.key];
      it.buttons.forEach((b, i) => b.classList.toggle("on", it.values[i] === cur));
      // A language without words cannot be played (the host page greys it out too).
      if (it.key === "lang" && Array.isArray(room.langs)) it.buttons.forEach((b, i) => (b.disabled = !room.langs.includes(it.values[i])));
      if (it.key === "late" && it.line) it.line.textContent = t.lateLine[cur === "closed" ? 1 : 0];
      if (it.key === "undo" && it.line) it.line.textContent = t.undoLine[cur ? 1 : 0];
      if (it.key === "length" && it.line) it.line.textContent = t.lengthLine(cur ?? 5);
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
  const rulesLine = h("p", { class: "small muted typed" });
  show(
    h("section", { class: "card tilt lobby" }, h("h1", {}, t.youreIn), h("h2", {}, t.players), list, start, err, hint, rulesLine, set.box),
    h("section", { class: "card dark" }, h("h2", { style: { "margin-top": "0" } }, t.howTitle), h("ol", { class: "how" }, ...t.how.map((x) => h("li", {}, x)))),
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
    rulesLine.textContent = t.rulesLine(room.rounds ?? 2, room.length ?? 5, !!room.undo);
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
      { class: "card tilt" },
      h("h1", {}, me.rank === 1 && me.of > 0 ? t.won : t.gameOver),
      h("p", { class: "score" }, fmt.n(me.score ?? 0), h("small", {}, t.points)),
      h("p", { class: "typed" }, me.of ? t.rank(me.rank ?? 0, me.of) : ""),
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
 */
function clock(deadline) {
  const bar = h("div", { class: "timebar" }, h("i"));
  const secs = h("span", { class: "secs" });
  const total = Math.max(1000, deadline - client.now());
  const fill = /** @type {HTMLElement} */ (bar.firstChild);
  const tick = () => {
    const ms = deadline - client.now();
    fill.style.transform = `scaleX(${Math.max(0, Math.min(1, ms / total))})`;
    secs.textContent = String(Math.max(0, Math.ceil(ms / 1000)));
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

/** The step's place: `2/4`, and a dot per step. @param {any} me */
function stepDots(me) {
  const n = Math.max(1, me.steps ?? 1);
  return h("span", { class: "steps", "aria-label": `${me.step}/${n}` }, ...Array.from({ length: n }, (_, i) => h("i", { class: i + 1 < me.step ? "past" : i + 1 === me.step ? "now" : "" })));
}

// ---------------------------------------------------------------------------
// Drawing: on top of the old ink (a shade lighter), three pens, undo of your own strokes.

class Pad {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{ strokes?: number[][] }} base the old ink (it cannot be touched)
   */
  constructor(canvas, base) {
    this.canvas = canvas;
    this.base = base;
    /** @type {number[][]} */
    this.strokes = [];
    this.points = 0;
    /** @type {number} */
    this.width = WIDTHS[1];
    /** @type {Live | null} */
    this.live = null;
    this.locked = false;
    this.onchange = () => {};
    /** A stroke was refused: the layer has all the ink it can take. */
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
  resize() {
    const f = fit(this.canvas);
    this.ctx = f.ctx;
    this.size = f.size;
    this.redraw();
  }
  redraw() {
    drawLayers(this.ctx, [{ drawing: this.base, color: OLD_INK }, { drawing: { strokes: this.strokes }, color: INK }], 0, 0, this.size);
  }
  /** Whether the layer has all the strokes or points it can take (MAX_STROKES, MAX_POINTS). */
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
    const s = [this.width, x, y];
    this.strokes.push(s);
    this.points++;
    this.live = new Live(this.ctx, s, this.size / GRID, INK);
    this.onchange();
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
      if (Math.hypot(x - s[s.length - 2], y - s[s.length - 1]) < 4) continue;
      s.push(x, y);
      this.points++;
      live.add();
    }
  }
  up() {
    this.live?.end();
    this.live = null;
  }
  /** Your own strokes go; the old ink stays. */
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
    this.points -= (s.length - 1) / 2;
    this.redraw();
    this.onchange();
  }
}

/** @param {any} me */
function draw(me) {
  const { bar, secs } = clock(me.deadline ?? 0);
  const canvas = /** @type {HTMLCanvasElement} */ (h("canvas", { class: "pad" }));
  const err = h("p", { class: "error" });
  const first = Array.isArray(me.choices);
  const wordEl = h("span", { class: "word", "data-fit": "2" }, first ? "…" : (me.word ?? ""));
  const tag = h("div", { class: "wordtag" }, h("span", { class: "label" }, first ? t.drawA : t.makeIt), wordEl);
  const hint = first ? null : h("p", { class: "ontop" }, t.onTop);
  const paper = h("div", { class: "paperbox" }, canvas, hint);
  const done = /** @type {HTMLButtonElement} */ (h("button", { class: "btn", id: "done", type: "button" }, t.done));
  const sizes = h("div", { class: "sizes" });
  const tools = h("div", { class: "tools" }, sizes);
  show(h("section", { class: "full-grid drawing" }, bar, h("div", { class: "top" }, tag, h("div", { class: "side" }, stepDots(me), secs)), h("div", { class: "padbox" }, paper), tools), err);
  const pad = new Pad(canvas, me.picture ?? { strokes: [] });
  const widthButtons = WIDTHS.map((w, i) =>
    h("button", { type: "button", "aria-label": t.sizes[i], onclick: () => pickWidth(i) }, h("i", { style: { width: `${DOTS[i]}px`, height: `${DOTS[i]}px` } })),
  );
  sizes.append(...widthButtons);
  const pickWidth = (/** @type {number} */ i) => {
    pad.width = WIDTHS[i];
    widthButtons.forEach((b, j) => b.classList.toggle("on", i === j));
  };
  pickWidth(1);
  if (me.undo) {
    const undo = /** @type {HTMLButtonElement} */ (h("button", { class: "tool", type: "button", "aria-label": t.undoBtn, onclick: () => pad.undo() }, icon(UNDO)));
    const clear = /** @type {HTMLButtonElement} */ (h("button", { class: "tool", type: "button", "aria-label": t.clear }, icon(TRASH)));
    // Clear asks once.
    /** @type {ReturnType<typeof setTimeout> | 0} */
    let armed = 0;
    const disarm = () => {
      if (armed) clearTimeout(armed);
      armed = 0;
      clear.classList.remove("arm");
      clear.replaceChildren(icon(TRASH));
    };
    clear.addEventListener("click", () => {
      if (armed) {
        disarm();
        pad.clear();
        return;
      }
      clear.classList.add("arm");
      clear.textContent = t.clearSure;
      armed = setTimeout(disarm, 2200);
    });
    tools.append(undo, clear);
    const changed = () => {
      undo.disabled = clear.disabled = pad.strokes.length === 0;
    };
    pad.onchange = () => {
      changed();
      hint?.classList.add("gone");
    };
    changed();
  } else pad.onchange = () => hint?.classList.add("gone");
  pad.onfull = () => {
    const say = t.inkOut(!!me.undo);
    err.textContent = say;
    setTimeout(() => err.textContent === say && (err.textContent = ""), 3000);
  };
  tools.append(done);
  // The first step: pick one of two words, then draw.
  /** @type {number | undefined} */
  let choice;
  if (first) {
    pad.locked = true;
    done.disabled = true;
    const box = h(
      "div",
      { class: "choices" },
      h("div", { class: "h" }, t.pick),
      ...me.choices.map((/** @type {string} */ c, /** @type {number} */ i) =>
        h(
          "button",
          {
            type: "button",
            onclick: () => {
              choice = i;
              wordEl.textContent = c;
              box.remove();
              pad.locked = false;
              done.disabled = false;
            },
          },
          h("span", { "data-fit": "2" }, c),
        ),
      ),
    );
    paper.append(box);
  }
  let sent = false;
  const submit = async () => {
    if (sent) return;
    sent = true;
    done.disabled = true;
    pad.up();
    try {
      await act("draw", { strokes: pad.strokes, ...(first ? { choice: choice ?? 0 } : {}) }, err);
    } catch {
      sent = false;
      done.disabled = false;
    }
  };
  done.addEventListener("click", () => void submit());
  autoSubmit = () => void submit();
}

// ---------------------------------------------------------------------------
// Guessing: the picture as it is now, all in one ink.

/** @param {any} me */
function guess(me) {
  const { bar, secs } = clock(me.deadline ?? 0);
  const canvas = /** @type {HTMLCanvasElement} */ (h("canvas", { class: "view" }));
  const picture = me.picture ?? { strokes: [] };
  const empty = !(picture.strokes?.length > 0);
  const paper = h("div", { class: "paperbox" }, canvas, empty ? h("div", { class: "overlay" }, t.blank) : null);
  const input = /** @type {HTMLInputElement} */ (
    h("input", { maxlength: MAX_GUESS, placeholder: t.guessPlaceholder, enterkeyhint: "send", autocapitalize: "none", autocomplete: "off", spellcheck: "true", lang, "aria-label": t.whatNow })
  );
  const err = h("p", { class: "error" });
  const send = /** @type {HTMLButtonElement} */ (h("button", { class: "btn", type: "submit" }, t.send));
  const form = h("form", { class: "guess-form", autocomplete: "off" }, input, send);
  const label = [me.from ? t.from(me.from) : "", me.last ? t.lastGuess : ""].filter(Boolean).join(" · ");
  show(
    h(
      "section",
      { class: "full-grid guessing" },
      bar,
      h("div", { class: "top" }, h("div", { class: "what" }, h("span", { class: "label" }, label), h("span", { class: "text" }, t.whatNow)), h("div", { class: "side" }, stepDots(me), secs)),
      h("div", { class: "padbox" }, paper),
      h("div", {}, form, err),
    ),
  );
  const paint = () => {
    const f = fit(canvas);
    drawInk(f.ctx, picture, 0, 0, f.size);
  };
  paint();
  const ro = new ResizeObserver(paint);
  ro.observe(canvas);
  cleanups.push(() => ro.disconnect());
  let sent = false;
  const submit = async (/** @type {boolean} */ auto) => {
    const text = input.value.trim();
    if (sent || !text) return;
    sent = true;
    send.disabled = true;
    try {
      await act("guess", { text }, auto ? undefined : err);
    } catch {
      sent = false;
      send.disabled = false;
    }
  };
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    void submit(false);
  });
  autoSubmit = () => void submit(true);
}

// ---------------------------------------------------------------------------
// Passed on: the page flies to the next player.

/** @param {any} me */
function passed(me) {
  const slip = h("div", { class: `slip${me.next ? "" : " stay"}` }, icon(PENCIL));
  show(
    h(
      "section",
      { class: "passed" },
      slip,
      h("div", { class: "to" }, me.next && me.task === "draw" ? fragment(t.passedTo("\u0000"), me.next) : t.lastDone),
      h("p", { class: "tip" }, t.waitOthers),
    ),
  );
}

/** A text with a name in bold where the placeholder (\0) is. @param {string} text @param {string} name */
function fragment(text, name) {
  const [a, b] = text.split("\u0000");
  const f = document.createDocumentFragment();
  f.append(a ?? "", h("b", {}, name), b ?? "");
  return f;
}

// ---------------------------------------------------------------------------
// The reveal: reactions.

function reactButtons() {
  return h(
    "div",
    { class: "reacts" },
    ...t.reactions.map((r, i) =>
      h(
        "button",
        {
          type: "button",
          onclick: () => {
            navigator.vibrate?.(12);
            client.act("react", { r: i }).catch(() => {});
          },
        },
        r,
      ),
    ),
  );
}

/** @param {any} me */
function watch(me) {
  show(
    h(
      "section",
      { class: "card tilt" },
      h("div", { class: "watching" }, avatar({ name: me.starter, color: undefined }), h("div", {}, h("div", { class: "t" }, t.pictureOf(me.starter ?? "")), h("div", { class: "typed small muted" }, `${me.index ?? 1} / ${me.of ?? 1}`))),
      h("p", { class: "big" }, me.mine ? t.youDrewHere : t.lookTv),
    ),
    h("h2", {}, t.react),
    reactButtons(),
  );
}

// ---------------------------------------------------------------------------
// The best move: every layer of the round, its new strokes in colour.

/** @param {any} me @param {any} room */
function vote(me, room) {
  const gallery = /** @type {any[]} */ (room.gallery ?? []);
  const own = new Set(/** @type {string[]} */ (me.mine ?? []));
  const err = h("p", { class: "error" });
  /** @type {string | null} */
  let pick = null;
  const confirm = /** @type {HTMLButtonElement} */ (h("button", { class: "btn", type: "button", disabled: true, "data-fit": "1" }, t.vote));
  /** @type {{ id: string, el: HTMLElement }[]} */
  const cards = [];
  /** @type {(() => void)[]} */
  const paints = [];
  const groups = gallery.map((p, pi) => {
    const layers = /** @type {any[]} */ (p.layers ?? []);
    const row = h("div", { class: "cands" });
    layers.forEach((l, k) => {
      if (!(l.drawing?.strokes?.length > 0)) return;
      const id = `${p.id}:${k}`;
      const mine = own.has(id);
      const c = /** @type {HTMLCanvasElement} */ (h("canvas"));
      const el = h(
        "button",
        {
          class: `cand${mine ? " mine" : ""}`,
          type: "button",
          disabled: mine,
          "data-layer": id,
          onclick: () => {
            pick = id;
            for (const x of cards) x.el.classList.toggle("on", x.id === id);
            confirm.disabled = false;
            confirm.textContent = t.voteFor(`${l.word} · ${l.by?.name ?? ""}`);
          },
        },
        c,
        h("span", { class: "w", "data-fit": "w" }, k > 0 ? h("s", {}, layers[k - 1]?.word ?? "") : null, k > 0 ? " → " : null, l.word ?? ""),
        h("span", { class: "by" }, h("span", { class: "dot", style: { "--c": l.by?.color ?? colorOf(l.by?.id) } }), mine ? t.mineTag : (l.by?.name ?? "")),
      );
      cards.push({ id, el });
      row.append(el);
      paints.push(() => {
        const f = fit(c);
        drawLayers(f.ctx, [{ drawing: { strokes: layers.slice(0, k).flatMap((x) => x.drawing?.strokes ?? []) }, color: FADED }, { drawing: l.drawing, color: l.by?.color ?? INK }], 0, 0, f.size);
      });
    });
    return h("div", { class: "group" }, h("h2", {}, t.pictureN(pi + 1, p.starter?.name ?? "")), row);
  });
  confirm.addEventListener("click", async () => {
    if (!pick) return;
    confirm.disabled = true;
    try {
      await act("vote", { layer: pick }, err);
    } catch {
      confirm.disabled = false;
    }
  });
  const { bar, secs } = clock(me.deadline ?? 0);
  show(
    h(
      "section",
      { class: "voting" },
      bar,
      h("div", { class: "top" }, h("div", { class: "what" }, h("h1", { style: { margin: "6px 0 0" } }, t.bestTitle)), secs),
      h("p", { class: "small muted", style: { margin: "0 0 4px" } }, t.bestHelp),
      ...groups,
      h("div", { class: "verdict-bar" }, confirm, err),
    ),
  );
  requestAnimationFrame(() => {
    for (const p of paints) p();
  });
}

function votedCard() {
  show(h("section", { class: "card tilt" }, h("h1", {}, t.bestTitle), h("p", { class: "big" }, t.voted)));
}

/** @param {any} me */
function best(me) {
  show(
    h(
      "section",
      { class: "card tilt" },
      h("h1", {}, t.bestTitle),
      me.won ? h("p", { class: "score" }, `+${fmt.n(me.points ?? 0)}`) : null,
      h("p", { class: "big" }, me.won ? t.bestWon : me.picked ? t.bestPicked : t.bestNot),
    ),
    h("h2", {}, t.react),
    reactButtons(),
  );
}

// ---------------------------------------------------------------------------
// Scores

/** @param {any} me @param {any} room */
function scoreCard(me, room) {
  const e = me.earned ?? {};
  const kinds = /** @type {const} */ (["drawn", "read", "best"]);
  show(
    h(
      "section",
      { class: "card tilt" },
      h("h2", { style: { "margin-top": "0" } }, `${t.roundN(room.round ?? 1)} · ${t.thisRound}`),
      h("p", { class: "score" }, `+${fmt.n(me.delta ?? 0)}`),
      h("ul", { class: "gains" }, ...kinds.filter((k) => e[k] > 0).map((k) => h("li", {}, h("span", {}, t.kinds[k]), h("b", {}, `+${fmt.n(e[k])}`)))),
      me.counts ? h("p", { class: "wordline" }, t.counts(me.counts)) : null,
      h("p", { class: "typed", style: { "margin-top": "14px" } }, `${fmt.n(me.score ?? 0)} ${t.points} · ${me.of ? t.rank(me.rank ?? 0, me.of) : ""}`),
    ),
  );
}

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
