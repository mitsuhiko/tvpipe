/**
 * The views outside the heist's frames (docs/pinch-design.md §2, §11):
 * what `game/game.ts` puts into `party.room` (every phone), each
 * `player.state` (one phone) and `party.screen` (the TV), and the
 * transient messages it sends. The heist itself (frames, the public
 * layer, actions, the tape) is `game/protocol.ts`.
 *
 * Owner: game.ts. The pages read these; a change here is a change of
 * both pages, so keep it additive and documented.
 *
 * Times: `deadline` fields are host time (`party.now()`; the pages use
 * `client.now()`), heist times in protocol.ts are seconds since the
 * heist started.
 *
 * Phones' actions (`client.act(type, data)`; a refusal rejects with
 * `PartyActionError` `code`, `message`):
 * - `start` (the VIP, lobby or final, at least `minPlayers` connected):
 *   null. Refusals: `not-vip`, `running`, `too-few`.
 * - `settings` (the VIP, lobby or final; `late` alone also during a
 *   game): a partial `{ length?, rounds?, lang?, late? }`
 *   ({@link SettingsView}, `lang` "en" or "de", `late` "wait" or
 *   "closed"): null. Refusals: `not-vip`, `running`, `bad-settings`.
 * - `skip` (the VIP, at the tape and the scores): null. `not-vip`, `not-now`.
 * - `h` (the heist): a protocol.ts `Action` (`{ a: "go", x, y }`, …),
 *   answered with null; refused with a PartyError whose code is the
 *   protocol.ts `Refusal` id and whose message is the English words
 *   (words.ts `refusals`, else a short line). Not in the heist (or not
 *   in this one: a latecomer): `over`; malformed: `invalid`.
 * - `resync` (a phone after a gap): null; its next frame's `pub` is a
 *   keyframe.
 * - Continuous input (`client.input`): `{ a: "aim", angle }` (degrees),
 *   at most every 100 ms; never answered.
 *
 * Who is who: names come from the roster (`view.roster`), colours from
 * `room.colors`. Messages: {@link Messages}.
 */

import type { Lang, NightItem } from "./items.ts";
import type { BlueprintWire } from "./map.ts";
import type { Frame, HeistResult, PublicDelta, PublicLayer, Tape } from "./protocol.ts";
import type { AwardId, OutcomeKind, Wing } from "./words.ts";

/** The game's phases, in order within a round (lobby first, final last). */
export type Phase = "lobby" | "briefing" | "heist" | "outcome" | "tape" | "scores" | "final";

/**
 * The settings (§13). `length` in seconds: one of protocol.ts
 * `TIMES.lengths`; `rounds`: turns as thief per player; `late`: whether
 * latecomers wait for the next round or are refused during a game
 * (the language is the room's `lang`).
 */
export interface SettingsView {
  length: number;
  rounds: 1 | 2;
  late: "wait" | "closed";
}

/** A night's catalogue entry as the public sees it: never its place, never whether it is still there (that is the public layer's `missing`). */
export interface CatalogueEntry {
  /** items.ts `ITEMS` id; names and notes come from items.ts in the page's language. */
  id: string;
  value: number;
  size: "small" | "large";
  tagged: boolean;
}

/** One round's result, for the scores and the end. */
export interface RoundView {
  round: number;
  thief: string;
  outcome: OutcomeKind;
  /** Dollars the thief got away with (0 unless `gotAway`). */
  haul: number;
  /** Catalogue ids the thief carried out (gotAway) or had on them (pinched). */
  items: string[];
  /** Rewards per guard id (§2: $1,000 for a hold that ended in the arrest, $2,000 for the arrest). */
  rewards: Record<string, number>;
}

/** An award at the end (§9): words.ts `award(lang, id, params)` renders it. */
export interface AwardView {
  id: AwardId;
  player: string;
  /** The numbers the citation needs (the words' AwardParams without names). */
  params: Record<string, number | string>;
}

/** `party.room`: every phone. */
export interface RoomView {
  phase: Phase;
  lang: Lang;
  settings: SettingsView;
  minPlayers: number;
  /** Players' colours by id (guards wear them; the thief's is used outside the heist). */
  colors: Record<string, string>;
  /** 1-based; 0 in the lobby. */
  round: number;
  rounds: number;
  /** The thief of the round (public: §2), null in the lobby and at the end. */
  thief: string | null;
  /** The thief order still to come (ids), for the lobby/scores' "next up". */
  next: string[];
  /** The heist's length in seconds this round (the setting, or the host's `?fast` override), from the briefing on. */
  length?: number;
  /** words.ts `estate(lang, i)`: the night's estate name. */
  estate?: number;
  /** The blueprint (public: no loot, no car), once per round from the briefing on. */
  blueprint?: BlueprintWire;
  catalogue?: CatalogueEntry[];
  /** Briefing, outcome, tape, scores: when the phase ends by itself (host time). */
  deadline?: number | null;
  /**
   * The heist's end, from the outcome to the scores: `by` the arresting
   * guard (pinched), `car` the getaway car's spot (public once the heist
   * is over: the TV shows the car). The haul shows only from the scores
   * on (§2), as `haul` there and in `history`.
   */
  outcome?: { kind: OutcomeKind; car: number; by?: string; haul?: number };
  /** Totals in dollars by player id, and every round so far. */
  scores: Record<string, number>;
  history: RoundView[];
  /** At the end: player ids, richest first (ties: the bigger single haul first). */
  podium?: string[];
  awards?: AwardView[];
  /** At the end: why the game ended early (`few`: fewer than `minPlayers` left), else absent. */
  ended?: "few";
}

/** The thief's secrets for the round (§2, §6): only in the thief's `player.state`. */
export interface ThiefBriefing {
  /** The getaway car: a blueprint spot id. */
  car: number;
  /**
   * The tip: one of the three most valuable items (an items.ts id) and
   * its wing; `building` (0 the main house, 1 the annex) only when the
   * lot has two. Render with words.ts `tip(lang, { item: itemById(id), wing, building }, rng)`.
   */
  tip: { item: string; wing: Wing; building?: number };
}

/**
 * `player.state`: one phone. `role` from the briefing to the scores of a
 * round (`wait`: a latecomer until the next round); in the lobby and at
 * the end `lobby` / `final`.
 */
export interface PlayerView {
  role: "thief" | "guard" | "wait" | "lobby" | "final";
  color: string;
  /** Thief only, from the briefing to the outcome. */
  briefing?: ThiefBriefing;
  /** Where one starts (tile), from the briefing on. */
  start?: { x: number; y: number };
}

/**
 * `party.screen`: the TV. The room's fields, plus during the heist a
 * snapshot of the public layer at most once a second (late or reloaded
 * TVs start from it; the 10 Hz deltas come as `pub` messages).
 */
export interface ScreenView extends RoomView {
  pub?: PublicLayer;
}

/**
 * Transient messages (`party.send` / `party.broadcast`, the page's `msg` event):
 * - `f`: a {@link Frame}, to each phone in the heist at 10 Hz (protocol.ts),
 *   only to its own player. Its `pub` is a keyframe (`prev` -1) in a
 *   phone's first frame of a heist, every 5 s, after `resync` and after
 *   the phone came back.
 * - `pub`: a {@link PublicDelta}, to screens (and watchers) at 10 Hz
 *   during the heist; a keyframe every 5 s and when a screen connects.
 *   `party.screen.pub` holds a snapshot at most once a second.
 * - `tape`: the {@link Tape} and the {@link HeistResult}, to screens at
 *   the tape phase (again to all screens when one connects during it:
 *   `round` tells a repeat).
 * Screens never get a frame.
 */
export interface Messages {
  f: Frame;
  pub: PublicDelta;
  tape: { tape: Tape; result: HeistResult; round: number };
}

/** Not on the wire: a catalogue entry from a NightItem (game.ts uses it). */
export function catalogueEntry(n: NightItem): CatalogueEntry {
  return { id: n.item.id, value: n.item.value, size: n.item.size, tagged: n.tagged };
}
