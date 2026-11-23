# Credits

Worldquiz's data (`data/countries.json`, `data/shapes.json`,
`data/flags/`) is made by `scripts/data.ts` from the sources below, with
the decisions in `data/decisions.txt`. We thank everyone who made and
keeps them.

- **Natural Earth** — the land and who borders whom: admin 0 countries,
  1:50m and 1:10m, version 5.1.2, https://www.naturalearthdata.com/ (via
  https://github.com/nvkelso/natural-earth-vector). In the public domain;
  thank you, Natural Earth.

- **Wikidata** — names, aliases, capitals, the flags' files, the highest
  points' German names. https://www.wikidata.org/, released under
  [CC0](https://creativecommons.org/publicdomain/zero/1.0/).

- **The World Bank** — population, area and GDP per person: World
  Development Indicators (SP.POP.TOTL, AG.SRF.TOTL.K2, NY.GDP.PCAP.CD),
  https://data.worldbank.org/, licensed under
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Countries are
  sums of the World Bank's entries for their parts (Denmark with Greenland
  and the Faroe Islands, and so on); some areas are replaced by
  Wikipedia's (see `data/decisions.txt`).

- **The International Monetary Fund** — GDP per person and population
  where the World Bank has none or none recent (Taiwan, South Sudan,
  Yemen): World Economic Outlook via the IMF DataMapper,
  https://www.imf.org/external/datamapper/. Source: International
  Monetary Fund.

- **The United Nations** — GDP per person of North Korea and Eritrea:
  UN Statistical Yearbook (UNSD, National Accounts Main Aggregates),
  https://data.un.org/; Western Sahara's population: World Population
  Prospects 2024.

- **Wikipedia** — facts checked against, and the highest points taken
  from, these lists (English Wikipedia, CC BY-SA 4.0; only facts are
  used, no text):
  [List of countries and territories by number of land borders](https://en.wikipedia.org/wiki/List_of_countries_and_territories_by_number_of_land_borders),
  [List of elevation extremes by country](https://en.wikipedia.org/wiki/List_of_elevation_extremes_by_country),
  [List of countries and dependencies by area](https://en.wikipedia.org/wiki/List_of_countries_and_dependencies_by_area).
  How well known a country is comes from the Wikimedia pageviews API
  (English and German Wikipedia).

- **Wikimedia Commons** — the flags, as SVG, https://commons.wikimedia.org/.
  All are in the public domain except the flag of Oman:
  [File:Flag of Oman.svg](https://commons.wikimedia.org/wiki/File:Flag_of_Oman.svg),
  by the contributors named in its file history, licensed under the
  Oman Open Government Licence (OGL-om 1.0).
