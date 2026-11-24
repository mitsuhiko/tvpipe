/**
 * Pinch on a party, for 3 to 8 players (docs/pinch-design.md §2, §11):
 * the lobby, then a round per thief turn: the briefing (a fresh estate,
 * the catalogue; the car and the tip to the thief alone), the heist (the
 * simulation, `game/sim.ts`, at 20 Hz, frames to each phone and the
 * public layer to the TV at 10 Hz), the outcome, the tape, the scores;
 * at the end the podium and the awards. The host is the only authority:
 * phones and screens only get views and messages (game/views.ts has
 * them all, and the actions).
 *
 * Secrecy at this layer: the getaway car and the tip go only into the
 * thief's `player.state`; nothing secret goes into `party.room` or
 * `party.screen`; frames go only to their own player, never to a
 * screen; the tape (everything revealed) goes to screens after the heist.
 */

import { Emitter, PartyError, type ActionInfo, type Json, type Party, type Player, type Sender } from "@tvpipe/party";

import { LANGS, pickCatalogue, type Lang, type NightItem } from "./items.ts";
import { encodeBlueprint, generate, lootCount, lootPlaces, tryEstate, type Estate } from "./map.ts";
import { parseAction, TIMES, type Action, type Frame, type HeistResult, type PublicDelta, type Refusal, type Tape } from "./protocol.ts";
import { hashSeed, Rng } from "./rng.ts";
import { Heist } from "./sim.ts";
import { catalogueEntry, type AwardView, type CatalogueEntry, type Phase, type PlayerView, type RoomView, type RoundView, type SettingsView, type ThiefBriefing } from "./views.ts";
import { ESTATE_COUNT, REFUSALS, words, type RefusalId } from "./words.ts";

export type { Phase } from "./views.ts";

export const MIN_PLAYERS = 3;
/** The simulation's step (ms): 20 Hz. */
export const STEP_MS = 50;

export interface Timings {
  /** The briefing (§2: 20 s). */
  briefing: number;
  /** The outcome card. */
  outcome: number;
  /** The tape (§8: about 40 s), unless skipped. */
  tape: number;
  /** The scores. */
  scores: number;
  /** The heist's length in seconds instead of the setting (null: the setting): `?fast`, tests. */
  heist: number | null;
  /** A thief away this long (heist seconds) ends the heist: "left" (§11). */
  awayLimit: number;
  /** Real ms per 50 ms simulation step: 50 is real time; tests run the heist faster (5: ten times). */
  step: number;
  /** Frames and public deltas (real ms between). */
  frame: number;
  /** The public layer's snapshot into `party.screen` (ms between, at least). */
  snapshot: number;
  /** A public-layer keyframe in frames and to screens (ms between). */
  keyframe: number;
}

export const DEFAULT_TIMINGS: Timings = {
  briefing: 20_000,
  outcome: 5000,
  tape: 40_000,
  scores: 8000,
  heist: null,
  awayLimit: TIMES.awayLimit,
  step: STEP_MS,
  frame: 100,
  snapshot: 1000,
  keyframe: 5000,
};

/** For trying the game (`?fast`): short phases and a 60 s heist. */
export const FAST_TIMINGS: Partial<Timings> = { briefing: 6000, outcome: 3000, tape: 12_000, scores: 4000, heist: 60 };

export interface Settings extends SettingsView {
  lang: Lang;
}

export interface GameOptions {
  lang?: Lang | undefined;
  length?: number | undefined;
  rounds?: 1 | 2 | undefined;
  minPlayers?: number | undefined;
  timings?: Partial<Timings> | undefined;
  /** Shuffles, estate seeds, words (default: seeded from `seed`, else Math.random). */
  rng?: (() => number) | undefined;
  /** A seed for the game's rng when no `rng` is given: the same seed, the same thief order and estates. */
  seed?: number | undefined;
  /** Test and check hook: the thief order (see {@link Pinch.thiefOrder}). */
  thiefOrder?: readonly string[] | undefined;
}

export interface Result {
  scores: Record<string, number>;
  history: RoundView[];
  podium: string[];
  ended?: "few";
}

export interface GameEvents {
  phase: [phase: Phase];
  settings: [settings: Settings];
  /** A round's estate is ready (tests and bots: {@link Pinch.estate}, {@link Pinch.truth}). */
  round: [n: number];
  /** A heist ended (its result). */
  heist: [result: HeistResult];
  end: [result: Result];
}

/** The players' colours (guards wear them): Deco tones apart on the blueprint's blue and the warm rooms. */
export const COLORS = ["#e8b923", "#e0475b", "#3fc1a5", "#f28c28", "#9b7bff", "#5aa9ff", "#86cf2e", "#ff7fbf"] as const;

/** The getaway car's and the loot's truth for one round (bots' oracle, tests). Never sent to a phone. */
export interface Truth {
  car: number;
  /** Per catalogue index: the tile it lies on and the walkable tile to take it from. */
  loot: { item: number; x: number; y: number; access: number; room: number }[];
}

/** English words for the refusals words.ts does not have. */
const REFUSAL_WORDS: Partial<Record<Refusal, string>> = { role: "Not for you", over: "Not now", invalid: "Not understood" };

/** A round being played. */
interface Round {
  n: number;
  thief: string;
  /** Everyone in it, the thief first (ids). */
  cast: string[];
  estate: Estate;
  estateName: number;
  catalogue: readonly NightItem[];
  length: number;
  heist: Heist | null;
  result: HeistResult | null;
  tape: Tape | null;
}

/** Per player across the game, for the awards. */
interface Stats {
  holds: number;
  arrests: number;
  lies: number;
  lightsOff: number;
  /** As the thief: the nearest unseen pass (tiles). */
  closest: number | null;
  bestHaul: number;
}

export class Pinch extends Emitter<GameEvents> {
  readonly party: Party;
  readonly minPlayers: number;
  timings: Timings;
  /** Stop after this many rounds (tests that are not about the rotation); null: every thief turn. */
  maxRounds: number | null = null;
  /**
   * Test and check hook (the live and lag checks, tests): the thief order
   * for the next game, player ids, instead of the shuffle. Ids not in the
   * game are skipped; players it leaves out follow, shuffled. With two
   * turns each, the order is played twice. Null: shuffled (the game).
   */
  thiefOrder: readonly string[] | null = null;
  readonly #rng: () => number;
  #lang: Lang;
  #length: number;
  #rounds: 1 | 2;
  #phase: Phase = "lobby";
  #running = false;
  #abort = new AbortController();
  #game = 0;
  readonly #colors = new Map<string, number>();
  readonly #names = new Map<string, string>();
  /** Thief turns to come (ids). */
  #queue: string[] = [];
  #scores: Record<string, number> = {};
  #history: RoundView[] = [];
  readonly #stats = new Map<string, Stats>();
  #round: Round | null = null;
  #skip: (() => void) | null = null;
  // The heist's loop.
  #tick: ReturnType<typeof setTimeout> | undefined;
  /** Players whose next frame carries a keyframe. */
  readonly #keyFor = new Set<string>();
  readonly #lastKey = new Map<string, number>();
  #screenKey = true;
  #screenLastKey = 0;

  constructor(party: Party, options: GameOptions = {}) {
    super();
    this.party = party;
    this.minPlayers = options.minPlayers ?? MIN_PLAYERS;
    this.timings = { ...DEFAULT_TIMINGS, ...options.timings };
    if (options.rng) this.#rng = options.rng;
    else if (options.seed !== undefined) {
      const seeded = new Rng(options.seed >>> 0);
      this.#rng = () => seeded.float();
    } else this.#rng = Math.random;
    this.thiefOrder = options.thiefOrder ? [...options.thiefOrder] : null;
    this.#lang = options.lang ?? "en";
    this.#length = TIMES.lengths.includes(options.length ?? -1) ? options.length! : TIMES.length;
    this.#rounds = options.rounds ?? 1;
  }

  get settings(): Settings {
    return { ...this.#settingsView(), lang: this.#lang };
  }
  get lang(): Lang {
    return this.#lang;
  }
  get phase(): Phase {
    return this.#phase;
  }
  get running(): boolean {
    return this.#running;
  }
  /** The round's number (0 before the first). */
  get roundNo(): number {
    return this.#round?.n ?? 0;
  }
  /** The thief of the round, or null. */
  get thief(): string | null {
    return this.#round?.thief ?? null;
  }
  /** The thief turns to come (a copy). */
  get queue(): string[] {
    return [...this.#queue];
  }
  get scores(): Record<string, number> {
    return { ...this.#scores };
  }
  get history(): readonly RoundView[] {
    return this.#history;
  }

  /** The round's estate, secrets and all (tests, bots' oracle). Never sent to a phone. */
  get estate(): Estate | null {
    return this.#round?.estate ?? null;
  }
  /** The night's catalogue (most valuable first). */
  get catalogue(): readonly NightItem[] {
    return this.#round?.catalogue ?? [];
  }
  /** The running simulation (tests). */
  get heist(): Heist | null {
    return this.#round?.heist ?? null;
  }
  /** The last round's tape (tests). */
  get tape(): Tape | null {
    return this.#round?.tape ?? null;
  }

  /** Where the car and the loot are this round (the bots' oracle; null between rounds). Never sent to a phone. */
  truth(): Truth | null {
    const r = this.#round;
    if (!r) return null;
    const { places } = r.estate;
    return {
      car: r.estate.car,
      loot: r.catalogue.map((n, item) => {
        const p = places[n.place]!;
        return { item, x: p.x, y: p.y, access: p.access, room: p.room };
      }),
    };
  }

  colorOf(id: string): string {
    return COLORS[this.#colors.get(id) ?? 0]!;
  }

  /** Ends the heist now as if the clock ran out (the live check). */
  timeUp(): void {
    this.#round?.heist?.timeUp();
  }

  /** Skips the tape or the scores (the host page). */
  skip(): boolean {
    if (!this.#skip || (this.#phase !== "tape" && this.#phase !== "scores")) return false;
    this.#skip();
    return true;
  }

  // -------------------------------------------------------------------------
  // The party

  /** Shows the lobby and handles the actions. */
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
      const v = obj(d);
      for (const k of Object.keys(v)) if (k !== "length" && k !== "rounds" && k !== "lang" && k !== "late") throw new PartyError("bad-settings", `${k}: not a setting`);
      // Late joining is live (as on the host page): the others wait for the lobby.
      if (this.#running && Object.keys(v).some((k) => k !== "late")) throw new PartyError("running", "Not during a game");
      const length = v["length"];
      const rounds = v["rounds"];
      const lang = v["lang"];
      if (length !== undefined && !(typeof length === "number" && TIMES.lengths.includes(length))) throw new PartyError("bad-settings", `length: ${TIMES.lengths.join(", ")}`);
      if (rounds !== undefined && rounds !== 1 && rounds !== 2) throw new PartyError("bad-settings", "rounds: 1, 2");
      if (lang !== undefined && !(LANGS as readonly Json[]).includes(lang)) throw new PartyError("bad-settings", `lang: ${LANGS.join(", ")}`);
      const late = v["late"];
      if (late !== undefined && late !== "wait" && late !== "closed") throw new PartyError("bad-settings", "late: wait, closed");
      this.configure({ length: length as number | undefined, rounds: rounds as 1 | 2 | undefined, lang: lang as Lang | undefined, late: late as "wait" | "closed" | undefined });
      return null;
    });
    party.handle("skip", (_d, from) => {
      vipOnly(from);
      if (!this.skip()) throw new PartyError("not-now", "Nothing to skip");
      return null;
    });
    party.handle("h", (d, from, info) => this.#act(d, from, info));
    party.handle("resync", (_d, from) => {
      if (from.role === "player") this.#keyFor.add(from.id);
      return null;
    });
    party.on("input", (p, data) => {
      const h = this.#round?.heist;
      if (!h || this.#phase !== "heist" || !this.#round!.cast.includes(p.id)) return;
      const a = parseAction({ ...obj(data), a: "aim" });
      if (a) h.act(p.id, a);
    });
    party.on("join", (p) => {
      this.#names.set(p.id, p.name);
      this.#colors.set(p.id, this.#freeColor());
      this.#colorsChanged();
      if (this.#running) {
        // A latecomer: a guard from the next round, a thief turn at the end.
        p.state.replace(json(this.#waitState(p)));
      } else p.state.replace(json(this.#lobbyState(p)));
    });
    party.on("away", (p) => this.#awayChanged(p, true));
    party.on("reconnect", (p) => {
      this.#keyFor.add(p.id);
      this.#awayChanged(p, false);
    });
    party.on("leave", (p) => this.#left(p));
    party.on("screen", (_s, connected) => {
      if (!connected) return;
      this.#screenKey = true;
      if (this.#phase === "tape") this.#sendTape();
    });
    this.#lobby();
  }

  /** Changes the settings between games; every phone and the TV follow. */
  configure(o: { length?: number | undefined; rounds?: 1 | 2 | undefined; lang?: Lang | undefined; late?: "wait" | "closed" | undefined; timings?: Partial<Timings> | undefined }): void {
    if (this.#running && (o.length !== undefined || o.rounds !== undefined || o.lang !== undefined)) throw new PartyError("running", "Not during a game");
    const was = JSON.stringify(this.settings);
    if (o.late === "wait" || o.late === "closed") this.party.lateJoin = o.late;
    if (o.length !== undefined && TIMES.lengths.includes(o.length)) this.#length = o.length;
    if (o.rounds === 1 || o.rounds === 2) this.#rounds = o.rounds;
    if (o.lang !== undefined && LANGS.includes(o.lang)) this.#lang = o.lang;
    if (o.timings) this.timings = { ...this.timings, ...o.timings };
    const f = { lang: this.#lang, settings: this.#settingsView() };
    this.party.room.set(f);
    this.party.screen.set(f);
    if (JSON.stringify(this.settings) !== was) this.emit("settings", this.settings);
  }

  /** Ends a running game (the party stays): the lobby at once. */
  close(): void {
    if (!this.#running) return;
    this.#game++;
    this.#abort.abort();
    this.#stop();
    this.#lobby();
  }

  #stop(): void {
    this.#stopHeist();
    this.#skip = null;
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

  #settingsView(): SettingsView {
    return { length: this.#length, rounds: this.#rounds, late: this.party.lateJoin === "closed" ? "closed" : "wait" };
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
    return Object.fromEntries(this.party.players.map((p) => [p.id, this.colorOf(p.id)]));
  }

  #colorsChanged(): void {
    const colors = this.#colorMap();
    this.party.room.set({ colors });
    this.party.screen.set({ colors });
  }

  /** The fields every room view has. */
  #base(): RoomView {
    const r = this.#round;
    return {
      phase: this.#phase,
      lang: this.#lang,
      settings: this.#settingsView(),
      minPlayers: this.minPlayers,
      colors: this.#colorMap(),
      round: r?.n ?? 0,
      rounds: (r?.n ?? 0) + this.#queue.length,
      thief: r?.thief ?? null,
      next: [...this.#queue],
      scores: { ...this.#scores },
      history: [...this.#history],
    };
  }

  /** Replaces the room and the screen views (a new round, the lobby, the end). */
  #replace(fields: Partial<RoomView>): void {
    const v = { ...this.#base(), ...fields } as unknown as Record<string, Json>;
    this.party.room.replace(v);
    this.party.screen.replace({ ...v, maxPlayers: this.party.maxPlayers });
  }

  /** Sets fields of the room and the screen views (a phase within a round). */
  #set(fields: Partial<RoomView> & Record<string, unknown>): void {
    const v = { ...this.#base(), ...fields } as unknown as Record<string, Json | undefined>;
    this.party.room.set(v);
    this.party.screen.set(v);
  }

  #lobbyState(p: Player): PlayerView {
    return { role: this.#phase === "final" ? "final" : "lobby", color: this.colorOf(p.id) };
  }

  #waitState(p: Player): PlayerView {
    return { role: "wait", color: this.colorOf(p.id) };
  }

  #lobby(): void {
    this.#round = null;
    this.#queue = [];
    this.#setPhase("lobby");
    this.#replace({ phase: "lobby" });
    for (const p of this.party.players) p.state.replace(json(this.#lobbyState(p)));
  }

  #statsOf(id: string): Stats {
    let s = this.#stats.get(id);
    if (!s) this.#stats.set(id, (s = { holds: 0, arrests: 0, lies: 0, lightsOff: 0, closest: null, bestHaul: 0 }));
    return s;
  }

  // -------------------------------------------------------------------------
  // A game

  /**
   * Plays a game with the players who are there (and those who join):
   * a round per thief turn, until every turn is played or fewer than
   * {@link minPlayers} are left. Closed ({@link close}), it returns what
   * was scored and shows nothing more.
   */
  async play(): Promise<Result> {
    const party = this.party;
    const game = ++this.#game;
    this.#running = true;
    this.#abort = new AbortController();
    const signal = this.#abort.signal;
    party.inProgress = true;
    this.#scores = Object.fromEntries(party.players.map((p) => [p.id, 0]));
    this.#history = [];
    this.#stats.clear();
    this.#queue = this.#order(party.players.filter((p) => !p.waiting).map((p) => p.id));
    let ended: "few" | undefined;
    try {
      for (let n = 1; !signal.aborted; n++) {
        for (const p of party.players) {
          if (p.waiting) {
            party.activate(p);
            this.#latecomer(p.id);
          }
        }
        if (party.players.length < this.minPlayers) {
          ended = "few";
          break;
        }
        if (this.maxRounds !== null && n > this.maxRounds) break;
        const thief = this.#nextThief();
        if (!thief) break;
        const round = await this.#prepare(n, thief, signal);
        if (!round || signal.aborted) break;
        const how = await this.#playRound(round, signal);
        if (how === "few") {
          ended = "few";
          break;
        }
        if (how === "abort") break;
      }
      return signal.aborted ? this.#result() : this.#final(ended);
    } finally {
      if (this.#game === game) this.#stop();
    }
  }

  /** The thief order: everyone once (or twice, each pass shuffled, nobody twice in a row). */
  #order(ids: string[]): string[] {
    // Seeded from the game's rng at the start of each game (its `rng` or `seed` option).
    const rng = new Rng(Math.floor(this.#rng() * 2 ** 32));
    const fixed = this.thiefOrder ? [...new Set(this.thiefOrder)].filter((id) => ids.includes(id)) : null;
    if (fixed) {
      const pass = [...fixed, ...rng.shuffle(ids.filter((id) => !fixed.includes(id)))];
      return this.#rounds === 2 ? [...pass, ...pass] : pass;
    }
    const out = rng.shuffle(ids);
    if (this.#rounds === 2) {
      const again = rng.shuffle(ids);
      if (again.length > 1 && again[0] === out[out.length - 1]) [again[0], again[1]] = [again[1]!, again[0]!];
      out.push(...again);
    }
    return out;
  }

  #latecomer(id: string): void {
    for (let i = 0; i < this.#rounds; i++) this.#queue.push(id);
    this.#scores[id] ??= 0;
  }

  /** The next thief: the first in the queue who is connected (an away one keeps the turn for later), else the first there. */
  #nextThief(): string | null {
    this.#queue = this.#queue.filter((id) => this.party.player(id));
    const i = this.#queue.findIndex((id) => this.party.player(id)?.connected);
    const at = i >= 0 ? i : 0;
    const id = this.#queue[at];
    if (id === undefined) return null;
    this.#queue.splice(at, 1);
    return id;
  }

  /** A round's estate, a try at a time so the page keeps going; its catalogue. */
  async #prepare(n: number, thief: string, signal: AbortSignal): Promise<Round | null> {
    const players = this.party.players.length;
    const seed = Math.floor(this.#rng() * 2 ** 32) >>> 0;
    let estate: Estate | null = null;
    for (let attempt = 0; attempt < 400 && !estate; attempt++) {
      if (signal.aborted) return null;
      const e = tryEstate(players, seed, attempt);
      if (typeof e !== "string") estate = e;
      else if (attempt % 3 === 2) await new Promise((r) => setTimeout(r, 0));
    }
    estate ??= generate(players, seed ^ 0x5bd1e995);
    if (signal.aborted) return null;
    const rng = new Rng(hashSeed("pinch-night", seed));
    const catalogue = pickCatalogue(lootCount(players), () => rng.float(), lootPlaces(estate));
    const cast = [thief, ...this.party.players.map((p) => p.id).filter((id) => id !== thief)];
    return {
      n,
      thief,
      cast,
      estate,
      estateName: Math.floor(this.#rng() * ESTATE_COUNT),
      catalogue,
      length: this.timings.heist ?? this.#length,
      heist: null,
      result: null,
      tape: null,
    };
  }

  /** The thief's tip: one of the three most valuable items and its wing. */
  #tip(r: Round): ThiefBriefing["tip"] {
    const top = r.catalogue.slice(0, 3);
    const k = Math.floor(this.#rng() * top.length);
    const n = top[Math.min(k, top.length - 1)]!;
    const place = r.estate.places[n.place]!;
    const twoHouses = r.estate.map.buildings.length > 1;
    if (place.wing.building < 0) return { item: n.item.id, wing: "garden" };
    return twoHouses ? { item: n.item.id, wing: place.wing.half, building: place.wing.building } : { item: n.item.id, wing: place.wing.half };
  }

  /** The start tiles: the thief at the car, guards in the security office (as the heist places them). */
  #starts(r: Round, heist: Heist): Map<string, { x: number; y: number }> {
    const out = new Map<string, { x: number; y: number }>();
    for (const id of r.cast) {
      const s = heist.peek(id);
      if (s) out.set(id, { x: Math.floor(s.x), y: Math.floor(s.y) });
    }
    return out;
  }

  /** One round: the briefing, the heist, the outcome, the tape, the scores. */
  async #playRound(r: Round, signal: AbortSignal): Promise<"done" | "abort" | "few"> {
    const party = this.party;
    this.#round = r;
    const heist = new Heist(r.estate, { thief: r.thief, guards: r.cast.slice(1), catalogue: r.catalogue, seed: r.n }, { length: r.length, times: { awayLimit: this.timings.awayLimit } });
    r.heist = heist;
    r.catalogue = heist.catalogue;
    const starts = this.#starts(r, heist);
    // The briefing.
    this.#setPhase("briefing");
    const catalogue: CatalogueEntry[] = r.catalogue.map(catalogueEntry);
    const briefing: ThiefBriefing = { car: r.estate.car, tip: this.#tip(r) };
    party.withTv(() => {
      this.#replace({
        phase: "briefing",
        estate: r.estateName,
        blueprint: encodeBlueprint(r.estate.map),
        catalogue,
        length: r.length,
        deadline: party.deadline(this.timings.briefing),
      });
      for (const p of party.players) {
        const start = starts.get(p.id);
        let v: PlayerView;
        if (p.id === r.thief) v = { role: "thief", color: this.colorOf(p.id), briefing, ...(start ? { start } : {}) };
        else if (r.cast.includes(p.id)) v = { role: "guard", color: this.colorOf(p.id), ...(start ? { start } : {}) };
        else v = this.#waitState(p);
        p.state.replace(json(v));
      }
    });
    this.emit("round", r.n);
    // (Cut short when the thief leaves: the heist then ends at once, "left".)
    await this.#wait(this.timings.briefing, signal);
    if (signal.aborted) return "abort";
    if (party.players.length < this.minPlayers) return "few";

    // The heist (none when the thief left during the briefing: straight to the outcome).
    const result = heist.result ?? (await this.#runHeist(r, signal));
    if (signal.aborted) return "abort";
    if (!result) return "few";
    r.result = result;
    this.emit("heist", result);
    this.#score(r, result);

    // The outcome.
    this.#setPhase("outcome");
    const by = result.outcome === "pinched" ? result.arrester : null;
    party.withTv(() => {
      this.#set({ phase: "outcome", outcome: { kind: result.outcome, car: result.car, ...(by ? { by } : {}) }, deadline: party.deadline(this.timings.outcome) });
      for (const p of party.players) {
        if (r.cast.includes(p.id)) p.state.set({ briefing: undefined });
      }
    });
    await sleep(this.timings.outcome, signal);
    if (signal.aborted) return "abort";

    // The tape (not when the thief left: the next round, §11).
    r.tape = heist.tape();
    if (result.outcome !== "left") {
      this.#setPhase("tape");
      party.withTv(() => {
        this.#set({ phase: "tape", deadline: party.deadline(this.timings.tape) });
        this.#sendTape();
      });
      await this.#wait(this.timings.tape, signal);
      if (signal.aborted) return "abort";
    }

    // The scores.
    this.#setPhase("scores");
    party.withTv(() => {
      this.#set({ phase: "scores", outcome: { kind: result.outcome, car: result.car, ...(by ? { by } : {}), haul: result.haul }, deadline: party.deadline(this.timings.scores) });
    });
    await this.#wait(this.timings.scores, signal);
    return signal.aborted ? "abort" : "done";
  }

  #sendTape(): void {
    const r = this.#round;
    if (!r?.tape || !r.result) return;
    const msg = { tape: r.tape, result: r.result, round: r.n };
    this.party.broadcast("tape", msg, "screen");
    this.party.broadcast("tape", msg, "watch");
  }

  /** Waits `ms`, or until the VIP or the host skips. */
  async #wait(ms: number, signal: AbortSignal): Promise<void> {
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    this.#skip = () => ctl.abort();
    await sleep(ms, ctl.signal);
    this.#skip = null;
    signal.removeEventListener("abort", onAbort);
  }

  /** The round's scores (§2) and the stats for the awards. */
  #score(r: Round, result: HeistResult): void {
    const rewards: Record<string, number> = {};
    if (result.outcome === "pinched") {
      if (result.holder) rewards[result.holder] = (rewards[result.holder] ?? 0) + 1000;
      if (result.arrester) rewards[result.arrester] = (rewards[result.arrester] ?? 0) + 2000;
    }
    const haul = result.outcome === "gotAway" ? result.haul : 0;
    const add = (id: string, v: number) => {
      if (this.party.player(id) || id in this.#scores) this.#scores[id] = (this.#scores[id] ?? 0) + v;
    };
    if (result.outcome !== "left") add(r.thief, haul);
    for (const [id, v] of Object.entries(rewards)) add(id, v);
    const ts = this.#statsOf(r.thief);
    ts.bestHaul = Math.max(ts.bestHaul, haul);
    for (const [id, s] of Object.entries(result.stats)) {
      const st = this.#statsOf(id);
      if (id === r.thief) {
        if (s.closest !== null) st.closest = st.closest === null ? s.closest : Math.min(st.closest, s.closest);
      } else {
        st.holds += s.holds;
        st.arrests += s.arrests;
        st.lies += s.lies;
      }
      st.lightsOff += s.lightsOff;
    }
    this.#history.push({
      round: r.n,
      thief: r.thief,
      outcome: result.outcome,
      haul,
      items: r.catalogue.length ? result.taken.map((i) => r.catalogue[i]?.item.id ?? "").filter(Boolean) : [],
      rewards,
    });
  }

  /** Richest first; ties: the bigger single haul first. */
  #podium(): string[] {
    const ids = Object.keys(this.#scores).filter((id) => this.party.player(id));
    return ids.sort((a, b) => (this.#scores[b] ?? 0) - (this.#scores[a] ?? 0) || this.#statsOf(b).bestHaul - this.#statsOf(a).bestHaul);
  }

  /** Three awards (§9) from the game's stats, each only when earned. */
  #awards(): AwardView[] {
    const here = [...this.#stats].filter(([id]) => this.party.player(id));
    const top = (f: (s: Stats) => number): [string, Stats] | null => {
      let best: [string, Stats] | null = null;
      for (const e of here) if (f(e[1]) > 0 && (!best || f(e[1]) > f(best[1]))) best = e;
      return best;
    };
    const out: AwardView[] = [];
    const sticky = top((s) => s.bestHaul);
    if (sticky) out.push({ id: "stickyFingers", player: sticky[0], params: { haul: sticky[1].bestHaul } });
    const arm = top((s) => s.arrests * 2 + s.holds);
    if (arm) out.push({ id: "longArm", player: arm[0], params: { holds: arm[1].holds, arrests: arm[1].arrests } });
    const rest: AwardView[] = [];
    const close = top((s) => (s.closest === null ? 0 : 10 - s.closest));
    if (close) rest.push({ id: "closeShave", player: close[0], params: { paces: Math.max(1, Math.round(close[1].closest!)) } });
    const tales = top((s) => s.lies);
    if (tales) rest.push({ id: "tallTales", player: tales[0], params: { lies: tales[1].lies } });
    const lights = top((s) => s.lightsOff);
    if (lights) rest.push({ id: "lightsOut", player: lights[0], params: { lights: lights[1].lightsOff } });
    const rng = new Rng(Math.floor(this.#rng() * 2 ** 32));
    out.push(...rng.shuffle(rest));
    return out.slice(0, 3);
  }

  #result(ended?: "few"): Result {
    return { scores: { ...this.#scores }, history: [...this.#history], podium: this.#podium(), ...(ended ? { ended } : {}) };
  }

  #final(ended?: "few"): Result {
    const party = this.party;
    this.#round = null;
    this.#queue = [];
    this.#setPhase("final");
    const result = this.#result(ended);
    party.withTv(() => {
      this.#replace({ phase: "final", podium: result.podium, awards: this.#awards(), ...(ended ? { ended } : {}) });
      for (const p of party.players) p.state.replace({ role: "final", color: this.colorOf(p.id) });
    });
    this.emit("end", result);
    return result;
  }

  // -------------------------------------------------------------------------
  // The heist

  /** Runs the heist to its end; null when the game ran out of players (or was closed). */
  #runHeist(r: Round, signal: AbortSignal): Promise<HeistResult | null> {
    const party = this.party;
    const heist = r.heist!;
    this.#setPhase("heist");
    this.#keyFor.clear();
    this.#lastKey.clear();
    for (const id of r.cast) this.#keyFor.add(id);
    this.#screenKey = true;
    for (const id of r.cast) {
      const p = party.player(id);
      if (!p) heist.leave(id);
      else if (!p.connected) heist.setAway(id, true);
    }
    party.withTv(() => {
      this.#set({ phase: "heist", deadline: null, pub: heist.publicLayer() });
    });
    return new Promise((resolve) => {
      let steps = 0;
      const t0 = Date.now();
      /** When the next frames are due: on a grid of `timings.frame`, so a late tick does not push every later frame back. */
      let nextFrame = -Infinity;
      let lastSnap = -Infinity;
      const finish = (v: HeistResult | null) => {
        this.#stopHeist();
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      };
      const onAbort = () => finish(null);
      signal.addEventListener("abort", onAbort, { once: true });
      this.#endHeist = finish;
      const tick = () => {
        this.#tick = undefined;
        const now = Date.now();
        // Drift correction: the steps due by now; after a long stall (a hidden page) at most 250 ms' worth at once.
        const every = Math.max(1, this.timings.step);
        const most = Math.max(5, Math.ceil(250 / every));
        let due = Math.floor((now - t0) / every) - steps;
        if (due > most) {
          steps += due - most;
          due = most;
        }
        for (let k = 0; k < due && !heist.result; k++) {
          steps++;
          heist.step();
        }
        const result = heist.result;
        if (now >= nextFrame - every / 2 || result) {
          // Behind by more than a frame (a stalled page): start the grid again from now.
          nextFrame = now - nextFrame > this.timings.frame ? now + this.timings.frame : nextFrame + this.timings.frame;
          this.#sendFrames(r, heist, now);
        }
        if (now - lastSnap >= this.timings.snapshot || result) {
          lastSnap = now;
          party.screen.set({ pub: heist.publicLayer() as unknown as Json });
        }
        if (result) return finish(result);
        this.#tick = setTimeout(tick, Math.max(0, t0 + (steps + 1) * every - Date.now()));
      };
      this.#tick = setTimeout(tick, Math.max(1, this.timings.step));
    });
  }

  #endHeist: ((v: HeistResult | null) => void) | null = null;

  #stopHeist(): void {
    clearTimeout(this.#tick);
    this.#tick = undefined;
    this.#endHeist = null;
  }

  /** Every phone in the heist its own frame; the screens the public delta (keyframes on the 5 s beat, after a gap, on joining). */
  #sendFrames(r: Round, heist: Heist, now: number): void {
    const party = this.party;
    const pub = heist.publicDelta();
    let keyframe: PublicDelta | null = null;
    const key = () => (keyframe ??= heist.publicKey());
    for (const id of r.cast) {
      const p = party.player(id);
      if (!p?.connected) continue;
      const k = this.#keyFor.has(id) || now - (this.#lastKey.get(id) ?? -Infinity) >= this.timings.keyframe;
      if (k) {
        this.#keyFor.delete(id);
        this.#lastKey.set(id, now);
      }
      const frame: Frame | null = heist.frame(id, k ? key() : pub);
      if (frame) party.send(p, "f", frame);
    }
    const k = this.#screenKey || now - this.#screenLastKey >= this.timings.keyframe;
    if (k) {
      this.#screenKey = false;
      this.#screenLastKey = now;
    }
    const out = k ? key() : pub;
    party.broadcast("pub", out, "screen");
    party.broadcast("pub", out, "watch");
  }

  /** `h`: a heist action from a phone. */
  #act(d: Json, from: Sender, info?: ActionInfo): null {
    const r = this.#round;
    const heist = r?.heist;
    if (from.role !== "player") throw refusal("role");
    if (!r || !heist || this.#phase !== "heist" || heist.result || !r.cast.includes(from.id)) throw refusal("over");
    const a: Action | null = parseAction(d);
    if (!a) throw refusal("invalid");
    // how old the action is (the phone's lag): widens the hold's window (§5, §15)
    const age = info && Number.isFinite(info.sentAt) ? Math.max(0, (this.party.now() - info.sentAt) / 1000) : undefined;
    const why = heist.act(from.id, a, age === undefined ? undefined : { age });
    if (why) throw refusal(why);
    return null;
  }

  /** A phone went away or came back: the heist knows (a guard stands still; a thief away too long ends it). */
  #awayChanged(p: Player, away: boolean): void {
    const r = this.#round;
    const heist = r?.heist;
    if (!r || !heist || !r.cast.includes(p.id) || this.#phase !== "heist") return;
    heist.setAway(p.id, away);
  }

  #left(p: Player): void {
    this.#colors.delete(p.id);
    this.#colorsChanged();
    this.#queue = this.#queue.filter((id) => id !== p.id);
    const r = this.#round;
    if (this.#running) this.#set({});
    if (!r?.heist || !r.cast.includes(p.id)) return;
    if (this.#phase === "briefing" || this.#phase === "heist") r.heist.leave(p.id);
    if (this.#phase === "briefing" && p.id === r.thief) this.#skip?.();
    // Too few left for the game: the heist stops at once (no score) and the game ends.
    if (this.#phase === "heist" && p.id !== r.thief && this.party.players.length < this.minPlayers) this.#endHeist?.(null);
  }
}

/** A refusal as a PartyError: the Refusal id as the code, the English words as the message. */
export function refusal(why: Refusal): PartyError {
  const en = words("en").refusals;
  const msg = (REFUSALS as readonly string[]).includes(why) ? en[why as RefusalId] : (REFUSAL_WORDS[why] ?? why);
  return new PartyError(why, msg);
}

/** A view as the party's JSON. */
function json(v: object): Record<string, Json> {
  return v as unknown as Record<string, Json>;
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
