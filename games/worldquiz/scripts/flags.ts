/**
 * The flags' SVGs as the game ships them (scripts/data.ts writes them to
 * `data/flags/`).
 */

/**
 * The SVG with a `viewBox` on its root when it has none: `0 0 width
 * height`. Without one an SVG drawn in an `<img>` of another size is
 * not scaled by every browser but drawn at its own size and cut: a TV
 * showed only the top stripe of Austria's flag (all red) while the phone
 * showed it whole. Unchanged when the size is not plain numbers.
 */
export function withViewBox(svg: string): string {
  const m = /<svg\b[^>]*>/.exec(svg);
  if (!m || /\sviewBox\s*=/.test(m[0])) return svg;
  const size = (name: string) => {
    const v = new RegExp(`\\s${name}\\s*=\\s*["']\\s*([0-9.]+(?:e[0-9]+)?)\\s*(?:px)?\\s*["']`, "i").exec(m[0]);
    return v ? Number(v[1]) : NaN;
  };
  const w = size("width");
  const h = size("height");
  if (!(w > 0 && h > 0)) return svg;
  return svg.slice(0, m.index) + m[0].replace(/^<svg\b/, `<svg viewBox="0 0 ${w} ${h}"`) + svg.slice(m.index + m[0].length);
}
