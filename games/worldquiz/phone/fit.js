// @ts-check
/**
 * Words that always fit. A word a player has to read (the word to draw,
 * the word a drawing was, the blanks) is never cut off with an ellipsis
 * and never broken in the middle ("Schraubenschlüs- sel"): its font
 * gets smaller until it fits its box instead. The phone and the TV mark
 * such elements with `data-fit`:
 *
 * - `"1"`: on one line;
 * - `"2"`: on at most two lines, broken only between words;
 * - `"w"`: as many lines as it takes, but nothing wider than the box
 *   (the blanks: a word's letters stay together).
 *
 * {@link watchFit} fits them when they appear, when their text or their
 * box changes, and when the font has loaded.
 */

/** The smallest a font gets, as a share of its size. */
const MIN = 0.4;

/** What was fitted: the text and the box it was fitted for. @type {WeakMap<Element, string>} */
const done = new WeakMap();

/**
 * Fits one element (it must be laid out, with a width of its own).
 * @param {HTMLElement} el
 */
export function fitText(el) {
  const mode = el.dataset["fit"] ?? "1";
  const width = el.clientWidth;
  if (!width) return;
  const key = `${mode}|${width}|${el.textContent}|${el.childElementCount}`;
  if (done.get(el) === key) return;
  el.style.fontSize = "";
  const cs = getComputedStyle(el);
  const base = parseFloat(cs.fontSize);
  if (!base) return;
  // The line height as a share of the font's (`normal`: about 1.2).
  const line = (parseFloat(cs.lineHeight) || base * 1.2) / base;
  const lines = mode === "2" ? 2 : 0;
  let size = base;
  const over = () => el.scrollWidth > el.clientWidth + 1 || (lines > 0 && el.scrollHeight > size * line * lines + 2);
  while (size > base * MIN && over()) {
    size = Math.max(base * MIN, size * 0.94);
    el.style.fontSize = `${size.toFixed(2)}px`;
  }
  done.set(el, `${mode}|${el.clientWidth}|${el.textContent}|${el.childElementCount}`);
}

let queued = false;
function refit() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    for (const el of document.querySelectorAll("[data-fit]")) fitText(/** @type {HTMLElement} */ (el));
  });
}

/**
 * Keeps every `data-fit` element of the page fitted: after anything is
 * added or its text changes, after a resize, and when fonts arrive (a
 * fallback font has other widths).
 */
export function watchFit() {
  new MutationObserver(refit).observe(document.body, { childList: true, subtree: true, characterData: true });
  window.addEventListener("resize", refit);
  document.fonts?.ready.then(() => {
    for (const el of document.querySelectorAll("[data-fit]")) done.delete(el);
    refit();
  });
  document.fonts?.addEventListener("loadingdone", () => {
    for (const el of document.querySelectorAll("[data-fit]")) done.delete(el);
    refit();
  });
  refit();
}
