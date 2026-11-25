// @ts-check
/**
 * Grading on the TV: the open exercise book of one column (a double page
 * of squared paper in the subject's cover), a line per player with the
 * answer in their handwriting, the red brackets of the same answers, the
 * answers struck by rule, who is done; then the teacher's red pen (the
 * strikes, the ticks, the circled points, a note now and then, the gold
 * stars); and the encyclopedia page that slides over it for Wikipedia.
 */

import { bracketPath, circlePath, star, TICK } from "./art.js";
import { h, rng, svg } from "./dom.js";
import { env, handOf, keepNames, now, person, subj } from "./env.js";
import { sound } from "./sound.js";
import { tab } from "./board.js";

/** @typedef {import("./screen.js").Scene} Scene */
/** @typedef {import("./env.js").Answer} Answer */
/** @typedef {import("./env.js").Mark} Mark */

/** @typedef {{ a: Answer, who: string, text: string, first: boolean, last: boolean, size: number, index: number }} Line */

/** The page's body height (px) the lines share. */
const BODY = 486;

/**
 * The lines of the book, split over its two pages so that the fuller page
 * has as few lines as can be: at a group boundary, or inside a big group
 * when that saves two lines or more (its bracket then goes on in the
 * other page). On a tie the left page takes more.
 * @param {Answer[]} answers @returns {[Line[], Line[]]}
 */
function pages(answers) {
  /** @type {Line[]} */
  const all = answers.flatMap((a) => {
    const who = Array.isArray(a.who) ? a.who : [];
    return who.map((id, j) => ({ a, who: id, text: String(a.texts?.[j] ?? a.texts?.[0] ?? ""), first: j === 0, last: j === who.length - 1, size: who.length, index: 0 }));
  });
  const total = all.length;
  let best = 0;
  let bestCost = Infinity;
  for (let i = 0; i <= total; i++) {
    const boundary = i === 0 || i === total || all[i - 1]?.a !== all[i]?.a;
    const cost = Math.max(i, total - i) + (boundary ? 0 : 1.5);
    if (cost <= bestCost) {
      bestCost = cost;
      best = i;
    }
  }
  all.forEach((l, i) => (l.index = i));
  return [all.slice(0, best), all.slice(best)];
}

/** @param {Record<string, any>} s @returns {Scene} */
export function gradeScene(s) {
  const t = env.t;
  const marked = s.stage === "marked";
  /** @type {import("./env.js").Column[]} */
  const cols = Array.isArray(s.columns) ? s.columns : [];
  const ci = Number(s.col) || 0;
  const col = cols[ci] ?? { subject: "register", text: "" };
  const letter = String(s.letter ?? "");
  /** @type {Answer[]} */
  const answers = Array.isArray(s.answers) ? s.answers : [];
  /** @type {Map<string, Mark>} */
  const marks = new Map((Array.isArray(s.marks) ? s.marks : []).map((m) => [m.id, m]));
  const [left, right] = pages(answers);
  const lines = left.length + right.length;
  // Up to three lines (two or three players): one wide page with big lines, no half-empty double page.
  const single = lines <= 3;
  const lineH = Math.floor(single ? BODY / Math.max(2, lines) : BODY / Math.max(4, left.length, right.length));
  const af = lineH >= 200 ? 84 : lineH >= 150 ? 72 : lineH >= 110 ? 62 : lineH >= 90 ? 52 : 46;
  const step = Math.min(0.6, Math.max(0.25, (2 + 0.6 * lines - 2.2) / Math.max(1, lines)));
  const rand = rng(`notes:${s.round}:${ci}`);

  /** @type {Map<string, HTMLElement>} */
  const ticks = new Map();
  /** @type {{ at: number, sound: "scratch" | "pling" }[]} */
  const cues = [];

  /** @param {Line} l */
  function line(l) {
    const a = l.a;
    const m = marks.get(a.id);
    const auto = typeof a.auto === "string" ? a.auto : "";
    const struckByRoom = marked && !!m?.struck && !auto;
    const delay = 0.6 + l.index * step;
    const words = h("span", { class: "t" }, auto === "empty" ? "—" : l.text);
    const textEl = h("div", { class: `ans ${handOf(l.who)}${auto === "empty" ? " empty" : ""}`, "data-fit": "box" }, h("span", { class: "w" }, words));
    // The margin note: what was clear from the start (the rule, the same answer), then what the pen adds.
    /** @type {string[]} */
    const early = [];
    /** @type {string[]} */
    const late = [];
    if (auto) early.push(t.auto[auto]?.(letter) ?? "");
    if (l.first && l.size > 1 && a.same) early.push(t.same[a.same] ?? t.same["same"] ?? "");
    if (struckByRoom && m && l.first) late.push(t.struck(m.doubts, m.of));
    if (marked && m && l.first && !auto) {
      const pick = (/** @type {string[]} */ xs) => xs[Math.floor(rand() * xs.length)] ?? "";
      if (m.struck && rand() < 0.6) late.push(pick(t.notes.struck));
      else if (!m.struck && (m.points === 20 || m.stars >= 2) && rand() < 0.7) late.push(pick(t.notes.good));
    }
    const e = early.filter(Boolean).join(" · ");
    const lt = late.filter(Boolean).join(" · ");
    const note = h(
      "div",
      { class: "note", "data-fit": "1" },
      ...(e ? [e] : []),
      lt ? h("span", { class: "late", style: { "--d": `${delay + 0.25}s` } }, `${e ? " · " : ""}${lt}`) : null,
    );
    // A strike (each line of the text): by rule from the start, by the room when the pen comes.
    if (struckByRoom) {
      words.style.setProperty("--d", `${delay}s`);
      cues.push({ at: delay, sound: "scratch" });
    }
    /** @type {Element | null} */
    let tick = null;
    if (marked && m && !m.struck && !auto) {
      tick = svg("svg", { class: "tick pen", viewBox: "0 0 44 32", style: `--d:${delay}s` }, svg("path", { d: TICK, pathLength: 1 }));
      cues.push({ at: delay, sound: "scratch" });
    }
    const ink = h("div", { class: "ink" }, textEl);
    const pts = h("div", { class: "pts" });
    if (marked && m) {
      const p = auto ? 0 : m.points;
      pts.append(
        h("span", { class: "num pop", style: { "--d": `${delay + 0.2}s` } }, String(p)),
        svg("svg", { class: "ring pen", viewBox: "0 0 60 44", style: `--d:${delay + 0.15}s` }, svg("path", { d: circlePath(`${a.id}:${l.who}`, 54, 38), transform: "translate(3 3)", pathLength: 1 })),
      );
    }
    const done = h("span", { class: "done" }, "✓");
    ticks.set(l.who, done);
    const row = h(
      "div",
      { class: `line${l.first ? " first" : ""}${l.last ? " last" : ""}${auto ? " auto" : ""}${struckByRoom ? " struck" : ""}`, "data-answer": a.id },
      h("div", { class: "margin" }, h("span", { class: "nm", "data-fit": "2" }, person(l.who).name), done, h("div", { class: "marks" }, tick)),
      h("div", { class: "cell" }, ink, note),
      pts,
    );
    // Gold stars on the answer's first line, after the pen.
    if (marked && m && m.stars > 0 && l.first && !auto) {
      const flyAt = 0.6 + lines * step + 0.2;
      const stack = h("div", { class: "stars" });
      const margin = /** @type {HTMLElement} */ (row.querySelector(".marks"));
      for (let k = 0; k < (m.stars > 3 ? 1 : m.stars); k++) {
        const st = star("star fly");
        st.setAttribute("style", `--d:${(flyAt + k * 0.25).toFixed(2)}s;--k:${k}`);
        stack.append(st);
        cues.push({ at: flyAt + k * 0.25 + 0.5, sound: "pling" });
      }
      if (m.stars > 3) stack.append(h("b", { class: "more pop", style: { "--d": `${flyAt + 0.5}s` } }, `×${m.stars}`));
      margin.append(stack);
    }
    return row;
  }

  /** The red brackets joining the lines of one answer (on one page). @param {Line[]} ls */
  function brackets(ls) {
    /** @type {Element[]} */
    const out = [];
    let i = 0;
    while (i < ls.length) {
      const l = /** @type {Line} */ (ls[i]);
      let j = i;
      while (j + 1 < ls.length && ls[j + 1]?.a === l.a) j++;
      if (j > i) {
        const top = i * lineH + 10;
        const ht = (j - i + 1) * lineH - 20;
        out.push(svg("svg", { class: "bracket", viewBox: `0 0 22 ${ht}`, width: 22, height: ht, style: `top:${top}px` }, svg("path", { d: bracketPath(20, ht) })));
      }
      i = j + 1;
    }
    return out;
  }

  /** @param {Line[]} ls @param {string} cls */
  const page = (ls, cls, /** @type {HTMLElement} */ head) =>
    h("div", { class: `pg ${cls}` }, head, h("div", { class: "lines", style: { "--lh": `${lineH}px`, "--af": `${af}px` } }, ...ls.map(line), ...brackets(ls)));

  const leftHead = h("div", { class: "head" }, tab(col.subject), h("div", { class: "title", "data-fit": "2" }, ...keepNames(col.text)));
  const rule = col.rule && t.rule[col.rule] ? t.rule[col.rule]?.(letter) ?? "" : "";
  const rightHead = h(
    "div",
    { class: "head right" },
    h("div", { class: "meta" }, h("div", { class: "of" }, t.colOf(ci + 1, cols.length)), rule ? h("div", { class: "rule", "data-fit": "1" }, rule) : null, h("div", { class: "hint", "data-fit": "1" }, marked ? "" : t.voteHint)),
    h("div", { class: `lettermark${/^[MW]$/.test(letter) ? " wide" : ""}` }, letter),
  );
  const wiki = h("div", { class: "wikislot" });
  const el = h(
    "div",
    { class: `scene grade s-${subj(col.subject)}${marked ? " marked" : ""}` },
    single
      ? h("div", { class: "book2 one" }, page([...left, ...right], "l r", h("div", { class: "heads" }, leftHead, rightHead)))
      : h("div", { class: "book2" }, page(left, "l", leftHead), h("div", { class: "spine" }), page(right, "r", rightHead)),
    wiki,
  );
  if (!marked) sound.page();
  const start = performance.now();
  for (const c of cues) setTimeout(() => sound[c.sound](), c.at * 1000);
  let total = 0;
  let wikiKey = "";
  let wikiTitle = "";
  let doneKey = "";
  void start;
  return {
    layout: "book",
    over: el,
    update(s) {
      if (!marked) {
        const left = Number(s.deadline) - now();
        if (Number.isFinite(left)) total = Math.max(total, left);
        env.clock = { deadline: Number(s.deadline) || undefined, total, red: left > 0 && left <= 5000 };
        const done = new Set(Array.isArray(s.done) ? s.done : []);
        const dk = [...done].sort().join(",");
        if (dk !== doneKey) {
          doneKey = dk;
          for (const [id, tk] of ticks) tk.classList.toggle("on", done.has(id));
        }
      } else {
        env.clock = {};
        if (!doneKey) {
          doneKey = "marked";
          for (const tk of ticks.values()) tk.classList.add("on");
        }
      }
      const w = marked ? null : s.wiki ?? null;
      const wk = JSON.stringify(w ? [w.id, w.title, w.url, w.pick, w.loading, w.error, w.query, w.by, w.at, w.disambiguation, (w.trail ?? []).length, env.lang] : null);
      if (wk !== wikiKey) {
        const was = wikiKey;
        wikiKey = wk;
        if (!w) {
          const old = wiki.firstElementChild;
          if (old) {
            old.classList.add("leave");
            setTimeout(() => old.remove(), 400);
          }
          wikiTitle = "";
        } else {
          const fresh = wikiPage(w);
          const title = `${w.title ?? ""}|${w.error ?? ""}`;
          // A new article fades in, the first slides in; scrolling (`at`) and loading change in place.
          if (was !== "null" && was !== "" && wiki.firstElementChild) fresh.classList.add(title !== wikiTitle ? "swap" : "still");
          if (title !== wikiTitle && !w.loading) sound.page();
          wikiTitle = title;
          wiki.replaceChildren(fresh);
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Wikipedia: a heavy encyclopedia's page

/** The text's sizes: from the largest down to the smallest a sofa still reads; below that, blocks go. */
const INTRO_MAX = 22;
const INTRO_MIN = 19;

/** Only Wikimedia's own pictures. @param {unknown} url */
function safeImage(url) {
  return typeof url === "string" && /^https:\/\/(upload|thumb)\.wikimedia\.org\//.test(url) ? url : null;
}

/**
 * An article's text as blocks (§7.1 `Block`, `Inline`), made with DOM
 * calls and text only: paragraphs, headings, list items (depth, number),
 * quotes; bold, italic, and links (only a look on the TV: phones follow
 * them).
 * @param {unknown} b
 */
function blockEl(b) {
  const x = /** @type {{ t?: string, c?: unknown, d?: number, n?: number }} */ (b && typeof b === "object" ? b : {});
  const kids = (Array.isArray(x.c) ? x.c : typeof x.c === "string" ? [x.c] : []).map((c) => {
    if (typeof c === "string") return c;
    const y = /** @type {{ s?: unknown, b?: boolean, i?: boolean, a?: unknown }} */ (c && typeof c === "object" ? c : {});
    const cls = [y.b ? "b" : "", y.i ? "i" : "", typeof y.a === "string" ? "a" : ""].filter(Boolean).join(" ");
    return h("span", { class: cls }, String(y.s ?? ""));
  });
  if (x.t === "h2" || x.t === "h3") return h(x.t, {}, ...kids);
  if (x.t === "quote") return h("blockquote", {}, ...kids);
  if (x.t === "li") {
    const depth = Math.max(1, Math.min(3, Number(x.d) || 1));
    return h("div", { class: `li d${depth}` }, h("span", { class: "mark" }, Number.isInteger(x.n) ? `${x.n}.` : "•"), h("span", { class: "c" }, ...kids));
  }
  return h("p", {}, ...kids);
}

/** Blocks laid out at most (from `at`): more than two columns ever hold. */
const MAX_BLOCKS = 40;

/**
 * Fills the page's two columns with the article from block `at` on:
 * a short text in one column at the largest size, else two columns, at a
 * smaller size when it does not fit; the text flows on from column to
 * column and what does not fit is cut at a line's end by the page's edge
 * (the columns go on, hidden: the page never scrolls). Blocks that fall
 * wholly behind the edge are removed.
 * @param {HTMLElement} el @param {unknown[]} blocks
 */
function fitBlocks(el, blocks) {
  const nodes = () => blocks.slice(0, MAX_BLOCKS).map(blockEl);
  const run = () => {
    if (!el.isConnected || !el.clientHeight) return;
    const over = () => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
    el.replaceChildren(...nodes());
    el.style.fontSize = `${INTRO_MAX}px`;
    el.style.columnCount = "1";
    if (!over()) return;
    el.style.columnCount = "";
    if (!over()) return;
    el.style.fontSize = `${INTRO_MIN}px`;
    // From the end only (what stays keeps its place): the blocks behind the edge, then a heading left last.
    const edge = el.getBoundingClientRect().right;
    while (el.childElementCount > 1 && (el.lastElementChild?.getBoundingClientRect().left ?? 0) >= edge - 1) el.lastElementChild?.remove();
    while (el.childElementCount > 1 && /^H[23]$/.test(el.lastElementChild?.tagName ?? "")) el.lastElementChild?.remove();
  };
  el.replaceChildren(...nodes());
  requestAnimationFrame(run);
  void document.fonts?.ready.then(run);
}

/**
 * The encyclopedia page: the article (from the driver's block `at` on),
 * or while the first lookup loads "Looking it up…", or what went wrong.
 * A later step's loading dims the last article under a spinner.
 * @param {Record<string, any>} w
 */
function wikiPage(w) {
  const t = env.t;
  const who = w.by ? person(String(w.by)).name : "";
  const query = String(w.query ?? "");
  const trail = Array.isArray(w.trail) ? w.trail.filter((x) => typeof x === "string").slice(-3) : [];
  const top = h(
    "div",
    { class: "masthead" },
    h("span", { class: "wm" }, "Wikipedia"),
    h("span", { class: "tag" }, t.encyclopedia),
    trail.length > 1 ? h("span", { class: "trail", "data-fit": "1" }, trail.join(" › ")) : null,
  );
  const foot = h("div", { class: "foot" }, h("span", { class: "by", "data-fit": "1" }, !who ? "" : w.title && !w.error && !w.loading ? t.reads(who, String(w.title)) : t.lookedUp(who, query)), h("span", { class: "credit" }, w.title && !w.error ? `${t.credit} · ${w.title}` : t.credit));
  const loading = () => h("div", { class: "center" }, h("div", { class: "spinner" }), h("p", { class: "big" }, t.looking), h("p", { class: "q", "data-fit": "1" }, t.q(query)));
  if (w.error) {
    return h("div", { class: "wiki state" }, top, h("div", { class: "center" }, h("p", { class: "big", "data-fit": "2" }, w.error === "offline" ? t.offline : t.nothing(query))), foot);
  }
  if (!w.title) return h("div", { class: "wiki state" }, top, loading(), foot);
  const at = Math.max(0, Number(w.at) || 0);
  const blocks = Array.isArray(w.blocks) ? w.blocks : [];
  // The picture belongs to the article's top: further down the text takes its room.
  const img = at === 0 ? safeImage(w.image) : null;
  const pic = img
    ? h("figure", {}, h("img", { onload: "this.closest('figure').classList.add('ok')", onerror: "this.closest('figure').remove()", alt: "", src: img }), h("figcaption", { "data-fit": "1" }, String(w.title)))
    : null;
  // The article's columns go on behind the page's edge (cut there on purpose): no layout check inside.
  const body = h("div", { class: `text${pic ? "" : " wide"}`, "data-nocheck": "" });
  fitBlocks(body, blocks.slice(Math.min(at, Math.max(0, blocks.length - 1))));
  return h(
    "div",
    { class: `wiki${w.loading ? " busy" : ""}` },
    top,
    h("h2", { "data-fit": "1" }, String(w.title)),
    w.description || w.disambiguation ? h("p", { class: "desc", "data-fit": "2" }, w.disambiguation ? t.disambiguation : String(w.description)) : null,
    h("div", { class: "rule" }),
    h("div", { class: "content" }, body, pic),
    foot,
    w.loading ? h("div", { class: "veil" }, loading()) : null,
  );
}
