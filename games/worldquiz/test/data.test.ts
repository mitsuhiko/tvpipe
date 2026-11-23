import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { test } from "node:test";

import { landOf, type Countries, type Country, type Shapes } from "../game/data.ts";

const DATA = new URL("../data/", import.meta.url);
const countries = (JSON.parse(readFileSync(new URL("countries.json", DATA), "utf8")) as Countries).countries;
const shapes = JSON.parse(readFileSync(new URL("shapes.json", DATA), "utf8")) as Shapes;
const byId = new Map(countries.map((c) => [c.id, c]));

function country(id: string): Country {
  const c = byId.get(id);
  assert.ok(c, `${id} is in the data`);
  return c;
}

const DISPUTED = ["EH", "PS", "TW", "XK"];

test("the deck: the UN's 193, the Vatican and the four disputed states, by id", () => {
  assert.equal(countries.length, 198);
  assert.equal(new Set(countries.map((c) => c.id)).size, countries.length);
  assert.deepEqual(
    countries.map((c) => c.id),
    countries.map((c) => c.id).sort(),
  );
  assert.deepEqual(countries.filter((c) => c.disputed).map((c) => c.id), DISPUTED);
  for (const id of ["VA", "DK", "NL", "CN", "FR", "SS"]) assert.ok(byId.has(id), id);
  for (const id of ["HK", "MO", "GL", "FO", "GI", "PR", "SX", "AW", "CW"]) assert.ok(!byId.has(id), id);
});

test("every card has every field, in sane ranges", () => {
  for (const c of countries) {
    const at = `${c.id}`;
    assert.match(c.id, /^[A-Z]{2}$/, at);
    for (const lang of ["en", "de"] as const) {
      assert.ok(c.name[lang].length > 0, `${at} name`);
      assert.ok(Array.isArray(c.aliases[lang]), `${at} aliases`);
      assert.ok(c.capitals[lang].length > 0, `${at} capitals`);
      assert.ok(Array.isArray(c.capitalAliases[lang]), `${at} capital aliases`);
      assert.ok(c.highest.name[lang].length > 0, `${at} highest`);
    }
    assert.equal(c.capitals.en.length, c.capitals.de.length, `${at} capitals per language`);
    assert.ok(Number.isInteger(c.population) && c.population >= 400 && c.population < 2e9, `${at} population`);
    assert.ok(c.populationYear >= 2020 && c.populationYear <= 2030, `${at} population year`);
    assert.ok(c.area > 0.1 && c.area < 2e7, `${at} area`);
    if (c.id === "VA") assert.deepEqual([c.gdp, c.gdpYear], [0, 0], "the Vatican has no GDP");
    else {
      assert.ok(Number.isInteger(c.gdp) && c.gdp >= 100 && c.gdp < 300_000, `${at} gdp ${c.gdp}`);
      assert.ok(c.gdpYear >= 2005 && c.gdpYear <= 2030, `${at} gdp year`);
    }
    assert.ok(Number.isInteger(c.highest.m) && c.highest.m > 0 && c.highest.m <= 8849, `${at} highest`);
    assert.ok(Number.isInteger(c.fame) && c.fame >= 1 && c.fame <= countries.length, `${at} fame`);
    const [lon, lat] = c.at;
    assert.ok(Math.abs(lon) <= 180 && Math.abs(lat) <= 90, `${at} at`);
    const [w, s, e, n] = c.box;
    assert.ok(s <= lat && lat <= n, `${at} at is inside its box`);
    assert.ok(w <= e ? w <= lon && lon <= e : lon >= w || lon <= e, `${at} at is inside its box (lon)`);
    assert.match(c.flag, /^[0-9a-f]{10}\.svg$/, `${at} flag`);
    for (const [k, v] of Object.entries(c.via ?? {})) {
      assert.ok(c.neighbours.includes(k), `${at} via ${k}`);
      assert.ok(v.en.length > 0 && v.de.length > 0, `${at} via ${k}`);
    }
  }
  assert.deepEqual(
    countries.map((c) => c.fame).sort((a, b) => a - b),
    countries.map((_, i) => i + 1),
    "fame is a ranking",
  );
});

test("the neighbour relation is symmetric and between cards", () => {
  for (const c of countries) {
    assert.deepEqual(c.neighbours, [...c.neighbours].sort(), c.id);
    for (const n of c.neighbours) {
      assert.notEqual(n, c.id);
      assert.ok(byId.get(n)?.neighbours.includes(c.id), `${c.id} – ${n}`);
    }
  }
});

/** Neighbours as the table in §3.2 and §3.1 has them: with the disputed states as their own cards. */
const NEIGHBOURS: Record<string, string> = {
  FR: "AD BE BR CH DE ES IT LU MC NL SR",
  BR: "AR BO CO FR GY PE PY SR UY VE",
  NL: "BE DE FR",
  DK: "CA DE",
  CA: "DK US",
  ES: "AD FR MA PT",
  GB: "IE",
  CY: "",
  RU: "AZ BY CN EE FI GE KP KZ LT LV MN NO PL UA",
  CN: "AF BT IN KG KP KZ LA MM MN NP PK RU TJ VN",
  IT: "AT CH FR SI SM VA",
  DE: "AT BE CH CZ DK FR LU NL PL",
  JP: "",
  RS: "BA BG HR HU ME MK RO XK",
  IL: "EG JO LB PS SY",
  MA: "DZ EH ES",
  MR: "DZ EH ML SN",
  AL: "GR ME MK XK",
  EG: "IL LY PS SD",
  JO: "IL IQ PS SA SY",
  US: "CA MX",
  TW: "",
};

test("known neighbours (§3.1, §3.2)", () => {
  for (const [id, list] of Object.entries(NEIGHBOURS)) {
    assert.deepEqual(country(id).neighbours, list === "" ? [] : list.split(" "), id);
  }
  // without the disputed states, as the game deals them
  const without = (id: string): number => country(id).neighbours.filter((n) => !DISPUTED.includes(n)).length;
  assert.equal(without("RS"), 7);
  assert.equal(without("IL"), 4);
  assert.equal(without("MA"), 2);
  assert.equal(without("MR"), 3);
  assert.equal(country("FR").via?.["BR"]?.en, "via French Guiana");
  assert.equal(country("FR").via?.["BR"]?.de, "über Französisch-Guayana");
});

test("known highest points (§3.3)", () => {
  const top = (id: string): [string, number] => [country(id).highest.name.en, country(id).highest.m];
  assert.equal(top("NP")[1], 8849);
  assert.equal(top("CN")[1], 8849);
  assert.deepEqual(top("NL"), ["Mount Scenery", 887]);
  assert.deepEqual(top("DK"), ["Gunnbjørn Fjeld", 3694]);
  assert.deepEqual(top("GB"), ["Ben Nevis", 1345]);
  assert.deepEqual(top("AU"), ["Mount Kosciuszko", 2228]);
  assert.deepEqual(top("DE"), ["Zugspitze", 2962]);
  assert.equal(country("DE").highest.name.de, "Zugspitze");
});

test("known numbers (§3.5)", () => {
  assert.ok(country("DK").area > 2_000_000, "Denmark with Greenland");
  assert.ok(country("DK").population > 5_900_000 && country("DK").population < 6_300_000);
  assert.ok(country("CN").population > country("IN").population * 0.9);
  assert.ok(country("RU").area > 17_000_000);
  assert.ok(country("VA").area < 1);
  assert.ok(country("FR").area > 640_000, "France with its overseas parts");
  assert.ok(country("LU").gdp > country("DE").gdp);
});

test("names, capitals and answers (§3.4, §4.1)", () => {
  assert.deepEqual(country("CN").name, { en: "China", de: "China" });
  assert.deepEqual(country("NL").name, { en: "Netherlands", de: "Niederlande" });
  assert.deepEqual(country("BO").capitals.en, ["Sucre", "La Paz"]);
  assert.deepEqual(country("ZA").capitals.en, ["Pretoria", "Cape Town", "Bloemfontein"]);
  assert.deepEqual(country("NL").capitals.de, ["Amsterdam", "Den Haag"]);
  assert.deepEqual(country("CH").capitals.en, ["Bern"]);
  assert.ok(country("US").aliases.de.includes("Amerika"));
  assert.ok(country("NL").aliases.en.includes("Holland"));
  assert.ok(country("CZ").aliases.en.includes("Czechia"));
  assert.ok(country("CI").aliases.en.includes("Côte d'Ivoire"));
  assert.ok(country("UA").capitalAliases.en.includes("Kiev"));
  assert.ok(country("UA").capitalAliases.de.includes("Kyjiw") || country("UA").capitals.de.includes("Kiew"));
});

test("every flag file exists", () => {
  for (const c of countries) assert.ok(existsSync(new URL(`flags/${c.flag}`, DATA)), `${c.id}: ${c.flag}`);
  const files = new Set(countries.map((c) => c.flag));
  assert.equal(files.size, countries.length, "one flag per country");
});

test("the land: every card has some, Antarctica none, under 400 KB", () => {
  assert.ok(statSync(new URL("shapes.json", DATA)).size <= 400 * 1024);
  assert.equal(shapes.v, 1);
  assert.equal(shapes.scale, 100);
  const land = landOf(shapes);
  for (const c of countries) {
    const rings = land.get(c.id);
    assert.ok(rings && rings.length > 0 && rings.every((r) => r.length >= 3), `${c.id} has land`);
  }
  for (const id of land.keys()) assert.ok(id === null || byId.has(id), `${id} is a card`);
  for (const rings of land.values()) for (const r of rings) for (const [, lat] of r) assert.ok(lat > -60, "no Antarctica");
  for (const u of shapes.units) for (const r of u.rings) assert.ok(r.every(Number.isInteger) && r.length % 2 === 0);
});
