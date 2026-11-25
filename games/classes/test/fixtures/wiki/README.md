# Recorded Wikipedia responses

Real responses of en.wikipedia.org and de.wikipedia.org, recorded once
with `curl` (November 2026) for `test/wiki.test.ts` and
`test/wikitext.test.ts`; the tests never touch the network. The texts
are Wikipedia's, under CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/),
by the articles' authors (each article's history on Wikipedia).

| file | request |
|---|---|
| `q-*.json` | `w/api.php?action=query&format=json&formatversion=2&redirects=1&prop=pageprops\|description\|pageimages&piprop=thumbnail&pithumbsize=640&ppprop=disambiguation&titles=…` (Beaver, Beavers (a redirect), Mercury (disambiguation), Pythagorean theorem, big furry dam builder (missing), Kobold, Pumuckl (a redirect to a section), Donau, Bank (Begriffsklärung)) |
| `*.html`, `*.html.gz` | `api/rest_v1/page/html/…` (Parsoid HTML): en Beaver, Mercury, Pythagorean theorem; de Kobold, Donau, Bank (Begriffsklärung); the large ones gzipped |
| `s-en-dam.json`, `en-search-*.json`, `de-search-*.json` | `w/api.php?action=query&list=search&srsearch=…&srlimit=5` (`de-search-busy.json`: the search answered "too busy") |
