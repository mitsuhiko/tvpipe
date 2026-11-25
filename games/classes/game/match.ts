/**
 * The same answer (docs/classes-design.md §5.1): two answers in a column
 * are the same when, in this order (the first rule that applies is the
 * reason the TV shows), they are the same after cleaning (`same`), the
 * same but for umlauts written as plain vowels or doubled letters
 * (`spelling`), one the other plus s or es in English (`plural`), or one
 * letter apart in keys of at least 6 letters (`typo`). Grouping is
 * transitive. Deterministic: it depends only on the texts and the
 * language. Known answers in test/match.test.ts.
 */

import { ARTICLES, baseLang, type Base, type Lang } from "./rules.ts";

export type Same = "same" | "spelling" | "plural" | "typo";
/** Strictest first: grouping takes the strict links first. */
const ORDER: readonly Same[] = ["same", "spelling", "plural", "typo"];

const NUMBERS: Record<Base, Record<string, string>> = {
  en: Object.fromEntries(
    ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"]
      .map((w, i) => [w, String(i)])
      .concat([["thirty", "30"], ["forty", "40"], ["fifty", "50"], ["sixty", "60"], ["seventy", "70"], ["eighty", "80"], ["ninety", "90"], ["hundred", "100"], ["thousand", "1000"], ["million", "1000000"]]),
  ),
  de: Object.fromEntries(
    ["null", "eins", "zwei", "drei", "vier", "fuenf", "sechs", "sieben", "acht", "neun", "zehn", "elf", "zwoelf", "dreizehn", "vierzehn", "fuenfzehn", "sechzehn", "siebzehn", "achtzehn", "neunzehn", "zwanzig"]
      .map((w, i) => [w, String(i)])
      .concat([["funf", "5"], ["zwolf", "12"], ["funfzehn", "15"], ["dreissig", "30"], ["vierzig", "40"], ["fuenfzig", "50"], ["funfzig", "50"], ["hundert", "100"], ["tausend", "1000"], ["million", "1000000"]]),
  ),
};

const UMLAUTS: Record<string, [spelled: string, plain: string]> = { ä: ["ae", "a"], ö: ["oe", "o"], ü: ["ue", "u"], æ: ["ae", "ae"], œ: ["oe", "oe"], ø: ["o", "o"], ß: ["ss", "ss"], ł: ["l", "l"], đ: ["d", "d"], ð: ["d", "d"], þ: ["th", "th"], ı: ["i", "i"] };

/**
 * An answer's key: NFKC, lowercase, accents off, umlauts spelled out (or,
 * `plain`, as plain vowels), punctuation, spaces and hyphens off, a
 * leading article off when more words follow, number words as digits.
 */
export function answerKey(text: string, lang: Lang, plain = false): string {
  let s = text.normalize("NFKC").toLowerCase();
  // Umlauts before NFD takes their dots off.
  s = s.normalize("NFC").replace(/[äöüæœøßłđðþı]/g, (c) => UMLAUTS[c]![plain ? 1 : 0]);
  s = s.normalize("NFD").replace(/\p{M}/gu, "");
  let words = s
    .split(/[\s\-‐‑‒–—_/]+/u)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter((w) => w !== "");
  if (words.length > 1 && ARTICLES[baseLang(lang)].includes(words[0]!)) words = words.slice(1);
  const nums = NUMBERS[baseLang(lang)];
  return words.map((w) => (Object.hasOwn(nums, w) ? nums[w]! : w)).join("");
}

/** Doubled letters made single. */
function single(s: string): string {
  return s.replace(/(.)\1+/gu, "$1");
}

/** Optimal string alignment distance (Damerau–Levenshtein with adjacent swaps), on code points. */
export function editDistance(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  const d: number[][] = Array.from({ length: x.length + 1 }, (_, i) => Array.from({ length: y.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= x.length; i++) {
    for (let j = 1; j <= y.length; j++) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && x[i - 1] === y[j - 2] && x[i - 2] === y[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
    }
  }
  return d[x.length]![y.length]!;
}

/** Whether two answers are the same, and why (§5.1); null when they are not. */
export function sameAnswer(a: string, b: string, lang: Lang): Same | null {
  const ka = answerKey(a, lang);
  const kb = answerKey(b, lang);
  if (ka === "" || kb === "") return null;
  if (ka === kb) return "same";
  const pa = answerKey(a, lang, true);
  const pb = answerKey(b, lang, true);
  if (pa === pb || pa === kb || ka === pb) return "spelling";
  if (single(ka) === single(kb) || single(pa) === single(pb)) return "spelling";
  if (lang === "en") {
    const [short, long] = ka.length <= kb.length ? [ka, kb] : [kb, ka];
    if ([...short].length >= 4 && (long === `${short}s` || long === `${short}es`)) return "plural";
  }
  if ([...ka].length >= 6 && [...kb].length >= 6 && editDistance(ka, kb) === 1) return "typo";
  return null;
}

export interface Group {
  /** Indices into the answers given, in their order. */
  members: number[];
  /** With two or more members: the loosest link that joined them. */
  same?: Same | undefined;
}

/**
 * Groups the same answers, transitively; groups in the order of their
 * first member. The strict links are taken first, so a group's reason
 * is the loosest link it could not do without.
 */
export function groupAnswers(texts: readonly string[], lang: Lang): Group[] {
  const parent = texts.map((_, i) => i);
  const reason = texts.map((): Same | null => null);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]!]!;
    return i;
  };
  const edges: { i: number; j: number; r: Same }[] = [];
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const r = sameAnswer(texts[i]!, texts[j]!, lang);
      if (r) edges.push({ i, j, r });
    }
  }
  edges.sort((a, b) => ORDER.indexOf(a.r) - ORDER.indexOf(b.r) || a.i - b.i || a.j - b.j);
  const looser = (a: Same | null, b: Same | null): Same | null => (a === null ? b : b === null ? a : ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b);
  for (const e of edges) {
    const a = find(e.i);
    const b = find(e.j);
    if (a === b) continue;
    const [root, child] = a < b ? [a, b] : [b, a];
    parent[child] = root;
    reason[root] = looser(looser(reason[root]!, reason[child]!), e.r);
  }
  const groups = new Map<number, Group>();
  texts.forEach((_, i) => {
    const r = find(i);
    let g = groups.get(r);
    if (!g) groups.set(r, (g = { members: [] }));
    g.members.push(i);
  });
  return [...groups.entries()].map(([root, g]) => (g.members.length > 1 ? { members: g.members, same: reason[root] ?? "same" } : g));
}
