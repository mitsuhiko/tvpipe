import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { Party } from "@tvpipe/party";
import { dropOuts, MemoryRelay } from "@tvpipe/party/testing";

import { Bot, bots } from "../game/bots.ts";
import { Crosstalk, type Script, type Timings } from "../game/game.ts";
import { boardColors, matcher, seeded, type Lang, type Team, type WordEntry } from "../game/rules.ts";

const DATA = (f: string) => readFileSync(new URL(`../data/${f}`, import.meta.url), "utf8");
const WORDS: Partial<Record<Lang, WordEntry[]>> = {};
const MATCH: Partial<Record<Lang, ReturnType<ReturnType<typeof matcher>["dictionary"]>>> = {};
for (const l of ["en", "de"] as const) {
  const m = matcher(l);
  WORDS[l] = m.parseWordList(DATA(m.files.words));
  MATCH[l] = m.dictionary(DATA(m.files.dict));
}

const fast: Timings = { intro: 10, clue: 1500, step: 600, flip: 10, roundEnd: 10 };

async function until(cond: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/**
 * A board in a known order: red, blue, neutral cards and the assassin,
 * the words named after them (r0…r7, b0…b7, n0…n7, x).
 */
const WORDS_OF = {
  red: ["rabbit", "garden", "lettuce", "fence", "shovel", "tractor", "barn", "scarecrow"],
  blue: ["beaver", "river", "log", "forest", "otter", "canoe", "bridge", "fish"],
  neutral: ["nettle", "cloud", "pencil", "guitar", "candle", "rocket", "mirror", "pillow"],
  assassin: ["volcano"],
};
const SCRIPT: Script = (() => {
  const next = { red: 0, blue: 0, neutral: 0, assassin: 0 };
  return boardColors().map((color) => ({ color, word: WORDS_OF[color][next[color]++]! }));
})();

interface Opts {
  timings?: Partial<Timings>;
  silent?: number;
  miss?: number;
  oracle?: boolean;
  manual?: { name: string; skip: string[] }[];
  script?: Script;
  lang?: Lang;
  tvDelay?: number;
}

async function game(n: number, opts: Opts = {}) {
  const relay = new MemoryRelay();
  const party = new Party({ grace: 50, maxPlayers: 12, tvDelay: opts.tvDelay }).listen(relay);
  const g = new Crosstalk(party, { words: WORDS, match: MATCH, timings: { ...fast, ...opts.timings }, rng: seeded(7), lang: opts.lang });
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
    miss: opts.miss ?? 0.15,
    oracle: opts.oracle === false ? undefined : (id: string) => g.key(id),
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
  const close = () => {
    g.close();
    for (const b of players) b.close();
    party.close();
  };
  return { relay, party, g, players, phases, screen, close };
}

/** Everything a view says, as text (to look for secrets in it). */
const text = (v: unknown) => JSON.stringify(v);

test("a whole game with 6 bots: someone wins, nothing leaks", async () => {
  const { party, g, players, phases, screen, close } = await game(6);
  try {
    // Secrets the TV and the other team must not see while the game runs.
    const leaks: string[] = [];
    const watch = () => {
      const st = g.state;
      if (!st || !g.running) return;
      const s = screen();
      for (const [i, c] of (s["board"] ?? []).entries()) if (c.color !== null && st.by[i]!.length === 0) leaks.push(`TV: colour of face-down ${c.word}`);
      for (const t of ["red", "blue"] as const) {
        const clue = st.teams[t].clue?.word;
        if (clue && text(s).includes(`"${clue}"`)) leaks.push(`TV: ${t}'s clue ${clue}`);
        for (const p of party.players) {
          const me = p.state.value as Record<string, any>;
          // The same word may be the team's own, now or in an earlier round.
          const own = me["team"] ? st.teams[me["team"] as Team].history.map((h) => h.word) : [];
          if (me["team"] !== t && me["team"] !== null && clue && !own.includes(clue) && text(me).includes(`"${clue}"`)) leaks.push(`${p.name}: the other team's clue`);
          if (me["key"] && me["task"] !== "spymaster") leaks.push(`${p.name}: the key`);
          if (me["task"] === "spymaster" && me["pad"]) leaks.push(`${p.name}: a spymaster sees the pad`);
          for (const line of st.teams[otherTeam(t)].pad) if (me["team"] === t && text(me).includes(line.text)) leaks.push(`${p.name}: the other team's pad`);
        }
      }
    };
    g.on("phase", watch);
    party.on("screen-view", watch);
    const end = new Promise<{ winner: Team | null; reason: string }>((r) => g.once("end", r));
    await players[0]!.client.act("start");
    const result = await end;
    assert.ok(["found", "assassin", "fewer-mistakes", "draw"].includes(result.reason), result.reason);
    assert.deepEqual(leaks, []);
    assert.deepEqual(
      players.map((b) => b.errors),
      players.map(() => []),
    );
    assert.equal(phases[0], "intro");
    assert.ok(phases.includes("clue") && phases.includes("guess"));
    assert.equal(phases.at(-1), "end");
    // The teams: three each, a spymaster each.
    const ids = party.players.map((p) => p.id);
    const red = ids.filter((id) => g.teamOf(id) === "red");
    assert.equal(red.length, 3);
    await until(() => players.every((b) => b.client.view["me"]?.task === "end"));
    const s = screen();
    assert.equal(s["phase"], "end");
    assert.equal(s["winner"], result.winner);
    assert.equal(s["reveal"]["key"].length, 25, "the key at the end");
    assert.ok(s["reveal"]["clues"]["red"].length >= 1 && s["reveal"]["clues"]["blue"].length >= 1, "every clue at the end");
    assert.ok(Array.isArray(s["reveal"]["pads"]["red"]));
    for (const t of ["red", "blue"] as const) assert.ok(s["next"][t], "next game's spymasters");
    assert.notEqual(s["next"]["red"], s["reveal"]["spymasters"]["red"], "the spymaster passes on");
  } finally {
    close();
  }
});

function otherTeam(t: Team): Team {
  return t === "red" ? "blue" : "red";
}

/** A game played by hand: four people, a known board. */
async function manualGame(opts: Opts = {}) {
  const ctx = await game(4, { ...opts, script: SCRIPT, manual: ["A", "B", "C", "D"].map((name) => ({ name, skip: ["spymaster", "operative"] })) });
  const { party, g, players } = ctx;
  await players[0]!.client.act("start");
  await until(() => g.phase === "clue");
  const by = (task: string, team: Team) => players.find((b) => b.client.view["me"]?.task === task && b.client.view["me"]?.team === team)!;
  await until(() => !!by("spymaster", "red") && !!by("operative", "blue"));
  const spy = { red: by("spymaster", "red"), blue: by("spymaster", "blue") };
  const op = { red: by("operative", "red"), blue: by("operative", "blue") };
  void party;
  return { ...ctx, spy, op };
}

const RED = (i: number) => SCRIPT.findIndex((c) => c.word === WORDS_OF.red[i]);
const BLUE = (i: number) => SCRIPT.findIndex((c) => c.word === WORDS_OF.blue[i]);
const NEUTRAL = (i: number) => SCRIPT.findIndex((c) => c.word === WORDS_OF.neutral[i]);
const ASSASSIN = SCRIPT.findIndex((c) => c.color === "assassin");

test("clues: checked against the board, secret to the team, one each", async () => {
  const { g, spy, op, screen, close } = await manualGame({ timings: { clue: 3000 } });
  try {
    await assert.rejects(spy.red.client.act("clue", { word: "rabbits", number: 2 }), (e: { code: string; message: string }) => e.code === "too-close" && /RABBIT/.test(e.message));
    await assert.rejects(spy.red.client.act("clue", { word: "warren", number: 0 }), { code: "bad-number" });
    await assert.rejects(op.red.client.act("clue", { word: "warren", number: 2 }), { code: "not-spymaster" });
    await spy.red.client.act("clue", { word: "warren", number: 2 });
    await assert.rejects(spy.red.client.act("clue", { word: "burrow", number: 2 }), { code: "already" });
    await until(() => op.red.client.view["me"]?.clue?.word === "warren");
    assert.equal(op.blue.client.view["me"].clue, null, "not on the other team's phones");
    assert.ok(!text(screen()).includes("warren"), "not on the TV");
    assert.equal(screen()["teams"]["red"]["status"], "ready");
    assert.equal(screen()["teams"]["blue"]["status"], "thinking");
    // Pins once the clue is in, before the steps (locks wait for them).
    await op.red.client.act("pin", { card: RED(0) });
    await assert.rejects(op.red.client.act("lock"), { code: "not-now" });
    await assert.rejects(op.blue.client.act("pin", { card: BLUE(0) }), { code: "not-now" }, "no clue yet");
    await spy.blue.client.act("clue", { word: "dam", number: 1 });
    await until(() => g.phase === "guess", 2000);
  } finally {
    close();
  }
});

test("steps: both teams lock, both cards turn together, a wrong card stops a team", async () => {
  const { g, spy, op, screen, close } = await manualGame({ timings: { step: 5000 } });
  try {
    await spy.red.client.act("clue", { word: "warren", number: 2 });
    await spy.blue.client.act("clue", { word: "dam", number: 1 });
    await until(() => g.phase === "guess");
    await assert.rejects(op.red.client.act("pin", { card: "pass" }), { code: "no-pass" }, "no pass before the first card");
    await op.red.client.act("pin", { card: RED(0) });
    await op.blue.client.act("pin", { card: NEUTRAL(0) });
    await assert.rejects(spy.red.client.act("pin", { card: RED(1) }), { code: "not-operative" });
    await op.red.client.act("lock");
    await until(() => screen()["teams"]["red"]["status"] === "locked");
    assert.equal(screen()["board"][RED(0)].color, null, "nothing turns before both locked");
    await op.blue.client.act("lock");
    await until(() => screen()["flip"]?.cards?.length === 2);
    const flip = screen()["flip"];
    assert.deepEqual(
      flip.cards.map((c: { team: Team; card: number; result: string }) => [c.team, c.card, c.result]),
      [
        ["red", RED(0), "right"],
        ["blue", NEUTRAL(0), "neutral"],
      ],
    );
    assert.equal(screen()["board"][RED(0)].color, "red");
    assert.equal(screen()["teams"]["blue"]["status"], "done");
    assert.equal(screen()["teams"]["blue"]["stop"], "neutral");
    assert.equal(screen()["teams"]["red"]["found"], 1);
    // Red alone now: its second card, then the extra one, then it is done.
    await until(() => g.state!.open && op.red.client.view["me"].locked === null && op.red.client.view["me"].canPass);
    await assert.rejects(op.blue.client.act("pin", { card: RED(1) }), { code: "not-now" }, "a team that stopped does not pin");
    await op.red.client.act("pin", { card: RED(1) });
    await op.red.client.act("lock");
    await until(() => screen()["teams"]["red"]["found"] === 2);
    await until(() => g.state!.open && op.red.client.view["me"].locked === null && screen()["roundStep"] === 3);
    await op.red.client.act("pin", { card: BLUE(0) });
    await op.red.client.act("lock");
    await until(() => screen()["teams"]["red"]["stop"] === "theirs" || g.phase === "clue");
    await until(() => g.phase === "clue");
    assert.equal(g.state!.teams.blue.wrong, 1);
    assert.equal(g.state!.teams.red.wrong, 1);
    assert.deepEqual(g.state!.teams.red.history[0]!.cards, [RED(0), RED(1), BLUE(0)]);
    assert.equal(screen()["teams"]["blue"]["found"], 1, "red's wrong card counts for blue");
  } finally {
    close();
  }
});

test("steps: the same card for both teams turns once; the extra card ends with 'used'", async () => {
  const { g, spy, op, screen, close } = await manualGame({ timings: { step: 5000 } });
  try {
    await spy.red.client.act("clue", { word: "warren", number: 1 });
    await spy.blue.client.act("clue", { word: "dam", number: 1 });
    await until(() => g.phase === "guess");
    for (const t of ["red", "blue"] as const) await op[t].client.act("pin", { card: RED(3) });
    for (const t of ["red", "blue"] as const) await op[t].client.act("lock");
    await until(() => screen()["flip"]?.cards?.length === 2);
    assert.deepEqual(screen()["board"][RED(3)].by, ["red", "blue"]);
    assert.equal(screen()["teams"]["red"]["found"], 1, "counted once");
    assert.equal(screen()["teams"]["blue"]["stop"], "theirs");
    await until(() => g.state!.open && op.red.client.view["me"].canPass && op.red.client.view["me"].locked === null && screen()["roundStep"] === 2);
    await op.red.client.act("pin", { card: RED(4) });
    await op.red.client.act("lock");
    await until(() => screen()["teams"]["red"]["stop"] === "used" || g.phase !== "guess");
    assert.equal(g.state!.teams.red.stop, "used", "a clue for 1 allows 2 cards");
  } finally {
    close();
  }
});

test("steps: time up locks a majority, else the team's round ends; a pass ends it", async () => {
  const { g, spy, op, screen, close } = await manualGame({ timings: { step: 300 } });
  try {
    await spy.red.client.act("clue", { word: "warren", number: 3 });
    await spy.blue.client.act("clue", { word: "dam", number: 3 });
    await until(() => g.phase === "guess");
    await op.red.client.act("pin", { card: RED(2) });
    // Blue pins nothing.
    await until(() => screen()["flip"] !== null && screen()["flip"] !== undefined);
    assert.deepEqual(
      screen()["flip"].cards.map((c: { card: number }) => c.card),
      [RED(2)],
      "red's majority locked at time up",
    );
    assert.equal(screen()["teams"]["blue"]["stop"], "timeout");
    await until(() => g.state!.open && op.red.client.view["me"].canPass && op.red.client.view["me"].locked === null);
    await op.red.client.act("pin", { card: "pass" });
    await op.red.client.act("lock");
    await until(() => g.phase !== "guess");
    assert.equal(g.state!.teams.red.stop, "pass");
  } finally {
    close();
  }
});

test("the assassin loses the game", async () => {
  const { g, spy, op, screen, close } = await manualGame({ timings: { step: 5000 } });
  try {
    const end = new Promise<{ winner: Team | null; reason: string }>((r) => g.once("end", r));
    await spy.red.client.act("clue", { word: "warren", number: 2 });
    await spy.blue.client.act("clue", { word: "dam", number: 1 });
    await until(() => g.phase === "guess");
    await op.red.client.act("pin", { card: ASSASSIN });
    await op.red.client.act("lock");
    await op.blue.client.act("pin", { card: BLUE(1) });
    await op.blue.client.act("lock");
    assert.deepEqual(await end, { winner: "blue", reason: "assassin" });
    await until(() => screen()["phase"] === "end");
    assert.equal(screen()["reveal"]["key"][ASSASSIN], "assassin");
    assert.deepEqual(screen()["reveal"]["clues"]["red"], [{ round: 1, word: "warren", number: 2, cards: [ASSASSIN] }]);
  } finally {
    close();
  }
});

test("the last cards: the first team with all eight wins; both in one step, fewer mistakes", async () => {
  const { g, spy, op, close } = await manualGame({ timings: { step: 5000 } });
  try {
    const end = new Promise<{ winner: Team | null; reason: string }>((r) => g.once("end", r));
    // Seven cards each turned already (as if by earlier rounds), one mistake for red.
    const st = g.state!;
    for (let i = 0; i < 7; i++) for (const c of [RED(i), BLUE(i)]) st.by[c] = [SCRIPT[c]!.color as Team];
    st.teams.red.wrong = 1;
    await spy.red.client.act("clue", { word: "warren", number: 1 });
    await spy.blue.client.act("clue", { word: "dam", number: 1 });
    await until(() => g.phase === "guess");
    await op.red.client.act("pin", { card: RED(7) });
    await op.blue.client.act("pin", { card: BLUE(7) });
    await op.red.client.act("lock");
    await op.blue.client.act("lock");
    assert.deepEqual(await end, { winner: "blue", reason: "fewer-mistakes" });
  } finally {
    close();
  }
});

test("the pad: lines for the team's operatives only, one editor a line", async () => {
  const relay = new MemoryRelay();
  const party = new Party({ grace: 50, maxPlayers: 12 }).listen(relay);
  const g = new Crosstalk(party, { words: WORDS, match: MATCH, timings: { ...fast, clue: 60_000 }, rng: seeded(3) });
  g.script = SCRIPT;
  g.open();
  const o = { url: "ws://party.test/_tvpipe/ws", WebSocket: relay.WebSocket, room: party.code, key: party.joinKey, think: () => 3, skip: ["spymaster", "operative"] };
  const ps = await bots(6, { ...o, names: ["A", "B", "C", "D", "E", "F"] });
  try {
    await ps[0]!.client.act("start");
    await until(() => g.phase === "clue");
    const of = (task: string, team: Team) => ps.filter((b) => b.client.view["me"]?.task === task && b.client.view["me"]?.team === team);
    await until(() => of("operative", "red").length === 2);
    const [a, b] = of("operative", "red");
    const blue = of("operative", "blue")[0]!;
    const spy = of("spymaster", "red")[0]!;
    await a!.client.act("pad", { op: "add", text: "  they whispered   SKY " });
    await until(() => b!.client.view["me"].pad?.length === 1);
    const line = b!.client.view["me"].pad[0];
    assert.equal(line.text, "they whispered SKY");
    assert.equal(line.name, a!.name);
    assert.equal(spy.client.view["me"].pad, null, "not the spymaster's");
    assert.equal(blue.client.view["me"].pad.length, 0, "not the other team's");
    await a!.client.act("pad", { op: "edit", id: line.id });
    await assert.rejects(b!.client.act("pad", { op: "save", id: line.id, text: "mine" }), { code: "busy" });
    await assert.rejects(b!.client.act("pad", { op: "delete", id: line.id }), { code: "busy" });
    await a!.client.act("pad", { op: "save", id: line.id, text: "they whispered MOON" });
    await until(() => b!.client.view["me"].pad[0].text === "they whispered MOON" && b!.client.view["me"].pad[0].edit === null);
    // Away: the line is free again.
    await b!.client.act("pad", { op: "edit", id: line.id });
    b!.client.drop();
    await until(() => g.state!.teams.red.pad[0]!.edit === null);
    await assert.rejects(spy.client.act("pad", { op: "add", text: "psst" }), { code: "not-operative" });
    await assert.rejects(a!.client.act("pad", { op: "add", text: "   " }), { code: "empty" });
    for (let i = 1; i < 24; i++) await a!.client.act("pad", { op: "add", text: `line ${i}` });
    await assert.rejects(a!.client.act("pad", { op: "add", text: "one more" }), { code: "pad-full" });
    await a!.client.act("pad", { op: "save", id: line.id, text: "" });
    await until(() => g.state!.teams.red.pad.length === 23);
  } finally {
    g.close();
    for (const p of ps) p.close();
    party.close();
  }
});

test("lobby: teams balance as people join, switching, the spymaster, shuffle", async () => {
  const { party, g, players, screen, close } = await game(5, { manual: ["A", "B", "C", "D", "E"].map((name) => ({ name, skip: ["lobby"] })) });
  try {
    await until(() => screen()["teams"]["red"]["players"].length + screen()["teams"]["blue"]["players"].length === 5);
    const sizes = [screen()["teams"]["red"]["players"].length, screen()["teams"]["blue"]["players"].length].sort();
    assert.deepEqual(sizes, [2, 3]);
    for (const t of ["red", "blue"]) assert.ok(screen()["teams"][t]["spymaster"], "the first of a team is its spymaster");
    const e = players[4]!;
    const mine = g.teamOf(e.client.you!.id)!;
    await e.client.act("team", { team: otherTeam(mine) });
    assert.equal(g.teamOf(e.client.you!.id), otherTeam(mine));
    await e.client.act("spymaster");
    assert.ok(g.isSpymaster(e.client.you!.id));
    await assert.rejects(players[1]!.client.act("shuffle"), { code: "not-vip" });
    await players[0]!.client.act("shuffle");
    await until(() => Math.abs(screen()["teams"]["red"]["players"].length - screen()["teams"]["blue"]["players"].length) <= 1);
    // Four on one team: the start moves one over.
    for (const p of players.slice(0, 4)) await p.client.act("team", { team: "red" });
    await p0start(players[0]!, g);
    await until(() => g.phase === "clue");
    assert.equal(party.players.filter((p) => g.teamOf(p.id) === "blue").length, 2, "balanced at the start");
  } finally {
    close();
  }
});

test("the VIP's settings: every one the host page has, checked, none during a game", async () => {
  const { party, g, players, close } = await game(4, { manual: ["A", "B", "C", "D"].map((name) => ({ name, skip: ["lobby"] })) });
  try {
    const vip = players[0]!.client;
    const room = (b: Bot) => b.client.view!["room"] as Record<string, any>;
    await until(() => players.every((p) => room(p)?.["late"] === "wait"));
    assert.deepEqual(room(players[1]!)["langs"], ["en", "de"]);
    const told: unknown[] = [];
    g.on("settings", (s) => told.push(s));
    const all = { lang: "de", clueTime: 120, stepTime: 45, deal: "mixed", difficulty: "hard", late: "closed" };
    const bad = { lang: "fr", clueTime: 75, stepTime: "30", deal: "random", difficulty: 3, late: "open" };
    for (const [k, v] of Object.entries(all)) {
      await assert.rejects(players[1]!.client.act("settings", { [k]: v }), { code: "not-vip" }, k);
      await assert.rejects(vip.act("settings", { [k]: bad[k as keyof typeof bad] }), { code: "bad-settings" }, k);
    }
    await assert.rejects(vip.act("settings", { rounds: 3 }), { code: "bad-settings" });
    assert.equal(told.length, 0, "nothing changed");
    for (const [k, v] of Object.entries(all)) await vip.act("settings", { [k]: v });
    assert.equal(g.lang, "de");
    assert.equal(party.lateJoin, "closed");
    assert.deepEqual(g.settings, { clueTime: 120, stepTime: 45, deal: "mixed", difficulty: "hard", late: "closed" });
    // Every phone sees them (and follows the language); the host page was told each time.
    await until(() => players.every((p) => Object.entries(all).every(([k, v]) => room(p)[k] === v)));
    assert.equal(told.length, Object.keys(all).length);
    // The host page's latecomers field (party.lateJoin, then configure) reaches the phones too.
    party.lateJoin = "wait";
    g.configure({ late: "wait" });
    await until(() => room(players[1]!)["late"] === "wait");
    await p0start(players[0]!, g);
    await assert.rejects(vip.act("settings", { late: "closed" }), { code: "running" });
    await assert.rejects(vip.act("settings", { lang: "en" }), { code: "running" });
    assert.equal(party.lateJoin, "wait");
  } finally {
    close();
  }
});

async function p0start(b: Bot, g: Crosstalk) {
  await b.client.act("start");
  await until(() => g.running);
}

test("too few: a team without two players at a round's start ends the game", async () => {
  const { party, g, players, close } = await game(4, { silent: 4, timings: { clue: 100 } });
  try {
    const end = new Promise<{ winner: Team | null; reason: string }>((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await until(() => g.phase === "clue");
    const red = party.players.find((p) => g.teamOf(p.id) === "red" && !p.vip)!;
    party.kick(red);
    assert.deepEqual(await end, { winner: null, reason: "too-few" });
  } finally {
    close();
  }
});

test("a spymaster who leaves: the next of the team takes over and sees the key", async () => {
  const { party, g, players, close } = await game(6, { manual: ["A", "B", "C", "D", "E", "F"].map((name) => ({ name, skip: ["spymaster", "operative"] })), timings: { clue: 60_000 } });
  try {
    await players[0]!.client.act("start");
    await until(() => g.phase === "clue");
    const spy = party.players.find((p) => g.isSpymaster(p.id) && !p.vip)!;
    const team = g.teamOf(spy.id)!;
    party.kick(spy);
    await until(() => players.some((b) => b.client.view["me"]?.task === "spymaster" && b.client.view["me"]?.team === team && b.client.view["me"]?.key?.length === 25));
  } finally {
    close();
  }
});

test("close(): back to the lobby at once, nothing of the game writes after", async () => {
  const { g, players, screen, close } = await game(4);
  try {
    await players[0]!.client.act("start");
    await until(() => g.phase === "guess");
    g.close();
    assert.equal(g.running, false);
    assert.equal(screen()["phase"], "lobby");
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(screen()["phase"], "lobby");
    assert.equal(screen()["board"], null);
    await until(() => players.every((b) => b.client.view["me"]?.task === "lobby"));
  } finally {
    close();
  }
});

test("phones that drop out and come back: the game goes on and ends with everyone", async () => {
  const relay = new MemoryRelay();
  const party = new Party({ grace: 50, maxPlayers: 12 }).listen(relay);
  const g = new Crosstalk(party, { words: WORDS, match: MATCH, timings: { ...fast, clue: 400, step: 300 }, rng: seeded(9) });
  g.open();
  const o = { url: "ws://party.test/_tvpipe/ws", WebSocket: relay.WebSocket, room: party.code, key: party.joinKey, think: () => 3, oracle: (id: string) => g.key(id), miss: 0.1 };
  const ps = await bots(6, o);
  try {
    const drops = dropOuts(
      ps.map((b) => b.client),
      { every: 120, rng: seeded(4) },
    );
    const end = new Promise((r) => g.once("end", r));
    await ps[0]!.client.act("start");
    await end;
    await drops.stop(3000);
    assert.equal(party.players.length, 6, "everyone is still in");
    await until(() => ps.every((b) => b.client.view["me"]?.task === "end"));
  } finally {
    g.close();
    for (const p of ps) p.close();
    party.close();
  }
});

test("a late joiner waits for the next round, then plays in the smaller team", async () => {
  const { relay, party, g, players, close } = await game(5, { timings: { clue: 300, step: 200 } });
  try {
    await players[0]!.client.act("start");
    await until(() => g.phase === "clue");
    const late = new Bot({ url: "ws://party.test/_tvpipe/ws", WebSocket: relay.WebSocket, room: party.code, key: party.joinKey, name: "Late", silent: true });
    await late.join();
    await until(() => late.client.view["me"]?.task === "wait");
    assert.equal(g.teamOf(late.client.you!.id), undefined, "no team yet");
    await until(() => (g.state?.round ?? 0) >= 2 || !g.running, 15_000);
    if (g.running) {
      await until(() => late.client.view["me"]?.task === "operative");
      const t = g.teamOf(late.client.you!.id)!;
      assert.equal(party.players.filter((p) => g.teamOf(p.id) === t).length, 3, "the smaller team");
    }
    late.close();
  } finally {
    close();
  }
});

test("German: a game with German words", async () => {
  const { g, players, screen, close } = await game(4, { lang: "de" });
  try {
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await until(() => g.phase === "clue");
    const words = new Set(WORDS.de!.map((w) => w.word));
    assert.ok(screen()["board"].every((c: { word: string }) => words.has(c.word)));
    await end;
    assert.deepEqual(
      players.map((b) => b.errors),
      players.map(() => []),
    );
  } finally {
    close();
  }
});

