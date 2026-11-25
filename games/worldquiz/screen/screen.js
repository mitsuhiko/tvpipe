// @ts-check
/**
 * Worldquiz's TV page: tvpipe casts it with its own browser, or anyone
 * opens the watch link (the host page's preview, muted). It shows the
 * screen view (`{ roster, screen, join }`, game/game.ts) in the room's
 * language over the cartoon world (`map.js`): the lobby with the join
 * code; a round's card backs while the captain chooses; compared cards
 * one by one with the camera flying to each country; discarded hands
 * with their strong numbers called out; challenges and their answers
 * (the whole card, typed answers read back, a flag planted on the
 * country and a line from every pin to it); who still has to press Next;
 * the planes' trip along the bottom the whole game; the final podium.
 * Players' texts are always text.
 */

import { joinText, PartyClient, qrSvg } from "/_tvpipe/lib/client.js";
import { cardEl, FACTS, flagSrc, GLOBE, h, ICONS, KIND_ICONS_MORE, LABELS, numbers, STRONG } from "../phone/cards.js";
import { watchFit } from "../phone/fit.js";
import { pickLang } from "../phone/i18n.js";
import { decodeRings, decodeShapes, WorldMap } from "./map.js";
import { strings } from "./strings.js";

const params = new URLSearchParams(location.hash.slice(1));
// tvpipe's join badge sits bottom left the whole game: the trip's route starts right of it.
const client = PartyClient.fromLocation({ role: /** @type {any} */ (params.get("role") ?? "screen"), rejoinBadge: { corner: "bottom-left" } });
const stage = /** @type {HTMLElement} */ (document.getElementById("stage"));
const hud = /** @type {HTMLElement} */ (document.getElementById("hud"));
const race = /** @type {HTMLElement} */ (document.getElementById("race"));
const statusBar = /** @type {HTMLElement} */ (document.getElementById("status"));
const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById("map"));

/** @type {"en" | "de"} */
let lang = pickLang(undefined);
let t = strings(lang);
let f = numbers(lang);

// ---------------------------------------------------------------------------
// The map

/** @type {WorldMap | null} */
let map = null;
fetch(new URL("../data/shapes.json", import.meta.url))
  .then((r) => r.json())
  .then((shapes) => {
    map = new WorldMap(canvas, decodeShapes(shapes), { mode: "flat" });
    fitMap();
    map.flyWorld(0);
    map.start();
    if (client.view) render(client.view);
  })
  .catch(() => {});
function fitMap() {
  map?.resize(innerWidth, innerHeight);
}
addEventListener("resize", fitMap);

/** Points the map at a country (or the world). @param {any} c @param {number} [ms] @param {number} [fill] @param {number} [maxZoom] */
function look(c, ms = 1700, fill, maxZoom) {
  if (!map) return;
  if (!c?.box) map.flyWorld(ms);
  else map.flyTo(c.box, c.at, ms, fill, maxZoom);
}

// ---------------------------------------------------------------------------
// Sound: a few synthesized cues through one compressor (the preview is muted).

const MUTED = params.get("mute") === "1";
/** @type {AudioContext | null} */
let audio = null;
/** @type {AudioNode | null} */
let master = null;
function ac() {
  if (MUTED) return null;
  try {
    if (!audio) {
      const a = new AudioContext();
      const comp = a.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.ratio.value = 4;
      const out = a.createGain();
      out.gain.value = 0.8;
      out.connect(comp).connect(a.destination);
      audio = a;
      master = out;
    }
    if (audio.state === "suspended") void audio.resume();
    return audio;
  } catch {
    return null;
  }
}
addEventListener("pointerdown", () => void ac(), { once: true });
/** @param {number} from @param {number} to @param {number} len @param {OscillatorType} [type] @param {number} [vol] @param {number} [delay] */
function tone(from, to, len, type = "sine", vol = 0.14, delay = 0) {
  const a = ac();
  if (!a || !master) return;
  const at = a.currentTime + 0.02 + delay;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(from, at);
  o.frequency.exponentialRampToValueAtTime(to, at + len);
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(vol, at + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, at + len);
  o.connect(g).connect(master);
  o.start(at);
  o.stop(at + len + 0.05);
}
const sfx = {
  pop: () => tone(520, 880, 0.12, "triangle", 0.16),
  flip: () => tone(300, 620, 0.09, "square", 0.05),
  ding: () => {
    tone(880, 880, 0.25, "sine", 0.18);
    tone(1320, 1320, 0.4, "sine", 0.14, 0.12);
  },
  fanfare: () => [523, 659, 784, 1047].forEach((n, i) => tone(n, n, 0.3, "triangle", 0.14, i * 0.11)),
  buzz: () => tone(150, 110, 0.45, "sawtooth", 0.08),
  whoosh: () => tone(200, 900, 0.35, "sine", 0.06),
  tick: () => tone(1500, 1500, 0.04, "square", 0.04),
  strong: () => [784, 988, 1175].forEach((n, i) => tone(n, n, 0.2, "triangle", 0.12, i * 0.08)),
};

// ---------------------------------------------------------------------------
// Helpers

const isColor = (/** @type {unknown} */ c) => typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c);
/** @param {string | undefined} id */
function colorOf(id) {
  const c = id ? client.view?.screen?.colors?.[id] : undefined;
  return isColor(c) ? c : "#7c8696";
}
/** @param {string | undefined} id */
function nameOf(id) {
  const p = (client.view?.screen?.players ?? []).find((/** @type {any} */ x) => x.id === id) ?? (client.view?.roster ?? []).find((/** @type {any} */ x) => x.id === id);
  return p?.name ?? "?";
}
const initial = (/** @type {string} */ name) => [...(name ?? "?").trim()][0]?.toUpperCase() ?? "?";
/** A player's chip. @param {string} id @param {...(Node | string | null)} extra */
function chip(id, ...extra) {
  return h("span", { class: "chip", style: { "--c": colorOf(id) } }, h("b", { class: "dot" }, initial(nameOf(id))), h("span", { class: "nm" }, nameOf(id)), ...extra);
}
function logo() {
  return h("div", { class: "wq-logo" }, "W", h("span", { html: GLOBE }), "rldquiz");
}

/** @type {number[]} */
let timers = [];
/** @param {() => void} fn @param {number} ms */
function later(fn, ms) {
  timers.push(/** @type {any} */ (setTimeout(fn, ms)));
}

// ---------------------------------------------------------------------------
// The HUD: the round and the clock

const clock = h("div", { class: "clock", hidden: true });
const roundLabel = h("div", { class: "round" });
const nextBar = h("div", { class: "nextbar", hidden: true });
hud.append(h("div", { class: "brand" }, logo()), roundLabel, nextBar, clock);

/** Who still has to press Next on their phone (the stages that wait for it). @param {any} sc */
function drawNext(sc) {
  const who = /** @type {string[]} */ (sc.phase === "round" && sc.next ? (sc.nextFor ?? []) : []);
  const there = new Set((sc.players ?? []).filter((/** @type {any} */ p) => !p.away).map((/** @type {any} */ p) => p.id));
  const asked = who.filter((id) => there.has(id));
  nextBar.hidden = asked.length === 0;
  if (nextBar.hidden) return;
  const ready = new Set(sc.ready ?? []);
  const left = asked.filter((id) => !ready.has(id)).length;
  nextBar.replaceChildren(
    h("span", { class: "nl" }, t.next, h("small", {}, left ? t.nextWaiting(left) : "✓")),
    h("span", { class: "nd" }, ...asked.map((id) => h("b", { class: `nw${ready.has(id) ? " ok" : ""}`, style: { "--c": colorOf(id) }, title: nameOf(id) }, ready.has(id) ? "✓" : initial(nameOf(id))))),
  );
}
/** @type {number | null} */
let deadline = null;
let lastTick = -1;
function tickClock() {
  if (deadline === null) {
    clock.hidden = true;
    return;
  }
  const ms = deadline - client.now();
  const n = Math.max(0, Math.ceil(ms / 1000));
  clock.hidden = false;
  if (clock.textContent !== String(n)) {
    clock.textContent = String(n);
    clock.classList.toggle("low", n <= 5);
    if (n <= 5 && n > 0 && n !== lastTick) {
      lastTick = n;
      sfx.tick();
    }
  }
}
setInterval(tickClock, 200);

// ---------------------------------------------------------------------------
// The trip: every player's plane on a dotted route along the bottom.

/** A plane flying right, along the route. */
const PLANE = "M24 13l-7-1-6-9h-3l3 9-6-.5-2-3h-2l1 4.5-1 4.5h2l2-3 6-.5-3 9h3l6-9 7-1z";
/** @type {Map<string, HTMLElement>} */
const planes = new Map();
const route = h("div", { class: "route" });
race.append(route);
/** Steps shown, held back while a reveal plays. @type {Record<string, number> | null} */
let shownSteps = null;
/** @param {any[]} players @param {Record<string, number>} [hold] */
function drawRace(players, hold) {
  const steps = (/** @type {any} */ p) => (hold && p.id in hold ? hold[p.id] : p.steps);
  const top = Math.max(0, ...players.map(steps));
  const span = Math.max(8, top + 3);
  // Stops along the route.
  if (route.childElementCount !== span + 1 || route.dataset["span"] !== String(span)) {
    route.dataset["span"] = String(span);
    for (const el of route.querySelectorAll(".stop")) el.remove();
    for (let i = 0; i <= span; i++) route.append(h("i", { class: "stop", style: { left: `${(i / span) * 100}%` } }));
  }
  const seen = new Set();
  /** @type {Map<number, number>} */
  const lanes = new Map();
  for (const p of [...players].sort((a, b) => steps(b) - steps(a) || a.name.localeCompare(b.name))) {
    seen.add(p.id);
    let el = planes.get(p.id);
    if (!el) {
      el = h("div", { class: "plane" }, h("span", { html: `<svg viewBox="0 0 26 26"><path d="${PLANE}"/></svg>` }), h("b", { class: "who" }));
      planes.set(p.id, el);
      race.append(el);
    }
    const s = steps(p);
    const lane = lanes.get(s) ?? 0;
    lanes.set(s, lane + 1);
    el.style.setProperty("--c", p.color ?? colorOf(p.id));
    el.style.setProperty("--x", String(s / span));
    el.style.setProperty("--lane", String(lane % 4));
    el.classList.toggle("away", !!p.away);
    /** @type {HTMLElement} */ (el.querySelector(".who")).textContent = `${p.name} · ${s}`;
  }
  for (const [id, el] of planes) if (!seen.has(id)) { el.remove(); planes.delete(id); }
}

// ---------------------------------------------------------------------------
// Rendering

/** @type {{ key: string, el: HTMLElement, update?: (sc: any) => void } | null} */
let scene = null;

client.on("view", (view) => render(view));
client.on("status", (st) => {
  statusBar.hidden = st === "open";
  statusBar.textContent = st === "reconnecting" || st === "connecting" ? t.reconnecting : st === "closed" ? t.over : "";
});

/** @param {any} sc */
function keyOf(sc) {
  if (sc.phase !== "round") return String(sc.phase ?? "");
  const q = sc.question ?? {};
  return `${sc.round}:${sc.stage}:${sc.try ?? ""}:${sc.kind ?? ""}:${q.flag ?? q.name ?? q.box?.join(",") ?? ""}:${sc.solution?.id ?? ""}`;
}

/** @param {any} view */
function render(view) {
  const sc = view.screen ?? {};
  const l = pickLang(sc.lang);
  const relang = l !== lang;
  if (relang) {
    lang = l;
    t = strings(l);
    f = numbers(l);
    document.documentElement.lang = l;
  }
  map?.setMode(sc.map === "globe" ? "globe" : "flat");
  document.body.dataset["map"] = sc.map === "globe" ? "globe" : "flat";
  roundLabel.textContent = sc.phase === "round" ? t.round(sc.round ?? 1, sc.rounds ?? 1) : "";
  deadline = typeof sc.deadline === "number" && (sc.stage === "draw" || sc.stage === "challenge") ? sc.deadline : null;
  // The countdown of a wait for Next (game/game.ts): it goes on by itself.
  if (sc.phase === "round" && sc.next && typeof sc.nextBy === "number") deadline = sc.nextBy;
  tickClock();
  const key = keyOf(sc);
  if (!scene || key !== scene.key || relang) {
    for (const x of timers) clearTimeout(x);
    timers = [];
    shownSteps = null;
    const old = scene;
    if (old) {
      old.el.classList.add("leaving");
      setTimeout(() => old.el.remove(), 450);
    }
    scene = build(sc, key);
    stage.append(scene.el);
  }
  scene.update?.(sc);
  drawNext(sc);
  race.hidden = sc.phase !== "round" && sc.phase !== "final";
  drawRace(sc.players ?? [], shownSteps ?? undefined);
  client.joinVisible = sc.phase === "lobby" || !sc.phase;
}

/** @param {any} sc @param {string} key */
function build(sc, key) {
  if (map) {
    map.hot = new Set();
    map.warm = new Set();
    map.outline = null;
    map.lone = false;
    map.pulse = false;
    map.marks = [];
    map.lines = [];
    map.goal = null;
    map.circle = null;
    map.right = 0;
    map.left = 0;
    map.bottom = 0;
    map.top = 0;
    map.out = new Set();
    map.spin = sc.phase === "lobby" || sc.phase === "final" || sc.stage === "draw" ? 4 : 0;
  }
  switch (sc.phase) {
    case "round":
      switch (sc.stage) {
        case "draw":
          return { key, ...drawScene(sc) };
        case "compete":
          return { key, ...competeScene(sc) };
        case "discard":
          return { key, ...discardScene(sc) };
        case "announce":
          return { key, ...announceScene(sc) };
        case "challenge":
          return { key, ...challengeScene(sc) };
        case "answer":
          return { key, ...answerScene(sc) };
      }
      return { key, el: h("div", { class: "scene" }) };
    case "final":
      return { key, ...finalScene(sc) };
    default:
      return { key, ...lobbyScene() };
  }
}

// ---------------------------------------------------------------------------
// The lobby

function lobbyScene() {
  look(null, 0);
  const qr = h("div", { class: "qr" });
  const link = h("div", { class: "link" });
  const list = h("div", { class: "chips" });
  const note = h("p", { class: "note" });
  const el = h(
    "div",
    { class: "scene lobby" },
    h("div", { class: "title" }, h("div", { class: "big-logo" }, logo())),
    h("div", { class: "panel joinp" }, h("h2", {}, t.join), qr, link),
    h("div", { class: "panel playersp" }, h("h2", { class: "count" }), list, note),
    h("ol", { class: "how panel" }, ...t.how.map((x) => h("li", {}, x))),
  );
  let qrFor = "";
  return {
    el,
    update(/** @type {any} */ sc) {
      const join = client.view?.join;
      if (join?.qr && join.qr !== qrFor) {
        qrFor = join.qr;
        qr.innerHTML = qrSvg(join.qr);
      }
      link.textContent = join ? (joinText(join) ?? t.scan) : "";
      const roster = (client.view?.roster ?? []).filter((/** @type {any} */ r) => r.role !== "screen");
      /** @type {HTMLElement} */ (el.querySelector(".count")).textContent = t.players(roster.length);
      list.replaceChildren(...roster.map((/** @type {any} */ r) => chip(r.id, r.vip ? h("small", {}, "★") : null, sc.heads?.[r.id] > 0 ? h("small", { class: "head" }, `+${sc.heads[r.id]}`) : null)));
      const min = sc.minPlayers ?? 2;
      const ready = roster.filter((/** @type {any} */ r) => r.connected).length;
      note.textContent = ready < min ? t.needMore(min - ready) : t.vipStarts;
    },
  };
}

// ---------------------------------------------------------------------------
// The draw: card backs, the captain choosing

/** @param {any} sc */
function drawScene(sc) {
  look(null);
  const hands = /** @type {string[]} */ (sc.hands ?? []);
  const row = h(
    "div",
    { class: `hands${hands.length > 6 ? " many" : ""}` },
    ...hands.map((id, i) =>
      h(
        "div",
        { class: `back-wrap${id === sc.captain ? " captain" : ""}`, style: { "--c": colorOf(id), "--i": String(i), "--tilt": `${((i * 37) % 9) - 4}deg` } },
        id === sc.captain ? h("div", { class: "crown" }, t.captain) : null,
        h("div", { class: "wq-back" }, h("span", { class: "back-logo", html: GLOBE })),
        chip(id),
      ),
    ),
  );
  sfx.whoosh();
  return {
    el: h("div", { class: "scene draw" }, h("div", { class: "banner" }, t.chooses(nameOf(sc.captain))), row, gonePanel(sc)),
  };
}

/** The strong cards that are gone, per number (§2.2). @param {any} sc */
function gonePanel(sc) {
  const gone = sc.gone ?? {};
  const rows = FACTS.map((k) => {
    const list = /** @type {any[]} */ (gone[k] ?? []);
    return h(
      "div",
      { class: "gone-row" },
      h("span", { class: "gi", html: ICONS[k] }),
      list.length ? h("div", { class: "gone-flags" }, ...list.map((g) => h("span", { class: "gf" }, h("img", { src: flagSrc(g.flag), alt: "" }), h("b", {}, `#${g.rank}`)))) : h("span", { class: "none" }, t.noneGone),
    );
  });
  return h("div", { class: "panel gone" }, h("h3", {}, t.gone), ...rows, h("p", { class: "left" }, t.left(sc.left ?? 0, sc.deckSize ?? 0)));
}

// ---------------------------------------------------------------------------
// Compete: the cards turn one by one, lowest first; the camera flies to each.

/** @param {any} sc */
function competeScene(sc) {
  const fact = sc.fact;
  const cards = /** @type {any[]} */ (sc.cards ?? []);
  const winners = /** @type {string[]} */ (sc.winners ?? []);
  const per = Math.max(500, sc.per ?? 1700);
  const intro = Math.max(0, (sc.intro ?? 2500) - 300);
  // Hold the planes until the winners are called.
  shownSteps = Object.fromEntries((sc.players ?? []).map((/** @type {any} */ p) => [p.id, p.steps - (winners.includes(p.id) ? 1 : 0)]));
  const big = h("div", { class: "big-card" });
  const strip = h("div", { class: "strip" });
  // Every card whole: in one row or two, as big as fits between the banner and the planes, left of the big card.
  sizeMinis(strip, cards.length, innerWidth / rem() - joinW() - 3 - 41, 42);
  const head = h("div", { class: "banner" }, h("span", { class: "fi", html: ICONS[/** @type {keyof typeof ICONS} */ (fact)] }), `${t.compare}: ${LABELS[lang][/** @type {keyof typeof LABELS.en} */ (fact)]}`, h("small", {}, t.highestWins));
  const el = h("div", { class: "scene compete" }, head, big, strip);
  if (map) map.right = innerWidth * 0.36;
  look(null);
  const order = [...cards].reverse();
  order.forEach((c, i) => {
    later(() => {
      sfx.flip();
      big.replaceChildren(h("div", { class: "who-holds" }, chip(c.pid)), cardEl(c.card, lang, { pick: fact, dim: false }));
      big.classList.remove("pop");
      void big.offsetWidth;
      big.classList.add("pop");
      strip.prepend(mini(c, fact, true));
      if (map) map.hot = new Set([c.card.id]);
      look(c.card, Math.min(1500, per * 0.8));
    }, intro + i * per);
  });
  later(() => {
    for (const m of strip.querySelectorAll(".mini")) m.classList.toggle("won", winners.includes(/** @type {HTMLElement} */ (m).dataset["pid"] ?? ""));
    const best = cards.filter((c) => winners.includes(c.pid));
    if (map) map.hot = new Set(best.map((c) => c.card.id));
    if (best[0]) look(best[0].card, 1200);
    big.replaceChildren(h("div", { class: "win-banner" }, winners.length > 1 ? t.tie : "", h("div", {}, t.wins(winners.map(nameOf)))), ...best.slice(0, 1).map((c) => cardEl(c.card, lang, { pick: fact, dim: false })));
    sfx.fanfare();
    shownSteps = null;
    drawRace(client.view?.screen?.players ?? []);
  }, intro + order.length * per + 300);
  return { el };
}

/** The TV's rem (a 72nd of its height), in px. */
const rem = () => innerHeight / 72;
/** The join badge's width (rem). */
const joinW = () => (parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--tvpipe-join-w")) || 0) / rem();

/**
 * Sizes `n` small cards (`.mini`, 9.7em wide, about 1.9 times as tall)
 * to fit a box (rem) in one row or two, at most their full size.
 * @param {HTMLElement} el @param {number} n @param {number} width @param {number} height
 */
function sizeMinis(el, n, width, height) {
  const gap = 1;
  let w = 0;
  for (const rows of [1, 2]) {
    const per = Math.ceil(Math.max(1, n) / rows);
    w = Math.max(w, Math.min(15.5, (width - (per - 1) * gap) / per, (height - (rows - 1) * gap) / rows / 1.9));
  }
  el.style.setProperty("--mf", `${(w / 9.7).toFixed(3)}rem`);
}

/** A small card: flag, name, its numbers (`fact` outlined), or only that one. @param {any} c @param {string | null} fact @param {boolean} all */
function mini(c, fact, all) {
  const card = c.card;
  const rows = (all ? FACTS : [fact]).map((k) => {
    const key = /** @type {keyof typeof ICONS} */ (k);
    const rank = card.ranks?.[key] ?? 0;
    return h("div", { class: `mrow${rank && rank <= STRONG ? " strong" : ""}${all && k === fact ? " pick" : ""}` }, h("span", { class: "mi", html: ICONS[key] }), h("b", { "data-fit": "1" }, f.fact(key, card.facts[key])), rank ? h("span", { class: `rank${rank <= STRONG ? " gold" : ""}` }, `#${rank}`) : null);
  });
  return h("div", { class: "mini", "data-pid": c.pid, style: { "--c": colorOf(c.pid) } }, h("img", { class: "mflag", src: flagSrc(card.flag), alt: "" }), h("div", { class: "mname", "data-fit": "1" }, card.name), ...rows, h("div", { class: "mwho" }, nameOf(c.pid)));
}

// ---------------------------------------------------------------------------
// Discard: the hands face up, strong numbers called out, then onto the pile.

/** @param {any} sc */
function discardScene(sc) {
  const cards = /** @type {any[]} */ (sc.cards ?? []);
  const row = h("div", { class: "discards" }, ...cards.map((c) => mini(c, null, true)));
  sizeMinis(row, cards.length, innerWidth / rem() - 8, 30);
  const strongOnes = cards.filter((c) => (c.card.strong ?? []).length > 0);
  const callouts = h(
    "div",
    { class: "callouts" },
    ...strongOnes.flatMap((c) => (c.card.strong ?? []).map((/** @type {string} */ k) => h("span", { class: "callout" }, h("img", { src: flagSrc(c.card.flag), alt: "" }), `${c.card.name}: #${c.card.ranks[k]} ${LABELS[lang][/** @type {keyof typeof LABELS.en} */ (k)]}`))),
  );
  if (map) map.hot = new Set(cards.map((c) => c.card.id));
  look(null);
  if (strongOnes.length) later(() => sfx.strong(), 600);
  return { el: h("div", { class: "scene discard" }, h("div", { class: "banner" }, t.discard), row, strongOnes.length ? callouts : null) };
}

// ---------------------------------------------------------------------------
// Challenges

const KIND_ICONS = {
  capital: '<svg viewBox="0 0 40 40"><path d="M20 4l3.5 8 8.5.8-6.4 5.6 1.9 8.4L20 22.4l-7.5 4.4 1.9-8.4L8 12.8l8.5-.8z" fill="#ffcf4a" stroke="#263450" stroke-width="3" stroke-linejoin="round"/><path d="M9 33h22" stroke="#263450" stroke-width="3" stroke-linecap="round"/></svg>',
  flag: '<svg viewBox="0 0 40 40"><path d="M9 36V5" stroke="#263450" stroke-width="3.5" stroke-linecap="round"/><path d="M10 6c6-3 10 3 16 0s6 0 6 0v15s-2-3-6 0-10-3-16 0z" fill="#ef4444" stroke="#263450" stroke-width="3" stroke-linejoin="round"/></svg>',
  where: '<svg viewBox="0 0 40 40"><path d="M20 37c-2-8-12-13-12-21a12 12 0 0124 0c0 8-10 13-12 21z" fill="#ff7a45" stroke="#263450" stroke-width="3" stroke-linejoin="round"/><circle cx="20" cy="16" r="4.5" fill="#fff" stroke="#263450" stroke-width="2.5"/></svg>',
  ...KIND_ICONS_MORE,
};
const LETTERS = "ABCDEFGHI";
/** How each kind is answered (game/rules.ts ANSWERS). */
const HOW = /** @type {Record<string, "text" | "pin" | "choice" | "number">} */ ({ capital: "text", flag: "text", where: "pin", pickflag: "choice", shape: "text", spot: "text", bigger: "choice", guess: "number", neighbour: "text", odd: "choice" });

/** Options as cards in a row: a letter, the flag, the name. @param {any[]} options */
function optionRow(options) {
  return h("div", { class: "options" }, ...options.map((o, i) => h("div", { class: "option", style: { "--i": String(i) } }, h("b", { class: "letter" }, LETTERS[i] ?? ""), h("img", { src: flagSrc(o.flag ?? ""), alt: "" }), h("span", { class: "oname", "data-fit": "1" }, o.name ?? ""))));
}

/** @param {any} sc */
function announceScene(sc) {
  const kind = /** @type {keyof typeof KIND_ICONS} */ (sc.kind);
  look(null);
  sfx.pop();
  return {
    el: h(
      "div",
      { class: "scene announce" },
      h(
        "div",
        { class: "announce-card" },
        h("div", { class: "a-top" }, sc.tiebreak ? t.tiebreak : t.challenge),
        h("span", { class: "a-icon", html: KIND_ICONS[kind] }),
        h("div", { class: "a-kind" }, t.kinds[kind]),
        h("div", { class: "a-line" }, t.kindLines[kind]),
        t.tryN(sc.try ?? 1) ? h("div", { class: "a-try" }, t.tryN(sc.try ?? 1)) : null,
      ),
    ),
  };
}

/** @param {any} sc */
function challengeScene(sc) {
  const q = sc.question ?? {};
  const kind = sc.kind;
  /** @type {HTMLElement} */
  let ask;
  if (kind === "capital") {
    ask = h("div", { class: "ask" }, h("img", { class: "ask-flag", src: flagSrc(q.flag), alt: "" }), h("div", { class: "ask-text" }, t.capitalOf, h("b", { "data-fit": "1" }, `${q.name}?`)));
    if (map) map.hot = new Set([q.id]);
    look(q, 1700, 0.3);
  } else if (kind === "flag") {
    ask = h("div", { class: "ask flag-ask" }, h("img", { class: "huge-flag", src: flagSrc(q.flag), alt: "" }), h("div", { class: "ask-text" }, t.whichFlag));
    look(null);
  } else if (kind === "pickflag") {
    const flags = /** @type {string[]} */ (q.flags ?? []);
    ask = h(
      "div",
      { class: "pick-ask" },
      h("div", { class: "ask static" }, h("span", { class: "ask-pin", html: KIND_ICONS.pickflag }), h("div", { class: "ask-text" }, t.kindLines.pickflag, h("b", { "data-fit": "1" }, q.name ?? ""))),
      h("div", { class: `flaggrid n${flags.length}` }, ...flags.map((f, i) => h("div", { class: "fopt", style: { "--i": String(i) } }, h("img", { src: flagSrc(f), alt: "" }), h("b", { class: "letter" }, LETTERS[i] ?? "")))),
    );
    look(null);
  } else if (kind === "shape") {
    // A slim banner: the shape takes the screen between it and the players.
    ask = h("div", { class: "banner" }, h("span", { class: "fi", html: KIND_ICONS.shape }), t.whichShape);
    if (map) {
      // The country alone on the sea: no neighbours, no grid to tell where.
      map.outline = decodeRings(q.shape ?? []);
      map.lone = true;
      map.top = 16 * rem();
      map.bottom = 20 * rem();
    }
    // Close enough to see the shape of a small one too.
    look({ box: q.box }, 1700, 0.85, 60);
  } else if (kind === "spot") {
    // The easier shape: the outline in its place, the land around it (no names).
    ask = h("div", { class: "banner" }, h("span", { class: "fi", html: KIND_ICONS.spot }), t.kindLines.spot);
    if (map) {
      map.outline = decodeRings(q.shape ?? []);
      map.pulse = true;
      map.top = 16 * rem();
      map.bottom = 20 * rem();
    }
    look({ box: q.box, at: q.at }, 1700, 0.3);
  } else if (kind === "bigger" || kind === "odd") {
    const fact = /** @type {keyof typeof ICONS} */ (q.fact);
    const head =
      kind === "bigger"
        ? h("div", { class: "ask static" }, h("span", { class: "ask-pin", html: ICONS[fact] ?? "" }), h("div", { class: "ask-text" }, LABELS[lang][fact] ?? "", h("b", { "data-fit": "1" }, t.biggerQ[/** @type {"area"} */ (fact)] ?? "")))
        : h("div", { class: "ask static" }, h("img", { class: "ask-flag", src: flagSrc(q.flag), alt: "" }), h("div", { class: "ask-text" }, t.kinds.odd, h("b", { "data-fit": "1" }, t.oddOf(q.name ?? ""))));
    ask = h("div", { class: "pick-ask" }, head, optionRow(q.options ?? []));
    look(null);
  } else if (kind === "guess") {
    const fact = /** @type {"population" | "area" | "highest"} */ (q.fact);
    ask = h("div", { class: "ask" }, h("img", { class: "ask-flag", src: flagSrc(q.flag), alt: "" }), h("div", { class: "ask-text" }, t.kinds.guess, h("b", { "data-fit": "1" }, t.guessQ[fact]?.(q.name ?? "") ?? "")));
    look(null);
  } else if (kind === "neighbour") {
    ask = h("div", { class: "ask" }, h("img", { class: "ask-flag", src: flagSrc(q.flag), alt: "" }), h("div", { class: "ask-text" }, t.kindLines.neighbour, h("b", { "data-fit": "1" }, `${t.neighbourOf(q.name ?? "")}`)));
    if (map) map.hot = new Set([q.id]);
    look(q, 1700, 0.22);
  } else {
    ask = h("div", { class: "ask" }, h("span", { class: "ask-pin", html: KIND_ICONS.where }), h("div", { class: "ask-text" }, t.whereIs, h("b", { "data-fit": "1" }, `${q.name}?`)));
    look(null);
  }
  const who = h("div", { class: "answering" });
  const el = h("div", { class: `scene challenge k-${kind}` }, ask, who);
  return {
    el,
    update(/** @type {any} */ s) {
      const locked = new Set(s.locked ?? []);
      who.replaceChildren(...(s.answering ?? []).map((/** @type {string} */ id) => chip(id, locked.has(id) ? h("span", { class: "ok" }, "✓") : h("span", { class: "dots" }, "…"))));
      if (locked.size) sfx.pop();
    },
  };
}

/**
 * The answer: the whole card on the right, everyone's answer on the left,
 * the country popping up on the map with a flag planted on it; for a pin
 * challenge the camera shows the country first, then pulls back to every
 * pin, each with a line to the country's nearest point and how far it is.
 * @param {any} sc
 */
function answerScene(sc) {
  const sol = sc.solution ?? {};
  const rv = sc.reveal ?? {};
  const winners = /** @type {string[]} */ (sc.winners ?? []);
  const answers = /** @type {any[]} */ (sc.answers ?? []);
  shownSteps = Object.fromEntries((sc.players ?? []).map((/** @type {any} */ p) => [p.id, p.steps - (winners.includes(p.id) && !sc.tiebreak ? 1 : 0)]));
  const card = h("div", { class: "sol-card" }, h("div", { class: "s-top" }, t.answer), cardEl(sol, lang));
  const list = h(
    "div",
    { class: `answers${answers.length > 7 ? " many" : ""}` },
    ...answers.map((a) => {
      const right = winners.includes(a.pid);
      /** @type {Node[]} */
      const what = [];
      const how = HOW[sc.kind] ?? "text";
      if (sc.kind === "where") what.push(h("span", { class: "said" }, a.km === null ? t.noAnswer : a.km === 0 ? t.hit : t.away(f.km(a.km))));
      else if (how === "choice") {
        const o = typeof a.choice === "number" ? rv.options?.[a.choice] : null;
        if (!o) what.push(h("span", { class: "said" }, t.noAnswer));
        else {
          what.push(h("b", { class: "letter" }, LETTERS[a.choice] ?? ""));
          if (sc.kind === "pickflag") what.push(h("img", { class: "aflag", src: flagSrc(o.flag ?? ""), alt: "" }));
          what.push(h("span", { class: "said" }, o.name ?? ""));
        }
      } else if (how === "number") {
        if (typeof a.value !== "number") what.push(h("span", { class: "said" }, t.noAnswer));
        else what.push(h("span", { class: "said" }, f.fact(rv.fact, a.value)), typeof a.off === "number" ? h("span", { class: "as" }, a.off < 1.005 ? "✓" : t.offBy(times(a.off))) : h("span"));
      } else {
        what.push(h("span", { class: "said" }, a.text || t.noAnswer));
        if (a.text && a.as && a.as !== a.text) what.push(h("span", { class: "as" }, `→ ${a.as}`));
      }
      return h("div", { class: `ans${right ? " right" : ""}` }, chip(a.pid), ...what, h("span", { class: "mark" }, right ? "✓" : "✗"));
    }),
  );
  const at = /** @type {[number, number]} */ (sol.at ?? [0, 0]);
  if (map) {
    map.hot = new Set([sol.id]);
    map.right = 42 * rem();
    map.left = 38 * rem();
    const flag = new Image();
    flag.src = flagSrc(sol.flag);
    map.goal = { lon: at[0], lat: at[1], name: sol.name ?? "", flag };
  }
  // Several countries: the neighbours, the four, the odd one among X's neighbours; then the camera takes them all in.
  const placed = /** @type {any[]} */ (sc.kind === "neighbour" ? (rv.neighbours ?? []) : sc.kind === "bigger" || sc.kind === "odd" ? (rv.options ?? []) : []);
  if (map && placed.length) {
    const odd = sc.kind === "odd" ? rv.options?.[rv.right] : null;
    if (sc.kind === "odd" && rv.of) map.hot = new Set([rv.of.id]);
    map.warm = new Set(placed.map((o) => o.id).filter((id) => !map?.hot.has(id) && id !== odd?.id));
    if (odd?.at) map.marks = [{ lon: odd.at[0], lat: odd.at[1], color: "#ef4444", label: "✗", big: true }];
    const box = unionBox([sol.box, ...placed.map((o) => o.box)].filter((b) => Array.isArray(b) && b.length === 4));
    later(() => map?.flyTo(box, [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2], 1300, map.mode === "globe" ? 0.45 : 0.6), 1700);
  }
  const extra = revealPanel(sc);
  // The panel at the bottom: the camera keeps the country above it.
  if (map && extra) map.bottom = (13 + (sc.kind === "pickflag" ? 3 + 5 * Math.ceil((rv.options ?? []).length / 3) : (REVEAL_REM[sc.kind] ?? 16))) * rem();
  look(sol, 1500, 0.35, sc.kind === "shape" ? 60 : undefined);
  if (sc.kind === "where") {
    const pins = answers.filter((a) => a.lon !== null && a.lat !== null);
    if (map) {
      map.marks = pins.map((a) => ({ lon: a.lon, lat: a.lat, color: colorOf(a.pid), label: initial(nameOf(a.pid)), big: winners.includes(a.pid) }));
      const start = performance.now() + 2800;
      map.lines = pins.filter((a) => a.km > 0 && Array.isArray(a.to)).map((a, i) => ({ from: /** @type {[number, number]} */ ([a.lon, a.lat]), to: a.to, color: colorOf(a.pid), label: f.km(a.km), at: start + i * 150 }));
    }
    // Then the country and every pin in view (pins on the other side of the world count the short way round).
    let [w, so, e, n] = sol.box ?? [at[0] - 1, at[1] - 1, at[0] + 1, at[1] + 1];
    if (e < w) e += 360;
    const mid = (w + e) / 2;
    for (const p of pins) {
      let lon = p.lon;
      while (lon - mid > 180) lon -= 360;
      while (mid - lon > 180) lon += 360;
      w = Math.min(w, lon);
      e = Math.max(e, lon);
      so = Math.min(so, p.lat);
      n = Math.max(n, p.lat);
    }
    // The globe shows less of the world than the flat map does at the same fill.
    if (pins.length) later(() => map?.flyTo([w, so, e, n], [(w + e) / 2, (so + n) / 2], 1300, map.mode === "globe" ? 0.45 : 0.7), 1700);
  }
  const el = h("div", { class: `scene answer k-${sc.kind}` }, h("div", { class: "side" }, card), list, extra);
  if (!winners.length) {
    el.append(h("div", { class: "nobody" }, h("div", { class: "stampbig" }, t.nobody), sc.again ? h("div", { class: "another" }, t.another) : null));
    later(() => sfx.buzz(), 400);
  } else later(() => sfx.ding(), 400);
  later(() => {
    shownSteps = null;
    drawRace(client.view?.screen?.players ?? []);
  }, 1500);
  return { el };
}

/** About how tall the reveal panel is (rem), for the map's bottom inset. @type {Record<string, number>} */
const REVEAL_REM = { bigger: 23, odd: 23, guess: 16, neighbour: 12 };

/** A ratio as "1.4" or "12". @param {number} x */
function times(x) {
  return new Intl.NumberFormat(lang, { maximumFractionDigits: x < 10 ? 1 : 0 }).format(x);
}

/**
 * Boxes [w, s, e, n] as one (across the date line the short way round).
 * @param {number[][]} boxes @returns {[number, number, number, number]}
 */
function unionBox(boxes) {
  let [w, s, e, n] = /** @type {[number, number, number, number]} */ (boxes[0] ?? [-10, -10, 10, 10]);
  if (e < w) e += 360;
  const mid = (w + e) / 2;
  for (const b of boxes.slice(1)) {
    let [bw, bs, be, bn] = /** @type {[number, number, number, number]} */ (b);
    if (be < bw) be += 360;
    const bm = (bw + be) / 2;
    let shift = 0;
    while (bm + shift - mid > 180) shift -= 360;
    while (mid - (bm + shift) > 180) shift += 360;
    w = Math.min(w, bw + shift);
    e = Math.max(e, be + shift);
    s = Math.min(s, bs);
    n = Math.max(n, bn);
  }
  return [w, s, e, n];
}

/**
 * What the answer shows beyond the card and the list, at the bottom
 * between them: the flags (the right one ticked, everyone's dot on their
 * pick), the four numbers in order, the odd one among the neighbours,
 * the guesses on a number line, the neighbours.
 * @param {any} sc
 */
function revealPanel(sc) {
  const rv = sc.reveal;
  if (!rv) return null;
  const answers = /** @type {any[]} */ (sc.answers ?? []);
  const dots = (/** @type {number} */ i) => h("span", { class: "dots" }, ...answers.filter((a) => a.choice === i).map((a) => h("b", { class: "pdot", style: { "--c": colorOf(a.pid) } }, initial(nameOf(a.pid)))));
  if (sc.kind === "pickflag") {
    return h(
      "div",
      { class: "panel reveal" },
      h(
        "div",
        { class: "flaglist" },
        ...(rv.options ?? []).map((/** @type {any} */ o, /** @type {number} */ i) =>
          h("div", { class: `fopt${i === rv.right ? " right" : ""}` }, h("span", { class: "fpic" }, h("img", { src: flagSrc(o.flag ?? ""), alt: "" }), h("b", { class: "letter" }, LETTERS[i] ?? ""), i === rv.right ? h("b", { class: "tick" }, "✓") : null), h("span", { class: "fwho" }, h("span", { class: "fname" }, o.name ?? ""), dots(i))),
        ),
      ),
    );
  }
  if (sc.kind === "bigger" || sc.kind === "odd") {
    const rows = (rv.options ?? []).map((/** @type {any} */ o, /** @type {number} */ i) => ({ o, i }));
    if (sc.kind === "bigger") rows.sort((/** @type {any} */ a, /** @type {any} */ b) => b.o.value - a.o.value);
    return h(
      "div",
      { class: "panel reveal" },
      h(
        "ol",
        { class: "ranked" },
        ...rows.map((/** @type {any} */ r) =>
          h(
            "li",
            { class: r.i === rv.right ? "right" : "" },
            h("b", { class: "letter" }, LETTERS[r.i] ?? ""),
            h("img", { src: flagSrc(r.o.flag ?? ""), alt: "" }),
            h("span", { class: "oname" }, r.o.name ?? "", sc.kind === "odd" ? h("small", {}, `${r.i === rv.right ? t.notBorders : t.borders} ${rv.of?.name ?? ""}`) : null),
            dots(r.i),
            sc.kind === "bigger" ? h("b", { class: "oval" }, f.fact(rv.fact, r.o.value)) : null,
          ),
        ),
      ),
    );
  }
  if (sc.kind === "guess") {
    const guesses = answers.filter((a) => typeof a.value === "number");
    const all = [rv.value, rv.value / (rv.factor ?? 1), rv.value * (rv.factor ?? 1), ...guesses.map((a) => a.value)].filter((v) => v > 0);
    const from = Math.max(rv.min || 1, Math.min(...all) / 3);
    const to = Math.min(rv.max || 10, Math.max(...all) * 3);
    const x = (/** @type {number} */ v) => `${(Math.max(0, Math.min(1, (Math.log(v) - Math.log(from)) / (Math.log(to) - Math.log(from)))) * 100).toFixed(1)}%`;
    return h(
      "div",
      { class: "panel reveal guessline" },
      h("div", { class: "gvalue" }, f.fact(rv.fact, rv.value)),
      h(
        "div",
        { class: "gline" },
        rv.factor ? h("i", { class: "gband", style: { left: x(rv.value / rv.factor), width: `calc(${x(rv.value * rv.factor)} - ${x(rv.value / rv.factor)})` } }) : null,
        h("i", { class: "gmark answer", style: { left: x(rv.value) } }),
        ...guesses.map((a, i) => h("b", { class: "pdot", style: { left: x(a.value), "--c": colorOf(a.pid), "--k": String(i % 3) } }, initial(nameOf(a.pid)))),
      ),
      h("div", { class: "gends" }, h("span", {}, f.fact(rv.fact, from)), h("span", {}, f.fact(rv.fact, to))),
    );
  }
  if (sc.kind === "neighbour") {
    return h("div", { class: "panel reveal" }, h("div", { class: "nhead" }, t.neighbours), h("div", { class: "nlist" }, ...(rv.neighbours ?? []).map((/** @type {any} */ o) => h("span", { class: "nchip" }, h("img", { src: flagSrc(o.flag ?? ""), alt: "" }), o.name ?? ""))));
  }
  return null;
}

// ---------------------------------------------------------------------------
// The end

/** @param {any} sc */
function finalScene(sc) {
  const places = /** @type {any[]} */ (sc.places ?? []);
  const top = places.filter((p) => p.place === 1);
  look(null);
  sfx.fanfare();
  const podium = h(
    "div",
    { class: "podium" },
    ...places.slice(0, 3).map((p) =>
      h("div", { class: `step p${p.place}`, style: { "--c": colorOf(p.id) } }, h("span", { class: "pl", html: `<svg viewBox="0 0 26 26"><path d="${PLANE}"/></svg>` }), h("div", { class: "pn" }, p.name), h("div", { class: "ps" }, t.steps(p.steps)), h("div", { class: "pp" }, String(p.place))),
    ),
  );
  const rest = h("ol", { class: "rest", start: "4" }, ...places.slice(3).map((p) => h("li", {}, `${p.name} · ${t.steps(p.steps)}`)));
  return {
    el: h(
      "div",
      { class: "scene final" },
      h("div", { class: "banner" }, t.final),
      h("div", { class: "champ" }, `${top.length > 1 ? t.winners : t.winner}: ${top.map((p) => p.name).join(" & ")}`),
      podium,
      places.length > 3 ? rest : null,
      h("p", { class: "note" }, t.playAgain),
    ),
  };
}

watchFit();

client.connect().catch((e) => {
  stage.replaceChildren(h("div", { class: "scene lobby" }, h("div", { class: "title" }, logo()), h("p", { class: "note" }, e?.message ?? String(e))));
});
