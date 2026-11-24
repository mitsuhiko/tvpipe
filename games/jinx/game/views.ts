/**
 * The contract between the host page (game.ts, the only authority), the TV
 * page (screen/) and the phone page (phone/): every view the host sets and
 * every action a phone sends. Types only. The pages are checked JavaScript
 * and import these with JSDoc: `@typedef {import("../game/views.ts").ScreenView} ScreenView`.
 *
 * The design: docs/jinx-design.md. Times (`deadline`, `until`) are on the
 * host's clock (`party.now()`; phones and TVs have `client.now()`).
 *
 * Secrecy (the design's rule): the secret word is in `party.screen` only from
 * the `verdict` phase on, and in a `player.state` only for clue-givers.
 * Clue words are on the TV only once turned (reveal) or from the verdict on.
 * Nothing on the TV or a phone tells who jinxed with whom before `jinx`.
 *
 * Language: `lang` in the screen view and the room view is the room's
 * language (`en`, `de`; the host page's or the VIP's setting, changed
 * only between games). The TV, the phones and the host page say
 * everything in it (a phone may pick its own); the words and the clues
 * are in it.
 */

import type { Lang } from "./lang.ts";

export type { Lang };

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

/**
 * A face: one of the ready-made faces (`preset`, 0–7), or a doodle drawn on
 * the phone: strokes on a 1000×1000 grid, each `[x0, y0, x1, y1, …]`, one ink
 * colour (the chip's centre is a circle inscribed in that grid). At most 40
 * strokes, 2000 points in all.
 */
export type Face = { preset: number } | { strokes: number[][] };

export interface Person {
  id: string;
  name: string;
  /** The chip's colour, 0–7 (the TV's and the phone's palette); unique in the room while there are 8 or fewer. */
  color: number;
  face: Face;
  vip: boolean;
  connected: boolean;
  /** A bot (the host page's), drawn with a dashed rim. */
  bot?: boolean;
  /**
   * Left the room during this game: kept (with `connected: false`) until the
   * next game, so cards, words, the replay and the end can still draw the chip.
   */
  left?: boolean;
}

/**
 * Everyone in the room, in join order (players waiting to join late
 * included), then those who left during this game (`left: true`).
 */
export type People = Person[];

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

export type Reason =
  | "same word"
  | "same number"
  | "spelling"
  | "plural"
  | "verb form"
  | "word form"
  | "same family"
  | "typo"
  | "sounds the same"
  | "contains the word"
  | "part of the word"
  | "backwards"
  | "too close";

/** A clue card. `id` is stable for the round ("c0", "c1", …). */
export interface Card {
  id: string;
  /** The author's person id. */
  author: string;
  bold: boolean;
  /** The clue as typed (cleaned of invisible characters), only once the TV may show it. */
  word?: string;
  /** `alive` (survived the jinx check) or `jinxed`; absent before the jinx check. */
  fate?: "alive" | "jinxed";
  /** Turn order, 1, 2, … once turned in the reveal. */
  turned?: number;
}

/** One jinx group: its cards and every matching pair with its reason (the TV slams pair by pair). */
export interface JinxGroup {
  cards: string[];
  pairs: { a: string; b: string; reason: Reason }[];
}

// ---------------------------------------------------------------------------
// The room's count
// ---------------------------------------------------------------------------

export interface Tally {
  /** Words found so far. */
  found: number;
  /** Rounds played so far. */
  played: number;
  /** Rounds in this game (grows when someone joins late). */
  total: number;
  /** Per round so far: found or missed. */
  history: ("found" | "missed")[];
}

/**
 * The room's bank: one score for everybody (the design's §4). A right guess
 * puts the pot in, a wrong one takes 2 out (never below 0). `goals` are the
 * room titles' marks for this game (chips; they move when the game gets
 * longer or shorter), `record` the room's best for a game of this many
 * rounds (the host page's `localStorage`), absent when there is none.
 */
export interface Bank {
  chips: number;
  goals: Goals;
  record?: number;
}

/** The chips a game of this length needs for each room title above "total jinx". */
export type Goals = Record<Exclude<RoomTitle, "total jinx">, number>;

/**
 * What one card did for the room (the phones' result line): `turned`
 * (turned before a right guess), `bold` (bold and turned before a right
 * guess: it put 2 more in the pot),
 * `jinxed`, `bold-jinxed` (−2 more off the pot), `best` (the guesser's best
 * clue).
 */
export type Part = "turned" | "bold" | "jinxed" | "bold-jinxed" | "best";

// ---------------------------------------------------------------------------
// The TV: party.screen
// ---------------------------------------------------------------------------

interface Base {
  /** The room's language. */
  lang: Lang;
  people: People;
}

interface InRound extends Base {
  round: number;
  rounds: number;
  /** The guesser's person id. */
  guesser: string;
  tally: Tally;
  bank: Bank;
  /** The pot (chips), from the jinx check on. */
  pot?: number;
}

export interface LobbyScreen extends Base {
  phase: "lobby";
  minPlayers: number;
  maxPlayers: number;
}

/** The round intro (~4 s): "ANNA IS IN THE HOT SEAT". */
export interface HotseatScreen extends InRound {
  phase: "hotseat";
  until: number;
}

/** Clue-givers write. The TV shows only who is done (`done`: person ids). */
export interface WriteScreen extends InRound {
  phase: "write";
  givers: string[];
  /** Clues each giver writes (2 with 3 players, else 1). */
  each: 1 | 2;
  /** Givers who sent all their clues. */
  done: string[];
  /** Cards sent so far (a count: nothing else about them). */
  sent: number;
  /** Cards sent so far per giver id (the TV throws each from its author's chip; no words). */
  sentBy: Record<string, number>;
  /** When writing began (host time): with `deadline`, the dial's full length. */
  started: number;
  deadline: number;
}

/**
 * The jinx check: all cards face down (no `word`), `fate` set, the groups
 * to slam in order. `pot` is after the jinx losses (1 per jinxed card, 2
 * more per bold one), `potBefore` before (10). The host waits until `until` (time for the animation:
 * 4 s + 4.5 s per group, a group of 3+ cards counting 1.5; faster groups after the first are the TV's business).
 */
export interface JinxScreen extends InRound {
  phase: "jinx";
  cards: Card[];
  groups: JinxGroup[];
  potBefore: number;
  pot: number;
  until: number;
}

/**
 * The reveal: the surviving cards (turned ones with `word` and `turned`).
 * `picked` is the card the guesser just picked (the TV's "ANNA TRUSTS… BEN"),
 * set with the turn. `pot` after the turns (−2 per card after the first, +2
 * per bold card). `draft` is the guess being typed, live (may be "");
 * `typing` once the guesser started typing this decision.
 */
export interface RevealScreen extends InRound {
  phase: "reveal";
  cards: Card[];
  jinxed: number;
  pot: number;
  picked?: string;
  draft: string;
  typing: boolean;
  /** When the current decision began (host time): with `deadline`, the dial's length. */
  started: number;
  deadline: number;
}

/**
 * The verdict. `result`: `right`, `wrong`, `pass`, or `lost` (every card
 * jinxed: no guess). `guess` as typed (absent for pass/lost); `near`: the
 * reason a near miss was accepted ("typo", "plural", …; absent for an exact
 * match). `banked`: what the round did to the bank (the pot when right, −2
 * or less when wrong, else 0); `bank` is after it.
 */
export interface VerdictScreen extends InRound {
  phase: "verdict";
  word: string;
  result: "right" | "wrong" | "pass" | "lost";
  guess?: string;
  near?: Reason;
  cards: Card[];
  banked: number;
  until: number;
}

/**
 * The replay: every card of the round face up (`word` set), with `fate`
 * and `turned`; `groups` as in the jinx check. `best`: the clue the
 * guesser picked as the one that helped most (a thank-you, no points;
 * absent while picking, or none). `picking` while the guesser may still
 * pick (only after a right guess).
 */
export interface ReplayScreen extends InRound {
  phase: "replay";
  word: string;
  result: "right" | "wrong" | "pass" | "lost";
  cards: Card[];
  groups: JinxGroup[];
  picking: boolean;
  banked: number;
  best?: string;
  deadline?: number;
}

/** Between rounds: the bank (`bank`) and what this round did to it (`banked`). */
export interface BankScreen extends InRound {
  phase: "bank";
  banked: number;
  /** The next guesser, absent after the last round. */
  next?: string;
  until: number;
}

export type RoomTitle = "telepaths" | "mind readers" | "in sync" | "mixed signals" | "total jinx";

/**
 * Light awards, no winners: `mind meld` (the pair whose clues jinxed
 * together most), `telepath` (most clues turned before a right guess).
 */
export interface Award {
  kind: "mind meld" | "telepath";
  /** Mind meld: two ids; the others: one. */
  ids: string[];
  count: number;
}

/** The word web: the words of the game and their clues (cleaned key → shown text). */
export interface Web {
  words: { word: string; found: boolean; clues: string[] }[];
  /** Clues used for more than one word: the clue as shown, and indices into `words`. */
  links: { clue: string; words: number[] }[];
}

/** A best clue of the night: the word, the clue, its author. */
export interface BestClue {
  word: string;
  clue: string;
  author: string;
  guesser: string;
}

/**
 * The end of the game, in steps the TV plays in order: `room` (the bank,
 * the title, the words, a new record), `clues` (the best clues of the
 * night; skipped when there are none), `awards` (skipped when none),
 * `web`. The host sets `step` and holds each one; `web` stays until the
 * VIP plays again. `bank.record` is the record before this game; `record`
 * is set when this game beat it (or set the first one).
 */
export interface EndScreen extends Base {
  phase: "end";
  step: "room" | "clues" | "awards" | "web";
  tally: Tally;
  bank: Bank;
  title: RoomTitle;
  record?: true;
  words: { word: string; found: boolean; guesser: string }[];
  clues: BestClue[];
  awards: Award[];
  web: Web;
}

export type ScreenView =
  | LobbyScreen
  | HotseatScreen
  | WriteScreen
  | JinxScreen
  | RevealScreen
  | VerdictScreen
  | ReplayScreen
  | BankScreen
  | EndScreen;

// ---------------------------------------------------------------------------
// Phones: party.room (everyone) and player.state (one phone)
// ---------------------------------------------------------------------------

/** Every phone: the phase and the people (for faces and names). */
/**
 * The settings the VIP may change from the phone (lobby and end), as the
 * host page does: rounds (`auto`: twice with 3–5 players, once with 6–8),
 * the writing time in seconds, the words' difficulty, the latecomers.
 * The language is one too (the `settings` action's `lang`), in the room
 * view as `lang`.
 */
export interface Settings {
  rounds: "auto" | 1 | 2;
  /** Seconds: 30, 45, 60 or 90 (the tests' short timers aside). */
  write: number;
  difficulty: "easy" | "normal" | "hard";
  /** Latecomers: play from the next round (`wait`), or nobody new joins a running game (`closed`; players can still rejoin by name). */
  late: "wait" | "closed";
}

export interface RoomView {
  phase: ScreenView["phase"];
  /** The room's language. */
  lang: Lang;
  /** The languages there are words for (the VIP can pick these). */
  langs: Lang[];
  /** The game's settings (the next game's, between games). */
  settings: Settings;
  people: People;
  round?: number;
  rounds?: number;
  guesser?: string;
  minPlayers: number;
  maxPlayers: number;
}

/**
 * One phone's task:
 * - `lobby`: draw a face (or keep the preset); the VIP starts (`canStart`).
 * - `wait`: joined during a game, plays from the next round.
 * - `hotseat`: the round intro (`guesser`: am I the guesser).
 * - `write`: a clue-giver: the word, the clues sent so far (`sent`, one or two
 *   slots), `deadline`.
 * - `blind`: the guesser while clues are written (`done`/`givers` counts).
 * - `tv`: nothing to do, watch the TV (the jinx check's slams and the
 *   verdict's envelope come first on the TV; `fate`, `check` and `result`
 *   follow when the TV has shown them).
 * - `fate`: after the jinx check, a giver's cards: survived or jinxed with
 *   whom (names) and why.
 * - `check`: the guesser during the jinx check: how many cards survived and
 *   how many were jinxed (counts only).
 * - Clue-givers keep `result` through the replay (the phone shows "Anna is
 *   picking the best clue…" from `room.phase`).
 * - `guess`: the guesser in the reveal: the cards (face down unless turned),
 *   the pot, `deadline`.
 * - `watch`: a clue-giver in the reveal: the word, the cards, "Shh".
 * - `result`: the verdict for this phone: the word, the result, what the
 *   round did to the room's bank (`banked`, `bank`) and what this phone's
 *   cards did (`parts`, one per card, plus `best`).
 * - `best`: the guesser picks the best clue among `cards` (turned or not, not jinxed).
 * - `bank`: the room's bank, the next title to reach (`goal`, absent at
 *   the top), `next` (am I up next).
 * - `final`: the end: the room's bank, title and words found, a new
 *   record, own award; the VIP: `canRestart`.
 */
export type PlayerState =
  | { task: "lobby"; face: Face; color: number; canStart: boolean }
  | { task: "wait" }
  | { task: "hotseat"; guesser: boolean }
  | {
      task: "write";
      word: string;
      each: 1 | 2;
      /** Accepted clues so far, by slot. */
      sent: ({ text: string; bold: boolean } | null)[];
      deadline: number;
    }
  | { task: "blind"; givers: number; done: number; deadline: number }
  | { task: "fate"; word: string; cards: { text: string; bold: boolean; fate: "alive" | "jinxed"; with: string[]; reason?: Reason }[] }
  | { task: "check"; survived: number; jinxed: number }
  | { task: "tv" }
  /** `turning`: the card just turned (its word already here) that the TV is still turning: no pick, no guess or pass until it is gone. */
  | { task: "guess"; cards: Card[]; pot: number; deadline: number; jinxed: number; turning?: string }
  | { task: "watch"; word: string; cards: Card[]; pot: number }
  | { task: "result"; word: string; result: "right" | "wrong" | "pass" | "lost"; guesser: boolean; banked: number; bank: number; parts: Part[] }
  | { task: "best"; cards: Card[]; deadline: number }
  | { task: "bank"; bank: number; banked: number; goal?: { title: RoomTitle; chips: number }; next: boolean }
  | { task: "final"; bank: number; title: RoomTitle; record: boolean; award?: Award["kind"]; canRestart: boolean; found: number; total: number };

// ---------------------------------------------------------------------------
// Actions (phone → host), `client.act(type, data)`; refusals are PartyErrors.
// Phones show them by code in their language (the messages are English,
// except a refused clue's, which is the matcher's wording in the room's
// language).
// ---------------------------------------------------------------------------

export interface Actions {
  /** Lobby (and while waiting): set your face. */
  face: Face;
  /** VIP, lobby: start with the players there. */
  start: null;
  /** VIP, end: play again (same players, a new game). */
  again: null;
  /** VIP, lobby: remove a player. */
  kick: { id: string };
  /**
   * VIP, lobby and end: change settings (any of them, and `lang`, one of
   * `RoomView.langs`; refused with `bad-settings` for another key or
   * value, `running` during a game).
   */
  settings: Partial<Settings> & { lang?: Lang };
  /**
   * A clue-giver, write phase: send (or replace) the clue in `slot` (0, or 1
   * with 3 players). Refused with code `too-close:REASON`, `own-clue:REASON`
   * (`REASON` a {@link Reason}: "too-close:plural"), `refused` (the
   * party's moderate hook), `empty`, `too-long`,
   * `too-many-words`, `not-english` (or the matcher's other input codes;
   * the message says why, in the room's language) or `late`.
   */
  clue: { text: string; bold: boolean; slot: number };
  /** The guesser, reveal: turn this card. */
  pick: { card: string };
  /** The guesser, reveal: the one guess (after at least one turned card; `refused` by the moderate hook). */
  guess: { text: string };
  /** The guesser, reveal: no guess. */
  pass: null;
  /** The guesser, replay after a right guess: the clue that helped most. */
  best: { card: string };
}

/**
 * Continuous input (`client.input(data)`, latest wins, never acked): the
 * guesser's draft while typing, `{ draft: string }` (at most 24 characters).
 */
export interface DraftInput {
  draft: string;
}
