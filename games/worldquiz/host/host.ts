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

import { HostPage, languageField, lateJoinField, preferredLang, type Field, type ToggleField } from "@tvpipe/party";

import { Bot } from "../game/bots.ts";
import { landOf, type Countries, type Shapes } from "../game/data.ts";
import type { FlagColours } from "../game/flagcolours.ts";
import { FAST_TIMINGS, LATE_JOINS, Worldquiz } from "../game/game.ts";
import { KINDS, LANGS, ROUNDS, type Difficulty, type Kind, type Lang, type MapMode, type Mode, type Pool } from "../game/rules.ts";
import { status } from "./strings.ts";

const robots: Bot[] = [];

/** The kinds of challenge as the host page names them (§4), with a line on each. */
const KIND_TEXT: Record<Kind, { label: { en: string; de: string }; hint: { en: string; de: string } }> = {
  capital: { label: { en: "Capital", de: "Hauptstadt" }, hint: { en: "Type the capital of a country.", de: "Die Hauptstadt eines Landes tippen." } },
  flag: { label: { en: "Flag", de: "Flagge" }, hint: { en: "Type the country of a flag.", de: "Das Land zu einer Flagge tippen." } },
  where: { label: { en: "Where is it?", de: "Wo liegt's?" }, hint: { en: "Pin a country on the map.", de: "Ein Land auf der Karte zeigen." } },
  pickflag: { label: { en: "Pick the flag", de: "Welche Flagge?" }, hint: { en: "A country's name: pick its flag among 6 (9 on hard).", de: "Ein Ländername: seine Flagge unter 6 (schwer: 9) wählen." } },
  shape: { label: { en: "Name the shape", de: "Welche Form?" }, hint: { en: "A country's outline on the map, no names: type it.", de: "Der Umriss eines Landes auf der Karte, ohne Namen: tippen, welches." } },
  bigger: { label: { en: "Which is bigger?", de: "Wer hat mehr?" }, hint: { en: "Four countries: the most people, area, height or GDP per person.", de: "Vier Länder: die meisten Einwohner, die größte Fläche, Höhe oder BIP pro Kopf." } },
  guess: { label: { en: "Guess the number", de: "Schätzen" }, hint: { en: "A country's population, area or highest point on a slider; the closest wins.", de: "Einwohner, Fläche oder höchster Punkt eines Landes schätzen; am nächsten gewinnt." } },
  neighbour: { label: { en: "Name a neighbour", de: "Nachbarland" }, hint: { en: "Type any country that borders it.", de: "Irgendein Land tippen, das angrenzt." } },
  odd: { label: { en: "Odd one out", de: "Wer passt nicht?" }, hint: { en: "Four countries, three border a fifth: pick the one that does not.", de: "Vier Länder, drei grenzen an ein fünftes: das wählen, das nicht angrenzt." } },
};

/** One switch per kind of challenge; the last one on stays on. */
function kindFields(game: Worldquiz): ToggleField[] {
  return KINDS.map((kind) => ({
    key: `kind-${kind}`,
    type: "toggle",
    label: KIND_TEXT[kind].label,
    hint: KIND_TEXT[kind].hint,
    get: () => game.settings.kinds.includes(kind),
    set: (on: boolean) => {
      const now = game.settings.kinds;
      const next = on ? [...now, kind] : now.filter((k) => k !== kind);
      if (!next.length) throw new Error(game.lang === "de" ? "Mindestens eine Art bleibt an." : "At least one kind stays on.");
      game.configure({ kinds: next });
    },
  }));
}

/** Worldquiz's settings, as the host page shows them; the VIP's phone has the same (phone/phone.js `settings`, the game's `settings` action). */
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
      hint: {
        en: "Time to answer (90, 60, 30 s), how close a pin or a guess must be, 9 flags to pick from on hard, how alike the wrong choices are.",
        de: "Zeit zum Antworten (90, 60, 30 s), wie nah eine Nadel oder Schätzung sein muss, schwer 9 Flaggen zur Wahl, wie ähnlich die falschen Antworten sind.",
      },
      choices: [
        { value: "easy", label: { en: "easy", de: "leicht" } },
        { value: "normal", label: { en: "normal", de: "normal" } },
        { value: "hard", label: { en: "hard", de: "schwer" } },
      ],
      get: () => s().difficulty,
      set: (difficulty: Difficulty) => game.configure({ difficulty }),
    },
    {
      key: "countries",
      type: "buttons",
      label: { en: "Countries asked", de: "Gefragte Länder" },
      hint: { en: "The challenges ask about the best-known countries (by Wikipedia page views) or all. The cards are always all of them.", de: "Die Herausforderungen fragen nach den bekanntesten Ländern (nach Wikipedia-Aufrufen) oder nach allen. Die Karten sind immer alle." },
      choices: [
        { value: "famous", label: { en: "80 best known", de: "80 bekannteste" } },
        { value: "known", label: { en: "150 best known", de: "150 bekannteste" } },
        { value: "all", label: { en: "all", de: "alle" } },
      ],
      get: () => s().countries,
      set: (countries: Pool) => game.configure({ countries }),
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
    ...kindFields(game),
    // Through the game, so the phones see it (the VIP changes it there too).
    { ...lateJoinField(game.party, LATE_JOINS), set: (lateJoin) => game.configure({ lateJoin }) },
  ];
}

async function main(): Promise<void> {
  const lang: Lang = preferredLang("worldquiz", LANGS);
  const page = await HostPage.connect({ name: "worldquiz", title: "Worldquiz", lang });
  const [countries, shapes, colours] = await Promise.all([
    fetch(new URL("../data/countries.json", import.meta.url)).then((r) => r.json() as Promise<Countries>),
    fetch(new URL("../data/shapes.json", import.meta.url)).then((r) => r.json() as Promise<Shapes>),
    // Only for the hard "pick the flag": without it the nearest flags stand in.
    fetch(new URL("../data/colours.json", import.meta.url))
      .then((r) => r.json() as Promise<{ flags: Record<string, FlagColours> }>)
      .catch(() => ({ flags: {} })),
  ]);
  const party = await page.tvpipe.party({ lateJoin: "wait" });
  const game = new Worldquiz(party, { countries: countries.countries, land: landOf(shapes), colours: new Map(Object.entries(colours.flags)), lang });
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
