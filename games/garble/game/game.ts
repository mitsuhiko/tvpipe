/**
 * Garble on a party, for 3 to 12 players (docs/garble-design.md): the
 * lobby, then per round one picture per player passed seat to seat (the
 * first player picks a word and draws it; each next one guesses what it
 * is now, then draws the word they are dealt on top), the reveal (each
 * picture rebuilt on the TV layer by layer, with every guess judged),
 * the vote for the best move, the scores; the final podium. The host is
 * the only authority: phones and screens only ever get views.
 *
 * Views:
 * - `party.room` (every phone): `{ phase, lang, langs, round, rounds, length, undo, timers, late, minPlayers, colors, step?, steps?, deadline?, gallery? }`
 * - `player.state` (one phone): `{ task, color, score, rank, of, … }`, `task` one of
 *   `lobby`, `wait` (a late joiner), `draw` (`picture`: the old ink, `word` or `choices`, `undo`,
 *   `deadline`, `done`, `next`), `guess` (`picture`, `from`, `deadline`, `last`, `done`), `watch`
 *   (`starter`, `index`, `of`, `mine`), `vote` (`mine`, `deadline`, `done`, `choice`), `best`
 *   (`won`, `points`), `scores` (`earned`, `delta`), `final`
 * - `party.screen` (the TV): `{ phase, lang, colors, … }` per phase, see each method.
 *
 * Until the reveal, a layer's word reaches only its drawer, a guess only
 * its writer, and the picture of a step only the player at that step
 * (as one ink: which strokes are new does not show).
 *
 * The TV is behind the phones (docs/games.md): what the TV shows (a new
 * phase, a step of the reveal, the best move, the scores) is set inside
 * `party.withTv`, so phones get it when the TV picture with it is up,
 * and deadlines count from then (`party.deadline`).
 */

import { Emitter, PartyError, type Json, type LateJoin, type Party, type Player } from "@tvpipe/party";

import {
  bestMove,
  cleanGuess,
  dealPicture,
  Deck,
  earnedTotal,
  flatten,
  guessAt,
  layerCount,
  layerId,
  layerPoints,
  LENGTHS,
  MIN_PLAYERS,
  pictureAt,
  scoreRound,
  shuffle,
  validateDrawing,
  type Drawing,
  type Earned,
  type Guess,
  type Lang,
  type Picture,
  type Word,
} from "./rules.ts";

export interface Timings {
  /** The first step: pick a word, draw it. */
  firstDraw: number;
  /** A step's guess, then its drawing (the step lasts both). */
  guess: number;
  draw: number;
  /** The reveal on the TV: a layer drawing itself, then its guess, then the whole picture. */
  layer: number;
  read: number;
  legend: number;
  /** The best-move vote, its result, the scores. */
  vote: number;
  best: number;
  scores: number;
}

export const DEFAULT_TIMINGS: Timings = {
  firstDraw: 60_000,
  guess: 20_000,
  draw: 60_000,
  layer: 3000,
  read: 2200,
  legend: 3600,
  vote: 30_000,
  best: 8000,
  scores: 11_000,
};

export const FAST_TIMINGS: Timings = {
  firstDraw: 45_000,
  guess: 15_000,
  draw: 40_000,
  layer: 2500,
  read: 1700,
  legend: 2600,
  vote: 20_000,
  best: 6500,
  scores: 8000,
};

/** The timers' choices: {@link DEFAULT_TIMINGS} or {@link FAST_TIMINGS}. */
export const PACES = ["normal", "fast"] as const;
export type Pace = (typeof PACES)[number];

/** Who may join during a game (the host page's late-join field, the VIP's phone): from the next round, or nobody. */
export const LATE_JOIN = ["wait", "closed"] as const satisfies readonly LateJoin[];

/** The rounds' choices. */
export const ROUNDS = [1, 2, 3, 4] as const;

/** The room's settings: the host page's, or the VIP's in the lobby. */
export interface Settings {
  /** Undo (and clear) of your own strokes on the pad; off: every stroke counts. */
  undo: boolean;
  /** Layers per picture (3, 5, 7), at most one less than the players. */
  length: number;
}

/**
 * A fixed first round (the live check's screenshots, `test/live/scenario.ts`):
 * the seats by name, each picture's words (two to pick from, then one
 * per further layer; words not in the list have no synonyms), and the
 * picture the reveal starts with.
 */
export interface Script {
  seats: string[];
  pictures: { choices: [string, string]; words: string[] }[];
  first?: number | undefined;
}

export interface GameOptions {
  /** The word lists per language (`data/words.txt`, …). */
  words: Partial<Record<Lang, readonly Word[]>>;
  lang?: Lang | undefined;
  rounds?: number | undefined;
  minPlayers?: number | undefined;
  timings?: Partial<Timings> | undefined;
  rng?: (() => number) | undefined;
  undo?: boolean | undefined;
  length?: number | undefined;
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

export type Phase = "lobby" | "play" | "reveal" | "vote" | "best" | "scores" | "final";

/**
 * The players' colours: their avatars, and their ink in the reveal (each
 * layer in its drawer's colour), so dark enough to read on paper.
 */
export const COLORS = [
  "#d62d3a",
  "#2f5bd8",
  "#cc6a0a",
  "#13895a",
  "#8b3fc6",
  "#d6408f",
  "#0a8396",
  "#8b5a2b",
  "#6b8a12",
  "#1f2f7a",
  "#a8860a",
  "#5b6575",
] as const;

/** Reactions phones can send during the reveal (the TV draws them). */
export const REACTIONS = 4;
/** A player's reactions: at most one per this many ms. */
export const REACT_EVERY = 600;

/** What the game itself names, per language. */
const SOMEONE: Record<Lang, string> = { en: "someone", de: "jemand" };

/** A round as it is played. */
interface Round {
  n: number;
  seats: Player[];
  /** Layers per picture (`L`); the steps are `L + 1` (the last only guesses). */
  layers: number;
  pictures: Picture[];
  /** Per picture: the words to pick from, then the words of its further layers. */
  deals: { choices: [Word, Word]; words: Word[] }[];
  /** The picture the reveal starts with (then seat order). */
  first: number;
  /** Best-move votes: voter id → layer id. */
  votes: Map<string, string>;
  /** The guesses as shown (`party.moderate`), by layer id; `false`: refused, hidden. */
  shown: Map<string, string | false>;
}

export class Garble extends Emitter<GameEvents> {
  readonly party: Party;
  rounds: number;
  readonly minPlayers: number;
  timings: Timings;
  /** A fixed first round for the next game (then cleared). */
  script: Script | undefined;
  readonly #rng: () => number;
  readonly #words = new Map<Lang, readonly Word[]>();
  /** The room's decks by language, kept from game to game. */
  readonly #decks = new Map<Lang, Deck<Word>>();
  #lang: Lang;
  #settings: Settings;
  /** Each player's colour (an index of {@link COLORS}), by id. */
  readonly #colors = new Map<string, number>();
  /** Names by id, kept after a player left (pictures still name them). */
  readonly #names = new Map<string, string>();
  /** Points per player id (players in the game). */
  readonly scores = new Map<string, number>();
  /** The last reaction per player id (the throttle). */
  readonly #reacted = new Map<string, number>();
  #phase: Phase = "lobby";
  #running = false;
  #abort = new AbortController();
  #roundNo = 0;
  #round: Round | undefined;
  /** The step being played (0-based) and whether its guess is still open. */
  #k = 0;
  #guessing = false;
  /** The last round's points by kind (the scores). */
  #earned = new Map<string, Earned>();

  constructor(party: Party, options: GameOptions) {
    super();
    this.party = party;
    this.rounds = options.rounds ?? 2;
    this.minPlayers = options.minPlayers ?? MIN_PLAYERS;
    this.timings = { ...DEFAULT_TIMINGS, ...options.timings };
    this.#rng = options.rng ?? Math.random;
    this.#lang = options.lang ?? "en";
    for (const [l, list] of Object.entries(options.words) as [Lang, readonly Word[]][]) if (list.length > 0) this.#words.set(l, list);
    if (!this.#words.has(this.#lang)) throw new Error(`garble: no words in ${this.#lang}`);
    this.#settings = {
      undo: options.undo ?? true,
      length: LENGTHS.includes(options.length as never) ? options.length! : 5,
    };
  }

  get settings(): Settings {
    return { ...this.#settings };
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

  /** The timers, as the settings name them (custom timings read as normal). */
  get pace(): Pace {
    return this.timings.draw === FAST_TIMINGS.draw ? "fast" : "normal";
  }

  /** Who may join during a game, as one of {@link LATE_JOIN} (the party's `open` reads as `wait`). */
  get late(): (typeof LATE_JOIN)[number] {
    return this.party.lateJoin === "closed" ? "closed" : "wait";
  }

  /** The languages there are words for. */
  get langs(): Lang[] {
    return [...this.#words.keys()];
  }

  /** The round being played (tests: the pictures, the words). */
  get round(): Readonly<Round> | undefined {
    return this.#round;
  }

  /**
   * What the picture a player is guessing now looks like it was meant to
   * be: the word of its latest layer with ink (the bots' oracle in the
   * host page, so games with bots read right most of the time; never
   * sent to a phone).
   */
  meant(id: string): Word | undefined {
    const r = this.#round;
    if (!r || this.#phase !== "play" || !this.#guessing || this.#k === 0) return undefined;
    const s = r.seats.findIndex((p) => p.id === id);
    if (s < 0) return undefined;
    return r.pictures[pictureAt(s, this.#k, r.seats.length)]!.layers.findLast((l) => l.drawing.strokes.length > 0)?.word;
  }

  colorOf(id: string): number {
    return this.#colors.get(id) ?? 0;
  }

  /** Shows the lobby and waits for the VIP to start. */
  open(): void {
    const party = this.party;
    const vipOnly = (from: { role: string; vip?: boolean }) => {
      if (from.role !== "player" || !from.vip) throw new PartyError("not-vip", "Only the VIP can do this");
    };
    party.handle("start", (_d, from) => {
      vipOnly(from as Player);
      if (this.#running) throw new PartyError("running", "The game is on");
      const ready = party.connectedPlayers.length;
      if (ready < this.minPlayers) throw new PartyError("too-few", `Wait for ${this.minPlayers - ready} more`);
      void this.play();
      return null;
    });
    party.handle("kick", (d, from) => {
      vipOnly(from as Player);
      if (this.#running) throw new PartyError("running", "Not during a game");
      const id = typeof d === "object" && d !== null && "id" in d ? (d as { id: unknown }).id : undefined;
      const p = typeof id === "string" ? party.player(id) : undefined;
      if (!p || p === from) throw new PartyError("no-player", "No such player");
      party.kick(p);
      return null;
    });
    party.handle("settings", (d, from) => {
      vipOnly(from as Player);
      if (typeof d !== "object" || d === null || Array.isArray(d)) throw new PartyError("bad-settings", "lang, rounds, length, timers, late, undo");
      const v = d as Record<string, Json>;
      for (const k of Object.keys(v)) if (!["lang", "rounds", "length", "timers", "late", "undo"].includes(k)) throw new PartyError("bad-settings", `${k}: not a setting`);
      const oneOf = <T extends Json>(key: string, list: readonly T[]): T | undefined => {
        if (v[key] === undefined) return undefined;
        if (!list.includes(v[key] as T)) throw new PartyError("bad-settings", `${key}: ${list.join(", ")}`);
        return v[key] as T;
      };
      const timers = oneOf("timers", PACES);
      this.configure({
        lang: oneOf("lang", this.langs),
        rounds: oneOf("rounds", ROUNDS),
        length: oneOf("length", LENGTHS),
        timings: timers === undefined ? undefined : timers === "fast" ? FAST_TIMINGS : DEFAULT_TIMINGS,
        late: oneOf("late", LATE_JOIN),
        undo: oneOf("undo", [true, false]),
      });
      return null;
    });
    party.handle("react", (d, from) => {
      if (from.role !== "player") throw new PartyError("not-player", "Players only");
      const r = typeof d === "object" && d !== null && "r" in d ? (d as { r: unknown }).r : d;
      if (typeof r !== "number" || !Number.isInteger(r) || r < 0 || r >= REACTIONS) throw new PartyError("bad-reaction", "No such reaction");
      if (!this.#running || (this.#phase !== "reveal" && this.#phase !== "best")) return null;
      const now = party.now();
      const p = from as Player;
      if (now - (this.#reacted.get(p.id) ?? 0) < REACT_EVERY) return null;
      this.#reacted.set(p.id, now);
      const msg = { r, name: p.name, color: COLORS[this.colorOf(p.id)] };
      party.broadcast("react", msg, "screen");
      party.broadcast("react", msg, "watch");
      return null;
    });
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
    });
    this.#lobby();
  }

  /**
   * Changes the rounds, the timers, the language, who may join late or
   * the settings before a game; every phone and the TV follow, and a
   * change tells the host page (`settings`).
   */
  configure(
    o: { rounds?: number | undefined; timings?: Partial<Timings> | undefined; lang?: Lang | undefined; late?: LateJoin | undefined } & { [K in keyof Settings]?: Settings[K] | undefined },
  ): void {
    if (this.#running) throw new PartyError("running", "Not during a game");
    if (o.lang !== undefined && !this.langs.includes(o.lang)) throw new PartyError("bad-lang", `Nothing to play in ${o.lang}`);
    if (o.late !== undefined && !(LATE_JOIN as readonly LateJoin[]).includes(o.late)) throw new PartyError("bad-late", `Latecomers: ${LATE_JOIN.join(", ")}`);
    const now = () => JSON.stringify([this.#lang, this.rounds, this.#settings, this.timings, this.party.lateJoin]);
    const was = now();
    if (o.rounds !== undefined) this.rounds = Math.max(1, Math.min(4, Math.round(o.rounds)));
    if (o.timings) this.timings = { ...DEFAULT_TIMINGS, ...o.timings };
    if (o.lang !== undefined) this.#lang = o.lang;
    if (o.late !== undefined) this.party.lateJoin = o.late;
    if (o.undo !== undefined) this.#settings.undo = o.undo;
    if (o.length !== undefined && LENGTHS.includes(o.length as never)) this.#settings.length = o.length;
    if (this.#phase === "lobby" || this.#phase === "final") {
      this.party.room.set(this.#settingsView());
      this.party.screen.set({ lang: this.#lang, rounds: this.rounds, ...this.#settings });
    }
    if (now() !== was) this.emit("settings", this.settings);
  }

  /** The settings as the phones see them (the VIP's controls, everyone's rules line). */
  #settingsView(): Record<string, Json> {
    return { lang: this.#lang, langs: this.langs, rounds: this.rounds, ...this.#settings, timers: this.pace, late: this.late };
  }

  /**
   * Ends a running game and its timers, with no final screen (closing
   * is not finishing: no `end`): the room is open again and the lobby
   * is on the TV and the phones (at once, not with the TV's delay), so
   * the VIP or the host can start again. Nothing of the closed game
   * writes to the party after it returns (each game's steps check their
   * own abort signal); the party stays, and a later {@link play} starts
   * afresh.
   */
  close(): void {
    if (!this.#running) return;
    this.#abort.abort();
    this.#over();
    this.#lobby();
  }

  /** A game is over (finished or closed): latecomers in, the room open again. */
  #over(): void {
    this.#round = undefined;
    this.#running = false;
    this.party.inProgress = false;
    for (const p of this.party.players) this.party.activate(p);
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

  /** Everybody's colour, by id (avatars and the reveal's ink). */
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
    return { task: this.#phase === "final" ? "final" : "lobby", color: this.colorOf(p.id), ...this.#rank(this.scores.has(p.id) ? p : undefined) };
  }

  #waitState(p: Player): Record<string, unknown> {
    return { task: "wait", note: this.#roundNo < this.rounds ? "round" : "game", color: this.colorOf(p.id) };
  }

  #room(fields: Record<string, unknown>): void {
    this.party.room.replace({ ...this.#settingsView(), round: this.#roundNo, minPlayers: this.minPlayers, colors: this.#colorMap(), ...fields });
  }

  #screen(fields: Record<string, unknown>): void {
    this.party.screen.replace({ lang: this.#lang, colors: this.#colorMap(), ...fields });
  }

  #lobby(): void {
    const party = this.party;
    this.#setPhase("lobby");
    this.#room({ phase: "lobby", maxPlayers: party.maxPlayers });
    this.#screen({ phase: "lobby", rounds: this.rounds, minPlayers: this.minPlayers, maxPlayers: party.maxPlayers, ...this.#settings });
    for (const p of party.players) p.state.replace(this.#lobbyState(p));
  }

  /**
   * A picture as the reveal shows it (names, colours, words, guesses,
   * points). A guess shows as `party.moderate` let it (`hidden`: refused).
   */
  #pictureView(r: Round, c: Picture): Record<string, unknown> {
    const guess = (g: Guess, k: number) => {
      const shown = r.shown.get(layerId(c.id, k)) ?? g.text;
      return { by: this.#who(g.by), text: shown === false ? "" : shown, right: g.right, ...(shown === false ? { hidden: true } : {}) };
    };
    return {
      id: c.id,
      starter: this.#who(c.layers[0]?.by ?? ""),
      layers: c.layers.map((l, k) => ({
        by: this.#who(l.by),
        word: l.word.word,
        drawing: l.drawing,
        points: layerPoints(k),
        guess: l.guess ? guess(l.guess, k) : null,
      })),
    };
  }

  // -------------------------------------------------------------------------
  // A game

  /** Plays a whole game with the players who are there (and those who join). */
  /**
   * Plays a whole game with the players who are there (and those who
   * join). It ends early, to the final screen, when fewer than
   * {@link minPlayers} are left in it at the start of a round (players
   * who left or were removed do not count; a phone that is only away
   * does). After {@link close} it resolves to the scores so far and
   * writes nothing more.
   */
  async play(): Promise<ScoreLine[]> {
    if (this.#running) throw new PartyError("running", "The game is on");
    const party = this.party;
    this.#running = true;
    const abort = new AbortController();
    this.#abort = abort;
    const signal = abort.signal;
    party.inProgress = true;
    this.scores.clear();
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
      if (signal.aborted) return this.#table();
      return this.#final();
    } finally {
      if (!signal.aborted) this.#over();
    }
  }

  #deck(): Deck<Word> {
    let d = this.#decks.get(this.#lang);
    if (!d) this.#decks.set(this.#lang, (d = new Deck(this.#words.get(this.#lang)!, this.#rng)));
    return d;
  }

  /** The seats and the words of a round: dealt, or the script's (round 1). */
  #deal(n: number, players: Player[]): { seats: Player[]; deals: Round["deals"]; first: number } {
    const script = n === 1 ? this.script : undefined;
    if (n === 1) this.script = undefined;
    const layers = layerCount(players.length, this.#settings.length);
    if (script) {
      const list = this.#words.get(this.#lang) ?? [];
      const word = (w: string): Word => list.find((x) => x.word === w) ?? { word: w, also: [] };
      const byName = (name: string) => players.find((p) => p.name === name);
      const seats = script.seats.map(byName).filter((p): p is Player => !!p);
      const rest = players.filter((p) => !seats.includes(p));
      const all = [...seats, ...rest];
      const deck = this.#deck();
      const deals = all.map((_, c) => {
        const s = script.pictures[c];
        return s ? { choices: [word(s.choices[0]), word(s.choices[1])] as [Word, Word], words: s.words.map(word) } : dealPicture(deck, layers, this.#lang);
      });
      return { seats: all, deals, first: Math.max(0, Math.min(all.length - 1, script.first ?? 0)) };
    }
    const seats = shuffle(players, this.#rng);
    const deck = this.#deck();
    // A random start, then seat order.
    return { seats, deals: seats.map(() => dealPicture(deck, layers, this.#lang)), first: Math.floor(this.#rng() * seats.length) };
  }

  async #playRound(n: number, players: Player[], signal: AbortSignal): Promise<void> {
    const { seats, deals, first } = this.#deal(n, players);
    const round: Round = {
      n,
      seats,
      first,
      layers: layerCount(seats.length, this.#settings.length),
      pictures: seats.map((_, i) => ({ id: i, layers: [] })),
      deals,
      votes: new Map(),
      shown: new Map(),
    };
    this.#round = round;
    for (let k = 0; k <= round.layers && !signal.aborted; k++) await this.#step(round, k, signal);
    if (signal.aborted) return;
    await this.#reveal(round, signal);
    if (signal.aborted) return;
    await this.#vote(round, signal);
  }

  /**
   * One step: every seat works on one picture. Step 0 draws the first
   * layer (a word picked from two); the steps after it first guess what
   * the picture is now, then draw the dealt word on top; the last step
   * only guesses.
   */
  async #step(r: Round, k: number, signal: AbortSignal): Promise<void> {
    const party = this.party;
    const count = r.seats.length;
    const first = k === 0;
    const last = k === r.layers;
    this.#k = k;
    this.#guessing = !first;
    this.#setPhase("play");
    const t = this.timings;
    const guessFor = first ? 0 : t.guess;
    const drawFor = last ? 0 : first ? t.firstDraw : t.draw;
    // From when the step is on the TV (and, with it, on the phones).
    const guessUntil = party.deadline(guessFor);
    const deadline = guessUntil + drawFor;
    const seatOfPlayer = new Map(r.seats.map((p, s) => [p, s]));
    const pictureOf = (p: Player) => r.pictures[pictureAt(seatOfPlayer.get(p)!, k, count)]!;
    const next = (p: Player) => this.#name(r.seats[(seatOfPlayer.get(p)! + 1) % count]!.id);
    const kind = first ? "first" : last ? "last" : "turn";
    const seats = r.seats.map((p) => this.#who(p.id));
    const base = (p: Player) => ({ step: k + 1, steps: r.layers + 1, ...this.#mine(p) });
    /** The drawing task of a player at this step (after their guess). */
    const drawState = (p: Player) => {
      const c = pictureOf(p);
      return {
        task: "draw",
        ...base(p),
        picture: flatten(c.layers),
        undo: this.#settings.undo,
        deadline,
        done: false,
        next: k + 1 <= r.layers ? next(p) : null,
        ...(first ? { choices: r.deals[c.id]!.choices.map((w) => w.word) } : { word: r.deals[c.id]!.words[k - 1]!.word }),
      };
    };
    const guessState = (p: Player) => {
      const c = pictureOf(p);
      const from = c.layers.at(-1)?.by;
      return { task: "guess", ...base(p), picture: flatten(c.layers), from: from ? this.#name(from) : null, deadline: guessUntil, last, done: false };
    };
    party.withTv(() => {
      this.#room({ phase: "play", step: k + 1, steps: r.layers + 1, kind, deadline });
      this.#screen({ phase: "play", round: r.n, rounds: this.rounds, step: k + 1, steps: r.layers + 1, kind, deadline, guessUntil, duration: guessFor + drawFor, seats, guessed: [], done: [] });
      for (const p of r.seats) p.state.replace(first ? drawState(p) : guessState(p));
      for (const p of party.players) if (!seatOfPlayer.has(p)) p.state.replace(this.#waitState(p));
    });

    const guessed = new Map<Player, string>();
    const drawn = new Set<string>();
    const guesses = first
      ? Promise.resolve(new Map<Player, string>())
      : party.collect<string>("guess", {
          from: r.seats,
          until: guessUntil,
          signal,
          validate: (d) => {
            const text = cleanGuess(typeof d === "object" && d !== null && !Array.isArray(d) ? (d as { text?: unknown }).text : d);
            if (!text) throw new PartyError("empty", "Write a guess");
            return text;
          },
          onAnswer: (p, text, got) => {
            guessed.set(p, text);
            p.state.replace(last ? { ...guessState(p), done: true } : drawState(p));
            party.screen.set({ guessed: [...got.keys()].map((x) => x.id) });
          },
        });
    const drawings = last
      ? Promise.resolve(new Map<Player, { drawing: Drawing; choice?: number }>())
      : party.collect<{ drawing: Drawing; choice?: number }>("draw", {
          from: r.seats,
          until: deadline,
          signal,
          validate: (d, p) => {
            if (!first && !guessed.has(p) && party.now() < guessUntil) throw new PartyError("guess-first", "Guess first");
            const drawing = validateDrawing(d);
            if (!first) return { drawing };
            const choice = (d as { choice?: unknown }).choice;
            if (choice !== 0 && choice !== 1) throw new PartyError("no-choice", "Pick a word");
            return { drawing, choice };
          },
          onAnswer: (p) => {
            drawn.add(p.id);
            p.state.set({ done: true });
            party.screen.set({ done: [...drawn] });
          },
        });
    await guesses;
    if (signal.aborted) return;
    // Time is up for guesses: whoever wrote none draws now (it counts as wrong).
    if (!first) {
      for (const p of r.seats) {
        if (guessed.has(p)) continue;
        guessed.set(p, "");
        if (party.player(p.id)) p.state.replace(last ? { ...guessState(p), done: true } : drawState(p));
      }
      party.screen.set({ guessed: r.seats.map((p) => p.id) });
    }
    const got = await drawings;
    if (signal.aborted) return;
    this.#guessing = false;
    for (const p of r.seats) {
      const c = pictureOf(p);
      if (!first) {
        const prev = c.layers.at(-1)!;
        // A slip counts unless it is another word: of the list, or of this picture (a script's words need not be in the list).
        const others = [...(this.#words.get(this.#lang) ?? []), ...c.layers.map((l) => l.word)];
        prev.guess = guessAt(prev, p.id, guessed.get(p) ?? "", this.#lang, others);
        // Judged as typed, shown (on the TV and in the gallery) as the moderate hook lets it.
        if (prev.guess.text) r.shown.set(layerId(c.id, c.layers.length - 1), party.moderate(prev.guess.text, "guess", p));
      }
      if (last) continue;
      const a = got.get(p);
      const deal = r.deals[c.id]!;
      const word = first ? deal.choices[a?.choice === 1 ? 1 : 0] : deal.words[k - 1]!;
      c.layers.push({ by: p.id, word, drawing: a?.drawing ?? { strokes: [] }, guess: null });
    }
  }

  // -------------------------------------------------------------------------
  // The reveal

  async #reveal(r: Round, signal: AbortSignal): Promise<void> {
    this.#setPhase("reveal");
    const order = r.pictures.map((_, i) => r.pictures[(r.first + i) % r.pictures.length]!);
    const shown: number[] = [];
    for (let i = 0; i < order.length; i++) {
      if (signal.aborted) return;
      await this.#showPicture(r, order[i]!, i, order.length, shown, signal);
      shown.push(order[i]!.id);
    }
  }

  async #showPicture(r: Round, c: Picture, index: number, of: number, shown: number[], signal: AbortSignal): Promise<void> {
    const party = this.party;
    const starter = c.layers[0]?.by ?? "";
    const { layer, read, legend } = this.timings;
    party.withTv(() => {
      this.#room({ phase: "reveal", index: index + 1, of });
      this.#screen({ phase: "reveal", round: r.n, rounds: this.rounds, index: index + 1, of, shown: [...shown], picture: this.#pictureView(r, c), cursor: 0, stage: "layers", times: { layer, read, legend } });
      for (const p of party.players) {
        if (!this.scores.has(p.id)) p.state.replace(this.#waitState(p));
        else p.state.replace({ task: "watch", starter: this.#name(starter), mine: c.layers.some((l) => l.by === p.id), index: index + 1, of, ...this.#mine(p) });
      }
    });
    for (let k = 0; k < c.layers.length; k++) {
      if (k > 0) party.withTv(() => party.screen.set({ cursor: k }));
      await this.#sleep(this.timings.layer + this.timings.read, signal);
      if (signal.aborted) return;
    }
    party.withTv(() => party.screen.set({ stage: "legend" }));
    await this.#sleep(this.timings.legend, signal);
  }

  // -------------------------------------------------------------------------
  // The best move

  async #vote(r: Round, signal: AbortSignal): Promise<void> {
    const party = this.party;
    this.#setPhase("vote");
    const deadline = party.deadline(this.timings.vote);
    const gallery = r.pictures.map((c) => this.#pictureView(r, c));
    /** The layers one can vote for: those with ink. */
    const candidates = new Map<string, string>();
    for (const c of r.pictures) c.layers.forEach((l, k) => l.drawing.strokes.length > 0 && candidates.set(layerId(c.id, k), l.by));
    const voters = r.seats.filter((p) => party.players.includes(p));
    const mine = (p: Player) => [...candidates].filter(([, by]) => by === p.id).map(([id]) => id);
    party.withTv(() => {
      this.#room({ phase: "vote", deadline, gallery });
      this.#screen({ phase: "vote", round: r.n, rounds: this.rounds, deadline, duration: this.timings.vote, gallery, voters: voters.map((p) => this.#who(p.id)), done: [] });
      for (const p of voters) p.state.replace({ task: "vote", mine: mine(p), deadline, done: false, choice: null, ...this.#mine(p) });
      for (const p of party.players) if (!voters.includes(p)) p.state.replace(this.#waitState(p));
    });
    const votes = await party.collect<string>("vote", {
      from: voters,
      until: deadline,
      signal,
      validate: (d, p) => {
        const id = typeof d === "object" && d !== null && !Array.isArray(d) ? (d as { layer?: unknown }).layer : d;
        if (typeof id !== "string" || !candidates.has(id)) throw new PartyError("bad-vote", "Pick a layer");
        if (candidates.get(id) === p.id) throw new PartyError("own-layer", "Not your own");
        return id;
      },
      onAnswer: (p, id, got) => {
        p.state.set({ done: true, choice: id });
        party.screen.set({ done: [...got.keys()].map((x) => x.id) });
      },
    });
    if (signal.aborted) return;
    r.votes = new Map([...votes].map(([p, id]) => [p.id, id]));
    const earned = scoreRound(r.pictures, r.votes);
    for (const [id, e] of earned) if (this.scores.has(id)) this.scores.set(id, (this.scores.get(id) ?? 0) + earnedTotal(e));
    this.#earned = earned;
    // The result: the winning layers (a tie shows them all), the tally.
    this.#setPhase("best");
    const best = bestMove(r.votes);
    const tally: Record<string, number> = {};
    for (const id of r.votes.values()) tally[id] = (tally[id] ?? 0) + 1;
    const winners = best.ids.map((id) => {
      const [pi, li] = id.split(":").map(Number);
      return { id, picture: pi!, layer: li!, votes: best.count, points: best.points };
    });
    party.withTv(() => {
      this.#room({ phase: "best" });
      this.#screen({ phase: "best", round: r.n, rounds: this.rounds, gallery, best: winners, tally });
      for (const p of party.players) {
        if (!this.scores.has(p.id)) continue;
        const won = winners.filter((w) => r.pictures[w.picture]?.layers[w.layer]?.by === p.id);
        const pick = r.votes.get(p.id);
        p.state.replace({ task: "best", won: won.length > 0, points: won.length * best.points, picked: !!pick && best.ids.includes(pick), ...this.#mine(p) });
      }
    });
    await this.#sleep(this.timings.best, signal);
  }

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
    const r = this.#round;
    /** Per player: layers read right (drawn, of drawn) and guesses right (of written). */
    const counts = new Map<string, { drawn: number; drew: number; read: number; wrote: number }>();
    const count = (id: string) => {
      let c = counts.get(id);
      if (!c) counts.set(id, (c = { drawn: 0, drew: 0, read: 0, wrote: 0 }));
      return c;
    };
    for (const c of r?.pictures ?? []) {
      for (const l of c.layers) {
        count(l.by).drew++;
        if (!l.guess) continue;
        count(l.guess.by).wrote++;
        if (l.guess.right) {
          count(l.by).drawn++;
          count(l.guess.by).read++;
        }
      }
    }
    const lines = this.#table(before).map((l) => ({ ...l, earned: this.#earned.get(l.id) ?? null, counts: counts.get(l.id) ?? null }));
    party.withTv(() => {
      this.#room({ phase: "scores" });
      this.#screen({ phase: "scores", round, rounds: this.rounds, lines, last: round >= this.rounds });
      for (const p of party.players) {
        if (!this.scores.has(p.id)) {
          p.state.replace(this.#waitState(p));
          continue;
        }
        const line = lines.find((l) => l.id === p.id);
        p.state.replace({ task: "scores", earned: line?.earned ?? null, counts: line?.counts ?? null, delta: line?.delta ?? 0, ...this.#mine(p) });
      }
    });
    await this.#sleep(this.timings.scores, signal);
  }

  #final(): ScoreLine[] {
    const party = this.party;
    this.#round = undefined;
    this.#setPhase("final");
    const table = this.#table();
    party.withTv(() => {
      this.#room({ phase: "final", maxPlayers: party.maxPlayers });
      this.#screen({ phase: "final", lines: table, rounds: this.rounds, ...this.#settings });
      for (const p of party.players) p.state.replace({ task: "final", color: this.colorOf(p.id), ...this.#rank(this.scores.has(p.id) ? p : undefined) });
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
