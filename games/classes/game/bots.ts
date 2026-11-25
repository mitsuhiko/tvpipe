/**
 * Fake players: clients that play Classes by themselves. For the tests
 * (in Node) and the live check: the host page's bot buttons (test mode,
 * or `?bots`) run them in the window, connected through tvpipe like a
 * phone.
 *
 * A bot stops the alphabet when it draws, answers every column from the
 * column list's examples for the letter (sometimes nothing, sometimes a
 * word with the wrong letter, often the first example, so bots share
 * answers now and then), raises its hand now and then when everything is
 * filled, doubts and stars at random with a low probability, and presses
 * Done. With a seeded `rng` it plays the same each time.
 */

import { memoryStorage, PartyClient, type WebSocketFactory } from "@tvpipe/party/client";

import { MIN_PLAYERS, pickLang, seeded, type Column, type Lang } from "./rules.ts";

export interface BotOptions {
  /** The WebSocket URL (`ws://127.0.0.1:PORT/_tvpipe/ws`). */
  url: string;
  WebSocket?: WebSocketFactory | undefined;
  room: string;
  key: string;
  name: string;
  rng?: (() => number) | undefined;
  /** Start the game when VIP and enough players are there. */
  autoStart?: boolean | undefined;
  /** Delay before each act, ms (default 0–300 random). */
  think?: (() => number) | undefined;
  /** Never act (to test deadlines). */
  silent?: boolean | undefined;
  /** Tasks it leaves to the test (`draw`, `write`, `grade`). */
  skip?: readonly string[] | undefined;
  /** The column lists, for the examples. */
  columns?: Partial<Record<Lang, readonly Column[]>> | undefined;
  /** A scripted bot (the live check's pictures): exactly these answers, doubts, stars and Stop!, nothing at random. */
  script?: BotScript | undefined;
  /** The longest answers: each made up to 40 characters (the live check's `--long`). */
  long?: boolean | undefined;
  /** Chances: an empty answer, a wrong letter, the first example, a Stop, a doubt per answer, a star per column, a lookup per column. */
  chances?: Partial<Chances> | undefined;
}

/** What a scripted bot does: answers by column (`""`: nothing), and per column the answers (by their text) it doubts and stars. */
export interface BotScript {
  answers: readonly string[];
  doubts?: Readonly<Record<number, readonly string[]>> | undefined;
  stars?: Readonly<Record<number, string>> | undefined;
  /** Presses Stop! once every column is filled. */
  stop?: boolean | undefined;
}

export interface Chances {
  empty: number;
  wrong: number;
  first: number;
  stop: number;
  doubt: number;
  star: number;
  wiki: number;
}

export const CHANCES: Chances = { empty: 0.1, wrong: 0.08, first: 0.3, stop: 0.3, doubt: 0.1, star: 0.3, wiki: 0 };

const FALLBACK: Record<Lang, string> = { en: "ingo", de: "ingo", at: "ingo" };
/** Words to make an answer 40 characters long (`long`). */
const TAIL: Record<Lang, string> = { en: "with extra cheese and a very long story behind it", de: "mit extra viel Käse und einer langen Geschichte dahinter", at: "mit extra viel Käse und einer langen Geschichte dahinter" };

/** A dealt column's text matched to its line in the list (`{player}` filled in). */
export function findColumn(list: readonly Column[], subject: string, text: string): Column | undefined {
  return list.find((c) => {
    if (c.subject !== subject) return false;
    if (c.text === text) return true;
    const re = new RegExp(`^${c.text.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{player's\}|\{player\}/g, ".+")}$`, "u");
    return c.text.includes("{") && re.test(text);
  });
}

export class Bot {
  readonly client: PartyClient;
  readonly name: string;
  /** Errors the host answered with (the expected refusals of a race left out). */
  errors: string[] = [];
  readonly #o: BotOptions;
  readonly #rng: () => number;
  readonly #chances: Chances;
  readonly #handled = new Set<string>();
  readonly #timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(o: BotOptions) {
    this.#o = o;
    this.name = o.name;
    this.#rng = o.rng ?? Math.random;
    this.#chances = { ...CHANCES, ...o.chances };
    this.client = new PartyClient({ url: o.url, room: o.room, key: o.key, storage: memoryStorage(), WebSocket: o.WebSocket });
    this.client.on("view", (view) => this.#onView(view));
  }

  async join(): Promise<void> {
    await this.client.join(this.name);
  }

  #think(): number {
    return this.#o.think ? this.#o.think() : this.#rng() * 300;
  }

  #later(ms: number, fn: () => Promise<unknown> | void, ignore: readonly string[] = []): void {
    const t = setTimeout(() => {
      this.#timers.delete(t);
      Promise.resolve()
        .then(fn)
        .catch((e: { code?: string }) => {
          if (!ignore.includes(e.code ?? "")) this.errors.push(e.code ?? String(e));
        });
    }, ms);
    this.#timers.add(t);
  }

  #once(key: string): boolean {
    if (this.#handled.has(key)) return false;
    this.#handled.add(key);
    return true;
  }

  #pick<T>(xs: readonly T[]): T | undefined {
    return xs.length === 0 ? undefined : xs[Math.floor(this.#rng() * xs.length)];
  }

  /** An answer for a column and letter. */
  answer(lang: Lang, subject: string, text: string, letter: string): string {
    const a = this.#answer(lang, subject, text, letter);
    if (!this.#o.long || !a) return a;
    const words = `${a} ${TAIL[lang]}`.split(" ");
    let out = "";
    for (const w of words) if (`${out} ${w}`.trim().length <= 40) out = `${out} ${w}`.trim();
    return out;
  }

  #answer(lang: Lang, subject: string, text: string, letter: string): string {
    const list = this.#o.columns?.[lang] ?? [];
    const col = findColumn(list, subject, text);
    // City, Country, River come whatever the letter: without an example, nothing.
    if (col?.classic && !col.any && (col.examples[letter]?.length ?? 0) === 0) return "";
    const c = this.#chances;
    const roll = this.#rng();
    if (roll < c.empty) return "";
    if (roll < c.empty + c.wrong) {
      const other = Object.entries(col?.examples ?? {}).filter(([l]) => l !== letter);
      const words = this.#pick(other)?.[1] ?? [];
      return this.#pick(words) ?? "Xylophone";
    }
    let ex = col?.examples[letter] ?? [];
    if (ex.length === 0) ex = list.filter((x) => x.subject === subject).flatMap((x) => x.examples[letter] ?? []);
    if (ex.length === 0) ex = list.flatMap((x) => x.examples[letter] ?? []);
    if (ex.length === 0) return `${letter}${FALLBACK[lang]}`;
    return roll < c.empty + c.wrong + c.first ? ex[0]! : this.#pick(ex)!;
  }

  #onView(view: Record<string, any>): void {
    if (this.#o.silent) return;
    const me = view["me"] ?? {};
    const room = view["room"] ?? {};
    const c = this.client;
    const you = c.you?.id;
    const r = room.round ?? 0;
    if (me.task === "lobby" || me.task === "final") {
      if (me.task === "final") this.#handled.clear();
      const vip = (view["roster"] ?? []).find((x: { id: string }) => x.id === you)?.vip;
      const ready = (view["roster"] ?? []).filter((x: { connected: boolean }) => x.connected).length;
      if (this.#o.autoStart && vip && me.task === "lobby" && ready >= (room.minPlayers ?? MIN_PLAYERS) && this.#once(`start:${ready}`)) this.#later(this.#think(), () => c.act("start"), ["running", "too-few"]);
      return;
    }
    if (this.#o.skip?.includes(me.task)) return;
    const lang = pickLang(room.lang);
    switch (me.task) {
      case "draw":
        if (room.phase === "letter" && room.drawer === you && room.run && !room.letter && this.#once(`draw:${r}`)) this.#later(this.#think(), () => c.act("stop-letter"), ["too-late"]);
        return;
      case "write": {
        if (room.phase !== "write" || !Array.isArray(room.columns) || !room.letter) return;
        if (this.#once(`write:${r}`)) {
          let at = 0;
          (room.columns as { subject: string; text: string }[]).forEach((col, i) => {
            const text = this.#o.script ? (this.#o.script.answers[i] ?? "") : this.answer(lang, col.subject, col.text, room.letter);
            at += this.#think();
            if (text) this.#later(at, () => c.act("draft", { i, text }), ["too-late"]);
          });
        }
        if (me.filled && me.canStop && room.settings?.stop && this.#once(`stop:${r}`) && (this.#o.script ? !!this.#o.script.stop : this.#rng() < this.#chances.stop)) this.#later(this.#think(), () => c.act("stop"), ["too-late", "stopped", "not-filled"]);
        return;
      }
      case "grade": {
        if (room.stage !== "vote" || me.done || !Array.isArray(room.answers) || !this.#once(`grade:${r}:${room.col}`)) return;
        const answers = room.answers as { id: string; who: string[]; auto?: string }[];
        const others = answers.filter((a) => !a.who.includes(you ?? "") && !a.auto);
        const late = ["too-late"];
        let at = this.#think();
        const script = this.#o.script;
        if (script) {
          const col = Number(room.col);
          const find = (text: string) => answers.find((a) => (a as { texts?: string[] }).texts?.includes(text) && !a.who.includes(you ?? ""));
          for (const text of script.doubts?.[col] ?? []) {
            const a = find(text);
            if (a) this.#later(at, () => c.act("doubt", { id: a.id, on: true }), late);
          }
          const star = script.stars?.[col];
          const a = star === undefined ? undefined : find(star);
          if (a) this.#later(at, () => c.act("star", { id: a.id }), late);
          this.#later(at + this.#think(), () => c.act("done", { done: true }), late);
          return;
        }
        for (const a of others) {
          if (this.#rng() < this.#chances.doubt) this.#later(at, () => c.act("doubt", { id: a.id, on: true }), late);
        }
        if (others.length > 0 && this.#rng() < this.#chances.star) {
          const a = this.#pick(others)!;
          this.#later(at, () => c.act("star", { id: a.id }), late);
        }
        const open = answers.filter((a) => a.auto !== "empty");
        if (open.length > 0 && this.#rng() < this.#chances.wiki) {
          const a = this.#pick(open)!;
          const wikiLate = [...late, "slow-down", "too-many", "no-article", "no-back", "bad-title", "not-driver"];
          this.#later(at, () => c.act("wiki", { id: a.id }), wikiLate);
          // Now and then a link followed (and its block reported, as the driver), then Back.
          const follow = this.#rng() < 0.5;
          const back = this.#rng() < 0.5;
          const step = 300 + this.#think();
          if (follow) {
            this.#later(at + step, () => {
              const w = this.client.view["room"]?.wiki;
              const links: string[] = (w?.blocks ?? []).flatMap((b: { c: (string | { a?: string })[] }) => b.c.flatMap((r) => (typeof r === "object" && r.a ? [r.a] : [])));
              if (w && !w.loading && links.length > 0) return c.act("wiki-go", { title: this.#pick(links)! });
            }, wikiLate);
            this.#later(at + step * 2, () => {
              const w = this.client.view["room"]?.wiki;
              if (w && w.by === you && Array.isArray(w.blocks) && w.blocks.length > 1) return c.act("wiki-at", { block: Math.floor(w.blocks.length / 2) });
            }, wikiLate);
          }
          if (back) {
            this.#later(at + step * 3, () => {
              if (this.client.view["room"]?.wiki?.back) return c.act("wiki-back");
            }, wikiLate);
          }
          at += follow || back ? step * 3 : 0;
        }
        at += this.#think();
        this.#later(at, () => c.act("done", { done: true }), late);
        return;
      }
    }
  }

  close(): void {
    for (const t of this.#timers) clearTimeout(t);
    this.#timers.clear();
    this.client.close();
  }
}

/** `n` bots joined to a party; the first starts the game when `autoStart`; `seed` gives each its own seeded generator. */
export async function bots(n: number, o: Omit<BotOptions, "name"> & { names?: readonly string[] | undefined; seed?: number | undefined }): Promise<Bot[]> {
  const names = o.names ?? ["Ada", "Bea", "Cy", "Dot", "Eli", "Fay", "Gus", "Hal", "Ivy", "Jo", "Kit", "Lu"];
  const out: Bot[] = [];
  for (let i = 0; i < n; i++) {
    // Each bot its own generator: the same seed plays the same game.
    const rng = o.seed !== undefined ? seeded(o.seed * 101 + i) : o.rng;
    const b = new Bot({ ...o, rng, name: names[i % names.length]! + (i >= names.length ? String(i) : ""), autoStart: o.autoStart && i === 0 });
    await b.join();
    out.push(b);
  }
  return out;
}
