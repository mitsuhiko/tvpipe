/**
 * Snug's host page: the game runs here, in tvpipe's window
 * (docs/playshare-design.md). It makes the party on tvpipe's relay, puts
 * the TV page on the TVs the launcher chose, runs the rules (`game/`),
 * and shows the room on tvpipe's standard host page (`HostPage` of
 * @tvpipe/party: the QR code, the TVs, the players, a preview of the TV)
 * with Snug's settings. Bots are for tests: their buttons show only in
 * test mode (`tvpipe game play --dev`) or with `?bots` in the page's URL.
 */

import { HostPage, languageField, lateJoinField, preferredLang, type Field } from "@tvpipe/party";

import { Bot } from "../game/bots.ts";
import { FAST_TIMINGS, Snug } from "../game/game.ts";
import { LANGS, type Lang, type Level, type Pace } from "../game/rules.ts";
import { status } from "./strings.ts";

const robots: Bot[] = [];

function settings(game: Snug): Field[] {
  return [
    languageField({ langs: LANGS, get: () => game.lang, set: (lang) => game.configure({ lang }) }),
    {
      key: "level",
      type: "buttons",
      label: { en: "Level", de: "Stufe" },
      hint: {
        en: "Where the shapes start; every filled shape makes the next one a little harder. Easy: small pieces, check as often as you like. Normal: 3 checks, a filled shape gives one back. Hard: big pieces, few ways, a check only when a filled shape earns one, lifting a piece costs 3 seconds.",
        de: "Wo die Formen anfangen; jede volle Form macht die nächste etwas schwerer. Leicht: kleine Teile, Prüfen so oft ihr wollt. Normal: 3-mal Prüfen, eine volle Form bringt eins zurück. Schwer: große Teile, wenige Lösungen, Prüfen nur, wenn eine volle Form es verdient, Hochheben kostet 3 Sekunden.",
      },
      choices: [
        { value: "easy", label: { en: "easy", de: "leicht" } },
        { value: "normal", label: { en: "normal", de: "normal" } },
        { value: "hard", label: { en: "hard", de: "schwer" } },
      ],
      get: () => game.settings.level,
      set: (level: Level) => game.configure({ level }),
    },
    {
      key: "pace",
      type: "buttons",
      label: { en: "Clock", de: "Uhr" },
      hint: { en: "How much time the team starts with and gets back for each shape.", de: "Wie viel Zeit das Team am Anfang hat und für jede Form zurückbekommt." },
      choices: [
        { value: "relaxed", label: { en: "relaxed", de: "gemütlich" } },
        { value: "normal", label: { en: "normal", de: "normal" } },
        { value: "rushed", label: { en: "rushed", de: "hektisch" } },
      ],
      get: () => game.settings.pace,
      set: (pace: Pace) => game.configure({ pace }),
    },
    lateJoinField(game.party, ["wait", "closed"]),
  ];
}

async function main(): Promise<void> {
  const lang: Lang = preferredLang("snug", LANGS);
  const page = await HostPage.connect({ name: "snug", title: "Snug", lang });
  const party = await page.tvpipe.party({ lateJoin: "wait" });
  const game = new Snug(party, { lang });
  game.open();

  /** Bots for test mode and the live check: they know where the solution has their pieces, and now and then put one wrong first. */
  const addBots = async (n: number, o: { names?: string[]; think?: number; wrong?: number; silent?: boolean } = {}) => {
    const url = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/_tvpipe/ws`;
    const names = o.names ?? ["Mochi", "Pudding", "Sprinkle", "Taffy", "Bonbon", "Cupcake", "Marzipan"].map((x) => `${x}${robots.length + 1}`);
    for (let i = 0; i < n; i++) {
      const b = new Bot({
        url,
        room: party.code,
        key: party.joinKey,
        name: names[i % names.length]!,
        think: () => o.think ?? 3000 + Math.random() * 6000,
        oracle: (id) => game.homeOf(id),
        wrong: o.wrong ?? 0.25,
        silent: o.silent ?? false,
        point: true,
      });
      await b.join();
      robots.push(b);
    }
  };

  page.run({
    party,
    game,
    lang: () => game.lang,
    settings: settings(game),
    status: (l) => status(l as Lang, game.phase, game.boardNo, game.solved),
    bots: addBots,
  });
  game.on("settings", () => page.update());
  game.on("phase", () => page.update());
  page.tvpipe.on("closing", () => {
    for (const b of robots) b.close();
  });
  await page.castChosen();
  // For checks and tests (DevTools): the party and the game; `?fast` plays with a short clock.
  if (new URLSearchParams(location.search).has("fast")) game.configure({ timings: FAST_TIMINGS });
  Object.assign(globalThis, { snug: { party, game, tvpipe: page.tvpipe, page, addBots, robots, FAST_TIMINGS } });
}

void main();
