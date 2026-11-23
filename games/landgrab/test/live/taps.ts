/**
 * Taps on the phone's plan map for the live tests: the map is a canvas,
 * so a territory is tapped at its badge, from the camera the map last
 * rests at (the canvas's `data-view`, "scale,ox,oy", there only while it
 * rests).
 */

/** JS for the phone's page: taps territory `id`; true when it could. */
export function tapTerritory(id: string): string {
  return `(async () => {
    const { parseWorld, hexCenter } = await import(new URL("../game/world.js", location.href).href);
    globalThis.__landgrabWorld ??= parseWorld(await (await fetch(new URL("../data/world.txt", location.href))).text());
    const terr = globalThis.__landgrabWorld.byId.get(${JSON.stringify(id)});
    const c = document.querySelector(".minimap.plan");
    // The camera at rest (it may be flying, or following a resize).
    for (let i = 0; i < 40 && c && !c.dataset.view; i++) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 100));
    const [s, ox, oy] = (c?.dataset.view ?? "").split(",").map(Number);
    if (!terr || !c || !s) return false;
    const [x, y] = hexCenter(terr.anchor[0], terr.anchor[1], 1);
    const r = c.getBoundingClientRect();
    c.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: r.left + ox + x * s, clientY: r.top + oy + y * s }));
    return true;
  })()`;
}
