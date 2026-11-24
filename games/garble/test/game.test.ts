import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { Party, type PartyOptions } from "@tvpipe/party";
import { dropOuts, MemoryRelay } from "@tvpipe/party/testing";

import { Bot, bots } from "../game/bots.ts";
import { DEFAULT_TIMINGS, FAST_TIMINGS, Garble, type Timings } from "../game/game.ts";
import { bestMove, earnedTotal, flatten, judge, parseWords, pictureAt, scoreRound, seeded, type Picture, type Word } from "../game/rules.ts";

const data = (f: string) => parseWords(readFileSync(new URL(`../data/${f}`, import.meta.url), "utf8"));
const WORDS = { en: data("words.txt"), de: data("words.de.txt") };

const fast: Timings = {
  firstDraw: 1500,
  guess: 800,
  draw: 1200,
  layer: 3,
  read: 3,
  legend: 3,
  vote: 1000,
  best: 5,
  scores: 5,
};

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function game(
  n: number,
  opts: { rounds?: number; silent?: number; length?: number; oracle?: boolean; lang?: "en" | "de"; voter?: boolean; tvDelay?: number; moderate?: PartyOptions["moderate"]; think?: number } = {},
) {
  const relay = new MemoryRelay();
  const party = new Party({ grace: 100, maxPlayers: 12, tvDelay: opts.tvDelay, moderate: opts.moderate }).listen(relay);
  const g = new Garble(party, { words: WORDS, rounds: opts.rounds ?? 1, timings: fast, rng: seeded(11), length: opts.length, lang: opts.lang });
  g.open();
  const phases: string[] = [];
  g.on("phase", (p) => phases.push(p));
  const o = {
    url: "ws://party.test/_tvpipe/ws",
    WebSocket: relay.WebSocket,
    room: party.code,
    key: party.joinKey,
    rng: seeded(n),
    think: () => opts.think ?? 3,
    oracle: opts.oracle === false ? undefined : (id: string) => g.meant(id),
  };
  const silent = opts.silent ?? 0;
  const players = await bots(n - silent, o);
  // Players who never answer: connected, but silent.
  for (let i = 0; i < silent; i++) {
    const b = new Bot({ ...o, name: `Mute${i + 1}`, silent: true });
    await b.join();
    players.push(b);
  }
  // A player who votes by hand (the test's).
  if (opts.voter) {
    const b = new Bot({ ...o, name: "Voter", skip: ["vote"] });
    await b.join();
    players.push(b);
  }
  /** The round's pictures, seats and words once it is revealed (the game forgets them at the end). */
  const rounds: { pictures: Picture[]; seats: string[]; deals: { choices: Word[]; words: Word[] }[] }[] = [];
  g.on("phase", (p) => {
    if (p === "reveal") rounds.push(structuredClone({ pictures: g.round!.pictures, seats: g.round!.seats.map((x) => x.id), deals: g.round!.deals }));
  });
  /** One more bot, joining now (a latecomer). */
  const add = async (name: string) => {
    const b = new Bot({ ...o, name });
    await b.join();
    players.push(b);
    return b;
  };
  return { party, g, players, phases, rounds, add, close: () => party.close() };
}

test("a whole game with 4 players", async () => {
  const { party, g, players, phases, rounds, close } = await game(4, { rounds: 2 });
  try {
    const end = new Promise<{ score: number }[]>((r) => g.once("end", r));
    await players[0]!.client.act("start");
    const table = await end;
    assert.equal(table.length, 4);
    assert.equal(phases.filter((p) => p === "play").length, 8, "4 players: 3 layers, then the last guess: 4 steps a round");
    for (const p of ["reveal", "vote", "best", "scores"]) assert.equal(phases.filter((x) => x === p).length, 2, p);
    assert.equal(phases.at(-1), "final");
    assert.ok(table.reduce((s, l) => s + l.score, 0) > 0, "someone scored");
    assert.deepEqual(
      players.map((b) => b.errors),
      [[], [], [], []],
    );
    assert.equal(rounds.length, 2);
    for (const r of rounds) {
      assert.equal(r.pictures.length, 4);
      for (const p of r.pictures) {
        assert.equal(p.layers.length, 3);
        assert.ok(p.layers.every((l) => l.guess !== null && l.drawing.strokes.length > 0));
      }
    }
    await until(() => players.every((b) => b.client.view["me"].task === "final"));
    assert.equal((party.screenView()["screen"] as { phase: string }).phase, "final");
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("phones drop out and come back all game long (a lost signal, another phone): the game ends with everyone in it", async () => {
  const { party, g, players, phases, close } = await game(5, { rounds: 2 });
  try {
    const chaos = dropOuts(
      players.map((b) => b.client),
      { rng: seeded(5), every: 100, away: [0, 800], maxAway: 2 },
    );
    const end = new Promise<{ score: number }[]>((r) => g.once("end", r));
    await players[0]!.client.act("start");
    const table = await end;
    await chaos.stop();
    assert.ok(chaos.counts.network > 0 && chaos.counts.device > 0, JSON.stringify(chaos.counts));
    assert.equal(table.length, 5);
    assert.equal(phases.at(-1), "final");
    assert.equal(party.players.length, 5, "nobody came back as somebody new");
    await until(() => players.every((b) => b.client.view["me"]?.task === "final"));
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("a whole game with 3 players: two layers, then the last guess", async () => {
  const { players, phases, rounds, g, close } = await game(3);
  try {
    const end = new Promise<{ score: number }[]>((r) => g.once("end", r));
    await players[0]!.client.act("start");
    const table = await end;
    assert.equal(table.length, 3);
    assert.equal(phases.filter((p) => p === "play").length, 3, "3 players: 2 layers, then the last guess");
    assert.equal(phases.at(-1), "final");
    assert.deepEqual(
      players.map((b) => b.errors),
      [[], [], []],
    );
    for (const p of rounds[0]!.pictures) assert.equal(p.layers.length, 2);
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("pictures: who draws and guesses which layer, the words, the verdicts", async () => {
  const { g, players, rounds, close } = await game(7, { length: 7 });
  try {
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await end;
    const { pictures, seats, deals } = rounds[0]!;
    const n = seats.length;
    assert.equal(pictures.length, 7);
    let right = 0;
    for (const p of pictures) {
      assert.equal(p.layers.length, 6, "7 players: 6 layers (at most one less than the players)");
      const deal = deals[p.id]!;
      assert.ok(deal.choices.some((w) => w.word === p.layers[0]!.word.word), "the first layer is a word picked from two");
      p.layers.slice(1).forEach((l, i) => assert.equal(l.word.word, deal.words[i]!.word, "then the dealt words"));
      assert.equal(new Set(p.layers.map((l) => l.word.word)).size, 6, "no word twice in a picture");
      // Layer k by seat p + k; its guess by seat p + k + 1: seven different players.
      p.layers.forEach((l, k) => {
        assert.equal(l.by, seats[(p.id + k) % n]);
        assert.equal(l.guess!.by, seats[(p.id + k + 1) % n]);
        assert.equal(l.guess!.right, judge(l.guess!.text, l.word, "en", WORDS.en));
        if (l.guess!.right) right++;
      });
      assert.equal(new Set([...p.layers.map((l) => l.by), p.layers.at(-1)!.guess!.by]).size, 7);
    }
    // The bots read the layer's word most of the time (the host page's oracle).
    assert.ok(right >= 42 * 0.5, `${right} of 42 read right`);
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("privacy: a layer's word, a guess and a step's picture reach only their player until the reveal", async () => {
  const { party, g, players, rounds, close } = await game(5);
  try {
    const seen: { who: string; id: string | undefined; view: Record<string, any> }[] = [];
    for (const b of players) b.client.on("view", (v) => seen.push({ who: b.name, id: b.client.you?.id, view: structuredClone(v) }));
    const tv: Record<string, any>[] = [];
    party.on("screen-view", (v) => tv.push(structuredClone(v)));
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await end;
    const { pictures, seats, deals } = rounds[0]!;
    const n = seats.length;
    const SECRET = new Set(["word", "choices", "picture", "drawing", "strokes", "text", "guess", "gallery", "layers"]);
    /** The keys of a JSON value, deep. */
    const keys = (v: unknown, out: string[] = []): string[] => {
      if (Array.isArray(v)) for (const x of v) keys(x, out);
      else if (v && typeof v === "object")
        for (const [k, x] of Object.entries(v)) {
          out.push(k);
          keys(x, out);
        }
      return out;
    };
    const before = (phase: unknown) => phase === "lobby" || phase === "play";
    const leaks: string[] = [];
    let checked = 0;
    for (const v of tv) {
      if (!before((v["screen"] as { phase?: string })?.phase)) continue;
      for (const k of keys(v["screen"])) if (SECRET.has(k)) leaks.push(`the TV sees ${k}`);
    }
    for (const { who, id, view } of seen) {
      if (!before(view["room"]?.phase)) continue;
      for (const k of keys(view["room"])) if (SECRET.has(k)) leaks.push(`${who}: the room has ${k}`);
      for (const k of keys(view["roster"])) if (SECRET.has(k)) leaks.push(`${who}: the roster has ${k}`);
      const me = view["me"] ?? {};
      if (me.task !== "draw" && me.task !== "guess") {
        for (const k of keys(me)) if (SECRET.has(k)) leaks.push(`${who}: ${me.task} has ${k}`);
        continue;
      }
      if (keys(me).includes("text") || keys(me).includes("guess")) leaks.push(`${who}: a guess in their view`);
      // Step k (0-based) of the player at seat s: picture s − k, as it was after k layers.
      const k = me.step - 1;
      const s = seats.indexOf(id!);
      const c = pictureAt(s, k, n);
      const p = pictures[c]!;
      checked++;
      if (JSON.stringify(me.picture) !== JSON.stringify(flatten(p.layers.slice(0, k)))) leaks.push(`${who}: step ${k + 1} shows another picture`);
      if (me.task === "draw") {
        if (k === 0 && JSON.stringify(me.choices) !== JSON.stringify(deals[c]!.choices.map((w) => w.word))) leaks.push(`${who}: someone else's choices`);
        if (k > 0 && me.word !== p.layers[k]!.word.word) leaks.push(`${who}: someone else's word`);
        if (k > 0 && p.layers[k]!.by !== id) leaks.push(`${who}: a word for a layer they do not draw`);
      } else if (keys(me).includes("word") || keys(me).includes("choices")) leaks.push(`${who}: a word while guessing`);
    }
    assert.deepEqual([...new Set(leaks)], []);
    assert.ok(checked > 20, `${checked} views checked`);
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("silent players: blank layers, no guesses (wrong), the game goes on", async () => {
  const { g, players, rounds, close } = await game(4, { silent: 2 });
  try {
    const end = new Promise<{ id: string; score: number }[]>((r) => g.once("end", r));
    await players[0]!.client.act("start");
    const table = await end;
    const mute = new Set(players.filter((b) => b.name.startsWith("Mute")).map((b) => b.client.you!.id));
    for (const p of rounds[0]!.pictures) {
      for (const l of p.layers) {
        if (mute.has(l.by)) assert.deepEqual(l.drawing.strokes, [], "a silent player's layer is blank");
        if (mute.has(l.guess!.by)) assert.deepEqual([l.guess!.text, l.guess!.right], ["", false]);
      }
    }
    for (const id of mute) assert.equal(table.find((l) => l.id === id)!.score, 0);
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("in German: German words, judged in German", async () => {
  const { g, players, rounds, close } = await game(5, { lang: "de" });
  try {
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await end;
    assert.equal(g.lang, "de");
    const german = new Set(WORDS.de.map((w) => w.word));
    const layers = rounds[0]!.pictures.flatMap((p) => p.layers);
    assert.ok(layers.every((l) => german.has(l.word.word)));
    assert.ok(layers.some((l) => l.guess!.right));
    for (const l of layers) assert.equal(l.guess!.right, !!l.guess!.text && judge(l.guess!.text, l.word, "de", WORDS.de));
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("the best move: others' layers only, 200 to the most votes", async () => {
  const { g, players, close } = await game(4, { voter: true });
  try {
    const mute = players.find((b) => b.name === "Voter")!;
    let before = new Map<string, number>();
    let votes = new Map<string, string>();
    let pictures: Picture[] = [];
    const checks: Promise<void>[] = [];
    g.on("phase", (p) => {
      if (p === "vote") {
        before = new Map(g.scores);
        // The silent player tries their own layer and one that is not there, then votes.
        checks.push(
          until(() => mute.client.view["me"]?.task === "vote").then(async () => {
            const mine = mute.client.view["me"].mine as string[];
            assert.ok(mine.length > 0);
            await assert.rejects(mute.client.act("vote", { layer: mine[0] }), /own/i);
            await assert.rejects(mute.client.act("vote", { layer: "99:0" }), /layer/i);
            const other = (mute.client.view["room"].gallery as { id: number; layers: unknown[] }[]).flatMap((x) => x.layers.map((_, k) => `${x.id}:${k}`)).find((id) => !mine.includes(id))!;
            await mute.client.act("vote", { layer: other });
          }),
        );
      }
      if (p === "best") {
        votes = new Map(g.round!.votes);
        pictures = structuredClone(g.round!.pictures);
      }
    });
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await end;
    await Promise.all(checks);
    assert.equal(votes.size, 5, "everyone voted");
    for (const [voter, id] of votes) {
      const [pi, li] = id.split(":").map(Number);
      assert.notEqual(pictures[pi!]!.layers[li!]!.by, voter, "never your own layer");
    }
    const best = bestMove(votes);
    const earned = scoreRound(pictures, votes);
    for (const [id, e] of earned) assert.equal(g.scores.get(id)! - (before.get(id) ?? 0), earnedTotal(e), "the round's points");
    for (const id of best.ids) {
      const [pi, li] = id.split(":").map(Number);
      assert.ok(earned.get(pictures[pi!]!.layers[li!]!.by)!.best >= best.points);
    }
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("a scripted first round: the seats and the words as written", async () => {
  const { g, players, rounds, close } = await game(4);
  try {
    const names = ["Cy", "Ada", "Dot", "Bea"];
    g.script = {
      seats: names,
      pictures: [
        { choices: ["cat", "owl"], words: ["submarine", "hedgehog"] },
        { choices: ["sun", "key"], words: ["lion", "clock"] },
        { choices: ["fish", "hat"], words: ["rocket", "car"] },
        { choices: ["house", "tree"], words: ["robot", "zebra"] },
      ],
    };
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await end;
    const { seats, pictures } = rounds[0]!;
    const byId = new Map(players.map((b) => [b.client.you!.id, b.name]));
    assert.deepEqual(
      seats.map((id) => byId.get(id)),
      names,
    );
    assert.deepEqual(
      pictures[0]!.layers.slice(1).map((l) => l.word.word),
      ["submarine", "hedgehog"],
    );
    assert.deepEqual(pictures[0]!.layers[1]!.word.also, ["sub"], "the list's synonyms");
    assert.ok(["cat", "owl"].includes(pictures[0]!.layers[0]!.word.word));
    assert.equal(g.script, undefined, "for one round only");
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("the host page removes players and moves the VIP during a game: it plays on", async () => {
  const { party, g, players, close } = await game(9, { rounds: 2 });
  try {
    const end = new Promise((r) => g.once("end", r));
    const removed: string[] = [];
    // One player removed in each kind of phase, the first time it comes.
    g.on("phase", (p) => {
      if (removed.includes(p) || !["play", "reveal", "vote", "best", "scores"].includes(p)) return;
      removed.push(p);
      setTimeout(() => {
        const victim = party.players.find((x) => !x.vip);
        if (victim) party.kick(victim);
        const next = party.players.find((x) => !x.vip);
        if (next) party.makeVip(next);
      }, 10);
    });
    await players[0]!.client.act("start");
    await end;
    assert.equal(removed.length, 5, "every kind of phase came");
    assert.equal(g.phase, "final");
    assert.equal(party.players.length, 4);
    assert.equal(party.players.filter((p) => p.vip).length, 1);
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("settings: the VIP only, before a game", async () => {
  const { g, players, close } = await game(4);
  try {
    assert.deepEqual(g.settings, { undo: true, length: 5 }, "undo is on by default");
    await players[0]!.client.act("settings", { undo: false, length: 3, rounds: 3 });
    assert.deepEqual(g.settings, { undo: false, length: 3 });
    assert.equal(g.rounds, 3);
    await assert.rejects(players[1]!.client.act("settings", { undo: true }), /VIP/);
    await assert.rejects(players[0]!.client.act("settings", { length: 4 }), /length/);
    await assert.rejects(players[0]!.client.act("settings", { rounds: 9 }), /rounds/);
    await until(() => players[2]!.client.view["room"].undo === false && players[2]!.client.view["room"].rounds === 3);
    await assert.rejects(players[0]!.client.act("settings", { colour: "red" }), /not a setting/);
    // Every setting of the host page: only the VIP, only its choices, every phone sees it, the host page hears of it.
    let told = 0;
    g.on("settings", () => told++);
    const room = () => players[2]!.client.view["room"];
    const cases: [string, unknown, unknown][] = [
      ["lang", "de", "fr"],
      ["timers", "fast", "slow"],
      ["late", "closed", "open"],
    ];
    for (const [key, good, bad] of cases) {
      await assert.rejects(players[1]!.client.act("settings", { [key]: good }), { code: "not-vip" }, key);
      await assert.rejects(players[0]!.client.act("settings", { [key]: bad }), { code: "bad-settings" }, key);
      const before = told;
      await players[0]!.client.act("settings", { [key]: good });
      assert.equal(told, before + 1, `${key}: the host page hears of it`);
      await until(() => room()[key] === good);
    }
    assert.equal(g.lang, "de");
    assert.deepEqual(room()["langs"], ["en", "de"]);
    assert.equal(g.pace, "fast");
    assert.equal(g.timings.draw, FAST_TIMINGS.draw);
    assert.equal(g.party.lateJoin, "closed");
    // The host page's late-join field (lateJoinField) sets the party, then tells the game: the phones follow.
    g.party.lateJoin = "wait";
    g.configure({ late: "wait" });
    await until(() => room()["late"] === "wait");
    assert.throws(() => g.configure({ late: "open" }), /Latecomers/);
    await players[0]!.client.act("settings", { lang: "en", timers: "normal" });
    assert.equal(g.timings.draw, DEFAULT_TIMINGS.draw);
    await until(() => room()["lang"] === "en" && room()["timers"] === "normal");
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("settings: none during a game, all again on the final screen", async () => {
  const { g, players, close } = await game(3);
  try {
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await until(() => g.phase === "play");
    for (const s of [{ lang: "de" }, { rounds: 2 }, { length: 3 }, { timers: "fast" }, { late: "closed" }, { undo: false }]) await assert.rejects(players[0]!.client.act("settings", s), { code: "running" }, JSON.stringify(s));
    assert.equal(g.lang, "en");
    assert.equal(g.party.lateJoin, "wait");
    await end;
    await players[0]!.client.act("settings", { lang: "de", late: "closed", timers: "fast" });
    const room = () => players[1]!.client.view["room"];
    await until(() => room()["phase"] === "final" && room()["lang"] === "de" && room()["late"] === "closed" && room()["timers"] === "fast");
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("a TV 250 ms behind: every phone gets a phase, a step and a result when the TV shows it, never before; deadlines count from then", async () => {
  const tvDelay = 250;
  const { party, g, players, phases, close } = await game(4, { tvDelay });
  try {
    /** A view's place in the game: the phase, with its round and its step (play) or picture (reveal). */
    const key = (v: { phase?: string; round?: number; step?: number; index?: number } | undefined) => (v?.phase === "final" ? "final" : `${String(v?.round)}:${String(v?.phase)}:${String(v?.step ?? v?.index ?? "")}`);
    // When the host changed the TV to each, and when each phone got there.
    const tv = new Map<string, number>();
    const off = party.on("screen-view", (v) => {
      const k = key(v["screen"] as Parameters<typeof key>[0]);
      if (!tv.has(k)) tv.set(k, Date.now());
    });
    const timings = g.timings;
    const lengths: Record<string, number> = { first: timings.firstDraw, turn: timings.guess + timings.draw, last: timings.guess };
    const early: string[] = [];
    const short: string[] = [];
    let checked = 0;
    for (const b of players) {
      let last = "";
      let result = "";
      b.client.on("view", (v) => {
        const room = v["room"] ?? {};
        const me = v["me"] ?? {};
        const k = key(room);
        if (k !== last) {
          last = k;
          const at = tv.get(k);
          if (at !== undefined) {
            checked++;
            if (Date.now() - at < tvDelay - 30) early.push(`${b.name}: ${k} ${Date.now() - at} ms after the TV`);
            if (room.phase === "play") {
              const left = room.deadline - party.now();
              if (left < lengths[room.kind]! - 60) short.push(`${b.name}: ${k} ${left} ms of ${lengths[room.kind]}`);
            }
          }
        }
        // The best move's result and the scores: not before the TV shows them.
        if ((me.task === "best" || me.task === "scores") && result !== `${room.round}:${me.task}`) {
          result = `${room.round}:${me.task}`;
          const at = tv.get(`${room.round}:${me.task}:`);
          if (at === undefined || Date.now() - at < tvDelay - 30) early.push(`${b.name}: ${result} ${at === undefined ? "before the TV" : `${Date.now() - at} ms after the TV`}`);
        }
      });
    }
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await end;
    await until(() => players.every((b) => b.client.view["me"]?.task === "final"));
    off();
    assert.equal(phases.filter((p) => p === "play").length, 4);
    assert.ok(checked > 40, `${checked} phases checked`);
    assert.deepEqual(early, []);
    assert.deepEqual(short, []);
    assert.deepEqual(
      players.map((b) => b.errors),
      [[], [], [], []],
    );
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("too few players left: the game ends before the next round, to its final screen; an away phone still counts", async () => {
  // Two of four leave in round 1: no round 2.
  {
    const { party, g, players, phases, close } = await game(4, { rounds: 2 });
    try {
      g.once("phase", function kick(p) {
        if (p !== "scores") return void g.once("phase", kick);
        for (const victim of party.players.filter((x) => !x.vip).slice(0, 2)) party.kick(victim);
      });
      const end = new Promise<{ id: string }[]>((r) => g.once("end", r));
      await players[0]!.client.act("start");
      const table = await end;
      assert.equal(phases.filter((p) => p === "reveal").length, 1, "one round");
      assert.equal(phases.at(-1), "final");
      assert.equal(table.length, 2);
      assert.equal((party.screen.peek() as { phase: string }).phase, "final");
      assert.equal(party.inProgress, false);
    } finally {
      for (const b of players) b.close();
      close();
    }
  }
  // Three, one of them away when round 2 starts: it is played.
  {
    const { party, g, players, phases, close } = await game(3, { rounds: 2 });
    try {
      g.once("phase", function away(p) {
        if (p !== "scores") return void g.once("phase", away);
        players[2]!.client.drop({ away: 2500 });
      });
      const end = new Promise<{ id: string }[]>((r) => g.once("end", r));
      await players[0]!.client.act("start");
      const table = await end;
      assert.equal(phases.filter((p) => p === "reveal").length, 2, "both rounds");
      assert.equal(table.length, 3);
      assert.equal(party.players.length, 3);
    } finally {
      for (const b of players) b.close();
      close();
    }
  }
});

test("close() mid-round: the lobby at once, nothing more is written, no final screen; a later play() starts afresh", async () => {
  const { party, g, players, phases, add, close } = await game(4, { rounds: 2, think: 150 });
  try {
    let ended = false;
    g.on("end", () => (ended = true));
    await players[0]!.client.act("start");
    await until(() => g.phase === "play" && (party.screen.peek() as { step?: number }).step === 2);
    const late = await add("Late");
    await until(() => late.client.view["me"]?.task === "wait");
    g.close();
    assert.equal(g.running, false);
    assert.equal(g.phase, "lobby");
    assert.equal(party.inProgress, false);
    assert.equal(party.players.find((p) => p.name === "Late")!.waiting, false, "latecomers are in");
    assert.equal((party.screen.peek() as { phase: string }).phase, "lobby");
    assert.equal((party.room.peek() as { phase: string }).phase, "lobby");
    assert.deepEqual(
      party.players.map((p) => (p.state.peek() as { task: string }).task),
      ["lobby", "lobby", "lobby", "lobby", "lobby"],
    );
    await until(() => players.every((b) => b.client.view["me"]?.task === "lobby"));
    const snapshot = () => JSON.stringify([party.screen.peek(), party.room.peek(), party.players.map((p) => p.state.peek())]);
    const then = snapshot();
    let flushed = 0;
    const off = party.on("screen-view", () => flushed++);
    // Longer than any step, the reveal, the vote and the scores with these timings.
    await new Promise((r) => setTimeout(r, 3000));
    off();
    assert.equal(snapshot(), then, "nothing written after close()");
    assert.equal(flushed, 0);
    assert.equal(ended, false, "closing is not finishing");
    assert.ok(!phases.includes("final") && !phases.includes("reveal"));
    // The VIP starts a new game from the start, the latecomer in it.
    const end = new Promise<{ score: number }[]>((r) => g.once("end", r));
    const from = phases.length;
    await players[0]!.client.act("start");
    await until(() => g.phase === "play");
    assert.equal((party.screen.peek() as { round: number; step: number }).round, 1);
    assert.equal((party.screen.peek() as { step: number }).step, 1);
    assert.equal(g.round!.seats.length, 5);
    const table = await end;
    assert.equal(table.length, 5);
    assert.equal(phases.slice(from).filter((p) => p === "reveal").length, 2);
    assert.equal(phases.at(-1), "final");
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("a closed bot never acts: its pending answers go with it", async () => {
  const { g, players, close } = await game(3, { think: 400 });
  try {
    await players[0]!.client.act("start");
    await until(() => g.phase === "play" && players[2]!.client.view["me"]?.task === "draw");
    players[2]!.close();
    await new Promise((r) => setTimeout(r, 700));
    assert.deepEqual(players[2]!.errors, [], "no act on a closed client");
    g.close();
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("a late joiner waits, then plays from the next round", async () => {
  const { party, g, players, add, close } = await game(3, { rounds: 2 });
  try {
    const end = new Promise<{ name: string }[]>((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await until(() => g.phase === "play");
    const late = await add("Late");
    await until(() => late.client.view["me"]?.task === "wait");
    assert.equal(late.client.view["me"].note, "round");
    assert.equal(party.players.find((p) => p.name === "Late")!.waiting, true);
    assert.ok(!g.round!.seats.some((p) => p.name === "Late"), "not in the running round");
    await until(() => late.client.view["room"]?.round === 2 && late.client.view["me"]?.task === "draw", 15_000);
    assert.equal(party.players.find((p) => p.name === "Late")!.waiting, false);
    const table = await end;
    assert.deepEqual(table.map((l) => l.name).sort(), ["Ada", "Bea", "Cy", "Late"]);
    assert.deepEqual(late.errors, []);
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("the VIP removes a player from the phone in the lobby, not during a game", async () => {
  const { party, g, players, close } = await game(4);
  try {
    await assert.rejects(players[1]!.client.act("kick", { id: players[3]!.client.you!.id }), /VIP/);
    await assert.rejects(players[0]!.client.act("kick", { id: players[0]!.client.you!.id }), /player/i);
    await players[0]!.client.act("kick", { id: players[3]!.client.you!.id });
    assert.equal(party.players.length, 3);
    await until(() => players[3]!.client.status === "closed");
    await players[0]!.client.act("start");
    await assert.rejects(players[0]!.client.act("kick", { id: players[2]!.client.you!.id }), /game/i);
    const end = new Promise<unknown[]>((r) => g.once("end", r));
    assert.equal((await end).length, 3);
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("guesses shown on the TV and in the gallery go through party.moderate; judged as typed", async () => {
  const moderate: PartyOptions["moderate"] = (text, { kind, player }) => (kind !== "guess" ? undefined : player?.name === "Ada" ? false : `~${text}`);
  const { party, g, players, rounds, close } = await game(4, { moderate });
  try {
    const reveals: { layers: { guess: { by: { name: string }; text: string; right: boolean; hidden?: boolean } | null }[] }[] = [];
    party.on("screen-view", (v) => {
      const s = v["screen"] as { phase?: string; picture?: (typeof reveals)[number] };
      if (s?.phase === "reveal" && s.picture) reveals.push(s.picture);
    });
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await end;
    const guesses = reveals.flatMap((p) => p.layers.map((l) => l.guess!));
    assert.ok(guesses.length > 0);
    for (const x of guesses) {
      if (x.by.name === "Ada") assert.deepEqual([x.text, x.hidden], ["", true]);
      else assert.ok(x.text.startsWith("~"), x.text);
    }
    // The verdicts are the typed text's.
    for (const p of rounds[0]!.pictures) for (const l of p.layers) assert.equal(l.guess!.right, judge(l.guess!.text, l.word, "en", WORDS.en));
  } finally {
    for (const b of players) b.close();
    close();
  }
});
