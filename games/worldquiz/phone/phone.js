// @ts-check
/**
 * Worldquiz's phone page: joining, the lobby (the VIP's settings), one's
 * card each round (with a little map; the captain's choice: one of the
 * five numbers or a challenge; a tab with the strong cards that are
 * gone), the compete result, the challenges (a capital or a country
 * typed, a pin on the map) and their answers, the final place.
 * Everything it shows comes from the party's view (`{ roster, room, me }`,
 * game/game.ts lists the fields); everything it does is an action.
 *
 * `?demo=NAME` (no party) renders fake views for looking at the screens:
 * lobby, card, captain, gone, compete, discard, announce, tiebreak,
 * capital, flag, where, locked, right, wrong, result-where, again,
 * final, wait; the newer kinds pickflag, pickflag9, shape, bigger, guess,
 * neighbour, odd and their result-pickflag, result-bigger, result-guess,
 * result-neighbour, result-odd.
 */

import { blockEmoji, PartyClient } from "/_tvpipe/lib/client.js";
import { decodeRings, decodeShapes, WorldMap } from "../screen/map.js";
import { cardEl, FACTS, flagSrc, GLOBE, h, ICONS, KIND_ICONS_MORE, LABELS, numbers, SHORT, STRONG } from "./cards.js";
import { watchFit } from "./fit.js";
import { browserLang, pickLang } from "./i18n.js";
import { strings } from "./strings.js";

/** @typedef {import("./cards.js").Fact} Fact */
/** @typedef {import("../screen/map.js").Unit} Unit */
/** @typedef {import("../screen/map.js").Mark} Mark */
/** @typedef {import("../screen/map.js").Line} Line */
/** @typedef {[number, number]} LonLat */
/** @typedef {"capital" | "flag" | "where" | "pickflag" | "shape" | "bigger" | "guess" | "neighbour" | "odd"} Kind */

/** The kinds of challenge (game/rules.ts KINDS) and how each is answered (ANSWERS there). */
const KINDS = /** @type {Kind[]} */ (["capital", "flag", "where", "pickflag", "shape", "bigger", "guess", "neighbour", "odd"]);
/** @type {Record<Kind, "text" | "pin" | "choice" | "number">} */
const HOW = { capital: "text", flag: "text", where: "pin", pickflag: "choice", shape: "text", bigger: "choice", guess: "number", neighbour: "text", odd: "choice" };
const LETTERS = "ABCDEFGHI";

const MAX_ANSWER = 40;
const DEMO = new URLSearchParams(location.search).get("demo");

// A controller, not a document: no pinch or double-tap zoom of the page, no selection.
for (const type of ["gesturestart", "gesturechange", "gestureend"]) document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
document.addEventListener("touchmove", (e) => e.touches.length > 1 && !(e.target instanceof HTMLCanvasElement) && e.preventDefault(), { passive: false });
document.addEventListener("dblclick", (e) => e.preventDefault(), { passive: false });
document.addEventListener("selectstart", (e) => {
  const tg = e.target instanceof Element ? e.target : /** @type {Node} */ (e.target).parentElement;
  if (!tg?.closest("input")) e.preventDefault();
});

const client = PartyClient.fromLocation();
// No emoji in names or answers (the host's matching knows none).
blockEmoji();
const app = /** @type {HTMLElement} */ (document.getElementById("app"));
const banner = /** @type {HTMLElement} */ (document.getElementById("banner"));
const who = /** @type {HTMLElement} */ (document.getElementById("who"));
const langButton = /** @type {HTMLButtonElement} */ (document.getElementById("lang"));
const logoEl = /** @type {HTMLElement} */ (document.getElementById("logo"));
logoEl.append(logo());

/** The demo's view (`?demo=…`) instead of the party's. @type {Record<string, any> | null} */
let demoView = null;
/** The view being shown. @returns {Record<string, any>} */
const V = () => demoView ?? client.view ?? {};
/** One's player id. */
const myId = () => (demoView ? "me" : client.you?.id);

// ---------------------------------------------------------------------------
// The language: the room's; before there is a room (the join form) the player's pick, else the browser's.

const LANG_KEY = "worldquiz:lang";
function ownLang() {
  try {
    const v = localStorage.getItem(LANG_KEY);
    return v ? pickLang(v) : null;
  } catch {
    return null;
  }
}
function roomLang() {
  const l = V().room?.lang;
  return typeof l === "string" ? pickLang(l) : null;
}
/** @type {"en" | "de"} */
let lang = roomLang() ?? ownLang() ?? browserLang();
let t = strings(lang);
document.documentElement.lang = lang;
function useLang() {
  const l = roomLang() ?? ownLang() ?? browserLang();
  if (l === lang) return false;
  lang = l;
  t = strings(l);
  document.documentElement.lang = l;
  return true;
}
langButton.addEventListener("click", () => {
  try {
    localStorage.setItem(LANG_KEY, lang === "de" ? "en" : "de");
  } catch {}
  if (useLang() && shown === "join") joinForm("", /** @type {HTMLInputElement | null} */ (document.getElementById("name"))?.value);
});

let shown = "";
/** @type {(() => void) | null} called on every view while the screen stays */
let refresh = null;
/** @type {(() => void)[]} cleanups of the screen on show */
let cleanups = [];

/** Hooks for the live check: the answer screen's map. */
const hooks = /** @type {{ map: WorldMap | null }} */ ({ map: null });
/** @type {any} */ (globalThis).worldquizPhone = hooks;

// ---------------------------------------------------------------------------
// Little helpers

/** @param {...(Node | null)} nodes */
function show(...nodes) {
  app.replaceChildren(...nodes.filter((n) => n !== null));
}
/** @param {string | null} text */
function setBanner(text) {
  banner.hidden = !text;
  banner.textContent = text ?? "";
}
/** A player's colour from the room (`colors` by id). @param {string | undefined} id */
function colorOf(id) {
  const c = id ? V().room?.colors?.[id] : undefined;
  return typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c) ? c : "#7c8696";
}
/** A name from the roster. @param {string | undefined} id */
function nameOf(id) {
  return (V().roster ?? []).find((/** @type {any} */ r) => r.id === id)?.name ?? "?";
}
const isVip = () => !!(V().roster ?? []).find((/** @type {any} */ r) => r.id === myId())?.vip;
/** A short buzz, where phones do that. @param {number | number[]} ms */
function buzz(ms) {
  try {
    navigator.vibrate?.(ms);
  } catch {}
}
const PLANE = '<svg viewBox="0 0 40 40" aria-hidden="true"><path d="M37 17c0-2-2-3-4-3H25L15 3h-5l5 11H8L5 9H2l2 11-2 11h3l3-5h7l-5 11h5l10-11h8c2 0 4-1 4-3z" fill="#fff" stroke="#263450" stroke-width="3" stroke-linejoin="round" transform="rotate(-20 20 20)"/></svg>';
const KIND_ICONS = {
  capital: '<svg viewBox="0 0 40 40" aria-hidden="true"><path d="M5 35h30M8 35V18h24v17M5 18 20 6l15 12z" fill="#ffcf4a" stroke="#263450" stroke-width="3" stroke-linejoin="round"/><path d="M13 22v9M20 22v9M27 22v9" stroke="#263450" stroke-width="3" stroke-linecap="round"/><path d="M20 6V1l6 2-6 2" fill="#ff7a45" stroke="#263450" stroke-width="2" stroke-linejoin="round"/></svg>',
  flag: '<svg viewBox="0 0 40 40" aria-hidden="true"><path d="M8 37V4" stroke="#263450" stroke-width="3.5" stroke-linecap="round"/><path d="M9 6c8-4 14 4 24 0v17c-10 4-16-4-24 0z" fill="#ef4444" stroke="#263450" stroke-width="3" stroke-linejoin="round"/><path d="M9 12.5c8-4 14 4 24 0v5c-10 4-16-4-24 0z" fill="#fff"/></svg>',
  where: '<svg viewBox="0 0 40 40" aria-hidden="true"><path d="M20 37s12-12 12-21a12 12 0 0 0-24 0c0 9 12 21 12 21z" fill="#ff7a45" stroke="#263450" stroke-width="3" stroke-linejoin="round"/><circle cx="20" cy="16" r="4.5" fill="#fff" stroke="#263450" stroke-width="2.5"/></svg>',
  ...KIND_ICONS_MORE,
};
const CHALLENGE_ICON = '<svg viewBox="0 0 40 40" aria-hidden="true"><path d="M14 14a6 6 0 1 1 9 5c-2 1-3 2-3 5" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round"/><circle cx="20" cy="32" r="3" fill="currentColor"/></svg>';
/** The captain's buttons: a colour per number. */
const FACT_COLORS = { population: "blue", area: "green", neighbours: "orange", highest: "teal", gdp: "purple" };

function logo() {
  return h("span", { class: "wq-logo" }, "W", h("span", { html: GLOBE }), "rldquiz");
}

/** @param {any} e */
function message(e) {
  switch (e?.code) {
    case "name-taken":
      return t.nameTaken;
    case "name-invalid":
      return t.pickAnother;
    case "full":
      return t.full;
    case "locked":
    case "in-progress":
      return shown === "join" ? t.closed : t.errors["locked"];
    case "bad-key":
      return t.badKey;
    case "no-room":
      return t.noRoom;
    default:
      return (typeof e?.code === "string" ? t.errors[e.code] : undefined) ?? e?.message ?? String(e);
  }
}

/** @param {string} type @param {any} data @param {HTMLElement} [err] */
async function act(type, data, err) {
  if (err) err.textContent = "";
  if (demoView) return demoAct(type, data);
  try {
    return await client.act(type, data);
  } catch (e) {
    if (err) err.textContent = message(e);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// The map: the shapes once, a WorldMap per screen.

/** @type {Promise<Unit[]> | null} */
let shapesP = null;
function shapes() {
  shapesP ??= fetch(new URL("../data/shapes.json", import.meta.url))
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`shapes: ${r.status}`))))
    .then((s) => decodeShapes(s));
  return shapesP;
}
void shapes().catch(() => {});

const MAP_KEY = "worldquiz:map";
/** The phone's own flat/globe, else the room's. @returns {"flat" | "globe"} */
function mapMode() {
  try {
    const v = localStorage.getItem(MAP_KEY);
    if (v === "flat" || v === "globe") return v;
  } catch {}
  return V().room?.map === "globe" ? "globe" : "flat";
}

/**
 * A map on the screen: not interactive, flown to `box` with `hot` popping
 * up; or interactive (drag, pinch, tap). A flat/globe toggle in the corner
 * (and zoom buttons when interactive).
 * @param {{ lone?: boolean, maxZoom?: number, hot?: string | null, warm?: string[], outline?: LonLat[][] | null, box?: number[] | null, at?: LonLat | null, interactive?: boolean, borders?: boolean, marks?: Mark[], lines?: Line[], onTap?: (ll: LonLat) => void, cls?: string, id?: string, fill?: number, onMap?: (m: WorldMap) => void }} o
 */
function mapView(o) {
  const canvas = /** @type {HTMLCanvasElement} */ (h("canvas", { id: o.id ?? null }));
  const tools = h("div", { class: "maptools" });
  const wrap = h("div", { class: `map ${o.cls ?? ""}` }, canvas, tools);
  /** @type {WorldMap | null} */
  let map = null;
  let dead = false;
  let placed = false;
  const box = /** @type {[number, number, number, number] | null} */ (o.box && o.box.length === 4 ? o.box : null);
  const place = () => {
    if (!map) return;
    if (box) map.flyTo(box, o.at ?? undefined, 0, o.fill, o.maxZoom);
    else map.flyWorld(0, 15);
    placed = true;
  };
  const modeBtn = /** @type {HTMLButtonElement} */ (h("button", { type: "button", class: "btn sq white small mode", "aria-label": t.mapMode }));
  const setModeIcon = () => {
    modeBtn.replaceChildren(h("span", { class: "ico", html: mapMode() === "globe" ? FLAT_ICON : GLOBE }));
  };
  setModeIcon();
  modeBtn.addEventListener("click", () => {
    const next = mapMode() === "globe" ? "flat" : "globe";
    try {
      localStorage.setItem(MAP_KEY, next);
    } catch {}
    setModeIcon();
    if (map) {
      map.setMode(next);
      place();
    }
  });
  tools.append(modeBtn);
  if (o.interactive) {
    tools.append(
      h("button", { type: "button", class: "btn sq white small", "aria-label": t.zoomIn, onclick: () => map?.zoomBy(1.6) }, h("b", {}, "+")),
      h("button", { type: "button", class: "btn sq white small", "aria-label": t.zoomOut, onclick: () => map?.zoomBy(1 / 1.6) }, h("b", {}, "−")),
    );
  }
  const ro = new ResizeObserver(() => {
    if (!map || !wrap.clientWidth || !wrap.clientHeight) return;
    map.resize(wrap.clientWidth, wrap.clientHeight);
    if (!o.interactive || !placed) place();
  });
  cleanups.push(() => {
    dead = true;
    map?.stop();
    ro.disconnect();
  });
  shapes().then(
    (units) => {
      if (dead) return;
      map = new WorldMap(canvas, units, { mode: mapMode(), borders: o.borders ?? true, interactive: !!o.interactive, ...(o.onTap ? { onTap: o.onTap } : {}) });
      if (o.hot) map.hot.add(o.hot);
      for (const id of o.warm ?? []) map.warm.add(id);
      if (o.outline?.length) map.outline = o.outline;
      map.lone = !!o.lone;
      map.marks = o.marks ?? [];
      map.lines = o.lines ?? [];
      if (wrap.clientWidth && wrap.clientHeight) {
        map.resize(wrap.clientWidth, wrap.clientHeight);
        place();
      }
      ro.observe(wrap);
      map.start();
      o.onMap?.(map);
    },
    () => wrap.classList.add("nomap"),
  );
  return { el: wrap, get map() { return map; } };
}
const FLAT_ICON = '<svg viewBox="0 0 40 40" aria-hidden="true"><rect x="3" y="8" width="34" height="24" rx="3" fill="#6cc7e8" stroke="#263450" stroke-width="3.5"/><path d="M8 14c4 0 5 3 9 3s2 5-1 7M24 12c2 3 6 1 9 3M26 23c3 0 4 2 4 5" fill="none" stroke="#263450" stroke-width="2.6" stroke-linecap="round"/></svg>';

// ---------------------------------------------------------------------------
// Fields

/** @type {CanvasRenderingContext2D | null} */
let ruler = null;

/**
 * Keeps what is typed in a field readable whole: longer than the field,
 * its font gets smaller (down to `min` px).
 * @param {HTMLInputElement} input
 * @param {number} [min]
 */
function fitField(input, min = 13) {
  input.style.fontSize = "";
  const text = input.value;
  if (!text || !input.clientWidth) return;
  const cs = getComputedStyle(input);
  const base = parseFloat(cs.fontSize);
  ruler ??= document.createElement("canvas").getContext("2d");
  if (!ruler || !base) return;
  ruler.font = `${cs.fontWeight} ${base}px ${cs.fontFamily}`;
  const width = ruler.measureText(text).width * 1.05;
  const room = input.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 2;
  if (width <= room || room <= 0) return;
  input.style.fontSize = `${Math.max(min, (base * room) / width).toFixed(2)}px`;
}
document.addEventListener("input", (e) => e.target instanceof HTMLInputElement && fitField(e.target));

// ---------------------------------------------------------------------------
// Joining

/** @param {string} [error] @param {string} [typed] */
function joinForm(error = "", typed) {
  shown = "join";
  refresh = null;
  setTask("join");
  langButton.hidden = false;
  langButton.textContent = t.otherLang;
  const input = /** @type {HTMLInputElement} */ (h("input", { id: "name", maxlength: 16, autocapitalize: "words", autocorrect: "off", spellcheck: "false", enterkeyhint: "go", autocomplete: "off", required: true }));
  const err = h("p", { class: "error" }, error);
  let saved = "";
  try {
    saved = localStorage.getItem("worldquiz:name") ?? "";
  } catch {}
  input.value = typed ?? client.saved?.name ?? saved;
  const form = h(
    "form",
    {
      autocomplete: "off",
      onsubmit: async (/** @type {Event} */ e) => {
        e.preventDefault();
        const name = input.value.trim();
        if (!name) return;
        try {
          localStorage.setItem("worldquiz:name", name);
        } catch {}
        err.textContent = "";
        try {
          await client.join(name);
          langButton.hidden = true;
        } catch (x) {
          joinForm(message(x), name);
        }
      },
    },
    h("label", { for: "name" }, t.yourName),
    input,
    h("button", { class: "btn big wide green", type: "submit" }, t.join),
    err,
  );
  show(h("div", { class: "hero" }, bigLogo()), h("section", { class: "panel pop" }, h("h1", {}, t.joinTitle), form));
  if (!input.value) input.focus();
}

function bigLogo() {
  return h("div", { class: "biglogo" }, logo());
}

client.on("status", (st) => {
  if (st === "reconnecting") setBanner(t.reconnecting);
  else if (st === "open") setBanner(null);
});
client.on("bye", (reason) => {
  const text = reason === "kicked" ? t.kicked : reason === "replaced" ? t.replaced : reason === "room-closed" ? t.roomClosed : null;
  if (!text) return;
  shown = "bye";
  refresh = null;
  clean();
  setTask("bye");
  setBanner(null);
  show(h("div", { class: "hero" }, bigLogo()), h("section", { class: "panel" }, h("p", { class: "big" }, text)));
});
client.on("view", (view) => render(view));

// ---------------------------------------------------------------------------
// Views

/** @param {string} task */
function setTask(task) {
  app.dataset["task"] = task;
  document.body.className = `task-${task}`;
}

function clean() {
  for (const c of cleanups) c();
  cleanups = [];
  hooks.map = null;
}

/** @param {any} me @param {any} room */
function keyOf(me, room) {
  const r = room.round ?? "";
  switch (me.task) {
    case "card":
      return `card:${me.key}:${me.captain ? 1 : 0}`;
    case "watch":
      return `watch:${me.what}:${r}:${room.try ?? ""}:${me.kind ?? ""}`;
    case "answer":
      return `answer:${me.key}`;
    case "result":
      return `result:${r}:${me.solution?.id ?? ""}:${me.kind ?? ""}`;
    default:
      return `${me.task}:${r}`;
  }
}

/** @param {Record<string, any>} view */
function render(view) {
  const me = view["me"] ?? {};
  const room = view["room"] ?? {};
  const mine = (view["roster"] ?? []).find((/** @type {any} */ r) => r.id === myId());
  if (useLang()) shown = "";
  header(me, room, mine);
  const key = keyOf(me, room);
  if (key !== shown) {
    shown = key;
    refresh = null;
    clean();
    langButton.hidden = true;
    setTask(me.task ?? "none");
    build(me, room);
    window.scrollTo(0, 0);
  }
  refresh?.();
}

/** The header: one's name with the colour dot, one's steps as a little plane. @param {any} me @param {any} room @param {any} mine */
function header(me, room, mine) {
  if (!mine) return who.replaceChildren();
  const steps = typeof me.steps === "number" ? me.steps : (room.steps?.[mine.id] ?? 0);
  const playing = me.task && me.task !== "lobby" && me.task !== "wait";
  who.replaceChildren(h("span", { class: "dot", style: { "--c": colorOf(mine.id) } }), h("b", {}, `${mine.vip ? "★ " : ""}${mine.name}`));
  if (playing) who.append(h("span", { class: "steps", title: t.stepsN(steps) }, h("span", { class: "plane", html: PLANE }), t.n(steps)));
}

/** @param {any} me @param {any} room */
function build(me, room) {
  switch (me.task) {
    case "lobby":
      return lobby();
    case "wait":
      return show(h("section", { class: "panel pop center" }, h("p", { class: "big" }, t.waitRound), h("p", { class: "note" }, t.lookTv)));
    case "card":
      return cardScreen(me, room);
    case "compete":
      return competeScreen(me, room);
    case "watch":
      return watching(me, room);
    case "answer":
      return answerScreen(me, room);
    case "result":
      return result(me, room);
    case "final":
      return final(me);
    default:
      return show(h("section", { class: "panel center" }, h("p", { class: "big" }, t.lookTv)));
  }
}

// ---------------------------------------------------------------------------
// Lobby and final: players, the VIP's settings, start.

/** @param {HTMLElement} err */
function settings(err) {
  /** @type {{ key: string, buttons: HTMLButtonElement[], values: any[], line: HTMLElement | null, lines: ((v: any) => string) | null }[]} */
  const items = [];
  const box = h("div", { class: "settings" }, h("h2", {}, t.settings));
  /**
   * @param {string} key @param {any[]} values @param {string[]} labels @param {string} title
   * @param {((v: any) => string) | null} [lines]
   */
  const add = (key, values, labels, title, lines = null) => {
    const buttons = values.map((v, i) => /** @type {HTMLButtonElement} */ (h("button", { type: "button", class: "btn small white", "data-setting": key, "data-value": String(v), onclick: () => act("settings", { [key]: v }, err).catch(() => {}) }, labels[i] ?? "")));
    const line = lines ? h("p", { class: "line" }) : null;
    box.append(h("div", { class: "setting" }, h("label", {}, title), h("div", { class: "seg" }, ...buttons), line));
    items.push({ key, buttons, values, line, lines });
  };
  add("mode", ["cards", "quiz"], [t.modes.cards, t.modes.quiz], t.modeLabel, (v) => t.modeLine[/** @type {"cards"} */ (v)] ?? "");
  add("rounds", [15, 30, 45], ["15", "30", "45"], t.roundsLabel);
  add("difficulty", ["easy", "normal", "hard"], [t.levels.easy, t.levels.normal, t.levels.hard], t.difficultyLabel, (v) => t.levelLine[/** @type {"easy"} */ (v)] ?? "");
  add("countries", ["famous", "known", "all"], [t.pools.famous, t.pools.known, t.pools.all], t.countriesLabel, (v) => t.poolLine[/** @type {"famous"} */ (v)] ?? "");
  add("disputed", [false, true], [t.off, t.on], t.disputedLabel, (v) => t.disputedLine[v ? 1 : 0] ?? "");
  add("map", ["flat", "globe"], [t.flat, t.globe], t.mapLabel);
  // The kinds in the mix: each a switch, one always on.
  const kindsOn = () => /** @type {Kind[]} */ (Array.isArray(V().room?.kinds) ? V().room.kinds : KINDS);
  const kindButtons = KINDS.map((k) =>
    /** @type {HTMLButtonElement} */ (
      h(
        "button",
        {
          type: "button",
          class: "btn small white kindbtn",
          "data-kind": k,
          onclick: () => {
            const on = kindsOn();
            const next = on.includes(k) ? on.filter((x) => x !== k) : KINDS.filter((x) => x === k || on.includes(x));
            if (next.length) act("settings", { kinds: next }, err).catch(() => {});
          },
        },
        h("span", { class: "ico", html: KIND_ICONS[k] ?? "" }),
        h("span", { class: "kname" }, t.kinds[k] ?? k),
      )
    ),
  );
  box.append(h("div", { class: "setting" }, h("label", {}, t.kindsLabel), h("div", { class: "kindgrid" }, ...kindButtons), h("p", { class: "line" }, t.kindsLine)));
  const update = () => {
    const room = V().room ?? {};
    box.hidden = !isVip();
    const on = kindsOn();
    for (const b of kindButtons) {
      const yes = on.includes(/** @type {Kind} */ (b.dataset["kind"]));
      b.classList.toggle("on", yes);
      b.classList.toggle("white", !yes);
      b.setAttribute("aria-pressed", String(yes));
    }
    for (const it of items) {
      const cur = it.key === "rounds" ? (room.roundsSetting ?? room.rounds) : room[it.key];
      it.buttons.forEach((b, i) => {
        const on = it.values[i] === cur;
        b.classList.toggle("on", on);
        b.classList.toggle("white", !on);
        b.setAttribute("aria-pressed", String(on));
      });
      if (it.line && it.lines) it.line.textContent = it.lines(cur);
    }
  };
  return { box, update };
}

function lobby() {
  const err = h("p", { class: "error" });
  const list = h("div", { class: "chips" });
  const hint = h("p", { class: "note" });
  const start = /** @type {HTMLButtonElement} */ (h("button", { class: "btn big wide green", id: "start", onclick: () => act("start", null, err).catch(() => {}) }, h("span", { html: PLANE }), t.start));
  const set = settings(err);
  show(
    h("section", { class: "panel pop lobby" }, h("h1", {}, t.youreIn), h("h2", {}, t.travellers), list, start, err, hint, set.box),
    h("section", { class: "panel plain" }, h("h2", { class: "top" }, t.howTitle), h("ol", { class: "how" }, ...t.how.map((x) => h("li", {}, x)))),
  );
  refresh = () => {
    const v = V();
    const roster = v["roster"] ?? [];
    const vip = isVip();
    const min = v["room"]?.minPlayers ?? 2;
    const ready = roster.filter((/** @type {any} */ r) => r.connected).length;
    list.replaceChildren(
      ...roster.map((/** @type {any} */ r) =>
        h(
          "span",
          { class: `chip${r.connected ? "" : " away"}${r.id === myId() ? " me" : ""}`, style: { "--c": colorOf(r.id) } },
          h("span", { class: "dot" }),
          h("span", { class: "nm" }, r.name),
          r.vip ? h("small", {}, t.vip) : null,
          vip && r.id !== myId() ? h("button", { type: "button", class: "kick", "aria-label": `✕ ${r.name}`, onclick: () => act("kick", { id: r.id }, err).catch(() => {}) }, "✕") : null,
        ),
      ),
    );
    start.hidden = !vip;
    start.disabled = ready < min;
    hint.textContent = vip ? (ready < min ? t.vipWait(min - ready) : t.vipReady) : t.waitVip;
    set.update();
  };
}

/** @param {any} me */
function final(me) {
  const err = h("p", { class: "error" });
  const again = /** @type {HTMLButtonElement} */ (h("button", { class: "btn big wide green", id: "start", onclick: () => act("start", null, err).catch(() => {}) }, t.playAgain));
  const set = settings(err);
  const vipBox = h("section", { class: "panel lobby" }, again, err, set.box);
  const won = !!me.won;
  if (won) buzz([60, 40, 60, 40, 120]);
  show(
    h(
      "section",
      { class: `panel pop center final${won ? " won" : ""}` },
      h("div", { class: "trophy", html: won ? TROPHY : PLANE }),
      h("h1", {}, won ? t.won : t.gameOver),
      me.of ? h("p", { class: "place" }, t.place(me.place ?? 0, me.of)) : null,
      h("p", { class: "note" }, t.stepsN(me.steps ?? 0)),
    ),
    vipBox,
  );
  refresh = () => {
    vipBox.hidden = !isVip();
    set.update();
  };
}
const TROPHY = '<svg viewBox="0 0 40 40" aria-hidden="true"><path d="M11 5h18v9a9 9 0 0 1-18 0z" fill="#ffc61a" stroke="#263450" stroke-width="3" stroke-linejoin="round"/><path d="M11 8H5c0 6 3 9 7 9M29 8h6c0 6-3 9-7 9" fill="none" stroke="#263450" stroke-width="3"/><path d="M17 23h6v6h-6zM12 35c0-4 4-6 8-6s8 2 8 6z" fill="#ffc61a" stroke="#263450" stroke-width="3" stroke-linejoin="round"/></svg>';

// ---------------------------------------------------------------------------
// Pieces: the clock, the round line

/**
 * A time bar and the seconds, ticking until the deadline; `onLow` once just before it.
 * @param {number} deadline @param {(() => void) | null} [onLow]
 */
function clock(deadline, onLow = null) {
  const bar = h("div", { class: "timebar" }, h("i"));
  const secs = h("span", { class: "secs" });
  const total = Math.max(1000, deadline - client.now());
  const fill = /** @type {HTMLElement} */ (bar.firstChild);
  let low = onLow;
  const tick = () => {
    const ms = deadline - client.now();
    fill.style.transform = `scaleX(${Math.max(0, Math.min(1, ms / total))})`;
    secs.textContent = String(Math.max(0, Math.ceil(Math.min(ms, total) / 1000)));
    bar.classList.toggle("low", ms < 5000);
    secs.classList.toggle("low", ms < 5000 && ms > 0);
    if (ms < 600 && low) {
      const f = low;
      low = null;
      f();
    }
  };
  tick();
  const timer = setInterval(tick, 200);
  cleanups.push(() => clearInterval(timer));
  return h("div", { class: "clockrow" }, bar, secs);
}

/** "Round 3 of 15". @param {any} room */
function roundLine(room) {
  return room.round && room.rounds ? h("p", { class: "round" }, t.roundN(room.round, room.rounds)) : null;
}

// ---------------------------------------------------------------------------
// The card (and the captain's choice), the gone cards

/** Which tab of the card screen, per round. */
let tab = { key: "", gone: false };

/** @param {any} me @param {any} room */
function cardScreen(me, room) {
  const card = me.card ?? {};
  if (tab.key !== me.key) tab = { key: me.key ?? "", gone: false };
  const tabCard = h("button", { type: "button", class: "tab", "data-tab": "card" }, t.tabCard);
  const tabGone = h("button", { type: "button", class: "tab", "data-tab": "gone" }, t.tabGone);
  const err = h("p", { class: "error" });
  const map = mapView({ hot: card.id, box: card.box, at: card.at, cls: `cardmap${me.captain ? " short" : ""}`, fill: 0.45 });
  const el = cardEl(card, lang, { stamp: t.stamp, hideRanks: true });
  if (me.captain) {
    buzz([60, 40, 60]);
    /** @type {HTMLButtonElement[]} */
    const buttons = [];
    const choose = async (/** @type {HTMLButtonElement} */ b, /** @type {any} */ data) => {
      for (const x of buttons) x.disabled = true;
      b.classList.add("down", "chosen");
      buzz(15);
      try {
        await act("choose", { key: me.key, ...data }, err);
      } catch {
        b.classList.remove("down", "chosen");
        for (const x of buttons) x.disabled = false;
      }
    };
    const f = numbers(lang);
    for (const k of FACTS) {
      const b = /** @type {HTMLButtonElement} */ (
        h(
          "button",
          { type: "button", class: `btn wide choice ${FACT_COLORS[k]}`, "data-fact": k },
          h("span", { class: "ico", html: ICONS[k] }),
          h("span", { class: "txt" }, h("span", { class: "lab" }, SHORT[lang][k]), h("span", { class: "val" }, f.fact(k, card.facts?.[k] ?? 0))),
        )
      );
      b.addEventListener("click", () => choose(b, { fact: k }));
      buttons.push(b);
    }
    const ch = /** @type {HTMLButtonElement} */ (h("button", { type: "button", class: "btn wide pink choice challenge", "data-challenge": "1" }, h("span", { class: "ico", html: CHALLENGE_ICON }), h("span", { class: "txt" }, h("span", { class: "val" }, t.challenge), h("small", {}, t.challengeLine))));
    ch.addEventListener("click", () => choose(ch, { challenge: true }));
    buttons.push(ch);
    el.querySelector(".facts")?.replaceWith(h("div", { class: "choices" }, ...buttons));
  }
  const top = me.captain
    ? h("section", { class: "panel pop captain" }, h("h1", { "data-fit": "1" }, t.captainTitle), me.deadline ? clock(me.deadline) : null, err)
    : h("section", { class: "panel pop waiting" }, h("p", { class: "big", "data-fit": "2" }, t.chooses(nameOf(room.captain))), h("p", { class: "note" }, t.choosesHint), me.deadline ? clock(me.deadline) : null);
  const cardPane = h("div", { class: "pane" }, map.el, h("div", { class: `cardwrap${me.captain ? " choosing" : ""}` }, el));
  const gonePane = h("div", { class: "pane" });
  show(roundLine(room), top, h("div", { class: "tabs" }, tabCard, tabGone), cardPane, gonePane);
  const setTab = () => {
    cardPane.hidden = tab.gone;
    gonePane.hidden = !tab.gone;
    tabCard.classList.toggle("on", !tab.gone);
    tabGone.classList.toggle("on", tab.gone);
  };
  tabCard.addEventListener("click", () => {
    tab.gone = false;
    setTab();
  });
  tabGone.addEventListener("click", () => {
    tab.gone = true;
    setTab();
  });
  setTab();
  let goneKey = "";
  refresh = () => {
    const r = V().room ?? {};
    const k = JSON.stringify([r.gone, r.left, r.deckSize]);
    if (k === goneKey) return;
    goneKey = k;
    gonePane.replaceChildren(goneList(r));
  };
}

/** Per number, the cards of its top ten that are on the discard pile (`room.gone`), and the cards left. @param {any} room */
function goneList(room) {
  const gone = room.gone ?? {};
  const rows = FACTS.filter((k) => Array.isArray(gone[k]) && gone[k].length > 0);
  const box = h("section", { class: "panel gone" }, h("h2", { class: "top" }, t.goneTitle));
  if (!rows.length) box.append(h("p", { class: "note empty" }, t.goneNone));
  else box.append(h("p", { class: "note" }, t.goneHint));
  for (const k of rows) {
    const items = /** @type {any[]} */ (gone[k]).slice().sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
    box.append(
      h(
        "div",
        { class: "gonefact" },
        h("div", { class: "gonehead" }, h("span", { class: "ico", html: ICONS[k] }), LABELS[lang][k]),
        h(
          "ul",
          {},
          ...items.map((c) =>
            h("li", {}, h("img", { class: "mini", src: flagSrc(c.flag ?? ""), alt: "" }), h("span", { class: "nm" }, c.name ?? ""), h("span", { class: `rank${(c.rank ?? 99) <= STRONG ? " gold" : ""}` }, `#${c.rank ?? "?"}`)),
          ),
        ),
      ),
    );
  }
  if (typeof room.left === "number" && typeof room.deckSize === "number") box.append(h("p", { class: "left" }, t.cardsLeft(room.left, room.deckSize)));
  return box;
}

/** Compete: one's card turned over with the number, one's place, the winners. @param {any} me @param {any} room */
function competeScreen(me, room) {
  const won = !!me.won;
  if (won) buzz([40, 30, 80]);
  show(
    roundLine(room),
    h(
      "section",
      { class: `panel pop center verdict${won ? " yes" : " no"}` },
      h("p", { class: "factname" }, h("span", { class: "ico", html: ICONS[/** @type {Fact} */ (me.fact)] ?? "" }), LABELS[lang][/** @type {Fact} */ (me.fact)] ?? ""),
      h("h1", {}, won ? t.wonStep : t.noStep),
      me.of ? h("p", { class: "place" }, t.place(me.place ?? 0, me.of)) : null,
      h("p", { class: "note" }, t.winners(me.winners ?? [])),
    ),
    h("div", { class: "cardwrap" }, cardEl(me.card ?? {}, lang, { pick: me.fact ?? null, stamp: t.stamp })),
    nextRow(me),
  );
}

/**
 * Next: what shows cards or an answer stays until everyone pressed it
 * (game/game.ts); pressed, who the game still waits for.
 * @param {any} me
 */
function nextRow(me) {
  if (!me.next) return null;
  const key = String(me.next);
  const err = h("p", { class: "error" });
  const status = h("p", { class: "status" });
  let sending = false;
  const btn = /** @type {HTMLButtonElement} */ (
    h(
      "button",
      {
        type: "button",
        id: "next",
        class: "btn big green",
        onclick: async () => {
          if (sending || V().me?.ready) return;
          sending = true;
          btn.disabled = true;
          buzz(15);
          try {
            await act("next", { key }, err);
          } catch {
          } finally {
            sending = false;
            refresh?.();
          }
        },
      },
      t.next,
      h("span", { html: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4l9 8-9 8z"/></svg>' }),
    )
  );
  const count = h("p", { class: "count" });
  const row = h("div", { class: "nextrow" }, status, count, btn, err);
  // The countdown (once someone pressed, or the wait is long): the stage goes on by itself.
  const tick = () => {
    const by = V().room?.nextBy;
    const s = typeof by === "number" ? Math.max(0, Math.ceil((by - client.now()) / 1000)) : null;
    count.hidden = s === null;
    if (s !== null) {
      count.textContent = t.nextIn(s);
      count.classList.toggle("low", s <= 5);
    }
  };
  const timer = setInterval(tick, 250);
  cleanups.push(() => clearInterval(timer));
  refresh = () => {
    const v = V();
    const done = !!v.me?.ready || v.me?.next !== key;
    btn.disabled = done || sending;
    btn.hidden = done;
    const room = v.room ?? {};
    const ready = new Set(room.ready ?? []);
    const connected = new Set((v.roster ?? []).filter((/** @type {any} */ r) => r.connected).map((/** @type {any} */ r) => r.id));
    const waiting = (room.nextFor ?? []).filter((/** @type {string} */ id) => !ready.has(id) && connected.has(id) && id !== myId()).map(nameOf);
    status.textContent = done ? t.nextWait(waiting) : "";
    status.hidden = !done;
    tick();
  };
  return row;
}

// ---------------------------------------------------------------------------
// Watching the TV: the hands discarded, a challenge announced, a tie-break

/** @param {any} me @param {any} room */
function watching(me, room) {
  if (me.what === "discard") {
    return show(
      roundLine(room),
      h("section", { class: "panel pop center" }, h("div", { class: "tvicon", html: TV_ICON }), h("h1", {}, t.discardTitle), h("p", { class: "note" }, t.discardHint)),
      h("div", { class: "cardwrap small" }, cardEl(me.card ?? {}, lang, { stamp: t.stamp })),
      nextRow(me),
    );
  }
  if (me.what === "announce") {
    const kind = /** @type {Kind} */ (me.kind ?? room.kind ?? "where");
    buzz(30);
    return show(
      roundLine(room),
      h(
        "section",
        { class: `panel pop center announce kind-${kind}` },
        room.tiebreak ? h("p", { class: "tag" }, t.tiebreak) : room.try > 1 ? h("p", { class: "tag" }, t.tryN(room.try)) : null,
        h("div", { class: "kindicon", html: KIND_ICONS[kind] ?? "" }),
        h("h1", { class: "huge", "data-fit": "1" }, t.kinds[kind] ?? ""),
        h("p", { class: "note" }, t.kindLines[kind] ?? ""),
      ),
    );
  }
  if (me.what === "tiebreak") {
    return show(h("section", { class: "panel pop center announce" }, h("div", { class: "kindicon", html: KIND_ICONS.where }), h("h1", {}, t.tiebreak), h("p", { class: "note" }, t.tiebreakWatch)));
  }
  show(h("section", { class: "panel center" }, h("p", { class: "big" }, t.lookTv)));
}
const TV_ICON = '<svg viewBox="0 0 40 40" aria-hidden="true"><rect x="3" y="7" width="34" height="23" rx="4" fill="#6cc7e8" stroke="#263450" stroke-width="3"/><path d="M14 36h12M20 30v6" stroke="#263450" stroke-width="3" stroke-linecap="round"/><rect x="9" y="12" width="9" height="13" rx="2" fill="#fff8e8" stroke="#263450" stroke-width="2"/><rect x="22" y="12" width="9" height="13" rx="2" fill="#fff8e8" stroke="#263450" stroke-width="2"/></svg>';

// ---------------------------------------------------------------------------
// Answering

/** What one has typed, pinned, picked or guessed, per challenge (kept over a reconnect). @type {Map<string, { text?: string, lon?: number, lat?: number, choice?: number, value?: number }>} */
const drafts = new Map();

/** @param {any} me @param {any} room */
function answerScreen(me, room) {
  const kind = /** @type {Kind} */ (me.kind);
  const how = HOW[kind] ?? "text";
  const q = me.question ?? {};
  const key = String(me.key ?? "");
  // After a reload the host's copy of the draft brings it back.
  const draft = drafts.get(key) ?? { ...(me.draft ?? {}) };
  drafts.set(key, draft);
  const err = h("p", { class: "error" });
  const lock = /** @type {HTMLButtonElement} */ (h("button", { type: "submit", id: "lock", class: "btn big green lock" }, t.lock));
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  let sending = false;
  /** The answer as the action takes it, or null when there is none (an empty text only unlocked). @param {boolean} lockIt */
  const payload = (lockIt) => {
    if (how === "pin") return draft.lon === undefined ? null : { key, lon: draft.lon, lat: draft.lat, lock: lockIt };
    if (how === "choice") return draft.choice === undefined ? null : { key, choice: draft.choice, lock: lockIt };
    if (how === "number") return draft.value === undefined ? null : { key, value: draft.value, lock: lockIt };
    return lockIt && !(draft.text ?? "").trim() ? null : { key, text: draft.text ?? "", lock: lockIt };
  };
  const has = () => payload(true) !== null;
  /** Sends the draft (not locked), debounced. */
  const sendDraft = (now = false) => {
    clearTimeout(timer);
    const go = () => {
      timer = undefined;
      if (me.locked || V().me?.locked) return;
      const data = payload(false);
      if (data) act("answer", data).catch(() => {});
    };
    if (now) go();
    else timer = setTimeout(go, 300);
  };
  cleanups.push(() => {
    if (timer !== undefined) sendDraft(true);
  });
  const locked = () => !!V().me?.locked;
  const lockIn = async () => {
    if (sending || locked()) return;
    const data = payload(true);
    if (!data) {
      err.textContent = how === "pin" ? t.tapMap : how === "choice" ? t.tapPick : how === "number" ? t.slide : (t.errors["bad-answer"] ?? "");
      buzz([30, 60, 30]);
      return;
    }
    clearTimeout(timer);
    timer = undefined;
    sending = true;
    lock.disabled = true;
    try {
      await act("answer", data, err);
      buzz(20);
    } catch {
    } finally {
      sending = false;
      refresh?.();
    }
  };
  const tick = clock(me.deadline ?? 0, () => {
    if (timer !== undefined) sendDraft(true);
  });
  /** @type {HTMLInputElement | null} */
  let input = null;
  /** @type {ReturnType<typeof mapView> | null} */
  let map = null;
  /** The options' buttons (choice kinds). @type {HTMLButtonElement[]} */
  const opts = [];
  /** Shows the guess (number kind). @type {(() => void) | null} */
  let showGuess = null;
  const status = h("p", { class: "status" });
  const lockRow = () => h("form", { class: "lockrow", onsubmit: (/** @type {Event} */ e) => (e.preventDefault(), void lockIn()) }, status, lock);
  /** @param {number} i */
  const pickOption = (i) => {
    if (locked() || sending) return;
    draft.choice = i;
    err.textContent = "";
    buzz(12);
    sendDraft();
    refresh?.();
  };
  /** An option's button. @param {number} i @param {...(Node | null)} kids */
  const option = (i, ...kids) => {
    const b = /** @type {HTMLButtonElement} */ (h("button", { type: "button", class: "opt", "data-choice": String(i), onclick: () => pickOption(i) }, h("b", { class: "letter" }, LETTERS[i] ?? ""), ...kids));
    opts.push(b);
    return b;
  };

  if (how === "pin") {
    const mark = () => (draft.lon === undefined || draft.lat === undefined ? [] : [{ lon: draft.lon, lat: draft.lat, color: colorOf(myId()), big: true }]);
    map = mapView({
      id: "wmap",
      cls: "wheremap",
      interactive: true,
      borders: me.borders !== false,
      marks: mark(),
      onTap: ([lon, lat]) => {
        if (locked() || sending) return;
        draft.lon = Math.round(lon * 1000) / 1000;
        draft.lat = Math.round(lat * 1000) / 1000;
        if (map?.map) map.map.marks = mark();
        err.textContent = "";
        buzz(12);
        sendDraft();
        refresh?.();
      },
      onMap: (m) => {
        hooks.map = m;
      },
    });
    show(h("section", { class: "panel pop question where" }, h("p", { class: "ask" }, t.whereIs), h("h1", { "data-fit": "1" }, q.name ?? "?"), tick), map.el, lockRow(), err);
  } else if (kind === "pickflag") {
    const flags = /** @type {string[]} */ (q.flags ?? []);
    const grid = h("div", { class: `flaggrid n${flags.length}` }, ...flags.map((f, i) => option(i, h("img", { src: flagSrc(f), alt: "" }))));
    show(h("section", { class: "panel pop question where" }, h("p", { class: "ask" }, t.kindLines.pickflag), h("h1", { "data-fit": "2" }, q.name ?? "?"), tick), grid, lockRow(), err);
  } else if (kind === "bigger" || kind === "odd") {
    const fact = /** @type {"population" | "area" | "highest" | "gdp"} */ (q.fact);
    const head =
      kind === "bigger"
        ? h("section", { class: "panel pop question where" }, h("p", { class: "factname" }, h("span", { class: "ico", html: ICONS[fact] ?? "" }), LABELS[lang][fact] ?? ""), h("h1", { "data-fit": "2" }, t.biggerQ[fact] ?? ""), tick)
        : h("section", { class: "panel pop question where" }, h("div", { class: "qrow" }, h("img", { class: "qflag", src: flagSrc(q.flag ?? ""), alt: "" }), h("h1", { "data-fit": "2" }, t.oddOf(q.name ?? "?"))), tick);
    const list = h("div", { class: "opts" }, ...(q.options ?? []).map((/** @type {any} */ o, /** @type {number} */ i) => option(i, h("img", { class: "oflag", src: flagSrc(o.flag ?? ""), alt: "" }), h("span", { class: "oname" }, o.name ?? ""))));
    show(head, list, lockRow(), err);
  } else if (how === "number") {
    const fact = /** @type {"population" | "area" | "highest"} */ (q.fact);
    const lo = Math.max(1e-9, Number(q.min) || 1);
    const hi = Math.max(lo * 10, Number(q.max) || lo * 10);
    const f = numbers(lang);
    const STEPS = 1000;
    const toValue = (/** @type {number} */ pos) => roundNice(Math.exp(Math.log(lo) + (pos / STEPS) * (Math.log(hi) - Math.log(lo))));
    const toPos = (/** @type {number} */ v) => Math.round(((Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo))) * STEPS);
    const slider = /** @type {HTMLInputElement} */ (h("input", { type: "range", id: "guess", min: "0", max: String(STEPS), step: "1", value: String(draft.value === undefined ? STEPS / 2 : toPos(draft.value)), "aria-label": t.guessQ[fact]?.(q.name ?? "") ?? "" }));
    const value = h("p", { class: "gvalue" });
    const set = (/** @type {number} */ v) => {
      if (locked() || sending) return;
      draft.value = Math.max(lo, Math.min(hi, v));
      slider.value = String(toPos(draft.value));
      err.textContent = "";
      sendDraft();
      refresh?.();
    };
    slider.addEventListener("input", () => set(toValue(Number(slider.value))));
    showGuess = () => {
      value.textContent = draft.value === undefined ? "?" : f.fact(fact, draft.value);
      value.classList.toggle("unset", draft.value === undefined);
    };
    const nudge = (/** @type {number} */ k) => set(roundNice((draft.value ?? toValue(Number(slider.value))) * k));
    const ends = h("div", { class: "gends" }, h("span", {}, f.fact(fact, lo)), h("span", {}, f.fact(fact, hi)));
    show(
      h("section", { class: "panel pop question where" }, h("div", { class: "qrow" }, h("img", { class: "qflag", src: flagSrc(q.flag ?? ""), alt: "" }), h("h1", { "data-fit": "2" }, t.guessQ[fact]?.(q.name ?? "?") ?? "")), tick),
      h(
        "section",
        { class: "panel guess" },
        value,
        slider,
        ends,
        h("div", { class: "gnudge" }, h("button", { type: "button", class: "btn white small", onclick: () => nudge(1 / 1.1) }, `− ${t.less}`), h("button", { type: "button", class: "btn white small", onclick: () => nudge(1.1) }, `+ ${t.more}`)),
      ),
      lockRow(),
      err,
    );
  } else {
    const placeholder = kind === "capital" ? t.capitalOf(q.name ?? "?") : kind === "neighbour" ? t.neighbourOf(q.name ?? "?") : t.whichCountry;
    input = /** @type {HTMLInputElement} */ (
      // No password managers' or contacts' autofill on a quiz answer.
      h("input", { id: "answer", class: "answer", maxlength: MAX_ANSWER, autocomplete: "off", "data-1p-ignore": "", "data-lpignore": "true", "data-form-type": "other", autocorrect: "off", autocapitalize: "words", spellcheck: "false", enterkeyhint: "go", placeholder, "aria-label": placeholder })
    );
    const field = input;
    field.value = draft.text ?? "";
    field.addEventListener("input", () => {
      draft.text = field.value.slice(0, MAX_ANSWER);
      err.textContent = "";
      sendDraft();
      refresh?.();
    });
    const form = h("form", { class: "panel answerform", autocomplete: "off", onsubmit: (/** @type {Event} */ e) => (e.preventDefault(), void lockIn()) }, field, lock, status, err);
    if (kind === "shape") {
      // The outline is the question: the map first, then the field.
      // The country alone on the sea: no neighbours, no grid to tell where.
      map = mapView({ outline: decodeRings(q.shape ?? []), lone: true, box: q.box ?? null, at: null, cls: "shapemap", fill: 0.6, maxZoom: 40, interactive: true, borders: me.borders !== false });
      show(h("section", { class: "panel pop question where" }, h("p", { class: "ask" }, t.kindLines.shape), tick), map.el, form);
    } else {
      const head =
        kind === "capital" || kind === "neighbour"
          ? h("section", { class: `panel pop question ${kind}` }, h("div", { class: "qrow" }, h("img", { class: "qflag", src: flagSrc(q.flag ?? ""), alt: "" }), h("h1", { "data-fit": "2" }, q.name ?? "?")), kind === "neighbour" ? h("p", { class: "ask" }, t.kindLines.neighbour) : null, tick)
          : h("section", { class: "panel pop question flagq" }, h("img", { class: "bigflag", src: flagSrc(q.flag ?? ""), alt: "" }), tick);
      if (kind === "capital" || kind === "neighbour") map = mapView({ hot: q.id ?? null, box: q.box ?? null, at: q.at ?? null, cls: "qmap", fill: kind === "neighbour" ? 0.25 : 0.4 });
      show(head, form, map ? map.el : null);
    }
    if (!locked()) field.focus({ preventScroll: true });
  }
  buzz([50, 30, 50]);
  refresh = () => {
    const done = locked();
    lock.disabled = done || sending || (how !== "text" && !has());
    lock.textContent = done ? t.locked : t.lock;
    lock.classList.toggle("done", done);
    if (input) input.disabled = done;
    if (done && input && document.activeElement === input) input.blur();
    opts.forEach((b, i) => {
      b.classList.toggle("picked", draft.choice === i);
      b.setAttribute("aria-pressed", String(draft.choice === i));
      b.disabled = done && draft.choice !== i;
    });
    showGuess?.();
    // An answer counts at the deadline; Done only ends it early.
    status.textContent = done ? t.lockedWait : !has() ? (how === "pin" ? t.tapMap : how === "choice" ? t.tapPick : how === "number" ? t.slide : "") : how === "pin" ? t.pinCounts : how === "choice" ? t.pickCounts : how === "number" ? t.guessCounts : t.textCounts;
    document.body.classList.toggle("locked", done);
  };
  void room;
}

/** A guess rounded to 2 significant digits (3 from 1,000 on), as people say numbers. @param {number} v */
function roundNice(v) {
  if (!(v > 0)) return v;
  const digits = v >= 1000 ? 3 : 2;
  const p = Math.pow(10, Math.floor(Math.log10(v)) - digits + 1);
  return Math.round(v / p) * p;
}

// ---------------------------------------------------------------------------
// The answer

/** @param {any} me @param {any} room */
function result(me, room) {
  const right = !!me.right;
  const sol = me.solution ?? {};
  const mine = me.mine;
  const f = numbers(lang);
  buzz(right ? [40, 30, 90] : 120);
  const how = HOW[/** @type {Kind} */ (me.kind)] ?? "text";
  const rv = me.reveal ?? {};
  const mark = right ? "✓" : "✗";
  /** @type {Node | null} */
  let answer = null;
  if (me.kind === "where") {
    answer = h("p", { class: "mine" }, !mine || mine.km === null || mine.km === undefined ? t.noPin : mine.km === 0 ? t.hit : t.kmAway(f.km(mine.km)));
  } else if (how === "choice") {
    const o = typeof mine?.choice === "number" ? rv.options?.[mine.choice] : null;
    answer = !o
      ? h("p", { class: "mine" }, t.noPick)
      : me.kind === "pickflag"
        ? h("p", { class: "mine" }, h("img", { class: "qflag small", src: flagSrc(o.flag ?? ""), alt: "" }), " ", o.name ?? "", " ", mark)
        : h("p", { class: "mine" }, o.name ?? "", " ", mark);
  } else if (how === "number") {
    answer =
      typeof mine?.value !== "number"
        ? h("p", { class: "mine" }, t.noGuess)
        : h("p", { class: "mine" }, f.fact(rv.fact, mine.value), " ", mark, typeof mine.off === "number" ? h("span", { class: "off" }, mine.off < 1.005 ? t.hit : t.offBy(timesText(mine.off))) : null);
  } else {
    const text = mine?.text ?? "";
    answer = text
      ? h("p", { class: "mine" }, h("span", { class: "typed" }, `“${text}”`), mine?.as && mine.as !== text ? h("span", {}, ` → ${mine.as}`) : null, " ", right ? "✓" : "✗")
      : h("p", { class: "mine" }, t.noAnswer);
  }
  const pinned = me.kind === "where" && mine && typeof mine.lon === "number" && typeof mine.lat === "number";
  const pins = pinned ? [{ lon: mine.lon, lat: mine.lat, color: colorOf(myId()), big: true }] : [];
  // One's pin with its line to the country, and both in view.
  const lines = pinned && mine.km > 0 && Array.isArray(mine.to) ? [{ from: /** @type {LonLat} */ ([mine.lon, mine.lat]), to: mine.to, color: colorOf(myId()), label: f.km(mine.km), at: performance.now() + 600 }] : [];
  let box = sol.box ?? null;
  let at = sol.at ?? null;
  let fill = 0.35;
  if (pinned && box) {
    let [w, so, e, n] = box;
    if (e < w) e += 360;
    let lon = mine.lon;
    const mid = (w + e) / 2;
    while (lon - mid > 180) lon -= 360;
    while (mid - lon > 180) lon += 360;
    box = [Math.min(w, lon), Math.min(so, mine.lat), Math.max(e, lon), Math.max(n, mine.lat)];
    at = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
    fill = 0.7;
  }
  /** @type {string[]} */
  let warm = [];
  let hot = sol.id ?? null;
  // Several countries on the map: the neighbours beside the country, the four of "which is bigger", the odd one.
  const placed = /** @type {any[]} */ (me.kind === "neighbour" ? (rv.neighbours ?? []) : me.kind === "bigger" || me.kind === "odd" ? (rv.options ?? []) : []);
  if (placed.length) {
    warm = placed.map((o) => o.id).filter((id) => id !== hot);
    if (me.kind === "odd") {
      const odd = rv.options?.[rv.right];
      warm = warm.filter((id) => id !== odd?.id);
      if (odd?.at) pins.push({ lon: odd.at[0], lat: odd.at[1], color: "#ef4444", big: true });
      hot = rv.of?.id ?? hot;
    }
    const all = [sol.box, ...placed.map((o) => o.box)].filter((b) => Array.isArray(b) && b.length === 4);
    if (all.length) {
      box = unionBox(all);
      at = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
      fill = 0.75;
    }
  }
  const map = mapView({ hot, warm, box, at, cls: "solmap", fill, marks: pins, lines });
  show(
    h(
      "section",
      { class: `panel pop center verdict ${right ? "yes" : "no"}` },
      room.tiebreak ? h("p", { class: "tag" }, t.tiebreak) : null,
      h("div", { class: "mark" }, right ? "✓" : "✗"),
      h("h1", {}, right ? t.right : t.wrong),
      h("p", { class: "label" }, t.yourAnswer),
      answer,
      (me.winners ?? []).length ? h("p", { class: "note" }, t.winners(me.winners)) : me.again ? null : h("p", { class: "note" }, t.nobody),
    ),
    me.again ? h("p", { class: "again pop" }, t.again) : null,
    revealPanel(me),
    // Where it is, then its whole card.
    h("section", { class: "panel solution" }, map.el),
    h("div", { class: "cardwrap small" }, cardEl(sol, lang)),
    nextRow(me),
  );
}

/**
 * Where a guess's number line starts and ends: ×10 past the answer and
 * the guesses (and the level's band), within the slider's ends.
 * @param {{ value: number, min: number, max: number, factor?: number }} rv @param {number[]} guesses
 * @returns {[number, number]}
 */
function guessSpan(rv, guesses) {
  const all = [rv.value, rv.value / (rv.factor ?? 1), rv.value * (rv.factor ?? 1), ...guesses].filter((v) => v > 0);
  return [Math.max(rv.min || 1, Math.min(...all) / 10), Math.min(rv.max || 10, Math.max(...all) * 10)];
}

/** A ratio as "1.4" or "12". @param {number} x */
function timesText(x) {
  return new Intl.NumberFormat(lang, { maximumFractionDigits: x < 10 ? 1 : 0 }).format(x);
}

/**
 * Boxes [w, s, e, n] as one (across the date line the short way round).
 * @param {number[][]} boxes @returns {[number, number, number, number]}
 */
function unionBox(boxes) {
  let [w, s, e, n] = /** @type {[number, number, number, number]} */ (boxes[0]);
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
 * What the answer shows beyond one's own: the flags with their names
 * (the right one ticked), the four numbers in order, the odd one among
 * the neighbours, the number on a line with one's guess, all the
 * neighbours. One's pick is outlined in one's colour.
 * @param {any} me
 */
function revealPanel(me) {
  const rv = me.reveal;
  if (!rv) return null;
  const f = numbers(lang);
  const mine = me.mine;
  const color = colorOf(myId());
  const picked = (/** @type {number} */ i) => typeof mine?.choice === "number" && mine.choice === i;
  if (me.kind === "pickflag") {
    return h(
      "section",
      { class: "panel reveal" },
      h("div", { class: `flaggrid small n${(rv.options ?? []).length}` }, ...(rv.options ?? []).map((/** @type {any} */ o, /** @type {number} */ i) => h("div", { class: `opt${i === rv.right ? " right" : ""}${picked(i) ? " mine" : ""}`, style: { "--c": color } }, h("img", { src: flagSrc(o.flag ?? ""), alt: "" }), h("span", { class: "oname" }, o.name ?? ""), i === rv.right ? h("b", { class: "tick" }, "✓") : null))),
    );
  }
  if (me.kind === "bigger") {
    const rows = (rv.options ?? []).map((/** @type {any} */ o, /** @type {number} */ i) => ({ o, i })).sort((/** @type {any} */ a, /** @type {any} */ b) => b.o.value - a.o.value);
    return h(
      "section",
      { class: "panel reveal" },
      h("p", { class: "factname" }, h("span", { class: "ico", html: ICONS[/** @type {Fact} */ (rv.fact)] ?? "" }), LABELS[lang][/** @type {Fact} */ (rv.fact)] ?? ""),
      h("ol", { class: "ranked" }, ...rows.map((/** @type {any} */ r) => h("li", { class: `${r.i === rv.right ? "right" : ""}${picked(r.i) ? " mine" : ""}`, style: { "--c": color } }, h("img", { class: "oflag", src: flagSrc(r.o.flag ?? ""), alt: "" }), h("span", { class: "oname" }, r.o.name ?? ""), h("b", { class: "oval" }, f.fact(rv.fact, r.o.value))))),
    );
  }
  if (me.kind === "odd") {
    return h(
      "section",
      { class: "panel reveal" },
      h("ol", { class: "ranked plain" }, ...(rv.options ?? []).map((/** @type {any} */ o, /** @type {number} */ i) => h("li", { class: `${i === rv.right ? "right" : ""}${picked(i) ? " mine" : ""}`, style: { "--c": color } }, h("img", { class: "oflag", src: flagSrc(o.flag ?? ""), alt: "" }), h("span", { class: "oname" }, o.name ?? "", h("small", {}, `${i === rv.right ? t.notBorders : t.borders} ${rv.of?.name ?? ""}`)), i === rv.right ? h("b", { class: "oval" }, "✓") : null))),
    );
  }
  if (me.kind === "guess") {
    // The line around the answer and one's guess (×10 past both, within the slider's ends): the whole slider would crowd them.
    const [from, to] = guessSpan(rv, typeof mine?.value === "number" ? [mine.value] : []);
    const lo = Math.log(from);
    const hi = Math.log(to);
    const x = (/** @type {number} */ v) => `${(Math.max(0, Math.min(1, (Math.log(v) - lo) / (hi - lo))) * 100).toFixed(1)}%`;
    const band = rv.factor ? h("i", { class: "gband", style: { left: x(rv.value / rv.factor), width: `calc(${x(rv.value * rv.factor)} - ${x(rv.value / rv.factor)})` } }) : null;
    return h(
      "section",
      { class: "panel reveal" },
      h("p", { class: "label" }, t.answerIs),
      h("p", { class: "gvalue" }, f.fact(rv.fact, rv.value)),
      h(
        "div",
        { class: "gline" },
        band,
        h("i", { class: "gmark answer", style: { left: x(rv.value) } }),
        typeof mine?.value === "number" ? h("i", { class: "gmark", style: { left: x(mine.value), "--c": color } }) : null,
      ),
      h("div", { class: "gends" }, h("span", {}, f.fact(rv.fact, from)), h("span", {}, f.fact(rv.fact, to))),
    );
  }
  if (me.kind === "neighbour") {
    return h("section", { class: "panel reveal" }, h("p", { class: "label" }, t.neighbours), h("div", { class: "nlist" }, ...(rv.neighbours ?? []).map((/** @type {any} */ o) => h("span", { class: "nchip" }, h("img", { src: flagSrc(o.flag ?? ""), alt: "" }), o.name ?? ""))));
  }
  return null;
}

watchFit();

// Keep the screen on while playing.
async function wake() {
  try {
    await /** @type {any} */ (navigator).wakeLock?.request("screen");
  } catch {}
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void wake();
});

// ---------------------------------------------------------------------------
// The demo (`?demo=NAME`): fake views, no party.

/** @param {string} type @param {any} data */
function demoAct(type, data) {
  console.log("demo act", type, JSON.stringify(data));
  const v = /** @type {Record<string, any>} */ (demoView);
  if (type === "answer" && data?.lock) {
    v["me"] = { ...v["me"], locked: true };
    render(v);
  }
  if (type === "settings") {
    v["room"] = { ...v["room"], ...data };
    render(v);
  }
  if (type === "next") {
    v["me"] = { ...v["me"], ready: true };
    v["room"] = { ...v["room"], ready: [...(v["room"]?.ready ?? []), "me"] };
    render(v);
  }
  return Promise.resolve(null);
}

/** The real data for the demo's fixtures: the cards by id, the land. @type {{ byId: Map<string, any>, units: Unit[] }} */
let demoData = { byId: new Map(), units: [] };

/** @param {string} name */
function fakeView(name) {
  const fl = (/** @type {string} */ id) => demoData.byId.get(id)?.flag ?? "";
  const nm = (/** @type {string} */ id) => demoData.byId.get(id)?.name?.[pickLang(new URLSearchParams(location.search).get("lang") ?? "en")] ?? id;
  const place = (/** @type {string} */ id) => ({ id, name: nm(id), flag: fl(id), at: demoData.byId.get(id)?.at, box: demoData.byId.get(id)?.box });
  /** Coded rings of a country, as the host sends a shape. @param {string} id */
  const coded = (id) =>
    demoData.units
      .filter((u) => u.id === id)
      .flatMap((u) => u.rings)
      .map((r) => {
        /** @type {number[]} */
        const out = [];
        let px = 0;
        let py = 0;
        for (const [lo, la] of r) {
          const x = Math.round(lo * 100);
          const y = Math.round(la * 100);
          out.push(x - px, y - py);
          px = x;
          py = y;
        }
        return out;
      });
  const qs = new URLSearchParams(location.search);
  const l = pickLang(qs.get("lang") ?? "en");
  const de = l === "de";
  const now = client.now();
  const roster = [
    { id: "me", name: "Phil", vip: true, connected: true },
    { id: "p2", name: "Ada", vip: false, connected: true },
    { id: "p3", name: "Bartholomew", vip: false, connected: true },
    { id: "p4", name: "Cy", vip: false, connected: false },
  ];
  const colors = { me: "#3b82f6", p2: "#ef4444", p3: "#22c55e", p4: "#ff6b00" };
  const room = { lang: l, phase: "round", round: 3, rounds: 16, minPlayers: 2, colors, steps: { me: 2, p2: 1, p3: 3, p4: 0 }, difficulty: "normal", disputed: false, map: qs.get("map") === "globe" ? "globe" : "flat", captain: "p2", left: 151, deckSize: 194 };
  const ranks = { population: 19, area: 63, neighbours: 1, highest: 76, gdp: 17 };
  const germany = {
    id: "DE",
    name: de ? "Deutschland" : "Germany",
    capitals: ["Berlin"],
    flag: fl("DE"),
    at: [10.4, 51.1],
    box: [5.9, 47.3, 15.0, 55.1],
    facts: { population: 83_280_000, area: 357_588, neighbours: 9, highest: 2962, gdp: 52_746 },
    highest: "Zugspitze",
    gdpYear: 2023,
    populationYear: 2023,
    neighbours: [],
  };
  const ranked = { ...germany, ranks, strong: ["neighbours"] };
  const nigeria = { id: "NG", name: "Nigeria", capitals: ["Abuja"], flag: fl("NG"), at: [8.0, 9.6], box: [2.7, 4.3, 14.7, 13.9], facts: { population: 223_800_000, area: 923_768, neighbours: 4, highest: 2419, gdp: 1597 }, ranks: { population: 6, area: 31, neighbours: 60, highest: 90, gdp: 140 }, strong: ["population"], highest: "Chappal Waddi", gdpYear: 2023, populationYear: 2023, neighbours: [] };
  const gone = {
    population: [
      { id: "CN", name: "China", flag: fl("CN"), rank: 2 },
      { id: "NG", name: "Nigeria", flag: fl("NG"), rank: 6 },
    ],
    area: [{ id: "CN", name: "China", flag: fl("CN"), rank: 4 }],
    neighbours: [{ id: "CN", name: "China", flag: fl("CN"), rank: 1 }],
  };
  /** @type {Record<string, () => { room?: any, me: any }>} */
  const views = {
    lobby: () => ({ room: { ...room, phase: "lobby", round: 0, rounds: 15 }, me: { task: "lobby", steps: 0 } }),
    wait: () => ({ me: { task: "wait" } }),
    card: () => ({ room: { ...room, stage: "draw", gone }, me: { task: "card", steps: 2, card: germany, captain: false, key: "1:3" } }),
    captain: () => ({ room: { ...room, captain: "me", stage: "draw", gone }, me: { task: "card", steps: 2, card: germany, captain: true, key: "1:3" } }),
    gone: () => {
      tab = { key: "1:3", gone: true };
      return { room: { ...room, stage: "draw", gone }, me: { task: "card", steps: 2, card: germany, captain: false, key: "1:3" } };
    },
    compete: () => ({ room: { ...room, next: "k", nextFor: ["me", "p2", "p3"], ready: ["p2"], stage: "compete", fact: "neighbours" }, me: { task: "compete", steps: 3, card: ranked, fact: "neighbours", place: 1, of: 4, won: true, winners: ["Phil"], next: "k" } }),
    discard: () => ({ room: { ...room, next: "k", nextFor: ["me", "p2", "p3"], ready: ["p2"], stage: "discard" }, me: { task: "watch", what: "discard", steps: 2, card: ranked, next: "k" } }),
    announce: () => ({ room: { ...room, stage: "announce", kind: "capital", try: 2 }, me: { task: "watch", what: "announce", kind: "capital", steps: 2 } }),
    tiebreak: () => ({ room: { ...room, stage: "challenge", kind: "where", tiebreak: true }, me: { task: "watch", what: "tiebreak", steps: 2 } }),
    capital: () => ({ room: { ...room, stage: "challenge", kind: "capital", deadline: now + 15000 }, me: { task: "answer", key: "c1", kind: "capital", question: { name: "Nigeria", flag: fl("NG"), at: nigeria.at, box: nigeria.box, id: "NG" }, deadline: now + 15000, borders: true, locked: false, steps: 2 } }),
    flag: () => ({ room: { ...room, stage: "challenge", kind: "flag", deadline: now + 15000 }, me: { task: "answer", key: "c2", kind: "flag", question: { flag: fl("NG") }, deadline: now + 15000, borders: true, locked: false, steps: 2 } }),
    where: () => ({ room: { ...room, stage: "challenge", kind: "where", deadline: now + 15000 }, me: { task: "answer", key: "c3", kind: "where", question: { name: de ? "Bosnien und Herzegowina" : "Bosnia and Herzegovina" }, deadline: now + 15000, borders: true, locked: false, steps: 2 } }),
    locked: () => {
      drafts.set("c4", { lon: 17.5, lat: 44.2 });
      return { room: { ...room, stage: "challenge", kind: "where", deadline: now + 9000 }, me: { task: "answer", key: "c4", kind: "where", question: { name: "Nigeria" }, deadline: now + 9000, borders: true, locked: true, steps: 2 } };
    },
    right: () => ({ room: { ...room, next: "k", nextFor: ["me", "p2", "p3"], ready: ["p2"], nextBy: now + 12000, stage: "answer", kind: "capital" }, me: { task: "result", kind: "capital", right: true, solution: nigeria, mine: { pid: "me", text: "abuya", as: "Abuja", right: true }, winners: ["Phil", "Ada"], steps: 3, again: false, next: "k" } }),
    wrong: () => ({ room: { ...room, next: "k", nextFor: ["me", "p2", "p3"], ready: ["p2"], stage: "answer", kind: "flag" }, me: { task: "result", kind: "flag", right: false, solution: nigeria, mine: { pid: "me", text: "Niger", as: "Niger", right: false }, winners: [], steps: 2, again: true, next: "k" } }),
    "result-where": () => ({ room: { ...room, next: "k", nextFor: ["me", "p2", "p3"], ready: ["p2"], stage: "answer", kind: "where" }, me: { task: "result", kind: "where", right: false, solution: nigeria, mine: { pid: "me", lon: 1.5, lat: 12.4, km: 310, to: [3.6, 11.7], right: false }, winners: ["Bartholomew"], steps: 2, again: false, next: "k" } }),
    again: () => ({ room: { ...room, next: "k", nextFor: ["me", "p2", "p3"], ready: ["p2"], stage: "answer", kind: "where" }, me: { task: "result", kind: "where", right: false, solution: nigeria, mine: null, winners: [], steps: 2, again: true, next: "k" } }),
    final: () => ({ room: { ...room, phase: "final", rounds: 15 }, me: { task: "final", steps: 9, place: 1, of: 4, won: true } }),
    pickflag: () => {
      const ids = ["BA", "HR", "RS", "SI", "ME", "MK"];
      drafts.set("c5", { choice: 2 });
      return { room: { ...room, stage: "challenge", kind: "pickflag", deadline: now + 40000 }, me: { task: "answer", key: "c5", kind: "pickflag", question: { name: nm("RS"), flags: ids.map(fl) }, deadline: now + 40000, borders: true, locked: false, steps: 2 } };
    },
    pickflag9: () => {
      const ids = ["TD", "RO", "AD", "MD", "BE", "CO", "VE", "EC", "DE"];
      return { room: { ...room, stage: "challenge", kind: "pickflag", deadline: now + 20000 }, me: { task: "answer", key: "c6", kind: "pickflag", question: { name: nm("TD"), flags: ids.map(fl) }, deadline: now + 20000, borders: true, locked: false, steps: 2 } };
    },
    shape: () => {
      const it = demoData.byId.get("IT");
      return { room: { ...room, stage: "challenge", kind: "shape", deadline: now + 40000 }, me: { task: "answer", key: "c7", kind: "shape", question: { shape: coded("IT"), box: it?.box, at: it?.at }, deadline: now + 40000, borders: true, locked: false, steps: 2 } };
    },
    bigger: () => ({ room: { ...room, stage: "challenge", kind: "bigger", deadline: now + 40000 }, me: { task: "answer", key: "c8", kind: "bigger", question: { fact: "population", options: ["NG", "BR", "JP", "MX"].map((id) => ({ name: nm(id), flag: fl(id) })) }, deadline: now + 40000, borders: true, locked: false, steps: 2 } }),
    guess: () => {
      drafts.set("c9", { value: 25_000_000 });
      return { room: { ...room, stage: "challenge", kind: "guess", deadline: now + 40000 }, me: { task: "answer", key: "c9", kind: "guess", question: { fact: "population", name: nm("PE"), flag: fl("PE"), min: 1000, max: 2e9 }, deadline: now + 40000, borders: true, locked: false, steps: 2 } };
    },
    neighbour: () => {
      const hu = demoData.byId.get("HU");
      return { room: { ...room, stage: "challenge", kind: "neighbour", deadline: now + 40000 }, me: { task: "answer", key: "c10", kind: "neighbour", question: { name: nm("HU"), flag: fl("HU"), id: "HU", at: hu?.at, box: hu?.box }, deadline: now + 40000, borders: true, locked: false, steps: 2 } };
    },
    odd: () => ({ room: { ...room, stage: "challenge", kind: "odd", deadline: now + 40000 }, me: { task: "answer", key: "c11", kind: "odd", question: { name: nm("HU"), flag: fl("HU"), options: ["AT", "CZ", "RO", "SK"].map((id) => ({ name: nm(id), flag: fl(id) })) }, deadline: now + 40000, borders: true, locked: false, steps: 2 } }),
    "result-pickflag": () => {
      const ids = ["BA", "HR", "RS", "SI", "ME", "MK"];
      return { room: { ...room, next: "k", nextFor: ["me", "p2"], ready: [], stage: "answer", kind: "pickflag" }, me: { task: "result", kind: "pickflag", right: false, solution: { ...nigeria, ...place("RS"), name: nm("RS") }, reveal: { options: ids.map(place), right: 2 }, mine: { pid: "me", choice: 4, right: false }, winners: ["Ada"], steps: 2, next: "k" } };
    },
    "result-bigger": () => ({
      room: { ...room, next: "k", nextFor: ["me", "p2"], ready: [], stage: "answer", kind: "bigger" },
      me: { task: "result", kind: "bigger", right: true, solution: nigeria, reveal: { fact: "population", options: [{ ...place("NG"), value: 223_800_000 }, { ...place("BR"), value: 216_400_000 }, { ...place("JP"), value: 124_500_000 }, { ...place("MX"), value: 128_500_000 }], right: 0 }, mine: { pid: "me", choice: 0, right: true }, winners: ["Phil"], steps: 3, next: "k" },
    }),
    "result-guess": () => ({
      room: { ...room, next: "k", nextFor: ["me", "p2"], ready: [], stage: "answer", kind: "guess" },
      me: { task: "result", kind: "guess", right: true, solution: { ...nigeria, ...place("PE"), facts: { ...nigeria.facts, population: 34_350_000 } }, reveal: { fact: "population", value: 34_350_000, min: 1000, max: 2e9, factor: 2 }, mine: { pid: "me", value: 25_000_000, off: 1.374, right: true }, winners: ["Phil"], steps: 3, next: "k" },
    }),
    "result-neighbour": () => ({
      room: { ...room, next: "k", nextFor: ["me", "p2"], ready: [], stage: "answer", kind: "neighbour" },
      me: { task: "result", kind: "neighbour", right: true, solution: { ...nigeria, ...place("HU") }, reveal: { neighbours: ["AT", "SK", "UA", "RO", "RS", "HR", "SI"].map(place) }, mine: { pid: "me", text: "Österreich", as: nm("AT"), right: true }, winners: ["Phil", "Ada"], steps: 3, next: "k" },
    }),
    "result-odd": () => ({
      room: { ...room, next: "k", nextFor: ["me", "p2"], ready: [], stage: "answer", kind: "odd" },
      me: { task: "result", kind: "odd", right: false, solution: { ...nigeria, ...place("HU") }, reveal: { of: place("HU"), options: ["AT", "CZ", "RO", "SK"].map(place), right: 1 }, mine: { pid: "me", choice: 3, right: false }, winners: [], steps: 2, next: "k" },
    }),
  };
  const v = (views[name] ?? views["card"] ?? (() => ({ me: {} })))();
  return { roster, room: { ...room, ...v.room }, me: v.me };
}

// ---------------------------------------------------------------------------

if (DEMO) {
  // The fixtures take flags and shapes from the real data.
  const demo = DEMO;
  Promise.all([fetch(new URL("../data/countries.json", import.meta.url)).then((r) => r.json()), shapes().catch(() => /** @type {Unit[]} */ ([]))]).then(
    ([c, units]) => {
      demoData = { byId: new Map((c.countries ?? []).map((/** @type {any} */ x) => [x.id, x])), units };
      demoView = fakeView(demo);
      render(demoView);
    },
    () => {
      demoView = fakeView(demo);
      render(demoView);
    },
  );
} else {
  const first = /** @type {HTMLElement | null} */ (app.querySelector(".big"));
  if (first) first.textContent = t.connecting;
  if (!client.room || !client.key) {
    show(h("div", { class: "hero" }, bigLogo()), h("section", { class: "panel" }, h("p", { class: "big" }, t.scanToJoin)));
  } else if (client.canResume) {
    client.connect().then(wake, (e) => joinForm(e?.code === "no-player" ? "" : message(e)));
  } else {
    joinForm();
  }
}
