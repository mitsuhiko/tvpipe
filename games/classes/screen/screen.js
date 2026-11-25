// @ts-check
/**
 * Classes' TV page: tvpipe casts it with its own browser, or anyone opens
 * the watch link (the host page's preview, muted). The screen is the
 * classroom (docs/classes-design.md §6): the alphabet frieze along the
 * top, the blackboard, the wall with its clock (and the join badge
 * pinned below it), the desks with everyone's exercise book while they
 * write, the open exercise book when the class grades, an encyclopedia
 * page for Wikipedia, the report cards and the cork board at the end.
 *
 * The page draws `view.screen` only (§7.3); players' texts are always
 * set as text. Everything left of x = 1044 is clear of the join badge
 * (bottom right): the wall's column above it has the clock and the
 * timetable.
 */

import { PartyClient } from "/_tvpipe/lib/client.js";
import { wallClock } from "./art.js";
import { h, mmss, svg, watchFit } from "./dom.js";
import { env, now } from "./env.js";
import { locale, pickLang } from "./i18n.js";
import { sound } from "./sound.js";
import { strings } from "./strings.js";
import { boardScene, bellScene, letterScene, lobbyScene, reportScene, writeScene } from "./board.js";
import { gradeScene } from "./book.js";
import { finalScene } from "./final.js";

const params = new URLSearchParams(location.hash.slice(1));
const client = PartyClient.fromLocation({ role: /** @type {any} */ (params.get("role") ?? "screen"), rejoinBadge: { corner: "bottom-right", layout: "column" } });
env.client = client;

const room = /** @type {HTMLElement} */ (document.getElementById("room"));

// ---------------------------------------------------------------------------
// The room: frieze, board, wall, desks, the layer above the board

const frieze = h("div", { id: "frieze" });
const chalk = h("div", { id: "chalk" });
const board = h("div", { id: "board" }, chalk, h("div", { class: "tray" }, h("span", { class: "stick" }), h("span", { class: "stick yellow" }), h("span", { class: "sponge" })));
const clock = wallClock();
const digits = h("div", { class: "digits" });
const note = h("div", { id: "note" });
const wall = h("div", { id: "wall" }, h("div", { class: "clockbox" }, clock.el), digits, note);
const desks = h("div", { id: "desks" });
const over = h("div", { id: "over" });
room.append(frieze, board, wall, desks, over);

/** @type {Map<string, { el: HTMLElement, cross: Element }>} */
const cards = new Map();
function buildFrieze() {
  frieze.replaceChildren();
  cards.clear();
  env.t.alphabet.forEach((l, i) => {
    const cross = svg("svg", { viewBox: "0 0 40 50", class: "cross", "aria-hidden": "true" }, svg("path", { d: "M5 7 Q20 24 35 44 M34 6 Q19 26 6 43" }));
    const el = h("div", { class: `card c${i % 6}` }, h("b", {}, l), cross);
    frieze.append(el);
    cards.set(l, { el, cross });
  });
}

let friezeKey = "";
let lit = "";
/** @param {Record<string, any>} s */
function updateFrieze(s) {
  const used = new Set(Array.isArray(s.used) ? s.used : []);
  const running = s.phase === "letter" && !s.letter && s.run && Array.isArray(s.run.seq) && s.run.seq.length > 0;
  const seq = running ? new Set(s.run.seq) : null;
  const key = JSON.stringify([[...used], s.letter ?? "", running, s.phase]);
  if (key !== friezeKey) {
    friezeKey = key;
    for (const [l, c] of cards) {
      const current = l === s.letter && s.phase !== "lobby" && s.phase !== "final";
      c.el.classList.toggle("used", used.has(l) && !current);
      c.el.classList.toggle("current", current);
      c.el.classList.toggle("out", !!seq && !seq.has(l) && !used.has(l));
    }
  }
  let now_ = "";
  if (running) {
    const r = s.run;
    const step = Math.max(20, Number(r.step) || 110);
    const t = now() - Number(r.start);
    if (t >= 0) now_ = String(r.seq[Math.floor(t / step) % r.seq.length] ?? "");
  }
  if (now_ !== lit) {
    cards.get(lit)?.el.classList.remove("lit");
    cards.get(now_)?.el.classList.add("lit");
    if (now_) sound.blip();
    lit = now_;
  }
}

/** The lesson and the subjects of this round on the wall's note. @param {Record<string, any>} s */
function updateNote(s) {
  const t = env.t;
  const cols = Array.isArray(s.columns) ? s.columns : [];
  const playing = ["letter", "board", "write", "bell", "grade", "report"].includes(s.phase);
  const today = new Date(now());
  const key = JSON.stringify([env.lang, playing && s.phase, s.round, s.rounds, s.col, s.stage, cols.map((c) => c.subject), playing || today.toDateString()]);
  if (note.dataset["key"] === key) return;
  note.dataset["key"] = key;
  note.classList.toggle("calendar", !playing);
  if (!playing) {
    // Before and after the game: the tear-off calendar.
    const fmt = (/** @type {Intl.DateTimeFormatOptions} */ o) => new Intl.DateTimeFormat(locale(env.lang), o).format(today);
    note.replaceChildren(h("span", { class: "tape" }), h("div", { class: "month" }, fmt({ month: "long" })), h("div", { class: "day" }, fmt({ day: "numeric" })), h("div", { class: "wd" }, fmt({ weekday: "long" })));
    return;
  }
  const grading = s.phase === "grade";
  const col = Number(s.col ?? -1);
  note.replaceChildren(
    h("span", { class: "tape" }),
    h("div", { class: "lesson", "data-fit": "1" }, t.lesson(s.round ?? 1, s.rounds ?? 1)),
    ...(grading ? [h("div", { class: "of", "data-fit": "1" }, t.colOf(col + 1, cols.length))] : []),
    h(
      "div",
      { class: "chips" },
      ...cols.map((c, i) => h("span", { class: `chip s-${c.subject}${grading && i < col ? " past" : ""}${grading && i === col ? " now" : ""}` })),
    ),
  );
}

let lastSec = -1;
function updateClock() {
  const c = env.clock;
  const t = now();
  const left = c.deadline ? c.deadline - t : undefined;
  clock.set({ date: new Date(t), left, total: c.total });
  const red = !!c.red || (left !== undefined && left > 0 && left <= 10_000);
  wall.classList.toggle("red", red);
  digits.textContent = left !== undefined ? mmss(left) : "";
  digits.hidden = left === undefined;
  const sec = left === undefined ? -1 : Math.ceil(left / 1000);
  if (sec !== lastSec) {
    if (sec > 0 && sec <= 10 && lastSec > sec && env.screen["phase"] === "write") sound.tick(sec % 2 === 0);
    lastSec = sec;
  }
}

// ---------------------------------------------------------------------------
// Scenes: built once per key, updated every frame

/**
 * @typedef {{ layout: "board" | "write" | "book" | "final", board?: HTMLElement, desks?: HTMLElement, over?: HTMLElement, update?: (s: Record<string, any>) => void, key?: (s: Record<string, any>) => string }} Scene
 */

let sceneKey = "";
/** @type {Scene | null} */
let scene = null;

/** @param {Record<string, any>} s */
function keyOf(s) {
  switch (s.phase) {
    case "letter":
      return `letter:${s.round}:${s.letter ? "stopped" : "run"}`;
    case "board":
    case "write":
    case "bell":
    case "report":
      return `${s.phase}:${s.round}`;
    case "grade":
      return `grade:${s.round}:${s.col}:${s.stage}`;
    default:
      return String(s.phase ?? "");
  }
}

/** @param {Record<string, any>} s @returns {Scene} */
function build(s) {
  switch (s.phase) {
    case "letter":
      return letterScene(s);
    case "board":
      return boardScene(s);
    case "write":
      return writeScene(s);
    case "bell":
      return bellScene(s);
    case "grade":
      return gradeScene(s);
    case "report":
      return reportScene(s);
    case "final":
      return finalScene(s);
    default:
      return lobbyScene(s);
  }
}

/** @param {Record<string, any>} view */
function render(view) {
  const s = view.screen ?? {};
  env.screen = s;
  // For the live checks (test/live/watch.ts): what the page draws.
  /** @type {any} */ (window).__classesScreen = s;
  env.roster = Array.isArray(view.roster) ? view.roster : [];
  const l = pickLang(s.lang);
  if (l !== env.lang || cards.size === 0) {
    env.lang = l;
    env.t = strings(l);
    document.documentElement.lang = locale(l);
    // The join badge speaks the page's language: tell it again.
    client.rejoinBadge?.update({ ...view, join: view.join ? { ...view.join } : view.join });
    buildFrieze();
    friezeKey = "";
    sceneKey = "";
    note.dataset["key"] = "";
  }
  client.joinVisible = (s.phase ?? "lobby") === "lobby";
  const key = keyOf(s);
  if (key !== sceneKey) {
    sceneKey = key;
    env.clock = {};
    scene = build(s);
    room.dataset["layout"] = scene.layout;
    room.dataset["phase"] = String(s.phase ?? "lobby");
    chalk.replaceChildren(...(scene.board ? [scene.board] : []));
    desks.replaceChildren(...(scene.desks ? [scene.desks] : []));
    over.replaceChildren(...(scene.over ? [scene.over] : []));
  }
  updateNote(s);
  frame();
}

function frame() {
  const s = env.screen;
  updateFrieze(s);
  scene?.update?.(s);
  updateClock();
}

client.on("view", (view) => render(/** @type {any} */ (view)));
(function loop() {
  frame();
  requestAnimationFrame(loop);
})();
watchFit();
await client.connect();
