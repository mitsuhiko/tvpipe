/**
 * Builds the bundle and packs it into `worldquiz.zip` with `tvpipe game
 * pack` (the one packer: it checks the bundle, writes the manifest at the
 * zip's top and prints the zip's sha256), the way games.yml releases it.
 * tvpipe is `$TVPIPE_BINARY`, else `tvpipe` on the PATH.
 *
 *   node scripts/pack.ts    # worldquiz.zip: tvpipe game play worldquiz.zip
 */

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tvpipe = process.env["TVPIPE_BINARY"] || "tvpipe";

execFileSync(process.execPath, [join(root, "scripts", "build.ts")], { stdio: "inherit" });
try {
  execFileSync(tvpipe, ["game", "pack", root, "--strict", "-o", join(root, "worldquiz.zip")], { stdio: "inherit" });
} catch (e) {
  const code = (e as NodeJS.ErrnoException).code;
  if (code === "ENOENT") throw new Error(`${tvpipe} not found: install tvpipe or set TVPIPE_BINARY`);
  process.exitCode = 1;
}
