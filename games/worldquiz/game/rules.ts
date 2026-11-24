/**
 * Worldquiz's rules without the party (docs/worldquiz-design.md): the
 * settings, the deck with its discard pile, the facts and their ranks,
 * comparing cards, picking challenges, and judging pins on the map.
 * Pure functions and small classes, tested in Node.
 */

import type { Country, Lang } from "./data.ts";

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

/** The five numbers on a card, in the card's order. */
export const FACTS = ["population", "area", "neighbours", "highest", "gdp"] as const;
export type Fact = (typeof FACTS)[number];

export const KINDS = ["capital", "flag", "where"] as const;
export type Kind = (typeof KINDS)[number];

/** What a difficulty changes (§6). */
export interface Level {
  /** Seconds to answer a challenge. */
  answer: number;
  /** Challenges come from this many best-known countries of the deck (Infinity: all). */
  known: number;
  /** A pin further than this (km) never wins. */
  maxKm: number;
  /** The phone's map draws borders (else only coastlines). */
  borders: boolean;
}

export const LEVELS: Record<Difficulty, Level> = {
  easy: { answer: 90, known: 80, maxKm: 3000, borders: true },
  normal: { answer: 60, known: 150, maxKm: 1500, borders: true },
  hard: { answer: 30, known: Infinity, maxKm: 800, borders: false },
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

/** The countries a challenge may ask about: the deck's best-known (§6). */
export function knownEnough(deck: readonly Country[], level: Level): (c: Country) => boolean {
  if (!Number.isFinite(level.known)) return () => true;
  const fames = deck.map((c) => c.fame).sort((a, b) => a - b);
  const limit = fames[Math.min(fames.length, level.known) - 1] ?? Infinity;
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
