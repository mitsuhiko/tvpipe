// @ts-check
/**
 * Small helpers of Classes' TV page: elements (`h`, `svg`), seeded
 * randomness (the same tilt and scribble every time a view is drawn),
 * and text that fits its box (words are read whole: smaller, never cut).
 */

/**
 * An element: attributes (`class`, `style` as an object of properties,
 * anything else as attributes; `false`/`null` left out) and children
 * (text is always text).
 * @param {string} tag
 * @param {Record<string, any>} [attrs]
 * @param {...(Node | string | null | undefined | false)} kids
 * @returns {HTMLElement}
 */
export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = v;
    else if (k === "style" && typeof v === "object") for (const [p, x] of Object.entries(v)) el.style.setProperty(p, String(x));
    else if (v !== false && v != null) el.setAttribute(k, String(v));
  }
  for (const kid of kids) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
  return el;
}

export const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * An SVG element with attributes and children.
 * @param {string} tag
 * @param {Record<string, string | number | null | undefined>} [attrs]
 * @param {...(Node | null | undefined | false)} kids
 * @returns {SVGElement}
 */
export function svg(tag, attrs = {}, ...kids) {
  const el = /** @type {SVGElement} */ (document.createElementNS(SVG_NS, tag));
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) el.setAttribute(k, String(v));
  for (const kid of kids) if (kid) el.append(kid);
  return el;
}

/** A 32-bit hash of a string (FNV-1a). @param {string} key */
export function hash(key) {
  let x = 2166136261;
  for (let i = 0; i < key.length; i++) x = Math.imul(x ^ key.charCodeAt(i), 16777619);
  return x >>> 0;
}

/** A stable pseudo-random number in [-1, 1) for a key (tilts that do not jump between views). @param {string} key */
export function jitter(key) {
  return (hash(key) / 4294967296) * 2 - 1;
}

/** A seeded generator of numbers in [0, 1) (mulberry32). @param {string} key */
export function rng(key) {
  let a = hash(key);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** "1:05" for a time left in ms (whole seconds up). @param {number} ms */
export function mmss(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Text that fits

/**
 * Elements marked `data-fit` keep their text whole and inside their box:
 * their font gets smaller (from the stylesheet's size, down to a third)
 * until it fits.
 *
 * - `"1"`: one line;
 * - `"2"`: at most two lines, broken between words;
 * - `"box"`: as many lines as the box's height takes.
 *
 * The box must have its width (and for `box` its height) from the layout,
 * not from the text.
 */
const MIN = 0.3;
/** @type {WeakMap<Element, string>} */
const fitted = new WeakMap();

/** @param {HTMLElement} el */
export function fitText(el) {
  const mode = el.dataset["fit"] ?? "1";
  const w = el.clientWidth;
  const hgt = el.clientHeight;
  if (!w) return;
  const key = `${mode}|${w}|${hgt}|${el.textContent}`;
  if (fitted.get(el) === key) return;
  el.style.fontSize = "";
  const cs = getComputedStyle(el);
  const base = parseFloat(cs.fontSize);
  if (!base) return;
  const line = (parseFloat(cs.lineHeight) || base * 1.2) / base;
  let size = base;
  // Handwriting and chalk fonts reach a little past their line (`slack`): that is no extra line.
  const over = () =>
    el.scrollWidth > el.clientWidth + 1 ||
    (mode === "2" && el.scrollHeight > size * line * 2 + size * 0.35) ||
    (mode === "box" && el.scrollHeight > el.clientHeight + Math.max(1, size * 0.12));
  // A first guess from the width (one line), then small steps.
  if (mode === "1" && el.scrollWidth > w) size = Math.max(base * MIN, (base * w) / el.scrollWidth);
  el.style.fontSize = `${size.toFixed(2)}px`;
  let guard = 80;
  while (guard-- > 0 && size > base * MIN && over()) {
    size = Math.max(base * MIN, size * 0.95);
    el.style.fontSize = `${size.toFixed(2)}px`;
  }
  fitted.set(el, key);
}

let queued = false;
/** Fits every `data-fit` element of the page in the next frame. */
export function refit() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    for (const el of document.querySelectorAll("[data-fit]")) fitText(/** @type {HTMLElement} */ (el));
  });
}

/** Keeps `data-fit` elements fitted: when added or changed, and when the fonts arrive. */
export function watchFit() {
  new MutationObserver(refit).observe(document.body, { childList: true, subtree: true, characterData: true });
  const again = () => {
    for (const el of document.querySelectorAll("[data-fit]")) fitted.delete(el);
    refit();
  };
  document.fonts?.ready.then(again);
  document.fonts?.addEventListener("loadingdone", again);
  refit();
}
