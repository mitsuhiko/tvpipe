// @ts-check
/**
 * Words that always fit (as in Krakel). A word a player has to read (a
 * column's title, an answer, a name) is never cut off with an ellipsis
 * and never broken in the middle ("Donaudampfschiff- fahrt"): its font
 * gets smaller until it fits its box instead. The phone and the TV mark
 * such elements with `data-fit`:
 *
 * - `"1"`: on one line;
 * - `"2"`: on at most two lines, broken only between words;
 * - `"w"`: as many lines as it takes, but nothing wider than the box
 *   (a long word's letters stay together).
 *
 * {@link watchFit} fits them when they appear, when their text or their
 * box changes, and when the font has loaded. {@link fitInput} does the
 * same for a typed field: its font gets smaller as the text outgrows it.
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

/** A canvas to measure typed text with. @type {CanvasRenderingContext2D | null} */
let measure = null;

/**
 * Fits a text field's font to its text: the stylesheet's size while it
 * fits, smaller (down to {@link MIN} of it) as the text outgrows the box.
 * @param {HTMLInputElement} input
 */
export function fitInput(input) {
  input.style.fontSize = "";
  const cs = getComputedStyle(input);
  const base = parseFloat(cs.fontSize);
  const room = input.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 2;
  if (!base || room <= 0 || !input.value) return;
  measure ??= document.createElement("canvas").getContext("2d");
  if (!measure) return;
  measure.font = `${cs.fontStyle} ${cs.fontWeight} ${base}px ${cs.fontFamily}`;
  const width = measure.measureText(input.value).width;
  if (width <= room) return;
  input.style.fontSize = `${Math.max(base * MIN, (base * room) / width).toFixed(2)}px`;
}
