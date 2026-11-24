/**
 * A live check of Worldquiz on `tvpipe game play` (not part of `npm
 * test`): tvpipe serves the bundle (`dist/`); a headless Chrome plays the
 * window (the launcher, then the host page), the TV (the watch link at
 * 1280×720) and a phone ("Phil": joining, choosing as captain, typing
 * answers, dropping pins); bots join in the window and play the rest.
 * Screenshots of the TV and the phone at each moment, a layout check of
 * the TV (nothing off the screen, no word cut, nothing under the join
 * badge) and of every phone screen at 390 and 320 px.
 *
 *   npm run build && node test/live/play.ts [--bots N] [--rounds N] [--lang en|de] [--map flat|globe] [--out DIR] [--shots DIR]
 *
 * `--shots DIR`: the pictures for the games list (docs/game-catalog.md)
 * into DIR: `tv-compete`, `tv-where`, `phone-card`, `phone-where`; the
 * game ends there:
 *
 *   node test/live/play.ts --bots 3 --shots ../../site/static/games/worldquiz
 *
 * Needs Chrome and tvpipe built (TVPIPE_BINARY, else target/release, else target/debug).
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { Browser, type Tab } from "./browser.ts";
import { keep } from "./shots.ts";
import { tie } from "./tie.ts";

const { values: args } = parseArgs({
  options: {
    bots: { type: "string", default: "3" },
    rounds: { type: "string", default: "4" },
    lang: { type: "string", default: "en" },
    map: { type: "string", default: "flat" },
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
const shots = args.shots;
const nBots = Number(args.bots);
const out = args.out ?? `/tmp/worldquiz-play${lang === "de" ? "-de" : ""}${args.map === "globe" ? "-globe" : ""}${shots ? "-shots" : ""}`;
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
  await win.until(`location.pathname.endsWith("/host/index.html") && !!globalThis.worldquiz`, 20_000);
  log("the host page runs the game");
  await win.eval(`(() => { worldquiz.page.set("lang", ${JSON.stringify(lang)}); worldquiz.page.set("map", ${JSON.stringify(args.map === "globe" ? "globe" : "flat")}); return true; })()`);
  await win.until(`worldquiz.game.lang === ${JSON.stringify(lang)}`, 5000);
  const timings = { choose: 15_000, competeIntro: 2500, competeCard: 1700, competeEnd: 2000, discard: 2000, announce: 2500, reveal: 1500, revealWhere: 3500, next: 120_000, answer: 15 };
  await win.eval(`(() => { worldquiz.game.configure({ timings: ${JSON.stringify(timings)} }); return true; })()`);
  const links = await win.eval<{ join: string; watch: string }>(`({ join: worldquiz.party.links.join, watch: worldquiz.party.links.watch })`);
  const tv = await browser.open(`${links.watch}&mute=1`, { width: 1280, height: 720 });
  const PHONE = { width: 390, height: 844, mobile: true };
  const phone = await browser.open(links.join, { ...PHONE, locale: lang === "de" ? "de-DE" : "en-US" });
  await phone.until(`!!document.getElementById("name")`, 20_000);
  await sleep(600);
  await phone.screenshot(`${out}/phone-00-join.png`);
  await phone.eval(`document.getElementById("name").value = "Phil"; document.querySelector("#name").form.querySelector("button[type=submit], button").click(); true`);
  await phone.until(`!!document.querySelector(".lobby")`);
  const names = shots ? ["Mia", "Lena", "Jonas"] : undefined;
  await win.eval(`worldquiz.addBots(${nBots}, { ${names ? `names: ${JSON.stringify(names)}, ` : ""}sharp: 0.7, think: 2500 }).then(() => true)`);
  await phone.until(`document.querySelectorAll(".chips .chip").length === ${nBots + 1}`, 20_000);
  log(`${nBots} bots joined in the window`);
  await win.screenshot(`${out}/host.png`);

  const layout = `(() => {
    const out = [];
    const W = innerWidth;
    if (document.documentElement.scrollWidth > W + 1) out.push("the page is wider than the screen: " + document.documentElement.scrollWidth);
    for (const el of document.querySelectorAll("body *")) {
      if (!el.checkVisibility || !el.checkVisibility()) continue;
      if (["svg", "path", "canvas", "input", "i", "circle", "g"].includes(el.localName)) continue;
      const cs = getComputedStyle(el);
      if (cs.textOverflow !== "ellipsis" && el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0 && cs.overflowX === "visible") out.push("too wide: " + el.localName + "." + el.className + " " + JSON.stringify((el.innerText || "").slice(0, 40)));
      const r = el.getBoundingClientRect();
      if (r.width > 0 && (r.right > W + 2 || r.left < -2)) out.push("off the side: " + el.localName + "." + el.className);
    }
    for (const el of document.querySelectorAll("[data-fit]")) {
      if (el.checkVisibility && !el.checkVisibility()) continue;
      if (el.scrollWidth > el.clientWidth + 1) out.push("a word does not fit: " + JSON.stringify(el.textContent) + " " + el.scrollWidth + " > " + el.clientWidth);
    }
    return out;
  })()`;
  const check = async (where: string, tab: Tab) => {
    for (const f of await tab.eval<string[]>(layout).catch((e: Error) => [`cannot check: ${e.message.slice(0, 100)}`])) problem(`${where}: ${f}`);
  };
  const tvLayout = `(() => {
    const out = [];
    const moving = document.getAnimations().filter((a) => a.playState === "running" && !(a.effect?.getTiming?.().iterations === Infinity)).map((a) => a.effect?.target).filter((x) => x instanceof Element);
    const still = (el) => !moving.some((m) => m.contains(el));
    for (const el of document.querySelectorAll("#stage .scene:not(.leaving) [data-fit]")) {
      if (el.checkVisibility && !el.checkVisibility()) continue;
      if (el.scrollWidth > el.clientWidth + 1) out.push("a word does not fit: " + JSON.stringify(el.textContent) + " " + el.scrollWidth + " > " + el.clientWidth);
    }
    const badge = document.querySelector("tvpipe-rejoin")?.shadowRoot?.querySelector(".mini.shown")?.getBoundingClientRect();
    for (const el of document.querySelectorAll("#stage .scene:not(.leaving) *, #race *")) {
      if (!el.checkVisibility || !el.checkVisibility()) continue;
      if (["svg", "path", "g", "circle", "rect", "text", "canvas", "i"].includes(el.localName)) continue;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (r.width > 0 && still(el) && (r.right > innerWidth + 2 || r.left < -2 || r.bottom > innerHeight + 2 || r.top < -2)) out.push("off the screen: " + el.localName + "." + el.className + " " + JSON.stringify((el.innerText || "").slice(0, 30)));
      if (cs.textOverflow !== "ellipsis" && el.children.length === 0 && el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0 && cs.display !== "inline" && cs.overflow !== "hidden") out.push("too wide: " + el.localName + "." + el.className + " " + JSON.stringify((el.innerText || "").slice(0, 30)));
      if (badge && r.width > 0 && still(el) && el.children.length === 0 && (el.innerText || "").trim() && r.left < badge.right && r.right > badge.left && r.top < badge.bottom && r.bottom > badge.top) out.push("under the join badge: " + el.localName + "." + el.className + " " + JSON.stringify((el.innerText || "").slice(0, 30)));
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
    await sleep(900);
    await tv.screenshot(`${out}/tv-${String(++n).padStart(2, "0")}-${name}.png`);
    for (const f of await tv.eval<string[]>(tvLayout).catch(() => [])) problem(`tv ${name}: ${f}`);
  };
  const phoneShot = async (name: string) => {
    await phone.send("Page.bringToFront");
    await sleep(500);
    const at = String(n).padStart(2, "0");
    await phone.screenshot(`${out}/phone-${at}-${name}.png`);
    await check(`phone ${name}`, phone);
    await phone.resize({ width: 320, height: 568, mobile: true });
    await sleep(300);
    await check(`small phone ${name}`, phone);
    await phone.screenshot(`${out}/phone-${at}-${name}-320.png`);
    await phone.resize(PHONE);
    await sleep(200);
  };
  await sleep(800);
  await tvShot("lobby");
  await phoneShot("lobby");
  await win.eval(`(() => { worldquiz.game.configure({ rounds: 15 }); return true; })()`);
  await phone.until(`!document.getElementById("start")?.disabled`);
  await phone.eval(`document.getElementById("start").click(); true`);

  const state = () =>
    win.eval<{ phase: string; stage: string; key: string; captain: boolean; kind: string; round: number; truth: { capitals: string[]; name: string; at: [number, number] } | null }>(`(() => {
      const g = worldquiz.game; const s = worldquiz.party.screenView().screen ?? {};
      const phil = worldquiz.party.players.find((p) => p.name === "Phil");
      return { phase: g.phase, stage: s.stage ?? "", key: [g.phase, s.stage ?? "", s.round ?? "", s.try ?? "", s.kind ?? ""].join("|"), captain: s.captain === phil?.id, kind: s.kind ?? "", round: s.round ?? 0, truth: g.truth() ?? null };
    })()`);
  // Phil presses Next (the bots press by themselves); the stage stays until he does.
  const next = async (where: string) => {
    await phone.until(`!!document.getElementById("next") && !document.getElementById("next").hidden`, 5000).catch(() => problem(`phone: no Next (${where})`));
    const before = await state();
    await sleep(400);
    const still = await state();
    if (still.key !== before.key) problem(`${where}: went on before Phil pressed Next`);
    await phone.eval(`document.getElementById("next")?.click(); true`);
  };
  const seen = new Set<string>();
  const rounds = Number(args.rounds);
  let choice = 0;
  const end = Date.now() + 20 * 60_000;
  for (;;) {
    if (Date.now() > end) throw new Error("the game took too long");
    if (shots && kept.length >= 4) break;
    const s = await state();
    if (s.phase === "final" || (!shots && s.round > rounds)) break;
    if (seen.has(s.key)) {
      await sleep(150);
      continue;
    }
    seen.add(s.key);
    log(`${s.key}${s.captain ? " (Phil is captain)" : ""}`);
    const name = `${s.round}-${s.stage}${s.kind ? `-${s.kind}` : ""}`;
    if (s.stage === "draw") {
      await sleep(1200);
      await tvShot(name);
      await phoneShot(name);
      await pic(phone, "phone-card", "phone");
      if (s.captain) {
        // Phil competes the first time, then challenges.
        const sel = choice++ % 2 === 0 ? `button[data-fact="population"]` : `button[data-challenge]`;
        await phone.until(`!!document.querySelector('${sel}')`, 5000);
        await phone.eval(`document.querySelector('${sel}').click(); true`);
      }
    } else if (s.stage === "compete") {
      await sleep(2500 + 1700 * (nBots + 1) + 800);
      await tvShot(name);
      await pic(tv, "tv-compete", "tv", 200);
      await phoneShot(name);
      await next(name);
    } else if (s.stage === "discard") {
      await sleep(1500);
      await tvShot(name);
      await phoneShot(name);
      await next(name);
    } else if (s.stage === "announce") {
      await sleep(1500);
      await tvShot(name);
    } else if (s.stage === "challenge") {
      await sleep(1200);
      const t = s.truth;
      if (s.kind === "where") {
        await phone.until(`!!globalThis.worldquizPhone?.map`, 5000).catch(() => problem("phone: no map to pin on"));
        const at = t ? [t.at[0] + 1.5, t.at[1] - 1] : [0, 0];
        await phone.eval(`(() => { const m = globalThis.worldquizPhone.map; m.onTap([${at[0]}, ${at[1]}]); return true; })()`).catch(() => problem("phone: cannot pin"));
        await sleep(600);
        await tvShot(name);
        await phoneShot(name);
        await pic(phone, "phone-where", "phone", 400);
        await phone.eval(`document.getElementById("lock")?.click(); true`);
      } else {
        await phone.until(`!!document.getElementById("answer")`, 5000).catch(() => problem(`phone: no answer field (${s.kind})`));
        const text = t ? (s.kind === "capital" ? t.capitals[0] : t.name) : "Atlantis";
        await phone.eval(`(() => { const i = document.getElementById("answer"); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
        await sleep(400);
        await tvShot(name);
        await phoneShot(name);
        await phone.eval(`document.getElementById("lock")?.click(); true`);
      }
    } else if (s.stage === "answer") {
      await sleep(s.kind === "where" ? 4200 : 1600);
      await tvShot(name);
      if (s.kind === "where") await pic(tv, "tv-where", "tv", 200);
      await phoneShot(name);
      await next(name);
    }
  }
  if (!shots) {
    // End it: the final screen.
    await win.eval(`(() => { worldquiz.game.close(); return true; })()`);
    await sleep(800);
    await tvShot("lobby-again");
  }
  const botErrors = await win.eval<string[]>(`worldquiz.robots.flatMap((b) => b.errors)`);
  if (botErrors.length > 0) problem(`the bots' errors: ${botErrors.join(", ")}`);
  for (const [name, tab] of [["the window", win], ["the TV", tv], ["the phone", phone]] as const) for (const e of tab.errors.splice(0)) problem(`${name}: ${e.replace(/:\d+\/favicon/, ":PORT/favicon")}`);
  log(`done: ${problems.length} problems`);
  if (problems.length) failed = true;
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  await browser.close();
  proc.kill();
}
process.exitCode = failed ? 1 : 0;
