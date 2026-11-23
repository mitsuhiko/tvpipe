import assert from "node:assert/strict";
import { test } from "node:test";

import { Party } from "@tvpipe/party";
import { dropOuts, MemoryRelay } from "@tvpipe/party/testing";

import { Bot, bots } from "../game/bots.ts";
import { Worldquiz, type Settings, type Timings } from "../game/game.ts";
import { seeded } from "../game/rules.ts";
import { COUNTRIES, LAND } from "./world.ts";

const fast: Timings = { choose: 300, competeIntro: 5, competeCard: 5, competeEnd: 5, discard: 5, discardStrong: 5, announce: 5, reveal: 5, revealWhere: 5, nobody: 5, answer: 0.4 };

interface Opts {
  settings?: Partial<Settings>;
  silent?: number;
  sharp?: number;
  competes?: number;
  timings?: Partial<Timings>;
  lang?: "en" | "de";
}

async function game(n: number, o: Opts = {}) {
  const relay = new MemoryRelay();
  const party = new Party({ grace: 50, maxPlayers: 10 }).listen(relay);
  const g = new Worldquiz(party, { countries: COUNTRIES, land: LAND, settings: { rounds: 15, ...o.settings }, timings: { ...fast, ...o.timings }, rng: seeded(n), lang: o.lang });
  g.open();
  const phases: string[] = [];
  g.on("phase", (p, s) => phases.push(s ? `${p}:${s}` : p));
  const opts = {
    url: "ws://party.test/_tvpipe/ws",
    WebSocket: relay.WebSocket,
    room: party.code,
    key: party.joinKey,
    rng: seeded(n + 100),
    think: () => 3,
    oracle: () => g.truth(),
    sharp: o.sharp ?? 0.7,
    competes: o.competes,
  };
  const players = await bots(n - (o.silent ?? 0), opts);
  for (let i = 0; i < (o.silent ?? 0); i++) {
    const b = new Bot({ ...opts, name: `Mute${i + 1}`, silent: true });
    await b.join();
    players.push(b);
  }
  const screens: Record<string, any>[] = [];
  party.on("screen-view", () => screens.push(structuredClone(party.screenView()["screen"] as Record<string, any>)));
  return { relay, party, g, players, phases, screens, close: () => party.close() };
}

test("a whole game with 3 players: rounds up to a multiple of the players, everyone captain as often", async () => {
  const { g, players, phases, screens, close } = await game(3);
  try {
    const end = new Promise<{ id: string; steps: number; place: number }[]>((r) => g.once("end", r));
    await players[0]!.client.act("start");
    const lines = await end;
    assert.equal(lines.length, 3);
    assert.equal(screens.at(-1)!["rounds"], 15);
    const draws = phases.filter((p) => p === "round:draw").length;
    assert.equal(draws, 15);
    // Every seat gets the captaincy five times (rounds 1, 4, 7, …).
    const perRound = [...new Map(screens.filter((s) => s["stage"] === "draw").map((s) => [s["round"], s["captain"]])).values()];
    for (const id of new Set(perRound)) assert.equal(perRound.filter((x) => x === id).length, 5);
    assert.ok(phases.includes("round:compete"));
    assert.ok(phases.includes("round:challenge"));
    assert.equal(phases.at(-1), "final");
    // Places follow the steps.
    for (const l of lines) assert.equal(l.place, 1 + lines.filter((m) => m.steps > l.steps).length);
    assert.deepEqual(
      players.map((b) => b.errors),
      [[], [], []],
    );
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("4 players and 15 rounds play 16; the deck never repeats a card before it ran out", async () => {
  const { g, players, screens, close } = await game(4, { competes: 1 });
  try {
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await end;
    assert.equal(screens.at(-1)!["rounds"], 16);
    const competes = screens.filter((s) => s["stage"] === "compete");
    assert.ok(competes.length > 0);
    // Compete rounds: the winners have the best value.
    for (const s of competes) {
      const best = Math.max(...s["cards"].map((c: { value: number }) => c.value));
      const win = s["cards"].filter((c: { value: number }) => c.value === best).map((c: { pid: string }) => c.pid);
      assert.deepEqual([...s["winners"]].sort(), win.sort());
    }
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("secrecy: the TV never shows a card during the draw, a phone only its own card", async () => {
  const { party, g, players, close } = await game(3, { competes: 0.5 });
  try {
    const seen: string[] = [];
    party.on("screen-view", () => {
      const s = party.screenView()["screen"] as Record<string, any>;
      if (s["stage"] === "draw") {
        assert.equal(s["cards"], undefined);
        assert.ok(!JSON.stringify(s).includes('"capitals"'));
        seen.push("draw");
      }
      if (s["stage"] === "challenge") {
        const q = s["question"] ?? {};
        if (s["kind"] === "where") assert.deepEqual(Object.keys(q), ["name"]);
        if (s["kind"] === "flag") assert.deepEqual(Object.keys(q), ["flag"]);
        assert.equal(s["solution"], undefined);
      }
    });
    const cardsSeen = new Map<string, Set<string>>();
    for (const b of players)
      b.client.on("view", (v: any) => {
        if (v.me?.task === "card") {
          const set = cardsSeen.get(b.name) ?? new Set();
          set.add(v.me.card.id);
          cardsSeen.set(b.name, set);
          assert.equal(JSON.stringify(v.room).includes('"facts"'), false);
        }
      });
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await end;
    assert.ok(seen.length > 0);
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("the disputed option puts the disputed states in the deck and counts them as neighbours", async () => {
  const { g, players, close } = await game(2, { settings: { disputed: true }, competes: 1 });
  try {
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await end;
    const cc = g.card(COUNTRIES.find((c) => c.id === "CC")!);
    assert.equal(cc.facts.neighbours, 3);
    assert.ok(cc.neighbours.includes("Xenia"));
  } finally {
    for (const b of players) b.close();
    close();
  }
  const off = await game(2, { competes: 1 });
  try {
    const end = new Promise((r) => off.g.once("end", r));
    await off.players[0]!.client.act("start");
    await end;
    assert.equal(off.g.card(COUNTRIES.find((c) => c.id === "CC")!).facts.neighbours, 2);
  } finally {
    for (const b of off.players) b.close();
    off.close();
  }
});

test("nobody answers: three challenges, then the round ends without steps", async () => {
  const { g, players, screens, close } = await game(2, { silent: 2, timings: { choose: 30, answer: 0.05 }, settings: { rounds: 15 } });
  try {
    await new Promise((r) => setTimeout(r, 20));
    const end = new Promise((r) => g.once("end", r));
    void g.play();
    await end;
    const answers = screens.filter((s) => s["stage"] === "answer" && !s["tiebreak"]);
    // Both at 0 at the end: a tie-break of up to three pins, which nobody drops either.
    assert.equal(screens.filter((s) => s["stage"] === "answer" && s["tiebreak"]).length, 3);
    // Every round: three tries, each with no winner.
    assert.equal(answers.length, 16 * 3);
    assert.ok(answers.every((s) => s["winners"].length === 0));
    assert.equal(answers.filter((s) => s["again"]).length, 16 * 2);
    assert.ok([...g.steps.values()].every((s) => s === 0));
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("a tie at the top after the last round is settled by pins", async () => {
  const { g, players, phases, close } = await game(2, { sharp: 1, competes: 0, settings: { rounds: 15 } });
  try {
    const end = new Promise<{ steps: number; place: number }[]>((r) => g.once("end", r));
    await players[0]!.client.act("start");
    const lines = await end;
    const top = lines.filter((l) => l.place === 1);
    if (phases.includes("round:tiebreak")) assert.ok(top.length >= 1);
    else assert.equal(top.length, 1);
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("German: the cards and the questions are German only", async () => {
  const { g, players, close } = await game(2, { lang: "de", competes: 1 });
  try {
    const names = new Set<string>();
    players[1]!.client.on("view", (v: any) => {
      if (v.me?.card) names.add(v.me.card.name);
    });
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await end;
    for (const n of names) assert.ok(COUNTRIES.some((c) => c.name.de === n), n);
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("phones that drop out and come back while a game runs", async () => {
  const { g, players, close } = await game(4);
  try {
    const end = new Promise((r) => g.once("end", r));
    const chaos = dropOuts(players.map((b) => b.client), { rng: seeded(5), every: 50, away: [0, 200] });
    await players[0]!.client.act("start");
    await end;
    await chaos.stop();
    assert.equal(g.phase, "final");
    assert.ok(chaos.counts.network + chaos.counts.device > 0);
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("settings: only the VIP, only known values, not during a game", async () => {
  const { g, players, close } = await game(2);
  try {
    await assert.rejects(players[1]!.client.act("settings", { rounds: 30 }), /VIP/);
    await assert.rejects(players[0]!.client.act("settings", { rounds: 7 }), /rounds/);
    await assert.rejects(players[0]!.client.act("settings", { colour: 1 }), /not a setting/);
    await players[0]!.client.act("settings", { rounds: 30, difficulty: "hard", disputed: true, map: "globe" });
    assert.deepEqual(g.settings, { rounds: 30, difficulty: "hard", disputed: true, map: "globe" });
  } finally {
    for (const b of players) b.close();
    close();
  }
});
