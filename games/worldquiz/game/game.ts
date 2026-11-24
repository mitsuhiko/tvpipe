/**
 * Worldquiz on a party, for 2 to 10 players (docs/worldquiz-design.md):
 * the lobby, then rounds. In a round everyone draws a country card at
 * the same time and sees only their own; the captain (in turn) competes
 * with one of the card's five numbers (every card turns over, the highest
 * steps one) or calls a challenge (the hands are shown and discarded,
 * then a random new country with a random kind of challenge: its
 * capital, its name from the flag, or where it is on the map; everyone
 * answers, the right ones step). The furthest after the rounds wins; a
 * tie at the top is settled by pins on the map. The host is the only
 * authority: phones and the TV only ever get views.
 *
 * Views:
 * - `party.room` (every phone): `{ phase, lang, round, rounds, minPlayers, colors, steps, settings…, stage?,
 *   captain?, deadline?, kind?, question?, locked?, gone?, left? }`: `settings` are `rounds`, `difficulty`,
 *   `disputed`, `map`; `steps` by player id; `question` what a challenge shows (`name` for a capital or a
 *   place, `flag` for a flag); `locked` who has locked an answer in; `gone` per number the discarded cards
 *   of its top ten with their ranks (§2.2), `left` the cards left in the deck.
 * - `player.state` (one phone): `{ task, color, steps, … }`; `task` one of `lobby`, `wait` (a late joiner),
 *   `card` (one's card (`card`), `captain`, `deadline`, `chose`), `compete` (`card`, `fact`, `place`, `won`),
 *   `watch` (the TV has the stage: `what`, `card`), `answer` (`kind`, `question`, `deadline`, `locked`,
 *   `draft`, `borders`), `result` (`kind`, `right`, `solution`, `mine`), `final` (`place`, `of`, `won`);
 *   `compete`, `watch` (the discard) and `result` carry `next` (the key to press Next with) and `ready`.
 * - `party.screen` (the TV): `{ phase, lang, colors, round, rounds, map, players, gone, left, stage?, … }`:
 *   `draw` (`captain`, `hands`: who holds a card, never which), `compete` (`fact`, `cards` with their
 *   values, `order`, `winners`), `discard` (`cards`), `challenge` (`kind`, `try`, `question`, `deadline`,
 *   `locked`), `answer` (`kind`, `solution`, `answers` (pins with `to`, the country's nearest point),
 *   `winners`, `band`), `final` (`places`); `compete`, `discard` and `answer` stay until everyone asked
 *   (`nextFor`) has pressed Next (`ready`), and the room has these too.
 *
 * A card reaches only its holder's phone until the captain competes or
 * the hands are discarded; a challenge's answer reaches nobody until the
 * reveal (the "where" challenge's country is named, its place is not
 * sent; the flag challenge sends only the flag's file, whose name does
 * not give the country away).
 */

import { Emitter, PartyError, type Json, type Party, type Player, type Sender } from "@tvpipe/party";

import { Matcher, type Candidate } from "./answer.ts";
import type { Country, Lang, Ring } from "./data.ts";
import { nearestOfCountry } from "./geo.ts";
import {
  captainFor,
  compete,
  Deck,
  deckOf,
  DIFFICULTIES,
  FACTS,
  judgePins,
  KINDS,
  knownEnough,
  LANGS,
  LEVELS,
  MAPS,
  MODES,
  MAX_TRIES,
  MIN_PLAYERS,
  neighboursIn,
  pick,
  ranksOf,
  ROUNDS,
  roundsFor,
  STRONG,
  strongFacts,
  topLists,
  type Difficulty,
  type Fact,
  type Kind,
  type MapMode,
  type Mode,
  type Ranks,
} from "./rules.ts";

/**
 * The game's clock (ms). What shows cards or an answer (a compete, the
 * hands before a challenge, a challenge's answer) waits for every player
 * to press Next, so there is time to learn; its timing is only how long
 * before Next counts (the TV's animation). Once someone has pressed, the
 * others get a countdown (`nextCountdown`); nobody pressing, it starts
 * anyway so that the wait ends `next` after the stage opened.
 */
export interface Timings {
  /** The captain's choice (null: no limit, the room waits; the captain leaving is a challenge). */
  choose: number | null;
  /** Compete: before the first card. */
  competeIntro: number;
  /** Compete: each card. */
  competeCard: number;
  /** Compete: the winners, at least, before Next counts. */
  competeEnd: number;
  /** The hands shown before a challenge, at least. */
  discard: number;
  /** A challenge announced, before the question. */
  announce: number;
  /** The answer, at least (text challenges). */
  reveal: number;
  /** The answer, at least (where: the lines to the country are drawn). */
  revealWhere: number;
  /** The longest wait for everyone's Next, the countdown included. */
  next: number;
  /** The countdown for those who have not pressed Next yet. */
  nextCountdown: number;
  /** Seconds to answer, by difficulty (null: the level's). */
  answer: number | null;
}

export const DEFAULT_TIMINGS: Timings = {
  choose: null,
  competeIntro: 2500,
  competeCard: 1700,
  competeEnd: 2000,
  discard: 2000,
  announce: 2500,
  reveal: 1500,
  revealWhere: 3500,
  next: 90_000,
  nextCountdown: 15_000,
  answer: null,
};

/** For trying the game: everything short. */
export const FAST_TIMINGS: Timings = {
  choose: null,
  competeIntro: 1200,
  competeCard: 700,
  competeEnd: 1000,
  discard: 800,
  announce: 1200,
  reveal: 800,
  revealWhere: 1500,
  next: 20_000,
  nextCountdown: 5000,
  answer: 8,
};

export interface Settings {
  /** Cards (the captain's choice each round) or only challenges. */
  mode: Mode;
  rounds: number;
  difficulty: Difficulty;
  disputed: boolean;
  map: MapMode;
}

export interface GameOptions {
  countries: readonly Country[];
  /** The land by country id (for the "where" challenge). */
  land: ReadonlyMap<string | null, readonly Ring[]>;
  lang?: Lang | undefined;
  settings?: Partial<Settings> | undefined;
  minPlayers?: number | undefined;
  timings?: Partial<Timings> | undefined;
  rng?: (() => number) | undefined;
}

export interface ScoreLine {
  id: string;
  name: string;
  steps: number;
  place: number;
}

export interface GameEvents {
  phase: [phase: Phase, stage: Stage | null];
  end: [scores: ScoreLine[]];
  settings: [settings: Settings];
}

export type Phase = "lobby" | "round" | "final";
export type Stage = "draw" | "compete" | "discard" | "challenge" | "answer" | "tiebreak";

/** The players' colours (the button palette, docs/worldquiz-design.md §7). */
export const COLORS = ["#3b82f6", "#ef4444", "#22c55e", "#ff6b00", "#9b51e0", "#e0307a", "#14b8a6", "#ffc61a", "#334155", "#8b5a2b"] as const;

/** A card as a view carries it: one language, the deck's numbers and ranks. */
export interface CardView {
  id: string;
  name: string;
  capitals: string[];
  flag: string;
  at: [number, number];
  box: [number, number, number, number];
  facts: Record<Fact, number>;
  /** The ranks in the deck: only on cards that were shown (compared, or discarded before a challenge), never on a hand. */
  ranks?: Ranks;
  strong?: Fact[];
  highest: string;
  gdpYear: number;
  populationYear: number;
  neighbours: string[];
}

/** A player's answer to a challenge as the host keeps it. */
interface Answer {
  text?: string;
  lon?: number;
  lat?: number;
  locked: boolean;
}

/** A wait for everyone's Next: who was asked, who pressed. */
interface NextWait {
  key: string;
  who: string[];
  ready: Set<string>;
  /** When the countdown ends (the party's clock), once it runs. */
  by: number | null;
  wake: () => void;
}

/** A challenge being played. */
interface Challenge {
  key: string;
  kind: Kind;
  country: Country;
  /** Who answers (ids). */
  players: string[];
  deadline: number;
  answers: Map<string, Answer>;
  wake: () => void;
}

export class Worldquiz extends Emitter<GameEvents> {
  readonly party: Party;
  readonly minPlayers: number;
  timings: Timings;
  readonly #all: readonly Country[];
  readonly #land: ReadonlyMap<string | null, readonly Ring[]>;
  readonly #rng: () => number;
  #lang: Lang;
  #settings: Settings;
  readonly #colors = new Map<string, number>();
  readonly #names = new Map<string, string>();
  /** Steps per player id (players in the game). */
  readonly steps = new Map<string, number>();
  /** Seat order (captains go round it). */
  #seats: string[] = [];
  #phase: Phase = "lobby";
  #stage: Stage | null = null;
  #running = false;
  #abort = new AbortController();
  #game = 0;
  #roundNo = 0;
  #rounds = 0;
  // The game's deck and what it knows about it.
  #deck: Deck<Country> | undefined;
  #inDeck = new Set<string>();
  #ranks = new Map<string, Ranks>();
  #tops: Record<Fact, string[]> | undefined;
  #byId = new Map<string, Country>();
  #names2 = { country: new Matcher([]), capital: new Matcher([]) };
  /** Whose card is what this round (player id → country). */
  #hands = new Map<string, Country>();
  #captain: string | undefined;
  #choice: ((c: { fact?: Fact; challenge?: boolean }) => void) | undefined;
  #chooseKey = "";
  #challenge: Challenge | undefined;
  #challengeNo = 0;
  #next: NextWait | undefined;
  #nextNo = 0;

  constructor(party: Party, options: GameOptions) {
    super();
    this.party = party;
    this.minPlayers = options.minPlayers ?? MIN_PLAYERS;
    this.timings = { ...DEFAULT_TIMINGS, ...options.timings };
    this.#rng = options.rng ?? Math.random;
    this.#lang = options.lang ?? "en";
    this.#all = options.countries;
    this.#land = options.land;
    if (this.#all.length === 0) throw new Error("worldquiz: no countries");
    this.#settings = { mode: "cards", rounds: 15, difficulty: "normal", disputed: false, map: "flat", ...options.settings };
    for (const c of this.#all) this.#byId.set(c.id, c);
  }

  get settings(): Settings {
    return { ...this.#settings };
  }

  get phase(): Phase {
    return this.#phase;
  }

  get stage(): Stage | null {
    return this.#stage;
  }

  get running(): boolean {
    return this.#running;
  }

  get lang(): Lang {
    return this.#lang;
  }

  /** The rounds of the game being played (the setting rounded up), or of the next one. */
  get rounds(): number {
    return this.#running ? this.#rounds : this.#settings.rounds;
  }

  /** The challenge being played (the bots' oracle and the tests; never sent before the reveal). */
  get challenge(): { kind: Kind; country: Country } | undefined {
    const c = this.#challenge;
    return c ? { kind: c.kind, country: c.country } : undefined;
  }

  /** The challenge's answer as the bots' oracle wants it (never sent before the reveal). */
  truth(): { kind: string; capitals: string[]; name: string; at: [number, number] } | undefined {
    const c = this.#challenge;
    return c ? { kind: c.kind, capitals: c.country.capitals[this.#lang], name: c.country.name[this.#lang], at: c.country.at } : undefined;
  }

  /** The round's hands (tests). */
  get hands(): ReadonlyMap<string, Country> {
    return this.#hands;
  }

  colorOf(id: string): number {
    return this.#colors.get(id) ?? 0;
  }

  /** Shows the lobby and waits for the VIP to start. */
  open(): void {
    const party = this.party;
    const vipOnly = (from: Sender) => {
      if (from.role !== "player" || !from.vip) throw new PartyError("not-vip", "Only the VIP can do this");
    };
    party.handle("start", (_d, from) => {
      vipOnly(from);
      if (this.#running) throw new PartyError("running", "The game is on");
      const ready = party.connectedPlayers.length;
      if (ready < this.minPlayers) throw new PartyError("too-few", `Wait for ${this.minPlayers - ready} more`);
      void this.play();
      return null;
    });
    party.handle("kick", (d, from) => {
      vipOnly(from);
      if (this.#running) throw new PartyError("running", "Not during a game");
      const id = typeof d === "object" && d !== null && "id" in d ? (d as { id: unknown }).id : undefined;
      const p = typeof id === "string" ? party.player(id) : undefined;
      if (!p || p === from) throw new PartyError("no-player", "No such player");
      party.kick(p);
      return null;
    });
    party.handle("settings", (d, from) => {
      vipOnly(from);
      this.configure(parseSettings(d));
      return null;
    });
    party.handle("choose", (d, from) => this.#choose(d, from));
    party.handle("answer", (d, from) => this.#answer(d, from));
    party.handle("next", (d, from) => this.#pressNext(d, from));
    party.on("join", (p) => {
      this.#names.set(p.id, p.name);
      this.#colors.set(p.id, this.#freeColor());
      this.#colorsChanged();
      if (!this.#running) p.state.replace(this.#lobbyState(p));
      else p.state.replace({ task: "wait", color: this.colorOf(p.id) });
    });
    party.on("leave", (p) => {
      // A captain who left cannot choose: a challenge.
      if (this.#choice && this.#stage === "draw" && p.id === this.#captain) this.#choice({ challenge: true });
      this.#colors.delete(p.id);
      this.#colorsChanged();
      this.#challenge?.wake();
      this.#next?.wake();
    });
    party.on("away", () => {
      this.#challenge?.wake();
      this.#next?.wake();
    });
    this.#lobby();
  }

  /** Changes the language or the settings before a game; every phone and the TV follow. */
  configure(o: { lang?: Lang | undefined; timings?: Partial<Timings> | undefined } & Partial<Settings>): void {
    if (this.#running) throw new PartyError("running", "Not during a game");
    const was = JSON.stringify([this.#lang, this.#settings]);
    if (o.lang !== undefined && LANGS.includes(o.lang)) this.#lang = o.lang;
    if (o.timings) this.timings = { ...this.timings, ...o.timings };
    const s = this.#settings;
    if (o.mode !== undefined && MODES.includes(o.mode)) s.mode = o.mode;
    if (o.rounds !== undefined && o.rounds > 0) s.rounds = Math.min(99, Math.round(o.rounds));
    if (o.difficulty !== undefined && DIFFICULTIES.includes(o.difficulty)) s.difficulty = o.difficulty;
    if (o.disputed !== undefined) s.disputed = !!o.disputed;
    if (o.map !== undefined && MAPS.includes(o.map)) s.map = o.map;
    if (this.#phase === "lobby" || this.#phase === "final") {
      this.party.room.set({ ...this.settings, roundsSetting: s.rounds, lang: this.#lang });
      this.party.screen.set({ ...this.settings, roundsSetting: s.rounds, lang: this.#lang });
    }
    if (JSON.stringify([this.#lang, this.#settings]) !== was) this.emit("settings", this.settings);
  }

  /** Ends a running game (the party stays): the lobby at once, no final screen. */
  close(): void {
    if (!this.#running) return;
    this.#game++;
    this.#abort.abort();
    this.#stop();
    this.#lobby();
  }

  #stop(): void {
    this.#hands.clear();
    this.#challenge = undefined;
    this.#next = undefined;
    this.#choice = undefined;
    this.#captain = undefined;
    this.#stage = null;
    this.#running = false;
    this.party.inProgress = false;
    for (const p of this.party.players) this.party.activate(p);
  }

  // -------------------------------------------------------------------------
  // Views

  #setPhase(phase: Phase, stage: Stage | null = null): void {
    const changed = phase !== this.#phase || stage !== this.#stage;
    this.#phase = phase;
    this.#stage = stage;
    if (changed) this.emit("phase", phase, stage);
  }

  #freeColor(): number {
    const used = COLORS.map(() => 0);
    for (const p of this.party.players) {
      const c = this.#colors.get(p.id);
      if (c !== undefined) used[c]!++;
    }
    return used.indexOf(Math.min(...used));
  }

  #colorMap(): Record<string, string> {
    return Object.fromEntries(this.party.players.map((p) => [p.id, COLORS[this.colorOf(p.id)]!]));
  }

  #colorsChanged(): void {
    const colors = this.#colorMap();
    this.party.room.set({ colors });
    this.party.screen.set({ colors, players: this.#playersView() });
  }

  #name(id: string): string {
    return this.party.player(id)?.name ?? this.#names.get(id) ?? "?";
  }

  #playersView(): { id: string; name: string; color: string; steps: number; away: boolean }[] {
    const ids = this.#running ? [...this.steps.keys()].filter((id) => this.party.player(id)) : this.party.players.map((p) => p.id);
    return ids.map((id) => ({ id, name: this.#name(id), color: COLORS[this.colorOf(id)]!, steps: this.steps.get(id) ?? 0, away: !this.party.player(id)?.connected }));
  }

  #stepsView(): Record<string, number> {
    return Object.fromEntries(this.steps);
  }

  #lobbyState(p: Player): Record<string, unknown> {
    return { task: this.#phase === "final" ? "final" : "lobby", color: this.colorOf(p.id), steps: this.steps.get(p.id) ?? 0, ...this.#place(p.id) };
  }

  #place(id: string): { place: number; of: number } {
    const all = [...this.steps.values()];
    const mine = this.steps.get(id) ?? 0;
    return { place: 1 + all.filter((s) => s > mine).length, of: all.length };
  }

  #common(): Record<string, unknown> {
    return { ...this.settings, roundsSetting: this.#settings.rounds, lang: this.#lang, round: this.#roundNo, rounds: this.rounds, minPlayers: this.minPlayers, colors: this.#colorMap(), steps: this.#stepsView() };
  }

  #room(fields: Record<string, unknown>): void {
    this.party.room.replace({ ...this.#common(), ...this.#deckView(), ...fields });
  }

  #screen(fields: Record<string, unknown>): void {
    this.party.screen.replace({ ...this.#common(), players: this.#playersView(), ...this.#deckView(), ...fields });
  }

  /**
   * The strong cards that are gone (§2.2): per number, the discarded
   * cards in its top ten, with their rank; and the cards left. Only
   * cards that were shown are in it: a rank is never told before.
   */
  #deckView(): Record<string, unknown> {
    const deck = this.#deck;
    const tops = this.#tops;
    if (!deck || !tops) return {};
    const gone = new Set(deck.pile.map((c) => c.id));
    const out: Record<string, { id: string; name: string; flag: string; rank: number }[]> = {};
    for (const f of FACTS)
      out[f] = tops[f].filter((id) => gone.has(id)).map((id) => ({ id, name: this.#byId.get(id)!.name[this.#lang], flag: this.#byId.get(id)!.flag, rank: this.#ranks.get(id)![f] }));
    return { gone: out, left: deck.left, deckSize: this.#inDeck.size };
  }

  #lobby(): void {
    this.#setPhase("lobby");
    this.#room({ phase: "lobby", maxPlayers: this.party.maxPlayers });
    this.#screen({ phase: "lobby", maxPlayers: this.party.maxPlayers });
    for (const p of this.party.players) p.state.replace(this.#lobbyState(p));
  }

  /** A card in the room's language, with the deck's numbers; `ranks` once it was shown (§2.2). */
  card(c: Country, ranked = true): CardView {
    const l = this.#lang;
    const ranks = this.#ranks.get(c.id) ?? { population: 0, area: 0, neighbours: 0, highest: 0, gdp: 0 };
    const facts = { population: c.population, area: c.area, neighbours: neighboursIn(c, this.#inDeck).length, highest: c.highest.m, gdp: c.gdp };
    const neighbours = neighboursIn(c, this.#inDeck).map((id) => {
      const n = this.#byId.get(id)!;
      const via = c.via?.[id]?.[l];
      return via ? `${n.name[l]} (${via})` : n.name[l];
    });
    return {
      id: c.id,
      name: c.name[l],
      capitals: c.capitals[l],
      flag: c.flag,
      at: c.at,
      box: c.box,
      facts,
      ...(ranked ? { ranks, strong: strongFacts(ranks) } : {}),
      highest: c.highest.name[l],
      gdpYear: c.gdpYear,
      populationYear: c.populationYear,
      neighbours,
    };
  }

  // -------------------------------------------------------------------------
  // A game

  /** Plays a whole game with the players who are there (and those who join). */
  async play(): Promise<ScoreLine[]> {
    const party = this.party;
    const game = ++this.#game;
    this.#running = true;
    this.#abort = new AbortController();
    const signal = this.#abort.signal;
    party.inProgress = true;
    this.steps.clear();
    this.#setupDeck();
    const start = party.players.filter((p) => p.connected);
    this.#seats = start.map((p) => p.id);
    // Cards: everyone captain as often; the quiz has no captain.
    this.#rounds = this.#settings.mode === "quiz" ? this.#settings.rounds : roundsFor(this.#settings.rounds, this.#seats.length);
    for (const id of this.#seats) this.steps.set(id, 0);
    try {
      for (let r = 1; r <= this.#rounds; r++) {
        this.#roundNo = r;
        this.#dealIn();
        const players = party.players.filter((p) => this.steps.has(p.id) && p.connected);
        if (party.players.filter((p) => this.steps.has(p.id)).length < this.minPlayers || players.length === 0) break;
        await this.#round(r, signal);
        if (signal.aborted) break;
      }
      if (!signal.aborted) await this.#tiebreak(signal);
      return signal.aborted ? this.#lines() : this.#final();
    } finally {
      if (this.#game === game) this.#stop();
    }
  }

  #setupDeck(): void {
    const deck = deckOf(this.#all, this.#settings.disputed);
    this.#inDeck = new Set(deck.map((c) => c.id));
    this.#ranks = ranksOf(deck);
    this.#tops = topLists(deck, this.#ranks);
    this.#deck = new Deck(deck, this.#rng);
    const country: Candidate[] = this.#all.map((c) => ({ id: c.id, names: [c.name.en, c.name.de, ...c.aliases.en, ...c.aliases.de] }));
    const capital: Candidate[] = this.#all.map((c) => ({ id: c.id, names: [...c.capitals.en, ...c.capitals.de, ...c.capitalAliases.en, ...c.capitalAliases.de] }));
    this.#names2 = { country: new Matcher(country), capital: new Matcher(capital) };
  }

  /** Waiting players join at the back of the field (the last place's steps) and of the seats. */
  #dealIn(): void {
    const low = Math.min(...[...this.steps.values()], Infinity);
    for (const p of this.party.players) {
      if (p.waiting) this.party.activate(p);
      if (!this.steps.has(p.id) && p.connected) {
        this.steps.set(p.id, Number.isFinite(low) ? low : 0);
        this.#seats.push(p.id);
      }
    }
    for (const id of [...this.steps.keys()]) if (!this.party.player(id)) this.steps.delete(id);
  }

  async #round(n: number, signal: AbortSignal): Promise<void> {
    const party = this.party;
    const deck = this.#deck!;
    if (this.#settings.mode === "quiz") {
      // Only the challenges: no cards, no captain.
      this.#captain = undefined;
      return this.#challenges(signal);
    }
    const players = party.players.filter((p) => this.steps.has(p.id) && p.connected);
    this.#hands = new Map(players.map((p) => [p.id, deck.draw()]));
    this.#captain = captainFor(n, this.#seats, (id) => !!party.player(id)?.connected && this.#hands.has(id));
    const captain = this.#captain!;
    const deadline = this.timings.choose === null ? null : party.deadline(this.timings.choose);
    this.#chooseKey = `${this.#game}:${n}`;
    const choice = new Promise<{ fact?: Fact; challenge?: boolean }>((resolve) => {
      this.#choice = resolve;
    });
    party.withTv(() => {
      this.#setPhase("round", "draw");
      this.#room({ phase: "round", stage: "draw", captain, deadline });
      this.#screen({ phase: "round", stage: "draw", captain, deadline, hands: [...this.#hands.keys()] });
      for (const p of party.players) {
        const c = this.#hands.get(p.id);
        if (c) p.state.replace({ task: "card", color: this.colorOf(p.id), steps: this.steps.get(p.id) ?? 0, card: this.card(c, false), captain: p.id === captain, deadline, key: this.#chooseKey });
        else p.state.replace({ task: "wait", color: this.colorOf(p.id) });
      }
    });
    // No choice in time (with a limit), or the game ends: a challenge (unplayed when it ended).
    const timeout =
      deadline === null
        ? new Promise<void>((resolve) => (signal.aborted ? resolve() : signal.addEventListener("abort", () => resolve(), { once: true })))
        : this.#sleep(Math.max(0, deadline - party.now()) + 300, signal);
    const chosen = await Promise.race([choice, timeout.then((): { fact?: Fact; challenge?: boolean } => ({ challenge: true }))]);
    this.#choice = undefined;
    if (signal.aborted) return;
    if (chosen.fact) await this.#compete(chosen.fact, signal);
    else await this.#discardAndChallenge(signal);
    deck.discard(...this.#hands.values());
    this.#hands.clear();
  }

  #choose(d: Json, from: Sender): null {
    if (from.role !== "player") throw new PartyError("not-player", "Only players choose");
    if (!this.#choice || this.#stage !== "draw") throw new PartyError("not-now", "Nothing to choose now");
    if (from.id !== this.#captain) throw new PartyError("not-captain", "Only the captain chooses");
    const v = (typeof d === "object" && d !== null && !Array.isArray(d) ? d : {}) as Record<string, Json>;
    if (v["key"] !== undefined && v["key"] !== this.#chooseKey) throw new PartyError("not-now", "That round is over");
    if (v["challenge"] === true) this.#choice({ challenge: true });
    else if (typeof v["fact"] === "string" && (FACTS as readonly string[]).includes(v["fact"])) this.#choice({ fact: v["fact"] as Fact });
    else throw new PartyError("bad-choice", "fact or challenge");
    return null;
  }

  async #compete(fact: Fact, signal: AbortSignal): Promise<void> {
    const party = this.party;
    const { order, winners, values } = compete(this.#hands, fact, this.#inDeck);
    const cards = order.map((pid) => ({ pid, card: this.card(this.#hands.get(pid)!), value: values.get(pid)! }));
    for (const w of winners) this.steps.set(w, (this.steps.get(w) ?? 0) + 1);
    const t = this.timings;
    const ms = t.competeIntro + t.competeCard * cards.length + t.competeEnd;
    // The hands go onto the pile now, so the TV's table of what is gone has them.
    this.#deck!.discard(...this.#hands.values());
    const held = new Map(this.#hands);
    this.#hands.clear();
    const nx = this.#openNext([...held.keys()]);
    party.withTv(() => {
      this.#setPhase("round", "compete");
      this.#room({ phase: "round", stage: "compete", captain: this.#captain, fact, ...this.#nextView(nx) });
      this.#screen({ phase: "round", stage: "compete", captain: this.#captain, fact, cards, order, winners, ms, intro: t.competeIntro, per: t.competeCard, ...this.#nextView(nx) });
      for (const p of party.players) {
        const c = held.get(p.id);
        if (!c) continue;
        p.state.replace({ task: "compete", color: this.colorOf(p.id), steps: this.steps.get(p.id) ?? 0, card: this.card(c), fact, place: 1 + order.filter((o) => values.get(o)! > values.get(p.id)!).length, of: order.length, won: winners.includes(p.id), winners: winners.map((w) => this.#name(w)), next: nx.key, ready: false });
      }
    });
    await this.#awaitNext(nx, ms, signal);
  }

  async #discardAndChallenge(signal: AbortSignal): Promise<void> {
    const party = this.party;
    const held = new Map(this.#hands);
    const cards = [...held].map(([pid, c]) => ({ pid, card: this.card(c) }));
    this.#deck!.discard(...held.values());
    this.#hands.clear();
    const nx = this.#openNext([...held.keys()]);
    party.withTv(() => {
      this.#setPhase("round", "discard");
      this.#room({ phase: "round", stage: "discard", captain: this.#captain, ...this.#nextView(nx) });
      this.#screen({ phase: "round", stage: "discard", captain: this.#captain, cards, ...this.#nextView(nx) });
      for (const p of party.players) {
        const c = held.get(p.id);
        if (c) p.state.replace({ task: "watch", what: "discard", color: this.colorOf(p.id), steps: this.steps.get(p.id) ?? 0, card: this.card(c), next: nx.key, ready: false });
      }
    });
    await this.#awaitNext(nx, this.timings.discard, signal);
    await this.#challenges(signal);
  }

  /** Challenges until someone wins one (at most three). */
  async #challenges(signal: AbortSignal): Promise<void> {
    for (let k = 1; k <= MAX_TRIES && !signal.aborted; k++) {
      const won = await this.#challengeOnce(k, signal);
      if (won.length) break;
    }
  }

  /** The answer time (ms) of the room's difficulty. */
  #answerMs(): number {
    return (this.timings.answer ?? LEVELS[this.#settings.difficulty].answer) * 1000;
  }

  /** One challenge: a random country of the deck with a random kind. Resolves with who won. */
  async #challengeOnce(attempt: number, signal: AbortSignal, only?: string[], kind?: Kind): Promise<string[]> {
    const party = this.party;
    const level = LEVELS[this.#settings.difficulty];
    const deck = this.#deck!;
    const country = deck.draw(knownEnough(deckOf(this.#all, this.#settings.disputed), level));
    kind ??= pick(KINDS, this.#rng);
    const players = only ?? party.players.filter((p) => this.steps.has(p.id) && p.connected).map((p) => p.id);
    const key = `${this.#game}:${this.#roundNo}:${++this.#challengeNo}`;
    const question = this.#question(kind, country);
    // The announcement, then the question with its deadline.
    party.withTv(() => {
      this.#setPhase("round", only ? "tiebreak" : "challenge");
      this.#room({ phase: "round", stage: "announce", kind, try: attempt, captain: this.#captain, tiebreak: !!only });
      this.#screen({ phase: "round", stage: "announce", kind, try: attempt, captain: this.#captain, tiebreak: only ?? null });
      for (const p of party.players) if (this.steps.has(p.id)) p.state.replace({ task: "watch", what: "announce", kind, color: this.colorOf(p.id), steps: this.steps.get(p.id) ?? 0 });
    });
    await this.#sleep(this.timings.announce, signal);
    if (signal.aborted) return [];
    const deadline = party.deadline(this.#answerMs());
    let wake = () => {};
    const ch: Challenge = { key, kind, country, players, deadline, answers: new Map(), wake: () => wake() };
    this.#challenge = ch;
    const borders = level.borders;
    party.withTv(() => {
      this.#room({ phase: "round", stage: "challenge", kind, try: attempt, question, deadline, locked: [], captain: this.#captain, tiebreak: !!only });
      this.#screen({ phase: "round", stage: "challenge", kind, try: attempt, question, deadline, locked: [], answering: players, captain: this.#captain, tiebreak: only ?? null });
      for (const p of party.players) {
        if (!this.steps.has(p.id)) continue;
        if (players.includes(p.id)) p.state.replace({ task: "answer", key, kind, question, deadline, borders, locked: false, color: this.colorOf(p.id), steps: this.steps.get(p.id) ?? 0 });
        else p.state.replace({ task: "watch", what: "tiebreak", color: this.colorOf(p.id), steps: this.steps.get(p.id) ?? 0 });
      }
    });
    // Until the deadline, or until everyone who is there has locked in.
    const allIn = () => players.every((id) => ch.answers.get(id)?.locked || !party.player(id)?.connected);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, Math.max(0, deadline - party.now()) + party.grace);
      function done() {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      }
      wake = () => {
        if (allIn()) done();
      };
      signal.addEventListener("abort", done, { once: true });
      if (players.length === 0) done();
    });
    this.#challenge = undefined;
    if (signal.aborted) return [];
    deck.discard(country);
    return this.#reveal(ch, attempt, only, signal);
  }

  #question(kind: Kind, c: Country): Record<string, unknown> {
    const l = this.#lang;
    switch (kind) {
      case "capital":
        return { name: c.name[l], flag: c.flag, at: c.at, box: c.box, id: c.id };
      case "flag":
        return { flag: c.flag };
      case "where":
        return { name: c.name[l] };
    }
  }

  #answer(d: Json, from: Sender): { locked: boolean } {
    if (from.role !== "player") throw new PartyError("not-player", "Only players answer");
    const ch = this.#challenge;
    if (!ch) throw new PartyError("not-now", "No question now");
    if (!ch.players.includes(from.id)) throw new PartyError("not-yours", "Not your question");
    const v = (typeof d === "object" && d !== null && !Array.isArray(d) ? d : {}) as Record<string, Json>;
    if (v["key"] !== undefined && v["key"] !== ch.key) throw new PartyError("not-now", "That question is over");
    if (this.party.now() > ch.deadline + this.party.grace) throw new PartyError("too-late", "Time is up");
    const had = ch.answers.get(from.id);
    if (had?.locked) throw new PartyError("locked", "Already locked in");
    const a: Answer = { locked: v["lock"] === true };
    if (ch.kind === "where") {
      const lon = v["lon"];
      const lat = v["lat"];
      if (typeof lon !== "number" || typeof lat !== "number" || !Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new PartyError("bad-answer", "lon and lat");
      a.lon = lon;
      a.lat = lat;
    } else {
      const text = v["text"];
      if (typeof text !== "string") throw new PartyError("bad-answer", "text");
      a.text = text.replace(/\s+/g, " ").trim().slice(0, 60);
      if (a.locked && !a.text) throw new PartyError("bad-answer", "empty");
    }
    ch.answers.set(from.id, a);
    // The phone's draft, for a reloaded page (never the others').
    this.party.player(from.id)?.state.set({ draft: ch.kind === "where" ? { lon: a.lon!, lat: a.lat! } : { text: a.text ?? "" } });
    if (a.locked) {
      const locked = ch.players.filter((id) => ch.answers.get(id)?.locked);
      this.party.room.set({ locked });
      this.party.screen.set({ locked });
      const p = this.party.player(from.id);
      p?.state.set({ locked: true });
    }
    ch.wake();
    return { locked: a.locked };
  }

  /** Judges a challenge and shows the answer; resolves with who won. */
  async #reveal(ch: Challenge, attempt: number, only: string[] | undefined, signal: AbortSignal): Promise<string[]> {
    const party = this.party;
    const level = LEVELS[this.#settings.difficulty];
    const c = ch.country;
    const answers: Record<string, unknown>[] = [];
    let winners: string[] = [];
    let band: number | null = null;
    if (ch.kind === "where") {
      const dists = new Map<string, number>();
      const nearest = new Map<string, [number, number]>();
      for (const id of ch.players) {
        const a = ch.answers.get(id);
        if (a?.lon === undefined || a.lat === undefined) continue;
        const n = nearestOfCountry(this.#land, c.id, a.lon, a.lat);
        dists.set(id, Math.round(n.km));
        nearest.set(id, [Math.round(n.at[0] * 1000) / 1000, Math.round(n.at[1] * 1000) / 1000]);
      }
      if (only) {
        // The tie-break: the closest alone wins; still equal, nobody (the next pin decides).
        const best = Math.min(...dists.values());
        const at = [...dists].filter(([, d]) => d === best).map(([id]) => id);
        winners = at.length === 1 ? at : [];
      } else ({ winners, band } = judgePins(dists, level.maxKm));
      for (const id of ch.players) {
        const a = ch.answers.get(id);
        // `to`: the country's nearest point, where the TV's line from the pin ends.
        answers.push({ pid: id, lon: a?.lon ?? null, lat: a?.lat ?? null, km: dists.get(id) ?? null, to: nearest.get(id) ?? null, right: winners.includes(id) });
      }
    } else {
      const m = ch.kind === "capital" ? this.#names2.capital : this.#names2.country;
      for (const id of ch.players) {
        const a = ch.answers.get(id);
        const text = a?.text ?? "";
        const r = text ? m.read(text) : { ids: [], name: null };
        const right = r.ids.includes(c.id);
        if (right) winners.push(id);
        const as = r.ids.length ? (ch.kind === "capital" ? this.#capitalName(r.ids[0]!, r.name) : this.#byId.get(r.ids[0]!)?.name[this.#lang]) : null;
        answers.push({ pid: id, text, as: as ?? null, right });
      }
    }
    if (!only) for (const w of winners) this.steps.set(w, (this.steps.get(w) ?? 0) + 1);
    const solution = { ...this.card(c) };
    const last = !winners.length && attempt < MAX_TRIES && !only;
    const nx = this.#openNext(party.players.filter((p) => this.steps.has(p.id)).map((p) => p.id));
    party.withTv(() => {
      this.#room({ phase: "round", stage: "answer", kind: ch.kind, solution, winners, band, captain: this.#captain, again: last, tiebreak: !!only, ...this.#nextView(nx) });
      this.#screen({ phase: "round", stage: "answer", kind: ch.kind, solution, answers, winners, band, captain: this.#captain, again: last, tiebreak: only ?? null, try: attempt, ...this.#nextView(nx) });
      for (const p of party.players) {
        if (!this.steps.has(p.id)) continue;
        const mine = answers.find((a) => a["pid"] === p.id) ?? null;
        p.state.replace({ task: "result", kind: ch.kind, right: winners.includes(p.id), solution, mine, winners: winners.map((w) => this.#name(w)), color: this.colorOf(p.id), steps: this.steps.get(p.id) ?? 0, again: last, next: nx.key, ready: false });
      }
    });
    await this.#awaitNext(nx, ch.kind === "where" ? this.timings.revealWhere : this.timings.reveal, signal);
    return winners;
  }

  // -------------------------------------------------------------------------
  // Next: what shows cards or an answer stays until everyone has pressed it.

  /** Asks `who` for Next (their views carry its key). */
  #openNext(who: string[]): NextWait {
    const nx: NextWait = { key: `${this.#game}:${this.#roundNo}:next${++this.#nextNo}`, who, ready: new Set(), by: null, wake: () => {} };
    this.#next = nx;
    return nx;
  }

  /** What the room and the TV show of a wait for Next: its key, who was asked, who pressed, the countdown's end. */
  #nextView(nx: NextWait): Record<string, unknown> {
    return { next: nx.key, nextFor: nx.who, ready: nx.who.filter((id) => nx.ready.has(id)), nextBy: nx.by };
  }

  /** Those asked who are still there and have not pressed. */
  #notReady(nx: NextWait): string[] {
    return nx.who.filter((id) => !nx.ready.has(id) && !!this.party.player(id)?.connected);
  }

  /**
   * Waits at least `minMs` (the TV's animation), then until everyone asked
   * who is there pressed Next, or until the countdown ends: it starts when
   * the first one presses (for the others), or else `timings.next` after
   * the stage opened, less the countdown.
   */
  async #awaitNext(nx: NextWait, minMs: number, signal: AbortSignal): Promise<void> {
    const party = this.party;
    const shownAt = party.now() + minMs;
    await new Promise<void>((resolve) => {
      let shown = false;
      let end: ReturnType<typeof setTimeout> | undefined;
      const done = () => {
        clearTimeout(min);
        clearTimeout(late);
        clearTimeout(end);
        signal.removeEventListener("abort", done);
        nx.wake = () => {};
        resolve();
      };
      const countdown = () => {
        if (nx.by !== null) return;
        const ms = this.timings.nextCountdown;
        nx.by = party.deadline(Math.max(0, shownAt - party.now()) + ms);
        party.room.set({ nextBy: nx.by });
        party.screen.set({ nextBy: nx.by });
        end = setTimeout(done, Math.max(0, nx.by - party.now()));
      };
      nx.wake = () => {
        if (nx.ready.size > 0) countdown();
        if (shown && this.#notReady(nx).length === 0) done();
      };
      const min = setTimeout(() => {
        shown = true;
        nx.wake();
      }, minMs);
      const late = setTimeout(countdown, Math.max(minMs, this.timings.next - this.timings.nextCountdown));
      if (signal.aborted) done();
      else signal.addEventListener("abort", done, { once: true });
    });
    if (this.#next === nx) this.#next = undefined;
  }

  #pressNext(d: Json, from: Sender): null {
    if (from.role !== "player") throw new PartyError("not-player", "Only players go on");
    const nx = this.#next;
    if (!nx) throw new PartyError("not-now", "Nothing to go on from");
    const v = (typeof d === "object" && d !== null && !Array.isArray(d) ? d : {}) as Record<string, Json>;
    if (v["key"] !== undefined && v["key"] !== nx.key) throw new PartyError("not-now", "That is over");
    if (!nx.who.includes(from.id)) throw new PartyError("not-yours", "Not your turn to go on");
    if (!nx.ready.has(from.id)) {
      nx.ready.add(from.id);
      const ready = nx.who.filter((id) => nx.ready.has(id));
      this.party.room.set({ ready });
      this.party.screen.set({ ready });
      this.party.player(from.id)?.state.set({ ready: true });
    }
    nx.wake();
    return null;
  }

  /** How a capital answer reads back: the name typed toward, in the room's language when it is one of the capitals. */
  #capitalName(id: string, matched: string | null): string {
    const c = this.#byId.get(id);
    if (!c) return matched ?? "";
    const l = this.#lang;
    const all = [...c.capitals.en, ...c.capitals.de, ...c.capitalAliases.en, ...c.capitalAliases.de];
    if (matched && c.capitals[l].includes(matched)) return matched;
    const i = matched ? c.capitals.en.indexOf(matched) : -1;
    if (i >= 0 && c.capitals[l][i]) return c.capitals[l][i]!;
    const j = matched ? c.capitals.de.indexOf(matched) : -1;
    if (j >= 0 && c.capitals[l][j]) return c.capitals[l][j]!;
    return matched ?? all[0] ?? "";
  }

  /** A tie at the top after the last round: pins on the map among the tied, until one is closest (at most three). */
  async #tiebreak(signal: AbortSignal): Promise<void> {
    for (let k = 1; k <= MAX_TRIES && !signal.aborted; k++) {
      const top = Math.max(...this.steps.values());
      const tied = [...this.steps].filter(([id, s]) => s === top && this.party.player(id)?.connected).map(([id]) => id);
      if (tied.length < 2) return;
      this.#captain = undefined;
      const won = await this.#challengeOnce(k, signal, tied, "where");
      if (won.length === 1) {
        this.steps.set(won[0]!, (this.steps.get(won[0]!) ?? 0) + 1);
        return;
      }
    }
  }

  #lines(): ScoreLine[] {
    const ids = [...this.steps.keys()];
    return ids
      .map((id) => ({ id, name: this.#name(id), steps: this.steps.get(id) ?? 0, place: this.#place(id).place }))
      .sort((a, b) => a.place - b.place || a.name.localeCompare(b.name));
  }

  #final(): ScoreLine[] {
    const party = this.party;
    const lines = this.#lines();
    party.withTv(() => {
      this.#setPhase("final");
      this.#room({ phase: "final" });
      this.#screen({ phase: "final", places: lines });
      for (const p of party.players) p.state.replace({ ...this.#lobbyState(p), task: "final", won: this.#place(p.id).place === 1 && this.steps.has(p.id) });
    });
    this.emit("end", lines);
    return lines;
  }

  #sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const t = setTimeout(resolve, ms);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          resolve();
        },
        { once: true },
      );
    });
  }
}

/** The settings an action may change, checked. */
export function parseSettings(d: Json): Partial<Settings> {
  if (typeof d !== "object" || d === null || Array.isArray(d)) throw new PartyError("bad-settings", "mode, rounds, difficulty, disputed, map");
  const v = d as Record<string, Json>;
  const o: Partial<Settings> = {};
  for (const k of Object.keys(v)) if (!["mode", "rounds", "difficulty", "disputed", "map"].includes(k)) throw new PartyError("bad-settings", `${k}: not a setting`);
  if (v["mode"] !== undefined) {
    if (!(MODES as readonly Json[]).includes(v["mode"])) throw new PartyError("bad-settings", "mode: cards or quiz");
    o.mode = v["mode"] as Mode;
  }
  if (v["rounds"] !== undefined) {
    if (!(ROUNDS as readonly Json[]).includes(v["rounds"])) throw new PartyError("bad-settings", `rounds: ${ROUNDS.join(", ")}`);
    o.rounds = v["rounds"] as number;
  }
  if (v["difficulty"] !== undefined) {
    if (!(DIFFICULTIES as readonly Json[]).includes(v["difficulty"])) throw new PartyError("bad-settings", "difficulty: easy, normal, hard");
    o.difficulty = v["difficulty"] as Difficulty;
  }
  if (v["disputed"] !== undefined) {
    if (typeof v["disputed"] !== "boolean") throw new PartyError("bad-settings", "disputed: true or false");
    o.disputed = v["disputed"];
  }
  if (v["map"] !== undefined) {
    if (!(MAPS as readonly Json[]).includes(v["map"])) throw new PartyError("bad-settings", "map: flat or globe");
    o.map = v["map"] as MapMode;
  }
  return o;
}

export { STRONG };
