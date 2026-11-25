/**
 * Classes' rules without a party (docs/classes-design.md): the letters,
 * the subjects, the column lists (§4.1) and their parser, dealing a
 * round's columns by the mix (§4.3), the letter and rule checks (§5.2),
 * the points (§3.4), the grades and remarks of the report cards (§3.6).
 * No imports: the pages may load the built `dist/game/rules.js` for the
 * subjects' names and colours. Known answers in test/rules.test.ts.
 */

/** The room's languages: English, German, Austrian German (German columns, words and Wikipedia; Austria's school and grades). */
export const LANGS = ["en", "de", "at"] as const;
export type Lang = (typeof LANGS)[number];
/** The language of the words: Austrian German is German. */
export type Base = "en" | "de";

/** The column list a language plays: `data/columns.txt`, the German one (`.de`) for German and Austrian rooms. */
export function columnsFile(lang: Lang): string {
  return lang === "en" ? "columns.txt" : "columns.de.txt";
}

/** The language's name in itself (the language setting). */
export const LANG_NAMES: Record<Lang, string> = { en: "English", de: "Deutsch", at: "Österreichisch" };

export function baseLang(lang: Lang): Base {
  return lang === "en" ? "en" : "de";
}

/** A language tag (`de-AT`, `en`, …) as one of {@link LANGS}: `at` and `de-AT` Austrian, other `de…` German, English by default. */
export function pickLang(tag: unknown): Lang {
  if (typeof tag !== "string") return "en";
  const t = tag.toLowerCase();
  if (/^(at|de[-_]at)\b/.test(t)) return "at";
  return t.split(/[-_]/)[0] === "de" ? "de" : "en";
}

/** Fewer in the game at the start of a round: it ends (a duel of two is a game). */
export const MIN_PLAYERS = 2;
/** The "held back?" stamp needs at least this many players (in a duel, second place is no last place). */
export const HELD_MIN = 3;
export const MAX_PLAYERS = 10;
/** An answer at most, after `cleanText` (§3.3). */
export const MAX_ANSWER = 40;
/** A column's text at most (§4.1). */
export const MAX_COLUMN = 40;

// ---------------------------------------------------------------------------
// Randomness

/** A small seeded generator (mulberry32): tests and fixed screenshots. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(items: readonly T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Settings (§2)

export const ROUNDS = [3, 4, 5, 6] as const;
export const COLUMN_COUNTS = [6, 8, 10] as const;
export const TIMES = [90, 120, 180, 300] as const;
export const MIXES = ["school", "mixed", "silly"] as const;
export type Mix = (typeof MIXES)[number];
export const CONTENTS = ["family", "party"] as const;
export type Content = (typeof CONTENTS)[number];
export const LETTER_SETS = ["common", "all"] as const;
export type LetterSet = (typeof LETTER_SETS)[number];
/** Latecomers: straight into the round (`open`), from the next round (`wait`), or not during a game (`closed`). */
export const LATES = ["open", "wait", "closed"] as const;
export type Late = (typeof LATES)[number];

/** The room's settings, as `room.settings` has them (`stop` and `classic` are booleans). */
export interface Settings {
  rounds: number;
  columns: number;
  time: number;
  mix: Mix;
  content: Content;
  stop: boolean;
  classic: boolean;
  letters: LetterSet;
  late: Late;
}

export const DEFAULT_SETTINGS: Settings = { rounds: 4, columns: 8, time: 120, mix: "mixed", content: "family", stop: true, classic: false, letters: "common", late: "open" };

/** The choices of each setting, for checking the `settings` action and the host page. */
export const SETTING_CHOICES: { [K in keyof Settings]: readonly Settings[K][] } = {
  rounds: ROUNDS,
  columns: COLUMN_COUNTS,
  time: TIMES,
  mix: MIXES,
  content: CONTENTS,
  stop: [true, false],
  classic: [true, false],
  letters: LETTER_SETS,
  late: LATES,
};

/**
 * Reads settings sent by a phone (or the host page): every key known and
 * every value one of its choices, else an error naming the first wrong
 * one (nothing is taken then). `lang` too, against `langs`.
 */
export function readSettings(data: unknown, langs: readonly Lang[]): { ok: true; settings: Partial<Settings> & { lang?: Lang } } | { ok: false; error: string } {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return { ok: false, error: "settings: an object" };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (k === "lang") {
      if (!langs.includes(v as Lang)) return { ok: false, error: `lang: ${langs.join(", ")}` };
      out[k] = v;
      continue;
    }
    if (!Object.hasOwn(SETTING_CHOICES, k)) return { ok: false, error: `${k}: not a setting` };
    const choices = SETTING_CHOICES[k as keyof Settings] as readonly unknown[];
    if (!choices.includes(v)) return { ok: false, error: `${k}: ${choices.join(", ")}` };
    out[k] = v;
  }
  return { ok: true, settings: out as Partial<Settings> & { lang?: Lang } };
}

// ---------------------------------------------------------------------------
// Letters (§3.1)

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
export const COMMON: Record<Base, readonly string[]> = {
  en: "ABCDEFGHIJKLMNOPRSTW".split(""),
  de: "ABCDEFGHIJKLMNOPRSTUVWZ".split(""),
};

/** The letters a game may play: the common ones, or all 26 (never Ä Ö Ü). */
export function letters(lang: Lang, set: LetterSet): string[] {
  return set === "all" ? [...ALPHABET] : [...COMMON[baseLang(lang)]];
}

// ---------------------------------------------------------------------------
// Subjects (§4.4)

export const SUBJECT_IDS = ["geo", "bio", "home", "music", "media", "sport", "social", "lang", "break", "trip", "register", "detention"] as const;
export type Subject = (typeof SUBJECT_IDS)[number];

export interface SubjectInfo {
  id: Subject;
  /** Every column of it counts as funny for the mix. */
  funny: boolean;
  /** The exercise book's cover colour. */
  color: string;
  name: Record<Base, string>;
}

export const SUBJECTS: Record<Subject, SubjectInfo> = {
  geo: { id: "geo", funny: false, color: "#2f6fc0", name: { en: "Geography", de: "Erdkunde" } },
  bio: { id: "bio", funny: false, color: "#3c9a46", name: { en: "Biology", de: "Biologie" } },
  home: { id: "home", funny: false, color: "#e8811e", name: { en: "Home economics", de: "Hauswirtschaft" } },
  music: { id: "music", funny: false, color: "#7b4bc4", name: { en: "Music", de: "Musik" } },
  media: { id: "media", funny: false, color: "#d9478f", name: { en: "Art & media", de: "Kunst & Medien" } },
  sport: { id: "sport", funny: false, color: "#d23a2f", name: { en: "PE", de: "Sport" } },
  social: { id: "social", funny: false, color: "#8a5a35", name: { en: "Social studies", de: "Sozialkunde" } },
  lang: { id: "lang", funny: false, color: "#e9c22c", name: { en: "English", de: "Deutsch" } },
  break: { id: "break", funny: true, color: "#6fb8e6", name: { en: "Break", de: "Pause" } },
  trip: { id: "trip", funny: true, color: "#1f9c95", name: { en: "School trip", de: "Klassenfahrt" } },
  register: { id: "register", funny: true, color: "#8c8f94", name: { en: "Register", de: "Klassenbuch" } },
  detention: { id: "detention", funny: true, color: "#26272b", name: { en: "Detention", de: "Nachsitzen" } },
};

export function isSubject(s: unknown): s is Subject {
  return typeof s === "string" && (SUBJECT_IDS as readonly string[]).includes(s);
}

// ---------------------------------------------------------------------------
// Columns (§4.1)

export const RULES = ["ends", "double", "two", "long"] as const;
export type Rule = (typeof RULES)[number];

export interface Column {
  subject: Subject;
  /** As written in the list, `{player}` or `{player's}` left in. */
  text: string;
  party: boolean;
  funny: boolean;
  any: boolean;
  classic?: 1 | 2 | 3 | undefined;
  rule?: Rule | undefined;
  /** In the German list: dealt only in German (`de`) or only in Austrian (`at`) rooms. */
  only?: "de" | "at" | undefined;
  /** Example answers by letter (A–Z). */
  examples: Record<string, string[]>;
  /** The line in the list (1-based). */
  line: number;
}

/** A column's identity in the room's memory of what was played. */
export function columnKey(c: Pick<Column, "subject" | "text">): string {
  return `${c.subject}:${c.text}`;
}

/** Counts as funny for the mix: tagged, or a funny subject; never a rule column (§5.2). */
export function isFunny(c: Column): boolean {
  return !c.rule && (c.funny || SUBJECTS[c.subject].funny);
}

/** Only with `content: party`: tagged, or detention. */
export function isParty(c: Column): boolean {
  return c.party || c.subject === "detention";
}

/** Works with the letter: `any`, or an example for it. */
export function worksWith(c: Column, letter: string): boolean {
  return c.any || (c.examples[letter]?.length ?? 0) > 0;
}

/** The common letters of a language the column has examples for. */
export function exampleLetters(c: Column, lang: Lang): string[] {
  return COMMON[baseLang(lang)].filter((l) => (c.examples[l]?.length ?? 0) > 0);
}

/** How many common letters a column without `any` needs examples for (§4.2). */
export const MIN_LETTERS = 12;

/** Dealt at all: `any`, or examples for at least {@link MIN_LETTERS} common letters. */
export function usable(c: Column, lang: Lang): boolean {
  return c.any || exampleLetters(c, lang).length >= MIN_LETTERS;
}

const PLACEHOLDER = /\{[^}]*\}/g;

/**
 * The column list (`data/columns.txt`, §4.1), for a room's language (the
 * German list serves `de` and `at`: `only:de` and `only:at` lines for one
 * of them). Lines that do not fit are
 * skipped, and so are examples that do not start with their letter or
 * break the column's rule; each is listed in `errors` with its line.
 */
export function parseColumns(text: string, lang: Lang, errors: string[] = []): Column[] {
  const out: Column[] = [];
  const seen = new Set<string>();
  let subject: Subject | null = null;
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    const where = `line ${i + 1}`;
    if (!line || line.startsWith("#")) return;
    if (line.startsWith("==")) {
      const id = line.slice(2).trim();
      if (!isSubject(id)) {
        subject = null;
        return void errors.push(`${where}: unknown subject ${id}`);
      }
      subject = id;
      return;
    }
    if (!subject) return void errors.push(`${where}: a column outside a subject`);
    const parts = line.split("|").map((x) => x.trim());
    if (parts.length > 3) return void errors.push(`${where}: more than three fields`);
    const [ctext = "", tags = "", ex = ""] = parts;
    const c: Column = { subject, text: ctext.normalize("NFC"), party: false, funny: false, any: false, examples: {}, line: i + 1 };
    if (!c.text) return void errors.push(`${where}: no text`);
    if ([...c.text].length > MAX_COLUMN) return void errors.push(`${where}: longer than ${MAX_COLUMN} characters`);
    const holders = c.text.match(PLACEHOLDER) ?? [];
    if (holders.length > 1) return void errors.push(`${where}: more than one placeholder`);
    if (holders.some((h) => h !== "{player}" && h !== "{player's}")) return void errors.push(`${where}: unknown placeholder ${holders[0]}`);
    let bad = false;
    for (const tag of tags.split(/\s+/).filter(Boolean)) {
      if (tag === "party") c.party = true;
      else if (tag === "funny") c.funny = true;
      else if (tag === "any") c.any = true;
      else if (tag === "only:de" || tag === "only:at") {
        if (lang === "en") {
          errors.push(`${where}: ${tag} in the English list`);
          bad = true;
        }
        c.only = tag.slice(5) as "de" | "at";
      }
      else if (/^classic:[123]$/.test(tag)) {
        if (subject !== "geo") {
          errors.push(`${where}: classic outside geo`);
          bad = true;
        }
        c.classic = Number(tag.slice(8)) as 1 | 2 | 3;
      } else if (tag.startsWith("rule:") && (RULES as readonly string[]).includes(tag.slice(5))) {
        if (c.rule) {
          errors.push(`${where}: more than one rule`);
          bad = true;
        }
        c.rule = tag.slice(5) as Rule;
      } else {
        errors.push(`${where}: unknown tag ${tag}`);
        bad = true;
      }
    }
    if (bad) return;
    for (const group of ex.split(";").map((x) => x.trim()).filter(Boolean)) {
      const m = /^([A-Za-z])\s*:\s*(.*)$/.exec(group);
      if (!m) {
        errors.push(`${where}: examples "${group.slice(0, 30)}": L: answer, answer`);
        continue;
      }
      const letter = m[1]!.toUpperCase();
      for (const a of m[2]!.split(",").map((x) => x.trim().normalize("NFC")).filter(Boolean)) {
        if ([...a].length > MAX_ANSWER) {
          errors.push(`${where}: example ${a}: longer than ${MAX_ANSWER} characters`);
          continue;
        }
        const strike = autoStrike(a, letter, c.rule, lang);
        if (strike) {
          errors.push(`${where}: example ${a} for ${letter}: ${strike === "letter" ? "does not start with the letter" : `breaks ${strike}`}`);
          continue;
        }
        (c.examples[letter] ??= []).includes(a) || c.examples[letter]!.push(a);
      }
    }
    const key = `${subject}:${c.text.toLocaleLowerCase()}:${c.only ?? ""}`;
    if (seen.has(key)) return void errors.push(`${where}: ${c.text} twice`);
    seen.add(key);
    // A German list read for Austria leaves out what is only Germany's, and the other way round.
    if (c.only && c.only !== lang) return;
    out.push(c);
  });
  return out;
}

// ---------------------------------------------------------------------------
// Names in columns

/** The possessive of a name: English "Anna's", "James'"; German "Annas", "Klaus’". */
export function possessive(name: string, lang: Lang): string {
  if (lang !== "en") return /(s|ß|x|z|ce)$/i.test(name) ? `${name}’` : `${name}s`;
  return /s$/i.test(name) ? `${name}'` : `${name}'s`;
}

/** A column's text with the player's name in (`{player}`, `{player's}`). */
export function fillColumn(text: string, name: string, lang: Lang): string {
  return text.replace("{player's}", possessive(name, lang)).replace("{player}", name);
}

export function hasPlaceholder(text: string): boolean {
  return text.includes("{player}") || text.includes("{player's}");
}

// ---------------------------------------------------------------------------
// Dealing (§3.2, §4.3)

export interface DealOptions {
  letter: string;
  n: number;
  mix: Mix;
  content: Content;
  classic: boolean;
  lang: Lang;
  rng: () => number;
  /** Column keys played this game (never again, the classic three aside). */
  played?: ReadonlySet<string> | undefined;
  /** Column keys the room played recently, the oldest first: dealt last, the latest the very last. */
  recent?: readonly string[] | undefined;
  /** The names of the players in the round, for `{player}`. */
  names?: readonly string[] | undefined;
}

export interface Dealt {
  column: Column;
  /** As the board shows it: `{player}` filled. */
  text: string;
  subject: Subject;
  rule?: Rule | undefined;
}

/** Funny columns a round of `n` deals by the mix. */
export function funnyCount(mix: Mix, n: number): number {
  return mix === "school" ? 1 : mix === "mixed" ? Math.round(n / 4) : Math.round(n / 2);
}

/**
 * A round's columns for a letter. The classic three first (with
 * `classic`), then the mix's funny and knowable columns, at most one
 * rule column, at most two of a subject, at most one register column,
 * party ones only with party content, none played this game, the
 * recently played ones last. When the letter leaves too few, the mix
 * gives way (`gaveWay`), then the limits, then columns played this game
 * come back: a round is short (`columns.length < n`) only when the list
 * has fewer columns for the letter than that.
 */
export function deal(all: readonly Column[], o: DealOptions): { columns: Dealt[]; gaveWay: boolean } {
  const content = (c: Column) => o.content === "party" || !isParty(c);
  const pool = all.filter((c) => usable(c, o.lang) && worksWith(c, o.letter) && content(c));
  const picked: Column[] = [];
  if (o.classic) {
    // City, Country, River every round, whatever the letter (as on the paper sheet).
    for (const k of [1, 2, 3] as const) {
      const c = all.find((x) => x.classic === k && content(x));
      if (c) picked.push(c);
    }
  }
  const classics = new Set(picked);
  const recent = new Map((o.recent ?? []).map((k, i) => [k, i + 1]));
  const ordered = shuffle(
    pool.filter((c) => !classics.has(c)),
    o.rng,
  )
    .map((c, i) => ({ c, i, r: recent.get(columnKey(c)) ?? 0 }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.c);
  const played = o.played ?? new Set<string>();
  const n = Math.min(o.n, picked.length + ordered.length);
  const m = n - picked.length;
  const funny = Math.min(m, funnyCount(o.mix, o.n));
  let gaveWay = false;

  const counts = () => {
    const subj = new Map<Subject, number>();
    for (const c of picked) subj.set(c.subject, (subj.get(c.subject) ?? 0) + 1);
    return { subj, rules: picked.filter((c) => c.rule).length, funny: picked.filter((c) => !classics.has(c) && isFunny(c)).length, rest: picked.filter((c) => !classics.has(c) && !isFunny(c)).length };
  };
  const fits = (c: Column, cap: number, rules: number, again: boolean) => {
    if (picked.includes(c)) return false;
    if (!again && played.has(columnKey(c))) return false;
    const k = counts();
    if ((k.subj.get(c.subject) ?? 0) >= cap) return false;
    if (c.subject === "register" && (k.subj.get("register") ?? 0) >= 1 && cap <= 2) return false;
    if (c.rule && k.rules >= rules) return false;
    return true;
  };
  const take = (want: (c: Column) => boolean, enough: () => boolean, cap: number, rules: number, again: boolean) => {
    for (const c of ordered) {
      if (enough()) return;
      if (want(c) && fits(c, cap, rules, again)) picked.push(c);
    }
  };
  // The mix as it should be.
  take(isFunny, () => counts().funny >= funny, 2, 1, false);
  take((c) => !isFunny(c), () => counts().rest >= m - funny, 2, 1, false);
  // Then it gives way: more of whatever works, looser limits, columns of this game again.
  const full = () => picked.length >= n;
  for (const [cap, rules, again] of [
    [2, 1, false],
    [3, 1, false],
    [Infinity, 2, false],
    [Infinity, Infinity, false],
    [Infinity, Infinity, true],
  ] as const) {
    if (full()) break;
    gaveWay = true;
    take(() => true, full, cap, rules, again);
  }
  const rest = shuffle(
    picked.filter((c) => !classics.has(c)),
    o.rng,
  );
  const names = shuffle(o.names ?? [], o.rng);
  let who = 0;
  const columns = [...picked.filter((c) => classics.has(c)), ...rest].map((c): Dealt => {
    let text = c.text;
    if (hasPlaceholder(text)) text = fillColumn(text, names.length > 0 ? names[who++ % names.length]! : "?", o.lang);
    return { column: c, text, subject: c.subject, ...(c.rule ? { rule: c.rule } : {}) };
  });
  return { columns, gaveWay };
}

// ---------------------------------------------------------------------------
// The letter and the rules (§5.2, §4.1)

export const ARTICLES: Record<Base, readonly string[]> = {
  en: ["the", "a", "an"],
  // A German room also takes off an English "the" (The Beatles): bands and games keep it. Not the other way round.
  de: ["der", "die", "das", "den", "dem", "des", "ein", "eine", "einen", "the"],
};

const SPECIAL: Record<string, string> = { Æ: "A", Ø: "O", Œ: "O", Ł: "L", Đ: "D", Ð: "D", Þ: "T", ß: "S", ẞ: "S", ı: "I" };

/** A letter as A–Z: accents off, Ä Ö Ü as A O U; null when it is no Latin letter. */
export function foldLetter(ch: string): string | null {
  const up = ch.toUpperCase();
  const s = SPECIAL[up] ?? SPECIAL[ch] ?? up.normalize("NFD").replace(/\p{M}/gu, "");
  return /^[A-Z]$/.test(s) ? s : null;
}

/** The words of an answer that have a letter or a digit in them, punctuation around them off. */
function wordsOf(text: string): string[] {
  return text
    .normalize("NFKC")
    .split(/\s+/u)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((w) => w !== "");
}

/** The words that count: a leading article off when more words follow. */
export function answerWords(text: string, lang: Lang): string[] {
  const ws = wordsOf(text);
  if (ws.length > 1 && ARTICLES[baseLang(lang)].includes(ws[0]!.toLowerCase())) ws.shift();
  return ws;
}

function initial(word: string): string | null {
  const c = [...word][0];
  if (c === undefined || !/\p{L}/u.test(c)) return null;
  return foldLetter(c);
}

/** The letter an answer starts with (§5.2), or null (empty, a digit, no Latin letter). */
export function firstLetter(text: string, lang: Lang): string | null {
  const w = answerWords(text, lang)[0];
  return w === undefined ? null : initial(w);
}

/** Generic geographic prefixes (§5.2): before more words, the word after one counts too ("Mount Fuji": F or M). */
export const PREFIXES: Record<Base, readonly (readonly string[])[]> = {
  en: [["mount"], ["mt"], ["lake"], ["river"], ["cape"], ["isle", "of"]],
  de: [["fluss"], ["see"], ["berg"], ["insel"]],
};

/** Clubs' prefixes (§5.2): "FC Basel" counts for F and B. */
export const CLUBS: Record<Base, readonly string[]> = {
  en: ["fc", "afc"],
  de: ["fc", "sc", "sv", "tsv", "tsg", "vfb", "vfl"],
};

/** How many words a prefix at `i` takes (a geographic prefix, a club's, a number), 0 for none. */
function prefixAt(ws: readonly string[], i: number, lang: Lang): number {
  const w = ws[i]!.toLowerCase();
  if (/^\p{N}+$/u.test(w) || CLUBS[baseLang(lang)].includes(w)) return 1;
  for (const pre of PREFIXES[baseLang(lang)]) if (pre.every((p, k) => ws[i + k]?.toLowerCase() === p)) return pre.length;
  return 0;
}

/**
 * The letters an answer may count for: its first word's, and, after a
 * prefix before more words (geographic, a club's, a leading number), the
 * next word's too; prefixes in a row ("1. FC Köln": F and K).
 */
export function answerLetters(text: string, lang: Lang): string[] {
  const ws = answerWords(text, lang);
  const out: string[] = [];
  let i = 0;
  while (i < ws.length) {
    const c = initial(ws[i]!);
    if (c && !out.includes(c)) out.push(c);
    const n = prefixAt(ws, i, lang);
    if (n === 0 || i + n >= ws.length) break;
    i += n;
  }
  return out;
}

export function startsWithLetter(text: string, letter: string, lang: Lang): boolean {
  return answerLetters(text, lang).includes(letter);
}

/** The letters of an answer, folded to A–Z where they fold. */
function lettersOf(text: string): string[] {
  return [...text.normalize("NFKC")].filter((c) => /\p{L}/u.test(c)).map((c) => foldLetter(c) ?? c.toUpperCase());
}

/** Whether an answer obeys a column's rule (it starts with the letter is checked apart). */
export function obeysRule(text: string, letter: string, rule: Rule, lang: Lang): boolean {
  switch (rule) {
    case "ends":
      return lettersOf(text).at(-1) === letter;
    case "double":
      return wordsOf(text).some((w) => /(\p{L})\1/u.test(lettersOf(w).join("")));
    case "two": {
      // Spaces and hyphens separate words; a leading article is not one.
      const ws = answerWords(text.replace(/[-‐‑‒–—]/g, " "), lang);
      return ws.length >= 2 && ws.every((w) => initial(w) === letter);
    }
    case "long":
      return lettersOf(text).length >= (lang === "en" ? 9 : 12);
  }
}

export type Auto = "empty" | "letter" | `rule:${Rule}`;

/** Struck by rule (§3.4): empty, not the letter, or the column's rule; null when it counts. */
export function autoStrike(text: string, letter: string, rule: Rule | undefined, lang: Lang): Auto | null {
  if (wordsOf(text).length === 0) return "empty";
  if (!startsWithLetter(text, letter, lang)) return "letter";
  if (rule && !obeysRule(text, letter, rule, lang)) return `rule:${rule}`;
  return null;
}

/** Scribble lengths for the TV (§3.3): 0 empty, 1 short (< 6 letters), 2 medium (< 15), 3 long. */
export function progressOf(text: string): number {
  const n = [...text].filter((c) => /[\p{L}\p{N}]/u.test(c)).length;
  return n === 0 ? 0 : n < 6 ? 1 : n < 15 ? 2 : 3;
}

// ---------------------------------------------------------------------------
// Points (§3.4)

/** Struck by the room: more than half of the others doubted it (in a duel: the other's one doubt). */
export function struckByRoom(doubts: number, others: number): boolean {
  return doubts * 2 > others;
}

/**
 * The points of each answer of a column: 20 for the only valid answer
 * with one writer, 10 for a valid answer nobody else wrote, 5 each for a
 * valid answer two or more wrote, 0 for the rest.
 */
export function columnPoints(answers: readonly { id: string; who: readonly string[]; auto?: Auto | undefined; struck: boolean }[]): Map<string, number> {
  const valid = answers.filter((a) => !a.auto && !a.struck && a.who.length > 0);
  const out = new Map<string, number>();
  for (const a of answers) out.set(a.id, 0);
  for (const a of valid) out.set(a.id, a.who.length > 1 ? 5 : valid.length === 1 ? 20 : 10);
  return out;
}

/** Competition ranks (1, 2, 2, 4) of totals by id. */
export function ranks(totals: ReadonlyMap<string, number>): Map<string, number> {
  const all = [...totals.values()];
  return new Map([...totals].map(([id, t]) => [id, 1 + all.filter((x) => x > t).length]));
}

// ---------------------------------------------------------------------------
// The report card (§3.6)

/** The grades, best first, and the shares they need (the last grade: below them all): English A–F and German 1–6 alike, Austrian 1–5. */
const GRADES: Record<Lang, { grades: readonly string[]; at: readonly number[] }> = {
  en: { grades: ["A", "B", "C", "D", "E", "F"], at: [1, 0.8, 0.6, 0.4, 0.2] },
  de: { grades: ["1", "2", "3", "4", "5", "6"], at: [1, 0.8, 0.6, 0.4, 0.2] },
  at: { grades: ["1", "2", "3", "4", "5"], at: [1, 0.75, 0.5, 0.25] },
};

/** A subject's grade from its share (points ÷ 10 × columns). */
export function gradeOf(share: number, lang: Lang): string {
  const g = GRADES[lang];
  const i = g.at.findIndex((t) => share >= t - 1e-9);
  return g.grades[i === -1 ? g.grades.length - 1 : i]!;
}

export const REMARKS = ["top", "clown", "twenty", "copy", "facts", "empty", "star", "fine"] as const;
export type Remark = (typeof REMARKS)[number];

export interface CardStats {
  id: string;
  rank: number;
  total: number;
  /** Stars on the answers they wrote. */
  stars: number;
  twenties: number;
  /** Answers they shared with someone (same answer). */
  shared: number;
  /** Answers struck by the room. */
  facts: number;
  /** Empty answers. */
  empty: number;
  /** Stars they gave on answers others starred too. */
  taste: number;
}

/**
 * The teacher's remarks: each to the player(s) with the most (more than
 * none), `top` to rank 1 (with points); at most two a card, in the
 * order of {@link REMARKS}; `fine` for a card without one. A remark every
 * player would get says nothing about anyone and goes to nobody (both of
 * a duel "top of the class" with the same points, everyone with one empty
 * answer), except `copy`: answers shared by everyone were copied by
 * everyone.
 */
export function remarks(stats: readonly CardStats[]): Map<string, Remark[]> {
  const winners = new Map<Remark, Set<string>>();
  winners.set("top", new Set(stats.filter((s) => s.rank === 1 && s.total > 0).map((s) => s.id)));
  const most = (r: Remark, f: (s: CardStats) => number) => {
    const max = Math.max(0, ...stats.map(f));
    winners.set(r, new Set(max > 0 ? stats.filter((s) => f(s) === max).map((s) => s.id) : []));
  };
  most("clown", (s) => s.stars);
  most("twenty", (s) => s.twenties);
  most("copy", (s) => s.shared);
  most("facts", (s) => s.facts);
  most("empty", (s) => s.empty);
  most("star", (s) => s.taste);
  if (stats.length > 1) for (const [r, ids] of winners) if (r !== "copy" && ids.size === stats.length) ids.clear();
  const out = new Map<string, Remark[]>();
  for (const s of stats) {
    const got = REMARKS.filter((r) => winners.get(r)?.has(s.id)).slice(0, 2);
    out.set(s.id, got.length > 0 ? got : ["fine"]);
  }
  return out;
}

/** "Promoted", or "held back?" for the last place (not also the first) with at least {@link HELD_MIN} players. */
export function stampOf(rank: number, ranksAll: readonly number[]): "promoted" | "held" {
  const last = Math.max(...ranksAll);
  return ranksAll.length >= HELD_MIN && rank === last && last > 1 ? "held" : "promoted";
}
