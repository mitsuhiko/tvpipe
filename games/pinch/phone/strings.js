// @ts-check
/**
 * The phone's own words (joining, the lobby, the cards between heists,
 * the heist's chrome). Everything the game itself says (buttons,
 * refusals, role cards, outcomes, awards, how to play, the ticker) comes
 * from game/words.ts; these are the page's frame around it. English and
 * German, in the same voice (docs/pinch-design.md §12).
 */

/** @typedef {"en" | "de"} Lang */

/** A language tag as one of the two: German for `de…`, else English. @param {unknown} tag @returns {Lang} */
export function pickLang(tag) {
  return typeof tag === "string" && /^de\b/i.test(tag) ? "de" : "en";
}

/** The browser's language. */
export function browserLang() {
  return pickLang(globalThis.navigator?.languages?.[0] ?? globalThis.navigator?.language);
}

const EN = {
  connecting: "Connecting…",
  reconnecting: "Reconnecting…",
  scanToJoin: "Scan the code on the TV to join.",
  joinTitle: "Who goes there?",
  yourName: "Your name",
  join: "Join",
  nameTaken: "That name is taken. Another one?",
  pickAnother: "Pick another name.",
  full: "The house is full.",
  closed: "A heist is on. Wait for the next game.",
  badKey: "That link is wrong. Scan the code again.",
  noRoom: "No game here. Scan the code on the TV.",
  kicked: "You were shown the door.",
  replaced: "You carried on on another phone.",
  roomClosed: "The game is over. Good night.",
  youreIn: "You're in.",
  players: "Tonight's suspects",
  vip: "VIP",
  start: "Start the night",
  vipWait: (/** @type {number} */ n) => (n === 1 ? "One more player and we're off." : `${n} more players and we're off.`),
  vipReady: "Everyone here? Start when you like.",
  waitVip: "The VIP starts the game.",
  settings: "The night",
  length: "Heist",
  rounds: "Rounds",
  roundsOnce: "Everyone once",
  roundsTwice: "Everyone twice",
  late: "Latecomers",
  lateWait: "Join next round",
  lateClosed: "Doors shut",
  language: "Language",
  howTitle: "How to play",
  controls: [
    "Tap the floor to walk there. The button at the bottom does what can be done here.",
    "Security: switch the flashlight on, drag from yourself to aim, tap the thief to hold them. Long press for marks.",
    "Thief: stay in the dark, take what you can carry, run for the car. Firecrackers make friends elsewhere.",
  ],
  waitNext: "You're in from the next round. Watch the TV and pick a favourite.",
  lookTv: "Eyes on the TV.",
  startsIn: "Starts in",
  yourStart: "You start here",
  carHere: "Your car",
  heistOn: "The heist is on",
  layer: "TV",
  layerTitle: "The TV's layer: the ink, marks and facts",
  fireArmed: "Tap where it should go",
  arrow: "Now drag the arrow",
  removeMark: "Remove",
  holding: (/** @type {string} */ name) => `You hold ${name}`,
  heldBy: (/** @type {string} */ name) => `${name} has you`,
  held: (/** @type {string} */ name) => `${name} is held!`,
  slots: "Sack",
  marksLeft: "Marks",
  firecrackers: "Firecrackers",
  haulRound: "Tonight's take",
  rewards: "Rewards",
  totals: "Totals",
  nextUp: (/** @type {string} */ name) => `Next up as the thief: ${name}`,
  tapeOn: "The tape is rolling on the TV.",
  skip: "Skip",
  playAgain: "Play again",
  theEnd: "The end",
  waitHost: "The VIP decides what happens next.",
  errors: /** @type {Record<string, string>} */ ({ "not-vip": "Only the VIP can do that.", "too-few": "Not enough players yet.", running: "A game is on.", "not-now": "Not now." }),
  /** The map's printed words (draw.js MapWords) not in words.ts. */
  mapWords: { glass: "CRASH", lamp: "SMASH", firecracker: "BANG", alarm: "ALARM", ping: "GPS PING", pinched: "PINCHED", gotAway: "GOT AWAY", static: "STATIC", camera: "CAMERA" },
};

/** @type {typeof EN} */
const DE = {
  connecting: "Verbinde…",
  reconnecting: "Verbindung weg, gleich wieder da…",
  scanToJoin: "Scanne den Code auf dem Fernseher.",
  joinTitle: "Wer da?",
  yourName: "Dein Name",
  join: "Rein da",
  nameTaken: "Den Namen gibt’s schon. Ein anderer?",
  pickAnother: "Nimm einen anderen Namen.",
  full: "Das Haus ist voll.",
  closed: "Hier läuft gerade ein Coup. Wart aufs nächste Spiel.",
  badKey: "Der Link stimmt nicht. Scanne den Code noch mal.",
  noRoom: "Hier läuft kein Spiel. Scanne den Code auf dem Fernseher.",
  kicked: "Man hat dich vor die Tür gesetzt.",
  replaced: "Du spielst jetzt auf einem anderen Handy weiter.",
  roomClosed: "Das Spiel ist aus. Gute Nacht.",
  youreIn: "Du bist dabei.",
  players: "Die Verdächtigen",
  vip: "VIP",
  start: "Die Nacht beginnt",
  vipWait: (/** @type {number} */ n) => (n === 1 ? "Noch einer, dann geht’s los." : `Noch ${n}, dann geht’s los.`),
  vipReady: "Alle da? Starte, wann du willst.",
  waitVip: "Der VIP startet das Spiel.",
  settings: "Die Nacht",
  length: "Coup",
  rounds: "Runden",
  roundsOnce: "Jeder einmal",
  roundsTwice: "Jeder zweimal",
  late: "Nachzügler",
  lateWait: "Nächste Runde",
  lateClosed: "Tür zu",
  language: "Sprache",
  howTitle: "So geht’s",
  controls: [
    "Tipp auf den Boden, um hinzulaufen. Der Knopf unten macht, was hier geht.",
    "Wache: Funzel an, von dir aus ziehen zum Leuchten, Langfinger antippen zum Festhalten. Lange drücken für Markierungen.",
    "Langfinger: bleib im Dunkeln, nimm, was du tragen kannst, ab zum Wagen. Knallfrösche lenken ab.",
  ],
  waitNext: "Ab der nächsten Runde bist du dabei. Bis dahin: Fernseher gucken.",
  lookTv: "Augen auf den Fernseher.",
  startsIn: "Los in",
  yourStart: "Hier fängst du an",
  carHere: "Dein Wagen",
  heistOn: "Der Coup läuft",
  layer: "TV",
  layerTitle: "Was der Fernseher zeigt: Tinte, Markierungen, Meldungen",
  fireArmed: "Tipp, wohin er fliegen soll",
  arrow: "Jetzt den Pfeil ziehen",
  removeMark: "Wegwischen",
  holding: (/** @type {string} */ name) => `Du hältst ${name} fest`,
  heldBy: (/** @type {string} */ name) => `${name} hat dich`,
  held: (/** @type {string} */ name) => `${name} ist gestellt!`,
  slots: "Sack",
  marksLeft: "Marken",
  firecrackers: "Knallfrösche",
  haulRound: "Die Beute heute",
  rewards: "Belohnungen",
  totals: "Gesamt",
  nextUp: (/** @type {string} */ name) => `Als Nächstes klaut: ${name}`,
  tapeOn: "Auf dem Fernseher läuft das Band.",
  skip: "Weiter",
  playAgain: "Noch eine Nacht",
  theEnd: "Ende",
  waitHost: "Der VIP entscheidet, wie’s weitergeht.",
  errors: { "not-vip": "Das darf nur der VIP.", "too-few": "Noch zu wenige Leute.", running: "Es läuft schon ein Spiel.", "not-now": "Nicht jetzt." },
  mapWords: { glass: "KLIRR", lamp: "PLOPP", firecracker: "PENG", alarm: "ALARM", ping: "GPS-PING", pinched: "GESCHNAPPT", gotAway: "ENTKOMMEN", static: "RAUSCHEN", camera: "KAMERA" },
};

/** The phone's words in a language. @param {Lang} lang */
export function strings(lang) {
  return lang === "de" ? DE : EN;
}

/** @typedef {typeof EN} Strings */
