// @ts-check
/**
 * The classroom's drawings, in SVG: the wall clock, the school bell, a
 * raised hand, gold stars, pushpins, the scribbles in the exercise books
 * (abstract ink, never letters) and the red pen's marks (a strike, a
 * tick, a circle, a bracket), each wobbly but the same every time for the
 * same key.
 */

import { rng, svg } from "./dom.js";

/** @param {number} x */
const r1 = (x) => Math.round(x * 10) / 10;

/** A path through points, smoothed (quadratic curves through the midpoints). @param {[number, number][]} pts */
export function smooth(pts) {
  if (pts.length < 2) return "";
  let d = `M${r1(pts[0]?.[0] ?? 0)} ${r1(pts[0]?.[1] ?? 0)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [x, y] = /** @type {[number, number]} */ (pts[i]);
    const [nx, ny] = /** @type {[number, number]} */ (pts[i + 1]);
    d += ` Q${r1(x)} ${r1(y)} ${r1((x + nx) / 2)} ${r1((y + ny) / 2)}`;
  }
  const last = /** @type {[number, number]} */ (pts.at(-1));
  return `${d} L${r1(last[0])} ${r1(last[1])}`;
}

// ---------------------------------------------------------------------------
// The wall clock

/**
 * The wall clock: a white face with minute marks, black hands showing the
 * time of day, the red second hand, and (while a deadline runs) a wedge
 * for the time left. `set(o)` moves it.
 */
export function wallClock() {
  const R = 100;
  const marks = [];
  for (let i = 0; i < 60; i++) {
    const big = i % 5 === 0;
    const a = (i / 60) * Math.PI * 2;
    const r0 = big ? 72 : 80;
    marks.push(svg("line", { x1: r1(Math.sin(a) * r0), y1: r1(-Math.cos(a) * r0), x2: r1(Math.sin(a) * 88), y2: r1(-Math.cos(a) * 88), class: big ? "hour-mark" : "min-mark" }));
  }
  const wedge = svg("path", { class: "wedge", d: "" });
  const hour = svg("line", { class: "hand hour", x1: 0, y1: 10, x2: 0, y2: -48 });
  const minute = svg("line", { class: "hand minute", x1: 0, y1: 14, x2: 0, y2: -74 });
  const second = svg("g", { class: "hand second" }, svg("line", { x1: 0, y1: 20, x2: 0, y2: -58 }), svg("circle", { cx: 0, cy: -62, r: 9 }));
  const el = svg(
    "svg",
    { viewBox: `${-R} ${-R} ${2 * R} ${2 * R}`, class: "wallclock", "aria-hidden": "true" },
    svg("circle", { r: 98, class: "rim" }),
    svg("circle", { r: 90, class: "face" }),
    wedge,
    ...marks,
    hour,
    minute,
    second,
    svg("circle", { r: 5, class: "pivot" }),
  );
  return {
    el,
    /**
     * @param {{ date: Date, left?: number, total?: number }} o `left` and `total` in ms for the wedge
     */
    set(o) {
      const d = o.date;
      const s = d.getSeconds() + d.getMilliseconds() / 1000;
      // The second hand jumps a little at each second, as a wall clock's does.
      const tick = Math.floor(s) + Math.min(1, (s % 1) * 6);
      const m = d.getMinutes() + s / 60;
      const hr = (d.getHours() % 12) + m / 60;
      hour.setAttribute("transform", `rotate(${r1(hr * 30)})`);
      minute.setAttribute("transform", `rotate(${r1(m * 6)})`);
      second.setAttribute("transform", `rotate(${r1(tick * 6)})`);
      if (o.left === undefined || !o.total || o.left <= 0) {
        wedge.setAttribute("d", "");
        return;
      }
      const share = Math.min(1, o.left / o.total);
      if (share >= 0.9999) {
        wedge.setAttribute("d", "M0 -90 A90 90 0 1 1 0 90 A90 90 0 1 1 0 -90 Z");
        return;
      }
      const a = share * Math.PI * 2;
      const x = Math.sin(a) * 90;
      const y = -Math.cos(a) * 90;
      wedge.setAttribute("d", `M0 0 L0 -90 A90 90 0 ${share > 0.5 ? 1 : 0} 1 ${r1(x)} ${r1(y)} Z`);
    },
  };
}

// ---------------------------------------------------------------------------
// Things on the wall and the desk

/** The school bell: a red gong on the wall, the electric hammer below it. */
export function bell() {
  return svg(
    "svg",
    { viewBox: "-70 -76 140 170", class: "bell", "aria-hidden": "true" },
    svg("rect", { x: -12, y: -76, width: 24, height: 18, rx: 3, class: "plate" }),
    svg(
      "g",
      { class: "gong" },
      svg("circle", { r: 58, class: "dome" }),
      svg("circle", { r: 44, class: "inner" }),
      svg("path", { d: "M-40 -22 A46 46 0 0 1 -14 -42", class: "shine" }),
      svg("circle", { r: 9, class: "knob" }),
    ),
    svg("rect", { x: -24, y: 66, width: 48, height: 26, rx: 5, class: "plate" }),
    svg("g", { class: "hammer" }, svg("line", { x1: 0, y1: 70, x2: 0, y2: 62 }), svg("circle", { cx: 0, cy: 60, r: 8 })),
  );
}

/** A raised hand (Stop!). */
export function raisedHand() {
  return svg(
    "svg",
    { viewBox: "0 0 48 64", class: "raised", "aria-hidden": "true" },
    svg("rect", { x: 17, y: 44, width: 16, height: 20, rx: 3, class: "sleeve" }),
    svg("path", {
      class: "palm",
      d: "M12 30 L12 12 Q12 8 15.5 8 Q19 8 19 12 L19 26 L19 6 Q19 2 22.5 2 Q26 2 26 6 L26 26 L26 7 Q26 3.5 29.5 3.5 Q33 3.5 33 7 L33 27 L33 12 Q33 9 36 9 Q39 9 39 12 L39 34 Q39 48 28 50 L22 50 Q14 49 10 42 L4 31 Q2.5 27.5 5.5 26.5 Q8.5 25.5 10.5 28.5 Z",
    }),
  );
}

/** A gold star sticker. @param {string} [cls] */
export function star(cls = "star") {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    const r = i % 2 === 0 ? 46 : 20;
    pts.push(`${r1(Math.sin(a) * r)},${r1(-Math.cos(a) * r)}`);
  }
  return svg("svg", { viewBox: "-50 -50 100 100", class: cls, "aria-hidden": "true" }, svg("polygon", { points: pts.join(" "), class: "body" }), svg("path", { d: "M-6 -30 L-12 -12", class: "gleam" }));
}

/** A pushpin's head. @param {string} color */
export function pin(color) {
  return svg("svg", { viewBox: "-12 -12 24 24", class: "pin", "aria-hidden": "true" }, svg("circle", { r: 10, fill: color }), svg("circle", { cx: -3, cy: -3, r: 3, class: "shine" }));
}

// ---------------------------------------------------------------------------
// Ink in the exercise books

/**
 * A scribble: handwriting-like loops that are no letters, seeded by
 * `key`, filling about a third, two thirds or nearly all of a `w`×`ht`
 * line (`level` 1–3, the `progress` of a column).
 * @param {string} key @param {number} level @param {number} w @param {number} ht
 */
export function scribble(key, level, w, ht) {
  const rand = rng(`${key}|${level}`);
  const share = level <= 1 ? 0.22 + rand() * 0.12 : level === 2 ? 0.48 + rand() * 0.14 : 0.8 + rand() * 0.14;
  const end = w * share;
  const base = ht * 0.78;
  const xh = ht * 0.34;
  /** @type {string[]} */
  const paths = [];
  let x = 2 + rand() * 4;
  while (x < end - 6) {
    // One "word": loops of a cursive hand, now and then a tall one.
    const len = Math.min(end - x, (level <= 1 ? 0.6 : 0.3 + rand() * 0.5) * w * 0.4 + 10);
    /** @type {[number, number][]} */
    const pts = [];
    const loops = Math.max(2, Math.round(len / (xh * 0.9)));
    const step = len / loops;
    for (let k = 0; k < loops; k++) {
      const tall = rand() < 0.18 ? 1.9 : rand() < 0.12 ? -0.6 : 1;
      const amp = xh * (0.75 + rand() * 0.4) * tall;
      const x0 = x + k * step;
      for (let s = 0; s <= 6; s++) {
        const t = (s / 6) * Math.PI * 2;
        const lx = x0 + (step * s) / 6 - Math.sin(t) * step * 0.45;
        const ly = base - (amp * (1 - Math.cos(t))) / 2;
        pts.push([lx, Math.min(ht - 1, Math.max(1, ly))]);
      }
    }
    paths.push(smooth(pts));
    x += len + xh * (0.8 + rand() * 0.8);
  }
  return svg("svg", { viewBox: `0 0 ${w} ${ht}`, width: w, height: ht, class: "scribble", "aria-hidden": "true" }, svg("path", { d: paths.join(" ") }));
}

// ---------------------------------------------------------------------------
// The red pen

/** A tick, about 40×30. */
export const TICK = "M3 17 Q8 20 13 28 Q22 10 40 2";

/** A loose hand-drawn circle around a `w`×`ht` box, its ends overlapping. @param {string} key @param {number} w @param {number} ht */
export function circlePath(key, w, ht) {
  const rand = rng(`circle|${key}`);
  /** @type {[number, number][]} */
  const pts = [];
  const cx = w / 2;
  const cy = ht / 2;
  const turns = 1.12;
  for (let i = 0; i <= 28; i++) {
    const t = (i / 28) * turns * Math.PI * 2 - 2.2;
    const wob = 1 + (rand() - 0.5) * 0.08;
    pts.push([cx + Math.cos(t) * (w / 2) * wob, cy + Math.sin(t) * (ht / 2) * wob]);
  }
  return smooth(pts);
}

/** A curly bracket on the right of a `ht`-tall stack of lines, `w` wide. @param {number} w @param {number} ht */
export function bracketPath(w, ht) {
  const m = ht / 2;
  const c = Math.min(18, ht / 6);
  return `M0 2 Q${r1(w * 0.55)} 2 ${r1(w * 0.55)} ${r1(c)} L${r1(w * 0.55)} ${r1(m - c)} Q${r1(w * 0.55)} ${r1(m)} ${w} ${r1(m)} Q${r1(w * 0.55)} ${r1(m)} ${r1(w * 0.55)} ${r1(m + c)} L${r1(w * 0.55)} ${r1(ht - c)} Q${r1(w * 0.55)} ${r1(ht - 2)} 0 ${r1(ht - 2)}`;
}
