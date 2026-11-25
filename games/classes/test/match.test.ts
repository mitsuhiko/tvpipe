import assert from "node:assert/strict";
import { test } from "node:test";

import { answerKey, editDistance, groupAnswers, sameAnswer, type Same } from "../game/match.ts";

test("keys: cleaning (§5.1, rule 1)", () => {
  const cases: [string, "en" | "de", string][] = [
    ["New York", "en", "newyork"],
    ["new-york", "en", "newyork"],
    ["  NEW   YORK!  ", "en", "newyork"],
    ["The Beatles", "en", "beatles"],
    ["The", "en", "the"],
    ["Seven Up", "en", "7up"],
    ["7 Up", "en", "7up"],
    ["Köln", "de", "koeln"],
    ["Koeln", "de", "koeln"],
    ["Straße", "de", "strasse"],
    ["Crème brûlée", "en", "cremebrulee"],
    ["Der Hund", "de", "hund"],
    ["Einen Kaffee", "de", "kaffee"],
    ["Die Hard", "en", "diehard"],
    ["The Beatles", "de", "beatles"],
    ["Der Hund", "en", "derhund"],
    ["Fünf Freunde", "de", "5freunde"],
    ["Ｆｕｌｌ ｗｉｄｔｈ", "en", "fullwidth"],
    ["Anna's", "en", "annas"],
  ];
  for (const [text, lang, key] of cases) assert.equal(answerKey(text, lang), key, text);
  assert.equal(answerKey("Köln", "de", true), "koln");
  // Austrian German is German.
  assert.equal(answerKey("Die Fünf Freunde", "at"), "5freunde");
  assert.equal(sameAnswer("Köln", "Koeln", "at"), "same");
});

test("edit distance: Damerau–Levenshtein (adjacent swaps are one edit)", () => {
  assert.equal(editDistance("amsterdam", "amsterdan"), 1);
  assert.equal(editDistance("amsterdam", "amstredam"), 1);
  assert.equal(editDistance("kitten", "sitting"), 3);
  assert.equal(editDistance("", "abc"), 3);
  assert.equal(editDistance("abc", "abc"), 0);
});

test("the same answer: known answers in English and German", () => {
  const cases: [string, string, "en" | "de", Same | null][] = [
    // same
    ["New York", "new-york", "en", "same"],
    ["Seven Up", "7 Up", "en", "same"],
    ["The Beatles", "Beatles", "en", "same"],
    ["The Beatles", "Beatles", "de", "same"],
    ["Die Ärzte", "Ärzte", "en", null],
    ["Köln", "Koeln", "de", "same"],
    ["Éclair", "eclair", "en", "same"],
    ["Die Ärzte", "Aerzte", "de", "same"],
    ["Fussball", "Fußball", "de", "same"],
    // spelling
    ["Köln", "Koln", "de", "spelling"],
    ["Mississippi", "Mississipi", "en", "spelling"],
    ["Kaffee", "Kafe", "de", "spelling"],
    ["Müller", "Muler", "de", "spelling"],
    // plural (English only)
    ["Apple", "Apples", "en", "plural"],
    ["Peach", "Peaches", "en", "plural"],
    ["Cats", "Cat", "en", null],
    ["Auto", "Autos", "en", "plural"],
    ["Auto", "Autos", "de", null],
    ["Banane", "Bananen", "de", "typo"],
    // typo
    ["Amsterdam", "Amsterdan", "en", "typo"],
    ["Amsterdam", "Amstredam", "en", "typo"],
    ["Donaudampfschiff", "Donaudampfschif", "de", "spelling"],
    ["Hamburg", "Homburg", "de", "typo"],
    ["Paris", "Parts", "en", null],
    // nothing about meaning
    ["Munich", "München", "en", null],
    ["NYC", "New York", "en", null],
    ["", "", "en", null],
    ["!!!", "?", "en", null],
  ];
  for (const [a, b, lang, want] of cases) {
    assert.equal(sameAnswer(a, b, lang), want, `${a} / ${b} (${lang})`);
    assert.equal(sameAnswer(b, a, lang), want, `${b} / ${a} (${lang})`);
  }
});

test("grouping: transitive, in order, the loosest link as the reason", () => {
  assert.deepEqual(groupAnswers(["Amsterdam", "Berlin", "amsterdam", "Amsterdan", "Bern"], "en"), [{ members: [0, 2, 3], same: "typo" }, { members: [1] }, { members: [4] }]);
  assert.deepEqual(groupAnswers(["Köln", "Koeln", "KOELN"], "de"), [{ members: [0, 1, 2], same: "same" }]);
  // Koln joins Köln by spelling, Koeln joins Köln as the same: one group.
  assert.deepEqual(groupAnswers(["Koln", "Koeln", "Köln"], "de"), [{ members: [0, 1, 2], same: "spelling" }]);
  // A chain: a ≈ b ≈ c makes one group even when a and c are further apart.
  assert.deepEqual(groupAnswers(["Amsterdam", "Amsterdan", "Amstardan"], "en"), [{ members: [0, 1, 2], same: "typo" }]);
  assert.deepEqual(groupAnswers([], "en"), []);
});
