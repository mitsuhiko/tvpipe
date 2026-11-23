/**
 * A live check of Snug on `tvpipe game play` (not part of `npm test`):
 * tvpipe serves the bundle (`dist/`); a headless Chrome plays the window
 * (the launcher, then the host page), the TV (the watch link at
 * 1280×720) and a phone (joining, turning and flipping a piece, dragging
 * pieces onto the shape with touches, taking one back, pointing and
 * pinging); bots join in the window and play the rest. A board is
 * solved, the next runs out of time. Screenshots of the TV and the phone
 * at each step, the phone at 390×844, 375×667, 320×568, 360×640 and
 * 430×932, with a layout check of each (nothing off the screen, no word
 * cut, tap targets, nothing under the TV's join badge).
 *
 *   npm run build && node test/live/play.ts [--bots N] [--lang en|de] [--level easy|normal|hard] [--out DIR] [--shots DIR]
 *
 * Needs Chrome and tvpipe built (TVPIPE_BINARY, else target/release, else target/debug).
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { Browser, type Tab } from "./browser.ts";
import { keep } from "./shots.ts";
import { tie } from "./tie.ts";

const { values: args } = parseArgs({
  options: {
    bots: { type: "string", default: "2" },
    lang: { type: "string", default: "en" },
    level: { type: "string", default: "normal" },
    out: { type: "string" },
    shots: { type: "string" },
  },
});

const here = new URL("../../", import.meta.url);
const repo = new URL("../../", here);
const exe = process.platform === "win32" ? "tvpipe.exe" : "tvpipe";
const binary = process.env["TVPIPE_BINARY"] ?? ["release", "debug"].map((p) => fileURLToPath(new URL(`target/${p}/${exe}`, repo))).find((p) => existsSync(p));
if (!binary) throw new Error("build tvpipe first (cargo build --release -p tvpipe-cli)");
const lang = args.lang === "de" ? "de" : "en";
const level = ["easy", "normal", "hard"].includes(args.level!) ? args.level! : "normal";
const shots = args.shots;
const nBots = Number(args.bots);
const out = args.out ?? `/tmp/snug-play${lang === "de" ? "-de" : ""}`;
mkdirSync(out, { recursive: true });
if (shots) mkdirSync(shots, { recursive: true });
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
let failed = false;
const problems: string[] = [];
const problem = (p: string) => {
  if (problems.includes(p)) return;
  problems.push(p);
  log(`PROBLEM ${p}`);
};
try {
  const win = await browser.open(start, { width: 1200, height: 860 });
  await win.until(`!!document.querySelector('#devices .device[data-name="browser"]')`, 20_000);
  await win.eval(`document.querySelector('#devices .device[data-name="browser"]').click(); true`);
  await win.until(`!document.getElementById("start").disabled`);
  await win.eval(`document.getElementById("start").click(); true`);
  await win.until(`location.pathname.endsWith("/host/index.html") && !!globalThis.snug`, 20_000);
  log("the host page runs the game");
  await win.eval(`(() => { snug.page.set("lang", ${JSON.stringify(lang)}); snug.page.set("level", ${JSON.stringify(level)}); return true; })()`);
  await win.until(`snug.game.lang === ${JSON.stringify(lang)} && snug.game.settings.level === ${JSON.stringify(level)}`, 5000);
  // A long clock for the phone's script and its screenshots.
  await win.eval(`(() => { snug.game.configure({ timings: { start: 300000, bonus: 30000 } }); return true; })()`);
  const links = await win.eval<{ join: string; watch: string }>(`({ join: snug.party.links.join, watch: snug.party.links.watch })`);
  const tv = await browser.open(`${links.watch}&mute=1`, { width: 1280, height: 720 });
  const PHONE = { width: 390, height: 844, mobile: true };
  const phone = await browser.open(links.join, { ...PHONE, locale: lang === "de" ? "de-DE" : "en-US" });
  await phone.until(`!!document.getElementById("name")`, 20_000);
  const pages: [string, Tab][] = [["the window", win], ["the TV", tv], ["the phone", phone]];
  await sleep(600);
  await phone.screenshot(`${out}/phone-00-join.png`);
  await phone.eval(`document.getElementById("name").value = "Phil"; document.querySelector("form button").click(); true`);
  await phone.until(`!!document.querySelector(".lobby")`);
  await win.eval(`snug.addBots(${nBots}, { names: ["Mia", "Lena", "Jonas", "Ana", "Tom", "Ida", "Max"].slice(0, ${nBots}), think: 4000, wrong: 0.25 }).then(() => true)`);
  await phone.until(`document.querySelectorAll(".chips .chip").length === ${nBots + 1}`, 20_000);
  log(`${nBots} bots joined in the window`);
  await win.screenshot(`${out}/host.png`);

  const layout = `(() => {
    const out = [];
    const W = innerWidth;
    if (document.documentElement.scrollWidth > W + 1) out.push("the page is wider than the screen: " + document.documentElement.scrollWidth);
    for (const el of document.querySelectorAll("body *")) {
      if (!el.checkVisibility || !el.checkVisibility()) continue;
      if (el instanceof SVGElement || ["input", "i"].includes(el.localName) || el.closest(".logo")) continue;
      const cs = getComputedStyle(el);
      if (cs.textOverflow !== "ellipsis" && el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0 && cs.overflowX === "visible") out.push("too wide: " + el.localName + "." + el.className + " " + JSON.stringify((el.innerText || "").slice(0, 40)));
      const r = el.getBoundingClientRect();
      if (r.width > 0 && (r.right > W + 2 || r.left < -2)) out.push("off the side: " + el.localName + "." + el.className);
    }
    for (const el of document.querySelectorAll("[data-fit]")) {
      if (el.checkVisibility && !el.checkVisibility()) continue;
      if (el.scrollWidth > el.clientWidth + 1) out.push("a word does not fit: " + JSON.stringify(el.textContent));
    }
    for (const el of document.querySelectorAll("button")) {
      if (el.checkVisibility && !el.checkVisibility()) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && (r.width < 32 || r.height < 32) && !el.closest(".chip")) out.push("a small tap target: " + el.className + " " + Math.round(r.width) + "×" + Math.round(r.height));
    }
    // Playing: the board and the whole hand on one screen, no scrolling.
    const tray = document.querySelector(".tray:not([hidden])");
    if (tray && tray.getBoundingClientRect().bottom > innerHeight + 2) out.push("the hand ends below the screen: " + Math.round(tray.getBoundingClientRect().bottom) + " > " + innerHeight);
    return out;
  })()`;
  const check = async (where: string, tab: Tab) => {
    for (const f of await tab.eval<string[]>(layout).catch((e: Error) => [`cannot check: ${e.message.slice(0, 100)}`])) problem(`${where}: ${f}`);
  };
  const tvLayout = `(() => {
    const out = [];
    const moving = document.getAnimations().filter((a) => a.playState === "running" && !(a.effect?.getTiming?.().iterations === Infinity)).map((a) => a.effect?.target).filter((x) => x instanceof Element);
    const still = (el) => !moving.some((m) => m.contains(el));
    for (const el of document.querySelectorAll(".scene:not(.leaving) [data-fit]")) {
      if (el.checkVisibility && !el.checkVisibility()) continue;
      if (el.scrollWidth > el.clientWidth + 1) out.push("a word does not fit: " + JSON.stringify(el.textContent));
    }
    const badge = document.querySelector("tvpipe-rejoin")?.shadowRoot?.querySelector(".mini.shown")?.getBoundingClientRect();
    for (const el of document.querySelectorAll(".scene:not(.leaving) *")) {
      if (!el.checkVisibility || !el.checkVisibility()) continue;
      if (el instanceof SVGElement || el.localName === "i" || el.closest(".logo") || el.closest(".confetti")) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && still(el) && (r.right > innerWidth + 2 || r.left < -2 || r.bottom > innerHeight + 2 || r.top < -2)) out.push("off the screen: " + el.localName + "." + el.className + " " + JSON.stringify((el.innerText || "").slice(0, 30)));
      if (badge && r.width > 0 && still(el) && (el.innerText || "").trim() && r.left < badge.right && r.right > badge.left && r.top < badge.bottom && r.bottom > badge.top) out.push("under the join badge: " + el.localName + "." + el.className + " " + JSON.stringify((el.innerText || "").slice(0, 30)));
    }
    return out;
  })()`;
  const kept: string[] = [];
  const pic = async (tab: Tab, name: string, kind: "tv" | "phone", settle?: number) => {
    if (!shots || kept.some((f) => f.startsWith(`${name}.`))) return;
    kept.push(await keep(tab, shots, name, kind, settle));
    log(`picture: ${kept.at(-1)}`);
  };
  let n = 0;
  const tvShot = async (name: string) => {
    await tv.send("Page.bringToFront");
    await sleep(150);
    await tv.screenshot(`${out}/tv-${String(++n).padStart(2, "0")}-${name}.png`);
    for (const f of await tv.eval<string[]>(tvLayout).catch(() => [])) problem(`tv ${name}: ${f}`);
  };
  const SIZES = [
    { width: 375, height: 667, mobile: true, tag: "375" },
    { width: 320, height: 568, mobile: true, tag: "320" },
    { width: 360, height: 640, mobile: true, tag: "360" },
    { width: 430, height: 932, mobile: true, tag: "430" },
  ];
  const phoneShot = async (name: string, sizes = true) => {
    const at = String(++n).padStart(2, "0");
    await phone.send("Page.bringToFront");
    await sleep(150);
    await phone.screenshot(`${out}/phone-${at}-${name}.png`);
    await check(`phone ${name}`, phone);
    if (!sizes) return;
    for (const s of SIZES) {
      await phone.resize(s);
      await sleep(300);
      await check(`phone ${s.tag} ${name}`, phone);
      await phone.screenshot(`${out}/phone-${at}-${name}-${s.tag}.png`);
    }
    await phone.resize(PHONE);
    await sleep(200);
  };
  await sleep(800);
  await tvShot("lobby");
  await pic(tv, "tv-lobby", "tv", 600);
  await phoneShot("lobby");
  await phone.until(`!document.getElementById("start")?.disabled`);
  await phone.eval(`document.getElementById("start").click(); true`);

  // ---- Board 1: the phone plays its pieces by touch; the bots theirs.
  await phone.until(`document.querySelectorAll(".tray .slot").length > 0`, 20_000);
  log("board 1");
  await sleep(1200);
  await tvShot("board1");
  await phoneShot("board1");
  const me = await win.eval<string>(`snug.party.players.find((p) => p.name === "Phil").id`);
  /** The phone's needed pieces and where the solution has them. */
  const mine = () => win.eval<{ id: string; home: [number, number][] }[]>(`[...snug.game.current.pieces.values()].filter((p) => p.owner === ${JSON.stringify(me)} && p.home && !p.at).map((p) => ({ id: p.id, home: p.home }))`);
  const norm = (cells: [number, number][]) => {
    const mx = Math.min(...cells.map((c) => c[0]));
    const my = Math.min(...cells.map((c) => c[1]));
    return JSON.stringify(cells.map(([x, y]) => [x - mx, y - my]).sort((a, b) => a[1]! - b[1]! || a[0]! - b[0]!));
  };
  /** Turns (taps) and flips a hand piece until it lies like `home`; the slot's index. */
  const orient = async (id: string, home: [number, number][]) => {
    const want = norm(home);
    for (let i = 0; i < 10; i++) {
      const at = await phone.eval<{ k: string; x: number; y: number; fx: number; fy: number } | null>(`(() => {
        const slots = [...document.querySelectorAll(".tray .slot")];
        const hand = ${JSON.stringify(id)};
        const s = slots.find((el) => el.dataset.id === hand);
        if (!s) return null;
        const g = s.querySelector(".grab").getBoundingClientRect();
        const f = s.querySelector(".flip").getBoundingClientRect();
        return { k: s.dataset.k, x: g.x + g.width / 2, y: g.y + g.height / 2, fx: f.x + f.width / 2, fy: f.y + f.height / 2 };
      })()`);
      if (!at) throw new Error(`no slot for ${id}`);
      if (at.k === want) return at;
      if (i === 4) await phone.drag([[at.fx, at.fy]]);
      else await phone.drag([[at.x, at.y]]);
      await sleep(250);
    }
    throw new Error(`could not turn ${id} to ${want}`);
  };
  /** Drags a hand piece (oriented already) so that it lands on `home`. */
  const dragTo = async (id: string, home: [number, number][]) => {
    const at = await orient(id, home);
    const target = await phone.eval<{ x: number; y: number }>(`(() => {
      const svg = document.querySelector("svg.board");
      const r = svg.getBoundingClientRect();
      const vb = svg.viewBox.baseVal;
      const unit = r.width / vb.width;
      const home = ${JSON.stringify(home)};
      const ox = Math.min(...home.map((c) => c[0]));
      const oy = Math.min(...home.map((c) => c[1]));
      const w = Math.max(...home.map((c) => c[0])) - ox + 1;
      const h = Math.max(...home.map((c) => c[1])) - oy + 1;
      return { x: r.left + (ox - vb.x) * unit + (w * unit) / 2, y: r.top + (oy - vb.y) * unit + 34 + h * unit };
    })()`);
    const steps: [number, number][] = [];
    for (let i = 0; i <= 8; i++) steps.push([at.x + ((target.x - at.x) * i) / 8, at.y + ((target.y - at.y) * i) / 8]);
    await phone.drag(steps);
  };
  /** Drags until it lands: a bot's wrong piece may lie there for a moment (it lifts it again). */
  const dropAt = async (id: string, home: [number, number][]) => {
    for (let i = 0; i < 6; i++) {
      await dragTo(id, home);
      const landed = await win
        .until(`JSON.stringify(snug.game.current?.pieces.get(${JSON.stringify(id)})?.at) === ${JSON.stringify(JSON.stringify(home))}`, 1500)
        .then(() => true, () => false);
      if (landed) return true;
      log(`the drop on ${JSON.stringify(home)} did not land (something lies there?), again`);
      await sleep(2500);
    }
    return false;
  };
  const pieces = await mine();
  if (pieces.length === 0) problem("the phone holds no needed piece");
  // A tap turns, ⇋ flips: the slot's shape changes.
  const before = await phone.eval<string>(`document.querySelector(".tray .slot").dataset.k`);
  const p0 = await phone.eval<{ x: number; y: number }>(`(() => { const r = document.querySelector(".tray .slot .grab").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await phone.drag([[p0.x, p0.y]]);
  await sleep(300);
  const after = await phone.eval<string>(`document.querySelector(".tray .slot").dataset.k`);
  if (before === after && !/^\[\[0,0\],\[1,0\],\[0,1\],\[1,1\]\]$/.test(before)) problem("a tap did not turn the piece");
  // The first piece by touch, where the solution has it.
  const first = pieces[0]!;
  if (!(await dropAt(first.id, first.home))) problem("the dragged piece did not land");
  await sleep(600);
  await phoneShot("placed", false);
  await pic(phone, "phone-board", "phone", 300);
  // Point and ping on the board.
  const b = await phone.eval<{ x: number; y: number; w: number; h: number }>(`(() => { const r = document.querySelector("svg.board").getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
  await phone.drag([[b.x + b.w * 0.8, b.y + b.h * 0.2], [b.x + b.w * 0.6, b.y + b.h * 0.4], [b.x + b.w * 0.5, b.y + b.h * 0.5]]);
  await sleep(150);
  await win.until(`!!snug.party.screenView().screen.cursors?.[${JSON.stringify(me)}]`, 3000).catch(() => problem("the phone's cursor did not reach the TV"));
  // Hard: no check before a filled shape; tapping says so.
  const tapCheck = async () => {
    const cb = await phone.eval<{ x: number; y: number }>(`(() => { const r = document.querySelector("button.check").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await phone.drag([[cb.x, cb.y]]);
  };
  if (level === "hard") {
    await tapCheck();
    await phone.until(`document.getElementById("toast").classList.contains("show")`, 3000).catch(() => problem("hard: tapping check without one said nothing"));
  }
  // Tap the placed piece: it comes back to the hand; drop it again.
  const back = await phone.eval<{ x: number; y: number }>(`(() => {
    const svg = document.querySelector("svg.board"); const r = svg.getBoundingClientRect(); const vb = svg.viewBox.baseVal; const unit = r.width / vb.width;
    const c = ${JSON.stringify(first.home[0])};
    return { x: r.left + (c[0] + 0.5 - vb.x) * unit, y: r.top + (c[1] + 0.5 - vb.y) * unit };
  })()`);
  await phone.drag([[back.x, back.y]]);
  await win.until(`snug.game.current.pieces.get(${JSON.stringify(first.id)}).at === null`, 5000).catch(() => problem("tapping the placed piece did not take it back"));
  await sleep(500);
  for (const p of await mine()) {
    if (!(await dropAt(p.id, p.home))) problem(`a piece dragged to ${JSON.stringify(p.home)} did not land`);
    await sleep(500);
  }
  await tvShot("board1-placed");
  await pic(tv, "tv-board", "tv", 400);
  await phone.until(`document.body.dataset.phase === "solved"`, 90_000).catch(async () => {
    problem("board 1 was not solved");
    log(await win.eval<string>(`JSON.stringify([...snug.game.current.pieces.values()].map((p) => ({ o: snug.party.player(p.owner)?.name, home: p.home, at: p.at })))`));
  });
  await sleep(1500);
  await tvShot("solved");
  await pic(tv, "tv-solved", "tv", 100);
  await phoneShot("solved", false);

  // ---- Board 2: the bots play, then the clock runs out.
  await phone.until(`document.body.dataset.phase === "board"`, 20_000);
  log("board 2");
  await sleep(9000);
  await tvShot("board2");
  await phoneShot("board2");
  // Once the bots are done (the phone holds the rest), check: the answer on the phone and the TV, at every size.
  await win.until(`[...snug.game.current.pieces.values()].every((p) => p.owner === ${JSON.stringify(me)} || !p.home || JSON.stringify(p.at) === JSON.stringify(p.home))`, 40_000).catch(() => problem("the bots did not finish board 2"));
  await tapCheck();
  await phone.until(`!!document.querySelector(".answer.show")`, 5000).catch(() => problem("the check's answer did not show on the phone"));
  await win.until(`snug.party.screenView().screen.check?.result === "open"`, 3000).catch(() => problem("the check's answer (open) did not reach the TV"));
  await sleep(600);
  await tvShot("checked");
  await phoneShot("checked");
  await win.eval(`snug.game.setClock(5000); true`);
  await phone.until(`document.body.dataset.phase === "over"`, 15_000);
  await sleep(800);
  await tvShot("timesup");
  await sleep(3200);
  await tvShot("solution");
  await pic(tv, "tv-solution", "tv", 100);
  await phoneShot("solution", false);
  await phone.until(`!!document.querySelector(".awards") || document.querySelector("h1")?.textContent?.length > 0 && !document.querySelector(".play")`, 20_000);
  await sleep(2500);
  await tvShot("final");
  await phoneShot("final");
  const errors = await win.eval<string[]>(`snug.robots.flatMap((b) => b.errors)`);
  if (errors.length > 0) problem(`the bots' errors: ${errors.join(", ")}`);
  for (const [name, tab] of pages) for (const e of tab.errors.splice(0)) problem(`${name}: ${e.replace(/:\d+\/favicon/, ":PORT/favicon")}`);
  log(`game over; problems: ${problems.length || "none"}; screenshots in ${out}`);
  if (problems.length > 0) failed = true;
  await win.eval(`document.getElementById("quit").click(); true`);
  await Promise.race([exited, sleep(10_000)]);
} catch (err) {
  failed = true;
  log(`FAILED: ${(err as Error).stack ?? String(err)}`);
  writeFileSync(`${out}/tvpipe.log`, tvpipeLog.join("\n"));
} finally {
  browser.close();
  proc.kill();
}
process.exit(failed ? 1 : 0);
