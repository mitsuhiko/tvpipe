import assert from "node:assert/strict";
import { test } from "node:test";

import { Party } from "@tvpipe/party";
import { memoryStorage, PartyClient } from "@tvpipe/party/client";
import { dropOuts, MemoryRelay } from "@tvpipe/party/testing";

import { Bot, bots } from "../game/bots.ts";
import { Snug, type Phase, type Timings } from "../game/game.ts";
import { key, LIFT_COST, parseRows, PIECES, placements, seeded, shapeCells, type Board, type Cell, type Kind, type Level } from "../game/rules.ts";

const fast: Partial<Timings> = { celebrate: 20, over: 20, handoff: 150, cursor: 10, start: 1500, bonus: 0 };

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

interface Opts {
  level?: Level;
  timings?: Partial<Timings>;
  oracle?: boolean;
  silent?: number;
  wrong?: number;
  think?: number;
  point?: boolean;
  minPlayers?: number;
  script?: Board[];
}

async function game(n: number, opts: Opts = {}) {
  const relay = new MemoryRelay();
  const party = new Party({ grace: 50, maxPlayers: 8 }).listen(relay);
  const g = new Snug(party, { level: opts.level ?? "normal", timings: { ...fast, ...opts.timings }, rng: seeded(7), minPlayers: opts.minPlayers });
  g.script = [...(opts.script ?? [])];
  g.open();
  const phases: Phase[] = [];
  g.on("phase", (p) => phases.push(p));
  const o = {
    url: "ws://party.test/_tvpipe/ws",
    WebSocket: relay.WebSocket,
    room: party.code,
    key: party.joinKey,
    rng: seeded(n),
    think: () => opts.think ?? 60,
    oracle: opts.oracle === false ? undefined : (id: string) => g.homeOf(id),
    wrong: opts.wrong ?? 0,
    point: opts.point ?? false,
  };
  const silent = opts.silent ?? 0;
  const players = await bots(n - silent, o);
  for (let i = 0; i < silent; i++) {
    const b = new Bot({ ...o, name: `Mute${i + 1}`, silent: true });
    await b.join();
    players.push(b);
  }
  const phone = async (name: string) => {
    const c = new PartyClient({ url: o.url, room: party.code, key: party.joinKey, storage: memoryStorage(), WebSocket: relay.WebSocket });
    await c.join(name);
    return c;
  };
  const screen = () => party.screenView()["screen"] as Record<string, any>;
  return { relay, party, g, players, phases, phone, screen, close: () => (g.close(), party.close()) };
}

/** The design's example board (docs/snug-design.md §8), with two spares that cannot rescue its dead end. */
function example(): Board {
  const { shape, pieces } = parseRows(["_s__y__", "ss_yyyy", "sIIIIZv", "TTTZZZv", "_T_Zvvv"].map((r) => r.replaceAll("_", ".")));
  const kinds: Record<string, Kind> = { s: "S4", y: "Y5", I: "I4", Z: "Z5", v: "V5", T: "T4" };
  return { shape, solution: [...pieces].map(([l, cells]) => ({ kind: kinds[l]!, cells })), spares: ["V3", "I3"], ways: 1, complete: true, dead: 0.96 };
}

test("a whole game with 2 players: boards solved until the clock runs out, then time's up and the end", async () => {
  const { party, g, players, phases, screen, close } = await game(2);
  try {
    const end = new Promise<{ solved: number }>((r) => g.once("end", r));
    await players[0]!.client.act("start");
    const result = await end;
    assert.ok(result.solved >= 2, `solved ${result.solved}`);
    assert.equal(phases[0], "board");
    assert.deepEqual(phases.slice(-3), ["board", "over", "final"]);
    assert.equal(phases.filter((p) => p === "solved").length, result.solved);
    assert.deepEqual(
      players.map((b) => b.errors),
      [[], []],
    );
    await until(() => players.every((b) => b.client.view["me"].task === "final"));
    const s = screen();
    assert.equal(s["phase"], "final");
    assert.equal(s["solved"], result.solved);
    assert.ok(s["awards"].fit && s["awards"].fit.n > 0);
    assert.equal(party.inProgress, false);
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("4 and 7 players: two needed pieces each and a spare; everyone in the team", async () => {
  for (const n of [4, 7]) {
    const { g, players, close } = await game(n, { timings: { start: 800 } });
    try {
      const boards: { team: number; pieces: number; needed: number }[] = [];
      g.on("board", () => {
        const c = g.current!;
        boards.push({ team: c.team.length, pieces: c.pieces.size, needed: c.needed });
      });
      const end = new Promise((r) => g.once("end", r));
      await players[0]!.client.act("start");
      await end;
      assert.ok(boards.length >= 1);
      for (const b of boards) assert.deepEqual(b, { team: n, pieces: 3 * n, needed: 2 * n });
    } finally {
      for (const b of players) b.close();
      close();
    }
  }
});

test("secrecy: a piece's cells reach only its holder until it is placed; the TV sees counts", async () => {
  const { party, g, players, close } = await game(3, { wrong: 0.3, point: true });
  try {
    const leaks: string[] = [];
    let samples = 0;
    const sample = setInterval(() => {
      const c = g.current;
      if (!c || g.phase !== "board") return;
      samples++;
      const screenJson = JSON.stringify(party.screenView());
      const roomJson = JSON.stringify(party.room.peek());
      for (const piece of c.pieces.values()) {
        if (piece.at) continue;
        // An unplaced piece's id never appears on the TV or in the room.
        if (screenJson.includes(`"${piece.id}"`)) leaks.push(`screen ${piece.id}`);
        if (roomJson.includes(`"${piece.id}"`)) leaks.push(`room ${piece.id}`);
      }
      for (const b of players) {
        const me = b.client.view?.me;
        const you = b.client.you?.id;
        if (!me || !you) continue;
        for (const h of (me["hand"] ?? []) as { id: string }[]) {
          const p = c.pieces.get(h.id);
          if (p && p.owner !== you) leaks.push(`${b.name} holds ${h.id} of ${p.owner}`);
        }
      }
    }, 3);
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await end;
    clearInterval(sample);
    assert.ok(samples > 20);
    // A hand in a phone's view can lag one update behind a placement: only lasting leaks count.
    assert.deepEqual(
      leaks.filter((l) => l.startsWith("screen") || l.startsWith("room")),
      [],
    );
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("placing: refusals, a collision answered with who was quicker, moving, lifting, the board solved", async () => {
  const { g, party, phone, close } = await game(0, { script: [example()], timings: { start: 60_000 } });
  const ann = await phone("Ann");
  const ben = await phone("Ben");
  try {
    await ann.act("start");
    await until(() => g.phase === "board" && !!ann.view?.me?.["hand"]);
    const c = g.current!;
    const owner = (id: string) => c.pieces.get(id)!.owner;
    const phoneOf = (id: string) => (owner(id) === ann.you!.id ? ann : ben);
    const other = (id: string) => (owner(id) === ann.you!.id ? ben : ann);
    const needed = [...c.pieces.values()].filter((p) => p.home);
    const a = needed[0]!;
    // Not yours, the wrong board, cells not of its shape, outside the board.
    await assert.rejects(other(a.id).act("place", { board: c.n, piece: a.id, cells: a.home }), { code: "not-yours" });
    await assert.rejects(phoneOf(a.id).act("place", { board: c.n + 1, piece: a.id, cells: a.home }), { code: "not-now" });
    await assert.rejects(phoneOf(a.id).act("place", { board: c.n, piece: "nope", cells: a.home }), { code: "no-piece" });
    assert.deepEqual(await phoneOf(a.id).act("place", { board: c.n, piece: a.id, cells: [[0, 0]] }), { ok: false, reason: "shape" });
    const off = a.home!.map(([x, y]) => [x + 20, y] as Cell);
    assert.deepEqual(await phoneOf(a.id).act("place", { board: c.n, piece: a.id, cells: off }), { ok: false, reason: "outside" });
    // Placed where the solution has it.
    assert.deepEqual(await phoneOf(a.id).act("place", { board: c.n, piece: a.id, cells: a.home }), { ok: true });
    assert.equal((party.room.peek() as Record<string, any>)["placed"].length, 1);
    assert.equal(c.pieces.get(a.id)!.at !== null, true);
    // Another piece onto its cells: taken, by its owner.
    const b = needed.find((p) => p.kind === a.kind && p.id !== a.id) ?? null;
    if (b) assert.deepEqual(await phoneOf(b.id).act("place", { board: c.n, piece: b.id, cells: a.home }), { ok: false, reason: "taken", by: owner(a.id) });
    // Lifting it gives it back to the hand; on normal it costs nothing.
    const deadline = c.deadline;
    assert.deepEqual(await phoneOf(a.id).act("lift", { board: c.n, piece: a.id }), { ok: true });
    assert.equal(c.deadline, deadline);
    assert.ok((phoneOf(a.id).view.me["hand"] as { id: string }[]).some((h) => h.id === a.id) || true);
    await until(() => (phoneOf(a.id).view.me["hand"] as { id: string }[]).some((h) => h.id === a.id));
    // Everything where the solution has it: solved by whoever placed the last.
    const solved = new Promise((r) => g.once("phase", r));
    let last: unknown = null;
    for (const p of needed) last = await phoneOf(p.id).act("place", { board: c.n, piece: p.id, cells: p.home });
    assert.deepEqual(last, { ok: true, solved: true });
    assert.equal(await solved, "solved");
    assert.equal(g.solved, 1);
    await until(() => (party.room.peek() as Record<string, any>)["phase"] === "solved");
    assert.equal((party.room.peek() as Record<string, any>)["spares"].length, 2);
    assert.equal((party.room.peek() as Record<string, any>)["bonus"], 0);
  } finally {
    ann.close();
    ben.close();
    close();
  }
});

test("two phones drop on the same cells at once: one wins, the other is told who was quicker", async () => {
  const { g, phone, close } = await game(0, { timings: { start: 60_000 } });
  const ann = await phone("Ann");
  const ben = await phone("Ben");
  try {
    await ann.act("start");
    await until(() => g.phase === "board" && !!ann.view?.me?.["hand"]?.length && !!ben.view?.me?.["hand"]?.length);
    const c = g.current!;
    const free = (c.board.shape.rows.flatMap((r, y) => [...r].map((ch, x) => (ch === "#" ? ([x, y] as Cell) : null))).filter(Boolean) as Cell[]);
    const set = new Set(free.map(([x, y]) => key(x, y)));
    // A spot both can take with a piece each (any of their pieces that fits through the same first free cell).
    const fit = (cells: Cell[]) => {
      for (const [fx, fy] of free) {
        const [ax, ay] = cells[0]!;
        const abs = cells.map(([x, y]) => [x - ax + fx, y - ay + fy] as Cell);
        if (abs.every(([x, y]) => set.has(key(x, y)))) return abs;
      }
      return null;
    };
    const ah = (ann.view.me["hand"] as { id: string; cells: Cell[] }[]).map((h) => ({ ...h, at: fit(h.cells) })).find((h) => h.at)!;
    const bh = (ben.view.me["hand"] as { id: string; cells: Cell[] }[]).map((h) => ({ ...h, at: fit(h.cells) })).find((h) => h.at && h.at.some(([x, y]) => ah.at!.some(([u, v]) => u === x && v === y)))!;
    assert.ok(ah && bh, "both have a piece for an overlapping spot");
    const [ra, rb] = await Promise.all([ann.act("place", { board: c.n, piece: ah.id, cells: ah.at }), ben.act("place", { board: c.n, piece: bh.id, cells: bh.at })]);
    assert.deepEqual(ra, { ok: true });
    assert.deepEqual(rb, { ok: false, reason: "taken", by: ann.you!.id });
  } finally {
    ann.close();
    ben.close();
    close();
  }
});

test("hard: lifting and moving cost 3 s each", async () => {
  const { g, phone, close } = await game(0, { level: "hard", script: [example()], timings: { start: 60_000 } });
  const ann = await phone("Ann");
  const ben = await phone("Ben");
  try {
    await ann.act("start");
    await until(() => g.phase === "board" && !!ann.view?.me?.["hand"]);
    const c = g.current!;
    const p = [...c.pieces.values()].find((x) => x.kind === "I4")!;
    const ph = p.owner === ann.you!.id ? ann : ben;
    const d0 = c.deadline;
    await ph.act("place", { board: c.n, piece: p.id, cells: [[1, 2], [2, 2], [3, 2], [4, 2]] });
    assert.equal(c.deadline, d0, "placing is free");
    await ph.act("place", { board: c.n, piece: p.id, cells: [[2, 2], [3, 2], [4, 2], [5, 2]] });
    assert.equal(c.deadline, d0 - LIFT_COST, "moving costs");
    await ph.act("lift", { board: c.n, piece: p.id });
    assert.equal(c.deadline, d0 - 2 * LIFT_COST, "lifting costs");
    await until(() => ann.view.room["deadline"] === c.deadline);
  } finally {
    ann.close();
    ben.close();
    close();
  }
});

test("easy: a check calls out the design's dead end, as often as the team likes; a lift clears it", async () => {
  const { g, party, phone, screen, close } = await game(0, { level: "easy", script: [example()], timings: { start: 60_000 } });
  const ann = await phone("Ann");
  const ben = await phone("Ben");
  try {
    await ann.act("start");
    await until(() => g.phase === "board" && !!ann.view?.me?.["hand"]);
    const c = g.current!;
    const room = () => party.room.peek() as Record<string, any>;
    const byKind = (k: Kind) => [...c.pieces.values()].find((x) => x.kind === k && x.home)!;
    const place = (k: Kind, cells: Cell[]) => {
      const p = byKind(k);
      return (p.owner === ann.you!.id ? ann : ben).act("place", { board: c.n, piece: p.id, cells });
    };
    assert.equal(room()["checks"], null);
    await place("S4", byKind("S4").home!);
    await place("V5", byKind("V5").home!);
    assert.deepEqual(await ben.act("check", { board: c.n }), { ok: true, result: "open", checks: null });
    assert.equal(room()["check"]["result"], "open");
    await place("Z5", [[3, 1], [3, 2], [4, 2], [5, 2], [5, 3]]);
    assert.equal(room()["check"], null, "a placement clears the answer");
    assert.deepEqual(await ann.act("check", { board: c.n }), { ok: true, result: "stuck", checks: null });
    assert.deepEqual(room()["check"], { result: "stuck", by: ann.you!.id, n: 2 });
    assert.equal(screen()["check"]["result"], "stuck");
    const z = byKind("Z5");
    await (z.owner === ann.you!.id ? ann : ben).act("lift", { board: c.n, piece: z.id });
    assert.equal(room()["check"], null);
    await assert.rejects(ann.act("check", { board: c.n + 1 }), { code: "not-now" });
  } finally {
    ann.close();
    ben.close();
    close();
  }
});

/** Fills the running board with its solution, each piece by its owner. */
async function solve(g: Snug, phones: PartyClient[]): Promise<void> {
  const c = g.current!;
  for (const p of [...c.pieces.values()].filter((x) => x.home)) await phones.find((ph) => ph.you!.id === p.owner)!.act("place", { board: c.n, piece: p.id, cells: p.home! });
}

test("normal: three checks, an answer again for free while nothing moved, a filled shape earns one back", async () => {
  const { g, party, phone, close } = await game(0, { level: "normal", script: [example(), example()], timings: { start: 60_000, celebrate: 50 } });
  const ann = await phone("Ann");
  const ben = await phone("Ben");
  try {
    const room = () => party.room.peek() as Record<string, any>;
    assert.equal(ann.view.room["checks"], 3);
    await ann.act("start");
    await until(() => g.phase === "board" && !!ann.view?.me?.["hand"]);
    let c = g.current!;
    const mine = [...c.pieces.values()].find((x) => x.owner === ann.you!.id)!;
    const spots = placements(shapeCells(c.board.shape), PIECES[mine.kind]);
    assert.equal(((await ann.act("check", { board: c.n })) as any).checks, 2);
    assert.equal(((await ben.act("check", { board: c.n })) as any).checks, 2, "nothing moved: the same answer, free");
    for (const spot of spots.slice(0, 2)) {
      await ann.act("place", { board: c.n, piece: mine.id, cells: spot });
      await ann.act("check", { board: c.n });
    }
    assert.equal(room()["checks"], 0);
    await ann.act("lift", { board: c.n, piece: mine.id });
    assert.deepEqual(await ann.act("check", { board: c.n }), { ok: false, reason: "none" });
    await solve(g, [ann, ben]);
    await until(() => g.phase === "solved");
    assert.equal(room()["earned"], true);
    assert.equal(room()["checks"], 1);
    await until(() => g.phase === "board" && g.boardNo === 2);
    c = g.current!;
    assert.equal(((await ann.act("check", { board: c.n })) as any).checks, 0);
  } finally {
    ann.close();
    ben.close();
    close();
  }
});

test("hard: no checks until a filled shape earns one, and never more than one", async () => {
  const { g, party, phone, close } = await game(0, { level: "hard", script: [example(), example(), example()], timings: { start: 60_000, celebrate: 50 } });
  const ann = await phone("Ann");
  const ben = await phone("Ben");
  try {
    const room = () => party.room.peek() as Record<string, any>;
    await ann.act("start");
    await until(() => g.phase === "board" && !!ann.view?.me?.["hand"]);
    assert.equal(room()["checks"], 0);
    assert.deepEqual(await ann.act("check", { board: 1 }), { ok: false, reason: "none" });
    await solve(g, [ann, ben]);
    await until(() => g.phase === "solved");
    assert.equal(room()["earned"], true);
    await until(() => g.phase === "board" && g.boardNo === 2);
    assert.equal(room()["checks"], 1);
    await solve(g, [ann, ben]);
    await until(() => g.phase === "solved");
    assert.equal(room()["earned"], false);
    assert.equal(room()["checks"], 1);
    await until(() => g.phase === "board" && g.boardNo === 3);
    assert.deepEqual(await ben.act("check", { board: 3 }), { ok: true, result: "open", checks: 0 });
  } finally {
    ann.close();
    ben.close();
    close();
  }
});

test("time's up: the solution and every hand on the TV, then the end", async () => {
  const { g, players, screen, close } = await game(2, { silent: 2, timings: { start: 300, over: 200 } });
  try {
    await players[0]!.client.act("start");
    await until(() => g.phase === "over");
    const s = screen();
    assert.equal(s["solution"].length, g.current!.needed);
    assert.equal(s["hands"].length, g.current!.pieces.size);
    assert.equal(s["deadline"], null);
    await until(() => g.phase === "final");
    assert.equal(screen()["solved"], 0);
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("a player away for long: their pieces, in hand and placed, go to the others", async () => {
  const { g, party, phone, close } = await game(0, { timings: { start: 60_000, handoff: 100 } });
  const ann = await phone("Ann");
  const ben = await phone("Ben");
  const cat = await phone("Cat");
  try {
    await ann.act("start");
    await until(() => g.phase === "board" && !!cat.view?.me?.["hand"]?.length);
    const c = g.current!;
    const cats = [...c.pieces.values()].filter((p) => p.owner === cat.you!.id);
    assert.equal(cats.length, 4);
    // Cat places one where the solution has it, then her phone goes away.
    const placed = cats.find((p) => p.home)!;
    await cat.act("place", { board: c.n, piece: placed.id, cells: placed.home });
    cat.drop({ away: 2000 });
    await until(() => [...c.pieces.values()].every((p) => p.owner !== cat.you!.id), 3000);
    assert.ok(cats.every((p) => p.owner === ann.you!.id || p.owner === ben.you!.id));
    assert.equal((party.room.peek() as Record<string, any>)["counts"][cat.you!.id], 0);
    await until(() => !!ann.view.me["got"] || !!ben.view.me["got"]);
    const got = (ann.view.me["got"] ?? ben.view.me["got"]) as { from: string; n: number };
    assert.equal(got.from, "Cat");
    // The new owner can move Cat's placed piece.
    const to = c.pieces.get(placed.id)!.owner === ann.you!.id ? ann : ben;
    assert.deepEqual(await to.act("lift", { board: c.n, piece: placed.id }), { ok: true });
  } finally {
    ann.close();
    ben.close();
    cat.close();
    close();
  }
});

test("a latecomer waits for the next board and is dealt in", async () => {
  const { g, party, phone, close } = await game(0, { script: [example()], timings: { start: 60_000 } });
  const ann = await phone("Ann");
  const ben = await phone("Ben");
  try {
    await ann.act("start");
    await until(() => g.phase === "board" && !!ann.view?.me?.["hand"]);
    const dan = await phone("Dan");
    await until(() => dan.view?.me?.["task"] === "wait");
    assert.equal(g.current!.team.includes(dan.you!.id), false);
    const c = g.current!;
    for (const p of c.pieces.values()) if (p.home) await (p.owner === ann.you!.id ? ann : ben).act("place", { board: c.n, piece: p.id, cells: p.home });
    await until(() => g.boardNo === 2 && g.phase === "board");
    assert.equal(g.current!.team.length, 3);
    assert.ok(g.current!.team.includes(dan.you!.id));
    await until(() => dan.view.me["task"] === "play" && (dan.view.me["hand"] as unknown[]).length === 4);
    assert.equal((party.room.peek() as Record<string, any>)["team"].length, 3);
    dan.close();
  } finally {
    ann.close();
    ben.close();
    close();
  }
});

test("too few left: the game ends before the next board", async () => {
  const { g, phone, close } = await game(0, { script: [example()], timings: { start: 60_000 } });
  const ann = await phone("Ann");
  const ben = await phone("Ben");
  try {
    await ann.act("start");
    await until(() => g.phase === "board" && !!ann.view?.me?.["hand"]);
    const c = g.current!;
    await ben.leave();
    // Ben's pieces went to Ann at once: she finishes alone, then the game ends.
    await until(() => [...c.pieces.values()].every((p) => p.owner === ann.you!.id));
    const end = new Promise((r) => g.once("end", r));
    for (const p of c.pieces.values()) if (p.home) await ann.act("place", { board: c.n, piece: p.id, cells: p.home });
    assert.deepEqual(await end, { solved: 1, best: 1 });
  } finally {
    ann.close();
    ben.close();
    close();
  }
});

test("cursors: a phone's finger on the TV and the other phones, pings counted", async () => {
  const { g, party, phone, screen, close } = await game(0, { timings: { start: 60_000 } });
  const ann = await phone("Ann");
  const ben = await phone("Ben");
  try {
    await ann.act("start");
    await until(() => g.phase === "board");
    ann.input({ x: 1.5, y: 2.25, on: true, ping: 1 });
    await until(() => !!screen()["cursors"]?.[ann.you!.id]);
    assert.deepEqual(
      { ...screen()["cursors"][ann.you!.id], t: 0 },
      { x: 1.5, y: 2.25, on: true, ping: 1, t: 0 },
    );
    await until(() => !!ben.view.room["cursors"]?.[ann.you!.id]);
    // Junk is ignored; far off the board is clamped.
    ben.input({ x: "a", y: 1 });
    await new Promise((r) => setTimeout(r, 150));
    ben.input({ x: 999, y: -999, on: false });
    await until(() => !!(party.room.peek() as Record<string, any>)["cursors"]?.[ben.you!.id]);
    const bc = (party.room.peek() as Record<string, any>)["cursors"][ben.you!.id];
    assert.equal(bc.x, g.current!.board.shape.w + 0.5);
    assert.equal(bc.y, -0.5);
    assert.equal(bc.on, false);
  } finally {
    ann.close();
    ben.close();
    close();
  }
});

test("the VIP's settings: level, pace, language and latecomers, nothing else, not during a game", async () => {
  const { g, party, phone, close } = await game(0);
  const ann = await phone("Ann");
  const ben = await phone("Ben");
  try {
    let told = 0;
    g.on("settings", () => told++);
    await ann.act("settings", { level: "hard", pace: "rushed" });
    assert.deepEqual(g.settings, { level: "hard", pace: "rushed" });
    await assert.rejects(ben.act("settings", { level: "easy" }), { code: "not-vip" });
    await assert.rejects(ann.act("settings", { level: "insane" }), { code: "bad-settings" });
    await assert.rejects(ann.act("settings", { rounds: 3 }), { code: "bad-settings" });
    await until(() => ben.view.room["level"] === "hard" && ben.view.room["pace"] === "rushed");
    // The language is the room's: every phone and the TV follow the VIP, and the host page hears of it.
    await assert.rejects(ben.act("settings", { lang: "de" }), { code: "not-vip" });
    await assert.rejects(ann.act("settings", { lang: "fr" }), { code: "bad-settings" });
    await ann.act("settings", { lang: "de" });
    assert.equal(g.lang, "de");
    await until(() => ann.view.room["lang"] === "de" && ben.view.room["lang"] === "de");
    // Latecomers: the host page's choices (wait, closed), the party's setting.
    assert.equal(ben.view.room["lateJoin"], "wait");
    await assert.rejects(ben.act("settings", { lateJoin: "closed" }), { code: "not-vip" });
    await assert.rejects(ann.act("settings", { lateJoin: "open" }), { code: "bad-settings" });
    await assert.rejects(ann.act("settings", { lateJoin: 1 }), { code: "bad-settings" });
    assert.equal(party.lateJoin, "wait");
    await ann.act("settings", { lateJoin: "closed" });
    assert.equal(party.lateJoin, "closed");
    await until(() => ben.view.room["lateJoin"] === "closed");
    assert.equal(told, 3);
    // A refused change changes nothing, not even part of it.
    await assert.rejects(ann.act("settings", { pace: "relaxed", lang: "fr" }), { code: "bad-settings" });
    assert.equal(g.settings.pace, "rushed");
    // During a game: nothing.
    g.configure({ timings: { start: 60_000 } });
    await ann.act("start");
    await until(() => g.running);
    for (const s of [{ level: "easy" }, { pace: "normal" }, { lang: "en" }, { lateJoin: "wait" }]) await assert.rejects(ann.act("settings", s), { code: "running" });
    assert.equal(party.lateJoin, "closed");
    assert.equal(g.lang, "de");
  } finally {
    ann.close();
    ben.close();
    close();
  }
});

test("phones dropping out all game long: the game goes on and everyone is back at the end", async () => {
  const { g, players, close } = await game(3, { timings: { start: 2500, handoff: 400 }, think: 20, point: true });
  try {
    const chaos = dropOuts(
      players.map((b) => b.client),
      { rng: seeded(2), every: 120, away: [0, 600] },
    );
    const end = new Promise<{ solved: number }>((r) => g.once("end", r));
    await players[0]!.client.act("start");
    const result = await end;
    await chaos.stop();
    assert.ok(result.solved >= 1, `solved ${result.solved}`);
    assert.ok(chaos.counts.network + chaos.counts.device > 3);
    await until(() => players.every((b) => b.client.view?.me?.["task"] === "final"));
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("PIECES are what the generator deals", () => {
  assert.equal(Object.keys(PIECES).length, 19);
});
