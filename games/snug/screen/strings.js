// @ts-check
/**
 * What Snug's TV says, in English and German. The room's language comes
 * with the screen view (`screen.lang`).
 */

import { format } from "../phone/i18n.js";

/** @param {"en" | "de"} lang */
export function strings(lang) {
  const f = format(lang);
  if (lang === "de") {
    return {
      ...f,
      tagline: "Füllt die Form gemeinsam. Eure Teile sieht niemand, bis sie liegen.",
      scanToJoin: "Scannen und mitspielen",
      players: "Mitspieler",
      /** @param {number} k */
      needed: (k) => f.p(k, { one: "Noch # fehlt", other: "Noch # fehlen" }),
      /** @param {string | undefined} name */
      vipStarts: (name) => (name ? `${name} startet am Handy` : "Der VIP startet am Handy"),
      how: [
        ["Eine Form", "Alle sehen dieselbe Form. Jeder hat eigene Teile, geheim auf dem Handy."],
        ["Reden!", "Beschreibt eure Teile, zeigt mit dem Finger auf Felder, legt sie hin."],
        ["Gegen die Uhr", "Jede volle Form bringt Zeit zurück. Wie viele schafft ihr?"],
      ],
      levels: { easy: "Leicht", normal: "Normal", hard: "Schwer" },
      levelLabel: "Stufe:",
      paceLabel: "Uhr:",
      paces: { relaxed: "Gemütlich", normal: "Normal", rushed: "Hektisch" },
      board: "Form",
      /** @param {number} n */
      boardN: (n) => `Form ${n}`,
      /** @param {number} n */
      solvedN: (n) => f.p(n, { one: "# geschafft", other: "# geschafft" }),
      snug: "Kuschelig!",
      /** @param {number} s */
      back: (s) => `+${s} s`,
      spares: "Nicht gebraucht",
      timesUp: "Die Zeit ist um!",
      couldHave: "So hätte es gepasst",
      /** @param {string} name */
      stuck: (name) => `${name} hat geprüft: Da hakt was. So geht es nicht mehr auf.`,
      /** @param {string} name */
      open: (name) => `${name} hat geprüft: Das kann noch aufgehen!`,
      /** @param {number} n */
      checksN: (n) => `Prüfen: ${n}`,
      checksAny: "Prüfen: beliebig",
      earned: "+1 Prüfen",
      /** @param {string} name */
      finished: (name) => `${name} hat das letzte Teil gelegt`,
      /** @param {string} name @param {number} n */
      handedTo: (name, n) => `${name} ist weg: ${f.p(n, { one: "# Teil", other: "# Teile" })} weitergegeben`,
      gameOver: "Geschafft!",
      /** @param {number} n */
      boardsDone: (n) => f.p(n, { one: "# Form gefüllt", other: "# Formen gefüllt" }),
      noneDone: "Keine Form gefüllt. Nächstes Mal!",
      /** @param {number} n */
      best: (n) => `Bestes heute: ${n}`,
      newBest: "Neuer Rekord heute!",
      awards: {
        fit: ["Passt perfekt", "die meisten letzten Teile"],
        pointer: ["Zeigefinger", "die meisten Pings"],
        thoughts: ["Nochmal überlegt", "am öftesten hochgehoben"],
      },
      again: "Der VIP startet die nächste Runde am Handy",
      reconnecting: "Verbinde …",
      over: "Das Spiel ist vorbei",
      pieces: "Teile",
      left: "übrig",
    };
  }
  return {
    ...f,
    tagline: "Fill the shape together. Nobody sees your pieces until they're placed.",
    scanToJoin: "Scan to play",
    players: "Players",
    /** @param {number} k */
    needed: (k) => f.p(k, { one: "# more to go", other: "# more to go" }),
    /** @param {string | undefined} name */
    vipStarts: (name) => (name ? `${name} starts on their phone` : "The VIP starts on their phone"),
    how: [
      ["One shape", "Everyone sees the same shape. Your pieces are secret, on your phone."],
      ["Talk!", "Describe your pieces, point at cells with your finger, drop them in."],
      ["Beat the clock", "Every shape you fill gives time back. How many can you do?"],
    ],
    levels: { easy: "Easy", normal: "Normal", hard: "Hard" },
    levelLabel: "Level:",
    paceLabel: "Clock:",
    paces: { relaxed: "Relaxed", normal: "Normal", rushed: "Rushed" },
    board: "Shape",
    /** @param {number} n */
    boardN: (n) => `Shape ${n}`,
    /** @param {number} n */
    solvedN: (n) => `${n} done`,
    snug: "Snug!",
    /** @param {number} s */
    back: (s) => `+${s} s`,
    spares: "Not needed",
    timesUp: "Time's up!",
    couldHave: "It would have gone like this",
    /** @param {string} name */
    stuck: (name) => `${name} checked: something's stuck. It can't work out like this.`,
    /** @param {string} name */
    open: (name) => `${name} checked: it can still work out!`,
    /** @param {number} n */
    checksN: (n) => `Checks: ${n}`,
    checksAny: "Checks: any",
    earned: "+1 check",
    /** @param {string} name */
    finished: (name) => `${name} placed the last piece`,
    /** @param {string} name @param {number} n */
    handedTo: (name, n) => `${name} is away: ${f.p(n, { one: "# piece", other: "# pieces" })} passed on`,
    gameOver: "That's a wrap!",
    /** @param {number} n */
    boardsDone: (n) => f.p(n, { one: "# shape filled", other: "# shapes filled" }),
    noneDone: "No shape filled. Next time!",
    /** @param {number} n */
    best: (n) => `Best today: ${n}`,
    newBest: "New best today!",
    awards: {
      fit: ["Snuggest fit", "the most last pieces"],
      pointer: ["Pointer", "the most pings"],
      thoughts: ["Second thoughts", "the most lifts"],
    },
    again: "The VIP starts the next game on their phone",
    reconnecting: "Reconnecting…",
    over: "The game is over",
    pieces: "pieces",
    left: "left",
  };
}
