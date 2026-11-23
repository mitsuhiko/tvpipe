/**
 * Snug's rules as pure functions (docs/snug-design.md): the pieces and
 * their orientations, the difficulty ladder and the checks, the generator
 * (grow a shape out of the needed pieces, add the spares, count the ways
 * to fill it, estimate its dead first placements, keep one by the rung),
 * the deal, checking a placement, the solver that counts
 * fillings and proves dead ends, and a seeded random source. No party,
 * no timers: `game.ts` plays these.
 *
 * Coordinates: `x` to the right, `y` down, cells as `[x, y]`.
 */

export type Cell = readonly [number, number];
export type Lang = "en" | "de";
export const LANGS: readonly Lang[] = ["en", "de"];

export const LEVELS = ["easy", "normal", "hard"] as const;
export type Level = (typeof LEVELS)[number];
export const PACES = ["relaxed", "normal", "rushed"] as const;
export type Pace = (typeof PACES)[number];
export const PACE_FACTOR: Record<Pace, number> = { relaxed: 1.5, normal: 1, rushed: 0.75 };

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 8;

/**
 * The free polyominoes of 3 to 5 cells, each in one orientation (the
 * others come from {@link orientations}). The names are ours, for tests
 * and logs; players never see them.
 */
export const PIECES = {
  I3: [[0, 0], [1, 0], [2, 0]],
  V3: [[0, 0], [1, 0], [0, 1]],
  I4: [[0, 0], [1, 0], [2, 0], [3, 0]],
  O4: [[0, 0], [1, 0], [0, 1], [1, 1]],
  T4: [[0, 0], [1, 0], [2, 0], [1, 1]],
  L4: [[0, 0], [0, 1], [0, 2], [1, 2]],
  S4: [[1, 0], [2, 0], [0, 1], [1, 1]],
  F5: [[1, 0], [2, 0], [0, 1], [1, 1], [1, 2]],
  I5: [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]],
  L5: [[0, 0], [0, 1], [0, 2], [0, 3], [1, 3]],
  N5: [[0, 0], [1, 0], [1, 1], [2, 1], [3, 1]],
  P5: [[0, 0], [1, 0], [0, 1], [1, 1], [0, 2]],
  T5: [[0, 0], [1, 0], [2, 0], [1, 1], [1, 2]],
  U5: [[0, 0], [2, 0], [0, 1], [1, 1], [2, 1]],
  V5: [[0, 0], [0, 1], [0, 2], [1, 2], [2, 2]],
  W5: [[0, 0], [0, 1], [1, 1], [1, 2], [2, 2]],
  X5: [[1, 0], [0, 1], [1, 1], [2, 1], [1, 2]],
  Y5: [[0, 0], [1, 0], [2, 0], [3, 0], [1, 1]],
  Z5: [[0, 0], [1, 0], [1, 1], [1, 2], [2, 2]],
} as const satisfies Record<string, readonly Cell[]>;
export type Kind = keyof typeof PIECES;

export const TROMINOES: readonly Kind[] = ["I3", "V3"];
export const TETROMINOES: readonly Kind[] = ["I4", "O4", "T4", "L4", "S4"];
export const PENTOMINOES: readonly Kind[] = ["F5", "I5", "L5", "N5", "P5", "T5", "U5", "V5", "W5", "X5", "Y5", "Z5"];

/** A mix of pieces: the share drawn from the big pool, the rest from the small one. */
export interface Mix {
  small: readonly Kind[];
  big: readonly Kind[];
  share: number;
}

const SMALL: Mix = { small: TROMINOES, big: TETROMINOES, share: 0.75 };
const TETRO: Mix = { small: TETROMINOES, big: TETROMINOES, share: 1 };
const HALF: Mix = { small: TETROMINOES, big: PENTOMINOES, share: 0.5 };
const BIG: Mix = { small: TETROMINOES, big: PENTOMINOES, share: 2 / 3 };

/** A rung of the ladder: the pieces, and which of the tries to keep (0 the most forgiving, 1 the least, by {@link deadShare}). */
export interface Rung {
  mix: Mix;
  rank: number;
}

/**
 * The difficulty ladder (docs/snug-design.md §7): every solved shape
 * climbs a rung, the level only says where a game starts. With two
 * players the rungs leave about 47, 60, 73, 77, 88, 93, 95 and 97 % of
 * first placements dead.
 */
export const LADDER: readonly Rung[] = [
  { mix: SMALL, rank: 0.1 },
  { mix: SMALL, rank: 0.35 },
  { mix: SMALL, rank: 0.65 },
  { mix: TETRO, rank: 0.5 },
  { mix: HALF, rank: 0.5 },
  { mix: BIG, rank: 0.5 },
  { mix: BIG, rank: 0.8 },
  { mix: BIG, rank: 1 },
];

/** The rung a level starts on. */
export const START_RUNG: Record<Level, number> = { easy: 0, normal: 3, hard: 4 };

/** The rung of a game's shape after `solved` filled ones. */
export function rungOf(level: Level, solved: number): number {
  return Math.min(LADDER.length - 1, START_RUNG[level] + Math.max(0, Math.floor(solved)));
}

/**
 * The checks ("can this still work out?") a level gives the team: how many
 * at the start and how many it can hold (null: as many as it likes); every
 * filled shape earns one, up to `max`.
 */
export const CHECKS: Record<Level, { start: number; max: number } | null> = {
  easy: null,
  normal: { start: 3, max: 3 },
  hard: { start: 0, max: 1 },
};

/** A check's solver steps: about 50 ms; a check that runs out says nothing and is not used up. */
export const CHECK_BUDGET = 300_000;

// ---------------------------------------------------------------------------
// Random

/** A seeded random source in [0, 1) (mulberry32). */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(xs: readonly T[], rng: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

const pick = <T>(xs: readonly T[], rng: () => number): T => xs[Math.floor(rng() * xs.length)]!;

// ---------------------------------------------------------------------------
// Shapes

export const key = (x: number, y: number): number => y * 1024 + x;

/** Cells moved to the top left (smallest x and y 0), sorted in reading order. */
export function normalize(cells: readonly Cell[]): Cell[] {
  let mx = Infinity;
  let my = Infinity;
  for (const [x, y] of cells) {
    mx = Math.min(mx, x);
    my = Math.min(my, y);
  }
  return cells.map(([x, y]) => [x - mx, y - my] as Cell).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
}

const sig = (cells: readonly Cell[]): string => cells.map(([x, y]) => `${x},${y}`).join(" ");

const orientationCache = new Map<string, Cell[][]>();

/** Every distinct orientation of a shape (turned and flipped), normalized, in a fixed order. */
export function orientations(cells: readonly Cell[]): Cell[][] {
  const k = sig(normalize(cells));
  const hit = orientationCache.get(k);
  if (hit) return hit;
  const out = new Map<string, Cell[]>();
  let cur: Cell[] = [...cells];
  for (let f = 0; f < 2; f++) {
    for (let r = 0; r < 4; r++) {
      const n = normalize(cur);
      const s = sig(n);
      if (!out.has(s)) out.set(s, n);
      cur = cur.map(([x, y]) => [-y, x] as Cell);
    }
    cur = cur.map(([x, y]) => [-x, y] as Cell);
  }
  const list = [...out.values()];
  orientationCache.set(k, list);
  return list;
}

/** Whether `cells` (anywhere) is the shape `base` turned or flipped. */
export function sameShape(base: readonly Cell[], cells: readonly Cell[]): boolean {
  if (base.length !== cells.length) return false;
  const s = sig(normalize(cells));
  return orientations(base).some((o) => sig(o) === s);
}

/** A shape turned a quarter clockwise, normalized. */
export function turn(cells: readonly Cell[]): Cell[] {
  return normalize(cells.map(([x, y]) => [-y, x] as Cell));
}

/** A shape flipped left to right, normalized. */
export function flip(cells: readonly Cell[]): Cell[] {
  return normalize(cells.map(([x, y]) => [-x, y] as Cell));
}

/** Whether cells are 4-connected and distinct. */
export function connected(cells: readonly Cell[]): boolean {
  if (cells.length === 0) return false;
  const set = new Set(cells.map(([x, y]) => key(x, y)));
  if (set.size !== cells.length) return false;
  const seen = new Set<number>();
  const stack: Cell[] = [cells[0]!];
  while (stack.length) {
    const [x, y] = stack.pop()!;
    const k = key(x, y);
    if (seen.has(k) || !set.has(k)) continue;
    seen.add(k);
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
  return seen.size === set.size;
}

// ---------------------------------------------------------------------------
// Boards

/** A board's shape: `rows` of `#` (a cell to fill) and `.` (not part of it). */
export interface Shape {
  w: number;
  h: number;
  rows: string[];
}

export function shapeCells(s: Shape): Cell[] {
  const out: Cell[] = [];
  s.rows.forEach((r, y) => [...r].forEach((c, x) => c === "#" && out.push([x, y])));
  return out;
}

export function shapeOf(cells: readonly Cell[]): Shape {
  let w = 0;
  let h = 0;
  for (const [x, y] of cells) {
    w = Math.max(w, x + 1);
    h = Math.max(h, y + 1);
  }
  const grid = Array.from({ length: h }, () => Array.from({ length: w }, () => "."));
  for (const [x, y] of cells) grid[y]![x] = "#";
  return { w, h, rows: grid.map((r) => r.join("")) };
}

/** Parses rows (`#`, `.`, or a piece's letter for a fixture's solution) into the shape and the letters' cells. */
export function parseRows(rows: readonly string[]): { shape: Shape; pieces: Map<string, Cell[]> } {
  const cells: Cell[] = [];
  const pieces = new Map<string, Cell[]>();
  rows.forEach((r, y) =>
    [...r].forEach((c, x) => {
      if (c === "." || c === " ") return;
      cells.push([x, y]);
      if (c !== "#") pieces.set(c, [...(pieces.get(c) ?? []), [x, y]]);
    }),
  );
  return { shape: shapeOf(cells), pieces };
}

/** Empty cells of a box that cannot reach its edge through other empty cells. */
export function holes(cells: readonly Cell[]): number {
  const set = new Set(cells.map(([x, y]) => key(x + 1, y + 1)));
  let w = 0;
  let h = 0;
  for (const [x, y] of cells) {
    w = Math.max(w, x + 3);
    h = Math.max(h, y + 3);
  }
  const seen = new Set<number>();
  const stack: Cell[] = [[0, 0]];
  while (stack.length) {
    const [x, y] = stack.pop()!;
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    const k = key(x, y);
    if (seen.has(k) || set.has(k)) continue;
    seen.add(k);
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
  return w * h - seen.size - set.size;
}

// ---------------------------------------------------------------------------
// The solver

export interface Count {
  /** Fillings found (at most `limit`). */
  count: number;
  /** Whether the search finished: false when it ran out of steps (`count` is then a lower bound). */
  complete: boolean;
  /** The first filling found: per piece index, its cells (unused pieces missing). */
  first: Map<number, Cell[]> | null;
}

/**
 * Counts the ways to cover exactly the cells `free` with some of
 * `pieces` (each at most once; pieces may stay unused), up to `limit`,
 * within `budget` steps. Pieces of the same shape count once.
 */
export function countFillings(free: readonly Cell[], pieces: readonly (readonly Cell[])[], o: { limit?: number; budget?: number } = {}): Count {
  const limit = o.limit ?? 50;
  let steps = o.budget ?? 40_000;
  if (free.length === 0) return { count: 1, complete: true, first: new Map() };
  if (pieces.reduce((a, p) => a + p.length, 0) < free.length) return { count: 0, complete: true, first: null };
  // A flat grid with a margin of 5 on every side; 1 = blocked (off the free cells or covered).
  let mx = Infinity;
  let my = Infinity;
  let Mx = 0;
  let My = 0;
  for (const [x, y] of free) {
    mx = Math.min(mx, x);
    my = Math.min(my, y);
    Mx = Math.max(Mx, x);
    My = Math.max(My, y);
  }
  const W = Mx - mx + 11;
  const H = My - my + 11;
  const grid = new Uint8Array(W * H).fill(1);
  const at = (x: number, y: number) => (y - my + 5) * W + (x - mx + 5);
  for (const [x, y] of free) grid[at(x, y)] = 0;
  const end = at(Mx, My) + 1;
  // Per piece, its orientations as offsets from their first cell (reading order).
  const shapeIds = pieces.map((p) => sig(normalize(orientations(p)[0]!)));
  const orients = pieces.map((p) =>
    orientations(p).map((or) => {
      const a = or[0]!;
      return { or, offs: or.map(([x, y]) => (y - a[1]) * W + (x - a[0])), ax: a[0], ay: a[1] };
    }),
  );
  const used = pieces.map(() => false);
  const chosen: { i: number; idx: number; or: number }[] = [];
  let count = 0;
  let first: Map<number, Cell[]> | null = null;
  let complete = true;
  let left = free.length;
  const rec = (from: number): void => {
    if (--steps < 0) {
      complete = false;
      return;
    }
    let idx = from;
    while (idx < end && grid[idx] === 1) idx++;
    if (left === 0 || idx >= end) {
      count++;
      if (!first) {
        first = new Map();
        for (const c of chosen) {
          const cx = (c.idx % W) + mx - 5;
          const cy = Math.floor(c.idx / W) + my - 5;
          const o = orients[c.i]![c.or]!;
          const a = o.or[0]!;
          first.set(c.i, o.or.map(([x, y]) => [x - a[0] + cx, y - a[1] + cy] as Cell));
        }
      }
      return;
    }
    const tried = new Set<string>();
    for (let i = 0; i < pieces.length; i++) {
      if (used[i] || tried.has(shapeIds[i]!)) continue;
      tried.add(shapeIds[i]!);
      const list = orients[i]!;
      for (let k = 0; k < list.length; k++) {
        const offs = list[k]!.offs;
        let fits = true;
        for (let m = 0; m < offs.length; m++) {
          const c = idx + offs[m]!;
          if (c < 0 || c >= grid.length || grid[c] === 1) {
            fits = false;
            break;
          }
        }
        if (!fits) continue;
        for (let m = 0; m < offs.length; m++) grid[idx + offs[m]!] = 1;
        used[i] = true;
        left -= offs.length;
        chosen.push({ i, idx, or: k });
        rec(idx + 1);
        chosen.pop();
        left += offs.length;
        used[i] = false;
        for (let m = 0; m < offs.length; m++) grid[idx + offs[m]!] = 0;
        if (count >= limit || steps < 0) return;
      }
    }
  };
  rec(0);
  return { count, complete: complete || count >= limit, first };
}

/** What a check says: the pieces in hand cannot fill the free cells (`stuck`), they can (`open`), or the search ran out (`unsure`). */
export type Verdict = "stuck" | "open" | "unsure";

/** Whether `pieces` can still fill exactly the cells `free` (each at most once, some may stay unused). */
export function verdict(free: readonly Cell[], pieces: readonly (readonly Cell[])[], budget = CHECK_BUDGET): Verdict {
  const c = countFillings(free, pieces, { limit: 1, budget });
  return c.count > 0 ? "open" : c.complete ? "stuck" : "unsure";
}

/** Every place a shape fits within `free` cells (absolute cells per placement). */
export function placements(free: readonly Cell[], shape: readonly Cell[]): Cell[][] {
  const set = new Set(free.map(([x, y]) => key(x, y)));
  const out: Cell[][] = [];
  for (const or of orientations(shape)) {
    const a = or[0]!;
    for (const [cx, cy] of free) {
      const dx = cx - a[0];
      const dy = cy - a[1];
      if (or.every(([x, y]) => set.has(key(x + dx, y + dy)))) out.push(or.map(([x, y]) => [x + dx, y + dy] as Cell));
    }
  }
  return out;
}

/** Whether a shape fits anywhere in `free`. */
export function fitsAnywhere(free: readonly Cell[], shape: readonly Cell[]): boolean {
  const set = new Set(free.map(([x, y]) => key(x, y)));
  for (const or of orientations(shape)) {
    const a = or[0]!;
    for (const [cx, cy] of free) {
      const dx = cx - a[0];
      const dy = cy - a[1];
      if (or.every(([x, y]) => set.has(key(x + dx, y + dy)))) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// The generator

/** How many needed pieces each player gets. */
export function piecesEach(players: number): number {
  return players <= 3 ? 3 : 2;
}

/** The kinds of `n` pieces of a mix. */
export function drawKinds(m: Mix, n: number, rng: () => number): Kind[] {
  const big = Math.round(n * m.share);
  return shuffle([...Array.from({ length: big }, () => pick(m.big, rng)), ...Array.from({ length: n - big }, () => pick(m.small, rng))], rng);
}

/** The box a board of `cells` grows in: about 1.3 × its cells, 4:3 to 2:1. */
export function boxFor(cells: number, rng: () => number): { w: number; h: number } {
  const area = cells * 1.3;
  const aspect = 1.35 + rng() * 0.5;
  const w = Math.max(3, Math.round(Math.sqrt(area * aspect)));
  const h = Math.max(3, Math.ceil(area / w));
  return { w, h };
}

/**
 * Grows a shape out of pieces of `kinds` inside a `w × h` box: each piece
 * in an orientation and place touching what is there, the ones touching
 * it most the likeliest. Null when a piece finds no place.
 */
export function grow(kinds: readonly Kind[], box: { w: number; h: number }, rng: () => number): { kind: Kind; cells: Cell[] }[] | null {
  const occ = new Set<number>();
  const out: { kind: Kind; cells: Cell[] }[] = [];
  for (const kind of kinds) {
    const ors = orientations(PIECES[kind]);
    if (out.length === 0) {
      const or = pick(ors, rng);
      const ow = Math.max(...or.map(([x]) => x)) + 1;
      const oh = Math.max(...or.map(([, y]) => y)) + 1;
      if (ow > box.w || oh > box.h) return null;
      const dx = Math.floor((box.w - ow) / 2 + (rng() - 0.5) * 2);
      const dy = Math.floor((box.h - oh) / 2 + (rng() - 0.5) * 2);
      const cells = or.map(([x, y]) => [Math.max(0, Math.min(box.w - ow, dx)) + x, Math.max(0, Math.min(box.h - oh, dy)) + y] as Cell);
      for (const [x, y] of cells) occ.add(key(x, y));
      out.push({ kind, cells });
      continue;
    }
    // Every placement inside the box, free, touching: weighted by contact squared.
    const cands: { cells: Cell[]; w: number }[] = [];
    const seen = new Set<string>();
    for (const or of ors) {
      const ow = Math.max(...or.map(([x]) => x)) + 1;
      const oh = Math.max(...or.map(([, y]) => y)) + 1;
      for (let dy = 0; dy + oh <= box.h; dy++) {
        for (let dx = 0; dx + ow <= box.w; dx++) {
          let ok = true;
          let contact = 0;
          for (const [x, y] of or) {
            const ax = x + dx;
            const ay = y + dy;
            if (occ.has(key(ax, ay))) {
              ok = false;
              break;
            }
            for (const [nx, ny] of [[ax + 1, ay], [ax - 1, ay], [ax, ay + 1], [ax, ay - 1]] as const) if (occ.has(key(nx, ny))) contact++;
          }
          if (!ok || contact === 0) continue;
          const cells = or.map(([x, y]) => [x + dx, y + dy] as Cell);
          const s = sig(normalize(cells)) + `@${dx},${dy}`;
          if (seen.has(s)) continue;
          seen.add(s);
          cands.push({ cells, w: contact * contact });
        }
      }
    }
    // The likeliest by weight; one that would close a hole is dropped and another drawn.
    const placed = [...occ].map((k) => [k % 1024, (k - (k % 1024)) / 1024] as Cell);
    let chosen: { cells: Cell[]; w: number } | null = null;
    while (cands.length > 0 && !chosen) {
      let r = rng() * cands.reduce((a, c) => a + c.w, 0);
      let at = cands.length - 1;
      for (let i = 0; i < cands.length; i++) {
        r -= cands[i]!.w;
        if (r <= 0) {
          at = i;
          break;
        }
      }
      const c = cands[at]!;
      if (holes([...placed, ...c.cells]) === 0) chosen = c;
      else cands.splice(at, 1);
    }
    if (!chosen) return null;
    for (const [x, y] of chosen.cells) occ.add(key(x, y));
    out.push({ kind, cells: chosen.cells });
  }
  return out;
}

/** A generated board: its shape, its solution (the needed pieces where the generator put them) and the spares' kinds. */
export interface Board {
  shape: Shape;
  solution: { kind: Kind; cells: Cell[] }[];
  spares: Kind[];
  /** Ways to fill it with every dealt piece (a lower bound when `complete` is false). */
  ways: number;
  complete: boolean;
  /** The share of first placements that leave it unsolvable, estimated ({@link deadShare}). */
  dead: number;
}

export interface GenerateOptions {
  players: number;
  /** The rung of {@link LADDER} ({@link rungOf}). */
  rung: number;
  rng: () => number;
  /** Boards to make and choose from (default 24, fewer for big boards). */
  tries?: number;
  /** Solver steps per count. */
  budget?: number;
}

/** How many boards to make and choose from, and the solver's steps for each: fewer for big boards. */
export function effort(players: number): { tries: number; budget: number } {
  const needed = piecesEach(players) * Math.max(1, players);
  return needed <= 6 ? { tries: 24, budget: 40_000 } : needed <= 9 ? { tries: 12, budget: 20_000 } : { tries: 8, budget: 10_000 };
}

/** The samples and the solver steps per sample of {@link deadShare}. */
export const DEAD_SAMPLES = 32;
export const DEAD_BUDGET = 3000;

/**
 * Estimates how much of a board is a trap: of `samples` first placements
 * (a random piece of all dealt ones, at a random place it fits), the share
 * after which the other pieces cannot fill the rest. A sample whose
 * search runs out of `budget` steps counts as dead (a hard place to
 * start). This, not the number of ways, is what a team feels (§8), and it
 * compares across board sizes, where counting ways runs out.
 */
export function deadShare(shape: Shape, pieces: readonly (readonly Cell[])[], rng: () => number, samples = DEAD_SAMPLES, budget = DEAD_BUDGET): number {
  const free = shapeCells(shape);
  const all: { i: number; cells: Cell[] }[] = [];
  pieces.forEach((p, i) => {
    for (const cells of placements(free, p)) all.push({ i, cells });
  });
  if (all.length === 0 || samples <= 0) return 1;
  let dead = 0;
  for (let s = 0; s < samples; s++) {
    const { i, cells } = all[Math.floor(rng() * all.length)]!;
    const taken = new Set(cells.map(([x, y]) => key(x, y)));
    const left = free.filter(([x, y]) => !taken.has(key(x, y)));
    const c = countFillings(left, pieces.filter((_, j) => j !== i), { limit: 1, budget });
    if (c.count === 0) dead++;
  }
  return dead / samples;
}

/**
 * One try: a shape grown out of the rung's pieces for `players`, without
 * holes and filling 70 % of its box or more, with spares, its count of
 * fillings and its share of dead first placements. Null when the try
 * failed (grow again).
 */
export function candidate(o: GenerateOptions): Board | null {
  const mix = LADDER[Math.max(0, Math.min(LADDER.length - 1, o.rung))]!.mix;
  const needed = piecesEach(o.players) * Math.max(1, o.players);
  const kinds = drawKinds(mix, needed, o.rng);
  const cells = kinds.reduce((a, k) => a + PIECES[k].length, 0);
  const grown = grow(kinds, boxFor(cells, o.rng), o.rng);
  if (!grown) return null;
  const all = grown.flatMap((p) => p.cells);
  if (holes(all) > 0) return null;
  let mx = Infinity;
  let my = Infinity;
  for (const [x, y] of all) {
    mx = Math.min(mx, x);
    my = Math.min(my, y);
  }
  // The shape and its solution, moved to the top left.
  const solution = grown.map((p) => ({ kind: p.kind, cells: p.cells.map(([x, y]) => [x - mx, y - my] as Cell) }));
  const shape = shapeOf(solution.flatMap((p) => p.cells));
  if (all.length / (shape.w * shape.h) < 0.7) return null;
  const spares = drawKinds(mix, Math.max(1, o.players), o.rng);
  const pieces = [...solution.map((p) => PIECES[p.kind]), ...spares.map((k) => PIECES[k])];
  const c = countFillings(shapeCells(shape), pieces, { limit: 50, budget: o.budget ?? effort(o.players).budget });
  const dead = deadShare(shape, pieces, o.rng);
  return { shape, solution, spares, ways: Math.max(1, c.count), complete: c.complete, dead };
}

/**
 * The board a rung keeps of several: sorted from the most forgiving (the
 * fewest dead first placements, then the most ways; a count that ran out
 * is "many") to the least, the one at the rung's rank.
 */
export function choose(boards: readonly Board[], rung: number): Board {
  if (boards.length === 0) throw new Error("snug: no board grew");
  const ways = (b: Board) => (b.complete ? b.ways : 1000 + b.ways);
  const sorted = [...boards].sort((a, b) => a.dead - b.dead || ways(b) - ways(a));
  const rank = LADDER[Math.max(0, Math.min(LADDER.length - 1, rung))]!.rank;
  return sorted[Math.round(rank * (sorted.length - 1))]!;
}

/** One board for `players` on a rung, at once (`game.ts` makes its boards a try at a time). */
export function generate(o: GenerateOptions): Board {
  const tries = o.tries ?? effort(o.players).tries;
  const boards: Board[] = [];
  for (let attempt = 0; boards.length < tries && attempt < tries * 40; attempt++) {
    const b = candidate(o);
    if (b) boards.push(b);
  }
  return choose(boards, o.rung);
}

// ---------------------------------------------------------------------------
// The deal

/** A piece in a game: its id (shuffled, says nothing), its shape as dealt, and where the solution has it (spares: null). */
export interface Piece {
  id: string;
  kind: Kind;
  cells: Cell[];
  home: Cell[] | null;
}

/**
 * Deals a board's pieces: every player the same number of needed pieces,
 * the cells as even as it goes (largest first, to whoever has the fewest
 * cells), then one spare each; each piece in a random orientation, ids
 * shuffled. Returns the hands in the players' order.
 */
export function deal(board: Board, players: readonly string[], prefix: string, rng: () => number): Map<string, Piece[]> {
  const hands = new Map<string, Piece[]>(players.map((id) => [id, []]));
  const cells = new Map<string, number>(players.map((id) => [id, 0]));
  const counts = new Map<string, number>(players.map((id) => [id, 0]));
  const each = Math.ceil(board.solution.length / Math.max(1, players.length));
  const needed = shuffle(board.solution, rng).sort((a, b) => b.cells.length - a.cells.length);
  const n = board.solution.length + board.spares.length;
  const ids = shuffle(
    Array.from({ length: n }, (_, i) => `${prefix}${i.toString(36)}`),
    rng,
  );
  const give = (id: string, kind: Kind, home: Cell[] | null) => {
    const ors = orientations(PIECES[kind]);
    hands.get(id)!.push({ id: ids.pop()!, kind, cells: pick(ors, rng), home });
  };
  for (const p of needed) {
    const open = shuffle(players, rng).filter((id) => counts.get(id)! < each);
    const to = open.sort((a, b) => cells.get(a)! - cells.get(b)!)[0] ?? players[0]!;
    give(to, p.kind, p.cells);
    cells.set(to, cells.get(to)! + p.cells.length);
    counts.set(to, counts.get(to)! + 1);
  }
  board.spares.forEach((k, i) => give(players[i % players.length]!, k, null));
  for (const [id, hand] of hands) hands.set(id, shuffle(hand, rng));
  return hands;
}

// ---------------------------------------------------------------------------
// Placing

export type Refusal = "shape" | "outside" | "taken";

/**
 * Checks a placement of a piece of shape `base` on the board: `cells` must
 * be the shape turned or flipped, all on the board and free (`occupied`:
 * cell key → the id of the piece on it; the piece itself does not count,
 * so it can move onto cells it covers). Returns the refusal and, for
 * `taken`, the piece in the way.
 */
export function checkPlacement(
  shape: Shape,
  occupied: ReadonlyMap<number, string>,
  piece: string,
  base: readonly Cell[],
  cells: readonly Cell[],
): { ok: true } | { ok: false; reason: Refusal; by?: string } {
  if (!sameShape(base, cells) || !connected(cells)) return { ok: false, reason: "shape" };
  for (const [x, y] of cells) {
    if (y < 0 || y >= shape.h || x < 0 || x >= shape.w || shape.rows[y]![x] !== "#") return { ok: false, reason: "outside" };
  }
  for (const [x, y] of cells) {
    const by = occupied.get(key(x, y));
    if (by !== undefined && by !== piece) return { ok: false, reason: "taken", by };
  }
  return { ok: true };
}

/** Reads cells from untrusted data: a list of 1–5 `[x, y]` integer pairs, else null. */
export function readCells(d: unknown): Cell[] | null {
  if (!Array.isArray(d) || d.length < 1 || d.length > 5) return null;
  const out: Cell[] = [];
  for (const c of d) {
    if (!Array.isArray(c) || c.length !== 2) return null;
    const [x, y] = c as unknown[];
    if (!Number.isInteger(x) || !Number.isInteger(y) || (x as number) < 0 || (y as number) < 0 || (x as number) > 64 || (y as number) > 64) return null;
    out.push([x as number, y as number]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The clock

/** The clock at the start, ms: 60 s + 15 s per needed piece, by the pace. */
export function startTime(needed: number, pace: Pace): number {
  return Math.round((60 + 15 * needed) * PACE_FACTOR[pace]) * 1000;
}

/** The time a solved board gives back, ms: 10 s + 6 s per needed piece, by the pace. */
export function bonusTime(needed: number, pace: Pace): number {
  return Math.round((10 + 6 * needed) * PACE_FACTOR[pace]) * 1000;
}

/** Hard's cost of lifting or moving a piece, ms. */
export const LIFT_COST = 3000;

export function pickLang(tag: unknown): Lang {
  return typeof tag === "string" && /^de\b/i.test(tag) ? "de" : "en";
}
