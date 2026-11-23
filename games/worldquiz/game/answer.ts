/**
 * Reading typed answers (docs/worldquiz-design.md §4.4): spelling
 * forgiven, but only toward one country. An answer is made plain
 * (lower case, no accents, "ä" and "ae" alike, no punctuation, no
 * articles or "Republic of"), then compared with every name of every
 * country (or every capital), in both languages, by Damerau–Levenshtein
 * distance. It counts for the country whose name is closest, when the
 * distance is small for the name's length and no other country's name
 * is as close; a name that is exactly another country's is that country.
 */

/** Words that say nothing about which country (both languages). */
const FILLERS = new Set(["the", "of", "and", "republic", "die", "der", "das", "des", "und", "republik", "von"]);

/**
 * An answer or a name, made plain for comparing: "Côte d'Ivoire" →
 * "cotedivoire", "Türkei" and "Tuerkei" → "turkei", "St. Lucia" →
 * "saintlucia", "The Bahamas" → "bahamas".
 */
export function plain(text: string, fillers = true): string {
  let s = text.normalize("NFKC").toLowerCase().replaceAll("ß", "ss");
  // Umlauts written out and with dots read the same.
  s = s.replace(/([aou])e/g, "$1").replace(/ä/g, "a").replace(/ö/g, "o").replace(/ü/g, "u");
  s = s.normalize("NFKD").replace(/\p{M}+/gu, "");
  s = s.replace(/[^\p{L}\p{N}]+/gu, " ");
  const words = s
    .split(" ")
    .filter((w) => w && !(fillers && FILLERS.has(w)))
    .map((w) => (w === "st" || w === "sankt" || w === "saint" ? "saint" : w));
  return words.join("");
}

/** Damerau–Levenshtein distance (optimal string alignment), by code point. */
export function distance(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  const m = x.length;
  const n = y.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev2: number[] = [];
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      let v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && x[i - 1] === y[j - 2] && x[i - 2] === y[j - 1]) v = Math.min(v, prev2[j - 2]! + 1);
      cur.push(v);
    }
    prev2 = prev;
    prev = cur;
  }
  return prev[n]!;
}

/** How many mistakes a name of this many letters forgives. */
export function forgiven(letters: number): number {
  return letters <= 4 ? 0 : letters <= 8 ? 1 : 2;
}

/** A thing to answer with: an id and the names that mean it. */
export interface Candidate {
  id: string;
  names: readonly string[];
}

/** What an answer was read as: the ids it means (several only for a name they share) and the name it matched. */
export interface Reading {
  ids: string[];
  name: string | null;
}

/** Plain forms of candidates, made once per list. */
export class Matcher {
  readonly #names: { id: string; name: string; plain: string; full: string }[] = [];

  constructor(candidates: readonly Candidate[]) {
    for (const c of candidates)
      for (const name of c.names) {
        const p = plain(name);
        if (p) this.#names.push({ id: c.id, name, plain: p, full: plain(name, false) });
      }
  }

  /** Reads an answer (§4.4). */
  read(answer: string): Reading {
    const a = plain(answer);
    const full = plain(answer, false);
    if (!a) return { ids: [], name: null };
    const exact = this.#names.filter((n) => n.plain === a);
    if (exact.length) return { ids: [...new Set(exact.map((n) => n.id))], name: exact[0]!.name };
    let best = Infinity;
    let hits: { id: string; name: string }[] = [];
    for (const n of this.#names) {
      // With the filler words ("Republic") and without: whichever is closer.
      let d = Infinity;
      for (const [x, y] of [
        [a, n.plain],
        [full, n.full],
      ] as const) {
        if (Math.abs([...x].length - [...y].length) > 2) continue;
        const e = distance(x, y);
        if (e <= forgiven([...y].length)) d = Math.min(d, e);
      }
      if (d === Infinity) continue;
      if (d < best) {
        best = d;
        hits = [n];
      } else if (d === best) hits.push(n);
    }
    const ids = [...new Set(hits.map((n) => n.id))];
    if (ids.length !== 1) return { ids: [], name: null };
    return { ids, name: hits[0]!.name };
  }
}
