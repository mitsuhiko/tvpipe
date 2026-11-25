/**
 * The phone with the keyboard up (not part of `npm test`): the preview's
 * fixtures (test/live/preview.ts serves them), a phone viewport that
 * shrinks as a keyboard opens (390×844 → 390×664 and → 45 % of the
 * height; 320 px too), and checks that what the player needs is in sight
 * and covered by nothing:
 *
 * - writing: every field focused in turn (the last one above all) lies
 *   inside the viewport, below the sticky strip, and the element at its
 *   corners is the field itself; ✋ Stop! (when every field is filled) is
 *   in the strip, in sight, without scrolling, also while typing; emptying
 *   the focused field takes it away;
 * - grading: "I'm done" in sight at the top and at the bottom of the list;
 * - Wikipedia: the search field in sight and not covered while focused;
 * - the one-action screens without the keyboard, at what a phone's browser
 *   leaves visible (390×660 like an iPhone's Safari, 320×480): the
 *   drawer's letter screen fits without scrolling, its Stop! on screen;
 *   the other letter screens and the bell fit too; the VIP's Start in the
 *   lobby and at the end in sight at the top, not covered.
 *
 *   node test/live/phone-keyboard.ts [--out DIR]
 *
 * Screenshots of each case into DIR (default /tmp/classes-keyboard).
 * Exit code 1 when a check failed.
 */

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Browser, type Tab } from "./browser.ts";

const here = dirname(fileURLToPath(import.meta.url));
const outArg = process.argv.indexOf("--out");
const out = outArg >= 0 ? (process.argv[outArg + 1] ?? "/tmp/classes-keyboard") : "/tmp/classes-keyboard";
mkdirSync(out, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The preview's server, for its links.
const server = spawn(process.execPath, [join(here, "preview.ts"), "--page", "phone", "--serve"], { stdio: ["ignore", "pipe", "inherit"] });
const links = new Map<string, string>();
await new Promise<void>((resolve, reject) => {
  createInterface({ input: server.stdout! }).on("line", (l) => {
    const m = /^\s+([\w-]+): (\S+)/.exec(l);
    if (m) links.set(m[1]!, m[2]!);
    if (links.size > 0 && !m && links.has("phone-30-wiki-de")) resolve();
  });
  setTimeout(() => (links.has("phone-30-wiki-de") ? resolve() : reject(new Error("the preview did not list the phone fixtures"))), 15_000);
});

/** In the page: what covers an element (its middle and its edges, inside rounded corners), and whether it is in sight below the sticky strip. */
const SEEN = (sel: string, belowStrip: boolean) => `(() => {
  const el = ${sel};
  if (!el) return ["missing"];
  const out = [];
  const r = el.getBoundingClientRect();
  const vv = window.visualViewport;
  const top = vv ? vv.offsetTop : 0, bottom = vv ? vv.offsetTop + vv.height : innerHeight;
  let limit = top;
  if (${belowStrip}) for (const s of document.querySelectorAll("#bar, .strip")) { const q = s.getBoundingClientRect(); if (q.height && q.top <= limit + 1) limit = Math.max(limit, q.bottom); }
  if (r.top < limit - 1) out.push("above the visible area (" + Math.round(r.top) + " < " + Math.round(limit) + ")");
  if (r.bottom > bottom + 1) out.push("below the visible area (" + Math.round(r.bottom) + " > " + Math.round(bottom) + ")");
  if (!out.length) for (const [x, y] of (() => { const cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2, k = Math.min(r.height / 2, 16); return [[r.left + k, cy], [r.right - k, cy], [cx, r.top + 3], [cx, r.bottom - 3], [cx, cy]]; })()) {
    const at = document.elementFromPoint(x, y);
    if (at && at !== el && !el.contains(at)) out.push("covered by " + at.localName + (at.className ? "." + String(at.className).split(" ").join(".") : "") + " at " + Math.round(x) + "," + Math.round(y));
  }
  return out;
})()`;

const problems: string[] = [];
const problem = (p: string) => {
  problems.push(p);
  console.log(`  ✗ ${p}`);
};
const browser = await Browser.launch();
try {
  // Closing the reader: the driver's ✕ closes it for everyone (wiki-close, no "Close for everyone" button for them); another phone's only puts it aside.
  {
    const tab: Tab = await browser.open("about:blank", { width: 390, height: 844, mobile: true });
    for (const [name, driver] of [
      ["phone-30-wiki-de", true],
      ["phone-31-wiki-en", false],
    ] as const) {
      await tab.send("Page.navigate", { url: links.get(name)! });
      await tab.until(`!!window.__preview && window.__preview.ready`, 10_000);
      await sleep(600);
      const all = await tab.eval<boolean>(`!!document.querySelector('#sheet [data-wiki="close"]')?.checkVisibility()`);
      if (all === driver) problem(`${name}: "Close for everyone" ${driver ? "shown to the driver" : "missing for another phone"}`);
      await tab.eval(`(() => { document.querySelector('#sheet [data-wiki="hide"]').click(); return true; })()`);
      await sleep(300);
      const acts = await tab.eval<{ type: string }[]>(`window.__preview.acts`);
      const sent = acts.some((a) => a.type === "wiki-close");
      if (sent !== driver) problem(`${name}: the ✕ ${driver ? "of the driver did not close it for everyone" : "of another phone closed it for everyone"}`);
      if (!(await tab.eval<boolean>(`document.getElementById("sheet").hidden`))) problem(`${name}: the ✕ did not close the reader on this phone`);
    }
    tab.close();
  }

  // The one-action screens: what to do is on screen without scrolling.
  const ONE: { name: string; fits: boolean; button?: string }[] = [
    { name: "phone-03-letter-drawer", fits: true, button: '[data-act="stop-letter"]' },
    { name: "phone-04-letter-other", fits: true },
    { name: "phone-05-letter-stopped", fits: true },
    { name: "phone-10-bell", fits: true },
    { name: "phone-01-lobby-vip", fits: false, button: '[data-act="start"]' },
    { name: "phone-24-two-lobby", fits: false, button: '[data-act="start"]' },
    { name: "phone-19-final", fits: false, button: '[data-act="start"]' },
    { name: "phone-20-final-en", fits: false, button: '[data-act="start"]' },
    { name: "phone-29-two-final", fits: false, button: '[data-act="start"]' },
  ];
  for (const [width, height] of [
    [390, 660],
    [320, 480],
    [390, 844],
  ] as const) {
    const tab: Tab = await browser.open("about:blank", { width, height, mobile: true });
    for (const one of ONE) {
      const url = links.get(one.name);
      if (!url) {
        problem(`no fixture ${one.name}`);
        continue;
      }
      await tab.send("Page.navigate", { url });
      await tab.until(`!!window.__preview && window.__preview.ready`, 10_000);
      await tab.eval(`document.fonts.ready.then(() => true)`);
      await sleep(900);
      const tag = `${width}x${height} ${one.name}`;
      await tab.screenshot(join(out, `one-${one.name}-${width}x${height}.png`));
      if (one.fits) {
        const [sh, ih] = await tab.eval<[number, number]>(`[document.documentElement.scrollHeight, innerHeight]`);
        if (sh > ih + 1) problem(`${tag}: needs scrolling (${sh} > ${ih})`);
      }
      if (one.button) {
        const shown = await tab.eval<boolean>(`(() => { const b = document.querySelector(${JSON.stringify(one.button)}); return !!b && b.checkVisibility(); })()`);
        if (!shown) {
          if (!one.name.includes("final") && !one.name.includes("lobby")) problem(`${tag}: no ${one.button}`);
          continue;
        }
        for (const p of await tab.eval<string[]>(SEEN(`document.querySelector(${JSON.stringify(one.button)})`, false))) problem(`${tag}: ${one.button} without scrolling: ${p}`);
      }
    }
    for (const e of tab.errors) problem(`${width}x${height}: page error: ${e}`);
    tab.close();
  }

  for (const width of [390, 320]) {
    const full = width === 390 ? 844 : 640;
    for (const kb of [width === 390 ? 664 : 500, Math.round(full * 0.45)]) {
      const tab: Tab = await browser.open("about:blank", { width, height: full, mobile: true });
      const open = async (name: string) => {
        const url = links.get(name);
        if (!url) throw new Error(`no fixture ${name}`);
        await tab.resize({ width, height: full, mobile: true });
        await tab.send("Page.navigate", { url });
        await tab.until(`!!window.__preview && window.__preview.ready`, 10_000);
        await tab.eval(`document.fonts.ready.then(() => true)`);
        await sleep(700);
      };
      const keyboard = async () => {
        await tab.resize({ width, height: kb, mobile: true });
        await sleep(450);
      };
      const tag = `${width}x${kb}`;
      console.log(`${tag}`);

      // Writing: every field, the last above all.
      for (const name of ["phone-07-write", "phone-08-write-full", "phone-09-write-stopped"]) {
        await open(name);
        await keyboard();
        const n = await tab.eval<number>(`document.querySelectorAll(".ruled input").length`);
        for (const i of [n - 1, 0, Math.floor(n / 2), n - 2]) {
          if (i < 0) continue;
          await tab.eval(`(() => { document.querySelectorAll(".ruled input")[${i}].focus(); return true; })()`);
          await sleep(500);
          for (const p of await tab.eval<string[]>(SEEN(`document.activeElement`, true))) problem(`${tag} ${name}: field ${i + 1} of ${n}: ${p}`);
          if (i === n - 1) await tab.screenshot(join(out, `${name}-${tag}-last.png`));
          if (name === "phone-08-write-full") for (const p of await tab.eval<string[]>(SEEN(`document.querySelector(".stopbtn:not([hidden])")`, false))) problem(`${tag} ${name}: ✋ Stop! while typing field ${i + 1}: ${p}`);
        }
        if (name === "phone-08-write-full") {
          // Emptying the field being typed in takes Stop! away; typing again brings it back.
          await tab.eval(`(() => { const x = document.activeElement; x.dataset.was = x.value; x.value = ""; x.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
          if (!(await tab.eval<boolean>(`!document.querySelector(".stopbtn:not([hidden])")`))) problem(`${tag} ${name}: ✋ Stop! with an empty field`);
          await tab.eval(`(() => { const x = document.activeElement; x.value = x.dataset.was; x.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
          if (!(await tab.eval<boolean>(`!!document.querySelector(".stopbtn:not([hidden])")`))) problem(`${tag} ${name}: no ✋ Stop! once the field is filled again`);
          // Without the keyboard, scrolled anywhere: Stop! in sight.
          await tab.eval(`(() => { document.activeElement.blur(); return true; })()`);
          await tab.resize({ width, height: full, mobile: true });
          await sleep(300);
          for (const y of ["0", "document.documentElement.scrollHeight"]) {
            await tab.eval(`(() => { scrollTo(0, ${y}); return true; })()`);
            await sleep(200);
            for (const p of await tab.eval<string[]>(SEEN(`document.querySelector(".stopbtn:not([hidden])")`, false))) problem(`${tag} ${name}: ✋ Stop! scrolled to ${y === "0" ? "the top" : "the bottom"}: ${p}`);
          }
          await tab.screenshot(join(out, `${name}-${tag}-bottom.png`));
        }
      }

      // Grading: "I'm done" at the top and the bottom of the list.
      for (const name of ["phone-11-vote", "phone-12-vote-en", "phone-25-two-vote"]) {
        await open(name);
        for (const y of ["0", "document.documentElement.scrollHeight"]) {
          await tab.eval(`(() => { scrollTo(0, ${y}); return true; })()`);
          await sleep(200);
          for (const p of await tab.eval<string[]>(SEEN(`document.querySelector(".donebtn")`, false))) problem(`${tag} ${name}: "I'm done" scrolled to ${y === "0" ? "the top" : "the bottom"}: ${p}`);
        }
        await tab.screenshot(join(out, `${name}-${tag}-bottom.png`));
      }

      // Wikipedia: the search field while typing.
      for (const name of ["phone-30-wiki-de", "phone-33-wiki-long"]) {
        await open(name);
        await tab.eval(`(() => { document.querySelector(".reader").scrollTop = 900; return true; })()`);
        await keyboard();
        await tab.eval(`(() => { document.querySelector('#sheet [data-wiki="search"]').focus(); return true; })()`);
        await sleep(400);
        for (const p of await tab.eval<string[]>(SEEN(`document.activeElement`, false))) problem(`${tag} ${name}: the search field: ${p}`);
        await tab.screenshot(join(out, `${name}-${tag}-search.png`));
      }
      for (const e of tab.errors) problem(`${tag}: page error: ${e}`);
      tab.close();
    }
  }
} finally {
  browser.close();
  server.kill();
}
console.log(problems.length ? `${problems.length} problems; screenshots in ${out}` : `all fine; screenshots in ${out}`);
process.exit(problems.length ? 1 : 0);
