/**
 * Snug on a party, for 2 to 8 players (docs/snug-design.md): the lobby,
 * then board after board against one team clock: a shape on the TV and
 * every phone, each phone with its own secret hand; pieces are placed,
 * moved and lifted by their owners, everyone points with a cursor; a
 * board is solved when every cell is covered, which stops the clock and
 * gives time back; time's up shows the solution and every hand, then the
 * end. The host is the only authority: phones and screens only get views.
 *
 * Views:
 * - `party.room` (every phone): `{ phase, lang, level, pace, minPlayers, colors, solved, best, board?, shape?,
 *   placed?, counts?, team?, deadline?, left?, checks, check?, cursors?, bonus?, earned?, by?, spares?, solution?,
 *   hands?, awards?, stats? }`: `phase` is `lobby`, `board`, `solved`, `over` (time's up) or `final`; `shape` the board
 *   (`{ w, h, rows }`), `placed` the pieces on it (`{ id, owner, cells }`), `counts` the pieces each player still
 *   holds (by id, never which), `team` who plays the board (ids), `deadline` the clock (host time; null while it
 *   is stopped, `left` the time then), `checks` the checks the team has left (null: as many as it likes),
 *   `check` the answer of the last one while the board is as it was then (`{ result: "stuck" | "open", by, n }`),
 *   `cursors` by id (`{ x, y, on, ping, t }`), at `solved` the time back (`bonus`), whether it earned a check
 *   (`earned`), who finished it (`by`) and the leftover pieces (`spares`: `{ owner, cells }`), at `over` the
 *   solution and every hand (`{ owner, cells }`).
 * - `player.state` (one phone): `{ task, color, hand?, got? }`: `task` is `lobby`, `wait` (a latecomer until the
 *   next board), `play`, `solved`, `over` or `final`; `hand` the pieces the player holds and has not placed
 *   (`{ id, cells }`, the cells as dealt); `got` when pieces came from a player who went away (`{ from, n, key }`).
 * - `party.screen` (the TV): the room's fields, and the players' names come with the roster.
 *
 * A piece's cells reach only its holder's phone until it is placed; the
 * TV and the other phones see how many pieces each player holds. The
 * board (placements, lifts, cursors) reaches the phones at once; phases
 * (a new board, solved, time's up, the end) with the TV.
 */

import { Emitter, PartyError, type Json, type Party, type Player, type Sender } from "@tvpipe/party";

import {
  bonusTime,
  candidate,
  CHECKS,
  checkPlacement,
  choose,
  deal,
  effort,
  key,
  LEVELS,
  LIFT_COST,
  MIN_PLAYERS,
  PACES,
  PIECES,
  readCells,
  rungOf,
  shapeCells,
  startTime,
  verdict,
  type Board,
  type Cell,
  type Lang,
  type Level,
  type Pace,
  type Piece,
} from "./rules.ts";

export interface Timings {
  /** The celebration of a solved board (the clock stopped). */
  celebrate: number;
  /** Time's up: the board, then the solution and the hands. */
  over: number;
  /** Away this long, a player's pieces go to the others. */
  handoff: number;
  /** Cursors reach the views at most this often. */
  cursor: number;
  /** The clock at the start (null: {@link startTime}). */
  start: number | null;
  /** The time a solved board gives back (null: {@link bonusTime}). */
  bonus: number | null;
}

export const DEFAULT_TIMINGS: Timings = { celebrate: 4500, over: 10_000, handoff: 8000, cursor: 100, start: null, bonus: null };

/** For trying the game: a short clock. */
export const FAST_TIMINGS: Partial<Timings> = { celebrate: 3000, over: 6000, start: 60_000, bonus: 20_000 };

export interface Settings {
  level: Level;
  pace: Pace;
}

export interface GameOptions {
  lang?: Lang | undefined;
  level?: Level | undefined;
  pace?: Pace | undefined;
  minPlayers?: number | undefined;
  timings?: Partial<Timings> | undefined;
  rng?: (() => number) | undefined;
}

export interface GameEvents {
  phase: [phase: Phase];
  settings: [settings: Settings];
  end: [result: Result];
  /** A board came (tests: its solution). */
  board: [n: number];
}

export type Phase = "lobby" | "board" | "solved" | "over" | "final";

export interface Result {
  solved: number;
  best: number;
}

/** The players' colours: candy tones that stay apart on a cream board. */
export const COLORS = ["#ff5fa2", "#3fa9ff", "#22c993", "#ffb81f", "#9b7bff", "#ff7f36", "#86cf2e", "#c9875a"] as const;

/** A piece in play: who holds it now, and where it is (null: in the hand). */
interface Held extends Piece {
  owner: string;
  at: Cell[] | null;
}

/** The board being played. */
interface Play {
  n: number;
  board: Board;
  team: string[];
  pieces: Map<string, Held>;
  occupied: Map<number, string>;
  cells: number;
  needed: number;
  deadline: number;
  /** The last check's answer, while the board is as it was then. */
  check: Check | null;
  by: string | null;
  done: (how: "solved" | "time" | "abort") => void;
}

interface Check {
  result: "stuck" | "open";
  by: string;
  n: number;
}

interface Stats {
  placed: number;
  lifts: number;
  pings: number;
  fits: number;
  checks: number;
}

interface Cursor {
  x: number;
  y: number;
  on: boolean;
  ping: number;
  t: number;
}

export class Snug extends Emitter<GameEvents> {
  readonly party: Party;
  readonly minPlayers: number;
  timings: Timings;
  /** Boards to play next, before any generated ones (tests, the live check's screenshots). */
  script: Board[] = [];
  readonly #rng: () => number;
  #lang: Lang;
  #level: Level;
  #pace: Pace;
  readonly #colors = new Map<string, number>();
  readonly #names = new Map<string, string>();
  readonly #stats = new Map<string, Stats>();
  #phase: Phase = "lobby";
  #running = false;
  #abort = new AbortController();
  #game = 0;
  #solved = 0;
  #best = 0;
  #play: Play | undefined;
  #clock: ReturnType<typeof setTimeout> | undefined;
  readonly #away = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #cursors = new Map<string, Cursor>();
  #cursorTimer: ReturnType<typeof setTimeout> | undefined;
  #cursorDirty = false;
  #gotKey = 0;
  /** The checks the team has left (null: unlimited). */
  #checks: number | null = null;
  #checkNo = 0;

  constructor(party: Party, options: GameOptions = {}) {
    super();
    this.party = party;
    this.minPlayers = options.minPlayers ?? MIN_PLAYERS;
    this.timings = { ...DEFAULT_TIMINGS, ...options.timings };
    this.#rng = options.rng ?? Math.random;
    this.#lang = options.lang ?? "en";
    this.#level = options.level ?? "normal";
    this.#pace = options.pace ?? "normal";
  }

  get settings(): Settings {
    return { level: this.#level, pace: this.#pace };
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
  get solved(): number {
    return this.#solved;
  }
  /** The checks the team has left (null: unlimited). */
  get checks(): number | null {
    return this.#running ? this.#checks : (CHECKS[this.#level]?.start ?? null);
  }
  /** The board's number (0 before the first). */
  get boardNo(): number {
    return this.#play?.n ?? 0;
  }

  /** Where the solution has a piece (the bots' oracle; spares: null). Never sent to a phone. */
  homeOf(id: string): Cell[] | null {
    return this.#play?.pieces.get(id)?.home ?? null;
  }

  /** The board being played (tests). */
  get current(): Readonly<Play> | undefined {
    return this.#play;
  }

  /** Sets the running board's clock to `ms` from now (the live check's way to time's up). */
  setClock(ms: number): void {
    const pl = this.#play;
    if (!pl || this.#phase !== "board") return;
    pl.deadline = this.party.now() + ms;
    this.#armClock();
    this.#boardChanged(pl);
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
      const id = obj(d)["id"];
      const p = typeof id === "string" ? party.player(id) : undefined;
      if (!p || p === from) throw new PartyError("no-player", "No such player");
      party.kick(p);
      return null;
    });
    party.handle("settings", (d, from) => {
      vipOnly(from);
      const v = obj(d);
      for (const k of Object.keys(v)) if (k !== "level" && k !== "pace") throw new PartyError("bad-settings", `${k}: not a setting`);
      if (v["level"] !== undefined && !(LEVELS as readonly Json[]).includes(v["level"])) throw new PartyError("bad-settings", `level: ${LEVELS.join(", ")}`);
      if (v["pace"] !== undefined && !(PACES as readonly Json[]).includes(v["pace"])) throw new PartyError("bad-settings", `pace: ${PACES.join(", ")}`);
      this.configure({ level: v["level"] as Level | undefined, pace: v["pace"] as Pace | undefined });
      return null;
    });
    party.handle("place", (d, from) => this.#place(d, from));
    party.handle("lift", (d, from) => this.#lift(d, from));
    party.handle("check", (d, from) => this.#check(d, from));
    party.on("input", (p, data) => this.#input(p, data));
    party.on("join", (p) => {
      this.#names.set(p.id, p.name);
      this.#colors.set(p.id, this.#freeColor());
      this.#colorsChanged();
      p.state.replace(this.#running ? this.#waitState(p) : this.#lobbyState(p));
    });
    party.on("away", (p) => {
      if (!this.#running) return;
      clearTimeout(this.#away.get(p.id));
      this.#away.set(
        p.id,
        setTimeout(() => {
          this.#away.delete(p.id);
          if (!p.connected) this.#handOff(p.id);
        }, this.timings.handoff),
      );
    });
    party.on("reconnect", (p) => {
      clearTimeout(this.#away.get(p.id));
      this.#away.delete(p.id);
    });
    party.on("leave", (p) => {
      clearTimeout(this.#away.get(p.id));
      this.#away.delete(p.id);
      this.#cursors.delete(p.id);
      this.#colors.delete(p.id);
      this.#colorsChanged();
      this.#handOff(p.id);
    });
    this.#lobby();
  }

  /** Changes the level, the pace, the language or the timers between games; every phone and the TV follow. */
  configure(o: { level?: Level | undefined; pace?: Pace | undefined; lang?: Lang | undefined; timings?: Partial<Timings> | undefined }): void {
    if (this.#running) throw new PartyError("running", "Not during a game");
    const was = JSON.stringify(this.settings);
    if (o.level !== undefined && LEVELS.includes(o.level)) this.#level = o.level;
    if (o.pace !== undefined && PACES.includes(o.pace)) this.#pace = o.pace;
    if (o.lang !== undefined) this.#lang = o.lang;
    if (o.timings) this.timings = { ...this.timings, ...o.timings };
    if (this.#phase === "lobby" || this.#phase === "final") {
      this.party.room.set({ lang: this.#lang, ...this.settings, checks: this.checks });
      this.party.screen.set({ lang: this.#lang, ...this.settings, checks: this.checks });
    }
    if (JSON.stringify(this.settings) !== was) this.emit("settings", this.settings);
  }

  /** Ends a running game (the party stays): the lobby at once, nothing of the old game writes after this. */
  close(): void {
    if (!this.#running) return;
    this.#game++;
    this.#abort.abort();
    this.#play?.done("abort");
    this.#stop();
    this.#lobby();
  }

  #stop(): void {
    clearTimeout(this.#clock);
    clearTimeout(this.#cursorTimer);
    this.#cursorTimer = undefined;
    for (const t of this.#away.values()) clearTimeout(t);
    this.#away.clear();
    this.#cursors.clear();
    this.#play = undefined;
    this.#running = false;
    this.party.inProgress = false;
    for (const p of this.party.players) this.party.activate(p);
  }

  // -------------------------------------------------------------------------
  // Views

  #setPhase(phase: Phase): void {
    const changed = phase !== this.#phase;
    this.#phase = phase;
    if (changed) this.emit("phase", phase);
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
    this.party.screen.set({ colors });
  }

  #name(id: string): string {
    return this.party.player(id)?.name ?? this.#names.get(id) ?? "?";
  }

  #base(): Record<string, unknown> {
    return { lang: this.#lang, ...this.settings, minPlayers: this.minPlayers, colors: this.#colorMap(), solved: this.#solved, best: this.#best, checks: this.checks };
  }

  #room(fields: Record<string, unknown>): void {
    this.party.room.replace({ ...this.#base(), ...fields });
  }

  #screen(fields: Record<string, unknown>): void {
    this.party.screen.replace({ ...this.#base(), maxPlayers: this.party.maxPlayers, ...fields });
  }

  #lobbyState(p: Player): Record<string, unknown> {
    return { task: this.#phase === "final" ? "final" : "lobby", color: this.colorOf(p.id) };
  }

  #waitState(p: Player): Record<string, unknown> {
    return { task: "wait", color: this.colorOf(p.id) };
  }

  #lobby(): void {
    this.#setPhase("lobby");
    this.#room({ phase: "lobby", maxPlayers: this.party.maxPlayers });
    this.#screen({ phase: "lobby" });
    for (const p of this.party.players) p.state.replace(this.#lobbyState(p));
  }

  #placedView(pl: Play): { id: string; owner: string; cells: Cell[] }[] {
    return [...pl.pieces.values()].filter((x) => x.at).map((x) => ({ id: x.id, owner: x.owner, cells: x.at! }));
  }

  #counts(pl: Play): Record<string, number> {
    const out: Record<string, number> = Object.fromEntries(pl.team.map((id) => [id, 0]));
    for (const x of pl.pieces.values()) if (!x.at) out[x.owner] = (out[x.owner] ?? 0) + 1;
    return out;
  }

  #hand(pl: Play, id: string): { id: string; cells: Cell[] }[] {
    return [...pl.pieces.values()].filter((x) => x.owner === id && !x.at).map((x) => ({ id: x.id, cells: x.cells }));
  }

  /** What the board's views always have. */
  #table(pl: Play): Record<string, unknown> {
    return { board: pl.n, shape: pl.board.shape, placed: this.#placedView(pl), counts: this.#counts(pl), team: pl.team, check: pl.check };
  }

  /** The board changed (a placement, a lift, a hand-off): the room and the screen at once. */
  #boardChanged(pl: Play): void {
    const f = { placed: this.#placedView(pl), counts: this.#counts(pl), check: pl.check, checks: this.checks, deadline: pl.deadline };
    this.party.room.set(f);
    this.party.screen.set(f);
  }

  #statsOf(id: string): Stats {
    let s = this.#stats.get(id);
    if (!s) this.#stats.set(id, (s = { placed: 0, lifts: 0, pings: 0, fits: 0, checks: 0 }));
    return s;
  }

  // -------------------------------------------------------------------------
  // A game

  /**
   * Plays a game with the players who are there (and those who join):
   * board after board until time is up, or until fewer than
   * {@link minPlayers} are left in it when a board would start. Closed
   * ({@link close}), it returns what was solved and shows nothing.
   */
  async play(): Promise<Result> {
    const party = this.party;
    const game = ++this.#game;
    this.#running = true;
    this.#abort = new AbortController();
    const signal = this.#abort.signal;
    party.inProgress = true;
    this.#solved = 0;
    this.#checks = CHECKS[this.#level]?.start ?? null;
    this.#stats.clear();
    let left: number | null = null;
    let next: Promise<Board | null> | null = null;
    let nextFor = 0;
    try {
      for (let n = 1; ; n++) {
        for (const p of party.players) if (p.waiting) party.activate(p);
        if (party.players.length < this.minPlayers) break;
        const connected = party.players.filter((p) => p.connected);
        const team = (connected.length > 0 ? connected : party.players).map((p) => p.id);
        const scripted = this.script.shift();
        const board = scripted ?? (next && nextFor === team.length ? await next : null) ?? (await this.#makeBoard(team.length, signal));
        next = null;
        if (signal.aborted || !board) break;
        const needed = board.solution.length;
        const time = left ?? this.timings.start ?? startTime(needed, this.#pace);
        const how = await this.#playBoard(n, board, team, time, signal);
        if (how === "abort" || signal.aborted) break;
        if (how === "time") {
          await this.#over(signal);
          break;
        }
        // Solved: the time back, the next board made meanwhile, the celebration.
        const pl = this.#play!;
        const bonus = this.timings.bonus ?? bonusTime(needed, this.#pace);
        left = Math.max(0, pl.deadline - party.now()) + bonus;
        this.#solved++;
        this.#best = Math.max(this.#best, this.#solved);
        if (pl.by) this.#statsOf(pl.by).fits++;
        const earned = this.#earn();
        nextFor = party.players.filter((p) => p.connected || p.waiting).length;
        next = this.#makeBoard(Math.max(1, nextFor), signal);
        await this.#celebrate(pl, bonus, left, earned, signal);
        if (signal.aborted) break;
      }
      return signal.aborted ? { solved: this.#solved, best: this.#best } : this.#final();
    } finally {
      if (this.#game === game) this.#stop();
    }
  }

  /** A filled shape earns a check, up to what the level lets the team hold; whether it did. */
  #earn(): boolean {
    const rule = CHECKS[this.#level];
    if (!rule || this.#checks === null || this.#checks >= rule.max) return false;
    this.#checks++;
    return true;
  }

  /** A board for `players` on the rung the shapes solved so far reached, a try at a time so the page keeps going. */
  async #makeBoard(players: number, signal: AbortSignal): Promise<Board | null> {
    const { tries, budget } = effort(players);
    const rung = rungOf(this.#level, this.#solved);
    const boards: Board[] = [];
    for (let attempt = 0; boards.length < tries && attempt < tries * 40; attempt++) {
      if (signal.aborted) return null;
      const b = candidate({ players, rung, rng: this.#rng, budget });
      if (b) boards.push(b);
      if (attempt % 2 === 1) await new Promise((r) => setTimeout(r, 0));
    }
    return signal.aborted ? null : choose(boards, rung);
  }

  async #playBoard(n: number, board: Board, team: string[], time: number, signal: AbortSignal): Promise<"solved" | "time" | "abort"> {
    const party = this.party;
    const hands = deal(board, team, `${n}-`, this.#rng);
    const pieces = new Map<string, Held>();
    for (const [owner, hand] of hands) for (const p of hand) pieces.set(p.id, { ...p, owner, at: null });
    let finish: (how: "solved" | "time" | "abort") => void = () => {};
    const over = new Promise<"solved" | "time" | "abort">((resolve) => (finish = resolve));
    const pl: Play = {
      n,
      board,
      team,
      pieces,
      occupied: new Map(),
      cells: shapeCells(board.shape).length,
      needed: board.solution.length,
      deadline: party.deadline(time),
      check: null,
      by: null,
      done: (how) => finish(how),
    };
    this.#play = pl;
    this.#cursors.clear();
    this.#setPhase("board");
    party.withTv(() => {
      this.#room({ phase: "board", ...this.#table(pl), deadline: pl.deadline, cursors: {} });
      this.#screen({ phase: "board", ...this.#table(pl), deadline: pl.deadline, cursors: {} });
      for (const p of party.players) {
        if (team.includes(p.id)) p.state.replace({ task: "play", color: this.colorOf(p.id), hand: this.#hand(pl, p.id) });
        else p.state.replace(this.#waitState(p));
      }
    });
    this.emit("board", n);
    this.#armClock();
    const abort = () => finish("abort");
    signal.addEventListener("abort", abort, { once: true });
    const how = await over;
    signal.removeEventListener("abort", abort);
    clearTimeout(this.#clock);
    return how;
  }

  /** Time's up at the deadline (plus the grace for actions on their way). */
  #armClock(): void {
    clearTimeout(this.#clock);
    const pl = this.#play;
    if (!pl || this.#phase !== "board") return;
    const wait = pl.deadline + this.party.grace - this.party.now();
    this.#clock = setTimeout(() => {
      if (this.#play !== pl || this.#phase !== "board") return;
      if (this.party.now() >= pl.deadline + this.party.grace) pl.done("time");
      else this.#armClock();
    }, Math.max(0, wait));
  }

  async #celebrate(pl: Play, bonus: number, left: number, earned: boolean, signal: AbortSignal): Promise<void> {
    const party = this.party;
    this.#setPhase("solved");
    const spares = [...pl.pieces.values()].filter((x) => !x.at).map((x) => ({ owner: x.owner, cells: x.cells }));
    const f = { phase: "solved", ...this.#table(pl), deadline: null, left, bonus, earned, by: pl.by, spares, cursors: {} };
    party.withTv(() => {
      this.#room(f);
      this.#screen(f);
      for (const p of party.players) p.state.replace(pl.team.includes(p.id) ? { task: "solved", color: this.colorOf(p.id) } : this.#waitState(p));
    });
    await sleep(this.timings.celebrate, signal);
  }

  async #over(signal: AbortSignal): Promise<void> {
    const party = this.party;
    const pl = this.#play!;
    this.#setPhase("over");
    const solution = [...pl.pieces.values()].filter((x) => x.home).map((x) => ({ owner: x.owner, cells: x.home! }));
    const hands = [...pl.pieces.values()].filter((x) => !x.at).map((x) => ({ owner: x.owner, cells: x.cells }));
    const f = { phase: "over", ...this.#table(pl), deadline: null, left: 0, solution, hands, cursors: {} };
    party.withTv(() => {
      this.#room(f);
      this.#screen(f);
      for (const p of party.players) p.state.replace(pl.team.includes(p.id) ? { task: "over", color: this.colorOf(p.id) } : this.#waitState(p));
    });
    await sleep(this.timings.over, signal);
  }

  /** The awards: the most boards finished, the most pings, the most lifts; each only when earned. */
  #awards(): Record<string, { id: string; name: string; n: number } | null> {
    const here = [...this.#stats].filter(([id]) => this.party.player(id));
    const best = (k: keyof Stats) => {
      const top = Math.max(0, ...here.map(([, s]) => s[k]));
      if (top <= 0) return null;
      const id = here.find(([, s]) => s[k] === top)![0];
      return { id, name: this.#name(id), n: top };
    };
    return { fit: best("fits"), pointer: best("pings"), thoughts: best("lifts") };
  }

  #final(): Result {
    const party = this.party;
    this.#play = undefined;
    this.#setPhase("final");
    const stats = Object.fromEntries([...this.#stats].filter(([id]) => party.player(id)));
    const f = { phase: "final", awards: this.#awards(), stats, maxPlayers: party.maxPlayers };
    party.withTv(() => {
      this.#room(f);
      this.#screen(f);
      for (const p of party.players) p.state.replace({ task: "final", color: this.colorOf(p.id) });
    });
    const result = { solved: this.#solved, best: this.#best };
    this.emit("end", result);
    return result;
  }

  // -------------------------------------------------------------------------
  // Placing, lifting, pointing

  /** The piece an action names, if the sender may move it now. */
  #mine(d: Json, from: Sender): { pl: Play; piece: Held; data: Record<string, Json> } {
    const pl = this.#play;
    const data = obj(d);
    if (from.role !== "player") throw new PartyError("not-player", "Players only");
    if (!pl || this.#phase !== "board" || data["board"] !== pl.n) throw new PartyError("not-now", "Not now");
    const piece = typeof data["piece"] === "string" ? pl.pieces.get(data["piece"]) : undefined;
    if (!piece) throw new PartyError("no-piece", "No such piece");
    if (piece.owner !== from.id) throw new PartyError("not-yours", "Not your piece");
    return { pl, piece, data };
  }

  #place(d: Json, from: Sender): unknown {
    const { pl, piece, data } = this.#mine(d, from);
    const party = this.party;
    if (party.now() > pl.deadline + party.grace) return { ok: false, reason: "time" };
    const cells = readCells(data["cells"]);
    if (!cells) return { ok: false, reason: "shape" };
    const check = checkPlacement(pl.board.shape, pl.occupied, piece.id, piece.cells, cells);
    if (!check.ok) {
      const by = check.by ? pl.pieces.get(check.by)?.owner : undefined;
      return { ok: false, reason: check.reason, ...(by ? { by } : {}) };
    }
    const stats = this.#statsOf(from.id);
    if (piece.at) {
      stats.lifts++;
      if (this.#level === "hard") this.#cost(pl);
      for (const [x, y] of piece.at) pl.occupied.delete(key(x, y));
    }
    piece.at = cells;
    stats.placed++;
    for (const [x, y] of cells) pl.occupied.set(key(x, y), piece.id);
    if (pl.occupied.size === pl.cells) {
      pl.by = from.id;
      pl.check = null;
      this.#boardChanged(pl);
      (from as Player).state.set({ hand: this.#hand(pl, from.id) });
      pl.done("solved");
      return { ok: true, solved: true };
    }
    pl.check = null;
    this.#boardChanged(pl);
    (from as Player).state.set({ hand: this.#hand(pl, from.id) });
    if (party.now() > pl.deadline + party.grace) pl.done("time");
    return { ok: true };
  }

  #lift(d: Json, from: Sender): unknown {
    const { pl, piece } = this.#mine(d, from);
    const party = this.party;
    if (party.now() > pl.deadline + party.grace) return { ok: false, reason: "time" };
    if (!piece.at) return { ok: true };
    for (const [x, y] of piece.at) pl.occupied.delete(key(x, y));
    piece.at = null;
    this.#statsOf(from.id).lifts++;
    if (this.#level === "hard") this.#cost(pl);
    pl.check = null;
    this.#boardChanged(pl);
    (from as Player).state.set({ hand: this.#hand(pl, from.id) });
    if (party.now() > pl.deadline + party.grace) pl.done("time");
    return { ok: true };
  }

  /** Hard: lifting and moving cost time. */
  #cost(pl: Play): void {
    pl.deadline -= LIFT_COST;
    this.#armClock();
  }

  /**
   * A check (`{ board }`, any player on the board): whether the pieces
   * still in hands can fill what is left. Answers `{ ok, result, checks }`;
   * a check uses one of the team's (none left: `none`) unless the board is
   * as it was at the last one, which answers again, or the search runs out
   * (`unsure`).
   */
  #check(d: Json, from: Sender): unknown {
    const pl = this.#play;
    const party = this.party;
    if (from.role !== "player") throw new PartyError("not-player", "Players only");
    if (!pl || this.#phase !== "board" || obj(d)["board"] !== pl.n || !pl.team.includes(from.id)) throw new PartyError("not-now", "Not now");
    if (party.now() > pl.deadline + party.grace) return { ok: false, reason: "time" };
    if (pl.check) return { ok: true, result: pl.check.result, checks: this.#checks };
    if (this.#checks === 0) return { ok: false, reason: "none" };
    const free = shapeCells(pl.board.shape).filter(([x, y]) => !pl.occupied.has(key(x, y)));
    const left = [...pl.pieces.values()].filter((x) => !x.at).map((x) => PIECES[x.kind]);
    const result = verdict(free, left);
    if (result === "unsure") return { ok: true, result, checks: this.#checks };
    if (this.#checks !== null) this.#checks--;
    this.#statsOf(from.id).checks++;
    pl.check = { result, by: from.id, n: ++this.#checkNo };
    this.#boardChanged(pl);
    return { ok: true, result, checks: this.#checks };
  }

  /** A cursor (`{ x, y, on, ping }`): into the views, at most every {@link Timings.cursor} ms. */
  #input(p: Player, data: Json): void {
    const pl = this.#play;
    if (!pl || this.#phase !== "board") return;
    const d = obj(data);
    const x = d["x"];
    const y = d["y"];
    const ping = d["ping"];
    if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) return;
    const { w, h } = pl.board.shape;
    const old = this.#cursors.get(p.id);
    const pings = typeof ping === "number" && Number.isInteger(ping) && ping >= 0 ? Math.min(ping, 1e6) : (old?.ping ?? 0);
    if (old && pings > old.ping) this.#statsOf(p.id).pings += Math.min(5, pings - old.ping);
    this.#cursors.set(p.id, {
      x: Math.round(Math.max(-0.5, Math.min(w + 0.5, x)) * 100) / 100,
      y: Math.round(Math.max(-0.5, Math.min(h + 0.5, y)) * 100) / 100,
      on: d["on"] !== false,
      ping: pings,
      t: this.party.now(),
    });
    this.#cursorDirty = true;
    if (!this.#cursorTimer) this.#flushCursors();
  }

  #flushCursors(): void {
    this.#cursorTimer = undefined;
    if (!this.#cursorDirty || this.#phase !== "board") return;
    this.#cursorDirty = false;
    const now = this.party.now();
    for (const [id, c] of this.#cursors) if (now - c.t > 6000 || !this.party.player(id)) this.#cursors.delete(id);
    const cursors = Object.fromEntries(this.#cursors);
    this.party.room.set({ cursors });
    this.party.screen.set({ cursors });
    this.#cursorTimer = setTimeout(() => this.#flushCursors(), this.timings.cursor);
  }

  /** A player away (or gone): their pieces, in hand and on the board, to the players who are there, the fewest in hand first. */
  #handOff(id: string): void {
    const pl = this.#play;
    if (!pl || this.#phase !== "board") return;
    const theirs = [...pl.pieces.values()].filter((x) => x.owner === id);
    if (theirs.length === 0) return;
    const takers = pl.team.filter((t) => t !== id && this.party.player(t)?.connected);
    if (takers.length === 0) return;
    const got = new Map<string, number>();
    for (const piece of theirs) {
      const counts = this.#counts(pl);
      const to = [...takers].sort((a, b) => (counts[a] ?? 0) - (counts[b] ?? 0))[0]!;
      piece.owner = to;
      got.set(to, (got.get(to) ?? 0) + 1);
    }
    const from = this.#name(id);
    for (const [to, n] of got) this.party.player(to)?.state.set({ hand: this.#hand(pl, to), got: { from, n, key: ++this.#gotKey } });
    this.party.player(id)?.state.set({ hand: [] });
    pl.check = null;
    this.#boardChanged(pl);
  }
}

function obj(d: Json | undefined): Record<string, Json> {
  return typeof d === "object" && d !== null && !Array.isArray(d) ? (d as Record<string, Json>) : {};
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
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

