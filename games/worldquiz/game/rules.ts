/**
 * Worldquiz's rules without the party (docs/worldquiz-design.md): the
 * settings, the deck with its discard pile, the facts and their ranks,
 * comparing cards, picking challenges, and judging pins on the map.
 * Pure functions and small classes, tested in Node.
 */

import type { Country, Lang } from "./data.ts";
import { colourDistance, type FlagColours } from "./flagcolours.ts";
import { km } from "./geo.ts";

export type { Lang };

export const LANGS: readonly Lang[] = ["en", "de"];

/** A tag (`de-AT`, `en`, …) as one of {@link LANGS}. */
export function pickLang(tag: unknown): Lang {
  return typeof tag === "string" && /^de\b/i.test(tag) ? "de" : "en";
}

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 10;

/** Rounds the room can pick; the game rounds up to a multiple of the players (§2.4). */
export const ROUNDS = [15, 30, 45] as const;
export const DIFFICULTIES = ["easy", "normal", "hard"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];
export const MAPS = ["flat", "globe"] as const;
export type MapMode = (typeof MAPS)[number];
/** The game: cards (draw, the captain competes or calls a challenge) or only the challenges (§2.5). */
export const MODES = ["cards", "quiz"] as const;
export type Mode = (typeof MODES)[number];

/** The five numbers on a card, in the card's order. */
export const FACTS = ["population", "area", "neighbours", "highest", "gdp"] as const;
export type Fact = (typeof FACTS)[number];

/**
 * The kinds of challenge (§4): type the capital, name the flag's
 * country, pin it on the map, pick its flag among several, name the
 * shape, name the country shown among its neighbours, pick the biggest of four, guess a number, name a neighbour,
 * pick the one of four that is no neighbour.
 */
export const KINDS = ["capital", "flag", "where", "pickflag", "shape", "spot", "bigger", "guess", "neighbour", "odd"] as const;
export type Kind = (typeof KINDS)[number];
/** How a kind is answered: typed, a pin, one of the shown options, a number. */
export const ANSWERS: Record<Kind, "text" | "pin" | "choice" | "number"> = {
  capital: "text",
  flag: "text",
  where: "pin",
  pickflag: "choice",
  shape: "text",
  spot: "text",
  bigger: "choice",
  guess: "number",
  neighbour: "text",
  odd: "choice",
};

/** Which countries challenges ask about (§6): the best known 80, 150, or all. */
export const POOLS = ["famous", "known", "all"] as const;
export type Pool = (typeof POOLS)[number];
export const POOL_SIZE: Record<Pool, number> = { famous: 80, known: 150, all: Infinity };

/** What a difficulty changes (§6). */
export interface Level {
  /** Seconds to answer a challenge. */
  answer: number;
  /** A pin further than this (km) never wins. */
  maxKm: number;
  /** The phone's map draws borders (else only coastlines). */
  borders: boolean;
  /** Flags to pick from (§4.5). */
  flags: number;
  /** A guess off by more than this factor never wins (§4.8). */
  factor: number;
}

export const LEVELS: Record<Difficulty, Level> = {
  easy: { answer: 90, maxKm: 3000, borders: true, flags: 6, factor: 3 },
  normal: { answer: 60, maxKm: 1500, borders: true, flags: 6, factor: 2 },
  hard: { answer: 30, maxKm: 800, borders: false, flags: 9, factor: 1.5 },
};

/** A strong number: in the top this many of the deck. */
export const STRONG = 10;
/** Pins this close to the land count as on it (km). */
export const HIT_KM = 25;
/** Pins within this share of the best distance tie with it. */
export const TIE_SHARE = 0.1;
/** Challenges without a winner before a round gives up. */
export const MAX_TRIES = 3;

// ---------------------------------------------------------------------------
// Randomness

/** A small seeded generator (mulberry32), for tests and replays. */
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

export function shuffle<T>(items: readonly T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export function pick<T>(items: readonly T[], rng: () => number): T {
  if (items.length === 0) throw new Error("pick from nothing");
  return items[Math.floor(rng() * items.length)]!;
}

// ---------------------------------------------------------------------------
// The deck

/**
 * The deck and its discard pile: drawn cards are gone until every other
 * card has come up; then the pile is shuffled into a new deck.
 */
export class Deck<T> {
  readonly #rng: () => number;
  #deck: T[];
  #pile: T[] = [];
  /** How often the pile became the deck again. */
  reshuffles = 0;

  constructor(cards: readonly T[], rng: () => number) {
    if (cards.length === 0) throw new Error("an empty deck");
    this.#rng = rng;
    this.#deck = shuffle(cards, rng);
  }

  /** Cards left in the deck. */
  get left(): number {
    return this.#deck.length;
  }

  /** The discard pile, oldest first. */
  get pile(): readonly T[] {
    return this.#pile;
  }

  /**
   * The next card `ok` accepts. When the deck has none (or is empty), the
   * pile is shuffled in first; when no card at all is acceptable, any.
   * Drawn cards are out until {@link discard}ed.
   */
  draw(ok: (card: T) => boolean = () => true): T {
    let i = this.#deck.findIndex(ok);
    if (i < 0 && this.#pile.length > 0) {
      this.#refill();
      i = this.#deck.findIndex(ok);
    }
    if (i < 0) i = this.#deck.length - 1;
    if (i < 0) {
      this.#refill();
      i = this.#deck.length - 1;
    }
    if (i < 0) throw new Error("no card left anywhere");
    return this.#deck.splice(i, 1)[0]!;
  }

  /** Cards onto the discard pile. */
  discard(...cards: T[]): void {
    this.#pile.push(...cards);
  }

  #refill(): void {
    this.#deck.push(...shuffle(this.#pile, this.#rng));
    this.#pile = [];
    this.reshuffles++;
  }
}

// ---------------------------------------------------------------------------
// Facts and ranks

/** The countries in a game: everyone, or without the disputed ones. */
export function deckOf(all: readonly Country[], disputed: boolean): Country[] {
  return all.filter((c) => disputed || !c.disputed);
}

/** A country's neighbours that are in the deck. */
export function neighboursIn(c: Country, ids: ReadonlySet<string>): string[] {
  return c.neighbours.filter((n) => ids.has(n));
}

/** The number of a fact for a country, in a deck (neighbours count only the deck's). */
export function factOf(c: Country, fact: Fact, ids: ReadonlySet<string>): number {
  switch (fact) {
    case "population":
      return c.population;
    case "area":
      return c.area;
    case "neighbours":
      return neighboursIn(c, ids).length;
    case "highest":
      return c.highest.m;
    case "gdp":
      return c.gdp;
  }
}

export type Ranks = Record<Fact, number>;

/**
 * Every country's rank per fact in the deck: 1 for the highest; equal
 * numbers share a rank (1 + how many are higher).
 */
export function ranksOf(deck: readonly Country[]): Map<string, Ranks> {
  const ids = new Set(deck.map((c) => c.id));
  const out = new Map<string, Ranks>();
  const sorted = Object.fromEntries(FACTS.map((f) => [f, deck.map((c) => factOf(c, f, ids)).sort((a, b) => b - a)])) as Record<Fact, number[]>;
  for (const c of deck) {
    const r = {} as Ranks;
    for (const f of FACTS) {
      const v = factOf(c, f, ids);
      r[f] = 1 + countAbove(sorted[f], v);
    }
    out.set(c.id, r);
  }
  return out;
}

/** In a list sorted high to low: how many are above `v`. */
function countAbove(desc: readonly number[], v: number): number {
  let lo = 0;
  let hi = desc.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (desc[mid]! > v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The facts in which a country is strong (top {@link STRONG}). */
export function strongFacts(r: Ranks): Fact[] {
  return FACTS.filter((f) => r[f] <= STRONG);
}

/** The top {@link STRONG} of each fact in the deck, best first (ids), ties by name for a stable order. */
export function topLists(deck: readonly Country[], ranks: ReadonlyMap<string, Ranks>): Record<Fact, string[]> {
  return Object.fromEntries(
    FACTS.map((f) => [
      f,
      deck
        .filter((c) => (ranks.get(c.id)?.[f] ?? Infinity) <= STRONG)
        .sort((a, b) => ranks.get(a.id)![f] - ranks.get(b.id)![f] || a.name.en.localeCompare(b.name.en))
        .map((c) => c.id),
    ]),
  ) as Record<Fact, string[]>;
}

// ---------------------------------------------------------------------------
// Rounds

/** The rounds to play: the setting, up to a multiple of the players so everyone is captain as often (§2.4). */
export function roundsFor(setting: number, players: number): number {
  const n = Math.max(1, players);
  return Math.ceil(setting / n) * n;
}

/**
 * Compares the cards of a round on one fact: the order (best first) and
 * who wins (everyone with the best number).
 */
export function compete(hands: ReadonlyMap<string, Country>, fact: Fact, ids: ReadonlySet<string>): { order: string[]; winners: string[]; values: Map<string, number> } {
  const values = new Map([...hands].map(([pid, c]) => [pid, factOf(c, fact, ids)] as const));
  const order = [...values.keys()].sort((a, b) => values.get(b)! - values.get(a)!);
  const best = order.length ? values.get(order[0]!)! : 0;
  return { order, winners: order.filter((p) => values.get(p) === best), values };
}

/** The countries a challenge may ask about: the deck's best-known `size` (§6; Infinity: all). */
export function knownEnough(deck: readonly Country[], size: number): (c: Country) => boolean {
  if (!Number.isFinite(size)) return () => true;
  const fames = deck.map((c) => c.fame).sort((a, b) => a - b);
  const limit = fames[Math.min(fames.length, size) - 1] ?? Infinity;
  return (c) => c.fame <= limit;
}

/**
 * Who wins a "where" challenge: distances (km, 0 on the land) by player;
 * the best and everyone within {@link HIT_KM} or {@link TIE_SHARE} of it,
 * when the best is within `maxKm`. Returns the winners and the band
 * (the furthest distance that still wins), or no one.
 */
export function judgePins(distances: ReadonlyMap<string, number>, maxKm: number): { winners: string[]; band: number | null } {
  const ds = [...distances.values()].filter((d) => Number.isFinite(d));
  if (ds.length === 0) return { winners: [], band: null };
  const raw = Math.min(...ds);
  const best = raw <= HIT_KM ? 0 : raw;
  if (best > maxKm) return { winners: [], band: null };
  const band = best === 0 ? HIT_KM : Math.max(best + HIT_KM, best * (1 + TIE_SHARE));
  const winners = [...distances].filter(([, d]) => d <= band).map(([p]) => p);
  return { winners, band };
}

/**
 * Who is captain in a round: the players in their seat order, one after
 * the other, skipping those away (whoever is next and there).
 */
export function captainFor(round: number, seats: readonly string[], here: (id: string) => boolean): string | undefined {
  const n = seats.length;
  for (let k = 0; k < n; k++) {
    const id = seats[(round - 1 + k) % n]!;
    if (here(id)) return id;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The new kinds' choices and judging (§4.5–4.10)

/** Far away (easy's wrong flags and odd ones), km between centres. */
export const FAR_KM = 3000;
/** Easy's odd one: not touching, but in the same part of the world (km between centres). */
export const ODD_EASY_KM: [number, number] = [800, 2500];
/** Normal's odd one: within this (km between centres). */
export const NEAR_KM = 1500;
/** A country smaller than this across (km) is never a shape to name (§4.6). */
export const SHAPE_KM = 20;

/** Km between two countries' centres (where their names go). */
export function apart(a: Country, b: Country): number {
  return km(a.at, b.at);
}

/** The first `n` of `items` that `ok` takes, in a random order. */
function sample<T>(items: readonly T[], n: number, rng: () => number, ok: (x: T) => boolean = () => true): T[] {
  return shuffle(items.filter(ok), rng).slice(0, n);
}

/**
 * The wrong flags for "pick the flag" (§4.5): `n` of `pool`, never the
 * country itself nor a flag that looks the same (an equal `look`).
 * Easy: random ones far away; normal: the nearest by centre; hard: those
 * of the most similar colours (nearest by centre without the colours).
 * Fewer when the pool has fewer.
 */
export function wrongFlags(c: Country, pool: readonly Country[], difficulty: Difficulty, n: number, rng: () => number, colours?: ReadonlyMap<string, FlagColours>): Country[] {
  const mine = colours?.get(c.flag);
  const others = pool.filter((x) => x.id !== c.id && x.flag !== c.flag && !(mine && colours?.get(x.flag)?.look === mine.look));
  const nearest = () => [...others].sort((a, b) => apart(c, a) - apart(c, b) || a.id.localeCompare(b.id)).slice(0, n);
  if (difficulty === "easy") {
    const far = sample(others, n, rng, (x) => apart(c, x) > FAR_KM);
    return far.length >= n ? far : [...far, ...sample(others, n - far.length, rng, (x) => !far.includes(x))];
  }
  if (difficulty === "hard" && mine) {
    const d = (x: Country) => {
      const k = colours?.get(x.flag);
      return k ? colourDistance(mine, k) : Infinity;
    };
    return [...others].sort((a, b) => d(a) - d(b) || a.id.localeCompare(b.id)).slice(0, n);
  }
  return nearest();
}

/** The numbers "which is bigger" asks about (§4.7), and those to guess (§4.8). */
export const BIGGER_FACTS = ["population", "area", "highest", "gdp"] as const satisfies readonly Fact[];
export type BiggerFact = (typeof BIGGER_FACTS)[number];
export const GUESS_FACTS = ["population", "area", "highest"] as const satisfies readonly Fact[];
export type GuessFact = (typeof GUESS_FACTS)[number];
/** The guess slider's ends per number (§4.8). */
export const GUESS_RANGE: Record<GuessFact, [number, number]> = { population: [1000, 2e9], area: [1, 2e7], highest: [10, 9000] };

/** Whether four numbers (largest first) make a fair "which is bigger" at a difficulty (§4.7). */
export function fairBigger(desc: readonly number[], difficulty: Difficulty): boolean {
  if (desc.length !== 4 || desc.some((v) => !(v > 0))) return false;
  for (let i = 1; i < 4; i++) if (!(desc[i - 1]! > desc[i]!)) return false;
  if (desc[0]! < desc[1]! * 1.1) return false;
  if (difficulty === "easy") return desc.every((v, i) => i === 0 || desc[i - 1]! >= v * 2);
  if (difficulty === "hard") return desc[0]! <= desc[3]! * 1.5;
  return true;
}

/**
 * "Which is bigger" around a country (§4.7): a number and four countries
 * with `c` among them, fair at the difficulty, in a random order, and
 * which one is the biggest; null when no number makes it fair.
 */
export function biggerOf(c: Country, pool: readonly Country[], difficulty: Difficulty, rng: () => number): { fact: BiggerFact; options: Country[]; right: number } | null {
  const others = pool.filter((x) => x.id !== c.id);
  for (const fact of shuffle(BIGGER_FACTS, rng)) {
    const v = (x: Country) => factOf(x, fact, new Set());
    const mine = v(c);
    if (!(mine > 0)) continue;
    // Only those that can stand with c: a different number, and on hard within ×1.5 of it.
    const fit = others.filter((x) => {
      const w = v(x);
      if (!(w > 0) || w === mine) return false;
      if (difficulty === "hard") return Math.max(w, mine) <= Math.min(w, mine) * 1.5;
      if (difficulty === "easy") return Math.max(w, mine) >= Math.min(w, mine) * 2;
      return true;
    });
    for (let tries = 0; tries < 300 && fit.length >= 3; tries++) {
      const four = [c, ...sample(fit, 3, rng)];
      const desc = four.map(v).sort((a, b) => b - a);
      if (!fairBigger(desc, difficulty)) continue;
      const options = shuffle(four, rng);
      const best = Math.max(...options.map(v));
      return { fact, options, right: options.findIndex((x) => v(x) === best) };
    }
  }
  return null;
}

/** A number to guess about a country (§4.8): one whose value is on the slider, or null. */
export function guessOf(c: Country, rng: () => number): { fact: GuessFact; value: number } | null {
  for (const fact of shuffle(GUESS_FACTS, rng)) {
    const value = factOf(c, fact, new Set());
    const [lo, hi] = GUESS_RANGE[fact];
    if (value >= lo && value <= hi) return { fact, value };
  }
  return null;
}

/** Reference countries on the guess slider (§4.8). */
export const GUESS_REFS = 4;

/**
 * The guess slider's reference countries (§4.8): up to four others than
 * `c` whose number is on the slider and not `c`'s own: the smallest, the
 * largest, and between them one of the best known near a third and two
 * thirds of the way (log); smallest first.
 */
export function guessRefs(c: Country, deck: readonly Country[], fact: GuessFact, rng: () => number): { country: Country; value: number }[] {
  const [lo, hi] = GUESS_RANGE[fact];
  const mine = factOf(c, fact, new Set());
  const on = deck
    .filter((x) => x.id !== c.id)
    .map((country) => ({ country, value: factOf(country, fact, new Set()) }))
    .filter((r) => r.value >= lo && r.value <= hi && r.value !== mine)
    .sort((a, b) => a.value - b.value || a.country.fame - b.country.fame);
  if (on.length <= GUESS_REFS) return on;
  const first = on[0]!;
  const last = on[on.length - 1]!;
  const span = Math.log(last.value) - Math.log(first.value);
  const at = (r: { value: number }) => (span > 0 ? (Math.log(r.value) - Math.log(first.value)) / span : 0);
  const picked = [first, last];
  for (const goal of [1 / 3, 2 / 3]) {
    const free = on.filter((r) => !picked.includes(r) && r.value !== first.value && r.value !== last.value && !picked.some((p) => p.value === r.value));
    if (!free.length) continue;
    // One of the three best known within a tenth of the way, else the nearest.
    const near = free.filter((r) => Math.abs(at(r) - goal) <= 0.1).sort((a, b) => a.country.fame - b.country.fame);
    picked.push(near.length ? near[Math.floor(rng() * Math.min(3, near.length))]! : free.reduce((a, b) => (Math.abs(at(b) - goal) < Math.abs(at(a) - goal) ? b : a)));
  }
  return picked.sort((a, b) => a.value - b.value);
}

/**
 * Who wins "guess the number" (§4.8): the closest by ratio (|log
 * guess/answer|) and everyone within 10 % of that ratio; a guess off by
 * more than `factor` never wins. Also how far off each is (the ratio, ≥ 1).
 */
export function judgeGuesses(guesses: ReadonlyMap<string, number>, answer: number, factor: number): { winners: string[]; off: Map<string, number> } {
  const off = new Map<string, number>();
  for (const [p, g] of guesses) if (g > 0 && Number.isFinite(g) && answer > 0) off.set(p, Math.exp(Math.abs(Math.log(g / answer))));
  if (off.size === 0) return { winners: [], off };
  const best = Math.min(...off.values());
  if (best > factor) return { winners: [], off };
  const band = Math.min(factor, best * (1 + TIE_SHARE));
  return { winners: [...off].filter(([, r]) => r <= band + 1e-12).map(([p]) => p), off };
}

/**
 * Whether a typed neighbour is right (§4.9): it reads as one of the
 * neighbours and not as the country asked. A name both share ("Congo"
 * for either Congo, "Korea" for either Korea) is the country itself too:
 * wrong, or naming the country would count as its neighbour.
 */
export function rightNeighbour(read: readonly string[], asked: string, neighbours: readonly string[]): boolean {
  return read.length > 0 && !read.includes(asked) && read.some((id) => neighbours.includes(id));
}

/**
 * "Odd one out" around X (§4.10): three of X's neighbours in the deck and
 * one country that is not, in a random order, and which is the odd one.
 * The odd one is always in the same part of the world (never one from
 * the other side, which would give it away): easy {@link ODD_EASY_KM}
 * away, normal within {@link NEAR_KM}, hard the nearest that is no
 * neighbour (by centre); the nearest when there is none so placed. Null with fewer than three
 * neighbours.
 */
export function oddOf(x: Country, deck: readonly Country[], pool: readonly Country[], difficulty: Difficulty, rng: () => number): { options: Country[]; right: number } | null {
  const ids = new Set(deck.map((c) => c.id));
  const near = neighboursIn(x, ids);
  if (near.length < 3) return null;
  const three = sample(deck.filter((c) => near.includes(c.id)), 3, rng);
  // The odd one is no neighbour of X, and of none of the three either would be too hard to tell: only X counts.
  const not = pool.filter((c) => c.id !== x.id && !near.includes(c.id));
  if (!not.length) return null;
  let odd: Country | undefined;
  if (difficulty === "easy") odd = sample(not, 1, rng, (c) => apart(x, c) >= ODD_EASY_KM[0] && apart(x, c) <= ODD_EASY_KM[1])[0];
  else if (difficulty === "normal") odd = sample(not, 1, rng, (c) => apart(x, c) <= NEAR_KM)[0];
  odd ??= [...not].sort((a, b) => apart(x, a) - apart(x, b) || a.id.localeCompare(b.id))[0]!;
  const options = shuffle([...three, odd], rng);
  return { options, right: options.indexOf(odd) };
}
