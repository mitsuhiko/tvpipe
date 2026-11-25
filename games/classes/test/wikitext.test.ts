import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";

import { blocksText, decodeEntities, linkTarget, tokenize, wikiBlocks, type Block, type Inline } from "../game/wikitext.ts";

/** Real Parsoid HTML (the REST API's page/html), recorded once (test/fixtures/wiki/README.md). */
function html(name: string): string {
  const raw = readFileSync(new URL(`fixtures/wiki/${name}`, import.meta.url));
  return name.endsWith(".gz") ? gunzipSync(raw).toString("utf8") : raw.toString("utf8");
}

const text = (r: Inline) => (typeof r === "string" ? r : r.s);
const plain = (b: Block) => b.c.map(text).join("");
const links = (blocks: Block[]) => blocks.flatMap((b) => b.c.flatMap((r) => (typeof r !== "string" && r.a ? [r.a] : [])));

/** What holds for every article: the caps, no markup, no empty blocks, links to articles only. */
function sane(blocks: Block[]): void {
  assert.ok(blocks.length > 0 && blocks.length <= 400);
  assert.ok(blocksText(blocks).length <= 20_000);
  for (const b of blocks) {
    const t = plain(b);
    assert.ok(t.trim() !== "", "no empty block");
    assert.equal(t, t.trim(), `trimmed: ${JSON.stringify(t.slice(0, 40))}`);
    assert.ok(!/[<>]|&amp;|&#\d+;|\[\d+\]|\[edit\]|\[Bearbeiten/.test(t), `no markup or footnote marks: ${t.slice(0, 120)}`);
    assert.ok(["p", "h2", "h3", "li", "quote"].includes(b.t));
    if (b.t === "li") assert.ok(b.d === 1 || b.d === 2 || b.d === 3);
    for (const r of b.c) if (typeof r !== "string") assert.ok(r.s !== "" && (r.b || r.i || r.a));
  }
  for (const a of links(blocks)) assert.ok(!/^(File|Datei|Category|Kategorie|Help|Hilfe|Template|Vorlage|Special|Spezial|Wikipedia|Portal|Image|Bild):/i.test(a), a);
  // A heading always has something after it.
  assert.ok(!["h2", "h3"].includes(blocks.at(-1)!.t));
}

test("the tokenizer: tags, attributes, entities, comments, raw text, void elements", () => {
  const t = tokenize(`<!DOCTYPE html><!-- a <b>comment</b> --><p class="x y" data-a='1 > 2' hidden id=z>A &amp; B&nbsp;&#x41;&#66;<br>c<img src="i.png"/></p><style>p { a: "<b>" }</style><script>if (a < b) {}</script>tail`);
  assert.deepEqual(t, [
    { k: "open", name: "p", attrs: Object.assign(Object.create(null), { class: "x y", "data-a": "1 > 2", hidden: "", id: "z" }), self: false },
    { k: "text", s: "A & B\u00a0AB" },
    { k: "open", name: "br", attrs: Object.create(null), self: true },
    { k: "text", s: "c" },
    { k: "open", name: "img", attrs: Object.assign(Object.create(null), { src: "i.png" }), self: true },
    { k: "close", name: "p" },
    { k: "open", name: "style", attrs: Object.create(null), self: false },
    { k: "close", name: "style" },
    { k: "open", name: "script", attrs: Object.create(null), self: false },
    { k: "close", name: "script" },
    { k: "text", s: "tail" },
  ]);
  assert.equal(decodeEntities("&lt;b&gt; &bogus; &#0; &#x1F600; &#55296; &auml;&szlig;"), "<b> &bogus;  😀  äß");
  // Broken HTML does not throw.
  assert.ok(tokenize("<p a='unclosed").length >= 1);
  assert.deepEqual(tokenize("a < b"), [
    { k: "text", s: "a " },
    { k: "text", s: "<" },
    { k: "text", s: " b" },
  ]);
});

test("links: articles only (namespaces, red links, interwiki, elsewhere are text)", () => {
  const a = (attrs: Record<string, string>) => linkTarget(Object.assign(Object.create(null), attrs));
  assert.equal(a({ rel: "mw:WikiLink", href: "./Hausgeist", title: "Hausgeist" }), "Hausgeist");
  assert.equal(a({ rel: "mw:WikiLink", href: "./Scheibenwelt-Romane#Der_f%C3%BCnfte_Elefant" }), "Scheibenwelt-Romane");
  assert.equal(a({ rel: "mw:WikiLink", href: "./Warcraft_III:_Reign_of_Chaos", title: "Warcraft III: Reign of Chaos" }), "Warcraft III: Reign of Chaos");
  assert.equal(a({ rel: "mw:WikiLink", href: "./Datei:Kobold.jpg", title: "Datei:Kobold.jpg" }), null);
  assert.equal(a({ rel: "mw:WikiLink", href: "./Category:Rodents", title: "Category:Rodents" }), null);
  assert.equal(a({ rel: "mw:WikiLink", href: "./Talk:Beaver", title: "Talk:Beaver" }), null);
  assert.equal(a({ rel: "mw:WikiLink", href: "./Benutzer_Diskussion:X", title: "Benutzer Diskussion:X" }), null);
  assert.equal(a({ rel: "mw:WikiLink", href: "./Nothing?action=edit&redlink=1", title: "Nothing", class: "new" }), null);
  assert.equal(a({ rel: "mw:WikiLink/Interwiki", href: "https://fr.wikipedia.org/wiki/Castor", title: "fr:Castor" }), null);
  assert.equal(a({ rel: "mw:ExtLink", href: "https://example.org/" }), null);
  assert.equal(a({ href: "./Kobold#cite_note-1" }), null);
  assert.equal(a({ rel: "mw:WikiLink", href: "javascript:alert(1)", title: "x" }), null);
});

test("the whitelist on made-up HTML: formats, lists, quotes, math, clutter dropped, sections dropped by heading", () => {
  const r = wikiBlocks(
    `<body><section><div role="note" class="hatnote">For other uses, see <a rel="mw:WikiLink" href="./X">X</a>.</div>
<table class="infobox"><tr><td>Born 1900</td></tr></table>
<p><b>Thing</b> is a <i>very <a rel="mw:WikiLink" href="./Odd_thing" title="Odd thing">odd</a></i> thing<sup class="mw-ref reference" typeof="mw:Extension/ref"><a href="#cite_note-1">[1]</a></sup>,  with   spaces and <span>spans</span>.</p>
<p class="mw-empty-elt"></p>
<figure typeof="mw:File/Thumb"><img src="x.jpg"/><figcaption>A picture</figcaption></figure>
<p>It holds <math alttext="{\\displaystyle a^{2}+b^{2}}"><mi>a</mi></math> and <a rel="mw:WikiLink" href="./Thing" title="Thing">itself</a>.<style>.x{}</style></p>
<ol><li>One</li><li>Two<ul><li>Two a</li></ul></li><li><a rel="mw:WikiLink" href="./Three" title="Three">Three</a></li></ol>
<blockquote><p>A quote.</p></blockquote>
<dl><dt>Term</dt><dd>Its meaning.</dd></dl>
<div class="navbox">Navigation stuff</div>
<script>alert(1)</script></section>
<section><h2>History</h2><section><h3>Early</h3><p>Long ago.</p></section></section>
<section><h2>See also</h2><ul><li><a rel="mw:WikiLink" href="./Y">Y</a></li></ul><section><h3>More</h3><p>Dropped too.</p></section></section>
<section><h2>Empty</h2><table><tr><td>only a table</td></tr></table></section>
<section><h2>Legacy</h2><p>After.</p></section></body>`,
    { self: "Thing" },
  );
  assert.equal(r.cut, false);
  assert.deepEqual(r.blocks, [
    { t: "p", c: [{ s: "Thing", b: true }, " is a ", { s: "very ", i: true }, { s: "odd", i: true, a: "Odd thing" }, " thing, with spaces and spans."] },
    { t: "p", c: ["It holds a^{2}+b^{2} and itself."] },
    { t: "li", c: ["One"], d: 1, n: 1 },
    { t: "li", c: ["Two"], d: 1, n: 2 },
    { t: "li", c: ["Two a"], d: 2 },
    { t: "li", c: [{ s: "Three", a: "Three" }], d: 1, n: 3 },
    { t: "quote", c: ["A quote."] },
    { t: "p", c: [{ s: "Term", b: true }] },
    { t: "p", c: ["Its meaning."] },
    { t: "h2", c: ["History"] },
    { t: "h3", c: ["Early"] },
    { t: "p", c: ["Long ago."] },
    { t: "h2", c: ["Legacy"] },
    { t: "p", c: ["After."] },
  ]);
});

test("the caps: 400 blocks, 20,000 characters, cut at a block", () => {
  const many = `<body>${Array.from({ length: 500 }, (_, i) => `<p>Paragraph ${i}.</p>`).join("")}</body>`;
  const a = wikiBlocks(many);
  assert.equal(a.blocks.length, 400);
  assert.equal(a.cut, true);
  const long = `<body>${Array.from({ length: 30 }, () => `<p>${"word ".repeat(200)}</p>`).join("")}</body>`;
  const b = wikiBlocks(long);
  assert.equal(b.cut, true);
  assert.equal(b.blocks.length, 20);
  assert.ok(blocksText(b.blocks).length <= 20_000);
  assert.equal(wikiBlocks(many, { maxBlocks: 3 }).blocks.length, 3);
});

test("de Kobold: the lead, headings, links (Warcraft III: Reign of Chaos is an article), no Literatur/Weblinks/Einzelnachweise", () => {
  const { blocks, cut } = wikiBlocks(html("de-kobold.html"), { self: "Kobold" });
  sane(blocks);
  assert.equal(cut, false);
  assert.deepEqual(blocks[0], { t: "p", c: [{ s: "Kobold", b: true }, " ist ein Begriff für ", { s: "Haus-", a: "Hausgeist" }, " und ", { s: "Naturgeister", a: "Naturgeist" }, "."] });
  const heads = blocks.filter((b) => b.t === "h2" || b.t === "h3").map(plain);
  assert.deepEqual(heads, ["Mythologische Figur", "Literarische Figur", "Trivia", "Film", "Videospiele", "Begriffliche Ableitungen"]);
  const ls = links(blocks);
  assert.ok(ls.includes("Pumuckl") && ls.includes("Warcraft III: Reign of Chaos") && ls.includes("Dungeons & Dragons"));
  // The disambiguation hint at the top and the pictures' captions are clutter.
  assert.ok(!blocksText(blocks).includes("Begriffsklärung"));
  assert.ok(!blocksText(blocks).includes("Zeichnung eines Kobolds"));
});

test("de Bank (Begriffsklärung) and en Mercury: disambiguation pages are lists of links", () => {
  const bank = wikiBlocks(html("de-bank.html"), { self: "Bank (Begriffsklärung)" }).blocks;
  sane(bank);
  assert.deepEqual(bank[1], { t: "li", c: [{ s: "Bank", a: "Bank" }, ", ein Geldinstitut"], d: 1 });
  assert.ok(bank.filter((b) => b.t === "li").length > 30);
  const mercury = wikiBlocks(html("en-mercury.html"), { self: "Mercury" }).blocks;
  sane(mercury);
  assert.deepEqual(mercury[1], { t: "li", c: [{ s: "Mercury (planet)", a: "Mercury (planet)" }, ", the closest planet to the Sun"], d: 1 });
  assert.ok(!mercury.some((b) => b.t === "h2" && plain(b) === "See also"));
});

test("en Beaver, de Donau: long articles cut at 20,000 characters; the taxobox, references, See also gone", () => {
  const beaver = wikiBlocks(html("en-beaver.html.gz"), { self: "Beaver" });
  sane(beaver.blocks);
  assert.equal(beaver.cut, true);
  assert.match(plain(beaver.blocks[0]!), /^Beavers \(genus Castor\) are large semiaquatic rodents of the Northern Hemisphere\./);
  assert.deepEqual(beaver.blocks[0]!.c.slice(0, 3), [{ s: "Beavers", b: true }, " (genus ", { s: "Castor", b: true, i: true }]);
  assert.ok(!/Scientific classification|Conservation status|For other uses/.test(blocksText(beaver.blocks)));
  assert.equal(plain(beaver.blocks[3]!), "Etymology");
  const donau = wikiBlocks(html("de-donau.html.gz"), { self: "Donau" });
  sane(donau.blocks);
  assert.equal(donau.cut, true);
  assert.match(plain(donau.blocks[0]!), /^Die Donau ist mit einem Abfluss \(MQ\) von rund 6855\sm³\/s/);
});

test("en Pythagorean theorem: formulas as their TeX, tables and references gone, links to itself are text", () => {
  const { blocks } = wikiBlocks(html("en-pythagorean.html.gz"), { self: "Pythagorean theorem" });
  sane(blocks);
  const all = blocksText(blocks);
  assert.ok(all.includes("a^2 + b^2 = c^2"), "the formula's TeX");
  assert.ok(!all.includes("displaystyle"));
  assert.ok(!links(blocks).includes("Pythagorean theorem"));
  assert.ok(links(blocks).includes("Euclidean geometry"));
});
