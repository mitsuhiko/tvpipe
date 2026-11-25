// @ts-check
/**
 * Classes' phone page: your exercise book (docs/classes-design.md §6.6).
 * Joining, the lobby with the class list and the VIP's settings, the
 * alphabet frieze (the drawer stops it), the timetable, writing an
 * answer per subject before the bell, grading a subject at a time
 * (doubt, a gold star, Wikipedia on the TV), the marks, the round's
 * points and at the end your report card. Everything it shows comes
 * from the party's view (`{ roster, room, me }`, §7.1/§7.2); everything
 * it does is an action (§7.4). Text players typed is always set with
 * `textContent`.
 */

import { blockEmoji, PartyClient } from "/_tvpipe/lib/client.js";
import { fitInput, watchFit } from "./fit.js";
import { browserLang, LANGS, locale, pickLang } from "./i18n.js";
import { ALPHABET, cover, hand, litLetter, subjectColors } from "./school.js";
import { strings } from "./strings.js";

/** The longest answer (§3.3). */
const MAX_ANSWER = 40;
/** Drafts go out this long after the last key (§3.3). */
const DRAFT_DELAY = 400;

// A controller, not a document: no pinch or double-tap zoom, no selection outside fields.
for (const type of ["gesturestart", "gesturechange", "gestureend"]) document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
document.addEventListener("touchmove", (e) => e.touches.length > 1 && e.preventDefault(), { passive: false });
document.addEventListener("dblclick", (e) => e.preventDefault(), { passive: false });
document.addEventListener("selectstart", (e) => {
  const tg = e.target instanceof Element ? e.target : /** @type {Node} */ (e.target).parentElement;
  if (!tg?.closest("input, textarea, .reader")) e.preventDefault();
});

const client = PartyClient.fromLocation();
// No emoji in names or answers (the host drops them too).
blockEmoji();
const app = /** @type {HTMLElement} */ (document.getElementById("app"));
const bar = /** @type {HTMLElement} */ (document.getElementById("bar"));
const banner = /** @type {HTMLElement} */ (document.getElementById("banner"));
const who = /** @type {HTMLElement} */ (document.getElementById("who"));
const sub = /** @type {HTMLElement} */ (document.getElementById("sub"));
const stamp = /** @type {HTMLElement} */ (document.getElementById("stamp"));
const sheet = /** @type {HTMLElement} */ (document.getElementById("sheet"));

// The header's height, for what sticks below it.
new ResizeObserver(() => document.documentElement.style.setProperty("--barh", `${bar.offsetHeight}px`)).observe(bar);

// ---------------------------------------------------------------------------
// The keyboard. Nothing sticks to the bottom of the page (Stop! and Done
// are in the sticky strip at the top), and the field being typed in is
// kept in sight: above the keyboard and below the sticky strip. iOS Safari
// does not shrink the layout viewport for the keyboard, it pans a smaller
// visual viewport over it; so what is visible is measured with
// `window.visualViewport`. While a field has focus (`body.typing`) the
// page gets room below its last field (so the page scrolls rather than
// the viewport panning), the sticky bars follow a panned viewport
// (`--vvtop`), and the Wikipedia overlay is laid over the visual viewport.

/** A field the keyboard types into. @param {unknown} el @returns {el is HTMLInputElement | HTMLTextAreaElement} */
const isField = (el) => (el instanceof HTMLInputElement && !["button", "submit", "checkbox", "radio"].includes(el.type)) || el instanceof HTMLTextAreaElement;

/** The part of the page the player sees, in client coordinates: the visual viewport. */
function visibleBox() {
  const vv = window.visualViewport;
  return vv ? { top: vv.offsetTop, bottom: vv.offsetTop + vv.height } : { top: 0, bottom: window.innerHeight };
}

/**
 * Scrolls the page so the field (with its line: the column's title when
 * there is room) is below the sticky bars at the top and above the
 * keyboard: inside the visual viewport.
 * @param {HTMLElement} field
 */
function keepVisible(field) {
  if (!field.isConnected || field.closest("#sheet")) return;
  const box = visibleBox();
  let top = box.top;
  let bottom = box.bottom;
  for (const el of document.querySelectorAll("#bar, .strip")) {
    const r = el.getBoundingClientRect();
    if (r.height > 0 && r.top <= top + 1) top = Math.max(top, r.bottom);
  }
  const room = bottom - top - 16;
  const line = /** @type {HTMLElement} */ (field.closest(".line") ?? field);
  const want = line.getBoundingClientRect().height <= room ? line : field;
  const r = want.getBoundingClientRect();
  const f = field.getBoundingClientRect();
  let dy = 0;
  if (f.bottom > bottom - 8) dy = Math.max(f.bottom - bottom + 8, Math.min(r.bottom - bottom + 8, r.top - top - 8));
  else if (r.top < top + 8 && r.bottom - r.top <= room) dy = r.top - top - 8;
  else if (f.top < top + 8) dy = f.top - top - 8;
  if (Math.abs(dy) >= 1) window.scrollBy({ top: dy, behavior: "instant" });
}

/** The Wikipedia overlay covers what is visible: the visual viewport. */
function fitSheet() {
  const vv = window.visualViewport;
  if (!vv || sheet.hidden) return;
  sheet.style.top = `${vv.offsetTop}px`;
  sheet.style.height = `${vv.height}px`;
  sheet.style.bottom = "auto";
}

let typing = false;
/** @param {boolean} on */
function setTyping(on) {
  if (on === typing) return;
  typing = on;
  document.body.classList.toggle("typing", on);
  if (!on) document.documentElement.style.setProperty("--vvtop", "0px");
}
/** @type {ReturnType<typeof setTimeout> | undefined} */
let settle;
/** Keeps the focused field in sight now and once the keyboard has settled. */
function followFocus() {
  const el = document.activeElement;
  if (!isField(el)) return;
  keepVisible(el);
  clearTimeout(settle);
  settle = setTimeout(() => document.activeElement === el && keepVisible(el), 350);
}
document.addEventListener("focusin", (e) => {
  if (!isField(e.target)) return;
  setTyping(true);
  requestAnimationFrame(followFocus);
});
// Moving from field to field (Enter) blurs one before the next has focus.
document.addEventListener("focusout", () => requestAnimationFrame(() => setTyping(isField(document.activeElement))));
let vvQueued = false;
const onViewport = () => {
  if (vvQueued) return;
  vvQueued = true;
  requestAnimationFrame(() => {
    vvQueued = false;
    // Where iOS panned the visual viewport down over the page, the sticky bars follow it.
    const top = typing ? Math.max(0, Math.round(window.visualViewport?.offsetTop ?? 0)) : 0;
    document.documentElement.style.setProperty("--vvtop", `${top}px`);
    // What is visible (iOS Safari's toolbars, not the keyboard: one-screen layouts never type).
    if (!typing) document.documentElement.style.setProperty("--vvh", `${Math.round(window.visualViewport?.height ?? window.innerHeight)}px`);
    fitSheet();
    if (isField(document.activeElement)) keepVisible(document.activeElement);
  });
};
window.visualViewport?.addEventListener("resize", onViewport);
window.visualViewport?.addEventListener("scroll", onViewport);
window.addEventListener("resize", onViewport);
onViewport();

// ---------------------------------------------------------------------------
// The language: the room's, the same on every phone (the host page or the
// VIP sets it); before joining, the browser's.

function roomLang() {
  const l = client.view?.room?.lang;
  return typeof l === "string" ? pickLang(l) : browserLang();
}
let lang = roomLang();
let t = strings(lang);
document.documentElement.lang = locale(lang);
function useLang() {
  const l = roomLang();
  if (l === lang) return false;
  lang = l;
  t = strings(l);
  document.documentElement.lang = locale(l);
  return true;
}

let shown = "";
/** @type {(() => void)[]} called on every view while the screen stays */
let refreshers = [];
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
/** @param {string | null} text @param {boolean} [red] */
function setBanner(text, red = true) {
  banner.hidden = !text;
  banner.classList.toggle("calm", !red);
  banner.textContent = text ?? "";
}

/** @returns {Record<string, any>} */
const room = () => client.view?.room ?? {};
/** @returns {Record<string, any>} */
const me = () => client.view?.me ?? {};
const myId = () => /** @type {string | undefined} */ (client.you?.id);
/** @returns {any[]} */
const roster = () => client.view?.roster ?? [];
const isVip = () => !!roster().find((r) => r.id === myId())?.vip;
/** How many it takes to start: the view's `minPlayers` (before it arrives, the game's least: 2). */
const minPlayers = () => (typeof room().minPlayers === "number" ? room().minPlayers : 2);

/** A name: the room's people (also away ones), else the roster. @param {string} id */
function nameOf(id) {
  const p = room().people?.[id];
  if (p && typeof p.name === "string") return p.name;
  return roster().find((r) => r.id === id)?.name ?? "?";
}
/** A player's handwriting, as the style of an element (`--hand`, `--hs`). @param {string | undefined} id */
function handStyle(id) {
  const p = id ? room().people?.[id] : null;
  const hd = hand(p?.hand);
  return { "--hand": `"${hd.family}"`, "--hs": String(hd.scale) };
}

/** A short buzz, where phones do that (once the player has touched the page: browsers refuse it before). @param {number | number[]} ms */
function buzz(ms) {
  try {
    if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
    navigator.vibrate?.(ms);
  } catch {}
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

/** Sends an action; a refusal shows in `err`. @param {string} type @param {any} data @param {HTMLElement} [err] */
async function act(type, data, err) {
  if (err) err.textContent = "";
  try {
    return await client.act(type, data);
  } catch (e) {
    if (err) err.textContent = message(e);
    throw e;
  }
}

/** Runs `fn` every quarter second while the screen stays. @param {() => void} fn */
function every(fn) {
  fn();
  const timer = setInterval(fn, 250);
  cleanups.push(() => clearInterval(timer));
}

/**
 * The wall clock: the time left to `deadline()` on the host's clock
 * (`client.now()`), red for the last 10 s and when `hurry()`.
 * @param {() => number | undefined} deadline
 * @param {() => boolean} [hurry]
 */
function clock(deadline, hurry = () => false) {
  const el = h("span", { class: "clock" });
  every(() => {
    const d = deadline();
    if (typeof d !== "number") {
      el.textContent = "";
      return;
    }
    const left = Math.max(0, d - client.now());
    const s = Math.ceil(left / 1000);
    el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    el.classList.toggle("low", left <= 10_000 || hurry());
  });
  return el;
}

/** A subject's tab: its cover colour and name. @param {string} subject */
function tab(subject) {
  const c = subjectColors(subject);
  return h("span", { class: "tab", style: { "--tab": c.bg, "--tab-ink": c.ink } }, t.subject(subject));
}

/** The class: everyone in the roster, names in their handwriting. */
function classList() {
  const list = h("div", { class: "chips" });
  refreshers.push(() => {
    list.replaceChildren(
      ...roster().map((r) =>
        h(
          "span",
          { class: `chip${r.connected ? "" : " away"}${r.id === myId() ? " me" : ""}` },
          h("span", { class: "hand", style: handStyle(r.id) }, r.name),
          r.vip ? h("small", {}, t.vip) : null,
          r.connected ? null : h("small", { class: "muted" }, t.away),
        ),
      ),
    );
  });
  return list;
}

// ---------------------------------------------------------------------------
// The exercise book's cover: your name on the label, the round, the
// letter stamped in the corner.

function updateBar() {
  const r = room();
  const id = myId();
  const p = id ? r.people?.[id] : null;
  document.body.style.setProperty("--cover", cover(p?.hand ?? (id ? roster().findIndex((x) => x.id === id) : 0)));
  who.textContent = id ? nameOf(id) : "";
  for (const [k, v] of Object.entries(handStyle(id))) who.style.setProperty(k, v);
  const playing = r.phase && r.phase !== "lobby" && r.phase !== "final" && typeof r.round === "number" && r.rounds;
  sub.textContent = playing ? t.roundOf(r.round, r.rounds) : t.exercise;
  const showLetter = typeof r.letter === "string" && ["letter", "board", "write", "bell", "grade", "report"].includes(r.phase);
  stamp.hidden = !showLetter;
  if (showLetter && stamp.textContent !== r.letter) stamp.textContent = r.letter;
}

// ---------------------------------------------------------------------------
// Joining

/** @param {string} [error] @param {string} [typed] */
function joinForm(error = "", typed) {
  shown = "join";
  refreshers = [];
  updateBar();
  const input = /** @type {HTMLInputElement} */ (h("input", { id: "name", maxlength: 16, autocapitalize: "words", autocorrect: "off", spellcheck: "false", enterkeyhint: "go", autocomplete: "off", required: true }));
  const err = h("p", { class: "error" }, error);
  input.value = typed ?? client.carried?.name ?? localStorage.getItem("classes:name") ?? "";
  const form = h(
    "form",
    {
      autocomplete: "off",
      onsubmit: async (/** @type {Event} */ e) => {
        e.preventDefault();
        const name = input.value.trim();
        if (!name) return;
        try {
          localStorage.setItem("classes:name", name);
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
    h("p", { class: "muted small" }, t.rejoinHint),
  );
  show(logo(), h("section", { class: "card pop" }, h("h1", {}, t.joinTitle), h("p", { class: "lead" }, t.joinLead), form));
  if (!input.value) input.focus();
}

function logo() {
  return h("div", { class: "logo" }, h("span", { class: "chalk" }, "Classes"), h("span", { class: "abc" }, "A B C"));
}

client.on("status", (st) => {
  if (st === "reconnecting") setBanner(t.reconnecting);
  else if (st === "open") setBanner(null);
});
client.on("bye", (reason) => {
  const text = reason === "kicked" ? t.kicked : reason === "replaced" ? t.replaced : reason === "room-closed" ? t.roomClosed : null;
  if (!text) return;
  shown = "bye";
  refreshers = [];
  for (const c of cleanups) c();
  cleanups = [];
  setBanner(null);
  closeReader();
  show(logo(), h("section", { class: "card" }, h("p", { class: "big" }, text)));
});
client.on("view", () => render());

// ---------------------------------------------------------------------------
// Views

/** Which screen the view asks for: a new key builds it anew, the same one only refreshes it. */
function keyOf() {
  const m = me();
  const r = room();
  const round = r.round ?? 0;
  if (m.task === "wait" || m.task === "watch") return `${m.task}:${round}`;
  switch (r.phase) {
    case "lobby":
      return "lobby";
    case "letter":
      return `letter:${round}:${isDrawer() ? 1 : 0}`;
    case "board":
    case "write":
    case "bell":
    case "report":
      return `${r.phase}:${round}`;
    case "grade":
      return `grade:${round}:${r.col ?? 0}:${r.stage ?? ""}`;
    case "final":
      return `final:${Array.isArray(r.cards) ? 1 : 0}`;
    default:
      return `other:${r.phase ?? ""}:${m.task ?? ""}`;
  }
}

/** The drawer: `room.drawer` is this phone's player (§7.2: `task` "draw" goes only to them). */
const isDrawer = () => !!myId() && room().drawer === myId();

function render() {
  if (!client.view?.me && !client.view?.room) return;
  if (useLang()) shown = "";
  updateBar();
  const key = keyOf();
  if (key !== shown) {
    shown = key;
    refreshers = [];
    for (const c of cleanups) c();
    cleanups = [];
    build();
    window.scrollTo({ top: 0 });
  }
  for (const f of refreshers) f();
  readerRefresh();
}

function build() {
  const m = me();
  const r = room();
  if (m.task === "wait") return waiting(t.waitRound, t.waitHint);
  if (m.task === "watch") return waiting(t.watchRound, t.watchHint);
  switch (r.phase) {
    case "lobby":
      return lobby();
    case "letter":
      return letter();
    case "board":
      return board();
    case "write":
      return write();
    case "bell":
      return bell();
    case "grade":
      return r.stage === "marked" ? marked() : vote();
    case "report":
      return report();
    case "final":
      return final();
    default:
      return show(h("section", { class: "card" }, h("p", { class: "big" }, t.lookTv)));
  }
}

/** Latecomers and players not in this round. @param {string} title @param {string} hint */
function waiting(title, hint) {
  show(h("section", { class: "card pop center" }, h("div", { class: "chalkboard small" }, h("span", { class: "chalk" }, "Classes")), h("p", { class: "big" }, title), h("p", { class: "muted" }, hint)), h("section", { class: "card" }, h("h2", {}, t.classList), classList()));
}

// ---------------------------------------------------------------------------
// Lobby and final: the class, the VIP's settings (§2), Start.

/** The VIP's settings: every key of §2, the same choices as the host page. @param {HTMLElement} err */
function settings(err) {
  /** @type {{ key: string, buttons: HTMLButtonElement[], values: any[], line: HTMLElement | null, lines: Record<string, string> | null, names: string[] }[]} */
  const items = [];
  const box = h("div", { class: "settings" }, h("h2", {}, t.settings));
  /** The current value of a setting (`lang` is the room's). @param {string} key */
  const current = (key) => (key === "lang" ? room().lang : room().settings?.[key]);
  /** @param {string} key @param {any[]} values @param {string[]} names the values' keys in the strings */
  const add = (key, values, names) => {
    const s = /** @type {any} */ (t.set)[key];
    const buttons = values.map((v, i) => /** @type {HTMLButtonElement} */ (h("button", { type: "button", "data-key": key, onclick: () => act("settings", { [key]: v }, err).catch(() => {}) })));
    const line = s.lines ? h("p", { class: "line" }) : null;
    box.append(h("div", { class: "setting" }, h("label", {}, s.label), h("div", { class: "seg" }, ...buttons), line));
    items.push({ key, buttons, values, line, lines: s.lines ?? null, names });
  };
  const langs = /** @type {string[]} */ (Array.isArray(room().langs) && room().langs.length ? room().langs : [...LANGS]);
  add("lang", langs, langs);
  add("rounds", [3, 4, 5, 6], ["3", "4", "5", "6"]);
  add("columns", [6, 8, 10], ["6", "8", "10"]);
  add("time", [90, 120, 180, 300], ["90", "120", "180", "300"]);
  add("mix", ["school", "mixed", "silly"], ["school", "mixed", "silly"]);
  add("content", ["family", "party"], ["family", "party"]);
  add("stop", [true, false], ["on", "off"]);
  add("classic", [true, false], ["on", "off"]);
  add("letters", ["common", "all"], ["common", "all"]);
  add("late", ["open", "wait", "closed"], ["open", "wait", "closed"]);
  const update = () => {
    box.hidden = !isVip();
    for (const it of items) {
      const s = /** @type {any} */ (t.set)[it.key];
      const cur = current(it.key);
      // The value's name: "on"/"off" for the booleans.
      const curName = cur === true ? "on" : cur === false ? "off" : String(cur);
      it.buttons.forEach((b, i) => {
        const name = it.names[i] ?? "";
        b.textContent = it.key === "lang" ? strings(pickLang(name)).langName : it.key === "time" ? t.seconds(Number(name)) : (s.choices[name] ?? name);
        b.classList.toggle("on", name === curName);
      });
      if (it.line && it.lines) {
        it.line.textContent = it.lines[curName] ?? "";
        it.line.hidden = !it.line.textContent;
      }
    }
  };
  return { box, update };
}

function lobby() {
  const err = h("p", { class: "error" });
  const hint = h("p", { class: "muted small center-text" });
  const start = /** @type {HTMLButtonElement} */ (h("button", { class: "btn", id: "start", "data-act": "start", type: "button", onclick: () => act("start", {}, err).catch(() => {}) }, t.start));
  const set = settings(err);
  show(
    // The VIP's Start before the class list: in sight without scrolling with ten in the class.
    h("section", { class: "card pop" }, h("h1", {}, t.youreIn), start, hint, err, h("h2", {}, t.classList), classList(), set.box),
    h("section", { class: "card plain" }, h("h2", {}, t.howTitle), h("ol", { class: "how" }, ...t.how.map((x) => h("li", {}, x)))),
  );
  refreshers.push(() => {
    const vip = isVip();
    const min = minPlayers();
    const ready = roster().filter((r) => r.connected).length;
    start.hidden = !vip;
    start.disabled = ready < min;
    hint.textContent = vip ? (ready < min ? t.vipWait(min - ready) : t.vipReady) : t.waitVip;
    set.update();
  });
}

// ---------------------------------------------------------------------------
// The letter: the frieze, the drawer's Stop! (§3.1)

function letter() {
  const drawer = isDrawer();
  const err = h("p", { class: "error" });
  /** @type {Map<string, HTMLElement>} */
  const tiles = new Map();
  for (const l of ALPHABET) tiles.set(l, h("span", { class: "tile" }, l));
  const frieze = h("div", { class: "frieze" }, ...tiles.values());
  const big = h("div", { class: "bigletter" });
  const title = h("h1", { class: "center-text", "data-fit": "2" });
  const hint = h("p", { class: "muted center-text" });
  /** What the drawer saw when they pressed: kept until the host's letter comes. @type {string | null} */
  let frozen = null;
  const stop = /** @type {HTMLButtonElement} */ (
    h(
      "button",
      {
        class: "btn huge",
        "data-act": "stop-letter",
        type: "button",
        onclick: () => {
          if (frozen || room().letter) return;
          frozen = litLetter(room().run, client.now());
          buzz(40);
          stop.disabled = true;
          act("stop-letter", {}, err).catch(() => {
            frozen = null;
            stop.disabled = false;
          });
        },
      },
      t.stopLetter,
    )
  );
  stop.hidden = !drawer;
  /** @type {string | null} */
  let lit = null;
  let raf = 0;
  const frame = () => {
    const r = room();
    const chosen = typeof r.letter === "string" ? r.letter : null;
    const now = chosen ?? frozen ?? litLetter(r.run, client.now());
    if (now !== lit) {
      lit = now;
      const seq = new Set(Array.isArray(r.run?.seq) ? r.run.seq : []);
      const used = new Set(Array.isArray(r.used) ? r.used : []);
      for (const [l, el] of tiles) {
        el.classList.toggle("lit", l === now && !chosen);
        el.classList.toggle("used", used.has(l) && l !== chosen);
        el.classList.toggle("out", !seq.has(l) && !used.has(l) && l !== chosen);
        el.classList.toggle("chosen", l === chosen);
      }
      big.textContent = now ?? "";
      big.classList.toggle("chosen", !!chosen);
    }
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  cleanups.push(() => cancelAnimationFrame(raf));
  refreshers.push(() => {
    const r = room();
    const chosen = typeof r.letter === "string";
    title.textContent = chosen ? t.theLetter : drawer ? t.drawerTitle : t.stopsAlphabet(nameOf(r.drawer ?? ""));
    hint.textContent = chosen ? t.penReady : drawer ? t.drawerHint : t.stopsHint;
    stop.hidden = !drawer || chosen;
    if (chosen && drawer) buzz(30);
  });
  if (drawer) buzz([30, 60, 30]);
  // One screen, no scrolling: the frieze compact, the letter as big as there is room, Stop! always on screen.
  document.body.classList.add("onescreen");
  cleanups.push(() => document.body.classList.remove("onescreen"));
  show(h("section", { class: "card pop letterscreen" }, title, frieze, h("div", { class: "bigbox" }, big), stop, err, hint));
}

// ---------------------------------------------------------------------------
// The board: today's timetable (§3.2)

function board() {
  const r = room();
  const cols = /** @type {any[]} */ (r.columns ?? []);
  show(
    h(
      "section",
      { class: "card pop" },
      h("div", { class: "chalkboard" }, h("span", { class: "chalk letter" }, r.letter ?? "")),
      h("h2", {}, t.timetable),
      h("ol", { class: "timetable" }, ...cols.map((c, i) => h("li", { style: { "--d": `${i * 0.25}s` } }, tab(c.subject), h("span", { class: "ttl", "data-fit": "2" }, c.text ?? "")))),
      h("p", { class: "muted center-text" }, t.penReady),
    ),
  );
}

// ---------------------------------------------------------------------------
// Writing (§3.3): a field per column on a ruled line, drafts to the host as
// you type, the clock, the ✋ Stop! button, locked at the bell.

function write() {
  const r = room();
  const L = typeof r.letter === "string" ? r.letter : "";
  const cols = /** @type {any[]} */ (r.columns ?? []);
  const err = h("p", { class: "error" });
  const server = /** @type {string[]} */ (me().answers ?? []);
  /** What the host has (as far as this phone knows), per column. */
  const sent = cols.map((_, i) => (typeof server[i] === "string" ? server[i] : ""));
  /** Drafts on their way, per column. */
  const inflight = cols.map(() => 0);
  /** @type {(ReturnType<typeof setTimeout> | undefined)[]} */
  const timers = cols.map(() => undefined);
  let locked = false;
  let flushed = false;
  const mine = handStyle(myId());

  /** @param {number} i */
  const send = (i) => {
    clearTimeout(timers[i]);
    timers[i] = undefined;
    const input = inputs[i];
    if (!input || (locked && flushed)) return;
    const text = input.value;
    if (text === sent[i]) return;
    sent[i] = text;
    inflight[i] = (inflight[i] ?? 0) + 1;
    act("draft", { i, text })
      .then((reply) => {
        // The host's cleaned text: shown once this phone is no longer typing there.
        const clean = reply && typeof reply.text === "string" ? reply.text : null;
        if (clean === null || clean === text || input.value !== text || document.activeElement === input) return;
        input.value = clean;
        sent[i] = clean;
        fitInput(input);
      })
      .catch((e) => {
        if (e?.code !== "too-late") err.textContent = message(e);
      })
      .finally(() => (inflight[i] = (inflight[i] ?? 1) - 1));
  };
  const flush = () => cols.forEach((_, i) => send(i));

  const inputs = cols.map((c, i) => {
    const last = i === cols.length - 1;
    const input = /** @type {HTMLInputElement} */ (
      h("input", {
        type: "text",
        name: `classes-${r.round}-${i}`,
        maxlength: MAX_ANSWER,
        autocapitalize: "sentences",
        autocorrect: "off",
        autocomplete: "off",
        spellcheck: "false",
        enterkeyhint: last ? "done" : "next",
        "aria-label": c.text ?? "",
        style: mine,
      })
    );
    input.value = sent[i] ?? "";
    input.addEventListener("input", () => {
      fitInput(input);
      clearTimeout(timers[i]);
      timers[i] = setTimeout(() => send(i), DRAFT_DELAY);
      count();
    });
    input.addEventListener("blur", () => send(i));
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      send(i);
      const next = inputs[i + 1];
      if (next) next.focus();
      else input.blur();
    });
    return input;
  });

  const rows = cols.map((c, i) => {
    const rule = typeof c.rule === "string" ? t.rules[c.rule]?.(L) : null;
    return h(
      "div",
      { class: "line" },
      h("div", { class: "head" }, tab(c.subject), rule ? h("span", { class: "rule" }, rule) : null),
      h("label", { class: "ttl", "data-fit": "2", for: `f${i}` }, c.text ?? ""),
      h("div", { class: "ruled" }, h("span", { class: "margin", "aria-hidden": "true" }, L), inputs[i] ?? null),
    );
  });
  inputs.forEach((x, i) => (x.id = `f${i}`));

  const filled = h("span", { class: "filled" });
  const count = () => {
    const k = inputs.filter((x) => x.value.trim()).length;
    filled.textContent = t.filled(k, cols.length);
    updateStop();
  };
  // ✋ Stop! lives in the sticky strip, beside the clock: reachable without
  // scrolling, never over a field; it takes the place of "10 of 10 written"
  // (it only shows when every field is filled).
  const stopBtn = /** @type {HTMLButtonElement} */ (
    h(
      "button",
      {
        class: "stopbtn",
        type: "button",
        "data-act": "stop",
        title: t.stopHint,
        // A tap keeps the keyboard's field focused (no jump while it is pressed).
        onpointerdown: (/** @type {Event} */ e) => e.preventDefault(),
        onclick: () => {
          flush();
          buzz(40);
          stopBtn.disabled = true;
          act("stop", {}, err).catch(() => (stopBtn.disabled = false));
        },
      },
      h("b", {}, t.stopHand),
      h("small", {}, t.stopShort),
    )
  );
  const stopNote = h("div", { class: "stopnote" });
  const strip = h("div", { class: "strip" }, filled, stopBtn, clock(() => room().deadline, () => !!room().stopBy), stopNote);
  /** Stop! only when every field is filled now (this phone's text, not only the host's last draft). */
  function updateStop() {
    const m = me();
    const rr = room();
    const now = client.now();
    const can = !locked && !!m.filled && !!m.canStop && !rr.stopBy && (typeof rr.deadline !== "number" || now < rr.deadline) && inputs.every((x) => x.value.trim() !== "");
    stopBtn.hidden = !can;
    filled.hidden = can;
  }
  count();

  every(() => {
    const d = room().deadline;
    if (typeof d !== "number") return;
    const now = client.now();
    // What there is goes in just before the bell; at the bell the pen is down.
    if (!flushed && now >= d - 400) {
      flush();
      flushed = true;
    }
    if (!locked && now >= d) {
      locked = true;
      for (const x of inputs) {
        x.disabled = true;
        x.blur();
      }
      updateStop();
    }
  });
  refreshers.push(() => {
    const m = me();
    const rr = room();
    // A reload or another phone: the host's drafts, unless this phone is typing there.
    const answers = /** @type {string[]} */ (m.answers ?? []);
    inputs.forEach((x, i) => {
      const a = answers[i];
      if (typeof a !== "string" || a === x.value || document.activeElement === x || inflight[i] || timers[i] !== undefined) return;
      x.value = a;
      sent[i] = a;
      fitInput(x);
    });
    count();
    stopNote.textContent = rr.stopBy ? (rr.stopBy === myId() ? t.youStopped : t.stoppedBy(nameOf(rr.stopBy))) : "";
    stopNote.hidden = !rr.stopBy;
  });
  cleanups.push(flush);
  show(h("section", { class: "book pop" }, strip, err, ...rows));
  // Typed text fits its field: again whenever a field's width changes (a
  // resize, the phone turned, the layout settling) and when the fonts arrive.
  const refit = new ResizeObserver((entries) => {
    for (const e of entries) fitInput(/** @type {HTMLInputElement} */ (e.target));
  });
  for (const x of inputs) refit.observe(x);
  cleanups.push(() => refit.disconnect());
  requestAnimationFrame(() => inputs.forEach(fitInput));
  document.fonts?.ready.then(() => inputs.forEach(fitInput));
  const fontsIn = () => inputs.forEach(fitInput);
  document.fonts?.addEventListener("loadingdone", fontsIn);
  cleanups.push(() => document.fonts?.removeEventListener("loadingdone", fontsIn));
  buzz(30);
}

// ---------------------------------------------------------------------------
// The bell (§3.3)

function bell() {
  const answers = /** @type {string[]} */ (me().answers ?? []);
  const n = (room().columns ?? []).length;
  const k = answers.filter((a) => typeof a === "string" && a.trim()).length;
  buzz([80, 40, 80, 40, 80]);
  show(h("section", { class: "card pop center" }, h("div", { class: "bell", "aria-hidden": "true" }, "🔔"), h("h1", { class: "chalk-title" }, t.pensDown), h("p", {}, t.handedIn), n ? h("p", { class: "muted" }, t.handedInN(k, n)) : null));
}

// ---------------------------------------------------------------------------
// Grading (§3.4): the column's answers as cards.

/** The column being graded, its title and its place. */
function gradeHead() {
  const r = room();
  const cols = /** @type {any[]} */ (r.columns ?? []);
  const c = cols[r.col ?? 0] ?? {};
  const L = typeof r.letter === "string" ? r.letter : "";
  const rule = typeof c.rule === "string" ? t.rules[c.rule]?.(L) : null;
  return {
    c,
    L,
    title: h("div", { class: "gtitle" }, h("span", { class: "ttl", "data-fit": "2" }, c.text ?? ""), rule ? h("span", { class: "rule" }, rule) : null),
    place: h("span", { class: "filled" }, t.colOf((r.col ?? 0) + 1, cols.length)),
  };
}

/**
 * An answer's lines: the text in its writer's hand, the names in the
 * margin (yours marked); a group joined by the red bracket.
 * @param {any} a
 */
function answerLines(a) {
  const ids = /** @type {string[]} */ (Array.isArray(a.who) ? a.who : []);
  const texts = /** @type {string[]} */ (Array.isArray(a.texts) ? a.texts : []);
  const one = new Set(texts).size <= 1;
  /** @param {string} id */
  const nm = (id) => h("span", { class: `nm${id === myId() ? " me" : ""}` }, id === myId() ? `${nameOf(id)} (${t.you})` : nameOf(id));
  /** An empty answer has no line of text: its reason says it. @param {string} text @param {string | undefined} id */
  const txt = (text, id) => (text ? h("span", { class: "txt", "data-fit": "2", style: handStyle(id) }, text) : a.auto === "empty" ? null : h("span", { class: "txt nothing" }, t.empty));
  if (one) return h("div", { class: "lines" }, txt(texts[0] ?? "", ids[0]), h("div", { class: "names" }, ...ids.map(nm)));
  return h("div", { class: "lines" }, ...ids.map((id, k) => h("div", { class: "wl" }, txt(texts[k] ?? "", id), h("div", { class: "names" }, nm(id)))));
}

/** The reasons an answer is joined or struck (and `more`).
 * @param {any} a @param {string} L @param {...(Node | null)} more */
function answerNotes(a, L, ...more) {
  const notes = [
    a.same && Array.isArray(a.who) && a.who.length > 1 ? h("span", { class: "same" }, t.same[a.same] ?? a.same) : null,
    a.auto ? h("span", { class: "reason" }, t.auto[a.auto]?.(L) ?? a.auto) : null,
    ...more,
  ].filter((x) => x !== null);
  return notes.length ? h("div", { class: "notes" }, ...notes) : null;
}

function vote() {
  const head = gradeHead();
  const answers = /** @type {any[]} */ (room().answers ?? []);
  const err = h("p", { class: "error" });
  /** This phone's choices until the view has them. */
  /** @type {Map<string, boolean>} */
  const doubtOv = new Map();
  /** @type {{ v: string | null } | null} */
  let starOv = null;
  /** @type {boolean | null} */
  let doneOv = null;
  const late = () => typeof room().deadline === "number" && client.now() >= room().deadline;
  const doubts = () => new Set(/** @type {string[]} */ (me().doubts ?? []));
  const starNow = () => (starOv ? starOv.v : (me().star ?? null));

  const cards = answers.map((a) => {
    const own = Array.isArray(a.who) && a.who.includes(myId());
    const auto = !!a.auto;
    const doubtB = /** @type {HTMLButtonElement} */ (
      h(
        "button",
        {
          class: "act doubt",
          "data-fit": "1",
          type: "button",
          onclick: () => {
            const on = !(doubtOv.get(a.id) ?? doubts().has(a.id));
            doubtOv.set(a.id, on);
            buzz(10);
            draw();
            act("doubt", { id: a.id, on }, err)
              .catch(() => {})
              .finally(() => {
                doubtOv.delete(a.id);
                draw();
              });
          },
        },
        t.doubt,
      )
    );
    const starB = /** @type {HTMLButtonElement} */ (
      h(
        "button",
        {
          class: "act star",
          "data-fit": "1",
          type: "button",
          onclick: () => {
            const v = starNow() === a.id ? null : a.id;
            const ov = { v };
            starOv = ov;
            buzz(10);
            draw();
            act("star", { id: v }, err)
              .catch(() => {})
              .finally(() => {
                if (starOv === ov) starOv = null;
                draw();
              });
          },
        },
        t.star,
      )
    );
    const wikiB = /** @type {HTMLButtonElement} */ (
      h(
        "button",
        {
          class: "act wiki",
          type: "button",
          onclick: () => {
            hiddenFor = "";
            buzz(10);
            act("wiki", { id: a.id }, err).catch(() => {});
          },
        },
        own || a.auto === "empty" ? t.wiki : "📖",
      )
    );
    wikiB.title = wikiB.ariaLabel = "Wikipedia";
    const el = h(
      "div",
      { class: `answer${own ? " mine" : ""}${auto ? " auto" : ""}${Array.isArray(a.who) && a.who.length > 1 ? " group" : ""}` },
      answerLines(a),
      answerNotes(a, head.L),
      h("div", { class: "acts" }, own || auto ? null : doubtB, own || a.auto === "empty" ? null : starB, a.auto === "empty" ? null : wikiB),
    );
    return { a, el, own, auto, doubtB, starB, wikiB };
  });

  // "I'm done" lives in the sticky strip beside the clock: reachable without scrolling, over nothing.
  const doneLabel = h("b", { "data-fit": "1" }, t.done);
  const doneCount = h("small", {});
  const doneB = /** @type {HTMLButtonElement} */ (
    h(
      "button",
      {
        class: "donebtn",
        type: "button",
        "data-act": "done",
        onclick: () => {
          const done = !(doneOv ?? !!me().done);
          doneOv = done;
          buzz(20);
          draw();
          act("done", { done }, err)
            .catch(() => {})
            .finally(() => {
              doneOv = null;
              draw();
            });
        },
      },
      doneLabel,
      doneCount,
    )
  );
  // Two in the round (every player has an answer per column): one doubt strikes (§3.4).
  const writers = new Set(answers.flatMap((a) => (Array.isArray(a.who) ? a.who : [])));
  const pair = writers.size === 2 && !!myId() && writers.has(myId()) && answers.some((a) => !a.auto && Array.isArray(a.who) && !a.who.includes(myId()));
  const lookups = h("p", { class: "muted small lookups" });
  const pill = /** @type {HTMLButtonElement} */ (h("button", { class: "pill", type: "button", onclick: () => ((hiddenFor = ""), readerRefresh()) }));

  const draw = () => {
    const ds = doubts();
    const star = starNow();
    const tooLate = late();
    const left = me().lookups;
    for (const c of cards) {
      const on = doubtOv.get(c.a.id) ?? ds.has(c.a.id);
      c.doubtB.classList.toggle("on", on);
      c.el.classList.toggle("doubted", on);
      c.starB.classList.toggle("on", star === c.a.id);
      c.el.classList.toggle("starred", star === c.a.id);
      c.doubtB.disabled = c.starB.disabled = tooLate;
      c.wikiB.disabled = tooLate || left === 0;
    }
    const done = doneOv ?? !!me().done;
    doneLabel.textContent = done ? t.undone : t.done;
    doneB.classList.toggle("on", done);
    doneB.disabled = tooLate;
    const r = room();
    const players = Object.keys(r.people ?? {}).length;
    const k = Array.isArray(r.done) ? r.done.length : 0;
    doneCount.textContent = players ? t.doneCount(k, Math.max(k, players)) : "";
    lookups.textContent = typeof left === "number" ? t.lookupsLeft(left) : "";
    lookups.hidden = !lookups.textContent;
    const w = r.wiki;
    pill.hidden = !w || !sheet.hidden;
    if (w) pill.textContent = `📖 ${w.title || w.query || ""} · ${t.wikiOpen}`;
  };
  every(draw);
  refreshers.push(draw);
  show(
    h(
      "section",
      { class: "book pop" },
      h("div", { class: "strip" }, doneB, clock(() => room().deadline)),
      err,
      h("div", { class: "ghead" }, tab(head.c.subject ?? ""), head.place),
      head.title,
      h("p", { class: "muted small" }, t.gradeHint),
      pair ? h("p", { class: "pairhint" }, t.pairHint) : null,
      pill,
      lookups,
      h("div", { class: "answers" }, ...cards.map((c) => c.el)),
    ),
  );
  buzz(30);
}

function marked() {
  const head = gradeHead();
  const answers = /** @type {any[]} */ (room().answers ?? []);
  const marks = new Map(/** @type {any[]} */ (room().marks ?? []).map((x) => [x.id, x]));
  const earned = me().earned;
  const cards = answers.map((a) => {
    const mk = marks.get(a.id);
    const struck = !!a.auto || !!mk?.struck;
    const own = Array.isArray(a.who) && a.who.includes(myId());
    const verdict = a.auto
      ? null
      : mk?.struck
        ? h("span", { class: "reason" }, t.struckBy(mk.doubts ?? 0, mk.of ?? 0))
        : h("span", { class: "tick" }, mk && mk.doubts > 0 ? `${t.counts} (${t.struckBy(mk.doubts, mk.of ?? 0)})` : t.counts);
    return h(
      "div",
      { class: `answer marked${own ? " mine" : ""}${struck ? " struck" : ""}${Array.isArray(a.who) && a.who.length > 1 ? " group" : ""}` },
      h("span", { class: `points p${mk?.points ?? 0}` }, String(mk?.points ?? 0)),
      answerLines(a),
      answerNotes(a, head.L, verdict),
      mk?.stars > 0 ? h("span", { class: "stars", title: t.starsN(mk.stars) }, "★".repeat(Math.min(mk.stars, 9)), mk.stars > 9 ? `×${mk.stars}` : "") : null,
    );
  });
  show(
    h(
      "section",
      { class: "book pop" },
      h("div", { class: "strip" }, tab(head.c.subject ?? ""), head.place, typeof earned === "number" ? h("span", { class: `earned${earned > 0 ? "" : " none"}` }, t.earned(earned)) : null),
      head.title,
      h("div", { class: "answers" }, ...cards),
    ),
  );
  if (typeof earned === "number" && earned > 0) buzz([20, 40, 20]);
}

// ---------------------------------------------------------------------------
// Wikipedia's reader view (§3.5): an overlay over the vote, which stays.
// The article as the host turned it into blocks (§7.1: built with DOM
// calls and `textContent`, never HTML); links follow (`wiki-go`), Back,
// a search field, the other results, the trail. Whoever navigated last
// drives: their phone reports the block at the top of its screen
// (`wiki-at`) and the TV follows it; everyone else scrolls freely.

/** The entry this phone put aside ("Back to grading"): round, column, answer. */
let hiddenFor = "";
/** The reader while it is open, else null. @type {ReturnType<typeof openReader> | null} */
let reader = null;

/** Which entry: the round's column and the answer it was opened for. @param {any} w */
const wikiKey = (w) => `${room().round}:${room().col}:${w.id}`;

function closeReader() {
  reader?.close();
  reader = null;
  sheet.hidden = true;
  sheet.replaceChildren();
  document.body.classList.remove("reading");
}

/** Only Wikimedia's pictures (§3.5: upload. or thumb.wikimedia.org). @param {unknown} src */
const safeImage = (src) => typeof src === "string" && (src.startsWith("https://upload.wikimedia.org/") || src.startsWith("https://thumb.wikimedia.org/"));
/** Only links to a Wikipedia article. @param {unknown} url */
const safeUrl = (url) => typeof url === "string" && /^https:\/\/[a-z-]+\.(m\.)?wikipedia\.org\//.test(url);

/** The most `wiki-at` a second (§7.4: at most 4). */
const AT_EVERY = 260;

function readerRefresh() {
  const r = room();
  const w = r.phase === "grade" && r.stage === "vote" ? r.wiki : null;
  if (!w || hiddenFor === wikiKey(w)) {
    if (reader) closeReader();
    return;
  }
  if (reader && reader.lang !== lang) closeReader();
  reader ??= openReader();
  reader.update(w);
}

/**
 * One inline run (§7.1 `Inline`): text, bold, italic, a link to follow.
 * @param {any} run
 * @param {(title: string) => void} follow
 * @returns {Node}
 */
function inline(run, follow) {
  if (typeof run === "string") return document.createTextNode(run);
  if (!run || typeof run.s !== "string") return document.createTextNode("");
  /** @type {Node} */
  let node = document.createTextNode(run.s);
  if (run.i) node = h("i", {}, node);
  if (run.b) node = h("b", {}, node);
  if (typeof run.a === "string" && run.a) {
    const title = run.a;
    node = h(
      "a",
      {
        class: "wl",
        href: "#",
        "data-wiki": "link",
        title,
        onclick: (/** @type {Event} */ e) => {
          e.preventDefault();
          follow(title);
        },
      },
      node,
    );
  }
  return node;
}

/**
 * The article's blocks (§7.1 `Block`): paragraphs, headings, list items
 * (depth, ordered numbers), quotes. Each has its index in `data-block`.
 * @param {any[]} blocks
 * @param {(title: string) => void} follow
 */
function blockNodes(blocks, follow) {
  return blocks.map((b, i) => {
    const runs = (Array.isArray(b?.c) ? b.c : []).map((/** @type {any} */ x) => inline(x, follow));
    /** @type {HTMLElement} */
    let el;
    switch (b?.t) {
      case "h2":
        el = h("h2", { class: "wh2" }, ...runs);
        break;
      case "h3":
        el = h("h3", { class: "wh3" }, ...runs);
        break;
      case "li": {
        const d = Math.max(1, Math.min(3, Number(b.d) || 1));
        el = h("div", { class: `wli d${d}` }, h("span", { class: "mark", "aria-hidden": "true" }, typeof b.n === "number" ? `${b.n}.` : d === 1 ? "•" : d === 2 ? "◦" : "▪"), h("span", {}, ...runs));
        break;
      }
      case "quote":
        el = h("blockquote", {}, ...runs);
        break;
      default:
        el = h("p", { class: "wp" }, ...runs);
    }
    el.dataset["block"] = String(i);
    return el;
  });
}

function openReader() {
  const myLang = lang;
  const err = h("p", { class: "error", role: "status" });
  /** A wiki action: its refusal as a friendly line. @param {string} type @param {any} data */
  const go = (type, data) => {
    err.textContent = "";
    act(type, data, err).catch(() => {});
  };
  /** This phone navigated: the next article starts at its top. */
  let navigated = false;
  const follow = (/** @type {string} */ title) => {
    navigated = true;
    buzz(10);
    go("wiki-go", { title });
  };
  /** ✕ and "Back to grading": the driver (who opened or navigated last) closes it for everyone, the TV too; anyone else only puts it aside. */
  const hide = () => {
    const w = room().wiki;
    if (w) hiddenFor = wikiKey(w);
    if (w && w.by === myId()) act("wiki-close", {}, err).catch(() => {});
    closeReader();
    render();
  };

  const closeAll = /** @type {HTMLButtonElement} */ (h("button", { class: "btn small", type: "button", "data-wiki": "close", onclick: () => go("wiki-close", {}) }, t.wikiClose));
  const backB = /** @type {HTMLButtonElement} */ (h("button", { class: "wback", type: "button", "data-wiki": "back", onclick: () => ((navigated = true), go("wiki-back", {})) }, t.wikiPrev));
  const q = /** @type {HTMLInputElement} */ (h("input", { type: "search", "data-wiki": "search", maxlength: 200, enterkeyhint: "search", autocapitalize: "sentences", autocorrect: "off", autocomplete: "off", spellcheck: "false", placeholder: t.wikiFind, "aria-label": t.wikiSearch }));
  const search = h(
    "form",
    {
      class: "wsearch",
      onsubmit: (/** @type {Event} */ e) => {
        e.preventDefault();
        const text = q.value.trim();
        if (!text) return;
        navigated = true;
        q.blur();
        err.textContent = "";
        act("wiki-go", { q: text }, err)
          .then(() => (q.value = ""))
          .catch(() => {});
      },
    },
    q,
    h("button", { type: "submit", "aria-label": t.wikiSearch }, "🔍"),
  );
  const trail = h("div", { class: "trail" });
  const by = h("p", { class: "by" });
  const looking = h("div", { class: "looking" }, h("span", { class: "spin", "aria-hidden": "true" }), t.looking);
  const article = h("article", { class: "warticle" });
  const others = h("div", { class: "others" });
  const left = h("p", { class: "left" });
  const foot = h("p", { class: "credit foot" });
  const panel = h(
    "div",
    { class: "reader" },
    h(
      "div",
      { class: "rhead" },
      h("div", { class: "rtop" }, h("span", { class: "wlogo" }, "W"), h("span", { class: "credit" }, t.wikiCredit), h("button", { class: "x", type: "button", "data-wiki": "hide", "aria-label": t.wikiBack, onclick: hide }, "✕")),
      h("div", { class: "rtools" }, backB, search),
      err,
    ),
    trail,
    by,
    looking,
    article,
    others,
    left,
    foot,
    h("div", { class: "row" }, h("button", { class: "btn ghost small", type: "button", "data-wiki": "hide", onclick: hide }, t.wikiBack), closeAll),
  );
  sheet.replaceChildren(panel);
  sheet.hidden = false;
  fitSheet();
  document.body.classList.add("reading");

  // The driver's position: the first block whose bottom is below the top
  // of the reading area (under the sticky bar), sent on change, ≤ 4 a second.
  let lastAt = 0;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let atTimer;
  let atLast = 0;
  const topBlock = () => {
    const top = panel.getBoundingClientRect().top + (panel.querySelector(".rhead")?.getBoundingClientRect().height ?? 0) + 4;
    for (const el of article.querySelectorAll("[data-block]")) {
      if (el.getBoundingClientRect().bottom > top) return Number(/** @type {HTMLElement} */ (el).dataset["block"]) || 0;
    }
    return 0;
  };
  const reportAt = () => {
    atTimer = undefined;
    const w = room().wiki;
    if (!w || w.by !== myId() || w.loading || w.error || !Array.isArray(w.blocks)) return;
    const at = topBlock();
    if (at === lastAt) return;
    lastAt = at;
    atLast = Date.now();
    client.act("wiki-at", { block: at }).catch(() => {});
  };
  const onScroll = () => {
    if (atTimer !== undefined) return;
    atTimer = setTimeout(reportAt, Math.max(0, AT_EVERY - (Date.now() - atLast)));
  };
  panel.addEventListener("scroll", onScroll, { passive: true });

  let articleKey = "";
  let restKey = "";
  /** @param {any} w */
  const update = (w) => {
    // The driver's ✕ closes it for everyone already: "Close for everyone" is for the others.
    closeAll.hidden = w.by === myId();
    const name = nameOf(w.by ?? "");
    by.textContent = w.loading ? t.wikiLooking(name, String(w.query ?? "")) : w.error ? "" : t.wikiReads(name, String(w.title ?? w.query ?? ""));
    by.hidden = !by.textContent;
    backB.hidden = !w.back;
    panel.classList.toggle("loading", !!w.loading);
    const hasArticle = !w.error && Array.isArray(w.blocks);
    looking.hidden = !w.loading;
    looking.classList.toggle("over", !!w.loading && hasArticle);
    // The article: rebuilt only when it is another one (a Back brings the old blocks again).
    const ak = JSON.stringify([myLang, w.error ?? "", w.title ?? "", w.url ?? "", w.blocks?.length ?? -1, w.blocks?.[0] ?? null, w.cut ?? false, w.image ?? ""]);
    if (ak !== articleKey && !(w.loading && articleKey)) {
      const first = articleKey === "";
      articleKey = ak;
      lastAt = 0;
      if (w.error) {
        article.replaceChildren(h("p", { class: "wiki-error" }, w.error === "offline" ? t.wikiOffline : t.wikiNone(String(w.query ?? ""))));
      } else if (hasArticle) {
        const url = safeUrl(w.url) ? w.url : null;
        article.replaceChildren(
          ...[
            h("h1", { class: "wtitle" }, w.title ?? ""),
            w.description ? h("p", { class: "desc" }, w.description) : null,
            w.disambiguation ? h("p", { class: "disamb" }, t.wikiDisamb) : null,
            safeImage(w.image) ? h("figure", {}, h("img", { src: w.image, alt: "", referrerpolicy: "no-referrer", onerror: (/** @type {Event} */ e) => /** @type {HTMLElement} */ (e.target).parentElement?.remove() })) : null,
            ...blockNodes(w.blocks, follow),
            w.cut && url ? h("p", { class: "cut" }, "… ", h("a", { href: url, target: "_blank", rel: "noopener noreferrer" }, t.wikiWhole)) : null,
          ].filter((x) => x !== null),
        );
      } else article.replaceChildren();
      // A new article starts at its top (on every phone: the old place means nothing there).
      if (!first || navigated) panel.scrollTop = 0;
      navigated = false;
    }
    // The trail, the other results, what is left: small, redrawn on change.
    const results = /** @type {any[]} */ (Array.isArray(w.results) ? w.results : []);
    const lookups = me().lookups;
    const rk = JSON.stringify([w.trail, results.map((x) => x.title), w.pick, w.loading, lookups, w.title, w.url]);
    if (rk !== restKey) {
      restKey = rk;
      const steps = /** @type {string[]} */ (Array.isArray(w.trail) ? w.trail : []);
      trail.hidden = steps.length < 2;
      trail.replaceChildren(...steps.flatMap((s, i) => [i ? h("span", { class: "sep", "aria-hidden": "true" }, "›") : null, h("span", { class: i === steps.length - 1 ? "cur" : "" }, s)]).filter((x) => x !== null));
      others.hidden = results.length < 2 && !(results.length === 1 && w.pick !== 0);
      others.replaceChildren(
        h("h2", {}, t.wikiOthers),
        ...results.map((x, i) =>
          h(
            "button",
            { type: "button", class: i === w.pick ? "on" : "", disabled: (i === w.pick && !w.error) || !!w.loading || lookups === 0, onclick: () => ((navigated = true), go("wiki", { id: w.id, pick: i })) },
            h("b", {}, x.title ?? ""),
            x.snippet ? h("span", {}, x.snippet) : null,
          ),
        ),
      );
      left.textContent = typeof lookups === "number" ? t.lookupsLeft(lookups) : "";
      foot.textContent = `${t.wikiCredit}${w.title ? ` · ${w.title}` : ""}`;
    }
  };
  return {
    lang: myLang,
    update,
    close() {
      clearTimeout(atTimer);
      panel.removeEventListener("scroll", onScroll);
    },
  };
}

// ---------------------------------------------------------------------------
// The report after a round (§3.6)

/** The class's grade list, yours marked. */
function scoreList() {
  const scores = /** @type {any[]} */ (room().scores ?? []).slice().sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
  return h(
    "ol",
    { class: "scores" },
    ...scores.map((s) =>
      h(
        "li",
        { class: s.id === myId() ? "me" : "" },
        h("span", { class: "rk" }, String(s.rank ?? "")),
        h("span", { class: "nm hand", "data-fit": "1", style: handStyle(s.id) }, nameOf(s.id)),
        h("span", { class: "plus" }, `+${t.n(s.round ?? 0)}`),
        h("b", {}, t.n(s.total ?? 0)),
      ),
    ),
  );
}

function report() {
  const m = me();
  const r = room();
  const of = Array.isArray(r.scores) ? r.scores.length : 0;
  const mine = /** @type {any[]} */ (r.scores ?? []).find((s) => s.id === myId());
  const earned = m.earned ?? mine?.round ?? 0;
  const total = m.total ?? mine?.total ?? 0;
  const rank = m.rank ?? mine?.rank;
  show(
    h(
      "section",
      { class: "card pop center" },
      h("h1", { "data-fit": "2" }, t.roundGraded(r.round ?? 1)),
      h("p", { class: "muted" }, t.thisRound),
      h("p", { class: "score red-pen" }, `+${t.n(earned)}`),
      mine?.twenties > 0 ? h("p", { class: "twenties red-pen" }, t.twenties(mine.twenties)) : null,
      h("p", { class: "total" }, `${t.total}: ${t.n(total)} ${t.points}`),
      rank && of ? h("p", { class: "muted" }, t.rank(rank, of)) : null,
    ),
    of ? h("section", { class: "card" }, scoreList()) : null,
  );
}

// ---------------------------------------------------------------------------
// The end: your report card, the best answers, another game (§3.6)

function final() {
  const m = me();
  const r = room();
  const err = h("p", { class: "error" });
  const again = /** @type {HTMLButtonElement} */ (h("button", { class: "btn", id: "start", "data-act": "start", type: "button", onclick: () => act("start", {}, err).catch(() => {}) }, t.playAgain));
  const hint = h("p", { class: "muted small center-text" });
  const set = settings(err);
  const id = myId() ?? "";
  const cards = /** @type {any[]} */ (Array.isArray(r.cards) ? r.cards : []);
  const card = cards.find((c) => c.id === id);
  const of = cards.length || (Array.isArray(r.scores) ? r.scores.length : 0);
  const best = /** @type {any[]} */ (Array.isArray(r.best) ? r.best : []);
  const reportCard = card
    ? h(
        "section",
        { class: "reportcard pop" },
        h("div", { class: "rc-head" }, h("span", { class: "rc-school" }, t.school), h("h1", {}, t.reportCard)),
        h("div", { class: "rc-name hand", "data-fit": "1", style: handStyle(id) }, nameOf(id)),
        h("h2", {}, t.grades),
        card.grades?.length
          ? h(
              "div",
              { class: "rc-grades" },
              .../** @type {any[]} */ (card.grades).map((g) => h("div", { class: "rc-row" }, tab(g.subject), h("span", { class: "dots" }), h("span", { class: "grade red-pen" }, String(g.grade ?? "")))),
            )
          : h("p", { class: "muted" }, t.noGrades),
        card.remarks?.length ? h("h2", {}, t.remarksTitle) : null,
        ...(/** @type {string[]} */ (card.remarks ?? []).map((code) => h("p", { class: "remark" }, t.remarks[code] ?? code))),
        h("div", { class: "rc-foot" }, h("span", { class: "rc-rank" }, h("span", {}, t.rank(card.rank ?? 0, of)), h("span", {}, `${t.n(card.total ?? 0)} ${t.points}`)), h("span", { class: `rc-stamp ${card.stamp === "held" ? "held" : ""}` }, t.stamps[card.stamp] ?? "")),
      )
    : h("section", { class: "card pop center" }, h("h1", {}, t.gameOver), typeof m.total === "number" ? h("p", { class: "score red-pen" }, t.n(m.total)) : null, m.rank && of ? h("p", { class: "muted" }, t.rank(m.rank, of)) : null);
  show(
    // The VIP's next game first: in sight without scrolling past the report card.
    h("div", { class: "strip againstrip" }, again, hint),
    reportCard,
    best.length
      ? h(
          "section",
          { class: "card cork" },
          h("h2", {}, t.best),
          h("div", { class: "pins" }, ...best.map((b) => h("div", { class: "index" }, h("div", { class: "itop" }, h("span", { class: "txt", "data-fit": "2", style: handStyle(b.id) }, b.text ?? ""), h("span", { class: "pin-stars" }, "★".repeat(Math.min(b.stars ?? 1, 5)))), h("span", { class: "col" }, tab(b.subject), " ", b.column ?? ""), h("span", { class: "nm" }, nameOf(b.id))))),
        )
      : null,
    h("section", { class: "card" }, err, set.box, h("h2", {}, t.classList), classList()),
  );
  refreshers.push(() => {
    const vip = isVip();
    const min = minPlayers();
    const ready = roster().filter((x) => x.connected).length;
    again.hidden = !vip;
    again.disabled = ready < min;
    hint.textContent = vip ? (ready < min ? t.vipWait(min - ready) : t.vipReady) : t.waitVip;
    set.update();
  });
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
updateBar();
// No room in the link: the page was opened without the QR code.
if (typeof client.room === "string" && (!client.room || !client.key)) {
  show(logo(), h("section", { class: "card" }, h("p", { class: "big" }, t.scanToJoin)));
} else if (client.canResume) {
  client.connect().then(wake, (e) => joinForm(e?.code === "no-player" ? "" : message(e)));
} else {
  joinForm();
}
