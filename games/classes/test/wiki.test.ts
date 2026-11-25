import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";

import { cleanTitle, cutText, plainText, safeImage, Wikipedia, type Fetch } from "../game/wiki.ts";

/** Responses recorded once from en/de Wikipedia (test/fixtures/wiki/README.md), by a part of their URL. */
function fixture(name: string): string {
  const raw = readFileSync(new URL(`fixtures/wiki/${name}`, import.meta.url));
  return name.endsWith(".gz") ? gunzipSync(raw).toString("utf8") : raw.toString("utf8");
}

type Route = string | number | Error;

/** A fetch answering from fixtures: the first route whose key is in the URL; a number is a status; else 404. */
function fake(routes: [string, Route][], calls: string[] = []): Fetch {
  return async (url) => {
    calls.push(url);
    for (const [part, r] of routes) {
      if (!url.includes(part)) continue;
      if (r instanceof Error) throw r;
      if (typeof r === "number") return { ok: false, status: r, json: async () => ({}), text: async () => "" };
      const body = r.startsWith("<") || r.startsWith("{") ? r : fixture(r);
      return { ok: true, status: 200, json: async () => JSON.parse(body), text: async () => body };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
  };
}

const QUERY = "action=query&format=json&formatversion=2&origin=*&redirects=1&prop=pageprops%7Cdescription%7Cpageimages&piprop=thumbnail&pithumbsize=640&ppprop=disambiguation&titles=";
const EN: [string, Route][] = [
  [`${QUERY}Beavers`, "q-en-beavers.json"],
  [`${QUERY}Beaver`, "q-en-beaver.json"],
  [`${QUERY}Mercury`, "q-en-mercury.json"],
  [`${QUERY}big%20furry`, "q-en-missing.json"],
  ["list=search&srsearch=big%20furry", "s-en-dam.json"],
  ["list=search&srsearch=Qxzvbnmwlk", "en-search-nothing.json"],
  ["page/html/Beaver", "en-beaver.html.gz"],
  ["page/html/Mercury", "en-mercury.html"],
];

test("found by its exact title: the facts from the query API, the text from page/html", async () => {
  const calls: string[] = [];
  const f = await new Wikipedia(fake(EN, calls)).find("Beaver", "en");
  assert.equal(f.error, undefined);
  assert.deepEqual(f.results, []);
  const a = f.article!;
  assert.equal(a.title, "Beaver");
  assert.equal(a.description, "Semiaquatic rodent");
  assert.match(a.image!, /^https:\/\/upload\.wikimedia\.org\/wikipedia\/commons\/6\/6b\/American_Beaver\.jpg/);
  assert.equal(a.url, "https://en.wikipedia.org/wiki/Beaver");
  assert.equal(a.cut, true);
  assert.equal(a.disambiguation, undefined);
  assert.ok(a.blocks.length > 20);
  assert.deepEqual(calls, [`https://en.wikipedia.org/w/api.php?${QUERY}Beaver`, "https://en.wikipedia.org/api/rest_v1/page/html/Beaver"]);
});

test("a redirect is followed (Beavers → Beaver); a redirect to a section says which (Pumuckl)", async () => {
  const f = await new Wikipedia(fake(EN)).find("Beavers", "en");
  assert.equal(f.article?.title, "Beaver");
  const de = await new Wikipedia(
    fake([
      [`${QUERY}Pumuckl`, "q-de-pumuckl.json"],
      ["page/html/Meister_Eder_und_sein_Pumuckl", "<body><section><p>Eine Kinderreihe.</p></section><section><h2>Pumuckl</h2><p>Ein Kobold.</p></section></body>"],
    ]),
  ).article("Pumuckl", "de");
  assert.ok(!("error" in de));
  assert.equal(de.title, "Meister Eder und sein Pumuckl");
  assert.equal(de.section, "Pumuckl");
  assert.deepEqual(de.blocks, [
    { t: "p", c: ["Eine Kinderreihe."] },
    { t: "h2", c: ["Pumuckl"] },
    { t: "p", c: ["Ein Kobold."] },
  ]);
});

test("a disambiguation page is an article, marked as such", async () => {
  const a = await new Wikipedia(fake(EN)).article("Mercury", "en");
  assert.ok(!("error" in a));
  assert.equal(a.disambiguation, true);
  assert.equal(a.description, "Topics referred to by the same term");
  assert.equal(a.image, undefined);
  const de = await new Wikipedia(
    fake([
      [`${QUERY}Bank`, "q-de-bank.json"],
      ["page/html/Bank_(Begriffskl%C3%A4rung)", "de-bank.html"],
    ]),
  ).article("Bank (Begriffsklärung)", "de");
  assert.ok(!("error" in de));
  assert.equal(de.disambiguation, true);
  assert.equal(de.url, "https://de.wikipedia.org/wiki/Bank_(Begriffskl%C3%A4rung)");
});

test("no such title: the search, its results (plain text), the first one opened", async () => {
  const calls: string[] = [];
  const w = new Wikipedia(fake([...EN, [`${QUERY}List%20of%20programs`, "q-en-mercury.json"]], calls));
  const f = await w.find("big furry dam builder", "en");
  assert.deepEqual(
    f.results.map((r) => r.title),
    ["List of programs broadcast by PBS Kids", "List of years in animation", f.results[2]!.title, f.results[3]!.title, f.results[4]!.title],
  );
  assert.ok(f.results.every((r) => !/[<>]|&quot;/.test(r.snippet)));
  assert.match(f.results[0]!.snippet, /"WTTW NATIONAL PRODUCTIONS PRESENTS HEIDI 4 PAWS: A FURRY TALE"/);
  // (The first result's facts are routed to Mercury's here: what matters is the order of the calls.)
  assert.equal(f.article?.title, "Mercury");
  assert.ok(calls[1]!.includes("list=search&srsearch=big%20furry%20dam%20builder&srlimit=5"));
  assert.deepEqual(await new Wikipedia(fake(EN)).find("Qxzvbnmwlk", "en"), { error: "none", results: [] });
});

test("failures: not reachable, too busy, rate-limited, missing; never a throw", async () => {
  assert.deepEqual(await new Wikipedia(fake([["", new TypeError("fetch failed")]])).find("Beaver", "en"), { error: "offline", results: [] });
  assert.deepEqual(await new Wikipedia(fake([["", 429]])).find("Beaver", "en"), { error: "offline", results: [] });
  assert.deepEqual(await new Wikipedia(fake([[QUERY, "q-en-missing.json"], ["list=search", "de-search-busy.json"]])).find("Köln", "de"), { error: "offline", results: [] });
  assert.deepEqual(await new Wikipedia(fake([[QUERY, "q-en-missing.json"]])).article("big furry dam builder", "en"), { error: "none" });
  assert.deepEqual(await new Wikipedia(fake([[QUERY, "q-en-beaver.json"], ["page/html", 503]])).article("Beaver", "en"), { error: "offline" });
  // Junk instead of the expected shapes.
  assert.deepEqual(await new Wikipedia(fake([[QUERY, '{"query":{"pages":[{"ns":0,"title":42}]}}']])).article("x", "en"), { error: "none" });
  const junk = await new Wikipedia(fake([[QUERY, '{"query":{"pages":[{"ns":0,"title":"<b>Ok</b>","thumbnail":{"source":"javascript:alert(1)"},"description":7}]}}'], ["page/html", "<p>Fine.<script>x</script></p>"]])).article("Ok", "en");
  assert.deepEqual(junk, { title: "Ok", url: "https://en.wikipedia.org/wiki/Ok", blocks: [{ t: "p", c: ["Fine."] }] });
  // Not an article (another namespace).
  assert.deepEqual(await new Wikipedia(fake([[QUERY, '{"query":{"pages":[{"ns":6,"title":"File:X.jpg"}]}}']])).article("File:X.jpg", "en"), { error: "none" });
});

test("plain text, cut at a sentence's end; pictures only from Wikimedia over https; titles as asked", () => {
  assert.equal(plainText('<span class="searchmatch">A</span> &amp; B &quot;c&quot; &#039;d&#039; &#x41;&#66;', 100), "A & B \"c\" 'd' AB");
  assert.equal(plainText(null, 10), "");
  assert.equal(cutText("First sentence here. Second sentence here. Third.", 45), "First sentence here. Second sentence here.");
  assert.equal(cutText("Short words without a full stop anywhere at all", 20), "Short words without…");
  assert.ok(safeImage("https://upload.wikimedia.org/wikipedia/commons/a/a1/X.jpg"));
  assert.ok(safeImage("https://thumb.wikimedia.org/wikipedia/commons/thumb/a/a1/X.jpg/330px-X.jpg"));
  for (const bad of ["http://upload.wikimedia.org/x.jpg", "https://evil.org/x.jpg", "https://upload.wikimedia.org.evil.org/x.jpg", "javascript:alert(1)", "data:image/png;base64,AAAA", "https://user@upload.wikimedia.org/x.jpg", 42, null]) {
    assert.equal(safeImage(bad), undefined, String(bad));
  }
  assert.equal(cleanTitle("  Kobold\n "), "Kobold");
  assert.equal(cleanTitle(""), null);
  assert.equal(cleanTitle("   "), null);
  assert.equal(cleanTitle(42), null);
  assert.equal(cleanTitle("x".repeat(201)), null);
  assert.equal(cleanTitle("x".repeat(200))?.length, 200);
});
