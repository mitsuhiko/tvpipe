/**
 * Shifty on a party, for 3 to 10 players (docs/shifty-design.md): the
 * lobby, then per round a board of sixteen words of one category, one of
 * them the secret that everyone but the phony gets; one clue after the
 * other, typed (the TV shows the typing as tiles and a lie detector's
 * needle, never the letters) or said out loud; the accusations, secret
 * on the phones and revealed together; the phony's last chance to name
 * the word; the reveal and the points; the scores; the final screen with
 * the podium and the awards. The host is the only authority: phones and
 * screens only ever get views.
 *
 * Views:
 * - `party.room` (every phone): `{ phase, lang, langs, round, rounds, …settings, late, minPlayers, colors, category?, board?,
 *   order?, clues?, turn?, accused?, deadline?, verdict?, reveal? }`: `board` the sixteen words (everyone sees them),
 *   `order` who gives clues in which order, `clues` by id (`{ text, away?, spoken? }`, `text` null for silence),
 *   `turn` the clue being given (`{ key, id, pass, index, of, deadline }`), `accused` who has accused (never whom),
 *   `verdict` (`{ top, caught, phony }`) and `reveal` (`{ secret, word, pick, named, caught, phony, earned }`)
 *   once the TV shows them.
 * - `player.state` (one phone): `{ task, color, score, rank, of, role?, word? }`: during a round `role` is
 *   `phony` or `innocent` and `word` the secret (innocents only); `task` one of `lobby`, `wait` (a late joiner),
 *   `card` (the deal), `clue` (`turn`, `mine`, `deadline`, `sent`), `accuse` (`deadline`, `done`, `choice`),
 *   `verdict`, `pick` (the phony's last chance: `deadline`, `done`, `pick`), `watch` (the others meanwhile),
 *   `result` (`earned`, `secret`, `word`, `named`, `caught`), `scores` (`earned`, `delta`), `final`.
 * - `party.screen` (the TV): `{ phase, lang, colors, round, rounds, … }`; in a round (`phase: "round"`) `stage`
 *   (`deal`, `clue`, `accuse`, `verdict`, `last`, `reveal`, `gone`), the category, the board, `suspects` (who
 *   plays the round, in the clues' order), `clues`, `traces` (each finished turn's typing log by id), `turn` (the
 *   clue being given, with its live typing log `keys` and `refused`), `accused`, and from the verdict on
 *   `votes`, `top`, `caught`, `phony`; from the reveal `secret`, `pick`, `named`, `earned`.
 *
 * The secret word reaches only the innocents' phones until the reveal,
 * who the phony is only the phony's phone until the verdict, typing only
 * the TV and only as counts.
 */

import { Emitter, PartyError, type Json, type LateJoin, type Party, type Player, type Sender } from "@tvpipe/party";

import {
  addKey,
  checkClue,
  clueOrder,
  cluesEach,
  dealBoard,
  Deck,
  deletions,
  earnedTotal,
  MIN_CATEGORY,
  MIN_PLAYERS,
  pickPhony,
  scoreRound,
  tally,
  BOARD,
  type Category,
  type Earned,
  type Key,
  type Lang,
  type Word,
} from "./rules.ts";

export interface Timings {
  /** The board dealt, everyone looks at their card. */
  deal: number;
  /** One clue (the room's setting). */
  clue: number;
  /** After a clue: pinned on the TV. */
  pin: number;
  /** A turn skipped (the player is away). */
  skip: number;
  /** Talking and accusing (the room's setting). */
  talk: number;
  /** The verdict: before the first string, and the stamp after the last. */
  verdict: number;
  /** The verdict: each string. */
  string: number;
  /** The verdict: the spotlight swinging to the phony who was not caught. */
  swing: number;
  /** The phony's last chance. */
  last: number;
  /** The word, the threads, the points. */
  reveal: number;
  scores: number;
}

export const DEFAULT_TIMINGS: Timings = {
  deal: 7000,
  clue: 25_000,
  pin: 1600,
  skip: 1400,
  talk: 60_000,
  verdict: 2200,
  string: 750,
  swing: 3000,
  last: 20_000,
  reveal: 9000,
  scores: 8000,
};

/** For trying the game: everything short. */
export const FAST_TIMINGS: Timings = {
  deal: 3500,
  clue: 12_000,
  pin: 1000,
  skip: 800,
  talk: 20_000,
  verdict: 1500,
  string: 500,
  swing: 2000,
  last: 10_000,
  reveal: 5000,
  scores: 4000,
};

/** What the room can pick (seconds). */
export const CLUE_TIMES = [15, 25, 40] as const;
export const TALK_TIMES = [45, 60, 90, 120] as const;
export const ROUNDS = [3, 4, 5, 6] as const;
/** Clues each: 0 is auto (two with up to five players, else one). */
export const CLUES = [0, 1, 2] as const;
export const MODES = ["typed", "spoken"] as const;
export type Mode = (typeof MODES)[number];
/** Latecomers (`party.lateJoin`): they wait for the next round, or nobody joins during a game (the host page's latecomers field offers these two). */
export const LATE = ["wait", "closed"] as const satisfies readonly LateJoin[];
export type Late = (typeof LATE)[number];

/** The room's settings: the host page's, or the VIP's on their phone in the lobby and at the end (besides the language and latecomers). */
export interface Settings {
  /** Clues typed on the phones, or said out loud. */
  mode: Mode;
  /** Clues each: 0 auto, 1 or 2. */
  clues: number;
  /** Seconds for a clue. */
  clueTime: number;
  /** Seconds to talk and accuse. */
  talkTime: number;
  /** The TV shows the typing: the tiles and the needle. */
  typing: boolean;
}

/** A fixed first round (the live check's screenshots): the category by its title, the board's words, the secret and the phony by name, the order of the clues by names. */
export interface Script {
  category: string;
  board?: string[] | undefined;
  secret: string;
  phony: string;
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
  mode?: Mode | undefined;
  clues?: number | undefined;
  typing?: boolean | undefined;
}

export interface ScoreLine {
  id: string;
  name: string;
  score: number;
  delta: number;
}

export interface GameEvents {
  phase: [phase: Phase, stage: Stage | null];
  end: [scores: ScoreLine[]];
  settings: [settings: Settings];
}

export type Phase = "lobby" | "round" | "scores" | "final";
export type Stage = "deal" | "clue" | "accuse" | "verdict" | "last" | "reveal" | "gone";

/** The players' colours: one each for ten players. */
export const COLORS = ["#e63946", "#3a86ff", "#f4a261", "#2ec4b6", "#9b5de5", "#ffbe0b", "#f15bb5", "#8ac926", "#00bbf9", "#c08552"] as const;

/** A clue as the TV and the phones get it: its text (null: nothing came), or that the turn was skipped. */
export interface Clue {
  text: string | null;
  away?: boolean;
  spoken?: boolean;
}

/** A finished turn's typing, as the TV draws it. */
export interface Trace {
  keys: Key[];
  /** When a clue was refused, ms since the turn began. */
  refused: number[];
  /** How long the turn took, ms. */
  ms: number;
}

/** What the game itself names, per language. */
const SOMEONE: Record<Lang, string> = { en: "someone", de: "jemand" };

/** A round as it is played. */
interface Round {
  n: number;
  category: Category;
  board: Word[];
  secret: number;
  phony: string;
  players: Player[];
  /** Who gives clues, in order (ids). */
  order: string[];
  passes: number;
  clues: Map<string, Clue[]>;
  traces: Map<string, Trace[]>;
  /** Accuser id → accused id. */
  votes: Map<string, string>;
  pick: number | null;
  caught: boolean;
  earned: Map<string, Earned>;
}

/** The clue being given. */
interface Turn {
  key: string;
  id: string;
  pass: number;
  start: number;
  end: number;
  keys: Key[];
  refused: number[];
  /** Ends the turn with a clue (or without one). */
  finish: (clue: Clue | null) => void;
}

/** The game's numbers per player, for the awards. */
interface Totals {
  phony: number;
  hits: number;
  deletions: number;
}

export class Shifty extends Emitter<GameEvents> {
  readonly party: Party;
  rounds: number;
  readonly minPlayers: number;
  timings: Timings;
  /** A fixed first round for the next game (then cleared). */
  script: Script | undefined;
  readonly #rng: () => number;
  readonly #words = new Map<Lang, readonly Category[]>();
  readonly #all = new Map<Lang, Word[]>();
  /** The room's category decks by language, kept from game to game. */
  readonly #decks = new Map<Lang, Deck<Category>>();
  #lang: Lang;
  #mode: Mode;
  #clues: number;
  #typing: boolean;
  readonly #colors = new Map<string, number>();
  /** Names by id, kept after a player left. */
  readonly #names = new Map<string, string>();
  /** Points per player id (players in the game). */
  readonly scores = new Map<string, number>();
  #phase: Phase = "lobby";
  #stage: Stage | null = null;
  #running = false;
  #abort = new AbortController();
  #game = 0;
  #roundNo = 0;
  #round: Round | undefined;
  #turn: Turn | undefined;
  #earned = new Map<string, Earned>();
  readonly #totals = new Map<string, Totals>();

  constructor(party: Party, options: GameOptions) {
    super();
    this.party = party;
    this.rounds = options.rounds ?? 4;
    this.minPlayers = options.minPlayers ?? MIN_PLAYERS;
    this.timings = { ...DEFAULT_TIMINGS, ...options.timings };
    this.#rng = options.rng ?? Math.random;
    this.#lang = options.lang ?? "en";
    for (const [l, list] of Object.entries(options.words) as [Lang, readonly Category[]][]) {
      const usable = list.filter((c) => c.words.length >= BOARD);
      if (usable.length === 0) continue;
      this.#words.set(l, usable);
      this.#all.set(
        l,
        list.flatMap((c) => c.words),
      );
    }
    if (!this.#words.has(this.#lang)) throw new Error(`shifty: no words in ${this.#lang}`);
    this.#mode = options.mode ?? "typed";
    this.#clues = options.clues ?? 0;
    this.#typing = options.typing ?? true;
  }

  get settings(): Settings {
    return { mode: this.#mode, clues: this.#clues, clueTime: this.timings.clue / 1000, talkTime: this.timings.talk / 1000, typing: this.#typing };
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

  get langs(): Lang[] {
    return [...this.#words.keys()];
  }

  /** The round being played (tests: the board, the clues, the votes). */
  get round(): Readonly<Round> | undefined {
    return this.#round;
  }

  /** Whether a player is the phony of the round (the bots' oracle in the host page and the tests; never sent to a phone). */
  isPhony(id: string): boolean {
    return this.#round?.phony === id;
  }

  /** The round's secret word (the bots' oracle; never sent but to the innocents). */
  secret(): Word | undefined {
    const r = this.#round;
    return r ? r.board[r.secret] : undefined;
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
      if (typeof d !== "object" || d === null || Array.isArray(d)) throw new PartyError("bad-settings", "lang, rounds, mode, clues, clueTime, talkTime, typing, late");
      const v = d as Record<string, Json>;
      const o: Partial<Settings> & { rounds?: number; lang?: Lang; late?: Late } = {};
      const oneOf = (key: "rounds" | "clues" | "clueTime" | "talkTime", list: readonly number[]) => {
        if (v[key] === undefined) return;
        if (!list.includes(v[key] as number)) throw new PartyError("bad-settings", `${key}: ${list.join(", ")}`);
        o[key] = v[key] as number;
      };
      for (const k of Object.keys(v)) if (!["lang", "rounds", "mode", "clues", "clueTime", "talkTime", "typing", "late"].includes(k)) throw new PartyError("bad-settings", `${k}: not a setting`);
      if (v["lang"] !== undefined) {
        if (!(this.langs as Json[]).includes(v["lang"])) throw new PartyError("bad-settings", `lang: ${this.langs.join(", ")}`);
        o.lang = v["lang"] as Lang;
      }
      if (v["late"] !== undefined) {
        if (!(LATE as readonly Json[]).includes(v["late"])) throw new PartyError("bad-settings", `late: ${LATE.join(", ")}`);
        o.late = v["late"] as Late;
      }
      oneOf("rounds", ROUNDS);
      oneOf("clues", CLUES);
      oneOf("clueTime", CLUE_TIMES);
      oneOf("talkTime", TALK_TIMES);
      if (v["mode"] !== undefined) {
        if (!(MODES as readonly Json[]).includes(v["mode"])) throw new PartyError("bad-settings", "mode: typed or spoken");
        o.mode = v["mode"] as Mode;
      }
      if (v["typing"] !== undefined) {
        if (typeof v["typing"] !== "boolean") throw new PartyError("bad-settings", "typing: true or false");
        o.typing = v["typing"];
      }
      this.configure(o);
      return null;
    });
    party.handle("clue", (d, from) => this.#clue(d, from));
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
      if (this.#turn?.id === p.id) this.#turn.finish(null);
    });
    this.#lobby();
  }

  /** Latecomers: they wait for the next round, or cannot join during a game (`party.lateJoin`; `open` reads as `wait`, as on the host page). */
  get late(): Late {
    return this.party.lateJoin === "closed" ? "closed" : "wait";
  }

  /** What the room view carries of the settings: the language and the languages with words, the rounds, {@link settings}, latecomers. */
  #settingsView(): Record<string, Json> {
    return { lang: this.#lang, langs: this.langs, rounds: this.rounds, ...this.settings, late: this.late };
  }

  /** Changes the language, the rounds, the timers, the settings or latecomers before a game; every phone and the TV follow. */
  configure(o: { rounds?: number | undefined; timings?: Partial<Timings> | undefined; lang?: Lang | undefined; late?: Late | undefined } & { [K in keyof Settings]?: Settings[K] | undefined }): void {
    if (this.#running) throw new PartyError("running", "Not during a game");
    if (o.lang !== undefined && !this.langs.includes(o.lang)) throw new PartyError("bad-lang", `Nothing to play in ${o.lang}`);
    if (o.late !== undefined && !LATE.includes(o.late)) throw new PartyError("bad-late", `Latecomers: ${LATE.join(", ")}`);
    const was = JSON.stringify([this.#lang, this.rounds, this.settings, this.late]);
    if (o.rounds !== undefined) this.rounds = Math.max(1, Math.min(10, Math.round(o.rounds)));
    if (o.timings) this.timings = { ...this.timings, ...o.timings };
    if (o.lang !== undefined) this.#lang = o.lang;
    if (o.mode !== undefined && MODES.includes(o.mode)) this.#mode = o.mode;
    if (o.clues !== undefined && (CLUES as readonly number[]).includes(o.clues)) this.#clues = o.clues;
    if (o.clueTime !== undefined && o.clueTime > 0) this.timings.clue = o.clueTime * 1000;
    if (o.talkTime !== undefined && o.talkTime > 0) this.timings.talk = o.talkTime * 1000;
    if (o.typing !== undefined) this.#typing = o.typing;
    if (o.late !== undefined) this.party.lateJoin = o.late;
    if (this.#phase === "lobby" || this.#phase === "final") {
      this.party.room.set(this.#settingsView());
      this.party.screen.set({ lang: this.#lang, rounds: this.rounds, ...this.settings });
    }
    if (JSON.stringify([this.#lang, this.rounds, this.settings, this.late]) !== was) this.emit("settings", this.settings);
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

  #stop(): void {
    const party = this.party;
    this.#round = undefined;
    this.#turn = undefined;
    this.#stage = null;
    this.#running = false;
    party.inProgress = false;
    for (const p of party.players) party.activate(p);
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

  #mine(p: Player): Record<string, unknown> {
    return { color: this.colorOf(p.id), ...this.#rank(this.scores.has(p.id) ? p : undefined) };
  }

  /** What a player of the round knows all round: their role, and the word unless they are the phony. */
  #card(r: Round, p: Player): Record<string, unknown> {
    return r.phony === p.id ? { role: "phony" } : { role: "innocent", word: r.board[r.secret]!.word };
  }

  #lobbyState(p: Player): Record<string, unknown> {
    return { task: this.#phase === "final" ? "final" : "lobby", ...this.#mine(p) };
  }

  #waitState(p: Player): Record<string, unknown> {
    return { task: "wait", note: this.#roundNo < this.rounds ? "round" : "game", color: this.colorOf(p.id) };
  }

  #room(fields: Record<string, unknown>): void {
    this.party.room.replace({ ...this.#settingsView(), round: this.#roundNo, minPlayers: this.minPlayers, colors: this.#colorMap(), ...fields });
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

  #others(ids: ReadonlySet<string>): void {
    for (const p of this.party.players) if (!ids.has(p.id)) p.state.replace(this.#waitState(p));
  }

  /** The round's clues and traces as views carry them (by id). */
  #cluesView(r: Round): Record<string, Clue[]> {
    return Object.fromEntries(r.order.map((id) => [id, r.clues.get(id) ?? []]));
  }

  #tracesView(r: Round): Record<string, Trace[]> {
    return Object.fromEntries(r.order.map((id) => [id, r.traces.get(id) ?? []]));
  }

  /** What the round's TV always has: the category, the board, the suspects, the clues so far. */
  #table(r: Round): Record<string, unknown> {
    return {
      phase: "round",
      category: r.category.title,
      board: r.board.map((w) => w.word),
      suspects: r.order.map((id) => this.#who(id)),
      clues: this.#cluesView(r),
      traces: this.#tracesView(r),
      passes: r.passes,
      mode: this.#mode,
      typing: this.#typing,
    };
  }

  /** What the round's phones always have. */
  #roomTable(r: Round): Record<string, unknown> {
    return { phase: "round", category: r.category.title, board: r.board.map((w) => w.word), order: r.order, clues: this.#cluesView(r), passes: r.passes };
  }

  // -------------------------------------------------------------------------
  // A game

  /**
   * Plays a whole game with the players who are there (and those who
   * join). It ends early, to the final screen, when fewer than
   * {@link minPlayers} are left in it at the start of a round. Closed
   * ({@link close}), it returns the scores so far and shows nothing.
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
      return signal.aborted ? this.#lines() : this.#final();
    } finally {
      if (this.#game === game) this.#stop();
    }
  }

  #deck(): Deck<Category> {
    let d = this.#decks.get(this.#lang);
    if (!d) this.#decks.set(this.#lang, (d = new Deck(this.#words.get(this.#lang)!, this.#rng)));
    return d;
  }

  /** The round's board, secret, phony and order: dealt, or the script's (round 1). */
  #deal(n: number, players: Player[]): Round {
    const script = n === 1 ? this.script : undefined;
    if (n === 1) this.script = undefined;
    const list = this.#words.get(this.#lang)!;
    const ids = players.map((p) => p.id);
    const category = (script && list.find((c) => c.title === script.category)) || this.#deck().draw((c) => c.words.length >= MIN_CATEGORY);
    let { words: board, secret } = dealBoard(category, this.#rng);
    let phony = pickPhony(ids, this.#rng);
    let order = clueOrder(ids, phony, this.#rng);
    if (script) {
      const named = [...new Set([...(script.board ?? []), script.secret])].flatMap((w) => category.words.find((x) => x.word === w) ?? []);
      const rest = board.filter((w) => !named.includes(w));
      board = [...named, ...rest].slice(0, BOARD);
      const s = board.findIndex((w) => w.word === script.secret);
      if (s >= 0) secret = s;
      phony = players.find((p) => p.name === script.phony)?.id ?? phony;
      const fixed = (script.order ?? []).flatMap((name) => players.find((p) => p.name === name)?.id ?? []);
      order = [...fixed, ...order.filter((id) => !fixed.includes(id))];
    }
    const passes = cluesEach(this.#clues, players.length);
    return { n, category, board, secret, phony, players, order, passes, clues: new Map(), traces: new Map(), votes: new Map(), pick: null, caught: false, earned: new Map() };
  }

  async #playRound(n: number, players: Player[], signal: AbortSignal): Promise<void> {
    const party = this.party;
    const r = this.#deal(n, players);
    this.#round = r;
    const ids = new Set(players.map((p) => p.id));

    // The deal: the board on the TV, the cards on the phones.
    this.#setPhase("round", "deal");
    party.withTv(() => {
      this.#room({ ...this.#roomTable(r) });
      this.#screen({ ...this.#table(r), stage: "deal" });
      for (const p of players) p.state.replace({ task: "card", ...this.#card(r, p), ...this.#mine(p) });
      this.#others(ids);
    });
    await this.#sleep(this.timings.deal, signal);
    if (signal.aborted) return;

    // The clues, one turn after the other.
    const turns = r.passes * r.order.length;
    for (let pass = 1; pass <= r.passes; pass++) {
      for (let i = 0; i < r.order.length; i++) {
        if (!party.player(r.phony)) break;
        const id = r.order[i]!;
        if (!party.player(id)) continue;
        await this.#playTurn(r, id, pass, (pass - 1) * r.order.length + i + 1, turns, signal);
        if (signal.aborted) return;
      }
    }
    this.#turn = undefined;

    // A phony who left for good takes the round with them.
    if (!party.player(r.phony)) return this.#gone(r, signal);

    await this.#accuse(r, signal);
    if (signal.aborted) return;
    if (!party.player(r.phony)) return this.#gone(r, signal);
    await this.#verdict(r, signal);
    if (signal.aborted) return;
    await this.#last(r, signal);
    if (signal.aborted) return;
    await this.#reveal(r, signal);
  }

  // -------------------------------------------------------------------------
  // Clues

  async #playTurn(r: Round, id: string, pass: number, index: number, of: number, signal: AbortSignal): Promise<void> {
    const party = this.party;
    const p = party.player(id)!;
    const ids = new Set(r.players.map((x) => x.id));
    const key = `${r.n}:${pass}:${id}`;
    const list = r.clues.get(id) ?? [];
    r.clues.set(id, list);
    this.#setPhase("round", "clue");
    if (!p.connected) {
      // Away when the turn comes: skipped.
      list.push({ text: null, away: true });
      party.withTv(() => {
        party.room.set({ clues: this.#cluesView(r), turn: { key, id, pass, index, of, deadline: 0, skipped: true } });
        party.screen.set({ stage: "clue", clues: this.#cluesView(r), turn: { key, id, pass, index, of, start: 0, end: 0, keys: [], refused: [], skipped: true } });
      });
      await this.#sleep(this.timings.skip, signal);
      return;
    }
    const start = party.deadline(0);
    const end = party.deadline(this.timings.clue);
    let finish: (clue: Clue | null) => void = () => {};
    const over = new Promise<Clue | null>((resolve) => (finish = resolve));
    const turn: Turn = { key, id, pass, start, end, keys: [], refused: [], finish: (c) => finish(c) };
    this.#turn = turn;
    const turnView = { key, id, pass, index, of, deadline: end };
    party.withTv(() => {
      this.#room({ ...this.#roomTable(r), turn: turnView });
      this.#screen({ ...this.#table(r), stage: "clue", turn: { key, id, pass, index, of, start, end, keys: [], refused: [] } });
      for (const x of r.players) {
        if (!party.player(x.id)) continue;
        x.state.replace({ task: "clue", turn: key, mine: x.id === id, deadline: end, sent: false, ...this.#card(r, x), ...this.#mine(x) });
      }
      this.#others(ids);
    });
    const timer = setTimeout(() => finish(null), Math.max(0, end + party.grace - party.now()));
    const abort = () => finish(null);
    signal.addEventListener("abort", abort, { once: true });
    const clue = await over;
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    if (this.#turn === turn) this.#turn = undefined;
    if (signal.aborted) return;
    list.push(clue ?? { text: null });
    const ms = Math.max(0, Math.min(party.now(), end) - start);
    const traces = r.traces.get(id) ?? [];
    traces.push({ keys: turn.keys, refused: turn.refused, ms });
    r.traces.set(id, traces);
    const t = this.#totalsOf(id);
    t.deletions += deletions(turn.keys);
    party.withTv(() => {
      party.room.set({ clues: this.#cluesView(r), turn: { ...turnView, done: true } });
      party.screen.set({ clues: this.#cluesView(r), traces: this.#tracesView(r), turn: { key, id, pass, index, of, start, end, keys: turn.keys, refused: turn.refused, done: true, ms } });
      p.state.set({ sent: true });
    });
    await this.#sleep(this.timings.pin, signal);
  }

  /** A clue from the phone whose turn it is: checked against the board (a refusal is an answer, not an error). */
  #clue(d: Json, from: Sender): unknown {
    const turn = this.#turn;
    const r = this.#round;
    const data = typeof d === "object" && d !== null && !Array.isArray(d) ? d : {};
    if (from.role !== "player") throw new PartyError("not-player", "Players only");
    if (!turn || !r || data["key"] !== turn.key) throw new PartyError("not-now", "Not your turn");
    if (from.id !== turn.id) throw new PartyError("not-yours", "Not your turn");
    const party = this.party;
    const spoken = this.#mode === "spoken";
    const raw = typeof data["text"] === "string" ? data["text"] : "";
    if (spoken && !raw.trim()) {
      turn.finish({ text: null, spoken: true });
      return { ok: true };
    }
    const shown = party.moderate(raw, "clue", from);
    const refuse = (reason: string, word?: string) => {
      turn.refused.push(Math.max(0, party.now() - turn.start));
      party.screen.set({ turn: { ...(party.screen.peek()["turn"] as object), refused: turn.refused } });
      return { ok: false, reason, ...(word ? { word } : {}) };
    };
    if (shown === false) return refuse("refused");
    const check = checkClue(shown, r.board, this.#lang, this.#all.get(this.#lang));
    if (!check.ok) return refuse(check.reason, check.word);
    turn.finish(spoken ? { text: check.text, spoken: true } : { text: check.text });
    return { ok: true, text: check.text };
  }

  /** The typing of the player whose turn it is (`{ turn, n, k, d }`): into the turn's log, onto the TV. */
  #input(p: Player, data: Json): void {
    const turn = this.#turn;
    if (!turn || turn.id !== p.id || this.#mode !== "typed") return;
    if (typeof data !== "object" || data === null || Array.isArray(data) || data["turn"] !== turn.key) return;
    const party = this.party;
    if (!addKey(turn.keys, party.now() - turn.start, data)) return;
    party.screen.set({ turn: { ...(party.screen.peek()["turn"] as object), keys: turn.keys } });
  }

  // -------------------------------------------------------------------------
  // Accusing, the verdict, the last chance, the reveal

  async #accuse(r: Round, signal: AbortSignal): Promise<void> {
    const party = this.party;
    this.#setPhase("round", "accuse");
    const ids = new Set(r.players.map((p) => p.id));
    const present = r.players.filter((p) => party.player(p.id));
    const deadline = party.deadline(this.timings.talk);
    party.withTv(() => {
      this.#room({ ...this.#roomTable(r), deadline, accused: [] });
      this.#screen({ ...this.#table(r), stage: "accuse", deadline, duration: this.timings.talk, accused: [] });
      for (const p of present) p.state.replace({ task: "accuse", deadline, done: false, choice: null, ...this.#card(r, p), ...this.#mine(p) });
      this.#others(ids);
    });
    const votes = await party.collect<string>("accuse", {
      from: present,
      until: deadline,
      signal,
      validate: (d, p) => {
        const id = typeof d === "object" && d !== null && !Array.isArray(d) ? (d as { id?: unknown }).id : d;
        if (typeof id !== "string" || !r.order.includes(id)) throw new PartyError("bad-accuse", "Pick a player");
        if (id === p.id) throw new PartyError("self", "Not yourself");
        return id;
      },
      onAnswer: (p, id, got) => {
        p.state.set({ done: true, choice: id });
        const accused = [...got.keys()].map((x) => x.id);
        party.room.set({ accused });
        party.screen.set({ accused });
      },
    });
    if (signal.aborted) return;
    r.votes = new Map([...votes].map(([p, id]) => [p.id, id]));
  }

  async #verdict(r: Round, signal: AbortSignal): Promise<void> {
    const party = this.party;
    this.#setPhase("round", "verdict");
    const { counts, top } = tally(r.votes);
    r.caught = top === r.phony;
    const phony = this.#who(r.phony);
    const votes = [...r.votes];
    party.withTv(() => {
      party.room.set({ verdict: { top, caught: r.caught, phony } });
      party.screen.set({ stage: "verdict", votes, counts: Object.fromEntries(counts), top, caught: r.caught, phony });
      for (const p of r.players) if (party.player(p.id)) p.state.replace({ task: "verdict", top, caught: r.caught, ...this.#card(r, p), ...this.#mine(p) });
    });
    const t = this.timings;
    await this.#sleep(t.verdict * 2 + t.string * votes.length + (r.caught ? 0 : t.swing), signal);
  }

  async #last(r: Round, signal: AbortSignal): Promise<void> {
    const party = this.party;
    this.#setPhase("round", "last");
    const phony = party.player(r.phony);
    const deadline = party.deadline(this.timings.last);
    party.withTv(() => {
      party.room.set({ deadline });
      party.screen.set({ stage: "last", deadline, duration: this.timings.last });
      for (const p of r.players) {
        if (!party.player(p.id)) continue;
        if (p === phony) p.state.replace({ task: "pick", deadline, done: false, pick: null, ...this.#card(r, p), ...this.#mine(p) });
        else p.state.replace({ task: "watch", deadline, ...this.#card(r, p), ...this.#mine(p) });
      }
    });
    if (!phony) return;
    const picks = await party.collect<number>("pick", {
      from: [phony],
      until: deadline,
      signal,
      validate: (d) => {
        const i = typeof d === "object" && d !== null && !Array.isArray(d) ? (d as { index?: unknown }).index : d;
        if (typeof i !== "number" || !Number.isInteger(i) || i < 0 || i >= r.board.length) throw new PartyError("bad-pick", "Pick a word of the board");
        return i;
      },
      onAnswer: (p, i) => p.state.set({ done: true, pick: i }),
    });
    if (signal.aborted) return;
    r.pick = picks.get(phony) ?? null;
  }

  #totalsOf(id: string): Totals {
    let t = this.#totals.get(id);
    if (!t) this.#totals.set(id, (t = { phony: 0, hits: 0, deletions: 0 }));
    return t;
  }

  async #reveal(r: Round, signal: AbortSignal): Promise<void> {
    const party = this.party;
    this.#setPhase("round", "reveal");
    const named = r.pick === r.secret;
    const ids = r.players.map((p) => p.id);
    const { caught, earned } = scoreRound(ids, r.phony, r.votes, named);
    r.caught = caught;
    r.earned = earned;
    this.#earned = earned;
    for (const [id, e] of earned) {
      if (this.scores.has(id)) this.scores.set(id, (this.scores.get(id) ?? 0) + earnedTotal(e));
      const t = this.#totalsOf(id);
      if (id === r.phony) t.phony += earnedTotal(e);
      if (e.accuse > 0) t.hits++;
    }
    const word = r.board[r.secret]!.word;
    const totals = Object.fromEntries([...earned].map(([id, e]) => [id, earnedTotal(e)]));
    const phony = this.#who(r.phony);
    const reveal = { secret: r.secret, word, pick: r.pick, named, caught, phony, earned: totals };
    party.withTv(() => {
      party.room.set({ reveal });
      party.screen.set({ stage: "reveal", ...reveal });
      for (const p of r.players) {
        if (!party.player(p.id)) continue;
        p.state.replace({ task: "result", earned: earned.get(p.id) ?? null, secret: r.secret, word, named, caught, pick: r.pick, phony: phony.name, ...this.#card(r, p), ...this.#mine(p) });
      }
    });
    await this.#sleep(this.timings.reveal, signal);
  }

  /** The phony left for good: the word is shown, nobody scores. */
  async #gone(r: Round, signal: AbortSignal): Promise<void> {
    const party = this.party;
    this.#setPhase("round", "gone");
    this.#turn = undefined;
    this.#earned = new Map();
    const word = r.board[r.secret]!.word;
    const phony = this.#who(r.phony);
    party.withTv(() => {
      party.room.set({ reveal: { secret: r.secret, word, gone: true, phony } });
      party.screen.set({ stage: "gone", secret: r.secret, word, phony });
      for (const p of r.players) if (party.player(p.id)) p.state.replace({ task: "result", earned: null, secret: r.secret, word, gone: true, phony: phony.name, ...this.#card(r, p), ...this.#mine(p) });
    });
    await this.#sleep(this.timings.reveal, signal);
  }

  // -------------------------------------------------------------------------
  // Scores and the end

  #lines(before?: ReadonlyMap<string, number>): ScoreLine[] {
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
    const lines = this.#lines(before).map((l) => ({ ...l, color: COLORS[this.colorOf(l.id)], earned: this.#earned.get(l.id) ?? null }));
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

  /** The awards: the most points as the phony, the most accusations that hit, the most deletions; each only when earned. */
  #awards(): Record<string, { who: { id: string; name: string; color: string }; n: number } | null> {
    const party = this.party;
    const here = [...this.#totals].filter(([id]) => party.player(id));
    const best = (k: keyof Totals) => {
      const top = Math.max(0, ...here.map(([, t]) => t[k]));
      if (top <= 0) return null;
      const id = here.find(([, t]) => t[k] === top)![0];
      return { who: this.#who(id), n: top };
    };
    return { liar: best("phony"), eye: best("hits"), hand: best("deletions") };
  }

  #final(): ScoreLine[] {
    const party = this.party;
    this.#round = undefined;
    this.#turn = undefined;
    this.#setPhase("final");
    const table = this.#lines();
    const lines = table.map((l) => ({ ...l, color: COLORS[this.colorOf(l.id)] }));
    const awards = this.#awards();
    party.withTv(() => {
      this.#room({ phase: "final", maxPlayers: party.maxPlayers });
      this.#screen({ phase: "final", lines, awards, ...this.settings });
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
