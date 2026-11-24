/**
 * Garble's host page: the game runs here, in tvpipe's window
 * (docs/playshare-design.md). It makes the party on tvpipe's relay, puts
 * the TV page on the TVs the launcher chose, runs the rules (`game/`),
 * and shows the room on tvpipe's standard host page (`HostPage` of
 * @tvpipe/party: the QR code, the TVs, the players, a preview of the TV)
 * with Garble's settings (`settings` below). Bots are for tests: their
 * buttons show only in test mode (`tvpipe game play --dev`) or with
 * `?bots` in the page's URL.
 */

import { HostPage, languageField, lateJoinField, preferredLang, type Field } from "@tvpipe/party";

import { bots, type Bot } from "../game/bots.ts";
import { DEFAULT_TIMINGS, FAST_TIMINGS, Garble, LATE_JOIN, ROUNDS } from "../game/game.ts";
import { LANGS, LENGTHS, parseWords, type Lang, type Word } from "../game/rules.ts";
import { status } from "./strings.ts";

const robots: Bot[] = [];

/** Garble's settings, as the host page shows them (the VIP's phone has them all too: the `settings` action). */
function settings(game: Garble, words: Partial<Record<Lang, Word[]>>): Field[] {
  return [
    languageField({ langs: LANGS, get: () => game.lang, set: (lang) => game.configure({ lang }), available: (l) => !!words[l]?.length }),
    {
      key: "rounds",
      type: "buttons",
      label: { en: "Rounds", de: "Runden" },
      choices: ROUNDS.map((n) => ({ value: n, label: String(n) })),
      get: () => game.rounds,
      set: (rounds: number) => game.configure({ rounds }),
    },
    {
      key: "length",
      type: "buttons",
      label: { en: "Layers per picture", de: "Schichten pro Bild" },
      hint: { en: "3 is short, 7 long; at most one less than the players.", de: "3 ist kurz, 7 lang; höchstens eine weniger als Spieler da sind." },
      choices: LENGTHS.map((n) => ({ value: n, label: String(n) })),
      get: () => game.settings.length,
      set: (length: number) => game.configure({ length }),
    },
    {
      key: "timers",
      label: { en: "Timers", de: "Zeit" },
      choices: [
        { value: "normal", label: { en: "normal", de: "normal" } },
        { value: "fast", label: { en: "fast", de: "schnell" } },
      ],
      get: () => game.pace,
      set: (v: string) => game.configure({ timings: v === "fast" ? FAST_TIMINGS : DEFAULT_TIMINGS }),
    },
    // The phones show who may join late too: the game sets it and its views.
    lateJoinField(game.party, LATE_JOIN, (late) => game.configure({ late })),
    {
      key: "undo",
      type: "toggle",
      label: { en: "Undo", de: "Rückgängig" },
      hint: { en: "Players can take their own strokes back. Off: every stroke counts.", de: "Eigene Striche lassen sich zurücknehmen. Aus: Jeder Strich zählt." },
      get: () => game.settings.undo,
      set: (undo) => game.configure({ undo }),
    },
  ];
}

async function main(): Promise<void> {
  let lang: Lang = preferredLang("garble", LANGS);
  const page = await HostPage.connect({ name: "garble", title: "Garble", lang });
  const words: Partial<Record<Lang, Word[]>> = {};
  await Promise.all(
    LANGS.map(async (l) => {
      const res = await fetch(new URL(`../data/words${l === "en" ? "" : `.${l}`}.txt`, import.meta.url));
      if (res.ok) words[l] = parseWords(await res.text());
    }),
  );
  if (!words[lang]?.length) lang = "en";
  const party = await page.tvpipe.party({ lateJoin: "wait" });
  const game = new Garble(party, { words, lang, rounds: 2 });
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
      // Bots cannot see drawings: the game tells them what a layer was meant to be (they still get it wrong now and then).
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
  // For checks and tests (DevTools): the party and the game.
  Object.assign(globalThis, { garble: { party, game, tvpipe: page.tvpipe, page, addBots, robots } });
}

void main();
