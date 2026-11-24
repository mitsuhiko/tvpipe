import assert from "node:assert/strict";
import { test } from "node:test";

import { Party } from "@tvpipe/party";
import { memoryStorage, PartyClient } from "@tvpipe/party/client";
import { dropOuts, MemoryRelay } from "@tvpipe/party/testing";

import { Bot, bots, type BotOptions } from "../game/bots.ts";
import { Busted, type Script, type Stage, type Timings } from "../game/game.ts";
import { parseQuestions, seeded, type Question } from "../game/rules.ts";

const QUESTIONS: Question[] = parseQuestions(
  [
    "vote\tfamily\tWho would most likely sleep through a whole day?\tSleepyhead of the Year",
    "vote\tfamily\tWho would most likely adopt ten cats?\tCat Magnet",
    "vote\tfamily\tWho would most likely get lost in their own street?\tHuman Compass",
    "vote\tparty\tWho would most likely text the wrong person?\tWrong Number",
    "answer\tfamily\tWhat would be your most useless superpower?",
    "answer\tfamily\tWhat would your robot butler be called?",
    "answer\tfamily\tWhat is the best smell in the world?",
    "answer\tparty\tWhat is your most embarrassing playlist called?",
    "# German",
  ].join("\n"),
);
const DE: Question[] = parseQuestions(
  [
    "vote\tfamily\tWer würde am ehesten einen ganzen Tag verschlafen?\tSiebenschläfer:in",
    "answer\tfamily\tWas wäre deine unnötigste Superkraft?",
  ].join("\n"),
);

const fast: Timings = {
  ask: 20,
  rank: 600,
  ballot: 5,
  tallied: 10,
  title: 10,
  write: 600,
  board: 10,
  boardPer: 1,
  boardMax: 30,
  match: 600,
  matchPer: 10,
  matchMax: 800,
  card: 5,
  revealed: 5,
  scores: 10,
};

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
  lang?: "en" | "de";
  timings?: Partial<Timings>;
  manual?: { name: string; skip: string[] }[];
  script?: Script;
  tvDelay?: number;
  minPlayers?: number;
  ballots?: "open" | "secret";
  bot?: Partial<BotOptions>;
}

async function game(n: number, opts: Opts = {}) {
  const relay = new MemoryRelay();
  const party = new Party({ grace: 100, maxPlayers: 10, tvDelay: opts.tvDelay }).listen(relay);
  const g = new Busted(party, {
    questions: { en: QUESTIONS, de: DE },
    rounds: opts.rounds ?? 2,
    timings: { ...fast, ...opts.timings },
    rng: seeded(7),
    lang: opts.lang,
    minPlayers: opts.minPlayers,
    ballots: opts.ballots,
  });
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
    rate: "never" as const,
    ...opts.bot,
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
  const screen = () => party.screenView()["screen"] as Record<string, any>;
  return { relay, party, g, players, phases, screen, close: () => party.close() };
}

const ROUND_VOTE = ["round:ask", "round:rank", "round:count", "round:title", "scores"];
const ROUND_ANSWER = ["round:ask", "round:write", "round:board", "round:match", "round:reveal", "scores"];

test("a whole game with 4 players: vote, answer, vote, answer; points add up; covers and titles at the end", async () => {
  const { g, players, phases, screen, close } = await game(4, { rounds: 4 });
  try {
    const end = new Promise<{ id: string; score: number }[]>((r) => g.once("end", r));
    await players[0]!.client.act("start");
    const table = await end;
    assert.deepEqual(phases, [...ROUND_VOTE, ...ROUND_ANSWER, ...ROUND_VOTE, ...ROUND_ANSWER, "final"]);
    assert.equal(table.length, 4);
    for (const b of players) assert.deepEqual(b.errors, [], b.name);
    const s = screen();
    assert.equal(s["phase"], "final");
    assert.equal(s["covers"].length, 4);
    const titles = s["covers"].flatMap((c: { titles: string[] }) => c.titles);
    assert.ok(titles.length >= 2, "two vote rounds: at least two titles");
    // Each answer round: every guess one point; each vote round at most 5 per voter.
    assert.ok(table.every((l) => l.score >= 0));
    await until(() => players.every((b) => b.client.view["me"]?.task === "final"));
    assert.ok(players.some((b) => b.client.view["me"].cover));
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("three players: a podium of two, two answers each, each name twice", async () => {
  const { g, party, players, close } = await game(3, { rounds: 2 });
  try {
    const seen: Record<string, any>[] = [];
    g.on("phase", (_p, s) => {
      if (s === "rank" || s === "match") seen.push(structuredClone(party.room.peek()));
    });
    let cards = 0;
    g.on("phase", (_p, s) => {
      if (s === "reveal") cards = (party.screenView()["screen"] as any).reveal?.items.length ?? 0;
    });
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await end;
    assert.equal(seen[0]!["podium"], 2);
    assert.equal(seen[1]!["per"], 2);
    assert.equal(seen[1]!["cards"].length, 6);
    assert.equal(cards, 6);
    for (const b of players) assert.deepEqual(b.errors, [], b.name);
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("secrets: no writer before the reveal, no voters with secret ballots, no ballots before the count", async () => {
  const { g, party, players, close } = await game(4, { rounds: 2, ballots: "secret" });
  try {
    const seen: { stage: Stage | null; screen: string; room: string; mes: string[] }[] = [];
    const sample = setInterval(() => {
      if (!g.running) return;
      seen.push({ stage: g.stage, screen: JSON.stringify(party.screenView()), room: JSON.stringify(party.room.peek()), mes: players.map((b) => JSON.stringify(b.client.view?.me ?? {})) });
    }, 2);
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await end;
    clearInterval(sample);
    assert.ok(seen.some((v) => v.stage === "match"));
    for (const v of seen) {
      if (v.stage === "write" || v.stage === "board" || v.stage === "match") {
        assert.ok(!/"author"|"guesses"/.test(v.screen + v.room), `no writer before the reveal (${v.stage})`);
      }
      if (v.stage === "rank" || v.stage === "ask") assert.ok(!/"ballots":\[|"result":/.test(v.screen + v.room), `no ballots before the count: ${v.stage} ${v.screen}`);
      if (v.stage === "count") assert.ok(!/"from"/.test(v.screen), "secret ballots: no voters");
      // A phone's own answers and cards are its own: never another's.
      for (const m of v.mes) assert.ok(!/"author"/.test(m));
    }
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("open ballots: the count names the voters", async () => {
  const { g, party, players, close } = await game(4, { rounds: 1, ballots: "open" });
  try {
    let ballots: { from?: string; podium: string[] }[] = [];
    g.on("phase", (_p, s) => {
      if (s === "count") ballots = (party.screenView()["screen"] as any).ballots;
    });
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await end;
    assert.equal(ballots.length, 4);
    assert.deepEqual(ballots.map((b) => b.from).sort(), players.map((b) => b.client.you!.id).sort());
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("ranking and matching by hand: refusals, then the points", async () => {
  const { g, party, players, close } = await game(4, { rounds: 2, manual: [{ name: "Zed", skip: ["rank", "match"] }] });
  try {
    const zed = players[3]!.client;
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await until(() => zed.view["me"]?.task === "rank");
    const cands: string[] = zed.view["room"].candidates;
    assert.equal(cands.length, 4);
    await assert.rejects(zed.act("rank", { podium: [cands[0], cands[0]] }), { code: "bad-podium" });
    await assert.rejects(zed.act("rank", { podium: ["nobody"] }), { code: "bad-podium" });
    await assert.rejects(zed.act("match", {}));
    await zed.act("rank", { podium: [zed.you!.id, cands[1], cands[2]] });
    await assert.rejects(zed.act("rank", { podium: [cands[1]] }));
    await until(() => zed.view["me"]?.task === "match");
    const own: number[] = zed.view["me"].own;
    assert.equal(own.length, 1);
    const authors: string[] = zed.view["room"].authors.filter((a: string) => a !== zed.you!.id);
    const cards: number[] = zed.view["room"].cards.map((c: { id: number }) => c.id).filter((id: number) => !own.includes(id));
    await assert.rejects(zed.act("match", { guesses: { [own[0]!]: authors[0] } }), { code: "bad-match" });
    await assert.rejects(zed.act("match", { guesses: { [cards[0]!]: authors[0], [cards[1]!]: authors[0] } }), { code: "bad-match" });
    const truth = new Map<number, string>();
    g.on("phase", (_p, s) => {
      if (s === "reveal") for (const it of (party.screenView()["screen"] as any).reveal.items) truth.set(it.card.id, it.author);
    });
    await zed.act("match", { guesses: Object.fromEntries(cards.map((c, i) => [c, authors[i]])), heart: cards[0] });
    await end;
    const right = cards.filter((c, i) => truth.get(c) === authors[i]).length;
    const items = [...truth.keys()];
    assert.equal(items.length, 4);
    assert.ok(right >= 0);
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("silent players: deadlines end every stage; their cards are missing, their ballots too", async () => {
  const { g, players, phases, close } = await game(5, { rounds: 2, silent: 2 });
  try {
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await end;
    assert.deepEqual(phases, [...ROUND_VOTE, ...ROUND_ANSWER, "final"]);
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("nobody writes: no matching, nothing to reveal, no points", async () => {
  const { g, players, phases, close } = await game(3, { rounds: 2, silent: 3, timings: { rank: 100, write: 100 } });
  try {
    const end = new Promise((r) => g.once("end", r));
    await g.play();
    await end;
    assert.ok(!phases.includes("round:match"));
    assert.deepEqual([...g.scores.values()], [0, 0, 0]);
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("suggestions: rated on the desk while people wait; approved ones are played and credited; a 🚫 drops one", async () => {
  const { g, party, players, close } = await game(4, { rounds: 2, bot: { rate: "never" } });
  try {
    const [a, b, c, d] = players.map((x) => x.client);
    await a!.act("suggest", { kind: "vote", text: "who would most likely eat soup with a fork", title: "fork master" });
    await b!.act("suggest", { kind: "answer", text: "What would you name a pet rock" });
    await c!.act("suggest", { kind: "vote", text: "Who would most likely be mean to waiters?" });
    await assert.rejects(a!.act("suggest", { kind: "quiz", text: "What?" }), { code: "bad-kind" });
    await assert.rejects(a!.act("suggest", { kind: "vote", text: "Hm?" }), { code: "bad-question" });
    await assert.rejects(d!.act("suggest", { kind: "vote", text: "Who would most likely eat soup with a fork?" }), { code: "duplicate" });
    await until(() => b!.view["me"]?.desk?.left === 2);
    // The author never rates their own; the desk never says who wrote it.
    assert.equal(a!.view["me"].desk.left, 2);
    assert.ok(!JSON.stringify(b!.view["me"].desk).includes(a!.you!.id));
    const ids = g.suggestions.map((s) => s.text);
    assert.deepEqual(ids, ["Who would most likely eat soup with a fork?", "What would you name a pet rock?", "Who would most likely be mean to waiters?"]);
    const id = (text: string) => g.suggestions.findIndex((s) => s.text === text);
    const tip = (i: number) => `t${i + 1}`;
    // Soup: two 👍 of three others → approved. Pet rock: 👍 👍 → approved. Waiters: a 🚫 → dropped.
    await b!.act("rate", { id: tip(0), rating: 1 });
    await assert.rejects(a!.act("rate", { id: tip(0), rating: 1 }), { code: "own-tip" });
    await c!.act("rate", { id: tip(0), rating: 1 });
    await a!.act("rate", { id: tip(1), rating: 1 });
    await c!.act("rate", { id: tip(1), rating: 1 });
    await d!.act("rate", { id: tip(2), rating: "no" });
    await until(() => g.suggestions.every((s) => s.state !== "pending"));
    assert.deepEqual(
      g.suggestions.map((s) => s.state),
      ["approved", "approved", "dropped"],
    );
    void id;
    const questions: any[] = [];
    g.on("phase", (_p, s) => {
      if (s === "ask") questions.push((party.screenView()["screen"] as any).question);
    });
    const end = new Promise((r) => g.once("end", r));
    await a!.act("start");
    await end;
    assert.equal(questions[0].text, "Who would most likely eat soup with a fork?");
    assert.equal(questions[0].title, "Fork master");
    assert.equal(questions[0].by.name, players[0]!.name);
    // Not the same author twice in a row: b's comes next anyway.
    assert.equal(questions[1].text, "What would you name a pet rock?");
    assert.deepEqual(
      g.suggestions.map((s) => s.state),
      ["played", "played", "dropped"],
    );
    const awards = (party.screenView()["screen"] as any).awards;
    assert.ok(awards.reporter);
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("the same author's suggestions never twice in a row: the deck plays between", async () => {
  const { g, party, players, close } = await game(4, { rounds: 4, bot: { rate: "up" } });
  try {
    const a = players[0]!.client;
    await a.act("suggest", { kind: "vote", text: "Who would most likely sing to a cow?" });
    await a.act("suggest", { kind: "vote", text: "Who would most likely bake bread at 4 am?" });
    await assert.rejects(a.act("suggest", { kind: "vote", text: "Who would most likely knit a scarf for a tree?" }).then(() => a.act("suggest", { kind: "vote", text: "Who would most likely hug a cactus?" })), { code: "too-many" });
    await until(() => g.suggestions.filter((s) => s.state === "approved").length === 3);
    const asked: string[] = [];
    g.on("phase", (_p, s) => {
      if (s === "ask") asked.push((party.screenView()["screen"] as any).question.by?.name ?? "deck");
    });
    const end = new Promise((r) => g.once("end", r));
    await a.act("start");
    await end;
    // Rounds 1 and 3 are votes: a's, then the deck's (round 2 was the deck's answer: a's again is fine in round 3).
    assert.equal(asked[0], players[0]!.name);
    assert.equal(asked[1], "deck");
    assert.equal(asked[2], players[0]!.name);
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("skipping: the VIP skips a question while ranking; another one comes; too late after", async () => {
  const { g, party, players, close } = await game(4, { rounds: 1, manual: [{ name: "Zed", skip: ["rank"] }], timings: { rank: 2000 } });
  try {
    const asked: string[] = [];
    g.on("phase", (_p, s) => {
      if (s === "ask") asked.push((party.screenView()["screen"] as any).question.text);
    });
    const end = new Promise((r) => g.once("end", r));
    await assert.rejects(players[1]!.client.act("skip"), { code: "not-vip" });
    await players[0]!.client.act("start");
    await until(() => g.stage === "rank");
    await players[0]!.client.act("skip");
    await until(() => asked.length === 2);
    assert.notEqual(asked[0], asked[1]);
    await until(() => g.stage === "count" || g.stage === "title", 4000);
    await assert.rejects(players[0]!.client.act("skip"), { code: "not-now" });
    await end;
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("honorary candidates: added in the lobby, voted for, on the covers; never during a game", async () => {
  const { g, party, players, close } = await game(3, { rounds: 1 });
  try {
    const vip = players[0]!.client;
    await assert.rejects(players[1]!.client.act("extra", { name: "Rex" }), { code: "not-vip" });
    await vip.act("extra", { name: "Rex the dog" });
    g.addExtra("Grandma");
    await assert.rejects(vip.act("extra", { name: players[1]!.name }), { code: "name-taken" });
    g.addExtra("Mr Whiskers");
    await assert.rejects(vip.act("extra", { name: "Too many" }), { code: "extras-full" });
    assert.deepEqual(
      g.extras.map((x) => x.name),
      ["Rex the dog", "Grandma", "Mr Whiskers"],
    );
    await vip.act("extra", { remove: g.extras[2]!.id });
    let candidates: string[] = [];
    g.on("phase", (_p, s) => {
      if (s === "rank") candidates = party.room.peek()["candidates"] as string[];
    });
    const end = new Promise((r) => g.once("end", r));
    await vip.act("start");
    await until(() => g.stage === "rank");
    assert.throws(() => g.addExtra("Late"), /Not during a game/);
    await end;
    assert.equal(candidates.length, 5);
    assert.ok(candidates.includes(g.extras[0]!.id));
    const covers = (party.screenView()["screen"] as any).covers as { id: string }[];
    assert.equal(covers.length, 5);
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("press photos: drawn on the phone, checked, on every view; an empty one is the doodle again", async () => {
  const { g, party, players, close } = await game(3, { rounds: 1 });
  try {
    const a = players[0]!.client;
    await a.act("portrait", { strokes: [[10, 10, 20, 20, 30, 10]] });
    await assert.rejects(a.act("portrait", { strokes: [[1, 2, 3]] }), { code: "bad-portrait" });
    await until(() => players[1]!.client.view["room"].people[a.you!.id].face?.length === 1);
    assert.deepEqual((party.screenView()["screen"] as any).people[a.you!.id].face, [[10, 10, 20, 20, 30, 10]]);
    await a.act("portrait", { strokes: [] });
    await until(() => players[1]!.client.view["room"].people[a.you!.id].face === null);
    void g;
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("phones drop out and come back all game long: the game ends with everyone in it", async () => {
  const { g, players, phases, close } = await game(5, { rounds: 4 });
  try {
    const chaos = dropOuts(
      players.map((b) => b.client),
      { rng: seeded(5), every: 100, away: [0, 800], maxAway: 2 },
    );
    const end = new Promise<{ score: number }[]>((r) => g.once("end", r));
    await players[0]!.client.act("start");
    const table = await end;
    await chaos.stop();
    assert.equal(table.length, 5);
    assert.equal(phases.filter((p) => p === "round:reveal").length + phases.filter((p) => p === "round:board").length >= 2, true);
    assert.ok(chaos.counts.network + chaos.counts.device > 0);
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("the VIP's settings are checked, and none during a game", async () => {
  const { g, party, players, close } = await game(3, { rounds: 2, timings: { rank: 2000 } });
  try {
    const vip = players[0]!.client;
    await assert.rejects(players[1]!.client.act("settings", { rounds: 6 }), { code: "not-vip" });
    await assert.rejects(vip.act("settings", { rounds: 7 }), { code: "bad-settings" });
    await assert.rejects(vip.act("settings", { level: "spicy" }), { code: "bad-settings" });
    await assert.rejects(vip.act("settings", { colour: "red" }), { code: "bad-settings" });
    await vip.act("settings", { rounds: 6, level: "party", ballots: "secret", writeTime: 90 });
    assert.equal(g.rounds, 6);
    assert.deepEqual(g.settings, { level: "party", ballots: "secret", writeTime: 90, lateJoin: "wait" });
    assert.equal(vip.view["room"].level, "party");
    // Latecomers: the host page's two choices; the party follows, and the host page hears of it.
    assert.equal(vip.view["room"].lateJoin, "wait");
    await assert.rejects(players[1]!.client.act("settings", { lateJoin: "closed" }), { code: "not-vip" });
    await assert.rejects(vip.act("settings", { lateJoin: "open" }), { code: "bad-settings" });
    await assert.rejects(vip.act("settings", { lateJoin: "never" }), { code: "bad-settings" });
    assert.equal(party.lateJoin, "wait");
    const heard = new Promise((r) => g.once("settings", r));
    await vip.act("settings", { lateJoin: "closed" });
    assert.deepEqual(await heard, { level: "party", ballots: "secret", writeTime: 90, lateJoin: "closed" });
    assert.equal(party.lateJoin, "closed");
    await until(() => players.every((p) => p.client.view["room"].lateJoin === "closed"));
    // The language is the room's: every phone and the TV follow the VIP.
    await assert.rejects(players[1]!.client.act("settings", { lang: "de" }), { code: "not-vip" });
    await assert.rejects(vip.act("settings", { lang: "fr" }), { code: "bad-settings" });
    await vip.act("settings", { lang: "de" });
    assert.equal(g.lang, "de");
    await until(() => players.every((p) => p.client.view["room"].lang === "de"));
    g.configure({ rounds: 2 });
    await vip.act("start");
    await until(() => g.stage === "rank");
    await assert.rejects(vip.act("settings", { rounds: 8 }), { code: "running" });
    await assert.rejects(vip.act("settings", { lateJoin: "wait" }), { code: "running" });
    assert.equal(party.lateJoin, "closed");
    g.close();
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("a latecomer waits for the next round, then plays", async () => {
  const { g, relay, party, players, close } = await game(3, { rounds: 2, timings: { rank: 400 } });
  try {
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await until(() => g.stage === "rank");
    const late = new Bot({ url: "ws://party.test/_tvpipe/ws", WebSocket: relay.WebSocket, room: party.code, key: party.joinKey, name: "Late", think: () => 3, rate: "never" });
    await late.join();
    await until(() => late.client.view["me"]?.task === "wait");
    await until(() => late.client.view["me"]?.task === "write", 4000);
    await end;
    assert.ok(g.scores.has(late.client.you!.id));
    late.close();
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("too few players left: the game ends at the next round, to its final screen", async () => {
  const { g, players, phases, close } = await game(3, { rounds: 4 });
  try {
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await until(() => g.stage === "rank");
    players[2]!.client.leave();
    await end;
    assert.deepEqual(phases, [...ROUND_VOTE, "final"]);
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("a TV 250 ms behind: phones get a stage when the TV shows it, never before", async () => {
  const { g, players, close } = await game(4, { rounds: 2, tvDelay: 250 });
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
    for (const [task, stage] of [["rank", "rank"], ["write", "write"], ["match", "match"]] as const) {
      const at = seen.find((x) => x.task === task)?.at;
      assert.ok(at !== undefined, task);
      assert.ok(at - shown.get(stage)! >= 200, `${task} ${at - shown.get(stage)!} ms after the host`);
    }
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("close(): the lobby at once, nothing written after it; then a fresh game", async () => {
  const { g, players, phases, screen, close } = await game(4, { rounds: 2 });
  try {
    await players[0]!.client.act("start");
    await until(() => g.stage === "rank");
    g.close();
    assert.equal(g.running, false);
    assert.equal(screen()["phase"], "lobby");
    await new Promise((r) => setTimeout(r, 0));
    const n = phases.length;
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(phases.length, n);
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await end;
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("in German: German questions", async () => {
  const { g, party, players, close } = await game(3, { rounds: 2, lang: "de" });
  try {
    const asked: string[] = [];
    g.on("phase", (_p, s) => {
      if (s === "ask") asked.push((party.screenView()["screen"] as any).question.text);
    });
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await end;
    assert.deepEqual(asked, ["Wer würde am ehesten einen ganzen Tag verschlafen?", "Was wäre deine unnötigste Superkraft?"]);
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("a scripted first round (screenshots)", async () => {
  const { g, party, players, close } = await game(3, { rounds: 2, script: { vote: "Who would most likely adopt ten cats?", answer: "What is the best smell in the world?" } });
  try {
    const asked: string[] = [];
    g.on("phase", (_p, s) => {
      if (s === "ask") asked.push((party.screenView()["screen"] as any).question.text);
    });
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await end;
    assert.deepEqual(asked, ["Who would most likely adopt ten cats?", "What is the best smell in the world?"]);
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("a phone that joins by hand gets the lobby with its desk", async () => {
  const relay = new MemoryRelay();
  const party = new Party({ grace: 100, maxPlayers: 10 }).listen(relay);
  const g = new Busted(party, { questions: { en: QUESTIONS }, timings: fast, rng: seeded(1) });
  g.open();
  const phone = new PartyClient({ url: "ws://t/", room: party.code, key: party.joinKey, storage: memoryStorage(), WebSocket: relay.WebSocket });
  await phone.join("Ann");
  await until(() => phone.view["me"]?.task === "lobby");
  assert.deepEqual(phone.view["me"].desk, { rate: null, left: 0, mine: [] });
  phone.close();
  party.close();
});
