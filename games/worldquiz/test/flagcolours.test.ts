import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { arcPoints, colourDistance, colourOf, deltaE, flagColours, lab, parsePath, parseTransform, parseXml, rasterise } from "../game/flagcolours.ts";
import { coloursFile } from "../scripts/colours.ts";

const share = (svg: string) => Object.fromEntries(flagColours(svg).colours);

test("xml: tags, attributes, entities, comments, a doctype with a subset, CDATA", () => {
  const el = parseXml(`<?xml version="1.0"?><!DOCTYPE svg [ <!ENTITY x "y"> ]><!-- hi --><svg a="1" b='&amp;2'><g/><style><![CDATA[.a{fill:red}]]></style></svg>`);
  assert.equal(el.name, "svg");
  assert.deepEqual(el.attrs, { a: "1", b: "&2" });
  assert.deepEqual(
    el.kids.map((k) => k.name),
    ["g", "style"],
  );
  assert.equal(el.kids[1]!.text, ".a{fill:red}");
});

test("colours: hex, short hex, rgb(), names, none", () => {
  assert.equal(colourOf("#ABC"), "#aabbcc");
  assert.equal(colourOf("#D00"), "#dd0000");
  assert.equal(colourOf("rgb(255, 0, 128)"), "#ff0080");
  assert.equal(colourOf("rgb(100%,0%,0%)"), "#ff0000");
  assert.equal(colourOf("White"), "#ffffff");
  assert.equal(colourOf("none"), null);
});

test("transforms: translate, scale, rotate about a point, matrix, in order", () => {
  assert.deepEqual(parseTransform("translate(10 20) scale(2)"), [2, 0, 0, 2, 10, 20]);
  const r = parseTransform("rotate(90 1 1)");
  const at = (x: number, y: number) => [r[0] * x + r[2] * y + r[4], r[1] * x + r[3] * y + r[5]].map((v) => Math.round(v * 1e9) / 1e9);
  assert.deepEqual(at(2, 1), [1, 2]);
  assert.deepEqual(parseTransform("matrix(1,2,3,4,5,6)"), [1, 2, 3, 4, 5, 6]);
});

test("paths: relative and absolute, implicit lines, H/V/Z, packed numbers and arc flags", () => {
  const [a] = parsePath("M0 0h900v600H0z");
  assert.deepEqual(a!.pts, [[0, 0], [900, 0], [900, 600], [0, 600]]);
  assert.equal(a!.closed, true);
  const [b] = parsePath("m1-1 2.5.5-.5.5");
  assert.deepEqual(b!.pts, [[1, -1], [3.5, -0.5], [3, 0]]);
  // Packed arc flags ("0 01" … ): a half circle from (0,0) to (2,0) of radius 1 through (1,-1) (sweep 1: clockwise on screen).
  const [c] = parsePath("M0 0a1 1 0 012 0");
  const mid = c!.pts[Math.floor(c!.pts.length / 2)]!;
  assert.ok(Math.abs(mid[0] - 1) < 1e-9 && Math.abs(mid[1] + 1) < 1e-9, String(mid));
  assert.deepEqual(c!.pts.at(-1), [2, 0]);
  const pts = arcPoints(0, 0, 1, 1, 0, false, false, 2, 0);
  assert.ok(pts.some(([, y]) => y > 0.99));
});

test("raster: painted in order, so overlapping paths count only where they show (France: thirds)", () => {
  const france = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"><path fill="#CE1126" d="M0 0h900v600H0"/><path fill="#fff" d="M0 0h600v600H0"/><path fill="#002654" d="M0 0h300v600H0"/></svg>`;
  assert.deepEqual(share(france), { "#002654": 0.333, "#ffffff": 0.333, "#ce1126": 0.333 });
});

test("raster: the viewBox, a circle (Japan: π·0.2²·1.5 of the flag), named and inherited fills", () => {
  const japan = `<svg viewBox="0 0 3 2"><rect fill="white" width="3" height="2"/><g fill="#bc002d"><circle cx="1.5" cy="1" r=".6"/></g></svg>`;
  const s = share(japan);
  // The disc covers π·0.36/6 ≈ 18.8 % of the flag; on a 48×32 grid within a cell row or so.
  assert.ok(Math.abs(s["#bc002d"]! - 0.188) < 0.02, String(s["#bc002d"]));
  assert.ok(Math.abs(s["#ffffff"]! - 0.812) < 0.02);
});

test("raster: evenodd holes, strokes (the US stripes are strokes), opacity, display none", () => {
  const ring = `<svg viewBox="0 0 4 4"><rect width="4" height="4" fill="#fff"/><path fill="#000" fill-rule="evenodd" d="M0 0h4v4H0zM1 1h2v2H1z"/></svg>`;
  assert.deepEqual(share(ring), { "#000000": 0.75, "#ffffff": 0.25 });
  const stripes = `<svg viewBox="0 0 8 4"><rect width="8" height="4" fill="#f00"/><path d="M0,1H8M0,3H8" stroke="#fff" stroke-width="1"/></svg>`;
  assert.deepEqual(share(stripes), { "#ff0000": 0.5, "#ffffff": 0.5 });
  const hidden = `<svg viewBox="0 0 2 2"><rect width="2" height="2" fill="#00f"/><rect width="1" height="2" fill="#f00" opacity=".2"/><rect width="1" height="2" fill="#0f0" style="display:none"/></svg>`;
  assert.deepEqual(share(hidden), { "#0000ff": 1 });
});

test("raster: use with x/y, CSS classes, gradients as the mean of their stops, clip paths", () => {
  const svg = `<svg viewBox="0 0 4 2"><style>.r{fill:#ff0000}</style><defs><rect id="s" width="1" height="2"/><linearGradient id="g"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#fff"/></linearGradient><clipPath id="c"><rect x="3" width="1" height="2"/></clipPath></defs>
    <rect width="4" height="2" fill="url(#g)"/><use href="#s" class="r"/><use xlink:href="#s" x="1" fill="#00f"/><rect width="4" height="2" fill="#0f0" clip-path="url(#c)"/></svg>`;
  assert.deepEqual(share(svg), { "#ff0000": 0.25, "#0000ff": 0.25, "#808080": 0.25, "#00ff00": 0.25 });
});

test("raster: the cells nothing covers are not a colour (Nepal's sky)", () => {
  const svg = `<svg viewBox="0 0 2 2"><path d="M0 0L2 2H0z" fill="#dc143c"/></svg>`;
  const { cells } = rasterise(svg);
  assert.ok(cells.includes(-1));
  assert.deepEqual(share(svg), { "#dc143c": 1 });
});

test("Lab and ΔE: known values", () => {
  assert.deepEqual(lab("#ffffff").map((v) => Math.round(v * 100) / 100 + 0), [100, 0, 0]);
  assert.deepEqual(lab("#000000").map((v) => Math.round(v) + 0), [0, 0, 0]);
  assert.deepEqual(lab("#ff0000").map((v) => Math.round(v * 10) / 10), [53.2, 80.1, 67.2]);
  assert.equal(deltaE("#123456", "#123456"), 0);
  assert.ok(Math.abs(deltaE("#000000", "#ffffff") - 100) < 0.01);
});

test("how alike: the same colours 0, Chad nearer Romania than France, a red stripe is not a red flag", () => {
  const chad = { colours: [["#002664", 0.333], ["#fecb00", 0.333], ["#c60c30", 0.333]] as [string, number][], look: "a" };
  const romania = { colours: [["#002b7f", 0.333], ["#fcd116", 0.333], ["#ce1126", 0.333]] as [string, number][], look: "b" };
  const france = { colours: [["#002654", 0.333], ["#ffffff", 0.333], ["#ce1126", 0.333]] as [string, number][], look: "c" };
  assert.equal(colourDistance(chad, chad), 0);
  assert.ok(colourDistance(chad, romania) < colourDistance(chad, france));
  assert.equal(colourDistance(chad, romania), colourDistance(romania, chad));
  const red = { colours: [["#ff0000", 1]] as [string, number][], look: "d" };
  const stripe = { colours: [["#ffffff", 0.8], ["#ff0000", 0.2]] as [string, number][], look: "e" };
  const pink = { colours: [["#ff3030", 1]] as [string, number][], look: "f" };
  assert.ok(colourDistance(red, pink) < colourDistance(red, stripe));
});

test("data/colours.json is what scripts/colours.ts writes from data/flags/", () => {
  assert.equal(readFileSync(new URL("../data/colours.json", import.meta.url), "utf8"), coloursFile());
});

test("the real flags: Germany in thirds, Romania among Chad's two nearest", () => {
  const all = (JSON.parse(readFileSync(new URL("../data/colours.json", import.meta.url), "utf8")) as { flags: Record<string, { colours: [string, number][]; look: string }> }).flags;
  const countries = (JSON.parse(readFileSync(new URL("../data/countries.json", import.meta.url), "utf8")) as { countries: { id: string; flag: string }[] }).countries;
  const of = (id: string) => all[countries.find((c) => c.id === id)!.flag]!;
  assert.deepEqual(Object.keys(Object.fromEntries(of("DE").colours)).sort(), ["#000000", "#dd0000", "#ffce00"]);
  const near = countries.filter((c) => c.id !== "TD").sort((a, b) => colourDistance(of("TD"), all[a.flag]!) - colourDistance(of("TD"), all[b.flag]!));
  assert.ok(near.slice(0, 2).some((c) => c.id === "RO"), near.slice(0, 3).map((c) => c.id).join(" "));
  for (const c of countries) assert.ok(all[c.flag]?.colours.length, `${c.id}: no colours`);
});
