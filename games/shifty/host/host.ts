/**
 * Shifty's host page: the game runs here, in tvpipe's window
 * (docs/playshare-design.md). It makes the party on tvpipe's relay, puts
 * the TV page on the TVs the launcher chose, runs the rules (`game/`),
 * and shows the room on tvpipe's standard host page (`HostPage` of
 * @tvpipe/party: the QR code, the TVs, the players, a preview of the TV)
 * with Shifty's settings (`settings` below). Bots are for tests: their
 * buttons show only in test mode (`tvpipe game play --dev`) or with
 * `?bots` in the page's URL.
 */

import { HostPage, languageField, lateJoinField, preferredLang, type Field } from "@tvpipe/party";

import { Bot } from "../game/bots.ts";
import { FAST_TIMINGS, LATE, Shifty, type Mode } from "../game/game.ts";
import { LANGS, parseCategories, type Category, type Lang } from "../game/rules.ts";
import { status } from "./strings.ts";

const robots: Bot[] = [];

/** Shifty's settings, as the host page shows them; the VIP's phone has the same (game.ts, the `settings` action). */
function settings(game: Shifty, words: Partial<Record<Lang, Category[]>>): Field[] {
  const s = () => game.settings;
  return [
    languageField({ langs: LANGS, get: () => game.lang, set: (lang) => game.configure({ lang }), available: (l) => !!words[l]?.length }),
    {
      key: "rounds",
      type: "buttons",
      label: { en: "Rounds", de: "Runden" },
      choices: [3, 4, 5, 6].map((n) => ({ value: n, label: String(n) })),
      get: () => game.rounds,
      set: (rounds: number) => game.configure({ rounds }),
    },
    {
      key: "mode",
      type: "buttons",
      label: { en: "Clues", de: "Hinweise" },
      choices: [
        { value: "typed", label: { en: "typed", de: "getippt" } },
        { value: "spoken", label: { en: "out loud", de: "laut gesagt" } },
      ],
      get: () => s().mode,
      set: (mode: Mode) => game.configure({ mode }),
    },
    {
      key: "clues",
      type: "buttons",
      label: { en: "Clues each", de: "Hinweise pro Person" },
      hint: { en: "Auto: two with up to five players, else one.", de: "Auto: zwei bei bis zu fünf Leuten, sonst einer." },
      choices: [
        { value: 0, label: "auto" },
        { value: 1, label: "1" },
        { value: 2, label: "2" },
      ],
      get: () => s().clues,
      set: (clues: number) => game.configure({ clues }),
    },
    {
      key: "clueTime",
      label: { en: "Time for a clue", de: "Zeit für einen Hinweis" },
      choices: [15, 25, 40].map((n) => ({ value: n, label: { en: `${n} seconds`, de: `${n} Sekunden` } })),
      get: () => s().clueTime,
      set: (clueTime: number) => game.configure({ clueTime }),
    },
    {
      key: "talkTime",
      label: { en: "Time to talk", de: "Zeit zum Reden" },
      choices: [45, 60, 90, 120].map((n) => ({ value: n, label: { en: `${n} seconds`, de: `${n} Sekunden` } })),
      get: () => s().talkTime,
      set: (talkTime: number) => game.configure({ talkTime }),
    },
    {
      key: "typing",
      type: "toggle",
      label: { en: "Show the typing", de: "Tippen zeigen" },
      hint: { en: "The TV shows blank tiles and a lie detector's needle while someone types (never the letters).", de: "Der Fernseher zeigt leere Kästchen und die Nadel eines Lügendetektors, während jemand tippt (nie die Buchstaben)." },
      get: () => s().typing,
      set: (typing) => game.configure({ typing }),
    },
    // The room view carries it too: the VIP's phone shows and sets the same two.
    lateJoinField(game.party, LATE, () => game.configure({})),
  ];
}

async function main(): Promise<void> {
  let lang: Lang = preferredLang("shifty", LANGS);
  const page = await HostPage.connect({ name: "shifty", title: "Shifty", lang });
  const words: Partial<Record<Lang, Category[]>> = {};
  await Promise.all(
    LANGS.map(async (l) => {
      const res = await fetch(new URL(`../data/words${l === "en" ? "" : `.${l}`}.txt`, import.meta.url));
      if (res.ok) words[l] = parseCategories(await res.text());
    }),
  );
  if (!words[lang]?.length) lang = "en";
  const party = await page.tvpipe.party({ lateJoin: "wait" });
  const game = new Shifty(party, { words, lang, rounds: 4 });
  game.open();

  /**
   * Bots for test mode and the live check: `names` and per-bot `clues`
   * (the live check's scripted round), how `sharp` they are (0–1) and
   * how long they think (ms).
   */
  const addBots = async (n: number, o: { names?: string[]; clues?: string[][]; sharp?: number; think?: number } = {}) => {
    const url = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/_tvpipe/ws`;
    const names = o.names ?? ["Robo", "Pixel", "Gizmo", "Bolt", "Chip", "Sprocket", "Widget", "Servo", "Cog", "Dynamo", "Fuse"].map((x) => `${x}${robots.length + 1}`);
    for (let i = 0; i < n; i++) {
      const b = new Bot({
        url,
        room: party.code,
        key: party.joinKey,
        name: names[i % names.length]!,
        think: () => o.think ?? 1500 + Math.random() * 4000,
        clues: o.clues?.[i],
        // The host knows the phony and the word: bots accuse and guess right now and then.
        oracle: () => (game.round ? { phony: game.round.phony, secret: game.round.secret } : undefined),
        sharp: o.sharp ?? 0.35,
      });
      await b.join();
      robots.push(b);
    }
  };

  page.run({
    party,
    game,
    lang: () => game.lang,
    settings: settings(game, words),
    status: (l) => status(l as Lang, game.phase, game.stage, Number(party.room.peek()["round"] ?? 0)),
    bots: addBots,
  });
  game.on("settings", () => page.update());
  game.on("phase", () => page.update());
  page.tvpipe.on("closing", () => {
    for (const b of robots) b.close();
  });
  await page.castChosen();
  // For checks and tests (DevTools): the party and the game; `?fast` plays with short timers.
  if (new URLSearchParams(location.search).has("fast")) game.configure({ timings: FAST_TIMINGS });
  Object.assign(globalThis, { shifty: { party, game, tvpipe: page.tvpipe, page, addBots, robots, FAST_TIMINGS } });
}

void main();
