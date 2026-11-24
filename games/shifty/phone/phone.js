// @ts-check
/**
 * Shifty's phone page: joining, the lobby (the VIP's settings), the card
 * (turned with a tap: the word, or "you are the phony"), the clue when it
 * is one's turn (typed, the typing reported as counts for the TV's
 * needle, never the letters; or said out loud), the accusation, the
 * phony's last chance on the board, the result, scores. Everything it
 * shows comes from the party's view (`{ roster, room, me }`); everything
 * it does is an action (or, while typing, continuous input).
 */

import { blockEmoji, PartyClient } from "/_tvpipe/lib/client.js";
import { watchFit } from "./fit.js";
import { browserLang, LANGS, pickLang } from "./i18n.js";
import { strings } from "./strings.js";

const MAX_CLUE = 24;

// A controller, not a document: no pinch or double-tap zoom, no selection.
for (const type of ["gesturestart", "gesturechange", "gestureend"]) document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
document.addEventListener("touchmove", (e) => e.touches.length > 1 && e.preventDefault(), { passive: false });
document.addEventListener("dblclick", (e) => e.preventDefault(), { passive: false });
document.addEventListener("selectstart", (e) => {
  const tg = e.target instanceof Element ? e.target : /** @type {Node} */ (e.target).parentElement;
  if (!tg?.closest("input")) e.preventDefault();
});

const client = PartyClient.fromLocation();
// No emoji in names, answers or clues (the host drops them too).
blockEmoji();
const app = /** @type {HTMLElement} */ (document.getElementById("app"));
const banner = /** @type {HTMLElement} */ (document.getElementById("banner"));
const who = /** @type {HTMLElement} */ (document.getElementById("who"));

// ---------------------------------------------------------------------------
// The language: the room's, the same on every phone (the host page or the
// VIP sets it); before joining, the browser's.

function roomLang() {
  const l = client.view?.room?.lang;
  return typeof l === "string" ? pickLang(l) : browserLang();
}
let lang = roomLang();
let t = strings(lang);
document.documentElement.lang = lang;
function useLang() {
  const l = roomLang();
  if (l === lang) return false;
  lang = l;
  t = strings(l);
  document.documentElement.lang = l;
  return true;
}

let shown = "";
/** @type {(() => void) | null} called on every view while the screen stays */
let refresh = null;
/** @type {(() => void) | null} sends what there is when time is up */
let autoSubmit = null;
/** @type {(() => void)[]} cleanups of the screen on show */
let cleanups = [];
/** Whether the card is turned up, and for which round. */
let peek = { round: -1, up: false };

// ---------------------------------------------------------------------------
// DOM helpers: text always as text.

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

/** A player's colour from the room (`colors` by id). */
function colorOf(/** @type {string | undefined} */ id) {
  const c = id ? client.view?.room?.colors?.[id] : undefined;
  return typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c) ? c : "#7c8696";
}
/** @param {string} id @param {string} [name] */
function avatar(id, name) {
  return h("span", { class: "avatar", style: { "--c": colorOf(id) } }, [...(name ?? nameOf(id))][0]?.toUpperCase() ?? "?");
}
/** A name from the roster. */
function nameOf(/** @type {string} */ id) {
  return (client.view?.roster ?? []).find((/** @type {any} */ r) => r.id === id)?.name ?? "?";
}

/** A short buzz, where phones do that. @param {number | number[]} ms */
function buzz(ms) {
  try {
    navigator.vibrate?.(ms);
  } catch {}
}

// ---------------------------------------------------------------------------
// Fields

/** @type {CanvasRenderingContext2D | null} */
let ruler = null;

/**
 * Keeps what is typed in a field readable whole: when the text gets
 * longer than the field, its font gets smaller (down to `min` px).
 * @param {HTMLInputElement} input
 * @param {number} [min]
 */
function fitField(input, min = 12) {
  input.style.fontSize = "";
  const text = input.value;
  if (!text || !input.clientWidth) return;
  const cs = getComputedStyle(input);
  const base = parseFloat(cs.fontSize);
  ruler ??= document.createElement("canvas").getContext("2d");
  if (!ruler || !base) return;
  ruler.font = `${cs.fontWeight} ${base}px ${cs.fontFamily}`;
  const shownText = cs.textTransform === "uppercase" ? text.toUpperCase() : text;
  const spacing = parseFloat(cs.letterSpacing) || 0;
  const width = (ruler.measureText(shownText).width + spacing * [...shownText].length) * 1.04;
  const room = input.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 2;
  if (width <= room || room <= 0) return;
  input.style.fontSize = `${Math.max(min, (base * room) / width).toFixed(2)}px`;
}
document.addEventListener("input", (e) => e.target instanceof HTMLInputElement && fitField(e.target));
document.addEventListener("focusin", (e) => e.target instanceof HTMLInputElement && fitField(e.target));

// ---------------------------------------------------------------------------
// Joining

/** @param {string} [error] @param {string} [typed] */
function joinForm(error = "", typed) {
  shown = "join";
  refresh = null;
  const input = /** @type {HTMLInputElement} */ (h("input", { id: "name", maxlength: 16, autocapitalize: "words", enterkeyhint: "go", autocomplete: "off", required: true }));
  const err = h("p", { class: "error" }, error);
  input.value = typed ?? client.saved?.name ?? localStorage.getItem("shifty:name") ?? "";
  const form = h(
    "form",
    {
      autocomplete: "off",
      onsubmit: async (/** @type {Event} */ e) => {
        e.preventDefault();
        const name = input.value.trim();
        if (!name) return;
        try {
          localStorage.setItem("shifty:name", name);
        } catch {}
        err.textContent = "";
        try {
          await client.join(name);
        } catch (x) {
          joinForm(message(x), name);
        }
      },
    },
    h("label", { for: "name" }, t.yourName),
    input,
    h("button", { class: "btn", type: "submit" }, t.join),
    err,
  );
  show(logo(), h("section", { class: "card pop" }, h("h1", {}, t.joinTitle), form));
  if (!input.value) input.focus();
}

function logo() {
  return h("div", { class: "logo" }, h("span", {}, "Shifty"), h("span", { class: "eyes" }, h("i"), h("i")));
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
      return t.closed;
    case "bad-key":
      return t.badKey;
    case "no-room":
      return t.noRoom;
    default:
      return (typeof e?.code === "string" ? t.errors[e.code] : undefined) ?? e?.message ?? String(e);
  }
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
  for (const c of cleanups) c();
  cleanups = [];
  setBanner(null);
  show(logo(), h("section", { class: "card" }, h("p", { class: "big" }, text)));
});
client.on("view", (view) => render(view));

// ---------------------------------------------------------------------------
// Views

/** @param {any} me @param {any} room */
function keyOf(me, room) {
  const r = room.round ?? "";
  switch (me.task) {
    case "clue":
      return `clue:${me.turn}:${me.mine ? 1 : 0}:${me.sent ? 1 : 0}`;
    case "accuse":
    case "pick":
      return `${me.task}:${r}:${me.done ? 1 : 0}`;
    default:
      return `${me.task}:${r}`;
  }
}

/** @param {Record<string, any>} view */
function render(view) {
  const me = view.me ?? {};
  const room = view.room ?? {};
  const mine = (view.roster ?? []).find((/** @type {any} */ r) => r.id === client.you?.id);
  if (useLang()) shown = "";
  const scoreText = typeof me.score === "number" && me.task !== "lobby" && me.of > 0 ? ` · ${t.n(me.score)}` : "";
  who.replaceChildren(...(mine ? [h("span", { class: "dot", style: { "--c": colorOf(mine.id) } }), h("b", {}, `${mine.vip ? "★ " : ""}${mine.name}`), scoreText] : []));
  if (peek.round !== room.round) peek = { round: room.round ?? -1, up: false };
  const key = keyOf(me, room);
  if (key !== shown) {
    shown = key;
    refresh = null;
    autoSubmit = null;
    for (const c of cleanups) c();
    cleanups = [];
    document.body.classList.toggle("phony", me.role === "phony" && peek.up);
    build(view);
  }
  refresh?.();
}

/** @param {Record<string, any>} view */
function build(view) {
  const me = view.me ?? {};
  const room = view.room ?? {};
  switch (me.task) {
    case "lobby":
      return lobby();
    case "wait":
      return show(h("section", { class: "card pop" }, h("p", { class: "big" }, me.note === "game" ? t.waitGame : t.waitRound)));
    case "card":
      return cardScreen(me, room);
    case "clue":
      return me.mine ? (me.sent ? sentScreen(me, room) : clueScreen(me, room)) : othersTurn(me, room);
    case "accuse":
      return me.done ? accused(me, room) : accuse(me, room);
    case "verdict":
      return verdict(me, room);
    case "pick":
      return me.done ? picked(me, room) : pick(me, room);
    case "watch":
      return watching(me, room);
    case "result":
      return result(me, room);
    case "scores":
      return scoreCard(me, room);
    case "final":
      return final();
    default:
      return show(h("section", { class: "card" }, h("p", { class: "big" }, t.lookTv)));
  }
}

/** @param {string} type @param {any} data @param {HTMLElement} [err] */
async function act(type, data, err) {
  if (err) err.textContent = "";
  try {
    return await client.act(type, data);
  } catch (e) {
    if (err) err.textContent = message(e);
    throw e;
  }
}

const isVip = () => !!(client.view?.roster ?? []).find((/** @type {any} */ r) => r.id === client.you?.id)?.vip;

// ---------------------------------------------------------------------------
// Lobby and final: players, the VIP's settings, start.

/** @param {HTMLElement} err */
function settings(err) {
  /** @type {{ key: string, buttons: HTMLButtonElement[], values: any[], line: HTMLElement | null }[]} */
  const items = [];
  const box = h("div", { class: "settings" }, h("h2", {}, t.settings));
  const add = (/** @type {string} */ key, /** @type {any[]} */ values, /** @type {string[]} */ labels, /** @type {string} */ title, /** @type {boolean} */ withLine) => {
    const buttons = values.map((v, i) => /** @type {HTMLButtonElement} */ (h("button", { type: "button", onclick: () => act("settings", { [key]: v }, err).catch(() => {}) }, labels[i])));
    const line = withLine ? h("p", { class: "line" }) : null;
    box.append(h("div", { class: "setting" }, h("label", {}, title), h("div", { class: "seg" }, ...buttons), line));
    items.push({ key, buttons, values, line });
  };
  add("lang", [...LANGS], LANGS.map((l) => strings(l).langName), t.langLabel, false);
  add("rounds", [3, 4, 5, 6], ["3", "4", "5", "6"], t.roundsLabel, false);
  add("mode", ["typed", "spoken"], [t.typed, t.spoken], t.modeLabel, true);
  add("clues", [0, 1, 2], [t.auto, "1", "2"], t.cluesLabel, false);
  add("clueTime", [15, 25, 40], [15, 25, 40].map(t.seconds), t.clueTimeLabel, false);
  add("talkTime", [45, 60, 90, 120], [45, 60, 90, 120].map(t.seconds), t.talkTimeLabel, false);
  add("typing", [true, false], [t.shown, t.hidden], t.typingLabel, false);
  add("late", ["wait", "closed"], [t.lateWait, t.lateClosed], t.lateLabel, false);
  const update = () => {
    const room = client.view?.room ?? {};
    box.hidden = !isVip();
    for (const it of items) {
      const cur = room[it.key];
      it.buttons.forEach((b, i) => b.classList.toggle("on", it.values[i] === cur));
      // A language without words cannot be picked (as on the host page).
      if (it.key === "lang" && Array.isArray(room.langs)) it.buttons.forEach((b, i) => (b.disabled = !room.langs.includes(it.values[i])));
      if (it.key === "mode" && it.line) it.line.textContent = t.modeLine[cur === "spoken" ? 1 : 0] ?? "";
    }
  };
  return { box, update };
}

function lobby() {
  const err = h("p", { class: "error" });
  const list = h("div", { class: "chips" });
  const hint = h("p", { class: "muted small" });
  const start = /** @type {HTMLButtonElement} */ (h("button", { class: "btn", id: "start", onclick: () => act("start", null, err).catch(() => {}) }, t.start));
  const set = settings(err);
  show(
    logo(),
    h("section", { class: "card pop lobby" }, h("h1", {}, t.youreIn), h("h2", {}, t.suspects), list, start, err, hint, set.box),
    h("section", { class: "card plain" }, h("h2", { style: { "margin-top": "0" } }, t.howTitle), h("ol", { class: "how" }, ...t.how.map((x) => h("li", {}, x)))),
  );
  refresh = () => {
    const v = client.view;
    const roster = v.roster ?? [];
    const vip = isVip();
    const min = v.room?.minPlayers ?? 3;
    const ready = roster.filter((/** @type {any} */ r) => r.connected).length;
    list.replaceChildren(
      ...roster.map((/** @type {any} */ r) =>
        h(
          "span",
          { class: `chip${r.connected ? "" : " away"}` },
          h("span", { class: "dot", style: { "--c": colorOf(r.id) } }),
          r.name,
          r.vip ? h("small", {}, t.vip) : null,
          vip && r.id !== client.you?.id ? h("button", { type: "button", "aria-label": `✕ ${r.name}`, onclick: () => act("kick", { id: r.id }, err).catch(() => {}) }, "✕") : null,
        ),
      ),
    );
    start.hidden = !vip;
    start.disabled = ready < min;
    hint.textContent = vip ? (ready < min ? t.vipWait(min - ready) : t.vipReady) : t.waitVip;
    set.update();
  };
}

function final() {
  const me = client.view?.me ?? {};
  const err = h("p", { class: "error" });
  const again = /** @type {HTMLButtonElement} */ (h("button", { class: "btn", id: "start", onclick: () => act("start", null, err).catch(() => {}) }, t.playAgain));
  const set = settings(err);
  show(
    h(
      "section",
      { class: "card pop" },
      h("h1", {}, me.rank === 1 && me.of > 0 ? t.won : t.gameOver),
      h("p", { class: "score" }, t.n(me.score ?? 0), h("small", {}, t.points)),
      h("p", { class: "muted" }, me.of ? t.rank(me.rank ?? 0, me.of) : ""),
      again,
      err,
      set.box,
    ),
  );
  refresh = () => {
    again.hidden = !isVip();
    set.update();
  };
}

// ---------------------------------------------------------------------------
// Pieces: the clock, the card, the board, the clues

/** A time bar and the seconds, ticking until the deadline. @param {number} deadline */
function clock(deadline) {
  const bar = h("div", { class: "timebar" }, h("i"));
  const secs = h("span", { class: "secs" });
  const total = Math.max(1000, deadline - client.now());
  const fill = /** @type {HTMLElement} */ (bar.firstChild);
  const tick = () => {
    const ms = deadline - client.now();
    fill.style.transform = `scaleX(${Math.max(0, Math.min(1, ms / total))})`;
    secs.textContent = String(Math.max(0, Math.ceil(Math.min(ms, total) / 1000)));
    const low = ms < 5000;
    bar.classList.toggle("low", low);
    secs.classList.toggle("low", low && ms > 0);
    if (ms < 700) autoSubmit?.();
  };
  tick();
  const timer = setInterval(tick, 200);
  cleanups.push(() => clearInterval(timer));
  return h("div", { class: "clockrow" }, bar, secs);
}

/**
 * The card: face down until tapped (a neighbour's glance is no leak), then
 * the word or "you are the phony", with the category. `big` on the deal.
 * @param {any} me @param {any} room @param {boolean} [big]
 */
function card(me, room, big = false) {
  const phony = me.role === "phony";
  const face = h(
    "div",
    { class: "face" },
    phony ? h("small", {}, t.yourCard) : h("small", {}, t.theWordIs),
    phony ? h("b", { class: "phonyword", "data-fit": "2" }, t.youArePhony) : h("b", { "data-fit": "1" }, me.word ?? ""),
    h("span", { class: "cat" }, `${t.category}: ${room.category ?? ""}`),
    big ? h("p", { class: "help" }, phony ? t.phonyHelp : t.innocentHelp) : null,
  );
  const back = h("div", { class: "back" }, h("span", { class: "eyes" }, h("i"), h("i")), h("small", {}, t.tapCard));
  const el = h("button", { type: "button", class: `secret${big ? " big" : ""}${phony ? " isphony" : ""}`, "aria-pressed": "false" }, back, face);
  const set = () => {
    el.classList.toggle("up", peek.up);
    el.setAttribute("aria-pressed", String(peek.up));
    document.body.classList.toggle("phony", phony && peek.up);
  };
  el.addEventListener("click", () => {
    peek.up = !peek.up;
    set();
    buzz(10);
  });
  set();
  return el;
}

/**
 * The board's sixteen words; with `onPick` a button each (the phony's last chance).
 * @param {any} room @param {((i: number, b: HTMLElement) => void) | null} [onPick]
 */
function board(room, onPick = null) {
  const words = /** @type {string[]} */ (room.board ?? []);
  return h(
    "div",
    { class: `board${onPick ? " picking" : ""}` },
    ...words.map((w, i) => {
      const b = h(onPick ? "button" : "span", { class: "w", type: onPick ? "button" : null }, h("span", { "data-fit": "1" }, w));
      if (onPick) b.addEventListener("click", () => onPick(i, b));
      return b;
    }),
  );
}

/** The clues so far, by player in the order of the turns. @param {any} room */
function clues(room) {
  const order = /** @type {string[]} */ (room.order ?? []);
  const list = h("div", { class: "clues" });
  for (const id of order) {
    const cs = /** @type {any[]} */ (room.clues?.[id] ?? []);
    list.append(h("div", { class: "row" }, avatar(id), h("b", {}, nameOf(id)), h("span", { class: "said" }, ...cs.map((c) => h("i", { class: c.text ? "" : "none", "data-fit": "1" }, c.away ? "–" : c.text ? c.text : c.spoken ? "🗣" : "…")))));
  }
  return list;
}

// ---------------------------------------------------------------------------
// The round

/** @param {any} me @param {any} room */
function cardScreen(me, room) {
  show(h("section", { class: "card pop center" }, card(me, room, true)), h("section", { class: "card plain" }, h("h2", {}, t.board), board(room)));
}

/** Typing counts for the TV's needle, per turn (a re-render keeps them). */
let typing = { turn: "", n: 0, k: 0, d: 0 };

/** @param {any} me @param {any} room */
function clueScreen(me, room) {
  const spoken = room.mode === "spoken";
  const err = h("p", { class: "error" });
  const input = /** @type {HTMLInputElement} */ (h("input", { class: "clue", maxlength: MAX_CLUE, autocapitalize: "off", autocorrect: "off", spellcheck: "false", autocomplete: "off", enterkeyhint: "send", placeholder: spoken ? t.pinIt : "" }));
  const send = /** @type {HTMLButtonElement} */ (h("button", { class: "btn", type: "submit" }, spoken ? t.done : t.send));
  if (typing.turn !== me.turn) typing = { turn: me.turn, n: 0, k: 0, d: 0 };
  let busy = false;
  const submit = async () => {
    if (busy) return;
    const text = input.value.trim();
    if (!text && !spoken) {
      err.textContent = t.refused.empty;
      return;
    }
    busy = true;
    send.disabled = true;
    try {
      const res = /** @type {any} */ (await act("clue", { key: me.turn, text }, err));
      if (res && res.ok === false) {
        const why = res.reason === "board" ? t.refused.board(res.word ?? "") : (t.refused[/** @type {"space"} */ (res.reason)] ?? t.refused.refused);
        err.textContent = typeof why === "string" ? why : "";
        buzz([30, 60, 30]);
        input.select();
      }
    } catch {
    } finally {
      busy = false;
      send.disabled = false;
    }
  };
  input.addEventListener("input", () => {
    if (spoken) return;
    const n = [...input.value].length;
    if (n > typing.n) typing.k += n - typing.n;
    else if (n < typing.n) typing.d += typing.n - n;
    typing.n = n;
    client.input({ turn: me.turn, n: typing.n, k: typing.k, d: typing.d });
    err.textContent = "";
  });
  const form = h(
    "form",
    {
      class: "clueform",
      autocomplete: "off",
      onsubmit: (/** @type {Event} */ e) => {
        e.preventDefault();
        void submit();
      },
    },
    input,
    send,
  );
  // Time up: what is typed goes in (a clue the board refuses stays out).
  autoSubmit = () => {
    autoSubmit = null;
    if (input.value.trim()) void submit();
  };
  buzz([60, 40, 60]);
  show(
    h("section", { class: "card pop turn" }, h("h1", {}, spoken ? t.sayIt : t.yourTurn), clock(me.deadline ?? 0), h("p", { class: "muted small" }, spoken ? t.sayHint : t.clueHint), form, err),
    h("section", { class: "card plain" }, card(me, room), h("h2", {}, t.board), board(room)),
  );
  if (!spoken) input.focus();
}

/** @param {any} me @param {any} room */
function sentScreen(me, room) {
  show(h("section", { class: "card pop" }, h("p", { class: "big" }, t.sent)), h("section", { class: "card plain" }, card(me, room), h("h2", {}, t.cluesSoFar), clues(room)));
}

/** @param {any} me @param {any} room */
function othersTurn(me, room) {
  const turn = room.turn ?? {};
  const name = nameOf(turn.id);
  const line = h("p", { class: "big" }, room.mode === "spoken" ? t.saying(name) : t.typing(name));
  const list = h("div");
  show(h("section", { class: "card pop" }, h("div", { class: "turnwho" }, avatar(turn.id), line), turn.deadline ? clock(turn.deadline) : null), h("section", { class: "card plain" }, card(me, room), h("h2", {}, t.cluesSoFar), list, h("h2", {}, t.board), board(room)));
  refresh = () => list.replaceChildren(clues(client.view?.room ?? room));
}

/** @param {any} me @param {any} room */
function accuse(me, room) {
  const err = h("p", { class: "error" });
  const order = /** @type {string[]} */ (room.order ?? []).filter((id) => id !== client.you?.id);
  /** @type {string | null} */
  let choice = null;
  const confirm = /** @type {HTMLButtonElement} */ (h("button", { class: "btn red", disabled: true }, t.accuse("…")));
  const buttons = order.map((id) => {
    const cs = /** @type {any[]} */ (room.clues?.[id] ?? []);
    const b = h("button", { type: "button", class: "suspect" }, avatar(id), h("span", { class: "nm" }, nameOf(id)), h("span", { class: "said" }, ...cs.map((c) => h("i", { class: c.text ? "" : "none", "data-fit": "1" }, c.away ? "–" : c.text ? c.text : c.spoken ? "🗣" : "…"))));
    b.addEventListener("click", () => {
      choice = id;
      for (const x of buttons) x.classList.toggle("on", x === b);
      confirm.disabled = false;
      confirm.textContent = t.accuse(nameOf(id));
      buzz(10);
    });
    return b;
  });
  confirm.addEventListener("click", () => {
    if (choice) act("accuse", { id: choice }, err).catch(() => {});
  });
  show(h("section", { class: "card pop" }, h("h1", {}, t.accuseTitle), clock(me.deadline ?? 0), h("p", { class: "muted small" }, t.accuseHint), h("div", { class: "suspects" }, ...buttons), confirm, err), h("section", { class: "card plain" }, card(me, room)));
}

/** @param {any} me @param {any} room */
function accused(me, room) {
  show(h("section", { class: "card pop" }, h("p", { class: "big" }, t.accusedYou(nameOf(me.choice))), h("p", { class: "muted" }, t.waitOthers), clock(me.deadline ?? 0)), h("section", { class: "card plain" }, card(me, room)));
}

/** @param {any} me @param {any} room */
function verdict(me, room) {
  const top = me.top ? nameOf(me.top) : null;
  show(h("section", { class: "card pop center" }, h("h1", { class: me.caught ? "red" : "" }, top ? (me.caught ? t.verdictCaught : t.verdictInnocent) : t.verdictNobody), top ? h("p", { class: "muted" }, t.verdictWho(top)) : null), h("section", { class: "card plain" }, card(me, room)));
}

/** @param {any} me @param {any} room */
function pick(me, room) {
  const err = h("p", { class: "error" });
  /** @type {number | null} */
  let choice = null;
  const confirm = /** @type {HTMLButtonElement} */ (h("button", { class: "btn red", disabled: true }, t.thatsIt));
  const grid = board(room, (i, b) => {
    choice = i;
    for (const x of grid.querySelectorAll(".w")) x.classList.toggle("on", x === b);
    confirm.disabled = false;
    buzz(10);
  });
  confirm.addEventListener("click", () => {
    if (choice !== null) act("pick", { index: choice }, err).catch(() => {});
  });
  buzz([60, 40, 60]);
  show(h("section", { class: "card pop" }, h("h1", { class: "red" }, t.lastTitle), clock(me.deadline ?? 0), h("p", { class: "muted small" }, t.lastHint), grid, confirm, err));
}

/** @param {any} me @param {any} room */
function picked(me, room) {
  show(h("section", { class: "card pop center" }, h("p", { class: "big" }, t.picked(room.board?.[me.pick] ?? "")), h("p", { class: "muted" }, t.waitOthers)));
}

/** @param {any} me @param {any} room */
function watching(me, room) {
  const phony = room.verdict?.phony;
  show(h("section", { class: "card pop center" }, phony ? h("div", { class: "turnwho" }, avatar(phony.id, phony.name), h("p", { class: "big" }, t.guessing(phony.name))) : null, clock(me.deadline ?? 0)), h("section", { class: "card plain" }, card(me, room), h("h2", {}, t.board), board(room)));
}

/** @param {any} me @param {any} room */
function result(me, room) {
  const e = me.earned ?? {};
  const kinds = /** @type {const} */ (["accuse", "team", "escape", "word"]);
  const gains = kinds.filter((k) => e[k] > 0);
  const phony = me.role === "phony";
  const lines = me.gone ? [t.gone] : phony ? [me.caught ? t.youCaught : t.youEscaped, me.named ? t.youNamed : t.youMissed] : [t.phonyWas(me.phony ?? "")];
  document.body.classList.remove("phony");
  show(
    h(
      "section",
      { class: "card pop center" },
      h("small", { class: "muted" }, t.theWord),
      h("p", { class: "reveal", "data-fit": "1" }, me.word ?? ""),
      ...lines.map((l) => h("p", {}, l)),
      gains.length > 0 ? h("ul", { class: "gains" }, ...gains.map((k) => h("li", {}, h("span", {}, t.kinds[k]), h("b", {}, `+${t.n(e[k])}`)))) : h("p", { class: "muted" }, me.gone ? "" : t.nothing),
    ),
  );
  void room;
}

/** @param {any} me @param {any} room */
function scoreCard(me, room) {
  const e = me.earned ?? {};
  const kinds = /** @type {const} */ (["accuse", "team", "escape", "word"]);
  show(
    h(
      "section",
      { class: "card pop" },
      h("h2", { style: { "margin-top": "0" } }, `${t.roundN(room.round ?? 1)} · ${t.thisRound}`),
      h("p", { class: "score" }, `+${t.n(me.delta ?? 0)}`),
      h("ul", { class: "gains" }, ...kinds.filter((k) => e[k] > 0).map((k) => h("li", {}, h("span", {}, t.kinds[k]), h("b", {}, `+${t.n(e[k])}`)))),
      h("p", { class: "total" }, `${t.pointsN(me.score ?? 0)} · ${me.of ? t.rank(me.rank ?? 0, me.of) : ""}`),
    ),
  );
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

/** @type {HTMLElement} */ (app.querySelector(".big")).textContent = t.connecting;
if (!client.room || !client.key) {
  show(logo(), h("section", { class: "card" }, h("p", { class: "big" }, t.scanToJoin)));
} else if (client.canResume) {
  client.connect().then(wake, (e) => joinForm(e?.code === "no-player" ? "" : message(e)));
} else {
  joinForm();
}
