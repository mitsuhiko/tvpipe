/**
 * Classes' host page: the game runs here, in tvpipe's window
 * (docs/playshare-design.md). It makes the party on tvpipe's relay, puts
 * the TV page on the TVs the launcher chose, runs the rules (`game/`),
 * looks answers up in Wikipedia (`fetch` from here, straight to
 * `{lang}.wikipedia.org`), and shows the room on tvpipe's standard host
 * page (`HostPage` of @tvpipe/party) with every setting of the design's
 * §2, plus the teacher's desk: "Skip column" and "End the round". It
 * remembers which columns the room played (`localStorage`), so a new
 * game deals fresh ones. Bots are for tests: their buttons show only in
 * test mode (`tvpipe game play --dev`) or with `?bots` in the page's URL;
 * `?fast` plays with short timers.
 */

import { HostPage, lateJoinField, preferredLang, type Field, type Player } from "@tvpipe/party";

import { Bot, type BotScript } from "../game/bots.ts";
import { Classes, FAST_TIMINGS } from "../game/game.ts";
import { baseLang, columnsFile, COLUMN_COUNTS, LANG_NAMES, LANGS, parseColumns, pickLang, ROUNDS, seeded, TIMES, type Column, type Content, type Lang, type LetterSet, type Mix } from "../game/rules.ts";
import { Wikipedia } from "../game/wiki.ts";
import { hostStrings, status } from "./strings.ts";

const robots: Bot[] = [];
const botNames = new Set<string>();
const RECENT_KEY = (l: Lang) => `classes:recent:${l}`;
/** The most played columns remembered per language (the oldest are forgotten first). */
const RECENT_MAX = 300;

function loadRecent(l: Lang): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY(l)) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function remember(l: Lang, keys: readonly string[]): void {
  try {
    const list = loadRecent(l).filter((k) => !keys.includes(k));
    list.push(...keys);
    localStorage.setItem(RECENT_KEY(l), JSON.stringify(list.slice(-RECENT_MAX)));
  } catch {}
}

/** Every setting of §2, through the game, so the phones see the host's changes (the VIP changes them there too). */
function settings(game: Classes, columns: Partial<Record<Lang, Column[]>>): Field[] {
  const s = () => game.settings;
  return [
    // The room's language: English, German, Austrian German (German with Austria's school; not the library's languageField, which knows no `at`).
    {
      key: "lang",
      label: { en: "Language", de: "Sprache" },
      choices: LANGS.map((l) => ({ value: l, label: { en: `${LANG_NAMES[l]}${l === "at" ? " (Austrian German)" : ""}`, de: LANG_NAMES[l] }, disabled: () => !columns[l]?.length })),
      get: () => game.lang,
      set: (lang: Lang) => game.configure({ lang }),
    },
    {
      key: "rounds",
      type: "buttons",
      label: { en: "Rounds", de: "Runden" },
      choices: ROUNDS.map((n) => ({ value: n, label: String(n) })),
      get: () => s().rounds,
      set: (rounds: number) => game.configure({ rounds }),
    },
    {
      key: "columns",
      type: "buttons",
      label: { en: "Columns per round", de: "Spalten pro Runde" },
      choices: COLUMN_COUNTS.map((n) => ({ value: n, label: String(n) })),
      get: () => s().columns,
      set: (n: number) => game.configure({ columns: n }),
    },
    {
      key: "time",
      type: "buttons",
      label: { en: "Time to write", de: "Zeit zum Schreiben" },
      choices: TIMES.map((n) => ({ value: n, label: { en: `${n} s`, de: `${n} s` } })),
      get: () => s().time,
      set: (time: number) => game.configure({ time }),
    },
    {
      key: "mix",
      type: "buttons",
      label: { en: "Columns", de: "Spalten" },
      hint: { en: "School: mostly knowable ones (City, Animal). Silly: half of them funny.", de: "Schule: meist Wissen (Stadt, Tier). Albern: die Hälfte lustig." },
      choices: [
        { value: "school", label: { en: "school", de: "Schule" } },
        { value: "mixed", label: { en: "mixed", de: "gemischt" } },
        { value: "silly", label: { en: "silly", de: "albern" } },
      ],
      get: () => s().mix,
      set: (mix: Mix) => game.configure({ mix }),
    },
    {
      key: "content",
      type: "buttons",
      label: { en: "Content", de: "Inhalt" },
      hint: { en: "Party also deals the cheeky columns (Detention).", de: "Party nimmt auch die frechen Spalten (Nachsitzen) dazu." },
      choices: [
        { value: "family", label: { en: "family", de: "Familie" } },
        { value: "party", label: { en: "party", de: "Party" } },
      ],
      get: () => s().content,
      set: (content: Content) => game.configure({ content }),
    },
    {
      key: "stop",
      type: "toggle",
      label: { en: "Stop!", de: "Stopp!" },
      hint: { en: "The first to fill every column may raise their hand: 10 s left for everyone.", de: "Wer alle Spalten gefüllt hat, darf sich melden: noch 10 s für alle." },
      get: () => s().stop,
      set: (stop: boolean) => game.configure({ stop }),
    },
    {
      key: "classic",
      type: "toggle",
      label: { en: "Classic start", de: "Klassisch" },
      hint: { en: "Every round starts with City, Country, River.", de: "Jede Runde beginnt mit Stadt, Land, Fluss." },
      get: () => s().classic,
      set: (classic: boolean) => game.configure({ classic }),
    },
    {
      key: "letters",
      type: "buttons",
      label: { en: "Letters", de: "Buchstaben" },
      hint: { en: "All adds the hard ones (Q, X, Y, …).", de: "Alle nimmt die schweren dazu (Q, X, Y, …)." },
      choices: [
        { value: "common", label: { en: "common", de: "übliche" } },
        { value: "all", label: { en: "all", de: "alle" } },
      ],
      get: () => s().letters,
      set: (letters: LetterSet) => game.configure({ letters }),
    },
    // Through the game, so the phones see it (the VIP changes it there too).
    { ...lateJoinField(game.party, ["open", "wait", "closed"]), set: (late) => game.configure({ late }) },
  ];
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  const { class: cls, ...rest } = props;
  if (cls) e.className = cls;
  Object.assign(e, rest);
  e.append(...children);
  return e;
}

/** The teacher's desk: Skip column, End the round. */
function desk(page: HostPage, game: Classes): () => void {
  const box = el("section", { class: "desk" });
  page.parts.main.append(box);
  const draw = () => {
    const t = hostStrings(game.lang);
    const skip = el("button", { textContent: t.skip, disabled: !game.canSkip });
    skip.onclick = () => {
      game.skipColumn();
      draw();
    };
    const end = el("button", { textContent: t.end, disabled: !game.canEnd });
    end.onclick = () => {
      game.endRound();
      draw();
    };
    box.replaceChildren(
      el("h2", {}, t.teacher),
      el("div", { class: "tvh-row" }, skip, el("span", { class: "tvh-muted tvh-small" }, t.skipHint)),
      el("div", { class: "tvh-row" }, end, el("span", { class: "tvh-muted tvh-small" }, t.endHint)),
    );
  };
  draw();
  return draw;
}

async function main(): Promise<void> {
  // The host's last choice or the browser's; a browser in de-AT starts in Austrian German.
  let lang: Lang = preferredLang("classes", LANGS);
  if (lang === "de" && pickLang(navigator.language) === "at") lang = "at";
  const page = await HostPage.connect({ name: "classes", title: "Classes", lang: baseLang(lang) });
  const columns: Partial<Record<Lang, Column[]>> = {};
  await Promise.all(
    LANGS.map(async (l) => {
      const res = await fetch(new URL(`../data/${columnsFile(l)}`, import.meta.url));
      if (!res.ok) return;
      const errors: string[] = [];
      const list = parseColumns(await res.text(), l, errors);
      if (errors.length > 0) console.warn(`columns (${l}): ${errors.length} lines skipped`, errors.slice(0, 20));
      if (list.length > 0) columns[l] = list;
    }),
  );
  if (!columns[lang]?.length) lang = columns.en?.length ? "en" : "de";
  const party = await page.tvpipe.party({ lateJoin: "open" });
  const game = new Classes(party, {
    columns,
    lang,
    recent: Object.fromEntries(LANGS.map((l) => [l, loadRecent(l)])),
    wiki: new Wikipedia((url, init) => fetch(url, init)),
    isBot: (p: Player) => botNames.has(p.name),
  });
  game.on("dealt", (l, keys) => remember(l, keys));
  game.open();

  /** Bots for test mode and the live check: `names`, how long they think (ms), their `chances`. */
  const addBots = async (n: number, o: { names?: string[]; think?: number; thinks?: number[]; seed?: number; wiki?: number; long?: boolean; chances?: Record<string, number>; scripts?: BotScript[] } = {}) => {
    const url = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/_tvpipe/ws`;
    const names = o.names ?? ["Robo", "Pixel", "Gizmo", "Bolt", "Chip", "Sprocket", "Widget", "Servo", "Cog", "Dynamo"].map((x) => `${x}${robots.length + 1}`);
    for (let i = 0; i < n; i++) {
      const name = names[i % names.length]!;
      botNames.add(name);
      const b = new Bot({
        url,
        room: party.code,
        key: party.joinKey,
        name,
        columns,
        think: () => o.thinks?.[i] ?? o.think ?? 1500 + Math.random() * 4000,
        script: o.scripts?.[i],
        chances: { wiki: o.wiki ?? 0.05, ...o.chances },
        long: o.long,
        ...(o.seed !== undefined ? { rng: seeded(o.seed * 101 + robots.length) } : {}),
      });
      await b.join();
      robots.push(b);
    }
  };

  page.run({
    party,
    game,
    // The page's own texts are English or German.
    lang: () => baseLang(game.lang),
    settings: settings(game, columns),
    status: (l) => {
      const c = game.current;
      return status(l as Lang, game.phase, game.stage, game.round, game.rounds, c?.letter ?? null, c?.col ?? null, c?.columns.length ?? 0);
    },
    tags: (p, l) => (botNames.has(p.name) ? [l === "de" ? "Bot" : "bot"] : []),
    bots: addBots,
  });
  const redraw = desk(page, game);
  const update = () => {
    page.update();
    redraw();
  };
  game.on("settings", update);
  game.on("phase", update);
  page.tvpipe.on("closing", () => {
    for (const b of robots) b.close();
  });
  await page.castChosen();
  if (new URLSearchParams(location.search).has("fast")) game.configure({ timings: FAST_TIMINGS });
  // For checks and tests (DevTools): the party and the game.
  Object.assign(globalThis, { classes: { party, game, tvpipe: page.tvpipe, page, addBots, robots, columns, FAST_TIMINGS } });
}

void main();
