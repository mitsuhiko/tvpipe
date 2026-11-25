/**
 * Classes on a party, for 2 to 10 players (docs/classes-design.md): a
 * round is a letter (the drawer stops the alphabet), today's columns on
 * the board, everyone writing an answer per column on their phone, the
 * school bell, then the grading column by column (the room doubts and
 * stars, anyone looks an answer up in Wikipedia, the red pen marks the
 * points), and the round's report; at the end the report cards and the
 * best answers of the day.
 *
 * The host is the only authority: phones and the TV only ever get views
 * (§7): `party.room` (every phone), `player.state` (one phone),
 * `party.screen` (the TV: the room's fields, plus `players`, `progress`,
 * `bellAt`, and its own `wiki` with `at`: the driver's top block). Nobody gets another
 * player's text before grading, and every phase, result and score
 * reaches the phones when the TV shows it (`party.withTv`).
 */

import { cleanText, Emitter, PartyError, type Json, type Party, type Player, type Sender } from "@tvpipe/party";

import { groupAnswers, type Same } from "./match.ts";
import {
  autoStrike,
  columnKey,
  columnPoints,
  deal,
  DEFAULT_SETTINGS,
  fillColumn,
  hasPlaceholder,
  gradeOf,
  letters,
  MAX_ANSWER,
  MIN_PLAYERS,
  ranks,
  readSettings,
  remarks,
  shuffle,
  stampOf,
  struckByRoom,
  SUBJECT_IDS,
  progressOf,
  type Auto,
  type CardStats,
  type Column,
  type Dealt,
  type Lang,
  type Settings,
  type Subject,
} from "./rules.ts";
import { cleanTitle, type WikiArticle, type WikiError, type WikiFound, type WikiResult, type WikiSource } from "./wiki.ts";

export interface Timings {
  /** The alphabet's run: ms per letter. */
  step: number;
  /** The run starts this long after the TV shows the frieze. */
  runLead: number;
  /** No stop by then (from the run's start): the host stops it. */
  letterMax: number;
  /** The letter chalked huge, before the board. */
  letterShown: number;
  /** The columns written on the board. */
  board: number;
  /** Writing, ms; null: the room's `time` setting. */
  write: number | null;
  /** After a Stop: this long left (if sooner). */
  stopLeft: number;
  /** The school bell. */
  bell: number;
  /** Drafts accepted after the deadline. */
  draftGrace: number;
  /** The vote: a base, per answer open to a vote, at most; with nothing to vote on. */
  vote: number;
  votePer: number;
  voteMax: number;
  voteEmpty: number;
  /** An article opened, followed, searched or switched: the vote lasts at least this long from when the TV shows it, adding at most `wikiMaxAdd` a column. */
  wikiMin: number;
  wikiMaxAdd: number;
  /** One lookup (open, follow, search, switch) a player every this many ms, at most `wikiPer` a column; Back and `wiki-at` are free. */
  wikiGap: number;
  wikiPer: number;
  /** The red pen: a base and per line. */
  marked: number;
  markedPer: number;
  report: number;
}

export const DEFAULT_TIMINGS: Timings = {
  step: 110,
  runLead: 400,
  letterMax: 10_000,
  letterShown: 1800,
  board: 3000,
  write: null,
  stopLeft: 10_000,
  bell: 2500,
  draftGrace: 500,
  vote: 25_000,
  votePer: 2000,
  voteMax: 50_000,
  voteEmpty: 5000,
  wikiMin: 20_000,
  wikiMaxAdd: 90_000,
  wikiGap: 2000,
  wikiPer: 15,
  marked: 2000,
  markedPer: 600,
  report: 8000,
};

/** For trying the game (`?fast`): everything short. */
export const FAST_TIMINGS: Timings = {
  ...DEFAULT_TIMINGS,
  letterMax: 5000,
  letterShown: 1000,
  board: 1500,
  write: 40_000,
  stopLeft: 5000,
  bell: 1500,
  vote: 10_000,
  votePer: 1000,
  voteMax: 20_000,
  voteEmpty: 2500,
  wikiMin: 10_000,
  wikiMaxAdd: 45_000,
  marked: 1200,
  markedPer: 300,
  report: 4000,
};

export type Phase = "lobby" | "letter" | "board" | "write" | "bell" | "grade" | "report" | "final";
export type Stage = "vote" | "marked";

export interface GameOptions {
  /** The column lists per language (`data/columns.txt`, …), parsed. */
  columns: Partial<Record<Lang, readonly Column[]>>;
  lang?: Lang | undefined;
  settings?: Partial<Settings> | undefined;
  minPlayers?: number | undefined;
  timings?: Partial<Timings> | undefined;
  rng?: (() => number) | undefined;
  /** Column keys the room played recently, per language, the oldest first (the host page keeps them). */
  recent?: Partial<Record<Lang, readonly string[]>> | undefined;
  /** Wikipedia (default: none: lookups say it is not reachable). */
  wiki?: WikiSource | undefined;
  /** Bots draw last. */
  isBot?: ((p: Player) => boolean) | undefined;
}

export interface ScoreLine {
  id: string;
  name: string;
  total: number;
  rank: number;
}

export interface GameEvents {
  phase: [phase: Phase, stage: Stage | null];
  end: [scores: ScoreLine[]];
  settings: [settings: Settings & { lang: Lang }];
  /** A round's columns were dealt: the room has played them. */
  dealt: [lang: Lang, keys: string[]];
}

interface AnswerFull {
  id: string;
  who: string[];
  texts: string[];
  same?: Same | undefined;
  auto?: Auto | undefined;
}

/** The history's steps: an article (or what was not found) and the search it came from. */
interface WikiEntry {
  /** The answer the reader was opened for. */
  id: string;
  query: string;
  article?: WikiArticle | undefined;
  error?: WikiError | undefined;
  results: WikiResult[];
  /** The article's index in `results`, -1 when it is not one of them. */
  pick: number;
}

/** The room's reader in a column's vote. */
interface WikiNav {
  stack: WikiEntry[];
  loading: { id: string; query: string } | null;
  /** The driver: who navigated last. */
  by: string;
  /** The driver's top block (the TV's view only). */
  at: number;
  seq: number;
}

/** History and cache sizes (§3.5). */
const WIKI_HISTORY = 20;
const WIKI_CACHE = 20;

interface Mark {
  id: string;
  doubts: number;
  of: number;
  struck: boolean;
  points: number;
  stars: number;
}

interface RoundState {
  seats: string[];
  drawer: string;
  run: { start: number; step: number; seq: string[] };
  letter: string | null;
  columns: Dealt[];
  drafts: Map<string, string[]>;
  deadline: number;
  stopBy: string | null;
  ended: boolean;
  points: Map<string, number>;
  twenties: Map<string, number>;
}

interface GradeState {
  col: number;
  answers: AnswerFull[];
  stage: Stage;
  doubts: Map<string, Set<string>>;
  stars: Map<string, string>;
  done: Set<string>;
  base: number;
  deadline: number;
  wiki: WikiNav | null;
  lookups: Map<string, { n: number; last: number }>;
  skipped: boolean;
  earned: Map<string, number>;
}

interface Stats {
  subjects: Map<Subject, { points: number; cols: number }>;
  stars: number;
  twenties: number;
  shared: number;
  facts: number;
  empty: number;
  taste: number;
}

interface Best {
  id: string;
  text: string;
  column: string;
  subject: string;
  stars: number;
}

const SOMEONE: Record<Lang, string> = { en: "Someone", de: "Jemand", at: "Jemand" };

function obj(d: Json): Record<string, Json> {
  return typeof d === "object" && d !== null && !Array.isArray(d) ? d : {};
}

function playerOnly(from: Sender): Player {
  if (from.role !== "player") throw new PartyError("not-player", "Players only");
  return from;
}

export class Classes extends Emitter<GameEvents> {
  readonly party: Party;
  readonly minPlayers: number;
  timings: Timings;
  /** A fixed letter for the next round (the live check's screenshots), then cleared. */
  script: { letter?: string | undefined; columns?: readonly string[] | undefined } | undefined;
  readonly #rng: () => number;
  readonly #columns = new Map<Lang, readonly Column[]>();
  readonly #recent: Partial<Record<Lang, string[]>>;
  readonly #wiki: WikiSource | undefined;
  /** The last articles read (by language and title), newest last. */
  readonly #cache = new Map<string, WikiArticle>();
  readonly #isBot: (p: Player) => boolean;
  #lang: Lang;
  #settings: Omit<Settings, "late">;
  /** Handwriting per player id (0–9, by join order), kept for the game's people who left. */
  readonly #hands = new Map<string, number>();
  readonly #names = new Map<string, string>();
  /** Points per player id: the players in the game. */
  readonly totals = new Map<string, number>();
  readonly #stats = new Map<string, Stats>();
  #best: (Best & { seq: number })[] = [];
  #used: string[] = [];
  readonly #played = new Set<string>();
  #phase: Phase = "lobby";
  #stage: Stage | null = null;
  /** The column being graded, for the phase events. */
  #col: number | null = null;
  #running = false;
  #abort = new AbortController();
  #game = 0;
  #roundNo = 0;
  #drawTurn = 0;
  #r: RoundState | null = null;
  #g: GradeState | null = null;
  readonly #kicks = new Set<() => void>();

  constructor(party: Party, options: GameOptions) {
    super();
    this.party = party;
    this.minPlayers = options.minPlayers ?? MIN_PLAYERS;
    this.timings = { ...DEFAULT_TIMINGS, ...options.timings };
    this.#rng = options.rng ?? Math.random;
    this.#wiki = options.wiki;
    this.#isBot = options.isBot ?? (() => false);
    this.#recent = Object.fromEntries(Object.entries(options.recent ?? {}).map(([l, keys]) => [l, [...(keys ?? [])]]));
    for (const [l, list] of Object.entries(options.columns) as [Lang, readonly Column[]][]) if (list.length > 0) this.#columns.set(l, list);
    this.#lang = options.lang && this.#columns.has(options.lang) ? options.lang : ([...this.#columns.keys()][0] ?? "en");
    if (!this.#columns.has(this.#lang)) throw new Error("classes: no columns");
    const { late, ...rest } = { ...DEFAULT_SETTINGS, ...options.settings };
    this.#settings = rest;
    party.lateJoin = late;
  }

  get settings(): Settings {
    const late = this.party.lateJoin;
    return { ...this.#settings, late: late === "closed" || late === "wait" ? late : "open" };
  }

  get lang(): Lang {
    return this.#lang;
  }

  get langs(): Lang[] {
    return [...this.#columns.keys()];
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

  get round(): number {
    return this.#roundNo;
  }

  get rounds(): number {
    return this.#settings.rounds;
  }

  /** The round's letter and columns (tests, the host page). */
  get current(): { letter: string | null; columns: { subject: string; text: string; rule?: string }[]; col: number | null } | null {
    const r = this.#r;
    return r ? { letter: r.letter, columns: r.columns.map((c) => this.#columnView(c)), col: this.#g?.col ?? null } : null;
  }

  /** "Skip column" works now: a column is being graded. */
  get canSkip(): boolean {
    return this.#running && this.#phase === "grade" && this.#g !== null && !this.#g.skipped;
  }

  /** "End the round" works now. */
  get canEnd(): boolean {
    return this.#running && this.#r !== null && !this.#r.ended && ["letter", "board", "write", "bell", "grade"].includes(this.#phase);
  }

  /** Shows the lobby and handles the phones' actions. */
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
    party.handle("settings", (d, from) => {
      vipOnly(from);
      if (this.#running) throw new PartyError("running", "Not during a game");
      const got = readSettings(d, this.langs);
      if (!got.ok) throw new PartyError("bad-settings", got.error);
      this.configure(got.settings);
      return null;
    });
    party.handle("stop-letter", (_d, from, info) => this.#stopLetter(playerOnly(from), info.sentAt));
    party.handle("draft", (d, from) => this.#draft(playerOnly(from), obj(d)));
    party.handle("stop", (_d, from) => this.#stopWriting(playerOnly(from)));
    party.handle("doubt", (d, from) => this.#doubt(playerOnly(from), obj(d)));
    party.handle("star", (d, from) => this.#star(playerOnly(from), obj(d)));
    party.handle("done", (d, from) => this.#done(playerOnly(from), obj(d)));
    party.handle("wiki", (d, from) => this.#lookup(playerOnly(from), obj(d)));
    party.handle("wiki-go", (d, from) => this.#wikiGo(playerOnly(from), obj(d)));
    party.handle("wiki-back", (_d, from) => this.#wikiBack(playerOnly(from)));
    party.handle("wiki-at", (d, from) => this.#wikiAt(playerOnly(from), obj(d)));
    party.handle("wiki-close", (_d, from) => {
      playerOnly(from);
      const g = this.#g;
      if (g && g.stage === "vote" && this.#phase === "grade" && g.wiki) {
        g.wiki = null;
        party.withTv(() => this.#put({ wiki: null }));
      }
      return null;
    });
    party.on("join", (p) => {
      this.#names.set(p.id, p.name);
      if (!this.#hands.has(p.id)) this.#hands.set(p.id, this.#freeHand());
      this.#put({ people: this.#people() });
      // Latecomers straight away: in the game at once, in the round when it is before the bell.
      if (this.#running && party.lateJoin === "open" && p.waiting) this.#admit(p);
      p.state.replace(this.#stateOf(p));
    });
    party.on("leave", (p) => {
      if (!this.totals.has(p.id)) this.#hands.delete(p.id);
      this.#put({ people: this.#people() });
      this.#kick();
    });
    party.on("away", () => this.#kick());
    party.on("active", (p) => p.state.replace(this.#stateOf(p)));
    this.#lobby();
  }

  /** Changes the language, the settings or the timings before a game; every phone and the TV follow. */
  configure(o: Partial<Settings> & { lang?: Lang | undefined; timings?: Partial<Timings> | undefined }): void {
    if (this.#running) throw new PartyError("running", "Not during a game");
    const { timings, ...rest } = o;
    const clean = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
    const got = readSettings(clean, this.langs);
    if (!got.ok) throw new PartyError("bad-settings", got.error);
    const was = JSON.stringify([this.#lang, this.settings]);
    if (timings) this.timings = { ...this.timings, ...timings };
    const { lang, late, ...s } = got.settings;
    if (lang) this.#lang = lang;
    if (late) this.party.lateJoin = late;
    this.#settings = { ...this.#settings, ...s };
    if (this.#phase === "lobby" || this.#phase === "final") this.#put({ lang: this.#lang, settings: this.settings, rounds: this.rounds });
    if (JSON.stringify([this.#lang, this.settings]) !== was) this.emit("settings", { ...this.settings, lang: this.#lang });
  }

  /** Skips the column being graded (no points, not on the cards); in the marks, goes on to the next. False when there is none. */
  skipColumn(): boolean {
    if (!this.canSkip) return false;
    this.#g!.skipped = true;
    this.#kick();
    return true;
  }

  /** Ends the round: what was graded counts, the rest is not graded; the report comes. */
  endRound(): boolean {
    if (!this.canEnd) return false;
    this.#r!.ended = true;
    this.#kick();
    return true;
  }

  /** Ends a running game at once (the party stays): the lobby, nothing of the old game after this. */
  close(): void {
    if (!this.#running) return;
    this.#game++;
    this.#abort.abort();
    this.#stop();
    this.#lobby();
  }

  #stop(): void {
    this.#r = null;
    this.#g = null;
    this.#stage = null;
    this.#running = false;
    this.party.inProgress = false;
    for (const p of this.party.players) this.party.activate(p);
  }

  // -------------------------------------------------------------------------
  // Views

  #setPhase(phase: Phase, stage: Stage | null = null, col: number | null = null): void {
    const changed = phase !== this.#phase || stage !== this.#stage || col !== this.#col;
    this.#col = col;
    this.#phase = phase;
    this.#stage = stage;
    if (changed) queueMicrotask(() => this.emit("phase", phase, stage));
  }

  #freeHand(): number {
    const used = new Set([...this.party.players.map((p) => this.#hands.get(p.id)), ...[...this.totals.keys()].map((id) => this.#hands.get(id))]);
    for (let i = 0; i < 10; i++) if (!used.has(i)) return i;
    return this.#hands.size % 10;
  }

  #name(id: string): string {
    return this.party.player(id)?.name ?? this.#names.get(id) ?? SOMEONE[this.#lang];
  }

  /** Everyone in the room, and everyone who played this game (away or gone). */
  #people(): Record<string, { name: string; hand: number }> {
    const out: Record<string, { name: string; hand: number }> = {};
    for (const p of this.party.players) out[p.id] = { name: p.name, hand: this.#hands.get(p.id) ?? 0 };
    if (this.#running || this.#phase === "final") for (const id of this.totals.keys()) out[id] ??= { name: this.#name(id), hand: this.#hands.get(id) ?? 0 };
    return out;
  }

  #base(): Record<string, unknown> {
    return {
      lang: this.#lang,
      langs: this.langs,
      settings: this.settings,
      minPlayers: this.minPlayers,
      people: this.#people(),
      round: this.#roundNo,
      rounds: this.rounds,
      used: [...this.#used],
    };
  }

  /** The TV's reader: the room's, with the driver's top block. */
  #tvWiki(w: unknown): unknown {
    if (!w || typeof w !== "object") return w;
    return { ...(w as object), at: this.#g?.wiki?.at ?? 0 };
  }

  /** A new phase: the room's view and the TV's from scratch. */
  #reset(fields: Record<string, unknown>, screen: Record<string, unknown> = {}): void {
    const room = { ...this.#base(), ...fields };
    this.party.room.replace(room);
    this.party.screen.replace({ ...room, ...("wiki" in fields ? { wiki: this.#tvWiki(fields["wiki"]) } : {}), ...screen });
  }

  /** Changes fields of both (`undefined` removes one). */
  #put(fields: Record<string, unknown>, screen: Record<string, unknown> = {}): void {
    this.party.room.set(fields);
    this.party.screen.set({ ...fields, ...("wiki" in fields ? { wiki: this.#tvWiki(fields["wiki"]) } : {}), ...screen });
  }

  #rankOf(id: string): number {
    const t = this.totals.get(id) ?? 0;
    return 1 + [...this.totals].filter(([x, v]) => this.party.player(x) && v > t).length;
  }

  #mine(p: Player): Record<string, unknown> {
    return this.totals.has(p.id) ? { total: this.totals.get(p.id)!, rank: this.#rankOf(p.id) } : {};
  }

  #writeState(r: RoundState, id: string): Record<string, unknown> {
    const answers = r.drafts.get(id) ?? r.columns.map(() => "");
    return { answers, filled: answers.length > 0 && answers.every((a) => a !== ""), canStop: this.#settings.stop && r.stopBy === null && this.#phase === "write" };
  }

  /** A player's whole state for the phase. */
  #stateOf(p: Player): Record<string, unknown> {
    if (this.#phase === "lobby") return { task: "lobby" };
    if (this.#phase === "final") return { task: "final", ...this.#mine(p) };
    if (p.waiting) return { task: "wait" };
    const r = this.#r;
    if (!r || !r.seats.includes(p.id)) return { task: "watch", ...this.#mine(p) };
    switch (this.#phase) {
      case "letter":
        // Only the drawer draws; the others write next (their fields come with the board).
        return { task: p.id === r.drawer ? "draw" : "write", ...this.#mine(p) };
      case "board":
      case "write":
      case "bell":
        return { task: "write", ...this.#writeState(r, p.id), ...this.#mine(p) };
      case "grade": {
        const g = this.#g;
        const answers = r.drafts.get(p.id) ?? r.columns.map(() => "");
        if (!g) return { task: "grade", answers, ...this.#mine(p) };
        if (g.stage === "vote") return { task: "grade", answers, ...this.#voteState(g, p.id), ...this.#mine(p) };
        return { task: "grade", answers, earned: g.earned.get(p.id) ?? 0, ...this.#mine(p) };
      }
      case "report":
        return { task: "report", earned: r.points.get(p.id) ?? 0, ...this.#mine(p) };
      default:
        return { task: "watch", ...this.#mine(p) };
    }
  }

  #voteState(g: GradeState, id: string): Record<string, unknown> {
    return { doubts: [...(g.doubts.get(id) ?? [])], star: g.stars.get(id) ?? null, done: g.done.has(id), lookups: this.timings.wikiPer - (g.lookups.get(id)?.n ?? 0) };
  }

  #states(): void {
    for (const p of this.party.players) p.state.replace(this.#stateOf(p));
  }

  #lobby(): void {
    this.#setPhase("lobby");
    this.#reset({ phase: "lobby" });
    this.#states();
  }

  /** A column as the views have it: its rule as the tag (`rule:two`), like an answer's `auto`. */
  #columnView(c: Dealt): { subject: string; text: string; rule?: string } {
    return { subject: c.subject, text: c.text, ...(c.rule ? { rule: `rule:${c.rule}` } : {}) };
  }

  #answerView(a: AnswerFull): Record<string, unknown> {
    return { id: a.id, who: a.who, texts: a.texts, ...(a.same ? { same: a.same } : {}), ...(a.auto ? { auto: a.auto } : {}) };
  }

  // -------------------------------------------------------------------------
  // Waiting

  #kick(): void {
    const ks = [...this.#kicks];
    this.#kicks.clear();
    for (const k of ks) k();
  }

  /** Waits until `at()` on `clock` (it may move), `done()` or the signal; re-checked on every kick. */
  async #until(at: () => number, done: () => boolean, signal: AbortSignal, clock: () => number = () => this.party.now()): Promise<void> {
    while (!signal.aborted && !done()) {
      const left = at() - clock();
      if (left <= 0) return;
      await new Promise<void>((resolve) => {
        const end = () => {
          clearTimeout(t);
          this.#kicks.delete(end);
          signal.removeEventListener("abort", end);
          resolve();
        };
        const t = setTimeout(end, left);
        this.#kicks.add(end);
        signal.addEventListener("abort", end, { once: true });
      });
    }
  }

  #sleep(ms: number, done: () => boolean, signal: AbortSignal): Promise<void> {
    const at = this.party.now() + ms;
    return this.#until(() => at, done, signal);
  }

  // -------------------------------------------------------------------------
  // A game

  /**
   * Plays a whole game with the players who are there (and those who
   * join between rounds). It ends early, to the final screen, when fewer
   * than {@link minPlayers} are left in it at the start of a round.
   * Closed ({@link close}), it returns the scores so far and shows nothing.
   */
  async play(): Promise<ScoreLine[]> {
    const party = this.party;
    const game = ++this.#game;
    this.#running = true;
    this.#abort = new AbortController();
    const signal = this.#abort.signal;
    party.inProgress = true;
    this.totals.clear();
    this.#stats.clear();
    this.#best = [];
    this.#used = [];
    this.#played.clear();
    this.#roundNo = 0;
    try {
      for (let r = 1; r <= this.rounds; r++) {
        for (const p of party.players) {
          if (p.waiting) party.activate(p);
          if (!this.totals.has(p.id)) this.totals.set(p.id, 0);
        }
        if (this.#inGame().length < this.minPlayers) break;
        this.#roundNo = r;
        await this.#playRound(signal);
        if (signal.aborted) break;
      }
      return signal.aborted ? this.#lines() : this.#final();
    } finally {
      if (this.#game === game) this.#stop();
    }
  }

  /**
   * A latecomer straight into the game (`late: open`): 0 points; before the
   * bell (letter, board, write) a seat in this round with a desk on the TV
   * and the time that is left; after it, watching until the next letter.
   */
  #admit(p: Player): void {
    this.party.activate(p);
    if (!this.totals.has(p.id)) this.totals.set(p.id, 0);
    const r = this.#r;
    if (!r || r.ended || r.seats.includes(p.id) || !["letter", "board", "write"].includes(this.#phase)) return;
    r.seats.push(p.id);
    if (r.columns.length > 0) r.drafts.set(p.id, r.columns.map(() => ""));
    this.party.screen.set({ players: [...r.seats], ...(this.#phase === "write" ? { progress: this.#progress(r) } : {}) });
  }

  #inGame(): Player[] {
    return this.party.players.filter((p) => this.totals.has(p.id));
  }

  #statsOf(id: string): Stats {
    let s = this.#stats.get(id);
    if (!s) this.#stats.set(id, (s = { subjects: new Map(), stars: 0, twenties: 0, shared: 0, facts: 0, empty: 0, taste: 0 }));
    return s;
  }

  /** The drawer: in turn by join order, away players and bots last. */
  #drawer(seats: Player[]): Player {
    const n = seats.length;
    const turn = this.#drawTurn++ % n;
    const order = [...seats.slice(turn), ...seats.slice(0, turn)];
    return order.find((p) => p.connected && !this.#isBot(p)) ?? order.find((p) => p.connected) ?? order[0]!;
  }

  async #playRound(signal: AbortSignal): Promise<void> {
    const party = this.party;
    const t = this.timings;
    const players = this.#inGame();
    const seats = players.map((p) => p.id);
    let available = letters(this.#lang, this.#settings.letters).filter((l) => !this.#used.includes(l));
    if (available.length === 0) available = letters(this.#lang, this.#settings.letters);
    const drawer = this.#drawer(players);
    const r: RoundState = {
      seats,
      drawer: drawer.id,
      run: { start: party.deadline(t.runLead), step: t.step, seq: shuffle(available, this.#rng) },
      letter: null,
      columns: [],
      drafts: new Map(),
      deadline: 0,
      stopBy: null,
      ended: false,
      points: new Map(),
      twenties: new Map(),
    };
    this.#r = r;
    this.#g = null;
    const screenNow = () => party.screenNow();

    // The letter.
    this.#setPhase("letter");
    party.withTv(() => {
      this.#reset({ phase: "letter", drawer: r.drawer, run: r.run }, { players: seats });
      this.#states();
    });
    const scripted = this.script?.letter;
    if (scripted && this.script) this.script.letter = undefined;
    await this.#until(() => r.run.start + t.letterMax, () => r.letter !== null || r.ended, signal, screenNow);
    if (signal.aborted) return;
    // Ended before a letter was chosen: the round is called off, the letters stay for later rounds.
    if (r.letter === null && !r.ended) r.letter = r.run.seq[Math.floor(this.#rng() * r.run.seq.length)]!;
    if (scripted && r.letter !== null) r.letter = scripted;
    if (r.letter !== null) {
      this.#used.push(r.letter);
      party.withTv(() => this.#put({ letter: r.letter, used: [...this.#used] }));
      if (!r.ended) await this.#sleep(t.letterShown, () => r.ended, signal);
      if (signal.aborted) return;
    }

    // The board.
    if (!r.ended) {
      const dealt = deal(this.#columns.get(this.#lang)!, {
        letter: r.letter!,
        n: this.#settings.columns,
        mix: this.#settings.mix,
        content: this.#settings.content,
        classic: this.#settings.classic,
        lang: this.#lang,
        rng: this.#rng,
        played: this.#played,
        recent: this.#recent[this.#lang] ?? [],
        names: players.map((p) => p.name),
      });
      r.columns = dealt.columns;
      // Scripted columns (the live check's pictures, the longest texts): these, by their text in the list, in order.
      const wanted = this.script?.columns;
      if (wanted && this.script) {
        this.script.columns = undefined;
        const list = this.#columns.get(this.#lang)!;
        const names = players.map((p) => p.name);
        const picked = wanted.map((text) => list.find((c) => c.text === text)).filter((c): c is Column => !!c);
        if (picked.length > 0)
          r.columns = picked.map((c, k) => ({ column: c, text: hasPlaceholder(c.text) ? fillColumn(c.text, names[k % names.length] ?? "?", this.#lang) : c.text, subject: c.subject, ...(c.rule ? { rule: c.rule } : {}) }));
      }
      const keys = r.columns.map((c) => columnKey(c.column));
      for (const k of keys) this.#played.add(k);
      const recent = (this.#recent[this.#lang] ??= []);
      for (const k of keys) {
        const i = recent.indexOf(k);
        if (i >= 0) recent.splice(i, 1);
        recent.push(k);
      }
      this.emit("dealt", this.#lang, keys);
      for (const id of seats) r.drafts.set(id, r.columns.map(() => ""));
      this.#setPhase("board");
      party.withTv(() => {
        this.#reset({ phase: "board", letter: r.letter, columns: r.columns.map((c) => this.#columnView(c)) }, { players: seats });
        this.#states();
      });
      await this.#sleep(t.board, () => r.ended, signal);
      if (signal.aborted) return;
    }

    // Writing, to the bell.
    if (!r.ended) {
      r.deadline = party.deadline(t.write ?? this.#settings.time * 1000);
      this.#setPhase("write");
      party.withTv(() => {
        this.#put({ phase: "write", deadline: r.deadline }, { progress: this.#progress(r) });
        this.#states();
      });
      await this.#until(() => r.deadline, () => r.ended, signal, screenNow);
      if (signal.aborted) return;
      if (r.ended) r.deadline = Math.min(r.deadline, party.screenNow());
      this.#setPhase("bell");
      party.withTv(() => {
        this.#put({ phase: "bell", deadline: r.deadline }, { bellAt: r.deadline });
        this.#states();
      });
      await this.#sleep(Math.max(t.bell, t.draftGrace + party.tvDelay), () => false, signal);
      if (signal.aborted) return;
    }

    // Grading, column by column.
    for (let i = 0; i < r.columns.length && !r.ended; i++) {
      await this.#grade(r, i, signal);
      if (signal.aborted) return;
    }
    this.#g = null;

    // The report.
    this.#setPhase("report");
    party.withTv(() => {
      this.#reset({ phase: "report", letter: r.letter ?? undefined, columns: r.columns.map((c) => this.#columnView(c)), scores: this.#scores(r) }, { players: seats });
      this.#states();
    });
    await this.#sleep(t.report, () => false, signal);
  }

  #progress(r: RoundState): Record<string, number[]> {
    return Object.fromEntries(r.seats.map((id) => [id, (r.drafts.get(id) ?? []).map(progressOf)]));
  }

  /** A column's answers: the same ones grouped (among answers struck alike), each empty one on its own, in seat order. */
  #answersOf(r: RoundState, i: number): AnswerFull[] {
    const dealt = r.columns[i]!;
    const items = r.seats.map((id) => {
      const text = r.drafts.get(id)?.[i] ?? "";
      return { id, text, auto: autoStrike(text, r.letter!, dealt.rule, this.#lang) };
    });
    const out: { first: number; a: Omit<AnswerFull, "id"> }[] = [];
    const classes = new Map<string, typeof items>();
    items.forEach((it) => {
      if (it.auto === "empty") return;
      const k = it.auto ?? "";
      if (!classes.has(k)) classes.set(k, []);
      classes.get(k)!.push(it);
    });
    for (const list of classes.values()) {
      for (const g of groupAnswers(
        list.map((x) => x.text),
        this.#lang,
      )) {
        const members = g.members.map((m) => list[m]!);
        out.push({ first: r.seats.indexOf(members[0]!.id), a: { who: members.map((m) => m.id), texts: members.map((m) => m.text), ...(g.same ? { same: g.same } : {}), ...(members[0]!.auto ? { auto: members[0]!.auto } : {}) } });
      }
    }
    items.forEach((it, k) => {
      if (it.auto === "empty") out.push({ first: k, a: { who: [it.id], texts: [""], auto: "empty" } });
    });
    out.sort((a, b) => a.first - b.first);
    return out.map((x, k) => ({ id: `${this.#roundNo}-${i}-${k + 1}`, ...x.a }));
  }

  #allDone(r: RoundState, g: GradeState): boolean {
    const here = r.seats.map((id) => this.party.player(id)).filter((p): p is Player => !!p && p.connected);
    return here.length > 0 && here.every((p) => g.done.has(p.id));
  }

  async #grade(r: RoundState, i: number, signal: AbortSignal): Promise<void> {
    const party = this.party;
    const t = this.timings;
    const dealt = r.columns[i]!;
    const answers = this.#answersOf(r, i);
    const open = answers.filter((a) => !a.auto).length;
    const ms = open === 0 ? t.voteEmpty : Math.min(t.voteMax, t.vote + t.votePer * open);
    const deadline = party.deadline(ms);
    const g: GradeState = { col: i, answers, stage: "vote", doubts: new Map(), stars: new Map(), done: new Set(), base: deadline, deadline, wiki: null, lookups: new Map(), skipped: false, earned: new Map() };
    this.#g = g;
    this.#setPhase("grade", "vote", i);
    party.withTv(() => {
      this.#reset(
        { phase: "grade", letter: r.letter, columns: r.columns.map((c) => this.#columnView(c)), col: i, stage: "vote", answers: answers.map((a) => this.#answerView(a)), done: [], deadline, wiki: null },
        { players: r.seats },
      );
      this.#states();
    });
    await this.#until(() => g.deadline, () => g.skipped || r.ended || this.#allDone(r, g), signal, () => party.screenNow());
    if (signal.aborted) return;
    g.wiki = null;
    // Skipped, or the round ended: this column is not graded.
    if (g.skipped || r.ended) return;

    // The marks.
    const seatsIn = r.seats.filter((id) => party.player(id));
    const graded = answers.map((a) => {
      const others = seatsIn.filter((id) => !a.who.includes(id));
      const doubts = a.auto ? 0 : others.filter((id) => g.doubts.get(id)?.has(a.id)).length;
      return { ...a, of: others.length, doubts, struck: !a.auto && struckByRoom(doubts, others.length) };
    });
    const points = columnPoints(graded);
    const starsOn = new Map<string, number>();
    for (const [, id] of g.stars) starsOn.set(id, (starsOn.get(id) ?? 0) + 1);
    const marks: Mark[] = graded.map((a) => ({ id: a.id, doubts: a.doubts, of: a.of, struck: a.struck, points: points.get(a.id) ?? 0, stars: starsOn.get(a.id) ?? 0 }));
    for (const a of graded) {
      const pts = points.get(a.id) ?? 0;
      const stars = starsOn.get(a.id) ?? 0;
      for (const id of a.who) {
        g.earned.set(id, pts);
        if (this.totals.has(id)) this.totals.set(id, this.totals.get(id)! + pts);
        r.points.set(id, (r.points.get(id) ?? 0) + pts);
        const s = this.#statsOf(id);
        const sub = s.subjects.get(dealt.subject) ?? { points: 0, cols: 0 };
        s.subjects.set(dealt.subject, { points: sub.points + pts, cols: sub.cols + 1 });
        s.stars += stars;
        if (pts === 20) {
          s.twenties++;
          r.twenties.set(id, (r.twenties.get(id) ?? 0) + 1);
        }
        if (a.who.length > 1 && !a.auto) s.shared++;
        if (a.struck) s.facts++;
        if (a.auto === "empty") s.empty++;
      }
      if (stars > 0) this.#best.push({ id: a.who[0]!, text: a.texts[0]!, column: dealt.text, subject: dealt.subject, stars, seq: this.#best.length });
    }
    for (const [by, id] of g.stars) if ((starsOn.get(id) ?? 0) > 1) this.#statsOf(by).taste++;
    g.stage = "marked";
    this.#setPhase("grade", "marked", i);
    party.withTv(() => {
      this.#put({ stage: "marked", marks, wiki: null, deadline: undefined, done: [...g.done] });
      this.#states();
    });
    await this.#sleep(t.marked + t.markedPer * answers.length, () => g.skipped || r.ended, signal);
  }

  // -------------------------------------------------------------------------
  // Actions

  #stopLetter(p: Player, sentAt: number): unknown {
    const r = this.#r;
    if (!r || this.#phase !== "letter" || r.letter !== null || r.ended) throw new PartyError("too-late", "The letter is chosen");
    if (p.id !== r.drawer) throw new PartyError("not-drawer", "Someone else stops the alphabet");
    const k = Math.max(0, Math.floor((sentAt - r.run.start) / r.run.step));
    r.letter = r.run.seq[k % r.run.seq.length]!;
    this.#kick();
    // Not the letter: the drawer learns it with the TV.
    return null;
  }

  #seated(p: Player): RoundState {
    const r = this.#r;
    if (!r || !r.seats.includes(p.id) || p.waiting) throw new PartyError("not-playing", "Not in this round");
    return r;
  }

  #draft(p: Player, d: Record<string, Json>): unknown {
    const r = this.#seated(p);
    if ((this.#phase !== "write" && this.#phase !== "bell") || this.party.now() > r.deadline + this.timings.draftGrace) throw new PartyError("too-late", "Pens down");
    const i = d["i"];
    const raw = d["text"];
    if (typeof i !== "number" || !Number.isInteger(i) || i < 0 || i >= r.columns.length || typeof raw !== "string" || raw.length > 400) throw new PartyError("bad-draft", "A column and a text");
    const moderated = raw.trim() === "" ? "" : this.party.moderate(raw, "answer", p);
    if (moderated === false) throw new PartyError("bad-draft", "Write something else");
    const text = cleanText(moderated, MAX_ANSWER);
    const answers = r.drafts.get(p.id) ?? r.columns.map(() => "");
    if (answers[i] !== text) {
      answers[i] = text;
      r.drafts.set(p.id, answers);
      this.party.screen.set({ progress: this.#progress(r) });
    }
    p.state.set(this.#writeState(r, p.id));
    return { text };
  }

  #stopWriting(p: Player): unknown {
    const r = this.#seated(p);
    if (this.#phase !== "write") throw new PartyError("too-late", "Pens down");
    if (!this.#settings.stop) throw new PartyError("off", "Stop is off");
    if (r.stopBy !== null) throw new PartyError("stopped", "Someone stopped already");
    const mine = r.drafts.get(p.id) ?? [];
    if (mine.length === 0 || mine.some((a) => a === "")) throw new PartyError("not-filled", "Fill every column first");
    r.stopBy = p.id;
    r.deadline = Math.min(r.deadline, this.party.deadline(this.timings.stopLeft));
    this.party.withTv(() => {
      this.#put({ stopBy: p.id, deadline: r.deadline });
      for (const id of r.seats) this.party.player(id)?.state.set({ canStop: false });
    });
    this.#kick();
    return null;
  }

  #voting(p: Player): { r: RoundState; g: GradeState } {
    const r = this.#seated(p);
    const g = this.#g;
    if (this.#phase !== "grade" || !g || g.stage !== "vote" || g.skipped || r.ended) throw new PartyError("too-late", "The marks are in");
    return { r, g };
  }

  #answer(g: GradeState, id: Json | undefined): AnswerFull {
    const a = typeof id === "string" ? g.answers.find((x) => x.id === id) : undefined;
    if (!a) throw new PartyError("bad-answer", "No such answer");
    return a;
  }

  #doubt(p: Player, d: Record<string, Json>): unknown {
    const { g } = this.#voting(p);
    const a = this.#answer(g, d["id"]);
    if (a.who.includes(p.id)) throw new PartyError("own", "Your own answer");
    if (a.auto) throw new PartyError("auto", "Struck already");
    let set = g.doubts.get(p.id);
    if (!set) g.doubts.set(p.id, (set = new Set()));
    if (d["on"] === false) set.delete(a.id);
    else set.add(a.id);
    p.state.set({ doubts: [...set] });
    return null;
  }

  #star(p: Player, d: Record<string, Json>): unknown {
    const { g } = this.#voting(p);
    if (d["id"] === null) g.stars.delete(p.id);
    else {
      const a = this.#answer(g, d["id"]);
      if (a.who.includes(p.id)) throw new PartyError("own", "Your own answer");
      if (a.auto === "empty") throw new PartyError("bad-answer", "Nothing to star");
      g.stars.set(p.id, a.id);
    }
    p.state.set({ star: g.stars.get(p.id) ?? null });
    return null;
  }

  #done(p: Player, d: Record<string, Json>): unknown {
    const { g } = this.#voting(p);
    if (d["done"] === false) g.done.delete(p.id);
    else g.done.add(p.id);
    p.state.set({ done: g.done.has(p.id) });
    this.party.withTv(() => this.#put({ done: [...g.done] }));
    this.#kick();
    return null;
  }

  /** The vote of a column, open for the reader (any player). */
  #reading(): GradeState {
    const g = this.#g;
    if (this.#phase !== "grade" || !g || g.stage !== "vote" || g.skipped || this.#r?.ended) throw new PartyError("too-late", "The marks are in");
    return g;
  }

  /** One lookup more for a player (open, follow, search, switch): at most one every `wikiGap`, `wikiPer` a column. */
  #count(p: Player, g: GradeState): void {
    const now = this.party.now();
    const used = g.lookups.get(p.id) ?? { n: 0, last: -Infinity };
    if (used.n >= this.timings.wikiPer) throw new PartyError("too-many", "No more lookups this column");
    if (now - used.last < this.timings.wikiGap) throw new PartyError("slow-down", "One at a time");
    g.lookups.set(p.id, { n: used.n + 1, last: now });
    p.state.set({ lookups: this.timings.wikiPer - used.n - 1 });
  }

  /** `wiki` `{ id, pick? }`: an answer looked up, or another of its search's results. */
  #lookup(p: Player, d: Record<string, Json>): unknown {
    const g = this.#reading();
    const a = this.#answer(g, d["id"]);
    if (a.auto === "empty") throw new PartyError("bad-answer", "Nothing to look up");
    const pick = d["pick"];
    const top = g.wiki?.stack.at(-1);
    if (pick !== undefined && pick !== null) {
      if (typeof pick !== "number" || !Number.isInteger(pick) || !top || top.id !== a.id || pick < 0 || pick >= top.results.length) throw new PartyError("bad-answer", "No such result");
      this.#count(p, g);
      const results = top.results;
      const title = results[pick]!.title;
      this.#navigate(p, g, { id: a.id, query: top.query }, (src, lang) => this.#cached(title, lang, src).then((x): WikiFound => ("error" in x ? { error: x.error, results } : { results, article: x })), pick);
      return null;
    }
    this.#count(p, g);
    const query = a.texts[0]!;
    this.#navigate(p, g, { id: a.id, query }, (src, lang) => src.find(query, lang));
    return null;
  }

  /** `wiki-go` `{ title }` (a link) or `{ q }` (the search field). */
  #wikiGo(p: Player, d: Record<string, Json>): unknown {
    const g = this.#reading();
    const nav = g.wiki;
    if (!nav) throw new PartyError("no-article", "Open an answer first");
    const title = d["title"] !== undefined ? cleanTitle(d["title"]) : null;
    const q = d["title"] === undefined ? cleanTitle(d["q"]) : null;
    if (!title && !q) throw new PartyError("bad-title", "A title or a search, at most 200 characters");
    this.#count(p, g);
    const id = nav.loading?.id ?? nav.stack.at(-1)?.id ?? "";
    if (title) this.#navigate(p, g, { id, query: title }, (src, lang) => this.#cached(title, lang, src).then((x): WikiFound => ("error" in x ? { error: x.error, results: [] } : { results: [], article: x })));
    else this.#navigate(p, g, { id, query: q! }, (src, lang) => src.find(q!, lang));
    return null;
  }

  /** `wiki-back`: the article before (from the history: nothing is fetched). */
  #wikiBack(p: Player): unknown {
    const g = this.#reading();
    const nav = g.wiki;
    if (!nav || nav.stack.length < 2) throw new PartyError("no-back", "Nothing to go back to");
    nav.seq++;
    nav.loading = null;
    nav.stack.pop();
    nav.by = p.id;
    nav.at = this.#startAt(nav.stack.at(-1)!);
    this.party.withTv(() => this.#put({ wiki: this.#wikiView(nav) }));
    return null;
  }

  /** `wiki-at` `{ block }`: the driver's top block; the TV follows (its view only). */
  #wikiAt(p: Player, d: Record<string, Json>): unknown {
    const g = this.#reading();
    const nav = g.wiki;
    if (!nav || nav.by !== p.id) throw new PartyError("not-driver", "Someone else is reading");
    const blocks = nav.stack.at(-1)?.article?.blocks.length ?? 0;
    const b = d["block"];
    const at = typeof b === "number" && Number.isFinite(b) ? Math.max(0, Math.min(Math.max(0, blocks - 1), Math.floor(b))) : 0;
    if (at !== nav.at) {
      nav.at = at;
      // Only the TV's view: phones scroll themselves.
      this.party.screen.set({ wiki: this.#tvWiki(this.#wikiView(nav)) });
    }
    return null;
  }

  /** An article from the cache, else fetched (and kept). */
  async #cached(title: string, lang: Lang, src: WikiSource): Promise<WikiArticle | { error: WikiError }> {
    const key = `${lang}:${title.toLowerCase()}`;
    const hit = this.#cache.get(key);
    if (hit) {
      this.#cache.delete(key);
      this.#cache.set(key, hit);
      return hit;
    }
    return src.article(title, lang);
  }

  #remember(a: WikiArticle): void {
    const key = `${this.#lang}:${a.title.toLowerCase()}`;
    this.#cache.delete(key);
    this.#cache.set(key, a);
    while (this.#cache.size > WIKI_CACHE) this.#cache.delete(this.#cache.keys().next().value!);
  }

  /** Where the reader starts: the redirect's section, else the top. */
  #startAt(e: WikiEntry): number {
    const sec = e.article?.section?.toLowerCase();
    if (!sec || !e.article) return 0;
    const i = e.article.blocks.findIndex((b) => (b.t === "h2" || b.t === "h3") && b.c.map((r) => (typeof r === "string" ? r : r.s)).join("").trim().toLowerCase() === sec);
    return Math.max(0, i);
  }

  /**
   * Changes the room's article: "Looking it up…" over the last one (with
   * more time to read), then the new one, pushed on the history. A newer
   * navigation or Back wins over one still loading.
   */
  #navigate(p: Player, g: GradeState, ask: { id: string; query: string }, work: (src: WikiSource, lang: Lang) => Promise<WikiFound>, pick?: number): void {
    const nav = (g.wiki ??= { stack: [], loading: null, by: p.id, at: 0, seq: 0 });
    const seq = ++nav.seq;
    nav.loading = ask;
    nav.by = p.id;
    const want = Math.min(this.party.deadline(this.timings.wikiMin), g.base + this.timings.wikiMaxAdd);
    if (want > g.deadline) g.deadline = want;
    this.party.withTv(() => this.#put({ wiki: this.#wikiView(nav), deadline: g.deadline }));
    this.#kick();
    const lang = this.#lang;
    const src = this.#wiki;
    (src ? work(src, lang) : Promise.resolve<WikiFound>({ error: "offline", results: [] }))
      .catch((): WikiFound => ({ error: "offline", results: [] }))
      .then((found) => {
        if (this.#g !== g || g.wiki !== nav || nav.seq !== seq || g.stage !== "vote") return;
        const results = found.results.slice(0, 5).map((r) => ({ title: r.title, snippet: r.snippet }));
        const art = found.article;
        if (art) this.#remember(art);
        const entry: WikiEntry = {
          id: ask.id,
          query: ask.query,
          ...(art ? { article: art } : { error: found.error ?? "none" }),
          results,
          pick: pick ?? (art ? results.findIndex((r) => r.title === art.title) : -1),
        };
        nav.stack.push(entry);
        if (nav.stack.length > WIKI_HISTORY) nav.stack.shift();
        nav.loading = null;
        nav.at = this.#startAt(entry);
        this.party.withTv(() => this.#put({ wiki: this.#wikiView(nav) }));
      });
  }

  /** The reader as the room sees it (§7.1 `Wiki`); the TV's adds `at`. */
  #wikiView(nav: WikiNav): Record<string, unknown> {
    const top = nav.stack.at(-1);
    const art = top?.article;
    return {
      id: nav.loading?.id ?? top?.id ?? "",
      by: nav.by,
      query: nav.loading?.query ?? top?.query ?? "",
      ...(nav.loading ? { loading: true } : top?.error ? { error: top.error } : {}),
      ...(art
        ? {
            title: art.title,
            ...(art.description ? { description: art.description } : {}),
            ...(art.image ? { image: art.image } : {}),
            url: art.url,
            blocks: art.blocks,
            ...(art.cut ? { cut: true } : {}),
            ...(art.disambiguation ? { disambiguation: true } : {}),
          }
        : {}),
      trail: nav.stack.map((e) => e.article?.title ?? e.query),
      back: nav.stack.length > 1,
      results: top?.results ?? [],
      pick: top?.pick ?? -1,
    };
  }

  // -------------------------------------------------------------------------
  // Scores and the end

  #scores(r: RoundState | null): { id: string; round: number; total: number; rank: number; twenties: number }[] {
    const ids = this.#inGame().map((p) => p.id);
    return ids
      .map((id) => ({ id, round: r?.points.get(id) ?? 0, total: this.totals.get(id) ?? 0, rank: this.#rankOf(id), twenties: r?.twenties.get(id) ?? 0 }))
      .sort((a, b) => a.rank - b.rank || ids.indexOf(a.id) - ids.indexOf(b.id));
  }

  #lines(): ScoreLine[] {
    return this.#scores(null).map((s) => ({ id: s.id, name: this.#name(s.id), total: s.total, rank: s.rank }));
  }

  #cards(): Record<string, unknown>[] {
    const ids = this.#inGame().map((p) => p.id);
    const rk = ranks(new Map(ids.map((id) => [id, this.totals.get(id) ?? 0])));
    const stats: CardStats[] = ids.map((id) => {
      const s = this.#statsOf(id);
      return { id, rank: rk.get(id)!, total: this.totals.get(id) ?? 0, stars: s.stars, twenties: s.twenties, shared: s.shared, facts: s.facts, empty: s.empty, taste: s.taste };
    });
    const rem = remarks(stats);
    const all = [...rk.values()];
    return ids
      .map((id) => {
        const s = this.#statsOf(id);
        const grades = SUBJECT_IDS.filter((sub) => (s.subjects.get(sub)?.cols ?? 0) > 0).map((sub) => {
          const x = s.subjects.get(sub)!;
          return { subject: sub, grade: gradeOf(x.points / (10 * x.cols), this.#lang) };
        });
        return { id, rank: rk.get(id)!, total: this.totals.get(id) ?? 0, grades, remarks: rem.get(id) ?? ["fine"], stamp: stampOf(rk.get(id)!, all) };
      })
      .sort((a, b) => a.rank - b.rank || ids.indexOf(a.id) - ids.indexOf(b.id));
  }

  #bestOf(): Best[] {
    return [...this.#best]
      .sort((a, b) => b.stars - a.stars || a.seq - b.seq)
      .slice(0, 6)
      .map(({ seq: _seq, ...b }) => b);
  }

  #final(): ScoreLine[] {
    const party = this.party;
    this.#r = null;
    this.#g = null;
    this.#setPhase("final");
    const lines = this.#lines();
    party.withTv(() => {
      this.#reset({ phase: "final", scores: this.#scores(null), cards: this.#cards(), best: this.#bestOf() });
      this.#states();
    });
    this.emit("end", lines);
    return lines;
  }
}

