import assert from "node:assert/strict";
import { test } from "node:test";

import { inRing, km, kmToLand } from "../game/geo.ts";
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
