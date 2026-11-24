// @ts-check
/**
 * Crosstalk's phone page: joining, the lobby (a team, the spymaster of
 * the next game, the VIP's settings), then one of two seats a game long:
 *
 * - the spymaster: the key (every card's colour), the clue (a word and
 *   a number) and, while the team guesses, its pins;
 * - an operative: the team's clue, the board to pin and lock cards on,
 *   Pass, and the team's pad (lines anyone of the team writes; unsent
 *   typing is kept on the phone, a tap on a card while writing types
 *   its word).
 *
 * At the end: the winner, the key, both teams' clues and pads, and the
 * lobby again for the next game. Everything it shows comes from the
 * party's view (`{ roster, room, me }`, game/views.ts); everything it
 * does is an action.
 */

import { blockEmoji, PartyClient } from "/_tvpipe/lib/client.js";
import { watchFit } from "./fit.js";
import { browserLang, LANGS, pickLang } from "./i18n.js";
import { strings } from "./strings.js";

/** @typedef {"red" | "blue"} Team */
/** @typedef {"red" | "blue" | "neutral" | "assassin"} Color */
/** @typedef {number | "pass"} Choice */
/** @typedef {{ word: string, color: Color | null, by: Team[], at: number }} BoardCard */
/** @typedef {{ id: number, text: string, by: string, name: string, edit: string | null }} PadLine */
/** @typedef {{ round: number, word: string, number: number, cards: number[] }} ClueLine */

const TEAMS = /** @type {const} */ (["red", "blue"]);
const NAME_MAX = 16;
const CLUE_MAX = 24;
const PAD_LINES = 24;
const PAD_CHARS = 80;
const CLUE_TIMES = [60, 90, 120];
const STEP_TIMES = [20, 30, 45];
/** How long a press is a long press (the card's word big, its pad lines). */
const LONG_PRESS = 480;

// A controller, not a document: no pinch or double-tap zoom, no selection.
for (const type of ["gesturestart", "gesturechange", "gestureend"]) document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
document.addEventListener("touchmove", (e) => e.touches.length > 1 && e.preventDefault(), { passive: false });
document.addEventListener("dblclick", (e) => e.preventDefault(), { passive: false });
document.addEventListener("selectstart", (e) => {
  const el = e.target instanceof Element ? e.target : /** @type {Node} */ (e.target).parentElement;
  if (!el?.closest("input, textarea")) e.preventDefault();
});
document.addEventListener("contextmenu", (e) => {
  const el = e.target instanceof Element ? e.target : null;
  if (el?.closest(".tile")) e.preventDefault();
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
const toastBox = /** @type {HTMLElement} */ (document.getElementById("toast"));
const sheetBox = /** @type {HTMLElement} */ (document.getElementById("sheet"));

// ---------------------------------------------------------------------------
// The language: the room's, the same on every phone (the host page or the
// VIP sets it); before joining, the browser's.

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
const CHECK = "M5 12.5l4.5 4.5L19 7";
const CROSS = "M6 6l12 12|M18 6L6 18";
const PLUS = "M12 5v14|M5 12h14";
/** A headset: the spymaster (an operator at the switchboard). */
const HEADSET = "M4 14v-2a8 8 0 0 1 16 0v2|M4 14h3v6H5a1 1 0 0 1-1-1z|M20 14h-3v6h2a1 1 0 0 0 1-1z|M17 20c0 1-2 2-4 2";

/** @param {unknown} x @returns {x is Team} */
const isTeam = (x) => x === "red" || x === "blue";
/** @param {Team} x @returns {Team} */
const other = (x) => (x === "red" ? "blue" : "red");
const myId = () => /** @type {string | undefined} */ (client.you?.id);

/** A name from the roster, else from the room's names (who left). @param {string | null | undefined} id */
function nameOf(id) {
  if (!id) return "?";
  const r = (client.view?.roster ?? []).find((/** @type {any} */ x) => x.id === id);
  return r?.name ?? client.view?.room?.names?.[id] ?? "?";
}
/** @param {string} id */
const rosterOf = (id) => (client.view?.roster ?? []).find((/** @type {any} */ x) => x.id === id);
const isVip = () => !!rosterOf(myId() ?? "")?.vip;

/**
 * Short tags for a team's players: the first letter, or more of the name
 * where two would look the same.
 * @param {string[]} ids
 */
function initials(ids) {
  /** @type {Map<string, string>} */
  const out = new Map();
  const letters = ids.map((id) => [...nameOf(id).trim()]);
  ids.forEach((id, i) => {
    const mine = letters[i] ?? [];
    let n = 1;
    while (n < 3 && letters.some((o, j) => j !== i && o.slice(0, n).join("").toUpperCase() === mine.slice(0, n).join("").toUpperCase())) n++;
    out.set(id, mine.slice(0, n).join("").toUpperCase() || "?");
  });
  return out;
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
  const text = input.value;
  if (!text || !input.clientWidth) return;
  const cs = getComputedStyle(input);
  const base = parseFloat(cs.fontSize);
  ruler ??= document.createElement("canvas").getContext("2d");
  if (!ruler || !base) return;
  ruler.font = `${cs.fontWeight} ${base}px ${cs.fontFamily}`;
  const shownText = cs.textTransform === "uppercase" ? text.toUpperCase() : text;
  const spacing = parseFloat(cs.letterSpacing) || 0;
  const width = (ruler.measureText(shownText).width + spacing * [...shownText].length) * 1.04;
  const room = input.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 2;
  if (width <= room || room <= 0) return;
  input.style.fontSize = `${Math.max(min, (base * room) / width).toFixed(2)}px`;
}
document.addEventListener("input", (e) => e.target instanceof HTMLInputElement && fitField(e.target));
document.addEventListener("focusin", (e) => e.target instanceof HTMLInputElement && fitField(e.target));

/** A textarea as tall as its text (pad lines wrap between words, never scroll). @param {HTMLTextAreaElement} ta */
function grow(ta) {
  ta.style.height = "auto";
  ta.style.height = `${ta.scrollHeight + 2}px`;
}

// While a field of the game has the keyboard (the pad, the clue), the board gets compact.
function writingNow() {
  const a = document.activeElement;
  return !!a && (a.matches?.(".pad textarea") || a.id === "clue");
}
function updateWriting() {
  const w = writingNow();
  if (document.body.classList.contains("writing") === w) return;
  document.body.classList.toggle("writing", w);
  appHeight();
  refitTiles();
}
document.addEventListener("focusin", updateWriting);
document.addEventListener("focusout", () => setTimeout(updateWriting, 60));

// ---------------------------------------------------------------------------
// What was typed and not sent yet, kept on the phone: a reload loses nothing.

const DRAFT_KEY = "crosstalk:draft";
/** @typedef {{ room: string, game: string, add: string, edit: { id: number, text: string } | null, clue: { round: number, word: string, number: number | null } | null }} Draft */

/** @returns {Draft} */
function draft() {
  const empty = { room: client.room, game: gameKey(), add: "", edit: null, clue: null };
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "null");
    if (d && typeof d === "object" && d.room === client.room && d.game === gameKey()) return { ...empty, ...d };
  } catch {}
  return empty;
}
/** @param {Partial<Draft>} patch */
function saveDraft(patch) {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...draft(), ...patch, room: client.room, game: gameKey() }));
  } catch {}
}
/** The game being played, as the board's words (a draft of another game is no use). */
function gameKey() {
  const b = /** @type {BoardCard[] | null | undefined} */ (client.view?.room?.board);
  if (!b) return "";
  let x = 2166136261;
  const s = b.map((c) => c.word).join("|");
  for (let i = 0; i < s.length; i++) x = Math.imul(x ^ s.charCodeAt(i), 16777619);
  return (x >>> 0).toString(36);
}

// ---------------------------------------------------------------------------
// Joining

/** @param {string} [error] @param {string} [typed] */
function joinForm(error = "", typed) {
  shown = "join";
  refresh = null;
  document.body.className = "";
  const input = /** @type {HTMLInputElement} */ (h("input", { id: "name", maxlength: NAME_MAX, autocapitalize: "words", enterkeyhint: "go", autocomplete: "off", required: true }));
  const err = h("p", { class: "error" }, error);
  let saved = "";
  try {
    saved = localStorage.getItem("crosstalk:name") ?? "";
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
          localStorage.setItem("crosstalk:name", name);
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
  show(logo(), h("section", { class: "panel pop" }, h("h1", {}, t.joinTitle), form));
  if (!input.value) input.focus();
}

/** The name, with two lines crossing behind it (a red and a blue cable). */
function logo() {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 300 90");
  svg.setAttribute("class", "cables");
  svg.setAttribute("aria-hidden", "true");
  for (const [d, c] of [
    ["M6 18 C 110 18, 190 72, 294 72", "var(--red)"],
    ["M6 72 C 110 72, 190 18, 294 18", "var(--blue)"],
  ]) {
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("d", d);
    p.setAttribute("style", `stroke: ${c}`);
    svg.append(p);
  }
  for (const [x, y] of [
    [6, 18],
    [6, 72],
    [294, 18],
    [294, 72],
  ]) {
    const c = document.createElementNS(SVG_NS, "circle");
    c.setAttribute("cx", String(x));
    c.setAttribute("cy", String(y));
    c.setAttribute("r", "6");
    svg.append(c);
  }
  return h("div", { class: "logo" }, svg, h("span", {}, "Crosstalk"));
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
  document.body.className = "";
  setBanner(null);
  closeSheet();
  show(logo(), h("section", { class: "panel" }, h("p", { class: "big" }, text)));
});
client.on("view", (view) => render(view));

// ---------------------------------------------------------------------------
// Views

/** @param {any} me @param {any} room */
function keyOf(me, room) {
  const game = room.board ? gameKey() : "";
  switch (me.task) {
    case "spymaster":
    case "operative":
      return `${me.task}:${me.team}:${game}`;
    case "end":
      return `end:${game}`;
    default:
      return String(me.task ?? "");
  }
}

/** @param {Record<string, any>} view */
function render(view) {
  const me = view.me ?? {};
  const room = view.room ?? {};
  const mine = rosterOf(myId() ?? "");
  if (useLang()) shown = "";
  const team = isTeam(me.team) ? me.team : null;
  who.replaceChildren(...(mine ? [team ? h("span", { class: `dot ${team}` }) : "", h("b", {}, `${mine.vip ? "★ " : ""}${mine.name}`)] : []));
  const key = keyOf(me, room);
  if (key !== shown) {
    shown = key;
    refresh = null;
    for (const c of cleanups) c();
    cleanups = [];
    closeSheet();
    toastBox.hidden = true;
    const full = me.task === "spymaster" || me.task === "operative";
    document.body.className = [full ? "full" : "", team ? `team-${team}` : "", me.task === "spymaster" ? "spy" : ""].filter(Boolean).join(" ");
    updateWriting();
    appHeight();
    build(view);
  } else {
    document.body.classList.toggle("team-red", team === "red");
    document.body.classList.toggle("team-blue", team === "blue");
  }
  refresh?.();
}

/** @param {Record<string, any>} view */
function build(view) {
  const me = view.me ?? {};
  switch (me.task) {
    case "lobby":
      return lobby();
    case "wait":
      return show(logo(), h("section", { class: "panel pop" }, h("p", { class: "big" }, t.waitRound)));
    case "operative":
    case "spymaster":
      return seat(me.task);
    case "end":
      return end();
    default:
      return show(h("section", { class: "panel" }, h("p", { class: "big" }, t.connecting)));
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

// ---------------------------------------------------------------------------
// The lobby (and the end's part for the next game): teams, spymasters, settings.

/** @param {HTMLElement} err */
function settings(err) {
  /** @type {{ key: string, buttons: HTMLButtonElement[], values: any[], line: HTMLElement | null }[]} */
  const items = [];
  const box = h("div", { class: "settings" }, h("h2", {}, t.settings));
  const add = (/** @type {string} */ key, /** @type {any[]} */ values, /** @type {string[]} */ labels, /** @type {string} */ title, /** @type {boolean} */ withLine) => {
    const buttons = values.map((v, i) => /** @type {HTMLButtonElement} */ (h("button", { type: "button", onclick: () => act("settings", { [key]: v }, err).catch(() => {}) }, labels[i])));
    const line = withLine ? h("p", { class: "line" }) : null;
    box.append(h("div", { class: "setting" }, h("label", {}, title), h("div", { class: "seg" }, ...buttons), line));
    items.push({ key, buttons, values, line });
  };
  add("lang", [...LANGS], LANGS.map((l) => strings(l).langName), t.langLabel, false);
  add("clueTime", CLUE_TIMES, CLUE_TIMES.map(t.seconds), t.clueTimeLabel, false);
  add("stepTime", STEP_TIMES, STEP_TIMES.map(t.seconds), t.stepTimeLabel, false);
  add("deal", ["tangled", "mixed"], [t.dealTangled, t.dealMixed], t.dealLabel, true);
  add("difficulty", ["easy", "normal", "hard"], ["easy", "normal", "hard"].map((d) => t.difficulty[d] ?? d), t.difficultyLabel, false);
  add("late", ["wait", "closed"], [t.lateWait, t.lateClosed], t.lateLabel, true);
  const update = () => {
    const room = client.view?.room ?? {};
    box.hidden = !isVip();
    for (const it of items) {
      const cur = room[it.key];
      it.buttons.forEach((b, i) => {
        b.classList.toggle("on", it.values[i] === cur);
        // A language without words cannot be picked (as on the host page).
        if (it.key === "lang") b.disabled = Array.isArray(room.langs) && !room.langs.includes(it.values[i]);
      });
      if (it.key === "deal" && it.line) it.line.textContent = t.dealLine[cur] ?? "";
      if (it.key === "late" && it.line) it.line.textContent = t.lateLine[cur] ?? "";
    }
  };
  return { box, update };
}

/**
 * The teams and the next game: my team (a switch), the spymaster (me,
 * with a tap), both teams' players, and for the VIP Start (or Play
 * again), Shuffle, the settings and removing players.
 * @param {boolean} after at the end of a game
 */
function teamsPanel(after) {
  const err = h("p", { class: "error" });
  const switchButtons = TEAMS.map((tm) => /** @type {HTMLButtonElement} */ (h("button", { type: "button", class: `pick ${tm}`, onclick: () => act("team", { team: tm }, err).catch(() => {}) }, h("span", {}, t.team(tm)))));
  const role = h("p", { class: "role" });
  const spyName = h("b", {});
  const spyButton = /** @type {HTMLButtonElement} */ (h("button", { type: "button", id: "be-spymaster", class: "btn ghost small", onclick: () => act("spymaster", null, err).catch(() => {}) }, icon(HEADSET), t.beSpymaster));
  const cols = h("div", { class: "teamcols" });
  const start = /** @type {HTMLButtonElement} */ (h("button", { class: "btn", id: "start", type: "button", onclick: () => act("start", null, err).catch(() => {}) }, after ? t.playAgain : t.start));
  const shuffle = /** @type {HTMLButtonElement} */ (h("button", { class: "btn ghost", id: "shuffle", type: "button", onclick: () => act("shuffle", null, err).catch(() => {}) }, t.shuffle));
  const hint = h("p", { class: "muted small" });
  const rulesLine = h("p", { class: "small muted" });
  const set = settings(err);
  const el = h(
    "section",
    { class: `panel ${after ? "" : "pop "}lobby` },
    after ? h("h2", { class: "first" }, t.nextGame) : h("h1", {}, t.youreIn),
    h("h2", {}, t.yourTeam),
    h("div", { class: "teamswitch" }, ...switchButtons),
    role,
    h("div", { class: "spyrow" }, h("span", { class: "spylabel" }, icon(HEADSET), h("span", {}, `${t.spymasterNext}:`), spyName), spyButton),
    h("h2", {}, t.teams),
    cols,
    start,
    shuffle,
    err,
    hint,
    rulesLine,
    set.box,
  );
  const update = () => {
    const v = client.view ?? {};
    const room = v.room ?? {};
    const me = v.me ?? {};
    const vip = isVip();
    const team = isTeam(me.team) ? me.team : null;
    const next = room.next ?? {};
    switchButtons.forEach((b, i) => {
      b.classList.toggle("on", TEAMS[i] === team);
      b.setAttribute("aria-pressed", String(TEAMS[i] === team));
    });
    const spy = team ? next[team] : null;
    const iAmSpy = !!spy && spy === myId();
    role.textContent = team ? (iAmSpy ? t.youSpymaster : t.youGuess) : "";
    spyName.textContent = spy ? nameOf(spy) : t.nobodyYet;
    spyButton.hidden = !team || iAmSpy;
    const roster = v.roster ?? [];
    cols.replaceChildren(
      ...TEAMS.map((tm) => {
        const ids = /** @type {string[]} */ (room.teams?.[tm]?.players ?? []);
        return h(
          "div",
          { class: `teamcol ${tm}` },
          h("h3", {}, t.team(tm), h("small", {}, String(ids.length))),
          h(
            "ul",
            {},
            ...ids.map((id) => {
              const r = roster.find((/** @type {any} */ x) => x.id === id);
              return h(
                "li",
                { class: `${r && !r.connected ? "away" : ""}${id === myId() ? " me" : ""}` },
                next[tm] === id ? h("span", { class: "hs", title: t.spymaster }, icon(HEADSET)) : null,
                h("span", { class: "nm" }, nameOf(id)),
                r?.vip ? h("small", { class: "vip" }, t.vip) : null,
                vip && id !== myId() ? h("button", { type: "button", class: "kick", "aria-label": `✕ ${nameOf(id)}`, onclick: () => act("kick", { id }, err).catch(() => {}) }, "✕") : null,
              );
            }),
          ),
        );
      }),
    );
    const min = room.minPlayers ?? 4;
    const ready = roster.filter((/** @type {any} */ r) => r.connected).length;
    start.hidden = !vip;
    shuffle.hidden = !vip;
    start.disabled = ready < min;
    const counts = TEAMS.map((tm) => (room.teams?.[tm]?.players ?? []).length);
    const uneven = Math.abs(counts[0] - counts[1]) > 1;
    hint.textContent = [vip ? (ready < min ? t.vipWait(min - ready) : t.vipReady) : t.waitVip, uneven ? t.uneven : ""].filter(Boolean).join(" ");
    rulesLine.textContent = t.rulesLine(room.clueTime ?? 90, room.stepTime ?? 30, room.deal ?? "tangled", t.difficulty[room.difficulty ?? "normal"] ?? "");
    rulesLine.hidden = vip;
    set.update();
  };
  return { el, update };
}

function lobby() {
  const p = teamsPanel(false);
  show(p.el, h("section", { class: "panel plain" }, h("h2", { class: "first" }, t.howTitle), h("ol", { class: "how" }, ...t.how.map((x) => h("li", {}, x)))));
  refresh = p.update;
}

// ---------------------------------------------------------------------------
// Board words in text (the pad): highlighted, in their colour where it is known.

/** @type {{ key: string, res: RegExp[] }} */
let wordRes = { key: "", res: [] };
/** @param {BoardCard[]} board */
function regexes(board) {
  const key = board.map((c) => c.word).join("|");
  if (wordRes.key !== key) {
    const esc = (/** @type {string} */ s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    wordRes = { key, res: board.map((c) => new RegExp(`(?<![\\p{L}\\p{N}])${esc(c.word.trim())}(?![\\p{L}\\p{N}])`, "giu")) };
  }
  return wordRes.res;
}

/**
 * The board's words in a text, as ranges (longer words first where they overlap).
 * @param {string} text @param {BoardCard[]} board
 * @returns {{ start: number, end: number, card: number }[]}
 */
function findWords(text, board) {
  /** @type {{ start: number, end: number, card: number }[]} */
  const hits = [];
  regexes(board).forEach((re, card) => {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) hits.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, card });
  });
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  /** @type {typeof hits} */
  const out = [];
  for (const x of hits) if (!out.length || x.start >= /** @type {any} */ (out.at(-1)).end) out.push(x);
  return out;
}

/**
 * A text with the board's words marked.
 * @param {string} text @param {BoardCard[]} board @param {(i: number) => Color | null} colorOf
 */
function marked(text, board, colorOf) {
  const frag = document.createDocumentFragment();
  let at = 0;
  for (const x of findWords(text, board)) {
    if (x.start > at) frag.append(text.slice(at, x.start));
    const c = colorOf(x.card);
    frag.append(h("span", { class: `bw${c ? ` c-${c}` : ""}` }, text.slice(x.start, x.end)));
    at = x.end;
  }
  if (at < text.length) frag.append(text.slice(at));
  return frag;
}

// ---------------------------------------------------------------------------
// The board

/**
 * The 5×5 board. `mode`: `op` (an operative: face down or turned, pins),
 * `spy` (the key: every colour, the turned ones dimmed, pins), `end`
 * (the key revealed, the cards never turned faded).
 * @param {"op" | "spy" | "end"} mode
 * @param {{ tap?: (i: number) => void, press?: (i: number) => void }} [on]
 */
function makeBoard(mode, on = {}) {
  const el = h("div", { class: `board ${mode}` });
  /** @type {{ el: HTMLElement, word: HTMLElement, pins: HTMLElement, state: string }[]} */
  const tiles = [];
  let words = "";
  /** Cards that turned while this board was shown (they flip once). */
  const seenTurned = new Set();
  let first = true;

  /** @param {number} i @param {HTMLElement} tile */
  const wire = (i, tile) => {
    let timer = 0;
    let long = false;
    /** @type {{ x: number, y: number } | null} */
    let at = null;
    tile.addEventListener("pointerdown", (e) => {
      // While writing, a tap types the word: the field keeps the keyboard.
      if (document.body.classList.contains("writing")) e.preventDefault();
      long = false;
      at = { x: e.clientX, y: e.clientY };
      clearTimeout(timer);
      if (on.press)
        timer = window.setTimeout(() => {
          long = true;
          buzz(15);
          on.press?.(i);
        }, LONG_PRESS);
    });
    tile.addEventListener("pointermove", (e) => {
      if (at && Math.hypot(e.clientX - at.x, e.clientY - at.y) > 10) clearTimeout(timer);
    });
    for (const type of ["pointerup", "pointercancel", "pointerleave"]) tile.addEventListener(type, () => clearTimeout(timer));
    tile.addEventListener("mousedown", (e) => {
      if (document.body.classList.contains("writing")) e.preventDefault();
    });
    tile.addEventListener("click", (e) => {
      e.preventDefault();
      if (long) return;
      on.tap?.(i);
    });
  };

  /**
   * @param {BoardCard[]} board
   * @param {{ key?: (Color | null)[] | null, pins?: Record<string, Choice>, team?: Team | null, mine?: Choice | null, majority?: Choice | null, locked?: Choice | null, noted?: Set<number> }} o
   */
  const update = (board, o) => {
    const w = board.map((c) => c.word).join("|");
    if (w !== words) {
      words = w;
      tiles.length = 0;
      el.replaceChildren(
        ...board.map((c, i) => {
          const word = h("span", { class: "word" }, c.word);
          const pins = h("span", { class: "pins" });
          const tile = h(mode === "end" ? "div" : "button", { class: "tile", type: mode === "end" ? null : "button" }, word, pins, h("i", { class: "noted" }));
          if (mode !== "end" || on.press) wire(i, tile);
          tiles.push({ el: tile, word, pins, state: "" });
          return tile;
        }),
      );
    }
    const pinIds = Object.keys(o.pins ?? {});
    const tags = initials(pinIds);
    board.forEach((c, i) => {
      const tile = tiles[i];
      if (!tile) return;
      const turned = c.color !== null;
      const color = mode === "op" ? c.color : (o.key?.[i] ?? c.color);
      const who = pinIds.filter((id) => o.pins?.[id] === i);
      const cls = [
        "tile",
        color ? `c-${color}` : "",
        turned ? "turned" : "",
        mode === "end" && !turned ? "faded" : "",
        o.mine === i ? "mine" : "",
        o.majority === i && !turned ? "majority" : "",
        o.locked === i ? "locked" : "",
        o.noted?.has(i) ? "has-note" : "",
      ]
        .filter(Boolean)
        .join(" ");
      if (turned && !seenTurned.has(i)) {
        seenTurned.add(i);
        if (!first) {
          tile.el.classList.remove("fresh");
          void tile.el.offsetWidth;
          tile.el.classList.add("fresh");
        }
      }
      const state = `${cls}|${who.map((id) => `${id}:${tags.get(id)}`).join(",")}|${c.by.join(",")}`;
      if (state === tile.state) return;
      tile.state = state;
      const fresh = tile.el.classList.contains("fresh");
      tile.el.className = cls + (fresh ? " fresh" : "");
      tile.el.setAttribute("aria-pressed", String(o.mine === i));
      tile.pins.replaceChildren(...(turned ? [] : who).map((id) => h("b", { class: id === myId() ? "me" : "" }, tags.get(id) ?? "?")));
    });
    first = false;
    refitTiles();
  };
  return { el, update, tiles };
}

// ---------------------------------------------------------------------------
// A card's word, read whole: narrowed a little first (Anton keeps its
// height), then smaller. On a 320 px phone "Schneeballschlacht" gets a
// quarter more height than with a smaller font alone.

/** How narrow a word may get before its font gets smaller. */
const SQUEEZE = 0.76;

/** @param {HTMLElement} el a card's `.word` */
function fitWord(el) {
  const box = el.parentElement;
  if (!box || !box.clientWidth) return;
  const cs = getComputedStyle(box);
  const room = box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 1;
  const key = `${room}|${cs.fontSize}|${el.textContent}`;
  if (el.dataset["fitted"] === key) return;
  el.style.fontSize = "";
  el.style.transform = "";
  const width = el.offsetWidth;
  if (room > 0 && width > room) {
    const s = room / width;
    if (s >= SQUEEZE) el.style.transform = `scaleX(${s.toFixed(3)})`;
    else {
      el.style.fontSize = `${((parseFloat(cs.fontSize) * s) / SQUEEZE).toFixed(2)}px`;
      el.style.transform = `scaleX(${SQUEEZE})`;
    }
  }
  el.dataset["fitted"] = key;
}

let tilesQueued = false;
/** Fits every card's word (after a change, a resize, the fonts, the keyboard). */
function refitTiles() {
  if (tilesQueued) return;
  tilesQueued = true;
  requestAnimationFrame(() => {
    tilesQueued = false;
    for (const el of document.querySelectorAll(".tile .word, .bigword span")) fitWord(/** @type {HTMLElement} */ (el));
  });
}
window.addEventListener("resize", refitTiles);
document.fonts?.ready.then(() => {
  for (const el of document.querySelectorAll(".tile .word")) delete (/** @type {HTMLElement} */ (el)).dataset["fitted"];
  refitTiles();
});
document.fonts?.addEventListener("loadingdone", () => {
  for (const el of document.querySelectorAll(".tile .word")) delete (/** @type {HTMLElement} */ (el)).dataset["fitted"];
  refitTiles();
});

// ---------------------------------------------------------------------------
// The clock: the phase's time left, a dial.

/** @param {HTMLElement} el */
function runClock(el) {
  const tick = () => {
    const room = client.view?.room ?? {};
    const dl = room.deadline;
    const dur = room.duration;
    if (typeof dl !== "number" || typeof dur !== "number" || dur <= 0) {
      el.classList.add("off");
      el.textContent = "";
      return;
    }
    el.classList.remove("off");
    const ms = dl - client.now();
    el.textContent = String(Math.max(0, Math.ceil(Math.min(ms, dur) / 1000)));
    el.style.setProperty("--p", String(Math.max(0, Math.min(1, ms / dur))));
    el.classList.toggle("low", ms < 8000 && ms > 0);
  };
  tick();
  const timer = setInterval(tick, 200);
  cleanups.push(() => clearInterval(timer));
}

// ---------------------------------------------------------------------------
// A step's flip: one's own team's result, briefly, with a buzz.

/** The last flip shown (undefined: none seen yet, the page just loaded). @type {number | undefined} */
let seenFlip;

/** @param {any} room @param {any} me */
function checkFlip(room, me) {
  const flip = room.flip;
  const step = typeof flip?.step === "number" ? flip.step : 0;
  if (seenFlip === undefined || step <= seenFlip) {
    seenFlip = Math.max(seenFlip ?? 0, step);
    return;
  }
  seenFlip = step;
  const card = (flip.cards ?? []).find((/** @type {any} */ c) => c.team === me.team);
  if (card) {
    const word = room.board?.[card.card]?.word ?? "";
    toast(t.flip[card.result] ?? "", word, card.result);
    buzz(card.result === "right" ? 60 : card.result === "assassin" ? [300, 80, 300, 80, 300] : [90, 70, 90]);
  } else if ((flip.passed ?? []).includes(me.team)) {
    toast(t.flip.pass ?? "", "", "pass");
  }
}

let toastTimer = 0;
/** @param {string} title @param {string} word @param {string} kind */
function toast(title, word, kind) {
  clearTimeout(toastTimer);
  toastBox.className = `toast ${kind}`;
  toastBox.replaceChildren(word ? h("span", { class: "tword", "data-fit": "1" }, word) : "", h("b", { "data-fit": "2" }, title));
  toastBox.hidden = false;
  toastTimer = window.setTimeout(() => {
    toastBox.hidden = true;
  }, 2600);
}
toastBox.addEventListener("click", () => {
  toastBox.hidden = true;
});

// ---------------------------------------------------------------------------
// A sheet over the screen (the clue history, a card's word and pad lines).

/** @param {...(Node | null)} kids */
function openSheet(...kids) {
  sheetBox.replaceChildren(
    h(
      "div",
      { class: "sheet-in", onclick: (/** @type {Event} */ e) => e.stopPropagation() },
      ...kids.filter((k) => k !== null),
      h("button", { type: "button", class: "btn ghost", onclick: closeSheet }, t.close),
    ),
  );
  sheetBox.hidden = false;
  sheetAt = Date.now();
  refitTiles();
}
/** When the sheet opened: the click that ends a long press is not a tap on it. */
let sheetAt = 0;
function closeSheet() {
  sheetBox.hidden = true;
  sheetBox.replaceChildren();
}
sheetBox.addEventListener("click", () => {
  if (Date.now() - sheetAt > 450) closeSheet();
});

/** @param {number} i */
function cardSheet(i) {
  const v = client.view ?? {};
  const board = /** @type {BoardCard[]} */ (v.room?.board ?? []);
  const c = board[i];
  if (!c) return;
  const me = v.me ?? {};
  const color = me.key?.[i] ?? v.room?.reveal?.key?.[i] ?? c.color;
  const lines = /** @type {PadLine[]} */ (me.pad ?? []).filter((l) => findWords(l.text, board).some((x) => x.card === i));
  openSheet(
    h("div", { class: `bigword${color ? ` c-${color}` : ""}` }, h("span", {}, c.word)),
    me.pad
      ? lines.length
        ? h("ul", { class: "padlines" }, ...lines.map((l) => h("li", {}, h("span", { class: "tx" }, marked(l.text, board, (k) => board[k]?.color ?? null)), h("small", {}, l.name))))
        : h("p", { class: "muted small center" }, t.noMentions)
      : null,
  );
}

function historySheet() {
  const v = client.view ?? {};
  const board = /** @type {BoardCard[]} */ (v.room?.board ?? []);
  const hist = /** @type {ClueLine[]} */ (v.me?.history ?? []);
  openSheet(h("h2", { class: "first" }, t.historyTitle), hist.length ? clueList(hist, board, (i) => board[i]?.color ?? null) : h("p", { class: "muted" }, t.noHistory));
}

/**
 * Clues with the cards turned for each.
 * @param {ClueLine[]} hist @param {BoardCard[]} board @param {(i: number) => Color | null} colorOf
 */
function clueList(hist, board, colorOf) {
  return h(
    "ol",
    { class: "clues" },
    ...hist.map((c) =>
      h(
        "li",
        {},
        h("span", { class: "rn" }, t.roundN(c.round)),
        h("span", { class: "cw" }, h("b", {}, c.word), ` ${t.n(c.number)}`),
        h("span", { class: "cards" }, ...(c.cards.length ? c.cards.map((i) => h("span", { class: `chipcard c-${colorOf(i) ?? "neutral"}` }, board[i]?.word ?? "?")) : [h("em", {}, t.nothingTurned)])),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// A seat in the game: the operative's and the spymaster's screens.

/** @param {"operative" | "spymaster"} task */
function seat(task) {
  const spy = task === "spymaster";
  const teamTag = h("span", { class: "teamtag" });
  const clueBox = /** @type {HTMLButtonElement} */ (h("button", { type: "button", class: "clue", onclick: historySheet }));
  const progress = h("span", { class: "prog" });
  const clock = h("span", { class: "clock" });
  const band = h("header", { class: "band" }, h("div", { class: "band-l" }, teamTag, clueBox, progress), clock);
  runClock(clock);
  const status = h("p", { class: "status" });
  const board = makeBoard(spy ? "spy" : "op", spy ? { press: cardSheet } : { tap: (i) => tapCard(i), press: cardSheet });
  const boardBox = h("div", { class: "boardbox" }, board.el);
  if (spy) {
    const spyBox = makeSpyBox();
    const reminder = h("div", { class: "reminder" }, h("b", {}, t.sayNothing), h("span", {}, t.sayNothingSub));
    show(h("div", { class: "seat spymaster" }, band, reminder, boardBox, status, spyBox.el));
    refresh = () => {
      const v = client.view ?? {};
      const room = v.room ?? {};
      const me = v.me ?? {};
      drawBand(room, me);
      board.update(room.board ?? [], { key: me.key, pins: livePins(room, me), majority: me.majority, locked: me.locked });
      status.textContent = spyStatus(room, me);
      spyBox.update(room, me);
      checkFlip(room, me);
    };
    return;
  }
  const pad = makePad();
  const passBtn = /** @type {HTMLButtonElement} */ (h("button", { type: "button", class: "pass", onclick: () => tapPass() }, h("span", {}, t.pass), h("span", { class: "pins" })));
  const lockBtn = /** @type {HTMLButtonElement} */ (h("button", { type: "button", class: "btn lock", onclick: () => act("lock", null, errLine).then(() => buzz(30), () => {}) }, t.lock));
  const errLine = h("p", { class: "error" });
  const actions = h("div", { class: "actions" }, h("div", { class: "statusbox" }, status, errLine), passBtn, lockBtn);
  show(h("div", { class: "seat operative" }, band, boardBox, actions, pad.el));

  /** Whether a pin goes through now (the view's rules, game.ts #pin). */
  const canPin = () => {
    const room = client.view?.room ?? {};
    const me = client.view?.me ?? {};
    return room.phase === "guess" ? me.active && me.locked === null : room.phase === "clue" && !!me.clue;
  };
  /** @param {number} i */
  const tapCard = (i) => {
    const room = client.view?.room ?? {};
    const me = client.view?.me ?? {};
    const c = room.board?.[i];
    if (!c) return;
    if (pad.typeWord(c.word)) return;
    if (c.color !== null) return cardSheet(i);
    if (!canPin()) {
      flash(status);
      return;
    }
    buzz(12);
    act("pin", { card: me.mine === i ? null : i }, errLine).catch(() => {});
  };
  const tapPass = () => {
    const me = client.view?.me ?? {};
    if (!canPin() || !me.canPass) return flash(status);
    buzz(12);
    act("pin", { card: me.mine === "pass" ? null : "pass" }, errLine).catch(() => {});
  };
  /** The clue last seen (null: none drawn yet). @type {string | null} */
  let clueWas = null;
  refresh = () => {
    const v = client.view ?? {};
    const room = v.room ?? {};
    const me = v.me ?? {};
    const b = /** @type {BoardCard[]} */ (room.board ?? []);
    drawBand(room, me);
    const noted = new Set((/** @type {PadLine[]} */ (me.pad ?? [])).flatMap((l) => findWords(l.text, b).map((x) => x.card)));
    board.update(b, { pins: livePins(room, me), mine: me.mine, majority: me.majority, locked: me.locked, noted });
    status.textContent = opStatus(room, me);
    const guessing = room.phase === "guess" && me.active;
    const canLock = me.majority !== null && me.majority !== undefined && me.mine === me.majority && room.open && me.locked === null && guessing;
    lockBtn.hidden = !canLock;
    passBtn.hidden = !(me.canPass && guessing && me.locked === null);
    passBtn.classList.toggle("mine", me.mine === "pass");
    passBtn.classList.toggle("majority", me.majority === "pass");
    const passers = Object.keys(me.pins ?? {}).filter((id) => me.pins[id] === "pass");
    const tags = initials(Object.keys(me.pins ?? {}));
    /** @type {HTMLElement} */ (passBtn.lastElementChild).replaceChildren(...passers.map((id) => h("b", { class: id === myId() ? "me" : "" }, tags.get(id) ?? "?")));
    actions.classList.toggle("can-lock", canLock);
    pad.update(room, me);
    // The clue arrives: a buzz.
    const clue = me.clue ? `${room.round}:${me.clue.word}` : "";
    if (clue && clueWas !== null && clue !== clueWas) buzz([40, 60, 40]);
    clueWas = clue;
    checkFlip(room, me);
  };

  /** @param {any} room @param {any} me */
  function drawBand(room, me) {
    const team = isTeam(me.team) ? me.team : "red";
    teamTag.replaceChildren(h("span", {}, t.team(team)), h("small", {}, spy ? t.spymaster : nameOf(myId())));
    if (me.clue) {
      clueBox.replaceChildren(h("span", { class: "cw", "data-fit": "1" }, me.clue.word, h("i", {}, " · "), t.n(me.clue.number)));
      clueBox.classList.remove("wait");
      const max = me.clue.number + 1;
      progress.textContent = room.phase === "clue" || room.phase === "intro" ? "" : me.active ? t.progress(me.turned ?? 0, max) : me.turned ? t.progressDone(me.turned) : "";
    } else {
      const spyId = room.teams?.[team]?.spymaster;
      const text = room.phase === "intro" ? t.intro : room.phase === "clue" ? (spy ? t.yourClue : t.thinking(nameOf(spyId))) : t.stop["no-clue"];
      clueBox.replaceChildren(h("span", { class: "cw small", "data-fit": "2" }, text));
      clueBox.classList.add("wait");
      progress.textContent = "";
    }
    clueBox.disabled = !(me.history ?? []).length;
  }
}

/**
 * The team's pins while they mean something: once its clue is in, until
 * it stops for the round (left over after, they would only confuse).
 * @param {any} room @param {any} me
 * @returns {Record<string, Choice>}
 */
function livePins(room, me) {
  const live = room.phase === "guess" ? me.active : room.phase === "clue" && !!me.clue;
  return live ? (me.pins ?? {}) : {};
}

/** Makes a status line blink (a tap that does nothing now). @param {HTMLElement} el */
function flash(el) {
  el.classList.remove("flash");
  void el.offsetWidth;
  el.classList.add("flash");
}

/** What an operative's team does now. @param {any} room @param {any} me */
function opStatus(room, me) {
  const otherTeam = isTeam(me.team) ? other(me.team) : "blue";
  const otherGuessing = ["guessing", "locked"].includes(room.teams?.[otherTeam]?.status);
  switch (room.phase) {
    case "intro":
      return t.youGuess;
    case "clue":
      return me.clue ? t.clueIn : t.clueWait;
    case "round":
      return t.roundOver;
    case "guess": {
      if (!me.active) return [me.stop ? t.stop[/** @type {keyof typeof t.stop} */ (me.stop)] : "", otherGuessing ? t.stillGuessing(otherTeam) : ""].filter(Boolean).join(" ");
      if (me.locked !== null) return me.locked === "pass" ? t.lockedPass : t.locked;
      if (!room.open) return t.turning;
      const board = room.board ?? [];
      const what = (/** @type {Choice} */ c) => (c === "pass" ? t.passWord : (board[c]?.word ?? "").toUpperCase());
      if (me.majority !== null && me.majority !== undefined) return me.mine === me.majority ? t.lockIt : t.agree(what(me.majority));
      if (me.mine === null || me.mine === undefined) return t.pinHint;
      const voters = (me.voters ?? []).length;
      const need = Math.floor(voters / 2) + 1;
      const have = Object.values(me.pins ?? {}).filter((c) => c === me.mine).length;
      return `${what(me.mine)}: ${t.pinMore(have, need)}`;
    }
    default:
      return "";
  }
}

/** What a spymaster's team does now. @param {any} room @param {any} me */
function spyStatus(room, me) {
  const otherTeam = isTeam(me.team) ? other(me.team) : "blue";
  const otherGuessing = ["guessing", "locked"].includes(room.teams?.[otherTeam]?.status);
  switch (room.phase) {
    case "round":
      return t.roundOver;
    case "guess":
      // No clue: the box below says why.
      if (!me.active) return [me.stop && me.stop !== "no-clue" ? t.stop[/** @type {keyof typeof t.stop} */ (me.stop)] : "", otherGuessing ? t.stillGuessing(otherTeam) : ""].filter(Boolean).join(" ");
      if (me.locked !== null) return me.locked === "pass" ? t.lockedPass : t.locked;
      return room.open ? t.spyPins : t.turning;
    default:
      return "";
  }
}

/** The spymaster's part below the board: the clue form, then the clue sent. */
function makeSpyBox() {
  const err = h("p", { class: "error" });
  const input = /** @type {HTMLInputElement} */ (h("input", { id: "clue", maxlength: CLUE_MAX, autocapitalize: "off", autocorrect: "off", spellcheck: "false", enterkeyhint: "send", autocomplete: "off", placeholder: t.cluePlaceholder }));
  /** @type {number | null} */
  let number = null;
  const nums = Array.from({ length: 9 }, (_, i) => /** @type {HTMLButtonElement} */ (h("button", { type: "button", onclick: () => pick(i + 1) }, t.n(i + 1))));
  const send = /** @type {HTMLButtonElement} */ (h("button", { type: "submit", class: "btn send" }, t.send));
  let sending = false;
  const form = h(
    "form",
    {
      class: "clueform",
      autocomplete: "off",
      onsubmit: async (/** @type {Event} */ e) => {
        e.preventDefault();
        const word = input.value.trim();
        if (!word || number === null || sending) {
          if (!word) input.focus();
          return;
        }
        sending = true;
        sync();
        try {
          await act("clue", { word, number }, err);
          buzz(40);
          input.blur();
          saveDraft({ clue: null });
        } catch {
          // The refusal says why; the field stays as it was.
          input.focus();
        } finally {
          sending = false;
          sync();
        }
      },
    },
    h("div", { class: "cluerow" }, input, send),
    h("label", { class: "numlabel" }, t.howMany),
    h("div", { class: "numbers" }, ...nums),
    err,
  );
  const sent = h("div", { class: "sent" });
  const el = h("div", { class: "spybox" }, form, sent);
  const round = () => Number(client.view?.room?.round ?? 0);
  const keep = () => saveDraft({ clue: { round: round(), word: input.value, number } });
  /** @param {number} n */
  const pick = (n) => {
    number = n;
    buzz(8);
    keep();
    sync();
  };
  const sync = () => {
    nums.forEach((b, i) => b.classList.toggle("on", number === i + 1));
    send.disabled = sending || !input.value.trim() || number === null;
  };
  input.addEventListener("input", () => {
    err.textContent = "";
    keep();
    sync();
  });
  let roundWas = -1;
  /** @param {any} room @param {any} me */
  const update = (room, me) => {
    if (room.round !== roundWas) {
      roundWas = room.round;
      const d = draft().clue;
      input.value = d && d.round === room.round ? d.word : "";
      number = d && d.round === room.round ? d.number : null;
      err.textContent = "";
      sync();
      requestAnimationFrame(() => fitField(input));
    }
    const asking = room.phase === "clue" && !me.clue;
    form.hidden = !asking;
    if (!asking && document.activeElement === input) input.blur();
    const team = isTeam(me.team) ? me.team : "red";
    const ot = other(team);
    if (me.clue && room.phase === "clue") {
      sent.hidden = false;
      const otherLine = room.phase === "clue" ? (room.teams?.[ot]?.status === "ready" ? t.otherReady(ot) : t.otherThinking(ot)) : "";
      sent.replaceChildren(h("small", {}, t.sentTitle), h("p", { class: "sentclue", "data-fit": "1" }, me.clue.word, h("i", {}, " · "), t.n(me.clue.number)), otherLine ? h("p", { class: "muted small" }, otherLine) : "");
    } else if (!me.clue && (room.phase === "guess" || room.phase === "round")) {
      sent.hidden = false;
      sent.replaceChildren(h("p", { class: "muted" }, t.noClueSent));
    } else {
      sent.hidden = true;
      sent.replaceChildren();
    }
  };
  return { el, update };
}

// ---------------------------------------------------------------------------
// The pad: the team's lines.

function makePad() {
  const list = h("ol", { class: "lines" });
  const count = h("span", { class: "count" });
  const err = h("p", { class: "error" });
  const add = /** @type {HTMLTextAreaElement} */ (h("textarea", { rows: 1, maxlength: PAD_CHARS, enterkeyhint: "send", autocomplete: "off", autocapitalize: "sentences", placeholder: t.padPlaceholder, "aria-label": t.padPlaceholder }));
  const addBtn = /** @type {HTMLButtonElement} */ (h("button", { type: "submit", class: "addbtn", "aria-label": t.add }, icon(PLUS)));
  const tapHint = h("p", { class: "taphint" }, t.padTapCard);
  const form = h("form", { class: "padadd", onsubmit: (/** @type {Event} */ e) => (e.preventDefault(), submitAdd()) }, add, addBtn);
  const el = h("section", { class: "pad" }, h("div", { class: "padhead" }, h("h2", {}, t.pad), count), list, err, tapHint, form);
  /** The line I edit: its id and field. @type {{ id: number, ta: HTMLTextAreaElement, li: HTMLElement, was: string } | null} */
  let editing = null;
  let drawn = "";
  let adding = false;

  // Keep the button from taking the focus (the keyboard stays).
  addBtn.addEventListener("pointerdown", (e) => e.preventDefault());
  add.addEventListener("input", () => {
    err.textContent = "";
    grow(add);
    saveDraft({ add: add.value });
  });
  add.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      submitAdd();
    }
  });
  async function submitAdd() {
    const text = add.value.trim();
    if (!text || adding) return;
    adding = true;
    try {
      await act("pad", { op: "add", text }, err);
      add.value = "";
      grow(add);
      saveDraft({ add: "" });
      requestAnimationFrame(() => (list.scrollTop = list.scrollHeight));
    } catch {
      // The text stays.
    } finally {
      adding = false;
    }
  }

  /** @param {PadLine} line @param {string} [text] */
  function startEdit(line, text) {
    const ta = /** @type {HTMLTextAreaElement} */ (h("textarea", { rows: 1, maxlength: PAD_CHARS, enterkeyhint: "done", autocomplete: "off", autocapitalize: "sentences" }));
    ta.value = text ?? line.text;
    const btn = (/** @type {string} */ cls, /** @type {string} */ d, /** @type {string} */ label, /** @type {() => void} */ fn) => {
      const b = h("button", { type: "button", class: cls, "aria-label": label, title: label, onclick: fn }, icon(d));
      b.addEventListener("pointerdown", (e) => e.preventDefault());
      return b;
    };
    const li = h(
      "li",
      { class: "editing" },
      ta,
      h("div", { class: "edbtns" }, btn("del", TRASH, t.remove, () => finish("delete")), btn("no", CROSS, t.cancel, () => finish("cancel")), btn("ok", CHECK, t.save, () => finish("save"))),
    );
    const ed = { id: line.id, ta, li, was: line.text };
    editing = ed;
    saveDraft({ edit: { id: line.id, text: ta.value } });
    ta.addEventListener("input", () => {
      err.textContent = "";
      showEditing();
      saveDraft({ edit: { id: line.id, text: ta.value } });
    });
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        finish("save");
      }
    });
    // Done with the keyboard: saved (or let go, unchanged).
    ta.addEventListener("blur", () =>
      setTimeout(() => {
        if (editing === ed && ta.isConnected && document.activeElement !== ta) finish(ta.value.trim() === ed.was ? "cancel" : "save");
      }, 120),
    );
    return ed;
  }

  /** @param {"save" | "cancel" | "delete"} op */
  async function finish(op) {
    const ed = editing;
    if (!ed) return;
    editing = null;
    saveDraft({ edit: null });
    drawn = "";
    try {
      if (op === "save") await act("pad", { op, id: ed.id, text: ed.ta.value.trim() }, err);
      else await act("pad", { op, id: ed.id }, err);
    } catch {
      // Refused (moderation, gone): the text stays on the phone for another try.
      if (op === "save") {
        editing = ed;
        saveDraft({ edit: { id: ed.id, text: ed.ta.value } });
      }
    }
    draw();
  }

  /** @param {PadLine} line */
  async function tapLine(line) {
    if (editing) return;
    const me = client.view?.me ?? {};
    if (line.edit && line.edit !== myId()) return;
    if (!me.pad) return;
    const ed = startEdit(line);
    drawn = "";
    draw();
    ed.ta.focus();
    const len = ed.ta.value.length;
    ed.ta.setSelectionRange(len, len);
    try {
      await act("pad", { op: "edit", id: line.id }, err);
    } catch {
      if (editing === ed) {
        editing = null;
        saveDraft({ edit: null });
        drawn = "";
        draw();
      }
    }
  }

  /** The line being edited, in sight (the keyboard came up, the field grew). */
  function showEditing() {
    if (!editing) return;
    grow(editing.ta);
    const l = list.getBoundingClientRect();
    const r = editing.li.getBoundingClientRect();
    if (r.bottom > l.bottom) list.scrollTop += r.bottom - l.bottom + 4;
    else if (r.top < l.top) list.scrollTop -= l.top - r.top + 4;
  }
  const ro = new ResizeObserver(() => showEditing());
  ro.observe(list);
  cleanups.push(() => ro.disconnect());

  let restored = false;
  function draw() {
    const v = client.view ?? {};
    const room = v.room ?? {};
    const me = v.me ?? {};
    const board = /** @type {BoardCard[]} */ (room.board ?? []);
    const lines = /** @type {PadLine[]} */ (me.pad ?? []);
    // After a reload: the line I was editing, with what I had typed.
    if (!restored && board.length) {
      restored = true;
      const d = draft();
      add.value = d.add ?? "";
      const line = d.edit ? lines.find((l) => l.id === d.edit?.id) : undefined;
      if (line && d.edit && (!line.edit || line.edit === myId())) {
        startEdit(line, d.edit.text);
        if (line.edit !== myId()) act("pad", { op: "edit", id: line.id }).catch(() => finish("cancel"));
      }
      requestAnimationFrame(() => grow(add));
    }
    if (editing && !lines.some((l) => l.id === editing?.id)) {
      editing = null;
      saveDraft({ edit: null });
    }
    const colors = board.map((c) => c.color).join(",");
    const key = JSON.stringify([lines, colors, editing?.id ?? null, lang]);
    count.textContent = `${t.n(lines.length)}/${t.n(PAD_LINES)}`;
    // One field at a time: while a line is edited, the new line's field steps aside.
    form.hidden = !!editing || (lines.length >= PAD_LINES && !add.value);
    if (key === drawn) return;
    drawn = key;
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 30;
    const colorOf = (/** @type {number} */ i) => board[i]?.color ?? null;
    const kids = lines.map((line) => {
      if (editing && editing.id === line.id) return editing.li;
      const busy = !!line.edit && line.edit !== myId();
      return h(
        "li",
        { class: busy ? "busy" : "", onclick: () => tapLine(line) },
        h("span", { class: "tx" }, marked(line.text, board, colorOf)),
        h("small", {}, busy ? t.writing(nameOf(line.edit)) : line.name),
      );
    });
    if (!lines.length) kids.push(h("li", { class: "empty" }, t.padEmpty));
    // The line being edited stays where it is: moved, its field would lose the keyboard.
    for (const c of [...list.children]) if (!kids.includes(/** @type {HTMLElement} */ (c))) c.remove();
    let ref = list.firstChild;
    for (const k of kids) {
      if (k === ref) ref = ref.nextSibling;
      else list.insertBefore(k, ref);
    }
    if (editing) requestAnimationFrame(showEditing);
    if (nearBottom) list.scrollTop = list.scrollHeight;
  }

  /**
   * While a field of the pad has the keyboard, a tapped card types its word there.
   * @param {string} word
   * @returns {boolean} whether it did
   */
  function typeWord(word) {
    const a = document.activeElement;
    if (!(a instanceof HTMLTextAreaElement) || !el.contains(a)) return false;
    const s = a.selectionStart ?? a.value.length;
    const e = a.selectionEnd ?? s;
    const before = a.value.slice(0, s);
    const after = a.value.slice(e);
    const ins = `${before && !/\s$/.test(before) ? " " : ""}${word}${after && /^\s/.test(after) ? "" : " "}`;
    if (before.length + ins.length + after.length > PAD_CHARS) {
      flash(tapHint);
      return true;
    }
    a.value = before + ins + after;
    const at = before.length + ins.length;
    a.setSelectionRange(at, at);
    a.dispatchEvent(new Event("input", { bubbles: true }));
    buzz(8);
    return true;
  }

  /** @param {any} _room @param {any} _me */
  const update = (_room, _me) => draw();
  return { el, update, typeWord };
}

// ---------------------------------------------------------------------------
// The end: who won, the key, the clues, the pads; and the next game.

function end() {
  const v = client.view ?? {};
  const room = v.room ?? {};
  const me = v.me ?? {};
  const board = /** @type {BoardCard[]} */ (room.board ?? []);
  const reveal = room.reveal ?? { key: [], clues: { red: [], blue: [] }, pads: { red: [], blue: [] }, spymasters: { red: null, blue: null } };
  const keyColor = (/** @type {number} */ i) => /** @type {Color | null} */ (reveal.key?.[i] ?? null);
  const winner = isTeam(room.winner) ? room.winner : null;
  const mine = isTeam(me.team) ? me.team : null;
  const result = h(
    "section",
    { class: `panel pop result ${winner ?? "none"}` },
    h("h1", { "data-fit": "1" }, winner ? t.wins(winner) : room.reason === "too-few" ? t.over : t.draw),
    h("p", { class: "reason" }, room.reason ? t.reason(room.reason, winner) : ""),
    winner && mine && room.reason !== "too-few" ? h("p", { class: "mine" }, winner === mine ? t.youWon : t.youLost) : null,
  );
  const keyBoard = makeBoard("end", { press: cardSheet });
  keyBoard.update(board, { key: board.map((_, i) => keyColor(i)) });
  const keyPanel = h("section", { class: "panel" }, h("h2", { class: "first" }, t.theKey), keyBoard.el, h("p", { class: "muted small" }, t.keyNote));
  const cluesPanel = h(
    "section",
    { class: "panel" },
    h("h2", { class: "first" }, t.theClues),
    ...TEAMS.map((tm) =>
      h(
        "div",
        { class: `teamblock ${tm}` },
        h("h3", {}, t.team(tm), reveal.spymasters?.[tm] ? h("small", {}, t.spymasterWas(nameOf(reveal.spymasters[tm]))) : null),
        (reveal.clues?.[tm] ?? []).length ? clueList(reveal.clues[tm], board, keyColor) : h("p", { class: "muted small" }, t.noClues),
      ),
    ),
  );
  const padsPanel = h(
    "section",
    { class: "panel" },
    h("h2", { class: "first" }, t.thePads),
    ...TEAMS.map((tm) => {
      const lines = /** @type {{ text: string, name: string }[]} */ (reveal.pads?.[tm] ?? []);
      return h(
        "div",
        { class: `teamblock ${tm}` },
        h("h3", {}, t.team(tm)),
        lines.length ? h("ul", { class: "padlines" }, ...lines.map((l) => h("li", {}, h("span", { class: "tx" }, marked(l.text, board, keyColor)), h("small", {}, l.name)))) : h("p", { class: "muted small" }, t.emptyPad),
      );
    }),
  );
  const next = teamsPanel(true);
  show(result, keyPanel, cluesPanel, padsPanel, next.el);
  refresh = next.update;
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
  show(logo(), h("section", { class: "panel" }, h("p", { class: "big" }, t.scanToJoin)));
} else if (client.canResume) {
  client.connect().then(wake, (e) => joinForm(e?.code === "no-player" ? "" : message(e)));
} else {
  joinForm();
}
