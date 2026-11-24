/**
 * Landgrab's host page: the game runs here, in tvpipe's window
 * (docs/playshare-design.md). It makes the party on tvpipe's relay, puts
 * the TV page on the TVs the launcher chose, runs the rules (`game/`),
 * and shows the room on tvpipe's standard host page (`HostPage` of
 * @tvpipe/party: the QR code, the TVs, the players, a preview of the TV)
 * with Landgrab's settings. Bots are for tests: their buttons show only
 * in test mode (`tvpipe game play --dev`) or with `?bots` in the page's
 * URL.
 */

import { HostPage, languageField, lateJoinField, preferredLang, type Field } from "@tvpipe/party";

import { Bot } from "../game/bots.ts";
import { FAST_TIMINGS, LATE, Landgrab, PLAN_TIMES, ROUNDS } from "../game/game.ts";
import { LANGS, type Lang } from "../game/rules.ts";
import { parseWorld } from "../game/world.ts";
import { status } from "./strings.ts";

const robots: Bot[] = [];

function settings(game: Landgrab): Field[] {
  return [
    languageField({ langs: LANGS, get: () => game.lang, set: (lang) => game.configure({ lang }) }),
    {
      key: "rounds",
      type: "buttons",
      label: { en: "Rounds", de: "Runden" },
      hint: { en: "Or until someone holds three quarters of the world.", de: "Oder bis jemand drei Viertel der Welt hält." },
      choices: ROUNDS.map((n) => ({ value: n, label: String(n) })),
      get: () => game.rounds,
      set: (rounds: number) => game.configure({ rounds }),
    },
    {
      key: "planTime",
      label: { en: "Time to plan", de: "Zeit zum Planen" },
      choices: PLAN_TIMES.map((n) => ({ value: n, label: { en: `${n} seconds`, de: `${n} Sekunden` } })),
      get: () => game.planTime,
      set: (planTime: number) => game.configure({ planTime }),
    },
    // The phones see it too (the VIP can change it there).
    lateJoinField(game.party, LATE, (late) => game.configure({ late: late === "closed" ? "closed" : "wait" })),
  ];
}

async function main(): Promise<void> {
  const lang: Lang = preferredLang("landgrab", LANGS);
  const page = await HostPage.connect({ name: "landgrab", title: "Landgrab", lang });
  const res = await fetch(new URL("../data/world.txt", import.meta.url));
  const world = parseWorld(await res.text());
  const party = await page.tvpipe.party({ lateJoin: "wait" });
  const game = new Landgrab(party, { world, lang, rounds: 8 });
  game.open();

  /** Bots for test mode and the live check: `names`, how long they think (ms). */
  const addBots = async (n: number, o: { names?: string[]; think?: number } = {}) => {
    const url = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/_tvpipe/ws`;
    const names = o.names ?? ["Robo", "Pixel", "Gizmo", "Bolt", "Chip", "Sprocket"].map((x) => `${x}${robots.length + 1}`);
    for (let i = 0; i < n; i++) {
      const b = new Bot({ url, room: party.code, key: party.joinKey, name: names[i % names.length]!, world, think: () => o.think ?? 3000 + Math.random() * 9000 });
      await b.join();
      robots.push(b);
    }
  };

  page.run({
    party,
    game,
    lang: () => game.lang,
    settings: settings(game),
    status: (l) => status(l as Lang, game.phase, game.round, game.rounds),
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
  Object.assign(globalThis, { landgrab: { party, game, world, tvpipe: page.tvpipe, page, addBots, robots, FAST_TIMINGS } });
}

void main();
