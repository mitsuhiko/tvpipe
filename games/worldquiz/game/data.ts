/**
 * Worldquiz's data as the game reads it: `data/countries.json` (the
 * cards) and `data/shapes.json` (the land, for the maps and the
 * distances). Both are written by `scripts/data.ts` from Wikidata, the
 * World Bank, Natural Earth and Wikipedia, with the hand-made decisions in
 * `data/decisions.txt` (docs/worldquiz-design.md §3); never edited by
 * hand.
 *
 * A country is everything constitutionally part of it (overseas
 * departments and collectivities, constituent countries of a kingdom,
 * exclaves) and not its dependencies; its numbers, its neighbours and
 * its land on the map all follow that one rule.
 */

export type Lang = "en" | "de";

export interface Named {
  en: string;
  de: string;
}

/** One card. */
export interface Country {
  /** ISO 3166-1 alpha-2 (Kosovo: XK). */
  id: string;
  /** Only with the disputed-states option (Kosovo, Palestine, Taiwan, Western Sahara). */
  disputed?: boolean;
  /** The short common name ("Germany" / "Deutschland"). */
  name: Named;
  /** Further names accepted as answers, per language (long forms, old names, abbreviations). */
  aliases: { en: string[]; de: string[] };
  /** The capitals as the card lists them, the first shown big; every one is a right answer. */
  capitals: { en: string[]; de: string[] };
  /** Further spellings of the capitals accepted as answers ("Kiev", "Kiew"). */
  capitalAliases: { en: string[]; de: string[] };
  /** Inhabitants, and the year of the number. */
  population: number;
  populationYear: number;
  /** km², land and inland water. */
  area: number;
  /** GDP per person, current US$, nominal, and its year. */
  gdp: number;
  gdpYear: number;
  /** The highest point: its name per language and its height (m). */
  highest: { name: Named; m: number };
  /**
   * Countries whose land touches this one's, by id, including disputed
   * ones: the game drops those not in its deck (§3.1, §3.2).
   */
  neighbours: string[];
  /** Why a neighbour is one when it is not obvious: id → reason per language ("via French Guiana"). */
  via?: Record<string, Named>;
  /** How well known (Wikipedia page views, both languages): 1 is the best known. */
  fame: number;
  /** Where its name or pin goes: [lon, lat], on its main land. */
  at: [number, number];
  /** Its main land's extent: [west, south, east, north] (degrees; west > east across the antimeridian). */
  box: [number, number, number, number];
  /** The flag's file in `data/flags/` (a name that does not give the country away). */
  flag: string;
}

export interface Countries {
  v: 1;
  /** Where the numbers come from, for the credits line. */
  sources: string;
  countries: Country[];
}

/**
 * The land: polygons in units of 0.01°. A unit is a piece of land with
 * one owner: a country's id, or `null` (dependencies and land nobody in
 * the game holds: drawn plain, never a country's).
 */
export interface Shapes {
  v: 1;
  /** Coordinates are integers: degrees × `scale`. */
  scale: number;
  units: ShapeUnit[];
}

export interface ShapeUnit {
  id: string | null;
  /**
   * Outer rings only, each delta-coded: [lon0, lat0, dlon1, dlat1, …]
   * (integers, scaled), closed implicitly (the last point is not the
   * first again).
   */
  rings: number[][];
}

/** A ring as [lon, lat] pairs in degrees. */
export type Ring = [number, number][];

/** Undoes the delta coding of one ring. */
export function decodeRing(coded: readonly number[], scale: number): Ring {
  const out: Ring = [];
  let x = 0;
  let y = 0;
  for (let i = 0; i + 1 < coded.length; i += 2) {
    x += coded[i]!;
    y += coded[i + 1]!;
    out.push([x / scale, y / scale]);
  }
  return out;
}

/** The land of every country, decoded: id → rings (null: nobody's). */
export function landOf(shapes: Shapes): Map<string | null, Ring[]> {
  const m = new Map<string | null, Ring[]>();
  for (const u of shapes.units) {
    const list = m.get(u.id) ?? [];
    for (const r of u.rings) list.push(decodeRing(r, shapes.scale));
    m.set(u.id, list);
  }
  return m;
}
