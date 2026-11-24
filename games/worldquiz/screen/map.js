// @ts-check
/**
 * Worldquiz's map, for the TV and the phones (docs/worldquiz-design.md
 * §7): the real land of `data/shapes.json` drawn like a cartoon on a
 * canvas, as a flat Mercator map or as a globe, with a camera that flies.
 *
 * - Countries in five pastel colours (neighbours differ), a thick ink
 *   coast drawn under the fills so only its outer half shows, thin ink
 *   borders, a darker sea shadow under the land, dashed graticule and
 *   little waves on a bright sea; the globe in a starry sky with an
 *   atmosphere glow and soft shading.
 * - Highlighted countries in a hot colour with a thick outline, in
 *   place (not lifted or bobbing: shape and size read true); a country
 *   too small to see gets a ring. Pins in players'
 *   colours; a pin's line to where it should have been, growing, with
 *   its distance; a little flag planted where the answer is.
 * - Our own projections: Mercator (the world repeats left and right, so
 *   the Pacific is never cut) and an orthographic globe whose rings are
 *   clipped at the horizon (visible stretches joined along the rim in
 *   the ring's own turning direction).
 * - On a phone (`interactive`): drag to pan or turn, pinch to zoom, tap
 *   to drop a pin (`onTap`).
 */

const D2R = Math.PI / 180;
const INK = "#263450";
const PALETTE = ["#f6d97b", "#a8dd8c", "#f4a6a0", "#c8b4ea", "#f7bf86", "#9fd8cf"];
const NOBODY = "#e9e2cf";
const SEA = "#6cc7e8";
const SEA_SHADOW = "#3f8fb3";
const HOT = "#ff7a45";
/** The second highlight (a country's neighbours beside it in the hot colour). */
const WARM = "#ffc61a";
const LAT_MAX = 84;
const LAT_MIN = -60;

/**
 * @typedef {[number, number]} LonLat
 * @typedef {{ id: string | null, rings: LonLat[][], v: [number, number, number][][], k: number, box: [number, number, number, number] }} Unit
 * @typedef {{ lon: number, lat: number, color: string, label?: string, big?: boolean }} Mark
 * @typedef {{ from: LonLat, to: LonLat, color: string, label?: string, at?: number }} Line a pin's line to where it should have been (`at`: when it starts to grow, ms of performance.now())
 * @typedef {{ lon: number, lat: number, name?: string, flag?: HTMLImageElement | null }} Goal
 * @typedef {{ lon: number, lat: number, zoom: number, R: number }} Cam
 */

/**
 * Rings as `data/shapes.json` codes them (delta-coded, × `scale`), e.g. a
 * shape challenge's outline (game/game.ts `outline`).
 * @param {number[][]} coded @param {number} [scale] @returns {LonLat[][]}
 */
export function decodeRings(coded, scale = 100) {
  /** @type {LonLat[][]} */
  const out = [];
  for (const c of Array.isArray(coded) ? coded : []) {
    if (!Array.isArray(c)) continue;
    /** @type {LonLat[]} */
    const r = [];
    let x = 0;
    let y = 0;
    for (let i = 0; i + 1 < c.length; i += 2) {
      x += Number(c[i]) || 0;
      y += Number(c[i + 1]) || 0;
      r.push([x / scale, y / scale]);
    }
    if (r.length >= 3) out.push(r);
  }
  return out;
}

/** Undoes `data/shapes.json`'s delta coding. @param {{ scale: number, units: { id: string | null, rings: number[][] }[] }} shapes */
export function decodeShapes(shapes) {
  /** @type {Unit[]} */
  const units = [];
  for (const u of shapes.units) {
    /** @type {LonLat[][]} */
    const rings = [];
    for (const coded of u.rings) {
      /** @type {LonLat[]} */
      const r = [];
      let x = 0;
      let y = 0;
      for (let i = 0; i + 1 < coded.length; i += 2) {
        x += /** @type {number} */ (coded[i]);
        y += /** @type {number} */ (coded[i + 1]);
        r.push([x / shapes.scale, y / shapes.scale]);
      }
      if (r.length >= 3) rings.push(r);
    }
    let w = 180, s = 90, e = -180, n = -90;
    for (const r of rings) for (const [lo, la] of r) { w = Math.min(w, lo); e = Math.max(e, lo); s = Math.min(s, la); n = Math.max(n, la); }
    units.push({ id: u.id, rings, v: rings.map((r) => r.map(([lo, la]) => vec(lo, la))), k: 0, box: [w, s, e, n] });
  }
  colour(units);
  // Big land first, so enclaves (Lesotho, San Marino, the Vatican; the shapes keep outer rings only) are drawn on top.
  const size = (/** @type {Unit} */ u) => (u.box[2] - u.box[0]) * (u.box[3] - u.box[1]);
  units.sort((a, b) => size(b) - size(a));
  return units;
}

/** @param {number} lon @param {number} lat @returns {[number, number, number]} */
function vec(lon, lat) {
  const l = lon * D2R;
  const p = lat * D2R;
  return [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)];
}

/**
 * Colours so that countries that touch differ: two countries touch when
 * points of theirs lie within a few km (the simplified borders no longer
 * share their points); greedy, the most connected first.
 * @param {Unit[]} units
 */
function colour(units) {
  const ids = [...new Set(units.map((u) => u.id).filter((id) => id !== null))];
  /** @type {Map<string, Set<string>>} */
  const adj = new Map(ids.map((id) => [/** @type {string} */ (id), new Set()]));
  /** @type {Map<string, Set<string>>} */
  const grid = new Map();
  const cell = 0.25;
  for (const u of units) {
    if (u.id === null) continue;
    for (const r of u.rings) for (const [lo, la] of r) {
      const key = `${Math.round(lo / cell)},${Math.round(la / cell)}`;
      let set = grid.get(key);
      if (!set) grid.set(key, (set = new Set()));
      set.add(u.id);
    }
  }
  for (const [key, set] of grid) {
    const [x, y] = key.split(",").map(Number);
    const near = new Set(set);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const id of grid.get(`${/** @type {number} */ (x) + dx},${/** @type {number} */ (y) + dy}`) ?? []) near.add(id);
    for (const a of set) for (const b of near) if (a !== b) { adj.get(a)?.add(b); adj.get(b)?.add(a); }
  }
  /** @type {Map<string, number>} */
  const k = new Map();
  for (const id of [...adj.keys()].sort((a, b) => (adj.get(b)?.size ?? 0) - (adj.get(a)?.size ?? 0) || a.localeCompare(b))) {
    const used = new Set([...(adj.get(id) ?? [])].map((n) => k.get(n)));
    let c = 0;
    while (used.has(c)) c++;
    k.set(id, c);
  }
  for (const u of units) u.k = u.id === null ? -1 : (k.get(u.id) ?? 0);
}

const mercY = (/** @type {number} */ la) => Math.log(Math.tan(Math.PI / 4 + (Math.max(-85, Math.min(85, la)) * D2R) / 2));
const unmercY = (/** @type {number} */ y) => (2 * Math.atan(Math.exp(y)) - Math.PI / 2) / D2R;
const ease = (/** @type {number} */ u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
const wrap = (/** @type {number} */ lon) => ((((lon + 180) % 360) + 360) % 360) - 180;

/** A small seeded generator for the decorations. @param {number} seed */
function rng(seed) {
  return () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
}

export class WorldMap {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {Unit[]} units
   * @param {{ mode?: "flat" | "globe", borders?: boolean, interactive?: boolean, sky?: boolean, onTap?: (lonlat: LonLat) => void }} [o]
   */
  constructor(canvas, units, o = {}) {
    this.canvas = canvas;
    this.ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
    this.units = units;
    /** @type {"flat" | "globe"} */
    this.mode = o.mode ?? "flat";
    this.borders = o.borders ?? true;
    this.interactive = !!o.interactive;
    this.sky = o.sky ?? true;
    this.onTap = o.onTap;
    /** Countries that pop up. @type {Set<string>} */
    this.hot = new Set();
    this.hotColor = HOT;
    /** Countries in the second highlight colour. @type {Set<string>} */
    this.warm = new Set();
    /** An outline drawn like a hot country, without saying whose (name the shape). @type {LonLat[][] | null} */
    this.outline = null;
    /** @type {{ of: LonLat[][], path: Path2D, v: [number, number, number][][] } | null} */
    this.outlineCache = null;
    /** Only the outline on the sea: no other land, no graticule (name the shape: nothing around gives it away). */
    this.lone = false;
    /** Countries left out of the game (drawn as nobody's land). @type {Set<string>} */
    this.out = new Set();
    /** @type {Mark[]} */
    this.marks = [];
    /** @type {Line[]} */
    this.lines = [];
    /** Where the answer is: a flag on a pole with the name under it. @type {Goal | null} */
    this.goal = null;
    /** A dashed circle (km) around a point, e.g. the winning band. @type {{ lon: number, lat: number, km: number } | null} */
    this.circle = null;
    this.w = 1;
    this.h = 1;
    this.dpr = 1;
    // The camera: flat (centre and zoom, 1 = the world's width fills the canvas), globe (centre and radius as a share of the height).
    /** @type {Cam} */
    this.cam = { lon: 10, lat: 25, zoom: 1, R: 0.42 };
    /** @type {{ start: number, dur: number, from: Cam, to: Cam } | null} */
    this.fly = null;
    this.t0 = performance.now();
    /** Degrees a second the camera drifts east while it does not fly (the lobby). */
    this.spin = 0;
    /** @type {number | undefined} */
    this.last = undefined;
    /** Insets on the right and the left (px) the camera keeps clear, e.g. for a card. */
    this.right = 0;
    this.left = 0;
    /** Insets at the top and the bottom (px), e.g. for panels; the camera keeps them clear. */
    this.top = 0;
    this.bottom = 0;
    this.waves = (() => { const r = rng(7), a = []; for (let i = 0; i < 90; i++) a.push([r() * 360 - 180, r() * 140 - 60]); return a; })();
    this.stars = (() => { const r = rng(3), a = []; for (let i = 0; i < 170; i++) a.push([r(), r(), r() * 1.6 + 0.4, r()]); return a; })();
    /** @type {Map<string, Path2D>} cached flat paths per unit index (Mercator units: radians and mercY) */
    this.flatPaths = new Map();
    this.running = false;
    if (this.interactive) this.#gestures();
  }

  /** Sizes the backing store (CSS px × devicePixelRatio). @param {number} w @param {number} h */
  resize(w, h) {
    this.dpr = Math.min(2.5, globalThis.devicePixelRatio || 1);
    this.w = Math.max(1, w);
    this.h = Math.max(1, h);
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.canvas.style.width = `${this.w}px`;
    this.canvas.style.height = `${this.h}px`;
  }

  /** @param {"flat" | "globe"} mode */
  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
  }

  /** Starts drawing every frame. */
  start() {
    if (this.running) return;
    this.running = true;
    const tick = (/** @type {number} */ now) => {
      if (!this.running) return;
      this.draw(now);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  stop() {
    this.running = false;
  }

  // -------------------------------------------------------------------------
  // The camera

  /** Flat: pixels per radian. */
  get scale() {
    return (this.w / (2 * Math.PI)) * this.cam.zoom;
  }

  /** The smallest zoom: the world's latitudes fill the height. */
  get minZoom() {
    const span = mercY(LAT_MAX) - mercY(LAT_MIN);
    return Math.max(1, (this.h / span) / (this.w / (2 * Math.PI)));
  }

  /**
   * Where the camera goes to show a box: flat (zoom so it fills about
   * `fill` of the free part), globe (turned to it, close enough).
   * `maxZoom`: how close it may get (a shape to name gets closer than a country among others).
   * @param {[number, number, number, number]} box @param {LonLat} [at] @param {number} [fill] @param {number} [maxZoom]
   */
  viewOf(box, at, fill = 0.3, maxZoom = 14) {
    let [w, s, e, n] = box;
    if (e < w) e += 360;
    const lon = at ? at[0] : (w + e) / 2;
    const lat = at ? at[1] : (s + n) / 2;
    const free = this.w - this.right - this.left;
    const wRad = Math.max((e - w) * D2R, 0.03);
    const hMerc = Math.max(mercY(n) - mercY(s), 0.03);
    const base = this.w / (2 * Math.PI);
    const high = Math.max(1, this.h - this.top - this.bottom);
    const zoom = Math.max(this.minZoom, Math.min(maxZoom, Math.min((free * fill) / (wRad * base), (high * fill) / (hMerc * base))));
    const shift = (this.right - this.left) / 2 / (base * zoom) / D2R;
    // Clear of the insets: the box's centre lies in the middle of what is left.
    const flatLat = this.bottom !== this.top ? unmercY(mercY(lat) - (this.bottom - this.top) / 2 / (base * zoom)) : lat;
    const ext = Math.max((e - w) * Math.cos(lat * D2R), n - s, 1) * D2R;
    // The globe gets close only when asked to (a shape to name), else a country stays among others.
    const R = Math.max(0.42, Math.min(maxZoom > 14 ? 8 : 1.2, (0.3 * fill * (high / this.h)) / 0.4 / Math.sin(Math.min(ext, 1.2) / 2 + (maxZoom > 14 ? 0.005 : 0.05))));
    return { lon: wrap(lon + shift), lat: Math.max(-60, Math.min(70, flatLat)), zoom, R, glon: lon, glat: Math.max(-55, Math.min(65, lat)) };
  }

  /** Flies to a box (ms; 0 jumps). @param {[number, number, number, number]} box @param {LonLat} [at] @param {number} [ms] @param {number} [fill] @param {number} [maxZoom] */
  flyTo(box, at, ms = 1600, fill, maxZoom) {
    const v = this.viewOf(box, at, fill, maxZoom);
    this.#flyCam({ lon: this.mode === "globe" ? v.glon : v.lon, lat: this.mode === "globe" ? v.glat : v.lat, zoom: v.zoom, R: v.R }, ms);
  }

  /** The whole world. @param {number} [ms] @param {number} [lon] */
  flyWorld(ms = 1600, lon = 10) {
    this.#flyCam({ lon: this.mode === "globe" ? this.cam.lon : lon, lat: this.mode === "globe" ? 20 : 12, zoom: this.minZoom, R: 0.42 }, ms);
  }

  /** @param {{ lon: number, lat: number, zoom: number, R: number }} to @param {number} ms */
  #flyCam(to, ms) {
    const from = { ...this.cam };
    // The short way round.
    const dl = wrap(to.lon - from.lon);
    const target = { ...to, lon: from.lon + dl };
    if (ms <= 0) {
      this.cam = { ...target, lon: wrap(target.lon) };
      this.fly = null;
      return;
    }
    this.fly = { start: performance.now(), dur: ms, from, to: target };
  }

  /** @param {number} now */
  #step(now) {
    const f = this.fly;
    if (!f) return;
    const u = Math.min(1, (now - f.start) / f.dur);
    const e = ease(u);
    const hop = Math.sin(Math.PI * u);
    const lz = Math.log(f.from.zoom) + (Math.log(f.to.zoom) - Math.log(f.from.zoom)) * e;
    const far = Math.min(1, Math.abs(wrap(f.to.lon - f.from.lon)) / 90 + Math.abs(f.to.lat - f.from.lat) / 60);
    this.cam.zoom = Math.max(this.minZoom, Math.exp(lz - hop * 0.7 * far * Math.min(1, Math.log(Math.max(f.from.zoom, f.to.zoom)) + 0.3)));
    this.cam.lon = f.from.lon + (f.to.lon - f.from.lon) * e;
    this.cam.lat = f.from.lat + (f.to.lat - f.from.lat) * e;
    this.cam.R = Math.exp(Math.log(f.from.R) + (Math.log(f.to.R) - Math.log(f.from.R)) * e) * (1 - 0.22 * hop * far);
    if (u >= 1) {
      this.cam.lon = wrap(this.cam.lon);
      this.fly = null;
    }
  }

  // -------------------------------------------------------------------------
  // Projections

  /** Flat: a point to pixels (x without wrapping). @param {number} lon @param {number} lat @returns {[number, number]} */
  flat(lon, lat) {
    const s = this.scale;
    return [this.w / 2 + wrap(lon - this.cam.lon) * D2R * s, this.h / 2 - (mercY(lat) - mercY(this.cam.lat)) * s];
  }

  /** Globe: the view frame of a unit vector (z towards the viewer). @param {[number, number, number]} v @returns {[number, number, number]} */
  rot(v) {
    const l0 = this.cam.lon * D2R;
    const p0 = this.cam.lat * D2R;
    const [x, y, z] = v;
    const cl = Math.cos(l0), sl = Math.sin(l0);
    const east = -sl * x + cl * y;
    const toward = cl * x + sl * y;
    return [east, Math.cos(p0) * z - Math.sin(p0) * toward, Math.sin(p0) * z + Math.cos(p0) * toward];
  }

  get globe() {
    const R = this.cam.R * this.h;
    return { cx: (this.w - this.right + this.left) / 2, cy: (this.h + this.top - this.bottom) / 2, R };
  }

  /** A point to pixels, or null behind the globe. @param {number} lon @param {number} lat @returns {[number, number] | null} */
  project(lon, lat) {
    if (this.mode === "flat") return this.flat(lon, lat);
    const g = this.globe;
    const w = this.rot(vec(lon, lat));
    return w[2] > 0 ? [g.cx + g.R * w[0], g.cy - g.R * w[1]] : null;
  }

  /** Pixels (CSS) to a point, or null off the globe. @param {number} x @param {number} y @returns {LonLat | null} */
  unproject(x, y) {
    if (this.mode === "flat") {
      const s = this.scale;
      const lat = unmercY(mercY(this.cam.lat) - (y - this.h / 2) / s);
      if (lat > 85 || lat < -85) return null;
      return [wrap(this.cam.lon + (x - this.w / 2) / s / D2R), lat];
    }
    const g = this.globe;
    const px = (x - g.cx) / g.R;
    const py = -(y - g.cy) / g.R;
    const r2 = px * px + py * py;
    if (r2 > 1) return null;
    const z = Math.sqrt(1 - r2);
    const l0 = this.cam.lon * D2R, p0 = this.cam.lat * D2R;
    const lat = Math.asin(z * Math.sin(p0) + py * Math.cos(p0));
    const lon = l0 + Math.atan2(px, z * Math.cos(p0) - py * Math.sin(p0));
    return [wrap(lon / D2R), lat / D2R];
  }

  // -------------------------------------------------------------------------
  // Paths

  /** Flat paths in Mercator units (x: radians east of 0°, y: -mercY), cached per unit. @param {number} i */
  #flatPath(i) {
    const key = String(i);
    let p = this.flatPaths.get(key);
    if (p) return p;
    p = new Path2D();
    const u = /** @type {Unit} */ (this.units[i]);
    for (const r of u.rings) {
      r.forEach(([lo, la], j) => (j ? p.lineTo(lo * D2R, -mercY(la)) : p.moveTo(lo * D2R, -mercY(la))));
      p.closePath();
    }
    this.flatPaths.set(key, p);
    return p;
  }

  /** @param {Unit} u */
  #globePath(u) {
    const p = new Path2D();
    for (const r of u.v) this.#globeRing(p, r);
    return p;
  }

  /**
   * One ring on the globe, clipped at the horizon: each visible stretch
   * ends where it crosses the rim; it is joined to the next stretch along
   * the rim, turning the way the ring turns, so its inside stays inside.
   * @param {Path2D} path @param {[number, number, number][]} ring
   */
  #globeRing(path, ring) {
    const g = this.globe;
    const P = ring.map((v) => this.rot(v));
    const n = P.length;
    const sx = (/** @type {number[]} */ p) => g.cx + g.R * /** @type {number} */ (p[0]);
    const sy = (/** @type {number[]} */ p) => g.cy - g.R * /** @type {number} */ (p[1]);
    const h = P.findIndex((p) => p[2] <= 0);
    if (h < 0) {
      P.forEach((p, i) => (i ? path.lineTo(sx(p), sy(p)) : path.moveTo(sx(p), sy(p))));
      path.closePath();
      return;
    }
    if (P.every((p) => p[2] <= 0)) return;
    const cross = (/** @type {number[]} */ a, /** @type {number[]} */ b) => {
      const [ax, ay, az] = /** @type {[number, number, number]} */ (a);
      const [bx, by, bz] = /** @type {[number, number, number]} */ (b);
      const t = az / (az - bz);
      const qx = ax + (bx - ax) * t, qy = ay + (by - ay) * t;
      const m = Math.hypot(qx, qy) || 1;
      return [qx / m, qy / m];
    };
    /** @type {{ pts: number[][], ein: number, eout: number }[]} */
    const segs = [];
    /** @type {{ pts: number[][], ein: number, eout: number } | null} */
    let cur = null;
    for (let k = 0; k < n; k++) {
      const a = /** @type {number[]} */ (P[(h + k) % n]);
      const b = /** @type {number[]} */ (P[(h + k + 1) % n]);
      const av = /** @type {number} */ (a[2]) > 0, bv = /** @type {number} */ (b[2]) > 0;
      if (!av && bv) { const q = cross(a, b); cur = { pts: [q, b], ein: Math.atan2(/** @type {number} */ (q[1]), /** @type {number} */ (q[0])), eout: 0 }; }
      else if (av && bv) cur?.pts.push(b);
      else if (av && !bv && cur) { const q = cross(a, b); cur.pts.push(q); cur.eout = Math.atan2(/** @type {number} */ (q[1]), /** @type {number} */ (q[0])); segs.push(cur); cur = null; }
    }
    if (!segs.length) return;
    // Which way the ring turns, seen from outside the globe.
    let cx = 0, cy = 0, cz = 0;
    for (const v of ring) { cx += v[0]; cy += v[1]; cz += v[2]; }
    let turn = 0;
    for (let i = 0; i < n; i++) {
      const a = /** @type {[number, number, number]} */ (ring[i]);
      const b = /** @type {[number, number, number]} */ (ring[(i + 1) % n]);
      turn += (a[1] * b[2] - a[2] * b[1]) * cx + (a[2] * b[0] - a[0] * b[2]) * cy + (a[0] * b[1] - a[1] * b[0]) * cz;
    }
    const dir = turn > 0 ? 1 : -1;
    const used = new Set();
    for (let i = 0; i < segs.length; i++) {
      if (used.has(i)) continue;
      let j = i;
      const first = /** @type {number[]} */ (/** @type {any} */ (segs[i]).pts[0]);
      path.moveTo(sx(first), sy(first));
      for (let guard = 0; guard <= segs.length; guard++) {
        used.add(j);
        const sg = /** @type {{ pts: number[][], ein: number, eout: number }} */ (segs[j]);
        for (let m = 1; m < sg.pts.length; m++) path.lineTo(sx(/** @type {number[]} */ (sg.pts[m])), sy(/** @type {number[]} */ (sg.pts[m])));
        let best = i, bd = Infinity;
        for (let k = 0; k < segs.length; k++) {
          if (used.has(k) && k !== i) continue;
          let d = (/** @type {any} */ (segs[k]).ein - sg.eout) * dir;
          d = ((d % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
          if (d < bd) { bd = d; best = k; }
        }
        path.arc(g.cx, g.cy, g.R, -sg.eout, -/** @type {any} */ (segs[best]).ein, dir > 0);
        if (best === i) break;
        j = best;
      }
      path.closePath();
    }
  }

  // -------------------------------------------------------------------------
  // Drawing

  /** @param {number} now */
  draw(now = performance.now()) {
    const dt = Math.min(0.1, Math.max(0, (now - (this.last ?? now)) / 1000));
    this.last = now;
    this.#step(now);
    if (!this.fly && this.spin) this.cam.lon = wrap(this.cam.lon + this.spin * dt);
    const ctx = this.ctx;
    const t = (now - this.t0) / 1000;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (this.mode === "flat") this.#drawFlat(t);
    else this.#drawGlobe(t);
    this.#drawMarks(t);
  }

  /** @param {Unit} u */
  #fill(u) {
    if (u.id === null || this.out.has(u.id)) return NOBODY;
    return /** @type {string} */ (PALETTE[u.k % PALETTE.length]);
  }

  /** @param {number} t */
  #drawFlat(t) {
    const ctx = this.ctx;
    const { w, h } = this;
    const s = this.scale;
    ctx.fillStyle = SEA;
    ctx.fillRect(0, 0, w, h);
    // Graticule (not when the outline is alone: it would tell where) and waves.
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,.35)";
    ctx.lineWidth = 1.3;
    ctx.setLineDash([6, 8]);
    for (let lo = -180; lo < 180 && !this.lone; lo += 30) {
      const [x] = this.flat(lo, 0);
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    for (let la = -60; la <= 80 && !this.lone; la += 20) {
      const [, y] = this.flat(0, la);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.strokeStyle = "#9be0f5";
    ctx.lineWidth = 2.2;
    ctx.lineCap = "round";
    const ws = Math.max(0.7, Math.min(1.6, Math.sqrt(this.cam.zoom) * 0.8));
    for (const [lo, la] of this.waves) {
      const [x, y] = this.flat(/** @type {number} */ (lo), /** @type {number} */ (la));
      if (x < -20 || x > w + 20 || y < -20 || y > h + 20) continue;
      wave(ctx, x, y + Math.sin(t * 1.5 + /** @type {number} */ (lo)) * 2, ws);
    }
    ctx.restore();
    // The world, repeated left and right as far as the canvas shows.
    const cx = w / 2 - this.cam.lon * D2R * s;
    const cy = h / 2 + mercY(this.cam.lat) * s;
    const span = 2 * Math.PI * s;
    const copies = [];
    for (let k = -2; k <= 2; k++) {
      const ox = cx + k * span;
      if (ox + Math.PI * s < -50 || ox - Math.PI * s > w + 50) continue;
      copies.push(ox);
    }
    const coast = Math.max(2.5, Math.min(5, 2 + this.cam.zoom * 0.5));
    for (const pass of this.lone ? [] : ["shadow", "coast", "fill", "border"]) {
      for (const ox of copies) {
        ctx.save();
        ctx.setTransform(this.dpr * s, 0, 0, this.dpr * s, this.dpr * (ox + (pass === "shadow" ? 4 : 0)), this.dpr * (cy + (pass === "shadow" ? 5 : 0)));
        this.units.forEach((u, i) => {
          if (this.#lit(u)) return;
          const p = this.#flatPath(i);
          if (pass === "shadow") { ctx.fillStyle = SEA_SHADOW; ctx.fill(p); }
          else if (pass === "coast") { ctx.lineJoin = "round"; ctx.strokeStyle = INK; ctx.lineWidth = coast / s; ctx.stroke(p); }
          else if (pass === "fill") { ctx.fillStyle = this.#fill(u); ctx.fill(p); }
          else if (this.borders || u.id === null) { ctx.strokeStyle = "rgba(38,52,80,.75)"; ctx.lineWidth = 1 / s; ctx.stroke(p); }
        });
        ctx.restore();
      }
    }
    // Highlighted countries, in place; the outline over everything.
    for (const ox of copies) {
      this.units.forEach((u, i) => {
        const lit = this.lone ? null : this.#lit(u);
        if (!lit) return;
        const p = this.#flatPath(i);
        ctx.save();
        ctx.setTransform(this.dpr * s, 0, 0, this.dpr * s, this.dpr * ox, this.dpr * cy);
        ctx.lineJoin = "round";
        ctx.strokeStyle = INK;
        ctx.lineWidth = 6 / s;
        ctx.stroke(p);
        ctx.fillStyle = lit;
        ctx.fill(p);
        // Enclaves stay themselves on the lifted country.
        this.#enclaves(u).forEach((j) => {
          const q = this.#flatPath(j);
          ctx.fillStyle = this.#fill(/** @type {Unit} */ (this.units[j]));
          ctx.fill(q);
          ctx.lineWidth = 2 / s;
          ctx.stroke(q);
        });
        ctx.restore();
      });
      const o = this.#outline();
      if (o) {
        ctx.save();
        // Alone, it gets the land's sea shadow.
        if (this.lone) {
          ctx.setTransform(this.dpr * s, 0, 0, this.dpr * s, this.dpr * (ox + 4), this.dpr * (cy + 5));
          ctx.fillStyle = SEA_SHADOW;
          ctx.fill(o.path);
        }
        ctx.setTransform(this.dpr * s, 0, 0, this.dpr * s, this.dpr * ox, this.dpr * cy);
        ctx.lineJoin = "round";
        ctx.strokeStyle = INK;
        ctx.lineWidth = 6 / s;
        ctx.stroke(o.path);
        ctx.fillStyle = this.hotColor;
        ctx.fill(o.path);
        ctx.restore();
      }
    }
  }

  /** The outline's extent [w, s, e, n]. @returns {[number, number, number, number]} */
  #outlineBox() {
    let w = 180, s = 90, e = -180, n = -90;
    for (const r of this.outline ?? []) for (const [lo, la] of r) { w = Math.min(w, lo); e = Math.max(e, lo); s = Math.min(s, la); n = Math.max(n, la); }
    return [w, s, e, n];
  }

  /** The highlight colour of a unit, or null. @param {Unit} u */
  #lit(u) {
    if (u.id === null) return null;
    if (this.hot.has(u.id)) return this.hotColor;
    if (this.warm.has(u.id)) return WARM;
    return null;
  }

  /** The outline's flat path (Mercator units) and its rings as vectors, made once per outline. */
  #outline() {
    const rings = this.outline;
    if (!rings?.length) return null;
    if (this.outlineCache?.of !== rings) {
      const path = new Path2D();
      for (const r of rings) {
        r.forEach(([lo, la], j) => (j ? path.lineTo(lo * D2R, -mercY(la)) : path.moveTo(lo * D2R, -mercY(la))));
        path.closePath();
      }
      this.outlineCache = { of: rings, path, v: rings.map((r) => r.map(([lo, la]) => vec(lo, la))) };
    }
    return this.outlineCache;
  }

  /** The units lying inside a unit's box and much smaller (enclaves), by index. @param {Unit} u */
  #enclaves(u) {
    const [w, s, e, n] = u.box;
    const area = (e - w) * (n - s);
    /** @type {number[]} */
    const out = [];
    this.units.forEach((v, j) => {
      if (v === u || this.#lit(v)) return;
      const [a, b, c, d] = v.box;
      if (a >= w && c <= e && b >= s && d <= n && (c - a) * (d - b) < area * 0.02 && v.id !== null) out.push(j);
    });
    return out;
  }

  /** @param {number} t */
  #drawGlobe(t) {
    const ctx = this.ctx;
    const { w, h } = this;
    const g = this.globe;
    if (this.sky) {
      const bg = ctx.createLinearGradient(0, 0, 0, h);
      bg.addColorStop(0, "#1b2448");
      bg.addColorStop(1, "#2d2a5c");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = "#fff";
      for (const [x, y, r, ph] of this.stars) {
        ctx.globalAlpha = 0.35 + 0.65 * Math.abs(Math.sin(t * 1.3 + /** @type {number} */ (ph) * 9));
        ctx.beginPath();
        ctx.arc(/** @type {number} */ (x) * w, /** @type {number} */ (y) * h, /** @type {number} */ (r), 0, 7);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      const glow = ctx.createRadialGradient(g.cx, g.cy, g.R * 0.92, g.cx, g.cy, g.R * 1.16);
      glow.addColorStop(0, "rgba(140,220,255,.55)");
      glow.addColorStop(1, "rgba(140,220,255,0)");
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(g.cx, g.cy, g.R * 1.2, 0, 7);
      ctx.fill();
    } else {
      ctx.clearRect(0, 0, w, h);
    }
    ctx.fillStyle = SEA;
    ctx.beginPath();
    ctx.arc(g.cx, g.cy, g.R, 0, 7);
    ctx.fill();
    ctx.save();
    ctx.beginPath();
    ctx.arc(g.cx, g.cy, g.R, 0, 7);
    ctx.clip();
    // Graticule.
    ctx.strokeStyle = "rgba(255,255,255,.3)";
    ctx.lineWidth = 1.2;
    ctx.setLineDash([5, 7]);
    const line = (/** @type {LonLat[]} */ pts) => {
      let on = false;
      ctx.beginPath();
      for (const [lo, la] of pts) {
        const q = this.project(lo, la);
        if (q) { on ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); on = true; } else on = false;
      }
      ctx.stroke();
    };
    for (let lo = -180; lo < 180 && !this.lone; lo += 30) line(Array.from({ length: 37 }, (_, i) => /** @type {LonLat} */ ([lo, -90 + i * 5])));
    for (let la = -60; la <= 60 && !this.lone; la += 30) line(Array.from({ length: 91 }, (_, i) => /** @type {LonLat} */ ([-180 + i * 4, la])));
    ctx.setLineDash([]);
    // Alone, the outline is the only land.
    const paths = this.lone ? [] : this.units.map((u) => this.#globePath(u));
    ctx.lineJoin = "round";
    ctx.strokeStyle = INK;
    ctx.lineWidth = Math.max(2.5, Math.min(4.5, g.R / 90));
    paths.forEach((p, i) => { const u = /** @type {Unit} */ (this.units[i]); if (!this.#lit(u)) ctx.stroke(p); });
    paths.forEach((p, i) => { const u = /** @type {Unit} */ (this.units[i]); if (!this.#lit(u)) { ctx.fillStyle = this.#fill(u); ctx.fill(p); } });
    ctx.strokeStyle = "rgba(38,52,80,.75)";
    ctx.lineWidth = 1;
    paths.forEach((p, i) => { const u = /** @type {Unit} */ (this.units[i]); if (!this.#lit(u) && (this.borders || u.id === null)) ctx.stroke(p); });
    paths.forEach((p, i) => {
      const u = /** @type {Unit} */ (this.units[i]);
      const lit = this.#lit(u);
      if (!lit) return;
      ctx.save();
      ctx.strokeStyle = INK;
      ctx.lineWidth = 6;
      ctx.stroke(p);
      ctx.fillStyle = lit;
      ctx.fill(p);
      for (const j of this.#enclaves(u)) {
        const q = /** @type {Path2D} */ (paths[j]);
        ctx.fillStyle = this.#fill(/** @type {Unit} */ (this.units[j]));
        ctx.fill(q);
        ctx.lineWidth = 2;
        ctx.stroke(q);
      }
      ctx.restore();
    });
    const o = this.#outline();
    if (o) {
      const p = new Path2D();
      for (const r of o.v) this.#globeRing(p, r);
      ctx.strokeStyle = INK;
      ctx.lineWidth = 6;
      ctx.stroke(p);
      ctx.fillStyle = this.hotColor;
      ctx.fill(p);
    }
    // Shading: light from the upper left.
    const sh = ctx.createRadialGradient(g.cx - g.R * 0.4, g.cy - g.R * 0.45, g.R * 0.1, g.cx, g.cy, g.R * 1.05);
    sh.addColorStop(0, "rgba(255,255,255,.26)");
    sh.addColorStop(0.55, "rgba(255,255,255,0)");
    sh.addColorStop(1, "rgba(10,20,70,.4)");
    ctx.fillStyle = sh;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
    ctx.lineWidth = 4;
    ctx.strokeStyle = INK;
    ctx.beginPath();
    ctx.arc(g.cx, g.cy, g.R, 0, 7);
    ctx.stroke();
  }

  /** @param {number} t */
  #drawMarks(t) {
    const ctx = this.ctx;
    // Rings around hot countries too small to see (still: no pulsing).
    for (const u of this.units) {
      const lit = this.#lit(u);
      if (!lit) continue;
      const [w, s, e, n] = u.box;
      const a = this.project(w, s), b = this.project(e, n);
      if (!a || !b || Math.hypot(a[0] - b[0], a[1] - b[1]) > 26) continue;
      const c = this.project((w + e) / 2, (s + n) / 2);
      if (!c) continue;
      const r = 18;
      ctx.lineWidth = 5;
      ctx.strokeStyle = INK;
      ctx.beginPath();
      ctx.arc(c[0], c[1], r, 0, 7);
      ctx.stroke();
      ctx.lineWidth = 3;
      ctx.strokeStyle = lit;
      ctx.stroke();
    }
    // A small outline gets its ring too.
    const ob = this.outline?.length ? this.#outlineBox() : null;
    if (ob) {
      const a = this.project(ob[0], ob[1]), b = this.project(ob[2], ob[3]), c = this.project((ob[0] + ob[2]) / 2, (ob[1] + ob[3]) / 2);
      if (a && b && c && Math.hypot(a[0] - b[0], a[1] - b[1]) <= 26) {
        ctx.lineWidth = 5;
        ctx.strokeStyle = INK;
        ctx.beginPath();
        ctx.arc(c[0], c[1], 18, 0, 7);
        ctx.stroke();
        ctx.lineWidth = 3;
        ctx.strokeStyle = this.hotColor;
        ctx.stroke();
      }
    }
    if (this.circle) {
      const { lon, lat, km } = this.circle;
      const pts = [];
      const d = km / 6371;
      const p1 = lat * D2R, l1 = lon * D2R;
      for (let i = 0; i <= 72; i++) {
        const b = (i / 72) * 2 * Math.PI;
        const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
        const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
        pts.push(this.project(l2 / D2R, p2 / D2R));
      }
      ctx.save();
      ctx.setLineDash([8, 8]);
      ctx.lineWidth = 3;
      ctx.strokeStyle = "#fff";
      ctx.beginPath();
      let on = false;
      let px = 0;
      for (const q of pts) {
        if (q && (!on || Math.abs(q[0] - px) < this.w / 2)) { on ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); on = true; px = q[0]; } else if (q) { ctx.moveTo(q[0], q[1]); px = q[0]; } else on = false;
      }
      ctx.stroke();
      ctx.restore();
    }
    const now = performance.now();
    /** @type {{ x: number, y: number, text: string, color: string }[]} */
    const labels = [];
    for (const l of this.lines) {
      const k = Math.max(0, Math.min(1, (now - (l.at ?? 0)) / 900));
      if (k <= 0) continue;
      const pts = this.#arc(l.from, l.to, ease(k));
      if (pts.length < 2) continue;
      ctx.save();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      for (const [width, color] of /** @type {[number, string][]} */ ([[8, INK], [4.5, l.color]])) {
        ctx.lineWidth = width;
        ctx.strokeStyle = color;
        ctx.beginPath();
        let on = false;
        for (const q of pts) {
          if (!q) { on = false; continue; }
          on ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]);
          on = true;
        }
        ctx.stroke();
      }
      const end = pts.at(-1);
      if (k >= 1 && end) {
        // Where the distance was measured to.
        ctx.fillStyle = "#fff";
        ctx.strokeStyle = INK;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(end[0], end[1], 6, 0, 7);
        ctx.fill();
        ctx.stroke();
        const mid = pts[Math.floor(pts.length / 2)];
        if (l.label && mid) labels.push({ x: mid[0], y: mid[1], text: l.label, color: l.color });
      }
      ctx.restore();
    }
    // Pins: the small ones first, the winners' on top.
    for (const m of [...this.marks].sort((a, b) => Number(!!a.big) - Number(!!b.big))) {
      const q = this.project(m.lon, m.lat);
      if (!q) continue;
      pin(ctx, q[0], q[1], m.color, m.label ?? "", m.big ? 1.15 : 0.9);
    }
    for (const l of labels) tag(ctx, l.x, l.y, l.text, l.color, "#fff", Math.max(13, this.h / 48));
    if (this.goal) {
      const q = this.project(this.goal.lon, this.goal.lat);
      if (q) goalFlag(ctx, q[0], q[1], this.goal, Math.max(0.8, this.h / 720), t);
    }
  }

  /**
   * The great circle from `a` to `b`, as far as `k` (0–1) of the way, in
   * pixels: null where it is behind the globe; on the flat map one
   * unbroken line across the date line.
   * @param {LonLat} a @param {LonLat} b @param {number} k
   * @returns {([number, number] | null)[]}
   */
  #arc(a, b, k) {
    const va = vec(a[0], a[1]);
    const vb = vec(b[0], b[1]);
    const om = Math.acos(Math.max(-1, Math.min(1, va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2])));
    const n = Math.max(2, Math.ceil(48 * k));
    /** @type {([number, number] | null)[]} */
    const out = [];
    const span = 2 * Math.PI * this.scale;
    for (let i = 0; i <= n; i++) {
      const u = (i / n) * k;
      let v = va;
      if (om > 1e-9) {
        const s0 = Math.sin((1 - u) * om) / Math.sin(om);
        const s1 = Math.sin(u * om) / Math.sin(om);
        v = [s0 * va[0] + s1 * vb[0], s0 * va[1] + s1 * vb[1], s0 * va[2] + s1 * vb[2]];
      }
      const lon = Math.atan2(v[1], v[0]) / D2R;
      const lat = Math.asin(Math.max(-1, Math.min(1, v[2]))) / D2R;
      const q = this.project(lon, lat);
      if (q && this.mode === "flat" && out.length && span > 1) {
        const prev = out[out.length - 1];
        if (prev) {
          while (q[0] - prev[0] > span / 2) q[0] -= span;
          while (prev[0] - q[0] > span / 2) q[0] += span;
        }
      }
      out.push(q);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Gestures (phones)

  #gestures() {
    const el = this.canvas;
    el.style.touchAction = "none";
    /** @type {Map<number, { x: number, y: number }>} */
    const pts = new Map();
    /** @type {{ x: number, y: number, t: number, moved: boolean, cam: Cam, dist: number, mid: { x: number, y: number } } | null} */
    let g = null;
    const local = (/** @type {PointerEvent} */ e) => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const twoFinger = () => {
      const [a, b] = [...pts.values()];
      if (!a || !b) return null;
      return { dist: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
    };
    el.addEventListener("pointerdown", (e) => {
      el.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, local(e));
      this.fly = null;
      const tf = twoFinger();
      const p = local(e);
      g = { x: p.x, y: p.y, t: performance.now(), moved: pts.size > 1, cam: { ...this.cam }, dist: tf?.dist ?? 0, mid: tf?.mid ?? p };
    });
    el.addEventListener("pointermove", (e) => {
      if (!pts.has(e.pointerId) || !g) return;
      pts.set(e.pointerId, local(e));
      const tf = twoFinger();
      if (tf && g.dist > 0) {
        g.moved = true;
        const k = tf.dist / g.dist;
        if (this.mode === "flat") {
          this.cam.zoom = Math.max(this.minZoom, Math.min(40, g.cam.zoom * k));
          const s = this.scale;
          const before = { lon: g.cam.lon + (g.mid.x - this.w / 2) / ((this.w / (2 * Math.PI)) * g.cam.zoom) / D2R };
          this.cam.lon = wrap(before.lon - (tf.mid.x - this.w / 2) / s / D2R);
          this.cam.lat = this.#clampLat(unmercY(mercY(g.cam.lat) + (g.mid.y - this.h / 2) / ((this.w / (2 * Math.PI)) * g.cam.zoom) - (tf.mid.y - this.h / 2) / s));
        } else this.cam.R = Math.max(0.3, Math.min(6, g.cam.R * k));
        return;
      }
      if (pts.size > 1) return;
      const p = local(e);
      const dx = p.x - g.x, dy = p.y - g.y;
      if (!g.moved && Math.hypot(dx, dy) < 8) return;
      g.moved = true;
      if (this.mode === "flat") {
        const s = this.scale;
        this.cam.lon = wrap(g.cam.lon - dx / s / D2R);
        this.cam.lat = this.#clampLat(unmercY(mercY(g.cam.lat) + dy / s));
      } else {
        const R = this.globe.R;
        this.cam.lon = wrap(g.cam.lon - (dx / R) * 57.3);
        this.cam.lat = Math.max(-80, Math.min(80, g.cam.lat + (dy / R) * 57.3));
      }
    });
    const end = (/** @type {PointerEvent} */ e) => {
      const was = g;
      pts.delete(e.pointerId);
      if (pts.size > 0) {
        // One finger left after a pinch: carry on dragging from here.
        const [rest] = [...pts.values()];
        if (rest) g = { x: rest.x, y: rest.y, t: performance.now(), moved: true, cam: { ...this.cam }, dist: 0, mid: rest };
        return;
      }
      g = null;
      if (!was || was.moved || e.type === "pointercancel" || performance.now() - was.t > 600) return;
      const p = local(e);
      const ll = this.unproject(p.x, p.y);
      if (ll) this.onTap?.(ll);
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
    el.addEventListener("wheel", (e) => {
      e.preventDefault();
      const k = Math.exp(-e.deltaY / 300);
      if (this.mode === "flat") this.cam.zoom = Math.max(this.minZoom, Math.min(40, this.cam.zoom * k));
      else this.cam.R = Math.max(0.3, Math.min(6, this.cam.R * k));
    }, { passive: false });
  }

  /** Keeps the flat map's edge from showing past the poles' cut. @param {number} lat */
  #clampLat(lat) {
    const half = this.h / 2 / this.scale;
    const top = mercY(LAT_MAX) - half;
    const bottom = mercY(LAT_MIN) + half;
    const y = mercY(lat);
    return unmercY(top < bottom ? (top + bottom) / 2 : Math.max(bottom, Math.min(top, y)));
  }

  /** Zoom steps for buttons. @param {number} k */
  zoomBy(k) {
    this.fly = null;
    if (this.mode === "flat") this.cam.zoom = Math.max(this.minZoom, Math.min(40, this.cam.zoom * k));
    else this.cam.R = Math.max(0.3, Math.min(6, this.cam.R * k));
  }
}

/** @param {CanvasRenderingContext2D} ctx @param {number} x @param {number} y @param {number} s */
function wave(ctx, x, y, s) {
  ctx.beginPath();
  ctx.moveTo(x - 9 * s, y);
  ctx.quadraticCurveTo(x - 4.5 * s, y - 6 * s, x, y);
  ctx.quadraticCurveTo(x + 4.5 * s, y + 6 * s, x + 9 * s, y);
  ctx.stroke();
}

/**
 * A rounded label centred on (x, y).
 * @param {CanvasRenderingContext2D} ctx @param {number} x @param {number} y @param {string} text @param {string} bg @param {string} fg @param {number} size font size (px)
 */
function tag(ctx, x, y, text, bg, fg, size) {
  ctx.save();
  ctx.font = `900 ${Math.round(size)}px Grandstander, system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const w = ctx.measureText(text).width + size * 1.1;
  const hh = size * 1.6;
  ctx.fillStyle = "rgba(20,30,60,.3)";
  roundRect(ctx, x - w / 2 + 2, y - hh / 2 + 4, w, hh, hh / 2);
  ctx.fill();
  ctx.fillStyle = bg;
  ctx.strokeStyle = INK;
  ctx.lineWidth = 3;
  roundRect(ctx, x - w / 2, y - hh / 2, w, hh, hh / 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = fg;
  ctx.fillText(text, x, y + 1);
  ctx.restore();
}

/** @param {CanvasRenderingContext2D} ctx @param {number} x @param {number} y @param {number} w @param {number} h @param {number} r */
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * Where the answer is: a pole planted on (x, y) with the country's flag
 * waving on it and its name on a label at the foot.
 * @param {CanvasRenderingContext2D} ctx @param {number} x @param {number} y @param {Goal} g @param {number} s @param {number} t
 */
function goalFlag(ctx, x, y, g, s, t) {
  const pole = 62 * s;
  const fw = 46 * s;
  const fh = 31 * s;
  ctx.save();
  ctx.lineCap = "round";
  // The foot: a little mound.
  ctx.fillStyle = "rgba(20,30,60,.3)";
  ctx.beginPath();
  ctx.ellipse(x, y + 2, 12 * s, 5 * s, 0, 0, 7);
  ctx.fill();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 7 * s;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x, y - pole);
  ctx.stroke();
  ctx.strokeStyle = "#fff8e8";
  ctx.lineWidth = 3 * s;
  ctx.stroke();
  // The cloth: the flag, a little wave in its top and bottom edges.
  const top = y - pole + 2 * s;
  const wave = Math.sin(t * 3) * 2.5 * s;
  ctx.beginPath();
  ctx.moveTo(x, top);
  ctx.quadraticCurveTo(x + fw / 2, top - wave, x + fw, top + wave * 0.5);
  ctx.lineTo(x + fw, top + fh + wave * 0.5);
  ctx.quadraticCurveTo(x + fw / 2, top + fh - wave, x, top + fh);
  ctx.closePath();
  ctx.fillStyle = "#fff";
  ctx.fill();
  if (g.flag?.complete && g.flag.naturalWidth) {
    ctx.save();
    ctx.clip();
    ctx.drawImage(g.flag, x, top - 3 * s, fw, fh + 6 * s);
    ctx.restore();
  }
  ctx.strokeStyle = INK;
  ctx.lineWidth = 3.5 * s;
  ctx.lineJoin = "round";
  ctx.stroke();
  // The knob.
  ctx.fillStyle = "#ffcf4a";
  ctx.lineWidth = 2.5 * s;
  ctx.beginPath();
  ctx.arc(x, y - pole - 3 * s, 5 * s, 0, 7);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
  if (g.name) tag(ctx, x, y + 16 * s, g.name, "#fff8e8", INK, 17 * s);
}

/**
 * A cartoon pin standing on (x, y): a drop with a white eye, or a
 * letter in it.
 * @param {CanvasRenderingContext2D} ctx @param {number} x @param {number} y @param {string} color @param {string} label @param {number} s
 */
export function pin(ctx, x, y, color, label, s = 1) {
  const h = 46 * s;
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = "rgba(20,30,60,.3)";
  ctx.beginPath();
  ctx.ellipse(0, 0, 9 * s, 4 * s, 0, 0, 7);
  ctx.fill();
  ctx.lineWidth = 3.5;
  ctx.lineJoin = "round";
  ctx.strokeStyle = INK;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.bezierCurveTo(-4 * s, -h * 0.45, -17 * s, -h * 0.6, -17 * s, -h * 0.78);
  ctx.arc(0, -h * 0.78, 17 * s, Math.PI, 0);
  ctx.bezierCurveTo(17 * s, -h * 0.6, 4 * s, -h * 0.45, 0, 0);
  ctx.closePath();
  ctx.stroke();
  ctx.fill();
  if (label) {
    ctx.fillStyle = "#fff";
    ctx.font = `900 ${Math.round(17 * s)}px Grandstander, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, 0, -h * 0.78 + 1);
  } else {
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(0, -h * 0.8, 6.5 * s, 0, 7);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}
