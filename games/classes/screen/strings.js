// @ts-check
/**
 * What Classes' TV says, in English and German (each written for its own
 * players, not translated): the blackboard's chalk, the subjects (§4.4 of
 * docs/classes-design.md), the red pen's reasons and notes, the report
 * card's remarks and stamps. Players' texts never come from here.
 */

import { format } from "./i18n.js";

/** The subjects: their names on the tabs and report cards. */
const SUBJECTS = {
  en: {
    geo: "Geography",
    bio: "Biology",
    home: "Home economics",
    music: "Music",
    media: "Art & media",
    sport: "PE",
    social: "Social studies",
    lang: "English",
    break: "Break",
    trip: "School trip",
    register: "Register",
    detention: "Detention",
  },
  de: {
    geo: "Erdkunde",
    bio: "Biologie",
    home: "Hauswirtschaft",
    music: "Musik",
    media: "Kunst & Medien",
    sport: "Sport",
    social: "Sozialkunde",
    lang: "Deutsch",
    break: "Pause",
    trip: "Klassenfahrt",
    register: "Klassenbuch",
    detention: "Nachsitzen",
  },
};

/** The teacher's remarks (`Card.remarks`), in the order the host gives them. */
const REMARKS = {
  en: {
    top: "Top of the class",
    clown: "Class clown",
    twenty: "Thinks for themselves",
    copy: "Copies from the neighbour",
    facts: "Very creative with the facts",
    empty: "Forgot the homework",
    star: "Good taste",
    fine: "A pleasure to have in class",
  },
  de: {
    top: "Spitze der Klasse",
    clown: "Bringt alle zum Lachen",
    twenty: "Denkt selbstständig",
    copy: "Schreibt gern ab",
    facts: "Sehr kreativ im Umgang mit Fakten",
    empty: "Hausaufgaben vergessen",
    star: "Hat einen guten Geschmack",
    fine: "Eine Bereicherung für die Klasse",
  },
};

/** German grades in words, as on a real Zeugnis. */
const GRADE_WORDS = { "1": "sehr gut", "2": "gut", "3": "befriedigend", "4": "ausreichend", "5": "mangelhaft", "6": "ungenügend" };
/** Austrian grades (1–5). */
const GRADE_WORDS_AT = { "1": "Sehr gut", "2": "Gut", "3": "Befriedigend", "4": "Genügend", "5": "Nicht genügend" };
/** Austria's own school subjects, on top of the German ones. */
const SUBJECTS_AT = { geo: "Geografie", home: "Ernährung & Haushalt", media: "Bildnerische Erziehung", sport: "Bewegung & Sport", social: "Politische Bildung", trip: "Projektwoche" };

/**
 * The TV's texts. Austrian German (`at`) is the German ones with
 * Austria's school words on top: Klassenvorstand, Aufstieg, grades 1–5.
 * @param {"en" | "de" | "at"} lang
 */
export function strings(lang) {
  const s = base(lang === "at" ? "de" : lang, format(lang));
  if (lang !== "at") return s;
  return {
    ...s,
    /** @param {string} id */
    subject: (id) => (/** @type {Record<string, string>} */ (SUBJECTS_AT))[id] ?? s.subject(id),
    school: "Bundesrealgymnasium Classes",
    /** @param {string} g */
    gradeWord: (g) => (/** @type {Record<string, string>} */ (GRADE_WORDS_AT))[g] ?? "",
    stamp: { promoted: "Aufstieg", held: "Aufstieg gefährdet" },
    teacher: "Klassenvorstand",
    signature: "Prof. Lämpel",
  };
}

/** @param {"en" | "de"} lang @param {import("./i18n.js").Format} f */
function base(lang, f) {
  const de = lang === "de";
  const q = (/** @type {string} */ s) => (de ? `„${s}“` : `“${s}”`);
  /** @type {Record<string, string>} */
  const subjects = SUBJECTS[lang];
  /** @type {Record<string, string>} */
  const remarks = REMARKS[lang];
  return {
    ...f,
    q,
    /** The alphabet of the frieze. */
    alphabet: "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split(""),
    /** @param {string} id */
    subject: (id) => subjects[id] ?? id,
    /** @param {string} code */
    remark: (code) => remarks[code] ?? code,
    // Lobby
    tagline: de ? "Stadt, Land, Fluss – heute im Klassenzimmer" : "Categories, back at school",
    /** @param {number} cols */
    pitch: (cols) => (de ? `Ein Buchstabe. ${cols} Fächer. Stifte weg, wenn's klingelt.` : `One letter. ${cols} subjects. Pens down at the bell.`),
    classList: de ? "Klassenliste" : "Class register",
    nobody: de ? "Noch niemand da." : "Nobody here yet.",
    joinTitle: de ? "Komm in die Klasse!" : "Join the class!",
    scan: de ? "Mit dem Handy scannen" : "Scan with your phone",
    orType: de ? "oder eintippen:" : "or type:",
    away: de ? "fehlt" : "away",
    /** @param {number} n */
    needMore: (n) => (de ? `Noch ${n === 1 ? "eine Person" : `${n} Leute`}, dann geht der Unterricht los.` : f.p(n, { one: "One more pupil and school can start.", other: "# more pupils and school can start." })),
    /** @param {string} name */
    vipStarts: (name) => (de ? `${name} läutet zur ersten Stunde.` : `${name} rings the bell for the first lesson.`),
    timetable: de ? "Stundenplan" : "Timetable",
    /** @param {number} n */
    lessons: (n) => (de ? `${n} Stunden` : `${n} lessons`),
    /** @param {number} n */
    perLesson: (n) => (de ? `${n} Fächer pro Stunde` : `${n} subjects a lesson`),
    /** @param {number} s */
    writeTime: (s) => (de ? `${s >= 120 ? `${s / 60} Minuten` : `${s} Sekunden`} zum Schreiben` : `${s >= 120 ? `${s / 60} minutes` : `${s} seconds`} to write`),
    mix: de ? { school: "Ernst des Lebens", mixed: "Halb ernst, halb Quatsch", silly: "Viel Quatsch" } : { school: "Proper lessons", mixed: "Half serious, half silly", silly: "Mostly silly" },
    party: de ? "Mit Nachsitzen (ab 16)" : "With detention (grown-ups)",
    classic: de ? "Erst Stadt, Land, Fluss" : "City, Country, River first",
    hard: de ? "Auch Q, X und Y" : "Hard letters too",
    /** Latecomers (`late`). @type {Record<string, string>} */
    late: de ? { open: "Zu spät? Sofort mitschreiben", wait: "Zu spät? Ab der nächsten Stunde", closed: "Zu spät? Heute nicht mehr" } : { open: "Late? Join straight away", wait: "Late? Join next lesson", closed: "Late? Not today" },
    stopOn: de ? "Wer fertig ist, darf „Stopp!“ rufen" : "Finish first and call “Stop!”",
    // Letter
    /** @param {string} name */
    stops: (name) => (de ? `${name} hält das Alphabet an` : `${name} stops the alphabet`),
    stopHint: de ? "Stopp auf dem Handy drücken!" : "Press Stop! on the phone",
    todays: de ? "Heute mit" : "Today’s letter",
    /** @param {number} r @param {number} n */
    lesson: (r, n) => (de ? `${r}. Stunde von ${n}` : `Lesson ${r} of ${n}`),
    // Board and writing
    /** @param {string} l */
    letterIs: (l) => (de ? `Alles mit ${l}` : `Everything with ${l}`),
    write: de ? "Schreibt!" : "Write!",
    /** @param {string} name */
    stopBy: (name) => (de ? `${name}: Stopp!` : `${name}: Stop!`),
    tenLeft: de ? "Noch 10 Sekunden!" : "10 seconds left!",
    /** @param {number} n @param {number} of */
    filled: (n, of) => `${n}/${of}`,
    /** The rule columns, small under their title. @type {Record<string, (l: string) => string>} */
    rule: de
      ? { "rule:ends": (l) => `fängt mit ${l} an und hört mit ${l} auf`, "rule:double": () => "mit Doppelbuchstaben", "rule:two": (l) => `zwei Wörter, beide mit ${l}`, "rule:long": () => "mindestens 12 Buchstaben" }
      : { "rule:ends": (l) => `starts and ends with ${l}`, "rule:double": () => "with a double letter", "rule:two": (l) => `two words, both with ${l}`, "rule:long": () => "at least 9 letters" },
    // The bell
    pensDown: de ? "Stifte weg!" : "Pens down!",
    bellSub: de ? "Jetzt wird korrigiert." : "Time to mark.",
    // Grading
    /** @param {number} i @param {number} n */
    colOf: (i, n) => (de ? `Fach ${i} von ${n}` : `Subject ${i} of ${n}`),
    voteHint: de ? "Am Handy: ✗ anzweifeln · ★ Stern · Nachschlagen" : "On your phone: ✗ doubt · ★ star · look it up",
    done: de ? "fertig" : "done",
    /** Why an answer was struck by rule. @type {Record<string, (l: string) => string>} */
    auto: de
      ? { empty: () => "nichts geschrieben", letter: (l) => `nicht mit ${l}!`, "rule:ends": (l) => `hört nicht mit ${l} auf`, "rule:double": () => "kein Doppelbuchstabe", "rule:two": (l) => `nicht zwei Wörter mit ${l}`, "rule:long": () => "zu kurz" }
      : { empty: () => "nothing written", letter: (l) => `not with ${l}!`, "rule:ends": (l) => `doesn't end with ${l}`, "rule:double": () => "no double letter", "rule:two": (l) => `not two ${l} words`, "rule:long": () => "too short" },
    /** The red bracket of the same answers. @type {Record<string, string>} */
    same: de ? { same: "gleiche Antwort", spelling: "≈ Schreibweise", plural: "≈ Mehrzahl", typo: "≈ Tippfehler" } : { same: "same answer", spelling: "≈ spelling", plural: "≈ plural", typo: "≈ typo" },
    /** @param {number} d @param {number} of */
    struck: (d, of) => (de ? `✗ ${d} von ${of}` : `✗ ${d} of ${of}`),
    /** The red pen's notes in the margin, now and then. */
    notes: {
      struck: de ? ["Wirklich?", "Netter Versuch", "Na ja …", "Siehe Duden"] : ["Really?", "Nice try", "Hmm…", "Says who?"],
      good: de ? ["Sehr gut!", "Kreativ!", "Prima!", "Schlau!"] : ["Well done!", "Clever!", "Lovely!", "Bright spark!"],
    },
    // Wikipedia
    looking: de ? "Wird nachgeschlagen …" : "Looking it up…",
    /** @param {string} s */
    nothing: (s) => (de ? `Wikipedia kennt ${q(s)} nicht.` : `Wikipedia found nothing for ${q(s)}.`),
    offline: de ? "Wikipedia ist gerade nicht erreichbar." : "Wikipedia is not reachable.",
    encyclopedia: de ? "Die freie Enzyklopädie" : "The Free Encyclopedia",
    /** @param {string} name @param {string} s */
    lookedUp: (name, s) => (de ? `${name} schlägt ${q(s)} nach` : `${name} looks up ${q(s)}`),
    /** @param {string} name @param {string} s */
    reads: (name, s) => (de ? `${name} liest ${q(s)}` : `${name} reads ${q(s)}`),
    credit: "Wikipedia · CC BY-SA",
    disambiguation: de ? "Begriffsklärung: Was ist gemeint?" : "Disambiguation: which one?",
    // Report
    /** @param {number} r */
    endOf: (r) => (de ? `Ende der ${r}. Stunde` : `End of lesson ${r}`),
    standings: de ? "Zwischenstand" : "Standings",
    finalStandings: de ? "Endstand" : "Final standings",
    /** @param {number} n */
    points: (n) => (de ? `${f.n(n)} Punkte` : f.p(n, { one: "# point", other: "# points" })),
    /** @param {string[]} names @param {number} n */
    mostTwenties: (names, n) => (de ? `Die meisten 20er: ${f.list(names)} (${n})` : `Most 20s: ${f.list(names)} (${n})`),
    // The final
    reportCard: de ? "Zeugnis" : "Report card",
    school: de ? "Städtische Gesamtschule Classes" : "Classes Community School",
    /** @param {number} year */
    year: (year) => (de ? `Schuljahr ${year}/${String((year + 1) % 100).padStart(2, "0")}` : `School year ${year}–${String((year + 1) % 100).padStart(2, "0")}`),
    name: de ? "Name" : "Name",
    /** @param {number} r @param {number} n */
    rankOf: (r, n) => (de ? `Platz ${r} von ${n}` : `${ordinal(r)} of ${n}`),
    grades: de ? "Noten" : "Grades",
    /** @param {string} g */
    gradeWord: (g) => (de ? (/** @type {Record<string, string>} */ (GRADE_WORDS))[g] ?? "" : ""),
    remarksTitle: de ? "Bemerkungen" : "Remarks",
    stamp: de ? { promoted: "Versetzt", held: "Versetzung gefährdet" } : { promoted: "Promoted", held: "Held back?" },
    teacher: de ? "Klassenleitung" : "Form tutor",
    signature: de ? "Lämpel" : "M. Honeywell",
    best: de ? "Die besten Antworten des Tages" : "Best answers of the day",
    noBest: de ? "Heute keine Sterne. Streng, diese Klasse!" : "No stars today. Tough crowd!",
    allCards: de ? "Alle Zeugnisse" : "Everyone’s report card",
    /** @param {string} name */
    again: (name) => (de ? `Noch ein Schultag? ${name} startet ihn am Handy.` : `Another school day? ${name} starts it from the phone.`),
  };
}

/** @param {number} n English ordinals: 1st, 2nd, 3rd, 4th, 11th. */
function ordinal(n) {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${s}`;
}

/** @typedef {ReturnType<typeof strings>} Strings */
