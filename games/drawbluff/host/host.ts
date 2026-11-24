/**
 * Drawbluff's host page: the game runs here, in tvpipe's window
 * (docs/playshare-design.md). It makes the party on tvpipe's relay, puts
 * the TV page on the TVs the launcher chose, runs the rules (`game/`),
 * and shows the room on tvpipe's standard host page (`HostPage` of
 * @tvpipe/party: the QR code, the TVs, the players, a preview of the TV)
 * with Drawbluff's settings (`settings` below). Bots are for tests:
 * their buttons show only in test mode (`tvpipe game play --dev`) or with
 * `?bots` in the page's URL. The room's language (default: the last
 * choice here, else this browser's) is a setting: the prompts, every
 * phone, the TV and this page follow it.
 */

import { HostPage, languageField, lateJoinField, preferredLang, type Field } from "@tvpipe/party";

import { bots, type Bot } from "../game/bots.ts";
import { Drawbluff, MAX_ROUNDS, TIMERS, type TimerChoice } from "../game/game.ts";
import { LANGS, parsePrompts, type Lang, type Prompt } from "../game/rules.ts";
import { status } from "./strings.ts";

const robots: Bot[] = [];

/**
 * Drawbluff's settings, as the host page shows them; the VIP's phone has
 * them all too, in the lobby and on the final screen (the game's
 * `settings` and `late-join` actions), and a change there tells this page.
 */
function settings(game: Drawbluff, prompts: Partial<Record<Lang, Prompt[]>>): Field[] {
  const s = () => game.settings;
  return [
    languageField({ langs: LANGS, get: () => game.lang, set: (lang) => game.configure({ lang }), available: (l) => !!prompts[l] }),
    {
      key: "rounds",
      type: "buttons",
      label: { en: "Rounds", de: "Runden" },
      hint: { en: "Every round counts more than the one before.", de: "Jede Runde zählt mehr als die davor." },
      choices: Array.from({ length: MAX_ROUNDS }, (_, i) => ({ value: i + 1, label: String(i + 1) })),
      get: () => game.rounds,
      set: (rounds: number) => game.configure({ rounds }),
    },
    {
      key: "timers",
      label: { en: "Timers", de: "Zeit" },
      choices: [
        { value: "fast", label: { en: "fast", de: "schnell" } },
        { value: "normal", label: { en: "normal", de: "normal" } },
        { value: "slow", label: { en: "slow", de: "langsam" } },
      ],
      get: () => game.timers,
      set: (v: string) => game.configure({ timings: TIMERS[v as TimerChoice] ?? TIMERS.normal }),
    },
    lateJoinField(game.party, ["wait", "open", "closed"], (mode) => game.party.room.set({ lateJoin: mode })),
    {
      key: "animate",
      type: "toggle",
      label: { en: "Animated drawings", de: "Animierte Zeichnungen" },
      hint: { en: "Everyone draws 2 frames that flip back and forth.", de: "Alle zeichnen 2 Bilder, die sich abwechseln." },
      get: () => s().animate,
      set: (animate) => game.configure({ animate }),
    },
    {
      key: "undo",
      type: "toggle",
      label: { en: "Undo", de: "Rückgängig" },
      hint: { en: "Players can take strokes back. Off: every stroke counts.", de: "Striche lassen sich zurücknehmen. Aus: Jeder Strich zählt." },
      get: () => s().undo,
      set: (undo) => game.configure({ undo }),
    },
    {
      key: "colormode",
      type: "toggle",
      label: { en: "Colour mode", de: "Farbmodus" },
      hint: { en: "Black and 4 colours instead of 2 shades of your own colour.", de: "Schwarz und 4 Farben statt 2 Töne der eigenen Farbe." },
      get: () => s().colorMode,
      set: (colorMode) => game.configure({ colorMode }),
    },
    {
      key: "adult",
      type: "toggle",
      label: { en: "Adult prompts (18+)", de: "Begriffe ab 18" },
      hint: { en: "Cheeky, not explicit. Off: family-friendly.", de: "Frech, nicht explizit. Aus: familientauglich." },
      get: () => s().adult,
      set: (adult) => game.configure({ adult }),
      disabled: () => !game.adultOk,
      // Every party starts family-friendly.
      remember: false,
    },
  ];
}

async function main(): Promise<void> {
  let lang: Lang = preferredLang("drawbluff", LANGS);
  const page = await HostPage.connect({ name: "drawbluff", title: "Drawbluff", lang });
  // Every language's prompts (data/prompts.txt, data/prompts.de.txt) and adult ones (data/prompts.adult.txt, …).
  const prompts: Partial<Record<Lang, Prompt[]>> = {};
  const adultPrompts: Partial<Record<Lang, Prompt[]>> = {};
  await Promise.all(
    LANGS.flatMap((l) =>
      [false, true].map(async (adult) => {
        const file = `prompts${adult ? ".adult" : ""}${l === "en" ? "" : `.${l}`}.txt`;
        const res = await fetch(new URL(`../data/${file}`, import.meta.url));
        if (res.ok) (adult ? adultPrompts : prompts)[l] = parsePrompts(await res.text());
      }),
    ),
  );
  if (!prompts[lang]) lang = "en";
  const party = await page.tvpipe.party({ lateJoin: "wait" });
  const game = new Drawbluff(party, { prompts, adultPrompts, lang, rounds: 2 });
  game.open();

  const addBots = async (n: number) => {
    const url = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/_tvpipe/ws`;
    const names = ["Robo", "Pixel", "Gizmo", "Bolt", "Chip", "Sprocket", "Widget", "Servo"];
    const added = await bots(n, {
      url,
      room: party.code,
      key: party.joinKey,
      names: names.map((x) => `${x}${robots.length + 1}`),
      think: () => 800 + Math.random() * 4000,
    });
    robots.push(...added);
  };

  page.run({
    party,
    game,
    lang: () => game.lang,
    settings: settings(game, prompts),
    status: (l) => status(l as Lang, game.phase, Number(party.room.peek()["round"] ?? 0)),
    bots: addBots,
  });
  game.on("settings", () => page.update());
  game.on("phase", () => page.update());
  page.tvpipe.on("closing", () => {
    for (const b of robots) b.close();
  });
  await page.castChosen();
  // For checks and tests (DevTools): the party and the game.
  Object.assign(globalThis, { drawbluff: { party, game, tvpipe: page.tvpipe, page, addBots } });
}

void main();
