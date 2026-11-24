/**
 * Busted's host page: the game runs here, in tvpipe's window
 * (docs/playshare-design.md). It makes the party on tvpipe's relay, puts
 * the TV page on the TVs the launcher chose, runs the rules (`game/`),
 * and shows the room on tvpipe's standard host page (`HostPage` of
 * @tvpipe/party) with Busted's settings, plus the editor's desk: the
 * suggested questions (the host can spike any), the honorary candidates,
 * and a button to skip the question being asked. It remembers which
 * questions the room played (`localStorage`), so a new game deals fresh
 * ones. Bots are for tests: their buttons show only in test mode
 * (`tvpipe game play --dev`) or with `?bots` in the page's URL.
 */

import { HostPage, languageField, lateJoinField, preferredLang, type Field } from "@tvpipe/party";

import { Bot } from "../game/bots.ts";
import { Busted, FAST_TIMINGS, LATE_JOINS, type Ballots } from "../game/game.ts";
import { LANGS, parseQuestions, type Kind, type Lang, type Level, type Question } from "../game/rules.ts";
import { deskStrings, status } from "./strings.ts";

const robots: Bot[] = [];
const SEEN_KEY = (l: Lang) => `busted:seen:${l}`;
/** The most played questions remembered per language (the oldest are forgotten first). */
const SEEN_MAX = 400;

function loadSeen(l: Lang): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(SEEN_KEY(l)) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function remember(l: Lang, key: string): void {
  try {
    const list = loadSeen(l).filter((k) => k !== key);
    list.push(key);
    localStorage.setItem(SEEN_KEY(l), JSON.stringify(list.slice(-SEEN_MAX)));
  } catch {}
}

/** Busted's settings, as the host page shows them. */
function settings(game: Busted, questions: Partial<Record<Lang, Question[]>>): Field[] {
  const s = () => game.settings;
  return [
    languageField({ langs: LANGS, get: () => game.lang, set: (lang) => game.configure({ lang }), available: (l) => !!questions[l]?.length }),
    {
      key: "rounds",
      type: "buttons",
      label: { en: "Rounds", de: "Runden" },
      hint: { en: "Half of them votes, half of them answers.", de: "Die Hälfte Abstimmungen, die Hälfte Antworten." },
      choices: [6, 8, 10, 12].map((n) => ({ value: n, label: String(n) })),
      get: () => game.rounds,
      set: (rounds: number) => game.configure({ rounds }),
    },
    {
      key: "level",
      type: "buttons",
      label: { en: "Questions", de: "Fragen" },
      hint: { en: "Family: fine with kids and grandparents. Party: cheekier, among friends.", de: "Familie: passt mit Kindern und Großeltern. Party: frecher, unter Freunden." },
      choices: [
        { value: "family", label: { en: "family", de: "Familie" } },
        { value: "party", label: { en: "party", de: "Party" } },
      ],
      get: () => s().level,
      set: (level: Level) => game.configure({ level }),
    },
    {
      key: "ballots",
      type: "buttons",
      label: { en: "Ballots", de: "Stimmzettel" },
      hint: { en: "Open: the count shows who ranked whom. Secret: only the medals.", de: "Offen: die Auszählung zeigt, wer wen gewählt hat. Geheim: nur die Medaillen." },
      choices: [
        { value: "open", label: { en: "open", de: "offen" } },
        { value: "secret", label: { en: "secret", de: "geheim" } },
      ],
      get: () => s().ballots,
      set: (ballots: Ballots) => game.configure({ ballots }),
    },
    {
      key: "writeTime",
      label: { en: "Time to write an answer", de: "Zeit für eine Antwort" },
      choices: [45, 60, 90].map((n) => ({ value: n, label: { en: `${n} seconds`, de: `${n} Sekunden` } })),
      get: () => s().writeTime,
      set: (writeTime: number) => game.configure({ writeTime }),
    },
    // Through the game, so the phones see it (the VIP changes it there too).
    { ...lateJoinField(game.party, LATE_JOINS), set: (lateJoin) => game.configure({ lateJoin }) },
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

/** The editor's desk on the host page: skip, honorary candidates, suggestions. */
function desk(page: HostPage, game: Busted): () => void {
  const box = el("section", { class: "desk" });
  page.parts.main.append(box);
  const draw = () => {
    const t = deskStrings(game.lang);
    const skip = el("button", { textContent: t.skip, disabled: !game.canSkip });
    skip.onclick = () => {
      game.skip();
      draw();
    };
    const input = el("input", { placeholder: t.extraPlaceholder, maxLength: 16 });
    const add = el("button", { textContent: t.add, disabled: game.running || game.extras.length >= 3 });
    const err = el("p", { class: "tvh-muted tvh-small" });
    add.onclick = () => {
      try {
        game.addExtra(input.value);
        input.value = "";
      } catch (e) {
        err.textContent = (e as Error).message;
      }
    };
    input.onkeydown = (e) => {
      if (e.key === "Enter") add.click();
    };
    input.disabled = game.running;
    const extras = el(
      "ul",
      { class: "tvh-list" },
      ...game.extras.map((x) => {
        const rm = el("button", { class: "tvh-act", textContent: "✕", disabled: game.running });
        rm.onclick = () => game.removeExtra(x.id);
        return el("li", {}, el("span", { class: "tvh-who" }, x.name), rm);
      }),
    );
    const open = game.suggestions.filter((s) => s.state === "pending" || s.state === "approved");
    const tips = el(
      "ul",
      { class: "tvh-list tips" },
      ...(open.length === 0
        ? [el("li", { class: "tvh-empty" }, t.noTips)]
        : open.map((s) => {
            const rm = el("button", { class: "tvh-act", textContent: t.spike });
            rm.onclick = () => game.dropSuggestion(s.id);
            const kind: Record<Kind, string> = { vote: t.vote, answer: t.answer };
            return el(
              "li",
              {},
              el(
                "span",
                { class: "tip" },
                el("b", {}, s.text),
                el("span", { class: "tvh-muted tvh-small" }, `${kind[s.kind]}${s.title ? ` · „${s.title}“` : ""} · ${s.author} · 👍 ${s.ups} 👎 ${s.downs} · ${s.state === "approved" ? t.approved : t.pending}`),
              ),
              rm,
            );
          })),
    );
    box.replaceChildren(
      el("h2", {}, t.desk),
      el("div", { class: "tvh-row" }, skip, el("span", { class: "tvh-muted tvh-small" }, t.skipHint)),
      el("h2", {}, t.extras),
      el("p", { class: "tvh-muted tvh-small" }, t.extrasHint),
      extras,
      el("div", { class: "tvh-row" }, input, add),
      err,
      el("h2", {}, t.tips),
      el("p", { class: "tvh-muted tvh-small" }, t.tipsHint),
      tips,
    );
  };
  draw();
  return draw;
}

async function main(): Promise<void> {
  let lang: Lang = preferredLang("busted", LANGS);
  const page = await HostPage.connect({ name: "busted", title: "Busted", lang });
  const questions: Partial<Record<Lang, Question[]>> = {};
  await Promise.all(
    LANGS.map(async (l) => {
      const res = await fetch(new URL(`../data/questions${l === "en" ? "" : `.${l}`}.txt`, import.meta.url));
      if (res.ok) questions[l] = parseQuestions(await res.text());
    }),
  );
  if (!questions[lang]?.length) lang = "en";
  const party = await page.tvpipe.party({ lateJoin: "wait" });
  const game = new Busted(party, { questions, lang, rounds: 8, seen: Object.fromEntries(LANGS.map((l) => [l, loadSeen(l)])) });
  game.on("seen", (l, key) => remember(l, key));
  game.open();

  /** Bots for test mode and the live check: `names`, their `answers`, their `suggest`ions, how long they think (ms). */
  const addBots = async (n: number, o: { names?: string[]; answers?: string[][]; suggest?: { kind: Kind; text: string; title?: string }[][]; think?: number; portrait?: boolean; favor?: string[] } = {}) => {
    const url = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/_tvpipe/ws`;
    const names = o.names ?? ["Robo", "Pixel", "Gizmo", "Bolt", "Chip", "Sprocket", "Widget", "Servo", "Cog", "Dynamo", "Fuse"].map((x) => `${x}${robots.length + 1}`);
    for (let i = 0; i < n; i++) {
      const b = new Bot({
        url,
        room: party.code,
        key: party.joinKey,
        name: names[i % names.length]!,
        think: () => o.think ?? 1500 + Math.random() * 4000,
        answers: o.answers?.[i],
        suggest: o.suggest?.[i],
        portrait: o.portrait ?? true,
        favor: o.favor,
        rate: "random",
      });
      await b.join();
      robots.push(b);
    }
  };

  page.run({
    party,
    game,
    lang: () => game.lang,
    settings: settings(game, questions),
    status: (l) => status(l as Lang, game.phase, game.stage, game.round, game.asked?.kind ?? null),
    bots: addBots,
  });
  const redraw = desk(page, game);
  const update = () => {
    page.update();
    redraw();
  };
  game.on("settings", update);
  game.on("phase", update);
  game.on("desk", redraw);
  page.tvpipe.on("closing", () => {
    for (const b of robots) b.close();
  });
  await page.castChosen();
  // For checks and tests (DevTools): the party and the game; `?fast` plays with short timers.
  if (new URLSearchParams(location.search).has("fast")) game.configure({ timings: FAST_TIMINGS });
  Object.assign(globalThis, { busted: { party, game, tvpipe: page.tvpipe, page, addBots, robots, FAST_TIMINGS } });
}

void main();
