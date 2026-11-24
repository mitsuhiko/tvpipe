import assert from "node:assert/strict";
import { suite, test } from "node:test";

import type { RoomView } from "../game/views.ts";
import { estate as estateName, words } from "../game/words.ts";
import { game, ROUND, until } from "./game-kit.ts";

suite("lobby, actions, words", { concurrency: true }, () => {
  test("the lobby: start needs the VIP and 3 connected; the settings are the VIP's, in the lobby (late joining also during a game)", async () => {
    const { g, party, phone, room, close } = await game(0);
    const ann = await phone("Ann");
    const ben = await phone("Ben");
    try {
      await assert.rejects(ann.act("start"), { code: "too-few" });
      const cat = await phone("Cat");
      await assert.rejects(ben.act("start"), { code: "not-vip" });
      await ann.act("settings", { length: 300, rounds: 2, lang: "de" });
      assert.deepEqual(g.settings, { length: 300, rounds: 2, lang: "de", late: "wait" });
      await ann.act("settings", { late: "closed" });
      assert.equal(party.lateJoin, "closed");
      await ann.act("settings", { late: "wait" });
      await assert.rejects(ann.act("settings", { late: "open" }), { code: "bad-settings" });
      await until(() => ben.view["room"]?.settings?.length === 300 && ben.view["room"]?.lang === "de");
      await assert.rejects(ben.act("settings", { length: 150 }), { code: "not-vip" });
      await assert.rejects(ann.act("settings", { length: 100 }), { code: "bad-settings" });
      await assert.rejects(ann.act("settings", { rounds: 3 }), { code: "bad-settings" });
      await assert.rejects(ann.act("settings", { lang: "fr" }), { code: "bad-settings" });
      await assert.rejects(ann.act("settings", { level: "hard" }), { code: "bad-settings" });
      await assert.rejects(ann.act("skip"), { code: "not-now" });
      assert.equal(room().settings.rounds, 2);
      g.configure({ rounds: 1, timings: { heist: null, briefing: 5000 } });
      await ann.act("start");
      await assert.rejects(ann.act("start"), { code: "running" });
      await assert.rejects(ann.act("settings", { length: 150 }), { code: "running" });
      await assert.rejects(ann.act("settings", { rounds: 2 }), { code: "running" });
      await assert.rejects(ann.act("settings", { lang: "en" }), { code: "running" });
      await assert.rejects(ann.act("settings", { late: "closed", lang: "en" }), { code: "running" });
      // Late joining is live, as on the host page: the VIP only, known modes, every phone sees it.
      await assert.rejects(ben.act("settings", { late: "closed" }), { code: "not-vip" });
      await assert.rejects(ann.act("settings", { late: "open" }), { code: "bad-settings" });
      // The host page updates on the game's `settings` event.
      const told: unknown[] = [];
      g.on("settings", (x) => told.push(x));
      await ann.act("settings", { late: "closed" });
      assert.equal(party.lateJoin, "closed");
      assert.equal(g.settings.late, "closed");
      assert.equal(told.length, 1);
      await until(() => ben.view["room"]?.settings?.late === "closed");
      await ann.act("settings", { late: "wait" });
      assert.equal(party.lateJoin, "wait");
      await until(() => ben.view["room"]?.settings?.late === "wait");
      await until(() => g.phase === "briefing");
      assert.equal(room().length, 300);
      assert.equal(room().rounds, 3);
      // Not in the heist yet.
      await assert.rejects(ann.act("h", { a: "go", x: 1, y: 1 }), { code: "over" });
      // Late joining closed: refused during the game.
      party.lateJoin = "closed";
      await assert.rejects(phone("Dan"));
      cat.close();
    } finally {
      ann.close();
      ben.close();
      close();
    }
  });

  test("heist actions: refusals with their codes and English words; aim as input; resync gives a keyframe", async () => {
    const { g, phone, close } = await game(0, { timings: { briefing: 50, heist: 120, step: 50, frame: 100 } });
    const ann = await phone("Ann");
    const ben = await phone("Ben");
    const cat = await phone("Cat");
    const frames = new Map<string, { pub: { prev: number; seq: number } }[]>();
    for (const c of [ann, ben, cat]) c.on("msg", (type: string, data: any) => type === "f" && frames.set(c.you!["id"] as string, [...(frames.get(c.you!["id"] as string) ?? []), data]));
    try {
      await ann.act("start");
      await until(() => g.phase === "heist" && frames.size === 3);
      const byId = (id: string) => [ann, ben, cat].find((c) => c.you!["id"] === id)!;
      const thief = byId(g.thief!);
      const guard = [ann, ben, cat].find((c) => c !== thief)!;
      const gid = guard.you!["id"] as string;
      // The first frame carries a keyframe, the next ones deltas.
      await until(() => frames.get(gid)!.length >= 3);
      assert.equal(frames.get(gid)![0]!.pub.prev, -1);
      assert.notEqual(frames.get(gid)![2]!.pub.prev, -1);
      await assert.rejects(guard.act("h", { a: "take", item: 0 }), (e: { code: string; message: string }) => e.code === "role" && e.message === "Not for you");
      await assert.rejects(guard.act("h", { a: "warp" }), { code: "invalid" });
      await assert.rejects(guard.act("h", null), { code: "invalid" });
      await assert.rejects(thief.act("h", { a: "take", item: 0 }), (e: { code: string; message: string }) => e.code === "nothingHere" && e.message === words("en").refusals.nothingHere);
      assert.equal(await guard.act("h", { a: "go", x: 2, y: 2 }), null);
      // Aim: continuous input, never answered.
      guard.input({ a: "aim", angle: 45 });
      // Resync: the next frame has a keyframe.
      const before = frames.get(gid)!.length;
      await guard.act("resync");
      await until(() => frames.get(gid)!.slice(before).some((f) => f.pub.prev === -1));
      assert.equal(g.heist!.faults, 0);
    } finally {
      ann.close();
      ben.close();
      cat.close();
      close();
    }
  });

  test("skipping: the VIP skips the tape and the scores; others may not", async () => {
    const { g, players, phases, close } = await game(3, { timings: { tape: 60_000, scores: 60_000, heist: 5 } });
    try {
      await players[0]!.client.act("start");
      await until(() => g.phase === "tape");
      // Over: the car is public now; the haul only at the scores.
      const out = (g.party.room.peek() as unknown as RoomView).outcome!;
      assert.equal(out.car, g.estate!.car);
      assert.equal(out.haul, undefined);
      await assert.rejects(players[1]!.client.act("skip"), { code: "not-vip" });
      await players[0]!.client.act("skip");
      await until(() => g.phase === "scores");
      assert.ok(g.skip());
      await until(() => g.roundNo === 2);
      assert.deepEqual(phases.slice(0, 6), [...ROUND, "briefing"]);
    } finally {
      close();
    }
  });

  test("German: the room's language, the estate's name in German", async () => {
    const { g, players, room, close } = await game(3, { timings: { briefing: 2000 } });
    try {
      g.configure({ lang: "de" });
      await players[0]!.client.act("start");
      await until(() => g.phase === "briefing");
      const r = room();
      assert.equal(r.lang, "de");
      await until(() => players.every((b) => b.room.lang === "de"));
      const name = estateName("de", r.estate!).name;
      assert.ok(name.length > 0);
      assert.equal(estateName("de", r.estate!).name, words("de").estates[r.estate! % words("de").estates.length]!.name);
    } finally {
      close();
    }
  });
});
