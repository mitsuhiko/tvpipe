import assert from "node:assert/strict";
import { test } from "node:test";

import { inRing, km, kmToLand, nearestOfCountry, nearestOnEdge } from "../game/geo.ts";
import type { Ring } from "../game/data.ts";

const near = (a: number, b: number, tol: number) => assert.ok(Math.abs(a - b) <= tol, `${a} not within ${tol} of ${b}`);

test("great-circle distances between known cities", () => {
  near(km([-0.1276, 51.5072], [2.3522, 48.8566]), 344, 3); // London–Paris
  near(km([13.405, 52.52], [-74.006, 40.7128]), 6385, 15); // Berlin–New York
  near(km([151.2093, -33.8688], [174.7633, -36.8485]), 2156, 10); // Sydney–Auckland
  near(km([179.5, 0], [-179.5, 0]), 111, 1); // across the antimeridian
  assert.equal(km([10, 10], [10, 10]), 0);
});

const SQUARE: Ring = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
];

test("inside the land is 0; outside, the nearest point of it", () => {
  assert.ok(inRing(SQUARE, 5, 5));
  assert.ok(!inRing(SQUARE, 11, 5));
  assert.equal(kmToLand([SQUARE], 5, 5), 0);
  // 1° of longitude east of the edge on the equator: ~111 km.
  near(kmToLand([SQUARE], 11, 0.0001), 111.2, 1);
  // Beside the middle of an edge (not a corner): the great circle along the edge is nearer than either corner.
  near(kmToLand([SQUARE], 5, -1), 111.2, 1);
  // Diagonally off a corner.
  near(kmToLand([SQUARE], -1, -1), km([-1, -1], [0, 0]), 0.5);
  // Several rings: the nearest counts.
  const islands: Ring[] = [SQUARE, [[20, 0], [21, 0], [21, 1], [20, 1]]];
  near(kmToLand(islands, 22, 0.5), 111.2, 1.5);
});

test("the nearest point of the land: what the reveal draws a line to", () => {
  // Below the middle of the bottom edge: straight up to it.
  const a = nearestOnEdge([SQUARE], 5, -1);
  near(a.km, 111.2, 1);
  near(a.at[0], 5, 0.01);
  near(a.at[1], 0, 0.01);
  // Off a corner: the corner.
  const b = nearestOnEdge([SQUARE], -1, -1);
  near(b.at[0], 0, 1e-6);
  near(b.at[1], 0, 1e-6);
  near(b.km, km([-1, -1], b.at), 1e-6);
  // East of the right edge.
  const c = nearestOnEdge([SQUARE], 12, 5);
  near(c.at[0], 10, 0.01);
  near(c.at[1], 5, 0.1);
  // On the land: the pin itself, 0 km; in an enclave (the shapes keep outer rings), to the country's own edge.
  const land = new Map<string | null, Ring[]>([["A", [SQUARE]], ["B", [[[4, 4], [6, 4], [6, 6], [4, 6]]]]]);
  assert.deepEqual(nearestOfCountry(land, "A", 2, 2), { km: 0, at: [2, 2] });
  const out = nearestOfCountry(land, "A", 5, 5.5);
  near(out.km, km([5, 5.5], out.at), 1e-6);
  assert.ok(out.km > 450, String(out.km));
  const inB = nearestOfCountry(land, "B", 2, 5);
  near(inB.at[0], 4, 0.01);
  near(inB.km, 222.4, 2);
});
