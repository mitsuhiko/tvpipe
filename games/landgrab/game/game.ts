/**
 * Landgrab on a party, for 2 to 6 players (docs/landgrab-design.md): the
 * lobby, then rounds of two phases until the last round or until someone
 * holds three quarters of the world. In the **plan** phase everyone at
 * once, in secret, places their reinforcements and gives orders on their
 * phone; in the **battle** phase the TV plays the orders out one at a
 * time (round robin over the players), with every fight's dice. The host
 * is the only authority: phones and screens only ever get views.
 *
 * Views:
 * - `party.room` (every phone): `{ phase, lang, round, rounds, planTime, late, minPlayers, colors, board?,
 *   players?, deadline?, step? }`: `late` the latecomers setting (`wait` or `closed`), `board` is `{ own, arm }` by territory index (`own` a player's id or `""` for the wild
 *   lands), `players` the standings (`{ id, lands, armies, stars, out, ready }`), `step` the event the TV plays
 *   (`{ i, of, ev, ms, scale }`: its length on the TV, as `timeline.ts` splits it).
 * - `player.state` (one phone): `{ task, color, … }`: `lobby`, `wait` (a latecomer, until the next round),
 *   `plan` (`deadline`, `reinf` `{ base, bonus, total }`, `stars`, `plan` (what the host has of theirs),
 *   `rise` (the territory they rose on this round, if they did)), `watch` (`feed`: their events of the
 *   battle so far), `final` (`rank`, `of`).
 * - `party.screen` (the TV): `{ phase, lang, colors, round, rounds, board, players, … }`: in `plan`, `deadline`,
 *   `duration` and `rises` (uprisings at the round's start); in `battle`, `step` (`{ i, of, ev, ms, scale }`);
 *   at the end, `final` (`{ winner, by, table, awards }`).
 *
 * Plans reach only the host until the battle shows them; the TV and the
 * other phones learn only who is ready.
 */

import { Emitter, PartyError, type Json, type Party, type Player, type Sender } from "@tvpipe/party";

import {
  autoPlace,
  checkPlan,
  continentsOf,
  deal,
  dominator,
  EMPTY_PLAN,
  MAX_STARS,
  MIN_PLAYERS,
  PlanError,
  placedOf,
  reinforcements,
  resolve,
  standing,
  STARS_TO_CASH,
  CASH_ARMIES,
  territoriesOf,
  armiesOf,
  uprisingAt,
  UPRISING_ARMIES,
  type Board,
  type Change,
  type Event,
  LANGS,
  type Lang,
  type Plan,
  type Reinforcements,
} from "./rules.ts";
import { eventMs, paceScale, PACE, FAST_PACE, type Pace } from "./timeline.ts";
import type { World } from "./world.ts";

export interface Timings {
  /** Planning (the room's setting). */
  plan: number;
  /** More time to plan in the first round. */
  firstPlan: number;
  /** After everyone is ready, before the battle. */
  ready: number;
  /** The round's banner on the TV before planning. */
  banner: number;
  /** After the battle, before the next round. */
  after: number;
  pace: Pace;
}

export const DEFAULT_TIMINGS: Timings = { plan: 60_000, firstPlan: 30_000, ready: 1500, banner: 2500, after: 3000, pace: PACE };
export const FAST_TIMINGS: Timings = { plan: 25_000, firstPlan: 5000, ready: 600, banner: 1000, after: 1200, pace: FAST_PACE };

/** What the room can pick. */
export const ROUNDS = [6, 8, 10, 12, 24] as const;
export const PLAN_TIMES = [45, 60, 90, 120] as const;
/** Latecomers: wait for the next round, or none (the host page's `lateJoinField` offers the same). */
export const LATE = ["wait", "closed"] as const;
export type Late = (typeof LATE)[number];

/** The players' colours: one each for six players (the wild lands are parchment). */
export const COLORS = ["#e4572e", "#2e86de", "#f3b61f", "#17b890", "#9b5de5", "#f15bb5"] as const;

export type Phase = "lobby" | "plan" | "battle" | "final";

export interface GameOptions {
  world: World;
  lang?: Lang | undefined;
  rounds?: number | undefined;
  minPlayers?: number | undefined;
  timings?: Partial<Timings> | undefined;
  rng?: (() => number) | undefined;
}

export interface Standing {
  id: string;
  name: string;
  color: string;
  lands: number;
  armies: number;
}

export interface GameEvents {
  phase: [phase: Phase];
  end: [table: Standing[]];
  settings: [];
}

/** A player's numbers for the awards. */
interface Totals {
  /** Territories taken. */
  taken: number;
  /** Enemy armies beaten. */
  beaten: number;
  /** The biggest fight won: the armies it beat. */
  biggest: number;
  /** Times risen as a rebel. */
  rises: number;
}

/** What a phone's feed says of an event (its own part in it). */
export interface FeedItem {
  /** The battle's step it belongs to (`room.step.i`); -1 for a cancelled order (told before the battle). */
  i?: number;
  type: "place" | "move" | "attack" | "defend" | "clash" | "cancel" | "out" | "continent" | "rise";
  from?: string;
  to?: string;
  /** The other side (a player's id, `""` for the wild lands). */
  foe?: string;
  n?: number;
  won?: boolean;
  lost?: number;
  beat?: number;
  continent?: string;
}

const SOMEONE: Record<Lang, string> = { en: "someone", de: "jemand" };

export class Landgrab extends Emitter<GameEvents> {
  readonly party: Party;
  readonly world: World;
  rounds: number;
  readonly minPlayers: number;
  timings: Timings;
  readonly #rng: () => number;
  #lang: Lang;
  readonly #colors = new Map<string, number>();
  readonly #names = new Map<string, string>();
  #phase: Phase = "lobby";
  #running = false;
  #abort = new AbortController();
  #game = 0;
  #round = 0;
  /** The board as the views have it (during a battle: as far as the TV got). */
  #board: Board = { own: [], arm: [] };
  /** Who plays: ids in the order they joined the game. */
  #ids: string[] = [];
  readonly #stars = new Map<string, number>();
  readonly #totals = new Map<string, Totals>();
  /** The plan phase: each player's reinforcements and what they sent. */
  #reinf = new Map<string, Reinforcements>();
  #plans = new Map<string, Plan>();
  #planning: { ready: (all: boolean) => void } | undefined;
  #feeds = new Map<string, FeedItem[]>();

  constructor(party: Party, options: GameOptions) {
    super();
    this.party = party;
    this.world = options.world;
    this.rounds = options.rounds ?? 8;
    this.minPlayers = options.minPlayers ?? MIN_PLAYERS;
    this.timings = { ...DEFAULT_TIMINGS, ...options.timings };
    this.#rng = options.rng ?? Math.random;
    this.#lang = options.lang ?? "en";
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
  get round(): number {
    return this.#round;
  }
  /** The board (tests, bots in the host page). */
  get board(): Readonly<Board> {
    return this.#board;
  }
  /** Who plays this game (ids). */
  get ids(): readonly string[] {
    return this.#ids;
  }
  get planTime(): number {
    return this.timings.plan / 1000;
  }
  /** Who may join during a game (the party's `lateJoin`, as this game offers it). */
  get late(): Late {
    return this.party.lateJoin === "closed" ? "closed" : "wait";
  }
  stars(id: string): number {
    return this.#stars.get(id) ?? 0;
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
      if (typeof d !== "object" || d === null || Array.isArray(d)) throw new PartyError("bad-settings", "lang, rounds, planTime, late");
      const v = d as Record<string, Json>;
      for (const k of Object.keys(v)) if (!["lang", "rounds", "planTime", "late"].includes(k)) throw new PartyError("bad-settings", `${k}: not a setting`);
      const oneOf = <T extends Json>(key: string, list: readonly T[]): T | undefined => {
        if (v[key] === undefined) return undefined;
        if (!list.includes(v[key] as T)) throw new PartyError("bad-settings", `${key}: ${list.join(", ")}`);
        return v[key] as T;
      };
      const o = { lang: oneOf("lang", LANGS), rounds: oneOf("rounds", ROUNDS), planTime: oneOf("planTime", PLAN_TIMES), late: oneOf("late", LATE) };
      this.configure(o);
      return null;
    });
    party.handle("plan", (d, from) => this.#plan(d, from));
    party.on("join", (p) => {
      this.#names.set(p.id, p.name);
      if (!this.#colors.has(p.id)) this.#colors.set(p.id, this.#freeColor());
      this.#colorsChanged();
      if (!this.#running) p.state.replace(this.#lobbyState(p));
      else p.state.replace(this.#waitState(p));
    });
    party.on("leave", (p) => {
      if (!this.#ids.includes(p.id)) this.#colors.delete(p.id);
      this.#colorsChanged();
      this.#checkReady();
    });
    party.on("away", () => this.#checkReady());
    party.on("reconnect", () => this.#checkReady());
    this.#lobby();
  }

  /** Changes the rounds, the planning time, the language, the latecomers or the timers before a game. */
  configure(o: { rounds?: number | undefined; planTime?: number | undefined; lang?: Lang | undefined; late?: Late | undefined; timings?: Partial<Timings> | undefined }): void {
    if (this.#running) throw new PartyError("running", "Not during a game");
    const was = JSON.stringify([this.rounds, this.timings.plan, this.#lang, this.late]);
    if (o.timings) this.timings = { ...this.timings, ...o.timings };
    if (o.rounds !== undefined) this.rounds = Math.max(1, Math.min(30, Math.round(o.rounds)));
    if (o.planTime !== undefined && o.planTime > 0) this.timings.plan = o.planTime * 1000;
    if (o.lang !== undefined) this.#lang = o.lang;
    if (o.late !== undefined && (LATE as readonly string[]).includes(o.late)) this.party.lateJoin = o.late;
    if (this.#phase === "lobby" || this.#phase === "final") {
      const s = { lang: this.#lang, rounds: this.rounds, planTime: this.planTime };
      this.party.room.set({ ...s, late: this.late });
      this.party.screen.set(s);
    }
    if (JSON.stringify([this.rounds, this.timings.plan, this.#lang, this.late]) !== was) this.emit("settings");
  }

  /** Ends a running game at once (the lobby is back; nothing of it writes afterwards). */
  close(): void {
    if (!this.#running) return;
    this.#game++;
    this.#abort.abort();
    this.#stop();
    this.#lobby();
  }

  #stop(): void {
    this.#running = false;
    this.#planning = undefined;
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
    for (const [id, c] of this.#colors) if (this.party.player(id) || this.#ids.includes(id)) used[c]!++;
    return used.indexOf(Math.min(...used));
  }

  #colorMap(): Record<string, string> {
    const ids = new Set([...this.party.players.map((p) => p.id), ...this.#ids]);
    return Object.fromEntries([...ids].map((id) => [id, COLORS[this.colorOf(id)]!]));
  }

  #colorsChanged(): void {
    const colors = this.#colorMap();
    this.party.room.set({ colors });
    this.party.screen.set({ colors });
  }

  #name(id: string): string {
    return this.party.player(id)?.name ?? this.#names.get(id) ?? SOMEONE[this.#lang];
  }

  /** The standings as the views carry them. */
  #players(ready?: ReadonlySet<string>): Record<string, unknown>[] {
    return standing(this.#board, this.#ids).map((s) => ({
      ...s,
      name: this.#name(s.id),
      stars: this.stars(s.id),
      continents: continentsOf(this.world, this.#board, s.id),
      out: s.lands === 0,
      gone: !this.party.player(s.id),
      ...(ready ? { ready: ready.has(s.id) } : {}),
    }));
  }

  #common(): Record<string, unknown> {
    return { lang: this.#lang, round: this.#round, rounds: this.rounds, planTime: this.planTime, colors: this.#colorMap() };
  }

  #room(fields: Record<string, unknown>): void {
    this.party.room.replace({ ...this.#common(), late: this.late, minPlayers: this.minPlayers, maxPlayers: this.party.maxPlayers, ...fields });
  }

  #screen(fields: Record<string, unknown>): void {
    this.party.screen.replace({ ...this.#common(), minPlayers: this.minPlayers, maxPlayers: this.party.maxPlayers, ...fields });
  }

  #lobbyState(p: Player): Record<string, unknown> {
    return { task: "lobby", color: this.colorOf(p.id) };
  }

  #waitState(p: Player): Record<string, unknown> {
    return { task: "wait", color: this.colorOf(p.id) };
  }

  #lobby(): void {
    this.#setPhase("lobby");
    this.#room({ phase: "lobby" });
    this.#screen({ phase: "lobby" });
    for (const p of this.party.players) p.state.replace(this.#lobbyState(p));
  }

  #boardView(): Board {
    return { own: [...this.#board.own], arm: [...this.#board.arm] };
  }

  // -------------------------------------------------------------------------
  // A game

  /**
   * Plays a whole game with the players who are there (latecomers rise as
   * rebels at the next round). Ends after the last round, when someone
   * holds three quarters of the world, or when fewer than
   * {@link minPlayers} are left at the start of a round.
   */
  async play(): Promise<Standing[]> {
    const party = this.party;
    const game = ++this.#game;
    this.#running = true;
    this.#abort = new AbortController();
    const signal = this.#abort.signal;
    party.inProgress = true;
    this.#stars.clear();
    this.#totals.clear();
    this.#ids = party.players.slice(0, COLORS.length).map((p) => p.id);
    // Colours: each player of the game a colour of their own.
    const taken = new Set<number>();
    for (const id of this.#ids) {
      let c = this.colorOf(id);
      if (taken.has(c)) c = COLORS.findIndex((_, i) => !taken.has(i));
      taken.add(c);
      this.#colors.set(id, c);
    }
    this.#colorsChanged();
    this.#board = deal(this.world, this.#ids, this.#rng);
    let by: "rounds" | "domination" | "players" = "rounds";
    try {
      for (let r = 1; r <= this.rounds; r++) {
        this.#round = r;
        const rises = this.#newRound();
        const present = this.#ids.filter((id) => party.player(id));
        if (present.length < this.minPlayers) {
          by = "players";
          break;
        }
        await this.#planPhase(r, rises, signal);
        if (signal.aborted) break;
        await this.#battlePhase(r, signal);
        if (signal.aborted) break;
        if (dominator(this.#board)) {
          by = "domination";
          break;
        }
      }
      return signal.aborted ? this.#table() : this.#final(by);
    } finally {
      if (this.#game === game) this.#stop();
    }
  }

  /**
   * A round's start: players who left for good leave their lands wild,
   * latecomers come in, and whoever holds nothing rises (the leader's
   * weakest territory, {@link UPRISING_ARMIES} armies). Returns the
   * uprisings: `[player id, territory index]`.
   */
  #newRound(): [string, number][] {
    const party = this.party;
    const b = this.#board;
    for (const id of this.#ids) {
      if (party.player(id)) continue;
      b.own.forEach((o, i) => o === id && (b.own[i] = ""));
    }
    for (const p of party.players) {
      if (!p.waiting && this.#ids.includes(p.id)) continue;
      if (this.#ids.filter((id) => party.player(id)).length >= COLORS.length) continue;
      party.activate(p);
      if (!this.#ids.includes(p.id)) {
        // A free colour: one no player of this game has.
        const used = new Set(this.#ids.filter((id) => party.player(id)).map((id) => this.colorOf(id)));
        this.#colors.set(p.id, Math.max(0, COLORS.findIndex((_, i) => !used.has(i))));
        this.#ids = [...this.#ids.filter((id) => party.player(id) || territoriesOf(b, id).length > 0), p.id];
      }
    }
    this.#colorsChanged();
    const rises: [string, number][] = [];
    for (const id of this.#ids) {
      if (!party.player(id) || territoriesOf(b, id).length > 0) continue;
      const t = uprisingAt(this.world, b, this.#ids, this.#rng);
      if (t < 0) continue;
      b.own[t] = id;
      b.arm[t] = UPRISING_ARMIES;
      rises.push([id, t]);
      this.#total(id).rises++;
    }
    return rises;
  }

  #total(id: string): Totals {
    let t = this.#totals.get(id);
    if (!t) this.#totals.set(id, (t = { taken: 0, beaten: 0, biggest: 0, rises: 0 }));
    return t;
  }

  // -------------------------------------------------------------------------
  // Planning

  async #planPhase(r: number, rises: [string, number][], signal: AbortSignal): Promise<void> {
    const party = this.party;
    this.#setPhase("plan");
    this.#plans = new Map();
    this.#reinf = new Map();
    for (const id of this.#ids) if (territoriesOf(this.#board, id).length > 0) this.#reinf.set(id, reinforcements(this.world, this.#board, id));
    const duration = this.timings.plan + (r === 1 ? this.timings.firstPlan : 0);
    const deadline = party.deadline(duration + this.timings.banner);
    const ready = new Set<string>();
    const board = this.#boardView();
    party.withTv(() => {
      this.#room({ phase: "plan", board, players: this.#players(ready), deadline });
      this.#screen({ phase: "plan", board, players: this.#players(ready), deadline, duration, banner: this.timings.banner, rises });
      for (const p of party.players) {
        if (!this.#reinf.has(p.id)) {
          p.state.replace(this.#ids.includes(p.id) ? { task: "watch", color: this.colorOf(p.id), feed: [], out: true } : this.#waitState(p));
          continue;
        }
        const rose = rises.find(([id]) => id === p.id);
        p.state.replace({ task: "plan", color: this.colorOf(p.id), deadline, reinf: this.#reinf.get(p.id)!, stars: this.stars(p.id), plan: EMPTY_PLAN, ...(rose ? { rise: this.world.territories[rose[1]]!.id } : {}) });
      }
    });
    await new Promise<void>((resolve) => {
      let done = false;
      let soon: ReturnType<typeof setTimeout> | undefined;
      const end = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearTimeout(soon);
        signal.removeEventListener("abort", end);
        this.#planning = undefined;
        resolve();
      };
      const timer = setTimeout(end, Math.max(0, deadline + party.grace - party.now()));
      signal.addEventListener("abort", end, { once: true });
      this.#planning = {
        ready: (all) => {
          // Everyone is ready: a moment for the TV to show it, then the battle (unless someone changes their mind).
          clearTimeout(soon);
          soon = all ? setTimeout(end, this.timings.ready) : undefined;
        },
      };
    });
  }

  /** A plan from a phone (all of it, each time): checked, kept, the room told who is ready. */
  #plan(d: Json, from: Sender): unknown {
    if (from.role !== "player") throw new PartyError("not-player", "Players only");
    if (this.#phase !== "plan" || !this.#planning) throw new PartyError("not-now", "Not now");
    const reinf = this.#reinf.get(from.id);
    if (!reinf) throw new PartyError("not-playing", "You have no territories this round");
    let plan: Plan;
    try {
      plan = checkPlan(this.world, this.#board, from.id, reinf.total, this.stars(from.id), d);
    } catch (e) {
      if (e instanceof PlanError) throw new PartyError(e.code, e.message);
      throw e;
    }
    this.#plans.set(from.id, plan);
    const p = this.party.player(from.id);
    p?.state.set({ plan: plan as unknown as Json });
    this.#readyChanged();
    return { ok: true };
  }

  #readyIds(): Set<string> {
    return new Set([...this.#plans].filter(([, p]) => p.ready).map(([id]) => id));
  }

  #readyChanged(): void {
    const ready = this.#readyIds();
    const players = this.#players(ready);
    this.party.room.set({ players });
    this.party.screen.set({ players });
    this.#checkReady();
  }

  /** Ends planning when every player who is there and plays this round is ready. */
  #checkReady(): void {
    if (this.#phase !== "plan" || !this.#planning) return;
    const ready = this.#readyIds();
    const waiting = [...this.#reinf.keys()].filter((id) => this.party.player(id)?.connected && !ready.has(id));
    this.#planning.ready(waiting.length === 0 && ready.size > 0);
  }

  // -------------------------------------------------------------------------
  // The battle

  async #battlePhase(r: number, signal: AbortSignal): Promise<void> {
    const party = this.party;
    this.#setPhase("battle");
    // Every plan made whole: what was not placed is placed for them; cashed stars are spent.
    const plans = new Map<string, Plan>();
    for (const [id, reinf] of this.#reinf) {
      const plan = this.#plans.get(id) ?? EMPTY_PLAN;
      const budget = reinf.total + (plan.cash ? CASH_ARMIES : 0);
      if (plan.cash) this.#stars.set(id, this.stars(id) - STARS_TO_CASH);
      const place = { ...plan.place };
      for (const [t, n] of Object.entries(autoPlace(this.world, this.#board, id, budget - placedOf(plan)))) place[t] = (place[t] ?? 0) + n;
      plans.set(id, { ...plan, place });
    }
    // The order of play: the round robin starts one player later each round.
    const ids = [...this.#reinf.keys()];
    const shift = ids.length ? (r - 1) % ids.length : 0;
    const turn = [...ids.slice(shift), ...ids.slice(0, shift)];
    const working: Board = { own: [...this.#board.own], arm: [...this.#board.arm] };
    const { events, captured } = resolve(this.world, working, plans, turn, this.#rng);
    const scale = paceScale(events, this.timings.pace);
    this.#feeds = new Map(this.#ids.map((id) => [id, []]));
    const shown = events.filter((e) => e.type !== "cancel");
    // Cancelled orders go to their players' feeds right away (nothing to show on the TV).
    for (const e of events) if (e.type === "cancel") this.#feed(e, -1);
    party.withTv(() => {
      this.#room({ phase: "battle", board: this.#boardView(), players: this.#players(), step: null });
      this.#screen({ phase: "battle", board: this.#boardView(), players: this.#players(), step: null, turn });
      for (const p of party.players) p.state.replace(this.#ids.includes(p.id) ? { task: "watch", color: this.colorOf(p.id), feed: this.#feeds.get(p.id) ?? [] } : this.#waitState(p));
    });
    await this.#sleep(this.timings.ready, signal);
    for (let i = 0; i < shown.length; i++) {
      if (signal.aborted) return;
      const ev = shown[i]!;
      this.#apply(ev.set);
      this.#tally(ev);
      const touched = this.#feed(ev, i);
      const ms = eventMs(ev, this.timings.pace, scale);
      const board = this.#boardView();
      party.withTv(() => {
        const step = { i, of: shown.length, ev: ev as unknown as Json, ms, scale };
        this.party.screen.set({ step, board, players: this.#players() });
        this.party.room.set({ step: { i, of: shown.length, ev: ev as unknown as Json, ms, scale }, board, players: this.#players() });
        for (const id of touched) this.party.player(id)?.state.set({ feed: this.#feeds.get(id) as unknown as Json });
      });
      await this.#sleep(ms, signal);
    }
    if (signal.aborted) return;
    // The board is the resolution's now (they agree; this keeps it exact).
    this.#board = working;
    for (const id of captured) this.#stars.set(id, Math.min(MAX_STARS, this.stars(id) + 1));
    party.withTv(() => {
      this.party.screen.set({ step: { i: shown.length, of: shown.length, ev: null, ms: 0, scale }, board: this.#boardView(), players: this.#players(), starred: [...captured] });
      this.party.room.set({ step: null, board: this.#boardView(), players: this.#players() });
    });
    await this.#sleep(this.timings.after, signal);
  }

  #apply(set: Change[]): void {
    for (const [i, own, arm] of set) {
      this.#board.own[i] = own;
      this.#board.arm[i] = arm;
    }
  }

  #tally(ev: Event): void {
    const win = (a: { p: string; won: boolean; def: number; foe: string }) => {
      const t = this.#total(a.p);
      if (a.won) {
        t.taken++;
        t.biggest = Math.max(t.biggest, a.def);
      }
      t.beaten += a.def;
    };
    if (ev.type === "attack") win(ev);
    if (ev.type === "clash" && ev.then) win(ev.then);
  }

  /** Adds an event (step `i` of the battle, -1 for a cancelled order) to the feeds of the players it touches; returns their ids. */
  #feed(ev: Event, i: number): string[] {
    const t = (i: number) => this.world.territories[i]!.id;
    const out = new Set<string>();
    const push = (id: string, item: FeedItem) => {
      const f = this.#feeds.get(id);
      if (!f) return;
      f.push({ ...item, i });
      out.add(id);
    };
    const attack = (a: { p: string; from: number; to: number; n: number; foe: string; def: number; left: number; won: boolean }) => {
      push(a.p, { type: "attack", from: t(a.from), to: t(a.to), foe: a.foe, n: a.n, won: a.won, lost: a.n - a.left, beat: a.won ? a.def : a.def - (this.#board.arm[a.to] ?? 0) });
      if (a.foe) push(a.foe, { type: "defend", from: t(a.from), to: t(a.to), foe: a.p, n: a.n, won: !a.won, beat: a.n - a.left });
    };
    switch (ev.type) {
      case "place":
        for (const [i, p, n] of ev.add) push(p, { type: "place", to: t(i), n });
        break;
      case "move":
        push(ev.p, { type: "move", from: t(ev.from), to: t(ev.to), n: ev.n });
        break;
      case "cancel":
        push(ev.p, { type: "cancel", from: t(ev.from), to: t(ev.to) });
        break;
      case "attack":
        attack(ev);
        break;
      case "clash":
        push(ev.p, { type: "clash", from: t(ev.a), to: t(ev.b), foe: ev.q, n: ev.na, lost: ev.na - ev.leftA, won: ev.leftA > 0 });
        push(ev.q, { type: "clash", from: t(ev.b), to: t(ev.a), foe: ev.p, n: ev.nb, lost: ev.nb - ev.leftB, won: ev.leftB > 0 });
        if (ev.then) attack(ev.then);
        break;
    }
    if (ev.type === "attack" || ev.type === "clash") {
      if (ev.out) push(ev.out, { type: "out" });
      if (ev.continent) {
        const winner = ev.type === "attack" ? ev.p : (ev.then?.p ?? "");
        push(winner, { type: "continent", continent: ev.continent });
      }
    }
    return [...out];
  }

  // -------------------------------------------------------------------------
  // The end

  #table(): Standing[] {
    return standing(this.#board, this.#ids).map((s) => ({ ...s, name: this.#name(s.id), color: COLORS[this.colorOf(s.id)]! }));
  }

  #awards(): Record<string, { id: string; n: number } | null> {
    const here = [...this.#totals].filter(([id]) => this.party.player(id));
    const best = (k: keyof Totals) => {
      const top = Math.max(0, ...here.map(([, t]) => t[k]));
      if (top <= 0) return null;
      return { id: here.find(([, t]) => t[k] === top)![0], n: top };
    };
    return { conqueror: best("taken"), warlord: best("beaten"), giant: best("biggest"), phoenix: best("rises") };
  }

  #final(by: "rounds" | "domination" | "players"): Standing[] {
    const party = this.party;
    this.#setPhase("final");
    const table = this.#table();
    const final = { winner: table[0]?.id ?? null, by, table, awards: this.#awards() };
    const board = this.#boardView();
    party.withTv(() => {
      this.#room({ phase: "final", board, players: this.#players(), final });
      this.#screen({ phase: "final", board, players: this.#players(), final });
      for (const p of party.players) {
        const rank = table.findIndex((s) => s.id === p.id);
        p.state.replace({ task: "final", color: this.colorOf(p.id), rank: rank >= 0 ? rank + 1 : null, of: table.length });
      }
    });
    this.emit("end", table);
    return table;
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

export { armiesOf, territoriesOf };
