import assert from "node:assert/strict";
import { test } from "node:test";

import { captainFor, compete, Deck, deckOf, factOf, judgePins, knownEnough, LEVELS, ranksOf, roundsFor, seeded, strongFacts, topLists } from "../game/rules.ts";
import { COUNTRIES } from "./world.ts";

test("the deck: every card comes up once before any comes back", () => {
  const deck = new Deck([1, 2, 3, 4, 5], seeded(1));
  const first = [deck.draw(), deck.draw(), deck.draw()];
  deck.discard(...first);
  const rest = [deck.draw(), deck.draw()];
  assert.deepEqual([...first, ...rest].sort(), [1, 2, 3, 4, 5]);
  assert.equal(deck.left, 0);
  assert.equal(deck.reshuffles, 0);
  deck.discard(...rest);
  const again = [deck.draw(), deck.draw(), deck.draw(), deck.draw(), deck.draw()];
  assert.deepEqual(again.sort(), [1, 2, 3, 4, 5]);
  assert.equal(deck.reshuffles, 1);
});

test("the deck: a picky draw takes the pile in when the deck has nothing it accepts, else any card", () => {
  const deck = new Deck([1, 2, 3, 4], seeded(2));
  const a = [deck.draw((n) => n % 2 === 0), deck.draw((n) => n % 2 === 0)].sort();
  assert.deepEqual(a, [2, 4]);
  deck.discard(2, 4);
  assert.equal(deck.draw((n) => n % 2 === 0) % 2, 0);
  assert.equal(deck.reshuffles, 1);
  // Nothing anywhere fits: any card.
  assert.ok([1, 2, 3, 4].includes(deck.draw((n) => n > 10)));
});

test("the deck: cards held out are not in it", () => {
  const deck = new Deck(["a", "b"], seeded(3));
  deck.draw();
  deck.draw();
  assert.throws(() => deck.draw(), /no card/);
});

test("disputed states are only in the deck with the option, and only count as neighbours there", () => {
  assert.equal(deckOf(COUNTRIES, false).length, 5);
  assert.equal(deckOf(COUNTRIES, true).length, 6);
  const cc = COUNTRIES.find((c) => c.id === "CC")!;
  const without = new Set(deckOf(COUNTRIES, false).map((c) => c.id));
  const withX = new Set(deckOf(COUNTRIES, true).map((c) => c.id));
  assert.equal(factOf(cc, "neighbours", without), 2);
  assert.equal(factOf(cc, "neighbours", withX), 3);
});

test("ranks: 1 is the highest, equal numbers share a rank", () => {
  const deck = deckOf(COUNTRIES, false);
  const r = ranksOf(deck);
  assert.equal(r.get("CC")!.population, 1);
  assert.equal(r.get("EE")!.population, 5);
  assert.equal(r.get("EE")!.gdp, 1);
  // Neighbours: AA, BB, CC, DD have 2 each (XK is out), EE 0.
  assert.deepEqual(
    ["AA", "BB", "CC", "DD", "EE"].map((id) => r.get(id)!.neighbours),
    [1, 1, 1, 1, 5],
  );
  assert.deepEqual(strongFacts(r.get("EE")!), ["population", "area", "neighbours", "highest", "gdp"]);
  const tops = topLists(deck, r);
  assert.deepEqual(tops.population, ["CC", "AA", "BB", "DD", "EE"]);
});

test("compete: the highest number wins, a tie at the top wins together", () => {
  const ids = new Set(deckOf(COUNTRIES, false).map((c) => c.id));
  const by = (id: string) => COUNTRIES.find((c) => c.id === id)!;
  const hands = new Map([
    ["p1", by("AA")],
    ["p2", by("BB")],
    ["p3", by("EE")],
  ]);
  assert.deepEqual(compete(hands, "gdp", ids).winners, ["p3"]);
  assert.deepEqual(compete(hands, "gdp", ids).order, ["p3", "p2", "p1"]);
  assert.deepEqual(compete(hands, "neighbours", ids).winners.sort(), ["p1", "p2"]);
});

test("rounds go up to a multiple of the players", () => {
  assert.equal(roundsFor(15, 6), 18);
  assert.equal(roundsFor(15, 5), 15);
  assert.equal(roundsFor(30, 4), 32);
  assert.equal(roundsFor(45, 10), 50);
  assert.equal(roundsFor(15, 1), 15);
});

test("the captain goes round the seats, skipping those away", () => {
  const seats = ["a", "b", "c"];
  assert.equal(captainFor(1, seats, () => true), "a");
  assert.equal(captainFor(2, seats, () => true), "b");
  assert.equal(captainFor(4, seats, () => true), "a");
  assert.equal(captainFor(2, seats, (id) => id !== "b"), "c");
  assert.equal(captainFor(1, seats, () => false), undefined);
});

test("pins: on the land is a hit, near-equal pins tie with the best, too far never wins", () => {
  const d = (o: Record<string, number>) => new Map(Object.entries(o));
  assert.deepEqual(judgePins(d({ a: 0, b: 20, c: 26 }), 1500), { winners: ["a", "b"], band: 25 });
  // 10 %: the best 300 km wins with everyone up to 330, not 331.
  assert.deepEqual(judgePins(d({ a: 300, b: 330, c: 331 }), 1500).winners, ["a", "b"]);
  // 25 km beats 10 % for short distances.
  assert.deepEqual(judgePins(d({ a: 100, b: 124, c: 126 }), 1500).winners, ["a", "b"]);
  // The margin is from the best only: no chaining.
  assert.deepEqual(judgePins(d({ a: 1000, b: 1100, c: 1200 }), 1500).winners, ["a", "b"]);
  assert.deepEqual(judgePins(d({ a: 1600 }), 1500), { winners: [], band: null });
  assert.deepEqual(judgePins(d({}), 1500), { winners: [], band: null });
});

test("challenges on easy come from the best-known countries", () => {
  const deck = Array.from({ length: 200 }, (_, i) => ({ ...COUNTRIES[0]!, id: `C${i}`, fame: i + 1 }));
  const ok = knownEnough(deck, LEVELS.easy);
  assert.equal(deck.filter(ok).length, 80);
  assert.equal(deck.filter(knownEnough(deck, LEVELS.normal)).length, 150);
  assert.equal(deck.filter(knownEnough(deck, LEVELS.hard)).length, 200);
});
