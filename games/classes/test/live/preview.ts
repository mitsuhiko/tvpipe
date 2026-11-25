/**
 * A preview of Classes' TV and phone pages without tvpipe, a host or
 * players: a small server for the pages with a fake `/_tvpipe/lib/client.js`
 * (test/live/fake-client.js: the real library, but a `PartyClient` that
 * emits the canned views of a fixture, test/live/fixtures/NAME.json), and
 * headless Chrome taking a screenshot of every fixture, with layout
 * checks: nothing off the screen, no text cut or overflowing its box (no
 * ellipsis, `data-fit` text that fits), nothing with text under the join
 * badge. Not part of `npm test`.
 *
 *   node test/live/preview.ts                          # the TV, every fixture, 1280×720 → /tmp/classes-preview
 *   node test/live/preview.ts --page phone             # the phone, 390×844 (and --width 320)
 *   node test/live/preview.ts --only 05-write,07-grade-vote --lang de
 *   node test/live/preview.ts --serve                  # only serve: prints the links, Ctrl-C ends
 *
 * Options: `--page screen|phone`, `--width N`, `--height N` (default
 * 1280×720 for the TV, 390×844 for the phone), `--out DIR` (default
 * /tmp/classes-preview; files PAGE-FIXTURE[-LANG][-WIDTH].png),
 * `--only a,b` (fixture names or prefixes), `--lang en|de` (the fixture's
 * `lang` replaced), `--wait MS` (instead of each fixture's `wait`),
 * `--serve`. A fixture with `pages: ["phone"]` is only for that page;
 * `resume: false` makes the fake client's `canResume` false (the join form);
 * its `hash` is added to the page's fragment (the TV's `ago=MS`: the
 * final's timeline as if it had started MS ago).
 *
 * The pages are served from the sources (`screen/`, `phone/`, `fonts/`,
 * `data/` as they are copied into dist/ by the build: edit and run
 * again), anything else (the compiled `game/*.js`) from `dist/` (`npm run
 * build` first if a page imports it). Exit code 1 when a check failed or
 * a page reported an error.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { Browser, type Tab } from "./browser.ts";
import { CHECK } from "./layout.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const dist = join(root, "dist");
const partyDist = join(root, "..", "..", "npm", "party", "dist");
const fixtures = join(here, "fixtures");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const page = arg("page") ?? "screen";
if (page !== "screen" && page !== "phone") throw new Error("--page screen|phone");
const width = Number(arg("width") ?? (page === "screen" ? 1280 : 390));
const height = Number(arg("height") ?? (page === "screen" ? 720 : 844));
const out = arg("out") ?? "/tmp/classes-preview";
const only = arg("only")?.split(",").filter(Boolean);
const lang = arg("lang");
const waitArg = arg("wait");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".map": "application/json",
};

const { encodeQr } = (await import(join(partyDist, "qr.js"))) as { encodeQr: (t: string) => { size: number; rows: string[] } | null };
const JOIN_URL = "https://tvpipe.party/r/?r=BCDF#k=preview-join-key";
const QR = encodeQr(JOIN_URL);

function fixtureNames(): string[] {
  return readdirSync(fixtures)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5))
    .sort();
}

function loadFixture(name: string, langOverride: string | null): any {
  const f = JSON.parse(readFileSync(join(fixtures, `${name}.json`), "utf8"));
  if (langOverride) {
    if (f.screen) f.screen.lang = langOverride;
    if (f.room) f.room.lang = langOverride;
  }
  if (f.join !== false && !f.join) {
    const phase = f.screen?.phase ?? f.room?.phase;
    f.join = { code: "BCDF", url: JOIN_URL, qr: QR, short: "https://tvpipe.party/BCDF", lateJoin: f.screen?.settings?.late ?? "wait", inProgress: phase !== "lobby" && phase !== "final" && phase !== undefined };
  }
  if (f.join === false) f.join = null;
  return f;
}

/** A path below a folder, or null when it leaves it or is not a file. */
function inside(base: string, path: string): string | null {
  const p = normalize(join(base, path));
  if (!p.startsWith(base)) return null;
  return existsSync(p) && statSync(p).isFile() ? p : null;
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const path = decodeURIComponent(url.pathname);
  const send = (status: number, body: string | Buffer, type = "text/plain; charset=utf-8") => {
    res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
    res.end(body);
  };
  try {
    if (path === "/_tvpipe/lib/client.js") return send(200, readFileSync(join(here, "fake-client.js")), TYPES[".js"]);
    if (path.startsWith("/_tvpipe/lib/")) {
      const rest = path.slice("/_tvpipe/lib/".length).replace(/^real\//, "");
      const f = inside(partyDist, rest);
      return f ? send(200, readFileSync(f), TYPES[extname(f)]) : send(404, "not found");
    }
    const fx = /^\/_preview\/fixtures\/([\w.-]+)\.json$/.exec(path);
    if (fx?.[1]) {
      if (!existsSync(join(fixtures, `${fx[1]}.json`))) return send(404, "no such fixture");
      return send(200, JSON.stringify(loadFixture(fx[1], url.searchParams.get("lang"))), TYPES[".json"]);
    }
    if (path === "/" || path === "/_preview/") {
      const links = fixtureNames().map((n) => `<li>${n}: <a href="/screen/index.html?fixture=${n}#role=screen&mute=1">TV</a> · <a href="/phone/index.html?fixture=${n}">phone</a></li>`);
      return send(200, `<!doctype html><meta charset="utf-8"><title>Classes preview</title><ul>${links.join("")}</ul>`, TYPES[".html"]);
    }
    const top = path.split("/")[1] ?? "";
    const f = (["screen", "phone", "fonts", "data"].includes(top) ? inside(root, path) : null) ?? inside(dist, path);
    return f ? send(200, readFileSync(f), TYPES[extname(f)] ?? "application/octet-stream") : send(404, "not found");
  } catch (e) {
    return send(500, String(e));
  }
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

/** A page's link for a fixture; the fixture's `hash` (e.g. `ago=40000`) goes into the fragment. */
function pageUrl(name: string): string {
  const f = loadFixture(name, null);
  const q = `?fixture=${encodeURIComponent(name)}${lang ? `&lang=${lang}` : ""}${f.resume === false ? "&resume=0" : ""}`;
  const extra = String(f.hash ?? "");
  const hash = [page === "screen" ? "role=screen&mute=1" : "", extra].filter(Boolean).join("&");
  return `${base}/${page}/index.html${q}${hash ? `#${hash}` : ""}`;
}

if (flag("serve")) {
  console.log(`serving ${base}/  (every fixture's links; Ctrl-C ends)`);
  for (const n of fixtureNames()) console.log(`  ${n}: ${pageUrl(n)}`);
  await new Promise(() => {});
}

mkdirSync(out, { recursive: true });
const names = fixtureNames().filter((n) => !only || only.some((o) => n === o || n.startsWith(o)));
const browser = await Browser.launch();
let failed = 0;
let ran = 0;
try {
  const tab: Tab = await browser.open("about:blank", { width, height, mobile: page === "phone", locale: lang === "de" ? "de-DE" : "en-US" });
  for (const name of names) {
    const f = loadFixture(name, null);
    if (Array.isArray(f.pages) && !f.pages.includes(page)) continue;
    tab.errors.length = 0;
    ran++;
    await tab.send("Page.navigate", { url: pageUrl(name) });
    await new Promise((r) => setTimeout(r, 150));
    await tab.until(`!!window.__preview && (window.__preview.ready || !!window.__preview.error)`, 10000).catch(() => tab.errors.push("the page never asked for its fixture"));
    await tab.eval(`document.fonts.ready.then(() => true)`);
    await new Promise((r) => setTimeout(r, Number(waitArg ?? f.wait ?? 1500)));
    const file = join(out, `${page}-${name}${lang ? `-${lang}` : ""}${(page === "screen" && width !== 1280) || (page === "phone" && width !== 390) ? `-${width}` : ""}.png`);
    await tab.screenshot(file);
    const problems = [...(await tab.eval<string[]>(CHECK(page === "phone")).catch((e: Error) => [`cannot check: ${e.message.slice(0, 200)}`])), ...tab.errors];
    const seen = new Set<string>();
    const unique = problems.filter((p) => !seen.has(p) && seen.add(p));
    console.log(`${unique.length ? "✗" : "✓"} ${name}: ${file}`);
    for (const p of unique.slice(0, 20)) console.log(`    ${p}`);
    if (unique.length > 20) console.log(`    … and ${unique.length - 20} more`);
    if (unique.length) failed++;
  }
} finally {
  browser.close();
  server.close();
}
console.log(failed ? `${failed} of ${ran} with problems` : `all ${ran} fine`);
process.exit(failed ? 1 : 0);
