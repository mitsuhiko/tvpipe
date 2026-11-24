// @ts-check
/**
 * What Worldquiz's phone page says, in English and German: the room's
 * language (the join form, before there is a room, the player's pick or
 * the browser's). The cards' own words (fact labels, numbers) are in
 * `cards.js`.
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
      scanToJoin: "Scanne den QR-Code auf dem Fernseher, um mitzuspielen.",
      joinTitle: "Wer bist du?",
      yourName: "Dein Name",
      join: "Mitspielen",
      nameTaken: "Den Namen gibt es schon. Nimm einen anderen.",
      pickAnother: "Nimm einen anderen Namen.",
      full: "Das Spiel ist voll.",
      closed: "Gerade kommt niemand Neues dazu. Gleich nochmal versuchen.",
      badKey: "Dieser Link stimmt nicht mehr. Scanne den Code auf dem Fernseher.",
      noRoom: "Dieses Spiel gibt es nicht mehr.",
      reconnecting: "Verbindung weg. Verbinde neu …",
      kicked: "Du wurdest aus dem Spiel genommen.",
      replaced: "Du spielst jetzt auf einem anderen Gerät.",
      roomClosed: "Das Spiel ist vorbei. Danke fürs Mitspielen!",
      youreIn: "Du bist dabei!",
      travellers: "Die Reisenden",
      vip: "VIP",
      start: "Abflug!",
      /** @param {number} k */
      vipWait: (k) => f.p(k, { one: "Noch # Person fehlt.", other: "Noch # Leute fehlen." }),
      vipReady: "Alle an Bord? Dann los.",
      waitVip: "Der VIP startet das Spiel.",
      settings: "Einstellungen",
      roundsLabel: "Runden",
      modeLabel: "Spiel",
      modes: { cards: "Mit Karten", quiz: "Nur Fragen" },
      modeLine: { cards: "Der Kapitän vergleicht Zahlen oder ruft eine Frage aus.", quiz: "Jede Runde eine Frage für alle, keine Karten." },
      difficultyLabel: "Schwierigkeit",
      levels: { easy: "leicht", normal: "normal", hard: "schwer" },
      levelLine: {
        easy: "90 s pro Frage, Nadeln bis 3.000 km, Schätzungen bis ×3, Grenzen auf der Karte.",
        normal: "60 s pro Frage, Nadeln bis 1.500 km, Schätzungen bis ×2.",
        hard: "30 s pro Frage, 9 Flaggen zur Wahl, ähnliche falsche Antworten, nur Küsten auf der Karte.",
      },
      countriesLabel: "Gefragte Länder",
      pools: { famous: "80", known: "150", all: "alle" },
      poolLine: {
        famous: "Fragen nur zu den 80 bekanntesten Ländern.",
        known: "Fragen zu den 150 bekanntesten Ländern.",
        all: "Fragen zu allen Ländern, auch den kleinsten.",
      },
      kindsLabel: "Fragen",
      kindsLine: "Tippe eine Art an, um sie wegzulassen. Eine bleibt immer.",
      disputedLabel: "Umstrittene Staaten",
      off: "aus",
      on: "an",
      disputedLine: ["Nur UN-Mitglieder und der Vatikan.", "Dazu Kosovo, Palästina, Taiwan und Westsahara."],
      mapLabel: "Karte am Fernseher",
      flat: "flach",
      globe: "Globus",
      howTitle: "So geht's",
      how: [
        "Jede Runde ziehen alle ein Land als Karte. Nur du siehst deine.",
        "Der Kapitän vergleicht eine Zahl (die höchste gewinnt) oder ruft eine Frage aus.",
        "Fragen: Hauptstädte, Flaggen, Nadeln auf der Karte, Umrisse, Zahlen, Nachbarn. Alle spielen mit.",
        "Jeder Sieg fliegt dein Flugzeug eine Station weiter. Wer am weitesten kommt, gewinnt.",
      ],
      waitRound: "Du steigst ab der nächsten Runde ein.",
      lookTv: "Schau auf den Fernseher.",
      roundN: (/** @type {number} */ r, /** @type {number} */ of) => `Runde ${r} von ${of}`,
      stamp: "deine Karte",
      tabCard: "Deine Karte",
      tabGone: "Weg",
      goneTitle: "Starke Karten, die weg sind",
      goneNone: "Noch ist keine starke Karte weg.",
      goneHint: "Die Top 10 jeder Zahl, die schon abgelegt sind.",
      /** @param {number} left @param {number} size */
      cardsLeft: (left, size) => `Noch ${f.n(left)} von ${f.n(size)} Karten im Stapel`,
      captainTitle: "Du bist Kapitän!",
      captainHint: "Vergleiche eine Zahl oder ruf eine Frage aus.",
      challenge: "Frage!",
      challengeLine: "Eine Frage für alle",
      /** @param {string} name */
      chooses: (name) => `${name} wählt …`,
      choosesHint: "Eine Zahl vergleichen oder eine Frage? Gleich siehst du's.",
      wonStep: "Du fliegst weiter!",
      noStep: "Diesmal nicht.",
      /** @param {number} p @param {number} of */
      place: (p, of) => `Platz ${p} von ${of}`,
      /** @param {string[]} names */
      winners: (names) => (names.length ? `${names.length > 1 ? "Gewinner" : "Gewonnen hat"}: ${f.list(names)}` : "Niemand hat gewonnen."),
      discardTitle: "Alle Karten sind am Fernseher",
      discardHint: "Sie kommen auf den Ablagestapel. Merk dir die starken!",
      kinds: { capital: "Hauptstadt", flag: "Flagge", where: "Wo liegt's?", pickflag: "Welche Flagge?", shape: "Welche Form?", bigger: "Wer hat mehr?", guess: "Schätzen!", neighbour: "Nachbarland", odd: "Wer passt nicht?" },
      kindLines: {
        capital: "Tippe die Hauptstadt.",
        flag: "Welches Land hat diese Flagge?",
        where: "Setz eine Nadel auf die Karte.",
        pickflag: "Tippe die richtige Flagge an.",
        shape: "Welches Land hat diese Form?",
        bigger: "Tippe auf das Land mit dem meisten.",
        guess: "Schieb auf deine Schätzung.",
        neighbour: "Tippe ein Land, das angrenzt.",
        odd: "Tippe auf das Land, das nicht angrenzt.",
      },
      /** @param {string} name */
      flagOf: (name) => `Welche Flagge hat ${name}?`,
      whichShape: "Welches Land ist das?",
      biggerQ: { population: "Die meisten Einwohner?", area: "Die größte Fläche?", highest: "Der höchste Punkt?", gdp: "Das höchste BIP pro Kopf?" },
      guessQ: {
        /** @param {string} n */
        population: (n) => `Wie viele Menschen leben in ${n}?`,
        /** @param {string} n */
        area: (n) => `Wie groß ist ${n}?`,
        /** @param {string} n */
        highest: (n) => `Wie hoch ist der höchste Punkt von ${n}?`,
      },
      /** @param {string} name */
      neighbourOf: (name) => `Ein Nachbarland von ${name}?`,
      /** @param {string} name */
      oddOf: (name) => `Welches grenzt nicht an ${name}?`,
      tapPick: "Tippe eins an.",
      pickCounts: "Deine Wahl zählt, wenn die Zeit um ist.",
      slide: "Schieb den Regler.",
      guessCounts: "Deine Schätzung zählt, wenn die Zeit um ist.",
      less: "Weniger",
      more: "Mehr",
      noPick: "Nichts gewählt",
      noGuess: "Keine Schätzung",
      /** @param {string} x */
      offBy: (x) => `≈ ×${x} daneben`,
      answerIs: "Richtig ist",
      neighbours: "Die Nachbarn",
      borders: "grenzt an",
      notBorders: "grenzt nicht an",
      /** @param {number} k */
      tryN: (k) => `Versuch ${k} von 3`,
      tiebreak: "Stechen!",
      tiebreakWatch: "Die Führenden setzen ihre Nadeln …",
      /** @param {string} name */
      capitalOf: (name) => `Hauptstadt von ${name}?`,
      whichCountry: "Welches Land?",
      whereIs: "Wo liegt",
      tapMap: "Tippe auf die Karte für deine Nadel.",
      lock: "Fertig",
      locked: "Fertig ✓",
      pinCounts: "Deine Nadel zählt, wenn die Zeit um ist. Fertig? Dann tippe auf „Fertig“.",
      textCounts: "Deine Antwort zählt, wenn die Zeit um ist.",
      lockedWait: "Warte auf die anderen …",
      zoomIn: "Hineinzoomen",
      zoomOut: "Herauszoomen",
      mapMode: "Flach oder Globus",
      right: "Richtig!",
      wrong: "Falsch",
      yourAnswer: "Deine Antwort",
      noAnswer: "Keine Antwort",
      noPin: "Keine Nadel",
      hit: "Volltreffer!",
      /** @param {string} km */
      kmAway: (km) => `≈ ${km} daneben`,
      nobody: "Niemand wusste es.",
      again: "Niemand wusste es – gleich kommt die nächste!",
      won: "Du hast gewonnen!",
      gameOver: "Gelandet!",
      /** @param {number} n */
      stepsN: (n) => f.p(n, { one: "# Station", other: "# Stationen" }),
      playAgain: "Nochmal",
      next: "Weiter",
      /** @param {string[]} names */
      nextWait: (names) => (names.length ? `Warte auf ${names.join(", ")} …` : "Gleich geht's weiter …"),
      /** @param {number} s */
      nextIn: (s) => `Weiter in ${s} s`,
      errors: /** @type {Record<string, string>} */ ({
        "not-vip": "Das darf nur der VIP.",
        running: "Das Spiel läuft gerade.",
        "too-few": "Es fehlen noch Mitspieler.",
        "not-now": "Zu spät.",
        "not-captain": "Nur der Kapitän wählt.",
        "too-late": "Die Zeit ist um.",
        locked: "Schon abgegeben.",
        "bad-answer": "Schreib erst etwas.",
      }),
    };
  }
  return {
    ...f,
    otherLang: "Deutsch",
    connecting: "Connecting …",
    scanToJoin: "Scan the QR code on the TV to join.",
    joinTitle: "Who are you?",
    yourName: "Your name",
    join: "Join",
    nameTaken: "That name is taken. Pick another one.",
    pickAnother: "Pick another name.",
    full: "The game is full.",
    closed: "Nobody can join right now. Try again in a moment.",
    badKey: "This link is out of date. Scan the code on the TV.",
    noRoom: "This game is gone.",
    reconnecting: "Connection lost. Reconnecting …",
    kicked: "You were removed from the game.",
    replaced: "You are playing on another device now.",
    roomClosed: "The game is over. Thanks for playing!",
    youreIn: "You're in!",
    travellers: "Travellers",
    vip: "VIP",
    start: "Take off!",
    /** @param {number} k */
    vipWait: (k) => f.p(k, { one: "Waiting for # more player.", other: "Waiting for # more players." }),
    vipReady: "Everyone on board? Let's go.",
    waitVip: "The VIP starts the game.",
    settings: "Settings",
    roundsLabel: "Rounds",
    modeLabel: "Game",
    modes: { cards: "With cards", quiz: "Questions only" },
    modeLine: { cards: "The captain compares numbers or calls a challenge.", quiz: "A question for everyone each round, no cards." },
    difficultyLabel: "Difficulty",
    levels: { easy: "easy", normal: "normal", hard: "hard" },
    levelLine: {
      easy: "90 s per question, pins within 3,000 km, guesses within ×3, borders on the map.",
      normal: "60 s per question, pins within 1,500 km, guesses within ×2.",
      hard: "30 s per question, 9 flags to pick from, look-alike wrong answers, only coastlines on the map.",
    },
    countriesLabel: "Countries asked",
    pools: { famous: "80", known: "150", all: "all" },
    poolLine: {
      famous: "Questions about the 80 best-known countries only.",
      known: "Questions about the 150 best-known countries.",
      all: "Questions about every country, the tiniest too.",
    },
    kindsLabel: "Challenges",
    kindsLine: "Tap a kind to leave it out. One always stays.",
    disputedLabel: "Disputed states",
    off: "off",
    on: "on",
    disputedLine: ["UN members and the Vatican only.", "Adds Kosovo, Palestine, Taiwan and Western Sahara."],
    mapLabel: "TV map",
    flat: "flat",
    globe: "globe",
    howTitle: "How to play",
    how: [
      "Each round everyone draws a country card. Only you see yours.",
      "The captain compares one number (the highest wins) or calls a challenge.",
      "Challenges: capitals, flags, pins on the map, shapes, numbers, neighbours. Everyone plays.",
      "Every win flies your plane one stop on. Whoever gets furthest wins.",
    ],
    waitRound: "You're in from the next round.",
    lookTv: "Look at the TV.",
    roundN: (/** @type {number} */ r, /** @type {number} */ of) => `Round ${r} of ${of}`,
    stamp: "your card",
    tabCard: "Your card",
    tabGone: "Gone",
    goneTitle: "Strong cards that are gone",
    goneNone: "Nothing strong gone yet.",
    goneHint: "Each number's top 10 already on the discard pile.",
    /** @param {number} left @param {number} size */
    cardsLeft: (left, size) => `${f.n(left)} of ${f.n(size)} cards left in the deck`,
    captainTitle: "You're the captain!",
    captainHint: "Compete with a number or call a challenge.",
    challenge: "Challenge!",
    challengeLine: "A question for everyone",
    /** @param {string} name */
    chooses: (name) => `${name} chooses …`,
    choosesHint: "A number to compare, or a challenge? You'll see in a moment.",
    wonStep: "You fly on!",
    noStep: "Not this time.",
    /** @param {number} p @param {number} of */
    place: (p, of) => `${ordinal(p)} of ${of}`,
    /** @param {string[]} names */
    winners: (names) => (names.length ? `${names.length > 1 ? "Winners" : "Winner"}: ${f.list(names)}` : "Nobody won."),
    discardTitle: "All cards are on the TV",
    discardHint: "They go onto the discard pile. Remember the strong ones!",
    kinds: { capital: "Capital", flag: "Flag", where: "Where is it?", pickflag: "Pick the flag", shape: "Name the shape", bigger: "Which is bigger?", guess: "Guess the number", neighbour: "Name a neighbour", odd: "Odd one out" },
    kindLines: {
      capital: "Type the capital.",
      flag: "Whose flag is this?",
      where: "Drop a pin on the map.",
      pickflag: "Tap the right flag.",
      shape: "Which country has this shape?",
      bigger: "Tap the one with the most.",
      guess: "Slide to your guess.",
      neighbour: "Type any country that borders it.",
      odd: "Tap the one that is no neighbour.",
    },
    /** @param {string} name */
    flagOf: (name) => `Which flag is ${name}'s?`,
    whichShape: "Which country is this?",
    biggerQ: { population: "The most people?", area: "The largest area?", highest: "The highest point?", gdp: "The highest GDP per person?" },
    guessQ: {
      /** @param {string} n */
      population: (n) => `How many people live in ${n}?`,
      /** @param {string} n */
      area: (n) => `How big is ${n}?`,
      /** @param {string} n */
      highest: (n) => `How high is ${n}'s highest point?`,
    },
    /** @param {string} name */
    neighbourOf: (name) => `A neighbour of ${name}?`,
    /** @param {string} name */
    oddOf: (name) => `Which one does not border ${name}?`,
    tapPick: "Tap one.",
    pickCounts: "Your pick counts when time is up.",
    slide: "Move the slider.",
    guessCounts: "Your guess counts when time is up.",
    less: "Less",
    more: "More",
    noPick: "No pick",
    noGuess: "No guess",
    /** @param {string} x */
    offBy: (x) => `≈ ×${x} off`,
    answerIs: "The answer",
    neighbours: "The neighbours",
    borders: "borders",
    notBorders: "does not border",
    /** @param {number} k */
    tryN: (k) => `Try ${k} of 3`,
    tiebreak: "Tie-break!",
    tiebreakWatch: "The leaders are dropping their pins …",
    /** @param {string} name */
    capitalOf: (name) => `Capital of ${name}?`,
    whichCountry: "Which country?",
    whereIs: "Where is",
    tapMap: "Tap the map to drop your pin.",
    lock: "Done",
    locked: "Done ✓",
    pinCounts: "Your pin counts when time is up. Sure? Tap Done.",
    textCounts: "Your answer counts when time is up.",
    lockedWait: "Waiting for the others …",
    zoomIn: "Zoom in",
    zoomOut: "Zoom out",
    mapMode: "Flat or globe",
    right: "Right!",
    wrong: "Wrong",
    yourAnswer: "Your answer",
    noAnswer: "No answer",
    noPin: "No pin",
    hit: "Spot on!",
    /** @param {string} km */
    kmAway: (km) => `≈ ${km} away`,
    nobody: "Nobody knew.",
    again: "Nobody knew — another one is coming!",
    won: "You won!",
    gameOver: "Landed!",
    /** @param {number} n */
    stepsN: (n) => f.p(n, { one: "# stop", other: "# stops" }),
    playAgain: "Play again",
    next: "Next",
    /** @param {string[]} names */
    nextWait: (names) => (names.length ? `Waiting for ${names.join(", ")} …` : "Here we go …"),
    /** @param {number} s */
    nextIn: (s) => `Going on in ${s} s`,
    errors: /** @type {Record<string, string>} */ ({
      "not-vip": "Only the VIP can do that.",
      running: "The game is on.",
      "too-few": "Waiting for more players.",
      "not-now": "Too late.",
      "not-captain": "Only the captain chooses.",
      "too-late": "Time is up.",
      locked: "Already locked in.",
      "bad-answer": "Type something first.",
    }),
  };
}

/** 1st, 2nd, 3rd, 4th, 11th, 21st … @param {number} n */
function ordinal(n) {
  const ten = n % 10;
  const hundred = n % 100;
  const suffix = hundred >= 11 && hundred <= 13 ? "th" : ten === 1 ? "st" : ten === 2 ? "nd" : ten === 3 ? "rd" : "th";
  return `${n}${suffix}`;
}

/** @typedef {ReturnType<typeof strings>} Strings */
