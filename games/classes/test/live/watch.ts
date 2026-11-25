/**
 * A live check of Classes' TV page against the real game (not part of
 * `npm test`): `tvpipe game play` serves the bundle (`dist/`), a headless
 * Chrome plays the window (the launcher, then the host page), bots join
 * and play a short game, and the TV (the watch link at 1280×720, muted)
 * is photographed at every new phase, stage and column, with the layout
 * checks of test/live/layout.ts.
 *
 *   npm run build && node test/live/watch.ts [--bots N] [--lang en|de] [--columns 6|8|10] [--rounds N] [--out DIR]
 *
 * Every player is a bot (no phone here): `--bots 2` is the smallest
 * game. A game that ends before a round was written is a problem.
 *
 * Bots look things up in Wikipedia now and then (the real one: needs the
 * internet). Pictures into /tmp/classes-watch (`NN-phase-….png`). Needs
 * Chrome and tvpipe built (TVPIPE_BINARY, else target/release, else
 * target/debug).
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { Browser } from "./browser.ts";
import { CHECK } from "./layout.ts";
import { tie } from "./tie.ts";

const { values: args } = parseArgs({
  options: {
    bots: { type: "string", default: "6" },
    lang: { type: "string", default: "de" },
    columns: { type: "string", default: "8" },
    rounds: { type: "string", default: "3" },
    out: { type: "string", default: "/tmp/classes-watch" },
  },
});

const here = new URL("../../", import.meta.url);
const repo = new URL("../../", here);
const exe = process.platform === "win32" ? "tvpipe.exe" : "tvpipe";
const binary = process.env["TVPIPE_BINARY"] ?? ["release", "debug"].map((p) => fileURLToPath(new URL(`target/${p}/${exe}`, repo))).find((p) => existsSync(p));
if (!binary) throw new Error("build tvpipe first (cargo build --release -p tvpipe-cli)");
const out = args.out;
mkdirSync(out, { recursive: true });
const t0 = Date.now();
const log = (m: string) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)} ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const proc = tie(spawn(binary, ["game", "play", fileURLToPath(here), "--window", "none", "--no-tunnel"], { stdio: ["ignore", "pipe", "pipe"] }));
const exited = new Promise<number | null>((r) => proc.on("exit", (c) => r(c)));
const tvpipeLog: string[] = [];
createInterface({ input: proc.stderr! }).on("line", (l) => {
  tvpipeLog.push(l);
  if (/ (WARN|ERROR) /.test(l)) log(`tvpipe: ${l}`);
});
const start = await new Promise<string>((resolve, reject) => {
  createInterface({ input: proc.stdout! }).once("line", resolve);
  exited.then(() => reject(new Error(`tvpipe exited:\n${tvpipeLog.join("\n")}`)));
});

const browser = await Browser.launch();
const problems: string[] = [];
const seen = new Set<string>();
try {
  const win = await browser.open(start, { width: 1200, height: 860 });
  await win.until(`document.querySelectorAll("#devices .device").length > 0`, 20_000);
  const names = await win.eval<string[]>(`[...document.querySelectorAll("#devices .device")].map((d) => d.dataset.name)`);
  // "A browser tab on this computer" (older launchers: `browser`).
  const pick = names.find((x) => x === "browser") ?? names.find((x) => /^local:|tab|this/.test(x ?? "")) ?? "";
  if (!pick) throw new Error(`no browser tab in the launcher: ${names.join(", ")}`);
  await win.eval(`document.querySelector('#devices .device[data-name="${pick}"]').click(); true`);
  await win.until(`!document.getElementById("start").disabled`);
  await win.eval(`document.getElementById("start").click(); true`);
  await win.until(`location.pathname.endsWith("/host/index.html") && !!globalThis.classes`, 20_000);
  log("the host page runs the game");
  const timings = { letterMax: 5000, letterShown: 1800, board: 3000, write: 16_000, stopLeft: 6000, bell: 2500, vote: 7000, votePer: 600, voteMax: 14_000, voteEmpty: 2500, wikiMin: 8000, wikiMaxAdd: 16_000, report: 6000 };
  await win.eval(`(() => { classes.game.configure({ lang: ${JSON.stringify(args.lang)}, rounds: ${Number(args.rounds)}, columns: ${Number(args.columns)}, timings: ${JSON.stringify(timings)} }); return true; })()`);
  const links = await win.eval<{ watch: string }>(`({ watch: classes.party.links.watch })`);
  const tv = await browser.open(`${links.watch}&mute=1`, { width: 1280, height: 720 });
  await tv.until(`!!document.getElementById("room")`, 20_000);
  await win.eval(`classes.addBots(${Number(args.bots)}, { think: 1200, wiki: 0.25 }).then(() => true)`);
  log(`${args.bots} bots joined`);
  await sleep(1500);
  const shoot = async (i: number, key: string) => {
    const file = `${out}/${String(i).padStart(2, "0")}-${key.replace(/[^\w-]+/g, "-")}.png`;
    await tv.screenshot(file);
    const found = [...(await tv.eval<string[]>(CHECK(false)).catch((e: Error) => [`cannot check: ${e.message.slice(0, 200)}`])), ...tv.errors.splice(0)];
    for (const p of found) if (!problems.includes(`${key}: ${p}`)) problems.push(`${key}: ${p}`);
    log(`${found.length ? "✗" : "✓"} ${file}${found.map((p) => `\n         ${p}`).join("")}`);
  };
  let n = 0;
  await shoot(n++, "lobby");
  seen.add("lobby");
  await win.eval(`(void classes.game.play(), true)`);
  let finalAt = 0;
  const end = Date.now() + 15 * 60_000;
  while (Date.now() < end) {
    const s = await tv.eval<{ phase?: string; stage?: string; col?: number; round?: number; wiki?: string; stopBy?: string }>(
      `(() => { const s = window.__classesScreen ?? {}; return { phase: s.phase, stage: s.stage, col: s.col, round: s.round, wiki: s.wiki ? (s.wiki.loading ? "loading" : s.wiki.error ? "error" : "open") : "", stopBy: s.stopBy ?? "" }; })()`,
    );
    const key = [s.phase, s.round, s.phase === "grade" ? `${s.col}-${s.stage}` : "", s.wiki ? `wiki-${s.wiki}` : "", s.stopBy ? "stop" : ""].filter(Boolean).join("-");
    if (s.phase && !seen.has(key)) {
      seen.add(key);
      // Let the scene settle (chalk, the red pen), but not past short stages.
      await sleep(s.phase === "grade" && s.stage === "marked" ? 2600 : s.phase === "letter" ? 600 : 1400);
      await shoot(n++, key);
    }
    if (s.phase === "final") {
      finalAt ||= Date.now();
      if (Date.now() - finalAt > 4000 && !seen.has("final-desk")) {
        await sleep(30_000);
        seen.add("final-desk");
        await shoot(n++, "final-later");
      }
      if (Date.now() - finalAt > 50_000) break;
    }
    await sleep(250);
  }
  if (![...seen].some((k) => k.startsWith("write"))) problems.push(`the game ended without a round (${args.bots} bots: fewer than the game's minPlayers?)`);
} finally {
  browser.close();
  proc.kill();
}
log(problems.length ? `${problems.length} problems` : "no problems");
process.exit(problems.length ? 1 : 0);
