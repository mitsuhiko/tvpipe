/**
 * Crosstalk on a party, for 4 to 12 players in two teams
 * (docs/crosstalk-design.md): the lobby (teams, spymasters, settings),
 * then rounds until a team has turned all its cards: both spymasters
 * type a clue at once (it reaches only their team's phones), then both
 * teams guess in steps, each locking one card a step, both cards turned
 * on the TV together, until both teams have stopped. At the end the TV
 * and the phones show what was secret: the key, every clue, both pads.
 *
 * The host is the only authority. The views are in `views.ts`; this
 * class recomputes all of them from its state ({@link Crosstalk.#sync})
 * whenever something changes: inside `party.withTv` for what the TV
 * shows (a phase, a flip), at once for what only a team sees (its pins,
 * its pad, its own lock).
 */

import { Emitter, PartyError, type Json, type Party, type Player, type Sender } from "@tvpipe/party";

import * as en from "./match.ts";
import * as de from "./match-de.ts";
import {
  afterCard,
  balance,
  BOARD,
  BOARD_MODES,
  checkClue,
  cleanNote,
  dealBoard,
  DIFFICULTIES,
  isTeam,
  majority,
  matcher,
  MIN_PLAYERS,
  MIN_TEAM,
  nextSpymaster,
  otherTeam,
  outcome,
  PAD,
  resultOf,
  shuffle,
  smallerTeam,
  TEAMS,
  type BoardMode,
  type Card,
  type Choice,
  type Difficulty,
  type Lang,
  type MatchOptions,
  type Outcome,
  type PadLine,
  type Stop,
  type Team,
  type WordEntry,
} from "./rules.ts";
import type { BoardCard, ClueLine, Flip, MeView, Phase, Reveal, RoomView, Settings, TeamStatus, TeamView } from "./views.ts";

export interface Timings {
  /** The rules on the TV before the first round. */
  intro: number;
  /** The clue phase (the room's setting). */
  clue: number;
  /** A step (the room's setting). */
  step: number;
  /** After a step's flip, before the next step. */
  flip: number;
  /** Between rounds: what the round did. */
  roundEnd: number;
}

export const DEFAULT_TIMINGS: Timings = { intro: 8000, clue: 90_000, step: 30_000, flip: 2800, roundEnd: 4000 };

/** For trying the game: everything short. */
export const FAST_TIMINGS: Timings = { intro: 3000, clue: 30_000, step: 15_000, flip: 1800, roundEnd: 2500 };

/** What the room can pick (seconds). */
export const CLUE_TIMES = [60, 90, 120] as const;
export const STEP_TIMES = [20, 30, 45] as const;
/** Latecomers: from the next round, or shut out (they can still rejoin by name); never into a running round. */
export const LATE = ["wait", "closed"] as const;
/** What the VIP's `settings` action takes. */
const SETTING_KEYS = ["lang", "clueTime", "stepTime", "deal", "difficulty", "late"];

export interface GameOptions {
  /** The word lists per language (the matcher's `parseWordList` of `data/words*.txt`). */
  words: Partial<Record<Lang, readonly WordEntry[]>>;
  /** Match options per language (the matcher's `dictionary` of `data/dict*.txt`). */
  match?: Partial<Record<Lang, MatchOptions>> | undefined;
  /** Words the room had per language (from the host page's storage): dealt after the others. */
  used?: Partial<Record<Lang, readonly string[]>> | undefined;
  lang?: Lang | undefined;
  minPlayers?: number | undefined;
  timings?: Partial<Timings> | undefined;
  rng?: (() => number) | undefined;
  deal?: BoardMode | undefined;
  difficulty?: Difficulty | undefined;
}

export interface GameEvents {
  phase: [phase: Phase];
  settings: [settings: Settings];
  /** A game is over (not when closed). */
  end: [outcome: Outcome];
  /** A board was dealt: the room's used words of the language now (to keep). */
  dealt: [lang: Lang, used: string[]];
  /** Someone changed team, or a team its spymaster (the host page's tags). */
  teams: [];
}

/** A fixed board (tests, the live check's screenshots): words and colours, in place. */
export type Script = readonly { word: string; color: Card["color"] }[];

interface TeamState {
  /** This round's clue, once its spymaster sent it. */
  clue: { word: string; number: number } | null;
  history: ClueLine[];
  /** Wrong cards this game (neutral, the other team's). */
  wrong: number;
  /** Still guessing this round. */
  active: boolean;
  stop: Stop | null;
  /** Cards turned this round. */
  turned: number;
  pins: Map<string, Choice>;
  /** This step's choice, once locked. */
  lock: Choice | null;
  pad: PadLine[];
  padSeq: number;
}

interface GameState {
  board: Card[];
  /** Who turned each card (empty: face down), and in which step. */
  by: Team[][];
  at: number[];
  round: number;
  step: number;
  roundStep: number;
  deadline: number | null;
  duration: number | null;
  teams: Record<Team, TeamState>;
  flip: Flip | null;
  outcome: Outcome | null;
  /** The spymasters of this game, as they were (the reveal names them). */
  spymasters: Record<Team, string | null>;
  /** A step is open: its cards can be locked. */
  open: boolean;
}

/** Phone texts the game sends itself (refusals), per language. */
const TEXT: Record<Lang, { tooClose: (word: string, why: string) => string; badNumber: string; notOnPad: string; notClue: string }> = {
  en: {
    tooClose: (word, why) => `Too close to ${word.toUpperCase()}: ${why}`,
    badNumber: "Pick a number from 1 to 9",
    notOnPad: "That can't go on the pad",
    notClue: "That can't be a clue",
  },
  de: {
    tooClose: (word, why) => `Zu nah an ${word.toUpperCase()}: ${why}`,
    badNumber: "Wähle eine Zahl von 1 bis 9",
    notOnPad: "Das kann nicht auf den Block",
    notClue: "Das geht nicht als Hinweis",
  },
};

export class Crosstalk extends Emitter<GameEvents> {
  readonly party: Party;
  readonly minPlayers: number;
  timings: Timings;
  /** A fixed board for the next game (then cleared). */
  script: Script | undefined;
  readonly #rng: () => number;
  readonly #words = new Map<Lang, readonly WordEntry[]>();
  readonly #match = new Map<Lang, MatchOptions>();
  readonly #used = new Map<Lang, Set<string>>();
  #lang: Lang;
  #board: BoardMode;
  #difficulty: Difficulty;
  /** Teams by player id: everyone in the room has one (latecomers get theirs when they come in). */
  readonly #teams = new Map<string, Team>();
  /** The spymasters (of the game running, or of the next one). */
  #spy: Record<Team, string | null> = { red: null, blue: null };
  /** Names by id, kept after a player left (the reveal still names them). */
  readonly #names = new Map<string, string>();
  #phase: Phase = "lobby";
  #running = false;
  #abort = new AbortController();
  #game = 0;
  #g: GameState | undefined;
  /** The last game's state, shown at the end until the next starts. */
  #last: GameState | undefined;
  /** The teams and spymasters as last synced (to tell when they change). */
  #teamsWere = "";
  /** Wakes the phase waiting (a clue came in, a team locked). */
  #poke: () => void = () => {};

  constructor(party: Party, options: GameOptions) {
    super();
    this.party = party;
    this.minPlayers = Math.max(MIN_PLAYERS, options.minPlayers ?? MIN_PLAYERS);
    this.timings = { ...DEFAULT_TIMINGS, ...options.timings };
    this.#rng = options.rng ?? Math.random;
    this.#lang = options.lang ?? "en";
    for (const [l, list] of Object.entries(options.words) as [Lang, readonly WordEntry[]][]) {
      if (list.length >= BOARD.size) this.#words.set(l, list);
    }
    for (const [l, opt] of Object.entries(options.match ?? {}) as [Lang, MatchOptions][]) this.#match.set(l, opt);
    for (const [l, used] of Object.entries(options.used ?? {}) as [Lang, string[]][]) this.#used.set(l, new Set(used));
    if (!this.#words.has(this.#lang)) throw new Error(`crosstalk: no words in ${this.#lang}`);
    this.#board = options.deal ?? "tangled";
    this.#difficulty = options.difficulty ?? "normal";
  }

  get settings(): Settings {
    const late = this.party.lateJoin === "closed" ? "closed" : "wait";
    return { clueTime: this.timings.clue / 1000, stepTime: this.timings.step / 1000, deal: this.#board, difficulty: this.#difficulty, late };
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

  get langs(): Lang[] {
    return [...this.#words.keys()];
  }

  /** A player's team (tests, the host page's tags). */
  teamOf(id: string): Team | undefined {
    return this.#teams.get(id);
  }

  /** Whether a player is a spymaster (of the game, or of the next). */
  isSpymaster(id: string): boolean {
    return this.#spy.red === id || this.#spy.blue === id;
  }

  /**
   * The bots' oracle (host page, tests; never sent to a phone): the
   * colours of the board for a player of the game running.
   */
  key(id: string): Card["color"][] | undefined {
    return this.#g && this.#teams.has(id) ? this.#g.board.map((c) => c.color) : undefined;
  }

  /** The game being played (tests). */
  get state(): Readonly<GameState> | undefined {
    return this.#g;
  }

  // -------------------------------------------------------------------------
  // The room

  /** Shows the lobby and handles the phones. */
  open(): void {
    const party = this.party;
    const vipOnly = (from: Sender) => {
      if (from.role !== "player" || !from.vip) throw new PartyError("not-vip", "Only the VIP can do this");
    };
    const between = () => {
      if (this.#running) throw new PartyError("running", "Not during a game");
    };
    party.handle("start", (_d, from) => {
      vipOnly(from);
      between();
      const ready = party.connectedPlayers.length;
      if (ready < this.minPlayers) throw new PartyError("too-few", `Wait for ${this.minPlayers - ready} more`);
      void this.play();
      return null;
    });
    party.handle("kick", (d, from) => {
      vipOnly(from);
      between();
      const id = obj(d)["id"];
      const p = typeof id === "string" ? party.player(id) : undefined;
      if (!p || p === from) throw new PartyError("no-player", "No such player");
      party.kick(p);
      return null;
    });
    party.handle("settings", (d, from) => {
      vipOnly(from);
      between();
      const v = obj(d);
      for (const k of Object.keys(v)) if (!SETTING_KEYS.includes(k)) throw new PartyError("bad-settings", `${k}: not a setting`);
      const oneOf = <T extends Json>(key: string, list: readonly T[]): T | undefined => {
        if (v[key] === undefined) return undefined;
        if (!list.includes(v[key] as T)) throw new PartyError("bad-settings", `${key}: ${list.join(", ")}`);
        return v[key] as T;
      };
      // The same choices as the host page's (host/host.ts `settings`): a language with words, latecomers waiting or shut out.
      this.configure({
        lang: oneOf("lang", this.langs),
        clueTime: oneOf("clueTime", CLUE_TIMES),
        stepTime: oneOf("stepTime", STEP_TIMES),
        deal: oneOf("deal", BOARD_MODES),
        difficulty: oneOf("difficulty", DIFFICULTIES),
        late: oneOf("late", LATE),
      });
      return null;
    });
    party.handle("team", (d, from) => {
      between();
      const team = obj(d)["team"];
      if (from.role !== "player" || !isTeam(team)) throw new PartyError("bad-team", "red or blue");
      const was = this.#teams.get(from.id);
      if (was === team) return null;
      this.#teams.set(from.id, team);
      if (was && this.#spy[was] === from.id) this.#spy[was] = this.#members(was)[0] ?? null;
      this.#spy[team] ??= from.id;
      this.#sync();
      return null;
    });
    party.handle("spymaster", (_d, from) => {
      between();
      const team = from.role === "player" ? this.#teams.get(from.id) : undefined;
      if (!team) throw new PartyError("no-team", "Pick a team first");
      this.#spy[team] = from.id;
      this.#sync();
      return null;
    });
    party.handle("shuffle", (_d, from) => {
      vipOnly(from);
      between();
      const ids = shuffle(
        party.players.map((p) => p.id),
        this.#rng,
      );
      const first: Team = this.#rng() < 0.5 ? "red" : "blue";
      ids.forEach((id, i) => this.#teams.set(id, i % 2 === 0 ? first : otherTeam(first)));
      for (const t of TEAMS) this.#spy[t] = this.#members(t)[0] ?? null;
      this.#sync();
      return null;
    });
    party.handle("clue", (d, from) => this.#clue(d, from));
    party.handle("pin", (d, from) => this.#pin(d, from));
    party.handle("lock", (_d, from) => this.#lock(from));
    party.handle("pad", (d, from) => this.#pad(d, from));
    party.on("join", (p) => {
      this.#names.set(p.id, p.name);
      if (!this.#running) this.#seat(p.id);
      this.#sync();
    });
    party.on("leave", (p) => this.#gone(p.id));
    party.on("away", (p) => {
      this.#release(p.id);
      this.#sync();
      this.#poke();
    });
    party.on("reconnect", () => {
      this.#sync();
      this.#poke();
    });
    this.#setPhase("lobby");
    this.#sync();
  }

  /**
   * Changes the settings or the language before a game (the host page,
   * the VIP's phone); every phone, the TV and the host page follow.
   */
  configure(o: { [K in keyof Settings]?: Settings[K] | undefined } & { lang?: Lang | undefined; timings?: Partial<Timings> | undefined }): void {
    if (this.#running) throw new PartyError("running", "Not during a game");
    if (o.lang !== undefined && !this.langs.includes(o.lang)) throw new PartyError("bad-lang", `Nothing to play in ${o.lang}`);
    const was = JSON.stringify([this.#lang, this.settings]);
    if (o.timings) this.timings = { ...this.timings, ...o.timings };
    if (o.late !== undefined && (LATE as readonly string[]).includes(o.late)) this.party.lateJoin = o.late;
    if (o.lang !== undefined) this.#lang = o.lang;
    if (o.clueTime !== undefined && o.clueTime > 0) this.timings.clue = o.clueTime * 1000;
    if (o.stepTime !== undefined && o.stepTime > 0) this.timings.step = o.stepTime * 1000;
    if (o.deal !== undefined) this.#board = o.deal;
    if (o.difficulty !== undefined) this.#difficulty = o.difficulty;
    this.#sync();
    if (JSON.stringify([this.#lang, this.settings]) !== was) this.emit("settings", this.settings);
  }

  /**
   * Ends a running game and its timers (the party stays): the lobby at
   * once (closing is not finishing), waiting players in, nothing of the
   * old game written after this returns.
   */
  close(): void {
    if (!this.#running) return;
    this.#game++;
    this.#abort.abort();
    this.#stop();
    this.#last = undefined;
    this.#setPhase("lobby");
    this.#sync();
  }

  #stop(): void {
    this.#g = undefined;
    this.#running = false;
    this.#poke = () => {};
    this.party.inProgress = false;
    for (const p of this.party.players) {
      if (p.waiting) this.party.activate(p);
      if (!this.#teams.has(p.id)) this.#seat(p.id);
    }
    this.#sync();
  }

  #setPhase(phase: Phase): void {
    this.#phase = phase;
    this.emit("phase", phase);
  }

  // -------------------------------------------------------------------------
  // Teams

  /** A team's players in the room, in the order they joined. */
  #members(t: Team): string[] {
    return this.party.players.filter((p) => this.#teams.get(p.id) === t && !p.waiting).map((p) => p.id);
  }

  /** A team for a newcomer (the smaller one); the first of a team is its spymaster. */
  #seat(id: string): void {
    if (this.#teams.has(id)) return;
    const t = smallerTeam({ red: this.#members("red").length, blue: this.#members("blue").length }, this.#rng);
    this.#teams.set(id, t);
    this.#spy[t] ??= id;
  }

  /** A player left for good: their team, spymaster role, pins and pad locks. */
  #gone(id: string): void {
    const t = this.#teams.get(id);
    this.#teams.delete(id);
    this.#release(id);
    if (t) {
      this.#g?.teams[t].pins.delete(id);
      if (this.#spy[t] === id) {
        // The next of the team takes over (in a game they see the key from now on).
        const members = this.#members(t);
        this.#spy[t] = members[0] ?? null;
        if (this.#g) this.#g.spymasters[t] = this.#spy[t];
      }
    }
    this.#sync();
    this.#poke();
  }

  /** The operatives of a team in the game (not its spymaster). */
  #operatives(t: Team): string[] {
    return this.#members(t).filter((id) => id !== this.#spy[t]);
  }

  /** The operatives of a team who are there: their majority locks. */
  #voters(t: Team): string[] {
    return this.#operatives(t).filter((id) => this.party.player(id)?.connected);
  }

  // -------------------------------------------------------------------------
  // Views

  #name(id: string | null): string {
    if (!id) return "";
    return this.party.player(id)?.name ?? this.#names.get(id) ?? "?";
  }

  #teamStatus(t: Team): TeamStatus {
    const g = this.#g;
    if (!g) return this.#phase === "lobby" ? "lobby" : "idle";
    const s = g.teams[t];
    if (this.#phase === "clue") return s.clue ? "ready" : "thinking";
    if (this.#phase === "guess") return !s.active ? "done" : s.lock !== null ? "locked" : "guessing";
    return "idle";
  }

  #boardView(g: GameState): BoardCard[] {
    return g.board.map((c, i) => ({ word: c.word, color: g.by[i]!.length > 0 ? c.color : null, by: g.by[i]!, at: g.at[i]! }));
  }

  #found(g: GameState, t: Team): number {
    return g.board.filter((c, i) => c.color === t && g.by[i]!.length > 0).length;
  }

  #room(): RoomView {
    const g = this.#g ?? (this.#phase === "end" ? this.#last : undefined);
    const names: Record<string, string> = {};
    for (const [id, n] of this.#names) names[id] = n;
    for (const p of this.party.players) names[p.id] = p.name;
    const teams = {} as Record<Team, TeamView>;
    for (const t of TEAMS) {
      const s = g?.teams[t];
      // At the end: who was spymaster (the next game's are in `next`).
      const spymaster = !this.#running && g ? g.spymasters[t] : this.#spy[t];
      teams[t] = { players: this.#members(t), spymaster, found: g ? this.#found(g, t) : 0, wrong: s?.wrong ?? 0, status: this.#teamStatus(t), stop: this.#running ? (s?.stop ?? null) : null };
    }
    const end = this.#phase === "end" && g ? g : undefined;
    return {
      phase: this.#phase,
      lang: this.#lang,
      langs: this.langs,
      ...this.settings,
      minPlayers: this.minPlayers,
      maxPlayers: this.party.maxPlayers,
      names,
      teams,
      board: g ? this.#boardView(g) : null,
      round: g?.round ?? 0,
      step: g?.step ?? 0,
      roundStep: g?.roundStep ?? 0,
      open: this.#running && this.#phase === "guess" && !!g?.open,
      deadline: this.#running ? (g?.deadline ?? null) : null,
      duration: this.#running ? (g?.duration ?? null) : null,
      flip: this.#running && (this.#phase === "guess" || this.#phase === "round") ? (g?.flip ?? null) : null,
      winner: end?.outcome?.winner ?? null,
      reason: end?.outcome?.reason ?? null,
      reveal: end ? this.#reveal(end) : null,
      next: { red: this.#running ? null : this.#spy.red, blue: this.#running ? null : this.#spy.blue },
    };
  }

  #reveal(g: GameState): Reveal {
    const pad = (t: Team) => g.teams[t].pad.filter((l) => l.text).map((l) => ({ text: l.text, name: this.#name(l.by) }));
    return {
      key: g.board.map((c) => c.color),
      clues: { red: g.teams.red.history, blue: g.teams.blue.history },
      pads: { red: pad("red"), blue: pad("blue") },
      spymasters: { ...g.spymasters },
    };
  }

  #me(p: Player): MeView {
    const base: MeView = { task: "lobby", team: this.#teams.get(p.id) ?? null, key: null, clue: null, turned: 0, history: [], pins: {}, voters: [], mine: null, majority: null, locked: null, canPass: false, active: false, stop: null, pad: null };
    if (p.waiting) return { ...base, task: "wait", team: null };
    const g = this.#g;
    const t = this.#teams.get(p.id);
    if (!this.#running || !g || !t) return { ...base, task: this.#phase === "end" ? "end" : this.#running ? "wait" : "lobby" };
    const s = g.teams[t];
    const spy = this.#spy[t] === p.id;
    const voters = this.#voters(t);
    return {
      task: spy ? "spymaster" : "operative",
      team: t,
      key: spy ? g.board.map((c) => c.color) : null,
      clue: s.clue,
      turned: s.turned,
      history: s.history,
      pins: Object.fromEntries([...s.pins].filter(([id]) => this.#teams.get(id) === t && id !== this.#spy[t])),
      voters,
      mine: s.pins.get(p.id) ?? null,
      majority: majority(s.pins, voters),
      locked: s.lock,
      canPass: s.turned > 0,
      active: s.active,
      stop: s.stop,
      pad: spy ? null : s.pad.map((l) => ({ id: l.id, text: l.text, by: l.by, name: this.#name(l.by), edit: l.edit })),
    };
  }

  /** Every view from the state: the room, the TV, each phone. */
  #sync(): void {
    const room = this.#room();
    this.party.room.replace(room as unknown as Record<string, unknown>);
    this.party.screen.replace(room as unknown as Record<string, unknown>);
    for (const p of this.party.players) p.state.replace(this.#me(p) as unknown as Record<string, unknown>);
    const teams = JSON.stringify([[...this.#teams], this.#spy]);
    if (teams !== this.#teamsWere) {
      this.#teamsWere = teams;
      this.emit("teams");
    }
  }

  /** Every view, timed to the TV. */
  #show(): void {
    this.party.withTv(() => this.#sync());
  }

  // -------------------------------------------------------------------------
  // A game

  /**
   * Plays a whole game with the players who are there (and those who
   * join): rounds until a team wins, a draw, or too few left (a team
   * without its two players at the start of a round). Closed
   * ({@link close}), it returns null and shows nothing.
   */
  async play(): Promise<Outcome | null> {
    const party = this.party;
    if (this.#running) return null;
    const game = ++this.#game;
    this.#running = true;
    this.#abort = new AbortController();
    const signal = this.#abort.signal;
    party.inProgress = true;
    try {
      this.#letIn();
      balance(
        this.#teams,
        party.players.map((p) => p.id),
      );
      for (const t of TEAMS) {
        const members = this.#members(t);
        if (!this.#spy[t] || !members.includes(this.#spy[t]!)) this.#spy[t] = members[0] ?? null;
      }
      const board = this.#deal();
      const team = (): TeamState => ({ clue: null, history: [], wrong: 0, active: false, stop: null, turned: 0, pins: new Map(), lock: null, pad: [], padSeq: 0 });
      const g: GameState = {
        board,
        by: board.map(() => []),
        at: board.map(() => 0),
        round: 0,
        step: 0,
        roundStep: 0,
        deadline: null,
        duration: null,
        teams: { red: team(), blue: team() },
        flip: null,
        outcome: null,
        spymasters: { ...this.#spy },
        open: false,
      };
      this.#g = g;
      this.#last = undefined;
      this.#setPhase("intro");
      g.deadline = party.deadline(this.timings.intro);
      g.duration = this.timings.intro;
      this.#show();
      await this.#sleep(this.timings.intro, signal);
      while (!signal.aborted && !g.outcome) {
        g.round++;
        this.#letIn();
        if (TEAMS.some((t) => this.#members(t).length < MIN_TEAM)) {
          g.outcome = { winner: null, reason: "too-few" };
          break;
        }
        for (const t of TEAMS) {
          if (!this.#spy[t] || this.#teams.get(this.#spy[t]!) !== t) this.#spy[t] = this.#members(t)[0] ?? null;
          g.spymasters[t] = this.#spy[t];
        }
        await this.#cluePhase(g, signal);
        if (signal.aborted) break;
        await this.#steps(g, signal);
        if (signal.aborted || g.outcome) break;
        this.#setPhase("round");
        g.deadline = null;
        g.duration = null;
        this.#show();
        await this.#sleep(this.timings.roundEnd, signal);
      }
      if (signal.aborted || !g.outcome) return null;
      return this.#end(g);
    } finally {
      if (this.#game === game) this.#stop();
    }
  }

  /** Players waiting to come in are in, each with a team (the smaller one). */
  #letIn(): void {
    for (const p of this.party.players) {
      if (p.waiting) this.party.activate(p);
      this.#seat(p.id);
    }
  }

  /** The board of the next game: the script's, or one dealt from the room's words. */
  #deal(): Card[] {
    const script = this.script;
    this.script = undefined;
    if (script) return script.map((c) => ({ word: c.word, color: c.color, category: "", banned: [], alsoRight: [], english: [] }));
    const l = this.#lang;
    const used = this.#used.get(l) ?? new Set<string>();
    const words = this.#words.get(l)!;
    const board = dealBoard(words, { mode: this.#board, difficulty: this.#difficulty, rng: this.#rng, used, matcher: matcher(l), opt: this.#match.get(l) });
    // A new pass once (nearly) every word was dealt.
    if (used.size + BOARD.size > words.length) used.clear();
    for (const c of board) used.add(c.word);
    this.#used.set(l, used);
    this.emit("dealt", l, [...used]);
    return board;
  }

  // -------------------------------------------------------------------------
  // Clues

  async #cluePhase(g: GameState, signal: AbortSignal): Promise<void> {
    const party = this.party;
    this.#setPhase("clue");
    g.roundStep = 0;
    g.flip = null;
    for (const t of TEAMS) {
      const s = g.teams[t];
      Object.assign(s, { clue: null, active: false, stop: null, turned: 0, lock: null });
      for (const [id, c] of s.pins) if (c === "pass" || g.by[c]!.length > 0) s.pins.delete(id);
    }
    g.deadline = party.deadline(this.timings.clue);
    g.duration = this.timings.clue;
    this.#show();
    await this.#until(g.deadline, signal, () => TEAMS.every((t) => g.teams[t].clue !== null));
  }

  #clue(d: Json, from: Sender): unknown {
    const g = this.#g;
    if (!g || this.#phase !== "clue" || from.role !== "player") throw new PartyError("not-now", "Not now");
    const t = this.#teams.get(from.id);
    if (!t || this.#spy[t] !== from.id) throw new PartyError("not-spymaster", "Only the spymaster gives the clue");
    const s = g.teams[t];
    if (s.clue) throw new PartyError("already", "Your team has its clue");
    const v = obj(d);
    const l = this.#lang;
    const m = matcher(l);
    const res = checkClue(v["word"], v["number"], g.board, g.by.map((b) => b.length === 0), m, this.#match.get(l));
    if (!res.ok) {
      if (res.code === "too-close") {
        const why = (l === "de" ? de.REASON_TEXT : en.REASON_TEXT)[res.reason];
        throw new PartyError("too-close", TEXT[l].tooClose(g.board[res.card]!.word, why));
      }
      throw new PartyError(res.code, res.code === "bad-number" ? TEXT[l].badNumber : res.message);
    }
    const word = this.party.moderate(res.clue.display, "clue", from);
    if (word === false) throw new PartyError("refused", TEXT[l].notClue);
    s.clue = { word, number: res.number };
    s.history.push({ round: g.round, word, number: res.number, cards: [] });
    this.#sync();
    this.#poke();
    return { word, number: res.number };
  }

  // -------------------------------------------------------------------------
  // Steps

  async #steps(g: GameState, signal: AbortSignal): Promise<void> {
    const party = this.party;
    this.#setPhase("guess");
    for (const t of TEAMS) {
      const s = g.teams[t];
      s.active = s.clue !== null;
      s.stop = s.clue ? null : "no-clue";
    }
    while (!signal.aborted && TEAMS.some((t) => g.teams[t].active)) {
      g.step++;
      g.roundStep++;
      for (const t of TEAMS) {
        const s = g.teams[t];
        s.lock = null;
        for (const [id, c] of s.pins) if (c === "pass" || g.by[c]!.length > 0) s.pins.delete(id);
      }
      g.deadline = party.deadline(this.timings.step);
      g.duration = this.timings.step;
      g.open = true;
      this.#show();
      await this.#until(g.deadline, signal, () => TEAMS.every((t) => !g.teams[t].active || g.teams[t].lock !== null || this.#voters(t).length === 0));
      g.open = false;
      if (signal.aborted) return;
      this.#flip(g);
      g.deadline = null;
      g.duration = null;
      this.#show();
      await this.#sleep(this.timings.flip, signal);
      if (g.outcome) return;
    }
  }

  /** The step's locked cards turn, together: what each means for its team, and whether the game is over. */
  #flip(g: GameState): void {
    const flip: Flip = { step: g.step, cards: [], passed: [] };
    const assassin: Team[] = [];
    for (const t of TEAMS) {
      const s = g.teams[t];
      if (!s.active) continue;
      // Time up: a choice that has the majority counts as locked.
      if (s.lock === null) s.lock = majority(s.pins, this.#voters(t));
      if (s.lock === "pass" && s.turned === 0) s.lock = null;
      if (s.lock === null) {
        s.active = false;
        s.stop = this.#voters(t).length === 0 ? "nobody" : "timeout";
        continue;
      }
      if (s.lock === "pass") {
        s.active = false;
        s.stop = "pass";
        flip.passed.push(t);
        continue;
      }
      const card = s.lock;
      const color = g.board[card]!.color;
      const result = resultOf(t, color);
      if (!g.by[card]!.includes(t)) g.by[card]!.push(t);
      g.at[card] = g.step;
      s.turned++;
      s.history.at(-1)?.cards.push(card);
      if (result === "neutral" || result === "theirs") s.wrong++;
      if (result === "assassin") assassin.push(t);
      flip.cards.push({ team: t, card, color, result });
      const stop = afterCard(result, s.turned, s.clue?.number ?? 0);
      if (stop) {
        s.active = false;
        s.stop = stop;
      }
    }
    for (const t of TEAMS) {
      const s = g.teams[t];
      if (s.active && this.#found(g, t) >= BOARD.team) {
        s.active = false;
        s.stop = "found";
      }
      s.lock = null;
    }
    g.flip = flip;
    g.outcome = outcome({ red: this.#found(g, "red"), blue: this.#found(g, "blue") }, { red: g.teams.red.wrong, blue: g.teams.blue.wrong }, assassin);
  }

  /** An operative's pin (or pass, or none): in a step, or in the clue phase once the team has its clue. */
  #pin(d: Json, from: Sender): unknown {
    const { g, s } = this.#operative(from);
    if (!(this.#phase === "guess" ? s.active && s.lock === null : this.#phase === "clue" && s.clue)) throw new PartyError("not-now", "Not now");
    const card = obj(d)["card"];
    if (card === null) s.pins.delete(from.id);
    else if (card === "pass") {
      if (s.turned === 0) throw new PartyError("no-pass", "Guess at least one card first");
      s.pins.set(from.id, "pass");
    } else if (typeof card === "number" && Number.isInteger(card) && card >= 0 && card < g.board.length && g.by[card]!.length === 0) {
      s.pins.set(from.id, card);
    } else throw new PartyError("bad-card", "Not a card you can pin");
    this.#sync();
    return null;
  }

  /** Locks the team's majority choice, by one who pinned it. */
  #lock(from: Sender): unknown {
    const { g, t, s } = this.#operative(from);
    if (this.#phase !== "guess" || !g.open || !s.active) throw new PartyError("not-now", "Not now");
    if (s.lock !== null) throw new PartyError("already", "Your team has locked");
    const m = majority(s.pins, this.#voters(t));
    if (m === null) throw new PartyError("no-majority", "Most of your team has to pin the same card");
    if (s.pins.get(from.id) !== m) throw new PartyError("not-yours", "Pin it yourself to lock it");
    s.lock = m;
    this.#sync();
    this.#poke();
    return { locked: m };
  }

  #operative(from: Sender): { g: GameState; t: Team; s: TeamState } {
    const g = this.#g;
    if (!g || !this.#running || from.role !== "player") throw new PartyError("not-now", "Not now");
    const t = this.#teams.get(from.id);
    if (!t || this.#spy[t] === from.id) throw new PartyError("not-operative", "Spymasters do not guess");
    return { g, t, s: g.teams[t] };
  }

  // -------------------------------------------------------------------------
  // The pad

  #pad(d: Json, from: Sender): unknown {
    const { s } = this.#operative(from);
    const v = obj(d);
    const id = v["id"];
    const line = typeof id === "number" ? s.pad.find((l) => l.id === id) : undefined;
    const text = () => {
      const t = cleanNote(v["text"]);
      if (!t) return t;
      const ok = this.party.moderate(t, "note", from as Player);
      if (ok === false) throw new PartyError("refused", TEXT[this.#lang].notOnPad);
      return ok;
    };
    const mine = (l: PadLine | undefined): PadLine => {
      if (!l) throw new PartyError("no-line", "That line is gone");
      if (l.edit !== null && l.edit !== from.id) throw new PartyError("busy", "Someone is writing there");
      return l;
    };
    switch (v["op"]) {
      case "add": {
        const tx = text();
        if (!tx) throw new PartyError("empty", "Write something");
        if (s.pad.length >= PAD.lines) throw new PartyError("pad-full", "The pad is full");
        s.pad.push({ id: ++s.padSeq, text: tx, by: from.id, edit: null });
        break;
      }
      case "edit":
        mine(line).edit = from.id;
        break;
      case "save": {
        const l = mine(line);
        const tx = text();
        if (!tx) s.pad.splice(s.pad.indexOf(l), 1);
        else Object.assign(l, { text: tx, by: from.id, edit: null });
        break;
      }
      case "cancel":
        if (line?.edit === from.id) line.edit = null;
        break;
      case "delete": {
        const l = mine(line);
        s.pad.splice(s.pad.indexOf(l), 1);
        break;
      }
      default:
        throw new PartyError("bad-op", "add, edit, save, cancel, delete");
    }
    this.#sync();
    return null;
  }

  /** A player's pad lines are free for the others (they went away or left). */
  #release(id: string): void {
    for (const g of [this.#g, this.#last]) if (g) for (const t of TEAMS) for (const l of g.teams[t].pad) if (l.edit === id) l.edit = null;
  }

  // -------------------------------------------------------------------------
  // The end

  #end(g: GameState): Outcome {
    const o = g.outcome!;
    this.#last = g;
    // The next game's spymasters: the next of each team.
    for (const t of TEAMS) this.#spy[t] = nextSpymaster(this.#members(t), g.spymasters[t]);
    this.#running = false;
    this.party.inProgress = false;
    this.#g = undefined;
    for (const t of TEAMS) for (const l of g.teams[t].pad) l.edit = null;
    this.#setPhase("end");
    this.#show();
    this.emit("end", o);
    return o;
  }

  // -------------------------------------------------------------------------
  // Waiting

  /** Until the deadline (and the grace), or until `done()` holds when something pokes. */
  #until(deadline: number, signal: AbortSignal, done: () => boolean): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        this.#poke = () => {};
        resolve();
      };
      const timer = setTimeout(finish, Math.max(0, deadline + this.party.grace - this.party.now()));
      signal.addEventListener("abort", finish, { once: true });
      this.#poke = () => {
        if (done()) finish();
      };
      this.#poke();
    });
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

function obj(d: Json): Record<string, Json> {
  return typeof d === "object" && d !== null && !Array.isArray(d) ? d : {};
}
