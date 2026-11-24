import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { Party } from "@tvpipe/party";
import { dropOuts, MemoryRelay } from "@tvpipe/party/testing";

import { Bot, bots } from "../game/bots.ts";
import { Landgrab, type Timings } from "../game/game.ts";
import { FAST_PACE } from "../game/timeline.ts";
import { seeded, territoriesOf, type Board, type Plan } from "../game/rules.ts";
import { parseWorld } from "../game/world.ts";

const world = parseWorld(readFileSync(new URL("../data/world.txt", import.meta.url), "utf8"));

/** Everything short; the TV's pace too (the events' times are what the host waits). */
const fast: Partial<Timings> = {
  plan: 400,
  firstPlan: 0,
  ready: 5,
  banner: 5,
  after: 5,
  pace: { ...FAST_PACE, place: 2, move: 2, intro: 2, clash: 2, roll: 1, fastRoll: 1, maxRolls: 10, outro: 2, fanfare: 2, budget: 1000 },
};

async function until(cond: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

interface Opts {
  rounds?: number;
  silent?: number;
  timings?: Partial<Timings>;
  minPlayers?: number;
  think?: number;
}

async function game(n: number, opts: Opts = {}) {
  const relay = new MemoryRelay();
  const party = new Party({ grace: 50, maxPlayers: 6, lateJoin: "wait" }).listen(relay);
  const g = new Landgrab(party, { world, rounds: opts.rounds ?? 3, timings: { ...fast, ...opts.timings }, rng: seeded(7), minPlayers: opts.minPlayers });
  g.open();
  const phases: string[] = [];
  g.on("phase", (p) => phases.push(p));
  const o = { url: "ws://party.test/_tvpipe/ws", WebSocket: relay.WebSocket, room: party.code, key: party.joinKey, world, rng: seeded(n), think: () => opts.think ?? 3 };
  const silent = opts.silent ?? 0;
  const players = await bots(n - silent, o);
  for (let i = 0; i < silent; i++) {
    const b = new Bot({ ...o, name: `Mute${i + 1}`, silent: true });
    await b.join();
    players.push(b);
  }
  const screen = () => party.screenView()["screen"] as Record<string, any>;
  return { relay, party, g, players, phases, screen, close: () => party.close() };
}

/** Sum of armies and territories as the screen view has them. */
const held = (b: Board, id: string) => territoriesOf(b, id).length;

test("a whole game with 3 bots: rounds of planning and battle, the board consistent, a final table", async () => {
  const { party, g, players, phases, screen, close } = await game(3, { rounds: 3 });
  try {
    const steps: any[] = [];
    party.on("screen-view", (v) => {
      const s = (v["screen"] as any)?.step;
      if (s?.ev && steps.at(-1)?.i !== s.i) steps.push(s);
    });
    const end = new Promise<any[]>((r) => g.once("end", r));
    await players[0]!.client.act("start");
    const table = await end;
    assert.equal(table.length, 3);
    assert.deepEqual(
      phases.filter((p, i) => p !== phases[i - 1]),
      ["plan", "battle", "plan", "battle", "plan", "battle", "final"],
    );
    assert.ok(steps.length > 3, "the TV got the battles step by step");
    assert.ok(steps.some((s) => s.ev.type === "attack"));
    assert.equal(steps[0].ev.type, "place");
    // Everything holds: every territory has a holder or is wild, and at least one army.
    const b = screen()["board"] as Board;
    assert.equal(b.own.length, world.territories.length);
    assert.ok(b.arm.every((a) => a >= 1));
    // The table is by territories.
    for (let i = 1; i < table.length; i++) assert.ok(table[i - 1].lands >= table[i].lands);
    assert.deepEqual(table.map((s) => s.lands), table.map((s) => held(b, s.id)));
    assert.equal(screen()["phase"], "final");
    assert.deepEqual(
      players.map((p) => p.errors),
      [[], [], []],
    );
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("planning ends early when everyone is ready, and plans stay secret", async () => {
  const { party, g, players, close } = await game(2, { rounds: 1, timings: { plan: 60_000 } });
  try {
    const leaks: unknown[] = [];
    // No room or screen view ever carries a plan.
    party.on("screen-view", (v) => JSON.stringify(v).includes('"orders"') && leaks.push(v));
    const t0 = Date.now();
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await end;
    assert.ok(Date.now() - t0 < 10_000, "did not wait for the 60 s");
    assert.equal(JSON.stringify(party.room.peek()).includes('"orders"'), false);
    assert.deepEqual(leaks, []);
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("a silent player's reinforcements are placed for them at the deadline", async () => {
  const { g, players, party, close } = await game(3, { rounds: 1, silent: 1 });
  try {
    const mute = players[2]!;
    const id = mute.client.you!["id"] as string;
    let before = 0;
    g.on("phase", (p) => {
      if (p === "battle") before = g.board.arm.reduce((s, a, i) => s + (g.board.own[i] === id ? a : 0), 0);
    });
    const placed: any[] = [];
    party.on("screen-view", (v) => {
      const ev = (v["screen"] as any)?.step?.ev;
      if (ev?.type === "place") placed.push(ev);
    });
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await end;
    const mine = placed[0].add.filter(([, p]: [number, string]) => p === id);
    assert.ok(mine.length > 0, "the mute player got armies");
    assert.ok(before > 0);
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("refused plans: not during the battle, not someone else's territory, not too many armies", async () => {
  const { g, players, close } = await game(2, { rounds: 1, silent: 1, timings: { plan: 2000 } });
  try {
    const mute = players[1]!;
    const id = mute.client.you!["id"] as string;
    const code = (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string }) => e.code);
    assert.equal(await code(mute.client.act("plan", { place: {}, orders: [] })), "not-now");
    await players[0]!.client.act("start");
    await until(() => g.phase === "plan" && mute.client.view?.me?.task === "plan");
    const b = g.board;
    const mine = territoriesOf(b as Board, id);
    const theirs = b.own.findIndex((o) => o && o !== id);
    const reinf = mute.client.view!.me!.reinf.total as number;
    assert.equal(await code(mute.client.act("plan", { place: { [world.territories[theirs]!.id]: 1 } })), "not-yours");
    assert.equal(await code(mute.client.act("plan", { place: { [world.territories[mine[0]!]!.id]: reinf + 1 } })), "too-many");
    const plan: Plan = { place: { [world.territories[mine[0]!]!.id]: reinf }, orders: [], cash: false, ready: false };
    assert.equal(await code(mute.client.act("plan", plan as any)), "ok");
    await until(() => !!mute.client.view?.me?.plan?.place?.[world.territories[mine[0]!]!.id]);
    g.close();
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("a player who is wiped out rises again next round on the leader's weakest territory", async () => {
  const { g, players, party, close } = await game(3, { rounds: 2, silent: 1 });
  try {
    const mute = players[2]!;
    const id = mute.client.you!["id"] as string;
    // Round 1's battle: everything of the mute player goes wild (as if wiped out).
    g.on("phase", (p) => {
      if (p === "battle" && g.round === 1) {
        const b = g.board as Board;
        b.own.forEach((o, i) => o === id && (b.own[i] = ""));
      }
    });
    let rises: any[] = [];
    let owner = "";
    party.on("screen-view", (v) => {
      const s = v["screen"] as any;
      if (s?.phase === "plan" && s.round === 2) (rises = s.rises), (owner = s.board.own[s.rises[0]?.[1]] ?? "");
    });
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await end;
    // The phase event comes before the battle copies the board: the mute player holds nothing through it.
    assert.equal(rises.length, 1);
    assert.equal(rises[0][0], id);
    assert.equal(owner, id);
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("players who drop out and come back stay in the game to its end", async () => {
  const { party, g, players, close } = await game(3, { rounds: 3 });
  try {
    const chaos = dropOuts(players.map((b) => b.client), { rng: seeded(5), every: 120, away: [20, 200] });
    const end = new Promise<any[]>((r) => g.once("end", r));
    await players[0]!.client.act("start");
    const table = await end;
    await chaos.stop();
    assert.equal(table.length, 3);
    assert.equal(party.players.length, 3);
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("a game ends when too few are left at a round's start", async () => {
  const { party, g, players, close } = await game(2, { rounds: 5 });
  try {
    const end = new Promise<any[]>((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await until(() => g.phase === "battle");
    party.kick(party.players.find((p) => p.name === players[1]!.name)!);
    await end;
    assert.ok(g.round <= 2);
    assert.equal((party.screenView()["screen"] as any).final.by, "players");
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("a latecomer waits, then rises as a rebel at the next round", async () => {
  const { relay, party, g, players, close } = await game(2, { rounds: 2 });
  try {
    const end = new Promise<any[]>((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await until(() => g.phase === "plan");
    const late = new Bot({ url: "ws://party.test/_tvpipe/ws", WebSocket: relay.WebSocket, room: party.code, key: party.joinKey, world, name: "Late", think: () => 3 });
    await late.join();
    await until(() => late.client.view?.me?.task === "wait");
    await end;
    const id = late.client.you!["id"] as string;
    assert.ok(g.ids.includes(id));
    late.close();
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("the VIP's settings: every one the host page has, checked, only the VIP's, none during a game", async () => {
  // The other player is silent: planning lasts its 60 s, so the room is still at the plan for the last checks.
  const { party, g, players, close } = await game(2, { rounds: 1, silent: 1, timings: { plan: 60_000 } });
  try {
    const [vip, other] = players.map((p) => p.client) as [Bot["client"], Bot["client"]];
    let told = 0;
    g.on("settings", () => told++);
    const room = () => other.view["room"] as Record<string, unknown>;
    await until(() => room()?.["late"] === "wait" && room()["lang"] === "en");
    for (const s of [{ lang: "de" }, { rounds: 12 }, { planTime: 90 }, { late: "closed" }]) {
      await assert.rejects(other.act("settings", s), { code: "not-vip" });
    }
    for (const s of [{ lang: "fr" }, { rounds: 7 }, { planTime: 30 }, { late: "open" }, { late: true }, { colour: 1 }]) {
      await assert.rejects(vip.act("settings", s), { code: "bad-settings" });
    }
    assert.equal(told, 0);
    await vip.act("settings", { lang: "de", rounds: 12, planTime: 90, late: "closed" });
    assert.deepEqual([g.lang, g.rounds, g.planTime, g.late, party.lateJoin], ["de", 12, 90, "closed", "closed"]);
    assert.ok(told > 0, "the host page hears of it");
    await until(() => room()["lang"] === "de" && room()["rounds"] === 12 && room()["planTime"] === 90 && room()["late"] === "closed");
    await vip.act("settings", { late: "wait" });
    assert.equal(party.lateJoin, "wait");
    await until(() => room()["late"] === "wait");
    // The host page's latecomers field goes through the game too: the phones see it.
    g.configure({ late: "closed" });
    await until(() => room()["late"] === "closed");
    g.configure({ rounds: 1, planTime: 45 });
    await vip.act("start");
    await until(() => g.phase === "plan");
    for (const s of [{ lang: "en" }, { rounds: 6 }, { planTime: 60 }, { late: "wait" }]) {
      await assert.rejects(vip.act("settings", s), { code: "running" });
    }
    // The plan's room view carries it too.
    await until(() => room()["phase"] === "plan" && room()["late"] === "closed");
  } finally {
    for (const b of players) b.close();
    close();
  }
});
