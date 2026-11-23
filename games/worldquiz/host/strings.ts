/**
 * What the host page says of Worldquiz itself, per language (the
 * room's): the status beside the logo. The page's own texts and the
 * settings' labels are @tvpipe/party's (`HostPage`) and `host.ts`'s.
 */

import type { Lang } from "../game/rules.ts";

const STAGES: Record<Lang, Record<string, string>> = {
  en: { lobby: "Lobby", final: "Game over", draw: "the captain chooses", compete: "comparing cards", discard: "cards discarded", challenge: "a challenge", answer: "the answer", tiebreak: "the tie-break" },
  de: { lobby: "Lobby", final: "Spielende", draw: "Kapitän wählt", compete: "Karten vergleichen", discard: "Karten abgelegt", challenge: "eine Herausforderung", answer: "die Auflösung", tiebreak: "das Stechen" },
};

/** The status beside the logo: the lobby, the end, or the round and what happens in it. */
export function status(lang: Lang, phase: string, stage: string | null, round: number, rounds: number): string {
  const p = STAGES[lang] ?? STAGES.en;
  if (phase === "lobby" || phase === "final") return p[phase]!;
  return `${lang === "de" ? "Runde" : "Round"} ${round}/${rounds} · ${p[stage ?? ""] ?? stage ?? ""}`;
}
