// @ts-check
/**
 * What the phone page says, per language (the room's, `room.lang`, the
 * same on every phone; before joining, the browser's). German is written for German speakers, not
 * translated word for word: "du", „quotes“, "Platz 3 von 8".
 */

import { format } from "./i18n.js";

/** @param {import("./i18n.js").Format} f */
const en = (f) => ({
  connecting: "Connecting…",
  scanToJoin: "Scan the code on the TV to join.",
  joinTitle: "Join the game",
  yourName: "Your name",
  join: "Join",
  /** This language's own name (the VIP's language buttons). */
  langName: "English",
  /** The header's sound switch. */
  soundOn: "Sound on",
  soundOff: "Sound off",
  // Joining and leaving.
  nameTaken: "Someone already has that name. If that is you on another phone, close the game there first.",
  pickAnother: "Pick another name.",
  full: "The game is full.",
  closed: "A game is running and it's closed to newcomers. Ask the VIP to let you in at the next game.",
  badKey: "This link does not work any more. Scan the code on the TV again.",
  noRoom: "That game is over. Scan the code on the TV again.",
  reconnecting: "Reconnecting…",
  kicked: "You were removed from the game.",
  replaced: "You opened the game somewhere else.",
  roomClosed: "The game is over. Thanks for playing!",
  // What the host refused (PartyError codes).
  /** @type {Record<string, string>} */
  errors: {
    "too-few": "Not enough players yet.",
    "not-vip": "Only the VIP can do that.",
    running: "Not during a game.",
    "no-player": "No such player.",
    empty: "Write a title.",
    truth: "That's the real title! Write a lie instead.",
    refused: "Try another one.",
    "bad-vote": "Pick one of the titles.",
    "bad-drawing": "That drawing cannot be sent.",
    "color-taken": "Someone has that colour: pick a free one.",
    "bad-color": "Pick one of the colours.",
    "no-adult": "There are no adult prompts in this language.",
  },
  // Header and scores.
  /** @param {number} r @param {number} of */
  rank: (r, of) => `#${f.n(r)} of ${f.n(of)}`,
  /** @param {number} r */
  rankOnly: (r) => `#${f.n(r)}`,
  /** In the header (narrow). @param {number} r @param {number} of */
  rankShort: (r, of) => `#${f.n(r)} of ${f.n(of)}`,
  /** @param {number} n */
  points: (n) => f.p(n, { one: "point", other: "points" }),
  /** @param {number} r */
  roundDone: (r) => `Round ${f.n(r)} done`,
  lookAtTv: "Look at the TV!",
  // Waiting.
  drawDone: "Nice! Waiting for the others to finish…",
  waitDrawing: "You're in! You vote from the next drawing on. Watch the TV meanwhile.",
  waitGame: "You're in! This game is about to end: you play the next one. Watch the TV meanwhile.",
  waitRound: "You're in! You join the game at the next round. Watch the TV meanwhile.",
  artist: "That's your drawing! Watch the others try to name it.",
  /** @param {string} lie @param {boolean} early */
  lieDone: (lie, early) => `Your lie: “${lie}”. ${early ? "That drawing is next on the TV." : "Waiting for the other liars…"}`,
  voteDone: "Vote counted. Look at the TV!",
  // Watching.
  galleryTitle: "Look at the TV: the gallery!",
  /** @param {number} page */
  galleryMine: (page) => `Your drawing is on page ${f.n(page)}.`,
  galleryOthers: "The other drawings of this round.",
  /** @param {string | undefined} name */
  drawingOf: (name) => (name ? `${name}'s drawing` : "Someone's drawing"),
  notLying: "You're not lying on this one. The liars are writing; you vote next.",
  /** @param {number} count @param {number} seen */
  artistResult: (count, seen) => `${f.n(count)} of ${f.n(seen)} found your drawing.`,
  found: "You found the real title!",
  /** @param {string[]} by */
  fellFor: (by) => `You fell for ${f.list(by)}'s lie.`,
  fellForOurs: "You fell for our lie.",
  /** @param {string} lie @param {number} n */
  lieFooled: (lie, n) => `Your lie “${lie}” fooled ${n === 0 ? "nobody" : f.p(n, { one: "# player", other: "# players" })}.`,
  // Latecomers.
  latecomers: "Latecomers",
  /** @type {Record<string, [string, string]>} the button, the line */
  late: {
    wait: ["Next round", "Latecomers join at the next round."],
    open: ["Anytime", "Latecomers join at the next drawing."],
    closed: ["Closed", "Nobody joins once the game is on."],
  },
  // The lobby and the end.
  youreIn: "You're in!",
  players: "Players",
  everybodyIn: "Everybody's in!",
  remove: "remove",
  vip: "★ VIP",
  /** @param {number} n */
  vipWait: (n) => `You're the VIP. Start when ${f.n(n)} more joined.`,
  vipReady: "You're the VIP: start when everybody's in.",
  waitVip: "Waiting for the VIP to start the game.",
  playAgain: "Play again",
  won: "You won!",
  gameOver: "Game over",
  // Drawing.
  draw: "Draw",
  done: "Done!",
  // Animations: two frames.
  animate: "Animate (2 frames)",
  /** @param {number} i */
  frameN: (i) => `Frame ${f.n(i)}`,
  copyFrame: "copy the other frame here",
  play: "play",
  stop: "stop",
  /** @param {number} i */
  frameEmpty: (i) => `Frame ${f.n(i)} is empty. Send?`,
  /** @param {number} i */
  colour: (i) => `colour ${f.n(i)}`,
  sizes: ["thin", "medium", "thick"],
  clear: "clear",
  clearSure: "Clear?",
  undo: "undo",
  // Your colour and the rules.
  yourColour: "Your colour",
  yourPens: "Your pens:",
  colourNames: ["red", "orange", "yellow", "lime", "green", "teal", "sky blue", "blue", "violet", "pink"],
  rules: "Rules",
  /** @param {number} n */
  roundsLine: (n) => f.p(n, { one: "One round.", other: "# rounds." }),
  /** @type {Record<string, string>} the room's language, by language */
  langLine: {
    en: "Prompts in English, on the TV and every phone.",
    de: "Prompts in German, on the TV and every phone.",
  },
  /** @type {Record<string, [string, string]>} the button, the line */
  timers: {
    fast: ["Fast", "Fast: less time to draw, lie and vote."],
    normal: ["Normal", "Normal time to draw, lie and vote."],
    slow: ["Slow", "Slow: more time to draw, lie and vote."],
  },
  /** @type {Record<"animate" | "undo" | "colorMode" | "adult", [[string, string], [string, string]]>} off, on: the button, the line */
  settings: {
    animate: [
      ["Still", "Everybody draws one picture."],
      ["Animated", "Animated: everybody draws two frames that flip back and forth."],
    ],
    undo: [
      ["No undo", "No undo: every stroke counts."],
      ["Undo", "Undo is on: take back the last stroke."],
    ],
    colorMode: [
      ["2 shades", "You draw in two shades of your colour."],
      ["4 colours", "Colour mode: black and four colours, tinted with yours."],
    ],
    adult: [
      ["Family", "Family-friendly prompts."],
      ["Adult 18+", "Adult prompts (18+)."],
    ],
  },
  noAdult: "Family-friendly prompts (no adult ones in this language).",
  // Lies and votes.
  fakeTitle: "Fake a title",
  liePlaceholder: "a convincing title",
  send: "Send",
  /** @param {string | undefined} name @param {number} liars */
  liarFor: (name, liars) => `You're a liar for ${name ? `${name}'s` : "this"} drawing${liars > 1 ? ` (one of ${f.n(liars)})` : ""}.`,
  firstAfterGallery: "It's the first on the TV after the gallery.",
  nextSitOut: "It's next on the TV: you sit this vote out.",
  whichReal: "Which is the real title?",
});

/** @type {typeof en} */
const de = (f) => ({
  connecting: "Verbinde…",
  scanToJoin: "Scann den Code am Fernseher, um mitzuspielen.",
  joinTitle: "Mach mit!",
  yourName: "Dein Name",
  join: "Mitspielen",
  langName: "Deutsch",
  soundOn: "Ton an",
  soundOff: "Ton aus",
  nameTaken: "Den Namen hat schon jemand. Bist du das auf einem anderen Handy? Dann schließ das Spiel dort zuerst.",
  pickAnother: "Nimm einen anderen Namen.",
  full: "Das Spiel ist voll.",
  closed: "Hier läuft gerade ein Spiel, und Neue kommen nicht mehr rein. Frag den VIP, ob du beim nächsten Spiel mitmachen kannst.",
  badKey: "Dieser Link geht nicht mehr. Scann den Code am Fernseher noch mal.",
  noRoom: "Dieses Spiel ist vorbei. Scann den Code am Fernseher noch mal.",
  reconnecting: "Verbinde neu…",
  kicked: "Du wurdest aus dem Spiel genommen.",
  replaced: "Du hast das Spiel woanders geöffnet.",
  roomClosed: "Das Spiel ist vorbei. Danke fürs Mitspielen!",
  errors: {
    "too-few": "Noch nicht genug Leute.",
    "not-vip": "Das darf nur der VIP.",
    running: "Nicht während des Spiels.",
    "no-player": "Diesen Mitspieler gibt es nicht.",
    empty: "Schreib einen Titel.",
    truth: "Das ist der echte Titel! Denk dir lieber eine Lüge aus.",
    refused: "Versuch einen anderen.",
    "bad-vote": "Wähl einen der Titel.",
    "bad-drawing": "Diese Zeichnung lässt sich nicht senden.",
    "color-taken": "Die Farbe hat schon jemand: Nimm eine freie.",
    "bad-color": "Wähl eine der Farben.",
    "no-adult": "In dieser Sprache gibt es keine Begriffe ab 18.",
  },
  rank: (r, of) => `Platz ${f.n(r)} von ${f.n(of)}`,
  rankOnly: (r) => `Platz ${f.n(r)}`,
  rankShort: (r, of) => `${f.n(r)}. von ${f.n(of)}`,
  points: (n) => f.p(n, { one: "Punkt", other: "Punkte" }),
  roundDone: (r) => `Runde ${f.n(r)} vorbei`,
  lookAtTv: "Schau auf den Fernseher!",
  drawDone: "Super! Jetzt warten wir auf die anderen…",
  waitDrawing: "Du bist dabei! Ab der nächsten Zeichnung stimmst du mit ab. Schau so lange auf den Fernseher.",
  waitGame: "Du bist dabei! Dieses Spiel ist gleich vorbei, beim nächsten spielst du mit. Schau so lange auf den Fernseher.",
  waitRound: "Du bist dabei! Ab der nächsten Runde spielst du mit. Schau so lange auf den Fernseher.",
  artist: "Das ist deine Zeichnung! Mal sehen, ob die anderen draufkommen.",
  lieDone: (lie, early) => `Deine Lüge: „${lie}“. ${early ? "Die Zeichnung kommt als Nächstes auf den Fernseher." : "Wir warten auf die anderen Lügner…"}`,
  voteDone: "Stimme gezählt. Schau auf den Fernseher!",
  galleryTitle: "Schau auf den Fernseher: die Galerie!",
  galleryMine: (page) => `Deine Zeichnung ist auf Seite ${f.n(page)}.`,
  galleryOthers: "Die anderen Zeichnungen dieser Runde.",
  drawingOf: (name) => (name ? `Die Zeichnung von ${name}` : "Eine Zeichnung"),
  notLying: "Diesmal lügst du nicht mit. Die Lügner schreiben, danach stimmst du ab.",
  artistResult: (count, seen) => f.p(count, { one: `# von ${f.n(seen)} hat deine Zeichnung erkannt.`, other: `# von ${f.n(seen)} haben deine Zeichnung erkannt.` }),
  found: "Du hast den echten Titel gefunden!",
  fellFor: (by) => `Du bist auf die Lüge von ${f.list(by)} reingefallen.`,
  fellForOurs: "Du bist auf unsere Lüge reingefallen.",
  lieFooled: (lie, n) => `Deine Lüge „${lie}“ hat ${n === 0 ? "niemanden" : f.p(n, { one: "# Mitspieler", other: "# Mitspieler" })} reingelegt.`,
  latecomers: "Nachzügler",
  late: {
    wait: ["Nächste Runde", "Nachzügler steigen in der nächsten Runde ein."],
    open: ["Jederzeit", "Nachzügler steigen bei der nächsten Zeichnung ein."],
    closed: ["Geschlossen", "Sobald das Spiel läuft, kommt keiner mehr dazu."],
  },
  youreIn: "Du bist dabei!",
  players: "Mitspieler",
  everybodyIn: "Alle da!",
  remove: "entfernen",
  vip: "★ VIP",
  vipWait: (n) => f.p(n, { one: "Du bist VIP. Starte, sobald noch # dazugekommen ist.", other: "Du bist VIP. Starte, sobald noch # dazugekommen sind." }),
  vipReady: "Du bist VIP: Starte, wenn alle da sind.",
  waitVip: "Warte, bis der VIP das Spiel startet.",
  playAgain: "Noch mal!",
  won: "Gewonnen!",
  gameOver: "Spiel vorbei",
  draw: "Zeichne",
  done: "Fertig!",
  animate: "Animiere (2 Bilder)",
  frameN: (i) => `Bild ${f.n(i)}`,
  copyFrame: "das andere Bild hierher kopieren",
  play: "abspielen",
  stop: "anhalten",
  frameEmpty: (i) => `Bild ${f.n(i)} ist leer. Senden?`,
  colour: (i) => `Farbe ${f.n(i)}`,
  sizes: ["dünn", "mittel", "dick"],
  clear: "löschen",
  clearSure: "Löschen?",
  undo: "rückgängig",
  yourColour: "Deine Farbe",
  yourPens: "Deine Stifte:",
  colourNames: ["Rot", "Orange", "Gelb", "Hellgrün", "Grün", "Türkis", "Himmelblau", "Blau", "Violett", "Pink"],
  rules: "Regeln",
  roundsLine: (n) => f.p(n, { one: "Eine Runde.", other: "# Runden." }),
  langLine: {
    en: "Begriffe auf Englisch, auf dem Fernseher und jedem Handy.",
    de: "Begriffe auf Deutsch, auf dem Fernseher und jedem Handy.",
  },
  timers: {
    fast: ["Schnell", "Schnell: weniger Zeit zum Zeichnen, Lügen und Abstimmen."],
    normal: ["Normal", "Normale Zeit zum Zeichnen, Lügen und Abstimmen."],
    slow: ["Langsam", "Langsam: mehr Zeit zum Zeichnen, Lügen und Abstimmen."],
  },
  settings: {
    animate: [
      ["Standbild", "Alle zeichnen ein Bild."],
      ["Animiert", "Animiert: Alle zeichnen zwei Bilder, die hin und her wechseln."],
    ],
    undo: [
      ["Kein Zurück", "Kein Rückgängig: Jeder Strich zählt."],
      ["Rückgängig", "Rückgängig ist an: Der letzte Strich lässt sich zurücknehmen."],
    ],
    colorMode: [
      ["2 Töne", "Du zeichnest in zwei Tönen deiner Farbe."],
      ["4 Farben", "Farbmodus: Schwarz und vier Farben, in deine getönt."],
    ],
    adult: [
      ["Familie", "Familientaugliche Begriffe."],
      ["Ab 18", "Begriffe für Erwachsene (ab 18)."],
    ],
  },
  noAdult: "Familientaugliche Begriffe (ab 18 gibt es in dieser Sprache nicht).",
  fakeTitle: "Erfinde einen Titel",
  liePlaceholder: "ein glaubwürdiger titel",
  send: "Senden",
  liarFor: (name, liars) => `Du lügst für ${name ? `die Zeichnung von ${name}` : "diese Zeichnung"}${liars > 1 ? ` (einer von ${f.n(liars)} Lügnern)` : ""}.`,
  firstAfterGallery: "Sie kommt nach der Galerie als Erste auf den Fernseher.",
  nextSitOut: "Sie kommt als Nächste auf den Fernseher: Bei dieser Abstimmung setzt du aus.",
  whichReal: "Welcher Titel ist echt?",
});

/** @typedef {ReturnType<typeof en>} Strings */

/**
 * The phone's strings in a language.
 * @param {import("./i18n.js").Lang} lang
 * @returns {Strings}
 */
export function strings(lang) {
  return (lang === "de" ? de : en)(format(lang));
}
