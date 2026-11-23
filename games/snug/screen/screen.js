// @ts-check
/**
 * Snug's TV page: tvpipe casts it with its own browser, or anyone opens
 * the watch link (the host page's preview, muted). It shows the screen
 * view (`{ roster, screen, join }`) in the room's language, in bubble
 * gum (docs/snug-design.md §11): the lobby; a board (the quilted
 * cushion, the candies placed on it, everyone's cursors and pings, the
 * team with the pieces each still holds, the clock) through solved (the
 * faces smile, confetti, the time back, the spares) and time's up (the
 * solution and every hand); the end with the awards. Players' names are
 * always text.
 */

import { joinText, PartyClient, qrSvg } from "/_tvpipe/lib/client.js";
import { cushion, initial, piece, pointer, s, shade } from "../phone/candy.js";
import { watchFit } from "../phone/fit.js";
import { pickLang } from "../phone/i18n.js";
import { sfx } from "./sound.js";
import { strings } from "./strings.js";

const params = new URLSearchParams(location.hash.slice(1));
// tvpipe's join badge sits bottom left, under the team.
const client = PartyClient.fromLocation({ role: /** @type {any} */ (params.get("role") ?? "screen"), rejoinBadge: { corner: "bottom-left" } });
const stage = /** @type {HTMLElement} */ (document.getElementById("stage"));
const statusBar = /** @type {HTMLElement} */ (document.getElementById("status"));
const sky = /** @type {HTMLElement} */ (document.getElementById("sky"));
const reduced = matchMedia("(prefers-reduced-motion: reduce)");

let lang = pickLang(undefined);
let t = strings(lang);

// ---------------------------------------------------------------------------
// Helpers

/**
 * @param {string} tag
 * @param {Record<string, any>} [attrs]
 * @param {...(Node | string | null | undefined | false)} kids
 * @returns {HTMLElement}
 */
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = v;
    else if (k === "style" && typeof v === "object") for (const [p, x] of Object.entries(v)) el.style.setProperty(p, String(x));
    else if (v !== false && v != null) el.setAttribute(k, String(v));
  }
  for (const kid of kids) if (kid) el.append(kid);
  return el;
}

const isColor = (/** @type {unknown} */ c) => typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c);
/** A player's colour from the screen view. @param {string | undefined | null} id */
function colorOf(id) {
  const c = id ? client.view?.screen?.colors?.[id] : undefined;
  return isColor(c) ? c : "#b9a3c9";
}
/** @param {string | undefined | null} id */
function nameOf(id) {
  return (client.view?.roster ?? []).find((/** @type {any} */ r) => r.id === id)?.name ?? "?";
}

/** @typedef {[number, number]} Cell */

/** Cells moved to the top left. @param {Cell[]} cells @returns {Cell[]} */
function norm(cells) {
  const mx = Math.min(...cells.map((c) => c[0]));
  const my = Math.min(...cells.map((c) => c[1]));
  return cells.map(([x, y]) => [x - mx, y - my]);
}

/** A small candy in its own SVG (team list, lobby). @param {Cell[]} cells @param {string} color @param {object} [o] */
function mini(cells, color, o = {}) {
  const n = norm(cells);
  const w = Math.max(...n.map((c) => c[0])) + 1;
  const hh = Math.max(...n.map((c) => c[1])) + 1;
  const svg = s("svg", { viewBox: `-0.15 -0.15 ${w + 0.3} ${hh + 0.3}`, class: "mini", style: `--w:${w + 0.3};--h:${hh + 0.3}` });
  svg.append(piece(n, color, { inset: 0.05, ...o }));
  return svg;
}

/** The logo: puffy letters with a white rim, a bow on top. @param {string} [cls] */
function logo(cls = "") {
  const svg = s("svg", { viewBox: "0 0 330 130", class: `logo ${cls}`, "aria-label": "Snug" });
  const defs = s("defs");
  const grad = s("linearGradient", { id: `lg${cls}`, x1: 0, y1: 0, x2: 0, y2: 1 });
  grad.append(s("stop", { offset: 0, "stop-color": "#ff8cc0" }), s("stop", { offset: 1, "stop-color": "#ff3d8e" }));
  defs.append(grad);
  svg.append(defs);
  const word = (/** @type {Record<string, string | number>} */ a) => {
    const x = s("text", { x: 150, y: 108, "text-anchor": "middle", class: "lw", ...a });
    x.textContent = "snug";
    return x;
  };
  svg.append(word({ fill: "#d81b6a", stroke: "#d81b6a", "stroke-width": 18, transform: "translate(0 7)" }));
  svg.append(word({ fill: `url(#lg${cls})`, stroke: "#fff", "stroke-width": 14, "paint-order": "stroke", "stroke-linejoin": "round" }));
  svg.append(word({ fill: "none", stroke: "#fff", "stroke-width": 3, "stroke-opacity": 0.55, transform: "translate(-2 -4) scale(1)", class: "lw shine" }));
  // The bow, tilted on the g.
  const bow = s("g", { transform: "translate(262 26) rotate(18)", class: "bow" });
  bow.append(
    s("path", { d: "M0 0C-26-22-46-6-40 10C-36 22-14 18 0 0Z", fill: "#ff4f9a", stroke: "#fff", "stroke-width": 5, "paint-order": "stroke" }),
    s("path", { d: "M0 0C26-22 46-6 40 10C36 22 14 18 0 0Z", fill: "#ff4f9a", stroke: "#fff", "stroke-width": 5, "paint-order": "stroke" }),
    s("path", { d: "M-24-4C-20-10-12-8-8-2", fill: "none", stroke: "#fff", "stroke-width": 3, "stroke-linecap": "round", "stroke-opacity": 0.7 }),
    s("circle", { r: 9, fill: "#ff2f86", stroke: "#fff", "stroke-width": 4 }),
  );
  svg.append(bow);
  return svg;
}

// ---------------------------------------------------------------------------
// The sky: polka dots (CSS) and a few floating hearts, stars and sparkles.

const SHAPES = {
  heart: "M0 3C-6-4-12 2-6 8L0 13L6 8C12 2 6-4 0 3Z",
  star: "M0-8L2.4-2.5L8.5-2.5L3.6 1.3L5.4 7.5L0 3.9L-5.4 7.5L-3.6 1.3L-8.5-2.5L-2.4-2.5Z",
  sparkle: "M0-9Q1-1 9 0Q1 1 0 9Q-1 1-9 0Q-1-1 0-9Z",
};
const SKY_COLORS = ["#ff8cc0", "#ffd24d", "#9fd8ff", "#c9a8ff", "#8fe3c0", "#ffffff"];
for (let i = 0; i < 16; i++) {
  const kind = /** @type {keyof typeof SHAPES} */ (["heart", "star", "sparkle"][i % 3]);
  const svg = s("svg", { viewBox: "-10 -10 20 24", class: "float" });
  svg.append(s("path", { d: SHAPES[kind], fill: SKY_COLORS[(i * 5) % SKY_COLORS.length] }));
  svg.style.setProperty("left", `${(i * 61.8) % 100}%`);
  svg.style.setProperty("top", `${(i * 37.3 + 11) % 100}%`);
  svg.style.setProperty("--s", `${16 + ((i * 7) % 18)}px`);
  svg.style.setProperty("--d", `${9 + ((i * 3) % 8)}s`);
  svg.style.setProperty("--dl", `${-(i * 1.7) % 9}s`);
  sky.append(svg);
}

// ---------------------------------------------------------------------------
// Scenes

/** @typedef {{ el: HTMLElement, update?: (view: any) => void, frame?: (now: number) => void, dispose?: () => void }} Scene */

/** @type {Scene | null} */
let scene = null;
let sceneKey = "";
/** @type {ReturnType<typeof setTimeout>[]} */
let timers = [];
function later(/** @type {number} */ ms, /** @type {() => void} */ fn) {
  timers.push(setTimeout(fn, ms));
}

client.on("view", (view) => render(view));
client.on("status", (st) => {
  statusBar.hidden = st === "open";
  statusBar.textContent = st === "reconnecting" || st === "connecting" ? t.reconnecting : st === "closed" ? t.over : "";
});

/** @param {any} view */
function keyOf(view) {
  const sc = view.screen ?? {};
  if (sc.phase === "board" || sc.phase === "solved" || sc.phase === "over") return `board:${sc.board ?? ""}`;
  return String(sc.phase ?? "");
}

/** @param {any} view */
function render(view) {
  const sc = view.screen ?? {};
  const l = pickLang(sc.lang);
  const relang = l !== lang;
  if (relang) {
    lang = l;
    t = strings(l);
    document.documentElement.lang = l;
  }
  const k = keyOf(view);
  if (k !== sceneKey || relang) {
    sceneKey = k;
    for (const x of timers) clearTimeout(x);
    timers = [];
    const old = scene;
    old?.dispose?.();
    if (old) {
      old.el.classList.add("leaving");
      setTimeout(() => old.el.remove(), 500);
    }
    scene = build(view);
    stage.append(scene.el);
  }
  scene?.update?.(view);
  client.joinVisible = sc.phase === "lobby" || !sc.phase;
}

function frame(/** @type {number} */ now) {
  scene?.frame?.(now);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

/** @param {any} view @returns {Scene} */
function build(view) {
  const sc = view.screen ?? {};
  switch (sc.phase) {
    case "lobby":
      return lobby();
    case "board":
    case "solved":
    case "over":
      return board(sc);
    case "final":
      return final();
    default:
      return { el: h("div", { class: "scene lobby" }, logo()) };
  }
}

// ---------------------------------------------------------------------------
// The lobby

/** Candy shapes for the players waiting in the lobby, one each. */
const LOBBY_SHAPES = /** @type {Cell[][]} */ ([
  [[0, 0], [1, 0], [0, 1], [1, 1]],
  [[0, 0], [1, 0], [2, 0], [1, 1]],
  [[0, 0], [0, 1], [1, 1], [1, 2]],
  [[0, 0], [1, 0], [2, 0], [0, 1]],
  [[1, 0], [0, 1], [1, 1], [2, 1], [1, 2]],
  [[0, 0], [1, 0], [2, 0]],
  [[0, 0], [1, 0], [1, 1], [2, 1]],
  [[0, 0], [0, 1], [1, 0]],
]);

/** @returns {Scene} */
function lobby() {
  const qr = h("div", { class: "qr" });
  const short = h("div", { class: "short" });
  const jar = h("div", { class: "jar" });
  const hint = h("p", { class: "hint" });
  const count = h("span", { class: "count" });
  const opts = h("p", { class: "opts" });
  const el = h(
    "div",
    { class: "scene lobby" },
    h(
      "div",
      { class: "left" },
      logo("big"),
      h("p", { class: "tagline", "data-fit": "2" }, t.tagline),
      h("ol", { class: "how" }, ...t.how.map(([b, x], i) => h("li", { style: { "--c": ["#ff5fa2", "#3fa9ff", "#22c993"][i] ?? "#ff5fa2" } }, h("b", {}, h("i", {}, String(i + 1)), b), h("span", {}, x)))),
      opts,
    ),
    h("div", { class: "right" }, h("div", { class: "joincard" }, h("div", { class: "qrbox" }, qr), h("div", { class: "jointext" }, h("b", {}, t.scanToJoin), short)), h("div", { class: "jarbox" }, h("h2", {}, t.players, count), jar, hint)),
  );
  /** @type {Map<string, HTMLElement>} */
  const shown = new Map();
  let qrUrl = "";
  return {
    el,
    update(v) {
      const sc = v.screen ?? {};
      if (v.join?.url && v.join.url !== qrUrl) {
        qrUrl = v.join.url;
        qr.innerHTML = qrSvg(v.join.qr, { quiet: 2 });
      }
      const text = joinText(v.join) ?? "";
      short.textContent = text;
      short.hidden = !text;
      const roster = /** @type {any[]} */ (v.roster ?? []);
      count.textContent = ` ${roster.length} / ${sc.maxPlayers ?? 8}`;
      const kids = roster.map((r, i) => {
        let c = shown.get(r.id);
        if (!c) {
          c = h("div", { class: "sweet drop" }, mini(LOBBY_SHAPES[i % LOBBY_SHAPES.length] ?? [[0, 0]], colorOf(r.id), { key: r.id, mood: "happy" }), h("span", { class: "nm", "data-fit": "1" }, r.name));
          const el2 = c;
          shown.set(r.id, c);
          later(900, () => el2.classList.remove("drop"));
          if (shown.size > 1) sfx.join();
        }
        c.classList.toggle("away", !r.connected);
        c.classList.toggle("vip", !!r.vip);
        const color = colorOf(r.id);
        if (c.dataset["c"] !== color) {
          c.dataset["c"] = color;
          c.querySelector("svg")?.replaceWith(mini(LOBBY_SHAPES[i % LOBBY_SHAPES.length] ?? [[0, 0]], color, { key: r.id, mood: "happy" }));
        }
        return c;
      });
      for (const [id, c] of shown) if (!roster.some((r) => r.id === id)) (shown.delete(id), c.remove());
      jar.replaceChildren(...kids);
      const min = sc.minPlayers ?? 2;
      const vip = roster.find((r) => r.vip);
      hint.textContent = roster.length < min ? t.needed(min - roster.length) : t.vipStarts(vip?.name);
      opts.textContent = `${t.levelLabel} ${t.levels[/** @type {"easy"} */ (sc.level)] ?? ""} · ${t.paceLabel} ${t.paces[/** @type {"normal"} */ (sc.pace)] ?? ""}`;
    },
  };
}

// ---------------------------------------------------------------------------
// A board

/**
 * The clock: a candy ring that drains, the time inside; `set(ms, total)`.
 */
function clock() {
  const svg = s("svg", { viewBox: "0 0 100 100", class: "ring" });
  const track = s("circle", { cx: 50, cy: 50, r: 41, class: "track" });
  const run = s("circle", { cx: 50, cy: 50, r: 41, class: "run", pathLength: 100, transform: "rotate(-90 50 50)" });
  svg.append(s("circle", { cx: 50, cy: 50, r: 47, class: "plate" }), track, run);
  const txt = h("b", { class: "time" });
  const plus = h("span", { class: "plus" });
  const el = h("div", { class: "clock" }, svg, txt, plus);
  let last = -1;
  return {
    el,
    /** @param {number} ms @param {number} total @param {boolean} running */
    set(ms, total, running) {
      const f = Math.max(0, Math.min(1, ms / Math.max(1, total)));
      run.setAttribute("stroke-dasharray", `${(f * 100).toFixed(2)} 100`);
      const secs = Math.max(0, Math.ceil(ms / 1000));
      txt.textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
      el.classList.toggle("low", running && ms <= 15_000);
      el.classList.toggle("urgent", running && ms <= 10_000 && ms > 0);
      if (running && secs !== last && secs <= 10 && secs > 0) sfx.tick(secs % 2 === 0);
      last = secs;
    },
    /** @param {string} text */
    bonus(text) {
      plus.textContent = text;
      plus.classList.remove("show");
      void plus.offsetWidth;
      plus.classList.add("show");
    },
  };
}

/**
 * @param {any} sc0
 * @returns {Scene}
 */
function board(sc0) {
  const shape = /** @type {{ w: number, h: number, rows: string[] }} */ (sc0.shape ?? { w: 1, h: 1, rows: ["#"] });
  const pad = 0.7;
  const svg = /** @type {SVGSVGElement} */ (/** @type {unknown} */ (s("svg", { viewBox: `${-pad} ${-pad} ${shape.w + 2 * pad} ${shape.h + 2 * pad}`, class: "board" })));
  const layers = { cushion: s("g"), placed: s("g", { class: "placed" }), solution: s("g", { class: "solution" }), pings: s("g"), cursors: s("g") };
  layers.cushion.append(cushion(shape));
  svg.append(layers.cushion, layers.placed, layers.solution, layers.pings, layers.cursors);
  const ck = clock();
  const team = h("ul", { class: "team" });
  const big = h("div", { class: "bigword" });
  const caption = h("p", { class: "caption" });
  const answer = h("div", { class: "answer" });
  const confetti = h("div", { class: "confetti" });
  const boardNo = h("span", { class: "pill" });
  const done = h("span", { class: "pill soft" });
  const level = h("span", { class: "pill soft" });
  const checks = h("span", { class: "pill soft checks" });
  const el = h(
    "div",
    { class: "scene play enter" },
    h("header", {}, logo("small"), boardNo, done, level, checks, h("span", { class: "grow" }), ck.el),
    h("aside", {}, team),
    h("main", {}, svg, answer, big, caption),
    confetti,
  );
  later(700, () => el.classList.remove("enter"));
  sfx.whoosh();

  /** @type {Map<string, { g: SVGGElement, key: string, owner: string }>} */
  const placed = new Map();
  /** @type {Map<string, { g: SVGGElement, ping: number, x: number, y: number, on: boolean, t: number }>} */
  const cursors = new Map();
  let total = 0;
  let phase = "";
  let mood = /** @type {"calm" | "happy" | "sleepy"} */ ("calm");
  /** @type {any} */
  let last = sc0;

  const drawPiece = (/** @type {any} */ p, /** @type {"calm" | "happy" | "sleepy"} */ m) => {
    const g = piece(p.cells, colorOf(p.owner), { key: p.id, mood: m });
    return /** @type {SVGGElement} */ (g);
  };

  /** The placed pieces: new ones drop in, moved or recoloured ones are redrawn, lifted ones hop off. */
  const syncPlaced = (/** @type {any[]} */ list, /** @type {boolean} */ quiet) => {
    const seen = new Set();
    for (const p of list) {
      seen.add(p.id);
      const k = `${JSON.stringify(p.cells)}|${p.owner}|${mood}`;
      const had = placed.get(p.id);
      if (had && had.key === k) continue;
      const g = drawPiece(p, mood);
      if (!had || had.key.split("|")[0] !== k.split("|")[0]) {
        g.classList.add("drop");
        if (!quiet) sfx.pop();
      }
      if (had) had.g.replaceWith(g);
      else layers.placed.append(g);
      placed.set(p.id, { g, key: k, owner: p.owner });
    }
    for (const [id, x] of placed) {
      if (seen.has(id)) continue;
      placed.delete(id);
      x.g.classList.add("hop");
      setTimeout(() => x.g.remove(), 380);
      if (!quiet) sfx.squeak();
    }
  };

  const redrawAll = () => {
    for (const [id, x] of placed) {
      const p = (last.placed ?? []).find((/** @type {any} */ q) => q.id === id);
      if (!p) continue;
      const g = drawPiece(p, mood);
      x.g.replaceWith(g);
      x.g = g;
      x.key = `${JSON.stringify(p.cells)}|${p.owner}|${mood}`;
    }
  };

  /** The team down the left: a candy chip each, a sweet per piece still held (or the pieces themselves once shown). */
  /** @type {Map<string, { key: string, el: HTMLElement }>} */
  const chips = new Map();
  const syncTeam = (/** @type {any} */ sc, /** @type {any[]} */ roster) => {
    const ids = /** @type {string[]} */ (sc.team ?? []);
    const shown = sc.phase === "solved" ? sc.spares : sc.phase === "over" && reveal ? sc.hands : null;
    const kids = ids.map((id) => {
      const r = roster.find((x) => x.id === id);
      const n = sc.counts?.[id] ?? 0;
      const color = colorOf(id);
      const name = r?.name ?? nameOf(id);
      const own = shown ? shown.filter((/** @type {any} */ p) => p.owner === id) : null;
      // Rebuilt only when something on it changed (the cursors update the view ten times a second).
      const key = JSON.stringify([name, color, r?.connected !== false, n, own?.map((/** @type {any} */ p) => p.cells) ?? null, sc.phase]);
      const had = chips.get(id);
      if (had && had.key === key) return had.el;
      const el = h(
        "li",
        { class: `${r?.connected === false ? "away" : ""}${had ? " still" : ""}`, style: { "--c": color, "--c2": shade(color, 0.75) } },
        h("span", { class: "badge" }, initial(name)),
        h("span", { class: "who" }, h("b", { "data-fit": "1" }, name), own && own.length && sc.phase === "solved" ? h("small", {}, t.spares) : null),
        own
          ? h("span", { class: "hand" }, ...own.map((/** @type {any} */ p) => mini(p.cells, color, { key: JSON.stringify(p.cells), mood: sc.phase === "over" ? "sleepy" : "calm" })))
          : h("span", { class: "sweets" }, ...Array.from({ length: Math.min(n, 6) }, () => h("i"))),
      );
      chips.set(id, { key, el });
      return el;
    });
    const same = kids.length === team.children.length && kids.every((k, i) => team.children[i] === k);
    if (!same) team.replaceChildren(...kids);
  };

  let reveal = false;
  const showSolution = () => {
    reveal = true;
    layers.placed.classList.add("fade");
    layers.solution.replaceChildren(...(last.solution ?? []).map((/** @type {any} */ p, /** @type {number} */ i) => {
      const g = piece(p.cells, colorOf(p.owner), { key: `s${i}`, mood: "calm" });
      g.classList.add("drop");
      g.style.setProperty("animation-delay", `${i * 90}ms`);
      return g;
    }));
    caption.textContent = t.couldHave;
    caption.classList.add("show");
    syncTeam(last, client.view?.roster ?? []);
  };

  return {
    el,
    update(v) {
      const sc = v.screen ?? {};
      last = sc;
      const roster = v.roster ?? [];
      boardNo.textContent = t.boardN(sc.board ?? 1);
      done.textContent = t.solvedN(sc.solved ?? 0);
      level.textContent = t.levels[/** @type {"easy"} */ (sc.level)] ?? "";
      if (sc.phase !== phase) {
        const was = phase;
        phase = sc.phase;
        if (phase === "board" && sc.deadline) total = Math.max(1000, sc.deadline - client.now());
        if (phase === "solved") {
          mood = "happy";
          syncPlaced(sc.placed ?? [], was === "");
          redrawAll();
          svg.classList.add("bounce");
          big.textContent = t.snug;
          big.className = "bigword show snug";
          if (sc.by || sc.earned) {
            caption.textContent = [sc.by ? t.finished(nameOf(sc.by)) : "", sc.earned ? t.earned : ""].filter(Boolean).join(" · ");
            caption.classList.add("show");
          }
          if (sc.bonus) ck.bonus(t.back(Math.round(sc.bonus / 1000)));
          burst(confetti);
          sfx.solved();
        }
        if (phase === "over") {
          mood = "sleepy";
          syncPlaced(sc.placed ?? [], true);
          redrawAll();
          big.textContent = t.timesUp;
          big.className = "bigword show over";
          sfx.timesUp();
          later(2600, () => {
            big.classList.remove("show");
            showSolution();
          });
        }
      }
      if (phase === "board") syncPlaced(sc.placed ?? [], false);
      checks.textContent = sc.checks === null || sc.checks === undefined ? t.checksAny : t.checksN(sc.checks);
      const c = phase === "board" ? sc.check : null;
      const answerKey = c ? `${c.n}` : "";
      if (answer.dataset["k"] !== answerKey) {
        answer.dataset["k"] = answerKey;
        if (c) {
          answer.textContent = c.result === "stuck" ? t.stuck(nameOf(c.by)) : t.open(nameOf(c.by));
          answer.className = `answer show ${c.result}`;
          if (c.result === "stuck") sfx.uhoh();
          else sfx.yes();
        } else answer.className = `answer ${answer.className.includes("stuck") ? "stuck" : "open"}`;
      }
      syncTeam(sc, roster);
      // Cursors: placed from the view, faded in the frame loop; a new ping rings.
      const cs = sc.cursors ?? {};
      for (const [id, c] of Object.entries(cs)) {
        if (id === undefined) continue;
        let cur = cursors.get(id);
        if (!cur) {
          const g = pointer(colorOf(id), initial(nameOf(id)));
          layers.cursors.append(g);
          cur = { g, ping: c.ping ?? 0, x: c.x, y: c.y, on: c.on, t: c.t };
          cursors.set(id, cur);
        }
        if ((c.ping ?? 0) > cur.ping) ring(layers.pings, c.x, c.y, colorOf(id));
        Object.assign(cur, { ping: c.ping ?? 0, x: c.x, y: c.y, on: c.on, t: c.t });
      }
      for (const [id, cur] of cursors) if (!cs[id]) (cur.g.remove(), cursors.delete(id));
    },
    frame() {
      const sc = last;
      const now = client.now();
      if (phase === "board" && sc.deadline) ck.set(sc.deadline - now, total, true);
      else ck.set(sc.left ?? 0, Math.max(total, sc.left ?? 0), false);
      for (const cur of cursors.values()) {
        const age = now - cur.t;
        const op = cur.on ? 1 : Math.max(0, 1 - Math.max(0, age) / 3000);
        cur.g.style.transform = `translate(${cur.x}px, ${cur.y}px)`;
        cur.g.setAttribute("opacity", phase === "board" ? op.toFixed(2) : "0");
      }
    },
  };
}

/** A ping: rings popping out where a cursor tapped. @param {SVGElement} layer @param {number} x @param {number} y @param {string} color */
function ring(layer, x, y, color) {
  for (let i = 0; i < 2; i++) {
    const c = s("circle", { cx: x, cy: y, r: 0.2, class: "pingring", stroke: color, style: `animation-delay:${i * 160}ms` });
    layer.append(c);
    setTimeout(() => c.remove(), 1400);
  }
  sfx.chime();
}

/** Confetti: candy-coloured bits falling over the scene. @param {HTMLElement} box */
function burst(box) {
  if (reduced.matches) return;
  const colors = ["#ff5fa2", "#3fa9ff", "#22c993", "#ffb81f", "#9b7bff", "#ff7f36", "#ffffff"];
  box.replaceChildren();
  for (let i = 0; i < 70; i++) {
    const bit = h("i", {
      style: {
        left: `${(i * 37) % 100}%`,
        background: colors[i % colors.length],
        "--dx": `${((i * 53) % 120) - 60}px`,
        "--r": `${(i * 97) % 720}deg`,
        "--d": `${1.6 + ((i * 13) % 14) / 10}s`,
        "--dl": `${((i * 7) % 10) / 20}s`,
        "border-radius": i % 3 === 0 ? "50%" : "3px",
      },
    });
    box.append(bit);
  }
  setTimeout(() => box.replaceChildren(), 4000);
}

// ---------------------------------------------------------------------------
// The end

/** @returns {Scene} */
function final() {
  const headline = h("h1", {});
  const num = h("div", { class: "num" });
  const sub = h("p", { class: "sub" });
  const awards = h("div", { class: "awards" });
  const again = h("p", { class: "again" }, t.again);
  const confetti = h("div", { class: "confetti" });
  const el = h("div", { class: "scene final" }, logo("small"), headline, num, sub, awards, again, confetti);
  let first = true;
  return {
    el,
    update(v) {
      const sc = v.screen ?? {};
      const n = sc.solved ?? 0;
      headline.textContent = n > 0 ? t.gameOver : t.noneDone;
      num.textContent = n > 0 ? t.n(n) : "";
      num.hidden = n === 0;
      sub.textContent = n > 0 ? `${t.boardsDone(n)} · ${n >= (sc.best ?? 0) && n > 0 ? t.newBest : t.best(sc.best ?? 0)}` : t.best(sc.best ?? 0);
      const list = /** @type {const} */ (["fit", "pointer", "thoughts"]);
      awards.replaceChildren(
        ...list.flatMap((k, i) => {
          const a = sc.awards?.[k];
          if (!a) return [];
          const color = colorOf(a.id);
          return [
            h(
              "div",
              { class: "award", style: { "--c": color, "--d": `${0.4 + i * 0.25}s` } },
              mini(LOBBY_SHAPES[i] ?? [[0, 0]], color, { key: a.id, mood: "happy" }),
              h("b", { "data-fit": "1" }, t.awards[k][0]),
              h("span", { class: "nm", "data-fit": "1" }, a.name),
              h("small", {}, `${t.n(a.n)} · ${t.awards[k][1]}`),
            ),
          ];
        }),
      );
      if (first) {
        first = false;
        if (n > 0) {
          burst(confetti);
          sfx.tune();
        }
      }
    },
  };
}

watchFit();

client.connect().catch((e) => {
  stage.replaceChildren(h("div", { class: "scene lobby" }, logo("big"), h("p", { class: "hint" }, e?.message ?? String(e))));
});
