/**
 * The screenshots for the games list (`play.ts --shots DIR`, see
 * docs/game-catalog.md): the TV at 1280×720 and the phone at 390×844, a
 * PNG each of at most 400 KiB (a WebP when the PNG is bigger).
 */

import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Tab } from "./browser.ts";

const SIZE = { tv: { width: 1280, height: 720 }, phone: { width: 390, height: 844 } } as const;
const LIMIT = 400 * 1024;

/**
 * Writes `DIR/NAME.png` (or `.webp`) from the tab at `kind`'s size (a
 * phone's tab draws at 2×, scaled down); the file's name. The tab comes to
 * the front first and gets `settle` ms: headless Chrome animates only the
 * front tab of a window. A scrolled page is taken as it is on the screen.
 */
export async function keep(tab: Tab, dir: string, name: string, kind: "tv" | "phone", settle = 1000): Promise<string> {
  await tab.send("Page.bringToFront");
  await new Promise((r) => setTimeout(r, settle));
  const clip = { ...SIZE[kind], scale: kind === "phone" ? 0.5 : 1 };
  for (const ext of ["png", "webp"]) rmSync(join(dir, `${name}.${ext}`), { force: true });
  // The clip is in the page's coordinates: from where the page is scrolled to.
  const at = await tab.eval<{ x: number; y: number }>(`({ x: scrollX, y: scrollY })`);
  const capture = async (o: { format?: "png" | "webp"; quality?: number } = {}) => {
    const r = await tab.send("Page.captureScreenshot", { format: o.format ?? "png", ...(o.quality === undefined ? {} : { quality: o.quality }), clip: { ...at, ...clip } });
    return Buffer.from(r.data, "base64");
  };
  let data = await capture();
  let file = `${name}.png`;
  for (const quality of [90, 80, 70]) {
    if (data.length <= LIMIT) break;
    data = await capture({ format: "webp", quality });
    file = `${name}.webp`;
  }
  if (data.length > LIMIT) throw new Error(`${file}: ${Math.round(data.length / 1024)} KiB, more than 400`);
  writeFileSync(join(dir, file), data);
  return file;
}
