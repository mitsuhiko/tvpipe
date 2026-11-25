/**
 * The layout checks of the live checks (preview.ts, watch.ts), run in a
 * page: nothing off the screen (a page that `scrolls` only sideways), no
 * text cut or wider than its box, no ellipsis, `data-fit` text that
 * fits, nothing with text under the join badge. Elements that are moving
 * (finite animations) are skipped; `data-nocheck` opts out.
 */

/** The checks, run in the page: a list of what is wrong. */
export const CHECK = (scrolls: boolean) => `(() => {
  const out = [];
  const W = innerWidth, H = innerHeight;
  const de = document.documentElement;
  if (de.scrollWidth > W + 1) out.push("the page is wider than the screen: " + de.scrollWidth);
  if (!${scrolls} && de.scrollHeight > H + 1) out.push("the page is taller than the screen: " + de.scrollHeight);
  const moving = document.getAnimations().filter((a) => a.playState === "running" && a.effect?.getTiming?.().iterations !== Infinity).map((a) => a.effect?.target).filter((x) => x instanceof Element);
  const still = (el) => !moving.some((m) => m === el || m.contains(el) || el.contains(m));
  const badge = document.querySelector("tvpipe-rejoin")?.shadowRoot?.querySelector(".mini.shown")?.getBoundingClientRect();
  const name = (el) => el.localName + (el.id ? "#" + el.id : "") + (typeof el.className === "string" && el.className ? "." + el.className.trim().split(/\\s+/).join(".") : "") + " " + JSON.stringify((el.textContent || "").trim().slice(0, 40));
  const ownText = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
  for (const el of document.querySelectorAll("body *")) {
    if (el.closest("svg, [data-nocheck], tvpipe-rejoin, script, style")) continue;
    if (!el.checkVisibility || !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const cs = getComputedStyle(el);
    if (still(el)) {
      if (r.right > W + 2 || r.left < -2 || (!${scrolls} && (r.bottom > H + 2 || r.top < -2))) out.push("off the screen: " + name(el));
    }
    if (!ownText(el) && !el.hasAttribute("data-fit")) continue;
    if (cs.textOverflow === "ellipsis") out.push("cut with an ellipsis: " + name(el));
    if (cs.display !== "inline" && el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 2) out.push("text wider than its box (" + el.scrollWidth + " > " + el.clientWidth + "): " + name(el));
    if (cs.display !== "inline" && el.clientHeight > 0 && cs.overflowY !== "visible" && cs.overflowY !== "auto" && cs.overflowY !== "scroll" && el.scrollHeight > el.clientHeight + 2) out.push("text cut at the bottom (" + el.scrollHeight + " > " + el.clientHeight + "): " + name(el));
    if (badge && still(el) && r.left < badge.right && r.right > badge.left && r.top < badge.bottom && r.bottom > badge.top) out.push("under the join badge: " + name(el));
  }
  return out;
})()`;
