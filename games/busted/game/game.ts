/**
 * Busted on a party, for 3 to 10 players (docs/busted-design.md): the
 * lobby (press photos drawn on the phones, honorary candidates), then
 * rounds that alternate between a **vote** ("who would most likely …":
 * everyone ranks a podium in secret, the TV counts the ballots and the
 * winner gets the question's title on the front page) and an **answer**
 * round (everyone answers the same question, the TV shows the answers
 * anonymously, everyone matches answers to writers, the TV busts them one
 * by one); the scores; the final special edition with everyone's cover.
 * Questions come from the room's suggestions when the room liked them
 * (rated on the phones while people wait), else from the deck.
 *
 * The host is the only authority: phones and screens only ever get views.
 *
 * Views:
 * - `party.room` (every phone): `{ phase, lang, round, rounds, …settings, minPlayers, people, extras, kind?, stage?,
 *   question?, candidates?, podium?, deadline?, cards?, authors?, per? }`. `people` by id: `{ name, color, face,
 *   extra? }` (`face` null: the doodle of the name). `cards` (`{ id, text }`, never the writer) from the board on.
 * - `player.state` (one phone): `{ task, color, score, rank, of, desk, … }`; `desk` the editor's desk: the next
 *   suggestion to rate (never its author), how many are left, the player's own suggestions and where they stand.
 *   `task`: `lobby`, `wait`, `ask`, `rank` (`deadline`, `done`, `podium`), `write` (`deadline`, `done`, `n`,
 *   `answers`), `read`, `match` (`deadline`, `done`, `own`: the player's card ids), `watch`, `scores` (`earned`,
 *   `delta`), `final`.
 * - `party.screen` (the TV): `{ phase, lang, round, rounds, people, … }`; in a round `kind`, `stage`, `question`,
 *   and per stage: `candidates`, `deadline`/`duration`, `done` (who is in); `ballots` (`{ from?, podium }`, `from`
 *   only with open ballots), `start`, `per` and `result` (the count); `cards`; `reveal` (`{ start, per, items }`:
 *   each card with its writer, the guesses and hearts).
 *
 * Nobody learns a writer before the TV busts them, a ballot's voter
 * (with secret ballots) ever, or a suggestion's author before it is played.
 */

import { cleanText, Emitter, PartyError, type Json, type Party, type Player, type Sender } from "@tvpipe/party";

import { readPortrait, type Strokes } from "./face.ts";
import {
  answersEach,
  answerTotal,
  cleanAnswer,
  cleanQuestion,
  cleanTitle,
  DEFAULT_TITLE,
  kindOf,
  makeCards,
  MAX_EXTRAS,
  MAX_PENDING,
  MIN_PLAYERS,
  pickSuggestion,
  podiumSize,
  questionKey,
  QuestionDeck,
  ratingState,
  readMatch,
  readPodium,
  scoreMatch,
  scoreVote,
  shuffle,
  tally,
  voteTotal,
  type AnswerEarned,
  type Card,
  type CardResult,
  type Kind,
  type Lang,
  type Level,
  type Question,
  type SuggestionState,
  type VoteEarned,
} from "./rules.ts";

export interface Timings {
  /** The question on the front page before anyone acts. */
  ask: number;
  /** Ranking the podium. */
  rank: number;
  /** The count: each ballot. */
  ballot: number;
  /** The count: after the last ballot, the winner circled. */
  tallied: number;
  /** The front page with the title. */
  title: number;
  /** Writing an answer (the room's setting; half as long again with two answers each). */
  write: number;
  /** The gossip column to read: a base, per card, at most. */
  board: number;
  boardPer: number;
  boardMax: number;
  /** Matching: a base, per card, at most. */
  match: number;
  matchPer: number;
  matchMax: number;
  /** The reveal: each card. */
  card: number;
  /** After the last card. */
  revealed: number;
  scores: number;
}

export const DEFAULT_TIMINGS: Timings = {
  ask: 5000,
  rank: 30_000,
  ballot: 1100,
  tallied: 2600,
  title: 7500,
  write: 60_000,
  board: 5000,
  boardPer: 1300,
  boardMax: 16_000,
  match: 35_000,
  matchPer: 3000,
  matchMax: 90_000,
  card: 5600,
  revealed: 1500,
  scores: 7000,
};

/** For trying the game: everything short. */
export const FAST_TIMINGS: Timings = {
  ask: 2500,
  rank: 15_000,
  ballot: 600,
  tallied: 1500,
  title: 4000,
  write: 25_000,
  board: 2500,
  boardPer: 500,
  boardMax: 6000,
  match: 15_000,
  matchPer: 1000,
  matchMax: 30_000,
  card: 3200,
  revealed: 800,
  scores: 3500,
};

export const ROUNDS = [6, 8, 10, 12] as const;
export const WRITE_TIMES = [45, 60, 90] as const;
export const BALLOTS = ["open", "secret"] as const;
export type Ballots = (typeof BALLOTS)[number];
export const LEVEL_CHOICES = ["family", "party"] as const;

/** The room's settings: the host page's, or the VIP's in the lobby. */
export interface Settings {
  /** Which questions the deck deals: family ones only, or the cheekier ones too. */
  level: Level;
  /** The count shows who voted what (open), or only the medals (secret). */
  ballots: Ballots;
  /** Seconds to write an answer. */
  writeTime: number;
}

/** A fixed first question (the live check's screenshots), by its text. */
export interface Script {
  vote?: string | undefined;
  answer?: string | undefined;
}

export interface GameOptions {
  /** The question lists per language (`data/questions.txt`, …). */
  questions: Partial<Record<Lang, readonly Question[]>>;
  lang?: Lang | undefined;
  rounds?: number | undefined;
  minPlayers?: number | undefined;
  timings?: Partial<Timings> | undefined;
  rng?: (() => number) | undefined;
  level?: Level | undefined;
  ballots?: Ballots | undefined;
  /** The keys of questions this room played before (the host page keeps them). */
  seen?: Partial<Record<Lang, readonly string[]>> | undefined;
}

export interface ScoreLine {
  id: string;
  name: string;
  score: number;
  delta: number;
}

export interface Suggestion {
  id: string;
  author: string;
  kind: Kind;
  text: string;
  title: string | null;
  seq: number;
  ratings: Map<string, 1 | -1>;
  /** Final states; pending and approved are worked out from the ratings. */
  end: "dropped" | "played" | null;
}

export interface GameEvents {
  phase: [phase: Phase, stage: Stage | null];
  end: [scores: ScoreLine[]];
  settings: [settings: Settings];
  /** A question of the deck was dealt: the room has played it. */
  seen: [lang: Lang, key: string];
  /** The suggestions or the honorary candidates changed (the host page's lists). */
  desk: [];
}

export type Phase = "lobby" | "round" | "scores" | "final";
export type Stage = "ask" | "rank" | "count" | "title" | "write" | "board" | "match" | "reveal";

/** Ink for the players: spot colours that stay apart on newsprint, one each for ten. */
export const COLORS = ["#d62828", "#1d4e89", "#2a9d3f", "#e07a10", "#7b2cbf", "#0a8f8f", "#c2185b", "#8d5524", "#5b6b00", "#3a3a8c"] as const;

const SOMEONE: Record<Lang, string> = { en: "Someone", de: "Jemand" };

/** A question as it is played. */
interface Asked {
  kind: Kind;
  text: string;
  title: string | null;
  /** A suggestion: its id and author. */
  tip: Suggestion | null;
}

/** The game's numbers per person, for the scores' details and the covers. */
interface Totals {
  titles: string[];
  fooled: number;
  right: number;
  hearts: number;
  /** Their answer with the most hearts (the latest when tied). */
  best: { text: string; hearts: number } | null;
  tips: number;
}

type Earned = (VoteEarned & { kind: "vote" }) | (AnswerEarned & { kind: "answer" });

export class Busted extends Emitter<GameEvents> {
  readonly party: Party;
  rounds: number;
  readonly minPlayers: number;
  timings: Timings;
  /** A fixed first question per kind for the next game (then cleared). */
  script: Script | undefined;
  readonly #rng: () => number;
  readonly #questions = new Map<Lang, readonly Question[]>();
  readonly #decks = new Map<Lang, QuestionDeck>();
  readonly #seen: Partial<Record<Lang, readonly string[]>>;
  #lang: Lang;
  #level: Level;
  #ballots: Ballots;
  readonly #colors = new Map<string, number>();
  /** Names by id, kept after a player left. */
  readonly #names = new Map<string, string>();
  readonly #faces = new Map<string, Strokes>();
  /** Honorary candidates: voted for, never playing. */
  #extras: { id: string; name: string }[] = [];
  #extraSeq = 0;
  readonly #tips: Suggestion[] = [];
  #tipSeq = 0;
  /** The author of the last suggestion played (none twice in a row). */
  #lastTip: string | null = null;
  /** Points per player id (players in the game). */
  readonly scores = new Map<string, number>();
  readonly #totals = new Map<string, Totals>();
  #earned = new Map<string, Earned>();
  #phase: Phase = "lobby";
  #stage: Stage | null = null;
  #running = false;
  #abort = new AbortController();
  /** Skips the question being asked (ask, rank, write). */
  #skipper: AbortController | null = null;
  #game = 0;
  #roundNo = 0;
  #asked: Asked | null = null;

  constructor(party: Party, options: GameOptions) {
    super();
    this.party = party;
    this.rounds = options.rounds ?? 8;
    this.minPlayers = options.minPlayers ?? MIN_PLAYERS;
    this.timings = { ...DEFAULT_TIMINGS, ...options.timings };
    this.#rng = options.rng ?? Math.random;
    this.#lang = options.lang ?? "en";
    this.#level = options.level ?? "family";
    this.#ballots = options.ballots ?? "open";
    this.#seen = options.seen ?? {};
    for (const [l, list] of Object.entries(options.questions) as [Lang, readonly Question[]][]) {
      if (list.some((q) => q.kind === "vote") && list.some((q) => q.kind === "answer")) this.#questions.set(l, list);
    }
    if (!this.#questions.has(this.#lang)) throw new Error(`busted: no questions in ${this.#lang}`);
  }

  get settings(): Settings {
    return { level: this.#level, ballots: this.#ballots, writeTime: this.timings.write / 1000 };
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
    return [...this.#questions.keys()];
  }

  get round(): number {
    return this.#roundNo;
  }

  /** The question being played (tests, the host page). */
  get asked(): Readonly<Asked> | null {
    return this.#asked;
  }

  get extras(): readonly { id: string; name: string }[] {
    return this.#extras;
  }

  /** Suggestions as the host page lists them (with their authors: the host page is the room's moderator). */
  get suggestions(): { id: string; author: string; kind: Kind; text: string; title: string | null; ups: number; downs: number; state: SuggestionState }[] {
    return this.#tips.map((s) => ({ id: s.id, author: this.#name(s.author), kind: s.kind, text: s.text, title: s.title, ...this.#votes(s), state: this.#tipState(s) }));
  }

  colorOf(id: string): number {
    return this.#colors.get(id) ?? 0;
  }

  /** Whether the question being asked may be skipped now. */
  get canSkip(): boolean {
    return this.#running && this.#skipper !== null && (this.#stage === "ask" || this.#stage === "rank" || this.#stage === "write");
  }

  /** Shows the lobby and waits for the VIP to start. */
  open(): void {
    const party = this.party;
    const vipOnly = (from: Sender) => {
      if (from.role !== "player" || !from.vip) throw new PartyError("not-vip", "Only the VIP can do this");
    };
    const obj = (d: Json): Record<string, Json> => (typeof d === "object" && d !== null && !Array.isArray(d) ? d : {});
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
      const id = obj(d)["id"];
      const p = typeof id === "string" ? party.player(id) : undefined;
      if (!p || p === from) throw new PartyError("no-player", "No such player");
      party.kick(p);
      return null;
    });
    party.handle("settings", (d, from) => {
      vipOnly(from);
      const v = obj(d);
      const o: Partial<Settings> & { rounds?: number; lang?: Lang } = {};
      for (const k of Object.keys(v)) if (!["lang", "rounds", "level", "ballots", "writeTime"].includes(k)) throw new PartyError("bad-settings", `${k}: not a setting`);
      const oneOf = <T extends Json>(key: string, list: readonly T[]): T | undefined => {
        if (v[key] === undefined) return undefined;
        if (!list.includes(v[key] as T)) throw new PartyError("bad-settings", `${key}: ${list.join(", ")}`);
        return v[key] as T;
      };
      o.lang = oneOf("lang", this.langs);
      o.rounds = oneOf("rounds", ROUNDS);
      o.level = oneOf("level", LEVEL_CHOICES);
      o.ballots = oneOf("ballots", BALLOTS);
      o.writeTime = oneOf("writeTime", WRITE_TIMES);
      this.configure(o);
      return null;
    });
    party.handle("skip", (_d, from) => {
      vipOnly(from);
      if (!this.skip()) throw new PartyError("not-now", "Too late to skip this one");
      return null;
    });
    party.handle("extra", (d, from) => {
      vipOnly(from);
      const v = obj(d);
      if (typeof v["remove"] === "string") this.removeExtra(v["remove"]);
      else this.addExtra(v["name"]);
      return null;
    });
    party.handle("portrait", (d, from) => {
      if (from.role !== "player") throw new PartyError("not-player", "Players only");
      const strokes = readPortrait(d);
      if (!strokes) throw new PartyError("bad-portrait", "Not a drawing");
      if (strokes.length === 0) this.#faces.delete(from.id);
      else this.#faces.set(from.id, strokes);
      this.#peopleChanged();
      return null;
    });
    party.handle("suggest", (d, from) => this.#suggest(obj(d), from));
    party.handle("rate", (d, from) => this.#rate(obj(d), from));
    party.on("join", (p) => {
      this.#names.set(p.id, p.name);
      this.#colors.set(p.id, this.#freeColor());
      this.#peopleChanged();
      if (!this.#running) p.state.replace(this.#lobbyState(p));
      else p.state.replace(this.#waitState(p));
      this.#deskChanged();
    });
    party.on("leave", (p) => {
      this.#colors.delete(p.id);
      this.#faces.delete(p.id);
      this.#peopleChanged();
      this.#deskChanged();
    });
    this.#lobby();
  }

  /** Changes the rounds, the timers, the language or the settings before a game; every phone and the TV follow. */
  configure(o: { rounds?: number | undefined; timings?: Partial<Timings> | undefined; lang?: Lang | undefined } & { [K in keyof Settings]?: Settings[K] | undefined }): void {
    if (this.#running) throw new PartyError("running", "Not during a game");
    if (o.lang !== undefined && !this.langs.includes(o.lang)) throw new PartyError("bad-lang", `Nothing to play in ${o.lang}`);
    const was = JSON.stringify([this.#lang, this.rounds, this.settings]);
    if (o.rounds !== undefined) this.rounds = Math.max(2, Math.min(20, Math.round(o.rounds)));
    if (o.timings) this.timings = { ...this.timings, ...o.timings };
    if (o.lang !== undefined) this.#lang = o.lang;
    if (o.level !== undefined && LEVEL_CHOICES.includes(o.level)) this.#level = o.level;
    if (o.ballots !== undefined && BALLOTS.includes(o.ballots)) this.#ballots = o.ballots;
    if (o.writeTime !== undefined && o.writeTime > 0) this.timings.write = o.writeTime * 1000;
    if (this.#phase === "lobby" || this.#phase === "final") {
      this.party.room.set({ lang: this.#lang, rounds: this.rounds, ...this.settings });
      this.party.screen.set({ lang: this.#lang, rounds: this.rounds, ...this.settings });
    }
    if (JSON.stringify([this.#lang, this.rounds, this.settings]) !== was) this.emit("settings", this.settings);
  }

  /** Adds an honorary candidate (the lobby only): a name, voted for but never playing. */
  addExtra(name: unknown): void {
    if (this.#running) throw new PartyError("running", "Not during a game");
    if (this.#extras.length >= MAX_EXTRAS) throw new PartyError("extras-full", `${MAX_EXTRAS} at most`);
    const raw = typeof name === "string" ? this.party.moderate(name, "name") : false;
    const clean = raw === false ? "" : cleanText(raw, 16);
    if (!clean) throw new PartyError("bad-name", "Pick another name");
    const key = clean.toLocaleLowerCase();
    if ([...this.#extras.map((x) => x.name), ...this.party.players.map((p) => p.name)].some((n) => n.toLocaleLowerCase() === key)) throw new PartyError("name-taken", "That name is taken");
    this.#extras.push({ id: `x${++this.#extraSeq}`, name: clean });
    this.#peopleChanged();
    this.emit("desk");
  }

  removeExtra(id: string): void {
    if (this.#running) throw new PartyError("running", "Not during a game");
    this.#extras = this.#extras.filter((x) => x.id !== id);
    this.#totals.delete(id);
    this.#peopleChanged();
    this.emit("desk");
  }

  /** Takes a suggestion off the desk (the host page: the room's moderator). */
  dropSuggestion(id: string): void {
    const s = this.#tips.find((x) => x.id === id);
    if (!s || s.end) return;
    s.end = "dropped";
    this.#deskChanged();
  }

  /** Skips the question being asked (ask, rank, write): the next one comes. False when it is too late. */
  skip(): boolean {
    if (!this.canSkip) return false;
    this.#skipper?.abort();
    return true;
  }

  /**
   * Ends a running game and its timers (the party stays): the lobby is
   * back at once (no final screen), waiting players are in, and nothing
   * of the old game writes after this returns.
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
    this.#asked = null;
    this.#skipper = null;
    this.#stage = null;
    this.#running = false;
    party.inProgress = false;
    for (const p of party.players) party.activate(p);
  }

  // -------------------------------------------------------------------------
  // People and views

  #setPhase(phase: Phase, stage: Stage | null = null): void {
    const changed = phase !== this.#phase || stage !== this.#stage;
    this.#phase = phase;
    this.#stage = stage;
    // Told once the views of the stage are set (they follow the call in the same tick).
    if (changed) queueMicrotask(() => this.emit("phase", phase, stage));
  }

  #freeColor(): number {
    const used = COLORS.map(() => 0);
    for (const p of this.party.players) {
      const c = this.#colors.get(p.id);
      if (c !== undefined) used[c]!++;
    }
    return used.indexOf(Math.min(...used));
  }

  #name(id: string): string {
    return this.party.player(id)?.name ?? this.#extras.find((x) => x.id === id)?.name ?? this.#names.get(id) ?? SOMEONE[this.#lang];
  }

  /** Everyone the views may name: players (the ones who left too, for this game's cards and ballots) and honorary candidates. */
  #people(): Record<string, { name: string; color: string; face: Strokes | null; extra?: true; gone?: true }> {
    const out: Record<string, { name: string; color: string; face: Strokes | null; extra?: true; gone?: true }> = {};
    for (const p of this.party.players) out[p.id] = { name: p.name, color: COLORS[this.colorOf(p.id)]!, face: this.#faces.get(p.id) ?? null };
    for (const x of this.#extras) out[x.id] = { name: x.name, color: "#6b6b6b", face: null, extra: true };
    if (this.#running) for (const id of this.scores.keys()) if (!out[id]) out[id] = { name: this.#name(id), color: "#6b6b6b", face: null, gone: true };
    return out;
  }

  #peopleChanged(): void {
    const people = this.#people();
    this.party.room.set({ people, extras: this.#extras.map((x) => x.id) });
    this.party.screen.set({ people, extras: this.#extras.map((x) => x.id) });
  }

  #rank(p: Player | undefined): { score: number; rank: number; of: number } {
    const scores = [...this.scores].filter(([id]) => this.party.player(id)).map(([, s]) => s);
    const s = p ? (this.scores.get(p.id) ?? 0) : 0;
    return { score: s, rank: 1 + scores.filter((x) => x > s).length, of: scores.length };
  }

  /** What every state of a player carries: their colour, score and the editor's desk. */
  #mine(p: Player): Record<string, unknown> {
    return { color: this.colorOf(p.id), ...this.#rank(this.scores.has(p.id) ? p : undefined), desk: this.#desk(p) };
  }

  #lobbyState(p: Player): Record<string, unknown> {
    return { task: this.#phase === "final" ? "final" : "lobby", ...this.#mine(p) };
  }

  #waitState(p: Player): Record<string, unknown> {
    return { task: "wait", note: this.#roundNo < this.rounds ? "round" : "game", ...this.#mine(p) };
  }

  #room(fields: Record<string, unknown>): void {
    this.party.room.replace({
      lang: this.#lang,
      round: this.#roundNo,
      rounds: this.rounds,
      ...this.settings,
      minPlayers: this.minPlayers,
      people: this.#people(),
      extras: this.#extras.map((x) => x.id),
      ...fields,
    });
  }

  #screen(fields: Record<string, unknown>): void {
    this.party.screen.replace({
      lang: this.#lang,
      round: this.#roundNo,
      rounds: this.rounds,
      ...this.settings,
      people: this.#people(),
      extras: this.#extras.map((x) => x.id),
      tips: this.#tipCounts(),
      ...fields,
    });
  }

  #lobby(): void {
    const party = this.party;
    this.#setPhase("lobby");
    this.#room({ phase: "lobby", maxPlayers: party.maxPlayers, maxExtras: MAX_EXTRAS });
    this.#screen({ phase: "lobby", minPlayers: this.minPlayers, maxPlayers: party.maxPlayers });
    for (const p of party.players) p.state.replace(this.#lobbyState(p));
  }

  /** Players in the game (they have a score), still in the party. */
  #inGame(): Player[] {
    return this.party.players.filter((p) => this.scores.has(p.id));
  }

  #others(ids: ReadonlySet<string>): void {
    for (const p of this.party.players) if (!ids.has(p.id)) p.state.replace(this.#waitState(p));
  }

  #totalsOf(id: string): Totals {
    let t = this.#totals.get(id);
    if (!t) this.#totals.set(id, (t = { titles: [], fooled: 0, right: 0, hearts: 0, best: null, tips: 0 }));
    return t;
  }

  // -------------------------------------------------------------------------
  // The editor's desk: suggested questions and their ratings

  #votes(s: Suggestion): { ups: number; downs: number } {
    let ups = 0;
    let downs = 0;
    for (const [id, v] of s.ratings) {
      if (!this.party.player(id)) continue;
      if (v > 0) ups++;
      else downs++;
    }
    return { ups, downs };
  }

  #tipState(s: Suggestion): SuggestionState {
    if (s.end) return s.end;
    const { ups, downs } = this.#votes(s);
    const others = this.party.players.filter((p) => p.id !== s.author).length;
    const st = ratingState(ups, downs, others);
    if (st === "dropped") s.end = "dropped";
    return st;
  }

  #tipCounts(): { pending: number; approved: number } {
    let pending = 0;
    let approved = 0;
    for (const s of this.#tips) {
      const st = this.#tipState(s);
      if (st === "pending") pending++;
      if (st === "approved") approved++;
    }
    return { pending, approved };
  }

  /** A player's desk: the next suggestion to rate (not theirs, not rated yet), how many wait, and their own. */
  #desk(p: Player): Record<string, unknown> {
    const open = this.#tips.filter((s) => s.author !== p.id && !s.ratings.has(p.id) && !s.end && this.#tipState(s) !== "dropped");
    const next = open[0];
    return {
      rate: next ? { id: next.id, kind: next.kind, text: next.text, title: next.title } : null,
      left: open.length,
      mine: this.#tips.filter((s) => s.author === p.id).map((s) => ({ id: s.id, kind: s.kind, text: s.text, state: this.#tipState(s) })),
    };
  }

  #deskChanged(): void {
    for (const p of this.party.players) p.state.set({ desk: this.#desk(p) });
    this.party.screen.set({ tips: this.#tipCounts() });
    this.emit("desk");
  }

  #suggest(d: Record<string, Json>, from: Sender): unknown {
    if (from.role !== "player") throw new PartyError("not-player", "Players only");
    const kind = d["kind"];
    if (kind !== "vote" && kind !== "answer") throw new PartyError("bad-kind", "vote or answer");
    const pending = this.#tips.filter((s) => s.author === from.id && !s.end && this.#tipState(s) !== "dropped").length;
    if (pending >= MAX_PENDING) throw new PartyError("too-many", `${MAX_PENDING} waiting at most`);
    const moderated = typeof d["text"] === "string" ? this.party.moderate(d["text"], "question", from) : false;
    const text = moderated === false ? null : cleanQuestion(cleanText(moderated, 400));
    if (!text) throw new PartyError("bad-question", "Write a question (10 to 120 characters)");
    let title: string | null = null;
    if (kind === "vote" && typeof d["title"] === "string" && d["title"].trim()) {
      const t = this.party.moderate(d["title"], "title", from);
      title = t === false ? null : cleanTitle(cleanText(t, 80));
      if (!title) throw new PartyError("bad-title", "A title of at most 28 characters");
    }
    const key = questionKey({ kind, text }).toLocaleLowerCase();
    if (this.#tips.some((s) => !s.end && questionKey(s).toLocaleLowerCase() === key)) throw new PartyError("duplicate", "That one is on the desk already");
    this.#tips.push({ id: `t${++this.#tipSeq}`, author: from.id, kind, text, title, seq: this.#tipSeq, ratings: new Map(), end: null });
    this.#deskChanged();
    return { ok: true, text };
  }

  #rate(d: Record<string, Json>, from: Sender): unknown {
    if (from.role !== "player") throw new PartyError("not-player", "Players only");
    const s = this.#tips.find((x) => x.id === d["id"]);
    if (!s) throw new PartyError("no-tip", "That one is gone");
    if (s.author === from.id) throw new PartyError("own-tip", "Not your own");
    if (s.ratings.has(from.id) || s.end) return { ok: true };
    const v = d["rating"];
    if (v === "no") s.end = "dropped";
    else if (v === 1 || v === -1) s.ratings.set(from.id, v);
    else throw new PartyError("bad-rating", "1, -1 or no");
    this.#tipState(s);
    this.#deskChanged();
    return { ok: true };
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
        const players = this.#inGame();
        if (players.length < this.minPlayers) break;
        const before = new Map(this.scores);
        this.#earned = new Map();
        const kind = kindOf(r);
        await this.#playRound(kind, signal);
        if (signal.aborted) break;
        await this.#scores(r, before, signal);
        if (signal.aborted) break;
      }
      return signal.aborted ? this.#lines() : this.#final();
    } finally {
      if (this.#game === game) this.#stop();
    }
  }

  /** A round of a kind; a skipped question makes way for the next one. */
  async #playRound(kind: Kind, signal: AbortSignal): Promise<void> {
    for (let tries = 0; tries < 20; tries++) {
      const skipper = new AbortController();
      this.#skipper = skipper;
      const s = AbortSignal.any([signal, skipper.signal]);
      const q = this.#question(kind);
      this.#asked = q;
      if (kind === "vote") await this.#vote(q, s);
      else await this.#answer(q, s);
      this.#skipper = null;
      if (signal.aborted) return;
      if (!skipper.signal.aborted) {
        if (q.tip) this.#totalsOf(q.tip.author).tips++;
        return;
      }
      // Skipped: a suggestion does not come back.
      if (q.tip) {
        q.tip.end = "dropped";
        this.#lastTip = null;
        this.#deskChanged();
      }
    }
  }

  #deck(): QuestionDeck {
    let d = this.#decks.get(this.#lang);
    if (!d) this.#decks.set(this.#lang, (d = new QuestionDeck(this.#questions.get(this.#lang)!, this.#rng, this.#seen[this.#lang] ?? [])));
    return d;
  }

  /** The next question of a kind: the room's best liked suggestion, else the deck's (or the script's). */
  #question(kind: Kind): Asked {
    const scripted = this.script?.[kind];
    if (scripted !== undefined && this.script) {
      this.script[kind] = undefined;
      const q = this.#questions.get(this.#lang)!.find((x) => x.kind === kind && x.text === scripted);
      if (q) return { kind, text: q.text, title: q.title ?? null, tip: null };
    }
    const rated = this.#tips.map((s) => ({ s, id: s.id, author: s.author, kind: s.kind, seq: s.seq, ...this.#votes(s), state: this.#tipState(s) }));
    const tip = pickSuggestion(rated, kind, this.#lastTip)?.s;
    if (tip) {
      tip.end = "played";
      this.#lastTip = tip.author;
      this.#deskChanged();
      return { kind, text: tip.text, title: kind === "vote" ? (tip.title ?? DEFAULT_TITLE[this.#lang]) : null, tip };
    }
    this.#lastTip = null;
    const q = this.#deck().draw(kind, this.#level);
    if (!q) throw new Error(`busted: no ${kind} questions in ${this.#lang}`);
    this.emit("seen", this.#lang, questionKey(q));
    return { kind, text: q.text, title: q.title ?? null, tip: null };
  }

  #questionView(q: Asked): Record<string, unknown> {
    return { kind: q.kind, text: q.text, title: q.title, ...(q.tip ? { by: { id: q.tip.author, name: this.#name(q.tip.author) } } : {}) };
  }

  /** The question on the front page (every round's first stage). */
  async #ask(q: Asked, fields: Record<string, unknown>, signal: AbortSignal): Promise<void> {
    const party = this.party;
    const players = this.#inGame();
    const ids = new Set(players.map((p) => p.id));
    this.#setPhase("round", "ask");
    const question = this.#questionView(q);
    party.withTv(() => {
      this.#room({ phase: "round", kind: q.kind, stage: "ask", question, ...fields });
      this.#screen({ phase: "round", kind: q.kind, stage: "ask", question, ...fields });
      for (const p of players) p.state.replace({ task: "ask", ...this.#mine(p) });
      this.#others(ids);
    });
    await this.#sleep(this.timings.ask, signal);
  }

  // -------------------------------------------------------------------------
  // Vote rounds

  async #vote(q: Asked, signal: AbortSignal): Promise<void> {
    const party = this.party;
    const t = this.timings;
    const players = this.#inGame();
    const candidates = [...players.map((p) => p.id), ...this.#extras.map((x) => x.id)];
    const podium = podiumSize(candidates.length);
    await this.#ask(q, { candidates, podium }, signal);
    if (signal.aborted) return;

    // Ranking, in secret.
    this.#setPhase("round", "rank");
    const voters = players.filter((p) => party.player(p.id));
    const deadline = party.deadline(t.rank);
    party.withTv(() => {
      party.room.set({ stage: "rank", deadline });
      party.screen.set({ stage: "rank", deadline, duration: t.rank, done: [] });
      for (const p of voters) p.state.replace({ task: "rank", deadline, done: false, podium: null, ...this.#mine(p) });
    });
    const set = new Set(candidates);
    const got = await party.collect<string[]>("rank", {
      from: voters,
      until: deadline,
      signal,
      validate: (d) => {
        try {
          return readPodium(d, set, podium);
        } catch (e) {
          throw new PartyError("bad-podium", (e as Error).message);
        }
      },
      onAnswer: (p, list, all) => {
        p.state.set({ done: true, podium: list });
        party.screen.set({ done: [...all.keys()].map((x) => x.id) });
      },
    });
    if (signal.aborted) return;
    this.#skipper = null;
    const ballots = new Map([...got].map(([p, list]) => [p.id, list]));

    // The count, ballot by ballot, then the front page.
    const result = tally(ballots.values(), candidates);
    const earned = scoreVote(ballots, result);
    for (const [id, e] of earned) {
      this.#earned.set(id, { kind: "vote", ...e });
      if (this.scores.has(id)) this.scores.set(id, this.scores.get(id)! + voteTotal(e));
    }
    const title = q.title ?? DEFAULT_TITLE[this.#lang];
    for (const w of result.winners) this.#totalsOf(w).titles.push(title);
    const open = this.#ballots === "open";
    const shown = shuffle([...ballots], this.#rng).map(([from, list]) => (open ? { from, podium: list } : { podium: list }));
    this.#setPhase("round", "count");
    const start = party.deadline(700);
    const res = { points: Object.fromEntries(result.points), golds: Object.fromEntries(result.golds), winners: result.winners, top: result.top, order: result.order };
    party.withTv(() => {
      party.room.set({ stage: "count" });
      party.screen.set({ stage: "count", ballots: shown, start, per: t.ballot, result: res });
      for (const p of voters) if (party.player(p.id)) p.state.replace({ task: "watch", ...this.#mine(p) });
    });
    await this.#sleep(700 + t.ballot * shown.length + t.tallied, signal);
    if (signal.aborted) return;
    this.#setPhase("round", "title");
    const winners = result.winners.map((id) => ({ id, points: result.points.get(id) ?? 0, golds: result.golds.get(id) ?? 0 }));
    party.withTv(() => {
      party.room.set({ stage: "title", winners: result.winners, title });
      party.screen.set({ stage: "title", winners, title, voters: ballots.size });
    });
    await this.#sleep(t.title, signal);
  }

  // -------------------------------------------------------------------------
  // Answer rounds

  async #answer(q: Asked, signal: AbortSignal): Promise<void> {
    const party = this.party;
    const t = this.timings;
    const players = this.#inGame();
    const per = answersEach(players.length);
    await this.#ask(q, { per }, signal);
    if (signal.aborted) return;

    // Writing.
    this.#setPhase("round", "write");
    const writers = players.filter((p) => party.player(p.id));
    const writeMs = per > 1 ? Math.round(t.write * 1.5) : t.write;
    const deadline = party.deadline(writeMs);
    party.withTv(() => {
      party.room.set({ stage: "write", deadline, per });
      party.screen.set({ stage: "write", deadline, duration: writeMs, done: [], per });
      for (const p of writers) p.state.replace({ task: "write", deadline, done: false, n: per, answers: null, ...this.#mine(p) });
    });
    const got = await party.collect<string[]>("answer", {
      from: writers,
      until: deadline,
      signal,
      validate: (d, p) => {
        const list = typeof d === "object" && d !== null && !Array.isArray(d) ? (d as { texts?: unknown }).texts : d;
        if (!Array.isArray(list) || list.length === 0 || list.length > per) throw new PartyError("bad-answer", per > 1 ? "One or two answers" : "One answer");
        const out: string[] = [];
        for (const raw of list) {
          if (typeof raw !== "string") throw new PartyError("bad-answer", "Text only");
          const m = party.moderate(raw, "answer", p);
          if (m === false) throw new PartyError("refused", "Write something else");
          const a = cleanAnswer(cleanText(m, 400));
          if (!a) continue;
          if (out.some((x) => x.toLocaleLowerCase() === a.toLocaleLowerCase())) throw new PartyError("twice", "Two different answers");
          out.push(a);
        }
        if (out.length === 0) throw new PartyError("empty", "Write something");
        return out;
      },
      onAnswer: (p, list, all) => {
        p.state.set({ done: true, answers: list });
        party.screen.set({ done: [...all.keys()].map((x) => x.id) });
      },
    });
    if (signal.aborted) return;
    this.#skipper = null;
    const answers = new Map([...got].map(([p, list]) => [p.id, list]));
    const cards = makeCards(answers, this.#rng);
    const authors = [...answers.keys()];
    const shown = cards.map((c) => ({ id: c.id, text: c.text }));

    // The gossip column, to read.
    this.#setPhase("round", "board");
    const ids = new Set(players.map((p) => p.id));
    const readMs = Math.min(t.boardMax, t.board + t.boardPer * cards.length);
    party.withTv(() => {
      party.room.set({ stage: "board", cards: shown, authors, per });
      party.screen.set({ stage: "board", cards: shown, authors, deadline: party.deadline(readMs), duration: readMs });
      for (const p of players) if (party.player(p.id)) p.state.replace({ task: "read", ...this.#mine(p) });
      this.#others(ids);
    });
    await this.#sleep(readMs, signal);
    if (signal.aborted) return;

    // Matching (nothing to match with fewer than two writers: straight to the reveal).
    const matches = new Map<string, { guesses: Map<number, string>; heart: number | null }>();
    const guessers = players.filter((p) => party.player(p.id));
    if (authors.length >= 2 && guessers.length > 0) {
      this.#setPhase("round", "match");
      const matchMs = Math.min(t.matchMax, t.match + t.matchPer * cards.length);
      const until = party.deadline(matchMs);
      party.withTv(() => {
        party.room.set({ stage: "match", deadline: until });
        party.screen.set({ stage: "match", deadline: until, duration: matchMs, done: [] });
        for (const p of guessers) {
          const own = cards.filter((c) => c.author === p.id).map((c) => c.id);
          p.state.replace({ task: "match", deadline: until, done: false, own, ...this.#mine(p) });
        }
      });
      const got = await party.collect<{ guesses: Map<number, string>; heart: number | null }>("match", {
        from: guessers,
        until,
        signal,
        validate: (d, p) => {
          try {
            return readMatch(d, cards, p.id, per);
          } catch (e) {
            throw new PartyError("bad-match", (e as Error).message);
          }
        },
        onAnswer: (p, _m, all) => {
          p.state.set({ done: true });
          party.screen.set({ done: [...all.keys()].map((x) => x.id) });
        },
      });
      if (signal.aborted) return;
      for (const [p, m] of got) matches.set(p.id, m);
    }

    // The reveal, card by card.
    const { earned, results } = scoreMatch(cards, matches);
    for (const [id, e] of earned) {
      this.#earned.set(id, { kind: "answer", ...e });
      if (this.scores.has(id)) this.scores.set(id, this.scores.get(id)! + answerTotal(e));
      const tot = this.#totalsOf(id);
      tot.fooled += e.fool;
      tot.right += e.guess;
    }
    for (const r of results) this.#remember(r);
    this.#setPhase("round", "reveal");
    const start = party.deadline(600);
    const items = results.map((r) => ({ card: { id: r.card.id, text: r.card.text }, author: r.card.author, guesses: r.guesses, right: r.right, wrong: r.wrong, hearts: r.hearts, busted: r.busted }));
    party.withTv(() => {
      party.room.set({ stage: "reveal" });
      party.screen.set({ stage: "reveal", reveal: { start, per: t.card, items } });
      for (const p of guessers) if (party.player(p.id)) p.state.replace({ task: "watch", ...this.#mine(p) });
    });
    await this.#sleep(600 + t.card * items.length + t.revealed, signal);
  }

  /** A card's hearts for its writer's cover. */
  #remember(r: CardResult): void {
    const tot = this.#totalsOf(r.card.author);
    tot.hearts += r.hearts;
    if (!tot.best || r.hearts >= tot.best.hearts) tot.best = { text: r.card.text, hearts: r.hearts };
  }

  // -------------------------------------------------------------------------
  // Scores and the end

  #lines(before?: ReadonlyMap<string, number>): ScoreLine[] {
    return this.#inGame()
      .map((p) => {
        const s = this.scores.get(p.id) ?? 0;
        return { id: p.id, name: p.name, score: s, delta: s - (before?.get(p.id) ?? s) };
      })
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  }

  async #scores(round: number, before: ReadonlyMap<string, number>, signal: AbortSignal): Promise<void> {
    const party = this.party;
    this.#asked = null;
    this.#setPhase("scores");
    const lines = this.#lines(before).map((l) => ({ ...l, earned: this.#earned.get(l.id) ?? null }));
    party.withTv(() => {
      this.#room({ phase: "scores" });
      this.#screen({ phase: "scores", lines, last: round >= this.rounds, next: round < this.rounds ? kindOf(round + 1) : null });
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

  /** The covers: every player in the game and every honorary candidate, with their titles and best answer. */
  #covers(): { id: string; titles: string[]; quote: string | null; hearts: number }[] {
    const ids = [...this.#inGame().map((p) => p.id), ...this.#extras.map((x) => x.id)];
    return ids.map((id) => {
      const t = this.#totals.get(id);
      return { id, titles: t?.titles ?? [], quote: t?.best?.text ?? null, hearts: t?.hearts ?? 0 };
    });
  }

  /** The awards, each only when someone earned it: knows the room best, most titles, master of disguise, readers' favourite, star reporter (suggestions played). */
  #awards(): Record<string, { id: string; n: number } | null> {
    const lines = this.#lines();
    const here = [...this.#totals].filter(([id]) => this.party.player(id) || this.#extras.some((x) => x.id === id));
    const best = (f: (t: Totals) => number, min = 1) => {
      let top: { id: string; n: number } | null = null;
      for (const [id, t] of here) {
        const n = f(t);
        if (n >= min && (!top || n > top.n)) top = { id, n };
      }
      return top;
    };
    const first = lines[0];
    return {
      knows: first && first.score > 0 ? { id: first.id, n: first.score } : null,
      titles: best((t) => t.titles.length, 2),
      disguise: best((t) => t.fooled),
      fans: best((t) => t.hearts),
      reporter: best((t) => t.tips),
    };
  }

  #final(): ScoreLine[] {
    const party = this.party;
    this.#asked = null;
    this.#setPhase("final");
    const table = this.#lines();
    party.withTv(() => {
      this.#room({ phase: "final", maxPlayers: party.maxPlayers, maxExtras: MAX_EXTRAS });
      this.#screen({ phase: "final", lines: table, covers: this.#covers(), awards: this.#awards() });
      const covers = this.#covers();
      for (const p of party.players) p.state.replace({ task: "final", ...this.#mine(p), cover: covers.find((c) => c.id === p.id) ?? null });
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

export type { Card };
