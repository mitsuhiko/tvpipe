// @ts-check
/**
 * Worldquiz's cards for the phone and the TV: a card as the host sends it
 * (`CardView` in game/game.ts: one language, the deck's numbers and
 * ranks) drawn as a postcard, the five numbers with their icons and
 * ranks, and the numbers written the way each language writes them.
 */

/** @typedef {"en" | "de"} Lang */
/** @typedef {"population" | "area" | "neighbours" | "highest" | "gdp"} Fact */

export const FACTS = /** @type {const} */ (["population", "area", "neighbours", "highest", "gdp"]);
/** A strong number: in the top this many (game/rules.ts STRONG). */
export const STRONG = 10;

export const LABELS = {
  en: { population: "Population", area: "Area", neighbours: "Neighbours", highest: "Highest point", gdp: "GDP per person" },
  de: { population: "Einwohner", area: "Fläche", neighbours: "Nachbarländer", highest: "Höchster Punkt", gdp: "BIP pro Kopf" },
};

/** Short labels for buttons and badges. */
export const SHORT = {
  en: { population: "Population", area: "Area", neighbours: "Neighbours", highest: "Highest", gdp: "GDP" },
  de: { population: "Einwohner", area: "Fläche", neighbours: "Nachbarn", highest: "Höhe", gdp: "BIP" },
};

/** The icons, drawn like the map: flat colours, ink outlines. */
export const ICONS = {
  population:
    '<svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="14" cy="13" r="6" fill="#c8b4ea" stroke="#263450" stroke-width="3"/><circle cx="27" cy="15" r="5" fill="#f4a6a0" stroke="#263450" stroke-width="3"/><path d="M3 34c0-8 5-12 11-12s11 4 11 12z" fill="#c8b4ea" stroke="#263450" stroke-width="3" stroke-linejoin="round"/><path d="M22 34c0-5 2-9 5-10 5 0 10 3 10 10z" fill="#f4a6a0" stroke="#263450" stroke-width="3" stroke-linejoin="round"/></svg>',
  area: '<svg viewBox="0 0 40 40" aria-hidden="true"><path d="M5 9l9-4 12 4 9-4v26l-9 4-12-4-9 4z" fill="#a8dd8c" stroke="#263450" stroke-width="3" stroke-linejoin="round"/><path d="M14 5v26M26 9v26" stroke="#263450" stroke-width="2.5"/></svg>',
  neighbours:
    '<svg viewBox="0 0 40 40" aria-hidden="true"><path d="M4 8h14l-2 10 3 14H4z" fill="#f6d97b" stroke="#263450" stroke-width="3" stroke-linejoin="round"/><path d="M18 8h18v24H19l-3-14z" fill="#f4a6a0" stroke="#263450" stroke-width="3" stroke-linejoin="round"/></svg>',
  highest:
    '<svg viewBox="0 0 40 40" aria-hidden="true"><path d="M3 34 15 12l6 9 5-6 11 19z" fill="#9fd8cf" stroke="#263450" stroke-width="3" stroke-linejoin="round"/><path d="m12 17 3-5 3 4.5-3 1.5z" fill="#fff" stroke="#263450" stroke-width="2" stroke-linejoin="round"/></svg>',
  gdp: '<svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="15" fill="#ffcf4a" stroke="#263450" stroke-width="3"/><path d="M24 14c-1-2-8-2-8 2s8 2 8 6-7 4-8 2M20 10v20" fill="none" stroke="#263450" stroke-width="2.6" stroke-linecap="round"/></svg>',
};

/** The icons of the newer kinds of challenge (§4.5–4.10), for the phone and the TV. */
export const KIND_ICONS_MORE = {
  pickflag:
    '<svg viewBox="0 0 40 40" aria-hidden="true"><rect x="3" y="5" width="15" height="11" rx="2" fill="#ef4444" stroke="#263450" stroke-width="2.5"/><rect x="22" y="5" width="15" height="11" rx="2" fill="#3b82f6" stroke="#263450" stroke-width="2.5"/><rect x="3" y="22" width="15" height="11" rx="2" fill="#22c55e" stroke="#263450" stroke-width="2.5"/><rect x="22" y="22" width="15" height="11" rx="2" fill="#ffcf4a" stroke="#263450" stroke-width="3.5"/><path d="M26 28l3 3 6-7" fill="none" stroke="#263450" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  shape:
    '<svg viewBox="0 0 40 40" aria-hidden="true"><path d="M8 10l9-4 6 5 9-1 2 9-5 5 2 8-9 2-5-5-7 2-3-9 4-5z" fill="#ff7a45" stroke="#263450" stroke-width="3" stroke-linejoin="round"/><text x="20" y="25" text-anchor="middle" font-size="13" font-weight="900" fill="#fff" font-family="sans-serif">?</text></svg>',
  bigger:
    '<svg viewBox="0 0 40 40" aria-hidden="true"><rect x="3" y="24" width="7" height="12" rx="1.5" fill="#a8dd8c" stroke="#263450" stroke-width="2.5"/><rect x="12" y="16" width="7" height="20" rx="1.5" fill="#f6d97b" stroke="#263450" stroke-width="2.5"/><rect x="21" y="6" width="7" height="30" rx="1.5" fill="#ff7a45" stroke="#263450" stroke-width="2.5"/><rect x="30" y="20" width="7" height="16" rx="1.5" fill="#c8b4ea" stroke="#263450" stroke-width="2.5"/></svg>',
  guess:
    '<svg viewBox="0 0 40 40" aria-hidden="true"><path d="M4 26h32" stroke="#263450" stroke-width="4" stroke-linecap="round"/><path d="M4 26h18" stroke="#ff7a45" stroke-width="4" stroke-linecap="round"/><circle cx="22" cy="26" r="6" fill="#fff" stroke="#263450" stroke-width="3"/><path d="M15 6h14l-7 8z" fill="#ffcf4a" stroke="#263450" stroke-width="2.5" stroke-linejoin="round"/></svg>',
  neighbour:
    '<svg viewBox="0 0 40 40" aria-hidden="true"><path d="M4 8h14l-2 10 3 14H4z" fill="#ff7a45" stroke="#263450" stroke-width="3" stroke-linejoin="round"/><path d="M18 8h18v24H19l-3-14z" fill="#ffcf4a" stroke="#263450" stroke-width="3" stroke-linejoin="round"/><path d="M24 16l4 4-4 4" fill="none" stroke="#263450" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  odd:
    '<svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="11" cy="12" r="7" fill="#a8dd8c" stroke="#263450" stroke-width="2.5"/><circle cx="29" cy="12" r="7" fill="#a8dd8c" stroke="#263450" stroke-width="2.5"/><circle cx="11" cy="29" r="7" fill="#a8dd8c" stroke="#263450" stroke-width="2.5"/><rect x="22" y="22" width="14" height="14" rx="2" fill="#ef4444" stroke="#263450" stroke-width="2.5" transform="rotate(12 29 29)"/></svg>',
};
/** A little globe for the logo. */
export const GLOBE =
  '<svg class="globe" viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="17" fill="#6cc7e8" stroke="#263450" stroke-width="4"/><path d="M9 12c5 0 6 4 10 4s3 5 0 7-1 6-4 9M26 6c-2 3 1 5 4 5s4 4 7 4M27 25c3 0 5 2 4 6" fill="none" stroke="#263450" stroke-width="3" stroke-linecap="round"/><path d="M9 12c5 0 6 4 10 4s3 5 0 7-1 6-4 9-8-6-9-10 0-8 3-10z" fill="#a8dd8c"/></svg>';

/**
 * Numbers in a language.
 * @param {Lang} lang
 */
export function numbers(lang) {
  const nf = new Intl.NumberFormat(lang);
  const one = new Intl.NumberFormat(lang, { maximumFractionDigits: 1, minimumFractionDigits: 1 });
  const two = new Intl.NumberFormat(lang, { maximumFractionDigits: 2, minimumFractionDigits: 2 });
  const small = new Intl.NumberFormat(lang, { maximumFractionDigits: 2 });
  /** @param {number} n */
  const people = (n) => {
    if (n >= 1e9) return lang === "de" ? `${two.format(n / 1e9)} Mrd.` : `${two.format(n / 1e9)} billion`;
    if (n >= 1e6) return lang === "de" ? `${one.format(n / 1e6)} Mio.` : `${one.format(n / 1e6)} million`;
    return nf.format(n < 10_000 ? Math.round(n) : Math.round(n / 1000) * 1000);
  };
  return {
    n: (/** @type {number} */ x) => nf.format(x),
    /**
     * A fact's number as the card writes it.
     * @param {Fact} fact @param {number} v
     */
    fact(fact, v) {
      switch (fact) {
        case "population":
          return people(v);
        case "area":
          return `${v < 10 ? small.format(v) : nf.format(Math.round(v))} km²`;
        case "neighbours":
          return nf.format(v);
        case "highest":
          return `${nf.format(Math.round(v))} m`;
        case "gdp":
          // 0: no figure (the Vatican has a budget, not an economy).
          if (!v) return "–";
          return lang === "de" ? `${nf.format(Math.round(v))} $` : `$${nf.format(Math.round(v))}`;
      }
    },
    km: (/** @type {number} */ v) => `${nf.format(Math.round(v))} km`,
  };
}

/**
 * @param {string} tag
 * @param {Record<string, any>} [attrs]
 * @param {...(Node | string | null | undefined | false)} kids
 * @returns {HTMLElement}
 */
export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v;
    else if (k === "style" && typeof v === "object") for (const [p, x] of Object.entries(v)) el.style.setProperty(p, String(x));
    else if (v === true) el.setAttribute(k, "");
    else if (v !== false && v != null) el.setAttribute(k, String(v));
  }
  for (const kid of kids) if (kid) el.append(kid);
  return el;
}

/** A flag's picture (files in data/flags/, from the page's folder). @param {string} file */
export function flagSrc(file) {
  return new URL(`../data/flags/${encodeURIComponent(file)}`, import.meta.url).href;
}

/**
 * A card as a postcard.
 * @param {any} card the CardView
 * @param {Lang} lang
 * @param {{ stamp?: string, pick?: Fact | null, dim?: boolean, only?: Fact | null, hideRanks?: boolean, note?: string }} [o] `pick` outlines a number and dims the others (not with `dim: false`)
 */
export function cardEl(card, lang, o = {}) {
  const L = LABELS[lang];
  const f = numbers(lang);
  const rows = FACTS.filter((k) => !o.only || k === o.only).map((k) => {
    const rank = card.ranks?.[k] ?? 0;
    const sub = k === "highest" ? card.highest : k === "gdp" && card.gdpYear ? String(card.gdpYear) : "";
    return h(
      "div",
      { class: `fact${o.pick === k ? " pick" : o.pick && o.dim !== false ? " dim" : ""}`, "data-fact": k },
      h("span", { html: ICONS[k] }),
      h("div", { class: "l" }, L[k], sub ? h("i", {}, sub) : null),
      h("div", { class: "v" }, f.fact(k, card.facts?.[k] ?? 0)),
      o.hideRanks || !rank ? h("span") : h("span", { class: `rank${rank <= STRONG ? " gold" : ""}` }, `#${rank}`),
    );
  });
  return h(
    "div",
    { class: "wq-card" },
    o.stamp ? h("div", { class: "stamp" }, o.stamp) : null,
    h("img", { class: "flag", src: flagSrc(card.flag), alt: "" }),
    h("h2", { "data-fit": "1" }, card.name),
    h("div", { class: "cap" }, h("span", { class: "star" }, "★ "), (card.capitals ?? []).join(" · ")),
    h("div", { class: "facts" }, ...rows),
    o.note ? h("div", { class: "note" }, o.note) : null,
  );
}
