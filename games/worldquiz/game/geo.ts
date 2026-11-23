/**
 * Distances on the globe (docs/worldquiz-design.md §4.3): from a pin to
 * the nearest point of a country's land, along a great circle, 0 when
 * the pin is on it. Flat map and globe are judged the same this way.
 */

import type { Ring } from "./data.ts";

export const EARTH_KM = 6371.0088;
const D2R = Math.PI / 180;

type V3 = [number, number, number];

/** A point on the unit sphere. */
export function vec(lon: number, lat: number): V3 {
  const l = lon * D2R;
  const p = lat * D2R;
  return [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)];
}

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const angle = (a: V3, b: V3) => Math.atan2(Math.hypot(...cross(a, b)), dot(a, b));

/** Great-circle distance between two points (km). */
export function km(a: [number, number], b: [number, number]): number {
  return angle(vec(a[0], a[1]), vec(b[0], b[1])) * EARTH_KM;
}

/** Whether a point lies inside a ring (lon/lat, even-odd; rings do not cross the antimeridian). */
export function inRing(ring: Ring, lon: number, lat: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** The angle from p to the arc a–b (radians). */
function toArc(p: V3, a: V3, b: V3): number {
  let d = Math.min(angle(p, a), angle(p, b));
  const n = cross(a, b);
  const m = Math.hypot(...n);
  if (m < 1e-12) return d;
  const u: V3 = [n[0] / m, n[1] / m, n[2] / m];
  const s = dot(p, u);
  const q: V3 = [p[0] - s * u[0], p[1] - s * u[1], p[2] - s * u[2]];
  const qm = Math.hypot(...q);
  if (qm < 1e-12) return d;
  const qq: V3 = [q[0] / qm, q[1] / qm, q[2] / qm];
  if (dot(cross(a, qq), u) >= 0 && dot(cross(qq, b), u) >= 0) d = Math.min(d, angle(p, qq));
  return d;
}

/** From a pin to the nearest point of the land (km): 0 inside any ring. */
export function kmToLand(rings: readonly Ring[], lon: number, lat: number): number {
  for (const r of rings) if (inRing(r, lon, lat)) return 0;
  return kmToEdge(rings, lon, lat);
}

/** A ring's area in square degrees (for comparing sizes, not for numbers). */
export function ringArea(r: Ring): number {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j]![0] + r[i]![0]) * (r[j]![1] - r[i]![1]);
  return Math.abs(a / 2);
}

/**
 * Whose land a pin is on: the smallest ring holding it wins, so an
 * enclave (Lesotho in South Africa, San Marino and the Vatican in Italy;
 * the shapes keep outer rings only) is its own country's, not the
 * country around it.
 */
export function ownerAt(land: ReadonlyMap<string | null, readonly Ring[]>, lon: number, lat: number): string | null | undefined {
  let best: string | null | undefined;
  let size = Infinity;
  for (const [id, rings] of land)
    for (const r of rings)
      if (inRing(r, lon, lat)) {
        const a = ringArea(r);
        if (a < size) {
          size = a;
          best = id;
        }
      }
  return best;
}

/**
 * From a pin to a country (km): 0 on its land, else to the nearest point
 * of its border; a pin in an enclave is outside the country around it.
 */
export function kmToCountry(land: ReadonlyMap<string | null, readonly Ring[]>, id: string, lon: number, lat: number): number {
  const rings = land.get(id) ?? [];
  if (!rings.some((r) => inRing(r, lon, lat))) return kmToEdge(rings, lon, lat);
  return ownerAt(land, lon, lat) === id ? 0 : kmToEdge(rings, lon, lat);
}

/** From a pin to the nearest point of the rings' edges (km). */
export function kmToEdge(rings: readonly Ring[], lon: number, lat: number): number {
  const p = vec(lon, lat);
  let best = Math.PI;
  for (const r of rings) {
    for (let i = 0; i < r.length; i++) {
      const a = r[i]!;
      const b = r[(i + 1) % r.length]!;
      const d = toArc(p, vec(a[0], a[1]), vec(b[0], b[1]));
      if (d < best) best = d;
    }
  }
  return best * EARTH_KM;
}
