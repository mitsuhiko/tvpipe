import assert from "node:assert/strict";
import { test } from "node:test";

import { distance, Matcher, plain } from "../game/answer.ts";

test("answers are made plain", () => {
  assert.equal(plain("Côte d'Ivoire"), "cotedivoire");
  assert.equal(plain("Türkei"), plain("Tuerkei"));
  assert.equal(plain("St. Lucia"), plain("Saint Lucia"));
  assert.equal(plain("Sankt Lucia"), plain("Saint Lucia"));
  assert.equal(plain("The Bahamas"), "bahamas");
  assert.equal(plain("Republik Kongo"), "kongo");
  assert.equal(plain("Weißrussland"), plain("Weissrussland"));
  assert.equal(plain("  "), "");
});

test("Damerau–Levenshtein distance", () => {
  assert.equal(distance("kitten", "sitting"), 3);
  assert.equal(distance("nigeria", "nigera"), 1);
  assert.equal(distance("abcd", "abdc"), 1);
  assert.equal(distance("", "abc"), 3);
  assert.equal(distance("same", "same"), 0);
});

const COUNTRIES = new Matcher([
  { id: "NE", names: ["Niger"] },
  { id: "NG", names: ["Nigeria"] },
  { id: "IR", names: ["Iran"] },
  { id: "IQ", names: ["Iraq", "Irak"] },
  { id: "AT", names: ["Austria", "Österreich"] },
  { id: "AU", names: ["Australia", "Australien"] },
  { id: "SI", names: ["Slovenia", "Slowenien"] },
  { id: "SK", names: ["Slovakia", "Slowakei"] },
  { id: "GM", names: ["Gambia", "The Gambia"] },
  { id: "ZM", names: ["Zambia", "Sambia"] },
  { id: "GN", names: ["Guinea"] },
  { id: "GY", names: ["Guyana"] },
  { id: "GW", names: ["Guinea-Bissau"] },
  { id: "ML", names: ["Mali"] },
  { id: "MT", names: ["Malta"] },
  { id: "DM", names: ["Dominica"] },
  { id: "DO", names: ["Dominican Republic", "Dominikanische Republik"] },
  { id: "SD", names: ["Sudan"] },
  { id: "SS", names: ["South Sudan", "Südsudan"] },
  { id: "CI", names: ["Ivory Coast", "Côte d'Ivoire", "Elfenbeinküste"] },
  { id: "US", names: ["United States", "USA", "Vereinigte Staaten"] },
  { id: "DE", names: ["Germany", "Deutschland"] },
]);
const read = (s: string) => COUNTRIES.read(s).ids;

test("an exact name is its country, however close another one is", () => {
  assert.deepEqual(read("Niger"), ["NE"]);
  assert.deepEqual(read("Nigeria"), ["NG"]);
  assert.deepEqual(read("Iran"), ["IR"]);
  assert.deepEqual(read("Iraq"), ["IQ"]);
  assert.deepEqual(read("irak"), ["IQ"]);
  assert.deepEqual(read("Austria"), ["AT"]);
  assert.deepEqual(read("Gambia"), ["GM"]);
  assert.deepEqual(read("Zambia"), ["ZM"]);
  assert.deepEqual(read("Mali"), ["ML"]);
  assert.deepEqual(read("Malta"), ["MT"]);
  assert.deepEqual(read("Dominica"), ["DM"]);
  assert.deepEqual(read("Sudan"), ["SD"]);
  assert.deepEqual(read("Guinea"), ["GN"]);
});

test("typos are forgiven toward one country only", () => {
  assert.deepEqual(read("Nigerai"), ["NG"]);
  assert.deepEqual(read("Austira"), ["AT"]);
  assert.deepEqual(read("Australai"), ["AU"]);
  assert.deepEqual(read("Slovakai"), ["SK"]);
  assert.deepEqual(read("Slowenein"), ["SI"]);
  assert.deepEqual(read("Germny"), ["DE"]);
  assert.deepEqual(read("deutschlnd"), ["DE"]);
  assert.deepEqual(read("Elfenbeinkuste"), ["CI"]);
  assert.deepEqual(read("cote divoire"), ["CI"]);
  assert.deepEqual(read("usa"), ["US"]);
  assert.deepEqual(read("Dominican Repuplic"), ["DO"]);
  assert.deepEqual(read("South Sudn"), ["SS"]);
  // As close to two countries: neither.
  assert.deepEqual(read("Nigera"), []);
  // Short names forgive nothing.
  assert.deepEqual(read("Irn"), []);
  assert.deepEqual(read("Mlai"), []);
  // Far off.
  assert.deepEqual(read("Atlantis"), []);
  assert.deepEqual(read(""), []);
});

test("the name an answer was read as comes back for the reveal", () => {
  assert.deepEqual(COUNTRIES.read("Germny"), { ids: ["DE"], name: "Germany" });
});

test("a capital two countries name is right for both", () => {
  const caps = new Matcher([
    { id: "IL", names: ["Jerusalem", "Tel Aviv"] },
    { id: "PS", names: ["Jerusalem", "Ramallah"] },
  ]);
  assert.deepEqual(caps.read("jerusalem").ids.sort(), ["IL", "PS"]);
  assert.deepEqual(caps.read("Tel Aviv").ids, ["IL"]);
});
