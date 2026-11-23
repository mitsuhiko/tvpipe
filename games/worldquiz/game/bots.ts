/**
 * Fake players: clients that play Worldquiz by themselves. For the tests
 * (in Node) and the live check: the host page's bot buttons (test mode,
 * or `?bots`) run them in the window, connected through tvpipe like a
 * phone.
 *
 * As captain a bot competes with its card's best-ranked number or calls
 * a challenge; in a challenge it types an answer (sometimes with a typo)
 * or drops a pin. With an `oracle` (the host's: the challenge's country)
 * it knows the answer `sharp` of the time; without one it guesses.
 */

import { memoryStorage, PartyClient, type WebSocketFactory } from "@tvpipe/party/client";

import { FACTS } from "./rules.ts";

export interface Truth {
  kind: string;
  capitals: string[];
  name: string;
  at: [number, number];
}

export interface BotOptions {
  /** The WebSocket URL (`ws://127.0.0.1:PORT/_tvpipe/ws`). */
  url: string;
  WebSocket?: WebSocketFactory | undefined;
  room: string;
  key: string;
  name: string;
  rng?: () => number;
  /** Start the game when VIP and enough players are there. */
  autoStart?: boolean;
  /** Delay before acting, ms (default 0–300 random). */
  think?: () => number;
  /** Never answer (to test deadlines). */
  silent?: boolean;
  /** Tasks it leaves to the test (`card`, `answer`, …). */
  skip?: string[];
  /** What the host knows about the challenge being played. */
  oracle?: (() => Truth | undefined) | undefined;
  /** With the oracle: how often it knows (0–1). */
  sharp?: number | undefined;
  /** How often a captain bot competes rather than challenges (0–1, default 0.5). */
  competes?: number | undefined;
}

const GUESSES = ["Paris", "London", "Berlin", "Lima", "Oslo", "Cairo", "Peru", "Chile", "Japan", "Kenya", "Nepal", "Mali"];

export class Bot {
  readonly client: PartyClient;
  readonly name: string;
  /** Errors the host answered with. */
  errors: string[] = [];
  readonly #o: BotOptions;
  readonly #rng: () => number;
  #handled = new Set<string>();
  #timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(o: BotOptions) {
    this.#o = o;
    this.name = o.name;
    this.#rng = o.rng ?? Math.random;
    this.client = new PartyClient({ url: o.url, room: o.room, key: o.key, storage: memoryStorage(), WebSocket: o.WebSocket });
    this.client.on("view", (view) => this.#onView(view));
  }

  async join(): Promise<void> {
    await this.client.join(this.name);
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

  #once(key: string, fn: () => Promise<unknown> | void, ignore: readonly string[] = []): void {
    if (this.#handled.has(key)) return;
    this.#handled.add(key);
    this.#later(this.#o.think ? this.#o.think() : this.#rng() * 300, fn, ignore);
  }

  #pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.#rng() * xs.length)]!;
  }

  /** A typo now and then: two neighbouring letters swapped. */
  #typo(s: string): string {
    if (s.length < 6 || this.#rng() > 0.3) return s;
    const i = 1 + Math.floor(this.#rng() * (s.length - 3));
    return s.slice(0, i) + s[i + 1] + s[i] + s.slice(i + 2);
  }

  #onView(view: Record<string, any>): void {
    const me = view["me"] ?? {};
    if (this.#o.silent || this.#o.skip?.includes(me.task)) return;
    const c = this.client;
    const you = c.you?.id;
    switch (me.task) {
      case "lobby":
      case "final": {
        const room = view["room"] ?? {};
        if (me.task === "final") this.#handled.clear();
        const vip = (view["roster"] ?? []).find((r: { id: string }) => r.id === you)?.vip;
        const ready = (view["roster"] ?? []).filter((r: { connected: boolean }) => r.connected).length;
        if (this.#o.autoStart && vip && me.task === "lobby" && ready >= (room.minPlayers ?? 2)) this.#once(`start:${ready}`, () => c.act("start"));
        return;
      }
      case "card":
        if (me.captain && me.key) {
          const card = me.card ?? {};
          const ranks = (card.ranks ?? {}) as Record<string, number>;
          const best = [...FACTS].sort((a, b) => (ranks[a] ?? 999) - (ranks[b] ?? 999))[0]!;
          const competes = this.#rng() < (this.#o.competes ?? 0.5);
          this.#once(`choose:${me.key}`, () => c.act("choose", competes ? { key: me.key, fact: best } : { key: me.key, challenge: true }), ["not-now"]);
        }
        return;
      case "answer":
        if (!me.locked && me.key) {
          const truth = this.#o.oracle?.();
          const knows = !!truth && this.#rng() < (this.#o.sharp ?? 0.6);
          this.#once(
            `answer:${me.key}`,
            async () => {
              if (me.kind === "where") {
                const [lon, lat] = knows && truth ? truth.at : [this.#rng() * 300 - 150, this.#rng() * 120 - 50];
                const jx = knows ? (this.#rng() - 0.5) * 4 : 0;
                const jy = knows ? (this.#rng() - 0.5) * 4 : 0;
                const pin = { lon: Math.max(-180, Math.min(180, lon + jx)), lat: Math.max(-85, Math.min(85, lat + jy)) };
                await c.act("answer", { key: me.key, ...pin, lock: false });
                await c.act("answer", { key: me.key, ...pin, lock: true });
              } else {
                const right = truth ? (me.kind === "capital" ? truth.capitals[0] : truth.name) : undefined;
                const text = knows && right ? this.#typo(right) : this.#pick(GUESSES);
                await c.act("answer", { key: me.key, text, lock: true });
              }
            },
            ["not-now", "too-late", "locked"],
          );
        }
        return;
    }
  }

  close(): void {
    for (const t of this.#timers) clearTimeout(t);
    this.#timers.clear();
    this.client.close();
  }
}

/** `n` bots joined to a party; the first starts the game when `autoStart`. */
export async function bots(n: number, o: Omit<BotOptions, "name"> & { names?: string[] }): Promise<Bot[]> {
  const names = o.names ?? ["Ada", "Bea", "Cy", "Dot", "Eli", "Fay", "Gus", "Hal", "Ivy", "Jo", "Kit", "Lu"];
  const out: Bot[] = [];
  for (let i = 0; i < n; i++) {
    const b = new Bot({ ...o, name: names[i % names.length]! + (i >= names.length ? String(i) : ""), autoStart: o.autoStart && i === 0 });
    await b.join();
    out.push(b);
  }
  return out;
}
