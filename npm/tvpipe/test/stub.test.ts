/**
 * Flows that need a TV, against a stub binary that speaks the machine
 * interface: receiver choice without `to`, pairing with a PIN callback,
 * pairing on demand, protocol checks.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { discover, pair, PageSession, PlaySession, Session, play, share, testPattern, TvpipeError } from "../src/index.ts";
import { stubBinary } from "./helpers.ts";

const unix = process.platform !== "win32";

const device = (name: string, video = true) => ({
  name,
  addresses: ["192.0.2.1"],
  model: "AppleTV14,1",
  airplay: { port: 7000, mirroring: video, pin: true, paired: false, friendly_name: name },
});

/** A stub with `devices` on the network and an AirPlay TV that needs pairing. */
function stub(devices: unknown[]) {
  return stubBinary(`
    state.calls = (state.calls || []).concat([args]);
    save();
    const cmd = args[0] === "debug" ? "debug " + args[1] : args[0];
    if (cmd === "discover") {
      emit({ type: "devices", devices: ${JSON.stringify(devices)} });
      emit({ type: "end", reason: "done" });
      return finish(0);
    }
    if (cmd === "pair") {
      emit({ type: "pin-required", name: args[1], address: "192.0.2.1:7000" });
      const c = await nextCommand();
      if (c && c.type === "pin" && c.pin === "1234") {
        state.paired = true; save();
        emit({ type: "paired", name: args[1], model: "AppleTV14,1", file: "/tmp/credentials.txt" });
        emit({ type: "end", reason: "done" });
        return finish(0);
      }
      emit({ type: "error", kind: "auth", message: "wrong PIN" });
      return finish(1);
    }
    if (cmd === "play" || cmd === "debug pattern") {
      const to = args[args.indexOf("--to") + 1];
      if (!state.paired) {
        emit({ type: "receiver", name: to, protocol: "airplay", state: "failed", error: "needs pairing", code: "pairing-required" });
        emit({ type: "error", kind: "auth", code: "pairing-required", message: to + " requires pairing", device: to });
        return finish(1);
      }
      emit({ type: "receiver", name: to, protocol: "airplay", state: "connected" });
      emit({ type: "connected", receivers: [to] });
      emit({ type: "started", route: "builtin", video: { codec: "h264", width: 1280, height: 720, fps: 30 }, audio: [], latency_ms: 100 });
      const c = await nextCommand();
      emit({ type: "receiver", name: to, state: "stopped" });
      emit({ type: "end", reason: c ? "stopped" : "stopped", receivers: [] });
      return finish(0);
    }
    emit({ type: "error", kind: "usage", message: "stub: unknown command" });
    finish(1);
  `);
}

function calls(dir: string): string[][] {
  return (JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as { calls: string[][] }).calls;
}

test("discover maps devices", { skip: !unix }, async () => {
  const { binary } = stub([device("Living Room"), { name: "Speaker", addresses: [], cast: { video: false } }]);
  const found = await discover({ binary, timeout: 500 });
  assert.equal(found.length, 2);
  assert.deepEqual(
    { ...found[0], airplay: undefined },
    {
      name: "Living Room",
      model: "AppleTV14,1",
      addresses: ["192.0.2.1"],
      protocols: ["airplay"],
      video: true,
      paired: false,
      pin: true,
      passwordPin: false,
      homeOnly: false,
      airplay: undefined,
      raop: undefined,
      cast: undefined,
    },
  );
  assert.equal(found[0]?.airplay?.["friendlyName"], "Living Room");
  assert.deepEqual(found[1]?.protocols, ["cast"]);
  assert.equal(found[1]?.video, false);
});

test("without `to`: the only video receiver, else a clear error", { skip: !unix }, async () => {
  // One TV with video (and a speaker without): it is chosen.
  const one = stub([device("Den"), device("Speaker", false)]);
  const failed = await play("x.mp4", { binary: one.binary }).catch((e: unknown) => e);
  // It needs pairing and there is no onPin: the error names the device.
  assert.ok(failed instanceof TvpipeError);
  assert.equal(failed.code, "pairing-required");
  assert.equal(failed.device, "Den");
  assert.match(failed.message, /Den requires pairing/);
  assert.deepEqual(calls(one.dir).at(-1)?.slice(0, 3), ["play", "--to", "Den"]);

  const two = stub([device("Den"), device("Kitchen")]);
  await assert.rejects(testPattern({ binary: two.binary }), (e: unknown) => {
    assert.ok(e instanceof TvpipeError);
    assert.equal(e.code, "ambiguous-receiver");
    assert.match(e.message, /"Den", "Kitchen"/);
    assert.equal((e.details["devices"] as unknown[]).length, 2);
    return true;
  });

  const none = stub([]);
  await assert.rejects(
    testPattern({ binary: none.binary }),
    (e: unknown) => e instanceof TvpipeError && e.code === "no-receivers" && /browser/.test(e.message),
  );
});

test("pair with a PIN callback", { skip: !unix }, async () => {
  const { binary } = stub([]);
  const asked: string[] = [];
  const r = await pair("Den", {
    binary,
    onPin: async (req) => {
      asked.push(`${req.name} ${req.address}`);
      return "1234";
    },
  });
  assert.deepEqual(asked, ["Den 192.0.2.1:7000"]);
  assert.equal(r.name, "Den");
  assert.equal(r.file, "/tmp/credentials.txt");
  // A wrong PIN, a cancelled prompt, no callback.
  await assert.rejects(pair("Den", { binary: stub([]).binary, onPin: () => "0000" }), /wrong PIN/);
  await assert.rejects(
    pair("Den", {
      binary: stub([]).binary,
      onPin: () => {
        throw new Error("user cancelled");
      },
    }),
    /user cancelled/,
  );
  await assert.rejects(
    pair("Den", { binary: stub([]).binary }),
    (e: unknown) => e instanceof TvpipeError && e.code === "pin-missing",
  );
});

test("a session pairs on demand with onPin, then starts", { skip: !unix }, async () => {
  const { binary, dir } = stub([]);
  let asked = 0;
  const s = await testPattern({
    binary,
    to: "Den",
    onPin: () => {
      asked++;
      return "1234";
    },
  });
  assert.equal(asked, 1);
  assert.equal(s.receivers.get("Den")?.state, "connected");
  const end = await s.stop();
  assert.equal(end.reason, "stopped");
  assert.deepEqual(
    calls(dir).map((c) => (c[0] === "debug" ? `debug ${c[1]}` : c[0])),
    ["debug pattern", "pair", "debug pattern"],
  );
});

test("a binary speaking another protocol is refused", { skip: !unix }, async () => {
  const { binary } = stubBinary(`
    emit({ type: "hello", protocol: 99, version: "9.9.9", command: args[0] });
    await nextCommand();
  `);
  await assert.rejects(
    testPattern({ binary, to: "browser" }),
    (e: unknown) => e instanceof TvpipeError && e.code === "protocol-mismatch" && /9\.9\.9/.test(e.message),
  );
});

test("share with a public link resolves once the link works", { skip: !unix }, async () => {
  const { binary, dir } = stubBinary(`
    state.calls = (state.calls || []).concat([args]);
    save();
    emit({ type: "share-page", url: "http://127.0.0.1:1/?t=x" });
    emit({ type: "tunnel", page: "share", provider: "opentunnel", url: "https://r.example/?t=y" });
    await nextCommand();
    emit({ type: "end", reason: "stopped", receivers: [] });
    finish(0);
  `);
  const s = await share({ binary, to: "TV", tunnel: "opentunnel", yes: true });
  assert.equal(s.shareUrl, "http://127.0.0.1:1/?t=x");
  assert.equal(s.publicUrl, "https://r.example/?t=y");
  await s.stop();
  const args = (JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as { calls: string[][] }).calls[0]!;
  assert.ok(args.includes("--tunnel=opentunnel") && args.includes("--yes"), String(args));
  await assert.rejects(share("https://x.example", { binary, to: "TV", tunnel: true }), TvpipeError);
});

test("a shared page goes to another page in the same tab", { skip: !unix }, async () => {
  const { binary, dir } = stubBinary(`
    emit({ type: "receiver", name: "TV", protocol: "cast", state: "connected" });
    emit({ type: "connected", receivers: ["TV"] });
    emit({ type: "capture", surface: "browser", label: "page", width: 1280, height: 720, audio: false });
    emit({ type: "started", route: "browser", video: { codec: "h264", width: 1280, height: 720, fps: 30 }, audio: [], latency_ms: 100 });
    for (;;) {
      const c = await nextCommand();
      state.commands = (state.commands || []).concat([c]);
      save();
      if (!c || c.type === "stop") break;
    }
    emit({ type: "end", reason: "stopped", receivers: [] });
    finish(0);
  `);
  const s = await share("https://status.example/", { binary, to: "TV" });
  assert.ok(s instanceof PageSession);
  s.navigate("https://status.example/next#k=2");
  s.navigate(new URL("https://other.example/"));
  assert.throws(() => s.navigate(" "), (e: unknown) => e instanceof TvpipeError && e.code === "invalid-argument");
  await s.stop();
  assert.throws(() => s.navigate("https://late.example/"), (e: unknown) => e instanceof TvpipeError && e.code === "closed");
  const commands = (JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as { commands: unknown[] }).commands;
  assert.deepEqual(commands, [
    { type: "navigate", url: "https://status.example/next#k=2" },
    { type: "navigate", url: "https://other.example/" },
    { type: "stop" },
  ]);
  // Without a URL there is no page to change.
  assert.equal("navigate" in Session.prototype, false);
});

test("a played file seeks and pauses", { skip: !unix }, async (t) => {
  const { binary, dir } = stubBinary(`
    emit({ type: "receiver", name: "TV", protocol: "cast", state: "connected" });
    emit({ type: "connected", receivers: ["TV"] });
    emit({ type: "started", route: "passthrough", video: { codec: "h264", width: 1280, height: 720, fps: 30 }, audio: [], latency_ms: 300 });
    emit({ type: "playback", position_ms: 0, duration_ms: 60000, paused: false });
    for (;;) {
      const c = await nextCommand();
      state.commands = (state.commands || []).concat([c]);
      save();
      if (!c || c.type === "stop") break;
      if (c.type === "pause") emit({ type: "playback", position_ms: 1200, duration_ms: 60000, paused: true });
    }
    emit({ type: "end", reason: "stopped", receivers: [] });
    finish(0);
  `);
  const s = await play("movie.mp4", { binary, to: "TV" });
  t.after(async () => { await s.stop(); });
  assert.ok(s instanceof PlaySession);
  // play() resolves on started; playback may arrive in a later stdout read.
  if (!s.playback) await new Promise((r) => s.once("playback", r));
  assert.deepEqual(s.playback, { type: "playback", positionMs: 0, durationMs: 60000, paused: false });
  const paused = new Promise((r) => s.once("playback", r));
  s.seek(30_000);
  s.seekBy(-10_000.4);
  s.pause();
  assert.deepEqual(await paused, { type: "playback", positionMs: 1200, durationMs: 60000, paused: true });
  s.resume();
  assert.throws(() => s.seek(-1), (e: unknown) => e instanceof TvpipeError && e.code === "invalid-argument");
  assert.throws(() => s.seekBy(Number.NaN), (e: unknown) => e instanceof TvpipeError && e.code === "invalid-argument");
  await s.stop();
  assert.throws(() => s.pause(), (e: unknown) => e instanceof TvpipeError && e.code === "closed");
  const commands = (JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as { commands: unknown[] }).commands;
  assert.deepEqual(commands, [
    { type: "seek", position_ms: 30000 },
    { type: "seek", by_ms: -10000 },
    { type: "pause" },
    { type: "resume" },
    { type: "stop" },
  ]);
});
