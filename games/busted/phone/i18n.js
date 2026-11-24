// @ts-check
/**
 * Languages for Busted's phone and TV pages (their string tables:
 * `phone/strings.js`, `screen/strings.js`): which language, numbers,
 * plurals and lists the way the language writes them (Intl). The room's
 * language comes with the views (`room.lang`, `screen.lang`), the same on
 * every phone; the host page or the VIP sets it (game/rules.ts `LANGS`,
 * `pickLang`).
 */

/** @typedef {"en" | "de"} Lang */

/** The languages there are strings (and words) for. */
export const LANGS = /** @type {const} */ (["en", "de"]);

/**
 * A language tag (`de-AT`, `en`, …) as one of {@link LANGS}: German for `de…`, else English.
 * @param {unknown} tag
 * @returns {Lang}
 */
export function pickLang(tag) {
  return typeof tag === "string" && /^de\b/i.test(tag) ? "de" : "en";
}

/** The browser's language, as one of {@link LANGS}. */
export function browserLang() {
  return pickLang(globalThis.navigator?.languages?.[0] ?? globalThis.navigator?.language);
}

/**
 * Formatting in a language: `n(1000)` "1,000" / "1.000", `p(n, forms)`
 * the plural form for `n` (`#` is the number: `{ one: "# player",
 * other: "# players" }`), `list(names)` "Ada, Bo and Cy" / "Ada, Bo und Cy".
 * @param {Lang} lang
 */
export function format(lang) {
  const nf = new Intl.NumberFormat(lang);
  const pr = new Intl.PluralRules(lang);
  const lf = new Intl.ListFormat(lang, { style: "long", type: "conjunction" });
  return {
    lang,
    /** @param {number} x */
    n: (x) => nf.format(x),
    /**
     * @param {number} x
     * @param {{ zero?: string, one?: string, two?: string, few?: string, many?: string, other: string }} forms
     */
    p: (x, forms) => (forms[pr.select(x)] ?? forms.other).replaceAll("#", nf.format(x)),
    /** @param {readonly string[]} xs */
    list: (xs) => lf.format(xs),
  };
}

/** @typedef {ReturnType<typeof format>} Format */
