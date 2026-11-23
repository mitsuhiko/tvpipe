// @ts-check
/**
 * What Snug's phone says, in English and German.
 */

import { format } from "./i18n.js";

/** @param {"en" | "de"} lang */
export function strings(lang) {
  const f = format(lang);
  if (lang === "de") {
    return {
      ...f,
      otherLang: "English",
      connecting: "Verbinde …",
      reconnecting: "Verbindung weg, verbinde neu …",
      scanToJoin: "Scanne den Code auf dem Fernseher, um mitzuspielen.",
      joinTitle: "Mitspielen",
      yourName: "Dein Name",
      join: "Los",
      nameTaken: "Den Namen hat schon jemand.",
      pickAnother: "Nimm einen anderen Namen.",
      full: "Das Spiel ist voll.",
      closed: "Gerade kann niemand dazukommen.",
      badKey: "Der Link stimmt nicht. Scanne den Code noch einmal.",
      noRoom: "Dieses Spiel gibt es nicht mehr.",
      kicked: "Du wurdest aus dem Spiel genommen.",
      replaced: "Du spielst jetzt auf einem anderen Gerät.",
      roomClosed: "Das Spiel ist vorbei. Danke fürs Mitspielen!",
      youreIn: "Du bist dabei!",
      players: "Mitspieler",
      vip: "VIP",
      start: "Starten",
      playAgain: "Nochmal",
      /** @param {number} n */
      vipWait: (n) => f.p(n, { one: "Noch # Person, dann kannst du starten.", other: "Noch # Leute, dann kannst du starten." }),
      vipReady: "Alle da? Dann los!",
      waitVip: "Der VIP startet das Spiel.",
      settings: "Einstellungen",
      levelLabel: "Stufe",
      paceLabel: "Uhr",
      levels: { easy: "leicht", normal: "normal", hard: "schwer" },
      paces: { relaxed: "gemütlich", normal: "normal", rushed: "hektisch" },
      levelLine: {
        easy: "Kleine Teile, viele Lösungen, Prüfen so oft ihr wollt. Teile, die nirgends passen, werden grau.",
        normal: "Mittlere Teile, 3-mal Prüfen (jede volle Form bringt eins zurück). Teile, die nirgends passen, werden grau.",
        hard: "Große Teile, wenige Lösungen. Prüfen nur, wenn ihr es mit einer vollen Form verdient. Hochheben kostet 3 Sekunden.",
      },
      howTitle: "So geht's",
      how: [
        "Alle sehen dieselbe Form. Deine Teile sieht nur dein Handy.",
        "Zieh ein Teil auf die Form. Tippen dreht es, ⇋ spiegelt es.",
        "Tipp auf dein gelegtes Teil, um es zurückzuholen. Zieh es, um es zu verschieben.",
        "Berühr die Form, um allen ein Feld zu zeigen. Kurz tippen: Ping!",
        "Redet! Nicht jedes Teil wird gebraucht. „Prüfen“ sagt, ob es noch aufgehen kann.",
      ],
      waitNext: "Du bist bei der nächsten Form dabei. Schau solange auf den Fernseher!",
      lookTv: "Schau auf den Fernseher!",
      /** @param {number} n */
      shapeN: (n) => `Form ${n}`,
      /** @param {number} n */
      doneN: (n) => `${n} geschafft`,
      yourPieces: "Deine Teile",
      noPieces: "Keine Teile mehr. Zeig den anderen, wo es hakt!",
      flip: "Spiegeln",
      nofit: "passt nirgends",
      /** @param {string} name */
      quicker: (name) => `${name} war schneller!`,
      quickerYou: "Da liegt schon was.",
      noFit: "Das passt da nicht.",
      timeUp: "Die Zeit ist um!",
      /** @param {string} name @param {number} n */
      got: (name, n) => `${name} ist weg: ${f.p(n, { one: "ein Teil ist", other: "# Teile sind" })} jetzt deins.`,
      check: "Prüfen",
      /** @param {number} n */
      checkN: (n) => `Prüfen · ${n}`,
      noChecks: "Kein Prüfen mehr übrig.",
      noChecksHard: "Noch kein Prüfen: Füllt eine Form, dann bekommt ihr eins.",
      unsure: "Zu viele Möglichkeiten, das lässt sich noch nicht sagen. Nichts verbraucht.",
      /** @param {string} name @param {boolean} me */
      stuck: (name, me) => `${me ? "Geprüft" : `${name} hat geprüft`}: So geht es nicht mehr auf. Holt ein Teil zurück!`,
      /** @param {string} name @param {boolean} me */
      open: (name, me) => `${me ? "Geprüft" : `${name} hat geprüft`}: Das kann noch aufgehen!`,
      earned: "+1 Prüfen",
      costs: "−3 s",
      snug: "Kuschelig!",
      /** @param {number} s */
      back: (s) => `+${s} Sekunden`,
      timesUp: "Die Zeit ist um!",
      couldHave: "So hätte es gepasst",
      gameOver: "Geschafft!",
      /** @param {number} n */
      filled: (n) => f.p(n, { one: "# Form gefüllt", other: "# Formen gefüllt" }),
      noneFilled: "Keine Form gefüllt",
      /** @param {number} n */
      best: (n) => `Bestes heute: ${n}`,
      awards: { fit: "Passt perfekt", pointer: "Zeigefinger", thoughts: "Nochmal überlegt" },
      errors: /** @type {Record<string, string>} */ ({ "too-few": "Es fehlen noch Mitspieler.", running: "Das Spiel läuft schon.", "not-vip": "Das darf nur der VIP.", "not-now": "Gerade nicht.", "not-yours": "Das ist nicht dein Teil." }),
    };
  }
  return {
    ...f,
    otherLang: "Deutsch",
    connecting: "Connecting…",
    reconnecting: "Lost the connection, reconnecting…",
    scanToJoin: "Scan the code on the TV to play.",
    joinTitle: "Join the game",
    yourName: "Your name",
    join: "Join",
    nameTaken: "Someone has that name already.",
    pickAnother: "Pick another name.",
    full: "The game is full.",
    closed: "Nobody can join right now.",
    badKey: "That link is not right. Scan the code again.",
    noRoom: "That game is gone.",
    kicked: "You were taken out of the game.",
    replaced: "You're playing on another device now.",
    roomClosed: "The game is over. Thanks for playing!",
    youreIn: "You're in!",
    players: "Players",
    vip: "VIP",
    start: "Start",
    playAgain: "Play again",
    /** @param {number} n */
    vipWait: (n) => f.p(n, { one: "One more person and you can start.", other: "# more people and you can start." }),
    vipReady: "Everyone here? Let's go!",
    waitVip: "The VIP starts the game.",
    settings: "Settings",
    levelLabel: "Level",
    paceLabel: "Clock",
    levels: { easy: "easy", normal: "normal", hard: "hard" },
    paces: { relaxed: "relaxed", normal: "normal", rushed: "rushed" },
    levelLine: {
      easy: "Small pieces, many ways to fill a shape, check as often as you like. Pieces that fit nowhere turn grey.",
      normal: "Middle-sized pieces, 3 checks (every filled shape gives one back). Pieces that fit nowhere turn grey.",
      hard: "Big pieces, few ways. Checks only when a filled shape earns one. Lifting a piece costs 3 seconds.",
    },
    howTitle: "How to play",
    how: [
      "Everyone sees the same shape. Only your phone sees your pieces.",
      "Drag a piece onto the shape. Tap it to turn it, ⇋ flips it.",
      "Tap your placed piece to take it back. Drag it to move it.",
      "Touch the shape to show everyone a cell. A quick tap pings!",
      "Talk! Not every piece is needed. Check tells you whether it can still work out.",
    ],
    waitNext: "You're in from the next shape. Watch the TV meanwhile!",
    lookTv: "Look at the TV!",
    /** @param {number} n */
    shapeN: (n) => `Shape ${n}`,
    /** @param {number} n */
    doneN: (n) => `${n} done`,
    yourPieces: "Your pieces",
    noPieces: "No pieces left. Show the others where it's stuck!",
    flip: "Flip",
    nofit: "fits nowhere",
    /** @param {string} name */
    quicker: (name) => `${name} was quicker!`,
    quickerYou: "Something's there already.",
    noFit: "That doesn't fit there.",
    timeUp: "Time's up!",
    /** @param {string} name @param {number} n */
    got: (name, n) => `${name} is away: ${f.p(n, { one: "a piece is", other: "# pieces are" })} yours now.`,
    check: "Check",
    /** @param {number} n */
    checkN: (n) => `Check · ${n}`,
    noChecks: "No checks left.",
    noChecksHard: "No checks yet: fill a shape to earn one.",
    unsure: "Too many ways to tell yet. Nothing used up.",
    /** @param {string} name @param {boolean} me */
    stuck: (name, me) => `${me ? "You checked" : `${name} checked`}: it can't work out like this. Take a piece back!`,
    /** @param {string} name @param {boolean} me */
    open: (name, me) => `${me ? "You checked" : `${name} checked`}: it can still work out!`,
    earned: "+1 check",
    costs: "−3 s",
    snug: "Snug!",
    /** @param {number} s */
    back: (s) => `+${s} seconds`,
    timesUp: "Time's up!",
    couldHave: "It would have gone like this",
    gameOver: "That's a wrap!",
    /** @param {number} n */
    filled: (n) => f.p(n, { one: "# shape filled", other: "# shapes filled" }),
    noneFilled: "No shape filled",
    /** @param {number} n */
    best: (n) => `Best today: ${n}`,
    awards: { fit: "Snuggest fit", pointer: "Pointer", thoughts: "Second thoughts" },
    errors: /** @type {Record<string, string>} */ ({ "too-few": "Not enough players yet.", running: "The game is on.", "not-vip": "Only the VIP can do that.", "not-now": "Not now.", "not-yours": "That's not your piece." }),
  };
}
