/**
 * Jinx on a party (docs/jinx-design.md): the lobby (faces, colours), then
 * per round the hot seat, the clue-givers write, the jinx check, the
 * guesser turns cards and guesses (the draft typed live on the TV), the
 * verdict, the replay with the best clue, the room's bank; the end in
 * steps (the room, the best clues, the awards, the word web). The room
 * plays as one team: one bank, no personal points. The host is
 * the only authority: phones and the TV only get views (`views.ts`, the
 * contract) and send actions.
 *
 * The room has a language (`lang`, the host page's or the VIP's setting,
 * changed only between games): its words, its clue matcher (`lang.ts`) and its bots'
 * clues; the room and screen views carry it, so every phone and the TV
 * speak it. Refusals are PartyErrors whose codes the phones translate
 * (views.ts `Actions`); only a refused clue's message is the matcher's own
 * wording, in the room's language.
 *
 * No phone tells what the TV is about to show: what the TV shows (a
 * phase, a turned card, the verdict) reaches the phones when the TV
 * picture with it is up (`party.withTv`, the TV's `tvDelay`), and later
 * still where the TV takes its time (a card's word after its lift and
 * flip, `flip`; a giver's fate near the end of the slams, `fateBefore`;
 * the result once the envelope is open, `resultAfter`). Deadlines and the
 * TV's `until`s are counted from when the TV and the phones show them
 * (`party.deadline`).
 */

import { Emitter, PartyError, stripEmoji, type Json, type Party, type Player } from "@tvpipe/party";

import { LANGS, matcher, type Lang, type Matcher } from "./lang.ts";
import type { Clue, MatchOptions, WordEntry } from "./match.ts";
import {
  addLate,
  awards,
  banked,
  goals,
  guesserOrder,
  guessesEach,
  nextGoal,
  pairKey,
  parts,
  pot,
  POT,
  roomTitle,
  validateFace,
  web,
  wordClue,
  WordDeck,
  type Difficulty,
  type PlayerStats,
  type Result,
  type RoundsSetting,
  type Turn,
} from "./rules.ts";
import type { Award, Bank, BestClue, Card, Face, JinxGroup, People, Person, PlayerState, Reason, RoomView, ScreenView, Settings, Tally } from "./views.ts";

export interface Timings {
  /** The round intro. */
  hotseat: number;
  /** Writing (the host setting: 30/45/60/90 s). */
  write: number;
  /** The jinx check: this, plus `jinxGroup` per group (a group of 3+ cards counts 1.5). */
  jinxBase: number;
  jinxGroup: number;
  /** Each reveal decision (turn a card or guess). */
  decide: number;
  /** Left at least, once the guesser starts typing. */
  typing: number;
  verdict: number;
  /** Phones learn their cards' fate this long before the jinx check ends (the TV slams first). */
  fateBefore: number;
  /** Phones get the verdict this long into it (the TV opens the envelope first). */
  resultAfter: number;
  /** A turned card's word shows on the TV this long after the pick (the lift, then the flip): the other phones get it then, the guesser's at once. */
  flip: number;
  /** Picking the best clue. */
  best: number;
  /** The replay when there is no best clue to pick. */
  replay: number;
  /** The replay after the best clue was picked. */
  replayHold: number;
  /** The bank between rounds. */
  bank: number;
  /** The end's steps (the web stays). */
  endRoom: number;
  endClues: number;
  endAwards: number;
  /** At most one draft update of the TV per this many ms. */
  draftEvery: number;
}

export const DEFAULT_TIMINGS: Timings = {
  hotseat: 4000,
  write: 45_000,
  jinxBase: 4000,
  jinxGroup: 4500,
  decide: 30_000,
  typing: 15_000,
  verdict: 6000,
  fateBefore: 1500,
  resultAfter: 3000,
  flip: 900,
  best: 20_000,
  replay: 8000,
  replayHold: 4000,
  bank: 5000,
  endRoom: 8000,
  endClues: 8000,
  endAwards: 8000,
  draftEvery: 50,
};

/** The writing times the host page (and the VIP's phone) offers, seconds. */
export const WRITE_TIMES = [30, 45, 60, 90] as const;
/** The rounds settings (`auto`: twice with 3–5 players, once with 6–8). */
export const ROUNDS = ["auto", 1, 2] as const;
export const DIFFICULTIES = ["easy", "normal", "hard"] as const;
/** The latecomers settings (the party's `lateJoin`): from the next round, or closed during a game. */
export const LATE_JOINS = ["wait", "closed"] as const;

/** Longest draft the TV shows. */
export const MAX_DRAFT = 24;

export interface JinxOptions {
  /** The room's language (default `en`; the host page's setting, see {@link Jinx.configure}). */
  lang?: Lang | undefined;
  /**
   * The secret words (the language's `data/words*.txt` through the
   * matcher's `parseWordList`): for `lang`, or per language (the languages
   * the room can switch to).
   */
  words: readonly WordEntry[] | Partial<Record<Lang, readonly WordEntry[]>>;
  /** `lang`'s dictionary as a lookup (English: `dict.txt` through match.ts `dictionary`): typo matching. */
  known?: ((word: string) => boolean) | undefined;
  /** Match options per language (the matcher's `dictionary(text)` of its `dict*.txt`): typo matching, word forms. */
  match?: Partial<Record<Lang, MatchOptions>> | undefined;
  /** The room's records (the host page's `localStorage`): the best bank per game length in rounds; see the `record` event. */
  records?: Readonly<Record<number, number>> | undefined;
  /** Words this room dealt before (the host page's `localStorage`), for `lang` or per language; see the `dealt` event. */
  dealt?: readonly string[] | Partial<Record<Lang, readonly string[]>> | undefined;
  rounds?: RoundsSetting | undefined;
  difficulty?: Difficulty | undefined;
  timings?: Partial<Timings> | undefined;
  rng?: (() => number) | undefined;
  minPlayers?: number | undefined;
}

export type Phase = ScreenView["phase"];

export interface JinxEvents {
  phase: [phase: Phase];
  /** A word was dealt: the room's dealt words so far in that language (to keep). */
  dealt: [used: string[], lang: Lang];
  /** A game of `rounds` rounds beat the room's record (or set the first): keep it. */
  record: [rounds: number, chips: number];
  /** The settings changed (the host page or the VIP's phone). */
  settings: [settings: Settings];
  end: [bank: number];
}

interface Profile {
  color: number;
  face: Face;
  bot: boolean;
}

interface Slot {
  clue: Clue;
  bold: boolean;
}

interface RoundCard {
  id: string;
  author: string;
  bold: boolean;
  clue: Clue;
  fate: "alive" | "jinxed";
  turned?: number;
}

interface Outcome {
  result: Result;
  guess?: string;
  near?: Reason;
}

interface Round {
  /** 1-based, counting rounds played this game. */
  n: number;
  guesser: Player;
  givers: Player[];
  each: 1 | 2;
  entry: WordEntry;
  secret: Clue;
  slots: Map<string, (Slot | null)[]>;
  deadline: number;
  cards: RoundCard[];
  groups: JinxGroup[];
  jinxed: number;
  pot: number;
  turns: number;
  picked?: string;
  draft: string;
  typing: boolean;
  outcome?: Outcome;
  banked: number;
  picking: boolean;
  best?: string;
  /** A card turning on the TV: the phones get it when its word shows (`flip`). */
  flipping?: ReturnType<typeof setTimeout> | undefined;
  abort: AbortController;
  signal: AbortSignal;
}

interface Played {
  entry: WordEntry;
  found: boolean;
  guesser: string;
  clues: { display: string; key: string }[];
  /** The best clue, once picked. */
  best?: { clue: string; author: string };
}

const obj = (d: Json): Record<string, Json> => (typeof d === "object" && d !== null && !Array.isArray(d) ? d : {});

export class Jinx extends Emitter<JinxEvents> {
  readonly party: Party;
  readonly minPlayers: number;
  rounds: RoundsSetting;
  difficulty: Difficulty;
  timings: Timings;
  readonly #rng: () => number;
  /** Per language: its matcher, match options and the room's deck (kept from game to game). */
  readonly #langs = new Map<Lang, { m: Matcher; opt: MatchOptions; deck: WordDeck }>();
  #lang: Lang;
  readonly #profiles = new Map<string, Profile>();
  /** Players who left during this game (kept in `people`). */
  #left: Person[] = [];
  /** Players in this game (ids). */
  readonly #ingame = new Set<string>();
  /** The room's bank this game. */
  #bank = 0;
  /** The best bank per game length (rounds). */
  readonly #records = new Map<number, number>();
  readonly #stats = new Map<string, PlayerStats>();
  readonly #pairs = new Map<string, number>();
  #played: Played[] = [];
  #history: Tally["history"] = [];
  #queue: Turn[] = [];
  #times: 1 | 2 = 1;
  #games = 0;
  #phase: Phase = "lobby";
  #running = false;
  #gameAbort = new AbortController();
  #endAbort = new AbortController();
  /** Counts games and closes: what a game queued for the TV (`#withTv`) is dropped once this moved on. */
  #gen = 0;
  #round: Round | undefined;
  /** The screen view without `people` (added on every set). */
  #view: Record<string, unknown> = {};
  readonly #wakers = new Set<() => void>();
  #draftAt = 0;
  #draftTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(party: Party, options: JinxOptions) {
    super();
    this.party = party;
    this.minPlayers = options.minPlayers ?? 3;
    this.rounds = options.rounds ?? "auto";
    this.difficulty = options.difficulty ?? "normal";
    this.timings = { ...DEFAULT_TIMINGS, ...options.timings };
    this.#rng = options.rng ?? Math.random;
    this.#lang = options.lang ?? "en";
    for (const [k, v] of Object.entries(options.records ?? {})) if (Number.isInteger(Number(k)) && Number.isFinite(v)) this.#records.set(Number(k), v);
    const words: Partial<Record<Lang, readonly WordEntry[]>> = Array.isArray(options.words) ? { [this.#lang]: options.words } : (options.words as Partial<Record<Lang, readonly WordEntry[]>>);
    const dealt: Partial<Record<Lang, readonly string[]>> = Array.isArray(options.dealt) ? { [this.#lang]: options.dealt } : ((options.dealt ?? {}) as Partial<Record<Lang, readonly string[]>>);
    for (const l of LANGS) {
      const list = words[l];
      if (!list || list.length === 0) continue;
      const opt: MatchOptions = { ...options.match?.[l] };
      if (l === this.#lang && options.known) opt.known = options.known;
      const m = matcher(l);
      this.#langs.set(l, { m, opt, deck: new WordDeck(list, this.#rng, dealt[l] ?? [], opt, m) });
    }
    if (!this.#langs.has(this.#lang)) throw new Error(`jinx: no words in ${this.#lang}`);
  }

  /** The settings the VIP may change from the phone too (the writing time in seconds; the language aside: {@link lang}). */
  get settings(): Settings {
    return { rounds: this.rounds, write: Math.round(this.timings.write / 1000), difficulty: this.difficulty, late: this.party.lateJoin === "closed" ? "closed" : "wait" };
  }

  /** The room's language. */
  get lang(): Lang {
    return this.#lang;
  }

  /** The languages there are words for. */
  get langs(): Lang[] {
    return [...this.#langs.keys()];
  }

  /** The room's language's matcher, options and deck. */
  get #here(): { m: Matcher; opt: MatchOptions; deck: WordDeck } {
    return this.#langs.get(this.#lang)!;
  }

  get phase(): Phase {
    return this.#phase;
  }

  get running(): boolean {
    return this.#running;
  }

  /** The secret word of the round (for the host page's bots, which cheat), if any. */
  get secret(): string | undefined {
    return this.#round?.entry.word;
  }

  /** The room's dealt words in its language (to keep in `localStorage`). */
  get dealt(): string[] {
    return this.#here.deck.used;
  }

  /** Marks a player as a bot (the TV draws a dashed rim). */
  markBot(id: string): void {
    const pr = this.#profiles.get(id);
    if (pr) pr.bot = true;
    this.#peopleChanged();
  }

  /**
   * Changes the settings between games. A new language (one with words)
   * goes to every phone and the TV at once; `late` is the party's
   * `lateJoin`.
   */
  configure(o: {
    rounds?: RoundsSetting | undefined;
    difficulty?: Difficulty | undefined;
    write?: number | undefined;
    timings?: Partial<Timings> | undefined;
    lang?: Lang | undefined;
    late?: Settings["late"] | undefined;
  }): void {
    if (this.#running) throw new PartyError("running", "Not during a game");
    if (o.lang !== undefined && !this.#langs.has(o.lang)) throw new PartyError("bad-lang", `No words in ${o.lang}`);
    if (o.late !== undefined && !LATE_JOINS.includes(o.late)) throw new PartyError("bad-late", `late: ${LATE_JOINS.join(", ")}`);
    const was = JSON.stringify([this.#lang, this.settings]);
    if (o.lang !== undefined && o.lang !== this.#lang) {
      this.#lang = o.lang;
      this.#view["lang"] = o.lang;
      this.party.room.set({ lang: o.lang });
      this.party.screen.set({ lang: o.lang });
    }
    if (o.rounds !== undefined) this.rounds = o.rounds;
    if (o.difficulty !== undefined) this.difficulty = o.difficulty;
    if (o.timings) this.timings = { ...this.timings, ...o.timings };
    if (o.write !== undefined) this.timings = { ...this.timings, write: o.write };
    if (o.late !== undefined) this.party.lateJoin = o.late;
    const now = this.settings;
    if (JSON.stringify([this.#lang, now]) !== was) {
      this.party.room.set({ settings: now });
      this.emit("settings", now);
    }
  }

  /**
   * Ends a running game and its timers, the end's steps too (the party
   * stays). Closing is not finishing: no final screen, no `end` event; a
   * running game's room goes back to the lobby at once (the TV, the
   * phones), and once this returns the game's rounds and timers write
   * nothing more to the party. The VIP or the host starts a fresh game.
   */
  close(): void {
    this.#gen++;
    this.#gameAbort.abort();
    this.#endAbort.abort();
    clearTimeout(this.#draftTimer);
    this.#draftTimer = undefined;
    if (this.#round) clearTimeout(this.#round.flipping);
    if (!this.#running) return;
    this.#round = undefined;
    this.#running = false;
    this.party.inProgress = false;
    for (const p of this.party.players) this.party.activate(p);
    this.#lobby();
  }

  /** Shows the lobby and handles the phones' actions. */
  open(): void {
    const party = this.party;
    party.handle("face", (d, from) => {
      if (from.role !== "player") throw new PartyError("not-player", "Players only");
      const face = validateFace(d);
      if (!face) throw new PartyError("bad-face", "That's not a face");
      this.#profile(from).face = face;
      if (this.#phase === "lobby" || this.#phase === "end") this.#passiveState(from);
      this.#peopleChanged();
      return null;
    });
    party.handle("start", (_d, from) => {
      if (from.role !== "player" || !from.vip) throw new PartyError("not-vip", "Only the VIP can start");
      if (this.#running) throw new PartyError("running", "The game is on");
      if (this.#phase !== "lobby") throw new PartyError("not-lobby", "Play again from the end screen");
      this.#checkEnough();
      void this.play();
      return null;
    });
    party.handle("again", (_d, from) => {
      if (from.role !== "player" || !from.vip) throw new PartyError("not-vip", "Only the VIP can start again");
      if (this.#running || this.#phase !== "end") throw new PartyError("running", "The game is on");
      this.#checkEnough();
      void this.play();
      return null;
    });
    party.handle("kick", (d, from) => {
      if (from.role !== "player" || !from.vip) throw new PartyError("not-vip", "Only the VIP can remove players");
      if (this.#running) throw new PartyError("running", "Not during a game");
      const id = obj(d)["id"];
      const p = typeof id === "string" ? party.player(id) : undefined;
      if (!p || p === from) throw new PartyError("no-player", "No such player");
      party.kick(p);
      return null;
    });
    party.handle("settings", (d, from) => {
      if (from.role !== "player" || !from.vip) throw new PartyError("not-vip", "Only the VIP can change the settings");
      if (this.#running) throw new PartyError("running", "Not during a game");
      this.configure(this.#checkSettings(d));
      return null;
    });
    party.handle("clue", (d, from) => this.#onClue(d, from as Player));
    party.handle("pick", (d, from) => this.#onPick(d, from as Player));
    party.handle("guess", (d, from) => this.#onGuess(d, from as Player));
    party.handle("pass", (_d, from) => this.#onPass(from as Player));
    party.handle("best", (d, from) => this.#onBest(d, from as Player));
    party.on("input", (p, data) => this.#onInput(p, data));
    party.on("join", (p) => {
      this.#profile(p);
      if (this.#running) p.state.replace(this.#s({ task: "wait" }));
      else for (const x of party.players) this.#passiveState(x);
      this.#peopleChanged();
    });
    party.on("leave", (p) => this.#onLeave(p));
    for (const ev of ["away", "reconnect", "vip", "active"] as const) {
      party.on(ev, () => {
        this.#peopleChanged();
        if (!this.#running) for (const p of party.players) this.#passiveState(p);
        this.#wake();
      });
    }
    for (const p of party.players) this.#profile(p);
    this.#lobby();
  }

  /** The lobby on the TV and every phone (opening, a game closed). */
  #lobby(): void {
    const party = this.party;
    this.#left = [];
    for (const [id] of this.#profiles) if (!party.player(id)) this.#profiles.delete(id);
    this.#setPhase("lobby");
    this.#screen({ phase: "lobby", minPlayers: this.minPlayers, maxPlayers: party.maxPlayers });
    this.#roomView({ phase: "lobby" });
    for (const p of party.players) this.#passiveState(p);
  }

  /** A phone's settings, checked as the host page offers them (a language only with words). */
  #checkSettings(d: Json): { rounds?: Settings["rounds"]; write?: number; difficulty?: Settings["difficulty"]; late?: Settings["late"]; lang?: Lang } {
    const keys = "lang, rounds, write, difficulty, late";
    if (typeof d !== "object" || d === null || Array.isArray(d)) throw new PartyError("bad-settings", keys);
    const out: { rounds?: Settings["rounds"]; write?: number; difficulty?: Settings["difficulty"]; late?: Settings["late"]; lang?: Lang } = {};
    const langs: readonly Json[] = this.langs;
    for (const [key, v] of Object.entries(d)) {
      if (key === "rounds" && (ROUNDS as readonly Json[]).includes(v)) out.rounds = v as Settings["rounds"];
      else if (key === "write" && (WRITE_TIMES as readonly Json[]).includes(v)) out.write = (v as number) * 1000;
      else if (key === "difficulty" && (DIFFICULTIES as readonly Json[]).includes(v)) out.difficulty = v as Settings["difficulty"];
      else if (key === "late" && (LATE_JOINS as readonly Json[]).includes(v)) out.late = v as Settings["late"];
      else if (key === "lang" && langs.includes(v)) out.lang = v as Lang;
      else if (key === "rounds") throw new PartyError("bad-settings", `rounds: ${ROUNDS.join(", ")}`);
      else if (key === "write") throw new PartyError("bad-settings", `write: ${WRITE_TIMES.join(", ")}`);
      else if (key === "difficulty") throw new PartyError("bad-settings", `difficulty: ${DIFFICULTIES.join(", ")}`);
      else if (key === "late") throw new PartyError("bad-settings", `late: ${LATE_JOINS.join(", ")}`);
      else if (key === "lang") throw new PartyError("bad-settings", `lang: ${this.langs.join(", ")}`);
      else throw new PartyError("bad-settings", `${key}: not a setting (${keys})`);
    }
    return out;
  }

  #checkEnough(): void {
    const ready = this.party.connectedPlayers.length;
    if (ready < this.minPlayers) {
      const n = this.minPlayers - ready;
      throw new PartyError("too-few", `Wait for ${n} more player${n === 1 ? "" : "s"}`);
    }
  }

  // -------------------------------------------------------------------------
  // People

  #profile(p: Player): Profile {
    let pr = this.#profiles.get(p.id);
    if (pr) return pr;
    const taken = new Set([...this.party.players.filter((x) => x !== p).map((x) => this.#profiles.get(x.id)?.color), ...this.#left.map((l) => l.color)]);
    let color = [0, 1, 2, 3, 4, 5, 6, 7].find((c) => !taken.has(c));
    if (color === undefined) {
      const present = new Set(this.party.players.filter((x) => x !== p).map((x) => this.#profiles.get(x.id)?.color));
      color = [0, 1, 2, 3, 4, 5, 6, 7].find((c) => !present.has(c)) ?? this.party.players.indexOf(p) % 8;
    }
    const usedFaces = new Set([...this.#profiles.values()].map((x) => ("preset" in x.face ? x.face.preset : -1)));
    const free = [0, 1, 2, 3, 4, 5, 6, 7].filter((f) => !usedFaces.has(f));
    const pool = free.length > 0 ? free : [0, 1, 2, 3, 4, 5, 6, 7];
    pr = { color, face: { preset: pool[Math.floor(this.#rng() * pool.length)]! }, bot: false };
    this.#profiles.set(p.id, pr);
    return pr;
  }

  #person(p: Player): Person {
    const pr = this.#profile(p);
    const out: Person = { id: p.id, name: p.name, color: pr.color, face: pr.face, vip: p.vip, connected: p.connected };
    if (pr.bot) out.bot = true;
    return out;
  }

  #people(): People {
    return [...this.party.players.map((p) => this.#person(p)), ...this.#left];
  }

  #peopleChanged(): void {
    const people = this.#people();
    this.party.screen.set({ people });
    this.party.room.set({ people });
  }

  #onLeave(p: Player): void {
    const pr = this.#profiles.get(p.id);
    this.#queue = this.#queue.filter((t) => t.id !== p.id);
    if ((this.#running || this.#phase === "end") && this.#ingame.has(p.id) && pr) {
      this.#left.push({ id: p.id, name: p.name, color: pr.color, face: pr.face, vip: false, connected: false, ...(pr.bot ? { bot: true } : {}), left: true });
    }
    if (!this.#left.some((l) => l.id === p.id)) this.#profiles.delete(p.id);
    const r = this.#round;
    if (r && r.guesser === p && !r.outcome && this.#running) r.abort.abort();
    if (this.#running) this.#roundsChanged();
    this.#peopleChanged();
    if (!this.#running) for (const x of this.party.players) this.#passiveState(x);
    this.#wake();
  }

  // -------------------------------------------------------------------------
  // Views

  #s(state: PlayerState): Record<string, unknown> {
    return state as unknown as Record<string, unknown>;
  }

  #setPhase(phase: Phase): void {
    this.#phase = phase;
    this.emit("phase", phase);
  }

  #screen(view: Record<string, unknown>): void {
    this.#view = { ...view, lang: this.#lang };
    this.party.screen.replace({ ...this.#view, people: this.#people() });
  }

  #screenSet(fields: Record<string, unknown>): void {
    Object.assign(this.#view, fields);
    for (const [k, v] of Object.entries(fields)) if (v === undefined) delete this.#view[k];
    this.party.screen.set(fields);
  }

  #roomView(fields: Partial<RoomView>): void {
    const r = this.#round;
    const base: Record<string, unknown> = { lang: this.#lang, langs: this.langs, settings: this.settings, people: this.#people(), minPlayers: this.minPlayers, maxPlayers: this.party.maxPlayers };
    if (this.#running && r) Object.assign(base, { round: r.n, rounds: this.#total(), guesser: r.guesser.id });
    this.party.room.replace({ ...base, ...fields });
  }

  /**
   * What the TV shows (a phase, a turned card, results): phones get it
   * when the TV picture with it is up (`party.withTv`; a tvpipe before
   * 0.3.1 has none and sends it at once). The TV gets it at once.
   */
  #withTv(fn: () => void): void {
    // A game closed (or the next one started) meanwhile: dropped.
    const gen = this.#gen;
    if (typeof this.party.withTv === "function") this.party.withTv(() => gen === this.#gen && fn());
    else fn();
  }

  /** Lobby and end states (they follow the roster). */
  #passiveState(p: Player): void {
    if (this.#running) return;
    if (this.#phase === "end" && this.#ingame.has(p.id)) {
      p.state.replace(this.#s(this.#finalState(p)));
      return;
    }
    const pr = this.#profile(p);
    const canStart = this.#phase === "lobby" && p.vip && this.party.connectedPlayers.length >= this.minPlayers;
    p.state.replace(this.#s({ task: "lobby", face: pr.face, color: pr.color, canStart }));
  }

  #tally(): Tally {
    return { found: this.#history.filter((h) => h === "found").length, played: this.#history.length, total: this.#total(), history: [...this.#history] };
  }

  /** Rounds in this game: played, the current one (until counted), the queue. */
  #total(): number {
    const r = this.#round;
    return this.#history.length + (r && this.#history.length < r.n ? 1 : 0) + this.#queue.length;
  }

  #roundsChanged(): void {
    if (!this.#round) return;
    const rounds = this.#total();
    if ("tally" in this.#view) this.#screenSet({ rounds, tally: this.#tally(), bank: this.#bankView() });
    this.party.room.set({ rounds });
  }

  /** The bank, the titles' marks and the record for this game's length. */
  #bankView(): Bank {
    const rounds = this.#total();
    const out: Bank = { chips: this.#bank, goals: goals(rounds) };
    const rec = this.#records.get(rounds);
    if (rec !== undefined) out.record = rec;
    return out;
  }

  /** The base of a round's screen view. */
  #inRound(r: Round): Record<string, unknown> {
    return { round: r.n, rounds: this.#total(), guesser: r.guesser.id, tally: this.#tally(), bank: this.#bankView() };
  }

  #cardView(c: RoundCard, word: boolean): Card {
    const out: Card = { id: c.id, author: c.author, bold: c.bold, fate: c.fate };
    if (word || c.turned !== undefined) out.word = c.clue.display;
    if (c.turned !== undefined) out.turned = c.turned;
    return out;
  }

  #inGame(): Player[] {
    return this.party.players.filter((p) => this.#ingame.has(p.id));
  }

  // -------------------------------------------------------------------------
  // Waiting

  #wake(): void {
    for (const w of [...this.#wakers]) w();
  }

  /** Until `at` (host clock), the signal, or (wakeable) a wake-up. */
  #until(at: number, signal: AbortSignal, wakeable = false): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const done = () => {
        clearTimeout(t);
        signal.removeEventListener("abort", done);
        this.#wakers.delete(done);
        resolve();
      };
      const t = setTimeout(done, Math.max(0, at - this.party.now()));
      signal.addEventListener("abort", done, { once: true });
      if (wakeable) this.#wakers.add(done);
    });
  }

  #sleep(ms: number, signal: AbortSignal): Promise<void> {
    return this.#until(this.party.now() + ms, signal);
  }

  // -------------------------------------------------------------------------
  // A game

  // Plays a whole game with the players there (and those who join).
  /** Plays a whole game; resolves to the room's bank. */
  async play(): Promise<number> {
    if (this.#running) throw new PartyError("running", "The game is on");
    const party = this.party;
    this.#endAbort.abort();
    this.#gameAbort = new AbortController();
    const signal = this.#gameAbort.signal;
    const gen = ++this.#gen;
    this.#running = true;
    party.inProgress = true;
    this.#ingame.clear();
    this.#bank = 0;
    this.#stats.clear();
    this.#pairs.clear();
    this.#played = [];
    this.#history = [];
    this.#left = [];
    this.#round = undefined;
    for (const [id] of this.#profiles) if (!party.player(id)) this.#profiles.delete(id);
    for (const p of party.players) party.activate(p);
    const players = [...party.players];
    for (const p of players) this.#join(p);
    this.#times = guessesEach(this.rounds, players.length);
    this.#queue = guesserOrder(
      players.map((p) => p.id),
      this.#games++,
      this.#times,
    );
    this.#peopleChanged();
    try {
      let n = 0;
      while (!signal.aborted) {
        this.#dealIn();
        if (this.#inGame().length < this.minPlayers) break;
        const turn = this.#queue.shift();
        if (!turn) break;
        const guesser = party.player(turn.id);
        if (!guesser || !this.#ingame.has(guesser.id)) continue;
        await this.#playRound(++n, guesser, signal);
        if (this.#history.length < n) n--; // dropped (the guesser left)
      }
    } finally {
      // Closed: close() did this, and nothing more is written.
      if (gen === this.#gen) {
        this.#round = undefined;
        this.#running = false;
        party.inProgress = false;
        for (const p of party.players) party.activate(p);
      }
    }
    if (signal.aborted || gen !== this.#gen) return this.#bank;
    return this.#end();
  }

  #join(p: Player): void {
    this.#ingame.add(p.id);
    this.#stats.set(p.id, { id: p.id, bestClues: 0, jinxed: 0, turnedRight: 0 });
  }

  /** Late joiners: in from this round, their turns at the end of each pass. */
  #dealIn(): void {
    for (const p of this.party.players) {
      if (this.#ingame.has(p.id)) continue;
      this.party.activate(p);
      this.#join(p);
      this.#queue = addLate(this.#queue, p.id, this.#times);
    }
  }

  async #playRound(n: number, guesser: Player, gameSignal: AbortSignal): Promise<void> {
    const party = this.party;
    const givers = this.#inGame().filter((p) => p !== guesser);
    const here = this.#here;
    const entry = here.deck.deal(
      this.difficulty,
      this.#played.map((x) => x.entry),
    );
    this.emit("dealt", here.deck.used, this.#lang);
    const secret = wordClue(entry.word, here.m) ?? { display: entry.word, key: entry.word, parts: [entry.word], kind: "word" as const };
    const abort = new AbortController();
    const r: Round = {
      n,
      guesser,
      givers,
      each: givers.length === 2 ? 2 : 1,
      entry,
      secret,
      slots: new Map(),
      deadline: 0,
      cards: [],
      groups: [],
      jinxed: 0,
      pot: POT.start,
      turns: 0,
      draft: "",
      typing: false,
      banked: 0,
      picking: false,
      abort,
      signal: AbortSignal.any([gameSignal, abort.signal]),
    };
    this.#round = r;
    for (const p of party.players) if (!this.#ingame.has(p.id)) p.state.replace(this.#s({ task: "wait" }));

    // The hot seat.
    this.#setPhase("hotseat");
    this.#withTv(() => {
      this.#screen({ phase: "hotseat", ...this.#inRound(r), until: party.deadline(this.timings.hotseat) });
      this.#roomView({ phase: "hotseat" });
      for (const p of this.#inGame()) p.state.replace(this.#s({ task: "hotseat", guesser: p === guesser }));
    });
    await this.#sleep(this.timings.hotseat, r.signal);
    if (r.signal.aborted) return;

    await this.#write(r);
    if (r.signal.aborted) return;
    await this.#jinx(r);
    if (r.signal.aborted) return;
    if (r.cards.some((c) => c.fate === "alive")) await this.#reveal(r);
    else r.outcome = { result: "lost" };
    if (r.signal.aborted && !r.outcome) return;
    if (gameSignal.aborted) return;
    this.#verdict(r);
    const resultAfter = Math.min(this.timings.resultAfter, this.timings.verdict);
    await this.#sleep(resultAfter, gameSignal);
    if (gameSignal.aborted) return;
    this.#results(r);
    await this.#sleep(this.timings.verdict - resultAfter, gameSignal);
    if (gameSignal.aborted) return;
    await this.#replay(r, gameSignal);
    if (gameSignal.aborted) return;
    await this.#bankPhase(r, gameSignal);
  }

  // -------------------------------------------------------------------------
  // Writing

  #full(r: Round, p: Player): boolean {
    const s = r.slots.get(p.id);
    return !!s && s.every((x) => x !== null);
  }

  #writeView(r: Round): { done: string[]; sent: number; sentBy: Record<string, number> } {
    const done = r.givers.filter((p) => this.#full(r, p)).map((p) => p.id);
    const sentBy: Record<string, number> = {};
    for (const [id, a] of r.slots) sentBy[id] = a.filter((x) => x !== null).length;
    const sent = Object.values(sentBy).reduce((s, n) => s + n, 0);
    return { done, sent, sentBy };
  }

  async #write(r: Round): Promise<void> {
    const party = this.party;
    // The whole time from when the phones (and the TV) show it.
    r.deadline = party.deadline(this.timings.write);
    const started = r.deadline - this.timings.write;
    for (const g of r.givers) r.slots.set(g.id, new Array<Slot | null>(r.each).fill(null));
    this.#setPhase("write");
    this.#withTv(() => {
      this.#screen({ phase: "write", ...this.#inRound(r), givers: r.givers.map((g) => g.id), each: r.each, ...this.#writeView(r), started, deadline: r.deadline });
      this.#roomView({ phase: "write" });
      for (const g of r.givers) g.state.replace(this.#s(this.#writeState(r, g)));
      r.guesser.state.replace(this.#s({ task: "blind", givers: r.givers.length, done: 0, deadline: r.deadline }));
    });
    const end = r.deadline + party.grace;
    while (!r.signal.aborted && party.now() < end) {
      const live = r.givers.filter((g) => party.players.includes(g));
      if (live.length === 0) break;
      if (live.some((g) => this.#full(r, g)) && live.every((g) => this.#full(r, g) || !g.connected)) break;
      await this.#until(end, r.signal, true);
    }
    // A giver who is gone has no card.
    let i = 0;
    for (const g of r.givers) {
      if (!party.players.includes(g)) continue;
      for (const s of r.slots.get(g.id) ?? []) {
        if (s) r.cards.push({ id: `c${i++}`, author: g.id, bold: s.bold, clue: s.clue, fate: "alive" });
      }
    }
  }

  #writeState(r: Round, g: Player): PlayerState {
    const sent = (r.slots.get(g.id) ?? []).map((s) => (s ? { text: s.clue.display, bold: s.bold } : null));
    return { task: "write", word: r.entry.word, each: r.each, sent, deadline: r.deadline };
  }

  #onClue(d: Json, from: Player): unknown {
    const r = this.#round;
    if (from.role !== "player") throw new PartyError("not-player", "Players only");
    if (!r || this.#phase !== "write" || this.party.now() > r.deadline + this.party.grace) throw new PartyError("late", "Too late: writing is over");
    const slots = r.slots.get(from.id);
    if (!slots) throw new PartyError("not-asked", "You're not writing this round");
    const o = obj(d);
    const text = o["text"];
    const slot = o["slot"] ?? 0;
    if (typeof text !== "string" || text.length > 200) throw new PartyError("empty", "Type a clue");
    if (typeof slot !== "number" || !Number.isInteger(slot) || slot < 0 || slot >= r.each) throw new PartyError("bad-slot", "No such clue slot");
    const bold = o["bold"] === true;
    // The clue is shown on the TV and the phones: no emoji, the party's moderate hook first (a replacement is checked as typed).
    const said = this.party.moderate(stripEmoji(text), "clue", from);
    if (said === false) throw new PartyError("refused", "Try another one");
    const own = slots.filter((s, i): s is Slot => s !== null && i !== slot).map((s) => s.clue);
    const { m, opt } = this.#here;
    const res = m.checkSubmit(said, r.secret, { ...opt, banned: r.entry.banned, alsoRight: r.entry.alsoRight, english: r.entry.english, own });
    // The reason rides in the code ("too-close:plural"): a phone in another
    // language than the room's says it in its own words.
    if (!res.ok) throw new PartyError(res.reason ? `${res.code}:${res.reason}` : res.code, res.message);
    slots[slot] = { clue: res.clue, bold };
    from.state.replace(this.#s(this.#writeState(r, from)));
    const v = this.#writeView(r);
    this.#withTv(() => {
      this.#screenSet(v);
      r.guesser.state.set({ done: v.done.length });
    });
    this.#wake();
    return { text: res.clue.display, bold };
  }

  // -------------------------------------------------------------------------
  // The jinx check

  async #jinx(r: Round): Promise<void> {
    const party = this.party;
    const { m, opt } = this.#here;
    const res = m.groupClues(
      r.cards.map((c) => c.clue),
      r.secret,
      opt,
      [...r.entry.banned, ...r.entry.alsoRight],
      r.entry.english,
    );
    for (const x of res.invalid) r.cards[x.index]!.fate = "jinxed";
    r.groups = res.groups.map((g) => ({
      cards: g.members.map((i) => r.cards[i]!.id),
      pairs: g.links.map((l) => ({ a: r.cards[l.a]!.id, b: r.cards[l.b]!.id, reason: l.reason })),
    }));
    for (const g of res.groups) for (const i of g.members) r.cards[i]!.fate = "jinxed";
    r.jinxed = r.cards.filter((c) => c.fate === "jinxed").length;
    r.pot = this.#pot(r);
    const weight = r.groups.reduce((s, g) => s + (g.cards.length >= 3 ? 1.5 : 1), 0);
    const ms = this.timings.jinxBase + Math.round(this.timings.jinxGroup * weight);
    // Here (`end`) and on the TV's clock (`until`).
    const end = party.now() + ms;
    const until = party.deadline(ms);
    this.#setPhase("jinx");
    this.#withTv(() => {
      this.#screen({ phase: "jinx", ...this.#inRound(r), cards: r.cards.map((c) => this.#cardView(c, false)), groups: r.groups, potBefore: POT.start, pot: r.pot, until });
      this.#roomView({ phase: "jinx" });
      // Phones watch the TV until the slams are done.
      for (const p of this.#inGame()) p.state.replace(this.#s({ task: "tv" }));
    });
    await this.#until(end - this.timings.fateBefore, r.signal);
    if (r.signal.aborted) return;
    this.#withTv(() => this.#fates(r));
    await this.#until(end, r.signal);
  }

  /** Each giver's cards' fate, the guesser how many survived. */
  #fates(r: Round): void {
    const party = this.party;
    const name = (id: string) => party.player(id)?.name ?? this.#left.find((l) => l.id === id)?.name ?? "someone";
    for (const g of r.givers) {
      if (!party.players.includes(g)) continue;
      const cards = r.cards
        .filter((c) => c.author === g.id)
        .map((c) => {
          const group = r.groups.find((x) => x.cards.includes(c.id));
          const pair = group?.pairs.find((p) => p.a === c.id || p.b === c.id);
          const others = group ? [...new Set(group.cards.map((id) => r.cards.find((x) => x.id === id)!.author).filter((a) => a !== g.id))] : [];
          const out: { text: string; bold: boolean; fate: "alive" | "jinxed"; with: string[]; reason?: Reason } = { text: c.clue.display, bold: c.bold, fate: c.fate, with: others.map(name) };
          if (pair) out.reason = pair.reason;
          return out;
        });
      g.state.replace(this.#s({ task: "fate", word: r.entry.word, cards }));
    }
    r.guesser.state.replace(this.#s({ task: "check", survived: r.cards.length - r.jinxed, jinxed: r.jinxed }));
  }

  // -------------------------------------------------------------------------
  // The reveal

  #alive(r: Round): RoundCard[] {
    return r.cards.filter((c) => c.fate === "alive");
  }

  #revealStates(r: Round): void {
    const cards = this.#alive(r).map((c) => this.#cardView(c, false));
    r.guesser.state.replace(this.#s({ task: "guess", cards, pot: r.pot, deadline: r.deadline, jinxed: r.jinxed }));
    for (const g of r.givers) if (this.party.players.includes(g)) g.state.replace(this.#s({ task: "watch", word: r.entry.word, cards, pot: r.pot }));
  }

  async #reveal(r: Round): Promise<void> {
    const party = this.party;
    r.deadline = party.deadline(this.timings.decide);
    const started = r.deadline - this.timings.decide;
    this.#setPhase("reveal");
    this.#withTv(() => this.#screen({
      phase: "reveal",
      ...this.#inRound(r),
      cards: this.#alive(r).map((c) => this.#cardView(c, false)),
      jinxed: r.jinxed,
      pot: r.pot,
      draft: "",
      typing: false,
      started,
      deadline: r.deadline,
    }));
    this.#withTv(() => {
      this.#roomView({ phase: "reveal" });
      this.#revealStates(r);
    });
    while (!r.outcome && !r.signal.aborted) {
      await this.#until(r.deadline, r.signal, true);
      if (r.outcome || r.signal.aborted) break;
      if (party.now() >= r.deadline) this.#timeout(r);
    }
    clearTimeout(this.#draftTimer);
    this.#draftTimer = undefined;
    clearTimeout(r.flipping);
    r.flipping = undefined;
  }

  /** A decision ran out: the draft as the guess, else a random card, else a pass. */
  #timeout(r: Round): void {
    if (r.typing && r.turns > 0) {
      const said = this.party.moderate(r.draft, "guess", r.guesser);
      const c = this.#here.m.clean(said === false ? "" : said);
      if (c.ok) return this.#judge(r, c.clue);
      return this.#finish(r, { result: "pass" });
    }
    const down = this.#alive(r).filter((c) => c.turned === undefined);
    const card = down[Math.floor(this.#rng() * down.length)];
    if (card) this.#turn(r, card);
    else this.#finish(r, { result: "pass" });
  }

  /** The pot after the jinx check and the turns so far. */
  #pot(r: Round): number {
    const jinxed = r.cards.filter((c) => c.fate === "jinxed");
    const turned = r.cards.filter((c) => c.turned !== undefined);
    return pot({ jinxed: jinxed.length, boldJinxed: jinxed.filter((c) => c.bold).length, turned: turned.length, boldTurned: turned.filter((c) => c.bold).length });
  }

  /**
   * A card turns: on the TV at once (the lift, then the flip), and on the
   * guesser's phone at once with its word, so the pick feels like turning
   * a card in hand; the other phones get it when the TV shows it (`flip`
   * later, with the TV's lag). Until then the guesser's phone marks the
   * card `turning`: no other pick and no lock-in yet (typing the guess
   * is fine: the draft rides on the TV beside the flip), and the next
   * decision's time counts from when the TV has the word.
   */
  #turn(r: Round, card: RoundCard): void {
    const party = this.party;
    card.turned = ++r.turns;
    r.pot = this.#pot(r);
    r.picked = card.id;
    r.typing = false;
    r.deadline = party.deadline(this.timings.flip + this.timings.decide);
    const started = r.deadline - this.timings.decide;
    this.#screenSet({ cards: this.#alive(r).map((c) => this.#cardView(c, false)), pot: r.pot, picked: card.id, typing: false, started, deadline: r.deadline });
    r.guesser.state.set({ cards: this.#alive(r).map((c) => this.#cardView(c, false)), pot: r.pot, deadline: r.deadline, turning: card.id });
    clearTimeout(r.flipping);
    r.flipping = setTimeout(() => {
      r.flipping = undefined;
      if (this.#round !== r || this.#phase !== "reveal" || r.outcome || r.signal.aborted) return;
      this.#withTv(() => this.#revealStates(r));
    }, this.timings.flip);
    this.#wake();
  }

  #finish(r: Round, o: Outcome): void {
    r.outcome = o;
    this.#wake();
  }

  #judge(r: Round, guess: Clue): void {
    const { m, opt } = this.#here;
    const near = m.judgeGuess(guess, r.secret, opt, r.entry.alsoRight);
    const o: Outcome = { result: near ? "right" : "wrong", guess: guess.display };
    if (near && near !== "same word") o.near = near;
    this.#finish(r, o);
  }

  #revealTurn(from: Player): Round {
    const r = this.#round;
    if (from.role !== "player") throw new PartyError("not-player", "Players only");
    if (!r || this.#phase !== "reveal" || r.outcome) throw new PartyError("late", "Not now");
    if (from !== r.guesser) throw new PartyError("not-guesser", "Only the guesser can do that");
    return r;
  }

  #onPick(d: Json, from: Player): unknown {
    const r = this.#revealTurn(from);
    const id = obj(d)["card"];
    const card = this.#alive(r).find((c) => c.id === id);
    if (!card || card.turned !== undefined) throw new PartyError("bad-card", "Pick a face-down card");
    this.#turn(r, card);
    return null;
  }

  #onGuess(d: Json, from: Player): unknown {
    const r = this.#revealTurn(from);
    if (r.turns === 0) throw new PartyError("no-card", "Turn a card first");
    const text = obj(d)["text"];
    // The guess is shown on the TV: no emoji, the party's moderate hook first.
    const said = typeof text === "string" && text.trim() !== "" ? this.party.moderate(stripEmoji(text.slice(0, 200)), "guess", from) : "";
    if (said === false) throw new PartyError("refused", "Try another one");
    const c = this.#here.m.clean(said);
    if (!c.ok) throw new PartyError(c.error, c.error === "empty" ? "Type a guess" : c.message);
    r.draft = [...c.clue.display].slice(0, MAX_DRAFT).join("");
    this.#judge(r, c.clue);
    return null;
  }

  #onPass(from: Player): unknown {
    const r = this.#revealTurn(from);
    this.#finish(r, { result: "pass" });
    return null;
  }

  #onInput(p: Player, data: Json): void {
    const r = this.#round;
    if (!r || this.#phase !== "reveal" || r.outcome || p !== r.guesser) return;
    const raw = obj(data)["draft"];
    if (typeof raw !== "string") return;
    // eslint-disable-next-line no-control-regex
    const draft = [...stripEmoji(raw).replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, "")].slice(0, MAX_DRAFT).join("");
    if (draft === r.draft) return;
    r.draft = draft;
    if (draft !== "" && !r.typing) {
      // Once typing, at least `typing` ms left.
      r.typing = true;
      r.deadline = Math.max(r.deadline, this.party.now() + this.timings.typing);
      clearTimeout(this.#draftTimer);
      this.#draftTimer = undefined;
      this.#draftAt = Date.now();
      this.#screenSet({ draft: this.#shownDraft(r), typing: true, deadline: r.deadline });
      r.guesser.state.set({ deadline: r.deadline });
      this.#wake();
      return;
    }
    const wait = this.#draftAt + this.timings.draftEvery - Date.now();
    if (wait <= 0) {
      this.#draftAt = Date.now();
      this.#screenSet({ draft: this.#shownDraft(r) });
    } else if (!this.#draftTimer) {
      this.#draftTimer = setTimeout(() => {
        this.#draftTimer = undefined;
        this.#draftAt = Date.now();
        if (this.#round === r && this.#phase === "reveal" && !r.outcome) this.#screenSet({ draft: this.#shownDraft(r) });
      }, wait);
    }
  }

  /** The draft as the TV shows it: through the party's moderate hook (refused: nothing). */
  #shownDraft(r: Round): string {
    if (r.draft === "") return "";
    const said = this.party.moderate(r.draft, "guess", r.guesser);
    return said === false ? "" : [...said].slice(0, MAX_DRAFT).join("");
  }

  // -------------------------------------------------------------------------
  // Verdict, replay, the bank

  #verdict(r: Round): void {
    const party = this.party;
    const o = r.outcome!;
    r.banked = banked(o.result, r.pot, this.#bank);
    this.#bank += r.banked;
    // The game's record.
    const found = o.result === "right";
    this.#history.push(found ? "found" : "missed");
    this.#played.push({ entry: r.entry, found, guesser: r.guesser.id, clues: r.cards.map((c) => ({ display: c.clue.display, key: c.clue.key })) });
    for (const c of r.cards) {
      const st = this.#stats.get(c.author);
      if (!st) continue;
      if (c.fate === "jinxed") st.jinxed++;
      else if (found && c.turned !== undefined) st.turnedRight++;
    }
    for (const g of r.groups) {
      const authors = [...new Set(g.cards.map((id) => r.cards.find((c) => c.id === id)!.author))];
      for (let i = 0; i < authors.length; i++) {
        for (let j = i + 1; j < authors.length; j++) {
          const k = pairKey(authors[i]!, authors[j]!);
          this.#pairs.set(k, (this.#pairs.get(k) ?? 0) + 1);
        }
      }
    }
    const view: Record<string, unknown> = {
      phase: "verdict",
      ...this.#inRound(r),
      word: r.entry.word,
      result: o.result,
      cards: r.cards.map((c) => this.#cardView(c, true)),
      banked: r.banked,
      pot: r.pot,
      until: party.deadline(this.timings.verdict),
    };
    if (o.guess !== undefined && (o.result === "right" || o.result === "wrong")) view["guess"] = o.guess;
    if (o.near) view["near"] = o.near;
    this.#setPhase("verdict");
    this.#withTv(() => {
      this.#screen(view);
      this.#roomView({ phase: "verdict" });
      // Phones watch the TV until the envelope is open.
      for (const p of this.#inGame()) p.state.replace(this.#s({ task: "tv" }));
    });
  }

  /** The verdict on the phones (after `resultAfter`, when the TV has it too). */
  #results(r: Round): void {
    this.#withTv(() => {
      for (const p of this.#inGame()) p.state.replace(this.#s(this.#resultState(r, p)));
    });
  }

  #resultState(r: Round, p: Player): PlayerState {
    const result = r.outcome!.result;
    const mine = parts(
      p.id,
      result,
      r.cards.map((c) => ({ author: c.author, bold: c.bold, fate: c.fate, turned: c.turned !== undefined })),
    );
    if (r.best && r.cards.find((c) => c.id === r.best)?.author === p.id) mine.push("best");
    return { task: "result", word: r.entry.word, result, guesser: p === r.guesser, banked: r.banked, bank: this.#bank, parts: mine };
  }

  async #replay(r: Round, signal: AbortSignal): Promise<void> {
    const party = this.party;
    const right = r.outcome!.result === "right" && party.players.includes(r.guesser);
    const choices = this.#alive(r);
    r.picking = right && choices.length > 0;
    const deadline = party.deadline(this.timings.best);
    const view: Record<string, unknown> = {
      phase: "replay",
      ...this.#inRound(r),
      word: r.entry.word,
      result: r.outcome!.result,
      cards: r.cards.map((c) => this.#cardView(c, true)),
      groups: r.groups,
      picking: r.picking,
      banked: r.banked,
      pot: r.pot,
    };
    if (r.picking) view["deadline"] = deadline;
    this.#setPhase("replay");
    this.#withTv(() => {
      this.#screen(view);
      this.#roomView({ phase: "replay" });
      if (r.picking) r.guesser.state.replace(this.#s({ task: "best", cards: choices.map((c) => this.#cardView(c, true)), deadline }));
    });
    if (!r.picking) {
      await this.#sleep(this.timings.replay, signal);
      return;
    }
    while (r.picking && !signal.aborted && party.now() < deadline + party.grace && party.players.includes(r.guesser)) {
      await this.#until(deadline + party.grace, signal, true);
    }
    if (signal.aborted) return;
    if (r.picking) {
      r.picking = false;
      this.#withTv(() => {
        this.#screenSet({ picking: false, deadline: undefined });
        if (party.players.includes(r.guesser)) r.guesser.state.replace(this.#s(this.#resultState(r, r.guesser)));
      });
      return;
    }
    await this.#sleep(this.timings.replayHold, signal);
  }

  #onBest(d: Json, from: Player): unknown {
    const r = this.#round;
    if (from.role !== "player") throw new PartyError("not-player", "Players only");
    if (!r || this.#phase !== "replay" || !r.picking) throw new PartyError("late", "Not now");
    if (from !== r.guesser) throw new PartyError("not-guesser", "Only the guesser picks");
    const id = obj(d)["card"];
    const card = this.#alive(r).find((c) => c.id === id);
    if (!card) throw new PartyError("bad-card", "Pick one of the clues");
    r.picking = false;
    r.best = card.id;
    const st = this.#stats.get(card.author);
    if (st) st.bestClues++;
    const played = this.#played[this.#played.length - 1];
    if (played) played.best = { clue: card.clue.display, author: card.author };
    const author = this.party.player(card.author);
    this.#withTv(() => {
      this.#screenSet({ picking: false, best: card.id, deadline: undefined });
      r.guesser.state.replace(this.#s(this.#resultState(r, r.guesser)));
      if (author) author.state.replace(this.#s(this.#resultState(r, author)));
    });
    this.#wake();
    return null;
  }

  async #bankPhase(r: Round, signal: AbortSignal): Promise<void> {
    const party = this.party;
    const next = this.#queue.find((t) => party.player(t.id));
    const view: Record<string, unknown> = { phase: "bank", ...this.#inRound(r), banked: r.banked, until: party.deadline(this.timings.bank) };
    if (next) view["next"] = next.id;
    this.#setPhase("bank");
    const goal = nextGoal(this.#bank, this.#total());
    this.#withTv(() => {
      this.#screen(view);
      this.#roomView({ phase: "bank" });
      for (const p of this.#inGame()) {
        const st: PlayerState = { task: "bank", bank: this.#bank, banked: r.banked, next: next?.id === p.id };
        if (goal) st.goal = goal;
        p.state.replace(this.#s(st));
      }
    });
    await this.#sleep(this.timings.bank, signal);
  }

  // -------------------------------------------------------------------------
  // The end

  #finalState(p: Player): PlayerState {
    const view = this.#view as { awards?: Award[]; record?: true };
    const award = (view.awards ?? []).find((a) => a.ids.includes(p.id));
    const found = this.#history.filter((h) => h === "found").length;
    const out: PlayerState = {
      task: "final",
      bank: this.#bank,
      title: roomTitle(this.#bank, this.#history.length),
      record: view.record === true,
      canRestart: p.vip,
      found,
      total: this.#history.length,
    };
    if (award) out.award = award.kind;
    return out;
  }

  async #end(): Promise<number> {
    const party = this.party;
    this.#endAbort = new AbortController();
    const signal = this.#endAbort.signal;
    const present = this.#inGame().map((p) => this.#stats.get(p.id)!);
    const aw = awards(present, this.#pairs);
    const rounds = this.#history.length;
    const bank: Bank = { chips: this.#bank, goals: goals(rounds) };
    const before = this.#records.get(rounds);
    if (before !== undefined) bank.record = before;
    const record = rounds > 0 && this.#bank > 0 && (before === undefined || this.#bank > before);
    const clues: BestClue[] = this.#played.filter((x) => x.best).map((x) => ({ word: x.entry.word, clue: x.best!.clue, author: x.best!.author, guesser: x.guesser }));
    const view: Record<string, unknown> = {
      phase: "end",
      step: "room",
      tally: this.#tally(),
      bank,
      title: roomTitle(this.#bank, rounds),
      words: this.#played.map((x) => ({ word: x.entry.word, found: x.found, guesser: x.guesser })),
      clues,
      awards: aw,
      web: web(this.#played.map((x) => ({ word: x.entry.word, found: x.found, clues: x.clues }))),
    };
    if (record) {
      view["record"] = true;
      this.#records.set(rounds, this.#bank);
      this.emit("record", rounds, this.#bank);
    }
    this.#setPhase("end");
    this.#withTv(() => {
      this.#screen(view);
      this.#roomView({ phase: "end" });
      for (const p of party.players) this.#passiveState(p);
    });
    this.emit("end", this.#bank);
    void (async () => {
      await this.#sleep(this.timings.endRoom, signal);
      if (signal.aborted) return;
      if (clues.length > 0) {
        this.#screenSet({ step: "clues" });
        await this.#sleep(this.timings.endClues, signal);
        if (signal.aborted) return;
      }
      if (aw.length > 0) {
        this.#screenSet({ step: "awards" });
        await this.#sleep(this.timings.endAwards, signal);
        if (signal.aborted) return;
      }
      this.#screenSet({ step: "web" });
    })();
    return this.#bank;
  }
}
