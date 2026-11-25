// @ts-check
/**
 * What the phone says, in English and German, each written for its own
 * players (German with "du"). Players' texts and the columns never come
 * from here: they are in the views.
 */

import { format } from "./i18n.js";

/** English ordinals: 1st, 2nd, 3rd, 4th, 11th. @param {number} n */
function ordinal(n) {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${s}`;
}

/** @param {import("./i18n.js").Format} f */
function en(f) {
  return {
    ...f,
    langName: "English",
    /** @param {string} s */
    q: (s) => `“${s}”`,
    connecting: "Connecting…",
    scanToJoin: "Scan the QR code on the TV to join the class.",
    joinTitle: "Take a seat",
    joinLead: "Today: one letter, a board full of subjects, and the bell is about to ring.",
    yourName: "Your name",
    join: "Join the class",
    rejoinHint: "Been here before? Type the same name and you get your seat back.",
    nameTaken: "Someone in the class already has that name.",
    pickAnother: "Pick another name.",
    full: "The class is full.",
    closed: "A game is on. Try again once it's over.",
    badKey: "This link is out of date. Scan the code on the TV again.",
    noRoom: "This game doesn't exist any more.",
    reconnecting: "Connection lost… reconnecting",
    kicked: "You were taken out of the class.",
    replaced: "You're playing on another device now.",
    roomClosed: "School's out: the game has ended.",
    lookTv: "Look at the TV.",
    exercise: "Exercise book",
    /** @param {number} r @param {number} n */
    roundOf: (r, n) => `Round ${r} of ${n}`,
    // Lobby
    youreIn: "You're in!",
    classList: "The class",
    vip: "VIP",
    you: "you",
    away: "away",
    start: "Start lessons",
    playAgain: "Another school day",
    /** @param {number} n */
    vipWait: (n) => (n === 1 ? "One more pupil and you can start." : `${n} more pupils and you can start.`),
    vipReady: "Everyone here? Then ring the bell.",
    waitVip: "The VIP starts the game.",
    settings: "Settings",
    howTitle: "How it works",
    how: [
      "Someone stops the alphabet. That's today's letter.",
      "Write one answer per subject that starts with it, before the bell rings. The TV only shows scribbles.",
      "Then the class grades: cross out what doesn't count, give a gold star to the best, look it up in Wikipedia.",
      "Only you: 20 points. Nobody else had it: 10. Same as someone: 5.",
    ],
    set: {
      lang: { label: "Language", choices: {} },
      rounds: { label: "Rounds", choices: {} },
      columns: { label: "Subjects per round", choices: {} },
      time: { label: "Time to write", choices: {} },
      mix: { label: "Funny subjects", choices: { school: "few", mixed: "some", silly: "lots" }, lines: { school: "Mostly real school: cities, animals, food.", mixed: "A quarter of the board is silly.", silly: "Half the board is silly." } },
      content: { label: "Subjects for", choices: { family: "family", party: "party" }, lines: { family: "Fine with kids and grandparents.", party: "Adds Detention: the cheeky subjects." } },
      stop: { label: "Stop! button", choices: { on: "on", off: "off" }, lines: { on: "Whoever fills every line first can cut everyone to 10 seconds.", off: "Everyone writes until the bell." } },
      classic: { label: "City, Country, River", choices: { on: "every round", off: "no" }, lines: { on: "Every round starts with the classic three.", off: "" } },
      letters: { label: "Letters", choices: { common: "common", all: "all" }, lines: { common: "No Q, X, Y and friends.", all: "Includes the hard ones (Q, X, Y …)." } },
      late: { label: "Latecomers", choices: { open: "straight away", wait: "from the next round", closed: "not during a game" }, lines: { open: "Anyone who comes late writes along at once, until the bell.", wait: "Anyone who comes late joins in from the next round.", closed: "Nobody new joins while a game runs." } },
    },
    /** @param {number} n */
    seconds: (n) => (n % 60 === 0 ? `${n / 60} min` : `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")} min`),
    // Waiting
    waitRound: "You're in from the next round.",
    waitHint: "Grab a pen and watch the TV meanwhile.",
    watchRound: "You're watching this round.",
    watchHint: "You'll be back at your desk next round.",
    // The letter
    drawerTitle: "You stop the alphabet!",
    drawerHint: "Tap Stop! when the light is on a good letter.",
    stopLetter: "Stop!",
    /** @param {string} name */
    stopsAlphabet: (name) => `${name} stops the alphabet`,
    stopsHint: "Watch the light run along the frieze.",
    theLetter: "Today's letter",
    // The board
    timetable: "Today's timetable",
    penReady: "Get your pen ready…",
    // Writing
    /** @param {number} k @param {number} n */
    filled: (k, n) => `${k} of ${n} written`,
    stopHand: "✋ Stop!",
    stopHint: "Everyone else gets 10 more seconds.",
    stopShort: "10 s left for all",
    /** @param {string} name */
    stoppedBy: (name) => `${name} called Stop! Hurry up!`,
    youStopped: "You called Stop! 10 seconds left.",
    /** @param {string} l */
    startsWith: (l) => `${l}…`,
    rules: /** @type {Record<string, (l: string) => string>} */ ({
      "rule:ends": (l) => `starts and ends with ${l}`,
      "rule:double": () => "with a double letter (ee, ll, …)",
      "rule:two": (l) => `two words, both with ${l}`,
      "rule:long": () => "at least 9 letters",
    }),
    // The bell
    pensDown: "Pens down!",
    handedIn: "Your exercise book is handed in.",
    /** @param {number} k @param {number} n */
    handedInN: (k, n) => `${k} of ${n} answers written.`,
    // Grading
    /** @param {number} i @param {number} n */
    colOf: (i, n) => `Subject ${i} of ${n}`,
    gradeHint: "Cross out what doesn't count. One gold star for the best.",
    pairHint: "Just the two of you: if you cross something out, it doesn't count.",
    doubt: "✗ Doesn't count",
    star: "★ Star",
    wiki: "📖 Wikipedia",
    done: "I'm done",
    undone: "✓ Done (tap: undo)",
    /** @param {number} k @param {number} n */
    doneCount: (k, n) => `${k} of ${n} done`,
    /** @param {number} n */
    lookupsLeft: (n) => (n === 0 ? "No lookups left in this subject." : n === 1 ? "1 lookup left" : `${n} lookups left`),
    same: /** @type {Record<string, string>} */ ({ same: "same answer", spelling: "≈ spelling", plural: "≈ plural", typo: "≈ typo" }),
    auto: /** @type {Record<string, (l: string) => string>} */ ({
      empty: () => "nothing written",
      letter: (l) => `doesn't start with ${l}`,
      "rule:ends": (l) => `doesn't end with ${l}`,
      "rule:double": () => "no double letter",
      "rule:two": (l) => `not two words with ${l}`,
      "rule:long": () => "too short",
    }),
    empty: "(nothing)",
    // Marked
    /** @param {number} d @param {number} n */
    struckBy: (d, n) => `✗ ${d} of ${n}`,
    counts: "✓ counts",
    /** @param {number} n */
    earned: (n) => (n > 0 ? `+${n} for you` : "No points for you here"),
    /** @param {number} n */
    starsN: (n) => (n === 1 ? "1 star" : `${n} stars`),
    pts: "pts",
    // Wikipedia
    looking: "Looking it up…",
    /** @param {string} q */
    wikiNone: (q) => `Wikipedia found nothing for “${q}”.`,
    wikiOffline: "Wikipedia is not reachable.",
    /** @param {string} name @param {string} title */
    wikiReads: (name, title) => `${name} reads “${title}”`,
    /** @param {string} name @param {string} q */
    wikiLooking: (name, q) => `${name} looks up “${q}”…`,
    wikiPrev: "← Back",
    wikiSearch: "Search Wikipedia",
    wikiFind: "Search",
    wikiDisamb: "This word can mean several things:",
    wikiWhole: "read the whole article on Wikipedia",
    wikiOthers: "Or did you mean",
    wikiClose: "Close for everyone",
    wikiBack: "Back to grading",
    wikiOpen: "Open",
    wikiCredit: "Wikipedia · CC BY-SA",
    // Report
    /** @param {number} r */
    roundGraded: (r) => `Round ${r} is graded`,
    thisRound: "Your points this round",
    total: "Total",
    /** @param {number} r @param {number} n */
    rank: (r, n) => `${ordinal(r)} of ${n}`,
    points: "points",
    /** @param {number} n */
    twenties: (n) => `${n}× 20 points: nobody else had anything there`,
    // Final
    reportCard: "Report card",
    school: "Classes Community School",
    grades: "Grades",
    remarksTitle: "Remarks",
    remarks: /** @type {Record<string, string>} */ ({
      top: "Top of the class",
      clown: "Class clown",
      twenty: "Thinks for themselves",
      copy: "Copies from the neighbour",
      facts: "Very creative with the facts",
      empty: "Forgot the homework",
      star: "Good taste",
      fine: "A pleasure to have in class",
    }),
    stamps: /** @type {Record<string, string>} */ ({ promoted: "Promoted", held: "Held back?" }),
    noGrades: "No grades: no subjects written.",
    best: "Best answers of the day",
    gameOver: "School's out!",
    errors: /** @type {Record<string, string>} */ ({
      "not-vip": "Only the VIP can do that.",
      "not-player": "Only players can do that.",
      running: "Not while a game is on.",
      "bad-settings": "That setting doesn't exist.",
      "too-few": "Not enough pupils yet.",
      "not-drawer": "Someone else stops the alphabet.",
      "too-late": "Too late.",
      "not-playing": "You're not in this round.",
      "bad-draft": "That answer can't be sent.",
      "not-filled": "Fill in every line first.",
      stopped: "Someone already called Stop!",
      off: "The Stop! button is off.",
      own: "That's your own answer.",
      auto: "That one is already crossed out.",
      "bad-answer": "That answer is gone.",
      "slow-down": "Not so fast: one page every two seconds.",
      "too-many": "That was your last lookup for this subject.",
      "bad-title": "Type what to look up.",
      "no-article": "The article is closed.",
      "no-back": "There's nothing to go back to.",
      "not-driver": "Someone else is reading now.",
    }),
  };
}

/** @param {import("./i18n.js").Format} f @returns {ReturnType<typeof en>} */
function de(f) {
  return {
    ...f,
    langName: "Deutsch",
    /** @param {string} s */
    q: (s) => `„${s}“`,
    connecting: "Verbinde …",
    scanToJoin: "Scann den QR-Code auf dem Fernseher, dann bist du in der Klasse.",
    joinTitle: "Setz dich",
    joinLead: "Heute: ein Buchstabe, eine Tafel voller Fächer, und gleich klingelt's.",
    yourName: "Dein Name",
    join: "Ab in die Klasse",
    rejoinHint: "Warst du schon drin? Gib denselben Namen ein, dann kriegst du deinen Platz zurück.",
    nameTaken: "Den Namen gibt's in der Klasse schon.",
    pickAnother: "Nimm einen anderen Namen.",
    full: "Die Klasse ist voll.",
    closed: "Gerade läuft ein Spiel. Versuch's danach nochmal.",
    badKey: "Der Link ist veraltet. Scann den Code auf dem Fernseher nochmal.",
    noRoom: "Dieses Spiel gibt es nicht mehr.",
    reconnecting: "Verbindung weg … verbinde neu",
    kicked: "Du wurdest aus der Klasse genommen.",
    replaced: "Du spielst jetzt auf einem anderen Gerät.",
    roomClosed: "Schulschluss: Das Spiel ist vorbei.",
    lookTv: "Schau auf den Fernseher.",
    exercise: "Heft",
    /** @param {number} r @param {number} n */
    roundOf: (r, n) => `Runde ${r} von ${n}`,
    youreIn: "Du bist dabei!",
    classList: "Die Klasse",
    vip: "VIP",
    you: "du",
    away: "weg",
    start: "Unterricht starten",
    playAgain: "Noch ein Schultag",
    /** @param {number} n */
    vipWait: (n) => (n === 1 ? "Noch eine Person, dann kannst du starten." : `Noch ${n} Leute, dann kannst du starten.`),
    vipReady: "Alle da? Dann läute den Unterricht ein.",
    waitVip: "Der VIP startet das Spiel.",
    settings: "Einstellungen",
    howTitle: "So geht's",
    how: [
      "Jemand stoppt das Alphabet. Das ist der Buchstabe der Runde.",
      "Schreib zu jedem Fach ein Wort mit diesem Anfangsbuchstaben, bevor es klingelt. Der Fernseher zeigt nur Gekritzel.",
      "Dann benotet die Klasse: Streich durch, was nicht zählt, klebe einen Goldstern auf die beste Antwort, schlag in Wikipedia nach.",
      "Nur du hast was: 20 Punkte. Keiner sonst hat dasselbe: 10. Gleiche Antwort wie jemand: 5.",
    ],
    set: {
      lang: { label: "Sprache", choices: {} },
      rounds: { label: "Runden", choices: {} },
      columns: { label: "Fächer pro Runde", choices: {} },
      time: { label: "Zeit zum Schreiben", choices: {} },
      mix: { label: "Lustige Fächer", choices: { school: "wenige", mixed: "einige", silly: "viele" }, lines: { school: "Fast nur echter Stoff: Städte, Tiere, Essen.", mixed: "Ein Viertel der Tafel ist Quatsch.", silly: "Die halbe Tafel ist Quatsch." } },
      content: { label: "Fächer für", choices: { family: "Familie", party: "Party" }, lines: { family: "Passt mit Kindern und Großeltern.", party: "Dazu kommt Nachsitzen: die frechen Fächer." } },
      stop: { label: "Stopp-Knopf", choices: { on: "an", off: "aus" }, lines: { on: "Wer zuerst alles ausgefüllt hat, kann allen auf 10 Sekunden verkürzen.", off: "Alle schreiben, bis es klingelt." } },
      classic: { label: "Stadt, Land, Fluss", choices: { on: "jede Runde", off: "nein" }, lines: { on: "Jede Runde beginnt mit den drei Klassikern.", off: "" } },
      letters: { label: "Buchstaben", choices: { common: "übliche", all: "alle" }, lines: { common: "Ohne Q, X und Y.", all: "Auch die schweren (Q, X, Y)." } },
      late: { label: "Nachzügler", choices: { open: "sofort", wait: "ab der nächsten Runde", closed: "nicht während des Spiels" }, lines: { open: "Wer später kommt, schreibt sofort mit, bis es klingelt.", wait: "Wer später kommt, spielt ab der nächsten Runde mit.", closed: "Während eines Spiels kommt niemand dazu." } },
    },
    /** @param {number} n */
    seconds: (n) => (n % 60 === 0 ? `${n / 60} Min.` : `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")} Min.`),
    waitRound: "Ab der nächsten Runde bist du dabei.",
    waitHint: "Spitz schon mal den Bleistift und schau so lange auf den Fernseher.",
    watchRound: "Diese Runde schaust du zu.",
    watchHint: "Nächste Runde sitzt du wieder an deinem Platz.",
    drawerTitle: "Du stoppst das Alphabet!",
    drawerHint: "Tipp auf Stopp!, wenn das Licht auf einem guten Buchstaben steht.",
    stopLetter: "Stopp!",
    /** @param {string} name */
    stopsAlphabet: (name) => `${name} stoppt das Alphabet`,
    stopsHint: "Schau, wie das Licht über die Buchstaben läuft.",
    theLetter: "Der Buchstabe",
    timetable: "Heute auf dem Stundenplan",
    penReady: "Stift bereit …",
    /** @param {number} k @param {number} n */
    filled: (k, n) => `${k} von ${n} geschrieben`,
    stopHand: "✋ Stopp!",
    stopHint: "Dann haben alle anderen nur noch 10 Sekunden.",
    stopShort: "noch 10 s für alle",
    /** @param {string} name */
    stoppedBy: (name) => `${name} ruft Stopp! Beeil dich!`,
    youStopped: "Du hast Stopp gerufen. Noch 10 Sekunden.",
    /** @param {string} l */
    startsWith: (l) => `${l} …`,
    rules: /** @type {Record<string, (l: string) => string>} */ ({
      "rule:ends": (l) => `fängt mit ${l} an und hört mit ${l} auf`,
      "rule:double": () => "mit Doppelbuchstaben (ee, ll, …)",
      "rule:two": (l) => `zwei Wörter, beide mit ${l}`,
      "rule:long": () => "mindestens 12 Buchstaben",
    }),
    pensDown: "Stifte weg!",
    handedIn: "Dein Heft ist abgegeben.",
    /** @param {number} k @param {number} n */
    handedInN: (k, n) => `${k} von ${n} Antworten geschrieben.`,
    /** @param {number} i @param {number} n */
    colOf: (i, n) => `Fach ${i} von ${n}`,
    gradeHint: "Streich durch, was nicht zählt. Ein Goldstern für die beste Antwort.",
    pairHint: "Ihr seid nur zu zweit: Was du durchstreichst, zählt nicht.",
    doubt: "✗ Zählt nicht",
    star: "★ Stern",
    wiki: "📖 Wikipedia",
    done: "Fertig",
    undone: "✓ Fertig (tippen: zurück)",
    /** @param {number} k @param {number} n */
    doneCount: (k, n) => `${k} von ${n} fertig`,
    /** @param {number} n */
    lookupsLeft: (n) => (n === 0 ? "In diesem Fach kannst du nichts mehr nachschlagen." : n === 1 ? "Noch einmal nachschlagen" : `Noch ${n}-mal nachschlagen`),
    same: /** @type {Record<string, string>} */ ({ same: "gleiche Antwort", spelling: "≈ Schreibweise", plural: "≈ Plural", typo: "≈ Tippfehler" }),
    auto: /** @type {Record<string, (l: string) => string>} */ ({
      empty: () => "nichts geschrieben",
      letter: (l) => `fängt nicht mit ${l} an`,
      "rule:ends": (l) => `hört nicht mit ${l} auf`,
      "rule:double": () => "kein Doppelbuchstabe",
      "rule:two": (l) => `nicht zwei Wörter mit ${l}`,
      "rule:long": () => "zu kurz",
    }),
    empty: "(nichts)",
    /** @param {number} d @param {number} n */
    struckBy: (d, n) => `✗ ${d} von ${n}`,
    counts: "✓ zählt",
    /** @param {number} n */
    earned: (n) => (n > 0 ? `+${n} für dich` : "Hier gibt's für dich keine Punkte"),
    /** @param {number} n */
    starsN: (n) => (n === 1 ? "1 Stern" : `${n} Sterne`),
    pts: "Pkt.",
    looking: "Ich schlag nach …",
    /** @param {string} q */
    wikiNone: (q) => `Wikipedia kennt „${q}“ nicht.`,
    wikiOffline: "Wikipedia ist gerade nicht erreichbar.",
    /** @param {string} name @param {string} title */
    wikiReads: (name, title) => `${name} liest „${title}“`,
    /** @param {string} name @param {string} q */
    wikiLooking: (name, q) => `${name} schlägt „${q}“ nach …`,
    wikiPrev: "← Zurück",
    wikiSearch: "In Wikipedia suchen",
    wikiFind: "Suchen",
    wikiDisamb: "Dieser Begriff hat mehrere Bedeutungen:",
    wikiWhole: "den ganzen Artikel auf Wikipedia lesen",
    wikiOthers: "Oder meintest du",
    wikiClose: "Für alle schließen",
    wikiBack: "Zurück zum Benoten",
    wikiOpen: "Öffnen",
    wikiCredit: "Wikipedia · CC BY-SA",
    /** @param {number} r */
    roundGraded: (r) => `Runde ${r} ist benotet`,
    thisRound: "Deine Punkte in dieser Runde",
    total: "Gesamt",
    /** @param {number} r @param {number} n */
    rank: (r, n) => `Platz ${r} von ${n}`,
    points: "Punkte",
    /** @param {number} n */
    twenties: (n) => `${n}× 20 Punkte: sonst hatte da niemand etwas`,
    reportCard: "Zeugnis",
    school: "Städtische Gesamtschule Classes",
    grades: "Noten",
    remarksTitle: "Bemerkungen",
    remarks: /** @type {Record<string, string>} */ ({
      top: "Spitze der Klasse",
      clown: "Klassenclown",
      twenty: "Denkt selbstständig",
      copy: "Schreibt gern ab",
      facts: "Sehr kreativ mit den Fakten",
      empty: "Hat die Hausaufgaben vergessen",
      star: "Hat einen guten Geschmack",
      fine: "Eine Freude im Unterricht",
    }),
    stamps: /** @type {Record<string, string>} */ ({ promoted: "Versetzt", held: "Versetzung gefährdet" }),
    noGrades: "Keine Noten: kein Fach geschrieben.",
    best: "Die besten Antworten des Tages",
    gameOver: "Schulschluss!",
    errors: /** @type {Record<string, string>} */ ({
      "not-vip": "Das darf nur der VIP.",
      "not-player": "Das dürfen nur Mitspielende.",
      running: "Nicht während eines Spiels.",
      "bad-settings": "Diese Einstellung gibt es nicht.",
      "too-few": "Es fehlen noch Leute.",
      "not-drawer": "Jemand anderes stoppt das Alphabet.",
      "too-late": "Zu spät.",
      "not-playing": "Du bist in dieser Runde nicht dabei.",
      "bad-draft": "Diese Antwort geht nicht.",
      "not-filled": "Füll erst alle Zeilen aus.",
      stopped: "Jemand hat schon Stopp gerufen.",
      off: "Der Stopp-Knopf ist aus.",
      own: "Das ist deine eigene Antwort.",
      auto: "Die ist schon durchgestrichen.",
      "bad-answer": "Diese Antwort gibt es nicht mehr.",
      "slow-down": "Nicht so schnell: eine Seite alle zwei Sekunden.",
      "too-many": "In diesem Fach kannst du nichts mehr nachschlagen.",
      "bad-title": "Gib ein, was du nachschlagen willst.",
      "no-article": "Der Artikel ist schon zu.",
      "no-back": "Weiter zurück geht's nicht.",
      "not-driver": "Gerade liest jemand anderes.",
    }),
  };
}

/** Subjects' names (§4.4): the German ones are the school's own. */
const SUBJECT_NAMES = {
  en: { geo: "Geography", bio: "Biology", home: "Home economics", music: "Music", media: "Art & media", sport: "PE", social: "Social studies", lang: "English", break: "Break", trip: "School trip", register: "Register", detention: "Detention" },
  de: { geo: "Erdkunde", bio: "Biologie", home: "Hauswirtschaft", music: "Musik", media: "Kunst & Medien", sport: "Sport", social: "Sozialkunde", lang: "Deutsch", break: "Pause", trip: "Klassenfahrt", register: "Klassenbuch", detention: "Nachsitzen" },
};

/** Austria's own school subjects, on top of the German ones. */
const SUBJECT_NAMES_AT = { geo: "Geografie", home: "Ernährung & Haushalt", media: "Bildnerische Erziehung", sport: "Bewegung & Sport", social: "Politische Bildung", trip: "Projektwoche" };

/**
 * Austrian German: the German texts with Austria's school words on top
 * (Klassenvorstand, Aufstieg, grades 1–5).
 * @param {import("./i18n.js").Format} f
 */
function at(f) {
  const d = de(f);
  return {
    ...d,
    // The language row's button (three in a row on a 320 px phone): the country says it.
    langName: "Österreich",
    school: "Bundesrealgymnasium Classes",
    stamps: /** @type {Record<string, string>} */ ({ promoted: "Aufstieg", held: "Aufstieg gefährdet" }),
  };
}

/** @param {"en" | "de" | "at"} lang */
export function strings(lang) {
  const f = format(lang);
  const names = /** @type {Record<string, string>} */ ({ ...SUBJECT_NAMES[lang === "at" ? "de" : lang], ...(lang === "at" ? SUBJECT_NAMES_AT : {}) });
  /** A subject's name. @param {string} id */
  const subject = (id) => names[id] ?? id;
  return { ...(lang === "at" ? at(f) : lang === "de" ? de(f) : en(f)), subject };
}

/** @typedef {ReturnType<typeof strings>} Strings */
