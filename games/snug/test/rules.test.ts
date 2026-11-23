import assert from "node:assert/strict";
import { test } from "node:test";

import {
  bonusTime,
  CHECKS,
  checkPlacement,
  connected,
  countFillings,
  deadShare,
  deal,
  fitsAnywhere,
  flip,
  generate,
  holes,
  key,
  LADDER,
  LEVELS,
  normalize,
  orientations,
  parseRows,
  PENTOMINOES,
  PIECES,
  piecesEach,
  placements,
  readCells,
  rungOf,
  sameShape,
  seeded,
  shapeCells,
  startTime,
  TETROMINOES,
  TROMINOES,
  turn,
  verdict,
  type Cell,
  type Kind,
} from "../game/rules.ts";

test("every piece has its known number of orientations", () => {
  const expect: Record<Kind, number> = {
    I3: 2, V3: 4, I4: 2, O4: 1, T4: 4, L4: 8, S4: 4,
    F5: 8, I5: 2, L5: 8, N5: 8, P5: 8, T5: 4, U5: 4, V5: 4, W5: 4, X5: 1, Y5: 8, Z5: 4,
  };
  for (const [k, n] of Object.entries(expect)) assert.equal(orientations(PIECES[k as Kind]).length, n, k);
  // The 19 free polyominoes of 3–5 cells are all different shapes.
  const all = [...TROMINOES, ...TETROMINOES, ...PENTOMINOES];
  assert.equal(all.length, 19);
  for (const a of all) for (const b of all) if (a !== b) assert.equal(sameShape(PIECES[a], PIECES[b]), false, `${a} ${b}`);
});

test("turning four times and flipping twice give the shape back; turned shapes are the same shape", () => {
  for (const k of Object.keys(PIECES) as Kind[]) {
    const base = normalize(PIECES[k]);
    assert.deepEqual(turn(turn(turn(turn(base)))), base, k);
    assert.deepEqual(flip(flip(base)), base, k);
    assert.ok(sameShape(base, turn(base)) && sameShape(base, flip(base)));
    assert.ok(sameShape(base, base.map(([x, y]) => [x + 7, y + 3] as Cell)));
  }
});

test("connected, holes", () => {
  assert.ok(connected([[0, 0], [1, 0], [1, 1]]));
  assert.ok(!connected([[0, 0], [2, 0]]));
  assert.ok(!connected([[0, 0], [0, 0]]));
  const ring = parseRows(["###", "#.#", "###"]).shape;
  assert.equal(holes(shapeCells(ring)), 1);
  const cup = parseRows(["#.#", "#.#", "###"]).shape;
  assert.equal(holes(shapeCells(cup)), 0);
});

// docs/snug-design.md §8: the example board, its one solution, and the dead end.
const EXAMPLE = ["_s__y__", "ss_yyyy", "sIIIIZv", "TTTZZZv", "_T_Zvvv"].map((r) => r.replaceAll("_", "."));

test("the design's example has exactly one filling with its six pieces", () => {
  const { shape, pieces } = parseRows(EXAMPLE);
  assert.equal(shapeCells(shape).length, 27);
  const kinds: Kind[] = ["S4", "Y5", "I4", "Z5", "V5", "T4"];
  for (const [i, letter] of ["s", "y", "I", "Z", "v", "T"].entries()) assert.ok(sameShape(PIECES[kinds[i]!], pieces.get(letter)!), letter);
  const c = countFillings(shapeCells(shape), kinds.map((k) => PIECES[k]), { limit: 10 });
  assert.deepEqual([c.count, c.complete], [1, true]);
});

test("the design's dead end: s, v and Z placed, everything fits, nothing fills the rest", () => {
  const { shape } = parseRows(EXAMPLE);
  const placed: Cell[] = [
    [1, 0], [0, 1], [1, 1], [0, 2], // s
    [6, 2], [6, 3], [4, 4], [5, 4], [6, 4], // v
    [3, 1], [3, 2], [4, 2], [5, 2], [5, 3], // Z, not where the solution has it
  ];
  const taken = new Set(placed.map(([x, y]) => key(x, y)));
  const free = shapeCells(shape).filter(([x, y]) => !taken.has(key(x, y)));
  const c = countFillings(free, [PIECES.T4, PIECES.I4, PIECES.Y5]);
  assert.deepEqual([c.count, c.complete], [0, true]);
  // The gap top right is an L of four: none of the three fits in it.
  const gap: Cell[] = [[4, 0], [4, 1], [5, 1], [6, 1]];
  for (const k of ["T4", "I4", "Y5"] as const) assert.equal(fitsAnywhere(gap, PIECES[k]), false, k);
  assert.ok(sameShape(PIECES.L4, gap));
});

test("most first placements on a board with one filling are dead ends", () => {
  const { shape } = parseRows(EXAMPLE);
  const kinds: Kind[] = ["S4", "Y5", "I4", "Z5", "V5", "T4"];
  let all = 0;
  let dead = 0;
  for (const [i, k] of kinds.entries()) {
    for (const spot of placements(shapeCells(shape), PIECES[k])) {
      all++;
      const taken = new Set(spot.map(([x, y]) => key(x, y)));
      const free = shapeCells(shape).filter(([x, y]) => !taken.has(key(x, y)));
      if (countFillings(free, kinds.filter((_, j) => j !== i).map((x) => PIECES[x]), { limit: 1 }).count === 0) dead++;
    }
  }
  assert.ok(dead / all > 0.9, `${dead}/${all}`);
});

test("the solver counts with spares, unused pieces allowed, the same shapes once", () => {
  const two = parseRows(["####", "####"]).shape;
  // Two I4s: one way (both rows). A spare O4 adds nothing alone (needs two).
  assert.equal(countFillings(shapeCells(two), [PIECES.I4, PIECES.I4]).count, 1);
  assert.equal(countFillings(shapeCells(two), [PIECES.O4, PIECES.O4]).count, 1);
  assert.equal(countFillings(shapeCells(two), [PIECES.I4, PIECES.I4, PIECES.O4, PIECES.O4]).count, 2);
  // Too few cells in the pieces: nothing, at once.
  assert.deepEqual(countFillings(shapeCells(two), [PIECES.I4]), { count: 0, complete: true, first: null });
  // The first filling's cells cover the board.
  const c = countFillings(shapeCells(two), [PIECES.L4, PIECES.L4]);
  assert.equal(c.count, 2);
  const cov = [...c.first!.values()].flat().map(([x, y]) => key(x, y)).sort();
  assert.deepEqual(cov, shapeCells(two).map(([x, y]) => key(x, y)).sort());
  // A budget that runs out says so.
  const big = parseRows(["##########", "##########", "##########", "##########"]).shape;
  const r = countFillings(shapeCells(big), Array.from({ length: 10 }, () => PIECES.I4), { limit: 1e9, budget: 50 });
  assert.equal(r.complete, false);
});

test("generated boards: no holes, compact, filled by their solution, the right pieces for every rung and size", () => {
  const rng = seeded(11);
  for (const rung of [0, 3, 4, 7]) {
    for (const players of [1, 2, 3, 4, 5, 8]) {
      const b = generate({ players, rung, rng, tries: 3 });
      const cells = shapeCells(b.shape);
      assert.equal(holes(cells), 0);
      assert.ok(cells.length / (b.shape.w * b.shape.h) >= 0.7);
      assert.equal(b.solution.length, piecesEach(players) * players);
      assert.equal(b.spares.length, players);
      assert.ok(b.dead >= 0 && b.dead <= 1);
      // The solution covers every cell once, each piece its kind.
      const seen = new Set<number>();
      for (const p of b.solution) {
        assert.ok(sameShape(PIECES[p.kind], p.cells));
        for (const [x, y] of p.cells) {
          assert.equal(b.shape.rows[y]![x], "#");
          assert.ok(!seen.has(key(x, y)));
          seen.add(key(x, y));
        }
      }
      assert.equal(seen.size, cells.length);
      const sizes = b.solution.map((p) => p.cells.length);
      if (rung === 0) assert.ok(sizes.every((n) => n === 3 || n === 4));
      else if (rung === 3) assert.ok(sizes.every((n) => n === 4));
      else assert.ok(sizes.every((n) => n === 4 || n === 5));
      assert.ok(b.shape.w >= b.shape.h * 0.8, `${b.shape.w}x${b.shape.h}`);
    }
  }
});

test("the ladder: a level says where a game starts, every filled shape climbs a rung, up to the top", () => {
  assert.deepEqual(LEVELS.map((l) => rungOf(l, 0)), [0, 3, 4]);
  assert.equal(rungOf("easy", 2), 2);
  assert.equal(rungOf("hard", 3), 7);
  assert.equal(rungOf("hard", 30), LADDER.length - 1);
  assert.equal(rungOf("normal", -1), 3);
});

test("higher rungs leave more first placements dead", () => {
  const dead = (rung: number) => {
    const rng = seeded(5);
    let sum = 0;
    for (let i = 0; i < 4; i++) sum += generate({ players: 2, rung, rng, tries: 12 }).dead;
    return sum / 4;
  };
  const [low, mid, top] = [dead(0), dead(3), dead(7)];
  assert.ok(low < mid && mid < top, `${low} ${mid} ${top}`);
  assert.ok(low < 0.65, `${low}`);
  assert.ok(top > 0.85, `${top}`);
});

test("the dead share: none on an open square, every one on a trap, the design's example near its count", () => {
  const square = parseRows(["####", "####", "####", "####"]).shape;
  const fours = Array.from({ length: 4 }, () => PIECES.I4);
  assert.equal(deadShare(square, fours, seeded(1)), 0);
  // A 2×3 block with an I3 and a V3: whichever goes in first, the other cannot fill the rest.
  const block = parseRows(["###", "###"]).shape;
  assert.equal(deadShare(block, [PIECES.I3, PIECES.V3], seeded(1)), 1);
  assert.equal(deadShare(parseRows(["#"]).shape, [PIECES.I3], seeded(1)), 1);
  // The example: about 96 % of first placements are dead (the count in the test above).
  const { shape } = parseRows(EXAMPLE);
  const kinds: Kind[] = ["S4", "Y5", "I4", "Z5", "V5", "T4"];
  const est = deadShare(shape, kinds.map((k) => PIECES[k]), seeded(2), 400, 40_000);
  assert.ok(est > 0.9, `${est}`);
});

test("a check: open at the start, stuck at the design's dead end, unsure when the search runs out", () => {
  const { shape, pieces } = parseRows(EXAMPLE);
  const kinds: Record<string, Kind> = { s: "S4", y: "Y5", I: "I4", Z: "Z5", v: "V5", T: "T4" };
  const all = shapeCells(shape);
  const hand = (letters: string) => [...letters].map((l) => PIECES[kinds[l]!]);
  assert.equal(verdict(all, hand("syIZvT")), "open");
  // s and v at home, Z one step off (§8): the L of four top right is left for T, I and y.
  const taken = new Set([...pieces.get("s")!, ...pieces.get("v")!, [3, 1], [3, 2], [4, 2], [5, 2], [5, 3]].map(([x, y]) => key(x!, y!)));
  const free = all.filter(([x, y]) => !taken.has(key(x, y)));
  assert.equal(verdict(free, hand("yIT")), "stuck");
  const big = parseRows(["##########", "##########", "##########", "##########"]).shape;
  assert.equal(verdict(shapeCells(big), Array.from({ length: 14 }, () => PIECES.V3), 50), "unsure");
});

test("checks: as many as the team likes on easy, three on normal, none to start on hard", () => {
  assert.equal(CHECKS.easy, null);
  assert.deepEqual(CHECKS.normal, { start: 3, max: 3 });
  assert.deepEqual(CHECKS.hard, { start: 0, max: 1 });
});

test("the deal: the same number of needed pieces each, a spare each, ids say nothing", () => {
  const rng = seeded(3);
  for (const players of [2, 3, 4, 7]) {
    const b = generate({ players, rung: 4, rng, tries: 2 });
    const ids = Array.from({ length: players }, (_, i) => `p${i}`);
    const hands = deal(b, ids, "1-", rng);
    const all = [...hands.values()].flat();
    assert.equal(all.length, b.solution.length + b.spares.length);
    assert.equal(new Set(all.map((p) => p.id)).size, all.length);
    for (const hand of hands.values()) {
      assert.equal(hand.filter((p) => p.home).length, piecesEach(players));
      assert.equal(hand.filter((p) => !p.home).length, 1);
      for (const p of hand) assert.ok(sameShape(PIECES[p.kind], p.cells));
    }
    // Cells per player as even as pieces of 4 and 5 allow.
    const cells = [...hands.values()].map((h) => h.filter((p) => p.home).reduce((a, p) => a + p.cells.length, 0));
    assert.ok(Math.max(...cells) - Math.min(...cells) <= 2, cells.join(","));
  }
});

test("placements: the shape turned or flipped, on the board, free", () => {
  const { shape } = parseRows(["###.", "####"]);
  const occ = new Map([[key(3, 1), "x"]]);
  const L = PIECES.L4;
  assert.deepEqual(checkPlacement(shape, occ, "a", L, [[0, 0], [0, 1], [1, 1], [2, 1]]), { ok: true });
  assert.deepEqual(checkPlacement(shape, occ, "a", L, [[0, 0], [1, 0], [2, 0], [2, 1]]), { ok: true });
  assert.deepEqual(checkPlacement(shape, occ, "a", L, [[1, 0], [2, 0], [3, 0], [3, 1]]), { ok: false, reason: "outside" });
  assert.deepEqual(checkPlacement(shape, occ, "a", L, [[1, 1], [2, 1], [3, 1], [1, 0]]), { ok: false, reason: "taken", by: "x" });
  assert.deepEqual(checkPlacement(shape, occ, "x", L, [[1, 1], [2, 1], [3, 1], [1, 0]]), { ok: true });
  assert.deepEqual(checkPlacement(shape, occ, "a", L, [[0, 0], [1, 0], [0, 1], [1, 1]]), { ok: false, reason: "shape" });
  assert.deepEqual(checkPlacement(shape, occ, "a", L, [[0, 0], [1, 0], [2, 0], [0, 0]]), { ok: false, reason: "shape" });
  assert.deepEqual(checkPlacement(shape, occ, "a", L, [[0, 0], [2, 0], [0, 1], [2, 1]]), { ok: false, reason: "shape" });
});

test("cells from the network", () => {
  assert.deepEqual(readCells([[0, 1], [2, 3]]), [[0, 1], [2, 3]]);
  for (const bad of [null, "x", [], [[0]], [[0, 1, 2]], [[-1, 0]], [[0.5, 0]], [[0, 99]], Array.from({ length: 6 }, () => [0, 0]), [["0", 0]]]) assert.equal(readCells(bad), null, JSON.stringify(bad));
});

test("the clock: 150 s and 46 s back for two players at normal pace", () => {
  assert.equal(startTime(6, "normal"), 150_000);
  assert.equal(bonusTime(6, "normal"), 46_000);
  assert.equal(startTime(6, "relaxed"), 225_000);
  assert.equal(bonusTime(16, "rushed"), 80_000);
});

test("seeded is deterministic", () => {
  const a = seeded(1);
  const b = seeded(1);
  for (let i = 0; i < 5; i++) assert.equal(a(), b());
});
