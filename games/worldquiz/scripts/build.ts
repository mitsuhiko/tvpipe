/**
 * Builds the bundle `tvpipe game play` serves (`dist/`, the manifest's
 * `root`): the TypeScript (`game/`, `host/`) compiled by tsc, imports of
 * `@tvpipe/party` pointed at tvpipe's copy (`/_tvpipe/lib/`), and the
 * pages, styles, fonts and word lists copied as they are.
 *
 *   node scripts/build.ts    # dist/
 *
 * `npm run zip` (scripts/pack.ts) packs it into worldquiz.zip with
 * `tvpipe game pack`.
 */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

/** Bare imports of the library, as tvpipe serves it. */
const LIBRARY: Record<string, string> = {
  "@tvpipe/party": "/_tvpipe/lib/index.js",
  "@tvpipe/party/client": "/_tvpipe/lib/client.js",
};

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

rmSync(dist, { recursive: true, force: true });
const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
execFileSync(process.execPath, [tsc, "-p", join(root, "tsconfig.build.json")], { stdio: "inherit" });
for (const f of files(dist)) {
  if (!f.endsWith(".js")) continue;
  const js = readFileSync(f, "utf8").replace(/from "(@tvpipe\/party(?:\/client)?)"/g, (m, spec: string) => {
    const to = LIBRARY[spec];
    if (!to) throw new Error(`${relative(root, f)}: unknown import ${spec}`);
    return `from "${to}"`;
  });
  if (/from "@tvpipe\//.test(js)) throw new Error(`${relative(root, f)}: an import of the library left`);
  writeFileSync(f, js);
}
for (const dir of ["phone", "screen", "data"]) cpSync(join(root, dir), join(dist, dir), { recursive: true });
for (const f of ["index.html", "host.css"]) cpSync(join(root, "host", f), join(dist, "host", f));
console.log(`built ${relative(process.cwd(), dist) || "."}`);

if (!existsSync(join(dist, "host", "host.js"))) {
  mkdirSync(dist, { recursive: true });
  throw new Error("the build made no host/host.js");
}
