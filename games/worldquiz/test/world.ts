/**
 * A small made-up world for the rules' and the game's tests: square
 * countries on a grid, with the numbers and names the tests need. The
 * real data is checked by data.test.ts.
 */

import type { Country, Ring } from "../game/data.ts";

function square(lon: number, lat: number, size = 4): Ring {
  return [
    [lon, lat],
    [lon + size, lat],
    [lon + size, lat + size],
    [lon, lat + size],
  ];
}

interface Spec {
  id: string;
  en: string;
  de: string;
  cap: [string, string];
  pop: number;
  area: number;
  m: number;
  gdp: number;
  nb: string[];
  fame: number;
  at: [number, number];
  disputed?: boolean;
  aliases?: string[];
}

const SPECS: Spec[] = [
  { id: "AA", en: "Alpha", de: "Alphaland", cap: ["Alphaville", "Alphastadt"], pop: 50e6, area: 400_000, m: 3000, gdp: 40_000, nb: ["BB", "CC"], fame: 1, at: [2, 2] },
  { id: "BB", en: "Bravo", de: "Bravien", cap: ["Bravo City", "Bravostadt"], pop: 10e6, area: 90_000, m: 1200, gdp: 70_000, nb: ["AA", "DD"], fame: 2, at: [6, 2] },
  { id: "CC", en: "Charlie", de: "Charlien", cap: ["Charleston", "Charleston"], pop: 120e6, area: 1_200_000, m: 5000, gdp: 8_000, nb: ["AA", "DD", "XK"], fame: 3, at: [2, 6] },
  { id: "DD", en: "Delta", de: "Deltanien", cap: ["Deltaport", "Deltahafen"], pop: 3e6, area: 30_000, m: 800, gdp: 25_000, nb: ["BB", "CC"], fame: 4, at: [6, 6] },
  { id: "EE", en: "Echo Islands", de: "Echoinseln", cap: ["Echo", "Echo"], pop: 200_000, area: 700, m: 300, gdp: 90_000, nb: [], fame: 5, at: [40, -20], aliases: ["Echos"] },
  { id: "XK", en: "Xenia", de: "Xenien", cap: ["Xen", "Xen"], pop: 1e6, area: 10_000, m: 2000, gdp: 5_000, nb: ["CC"], fame: 6, at: [2, 10], disputed: true },
];

export const COUNTRIES: Country[] = SPECS.map((s) => ({
  id: s.id,
  ...(s.disputed ? { disputed: true } : {}),
  name: { en: s.en, de: s.de },
  aliases: { en: s.aliases ?? [], de: [] },
  capitals: { en: [s.cap[0]], de: [s.cap[1]] },
  capitalAliases: { en: [], de: [] },
  population: s.pop,
  populationYear: 2024,
  area: s.area,
  gdp: s.gdp,
  gdpYear: 2024,
  highest: { name: { en: `Mount ${s.en}`, de: `${s.de}berg` }, m: s.m },
  neighbours: s.nb,
  fame: s.fame,
  at: s.at,
  box: [s.at[0] - 2, s.at[1] - 2, s.at[0] + 2, s.at[1] + 2],
  flag: `f${s.id.toLowerCase()}.svg`,
}));

export const LAND = new Map<string | null, Ring[]>(COUNTRIES.map((c) => [c.id, [square(c.at[0] - 2, c.at[1] - 2)]]));
