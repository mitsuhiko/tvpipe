import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { Party } from "@tvpipe/party";
import { memoryStorage, PartyClient } from "@tvpipe/party/client";
import { dropOuts, MemoryRelay } from "@tvpipe/party/testing";

import { Bot, bots } from "../game/bots.ts";
import { Shifty, type Script, type Stage, type Timings } from "../game/game.ts";
import { BOARD, earnedTotal, parseCategories, seeded, type Earned } from "../game/rules.ts";

const data = (f: string) => parseCategories(readFileSync(new URL(`../data/${f}`, import.meta.url), "utf8"));
const WORDS = { en: data("words.txt"), de: data("words.de.txt") };

const fast: Timings = { deal: 30, clue: 500, pin: 10, skip: 10, talk: 700, verdict: 10, string: 5, swing: 10, last: 400, reveal: 10, scores: 10 };

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

interface Opts {
  rounds?: number;
  silent?: number;
  oracle?: boolean;
  lang?: "en" | "de";
  mode?: "typed" | "spoken";
  clues?: number;
  timings?: Partial<Timings>;
  /** Players the test plays by hand (they leave these tasks alone). */
  manual?: { name: string; skip: string[] }[];
  script?: Script;
  tvDelay?: number;
  minPlayers?: number;
}

/** A round as it was played (the game forgets it at the end). */
interface Played {
  category: string;
  board: string[];
  secret: number;
  phony: string;
  order: string[];
  passes: number;
  clues: Record<string, { text: string | null; away?: boolean }[]>;
  votes: Map<string, string>;
  pick: number | null;
  caught: boolean;
  earned: Map<string, Earned>;
}

async function game(n: number, opts: Opts = {}) {
  const relay = new MemoryRelay();
  const party = new Party({ grace: 100, maxPlayers: 10, tvDelay: opts.tvDelay }).listen(relay);
  const g = new Shifty(party, { words: WORDS, rounds: opts.rounds ?? 1, timings: { ...fast, ...opts.timings }, rng: seeded(7), lang: opts.lang, mode: opts.mode, clues: opts.clues, minPlayers: opts.minPlayers });
  g.script = opts.script;
  g.open();
  const phases: string[] = [];
  g.on("phase", (p, s) => phases.push(s ? `${p}:${s}` : p));
  const o = {
    url: "ws://party.test/_tvpipe/ws",
    WebSocket: relay.WebSocket,
    room: party.code,
    key: party.joinKey,
    rng: seeded(n),
    think: () => 3,
    keyGap: () => 2,
    hesitate: () => 5,
    oracle: opts.oracle === false ? undefined : () => (g.round ? { phony: g.round.phony, secret: g.round.secret } : undefined),
  };
  const silent = opts.silent ?? 0;
  const manual = opts.manual ?? [];
  const players = await bots(n - silent - manual.length, o);
  for (let i = 0; i < silent; i++) {
    const b = new Bot({ ...o, name: `Mute${i + 1}`, silent: true });
    await b.join();
    players.push(b);
  }
  for (const m of manual) {
    const b = new Bot({ ...o, name: m.name, skip: m.skip });
    await b.join();
    players.push(b);
  }
  const rounds: Played[] = [];
  g.on("phase", (p) => {
    const r = g.round;
    if (p === "scores" && r) {
      rounds.push({
        category: r.category.title,
        board: r.board.map((w) => w.word),
        secret: r.secret,
        phony: r.phony,
        order: [...r.order],
        passes: r.passes,
        clues: structuredClone(Object.fromEntries(r.clues)),
        votes: new Map(r.votes),
        pick: r.pick,
        caught: r.caught,
        earned: new Map(r.earned),
      });
    }
  });
  const screen = () => party.screenView()["screen"] as Record<string, any>;
  return { relay, party, g, players, phases, rounds, screen, close: () => party.close() };
}

test("a whole game with 3 players: two clues each, the phony caught only when both innocents accuse", async () => {
  const { g, players, rounds, close } = await game(3, { rounds: 2 });
  try {
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await end;
    assert.equal(rounds.length, 2);
    for (const r of rounds) {
      assert.equal(r.passes, 2);
      const onPhony = [...r.votes.values()].filter((id) => id === r.phony).length;
      assert.equal(r.caught, onPhony >= 2 && r.votes.size - onPhony < onPhony);
    }
    assert.deepEqual(
      players.map((b) => b.errors),
      [[], [], []],
    );
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("a whole game with 5 players", async () => {
  const { party, g, players, phases, rounds, screen, close } = await game(5, { rounds: 2 });
  try {
    const end = new Promise<{ id: string; score: number }[]>((r) => g.once("end", r));
    await players[0]!.client.act("start");
    const table = await end;
    assert.equal(table.length, 5);
    const stages = phases.filter((p) => p.startsWith("round:"));
    assert.deepEqual(stages, ["round:deal", "round:clue", "round:accuse", "round:verdict", "round:last", "round:reveal", "round:deal", "round:clue", "round:accuse", "round:verdict", "round:last", "round:reveal"]);
    assert.equal(phases.filter((p) => p === "scores").length, 2);
    assert.equal(phases.at(-1), "final");
    assert.deepEqual(
      players.map((b) => b.errors),
      [[], [], [], [], []],
    );
    assert.equal(rounds.length, 2);
    assert.notEqual(rounds[0]!.category, rounds[1]!.category, "another category each round");
    const totals = new Map<string, number>();
    for (const r of rounds) {
      const list = WORDS.en.find((c) => c.title === r.category)!;
      assert.equal(r.board.length, BOARD);
      assert.equal(new Set(r.board).size, BOARD);
      assert.ok(r.board.every((w) => list.words.some((x) => x.word === w)), "the board is of the category");
      assert.notEqual(r.order[0], r.phony, "the phony never first");
      assert.equal(r.passes, 2, "two clues each with five players");
      for (const id of r.order) {
        assert.equal(r.clues[id]!.length, 2);
        for (const c of r.clues[id]!) assert.ok(c.text && c.text.length > 0, "the bots type a clue each turn");
      }
      assert.equal(r.votes.size, 5, "everyone accused");
      assert.ok(r.pick !== null, "the phony picked");
      for (const [id, e] of r.earned) totals.set(id, (totals.get(id) ?? 0) + earnedTotal(e));
    }
    for (const l of table) assert.equal(l.score, totals.get(l.id) ?? 0, "the table is the rounds' points");
    await until(() => players.every((b) => b.client.view["me"].task === "final"));
    const s = screen();
    assert.equal(s["phase"], "final");
    assert.ok(s["awards"].hand && s["awards"].hand.n > 0, "the bots delete letters now and then: the shakiest hand");
    assert.equal(party.inProgress, false);
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("what phones and the TV are told: the secret only to the innocents, the phony only to the phony, typing only as counts", async () => {
  const { party, g, players, close } = await game(4, { rounds: 1 });
  try {
    const seen: { stage: Stage | null; screen: string; room: string }[] = [];
    const states: { stage: Stage | null; id: string; me: Record<string, any> }[] = [];
    const sample = setInterval(() => {
      if (!g.round) return;
      seen.push({ stage: g.stage, screen: JSON.stringify(party.screenView()), room: JSON.stringify(party.room.peek()) });
      for (const b of players) if (b.client.view?.me && b.client.you) states.push({ stage: g.stage, id: b.client.you.id, me: structuredClone(b.client.view.me) });
    }, 3);
    const end = new Promise((r) => g.once("end", r));
    let secret = "";
    let phony = "";
    g.on("phase", (_p, s) => {
      if (s === "deal") {
        secret = g.secret()!.word;
        phony = g.round!.phony;
      }
    });
    await players[0]!.client.act("start");
    await end;
    clearInterval(sample);
    assert.ok(secret && phony);
    const before = (s: Stage | null, list: Stage[]) => s !== null && list.includes(s);
    for (const v of seen) {
      if (before(v.stage, ["deal", "clue", "accuse"])) {
        for (const x of [v.screen, v.room]) {
          assert.ok(!/"secret"|"word"|"phony"|"pick"|"votes"/.test(x), `nothing of the secret or the phony before the verdict (${v.stage}): ${x.slice(0, 200)}`);
        }
        assert.ok(!v.screen.includes('"text":"') || !/"keys":\[\[[^\]]*"/.test(v.screen), "typing as numbers");
      }
    }
    for (const s of states) {
      if (!before(s.stage, ["deal", "clue", "accuse", "verdict", "last"])) continue;
      if (!s.me["role"]) continue;
      if (s.id === phony) {
        assert.equal(s.me["role"], "phony");
        assert.equal(s.me["word"], undefined, "the phony never gets the word before the reveal");
      } else {
        assert.equal(s.me["role"], "innocent");
        assert.equal(s.me["word"], secret);
      }
    }
    assert.ok(states.some((s) => s.id === phony && s.me["role"] === "phony"));
    assert.ok(seen.some((v) => v.stage === "clue" && /"keys":\[\[\d+,\d+,\d+,\d+\]/.test(v.screen)), "the TV saw typing");
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("a clue by hand: not your turn, a word of the board refused (the TV's needle kicks), then pinned; typing reaches the TV as counts", async () => {
  const script: Script = { category: "Zoo animals", board: ["lion", "zebra", "giraffe"], secret: "zebra", phony: "Ada", order: ["Me", "Ada"] };
  const { party, g, players, screen, close } = await game(4, { rounds: 1, script, manual: [{ name: "Me", skip: ["clue"] }], timings: { clue: 3000 } });
  try {
    const me = players.find((b) => b.name === "Me")!;
    const ada = players.find((b) => b.name === "Ada")!;
    await players[0]!.client.act("start");
    await until(() => me.client.view["me"].task === "clue" && me.client.view["me"].mine);
    const view = me.client.view;
    assert.equal(view["me"]["role"], "innocent");
    assert.equal(view["me"]["word"], "zebra");
    assert.deepEqual(view["room"]["board"].slice(0, 3), ["lion", "zebra", "giraffe"]);
    assert.equal(view["room"]["turn"]["id"], me.client.you!.id);
    const key = view["me"]["turn"];
    await assert.rejects(ada.client.act("clue", { key, text: "stripes" }), { code: "not-yours" });
    await assert.rejects(me.client.act("clue", { key: "1:1:nope", text: "stripes" }), { code: "not-now" });
    me.client.input({ turn: key, n: 5, k: 5, d: 0 });
    await until(() => (screen()["turn"]?.keys ?? []).length === 1);
    assert.deepEqual(screen()["turn"].keys[0].slice(1), [5, 5, 0]);
    assert.deepEqual(await me.client.act("clue", { key, text: "Zebras" }), { ok: false, reason: "board", word: "zebra" });
    assert.deepEqual(await me.client.act("clue", { key, text: "LION" }), { ok: false, reason: "board", word: "lion" });
    assert.deepEqual(await me.client.act("clue", { key, text: "two words" }), { ok: false, reason: "space" });
    assert.equal(screen()["turn"].refused.length, 3);
    // Input is latest-wins every 100 ms: one at a time.
    me.client.input({ turn: "other", n: 9, k: 9, d: 9 });
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(screen()["turn"].keys.length, 1, "another turn's typing is ignored");
    me.client.input({ turn: key, n: 0, k: 5, d: 5 });
    await until(() => (screen()["turn"]?.keys ?? []).length === 2);
    assert.deepEqual(await me.client.act("clue", { key, text: " stripes " }), { ok: true, text: "stripes" });
    await until(() => screen()["clues"]?.[me.client.you!.id]?.length === 1);
    assert.deepEqual(screen()["clues"][me.client.you!.id], [{ text: "stripes" }]);
    const trace = screen()["traces"][me.client.you!.id][0];
    assert.equal(trace.keys.length, 2);
    assert.equal(trace.refused.length, 3);
    assert.ok(!JSON.stringify(screen()["turn"]).includes("stripe") || screen()["turn"].done);
    await assert.rejects(me.client.act("clue", { key, text: "again" }), { code: "not-now" });
    assert.equal(g.isPhony(ada.client.you!.id), true, "the script's phony");
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("silent and away players: turns time out or are skipped, nobody accuses, the phony escapes", async () => {
  const { g, players, rounds, close } = await game(4, { rounds: 1, silent: 4, timings: { clue: 80, talk: 150, last: 80 } });
  try {
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await end;
    const r = rounds[0]!;
    for (const id of r.order) assert.deepEqual(r.clues[id], [{ text: null }, { text: null }]);
    assert.equal(r.votes.size, 0);
    assert.equal(r.caught, false);
    assert.equal(earnedTotal(r.earned.get(r.phony)!), 2);
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("a player away when their turn comes is skipped", async () => {
  const script: Script = { category: "Zoo animals", secret: "lion", phony: "Ada", order: ["Away", "Ada"] };
  const { g, players, rounds, close } = await game(5, { rounds: 1, script, clues: 1, manual: [{ name: "Away", skip: [] }] });
  try {
    const away = players.find((b) => b.name === "Away")!;
    away.client.drop({ away: 60_000 });
    await until(() => !g.party.players.find((p) => p.name === "Away")?.connected);
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await end;
    const id = g.party.players.find((p) => p.name === "Away")!.id;
    assert.deepEqual(rounds[0]!.clues[id], [{ text: null, away: true }]);
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("accusing by hand: not oneself, not a stranger; the most accused alone is the verdict; the phony's pick", async () => {
  const script: Script = { category: "Zoo animals", board: ["lion", "zebra"], secret: "zebra", phony: "Me", order: ["Ada", "Me"] };
  const { party, g, players, rounds, screen, close } = await game(4, { rounds: 1, clues: 1, script, oracle: false, manual: [{ name: "Me", skip: ["accuse", "pick"] }], timings: { talk: 2000, last: 2000 } });
  try {
    const me = players.find((b) => b.name === "Me")!;
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await until(() => me.client.view["me"].task === "accuse");
    assert.equal(me.client.view["me"]["role"], "phony");
    assert.ok(!JSON.stringify(screen()).includes('"votes"'), "whom only with the verdict");
    await assert.rejects(me.client.act("accuse", { id: me.client.you!.id }), { code: "self" });
    await assert.rejects(me.client.act("accuse", { id: "nobody" }), { code: "bad-accuse" });
    const ada = party.players.find((p) => p.name === "Ada")!;
    await me.client.act("accuse", { id: ada.id });
    await until(() => me.client.view["me"].task === "pick");
    await assert.rejects(me.client.act("pick", { index: 99 }), { code: "bad-pick" });
    await me.client.act("pick", { index: 1 });
    await end;
    const r = rounds[0]!;
    assert.equal(r.pick, 1);
    assert.equal(r.board[r.secret], "zebra");
    const e = r.earned.get(r.phony)!;
    assert.equal(e.word, 2, "the phony named the word");
    assert.equal(e.escape, r.caught ? 0 : 2);
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("out loud: Done without a word, or a word pinned (checked as typed)", async () => {
  const { players, g, rounds, close } = await game(4, { rounds: 1, mode: "spoken", clues: 2 });
  try {
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await end;
    const all = Object.values(rounds[0]!.clues).flat();
    assert.ok(all.every((c) => (c as { spoken?: boolean }).spoken === true));
    assert.ok(all.some((c) => c.text === null) && all.some((c) => c.text !== null));
    assert.deepEqual(
      players.map((b) => b.errors),
      [[], [], [], []],
    );
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("phones drop out and come back all game long: the game ends with everyone in it", async () => {
  const { g, players, phases, close } = await game(6, { rounds: 2, timings: { clue: 300 } });
  try {
    const chaos = dropOuts(
      players.map((b) => b.client),
      { rng: seeded(5), every: 100, away: [0, 800], maxAway: 2 },
    );
    const end = new Promise<{ score: number }[]>((r) => g.once("end", r));
    await players[0]!.client.act("start");
    const table = await end;
    await chaos.stop();
    assert.equal(table.length, 6);
    assert.equal(phases.filter((p) => p === "round:reveal").length, 2);
    assert.ok(chaos.counts.network + chaos.counts.device > 0);
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("the VIP's settings are checked, and none during a game", async () => {
  const relay = new MemoryRelay();
  const party = new Party({ grace: 100, maxPlayers: 10 }).listen(relay);
  const g = new Shifty(party, { words: WORDS, rounds: 1, timings: fast, rng: seeded(3) });
  g.open();
  const phone = (name: string) => {
    const c = new PartyClient({ url: "ws://t/", room: party.code, key: party.joinKey, storage: memoryStorage(), WebSocket: relay.WebSocket });
    return c.join(name).then(() => c);
  };
  const vip = await phone("Vip");
  const other = await phone("Other");
  try {
    await vip.act("settings", { rounds: 6, mode: "spoken", clues: 1, clueTime: 40, talkTime: 90, typing: false });
    assert.deepEqual(g.settings, { mode: "spoken", clues: 1, clueTime: 40, talkTime: 90, typing: false });
    assert.equal(g.rounds, 6);
    for (const bad of [{ rounds: 7 }, { mode: "mime" }, { clues: 3 }, { clueTime: 20 }, { talkTime: 30 }, { typing: "yes" }, { lang: "fr" }, { late: "open" }, { late: true }, { color: 1 }]) {
      await assert.rejects(vip.act("settings", bad), { code: "bad-settings" }, JSON.stringify(bad));
    }
    await assert.rejects(other.act("settings", { rounds: 3 }), { code: "not-vip" });
    await until(() => vip.view?.room?.["mode"] === "spoken");
    assert.equal((party.screenView()["screen"] as Record<string, unknown>)["talkTime"], 90);
    // The language and latecomers, as on the host page: the room's, every phone follows, the host page hears of it.
    let told = 0;
    g.on("settings", () => told++);
    assert.deepEqual(other.view?.room?.["langs"], ["en", "de"]);
    assert.equal(other.view?.room?.["late"], "wait");
    await assert.rejects(other.act("settings", { lang: "de" }), { code: "not-vip" });
    await assert.rejects(other.act("settings", { late: "closed" }), { code: "not-vip" });
    assert.equal(g.lang, "en");
    assert.equal(party.lateJoin, "wait");
    await vip.act("settings", { lang: "de" });
    assert.equal(g.lang, "de");
    assert.equal(told, 1);
    await vip.act("settings", { late: "closed" });
    assert.equal(party.lateJoin, "closed");
    assert.equal(told, 2);
    await until(() => [vip, other].every((c) => c.view?.room?.["lang"] === "de" && c.view?.room?.["late"] === "closed"));
    assert.equal((party.screenView()["screen"] as Record<string, unknown>)["lang"], "de");
    // The host page's latecomers field sets party.lateJoin and then configure({}): the phones see it.
    party.lateJoin = "wait";
    g.configure({});
    await until(() => other.view?.room?.["late"] === "wait");
    assert.throws(() => g.configure({ lang: "fr" as "de" }), { code: "bad-lang" });
  } finally {
    vip.close();
    other.close();
    party.close();
  }
});

test("the language and latecomers: not during a game, again at the end", async () => {
  const { g, players, party, close } = await game(3, { rounds: 1 });
  try {
    const vip = players[0]!.client;
    const end = new Promise((r) => g.once("end", r));
    await vip.act("start");
    await until(() => g.stage === "clue");
    await assert.rejects(vip.act("settings", { lang: "de" }), { code: "running" });
    await assert.rejects(vip.act("settings", { late: "closed" }), { code: "running" });
    assert.equal(g.lang, "en");
    assert.equal(party.lateJoin, "wait");
    await end;
    await until(() => g.phase === "final");
    await vip.act("settings", { lang: "de", late: "closed" });
    await until(() => players.every((p) => p.client.view?.room?.["lang"] === "de" && p.client.view?.room?.["late"] === "closed"));
    assert.equal(party.lateJoin, "closed");
  } finally {
    close();
  }
});

test("a latecomer waits for the next round, then plays", async () => {
  const { party, g, players, close, relay } = await game(4, { rounds: 2, timings: { talk: 300 } });
  let late: Bot | undefined;
  try {
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await until(() => g.stage === "clue");
    late = new Bot({ url: "ws://t/", WebSocket: relay.WebSocket, room: party.code, key: party.joinKey, name: "Late", think: () => 3, keyGap: () => 2 });
    await late.join();
    await until(() => late!.client.view?.me?.task === "wait");
    assert.ok(!g.round!.order.includes(late.client.you!.id));
    await until(() => g.round?.n === 2);
    assert.ok(g.round!.order.includes(late.client.you!.id), "plays from the next round");
    await end;
    assert.deepEqual(late.errors, []);
  } finally {
    late?.close();
    for (const b of players) b.close();
    close();
  }
});

test("too few players left: the game ends at the next round, to its final screen", async () => {
  const { party, g, players, phases, close } = await game(3, { rounds: 3 });
  try {
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await until(() => g.stage === "clue");
    party.kick(party.players.at(-1)!);
    await end;
    assert.equal(phases.filter((p) => p === "round:deal").length, 1);
    assert.equal(phases.at(-1), "final");
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("a phony who leaves for good ends the round: the word is shown, nobody scores", async () => {
  const script: Script = { category: "Zoo animals", secret: "lion", phony: "Gone", order: ["Ada", "Bea"] };
  const { party, g, players, phases, screen, close } = await game(5, { rounds: 1, script, clues: 1, manual: [{ name: "Gone", skip: [] }], timings: { clue: 2000 } });
  try {
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await until(() => g.stage === "clue");
    party.kick(party.players.find((p) => p.name === "Gone")!);
    await until(() => g.stage === "gone");
    assert.equal(screen()["word"], "lion");
    await end;
    assert.ok(!phases.includes("round:accuse"));
    for (const p of party.players) assert.equal(g.scores.get(p.id), 0);
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("a TV 250 ms behind: every phone gets a stage when the TV shows it, never before", async () => {
  const { party, g, players, close } = await game(4, { rounds: 1, tvDelay: 250, clues: 1 });
  try {
    const shown = new Map<string, number>();
    const seen: { task: string; at: number }[] = [];
    g.on("phase", (_p, s) => shown.set(String(s), Date.now()));
    players[1]!.client.on("view", (v) => {
      const t = String(v["me"]?.task ?? "");
      if (seen.at(-1)?.task !== t) seen.push({ task: t, at: Date.now() });
    });
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await end;
    await until(() => players[1]!.client.view["me"].task === "final");
    for (const [task, stage] of [["accuse", "accuse"], ["verdict", "verdict"], ["result", "reveal"]] as const) {
      const at = seen.find((x) => x.task === task)?.at;
      assert.ok(at !== undefined, task);
      assert.ok(at - shown.get(stage)! >= 200, `${task} ${at - shown.get(stage)!} ms after the host`);
    }
  } finally {
    for (const b of players) b.close();
    close();
  }
  void party;
});

test("close(): the lobby at once, everyone in, no final screen, nothing written after it; then a fresh game", async () => {
  const { party, g, players, phases, screen, close } = await game(4, { rounds: 2 });
  try {
    await players[0]!.client.act("start");
    await until(() => g.stage === "clue");
    g.close();
    assert.equal(g.running, false);
    assert.equal(screen()["phase"], "lobby");
    const n = phases.length;
    await new Promise((r) => setTimeout(r, 900));
    assert.equal(screen()["phase"], "lobby");
    assert.equal(phases.length, n, "nothing of the closed game");
    assert.equal(party.inProgress, false);
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await end;
    assert.deepEqual(
      players.map((b) => b.errors),
      [[], [], [], []],
    );
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("in German: German categories and words", async () => {
  const { g, players, rounds, close } = await game(4, { rounds: 1, lang: "de" });
  try {
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await end;
    assert.ok(WORDS.de.some((c) => c.title === rounds[0]!.category));
    assert.deepEqual(
      players.map((b) => b.errors),
      [[], [], [], []],
    );
  } finally {
    for (const b of players) b.close();
    close();
  }
});
