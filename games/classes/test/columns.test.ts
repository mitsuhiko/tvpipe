import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { baseLang, columnsFile, COMMON, deal, LANGS, parseColumns, seeded, usable, type Lang } from "../game/rules.ts";

const file = (l: Lang) => new URL(`../data/${columnsFile(l)}`, import.meta.url);

// The lists themselves: `npm run columns` checks everything and prints the coverage; this is the part a list must never break.
for (const lang of LANGS) {
  test(`the ${lang} column list: every line parses, every column can be dealt, every common letter deals a full round`, { skip: !existsSync(file(lang)) && `no data/columns.${lang}.txt yet` }, () => {
    const errors: string[] = [];
    const cols = parseColumns(readFileSync(file(lang), "utf8"), lang, errors);
    assert.deepEqual(errors, []);
    assert.deepEqual(
      cols.filter((c) => !usable(c, lang)).map((c) => `line ${c.line}: ${c.text}`),
      [],
    );
    for (const k of [1, 2, 3]) assert.equal(cols.filter((c) => c.classic === k).length, 1, `classic:${k}`);
    for (const letter of COMMON[baseLang(lang)]) {
      for (const content of ["family", "party"] as const) {
        const d = deal(cols, { letter, n: 10, mix: "mixed", content, classic: false, lang, rng: seeded(1) });
        assert.equal(d.columns.length, 10, `${letter} ${content}`);
      }
    }
  });
}
