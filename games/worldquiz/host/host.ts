/**
 * Worldquiz's host page: the game runs here, in tvpipe's window
 * (docs/playshare-design.md). It loads the cards and the land
 * (`data/countries.json`, `data/shapes.json`), makes the party on
 * tvpipe's relay, puts the TV page on the TVs the launcher chose, runs
 * the rules (`game/`), and shows the room on tvpipe's standard host page
 * (`HostPage` of @tvpipe/party) with Worldquiz's settings (`settings`
 * below). Bots are for tests: their buttons show only in test mode
 * (`tvpipe game play --dev`) or with `?bots` in the page's URL.
 */

import { HostPage, languageField, lateJoinField, preferredLang, type Field } from "@tvpipe/party";

import { Bot } from "../game/bots.ts";
import { landOf, type Countries, type Shapes } from "../game/data.ts";
import { FAST_TIMINGS, Worldquiz } from "../game/game.ts";
import { LANGS, ROUNDS, type Difficulty, type Lang, type MapMode, type Mode } from "../game/rules.ts";
import { status } from "./strings.ts";

const robots: Bot[] = [];

/** Worldquiz's settings, as the host page shows them. */
function settings(game: Worldquiz): Field[] {
  const s = () => game.settings;
  return [
    languageField({ langs: LANGS, get: () => game.lang, set: (lang) => game.configure({ lang }) }),
    {
      key: "mode",
      type: "buttons",
      label: { en: "Game", de: "Spiel" },
      hint: { en: "With cards: the captain compares numbers or calls a challenge. Questions only: a challenge for everyone every round.", de: "Mit Karten: Der Kapitän vergleicht Zahlen oder ruft eine Frage aus. Nur Fragen: jede Runde eine Frage für alle." },
      choices: [
        { value: "cards", label: { en: "with cards", de: "mit Karten" } },
        { value: "quiz", label: { en: "questions only", de: "nur Fragen" } },
      ],
      get: () => s().mode,
      set: (mode: Mode) => game.configure({ mode }),
    },
    {
      key: "rounds",
      type: "buttons",
      label: { en: "Rounds", de: "Runden" },
      hint: { en: "With cards rounded up so that everyone is captain equally often.", de: "Mit Karten aufgerundet, damit alle gleich oft Kapitän sind." },
      choices: ROUNDS.map((n) => ({ value: n, label: String(n) })),
      get: () => s().rounds,
      set: (rounds: number) => game.configure({ rounds }),
    },
    {
      key: "difficulty",
      type: "buttons",
      label: { en: "Difficulty", de: "Schwierigkeit" },
      hint: { en: "Time to answer (90, 60, 30 s), how well known the challenges' countries are, how close a pin must be.", de: "Zeit zum Antworten (90, 60, 30 s), wie bekannt die Länder der Herausforderungen sind, wie nah eine Nadel sein muss." },
      choices: [
        { value: "easy", label: { en: "easy", de: "leicht" } },
        { value: "normal", label: { en: "normal", de: "normal" } },
        { value: "hard", label: { en: "hard", de: "schwer" } },
      ],
      get: () => s().difficulty,
      set: (difficulty: Difficulty) => game.configure({ difficulty }),
    },
    {
      key: "map",
      type: "buttons",
      label: { en: "TV map", de: "Karte im Fernseher" },
      choices: [
        { value: "flat", label: { en: "flat", de: "flach" } },
        { value: "globe", label: { en: "globe", de: "Globus" } },
      ],
      get: () => s().map,
      set: (map: MapMode) => game.configure({ map }),
    },
    {
      key: "disputed",
      type: "toggle",
      label: { en: "Disputed states", de: "Umstrittene Staaten" },
      hint: { en: "Kosovo, Palestine, Taiwan and Western Sahara as cards and neighbours.", de: "Kosovo, Palästina, Taiwan und Westsahara als Karten und Nachbarn." },
      get: () => s().disputed,
      set: (disputed) => game.configure({ disputed }),
    },
    lateJoinField(game.party, ["wait", "closed"]),
  ];
}

async function main(): Promise<void> {
  const lang: Lang = preferredLang("worldquiz", LANGS);
  const page = await HostPage.connect({ name: "worldquiz", title: "Worldquiz", lang });
  const [countries, shapes] = await Promise.all([
    fetch(new URL("../data/countries.json", import.meta.url)).then((r) => r.json() as Promise<Countries>),
    fetch(new URL("../data/shapes.json", import.meta.url)).then((r) => r.json() as Promise<Shapes>),
  ]);
  const party = await page.tvpipe.party({ lateJoin: "wait" });
  const game = new Worldquiz(party, { countries: countries.countries, land: landOf(shapes), lang });
  game.open();

  /** Bots for test mode and the live check: `names`, how `sharp` they are (0–1) and how long they think (ms). */
  const addBots = async (n: number, o: { names?: string[]; sharp?: number; think?: number; competes?: number } = {}) => {
    const url = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/_tvpipe/ws`;
    const names = o.names ?? ["Robo", "Pixel", "Gizmo", "Bolt", "Chip", "Sprocket", "Widget", "Servo", "Cog"].map((x) => `${x}${robots.length + 1}`);
    for (let i = 0; i < n; i++) {
      const b = new Bot({
        url,
        room: party.code,
        key: party.joinKey,
        name: names[i % names.length]!,
        think: () => o.think ?? 1500 + Math.random() * 4000,
        oracle: () => game.truth(),
        sharp: o.sharp ?? 0.5,
        competes: o.competes,
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
    status: (l) => status(l as Lang, game.phase, game.stage, Number(party.room.peek()["round"] ?? 0), game.rounds),
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
  Object.assign(globalThis, { worldquiz: { party, game, tvpipe: page.tvpipe, page, addBots, robots, FAST_TIMINGS } });
}

void main();
