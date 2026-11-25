/**
 * A live check of Classes on `tvpipe game play` (not part of `npm test`):
 * tvpipe serves the bundle (`dist/`); a headless Chrome plays the window
 * (the launcher, then the host page), the TV (the watch link at
 * 1280×720) and a phone at 390 px that joins, stops the alphabet when it
 * draws, writes its answers (and reloads with its memory gone half-way,
 * coming back by name to its answers), raises its hand (Stop!), doubts,
 * stars, opens Wikipedia (the live network: when Wikipedia is not
 * reachable the check notes it and goes on) and presses Done; bots join
 * in the window and play the rest. Screenshots of the TV and the phone at
 * each stage, a layout check of the TV (nothing off the screen, no text
 * cut, nothing under the join badge) and of every phone screen at 390 and
 * 320 px.
 *
 *   npm run build && node test/live/play.ts [--bots N] [--rounds N] [--columns N] [--lang en|de] [--long] [--out DIR] [--shots DIR]
 *
 * `--rounds 1` or 2: a game has 3 at least; the rounds after are ended at
 * once (the host's "End the round").
 *
 * `--long`: the longest columns of the list on the board, 40-character
 * answers and long names.
 *
 * `--shots DIR`: the pictures for the games list (docs/game-catalog.md)
 * into DIR from a fixed game (`SCRIPT`: six people, the letter B, six
 * columns, one round): `tv-write` (the books filling up, a Stop!),
 * `tv-grade` (the red pen's marks on the funny column), `tv-wiki` (when
 * Wikipedia answers: Beaver, then a link from it; else it is skipped with a
 * note), `tv-final` (Sam's report card), `tv-cork` (the best answers),
 * `phone-write`, `phone-grade`, `phone-wiki` (the phone's reader):
 *
 *   node test/live/play.ts --bots 5 --shots ../../site/static/games/classes
 *
 * Needs Chrome and tvpipe (TVPIPE_BINARY, else target/release, else
 * target/debug; neither: it runs `cargo build --release -p tvpipe-cli`).
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { findColumn } from "../../game/bots.ts";
import { baseLang, columnsFile, parseColumns, type Column, type Lang } from "../../game/rules.ts";
import { Browser, type Tab } from "./browser.ts";
import { keep } from "./shots.ts";
import { tie } from "./tie.ts";

const { values: args } = parseArgs({
  options: {
    bots: { type: "string", default: "4" },
    rounds: { type: "string", default: "2" },

    columns: { type: "string", default: "8" },
    lang: { type: "string", default: "en" },
    out: { type: "string" },
    shots: { type: "string" },
    long: { type: "boolean", default: false },
  },
});

/**
 * The pictures' game: six people, the letter B, six columns, one round.
 * Every answer, doubt, star and Stop! is written here; the bots think at
 * fixed speeds, so the books fill unevenly and Lena raises her hand first.
 * On "Excuse for missing homework" (the page of the tv-grade picture): a
 * unique 10 with three gold stars, a same-answer pair at 5 each, an answer
 * the room strikes (4 of 5), a wrong letter, another unique 10.
 */
const PEOPLE = ["Mia", "Lena", "Jonas", "Noah", "Emma"];
const ME = { en: "Sam", de: "Paul" };
const THINKS = [2200, 1000, 2500, 3600, 6000];
const BLACK_HOLE = "Black hole in my backpack";
const BERMUDA = "Bermuda Triangle, again";
const BAGPIPES = "Bagpipes, for the neighbours";
const SCRIPT = {
  letter: "B",
  columns: ["Excuse for missing homework", "City", "Animal", "Band or singer", "Something {player} would buy", "Film"],
  /** The phone's answers (Sam). */
  answers: [BLACK_HOLE, "Bangkok", "Badger", "", "Bathtub full of jelly", "Bee Movie"],
  bots: [
    { answers: ["The baby ate it", "Berlin", "Badger", "Beyoncé", "Bubble wrap by the metre", "Bambi"], doubts: { 0: ["Because"] }, stars: { 0: BLACK_HOLE, 4: BAGPIPES } },
    { answers: ["The baby ate it!", "Berlin", "Bear", "Beyoncé", BAGPIPES, "Bambi"], doubts: { 0: ["Because"] }, stars: { 0: BLACK_HOLE, 4: "Bubble wrap by the metre" }, stop: true },
    { answers: [BERMUDA, "Berlin", "Beaver", "Bob Marley", "Bulk toilet paper", ""], stars: { 0: BLACK_HOLE, 4: BAGPIPES } },
    { answers: ["Because", "Boston", "Bat", "Bob Marley"], stars: { 0: BERMUDA, 4: "Bathtub full of jelly", 5: "Bee Movie" } },
    { answers: ["My dog ate it", "Brisbane"], doubts: { 0: ["Because"] }, stars: { 4: "Bulk toilet paper" } },
  ],
  /** On the grading page: the phone stars Jonas's excuse and doubts Noah's; it looks up Jonas's beaver. */
  star: BERMUDA,
  doubt: "Because",
  wiki: "Beaver",
  /** A link in Beaver's lead, followed for the picture (the trail shows). */
  link: "North American beaver",
};
const LONG_NAMES = ["Maximiliane", "Konstantin", "Bartholomew", "Wilhelmina", "Christopher", "Alexandria", "Friederike", "Jean-Baptiste", "Annemarie"];
const TAIL = { en: "with extra cheese and a very long story behind it", de: "mit extra viel Käse und einer langen Geschichte dahinter" };

const here = new URL("../../", import.meta.url);
const repo = new URL("../../", here);
const exe = process.platform === "win32" ? "tvpipe.exe" : "tvpipe";
const find = () => process.env["TVPIPE_BINARY"] ?? ["release", "debug"].map((p) => fileURLToPath(new URL(`target/${p}/${exe}`, repo))).find((p) => existsSync(p));
let binary = find();
if (!binary) {
  console.log("building tvpipe: cargo build --release -p tvpipe-cli");
  const r = spawnSync("cargo", ["build", "--release", "-p", "tvpipe-cli"], { cwd: fileURLToPath(repo), stdio: "inherit" });
  if (r.status !== 0) throw new Error("cargo build failed");
  binary = find();
}
if (!binary) throw new Error("no tvpipe binary");
if (!existsSync(new URL("dist/host/host.js", here))) throw new Error("build the game first: npm run build");
const lang: Lang = args.lang === "de" || args.lang === "at" ? args.lang : "en";
/** German words (Austrian rooms too). */
const de = baseLang(lang) === "de";
const shots = args.shots;
const nBots = Number(args.bots);
if (shots && (nBots !== PEOPLE.length || lang !== "en")) throw new Error(`--shots plays a scripted game in English: --bots ${PEOPLE.length}`);
const rounds = shots ? 1 : Number(args.rounds);
const nCols = shots ? SCRIPT.columns.length : Number(args.columns);
const out = args.out ?? `/tmp/classes-play${lang === "en" ? "" : `-${lang}`}${args.long ? "-long" : ""}${shots ? "-shots" : ""}`;
const me = args.long ? (de ? "Bartholomäus-Jo" : "Maximilianus Jr") : ME[baseLang(lang)];
const LIST: Column[] = parseColumns(readFileSync(new URL(`data/${columnsFile(lang)}`, here), "utf8"), lang);
mkdirSync(out, { recursive: true });
// The last run's screenshots go: a folder holds one run.
for (const f of readdirSync(out)) if (/\.(png|txt|log)$/.test(f)) rmSync(join(out, f));
if (shots) mkdirSync(shots, { recursive: true });
const t0 = Date.now();
const log = (m: string) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)} ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Up to 40 characters: the answer and more words. */
const lengthen = (a: string) => {
  let s = "";
  for (const w of `${a} ${TAIL[baseLang(lang)]}`.split(" ")) if (`${s} ${w}`.trim().length <= 40) s = `${s} ${w}`.trim();
  return s;
};
/** The phone's answer for a dealt column: an example for the letter (the second one, the bots like the first). */
function answerFor(c: { subject: string; text: string }, letter: string, i: number): string {
  if (shots) return SCRIPT.answers[i] ?? "";
  const col = findColumn(LIST, c.subject, c.text);
  const ex = col?.examples[letter] ?? [];
  const a = ex[1] ?? ex[0] ?? (col?.classic ? "" : `${letter}${de ? "ombola" : "ingo"}`);
  return a && args.long ? lengthen(a) : a;
}

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

/** The checks of preview.ts, run in the page: a list of what is wrong. `scrolls`: the phone (its page may be taller than the screen). */
const CHECK = (scrolls: boolean) => `(() => {
  const out = [];
  const W = innerWidth, H = innerHeight;
  const de = document.documentElement;
  if (de.scrollWidth > W + 1) out.push("the page is wider than the screen: " + de.scrollWidth);
  if (!${scrolls} && de.scrollHeight > H + 1) out.push("the page is taller than the screen: " + de.scrollHeight);
  const moving = document.getAnimations().filter((a) => a.playState === "running" && a.effect?.getTiming?.().iterations !== Infinity).map((a) => a.effect?.target).filter((x) => x instanceof Element);
  const still = (el) => !moving.some((m) => m === el || m.contains(el) || el.contains(m));
  const badge = document.querySelector("tvpipe-rejoin")?.shadowRoot?.querySelector(".mini.shown")?.getBoundingClientRect();
  const name = (el) => el.localName + (el.id ? "#" + el.id : "") + (typeof el.className === "string" && el.className ? "." + el.className.trim().split(/\\s+/).join(".") : "") + " " + JSON.stringify((el.textContent || "").trim().slice(0, 40));
  const ownText = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
  for (const el of document.querySelectorAll("body *")) {
    if (el.closest("svg, [data-nocheck], tvpipe-rejoin, script, style")) continue;
    if (!el.checkVisibility || !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const cs = getComputedStyle(el);
    if (still(el)) {
      if (r.right > W + 2 || r.left < -2 || (!${scrolls} && (r.bottom > H + 2 || r.top < -2))) out.push("off the screen: " + name(el));
    }
    if (!ownText(el) && !el.hasAttribute("data-fit")) continue;
    if (cs.textOverflow === "ellipsis") out.push("cut with an ellipsis: " + name(el));
    if (cs.display !== "inline" && el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 2) out.push("text wider than its box (" + el.scrollWidth + " > " + el.clientWidth + "): " + name(el));
    if (cs.display !== "inline" && el.clientHeight > 0 && cs.overflowY !== "visible" && cs.overflowY !== "auto" && cs.overflowY !== "scroll" && el.scrollHeight > el.clientHeight + 2) out.push("text cut at the bottom (" + el.scrollHeight + " > " + el.clientHeight + "): " + name(el));
    if (badge && still(el) && r.left < badge.right && r.right > badge.left && r.top < badge.bottom && r.bottom > badge.top) out.push("under the join badge: " + name(el));
  }
  // A typed field's font gets smaller as its text outgrows it (docs/games.md): never cut.
  for (const el of document.querySelectorAll("input:not([type]), input[type=text], textarea")) {
    if (!el.checkVisibility || !el.checkVisibility() || !el.value) continue;
    if (el.scrollWidth > el.clientWidth + 2) out.push("typed text wider than its field (" + el.scrollWidth + " > " + el.clientWidth + "): " + JSON.stringify(el.value));
  }
  return out;
})()`;

const browser = await Browser.launch();
let failed = false;
const problems: string[] = [];
const notes: string[] = [];
const problem = (p: string) => {
  if (problems.includes(p)) return;
  problems.push(p);
  log(`PROBLEM ${p}`);
};
const note = (n: string) => {
  if (notes.includes(n)) return;
  notes.push(n);
  log(`note: ${n}`);
};
try {
  const win = await browser.open(start, { width: 1200, height: 860 });
  await win.until(`!!document.querySelector('#devices .device[data-name="browser"]')`, 20_000);
  await win.eval(`document.querySelector('#devices .device[data-name="browser"]').click(); true`);
  await win.until(`!document.getElementById("start").disabled`);
  await win.eval(`document.getElementById("start").click(); true`);
  await win.until(`location.pathname.endsWith("/host/index.html") && !!globalThis.classes`, 20_000);
  log("the host page runs the game");
  await win.eval(`(() => { classes.page.set("lang", ${JSON.stringify(lang)}); return true; })()`);
  await win.until(`classes.game.lang === ${JSON.stringify(lang)}`, 5000);
  const timings = shots
    ? { letterMax: 10_000, letterShown: 1800, board: 4000, write: 60_000, stopLeft: 10_000, bell: 2500, vote: 30_000, votePer: 1000, voteMax: 40_000, voteEmpty: 4000, marked: 8000, markedPer: 600, report: 6000 }
    : { letterMax: 10_000, letterShown: 1800, board: 4000, write: 50_000, stopLeft: 10_000, bell: 2500, vote: 25_000, votePer: 1000, voteMax: 35_000, voteEmpty: 4000, marked: 2500, markedPer: 600, report: 6000 };
  await win.eval(`(() => { classes.game.configure({ rounds: ${Math.min(6, Math.max(3, rounds))}, columns: ${[6, 8, 10].includes(nCols) ? nCols : 8}, timings: ${JSON.stringify(timings)} }); return true; })()`);
  if (shots) await win.eval(`(() => { classes.game.script = ${JSON.stringify({ letter: SCRIPT.letter, columns: SCRIPT.columns })}; return true; })()`);
  /** --long: the round's columns are the longest of the list (a new set each round). */
  const longest = [...LIST].sort((a, b) => b.text.length - a.text.length).map((c) => c.text);
  const links = await win.eval<{ join: string; watch: string }>(`({ join: classes.party.links.join, watch: classes.party.links.watch })`);
  const tv = await browser.open(`${links.watch}&mute=1`, { width: 1280, height: 720 });
  const PHONE = { width: 390, height: 844, mobile: true };
  const phone = await browser.open(links.join, { ...PHONE, locale: lang === "at" ? "de-AT" : lang === "de" ? "de-DE" : "en-US" });
  await phone.until(`!!document.getElementById("name")`, 20_000);
  const loud = await browser.open(links.watch, { width: 640, height: 360 });
  const pages: [string, Tab][] = [["the window", win], ["the TV", tv], ["the TV with sound", loud], ["the phone", phone]];
  await sleep(600);
  await phone.screenshot(`${out}/phone-00-join.png`);
  const join = async () => {
    await phone.eval(`document.getElementById("name").value = ${JSON.stringify(me)}; document.querySelector("form button").click(); true`);
    await phone.until(`!document.getElementById("name")`);
  };
  await join();
  const names = shots ? PEOPLE : args.long ? LONG_NAMES.slice(0, nBots) : undefined;
  await win.eval(`classes.addBots(${nBots}, ${JSON.stringify({ think: 900, ...(names ? { names } : {}), ...(args.long ? { long: true } : {}), ...(shots ? { thinks: THINKS, scripts: SCRIPT.bots } : {}) })}).then(() => true)`);
  await phone.until(`document.querySelectorAll(".chips .chip").length >= ${nBots + 1}`, 20_000).catch(() => problem("the phone's class list does not show everyone"));
  log(`${nBots} bots joined in the window`);
  await sleep(1200);
  await win.screenshot(`${out}/host.png`);

  const kept: string[] = [];
  /** Until the TV's finite animations (the red pen, the stamps) are over. */
  const still = (ms = 15_000) => tv.until(`document.getAnimations().filter((a) => a.playState === "running" && a.effect?.getTiming?.().iterations !== Infinity).length === 0`, ms).catch(() => note("the TV was still animating"));
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
    for (const f of await tv.eval<string[]>(CHECK(false)).catch((e: Error) => [`cannot check: ${e.message.slice(0, 100)}`])) problem(`tv ${name}: ${f}`);
  };
  const check = async (where: string) => {
    for (const f of await phone.eval<string[]>(CHECK(true)).catch((e: Error) => [`cannot check: ${e.message.slice(0, 100)}`])) problem(`${where}: ${f}`);
  };
  const shot = async (name: string, tvToo = true) => {
    if (tvToo) await tvShot(name);
    const at = String(tvToo ? n : ++n).padStart(2, "0");
    await phone.screenshot(`${out}/phone-${at}-${name}.png`);
    await check(`phone ${name}`);
    await phone.resize({ width: 320, height: 568, mobile: true });
    await sleep(250);
    await check(`small phone ${name}`);
    await phone.screenshot(`${out}/phone-${at}-${name}-320.png`);
    await phone.resize(PHONE);
    await sleep(150);
  };
  await shot("lobby");
  await phone.until(`!document.getElementById("start")?.disabled`);
  await phone.eval(`document.getElementById("start").click(); true`);

  type State = { phase: string; stage: string; round: number; col: number; key: string; room: Record<string, any> };
  const state = () =>
    win.eval<State>(`(() => { const g = classes.game, r = classes.party.room.peek(); return { phase: g.phase, stage: g.stage ?? "", round: g.round, col: r.col ?? -1, key: [g.phase, g.stage ?? "", g.round, g.phase === "grade" ? r.col : ""].join("|"), room: JSON.parse(JSON.stringify(r)) }; })()`);
  const myId = () => win.eval<string>(`classes.party.players.find((p) => p.name === ${JSON.stringify(me)})?.id ?? ""`);
  /**
   * The phone reads Wikipedia (§3.5), holding the vote open meanwhile: it
   * opens its answer, scrolls (the TV follows the driver: `at`), follows a
   * link, goes back, searches; the TV is taken with each article loaded.
   * The reader's controls (the phone page's contract with this check):
   * `[data-wiki="link"]` on an article's links, `[data-wiki="back"]`,
   * `[data-wiki="search"]` (an input in a form), `[data-wiki="hide"]` (✕:
 * the driver's closes it for everyone), `[data-wiki="close"]` (the others');
   * the reader is `#sheet`.
   */
  const loaded = async (what: string, test = "true") => {
    const ok = await win
      .until(`(() => { const w = classes.party.room.peek().wiki; return !!w && !w.loading && (${test}); })()`, 20_000)
      .then(() => true)
      .catch(() => (problem(`Wikipedia: ${what}: still looking it up after 20 s`), false));
    const w = await win.eval<Record<string, any> | null>(`classes.party.room.peek().wiki`);
    if (!ok || !w) return null;
    if (w.error === "offline") note(`Wikipedia is not reachable from here (the TV said so): ${w.query}`);
    else if (w.error === "none") note(`Wikipedia found nothing for ${JSON.stringify(w.query)}`);
    else {
      log(`Wikipedia (${what}): ${w.title} (${w.blocks?.length ?? 0} blocks${w.cut ? ", cut" : ""}${w.image ? ", a picture" : ""}${w.disambiguation ? ", a disambiguation page" : ""})`);
      // The TV shows the article (not only "Looking it up…").
      await tv.until(`document.body.innerText.includes(${JSON.stringify(String(w.title))})`, 8000).catch(() => problem(`Wikipedia: the TV does not show ${w.title}`));
    }
    return w;
  };
  const reader = async (k: number, text: string, tag: string) => {
    await phone.eval(`document.querySelectorAll(".answer")[${k}].querySelector(".act.wiki").click(); true`);
    log(`phone: Wikipedia for ${JSON.stringify(text)}`);
    const w = await loaded("opened");
    await phone.until(`!document.getElementById("sheet")?.hidden`, 3000).catch(() => problem("Wikipedia: no reader on the phone"));
    await sleep(1500);
    await shot(`${tag}-wiki`);
    if (!w || w.error) return;
    // Scrolling: the phone (the driver) reports its top block, the TV follows.
    await phone.eval(`(() => { const s = document.getElementById("sheet"); const el = [...s.querySelectorAll("*")].find((e) => e.scrollHeight > e.clientHeight + 50 && /auto|scroll/.test(getComputedStyle(e).overflowY)) ?? document.scrollingElement; el.scrollTop = el.scrollHeight / 2; el.dispatchEvent(new Event("scroll")); return true; })()`);
    await win.until(`(classes.party.screenView().screen.wiki?.at ?? 0) > 0`, 4000).catch(() => problem("Wikipedia: the TV does not follow the driver's scrolling (screen wiki.at stays 0)"));
    await sleep(1200);
    await tvShot(`${tag}-wiki-scrolled`);
    // A link.
    const link = await phone.eval<string | null>(`(() => { const a = document.querySelector('#sheet [data-wiki="link"]'); if (!a) return null; a.click(); return a.textContent; })()`);
    if (link === null) problem(`Wikipedia: no link to follow in the phone's reader ([data-wiki="link"])`);
    else {
      log(`phone: followed ${JSON.stringify(link)}`);
      const w2 = await loaded("a link", "w.trail.length >= 2");
      if (w2) await shot(`${tag}-wiki-link`);
      // Back (free: no fetch).
      await sleep(2100);
      const back = await phone.eval<boolean>(`(() => { const b = document.querySelector('#sheet [data-wiki="back"]'); b?.click(); return !!b; })()`);
      if (!back) problem(`Wikipedia: no Back in the phone's reader ([data-wiki="back"])`);
      else await win.until(`(() => { const w = classes.party.room.peek().wiki; return !!w && w.title === ${JSON.stringify(w.title)}; })()`, 4000).then(() => log("phone: back")).catch(() => problem("Wikipedia: Back did not go back"));
    }
    // A search.
    await sleep(2100);
    const term = de ? "Kobold" : "Beaver";
    const searched = await phone.eval<boolean>(`(() => { const i = document.querySelector('#sheet [data-wiki="search"]'); if (!i) return false; i.value = ${JSON.stringify(term)}; i.dispatchEvent(new Event("input", { bubbles: true })); if (i.form) i.form.requestSubmit(); else i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); return true; })()`);
    if (!searched) problem(`Wikipedia: no search field in the phone's reader ([data-wiki="search"])`);
    else {
      log(`phone: searched ${term}`);
      const w3 = await loaded("a search", `w.title === ${JSON.stringify(term)}`);
      if (w3) {
        await sleep(1500);
        await shot(`${tag}-wiki-search`);
      }
    }
    // The driver's ✕ closes it for everyone (the TV too).
    const closed = await phone.eval<boolean>(`(() => { const b = document.querySelector('#sheet [data-wiki="hide"]'); b?.click(); return !!b; })()`);
    if (!closed) problem(`Wikipedia: no ✕ in the phone's reader ([data-wiki="hide"])`);
    else await win.until(`classes.party.room.peek().wiki === null`, 5000).catch(() => problem("Wikipedia: the driver's ✕ did not close it for everyone"));
  };
  /** The pictures' game (`--shots`): what the phone does and when the pictures are taken. */
  const card = (text: string) => `[...document.querySelectorAll(".answer")].find((x) => x.textContent.includes(${JSON.stringify(text)}))`;
  const pictures = async (s: State) => {
    if (s.phase === "write") {
      const since = Date.now();
      await phone.until(`document.querySelectorAll(".book input").length === ${SCRIPT.answers.length}`, 8000);
      await phone.eval(
        `(async () => { const ins = [...document.querySelectorAll(".book input")]; const a = ${JSON.stringify(SCRIPT.answers)}; for (let i = 0; i < ins.length; i++) { if (!a[i]) continue; const x = ins[i]; x.focus(); x.value = a[i]; x.dispatchEvent(new Event("input", { bubbles: true })); x.blur(); x.dispatchEvent(new Event("change", { bubbles: true })); await new Promise((r) => setTimeout(r, 150)); } window.scrollTo(0, 0); return true; })()`,
      );
      await sleep(600);
      await pic(phone, "phone-write", "phone", 300);
      // Lena raised her hand at about 7 s; the others are 1 to 4 columns in.
      await win.until(`!!classes.party.room.peek().stopBy`, 15_000).catch(() => problem("pictures: nobody pressed Stop!"));
      await sleep(Math.max(1500, 9000 - (Date.now() - since)));
      await pic(tv, "tv-write", "tv", 200);
    } else if (s.stage === "vote" && s.col === 0) {
      await phone.until(`!!${card(SCRIPT.doubt)}?.querySelector(".act.doubt")`, 8000);
      await sleep(600);
      await phone.eval(`${card(SCRIPT.star)}.querySelector(".act.star").click(); true`);
      await sleep(400);
      await phone.eval(`${card(SCRIPT.doubt)}.querySelector(".act.doubt").click(); true`);
      // The bots' doubts and stars come in; the phone shows its own.
      await win.until(`(() => { const r = classes.party.room.peek(); return r.done.length >= 5; })()`, 20_000).catch(() => problem("pictures: the bots did not finish grading"));
      // Scrolled so that the star (Jonas) and the doubt (Noah) are both on the screen.
      await phone.eval(`(() => { ${card(SCRIPT.doubt)}.scrollIntoView({ block: "end" }); window.scrollBy(0, 12); return true; })()`);
      await sleep(500);
      await pic(phone, "phone-grade", "phone", 300);
      await phone.eval(`document.querySelector('[data-act="done"]').click(); true`);
    } else if (s.stage === "marked" && s.col === 0) {
      const m = s.room["marks"] as { struck: boolean; points: number; stars: number; doubts: number; of: number }[];
      log(`pictures: the marks ${JSON.stringify(m.map((x) => [x.points, x.stars, x.struck ? `struck ${x.doubts}/${x.of}` : ""]))}`);
      await sleep(1500);
      await still();
      await pic(tv, "tv-grade", "tv", 300);
    } else if (s.stage === "vote" && s.col === 2) {
      await phone.until(`!!${card(SCRIPT.wiki)}?.querySelector(".act.wiki")`, 8000);
      await sleep(600);
      await phone.eval(`${card(SCRIPT.wiki)}.querySelector(".act.wiki").click(); true`);
      log(`phone: Wikipedia for ${SCRIPT.wiki}`);
      await win.until(`(() => { const w = classes.party.room.peek().wiki; return !!w && !w.loading; })()`, 15_000).catch(() => problem("Wikipedia: still looking it up after 15 s"));
      let w = await win.eval<Record<string, any> | null>(`classes.party.room.peek().wiki`);
      if (!w || w.error) note(`no tv-wiki picture: Wikipedia ${w?.error === "offline" ? "is not reachable" : "found nothing"} for ${SCRIPT.wiki}`);
      else {
        log(`Wikipedia: ${w.title} (${w.blocks?.length ?? 0} blocks)`);
        // A link from the lead (the trail shows: Beaver › North American beaver).
        await phone.until(`!document.getElementById("sheet")?.hidden`, 3000).catch(() => {});
        await sleep(2200);
        const followed = await phone.eval<string | null>(`(() => { const ls = [...document.querySelectorAll('#sheet [data-wiki="link"]')]; const a = ls.find((x) => x.textContent === ${JSON.stringify(SCRIPT.link)}) ?? null; a?.click(); return a?.textContent ?? null; })()`);
        if (followed) {
          log(`phone: followed ${followed}`);
          await win.until(`(() => { const w = classes.party.room.peek().wiki; return !!w && !w.loading && w.trail.length === 2; })()`, 15_000).catch(() => note("the link did not open"));
          w = await win.eval<Record<string, any> | null>(`classes.party.room.peek().wiki`);
        } else note(`no link ${JSON.stringify(SCRIPT.link)} in the article: the picture without a trail`);
        if (!w || w.error || !w.image) note(`no tv-wiki picture: ${w?.title ?? SCRIPT.wiki} has no picture`);
        else {
          log(`Wikipedia: ${w.title} (${w.blocks?.length ?? 0} blocks, a picture; trail ${w.trail.join(" › ")})`);
          await tv.until(`document.body.innerText.includes(${JSON.stringify(String(w.title))})`, 8000).catch(() => problem(`Wikipedia: the TV does not show ${w!.title}`));
          await sleep(1500);
          await still();
          await tv.until(`[...document.images].every((i) => i.complete && i.naturalWidth > 0)`, 10_000).catch(() => note("the article's picture did not load on the TV"));
          await pic(tv, "tv-wiki", "tv", 300);
          await phone.eval(`(() => { const s = document.querySelector("#sheet .reader") ?? document.getElementById("sheet"); s.scrollTop = 0; return true; })()`);
          await phone.until(`[...document.querySelectorAll("#sheet img")].every((i) => i.complete)`, 8000).catch(() => {});
          await pic(phone, "phone-wiki", "phone", 400);
        }
      }
      await phone.eval(`document.querySelector('#sheet [data-wiki="hide"]')?.click(); true`);
      await sleep(300);
      await phone.eval(`document.querySelector('[data-act="done"]')?.click(); true`);
    } else if (s.stage === "vote") {
      await phone.until(`!!document.querySelector('[data-act="done"]')`, 8000);
      await sleep(800);
      await phone.eval(`document.querySelector('[data-act="done"]').click(); true`);
    }
  };
  const seen = new Set<string>();
  const deadline = Date.now() + 30 * 60_000;
  let reloaded = false;
  let stopped = false;
  let looked = false;
  let doubted = false;
  for (;;) {
    if (Date.now() > deadline) throw new Error("the game took too long");
    const s = await state();
    if (s.phase === "final") break;
    if (seen.has(s.key)) {
      await sleep(100);
      continue;
    }
    seen.add(s.key);
    const tag = `r${s.round}-${s.phase}${s.stage ? `-${s.stage}` : ""}${s.phase === "grade" ? `-c${s.col + 1}` : ""}`;
    log(tag);
    if (shots && s.round <= rounds && ["write", "grade"].includes(s.phase)) {
      await pictures(s);
      continue;
    }
    if (shots && s.phase === "letter" && s.round <= rounds) {
      await phone.until(`!!document.querySelector(".btn.huge") && !document.querySelector(".btn.huge").disabled`, 8000);
      await sleep(1200);
      await phone.eval(`document.querySelector(".btn.huge").click(); true`);
      continue;
    }
    if (s.phase === "letter" && s.round > rounds) {
      // Fewer rounds than a game has (3 at least): the rest are ended at once.
      await win.eval(`classes.game.endRound()`);
    } else if (s.phase === "letter") {
      if (args.long && !shots) await win.eval(`(() => { classes.game.script = { columns: ${JSON.stringify(longest.slice((s.round - 1) * nCols, s.round * nCols))} }; return true; })()`);
      await sleep(1500);
      const drawer = await phone.eval<boolean>(`!!document.querySelector(".btn.huge") && !document.querySelector(".btn.huge").disabled`);
      await shot(tag);
      if (drawer) {
        await phone.eval(`document.querySelector(".btn.huge").click(); true`);
        log("phone: stopped the alphabet");
        await sleep(400);
        await shot(`${tag}-stopped`, false);
      } else log("phone: not the drawer");
    } else if (s.phase === "board") {
      // Every column chalked (the TV writes them one by one over about 3 s).
      await sleep(3300);
      await shot(tag);
    } else if (s.phase === "write") {
      await phone.until(`document.querySelectorAll(".book input").length > 0`, 8000);
      const r = s.room;
      const answers = (r["columns"] as { subject: string; text: string }[]).map((c, i) => answerFor(c, r["letter"], i));
      const type = (from: number, to: number) =>
        phone.eval(
          `(async () => { const ins = [...document.querySelectorAll(".book input")]; const a = ${JSON.stringify(answers)}; for (let i = ${from}; i < Math.min(${to}, ins.length); i++) { const x = ins[i]; x.focus(); x.value = a[i]; x.dispatchEvent(new Event("input", { bubbles: true })); x.blur(); x.dispatchEvent(new Event("change", { bubbles: true })); await new Promise((r) => setTimeout(r, 120)); } return true; })()`,
        );
      const half = Math.ceil(answers.length / 2);
      await type(0, half);
      await sleep(1500);
      if (!shots && !reloaded) {
        // Dropping out: the phone reloads with its memory gone and joins by name: its seat and its answers again.
        reloaded = true;
        await phone.eval(`localStorage.clear(); location.reload(); true`);
        await phone.until(`!!document.getElementById("name")`);
        await join();
        await phone.until(`document.querySelectorAll(".book input").length > 0`, 8000);
        const back = await phone.eval<string[]>(`[...document.querySelectorAll(".book input")].map((x) => x.value)`);
        const want = answers.slice(0, half).map((a) => a.slice(0, 40));
        const same = want.every((a, i) => back[i] === a);
        log(`phone: forgot everything, reloaded, joined as ${me} again: ${same ? "its answers are back" : `NOT its answers: ${JSON.stringify(back)}`}`);
        if (!same) problem(`the phone did not get its answers back after a reload: ${JSON.stringify(back)} for ${JSON.stringify(want)}`);
      }
      await type(half, answers.length);
      await sleep(1200);
      await pic(phone, "phone-write", "phone", 300);
      await sleep(shots ? 6000 : 2500);
      await pic(tv, "tv-write", "tv", 300);
      await shot(tag);
      const canStop = await phone.eval<boolean>(`(() => { const b = document.querySelector('[data-act="stop"]'); return !!b && b.checkVisibility() && !b.disabled; })()`);
      if (!shots && !stopped && answers.every(Boolean)) {
        if (!canStop) problem("write: every column filled, but no Stop! button on the phone");
        else {
          await sleep(4000);
          await phone.eval(`document.querySelector('[data-act="stop"]').click(); true`);
          await win.until(`!!classes.party.room.peek().stopBy`, 5000).catch(() => problem("Stop! pressed, but the host has no stopBy"));
          stopped = true;
          log("phone: Stop!");
          await sleep(1200);
          await shot(`${tag}-stop`);
        }
      }
    } else if (s.phase === "bell") {
      await sleep(900);
      await shot(tag);
    } else if (s.phase === "grade" && s.stage === "vote") {
      await phone.until(`document.querySelectorAll(".answer").length > 0`, 8000).catch(() => problem(`${tag}: no answers on the phone`));
      await sleep(900);
      const id = await myId();
      const answers = (s.room["answers"] ?? []) as { id: string; who: string[]; texts: string[]; auto?: string }[];
      const others = answers.filter((a) => !a.who.includes(id) && !a.auto);
      const full = s.col < 2 || (shots && s.col < 2);
      if (full) await shot(tag);
      // A star on another's answer, a doubt now and then.
      if (others.length > 0) {
        const k = await phone.eval<number>(`document.querySelectorAll(".answer:not(.mine) .act.star").length`);
        if (k > 0) {
          await phone.eval(`document.querySelectorAll(".answer:not(.mine) .act.star")[0].click(); true`);
          await sleep(500);
        }
        if (!doubted && !shots) {
          doubted = true;
          await phone.eval(`document.querySelectorAll(".answer:not(.mine):not(.auto) .act.doubt")[${others.length > 1 ? 1 : 0}]?.click(); true`);
          await sleep(500);
          log("phone: a doubt and a star");
        }
      }
      if (s.col === 0) {
        await pic(phone, "phone-grade", "phone", 300);
        await shot(`${tag}-starred`, false);
      }
      // Wikipedia, once: on the phone's own answer of a knowable column (the first round), else any.
      const subject = (s.room["columns"]?.[s.col]?.subject ?? "") as string;
      if (!looked && (shots ? s.col === 1 : ["geo", "bio", "home", "music", "media", "sport", "social"].includes(subject) || s.col >= 2)) {
        const mine = answers.find((a) => a.who.includes(id) && a.auto !== "empty") ?? answers.find((a) => a.auto !== "empty");
        if (mine) {
          looked = true;
          await reader(answers.indexOf(mine), mine.texts[0]!, tag);
        }
      }
      await phone.eval(`(() => { const b = document.querySelector('[data-act="done"]'); b?.click(); return !!b; })()`);
      await win.until(`(() => { const g = classes.game; return g.stage !== "vote" || classes.party.room.peek().col !== ${s.col} || classes.party.room.peek().done.length > 0; })()`, 5000);
    } else if (s.phase === "grade" && s.stage === "marked") {
      if (s.col < 2) {
        await sleep(2200);
        await pic(tv, "tv-grade", "tv", 400);
        await shot(tag);
      }
    } else if (s.phase === "report") {
      await sleep(3500);
      await shot(tag);
    }
  }
  if (shots) {
    // The report cards come one by one from the last place: Sam's (first) is the last; then the desk, then the cork board.
    await tv.until(`document.querySelector(".rcard.big .nm")?.textContent === ${JSON.stringify(ME.en)}`, 60_000);
    await sleep(800);
    await still();
    await pic(tv, "tv-final", "tv", 300);
    await tv.until(`!!document.querySelector(".scene.final.cork")?.isConnected`, 30_000);
    await sleep(1500);
    await still();
    await pic(tv, "tv-cork", "tv", 300);
    const want = ["phone-write", "tv-write", "phone-grade", "tv-grade", "tv-wiki", "tv-final", "tv-cork"].filter((x) => !kept.some((f) => f.startsWith(`${x}.`)));
    if (want.length > 0) note(`pictures not taken: ${want.join(", ")}`);
  } else {
    await sleep(2500);
    await shot("final");
    for (const at of [6000, 6000, 8000]) {
      await sleep(at);
      await tvShot("final");
    }
    await phone.eval(`window.scrollTo(0, document.body.scrollHeight); true`);
    await sleep(500);
    await shot("final-end", false);
    const errors = await win.eval<string[]>(`classes.robots.flatMap((b) => b.errors)`);
    if (errors.length > 0) problem(`the bots' errors: ${errors.join(", ")}`);
    const sum = await win.eval<{ cards: number; best: number; players: number }>(`(() => { const s = classes.party.screenView().screen; return { cards: s.cards?.length ?? 0, best: s.best?.length ?? 0, players: classes.party.players.length }; })()`);
    if (sum.cards !== sum.players) problem(`final: ${sum.cards} report cards for ${sum.players} players`);
    log(`final: ${sum.cards} report cards, ${sum.best} best answers`);
  }
  for (const [name, tab] of pages) {
    for (const e of tab.errors.splice(0)) {
      if (/wikipedia\.org|wikimedia\.org/.test(e)) note(`${name}: ${e}`);
      else problem(`${name}: ${e.replace(/:\d+\/favicon/, ":PORT/favicon")}`);
    }
  }
  log(`game over; problems: ${problems.length || "none"}; notes: ${notes.length || "none"}; screenshots in ${out}`);
  if (problems.length > 0) failed = true;
  await win.eval(`document.getElementById("quit")?.click(); true`).catch(() => {});
  await Promise.race([exited, sleep(10_000)]);
} catch (err) {
  failed = true;
  log(`FAILED: ${(err as Error).stack ?? String(err)}`);
} finally {
  writeFileSync(`${out}/tvpipe.log`, tvpipeLog.join("\n"));
  writeFileSync(`${out}/problems.txt`, [...problems.map((p) => `PROBLEM ${p}`), ...notes.map((x) => `note ${x}`)].join("\n"));
  browser.close();
  proc.kill();
}
process.exit(failed ? 1 : 0);
