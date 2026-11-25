# Classes: die deutsche Spaltenliste

Wie `data/columns.de.txt` entstand, für alle, die sie erweitern. Das Format
und die Regeln zum Austeilen stehen in docs/classes-design.md §4; geprüft
wird mit `npm run columns`. Die Liste ist für Deutsch geschrieben, nicht
aus `data/columns.txt` übersetzt (die beiden entstanden unabhängig).

## Woraus sie besteht

151 Spalten, 74 davon lustig (`funny` oder in break, trip, register,
detention), 12 nur für `party`.

| Fach | Spalten | davon lustig |
|---|---|---|
| geo | 12 | 3 |
| bio | 13 | 2 |
| home | 13 | 2 |
| music | 10 | 3 |
| media | 13 | 3 |
| sport | 10 | 3 |
| social | 13 | 3 |
| lang | 13 | 1 |
| break | 20 | 20 |
| trip | 10 | 10 |
| register | 13 | 13 (eine `party`) |
| detention | 11 | 11 (alle `party`) |

## Wissensspalten

- **Die Klassiker vom Zettel zuerst:** Stadt, Land, Fluss (classic:1–3),
  Name (hier „Vorname“), Tier, Pflanze, Beruf, Promi, Marke, Automarke,
  Getränk, Körperteil, Sportart, Märchenfigur, Band oder Musikstar. Dazu
  schmalere (Käsesorte, Pilz, Dinosaurier, Skiort, Komponist oder
  Komponistin), die die 20 Punkte möglich machen.
- **D-A-CH gemischt, nicht Deutschland-Insider:** Bundesland oder Kanton,
  Skiort, „Wort aus Österreich oder der Schweiz“, Gerichte von Gröstl bis
  Zürcher Geschnetzeltes, Rivella und Almdudler, Kronen Zeitung und NZZ,
  Jass und Schnapsen, Ochs am Berg und Tempelhüpfen. In den Beispielen
  stehen Austriazismen und Helvetismen gleichberechtigt (Semmel, Weckerl,
  Gipfeli; Eierschwammerl; Penalty, Corner, Offside).
- **Beispiele sind Belege:** 2–3 pro Buchstabe, jedes in Wikipedia oder
  im Duden unter diesem Namen. Wo ich unsicher war, fehlt der Buchstabe
  lieber (z. B. kein W bei Land, kein I bei Berg). Titel mit Artikel
  stehen unter dem Buchstaben nach dem Artikel (Der Kommissar unter K,
  Die unendliche Geschichte unter U), weil das Spiel den Artikel
  abschneidet (§5.2).
- **Ohne gegenderte Überschriften:** „Promi“, „Sportstar“, „Band oder
  Musikstar“, „Komponist oder Komponistin“, „Superheld oder
  Superheldin“; bei Beruf mischen die Beispiele beide Formen.
- **Regel-Spalten in Deutsch:** beginnt und endet mit dem Buchstaben,
  Doppelbuchstabe, zwei Wörter mit dem Buchstaben, langes Wort ab 12
  Buchstaben (Komposita: Donaudampfschifffahrt, Überraschungsei).

## Lustige Spalten

- Pause (break) trägt den Witz: Ausrede für fehlende Hausaufgaben,
  Nutzlose Superkraft, Neues IKEA-Produkt (Ärgerlig, Fältteil), Was Oma
  immer sagt, Titel deiner Autobiografie, Was Lehrkräfte heimlich denken.
- Klassenfahrt und Klassenbuch für die Runde: der Koffer, der Schlafsaal,
  das Essen; „Was {player} zu oft sagt“ (Oida, Gell?, Krass). Klassenbuch
  neckt, nie über Körper, Aussehen, Geld, Krankheit; die eine frechere
  Spalte („Was {player} nie zugeben würde“) ist `party`.
- Auch die Wissensfächer haben je ein bis drei lustige `any`-Spalten
  (Kreuzung aus zwei Tieren, Schlechter Titel für einen Krimi, Neue
  olympische Disziplin), damit `silly` mehr als break/trip/register hat.
- Alle lustigen Spalten haben Beispiele für alle 23 üblichen Buchstaben
  (die Bots antworten daraus), höchstens 40 Zeichen, ohne Komma.
- Nachsitzen (detention) ist für Erwachsene: Schimpfwort, Mittel gegen
  Kater, Schlechter Anmachspruch, Cocktail (eine Wissensspalte).
