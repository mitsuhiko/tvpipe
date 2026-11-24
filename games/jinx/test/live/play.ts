/**
 * A live check of Jinx on `tvpipe game play` (not part of `npm test`):
 * tvpipe serves the bundle (`dist/`); a headless Chrome plays the window
 * (the launcher, then the host page, which adds the bots), one phone
 * (joining, drawing a face, starting as the VIP, writing clues with a
 * refusal and a bold one, turning cards, typing a guess letter by letter,
 * picking the best clue, playing again) and the TV: the `browser`
 * receiver's player page, so the picture went through tvpipe's own
 * headless Chrome, the capture and the stream. Screenshots of the host
 * window, the TV (the stream, and the TV page itself) and the phone per
 * phase; every shot also checks the layout (the phone, also at 320 px wide,
 * and the TV page: no text running out of its box, nothing off the
 * screen, nothing under tvpipe's join badge in the bottom-left corner),
 * the secrecy of the word on the TV, and every tab's errors (over
 * DevTools: exceptions, console errors, failed loads); the bots' refused
 * actions fail the run too. Every tab has a window of its own (headless
 * Chrome animates only a window's front tab).
 *
 *   npm run build && node test/live/play.ts [--bots N] [--rounds auto|1|2] [--lang en|de] [--long] [--out DIR] [--shots DIR]
 *
 * `--bots 7`: a full table (8 players): the seats of the write scene and
 * the verdict, two rows of cards, beside the join badge.
 *
 * `--long`: the longest secret words of the language's list are dealt
 * (the window's fetch of the list answered with them only), the bots and
 * the phone write clues of 18–24 letters and guess the long word: to see
 * that no word is cut off or broken on the TV or the phone.
 *
 * `--lang de`: the room in German (the host page's Language setting), the
 * phone's browser in German, German clues and guesses; screenshots in
 * /tmp/jinx-live-de.
 *
 * `--shots DIR`: the pictures for the games list (docs/game-catalog.md)
 * into DIR: `tv-reveal` (the TV page), `phone-lobby` and `phone-guess`;
 * the game ends there. The round is then a fixed one (`scenario.ts`: the
 * word, the other players' names, faces and clues, the cards Phil turns),
 * the other players not marked as bots on the TV. With `--bots 7` the table is full:
 *
 *   node test/live/play.ts --bots 7 --shots ../../site/static/games/jinx
 *
 * Needs Chrome and tvpipe built (target/release, else target/debug, or
 * TVPIPE_BINARY).
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { CATEGORY_DE } from "../../game/bots.ts";
import { Browser, type Tab } from "./browser.ts";
import * as scenario from "./scenario.ts";
import { keep } from "./shots.ts";
import { tie } from "./tie.ts";

const { values: args } = parseArgs({
  options: {
    bots: { type: "string", default: "3" },
    rounds: { type: "string", default: "1" },
    out: { type: "string" },
    shots: { type: "string" },
    lang: { type: "string", default: "en" },
    long: { type: "boolean", default: false },
  },
});
const de = args.lang === "de";
/** The phone's texts that the checks look for, per language. */
const texts = de
  ? { fate: /überlebt|gejinxt/i, result: /richtig!|daneben|hat's|gepasst|alle weg/i, again: /nochmal/i, over: "vorbei" }
  : { fate: /survived|jinxed/i, result: /right!|not it|got it|missed it|passed|all jinxed/i, again: /again/i, over: "over" };

const here = new URL("../../", import.meta.url);
const repo = new URL("../../", here);
const exe = process.platform === "win32" ? "tvpipe.exe" : "tvpipe";
const binary =
  process.env["TVPIPE_BINARY"] ??
  ["release", "debug"].map((p) => fileURLToPath(new URL(`target/${p}/${exe}`, repo))).find((p) => existsSync(p));
if (!binary) throw new Error("build tvpipe first (cargo build --release -p tvpipe-cli)");
const bundle = fileURLToPath(here);
const out = args.out ?? `/tmp/jinx-live${de ? "-de" : ""}${args.long ? "-long" : ""}`;
if (args.long && args.shots) throw new Error("--long and --shots: one at a time");
/** --long: clues of 18–24 letters (German compounds), and wrong guesses as long. */
const LONG = de
  ? ["Donaudampfschifffahrt", "Geschirrspülmaschine", "Weihnachtsbaumschmuck", "Streichholzschächtelchen", "Rindfleischetikettierung", "Sonnenblumenkernbrot", "Feuerwehrhauptmann", "Eichhörnchenfutter"]
  : ["incomprehensibilities", "electroencephalograph", "counterrevolutionary", "uncharacteristically", "internationalization", "telecommunications", "photosynthesizing", "overenthusiastically"];
mkdirSync(out, { recursive: true });
if (args.shots) mkdirSync(args.shots, { recursive: true });
const nBots = Number(args.bots);
const t0 = Date.now();
const log = (m: string) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)} ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// tvpipe game play, the window left to us (--window none prints its URL).
const proc = tie(spawn(binary, ["-v", "game", "play", bundle, "--window", "none", "--no-tunnel"], { stdio: ["ignore", "pipe", "pipe"] }));
const exited = new Promise<number | null>((r) => proc.on("exit", (c) => r(c)));
const tvpipeLog: string[] = [];
const tvpipeProblems: string[] = [];
createInterface({ input: proc.stderr! }).on("line", (l) => {
  tvpipeLog.push(l);
  if (/ (WARN|ERROR) /.test(l)) tvpipeProblems.push(l);
  if (/ (WARN|ERROR) |playshare: /.test(l)) log(`tvpipe: ${l.replace(/^\s*\S+ /, "")}`);
});
const start = await new Promise<string>((resolve, reject) => {
  createInterface({ input: proc.stdout! }).once("line", resolve);
  exited.then(() => reject(new Error(`tvpipe exited:\n${tvpipeLog.join("\n")}`)));
});
log(`tvpipe game play games/jinx: ${start.replace(/t=.*/, "t=…")}`);

const browser = await Browser.launch();
let failed = false;
const problems: string[] = [];
const problem = (p: string) => {
  if (problems.includes(p)) return;
  problems.push(p);
  log(`PROBLEM ${p}`);
};
const tabs: [string, Tab][] = [];
const reportErrors = () => {
  for (const [name, tab] of tabs) {
    for (const e of tab.errors.splice(0)) problem(`${name} console: ${e.replace(/:\d+\/favicon/, ":PORT/favicon")}`);
  }
};
/**
 * --long: the window's word lists hold their 16 longest words only
 * (headers kept), over the DevTools Fetch domain: the deck deals them.
 * Call before the host page loads.
 */
async function dealLong(win: Tab): Promise<void> {
  type Paused = { requestId: string; request: { url: string }; responseStatusCode?: number; responseHeaders?: { name: string; value: string }[] };
  const answer = async (p: Paused): Promise<void> => {
    if (p.responseStatusCode !== 200) return void (await win.send("Fetch.continueRequest", { requestId: p.requestId }));
    const body = (await win.send("Fetch.getResponseBody", { requestId: p.requestId })) as { body: string; base64Encoded: boolean };
    const text = body.base64Encoded ? Buffer.from(body.body, "base64").toString("utf8") : body.body;
    const lines = text.split("\n").filter((l) => l.trim() !== "");
    const head = lines.filter((l) => l.startsWith("#"));
    const words = lines.filter((l) => !l.startsWith("#")).sort((a, b) => [...b.split("\t")[0]!].length - [...a.split("\t")[0]!].length).slice(0, 16);
    log(`--long: ${p.request.url.replace(/.*\//, "")}: ${words.map((l) => l.split("\t")[0]).join(", ")}`);
    await win.send("Fetch.fulfillRequest", {
      requestId: p.requestId,
      responseCode: 200,
      responseHeaders: (p.responseHeaders ?? []).filter((h) => !/^content-(length|encoding)$/i.test(h.name)),
      body: Buffer.from([...head, ...words].join("\n") + "\n").toString("base64"),
    });
  };
  win.on("Fetch.requestPaused", (p: Paused) => void answer(p).catch((e: Error) => problem(`--long: ${p.request.url}: ${e.message}`)));
  await win.send("Fetch.enable", { patterns: [{ urlPattern: "*/data/words*.txt*", requestStage: "Response" }] });
}

type HostMon = { at: number; phase: string; round: number; until: number; task: string; secret: string; guesser: boolean };
type PhoneMon = { at: number; fate: boolean; result: boolean; text: string };
/**
 * The phones' secrecy over time: no jinx fate (the fate screen, or the
 * guesser's "survived"/"jinxed" counts) before the TV's jinx `until` − 1.5 s,
 * no word or result before the verdict's start + 3 s; on the phone's
 * screen, and on the host (Phil's task), which sets it the TV's lag
 * earlier (`party.withTv`: the phone applies it when the TV shows it).
 */
async function timing(win: Tab, phone: Tab): Promise<void> {
  const FATE_BEFORE = 1500;
  const RESULT_AFTER = 3000;
  const SLACK = 120; // the monitors' poll and the view's way to the phone
  const verdictMs = await win.eval<number>(`jinx.game.timings.verdict`);
  const lag = await win.eval<number>(`jinx.party.tvDelay`);
  const host = await win.eval<HostMon[]>(`globalThis.__mon`);
  const ph = await phone.eval<PhoneMon[]>(`globalThis.__mon`);
  // The windows: per round, from the jinx (or verdict) start to its limit.
  const windows: { what: string; from: number; to: number; secret: string; round: number }[] = [];
  for (let i = 0; i < host.length; i++) {
    const e = host[i]!;
    const prev = host[i - 1];
    if (prev && prev.phase === e.phase && prev.round === e.round) continue;
    if (e.phase === "jinx" && e.until) windows.push({ what: "jinx", from: e.at, to: e.until - FATE_BEFORE, secret: e.secret, round: e.round });
    if (e.phase === "verdict" && e.until) {
      const start = e.until - verdictMs;
      windows.push({ what: "verdict", from: e.at, to: start + RESULT_AFTER, secret: e.secret, round: e.round });
    }
  }
  let seenFate = 0;
  let seenResult = 0;
  for (const w of windows) {
    for (const e of host) {
      if (!(e.at >= w.from && e.at < w.to - lag - SLACK)) continue;
      if (w.what === "jinx" && (e.task === "fate" || e.task === "check")) problem(`timing: round ${w.round}: Phil's task was ${e.task} ${w.to - lag - e.at} ms before the TV's jinx until − 1.5 s − the TV's lag (${lag} ms)`);
      if (w.what === "verdict" && e.task === "result") problem(`timing: round ${w.round}: Phil's task was result ${w.to - lag - e.at} ms before verdict start + 3 s − the TV's lag (${lag} ms)`);
    }
    // The phone's screen, sampled every 40 ms (after 400 ms: the new view's way to the phone).
    for (let t = w.from + 400; t < w.to - SLACK; t += 40) {
      const e = ph.filter((x) => x.at <= t).at(-1);
      if (!e) continue;
      const ms = w.to - t;
      const say = (what: string) => problem(`timing: round ${w.round}: the phone showed ${what} ${ms} ms early: ${JSON.stringify(e.text.slice(0, 80))}`);
      if (w.what === "jinx" && (e.fate || texts.fate.test(e.text))) {
        say("the jinx fate");
        break;
      }
      if (w.what === "verdict" && (e.result || texts.result.test(e.text))) {
        say("the result");
        break;
      }
      if (w.what === "verdict" && w.secret && new RegExp(`\\b${w.secret}\\b`, "i").test(e.text)) {
        say(`the word "${w.secret}"`);
        break;
      }
    }
    const after = ph.filter((e) => e.at >= w.to && e.at < w.to + 4000);
    if (w.what === "jinx" && after.some((e) => e.fate || texts.fate.test(e.text))) seenFate++;
    if (w.what === "verdict" && after.some((e) => e.result)) seenResult++;
  }
  const jinxes = windows.filter((w) => w.what === "jinx").length;
  const verdicts = windows.filter((w) => w.what === "verdict").length;
  log(`timing: ${jinxes} jinx checks (the phone's fate came after the limit in ${seenFate}), ${verdicts} verdicts (the result came after the limit in ${seenResult})`);
  if (seenFate < jinxes || seenResult < verdicts) problem(`timing: the phone did not show every fate (${seenFate}/${jinxes}) or result (${seenResult}/${verdicts}) once allowed`);
}

try {
  // The window: the launcher first.
  const win = await browser.open(start, { width: 1280, height: 800 });
  tabs.push(["host window", win]);
  if (args.shots) await scenario.deal(win);
  if (args.long) await dealLong(win);
  await win.until(`document.querySelectorAll("#devices .device").length > 0`);
  await sleep(1500); // a discovery round: real TVs show up too
  await win.screenshot(`${out}/launcher.png`);
  const listed = await win.eval<string[]>(`[...document.querySelectorAll("#devices .device")].map((d) => d.dataset.name)`);
  log(`launcher lists: ${listed.join(", ")}`);
  // Only the browser receiver (no real TV without asking).
  await win.eval(`document.querySelector('#devices .device[data-name="browser"]').click(); true`);
  await win.until(`!document.getElementById("start").disabled`);
  await win.eval(`document.getElementById("start").click(); true`);
  await win.until(`location.pathname.endsWith("/host/index.html") && !!globalThis.jinx`, 20_000);
  log("the host page runs the game");
  // Settings, as the host page sets them.
  await win.eval(
    `(() => { jinx.page.set("rounds", ${JSON.stringify(args.rounds)}); jinx.page.set("write", 30); return true; })()`,
  );
  await win.until(`jinx.game.rounds === ${JSON.stringify(args.rounds === "auto" ? "auto" : Number(args.rounds))} && jinx.game.timings.write === 30000`);
  // The room's language, as the host page sets it (German needs its word list).
  await win.eval(`(() => { jinx.page.set("lang", ${JSON.stringify(args.lang)}); return true; })()`);
  await win.until(`jinx.game.lang === ${JSON.stringify(args.lang)}`, 5000);
  const links = await win.eval<{ join: string; watch: string; code: string }>(`({ join: jinx.party.links.join, watch: jinx.party.links.watch, code: jinx.party.code })`);
  log(`room ${links.code}, phones join at ${links.join.replace(/#.*/, "#k=…")}`);
  // The TV: the browser receiver's player page, once the cast streams.
  await win.until(`!document.getElementById("player").hidden`, 60_000);
  const playerUrl = await win.eval<string>(`document.getElementById("player").href`);
  const tv = await browser.open(playerUrl, { width: 1280, height: 720 });
  tabs.push(["tv stream", tv]);
  log(`TV: ${playerUrl.replace(/t=.*/, "t=…")}`);
  // The TV page itself (the watch link, muted, as the host's preview): crisp shots and layout checks.
  const screen = await browser.open(`${links.watch}&mute=1`, { width: 1280, height: 720 });
  tabs.push(["tv page", screen]);
  // A phone (through the phones' listener, as the QR code says).
  const PHONE = { width: 390, height: 844, mobile: true };
  const phone = await browser.open(links.join, { ...PHONE, locale: de ? "de-DE" : "en-US" });
  tabs.push(["phone", phone]);
  await phone.until(`!!document.getElementById("name")`, 20_000);
  await phone.screenshot(`${out}/phone-join.png`);
  await phone.eval(`document.getElementById("name").value = "Phil"; document.querySelector("form.join button").click(); true`);
  await phone.until(`!!document.querySelector("canvas.pad")`);
  log("phone: joined as Phil (the VIP)");

  // Draws a face on the lobby's pad (touch).
  const box = await phone.eval<{ x: number; y: number; w: number }>(
    `(() => { const r = document.querySelector("canvas.pad").getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width }; })()`,
  );
  const pt = (a: number, b: number): [number, number] => [box.x + a * box.w, box.y + b * box.w];
  if (args.shots) await scenario.drawPhil(phone, box);
  else {
    await phone.drag([pt(0.36, 0.38), pt(0.38, 0.42), pt(0.36, 0.44)]);
    await phone.drag([pt(0.62, 0.38), pt(0.64, 0.42), pt(0.62, 0.44)]);
    await phone.drag(Array.from({ length: 14 }, (_, i) => pt(0.3 + (0.4 * i) / 13, 0.62 + 0.1 * Math.sin((i / 13) * Math.PI))));
  }
  const faceStrokes = args.shots ? scenario.PHIL.length : 3;
  await win.until(`jinx.party.screen.peek().people?.find((p) => p.name === "Phil")?.face?.strokes?.length === ${faceStrokes}`);
  log(`phone: drew a face (${faceStrokes} strokes on the TV's view)`);

  // Bots, as the host page adds them; for the pictures with people's names and unmarked (no dashed rim on the TV).
  if (args.shots) {
    if (nBots !== scenario.PLAYERS.length || de) throw new Error(`--shots plays scenario.ts (in English): --bots ${scenario.PLAYERS.length}`);
    await win.eval(scenario.joinScript());
    await win.until(`jinx.party.players.length >= ${nBots + 1}`);
  }
  for (let left = args.shots ? 0 : nBots; left > 0; ) {
    const n = left >= 3 ? 3 : 1;
    const before = await win.eval<number>(`jinx.party.players.length`);
    await win.eval(`document.getElementById(${JSON.stringify(n === 3 ? "bot3" : "bot1")}).click(); true`);
    await win.until(`jinx.party.players.length >= ${before + n}`);
    left -= n;
  }
  log(`${nBots} bots joined from the host page`);
  if (args.long) {
    // The bots' random clues and wrong guesses: long words (their dictionary is the window's).
    await win.eval(`(() => { jinx.dict[${JSON.stringify(args.lang)}] = ${JSON.stringify(LONG)}; return true; })()`);
  }

  /**
   * Layout problems in the page: text running out of the box it is drawn
   * on (the nearest ancestor with a background or a border, or one that
   * clips), text or buttons off the screen. Text being animated is skipped
   * (cards flying in), and so is text clipped with an ellipsis on purpose.
   */
  const layout = `(() => {
    const out = [];
    const W = innerWidth, H = innerHeight;
    if (document.documentElement.scrollWidth > W + 1) out.push("the page is wider than the screen: " + document.documentElement.scrollWidth);
    const visual = (e) => {
      const cs = getComputedStyle(e);
      return cs.overflowX !== "visible" || cs.backgroundImage !== "none" || !/rgba\\(.*, 0\\)$|transparent/.test(cs.backgroundColor) || parseFloat(cs.borderLeftWidth) > 0 && parseFloat(cs.borderRightWidth) > 0;
    };
    const animated = (e) => { for (let p = e; p; p = p.parentElement) if (p.getAnimations().some((x) => x.playState === "running" && !(x.effect?.getComputedTiming().iterations === Infinity))) return true; return false; };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const seen = new Set();
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      const el = t.parentElement;
      if (!el || !t.textContent.trim() || seen.has(el)) continue;
      seen.add(el);
      if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      if (el.closest("svg, script, style, option, select")) continue;
      const cs = getComputedStyle(el);
      if (cs.textOverflow === "ellipsis" || cs.webkitLineClamp !== "none") {
        // Names may be cut (they are short()ened anyway); anything else players read never.
        const name = el.closest(".seatname, .who-guesses, .name, .who, .n, .gone");
        if (!name && el.scrollWidth > el.clientWidth + 1) out.push("cut with an ellipsis: " + el.localName + "." + String(el.className).trim().split(/\s+/).join(".") + " " + JSON.stringify(t.textContent.trim().slice(0, 40)));
        continue;
      }
      const range = document.createRange();
      range.selectNodeContents(t);
      const r = range.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (animated(el)) continue;
      const text = JSON.stringify(t.textContent.trim().slice(0, 40));
      const what = el.localName + (el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\\s+/).join(".") : "");
      let box = el;
      while (box && box !== document.body && !visual(box)) box = box.parentElement;
      if (box && box !== document.body) {
        const b = box.getBoundingClientRect();
        const bs = getComputedStyle(box);
        const scrolls = /auto|scroll/.test(bs.overflowX + bs.overflowY);
        if (!scrolls && (r.left < b.left - 2 || r.right > b.right + 2)) out.push("text out of its box: " + what + " " + text + " in " + box.localName + "." + String(box.className).trim().split(/\\s+/).join(".") + " (" + Math.round(r.left - b.left) + ", " + Math.round(b.right - r.right) + " px)");
      }
      let scroller = el.parentElement;
      while (scroller && !/auto|scroll/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
      if (r.right > W + 2 || r.left < -2 || (!scroller && (r.top < -2 || r.bottom > H + 2))) out.push("text off the screen: " + what + " " + text + " " + [r.left, r.top, r.right, r.bottom].map(Math.round).join(","));
    }
    for (const el of document.querySelectorAll("button, input")) {
      if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) || animated(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && (r.right > W + 2 || r.left < -2)) out.push("off the side: " + el.localName + "." + el.className + " " + JSON.stringify((el.innerText || el.value || "").trim().slice(0, 30)));
    }
    return out;
  })()`;
  /**
   * The TV page: nothing of the picture under tvpipe's join badge (its
   * card bottom left): text, chips, cards, labels.
   */
  const underBadge = `(() => {
    const out = [];
    const mini = document.querySelector("tvpipe-rejoin")?.shadowRoot?.querySelector(".mini.shown");
    if (!mini || !document.documentElement.hasAttribute("data-tvpipe-join")) return out;
    const b = mini.getBoundingClientRect();
    if (b.width === 0) return out;
    const hit = (r) => r.width > 0 && r.height > 0 && r.left < b.right - 1 && r.right > b.left + 1 && r.top < b.bottom - 1 && r.bottom > b.top + 1;
    const animated = (e) => { for (let p = e; p; p = p.parentElement) if (p.getAnimations().some((x) => x.playState === "running" && !(x.effect?.getComputedTiming().iterations === Infinity))) return true; return false; };
    const layer = [...document.querySelectorAll(".stage .layer")].at(-1);
    const scope = [layer, ...document.querySelectorAll(".stage .head, .stage .pot, .stage .hostline")].filter(Boolean);
    const seen = new Set();
    for (const root of scope) {
      for (const el of root.querySelectorAll("*")) {
        if (el.closest("svg") || el.closest(".burst, .zone, .yarn") || !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
        const cs = getComputedStyle(el);
        const solid = !/rgba\(.*, 0\)$|transparent/.test(cs.backgroundColor) || cs.backgroundImage !== "none";
        const text = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
        if (!solid && !text) continue;
        const r = el.getBoundingClientRect();
        if (r.width > 900 || r.height > 500 || !hit(r) || animated(el)) continue;
        const what = el.localName + (typeof el.className === "string" && el.className ? "." + el.className.trim().split(/\s+/).join(".") : "");
        const key = what + el.textContent.trim().slice(0, 20);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push("under the join badge: " + what + " " + JSON.stringify(el.textContent.trim().slice(0, 30)) + " " + [r.left, r.top, r.right, r.bottom].map(Math.round).join(","));
      }
    }
    return out;
  })()`;
  const check = async (where: string, tab: Tab) => {
    const found = await tab.eval<string[]>(layout).catch((e: Error) => [`cannot check: ${e.message.slice(0, 120)}`]);
    if (tab === screen) found.push(...(await tab.eval<string[]>(underBadge).catch((e: Error) => [`cannot check the badge: ${e.message.slice(0, 120)}`])));
    for (const f of found) problem(`${where}: ${f}`);
  };
  /** The TV page must not show the secret word before the verdict. */
  const secrecy = async (where: string) => {
    const s = await win.eval<{ phase: string; secret?: string }>(`({ phase: jinx.game.phase, secret: jinx.game.secret })`);
    if (!s.secret || !["hotseat", "write", "jinx", "reveal"].includes(s.phase)) return;
    const text = await screen.eval<string>(`document.body.innerText`);
    if (new RegExp(`\\b${s.secret}\\b`, "i").test(text)) problem(`tv ${where}: the TV shows the secret word "${s.secret}" in ${s.phase}`);
  };
  const shots: string[] = [];
  const kept: string[] = [];
  const pic = async (tab: Tab, name: string, kind: "tv" | "phone", settle?: number) => {
    if (!args.shots || kept.some((f) => f.startsWith(`${name}.`))) return;
    kept.push(await keep(tab, args.shots, name, kind, settle));
    log(`picture: ${kept.at(-1)}`);
  };
  const shot = async (name: string, o: { secret?: boolean; wait?: number } = {}) => {
    await sleep(o.wait ?? 1500); // the TV is a stream: a little behind
    await Promise.all([
      tv.screenshot(`${out}/tv-${name}.png`),
      screen.screenshot(`${out}/screen-${name}.png`),
      win.screenshot(`${out}/host-${name}.png`),
      phone.screenshot(`${out}/phone-${name}.png`),
    ]);
    if (o.secret !== false) await secrecy(name);
    await check(`phone ${name}`, phone);
    await check(`tv ${name}`, screen);
    // A small phone (320 px wide, an iPhone SE).
    await phone.resize({ width: 320, height: 568, mobile: true });
    await sleep(300);
    await phone.screenshot(`${out}/phone-small-${name}.png`);
    await check(`small phone ${name}`, phone);
    await phone.resize(PHONE);
    reportErrors();
    shots.push(name);
    log(`screenshots: ${name}`);
  };
  await shot("lobby");
  await pic(phone, "phone-lobby", "phone");

  // The VIP's settings on the phone (below the table; language, rounds, writing time, words, latecomers): words easy, then back to normal, from the phone.
  if (!args.shots) {
    await phone.until(`!!document.querySelector("section.settings:not([hidden])")`, 5000).catch(() => problem("phone lobby: the VIP has no settings"));
    const pick = async (key: number, i: number) => {
      await phone.eval(`(() => { const s = document.querySelectorAll("section.settings .setting")[${key}]; s.scrollIntoView({ block: "center" }); s.querySelectorAll(".seg button")[${i}].click(); return true; })()`);
      await phone.until(`document.querySelectorAll("section.settings .setting")[${key}].querySelectorAll(".seg button")[${i}].classList.contains("on")`, 5000);
    };
    await pick(3, 0);
    await win.until(`jinx.game.difficulty === "easy"`, 3000).catch(() => problem("phone lobby: the VIP's words setting did not reach the game"));
    await sleep(300);
    await phone.screenshot(`${out}/phone-lobby-settings.png`);
    await check("phone lobby settings", phone);
    await phone.resize({ width: 320, height: 568, mobile: true });
    await sleep(300);
    await phone.eval(`document.querySelector("section.settings").scrollIntoView({ block: "end" }); true`);
    await phone.screenshot(`${out}/phone-small-lobby-settings.png`);
    await check("small phone lobby settings", phone);
    await phone.resize(PHONE);
    await pick(3, 1);
    await win.until(`jinx.game.difficulty === "normal"`, 3000).catch(() => problem("phone lobby: the VIP's words setting did not reach the game"));
    log("phone: the VIP's settings (words easy, then normal)");
  }

  // Timing monitors (every 40 ms, Date.now() in both tabs, one machine):
  // the host's screen phase with its deadlines and Phil's task; the phone's
  // screen. Checked after the game (see `timing`).
  await win.eval(`(() => {
    const log = (globalThis.__mon = []);
    let last = "";
    setInterval(() => {
      const s = jinx.party.screen.peek();
      const phil = jinx.party.players.find((p) => p.name === "Phil");
      const task = phil?.state.peek()?.task ?? "";
      const off = Date.now() - jinx.party.now();
      const e = { phase: s.phase, round: s.round ?? 0, until: typeof s.until === "number" ? Math.round(s.until + off) : 0, task, secret: jinx.game.secret ?? "", guesser: s.guesser === phil?.id };
      const k = JSON.stringify(e);
      if (k !== last) { last = k; log.push({ at: Date.now(), ...e }); }
    }, 40);
    return true;
  })()`);
  await phone.eval(`(() => {
    const log = (globalThis.__mon = []);
    let last = "";
    setInterval(() => {
      const main = document.querySelector("#main");
      const e = { fate: !!document.querySelector(".fates"), result: !!document.querySelector("#main .points"), text: (main?.innerText ?? "").replace(/\\s+/g, " ").slice(0, 400) };
      const k = JSON.stringify(e);
      if (k !== last) { last = k; log.push({ at: Date.now(), ...e }); }
    }, 40);
    return true;
  })()`);
  log("timing monitors on the host and the phone");

  // Phil (the VIP) starts from the phone.
  await phone.until(`(() => { const b = [...document.querySelectorAll("#dock button.primary")].find((b) => !b.hidden); return b && !b.disabled; })()`);
  log(`phone: "${await phone.eval<string>(`[...document.querySelectorAll("#dock button.primary")].find((b) => !b.hidden).textContent`)}"`);
  await phone.eval(`[...document.querySelectorAll("#dock button.primary")].find((b) => !b.hidden).click(); true`);

  const state = () =>
    win.eval<{ phase: string; round?: number; step?: string; guesser?: string; phil?: string; secret?: string; draft?: string }>(
      `(() => { const s = jinx.party.screen.peek(); const phil = jinx.party.players.find((p) => p.name === "Phil"); return { phase: s.phase, round: s.round, step: s.step, guesser: s.guesser, phil: phil?.id, secret: jinx.game.secret, draft: s.draft }; })()`,
    );
  // The words' categories (the bots write them now and then): the phone writes one too, to jinx with a bot.
  const category = new Map(
    readFileSync(new URL(`dist/data/${de ? "words.de.txt" : "words.txt"}`, here), "utf8")
      .split("\n")
      .map((l) => l.split("\t"))
      .filter((f) => f.length >= 3)
      .map((f) => [f[0]!, de ? (CATEGORY_DE[f[2]!] ?? f[2]!) : f[2]!]),
  );
  let writeRounds = 0;
  const clueWords = args.long
    ? LONG
    : de
    ? ["Galaxie", "Flüstern", "Gurke", "Laterne", "Samt", "Donner", "Kompass", "Keks", "Umlaufbahn", "Wiese"]
    : ["galaxy", "whisper", "pickle", "lantern", "velvet", "thunder", "compass", "biscuit", "orbit", "meadow"];
  let clueN = 0;
  let boldDone = false;
  let rejected = false;
  let guesserRounds = 0;

  /** The phone writes its clue(s): the secret word first (refused), then real ones, one bold. */
  const writeClues = async (at: string) => {
    await phone.until(`!!document.querySelector(".slot input")`, 10_000);
    const word = await phone.eval<string>(`document.querySelector(".index .word").textContent`);
    const slots = await phone.eval<number>(`document.querySelectorAll(".slot").length`);
    writeRounds++;
    for (let i = 0; i < slots; i++) {
      const sel = `document.querySelectorAll(".slot")[${i}]`;
      if (!(await phone.eval<boolean>(`!!${sel}`))) break;
      if (!rejected) {
        // The word itself: refused, the reason on the phone.
        await phone.eval(`${sel}.querySelector("input").focus(); true`);
        await phone.type(word.toUpperCase().slice(0, 1) + word.slice(1) + "s", 40);
        await phone.eval(`${sel}.querySelector("button.send").click(); true`);
        await phone.until(`${sel}.querySelector(".line").classList.contains("error") && ${sel}.querySelector(".line").textContent.length > 0`);
        const why = await phone.eval<string>(`${sel}.querySelector(".line").textContent`);
        log(`phone: "${word}s" refused: ${why}`);
        await shot(`${at}-write-refused`, { wait: 300 });
        rejected = true;
      }
      for (let attempt = 0; attempt < 4; attempt++) {
        // From the second writing round on, the word's category first (bots write it too: a jinx, likely).
        let clue = writeRounds >= 2 && attempt === 0 && i === 0 && category.get(word) ? category.get(word)! : clueWords[clueN++ % clueWords.length]!;
        if (clue === word) clue = clueWords[clueN++ % clueWords.length]!;
        await phone.eval(`(() => { const i = ${sel}.querySelector("input"); i.value = ""; i.focus(); return true; })()`);
        await phone.type(clue, 30);
        const bold = !boldDone;
        if (bold) await phone.eval(`${sel}.querySelector(".boldtoggle").click(); true`);
        await phone.eval(`${sel}.querySelector("button.send").click(); true`);
        // Accepted: the sent card, or (the last clue in) the phase moves on and the slot is gone.
        const ok = await phone
          .until(`!${sel} || !${sel}.querySelector(".sent").hidden || ${sel}.querySelector(".line").classList.contains("error")`, 5000)
          .then(() => phone.eval<boolean>(`!${sel} || !${sel}.querySelector(".sent").hidden`));
        if (ok) {
          if (bold) boldDone = true;
          log(`phone: clue ${i + 1} "${clue}"${bold ? " (bold)" : ""} for "${word}"`);
          break;
        }
        log(`phone: "${clue}" refused: ${await phone.eval<string>(`${sel}.querySelector(".line").textContent`)}`);
        if (bold) await phone.eval(`${sel}.querySelector(".boldtoggle").click(); true`);
      }
    }
  };

  /** The phone guesses: turns one or two cards, types the guess letter by letter (a typo fixed with backspace), guesses. */
  const playGuesser = async (at: string) => {
    guesserRounds++;
    await phone.until(`!!document.querySelector(".cards") && document.querySelectorAll(".cards .card").length > 0`, 10_000);
    await shot(`${at}-reveal-start`);
    const cards = await phone.eval<number>(`document.querySelectorAll(".cards .card").length`);
    const turn = args.shots ? scenario.TURN.length : Math.min(cards, 2);
    for (let i = 0; i < turn; i++) {
      await phone.until(`!!document.querySelector(".cards button.card.down:not([disabled])")`);
      // The scenario's cards by author, else the first face-down one.
      const by = args.shots ? JSON.stringify(scenario.TURN[i]) : "null";
      const picked = Date.now();
      await phone.eval(`[...document.querySelectorAll(".cards button.card.down")].find((b) => ${by} === null || b.querySelector(".who")?.textContent === ${by}).click(); true`);
      // The guesser's phone turns the card at once (its word there), and keeps it lifted, with no
      // lock-in, until the TV has turned it too.
      await phone.until(`!!document.querySelector(".cards .card.turning")`, 3000).catch(() => problem("reveal: the picked card does not lift on the phone"));
      await phone.until(`document.querySelectorAll(".cards .card.turned").length === ${i + 1}`);
      const ms = Date.now() - picked;
      if (i === 0) await shot(`${at}-reveal-turning`);
      const flip = await win.eval<number>(`jinx.game.timings.flip + jinx.party.tvDelay`);
      if (ms > 600) problem(`reveal: the guesser's phone showed the word ${ms} ms after the pick (not at once)`);
      await phone.until(`!document.querySelector(".cards .card.turning")`, flip + 3000);
      const lockIn = Date.now() - picked;
      if (lockIn < flip - 150) problem(`reveal: the guesser could lock in ${lockIn} ms after the pick, before the TV's flip (${flip} ms)`);
      await win.until(`jinx.party.screen.peek().cards?.filter((c) => c.turned).length === ${i + 1}`);
      log(`phone: turned card ${i + 1} of ${cards}: "${await phone.eval<string>(`[...document.querySelectorAll(".cards .card.turned .word")].at(-1).textContent`)}" (its word ${ms} ms after the pick, lock-in after ${lockIn} ms; the TV's flip and lag: ${flip} ms)`);
      if (i === 0) await shot(`${at}-reveal-turned`, { wait: 2500 });
    }
    const secret = (await state()).secret!;
    if (args.shots && secret !== scenario.WORD) problem(`shots: the word is "${secret}", not the scenario's "${scenario.WORD}" (dealt from ${scenario.dealt.join(", ") || "no list"})`);
    // The first time right (a wrong letter first, deleted), later a wrong guess.
    const right = guesserRounds === 1;
    const [wrong1, wrong2] = args.long ? [LONG[0]!, LONG[1]!] : de ? ["Elefant", "Giraffe"] : ["elephant", "giraffe"];
    const guess = right ? secret : secret === wrong1 ? wrong2 : wrong1;
    await phone.eval(`document.querySelector("input.tape-field").focus(); true`);
    const half = Math.ceil(guess.length / 2);
    await phone.type(guess.slice(0, half), 150);
    await phone.type("x", 0);
    await sleep(400);
    await phone.backspace();
    await sleep(300);
    const draftNow = await win.eval<string>(`jinx.party.screen.peek().draft`);
    if (draftNow !== guess.slice(0, half)) problem(`reveal: the TV's draft is "${draftNow}" after typing "${guess.slice(0, half)}x" and a backspace`);
    await shot(`${at}-reveal-draft-half`, { secret: false, wait: 1200 });
    const tape = await screen.eval<string>(`[...document.querySelectorAll(".dymo .l:not(.gone)")].map((l) => l.textContent).join("")`);
    if (tape !== guess.slice(0, half).toUpperCase()) problem(`tv reveal: the label tape says "${tape}", the draft is "${guess.slice(0, half)}"`);
    await phone.type(guess.slice(half), 150);
    await win.until(`jinx.party.screen.peek().draft === ${JSON.stringify(guess)}`, 3000).catch(() => problem(`reveal: the TV's draft did not reach "${guess}"`));
    await shot(`${at}-reveal-draft`, { secret: false, wait: 1200 });
    await pic(phone, "phone-guess", "phone");
    await pic(screen, "tv-reveal", "tv");
    await phone.eval(`document.querySelector("form.editor button.primary").click(); true`);
    log(`phone: guessed "${guess}" (${right ? "right" : "wrong"}) after ${turn} card(s)`);
  };

  /**
   * Dropping out (not with --shots): at the first write a bot's phone
   * goes for 9 s and comes back by name (its token lost, as on another
   * phone): the TV still shows the join badge, the host page a Rejoin button
   * (Phil's phone stays: the timing check watches it).
   */
  const dropped = new Set<string>();
  const rejoin = de ? "Rückkehrcode" : "Rejoin code";
  const rejoinChecks = async (phase: string, at: string) => {
    if (args.shots) return;
    if (phase === "write" && !dropped.has("bot")) {
      dropped.add("bot");
      const name = await win.eval<string>(`(() => { const b = jinx.robots[0]; b.client.drop({ away: 9000, forget: true }); return b.name; })()`);
      log(`${name}'s phone dropped out (back by name in 9 s)`);
      await sleep(6000);
      await Promise.all([tv.screenshot(`${out}/tv-${at}-rejoin.png`), screen.screenshot(`${out}/screen-${at}-rejoin.png`)]);
      const badge = await screen.eval<string>(`(() => { const r = document.querySelector("tvpipe-rejoin")?.shadowRoot; return r?.querySelector(".card") ? "a rejoin card" : r?.querySelector(".mini.shown")?.innerText ?? ""; })()`);
      const button = await win.eval<boolean>(`[...document.querySelectorAll("button")].some((b) => b.textContent === ${JSON.stringify(rejoin)})`);
      log(`the TV's join badge: ${JSON.stringify(badge.replace(/\n/g, " / "))}; the host's Rejoin button: ${button}`);
      if (!badge || badge === "a rejoin card" || !button) throw new Error("no join badge on the TV (or a rejoin card), or no Rejoin button");
      await win.eval(`[...document.querySelectorAll("button")].find((b) => b.textContent === ${JSON.stringify(rejoin)}).click(); true`);
      await win.until(`!!document.querySelector("dialog.tvpipe-rejoin")`);
      await win.screenshot(`${out}/host-${at}-rejoin.png`);
      await win.until(`!document.querySelector("dialog.tvpipe-rejoin") && jinx.party.players.find((p) => p.name === ${JSON.stringify(name)}).connected`, 15_000);
      log(`${name} is back by name; the host's dialog closed by itself`);
    }
  };

  const seen = new Set<string>();
  let n = 0;
  let again = false;
  let games = 1;
  const deadline = Date.now() + 20 * 60_000;
  for (;;) {
    if (Date.now() > deadline) throw new Error("the game took too long");
    if (args.shots && kept.length >= 3) break;
    const s = await state();
    const k = `${games}:${s.phase}:${s.round ?? ""}:${s.step ?? ""}`;
    if (seen.has(k)) {
      await sleep(150);
      continue;
    }
    seen.add(k);
    const at = `${games}-${String(++n).padStart(2, "0")}`;
    const mine = s.guesser === s.phil;
    if (games === 1) await rejoinChecks(s.phase, at);
    if (games === 2 && s.phase !== "lobby") {
      // The second game started: one look, then the End button.
      await shot(`${at}-again-${s.phase}`);
      break;
    }
    switch (s.phase) {
      case "hotseat":
        log(`round ${s.round}: ${mine ? "Phil guesses" : "Phil writes"}`);
        await shot(`${at}-hotseat`, { wait: 2600 });
        break;
      case "write":
        if (mine) {
          await shot(`${at}-write-blind`);
        } else {
          await writeClues(at);
          await shot(`${at}-write`, { wait: 500 });
        }
        break;
      case "jinx": {
        const j = await win.eval<{ groups: number; cards: number; jinxed: number; until: number; now: number }>(
          `(() => { const s = jinx.party.screen.peek(); return { groups: s.groups.length, cards: s.cards.length, jinxed: s.cards.filter((c) => c.fate === "jinxed").length, until: s.until, now: jinx.party.now() }; })()`,
        );
        log(`jinx check: ${j.cards} cards, ${j.groups} groups, ${j.jinxed} jinxed`);
        await shot(`${at}-jinx`, { wait: 2500 });
        if (j.groups > 0) await shot(`${at}-jinx-late`, { wait: Math.max(0, j.until - j.now - 6000) });
        break;
      }
      case "reveal":
        if (mine) await playGuesser(at);
        else await shot(`${at}-reveal`, { wait: 2500 });
        break;
      case "verdict": {
        const v = await win.eval<{ result: string; word: string; guess?: string; near?: string }>(`jinx.party.screen.peek()`);
        log(`verdict: ${v.result} (word "${v.word}", guess ${JSON.stringify(v.guess ?? null)}${v.near ? `, near: ${v.near}` : ""})`);
        await shot(`${at}-verdict`, { wait: 1500 });
        await shot(`${at}-verdict-late`, { wait: 2500 });
        break;
      }
      case "replay":
        if (mine && (await phone.until(`!!document.querySelector(".cards button.card")`, 4000).then(() => true, () => false))) {
          await shot(`${at}-replay-best-pick`, { wait: 800 });
          await phone.eval(`document.querySelector(".cards button.card").click(); true`);
          await win.until(`!!jinx.party.screen.peek().best`, 5000);
          log(`phone: picked the best clue`);
          await shot(`${at}-replay-best`, { wait: 1800 });
        } else {
          await shot(`${at}-replay`, { wait: 2500 });
        }
        break;
      case "bank":
        await shot(`${at}-bank`, { wait: 3800 });
        break;
      case "end":
        await shot(`${at}-end-${s.step}`, { wait: s.step === "web" ? 7000 : s.step === "room" ? 3500 : 5000 });
        if (s.step === "web" && !again) {
          again = true;
          await phone.until(`(() => { const b = [...document.querySelectorAll("#dock button.primary")].find((b) => !b.hidden); return b && ${texts.again}.test(b.textContent); })()`, 10_000);
          await phone.eval(`[...document.querySelectorAll("#dock button.primary")].find((b) => !b.hidden).click(); true`);
          log("phone: Play again");
          games = 2;
        }
        break;
      default:
        break;
    }
  }
  if (args.shots) {
    if (kept.length < 3) problem(`pictures: only ${kept.join(", ")}`);
  } else await timing(win, phone);
  // The bots' refused actions (codes the game answered with).
  const botErrors = await win.eval<string[]>(`jinx.robots.flatMap((b) => b.errors.map((e) => b.name + ": " + e))`);
  if (botErrors.length > 0) problem(`the bots' errors: ${botErrors.join(", ")}`);
  log(`${shots.length} screenshot sets in ${out}; problems: ${problems.length || "none"}`);
  // The End button: tvpipe ends, everyone is told. Pages trying to reconnect after that are fine.
  reportErrors();
  await win.eval(`document.getElementById("quit").click(); true`);
  const code = await Promise.race([exited, new Promise<string>((r) => setTimeout(() => r("still running"), 15_000))]);
  await phone.until(`document.body.innerText.toLowerCase().includes(${JSON.stringify(texts.over)})`, 5000).catch(() => {});
  await phone.screenshot(`${out}/phone-after-end.png`);
  log(`tvpipe exited: ${code}; the phone says: ${(await phone.eval<string>(`document.body.innerText.slice(0, 80)`)).replace(/\n/g, " / ")}`);
  if (code !== 0) failed = true;
  for (const [, tab] of tabs) tab.errors.splice(0, tab.errors.length, ...tab.errors.filter((e) => !/ERR_CONNECTION_REFUSED|WebSocket connection/.test(e)));
  reportErrors();
  for (const p of tvpipeProblems) problem(`tvpipe: ${p}`);
} catch (err) {
  failed = true;
  log(`FAILED: ${(err as Error).stack ?? String(err)}`);
  reportErrors();
} finally {
  writeFileSync(`${out}/tvpipe.log`, tvpipeLog.join("\n"));
  writeFileSync(`${out}/problems.txt`, problems.join("\n") + "\n");
  browser.close();
  proc.kill();
}
if (problems.length > 0) failed = true;
log(failed ? `FAILED (${problems.length} problems, ${out}/problems.txt)` : "ok");
process.exit(failed ? 1 : 0);
