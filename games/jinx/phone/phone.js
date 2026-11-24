// @ts-check
/**
 * Jinx's phone page. It shows `view.room` (RoomView: the phase and the
 * people) and `view.me` (PlayerState: this phone's task) and sends the
 * actions of game/views.ts; the guesser's draft goes as `input({ draft })`.
 * The look is the TV's table: felt, cream paper, tomato card backs, chips.
 * Everything players typed is shown as text (`textContent`), never as markup.
 * It speaks the room's language (`room.lang`, the host page's or the
 * VIP's setting), or the one the player picked with the header's switch
 * (joining, the lobby, the end);
 * `strings.js` has the texts. Jinx is a team game: the room shares one
 * bank of chips, so the phone shows the room's bank and what this phone's
 * cards did for it, never personal points or ranks.
 *
 * @typedef {import("../game/views.ts").RoomView} RoomView
 * @typedef {import("../game/views.ts").PlayerState} PlayerState
 * @typedef {import("../game/views.ts").Person} Person
 * @typedef {import("../game/views.ts").Card} Card
 * @typedef {import("../game/views.ts").Face} Face
 * @typedef {import("../game/views.ts").Reason} Reason
 * @typedef {import("../game/views.ts").Award} Award
 * @typedef {import("../game/views.ts").RoomTitle} RoomTitle
 * @typedef {import("../game/views.ts").Settings} Settings
 */
/**
 * @template {PlayerState["task"]} T
 * @typedef {Extract<PlayerState, { task: T }>} Task
 */
/**
 * What is on screen: the scrolling part, the part docked at the bottom
 * (fields stay right above the on-screen keyboard), and what to update on
 * every view while the screen stays.
 * @typedef {{ main: (Node | null)[], dock?: (Node | null)[], refresh?: (me: PlayerState, room: RoomView) => void, tone?: string }} Screen
 */

import { blockEmoji, PartyClient } from "/_tvpipe/lib/client.js";
import { COLORS, FLAME, faceSvg, PRESETS } from "./faces.js";
import { browserLang, LANGS, pickLang } from "./i18n.js";
import { Pad } from "./pad.js";
import { strings } from "./strings.js";

/** The longest clue and guess (the matcher's limit). */
const MAX_WORD = 24;
const NAME_KEY = "jinx:name";

// ---------------------------------------------------------------------------
// A game controller, not a document: no pinch or double-tap zoom, no text
// selection outside the fields (iOS ignores `user-scalable=no`).

for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
  document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
}
document.addEventListener(
  "touchmove",
  (e) => {
    if (e.touches.length > 1) e.preventDefault();
  },
  { passive: false },
);
document.addEventListener("dblclick", (e) => e.preventDefault(), { passive: false });
document.addEventListener("selectstart", (e) => {
  const t = e.target instanceof Element ? e.target : /** @type {Node} */ (e.target).parentElement;
  if (!t?.closest("input, textarea")) e.preventDefault();
});

// ---------------------------------------------------------------------------
// DOM helpers: text always as text.

/** @typedef {Node | string | number | null | undefined | false} Kid */

/**
 * @param {string} tag
 * @param {Record<string, any>} [attrs]
 * @param {...Kid} kids
 * @returns {HTMLElement}
 */
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "style") el.style.cssText = v;
    else if (v === true) el.setAttribute(k, "");
    else if (v !== false && v != null) el.setAttribute(k, String(v));
  }
  for (const kid of kids) if (kid !== null && kid !== undefined && kid !== false) el.append(typeof kid === "number" ? String(kid) : kid);
  return el;
}

/**
 * A button (type=button).
 * @param {string} cls
 * @param {() => void} onclick
 * @param {...Kid} kids
 */
function btn(cls, onclick, ...kids) {
  return /** @type {HTMLButtonElement} */ (h("button", { type: "button", class: cls, onclick }, ...kids));
}

/** @param {string} markup constant markup of this file only */
function icon(markup) {
  const s = h("span", { class: "icon" });
  s.innerHTML = markup;
  return s;
}

/** @param {number[]} pattern */
function buzz(pattern) {
  try {
    // Only after a tap on the page (browsers refuse it before, with a warning).
    if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
    navigator.vibrate?.(pattern);
  } catch {}
}

// ---------------------------------------------------------------------------
// The shell

const app = h("div", { id: "app" });
const header = h("header", { id: "top" });
/** The wooden letter tiles. @param {boolean} [large] */
function logo(large = false) {
  return h("div", { class: `tiles${large ? " big" : ""}`, role: "img", "aria-label": "JINX" }, ...["J", "I", "N", "X"].map((l, i) => h("b", { style: `--r:${[-4, 3, -2, 5][i]}deg` }, l, h("sub", {}, [8, 1, 1, 8][i]))));
}
const tiles = logo();
const timer = h("div", { id: "timer", class: "dial", hidden: true, "aria-live": "off" });
const meBox = h("div", { id: "me" });
const langButton = /** @type {HTMLButtonElement} */ (h("button", { type: "button", id: "lang", hidden: true }));
header.append(tiles, timer, langButton, meBox);
const banner = h("div", { id: "banner", role: "status", hidden: true });
const main = h("main", { id: "main" });
const dock = h("footer", { id: "dock" });
app.append(header, banner, main, dock);
document.body.replaceChildren(app);

// The on-screen keyboard: the app is as tall as the visual viewport, so the
// docked fields sit right above the keyboard and the rest scrolls.
const root = document.documentElement;
function fitViewport() {
  const vv = window.visualViewport;
  const height = vv ? vv.height : window.innerHeight;
  root.style.setProperty("--vvh", `${Math.round(height)}px`);
  app.style.transform = vv && vv.offsetTop > 0 ? `translateY(${Math.round(vv.offsetTop)}px)` : "";
  root.classList.toggle("short", height < 560);
}
window.visualViewport?.addEventListener("resize", fitViewport);
window.visualViewport?.addEventListener("scroll", fitViewport);
window.addEventListener("resize", fitViewport);
fitViewport();
// A focused field scrolls its screen part into view once the keyboard is up.
document.addEventListener("focusin", (e) => {
  const t = e.target;
  if (t instanceof HTMLInputElement) setTimeout(() => t.scrollIntoView({ block: "nearest" }), 300);
});

const client = PartyClient.fromLocation();
// No emoji in names, answers or clues (the host drops them too).
blockEmoji();

// ---------------------------------------------------------------------------
// The language: the phone's own choice, else the room's, else the browser's.

const LANG_KEY = "jinx:lang";
/** @returns {import("./i18n.js").Lang | null} */
function ownLang() {
  try {
    const v = localStorage.getItem(LANG_KEY);
    return v ? pickLang(v) : null;
  } catch {
    return null;
  }
}
/** @returns {import("./i18n.js").Lang} */
function roomLang() {
  const l = client.view?.room?.lang;
  return typeof l === "string" ? pickLang(l) : browserLang();
}
let lang = ownLang() ?? roomLang();
let t = strings(lang);
document.documentElement.lang = lang;

/** Follows the language; true when it changed (the screen has to be built again). */
function useLang() {
  const l = ownLang() ?? roomLang();
  if (l === lang) return false;
  lang = l;
  t = strings(l);
  document.documentElement.lang = l;
  return true;
}

/** The switch: only where rebuilding loses nothing (joining, the lobby, the end). */
function showSwitch(on = false) {
  langButton.hidden = !on;
  langButton.textContent = t.otherLang;
  langButton.lang = lang === "de" ? "en" : "de";
}
langButton.addEventListener("click", () => {
  const next = lang === "de" ? "en" : "de";
  try {
    // Back to the room's language: follow the room again.
    if (next === roomLang()) localStorage.removeItem(LANG_KEY);
    else localStorage.setItem(LANG_KEY, next);
  } catch {}
  if (!useLang()) return;
  if (shown === "join") {
    const typed = /** @type {HTMLInputElement | null} */ (document.getElementById("name"))?.value;
    joinForm("", typed);
  } else if (meView()) {
    shown = "";
    render();
  } else {
    // Before joining (no room, or a resumed phone connecting): the plain screen again.
    plain(shown, logo(true), big(shown === "no-room" ? t.scanToJoin : t.connecting));
    showSwitch(true);
  }
});

// ---------------------------------------------------------------------------
// The view

/** @returns {RoomView} */
function roomView() {
  const r = client.view?.room;
  return r && typeof r === "object" && Array.isArray(r.people) ? r : { phase: "lobby", lang: browserLang(), langs: [], settings: { rounds: "auto", write: 45, difficulty: "normal", late: "wait" }, people: [], minPlayers: 3, maxPlayers: 8 };
}

/** @returns {PlayerState | null} */
function meView() {
  const m = client.view?.me;
  return m && typeof m === "object" && typeof m.task === "string" ? m : null;
}

/** @param {string | undefined} id */
function person(id) {
  return roomView().people.find((p) => p.id === id);
}

function myself() {
  return person(client.you?.id);
}

/** @param {string | undefined} id */
function nameOf(id) {
  return person(id)?.name ?? t.someone;
}

/** @param {number} n */
function signed(n) {
  const a = new Intl.NumberFormat(lang).format(Math.abs(n));
  return n > 0 ? `+${a}` : n < 0 ? `−${a}` : "0";
}

// ---------------------------------------------------------------------------
// Pieces: chips, cards, stamps

/**
 * A poker-chip avatar.
 * @param {Person | undefined} p
 * @param {number} size px
 * @param {{ crown?: boolean, blindfold?: boolean, face?: Face, color?: number }} [o]
 */
function chip(p, size, o = {}) {
  const color = COLORS[o.color ?? p?.color ?? 0] ?? COLORS[0];
  const el = h("span", { class: `chip${p?.bot ? " bot" : ""}${p && !p.connected ? " away" : ""}`, style: `--s:${size}px;--c:${color}` });
  el.append(faceSvg(o.face ?? p?.face));
  if (o.crown) el.append(h("i", { class: "crown" }));
  if (o.blindfold) el.append(h("i", { class: "blindfold" }));
  return el;
}

function flame() {
  return h("span", { class: "flame" }, icon(FLAME));
}

/**
 * A clue card: the back (tomato, or ink with a flame when bold) until it is
 * turned, then the cream face with the word.
 * @param {Card} c
 * @param {{ tag?: string, onclick?: () => void, label?: string, words?: boolean, extra?: string }} [o]
 */
function cardEl(c, o = {}) {
  const author = person(c.author);
  const up = typeof c.word === "string" && (o.words !== false || c.turned);
  const el = h(o.tag ?? "div", {
    class: `card${up ? " up" : " down"}${c.bold ? " bold" : ""}${c.turned ? " turned" : ""}${o.extra ? ` ${o.extra}` : ""}`,
    type: o.tag === "button" ? "button" : null,
    "aria-label": o.label ?? null,
    onclick: o.onclick ?? null,
  });
  const face = h("span", { class: "paper" });
  if (up) face.append(h("span", { class: "word" }, c.word ?? ""));
  else face.append(h("span", { class: "emblem" }, h("span", {}, "J")));
  el.append(face, chip(author, 34), h("span", { class: "who" }, author?.name ?? "?"));
  if (c.bold) el.append(flame());
  if (c.turned) el.append(h("span", { class: "order" }, c.turned));
  return el;
}

/**
 * Fits words into their card, so that every word can be read whole: no
 * ellipsis, ever (a clue cut off is a clue lost), and no letters hidden
 * behind the card's edge. On one line it gets smaller down to 60 %, then
 * condensed down to 62 % (long German compounds: "GEBURTSTAGSKUCHEN").
 * A word too long even for that goes on two lines of about the same
 * length, hyphenated, as large as it fits (the secret word's card is
 * wide: it only gets smaller). Runs after layout.
 * @param {ParentNode} [scope]
 */
function fitWords(scope = document) {
  requestAnimationFrame(() => {
    for (const el of scope.querySelectorAll(".card .word, .index .word")) {
      const w = /** @type {HTMLElement} */ (el);
      w.removeAttribute("style");
      const parent = w.parentElement;
      if (!parent) continue;
      const ps = getComputedStyle(parent);
      const own = getComputedStyle(w);
      const pad = parseFloat(own.paddingLeft) + parseFloat(own.paddingRight);
      const inner = parent.clientWidth - parseFloat(ps.paddingLeft) - parseFloat(ps.paddingRight);
      const room = inner - 12 - pad;
      if (room <= 0) continue;
      // the text's own width (a block's scrollWidth is at least the card's)
      const range = document.createRange();
      range.selectNodeContents(w);
      const text = () => range.getBoundingClientRect().width;
      const full = text();
      if (full <= room) continue;
      const size = parseFloat(own.fontSize);
      const index = !!w.closest(".index");
      // What one line can take: 60 % of the size, condensed to 62 %.
      if (!index && room / full < FIT_SIZE * FIT_SQUEEZE) {
        // Two lines, balanced ("FEUERWEHR-", "AUTO"), from nearly full size down until both fit;
        // over the author's chip and the flame, which a small card's first line reaches (nothing of it hidden).
        Object.assign(w.style, { whiteSpace: "normal", hyphens: "auto", overflowWrap: "anywhere", lineHeight: "1.08", maxWidth: `${room + pad}px`, zIndex: "3" });
        w.style.setProperty("-webkit-hyphens", "auto");
        w.style.setProperty("text-wrap", "balance");
        w.style.setProperty("hyphenate-limit-chars", "8 4 4");
        const twoLines = () => w.scrollWidth <= w.clientWidth + 1 && w.getBoundingClientRect().height <= parseFloat(getComputedStyle(w).lineHeight) * 2 + 2;
        let s = size * 0.9;
        w.style.fontSize = `${s}px`;
        while (s > size * 0.4 && !twoLines()) {
          s *= 0.94;
          w.style.fontSize = `${s}px`;
        }
        if (twoLines()) continue;
        // A browser that breaks no word: one line after all, as small as it takes.
        w.removeAttribute("style");
      }
      w.style.fontSize = `${size * Math.max(FIT_SIZE, room / full)}px`;
      let k = room / text();
      if (k >= 1) continue;
      if (k < FIT_SQUEEZE) {
        // Still too long when condensed: smaller yet, so nothing is cut off.
        w.style.fontSize = `${(parseFloat(w.style.fontSize) * k) / FIT_SQUEEZE}px`;
        k = Math.min(1, room / text());
      }
      const x = Math.max(FIT_SQUEEZE, k);
      if (index) {
        // the index card's word is a block as wide as the card: as wide as the text instead, centred, then condensed
        const wide = text() + pad;
        w.style.width = `${wide}px`;
        w.style.marginLeft = w.style.marginRight = `${(inner - wide) / 2}px`;
      } else w.style.maxWidth = `${(room + pad) / x}px`;
      w.style.transform = `scaleX(${x.toFixed(3)})`;
    }
  });
}
/** A word on one line: no smaller than this share of its size, no narrower than this. */
const FIT_SIZE = 0.6;
const FIT_SQUEEZE = 0.62;

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
document.fonts?.ready.then(() => fitWords());
document.fonts?.addEventListener("loadingdone", () => fitWords());
window.addEventListener("resize", () => fitWords());

/**
 * @param {string} text
 * @param {string} [tone] tomato, leaf, gold, ink
 */
function stamp(text, tone = "tomato") {
  return h("div", { class: `stamp ${tone}` }, text);
}

/** @param {string} text */
function tape(text) {
  return h("div", { class: "tape" }, text);
}

/**
 * The secret word on an index card.
 * @param {string} word
 * @param {string} [label]
 */
function indexCard(word, label = t.theWord) {
  const w = h("div", { class: "word" }, word);
  return h("div", { class: "index" }, h("div", { class: "label" }, label), w);
}

/** @param {number} pot */
function potEl(pot) {
  const stack = h("div", { class: "stack" });
  for (let i = 0; i < Math.min(pot, 12); i++) stack.append(h("i"));
  return h("div", { class: "pot" }, stack, h("div", { class: "label" }, h("small", {}, t.thePot), h("b", {}, pot)));
}

/** @param {...Kid} kids */
function note(...kids) {
  return h("p", { class: "note" }, ...kids);
}

/** @param {...Kid} kids */
function big(...kids) {
  return h("p", { class: "big" }, ...kids);
}

const ENVELOPE = `<svg viewBox="0 0 200 130" aria-hidden="true"><rect x="4" y="4" width="192" height="122" rx="10" fill="#d9b98a" stroke="#1d1a2b" stroke-width="6"/><path d="M6 10 L100 78 L194 10" fill="none" stroke="#1d1a2b" stroke-width="6" stroke-linejoin="round"/><circle cx="100" cy="76" r="24" fill="#df4a3c" stroke="#1d1a2b" stroke-width="5"/><text x="100" y="88" text-anchor="middle" font-size="32" font-weight="700" fill="#fbf1dc" font-family="Plex Sans, sans-serif">?</text></svg>`;

// ---------------------------------------------------------------------------
// Errors

/** Refusals of the clue action that are the game's, not the matcher's. */
const CLUE_GAME_CODES = new Set(["late", "not-asked", "bad-slot", "not-player", "refused"]);

/**
 * A refusal in this phone's language, by its code. A refused clue's
 * message is the matcher's own wording in the room's language: shown as it
 * is when this phone speaks the room's language, else said from the code
 * and its reason ("too-close:plural").
 * @param {any} e
 * @param {string} [action] the action refused (`clue`, `guess`, …)
 */
function message(e, action = "") {
  const code = typeof e?.code === "string" ? e.code : "";
  const [base = "", reason] = code.split(":");
  const said = typeof e?.message === "string" && e.message ? e.message : "";
  if (action === "clue" && !CLUE_GAME_CODES.has(base) && lang === roomLang() && said) return said;
  const r = /** @type {import("../game/views.ts").Reason | undefined} */ (reason && reason in t.reasons ? reason : undefined);
  if (base === "too-close") return t.tryAnother(t.tooClose[r ?? "too close"]);
  if (base === "own-clue") return t.ownClue(r && r !== "same word" ? t.reasons[r] : null);
  if (base === "empty") return action === "guess" ? t.typeGuess : t.typeClue;
  return t.errors[base] ?? (said || t.failed);
}

/**
 * Sends an action; a refusal lands in `err` (and is thrown on).
 * @param {string} type
 * @param {unknown} data
 * @param {HTMLElement | null} [err]
 */
async function act(type, data, err) {
  if (err) err.textContent = "";
  try {
    return await client.act(type, data);
  } catch (e) {
    if (err) err.textContent = message(e, type);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Rendering

/** The key of what is on screen: rebuilt only when it changes. */
let shown = "";
/** @type {Screen["refresh"] | null} */
let refresh = null;
/** Called by the clock shortly before the deadline (the write screen sends what is typed). */
/** @type {(() => void) | null} */
let lastCall = null;

/** @param {Screen} s */
function mount(s) {
  main.replaceChildren(...s.main.filter((n) => n !== null));
  dock.replaceChildren(...(s.dock ?? []).filter((n) => n !== null));
  dock.hidden = !s.dock?.length;
  app.dataset.tone = s.tone ?? "";
  main.scrollTop = 0;
  refresh = s.refresh ?? null;
  fitWords();
  lastCall = null;
}

/**
 * A plain screen outside the game (connecting, kicked, …).
 * @param {string} key
 * @param {...Kid} kids
 */
function plain(key, ...kids) {
  shown = key;
  mount({ main: [h("section", { class: "center" }, ...kids)] });
  outside = true;
  timer.hidden = true;
  showSwitch(false);
}

/** A screen outside the game is up (no clock). */
let outside = false;

function renderHeader() {
  const p = myself();
  meBox.replaceChildren();
  if (!p) return;
  meBox.append(h("span", { class: "name" }, p.name), chip(p, 36));
}

function render() {
  const me = meView();
  const room = roomView();
  if (useLang() && shown !== "join" && !shown.startsWith("bye:")) shown = "";
  renderHeader();
  if (!me) return;
  const key = screenKey(me, room);
  if (key !== shown) {
    shown = key;
    outside = false;
    showSwitch(me.task === "lobby" || me.task === "final");
    mount(build(me, room));
  }
  refresh?.(me, room);
  tick();
}

/**
 * @param {PlayerState} me
 * @param {RoomView} room
 */
function screenKey(me, room) {
  if (held(me, room)) return `hold:${me.task}:${room.phase}:${room.round ?? ""}`;
  return me.task === "lobby" || me.task === "wait" || me.task === "final" ? me.task : `${me.task}:${room.round ?? ""}`;
}

/**
 * A task the room has moved past: the host keeps the old task a while so a
 * phone never beats the TV (a giver's fate comes near the end of the jinx
 * check, the result a few seconds into the verdict). Until then: nothing
 * new, "watch the TV".
 * @param {PlayerState} me
 * @param {RoomView} room
 */
function held(me, room) {
  switch (me.task) {
    case "write":
    case "blind":
      return room.phase !== "write";
    case "guess":
    case "watch":
      return room.phase !== "reveal";
    default:
      return false;
  }
}

/**
 * @param {PlayerState} me
 * @param {RoomView} room
 * @returns {Screen}
 */
function hold(me, room) {
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  const jinx = room.phase === "jinx";
  const guesser = me.task === "blind" || me.task === "guess" || room.guesser === client.you?.id;
  return {
    tone: "spot",
    main: [
      h(
        "section",
        { class: "center" },
        jinx ? h("div", { class: "backs" }, ...[0, 1, 2].map(() => h("i", { class: "back" }, h("span", {}, "J")))) : h("div", { class: "envelope" }, icon(ENVELOPE)),
        h("h1", { class: "title" }, jinx ? t.jinxCheck : room.phase === "verdict" ? t.theVerdict : t.lookAtTv),
        big(t.watchTv),
        note(jinx ? (guesser ? t.whichMadeIt : t.sameClue) : t.hereComes),
      ),
    ],
  };
}

/**
 * @param {PlayerState} me
 * @param {RoomView} room
 * @returns {Screen}
 */
function build(me, room) {
  if (held(me, room)) return hold(me, room);
  switch (me.task) {
    case "tv":
      return hold(me, room);
    case "lobby":
      return lobby(me);
    case "wait":
      return waitLate();
    case "hotseat":
      return hotseat(me, room);
    case "write":
      return write(me, room);
    case "blind":
      return blind(me);
    case "check":
      return check(me);
    case "fate":
      return fate(me);
    case "guess":
      return guess(me);
    case "watch":
      return watch(me, room);
    case "result":
      return result(me, room);
    case "best":
      return best(me);
    case "bank":
      return bank(me, room);
    case "final":
      return final(me);
    default:
      return { main: [h("section", { class: "center" }, big(t.lookAtTvBang))] };
  }
}

// ---------------------------------------------------------------------------
// Joining

/**
 * @param {string} [error]
 * @param {string} [typed] the name typed so far (the language switched)
 */
function joinForm(error = "", typed) {
  shown = "join";
  let saved = "";
  try {
    saved = typed ?? client.saved?.name ?? localStorage.getItem(NAME_KEY) ?? "";
  } catch {}
  const input = /** @type {HTMLInputElement} */ (
    h("input", { id: "name", maxlength: 16, autocapitalize: "words", autocomplete: "nickname", enterkeyhint: "go", spellcheck: "false", placeholder: t.yourName, "aria-label": t.yourName })
  );
  input.value = saved;
  const err = h("p", { class: "line error", role: "alert" }, error);
  const go = /** @type {HTMLButtonElement} */ (h("button", { type: "submit", class: "primary" }, t.takeSeat));
  const form = h(
    "form",
    {
      class: "join",
      autocomplete: "off",
      onsubmit: async (/** @type {Event} */ e) => {
        e.preventDefault();
        const name = input.value.trim();
        if (!name) return input.focus();
        try {
          localStorage.setItem(NAME_KEY, name);
        } catch {}
        err.textContent = "";
        go.disabled = true;
        try {
          await client.join(name);
          wake();
        } catch (e) {
          go.disabled = false;
          err.textContent = message(e, "join");
          buzz([60, 40, 60]);
        }
      },
    },
    err,
    h("div", { class: "row" }, input, go),
  );
  mount({
    main: [h("section", { class: "center hello" }, logo(true), ...t.hello.map((line) => big(line)), note(t.helloNote))],
    dock: [form],
  });
  outside = true;
  timer.hidden = true;
  showSwitch(true);
}

// ---------------------------------------------------------------------------
// Lobby: draw your face; the VIP starts and removes players.

/**
 * The face pad: your chip, drawn on with one ink; Undo, Clear, Shuffle.
 * Every change goes to the host (the TV shows it at once).
 * @param {Face} face
 * @param {number} color
 * @param {HTMLElement} err
 */
function facePad(face, color, err) {
  const canvas = /** @type {HTMLCanvasElement} */ (h("canvas", { class: "pad", "aria-label": t.drawFace }));
  const preset = h("div", { class: "preset" });
  const ring = h("div", { class: "padchip", style: `--c:${COLORS[color] ?? COLORS[0]}` }, preset, canvas);
  const hint = h("p", { class: "line" });
  /** The preset the chip falls back to (clear, or before the first stroke). */
  let base = "preset" in face ? face.preset : 0;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let sendTimer = null;
  const showPreset = (/** @type {boolean} */ on) => {
    preset.replaceChildren(on ? faceSvg({ preset: base }) : "");
    preset.hidden = !on;
  };
  const sendFace = () => {
    if (sendTimer) clearTimeout(sendTimer);
    sendTimer = setTimeout(() => {
      sendTimer = null;
      const next = pad.strokes.length ? { strokes: pad.strokes.map((s) => s.slice()) } : { preset: base };
      act("face", next, err).catch(() => {});
    }, 500);
  };
  const pad = new Pad(canvas, {
    onStroke: () => {
      showPreset(false);
      hint.textContent = pad.full ? t.plentyInk : t.thatsYou;
      sendFace();
    },
    onFull: () => {
      hint.textContent = t.plentyInk;
      buzz([30]);
    },
  });
  // The pad starts blank over the preset; a doodle from before comes back.
  canvas.addEventListener("pointerdown", () => showPreset(false));
  if ("strokes" in face && face.strokes.length) {
    pad.load(face.strokes);
    showPreset(false);
    hint.textContent = t.thatsYou;
  } else {
    showPreset(true);
    hint.textContent = t.drawOver;
  }
  const tools = h(
    "div",
    { class: "tools" },
    btn("ghost", () => {
      pad.undo();
      if (!pad.strokes.length) showPreset(true);
      sendFace();
    }, t.undo),
    btn("ghost", () => {
      pad.clear();
      showPreset(true);
      sendFace();
    }, t.clear),
    btn("ghost", () => {
      base = (base + 1 + Math.floor(Math.random() * (PRESETS.length - 1))) % PRESETS.length;
      pad.clear();
      showPreset(true);
      hint.textContent = t.shuffled;
      sendFace();
    }, t.shuffle),
  );
  return { ring, tools, hint };
}

/**
 * The VIP's settings (the lobby and the end), all the host page offers:
 * the language (for the whole room; one without words greyed out),
 * rounds, writing time, words, latecomers. The current values come with
 * the room view.
 * @param {HTMLElement} err
 */
function settingsBox(err) {
  /** @type {{ key: keyof Settings | "lang", buttons: HTMLButtonElement[], values: any[] }[]} */
  const items = [];
  const roundsLine = h("p", { class: "line" });
  const lateLine = h("p", { class: "line" });
  const box = h("section", { class: "settings" }, h("h2", { class: "label" }, t.settings));
  /** @param {keyof Settings | "lang"} key @param {any[]} values @param {string[]} labels @param {string} title @param {HTMLElement | null} [line] */
  const add = (key, values, labels, title, line = null) => {
    const buttons = values.map((v, i) => btn("", () => void pick(key, v), labels[i] ?? String(v)));
    const head = h("h3", {}, title);
    box.append(h("div", { class: "setting" }, head, h("div", { class: "seg", role: "group", "aria-label": title }, ...buttons), line));
    items.push({ key, buttons, values });
  };
  /** @param {keyof Settings | "lang"} key @param {any} v */
  const pick = async (key, v) => {
    try {
      await act("settings", { [key]: v }, err);
    } catch {
      return;
    }
    if (key !== "lang") return;
    // The VIP picked the room's language: this phone follows the room again.
    try {
      localStorage.removeItem(LANG_KEY);
    } catch {}
    if (useLang()) {
      shown = "";
      render();
    }
  };
  add("lang", [...LANGS], LANGS.map((l) => strings(l).langName), t.langLabel);
  add("rounds", ["auto", 1, 2], [t.roundsAuto, t.roundsOnce, t.roundsTwice], t.roundsLabel, roundsLine);
  add("write", [30, 45, 60, 90], [30, 45, 60, 90].map(t.seconds), t.writeLabel);
  add("difficulty", ["easy", "normal", "hard"], [t.easy, t.normal, t.hard], t.wordsLabel);
  add("late", ["wait", "closed"], [t.lateWait, t.lateClosed], t.lateLabel, lateLine);
  /** @param {RoomView} room */
  const update = (room) => {
    box.hidden = !myself()?.vip || !room.settings;
    const cur = room.settings;
    if (!cur) return;
    for (const it of items) {
      const value = it.key === "lang" ? room.lang : cur[it.key];
      it.buttons.forEach((b, i) => {
        const on = it.values[i] === value;
        b.classList.toggle("on", on);
        b.setAttribute("aria-pressed", String(on));
        // A language without words cannot be picked (as on the host page).
        if (it.key === "lang") b.disabled = !on && Array.isArray(room.langs) && !room.langs.includes(it.values[i]);
      });
    }
    roundsLine.textContent = t.roundsLine[cur.rounds] ?? "";
    lateLine.textContent = t.lateLine[cur.late] ?? "";
  };
  return { box, update };
}

/**
 * @param {Task<"lobby">} me
 * @returns {Screen}
 */
function lobby(me) {
  const err = h("p", { class: "line error", role: "alert" });
  const { ring, tools, hint } = facePad(me.face, me.color, err);
  const count = h("span", { class: "count" });
  const list = h("ul", { class: "people" });
  const start = btn("primary", () => {
    start.disabled = true;
    act("start", null, err).catch(() => (start.disabled = false));
  }, t.start);
  const slip = h("p", { class: "slip" });
  const set = settingsBox(err);
  /** @type {string | null} */
  let confirmKick = null;
  let lastList = "";
  return {
    main: [
      h("h1", { class: "title" }, t.drawFace),
      ring,
      tools,
      hint,
      h("h2", { class: "label" }, `${t.atTable} `, count),
      list,
      set.box,
    ],
    dock: [err, start, slip],
    refresh: (m, room) => {
      if (m.task !== "lobby") return;
      const vip = !!myself()?.vip;
      const here = room.people.filter((p) => p.connected && !p.left);
      count.textContent = `${room.people.length} / ${room.maxPlayers}`;
      const key = JSON.stringify([room.people.map((p) => [p.id, p.name, p.color, p.face, p.vip, p.connected, p.bot]), vip, confirmKick]);
      if (key !== lastList) {
        lastList = key;
        list.replaceChildren(
          ...room.people.map((p) => {
            const mine = p.id === client.you?.id;
            const kick =
              vip && !mine
                ? btn(confirmKick === p.id ? "kick sure" : "kick", () => {
                    if (confirmKick !== p.id) {
                      confirmKick = p.id;
                      render();
                      return;
                    }
                    confirmKick = null;
                    act("kick", { id: p.id }, err).catch(() => {});
                  }, confirmKick === p.id ? t.removeSure : "✕")
                : null;
            if (kick) kick.setAttribute("aria-label", t.remove(p.name));
            return h(
              "li",
              { class: p.connected ? "" : "away" },
              chip(p, 40, { crown: p.vip }),
              h("span", { class: "name" }, p.name, mine ? h("small", {}, t.you) : null),
              !p.connected ? h("small", { class: "gone" }, t.away) : null,
              kick,
            );
          }),
        );
      }
      start.hidden = !vip;
      start.disabled = !m.canStart;
      start.textContent = m.canStart ? t.startWith(here.length) : t.needPlayers(room.minPlayers, Math.max(0, room.minPlayers - here.length));
      const host = room.people.find((p) => p.vip);
      slip.hidden = vip;
      slip.textContent = host ? t.vipStarts(host.name) : t.startsSoon;
      set.update(room);
    },
  };
}

/** @returns {Screen} */
function waitLate() {
  const p = myself();
  const err = h("p", { class: "line error", role: "alert" });
  const { ring, tools, hint } = facePad(p?.face ?? { preset: 0 }, p?.color ?? 0, err);
  return {
    main: [
      h("h1", { class: "title" }, t.youreIn),
      big(t.lateNote),
      ring,
      tools,
      hint,
      err,
    ],
  };
}

// ---------------------------------------------------------------------------
// The round

/**
 * @param {Task<"hotseat">} me
 * @param {RoomView} room
 * @returns {Screen}
 */
function hotseat(me, room) {
  const g = person(room.guesser);
  const round = room.round && room.rounds ? tape(t.roundOf(room.round, room.rounds)) : null;
  if (me.guesser) {
    buzz([80, 60, 80]);
    return {
      tone: "spot",
      main: [
        h(
          "section",
          { class: "center" },
          round,
          chip(myself(), 132, { blindfold: true }),
          h("h1", { class: "title" }, t.hotSeat),
          big(t.noPeeking),
          note(t.hotSeatNote),
        ),
      ],
    };
  }
  return {
    main: [
      h(
        "section",
        { class: "center" },
        round,
        chip(g, 120, { blindfold: true }),
        h("h1", { class: "title" }, t.guesses(g?.name ?? t.someone)),
        big(t.getReady),
        note(t.hotSeatGiver),
      ),
    ],
  };
}

/**
 * The clue-giver writes (one slot, or two with 3 players).
 * @param {Task<"write">} me
 * @param {RoomView} room
 * @returns {Screen}
 */
function write(me, room) {
  const g = person(room.guesser);
  const allIn = h("p", { class: "line ok" });
  /** @type {{ refresh: (sent: { text: string, bold: boolean } | null) => void, lastCall: () => void }[]} */
  const slots = [];
  const box = h("div", { class: `slots n${me.each}` });
  for (let i = 0; i < me.each; i++) {
    const s = slot(i, me.each);
    slots.push(s);
    box.append(s.el);
  }
  const screen = {
    main: [
      indexCard(me.word),
      h("p", { class: "line who-guesses" }, chip(g, 26), t.whoGuesses(g?.name ?? t.someone, me.each)),
      allIn,
      note(h("b", {}, t.bold), t.boldNote),
    ],
    dock: [box],
    refresh: (/** @type {PlayerState} */ m) => {
      if (m.task !== "write") return;
      slots.forEach((s, i) => s.refresh(m.sent[i] ?? null));
      const done = m.sent.filter(Boolean).length;
      allIn.textContent = done >= m.each ? t.allIn : "";
    },
  };
  queueMicrotask(() => {
    lastCall = () => slots.forEach((s) => s.lastCall());
  });
  return screen;
}

/**
 * One clue slot: the field, the flame toggle, Send; once accepted, the sent
 * card with Change. A refusal shows the host's message and keeps the text.
 * @param {number} i
 * @param {number} each
 */
function slot(i, each) {
  const input = /** @type {HTMLInputElement} */ (
    h("input", {
      maxlength: MAX_WORD,
      placeholder: each === 2 ? t.cluePlaceholder(i + 1) : t.oneWord,
      "aria-label": each === 2 ? t.clueN(i + 1) : t.yourClue,
      autocapitalize: lang === "de" ? "sentences" : "none",
      lang,
      autocomplete: "off",
      autocorrect: "off",
      spellcheck: "false",
      enterkeyhint: "send",
    })
  );
  const label = h("p", { class: "line", "aria-live": "polite" });
  const bold = btn("boldtoggle", () => {
    setBold(bold.getAttribute("aria-pressed") !== "true");
    input.focus({ preventScroll: true });
  }, icon(FLAME), h("span", {}, t.bold));
  bold.setAttribute("aria-pressed", "false");
  bold.setAttribute("aria-label", t.bold);
  const send = btn("primary send", () => submit(), t.send);
  const editor = h(
    "form",
    {
      class: "editor",
      autocomplete: "off",
      onsubmit: (/** @type {Event} */ e) => {
        e.preventDefault();
        submit();
      },
    },
    input,
    bold,
    send,
  );
  const sentWord = h("span", { class: "word" });
  const sentCard = h("div", { class: "sent" }, h("span", { class: "mini-back" }, h("span", {}, "J")), h("span", { class: "text" }, h("span", { class: "lbl" }, t.sent), sentWord), btn("ghost small", () => edit(), t.change));
  const el = h("div", { class: "slot" }, label, editor, sentCard);
  let pending = false;
  let editing = false;
  /** @type {{ text: string, bold: boolean } | null} */
  let sent = null;
  /** @type {string} */
  let error = "";

  /** @param {boolean} on */
  function setBold(on) {
    bold.setAttribute("aria-pressed", String(on));
    el.classList.toggle("is-bold", on);
  }
  function edit() {
    editing = true;
    if (sent) {
      input.value = sent.text;
      setBold(sent.bold);
    }
    update();
    input.focus();
  }
  async function submit() {
    const text = input.value.trim();
    if (pending) return;
    if (!text) {
      error = t.typeFirst;
      update();
      input.focus();
      return;
    }
    pending = true;
    error = "";
    update();
    try {
      await client.act("clue", { text, bold: bold.getAttribute("aria-pressed") === "true", slot: i });
      editing = false;
      buzz([25]);
      if (document.activeElement === input) input.blur();
    } catch (e) {
      error = message(e, "clue");
      buzz([60, 40, 60]);
      input.focus();
    }
    pending = false;
    update();
  }
  function update() {
    const open = !sent || editing;
    editor.hidden = !open;
    sentCard.hidden = open;
    send.disabled = pending;
    send.textContent = pending ? "…" : sent && editing ? t.swap : t.send;
    label.classList.toggle("error", !!error);
    label.textContent = error || (open ? (each === 2 ? t.clueN(i + 1) : t.yourClue) + (sent ? t.untilTime : "") : "");
    if (sent) {
      sentWord.textContent = sent.text;
      sentCard.classList.toggle("bold", sent.bold);
      sentWord.append(sent.bold ? " 🔥" : "");
      // The clue whole, never cut: on its own line when it needs it, smaller when even that is too narrow.
      sentWord.style.fontSize = "";
      requestAnimationFrame(() => {
        const room = sentWord.parentElement?.clientWidth ?? 0;
        const w = sentWord.scrollWidth;
        if (room > 0 && w > room) sentWord.style.fontSize = `${Math.max(10, (parseFloat(getComputedStyle(sentWord).fontSize) * room) / w - 0.2)}px`;
      });
    }
  }
  update();
  return {
    el,
    /** @param {{ text: string, bold: boolean } | null} s */
    refresh(s) {
      const changed = JSON.stringify(s) !== JSON.stringify(sent);
      sent = s;
      if (changed) update();
    },
    lastCall() {
      if (!pending && (!sent || editing) && input.value.trim() && input.value.trim() !== sent?.text) submit();
    },
  };
}

/**
 * @param {Task<"blind">} me
 * @returns {Screen}
 */
function blind(me) {
  const count = h("p", { class: "big" });
  const dots = h("div", { class: "dots" });
  return {
    tone: "spot",
    main: [
      h(
        "section",
        { class: "center" },
        h("div", { class: "envelope" }, icon(ENVELOPE)),
        h("h1", { class: "title" }, t.eyesOnTv),
        big(t.friendsWriting),
        dots,
        count,
      ),
    ],
    refresh: (m) => {
      if (m.task !== "blind") return;
      count.textContent = t.doneOf(m.done, m.givers);
      dots.replaceChildren(...Array.from({ length: m.givers }, (_, i) => h("i", { class: i < m.done ? "on" : "" })));
    },
  };
}

/**
 * @param {Task<"check">} me
 * @returns {Screen}
 */
function check(me) {
  const backs = h("div", { class: "backs" });
  for (let i = 0; i < me.survived; i++) backs.append(h("i", { class: "back" }, h("span", {}, "J")));
  for (let i = 0; i < me.jinxed; i++) backs.append(h("i", { class: "back broken" }, h("span", {}, "J")));
  return {
    tone: "spot",
    main: [
      h(
        "section",
        { class: "center" },
        h("h1", { class: "title" }, t.jinxCheck),
        backs,
        big(t.survived(me.survived), h("br"), h("span", { class: "dim" }, t.wereJinxed(me.jinxed))),
        note(me.survived ? t.pickCard : t.allSmoke),
      ),
    ],
  };
}

/**
 * @param {Task<"fate">} me
 * @returns {Screen}
 */
function fate(me) {
  const jinxed = me.cards.some((c) => c.fate === "jinxed");
  buzz(jinxed ? [220] : [30]);
  const list = h("div", { class: "fates" });
  for (const c of me.cards) {
    const names = c.with.map((w) => person(w)?.name ?? w);
    const why = c.reason ? (t.reasons[c.reason] ?? c.reason) : "";
    list.append(
      h(
        "div",
        { class: `fate ${c.fate}` },
        h("div", { class: `card up${c.bold ? " bold" : ""}${c.fate === "jinxed" ? " cracked" : ""}` }, h("span", { class: "paper" }, h("span", { class: "word" }, c.text)), c.bold ? flame() : null),
        c.fate === "alive"
          ? h("div", { class: "says" }, stamp(t.stampSurvived, "leaf"), h("p", {}, c.bold ? t.boldStillIn : t.stillIn))
          : h(
              "div",
              { class: "says" },
              stamp(t.stampJinxed, "tomato"),
              h("p", {}, names.length ? t.jinxedWith(names) : t.withOwn),
              why ? tape(why) : null,
              c.bold ? h("p", { class: "minus" }, t.boldMinus) : null,
            ),
      ),
    );
  }
  return {
    main: [indexCard(me.word), h("h1", { class: "title" }, t.yourCards(me.cards.length)), list, note(t.dontSay)],
  };
}

/**
 * The guesser: turn cards, type the one guess (live on the TV), or pass.
 * @param {Task<"guess">} me
 * @returns {Screen}
 */
function guess(me) {
  const grid = h("div", { class: "cards" });
  const potBox = h("div", { class: "potbox" });
  const info = h("p", { class: "line" });
  const err = h("p", { class: "line error", role: "alert" });
  const input = /** @type {HTMLInputElement} */ (
    h("input", {
      class: "tape-field",
      maxlength: MAX_WORD,
      placeholder: t.guessPlaceholder,
      "aria-label": t.yourGuess,
      autocapitalize: lang === "de" ? "sentences" : "none",
      lang,
      autocomplete: "off",
      autocorrect: "off",
      spellcheck: "false",
      enterkeyhint: "done",
    })
  );
  const go = btn("primary", () => lockIn(), t.guess);
  let passArmed = false;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let passTimer = null;
  const pass = btn("ghost pass", () => {
    if (!passArmed) {
      passArmed = true;
      pass.textContent = t.passSure;
      pass.classList.add("armed");
      passTimer = setTimeout(() => {
        passArmed = false;
        pass.textContent = t.pass;
        pass.classList.remove("armed");
      }, 3000);
      return;
    }
    if (passTimer) clearTimeout(passTimer);
    busy = true;
    sync();
    act("pass", null, err).catch(() => {
      busy = false;
      sync();
    });
  }, t.pass);
  const form = h(
    "form",
    {
      class: "editor",
      autocomplete: "off",
      // Enter (the keyboard's "done") only closes the keyboard: the one
      // guess goes with the Guess button, never by accident.
      onsubmit: (/** @type {Event} */ e) => {
        e.preventDefault();
        input.blur();
      },
    },
    input,
    go,
  );
  let busy = false;
  /**
   * The card just turned that the TV is still turning (`me.turning`): its
   * word is here at once, but no other pick and no lock-in until the TV
   * has it too.
   */
  let turning = "";
  /** The card tapped, until the host answers: lifted at once. */
  let picking = "";
  let cards = me.cards;
  let lastCards = "";
  /** Cards already face up here (one turned since flips over once). */
  const up = new Set(me.cards.filter((c) => c.turned).map((c) => c.id));
  function drawGrid() {
    grid.replaceChildren(
      ...cards.map((c) => {
        if (c.turned) {
          const fresh = !up.has(c.id);
          up.add(c.id);
          if (fresh) buzz([15]);
          const extra = [c.id === turning ? "turning" : "", fresh ? "flipin" : ""].filter(Boolean).join(" ");
          return cardEl(c, { extra: extra || undefined });
        }
        if (c.id === turning || c.id === picking) return cardEl(c, { words: false, extra: "turning" });
        return cardEl(c, { tag: "button", onclick: () => pick(c.id), label: t.turnCard(nameOf(c.author)), words: false });
      }),
    );
    fitWords(grid);
  }
  input.addEventListener("input", () => {
    client.input({ draft: input.value.slice(0, MAX_WORD) });
    sync();
  });
  function lockIn() {
    const text = input.value.trim();
    if (busy || turning || !text || !cards.some((c) => c.turned)) return;
    busy = true;
    sync();
    input.blur();
    act("guess", { text }, err).catch(() => {
      busy = false;
      sync();
      buzz([60, 40, 60]);
    });
  }
  /** @param {string} id */
  function pick(id) {
    if (busy || turning) return;
    busy = true;
    picking = id;
    drawGrid();
    sync();
    buzz([20]);
    act("pick", { card: id }, err)
      .catch(() => {
        picking = "";
        drawGrid();
      })
      .finally(() => {
        busy = false;
        sync();
      });
  }
  function sync() {
    const turned = cards.filter((c) => c.turned).length;
    const left = cards.length - turned;
    const wait = busy || !!turning;
    // Typing may start while the TV still turns the card (the draft shows beside it).
    input.disabled = busy || turned === 0;
    input.placeholder = turned === 0 ? t.turnFirst : t.guessPlaceholder;
    go.disabled = wait || turned === 0 || !input.value.trim();
    pass.disabled = wait || turned === 0;
    grid.querySelectorAll("button").forEach((b) => ((/** @type {HTMLButtonElement} */ (b)).disabled = wait));
    const card = turning ? cards.find((c) => c.id === turning) : undefined;
    info.textContent = card ? t.turning(nameOf(card.author)) : turned === 0 ? t.whoseCard : left === 0 ? t.noCardsLeft : t.another;
  }
  return {
    tone: "hot",
    main: [h("div", { class: "head" }, potBox, h("div", { class: "info" }, h("h1", { class: "title" }, t.yourTurn), h("p", { class: "dim jinxed" }))), grid],
    dock: [info, err, form, pass],
    refresh: (m) => {
      if (m.task !== "guess") return;
      cards = m.cards;
      turning = m.turning ?? "";
      if (picking && cards.some((c) => c.id === picking && c.turned)) picking = "";
      const key = JSON.stringify([m.cards, m.pot, turning]);
      if (key !== lastCards) {
        lastCards = key;
        potBox.replaceChildren(potEl(m.pot));
        const jinx = main.querySelector(".jinxed");
        if (jinx) jinx.textContent = t.cardsSurvived(m.cards.length, m.jinxed);
        drawGrid();
      }
      sync();
    },
  };
}

/**
 * A clue-giver in the reveal: the word, the cards, quiet.
 * @param {Task<"watch">} me
 * @param {RoomView} room
 * @returns {Screen}
 */
function watch(me, room) {
  const g = person(room.guesser);
  const grid = h("div", { class: "cards small" });
  const potBox = h("div", { class: "potbox" });
  let last = "";
  return {
    main: [
      h("div", { class: "head" }, indexCard(me.word), potBox),
      h("div", { class: "shh" }, h("b", {}, t.shhh), h("span", {}, t.noHints(g?.name ?? t.theGuesser))),
      grid,
    ],
    refresh: (m) => {
      if (m.task !== "watch") return;
      const key = JSON.stringify([m.cards, m.pot]);
      if (key === last) return;
      last = key;
      potBox.replaceChildren(potEl(m.pot));
      grid.replaceChildren(...m.cards.map((c) => cardEl(c)));
      fitWords(grid);
    },
  };
}

/**
 * The verdict (and the replay for clue-givers): the word, what the round
 * did to the room's bank, and what this phone's cards did (`parts`; the
 * best clue's author gets "best" during the replay, on the same screen).
 * @param {Task<"result">} me
 * @param {RoomView} room
 * @returns {Screen}
 */
function result(me, room) {
  const g = person(room.guesser);
  const replay = h("p", { class: "line replay" });
  /** @type {Kid} */
  let top;
  if (me.guesser) {
    top = stamp(t.stamps[me.result], me.result === "right" ? "leaf" : me.result === "lost" ? "tomato" : "ink");
    buzz(me.result === "right" ? [40, 40, 40, 40, 140] : me.result === "wrong" ? [300] : [60]);
  } else {
    const name = g?.name ?? t.theGuesser;
    const verdict = me.result === "right" ? t.gotIt(name) : me.result === "wrong" ? t.missed(name) : me.result === "pass" ? t.passed(name) : t.allJinxed;
    top = h("h1", { class: "title" }, verdict);
    buzz(me.banked > 0 ? [40, 40, 80] : me.banked < 0 ? [200] : [30]);
  }
  const parts = h("ul", { class: "why" });
  /** @type {string | null} */
  let lastParts = null;
  return {
    tone: me.result === "right" ? "good" : "",
    main: [
      h(
        "section",
        { class: "center" },
        top,
        indexCard(me.word, t.theWordWas),
        h(
          "div",
          { class: "banked" },
          h("p", { class: `points ${me.banked > 0 ? "plus" : me.banked < 0 ? "minus" : "zero"}` }, signed(me.banked), h("small", {}, t.forTheRoom)),
          h("p", { class: "bank-line" }, t.bankIs(me.bank)),
        ),
        me.guesser ? note(t.guesserNote[me.result]) : null,
        parts,
        replay,
      ),
    ],
    refresh: (m, r) => {
      if (m.task !== "result") return;
      const key = m.parts.join();
      if (key !== lastParts) {
        if (lastParts !== null) buzz([30, 30, 60]);
        lastParts = key;
        parts.replaceChildren(...m.parts.map((p) => h("li", { class: p }, t.parts[p] ?? p)));
      }
      parts.hidden = !m.parts.length;
      replay.textContent = r.phase === "replay" && !m.guesser && m.result === "right" && !m.parts.includes("best") ? t.pickingBest(g?.name ?? t.theGuesser) : r.phase === "replay" ? t.replay : "";
    },
  };
}

/**
 * The guesser picks the clue that helped most: a thank-you, no chips.
 * @param {Task<"best">} me
 * @returns {Screen}
 */
function best(me) {
  const err = h("p", { class: "line error", role: "alert" });
  const grid = h("div", { class: "cards" });
  /** @type {string | null} */
  let chosen = null;
  const done = h("p", { class: "line ok" });
  const draw = () => {
    grid.replaceChildren(
      ...me.cards.map((c) => {
        const b = cardEl(c, {
          tag: "button",
          extra: chosen === c.id ? "chosen" : chosen ? "dim" : "",
          label: t.bestLabel(c.word ?? "", nameOf(c.author)),
          onclick: () => {
            if (chosen) return;
            chosen = c.id;
            buzz([30, 30, 60]);
            draw();
            act("best", { card: c.id }, err).then(
              () => (done.textContent = t.bestDone(nameOf(c.author))),
              () => {
                chosen = null;
                draw();
              },
            );
          },
        });
        if (chosen === c.id) b.append(h("span", { class: "rosette" }, t.best));
        return b;
      }),
    );
  };
  draw();
  fitWords(grid);
  return {
    tone: "good",
    main: [h("h1", { class: "title" }, t.whichHelped), note(t.bestNote), grid, done, err],
  };
}

/**
 * Between rounds: the room's bank, this round's change, the next title.
 * @param {Task<"bank">} me
 * @param {RoomView} room
 * @returns {Screen}
 */
function bank(me, room) {
  if (me.next) buzz([80, 60, 80]);
  const goal = me.goal ? t.moreTo(Math.max(0, me.goal.chips - me.bank), t.titles[me.goal.title] ?? me.goal.title) : t.topTitle;
  return {
    main: [
      h(
        "section",
        { class: "center" },
        room.round && room.rounds ? tape(t.afterRound(room.round, room.rounds)) : null,
        bankNote(me.bank, { banked: me.banked }),
        h("p", { class: "goal" }, goal),
        me.next ? h("div", { class: "next" }, stamp(t.upNext, "gold"), note(t.upNextNote)) : note(t.bankOnTv),
      ),
    ],
  };
}

/**
 * The score pad's note: the room's bank, big, and this round's change.
 * @param {number} chips
 * @param {{ banked?: number, record?: boolean }} [o] `banked` between rounds, `record` at the end
 */
function bankNote(chips, o = {}) {
  const { banked, record } = o;
  return h(
    "div",
    { class: "pad-note" },
    h("p", { class: "chips" }, String(chips)),
    h("p", { class: "total" }, t.chipsInBank(chips)),
    banked === undefined ? null : h("p", { class: `delta ${banked > 0 ? "plus" : banked < 0 ? "minus" : "zero"}` }, signed(banked), t.thisRound),
    record ? h("p", { class: "record" }, t.newRecord) : null,
  );
}

/**
 * The end: the room's bank and title, a new record, the words found, own
 * award; the VIP plays again.
 * @param {Task<"final">} me
 * @returns {Screen}
 */
function final(me) {
  const err = h("p", { class: "line error", role: "alert" });
  const again = btn("primary", () => {
    again.disabled = true;
    act("again", null, err).catch(() => (again.disabled = false));
  }, t.playAgain);
  const slip = h("p", { class: "slip" });
  const set = settingsBox(err);
  const award = me.award ? t.awards[me.award] : null;
  const low = me.title === "total jinx" || me.title === "mixed signals";
  if (me.record) buzz([40, 40, 40, 40, 140]);
  return {
    main: [
      h(
        "section",
        { class: "center final" },
        tape(t.gameOver),
        bankNote(me.bank, { record: me.record }),
        stamp(t.titles[me.title] ?? me.title, low ? "tomato" : "leaf"),
        big(t.wordsFound(me.found, me.total)),
        award ? h("div", { class: "award" }, h("small", {}, t.yourAward), h("b", {}, award[0]), h("p", {}, award[1])) : null,
      ),
      set.box,
    ],
    dock: [err, again, slip],
    refresh: (m, room) => {
      if (m.task !== "final") return;
      again.hidden = !m.canRestart;
      const host = room.people.find((p) => p.vip);
      slip.hidden = m.canRestart;
      slip.textContent = host ? t.vipAgain(host.name) : t.thanks;
      set.update(room);
    },
  };
}

// ---------------------------------------------------------------------------
// The clock: the header's dial for the task's deadline.

let buzzedLow = "";
function tick() {
  const me = meView();
  const deadline = !outside && me && !held(me, roomView()) && "deadline" in me && typeof me.deadline === "number" ? me.deadline : null;
  timer.hidden = deadline === null;
  if (deadline === null || !me) return;
  const left = deadline - client.now();
  const s = Math.max(0, Math.ceil(left / 1000));
  timer.textContent = String(s);
  timer.classList.toggle("low", left < 10_000);
  if (left < 10_000 && left > 0 && buzzedLow !== shown && me.task !== "blind") {
    buzzedLow = shown;
    buzz([40]);
  }
  if (left < 900) lastCall?.();
}
setInterval(tick, 250);

// ---------------------------------------------------------------------------
// Connection

client.on("status", (/** @type {string} */ s) => {
  if (s === "reconnecting") {
    banner.hidden = false;
    banner.textContent = t.reconnecting;
    app.classList.add("offline");
  } else if (s === "open") {
    banner.hidden = true;
    app.classList.remove("offline");
  } else if (s === "closed" && !client.byeReason && shown !== "join") {
    banner.hidden = true;
    app.classList.remove("offline");
    plain("closed", h("h1", { class: "title" }, t.disconnected), big(t.closedText), btn("primary", () => location.reload(), t.reconnect));
  }
});

client.on("bye", (/** @type {string} */ reason) => {
  const text = t.bye[reason];
  if (!text) return;
  banner.hidden = true;
  app.classList.remove("offline");
  timer.hidden = true;
  meBox.replaceChildren();
  if (reason === "kicked") buzz([200]);
  plain(`bye:${reason}`, logo(true), big(text), reason !== "room-closed" ? note(t.scanAgain) : null);
});

client.on("view", () => {
  if (shown.startsWith("bye:")) return;
  render();
});

// Keep the screen on while playing.
async function wake() {
  try {
    await /** @type {any} */ (navigator).wakeLock?.request("screen");
  } catch {}
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") wake();
});

plain("connecting", logo(true), big(t.connecting));
if (!client.room || !client.key) {
  plain("no-room", logo(true), big(t.scanToJoin));
  showSwitch(true);
} else if (client.canResume) {
  client.connect().then(wake, (/** @type {any} */ e) => joinForm(e?.code === "no-player" ? "" : message(e, "join")));
} else {
  joinForm();
}

