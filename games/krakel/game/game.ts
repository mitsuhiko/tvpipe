/**
 * Krakel on a party, for 3 to 10 players (docs/krakel-design.md): the
 * lobby, then per round one category for the room and a word of it for
 * everyone to draw at once (three to pick from; or, with `mixed`, words
 * from different categories for everyone); then every drawing in turn is redrawn on the
 * TV stroke by stroke, stretched or squeezed to the guess time, while
 * the others type what it is (the sooner, the more points; a wrong
 * guess locks the phone for a moment); then the round's gallery, a heart
 * from everyone for their favourite, and the drawings ranked by how well
 * they were read; the scores; the final podium. The host is the only
 * authority: phones and screens only ever get views.
 *
 * Views:
 * - `party.room` (every phone): `{ phase, lang, langs, late, round, rounds, drawTime, guessTime, hints, lockout, mixed,
 *   minPlayers, colors, category?, deadline?, spot?, got?, stage?, gallery? }` (`langs`: the languages there are
 *   words for; `late`: latecomers, `wait` or `closed`, the party's `lateJoin`; `category`: the round's, or on stage the drawing's;
 *   null while a mixed round draws and in its gallery); `spot` is the drawing on stage: `{ key, index, of, artist,
 *   drawing, start, end, shape, asked }` (`shape`: the word's letters as blanks, with `hints`; `asked`: how many guess),
 *   `got` who named it so far, `reveal` (`word`, `points`) once it is over.
 * - `player.state` (one phone): `{ task, color, score, rank, of, … }`, `task` one of `lobby`, `wait` (a late
 *   joiner), `draw` (`choices`, `categories`: each choice's, `deadline`, `done`), `guess` (`key`, `right`, `points`, `first`,
 *   `lockedUntil`, `tries`), `artist` (`key`, `word`), `result` (`key`, `word`, `mine`, `right`, `points`, …),
 *   `vote` (`own`, `deadline`, `done`, `choice`), `ranked` (`place`, `of`, `points`, `hearts`, `fav`), `scores`
 *   (`earned`, `delta`), `final`
 * - `party.screen` (the TV): `{ phase, lang, colors, … }` per phase, see each method. While drawing `ink` (how
 *   much each one drew, from the phones' continuous input `{ ink }`). Wrong guesses reach the TV as `guess`
 *   messages (`{ id, text }`, or `{ id, close: true }` for a near miss: its text would give the word away).
 *
 * Until its reveal a drawing's word reaches only its artist; the TV and
 * the watch link get it with the reveal.
 */

import { Emitter, PartyError, type Json, type Party, type Player, type Sender } from "@tvpipe/party";

import {
  cleanGuess,
  cardsOf,
  dealMixed,
  dealRound,
  Deck,
  earnedTotal,
  entryPoints,
  favourite,
  guessPoints,
  hasInk,
  judge,
  MIN_PLAYERS,
  POINTS,
  rankEntries,
  scoreRound,
  shapeOf,
  shuffle,
  validateDrawing,
  type Card,
  type Category,
  type Drawing,
  type Earned,
  type Entry,
  type Lang,
  type Word,
} from "./rules.ts";

export interface Timings {
  /** Drawing (the room's setting). */
  draw: number;
  /** Guessing one drawing: its replay fills this (the room's setting). */
  guess: number;
  /** Before a replay starts: whose drawing is next. */
  lead: number;
  /** After a replay: the word, who had it. */
  reveal: number;
  /** The hearts. */
  vote: number;
  /** The drawings ranked. */
  ranked: number;
  scores: number;
}

export const DEFAULT_TIMINGS: Timings = {
  draw: 120_000,
  guess: 45_000,
  lead: 4000,
  reveal: 6500,
  vote: 25_000,
  ranked: 12_000,
  scores: 9000,
};

/** For trying the game: everything short. */
export const FAST_TIMINGS: Timings = {
  draw: 30_000,
  guess: 20_000,
  lead: 3000,
  reveal: 4000,
  vote: 12_000,
  ranked: 7000,
  scores: 5000,
};

/** What the room can pick (seconds). */
export const DRAW_TIMES = [60, 90, 120, 180] as const;
export const GUESS_TIMES = [30, 45, 60, 90] as const;
export const LOCKOUTS = [0, 2, 4, 8] as const;
export const MAX_ROUNDS = 4;
/** Who may join during a game (the party's `lateJoin`): at the next round, or not at all. */
export const LATE_JOINS = ["wait", "closed"] as const;
export type LateJoins = (typeof LATE_JOINS)[number];

/** The room's settings: the host page's, or the VIP's (lobby and final). */
export interface Settings {
  /** Seconds to draw. */
  drawTime: number;
  /** Seconds to guess one drawing (its replay takes that long). */
  guessTime: number;
  /** The easy mode: the word's letters as blanks while guessing. */
  hints: boolean;
  /** Seconds a phone is locked after a wrong guess (0: not at all). */
  lockout: number;
  /** Mixed words: everyone's words come from different categories (off: one category a round). */
  mixed: boolean;
}

/**
 * A fixed first round (the live check's screenshots): the category by
 * its title, each named player's word (a word of the category, or any
 * other), and whose drawings go on stage in which order.
 */
export interface Script {
  category: string;
  words: Record<string, string>;
  order?: string[] | undefined;
}

export interface GameOptions {
  /** The word lists per language (`data/words.txt`, …). */
  words: Partial<Record<Lang, readonly Category[]>>;
  lang?: Lang | undefined;
  rounds?: number | undefined;
  minPlayers?: number | undefined;
  timings?: Partial<Timings> | undefined;
  rng?: (() => number) | undefined;
  hints?: boolean | undefined;
  /** Seconds (tests: a fraction). */
  lockout?: number | undefined;
  mixed?: boolean | undefined;
}

export interface ScoreLine {
  id: string;
  name: string;
  score: number;
  delta: number;
}

export interface GameEvents {
  phase: [phase: Phase];
  end: [scores: ScoreLine[]];
  settings: [settings: Settings];
}

export type Phase = "lobby" | "draw" | "guess" | "gallery" | "scores" | "final";

/** The players' colours (their avatars): one each for ten players. */
export const COLORS = ["#ef476f", "#118ab2", "#f78c1f", "#06a77d", "#8f5bd6", "#e0a100", "#e05cb3", "#3d5a80", "#7cb518", "#c8553d"] as const;

/** The TV's `ink` at most this often, ms. */
export const INK_EVERY = 400;
/** The most `ink` a phone can report. */
export const MAX_INK = 1_000_000;
/** A guess this much before a phone's lock ends still counts (the phones' clocks are a little off), ms. */
export const LOCK_SLACK = 150;
/** After the last guesser had it, before the reveal: the TV shows the tick. */
export const ALL_GOT_PAUSE = 900;

/** What the game itself names, per language. */
const SOMEONE: Record<Lang, string> = { en: "someone", de: "jemand" };

/** A round as it is played. */
interface Round {
  n: number;
  /** The round's category; null in a mixed round (every word has its own). */
  category: Category | null;
  players: Player[];
  /** The words each player picks from, by id. */
  deals: Map<string, Card[]>;
  /** One per player, once the drawings are in. */
  entries: Entry[];
  /** The artists whose drawings go on stage, in that order (ids). */
  order: string[];
  /** Hearts: voter id → artist id. */
  votes: Map<string, string>;
}

/** The drawing on stage. */
interface Spot {
  entry: Entry;
  key: string;
  start: number;
  end: number;
  stage: "guess" | "reveal";
  /** Until when each guesser is locked, by id. */
  locked: Map<string, number>;
  tries: Map<string, number>;
  /** Ends the guessing when every guesser who is there has it. */
  check: () => void;
}

export class Krakel extends Emitter<GameEvents> {
  readonly party: Party;
  rounds: number;
  readonly minPlayers: number;
  timings: Timings;
  /** A fixed first round for the next game (then cleared). */
  script: Script | undefined;
  readonly #rng: () => number;
  readonly #words = new Map<Lang, readonly Category[]>();
  /** Every word of a language (the matcher: a slip never turns one word into another). */
  readonly #all = new Map<Lang, Word[]>();
  /** The room's category decks by language, kept from game to game. */
  readonly #decks = new Map<Lang, Deck<Category>>();
  #lang: Lang;
  #hints: boolean;
  #lockout: number;
  #mixed: boolean;
  /** The room's word decks for mixed rounds by language, kept from game to game. */
  readonly #cards = new Map<Lang, Deck<Card>>();
  /** Each player's colour (an index of {@link COLORS}), by id. */
  readonly #colors = new Map<string, number>();
  /** Names by id, kept after a player left (drawings still name them). */
  readonly #names = new Map<string, string>();
  /** Points per player id (players in the game). */
  readonly scores = new Map<string, number>();
  #phase: Phase = "lobby";
  #running = false;
  #abort = new AbortController();
  /** The game being played: a game's flow writes nothing once another (or the lobby, after {@link close}) took over. */
  #game = 0;
  #roundNo = 0;
  #round: Round | undefined;
  #spot: Spot | undefined;
  /** The last round's points by kind (the scores). */
  #earned = new Map<string, Earned>();
  /** The game's points by kind (the awards). */
  #totals = new Map<string, Earned>();
  /** The game's clearest drawing so far. */
  #best: { entry: Entry; points: number; category: string } | undefined;
  /** While drawing: how much each drawer drew (their phone's `ink`), and the TV's update to come. */
  #ink: Map<string, number> | undefined;
  #inkTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(party: Party, options: GameOptions) {
    super();
    this.party = party;
    this.rounds = options.rounds ?? 2;
    this.minPlayers = options.minPlayers ?? MIN_PLAYERS;
    this.timings = { ...DEFAULT_TIMINGS, ...options.timings };
    this.#rng = options.rng ?? Math.random;
    this.#lang = options.lang ?? "en";
    for (const [l, list] of Object.entries(options.words) as [Lang, readonly Category[]][]) {
      if (list.length === 0) continue;
      this.#words.set(l, list);
      this.#all.set(
        l,
        list.flatMap((c) => c.words),
      );
    }
    if (!this.#words.has(this.#lang)) throw new Error(`krakel: no words in ${this.#lang}`);
    this.#hints = options.hints ?? true;
    this.#lockout = options.lockout ?? 4;
    this.#mixed = options.mixed ?? false;
  }

  get settings(): Settings {
    return { drawTime: this.timings.draw / 1000, guessTime: this.timings.guess / 1000, hints: this.#hints, lockout: this.#lockout, mixed: this.#mixed };
  }

  get phase(): Phase {
    return this.#phase;
  }

  get running(): boolean {
    return this.#running;
  }

  get lang(): Lang {
    return this.#lang;
  }

  /** The languages there are words for. */
  get langs(): Lang[] {
    return [...this.#words.keys()];
  }

  /** Who may join during a game: the party's `lateJoin` as one of {@link LATE_JOINS} (`open` reads as `wait`). */
  get late(): LateJoins {
    return this.party.lateJoin === "closed" ? "closed" : "wait";
  }

  /** The round being played (tests: the words, the drawings). */
  get round(): Readonly<Round> | undefined {
    return this.#round;
  }

  /**
   * The word of the drawing a player is guessing now (the bots' oracle
   * in the host page and the tests; never sent to a phone).
   */
  meant(id: string): Word | undefined {
    const s = this.#spot;
    return s && s.stage === "guess" && s.entry.guessers.includes(id) ? s.entry.word : undefined;
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
      const keys = ["lang", "late", "rounds", "drawTime", "guessTime", "hints", "lockout", "mixed"];
      if (typeof d !== "object" || d === null || Array.isArray(d)) throw new PartyError("bad-settings", keys.join(", "));
      const v = d as Record<string, Json>;
      for (const k of Object.keys(v)) if (!keys.includes(k)) throw new PartyError("bad-settings", `${k}: not a setting`);
      const o: Partial<Settings> & { rounds?: number; lang?: Lang; late?: LateJoins } = {};
      const word = <T extends string>(key: "lang" | "late", list: readonly T[]): T | undefined => {
        if (v[key] === undefined) return undefined;
        if (!list.includes(v[key] as T)) throw new PartyError("bad-settings", `${key}: ${list.join(", ")}`);
        return v[key] as T;
      };
      o.lang = word("lang", this.langs);
      o.late = word("late", LATE_JOINS);
      const oneOf = (key: "drawTime" | "guessTime" | "lockout" | "rounds", list: readonly number[]) => {
        if (v[key] === undefined) return;
        if (!list.includes(v[key] as number)) throw new PartyError("bad-settings", `${key}: ${list.join(", ")}`);
        o[key] = v[key] as number;
      };
      oneOf("drawTime", DRAW_TIMES);
      oneOf("guessTime", GUESS_TIMES);
      oneOf("lockout", LOCKOUTS);
      oneOf(
        "rounds",
        Array.from({ length: MAX_ROUNDS }, (_, i) => i + 1),
      );
      for (const key of ["hints", "mixed"] as const) {
        if (v[key] === undefined) continue;
        if (typeof v[key] !== "boolean") throw new PartyError("bad-settings", `${key}: true or false`);
        o[key] = v[key];
      }
      this.configure(o);
      return null;
    });
    party.handle("guess", (d, from) => this.#guess(d, from));
    party.on("input", (p, data) => this.#input(p, data));
    party.on("join", (p) => {
      this.#names.set(p.id, p.name);
      this.#colors.set(p.id, this.#freeColor());
      this.#colorsChanged();
      if (!this.#running) p.state.replace(this.#lobbyState(p));
      else p.state.replace(this.#waitState(p));
    });
    party.on("leave", (p) => {
      this.#colors.delete(p.id);
      this.#colorsChanged();
      this.#spot?.check();
    });
    party.on("away", () => this.#spot?.check());
    this.#lobby();
  }

  /**
   * Changes the rounds, the timers, the language, the latecomers or the
   * settings before a game; every phone and the TV follow.
   */
  configure(o: { rounds?: number | undefined; timings?: Partial<Timings> | undefined; lang?: Lang | undefined; late?: LateJoins | undefined } & { [K in keyof Settings]?: Settings[K] | undefined }): void {
    if (this.#running) throw new PartyError("running", "Not during a game");
    if (o.lang !== undefined && !this.langs.includes(o.lang)) throw new PartyError("bad-lang", `Nothing to play in ${o.lang}`);
    if (o.late !== undefined && !LATE_JOINS.includes(o.late)) throw new PartyError("bad-late", `Latecomers: ${LATE_JOINS.join(", ")}`);
    const was = JSON.stringify([this.#lang, this.late, this.rounds, this.settings]);
    if (o.rounds !== undefined) this.rounds = Math.max(1, Math.min(MAX_ROUNDS, Math.round(o.rounds)));
    if (o.timings) this.timings = { ...this.timings, ...o.timings };
    if (o.lang !== undefined) this.#lang = o.lang;
    if (o.late !== undefined) this.party.lateJoin = o.late;
    if (o.drawTime !== undefined && o.drawTime > 0) this.timings.draw = o.drawTime * 1000;
    if (o.guessTime !== undefined && o.guessTime > 0) this.timings.guess = o.guessTime * 1000;
    if (o.hints !== undefined) this.#hints = o.hints;
    if (o.mixed !== undefined) this.#mixed = o.mixed;
    if (o.lockout !== undefined && o.lockout >= 0) this.#lockout = o.lockout;
    if (this.#phase === "lobby" || this.#phase === "final") {
      this.party.room.set({ lang: this.#lang, late: this.late, rounds: this.rounds, ...this.settings });
      this.party.screen.set({ lang: this.#lang, rounds: this.rounds, ...this.settings });
    }
    if (JSON.stringify([this.#lang, this.late, this.rounds, this.settings]) !== was) this.emit("settings", this.settings);
  }

  /**
   * Ends a running game and its timers (the party stays): the lobby is
   * back at once (no final screen: closing is not finishing), waiting
   * players are in, and nothing of the old game writes after this
   * returns. A later {@link play} starts a fresh game.
   */
  close(): void {
    if (!this.#running) return;
    this.#game++;
    this.#abort.abort();
    this.#stop();
    this.#lobby();
  }

  /** What ends a game, played out or closed: no round, no timers, nobody waiting. */
  #stop(): void {
    const party = this.party;
    clearTimeout(this.#inkTimer);
    this.#inkTimer = undefined;
    this.#round = undefined;
    this.#spot = undefined;
    this.#ink = undefined;
    this.#running = false;
    party.inProgress = false;
    for (const p of party.players) party.activate(p);
  }

  // -------------------------------------------------------------------------
  // Views

  #setPhase(phase: Phase): void {
    this.#phase = phase;
    this.emit("phase", phase);
  }

  #freeColor(): number {
    const used = COLORS.map(() => 0);
    for (const p of this.party.players) {
      const c = this.#colors.get(p.id);
      if (c !== undefined) used[c]!++;
    }
    return used.indexOf(Math.min(...used));
  }

  /** Everybody's colour, by id. */
  #colorMap(): Record<string, string> {
    return Object.fromEntries(this.party.players.map((p) => [p.id, COLORS[this.colorOf(p.id)]!]));
  }

  #colorsChanged(): void {
    const colors = this.#colorMap();
    this.party.room.set({ colors });
    if (this.#phase === "lobby" || this.#phase === "final") this.party.screen.set({ colors });
  }

  #name(id: string): string {
    return this.party.player(id)?.name ?? this.#names.get(id) ?? SOMEONE[this.#lang];
  }

  #who(id: string): { id: string; name: string; color: string } {
    return { id, name: this.#name(id), color: COLORS[this.colorOf(id)]! };
  }

  #rank(p: Player | undefined): { score: number; rank: number; of: number } {
    const scores = [...this.scores].filter(([id]) => this.party.player(id)).map(([, s]) => s);
    const s = p ? (this.scores.get(p.id) ?? 0) : 0;
    return { score: s, rank: 1 + scores.filter((x) => x > s).length, of: scores.length };
  }

  /** What every phone of a game carries: the colour, the score. */
  #mine(p: Player): Record<string, unknown> {
    return { color: this.colorOf(p.id), ...this.#rank(this.scores.has(p.id) ? p : undefined) };
  }

  #lobbyState(p: Player): Record<string, unknown> {
    return { task: this.#phase === "final" ? "final" : "lobby", ...this.#mine(p) };
  }

  #waitState(p: Player): Record<string, unknown> {
    return { task: "wait", note: this.#roundNo < this.rounds ? "round" : "game", color: this.colorOf(p.id) };
  }

  #room(fields: Record<string, unknown>): void {
    this.party.room.replace({ lang: this.#lang, langs: this.langs, late: this.late, round: this.#roundNo, rounds: this.rounds, ...this.settings, minPlayers: this.minPlayers, colors: this.#colorMap(), ...fields });
  }

  #screen(fields: Record<string, unknown>): void {
    this.party.screen.replace({ lang: this.#lang, colors: this.#colorMap(), round: this.#roundNo, rounds: this.rounds, ...fields });
  }

  #lobby(): void {
    const party = this.party;
    this.#setPhase("lobby");
    this.#room({ phase: "lobby", maxPlayers: party.maxPlayers });
    this.#screen({ phase: "lobby", minPlayers: this.minPlayers, maxPlayers: party.maxPlayers, ...this.settings });
    for (const p of party.players) p.state.replace(this.#lobbyState(p));
  }

  /** The players of the game who are not in `ids` wait (late joiners). */
  #others(ids: ReadonlySet<string>): void {
    for (const p of this.party.players) if (!ids.has(p.id)) p.state.replace(this.#waitState(p));
  }

  // -------------------------------------------------------------------------
  // A game

  /**
   * Plays a whole game with the players who are there (and those who
   * join). It ends early, to the final screen, when fewer than
   * {@link minPlayers} are left in it at the start of a round (a phone
   * that is only away still counts). Closed ({@link close}), it returns
   * the scores so far and shows nothing.
   */
  async play(): Promise<ScoreLine[]> {
    const party = this.party;
    const game = ++this.#game;
    this.#running = true;
    this.#abort = new AbortController();
    const signal = this.#abort.signal;
    party.inProgress = true;
    this.scores.clear();
    this.#totals.clear();
    this.#best = undefined;
    try {
      for (let r = 1; r <= this.rounds; r++) {
        this.#roundNo = r;
        for (const p of party.players) {
          if (p.waiting) party.activate(p);
          if (!this.scores.has(p.id)) this.scores.set(p.id, 0);
        }
        const players = party.players.filter((p) => this.scores.has(p.id));
        if (players.length < this.minPlayers) break;
        const before = new Map(this.scores);
        await this.#playRound(r, players, signal);
        if (signal.aborted) break;
        await this.#scores(r, before, signal);
        if (signal.aborted) break;
      }
      return signal.aborted ? this.#table() : this.#final();
    } finally {
      if (this.#game === game) this.#stop();
    }
  }

  #deck(): Deck<Category> {
    let d = this.#decks.get(this.#lang);
    if (!d) this.#decks.set(this.#lang, (d = new Deck(this.#words.get(this.#lang)!, this.#rng)));
    return d;
  }

  /**
   * The words of a round: one category and a few of its words for
   * everyone, or (mixed) words from different categories for everyone;
   * or the script's (round 1, always one category).
   */
  #deal(n: number, players: Player[]): { category: Category | null; deals: Map<string, Card[]>; order: string[] | undefined } {
    const script = n === 1 ? this.script : undefined;
    if (n === 1) this.script = undefined;
    const list = this.#words.get(this.#lang)!;
    if (this.#mixed && !script) {
      let deck = this.#cards.get(this.#lang);
      if (!deck) this.#cards.set(this.#lang, (deck = new Deck(cardsOf(list), this.#rng)));
      const dealt = dealMixed(deck, players.length, this.#lang);
      return { category: null, deals: new Map(players.map((p, i) => [p.id, dealt[i]!])), order: undefined };
    }
    const scripted = script ? (list.find((c) => c.title === script.category) ?? { title: script.category, words: [] }) : undefined;
    const drawn = scripted && scripted.words.length >= players.length ? scripted : this.#deck().draw((c) => c.words.length >= players.length);
    const category = scripted ? { ...drawn, title: scripted.title } : drawn;
    const dealt = dealRound(drawn, players.length, this.#rng);
    const deals = new Map(players.map((p, i) => [p.id, dealt[i]!.map((word) => ({ word, category: category.title }))]));
    if (!script) return { category, deals, order: undefined };
    for (const p of players) {
      const w = script.words[p.name];
      if (w !== undefined) deals.set(p.id, [{ word: drawn.words.find((x) => x.word === w) ?? { word: w, also: [] }, category: category.title }]);
    }
    const order = script.order?.flatMap((name) => players.find((p) => p.name === name)?.id ?? []);
    return { category, deals, order };
  }

  async #playRound(n: number, players: Player[], signal: AbortSignal): Promise<void> {
    const { category, deals, order } = this.#deal(n, players);
    const round: Round = { n, category, players, deals, entries: [], order: [], votes: new Map() };
    this.#round = round;
    await this.#draw(round, signal);
    if (signal.aborted) return;
    const shown = round.entries.filter((e) => e.shown).map((e) => e.by);
    const fixed = (order ?? []).filter((id) => shown.includes(id));
    round.order = [...fixed, ...shuffle(shown.filter((id) => !fixed.includes(id)), this.#rng)];
    for (let i = 0; i < round.order.length; i++) {
      const entry = round.entries.find((e) => e.by === round.order[i])!;
      // Whoever left for good takes their drawing with them.
      if (!this.party.player(entry.by)) {
        entry.shown = false;
        continue;
      }
      await this.#stage(round, entry, i, round.order.length, signal);
      if (signal.aborted) return;
    }
    await this.#gallery(round, signal);
  }

  // -------------------------------------------------------------------------
  // Drawing

  async #draw(r: Round, signal: AbortSignal): Promise<void> {
    const party = this.party;
    this.#setPhase("draw");
    const deadline = party.deadline(this.timings.draw);
    // Null in a mixed round: every word shows its own category.
    const category = r.category?.title ?? null;
    const ids = new Set(r.players.map((p) => p.id));
    this.#ink = new Map(r.players.map((p) => [p.id, 0]));
    party.withTv(() => {
      this.#room({ phase: "draw", category, deadline });
      this.#screen({ phase: "draw", category, deadline, duration: this.timings.draw, players: r.players.map((p) => this.#who(p.id)), done: [], ink: {} });
      for (const p of r.players) {
        const cards = r.deals.get(p.id)!;
        p.state.replace({ task: "draw", choices: cards.map((c) => c.word.word), categories: cards.map((c) => c.category), deadline, done: false, ...this.#mine(p) });
      }
      this.#others(ids);
    });
    const done = new Set<string>();
    const got = await party.collect<{ drawing: Drawing; choice: number }>("draw", {
      from: r.players,
      until: deadline,
      signal,
      validate: (d, p) => {
        const drawing = validateDrawing(d);
        const n = r.deals.get(p.id)!.length;
        const choice = (d as { choice?: unknown }).choice ?? 0;
        if (typeof choice !== "number" || !Number.isInteger(choice) || choice < 0 || choice >= n) throw new PartyError("no-choice", "Pick a word");
        return { drawing, choice };
      },
      onAnswer: (p) => {
        done.add(p.id);
        p.state.set({ done: true });
        party.screen.set({ done: [...done] });
      },
    });
    if (signal.aborted) return;
    clearTimeout(this.#inkTimer);
    this.#inkTimer = undefined;
    this.#ink = undefined;
    r.entries = r.players.map((p) => {
      const a = got.get(p);
      const drawing = a?.drawing ?? { strokes: [] };
      const card = r.deals.get(p.id)![a?.choice ?? 0]!;
      return { by: p.id, word: card.word, category: card.category, drawing, guessers: [], hits: [], shown: hasInk(drawing) };
    });
  }

  #input(p: Player, data: Json): void {
    if (typeof data !== "object" || data === null || Array.isArray(data)) return;
    const ink = data["ink"];
    if (!this.#ink?.has(p.id) || typeof ink !== "number" || !Number.isFinite(ink)) return;
    this.#ink.set(p.id, Math.round(Math.min(MAX_INK, Math.max(0, ink))));
    this.#inkTimer ??= setTimeout(() => {
      this.#inkTimer = undefined;
      if (this.#ink && this.#phase === "draw") this.party.screen.set({ ink: Object.fromEntries(this.#ink) });
    }, INK_EVERY);
  }

  // -------------------------------------------------------------------------
  // A drawing on stage: its replay, the guesses, the reveal

  async #stage(r: Round, entry: Entry, index: number, of: number, signal: AbortSignal): Promise<void> {
    const party = this.party;
    this.#setPhase("guess");
    const guessers = r.players.filter((p) => p.id !== entry.by && party.player(p.id));
    entry.guessers = guessers.map((p) => p.id);
    const start = party.deadline(this.timings.lead);
    const end = start + this.timings.guess;
    const key = `${r.n}:${index + 1}`;
    // The drawing's own category: in a mixed round another one for each.
    const category = entry.category;
    const artist = this.#who(entry.by);
    const view = { key, index: index + 1, of, artist, drawing: entry.drawing, start, end, shape: this.#hints ? shapeOf(entry.word.word) : null, asked: guessers.length };
    let finish = () => {};
    const over = new Promise<void>((resolve) => (finish = resolve));
    let pause: ReturnType<typeof setTimeout> | undefined;
    const spot: Spot = {
      entry,
      key,
      start,
      end,
      stage: "guess",
      locked: new Map(),
      tries: new Map(),
      check: () => {
        const there = entry.guessers.filter((id) => party.player(id)?.connected);
        if (pause || there.length === 0 || !there.every((id) => entry.hits.some((h) => h.by === id))) return;
        pause = setTimeout(finish, Math.min(ALL_GOT_PAUSE, this.timings.reveal));
      },
    };
    this.#spot = spot;
    party.withTv(() => {
      this.#room({ phase: "guess", category, spot: view, got: [] });
      this.#screen({ phase: "guess", stage: "guess", category, ...view, guessers: guessers.map((p) => this.#who(p.id)), got: [], lockout: this.#lockout });
      for (const p of guessers) p.state.replace({ task: "guess", key, right: false, points: 0, first: false, lockedUntil: 0, tries: 0, ...this.#mine(p) });
      const a = party.player(entry.by);
      a?.state.replace({ task: "artist", key, word: entry.word.word, ...this.#mine(a) });
      this.#others(new Set(r.players.map((p) => p.id)));
    });
    const timer = setTimeout(finish, Math.max(0, end + party.grace - party.now()));
    signal.addEventListener("abort", finish, { once: true });
    await over;
    clearTimeout(timer);
    clearTimeout(pause);
    signal.removeEventListener("abort", finish);
    if (signal.aborted) return;

    // The reveal: the word, who had it, what it pays.
    spot.stage = "reveal";
    entry.hits.sort((a, b) => a.at - b.at);
    const points = entryPoints(entry);
    const add = (id: string, n: number, kind: keyof Earned) => {
      if (this.scores.has(id)) this.scores.set(id, (this.scores.get(id) ?? 0) + n);
      let t = this.#totals.get(id);
      if (!t) this.#totals.set(id, (t = { drawn: 0, guessed: 0, first: 0, favourite: 0 }));
      t[kind] += n;
    };
    add(entry.by, points, "drawn");
    for (const h of entry.hits) {
      add(h.by, h.points, "guessed");
      if (h.first) add(h.by, POINTS.first, "first");
    }
    if (!this.#best || points > this.#best.points) this.#best = { entry, points, category };
    const word = entry.word.word;
    const got = entry.hits.map((h) => ({ id: h.by, points: h.points + (h.first ? POINTS.first : 0), first: h.first }));
    party.withTv(() => {
      party.room.set({ reveal: { word, points } });
      party.screen.set({ stage: "reveal", word, points, got });
      for (const p of guessers) {
        if (!party.player(p.id)) continue;
        const h = entry.hits.find((x) => x.by === p.id);
        p.state.replace({ task: "result", key, word, mine: false, artist: artist.name, right: !!h, points: h ? h.points + (h.first ? POINTS.first : 0) : 0, first: !!h?.first, ...this.#mine(p) });
      }
      const a = party.player(entry.by);
      a?.state.replace({ task: "result", key, word, mine: true, points, got: entry.hits.length, guessers: entry.guessers.length, ...this.#mine(a) });
    });
    await this.#sleep(this.timings.reveal, signal);
    if (this.#spot === spot) this.#spot = undefined;
  }

  /** A typed guess at the drawing on stage. */
  #guess(d: Json, from: Sender): unknown {
    const spot = this.#spot;
    const data = typeof d === "object" && d !== null && !Array.isArray(d) ? d : {};
    if (from.role !== "player") throw new PartyError("not-player", "Players only");
    if (!spot || spot.stage !== "guess" || data["key"] !== spot.key) throw new PartyError("not-now", "Nothing to guess now");
    const { entry } = spot;
    if (from.id === entry.by) throw new PartyError("own-drawing", "Not your own drawing");
    if (!entry.guessers.includes(from.id)) throw new PartyError("not-asked", "Not your turn");
    if (entry.hits.some((h) => h.by === from.id)) throw new PartyError("already", "You have it already");
    // The host's clock, when the guess arrives: over a replay of half a
    // minute a phone's few ms on the way cost a point or two, and no
    // phone's own clock is taken at its word.
    const party = this.party;
    const at = party.now();
    if (at < spot.start) throw new PartyError("not-yet", "Not yet");
    if (at < (spot.locked.get(from.id) ?? 0) - LOCK_SLACK) throw new PartyError("locked", "Wait a moment");
    const text = cleanGuess(data["text"]);
    if (!text) throw new PartyError("empty", "Write a guess");
    const verdict = judge(text, entry.word, this.#lang, this.#all.get(this.#lang));
    if (verdict === "right") {
      const share = Math.max(0, Math.min(1, (at - spot.start) / Math.max(1, spot.end - spot.start)));
      const points = guessPoints(share);
      const first = entry.hits.length === 0;
      entry.hits.push({ by: from.id, at: share, points, first });
      const total = points + (first ? POINTS.first : 0);
      from.state.set({ right: true, points: total, first });
      party.room.set({ got: entry.hits.map((h) => h.by) });
      party.withTv(() => party.screen.set({ got: entry.hits.map((h) => ({ id: h.by, points: h.points + (h.first ? POINTS.first : 0), first: h.first })) }));
      queueMicrotask(spot.check);
      return { verdict, points: total, first };
    }
    const tries = (spot.tries.get(from.id) ?? 0) + 1;
    spot.tries.set(from.id, tries);
    const lockedUntil = this.#lockout > 0 ? at + this.#lockout * 1000 : 0;
    spot.locked.set(from.id, lockedUntil);
    from.state.set({ lockedUntil, tries });
    // The TV shows what was tried; a near miss would give the word away.
    const shown = verdict === "close" ? false : party.moderate(text, "guess", from);
    const msg = shown === false ? { id: from.id, close: verdict === "close" } : { id: from.id, text: shown };
    party.withTv(() => {
      party.broadcast("guess", msg, "screen");
      party.broadcast("guess", msg, "watch");
    });
    return { verdict, lockedUntil };
  }

  // -------------------------------------------------------------------------
  // The gallery: a heart for the favourite, then the drawings ranked

  async #gallery(r: Round, signal: AbortSignal): Promise<void> {
    const party = this.party;
    const shown = r.order.map((id) => r.entries.find((e) => e.by === id)!).filter((e) => e.shown);
    if (shown.length === 0) {
      this.#earned = scoreRound(r.entries, r.votes);
      return;
    }
    this.#setPhase("gallery");
    const category = r.category?.title ?? null;
    const gallery = shown.map((e) => ({ id: e.by, artist: this.#who(e.by), word: e.word.word, drawing: e.drawing }));
    const ids = new Set(r.players.map((p) => p.id));
    // A heart needs two drawings to choose from that are not one's own.
    const voters = r.players.filter((p) => party.player(p.id) && shown.filter((e) => e.by !== p.id).length >= 2);
    if (voters.length > 0) {
      const deadline = party.deadline(this.timings.vote);
      party.withTv(() => {
        this.#room({ phase: "gallery", stage: "vote", category, deadline, gallery });
        this.#screen({ phase: "gallery", stage: "vote", category, deadline, duration: this.timings.vote, gallery, voters: voters.map((p) => this.#who(p.id)), done: [] });
        for (const p of r.players) {
          if (!party.player(p.id)) continue;
          if (voters.includes(p)) p.state.replace({ task: "vote", own: shown.some((e) => e.by === p.id) ? p.id : null, deadline, done: false, choice: null, ...this.#mine(p) });
          else p.state.replace({ task: "vote", own: p.id, deadline, done: true, choice: null, ...this.#mine(p) });
        }
        this.#others(ids);
      });
      const votes = await party.collect<string>("vote", {
        from: voters,
        until: deadline,
        signal,
        validate: (d, p) => {
          const id = typeof d === "object" && d !== null && !Array.isArray(d) ? (d as { id?: unknown }).id : d;
          if (typeof id !== "string" || !shown.some((e) => e.by === id)) throw new PartyError("bad-vote", "Pick a drawing");
          if (id === p.id) throw new PartyError("own-drawing", "Not your own");
          return id;
        },
        onAnswer: (p, id, got) => {
          p.state.set({ done: true, choice: id });
          party.screen.set({ done: [...got.keys()].map((x) => x.id) });
        },
      });
      if (signal.aborted) return;
      r.votes = new Map([...votes].map(([p, id]) => [p.id, id]));
    }
    const fav = favourite(r.votes);
    for (const id of fav.ids) {
      if (this.scores.has(id)) this.scores.set(id, (this.scores.get(id) ?? 0) + fav.points);
      const t = this.#totals.get(id);
      if (t) t.favourite += fav.points;
    }
    this.#earned = scoreRound(r.entries, r.votes);
    const hearts = new Map<string, number>();
    for (const id of r.votes.values()) hearts.set(id, (hearts.get(id) ?? 0) + 1);
    const ranking = rankEntries(shown).map(({ entry, place, points }) => ({
      id: entry.by,
      place,
      points,
      got: entry.hits.length,
      of: entry.guessers.length,
      hearts: hearts.get(entry.by) ?? 0,
      fav: fav.ids.includes(entry.by) ? fav.points : 0,
    }));
    party.withTv(() => {
      this.#room({ phase: "gallery", stage: "ranked", category, gallery });
      this.#screen({ phase: "gallery", stage: "ranked", category, gallery, ranking });
      for (const p of r.players) {
        if (!party.player(p.id)) continue;
        const line = ranking.find((x) => x.id === p.id);
        const word = r.entries.find((e) => e.by === p.id)?.word.word ?? "";
        p.state.replace({ task: "ranked", word, place: line?.place ?? null, drawings: ranking.length, points: line?.points ?? 0, hearts: line?.hearts ?? 0, fav: line?.fav ?? 0, ...this.#mine(p) });
      }
      this.#others(ids);
    });
    await this.#sleep(this.timings.ranked, signal);
  }

  // -------------------------------------------------------------------------
  // Scores and the end

  #table(before?: ReadonlyMap<string, number>): ScoreLine[] {
    return this.party.players
      .filter((p) => this.scores.has(p.id))
      .map((p) => {
        const s = this.scores.get(p.id) ?? 0;
        return { id: p.id, name: p.name, score: s, delta: s - (before?.get(p.id) ?? s) };
      })
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  }

  async #scores(round: number, before: ReadonlyMap<string, number>, signal: AbortSignal): Promise<void> {
    const party = this.party;
    this.#setPhase("scores");
    const lines = this.#table(before).map((l) => ({ ...l, earned: this.#earned.get(l.id) ?? null }));
    party.withTv(() => {
      this.#room({ phase: "scores" });
      this.#screen({ phase: "scores", lines, last: round >= this.rounds });
      for (const p of party.players) {
        if (!this.scores.has(p.id)) {
          p.state.replace(this.#waitState(p));
          continue;
        }
        const line = lines.find((l) => l.id === p.id);
        p.state.replace({ task: "scores", earned: line?.earned ?? null, delta: line?.delta ?? 0, ...this.#mine(p) });
      }
    });
    await this.#sleep(this.timings.scores, signal);
  }

  #final(): ScoreLine[] {
    const party = this.party;
    this.#round = undefined;
    this.#spot = undefined;
    this.#setPhase("final");
    const table = this.#table();
    // The awards: the game's clearest drawing, and the sharpest eye (the most points for guessing).
    const best = this.#best && this.#best.points > 0 ? { artist: this.#who(this.#best.entry.by), word: this.#best.entry.word.word, drawing: this.#best.entry.drawing, points: this.#best.points, category: this.#best.category } : null;
    const eyes = [...this.#totals].filter(([id]) => party.player(id)).map(([id, t]) => ({ id, points: t.guessed + t.first }));
    const top = Math.max(0, ...eyes.map((e) => e.points));
    const eye = top > 0 ? { who: this.#who(eyes.find((e) => e.points === top)!.id), points: top } : null;
    party.withTv(() => {
      this.#room({ phase: "final", maxPlayers: party.maxPlayers });
      this.#screen({ phase: "final", lines: table, best, eye, ...this.settings });
      for (const p of party.players) p.state.replace({ task: "final", ...this.#mine(p) });
    });
    this.emit("end", table);
    return table;
  }

  // -------------------------------------------------------------------------

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

export { earnedTotal };
