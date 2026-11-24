/**
 * Krakel's host page: the game runs here, in tvpipe's window
 * (docs/playshare-design.md). It makes the party on tvpipe's relay, puts
 * the TV page on the TVs the launcher chose, runs the rules (`game/`),
 * and shows the room on tvpipe's standard host page (`HostPage` of
 * @tvpipe/party: the QR code, the TVs, the players, a preview of the TV)
 * with Krakel's settings (`settings` below). Bots are for tests: their
 * buttons show only in test mode (`tvpipe game play --dev`) or with
 * `?bots` in the page's URL.
 */

import { HostPage, languageField, lateJoinField, preferredLang, type Field } from "@tvpipe/party";

import { bots, type Bot } from "../game/bots.ts";
import { FAST_TIMINGS, Krakel, LATE_JOINS } from "../game/game.ts";
import { LANGS, parseCategories, type Category, type Lang } from "../game/rules.ts";
import { status } from "./strings.ts";

const robots: Bot[] = [];

/** Krakel's settings, as the host page shows them. */
function settings(game: Krakel, words: Partial<Record<Lang, Category[]>>): Field[] {
  const s = () => game.settings;
  return [
    languageField({ langs: LANGS, get: () => game.lang, set: (lang) => game.configure({ lang }), available: (l) => !!words[l]?.length }),
    {
      key: "rounds",
      type: "buttons",
      label: { en: "Rounds", de: "Runden" },
      choices: [1, 2, 3, 4].map((n) => ({ value: n, label: String(n) })),
      get: () => game.rounds,
      set: (rounds: number) => game.configure({ rounds }),
    },
    {
      key: "drawTime",
      label: { en: "Time to draw", de: "Zeit zum Zeichnen" },
      choices: [
        { value: 60, label: { en: "1 minute", de: "1 Minute" } },
        { value: 90, label: { en: "1½ minutes", de: "1½ Minuten" } },
        { value: 120, label: { en: "2 minutes", de: "2 Minuten" } },
        { value: 180, label: { en: "3 minutes", de: "3 Minuten" } },
      ],
      get: () => s().drawTime,
      set: (drawTime: number) => game.configure({ drawTime }),
    },
    {
      key: "guessTime",
      label: { en: "Time to guess", de: "Zeit zum Raten" },
      choices: [30, 45, 60, 90].map((n) => ({ value: n, label: { en: `${n} seconds`, de: `${n} Sekunden` } })),
      get: () => s().guessTime,
      set: (guessTime: number) => game.configure({ guessTime }),
    },
    {
      key: "lockout",
      label: { en: "After a wrong guess", de: "Nach einem falschen Tipp" },
      choices: [
        { value: 0, label: { en: "guess on at once", de: "gleich weiterraten" } },
        ...[2, 4, 8].map((n) => ({ value: n, label: { en: `wait ${n} seconds`, de: `${n} Sekunden warten` } })),
      ],
      get: () => s().lockout,
      set: (lockout: number) => game.configure({ lockout }),
    },
    {
      key: "hints",
      type: "toggle",
      label: { en: "Show the letters", de: "Buchstaben zeigen" },
      hint: { en: "Blanks tell how many letters the word has (easier).", de: "Striche zeigen, wie viele Buchstaben das Wort hat (leichter)." },
      get: () => s().hints,
      set: (hints) => game.configure({ hints }),
    },
    {
      key: "mixed",
      type: "toggle",
      label: { en: "Mixed words", de: "Gemischte Wörter" },
      hint: { en: "Every word from another category, not one category a round.", de: "Jedes Wort aus einer anderen Kategorie statt einer Kategorie pro Runde." },
      get: () => s().mixed,
      set: (mixed) => game.configure({ mixed }),
    },
    // The game shows it to the phones (the VIP's settings) and keeps it to these two.
    lateJoinField(game.party, LATE_JOINS, (late) => game.configure({ late: late === "closed" ? "closed" : "wait" })),
  ];
}

async function main(): Promise<void> {
  let lang: Lang = preferredLang("krakel", LANGS);
  const page = await HostPage.connect({ name: "krakel", title: "Krakel", lang });
  const words: Partial<Record<Lang, Category[]>> = {};
  await Promise.all(
    LANGS.map(async (l) => {
      const res = await fetch(new URL(`../data/words${l === "en" ? "" : `.${l}`}.txt`, import.meta.url));
      if (res.ok) words[l] = parseCategories(await res.text());
    }),
  );
  if (!words[lang]?.length) lang = "en";
  const party = await page.tvpipe.party({ lateJoin: "wait" });
  const game = new Krakel(party, { words, lang, rounds: 2 });
  game.open();

  const addBots = async (n: number) => {
    const url = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/_tvpipe/ws`;
    const names = ["Robo", "Pixel", "Gizmo", "Bolt", "Chip", "Sprocket", "Widget", "Servo", "Cog", "Dynamo", "Fuse"];
    const added = await bots(n, {
      url,
      room: party.code,
      key: party.joinKey,
      names: names.map((x) => `${x}${robots.length + 1}`),
      think: () => 1500 + Math.random() * 5000,
      // Bots cannot see drawings: the game tells them the word (they name it somewhere along the replay, sometimes after a wrong guess).
      oracle: (id) => game.meant(id),
    });
    robots.push(...added);
  };

  page.run({
    party,
    game,
    lang: () => game.lang,
    settings: settings(game, words),
    status: (l) => status(l as Lang, game.phase, Number(party.room.peek()["round"] ?? 0)),
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
  Object.assign(globalThis, { krakel: { party, game, tvpipe: page.tvpipe, page, addBots, robots, FAST_TIMINGS } });
}

void main();
