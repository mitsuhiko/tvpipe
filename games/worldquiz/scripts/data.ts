/**
 * Makes Worldquiz's data (the format: game/data.ts; why it is so:
 * docs/worldquiz-design.md §3): `data/countries.json` (the cards, one
 * country per line, by id), `data/shapes.json` (the land) and
 * `data/flags/` (the flags, under names that do not give the country
 * away).
 *
 *   node scripts/data.ts             # writes them, prints what it decided and what it doubts
 *   node scripts/data.ts --check     # fails if the checked-in files are not what it would write
 *   node scripts/data.ts --refresh   # fetches every source again instead of reading .cache/
 *
 * Everything fetched is kept in `.cache/` (not checked in), so a second
 * run works offline and gives the same files; `--refresh` takes the
 * sources as they are today, and its differences are the year's news.
 *
 * Sources:
 *
 * - Wikidata (SPARQL): the deck (the UN's members, plus the Vatican and
 *   the four disputed states named in decisions.txt), names, aliases,
 *   capitals, flags, the Wikipedia articles, and the highest points as a
 *   cross-check.
 * - The World Bank (API, latest value): population, area, GDP and GDP per
 *   person, summed over a country's parts; the IMF's DataMapper where the
 *   World Bank has nothing (Taiwan) or nothing recent (GDP older than
 *   three years).
 * - Natural Earth's admin 0 countries (v5.1.2): 1:50m for the land, 1:10m
 *   for who borders whom (two units border when they share an edge).
 * - Wikipedia: *List of countries and territories by number of land
 *   borders* (checked against the computed borders), *List of elevation
 *   extremes by country* (the highest points), *List of countries and
 *   dependencies by area* (checked against the World Bank's areas).
 * - Wikimedia Commons: the flags (SVG) and their licences; the pageviews
 *   API: how well known a country is (its English and German article's
 *   views in the median month of the last 12).
 *
 * The rule (§3.2): a country is everything constitutionally part of it,
 * not its dependencies, and its numbers, neighbours and land all follow
 * it. Where the sources need a human, `data/decisions.txt` says what to
 * do and why (its format is at its top), and the run fails until every
 * such case has a line there: a Natural Earth unit nobody claimed, a
 * border where the computed one and Wikipedia's list disagree, an area
 * more than 2 % off Wikipedia's, a country with several capitals in
 * Wikidata, a name in a Wikipedia list it cannot place.
 *
 * The land is drawn from 1:50m: units of one owner dissolved into one,
 * holes dropped, simplified by Douglas–Peucker to 0.03° along arcs
 * shared by neighbours (so borders stay shared), islands under 40 km²
 * dropped unless the country has no island of 1,000 km² (Kiribati, the
 * Maldives keep all theirs), rounded to 0.01° and delta-coded.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Countries, Country, Named, ShapeUnit, Shapes } from "../game/data.ts";
import { withViewBox } from "./flags.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = join(ROOT, ".cache");
const DATA = join(ROOT, "data");
const ARGS = process.argv.slice(2);
const REFRESH = ARGS.includes("--refresh");
const CHECK = ARGS.includes("--check");
const UA = "worldquiz-data/1 (games/worldquiz/scripts/data.ts; a party game's data, fetched once)";

/** Natural Earth, pinned. */
const NE = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson";
/** The tolerance of the simplification, degrees. */
const TOLERANCE = 0.03;
/** Islands smaller than this (km²) are dropped, unless the country has nothing bigger. */
const MIN_ISLAND = 40;
/** A country whose biggest island is smaller than this (km²) keeps all its islands (Kiribati, Tuvalu). */
const SMALL_ISLANDS = 1000;
/** Coordinates in shapes.json are degrees × SCALE, integers. */
const SCALE = 100;
/** An area further than this off Wikipedia's needs a decision. */
const AREA_SLACK = 0.02;

type Pt = [number, number];
/** A Natural Earth unit's owner: a country, nobody (null), or off the map. */
const DROP = "drop";
type Owner = string | null | typeof DROP;

// ---------------------------------------------------------------- fetching

/** Pauses between requests to one host, so as not to be throttled. */
async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * The body of `url` from `.cache/` (the name plus a hash of the request),
 * fetched when it is not there or with `--refresh`.
 */
async function cached(name: string, url: string, init?: RequestInit): Promise<Buffer> {
  const key = createHash("sha256")
    .update(url + "\n" + String(init?.body ?? ""))
    .digest("hex")
    .slice(0, 8);
  const dot = name.lastIndexOf(".");
  const path = join(CACHE, `${name.slice(0, dot)}-${key}${name.slice(dot)}`);
  if (!REFRESH && existsSync(path)) return readFileSync(path);
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; ; attempt++) {
    let status = 0;
    try {
      const res = await fetch(url, { ...init, headers: { "User-Agent": UA, ...init?.headers } });
      status = res.status;
      if (res.ok) {
        const body = Buffer.from(await res.arrayBuffer());
        writeFileSync(path, body);
        return body;
      }
      if (status === 404) throw new Error(`${url}: HTTP 404`);
    } catch (e) {
      if (status === 404 || attempt >= 5) throw e;
    }
    if (attempt >= 5) throw new Error(`${url}: HTTP ${status}`);
    await sleep(2000 * 2 ** attempt);
  }
}

async function cachedJson(name: string, url: string, init?: RequestInit): Promise<unknown> {
  return JSON.parse((await cached(name, url, init)).toString("utf8"));
}

async function cachedText(name: string, url: string): Promise<string> {
  return (await cached(name, url)).toString("utf8");
}

/** A SPARQL query's rows, each variable's value as a string. */
async function sparql(name: string, query: string): Promise<Record<string, string>[]> {
  const json = (await cachedJson(`wikidata-${name}.json`, "https://query.wikidata.org/sparql", {
    method: "POST",
    body: new URLSearchParams({ query }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/sparql-results+json" },
  })) as { results: { bindings: Record<string, { value: string; "xml:lang"?: string }>[] } };
  // each variable's value, and its language as `<variable>@`
  return json.results.bindings.map((b) =>
    Object.fromEntries(Object.entries(b).flatMap(([k, v]) => [[k, v.value], [`${k}@`, v["xml:lang"] ?? ""]])),
  );
}

function wikitext(title: string): Promise<string> {
  const url = `https://en.wikipedia.org/w/index.php?title=${encodeURIComponent(title.replaceAll(" ", "_"))}&action=raw`;
  return cachedText(`wikipedia-${title.replaceAll(" ", "_")}.wiki`, url);
}

const qid = (uri: string): string => uri.slice(uri.lastIndexOf("/") + 1);

// ---------------------------------------------------------------- decisions

/** Problems that need a human: the run fails with all of them listed. */
const problems: string[] = [];
/** Things worth a look that do not stop the run. */
const notes: string[] = [];

interface CountryDecisions {
  item?: string;
  name?: Named;
  aliases: { en: string[]; de: string[] };
  dropAliases: Set<string>;
  capitals?: { en: string[]; de: string[] };
  capitalAliases: { en: string[]; de: string[] };
  parts?: string[];
  area?: number | "ok" | "wikipedia";
  population?: [number, number];
  gdp?: [number, number];
  highest?: { name: Named; m: number };
  via: Record<string, Named>;
  flag?: string;
  flagLicence?: string;
}

interface PartFigures {
  population?: [number, number];
  area?: number;
  gdp?: [number, number];
}

interface Decisions {
  deck: Map<string, { id: string; disputed: boolean }>;
  units: Map<string, Owner>;
  /** Polygons of a unit whose extent's centre is in `box` go to `owner`. */
  pieces: { unit: string; box: [number, number, number, number]; owner: string | null }[];
  borders: Map<string, boolean>;
  /** Names in Wikipedia's lists: the country, or null for nobody's; `part` when the row is one of the country's parts. */
  wiki: Map<string, { id: string | null; part: boolean }>;
  countries: Map<string, CountryDecisions>;
  parts: Map<string, PartFigures>;
}

/** Splits "a; b | c; d" into the English and the German list. */
function bilingual(value: string, line: number): { en: string[]; de: string[] } {
  const halves = value.split("|");
  if (halves.length !== 2) throw new Error(`decisions.txt:${line}: expected "English | German"`);
  const list = (s: string): string[] =>
    s
      .split(";")
      .map((x) => x.trim())
      .filter((x) => x !== "");
  return { en: list(halves[0]!), de: list(halves[1]!) };
}

function number(s: string, line: number): number {
  const n = Number(s.replaceAll(",", ""));
  if (!Number.isFinite(n)) throw new Error(`decisions.txt:${line}: not a number: ${s}`);
  return n;
}

export function parseDecisions(text: string): Decisions {
  const d: Decisions = {
    deck: new Map(),
    units: new Map(),
    pieces: [],
    borders: new Map(),
    wiki: new Map(),
    countries: new Map(),
    parts: new Map(),
  };
  const country = (id: string): CountryDecisions => {
    let c = d.countries.get(id);
    if (!c) {
      c = { aliases: { en: [], de: [] }, dropAliases: new Set(), capitalAliases: { en: [], de: [] }, via: {} };
      d.countries.set(id, c);
    }
    return c;
  };
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const n = i + 1;
    const raw = lines[i]!;
    if (raw.trim() === "" || raw.trimStart().startsWith("#")) continue;
    const colon = raw.indexOf(": ");
    if (colon < 0 && !raw.endsWith(":")) throw new Error(`decisions.txt:${n}: expected "subject key: value"`);
    const head = raw.slice(0, colon < 0 ? raw.length - 1 : colon).trim();
    const rest = colon < 0 ? "" : raw.slice(colon + 2);
    const dash = rest.indexOf(" -- ");
    const value = (dash < 0 ? rest : rest.slice(0, dash)).trim();
    const reason = dash < 0 ? "" : rest.slice(dash + 4).trim();
    const words = head.split(/\s+/);
    const [subject, key] = words;
    const needReason = (): void => {
      if (reason === "") throw new Error(`decisions.txt:${n}: this decision needs a reason ("-- why")`);
    };
    if (subject === "deck") {
      const [id, flag] = value.split(/\s+/);
      if (!key || !id || !/^[A-Z]{2}$/.test(id)) throw new Error(`decisions.txt:${n}: deck Q…: XX [disputed]`);
      d.deck.set(key, { id, disputed: flag === "disputed" });
    } else if (subject === "unit") {
      if (!key) throw new Error(`decisions.txt:${n}: unit ABC: XX`);
      needReason();
      d.units.set(key, value === "-" ? null : value === DROP ? DROP : value);
    } else if (subject === "piece") {
      const [unit, ...box] = words.slice(1);
      if (!unit || box.length !== 4) throw new Error(`decisions.txt:${n}: piece ABC W S E N: XX`);
      needReason();
      const [w, s, e, nn] = box.map((x) => number(x, n)) as [number, number, number, number];
      d.pieces.push({ unit, box: [w, s, e, nn], owner: value === "-" ? null : value });
    } else if (subject === "border") {
      const [a, b] = words.slice(1);
      if (!a || !b || (value !== "yes" && value !== "no")) throw new Error(`decisions.txt:${n}: border XX YY: yes|no`);
      needReason();
      d.borders.set(pair(a, b), value === "yes");
    } else if (subject === "wiki") {
      const [id, part] = value.split(/\s+/);
      if (!id || (part !== undefined && part !== "part")) throw new Error(`decisions.txt:${n}: wiki NAME: XX [part] | -`);
      d.wiki.set(head.slice(5).trim(), { id: id === "-" ? null : id, part: part === "part" });
    } else if (subject && /^[A-Z]{3}$/.test(subject)) {
      const p = d.parts.get(subject) ?? {};
      d.parts.set(subject, p);
      const [a, b] = value.split(/\s+/);
      needReason();
      if (key === "area") p.area = number(value, n);
      else if (key === "population" && a && b) p.population = [number(a, n), number(b, n)];
      else if (key === "gdp" && a && b) p.gdp = [number(a, n), number(b, n)];
      else throw new Error(`decisions.txt:${n}: a part has area N, population N YEAR or gdp N YEAR`);
    } else if (subject && /^[A-Z]{2}$/.test(subject)) {
      const c = country(subject);
      const [a, b] = value.split(/\s+/);
      if (key === "item") c.item = value;
      else if (key === "name") {
        const { en, de } = bilingual(value, n);
        if (en.length !== 1 || de.length !== 1) throw new Error(`decisions.txt:${n}: one name per language`);
        c.name = { en: en[0]!, de: de[0]! };
      } else if (key === "aliases") {
        const l = bilingual(value, n);
        c.aliases.en.push(...l.en);
        c.aliases.de.push(...l.de);
      } else if (key === "drop-aliases") {
        for (const x of value.split(";")) c.dropAliases.add(x.trim());
      } else if (key === "capitals") {
        needReason();
        c.capitals = bilingual(value, n);
      } else if (key === "capital-aliases") {
        const l = bilingual(value, n);
        c.capitalAliases.en.push(...l.en);
        c.capitalAliases.de.push(...l.de);
      } else if (key === "parts") c.parts = value.split(/\s+/);
      else if (key === "area") {
        needReason();
        c.area = value === "ok" || value === "wikipedia" ? value : number(value, n);
      } else if (key === "population" && a && b) {
        needReason();
        c.population = [number(a, n), number(b, n)];
      } else if (key === "gdp" && a && b) {
        needReason();
        c.gdp = [number(a, n), number(b, n)];
      } else if (key === "highest") {
        needReason();
        const m = /^(\d+) (.+)$/.exec(value);
        if (!m) throw new Error(`decisions.txt:${n}: highest: METRES English | German`);
        const { en, de } = bilingual(m[2]!, n);
        c.highest = { m: Number(m[1]), name: { en: en[0] ?? "", de: de[0] ?? "" } };
      } else if (key === "via" && words[2]) {
        const { en, de } = bilingual(value, n);
        c.via[words[2]] = { en: en.join("; "), de: de.join("; ") };
      } else if (key === "flag") c.flag = value;
      else if (key === "flag-licence") {
        needReason();
        c.flagLicence = value;
      }
      else throw new Error(`decisions.txt:${n}: unknown key ${key ?? ""}`);
    } else throw new Error(`decisions.txt:${n}: unknown subject ${subject ?? ""}`);
  }
  return d;
}

function pair(a: string, b: string): string {
  return a < b ? `${a} ${b}` : `${b} ${a}`;
}

// ---------------------------------------------------------------- Wikidata

interface Item {
  q: string;
  en?: string;
  de?: string;
  iso3?: string;
  flags: string[];
  enwiki?: string;
  dewiki?: string;
  aliases: { en: string[]; de: string[] };
  capitals: { q: string; en?: string; de?: string; aliases: { en: string[]; de: string[] } }[];
  highest: { en?: string; de?: string; m?: number }[];
}

async function wikidata(extra: string[]): Promise<{ un: Map<string, string | undefined>; items: Map<string, Item> }> {
  const unRows = await sparql(
    "un",
    `SELECT ?c ?iso WHERE {
      ?c wdt:P31 wd:Q3624078; p:P463 ?m . ?m ps:P463 wd:Q1065 .
      FILTER NOT EXISTS { ?m pq:P582 ?end }
      OPTIONAL { ?c wdt:P297 ?iso }
    }`,
  );
  const un = new Map<string, string | undefined>();
  for (const r of unRows) un.set(qid(r["c"]!), r["iso"]);
  const qs = [...new Set([...un.keys(), ...extra])].sort();
  const values = qs.map((q) => `wd:${q}`).join(" ");
  const lang = (v: string) => `FILTER(lang(${v}) = "en" || lang(${v}) = "de")`;
  const [info, aliases, capitals, capitalAliases, highest] = await Promise.all([
    sparql(
      "items",
      `SELECT ?c ?en ?de ?iso3 ?flag ?enwiki ?dewiki WHERE { VALUES ?c { ${values} }
        OPTIONAL { ?c rdfs:label ?en FILTER(lang(?en) = "en") }
        OPTIONAL { ?c rdfs:label ?de FILTER(lang(?de) = "de") }
        OPTIONAL { ?c wdt:P298 ?iso3 }
        OPTIONAL { ?c wdt:P41 ?flag }
        OPTIONAL { ?enwiki schema:about ?c; schema:isPartOf <https://en.wikipedia.org/> }
        OPTIONAL { ?dewiki schema:about ?c; schema:isPartOf <https://de.wikipedia.org/> } }`,
    ),
    sparql("aliases", `SELECT ?c ?a WHERE { VALUES ?c { ${values} } ?c skos:altLabel ?a ${lang("?a")} }`),
    sparql(
      "capitals",
      `SELECT ?c ?cap ?en ?de WHERE { VALUES ?c { ${values} } ?c wdt:P36 ?cap .
        OPTIONAL { ?cap rdfs:label ?en FILTER(lang(?en) = "en") }
        OPTIONAL { ?cap rdfs:label ?de FILTER(lang(?de) = "de") } }`,
    ),
    sparql(
      "capital-aliases",
      `SELECT ?c ?cap ?a WHERE { VALUES ?c { ${values} } ?c wdt:P36 ?cap . ?cap skos:altLabel ?a ${lang("?a")} }`,
    ),
    sparql(
      "highest",
      `SELECT ?c ?hp ?en ?de ?m WHERE { VALUES ?c { ${values} } ?c wdt:P610 ?hp .
        OPTIONAL { ?hp rdfs:label ?en FILTER(lang(?en) = "en") }
        OPTIONAL { ?hp rdfs:label ?de FILTER(lang(?de) = "de") }
        OPTIONAL { ?hp wdt:P2044 ?m } }`,
    ),
  ]);
  const items = new Map<string, Item>();
  const item = (uri: string): Item => {
    const q = qid(uri);
    let it = items.get(q);
    if (!it) {
      it = { q, flags: [], aliases: { en: [], de: [] }, capitals: [], highest: [] };
      items.set(q, it);
    }
    return it;
  };
  const title = (url: string | undefined): string | undefined =>
    url === undefined ? undefined : decodeURIComponent(url.slice(url.indexOf("/wiki/") + 6)).replaceAll("_", " ");
  for (const r of info) {
    const it = item(r["c"]!);
    it.en ??= r["en"];
    it.de ??= r["de"];
    it.iso3 ??= r["iso3"];
    it.enwiki ??= title(r["enwiki"]);
    it.dewiki ??= title(r["dewiki"]);
    const flag = r["flag"];
    if (flag !== undefined) {
      const file = decodeURIComponent(flag.slice(flag.lastIndexOf("/") + 1));
      if (!it.flags.includes(file)) it.flags.push(file);
    }
  }
  for (const r of aliases) item(r["c"]!).aliases[r["a@"] === "de" ? "de" : "en"].push(r["a"]!);
  const capital = (r: Record<string, string>) => {
    const it = item(r["c"]!);
    const q = qid(r["cap"]!);
    let c = it.capitals.find((x) => x.q === q);
    if (!c) {
      c = { q, aliases: { en: [], de: [] } };
      it.capitals.push(c);
    }
    return c;
  };
  for (const r of capitals) {
    const c = capital(r);
    c.en ??= r["en"];
    c.de ??= r["de"];
  }
  for (const r of capitalAliases) capital(r).aliases[r["a@"] === "de" ? "de" : "en"].push(r["a"]!);
  for (const r of highest) {
    const it = item(r["c"]!);
    it.highest.push({ en: r["en"], de: r["de"], m: r["m"] === undefined ? undefined : Number(r["m"]) });
  }
  for (const it of items.values()) {
    it.flags.sort();
    it.aliases.en.sort();
    it.aliases.de.sort();
    it.capitals.sort((a, b) => a.q.localeCompare(b.q));
    for (const c of it.capitals) {
      c.aliases.en.sort();
      c.aliases.de.sort();
    }
  }
  return { un, items };
}

// ---------------------------------------------------------------- wikitext

/** `text` without the templates named (and everything nested in them), refs and comments. */
function strip(text: string, templates: string[]): string {
  let s = text.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<ref[^>]*\/>/g, "").replace(/<ref[^>]*>[\s\S]*?<\/ref>/g, "");
  const lower = templates.map((t) => t.toLowerCase());
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s.startsWith("{{", i)) {
      const m = /^\{\{\s*([^|}]+?)\s*[|}]/.exec(s.slice(i, i + 80));
      if (m && lower.includes(m[1]!.toLowerCase())) {
        let depth = 0;
        let j = i;
        while (j < s.length) {
          if (s.startsWith("{{", j)) {
            depth++;
            j += 2;
          } else if (s.startsWith("}}", j)) {
            depth--;
            j += 2;
            if (depth === 0) break;
          } else j++;
        }
        i = j;
        continue;
      }
    }
    out += s[i];
    i++;
  }
  return out;
}

/** The rows of the wikitables in `text`, each as its cells' text (a cell may span lines). */
function tableRows(text: string): string[][] {
  const rows: string[][] = [];
  // only what is inside a table
  const inside: string[] = [];
  let depth = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("{|")) depth++;
    else if (line.startsWith("|}")) depth = Math.max(0, depth - 1);
    else if (depth > 0) inside.push(line);
    if (line.startsWith("|}")) inside.push("|-");
  }
  for (const chunk of inside.join("\n").split(/\n\|-[^\n]*/)) {
    const cells: string[] = [];
    for (const line of chunk.split("\n")) {
      if (line.startsWith("|+") || line.startsWith("!")) continue;
      if (line.startsWith("|")) cells.push(...line.slice(1).split("||"));
      else if (cells.length > 0) cells[cells.length - 1] += "\n" + line;
    }
    if (cells.length > 0) rows.push(cells.map((c) => c.trim()));
  }
  return rows;
}

/** The countries named by flag templates in `cell`, in order. */
function flags(cell: string): string[] {
  return [...cell.matchAll(/\{\{\s*(?:flag|flagicon|flagcountry)\s*\|\s*([^|}]+?)\s*[|}]/gi)].map((m) => m[1]!);
}

interface BorderRow {
  name: string;
  neighbours: string[];
}

/** Wikipedia's land borders: each row's country and the neighbours it lists. */
function parseBorders(text: string): BorderRow[] {
  const out: BorderRow[] = [];
  for (const cells of tableRows(strip(text, ["efn", "cvt", "convert", "hidden", "refn", "ref", "sfn"]))) {
    const name = flags(cells[0]!)[0];
    if (name === undefined || cells.length < 5) continue;
    out.push({ name, neighbours: flags(cells[cells.length - 1]!) });
  }
  return out;
}

interface ElevationRow {
  code: string;
  name: string;
  link?: string;
  m: number;
}

/** Wikipedia's highest points: the country (an ISO code template or a flag), the summit and its height. */
function parseElevations(text: string): ElevationRow[] {
  const out: ElevationRow[] = [];
  for (const cells of tableRows(strip(text, ["efn", "refn", "sfn"]))) {
    const head = cells[0]!;
    const code = /^\{\{([A-Z]{3,4})\}\}/.exec(head)?.[1] ?? flags(head)[0];
    const cell = cells[1];
    if (code === undefined || cell === undefined) continue;
    const m = /\{\{epi\/moft\|(-?[\d.,]+)/.exec(cell);
    if (!m) continue;
    const link = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/.exec(cell);
    let name = link ? (link[2] ?? link[1]!) : cell.slice(0, cell.indexOf("{{epi")).trim();
    name = name.replace(/\{\{[^}]*\}\}/g, "").trim();
    out.push({ code, name, link: link?.[1], m: Number(m[1]!.replaceAll(",", "")) });
  }
  return out;
}

/** Wikipedia's areas (km², total): the first row of each name. */
function parseAreas(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const cells of tableRows(strip(text, ["efn", "refn", "sfn"]))) {
    const name = cells.slice(0, 2).flatMap(flags)[0];
    const m = /\{\{km2 mi2\|([\d.,]+)/.exec(cells.join(" "));
    if (name === undefined || !m || out.has(name)) continue;
    out.set(name, Number(m[1]!.replaceAll(",", "")));
  }
  return out;
}

// ---------------------------------------------------------------- World Bank, IMF

interface Figure {
  value: number;
  year: number;
}

/** A World Bank indicator's latest value per ISO 3166 alpha-3 code. */
async function worldBank(indicator: string): Promise<Map<string, Figure>> {
  const url = `https://api.worldbank.org/v2/country/all/indicator/${indicator}?format=json&mrnev=1&per_page=1000`;
  const json = (await cachedJson(`worldbank-${indicator}.json`, url)) as [
    unknown,
    { countryiso3code: string; date: string; value: number | null }[],
  ];
  const out = new Map<string, Figure>();
  for (const r of json[1]) {
    if (r.value !== null && r.countryiso3code !== "") out.set(r.countryiso3code, { value: r.value, year: Number(r.date) });
  }
  return out;
}

/** The IMF's codes where they are not ISO's (Kosovo, Palestine). */
const IMF_CODE: Record<string, string> = { XKX: "UVK", PSE: "WBG" };

/** An IMF DataMapper indicator: code → year → value. */
async function imf(indicator: string): Promise<Map<string, Map<number, number>>> {
  const url = `https://www.imf.org/external/datamapper/api/v1/${indicator}`;
  const json = (await cachedJson(`imf-${indicator}.json`, url)) as {
    values: Record<string, Record<string, Record<string, number | null>>>;
  };
  const out = new Map<string, Map<number, number>>();
  for (const [code, years] of Object.entries(json.values[indicator] ?? {})) {
    const m = new Map<number, number>();
    for (const [y, v] of Object.entries(years)) if (v !== null) m.set(Number(y), v);
    out.set(code, m);
  }
  return out;
}

// ---------------------------------------------------------------- Natural Earth

interface Feature {
  properties: Record<string, string | number | null>;
  geometry: { type: "Polygon"; coordinates: Pt[][] } | { type: "MultiPolygon"; coordinates: Pt[][][] };
}

async function naturalEarth(scale: "10m" | "50m"): Promise<Feature[]> {
  const name = `ne_${scale}_admin_0_countries.geojson`;
  const json = (await cachedJson(`naturalearth-${name}`, `${NE}/${name}`)) as { features: Feature[] };
  return json.features;
}

function polygonsOf(f: Feature): Pt[][][] {
  return f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
}

const prop = (f: Feature, k: string): string => String(f.properties[k] ?? "");

/** Twice the signed area (planar, degrees²): positive when counter-clockwise. */
function signedArea2(r: readonly Pt[]): number {
  let s = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += (r[j]![0] - r[i]![0]) * (r[j]![1] + r[i]![1]);
  return s;
}

/** A ring's area in km², roughly (degrees² shrunk by the cosine of its middle latitude). */
function km2(r: readonly Pt[]): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of r) {
    lo = Math.min(lo, p[1]);
    hi = Math.max(hi, p[1]);
  }
  return (Math.abs(signedArea2(r)) / 2) * Math.cos((((lo + hi) / 2) * Math.PI) / 180) * 111.32 ** 2;
}

function inRing(p: Pt, r: readonly Pt[]): boolean {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i]!;
    const [xj, yj] = r[j]!;
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** `ring` without its closing point (GeoJSON repeats the first point at the end). */
function open(ring: readonly Pt[]): Pt[] {
  const r = ring.slice();
  const a = r[0];
  const b = r[r.length - 1];
  if (a && b && r.length > 1 && a[0] === b[0] && a[1] === b[1]) r.pop();
  return r;
}

/**
 * Who owns each Natural Earth unit: decisions.txt, else a sovereign
 * country (or a country of one, as NE's "Country") whose ISO code is in
 * the deck. Anything else needs a decision.
 */
function unitOwners(features: Feature[], deck: Set<string>, d: Decisions): Map<string, Owner> {
  const out = new Map<string, Owner>();
  for (const f of features) {
    const a3 = prop(f, "ADM0_A3");
    const decided = d.units.get(a3);
    const iso = prop(f, "ISO_A2_EH");
    const type = prop(f, "TYPE");
    if (decided !== undefined) {
      if (decided !== null && decided !== DROP && !deck.has(decided)) problems.push(`unit ${a3}: ${decided} is not in the deck`);
      out.set(a3, decided);
    } else if (["Sovereign country", "Country", "Sovereignty"].includes(type) && deck.has(iso)) out.set(a3, iso);
    else {
      problems.push(
        `unit ${a3} (${prop(f, "NAME")}, ${type} of ${prop(f, "SOVEREIGNT")}): whose? add "unit ${a3}: XX|-|drop -- why"`,
      );
      out.set(a3, null);
    }
  }
  return out;
}

/** The owner of one polygon of a unit: a `piece` decision, else the unit's. */
function polygonOwner(f: Feature, poly: Pt[][], owners: Map<string, Owner>, d: Decisions): Owner {
  const a3 = prop(f, "ADM0_A3");
  for (const p of d.pieces) {
    if (p.unit !== a3) continue;
    const xs = poly[0]!.map((q) => q[0]);
    const ys = poly[0]!.map((q) => q[1]);
    const x = (Math.min(...xs) + Math.max(...xs)) / 2;
    const y = (Math.min(...ys) + Math.max(...ys)) / 2;
    const [w, s, e, n] = p.box;
    if (x >= w && x <= e && y >= s && y <= n) return p.owner;
  }
  return owners.get(a3) ?? null;
}

/**
 * Who borders whom by land: two owners whose polygons share an edge
 * (vertices rounded to 1e-5°), with the units that do.
 */
function adjacency(features: Feature[], owners: Map<string, Owner>, d: Decisions): Map<string, Set<string>> {
  const edges = new Map<string, Set<string>>();
  const key = (p: Pt): string => `${Math.round(p[0] * 1e5)},${Math.round(p[1] * 1e5)}`;
  for (const f of features) {
    for (const poly of polygonsOf(f)) {
      const owner = polygonOwner(f, poly, owners, d);
      if (owner === null || owner === DROP) continue;
      for (const ring of poly) {
        for (let i = 0; i + 1 < ring.length; i++) {
          const a = key(ring[i]!);
          const b = key(ring[i + 1]!);
          if (a === b) continue;
          const k = a < b ? `${a} ${b}` : `${b} ${a}`;
          let s = edges.get(k);
          if (!s) edges.set(k, (s = new Set()));
          s.add(owner);
        }
      }
    }
  }
  const out = new Map<string, Set<string>>();
  for (const s of edges.values()) {
    if (s.size < 2) continue;
    for (const a of s) for (const b of s) if (a !== b) (out.get(a) ?? out.set(a, new Set()).get(a)!).add(b);
  }
  return out;
}

/**
 * Dissolves rings of one owner into its outlines: edges two rings share
 * (in opposite directions, once each ring runs counter-clockwise and each
 * hole clockwise) cancel, the rest chain up again; holes are dropped.
 */
function dissolve(polys: Pt[][][]): Pt[][] {
  const k = (p: Pt): string => `${p[0]},${p[1]}`;
  const point = new Map<string, Pt>();
  const directed = new Map<string, number>();
  for (const poly of polys) {
    poly.forEach((ring0, i) => {
      let ring = open(ring0);
      if (ring.length < 3) return;
      const ccw = signedArea2(ring) > 0;
      if (ccw !== (i === 0)) ring = ring.reverse();
      for (let j = 0; j < ring.length; j++) {
        const a = ring[j]!;
        const b = ring[(j + 1) % ring.length]!;
        const ka = k(a);
        const kb = k(b);
        if (ka === kb) continue;
        point.set(ka, a);
        point.set(kb, b);
        const back = `${kb} ${ka}`;
        const n = directed.get(back);
        if (n) {
          if (n === 1) directed.delete(back);
          else directed.set(back, n - 1);
        } else directed.set(`${ka} ${kb}`, (directed.get(`${ka} ${kb}`) ?? 0) + 1);
      }
    });
  }
  const next = new Map<string, string[]>();
  for (const [e, n] of directed) {
    const [a, b] = e.split(" ") as [string, string];
    for (let i = 0; i < n; i++) (next.get(a) ?? next.set(a, []).get(a)!).push(b);
  }
  const out: Pt[][] = [];
  for (const start of [...next.keys()].sort()) {
    while ((next.get(start)?.length ?? 0) > 0) {
      const ring: Pt[] = [];
      let at = start;
      for (;;) {
        ring.push(point.get(at)!);
        const outs = next.get(at);
        const to = outs?.shift();
        if (to === undefined || to === start) break;
        at = to;
      }
      if (ring.length >= 3 && signedArea2(ring) > 0) out.push(ring);
    }
  }
  return out;
}

/** Douglas–Peucker on an open chain: the indices kept (both ends always). */
function douglasPeucker(pts: readonly Pt[], tol: number): Pt[] {
  if (pts.length <= 2) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length > 0) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = pts[a]!;
    const [bx, by] = pts[b]!;
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    let best = -1;
    let bi = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i]!;
      const dist = len === 0 ? Math.hypot(px - ax, py - ay) : Math.abs(dx * (ay - py) - dy * (ax - px)) / len;
      if (dist > best) {
        best = dist;
        bi = i;
      }
    }
    if (best > tol) {
      keep[bi] = 1;
      stack.push([a, bi], [bi, b]);
    }
  }
  return pts.filter((_, i) => keep[i] === 1);
}

/**
 * Simplifies rings so that what neighbours share stays shared: a vertex
 * where the rings through it do not all have the same neighbours on both
 * sides is a junction; the stretches between junctions are simplified
 * one by one, each in the same direction whichever ring it is met in.
 */
function simplifyShared(rings: Pt[][], tol: number): Pt[][] {
  const k = (p: Pt): string => `${p[0]},${p[1]}`;
  const sig = new Map<string, string>();
  const junction = new Set<string>();
  for (const r of rings) {
    for (let i = 0; i < r.length; i++) {
      const a = k(r[(i + r.length - 1) % r.length]!);
      const b = k(r[(i + 1) % r.length]!);
      const s = a < b ? `${a} ${b}` : `${b} ${a}`;
      const v = k(r[i]!);
      const was = sig.get(v);
      if (was === undefined) sig.set(v, s);
      else if (was !== s) junction.add(v);
    }
  }
  const chain = (pts: Pt[]): Pt[] => {
    const first = k(pts[0]!);
    const last = k(pts[pts.length - 1]!);
    const flip = first > last || (first === last && k(pts[1]!) > k(pts[pts.length - 2]!));
    if (!flip) return douglasPeucker(pts, tol);
    return douglasPeucker(pts.slice().reverse(), tol).reverse();
  };
  return rings.map((r) => {
    const cuts: number[] = [];
    r.forEach((p, i) => {
      if (junction.has(k(p))) cuts.push(i);
    });
    if (cuts.length === 0) {
      // a ring of its own: cut at its smallest point and at the point furthest from it
      let s = 0;
      r.forEach((p, i) => {
        if (k(p) < k(r[s]!)) s = i;
      });
      const rot = [...r.slice(s), ...r.slice(0, s)];
      let far = 1;
      rot.forEach((p, i) => {
        if (Math.hypot(p[0] - rot[0]![0], p[1] - rot[0]![1]) > Math.hypot(rot[far]![0] - rot[0]![0], rot[far]![1] - rot[0]![1]))
          far = i;
      });
      const a = chain(rot.slice(0, far + 1));
      const b = chain([...rot.slice(far), rot[0]!]);
      return [...a.slice(0, -1), ...b.slice(0, -1)];
    }
    const out: Pt[] = [];
    for (let c = 0; c < cuts.length; c++) {
      const from = cuts[c]!;
      const to = cuts[(c + 1) % cuts.length]!;
      const pts = to > from ? r.slice(from, to + 1) : [...r.slice(from), ...r.slice(0, to + 1)];
      out.push(...chain(pts).slice(0, -1));
    }
    return out;
  });
}

/** A ring rounded to the grid, repeated points dropped; null when fewer than three are left. */
function quantize(r: readonly Pt[]): Pt[] | null {
  const out: Pt[] = [];
  for (const p of r) {
    const q: Pt = [Math.round(p[0] * SCALE), Math.round(p[1] * SCALE)];
    const last = out[out.length - 1];
    if (!last || last[0] !== q[0] || last[1] !== q[1]) out.push(q);
  }
  while (out.length > 1 && out[0]![0] === out[out.length - 1]![0] && out[0]![1] === out[out.length - 1]![1]) out.pop();
  return out.length >= 3 && signedArea2(out) !== 0 ? out : null;
}

function deltaCode(r: readonly Pt[]): number[] {
  const out: number[] = [];
  let x = 0;
  let y = 0;
  for (const [px, py] of r) {
    out.push(px - x, py - y);
    x = px;
    y = py;
  }
  return out;
}

interface Land {
  shapes: Shapes;
  /** Each owner's rings in degrees, as written. */
  rings: Map<string | null, Pt[][]>;
}

function land(features: Feature[], owners: Map<string, Owner>, d: Decisions): Land {
  const byOwner = new Map<string | null, Pt[][][]>();
  for (const f of features) {
    for (const poly of polygonsOf(f)) {
      const owner = polygonOwner(f, poly, owners, d);
      if (owner === DROP) continue;
      (byOwner.get(owner) ?? byOwner.set(owner, []).get(owner)!).push(poly);
    }
  }
  const order = [...byOwner.keys()].sort((a, b) => (a === null ? 1 : b === null ? -1 : a.localeCompare(b)));
  const outlines: { owner: string | null; ring: Pt[]; km2: number }[] = [];
  for (const owner of order) for (const ring of dissolve(byOwner.get(owner)!)) outlines.push({ owner, ring, km2: km2(ring) });
  const simple = simplifyShared(
    outlines.map((o) => o.ring),
    TOLERANCE,
  );
  const biggest = new Map<string | null, number>();
  for (const o of outlines) biggest.set(o.owner, Math.max(biggest.get(o.owner) ?? 0, o.km2));
  const units: ShapeUnit[] = [];
  const rings = new Map<string | null, Pt[][]>();
  for (const owner of order) {
    const mine = outlines
      .map((o, i) => ({ ...o, simple: simple[i]! }))
      .filter((o) => o.owner === owner && (o.km2 >= MIN_ISLAND || (owner !== null && biggest.get(owner)! < SMALL_ISLANDS)))
      .sort((a, b) => b.km2 - a.km2);
    const coded: number[][] = [];
    const degrees: Pt[][] = [];
    for (const o of mine) {
      let q = quantize(o.simple) ?? quantize(o.ring);
      if (!q) {
        // smaller than the grid (the Vatican): a diamond around it
        const cx = Math.round((o.ring.reduce((s, p) => s + p[0], 0) / o.ring.length) * SCALE);
        const cy = Math.round((o.ring.reduce((s, p) => s + p[1], 0) / o.ring.length) * SCALE);
        q = [
          [cx, cy - 1],
          [cx + 1, cy],
          [cx, cy + 1],
          [cx - 1, cy],
        ];
      }
      coded.push(deltaCode(q));
      degrees.push(q.map(([x, y]) => [x / SCALE, y / SCALE]));
    }
    if (coded.length === 0) continue;
    units.push({ id: owner, rings: coded });
    rings.set(owner, degrees);
  }
  return { shapes: { v: 1, scale: SCALE, units }, rings };
}

/**
 * A country's main land's extent: its ring around `at` (else its
 * biggest), grown by every ring of it within 3° of what is in, across
 * the antimeridian too.
 */
function mainBox(rings: Pt[][], at: Pt): [number, number, number, number] {
  const boxes = rings.map((r) => {
    let w = Infinity;
    let s = Infinity;
    let e = -Infinity;
    let n = -Infinity;
    for (const [x, y] of r) {
      w = Math.min(w, x);
      e = Math.max(e, x);
      s = Math.min(s, y);
      n = Math.max(n, y);
    }
    return { w, s, e, n, km2: km2(r), has: inRing(at, r) };
  });
  let start = boxes.findIndex((b) => b.has);
  if (start < 0) start = boxes.reduce((bi, b, i) => (b.km2 > boxes[bi]!.km2 ? i : bi), 0);
  const box = { ...boxes[start]! };
  const used = new Set([start]);
  for (let grown = true; grown; ) {
    grown = false;
    boxes.forEach((b, i) => {
      if (used.has(i)) return;
      for (const shift of [0, 360, -360]) {
        const gx = Math.max(0, b.w + shift - box.e, box.w - (b.e + shift));
        const gy = Math.max(0, b.s - box.n, box.s - b.n);
        if (Math.max(gx, gy) <= 3) {
          box.w = Math.min(box.w, b.w + shift);
          box.e = Math.max(box.e, b.e + shift);
          box.s = Math.min(box.s, b.s);
          box.n = Math.max(box.n, b.n);
          used.add(i);
          grown = true;
          return;
        }
      }
    });
  }
  // and `at` (Natural Earth's label point may lie just off a micro-state's rounded ring)
  const x = at[0] < box.w - 180 ? at[0] + 360 : at[0] > box.e + 180 ? at[0] - 360 : at[0];
  box.w = Math.min(box.w, x);
  box.e = Math.max(box.e, x);
  box.s = Math.min(box.s, at[1]);
  box.n = Math.max(box.n, at[1]);
  const wrap = (x: number): number => Math.round((x > 180 ? x - 360 : x < -180 ? x + 360 : x) * 100) / 100;
  return [wrap(box.w), Math.round(box.s * 100) / 100, wrap(box.e), Math.round(box.n * 100) / 100];
}

// ---------------------------------------------------------------- Wikimedia

/** The 12 whole months before the first run (kept in .cache/, renewed by --refresh). */
function period(): { start: string; end: string } {
  const path = join(CACHE, "period.json");
  if (!REFRESH && existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as { start: string; end: string };
  const now = new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 11, 1));
  const ymd = (d: Date): string => d.toISOString().slice(0, 10).replaceAll("-", "");
  const p = { start: ymd(start), end: ymd(end) };
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(path, JSON.stringify(p) + "\n");
  return p;
}

/**
 * An article's page views by people in a typical month of the period:
 * the median month, so that a month of news (Cape Verde at the 2026 World
 * Cup: 20 times its usual) does not make a country famous.
 */
async function pageviews(wiki: "en" | "de", title: string, p: { start: string; end: string }): Promise<number> {
  const t = encodeURIComponent(title.replaceAll(" ", "_"));
  const url = `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/${wiki}.wikipedia/all-access/user/${t}/monthly/${p.start}00/${p.end}00`;
  const json = (await cachedJson(`pageviews/${wiki}-${title.replace(/[^\p{L}\p{N}]+/gu, "_")}.json`, url)) as {
    items: { views: number }[];
  };
  const months = json.items.map((i) => i.views).sort((a, b) => a - b);
  const mid = months.length >> 1;
  return months.length === 0 ? 0 : months.length % 2 ? months[mid]! : (months[mid - 1]! + months[mid]!) / 2;
}

/** In batches of 50, as the MediaWiki APIs take them. */
function batches<T>(list: T[], n = 50): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

/** The Wikidata item of English Wikipedia articles (redirects followed), and its labels. */
async function articleItems(titles: string[]): Promise<Map<string, { q: string; en?: string; de?: string }>> {
  const toItem = new Map<string, string>();
  for (const b of batches([...new Set(titles)].sort())) {
    const url = `https://en.wikipedia.org/w/api.php?action=query&format=json&redirects=1&prop=pageprops&ppprop=wikibase_item&titles=${encodeURIComponent(b.join("|"))}`;
    const json = (await cachedJson("enwiki-items.json", url)) as {
      query: {
        normalized?: { from: string; to: string }[];
        redirects?: { from: string; to: string }[];
        pages: Record<string, { title: string; pageprops?: { wikibase_item?: string } }>;
      };
    };
    const byTitle = new Map<string, string>();
    for (const page of Object.values(json.query.pages)) {
      if (page.pageprops?.wikibase_item) byTitle.set(page.title, page.pageprops.wikibase_item);
    }
    for (const t of b) {
      let to = t;
      to = json.query.normalized?.find((n) => n.from === to)?.to ?? to;
      to = json.query.redirects?.find((n) => n.from === to)?.to ?? to;
      const q = byTitle.get(to);
      if (q) toItem.set(t, q);
    }
  }
  const labels = new Map<string, { en?: string; de?: string }>();
  for (const b of batches([...new Set(toItem.values())].sort())) {
    const url = `https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=labels&languages=en|de&ids=${b.join("|")}`;
    const json = (await cachedJson("wikidata-labels.json", url)) as {
      entities: Record<string, { labels?: Record<string, { value: string }> }>;
    };
    for (const [q, e] of Object.entries(json.entities)) labels.set(q, { en: e.labels?.["en"]?.value, de: e.labels?.["de"]?.value });
  }
  const out = new Map<string, { q: string; en?: string; de?: string }>();
  for (const [t, q] of toItem) out.set(t, { q, ...labels.get(q) });
  return out;
}

interface Flag {
  file: string;
  svg: Buffer;
  licence: string;
  artist: string;
}

/** Flags from Commons: the SVGs and their licences. */
async function commonsFlags(files: string[]): Promise<Map<string, Flag>> {
  const out = new Map<string, Flag>();
  for (const b of batches([...new Set(files)].sort())) {
    const titles = b.map((f) => `File:${f}`).join("|");
    const url = `https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo&iiprop=url|extmetadata&iiextmetadatafilter=LicenseShortName|Artist&titles=${encodeURIComponent(titles)}`;
    const json = (await cachedJson("commons-flags.json", url)) as {
      query: {
        normalized?: { from: string; to: string }[];
        pages: Record<
          string,
          {
            title: string;
            imageinfo?: { url: string; extmetadata?: Record<string, { value: string }> }[];
          }
        >;
      };
    };
    for (const f of b) {
      let t = `File:${f}`;
      t = json.query.normalized?.find((n) => n.from === t)?.to ?? t;
      const page = Object.values(json.query.pages).find((p) => p.title === t);
      const info = page?.imageinfo?.[0];
      if (!info) {
        problems.push(`flag ${f}: not on Commons`);
        continue;
      }
      // LF line ends: the repository checks text out with LF (.gitattributes), and the file's name is its content's hash.
      const raw = await cached(`flags/${f.replace(/[^\p{L}\p{N}.]+/gu, "_")}`, info.url);
      // A viewBox where it has none, so every browser scales it (scripts/flags.ts).
      const svg = Buffer.from(withViewBox(raw.toString("utf8").replace(/\r\n?/g, "\n")), "utf8");
      const meta = info.extmetadata ?? {};
      const plain = (s: string | undefined): string => (s ?? "").replace(/<[^>]*>/g, "").trim();
      out.set(f, { file: f, svg, licence: plain(meta["LicenseShortName"]?.value), artist: plain(meta["Artist"]?.value) });
    }
  }
  return out;
}

/** `f` over `list`, `n` at a time, results in order. */
async function pool<T, R>(list: T[], n: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(list.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < list.length) {
        const i = next++;
        out[i] = await f(list[i]!);
      }
    }),
  );
  return out;
}

// ---------------------------------------------------------------- names

/** Lower case, accents and everything but letters and digits off: for comparing names. */
function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * Whether a Wikidata alias is worth keeping as an answer: Latin script,
 * more than three letters, no digits, no qualifiers ("Berlin, Germany",
 * "Bolivia (Plurinational State of)"), no abbreviation ("Lond.").
 */
function goodAlias(a: string): boolean {
  if (/[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u.test(a)) return false;
  if (/[\p{N},()]|\.$/u.test(a)) return false;
  return fold(a).replace(/\p{N}/gu, "").length > 3;
}

/** `list` without repeats (by `fold`), without those in `not`. */
function distinct(list: string[], not: string[] = []): string[] {
  const seen = new Set(not.map(fold));
  const out: string[] = [];
  for (const x of list) {
    const f = fold(x);
    if (f === "" || seen.has(f)) continue;
    seen.add(f);
    out.push(x);
  }
  return out;
}

// ---------------------------------------------------------------- the cards

const SOURCES =
  "Wikidata (CC0); World Bank (CC BY 4.0); IMF; United Nations; Natural Earth (public domain); Wikipedia; Wikimedia Commons";

/** Licences a flag may have without a decision. */
const FREE = /^(public domain|pd\b|cc0)/i;

interface Output {
  countries: Countries;
  shapes: Shapes;
  flags: Map<string, Buffer>;
}

async function build(): Promise<Output> {
  const d = parseDecisions(readFileSync(join(DATA, "decisions.txt"), "utf8"));
  const extra = [...d.deck.keys()];
  for (const c of d.countries.values()) {
    if (c.item) extra.push(c.item);
    if (c.flag?.startsWith("Q")) extra.push(c.flag);
  }
  const { un, items } = await wikidata(extra);
  if (un.size !== 193) problems.push(`Wikidata lists ${un.size} UN members, not 193`);

  // the deck
  const deck = new Map<string, { q: string; disputed: boolean }>();
  for (const [q, iso] of un) {
    const dd = d.deck.get(q);
    const id = dd?.id ?? iso;
    if (id === undefined) problems.push(`UN member ${q} has no ISO code: add "deck ${q}: XX"`);
    else deck.set(id, { q, disputed: dd?.disputed ?? false });
  }
  for (const [q, dd] of d.deck) if (!un.has(q)) deck.set(dd.id, { q, disputed: dd.disputed });
  const ids = [...deck.keys()].sort();
  const inDeck = new Set(ids);
  for (const id of d.countries.keys()) if (!inDeck.has(id)) problems.push(`decisions for ${id}, which is not in the deck`);
  const none: CountryDecisions = {
    aliases: { en: [], de: [] },
    dropAliases: new Set(),
    capitalAliases: { en: [], de: [] },
    via: {},
  };
  const dec = (id: string): CountryDecisions => d.countries.get(id) ?? none;
  const mainItem = (id: string): Item => items.get(deck.get(id)!.q)!;
  /** The item for names, articles, capitals and the flag: `item:` if decided. */
  const itemOf = (id: string): Item => {
    const q = dec(id).item;
    return (q ? items.get(q) : undefined) ?? mainItem(id);
  };
  const partsOf = (id: string): string[] => {
    const p = dec(id).parts ?? [mainItem(id).iso3 ?? itemOf(id).iso3 ?? ""];
    if (p[0] === "") problems.push(`${id}: no ISO 3166 alpha-3 code: add "${id} parts: ABC"`);
    return p;
  };

  // names, as Wikipedia's lists write them
  const names = new Map<string, Named>();
  for (const id of ids) {
    const it = itemOf(id);
    const name = dec(id).name ?? { en: it.en ?? "", de: it.de ?? "" };
    if (name.en === "" || name.de === "") problems.push(`${id}: no name in Wikidata: add "${id} name: … | …"`);
    names.set(id, name);
  }
  const own = new Map<string, string>();
  for (const id of ids) {
    const m = mainItem(id);
    const it = itemOf(id);
    for (const n of [names.get(id)!.en, it.en, m.en, it.enwiki, m.enwiki]) if (n && !own.has(fold(n))) own.set(fold(n), id);
  }
  const unplaced = new Set<string>();
  /** The country a name in a Wikipedia list stands for (null: nobody in the deck), and whether as a part. */
  const place = (name: string, list: string): { id: string | null; part: boolean } | undefined => {
    const w = d.wiki.get(name);
    if (w) return w;
    const id = own.get(fold(name));
    if (id) return { id, part: false };
    unplaced.add(`wiki ${name}: XX|XX part|-   (in ${list})`);
    return undefined;
  };

  // Natural Earth
  const [ne10, ne50] = await Promise.all([naturalEarth("10m"), naturalEarth("50m")]);
  const owners10 = unitOwners(ne10, inDeck, d);
  const owners50 = unitOwners(ne50, inDeck, d);
  const computed = adjacency(ne10, owners10, d);
  const world = land(ne50, owners50, d);

  // borders: computed against Wikipedia's list
  const listed = new Map<string, Set<string>>();
  const link = (m: Map<string, Set<string>>, a: string, b: string): void => {
    (m.get(a) ?? m.set(a, new Set()).get(a)!).add(b);
    (m.get(b) ?? m.set(b, new Set()).get(b)!).add(a);
  };
  for (const row of parseBorders(await wikitext("List of countries and territories by number of land borders"))) {
    const a = place(row.name, "the land borders");
    if (!a?.id) continue;
    for (const n of row.neighbours) {
      const b = place(n, "the land borders");
      if (b?.id && b.id !== a.id) link(listed, a.id, b.id);
    }
  }
  const neighbours = new Map<string, Set<string>>(ids.map((id) => [id, new Set<string>()]));
  const pairs = new Set<string>();
  for (const m of [computed, listed]) for (const [a, bs] of m) for (const b of bs) pairs.add(pair(a, b));
  for (const p of d.borders.keys()) pairs.add(p);
  for (const p of [...pairs].sort()) {
    const [a, b] = p.split(" ") as [string, string];
    const c = computed.get(a)?.has(b) ?? false;
    const w = listed.get(a)?.has(b) ?? false;
    const decided = d.borders.get(p);
    if (decided === undefined && c !== w)
      problems.push(`border ${p}: ${c ? "touch in Natural Earth" : "do not touch in Natural Earth"}, ${w ? "" : "not "}in Wikipedia's list: add "border ${p}: yes|no -- why"`);
    if (decided ?? c) {
      neighbours.get(a)?.add(b);
      neighbours.get(b)?.add(a);
    }
  }

  // highest points
  const iso3 = new Map<string, string>();
  for (const id of ids) for (const p of partsOf(id)) iso3.set(p, id);
  const elevations = parseElevations(await wikitext("List of elevation extremes by country"));
  const summits = await articleItems(elevations.flatMap((e) => (e.link ? [e.link] : [])));
  const highest = new Map<string, ElevationRow>();
  for (const e of elevations) {
    const id = iso3.get(e.code) ?? (/^[A-Z]+$/.test(e.code) ? d.wiki.get(e.code)?.id : place(e.code, "the elevation extremes")?.id);
    if (!id) continue;
    const was = highest.get(id);
    if (!was || e.m > was.m) highest.set(id, e);
  }

  // numbers
  const [pop, area, gdpPc] = await Promise.all([
    worldBank("SP.POP.TOTL"),
    worldBank("AG.SRF.TOTL.K2"),
    worldBank("NY.GDP.PCAP.CD"),
  ]);
  const [imfPc, imfPop] = await Promise.all([imf("NGDPDPC"), imf("LP")]);
  const years = new Map<number, number>();
  for (const f of gdpPc.values()) years.set(f.year, (years.get(f.year) ?? 0) + 1);
  const year = [...years].sort((a, b) => b[1] - a[1])[0]![0];
  const fromImf = (m: Map<string, Map<number, number>>, code: string): Figure | undefined => {
    const v = m.get(IMF_CODE[code] ?? code);
    if (!v) return undefined;
    for (let y = year; y > year - 5; y--) {
      const x = v.get(y);
      if (x !== undefined) return { value: x, year: y };
    }
    return undefined;
  };
  const areas = parseAreas(await wikitext("List of countries and dependencies by area"));
  const wikiArea = new Map<string, number>();
  for (const [name, km] of areas) {
    const p = place(name, "the areas");
    if (p?.id && !p.part && !wikiArea.has(p.id)) wikiArea.set(p.id, km);
  }

  // fame
  const per = period();
  const views = await pool(ids, 6, async (id) => {
    const it = itemOf(id);
    let n = 0;
    for (const [wiki, title] of [
      ["en", it.enwiki],
      ["de", it.dewiki],
    ] as const) {
      if (title === undefined) problems.push(`${id}: no ${wiki} Wikipedia article in Wikidata`);
      else n += await pageviews(wiki, title, per);
    }
    return n;
  });
  const byViews = ids.map((id, i) => ({ id, n: views[i]! })).sort((a, b) => b.n - a.n || a.id.localeCompare(b.id));
  const fame = new Map(byViews.map((x, i) => [x.id, i + 1]));

  // flags
  const flagFile = new Map<string, string>();
  for (const id of ids) {
    const f = dec(id).flag;
    const list = f === undefined ? itemOf(id).flags : f.startsWith("Q") ? (items.get(f)?.flags ?? []) : [f];
    const pick = list.find((x) => x.startsWith("Flag of")) ?? list[0];
    if (list.length > 1) notes.push(`${id}: several flags in Wikidata (${list.join(", ")}), took ${pick ?? "-"}`);
    if (pick === undefined) problems.push(`${id}: no flag: add "${id} flag: File name.svg"`);
    else flagFile.set(id, pick);
  }
  const flagData = await commonsFlags([...flagFile.values()]);
  const flagsOut = new Map<string, Buffer>();

  const countries: Country[] = [];
  for (const id of ids) {
    const c = dec(id);
    const m = mainItem(id);
    const it = itemOf(id);
    const name = names.get(id)!;
    const disputed = deck.get(id)!.disputed;

    const alias = (lang: "en" | "de"): string[] => {
      const wd = [m[lang], it[lang], ...m.aliases[lang], ...(it === m ? [] : it.aliases[lang])].filter(
        (a): a is string => a !== undefined && goodAlias(a) && !c.dropAliases.has(a),
      );
      return distinct([...c.aliases[lang], ...wd], [name[lang]]);
    };

    let capitals = c.capitals;
    if (!capitals) {
      const caps = it.capitals;
      if (caps.length !== 1)
        problems.push(`${id}: ${caps.length} capitals in Wikidata (${caps.map((x) => x.en).join(", ")}): add "${id} capitals: … | … -- why"`);
      capitals = { en: caps.flatMap((x) => (x.en ? [x.en] : [])), de: caps.flatMap((x) => (x.de ? [x.de] : [])) };
      if (caps.some((x) => !x.en || !x.de)) problems.push(`${id}: a capital without an English or German name in Wikidata`);
    }
    if (capitals.en.length === 0 || capitals.en.length !== capitals.de.length)
      problems.push(`${id}: capitals ${capitals.en.join(", ")} | ${capitals.de.join(", ")}`);
    const capitalAlias = (lang: "en" | "de"): string[] => {
      const wd = it.capitals
        .filter((x) => (x.en && capitals.en.includes(x.en)) || (x.de && capitals.de.includes(x.de)))
        .flatMap((x) => x.aliases[lang])
        .filter((a) => goodAlias(a) && !c.dropAliases.has(a));
      return distinct([...c.capitalAliases[lang], ...wd], capitals[lang]);
    };

    // numbers, summed over the parts
    const parts = partsOf(id);
    let population = 0;
    let km = 0;
    let gdpSum = 0;
    let gdpPop = 0;
    let populationYear = 0;
    let gdpYear = 0;
    for (const [i, p] of parts.entries()) {
      const fig = d.parts.get(p);
      const pp: Figure | undefined = fig?.population
        ? { value: fig.population[0], year: fig.population[1] }
        : (pop.get(p) ?? (() => {
            const x = fromImf(imfPop, p);
            return x && { value: Math.round(x.value * 1e6), year: x.year };
          })());
      const aa = fig?.area ?? area.get(p)?.value;
      let gg: Figure | undefined = fig?.gdp ? { value: fig.gdp[0], year: fig.gdp[1] } : gdpPc.get(p);
      if (!fig?.gdp && (!gg || gg.year < year - 3)) {
        const x = fromImf(imfPc, p);
        if (x) {
          if (gg) notes.push(`${p}: World Bank GDP per person is from ${gg.year}, took the IMF's for ${x.year}`);
          gg = x;
        }
      }
      if (!pp && !c.population) problems.push(`${id}: no population for ${p}: add "${p} population: N YEAR -- source"`);
      if (aa === undefined && c.area === undefined) problems.push(`${id}: no area for ${p}: add "${p} area: N -- source"`);
      if (!gg && i === 0 && !c.gdp) problems.push(`${id}: no GDP per person for ${p}: add "${p} gdp: N YEAR -- source"`);
      if (!gg && i > 0) notes.push(`${id}: no GDP for its part ${p}; GDP per person is over the other parts`);
      population += pp?.value ?? 0;
      km += aa ?? 0;
      if (gg && pp) {
        gdpSum += gg.value * pp.value;
        gdpPop += pp.value;
      }
      if (i === 0) {
        populationYear = pp?.year ?? 0;
        gdpYear = gg?.year ?? 0;
      }
    }
    if (c.population) [population, populationYear] = c.population;
    let gdp = gdpPop > 0 ? gdpSum / gdpPop : 0;
    if (c.gdp) [gdp, gdpYear] = c.gdp;
    const wa = wikiArea.get(id);
    if (typeof c.area === "number") km = c.area;
    else if (c.area === "wikipedia") {
      if (wa === undefined) problems.push(`${id} area: wikipedia, but Wikipedia's list has no row for it`);
      else km = wa;
    }
    if (wa === undefined) {
      if (c.area === undefined) problems.push(`${id}: not in Wikipedia's areas: add "wiki Name: ${id}" or "${id} area: ok -- why"`);
    } else if (Math.abs(km - wa) > AREA_SLACK * wa && c.area === undefined)
      problems.push(`${id} area: ${Math.round(km)} km², Wikipedia ${wa}: add "${id} area: N|ok|wikipedia -- why"`);

    // the highest point
    let top = c.highest;
    if (!top) {
      const e = highest.get(id);
      if (!e) problems.push(`${id}: no highest point in Wikipedia's list: add "${id} highest: M English | German -- why"`);
      else {
        const s = e.link ? summits.get(e.link) : undefined;
        if (!s?.de) notes.push(`${id}: ${e.name} has no German name in Wikidata`);
        top = { name: { en: e.name, de: s?.de ?? e.name }, m: Math.round(e.m) };
      }
    }
    if (top) {
      const wd = [...m.highest, ...(it === m ? [] : it.highest)];
      if (!wd.some((h) => h.m !== undefined && Math.abs(h.m - top.m) <= 25))
        notes.push(`${id}: highest ${top.name.en} ${top.m} m; Wikidata: ${wd.map((h) => `${h.en ?? "?"} ${h.m ?? "?"}`).join(", ") || "nothing"}`);
    }

    // the land
    const rings = world.rings.get(id);
    const mainA3 = parts[0];
    const units = ne50.filter((f) => owners50.get(prop(f, "ADM0_A3")) === id);
    const mainUnit =
      units.find((f) => prop(f, "ADM0_A3") === mainA3 || prop(f, "ISO_A3_EH") === mainA3) ??
      units.sort((a, b) => polygonsOf(b).length - polygonsOf(a).length)[0];
    let at: [number, number] = [0, 0];
    let box: [number, number, number, number] = [0, 0, 0, 0];
    if (!rings || !mainUnit) problems.push(`${id}: no land in Natural Earth 1:50m`);
    else {
      at = [Number(mainUnit.properties["LABEL_X"]), Number(mainUnit.properties["LABEL_Y"])].map(
        (x) => Math.round(x * 100) / 100,
      ) as [number, number];
      box = mainBox(rings, at);
    }

    // the flag
    let flag = "";
    const ff = flagFile.get(id);
    const fd = ff ? flagData.get(ff) : undefined;
    if (fd) {
      flag = createHash("sha256").update(fd.svg).digest("hex").slice(0, 10) + ".svg";
      flagsOut.set(flag, fd.svg);
      if (!FREE.test(fd.licence) && c.flagLicence !== fd.licence)
        problems.push(`${id}: flag ${fd.file} is ${fd.licence || "unlicensed"}: add "${id} flag-licence: ${fd.licence} -- why it may be used"`);
    }

    const nb = [...neighbours.get(id)!].sort();
    const via: Record<string, Named> = {};
    for (const [k, v] of Object.entries(c.via).sort()) {
      if (!nb.includes(k)) problems.push(`${id} via ${k}: not a neighbour`);
      via[k] = v;
    }

    const card: Country = {
      id,
      ...(disputed ? { disputed: true } : {}),
      name,
      aliases: { en: alias("en"), de: alias("de") },
      capitals,
      capitalAliases: { en: capitalAlias("en"), de: capitalAlias("de") },
      population: Math.round(population),
      populationYear,
      // km², to the km², to the hundredth below 100 km² (the Vatican, Monaco)
      area: km < 100 ? Math.round(km * 100) / 100 : Math.round(km),
      gdp: Math.round(gdp),
      gdpYear,
      highest: top ?? { name: { en: "", de: "" }, m: 0 },
      neighbours: nb,
      ...(Object.keys(via).length > 0 ? { via } : {}),
      fame: fame.get(id)!,
      at,
      box,
      flag,
    };
    countries.push(card);
  }

  // an alias that is another country's name is no answer
  const nameOf = new Map<string, string>();
  for (const c of countries) for (const n of [c.name.en, c.name.de]) nameOf.set(fold(n), c.id);
  for (const c of countries) {
    for (const lang of ["en", "de"] as const) {
      c.aliases[lang] = c.aliases[lang].filter((a) => {
        const other = nameOf.get(fold(a));
        if (other === undefined || other === c.id) return true;
        notes.push(`${c.id}: dropped the alias ${a}, ${other}'s name`);
        return false;
      });
    }
  }

  problems.push(...[...unplaced].sort());
  return { countries: { v: 1, sources: SOURCES, countries }, shapes: world.shapes, flags: flagsOut };
}

// ---------------------------------------------------------------- writing

function countriesJson(c: Countries): string {
  return `{"v":${c.v},"sources":${JSON.stringify(c.sources)},"countries":[\n${c.countries.map((x) => JSON.stringify(x)).join(",\n")}\n]}\n`;
}

function shapesJson(s: Shapes): string {
  return `{"v":${s.v},"scale":${s.scale},"units":[\n${s.units.map((u) => JSON.stringify(u)).join(",\n")}\n]}\n`;
}

async function main(): Promise<void> {
  const out = await build();
  for (const n of [...new Set(notes)]) console.log(`note: ${n}`);
  const unique = [...new Set(problems)];
  if (unique.length > 0) {
    for (const p of unique) console.error(`decide: ${p}`);
    console.error(`${unique.length} cases need a decision in data/decisions.txt`);
    process.exitCode = 1;
    return;
  }
  const files = new Map<string, string | Buffer>([
    ["countries.json", countriesJson(out.countries)],
    ["shapes.json", shapesJson(out.shapes)],
  ]);
  for (const [name, svg] of out.flags) files.set(`flags/${name}`, svg);
  const flagDir = join(DATA, "flags");
  const stale = existsSync(flagDir)
    ? readdirSync(flagDir)
        .filter((f) => !out.flags.has(f))
        .map((f) => `flags/${f}`)
    : [];
  if (CHECK) {
    const differ = [...files].filter(([name, body]) => {
      const path = join(DATA, name);
      return !existsSync(path) || !readFileSync(path).equals(Buffer.from(body));
    });
    for (const [name] of differ) console.error(`data/${name} is not what scripts/data.ts writes`);
    for (const name of stale) console.error(`data/${name} is not written by scripts/data.ts`);
    if (differ.length > 0 || stale.length > 0) process.exitCode = 1;
    else console.log("data/ is up to date");
    return;
  }
  mkdirSync(flagDir, { recursive: true });
  for (const [name, body] of files) writeFileSync(join(DATA, name), body);
  for (const name of stale) rmSync(join(DATA, name));
  const size = (name: string): string => `${(Buffer.byteLength(files.get(name)!) / 1024).toFixed(0)} KB`;
  const flagBytes = [...out.flags.values()].reduce((s, b) => s + b.length, 0);
  console.log(
    `${out.countries.countries.length} countries (${size("countries.json")}), shapes ${size("shapes.json")}, ${out.flags.size} flags (${(flagBytes / 1024).toFixed(0)} KB)`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
