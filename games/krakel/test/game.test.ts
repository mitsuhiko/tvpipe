import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { Party } from "@tvpipe/party";
import { memoryStorage, PartyClient } from "@tvpipe/party/client";
import { dropOuts, MemoryRelay } from "@tvpipe/party/testing";

import { Bot, bots } from "../game/bots.ts";
import { Krakel, type Script, type Timings } from "../game/game.ts";
import { earnedTotal, entryPoints, parseCategories, POINTS, scoreRound, seeded, shapeOf, type Entry } from "../game/rules.ts";

const data = (f: string) => parseCategories(readFileSync(new URL(`../data/${f}`, import.meta.url), "utf8"));
const WORDS = { en: data("words.txt"), de: data("words.de.txt") };

const fast: Timings = { draw: 1500, guess: 800, lead: 30, reveal: 8, vote: 1000, ranked: 8, scores: 8 };

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
  hints?: boolean;
  mixed?: boolean;
  lockout?: number;
  timings?: Partial<Timings>;
  /** Players the test plays by hand (they leave these tasks alone). */
  manual?: { name: string; skip: string[] }[];
  script?: Script;
  guessAt?: () => number;
  /** How far the TV is behind, ms. */
  tvDelay?: number;
}

async function game(n: number, opts: Opts = {}) {
  const relay = new MemoryRelay();
  const party = new Party({ grace: 100, maxPlayers: 10, tvDelay: opts.tvDelay }).listen(relay);
  const g = new Krakel(party, { words: WORDS, rounds: opts.rounds ?? 1, timings: { ...fast, ...opts.timings }, rng: seeded(11), lang: opts.lang, hints: opts.hints, mixed: opts.mixed, lockout: opts.lockout ?? 0.05 });
  g.script = opts.script;
  g.open();
  const phases: string[] = [];
  g.on("phase", (p) => phases.push(p));
  const o = {
    url: "ws://party.test/_tvpipe/ws",
    WebSocket: relay.WebSocket,
    room: party.code,
    key: party.joinKey,
    rng: seeded(n),
    think: () => 3,
    // Early enough that a slow machine's late timers still land inside the replay.
    guessAt: opts.guessAt ?? (() => 0.15 + Math.random() * 0.4),
    oracle: opts.oracle === false ? undefined : (id: string) => g.meant(id),
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
  /** The rounds' drawings once they are ranked (the game forgets them at the end). */
  const rounds: { category: string | null; entries: Entry[]; votes: Map<string, string> }[] = [];
  g.on("phase", (p) => {
    if (p === "scores" && g.round) rounds.push({ category: g.round.category?.title ?? null, entries: structuredClone(g.round.entries), votes: new Map(g.round.votes) });
  });
  const screen = () => party.screenView()["screen"] as Record<string, any>;
  return { relay, party, g, players, phases, rounds, screen, close: () => party.close() };
}

test("a whole game with 4 players", async () => {
  const { party, g, players, phases, rounds, screen, close } = await game(4, { rounds: 2 });
  try {
    const end = new Promise<{ id: string; score: number }[]>((r) => g.once("end", r));
    await players[0]!.client.act("start");
    const table = await end;
    assert.equal(table.length, 4);
    assert.deepEqual(phases.filter((p) => p === "draw").length, 2);
    assert.equal(phases.filter((p) => p === "guess").length, 8, "every drawing of both rounds on stage");
    for (const p of ["gallery", "scores"]) assert.equal(phases.filter((x) => x === p).length, 2, p);
    assert.equal(phases.at(-1), "final");
    assert.deepEqual(
      players.map((b) => b.errors),
      [[], [], [], []],
    );
    assert.equal(rounds.length, 2);
    assert.notEqual(rounds[0]!.category, rounds[1]!.category, "another category each round");
    const totals = new Map<string, number>();
    for (const r of rounds) {
      assert.equal(r.entries.length, 4);
      assert.equal(new Set(r.entries.map((e) => e.word.word)).size, 4, "a different word each");
      const list = WORDS.en.find((c) => c.title === r.category)!;
      for (const e of r.entries) {
        assert.ok(e.shown && e.drawing.strokes.length > 0);
        assert.ok(list.words.some((x) => x.word === e.word.word), "a word of the round's category");
        assert.equal(e.category, r.category);
        assert.equal(e.guessers.length, 3);
        assert.equal(e.hits.length, 3, "the bots know the word");
        assert.equal(e.hits.filter((h) => h.first).length, 1);
        assert.ok(e.hits.every((h) => h.points >= POINTS.min && h.points <= POINTS.max && h.by !== e.by));
      }
      for (const [id, e] of scoreRound(r.entries, r.votes)) totals.set(id, (totals.get(id) ?? 0) + earnedTotal(e));
    }
    for (const l of table) assert.equal(l.score, totals.get(l.id), "the table is the rounds' points");
    await until(() => players.every((b) => b.client.view["me"].task === "final"));
    const s = screen();
    assert.equal(s["phase"], "final");
    assert.ok(s["best"].points > 0 && s["best"].drawing.strokes.length > 0, "the game's clearest drawing");
    assert.ok(s["eye"].points > 0);
    assert.equal(party.inProgress, false);
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("phones drop out and come back all game long (a lost signal, another phone): the game ends with everyone in it", async () => {
  const { party, g, players, phases, close } = await game(5, { rounds: 2, timings: { guess: 500 } });
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

test("what phones and the TV are told: the word only to its artist until the reveal, blanks in the easy mode", async () => {
  const script: Script = { category: WORDS.en[0]!.title, words: { Ada: "zebra crossing", Bea: WORDS.en[0]!.words[0]!.word }, order: ["Ada", "Bea"] };
  const { party, g, players, screen, close } = await game(3, { script, timings: { guess: 1500, lead: 60, reveal: 300 }, guessAt: () => 0.4 });
  try {
    const [ada, bea, cy] = players as [Bot, Bot, Bot];
    const seen: string[] = [];
    const leaks: string[] = [];
    const secret = /zebra crossing/i;
    // Everything a guesser's phone and the TV get while Ada's drawing is on stage.
    const watch = (name: string, view: () => unknown, guessing: () => boolean) => {
      if (guessing() && secret.test(JSON.stringify(view()))) leaks.push(name);
    };
    const onStage = () => g.phase === "guess" && (screen()["artist"]?.name === "Ada") && screen()["stage"] === "guess";
    bea.client.on("view", (v) => watch("Bea's phone", () => v, onStage));
    party.on("screen-view", () => watch("the TV", () => party.screenView(), onStage));
    ada.client.on("view", (v) => {
      const me = v["me"] ?? {};
      if (me.task === "draw") seen.push(`draw:${JSON.stringify(me.choices)}`);
      if (me.task === "artist") seen.push(`artist:${me.word}`);
    });
    const end = new Promise((r) => g.once("end", r));
    await ada.client.act("start");
    await until(() => g.phase === "guess" && screen()["stage"] === "guess");
    const s = screen();
    assert.equal(s["artist"].name, "Ada");
    assert.equal(s["index"], 1);
    assert.equal(s["of"], 3);
    assert.equal(s["shape"], shapeOf("zebra crossing"));
    assert.equal(s["shape"], "_____ ________");
    assert.equal(s["category"], script.category);
    assert.ok(s["end"] - s["start"] === 1500 && s["drawing"].strokes.length > 0);
    assert.deepEqual(s["guessers"].map((x: { name: string }) => x.name).sort(), ["Bea", "Cy"]);
    assert.equal(s["word"], undefined);
    await until(() => cy.client.view["room"]?.spot?.key === "1:1");
    const room = cy.client.view["room"];
    assert.equal(room.spot.shape, "_____ ________");
    assert.equal(room.spot.artist.name, "Ada");
    assert.deepEqual(room.spot.drawing, s["drawing"]);
    await until(() => screen()["stage"] === "reveal");
    assert.equal(screen()["word"], "zebra crossing");
    assert.equal(screen()["got"].length, 2);
    await until(() => bea.client.view["me"].task === "result" || bea.client.view["me"].task === "artist");
    await end;
    assert.deepEqual(leaks, []);
    assert.ok(seen.includes('draw:["zebra crossing"]') && seen.includes("artist:zebra crossing"), seen.join(" "));
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("the hard mode shows no blanks", async () => {
  const { g, players, screen, close } = await game(3, { hints: false });
  try {
    await players[0]!.client.act("start");
    await until(() => g.phase === "guess");
    assert.equal(screen()["shape"], null);
    await until(() => players[1]!.client.view["room"]?.spot !== undefined);
    assert.equal(players[0]!.client.view["room"].hints, false);
    assert.equal(players[1]!.client.view["room"].spot.shape, null);
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("guessing by hand: too early, wrong (locked, on the TV), close (not on the TV), right by time, once; the artist and stale keys are refused", async () => {
  const script: Script = { category: "Test", words: { Ada: "elephant", Bea: "fox", Zoe: "owl" }, order: ["Ada", "Bea", "Zoe"] };
  const { relay, party, g, players, screen, close } = await game(3, {
    script,
    lockout: 0.6,
    timings: { guess: 3000, lead: 250, reveal: 200 },
    manual: [{ name: "Zoe", skip: ["guess"] }],
    guessAt: () => 0.5,
  });
  // A TV: the wrong guesses arrive there as messages.
  const tv = new PartyClient({ url: "ws://party.test/_tvpipe/ws", room: party.code, key: party.screenKey, role: "screen", storage: memoryStorage(), WebSocket: relay.WebSocket });
  const shown: any[] = [];
  tv.on("msg", (type, d) => type === "guess" && shown.push(d));
  await tv.connect();
  try {
    const [ada, bea, zoe] = players as [Bot, Bot, Bot];
    const z = zoe.client;
    const code = (p: Promise<unknown>) => p.then(() => "ok", (e: { code: string }) => e.code);
    await ada.client.act("start");
    await until(() => g.phase === "guess" && z.view["me"].task === "guess");
    const key = z.view["me"].key;
    assert.equal(key, "1:1");
    assert.equal(await code(z.act("guess", { key, text: "elephant" })), "not-yet", "before the replay starts");
    assert.equal(await code(ada.client.act("guess", { key, text: "elephant" })), "own-drawing");
    await until(() => party.now() >= screen()["start"]);
    assert.equal(await code(z.act("guess", { key: "1:2", text: "elephant" })), "not-now", "another drawing's key");
    assert.equal(await code(z.act("guess", { key, text: "  " })), "empty");
    const wrong = (await z.act("guess", { key, text: "a hippo" })) as { verdict: string; lockedUntil: number };
    assert.equal(wrong.verdict, "wrong");
    assert.ok(wrong.lockedUntil > party.now());
    assert.equal(z.view["me"].tries, 1);
    assert.equal(await code(z.act("guess", { key, text: "elephant" })), "locked");
    await until(() => party.now() >= wrong.lockedUntil);
    assert.equal(z.view["me"].lockedUntil, wrong.lockedUntil);
    const close1 = (await z.act("guess", { key, text: "elefent" })) as { verdict: string; lockedUntil: number };
    assert.equal(close1.verdict, "close");
    await until(() => party.now() >= close1.lockedUntil);
    const before = (party.now() - screen()["start"]) / 3000;
    const right = (await z.act("guess", { key, text: "Elefant" })) as { verdict: string; points: number; first: boolean };
    const after = (party.now() - screen()["start"]) / 3000;
    assert.equal(right.verdict, "right", "a slip is forgiven");
    assert.equal(right.first, true, "Bea's bot answers at half time");
    const least = Math.round((1000 - 800 * after) / 10) * 10 + POINTS.first;
    const most = Math.round((1000 - 800 * before) / 10) * 10 + POINTS.first;
    assert.ok(right.points >= least && right.points <= most, `${least} <= ${right.points} <= ${most}`);
    await until(() => z.view["me"].right === true);
    assert.equal(z.view["me"].points, right.points);
    assert.equal(await code(z.act("guess", { key, text: "elephant" })), "already");
    await until(() => shown.length >= 2);
    assert.deepEqual(shown.slice(0, 2), [{ id: z.you!.id, text: "a hippo" }, { id: z.you!.id, close: true }]);
    assert.deepEqual(screen()["got"], [{ id: z.you!.id, points: right.points, first: true }]);
    // Everyone who is there has it: the replay ends early.
    await until(() => screen()["stage"] === "reveal", 5000);
    assert.ok(party.now() < screen()["end"], "before the time was up");
    const got = screen()["got"] as { id: string; points: number; first: boolean }[];
    assert.equal(got.length, 2);
    assert.equal(screen()["word"], "elephant");
    // The artist: half of what the two earned by time.
    assert.equal(screen()["points"], Math.round((got[0]!.points - POINTS.first + got[1]!.points) / 2 / 10) * 10);
    await until(() => ada.client.view["me"].task === "result");
    assert.equal(ada.client.view["me"].mine, true);
    assert.equal(ada.client.view["me"].got, 2);
    await until(() => z.view["me"].task === "result" && z.view["me"].right === true);
    // The next drawing: nobody guesses for Zoe; she lets it pass.
    await until(() => screen()["index"] === 2 && screen()["stage"] === "guess" && z.view["me"].task === "guess", 5000);
    assert.equal(z.view["me"].key, "1:2");
    assert.equal(await code(z.act("guess", { key, text: "fox" })), "not-now", "the last drawing's key");
    await until(() => screen()["index"] === 3 && z.view["me"].task === "artist", 10_000);
    assert.equal(z.view["me"].word, "owl");
  } finally {
    tv.close();
    for (const b of players) b.close();
    close();
  }
});

test("silent players: the game goes on without them; a blank page is not shown and earns nothing", async () => {
  const { g, players, rounds, phases, close } = await game(4, { silent: 1, timings: { draw: 400, guess: 600, vote: 300 } });
  try {
    const end = new Promise<{ id: string; name: string; score: number }[]>((r) => g.once("end", r));
    await players[0]!.client.act("start");
    const table = await end;
    assert.equal(table.length, 4);
    assert.equal(phases.filter((p) => p === "guess").length, 3, "three drawings: the fourth page is blank");
    const mute = table.find((l) => l.name === "Mute1")!;
    assert.equal(mute.score, 0);
    const blank = rounds[0]!.entries.find((e) => e.by === mute.id)!;
    assert.equal(blank.shown, false);
    for (const e of rounds[0]!.entries.filter((x) => x.shown)) {
      assert.equal(e.guessers.length, 3);
      assert.equal(e.hits.length, 2, "the silent one never has it");
      assert.ok(entryPoints(e) > 0);
    }
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("without a clue nobody has it: every replay runs its whole time and nobody scores for drawing", async () => {
  const { g, players, rounds, close } = await game(3, { oracle: false, timings: { guess: 250, vote: 300 } });
  try {
    const end = new Promise<{ score: number }[]>((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await end;
    for (const e of rounds[0]!.entries) assert.equal(e.hits.length, 0);
    assert.deepEqual(
      players.map((b) => b.errors),
      [[], [], []],
    );
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("the hearts: not for one's own drawing; the favourite pays its artist and tops the phone's card", async () => {
  const { g, players, rounds, screen, close } = await game(4, { manual: [{ name: "Zoe", skip: ["vote"] }], timings: { vote: 3000, ranked: 300 } });
  try {
    const zoe = players[3]!.client;
    const end = new Promise<{ id: string; score: number }[]>((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await until(() => zoe.view["me"]?.task === "vote", 8000);
    const room = zoe.view["room"];
    assert.equal(room.stage, "vote");
    assert.equal(room.gallery.length, 4);
    assert.ok(room.gallery.every((x: any) => x.word && x.artist.name && x.drawing.strokes.length > 0));
    assert.equal(zoe.view["me"].own, zoe.you!.id);
    const code = (p: Promise<unknown>) => p.then(() => "ok", (e: { code: string }) => e.code);
    assert.equal(await code(zoe.act("vote", { id: zoe.you!.id })), "own-drawing");
    assert.equal(await code(zoe.act("vote", { id: "nobody" })), "bad-vote");
    // Zoe gives her heart to whoever has one already (the bots voted at once), so there is a favourite.
    await until(() => screen()["done"].length === 3);
    const other = room.gallery.find((x: any) => x.id !== zoe.you!.id)!.id;
    assert.equal(await code(zoe.act("vote", { id: other })), "ok");
    assert.notEqual(await code(zoe.act("vote", { id: other })), "ok", "one heart");
    await until(() => screen()["stage"] === "ranked");
    const ranking = screen()["ranking"] as { id: string; place: number; points: number; hearts: number; fav: number; got: number; of: number }[];
    assert.equal(ranking.length, 4);
    assert.deepEqual(ranking.map((x) => x.place), [...ranking.map((x) => x.place)].sort((a, b) => a - b));
    assert.equal(ranking.reduce((n, x) => n + x.hearts, 0), 4);
    for (let i = 1; i < ranking.length; i++) assert.ok(ranking[i - 1]!.points >= ranking[i]!.points);
    await until(() => zoe.view["me"].task === "ranked");
    const mine = ranking.find((x) => x.id === zoe.you!.id)!;
    assert.equal(zoe.view["me"].place, mine.place);
    assert.equal(zoe.view["me"].drawings, 4);
    assert.equal(zoe.view["me"].hearts, mine.hearts);
    const table = await end;
    const r = rounds[0]!;
    const earned = scoreRound(r.entries, r.votes);
    for (const l of table) assert.equal(l.score, earnedTotal(earned.get(l.id)!));
    const favs = ranking.filter((x) => x.fav > 0);
    assert.ok(favs.length > 0, "two hearts on one drawing at least: four hearts on four drawings, none on one's own… or all different");
    for (const f of favs) assert.equal(earned.get(f.id)!.favourite, f.fav);
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("the settings: the VIP's, checked; the host's; none during a game", async () => {
  const { party, g, players, close } = await game(3);
  try {
    const [vip, other] = players as [Bot, Bot];
    const code = (p: Promise<unknown>) => p.then(() => "ok", (e: { code: string }) => e.code);
    assert.equal(await code(other.client.act("settings", { hints: false })), "not-vip");
    assert.equal(await code(vip.client.act("settings", { drawTime: 61 })), "bad-settings");
    assert.equal(await code(vip.client.act("settings", { hints: "no" })), "bad-settings");
    assert.equal(await code(vip.client.act("settings", { mixed: 1 })), "bad-settings");
    assert.equal(await code(vip.client.act("settings", { rounds: 9 })), "bad-settings");
    assert.equal(await code(vip.client.act("settings", { colour: "red" })), "bad-settings");
    const changed: unknown[] = [];
    g.on("settings", (s) => changed.push(s));
    assert.equal(await code(vip.client.act("settings", { drawTime: 180, guessTime: 30, hints: false, lockout: 8, rounds: 3, mixed: true })), "ok");
    assert.deepEqual(g.settings, { drawTime: 180, guessTime: 30, hints: false, lockout: 8, mixed: true });
    assert.equal(g.rounds, 3);
    assert.equal(g.timings.draw, 180_000);
    assert.equal(g.timings.guess, 30_000);
    assert.equal(changed.length, 1);
    await until(() => other.client.view["room"].drawTime === 180);
    const room = other.client.view["room"];
    assert.deepEqual([room.guessTime, room.hints, room.lockout, room.rounds, room.mixed], [30, false, 8, 3, true]);
    const s = party.screenView()["screen"] as Record<string, unknown>;
    assert.deepEqual([s["drawTime"], s["guessTime"], s["hints"], s["lockout"], s["rounds"]], [180, 30, false, 8, 3]);
    // The language and the latecomers, like the host page's: the VIP's too, checked, every phone follows, the host page hears of it.
    assert.deepEqual([room.lang, room.langs, room.late], ["en", ["en", "de"], "wait"]);
    assert.equal(await code(other.client.act("settings", { lang: "de" })), "not-vip");
    assert.equal(await code(other.client.act("settings", { late: "closed" })), "not-vip");
    assert.equal(await code(vip.client.act("settings", { lang: "fr" })), "bad-settings");
    assert.equal(await code(vip.client.act("settings", { late: "open" })), "bad-settings");
    assert.equal(await code(vip.client.act("settings", { late: true })), "bad-settings");
    assert.deepEqual([g.lang, party.lateJoin, changed.length], ["en", "wait", 1]);
    assert.equal(await code(vip.client.act("settings", { lang: "de", late: "closed" })), "ok");
    assert.deepEqual([g.lang, g.late, party.lateJoin, changed.length], ["de", "closed", "closed", 2]);
    await until(() => players.every((p) => p.client.view["room"].lang === "de" && p.client.view["room"].late === "closed"));
    assert.equal((party.screenView()["screen"] as Record<string, unknown>)["lang"], "de");
    // The host page's (its field sets the party's lateJoin, then tells the game).
    party.lateJoin = "wait";
    g.configure({ late: "wait" });
    await until(() => other.client.view["room"].late === "wait");
    g.configure({ lang: "en" });
    await until(() => other.client.view["room"].lang === "en");
    g.configure({ lang: "de", timings: fast, lockout: 0, mixed: false });
    await until(() => other.client.view["room"].lang === "de");
    assert.throws(() => g.configure({ lang: "fr" as "de" }), { code: "bad-lang" });
    await vip.client.act("start");
    await until(() => g.phase === "draw");
    assert.throws(() => g.configure({ rounds: 1 }), { code: "running" });
    assert.equal(await code(vip.client.act("settings", { hints: true })), "running");
    assert.equal(await code(vip.client.act("settings", { lang: "en" })), "running");
    assert.equal(await code(vip.client.act("settings", { late: "closed" })), "running");
    assert.equal(party.lateJoin, "wait");
    assert.ok(WORDS.de.some((c) => c.title === g.round!.category?.title), "a German category");
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("everyone has three words to pick from (two when the category is short of them), each with its category", async () => {
  for (const [n, per] of [
    [4, 3],
    [10, 2],
  ] as const) {
    const { g, players, close } = await game(n);
    try {
      await players[0]!.client.act("start");
      await until(() => g.phase === "draw" && players.every((b) => b.client.view["me"]?.task === "draw"));
      const title = g.round!.category!.title;
      const size = g.round!.category!.words.length;
      assert.equal(per, Math.min(3, Math.floor(size / n)), `${size} words for ${n}`);
      const all: string[] = [];
      for (const b of players) {
        const me = b.client.view["me"];
        assert.equal(me.choices.length, per);
        assert.deepEqual(me.categories, me.choices.map(() => title));
        all.push(...me.choices);
      }
      assert.equal(new Set(all).size, per * n, "no word twice");
      assert.equal(players[0]!.client.view["room"].category, title);
    } finally {
      for (const b of players) b.close();
      close();
    }
  }
});

test("mixed words: three words from three categories each; no category while drawing, every drawing's own on stage", async () => {
  const { party, g, players, rounds, screen, close } = await game(4, { mixed: true, rounds: 2, timings: { guess: 900, reveal: 60 } });
  try {
    const end = new Promise((r) => g.once("end", r));
    const staged: { category: string; word: string; phone: string }[] = [];
    party.on("screen-view", () => {
      const s = screen();
      if (s["phase"] === "guess" && s["stage"] === "reveal" && !staged.some((x) => x.word === s["word"])) {
        staged.push({ category: s["category"], word: s["word"], phone: players[0]!.client.view["room"]?.category });
      }
    });
    await players[0]!.client.act("start");
    await until(() => g.phase === "draw" && players.every((b) => b.client.view["me"]?.task === "draw"));
    assert.equal(g.round!.category, null);
    assert.equal(screen()["category"], null);
    assert.equal(players[0]!.client.view["room"].category, null);
    assert.equal(players[0]!.client.view["room"].mixed, true);
    const home = new Map(WORDS.en.flatMap((c) => c.words.map((x) => [x.word, c.title] as const)));
    const all: string[] = [];
    for (const b of players) {
      const me = b.client.view["me"];
      assert.equal(me.choices.length, 3);
      assert.equal(new Set(me.categories).size, 3, "three categories");
      me.choices.forEach((word: string, i: number) => assert.equal(me.categories[i], home.get(word), word));
      all.push(...me.choices);
    }
    assert.equal(new Set(all).size, 12, "no word twice");
    await end;
    assert.equal(rounds.length, 2);
    for (const r of rounds) {
      assert.equal(r.category, null);
      for (const e of r.entries) {
        assert.equal(e.category, home.get(e.word.word));
        assert.equal(e.hits.length, 3, "the bots know the word");
      }
    }
    // On stage every drawing came with its own category, on the TV and on the phones.
    assert.equal(staged.length, 8);
    for (const s of staged) assert.equal(s.category, home.get(s.word), s.word);
    assert.ok(new Set(staged.map((s) => s.category)).size > 2, "from several categories");
    assert.deepEqual(
      players.map((b) => b.errors),
      [[], [], [], []],
    );
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("a latecomer waits for the next round, then plays", async () => {
  const { relay, party, g, players, phases, close } = await game(3, { rounds: 2 });
  let late: Bot | undefined;
  try {
    const end = new Promise<{ name: string; score: number }[]>((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await until(() => g.phase === "guess");
    late = new Bot({ url: "ws://party.test/_tvpipe/ws", WebSocket: relay.WebSocket, room: party.code, key: party.joinKey, name: "Late", rng: seeded(9), think: () => 3, oracle: (id) => g.meant(id) });
    await late.join();
    await until(() => late!.client.view["me"]?.task !== undefined);
    assert.equal(late.client.view["me"].task, "wait");
    assert.equal(late.client.view["me"].note, "round");
    const table = await end;
    assert.equal(table.length, 4);
    assert.ok(table.find((l) => l.name === "Late")!.score > 0);
    assert.equal(phases.filter((p) => p === "guess").length, 3 + 4);
  } finally {
    late?.close();
    for (const b of players) b.close();
    close();
  }
});

test("in German: German categories and words, guesses with articles and plurals", async () => {
  const { g, players, rounds, close } = await game(4, { lang: "de" });
  try {
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await end;
    const r = rounds[0]!;
    const list = WORDS.de.find((c) => c.title === r.category)!;
    assert.ok(list);
    for (const e of r.entries) {
      assert.ok(list.words.some((x) => x.word === e.word.word));
      assert.equal(e.hits.length, 3);
    }
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("the host removes players and moves the VIP during a game: it plays on", async () => {
  const { party, g, players, phases, close } = await game(7, { rounds: 2 });
  try {
    const end = new Promise<{ id: string }[]>((r) => g.once("end", r));
    const removed: string[] = [];
    // One player removed in each kind of phase, the first time it comes, and the VIP moved on.
    g.on("phase", (p) => {
      if (removed.includes(p) || !["draw", "guess", "gallery", "scores"].includes(p)) return;
      removed.push(p);
      setTimeout(() => {
        const victim = party.players.find((x) => !x.vip);
        if (victim) party.kick(victim);
        const next = party.players.find((x) => !x.vip);
        if (next) party.makeVip(next);
      }, 0);
    });
    await players[0]!.client.act("start");
    const table = await end;
    assert.deepEqual(removed, ["draw", "guess", "gallery", "scores"], "every kind of phase came");
    assert.equal(phases.filter((p) => p === "draw").length, 2, "both rounds, with three left");
    assert.equal(g.phase, "final");
    assert.equal(party.players.length, 3);
    assert.deepEqual(table.map((l) => l.id).sort(), party.players.map((p) => p.id).sort(), "the removed are not ranked");
    assert.equal(party.players.filter((p) => p.vip).length, 1);
    const left = new Set(party.players.map((p) => p.id));
    for (const b of players) if (left.has(b.client.you!.id)) assert.deepEqual(b.errors, [], b.name);
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("the VIP removes a player from the phone in the lobby; nobody else, and not during a game", async () => {
  const { party, g, players, close } = await game(4, { rounds: 1 });
  try {
    const id = (i: number) => players[i]!.client.you!.id;
    await assert.rejects(players[1]!.client.act("kick", { id: id(3) }), (e: { code: string }) => e.code === "not-vip");
    await assert.rejects(players[0]!.client.act("kick", { id: id(0) }), (e: { code: string }) => e.code === "no-player");
    await players[0]!.client.act("kick", { id: id(3) });
    assert.equal(party.players.length, 3);
    assert.ok(!party.player(id(3)));
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await assert.rejects(players[0]!.client.act("kick", { id: id(2) }), (e: { code: string }) => e.code === "running");
    await end;
    assert.equal(party.players.length, 3);
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("too few players left: the game ends at the next round, to its final screen; a phone that is only away still plays", async () => {
  // Three players, one removed in the first round: no second round.
  {
    const { party, g, players, phases, screen, close } = await game(3, { rounds: 2 });
    try {
      const end = new Promise<unknown[]>((r) => g.once("end", r));
      let kicked = false;
      g.on("phase", (p) => {
        if (p !== "guess" || kicked) return;
        kicked = true;
        setTimeout(() => party.kick(party.players.find((x) => !x.vip)!), 0);
      });
      await players[0]!.client.act("start");
      const table = await end;
      assert.equal(g.minPlayers, 3);
      assert.equal(phases.filter((p) => p === "draw").length, 1, "the first round played out, no second");
      assert.equal(phases.at(-1), "final");
      assert.equal(table.length, 2);
      assert.equal(screen()["phase"], "final");
      assert.equal(party.inProgress, false);
    } finally {
      for (const b of players) b.close();
      close();
    }
  }
  // Three players, one phone away all game: it still counts.
  {
    const { g, players, phases, close } = await game(3, { rounds: 2 });
    try {
      const end = new Promise<unknown[]>((r) => g.once("end", r));
      await players[0]!.client.act("start");
      await until(() => g.phase === "draw");
      players[2]!.client.drop({ away: 60_000 });
      const table = await end;
      assert.equal(phases.filter((p) => p === "draw").length, 2, "both rounds");
      assert.equal(table.length, 3);
    } finally {
      for (const b of players) b.close();
      close();
    }
  }
});

test("a TV 250 ms behind: every phone gets a phase and a drawing's result when the TV shows it, never before", async () => {
  const tvDelay = 250;
  const { party, g, players, close } = await game(4, { rounds: 1, tvDelay });
  try {
    // When the host changed the TV to each step, and when each phone's room got there.
    const tv = new Map<string, number>();
    const off = party.on("screen-view", (v) => {
      const sc = v["screen"] as Record<string, any> | undefined;
      if (!sc) return;
      const key = `${sc["round"]}:${sc["phase"]}:${sc["stage"] ?? ""}:${sc["phase"] === "guess" ? sc["key"] : ""}`;
      if (!tv.has(key)) tv.set(key, Date.now());
    });
    const early: string[] = [];
    const seen = new Set<string>();
    for (const b of players) {
      let last = "";
      b.client.on("view", (v) => {
        const room = v["room"] as Record<string, any> | undefined;
        if (!room) return;
        const stage = room["phase"] === "guess" ? (room["reveal"] ? "reveal" : "guess") : (room["stage"] ?? "");
        const key = `${room["round"]}:${room["phase"]}:${stage}:${room["phase"] === "guess" ? room["spot"]?.key : ""}`;
        if (key === last) return;
        last = key;
        const at = tv.get(key);
        if (room["phase"] === "lobby") return;
        if (at === undefined) return void early.push(`${b.name}: ${key} before the TV had it`);
        seen.add(key);
        if (Date.now() - at < tvDelay - 30) early.push(`${b.name}: ${key} ${Date.now() - at} ms after the TV`);
        // A drawing's result reaches the phone with the reveal, not before.
        const me = v["me"] as Record<string, any>;
        if (me?.["task"] === "result" && stage !== "reveal") early.push(`${b.name}: a result in ${key}`);
      });
    }
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await end;
    await until(() => players.every((b) => b.client.view["room"]?.phase === "final"));
    off();
    for (const k of ["1:draw::", "1:guess:guess:1:1", "1:guess:reveal:1:1", "1:gallery:vote:", "1:gallery:ranked:", "1:scores::", "1:final::"]) assert.ok(seen.has(k), `${k} checked (${[...seen].join(", ")})`);
    assert.deepEqual(early, []);
    assert.deepEqual(
      players.map((b) => b.errors),
      [[], [], [], []],
    );
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("close(): the lobby at once, everyone in, no final screen, nothing written after it; then a fresh game", async () => {
  const { relay, party, g, players, phases, close } = await game(3, { rounds: 2, tvDelay: 100 });
  let late: Bot | undefined;
  try {
    let ended = 0;
    g.on("end", () => ended++);
    await players[0]!.client.act("start");
    await until(() => g.phase === "guess");
    late = new Bot({ url: "ws://party.test/_tvpipe/ws", WebSocket: relay.WebSocket, room: party.code, key: party.joinKey, name: "Late", rng: seeded(9), think: () => 3 });
    await late.join();
    await until(() => late!.client.view["me"]?.task === "wait");
    await until(() => (party.screen.peek() as Record<string, unknown>)["stage"] === "guess");
    g.close();
    const views = () => JSON.stringify([party.screen.peek(), party.room.peek(), party.players.map((p) => p.state.peek())]);
    const now = views();
    assert.equal(g.running, false);
    assert.equal(party.inProgress, false);
    assert.equal(g.phase, "lobby");
    assert.equal((party.screen.peek() as Record<string, unknown>)["phase"], "lobby");
    assert.equal((party.room.peek() as Record<string, unknown>)["phase"], "lobby");
    assert.ok(party.players.every((p) => !p.waiting && (p.state.peek() as Record<string, unknown>)["task"] === "lobby"));
    assert.equal(party.players.length, 4);
    // The old game's timers, replays and TV-synced changes write nothing.
    const after = phases.length;
    await new Promise((r) => setTimeout(r, fast.guess + 400));
    assert.equal(views(), now);
    assert.deepEqual(phases.slice(after), []);
    assert.equal(ended, 0, "closing is not finishing");
    await until(() => [...players, late!].every((b) => b.client.view["me"]?.task === "lobby"));
    // A fresh game, the latecomer in it from the start.
    const end = new Promise<unknown[]>((r) => g.once("end", r));
    await players[0]!.client.act("start");
    const table = await end;
    assert.equal(table.length, 4);
    assert.equal(phases.filter((p) => p === "draw").length, 1 + 2);
    assert.deepEqual(
      players.map((b) => b.errors),
      [[], [], []],
    );
  } finally {
    late?.close();
    for (const b of players) b.close();
    close();
  }
});
