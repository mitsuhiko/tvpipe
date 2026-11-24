// @ts-check
/**
 * Busted's phone page: a reporter's notebook. Joining, the lobby (the
 * press photo drawn with a finger, the VIP's settings and honorary
 * candidates), the question, the podium (tap gold, silver, bronze), the
 * answer, the matching of anonymous answers to writers (with a heart for
 * the best), the results, the cover at the end. Between, whenever the
 * player waits, the editor's desk: suggested questions to rate (print
 * it, meh, no way), and the ✎ button to suggest one. Everything it shows
 * comes from the party's view (`{ roster, room, me }`); everything it
 * does is an action.
 */

import { blockEmoji, PartyClient } from "/_tvpipe/lib/client.js";
import { doodle, FACE, MAX_POINTS, MAX_STROKES, pathOf, thin } from "../game/face.js";
import { watchFit } from "./fit.js";
import { browserLang, LANGS, pickLang } from "./i18n.js";
import { strings } from "./strings.js";

const MAX_ANSWER = 80;
const MAX_QUESTION = 120;
const MAX_TITLE = 28;

// A controller, not a document: no pinch or double-tap zoom, no selection outside fields.
for (const type of ["gesturestart", "gesturechange", "gestureend"]) document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
document.addEventListener("touchmove", (e) => e.touches.length > 1 && e.preventDefault(), { passive: false });
document.addEventListener("dblclick", (e) => e.preventDefault(), { passive: false });
document.addEventListener("selectstart", (e) => {
  const tg = e.target instanceof Element ? e.target : /** @type {Node} */ (e.target).parentElement;
  if (!tg?.closest("input, textarea")) e.preventDefault();
});

const client = PartyClient.fromLocation();
// No emoji in names, answers or questions (the host drops them too).
blockEmoji();
const app = /** @type {HTMLElement} */ (document.getElementById("app"));
const banner = /** @type {HTMLElement} */ (document.getElementById("banner"));
const who = /** @type {HTMLElement} */ (document.getElementById("who"));
const mark = /** @type {HTMLElement} */ (document.getElementById("mark"));
const tipButton = /** @type {HTMLButtonElement} */ (document.getElementById("tip"));
const sheet = /** @type {HTMLElement} */ (document.getElementById("sheet"));

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
tipButton.addEventListener("click", () => openSuggest());

let shown = "";
/** @type {(() => void)[]} called on every view while the screen stays */
let refreshers = [];
/** @type {(() => void)[]} cleanups of the screen on show */
let cleanups = [];

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

/** @param {string} id @returns {{ name: string, color: string, face: number[][] | null, extra?: boolean }} */
function person(id) {
  return client.view?.room?.people?.[id] ?? { name: nameOf(id), color: "#7c8696", face: null };
}
/** A name from the roster. @param {string} id */
function nameOf(id) {
  return (client.view?.roster ?? []).find((/** @type {any} */ r) => r.id === id)?.name ?? "?";
}
const isColor = (/** @type {unknown} */ c) => typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c);
/** @param {string} id */
function colorOf(id) {
  const c = person(id).color;
  return isColor(c) ? c : "#7c8696";
}

const SVG_NS = "http://www.w3.org/2000/svg";
/** @param {number[][]} strokes */
function strokesSvg(strokes) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${FACE} ${FACE}`);
  svg.setAttribute("aria-hidden", "true");
  for (const s of strokes) {
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("d", pathOf(s));
    svg.append(p);
  }
  return svg;
}
/** A face: the drawn portrait, else the doodle of the name. @param {string} id @param {number} [size] @param {boolean} [round] */
function face(id, size, round = false) {
  const p = person(id);
  const strokes = Array.isArray(p.face) && p.face.length > 0 ? p.face : doodle(p.name);
  return h("span", { class: `face${round ? " round" : ""}`, style: { "--c": colorOf(id), ...(size ? { "--s": `${size}px` } : {}) } }, strokesSvg(strokes));
}

/** A short buzz, where phones do that. @param {number | number[]} ms */
function buzz(ms) {
  try {
    navigator.vibrate?.(ms);
  } catch {}
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

const me = () => client.view?.me ?? {};
const room = () => client.view?.room ?? {};
const isVip = () => !!(client.view?.roster ?? []).find((/** @type {any} */ r) => r.id === client.you?.id)?.vip;

/** The countdown in a card's corner. @param {number} deadline */
function clock(deadline) {
  const el = h("span", { class: "clock" });
  const tick = () => {
    const left = Math.max(0, deadline - client.now());
    const s = Math.ceil(left / 1000);
    el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    el.classList.toggle("low", left > 0 && left <= 5000);
  };
  tick();
  const timer = setInterval(tick, 250);
  cleanups.push(() => clearInterval(timer));
  return el;
}

/** Calls `fn` just before the deadline (what there is goes in when time runs out). @param {number} deadline @param {() => void} fn */
function atDeadline(deadline, fn) {
  const ms = deadline - client.now() - 400;
  if (ms <= 0) return;
  const timer = setTimeout(fn, ms);
  cleanups.push(() => clearTimeout(timer));
}

/** The VIP's way out of a question the room does not want (while it is asked, ranked or written). */
function skipButton() {
  if (!isVip()) return null;
  const err = h("p", { class: "error" });
  return h("div", {}, h("button", { class: "btn ghost small", type: "button", onclick: () => act("skip", null, err).catch(() => {}) }, t.skipQ), err);
}

/** The question's kicker. @param {any} q */
function kicker(q) {
  if (q?.by) return h("span", { class: "kicker yellow" }, t.readerQ(q.by.name ?? ""));
  return h("span", { class: q?.kind === "answer" ? "kicker black" : "kicker" }, q?.kind === "answer" ? t.askKicker : t.pollKicker);
}

// ---------------------------------------------------------------------------
// Joining

/** @param {string} [error] @param {string} [typed] */
function joinForm(error = "", typed) {
  shown = "join";
  refreshers = [];
  tipButton.hidden = true;
  mark.textContent = t.masthead;
  const input = /** @type {HTMLInputElement} */ (h("input", { id: "name", maxlength: 16, autocapitalize: "words", enterkeyhint: "go", autocomplete: "off", required: true }));
  const err = h("p", { class: "error" }, error);
  input.value = typed ?? client.carried?.name ?? localStorage.getItem("busted:name") ?? "";
  const form = h(
    "form",
    {
      autocomplete: "off",
      onsubmit: async (/** @type {Event} */ e) => {
        e.preventDefault();
        const name = input.value.trim();
        if (!name) return;
        try {
          localStorage.setItem("busted:name", name);
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
  return h("div", { class: "logo" }, h("b", {}, t.masthead), h("span", {}, "Busted"));
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
  refreshers = [];
  for (const c of cleanups) c();
  cleanups = [];
  setBanner(null);
  tipButton.hidden = true;
  closeSheet();
  show(logo(), h("section", { class: "card" }, h("p", { class: "big" }, text)));
});
client.on("view", (view) => render(view));

// ---------------------------------------------------------------------------
// Views

/** @param {any} m @param {any} r */
function keyOf(m, r) {
  const q = r.question?.text ?? "";
  const base = `${m.task}:${r.round ?? ""}:${q}`;
  switch (m.task) {
    case "rank":
    case "write":
    case "match":
      return `${base}:${m.done ? 1 : 0}`;
    default:
      return base;
  }
}

/** @param {Record<string, any>} view */
function render(view) {
  const m = view.me ?? {};
  const r = view.room ?? {};
  const mine = (view.roster ?? []).find((/** @type {any} */ x) => x.id === client.you?.id);
  if (useLang()) shown = "";
  mark.textContent = t.masthead;
  const scoreText = typeof m.score === "number" && m.task !== "lobby" && m.of > 0 ? ` · ${t.n(m.score)}` : "";
  who.replaceChildren(...(mine ? [h("span", { class: "dot", style: { "--c": colorOf(mine.id) } }), h("b", {}, `${mine.vip ? "★ " : ""}${mine.name}`), scoreText] : []));
  tipButton.hidden = !m.task;
  tipButton.textContent = t.suggest;
  const key = keyOf(m, r);
  if (key !== shown) {
    shown = key;
    refreshers = [];
    for (const c of cleanups) c();
    cleanups = [];
    build(view);
    window.scrollTo({ top: 0 });
  }
  for (const f of refreshers) f();
  if (sheetRefresh) sheetRefresh();
}

/** @param {Record<string, any>} view */
function build(view) {
  const m = view.me ?? {};
  const r = view.room ?? {};
  switch (m.task) {
    case "lobby":
      return lobby();
    case "wait":
      return show(h("section", { class: "card pop center" }, h("p", { class: "big" }, m.note === "game" ? t.waitGame : t.waitRound)), photoCard(), desk());
    case "ask":
      return show(h("section", { class: "card pop" }, kicker(r.question), h("p", { class: "q" }, r.question?.text ?? ""), h("p", { class: "deck" }, t.lookTv), skipButton()), desk());
    case "rank":
      return m.done ? ranked(m, r) : rank(m, r);
    case "write":
      return m.done ? written(m) : write(m, r);
    case "read":
      return show(h("section", { class: "card pop center" }, h("p", { class: "big" }, t.readTv), h("p", { class: "deck" }, r.question?.text ?? "")), desk());
    case "match":
      return m.done ? waitCard(t.filed) : match(m, r);
    case "watch":
      return waitCard(t.watchTv);
    case "scores":
      return scoreCard(m, r);
    case "final":
      return final(m);
    default:
      return show(h("section", { class: "card" }, h("p", { class: "big" }, t.lookTv)));
  }
}

/** @param {string} text */
function waitCard(text) {
  show(h("section", { class: "card pop center" }, h("div", { class: "stamp" }, text), h("p", { class: "deck" }, room().question?.text ?? "")), desk());
}

// ---------------------------------------------------------------------------
// The editor's desk: rate the suggestions while waiting

function desk() {
  const box = h("section", { class: "desk pop" });
  let shownId = "";
  const draw = () => {
    const d = me().desk ?? {};
    const r = d.rate;
    box.hidden = !r;
    if (!r || r.id === shownId) return;
    shownId = r.id;
    const send = (/** @type {1 | -1 | "no"} */ rating) => {
      buzz(15);
      shownId = "";
      box.hidden = true;
      act("rate", { id: r.id, rating }).catch(() => {});
    };
    box.replaceChildren(
      ...[
        h("div", { class: "head" }, h("span", {}, t.desk), h("small", {}, t.toRate(d.left ?? 1))),
        h("div", { class: "kind" }, r.kind === "vote" ? t.kindVote : t.kindAnswer),
        h("p", { class: "tq" }, r.text),
        r.title ? h("div", { class: "tt" }, `${t.title}: ${r.title}`) : null,
      ].filter((x) => x !== null),
      h("div", { class: "stamps" }, h("button", { class: "up", type: "button", onclick: () => send(1) }, t.printIt), h("button", { class: "down", type: "button", onclick: () => send(-1) }, t.meh), h("button", { class: "no", type: "button", onclick: () => send("no") }, t.noWay)),
    );
  };
  draw();
  refreshers.push(draw);
  return box;
}

// ---------------------------------------------------------------------------
// Sheets

/** @type {(() => void) | null} */
let sheetRefresh = null;
/** @param {...(Node | null)} kids */
function openSheet(...kids) {
  const panel = h("div", { class: "panel" }, ...kids);
  sheet.replaceChildren(panel);
  sheet.hidden = false;
  sheet.onclick = (e) => {
    if (e.target === sheet) closeSheet();
  };
  return panel;
}
function closeSheet() {
  sheet.hidden = true;
  sheet.replaceChildren();
  sheetRefresh = null;
}

/** Suggesting a question. */
function openSuggest() {
  /** @type {"vote" | "answer"} */
  let kind = "vote";
  const err = h("p", { class: "error" });
  const text = /** @type {HTMLTextAreaElement} */ (h("textarea", { maxlength: MAX_QUESTION, rows: 3, enterkeyhint: "done", autocapitalize: "sentences" }));
  const title = /** @type {HTMLInputElement} */ (h("input", { maxlength: MAX_TITLE, autocapitalize: "words", enterkeyhint: "done" }));
  const titleBox = h("div", {}, h("label", {}, t.titleLabel), title);
  const counter = h("div", { class: "count" });
  const voteB = h("button", { type: "button" }, h("b", {}, t.kindVoteLong), h("span", {}, t.kindVoteHint));
  const ansB = h("button", { type: "button" }, h("b", {}, t.kindAnswerLong), h("span", {}, t.kindAnswerHint));
  const setKind = (/** @type {"vote" | "answer"} */ k) => {
    kind = k;
    voteB.classList.toggle("on", k === "vote");
    ansB.classList.toggle("on", k === "answer");
    titleBox.hidden = k !== "vote";
    text.placeholder = k === "vote" ? t.votePlaceholder : t.answerPlaceholder;
    title.placeholder = t.titlePlaceholder;
  };
  voteB.onclick = () => setKind("vote");
  ansB.onclick = () => setKind("answer");
  const update = () => (counter.textContent = `${[...text.value].length} / ${MAX_QUESTION}`);
  text.addEventListener("input", update);
  const list = h("ul", { class: "mytips" });
  const send = /** @type {HTMLButtonElement} */ (
    h(
      "button",
      {
        class: "btn",
        type: "button",
        onclick: async () => {
          if (!text.value.trim()) return;
          try {
            await act("suggest", { kind, text: text.value, ...(kind === "vote" && title.value.trim() ? { title: title.value } : {}) }, err);
            text.value = "";
            title.value = "";
            update();
            err.textContent = t.sentTip;
            buzz(20);
          } catch {}
        },
      },
      t.sendTip,
    )
  );
  openSheet(
    h("h1", {}, t.suggestTitle),
    h("p", { class: "deck" }, t.suggestHint),
    h("div", { class: "kinds" }, voteB, ansB),
    text,
    counter,
    titleBox,
    send,
    err,
    h("h2", {}, t.yourTips),
    list,
    h("button", { class: "btn ghost small", type: "button", onclick: closeSheet }, t.close),
  );
  setKind("vote");
  update();
  sheetRefresh = () => {
    const mine = /** @type {any[]} */ (me().desk?.mine ?? []);
    list.replaceChildren(...mine.map((s) => h("li", {}, h("b", {}, s.text), h("span", { class: s.state }, /** @type {any} */ (t.tipState)[s.state] ?? s.state))));
  };
  sheetRefresh();
  text.focus();
}

// ---------------------------------------------------------------------------
// The press photo

function photoCard() {
  const box = h("section", { class: "card pop" });
  let key = "";
  const draw = () => {
    const id = client.you?.id;
    if (!id) return;
    const p = person(id);
    const k = JSON.stringify([p.face?.length ?? 0, p.name, lang]);
    if (k === key) return;
    key = k;
    box.replaceChildren(
      h("h2", {}, t.pressPhoto),
      h("div", { class: "portrait" }, face(id), h("div", { class: "side" }, h("p", { class: "deck", style: { margin: "0" } }, t.photoHint), h("button", { class: "btn small", type: "button", onclick: () => openPad() }, p.face?.length ? t.redraw : t.drawIt))),
    );
  };
  draw();
  refreshers.push(draw);
  return box;
}

/** Drawing the press photo with a finger: black marker on a square. */
function openPad() {
  const canvas = /** @type {HTMLCanvasElement} */ (h("canvas"));
  const pad = h("div", { class: "pad" }, h("div", { class: "guide" }), canvas);
  const err = h("p", { class: "error" });
  /** @type {number[][]} */
  const strokes = [];
  /** @type {number[] | null} */
  let cur = null;
  const ctx = canvas.getContext("2d");
  const size = () => {
    const r = canvas.getBoundingClientRect();
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    canvas.width = Math.round(r.width * dpr);
    canvas.height = Math.round(r.height * dpr);
    draw();
  };
  const draw = () => {
    if (!ctx) return;
    const k = canvas.width / FACE;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.clearRect(0, 0, FACE, FACE);
    ctx.strokeStyle = "#161513";
    ctx.lineWidth = 3.2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const s of [...strokes, ...(cur ? [cur] : [])]) ctx.stroke(new Path2D(pathOf(s)));
  };
  const at = (/** @type {PointerEvent} */ e) => {
    const r = canvas.getBoundingClientRect();
    return [Math.max(0, Math.min(FACE, ((e.clientX - r.left) / r.width) * FACE)), Math.max(0, Math.min(FACE, ((e.clientY - r.top) / r.height) * FACE))];
  };
  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    cur = at(e);
    draw();
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!cur) return;
    for (const ev of e.getCoalescedEvents?.() ?? [e]) cur.push(...at(ev));
    draw();
  });
  const up = () => {
    if (!cur) return;
    if (strokes.length < MAX_STROKES) strokes.push(thin(cur, 0.8));
    cur = null;
    draw();
  };
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", up);
  for (const type of ["touchstart", "touchmove", "touchend"]) canvas.addEventListener(type, (e) => e.preventDefault(), { passive: false });
  const save = async () => {
    // Within the limits: thinner and thinner until it fits.
    let out = strokes.map((s) => s.map((v) => Math.round(v * 10) / 10));
    for (const min of [1.2, 1.8, 2.6, 3.6, 5]) {
      out = strokes.map((s) => thin(s, min).map((v) => Math.round(v)));
      if (out.reduce((a, s) => a + s.length / 2, 0) <= MAX_POINTS) break;
    }
    try {
      await act("portrait", { strokes: out }, err);
      closeSheet();
    } catch {}
  };
  openSheet(
    h("h1", {}, t.padTitle),
    h("p", { class: "deck" }, t.padHint),
    pad,
    h(
      "div",
      { class: "row" },
      h("button", { class: "btn ghost small", type: "button", onclick: () => (strokes.pop(), draw()) }, t.undo),
      h("button", { class: "btn ghost small", type: "button", onclick: () => ((strokes.length = 0), draw()) }, t.wipe),
    ),
    h("button", { class: "btn", type: "button", onclick: save }, t.save),
    err,
    h("button", { class: "btn ghost small", type: "button", onclick: closeSheet }, t.cancel),
  );
  requestAnimationFrame(size);
}

// ---------------------------------------------------------------------------
// Lobby and final: players, the VIP's settings and honorary candidates, start.

/** @param {HTMLElement} err */
function settings(err) {
  /** @type {{ key: string, buttons: HTMLButtonElement[], values: any[], line: HTMLElement | null, lines: string[] | null }[]} */
  const items = [];
  const box = h("div", { class: "settings" }, h("h2", {}, t.settings));
  // `lines`: a line under the buttons for each value.
  const add = (/** @type {string} */ key, /** @type {any[]} */ values, /** @type {string[]} */ labels, /** @type {string} */ title, /** @type {string[] | null} */ lines) => {
    const buttons = values.map((v, i) => /** @type {HTMLButtonElement} */ (h("button", { type: "button", onclick: () => act("settings", { [key]: v }, err).catch(() => {}) }, labels[i])));
    const line = lines ? h("p", { class: "line" }) : null;
    box.append(h("div", { class: "setting" }, h("label", {}, title), h("div", { class: "seg" }, ...buttons), line));
    items.push({ key, buttons, values, line, lines });
  };
  add("lang", [...LANGS], LANGS.map((l) => strings(l).langName), t.langLabel, null);
  add("rounds", [6, 8, 10, 12], ["6", "8", "10", "12"], t.roundsLabel, null);
  add("level", ["family", "party"], [t.family, t.party], t.levelLabel, t.levelLine);
  add("ballots", ["open", "secret"], [t.open, t.secret], t.ballotsLabel, null);
  add("writeTime", [45, 60, 90], [45, 60, 90].map(t.seconds), t.writeLabel, null);
  add("lateJoin", ["wait", "closed"], [t.lateWait, t.lateClosed], t.lateLabel, t.lateLine);
  const update = () => {
    const r = room();
    box.hidden = !isVip();
    for (const it of items) {
      const cur = r[it.key];
      const at = it.values.indexOf(cur);
      it.buttons.forEach((b, i) => b.classList.toggle("on", i === at));
      if (it.line && it.lines) it.line.textContent = it.lines[Math.max(0, at)] ?? "";
    }
  };
  return { box, update };
}

/** The VIP's honorary candidates. @param {HTMLElement} err */
function extrasBox(err) {
  const list = h("div", { class: "chips" });
  const input = /** @type {HTMLInputElement} */ (h("input", { maxlength: 16, placeholder: t.extraName, autocapitalize: "words", enterkeyhint: "done" }));
  const add = /** @type {HTMLButtonElement} */ (
    h(
      "button",
      {
        class: "btn small",
        type: "button",
        style: { flex: "0 0 auto", width: "auto", "margin-top": "0", padding: "10px 16px" },
        onclick: async () => {
          if (!input.value.trim()) return;
          try {
            await act("extra", { name: input.value }, err);
            input.value = "";
          } catch {}
        },
      },
      t.add,
    )
  );
  const form = h("div", { class: "row", style: { "margin-top": "8px" } }, input, add);
  const box = h("div", {}, h("h2", {}, t.extras), h("p", { class: "small muted", style: { margin: "0 0 8px" } }, t.extrasHint), list, form);
  const update = () => {
    const r = room();
    box.hidden = !isVip();
    const ids = /** @type {string[]} */ (r.extras ?? []);
    list.replaceChildren(...ids.map((id) => h("span", { class: "chip" }, face(id, 28), person(id).name, h("button", { type: "button", "aria-label": `✕ ${person(id).name}`, onclick: () => act("extra", { remove: id }, err).catch(() => {}) }, "✕"))));
    form.hidden = ids.length >= (r.maxExtras ?? 3);
  };
  return { box, update };
}

function lobby() {
  const err = h("p", { class: "error" });
  const list = h("div", { class: "chips" });
  const hint = h("p", { class: "muted small" });
  const start = /** @type {HTMLButtonElement} */ (h("button", { class: "btn", id: "start", onclick: () => act("start", null, err).catch(() => {}) }, t.start));
  const set = settings(err);
  const ex = extrasBox(err);
  show(
    h("section", { class: "card pop" }, h("h1", {}, t.youreIn), h("h2", {}, t.reporters), list, start, err, hint, set.box, ex.box),
    photoCard(),
    desk(),
    h("section", { class: "card plain" }, h("h2", { style: { "border-top": "0" } }, t.howTitle), h("ol", { class: "how" }, ...t.how.map((x) => h("li", {}, x)))),
  );
  refreshers.push(() => {
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
          face(r.id, 28),
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
    ex.update();
  });
}

/** @param {any} m */
function final(m) {
  const err = h("p", { class: "error" });
  const again = /** @type {HTMLButtonElement} */ (h("button", { class: "btn", id: "start", onclick: () => act("start", null, err).catch(() => {}) }, t.playAgain));
  const set = settings(err);
  const id = client.you?.id ?? "";
  const c = m.cover;
  const cover = c
    ? h(
        "div",
        { class: "mycover", style: { "--c": colorOf(id) } },
        h("div", { class: "cm" }, "BUSTED!"),
        face(id),
        h("div", { class: "nm" }, person(id).name),
        h("div", { class: "lines" }, ...(c.titles.length ? c.titles.slice(0, 4).map((/** @type {string} */ x, /** @type {number} */ i) => h("span", { class: i === 0 ? "first" : "" }, x)) : [h("q", {}, t.noTitles)]), c.quote ? h("q", {}, c.quote) : null),
      )
    : null;
  show(
    h(
      "section",
      { class: "card pop center" },
      h("h1", {}, m.rank === 1 && m.of > 0 && (m.score ?? 0) > 0 ? t.won : t.gameOver),
      cover,
      h("p", { class: "score" }, t.n(m.score ?? 0), h("small", {}, t.points)),
      h("p", { class: "muted" }, m.of ? t.rank(m.rank ?? 0, m.of) : ""),
      again,
      err,
      set.box,
    ),
    desk(),
  );
  refreshers.push(() => {
    again.hidden = !isVip();
    set.update();
  });
}

// ---------------------------------------------------------------------------
// Ranking: the podium

/** @param {any} m @param {any} r */
function rank(m, r) {
  const err = h("p", { class: "error" });
  const ids = /** @type {string[]} */ (r.candidates ?? []);
  const size = r.podium ?? 3;
  /** @type {string[]} */
  const podium = [];
  const you = client.you?.id;
  const file = /** @type {HTMLButtonElement} */ (h("button", { class: "btn" }, t.fileIt));
  /** @type {Map<string, HTMLElement>} */
  const cards = new Map();
  const draw = () => {
    for (const [id, el] of cards) {
      const place = podium.indexOf(id);
      el.classList.toggle("on", place >= 0);
      el.querySelector(".medal")?.remove();
      if (place >= 0) el.append(h("span", { class: `medal m${place}` }, String(place + 1)));
    }
    file.disabled = podium.length < Math.min(size, ids.length);
    file.textContent = file.disabled ? t.pickMore(Math.min(size, ids.length) - podium.length) : t.fileIt;
  };
  for (const id of ids) {
    const el = h(
      "button",
      {
        class: "cand",
        type: "button",
        onclick: () => {
          const i = podium.indexOf(id);
          if (i >= 0) podium.splice(i, 1);
          else if (podium.length < size) podium.push(id);
          buzz(10);
          draw();
        },
      },
      face(id),
      h("span", { class: "nm", "data-fit": "1" }, person(id).name),
      id === you ? h("span", { class: "tag" }, t.you) : null,
    );
    cards.set(id, el);
  }
  const send = () => act("rank", { podium }, err).catch(() => {});
  file.addEventListener("click", send);
  atDeadline(m.deadline ?? 0, () => {
    if (podium.length > 0) void send();
  });
  draw();
  buzz(30);
  show(h("section", { class: "card pop" }, clock(m.deadline ?? 0), kicker(r.question), h("p", { class: "q small" }, r.question?.text ?? ""), h("p", { class: "muted small", style: { margin: "0" } }, size === 2 ? t.rankHint2 : t.rankHint), h("div", { class: "cands" }, ...cards.values()), file, err, skipButton()), desk());
}

/** @param {any} m @param {any} r */
function ranked(m, r) {
  const podium = /** @type {string[]} */ (m.podium ?? []);
  show(
    h(
      "section",
      { class: "card pop center" },
      h("div", { class: "stamp" }, t.filed),
      h("p", { class: "deck" }, r.question?.text ?? ""),
      h("h2", { style: { "align-self": "stretch", "text-align": "left" } }, t.yourPodium),
      h("ol", { class: "podium", style: { "align-self": "stretch" } }, ...podium.map((id, i) => h("li", {}, h("span", { class: `medal m${i}` }, String(i + 1)), face(id, 40), person(id).name))),
    ),
    desk(),
  );
}

// ---------------------------------------------------------------------------
// Writing

/** @param {any} m @param {any} r */
function write(m, r) {
  const err = h("p", { class: "error" });
  const n = m.n ?? 1;
  const key = `busted:draft:${r.round}:${r.question?.text ?? ""}`;
  /** @type {string[]} */
  let drafts = [];
  try {
    drafts = JSON.parse(sessionStorage.getItem(key) ?? "[]");
  } catch {}
  const fields = Array.from({ length: n }, (_, i) => {
    const ta = /** @type {HTMLTextAreaElement} */ (h("textarea", { maxlength: MAX_ANSWER, rows: 2, enterkeyhint: "done", autocapitalize: "sentences", placeholder: n > 1 ? `${t.answer} ${i + 1}` : t.answer }));
    ta.value = drafts[i] ?? "";
    const count = h("div", { class: "count" });
    const upd = () => {
      count.textContent = `${[...ta.value].length} / ${MAX_ANSWER}`;
      try {
        sessionStorage.setItem(key, JSON.stringify(fields.map((f) => f.ta.value)));
      } catch {}
      send.disabled = fields.every((f) => !f.ta.value.trim());
    };
    ta.addEventListener("input", () => upd());
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter") e.preventDefault();
    });
    return { ta, count, upd };
  });
  const send = /** @type {HTMLButtonElement} */ (h("button", { class: "btn" }, t.send));
  const submit = () => {
    const texts = fields.map((f) => f.ta.value.trim()).filter(Boolean);
    if (texts.length === 0) return Promise.resolve();
    return act("answer", { texts }, err).catch(() => {});
  };
  send.addEventListener("click", () => void submit());
  atDeadline(m.deadline ?? 0, () => void submit());
  for (const f of fields) f.upd();
  buzz(30);
  show(
    h(
      "section",
      { class: "card pop" },
      clock(m.deadline ?? 0),
      kicker(r.question),
      h("p", { class: "q" }, r.question?.text ?? ""),
      h("p", { class: "deck" }, t.writeHint),
      h("label", {}, n > 1 ? t.writeTitle2 : t.writeTitle),
      ...fields.flatMap((f) => [f.ta, f.count]),
      send,
      err,
      skipButton(),
    ),
  );
  fields[0]?.ta.focus();
}

/** @param {any} m */
function written(m) {
  const answers = /** @type {string[]} */ (m.answers ?? []);
  show(h("section", { class: "card pop center" }, h("div", { class: "stamp" }, t.sent), h("p", { class: "deck" }, room().question?.text ?? ""), ...answers.map((a) => h("div", { class: "typed", style: { "align-self": "stretch" } }, a))), desk());
}

// ---------------------------------------------------------------------------
// Matching

/** @param {any} m @param {any} r */
function match(m, r) {
  const err = h("p", { class: "error" });
  const you = client.you?.id;
  const own = new Set(/** @type {number[]} */ (m.own ?? []));
  const cards = /** @type {{ id: number, text: string }[]} */ (r.cards ?? []);
  const authors = /** @type {string[]} */ ((r.authors ?? []).filter((/** @type {string} */ a) => a !== you));
  const per = r.per ?? 1;
  /** @type {Map<number, string>} */
  const guesses = new Map();
  /** @type {number | null} */
  let heart = null;
  const open = h("p", { class: "muted small" });
  const file = /** @type {HTMLButtonElement} */ (h("button", { class: "btn" }, t.fileGuesses));
  const used = (/** @type {string} */ a, /** @type {number} */ except) => [...guesses].filter(([c, x]) => x === a && c !== except).length;
  /** @type {Map<number, HTMLElement>} */
  const rows = new Map();
  const draw = () => {
    for (const card of cards) {
      const row = rows.get(card.id);
      if (!row) continue;
      const g = guesses.get(card.id);
      row.classList.toggle("set", !!g);
      const pick = /** @type {HTMLElement} */ (row.querySelector(".pick"));
      if (own.has(card.id)) pick.replaceChildren(t.yours);
      else pick.replaceChildren(...(g ? [face(g, 34, true), person(g).name] : [t.who]));
      const hb = row.querySelector(".heart");
      hb?.classList.toggle("on", heart === card.id);
      if (hb) hb.textContent = heart === card.id ? "♥" : "♡";
    }
    const left = cards.filter((c) => !own.has(c.id) && !guesses.has(c.id)).length;
    open.textContent = left > 0 ? t.openLeft(left) : "";
  };
  const pickFor = (/** @type {{ id: number, text: string }} */ card) => {
    const row = rows.get(card.id);
    row?.classList.add("focus");
    const close = () => {
      row?.classList.remove("focus");
      closeSheet();
    };
    openSheet(
      h("h2", {}, t.pickWriter),
      h("div", { class: "typed" }, card.text),
      h(
        "div",
        { class: "picks" },
        ...authors.map((a) => {
          const left = per - used(a, card.id);
          return h(
            "button",
            {
              type: "button",
              disabled: left <= 0,
              onclick: () => {
                guesses.set(card.id, a);
                buzz(10);
                close();
                draw();
              },
            },
            face(a, 56),
            person(a).name,
            per > 1 ? h("small", {}, `${left}×`) : null,
          );
        }),
      ),
      h(
        "div",
        { class: "row" },
        h(
          "button",
          {
            class: "btn ghost small",
            type: "button",
            onclick: () => {
              guesses.delete(card.id);
              close();
              draw();
            },
          },
          t.clear,
        ),
        h("button", { class: "btn ghost small", type: "button", onclick: close }, t.cancel),
      ),
    );
  };
  for (const card of cards) {
    const mine = own.has(card.id);
    const hb = mine
      ? null
      : h(
          "button",
          {
            class: "heart",
            type: "button",
            "aria-label": t.heart,
            onclick: (/** @type {Event} */ e) => {
              e.stopPropagation();
              heart = heart === card.id ? null : card.id;
              buzz(10);
              draw();
            },
          },
          "♡",
        );
    const row = h(
      "div",
      { class: `note${mine ? " mine" : ""}`, role: "button", onclick: () => !mine && pickFor(card) },
      h("span", { class: "num" }, String(card.id + 1)),
      h("span", { class: "txt" }, card.text),
      h("span", { class: "side" }, h("span", { class: "pick" }), hb),
    );
    rows.set(card.id, row);
  }
  const send = () => act("match", { guesses: Object.fromEntries(guesses), heart }, err).catch(() => {});
  file.addEventListener("click", () => {
    closeSheet();
    void send();
  });
  atDeadline(m.deadline ?? 0, () => {
    closeSheet();
    void send();
  });
  cleanups.push(closeSheet);
  draw();
  buzz(30);
  show(h("section", { class: "card pop" }, clock(m.deadline ?? 0), h("h1", {}, t.matchTitle), h("p", { class: "deck" }, r.question?.text ?? ""), h("p", { class: "muted small", style: { margin: "0" } }, per > 1 ? t.matchHint2(per) : t.matchHint), h("div", { class: "notes" }, ...rows.values()), open, file, err));
}

// ---------------------------------------------------------------------------
// Scores

/** @param {any} m @param {any} r */
function scoreCard(m, r) {
  const e = m.earned ?? {};
  const kinds = /** @type {const} */ (["room", "gold", "self", "guess", "fool"]);
  const gains = kinds.filter((k) => (e[k] ?? 0) > 0);
  show(
    h(
      "section",
      { class: "card pop" },
      h("h2", { style: { "border-top": "0" } }, `${t.roundN(r.round ?? 1)} · ${t.thisRound}`),
      h("p", { class: "score" }, `+${t.n(m.delta ?? 0)}`),
      gains.length ? h("ul", { class: "gains" }, ...gains.map((k) => h("li", {}, h("span", {}, t.kinds[k]), h("b", {}, `+${t.n(e[k])}`)))) : h("p", { class: "muted" }, t.nothing),
      h("p", { class: "total" }, `${t.pointsN(m.score ?? 0)} · ${m.of ? t.rank(m.rank ?? 0, m.of) : ""}`),
    ),
    desk(),
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
mark.textContent = t.masthead;
if (!client.room || !client.key) {
  show(logo(), h("section", { class: "card" }, h("p", { class: "big" }, t.scanToJoin)));
} else if (client.canResume) {
  client.connect().then(wake, (e) => joinForm(e?.code === "no-player" ? "" : message(e)));
} else {
  joinForm();
}
