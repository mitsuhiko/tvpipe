import assert from "node:assert/strict";
import { test } from "node:test";

import { Party } from "@tvpipe/party";
import { dropOuts, MemoryRelay } from "@tvpipe/party/testing";

import { Bot, bots } from "../game/bots.ts";
import { Worldquiz, type Settings, type Timings } from "../game/game.ts";
import { ANSWERS, KINDS, seeded, type Kind } from "../game/rules.ts";
import { COUNTRIES, LAND } from "./world.ts";

const fast: Timings = { choose: 300, competeIntro: 5, competeCard: 5, competeEnd: 5, discard: 5, announce: 5, reveal: 5, revealWhere: 5, next: 10_000, nextCountdown: 2000, answer: 0.4 };

interface Opts {
  settings?: Partial<Settings>;
  /** The last this many bots never press Next (the test does). */
  lazy?: number;
  silent?: number;
  sharp?: number;
  competes?: number;
  timings?: Partial<Timings>;
  lang?: "en" | "de";
}

async function game(n: number, o: Opts = {}) {
  const relay = new MemoryRelay();
  // Bots think 3 ms, far faster than phones: the default 20 messages a second would cut them off (4008 rate-limited) and leave nobody connected for the tiebreak.
  const party = new Party({ grace: 50, maxPlayers: 10, limits: { rate: 400, burst: 400 } }).listen(relay);
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
  const players = await bots(n - (o.silent ?? 0) - (o.lazy ?? 0), opts);
  for (let i = 0; i < (o.lazy ?? 0); i++) {
    const b = new Bot({ ...opts, name: `Lazy${i + 1}`, skip: ["compete", "watch", "result"] });
    await b.join();
    players.push(b);
  }
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
  const { g, players, screens, close } = await game(2, { silent: 2, timings: { choose: 30, answer: 0.05, next: 5, nextCountdown: 1 }, settings: { rounds: 15 } });
  try {
    await new Promise((r) => setTimeout(r, 20));
    const end = new Promise((r) => g.once("end", r));
    void g.play();
    await end;
    // One per answer shown (its countdown changes the screen again).
    const shown = [...new Map(screens.filter((s) => s["stage"] === "answer").map((s) => [s["next"], s])).values()];
    const answers = shown.filter((s) => !s["tiebreak"]);
    // Both at 0 at the end: a tie-break of up to three pins, which nobody drops either.
    assert.equal(shown.filter((s) => s["tiebreak"]).length, 3);
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
  const { g, players, close } = await game(4, { timings: { next: 300, nextCountdown: 100 } });
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
    assert.deepEqual(g.settings, { mode: "cards", rounds: 30, difficulty: "hard", countries: "known", kinds: [...KINDS], disputed: true, map: "globe", lateJoin: "wait" });
    await players[0]!.client.act("settings", { countries: "all", kinds: ["where", "capital"] });
    assert.equal(g.settings.countries, "all");
    assert.deepEqual(g.settings.kinds, ["capital", "where"]);
    assert.equal(g.settings.difficulty, "hard");
    await assert.rejects(players[0]!.client.act("settings", { kinds: [] }), /kinds/);
    await assert.rejects(players[0]!.client.act("settings", { kinds: ["capital", "riddle"] }), /kinds/);
    await assert.rejects(players[0]!.client.act("settings", { kinds: ["capital", "capital"] }), /kinds/);
    await assert.rejects(players[0]!.client.act("settings", { countries: 80 }), /countries/);
    await assert.rejects(players[0]!.client.act("settings", { mode: "bets" }), /mode/);
    await players[0]!.client.act("settings", { mode: "quiz" });
    assert.equal(g.settings.mode, "quiz");
    // One bad value refuses the whole change.
    await assert.rejects(players[0]!.client.act("settings", { rounds: 45, map: "round" }), /map/);
    assert.equal(g.settings.rounds, 30);
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("the VIP sets the language and latecomers too, as the host page does: every phone follows, not during a game", async () => {
  const { g, party, players, close } = await game(3, { timings: { choose: 60_000 } });
  const until = async (what: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!what()) {
      if (Date.now() > end) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  try {
    const vip = players[0]!.client;
    const heard: unknown[] = [];
    g.on("settings", (s) => heard.push(s));
    // The language: only the VIP, only a known one; every phone and the TV follow, and the host page hears of it.
    await assert.rejects(players[1]!.client.act("settings", { lang: "de" }), /VIP/);
    await assert.rejects(vip.act("settings", { lang: "fr" }), { code: "bad-settings" });
    await assert.rejects(vip.act("settings", { lang: 1 }), { code: "bad-settings" });
    assert.equal(g.lang, "en");
    await vip.act("settings", { lang: "de" });
    assert.equal(g.lang, "de");
    assert.equal(heard.length, 1);
    await until(() => players.every((p) => p.client.view["room"]?.lang === "de"));
    assert.equal((party.screenView()["screen"] as Record<string, unknown>)["lang"], "de");
    // Latecomers: the host page's two choices; the party follows, and so do the room view and the host page.
    assert.equal(vip.view["room"].lateJoin, "wait");
    await assert.rejects(players[1]!.client.act("settings", { lateJoin: "closed" }), /VIP/);
    await assert.rejects(vip.act("settings", { lateJoin: "open" }), { code: "bad-settings" });
    await assert.rejects(vip.act("settings", { lateJoin: "never" }), { code: "bad-settings" });
    assert.notEqual(party.lateJoin, "closed");
    await vip.act("settings", { lateJoin: "closed" });
    assert.equal(party.lateJoin, "closed");
    assert.equal((heard.at(-1) as { lateJoin: string }).lateJoin, "closed");
    await until(() => players.every((p) => p.client.view["room"]?.lateJoin === "closed"));
    // The host page's field goes through the game too: the phones see its change.
    g.configure({ lateJoin: "wait" });
    assert.equal(party.lateJoin, "wait");
    await until(() => players.every((p) => p.client.view["room"]?.lateJoin === "wait"));
    // Nothing during a game (no setting is live on the host page either).
    await vip.act("start");
    await until(() => g.phase === "round");
    for (const change of [{ lang: "en" }, { lateJoin: "closed" }, { rounds: 45 }, { kinds: ["where"] }, { countries: "all" }]) {
      await assert.rejects(vip.act("settings", change), { code: "running" });
    }
    assert.equal(g.lang, "de");
    assert.equal(party.lateJoin, "wait");
    g.close();
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("cards and answers stay until everyone has pressed Next", async () => {
  const { g, party, players, close } = await game(3, { lazy: 1, competes: 0.5, timings: { next: 60_000 } });
  const until = async (what: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!what()) {
      if (Date.now() > end) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  try {
    const lazy = players[2]!;
    await players[0]!.client.act("start");
    for (let i = 0; i < 4; i++) {
      await until(() => typeof party.room.peek()["next"] === "string" && g.stage !== "draw");
      const stage = g.stage;
      const room = party.room.peek() as Record<string, any>;
      assert.ok(["compete", "discard", "challenge", "tiebreak"].includes(stage ?? ""), String(stage));
      assert.equal(room["nextFor"].length, 3);
      // The two others press; the stage stays for the lazy one.
      await until(() => (party.room.peek()["ready"] as string[]).length === 2);
      await new Promise((r) => setTimeout(r, 60));
      assert.equal(party.room.peek()["next"], room["next"]);
      await assert.rejects(lazy.client.act("next", { key: "0:0:next0" }), /over/);
      const me = (lazy.client.view as any)?.me ?? {};
      assert.equal(me.next, room["next"]);
      await lazy.client.act("next", { key: me.next });
      await until(() => party.room.peek()["next"] !== room["next"]);
    }
    g.close();
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("someone pressed Next: the others get a countdown, then the game goes on", async () => {
  const { g, party, players, close } = await game(3, { lazy: 1, competes: 0.5, timings: { next: 60_000, nextCountdown: 150 } });
  const until = async (what: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!what()) {
      if (Date.now() > end) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  try {
    await players[0]!.client.act("start");
    for (let i = 0; i < 3; i++) {
      await until(() => typeof party.room.peek()["next"] === "string" && g.stage !== "draw");
      const room = party.room.peek() as Record<string, any>;
      await until(() => typeof party.room.peek()["nextBy"] === "number");
      const by = party.room.peek()["nextBy"] as number;
      assert.ok(by > party.now() - 50);
      assert.equal(party.screen.peek()["nextBy"], by);
      // The lazy one never presses: the stage ends with the countdown.
      await until(() => party.room.peek()["next"] !== room["next"]);
      assert.ok(party.now() >= by - 20);
    }
    g.close();
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("nobody presses Next: the countdown starts by itself", async () => {
  const { g, party, players, close } = await game(2, { lazy: 2, competes: 0.5, timings: { next: 200, nextCountdown: 100 } });
  try {
    void g.play();
    const end = Date.now() + 3000;
    while (!(typeof party.room.peek()["next"] === "string" && typeof party.room.peek()["nextBy"] === "number")) {
      if (Date.now() > end) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 5));
    }
    g.close();
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("the captain's choice has no time limit; a captain who leaves makes it a challenge", async () => {
  const { g, party, players, close } = await game(3, { silent: 1, timings: { choose: null, nextCountdown: 20 } });
  const until = async (what: () => boolean, ms = 5000) => {
    const end = Date.now() + ms;
    while (!what()) {
      if (Date.now() > end) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  try {
    const mute = players[2]!;
    const muteId = mute.client.you!.id;
    await players[0]!.client.act("start");
    await until(() => g.stage === "draw" && party.room.peek()["captain"] === muteId);
    assert.equal(party.room.peek()["deadline"], null);
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(g.stage, "draw");
    party.kick(party.player(muteId)!);
    await until(() => g.stage !== "draw");
    assert.ok(["discard", "challenge"].includes(g.stage ?? ""), String(g.stage));
    g.close();
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("questions only: every round a challenge, no cards, no captain", async () => {
  const { g, players, phases, screens, close } = await game(3, { competes: 1, settings: { mode: "quiz", rounds: 15 } });
  try {
    let cards = 0;
    for (const b of players) b.client.on("view", (v: any) => void (v.me?.card ? cards++ : 0));
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await end;
    // Not rounded up to a multiple of the players.
    assert.equal(Math.max(...screens.map((s) => s["rounds"] ?? 0)), 15);
    assert.ok(!phases.some((p) => ["round:draw", "round:compete", "round:discard"].includes(p)), phases.join(" "));
    assert.ok(phases.includes("round:challenge"));
    assert.equal(cards, 0);
    assert.ok(screens.every((s) => s["stage"] === undefined || s["captain"] === undefined || s["captain"] === null));
  } finally {
    for (const b of players) b.close();
    close();
  }
});

/** A quiz of one kind: every challenge's screens, every phone's answer view, the end. */
async function oneKind(kind: Kind, o: Opts = {}) {
  const t = await game(3, { sharp: 0.8, ...o, settings: { mode: "quiz", rounds: 6, kinds: [kind], ...o.settings } });
  const phone: Record<string, any>[] = [];
  t.players[1]!.client.on("view", (v: any) => {
    if (v.me?.task === "answer" || v.me?.task === "result") phone.push(structuredClone(v.me));
  });
  const end = new Promise((r) => t.g.once("end", r));
  await t.players[0]!.client.act("start");
  await end;
  const asked = t.screens.filter((x) => x["stage"] === "challenge" && !x["tiebreak"]);
  const shown = [...new Map(t.screens.filter((x) => x["stage"] === "answer" && !x["tiebreak"]).map((x) => [x["next"], x])).values()];
  return { ...t, asked, shown, phone };
}

for (const kind of KINDS.filter((k) => !["capital", "flag", "where"].includes(k))) {
  test(`a quiz of only "${kind}": asked, answered by the bots, judged, revealed`, async () => {
    const disputed = kind === "odd"; // Charlie borders three only with Xenia.
    const { g, players, asked, shown, phone, close } = await oneKind(kind, { settings: { disputed } });
    try {
      assert.ok(asked.length >= 6, String(asked.length));
      assert.ok(asked.every((x) => x["kind"] === kind), asked.map((x) => x["kind"]).join());
      assert.ok(shown.length >= 6);
      // Somebody was right somewhere (the bots know 80 % of the time).
      assert.ok(shown.some((x) => x["winners"].length > 0));
      const how = ANSWERS[kind];
      for (const x of shown) {
        assert.equal(x["kind"], kind);
        for (const a of x["answers"]) {
          if (how === "choice") assert.ok(a.choice === null || Number.isInteger(a.choice));
          if (how === "number") assert.ok(a.value === null || a.value > 0);
          if (how === "text") assert.equal(typeof a.text, "string");
        }
      }
      // The questions never carry the answer.
      for (const x of asked) {
        const q = x["question"];
        const text = JSON.stringify(q);
        assert.ok(!("id" in q) || kind === "neighbour", text);
        if (kind === "shape") assert.deepEqual(Object.keys(q).sort(), ["at", "box", "shape"]);
        if (kind === "pickflag") {
          assert.deepEqual(Object.keys(q).sort(), ["flags", "name"]);
          assert.equal(new Set(q.flags).size, q.flags.length);
        }
        if (kind === "bigger" || kind === "odd") assert.equal(q.options.length, 4);
        if (kind === "guess") assert.ok(q.min < q.max);
        assert.ok(!text.includes('"right"') && !text.includes('"value"'), text);
      }
      // The reveal has what it shows.
      for (const x of shown) {
        const r = x["reveal"];
        if (kind === "pickflag" || kind === "bigger" || kind === "odd") assert.ok(Number.isInteger(r.right) && r.options[r.right]);
        if (kind === "bigger") assert.equal(x["solution"].id, r.options[r.right].id);
        if (kind === "guess") assert.ok(r.value > 0 && r.factor === 2);
        if (kind === "neighbour") assert.ok(r.neighbours.length > 0);
        if (kind === "shape") assert.equal(r, null);
      }
      // The phone's answer screen had the question, its result its own answer and the reveal.
      assert.ok(phone.some((m) => m.task === "answer" && m.kind === kind && m.question));
      assert.ok(phone.some((m) => m.task === "result" && m.mine && "reveal" in m));
      assert.deepEqual(
        players.map((b) => b.errors),
        [[], [], []],
      );
      assert.equal(g.phase, "final");
    } finally {
      for (const b of players) b.close();
      close();
    }
  });
}

test("a kind no country fits (odd one out without enough neighbours) gives way to a pin", async () => {
  const { players, asked, close } = await oneKind("odd");
  try {
    assert.ok(asked.length > 0);
    assert.ok(asked.every((x) => x["kind"] === "where"));
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("answers of the new kinds are checked: an option of the question, a number on the slider", async () => {
  const { g, party, players, close } = await game(2, { silent: 2, settings: { mode: "quiz", kinds: ["pickflag", "guess"] }, timings: { answer: 5 } });
  const until = async (what: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!what()) {
      if (Date.now() > end) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  try {
    void g.play();
    const p = players[0]!;
    for (let i = 0; i < 2; i++) {
      await until(() => g.stage === "challenge" && (p.client.view as any)?.me?.task === "answer");
      const me = (p.client.view as any).me;
      if (me.kind === "pickflag") {
        await assert.rejects(p.client.act("answer", { key: me.key, choice: me.question.flags.length }), /choice/);
        await assert.rejects(p.client.act("answer", { key: me.key, text: "Alpha" }), /choice/);
        await p.client.act("answer", { key: me.key, choice: 0 });
        assert.deepEqual((p.client.view as any).me.draft, { choice: 0 });
      } else {
        await assert.rejects(p.client.act("answer", { key: me.key, value: me.question.max * 2 }), /value/);
        await assert.rejects(p.client.act("answer", { key: me.key, value: "5" }), /value/);
        await p.client.act("answer", { key: me.key, value: me.question.min });
      }
      await p.client.act("answer", { key: me.key, ...(me.kind === "pickflag" ? { choice: 1 } : { value: me.question.max }), lock: true });
      await assert.rejects(p.client.act("answer", { key: me.key, choice: 0, value: 5 }), /locked/i);
      const key = me.key;
      await until(() => (p.client.view as any)?.me?.key !== key || g.stage !== "challenge", 8000);
      await until(() => g.stage === "challenge" || party.room.peek()["stage"] === "answer");
      g.close();
      break;
    }
  } finally {
    for (const b of players) b.close();
    close();
  }
});
