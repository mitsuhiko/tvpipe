/**
 * Jinx's host page: the game runs here, in tvpipe's window
 * (docs/playshare-design.md). It makes the party on tvpipe's relay, puts
 * the TV page on the TVs the launcher chose, runs the rules (`game/`),
 * and shows the room on tvpipe's standard host page (`HostPage` of
 * @tvpipe/party: the QR code, the TVs, the players, a muted preview of
 * the TV) with Jinx's settings (`settings` below: rounds, writing time,
 * words, latecomers; the VIP's phone has them all too, the language as
 * well). Bots are for tests: their buttons show only in test mode
 * (`tvpipe game play --dev`) or with `?bots` in the page's URL. The
 * room's dealt words are kept in `localStorage` per language, so no word
 * comes twice until all were dealt, and so are the room's records (the
 * best bank per game length). The room's language (default: the last
 * choice here, else this browser's) is a setting, changed only between
 * games: the words, the clue matcher, every phone, the TV and this page
 * follow it. A language whose data files are missing cannot be picked.
 */

import { HostPage, languageField, lateJoinField, preferredLang, type Field } from "@tvpipe/party";

import { bots, type Bot } from "../game/bots.ts";
import { Jinx, LATE_JOINS } from "../game/game.ts";
import { LANGS, matcher, type Lang } from "../game/lang.ts";
import type { MatchOptions, WordEntry } from "../game/match.ts";
import type { Difficulty, RoundsSetting } from "../game/rules.ts";
import { status, strings } from "./strings.ts";

const robots: Bot[] = [];
/** Every language's words (the bots' categories). */
let allWords: WordEntry[] = [];
/** Per language: words for the bots' random clues and wrong guesses. */
const dictWords: Partial<Record<Lang, string[]>> = {};

/** The dealt words per language: English under the old key. */
const dealtKey = (l: Lang) => (l === "en" ? "jinx:dealt" : `jinx:dealt:${l}`);
/** The room's best bank per game length (rounds), every language. */
const RECORDS_KEY = "jinx:records";

function loadJson<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}

/** Jinx's settings, as the host page shows them. */
function settings(game: Jinx, words: Partial<Record<Lang, WordEntry[]>>): Field[] {
  return [
    languageField({
      langs: LANGS,
      get: () => game.lang,
      set: (lang) => game.configure({ lang }),
      available: (l) => !!words[l],
      unavailable: (l) => strings(l as Lang).noWords,
    }),
    {
      key: "rounds",
      label: { en: "Rounds", de: "Runden" },
      choices: [
        { value: "auto", label: { en: "auto: twice up to 5 players", de: "automatisch: zweimal bis 5 Leute" } },
        { value: 1, label: { en: "everyone guesses once", de: "alle raten einmal" } },
        { value: 2, label: { en: "everyone guesses twice", de: "alle raten zweimal" } },
      ],
      get: () => game.rounds,
      set: (rounds: RoundsSetting) => game.configure({ rounds }),
    },
    {
      key: "write",
      type: "buttons",
      label: { en: "Writing time", de: "Schreibzeit" },
      choices: [30, 45, 60, 90].map((n) => ({ value: n, label: (l: string) => `${new Intl.NumberFormat(l).format(n)} s` })),
      get: () => Math.round(game.timings.write / 1000),
      set: (s: number) => game.configure({ write: s * 1000 }),
    },
    {
      key: "difficulty",
      type: "buttons",
      label: { en: "Words", de: "Wörter" },
      choices: [
        { value: "easy", label: { en: "easy", de: "leicht" } },
        { value: "normal", label: { en: "normal", de: "normal" } },
        { value: "hard", label: { en: "hard", de: "schwer" } },
      ],
      get: () => game.difficulty,
      set: (difficulty: Difficulty) => game.configure({ difficulty }),
    },
    // Latecomers play from the next round, or the game is closed to them (they can still rejoin by name).
    // Through the game, so the phones (the VIP's settings) see it.
    { ...lateJoinField(game.party, LATE_JOINS), set: (late: (typeof LATE_JOINS)[number]) => game.configure({ late }) },
  ];
}

/** A language's data files (its matcher's `files`), or nothing when one is missing. */
async function loadLang(l: Lang): Promise<{ words: WordEntry[]; match: MatchOptions } | undefined> {
  const m = matcher(l);
  try {
    const [wordsText, dictText] = await Promise.all(
      [m.files.words, m.files.dict].map(async (f) => {
        const res = await fetch(new URL(`../data/${f}`, import.meta.url));
        if (!res.ok) throw new Error(`data/${f}: ${res.status}`);
        return res.text();
      }),
    );
    const words = m.parseWordList(wordsText!);
    return words.length > 0 ? { words, match: m.dictionary(dictText!) } : undefined;
  } catch (err) {
    console.warn(`jinx: no ${l}: ${(err as Error).message}`);
    return undefined;
  }
}

async function main(): Promise<void> {
  let lang: Lang = preferredLang("jinx", LANGS);
  const page = await HostPage.connect({ name: "jinx", title: "Jinx", lang });
  // Every language's words and dictionary (data/words.txt, data/words.de.txt, …).
  const words: Partial<Record<Lang, WordEntry[]>> = {};
  const match: Partial<Record<Lang, MatchOptions>> = {};
  const dealt: Partial<Record<Lang, string[]>> = {};
  await Promise.all(
    LANGS.map(async (l) => {
      const data = await loadLang(l);
      if (!data) return;
      words[l] = data.words;
      match[l] = data.match;
      dealt[l] = loadJson<string[]>(dealtKey(l), []);
      // The bots' random clues and wrong guesses come from the curated word list:
      // the dictionary has names, places and words not for a party's TV.
      dictWords[l] = data.words.map((w) => w.word).filter((w) => /^\p{L}{4,10}$/u.test(w));
    }),
  );
  // A German room knows English words too: none is a German word in disguise, and banned translations match in their English forms.
  if (match.de && match.en?.known) match.de = { ...match.de, englishKnown: match.en.known } as MatchOptions;
  allWords = LANGS.flatMap((l) => words[l] ?? []);
  if (!words[lang]) lang = LANGS.find((l) => words[l]) ?? "en";
  // The settings of before the standard host page, once.
  const old = loadJson<{ rounds?: RoundsSetting; write?: number; difficulty?: Difficulty }>("jinx:settings", {});
  const party = await page.tvpipe.party({ lateJoin: "wait" });
  const game = new Jinx(party, {
    lang,
    words,
    match,
    dealt,
    records: loadJson<Record<number, number>>(RECORDS_KEY, {}),
    rounds: old.rounds ?? "auto",
    difficulty: old.difficulty ?? "normal",
    timings: { write: (old.write ?? 45) * 1000 },
  });
  game.on("dealt", (used, l) => {
    try {
      localStorage.setItem(dealtKey(l), JSON.stringify(used));
    } catch {
      // Full or blocked: the deck still works for this session.
    }
  });
  game.on("record", (rounds, chips) => {
    try {
      localStorage.setItem(RECORDS_KEY, JSON.stringify({ ...loadJson<Record<number, number>>(RECORDS_KEY, {}), [rounds]: chips }));
    } catch {
      // Full or blocked: the record lasts this session.
    }
  });
  game.open();

  const botIds = new Set<string>();
  const addBots = async (n: number) => {
    const url = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/_tvpipe/ws`;
    const names = ["Robo", "Pixel", "Gizmo", "Bolt", "Chip", "Sprocket", "Widget", "Servo"];
    const added = await bots(n, {
      url,
      room: party.code,
      key: party.joinKey,
      names: names.map((x) => `${x}${robots.length + 1}`),
      think: () => 800 + Math.random() * 3000,
      peek: () => game.secret,
      words: allWords,
      dict: dictWords,
    });
    for (const b of added) {
      if (!b.client.you) continue;
      const id = String(b.client.you["id"]);
      game.markBot(id);
      botIds.add(id);
    }
    robots.push(...added);
  };

  page.run({
    party,
    game,
    lang: () => game.lang,
    settings: settings(game, words),
    status: (l) => status(l as Lang, game.phase, Number(party.room.peek()["round"] ?? 0)),
    startLabel: (l) => (game.phase === "end" ? strings(l as Lang).playAgain : undefined),
    tags: (p, l) => (botIds.has(p.id) ? [strings(l as Lang).bot] : []),
    bots: addBots,
  });
  game.on("phase", () => page.update());
  // The VIP changed a setting from the phone (the language too).
  game.on("settings", () => page.update());
  page.tvpipe.on("closing", () => {
    for (const b of robots) b.close();
  });
  await page.castChosen();
  // For checks and tests (DevTools): the party and the game; `dict`, the bots' words per language (the live check's --long gives them long ones).
  Object.assign(globalThis, { jinx: { party, game, tvpipe: page.tvpipe, page, addBots, robots, dict: dictWords } });
}

void main();
