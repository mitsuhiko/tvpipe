// @ts-check
/**
 * Drawbluff's phone page: joining, the lobby, the drawing pad, lies,
 * votes, scores. Everything it shows comes from the party's view
 * (`{ roster, room, me }`); everything it does is an action. It speaks
 * the room's language (`room.lang`, the VIP's or the host page's), or the
 * one the player picked with the switch in the header (kept on this phone).
 */

import { blockEmoji, PartyClient } from "/_tvpipe/lib/client.js";
import { watchFit } from "./fit.js";
import { browserLang, LANGS, pickLang } from "./i18n.js";
import { Sfx } from "./sfx.js";
import { strings } from "./strings.js";
import { drawDrawing, drawStroke, FRAME_MS, framesOf, GRID, PALETTE } from "./strokes.js";

/** For all frames together (game/rules.ts). */
const MAX_STROKES = 300;
const MAX_POINTS = 12000;
/** How strongly an animation's other frame shows under the one you draw. */
const ONION = 0.28;
const WIDTHS = [8, 20, 48];
/** The longest lie the input takes (`LIE_SOFT` in game/rules.ts). */
const LIE_SOFT = 40;

// Phones are game controllers here, not documents: iOS Safari ignores
// `user-scalable=no`, so block its pinch and double-tap zoom gestures and
// text selection outside text fields by hand.
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

const client = PartyClient.fromLocation();
// No emoji in names, answers or clues (the host drops them too).
blockEmoji();
const app = /** @type {HTMLElement} */ (document.getElementById("app"));
const banner = /** @type {HTMLElement} */ (document.getElementById("banner"));
const timer = /** @type {HTMLElement} */ (document.getElementById("timer"));
const who = /** @type {HTMLElement} */ (document.getElementById("who"));
const langButton = /** @type {HTMLButtonElement} */ (document.getElementById("lang"));
const soundButton = /** @type {HTMLButtonElement} */ (document.getElementById("sound"));
const header = /** @type {HTMLElement} */ (document.querySelector("header"));

// Titles (`data-fit`) get smaller instead of cut off or broken in a word (fit.js).
watchFit();

/** A canvas to measure text with. @type {CanvasRenderingContext2D | null} */
let ruler = null;

/**
 * Keeps what is typed in a field readable whole (a long lie): when the
 * text gets longer than the field, its font gets smaller (down to `min`
 * px: 40 letters on a 320 px phone) instead of the text scrolling out of
 * sight (as Krakel's).
 * @param {HTMLInputElement} input
 * @param {number} [min]
 */
function fitField(input, min = 10) {
  input.style.fontSize = "";
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
addEventListener("resize", () => {
  for (const i of document.querySelectorAll("input")) fitField(i);
});

/**
 * A sentence with a title in it (a lie): the title never broken in a word.
 * @param {string} text
 * @param {string} title
 * @returns {(string | HTMLElement)[]}
 */
function titled(text, title) {
  const at = title ? text.indexOf(title) : -1;
  if (at < 0) return [text];
  return [text.slice(0, at), h("span", { class: "title" }, title), text.slice(at + title.length)];
}

// ---------------------------------------------------------------------------
// The language: the phone's own choice, else the room's, else the browser's.

const LANG_KEY = "drawbluff:lang";
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
  showSound();
  return true;
}

/** The switch: only where rebuilding loses nothing (joining, the lobby, the end). */
function showSwitch(on = false) {
  langButton.hidden = !on;
  langButton.textContent = t.otherLang;
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
  } else if (client.view?.me) {
    shown = "";
    render(client.view);
  } else showSwitch(true);
});

// ---------------------------------------------------------------------------
// Sound and touch: quiet cues (the TV plays the show), a buzz where the
// phone can, both off with the switch in the header (kept on this phone).

const SOUND_KEY = "drawbluff:sound";
function soundOff() {
  try {
    return localStorage.getItem(SOUND_KEY) === "off";
  } catch {
    return false;
  }
}
const sfx = new Sfx({ volume: 0.55, muted: soundOff() });
/** @param {number | number[]} pattern */
function buzz(pattern) {
  if (sfx.muted) return;
  try {
    navigator.vibrate?.(pattern);
  } catch {}
}
function showSound() {
  const on = !sfx.muted;
  soundButton.classList.toggle("off", !on);
  soundButton.setAttribute("aria-label", on ? t.soundOn : t.soundOff);
  soundButton.replaceChildren(icon(on ? SPEAKER : SPEAKER_OFF));
}
soundButton.addEventListener("click", () => {
  sfx.muted = !sfx.muted;
  try {
    if (sfx.muted) localStorage.setItem(SOUND_KEY, "off");
    else localStorage.removeItem(SOUND_KEY);
  } catch {}
  showSound();
  if (!sfx.muted) sfx.play("tap");
});
// Audio starts with a tap (browsers allow it only then); every button clicks.
document.addEventListener(
  "pointerdown",
  (e) => {
    sfx.unlock();
    const b = e.target instanceof Element ? e.target.closest("button") : null;
    if (b && !(/** @type {HTMLButtonElement} */ (b).disabled) && b !== soundButton) {
      sfx.play("tap", { pitch: b.classList.contains("primary") || b.classList.contains("done") ? 1.25 : 1 });
      buzz(8);
    }
  },
  { capture: true, passive: true },
);

/** The key of what is on screen: rebuilt only when it changes. */
let shown = "";
/** @type {(() => void) | null} called on every view while the screen stays */
let refresh = null;
/** @type {Pad | null} */
let pad = null;

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
    else if (v === true) el.setAttribute(k, "");
    else if (v !== false && v != null) el.setAttribute(k, String(v));
  }
  for (const kid of kids) if (kid) el.append(kid);
  return el;
}

/** @param {...Node} nodes */
function show(...nodes) {
  app.replaceChildren(...nodes);
}

/** @param {string | null} text */
function setBanner(text) {
  banner.hidden = !text;
  banner.textContent = text ?? "";
}

// ---------------------------------------------------------------------------
// Joining

/**
 * @param {string} [error]
 * @param {string} [typed] the name typed so far (the language switched)
 */
function joinForm(error = "", typed) {
  shown = "join";
  refresh = null;
  showSwitch(true);
  const tpl = /** @type {HTMLTemplateElement} */ (document.getElementById("t-join"));
  show(tpl.content.cloneNode(true));
  const input = /** @type {HTMLInputElement} */ (document.getElementById("name"));
  const err = /** @type {HTMLElement} */ (document.getElementById("join-error"));
  /** @type {HTMLElement} */ (app.querySelector("h1")).textContent = t.joinTitle;
  /** @type {HTMLElement} */ (app.querySelector("label")).textContent = t.yourName;
  /** @type {HTMLElement} */ (app.querySelector("#join-form button")).textContent = t.join;
  input.value = typed ?? client.saved?.name ?? localStorage.getItem("drawbluff:name") ?? "";
  err.textContent = error;
  /** @type {HTMLFormElement} */ (document.getElementById("join-form")).addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const name = input.value.trim();
    if (!name) return;
    try {
      localStorage.setItem("drawbluff:name", name);
    } catch {}
    err.textContent = "";
    try {
      await client.join(name);
    } catch (e) {
      joinForm(message(e));
    }
  });
  if (!input.value) input.focus();
}

/** @param {any} e */
function message(e) {
  const code = e?.code;
  switch (code) {
    case "name-taken":
      return t.nameTaken;
    case "name-invalid":
      return lang === "en" && e.message ? e.message : t.pickAnother;
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
      return (typeof code === "string" ? t.errors[code] : undefined) ?? e?.message ?? String(e);
  }
}

client.on("status", (s) => {
  if (s === "reconnecting") setBanner(t.reconnecting);
  else if (s === "open") setBanner(null);
});

client.on("bye", (reason) => {
  const text = reason === "kicked" ? t.kicked : reason === "replaced" ? t.replaced : reason === "room-closed" ? t.roomClosed : null;
  if (text) {
    shown = "bye";
    refresh = null;
    showSwitch(false);
    setBanner(null);
    timer.hidden = true;
    show(h("section", { class: "card" }, h("p", { class: "big" }, text)));
  }
});

client.on("view", (view) => render(view));

// ---------------------------------------------------------------------------
// Views

/** @param {Record<string, any>} view */
function render(view) {
  const me = view.me ?? {};
  const room = view.room ?? {};
  const roster = view.roster ?? [];
  const mine = roster.find((/** @type {any} */ r) => r.id === client.you?.id);
  if (useLang()) shown = "";
  const rank = typeof me.rank === "number" && typeof me.of === "number" && me.of > 0 && me.task !== "lobby" ? ` · ${t.rankShort(me.rank, me.of)}` : "";
  const dot = typeof me.color === "number" && Array.isArray(room.colors) ? room.colors[me.color] : undefined;
  if (typeof dot === "string" && /^#[0-9a-f]{6}$/i.test(dot)) document.documentElement.style.setProperty("--me", dot);
  who.replaceChildren(
    ...(mine && typeof dot === "string" ? [h("span", { class: "dot", style: `background:${dot}` })] : []),
    mine ? `${mine.vip ? "★ " : ""}${mine.name}${rank}` : "",
  );
  const key = screenKey(me, room);
  if (key !== shown) {
    showSwitch(me.task === "lobby" || me.task === "final");
    shown = key;
    refresh = null;
    pad = null;
    // The pad takes the whole screen; everything else has the header (and the clock in it).
    document.body.classList.toggle("drawing", me.task === "draw" && !me.done);
    if (timer.parentElement !== header) header.append(timer);
    build(view);
    cue(me);
  }
  refresh?.();
}

/** The task cued last (`task:key`): a cue once per task. */
let cued = "";
/**
 * A cue for a new screen: your turn (draw, lie, vote) rings and buzzes,
 * points won chime in coins.
 * @param {any} me
 */
function cue(me) {
  const key = `${me.task}:${me.key ?? ""}:${me.deadline ?? ""}:${me.note ?? ""}`;
  if (key === cued) return;
  cued = key;
  if (["draw", "lie", "vote"].includes(me.task) && !me.done) {
    sfx.play("chime", { vol: 0.8 });
    buzz([25, 60, 25]);
  } else if (me.note === "result" && me.result?.points > 0) {
    sfx.play("coin");
    sfx.play("coin", { at: 0.18, pitch: 1.12 });
    buzz([15, 40, 15, 40, 15]);
  }
}

/**
 * What is on screen: a lie or a vote stays while the room moves on (the
 * next drawing's liars write during the current vote and reveal).
 * @param {any} me
 * @param {any} room
 */
function screenKey(me, room) {
  const done = me.done ? 1 : 0;
  switch (me.task) {
    case "lie":
    case "vote":
    case "artist":
      return `${me.task}:${me.key ?? ""}:${done}`;
    case "draw":
      return `draw:${room.round ?? ""}:${me.deadline ?? ""}:${done}`;
    default:
      return `${me.task}:${room.round ?? ""}:${room.spot ?? ""}:${room.phase ?? ""}:${me.note ?? ""}`;
  }
}

/** @param {Record<string, any>} view */
function build(view) {
  const me = view.me ?? {};
  const room = view.room ?? {};
  switch (me.task) {
    case "lobby":
      return lobby(view);
    case "draw":
      return me.done ? waiting(t.drawDone) : draw(me);
    case "wait":
      return waiting(me.note === "drawing" ? t.waitDrawing : me.note === "game" ? t.waitGame : t.waitRound, colorPicker(h("p", { class: "error" })).box);
    case "artist":
      return waiting(t.artist);
    case "lie":
      return me.done ? waiting(titled(t.lieDone(me.lie ?? "", !!me.early), me.lie ?? "")) : lie(me);
    case "vote":
      return me.done ? waiting(t.voteDone) : vote(me.options ?? [], room.drawing);
    case "watch":
      return watch(me, room);
    case "scores":
      return scoreCard(t.roundDone(room.round ?? 0), me);
    case "final":
      return final(view);
    default:
      return waiting(t.lookAtTv);
  }
}

/**
 * @param {string | (string | HTMLElement)[]} text
 * @param {...Node} extra
 */
function waiting(text, ...extra) {
  show(h("section", { class: "card" }, h("p", { class: "big" }, ...(Array.isArray(text) ? text : [text])), doodle(), ...extra));
}

/** A pencil line that draws itself over and over (the card is waiting). */
function doodle() {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 100 50");
  svg.setAttribute("class", "doodle");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("pathLength", "1");
  path.setAttribute("d", "M6 34 C 14 10, 26 10, 24 30 S 40 44, 46 22 S 62 6, 64 28 S 80 42, 94 16");
  svg.append(path);
  return svg;
}

/**
 * @param {string} title
 * @param {any} me
 * @param {...(Node | string | null | undefined | false)} extra
 */
function scoreCard(title, me, ...extra) {
  show(
    h(
      "section",
      { class: "card" },
      title.startsWith("+") ? h("p", { class: "gain" }, title) : h("h1", {}, title),
      ...extra,
      h("p", { class: "score pop" }, formatNumber(me.score ?? 0)),
      h("p", { class: "muted" }, `${t.points(me.score ?? 0)} · ${me.of ? t.rank(me.rank ?? 0, me.of) : t.rankOnly(me.rank ?? 0)}`),
    ),
  );
}

/** @param {number} n */
function formatNumber(n) {
  return new Intl.NumberFormat(lang).format(n);
}

/**
 * Between tasks: what the TV shows, what happened to you.
 * @param {any} me
 * @param {any} room
 */
function watch(me, room) {
  if (me.note === "gallery") {
    return scoreCard(t.galleryTitle, me, h("p", { class: "big" }, me.mine ? t.galleryMine(me.mine) : t.galleryOthers));
  }
  if (me.note === "rest") {
    return scoreCard(t.drawingOf(me.artist?.name), me, h("p", { class: "big" }, t.notLying));
  }
  const r = me.result;
  if (me.note === "result" && r) {
    /** @type {(string | HTMLElement)[][]} */
    const lines = [];
    if (r.kind === "artist") lines.push([t.artistResult(r.count ?? 0, r.seen ?? 0)]);
    if (r.kind === "found") lines.push([t.found]);
    if (r.kind === "fooled") lines.push([r.by?.length ? t.fellFor(r.by) : t.fellForOurs]);
    if (r.lie !== undefined) lines.push(titled(t.lieFooled(r.lie, r.fooledCount ?? 0), r.lie));
    return scoreCard(
      r.points > 0 ? `+${formatNumber(r.points)}` : t.lookAtTv,
      me,
      ...lines.map((l) => h("p", { class: "big" }, ...l)),
    );
  }
  return scoreCard(t.lookAtTv, me);
}

/** Who may join during a game: the VIP's choice (`late-join`). */
const LATE_JOIN = ["wait", "open", "closed"];

/**
 * Latecomers: three buttons for the VIP, a line for everybody else.
 * @param {HTMLElement} err
 */
function lateJoin(err) {
  const buttons = LATE_JOIN.map((mode) => /** @type {HTMLButtonElement} */ (h("button", { "data-mode": mode, onclick: () => act("late-join", { mode }, err).catch(() => {}) }, t.late[mode]?.[0])));
  const row = h("div", { class: "row seg" }, ...buttons);
  const line = h("p", { class: "muted" });
  const box = h("div", { class: "late" }, h("h2", {}, t.latecomers), row, line);
  const update = () => {
    const v = client.view;
    const mode = v.room?.lateJoin ?? "wait";
    const vip = (v.roster ?? []).find((/** @type {any} */ r) => r.id === client.you?.id)?.vip;
    row.hidden = !vip;
    for (const b of buttons) b.classList.toggle("chosen", b.dataset.mode === mode);
    line.textContent = t.late[mode]?.[1] ?? "";
  };
  return { box, update };
}

/**
 * Your colour: the swatches to pick from (a colour someone else has is
 * marked; the host refuses it while one is free) and the pens it gives.
 * It updates itself on every view while it is on screen.
 * @param {HTMLElement} err
 */
function colorPicker(err) {
  const grid = h("div", { class: "colors" });
  const pens = h("div", { class: "pens" });
  const box = h("div", { class: "picker" }, h("h2", {}, t.yourColour), grid, h("div", { class: "pens-line" }, h("span", { class: "muted" }, t.yourPens), pens), err);
  /** @type {HTMLButtonElement[]} */
  let buttons = [];
  let last = "";
  const update = () => {
    const v = client.view;
    const colors = /** @type {string[]} */ (Array.isArray(v.room?.colors) ? v.room.colors : []);
    const taken = /** @type {number[]} */ (Array.isArray(v.room?.taken) ? v.room.taken : []);
    const mine = v.me?.color;
    const palette = /** @type {string[]} */ (Array.isArray(v.me?.palette) ? v.me.palette : []);
    const key = JSON.stringify([colors, taken, mine, palette]);
    if (key === last) return;
    last = key;
    box.hidden = colors.length === 0;
    if (buttons.length !== colors.length) {
      buttons = colors.map((c, i) => /** @type {HTMLButtonElement} */ (h("button", { style: `background:${c}`, "aria-label": t.colourNames[i] ?? t.colour(i + 1), onclick: () => act("color", { color: i }, err).catch(() => {}) })));
      grid.replaceChildren(...buttons);
    }
    buttons.forEach((b, i) => {
      b.classList.toggle("chosen", i === mine);
      b.classList.toggle("taken", i !== mine && (taken[i] ?? 0) > 0);
    });
    pens.replaceChildren(...palette.map((c) => h("span", { class: "pen", style: `--c:${c}` })));
  };
  const was = refresh;
  refresh = () => {
    was?.();
    update();
  };
  update();
  return { box, update };
}

/** The timers' choices (`TIMERS` in game/game.ts). */
const TIMERS = ["fast", "normal", "slow"];

/**
 * The room's rules: the VIP's buttons (the language, the rounds, the
 * timers, undo, colours, adult prompts, animation), a line each for
 * everybody. Every row has its setting in `data-key`.
 * @param {HTMLElement} err
 */
function rules(err) {
  /** @type {{ key: "animate" | "undo" | "colorMode" | "adult", row: HTMLElement, buttons: HTMLButtonElement[], line: HTMLElement }[]} */
  const items = [];
  const box = h("div", { class: "rules" }, h("h2", {}, t.rules));
  // The language: the room's, every phone (that did not pick its own) and the TV follow it.
  const langButtons = LANGS.map((l) =>
    /** @type {HTMLButtonElement} */ (
      h(
        "button",
        {
          lang: l,
          onclick: () => {
            // The VIP follows the room again (their own switch is undone).
            try {
              localStorage.removeItem(LANG_KEY);
            } catch {}
            act("settings", { lang: l }, err)
              .then(() => {
                if (!useLang() || !client.view?.me) return;
                shown = "";
                render(client.view);
              })
              .catch(() => {});
          },
        },
        strings(l).langName,
      )
    ),
  );
  const langRow = h("div", { class: "row seg lang", "data-key": "lang" }, ...langButtons);
  const langLine = h("p", { class: "muted" });
  box.append(langRow, langLine);
  // The rounds: 1 to MAX_ROUNDS (game.ts).
  const roundButtons = [1, 2, 3, 4, 5].map((n) => /** @type {HTMLButtonElement} */ (h("button", { onclick: () => act("settings", { rounds: n }, err).catch(() => {}) }, String(n))));
  const roundRow = h("div", { class: "row seg rounds", "data-key": "rounds" }, ...roundButtons);
  const roundLine = h("p", { class: "muted" });
  box.append(roundRow, roundLine);
  const timerButtons = TIMERS.map((v) => /** @type {HTMLButtonElement} */ (h("button", { onclick: () => act("settings", { timers: v }, err).catch(() => {}) }, t.timers[v]?.[0])));
  const timerRow = h("div", { class: "row seg timers", "data-key": "timers" }, ...timerButtons);
  const timerLine = h("p", { class: "muted" });
  box.append(timerRow, timerLine);
  for (const key of /** @type {const} */ (["undo", "colorMode", "adult", "animate"])) {
    const [off, on] = t.settings[key];
    const buttons = [false, true].map((value, i) => /** @type {HTMLButtonElement} */ (h("button", { onclick: () => act("settings", { [key]: value }, err).catch(() => {}) }, (i ? on : off)[0])));
    const row = h("div", { class: "row seg", "data-key": key }, ...buttons);
    const line = h("p", { class: "muted" });
    box.append(row, line);
    items.push({ key, row, buttons, line });
  }
  const update = () => {
    const v = client.view;
    const room = v.room ?? {};
    const vip = (v.roster ?? []).find((/** @type {any} */ r) => r.id === client.you?.id)?.vip;
    const playing = typeof room.lang === "string" ? pickLang(room.lang) : lang;
    const langs = Array.isArray(room.langs) ? room.langs : [playing];
    langRow.hidden = !vip;
    langButtons.forEach((b, i) => {
      b.classList.toggle("chosen", LANGS[i] === playing);
      b.disabled = !langs.includes(LANGS[i]);
    });
    langLine.textContent = t.langLine[playing] ?? "";
    const rounds = typeof room.rounds === "number" ? room.rounds : 0;
    roundRow.hidden = !vip;
    roundButtons.forEach((b, i) => b.classList.toggle("chosen", i + 1 === rounds));
    roundLine.textContent = rounds ? t.roundsLine(rounds) : "";
    const timers = typeof room.timers === "string" && TIMERS.includes(room.timers) ? room.timers : "normal";
    timerRow.hidden = !vip;
    timerButtons.forEach((b, i) => b.classList.toggle("chosen", TIMERS[i] === timers));
    timerLine.textContent = t.timers[timers]?.[1] ?? "";
    for (const { key, row, buttons, line } of items) {
      const on = !!room[key];
      row.hidden = !vip;
      buttons.forEach((b, i) => b.classList.toggle("chosen", !!i === on));
      if (key === "adult") buttons[1].disabled = !room.adultOk;
      line.textContent = key === "adult" && !room.adultOk ? t.noAdult : t.settings[key][on ? 1 : 0][1];
    }
  };
  return { box, update };
}

/** @param {Record<string, any>} view */
function lobby(view) {
  const list = h("ul", { class: "players" });
  const start = /** @type {HTMLButtonElement} */ (h("button", { class: "primary", id: "start", onclick: () => act("start", null, err).catch(() => {}) }, t.everybodyIn));
  const err = h("p", { class: "error" });
  const hint = h("p", { class: "muted" });
  const late = lateJoin(err);
  const set = rules(err);
  show(h("section", { class: "card lobby" }, h("h1", {}, t.youreIn), hint, h("h2", {}, t.players), list, start, err, set.box, late.box));
  // Your colour first: picked when you start.
  /** @type {HTMLElement} */ (app.querySelector(".card")).insertBefore(colorPicker(h("p", { class: "error" })).box, hint.nextSibling);
  const pick = refresh;
  refresh = () => {
    pick?.();
    set.update();
    late.update();
    const v = client.view;
    const roster = v.roster ?? [];
    const meVip = roster.find((/** @type {any} */ r) => r.id === client.you?.id)?.vip;
    const min = v.room?.minPlayers ?? 3;
    const ready = roster.filter((/** @type {any} */ r) => r.connected).length;
    list.replaceChildren(
      ...roster.map((/** @type {any} */ r) =>
        h(
          "li",
          { class: r.connected ? "" : "away" },
          h("span", { class: "name" }, r.name),
          r.vip ? h("span", { class: "vip" }, t.vip) : null,
          meVip && r.id !== client.you?.id ? h("button", { onclick: () => act("kick", { id: r.id }, err).catch(() => {}) }, t.remove) : null,
        ),
      ),
    );
    start.hidden = !meVip;
    start.disabled = ready < min;
    hint.textContent = meVip ? (ready < min ? t.vipWait(min - ready) : t.vipReady) : t.waitVip;
  };
}

/** @param {Record<string, any>} view */
function final(view) {
  const me = view.me ?? {};
  const err = h("p", { class: "error" });
  const again = /** @type {HTMLButtonElement} */ (h("button", { class: "primary", id: "start", onclick: () => act("start", null, err).catch(() => {}) }, t.playAgain));
  const late = lateJoin(err);
  const set = rules(err);
  show(
    h(
      "section",
      { class: "card" },
      h("h1", {}, me.rank === 1 ? t.won : t.gameOver),
      h("p", { class: "score" }, formatNumber(me.score ?? 0)),
      h("p", { class: "muted" }, `${t.points(me.score ?? 0)} · ${t.rankOnly(me.rank ?? 0)}`),
      again,
      err,
      set.box,
      late.box,
    ),
  );
  /** @type {HTMLElement} */ (app.querySelector(".card")).append(colorPicker(h("p", { class: "error" })).box);
  const pick = refresh;
  refresh = () => {
    pick?.();
    const vip = (client.view.roster ?? []).find((/** @type {any} */ r) => r.id === client.you?.id)?.vip;
    again.hidden = !vip;
    set.update();
    late.update();
    late.box.hidden = !vip;
  };
}

/**
 * @param {string} type
 * @param {any} data
 * @param {HTMLElement} err
 */
async function act(type, data, err) {
  err.textContent = "";
  try {
    const out = await client.act(type, data);
    if (type === "draw" || type === "lie" || type === "vote") {
      sfx.play("send");
      buzz(20);
    }
    return out;
  } catch (e) {
    err.textContent = message(e);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Drawing

/**
 * A stroke's points and its length on the grid.
 * @param {number[]} s
 */
function measure(s) {
  let length = 0;
  for (let i = 4; i + 1 < s.length; i += 2) length += Math.hypot(s[i] - s[i - 2], s[i + 1] - s[i - 1]);
  return { points: (s.length - 2) / 2, length };
}

/**
 * The drawing pad: one frame, or an animation's frames (one drawn at a
 * time, the other faintly under it, a preview that flips through them).
 * The limits are for all frames together.
 */
class Pad {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {readonly string[]} palette the player's pens
   * @param {number} [frames] 2: an animation
   */
  constructor(canvas, palette, frames = 1) {
    this.canvas = canvas;
    this.palette = palette;
    this.ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
    /** @type {number[][][]} */
    this.frames = Array.from({ length: Math.max(1, frames) }, () => []);
    /** The frame being drawn. */
    this.frame = 0;
    /** @type {ReturnType<typeof setInterval> | 0} the preview, flipping through the frames */
    this.playing = 0;
    this.shown = 0;
    /** @type {() => void} called when strokes come or go, or the frame or the preview changes */
    this.onchange = () => {};
    /** How much is drawn: the strokes' length on the grid (the TV's progress). */
    this.length = 0;
    this.points = 0;
    this.color = 0;
    this.width = WIDTHS[1];
    /** @type {number[] | null} */
    this.current = null;
    this.size = 0;
    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas);
    canvas.addEventListener("pointerdown", (e) => this.down(e));
    canvas.addEventListener("pointermove", (e) => this.move(e));
    canvas.addEventListener("pointerup", () => this.up());
    canvas.addEventListener("pointercancel", () => this.up());
    // Pointer events alone don't stop iOS Safari from starting a text
    // selection, the magnifier or a scroll/zoom from a touch on the pad:
    // cancel the touch events themselves (non-passive).
    for (const type of ["touchstart", "touchmove", "touchend"]) {
      canvas.addEventListener(type, (e) => e.preventDefault(), { passive: false });
    }
  }

  /** The strokes of the frame being drawn. */
  get strokes() {
    return this.frames[this.frame];
  }

  /** Strokes in all frames. */
  get count() {
    return this.frames.reduce((n, f) => n + f.length, 0);
  }

  /** What the host gets: `{ strokes }`, an animation with its `frames`. */
  get drawing() {
    const [strokes, ...frames] = this.frames;
    return frames.length > 0 ? { strokes, frames } : { strokes };
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    this.size = r.width;
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.width * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.redraw();
  }

  redraw() {
    const palette = [...this.palette];
    if (this.playing) {
      drawDrawing(this.ctx, { strokes: this.frames[this.shown], palette }, 0, 0, this.size);
      return;
    }
    drawDrawing(this.ctx, { strokes: [], palette }, 0, 0, this.size);
    // The other frames faintly under this one (onion skin).
    this.ctx.save();
    this.ctx.globalAlpha = ONION;
    this.frames.forEach((f, i) => {
      if (i !== this.frame) drawDrawing(this.ctx, { strokes: f, palette }, 0, 0, this.size, { paper: null });
    });
    this.ctx.restore();
    drawDrawing(this.ctx, { strokes: this.strokes, palette }, 0, 0, this.size, { paper: null });
  }

  /** @param {PointerEvent} e */
  at(e) {
    const r = this.canvas.getBoundingClientRect();
    const k = GRID / r.width;
    return [Math.round(Math.min(GRID, Math.max(0, (e.clientX - r.left) * k))), Math.round(Math.min(GRID, Math.max(0, (e.clientY - r.top) * k)))];
  }

  /** @param {PointerEvent} e */
  down(e) {
    // A tap on the preview stops it.
    if (this.playing) {
      e.preventDefault();
      this.stop();
      return;
    }
    if (this.count >= MAX_STROKES || this.points >= MAX_POINTS) return;
    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);
    const [x, y] = this.at(e);
    this.current = [this.color, this.width, x, y];
    this.strokes.push(this.current);
    this.points++;
    drawStroke(this.ctx, this.current, 0, 0, this.size, this.palette);
    this.onchange();
  }

  /** @param {PointerEvent} e */
  move(e) {
    const s = this.current;
    if (!s) return;
    e.preventDefault();
    for (const ev of e.getCoalescedEvents?.() ?? [e]) {
      if (this.points >= MAX_POINTS) return this.up();
      const [x, y] = this.at(ev);
      const lx = s[s.length - 2];
      const ly = s[s.length - 1];
      if (Math.hypot(x - lx, y - ly) < 4) continue;
      s.push(x, y);
      this.points++;
      this.length += Math.hypot(x - lx, y - ly);
      drawStroke(this.ctx, [s[0], s[1], lx, ly, x, y], 0, 0, this.size, this.palette);
    }
  }

  up() {
    const was = this.current;
    this.current = null;
    if (was) this.onchange();
  }

  /** @param {number[][]} strokes taken out of the pad's measure */
  forget(strokes) {
    for (const s of strokes) {
      const m = measure(s);
      this.points -= m.points;
      this.length -= m.length;
    }
    this.points = Math.max(0, this.points);
    this.length = Math.max(0, this.length);
  }

  /** Clears the frame being drawn. */
  clear() {
    this.forget(this.strokes);
    this.frames[this.frame] = [];
    this.redraw();
    this.onchange();
  }

  /** Takes back the last stroke of the frame (when the room allows undo). */
  undo() {
    if (this.current) return;
    const s = this.strokes.pop();
    if (!s) return;
    this.forget([s]);
    this.redraw();
    this.onchange();
  }

  /** Draws frame `i` (the preview stops). @param {number} i */
  go(i) {
    if (this.current || i < 0 || i >= this.frames.length) return;
    this.stop(false);
    this.frame = i;
    this.redraw();
    this.onchange();
  }

  /** Whether {@link copy} can fill the frame: it is empty, another one is not, and the limits allow it. */
  get canCopy() {
    const from = this.frames[this.frame === 0 ? 1 : this.frame - 1];
    if (!from || this.strokes.length > 0 || from.length === 0) return false;
    const points = from.reduce((n, s) => n + measure(s).points, 0);
    return this.count + from.length <= MAX_STROKES && this.points + points <= MAX_POINTS;
  }

  /** Fills an empty frame with the one before it (frame 1 with frame 2), to change what moves. */
  copy() {
    if (this.current || !this.canCopy) return;
    const from = this.frames[this.frame === 0 ? 1 : this.frame - 1];
    this.frames[this.frame] = from.map((s) => [...s]);
    for (const s of from) {
      const m = measure(s);
      this.points += m.points;
      this.length += m.length;
    }
    this.redraw();
    this.onchange();
  }

  /** Flips through the frames on the pad until tapped. */
  play() {
    if (this.current || this.playing || this.frames.length < 2) return;
    this.shown = this.frame;
    this.playing = setInterval(() => {
      if (!this.canvas.isConnected) return this.stop(false);
      this.shown = (this.shown + 1) % this.frames.length;
      this.redraw();
    }, FRAME_MS);
    this.redraw();
    this.onchange();
  }

  stop(show = true) {
    if (!this.playing) return;
    clearInterval(this.playing);
    this.playing = 0;
    if (!show) return;
    this.redraw();
    this.onchange();
  }
}

const SVG_NS = "http://www.w3.org/2000/svg";
/** @param {string} d the icon's paths (24×24, stroked) */
function icon(d) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  for (const part of d.split("|")) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", part);
    svg.append(path);
  }
  return svg;
}
const TRASH = "M4 7h16|M9 7V4h6v3|M6 7l1 13h10l1-13|M10 11v6|M14 11v6";
const UNDO = "M9 14L4 9l5-5|M4 9h10a6 6 0 0 1 0 12h-3";
const PLAY = "M7 4.5v15l12-7.5z";
const STOP = "M6 6h12v12H6z";
const COPY = "M9 9h11v11H9z|M5 15H4V4h11v1";
const SPEAKER = "M4 9h4l5-4v14l-5-4H4z|M16.5 8.5a5 5 0 0 1 0 7|M19.5 5.5a9 9 0 0 1 0 13";
const SPEAKER_OFF = "M4 9h4l5-4v14l-5-4H4z|M17 9l5 6|M22 9l-5 6";
/** The size buttons' dots, px. */
const DOTS = [8, 14, 22];

/**
 * The pad, as big as the screen allows: a line with the prompt and the
 * clock, the square pad, the player's pens, and one toolbar (sizes,
 * clear, undo when the room allows it, done). An animation (`me.frames`
 * 2) has a line of frames above the pens: a tab per frame with its
 * thumbnail, copy (an empty frame gets the other one) and play.
 * @param {any} me
 */
function draw(me) {
  const palette = /** @type {string[]} */ (Array.isArray(me.palette) && me.palette.length > 0 ? me.palette : PALETTE);
  const nFrames = me.frames === 2 ? 2 : 1;
  const canvas = /** @type {HTMLCanvasElement} */ (h("canvas", { class: "pad" }));
  const err = h("p", { class: "error" });
  const swatches = h("div", { class: "swatches" });
  const sizes = h("div", { class: "sizes" });
  const done = /** @type {HTMLButtonElement} */ (h("button", { class: "done", id: "done", "data-fit": "w", onclick: () => submit() }, t.done));
  const top = h("div", { class: "top" }, h("div", { class: "what" }, h("span", { class: "label" }, nFrames > 1 ? t.animate : t.draw), h("span", { class: "prompt", "data-fit": "2" }, me.prompt ?? "")), timer);
  const clear = /** @type {HTMLButtonElement} */ (h("button", { class: "icon", id: "clear", "aria-label": t.clear }, icon(TRASH)));
  const undo = me.undo ? /** @type {HTMLButtonElement} */ (h("button", { class: "icon", id: "undo", "aria-label": t.undo }, icon(UNDO))) : null;
  const bar = h("div", { class: "toolbar" }, sizes, clear, undo, done);
  // The frames: tabs with thumbnails, copy, play.
  const thumbs = Array.from({ length: nFrames }, () => /** @type {HTMLCanvasElement} */ (h("canvas")));
  const tabs = thumbs.map((c, i) => /** @type {HTMLButtonElement} */ (h("button", { class: "frame", "data-frame": i + 1, onclick: () => p.go(i) }, c, h("span", {}, t.frameN(i + 1)))));
  const copy = /** @type {HTMLButtonElement} */ (h("button", { class: "icon", id: "copy", "aria-label": t.copyFrame, onclick: () => p.copy() }, icon(COPY)));
  const play = /** @type {HTMLButtonElement} */ (h("button", { class: "icon", id: "play", "aria-label": t.play, onclick: () => (p.playing ? p.stop() : p.play()) }, icon(PLAY)));
  const strip = nFrames > 1 ? h("div", { class: "frames" }, ...tabs, copy, play) : null;
  show(h("section", { class: `draw${strip ? " anim" : ""}` }, top, h("div", { class: "padbox" }, canvas), strip, swatches, bar, err));
  const p = new Pad(canvas, palette, nFrames);
  pad = p;
  const pens = palette.map((c, i) => {
    const b = h("button", { style: `--c:${c}`, "aria-label": t.colour(i + 1), onclick: () => pick(i) });
    swatches.append(b);
    return b;
  });
  /** @param {number} i */
  const pick = (i) => {
    p.color = i;
    pens.forEach((b, j) => b.classList.toggle("chosen", j === i));
  };
  pick(0);
  const widths = WIDTHS.map((w, i) => {
    const b = h("button", { "aria-label": t.sizes[i] ?? "", onclick: () => size(i) }, h("i", { style: `width:${DOTS[i]}px;height:${DOTS[i]}px` }));
    sizes.append(b);
    return b;
  });
  /** @param {number} i */
  const size = (i) => {
    p.width = WIDTHS[i];
    widths.forEach((b, j) => b.classList.toggle("chosen", j === i));
  };
  size(1);
  // Clear asks once: without undo a stray tap would lose the drawing.
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
      p.clear();
      return;
    }
    clear.classList.add("arm");
    clear.textContent = t.clearSure;
    armed = setTimeout(disarm, 2000);
  });
  undo?.addEventListener("click", () => p.undo());
  /** Frames drawn, as the thumbnails show them (redrawn when they change). */
  const thumbed = thumbs.map(() => -1);
  const changed = () => {
    if (undo) undo.disabled = p.strokes.length === 0 || !!p.playing;
    clear.disabled = p.strokes.length === 0 || !!p.playing;
    if (p.strokes.length === 0 && armed) disarm();
    if (!strip) return;
    tabs.forEach((b, i) => b.classList.toggle("chosen", i === p.frame && !p.playing));
    copy.hidden = !p.canCopy || !!p.playing;
    play.classList.toggle("chosen", !!p.playing);
    play.replaceChildren(icon(p.playing ? STOP : PLAY));
    play.setAttribute("aria-label", p.playing ? t.stop : t.play);
    play.disabled = p.frames.every((f) => f.length === 0);
    thumbs.forEach((c, i) => {
      const n = p.frames[i].reduce((k, s) => k + s.length, 0);
      if (thumbed[i] === n || p.current) return;
      thumbed[i] = n;
      const size = c.clientWidth || 30;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      c.width = c.height = Math.round(size * dpr);
      const ctx = /** @type {CanvasRenderingContext2D} */ (c.getContext("2d"));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawDrawing(ctx, { strokes: p.frames[i], palette: [...palette] }, 0, 0, size);
    });
    if (sure && !p.frames.some((f) => f.length === 0)) unsure();
  };
  // Done with an empty frame (and another drawn) asks once, on that frame.
  /** @type {ReturnType<typeof setTimeout> | 0} */
  let sure = 0;
  const unsure = () => {
    if (sure) clearTimeout(sure);
    sure = 0;
    done.classList.remove("arm");
    done.textContent = t.done;
  };
  // The TV shows how much everyone drew (never what): `{ ink }`, the
  // length drawn / 10, at most every half second while drawing.
  let inkAt = 0;
  const ink = () => {
    inkAt = Date.now();
    client.input({ ink: Math.round(p.length / 10) });
  };
  p.onchange = () => {
    changed();
    ink();
  };
  canvas.addEventListener("pointermove", () => {
    if (p.current && Date.now() - inkAt >= 500) ink();
  });
  changed();
  let sent = false;
  /** @param {boolean} [force] time's up: no questions */
  const submit = async (force = false) => {
    if (sent) return;
    const empty = p.frames.findIndex((f) => f.length === 0);
    if (!force && !sure && empty >= 0 && p.count > 0 && nFrames > 1) {
      p.go(empty);
      done.classList.add("arm");
      done.textContent = t.frameEmpty(empty + 1);
      sure = setTimeout(unsure, 3000);
      return;
    }
    unsure();
    sent = true;
    done.disabled = true;
    p.stop(false);
    try {
      await act("draw", p.drawing, err);
    } catch {
      sent = false;
      done.disabled = false;
    }
  };
  // Time's up: send what is there.
  refresh = () => {};
  autoSubmit = () => {
    if (!sent && pad === p) submit(true);
  };
}

/** @type {(() => void) | null} */
let autoSubmit = null;

// ---------------------------------------------------------------------------
// Lies and votes

/**
 * The drawing to lie or vote about; an animation flips through its frames
 * while it is on screen.
 * @param {any} drawing
 */
function mini(drawing) {
  const c = /** @type {HTMLCanvasElement} */ (h("canvas", { class: "mini" }));
  const frame = h("div", { class: "mframe" }, h("div", {}, c));
  requestAnimationFrame(() => {
    const r = c.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(r.width * dpr);
    c.height = Math.round(r.width * dpr);
    const ctx = /** @type {CanvasRenderingContext2D} */ (c.getContext("2d"));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawDrawing(ctx, drawing, 0, 0, r.width);
    const n = framesOf(drawing).length;
    if (n < 2) return;
    let frame = 0;
    const flip = setInterval(() => {
      if (!c.isConnected) return clearInterval(flip);
      frame = (frame + 1) % n;
      drawDrawing(ctx, drawing, 0, 0, r.width, { frame });
    }, FRAME_MS);
  });
  return frame;
}

/** @param {any} me */
function lie(me) {
  const drawing = me.drawing ?? client.view.room?.drawing;
  // As long as the prompts at most (LIE_SOFT in game/rules.ts), no capitals
  // (titles are shown in lowercase anyway); autocorrect stays on.
  const input = /** @type {HTMLInputElement} */ (
    h("input", { maxlength: LIE_SOFT, placeholder: t.liePlaceholder, enterkeyhint: "send", autocapitalize: "none", autocomplete: "off", spellcheck: "true", lang })
  );
  const err = h("p", { class: "error" });
  // The TV shows who is typing (never what), at most once a second.
  let typedAt = 0;
  input.addEventListener("input", () => {
    if (Date.now() - typedAt < 1000) return;
    typedAt = Date.now();
    client.input({ typing: true });
  });
  const send = async (/** @type {any} */ data) => {
    try {
      await act("lie", data, err);
    } catch {}
  };
  const form = h(
    "form",
    {
      class: "lie",
      autocomplete: "off",
      onsubmit: (/** @type {Event} */ e) => {
        e.preventDefault();
        if (input.value.trim()) send({ text: input.value });
      },
    },
    input,
    h("button", { type: "submit", class: "primary" }, t.send),
    err,
  );
  const role = t.liarFor(me.artist?.name, me.liars ?? 0);
  // Early: the first drawing's liars write during the gallery, the next
  // drawing's during the current vote (which they sit out).
  const hint = h("p", { class: "muted" });
  show(h("section", { class: "card" }, h("h2", {}, t.fakeTitle), h("p", { class: "role" }, role), me.early ? hint : null, mini(drawing), form));
  refresh = () => {
    const phase = client.view.room?.phase;
    hint.textContent = phase === "draw" || phase === "gallery" ? t.firstAfterGallery : t.nextSitOut;
  };
}

/**
 * @param {{ id: string, text: string }[]} options
 * @param {any} drawing
 */
function vote(options, drawing) {
  const err = h("p", { class: "error" });
  const list = h("div", { class: "options" });
  for (const [i, o] of options.entries()) {
    const b = h(
      "button",
      {
        class: "in",
        style: `animation-delay:${150 + i * 70}ms`,
        onclick: async () => {
          list.querySelectorAll("button").forEach((x) => {
            x.classList.remove("in");
            x.classList.toggle("chosen", x === b);
          });
          try {
            await act("vote", { option: o.id }, err);
          } catch {}
        },
      },
      h("span", { class: "tx", "data-fit": "w" }, o.text),
    );
    list.append(b);
  }
  show(h("section", { class: "card" }, h("h2", {}, t.whichReal), mini(drawing), list, err));
}

// ---------------------------------------------------------------------------
// The clock

setInterval(() => {
  const deadline = client.view.me?.deadline ?? client.view.room?.deadline;
  const task = client.view.me?.task;
  const active = typeof deadline === "number" && ["draw", "lie", "vote"].includes(task) && !client.view.me?.done;
  timer.hidden = !active;
  if (!active) return;
  const left = deadline - client.now();
  timer.textContent = String(Math.max(0, Math.ceil(left / 1000)));
  timer.classList.toggle("low", left < 10_000);
  if (task === "draw" && left < 800) autoSubmit?.();
}, 200);

// Keep the screen on while playing.
async function wake() {
  try {
    await /** @type {any} */ (navigator).wakeLock?.request("screen");
  } catch {}
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") wake();
});

// ---------------------------------------------------------------------------

/** @type {HTMLElement} */ (app.querySelector(".big")).textContent = t.connecting;
showSound();
if (!client.room || !client.key) {
  show(h("section", { class: "card" }, h("p", { class: "big" }, t.scanToJoin)));
} else if (client.canResume) {
  client.connect().then(wake, (e) => joinForm(e?.code === "no-player" ? "" : message(e)));
} else {
  joinForm();
}
