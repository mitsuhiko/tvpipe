/**
 * Drawbluff on a party, for 3 to 50 players (docs/drawbluff-scale.md):
 * the lobby, then per round everyone draws their prompt, a gallery shows
 * the drawings that do not get the stage, and per spotlight drawing its
 * liars write fake titles, the others vote, the truth is revealed;
 * scores; the final podium. The host is the only authority: phones and
 * screens only ever get views (docs/party-design.md §5).
 *
 * Views:
 * - `party.room` (every phone): `{ phase, lang, round, rounds, players, spot?, spots?, deadline?, drawing?, artist?, minPlayers?,
 *   undo, colorMode, adult, animate, adultOk, langs, timers, lateJoin?, colors, taken }` (the settings, the languages
 *   with prompts, the timers' choice, the colours to pick and how many have each)
 * - `player.state` (one phone): `{ task, score, rank, of, color, palette, … }`, `task` one of
 *   `lobby`, `wait` (a late joiner), `draw` (`prompt`, `palette`, `undo`, `frames`, `deadline`, `done`),
 *   `lie` (`key`, `drawing`, `artist`, `liars`, `early`, `deadline`, `done`, `lie`),
 *   `artist` (`key`), `vote` (`key`, `options`, `deadline`, `done`, `choice`),
 *   `watch` (`note`; `result` with `note: "result"`, after the TV showed the truth), `scores`/`final`
 * - `party.screen` (the TV): `{ phase, lang, colors, … }` per phase, see each method;
 *   `colors` every player's colour by id. While drawing `ink` (how much
 *   each one drew, from the phones' continuous input `{ ink }`), while
 *   liars write `typing` (who typed lately, from `{ typing: true }`).
 *
 * `lang` is the room's language (`en`, `de`): the prompts, the decoys,
 * and what every phone and TV says (each page has its strings).
 *
 * Every player has a colour (`PLAYER_COLORS`, picked in the lobby, else
 * the least used) and draws with pens made from it (`palette`): its dark
 * and light shade, or with `colorMode` black and four colours leaning to
 * it. The settings (the host page's, or the VIP's in the lobby and on the
 * final screen, action `settings`; `late-join` for latecomers): the
 * `lang`, the `rounds` (1 to `MAX_ROUNDS`), the `timers` (`TIMERS`), `undo`
 * on the pad (off: every stroke counts), `colorMode`, `adult` (the
 * adult prompts, where the language has them), `animate` (every drawing
 * is an animation of `FRAMES` frames that the pages flip through, with
 * the longer `drawAnimated` time to draw).
 */

import { Emitter, LATE_JOIN, PartyError, type Json, type LateJoin, type Party, type Player } from "@tvpipe/party";

import {
  buildOptions,
  cleanTitle,
  decoyOrder,
  displayTitle,
  FRAMES,
  framesOf,
  palette,
  PLAYER_COLORS,
  playerColors,
  deal,
  PHONE_LIES,
  pickLiars,
  plan,
  POINTS,
  PromptDeck,
  revealOrder,
  rotate,
  score,
  share,
  shuffle,
  spread,
  titleKey,
  validateDrawing,
  type Drawing,
  type Lang,
  type Option,
  type Plan,
  type Prompt,
} from "./rules.ts";

export interface Timings {
  draw: number;
  /** Drawing an animation (the `animate` setting): two frames. */
  drawAnimated: number;
  lie: number;
  vote: number;
  /** Between two reveal steps. */
  revealStep: number;
  /** After the truth. */
  revealEnd: number;
  scores: number;
  /** One page of the gallery. */
  gallery: number;
}

export const DEFAULT_TIMINGS: Timings = {
  draw: 90_000,
  drawAnimated: 135_000,
  lie: 50_000,
  vote: 25_000,
  revealStep: 2600,
  revealEnd: 4500,
  scores: 9000,
  gallery: 5000,
};

export const FAST_TIMINGS: Timings = {
  draw: 25_000,
  drawAnimated: 35_000,
  lie: 25_000,
  vote: 15_000,
  revealStep: 1500,
  revealEnd: 2500,
  scores: 4000,
  gallery: 3000,
};

export const SLOW_TIMINGS: Timings = {
  draw: 135_000,
  drawAnimated: 200_000,
  lie: 75_000,
  vote: 40_000,
  revealStep: 3200,
  revealEnd: 6000,
  scores: 12_000,
  gallery: 7000,
};

/** The timers setting's choices (the host page's and the VIP's). */
export const TIMERS = { fast: FAST_TIMINGS, normal: DEFAULT_TIMINGS, slow: SLOW_TIMINGS } as const;
export type TimerChoice = keyof typeof TIMERS;
export const TIMER_CHOICES = Object.keys(TIMERS) as TimerChoice[];

/** Newcomers the TV names ("+ Anna"); more: a count. */
export const JOINED_NAMES = 3;

/** Drawings per gallery page on the TV. */
export const GALLERY_PAGE = 8;
/** Lines of the score table on the TV. */
export const BOARD_LINES = 8;
/** Voter names a reveal line lists (more: a count). */
export const REVEAL_NAMES = 6;
/** Voter ids a reveal line carries (the TV's dots; more: a count). */
export const REVEAL_IDS = 12;
/** The TV's `ink` and `typing` at most this often, ms. */
export const INK_EVERY = 500;
export const TYPING_EVERY = 1000;
/** A liar counts as typing this long after their last keystroke, ms. */
export const TYPING_FOR = 3000;
/** The most `ink` a phone can report (a full pad of strokes is far less). */
export const MAX_INK = 1_000_000;
/** The most rounds a game can have (the host page's or the VIP's choice, from 1). */
export const MAX_ROUNDS = 5;

export interface GameOptions {
  rounds?: number | undefined;
  minPlayers?: number | undefined;
  timings?: Partial<Timings> | undefined;
  rng?: (() => number) | undefined;
  /**
   * The prompts (`data/prompts.txt` through `parsePrompts`; plain strings
   * have no structure): for `lang`, or per language.
   */
  prompts: readonly (string | Prompt)[] | Partial<Record<Lang, readonly (string | Prompt)[]>>;
  /** The room's language (default `en`; the host page's setting, see {@link Drawbluff.configure}). */
  lang?: Lang | undefined;
  /**
   * Who may join during a game (the VIP can change it in the lobby):
   * `wait` (the default) from the next round, `open` from the next
   * drawing, `closed` not at all (docs/drawbluff-scale.md §9).
   */
  lateJoin?: LateJoin | undefined;
  /** The adult prompts (`data/prompts.adult.txt`, …), per language: dealt instead when `adult` is on. */
  adultPrompts?: Partial<Record<Lang, readonly (string | Prompt)[]>> | undefined;
  /** Undo on the drawing pad (default off: every stroke counts). */
  undo?: boolean | undefined;
  /** Black and four colours leaning to the player's colour instead of its two shades (default off). */
  colorMode?: boolean | undefined;
  /** The adult prompts (default off). */
  adult?: boolean | undefined;
  /** Animated drawings: every player draws `FRAMES` frames that flip (default off). */
  animate?: boolean | undefined;
}

/** The room's settings: the host page's, or the VIP's in the lobby. */
export interface Settings {
  undo: boolean;
  colorMode: boolean;
  adult: boolean;
  animate: boolean;
}

export interface ScoreLine {
  id: string;
  name: string;
  score: number;
  delta: number;
}

export interface GameEvents {
  phase: [phase: string];
  end: [scores: ScoreLine[]];
  /** The settings, the rounds, the timers, the language or the latecomers changed (the host page's or the VIP's). */
  settings: [settings: Settings];
}

/** What the game itself names, per language (the pages have their own strings). */
const SOMEONE: Record<Lang, string> = { en: "someone", de: "jemand" };

export type Phase = "lobby" | "draw" | "gallery" | "lie" | "vote" | "reveal" | "scores" | "final";

/** One drawing of the round. */
interface Entry {
  artist: Player;
  prompt: string;
  /** The prompt's structure. */
  tag: string;
  /** The prompt's decoys (`data/prompts.txt`). */
  decoys: readonly string[];
  drawing: Drawing;
}

/** A spotlight's liars at work (maybe while the TV shows something else). */
interface Lies {
  spot: Entry;
  /** `round.spot`, the phones' key for the task. */
  key: string;
  liars: Player[];
  deadline: number;
  answers: Map<Player, string>;
  finished: boolean;
  done: Promise<Map<Player, string>>;
  abort: AbortController;
}

/** What one player did this round (the highlights). */
interface Tally {
  fooled: number;
  found: number;
  votes: number;
}

export class Drawbluff extends Emitter<GameEvents> {
  readonly party: Party;
  rounds: number;
  readonly minPlayers: number;
  timings: Timings;
  readonly #rng: () => number;
  /** The prompts per language. */
  readonly #prompts = new Map<Lang, readonly Prompt[]>();
  /** The adult prompts per language. */
  readonly #adultPrompts = new Map<Lang, readonly Prompt[]>();
  /** The room's decks per language (`en`, `en:adult`, …), kept from game to game (no prompt twice until all were dealt). */
  readonly #decks = new Map<string, PromptDeck>();
  #lang: Lang;
  #settings: Settings;
  /** Each player's colour (an index of `PLAYER_COLORS`), by id. */
  readonly #colors = new Map<string, number>();
  /** Points per player id (players in the game; late joiners from their first round). */
  readonly scores = new Map<string, number>();
  /** Lies written so far this game, per player id (rotation). */
  readonly #lied = new Map<string, number>();
  /** Spotlights so far this game, per player id (rotation). */
  readonly #spotted = new Map<string, number>();
  #tally = new Map<string, Tally>();
  #phase: Phase = "lobby";
  #running = false;
  /** The game's: aborted by {@link close} (each game has its own). */
  #abort = new AbortController();
  /** Counts games and closes: a game whose number moved on was closed. */
  #gen = 0;
  /** A game's flow until it returned (a closed one winds down at once, writing nothing). */
  #flow: Promise<void> | undefined;
  /** This game's deck (the room's, in the game's language). */
  #deck!: PromptDeck;
  #round = 0;
  /** The lies whose progress the TV shows (`liars`/`done` on the screen). */
  #onScreen: Lies | undefined;
  /** Dealt in during a round without a drawing of their own: first in the next round's spotlights. */
  readonly #fresh = new Set<string>();
  /** Names of this round's newcomers, oldest first (the TV's "+ Anna"). */
  #joined: string[] = [];
  /** Spotlights of this round whose vote has not started (a newcomer in `open` mode can still vote). */
  #votesLeft = 0;
  /** While drawing: how much each drawer drew (their phone's `ink`), and the TV's update to come. */
  #ink: Map<string, number> | undefined;
  #inkTimer: ReturnType<typeof setTimeout> | undefined;
  /** Liars' last keystrokes (their phone's `typing`), by id. */
  readonly #typed = new Map<string, number>();
  /** Updates the TV's `typing` now unless it just did (while liars are on screen). */
  #pokeTyping: (() => void) | undefined;

  constructor(party: Party, options: GameOptions) {
    super();
    this.party = party;
    this.rounds = Math.max(1, Math.min(MAX_ROUNDS, Math.round(options.rounds ?? 2)));
    this.minPlayers = options.minPlayers ?? 3;
    this.timings = { ...DEFAULT_TIMINGS, ...options.timings };
    this.#rng = options.rng ?? Math.random;
    this.#lang = options.lang ?? "en";
    const lists: Partial<Record<Lang, readonly (string | Prompt)[]>> = Array.isArray(options.prompts)
      ? { [this.#lang]: options.prompts }
      : (options.prompts as Partial<Record<Lang, readonly (string | Prompt)[]>>);
    const load = (to: Map<Lang, readonly Prompt[]>, from: Partial<Record<Lang, readonly (string | Prompt)[]>>) => {
      for (const [lang, list] of Object.entries(from) as [Lang, readonly (string | Prompt)[]][]) {
        if (list.length > 0) to.set(lang, list.map((p) => (typeof p === "string" ? { text: p, tag: "" } : p)));
      }
    };
    load(this.#prompts, lists);
    load(this.#adultPrompts, options.adultPrompts ?? {});
    if (!this.#prompts.has(this.#lang)) throw new Error(`drawbluff: no prompts in ${this.#lang}`);
    if (options.lateJoin !== undefined) party.lateJoin = options.lateJoin;
    this.#settings = {
      undo: options.undo ?? false,
      colorMode: options.colorMode ?? false,
      adult: (options.adult ?? false) && this.#adultPrompts.has(this.#lang),
      animate: options.animate ?? false,
    };
  }

  /** The room's settings. */
  get settings(): Settings {
    return { ...this.#settings };
  }

  /** Whether the room's language has adult prompts. */
  get adultOk(): boolean {
    return this.#adultPrompts.has(this.#lang);
  }

  /** A player's colour (an index of `PLAYER_COLORS`). */
  colorOf(p: Player): number {
    return this.#colors.get(p.id) ?? 0;
  }

  get phase(): Phase {
    return this.#phase;
  }

  get running(): boolean {
    return this.#running;
  }

  /** The room's language. */
  get lang(): Lang {
    return this.#lang;
  }

  /** The languages there are prompts for. */
  get langs(): Lang[] {
    return [...this.#prompts.keys()];
  }

  /** The timers' choice the timings are (other timings, a test's: `normal`). */
  get timers(): TimerChoice {
    return TIMER_CHOICES.find((k) => (Object.keys(TIMERS[k]) as (keyof Timings)[]).every((t) => this.timings[t] === TIMERS[k][t])) ?? "normal";
  }

  /** Shows the lobby and waits for the VIP to start. */
  open(): void {
    const party = this.party;
    party.handle("start", (_d, from) => {
      if (from.role !== "player" || !from.vip) throw new PartyError("not-vip", "Only the VIP can start");
      if (this.#running) throw new PartyError("running", "The game is on");
      const ready = party.connectedPlayers.length;
      if (ready < this.minPlayers) {
        throw new PartyError("too-few", `Wait for ${this.minPlayers - ready} more player${this.minPlayers - ready === 1 ? "" : "s"}`);
      }
      void this.play();
      return null;
    });
    party.handle("kick", (d, from) => {
      if (from.role !== "player" || !from.vip) throw new PartyError("not-vip", "Only the VIP can remove players");
      if (this.#running) throw new PartyError("running", "Not during a game");
      const id = typeof d === "object" && d !== null && "id" in d ? (d as { id: unknown }).id : undefined;
      const p = typeof id === "string" ? party.player(id) : undefined;
      if (!p || p === from) throw new PartyError("no-player", "No such player");
      party.kick(p);
      return null;
    });
    party.handle("settings", (d, from) => {
      if (from.role !== "player" || !from.vip) throw new PartyError("not-vip", "Only the VIP can change this");
      if (typeof d !== "object" || d === null || Array.isArray(d)) throw new PartyError("bad-settings", "lang, rounds, timers, undo, colorMode, adult, animate");
      const v = d as Record<string, Json>;
      for (const k of Object.keys(v)) if (!["lang", "rounds", "timers", "undo", "colorMode", "adult", "animate"].includes(k)) throw new PartyError("bad-settings", `${k}: not a setting`);
      const o: Partial<Settings> & { rounds?: number; lang?: Lang; timings?: Timings } = {};
      if (v["lang"] !== undefined) {
        if (typeof v["lang"] !== "string" || !this.langs.includes(v["lang"] as Lang)) throw new PartyError("bad-settings", `lang: ${this.langs.join(", ")}`);
        o.lang = v["lang"] as Lang;
      }
      const rounds = v["rounds"];
      if (rounds !== undefined) {
        if (typeof rounds !== "number" || !Number.isInteger(rounds) || rounds < 1 || rounds > MAX_ROUNDS) throw new PartyError("bad-settings", `rounds: 1 to ${MAX_ROUNDS}`);
        o.rounds = rounds;
      }
      if (v["timers"] !== undefined) {
        if (typeof v["timers"] !== "string" || !TIMER_CHOICES.includes(v["timers"] as TimerChoice)) throw new PartyError("bad-settings", `timers: ${TIMER_CHOICES.join(", ")}`);
        o.timings = TIMERS[v["timers"] as TimerChoice];
      }
      for (const k of ["undo", "colorMode", "adult", "animate"] as const) {
        const x = v[k];
        if (x === undefined) continue;
        if (typeof x !== "boolean") throw new PartyError("bad-settings", `${k}: true or false`);
        o[k] = x;
      }
      this.configure(o);
      return null;
    });
    party.handle("color", (d, from) => {
      if (from.role !== "player") throw new PartyError("not-player", "Only players have a colour");
      // Not while you play: your pens are dealt with your prompt.
      if (this.#running && this.scores.has(from.id) && !from.waiting) throw new PartyError("running", "Not during a game");
      const c = typeof d === "object" && d !== null && "color" in d ? (d as { color: unknown }).color : d;
      if (typeof c !== "number" || !Number.isInteger(c) || c < 0 || c >= PLAYER_COLORS.length) throw new PartyError("bad-color", "No such colour");
      const used = this.#taken();
      // Your own, or a free one; shared only when none is free.
      if (c !== this.#colors.get(from.id) && used[c]! > 0 && used.some((n) => n === 0)) throw new PartyError("color-taken", "Someone has that colour");
      this.#setColor(from, c);
      return null;
    });
    party.handle("late-join", (d, from) => {
      if (from.role !== "player" || !from.vip) throw new PartyError("not-vip", "Only the VIP can change this");
      if (this.#running) throw new PartyError("running", "Not during a game");
      const mode = typeof d === "object" && d !== null && "mode" in d ? (d as { mode: unknown }).mode : d;
      if (typeof mode !== "string" || !LATE_JOIN.includes(mode as LateJoin)) throw new PartyError("bad-mode", "closed, wait or open");
      const was = party.lateJoin;
      party.lateJoin = mode as LateJoin;
      party.room.set({ lateJoin: mode });
      // The host page shows it too.
      if (mode !== was) this.emit("settings", this.settings);
      return null;
    });
    // Joiners in the lobby (or after the game) see the lobby; during a
    // game they wait (the party marks them waiting) until they are dealt
    // in: at the next round, or with `open` at the next drawing.
    party.on("join", (p) => {
      this.#setColor(p, this.#freeColor(), false);
      this.#colorsChanged();
      if (!this.#running) {
        p.state.replace(this.#lobbyState(p));
        return;
      }
      p.state.replace(this.#waitState(p));
      this.#joined.push(p.name);
      party.screen.set(this.#joinedView());
    });
    party.on("leave", (p) => {
      this.#colors.delete(p.id);
      this.#colorsChanged();
    });
    party.on("input", (p, data) => this.#input(p, data));
    this.#lobby();
  }

  /** How many players have each colour. */
  #taken(): number[] {
    const n = PLAYER_COLORS.map(() => 0);
    for (const p of this.party.players) {
      const c = this.#colors.get(p.id);
      if (c !== undefined) n[c]!++;
    }
    return n;
  }

  /** A newcomer's colour: one of the least used. */
  #freeColor(): number {
    const used = this.#taken();
    const least = Math.min(...used);
    const free = used.flatMap((n, i) => (n === least ? [i] : []));
    return free[Math.floor(this.#rng() * free.length)]!;
  }

  #setColor(p: Player, c: number, show = true): void {
    this.#colors.set(p.id, c);
    if (!show) return;
    p.state.set({ color: c, palette: palette(c, this.#settings.colorMode) });
    this.#colorsChanged();
  }

  /** The colours to pick and how many have each (in the room), the players' (on the TV's lobby). */
  #colorsChanged(): void {
    this.party.room.set({ taken: this.#taken() });
    this.party.screen.set({ colors: this.#screenColors() });
  }

  /**
   * A phone's continuous input: `{ ink }` while drawing (the TV's
   * progress), `{ typing: true }` while lying. Anything else is ignored.
   */
  #input(p: Player, data: Json): void {
    if (typeof data !== "object" || data === null || Array.isArray(data)) return;
    const ink = data["ink"];
    if (this.#ink && this.#ink.has(p.id) && typeof ink === "number" && Number.isFinite(ink)) {
      this.#ink.set(p.id, Math.round(Math.min(MAX_INK, Math.max(0, ink))));
      this.#inkTimer ??= setTimeout(() => {
        this.#inkTimer = undefined;
        if (this.#ink && this.#phase === "draw") this.party.screen.set({ ink: Object.fromEntries(this.#ink) });
      }, INK_EVERY);
    }
    if (data["typing"] === true) {
      this.#typed.set(p.id, Date.now());
      this.#pokeTyping?.();
    }
  }

  /** The liars of `lies` who typed lately (and are not done). */
  #typing(lies: Lies | undefined): string[] {
    if (!lies) return [];
    const now = Date.now();
    return lies.liars.filter((l) => !lies.answers.has(l) && now - (this.#typed.get(l.id) ?? -Infinity) < TYPING_FOR).map((l) => l.id);
  }

  /** Keeps the TV's `typing` current while `lies` are on screen; call the result to stop. */
  #watchTyping(lies: Lies | undefined): () => void {
    if (!lies) return () => {};
    let last = "[]";
    let at = 0;
    const update = () => {
      if (this.#onScreen !== lies) return;
      const now = JSON.stringify(this.#typing(lies));
      if (now === last) return;
      last = now;
      at = Date.now();
      this.party.screen.set({ typing: JSON.parse(now) as string[] });
    };
    const timer = setInterval(update, TYPING_EVERY);
    const poke = () => {
      if (Date.now() - at >= TYPING_EVERY) update();
    };
    this.#pokeTyping = poke;
    return () => {
      clearInterval(timer);
      if (this.#pokeTyping === poke) this.#pokeTyping = undefined;
    };
  }

  #colorView(): { colors: string[]; taken: number[] } {
    return { colors: playerColors(), taken: this.#taken() };
  }

  #screenColors(): Record<string, string> {
    const all = playerColors();
    return Object.fromEntries(this.party.players.map((p) => [p.id, all[this.colorOf(p)]!]));
  }

  /** A player's colour and pens (their view). */
  #pens(p: Player): { color: number; palette: string[] } {
    return { color: this.colorOf(p), palette: palette(this.colorOf(p), this.#settings.colorMode) };
  }

  /** The room's settings for the phones: the VIP's buttons and everybody's lines. */
  #settingsView(): Record<string, Json> {
    return { ...this.#settings, adultOk: this.adultOk, lang: this.#lang, langs: this.langs, timers: this.timers };
  }

  /**
   * Changes the rounds, the timers, the language or the settings before
   * a game (the lobby shows the rounds and the settings; every phone and
   * TV follows the language). Adult prompts only where the language has
   * them: switching to a language without turns `adult` off.
   */
  configure(
    o: { rounds?: number | undefined; timings?: Partial<Timings> | undefined; lang?: Lang | undefined } & { [K in keyof Settings]?: Settings[K] | undefined },
  ): void {
    if (this.#running) throw new PartyError("running", "Not during a game");
    if (o.lang !== undefined && !this.#prompts.has(o.lang)) throw new PartyError("bad-lang", `No prompts in ${o.lang}`);
    const lang = o.lang ?? this.#lang;
    if (o.adult === true && !this.#adultPrompts.has(lang)) throw new PartyError("no-adult", `No adult prompts in ${lang}`);
    const was = JSON.stringify([this.#lang, this.rounds, this.timings, this.#settings]);
    if (o.rounds !== undefined) this.rounds = Math.max(1, Math.min(MAX_ROUNDS, Math.round(o.rounds)));
    if (o.timings) this.timings = { ...DEFAULT_TIMINGS, ...o.timings };
    if (o.lang !== undefined && o.lang !== this.#lang) {
      this.#lang = o.lang;
      this.party.room.set({ lang: o.lang });
      this.party.screen.set({ lang: o.lang });
    }
    const colorMode = this.#settings.colorMode;
    if (o.undo !== undefined) this.#settings.undo = o.undo;
    if (o.colorMode !== undefined) this.#settings.colorMode = o.colorMode;
    if (o.adult !== undefined) this.#settings.adult = o.adult;
    if (o.animate !== undefined) this.#settings.animate = o.animate;
    if (!this.#adultPrompts.has(this.#lang)) this.#settings.adult = false;
    if (this.#settings.colorMode !== colorMode) for (const p of this.party.players) p.state.set(this.#pens(p));
    this.party.room.set(this.#settingsView());
    // Between games (the lobby, the final screen) the rules for the next one.
    if (this.#phase === "lobby" || this.#phase === "final") {
      this.party.room.set({ rounds: this.rounds });
      this.party.screen.set({ ...this.#settings, rounds: this.rounds });
    }
    if (JSON.stringify([this.#lang, this.rounds, this.timings, this.#settings]) !== was) this.emit("settings", this.settings);
  }

  /**
   * Ends the game and its timers (the party stays): back to the lobby
   * at once (no final screen, closing is not finishing), the waiting
   * players in, so the VIP or the host can start again. Nothing of the
   * closed game writes to the party after this returns.
   */
  close(): void {
    this.#gen++;
    this.#abort.abort();
    clearTimeout(this.#inkTimer);
    this.#inkTimer = undefined;
    this.#ink = undefined;
    this.#onScreen = undefined;
    this.#pokeTyping = undefined;
    if (!this.#running && this.#phase === "lobby") return;
    this.#running = false;
    this.party.inProgress = false;
    for (const p of this.party.players) this.party.activate(p);
    this.#joined = [];
    this.#lobby();
  }

  #setPhase(phase: Phase): void {
    this.#phase = phase;
    this.emit("phase", phase);
  }

  #lobbyState(p: Player): Record<string, unknown> {
    return { task: this.#phase === "final" ? "final" : "lobby", ...this.#rank(this.scores.has(p.id) ? p : undefined), ...this.#pens(p) };
  }

  /** A waiting player's task: when they get in (`note`: `drawing`, `round` or `game`). */
  #waitState(p: Player): Record<string, unknown> {
    const open = this.party.lateJoin === "open" && (this.#phase === "draw" || this.#votesLeft > 0);
    const note = open ? "drawing" : this.#round < this.rounds ? "round" : "game";
    return { task: "wait", note, ...this.#rank(p), ...this.#pens(p) };
  }

  /** The TV's newcomers: `joined` (the last few names), `joinedMore` (how many others). */
  #joinedView(): { joined: string[]; joinedMore: number } {
    return { joined: this.#joined.slice(-JOINED_NAMES), joinedMore: Math.max(0, this.#joined.length - JOINED_NAMES) };
  }

  /** The TV's view of a phase, with the newcomers. */
  #screen(fields: Record<string, unknown>): void {
    this.party.screen.replace({ ...fields, lang: this.#lang, colors: this.#screenColors(), ...this.#joinedView() });
  }

  /**
   * Deals waiting players in (`open`: at a spotlight's lies and vote;
   * every mode: at a round's drawing): in the game from now on, their
   * lies counted as the fewest so far (so they join the rotation).
   */
  #dealIn(midRound: boolean): void {
    const party = this.party;
    const waiting = party.players.filter((p) => p.waiting);
    if (waiting.length === 0) return;
    const lied = this.#inGame().map((p) => this.#lied.get(p.id) ?? 0);
    const least = lied.length > 0 ? Math.min(...lied) : 0;
    for (const p of waiting) {
      party.activate(p);
      if (this.scores.has(p.id)) continue;
      this.scores.set(p.id, 0);
      this.#lied.set(p.id, least);
      if (midRound) this.#fresh.add(p.id);
    }
  }

  #lobby(): void {
    const p = this.party;
    this.#setPhase("lobby");
    p.room.replace({
      phase: "lobby",
      lang: this.#lang,
      minPlayers: this.minPlayers,
      maxPlayers: p.maxPlayers,
      rounds: this.rounds,
      lateJoin: p.lateJoin,
      ...this.#settingsView(),
      ...this.#colorView(),
    });
    p.screen.replace({
      phase: "lobby",
      lang: this.#lang,
      minPlayers: this.minPlayers,
      maxPlayers: p.maxPlayers,
      rounds: this.rounds,
      ...this.#settings,
      colors: this.#screenColors(),
    });
    for (const pl of p.players) pl.state.replace({ task: "lobby", ...this.#pens(pl) });
  }

  /**
   * Plays a whole game with the players who are there (and those who
   * join). It ends early, to the final screen, when a round would start
   * with fewer than `minPlayers` (players who left or were removed do not
   * count, an away phone does). Closed ({@link close}): it returns the
   * scores so far and writes nothing.
   */
  async play(): Promise<ScoreLine[]> {
    const party = this.party;
    const gen = ++this.#gen;
    this.#running = true;
    party.inProgress = true;
    // A closed game's flow winds down first (its signal is aborted until it did).
    if (this.#flow) await this.#flow;
    if (gen !== this.#gen) return this.#table();
    let ended!: () => void;
    this.#flow = new Promise((r) => (ended = r));
    this.#abort = new AbortController();
    try {
      this.scores.clear();
      this.#lied.clear();
      this.#spotted.clear();
      this.#fresh.clear();
      this.#typed.clear();
      const adult = this.#settings.adult && this.#adultPrompts.has(this.#lang);
      const deckKey = adult ? `${this.#lang}:adult` : this.#lang;
      let deck = this.#decks.get(deckKey);
      if (!deck) this.#decks.set(deckKey, (deck = new PromptDeck((adult ? this.#adultPrompts : this.#prompts).get(this.#lang)!, this.#rng)));
      this.#deck = deck;
      for (let round = 1; round <= this.rounds; round++) {
        if (this.#abort.signal.aborted) break;
        this.#round = round;
        this.#joined = [];
        this.#votesLeft = 0;
        // Everybody in the room plays this round, late joiners too.
        this.#dealIn(false);
        for (const p of party.players) if (!this.scores.has(p.id)) this.scores.set(p.id, 0);
        const players = this.#inGame();
        // Too few left: the game ends here.
        if (players.length < this.minPlayers) break;
        const before = new Map(this.scores);
        this.#tally = new Map();
        const entries = await this.#draw(round, players);
        if (this.#abort.signal.aborted) break;
        await this.#spotlights(round, players.length, entries);
        if (this.#abort.signal.aborted) break;
        await this.#scores(round, before);
      }
      if (gen !== this.#gen) return this.#table();
      return this.#final();
    } finally {
      this.#flow = undefined;
      ended();
      // Closed: close() did this (and a next game may run).
      if (gen === this.#gen) {
        this.#running = false;
        party.inProgress = false;
        for (const p of party.players) party.activate(p);
      }
    }
  }

  // -------------------------------------------------------------------------

  /** Players of this game still in the room, in join order. */
  #inGame(): Player[] {
    return this.party.players.filter((p) => this.scores.has(p.id));
  }

  /**
   * A deadline `ms` after the phase shows on the TV (and with
   * {@link #withTv} on the phones): everybody gets the whole time.
   */
  #deadline(ms: number): number {
    return this.party.now() + (this.party.tvDelay ?? 0) + ms;
  }

  /**
   * What the TV shows (a phase, a reveal step): phones and watchers get
   * it when the TV picture with it is up (`party.withTv`; a tvpipe
   * before 0.3.1 has no `withTv` and sends it at once).
   */
  #withTv(fn: () => void): void {
    if (typeof this.party.withTv === "function") this.party.withTv(fn);
    else fn();
  }

  #room(fields: Record<string, unknown>): void {
    this.party.room.replace({ lang: this.#lang, round: this.#round, rounds: this.rounds, players: this.#inGame().length, ...this.#settingsView(), ...this.#colorView(), ...fields });
  }

  async #draw(round: number, players: Player[]): Promise<Entry[]> {
    const party = this.party;
    this.#setPhase("draw");
    const hand = this.#deck.deal(players.length);
    const prompts = new Map(players.map((p, i) => [p, hand[i]!]));
    // Everyone's pens as dealt (a drawing carries its artist's).
    const pens = new Map(players.map((p) => [p, this.#pens(p).palette]));
    const animate = this.#settings.animate;
    const frames = animate ? FRAMES : 1;
    const deadline = this.#deadline(animate ? this.timings.drawAnimated : this.timings.draw);
    const undo = this.#settings.undo;
    this.#ink = new Map(players.map((p) => [p.id, 0]));
    this.#withTv(() => {
      this.#room({ phase: "draw", deadline });
      this.#screen({ phase: "draw", round, rounds: this.rounds, deadline, animate, waiting: players.map((p) => p.id), done: [], ink: {} });
      for (const [p, prompt] of prompts) {
        p.state.replace({ task: "draw", prompt: displayTitle(prompt.text), undo, frames, deadline, done: false, ...this.#rank(p), ...this.#pens(p) });
      }
      for (const p of party.players) if (!prompts.has(p)) p.state.replace(this.#waitState(p));
    });
    const got = await party.collect<Drawing>("draw", {
      from: players,
      until: deadline,
      validate: (d, p) => {
        const palette = pens.get(p) ?? this.#pens(p).palette;
        return { ...validateDrawing(d, palette.length, frames), palette };
      },
      signal: this.#abort.signal,
      onAnswer: (p, _v, answers) => {
        p.state.set({ done: true });
        party.screen.set({ done: [...answers.keys()].map((x) => x.id) });
      },
    });
    this.#ink = undefined;
    return [...got].map(([artist, drawing]) => {
      const { text, tag, decoys } = prompts.get(artist)!;
      return { artist, prompt: text, tag, decoys: decoys ?? [], drawing };
    });
  }

  /** The round's spotlights (and the gallery of the other drawings). */
  async #spotlights(round: number, n: number, entries: Entry[]): Promise<void> {
    const party = this.party;
    const p = plan(n);
    const live = entries.filter((e) => party.players.includes(e.artist));
    const ids = live.map((e) => e.artist.id);
    const byId = new Map(live.map((e) => [e.artist.id, e]));
    // Newcomers of the last round first, then the fewest spotlights,
    // then connected artists, then drawings with strokes.
    const key = (id: string) => {
      const e = byId.get(id)!;
      return 4 * (this.#spotted.get(id) ?? 0) - (this.#fresh.has(id) ? 4 : 0) + (e.artist.connected ? 0 : 2) + (framesOf(e.drawing).every((f) => f.length === 0) ? 1 : 0);
    };
    const chosen = rotate(ids, key, p.spotlights, this.#rng);
    this.#fresh.clear();
    this.#votesLeft = chosen.length;
    // Spotlights in a row mix the structures too.
    const spots = spread(
      chosen.map((id) => byId.get(id)!),
      (e) => e.tag,
    );
    for (const s of spots) this.#spotted.set(s.artist.id, (this.#spotted.get(s.artist.id) ?? 0) + 1);
    const gallery = live.filter((e) => !chosen.includes(e.artist.id));
    // The first spotlight's liars start now (during the gallery, if any).
    let next = spots[0] ? this.#startLies(round, 0, spots[0], p, [], undefined, gallery.length > 0) : undefined;
    if (gallery.length > 0) await this.#gallery(round, gallery, next);
    for (let i = 0; i < spots.length; i++) {
      if (this.#abort.signal.aborted) return;
      const spot = spots[i]!;
      if (!party.players.includes(spot.artist)) {
        next?.abort.abort();
        next = undefined;
        continue; // left the game
      }
      const lies = next && next.spot === spot ? next : this.#startLies(round, i, spot, p, [], undefined, false);
      next = undefined;
      await this.#liePhase(round, i, spots.length, lies);
      if (this.#abort.signal.aborted) return;
      const following = spots[i + 1];
      if (p.pipelined && following && party.players.includes(following.artist)) {
        next = this.#startLies(round, i + 1, following, p, lies.liars, spot.artist, true);
      }
      await this.#turn(round, i, spots.length, lies, next);
    }
  }

  /**
   * Gives a spotlight drawing to its liars: `busy` may not lie (the
   * current liars), `first` lies first if they can (the current artist);
   * `early`: the TV shows something else meanwhile.
   */
  #startLies(round: number, i: number, spot: Entry, p: Plan, busy: readonly Player[], first: Player | undefined, early: boolean): Lies {
    const party = this.party;
    if (party.lateJoin === "open") this.#dealIn(true);
    const pool = this.#inGame()
      .filter((x) => x !== spot.artist && !busy.includes(x))
      .map((x) => x.id);
    // Away players last.
    const lied = new Map(pool.map((id) => [id, (this.#lied.get(id) ?? 0) + (party.player(id)!.connected ? 0 : 1000)]));
    const firstId = first && first.connected && this.scores.has(first.id) ? first.id : undefined;
    const liars = pickLiars(pool, lied, p.liars, this.#rng, firstId).map((id) => party.player(id)!);
    for (const l of liars) this.#lied.set(l.id, (this.#lied.get(l.id) ?? 0) + 1);
    const key = `${round}.${i + 1}`;
    const deadline = this.#deadline(this.timings.lie);
    const art = { id: spot.artist.id, name: spot.artist.name };
    for (const l of liars) {
      l.state.replace({ task: "lie", key, drawing: spot.drawing, artist: art, liars: liars.length, early, deadline, done: false, ...this.#rank(l) });
    }
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    this.#abort.signal.addEventListener("abort", onAbort, { once: true });
    const answers = new Map<Player, string>();
    const lies: Lies = { spot, key, liars, deadline, answers, finished: false, done: Promise.resolve(answers), abort };
    lies.done = party
      .collect<string>("lie", {
        from: liars,
        until: deadline,
        signal: abort.signal,
        validate: (d, pl) => {
          // Kept as typed; shown and compared in the display form.
          const text = cleanTitle(typeof d === "object" && d !== null ? (d as { text?: unknown }).text : d);
          if (!displayTitle(text)) throw new PartyError("empty", "Write a title");
          if (titleKey(text, this.#lang) === titleKey(spot.prompt, this.#lang)) throw new PartyError("truth", "That's the real title! Write a lie instead.");
          if (!titleKey(text, this.#lang)) throw new PartyError("empty", "Write a title with letters");
          const ok = party.moderate(text, "lie", pl);
          if (ok === false) throw new PartyError("refused", "Try another one");
          return cleanTitle(ok);
        },
        reply: (text) => ({ text: displayTitle(text) }),
        onAnswer: (pl, text, got) => {
          answers.set(pl, text);
          pl.state.set({ done: true, lie: displayTitle(text) });
          if (this.#onScreen === lies) party.screen.set({ done: [...got.keys()].map((x) => x.id) });
        },
      })
      .then((got) => {
        lies.finished = true;
        this.#abort.signal.removeEventListener("abort", onAbort);
        return got;
      });
    return lies;
  }

  /** The gallery: the round's other drawings, a page at a time, while the first liars write. */
  async #gallery(round: number, gallery: Entry[], lies: Lies | undefined): Promise<void> {
    const party = this.party;
    this.#setPhase("gallery");
    this.#onScreen = lies;
    const pages = Math.ceil(gallery.length / GALLERY_PAGE);
    const page = (n: number) =>
      gallery.slice(n * GALLERY_PAGE, (n + 1) * GALLERY_PAGE).map((e) => ({ id: e.artist.id, name: e.artist.name, prompt: displayTitle(e.prompt), drawing: e.drawing }));
    const busy = new Set(lies?.liars ?? []);
    this.#withTv(() => {
      this.#room({ phase: "gallery", count: gallery.length });
      this.#screen({
        phase: "gallery",
        round,
        rounds: this.rounds,
        page: 1,
        pages,
        count: gallery.length,
        items: page(0),
        liars: lies?.liars.map((l) => l.id) ?? [],
        done: lies ? [...lies.answers.keys()].map((l) => l.id) : [],
        artist: lies ? { id: lies.spot.artist.id, name: lies.spot.artist.name } : null,
        typing: this.#typing(lies),
      });
      for (const p of party.players) {
        if (busy.has(p)) continue;
        const mine = gallery.findIndex((e) => e.artist === p);
        if (!this.scores.has(p.id)) p.state.replace(this.#waitState(p));
        else p.state.replace({ task: "watch", note: "gallery", mine: mine >= 0 ? Math.floor(mine / GALLERY_PAGE) + 1 : null, ...this.#rank(p) });
      }
    });
    const stop = this.#watchTyping(lies);
    try {
      for (let n = 1; n <= pages; n++) {
        if (n > 1) this.#withTv(() => party.screen.set({ page: n, items: page(n - 1) }));
        await this.#sleep(this.timings.gallery);
        if (this.#abort.signal.aborted) return;
      }
    } finally {
      stop();
    }
  }

  /** The TV's lie moment: the drawing, while its liars are still writing. */
  async #liePhase(round: number, i: number, spots: number, lies: Lies): Promise<void> {
    if (lies.finished) return;
    const party = this.party;
    const spot = lies.spot;
    this.#setPhase("lie");
    this.#onScreen = lies;
    const art = { id: spot.artist.id, name: spot.artist.name };
    const deadline = lies.deadline;
    const busy = new Set(lies.liars);
    this.#withTv(() => {
      this.#room({ phase: "lie", spot: i + 1, spots, deadline, artist: art });
      this.#screen({
        phase: "lie",
        round,
        spot: i + 1,
        spots,
        deadline,
        drawing: spot.drawing,
        artist: art,
        waiting: lies.liars.map((p) => p.id),
        done: [...lies.answers.keys()].map((p) => p.id),
        typing: this.#typing(lies),
      });
      for (const p of party.players) {
        if (busy.has(p)) continue;
        if (p === spot.artist) p.state.replace({ task: "artist", key: lies.key, ...this.#rank(p) });
        else if (!this.scores.has(p.id)) p.state.replace(this.#waitState(p));
        else p.state.replace({ task: "watch", note: "rest", artist: art, ...this.#rank(p) });
      }
    });
    const stop = this.#watchTyping(lies);
    try {
      await lies.done;
    } finally {
      stop();
    }
  }

  /** A spotlight's vote and reveal (`next`: the next drawing's liars, writing meanwhile). */
  async #turn(round: number, i: number, spots: number, lies: Lies, next: Lies | undefined): Promise<void> {
    const party = this.party;
    const spot = lies.spot;
    const artist = spot.artist;
    const art = { id: artist.id, name: artist.name };
    const lang = this.#lang;
    const truthKey = titleKey(spot.prompt, lang);
    const lied = await lies.done;
    if (this.#abort.signal.aborted) return;
    const options = buildOptions(
      spot.prompt,
      new Map([...lied].map(([p, t]) => [p.id, t])),
      // The prompt's own decoys, then (a file without them) undealt prompts.
      [...shuffle(spot.decoys, this.#rng), ...decoyOrder(shuffle(this.#deck.left.filter((t) => titleKey(t.text, lang) !== truthKey), this.#rng), spot.tag).map((t) => t.text)],
      this.#rng,
      Math.min(4, lies.liars.length + 1),
      lang,
    );
    // A prompt shown as a decoy is not dealt later.
    this.#deck.discard(options.filter((o) => o.decoy).map((o) => o.text));
    // With `open`, newcomers vote from here (never in a vote that runs).
    if (party.lateJoin === "open") this.#dealIn(true);
    this.#votesLeft = Math.max(0, this.#votesLeft - 1);
    const writing = new Set(next?.liars ?? []);
    const voters = this.#inGame().filter((p) => p !== artist && !writing.has(p));
    const shown = deal(options, voters.map((p) => p.id), PHONE_LIES, this.#rng);
    const text = new Map(options.map((o) => [o.id, o.text]));
    const mine = (p: Player) => (shown.get(p.id) ?? []).map((id) => ({ id, text: text.get(id)! }));

    // Votes.
    this.#setPhase("vote");
    this.#onScreen = undefined;
    const deadline = this.#deadline(this.timings.vote);
    const key = lies.key;
    this.#withTv(() => {
      this.#room({ phase: "vote", spot: i + 1, spots, deadline, drawing: spot.drawing, artist: art });
      this.#screen({
        phase: "vote",
        round,
        spot: i + 1,
        spots,
        deadline,
        drawing: spot.drawing,
        artist: art,
        options: options.map((o) => ({ id: o.id, text: o.text })),
        waiting: voters.map((p) => p.id),
        done: [],
        writing: writing.size,
      });
      for (const p of voters) p.state.replace({ task: "vote", key, options: mine(p), deadline, done: false, ...this.#rank(p) });
      if (!writing.has(artist)) artist.state.replace({ task: "artist", key, ...this.#rank(artist) });
      for (const p of party.players) {
        if (!this.scores.has(p.id) && !writing.has(p)) p.state.replace(this.#waitState(p));
      }
    });
    const votes = await party.collect<string>("vote", {
      from: voters,
      until: deadline,
      signal: this.#abort.signal,
      validate: (d, p) => {
        const id = typeof d === "object" && d !== null ? (d as { option?: unknown }).option : d;
        if (typeof id !== "string" || !(shown.get(p.id) ?? []).includes(id)) throw new PartyError("bad-vote", "Pick one of the titles");
        return id;
      },
      onAnswer: (p, id, answers) => {
        p.state.set({ done: true, choice: id });
        party.screen.set({ done: [...answers.keys()].map((x) => x.id) });
      },
    });
    if (this.#abort.signal.aborted) return;

    // Points (counted once the TV showed them, see #reveal) and the reveal.
    const byVoter = new Map([...votes].map(([p, o]) => [p.id, o]));
    const scoring = score(artist.id, options, shown, byVoter, round);
    for (const [id, o] of byVoter) {
      const opt = options.find((x) => x.id === o);
      if (!opt || !scoring.voters.get(o)!.includes(id)) continue;
      this.#count(id).votes++;
      if (opt.truth) this.#count(id).found++;
      else for (const a of opt.authors) this.#count(a).fooled++;
    }
    await this.#reveal(round, i, spots, spot, options, scoring, byVoter, next);
  }

  #count(id: string): Tally {
    let t = this.#tally.get(id);
    if (!t) this.#tally.set(id, (t = { fooled: 0, found: 0, votes: 0 }));
    return t;
  }

  async #reveal(
    round: number,
    i: number,
    spots: number,
    spot: Entry,
    options: Option[],
    scoring: ReturnType<typeof score>,
    votes: ReadonlyMap<string, string>,
    next: Lies | undefined,
  ): Promise<void> {
    const party = this.party;
    this.#setPhase("reveal");
    const name = (id: string) => party.player(id)?.name ?? SOMEONE[this.#lang];
    const items = revealOrder(options, scoring.voters).map((o) => {
      const who = scoring.voters.get(o.id) ?? [];
      const seen = scoring.seen.get(o.id) ?? 0;
      return {
        id: o.id,
        text: o.text,
        truth: o.truth,
        decoy: o.decoy,
        authors: o.authors.map(name),
        authorIds: o.authors,
        voters: who.slice(0, REVEAL_NAMES).map(name),
        voterIds: who.slice(0, REVEAL_IDS),
        count: who.length,
        seen,
        points: (o.truth ? POINTS.guess : share(who.length, POINTS.fooled, seen)) * round,
        artistPoints: o.truth ? share(who.length, POINTS.artist, seen) * round : 0,
        same: o.authors.length > 1,
      };
    });
    const art = { id: spot.artist.id, name: spot.artist.name };
    const writing = new Set(next && !next.finished ? next.liars.filter((p) => !next.answers.has(p)) : []);
    this.#withTv(() => {
      this.#room({ phase: "reveal", spot: i + 1, spots, drawing: spot.drawing, artist: art });
      this.#screen({
        phase: "reveal",
        round,
        spot: i + 1,
        spots,
        drawing: spot.drawing,
        artist: art,
        prompt: displayTitle(spot.prompt),
        items,
        step: 0,
        stepMs: this.timings.revealStep,
        endMs: this.timings.revealEnd,
      });
      // The TV tells: the phones only say to look at it (scores and ranks from before this drawing).
      for (const p of party.players) {
        if (writing.has(p)) continue;
        p.state.replace(this.scores.has(p.id) ? { task: "watch", note: "reveal", ...this.#rank(p) } : this.#waitState(p));
      }
    });
    for (let step = 1; step <= items.length; step++) {
      await this.#sleep(this.timings.revealStep);
      if (this.#abort.signal.aborted) return;
      this.#withTv(() => party.screen.set({ step }));
    }
    // Once the TV showed the truth and its points: the points count, and
    // each phone says what it did for you (`note: "result"`).
    const after = Math.min(this.timings.revealStep, Math.floor(this.timings.revealEnd / 2));
    await this.#sleep(after);
    if (this.#abort.signal.aborted) return;
    for (const [id, n] of scoring.points) this.scores.set(id, (this.scores.get(id) ?? 0) + n);
    this.#withTv(() => {
      for (const p of party.players) {
        if (writing.has(p)) continue;
        if (!this.scores.has(p.id)) {
          p.state.replace(this.#waitState(p));
          continue;
        }
        p.state.replace({ task: "watch", note: "result", result: this.#result(p, spot, options, scoring, votes), ...this.#rank(p) });
      }
    });
    await this.#sleep(this.timings.revealEnd - after);
  }

  /** What one phone says after a vote: what you found, who fooled you, what your lie did. */
  #result(p: Player, spot: Entry, options: Option[], scoring: ReturnType<typeof score>, votes: ReadonlyMap<string, string>): Record<string, unknown> {
    const points = scoring.points.get(p.id) ?? 0;
    if (p === spot.artist) {
      const truth = options.find((o) => o.truth)!;
      return { kind: "artist", points, count: scoring.voters.get(truth.id)?.length ?? 0, seen: scoring.seen.get(truth.id) ?? 0 };
    }
    const lie = options.find((o) => o.authors.includes(p.id));
    const fooled = lie ? (scoring.voters.get(lie.id)?.length ?? 0) : 0;
    const choice = votes.get(p.id);
    const picked = options.find((o) => o.id === choice && (scoring.voters.get(o.id) ?? []).includes(p.id));
    const out: Record<string, unknown> = { kind: picked ? (picked.truth ? "found" : "fooled") : "none", points };
    if (picked && !picked.truth) out["by"] = picked.decoy ? [] : picked.authors.map((a) => this.party.player(a)?.name ?? SOMEONE[this.#lang]);
    if (lie) {
      out["lie"] = lie.text;
      out["fooledCount"] = fooled;
    }
    return out;
  }

  #table(before?: ReadonlyMap<string, number>): ScoreLine[] {
    return this.party.players
      .filter((p) => this.scores.has(p.id))
      .map((p) => {
        const s = this.scores.get(p.id) ?? 0;
        return { id: p.id, name: p.name, score: s, delta: s - (before?.get(p.id) ?? 0) };
      })
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  }

  #rank(p: Player | undefined): { score: number; rank: number; of: number } {
    const scores = [...this.scores].filter(([id]) => this.party.player(id)).map(([, s]) => s);
    const s = p ? (this.scores.get(p.id) ?? 0) : 0;
    return { score: s, rank: 1 + scores.filter((x) => x > s).length, of: scores.length };
  }

  /** The round's highlights: the best liar, the sharpest eye. */
  #highlights(): Record<string, unknown>[] {
    const party = this.party;
    const lines = [...this.#tally]
      .map(([id, t]) => ({ id, name: party.player(id)?.name, ...t }))
      .filter((l): l is { id: string; name: string } & Tally => typeof l.name === "string");
    const best = (key: (l: Tally) => number) =>
      lines.filter((l) => key(l) > 0).sort((a, b) => key(b) - key(a) || a.name.localeCompare(b.name))[0];
    const out: Record<string, unknown>[] = [];
    const liar = best((l) => l.fooled);
    if (liar) out.push({ kind: "liar", id: liar.id, name: liar.name, count: liar.fooled });
    const eye = best((l) => l.found);
    if (eye) out.push({ kind: "eye", id: eye.id, name: eye.name, count: eye.found, of: eye.votes });
    return out;
  }

  async #scores(round: number, before: ReadonlyMap<string, number>): Promise<void> {
    const party = this.party;
    this.#setPhase("scores");
    const table = this.#table(before);
    this.#withTv(() => {
      this.#room({ phase: "scores" });
      this.#screen({
        phase: "scores",
        round,
        rounds: this.rounds,
        scores: table.slice(0, BOARD_LINES),
        total: table.length,
        highlights: this.#highlights(),
        last: round === this.rounds,
      });
      for (const p of party.players) p.state.replace(this.scores.has(p.id) ? { task: "scores", ...this.#rank(p) } : this.#waitState(p));
    });
    await this.#sleep(this.timings.scores);
  }

  #final(): ScoreLine[] {
    const party = this.party;
    this.#setPhase("final");
    const table = this.#table();
    this.#withTv(() => {
      // The next game's rules too (the VIP's phone shows them again).
      party.room.replace({ phase: "final", lang: this.#lang, minPlayers: this.minPlayers, maxPlayers: party.maxPlayers, rounds: this.rounds, lateJoin: party.lateJoin, ...this.#settingsView(), ...this.#colorView() });
      party.screen.replace({ phase: "final", lang: this.#lang, scores: table.slice(0, BOARD_LINES), total: table.length, colors: this.#screenColors(), rounds: this.rounds, ...this.#settings });
      for (const p of party.players) p.state.replace({ task: "final", ...this.#rank(this.scores.has(p.id) ? p : undefined), ...this.#pens(p) });
    });
    this.emit("end", table);
    return table;
  }

  #sleep(ms: number): Promise<void> {
    const signal = this.#abort.signal;
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
