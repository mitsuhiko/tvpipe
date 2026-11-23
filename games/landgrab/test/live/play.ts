/**
 * A live check of Landgrab on `tvpipe game play` (not part of `npm
 * test`): tvpipe serves the bundle (`dist/`); a headless Chrome plays
 * the window (the launcher, then the host page), the TV (the watch link
 * at 1280×720) and a phone (joining; on the map: a territory tapped,
 * armies placed with taps and +, an attack from it to a neighbour, a foe
 * tapped from the whole world and attacked from next door with a quick
 * amount; Ready);
 * bots join in the window and play the rest. Screenshots of the TV
 * through the battle and of the phone at each step, at 390×844,
 * 375×667, 320×568, 360×640, 360×740 and 430×932, with a layout check
 * of each (nothing off the screen, no word cut, tap targets, room for
 * the panel under the map, nothing under the TV's join badge).
 *
 *   npm run build && node test/live/play.ts [--bots N] [--rounds N] [--lang en|de] [--out DIR] [--shots DIR]
 *
 * Needs Chrome and tvpipe built (TVPIPE_BINARY, else target/release, else target/debug).
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { parseWorld } from "../../game/world.ts";
import { Browser, type Tab } from "./browser.ts";
import { keep } from "./shots.ts";
import { tapTerritory } from "./taps.ts";
import { tie } from "./tie.ts";

const { values: args } = parseArgs({
  options: {
    bots: { type: "string", default: "3" },
    rounds: { type: "string", default: "2" },
    lang: { type: "string", default: "en" },
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
const out = args.out ?? `/tmp/landgrab-play${lang === "de" ? "-de" : ""}`;
mkdirSync(out, { recursive: true });
if (shots) mkdirSync(shots, { recursive: true });
const world = parseWorld(readFileSync(new URL("data/world.txt", here), "utf8"));
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
  // No TV: the TV's picture is the watch link's tab below.
  await win.until(`document.querySelectorAll("#devices .device").length > 0 && !document.getElementById("no-tv").hidden`, 20_000);
  await win.eval(`document.getElementById("no-tv").click(); true`);
  await win.until(`location.pathname.endsWith("/host/index.html") && !!globalThis.landgrab`, 20_000);
  log("the host page runs the game");
  await win.eval(`(() => { landgrab.page.set("lang", ${JSON.stringify(lang)}); return true; })()`);
  await win.until(`landgrab.game.lang === ${JSON.stringify(lang)}`, 5000);
  // Time to plan for the phone's script and its screenshots at every size (it ends planning with Ready).
  await win.eval(`(() => { landgrab.game.configure({ rounds: ${Number(args.rounds)}, timings: { plan: 90000, firstPlan: 0 } }); return true; })()`);
  const links = await win.eval<{ join: string; watch: string }>(`({ join: landgrab.party.links.join, watch: landgrab.party.links.watch })`);
  const tv = await browser.open(`${links.watch}&mute=1`, { width: 1280, height: 720 });
  const PHONE = { width: 390, height: 844, mobile: true };
  const phone = await browser.open(links.join, { ...PHONE, locale: lang === "de" ? "de-DE" : "en-US" });
  await phone.until(`!!document.getElementById("name")`, 20_000).catch(async (e) => {
    const html = await phone.eval<string>(`document.body.innerHTML.slice(0, 600) + " | " + location.href`).catch((x: Error) => x.message);
    throw new Error(`${e.message}; the phone's errors: ${phone.errors.join(" | ")}; ${html}`);
  });
  const pages: [string, Tab][] = [["the window", win], ["the TV", tv], ["the phone", phone]];
  await sleep(600);
  await phone.screenshot(`${out}/phone-00-join.png`);
  await phone.eval(`document.getElementById("name").value = "Phil"; document.querySelector("form button").click(); true`);
  await phone.until(`!!document.querySelector(".lobby")`);
  await win.eval(`landgrab.addBots(${nBots}, { names: ["Mia", "Lena", "Jonas", "Ana", "Tom"].slice(0, ${nBots}), think: 2500 }).then(() => true)`);
  await phone.until(`document.querySelectorAll(".chips .chip").length === ${nBots + 1}`, 20_000);
  log(`${nBots} bots joined in the window`);
  await win.screenshot(`${out}/host.png`);

  const layout = `(() => {
    const out = [];
    const W = innerWidth;
    if (document.documentElement.scrollWidth > W + 1) out.push("the page is wider than the screen: " + document.documentElement.scrollWidth);
    for (const el of document.querySelectorAll("body *")) {
      if (!el.checkVisibility || !el.checkVisibility()) continue;
      if (["svg", "path", "canvas", "input", "i"].includes(el.localName) || el.closest(".logo")) continue;
      const cs = getComputedStyle(el);
      const clipped = cs.textOverflow === "ellipsis";
      if (!clipped && el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0 && cs.overflowX === "visible") out.push("too wide: " + el.localName + "." + el.className + " " + JSON.stringify((el.innerText || "").slice(0, 40)));
      const r = el.getBoundingClientRect();
      if (r.width > 0 && (r.right > W + 2 || r.left < -2)) out.push("off the side: " + el.localName + "." + el.className);
    }
    for (const el of document.querySelectorAll("[data-fit]")) {
      if (el.checkVisibility && !el.checkVisibility()) continue;
      if (el.scrollWidth > el.clientWidth + 1) out.push("a word does not fit: " + JSON.stringify(el.textContent) + " " + el.scrollWidth + " > " + el.clientWidth);
    }
    // Fingers: every button at least 32 px each way (most are 40 and more).
    for (const el of document.querySelectorAll("button")) {
      if (el.checkVisibility && !el.checkVisibility()) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && (r.width < 32 || r.height < 32)) out.push("a small tap target: " + el.className + " " + JSON.stringify((el.innerText || el.getAttribute("aria-label") || "").slice(0, 20)) + " " + Math.round(r.width) + "×" + Math.round(r.height));
    }
    // The plan's map keeps room above its bar, the bar stays above the dock; the dock stays small.
    const map = document.querySelector(".planmap")?.getBoundingClientRect();
    const bar = document.querySelector(".planbar")?.getBoundingClientRect();
    const dockTop = document.getElementById("dock")?.getBoundingClientRect().top ?? innerHeight;
    if (map && map.height < 140) out.push("the map gets " + Math.round(map.height) + " px");
    if (bar && bar.bottom > dockTop + 1) out.push("the bar goes under the dock by " + Math.round(bar.bottom - dockTop) + " px");
    const dock = document.getElementById("dock");
    if (dock && !dock.hidden && dock.getBoundingClientRect().height > innerHeight * 0.16) out.push("the dock takes " + Math.round(dock.getBoundingClientRect().height) + " px");
    return out;
  })()`;
  const check = async (where: string, tab: Tab) => {
    for (const f of await tab.eval<string[]>(layout).catch((e: Error) => [`cannot check: ${e.message.slice(0, 100)}`])) problem(`${where}: ${f}`);
  };
  /** The TV: no word cut, nothing off the screen, nothing that matters under the join badge. */
  const tvLayout = `(() => {
    const out = [];
    const moving = document.getAnimations().filter((a) => a.playState === "running" && !(a.effect?.getTiming?.().iterations === Infinity)).map((a) => a.effect?.target).filter((x) => x instanceof Element);
    const still = (el) => !moving.some((m) => m.contains(el));
    for (const el of document.querySelectorAll("#hud .scene:not(.leaving) [data-fit]")) {
      if (el.checkVisibility && !el.checkVisibility()) continue;
      if (el.scrollWidth > el.clientWidth + 1) out.push("a word does not fit: " + JSON.stringify(el.textContent) + " " + el.scrollWidth + " > " + el.clientWidth);
    }
    const badge = document.querySelector("tvpipe-rejoin")?.shadowRoot?.querySelector(".mini.shown")?.getBoundingClientRect();
    for (const el of document.querySelectorAll("#hud .scene:not(.leaving) *")) {
      if (!el.checkVisibility || !el.checkVisibility()) continue;
      if (["svg", "path", "g", "circle", "rect", "text", "canvas", "i"].includes(el.localName) || el.closest(".logo")) continue;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (r.width > 0 && still(el) && (r.right > innerWidth + 2 || r.left < -2 || r.bottom > innerHeight + 2 || r.top < -2)) out.push("off the screen: " + el.localName + "." + el.className + " " + JSON.stringify((el.innerText || "").slice(0, 30)));
      if (cs.textOverflow !== "ellipsis" && el.children.length === 0 && el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0 && cs.display !== "inline") out.push("too wide: " + el.localName + "." + el.className + " " + JSON.stringify((el.innerText || "").slice(0, 30)));
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
    await sleep(120);
    await tv.screenshot(`${out}/tv-${String(++n).padStart(2, "0")}-${name}.png`);
    for (const f of await tv.eval<string[]>(tvLayout).catch(() => [])) problem(`tv ${name}: ${f}`);
  };
  // iPhone SE 2/3, iPhone SE (1st), small and tall Androids, iPhone Pro Max.
  const SIZES = [
    { width: 375, height: 667, mobile: true, tag: "375" },
    { width: 320, height: 568, mobile: true, tag: "320" },
    { width: 360, height: 640, mobile: true, tag: "360" },
    { width: 360, height: 740, mobile: true, tag: "360x740" },
    { width: 430, height: 932, mobile: true, tag: "430" },
  ];
  const phoneShot = async (name: string) => {
    const at = String(++n).padStart(2, "0");
    await phone.send("Page.bringToFront");
    await sleep(120);
    await phone.screenshot(`${out}/phone-${at}-${name}.png`);
    await check(`phone ${name}`, phone);
    for (const s of SIZES) {
      await phone.resize(s);
      await sleep(250);
      await check(`phone ${s.tag} ${name}`, phone);
      await phone.screenshot(`${out}/phone-${at}-${name}-${s.tag}.png`);
    }
    await phone.resize(PHONE);
    await sleep(150);
  };
  await sleep(800);
  await tvShot("lobby");
  await phoneShot("lobby");
  await phone.until(`!document.getElementById("start")?.disabled`);
  await phone.eval(`document.getElementById("start").click(); true`);

  const state = () => win.eval<{ phase: string; round: number; step: number }>(`(() => { const g = landgrab.game; const s = landgrab.party.screenView().screen ?? {}; return { phase: g.phase, round: g.round, step: s.step?.i ?? -1 }; })()`);
  const tap = (sel: string) => phone.eval(`(() => { const el = ${sel}; if (!el) return false; el.click(); return true; })()`);
  const deadline = Date.now() + 25 * 60_000;
  let lastKey = "";
  for (;;) {
    if (Date.now() > deadline) throw new Error("the game took too long");
    const s = await state();
    if (s.phase === "final") break;
    const key = `${s.round}:${s.phase}`;
    if (key === lastKey) {
      if (s.phase === "battle" && s.step >= 0 && s.step % 3 === 0) {
        const k = `${key}:${s.step}`;
        if (!(globalThis as any)[k]) {
          (globalThis as any)[k] = true;
          await sleep(900);
          await tvShot(`r${s.round}-battle-${s.step}-a`);
          await sleep(1300);
          await tvShot(`r${s.round}-battle-${s.step}-b`);
          // The phone with the same event (the dice in step with the TV).
          await phone.send("Page.bringToFront");
          await sleep(100);
          await phone.screenshot(`${out}/phone-${String(++n).padStart(2, "0")}-r${s.round}-battle-${s.step}.png`);
          await check(`phone r${s.round} battle ${s.step}`, phone);
          await pic(phone, "phone-battle", "phone", 50);
          await pic(tv, "tv-battle", "tv", 100);
        }
      }
      await sleep(150);
      continue;
    }
    lastKey = key;
    log(key);
    if (s.phase === "plan") {
      await phone.until(`!!document.querySelector(".planbar") && !!document.querySelector(".minimap.plan")?.dataset.view`, 8000);
      await sleep(3200);
      await tvShot(`r${s.round}-plan`);
      // The games list's cover: the whole world while everyone plans (the bots ready one by one).
      await pic(tv, "tv-plan", "tv", 100);
      await phoneShot(`r${s.round}-plan`);
      // Where to tap, from the host's board: the strongest front, its weakest foe, a foe of another front.
      const sv = await win.eval<{ board: { own: string[]; arm: number[] }; players: { id: string; name: string }[] }>(`landgrab.party.screenView().screen`);
      const me = sv.players.find((p) => p.name === "Phil")?.id ?? "";
      const own = (id: string) => sv.board.own[world.byId.get(id)!.index] === me;
      const arm = (id: string) => sv.board.arm[world.byId.get(id)!.index] ?? 0;
      const fronts = world.territories.filter((x) => own(x.id) && x.neighbors.some((n) => !own(n))).sort((x, y) => arm(y.id) - arm(x.id));
      const A = fronts[0];
      const tapAt = async (id: string) => {
        if (!(await phone.eval<boolean>(tapTerritory(id)))) problem(`round ${s.round}: cannot tap ${id} on the map`);
        await sleep(700);
      };
      if (!A) problem(`round ${s.round}: no front`);
      else {
        const C = A.neighbors.filter((n) => !own(n)).sort((x, y) => arm(x) - arm(y))[0]!;
        if (await phone.eval<boolean>(`document.querySelector(".steps .stp.on") === document.querySelector(".steps .stp")`)) {
          // Place: a tap flies to the front and selects it; taps on it and + place the rest.
          await tapAt(A.id);
          if (!(await phone.eval<boolean>(`!!document.querySelector(".planbar .step-btn.plus")`))) problem(`round ${s.round}: tapping ${A.id} selected nothing to place on`);
          await phoneShot(`r${s.round}-place-selected`);
          await tapAt(A.id);
          for (let i = 0; i < 12; i++) await tap(`document.querySelector(".planbar .step-btn.plus:not([disabled])")`);
          await sleep(300);
          if (!(await phone.eval<boolean>(`!!document.querySelector(".steps .stp b.ok")`))) problem(`round ${s.round}: armies left after placing on ${A.id}`);
          await phoneShot(`r${s.round}-placed`);
          await tap(`document.querySelector(".planbar .btn.next")`);
          await sleep(300);
        } else await tap(`document.querySelectorAll(".steps .stp")[1]`);
        // Orders: from the front to its weakest foe.
        await phoneShot(`r${s.round}-orders`);
        await tapAt(A.id);
        await phoneShot(`r${s.round}-from`);
        await tapAt(C);
        if (!(await phone.eval<boolean>(`!!document.querySelector(".route-head")`))) problem(`round ${s.round}: tapping ${C} from ${A.id} opened no amount`);
        else {
          await phoneShot(`r${s.round}-amount`);
          await pic(phone, "phone-attack", "phone", 200);
          await tap(`document.querySelector(".amount-actions .send")`);
          await sleep(300);
          if ((await phone.eval<string>(`document.querySelectorAll(".steps .stp")[1]?.querySelector("b")?.textContent ?? ""`)) !== "1") problem(`round ${s.round}: the attack made no order`);
        }
        // From the whole world: a foe of another front, attacked from next door with all.
        const D = fronts[1]?.neighbors.find((n) => !own(n) && n !== C);
        const E = D && world.byId.get(D)!.neighbors.find((n) => own(n) && n !== A.id);
        if (D && E) {
          await tap(`document.querySelector(".world-btn")`);
          await sleep(700);
          await tapAt(D);
          await phoneShot(`r${s.round}-foe`);
          await tapAt(E);
          // All when there are quick amounts (a single army has none); sent either way.
          await tap(`document.querySelector(".quick .q:last-child")`);
          await tap(`document.querySelector(".amount-actions .send")`);
          await sleep(300);
        }
      }
      await pic(phone, "phone-plan", "phone", 400);
      await tap(`document.querySelector("#dock .btn")`);
      await sleep(600);
      await phoneShot(`r${s.round}-ready`);
      await tvShot(`r${s.round}-ready`);
    } else if (s.phase === "battle") {
      await sleep(1500);
      await phoneShot(`r${s.round}-battle`);
    }
  }
  await sleep(2500);
  await tvShot("final");
  await phoneShot("final");
  const errors = await win.eval<string[]>(`landgrab.robots.flatMap((b) => b.errors)`);
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
