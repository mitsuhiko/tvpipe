import assert from "node:assert/strict";
import { test } from "node:test";

import { Party, type LateJoin } from "@tvpipe/party";
import { memoryStorage, PartyClient } from "@tvpipe/party/client";
import { dropOuts, MemoryRelay } from "@tvpipe/party/testing";

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

import { bots, LIES } from "../game/bots.ts";
import { Drawbluff, FAST_TIMINGS, MAX_ROUNDS, SLOW_TIMINGS } from "../game/game.ts";
import { palette, PLAYER_COLORS, seeded, type Lang } from "../game/rules.ts";
import { ADULT_BY_LANG, PROMPT_LIST, PROMPTS_BY_LANG } from "./prompts.ts";

const fast = { draw: 1500, drawAnimated: 1500, lie: 1200, vote: 1200, revealStep: 20, revealEnd: 20, scores: 20, gallery: 20 };

async function game(
  n: number,
  opts: { silent?: number; drop?: number; rounds?: number; think?: number; lateJoin?: LateJoin; lang?: Lang; adult?: boolean; tvDelay?: number; minPlayers?: number } = {},
) {
  const relay = new MemoryRelay();
  const party = new Party({ grace: 100, maxPlayers: Math.max(8, n + 2), tvDelay: opts.tvDelay }).listen(relay);
  const server = { relay, close: async () => party.close() };
  const g = new Drawbluff(party, {
    rounds: opts.rounds ?? 2,
    minPlayers: opts.minPlayers,
    timings: fast,
    rng: seeded(7),
    lateJoin: opts.lateJoin,
    prompts: opts.lang ? PROMPTS_BY_LANG : PROMPT_LIST,
    lang: opts.lang,
    adultPrompts: opts.adult ? { en: ADULT_BY_LANG.en } : undefined,
  });
  g.open();
  const url = "ws://party.test/_tvpipe/ws";
  const phases: string[] = [];
  g.on("phase", (p) => phases.push(p));
  const players = await bots(n, { url, WebSocket: relay.WebSocket, room: party.code, key: party.joinKey, rng: seeded(n), think: () => opts.think ?? 5 });
  if (opts.silent !== undefined) {
    // One player who never answers: their client stays connected.
    players[opts.silent]!.client.on("view", () => {});
  }
  return { server, party, g, players, phases };
}

test("a whole game with 3 players", async () => {
  const { server, party, g, players, phases } = await game(3);
  try {
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    const table = (await end) as { name: string; score: number }[];
    assert.equal(table.length, 3);
    assert.equal(phases.filter((p) => p === "draw").length, 2);
    assert.equal(phases.filter((p) => p === "reveal").length, 6, "each player's drawing, twice");
    assert.equal(g.phase, "final");
    const total = table.reduce((s, l) => s + l.score, 0);
    assert.ok(total > 0, "someone scored");
    assert.deepEqual(
      players.map((b) => b.errors),
      [[], [], []],
    );
    // Phones show the final screen with their rank.
    await until(() => players.every((b) => b.client.view["me"].task === "final"));
    assert.equal(party.screenView()["screen"]!.constructor, Object);
    assert.equal((party.screenView()["screen"] as { phase: string }).phase, "final");
    assert.equal(party.locked, false);
  } finally {
    for (const b of players) b.close();
    await server.close();
  }
});

test("with a TV behind: phones get each phase when the TV shows it, with the whole time to answer", async () => {
  const { server, party, g, players } = await game(3, { rounds: 1, tvDelay: 150 });
  const tv = new PartyClient({ url: "ws://party.test/_tvpipe/ws", room: party.code, key: party.screenKey, role: "screen", storage: memoryStorage(), WebSocket: server.relay.WebSocket });
  try {
    await tv.connect();
    const phone = players[0]!.client;
    await until(() => phone.rtt < 1000 && tv.rtt < 1000);
    const seen: Record<string, number> = {};
    let deadline = 0;
    tv.on("view", (v) => v.screen?.phase === "draw" && (seen["tv"] ??= Date.now()));
    phone.on("view", (v) => {
      if (v.room?.phase !== "draw" || seen["phone"]) return;
      seen["phone"] = Date.now();
      deadline = v.me.deadline;
    });
    const end = new Promise((r) => g.once("end", r));
    await phone.act("start");
    await until(() => seen["tv"] !== undefined && seen["phone"] !== undefined);
    assert.ok(seen["phone"]! - seen["tv"]! >= 100, `the phone ${seen["phone"]! - seen["tv"]!} ms after the TV`);
    // The countdown starts with the phase on the phone and the TV alike.
    const left = deadline - phone.now();
    assert.ok(left > fast.draw - 100 && left <= fast.draw + 20, `${left} ms left to draw`);
    assert.ok(Math.abs(tv.now() - phone.now() - 150) < 30, "the TV counts by its picture");
    await end;
    assert.deepEqual(
      players.map((b) => b.errors),
      [[], [], []],
    );
  } finally {
    tv.close();
    for (const b of players) b.close();
    await server.close();
  }
});

test("8 players, one round (the classic game's most)", async () => {
  const { server, g, players } = await game(8, { rounds: 1 });
  try {
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    const table = (await end) as unknown[];
    assert.equal(table.length, 8);
  } finally {
    for (const b of players) b.close();
    await server.close();
  }
});

test("too few players, non-VIP start, a late joiner plays from the next round", async () => {
  const { server, party, g, players } = await game(2);
  try {
    await assert.rejects(players[0]!.client.act("start"), (e: { code: string }) => e.code === "too-few");
    const more = await bots(1, { url: "ws://party.test/_tvpipe/ws", WebSocket: server.relay.WebSocket, room: party.code, key: party.joinKey, names: ["Zed"], think: () => 5 });
    players.push(...more);
    await assert.rejects(players[1]!.client.act("start"), (e: { code: string }) => e.code === "not-vip");
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await until(() => g.phase === "lie" || g.phase === "vote");
    const late = await bots(1, { url: "ws://party.test/_tvpipe/ws", WebSocket: server.relay.WebSocket, room: party.code, key: party.joinKey, names: ["Late"], think: () => 5 });
    players.push(...late);
    await until(() => late[0]!.client.view["me"]?.task === "wait");
    assert.equal(late[0]!.client.view["me"].note, "round");
    assert.equal(party.players.find((p) => p.name === "Late")!.waiting, true);
    await until(() => (party.screen.peek() as { joined?: string[] }).joined?.includes("Late") === true);
    await until(() => late[0]!.client.view["me"]?.task === "draw", 15_000);
    assert.equal(party.players.find((p) => p.name === "Late")!.waiting, false);
    const table = (await end) as { name: string }[];
    assert.deepEqual(table.map((l) => l.name).sort(), ["Ada", "Bea", "Late", "Zed"]);
  } finally {
    for (const b of players) b.close();
    await server.close();
  }
});

test("late join open: dealt in at the next drawing (never into a running vote), first in the next round's spotlights", async () => {
  // 13: pipelined, and in round 2 seven never-spotted players compete for six spotlights.
  const { server, party, g, players } = await game(13, { lateJoin: "open" });
  try {
    const url = "ws://party.test/_tvpipe/ws";
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    assert.equal(party.inProgress, true);
    await until(() => g.phase === "vote", 15_000);
    const s = party.screen.peek() as { round: number; spot: number };
    const running = `${s.round}.${s.spot}`;
    const late = (await bots(1, { url, WebSocket: server.relay.WebSocket, room: party.code, key: party.joinKey, names: ["Late"], think: () => 5 }))[0]!;
    players.push(late);
    const tasks: string[] = [];
    late.client.on("view", (v) => {
      const me = v["me"] ?? {};
      const t = `${v["room"]?.round}:${me.task}:${me.key ?? me.note ?? ""}`;
      if (tasks[tasks.length - 1] !== t) tasks.push(t);
    });
    await until(() => late.client.view["me"]?.task === "wait");
    assert.equal(late.client.view["me"].note, "drawing");
    await until(() => (party.screen.peek() as { joined?: string[] }).joined?.includes("Late") === true);
    // Round 2: Late draws, and their drawing gets the stage.
    const id = late.client.you!.id;
    let spotted = false;
    g.on("phase", (p) => {
      const v = party.screen.peek() as { round?: number; artist?: { id: string } };
      if ((p === "lie" || p === "vote") && v.round === 2 && v.artist?.id === id) spotted = true;
    });
    const table = (await end) as { name: string }[];
    assert.ok(table.some((l) => l.name === "Late"));
    assert.ok(!tasks.some((t) => t.startsWith("1:draw")), `no drawing in round 1: ${tasks.join(" ")}`);
    assert.ok(!tasks.some((t) => t === `1:vote:${running}`), "not in the running vote");
    assert.ok(tasks.some((t) => t.startsWith("1:vote:") || t.startsWith("1:lie:")), `dealt in during round 1: ${tasks.join(" ")}`);
    assert.ok(tasks.some((t) => t.startsWith("2:draw")), "draws in round 2");
    assert.ok(spotted, "a spotlight for the newcomer in round 2");
    assert.equal(party.inProgress, false);
    assert.deepEqual(late.errors, []);
  } finally {
    for (const b of players) b.close();
    await server.close();
  }
});

test("late join closed: newcomers refused during the game, welcome after; the VIP's toggle", async () => {
  const { server, party, g, players } = await game(3, { rounds: 1 });
  try {
    const url = "ws://party.test/_tvpipe/ws";
    assert.equal(players[0]!.client.view["room"].lateJoin, "wait");
    await assert.rejects(players[1]!.client.act("late-join", { mode: "closed" }), (e: { code: string }) => e.code === "not-vip");
    await assert.rejects(players[0]!.client.act("late-join", { mode: "maybe" }), (e: { code: string }) => e.code === "bad-mode");
    await players[0]!.client.act("late-join", { mode: "closed" });
    assert.equal(party.lateJoin, "closed");
    await until(() => players[1]!.client.view["room"].lateJoin === "closed");
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await assert.rejects(players[0]!.client.act("late-join", { mode: "open" }), (e: { code: string }) => e.code === "running");
    await assert.rejects(bots(1, { url, WebSocket: server.relay.WebSocket, room: party.code, key: party.joinKey, names: ["Late"] }), (e: { code: string }) => e.code === "in-progress");
    await end;
    const late = await bots(1, { url, WebSocket: server.relay.WebSocket, room: party.code, key: party.joinKey, names: ["Late"] });
    players.push(...late);
    await until(() => late[0]!.client.view["me"]?.task === "final");
    assert.equal(party.players.length, 4);
  } finally {
    for (const b of players) b.close();
    await server.close();
  }
});

test("a silent player and one who drops mid-game: deadlines move the game on", async () => {
  const { server, g, players } = await game(4, { rounds: 1 });
  try {
    const silent = players[3]!;
    silent.client.close(); // gone: never answers, never comes back
    const end = new Promise((r) => g.once("end", r));
    // A player who drops during the drawing phase and comes back.
    g.once("phase", (p) => {
      if (p === "draw") players[2]!.client.drop();
    });
    const t0 = Date.now();
    await players[0]!.client.act("start");
    const table = (await end) as { name: string }[];
    assert.equal(table.length, 4, "the away player keeps their place");
    assert.ok(Date.now() - t0 >= fast.draw, "the draw phase waited for the deadline");
    assert.equal(players[2]!.client.status, "open");
  } finally {
    for (const b of players) b.close();
    await server.close();
  }
});

test("phones drop out and come back all game long (a lost signal, another phone): the game ends with everyone in it", async () => {
  const { server, party, g, players, phases } = await game(5, { rounds: 2 });
  try {
    const chaos = dropOuts(
      players.map((b) => b.client),
      { rng: seeded(5), every: 100, away: [0, 800], maxAway: 2 },
    );
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    const table = (await end) as { name: string }[];
    await chaos.stop();
    assert.ok(chaos.counts.network > 0 && chaos.counts.device > 0, JSON.stringify(chaos.counts));
    assert.equal(table.length, 5);
    assert.equal(phases.at(-1), "final");
    assert.equal(party.players.length, 5, "nobody came back as somebody new");
    await until(() => players.every((b) => b.client.view["me"]?.task === "final"));
  } finally {
    for (const b of players) b.close();
    await server.close();
  }
});

test("VIP removes a player in the lobby", async () => {
  const { server, party, players } = await game(3);
  try {
    await players[0]!.client.act("kick", { id: players[2]!.client.you!.id });
    assert.equal(party.players.length, 2);
    await assert.rejects(players[1]!.client.act("kick", { id: players[0]!.client.you!.id }), (e: { code: string }) => e.code === "not-vip");
  } finally {
    for (const b of players) b.close();
    await server.close();
  }
});

test("the host page removes players and moves the VIP during a game: it plays on", async () => {
  const { server, party, g, players, phases } = await game(8, { rounds: 2 });
  try {
    const end = new Promise((r) => g.once("end", r));
    const removed: string[] = [];
    // One player removed in each kind of phase, the first time it comes.
    g.on("phase", (p) => {
      if (removed.includes(p) || !["draw", "lie", "vote", "reveal", "scores"].includes(p)) return;
      removed.push(p);
      setTimeout(() => {
        const victim = party.players.find((x) => !x.vip);
        if (victim) party.kick(victim);
        const next = party.players.find((x) => !x.vip);
        if (next) party.makeVip(next);
      }, 30);
    });
    await players[0]!.client.act("start");
    const table = (await end) as unknown[];
    assert.equal(removed.length, 5, "every kind of phase came");
    assert.equal(g.phase, "final");
    assert.equal(party.players.length, 3);
    assert.equal(phases.filter((p) => p === "draw").length, 2, "three are enough for the next round");
    assert.equal(table.length, 3, "the removed are not ranked");
    assert.equal(party.players.filter((p) => p.vip).length, 1);
  } finally {
    for (const b of players) b.close();
    await server.close();
  }
});

test("too few players left: the game ends at the next round, to the final screen; an away phone still counts", async () => {
  // One leaves and one's phone goes away for good in round 1: three still in it, both rounds.
  {
    const { server, g, players, phases } = await game(4, { rounds: 2 });
    try {
      g.once("phase", (p) => {
        if (p !== "draw") return;
        players[3]!.client.leave();
        players[2]!.client.close();
      });
      const end = new Promise((r) => g.once("end", r));
      await players[0]!.client.act("start");
      const table = (await end) as unknown[];
      assert.equal(phases.filter((p) => p === "draw").length, 2);
      assert.equal(table.length, 3);
    } finally {
      for (const b of players) b.close();
      await server.close();
    }
  }
  // One leaves and the host removes another in round 1: two left, round 2 does not start.
  {
    const { server, party, g, players, phases } = await game(4, { rounds: 3 });
    try {
      g.once("phase", (p) => {
        if (p !== "draw") return;
        players[3]!.client.leave();
        party.kick(party.players[2]!);
      });
      const end = new Promise((r) => g.once("end", r));
      await players[0]!.client.act("start");
      const table = (await end) as unknown[];
      assert.equal(phases.filter((p) => p === "draw").length, 1);
      assert.equal(phases.filter((p) => p === "scores").length, 1, "round 1 played to its scores");
      assert.equal(phases.at(-1), "final");
      assert.equal(table.length, 2);
      assert.equal(g.running, false);
      assert.equal((party.screen.peek() as { phase: string }).phase, "final");
      await until(() => players.slice(0, 2).every((b) => b.client.view["me"]?.task === "final"));
    } finally {
      for (const b of players) b.close();
      await server.close();
    }
  }
  // The game's own minimum: with minPlayers 2, two play on.
  {
    const { server, g, players, phases } = await game(3, { rounds: 2, minPlayers: 2 });
    try {
      g.once("phase", (p) => {
        if (p === "draw") players[2]!.client.leave();
      });
      const end = new Promise((r) => g.once("end", r));
      await players[0]!.client.act("start");
      const table = (await end) as unknown[];
      assert.equal(phases.filter((p) => p === "draw").length, 2);
      assert.equal(table.length, 2);
    } finally {
      for (const b of players) b.close();
      await server.close();
    }
  }
});

test("close(): back to the lobby at once, nothing of the closed game writes after it, and the next game plays", async () => {
  const { server, party, g, players } = await game(3, { rounds: 2, tvDelay: 150 });
  try {
    await players[0]!.client.act("start");
    // A late joiner waits for the next round.
    await until(() => g.phase === "lie" || g.phase === "vote");
    const late = await bots(1, { url: "ws://party.test/_tvpipe/ws", WebSocket: server.relay.WebSocket, room: party.code, key: party.joinKey, names: ["Late"], think: () => 5 });
    players.push(...late);
    await until(() => party.players.find((p) => p.name === "Late")?.waiting === true);
    await until(() => g.phase === "vote");
    const after: string[] = [];
    g.on("phase", (p) => after.push(p));
    g.on("end", () => after.push("end"));
    g.close();
    // At once: the lobby on the TV, in the room and on every phone, everyone in.
    assert.equal(g.running, false);
    assert.equal(g.phase, "lobby");
    assert.equal(party.inProgress, false);
    assert.ok(party.players.every((p) => !p.waiting));
    assert.equal((party.screen.peek() as { phase: string }).phase, "lobby");
    assert.equal((party.room.peek() as { phase: string }).phase, "lobby");
    assert.ok(party.players.every((p) => (p.state.peek() as { task: string }).task === "lobby"));
    assert.deepEqual(after, ["lobby"]);
    // Then nothing: no phase, no final screen, no view changes (the game's timers are gone).
    const views = () => JSON.stringify([party.screen.peek(), party.room.peek(), party.players.map((p) => p.state.peek())]);
    const was = views();
    await new Promise((r) => setTimeout(r, fast.vote + fast.lie + 500));
    assert.equal(views(), was);
    assert.deepEqual(after, ["lobby"]);
    await until(() => players.every((b) => b.client.view["me"]?.task === "lobby"));
    // The VIP starts again: a fresh game, with the late joiner from its first round.
    for (const b of players) b.errors = [];
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    const table = (await end) as { name: string; score: number }[];
    assert.equal(table.length, 4);
    assert.ok(table.some((l) => l.score > 0), "someone scored");
    assert.equal(after.filter((p) => p === "draw").length, 2);
    assert.deepEqual(
      players.map((b) => b.errors),
      [[], [], [], []],
    );
    // Closing a finished game goes to the lobby too; a second close changes nothing.
    g.close();
    assert.equal((party.room.peek() as { phase: string }).phase, "lobby");
    g.close();
    assert.equal(g.phase, "lobby");
  } finally {
    for (const b of players) b.close();
    await server.close();
  }
});

test("a closed bot never acts", async () => {
  const { server, g, players } = await game(3, { rounds: 1, think: 150 });
  try {
    await players[0]!.client.act("start");
    await until(() => players[1]!.client.view["me"]?.task === "draw");
    players[1]!.close();
    await new Promise((r) => setTimeout(r, 400));
    assert.deepEqual(players[1]!.errors, [], "no answer sent from a closed client");
    g.close();
  } finally {
    for (const b of players) b.close();
    await server.close();
  }
});

test("50 players: spotlights, rotating liars, pipelined lies, sampled options, every phone busy", async () => {
  const { server, party, g, players } = await game(50, { rounds: 2, think: 150 });
  try {
    const phases: string[] = [];
    const problems: string[] = [];
    const byId = new Map(players.map((b) => [b.client.you!.id, b]));
    g.on("phase", (p) => {
      phases.push(p);
      if (p !== "vote") return;
      // Checked once the vote's views are out.
      setTimeout(() => {
        const s = party.screen.peek() as Record<string, any>;
        if (s["phase"] !== "vote") return problems.push("the vote was over too soon to check");
        const voters = new Set<string>(s["waiting"]);
        let liars = 0;
        for (const [id, b] of byId) {
          const me = b.client.view["me"] ?? {};
          if (me.task === "vote") {
            if (!voters.has(id)) problems.push(`${id} votes but is not waited for`);
            const opts = me.options as { id: string }[];
            if (opts.length > 6) problems.push(`${id} has ${opts.length} options`);
            const tv = (s["options"] as { id: string }[]).map((o) => o.id);
            const order = opts.map((o) => tv.indexOf(o.id));
            if (order.some((x, i) => x < 0 || (i > 0 && x < order[i - 1]!))) problems.push(`${id}: options not in the TV's order`);
          } else if (me.task === "lie") liars++;
          else if (me.task !== "artist") problems.push(`${id} has nothing to do: ${me.task}`);
        }
        if (s["spot"] < s["spots"] && liars === 0) problems.push(`no liars writing during vote ${s["spot"]}`);
      }, 60);
    });
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    const table = (await end) as { name: string; score: number }[];
    assert.equal(table.length, 50);
    assert.deepEqual(problems.slice(0, 5), []);
    assert.equal(phases.filter((p) => p === "reveal").length, 12, "6 spotlights a round");
    assert.equal(phases.filter((p) => p === "gallery").length, 2);
    assert.ok(table[0]!.score < 40_000, `points scaled: ${table[0]!.score}`);
    const screen = party.screen.peek() as Record<string, any>;
    assert.equal(screen["total"], 50);
    assert.equal(screen["scores"].length, 8);
    assert.ok(players.every((b) => b.client.view["me"].of === 50));
    assert.deepEqual(new Set(players.flatMap((b) => b.errors)), new Set());
  } finally {
    for (const b of players) b.close();
    await server.close();
  }
});

test("a room deals no prompt twice over several games, nor one it showed as a decoy", async () => {
  // 3 players: two liars, so a vote may have a decoy (one of the prompt's own).
  const { server, party, g, players } = await game(3);
  try {
    const shown = new Set<string>();
    const dealt: string[] = [];
    const problems: string[] = [];
    g.on("phase", (p) => {
      if (p === "draw") {
        // Every phone's prompt, once the host set it.
        queueMicrotask(() => {
          for (const pl of party.players) {
            const me = pl.state.peek() as { task?: string; prompt?: string };
            if (me.task !== "draw" || !me.prompt) continue;
            if (shown.has(me.prompt)) problems.push(`${me.prompt} again`);
            shown.add(me.prompt);
            dealt.push(me.prompt);
          }
        });
      }
      if (p === "vote") {
        queueMicrotask(() => {
          for (const o of (party.screen.peek() as { options: { text: string }[] }).options) shown.add(o.text);
        });
      }
    });
    for (let n = 0; n < 3; n++) {
      const end = new Promise((r) => g.once("end", r));
      await players[0]!.client.act("start");
      await end;
    }
    assert.equal(dealt.length, 3 * 2 * 3, "3 games, 2 rounds, 3 prompts");
    assert.deepEqual(problems, []);
    assert.deepEqual(new Set(players.flatMap((b) => b.errors)), new Set());
  } finally {
    for (const b of players) b.close();
    await server.close();
  }
});

test("too few lies: the game adds decoys written for the drawing's prompt, never other prompts", async () => {
  // 3 players and a silent one: every drawing has two lies and a decoy.
  const { server, party, g, players } = await game(3, { rounds: 1 });
  const [quiet] = await bots(1, { url: "ws://party.test/_tvpipe/ws", WebSocket: server.relay.WebSocket, room: party.code, key: party.joinKey, silent: true, names: ["Quiet"] });
  players.push(quiet!);
  try {
    const byText = new Map(PROMPT_LIST.map((p) => [p.text, p]));
    const dealt = new Map<string, string>();
    const problems: string[] = [];
    let votes = 0;
    g.on("phase", (p) => {
      if (p === "draw") {
        queueMicrotask(() => {
          for (const pl of party.players) {
            const me = pl.state.peek() as { task?: string; prompt?: string };
            if (me.task === "draw" && me.prompt) dealt.set(pl.id, me.prompt);
          }
        });
      }
      if (p === "vote") {
        queueMicrotask(() => {
          const screen = party.screen.peek() as { artist: { id: string }; options: { text: string }[] };
          const truth = dealt.get(screen.artist.id)!;
          const decoys = new Set(byText.get(truth)!.decoys);
          const texts = screen.options.map((o) => o.text);
          votes++;
          if (texts.length !== 4) problems.push(`${truth}: ${texts.length} options`);
          if (!texts.some((t) => decoys.has(t))) problems.push(`${truth}: no decoy of its own in ${texts.join(", ")}`);
          for (const t of texts) if (t !== truth && byText.has(t)) problems.push(`${truth}: the prompt ${t} as a decoy`);
        });
      }
    });
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await end;
    assert.equal(votes, 3, "three drawings (the silent player draws nothing)");
    assert.deepEqual(problems, []);
  } finally {
    for (const b of players) b.close();
    await server.close();
  }
});

test("German: the room's language reaches every phone and the TV, with German prompts and German bots' lies", async () => {
  const { server, party, g, players } = await game(4, { lang: "en" });
  try {
    assert.equal(players[1]!.client.view["room"].lang, "en");
    assert.deepEqual(g.langs.sort(), ["de", "en"]);
    g.configure({ lang: "de" });
    await until(() => players.every((b) => b.client.view["room"]?.lang === "de"));
    assert.equal((party.screenView()["screen"] as { lang: string }).lang, "de");
    const de = new Set(PROMPTS_BY_LANG.de.map((p) => p.text));
    const prompts: string[] = [];
    const lies: string[] = [];
    const langs = new Set<string>();
    g.on("phase", (p) => {
      langs.add((party.screen.peek() as { lang: string }).lang);
      langs.add(party.room.peek()["lang"] as string);
      if (p === "draw") queueMicrotask(() => prompts.push(...party.players.map((pl) => (pl.state.peek() as { prompt?: string }).prompt).filter((x) => typeof x === "string")));
      if (p === "vote") {
        queueMicrotask(() => {
          const s = party.screen.peek() as { options: { text: string }[] };
          lies.push(...s.options.map((o) => o.text).filter((t) => !de.has(t)));
        });
      }
    });
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    assert.throws(() => g.configure({ lang: "en" }), (e: { code: string }) => e.code === "running");
    const table = (await end) as unknown[];
    assert.equal(table.length, 4);
    assert.deepEqual([...langs], ["de"], "every phase in German");
    assert.equal(prompts.length, 8);
    for (const p of prompts) assert.ok(de.has(p), `${p}: a German prompt`);
    assert.ok(lies.length > 0);
    for (const l of lies) assert.ok(LIES.de.some((x) => l.startsWith(x)), `${l}: a German lie`);
    await until(() => players.every((b) => b.client.view["me"].task === "final" && b.client.view["room"].lang === "de"));
    assert.deepEqual(new Set(players.flatMap((b) => b.errors)), new Set());
    assert.throws(() => g.configure({ lang: "fr" as Lang }), (e: { code: string }) => e.code === "bad-lang");
  } finally {
    for (const b of players) b.close();
    await server.close();
  }
});

test("colours, pens and the rules: picked in the lobby, the VIP's settings, adult prompts, the pens a drawing carries", async () => {
  const { server, party, g, players } = await game(3, { rounds: 1, lang: "en", adult: true });
  try {
    const me = (i: number) => players[i]!.client.view["me"] as { color: number; palette: string[]; task: string; undo?: boolean };
    const room = (i: number) => players[i]!.client.view["room"] as Record<string, any>;
    // Everybody got a colour of their own and its two shades.
    await until(() => players.every((_, i) => typeof me(i)?.color === "number" && Array.isArray(room(i)?.taken)));
    const colors = players.map((_, i) => me(i).color);
    assert.equal(new Set(colors).size, 3);
    assert.equal(room(0)["colors"].length, PLAYER_COLORS.length);
    assert.equal(room(0)["taken"].reduce((a: number, b: number) => a + b, 0), 3);
    for (let i = 0; i < 3; i++) assert.deepEqual(me(i).palette, palette(colors[i]!));
    // Someone else's colour is taken while one is free; a free one is yours.
    await assert.rejects(players[1]!.client.act("color", { color: colors[0] }), (e: { code: string }) => e.code === "color-taken");
    await assert.rejects(players[1]!.client.act("color", { color: 99 }), (e: { code: string }) => e.code === "bad-color");
    const free = PLAYER_COLORS.findIndex((_, i) => !colors.includes(i));
    await players[1]!.client.act("color", { color: free });
    await until(() => me(1).color === free && me(1).palette[0] === palette(free)[0]);
    const id1 = party.players[1]!.id;
    assert.equal((party.screen.peek() as { colors: Record<string, string> }).colors[id1], room(0)["colors"][free]);
    // The rules: the VIP's, with true or false.
    const changes: unknown[] = [];
    g.on("settings", (s) => changes.push(s));
    await assert.rejects(players[1]!.client.act("settings", { undo: true }), (e: { code: string }) => e.code === "not-vip");
    await assert.rejects(players[0]!.client.act("settings", { undo: "yes" }), (e: { code: string }) => e.code === "bad-settings");
    assert.deepEqual(g.settings, { undo: false, colorMode: false, adult: false, animate: false });
    await players[0]!.client.act("settings", { undo: true, colorMode: true, adult: true });
    assert.deepEqual(g.settings, { undo: true, colorMode: true, adult: true, animate: false });
    assert.equal(changes.length, 1);
    // The rounds: the VIP's too, 1 to 5.
    await assert.rejects(players[1]!.client.act("settings", { rounds: 3 }), (e: { code: string }) => e.code === "not-vip");
    for (const rounds of [0, MAX_ROUNDS + 1, 2.5, "3"]) {
      await assert.rejects(players[0]!.client.act("settings", { rounds }), (e: { code: string }) => e.code === "bad-settings", String(rounds));
    }
    await players[0]!.client.act("settings", { rounds: MAX_ROUNDS });
    assert.equal(g.rounds, 5);
    assert.equal(changes.length, 2);
    await until(() => players.every((_, i) => room(i)["rounds"] === 5));
    assert.equal((party.screen.peek() as { rounds: number }).rounds, 5);
    await players[0]!.client.act("settings", { rounds: 1 });
    assert.equal(g.rounds, 1);
    // Not a setting: refused.
    await assert.rejects(players[0]!.client.act("settings", { speed: 2 }), (e: { code: string }) => e.code === "bad-settings");
    // The timers: the host page's three choices, the VIP's too.
    assert.equal(room(0)["timers"], "normal");
    await assert.rejects(players[1]!.client.act("settings", { timers: "fast" }), (e: { code: string }) => e.code === "not-vip");
    for (const timers of ["quick", 1, true]) {
      await assert.rejects(players[0]!.client.act("settings", { timers }), (e: { code: string }) => e.code === "bad-settings", String(timers));
    }
    let n = changes.length;
    await players[0]!.client.act("settings", { timers: "slow" });
    assert.deepEqual(g.timings, SLOW_TIMINGS);
    assert.equal(g.timers, "slow");
    assert.equal(changes.length, n + 1);
    await until(() => players.every((_, i) => room(i)["timers"] === "slow"));
    await players[0]!.client.act("settings", { timers: "fast" });
    assert.deepEqual(g.timings, FAST_TIMINGS);
    await until(() => room(1)["timers"] === "fast");
    // The language: the room's, one with prompts (the host page's choices).
    assert.deepEqual(room(0)["langs"], ["en", "de"]);
    await assert.rejects(players[1]!.client.act("settings", { lang: "de" }), (e: { code: string }) => e.code === "not-vip");
    for (const lang of ["fr", "", 1]) {
      await assert.rejects(players[0]!.client.act("settings", { lang }), (e: { code: string }) => e.code === "bad-settings", String(lang));
    }
    n = changes.length;
    await players[0]!.client.act("settings", { lang: "de" });
    assert.equal(g.lang, "de");
    assert.equal(changes.length, n + 1);
    await until(() => players.every((_, i) => room(i)["lang"] === "de") && (party.screen.peek() as { lang: string }).lang === "de");
    await players[0]!.client.act("settings", { lang: "en", timers: "normal" });
    assert.equal(g.lang, "en");
    assert.equal(g.timers, "normal");
    // Latecomers: a VIP's change tells the host page too.
    n = changes.length;
    await players[0]!.client.act("late-join", { mode: "open" });
    assert.equal(changes.length, n + 1);
    await players[0]!.client.act("late-join", { mode: "wait" });
    assert.equal(party.lateJoin, "wait");
    g.configure({ timings: fast, adult: true });
    await until(() => players.every((_, i) => me(i).palette.length === 5 && room(i)["colorMode"] === true));
    assert.deepEqual(me(1).palette, palette(free, true));
    assert.equal((party.screen.peek() as { adult: boolean }).adult, true);
    // No adult prompts in German: off there, refused.
    g.configure({ lang: "de" });
    assert.equal(g.settings.adult, false);
    await until(() => room(0)["adultOk"] === false && room(0)["adult"] === false);
    await assert.rejects(players[0]!.client.act("settings", { adult: true }), (e: { code: string }) => e.code === "no-adult");
    g.configure({ lang: "en", adult: true });
    // The game: adult prompts, the pens and undo on every pad, drawings with their artist's pens.
    const adult = new Set(ADULT_BY_LANG.en.map((p) => p.text));
    const prompts: string[] = [];
    const drawings: { artist: string; palette?: string[] }[] = [];
    g.on("phase", (p) => {
      if (p === "draw") queueMicrotask(() => prompts.push(...party.players.map((pl) => (pl.state.peek() as { prompt?: string }).prompt).filter((x) => typeof x === "string")));
      if (p === "lie") {
        queueMicrotask(() => {
          const s = party.screen.peek() as { artist: { id: string }; drawing: { palette?: string[] } };
          drawings.push({ artist: s.artist.id, palette: s.drawing.palette });
        });
      }
    });
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await until(() => players.every((_, i) => me(i).task === "draw"));
    assert.ok(players.every((_, i) => me(i).undo === true && me(i).palette.length === 5));
    await assert.rejects(players[2]!.client.act("color", { color: free }), (e: { code: string }) => e.code === "running");
    await assert.rejects(players[0]!.client.act("settings", { undo: false }), (e: { code: string }) => e.code === "running");
    await assert.rejects(players[0]!.client.act("settings", { lang: "de" }), (e: { code: string }) => e.code === "running");
    await assert.rejects(players[0]!.client.act("settings", { timers: "slow" }), (e: { code: string }) => e.code === "running");
    await end;
    assert.equal(prompts.length, 3);
    for (const p of prompts) assert.ok(adult.has(p), `${p}: an adult prompt`);
    assert.ok(drawings.length > 0);
    for (const d of drawings) assert.deepEqual(d.palette, palette(g.colorOf(party.player(d.artist)!), true));
    // After the game the VIP sets the next one's rules: every phone and the TV see them.
    await until(() => players.every((_, i) => me(i).task === "final" && room(i)["rounds"] === 1));
    assert.equal((party.screen.peek() as { rounds: number }).rounds, 1);
    await players[0]!.client.act("settings", { rounds: 3, undo: false });
    assert.equal(g.rounds, 3);
    await until(() => players.every((_, i) => room(i)["rounds"] === 3 && room(i)["undo"] === false && room(i)["phase"] === "final"));
    assert.deepEqual(
      [(party.screen.peek() as { rounds: number }).rounds, (party.screen.peek() as { undo: boolean }).undo, (party.screen.peek() as { phase: string }).phase],
      [3, false, "final"],
    );
    assert.deepEqual(new Set(players.flatMap((b) => b.errors)), new Set());
  } finally {
    for (const b of players) b.close();
    await server.close();
  }
});

test("animated drawings: two frames on every pad, the TV, the liars' and the voters' phones get both", async () => {
  const { server, party, g, players } = await game(4, { rounds: 1 });
  try {
    const me = (i: number) => players[i]!.client.view["me"] as Record<string, any>;
    const room = (i: number) => players[i]!.client.view["room"] as Record<string, any>;
    await assert.rejects(players[1]!.client.act("settings", { animate: true }), (e: { code: string }) => e.code === "not-vip");
    await assert.rejects(players[0]!.client.act("settings", { animate: 2 }), (e: { code: string }) => e.code === "bad-settings");
    await players[0]!.client.act("settings", { animate: true });
    assert.equal(g.settings.animate, true);
    await until(() => players.every((_, i) => room(i)?.["animate"] === true) && (party.screen.peek() as { animate?: boolean }).animate === true);
    const screens: Record<string, any>[] = [];
    const off = party.on("screen-view", (v) => screens.push(v["screen"] as Record<string, any>));
    const lies: unknown[] = [];
    const votes: unknown[] = [];
    for (const p of players) {
      p.client.on("view", (v) => {
        const m = v["me"] as Record<string, any> | undefined;
        if (m?.["task"] === "lie") lies.push(m["drawing"]);
        if (m?.["task"] === "vote") votes.push((v["room"] as Record<string, any>)["drawing"]);
      });
    }
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await until(() => players.every((_, i) => me(i).task === "draw" || me(i).done));
    const draw = party.players.map((p) => p.state.peek() as Record<string, any>);
    assert.ok(draw.every((s) => s["frames"] === 2), "every pad has two frames");
    const deadline = (party.screen.peek() as { deadline: number }).deadline;
    assert.ok(deadline - party.now() > fast.draw - 200, "the time to animate");
    await end;
    off();
    // Every drawing on the TV, the liars' and the voters' phones: two frames, the second moved (the bots' doodles hop).
    const shown = [...screens.filter((s) => s["phase"] === "lie" || s["phase"] === "vote" || s["phase"] === "reveal").map((s) => s["drawing"]), ...lies, ...votes] as {
      strokes: number[][];
      frames?: number[][][];
      palette?: string[];
    }[];
    assert.ok(shown.length > 0 && lies.length > 0 && votes.length > 0);
    for (const d of shown) {
      assert.equal(d.frames?.length, 1);
      assert.equal(d.frames![0]!.length, d.strokes.length);
      assert.notDeepEqual(d.frames![0], d.strokes);
      assert.ok(Array.isArray(d.palette));
    }
    assert.deepEqual(new Set(players.flatMap((b) => b.errors)), new Set());
    // Back to still drawings after the game.
    g.configure({ animate: false });
    assert.equal(g.settings.animate, false);
  } finally {
    for (const b of players) b.close();
    await server.close();
  }
});

test("the reveal: no phone tells its points before the TV showed the truth", async () => {
  const { server, party, g, players } = await game(4, { rounds: 1 });
  try {
    let before = new Map<string, number>();
    g.on("phase", (p) => {
      if (p === "vote") before = new Map(g.scores);
    });
    const leaks: string[] = [];
    let steps = 0;
    const off = party.on("screen-view", (v) => {
      const s = v["screen"] as { phase: string; step: number; items: unknown[] };
      if (s.phase !== "reveal" || s.step >= s.items.length) return;
      steps++;
      for (const p of party.players) {
        const st = p.state.peek() as Record<string, unknown>;
        if (st["note"] === "result" || st["result"] !== undefined) leaks.push(`${p.name}: a result at step ${s.step}`);
        if (g.scores.get(p.id) !== before.get(p.id)) leaks.push(`${p.name}: points at step ${s.step}`);
        if (typeof st["score"] === "number" && st["score"] !== before.get(p.id)) leaks.push(`${p.name}: score ${String(st["score"])} at step ${s.step}`);
      }
    });
    const results = new Set<string>();
    for (const b of players) {
      b.client.on("view", (v) => {
        const me = v["me"] as Record<string, any> | undefined;
        if (me?.["note"] === "result" && me["result"]) results.add(b.name);
      });
    }
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await end;
    off();
    assert.ok(steps > 0);
    assert.deepEqual(leaks, []);
    assert.deepEqual(results, new Set(players.map((b) => b.name)), "every phone got its result after all");
  } finally {
    for (const b of players) b.close();
    await server.close();
  }
});

test("the TV: every player's colour in every phase, ink while drawing, who types, the reveal's ids", async () => {
  const { server, party, g, players } = await game(4, { rounds: 1, think: 900 });
  try {
    const seen: Record<string, any>[] = [];
    let inked = false;
    let typing = false;
    const off = party.on("screen-view", (v) => {
      const s = v["screen"] as Record<string, any>;
      seen.push(s);
      if (s["phase"] === "draw" && Object.values(s["ink"] ?? {}).some((n) => (n as number) > 0)) inked = true;
      if ((s["phase"] === "lie" || s["phase"] === "gallery") && (s["typing"] ?? []).length > 0) typing = true;
    });
    assert.equal((party.screen.peek() as { rounds: number }).rounds, 1);
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await end;
    off();
    const ids = party.players.map((p) => p.id).sort();
    for (const phase of ["draw", "lie", "vote", "reveal", "scores", "final"]) {
      const s = seen.find((x) => x["phase"] === phase);
      assert.ok(s, phase);
      assert.deepEqual(Object.keys(s["colors"] ?? {}).sort(), ids, `${phase}: everybody's colour`);
    }
    assert.ok(inked, "ink while drawing");
    assert.ok(typing, "liars typing");
    const reveal = seen.find((x) => x["phase"] === "reveal")!;
    assert.equal(reveal["stepMs"], fast.revealStep);
    assert.equal(reveal["endMs"], fast.revealEnd);
    for (const it of reveal["items"]) {
      assert.ok(Array.isArray(it.authorIds) && Array.isArray(it.voterIds));
      assert.equal(it.voterIds.length, Math.min(it.count, 12));
      for (const id of [...it.authorIds, ...it.voterIds]) assert.ok(ids.includes(id), id);
    }
  } finally {
    for (const b of players) b.close();
    await server.close();
  }
});
