// @ts-check
/**
 * Pinch's phone page (docs/pinch-design.md §2, §10): joining, the lobby
 * (the VIP's settings, how to play), the role card at the briefing, the
 * heist (heist.js), the outcome, the tape, the scores and the end.
 * Everything comes from the party's view (`{ roster, room, me }`: views.ts
 * RoomView and PlayerView) and the heist's frames (`f` messages,
 * protocol.ts); everything it does is an action.
 *
 * `?demo=thief|guard` (with `&phase=lobby|briefing|heist|outcome|tape|scores|final|join`,
 * `&scene=walk|hold|held|busy`, `&seed=N`, `&lang=de`) runs the page on
 * canned data from a generated estate instead of a party (demo.js).
 */

import { PartyClient, blockEmoji } from "/_tvpipe/lib/client.js";
import { drawBlueprint, fitCanvas, fitView, PALETTE, useTiles } from "./draw.js";
import { watchFit } from "./fit.js";
import { artFor, clock, heistScreen } from "./heist.js";
import { browserLang, pickLang, strings } from "./strings.js";
import { decodeBlueprint } from "../game/map.js";
import { TIMES, wordsArea } from "../game/protocol.js";
import { itemById } from "../game/items.js";
import { award, estate, money, outcome, roleCard, tip, words } from "../game/words.js";

/** @typedef {import("../game/views.ts").RoomView} RoomView */
/** @typedef {import("../game/views.ts").PlayerView} PlayerView */
/** @typedef {import("../game/map.ts").Blueprint} Blueprint */

// A controller, not a document: no pinch or double-tap zoom, no selection, no scrolling the map.
for (const type of ["gesturestart", "gesturechange", "gestureend"]) document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
document.addEventListener("touchmove", (e) => {
  if (e.touches.length > 1 || document.body.classList.contains("playing")) e.preventDefault();
}, { passive: false });
document.addEventListener("dblclick", (e) => e.preventDefault(), { passive: false });
document.addEventListener("selectstart", (e) => {
  const tg = e.target instanceof Element ? e.target : /** @type {Node} */ (e.target).parentElement;
  if (!tg?.closest("input")) e.preventDefault();
});

const params = new URLSearchParams(location.search);
const demo = params.get("demo");
/** @type {any} */
const client = demo ? (await import("./demo.js")).demoClient(params) : PartyClient.fromLocation();
if (demo) /** @type {any} */ (globalThis).pinchDemo = client;
if (!demo) blockEmoji();

const app = /** @type {HTMLElement} */ (document.getElementById("app"));
const banner = /** @type {HTMLElement} */ (document.getElementById("banner"));
const who = /** @type {HTMLElement} */ (document.getElementById("who"));
const langButton = /** @type {HTMLButtonElement} */ (document.getElementById("lang"));
const toastEl = /** @type {HTMLElement} */ (document.getElementById("toast"));

// ---------------------------------------------------------------------------
// The language: the phone's own choice, else the room's, else the browser's.

const LANG_KEY = "pinch:lang";
function ownLang() {
  try {
    const v = localStorage.getItem(LANG_KEY);
    return v ? pickLang(v) : null;
  } catch {
    return null;
  }
}
function roomLang() {
  const l = client.view?.room?.lang;
  return typeof l === "string" ? pickLang(l) : browserLang();
}
let lang = ownLang() ?? roomLang();
let t = strings(lang);
document.documentElement.lang = lang;
function useLang() {
  const l = ownLang() ?? roomLang();
  if (l === lang) return false;
  lang = l;
  t = strings(l);
  document.documentElement.lang = l;
  return true;
}
langButton.addEventListener("click", () => {
  const next = lang === "de" ? "en" : "de";
  try {
    if (next === roomLang()) localStorage.removeItem(LANG_KEY);
    else localStorage.setItem(LANG_KEY, next);
  } catch {}
  if (!useLang()) return;
  if (shown === "join") joinForm("", /** @type {HTMLInputElement | null} */ (document.getElementById("name"))?.value);
  else if (client.view?.me) {
    shown = "";
    render(client.view);
  }
});

// ---------------------------------------------------------------------------
// Helpers: text always as text.

/**
 * @param {string} tag
 * @param {Record<string, any>} [attrs]
 * @param {...(Node | string | null | undefined | false)} kids
 * @returns {HTMLElement}
 */
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "style" && typeof v === "object") for (const [p, x] of Object.entries(v)) el.style.setProperty(p, String(x));
    else if (v === true) el.setAttribute(k, "");
    else if (v !== false && v != null) el.setAttribute(k, String(v));
  }
  for (const kid of kids) if (kid) el.append(kid);
  return el;
}
/** @param {...(Node | null)} nodes */
function show(...nodes) {
  app.replaceChildren(...nodes.filter((n) => n !== null));
}
/** @param {string | null} text */
function setBanner(text) {
  banner.hidden = !text;
  banner.textContent = text ?? "";
}
/** @type {ReturnType<typeof setTimeout> | undefined} */
let toastTimer;
/** @param {string} text */
function toast(text) {
  toastEl.textContent = text;
  toastEl.hidden = false;
  toastEl.classList.remove("show");
  void toastEl.offsetWidth;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2600);
}
const isColor = (/** @type {unknown} */ c) => typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c);
/** @param {string | undefined | null} id */
function colorOf(id) {
  const c = id ? client.view?.room?.colors?.[id] : undefined;
  return isColor(c) ? c : "#d6a842";
}
/** @param {string | undefined | null} id */
function nameOf(id) {
  return (client.view?.roster ?? []).find((/** @type {any} */ r) => r.id === id)?.name ?? "?";
}
/** @param {number | number[]} ms */
function buzz(ms) {
  try {
    navigator.vibrate?.(ms);
  } catch {}
}
const isVip = () => !!(client.view?.roster ?? []).find((/** @type {any} */ r) => r.id === client.you?.id)?.vip;
/** @returns {RoomView} */
const room = () => client.view?.room ?? {};
/** @returns {PlayerView} */
const me = () => client.view?.me ?? {};

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
      return t.closed;
    case "bad-key":
      return t.badKey;
    case "no-room":
      return t.noRoom;
    default:
      return (typeof e?.code === "string" ? t.errors[e.code] : undefined) ?? e?.message ?? String(e);
  }
}

/** @param {string} type @param {any} [data] @param {HTMLElement} [err] */
async function act(type, data, err) {
  if (err) err.textContent = "";
  try {
    return await client.act(type, data);
  } catch (e) {
    if (err) err.textContent = message(e);
    else toast(message(e));
    return undefined;
  }
}

/** The logo: the name in Limelight, a sunburst behind. */
function logo() {
  return h("div", { class: "logo" }, h("span", { class: "deco-title" }, "Pinch"), h("small", {}, words(lang).tagline));
}

/** A live countdown to a host-time deadline. */
function countdown() {
  const el = h("b", { class: "countdown" });
  const tick = () => {
    const d = room().deadline;
    el.textContent = typeof d === "number" ? clock((d - client.now()) / 1000) : "";
  };
  tick();
  const id = setInterval(tick, 250);
  cleanups.push(() => clearInterval(id));
  return el;
}

// ---------------------------------------------------------------------------
// Joining

let shown = "";
/** @type {((view: any) => void) | null} */
let refresh = null;
/** @type {(() => void)[]} */
let cleanups = [];
/** The last few frames: the heist screen may come after its first frame. @type {unknown[]} */
let frames = [];
client.on("msg", (/** @type {string} */ type, /** @type {unknown} */ data) => {
  if (type !== "f") return;
  frames.push(data);
  if (frames.length > 3) frames.shift();
});

/** @param {string} [error] @param {string} [typed] */
function joinForm(error = "", typed) {
  shown = "join";
  refresh = null;
  langButton.hidden = false;
  langButton.textContent = t.otherLang;
  const input = /** @type {HTMLInputElement} */ (h("input", { id: "name", maxlength: 16, autocapitalize: "words", enterkeyhint: "go", autocomplete: "off", required: true }));
  const err = h("p", { class: "error" }, error);
  let saved = "";
  try {
    saved = localStorage.getItem("pinch:name") ?? "";
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
          localStorage.setItem("pinch:name", name);
        } catch {}
        err.textContent = "";
        try {
          await client.join(name);
          void wake();
        } catch (x) {
          joinForm(message(x), name);
        }
      },
    },
    h("label", { for: "name" }, t.yourName),
    input,
    h("button", { class: "deco-btn wide", type: "submit" }, t.join),
    err,
  );
  show(logo(), h("section", { class: "card pop" }, h("h1", {}, t.joinTitle), form));
  if (!input.value) input.focus();
}

client.on("status", (/** @type {string} */ st) => {
  if (st === "reconnecting") setBanner(t.reconnecting);
  else if (st === "open") setBanner(null);
});
client.on("bye", (/** @type {string} */ reason) => {
  const text = reason === "kicked" ? t.kicked : reason === "replaced" ? t.replaced : reason === "room-closed" ? t.roomClosed : null;
  if (!text) return;
  leave();
  shown = "bye";
  setBanner(null);
  show(logo(), h("section", { class: "card" }, h("p", { class: "big" }, text)));
});
client.on("view", (/** @type {any} */ view) => render(view));

function leave() {
  refresh = null;
  for (const c of cleanups) c();
  cleanups = [];
}

// ---------------------------------------------------------------------------
// Views

/** @param {any} view */
function keyOf(view) {
  const r = view.room ?? {};
  const m = view.me ?? {};
  if (m.role === "wait" && r.phase !== "lobby" && r.phase !== "final") return `wait:${r.round}`;
  switch (r.phase) {
    case "lobby":
    case "final":
      return String(r.phase);
    default:
      return `${r.phase}:${r.round}:${m.role ?? ""}`;
  }
}

/** @param {any} view */
function render(view) {
  if (!view?.room || !view.me) return;
  const mine = (view.roster ?? []).find((/** @type {any} */ r) => r.id === client.you?.id);
  if (useLang()) shown = "";
  who.replaceChildren(...(mine ? [h("span", { class: "dot", style: { "--c": colorOf(mine.id) } }), h("b", {}, `${mine.vip ? "★ " : ""}${mine.name}`)] : []));
  // The buffer holds the coming heist's first frames only: a past heist's would hide the next one's (world.js drops older frames).
  if (view.room.phase !== "heist") frames = [];
  const k = keyOf(view);
  if (k !== shown) {
    shown = k;
    leave();
    const phase = view.room.phase;
    langButton.hidden = !(phase === "lobby" || phase === "final");
    langButton.textContent = t.otherLang;
    document.body.classList.toggle("playing", phase === "heist" && view.me.role !== "wait");
    document.body.dataset["phase"] = String(phase);
    build(view);
    void wake();
  }
  refresh?.(view);
}

/** @param {any} view */
function build(view) {
  const r = view.room;
  const m = view.me;
  if (m.role === "wait" && r.phase !== "lobby" && r.phase !== "final") return waiting();
  switch (r.phase) {
    case "lobby":
      return lobby();
    case "briefing":
      return briefing();
    case "heist":
      return heist();
    case "outcome":
      return outcomeCard();
    case "tape":
      return tape();
    case "scores":
      return scores();
    case "final":
      return final();
    default:
      return show(h("section", { class: "card" }, h("p", { class: "big" }, t.lookTv)));
  }
}

function waiting() {
  show(logo(), h("section", { class: "card pop center" }, h("p", { class: "big" }, t.waitNext)));
}

// ---------------------------------------------------------------------------
// Lobby and final: players, the VIP's settings, start.

/**
 * The VIP's settings: all of them in the lobby and at the end; `live`
 * (between rounds, at the tape and the scores) only late joining, which
 * the host page also changes during a game.
 * @param {HTMLElement} err @param {{ live?: boolean }} [o]
 */
function settings(err, o = {}) {
  /** @type {{ buttons: HTMLButtonElement[], on: (r: RoomView, i: number) => boolean }[]} */
  const items = [];
  const box = h("div", { class: "settings" }, o.live ? null : h("h2", {}, t.settings));
  /** @param {string} title @param {{ label: string, data: object }[]} choices @param {(r: RoomView, i: number) => boolean} on */
  const add = (title, choices, on) => {
    const buttons = choices.map((c) => /** @type {HTMLButtonElement} */ (h("button", { type: "button", onclick: () => act("settings", c.data, err) }, c.label)));
    box.append(h("div", { class: "setting" }, h("label", {}, title), h("div", { class: "seg" }, ...buttons)));
    items.push({ buttons, on });
  };
  const lengths = TIMES.lengths;
  if (!o.live) add(t.length, lengths.map((l) => ({ label: clock(l), data: { length: l } })), (r, i) => r.settings?.length === lengths[i]);
  if (!o.live) add(t.rounds, [{ label: t.roundsOnce, data: { rounds: 1 } }, { label: t.roundsTwice, data: { rounds: 2 } }], (r, i) => r.settings?.rounds === i + 1);
  add(t.late, [{ label: t.lateWait, data: { late: "wait" } }, { label: t.lateClosed, data: { late: "closed" } }], (r, i) => r.settings?.late === (i ? "closed" : "wait"));
  if (!o.live) add(t.language, [{ label: "English", data: { lang: "en" } }, { label: "Deutsch", data: { lang: "de" } }], (r, i) => r.lang === (i ? "de" : "en"));
  const update = () => {
    const r = room();
    box.hidden = !isVip();
    for (const it of items) it.buttons.forEach((b, i) => b.classList.toggle("on", it.on(r, i)));
  };
  return { box, update };
}

/** The roster as chips in the players' colours. */
function chips() {
  const list = h("div", { class: "chips" });
  const update = () => {
    const roster = client.view?.roster ?? [];
    list.replaceChildren(
      ...roster.map((/** @type {any} */ r) =>
        h("span", { class: `chip${r.connected ? "" : " away"}` }, h("span", { class: "dot", style: { "--c": colorOf(r.id) } }), r.name, r.vip ? h("small", {}, t.vip) : null),
      ),
    );
  };
  return { list, update };
}

function howTo() {
  const w = words(lang);
  return h(
    "section",
    { class: "card plain" },
    h("h2", {}, t.howTitle),
    h("ol", { class: "how" }, ...w.howTo.map((x) => h("li", {}, x))),
    h("ul", { class: "how controls" }, ...t.controls.map((x) => h("li", {}, x))),
  );
}

function lobby() {
  const err = h("p", { class: "error" });
  const hint = h("p", { class: "muted small" });
  const start = /** @type {HTMLButtonElement} */ (h("button", { class: "deco-btn deco-btn-big wide", id: "start", onclick: () => act("start", null, err) }, t.start));
  const set = settings(err);
  const list = chips();
  show(logo(), h("section", { class: "card pop lobby" }, h("h1", {}, t.youreIn), h("h2", {}, t.players), list.list, start, err, hint, set.box), howTo());
  refresh = () => {
    const v = client.view;
    const roster = v.roster ?? [];
    const vip = isVip();
    const min = v.room?.minPlayers ?? 3;
    const ready = roster.filter((/** @type {any} */ r) => r.connected).length;
    list.update();
    start.hidden = !vip;
    start.disabled = ready < min;
    hint.textContent = vip ? (ready < min ? t.vipWait(min - ready) : t.vipReady) : t.waitVip;
    set.update();
  };
}

function final() {
  const w = words(lang);
  const err = h("p", { class: "error" });
  const again = /** @type {HTMLButtonElement} */ (h("button", { class: "deco-btn deco-btn-big wide", onclick: () => act("start", null, err) }, t.playAgain));
  const set = settings(err);
  const podium = h("ol", { class: "podium" });
  const awards = h("ul", { class: "awards" });
  const wait = h("p", { class: "muted small center" }, t.waitHost);
  show(h("section", { class: "card pop center final" }, h("h1", { class: "deco-title" }, t.theEnd), h("h2", {}, w.ui.podium), podium, awards, again, err, wait, set.box));
  refresh = () => {
    const r = room();
    const scores = r.scores ?? {};
    const ids = Object.keys(scores).sort((a, b) => (scores[b] ?? 0) - (scores[a] ?? 0) || nameOf(a).localeCompare(nameOf(b)));
    podium.replaceChildren(
      ...ids.map((id, k) =>
        h("li", { class: `place p${k + 1}${id === client.you?.id ? " me" : ""}` }, h("span", { class: "rank" }, String(k + 1)), h("span", { class: "dot", style: { "--c": colorOf(id) } }), h("b", { "data-fit": "1" }, nameOf(id)), h("span", { class: "money" }, money(lang, scores[id] ?? 0))),
      ),
    );
    awards.replaceChildren(
      ...(Array.isArray(r.awards) ? r.awards : []).flatMap((a, k) => {
        try {
          const p = /** @type {any} */ ({ ...a.params, name: nameOf(a.player) });
          const x = award(lang, a.id, p, () => (k * 0.37) % 1);
          return [h("li", {}, h("b", { class: "deco-title" }, x.name), h("span", {}, x.citation))];
        } catch {
          return [];
        }
      }),
    );
    again.hidden = !isVip();
    wait.hidden = isVip();
    set.update();
  };
}

// ---------------------------------------------------------------------------
// The briefing: the role card with the blueprint.

/** @type {{ key: unknown, map: Blueprint | null }} */
let mapCache = { key: null, map: null };
/**
 * The round's blueprint, decoded once. Keyed by the round and its
 * contents (as the TV does), not by the object: the client merges a new
 * round's blueprint into the old object, which keeps its identity.
 */
function blueprint() {
  const bp = /** @type {any} */ (room().blueprint);
  if (!bp) return null;
  const cells = String(bp.cells ?? "");
  const key = `${room().round}:${bp.w}x${bp.h}:${cells.length}:${cells.slice(0, 120)}:${cells.slice(-120)}`;
  if (mapCache.key !== key) mapCache = { key, map: decodeBlueprint(bp) };
  return mapCache.map;
}
const artKey = () => `${room().round}|${room().estate}|${mapCache.key}`;

function briefing() {
  const m = me();
  const map = blueprint();
  const role = m.role === "thief" ? "thief" : "guard";
  const w = words(lang);
  /** @type {{ name: string, title: string, lines: string[] }} */
  let card = { name: w.roles[role].name, title: w.roles[role].title, lines: [] };
  let tipLine = "";
  try {
    if (map && role === "thief" && m.briefing) {
      const spot = map.spots[m.briefing.car];
      const where = spot ? wordsArea(map, { area: spot.area }) : null;
      if (where) card = roleCard(lang, "thief", { spot: `P${(spot?.id ?? 0) + 1}`, where });
      const item = itemById(m.briefing.tip?.item ?? "");
      if (item) tipLine = tip(lang, { item, wing: m.briefing.tip.wing, ...(m.briefing.tip.building === undefined ? {} : { building: m.briefing.tip.building }) }, () => 0.3);
    } else if (map) {
      const where = wordsArea(map, { room: map.security });
      if (where) card = roleCard(lang, "guard", { where });
    }
  } catch {}
  const est = typeof room().estate === "number" ? estate(lang, /** @type {number} */ (room().estate)).name : "";
  const cv = /** @type {HTMLCanvasElement} */ (h("canvas", {}));
  const legend = h("p", { class: "legend" }, h("i", { class: role, style: { "--me": colorOf(client.you?.id) } }), role === "thief" ? t.carHere : t.yourStart);
  show(
    h(
      "section",
      { class: `card pop role ${role}` },
      h("p", { class: "estate", "data-fit": "1" }, est),
      h("h1", { class: "deco-title", "data-fit": "2" }, card.title),
      h("div", { class: "bp" }, cv),
      legend,
      ...card.lines.map((l) => h("p", { class: "line" }, l)),
      tipLine ? h("p", { class: "tip" }, h("b", {}, w.ui.tip), " ", tipLine) : null,
      h("p", { class: "starts" }, t.startsIn, " ", countdown()),
    ),
  );
  if (!map) return;
  /** @type {HTMLElement} */ (cv.parentElement).style.aspectRatio = `${map.w} / ${map.h}`;
  const art = artFor(map, lang, artKey());
  const dpr = Math.min(2, devicePixelRatio || 1);
  let raf = 0;
  const draw = (/** @type {number} */ now) => {
    raf = requestAnimationFrame(draw);
    const box = /** @type {HTMLElement} */ (cv.parentElement);
    const bw = box.clientWidth;
    const bh = box.clientHeight;
    if (!bw || !bh || !art) return;
    const c = fitCanvas(cv, bw, bh, dpr);
    const v = fitView(map, bw, bh, dpr, { pad: 4 });
    drawBlueprint(c, art, v, { budget: 999 });
    useTiles(c, v);
    const pulse = 0.5 + 0.5 * Math.sin(now / 260);
    const px = 1 / v.scale;
    if (role === "thief" && m.briefing) {
      const s = map.spots[m.briefing.car];
      if (s) {
        const r = s.rect;
        c.fillStyle = `rgba(243,210,122,${0.35 + 0.35 * pulse})`;
        c.fillRect(r.x, r.y, r.w, r.h);
        c.strokeStyle = PALETTE.goldLight;
        c.lineWidth = 3 * px;
        c.strokeRect(r.x - 0.5, r.y - 0.5, r.w + 1, r.h + 1);
        c.beginPath();
        c.arc(r.x + r.w / 2, r.y + r.h / 2, Math.max(r.w, r.h) / 2 + 1.5 + pulse * 2.5, 0, Math.PI * 2);
        c.lineWidth = 2 * px;
        c.stroke();
      }
    } else if (m.start && Number.isFinite(m.start.x)) {
      const x = m.start.x + 0.5;
      const y = m.start.y + 0.5;
      c.fillStyle = colorOf(client.you?.id);
      c.strokeStyle = PALETTE.ink;
      c.lineWidth = 2 * px;
      c.beginPath();
      c.arc(x, y, 0.9, 0, Math.PI * 2);
      c.fill();
      c.stroke();
      c.strokeStyle = colorOf(client.you?.id);
      c.beginPath();
      c.arc(x, y, 1.6 + pulse * 2.5, 0, Math.PI * 2);
      c.stroke();
    }
  };
  raf = requestAnimationFrame(draw);
  cleanups.push(() => cancelAnimationFrame(raf));
}

// ---------------------------------------------------------------------------
// The heist

function heist() {
  const map = blueprint();
  const m = me();
  if (!map || (m.role !== "thief" && m.role !== "guard")) {
    show(h("section", { class: "card center" }, h("p", { class: "big" }, t.heistOn), h("p", { class: "muted" }, t.lookTv)));
    return;
  }
  const screen = heistScreen(
    {
      client, myId: client.you?.id ?? "", role: m.role, map, lang, strings: t,
      catalogue: () => room().catalogue ?? [], colorOf, nameOf, buzz, frames: [...frames],
      colors: () => room().colors ?? {},
      names: () => Object.fromEntries((client.view?.roster ?? []).map((/** @type {any} */ r) => [r.id, r.name])),
    },
    artKey(),
  );
  show(screen.el);
  /** @type {any} */ (globalThis).pinchHeist = screen.model;
  cleanups.push(() => screen.destroy());
}

// ---------------------------------------------------------------------------
// After the heist

function outcomeCard() {
  const r = room();
  const o = r.outcome;
  const kind = o?.kind ?? "pinched";
  let card = { title: "", sub: "" };
  try {
    card = outcome(lang, kind, { thief: nameOf(r.thief), guard: nameOf(o?.by) }, () => ((r.round ?? 0) * 0.37) % 1);
  } catch {}
  const mine = r.thief === client.you?.id;
  const good = kind === "gotAway" ? mine : !mine;
  buzz(kind === "gotAway" ? [80, 60, 80, 60, 320] : [400]);
  show(
    h(
      "div",
      { class: `intertitle outcome ${kind}${good ? " good" : ""}` },
      h(
        "div",
        { class: "intertitle-card" },
        h(
          "div",
          { class: "intertitle-text" },
          h("span", { class: "otitle", "data-fit": "1" }, card.title),
          h("span", { class: "intertitle-rule" }),
          card.sub,
          kind === "gotAway" && typeof o?.haul === "number" ? h("small", {}, money(lang, o.haul)) : null,
        ),
      ),
    ),
  );
}

function tape() {
  const w = words(lang);
  const skip = /** @type {HTMLButtonElement} */ (h("button", { class: "deco-btn wide", onclick: () => act("skip") }, w.buttons.skip));
  const err = h("p", { class: "error" });
  const set = settings(err, { live: true });
  show(h("section", { class: "card pop center tape" }, h("p", { class: "vhs" }, `${w.ui.play} ▶`), h("h1", { class: "deco-title" }, w.ui.tape), h("p", { class: "big" }, t.tapeOn), skip, err, set.box));
  refresh = () => {
    skip.hidden = !isVip();
    set.update();
  };
}

function scores() {
  const w = words(lang);
  const r = room();
  const last = Array.isArray(r.history) ? r.history.at(-1) : undefined;
  const cat = r.catalogue ?? [];
  const items = (last?.items ?? []).map((id) => {
    const it = itemById(id);
    return h("li", {}, it ? it.name[lang] : id, h("span", { class: "money" }, money(lang, it?.value ?? cat.find((c) => c.id === id)?.value ?? 0)));
  });
  const rewards = Object.entries(last?.rewards ?? {}).map(([id, v]) => h("li", {}, h("span", { class: "dot", style: { "--c": colorOf(id) } }), nameOf(id), h("span", { class: "money" }, money(lang, v))));
  const totals = h("ol", { class: "totals" });
  const next = h("p", { class: "muted center" });
  const skip = /** @type {HTMLButtonElement} */ (h("button", { class: "deco-btn wide", onclick: () => act("skip") }, w.buttons.skip));
  const err = h("p", { class: "error" });
  const set = settings(err, { live: true });
  show(
    h(
      "section",
      { class: "card pop scores" },
      h("p", { class: "estate" }, `${w.ui.round} ${r.round ?? ""}`),
      h("h1", { class: "deco-title" }, t.haulRound),
      h("p", { class: "haul" }, h("span", { class: "dot", style: { "--c": colorOf(last?.thief) } }), h("b", {}, nameOf(last?.thief)), h("span", { class: "money big" }, money(lang, last?.haul ?? 0))),
      items.length ? h("ul", { class: "items" }, ...items) : null,
      rewards.length ? h("h2", {}, t.rewards) : null,
      rewards.length ? h("ul", { class: "rewards" }, ...rewards) : null,
      h("h2", {}, t.totals),
      totals,
      next,
      h("p", { class: "starts" }, countdown()),
      skip,
      err,
      set.box,
    ),
  );
  refresh = () => {
    const rr = room();
    const sc = rr.scores ?? {};
    const ids = Object.keys(sc).sort((a, b) => (sc[b] ?? 0) - (sc[a] ?? 0));
    totals.replaceChildren(...ids.map((id) => h("li", { class: id === client.you?.id ? "me" : "" }, h("span", { class: "dot", style: { "--c": colorOf(id) } }), h("b", {}, nameOf(id)), h("span", { class: "money" }, money(lang, sc[id] ?? 0)))));
    const n = rr.next?.[0];
    next.textContent = n ? t.nextUp(nameOf(n)) : "";
    skip.hidden = !isVip();
    set.update();
  };
}

// ---------------------------------------------------------------------------

watchFit();

/** Keeps the screen on while playing. */
async function wake() {
  try {
    await /** @type {any} */ (navigator).wakeLock?.request("screen");
  } catch {}
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void wake();
});

setBanner(null);
/** @type {HTMLElement} */ (app.querySelector(".big") ?? app).textContent = t.connecting;
if (!client.room || !client.key) {
  show(logo(), h("section", { class: "card" }, h("p", { class: "big" }, t.scanToJoin)));
} else if (client.canResume) {
  client.connect().then(wake, (/** @type {any} */ e) => joinForm(e?.code === "no-player" ? "" : message(e)));
} else {
  joinForm();
}
