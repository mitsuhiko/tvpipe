/**
 * What the host page says of Classes itself, per language (the room's):
 * the status beside the logo, the host's buttons and the settings'
 * labels. The page's own texts are @tvpipe/party's (`HostPage`).
 */

import { baseLang, type Base, type Lang } from "../game/rules.ts";

const PHASES: Record<Base, Record<string, string>> = {
  en: { lobby: "Lobby", final: "Report cards", letter: "the alphabet", board: "the board", write: "writing", bell: "the bell", vote: "grading", marked: "the red pen", report: "the report" },
  de: { lobby: "Lobby", final: "Zeugnisse", letter: "das Alphabet", board: "die Tafel", write: "Schreiben", bell: "die Klingel", vote: "Korrektur", marked: "der Rotstift", report: "die Noten" },
};

/** The status beside the logo: the lobby, the end, or the round, its letter and what happens in it. */
export function status(lang: Lang, phase: string, stage: string | null, round: number, rounds: number, letter: string | null, col: number | null, cols: number): string {
  const p = PHASES[baseLang(lang)];
  if (phase === "lobby" || phase === "final") return p[phase]!;
  const what = phase === "grade" ? `${p[stage ?? "vote"]} ${(col ?? 0) + 1}/${cols}` : (p[phase] ?? phase);
  return `${lang !== "en" ? "Runde" : "Round"} ${round}/${rounds}${letter ? ` · ${letter}` : ""} · ${what}`;
}

export function hostStrings(lang: Lang) {
  return lang !== "en"
    ? {
        teacher: "Lehrerpult",
        skip: "Spalte überspringen",
        skipHint: "Bei der Korrektur: diese Spalte zählt nicht (keine Punkte, nicht im Zeugnis).",
        end: "Runde beenden",
        endHint: "Gleich zu den Noten: was schon korrigiert ist, zählt; der Rest nicht.",
      }
    : {
        teacher: "The teacher's desk",
        skip: "Skip column",
        skipHint: "While grading: this column does not count (no points, not on the report cards).",
        end: "End the round",
        endHint: "Straight to the report: what was graded counts, the rest does not.",
      };
}
