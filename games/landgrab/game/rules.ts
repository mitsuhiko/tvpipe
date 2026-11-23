/**
 * Landgrab's rules, without the party (docs/landgrab-design.md): the
 * deal, reinforcements, plans and their checks, the dice, and a round's
 * resolution into the events the TV plays out. Pure functions of the
 * world, the board and a random source, so the host, the phones (which
 * check a plan before they send it) and the tests share them.
 */

import type { World } from "./world.ts";

export type { Lang } from "./world.ts";
export const LANGS = ["en", "de"] as const;

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 6;
/** The fewest armies a player gets in a round. */
export const MIN_REINFORCE = 3;
/** Stars a player cashes in at once, and what they bring. */
export const STARS_TO_CASH = 3;
export const CASH_ARMIES = 5;
export const MAX_STARS = 5;
/** Orders a plan may have. */
export const MAX_ORDERS = 16;
/** A rebel's (or a latecomer's) uprising: the armies it starts with. */
export const UPRISING_ARMIES = 3;
/** The share of the world that wins the game at once. */
export const DOMINATION = 0.75;

/**
 * The board: per territory (by index), who holds it (a player's id, `""`
 * for the wild lands nobody holds) and how many armies are on it.
 */
export interface Board {
  own: string[];
  arm: number[];
}

export interface Order {
  from: string;
  to: string;
  n: number;
}

/** What a player sends in the planning phase (all of it, every time). */
export interface Plan {
  /** Reinforcements by territory id. */
  place: Record<string, number>;
  orders: Order[];
  /** Stars cashed in for {@link CASH_ARMIES} more armies. */
  cash: boolean;
  ready: boolean;
}

export const EMPTY_PLAN: Plan = { place: {}, orders: [], cash: false, ready: false };

/** A plan the rules refuse: `code` for the phone's message. */
export class PlanError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Randomness

/** A small seeded random source (mulberry32) for tests and replays. */
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

export function die(rng: () => number): number {
  return 1 + Math.min(5, Math.floor(rng() * 6));
}

// ---------------------------------------------------------------------------
// The deal

/** Territories each player starts with, for `n` players. */
export function startTerritories(n: number, total: number): number {
  return Math.max(4, Math.min(10, Math.round((total * 0.55) / Math.max(1, n))));
}

/**
 * The opening board: each player gets {@link startTerritories} at random
 * (2 armies each, never a whole continent), the rest are wild lands with
 * 1–3 armies.
 */
export function deal(world: World, ids: readonly string[], rng: () => number): Board {
  const total = world.territories.length;
  const k = Math.min(startTerritories(ids.length, total), Math.floor(total / Math.max(1, ids.length)));
  let own: string[] = [];
  for (let attempt = 0; attempt < 50; attempt++) {
    const order = shuffle(
      world.territories.map((t) => t.index),
      rng,
    );
    own = world.territories.map(() => "");
    order.slice(0, k * ids.length).forEach((t, i) => (own[t] = ids[i % ids.length]!));
    const whole = world.continents.some((c) => {
      const first = own[world.byId.get(c.territories[0]!)!.index];
      return !!first && c.territories.every((id) => own[world.byId.get(id)!.index] === first);
    });
    if (!whole) break;
  }
  const arm = own.map((o) => (o ? 2 : 1 + Math.floor(rng() * 3)));
  return { own, arm };
}

// ---------------------------------------------------------------------------
// Counting

export function territoriesOf(board: Board, id: string): number[] {
  const out: number[] = [];
  board.own.forEach((o, i) => o === id && out.push(i));
  return out;
}

export function armiesOf(board: Board, id: string): number {
  let n = 0;
  board.own.forEach((o, i) => o === id && (n += board.arm[i]!));
  return n;
}

/** The continents a player holds whole. */
export function continentsOf(world: World, board: Board, id: string): string[] {
  return world.continents.filter((c) => c.territories.every((t) => board.own[world.byId.get(t)!.index] === id)).map((c) => c.id);
}

export interface Reinforcements {
  /** From the territories: a third of them, at least {@link MIN_REINFORCE}. */
  base: number;
  /** Continent bonuses: `[continent id, bonus]`. */
  bonus: [string, number][];
  total: number;
}

/** The armies a player gets at the start of a round (before stars). */
export function reinforcements(world: World, board: Board, id: string): Reinforcements {
  const base = Math.max(MIN_REINFORCE, Math.floor(territoriesOf(board, id).length / 3));
  const bonus = continentsOf(world, board, id).map((c) => [c, world.continents.find((x) => x.id === c)!.bonus] as [string, number]);
  return { base, bonus, total: base + bonus.reduce((s, [, b]) => s + b, 0) };
}

/** A player's standing: territories, then armies. */
export function standing(board: Board, ids: readonly string[]): { id: string; lands: number; armies: number }[] {
  return ids.map((id) => ({ id, lands: territoriesOf(board, id).length, armies: armiesOf(board, id) })).sort((a, b) => b.lands - a.lands || b.armies - a.armies);
}

/** Enemy (and wild) armies next to a territory: the pressure on it. */
export function threat(world: World, board: Board, t: number): number {
  const me = board.own[t];
  let n = 0;
  for (const nb of world.territories[t]!.neighbors) {
    const i = world.byId.get(nb)!.index;
    if (board.own[i] !== me && board.own[i]) n += board.arm[i]!;
  }
  return n;
}

/** Whether a territory borders one that is not the holder's. */
export function frontier(world: World, board: Board, t: number): boolean {
  const me = board.own[t];
  return world.territories[t]!.neighbors.some((nb) => board.own[world.byId.get(nb)!.index] !== me);
}

/**
 * Where reinforcements go when nobody placed them (away players, the
 * rest of a plan): one by one to the border territory under the most
 * pressure for its armies; inland only when there is no border.
 */
export function autoPlace(world: World, board: Board, id: string, count: number): Record<string, number> {
  const mine = territoriesOf(board, id);
  const out: Record<string, number> = {};
  if (mine.length === 0 || count <= 0) return out;
  const front = mine.filter((t) => frontier(world, board, t));
  const pool = front.length ? front : mine;
  const extra = new Map<number, number>();
  for (let i = 0; i < count; i++) {
    let best = pool[0]!;
    let score = -Infinity;
    for (const t of pool) {
      const have = board.arm[t]! + (extra.get(t) ?? 0);
      const s = (threat(world, board, t) + 1) / have;
      if (s > score) (score = s), (best = t);
    }
    extra.set(best, (extra.get(best) ?? 0) + 1);
  }
  for (const [t, n] of extra) out[world.territories[t]!.id] = n;
  return out;
}

// ---------------------------------------------------------------------------
// Plans

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isCount = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x) && x >= 0 && x <= 10_000;

/**
 * Checks a plan from a phone against the board: reinforcements on one's
 * own territories and no more than there are (`armies`, plus
 * {@link CASH_ARMIES} when `stars` allow cashing in), orders from one's
 * own territories to neighbours, never moving the last army out of a
 * territory, taken in the plan's order (armies moved in earlier may
 * march on: the battle keeps each player's order). Returns it cleaned up (zero placements dropped, the same
 * route twice merged); throws {@link PlanError}.
 */
export function checkPlan(world: World, board: Board, id: string, armies: number, stars: number, raw: unknown): Plan {
  if (!isRecord(raw)) throw new PlanError("bad-plan", "A plan is { place, orders, cash, ready }");
  const cash = raw["cash"] === true;
  if (cash && stars < STARS_TO_CASH) throw new PlanError("no-stars", `Cashing in takes ${STARS_TO_CASH} stars`);
  const budget = armies + (cash ? CASH_ARMIES : 0);
  const place: Record<string, number> = {};
  let placed = 0;
  const rawPlace = raw["place"] ?? {};
  if (!isRecord(rawPlace)) throw new PlanError("bad-plan", "place: { territory: armies }");
  for (const [t, n] of Object.entries(rawPlace)) {
    const terr = world.byId.get(t);
    if (!terr || board.own[terr.index] !== id) throw new PlanError("not-yours", `${t} is not yours`);
    if (!isCount(n)) throw new PlanError("bad-plan", `place.${t}: a number of armies`);
    if (n === 0) continue;
    place[t] = n;
    placed += n;
  }
  if (placed > budget) throw new PlanError("too-many", `Only ${budget} armies to place`);
  const rawOrders = raw["orders"] ?? [];
  if (!Array.isArray(rawOrders)) throw new PlanError("bad-plan", "orders: a list");
  if (rawOrders.length > MAX_ORDERS) throw new PlanError("too-many-orders", `At most ${MAX_ORDERS} orders`);
  const orders: Order[] = [];
  for (const o of rawOrders) {
    if (!isRecord(o) || typeof o["from"] !== "string" || typeof o["to"] !== "string" || !isCount(o["n"]) || o["n"] < 1) throw new PlanError("bad-plan", "An order is { from, to, n }");
    const from = world.byId.get(o["from"]);
    const to = world.byId.get(o["to"]);
    if (!from || board.own[from.index] !== id) throw new PlanError("not-yours", `${o["from"]} is not yours`);
    if (!to || !from.neighbors.includes(to.id)) throw new PlanError("not-neighbor", `${o["to"]} is not next to ${from.id}`);
    const same = orders.find((x) => x.from === from.id && x.to === to.id);
    if (same) same.n += o["n"];
    else orders.push({ from: from.id, to: to.id, n: o["n"] });
  }
  // In the plan's order, as the battle takes it: armies moved into one's
  // own territory may march on from there in a later order.
  const along = planArmies(world, board, place);
  for (const o of orders) {
    const have = along.get(o.from) ?? 0;
    if (o.n > have - 1) throw new PlanError("too-few-armies", `${o.from} has ${have} armies then: one stays`);
    along.set(o.from, have - o.n);
    if (board.own[world.byId.get(o.to)!.index] === id) along.set(o.to, (along.get(o.to) ?? 0) + o.n);
  }
  return { place, orders, cash, ready: raw["ready"] === true };
}

/** Armies per territory once a plan's reinforcements are there (before its orders). */
export function planArmies(world: World, board: Board, place: Readonly<Record<string, number>>): Map<string, number> {
  return new Map(world.territories.map((t) => [t.id, (board.arm[t.index] ?? 0) + (place[t.id] ?? 0)]));
}

/**
 * Armies per territory after each of a player's orders, in the plan's
 * order, as if every move arrives (attacks take their armies away;
 * what they win is not counted). `after[k]` is the board after order
 * `k`; `after[-1]` would be {@link planArmies}.
 */
export function armiesAlong(world: World, board: Board, id: string, place: Readonly<Record<string, number>>, orders: readonly Order[]): Map<string, number>[] {
  const armies = planArmies(world, board, place);
  return orders.map((o) => {
    armies.set(o.from, (armies.get(o.from) ?? 0) - o.n);
    const to = world.byId.get(o.to);
    if (to && board.own[to.index] === id) armies.set(o.to, (armies.get(o.to) ?? 0) + o.n);
    return new Map(armies);
  });
}

/** How many of a plan's reinforcements are placed. */
export function placedOf(plan: Plan): number {
  return Object.values(plan.place).reduce((s, n) => s + n, 0);
}

// ---------------------------------------------------------------------------
// Battles

/** One throw: the attacker's dice and the defender's, each sorted high to low. */
export type Roll = [number[], number[]];

/** Who lost how many in a throw: `[attacker, defender]`; a tie goes to the defender (or, head-on, costs both). */
export function losses(roll: Roll, headOn = false): [number, number] {
  const [a, d] = roll;
  let la = 0;
  let ld = 0;
  const pairs = Math.min(a.length, d.length, 2);
  for (let i = 0; i < pairs; i++) {
    if (a[i]! > d[i]!) ld++;
    else if (a[i]! < d[i]!) la++;
    else if (headOn) la++, ld++;
    else la++;
  }
  return [la, ld];
}

function throwDice(n: number, rng: () => number): number[] {
  return Array.from({ length: n }, () => die(rng)).sort((x, y) => y - x);
}

/**
 * A fight to the end: the attacker throws up to three dice, the defender
 * up to two (head-on, both up to three), until one side has nobody left.
 * Returns every throw and who is left.
 */
export function fight(att: number, def: number, rng: () => number, headOn = false): { rolls: Roll[]; att: number; def: number } {
  const rolls: Roll[] = [];
  while (att > 0 && def > 0) {
    const roll: Roll = [throwDice(Math.min(3, att), rng), throwDice(Math.min(headOn ? 3 : 2, def), rng)];
    const [la, ld] = losses(roll, headOn);
    att = Math.max(0, att - la);
    def = Math.max(0, def - ld);
    rolls.push(roll);
  }
  return { rolls, att, def };
}

// ---------------------------------------------------------------------------
// Resolution

/** A territory after an event: `[index, holder, armies]`. */
export type Change = [number, string, number];

export interface Attack {
  /** The attacker, the territories (indices), the armies sent. */
  p: string;
  from: number;
  to: number;
  n: number;
  /** Who held the target (`""`: the wild lands) and with how many. */
  foe: string;
  def: number;
  rolls: Roll[];
  /** The attackers left; when the target fell they hold it. */
  left: number;
  won: boolean;
}

/**
 * What happened, for the TV to play and the phones to tell. Every event
 * has `was` and `set`: the territories it touches before and after it.
 */
export type Event = (
  /** Every player's reinforcements at once (and cashed stars). */
  | { type: "place"; add: [number, string, number][] }
  | { type: "move"; p: string; from: number; to: number; n: number }
  | ({ type: "attack"; out?: string; continent?: string } & Attack)
  /**
   * Two armies marching against each other meet halfway: `p` from `a`
   * with `na`, `q` from `b` with `nb`; the side left standing marches on
   * into the other's territory (`then`).
   */
  | { type: "clash"; p: string; q: string; a: number; b: number; na: number; nb: number; rolls: Roll[]; leftA: number; leftB: number; then: Attack | null; out?: string; continent?: string }
  /** An order that could not be carried out: its territory fell (or kept a single army). */
  | { type: "cancel"; p: string; from: number; to: number }
) & { was: Change[]; set: Change[] };

interface Pending {
  p: string;
  order: Order;
  done: boolean;
}

/**
 * Plays a round's plans out on `board` (changed in place) and returns
 * what happened, in order. First every reinforcement lands; then the
 * orders go one at a time, a round robin over the players in `turn`
 * order (each player's in their own order). An order moves or attacks
 * with what it asked for, or what is there less the one army that
 * stays; one whose territory was taken meanwhile is cancelled. Two
 * orders against each other (A to B and B to A) meet halfway (a clash).
 * Also returns who took at least one territory (for the stars).
 */
export function resolve(world: World, board: Board, plans: ReadonlyMap<string, Plan>, turn: readonly string[], rng: () => number): { events: Event[]; captured: Set<string> } {
  const events: Event[] = [];
  const captured = new Set<string>();
  const idx = (id: string) => world.byId.get(id)!.index;

  // Reinforcements.
  const add: [number, string, number][] = [];
  for (const p of turn) {
    const plan = plans.get(p);
    if (!plan) continue;
    for (const [t, n] of Object.entries(plan.place)) {
      const i = idx(t);
      if (board.own[i] !== p || n <= 0) continue;
      board.arm[i]! += n;
      add.push([i, p, n]);
    }
  }
  if (add.length) {
    const touched = [...new Set(add.map(([i]) => i))];
    const extra = new Map<number, number>();
    for (const [i, , n] of add) extra.set(i, (extra.get(i) ?? 0) + n);
    events.push({ type: "place", add, was: touched.map((i) => [i, board.own[i]!, board.arm[i]! - extra.get(i)!]), set: touched.map((i) => [i, board.own[i]!, board.arm[i]!]) });
  }

  // The orders, round robin.
  const queues = turn.map((p) => (plans.get(p)?.orders ?? []).map((order) => ({ p, order, done: false }) as Pending));
  const all = queues.flat();
  const longest = Math.max(0, ...queues.map((q) => q.length));
  const owners = (): Map<string, string[]> => {
    const m = new Map<string, string[]>();
    for (const c of world.continents) m.set(c.id, c.territories.map((t) => board.own[idx(t)]!));
    return m;
  };
  const conquest = (p: string, before: Map<string, string[]>): string | undefined => {
    for (const c of world.continents) {
      const now = c.territories.every((t) => board.own[idx(t)] === p);
      const was = before.get(c.id)!.every((o) => o === p);
      if (now && !was) return c.id;
    }
    return undefined;
  };
  const attack = (p: string, from: number, to: number, n: number): Attack => {
    const foe = board.own[to]!;
    const def = board.arm[to]!;
    const f = fight(n, def, rng);
    const won = f.def === 0 && f.att > 0;
    if (won) {
      board.own[to] = p;
      board.arm[to] = f.att;
      captured.add(p);
    } else {
      board.arm[to] = f.def;
    }
    return { p, from, to, n, foe, def, rolls: f.rolls, left: f.att, won };
  };
  const finish = (ev: Event & { type: "attack" | "clash" }, foe: string, before: Map<string, string[]>, winner: string) => {
    if (foe && !board.own.includes(foe)) ev.out = foe;
    const c = conquest(winner, before);
    if (c) ev.continent = c;
  };
  for (let k = 0; k < longest; k++) {
    for (const q of queues) {
      const item = q[k];
      if (!item || item.done) continue;
      item.done = true;
      const { p, order } = item;
      const from = idx(order.from);
      const to = idx(order.to);
      const n = Math.min(order.n, board.arm[from]! - 1);
      if (board.own[from] !== p || n <= 0) {
        events.push({ type: "cancel", p, from, to, was: [], set: [] });
        continue;
      }
      const was: Change[] = [
        [from, board.own[from]!, board.arm[from]!],
        [to, board.own[to]!, board.arm[to]!],
      ];
      if (board.own[to] === p) {
        board.arm[from]! -= n;
        board.arm[to]! += n;
        events.push({ type: "move", p, from, to, n, was, set: [[from, p, board.arm[from]!], [to, p, board.arm[to]!]] });
        continue;
      }
      const before = owners();
      const foe = board.own[to]!;
      // Head-on: the foe marches against this territory too, and has not gone yet.
      const other = foe ? all.find((x) => !x.done && x.p === foe && x.order.from === order.to && x.order.to === order.from) : undefined;
      const nb = other ? Math.min(other.order.n, board.arm[to]! - 1) : 0;
      if (other && nb > 0) {
        other.done = true;
        board.arm[from]! -= n;
        board.arm[to]! -= nb;
        const f = fight(n, nb, rng, true);
        let then: Attack | null = null;
        let winner = "";
        if (f.att > 0) {
          then = attack(p, from, to, f.att);
          winner = p;
        } else if (f.def > 0) {
          then = attack(foe, to, from, f.def);
          winner = foe;
        }
        const ev: Event = { type: "clash", p, q: foe, a: from, b: to, na: n, nb, rolls: f.rolls, leftA: f.att, leftB: f.def, then, was, set: [[from, board.own[from]!, board.arm[from]!], [to, board.own[to]!, board.arm[to]!]] };
        if (then && winner) finish(ev, winner === p ? foe : p, before, winner);
        events.push(ev);
        continue;
      }
      board.arm[from]! -= n;
      const a = attack(p, from, to, n);
      const ev: Event = { type: "attack", ...a, was, set: [[from, p, board.arm[from]!], [to, board.own[to]!, board.arm[to]!]] };
      if (a.won) finish(ev, foe, before, p);
      events.push(ev);
    }
  }
  return { events, captured };
}

/**
 * Where a rebel (a player who was wiped out) or a latecomer rises: the
 * leader's territory with the fewest armies (never their last one), else
 * the weakest wild land. Returns its index, or -1 when there is none.
 */
export function uprisingAt(world: World, board: Board, ids: readonly string[], rng: () => number): number {
  const table = standing(board, ids).filter((s) => s.lands > 1);
  const pick = (cands: number[]) => {
    if (cands.length === 0) return -1;
    const low = Math.min(...cands.map((t) => board.arm[t]!));
    const weakest = cands.filter((t) => board.arm[t] === low);
    return weakest[Math.floor(rng() * weakest.length)]!;
  };
  if (table.length) return pick(territoriesOf(board, table[0]!.id));
  return pick(territoriesOf(board, ""));
}

/** Who holds at least {@link DOMINATION} of the world, if anyone. */
export function dominator(board: Board): string | undefined {
  const counts = new Map<string, number>();
  for (const o of board.own) if (o) counts.set(o, (counts.get(o) ?? 0) + 1);
  for (const [id, n] of counts) if (n >= Math.ceil(board.own.length * DOMINATION)) return id;
  return undefined;
}
