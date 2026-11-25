import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { Party } from "@tvpipe/party";
import { memoryStorage, PartyClient } from "@tvpipe/party/client";
import { dropOuts, MemoryRelay } from "@tvpipe/party/testing";

import { Bot, bots, type BotOptions } from "../game/bots.ts";
import { Classes, type GameOptions, type Timings } from "../game/game.ts";
import { parseColumns, seeded, type Column, type Settings } from "../game/rules.ts";
import type { WikiArticle, WikiSource } from "../game/wiki.ts";
import type { Block } from "../game/wikitext.ts";

const EN = parseColumns(readFileSync(new URL("fixtures/columns.txt", import.meta.url), "utf8"), "en");
const DE = parseColumns(readFileSync(new URL("fixtures/columns.de.txt", import.meta.url), "utf8"), "de");
const AT = parseColumns(readFileSync(new URL("fixtures/columns.de.txt", import.meta.url), "utf8"), "at");

const fast: Partial<Timings> = {
  step: 20,
  runLead: 10,
  letterMax: 300,
  letterShown: 10,
  board: 10,
  write: 400,
  stopLeft: 100,
  bell: 20,
  draftGrace: 100,
  vote: 400,
  votePer: 10,
  voteMax: 600,
  voteEmpty: 50,
  wikiMin: 200,
  wikiMaxAdd: 400,
  wikiGap: 50,
  marked: 10,
  markedPer: 2,
  report: 10,
};

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 3));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Opts {
  settings?: Partial<Settings>;
  timings?: Partial<Timings>;
  /** Players without a will of their own, joined first (the first is the VIP and draws first). */
  manual?: string[];
  silent?: number;
  tvDelay?: number;
  lang?: "en" | "de" | "at";
  columns?: Column[];
  wiki?: WikiSource;
  bot?: Partial<BotOptions>;
  minPlayers?: number;
}

async function game(n: number, opts: Opts = {}) {
  const relay = new MemoryRelay();
  const party = new Party({ grace: 100, maxPlayers: 10, tvDelay: opts.tvDelay }).listen(relay);
  const options: GameOptions = {
    columns: { en: opts.columns ?? EN, de: DE, at: AT },
    lang: opts.lang,
    settings: { rounds: 2, columns: 6, ...opts.settings },
    timings: { ...fast, ...opts.timings },
    rng: seeded(7),
    wiki: opts.wiki,
    minPlayers: opts.minPlayers,
  };
  const g = new Classes(party, options);
  g.open();
  const phases: string[] = [];
  g.on("phase", (p, s) => phases.push(s ? `${p}:${s}` : p));
  const o = { url: "ws://party.test/_tvpipe/ws", WebSocket: relay.WebSocket, room: party.code, key: party.joinKey, think: () => 3, columns: { en: EN, de: DE }, ...opts.bot };
  const manual: Bot[] = [];
  for (const name of opts.manual ?? []) {
    const b = new Bot({ ...o, name, silent: true });
    await b.join();
    manual.push(b);
  }
  const players = [...manual, ...(await bots(n - manual.length - (opts.silent ?? 0), { ...o, seed: n }))];
  for (let i = 0; i < (opts.silent ?? 0); i++) {
    const b = new Bot({ ...o, name: `Mute${i + 1}`, silent: true });
    await b.join();
    players.push(b);
  }
  const screen = () => party.screenView()["screen"] as Record<string, any>;
  const room = () => party.room.peek() as Record<string, any>;
  const close = () => {
    for (const b of players) b.close();
    party.close();
  };
  return { relay, party, g, players, manual, phases, screen, room, close, o };
}

const ROUND = (cols: number) => ["letter", "board", "write", "bell", ...Array.from({ length: cols }, () => ["grade:vote", "grade:marked"]).flat(), "report"];

test("a whole game with 4 bots: every phase, points add up, report cards and the best answers at the end", async () => {
  const { g, players, phases, screen, room, close } = await game(4, { settings: { rounds: 2, columns: 6 } });
  try {
    const marks: { points: number; who: string[] }[] = [];
    g.on("phase", (_p, s) => {
      if (s === "marked") {
        const r = room();
        for (const m of r["marks"]) marks.push({ points: m.points, who: r["answers"].find((a: any) => a.id === m.id).who });
      }
    });
    const end = new Promise<{ id: string; total: number }[]>((r) => g.once("end", r));
    await players[0]!.client.act("start");
    const table = await end;
    assert.deepEqual(phases, [...ROUND(6), ...ROUND(6), "final"]);
    assert.equal(table.length, 4);
    for (const b of players) assert.deepEqual(b.errors, [], b.name);
    // Totals are the marks' points, per writer.
    for (const line of table) {
      const sum = marks.filter((m) => m.who.includes(line.id)).reduce((a, m) => a + m.points, 0);
      assert.equal(line.total, sum, line.id);
    }
    assert.ok(table.some((l) => l.total > 0));
    const s = screen();
    assert.equal(s["phase"], "final");
    assert.equal(s["cards"].length, 4);
    for (const c of s["cards"]) {
      assert.ok(c.grades.length > 0);
      assert.ok(c.grades.every((x: any) => /^[A-F]$/.test(x.grade) && typeof x.subject === "string"));
      assert.ok(c.remarks.length >= 1 && c.remarks.length <= 2);
      assert.ok(["promoted", "held"].includes(c.stamp));
    }
    assert.ok(s["best"].length <= 6);
    assert.ok(s["best"].every((b: any) => b.stars >= 1));
    assert.equal(s["used"].length, 2);
    assert.notEqual(s["used"][0], s["used"][1]);
    await until(() => players.every((b) => b.client.view["me"]?.task === "final"));
    assert.ok(players.every((b) => typeof b.client.view["me"].total === "number" && b.client.view["me"].rank >= 1));
  } finally {
    close();
  }
});

test("secrets: no other player's text before grading, no doubts or stars before the marks", async () => {
  const { g, party, players, close } = await game(4, { settings: { rounds: 1, columns: 6 }, bot: { chances: { doubt: 0.5, star: 0.8 } } });
  try {
    // What each phone sent.
    const sent = players.map(() => new Set<string>([""]));
    players.forEach((b, i) => {
      const act = b.client.act.bind(b.client);
      b.client.act = (type: string, data?: any) => {
        if (type === "draft") sent[i]!.add(data.text);
        return act(type, data);
      };
    });
    const seen: { phase: string; stage: string | null; screen: string; room: string; mes: Record<string, any>[] }[] = [];
    const sample = setInterval(() => {
      if (!g.running) return;
      seen.push({ phase: g.phase, stage: g.stage, screen: JSON.stringify(party.screenView()), room: JSON.stringify(party.room.peek()), mes: players.map((b) => b.client.view?.me ?? {}) });
    }, 2);
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await end;
    clearInterval(sample);
    assert.ok(seen.some((v) => v.phase === "write"));
    assert.ok(seen.some((v) => v.stage === "vote"));
    for (const v of seen) {
      if (["letter", "board", "write", "bell"].includes(v.phase)) assert.ok(!/"texts"|"answers"/.test(v.screen + v.room), `no answers in ${v.phase}`);
      if (v.stage === "vote") assert.ok(!/"marks"|"doubts"|"stars"/.test(v.screen + v.room), "no marks in the vote");
      // A phone has its own answers only.
      v.mes.forEach((me, i) => {
        for (const a of me.answers ?? []) assert.ok(sent[i]!.has(a), `${players[i]!.name}: ${a}`);
        assert.ok(!("texts" in me));
      });
    }
    // The progress on the TV: numbers only.
    const prog = seen.find((v) => v.phase === "write")!.screen;
    assert.match(prog, /"progress":\{/);
  } finally {
    close();
  }
});

test("the letter is the one the drawer saw: picked by info.sentAt; others cannot stop it, nobody twice", async () => {
  const { g, players, manual, close } = await game(3, { manual: ["Zed"], settings: { rounds: 1 }, timings: { step: 200, runLead: 50, letterMax: 8000 } });
  try {
    const zed = manual[0]!.client;
    const end = new Promise((r) => g.once("end", r));
    await zed.act("start");
    await until(() => zed.view["me"]?.task === "draw" && !!zed.view["room"]?.run);
    const room = zed.view["room"];
    assert.equal(room.drawer, zed.you!.id);
    // Only the drawer draws.
    await until(() => players[1]!.client.view["room"]?.phase === "letter");
    assert.equal(players[1]!.client.view["me"].task, "write");
    await assert.rejects(players[1]!.client.act("stop-letter"), { code: "not-drawer" });
    const { start, step, seq } = room.run as { start: number; step: number; seq: string[] };
    assert.equal(seq.length, 20);
    // Press in the middle of the 4th letter's slot.
    const at = start + step * 3 + step / 2;
    await sleep(Math.max(0, at - zed.hostNow()));
    await zed.act("stop-letter");
    assert.equal(g.current!.letter, seq[3]);
    await assert.rejects(zed.act("stop-letter"), { code: "too-late" });
    await until(() => zed.view["room"]?.letter === seq[3]);
    await end;
  } finally {
    close();
  }
});

test("an away or silent drawer: the host stops the alphabet itself", async () => {
  const { g, players, phases, close } = await game(3, { silent: 3, settings: { rounds: 1 }, timings: { letterMax: 100 } });
  try {
    const end = new Promise((r) => g.once("end", r));
    await g.play();
    await end;
    assert.deepEqual(phases.slice(0, 4), ["letter", "board", "write", "bell"]);
    void players;
  } finally {
    close();
  }
});

test("a TV 250 ms behind: nothing reaches the phones before the TV shows it", async () => {
  const { g, players, close } = await game(4, { settings: { rounds: 1 }, tvDelay: 250, timings: { write: 800, vote: 800, voteMax: 900, report: 400 } });
  try {
    const shown = new Map<string, number>();
    const seen: { key: string; at: number }[] = [];
    g.on("phase", (p, s) => {
      const k = s ? `${p}:${s}` : p;
      if (!shown.has(k)) shown.set(k, Date.now());
    });
    const phone = players[1]!.client;
    phone.on("view", (v) => {
      const k = v["room"]?.stage ? `${v["room"].phase}:${v["room"].stage}` : String(v["room"]?.phase);
      if (seen.at(-1)?.key !== k) seen.push({ key: k, at: Date.now() });
    });
    let chosen = 0;
    let arrived = 0;
    g.on("phase", (p) => {
      if (p === "board" && !chosen) chosen = Date.now();
    });
    phone.on("view", (v) => {
      if (v["room"]?.letter && !arrived) arrived = Date.now();
    });
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await end;
    for (const k of ["letter", "board", "write", "bell", "grade:vote", "grade:marked", "report"]) {
      const at = seen.find((x) => x.key === k)?.at;
      assert.ok(at !== undefined, k);
      assert.ok(at - shown.get(k)! >= 200, `${k}: ${at - shown.get(k)!} ms after the host`);
    }
    assert.ok(arrived > 0);
  } finally {
    close();
  }
});

test("grading by hand: 20, 10 and 5; struck by more than half of the others; stars; the report cards", async () => {
  const columns = EN.filter((c) => !c.rule);
  const { g, manual, room, screen, close } = await game(3, { manual: ["Ann", "Bob", "Cat"], columns, settings: { rounds: 1, columns: 6 }, timings: { letterMax: 50, write: 600, vote: 3000, voteMax: 3000, voteEmpty: 3000 } });
  try {
    g.script = { letter: "B" };
    const [a, b, c] = manual.map((m) => m.client) as [PartyClient, PartyClient, PartyClient];
    const plan = [
      ["Berlin", "berlin", "Bonn"],
      ["Boston", "", "Rome"],
      ["Bali", "Bern", "Brno"],
      ["Bear", "Bird", "Bee"],
      ["", "", ""],
      ["Banjo", "Banjo", "Banjo"],
    ];
    const end = new Promise((r) => g.once("end", r));
    await a.act("start");
    await until(() => g.phase === "write");
    await until(() => a.view["room"]?.phase === "write");
    for (const [i, texts] of plan.entries()) {
      for (const [k, p] of [a, b, c].entries()) if (texts[k]) await p.act("draft", { i, text: texts[k] });
    }
    assert.deepEqual(a.view["me"].answers, plan.map((t) => t[0]));
    assert.equal(a.view["me"].filled, false);
    const marks: any[] = [];
    const answersOf: any[] = [];
    for (let i = 0; i < 6; i++) {
      await until(() => g.stage === "vote" && room()["col"] === i);
      await until(() => a.view["room"]?.col === i && a.view["room"]?.stage === "vote");
      const answers = a.view["room"].answers as { id: string; who: string[]; texts: string[]; same?: string; auto?: string }[];
      const of = (p: PartyClient) => answers.find((x) => x.who.includes(p.you!.id))!;
      if (i === 0) await a.act("star", { id: of(c).id });
      if (i === 2) {
        await b.act("doubt", { id: of(a).id, on: true });
        await c.act("doubt", { id: of(a).id, on: true });
      }
      if (i === 3) await b.act("doubt", { id: of(a).id, on: true });
      for (const p of [a, b, c]) await p.act("done", { done: true });
      await until(() => g.stage === "marked" && room()["col"] === i);
      marks.push(room()["marks"]);
      answersOf.push(answers);
    }
    await end;
    // Column 0: Berlin and berlin are the same answer.
    assert.equal(answersOf[0].length, 2);
    assert.equal(answersOf[0][0].same, "same");
    assert.deepEqual(answersOf[0][0].texts, ["Berlin", "berlin"]);
    assert.deepEqual(
      marks[0].map((m: any) => [m.points, m.stars]),
      [
        [5, 0],
        [10, 1],
      ],
    );
    // Column 1: the only valid answer; an empty one; a wrong letter.
    assert.deepEqual(
      answersOf[1].map((x: any) => x.auto ?? null),
      [null, "empty", "letter"],
    );
    assert.deepEqual(
      marks[1].map((m: any) => m.points),
      [20, 0, 0],
    );
    // Column 2: both others doubted Bali: struck. Column 3: one of two: it counts.
    assert.deepEqual(marks[2][0], { id: answersOf[2][0].id, doubts: 2, of: 2, struck: true, points: 0, stars: 0 });
    assert.deepEqual(
      marks[2].map((m: any) => m.points),
      [0, 10, 10],
    );
    assert.deepEqual(marks[3][0], { id: answersOf[3][0].id, doubts: 1, of: 2, struck: false, points: 10, stars: 0 });
    // Column 4: all empty. Column 5: three the same, nobody left to doubt it.
    assert.deepEqual(
      marks[4].map((m: any) => m.points),
      [0, 0, 0],
    );
    assert.deepEqual(marks[5], [{ id: answersOf[5][0].id, doubts: 0, of: 0, struck: false, points: 5, stars: 0 }]);
    const ids = [a, b, c].map((p) => p.you!.id);
    assert.deepEqual(
      ids.map((id) => g.totals.get(id)),
      [40, 30, 35],
    );
    const s = screen();
    const card = (id: string) => s["cards"].find((x: any) => x.id === id);
    assert.deepEqual(
      s["cards"].map((x: any) => x.id),
      [ids[0], ids[2], ids[1]],
    );
    assert.deepEqual(card(ids[0]!).remarks, ["top", "twenty"]);
    assert.deepEqual(card(ids[1]!).remarks, ["copy", "empty"]);
    assert.deepEqual(card(ids[2]!).remarks, ["clown"]);
    assert.equal(card(ids[1]!).stamp, "held");
    assert.equal(card(ids[0]!).stamp, "promoted");
    assert.deepEqual(s["best"], [{ id: ids[2], text: "Bonn", column: room()["columns"]?.[0]?.text ?? s["best"][0].column, subject: s["best"][0].subject, stars: 1 }]);
    assert.deepEqual(
      s["scores"].map((x: any) => [x.id, x.total, x.rank]),
      [
        [ids[0], 40, 1],
        [ids[2], 35, 2],
        [ids[1], 30, 3],
      ],
    );
  } finally {
    close();
  }
});

test("a duel of two: a whole game with bots; report cards without a held-back stamp", async () => {
  const { g, players, phases, screen, close } = await game(2, { settings: { rounds: 3, columns: 6 } });
  try {
    const end = new Promise<{ id: string; total: number }[]>((r) => g.once("end", r));
    await players[0]!.client.act("start");
    const table = await end;
    assert.deepEqual(phases, [...ROUND(6), ...ROUND(6), ...ROUND(6), "final"]);
    assert.equal(table.length, 2);
    for (const b of players) assert.deepEqual(b.errors, [], b.name);
    const cards = screen()["cards"] as { stamp: string; remarks: string[]; rank: number }[];
    assert.equal(cards.length, 2);
    assert.ok(cards.every((c) => c.stamp === "promoted"));
    // No remark both get for the same thing, but copying.
    const [a, b] = cards.map((c) => c.remarks.filter((r) => r !== "fine" && r !== "copy"));
    assert.ok(!a!.some((r) => b!.includes(r)), `${a} / ${b}`);
    await until(() => players.every((p) => p.client.view["me"]?.task === "final"));
  } finally {
    close();
  }
});

test("a duel by hand: the other's one doubt strikes; the same answer is 5 each; the only answer 20", async () => {
  const { g, manual, room, close } = await game(2, { manual: ["Ann", "Bob"], columns: EN.filter((c) => !c.rule), settings: { rounds: 3, columns: 6 }, timings: { letterMax: 50, write: 500, vote: 3000, voteMax: 3000, voteEmpty: 3000 } });
  try {
    g.script = { letter: "B" };
    const [a, b] = manual.map((m) => m.client) as [PartyClient, PartyClient];
    await a.act("start");
    await until(() => a.view["room"]?.phase === "write");
    await a.act("draft", { i: 0, text: "Bern" });
    await b.act("draft", { i: 0, text: "Bonn" });
    await a.act("draft", { i: 1, text: "Bear" });
    await b.act("draft", { i: 1, text: "bear" });
    await a.act("draft", { i: 2, text: "Banjo" });
    await until(() => a.view["room"]?.stage === "vote" && a.view["room"]?.col === 0);
    const of = (p: PartyClient) => (a.view["room"].answers as { id: string; who: string[] }[]).find((x) => x.who.includes(p.you!.id))!;
    await b.act("doubt", { id: of(a).id, on: true });
    for (const p of [a, b]) await p.act("done", { done: true });
    await until(() => g.stage === "marked" && room()["col"] === 0);
    assert.deepEqual(
      (room()["marks"] as { doubts: number; of: number; struck: boolean; points: number }[]).map((m) => [m.doubts, m.of, m.struck, m.points]),
      [
        [1, 1, true, 0],
        [0, 1, false, 20],
      ],
    );
    for (const col of [1, 2]) {
      await until(() => g.stage === "vote" && room()["col"] === col);
      for (const p of [a, b]) await until(() => p.view["room"]?.col === col).then(() => p.act("done", { done: true }));
      await until(() => g.stage === "marked" && room()["col"] === col);
      assert.deepEqual(
        (room()["marks"] as { points: number }[]).map((m) => m.points),
        col === 1 ? [5] : [20, 0],
      );
    }
    g.close();
  } finally {
    close();
  }
});

test("writing: drafts, their refusals, Stop, and the bell", async () => {
  const { g, manual, party, screen, close } = await game(3, { manual: ["Ann", "Bob", "Cat"], settings: { rounds: 1, columns: 6 }, timings: { letterMax: 50, write: 3000, stopLeft: 200, vote: 50, voteMax: 50 } });
  try {
    const [a, b, c] = manual.map((m) => m.client) as [PartyClient, PartyClient, PartyClient];
    const end = new Promise((r) => g.once("end", r));
    await a.act("start");
    await until(() => g.phase === "letter");
    await assert.rejects(a.act("draft", { i: 0, text: "Too early" }), { code: "too-late" });
    await until(() => a.view["room"]?.phase === "write");
    const n = a.view["room"].columns.length;
    assert.equal(n, 6);
    await assert.rejects(a.act("draft", { i: 6, text: "x" }), { code: "bad-draft" });
    await assert.rejects(a.act("draft", { i: -1, text: "x" }), { code: "bad-draft" });
    await assert.rejects(a.act("draft", { i: 0.5, text: "x" }), { code: "bad-draft" });
    await assert.rejects(a.act("draft", { i: 0, text: 42 }), { code: "bad-draft" });
    await assert.rejects(a.act("draft", { i: 0, text: "x".repeat(401) }), { code: "bad-draft" });
    await assert.rejects(a.act("stop"), { code: "not-filled" });
    // Cleaned: emoji off, 40 characters at most.
    assert.deepEqual(await a.act("draft", { i: 0, text: "  Bonn 🎉  " }), { text: "Bonn" });
    assert.deepEqual(await a.act("draft", { i: 1, text: "a".repeat(60) }), { text: "a".repeat(40) });
    assert.equal(screen()["progress"][a.you!.id][0], 1);
    assert.equal(screen()["progress"][a.you!.id][1], 3);
    assert.equal(screen()["progress"][b.you!.id][0], 0);
    for (let i = 2; i < n; i++) await a.act("draft", { i, text: `Answer ${i}` });
    await until(() => a.view["me"]?.filled === true && a.view["me"]?.canStop === true);
    const before = g.current && (party.room.peek()["deadline"] as number);
    await a.act("stop");
    assert.equal(party.room.peek()["stopBy"], a.you!.id);
    assert.ok((party.room.peek()["deadline"] as number) < before! - 1000);
    await until(() => b.view["me"]?.canStop === false);
    for (let i = 0; i < n; i++) await b.act("draft", { i, text: "Bee" });
    await assert.rejects(b.act("stop"), { code: "stopped" });
    await until(() => g.phase === "grade");
    await assert.rejects(c.act("draft", { i: 0, text: "Too late" }), { code: "too-late" });
    await assert.rejects(c.act("stop"), { code: "too-late" });
    await end;
  } finally {
    close();
  }
});

test("Stop is off: refused", async () => {
  const { g, manual, close } = await game(3, { manual: ["Ann"], settings: { rounds: 1, columns: 6, stop: false }, timings: { letterMax: 50, write: 1000 } });
  try {
    const a = manual[0]!.client;
    const end = new Promise((r) => g.once("end", r));
    await a.act("start");
    await until(() => a.view["room"]?.phase === "write");
    for (let i = 0; i < 6; i++) await a.act("draft", { i, text: "Something" });
    assert.equal(a.view["me"].canStop, false);
    await assert.rejects(a.act("stop"), { code: "off" });
    g.close();
    void end;
  } finally {
    close();
  }
});

test("the vote's refusals: own, auto, bad-answer, too-late, not-playing", async () => {
  const { g, manual, relay, party, close } = await game(3, { manual: ["Ann", "Bob", "Cat"], columns: EN.filter((c) => !c.rule), settings: { rounds: 1, columns: 6, late: "wait" }, timings: { letterMax: 50, write: 500, vote: 4000, voteMax: 4000, voteEmpty: 4000, marked: 5000 } });
  try {
    g.script = { letter: "B" };
    const [a, b, c] = manual.map((m) => m.client) as [PartyClient, PartyClient, PartyClient];
    const end = new Promise((r) => g.once("end", r));
    await a.act("start");
    await until(() => g.phase === "grade" || a.view["room"]?.phase === "write");
    await assert.rejects(a.act("doubt", { id: "x", on: true }), { code: "too-late" });
    await assert.rejects(a.act("done", { done: true }), { code: "too-late" });
    await until(() => a.view["room"]?.phase === "write");
    await a.act("draft", { i: 0, text: "Berlin" });
    await b.act("draft", { i: 0, text: "Rome" });
    // A latecomer waits for the next round: not in this one.
    const late = new PartyClient({ url: "ws://t/", room: party.code, key: party.joinKey, storage: memoryStorage(), WebSocket: relay.WebSocket });
    await late.join("Late");
    await until(() => late.view["me"]?.task === "wait");
    await assert.rejects(late.act("draft", { i: 0, text: "Bonn" }), { code: "not-playing" });
    await until(() => a.view["room"]?.stage === "vote");
    const answers = a.view["room"].answers as { id: string; who: string[]; auto?: string }[];
    const mine = answers.find((x) => x.who.includes(a.you!.id))!;
    const rome = answers.find((x) => x.who.includes(b.you!.id))!;
    const empty = answers.find((x) => x.who.includes(c.you!.id))!;
    assert.equal(rome.auto, "letter");
    assert.equal(empty.auto, "empty");
    await assert.rejects(a.act("doubt", { id: mine.id, on: true }), { code: "own" });
    await assert.rejects(a.act("doubt", { id: rome.id, on: true }), { code: "auto" });
    await assert.rejects(a.act("doubt", { id: "nope", on: true }), { code: "bad-answer" });
    await assert.rejects(a.act("star", { id: mine.id }), { code: "own" });
    await assert.rejects(a.act("star", { id: empty.id }), { code: "bad-answer" });
    await assert.rejects(a.act("star", { id: 3 }), { code: "bad-answer" });
    await assert.rejects(late.act("doubt", { id: mine.id, on: true }), { code: "not-playing" });
    await b.act("doubt", { id: mine.id, on: true });
    assert.deepEqual(b.view["me"].doubts, [mine.id]);
    await b.act("doubt", { id: mine.id, on: false });
    assert.deepEqual(b.view["me"].doubts, []);
    await b.act("star", { id: mine.id });
    assert.equal(b.view["me"].star, mine.id);
    await b.act("star", { id: null });
    assert.equal(b.view["me"].star, null);
    await a.act("done", { done: true });
    assert.equal(a.view["me"].done, true);
    await until(() => (a.view["room"].done as string[]).includes(a.you!.id));
    await a.act("done", { done: false });
    assert.equal(a.view["me"].done, false);
    for (const p of [a, b, c]) await p.act("done", { done: true });
    await until(() => g.stage === "marked");
    await assert.rejects(b.act("doubt", { id: mine.id, on: true }), { code: "too-late" });
    await assert.rejects(b.act("star", { id: mine.id }), { code: "too-late" });
    await assert.rejects(b.act("done", { done: true }), { code: "too-late" });
    await assert.rejects(b.act("wiki", { id: mine.id }), { code: "too-late" });
    g.close();
    void end;
    late.close();
  } finally {
    close();
  }
});

/** A made-up Wikipedia: articles by title with links between them, a search, how often each was fetched. */
function fakeWiki(delay = 20) {
  const calls: string[] = [];
  const art = (title: string, links: string[], n = 3): WikiArticle => ({
    title,
    url: `https://en.wikipedia.org/wiki/${title}`,
    description: `About ${title}`,
    image: "https://upload.wikimedia.org/x.jpg",
    blocks: [
      { t: "p", c: [{ s: title, b: true }, " is linked to ", ...links.flatMap((l) => [{ s: l, a: l }, " "])] },
      { t: "h2", c: ["History"] },
      ...Array.from({ length: n }, (_, i): Block => ({ t: "p", c: [`Paragraph ${i}.`] })),
      { t: "h2", c: ["Band"] },
      { t: "p", c: ["The band part."] },
    ],
  });
  const articles: Record<string, WikiArticle> = {
    Berlin: art("Berlin", ["Germany", "Spree"]),
    "Berlin (band)": art("Berlin (band)", []),
    Germany: art("Germany", ["Berlin"]),
    Spree: art("Spree", ["Berlin"]),
    "Berlin Wall": { ...art("Berlin Wall", []), section: "Band" },
  };
  const wiki: WikiSource = {
    async find(query) {
      calls.push(`find ${query}`);
      await sleep(delay);
      if (query === "Bxqz") return { error: "none", results: [] };
      if (articles[query]) return { results: [], article: articles[query] };
      return { results: [{ title: "Berlin", snippet: "Capital" }, { title: "Berlin (band)", snippet: "Band" }], article: articles["Berlin"] };
    },
    async article(title) {
      calls.push(`article ${title}`);
      await sleep(delay);
      return articles[title] ?? { error: "none" };
    },
  };
  return { wiki, calls };
}

test("Wikipedia: open, follow a link, back (no fetch), search, another result; the driver; more time; the refusals", async () => {
  const { wiki, calls } = fakeWiki();
  const { g, manual, room, screen, close } = await game(3, { manual: ["Ann", "Bob", "Cat"], columns: EN.filter((c) => !c.rule), wiki, settings: { rounds: 1, columns: 6 }, timings: { letterMax: 50, write: 300, vote: 3000, voteMax: 3000, voteEmpty: 3000, wikiGap: 60, wikiPer: 6, wikiMin: 5000, wikiMaxAdd: 9000, marked: 5000 } });
  try {
    g.script = { letter: "B" };
    const [a, b, c] = manual.map((m) => m.client) as [PartyClient, PartyClient, PartyClient];
    await a.act("start");
    await until(() => a.view["room"]?.phase === "write");
    await a.act("draft", { i: 0, text: "Berlin Wall" });
    await b.act("draft", { i: 0, text: "Bxqz" });
    await until(() => a.view["room"]?.stage === "vote");
    const answers = a.view["room"].answers as { id: string; who: string[] }[];
    const wall = answers.find((x) => x.who.includes(a.you!.id))!;
    const bxqz = answers.find((x) => x.who.includes(b.you!.id))!;
    const empty = answers.find((x) => x.who.includes(c.you!.id))!;
    await assert.rejects(c.act("wiki", { id: empty.id }), { code: "bad-answer" });
    await assert.rejects(c.act("wiki", { id: wall.id, pick: 1 }), { code: "bad-answer" });
    await assert.rejects(c.act("wiki-go", { title: "Berlin" }), { code: "no-article" });
    await assert.rejects(c.act("wiki-back"), { code: "no-back" });
    const before = room()["deadline"] as number;

    // Opened for an answer: the exact title; a redirect to a section starts there.
    await a.act("wiki", { id: wall.id });
    assert.equal(a.view["me"].lookups, 5);
    assert.equal(room()["wiki"].loading, true);
    assert.equal(room()["wiki"].query, "Berlin Wall");
    assert.ok((room()["deadline"] as number) > before);
    await until(() => room()["wiki"]?.title === "Berlin Wall" && !room()["wiki"].loading);
    let w = room()["wiki"];
    assert.deepEqual(
      { by: w.by, trail: w.trail, back: w.back, results: w.results, pick: w.pick, description: w.description, image: w.image },
      { by: a.you!.id, trail: ["Berlin Wall"], back: false, results: [], pick: -1, description: "About Berlin Wall", image: "https://upload.wikimedia.org/x.jpg" },
    );
    assert.equal(w.blocks.length, 7);
    // The TV starts at the section; `at` is the TV's only.
    assert.equal(screen()["wiki"].at, 5);
    assert.ok(!("at" in room()["wiki"]));

    // A search (the field): its results; another result.
    await sleep(70);
    await b.act("wiki-go", { q: "Capital of Germany" });
    await until(() => room()["wiki"]?.title === "Berlin" && !room()["wiki"].loading);
    w = room()["wiki"];
    assert.equal(w.by, b.you!.id);
    assert.deepEqual(w.trail, ["Berlin Wall", "Berlin"]);
    assert.equal(w.pick, 0);
    assert.equal(w.results.length, 2);
    assert.equal(screen()["wiki"].at, 0);
    await sleep(70);
    await b.act("wiki", { id: wall.id, pick: 1 });
    await until(() => room()["wiki"]?.title === "Berlin (band)" && !room()["wiki"].loading);
    assert.equal(room()["wiki"].pick, 1);

    // The driver reports its top block; others cannot.
    await assert.rejects(a.act("wiki-at", { block: 2 }), { code: "not-driver" });
    const roomBefore = JSON.stringify(room());
    await b.act("wiki-at", { block: 3 });
    assert.equal(screen()["wiki"].at, 3);
    await b.act("wiki-at", { block: 999 });
    assert.equal(screen()["wiki"].at, 6);
    assert.equal(JSON.stringify(room()), roomBefore, "phones get nothing for wiki-at");

    // Back: the article before, not fetched again; the one going back drives.
    const fetched = calls.length;
    await c.act("wiki-back");
    w = room()["wiki"];
    assert.equal(w.title, "Berlin");
    assert.equal(w.by, c.you!.id);
    assert.deepEqual(w.trail, ["Berlin Wall", "Berlin"]);
    assert.equal(calls.length, fetched);

    // A link: followed by its title; the cache serves a title read before.
    await sleep(70);
    await c.act("wiki-go", { title: "Germany" });
    await until(() => room()["wiki"]?.title === "Germany" && !room()["wiki"].loading);
    assert.deepEqual(room()["wiki"].trail, ["Berlin Wall", "Berlin", "Germany"]);
    assert.equal(room()["wiki"].back, true);
    await sleep(70);
    const n = calls.length;
    await c.act("wiki-go", { title: "Berlin" });
    await until(() => room()["wiki"]?.trail.length === 4 && !room()["wiki"].loading);
    assert.equal(calls.length, n, "from the cache");
    assert.equal(room()["wiki"].title, "Berlin");

    // Not found: an error, Back still works.
    await sleep(70);
    await a.act("wiki", { id: bxqz.id });
    await until(() => room()["wiki"]?.error === "none");
    assert.equal(room()["wiki"].query, "Bxqz");
    assert.equal(room()["wiki"].title, undefined);
    await a.act("wiki-back");
    assert.equal(room()["wiki"].title, "Berlin");

    // The refusals: bad titles, too fast, too many; Back and wiki-at are free.
    await assert.rejects(a.act("wiki-go", { title: "" }), { code: "bad-title" });
    await assert.rejects(a.act("wiki-go", { q: "x".repeat(201) }), { code: "bad-title" });
    await assert.rejects(a.act("wiki-go", { title: 42 }), { code: "bad-title" });
    await sleep(70);
    await a.act("wiki-go", { title: "Spree" });
    await assert.rejects(a.act("wiki-go", { title: "Spree" }), { code: "slow-down" });
    for (let k = a.view["me"].lookups; k > 0; k--) {
      await sleep(70);
      await a.act("wiki-go", { title: k % 2 ? "Spree" : "Germany" });
    }
    await sleep(70);
    await assert.rejects(a.act("wiki-go", { title: "Spree" }), { code: "too-many" });
    assert.equal(a.view["me"].lookups, 0);
    await a.act("wiki-back");
    // More time, but at most wikiMaxAdd in all.
    assert.ok((room()["deadline"] as number) <= before + 9000 + 5);
    // History: at most 20 steps.
    assert.ok(room()["wiki"].trail.length <= 20);

    await c.act("wiki-close");
    assert.equal(room()["wiki"], null);
    assert.equal(screen()["wiki"], null);
    for (const p of [a, b, c]) await p.act("done", { done: true });
    await until(() => g.stage === "marked");
    assert.equal(room()["wiki"], null);
    await assert.rejects(a.act("wiki-back"), { code: "too-late" });
    await assert.rejects(a.act("wiki-at", { block: 1 }), { code: "too-late" });
    await assert.rejects(a.act("wiki-go", { title: "Berlin" }), { code: "too-late" });
    g.close();
  } finally {
    close();
  }
});

test("bots read Wikipedia too: open, follow links, report where they are, go back; no errors", async () => {
  const { wiki, calls } = fakeWiki(5);
  const { g, players, close } = await game(3, { columns: EN.filter((c) => !c.rule), wiki, settings: { rounds: 1, columns: 6 }, bot: { chances: { wiki: 1, empty: 0, wrong: 0 }, think: () => 40 }, timings: { wikiGap: 10, vote: 3000, voteMax: 3000 } });
  try {
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await end;
    for (const b of players) assert.deepEqual(b.errors, [], b.name);
    assert.ok(calls.some((x) => x.startsWith("find ")));
    assert.ok(calls.some((x) => x.startsWith("article ")), calls.join(", "));
  } finally {
    close();
  }
});

test("Wikipedia: a newer step wins over one still loading; Back cancels loading", async () => {
  const { wiki } = fakeWiki(200);
  const { g, manual, room, close } = await game(2, { manual: ["Ann", "Bob"], columns: EN.filter((c) => !c.rule), wiki, settings: { rounds: 1, columns: 6 }, timings: { letterMax: 50, write: 300, vote: 5000, voteMax: 5000, voteEmpty: 5000, wikiGap: 10 } });
  try {
    g.script = { letter: "B" };
    const [a, b] = manual.map((m) => m.client) as [PartyClient, PartyClient];
    await a.act("start");
    await until(() => a.view["room"]?.phase === "write");
    await a.act("draft", { i: 0, text: "Berlin" });
    await until(() => a.view["room"]?.stage === "vote");
    const id = (a.view["room"].answers as { id: string; who: string[] }[]).find((x) => x.who.includes(a.you!.id))!.id;
    await a.act("wiki", { id });
    await until(() => room()["wiki"]?.title === "Berlin" && !room()["wiki"].loading);
    await a.act("wiki-go", { title: "Germany" });
    await sleep(20);
    await b.act("wiki-go", { title: "Spree" });
    await until(() => !room()["wiki"].loading, 3000);
    await sleep(300);
    assert.equal(room()["wiki"].title, "Spree");
    assert.deepEqual(room()["wiki"].trail, ["Berlin", "Spree"]);
    // Loading over the last article: Back cancels it.
    await sleep(20);
    await a.act("wiki-go", { title: "Germany" });
    assert.equal(room()["wiki"].loading, true);
    assert.equal(room()["wiki"].title, "Spree", "the last article stays under Looking it up…");
    await a.act("wiki-back");
    await sleep(300);
    assert.equal(room()["wiki"].title, "Berlin");
    assert.equal(room()["wiki"].loading, undefined);
    g.close();
  } finally {
    close();
  }
});

test("no Wikipedia (offline): the lookup says so", async () => {
  const { g, manual, room, close } = await game(3, { manual: ["Ann", "Bob", "Cat"], columns: EN.filter((c) => !c.rule), settings: { rounds: 1, columns: 6 }, timings: { letterMax: 50, write: 300, vote: 3000, voteMax: 3000 } });
  try {
    g.script = { letter: "B" };
    const [a] = manual.map((m) => m.client) as [PartyClient];
    await a.act("start");
    await until(() => a.view["room"]?.phase === "write");
    await a.act("draft", { i: 0, text: "Berlin" });
    await until(() => a.view["room"]?.stage === "vote");
    const id = (a.view["room"].answers as { id: string; who: string[] }[]).find((x) => x.who.includes(a.you!.id))!.id;
    await a.act("wiki", { id });
    await until(() => room()["wiki"]?.error === "offline");
    g.close();
  } finally {
    close();
  }
});

test("start and settings: the VIP only, checked, none during a game; the host page's changes reach the phones", async () => {
  const { g, party, players, close } = await game(3, { settings: { rounds: 2 }, timings: { letterMax: 2000 }, bot: { skip: ["draw"] } });
  try {
    const vip = players[0]!.client;
    const other = players[1]!.client;
    await assert.rejects(other.act("start"), { code: "not-vip" });
    await assert.rejects(other.act("settings", { rounds: 3 }), { code: "not-vip" });
    for (const bad of [{ rounds: 7 }, { columns: 9 }, { time: 60 }, { mix: "crazy" }, { content: "adult" }, { stop: "on" }, { classic: 1 }, { letters: "few" }, { late: "soon" }, { time: 240 }, { lang: "fr" }, { colour: "red" }]) {
      await assert.rejects(vip.act("settings", bad), { code: "bad-settings" }, JSON.stringify(bad));
    }
    // A bad value among good ones: nothing changes.
    await assert.rejects(vip.act("settings", { rounds: 5, mix: "crazy" }), { code: "bad-settings" });
    assert.equal(g.settings.rounds, 2);
    assert.equal(g.settings.late, "open");
    assert.equal(party.lateJoin, "open");
    await vip.act("settings", { time: 300 });
    assert.equal(g.settings.time, 300);
    const heard = new Promise((r) => g.once("settings", r));
    await vip.act("settings", { rounds: 5, columns: 10, time: 180, mix: "silly", content: "party", stop: false, classic: true, letters: "all", late: "closed", lang: "de" });
    assert.deepEqual(await heard, { rounds: 5, columns: 10, time: 180, mix: "silly", content: "party", stop: false, classic: true, letters: "all", late: "closed", lang: "de" });
    assert.equal(party.lateJoin, "closed");
    await until(() => players.every((p) => p.client.view["room"]?.lang === "de" && p.client.view["room"]?.settings?.rounds === 5));
    assert.equal(vip.view["room"].rounds, 5);
    g.configure({ lang: "en", rounds: 3, columns: 6, late: "wait", classic: false });
    await until(() => other.view["room"]?.settings?.rounds === 3 && other.view["room"]?.lang === "en");
    assert.equal(party.lateJoin, "wait");
    assert.throws(() => g.configure({ rounds: 7 as any }), { code: "bad-settings" });
    await vip.act("start");
    await assert.rejects(vip.act("start"), { code: "running" });
    await assert.rejects(vip.act("settings", { rounds: 4 }), { code: "running" });
    assert.throws(() => g.configure({ rounds: 4 }), { code: "running" });
    g.close();
  } finally {
    close();
  }
});

test("too few to start; too few left: the game ends at the next round, to its final screen", async () => {
  const one = await game(1, {});
  try {
    await assert.rejects(one.players[0]!.client.act("start"), { code: "too-few" });
  } finally {
    one.close();
  }
  // Three, one leaves: the duel goes on to the end.
  const three = await game(3, { settings: { rounds: 3 } });
  try {
    const end = new Promise((r) => three.g.once("end", r));
    await three.players[0]!.client.act("start");
    await until(() => three.g.phase === "write");
    three.players[2]!.client.leave();
    await end;
    assert.equal(three.phases.filter((p) => p === "report").length, 3);
  } finally {
    three.close();
  }
  const { g, players, phases, close } = await game(2, { settings: { rounds: 3 } });
  try {
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await until(() => g.phase === "write");
    // A duel: one leaves; the round in progress is not cut short, the next one does not start.
    players[1]!.client.leave();
    await end;
    assert.deepEqual(phases, [...ROUND(6), "final"]);
    assert.equal((g.party.screenView()["screen"] as any).cards.length, 1);
  } finally {
    close();
  }
});

test("late: wait: a latecomer waits for the next round, then plays", async () => {
  const { g, relay, party, players, o, close } = await game(3, { settings: { rounds: 2, late: "wait" } });
  try {
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await until(() => g.phase === "write");
    const late = new Bot({ ...o, url: "ws://party.test/_tvpipe/ws", WebSocket: relay.WebSocket, room: party.code, key: party.joinKey, name: "Late" });
    await late.join();
    await until(() => late.client.view["me"]?.task === "wait");
    await until(() => late.client.view["me"]?.task === "draw" || late.client.view["me"]?.task === "write", 8000);
    await end;
    assert.ok(g.totals.has(late.client.you!.id));
    assert.ok((party.screenView()["screen"] as any)["cards"].some((c: any) => c.id === late.client.you!.id));
    late.close();
  } finally {
    close();
  }
});

test("late: open (the default): a latecomer before the bell writes in this round, has a desk, scores; after it, watches and plays next round", async () => {
  const { g, relay, party, manual, players, room, screen, close } = await game(3, { manual: ["Ann"], columns: EN.filter((c) => !c.rule), settings: { rounds: 2, columns: 6 }, timings: { letterMax: 50, write: 1500, vote: 600, voteMax: 600 } });
  try {
    g.script = { letter: "B" };
    const end = new Promise((r) => g.once("end", r));
    await manual[0]!.client.act("start");
    await until(() => g.phase === "write");
    const late = new PartyClient({ url: "ws://t/", room: party.code, key: party.joinKey, storage: memoryStorage(), WebSocket: relay.WebSocket });
    await late.join("Late");
    const id = late.you!.id;
    await until(() => late.view["me"]?.task === "write" && late.view["room"]?.phase === "write");
    assert.deepEqual(late.view["me"].answers, ["", "", "", "", "", ""]);
    assert.equal(late.view["me"].total, 0);
    assert.ok(typeof late.view["room"].deadline === "number" && late.view["room"].columns.length === 6);
    assert.ok((screen()["players"] as string[]).includes(id), "a desk on the TV");
    assert.deepEqual(screen()["progress"][id], [0, 0, 0, 0, 0, 0]);
    assert.equal(late.view["room"].people[id].name, "Late");
    await late.act("draft", { i: 0, text: "Bremen" });
    assert.deepEqual(screen()["progress"][id], [2, 0, 0, 0, 0, 0]);
    await until(() => g.stage === "marked" && room()["col"] === 0, 8000);
    const answers = room()["answers"] as { id: string; who: string[] }[];
    const mine = answers.find((a) => a.who.includes(id))!;
    assert.ok(mine);
    const mark = (room()["marks"] as { id: string; points: number }[]).find((m) => m.id === mine.id)!;
    assert.ok(mark.points > 0);
    assert.equal(g.totals.get(id), mark.points);

    // A second latecomer during grading: watching, then in the next round.
    const later = new PartyClient({ url: "ws://t/", room: party.code, key: party.joinKey, storage: memoryStorage(), WebSocket: relay.WebSocket });
    await later.join("Later");
    await until(() => later.view["me"]?.task === "watch");
    assert.equal(later.view["me"].total, 0);
    await assert.rejects(later.act("doubt", { id: mine.id, on: true }), { code: "not-playing" });
    await until(() => g.round === 2 && g.phase === "write", 15_000);
    await until(() => later.view["me"]?.task === "write");
    await end;
    const cards = screen()["cards"] as { id: string; grades: { subject: string }[] }[];
    assert.ok(cards.some((c) => c.id === later.you!.id));
    // A latecomer's card has the subjects they wrote in only.
    const lateCard = cards.find((c) => c.id === id)!;
    assert.ok(lateCard.grades.length >= 1);
    void players;
    late.close();
    later.close();
  } finally {
    close();
  }
});

test("late: open with phones dropping out and coming back, and a latecomer: the game ends with everyone in it", async () => {
  const { g, relay, party, players, o, close } = await game(4, { settings: { rounds: 3, columns: 6 } });
  try {
    const late: Bot[] = [];
    const chaos = dropOuts(() => [...players, ...late].map((b) => b.client), { rng: seeded(11), every: 120, away: [0, 500], maxAway: 2 });
    const end = new Promise<{ total: number }[]>((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await until(() => g.phase === "write");
    const b = new Bot({ ...o, url: "ws://party.test/_tvpipe/ws", WebSocket: relay.WebSocket, room: party.code, key: party.joinKey, name: "Late" });
    await b.join();
    late.push(b);
    const table = await end;
    await chaos.stop();
    assert.equal(table.length, 5);
    assert.ok(g.totals.has(b.client.you!.id));
    b.close();
  } finally {
    close();
  }
});

test("phones drop out and come back all game long: the game ends with everyone in it", async () => {
  const { g, players, phases, close } = await game(5, { settings: { rounds: 3, columns: 6 } });
  try {
    const chaos = dropOuts(
      players.map((b) => b.client),
      { rng: seeded(5), every: 100, away: [0, 600], maxAway: 2 },
    );
    const end = new Promise<{ total: number }[]>((r) => g.once("end", r));
    await players[0]!.client.act("start");
    const table = await end;
    await chaos.stop();
    assert.equal(table.length, 5);
    assert.equal(phases.filter((p) => p === "report").length, 3);
    assert.ok(chaos.counts.network + chaos.counts.device > 0);
    await until(() => players.every((b) => b.client.view["me"]?.task === "final"));
  } finally {
    close();
  }
});

test("a duel with phones dropping out and coming back: an away phone still counts, the game ends with both", async () => {
  const { g, players, phases, close } = await game(2, { settings: { rounds: 3, columns: 6 } });
  try {
    const chaos = dropOuts(
      players.map((b) => b.client),
      { rng: seeded(9), every: 120, away: [0, 500], maxAway: 1 },
    );
    const end = new Promise<{ total: number }[]>((r) => g.once("end", r));
    await players[0]!.client.act("start");
    const table = await end;
    await chaos.stop();
    assert.equal(table.length, 2);
    assert.equal(phases.filter((p) => p === "report").length, 3);
    assert.ok(chaos.counts.network + chaos.counts.device > 0);
  } finally {
    close();
  }
});

test("the host's buttons: skip a column, end the round", async () => {
  const { g, players, phases, room, close } = await game(3, { settings: { rounds: 2, columns: 6 }, bot: { skip: ["grade"] }, timings: { vote: 3000, voteMax: 3000, voteEmpty: 3000 } });
  try {
    const end = new Promise((r) => g.once("end", r));
    assert.equal(g.skipColumn(), false);
    assert.equal(g.endRound(), false);
    await players[0]!.client.act("start");
    await until(() => g.stage === "vote" && room()["col"] === 0);
    assert.equal(g.skipColumn(), true);
    await until(() => g.stage === "vote" && room()["col"] === 1);
    assert.equal(g.endRound(), true);
    await until(() => g.phase === "report");
    await until(() => g.phase === "write");
    assert.equal(g.endRound(), true);
    await end;
    const first = phases.indexOf("report");
    assert.deepEqual(phases.slice(0, first + 1), ["letter", "board", "write", "bell", "grade:vote", "grade:vote", "report"]);
    assert.deepEqual(phases.slice(first + 1), ["letter", "board", "write", "bell", "report", "final"]);
    // Nothing graded: no points.
    assert.ok([...g.totals.values()].every((t) => t === 0));
  } finally {
    close();
  }
});

test("ending the round before the letter: no letter used, no grading; scripted columns", async () => {
  const { g, players, phases, screen, close } = await game(3, { settings: { rounds: 3, columns: 6 }, bot: { skip: ["draw"] }, timings: { letterMax: 3000 } });
  try {
    g.script = { columns: ["Sport", "Animal", "{player's} secret talent", "No such column"] };
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await until(() => g.phase === "letter");
    assert.equal(g.endRound(), true);
    await until(() => g.phase === "report");
    assert.deepEqual(screen()["used"], []);
    assert.equal(screen()["letter"], undefined);
    await until(() => g.phase === "board", 6000);
    const cols = g.current!.columns.map((c) => c.text);
    assert.equal(cols.length, 3);
    assert.deepEqual(cols.slice(0, 2), ["Sport", "Animal"]);
    assert.match(cols[2]!, /^(Ada|Bea|Cy)'s secret talent$/);
    g.close();
    void end;
    assert.deepEqual(phases.slice(0, 2), ["letter", "report"]);
  } finally {
    close();
  }
});

test("scripted columns are the list's: subject, rule and tags kept; the rule is checked in grading", async () => {
  const { g, manual, room, close } = await game(2, { lang: "de", manual: ["Ann", "Bob"], settings: { rounds: 3, columns: 6 }, timings: { letterMax: 50, write: 400, vote: 3000, voteMax: 3000 } });
  try {
    g.script = { letter: "F", columns: ["Zwei Wörter, ein Buchstabe", "Wort mit Doppelbuchstaben", "Etwas, das {player} kaufen würde"] };
    const [a, b] = manual.map((m) => m.client) as [PartyClient, PartyClient];
    await a.act("start");
    await until(() => a.view["room"]?.phase === "write");
    assert.deepEqual(a.view["room"].columns, [
      { subject: "lang", text: "Zwei Wörter, ein Buchstabe", rule: "rule:two" },
      { subject: "lang", text: "Wort mit Doppelbuchstaben", rule: "rule:double" },
      { subject: "register", text: a.view["room"].columns[2].text },
    ]);
    assert.match(a.view["room"].columns[2].text, /^Etwas, das (Ann|Bob) kaufen würde$/);
    assert.deepEqual(
      g.current!.columns.map((c) => c.rule ?? null),
      ["rule:two", "rule:double", null],
    );
    await a.act("draft", { i: 0, text: "Fliegende Fische" });
    await b.act("draft", { i: 0, text: "Fisch" });
    await a.act("draft", { i: 1, text: "Futter" });
    await b.act("draft", { i: 1, text: "Fisch" });
    await until(() => g.stage === "vote" && room()["col"] === 0);
    const auto = (col: number) => (room()["answers"] as { texts: string[]; auto?: string }[]).map((x) => [x.texts[0], x.auto ?? null]);
    assert.deepEqual(auto(0), [
      ["Fliegende Fische", null],
      ["Fisch", "rule:two"],
    ]);
    for (const p of [a, b]) await p.act("done", { done: true });
    await until(() => g.stage === "vote" && room()["col"] === 1);
    assert.deepEqual(auto(1), [
      ["Futter", null],
      ["Fisch", "rule:double"],
    ]);
    g.close();
  } finally {
    close();
  }
});

test("close(): the lobby at once, nothing written after it; then a fresh game", async () => {
  const { g, players, phases, screen, close } = await game(3, { settings: { rounds: 1 } });
  try {
    await players[0]!.client.act("start");
    await until(() => g.phase === "write");
    g.close();
    assert.equal(g.running, false);
    assert.equal(screen()["phase"], "lobby");
    await sleep(0);
    const n = phases.length;
    await sleep(500);
    assert.equal(phases.length, n);
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await end;
  } finally {
    close();
  }
});

test("classic on: City, Country, River whatever the letter; bots leave a classic without an example empty", async () => {
  const { g, players, room, close } = await game(3, { settings: { rounds: 1, columns: 6, classic: true }, timings: { letterMax: 50 } });
  try {
    g.script = { letter: "K" };
    const river: any[] = [];
    g.on("phase", (_p, s) => {
      if (s === "vote" && room()["columns"]?.[room()["col"]]?.text === "River") river.push(...room()["answers"]);
    });
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await end;
    assert.equal(river.length, 3, "River was on the board for K");
    assert.ok(river.every((a) => a.auto === "empty"));
    for (const b of players) assert.deepEqual(b.errors, [], b.name);
  } finally {
    close();
  }
});

test("in German: German columns, German grades", async () => {
  const { g, players, screen, close } = await game(3, { lang: "de", settings: { rounds: 1 } });
  try {
    const cols: string[] = [];
    g.on("phase", (p) => {
      if (p === "board") cols.push(...g.current!.columns.map((c) => c.text));
    });
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await end;
    const de = new Set(DE.map((c) => c.text));
    assert.ok(cols.length === 6 && cols.every((t) => de.has(t) || /geheimes Talent|kaufen würde/.test(t)), cols.join(", "));
    assert.ok(screen()["cards"].every((c: any) => c.grades.every((x: any) => /^[1-6]$/.test(x.grade))));
    assert.ok(screen()["used"][0] && "ABCDEFGHIJKLMNOPRSTUVWZ".includes(screen()["used"][0]));
  } finally {
    close();
  }
});

test("in Austrian German: German columns and letters, grades 1–5, the room says at", async () => {
  const { g, players, screen, close } = await game(3, { lang: "at", settings: { rounds: 1 } });
  try {
    const cols: string[] = [];
    g.on("phase", (p) => {
      if (p === "board") cols.push(...g.current!.columns.map((c) => c.text));
    });
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await end;
    const de = new Set(AT.map((c) => c.text));
    assert.ok(cols.length === 6 && cols.every((t) => de.has(t) || /geheimes Talent|kaufen würde/.test(t)), cols.join(", "));
    assert.equal(screen()["lang"], "at");
    assert.deepEqual(screen()["langs"], ["en", "de", "at"]);
    assert.ok("ABCDEFGHIJKLMNOPRSTUVWZ".includes(screen()["used"][0]));
    const cards = screen()["cards"] as { grades: { grade: string }[]; stamp: string; rank: number }[];
    assert.ok(cards.every((c) => c.grades.every((x) => /^[1-5]$/.test(x.grade))));
    for (const b of players) assert.deepEqual(b.errors, [], b.name);
  } finally {
    close();
  }
});

test("a phone that joins by hand gets the lobby: people with handwriting, the settings", async () => {
  const relay = new MemoryRelay();
  const party = new Party({ grace: 100, maxPlayers: 10 }).listen(relay);
  const g = new Classes(party, { columns: { en: EN }, timings: fast, rng: seeded(1) });
  g.open();
  const phones = [];
  for (const name of ["Ann", "Bob"]) {
    const phone = new PartyClient({ url: "ws://t/", room: party.code, key: party.joinKey, storage: memoryStorage(), WebSocket: relay.WebSocket });
    await phone.join(name);
    phones.push(phone);
  }
  const phone = phones[1]!;
  await until(() => phone.view["me"]?.task === "lobby" && Object.keys(phone.view["room"]?.people ?? {}).length === 2);
  const room = phone.view["room"];
  assert.equal(room.phase, "lobby");
  assert.deepEqual(
    Object.values(room.people).map((p: any) => [p.name, p.hand]),
    [
      ["Ann", 0],
      ["Bob", 1],
    ],
  );
  assert.deepEqual(room.settings, { rounds: 4, columns: 8, time: 120, mix: "mixed", content: "family", stop: true, classic: false, letters: "common", late: "open" });
  assert.deepEqual(room.langs, ["en"]);
  // de-AT: the VIP picks Austrian German only where its columns are there.
  await assert.rejects(phones[0]!.act("settings", { lang: "at" }), { code: "bad-settings" });
  assert.equal(room.minPlayers, 2);
  for (const p of phones) p.close();
  party.close();
});
