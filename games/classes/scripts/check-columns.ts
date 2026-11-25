/**
 * Checks the column lists (docs/classes-design.md §4.1, §4.2):
 *
 *   node scripts/check-columns.ts                       # data/columns.txt and data/columns.de.txt
 *   node scripts/check-columns.ts data/columns.de.txt   # one list (German: `.de.` in the name)
 *
 * Errors (exit code 1): lines that do not parse, examples that do not
 * start with their letter or break the column's rule, columns without
 * `any` with examples for fewer than 12 common letters (the game drops
 * them), not exactly one each of classic:1–3, fewer than 150 columns, less
 * than a third funny, a subject with fewer than 6 columns (register and
 * detention 8), and a common letter that cannot deal a full round of 10
 * in some mix and content. Warnings: settings where the mix has to give
 * way for a letter, and whole games of 6 rounds that run out of fresh
 * columns. Then the coverage: per common letter, how many columns of each
 * subject work with it.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  COLUMN_COUNTS,
  baseLang,
  COMMON,
  CONTENTS,
  deal,
  exampleLetters,
  isFunny,
  isParty,
  MIN_LETTERS,
  MIXES,
  parseColumns,
  seeded,
  SUBJECT_IDS,
  usable,
  worksWith,
  type Column,
  type Lang,
} from "../game/rules.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const files = args.length > 0 ? args : [join(root, "data", "columns.txt"), join(root, "data", "columns.de.txt")];
/** A list and the rooms it serves: the German one German and Austrian rooms (`only:de`, `only:at`). */
const runs = files.flatMap((f) => (/\.de\./.test(basename(f)) ? [[f, "de"], [f, "at"]] : [[f, "en"]]) as [string, Lang][]);
let failed = false;

const SHORT: Record<string, string> = { geo: "geo", bio: "bio", home: "home", music: "mus", media: "med", sport: "spt", social: "soc", lang: "lng", break: "brk", trip: "trp", register: "reg", detention: "det" };

function check(file: string, lang: Lang): void {
  console.log(`\n== ${file} (${lang})`);
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!existsSync(file)) {
    console.log(`error: missing`);
    failed = true;
    return;
  }
  const all = parseColumns(readFileSync(file, "utf8"), lang, errors);
  for (const c of all) {
    if (!usable(c, lang)) errors.push(`line ${c.line}: ${c.text}: examples for ${exampleLetters(c, lang).length} common letters (${MIN_LETTERS} needed, or \`any\`): dropped`);
  }
  const cols = all.filter((c) => usable(c, lang));
  for (const k of [1, 2, 3] as const) {
    const n = cols.filter((c) => c.classic === k).length;
    if (n !== 1) errors.push(`classic:${k}: ${n} columns (exactly one)`);
  }
  const funny = cols.filter(isFunny).length;
  if (cols.length < 150) errors.push(`${cols.length} columns (at least 150)`);
  if (funny * 3 < cols.length) errors.push(`${funny} funny of ${cols.length} (at least a third)`);
  for (const s of SUBJECT_IDS) {
    const n = cols.filter((c) => c.subject === s).length;
    const min = s === "register" || s === "detention" ? 8 : 6;
    if (n < min) errors.push(`${s}: ${n} columns (at least ${min})`);
  }

  // Every common letter, every setting: a full round from a fresh game.
  const gave = new Map<string, string[]>();
  for (const letter of COMMON[baseLang(lang)]) {
    for (const content of CONTENTS) {
      for (const mix of MIXES) {
        for (const n of COLUMN_COUNTS) {
          for (const classic of [false, true]) {
            let worst: { short: boolean; gaveWay: boolean } = { short: false, gaveWay: false };
            for (let seed = 1; seed <= 4; seed++) {
              const d = deal(cols, { letter, n, mix, content, classic, lang, rng: seeded(seed) });
              const short = d.columns.length < n;
              if (short || (d.gaveWay && !worst.short)) worst = { short, gaveWay: d.gaveWay };
            }
            const what = `${content}/${mix}/${n}${classic ? "/classic" : ""}`;
            if (worst.short) errors.push(`${letter}: ${what}: not a full round`);
            else if (worst.gaveWay) gave.set(letter, [...(gave.get(letter) ?? []), what]);
          }
        }
      }
    }
  }
  for (const [letter, list] of gave) warnings.push(`${letter}: the mix gives way in ${list.length} settings (${list.slice(0, 4).join(", ")}${list.length > 4 ? ", …" : ""})`);

  // Whole games: 6 rounds of 10, random common letters, no column twice.
  for (const content of CONTENTS) {
    for (const mix of MIXES) {
      let gaveWay = 0;
      for (let g = 1; g <= 20; g++) {
        const rng = seeded(1000 + g);
        const played = new Set<string>();
        const letters = [...COMMON[baseLang(lang)]].sort(() => rng() - 0.5).slice(0, 6);
        for (const letter of letters) {
          const d = deal(cols, { letter, n: 10, mix, content, classic: false, lang, rng, played });
          if (d.gaveWay) gaveWay++;
          for (const c of d.columns) played.add(`${c.column.subject}:${c.column.text}`);
        }
      }
      if (gaveWay > 0) warnings.push(`games of 6 × 10, ${content}/${mix}: the mix gave way in ${gaveWay} of 120 rounds`);
    }
  }

  // Coverage per letter and subject.
  const pool = (content: "family" | "party") => cols.filter((c) => content === "party" || !isParty(c));
  console.log(`${cols.length} columns (${funny} funny, ${cols.filter((c) => c.any).length} any, ${cols.filter((c) => c.rule).length} rule, ${cols.filter(isParty).length} party)`);
  console.log(["    ", ...SUBJECT_IDS.map((s) => SHORT[s]!.padStart(4)), " funny  know  all"].join(""));
  for (const letter of COMMON[baseLang(lang)]) {
    const works = (c: Column) => worksWith(c, letter);
    const row = SUBJECT_IDS.map((s) => String(cols.filter((c) => c.subject === s && works(c)).length).padStart(4));
    const fam = pool("family").filter(works);
    console.log([`  ${letter} `, ...row, String(fam.filter(isFunny).length).padStart(6), String(fam.filter((c) => !isFunny(c)).length).padStart(6), String(cols.filter(works).length).padStart(5)].join(""));
  }
  for (const w of warnings) console.log(`warning: ${w}`);
  for (const e of errors) console.log(`error: ${e}`);
  console.log(`${errors.length} errors, ${warnings.length} warnings`);
  if (errors.length > 0) failed = true;
}

for (const [f, l] of runs) check(f, l);
process.exit(failed ? 1 : 0);
