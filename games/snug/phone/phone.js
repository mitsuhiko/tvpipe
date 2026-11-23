// @ts-check
/**
 * Snug's phone page: joining, the lobby (the VIP's settings), and a board:
 * the shape with what is on it, everyone's cursors, and one's own secret
 * hand below. Drag a piece onto the shape (tap turns it, ⇋ flips it);
 * tap one's own placed piece to take it back, drag it to move it; touch
 * anywhere else on the shape to point (a quick tap pings). Then solved,
 * time's up and the end. Everything it shows comes from the party's view
 * (`{ roster, room, me }`); everything it does is an action, or, for the
 * cursor, continuous input. docs/snug-design.md §4, §5, §11.
 */

import { blockEmoji, PartyClient } from "/_tvpipe/lib/client.js";
import { fitsAnywhere, flip, normalize, turn } from "../game/rules.js";
import { cushion, initial, piece, pointer, s } from "./candy.js";
import { watchFit } from "./fit.js";
import { browserLang, pickLang } from "./i18n.js";
import { strings } from "./strings.js";

// A controller, not a document: no pinch or double-tap zoom, no selection.
for (const type of ["gesturestart", "gesturechange", "gestureend"]) document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
document.addEventListener("touchmove", (e) => e.touches.length > 1 && e.preventDefault(), { passive: false });
document.addEventListener("dblclick", (e) => e.preventDefault(), { passive: false });
document.addEventListener("selectstart", (e) => {
  const tg = e.target instanceof Element ? e.target : /** @type {Node} */ (e.target).parentElement;
  if (!tg?.closest("input")) e.preventDefault();
});

const client = PartyClient.fromLocation();
blockEmoji();
const app = /** @type {HTMLElement} */ (document.getElementById("app"));
const banner = /** @type {HTMLElement} */ (document.getElementById("banner"));
const toastEl = /** @type {HTMLElement} */ (document.getElementById("toast"));
const who = /** @type {HTMLElement} */ (document.getElementById("who"));
const langButton = /** @type {HTMLButtonElement} */ (document.getElementById("lang"));

// ---------------------------------------------------------------------------
// The language: the phone's own choice, else the room's, else the browser's.

const LANG_KEY = "snug:lang";
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
/** @type {((view: any) => void) | null} called on every view while the screen stays */
let refresh = null;
/** @type {(() => void)[]} */
let cleanups = [];

// ---------------------------------------------------------------------------
// Helpers: text always as text.

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
/** @type {ReturnType<typeof setTimeout> | undefined} */
let toastTimer;
/** A message that pops up for a moment. @param {string} text @param {"ok" | "bad" | "info"} [kind] */
function toast(text, kind = "info") {
  toastEl.textContent = text;
  toastEl.className = kind;
  toastEl.hidden = false;
  void toastEl.offsetWidth;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2600);
}

const isColor = (/** @type {unknown} */ c) => typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c);
/** @param {string | undefined | null} id */
function colorOf(id) {
  const c = id ? client.view?.room?.colors?.[id] : undefined;
  return isColor(c) ? c : "#b9a3c9";
}
/** @param {string | undefined | null} id */
function nameOf(id) {
  return (client.view?.roster ?? []).find((/** @type {any} */ r) => r.id === id)?.name ?? "?";
}
/** @param {number | number[]} ms */
function buzz(ms) {
  try {
    navigator.vibrate?.(ms);
  } catch {}
}
const isVip = () => !!(client.view?.roster ?? []).find((/** @type {any} */ r) => r.id === client.you?.id)?.vip;

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

/** @param {string} type @param {any} data @param {HTMLElement} [err] */
async function act(type, data, err) {
  if (err) err.textContent = "";
  try {
    return await client.act(type, data);
  } catch (e) {
    if (err) err.textContent = message(e);
    else toast(message(e), "bad");
    throw e;
  }
}

/** The logo: the word with a bow. */
function logo() {
  return h("div", { class: "logo" }, h("span", {}, "snug"), h("i", { class: "bow" }));
}

// ---------------------------------------------------------------------------
// Joining

/** @param {string} [error] @param {string} [typed] */
function joinForm(error = "", typed) {
  shown = "join";
  refresh = null;
  langButton.hidden = false;
  langButton.textContent = t.otherLang;
  const input = /** @type {HTMLInputElement} */ (h("input", { id: "name", maxlength: 16, autocapitalize: "words", enterkeyhint: "go", autocomplete: "off", required: true }));
  const err = h("p", { class: "error" }, error);
  input.value = typed ?? client.saved?.name ?? localStorage.getItem("snug:name") ?? "";
  const form = h(
    "form",
    {
      autocomplete: "off",
      onsubmit: async (/** @type {Event} */ e) => {
        e.preventDefault();
        const name = input.value.trim();
        if (!name) return;
        try {
          localStorage.setItem("snug:name", name);
        } catch {}
        err.textContent = "";
        try {
          await client.join(name);
          void wake();
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
  setBanner(null);
  show(logo(), h("section", { class: "card" }, h("p", { class: "big" }, text)));
});
client.on("view", (view) => render(view));

// ---------------------------------------------------------------------------
// Views

/** @param {any} me @param {any} room */
function keyOf(me, room) {
  switch (me.task) {
    case "play":
    case "solved":
    case "over":
      return `board:${room.board ?? ""}`;
    default:
      return String(me.task ?? "");
  }
}

/** @param {Record<string, any>} view */
function render(view) {
  const me = view.me ?? {};
  const room = view.room ?? {};
  const mine = (view.roster ?? []).find((/** @type {any} */ r) => r.id === client.you?.id);
  if (useLang()) shown = "";
  who.replaceChildren(...(mine ? [h("span", { class: "dot", style: { "--c": colorOf(mine.id) } }), h("b", {}, `${mine.vip ? "★ " : ""}${mine.name}`)] : []));
  const k = keyOf(me, room);
  if (k !== shown) {
    shown = k;
    refresh = null;
    for (const c of cleanups) c();
    cleanups = [];
    langButton.hidden = !(me.task === "lobby" || me.task === "final");
    langButton.textContent = t.otherLang;
    document.body.classList.toggle("playing", k.startsWith("board:"));
    build(view);
  }
  refresh?.(view);
}

/** @param {Record<string, any>} view */
function build(view) {
  const me = view.me ?? {};
  switch (me.task) {
    case "lobby":
      return lobby();
    case "wait":
      return show(logo(), h("section", { class: "card pop" }, h("p", { class: "big" }, t.waitNext)));
    case "play":
    case "solved":
    case "over":
      return play();
    case "final":
      return final();
    default:
      return show(h("section", { class: "card" }, h("p", { class: "big" }, t.lookTv)));
  }
}

// ---------------------------------------------------------------------------
// Lobby and final: players, the VIP's settings, start.

/** @param {HTMLElement} err */
function settings(err) {
  /** @type {{ key: string, buttons: HTMLButtonElement[], values: string[] }[]} */
  const items = [];
  const line = h("p", { class: "line" });
  const box = h("div", { class: "settings" }, h("h2", {}, t.settings));
  const add = (/** @type {string} */ key, /** @type {string[]} */ values, /** @type {Record<string, string>} */ labels, /** @type {string} */ title) => {
    const buttons = values.map((v) => /** @type {HTMLButtonElement} */ (h("button", { type: "button", onclick: () => act("settings", { [key]: v }, err).catch(() => {}) }, labels[v] ?? v)));
    box.append(h("div", { class: "setting" }, h("label", {}, title), h("div", { class: "seg" }, ...buttons)));
    items.push({ key, buttons, values });
  };
  add("level", ["easy", "normal", "hard"], t.levels, t.levelLabel);
  box.append(line);
  add("pace", ["relaxed", "normal", "rushed"], t.paces, t.paceLabel);
  const update = () => {
    const room = client.view?.room ?? {};
    box.hidden = !isVip();
    for (const it of items) it.buttons.forEach((b, i) => b.classList.toggle("on", it.values[i] === room[it.key]));
    line.textContent = t.levelLine[/** @type {"easy"} */ (room.level)] ?? "";
  };
  return { box, update };
}

const LOBBY_SHAPES = /** @type {[number, number][][]} */ ([
  [[0, 0], [1, 0], [0, 1], [1, 1]],
  [[0, 0], [1, 0], [2, 0], [1, 1]],
  [[0, 0], [0, 1], [1, 1], [1, 2]],
  [[0, 0], [1, 0], [2, 0], [0, 1]],
  [[1, 0], [0, 1], [1, 1], [2, 1], [1, 2]],
  [[0, 0], [1, 0], [2, 0]],
  [[0, 0], [1, 0], [1, 1], [2, 1]],
  [[0, 0], [0, 1], [1, 0]],
]);

/** A small candy in its own SVG. @param {[number, number][]} cells @param {string} color @param {object} [o] */
function mini(cells, color, o = {}) {
  const n = /** @type {[number, number][]} */ (normalize(cells));
  const w = Math.max(...n.map((c) => c[0])) + 1;
  const hh = Math.max(...n.map((c) => c[1])) + 1;
  const svg = s("svg", { viewBox: `-0.15 -0.15 ${w + 0.3} ${hh + 0.3}`, class: "mini" });
  svg.append(piece(n, color, { inset: 0.05, ...o }));
  return svg;
}

function lobby() {
  const err = h("p", { class: "error" });
  const list = h("div", { class: "chips" });
  const hint = h("p", { class: "muted small" });
  const start = /** @type {HTMLButtonElement} */ (h("button", { class: "btn", id: "start", onclick: () => act("start", null, err).catch(() => {}) }, t.start));
  const set = settings(err);
  const myIndex = () => Math.max(0, (client.view?.roster ?? []).findIndex((/** @type {any} */ r) => r.id === client.you?.id));
  const me = h("div", { class: "mecandy" });
  show(
    logo(),
    h("section", { class: "card pop lobby" }, me, h("h1", {}, t.youreIn), h("h2", {}, t.players), list, start, err, hint, set.box),
    h("section", { class: "card plain" }, h("h2", { style: { "margin-top": "0" } }, t.howTitle), h("ol", { class: "how" }, ...t.how.map((x) => h("li", {}, x)))),
  );
  let meColor = "";
  refresh = () => {
    const v = client.view;
    const roster = v.roster ?? [];
    const vip = isVip();
    const min = v.room?.minPlayers ?? 2;
    const ready = roster.filter((/** @type {any} */ r) => r.connected).length;
    const c = colorOf(client.you?.id);
    if (c !== meColor) {
      meColor = c;
      me.replaceChildren(mini(LOBBY_SHAPES[myIndex() % LOBBY_SHAPES.length] ?? [[0, 0]], c, { mood: "happy", key: "me" }));
    }
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
    set.update();
  };
}

function final() {
  const err = h("p", { class: "error" });
  const again = /** @type {HTMLButtonElement} */ (h("button", { class: "btn", id: "start", onclick: () => act("start", null, err).catch(() => {}) }, t.playAgain));
  const set = settings(err);
  const head = h("h1", {});
  const num = h("p", { class: "score" });
  const sub = h("p", { class: "muted" });
  const awards = h("ul", { class: "awards" });
  show(logo(), h("section", { class: "card pop center" }, head, num, sub, awards, again, err, set.box));
  refresh = () => {
    const room = client.view?.room ?? {};
    const n = room.solved ?? 0;
    head.textContent = n > 0 ? t.gameOver : t.noneFilled;
    num.textContent = n > 0 ? t.filled(n) : "";
    sub.textContent = t.best(room.best ?? 0);
    const list = /** @type {const} */ (["fit", "pointer", "thoughts"]);
    awards.replaceChildren(
      ...list.flatMap((k) => {
        const a = room.awards?.[k];
        return a ? [h("li", {}, h("span", { class: "dot", style: { "--c": colorOf(a.id) } }), h("b", {}, t.awards[k]), h("span", {}, a.name))] : [];
      }),
    );
    again.hidden = !isVip();
    set.update();
  };
}

// ---------------------------------------------------------------------------
// A board

/** @typedef {[number, number]} Cell */
/** @typedef {{ id: string, cells: Cell[] }} Held */

const PAD = 0.3;
/** Where a dragged piece floats: this far above the finger, px. */
const LIFT = 34;

function play() {
  const svg = /** @type {SVGSVGElement} */ (/** @type {unknown} */ (s("svg", { class: "board" })));
  const layers = { cushion: s("g"), placed: s("g"), ghost: s("g", { class: "ghost" }), solution: s("g", { class: "solution" }), pings: s("g"), cursors: s("g") };
  svg.append(layers.cushion, layers.placed, layers.solution, layers.ghost, layers.pings, layers.cursors);
  const boardBox = h("div", { class: "boardbox" }, svg);
  const time = h("b", { class: "time" });
  const bar = h("div", { class: "tbar" }, h("i"));
  const shapeNo = h("span", { class: "shapeno" });
  const doneNo = h("span", { class: "doneno" });
  const hud = h("div", { class: "hud" }, shapeNo, h("div", { class: "clock" }, bar, time), doneNo);
  const answer = h("p", { class: "answer" });
  const tray = h("div", { class: "tray" });
  const checkBtn = /** @type {HTMLButtonElement} */ (h("button", { type: "button", class: "check" }));
  const trayTitle = h("div", { class: "trayhead" }, h("h2", { class: "traytitle" }, t.yourPieces), checkBtn);
  const overlay = h("div", { class: "overlay" });
  const wrap = h("div", { class: "play" }, hud, boardBox, answer, trayTitle, tray, overlay);
  show(wrap);

  // Local state: the orientation of each piece in hand, what was dropped and waits for the host, lifts on their way.
  /** @type {Map<string, Cell[]>} */
  const orient = new Map();
  /** @type {Map<string, { cells: Cell[], until: number }>} */
  const pending = new Map();
  /** @type {Map<string, number>} */
  const lifting = new Map();
  /** @type {Map<string, { g: SVGGElement, ping: number, x: number, y: number, on: boolean, t: number }>} */
  const cursors = new Map();
  let unit = 40;
  let shapeKey = "";
  /** @type {{ w: number, h: number, rows: string[] }} */
  let shape = { w: 1, h: 1, rows: ["#"] };
  let total = 0;
  let phase = "";
  let gotKey = 0;
  let pings = 0;
  let solutionShown = false;
  let checking = false;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let solutionTimer;
  cleanups.push(() => clearTimeout(solutionTimer));

  const room = () => client.view?.room ?? {};
  const me = () => client.view?.me ?? {};
  const myId = () => client.you?.id ?? "";

  /** The pieces on the board as this phone sees them: the room's, its own drops waiting for the host, minus its lifts. */
  const placedNow = () => {
    /** @type {{ id: string, owner: string, cells: Cell[], pending?: boolean }[]} */
    const list = (room().placed ?? []).filter((/** @type {any} */ p) => !lifting.has(p.id) && !pending.has(p.id));
    for (const [id, p] of pending) list.push({ id, owner: myId(), cells: p.cells, pending: true });
    return list;
  };
  /** @returns {Held[]} */
  const handNow = () => {
    /** @type {Held[]} */
    const hand = (me().hand ?? []).filter((/** @type {Held} */ p) => !pending.has(p.id));
    for (const id of lifting.keys()) {
      const p = (room().placed ?? []).find((/** @type {any} */ q) => q.id === id);
      if (p && !hand.some((x) => x.id === id)) hand.push({ id, cells: /** @type {Cell[]} */ (normalize(p.cells)) });
    }
    return hand;
  };
  const occupied = (/** @type {string | null} */ except) => {
    const set = new Set();
    for (const p of placedNow()) if (p.id !== except) for (const [x, y] of p.cells) set.add(`${x},${y}`);
    return set;
  };
  const onBoard = (/** @type {number} */ x, /** @type {number} */ y) => y >= 0 && y < shape.h && x >= 0 && x < shape.w && shape.rows[y]?.[x] === "#";
  const freeCells = () => {
    const occ = occupied(null);
    /** @type {Cell[]} */
    const out = [];
    shape.rows.forEach((r, y) => [...r].forEach((c, x) => c === "#" && !occ.has(`${x},${y}`) && out.push([x, y])));
    return out;
  };

  /** Sizes the board to the room there is: the width, and what the hand below leaves of the height. */
  const layout = () => {
    const w = boardBox.clientWidth || 320;
    const avail = Math.max(150, window.innerHeight * (window.innerHeight < 700 ? 0.42 : 0.5));
    unit = Math.max(14, Math.min(w / (shape.w + 2 * PAD), avail / (shape.h + 2 * PAD), 64));
    svg.setAttribute("viewBox", `${-PAD} ${-PAD} ${shape.w + 2 * PAD} ${shape.h + 2 * PAD}`);
    svg.setAttribute("width", String(Math.round(unit * (shape.w + 2 * PAD))));
    svg.setAttribute("height", String(Math.round(unit * (shape.h + 2 * PAD))));
  };
  const onResize = () => layout();
  addEventListener("resize", onResize);
  cleanups.push(() => removeEventListener("resize", onResize));

  /** Screen point → board cells (fractional). @param {number} cx @param {number} cy */
  const toBoard = (cx, cy) => {
    const r = svg.getBoundingClientRect();
    return [(cx - r.left) / unit - PAD, (cy - r.top) / unit - PAD];
  };

  // --- Drawing ------------------------------------------------------------------------------

  /** @type {Map<string, { g: SVGGElement, key: string }>} */
  const drawn = new Map();
  const moodOf = () => (phase === "solved" ? "happy" : phase === "over" ? "sleepy" : "calm");
  const drawPlaced = () => {
    const list = placedNow();
    const seen = new Set();
    for (const p of list) {
      seen.add(p.id);
      const k = `${JSON.stringify(p.cells)}|${p.owner}|${moodOf()}|${p.pending ? 1 : 0}`;
      const had = drawn.get(p.id);
      if (had?.key === k) continue;
      const g = piece(p.cells, colorOf(p.owner), { key: p.id, mood: /** @type {any} */ (moodOf()) });
      g.dataset["id"] = p.id;
      if (p.owner === myId()) g.classList.add("mine");
      if (p.pending) g.classList.add("pending");
      if (!had || had.key.split("|")[0] !== k.split("|")[0]) g.classList.add("drop");
      if (had) had.g.replaceWith(g);
      else layers.placed.append(g);
      drawn.set(p.id, { g, key: k });
    }
    for (const [id, x] of drawn) {
      if (seen.has(id)) continue;
      drawn.delete(id);
      x.g.remove();
    }
  };

  /** @type {Map<string, HTMLElement>} */
  const slots = new Map();
  const drawTray = () => {
    const hand = handNow();
    for (const p of hand) if (!orient.has(p.id)) orient.set(p.id, /** @type {Cell[]} */ (normalize(p.cells)));
    const free = freeCells();
    const help = room().level !== "hard";
    const kids = hand.map((p) => {
      const cells = orient.get(p.id) ?? p.cells;
      const k = JSON.stringify(cells);
      let slot = slots.get(p.id);
      if (!slot || slot.dataset["k"] !== k) {
        const fresh = slotFor(p.id, cells);
        if (slot) slot.replaceWith(fresh);
        slot = fresh;
        slots.set(p.id, slot);
      }
      slot.classList.toggle("nofit", help && !fitsAnywhere(free, cells));
      return slot;
    });
    for (const [id, el] of slots) if (!hand.some((p) => p.id === id)) (slots.delete(id), el.remove());
    // Re-appending a slot would end a drag that started on it (pointer capture): only when the hand changed.
    const same = kids.length === tray.children.length && kids.every((k, i) => tray.children[i] === k);
    if (kids.length === 0) {
      if (!tray.querySelector(".empty")) tray.replaceChildren(h("p", { class: "empty" }, t.noPieces));
    } else if (!same) tray.replaceChildren(...kids);
  };

  /** A slot of the hand: the piece (tap: turn; drag: onto the board) and its flip button. @param {string} id @param {Cell[]} cells */
  const slotFor = (id, cells) => {
    const w = Math.max(...cells.map((c) => c[0])) + 1;
    const hh = Math.max(...cells.map((c) => c[1])) + 1;
    const pic = s("svg", { viewBox: `-0.12 -0.12 ${w + 0.24} ${hh + 0.24}`, class: "slotpic" });
    const u = Math.min(56 / Math.max(w, hh, 3), 20);
    pic.setAttribute("width", String(Math.round(u * (w + 0.24))));
    pic.setAttribute("height", String(Math.round(u * (hh + 0.24))));
    pic.append(piece(cells, colorOf(myId()), { key: id }));
    const grab = h("div", { class: "grab" }, pic, h("small", { class: "nf" }, t.nofit));
    const flipBtn = h("button", { type: "button", class: "flip", "aria-label": t.flip }, "⇋");
    const slot = h("div", { class: "slot" }, grab, flipBtn);
    slot.dataset["k"] = JSON.stringify(cells);
    slot.dataset["id"] = id;
    flipBtn.addEventListener("click", () => {
      orient.set(id, /** @type {Cell[]} */ (flip(orient.get(id) ?? cells)));
      buzz(8);
      drawTray();
    });
    grab.addEventListener("pointerdown", (e) => startDrag(e, id, orient.get(id) ?? cells, null, grab));
    return slot;
  };

  // --- Dragging -----------------------------------------------------------------------------

  const floater = /** @type {SVGSVGElement} */ (/** @type {unknown} */ (s("svg", { class: "floater" })));
  document.body.append(floater);
  cleanups.push(() => floater.remove());

  /** @type {{ id: string, cells: Cell[], from: Cell[] | null, x0: number, y0: number, moved: boolean, start: number, el: Element, pointer: number, at: Cell[] | null } | null} */
  let drag = null;

  /**
   * @param {PointerEvent} e @param {string} id @param {Cell[]} cells the piece's shape as it would land
   * @param {Cell[] | null} from where it lies now (moving a placed piece) @param {Element} el
   */
  const startDrag = (e, id, cells, from, el) => {
    if (phase !== "board" || drag) return;
    e.preventDefault();
    try {
      el.setPointerCapture(e.pointerId);
    } catch {}
    drag = { id, cells: /** @type {Cell[]} */ (normalize(cells)), from, x0: e.clientX, y0: e.clientY, moved: false, start: performance.now(), el, pointer: e.pointerId, at: null };
  };

  /** Where a dragged piece would land: its cells snapped under the floater, and whether that works. */
  const landing = (/** @type {number} */ cx, /** @type {number} */ cy) => {
    if (!drag) return { cells: null, ok: false };
    const w = Math.max(...drag.cells.map((c) => c[0])) + 1;
    const hh = Math.max(...drag.cells.map((c) => c[1])) + 1;
    const left = cx - (w * unit) / 2;
    const top = cy - LIFT - hh * unit;
    const [bx, by] = toBoard(left, top);
    const ox = Math.round(bx);
    const oy = Math.round(by);
    /** @type {Cell[]} */
    const cells = drag.cells.map(([x, y]) => [x + ox, y + oy]);
    const occ = occupied(drag.id);
    const ok = cells.every(([x, y]) => onBoard(x, y) && !occ.has(`${x},${y}`));
    return { cells, ok, left, top, w, h: hh };
  };

  const moveDrag = (/** @type {PointerEvent} */ e) => {
    if (!drag || e.pointerId !== drag.pointer) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 8) return;
    if (!drag.moved) {
      drag.moved = true;
      floater.replaceChildren(piece(drag.cells, colorOf(myId()), { key: drag.id, mood: "happy" }));
      floater.classList.add("on");
      if (drag.from) drawn.get(drag.id)?.g.classList.add("lifted");
      else slots.get(drag.id)?.classList.add("away");
      buzz(6);
    }
    const l = landing(e.clientX, e.clientY);
    const w = l.w ?? 1;
    const hh = l.h ?? 1;
    floater.setAttribute("viewBox", `-0.1 -0.1 ${w + 0.2} ${hh + 0.2}`);
    floater.style.width = `${(w + 0.2) * unit}px`;
    floater.style.height = `${(hh + 0.2) * unit}px`;
    floater.style.transform = `translate(${(l.left ?? 0) - 0.1 * unit}px, ${(l.top ?? 0) - 0.1 * unit}px)`;
    drag.at = l.ok ? l.cells : null;
    layers.ghost.replaceChildren();
    if (l.cells && l.cells.some(([x, y]) => onBoard(x, y))) {
      const g = piece(l.cells, l.ok ? colorOf(myId()) : "#bbbbbb", { face: false });
      g.classList.toggle("bad", !l.ok);
      layers.ghost.append(g);
    }
    const [fx, fy] = toBoard(e.clientX, e.clientY);
    point(fx, fy, true);
  };

  const endDrag = (/** @type {PointerEvent} */ e) => {
    if (!drag || e.pointerId !== drag.pointer) return;
    const d = drag;
    drag = null;
    floater.classList.remove("on");
    layers.ghost.replaceChildren();
    drawn.get(d.id)?.g.classList.remove("lifted");
    slots.get(d.id)?.classList.remove("away");
    pointOff();
    if (!d.moved) {
      // A tap: on the hand turns the piece; on the board takes it back.
      if (d.from) lift(d.id);
      else {
        orient.set(d.id, /** @type {Cell[]} */ (turn(orient.get(d.id) ?? d.cells)));
        buzz(8);
        drawTray();
      }
      return;
    }
    if (d.at) place(d.id, d.at, d.from !== null);
    else if (d.from) {
      // Dropped off the board while moving: back where it was.
      buzz([20, 40, 20]);
    }
  };
  addEventListener("pointermove", moveDrag);
  addEventListener("pointerup", endDrag);
  addEventListener("pointercancel", endDrag);
  cleanups.push(() => {
    removeEventListener("pointermove", moveDrag);
    removeEventListener("pointerup", endDrag);
    removeEventListener("pointercancel", endDrag);
  });

  /** @param {string} id @param {Cell[]} cells @param {boolean} moving */
  const place = (id, cells, moving) => {
    const board = room().board;
    pending.set(id, { cells, until: Date.now() + 4000 });
    buzz(12);
    redraw();
    client.act("place", { board, piece: id, cells }).then(
      (r) => {
        const res = /** @type {any} */ (r);
        if (res && res.ok === false) {
          pending.delete(id);
          refusal(res.reason, res.by);
          redraw();
          return;
        }
        if (moving && room().level === "hard") toast(t.costs, "bad");
        // Kept until the room shows it (the reply may come before the view).
        const p = pending.get(id);
        if (p) p.until = Date.now() + 1500;
        settle();
      },
      (e) => {
        pending.delete(id);
        toast(message(e), "bad");
        redraw();
      },
    );
  };

  /** @param {string} id */
  const lift = (id) => {
    const board = room().board;
    lifting.set(id, Date.now() + 4000);
    buzz(8);
    redraw();
    client.act("lift", { board, piece: id }).then(
      (r) => {
        const res = /** @type {any} */ (r);
        if (res && res.ok === false) refusal(res.reason, res.by);
        else if (room().level === "hard") toast(t.costs, "bad");
        lifting.set(id, Date.now() + 1500);
        settle();
      },
      (e) => {
        lifting.delete(id);
        toast(message(e), "bad");
        redraw();
      },
    );
  };

  /** @param {string} reason @param {string} [by] */
  const refusal = (reason, by) => {
    buzz([30, 50, 30]);
    if (reason === "taken") toast(by && by !== myId() ? t.quicker(nameOf(by)) : t.quickerYou, "bad");
    else if (reason === "time") toast(t.timeUp, "bad");
    else toast(t.noFit, "bad");
    wrap.classList.remove("shake");
    void wrap.offsetWidth;
    wrap.classList.add("shake");
  };

  /** Drops and lifts the room has caught up with (or that waited too long) are forgotten. */
  const settle = () => {
    const placed = room().placed ?? [];
    const hand = me().hand ?? [];
    const now = Date.now();
    for (const [id, p] of pending) {
      const there = placed.find((/** @type {any} */ q) => q.id === id);
      if ((there && JSON.stringify(there.cells) === JSON.stringify(p.cells)) || now > p.until) pending.delete(id);
    }
    for (const [id, until] of lifting) {
      if (!placed.some((/** @type {any} */ q) => q.id === id) && hand.some((/** @type {any} */ q) => q.id === id)) lifting.delete(id);
      else if (now > until) lifting.delete(id);
    }
    redraw();
  };

  // --- Checking: can it still work out? -----------------------------------------------------

  checkBtn.addEventListener("click", () => {
    if (phase !== "board" || checking) return;
    if (room().checks === 0) {
      toast(room().level === "hard" ? t.noChecksHard : t.noChecks, "info");
      return;
    }
    checking = true;
    drawCheck();
    client.act("check", { board: room().board }).then(
      (r) => {
        const res = /** @type {any} */ (r);
        if (res?.ok === false) toast(res.reason === "time" ? t.timeUp : room().level === "hard" ? t.noChecksHard : t.noChecks, "info");
        else if (res?.result === "unsure") toast(t.unsure, "info");
        else buzz(res?.result === "stuck" ? [30, 50, 30] : 15);
      },
      (e) => toast(message(e), "bad"),
    ).finally(() => {
      checking = false;
      drawCheck();
    });
  });

  /** The check button (what is left of the team's checks) and the last answer, while the board is as it was. */
  const drawCheck = () => {
    const n = room().checks;
    checkBtn.textContent = n === null || n === undefined ? t.check : t.checkN(n);
    checkBtn.classList.toggle("out", n === 0);
    checkBtn.disabled = checking || phase !== "board";
    const c = room().check;
    answer.className = `answer${c && phase === "board" ? ` show ${c.result}` : ""}`;
    answer.textContent = c ? (c.result === "stuck" ? t.stuck(nameOf(c.by), c.by === myId()) : t.open(nameOf(c.by), c.by === myId())) : "";
  };

  // --- Pointing -----------------------------------------------------------------------------

  let pointing = /** @type {{ pointer: number, x0: number, y0: number, start: number } | null} */ (null);
  /** @param {number} x @param {number} y @param {boolean} on */
  const point = (x, y, on) => client.input({ x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100, on, ping: pings });
  let lastPoint = [0, 0];
  const pointOff = () => point(lastPoint[0] ?? 0, lastPoint[1] ?? 0, false);

  svg.addEventListener("pointerdown", (e) => {
    if (phase !== "board" || drag || pointing) return;
    const [bx, by] = toBoard(e.clientX, e.clientY);
    const cx = Math.floor(bx);
    const cy = Math.floor(by);
    const mine = placedNow().find((p) => p.owner === myId() && !p.pending && p.cells.some(([x, y]) => x === cx && y === cy));
    if (mine) {
      startDrag(e, mine.id, mine.cells, mine.cells, svg);
      return;
    }
    e.preventDefault();
    try {
      svg.setPointerCapture(e.pointerId);
    } catch {}
    pointing = { pointer: e.pointerId, x0: e.clientX, y0: e.clientY, start: performance.now() };
    lastPoint = [bx, by];
    point(bx, by, true);
  });
  svg.addEventListener("pointermove", (e) => {
    if (!pointing || e.pointerId !== pointing.pointer) return;
    const [bx, by] = toBoard(e.clientX, e.clientY);
    lastPoint = [bx, by];
    point(bx, by, true);
  });
  const endPoint = (/** @type {PointerEvent} */ e) => {
    if (!pointing || e.pointerId !== pointing.pointer) return;
    const quick = performance.now() - pointing.start < 350 && Math.hypot(e.clientX - pointing.x0, e.clientY - pointing.y0) < 12;
    pointing = null;
    if (quick) {
      pings++;
      ring(lastPoint[0] ?? 0, lastPoint[1] ?? 0, colorOf(myId()));
      buzz(10);
    }
    pointOff();
  };
  svg.addEventListener("pointerup", endPoint);
  svg.addEventListener("pointercancel", endPoint);

  /** @param {number} x @param {number} y @param {string} color */
  const ring = (x, y, color) => {
    for (let i = 0; i < 2; i++) {
      const c = s("circle", { cx: x, cy: y, r: 0.2, class: "pingring", stroke: color, style: `animation-delay:${i * 150}ms` });
      layers.pings.append(c);
      setTimeout(() => c.remove(), 1300);
    }
  };

  // --- The view ----------------------------------------------------------------------------

  const redraw = () => {
    drawPlaced();
    drawTray();
  };

  const showSolution = () => {
    if (solutionShown) return;
    solutionShown = true;
    layers.placed.classList.add("fade");
    layers.solution.replaceChildren(...(room().solution ?? []).map((/** @type {any} */ p, /** @type {number} */ i) => piece(p.cells, colorOf(p.owner), { key: `s${i}` })));
    overlay.replaceChildren(h("div", { class: "msg small" }, h("b", {}, t.couldHave)));
  };

  refresh = (view) => {
    const r = view.room ?? {};
    const m = view.me ?? {};
    const sk = JSON.stringify(r.shape ?? null);
    if (sk !== shapeKey && r.shape) {
      shapeKey = sk;
      shape = r.shape;
      layers.cushion.replaceChildren(cushion(shape));
      layout();
    }
    if (r.phase !== phase) {
      phase = r.phase;
      document.body.dataset["phase"] = phase;
      if (phase === "board" && r.deadline) total = Math.max(1000, r.deadline - client.now());
      if (phase === "solved") {
        overlay.replaceChildren(h("div", { class: "msg" }, h("b", {}, t.snug), r.bonus ? h("span", {}, t.back(Math.round(r.bonus / 1000))) : null, r.earned ? h("span", {}, t.earned) : null));
        buzz([30, 60, 30, 60, 80]);
      }
      if (phase === "over") {
        overlay.replaceChildren(h("div", { class: "msg over" }, h("b", {}, t.timesUp)));
        buzz(200);
        solutionTimer = setTimeout(showSolution, 2600);
      }
      for (const x of drawn.values()) x.key = "";
    }
    shapeNo.textContent = t.shapeN(r.board ?? 1);
    doneNo.textContent = t.doneN(r.solved ?? 0);
    drawCheck();
    trayTitle.hidden = phase !== "board";
    tray.hidden = phase !== "board";
    if (m.got && m.got.key !== gotKey) {
      gotKey = m.got.key;
      toast(t.got(m.got.from, m.got.n), "info");
      buzz([20, 40, 20]);
    }
    // Others' cursors and their pings.
    const cs = r.cursors ?? {};
    for (const [id, c] of Object.entries(cs)) {
      if (id === myId()) continue;
      let cur = cursors.get(id);
      if (!cur) {
        const g = /** @type {SVGGElement} */ (pointer(colorOf(id), initial(nameOf(id))));
        layers.cursors.append(g);
        cur = { g, ping: c.ping ?? 0, x: c.x, y: c.y, on: c.on, t: c.t };
        cursors.set(id, cur);
      }
      if ((c.ping ?? 0) > cur.ping) ring(c.x, c.y, colorOf(id));
      Object.assign(cur, { ping: c.ping ?? 0, x: c.x, y: c.y, on: c.on, t: c.t });
    }
    for (const [id, cur] of cursors) if (!cs[id]) (cur.g.remove(), cursors.delete(id));
    settle();
  };

  // The clock and the cursors' fading, every frame.
  let raf = 0;
  const tick = () => {
    const r = room();
    const now = client.now();
    const ms = phase === "board" && r.deadline ? r.deadline - now : (r.left ?? 0);
    const secs = Math.max(0, Math.ceil(ms / 1000));
    time.textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
    const f = Math.max(0, Math.min(1, ms / Math.max(1, total, r.left ?? 0)));
    /** @type {HTMLElement} */ (bar.firstChild).style.transform = `scaleX(${f})`;
    hud.classList.toggle("low", phase === "board" && ms < 15_000);
    for (const cur of cursors.values()) {
      const age = now - cur.t;
      const op = phase !== "board" ? 0 : cur.on ? 1 : Math.max(0, 1 - Math.max(0, age) / 3000);
      cur.g.style.transform = `translate(${cur.x}px, ${cur.y}px)`;
      cur.g.setAttribute("opacity", op.toFixed(2));
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  cleanups.push(() => cancelAnimationFrame(raf));
  requestAnimationFrame(() => layout());
}

watchFit();

/** Keeps the screen on while playing. */
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
