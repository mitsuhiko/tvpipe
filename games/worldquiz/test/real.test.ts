import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { Party } from "@tvpipe/party";
import { MemoryRelay } from "@tvpipe/party/testing";

import { Matcher } from "../game/answer.ts";
import { bots } from "../game/bots.ts";
import { landOf, type Countries, type Shapes } from "../game/data.ts";
import { Worldquiz } from "../game/game.ts";
import { kmToCountry, kmToLand } from "../game/geo.ts";
import { deckOf, ranksOf, seeded } from "../game/rules.ts";

const read = <T>(f: string): T => JSON.parse(readFileSync(new URL(`../data/${f}`, import.meta.url), "utf8")) as T;
const { countries } = read<Countries>("countries.json");
const land = landOf(read<Shapes>("shapes.json"));
const by = (id: string) => countries.find((c) => c.id === id)!;

test("typed answers against the real names: either language, aliases, typos, never a neighbour's name", () => {
  const names = new Matcher(countries.map((c) => ({ id: c.id, names: [c.name.en, c.name.de, ...c.aliases.en, ...c.aliases.de] })));
  const is = (answer: string, id: string) => assert.deepEqual(names.read(answer).ids, [id], answer);
  is("Germany", "DE");
  is("deutschland", "DE");
  is("Elfenbeinküste", "CI");
  is("Ivory Coast", "CI");
  is("USA", "US");
  is("Tschechien", "CZ");
  is("Czech Republic", "CZ");
  is("Holland", "NL");
  is("cina", "CN");
  is("China", "CN");
  is("Switzreland", "CH");
  is("Niger", "NE");
  is("Nigeria", "NG");
  is("Iraq", "IQ");
  is("Iran", "IR");
  is("Austria", "AT");
  is("Australia", "AU");
  is("Slovakia", "SK");
  is("Slovenia", "SI");
  const caps = new Matcher(countries.map((c) => ({ id: c.id, names: [...c.capitals.en, ...c.capitals.de, ...c.capitalAliases.en, ...c.capitalAliases.de] })));
  const cap = (answer: string, id: string) => assert.ok(caps.read(answer).ids.includes(id), answer);
  cap("Berlin", "DE");
  cap("Peking", "CN");
  cap("Beijing", "CN");
  cap("Den Haag", "NL");
  cap("Amsterdam", "NL");
  cap("Bern", "CH");
  cap("Sucre", "BO");
  cap("La Paz", "BO");
  cap("Kiew", "UA");
  cap("Kyiv", "UA");
  cap("Pretoria", "ZA");
  cap("Cape Town", "ZA");
});

test("pins on the real land: inside is 0, the Vatican is inside Rome's reach", () => {
  assert.equal(kmToLand(land.get("DE")!, 13.4, 52.52), 0);
  assert.equal(kmToLand(land.get("FR")!, 2.35, 48.86), 0);
  // Paris is far from Germany's border, but not too far.
  const d = kmToLand(land.get("DE")!, 2.35, 48.86);
  assert.ok(d > 250 && d < 450, String(d));
  // The Vatican: a pin on St Peter's is a hit (or within the 25 km of one).
  assert.ok(kmToLand(land.get("VA")!, 12.4534, 41.9029) <= 25);
  // Enclaves: a pin in Maseru is Lesotho's, not South Africa's.
  assert.equal(kmToCountry(land, "LS", 27.48, -29.31), 0);
  assert.ok(kmToCountry(land, "ZA", 27.48, -29.31) > 5);
  assert.equal(kmToCountry(land, "ZA", 28.04, -26.2), 0);
});

test("ranks on the real deck: China first in population, the Vatican last in area", () => {
  const ranks = ranksOf(deckOf(countries, false));
  assert.ok(ranks.get("CN")!.population <= 2);
  assert.equal(ranks.get("RU")!.area, 1);
  assert.equal(ranks.get("NP")!.highest, 1);
  assert.equal(ranks.get("VA")!.area, deckOf(countries, false).length);
  assert.equal(ranks.get("VA")!.gdp, deckOf(countries, false).length);
});

test("a whole game on the real data, every card shown in the game's language", async () => {
  const relay = new MemoryRelay();
  const party = new Party({ grace: 50, maxPlayers: 10 }).listen(relay);
  const g = new Worldquiz(party, {
    countries,
    land,
    lang: "de",
    settings: { rounds: 15, disputed: true },
    timings: { choose: 200, competeIntro: 2, competeCard: 2, competeEnd: 2, discard: 2, announce: 2, reveal: 2, revealWhere: 2, next: 10_000, answer: 0.3 },
    rng: seeded(11),
  });
  g.open();
  const players = await bots(5, { url: "ws://party.test/_tvpipe/ws", WebSocket: relay.WebSocket, room: party.code, key: party.joinKey, rng: seeded(3), think: () => 2, oracle: () => g.truth(), sharp: 0.6 });
  try {
    const names = new Set<string>();
    players[0]!.client.on("view", (v: any) => {
      if (v.me?.card) names.add(v.me.card.name);
    });
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await end;
    assert.ok(names.size > 0);
    for (const n of names) assert.ok(countries.some((c) => c.name.de === n), n);
    assert.deepEqual(
      players.map((b) => b.errors),
      players.map(() => []),
    );
    void by;
  } finally {
    for (const b of players) b.close();
    party.close();
  }
});
