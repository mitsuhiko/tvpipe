// @ts-check
/**
 * Busted's TV page: tvpipe casts it with its own browser, or anyone opens
 * the watch link (the host page's preview, muted). The whole screen is a
 * gossip paper, The Daily Busted (docs/busted-design.md, "The look"): a
 * masthead, then per stage a page of it. The lobby asks for reporters
 * (the join coupon, the press photos); a vote round prints its question
 * as a headline, shows the suspects' contact sheet while they rank, counts
 * the ballots into columns of clippings and prints the winner on the
 * front page with their title; an answer round collects letters to the
 * editor, prints them anonymously in the gossip column and busts the
 * writers one note at a time; the standings; the special edition with
 * the awards and everyone's magazine cover. Players' texts are always text.
 */

import { joinText, PartyClient, qrSvg } from "/_tvpipe/lib/client.js";
import { doodle, FACE, pathOf } from "../game/face.js";
import { pickLang } from "../phone/i18n.js";
import { sound } from "./sound.js";
import { strings } from "./strings.js";

const params = new URLSearchParams(location.hash.slice(1));
const client = PartyClient.fromLocation({ role: /** @type {any} */ (params.get("role") ?? "screen"), rejoinBadge: { corner: "bottom-right" } });
const page = /** @type {HTMLElement} */ (document.getElementById("page"));
const main = /** @type {HTMLElement} */ (document.getElementById("main"));
const flashEl = /** @type {HTMLElement} */ (document.getElementById("flash"));

// The page is 1280×720 (the manifest's TV size), scaled to the window (screen.css).
function fitStage() {
  const k = Math.min(innerWidth / 1280, innerHeight / 720);
  document.documentElement.style.setProperty("--k", String(k > 0 ? k : 1));
}
fitStage();
addEventListener("resize", fitStage);

let lang = pickLang(undefined);
let t = strings(lang);

// ---------------------------------------------------------------------------
// Helpers

/**
 * @param {string} tag
 * @param {Record<string, any>} [attrs]
 * @param {...(Node | string | null | undefined | false)} kids
 * @returns {HTMLElement}
 */
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = v;
    else if (k === "style" && typeof v === "object") for (const [p, x] of Object.entries(v)) el.style.setProperty(p, String(x));
    else if (v !== false && v != null) el.setAttribute(k, String(v));
  }
  for (const kid of kids) if (kid) el.append(kid);
  return el;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** A stable pseudo-random number in [-1, 1) for a key (tilts that do not jump between views). */
function jitter(/** @type {string} */ key) {
  let x = 2166136261;
  for (let i = 0; i < key.length; i++) x = Math.imul(x ^ key.charCodeAt(i), 16777619);
  return ((x >>> 0) / 4294967296) * 2 - 1;
}

/** @returns {Record<string, any>} */
const screen = () => client.view?.screen ?? {};
/** @param {string} id @returns {{ name: string, color: string, face: number[][] | null, extra?: boolean, gone?: boolean }} */
function person(id) {
  const p = screen().people?.[id];
  return p ?? { name: "?", color: "#666", face: null };
}
const isColor = (/** @type {unknown} */ c) => typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c);
const colorOf = (/** @type {string} */ id) => (isColor(person(id).color) ? person(id).color : "#666");

/** A face as SVG: the drawn portrait, else the doodle of the name. @param {string} id */
function faceSvg(id) {
  const p = person(id);
  const strokes = Array.isArray(p.face) && p.face.length > 0 ? p.face : doodle(p.name);
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${FACE} ${FACE}`);
  svg.setAttribute("aria-hidden", "true");
  for (const s of strokes) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", pathOf(s));
    svg.append(path);
  }
  return svg;
}

/**
 * A press photo: the face on a white print with the player's colour, the name below.
 * @param {string} id
 * @param {{ size?: number, tilt?: boolean, cls?: string, tape?: boolean, caption?: string | null }} [o]
 */
function photo(id, o = {}) {
  const p = person(id);
  const tilt = o.tilt === false ? 0 : jitter(`tilt:${id}`) * 3.5;
  return h(
    "div",
    { class: `photo${p.extra ? " extra" : ""}${o.cls ? ` ${o.cls}` : ""}`, "data-id": id, style: { "--s": `${o.size ?? 120}px`, "--r": `${tilt.toFixed(2)}deg`, "--c": colorOf(id) } },
    o.tape ? h("span", { class: "tape" }) : null,
    h("div", { class: "pic" }, faceSvg(id)),
    o.caption === null ? null : h("div", { class: "cap" }, o.caption ?? p.name),
    p.extra ? h("span", { class: "ribbon" }, t.honorary) : null,
  );
}

/** A round face. @param {string} id @param {number} [size] */
function mini(id, size) {
  return h("span", { class: "mini", style: { "--c": colorOf(id), ...(size ? { "--s": `${size}px` } : {}) }, title: person(id).name }, faceSvg(id));
}

/** @param {string} text @param {string} [cls] @param {string} [r] */
function stamp(text, cls = "", r = "-12deg") {
  return h("div", { class: `stamp ${cls}`, style: { "--r": r } }, text);
}

/**
 * Makes text as big as its box takes: from `max` px down, until it fits
 * (height and width). Words are never broken.
 * @param {HTMLElement} el @param {number} max @param {number} [min]
 */
function fitBox(el, max, min = 14) {
  const run = () => {
    let size = max;
    el.style.fontSize = `${size}px`;
    let guard = 60;
    while (guard-- > 0 && size > min && (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1)) {
      size = Math.max(min, size * 0.94);
      el.style.fontSize = `${size.toFixed(1)}px`;
    }
  };
  requestAnimationFrame(run);
  void document.fonts?.ready.then(run);
}

/**
 * One line as big as its box is wide: from `max` px down until it fits.
 * @param {HTMLElement} el @param {number} max @param {number} [min]
 */
function fitWidth(el, max, min = 14) {
  const run = () => {
    el.style.fontSize = `${max}px`;
    const w = el.scrollWidth;
    const room = el.clientWidth;
    if (w > room && w > 0) el.style.fontSize = `${Math.max(min, (max * room) / w) * 0.98}px`;
  };
  requestAnimationFrame(run);
  void document.fonts?.ready.then(run);
}

/** @param {number} ms */
function mmss(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The clock: "goes to press in 0:23"; red with ticks in the last five seconds. */
function clock() {
  const b = h("b", {}, "0:00");
  const el = h("div", { class: "clock" }, h("small", {}, t.press), b);
  let lastSec = -1;
  return {
    el,
    /** @param {number} deadline */
    update(deadline) {
      const left = deadline - client.now();
      b.textContent = mmss(left);
      const sec = Math.ceil(left / 1000);
      el.classList.toggle("low", left > 0 && left <= 5000);
      if (sec !== lastSec) {
        if (sec <= 5 && sec > 0 && lastSec !== -1) sound.tick();
        if (sec === 0 && lastSec > 0) sound.ding();
        lastSec = sec;
      }
    },
  };
}

function flash() {
  flashEl.classList.remove("on");
  void flashEl.offsetWidth;
  flashEl.classList.add("on");
}

// ---------------------------------------------------------------------------
// The masthead

const mast = h(
  "header",
  { class: "mast" },
  h("div", { class: "row" }, h("div", { class: "ear left", id: "earL" }), h("h1", { id: "title" }), h("div", { class: "ear right", id: "earR" })),
  h("div", { class: "dateline" }, h("span", { id: "issue" }), h("span", { class: "motto", id: "motto" }), h("span", { id: "date" })),
);
page.prepend(mast);

/** @param {Record<string, any>} s */
function masthead(s) {
  const set = (/** @type {string} */ id, /** @type {(Node | string)[]} */ ...kids) => /** @type {HTMLElement} */ (document.getElementById(id)).replaceChildren(...kids);
  set("title", t.masthead);
  set("motto", t.motto);
  set("date", `${t.date()} · ${t.edition}`);
  set("issue", t.issue(Math.max(1, s.round ?? 1)));
  const playing = s.phase === "round" || s.phase === "scores";
  set("earL", h("b", {}, playing ? t.roundOf(s.round ?? 1, s.rounds ?? 1) : s.phase === "final" ? t.special : t.tonight), t.price);
  const readers = Object.values(s.people ?? {}).filter((p) => !p.extra && !p.gone).length;
  set("earR", h("b", {}, t.readers(readers)), t.weather);
}

// ---------------------------------------------------------------------------
// Scenes: each built once per key, then updated on every view and tick

/** @type {string} */
let sceneKey = "";
/** @type {((s: Record<string, any>) => void) | null} */
let update = null;

/** Names on photos, covers and envelopes are read whole: smaller until they fit their line. */
const LABELS = ".cap, .nm, .env .who, .slip .from, .award b";
/** @param {ParentNode} root */
function shrinkLabels(root) {
  const run = () => {
    for (const el of /** @type {NodeListOf<HTMLElement>} */ (root.querySelectorAll(LABELS))) {
      el.style.fontSize = "";
      const w = el.scrollWidth;
      const room = el.clientWidth;
      if (w > room + 1 && room > 0) el.style.fontSize = `${(parseFloat(getComputedStyle(el).fontSize) * room) / w * 0.97}px`;
    }
  };
  requestAnimationFrame(run);
  void document.fonts?.ready.then(run);
}

/** @param {HTMLElement} el @param {((s: Record<string, any>) => void) | null} [up] */
function showScene(el, up = null) {
  main.replaceChildren(el);
  update = up;
  shrinkLabels(el);
}

// ---- Lobby -----------------------------------------------------------------

function lobby() {
  const qr = h("div", { class: "qr" });
  const link = h("div", { class: "link" });
  const staff = h("div", { class: "staff" });
  const note = h("p", { class: "lobbynote" });
  const orType = h("div", { class: "or" }, t.orType);
  const inbox = h("span", { class: "kicker yellow inbox" });
  const el = h(
    "div",
    { class: "scene lobby" },
    h("div", { class: "top" }, h("div", {}, h("span", { class: "kicker" }, t.extra), h("h2", { class: "hl" }, t.wanted)), h("p", { class: "deck" }, t.lobbyDeck)),
    h(
      "div",
      { class: "cols" },
      h("div", {}, h("div", { class: "coupon" }, h("div", { class: "clip" }, t.clip), qr, orType, link), note, inbox),
      h("div", {}, h("div", { class: "section" }, t.staff), staff),
      h("div", { class: "how" }, h("div", { class: "section" }, t.howTitle), h("ol", {}, ...t.how.map(([a, b]) => h("li", {}, h("b", {}, a ?? ""), h("span", {}, b ?? ""))))),
    ),
  );
  let shown = "";
  let count = -1;
  showScene(el, (s) => {
    const join = client.view?.join;
    const qrKey = JSON.stringify(join?.qr ?? null);
    if (qrKey !== shown) {
      shown = qrKey;
      qr.innerHTML = qrSvg(join?.qr, { dark: "#161513", light: "#fffdf6" });
    }
    link.textContent = joinText(join) ?? "";
    orType.hidden = !link.textContent;
    const roster = /** @type {any[]} */ (client.view?.roster ?? []);
    const ids = [...roster.map((r) => r.id), ...(s.extras ?? [])];
    if (ids.length > count && count >= 0) sound.join();
    const key = JSON.stringify([ids, roster.map((r) => r.connected), ids.map((id) => person(id).face?.length ?? 0)]);
    if (staff.dataset["key"] !== key) {
      staff.dataset["key"] = key;
      const size = ids.length <= 4 ? 140 : ids.length <= 6 ? 122 : ids.length <= 8 ? 108 : ids.length <= 10 ? 92 : 82;
      staff.replaceChildren(...(ids.length === 0 ? [h("p", { class: "empty" }, t.noStaff)] : ids.map((id, i) => {
        const r = roster.find((x) => x.id === id);
        const el = photo(id, { size, cls: `drop${r && !r.connected ? " away" : ""}` });
        el.style.setProperty("--d", `${i * 0.04}s`);
        return el;
      })));
      shrinkLabels(staff);
    }
    count = ids.length;
    const ready = roster.filter((r) => r.connected).length;
    const min = s.minPlayers ?? 3;
    note.textContent = ready < min ? t.needMore(min - ready) : t.ready;
    const tips = s.tips?.approved ?? 0;
    inbox.hidden = tips + (s.tips?.pending ?? 0) === 0;
    inbox.textContent = t.inbox(tips + (s.tips?.pending ?? 0));
  });
}

// ---- A round's front page: the question ----------------------------------

/** @param {Record<string, any>} q */
function kicker(q) {
  if (q?.by) return h("span", { class: "kicker yellow" }, t.readerQ(q.by.name ?? ""));
  return h("span", { class: q?.kind === "answer" ? "kicker black" : "kicker" }, q?.kind === "answer" ? t.askRoom : t.poll);
}

/** The headline: the question, as big as its box takes. @param {Record<string, any>} q @param {number} max */
function headline(q, max) {
  const span = h("span", {}, q?.text ?? "");
  const el = h("h2", { class: "hl q fitbox" }, span);
  fitBox(el, max, 22);
  return el;
}

/** @param {Record<string, any>} s */
function ask(s) {
  const q = s.question ?? {};
  const isVote = s.kind === "vote";
  const ids = isVote ? (s.candidates ?? []) : players(s);
  const size = ids.length <= 6 ? 110 : ids.length <= 10 ? 86 : 72;
  const el = h(
    "div",
    { class: "scene front" },
    h(
      "div",
      { class: "head spin" },
      h("div", { class: "row" }, kicker(q), h("span", { class: "byline" }, t.roundOf(s.round ?? 1, s.rounds ?? 1))),
      headline(q, 92),
      h("p", { class: "deck hint" }, isVote ? (s.podium === 2 ? t.rankHint2 : t.rankHint) : s.per > 1 ? t.answerHint2(s.per) : t.answerHint),
    ),
    h("div", { class: "strip" }, h("div", { class: "section" }, isVote ? t.suspects : t.staff), h("div", { class: "faces" }, ...ids.map((/** @type {string} */ id, /** @type {number} */ i) => {
      const p = photo(id, { size, cls: "rise" });
      p.style.setProperty("--d", `${0.6 + i * 0.05}s`);
      return p;
    }))),
  );
  sound.press();
  showScene(el);
}

/** Players of the round: everyone named who is not an honorary candidate (nor gone). @param {Record<string, any>} s */
function players(s) {
  return Object.entries(s.people ?? {})
    .filter(([, p]) => !p.extra && !p.gone)
    .map(([id]) => id);
}

// ---- Ranking: the contact sheet ------------------------------------------

/** @param {Record<string, any>} s */
function rank(s) {
  const q = s.question ?? {};
  const ids = /** @type {string[]} */ (s.candidates ?? []);
  const n = ids.length;
  const size = n <= 4 ? 170 : n <= 6 ? 150 : n <= 8 ? 128 : n <= 10 ? 112 : 96;
  const c = clock();
  const photos = new Map(ids.map((id) => [id, photo(id, { size })]));
  const el = h(
    "div",
    { class: "scene front rank" },
    h("div", { class: "head" }, h("div", { class: "row" }, kicker(q)), headline(q, 56), h("p", { class: "deck hint" }, s.podium === 2 ? t.rankHint2 : t.rankHint)),
    h("div", { class: "clockbox" }, c.el),
    h("div", { class: "sheet" }, ...photos.values()),
  );
  const stamped = new Set();
  showScene(el, (s) => {
    c.update(s.deadline ?? 0);
    for (const id of s.done ?? []) {
      if (stamped.has(id)) continue;
      stamped.add(id);
      const p = photos.get(id);
      if (!p) continue;
      const st = stamp(t.filed, "", `${(-14 + jitter(`f:${id}`) * 8).toFixed(1)}deg`);
      st.style.setProperty("--fs", `${Math.round(size * 0.2)}px`);
      st.style.left = "6%";
      st.style.top = "34%";
      p.append(st);
      sound.stamp();
    }
  });
}

// ---- The count -----------------------------------------------------------

/** @param {Record<string, any>} s */
function count(s) {
  const q = s.question ?? {};
  const ballots = /** @type {{ from?: string, podium: string[] }[]} */ (s.ballots ?? []);
  const ids = /** @type {string[]} */ (s.candidates ?? []);
  const res = s.result ?? {};
  const max = Math.max(3, ...Object.values(res.points ?? {}).map(Number));
  const n = ids.length;
  const room = 1224 - 340 - 150;
  const bw = Math.min(110, Math.floor((room - 10 * (n - 1)) / Math.max(1, n)));
  const unit = Math.max(2, Math.floor((330 - 40) / max));
  /** @type {Map<string, { el: HTMLElement, stack: HTMLElement, pts: HTMLElement, n: number }>} */
  const bars = new Map();
  for (const id of ids) {
    const stack = h("div", { class: "stack" });
    const pts = h("div", { class: "pts" }, "0");
    const el = h("div", { class: "bar", style: { "--bw": `${bw}px`, "--u": `${unit}px` } }, pts, stack, photo(id, { size: Math.min(96, bw), tilt: false }));
    bars.set(id, { el, stack, pts, n: 0 });
  }
  const slip = h("div", { class: "slip" });
  const el = h(
    "div",
    { class: "scene front count" },
    h("div", { class: "head" }, h("div", { class: "row" }, h("span", { class: "kicker black" }, t.count)), headline(q, 38)),
    slip,
    h("div", { class: "bars" }, ...[...bars.values()].map((b) => b.el)),
  );
  let shown = 0;
  let done = false;
  const drawSlip = (/** @type {number} */ i) => {
    const b = ballots[i];
    if (!b) {
      slip.replaceChildren(h("div", { class: "no" }, t.noBallots));
      return;
    }
    slip.classList.remove("in");
    void slip.offsetWidth;
    slip.classList.add("in");
    slip.replaceChildren(
      h("div", { class: "no" }, t.ballot(i + 1, ballots.length)),
      h("div", { class: "from" }, ...(b.from ? [mini(b.from, 44), person(b.from).name] : [h("span", { class: "secret" }, t.secretBallot)])),
      h("ol", {}, ...b.podium.map((id, place) => h("li", {}, h("span", { class: `medal m${place}` }, String(place + 1)), person(id).name, h("small", {}, `+${3 - place}`)))),
    );
  };
  if (ballots.length === 0) drawSlip(0);
  showScene(el, (s) => {
    const start = s.start ?? 0;
    const per = s.per ?? 1000;
    const k = Math.max(0, Math.min(ballots.length, Math.floor((client.now() - start) / per) + 1));
    while (shown < k) {
      const b = ballots[shown];
      drawSlip(shown);
      b?.podium.forEach((id, place) => {
        const bar = bars.get(id);
        if (!bar) return;
        const pts = 3 - place;
        bar.n += pts;
        bar.stack.append(h("div", { class: `blk m${place}`, style: { "--n": pts } }));
        bar.pts.textContent = String(bar.n);
      });
      sound.tally(shown % 5);
      shown++;
      if (shown === ballots.length) sound.drumroll(1.1);
    }
    if (!done && shown >= ballots.length && client.now() > start + per * ballots.length + 1100) {
      done = true;
      const winners = /** @type {string[]} */ (res.winners ?? []);
      for (const [id, b] of bars) {
        b.el.classList.toggle("win", winners.includes(id));
        b.el.classList.toggle("lose", winners.length > 0 && !winners.includes(id) && !(res.top ?? []).includes(id));
      }
    }
  });
}

// ---- The front page with the title ----------------------------------------

/** @param {Record<string, any>} s */
function titlePage(s) {
  const q = s.question ?? {};
  const winners = /** @type {{ id: string, points: number, golds: number }[]} */ (s.winners ?? []);
  const names = winners.map((w) => person(w.id).name);
  const el = h("div", { class: "scene titlepage" });
  if (winners.length === 0) {
    el.append(h("span", { class: "kicker black" }, t.noComment), h("div", { class: "story", style: { left: "0" } }, h("div", { class: "name" }, t.noComment), h("p", { class: "silent" }, t.silent)));
    showScene(el);
    return;
  }
  const size = winners.length === 1 ? 300 : winners.length === 2 ? 190 : 140;
  const nameEl = h("div", { class: "name" }, names.join(" & "));
  const titleEl = h("div", { class: "title fitbox" }, s.title ?? q.title ?? "");
  const golds = winners.reduce((a, w) => a + w.golds, 0);
  el.append(
    h("span", { class: "kicker" }, winners.length > 1 ? `${t.exclusive} · ${t.shared}` : t.exclusive),
    h("div", { class: "who" }, ...winners.map((w) => photo(w.id, { size, tape: true, cls: "drop" }))),
    h(
      "div",
      { class: "story" },
      nameEl,
      titleEl,
      h(
        "div",
        { class: "article" },
        h("p", {}, t.asked(q.text ?? "")),
        h("p", {}, t.sources(winners.length === 1 ? (winners[0]?.golds ?? 0) : golds, s.voters ?? 0)),
        h("p", { class: "medals" }, h("span", { class: "medal m0" }, "1"), `× ${golds}`, h("span", {}, "·"), t.points(winners[0]?.points ?? 0)),
        h("p", { class: "byline" }, `${t.pictured} ${t.list(names)}, ${t.pictureNote}`),
      ),
    ),
  );
  fitWidth(nameEl, 150, 40);
  fitBox(titleEl, 70, 26);
  showScene(el);
  flash();
  sound.shutter();
  setTimeout(() => sound.fanfare(), 250);
}

// ---- Writing: letters to the editor --------------------------------------

/** @param {Record<string, any>} s */
function write(s) {
  const q = s.question ?? {};
  const ids = players(s);
  const c = clock();
  const envs = new Map(ids.map((id) => [id, h("div", { class: "env" }, h("div", { class: "body" }), mini(id), h("div", { class: "who" }, person(id).name))]));
  const tally = h("span", { class: "byline" });
  const el = h(
    "div",
    { class: "scene front write" },
    h("div", { class: "head" }, h("div", { class: "row" }, kicker(q)), headline(q, 56)),
    h("div", { class: "clockbox" }, c.el),
    h("div", { class: "section", style: { position: "absolute", left: "0", right: "0", top: "150px" } }, t.letters, h("small", {}, tally)),
    h("div", { class: "letters" }, ...envs.values()),
  );
  const seen = new Set();
  showScene(el, (s) => {
    c.update(s.deadline ?? 0);
    const done = /** @type {string[]} */ (s.done ?? []);
    for (const id of done) {
      if (seen.has(id)) continue;
      seen.add(id);
      envs.get(id)?.classList.add("in");
      sound.letter();
    }
    tally.textContent = t.inOf(done.length, ids.length);
  });
}

// ---- The gossip column ---------------------------------------------------

/** @param {Record<string, any>} s */
function board(s) {
  const q = s.question ?? {};
  const cards = /** @type {{ id: number, text: string }[]} */ (s.cards ?? []);
  const matching = s.stage === "match";
  const c = clock();
  const ids = players(s);
  const minis = new Map(ids.map((id) => [id, mini(id)]));
  const notes = cards.map((card, i) => {
    const txt = h("div", { class: "txt fitbox" }, card.text);
    const n = h("div", { class: "note rise", style: { "--d": `${i * 0.08}s` } }, h("span", { class: "num" }, String(card.id + 1)), txt);
    return { n, txt };
  });
  const grid = h("div", { class: `notes${cards.length <= 3 ? " one" : ""}` }, ...notes.map((x) => x.n));
  const el = h(
    "div",
    { class: `scene board${matching ? " match" : ""}` },
    h("div", { class: "colhead" }, h("div", { class: "section" }, t.column), h("p", { class: "deck" }, q.text ?? "")),
    h("div", { class: "side" }, c.el, h("p", { class: "hint" }, matching ? t.matchHint : t.columnHint), matching ? h("div", { class: "filed" }, h("span", { class: "byline" }, t.guesses), h("div", { class: "faces" }, ...minis.values())) : null),
    grid,
  );
  showScene(el, (s) => {
    c.update(s.deadline ?? 0);
    if (matching) {
      const done = new Set(s.done ?? []);
      for (const [id, m] of minis) {
        m.classList.toggle("ok", done.has(id));
        m.classList.toggle("wait", !done.has(id));
      }
    }
  });
  const rows = Math.ceil(cards.length / (cards.length <= 3 ? 1 : 2));
  const max = rows <= 2 ? 40 : rows <= 3 ? 34 : rows <= 4 ? 29 : 25;
  for (const x of notes) fitBox(x.txt, max, 14);
  if (!matching) sound.rustle();
}

// ---- The reveal: busted, one note at a time ---------------------------------

/** @param {Record<string, any>} s */
function reveal(s) {
  const r = s.reveal ?? { items: [], start: 0, per: 5000 };
  const items = /** @type {any[]} */ (r.items ?? []);
  const authors = [...new Set(/** @type {string[]} */ (s.authors ?? items.map((x) => x.author)))];
  const n = authors.length;
  const size = n <= 3 ? 140 : n <= 4 ? 108 : n <= 6 ? 104 : n <= 8 ? 92 : 80;
  const left = h("div", { class: "big" });
  const sus = new Map(authors.map((id) => [id, { el: h("div", { class: "sus", style: { "--s": `${size}px` } }, photo(id, { size })), votes: h("div", { class: "votes" }) }]));
  for (const x of sus.values()) x.el.append(x.votes);
  const progress = h("div", { class: "progress" }, ...items.map((_, i) => h("span", {}, String(i + 1))));
  const el = h(
    "div",
    { class: "scene reveal" },
    left,
    h("div", { class: "suspects" }, h("div", { class: "section" }, t.whoWrote), h("div", { class: "grid" }, ...[...sus.values()].map((x) => x.el))),
    progress,
  );
  let at = -1;
  let phase = -1;
  let landed = -1;
  showScene(el, (s) => {
    const rr = s.reveal ?? r;
    const now = client.now() - (rr.start ?? 0);
    const per = rr.per ?? 5000;
    const i = Math.max(0, Math.min(items.length - 1, Math.floor(now / per)));
    const into = now - i * per;
    const p = now < 0 ? -1 : into < per * 0.22 ? 0 : into < per * 0.5 ? 1 : 2;
    const it = items[i];
    if (!it) return;
    if (i !== at) {
      at = i;
      phase = -1;
      [...progress.children].forEach((c, k) => {
        c.className = k < i ? "done" : k === i ? "now" : "";
      });
      left.className = "big in";
      left.replaceChildren(h("span", { class: "no" }, `${t.no(it.card.id + 1)} · ${t.tip(i + 1, items.length)}`), h("div", { class: "txt fitbox" }, it.card.text));
      fitBox(/** @type {HTMLElement} */ (left.querySelector(".txt")), 44, 18);
      for (const x of sus.values()) {
        x.votes.replaceChildren();
        x.el.classList.remove("author", "other");
      }
      sound.rustle();
    }
    if (p <= phase) return;
    phase = p;
    if (p >= 1 && landed !== i) {
      landed = i;
      // The guesses land on the suspects.
      const guesses = /** @type {[string, string][]} */ (it.guesses ?? []);
      guesses.forEach(([g, to], k) => {
        const m = mini(g, 28);
        m.style.setProperty("--d", `${k * 0.08}s`);
        sus.get(to)?.votes.append(m);
      });
      if (guesses.length) sound.key();
    }
    if (p >= 2) {
      for (const [id, x] of sus) {
        x.el.classList.toggle("author", id === it.author);
        x.el.classList.toggle("other", id !== it.author);
      }
      const clipped = h("div", { class: "clipped" }, photo(it.author, { size: 120, tilt: false }));
      const guessed = (it.right ?? 0) + (it.wrong ?? 0);
      const st = guessed === 0 ? stamp(t.noGuess, "black", "-6deg") : it.busted ? stamp(t.busted, "", "-10deg") : stamp(t.gotAway, "blue", "-8deg");
      left.append(clipped, st);
      if (it.hearts > 0) left.append(h("div", { class: "hearts" }, `${"♥".repeat(Math.min(5, it.hearts))}${it.hearts > 5 ? ` ${it.hearts}` : ""}`));
      flash();
      sound.shutter();
      setTimeout(() => sound.stamp(), 120);
      if (it.hearts > 0) setTimeout(() => sound.chime(), 500);
    }
  });
}

// ---- Standings -----------------------------------------------------------

/** @param {Record<string, any>} e */
function why(e) {
  if (!e) return "";
  const de = lang === "de";
  if (e.kind === "vote") {
    const parts = [];
    if (e.room) parts.push(de ? `+${e.room} Runde gelesen` : `+${e.room} read the room`);
    if (e.gold) parts.push(de ? `+${e.gold} Gold getroffen` : `+${e.gold} gold on the winner`);
    if (e.self) parts.push(de ? `+${e.self} selbstkritisch` : `+${e.self} self-aware`);
    return parts.join(" · ");
  }
  const parts = [];
  if (e.guess) parts.push(de ? `+${e.guess} richtig geraten` : `+${e.guess} guessed right`);
  if (e.fool) parts.push(de ? `+${e.fool} getäuscht` : `+${e.fool} fooled`);
  return parts.join(" · ");
}

/** @param {Record<string, any>} s */
function scores(s) {
  const lines = /** @type {any[]} */ (s.lines ?? []);
  let rank = 0;
  let prev = NaN;
  const rows = lines.map((l, i) => {
    if (l.score !== prev) rank = i + 1;
    prev = l.score;
    return h(
      "tr",
      { style: { "--d": `${i * 0.06}s` } },
      h("td", { class: "rk" }, String(rank)),
      h("td", { class: "nm" }, mini(l.id), l.name),
      h("td", { class: "why" }, why(l.earned)),
      h("td", { class: "dl" }, l.delta > 0 ? `+${l.delta}` : ""),
      h("td", { class: "sc" }, String(l.score)),
    );
  });
  const el = h(
    "div",
    { class: "scene scores" },
    h("span", { class: "kicker black" }, t.afterRound(s.round ?? 1)),
    h("h2", { class: "hl" }, t.standings),
    h("table", { style: { "--rows": lines.length } }, h("tbody", {}, ...rows)),
    h("div", { class: "next" }, h("span", { class: "kicker" }, s.last ? t.special : t.roundOf((s.round ?? 1) + 1, s.rounds ?? 1)), h("b", {}, s.last ? t.lastRound : s.next === "answer" ? t.nextAnswer : t.nextVote)),
  );
  showScene(el);
  sound.rustle();
}

// ---- The special edition -------------------------------------------------

/** @param {Record<string, any>} s */
function final(s) {
  const lines = /** @type {any[]} */ (s.lines ?? []);
  const covers = /** @type {{ id: string, titles: string[], quote: string | null, hearts: number }[]} */ (s.covers ?? []);
  const awards = s.awards ?? {};
  const top = lines[0];
  const pageA = h(
    "div",
    { class: "scene final" },
    h("span", { class: "kicker" }, t.special),
    h("h2", { class: "hl" }, top && awards.knows ? t.knows(top.name) : t.noWinner),
    h(
      "div",
      { class: "left" },
      h(
        "table",
        { style: { "--rows": lines.length } },
        h(
          "tbody",
          {},
          ...lines.map((l, i) => h("tr", {}, h("td", {}, `${i + 1}.`), h("td", {}, mini(l.id), l.name), h("td", { class: "sc" }, String(l.score)))),
        ),
      ),
    ),
    h(
      "div",
      { class: "awards" },
      ...Object.entries(awards)
        .filter(([, a]) => a)
        .map(([k, a], i) =>
          h(
            "div",
            { class: "award", style: { "--d": `${0.4 + i * 0.15}s` } },
            mini(a.id),
            h("div", {}, h("small", {}, /** @type {any} */ (t.awards)[k] ?? k), h("b", {}, person(a.id).name), h("span", {}, t.awardLine(k, a.n))),
          ),
        ),
    ),
  );
  const n = covers.length;
  const cw = n <= 4 ? 210 : n <= 6 ? 180 : n <= 10 ? 158 : n <= 12 ? 148 : 138;
  const coverEls = covers.map((c) => {
    const p = person(c.id);
    const lines = [
      ...c.titles.slice(0, 3).map((x, i) => h("span", { class: i === 0 ? "first" : "" }, x)),
      c.titles.length === 0 ? h("em", {}, t.noTitles) : null,
      c.quote ? h("q", {}, c.quote) : null,
    ];
    return h(
      "div",
      { class: `cover${p.extra ? " extra" : ""}`, style: { "--c": colorOf(c.id), "--cw": `${cw}px` } },
      h("div", { class: "cm" }, t.coverMast),
      h("div", { class: "face" }, faceSvg(c.id)),
      h("div", { class: "nm" }, p.name),
      h("div", { class: "lines" }, ...lines),
    );
  });
  const pageB = h("div", { class: "scene final" }, h("span", { class: "kicker" }, t.special), h("div", { class: "section", style: { "margin-top": "8px" } }, t.newsstand, h("small", {}, t.finalDeck)), h("div", { class: "stand" }, ...coverEls));
  let shownPage = "";
  let hot = -1;
  const start = client.now();
  showScene(pageA, () => {
    const el = client.now() - start;
    const cycle = 26_000;
    const which = el % cycle < 10_000 ? "a" : "b";
    if (which !== shownPage) {
      shownPage = which;
      main.replaceChildren(which === "a" ? pageA : pageB);
      shrinkLabels(main);
      sound.rustle();
    }
    if (which === "b" && coverEls.length > 0) {
      const i = Math.floor(((el % cycle) - 10_000) / 2600) % coverEls.length;
      if (i !== hot) {
        hot = i;
        coverEls.forEach((c, k) => c.classList.toggle("hot", k === i));
        sound.shutter();
      }
    }
  });
  sound.fanfare();
}

// ---------------------------------------------------------------------------

/** @param {Record<string, any>} s */
function keyOf(s) {
  if (s.phase === "round") return `round:${s.round}:${s.stage}:${s.question?.text ?? ""}`;
  if (s.phase === "scores") return `scores:${s.round}`;
  return String(s.phase ?? "");
}

/** @param {Record<string, any>} view */
function render(view) {
  const s = view.screen ?? {};
  const l = pickLang(s.lang);
  if (l !== lang) {
    lang = l;
    t = strings(l);
    document.documentElement.lang = l;
    sceneKey = "";
  }
  masthead(s);
  client.joinVisible = s.phase === "lobby";
  const key = keyOf(s);
  if (key !== sceneKey) {
    sceneKey = key;
    update = null;
    if (s.phase === "lobby") lobby();
    else if (s.phase === "scores") scores(s);
    else if (s.phase === "final") final(s);
    else if (s.phase === "round") {
      if (s.stage === "ask") ask(s);
      else if (s.stage === "rank") rank(s);
      else if (s.stage === "count") count(s);
      else if (s.stage === "title") titlePage(s);
      else if (s.stage === "write") write(s);
      else if (s.stage === "board" || s.stage === "match") board(s);
      else if (s.stage === "reveal") reveal(s);
    }
  }
  update?.(s);
}

client.on("view", (view) => render(view));
setInterval(() => {
  if (update) update(screen());
}, 100);
await client.connect();
