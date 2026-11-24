/**
 * Crosstalk's host page: the game runs here, in tvpipe's window
 * (docs/playshare-design.md). It makes the party on tvpipe's relay, puts
 * the TV page on the TVs the launcher chose, runs the rules (`game/`),
 * and shows the room on tvpipe's standard host page (`HostPage` of
 * @tvpipe/party: the QR code, the TVs, the players with their team, a
 * muted preview of the TV) with Crosstalk's settings (`settings` below:
 * language, clue time, step time, the board, the words, latecomers; the
 * VIP's phone offers the same in the lobby and at the end, and a change
 * there comes back as the game's `settings` event).
 * Bots are for tests: their buttons show only in test mode (`tvpipe game
 * play --dev`) or with `?bots` in the page's URL. The room's dealt words
 * are kept in `localStorage` per language, so no word comes twice until
 * all were dealt. A language whose data files are missing cannot be
 * picked.
 */

import { HostPage, languageField, lateJoinField, preferredLang, type Field } from "@tvpipe/party";

import { bots, type Bot } from "../game/bots.ts";
import { CLUE_TIMES, Crosstalk, FAST_TIMINGS, LATE, STEP_TIMES } from "../game/game.ts";
import { LANGS, matcher, type Lang, type MatchOptions, type WordEntry } from "../game/rules.ts";
import type { Settings } from "../game/views.ts";
import { status, strings } from "./strings.ts";

const robots: Bot[] = [];
const dealtKey = (l: Lang) => `crosstalk:dealt:${l}`;

function loadJson<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}

const seconds = (n: number) => ({ value: n, label: (l: string) => `${new Intl.NumberFormat(l).format(n)} s` });

/** Crosstalk's settings, as the host page shows them. */
function settings(game: Crosstalk, words: Partial<Record<Lang, WordEntry[]>>): Field[] {
  const s = () => game.settings;
  return [
    languageField({ langs: LANGS, get: () => game.lang, set: (lang) => game.configure({ lang }), available: (l) => !!words[l as Lang], unavailable: (l) => strings(l as Lang).noWords }),
    {
      key: "clueTime",
      type: "buttons",
      label: { en: "Time for the clues", de: "Zeit für die Hinweise" },
      choices: CLUE_TIMES.map(seconds),
      get: () => s().clueTime,
      set: (clueTime: number) => game.configure({ clueTime }),
    },
    {
      key: "stepTime",
      type: "buttons",
      label: { en: "Time for each card", de: "Zeit pro Karte" },
      choices: STEP_TIMES.map(seconds),
      get: () => s().stepTime,
      set: (stepTime: number) => game.configure({ stepTime }),
    },
    {
      key: "deal",
      type: "buttons",
      label: { en: "The board", de: "Das Spielfeld" },
      hint: {
        en: "Tangled: a few categories, both teams in each, so themes run into each other. Mixed: any words.",
        de: "Verwoben: wenige Kategorien, beide Teams in jeder, so kommen sich die Themen in die Quere. Gemischt: beliebige Wörter.",
      },
      choices: [
        { value: "tangled", label: { en: "tangled", de: "verwoben" } },
        { value: "mixed", label: { en: "mixed", de: "gemischt" } },
      ],
      get: () => s().deal,
      set: (deal: Settings["deal"]) => game.configure({ deal }),
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
      get: () => s().difficulty,
      set: (difficulty: Settings["difficulty"]) => game.configure({ difficulty }),
    },
    // Latecomers play from the next round, or the game is closed to them (they can still rejoin by name);
    // the phones' view carries it (the VIP's phone changes it too).
    lateJoinField(game.party, LATE, (late) => game.configure({ late: late === "closed" ? "closed" : "wait" })),
  ];
}

/** A language's word list and dictionary (its matcher's files), or nothing when one is missing. */
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
    console.warn(`crosstalk: no ${l}: ${(err as Error).message}`);
    return undefined;
  }
}

async function main(): Promise<void> {
  let lang: Lang = preferredLang("crosstalk", LANGS);
  const page = await HostPage.connect({ name: "crosstalk", title: "Crosstalk", lang });
  const words: Partial<Record<Lang, WordEntry[]>> = {};
  const match: Partial<Record<Lang, MatchOptions>> = {};
  const used: Partial<Record<Lang, string[]>> = {};
  await Promise.all(
    LANGS.map(async (l) => {
      const data = await loadLang(l);
      if (!data) return;
      words[l] = data.words;
      match[l] = data.match;
      used[l] = loadJson<string[]>(dealtKey(l), []);
    }),
  );
  // A German room knows English words too: a banned English translation also in its English forms.
  if (match.de && match.en?.known) match.de = { ...match.de, englishKnown: match.en.known } as MatchOptions;
  if (!words[lang]) lang = LANGS.find((l) => words[l]) ?? "en";
  const party = await page.tvpipe.party({ lateJoin: "wait" });
  const game = new Crosstalk(party, { words, match, used, lang });
  game.on("dealt", (l, list) => {
    try {
      localStorage.setItem(dealtKey(l), JSON.stringify(list));
    } catch {
      // Full or blocked: the deck still works for this session.
    }
  });
  game.open();

  const botIds = new Set<string>();
  /** `n` bots; `names` for people's names (the live check's pictures), else robots'. */
  const addBots = async (n: number, names?: string[]) => {
    const url = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/_tvpipe/ws`;
    const robo = ["Robo", "Pixel", "Gizmo", "Bolt", "Chip", "Sprocket", "Widget", "Servo", "Cog", "Dynamo", "Fuse"];
    const added = await bots(n, {
      url,
      room: party.code,
      key: party.joinKey,
      names: names ?? robo.map((x) => `${x}${robots.length + 1}`),
      think: () => 700 + Math.random() * 2500,
      // Bots cannot read clues: their operatives know the board's colours and miss now and then.
      oracle: (id) => game.key(id),
      miss: 0.25,
    });
    for (const b of added) if (b.client.you) botIds.add(String(b.client.you["id"]));
    robots.push(...added);
  };

  page.run({
    party,
    game,
    lang: () => game.lang,
    settings: settings(game, words),
    status: (l) => status(l as Lang, game.phase, Number(party.room.peek()["round"] ?? 0)),
    startLabel: (l) => (game.phase === "end" ? strings(l as Lang).playAgain : undefined),
    tags: (p, l) => {
      const t = strings(l as Lang);
      const team = game.teamOf(p.id);
      return [...(team ? [t.team(team)] : []), ...(game.isSpymaster(p.id) ? [t.spymaster] : []), ...(botIds.has(p.id) ? [t.bot] : [])];
    },
    bots: addBots,
  });
  game.on("phase", () => page.update());
  game.on("settings", () => page.update());
  // Teams and spymasters change with the phones' taps: the tags follow.
  game.on("teams", () => page.update());
  page.tvpipe.on("closing", () => {
    for (const b of robots) b.close();
  });
  await page.castChosen();
  // For checks and tests (DevTools): the party and the game; `?fast` plays with short timers.
  if (new URLSearchParams(location.search).has("fast")) game.configure({ timings: FAST_TIMINGS });
  Object.assign(globalThis, { crosstalk: { party, game, tvpipe: page.tvpipe, page, addBots, robots, FAST_TIMINGS } });
}

void main();
