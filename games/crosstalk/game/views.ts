/**
 * What the host sends: the contract between the game (`game.ts`), the TV
 * page (`screen/`) and the phone page (`phone/`). The host is the only
 * authority; phones and the TV draw these views and send actions.
 *
 * - `party.room` (every phone) and `party.screen` (the TV, the watch
 *   link) are the same {@link RoomView}: only what everybody may see.
 * - `player.state` (one phone) is a {@link MeView}: the key for a
 *   spymaster, the team's clue, pins and pad for its players.
 *
 * Secret until the end of the game (then in `reveal`): the key (only in
 * the spymasters' `me.key`), a clue and its number (only in its team's
 * `me`), pins (the team's `me`), the pad (the team's operatives' `me`).
 */

import type { Choice, Color, EndReason, Stop, Team } from "./rules.ts";

export type Phase = "lobby" | "intro" | "clue" | "guess" | "round" | "end";

/** A card as everybody sees it: the word, and its colour once turned (by whom). */
export interface BoardCard {
  word: string;
  color: Color | null;
  /** The teams that locked it (both, when both did in one step). */
  by: Team[];
  /** The step (game-wide) it was turned in, 0 while face down. */
  at: number;
}

/**
 * A team's state for the TV:
 * - `lobby`: before a game;
 * - `thinking` / `ready`: the clue phase (its spymaster typing, or the clue in);
 * - `guessing` / `locked`: a step (its card not chosen yet, or locked);
 * - `done`: stopped for this round (`stop` says why);
 * - `idle`: between rounds, the intro, the end.
 */
export type TeamStatus = "lobby" | "thinking" | "ready" | "guessing" | "locked" | "done" | "idle";

export interface TeamView {
  /** Player ids, in the order they joined. */
  players: string[];
  spymaster: string | null;
  /** Its cards turned so far (by anyone), of {@link BOARD.team}. */
  found: number;
  /** Its wrong cards this game (neutral, the other team's): the tie-break. */
  wrong: number;
  status: TeamStatus;
  stop: Stop | null;
}

/** One card of a step's flip. */
export interface FlipCard {
  team: Team;
  card: number;
  color: Color;
  /** right, neutral, theirs (the other team's), assassin. */
  result: "right" | "neutral" | "theirs" | "assassin";
}

export interface Flip {
  /** The step (game-wide counter): a new flip has a new one. */
  step: number;
  cards: FlipCard[];
  /** Teams that passed in this step. */
  passed: Team[];
}

export interface ClueLine {
  round: number;
  word: string;
  number: number;
  /** The cards its team turned for it, in order. */
  cards: number[];
}

export interface RevealLine {
  text: string;
  /** Who wrote it last. */
  name: string;
}

/** The end of a game: what was secret. */
export interface Reveal {
  key: Color[];
  clues: Record<Team, ClueLine[]>;
  pads: Record<Team, RevealLine[]>;
  /** Who was spymaster of each team. */
  spymasters: Record<Team, string | null>;
}

export interface Settings {
  /** Seconds for the clues. */
  clueTime: number;
  /** Seconds for a step. */
  stepTime: number;
  /** How the board is dealt: categories tangled (the default), or any words. */
  deal: "tangled" | "mixed";
  difficulty: "easy" | "normal" | "hard";
  /** Latecomers (the party's `lateJoin`): from the next round, or shut out. */
  late: "wait" | "closed";
}

export interface RoomView extends Settings {
  phase: Phase;
  lang: "en" | "de";
  /** The languages the room can play (those with words): the VIP's choices. */
  langs: ("en" | "de")[];
  minPlayers: number;
  maxPlayers: number;
  /** Names by player id: everyone who played in this game, also those who left. */
  names: Record<string, string>;
  teams: Record<Team, TeamView>;
  /** Null in the lobby (and before the first game). */
  board: BoardCard[] | null;
  round: number;
  /** Steps so far in this game (a step's flip carries its number). */
  step: number;
  /** Steps so far in this round. */
  roundStep: number;
  /** A step is open: cards can be locked (false during a flip). */
  open: boolean;
  /** When the phase's clock ends (host clock), and how long it runs (ms). */
  deadline: number | null;
  duration: number | null;
  /** The last flip (in the guess phase, until the next step's flip). */
  flip: Flip | null;
  /** The end. */
  winner: Team | null;
  reason: EndReason | null;
  reveal: Reveal | null;
  /** The next game's spymasters (lobby and end). */
  next: Record<Team, string | null>;
}

export interface PadLineView {
  id: number;
  text: string;
  /** Who wrote it last (id, name). */
  by: string;
  name: string;
  /** Who is editing it now. */
  edit: string | null;
}

export interface MeView {
  task: "lobby" | "wait" | "spymaster" | "operative" | "end";
  team: Team | null;
  /** The key: a spymaster's only. */
  key: Color[] | null;
  /** The team's clue of this round (once its spymaster sent it). */
  clue: { word: string; number: number } | null;
  /** The team's cards this round, and how many more it may turn (number + 1). */
  turned: number;
  /** The team's clues so far, this round's last. */
  history: ClueLine[];
  /** The team's operatives' pins (by id). */
  pins: Record<string, Choice>;
  /** The team's operatives who are there: their majority locks. */
  voters: string[];
  mine: Choice | null;
  /** The choice a majority pinned, if any (Lock shows for them). */
  majority: Choice | null;
  /** The team's card for this step, once locked. */
  locked: Choice | null;
  /** Whether the team may pass now (after its first card of the round). */
  canPass: boolean;
  /** Whether the team is still guessing this round. */
  active: boolean;
  stop: Stop | null;
  /** The team's pad: its operatives' only. */
  pad: PadLineView[] | null;
}

/** The actions phones send (`client.act(type, data)`). */
export interface Actions {
  /** VIP, lobby or end: start a game. */
  start: null;
  /** VIP, lobby or end: the settings (`lang`, `clueTime`, `stepTime` in seconds, `deal`, `difficulty`, `late`), the host page's choices. */
  settings: Partial<Settings> & { lang?: "en" | "de" };
  /** VIP, lobby or end: remove a player. */
  kick: { id: string };
  /** Lobby or end: join a team. */
  team: { team: Team };
  /** Lobby or end: be your team's spymaster next game. */
  spymaster: null;
  /** VIP, lobby or end: new random teams. */
  shuffle: null;
  /** Spymaster, clue phase: the clue (refused with the reason: too-close names the card). */
  clue: { word: string; number: number };
  /** Operative: pin a card (an index), pass, or take the pin off (null). In the clue phase once the clue is in, or in a step. */
  pin: { card: Choice | null };
  /** Operative whose pin is the majority's, in a step: lock it. */
  lock: null;
  /** Operative, during a game: the pad. */
  pad:
    | { op: "add"; text: string }
    | { op: "edit"; id: number }
    | { op: "save"; id: number; text: string }
    | { op: "cancel"; id: number }
    | { op: "delete"; id: number };
}
