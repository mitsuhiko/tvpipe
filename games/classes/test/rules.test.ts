import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  answerLetters,
  baseLang,
  columnsFile,
  autoStrike,
  columnKey,
  columnPoints,
  deal,
  fillColumn,
  firstLetter,
  funnyCount,
  gradeOf,
  isFunny,
  isParty,
  letters,
  obeysRule,
  parseColumns,
  pickLang,
  possessive,
  progressOf,
  ranks,
  readSettings,
  remarks,
  seeded,
  stampOf,
  struckByRoom,
  usable,
  type CardStats,
  type Column,
} from "../game/rules.ts";

const EN = parseColumns(readFileSync(new URL("fixtures/columns.txt", import.meta.url), "utf8"), "en");
const DE = parseColumns(readFileSync(new URL("fixtures/columns.de.txt", import.meta.url), "utf8"), "de");

test("the fixture lists parse without errors", () => {
  for (const [file, lang] of [["fixtures/columns.txt", "en"], ["fixtures/columns.de.txt", "de"]] as const) {
    const errors: string[] = [];
    const cols = parseColumns(readFileSync(new URL(file, import.meta.url), "utf8"), lang, errors);
    assert.deepEqual(errors, []);
    assert.equal(cols.length, lang === "en" ? 22 : 21);
    assert.ok(cols.every((c) => usable(c, lang)));
  }
});

test("the column list: sections, tags, examples; bad lines and examples are skipped and named", () => {
  const errors: string[] = [];
  const cols = parseColumns(
    [
      "# a comment",
      "City | classic:1 | A: Amsterdam, Athens; b: Berlin",
      "== geo",
      "City | classic:1 | A: Amsterdam, Athens; b: Berlin; C: Berlin",
      "Island | | A: Aruba; B: Bali, Borneo",
      "== break",
      "Excuse for missing homework | funny any | B: The baby ate it; D: Dog ate it",
      "== register",
      "Something {player} would buy | any |",
      "{player} and {player's} | any |",
      "What {name} says | any |",
      "== lang",
      "Starts and ends with the letter | rule:ends | A: Area, Apple; D: Dad",
      "Two | rule:two rule:ends | F: Fierce Fish",
      "Odd | spicy |",
      "A column whose text is far too long for the board | any |",
      "== nature",
      "Tree | | O: Oak",
      "== bio",
      "Animal | classic:2 | A: Ant",
      "Animal | | A: Ant",
      "animal | | A: Ant",
      "Bird | | A Auk",
      "Fish | | A: Anchovy | extra",
      "== register",
      "What {player} would order at a kebab shop | any |",
      "What {player} would order at a kebab sh | any |",
      "== geo",
      "Lake | | A: Lake Albert, Lake Annecy in the French Alps of Haute-Savoie",
    ].join("\n"),
    "en",
    errors,
  );
  assert.deepEqual(
    cols.map((c) => c.text),
    ["City", "Island", "Excuse for missing homework", "Something {player} would buy", "Starts and ends with the letter", "Animal", "Bird", "What {player} would order at a kebab sh", "Lake"],
  );
  const city = cols[0]!;
  assert.equal(city.subject, "geo");
  assert.equal(city.classic, 1);
  assert.deepEqual(city.examples, { A: ["Amsterdam", "Athens"], B: ["Berlin"] });
  assert.equal(city.line, 4);
  const excuse = cols[2]!;
  assert.ok(excuse.funny && excuse.any && !excuse.party);
  assert.deepEqual(excuse.examples, { B: ["The baby ate it"], D: ["Dog ate it"] });
  assert.equal(cols[4]!.rule, "ends");
  assert.deepEqual(cols[4]!.examples, { A: ["Area"], D: ["Dad"] });
  assert.deepEqual(cols[6]!.examples, {});
  const want = [
    /line 2: a column outside a subject/,
    /line 4: example Berlin for C: does not start with the letter/,
    /line 10: more than one placeholder/,
    /line 11: unknown placeholder \{name\}/,
    /line 13: example Apple for A: breaks rule:ends/,
    /line 14: more than one rule/,
    /line 15: unknown tag spicy/,
    /line 16: longer than 40 characters/,
    /line 17: unknown subject nature/,
    /line 18: a column outside a subject/,
    /line 20: classic outside geo/,
    /line 22: animal twice/,
    /line 23: examples "A Auk"/,
    /line 24: more than three fields/,
    /line 26: longer than 40 characters/,
    /line 29: example Lake Annecy in the French Alps of Haute-Savoie: longer than 40 characters/,
  ];
  assert.equal(errors.length, want.length, errors.join("\n"));
  want.forEach((re, i) => assert.match(errors[i]!, re));
});

test("dealt only with examples for 12 common letters, or any", () => {
  const few = parseColumns("== bio\nBird | | A: Auk; B: Blackbird; C: Crow", "en")[0]!;
  assert.equal(usable(few, "en"), false);
  const anyCol = parseColumns("== break\nUseless superpower | any |", "en")[0]!;
  assert.equal(usable(anyCol, "en"), true);
  assert.ok(isFunny(anyCol));
  const det = parseColumns("== detention\nHangover cure | any |", "en")[0]!;
  assert.ok(isParty(det) && isFunny(det));
  // Rule columns are never funny, not even in a funny subject or tagged.
  const rules = parseColumns("== break\nDouble trouble | any rule:double |\n== lang\nFunny pair | funny rule:two | F: Fierce Fish", "en");
  assert.ok(rules.length === 2 && rules.every((c) => !isFunny(c)));
});

test("letters: common per language, all 26; no umlauts", () => {
  assert.equal(letters("en", "common").join(""), "ABCDEFGHIJKLMNOPRSTW");
  assert.equal(letters("de", "common").join(""), "ABCDEFGHIJKLMNOPRSTUVWZ");
  assert.equal(letters("de", "all").length, 26);
  assert.equal(letters("en", "all").join(""), "ABCDEFGHIJKLMNOPQRSTUVWXYZ");
});

test("names in columns: possessives in English and German", () => {
  assert.equal(possessive("Anna", "en"), "Anna's");
  assert.equal(possessive("James", "en"), "James'");
  assert.equal(possessive("Max", "en"), "Max's");
  assert.equal(possessive("Anna", "de"), "Annas");
  assert.equal(possessive("Klaus", "de"), "Klaus’");
  assert.equal(possessive("Max", "de"), "Max’");
  assert.equal(possessive("Fritz", "de"), "Fritz’");
  assert.equal(possessive("Grace", "de"), "Grace’");
  assert.equal(fillColumn("{player's} secret talent", "James", "en"), "James' secret talent");
  assert.equal(fillColumn("Something {player} would buy", "Anna", "en"), "Something Anna would buy");
  assert.equal(fillColumn("{player's} geheimes Talent", "Klaus", "de"), "Klaus’ geheimes Talent");
});

test("the letter an answer starts with (§5.2)", () => {
  const cases: [string, "en" | "de", string | null][] = [
    ["Amsterdam", "en", "A"],
    ["  amsterdam", "en", "A"],
    ["The Beatles", "en", "B"],
    ["The", "en", "T"],
    ["A", "en", "A"],
    ["An apple a day", "en", "A"],
    ["Éclair", "en", "E"],
    ["Ölberg", "de", "O"],
    ["Ärzte", "de", "A"],
    ["Die Ärzte", "de", "A"],
    ["Die Hard", "en", "D"],
    ["The Beatles", "de", "B"],
    ["The", "de", "T"],
    ["Der Hund", "en", "D"],
    ["Der Hund", "de", "H"],
    ["Einen Kaffee", "de", "K"],
    ["“Quoted”", "en", "Q"],
    ["...and so on", "en", "A"],
    ["'Allo 'Allo!", "en", "A"],
    ["7 Up", "en", null],
    ["", "en", null],
    ["!!!", "en", null],
    ["Ñandú", "en", "N"],
    ["Łódź", "de", "L"],
    ["Ωmega", "en", null],
  ];
  for (const [text, lang, want] of cases) assert.equal(firstLetter(text, lang), want, `${text} (${lang})`);
});

test("a geographic prefix before more words: either word counts", () => {
  const cases: [string, "en" | "de", string[]][] = [
    ["Mount Fuji", "en", ["M", "F"]],
    ["Mt. Everest", "en", ["M", "E"]],
    ["Lake Victoria", "en", ["L", "V"]],
    ["The River Thames", "en", ["R", "T"]],
    ["Cape Horn", "en", ["C", "H"]],
    ["Isle of Man", "en", ["I", "M"]],
    ["Isle Royale", "en", ["I"]],
    ["Mount", "en", ["M"]],
    ["Mountain View", "en", ["M"]],
    ["Fluss Elbe", "de", ["F", "E"]],
    ["See Genezareth", "de", ["S", "G"]],
    ["Der Berg Ararat", "de", ["B", "A"]],
    ["Insel Rügen", "de", ["I", "R"]],
    ["Mount Fuji", "de", ["M"]],
    ["Lake Garda", "de", ["L"]],
  ];
  for (const [text, lang, want] of cases) assert.deepEqual(answerLetters(text, lang), want, `${text} (${lang})`);
  assert.equal(autoStrike("Mount Fuji", "F", undefined, "en"), null);
  assert.equal(autoStrike("Mount Fuji", "M", undefined, "en"), null);
  assert.equal(autoStrike("Mount Fuji", "K", undefined, "en"), "letter");
  assert.equal(autoStrike("Insel Rügen", "R", undefined, "de"), null);
  // A leading number and clubs' prefixes, in a row too.
  const more: [string, "en" | "de", string[]][] = [
    ["FC Basel", "en", ["F", "B"]],
    ["AFC Ajax", "en", ["A"]],
    ["FC Basel", "de", ["F", "B"]],
    ["1. FC Köln", "de", ["F", "K"]],
    ["1899 Hoffenheim", "de", ["H"]],
    ["TSG 1899 Hoffenheim", "de", ["T", "H"]],
    ["VfB Stuttgart", "de", ["V", "S"]],
    ["VfL Wolfsburg", "de", ["V", "W"]],
    ["SV Werder Bremen", "de", ["S", "W"]],
    ["TSV 1860 München", "de", ["T", "M"]],
    ["SC Freiburg", "de", ["S", "F"]],
    ["VfB Stuttgart", "en", ["V"]],
    ["7 Up", "en", ["U"]],
    ["1899", "de", []],
    ["FC", "de", ["F"]],
  ];
  for (const [text, lang, want] of more) assert.deepEqual(answerLetters(text, lang), want, `${text} (${lang})`);
  assert.equal(autoStrike("1. FC Köln", "K", undefined, "de"), null);
  assert.equal(autoStrike("1. FC Köln", "E", undefined, "de"), "letter");
  // The rest of the rules look at the whole answer.
  assert.equal(autoStrike("Lake Erie", "E", "ends", "en"), null);
  assert.equal(autoStrike("Lake Tahoe", "T", "ends", "en"), "rule:ends");
});

test("struck by rule: empty, the letter, and the column's rules", () => {
  assert.equal(autoStrike("", "A", undefined, "en"), "empty");
  assert.equal(autoStrike("   ", "A", undefined, "en"), "empty");
  assert.equal(autoStrike("?!", "A", undefined, "en"), "empty");
  assert.equal(autoStrike("Berlin", "A", undefined, "en"), "letter");
  assert.equal(autoStrike("Athens", "A", undefined, "en"), null);
  // ends
  assert.equal(autoStrike("Asia", "A", "ends", "en"), null);
  assert.equal(autoStrike("Area!", "A", "ends", "en"), null);
  assert.equal(autoStrike("Apple", "A", "ends", "en"), "rule:ends");
  assert.ok(obeysRule("Ehe", "E", "ends", "de"));
  assert.ok(obeysRule("Uhu", "U", "ends", "de"));
  // Ä Ö Ü count as A O U at the end too.
  assert.ok(obeysRule("Anä", "A", "ends", "de"));
  assert.ok(obeysRule("Otto Ö", "O", "ends", "de"));
  assert.ok(obeysRule("Uhü", "U", "ends", "de"));
  assert.ok(!obeysRule("Uhö", "U", "ends", "de"));
  // double
  assert.ok(obeysRule("Kaffee", "K", "double", "de"));
  assert.ok(obeysRule("Apple", "A", "double", "en"));
  assert.ok(!obeysRule("Bus stop", "B", "double", "en"), "not across words");
  assert.equal(autoStrike("Banana", "B", "double", "en"), "rule:double");
  // two
  assert.equal(autoStrike("Fierce Fish", "F", "two", "en"), null);
  assert.equal(autoStrike("The Fierce Fish", "F", "two", "en"), null);
  assert.equal(autoStrike("Fierce Dog", "F", "two", "en"), "rule:two");
  assert.equal(autoStrike("Fish", "F", "two", "en"), "rule:two");
  assert.equal(autoStrike("Fliegende Fische", "F", "two", "de"), null);
  // Spaces and hyphens separate words; a leading article is not a word.
  assert.equal(autoStrike("Fish-Finger", "F", "two", "en"), null);
  assert.equal(autoStrike("Fish-Dinner", "F", "two", "en"), "rule:two");
  assert.equal(autoStrike("The Fish", "F", "two", "en"), "rule:two");
  assert.equal(autoStrike("Die Fische", "F", "two", "de"), "rule:two");
  assert.equal(autoStrike("Die Fliegenden Fische", "F", "two", "de"), null);
  assert.equal(autoStrike("The Fierce Fish", "F", "two", "de"), null);
  // long: 9 letters in English, 12 in German, letters only
  assert.equal(autoStrike("Adventure", "A", "long", "en"), null);
  assert.equal(autoStrike("Elephant", "E", "long", "en"), "rule:long");
  assert.equal(autoStrike("Ice-cream!", "I", "long", "en"), "rule:long");
  assert.equal(autoStrike("Hausaufgaben", "H", "long", "de"), null);
  assert.equal(autoStrike("Luftballon", "L", "long", "de"), "rule:long");
});

test("scribbles: 0 empty, 1 short, 2 medium, 3 long", () => {
  assert.deepEqual(["", "  ", "Rome", "Paris", "Amsterdam", "Donaudampfschiff"].map(progressOf), [0, 0, 1, 1, 2, 3]);
});

test("the mix: funny columns per round", () => {
  assert.deepEqual([6, 8, 10].map((n) => funnyCount("school", n)), [1, 1, 1]);
  assert.deepEqual([6, 8, 10].map((n) => funnyCount("mixed", n)), [2, 2, 3]);
  assert.deepEqual([6, 8, 10].map((n) => funnyCount("silly", n)), [3, 4, 5]);
});

function check(cols: Column[], o: { content: "family" | "party" }) {
  const subj = new Map<string, number>();
  for (const c of cols) subj.set(c.subject, (subj.get(c.subject) ?? 0) + 1);
  assert.ok(cols.filter((c) => c.rule).length <= 1, "one rule column at most");
  assert.ok((subj.get("register") ?? 0) <= 1, "one register column at most");
  if (o.content === "family") assert.ok(cols.every((c) => !isParty(c)), "no party columns");
  assert.equal(new Set(cols.map(columnKey)).size, cols.length, "no column twice");
}

test("dealing: the mix, the limits, the letter, no party with family", () => {
  for (let seed = 1; seed <= 30; seed++) {
    for (const letter of ["B", "M", "T", "S"]) {
      const d = deal(EN, { letter, n: 8, mix: "mixed", content: "family", classic: false, lang: "en", rng: seeded(seed), names: ["Anna", "Ben", "Cy"] });
      const cols = d.columns.map((x) => x.column);
      assert.equal(cols.length, 8);
      check(cols, { content: "family" });
      assert.ok(cols.every((c) => c.any || (c.examples[letter]?.length ?? 0) > 0), "works with the letter");
      if (!d.gaveWay) {
        assert.equal(cols.filter(isFunny).length, 2, `seed ${seed} ${letter}`);
        const subj = new Map<string, number>();
        for (const c of cols) subj.set(c.subject, (subj.get(c.subject) ?? 0) + 1);
        assert.ok([...subj.values()].every((n) => n <= 2), "two of a subject at most");
      }
    }
  }
});

test("dealing: the letter decides which columns can come (Film has no D)", () => {
  for (let seed = 1; seed <= 20; seed++) {
    const d = deal(EN, { letter: "D", n: 6, mix: "school", content: "family", classic: false, lang: "en", rng: seeded(seed) });
    assert.ok(!d.columns.some((c) => c.column.text === "Film"));
  }
});

test("dealing: classic first (City, Country, River); party content deals detention sometimes", () => {
  const d = deal(EN, { letter: "B", n: 8, mix: "mixed", content: "family", classic: true, lang: "en", rng: seeded(3) });
  assert.deepEqual(
    d.columns.slice(0, 3).map((c) => c.text),
    ["City", "Country", "River"],
  );
  assert.ok(!d.columns.slice(3).some((c) => c.subject === "geo"), "geo is full");
  // River has no K, Land no W (in the German list here: Wales is the W): with classic on they come anyway.
  for (const letter of ["K", "Q", "X"]) {
    const k = deal(EN, { letter, n: 8, mix: "mixed", content: "family", classic: true, lang: "en", rng: seeded(3) });
    assert.deepEqual(
      k.columns.slice(0, 3).map((c) => c.text),
      ["City", "Country", "River"],
      letter,
    );
    assert.equal(k.columns.length, 8);
  }
  // Without classic, River comes only for letters it has examples for.
  for (let seed = 1; seed <= 20; seed++) {
    assert.ok(!deal(EN, { letter: "K", n: 10, mix: "school", content: "family", classic: false, lang: "en", rng: seeded(seed) }).columns.some((c) => c.text === "River"));
  }
  let detention = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const p = deal(EN, { letter: "B", n: 10, mix: "silly", content: "party", classic: false, lang: "en", rng: seeded(seed) });
    check(
      p.columns.map((c) => c.column),
      { content: "party" },
    );
    if (p.columns.some((c) => c.subject === "detention")) detention++;
  }
  assert.ok(detention > 0);
});

test("dealing: never a column twice in a game, the room's recent ones last, the mix gives way rather than a short round", () => {
  const played = new Set<string>();
  for (const letter of ["B", "C", "D", "F", "G", "H"]) {
    const d = deal(EN, { letter, n: 6, mix: "school", content: "family", classic: false, lang: "en", rng: seeded(9), played });
    assert.equal(d.columns.length, 6);
    for (const c of d.columns) {
      if (played.has(columnKey(c.column))) assert.ok(d.gaveWay, "only when the list runs out");
      played.add(columnKey(c.column));
    }
  }
  // Recent: with everything else fresh, the recent ones are not dealt.
  const recent = ["bio:Animal", "home:Fruit or vegetable", "sport:Sport"];
  for (let seed = 1; seed <= 20; seed++) {
    const d = deal(EN, { letter: "B", n: 6, mix: "school", content: "family", classic: false, lang: "en", rng: seeded(seed), recent });
    assert.ok(!d.columns.some((c) => recent.includes(columnKey(c.column))), `seed ${seed}`);
  }
  // A list with too few funny columns for silly: knowable ones fill in.
  const few = EN.filter((c) => !isFunny(c) || c.subject === "break");
  const s = deal(few, { letter: "B", n: 10, mix: "silly", content: "family", classic: false, lang: "en", rng: seeded(1) });
  assert.equal(s.columns.length, 10);
  assert.ok(s.gaveWay);
});

test("dealing: {player} filled, a different player each", () => {
  const regs = EN.filter((c) => c.subject === "register");
  const d = deal([...regs, ...EN.filter((c) => c.subject === "geo")], { letter: "B", n: 4, mix: "silly", content: "family", classic: false, lang: "en", rng: seeded(2), names: ["Anna", "James"] });
  const texts = d.columns.filter((c) => c.subject === "register").map((c) => c.text);
  // One register column a round, unless the list has nothing else.
  assert.ok(texts.length >= 1);
  assert.ok(texts.every((t) => /Anna|James/.test(t) && !t.includes("{")), texts.join());
  if (texts.length === 2) assert.notEqual(texts[0]!.includes("Anna"), texts[1]!.includes("Anna"));
  const de = deal(
    DE.filter((c) => c.subject === "register"),
    { letter: "B", n: 2, mix: "silly", content: "family", classic: false, lang: "de", rng: seeded(1), names: ["Klaus", "Anna"] },
  );
  // Only register columns: the limit gives way; Klaus and Anna once each.
  const t = de.columns.map((c) => c.text).sort();
  assert.ok(
    JSON.stringify(t) === JSON.stringify(["Etwas, das Anna kaufen würde", "Klaus’ geheimes Talent"]) || JSON.stringify(t) === JSON.stringify(["Annas geheimes Talent", "Etwas, das Klaus kaufen würde"]),
    t.join(" / "),
  );
});

test("points: 20 alone, 10 own, 5 shared, 0 struck or empty", () => {
  const p = (list: { id: string; who: string[]; auto?: "empty" | "letter"; struck?: boolean }[]) => Object.fromEntries(columnPoints(list.map((a) => ({ struck: false, ...a }))));
  assert.deepEqual(p([{ id: "a", who: ["1"] }, { id: "b", who: ["2"], auto: "empty" }, { id: "c", who: ["3"], auto: "letter" }]), { a: 20, b: 0, c: 0 });
  assert.deepEqual(p([{ id: "a", who: ["1"] }, { id: "b", who: ["2"] }]), { a: 10, b: 10 });
  assert.deepEqual(p([{ id: "a", who: ["1", "2"] }, { id: "b", who: ["3"] }]), { a: 5, b: 10 });
  assert.deepEqual(p([{ id: "a", who: ["1", "2"] }]), { a: 5 });
  assert.deepEqual(p([{ id: "a", who: ["1"] }, { id: "b", who: ["2"], struck: true }]), { a: 20, b: 0 });
  assert.deepEqual(p([{ id: "a", who: ["1"], struck: true }]), { a: 0 });
});

test("struck by the room: more than half of the others", () => {
  assert.equal(struckByRoom(2, 2), true);
  assert.equal(struckByRoom(1, 2), false);
  assert.equal(struckByRoom(2, 3), true);
  assert.equal(struckByRoom(2, 4), false);
  assert.equal(struckByRoom(3, 4), true);
  assert.equal(struckByRoom(0, 0), false);
  // A duel: the other's one doubt strikes.
  assert.equal(struckByRoom(1, 1), true);
  assert.equal(struckByRoom(0, 1), false);
});

test("ranks: shared places", () => {
  assert.deepEqual(Object.fromEntries(ranks(new Map([["a", 30], ["b", 50], ["c", 30], ["d", 0]]))), { a: 2, b: 1, c: 2, d: 4 });
});

test("grades: 1–6 and A–F on the same thresholds; Austria 1–5 on its own", () => {
  const shares = [1.5, 1, 0.99, 0.8, 0.6, 0.59, 0.4, 0.2, 0.19, 0];
  assert.deepEqual(shares.map((s) => gradeOf(s, "de")), ["1", "1", "2", "2", "3", "4", "4", "5", "6", "6"]);
  assert.deepEqual(shares.map((s) => gradeOf(s, "en")), ["A", "A", "B", "B", "C", "D", "D", "E", "F", "F"]);
  const at = [2, 1, 0.99, 0.75, 0.74, 0.5, 0.49, 0.25, 0.24, 0];
  assert.deepEqual(at.map((s) => gradeOf(s, "at")), ["1", "1", "2", "2", "3", "3", "4", "4", "5", "5"]);
});

test("Austrian German: the browser's de-AT, German words and letters, the German list without only:de", () => {
  assert.deepEqual(["de-AT", "de_at", "at", "de-DE", "de", "de-CH", "en-GB", "fr", 42].map(pickLang), ["at", "at", "at", "de", "de", "de", "en", "en", "en"]);
  assert.equal(baseLang("at"), "de");
  assert.equal(columnsFile("at"), "columns.de.txt");
  assert.deepEqual(letters("at", "common"), letters("de", "common"));
  assert.equal(firstLetter("Die Ärzte", "at"), "A");
  assert.equal(possessive("Klaus", "at"), "Klaus’");
  assert.equal(autoStrike("Hausaufgaben", "H", "long", "at"), null);
  const list = ["== geo", "Stadt | classic:1 | A: Aachen", "Bundesland | only:de | B: Bayern", "Bundesland | only:at | B: Burgenland", "Schikurs-Ort | only:at | S: Schladming"].join("\n");
  assert.deepEqual(
    parseColumns(list, "de").map((c) => [c.text, c.only ?? null, Object.keys(c.examples).join("")]),
    [
      ["Stadt", null, "A"],
      ["Bundesland", "de", "B"],
    ],
  );
  assert.deepEqual(
    parseColumns(list, "at").map((c) => [c.text, c.only ?? null]),
    [
      ["Stadt", null],
      ["Bundesland", "at"],
      ["Schikurs-Ort", "at"],
    ],
  );
  const errors: string[] = [];
  parseColumns("== geo\nCounty | only:at | B: Bath", "en", errors);
  assert.match(errors[0]!, /only:at in the English list/);
});

test("remarks: the most of each, ties to all, two a card at most, fine for the rest; the stamp", () => {
  const s = (id: string, o: Partial<CardStats>): CardStats => ({ id, rank: 2, total: 10, stars: 0, twenties: 0, shared: 0, facts: 0, empty: 0, taste: 0, ...o });
  const got = remarks([
    s("a", { rank: 1, total: 90, stars: 3, twenties: 2 }),
    s("b", { stars: 3, shared: 4 }),
    s("c", { facts: 1, empty: 2, taste: 1 }),
    s("d", {}),
  ]);
  assert.deepEqual(Object.fromEntries(got), { a: ["top", "clown"], b: ["clown", "copy"], c: ["facts", "empty"], d: ["fine"] });
  // Nobody scored: no top of the class.
  assert.deepEqual(remarks([s("a", { rank: 1, total: 0 }), s("b", { rank: 1, total: 0 })]).get("a"), ["fine"]);
  // What every player would get says nothing: not given (but copying is copying, by both).
  assert.deepEqual(
    Object.fromEntries(remarks([s("a", { rank: 1, total: 30, empty: 1, shared: 2, stars: 1 }), s("b", { rank: 1, total: 30, empty: 1, shared: 2, stars: 1 })])),
    { a: ["copy"], b: ["copy"] },
  );
  assert.deepEqual(
    Object.fromEntries(remarks([s("a", { rank: 1, total: 40, empty: 1, shared: 2 }), s("b", { rank: 2, total: 30, empty: 1, shared: 2, facts: 1, twenties: 1 })])),
    { a: ["top", "copy"], b: ["twenty", "copy"] },
  );
  assert.deepEqual(
    Object.fromEntries(remarks([s("a", { empty: 1 }), s("b", { empty: 1 }), s("c", { empty: 1 })])),
    { a: ["fine"], b: ["fine"], c: ["fine"] },
  );
  // One player alone keeps theirs.
  assert.deepEqual(remarks([s("a", { rank: 1, total: 10, empty: 2 })]).get("a"), ["top", "empty"]);
  assert.equal(stampOf(3, [1, 2, 3]), "held");
  assert.equal(stampOf(2, [1, 2, 2]), "held");
  assert.equal(stampOf(2, [1, 2]), "promoted");
  assert.equal(stampOf(1, [1, 1, 1]), "promoted");
  assert.equal(stampOf(1, [1, 2, 3]), "promoted");
  // A duel: second place is not held back.
  assert.equal(stampOf(2, [1, 2]), "promoted");
});

test("settings: known keys and choices only, nothing taken otherwise", () => {
  assert.deepEqual(readSettings({ rounds: 5, stop: false, mix: "silly", lang: "de" }, ["en", "de"]), { ok: true, settings: { rounds: 5, stop: false, mix: "silly", lang: "de" } });
  assert.equal(readSettings({ time: 300, late: "open" }, ["en", "de"]).ok, true);
  for (const bad of [{ rounds: 7 }, { stop: "on" }, { colour: "red" }, { lang: "fr" }, { late: "soon" }, [], null, { time: 60 }, { time: 240 }]) {
    assert.equal(readSettings(bad, ["en", "de"]).ok, false, JSON.stringify(bad));
  }
});
