import assert from "node:assert/strict";
import { test } from "node:test";

import type { Country, Ring } from "../game/data.ts";
import type { FlagColours } from "../game/flagcolours.ts";
import { outline } from "../game/game.ts";
import { biggerOf, captainFor, rightNeighbour, compete, Deck, deckOf, factOf, fairBigger, guessOf, judgeGuesses, judgePins, knownEnough, oddOf, POOL_SIZE, ranksOf, roundsFor, seeded, strongFacts, topLists, wrongFlags } from "../game/rules.ts";
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

test("challenges come from the best-known countries of the setting, whatever the difficulty", () => {
  const deck = Array.from({ length: 200 }, (_, i) => ({ ...COUNTRIES[0]!, id: `C${i}`, fame: i + 1 }));
  const ok = knownEnough(deck, POOL_SIZE.famous);
  assert.equal(deck.filter(ok).length, 80);
  assert.equal(deck.filter(knownEnough(deck, POOL_SIZE.known)).length, 150);
  assert.equal(deck.filter(knownEnough(deck, POOL_SIZE.all)).length, 200);
});

/** A made-up country: an id, where its centre is, and what the test needs. */
function mk(id: string, at: [number, number], o: Partial<Country> = {}): Country {
  return { ...COUNTRIES[0]!, id, at, box: [at[0] - 1, at[1] - 1, at[0] + 1, at[1] + 1], flag: `${id}.svg`, neighbours: [], ...o };
}

test("pick the flag: easy far away, normal the nearest, hard the most alike colours; never one that looks the same", () => {
  // A row of countries along the equator, 1° (111 km) apart, and two far away.
  const row = Array.from({ length: 10 }, (_, i) => mk(`R${i}`, [i, 0]));
  const far = [mk("F1", [100, 0]), mk("F2", [-100, 10]), mk("F3", [150, -30])];
  const pool = [...row, ...far];
  const c = row[0]!;
  const easy = wrongFlags(c, pool, "easy", 3, seeded(1));
  assert.deepEqual(easy.map((x) => x.id).sort(), ["F1", "F2", "F3"]);
  assert.deepEqual(
    wrongFlags(c, pool, "normal", 3, seeded(1)).map((x) => x.id),
    ["R1", "R2", "R3"],
  );
  const flag = (colours: [string, number][], look = colours.map((x) => x[0]).join()): FlagColours => ({ colours, look });
  const colours = new Map<string, FlagColours>([
    ["R0.svg", flag([["#002664", 0.333], ["#fecb00", 0.333], ["#c60c30", 0.333]])],
    // Romania: alike; France: half alike; Japan: not; a copy of R0's picture: never shown.
    ["F3.svg", flag([["#002b7f", 0.333], ["#fcd116", 0.333], ["#ce1126", 0.333]])],
    ["F1.svg", flag([["#002654", 0.333], ["#ffffff", 0.333], ["#ce1126", 0.333]])],
    ["R5.svg", flag([["#ffffff", 0.8], ["#bc002d", 0.2]])],
    ["R1.svg", flag([["#002664", 0.333], ["#fecb00", 0.333], ["#c60c30", 0.333]])],
  ]);
  assert.deepEqual(
    wrongFlags(c, pool, "hard", 3, seeded(1), colours).map((x) => x.id),
    ["F3", "F1", "R5"],
  );
  // Without colours, hard falls back to the nearest.
  assert.deepEqual(
    wrongFlags(c, pool, "hard", 2, seeded(1)).map((x) => x.id),
    ["R1", "R2"],
  );
  // Too few far away: the rest at random, never the country.
  const few = wrongFlags(c, pool, "easy", 8, seeded(2));
  assert.equal(few.length, 8);
  assert.ok(!few.includes(c));
  assert.ok(far.every((f) => few.includes(f)));
});

test("which is bigger: fair fours (distinct, the biggest 10 % ahead; easy each double the next, hard within ×1.5)", () => {
  assert.ok(fairBigger([100, 50, 20, 10], "easy"));
  assert.ok(!fairBigger([100, 60, 20, 10], "easy"));
  assert.ok(fairBigger([140, 120, 110, 100], "hard"));
  assert.ok(!fairBigger([160, 120, 110, 100], "hard"));
  assert.ok(!fairBigger([105, 100, 50, 10], "normal"));
  assert.ok(!fairBigger([100, 50, 50, 10], "normal"));
  assert.ok(!fairBigger([100, 50, 0, 10], "normal"));
  assert.ok(fairBigger([111, 100, 99, 1], "normal"));
  const pool = Array.from({ length: 40 }, (_, i) =>
    mk(`P${i}`, [i, 0], { population: Math.round(1000 * 1.3 ** i), area: 1000 + i * 37, gdp: 500 * (i + 1), highest: { name: { en: "x", de: "x" }, m: 100 + i * 11 } }),
  );
  for (const d of ["easy", "normal", "hard"] as const)
    for (let k = 0; k < 20; k++) {
      const c = pool[(k * 7) % 40]!;
      const b = biggerOf(c, pool, d, seeded(k));
      assert.ok(b, `${d} ${c.id}`);
      assert.equal(b.options.length, 4);
      assert.ok(b.options.includes(c));
      const v = b.options.map((o) => factOf(o, b.fact, new Set()));
      assert.equal(v[b.right], Math.max(...v));
      assert.ok(fairBigger([...v].sort((x, y) => y - x), d), `${d}: ${v}`);
    }
  // Nobody to stand with: null.
  assert.equal(biggerOf(pool[0]!, [pool[0]!, pool[1]!], "normal", seeded(1)), null);
});

test("guess the number: closest by ratio, ties within 10 % of its ratio, too far never wins", () => {
  const g = (o: Record<string, number>) => new Map(Object.entries(o));
  // 100 is the answer: 120 is off by 1.2, 80 by 1.25, 130 by 1.3.
  const r = judgeGuesses(g({ a: 120, b: 80, c: 130, d: 300 }), 100, 2);
  assert.deepEqual(r.winners, ["a", "b", "c"].filter((p) => r.off.get(p)! <= 1.2 * 1.1 + 1e-12));
  assert.deepEqual(r.winners, ["a", "b", "c"]);
  assert.equal(Math.round(r.off.get("d")! * 1000), 3000);
  assert.deepEqual(judgeGuesses(g({ a: 100, b: 109, c: 112 }), 100, 2).winners, ["a", "b"]);
  // Off by more than the level's factor: nobody, even the best.
  assert.deepEqual(judgeGuesses(g({ a: 250, b: 40 }), 100, 2).winners, []);
  assert.deepEqual(judgeGuesses(g({ a: 140 }), 100, 1.5).winners, ["a"]);
  // The band stops at the factor.
  assert.deepEqual(judgeGuesses(g({ a: 145, b: 155 }), 100, 1.5).winners, ["a"]);
  assert.deepEqual(judgeGuesses(g({}), 100, 2).winners, []);
  // A number off the slider is not asked.
  assert.equal(guessOf(mk("V", [0, 0], { population: 800, area: 0.4, highest: { name: { en: "x", de: "x" }, m: 75 } }), seeded(1))?.fact, "highest");
  assert.equal(guessOf(mk("V", [0, 0], { population: 800, area: 0.4, highest: { name: { en: "x", de: "x" }, m: 5 } }), seeded(1)), null);
});

test("name a neighbour: any neighbour, never the country itself, not even by a name they share", () => {
  const nb = ["CG", "AO", "ZM"];
  assert.ok(rightNeighbour(["AO"], "CD", nb));
  assert.ok(!rightNeighbour(["CD"], "CD", nb));
  // "Congo" reads as both Congos: for the Democratic Republic it is its own name too.
  assert.ok(!rightNeighbour(["CD", "CG"], "CD", nb));
  assert.ok(!rightNeighbour(["FR"], "CD", nb));
  assert.ok(!rightNeighbour([], "CD", nb));
});

test("odd one out: three neighbours and one that is not, never from far away; easy 800–2500 km, normal within 1500 km, hard the nearest", () => {
  const x = mk("X", [0, 0], { neighbours: ["N1", "N2", "N3", "N4"] });
  const ns = [mk("N1", [2, 0]), mk("N2", [-2, 0]), mk("N3", [0, 2]), mk("N4", [0, -2])];
  const near = mk("C1", [4, 0]);
  // 444, 1,334 and 6,670 km from X.
  const mid = mk("C2", [12, 0]);
  const far = mk("C3", [60, 0]);
  const deck = [x, ...ns, near, mid, far];
  const odd = (d: "easy" | "normal" | "hard", seed: number) => {
    const o = oddOf(x, deck, deck, d, seeded(seed))!;
    assert.equal(o.options.length, 4);
    assert.equal(o.options.filter((c) => ns.includes(c)).length, 3);
    return o.options[o.right]!.id;
  };
  for (let k = 0; k < 10; k++) {
    assert.equal(odd("easy", k), "C2");
    assert.ok(["C1", "C2"].includes(odd("normal", k)));
    assert.equal(odd("hard", k), "C1");
  }
  // Neighbours not in the deck do not count: two left is too few.
  assert.equal(oddOf(x, [x, ns[0]!, ns[1]!, near], [near], "hard", seeded(1)), null);
});

test("a shape's outline: delta-coded hundredths, the biggest rings, tiny islands dropped", () => {
  const sq = (x: number, y: number, s: number): Ring => [[x, y], [x + s, y], [x + s, y + s], [x, y + s]];
  const coded = outline([sq(10, 10, 0.05), sq(1, 2, 2)]);
  assert.deepEqual(coded, [[100, 200, 200, 0, 0, 200, -200, 0]]);
  assert.equal(outline([sq(0, 0, 1), sq(5, 5, 0.2)]).length, 2);
});
