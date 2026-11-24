/**
 * The colours of a flag (docs/worldquiz-design.md §4.5, hard: the wrong
 * flags are those of the most similar colours): the flag's SVG drawn on
 * a coarse grid by a small rasteriser of our own (no DOM, so the script
 * and the tests run it in Node), each colour's share of the cells, and
 * how alike two flags' colours are.
 *
 * What it draws: `rect`, `circle`, `ellipse`, `line`, `polyline`,
 * `polygon` and `path` (every command, curves and arcs flattened),
 * groups with their transforms, `use`, fills (colours, named colours,
 * gradients as the mean of their stops) with both fill rules, strokes as
 * wide as at least half a cell, `clip-path` (the clip's shapes as a
 * mask), and the simple CSS of a `style` element (`.class`, `#id`, tag).
 * Text, patterns, masks and filters are not drawn (no flag of the game
 * has them). Painted in document order, so what lies on top counts
 * (France's three overlapping paths are three thirds).
 *
 * `scripts/colours.ts` writes `data/colours.json` with it; the game
 * reads that file.
 */

/** The grid's width; its height keeps the flag's aspect (so strokes keep their width), 8 to 64 cells. */
export const GRID_W = 48;
/** Colours with less of the flag than this are left out. */
export const MIN_SHARE = 0.01;

/** A flag's colours, the most first: `#rrggbb` and its share (0–1); `look`, a hash of the whole picture (equal: the same flag). */
export interface FlagColours {
  colours: [string, number][];
  look: string;
}

// ---------------------------------------------------------------------------
// XML

export interface El {
  name: string;
  attrs: Record<string, string>;
  kids: El[];
  text: string;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

/** The document's root element (a small XML reader: tags, attributes, text; no DTD). */
export function parseXml(text: string): El {
  const root: El = { name: "#root", attrs: {}, kids: [], text: "" };
  const stack: El[] = [root];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const lt = text.indexOf("<", i);
    const top = stack[stack.length - 1]!;
    if (lt < 0) {
      top.text += decode(text.slice(i));
      break;
    }
    if (lt > i) top.text += decode(text.slice(i, lt));
    if (text.startsWith("<!--", lt)) {
      const e = text.indexOf("-->", lt + 4);
      i = e < 0 ? n : e + 3;
    } else if (text.startsWith("<![CDATA[", lt)) {
      const e = text.indexOf("]]>", lt + 9);
      top.text += text.slice(lt + 9, e < 0 ? n : e);
      i = e < 0 ? n : e + 3;
    } else if (text.startsWith("<?", lt)) {
      const e = text.indexOf("?>", lt + 2);
      i = e < 0 ? n : e + 2;
    } else if (text.startsWith("<!", lt)) {
      // A DOCTYPE, maybe with an internal subset in brackets.
      let j = lt + 2;
      let depth = 0;
      while (j < n && !(text[j] === ">" && depth === 0)) {
        if (text[j] === "[") depth++;
        else if (text[j] === "]") depth--;
        j++;
      }
      i = j + 1;
    } else if (text[lt + 1] === "/") {
      const e = text.indexOf(">", lt);
      const name = text.slice(lt + 2, e < 0 ? n : e).trim();
      for (let k = stack.length - 1; k > 0; k--)
        if (stack[k]!.name === name) {
          stack.length = k;
          break;
        }
      i = e < 0 ? n : e + 1;
    } else {
      // A start tag: up to the ">" outside quotes.
      let j = lt + 1;
      let q = "";
      while (j < n) {
        const ch = text[j]!;
        if (q) {
          if (ch === q) q = "";
        } else if (ch === '"' || ch === "'") q = ch;
        else if (ch === ">") break;
        j++;
      }
      const body = text.slice(lt + 1, j);
      const self = body.endsWith("/");
      const inner = self ? body.slice(0, -1) : body;
      const m = /^[^\s/>]+/.exec(inner);
      const el: El = { name: m ? m[0] : "", attrs: {}, kids: [], text: "" };
      const re = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
      let a: RegExpExecArray | null;
      while ((a = re.exec(inner.slice(el.name.length)))) el.attrs[a[1]!] = decode(a[3] ?? a[4] ?? "");
      top.kids.push(el);
      if (!self) stack.push(el);
      i = j + 1;
    }
  }
  return root.kids.find((k) => k.name === "svg" || k.name.endsWith(":svg")) ?? root.kids[0] ?? root;
}

// ---------------------------------------------------------------------------
// Numbers, colours, transforms

/** Reads numbers and single-digit flags from a path or a list. */
class Scanner {
  i = 0;
  readonly s: string;
  constructor(s: string) {
    this.s = s;
  }
  skip(): void {
    while (this.i < this.s.length && /[\s,]/.test(this.s[this.i]!)) this.i++;
  }
  /** At a number (after separators)? */
  more(): boolean {
    this.skip();
    return this.i < this.s.length && /[-+.\d]/.test(this.s[this.i]!);
  }
  num(): number {
    this.skip();
    const m = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(this.s.slice(this.i, this.i + 40));
    if (!m) throw new Error(`a number at ${this.i}`);
    this.i += m[0].length;
    return Number(m[0]);
  }
  flag(): boolean {
    this.skip();
    const c = this.s[this.i];
    if (c !== "0" && c !== "1") throw new Error(`a flag at ${this.i}`);
    this.i++;
    return c === "1";
  }
}

function numbersIn(s: string): number[] {
  return (s.match(/[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g) ?? []).map(Number);
}

/** A length (user units; px and no unit alike, % of `of`). */
function len(v: string | undefined, of = 0, dflt = 0): number {
  if (v === undefined) return dflt;
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return dflt;
  return v.trim().endsWith("%") ? (n / 100) * of : n;
}

const NAMED: Record<string, string> = {
  black: "#000000", white: "#ffffff", red: "#ff0000", green: "#008000", blue: "#0000ff", yellow: "#ffff00",
  navy: "#000080", maroon: "#800000", gold: "#ffd700", orange: "#ffa500", silver: "#c0c0c0", gray: "#808080",
  grey: "#808080", lime: "#00ff00", aqua: "#00ffff", cyan: "#00ffff", teal: "#008080", purple: "#800080",
  fuchsia: "#ff00ff", magenta: "#ff00ff", olive: "#808000", brown: "#a52a2a", crimson: "#dc143c",
  darkgreen: "#006400", darkblue: "#00008b", darkred: "#8b0000", forestgreen: "#228b22", royalblue: "#4169e1",
};

/** A colour as `#rrggbb`, or null (none, or unknown). */
export function colourOf(v: string): string | null {
  const s = v.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  if (/^#[0-9a-f]{3}$/.test(s)) return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  const rgb = /^rgba?\(([^)]*)\)$/.exec(s);
  if (rgb) {
    const parts = rgb[1]!.split(/[\s,/]+/).filter(Boolean).slice(0, 3);
    if (parts.length < 3) return null;
    const ch = parts.map((p) => Math.max(0, Math.min(255, Math.round(p.endsWith("%") ? parseFloat(p) * 2.55 : parseFloat(p)))));
    if (ch.some((c) => !Number.isFinite(c))) return null;
    return `#${ch.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
  }
  return NAMED[s] ?? null;
}

/** An affine transform [a b c d e f]: x' = a x + c y + e, y' = b x + d y + f. */
export type Mat = [number, number, number, number, number, number];
const ID: Mat = [1, 0, 0, 1, 0, 0];

export function mul(m: Mat, n: Mat): Mat {
  return [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
}

/** An SVG `transform` attribute as one matrix. */
export function parseTransform(s: string | undefined): Mat {
  let m = ID;
  if (!s) return m;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let t: RegExpExecArray | null;
  while ((t = re.exec(s))) {
    const a = numbersIn(t[2]!);
    let n: Mat = ID;
    switch (t[1]) {
      case "matrix":
        if (a.length >= 6) n = [a[0]!, a[1]!, a[2]!, a[3]!, a[4]!, a[5]!];
        break;
      case "translate":
        n = [1, 0, 0, 1, a[0] ?? 0, a[1] ?? 0];
        break;
      case "scale":
        n = [a[0] ?? 1, 0, 0, a[1] ?? a[0] ?? 1, 0, 0];
        break;
      case "rotate": {
        const r = ((a[0] ?? 0) * Math.PI) / 180;
        const [cx, cy] = [a[1] ?? 0, a[2] ?? 0];
        n = mul(mul([1, 0, 0, 1, cx, cy], [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0]), [1, 0, 0, 1, -cx, -cy]);
        break;
      }
      case "skewX":
        n = [1, 0, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 1, 0, 0];
        break;
      case "skewY":
        n = [1, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0];
        break;
    }
    m = mul(m, n);
  }
  return m;
}

// ---------------------------------------------------------------------------
// Geometry: every shape as polylines (subpaths) in user units

type Pt = [number, number];
interface Sub {
  pts: Pt[];
  closed: boolean;
}

const CURVE_STEPS = 8;

/** A path's `d` as subpaths, curves and arcs flattened. */
export function parsePath(d: string): Sub[] {
  const s = new Scanner(d);
  const out: Sub[] = [];
  let cur: Sub | null = null;
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  // The last control point (for S and T).
  let cx = 0;
  let cy = 0;
  let prev = "";
  let cmd = "";
  const to = (px: number, py: number) => {
    if (!cur) {
      cur = { pts: [[x, y]], closed: false };
      out.push(cur);
    }
    cur.pts.push([px, py]);
    x = px;
    y = py;
  };
  while (true) {
    s.skip();
    if (s.i >= d.length) break;
    const ch = d[s.i]!;
    if (/[a-zA-Z]/.test(ch)) {
      cmd = ch;
      s.i++;
    } else if (!cmd || !s.more()) throw new Error(`path: ${ch} at ${s.i}`);
    else if (cmd === "M") cmd = "L";
    else if (cmd === "m") cmd = "l";
    const rel = cmd === cmd.toLowerCase();
    const ox = rel ? x : 0;
    const oy = rel ? y : 0;
    switch (cmd.toUpperCase()) {
      case "M": {
        const px = ox + s.num();
        const py = oy + s.num();
        cur = { pts: [[px, py]], closed: false };
        out.push(cur);
        x = sx = px;
        y = sy = py;
        break;
      }
      case "L":
        to(ox + s.num(), oy + s.num());
        break;
      case "H":
        to(ox + s.num(), y);
        break;
      case "V":
        to(x, oy + s.num());
        break;
      case "C":
      case "S": {
        let x1: number;
        let y1: number;
        if (cmd.toUpperCase() === "C") {
          x1 = ox + s.num();
          y1 = oy + s.num();
        } else {
          const smooth = /[CcSs]/.test(prev);
          x1 = smooth ? 2 * x - cx : x;
          y1 = smooth ? 2 * y - cy : y;
        }
        const x2 = ox + s.num();
        const y2 = oy + s.num();
        const ex = ox + s.num();
        const ey = oy + s.num();
        const [x0, y0] = [x, y];
        for (let k = 1; k <= CURVE_STEPS; k++) {
          const t = k / CURVE_STEPS;
          const u = 1 - t;
          to(u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * ex, u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * ey);
        }
        cx = x2;
        cy = y2;
        break;
      }
      case "Q":
      case "T": {
        let x1: number;
        let y1: number;
        if (cmd.toUpperCase() === "Q") {
          x1 = ox + s.num();
          y1 = oy + s.num();
        } else {
          const smooth = /[QqTt]/.test(prev);
          x1 = smooth ? 2 * x - cx : x;
          y1 = smooth ? 2 * y - cy : y;
        }
        const ex = ox + s.num();
        const ey = oy + s.num();
        const [x0, y0] = [x, y];
        for (let k = 1; k <= CURVE_STEPS; k++) {
          const t = k / CURVE_STEPS;
          const u = 1 - t;
          to(u * u * x0 + 2 * u * t * x1 + t * t * ex, u * u * y0 + 2 * u * t * y1 + t * t * ey);
        }
        cx = x1;
        cy = y1;
        break;
      }
      case "A": {
        const rx = Math.abs(s.num());
        const ry = Math.abs(s.num());
        const rot = s.num();
        const large = s.flag();
        const sweep = s.flag();
        const ex = ox + s.num();
        const ey = oy + s.num();
        for (const p of arcPoints(x, y, rx, ry, rot, large, sweep, ex, ey)) to(p[0], p[1]);
        break;
      }
      case "Z":
        if (cur) cur.closed = true;
        x = sx;
        y = sy;
        cur = null;
        break;
      default:
        throw new Error(`path: command ${cmd}`);
    }
    if (!/[CcSsQqTt]/.test(cmd)) {
      cx = x;
      cy = y;
    }
    prev = cmd;
  }
  return out;
}

/** An elliptical arc (SVG's endpoint form) as points after the start, the end last. */
export function arcPoints(x1: number, y1: number, rx: number, ry: number, rotDeg: number, large: boolean, sweep: boolean, x2: number, y2: number): Pt[] {
  if (rx === 0 || ry === 0 || (x1 === x2 && y1 === y2)) return [[x2, y2]];
  const phi = (rotDeg * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const xp = cos * dx + sin * dy;
  const yp = -sin * dx + cos * dy;
  const lam = (xp * xp) / (rx * rx) + (yp * yp) / (ry * ry);
  if (lam > 1) {
    rx *= Math.sqrt(lam);
    ry *= Math.sqrt(lam);
  }
  const num = rx * rx * ry * ry - rx * rx * yp * yp - ry * ry * xp * xp;
  const den = rx * rx * yp * yp + ry * ry * xp * xp;
  const co = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
  const cxp = (co * rx * yp) / ry;
  const cyp = (-co * ry * xp) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t1 = ang(1, 0, (xp - cxp) / rx, (yp - cyp) / ry);
  let dt = ang((xp - cxp) / rx, (yp - cyp) / ry, (-xp - cxp) / rx, (-yp - cyp) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  else if (sweep && dt < 0) dt += 2 * Math.PI;
  const steps = Math.max(2, Math.ceil(Math.abs(dt) / (Math.PI / 12)));
  const out: Pt[] = [];
  for (let k = 1; k <= steps; k++) {
    const t = t1 + (dt * k) / steps;
    out.push([cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin, cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos]);
  }
  out[out.length - 1] = [x2, y2];
  return out;
}

function ellipse(cx: number, cy: number, rx: number, ry: number): Sub[] {
  if (rx <= 0 || ry <= 0) return [];
  const n = 32;
  const pts: Pt[] = [];
  for (let k = 0; k < n; k++) pts.push([cx + rx * Math.cos((2 * Math.PI * k) / n), cy + ry * Math.sin((2 * Math.PI * k) / n)]);
  return [{ pts, closed: true }];
}

function pointsOf(v: string | undefined, closed: boolean): Sub[] {
  const a = numbersIn(v ?? "");
  const pts: Pt[] = [];
  for (let k = 0; k + 1 < a.length; k += 2) pts.push([a[k]!, a[k + 1]!]);
  return pts.length >= 2 ? [{ pts, closed }] : [];
}

/** A shape element's geometry (user units), or null when it is not a shape. */
function shapeOf(el: El, vb: [number, number, number, number]): Sub[] | null {
  const a = el.attrs;
  switch (local(el.name)) {
    case "rect": {
      const w = len(a["width"], vb[2]);
      const h = len(a["height"], vb[3]);
      const x = len(a["x"], vb[2]);
      const y = len(a["y"], vb[3]);
      if (w <= 0 || h <= 0) return [];
      return [{ pts: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], closed: true }];
    }
    case "circle": {
      const r = len(a["r"], Math.hypot(vb[2], vb[3]) / Math.SQRT2);
      return ellipse(len(a["cx"], vb[2]), len(a["cy"], vb[3]), r, r);
    }
    case "ellipse":
      return ellipse(len(a["cx"], vb[2]), len(a["cy"], vb[3]), len(a["rx"], vb[2]), len(a["ry"], vb[3]));
    case "line":
      return [{ pts: [[len(a["x1"], vb[2]), len(a["y1"], vb[3])], [len(a["x2"], vb[2]), len(a["y2"], vb[3])]], closed: false }];
    case "polyline":
      return pointsOf(a["points"], false);
    case "polygon":
      return pointsOf(a["points"], true);
    case "path":
      try {
        return parsePath(a["d"] ?? "");
      } catch {
        // A broken path draws as far as it read (as browsers do): here, not at all.
        return [];
      }
    default:
      return null;
  }
}

function local(name: string): string {
  const i = name.indexOf(":");
  return i < 0 ? name : name.slice(i + 1);
}

// ---------------------------------------------------------------------------
// Styles

interface Style {
  fill: string;
  fillRule: string;
  stroke: string;
  strokeWidth: string;
  opacity: number;
  fillOpacity: number;
  strokeOpacity: number;
  color: string;
}

const STYLE_PROPS = ["fill", "fill-rule", "stroke", "stroke-width", "opacity", "fill-opacity", "stroke-opacity", "color", "display", "visibility", "clip-path"];

/** A `style` element's rules: selector (`.c`, `#id`, `tag`) → declarations. */
function cssRules(text: string): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>();
  const re = /([^{}]+)\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, "");
  while ((m = re.exec(clean))) {
    const decl = declarations(m[2]!);
    for (const sel of m[1]!.split(",").map((x) => x.trim()).filter(Boolean)) out.set(sel, { ...out.get(sel), ...decl });
  }
  return out;
}

function declarations(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of s.split(";")) {
    const i = part.indexOf(":");
    if (i > 0) out[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).replace(/!important/, "").trim();
  }
  return out;
}

// ---------------------------------------------------------------------------
// The raster

/** A grid of colour indices (-1: nothing yet). */
class Raster {
  readonly cells: Int32Array;
  readonly palette: string[] = [];
  readonly #index = new Map<string, number>();
  readonly w: number;
  readonly h: number;
  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.cells = new Int32Array(w * h).fill(-1);
  }
  colour(hex: string): number {
    let i = this.#index.get(hex);
    if (i === undefined) {
      i = this.palette.length;
      this.palette.push(hex);
      this.#index.set(hex, i);
    }
    return i;
  }
}

/** Cells (by index) whose centres a filled polygon set covers. */
function fillCells(subs: Pt[][], w: number, h: number, evenOdd: boolean): number[] {
  const out: number[] = [];
  const xs: [number, number][] = [];
  for (let j = 0; j < h; j++) {
    const y = j + 0.5;
    xs.length = 0;
    for (const pts of subs) {
      const n = pts.length;
      for (let k = 0; k < n; k++) {
        const [x1, y1] = pts[k]!;
        const [x2, y2] = pts[(k + 1) % n]!;
        if (y1 <= y === y2 <= y) continue;
        xs.push([x1 + ((y - y1) * (x2 - x1)) / (y2 - y1), y2 > y1 ? 1 : -1]);
      }
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a[0] - b[0]);
    let wind = 0;
    for (let k = 0; k < xs.length - 1; k++) {
      wind += xs[k]![1];
      const inside = evenOdd ? (k + 1) % 2 === 1 : wind !== 0;
      if (!inside) continue;
      const from = Math.max(0, Math.ceil(xs[k]![0] - 0.5));
      const to = Math.min(w - 1, Math.ceil(xs[k + 1]![0] - 0.5) - 1);
      for (let i = from; i <= to; i++) out.push(j * w + i);
    }
  }
  return out;
}

/** Cells whose centres lie within `hw` of the polylines. */
function strokeCells(subs: { pts: Pt[]; closed: boolean }[], hw: number, w: number, h: number): number[] {
  const hit = new Set<number>();
  for (const s of subs) {
    const n = s.pts.length;
    const segs = s.closed ? n : n - 1;
    for (let k = 0; k < segs; k++) {
      const [ax, ay] = s.pts[k]!;
      const [bx, by] = s.pts[(k + 1) % n]!;
      const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - hw));
      const x1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx) + hw));
      const y0 = Math.max(0, Math.floor(Math.min(ay, by) - hw));
      const y1 = Math.min(h - 1, Math.ceil(Math.max(ay, by) + hw));
      const dx = bx - ax;
      const dy = by - ay;
      const l2 = dx * dx + dy * dy;
      for (let j = y0; j <= y1; j++)
        for (let i = x0; i <= x1; i++) {
          const px = i + 0.5;
          const py = j + 0.5;
          const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
          if (Math.hypot(px - ax - t * dx, py - ay - t * dy) <= hw) hit.add(j * w + i);
        }
    }
  }
  return [...hit];
}

/** Draws an SVG flag on a grid: the raster's cells and palette. */
export function rasterise(svg: string, w = GRID_W): { cells: Int32Array; palette: string[]; h: number } {
  const root = parseXml(svg);
  const a = root.attrs;
  const vbn = numbersIn(a["viewBox"] ?? "");
  const vb: [number, number, number, number] =
    vbn.length === 4 && vbn[2]! > 0 && vbn[3]! > 0 ? [vbn[0]!, vbn[1]!, vbn[2]!, vbn[3]!] : [0, 0, len(a["width"], 0, 0) || 300, len(a["height"], 0, 0) || 200];
  const h = Math.max(8, Math.min(64, Math.round((w * vb[3]) / vb[2])));
  const r = new Raster(w, h);
  // The ids (for use, gradients and clips) and the CSS.
  const ids = new Map<string, El>();
  const css = new Map<string, Record<string, string>>();
  const index = (el: El) => {
    if (el.attrs["id"]) ids.set(el.attrs["id"], el);
    if (local(el.name) === "style") for (const [k, v] of cssRules(el.text)) css.set(k, { ...css.get(k), ...v });
    for (const k of el.kids) index(k);
  };
  index(root);
  const base: Mat = [w / vb[2], 0, 0, h / vb[3], (-vb[0] * w) / vb[2], (-vb[1] * h) / vb[3]];
  const initial: Style = { fill: "#000000", fillRule: "nonzero", stroke: "none", strokeWidth: "1", opacity: 1, fillOpacity: 1, strokeOpacity: 1, color: "#000000" };

  /** The element's own properties: attributes, then CSS by tag, class, id, then its style attribute. */
  const props = (el: El): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const p of STYLE_PROPS) if (el.attrs[p] !== undefined) out[p] = el.attrs[p]!;
    const add = (d: Record<string, string> | undefined) => {
      if (d) for (const p of STYLE_PROPS) if (d[p] !== undefined) out[p] = d[p]!;
    };
    add(css.get(local(el.name)));
    for (const c of (el.attrs["class"] ?? "").split(/\s+/).filter(Boolean)) add(css.get(`.${c}`));
    if (el.attrs["id"]) add(css.get(`#${el.attrs["id"]}`));
    if (el.attrs["style"]) add(declarations(el.attrs["style"]));
    return out;
  };

  const inherit = (st: Style, p: Record<string, string>): Style => {
    const s = { ...st };
    if (p["fill"] !== undefined) s.fill = p["fill"];
    if (p["fill-rule"] !== undefined) s.fillRule = p["fill-rule"];
    if (p["stroke"] !== undefined) s.stroke = p["stroke"];
    if (p["stroke-width"] !== undefined) s.strokeWidth = p["stroke-width"];
    if (p["color"] !== undefined) s.color = p["color"];
    // Opacity multiplies down the tree (not inherited in SVG, but a group's opacity covers its children).
    if (p["opacity"] !== undefined) s.opacity = st.opacity * (parseFloat(p["opacity"]) || 0);
    if (p["fill-opacity"] !== undefined) s.fillOpacity = parseFloat(p["fill-opacity"]) || 0;
    if (p["stroke-opacity"] !== undefined) s.strokeOpacity = parseFloat(p["stroke-opacity"]) || 0;
    return s;
  };

  /** A paint as `#rrggbb` (a gradient: the mean of its stops), or null. */
  const paint = (v: string, st: Style, depth = 0): string | null => {
    const s = v.trim();
    if (s === "none" || s === "transparent") return null;
    if (s === "currentColor") return colourOf(st.color);
    const url = /^url\(\s*['"]?#([^'")]+)['"]?\s*\)/.exec(s);
    if (url) {
      const g = ids.get(url[1]!);
      const stops = g ? gradientStops(g, depth) : [];
      if (!stops.length) {
        const fallback = s.slice(url[0].length).trim();
        return fallback ? paint(fallback, st, depth + 1) : null;
      }
      const rgb = [0, 0, 0];
      for (const c of stops) for (let k = 0; k < 3; k++) rgb[k]! += parseInt(c.slice(1 + 2 * k, 3 + 2 * k), 16);
      return `#${rgb.map((x) => Math.round(x / stops.length).toString(16).padStart(2, "0")).join("")}`;
    }
    return colourOf(s);
  };
  const gradientStops = (g: El, depth: number): string[] => {
    const stops = g.kids
      .filter((k) => local(k.name) === "stop")
      .map((k) => {
        const p = { ...k.attrs, ...(k.attrs["style"] ? declarations(k.attrs["style"]) : {}) };
        return colourOf(p["stop-color"] ?? "#000000");
      })
      .filter((c): c is string => c !== null);
    if (stops.length || depth > 4) return stops;
    const href = g.attrs["href"] ?? g.attrs["xlink:href"];
    const next = href?.startsWith("#") ? ids.get(href.slice(1)) : undefined;
    return next ? gradientStops(next, depth + 1) : [];
  };

  /** The cells a clip path lets through, for an element drawn with `ctm`. */
  const clipMask = (ref: string | undefined, ctm: Mat): Set<number> | null => {
    const id = ref ? /url\(\s*['"]?#([^'")]+)['"]?\s*\)/.exec(ref)?.[1] : undefined;
    const clip = id ? ids.get(id) : undefined;
    if (!clip) return null;
    const cells = new Set<number>();
    const m = mul(ctm, parseTransform(clip.attrs["transform"]));
    const walkClip = (el: El, mm: Mat, depth: number) => {
      if (depth > 8) return;
      const name = local(el.name);
      const m2 = mul(mm, parseTransform(el.attrs["transform"]));
      if (name === "use") {
        const target = useTarget(el);
        if (target) walkClip(target, mul(m2, [1, 0, 0, 1, len(el.attrs["x"]), len(el.attrs["y"])]), depth + 1);
        return;
      }
      if (name === "g") {
        for (const k of el.kids) walkClip(k, m2, depth + 1);
        return;
      }
      const geo = shapeOf(el, vb);
      if (!geo?.length) return;
      const rule = (props(el)["clip-rule"] ?? el.attrs["clip-rule"]) === "evenodd";
      for (const c of fillCells(geo.map((g) => g.pts.map((p) => apply(m2, p))), w, h, rule)) cells.add(c);
    };
    for (const k of clip.kids) walkClip(k, m, 0);
    return cells;
  };

  const useTarget = (el: El): El | undefined => {
    const href = el.attrs["href"] ?? el.attrs["xlink:href"];
    return href?.startsWith("#") ? ids.get(href.slice(1)) : undefined;
  };

  const SKIP = new Set(["defs", "clipPath", "mask", "symbol", "title", "desc", "metadata", "pattern", "linearGradient", "radialGradient", "style", "text", "filter", "marker", "namedview", "RDF"]);

  const draw = (el: El, ctm: Mat, st: Style, clip: Set<number> | null, depth: number) => {
    if (depth > 30) return;
    const name = local(el.name);
    if (SKIP.has(name)) return;
    const p = props(el);
    if (p["display"] === "none") return;
    const s = inherit(st, p);
    const m = mul(ctm, parseTransform(el.attrs["transform"]));
    let c = clip;
    if (p["clip-path"] && p["clip-path"] !== "none") {
      const mask = clipMask(p["clip-path"], m);
      if (mask) c = c ? new Set([...mask].filter((x) => c!.has(x))) : mask;
    }
    if (name === "svg" || name === "g" || name === "a" || name === "switch") {
      // A nested svg's own viewport is not mapped: no flag has one but the root.
      for (const k of el.kids) draw(k, m, s, c, depth + 1);
      return;
    }
    if (name === "use") {
      const target = useTarget(el);
      if (!target || depth > 20) return;
      const mm = mul(m, [1, 0, 0, 1, len(el.attrs["x"]), len(el.attrs["y"])]);
      if (local(target.name) === "symbol") for (const k of target.kids) draw(k, mm, s, c, depth + 1);
      else draw(target, mm, s, c, depth + 1);
      return;
    }
    const geo = shapeOf(el, vb);
    if (!geo || p["visibility"] === "hidden") return;
    const put = (cells: number[], hex: string) => {
      const ci = r.colour(hex);
      for (const x of cells) if (!c || c.has(x)) r.cells[x] = ci;
    };
    const fill = paint(s.fill, s);
    if (fill && s.opacity * s.fillOpacity >= 0.35) {
      const closed = geo.map((g) => g.pts.map((q) => apply(m, q))).filter((q) => q.length >= 3);
      put(fillCells(closed, w, h, s.fillRule === "evenodd"), fill);
    }
    const stroke = paint(s.stroke, s);
    if (stroke && s.opacity * s.strokeOpacity >= 0.35) {
      // Half the width in cells (the transform's mean scale); thinner than half a cell is a hairline: not counted.
      const hw = (len(s.strokeWidth, Math.hypot(vb[2], vb[3]) / Math.SQRT2, 1) * Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]))) / 2;
      if (hw >= 0.25) put(strokeCells(geo.map((g) => ({ pts: g.pts.map((q) => apply(m, q)), closed: g.closed })), hw, w, h), stroke);
    }
  };
  for (const k of root.kids) draw(k, base, inherit(initial, props(root)), null, 0);
  return { cells: r.cells, palette: r.palette, h };
}

function apply(m: Mat, p: Pt): Pt {
  return [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
}

/** FNV-1a (32 bits), as 8 hex digits. */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** A flag's colours by share (the cells nothing covers are left out), and its look. */
export function flagColours(svg: string): FlagColours {
  const { cells, palette } = rasterise(svg);
  const counts = new Map<number, number>();
  let drawn = 0;
  for (const c of cells)
    if (c >= 0) {
      counts.set(c, (counts.get(c) ?? 0) + 1);
      drawn++;
    }
  const colours: [string, number][] = [...counts]
    .map(([c, n]): [string, number] => [palette[c]!, drawn ? n / drawn : 0])
    .filter(([, s]) => s >= MIN_SHARE)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([hex, s]) => [hex, Math.round(s * 1000) / 1000]);
  const look = fnv1a(Array.from(cells, (c) => (c >= 0 ? palette[c]! : "-")).join(""));
  return { colours, look };
}

// ---------------------------------------------------------------------------
// How alike

/** sRGB `#rrggbb` to CIE L*a*b* (D65). */
export function lab(hex: string): [number, number, number] {
  const ch = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }) as [number, number, number];
  const [r, g, b] = ch;
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const [fx, fy, fz] = [f(x), f(y), f(z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** ΔE (1976) between two colours. */
export function deltaE(a: string, b: string): number {
  const [l1, a1, b1] = lab(a);
  const [l2, a2, b2] = lab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

/**
 * How unlike two flags' colours are (0: the same colours in the same
 * shares): each colour of one, by its share, how far it is from the
 * nearest colour of the other, both ways, averaged; plus how far the
 * shares of the nearest matches differ, so that a flag mostly red is
 * not like a flag with a red stripe.
 */
export function colourDistance(a: FlagColours, b: FlagColours): number {
  if (!a.colours.length || !b.colours.length) return Infinity;
  const one = (x: FlagColours, y: FlagColours) => {
    let d = 0;
    let total = 0;
    for (const [hex, share] of x.colours) {
      let best = Infinity;
      let other = 0;
      for (const [hy, sy] of y.colours) {
        const e = deltaE(hex, hy);
        if (e < best) {
          best = e;
          other = sy;
        }
      }
      d += share * (best + 50 * Math.abs(share - other));
      total += share;
    }
    return total ? d / total : Infinity;
  };
  return (one(a, b) + one(b, a)) / 2;
}
