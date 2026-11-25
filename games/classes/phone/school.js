// @ts-check
/**
 * The school's look, shared by the phone and the TV page (§4.4, §6.3 of
 * docs/classes-design.md): the subjects' cover colours, the players'
 * handwriting fonts (`people[id].hand`, 0–9) and the exercise books'
 * cover colours. The fonts' `@font-face` rules are in each page's
 * stylesheet (the files: `fonts/`).
 */

/**
 * The subjects' cover colours: the tab beside a column's title. `ink`
 * is the text on it.
 * @type {Record<string, { bg: string, ink: string }>}
 */
export const SUBJECTS = {
  geo: { bg: "#2f6db5", ink: "#fff" },
  bio: { bg: "#3a8f4a", ink: "#fff" },
  home: { bg: "#e07a1f", ink: "#fff" },
  music: { bg: "#7b4fb3", ink: "#fff" },
  media: { bg: "#d4508f", ink: "#fff" },
  sport: { bg: "#c8352e", ink: "#fff" },
  social: { bg: "#8a5a3b", ink: "#fff" },
  lang: { bg: "#e8c22e", ink: "#2a2414" },
  break: { bg: "#7cc3e8", ink: "#13324a" },
  trip: { bg: "#1f9a92", ink: "#fff" },
  register: { bg: "#8a8f96", ink: "#fff" },
  detention: { bg: "#222222", ink: "#fff" },
};

/** A subject's colours (an unknown one: grey). @param {unknown} id */
export function subjectColors(id) {
  return (typeof id === "string" && SUBJECTS[id]) || { bg: "#8a8f96", ink: "#fff" };
}

/**
 * The handwritings, by `hand`: the font family and a size factor that
 * makes them look about as big as each other (Caveat writes small,
 * Gloria Hallelujah wide).
 * @type {readonly { family: string, scale: number }[]}
 */
export const HANDS = [
  { family: "Patrick Hand", scale: 1.05 },
  { family: "Kalam", scale: 0.95 },
  { family: "Gochi Hand", scale: 1.05 },
  { family: "Indie Flower", scale: 1 },
  { family: "Architects Daughter", scale: 0.9 },
  { family: "Shadows Into Light Two", scale: 0.98 },
  { family: "Coming Soon", scale: 0.86 },
  { family: "Gloria Hallelujah", scale: 0.82 },
  { family: "Handlee", scale: 0.95 },
  { family: "Caveat", scale: 1.22 },
];

/** A hand by its number (anything else: the first). @param {unknown} n */
export function hand(n) {
  return HANDS[typeof n === "number" && n >= 0 && n < HANDS.length ? Math.floor(n) : 0] ?? { family: "Patrick Hand", scale: 1 };
}

/** The exercise books' covers, by `hand` (each player their own colour). */
export const COVERS = ["#c8352e", "#2f6db5", "#3a8f4a", "#e07a1f", "#7b4fb3", "#1f9a92", "#d4508f", "#8a5a3b", "#4a5568", "#b8860b"];

/** A player's cover colour by their `hand`. @param {unknown} n */
export function cover(n) {
  return COVERS[typeof n === "number" && n >= 0 ? Math.floor(n) % COVERS.length : 0] ?? "#c8352e";
}

/** The alphabet of the frieze. */
export const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

/**
 * The letter the frieze lights now (§3.1): `seq[floor((now − start) /
 * step) mod seq.length]`, before the start the first.
 * @param {{ start: number, step: number, seq: string[] } | undefined | null} run
 * @param {number} now
 */
export function litLetter(run, now) {
  if (!run || !Array.isArray(run.seq) || run.seq.length === 0 || !(run.step > 0)) return null;
  const k = Math.max(0, Math.floor((now - run.start) / run.step));
  return run.seq[k % run.seq.length] ?? null;
}
