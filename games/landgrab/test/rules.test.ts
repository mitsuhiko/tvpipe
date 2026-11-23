import assert from "node:assert/strict";
import { test } from "node:test";

import { botPlan } from "../game/bots.ts";
import {
  armiesAlong,
  autoPlace,
  checkPlan,
  deal,
  dominator,
  fight,
  losses,
  PlanError,
  reinforcements,
  resolve,
  seeded,
  startTerritories,
  uprisingAt,
  type Board,
  type Plan,
} from "../game/rules.ts";
import { eventMs, PACE, paceScale, rollTimes, timeline } from "../game/timeline.ts";
import { parseWorld } from "../game/world.ts";

/**
 * A small world: two continents. Row 0: aa aa bb bb · cc; row 1: aa bb bb dd · cc
 * (cc is an island, linked to dd by sea).
 */
const TINY = `
grid 6 2
continent no 2 North | Nord
continent so 1 South | Süd
territory aa no 0 0 Aland | Aland
territory bb no 2 0 Bland | Bland
territory dd so 3 1 Dland | Dland
territory cc so 5 0 Cland | Cland
link dd cc
map
aaaabbbb..cc
aabbbbdd..cc
`;
const world = parseWorld(TINY);
const ix = (id: string) => world.byId.get(id)!.index;

/** A board from `{ id: [holder, armies] }`. */
function board(spec: Record<string, [string, number]>): Board {
  const b: Board = { own: world.territories.map(() => ""), arm: world.territories.map(() => 1) };
  for (const [t, [o, a]] of Object.entries(spec)) {
    b.own[ix(t)] = o;
    b.arm[ix(t)] = a;
  }
  return b;
}

const plan = (p: Partial<Plan>): Plan => ({ place: {}, orders: [], cash: false, ready: true, ...p });

test("the tiny world's neighbours: by land, and by sea where linked", () => {
  assert.deepEqual(
    world.territories.map((t) => [t.id, t.neighbors]),
    [
      ["aa", ["bb"]],
      ["bb", ["aa", "dd"]],
      ["dd", ["bb", "cc"]],
      ["cc", ["dd"]],
    ],
  );
});

test("losses: the defender wins ties; head-on a tie costs both", () => {
  assert.deepEqual(losses([[6, 3, 1], [5, 4]]), [1, 1]);
  assert.deepEqual(losses([[6, 5, 1], [5, 4]]), [0, 2]);
  assert.deepEqual(losses([[4, 4, 1], [4, 4]]), [2, 0]);
  assert.deepEqual(losses([[2], [6, 1]]), [1, 0]);
  assert.deepEqual(losses([[4, 4, 1], [4, 4, 2]], true), [2, 2]);
});

test("fight: to the end, with at most three and two dice, and the same throws for the same seed", () => {
  const a = fight(10, 7, seeded(3));
  const b = fight(10, 7, seeded(3));
  assert.deepEqual(a, b);
  assert.ok(a.att === 0 || a.def === 0);
  let att = 10;
  let def = 7;
  for (const roll of a.rolls) {
    assert.equal(roll[0].length, Math.min(3, att));
    assert.equal(roll[1].length, Math.min(2, def));
    assert.deepEqual(roll[0], [...roll[0]].sort((x, y) => y - x));
    const [la, ld] = losses(roll);
    att -= la;
    def -= ld;
  }
  assert.deepEqual([att, def], [a.att, a.def]);
});

test("reinforcements: a third of the territories, at least three, plus whole continents", () => {
  assert.deepEqual(reinforcements(world, board({ aa: ["x", 2] }), "x"), { base: 3, bonus: [], total: 3 });
  assert.deepEqual(reinforcements(world, board({ aa: ["x", 2], bb: ["x", 1] }), "x"), { base: 3, bonus: [["no", 2]], total: 5 });
});

test("deal: everyone the same number of territories, never a whole continent, 2 armies each", () => {
  for (let seed = 1; seed < 40; seed++) {
    const b = deal(world, ["x", "y"], seeded(seed));
    const k = Math.min(startTerritories(2, 4), 2);
    assert.equal(b.own.filter((o) => o === "x").length, k);
    assert.equal(b.own.filter((o) => o === "y").length, k);
    for (const c of world.continents) {
      const owners = new Set(c.territories.map((t) => b.own[ix(t)]));
      assert.ok(owners.size > 1 || [...owners][0] === "", `seed ${seed}: ${c.id} whole`);
    }
    b.own.forEach((o, i) => (o ? assert.equal(b.arm[i], 2) : assert.ok(b.arm[i]! >= 1 && b.arm[i]! <= 3)));
  }
});

test("checkPlan: own territories, neighbours, one army stays, no more than there is to place", () => {
  const b = board({ aa: ["x", 3], bb: ["x", 1], dd: ["y", 2] });
  const err = (raw: unknown, code: string, stars = 0) =>
    assert.throws(
      () => checkPlan(world, b, "x", 3, stars, raw),
      (e: unknown) => e instanceof PlanError && e.code === code,
    );
  assert.deepEqual(checkPlan(world, b, "x", 3, 0, { place: { aa: 2, bb: 0 }, orders: [{ from: "aa", to: "bb", n: 2 }, { from: "aa", to: "bb", n: 2 }], ready: true }), {
    place: { aa: 2 },
    orders: [{ from: "aa", to: "bb", n: 4 }],
    cash: false,
    ready: true,
  });
  err({ place: { dd: 1 } }, "not-yours");
  err({ place: { aa: 4 } }, "too-many");
  err({ orders: [{ from: "aa", to: "dd", n: 1 }] }, "not-neighbor");
  err({ orders: [{ from: "dd", to: "bb", n: 1 }] }, "not-yours");
  err({ orders: [{ from: "aa", to: "bb", n: 3 }] }, "too-few-armies");
  err({ orders: [{ from: "aa", to: "bb", n: 0 }] }, "bad-plan");
  err({ cash: true }, "no-stars", 2);
  err([], "bad-plan");
  // Moved armies may march on, in a later order only.
  assert.deepEqual(
    checkPlan(world, b, "x", 0, 0, { orders: [{ from: "aa", to: "bb", n: 2 }, { from: "bb", to: "dd", n: 2 }] }).orders,
    [{ from: "aa", to: "bb", n: 2 }, { from: "bb", to: "dd", n: 2 }],
  );
  err({ orders: [{ from: "bb", to: "dd", n: 2 }, { from: "aa", to: "bb", n: 2 }] }, "too-few-armies");
  err({ orders: [{ from: "aa", to: "bb", n: 2 }, { from: "bb", to: "dd", n: 3 }] }, "too-few-armies");
  assert.deepEqual(
    armiesAlong(world, b, "x", { aa: 1 }, [{ from: "aa", to: "bb", n: 3 }, { from: "bb", to: "dd", n: 2 }]).map((m) => [m.get("aa"), m.get("bb"), m.get("dd")]),
    [[1, 4, 2], [1, 2, 2]],
  );
  // Placed armies may march on; cashed stars add five.
  assert.equal(checkPlan(world, b, "x", 3, 3, { place: { bb: 8 }, orders: [{ from: "bb", to: "dd", n: 8 }], cash: true }).orders[0]!.n, 8);
});

test("autoPlace: the border under pressure gets the armies", () => {
  const b = board({ aa: ["x", 5], bb: ["x", 1], dd: ["y", 6] });
  assert.deepEqual(autoPlace(world, b, "x", 4), { bb: 4 });
  assert.deepEqual(autoPlace(world, b, "nobody", 4), {});
});

test("resolve: reinforcements first, then the orders round robin; a lost territory's order is cancelled", () => {
  // x attacks dd from bb with 9; y's order from dd comes after x's first order and finds dd taken.
  const b = board({ aa: ["x", 2], bb: ["x", 2], dd: ["y", 1], cc: ["y", 1] });
  const plans = new Map([
    ["x", plan({ place: { bb: 8 }, orders: [{ from: "bb", to: "dd", n: 9 }] })],
    ["y", plan({ place: { dd: 1 }, orders: [{ from: "cc", to: "dd", n: 1 }] })],
  ]);
  const { events, captured } = resolve(world, b, plans, ["x", "y"], seeded(1));
  assert.deepEqual(
    events.map((e) => e.type),
    ["place", "attack", "cancel"],
  );
  const attack = events[1]!;
  assert.ok(attack.type === "attack");
  assert.equal(attack.def, 2);
  assert.equal(attack.n, 9);
  assert.ok(attack.won);
  assert.equal(b.own[ix("dd")], "x");
  assert.equal(b.arm[ix("dd")], attack.left);
  assert.equal(b.arm[ix("bb")], 1);
  assert.deepEqual([...captured], ["x"]);
  // The events' changes, applied in order, end at the board.
  const replay = board({ aa: ["x", 2], bb: ["x", 2], dd: ["y", 1], cc: ["y", 1] });
  for (const e of events) {
    for (const [i, o, a] of e.was) assert.deepEqual([replay.own[i], replay.arm[i]], [o, a], `${e.type}: was`);
    for (const [i, o, a] of e.set) (replay.own[i] = o), (replay.arm[i] = a);
  }
  assert.deepEqual(replay, b);
});

test("resolve: an order sends at most all but one army, and a move adds to the target", () => {
  const b = board({ aa: ["x", 4], bb: ["x", 1], dd: ["y", 1] });
  const { events } = resolve(world, b, new Map([["x", plan({ orders: [{ from: "aa", to: "bb", n: 9 }] })]]), ["x"], seeded(1));
  assert.deepEqual(events, [{ type: "move", p: "x", from: ix("aa"), to: ix("bb"), n: 3, was: [[ix("aa"), "x", 4], [ix("bb"), "x", 1]], set: [[ix("aa"), "x", 1], [ix("bb"), "x", 4]] }]);
});

test("resolve: armies moved in march on in a later order", () => {
  const b = board({ aa: ["x", 3], bb: ["x", 1], dd: ["y", 1] });
  const { events } = resolve(world, b, new Map([["x", plan({ orders: [{ from: "aa", to: "bb", n: 2 }, { from: "bb", to: "dd", n: 2 }] })]]), ["x"], seeded(1));
  assert.deepEqual(
    events.map((e) => [e.type, "n" in e ? e.n : 0]),
    [["move", 2], ["attack", 2]],
  );
});

test("resolve: two armies marching against each other clash halfway, the survivors march on", () => {
  for (let seed = 1; seed < 30; seed++) {
    const b = board({ aa: ["x", 2], bb: ["x", 8], dd: ["y", 8], cc: ["y", 1] });
    const plans = new Map([
      ["x", plan({ orders: [{ from: "bb", to: "dd", n: 7 }] })],
      ["y", plan({ orders: [{ from: "dd", to: "bb", n: 7 }] })],
    ]);
    const { events } = resolve(world, b, plans, ["x", "y"], seeded(seed));
    assert.equal(events.length, 1, "the clash takes both orders");
    const e = events[0]!;
    assert.ok(e.type === "clash");
    assert.equal(e.na, 7);
    assert.equal(e.nb, 7);
    assert.ok(e.leftA === 0 || e.leftB === 0);
    if (e.leftA > 0) assert.deepEqual([e.then?.p, e.then?.n, e.then?.def], ["x", e.leftA, 1]);
    else if (e.leftB > 0) assert.deepEqual([e.then?.p, e.then?.n, e.then?.def], ["y", e.leftB, 1]);
    else assert.equal(e.then, null);
    for (const r of e.rolls) assert.ok(r[1].length <= 3);
  }
});

test("resolve: a continent taken whole and a player wiped out are part of the event", () => {
  const b = board({ aa: ["x", 9], bb: ["y", 1], dd: ["z", 1], cc: ["z", 1] });
  const rng = seeded(4);
  const { events } = resolve(world, b, new Map([["x", plan({ orders: [{ from: "aa", to: "bb", n: 8 }] })]]), ["x"], rng);
  const e = events[0]!;
  assert.ok(e.type === "attack");
  if (e.won) {
    assert.equal(e.continent, "no");
    assert.equal(e.out, "y");
  }
});

test("uprising: on the leader's weakest territory, never their last one; else the weakest wild land", () => {
  const b = board({ aa: ["x", 5], bb: ["x", 2], dd: ["y", 1] });
  assert.equal(uprisingAt(world, b, ["x", "y", "z"], seeded(1)), ix("bb"));
  const c = board({ aa: ["x", 5], cc: ["", 3], dd: ["", 2], bb: ["", 4] });
  assert.equal(uprisingAt(world, c, ["x", "z"], seeded(1)), ix("dd"));
});

test("dominator: three quarters of the world", () => {
  assert.equal(dominator(board({ aa: ["x", 1], bb: ["x", 1], dd: ["x", 1] })), "x");
  assert.equal(dominator(board({ aa: ["x", 1], bb: ["x", 1] })), undefined);
});

test("timeline: slow first throws, fast later ones within the cap; the battle scaled into the budget", () => {
  assert.deepEqual(rollTimes(1, PACE), [PACE.roll]);
  assert.deepEqual(rollTimes(4, PACE), [PACE.roll, PACE.roll, PACE.fastRoll, PACE.fastRoll]);
  const many = rollTimes(40, PACE);
  assert.ok(many.reduce((s, x) => s + x, 0) <= PACE.maxRolls + 40);
  const b = board({ aa: ["x", 9], bb: ["y", 3] });
  const { events } = resolve(world, b, new Map([["x", plan({ orders: [{ from: "aa", to: "bb", n: 8 }] })]]), ["x"], seeded(2));
  const e = events[0]!;
  const t = timeline(e, PACE);
  assert.equal(t[0]![0], "intro");
  assert.equal(t.filter(([n]) => n.startsWith("roll:")).length, e.type === "attack" ? e.rolls.length : 0);
  assert.equal(eventMs(e, PACE), t.at(-1)![1] + t.at(-1)![2]);
  assert.equal(paceScale(events, PACE), 1);
  assert.equal(paceScale(Array(200).fill(e), PACE), PACE.minScale);
});

test("botPlan: a plan the rules accept, all armies placed, ready", () => {
  for (let seed = 1; seed < 30; seed++) {
    const b = deal(world, ["x", "y"], seeded(seed));
    const p = botPlan(world, b, "x", 3, 3, seeded(seed));
    const checked = checkPlan(world, b, "x", 3, 3, p);
    assert.equal(
      Object.values(checked.place).reduce((s, n) => s + n, 0),
      8,
    );
    assert.equal(checked.ready, true);
  }
});
