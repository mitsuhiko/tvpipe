// @ts-check
/**
 * The world small, on a phone's canvas, in the TV's look (raised hex
 * tiles in their holders' colours on a dark sea): the whole world to
 * tap, or a close-up framed on a few territories (a territory and its
 * neighbours while planning, a fight during the battle) with army
 * badges, placements and the orders as arrows.
 */

import { placeNames } from "../game/names.js";
import { HEX_ROW, HEX_SIDES, HEX_W, hexCenter, hexCorners, hexNeighbors } from "../game/world.js";

/** @typedef {import("../game/world.js").World} World */
/** @typedef {{ own: string[], arm: number[] }} Board */
/**
 * An arrow: one's own orders in white (attacks solid, moves dashed),
 * the battle's in the mover's colour (`color`); `n` on its middle.
 * @typedef {{ from: number, to: number, n?: number, kind: "atk" | "move", color?: string }} Arrow
 */
/**
 * @typedef {object} MapOptions
 * @property {number} [sel] the selected territory: outlined, the rest dimmed but `hi`
 * @property {Set<number>} [hi] territories not dimmed (and outlined faintly)
 * @property {boolean} [dim] with `sel`, the rest but `hi` dimmed (true)
 * @property {Map<number, string>} [labels] badges: a territory's text (its armies)
 * @property {Map<number, number>} [plus] armies placed: a white "+3" by the badge (on the territory without one)
 * @property {Arrow[]} [arrows]
 * @property {number[]} [frame] territories to frame (a close-up); the canvas keeps its CSS height
 * @property {number} [pad] around the frame, in hexes (1.5)
 * @property {number} [maxScale] the closest a close-up gets, px per hex (20)
 * @property {View} [view] the camera, as it is (a flight between frames): instead of `frame`; the canvas keeps its CSS height
 * @property {Map<number, string>} [names] territories' names to write on the land (when close enough: not on the whole world)
 * @property {Set<number>} [strong] names in bold, chosen first (the selection, an order's two ends)
 * @property {string} [me] the player
 * @property {boolean} [regions] a light seam where continents meet on land (true)
 * @property {Map<string, string>} [regionNames] the continents' names (by id) to write in the sea next to them
 */
/** @typedef {{ s: number, ox: number, oy: number }} View px per hex radius, and the map's origin on the canvas */

export const WILD = "#d9c7a0";

/** A colour darker (k < 0) or lighter (k > 0). @param {string} hex @param {number} k */
export function shade(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => Math.round(k < 0 ? c * (1 + k) : c + (255 - c) * k));
  return `#${ch.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Per world: land hexes' centres at radius 1 with their territory, the
 * sea's, the sides between territories (and the coast), and each
 * territory's bounding box.
 * @typedef {{ land: [number, number, number][], sea: [number, number][], sides: [number, number, number, number, number, number][], boxes: [number, number, number, number][], W: number, H: number }} Geometry
 */
/** @type {WeakMap<World, Geometry>} */
const cache = new WeakMap();

/** @param {World} w @returns {Geometry} */
function geometry(w) {
  let g = cache.get(w);
  if (g) return g;
  /** @type {Geometry} */
  const geo = { land: [], sea: [], sides: [], boxes: w.territories.map(() => [Infinity, Infinity, -Infinity, -Infinity]), W: HEX_W * (w.cols + 0.5), H: HEX_ROW * (w.rows - 1) + 2 };
  for (let r = 0; r < w.rows; r++) {
    for (let c = 0; c < w.cols; c++) {
      const t = w.cells[r * w.cols + c] ?? -1;
      const [x, y] = hexCenter(c, r, 1);
      if (t < 0) {
        geo.sea.push([x, y]);
        continue;
      }
      geo.land.push([x, y, t]);
      const b = /** @type {[number, number, number, number]} */ (geo.boxes[t]);
      b[0] = Math.min(b[0], x - 1);
      b[1] = Math.min(b[1], y - 1);
      b[2] = Math.max(b[2], x + 1);
      b[3] = Math.max(b[3], y + 1);
      const corners = hexCorners(x, y, 1);
      hexNeighbors(c, r).forEach(([nc, nr], k) => {
        const o = nc < 0 || nr < 0 || nc >= w.cols || nr >= w.rows ? -1 : (w.cells[nr * w.cols + nc] ?? -1);
        if (o === t || (o >= 0 && o < t)) return;
        const [i, j] = /** @type {[number, number]} */ (HEX_SIDES[k]);
        const a = /** @type {[number, number]} */ (corners[i]);
        const z = /** @type {[number, number]} */ (corners[j]);
        geo.sides.push([a[0], a[1], z[0], z[1], t, o]);
      });
    }
  }
  cache.set(w, geo);
  return geo;
}

/** A territory's badge point (its anchor hex) at radius 1. @param {World} w @param {number} t */
function anchor(w, t) {
  const terr = w.territories[t];
  return terr ? hexCenter(terr.anchor[0], terr.anchor[1], 1) : [0, 0];
}

/**
 * The camera that frames territories on a canvas of `cssW`×`cssH`: as
 * close as they fit with `pad` hexes around them, at most `maxScale` px
 * per hex.
 * @param {World} w @param {number} cssW @param {number} cssH @param {number[]} frame
 * @param {number} [pad] @param {number} [maxScale]
 * @returns {View}
 */
export function frameView(w, cssW, cssH, frame, pad = 1.5, maxScale = 20) {
  const g = geometry(w);
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const t of frame) {
    const b = g.boxes[t];
    if (!b || b[0] === Infinity) continue;
    // A territory across the map's edge (a wrapping sea route) would stretch the frame: keep to the first's side.
    if (x0 !== Infinity && (b[0] > x1 + g.W / 2 || b[2] < x0 - g.W / 2)) continue;
    (x0 = Math.min(x0, b[0])), (y0 = Math.min(y0, b[1])), (x1 = Math.max(x1, b[2])), (y1 = Math.max(y1, b[3]));
  }
  if (x0 === Infinity) [x0, y0, x1, y1] = [0, 0, g.W, g.H];
  (x0 -= pad), (y0 -= pad), (x1 += pad), (y1 += pad);
  const s = Math.min(cssW / (x1 - x0), cssH / (y1 - y0), maxScale);
  return { s, ox: cssW / 2 - ((x0 + x1) / 2) * s, oy: cssH / 2 - ((y0 + y1) / 2) * s };
}

/**
 * A camera between two, at `k` (0 … 1, eased by the caller): the middle
 * moves straight, the scale evenly in ratio (a zoom that feels even).
 * Both are for a canvas of `cssW`×`cssH`.
 * @param {View} a @param {View} b @param {number} k @param {number} cssW @param {number} cssH
 * @returns {View}
 */
export function between(a, b, k, cssW, cssH) {
  const mid = (/** @type {View} */ v) => [(cssW / 2 - v.ox) / v.s, (cssH / 2 - v.oy) / v.s];
  const [ax, ay] = mid(a);
  const [bx, by] = mid(b);
  const s = a.s * (b.s / a.s) ** k;
  const x = ax + (bx - ax) * k;
  const y = ay + (by - ay) * k;
  return { s, ox: cssW / 2 - x * s, oy: cssH / 2 - y * s };
}

/**
 * Draws `board` on `canvas`. The whole world: the canvas's height
 * follows its width. A close-up (`o.frame`): the canvas keeps its CSS
 * height and the framed territories fill it. Returns the view for
 * {@link pickAt}.
 * @param {HTMLCanvasElement} canvas
 * @param {World} w
 * @param {Board} board
 * @param {(id: string) => string} colorOf a holder's colour
 * @param {MapOptions} [o]
 * @returns {View}
 */
export function drawMap(canvas, w, board, colorOf, o = {}) {
  const g = geometry(w);
  const cssW = canvas.clientWidth || 320;
  /** @type {View} */
  let v;
  let cssH;
  if (o.view) {
    cssH = canvas.clientHeight || 160;
    v = o.view;
  } else if (o.frame && o.frame.length) {
    cssH = canvas.clientHeight || 160;
    v = frameView(w, cssW, cssH, o.frame, o.pad, o.maxScale);
  } else {
    const s = cssW / g.W;
    cssH = s * g.H;
    canvas.style.height = `${cssH}px`;
    v = { s, ox: 0, oy: 0 };
  }
  const dpr = Math.min(3, globalThis.devicePixelRatio || 1);
  const pw = Math.round(cssW * dpr);
  const ph = Math.round(cssH * dpr);
  if (canvas.width !== pw) canvas.width = pw;
  if (canvas.height !== ph) canvas.height = ph;
  const ctx = canvas.getContext("2d");
  if (!ctx) return v;
  const { s, ox, oy } = v;
  const X = (/** @type {number} */ x) => ox + x * s;
  const Y = (/** @type {number} */ y) => oy + y * s;
  const hex = (/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ r) => {
    hexCorners(X(x), Y(y), r * s).forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
    ctx.closePath();
  };
  const visible = (/** @type {number} */ x, /** @type {number} */ y) => X(x) > -2 * s && X(x) < cssW + 2 * s && Y(y) > -2 * s && Y(y) < cssH + 2 * s;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // The sea: a lit middle, darker edges; its faint grid when close enough to see.
  const sea = ctx.createRadialGradient(cssW * 0.45, cssH * 0.4, 0, cssW * 0.45, cssH * 0.4, Math.max(cssW, cssH) * 0.8);
  sea.addColorStop(0, "#16586a");
  sea.addColorStop(0.6, "#0d3a4a");
  sea.addColorStop(1, "#06202b");
  ctx.fillStyle = sea;
  ctx.fillRect(0, 0, cssW, cssH);
  if (s >= 5) {
    ctx.strokeStyle = "rgba(120, 200, 220, .07)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const [x, y] of g.sea) if (visible(x, y)) hex(x, y, 0.92);
    ctx.stroke();
  }

  // The land's shadow, then the tiles.
  const close = s >= 5;
  ctx.fillStyle = "rgba(0, 8, 12, .55)";
  ctx.beginPath();
  for (const [x, y] of g.land) if (visible(x, y)) hex(x + 0.16, y + 0.3, 1.06);
  ctx.fill();
  const picked = o.sel !== undefined && o.sel >= 0;
  const dim = picked && o.dim !== false;
  const faded = (/** @type {number} */ t) => dim && t !== o.sel && !o.hi?.has(t);
  /** @type {Map<string, [number, number, number][]>} by colour (and faded: a "~" in front) */
  const groups = new Map();
  for (const h of g.land) {
    if (!visible(h[0], h[1])) continue;
    const own = board.own[h[2]] ?? "";
    const c = `${faded(h[2]) ? "~" : ""}${own ? colorOf(own) : WILD}`;
    let list = groups.get(c);
    if (!list) groups.set(c, (list = []));
    list.push(h);
  }
  const r = close ? 0.94 : 1.05;
  for (const [c, list] of groups) {
    // Faded: the sea shows through.
    ctx.globalAlpha = c.startsWith("~") ? 0.32 : 1;
    ctx.fillStyle = c.replace("~", "");
    ctx.beginPath();
    for (const [x, y] of list) hex(x, y, r);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  if (close) {
    // Raised tiles: light from the top, a darker foot.
    const lit = ctx.createLinearGradient(0, -s, 0, s);
    lit.addColorStop(0, "rgba(255, 255, 255, .30)");
    lit.addColorStop(0.5, "rgba(255, 255, 255, 0)");
    lit.addColorStop(1, "rgba(0, 0, 0, .22)");
    ctx.fillStyle = lit;
    for (const [c, list] of groups) {
      if (c.startsWith("~")) continue;
      for (const [x, y] of list) {
        ctx.save();
        ctx.translate(X(x), Y(y));
        ctx.beginPath();
        hexCorners(0, 0, r * s).forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
        ctx.fill();
        ctx.restore();
      }
    }
  }

  // Borders: between territories and on the coast.
  ctx.lineCap = "round";
  const line = (/** @type {string} */ color, /** @type {number} */ width, /** @type {(a: number, b: number) => boolean} */ which) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    for (const [x1, y1, x2, y2, a, b] of g.sides) {
      if (!which(a, b) || !visible(x1, y1)) continue;
      ctx.moveTo(X(x1), Y(y1));
      ctx.lineTo(X(x2), Y(y2));
    }
    ctx.stroke();
  };
  line("rgba(3, 16, 22, .9)", Math.max(1, s * 0.22), (_a, b) => b < 0);
  line("rgba(12, 18, 24, .6)", Math.max(0.8, s * (close ? 0.2 : 0.16)), (a, b) => b >= 0 && board.own[a] !== board.own[b]);
  if (close) line("rgba(12, 18, 24, .28)", Math.max(0.6, s * 0.08), (a, b) => b >= 0 && board.own[a] === board.own[b]);
  // Where continents meet on land: a light seam.
  if (o.regions !== false) line("rgba(244, 234, 210, .75)", Math.max(1, s * 0.14), (a, b) => b >= 0 && w.territories[a]?.continent !== w.territories[b]?.continent);

  // Sea routes: dashed.
  if (close) {
    ctx.save();
    ctx.setLineDash([s * 0.5, s * 0.5]);
    ctx.strokeStyle = "rgba(230, 240, 240, .35)";
    ctx.lineWidth = Math.max(1, s * 0.12);
    ctx.beginPath();
    for (const l of w.links) {
      if (l.wrap) continue;
      const a = w.byId.get(l.a);
      const b = w.byId.get(l.b);
      if (!a || !b) continue;
      const [ax, ay] = anchor(w, a.index);
      const [bx, by] = anchor(w, b.index);
      ctx.moveTo(X(ax), Y(ay));
      ctx.lineTo(X(bx), Y(by));
    }
    ctx.stroke();
    ctx.restore();
  }
  // The selection: neighbours faintly, itself bright.
  const outline = (/** @type {number} */ t, /** @type {string} */ color, /** @type {number} */ width) => line(color, width, (a, b) => (a === t) !== (b === t));
  if (o.hi && dim) for (const t of o.hi) outline(t, "rgba(255, 255, 255, .5)", Math.max(1, s * 0.22));
  if (picked && o.sel !== undefined) {
    outline(o.sel, "rgba(0, 0, 0, .5)", Math.max(3, s * 0.7));
    outline(o.sel, "#fff", Math.max(2, s * 0.4));
  }

  // Arrows: one's orders in white, the fight on the TV in the mover's colour.
  for (const a of o.arrows ?? []) {
    let [ax, ay] = anchor(w, a.from);
    let [bx, by] = anchor(w, a.to);
    if (Math.abs(bx - ax) > g.W / 2) bx += bx > ax ? -g.W : g.W;
    const len = Math.hypot(bx - ax, by - ay) || 1;
    const ux = (bx - ax) / len;
    const uy = (by - ay) / len;
    // From the edge of the start badge to just before the target's.
    const r0 = close ? 1.1 : 0;
    (ax += ux * r0), (ay += uy * r0), (bx -= ux * (close ? 1.4 : 0.6)), (by -= uy * (close ? 1.4 : 0.6));
    const bend = Math.min(2.5, len * 0.18);
    const mx = (ax + bx) / 2 - uy * bend;
    const my = (ay + by) / 2 + ux * bend;
    const color = a.color ?? "#fff";
    const width = close ? Math.max(3, s * 0.42) : Math.max(1.8, s * 0.7);
    ctx.save();
    ctx.lineCap = a.kind === "move" ? "butt" : "round";
    if (a.kind === "move") ctx.setLineDash([width * 1.6, width * 1.1]);
    ctx.strokeStyle = "rgba(0, 0, 0, .55)";
    ctx.lineWidth = width + (close ? 3 : 2);
    ctx.beginPath();
    ctx.moveTo(X(ax), Y(ay));
    ctx.quadraticCurveTo(X(mx), Y(my), X(bx), Y(by));
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
    ctx.restore();
    // The head, along the curve's end.
    const hx = bx - mx;
    const hy = by - my;
    const hl = Math.hypot(hx, hy) || 1;
    const size = close ? Math.max(9, s * 1.3) : Math.max(6, s * 2.6);
    const px = X(bx) + (hx / hl) * size * 0.5;
    const py = Y(by) + (hy / hl) * size * 0.5;
    ctx.fillStyle = color;
    ctx.strokeStyle = "rgba(0, 0, 0, .6)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(px - (hx / hl) * size - (hy / hl) * size * 0.6, py - (hy / hl) * size + (hx / hl) * size * 0.6);
    ctx.lineTo(px - (hx / hl) * size + (hy / hl) * size * 0.6, py - (hy / hl) * size - (hx / hl) * size * 0.6);
    ctx.closePath();
    ctx.stroke();
    ctx.fill();
    const fs = Math.max(11, Math.min(15, s * 1.2));
    if (a.n && s >= 3) badge(ctx, X(mx), Y(my), String(a.n), color, fs, "#fff", "rgba(10, 14, 20, .9)");
  }

  if (o.regionNames?.size) regionNames(ctx, w, v, cssW, cssH, o.regionNames);

  const font = close ? Math.max(11, Math.min(16, s * 1.15)) : Math.max(9, Math.min(12, s * 2.1));
  // Names: on the land, by their badges, clear of them and of each other.
  // Not on the whole world: no room.
  if (o.names && o.names.size && s >= 2) names(ctx, w, v, cssW, cssH, o.names, o.strong ?? new Set(), new Set(o.labels?.keys() ?? []), font * 0.75 + 2);

  // Badges: armies on the territories that matter; placements in white by them.
  if (o.labels) {
    for (const [t, text] of o.labels) {
      const [x, y] = anchor(w, t);
      const own = board.own[t] ?? "";
      badge(ctx, X(x), Y(y), text, own ? colorOf(own) : WILD, font, "#fff", "rgba(10, 14, 20, .88)");
    }
  }
  for (const [t, n] of o.plus ?? []) {
    if (!n) continue;
    const [x, y] = anchor(w, t);
    const on = o.labels?.has(t);
    const f = on ? Math.max(10, font * 0.8) : font;
    badge(ctx, X(x) + (on ? font * 1.05 : 0), Y(y) - (on ? font * 0.95 : 0), `+${n}`, "rgba(10, 14, 20, .9)", f, "#10161c", "#fff");
  }
  return v;
}

/** Where the continents' names go, per world and layout. @type {WeakMap<World, Map<string, [string, number, number][]>>} */
const regionSpots = new WeakMap();

/**
 * The continents' names in the sea, each as near its continent's middle
 * as there is open sea for it, clear of the land and of each other, in
 * parchment with a dark rim.
 * @param {CanvasRenderingContext2D} ctx @param {World} w @param {View} v @param {number} cssW @param {number} cssH
 * @param {Map<string, string>} names
 */
function regionNames(ctx, w, v, cssW, cssH, names) {
  const { s, ox, oy } = v;
  const px = Math.max(9, Math.min(13, s * 3.4));
  const font = `${px}px "Lilita One", "Arial Black", sans-serif`;
  ctx.font = font;
  const key = `${cssW}x${cssH}|${s.toFixed(3)}|${ox.toFixed(1)}|${oy.toFixed(1)}|${[...names].join(",")}|${ctx.measureText("M").width.toFixed(2)}`;
  let byKey = regionSpots.get(w);
  if (!byKey) regionSpots.set(w, (byKey = new Map()));
  let spots = byKey.get(key);
  if (!spots) {
    spots = [];
    /** @type {[number, number, number, number][]} taken boxes, map units */
    const taken = [];
    // In map units: the canvas, the text's height.
    const [vx0, vy0, vx1, vy1] = [-ox / s, -oy / s, (cssW - ox) / s, (cssH - oy) / s];
    const bh = (px * 1.1) / s;
    const near = 0.4;
    const land = (/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ bw) => {
      const r0 = Math.max(0, Math.floor((y - 2) / HEX_ROW));
      const r1 = Math.min(w.rows - 1, Math.ceil((y + bh + 1) / HEX_ROW));
      for (let r = r0; r <= r1; r++) {
        for (let c = Math.max(0, Math.floor(x / HEX_W) - 1); c <= Math.min(w.cols - 1, Math.ceil((x + bw) / HEX_W) + 1); c++) {
          if ((w.cells[r * w.cols + c] ?? -1) < 0) continue;
          const [cx, cy] = hexCenter(c, r, 1);
          if (cx > x - 1 - near && cx < x + bw + 1 + near && cy > y - 1 - near && cy < y + bh + 1 + near) return true;
        }
      }
      return false;
    };
    const overlaps = (/** @type {number[]} */ a, /** @type {number[]} */ b) => (a[0] ?? 0) < (b[0] ?? 0) + (b[2] ?? 0) && (b[0] ?? 0) < (a[0] ?? 0) + (a[2] ?? 0) && (a[1] ?? 0) < (b[1] ?? 0) + (b[3] ?? 0) && (b[1] ?? 0) < (a[1] ?? 0) + (a[3] ?? 0);
    // The continent of the land nearest to a point: a name belongs by its own coast.
    const nearest = (/** @type {number} */ x, /** @type {number} */ y) => {
      let best = Infinity;
      let cont = "";
      for (const terr of w.territories) {
        for (const i of terr.hexes) {
          const [cx, cy] = hexCenter(i % w.cols, Math.floor(i / w.cols), 1);
          const d = (cx - x) ** 2 + (cy - y) ** 2;
          if (d < best) (best = d), (cont = terr.continent);
        }
      }
      return cont;
    };
    const step = Math.max(0.5, 2 / s);
    for (const c of w.continents) {
      const name = (names.get(c.id) ?? "").toUpperCase();
      if (!name) continue;
      const bw = (ctx.measureText(name).width + 4) / s;
      const hexes = c.territories.flatMap((id) => w.byId.get(id)?.hexes ?? []);
      const mx = hexes.reduce((a, i) => a + hexCenter(i % w.cols, Math.floor(i / w.cols), 1)[0], 0) / Math.max(1, hexes.length);
      const my = hexes.reduce((a, i) => a + hexCenter(i % w.cols, Math.floor(i / w.cols), 1)[1], 0) / Math.max(1, hexes.length);
      /** @type {[number, number, number] | null} */
      let best = null;
      // By its own coast if there is room; else wherever is nearest.
      for (const own of [true, false]) {
        for (let y = vy0 + 0.3; y + bh < vy1 - 0.3; y += step) {
          for (let x = vx0 + 0.3; x + bw < vx1 - 0.3; x += step) {
            const score = Math.hypot(x + bw / 2 - mx, (y + bh / 2 - my) * 1.2);
            if (best && score >= best[2]) continue;
            if (taken.some((b) => overlaps([x - 0.5, y - 0.3, bw + 1, bh + 0.6], b))) continue;
            if (land(x, y, bw) || (own && nearest(x + bw / 2, y + bh / 2) !== c.id)) continue;
            best = [x, y, score];
          }
        }
        if (best) break;
      }
      if (!best) continue;
      taken.push([best[0], best[1], bw, bh]);
      spots.push([name, best[0] + bw / 2, best[1] + bh / 2]);
    }
    byKey.set(key, spots);
  }
  ctx.font = font;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.lineWidth = 3;
  for (const [name, x, y] of spots) {
    ctx.strokeStyle = "rgba(4, 18, 26, .9)";
    ctx.strokeText(name, ox + x * s, oy + y * s + px * 0.06);
    ctx.fillStyle = "rgba(244, 234, 210, .8)";
    ctx.fillText(name, ox + x * s, oy + y * s + px * 0.06);
  }
}

/** The names' font, at a size. @param {number} px @param {boolean} strong */
const nameFont = (px, strong) => `${strong ? 800 : 600} ${px}px "Barlow Condensed", "Arial Narrow", sans-serif`;

/**
 * Territories' names on a close-up (game/names.ts places them), in light
 * letters with a dark rim; the strong ones bigger, bolder and placed
 * first. `badge`: the badges' radius in px.
 * @param {CanvasRenderingContext2D} ctx @param {World} w @param {View} v @param {number} cssW @param {number} cssH
 * @param {Map<number, string>} names @param {Set<number>} strong @param {Set<number>} badged @param {number} badge
 */
function names(ctx, w, v, cssW, cssH, names, strong, badged, badge) {
  const { s, ox, oy } = v;
  const px = Math.max(11, Math.min(14, s * 1.1));
  const big = px + 2;
  const m = 3 / s;
  /** @param {number} t */
  const pxOf = (t) => (strong.has(t) ? big : px);
  const order = [...names.keys()].sort((a, b) => Number(strong.has(b)) - Number(strong.has(a)) || (w.territories[a]?.hexes.length ?? 0) - (w.territories[b]?.hexes.length ?? 0));
  // Each name at its own size: placed one at a time, the ones before kept clear.
  /** @type {import("../game/names.js").Box[]} */
  const avoid = [];
  /** @type {import("../game/names.js").Label[]} */
  const labels = [];
  for (const t of order) {
    const p = pxOf(t);
    ctx.font = nameFont(100, strong.has(t));
    const [l] = placeNames(w, new Map([[t, names.get(t) ?? ""]]), {
      size: p / s,
      measure: (text, size) => (ctx.measureText(text).width / 100) * size,
      badge: badge / s,
      badges: badged,
      avoid,
      bounds: [-ox / s + m, -oy / s + m, cssW / s - 2 * m, cssH / s - 2 * m],
      lead: 1,
    });
    if (!l) continue;
    avoid.push([l.x - l.w / 2 - 2 / s, l.y - l.h / 2 - 1 / s, l.w + 4 / s, l.h + 2 / s]);
    labels.push(l);
  }
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  for (const l of labels) {
    const st = strong.has(l.t);
    const p = l.size * s;
    ctx.font = nameFont(p, st);
    ctx.lineWidth = st ? 4 : 3;
    ctx.strokeStyle = "rgba(4, 14, 20, .88)";
    ctx.fillStyle = st ? "#fff" : "#f4ead2";
    l.lines.forEach((line, k) => {
      const x = ox + l.x * s;
      const y = oy + (l.y - l.h / 2 + l.size * (k + 0.5)) * s + p * 0.06;
      ctx.strokeText(line, x, y);
      ctx.fillText(line, x, y);
    });
  }
}

/**
 * A round badge (a pill for longer text) with a coloured ring.
 * @param {CanvasRenderingContext2D} ctx @param {number} x @param {number} y @param {string} text
 * @param {string} ring @param {number} font @param {string} ink @param {string} fill
 */
function badge(ctx, x, y, text, ring, font, ink, fill) {
  ctx.font = `${font}px "Lilita One", "Arial Black", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const h = font * 1.5;
  const tw = Math.max(h, ctx.measureText(text).width + font * 0.75);
  ctx.fillStyle = "rgba(0, 0, 0, .35)";
  ctx.beginPath();
  ctx.roundRect(x - tw / 2 + 1, y - h / 2 + 2, tw, h, h / 2);
  ctx.fill();
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.roundRect(x - tw / 2, y - h / 2, tw, h, h / 2);
  ctx.fill();
  ctx.strokeStyle = ring;
  ctx.lineWidth = Math.max(1.5, font * 0.16);
  ctx.stroke();
  ctx.fillStyle = ink;
  ctx.fillText(text, x, y + font * 0.04);
}

/**
 * The territory under a point of the canvas (CSS px), or -1: the
 * nearest land hex within a hex and a half (fingers are wide, hexes
 * small); in a close-up, a tap near a badge counts for its territory.
 * @param {World} w
 * @param {View} v what {@link drawMap} returned
 * @param {number} x
 * @param {number} y
 */
export function pickAt(w, v, x, y) {
  const g = geometry(w);
  const mx = (x - v.ox) / v.s;
  const my = (y - v.oy) / v.s;
  let best = -1;
  // Within a fingertip (about 14 px) or a hex and a half, whichever is more.
  const reach = Math.max(1.5, 14 / v.s);
  let dist = reach * reach;
  for (const [cx, cy, t] of g.land) {
    const d = (cx - mx) ** 2 + (cy - my) ** 2;
    if (d < dist) (dist = d), (best = t);
  }
  if (v.s >= 5) {
    // Badges are what people aim at.
    let near = (16 / v.s) ** 2;
    let hit = -1;
    for (const terr of w.territories) {
      const [ax, ay] = anchor(w, terr.index);
      const d = (ax - mx) ** 2 + (ay - my) ** 2;
      if (d < near) (near = d), (hit = terr.index);
    }
    if (hit >= 0) return hit;
  }
  return best;
}
