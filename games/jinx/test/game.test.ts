import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { Party } from "@tvpipe/party";
import { dropOuts, MemoryRelay } from "@tvpipe/party/testing";

import { Bot, CATEGORY_DE, FALLBACK, type BotOptions } from "../game/bots.ts";
import { Jinx, type Timings } from "../game/game.ts";
import { matcher } from "../game/lang.ts";
import { dictionary, parseWordList } from "../game/match.ts";
import { roomTitle, seeded } from "../game/rules.ts";
import type { ScreenView } from "../game/views.ts";

const WORDS = parseWordList(readFileSync(new URL("../data/words.txt", import.meta.url), "utf8"));
const DICT_TEXT = readFileSync(new URL("../data/dict.txt", import.meta.url), "utf8");
const known = dictionary(DICT_TEXT);
const DICT = DICT_TEXT.split("\n").filter((w) => /^[a-z]{4,8}$/.test(w));

// German: its own words, dictionary and matcher.
const de = matcher("de");
const WORDS_DE = de.parseWordList(readFileSync(new URL(`../data/${de.files.words}`, import.meta.url), "utf8"));
const MATCH_DE = { ...de.dictionary(readFileSync(new URL(`../data/${de.files.dict}`, import.meta.url), "utf8")), englishKnown: known };

const fast: Partial<Timings> = {
  hotseat: 10,
  write: 1500,
  jinxBase: 10,
  jinxGroup: 5,
  decide: 400,
  flip: 20,
  typing: 300,
  verdict: 10,
  best: 400,
  replay: 10,
  replayHold: 10,
  bank: 10,
  endRoom: 10,
  endClues: 10,
  endAwards: 10,
  draftEvery: 20,
};

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const NAMES = ["Ada", "Bea", "Cy", "Dot", "Eli", "Fay", "Gus", "Hal"];
const URL_ = "ws://party.test/_tvpipe/ws";

type BotOpts = Partial<Omit<BotOptions, "url" | "room" | "key" | "name">>;

async function setup(
  n: number,
  o: {
    rounds?: "auto" | 1 | 2;
    bot?: (i: number) => BotOpts;
    timings?: Partial<Timings>;
    lang?: "en" | "de";
    dealt?: { en?: string[]; de?: string[] };
    records?: Record<number, number>;
    tvDelay?: number;
    moderate?: (text: string) => string | false | undefined;
    /** The languages with words (default both). */
    words?: ("en" | "de")[];
  } = {},
) {
  const relay = new MemoryRelay();
  const party = new Party({ grace: 100, maxPlayers: 8, tvDelay: o.tvDelay, moderate: o.moderate && ((text, ctx) => (ctx.kind === "name" ? undefined : o.moderate!(text))) }).listen(relay);
  const g = new Jinx(party, {
    lang: o.lang,
    words: Object.fromEntries(Object.entries({ en: WORDS, de: WORDS_DE }).filter(([l]) => !o.words || o.words.includes(l as "en" | "de"))),
    match: { en: { known }, de: MATCH_DE },
    dealt: o.dealt,
    records: o.records,
    rounds: o.rounds ?? "auto",
    timings: { ...fast, ...o.timings },
    rng: seeded(n + 1),
  });
  g.open();
  const phases: string[] = [];
  g.on("phase", (p) => phases.push(p));
  const screens: ScreenView[] = [];
  let last = "";
  party.on("screen-view", (v) => {
    // The event follows every flush (phones' states too): keep changes only.
    const json = JSON.stringify(v["screen"]);
    if (json !== last) screens.push(JSON.parse(json) as ScreenView);
    last = json;
  });
  const players: Bot[] = [];
  const add = async (name: string, i: number) => {
    const b = new Bot({
      url: URL_,
      WebSocket: relay.WebSocket,
      room: party.code,
      key: party.joinKey,
      name,
      rng: seeded(100 + i),
      think: () => 5,
      peek: () => g.secret,
      words: [...WORDS, ...WORDS_DE],
      dict: { en: DICT },
      ...o.bot?.(i),
    });
    await b.join();
    g.markBot(b.client.you!["id"]);
    players.push(b);
    return b;
  };
  for (let i = 0; i < n; i++) await add(NAMES[i]!, i);
  const close = () => {
    g.close();
    for (const b of players) b.close();
    party.close();
  };
  return { party, g, players, phases, screens, add, close };
}

const of = <P extends ScreenView["phase"]>(screens: ScreenView[], phase: P) => screens.filter((s): s is Extract<ScreenView, { phase: P }> => s.phase === phase);

/** The secrecy rule: no word on the TV before the verdict, no clue word unless turned. */
function checkSecrecy(screens: ScreenView[]): void {
  for (const s of screens) {
    if (s.phase === "hotseat" || s.phase === "write" || s.phase === "jinx" || s.phase === "reveal") {
      assert.equal("word" in s, false, `word on the TV in ${s.phase}`);
      if ("cards" in s) for (const c of s.cards) assert.equal(c.word !== undefined, c.turned !== undefined, `clue word shown in ${s.phase}`);
    }
  }
}

test("a whole game with 4 bots: every player guesses twice, the room's bank adds up, the end in steps", async () => {
  const { party, g, players, phases, screens, close } = await setup(4, { records: { 8: 3 } });
  try {
    // The guesser's phone never has the word.
    const leaks: string[] = [];
    for (const b of players) {
      b.client.on("view", (v) => {
        const me = v["me"] ?? {};
        if (["hotseat", "blind", "check", "guess", "best"].includes(me.task) && "word" in me) leaks.push(`${b.name}: ${me.task}`);
        if ("word" in (v["room"] ?? {})) leaks.push("room");
      });
    }
    const end = new Promise<number>((r) => g.once("end", r));
    const records: [number, number][] = [];
    g.on("record", (rounds, chips) => records.push([rounds, chips]));
    await players[0]!.client.act("start");
    const bank = await end;
    assert.deepEqual(leaks, []);
    assert.equal(phases.filter((p) => p === "hotseat").length, 8);
    assert.equal(phases.filter((p) => p === "verdict").length, 8);
    const verdicts = of(screens, "verdict");
    const guessers = verdicts.map((v) => v.guesser);
    for (const p of players) assert.equal(guessers.filter((x) => x === p.client.you!["id"]).length, 2);
    // The bank: the sum of the verdicts' changes, each the pot when right, −2 when wrong.
    assert.equal(
      verdicts.reduce((s, v) => s + v.banked, 0),
      bank,
    );
    let before = 0;
    for (const v of verdicts) {
      assert.equal(v.banked, v.result === "right" ? v.pot : v.result === "wrong" ? 0 - Math.min(2, before) : 0);
      before += v.banked;
      assert.equal(v.bank.chips, before);
      assert.deepEqual(v.bank.goals, { "mixed signals": 16, "in sync": 32, "mind readers": 48, telepaths: 64 });
      assert.equal(v.bank.record, 3);
    }
    assert.ok(of(screens, "replay").some((r) => r.best), "best clues picked");
    assert.ok(verdicts.some((v) => v.result === "right"), "some right guesses");
    assert.ok(screens.every((s) => s.people.every((p) => !("score" in p))), "no personal scores");
    // Between rounds: the bank, and each phone the next goal.
    const banks = of(screens, "bank");
    assert.equal(banks.length, 8);
    assert.ok(banks.every((b) => b.bank.chips === verdicts.find((v) => v.round === b.round)!.bank.chips));
    checkSecrecy(screens);
    // The dials' start times, the cards per giver, the replay's bank.
    const writes = of(screens, "write");
    assert.ok(writes.every((w) => w.started < w.deadline && Object.values(w.sentBy).reduce((a, b) => a + b, 0) === w.sent));
    assert.ok(writes.some((w) => w.sent > 0 && Object.keys(w.sentBy).every((id) => w.givers.includes(id))));
    assert.ok(of(screens, "reveal").every((x) => x.started < x.deadline));
    assert.ok(of(screens, "verdict").every((v) => typeof v.pot === "number"));
    for (const rp of of(screens, "replay")) assert.equal(rp.banked, verdicts.find((v) => v.round === rp.round)!.banked);
    // The draft went to the TV while typing.
    assert.ok(of(screens, "reveal").some((s) => s.typing && s.draft.length > 0), "a live draft");
    // The end: steps up to the web, which stays.
    await until(() => (party.screen.peek() as { step?: string }).step === "web");
    const e = party.screen.peek() as unknown as Extract<ScreenView, { phase: "end" }>;
    assert.equal(e.tally.played, 8);
    assert.equal(e.words.length, 8);
    assert.equal(e.web.words.length, 8);
    assert.equal(e.bank.chips, bank);
    assert.equal(e.title, roomTitle(bank, 8));
    assert.equal(e.clues.length, new Set(of(screens, "replay").filter((r) => r.best).map((r) => r.round)).size);
    assert.ok(e.clues.every((c) => e.words.some((w) => w.word === c.word && w.found)));
    assert.ok(e.awards.every((a) => a.kind === "mind meld" || a.kind === "telepath"));
    if (bank > 3) {
      assert.equal(e.record, true);
      assert.deepEqual(records, [[8, bank]]);
    } else assert.deepEqual(records, []);
    assert.ok(e.people.every((p) => p.bot));
    await until(() => players.every((b) => b.client.view["me"]?.task === "final"));
    const vip = players[0]!.client.view["me"];
    assert.equal(vip.canRestart, true);
    assert.equal(vip.total, 8);
    assert.equal(vip.bank, bank);
    assert.equal(vip.title, e.title);
    assert.equal(players[1]!.client.view["me"].canRestart, false);
    assert.equal(party.inProgress, false);
    assert.deepEqual(
      players.map((b) => b.errors),
      [[], [], [], []],
    );
    // Play again: a new game, rotated by one.
    const end2 = new Promise((r) => g.once("end", r));
    await assert.rejects(players[1]!.client.act("again"), (e: { code: string }) => e.code === "not-vip");
    await players[0]!.client.act("again");
    await until(() => g.phase === "hotseat");
    assert.equal((party.screen.peek() as { guesser: string }).guesser, players[1]!.client.you!["id"]);
    await end2;
    const words = new Set(of(screens, "verdict").map((v) => v.word));
    assert.equal(words.size, 16, "no word twice in a room");
  } finally {
    close();
  }
});


test("phones drop out and come back all game long (a lost signal, another phone): the game ends with everyone in it", async () => {
  const { party, g, players, phases, close } = await setup(5);
  try {
    const chaos = dropOuts(
      players.map((b) => b.client),
      { rng: seeded(5), every: 100, away: [0, 800], maxAway: 2 },
    );
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await end;
    await chaos.stop();
    assert.ok(chaos.counts.network > 0 && chaos.counts.device > 0, JSON.stringify(chaos.counts));
    assert.equal(phases.at(-1), "end");
    assert.equal(party.players.length, 5, "nobody came back as somebody new");
    await until(() => players.every((b) => b.client.view["me"]?.task === "final"));
  } finally {
    close();
  }
});
test("3 players write two clues each; 6 rounds", async () => {
  const { g, players, phases, screens, close } = await setup(3);
  try {
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await until(() => g.phase === "write");
    await until(() => players.some((b) => b.client.view["me"]?.task === "write"));
    const giver = players.find((b) => b.client.view["me"]?.task === "write")!;
    assert.equal(giver.client.view["me"].each, 2);
    assert.equal(giver.client.view["me"].sent.length, 2);
    await end;
    assert.equal(phases.filter((p) => p === "verdict").length, 6);
    const jinx = of(screens, "jinx");
    assert.ok(jinx.some((j) => j.cards.length === 4), "two cards per giver");
    checkSecrecy(screens);
  } finally {
    close();
  }
});

test("clue checks: too close, own clue, replacing, late; guess rules", async () => {
  // The jinx check long enough to see the fates in (at 15 ms, Windows' timers missed it).
  const { party, g, players, close } = await setup(3, { bot: () => ({ silent: true }), timings: { jinxBase: 1000 } });
  try {
    await players[0]!.client.act("start");
    await until(() => g.phase === "write");
    const word = g.secret!;
    const guesserId = (party.screen.peek() as { guesser: string }).guesser;
    const [a, b] = players.filter((p) => p.client.you!["id"] !== guesserId);
    const guesser = players.find((p) => p.client.you!["id"] === guesserId)!;
    await assert.rejects(a!.client.act("clue", { text: word, bold: false, slot: 0 }), (e: { code: string }) => e.code === "too-close:same word");
    await assert.rejects(a!.client.act("clue", { text: "", bold: false, slot: 0 }), (e: { code: string }) => e.code === "empty");
    await assert.rejects(a!.client.act("clue", { text: "one two three", bold: false, slot: 0 }), (e: { code: string }) => e.code === "too-many-words");
    await assert.rejects(guesser.client.act("clue", { text: "zebra", bold: false, slot: 0 }), (e: { code: string }) => e.code === "not-asked");
    const ok = await a!.client.act("clue", { text: "Zebra", bold: true, slot: 0 });
    assert.deepEqual(ok, { text: "Zebra", bold: true });
    await assert.rejects(a!.client.act("clue", { text: "zebras", bold: false, slot: 1 }), (e: { code: string }) => e.code === "own-clue:plural");
    await a!.client.act("clue", { text: "stripes", bold: false, slot: 0 }); // replaced
    await until(() => a!.client.view["me"]?.sent?.[0]?.text === "stripes");
    assert.equal(guesser.client.view["me"].task, "blind");
    await a!.client.act("clue", { text: "Zebra", bold: false, slot: 1 });
    await b!.client.act("clue", { text: "stripes", bold: true, slot: 0 });
    await b!.client.act("clue", { text: "horse", bold: false, slot: 1 });
    // All in: on to the jinx check (stripes ×2 jinxed, b's bold one too).
    await until(() => g.phase === "jinx");
    const j = party.screen.peek() as unknown as Extract<ScreenView, { phase: "jinx" }>;
    assert.equal(j.groups.length, 1);
    assert.equal(j.groups[0]!.pairs[0]!.reason, "same word");
    assert.equal(j.pot, 6, "2 jinxed, one of them bold");
    await until(() => guesser.client.view["me"]?.task === "check");
    assert.deepEqual({ ...guesser.client.view["me"] }, { task: "check", survived: 2, jinxed: 2 });
    await until(() => a!.client.view["me"]?.task === "fate");
    const fate = a!.client.view["me"].cards as { text: string; fate: string; with: string[]; reason?: string }[];
    assert.deepEqual(fate.find((c) => c.text === "stripes"), { text: "stripes", bold: false, fate: "jinxed", with: [b!.name], reason: "same word" });
    await assert.rejects(a!.client.act("clue", { text: "late", bold: false, slot: 0 }), (e: { code: string }) => e.code === "late");
    // The reveal: guess before a card, pick, the draft, a guess.
    await until(() => g.phase === "reveal");
    await assert.rejects(guesser.client.act("guess", { text: word }), (e: { code: string }) => e.code === "no-card");
    await assert.rejects(a!.client.act("pass"), (e: { code: string }) => e.code === "not-guesser");
    const cards = guesser.client.view["me"].cards as { id: string; word?: string }[];
    assert.ok(cards.every((c) => c.word === undefined));
    await guesser.client.act("pick", { card: cards[0]!.id });
    await assert.rejects(guesser.client.act("pick", { card: cards[0]!.id }), (e: { code: string }) => e.code === "bad-card");
    await until(() => (party.screen.peek() as { cards: { word?: string }[] }).cards.some((c) => c.word));
    guesser.client.input({ draft: word.slice(0, 2) });
    await until(() => (party.screen.peek() as { typing?: boolean }).typing === true);
    assert.equal((party.screen.peek() as { draft: string }).draft, word.slice(0, 2));
    await guesser.client.act("guess", { text: word.toUpperCase() });
    await until(() => g.phase === "verdict");
    const v = party.screen.peek() as unknown as Extract<ScreenView, { phase: "verdict" }>;
    assert.equal(v.result, "right");
    assert.equal(v.word, word);
    assert.equal(v.near, undefined);
    // Pot 6 (2 jinxed, b's bold: 2 more; one card), all of it into the room's bank.
    assert.equal(v.pot, 6);
    assert.equal(v.banked, 6);
    assert.equal(v.bank.chips, 6);
    await until(() => b!.client.view["me"]?.task === "result");
    assert.equal(b!.client.view["me"].parts[0], "bold-jinxed");
    assert.equal(b!.client.view["me"].banked, 6);
    await until(() => guesser.client.view["me"]?.task === "best");
    const best = guesser.client.view["me"].cards as { id: string; word: string; author: string }[];
    assert.equal(best.length, 2);
    assert.ok(best.every((c) => typeof c.word === "string"));
    await assert.rejects(a!.client.act("best", { card: best[1]!.id }), (e: { code: string }) => e.code === "not-guesser");
    await guesser.client.act("best", { card: best[1]!.id });
    await until(() => (party.screen.peek() as { best?: string }).best === best[1]!.id);
    // A thank-you: no points; the author's phone says so.
    assert.equal((party.screen.peek() as { bank: { chips: number } }).bank.chips, 6);
    const author = players.find((p) => p.client.you!["id"] === best[1]!.author)!;
    await until(() => (author.client.view["me"]?.parts ?? []).includes("best"));
  } finally {
    close();
  }
});

test("clues and guesses go through the party's moderate hook: refused, or replaced and checked as typed", async () => {
  const seen: string[] = [];
  const moderate = (text: string) => {
    seen.push(text);
    if (/rude/i.test(text)) return false;
    return text.replace(/heck/gi, "gosh");
  };
  const { party, g, players, close } = await setup(3, { bot: () => ({ silent: true }), moderate, timings: { write: 5000, decide: 5000 } });
  try {
    await players[0]!.client.act("start");
    await until(() => g.phase === "write");
    const guesser = (party.screen.peek() as { guesser: string }).guesser;
    const [a, b] = players.filter((p) => p.client.you!["id"] !== guesser);
    const gp = players.find((p) => p.client.you!["id"] === guesser)!;
    await assert.rejects(a!.client.act("clue", { text: "rude", bold: false, slot: 0 }), (e: { code: string }) => e.code === "refused");
    assert.deepEqual(await a!.client.act("clue", { text: "heck", bold: false, slot: 0 }), { text: "gosh", bold: false });
    for (const p of [a!, b!]) for (let slot = 0; slot < 2; slot++) if (p !== a || slot > 0) await p.client.act("clue", { text: ["orbit", "meadow", "thunder"][slot + (p === b ? 1 : 0)]!, bold: false, slot });
    await until(() => g.phase === "reveal", 10_000);
    const words = (party.screen.peek() as { cards: { word?: string }[] }).cards;
    assert.ok(words.every((c) => c.word === undefined));
    const card = (party.screen.peek() as { cards: { id: string }[] }).cards[0]!.id;
    await gp.client.act("pick", { card });
    // The draft on the TV, as moderated.
    gp.client.input({ draft: "heck" });
    await until(() => (party.screen.peek() as { draft: string }).draft === "gosh");
    gp.client.input({ draft: "rude" });
    await until(() => (party.screen.peek() as { draft: string }).draft === "");
    await assert.rejects(gp.client.act("guess", { text: "rude" }), (e: { code: string }) => e.code === "refused");
    await gp.client.act("guess", { text: "heck" });
    await until(() => g.phase === "verdict");
    const v = party.screen.peek() as { guess?: string; cards: { word: string }[] };
    assert.equal(v.guess, "gosh");
    assert.ok(v.cards.some((c) => c.word === "gosh") && !v.cards.some((c) => /heck|rude/.test(c.word)));
    assert.ok(seen.includes("rude") && seen.includes("heck"));
  } finally {
    close();
  }
});

test("all jinxed: straight to the verdict, the word is lost", async () => {
  const { g, players, screens, close } = await setup(4, { rounds: 1, bot: () => ({ clues: "category", bold: 0 }) });
  try {
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await end;
    const lost = of(screens, "verdict").filter((v) => v.result === "lost");
    assert.ok(lost.length >= 2, `lost rounds: ${lost.length}`);
    for (const v of lost) assert.equal(v.banked, 0);
    const rounds = new Set(lost.map((v) => v.round));
    for (const s of screens) if (s.phase === "reveal") assert.ok(!rounds.has(s.round), "no reveal when all are jinxed");
    const replay = of(screens, "replay").find((r) => r.result === "lost")!;
    assert.equal(replay.picking, false);
    assert.ok(replay.cards.every((c) => c.fate === "jinxed" && c.word));
  } finally {
    close();
  }
});

test("wrong guesses cost the bank 2 (never below 0), passes nothing", async () => {
  for (const style of ["wrong", "pass"] as const) {
    const { g, players, screens, close } = await setup(4, { rounds: 1, bot: () => ({ guess: style, clues: "random", bold: 0 }) });
    try {
      const end = new Promise((r) => g.once("end", r));
      await players[0]!.client.act("start");
      const bank = await end;
      const vs = of(screens, "verdict").filter((v) => v.result !== "lost");
      assert.ok(vs.length > 0);
      for (const v of vs) {
        assert.equal(v.result, style);
        assert.equal(v.banked, 0, "the bank is empty: nothing to lose");
        if (style === "wrong") assert.ok(typeof v.guess === "string");
      }
      assert.equal(bank, 0);
      assert.ok(of(screens, "replay").every((r) => !r.picking));
      const e = of(screens, "end").at(-1)!;
      assert.equal(e.title, "total jinx");
      assert.deepEqual(e.clues, []);
      assert.equal(e.record, undefined, "no record with an empty bank");
    } finally {
      close();
    }
  }
});

test("a wrong guess takes 2 out of a bank that has chips", async () => {
  const { g, screens, players, close } = await setup(4, { rounds: 1, bot: (i) => ({ guess: i === 3 ? "wrong" : "right", clues: "random", bold: 0 }) });
  try {
    const end = new Promise<number>((r) => g.once("end", r));
    await players[0]!.client.act("start");
    const bank = await end;
    const vs = of(screens, "verdict");
    const last = vs.at(-1)!;
    assert.equal(last.guesser, players[3]!.client.you!["id"]);
    const before = vs.slice(0, -1).reduce((s, v) => s + v.banked, 0);
    assert.ok(before > 2, `the bank before: ${before}`);
    if (last.result === "wrong") assert.equal(last.banked, -2);
    assert.equal(bank, before + last.banked);
    await until(() => players.every((b) => b.client.view["me"]?.task === "final"));
    assert.ok(players.every((b) => b.client.view["me"].bank === bank));
  } finally {
    close();
  }
});

test("timeouts: a silent guesser gets random cards, then a pass; a silent giver has no card", async () => {
  const { g, party, players, screens, close } = await setup(4, {
    rounds: 1,
    timings: { write: 400, decide: 200 },
    bot: (i) => (i === 1 ? { silent: true } : { clues: "random", bold: 0, guess: "right" }),
  });
  try {
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await end;
    const silentId = players[1]!.client.you!["id"];
    const mine = of(screens, "verdict").filter((v) => v.guesser === silentId);
    assert.equal(mine.length, 1);
    assert.equal(mine[0]!.result, "pass");
    const turned = mine[0]!.cards.filter((c) => c.turned !== undefined).length;
    assert.equal(turned, mine[0]!.cards.filter((c) => c.fate === "alive").length, "every card turned by the timer");
    for (const j of of(screens, "jinx")) assert.ok(j.cards.every((c) => c.author !== silentId), "no card for the silent giver");
    assert.equal(party.players.length, 4);
  } finally {
    close();
  }
});

test("a disconnected guesser: the timers go on", async () => {
  const { g, party, players, screens, close } = await setup(4, { rounds: 1, timings: { write: 300 } });
  try {
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await until(() => g.phase === "hotseat");
    // The next guesser's phone goes away (without leaving) for the rest of the game.
    const nextId = (party.screen.peek() as { guesser: string }).guesser;
    const order = players.map((p) => p.client.you!["id"]);
    const away = players[(order.indexOf(nextId) + 1) % 4]!;
    away.client.close();
    await end;
    const v = of(screens, "verdict").filter((x) => x.guesser === away.client.you!["id"]);
    assert.equal(v.length, 1);
    assert.ok(v[0]!.result === "pass" || v[0]!.result === "lost");
    assert.equal(party.players.length, 4);
  } finally {
    close();
  }
});

test("too few, non-VIP start, kick; a late joiner plays from the next round, rounds grow", async () => {
  const { party, g, players, screens, add, close } = await setup(2, { bot: () => ({ clues: "random" }) });
  try {
    await assert.rejects(players[0]!.client.act("start"), (e: { code: string }) => e.code === "too-few");
    const k = await add("Kick", 7);
    await until(() => players[0]!.client.view["me"]?.canStart === true);
    await players[0]!.client.act("kick", { id: k.client.you!["id"] });
    await until(() => party.players.length === 2);
    players.pop();
    await add("Cy", 2);
    await assert.rejects(players[1]!.client.act("start"), (e: { code: string }) => e.code === "not-vip");
    // Faces and colours: distinct colours, a drawn face.
    await players[1]!.client.act("face", { strokes: [[100, 100, 900, 900]] });
    await until(() => (party.screen.peek() as { people: { face: unknown }[] }).people.some((p) => "strokes" in (p.face as object)));
    const people = (party.screen.peek() as unknown as Extract<ScreenView, { phase: "lobby" }>).people;
    assert.equal(new Set(people.map((p) => p.color)).size, 3);
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await until(() => g.phase === "write");
    const late = await add("Late", 3);
    await until(() => late.client.view["me"]?.task === "wait");
    assert.equal(party.players.find((p) => p.name === "Late")!.waiting, true);
    await until(() => late.client.view["me"]?.task === "hotseat" || late.client.view["me"]?.task === "write", 15_000);
    await end;
    const vs = of(screens, "verdict");
    assert.equal(vs.length, 8, "6 rounds + 2 for the late joiner");
    assert.equal(vs.filter((v) => v.guesser === late.client.you!["id"]).length, 2);
    assert.equal(vs[0]!.guesser === late.client.you!["id"], false);
    assert.equal(of(screens, "write").find((w) => w.round === 1)!.each, 2);
    assert.ok(of(screens, "write").some((w) => w.each === 1), "one clue each with 4 players");
  } finally {
    close();
  }
});

test("the VIP's settings from the phone: lobby and end, checked as the host page offers them", async () => {
  const { party, g, players, close } = await setup(3, { rounds: 1 });
  try {
    const vip = players[0]!.client;
    const changed: unknown[] = [];
    g.on("settings", (s) => changed.push(s));
    assert.deepEqual(party.room.peek()["settings"], { rounds: 1, write: 2, difficulty: "normal", late: "wait" }, "the tests' 1.5 s write rounds to 2");
    assert.deepEqual(party.room.peek()["langs"], ["en", "de"]);
    await vip.act("settings", { rounds: 2, write: 30 });
    await vip.act("settings", { difficulty: "hard" });
    assert.equal(g.rounds, 2);
    assert.equal(g.timings.write, 30_000);
    assert.equal(g.difficulty, "hard");
    assert.deepEqual(changed, [
      { rounds: 2, write: 30, difficulty: "normal", late: "wait" },
      { rounds: 2, write: 30, difficulty: "hard", late: "wait" },
    ]);
    await until(() => JSON.stringify(players[1]!.client.view["room"]?.settings) === JSON.stringify({ rounds: 2, write: 30, difficulty: "hard", late: "wait" }));
    // The latecomers: the party's lateJoin, as the host page's field sets it.
    await vip.act("settings", { late: "closed" });
    assert.equal(party.lateJoin, "closed");
    await until(() => players[1]!.client.view["room"]?.settings?.late === "closed");
    // The language: the whole room's (every phone, the TV); the host page hears of it.
    await vip.act("settings", { lang: "de" });
    assert.equal(g.lang, "de");
    assert.equal((party.screen.peek() as { lang: string }).lang, "de");
    await until(() => players.every((b) => b.client.view["room"]?.lang === "de"));
    assert.equal(changed.length, 4, "a new language is a change of settings");
    // Refused: not the VIP (every setting), values the host page does not offer.
    for (const s of [{ rounds: 1 }, { write: 45 }, { difficulty: "easy" }, { late: "wait" }, { lang: "en" }]) {
      await assert.rejects(players[1]!.client.act("settings", s), (e: { code: string }) => e.code === "not-vip", JSON.stringify(s));
    }
    for (const bad of [{ rounds: 3 }, { rounds: "1" }, { write: 50 }, { write: 45_000 }, { difficulty: "insane" }, { lang: "fr" }, { lang: "EN" }, { lang: 1 }, { late: "open" }, { late: true }, { colour: "red" }, { rounds: 1, write: 7 }, null, [1], "auto"]) {
      await assert.rejects(vip.act("settings", bad), (e: { code: string }) => e.code === "bad-settings", JSON.stringify(bad));
    }
    assert.equal(g.rounds, 2, "a refused change changes nothing");
    assert.equal(g.lang, "de");
    assert.equal(party.lateJoin, "closed");
    await vip.act("settings", { lang: "en", late: "wait" });
    assert.equal(g.lang, "en");
    assert.equal(party.lateJoin, "wait");
    await vip.act("settings", { rounds: "auto", write: 30 });
    assert.equal(g.rounds, "auto");
    // Not during a game; again at the end.
    await vip.act("settings", { rounds: 1, write: 30, difficulty: "easy" });
    g.configure({ write: 300 });
    const end = new Promise((r) => g.once("end", r));
    await vip.act("start");
    await assert.rejects(vip.act("settings", { rounds: 2 }), (e: { code: string }) => e.code === "running");
    for (const s of [{ lang: "de" }, { late: "closed" }]) await assert.rejects(vip.act("settings", s), (e: { code: string }) => e.code === "running", JSON.stringify(s));
    await end;
    await vip.act("settings", { write: 90, late: "closed", lang: "de" });
    assert.equal(g.timings.write, 90_000);
    assert.deepEqual(party.room.peek()["settings"], { rounds: 1, write: 90, difficulty: "easy", late: "closed" });
    assert.equal(party.room.peek()["lang"], "de");
  } finally {
    close();
  }
});

test("the VIP cannot pick a language without words (the host page greys it out)", async () => {
  const { party, g, players, close } = await setup(3, { words: ["en"] });
  try {
    assert.deepEqual(party.room.peek()["langs"], ["en"]);
    await assert.rejects(players[0]!.client.act("settings", { lang: "de" }), (e: { code: string }) => e.code === "bad-settings");
    assert.equal(g.lang, "en");
  } finally {
    close();
  }
});

test("closed to latecomers (the host page's setting): nobody new joins during a game, anyone between games", async () => {
  const { party, g, players, add, close } = await setup(3, { rounds: 1, bot: () => ({ clues: "random" }) });
  try {
    party.lateJoin = "closed";
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await until(() => g.phase === "write");
    await assert.rejects(add("Late", 3), (e: { code: string }) => e.code === "in-progress");
    assert.equal(party.players.length, 3);
    await end;
    // Between games anyone may join.
    await add("After", 4);
    assert.equal(party.players.length, 4);
  } finally {
    close();
  }
});

test("a player who leaves: skipped as guesser, kept on the TV as left", async () => {
  const { party, g, players, screens, close } = await setup(4, { rounds: 1, bot: () => ({ clues: "random" }) });
  try {
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await until(() => of(screens, "bank").length >= 1);
    const gone = players[3]!;
    const goneId = gone.client.you!["id"];
    const guessedBefore = of(screens, "verdict").some((v) => v.guesser === goneId);
    gone.client.leave();
    await until(() => party.players.length === 3);
    const people = (party.screen.peek() as { people: { id: string; left?: boolean; connected: boolean }[] }).people;
    assert.deepEqual(
      people.filter((p) => p.left).map((p) => [p.id, p.connected]),
      [[goneId, false]],
    );
    await end;
    const vs = of(screens, "verdict");
    if (!guessedBefore) assert.ok(vs.every((v) => v.guesser !== goneId));
    assert.equal(vs.length, guessedBefore ? 4 : 3);
    const e = of(screens, "end").at(-1)!;
    assert.ok(e.people.some((p) => p.id === goneId && p.left));
    assert.ok(e.words.length === vs.length);
  } finally {
    close();
  }
});

test("too few left: the game ends at the next round's start, to the final screen; a phone only away still counts", async () => {
  const { party, g, players, screens, close } = await setup(4, { rounds: 1, bot: () => ({ clues: "random" }), timings: { write: 300 } });
  try {
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await until(() => g.phase === "write");
    // One phone goes away (it does not leave), another leaves: three still count (the away one too).
    const guesser = (party.screen.peek() as { guesser: string }).guesser;
    const givers = players.filter((b) => b.client.you!["id"] !== guesser);
    givers[0]!.client.close();
    givers[1]!.client.leave();
    await until(() => party.players.length === 3);
    await until(() => of(screens, "hotseat").length >= 2, 15_000);
    // One more leaves: 2 left, fewer than minPlayers (3); the round being played ends, no other starts.
    givers[2]!.client.leave();
    await until(() => party.players.length === 2);
    const rounds = of(screens, "hotseat").length;
    await end;
    assert.equal(g.phase, "end");
    assert.equal(of(screens, "hotseat").length, rounds, "no round after the one being played");
    assert.ok(of(screens, "end").length > 0, "the final screen");
    const guesserBot = players.find((b) => b.client.you!["id"] === guesser)!;
    await until(() => guesserBot.client.view["me"]?.task === "final");
  } finally {
    close();
  }
});

test("close() mid-round: the lobby at once, nothing written after, no final screen; a fresh game after", async () => {
  const { party, g, players, screens, close } = await setup(4, { rounds: 1, timings: { write: 200, decide: 2000 }, tvDelay: 50 });
  try {
    let ended = 0;
    g.on("end", () => ended++);
    await players[0]!.client.act("start");
    await until(() => g.phase === "reveal");
    g.close();
    assert.equal(g.running, false);
    assert.equal(g.phase, "lobby");
    assert.equal(party.inProgress, false);
    assert.equal((party.screen.peek() as { phase: string }).phase, "lobby");
    assert.equal((party.room.peek() as { phase: string }).phase, "lobby");
    for (const p of party.players) assert.equal((p.state.peek() as { task: string }).task, "lobby");
    const screen = JSON.stringify(party.screen.peek());
    const room = JSON.stringify(party.room.peek());
    const states = JSON.stringify(party.players.map((p) => p.state.peek()));
    // Longer than every timer of the round (the TV's lag, the flip, the decision).
    await new Promise((r) => setTimeout(r, 2500));
    assert.equal(JSON.stringify(party.screen.peek()), screen);
    assert.equal(JSON.stringify(party.room.peek()), room);
    assert.equal(JSON.stringify(party.players.map((p) => p.state.peek())), states);
    assert.equal(ended, 0);
    assert.equal(of(screens, "end").length, 0, "no final screen");
    await until(() => players.every((b) => b.client.view["me"]?.task === "lobby"));
    assert.equal(players[0]!.client.view["me"]?.canStart, true);
    // The VIP starts a fresh game.
    const end = new Promise<number>((r) => g.once("end", r));
    const before = of(screens, "verdict").length;
    await players[0]!.client.act("start");
    await end;
    const verdicts = of(screens, "verdict").slice(before);
    assert.equal(verdicts.length, 4);
    assert.equal(verdicts[0]!.round, 1);
    assert.equal(verdicts[0]!.bank.chips, verdicts[0]!.banked, "a fresh bank");
  } finally {
    close();
  }
});

test("a closed bot never acts", async () => {
  const { party, g, players, close } = await setup(3, { rounds: 1, bot: (i) => ({ think: () => (i === 0 ? 5 : 300) }) });
  try {
    await players[0]!.client.act("start");
    await until(() => g.phase === "write");
    // A giver's clue is planned (300 ms): closed before, it never comes.
    const givers = (party.screen.peek() as { givers: string[] }).givers;
    const bea = players.find((b) => b !== players[0] && givers.includes(b.client.you!["id"]))!;
    const id = bea.client.you!["id"];
    bea.close();
    await new Promise((r) => setTimeout(r, 600));
    const w = party.screen.peek() as { sentBy?: Record<string, number> };
    assert.equal(w.sentBy?.[id] ?? 0, 0);
    assert.deepEqual(bea.errors, []);
  } finally {
    close();
  }
});

test("the guesser leaves mid-round: the round is dropped", async () => {
  const { party, g, players, screens, close } = await setup(4, { rounds: 1, bot: (i) => (i === 0 ? { guess: "silent" } : { clues: "random" }), timings: { decide: 2000 } });
  try {
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await until(() => g.phase === "reveal");
    const guesserId = (party.screen.peek() as { guesser: string }).guesser;
    assert.equal(guesserId, players[0]!.client.you!["id"]);
    players[0]!.client.leave();
    await end;
    const vs = of(screens, "verdict");
    assert.equal(vs.length, 3);
    assert.ok(vs.every((v) => v.guesser !== guesserId));
    assert.equal(vs[0]!.round, 1, "the next round counts as round 1");
  } finally {
    close();
  }
});

test("no spoilers on phones: fate after the TV's slams, the result after the envelope", async () => {
  const { g, players, screens, close } = await setup(4, {
    rounds: 1,
    bot: () => ({ clues: "random" }),
    timings: { jinxBase: 1700, jinxGroup: 0, verdict: 700, resultAfter: 500, fateBefore: 1500 },
  });
  try {
    const giver = players[1]!; // Ada guesses first
    const tasks: { task: string; at: number }[] = [];
    giver.client.on("view", (v) => {
      const t = v["me"]?.task;
      if (t && tasks.at(-1)?.task !== t) tasks.push({ task: t, at: Date.now() });
    });
    await players[0]!.client.act("start");
    const first = of(screens, "hotseat")[0];
    await until(() => tasks.some((t) => t.task === "result") || g.phase === "replay", 10_000);
    await until(() => tasks.some((t) => t.task === "result"), 5000);
    assert.equal(first?.tally.total, 4, "the total from the first hot seat");
    const seq = tasks.map((t) => t.task);
    const at = (task: string) => tasks.find((t) => t.task === task)!.at;
    assert.ok(seq.indexOf("tv") < seq.indexOf("fate"), seq.join(" "));
    assert.ok(at("fate") - tasks[seq.indexOf("tv")]!.at >= 150, "fate only near the end of the jinx check");
    const last = seq.lastIndexOf("tv");
    assert.ok(last > seq.indexOf("fate") && last < seq.indexOf("result"), seq.join(" "));
    assert.ok(at("result") - tasks[last]!.at >= 400, "the result after the envelope");
  } finally {
    close();
  }
});

test("a turned card: the TV and the guesser's phone at once, the other phones when the TV shows its word (the flip, the TV's lag)", async () => {
  const tvDelay = 300;
  const flip = 400;
  const { party, g, players, close } = await setup(4, {
    rounds: 1,
    tvDelay,
    timings: { flip, decide: 5000 },
    bot: (i) => (i === 0 ? { guess: "silent" } : { clues: "random" }),
  });
  try {
    const [guesser, giver] = [players[0]!, players[1]!];
    type Me = { task?: string; cards?: { id: string; word?: string; turned?: number }[]; turning?: string; deadline?: number };
    const seen: { who: string; at: number; me: Me }[] = [];
    // A copy: the client updates its view in place.
    for (const b of [guesser, giver]) b.client.on("view", (v) => seen.push({ who: b.name, at: Date.now(), me: JSON.parse(JSON.stringify(v["me"] ?? {})) as Me }));
    await guesser.client.act("start");
    await until(() => g.phase === "reveal" && (guesser.client.view["me"] as Me)?.task === "guess", 15_000);
    const card = (guesser.client.view["me"] as Me).cards!.find((c) => !c.turned)!;
    assert.equal(card.word, undefined, "face down on the guesser's phone");
    const t0 = Date.now();
    await guesser.client.act("pick", { card: card.id });
    // The TV: at once.
    const tv = party.screen.peek() as { picked?: string; cards: { id: string; word?: string }[]; deadline: number; started: number };
    assert.equal(tv.picked, card.id);
    assert.ok(tv.cards.find((c) => c.id === card.id)?.word, "the TV has the word to show");
    assert.equal(tv.deadline - tv.started, 5000, "the TV's dial: the whole decision");
    // The guesser's phone: the card turned with its word at once, marked turning until the TV shows it.
    const mine = (guesser.client.view["me"] as Me);
    assert.equal(mine.turning, card.id, "turning at once");
    assert.ok(mine.cards?.find((c) => c.id === card.id)?.word, "the guesser's word at once");
    assert.ok(Date.now() - t0 < flip, "at once");
    await until(() => !!(giver.client.view["me"] as Me).cards?.find((c) => c.id === card.id)?.turned, 3000);
    const first = (who: string) => seen.find((s) => s.who === who && s.at >= t0 && s.me?.cards?.find((c) => c.id === card.id)?.turned)!;
    const s = first(giver.name);
    assert.ok(s.at - t0 >= flip + tvDelay - 30, `the giver: the word after the flip and the TV's lag (${s.at - t0} ms)`);
    await until(() => (guesser.client.view["me"] as Me).turning === undefined, 3000);
    const mineSeen = seen.filter((x) => x.who === guesser.name && x.at >= t0);
    const from = mineSeen.findIndex((x) => x.me.turning === card.id);
    assert.ok(from >= 0 && mineSeen[from]!.at - t0 < flip, "turning at once");
    const done = mineSeen.slice(from).find((x) => x.me.task === "guess" && x.me.turning === undefined)!;
    assert.ok(done.at - t0 >= flip + tvDelay - 30, `the guesser's lock-in once the TV has the word (${done.at - t0} ms)`);
    const me = guesser.client.view["me"] as Me;
    assert.equal(me.turning, undefined);
    assert.ok(me.deadline! - party.now() > 5000 - 400, "the whole decision from when the word shows");
  } finally {
    close();
  }
});

test("a TV 250 ms behind: a whole game; every phone gets a phase when the TV shows it, never before", async () => {
  const tvDelay = 250;
  const { party, g, players, phases, close } = await setup(4, { rounds: 1, tvDelay });
  try {
    // When the host changed the TV to each phase, and when each phone's room got there.
    const tv = new Map<string, number>();
    const off = party.on("screen-view", (v) => {
      const sc = v["screen"] as { round?: number; phase?: string } | undefined;
      const key = `${String(sc?.round)}:${String(sc?.phase)}`;
      if (!tv.has(key)) tv.set(key, Date.now());
    });
    const early: string[] = [];
    let checked = 0;
    for (const b of players) {
      let last = "";
      b.client.on("view", (v) => {
        const key = `${String(v["room"]?.["round"])}:${String(v["room"]?.["phase"])}`;
        if (key === last) return;
        last = key;
        const at = tv.get(key);
        if (at === undefined || !g.running) return;
        checked++;
        if (Date.now() - at < tvDelay - 30) early.push(`${b.name}: ${key} ${Date.now() - at} ms after the TV`);
      });
    }
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await end;
    off();
    assert.equal(phases.filter((p) => p === "verdict").length, 4);
    assert.ok(checked > 10, `${checked} phases checked`);
    assert.deepEqual(early, []);
    assert.deepEqual(
      players.map((b) => b.errors),
      [[], [], [], []],
    );
  } finally {
    close();
  }
});

test("a German room: German words, the room and the TV say de, bots write German clues", async () => {
  const { party, g, players, screens, close } = await setup(4, { lang: "de", rounds: 1 });
  try {
    assert.equal(g.lang, "de");
    assert.deepEqual(g.langs.sort(), ["de", "en"]);
    assert.equal((party.screen.peek() as { lang: string }).lang, "de");
    await until(() => players.every((b) => b.client.view["room"]?.lang === "de"));
    const clues: string[] = [];
    const dealt: [string[], string][] = [];
    g.on("dealt", (used, lang) => dealt.push([used, lang]));
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await end;
    const german = new Set(WORDS_DE.map((w) => w.word));
    const vs = of(screens, "verdict");
    assert.equal(vs.length, 4);
    assert.ok(vs.every((v) => german.has(v.word)), "German words");
    assert.ok(screens.every((s) => s.lang === "de"));
    for (const r of of(screens, "replay")) for (const c of r.cards) if (c.word) clues.push(c.word);
    const allowed = new Set([...Object.values(CATEGORY_DE), ...FALLBACK.de]);
    assert.ok(clues.length > 0 && clues.every((c) => allowed.has(c)), clues.join(" "));
    assert.ok(dealt.length === 4 && dealt.every(([, l]) => l === "de"));
    assert.ok(vs.some((v) => v.result === "right"), "some right guesses");
    checkSecrecy(screens);
    assert.deepEqual(
      players.map((b) => b.errors),
      [[], [], [], []],
    );
  } finally {
    close();
  }
});

test("the language changes between games only; each language keeps its own dealt words", async () => {
  const enBefore = WORDS.slice(0, 3).map((w) => w.word);
  const deBefore = WORDS_DE.slice(0, 2).map((w) => w.word);
  const { party, g, players, screens, close } = await setup(3, { rounds: 1, dealt: { en: enBefore, de: deBefore }, bot: () => ({ clues: "random" }) });
  try {
    assert.equal(g.lang, "en");
    assert.deepEqual(g.dealt, enBefore);
    const used: Record<string, string[]> = {};
    g.on("dealt", (u, lang) => (used[lang] = u));
    g.configure({ lang: "de" });
    assert.equal(g.lang, "de");
    assert.deepEqual(g.dealt, deBefore);
    assert.equal((party.screen.peek() as { lang: string }).lang, "de");
    await until(() => players.every((b) => b.client.view["room"]?.lang === "de"));
    g.configure({ lang: "en" });
    await until(() => players.every((b) => b.client.view["room"]?.lang === "en"));
    assert.throws(() => g.configure({ lang: "xx" as "de" }), (e: { code: string }) => e.code === "bad-lang");
    // A game in English: not switchable while it runs.
    let end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await until(() => g.running);
    assert.throws(() => g.configure({ lang: "de" }), (e: { code: string }) => e.code === "running");
    await end;
    const english = of(screens, "verdict").map((v) => v.word);
    assert.ok(english.every((w) => WORDS.some((x) => x.word === w)));
    assert.ok(english.every((w) => !enBefore.includes(w)), "no English word dealt before");
    assert.deepEqual(used["en"]?.slice(0, 3), enBefore);
    assert.equal(used["de"], undefined);
    // At the end: German for the next game; the TV and the phones follow at once.
    g.configure({ lang: "de" });
    assert.equal((party.screen.peek() as { lang: string; phase: string }).lang, "de");
    await until(() => players.every((b) => b.client.view["room"]?.lang === "de"));
    end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("again");
    await end;
    const german = of(screens, "verdict").slice(english.length).map((v) => v.word);
    assert.equal(german.length, 3);
    assert.ok(german.every((w) => WORDS_DE.some((x) => x.word === w)));
    assert.ok(german.every((w) => !deBefore.includes(w)), "no German word dealt before");
    assert.deepEqual(used["de"], [...deBefore, ...german]);
    assert.ok(of(screens, "end").at(-1)!.lang === "de");
  } finally {
    close();
  }
});

test("a German refusal: the reason in the code, the matcher's message", async () => {
  const { party, g, players, close } = await setup(3, { lang: "de", rounds: 1, bot: () => ({ silent: true }) });
  try {
    await players[0]!.client.act("start");
    await until(() => g.phase === "write");
    const guesserId = (party.screen.peek() as { guesser: string }).guesser;
    const a = players.find((p) => p.client.you!["id"] !== guesserId)!;
    await assert.rejects(a.client.act("clue", { text: g.secret!, bold: false, slot: 0 }), (e: { code: string; message: string }) => e.code === "too-close:same word" && e.message.length > 0);
  } finally {
    close();
  }
});
