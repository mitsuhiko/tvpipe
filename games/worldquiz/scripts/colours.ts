/**
 * Writes `data/colours.json`: every flag's colours and their shares, and
 * a hash of its picture (game/flagcolours.ts), keyed by the flag's file.
 * The hard "pick the flag" challenge takes its wrong flags by these
 * (docs/worldquiz-design.md §4.5). Offline: it reads `data/flags/`.
 *
 *   node scripts/colours.ts           # writes it
 *   node scripts/colours.ts --check   # fails if the checked-in file is not what it would write
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { flagColours, type FlagColours } from "../game/flagcolours.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "data", "colours.json");

/** The file's text: one flag per line, by file name. */
export function coloursFile(dir = join(ROOT, "data", "flags")): string {
  const flags: Record<string, FlagColours> = {};
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".svg")).sort()) flags[f] = flagColours(readFileSync(join(dir, f), "utf8"));
  const lines = Object.entries(flags).map(([f, c]) => `    ${JSON.stringify(f)}: ${JSON.stringify(c)}`);
  return `{\n  "v": 1,\n  "flags": {\n${lines.join(",\n")}\n  }\n}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const text = coloursFile();
  if (process.argv.includes("--check")) {
    if (readFileSync(OUT, "utf8") !== text) {
      console.error("data/colours.json is out of date: node scripts/colours.ts");
      process.exit(1);
    }
    console.log("data/colours.json is up to date");
  } else {
    writeFileSync(OUT, text);
    console.log(`wrote ${OUT}`);
  }
}
