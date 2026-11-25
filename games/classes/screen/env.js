// @ts-check
/**
 * What every scene of the TV page shares: the client, the strings of the
 * room's language, the screen view, the people, and the wall clock.
 */

import { strings } from "./strings.js";

/** @typedef {{ id: string, who: string[], texts: string[], same?: string, auto?: string }} Answer */
/** @typedef {{ id: string, doubts: number, of: number, struck: boolean, points: number, stars: number }} Mark */
/** @typedef {{ subject: string, text: string, rule?: string }} Column */

export const env = {
  /** @type {import("/_tvpipe/lib/client.js").PartyClient | null} */
  client: null,
  /** @type {"en" | "de" | "at"} */
  lang: "en",
  t: strings("en"),
  /** The screen view (`party.screen`). @type {Record<string, any>} */
  screen: {},
  /** The roster. @type {{ id: string, name: string, vip?: boolean, connected?: boolean, waiting?: boolean }[]} */
  roster: [],
  /**
   * The wall clock's state for this frame, set by the scene's update:
   * `deadline` (host time) with its `total` for the wedge, `red`.
   * @type {{ deadline?: number, total?: number, red?: boolean }}
   */
  clock: {},
  /** Preview only (`#ago=MS`): scenes behave as if they had started MS ago. */
  ago: Number(new URLSearchParams(location.hash.slice(1)).get("ago") ?? 0) || 0,
};

/** The host's time as it is on the TV now. */
export const now = () => env.client?.now() ?? Date.now();

/** @param {string} id @returns {{ name: string, hand: number }} */
export function person(id) {
  const p = env.screen["people"]?.[id];
  return p && typeof p.name === "string" ? { name: p.name, hand: Number.isInteger(p.hand) ? ((p.hand % 10) + 10) % 10 : 0 } : { name: "?", hand: 0 };
}

/** Whether a player's phone is connected (the roster; unknown: yes). @param {string} id */
export function connected(id) {
  const r = env.roster.find((x) => x.id === id);
  return r ? r.connected !== false : true;
}

/** The handwriting class of a player (`hand` 0–9, docs/classes-design.md §6.3). @param {string} id */
export const handOf = (id) => `hand${person(id).hand}`;

/** A subject's id as a class name (unknown ones get the grey of the register). @param {unknown} s */
export function subj(s) {
  return typeof s === "string" && /^(geo|bio|home|music|media|sport|social|lang|break|trip|register|detention)$/.test(s) ? s : "register";
}

/**
 * A column's text with the players' names in it kept on one line
 * ("Hildegard-Luise" never breaks at its hyphen): text nodes, and a
 * `nowrap` span around each name.
 * @param {string} text @returns {(string | HTMLElement)[]}
 */
export function keepNames(text) {
  const names = Object.values(env.screen["people"] ?? {})
    .map((p) => (p && typeof p.name === "string" ? p.name : ""))
    .filter((n) => /[\s-]/.test(n))
    .sort((a, b) => b.length - a.length);
  /** @type {(string | HTMLElement)[]} */
  let parts = [text];
  for (const name of names) {
    parts = parts.flatMap((part) => {
      if (typeof part !== "string" || !part.includes(name)) return [part];
      return part.split(name).flatMap((piece, i) => {
        const span = document.createElement("span");
        span.className = "nw";
        span.textContent = name;
        return i === 0 ? [piece] : [span, piece];
      });
    });
  }
  return parts.filter((p) => p !== "");
}
