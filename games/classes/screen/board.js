// @ts-check
/**
 * The blackboard's scenes: the lobby (the title, the class register, the
 * join sheet pinned on), the letter (the drawer, the running light, the
 * letter chalked huge), the board (today's subjects chalked one by one),
 * writing (the letter, the subjects, the desks with everyone's exercise
 * book filling with scribbles), the bell and the report (the points
 * added up in chalk).
 */

import { joinText, qrSvg } from "/_tvpipe/lib/client.js";
import { bell, raisedHand, scribble } from "./art.js";
import { h, jitter } from "./dom.js";
import { connected, env, keepNames, now, person, subj } from "./env.js";
import { sound } from "./sound.js";

/** @typedef {import("./screen.js").Scene} Scene */

/** A subject's coloured tab with its name. @param {string} subject */
export function tab(subject) {
  return h("span", { class: `tab s-${subj(subject)}` }, env.t.subject(subj(subject)));
}

/** The settings, chalked small: the day's timetable. @param {Record<string, any>} st */
function timetable(st) {
  const t = env.t;
  const lines = [
    t.lessons(Number(st.rounds) || 4),
    t.perLesson(Number(st.columns) || 8),
    t.writeTime(Number(st.time) || 120),
    /** @type {Record<string, string>} */ (t.mix)[st.mix] ?? t.mix.mixed,
    st.classic ? t.classic : null,
    st.stop !== false ? t.stopOn : null,
    st.content === "party" ? t.party : null,
    st.letters === "all" ? t.hard : null,
    /** @type {Record<string, string>} */ (t.late)[st.late] ?? null,
  ].filter((x) => typeof x === "string");
  return h("div", { class: "timetable" }, h("h3", {}, t.timetable), h("ul", { "data-fit": "box" }, ...lines.map((x) => h("li", {}, x))));
}

// ---- Lobby -----------------------------------------------------------------

/** @param {Record<string, any>} s @returns {Scene} */
export function lobbyScene(s) {
  const t = env.t;
  const list = h("ol", { class: "register" });
  const status = h("p", { class: "status", "data-fit": "1" });
  const qr = h("div", { class: "qr" });
  const link = h("div", { class: "link", "data-fit": "1" });
  const orType = h("div", { class: "or" }, t.orType);
  const tt = h("div", { class: "ttbox" });
  const el = h(
    "div",
    { class: "scene lobby" },
    h(
      "div",
      { class: "left" },
      h("h1", { class: "title", "data-fit": "1" }, "Classes"),
      h("p", { class: "tagline", "data-fit": "2" }, t.tagline),
      h("p", { class: "pitch", "data-fit": "2" }),
      tt,
    ),
    h("div", { class: "mid" }, h("h3", {}, t.classList), list),
    h("div", { class: "sheet" }, h("span", { class: "tape a" }), h("span", { class: "tape b" }), h("div", { class: "hd", "data-fit": "1" }, t.joinTitle), qr, h("div", { class: "scan", "data-fit": "1" }, t.scan), orType, link),
    status,
  );
  let qrKey = "";
  let count = -1;
  let ttKey = "";
  return {
    layout: "board",
    board: el,
    update(s) {
      const join = env.client?.view?.join;
      const k = JSON.stringify(join?.qr ?? null);
      if (k !== qrKey) {
        qrKey = k;
        qr.innerHTML = qrSvg(join?.qr, { dark: "#1d2a24", light: "#f7f3e8", quiet: 2 });
      }
      const lt = joinText(join) ?? "";
      if (link.textContent !== lt) link.textContent = lt;
      orType.hidden = !lt;
      link.hidden = !lt;
      const st = s.settings ?? {};
      const tk = JSON.stringify([st, env.lang]);
      if (tk !== ttKey) {
        ttKey = tk;
        tt.replaceChildren(timetable(st));
        /** @type {HTMLElement} */ (el.querySelector(".pitch")).textContent = t.pitch(Number(st.columns) || 8);
      }
      const roster = env.roster.filter((r) => !r.waiting || true);
      const key = JSON.stringify(roster.map((r) => [r.id, r.name, r.connected, r.vip]));
      if (list.dataset["key"] !== key) {
        list.dataset["key"] = key;
        if (count >= 0 && roster.length > count) sound.chalk(4);
        list.classList.toggle("two", roster.length > 6);
        list.replaceChildren(
          ...(roster.length === 0
            ? [h("li", { class: "empty" }, t.nobody)]
            : roster.map((r, i) => h("li", { class: `${r.connected === false ? "away" : ""}${i === count ? " new" : ""}`, style: { "--d": `${i === roster.length - 1 && count >= 0 ? 0 : 0}s` } }, h("span", { class: "n" }, `${i + 1}.`), h("span", { class: "nm", "data-fit": "1" }, r.name)))),
        );
        count = roster.length;
      }
      const ready = roster.filter((r) => r.connected !== false).length;
      const min = Number(s.minPlayers) || 2;
      const vip = roster.find((r) => r.vip);
      const text = ready < min ? t.needMore(min - ready) : vip ? t.vipStarts(vip.name) : "";
      if (status.textContent !== text) status.textContent = text;
    },
  };
}

// ---- The letter ------------------------------------------------------------

/** @param {Record<string, any>} s @returns {Scene} */
export function letterScene(s) {
  const t = env.t;
  const stopped = typeof s.letter === "string" && s.letter !== "";
  const drawer = s.drawer ? person(s.drawer).name : "";
  const big = h("div", { class: `bigletter${stopped ? " chalked" : ""}${stopped && /^[MW]$/.test(s.letter) ? " wide" : ""}` }, stopped ? s.letter : "");
  const el = h(
    "div",
    { class: `scene letter${stopped ? " stopped" : ""}` },
    h("div", { class: "lessonline" }, t.lesson(s.round ?? 1, s.rounds ?? 1)),
    h("h2", { class: "who", "data-fit": "2" }, ...(stopped ? [t.todays] : keepNames(t.stops(drawer)))),
    big,
    h("p", { class: "hint", "data-fit": "1" }, stopped ? t.letterIs(s.letter) : t.stopHint),
  );
  if (stopped) sound.chalkLetter();
  let shown = "";
  return {
    layout: "board",
    board: el,
    update(s) {
      if (stopped || !s.run || !Array.isArray(s.run.seq) || s.run.seq.length === 0) return;
      const step = Math.max(20, Number(s.run.step) || 110);
      const dt = now() - Number(s.run.start);
      const l = dt >= 0 ? String(s.run.seq[Math.floor(dt / step) % s.run.seq.length] ?? "") : "";
      if (l !== shown) {
        shown = l;
        big.textContent = l;
      }
    },
  };
}

// ---- The board: today's subjects ------------------------------------------

/** The letter in its chalk circle. @param {string} letter @param {string} [cls] */
function letterBox(letter, cls = "") {
  return h("div", { class: `letterbox ${cls}${/^[MW]$/.test(letter) ? " wide" : ""}` }, h("div", { class: "lbl", "data-fit": "1" }, env.t.todays), h("div", { class: "ring" }, h("span", {}, letter)));
}

/** @param {Record<string, any>} s @returns {Scene} */
export function boardScene(s) {
  const t = env.t;
  /** @type {import("./env.js").Column[]} */
  const cols = Array.isArray(s.columns) ? s.columns : [];
  const per = 2600 / Math.max(1, cols.length);
  const items = cols.map((c, i) =>
    h(
      "li",
      { class: "col", style: { "--d": `${(i * per) / 1000 + 0.15}s` } },
      h("span", { class: "num" }, `${i + 1}`),
      h(
        "div",
        { class: "body" },
        h("div", { class: "top" }, tab(c.subject), c.rule && t.rule[c.rule] ? h("span", { class: "rule", "data-fit": "1" }, t.rule[c.rule]?.(s.letter ?? "") ?? "") : null),
        h("div", { class: "text", "data-fit": "2" }, ...keepNames(c.text)),
      ),
    ),
  );
  const el = h("div", { class: "scene boardcols" }, letterBox(s.letter ?? "?"), h("ol", { class: `cols n${cols.length > 6 ? "many" : "few"}`, style: { "--rows": Math.ceil(cols.length / 2) } }, ...items));
  cols.forEach((_, i) => sound.chalk(3, (i * per) / 1000 + 0.15));
  return { layout: "board", board: el };
}

// ---- Writing: the board, the clock and the desks --------------------------

/** The board while they write: the letter, the subjects small. @param {Record<string, any>} s @param {boolean} [bellRing] */
function writeBoard(s, bellRing = false) {
  const t = env.t;
  /** @type {import("./env.js").Column[]} */
  const cols = Array.isArray(s.columns) ? s.columns : [];
  const stop = h("div", { class: "stopnote", hidden: "" });
  const el = h(
    "div",
    { class: "scene writeboard" },
    letterBox(s.letter ?? "?", "small"),
    h(
      "ol",
      { class: "mini", style: { "--rows": Math.ceil(cols.length / 2) } },
      ...cols.map((c, i) => h("li", {}, h("span", { class: `dot s-${subj(c.subject)}` }), h("span", { class: "n" }, `${i + 1}`), h("span", { class: "text", "data-fit": "1" }, ...keepNames(c.text)))),
    ),
    stop,
  );
  if (bellRing) {
    el.classList.add("ringing");
    el.append(h("div", { class: "bellnote" }, bell(), h("div", {}, h("h2", { "data-fit": "1" }, t.pensDown), h("p", { "data-fit": "1" }, t.bellSub))));
  }
  return { el, stop };
}

/**
 * Everyone's exercise book on the desks: the name on the label, a line
 * per column, a scribble on each filled one.
 * @param {Record<string, any>} s
 */
function deskRow(s) {
  const ids = /** @type {string[]} */ (Array.isArray(s.players) && s.players.length > 0 ? s.players : Object.keys(s.people ?? {}));
  const cols = Array.isArray(s.columns) ? s.columns.length : 0;
  const n = ids.length;
  const rows = n <= 5 ? 1 : 2;
  const per = Math.ceil(n / rows);
  // The desks' room: 1024 × 384, gaps 14.
  const W = Math.floor(Math.min(n <= 2 ? 360 : n <= 3 ? 300 : 250, (1024 - 14 * (per - 1)) / per));
  const H = Math.floor((384 - 14 * (rows - 1) - (rows === 1 ? 24 : 0)) / rows);
  const lineH = Math.max(9, Math.floor((H - 58) / Math.max(1, cols)));
  /** @type {Map<string, { el: HTMLElement, lines: HTMLElement[], count: HTMLElement, key: string }>} */
  const books = new Map();
  const el = h("div", { class: `desks r${rows}`, style: { "--bw": `${W}px`, "--bh": `${H}px`, "--lh": `${lineH}px`, "--per": per } });
  ids.forEach((id, i) => {
    const lines = Array.from({ length: cols }, () => h("div", { class: "line" }));
    const count = h("span", { class: "count" });
    const book = h(
      "div",
      { class: `book k${person(id).hand}`, style: { "--r": `${(jitter(`book:${id}`) * 1.6).toFixed(2)}deg`, "--d": `${(i * 0.05).toFixed(2)}s` } },
      h("div", { class: "label" }, h("span", { class: "nm", "data-fit": "1" }, person(id).name), count),
      h("div", { class: "page" }, ...lines),
    );
    el.append(book);
    books.set(id, { el: book, lines, count, key: "" });
  });
  return {
    el,
    /** @param {Record<string, any>} s */
    update(s) {
      const progress = s.progress ?? {};
      for (const [id, b] of books) {
        const p = Array.isArray(progress[id]) ? progress[id] : [];
        const away = !connected(id);
        const key = JSON.stringify([p, away, s.stopBy === id]);
        if (key === b.key) continue;
        const old = b.key ? JSON.parse(b.key)[0] : [];
        b.key = key;
        b.lines.forEach((line, c) => {
          const level = Math.max(0, Math.min(3, Number(p[c]) || 0));
          if (level === (Number(old[c]) || 0) && line.childElementCount > 0) return;
          line.replaceChildren(...(level > 0 ? [scribble(`${id}:${c}`, level, W - 34, lineH)] : []));
          if (level > 0 && old.length > 0) line.classList.add("fresh");
        });
        const filled = p.filter((x) => Number(x) > 0).length;
        b.count.textContent = env.t.filled(filled, b.lines.length);
        b.el.classList.toggle("full", filled === b.lines.length && b.lines.length > 0);
        b.el.classList.toggle("away", away);
        const hand = b.el.querySelector(".raised");
        if (s.stopBy === id && !hand) b.el.querySelector(".label")?.append(raisedHand());
      }
    },
  };
}

/** @param {Record<string, any>} s @returns {Scene} */
export function writeScene(s) {
  const t = env.t;
  const b = writeBoard(s);
  const d = deskRow(s);
  const total = (Number(s.settings?.time) || 120) * 1000;
  let stopShown = "";
  sound.chalk(2);
  return {
    layout: "write",
    board: b.el,
    desks: d.el,
    update(s) {
      d.update(s);
      const left = Number(s.deadline) - now();
      env.clock = { deadline: Number(s.deadline) || undefined, total: Math.max(total, s.stopBy ? 10_000 : 0, left), red: !!s.stopBy };
      if (s.stopBy && s.stopBy !== stopShown) {
        stopShown = s.stopBy;
        b.stop.hidden = false;
        b.el.classList.add("stopped");
        b.stop.replaceChildren(h("b", { "data-fit": "1" }, t.stopBy(person(s.stopBy).name)), h("span", { "data-fit": "1" }, t.tenLeft));
        sound.chalk(5);
      }
    },
  };
}

/** @param {Record<string, any>} s @returns {Scene} */
export function bellScene(s) {
  const b = writeBoard(s, true);
  const d = deskRow(s);
  d.update(s);
  const at = Number(s.bellAt);
  const delay = Number.isFinite(at) ? Math.max(0, (at - now()) / 1000) : 0;
  if (delay < 1.5 || !Number.isFinite(at)) sound.bell(2, delay);
  return {
    layout: "write",
    board: b.el,
    desks: d.el,
    update(s) {
      env.clock = { deadline: Number(s.deadline) || undefined, total: 1, red: true };
    },
  };
}

// ---- The report: the points added up in chalk ----------------------------

/** @param {Record<string, any>} s @returns {Scene} */
export function reportScene(s) {
  const t = env.t;
  /** @type {{ id: string, round: number, total: number, rank: number, twenties?: number }[]} */
  const scores = Array.isArray(s.scores) ? [...s.scores].sort((a, b) => a.rank - b.rank || b.total - a.total) : [];
  const n = scores.length;
  const rows = scores.map((x, i) =>
    h(
      "li",
      { class: `row${x.rank === 1 ? " first" : ""}`, style: { "--d": `${(0.3 + (n - 1 - i) * 0.28).toFixed(2)}s` } },
      h("span", { class: "rk" }, `${x.rank}.`),
      h("span", { class: "nm", "data-fit": "1" }, person(x.id).name),
      h("span", { class: "sum" }, h("span", { class: "was" }, t.n(x.total - x.round)), h("span", { class: "plus" }, `+ ${t.n(x.round)}`), h("span", { class: "eq" }, "="), h("b", {}, t.n(x.total))),
    ),
  );
  const best = Math.max(0, ...scores.map((x) => Number(x.twenties) || 0));
  const twenty = best > 0 ? t.mostTwenties(scores.filter((x) => Number(x.twenties) === best).map((x) => person(x.id).name), best) : "";
  const el = h(
    "div",
    { class: "scene report" },
    h("div", { class: "hd" }, h("h2", { "data-fit": "1" }, t.endOf(s.round ?? 1)), h("span", { class: "sub" }, t.standings)),
    h("ol", { class: "rows", style: { "--n": Math.max(n, 2) } }, ...rows),
    twenty ? h("p", { class: "twenty", "data-fit": "1" }, twenty) : null,
  );
  scores.forEach((_, i) => sound.chalk(3, 0.3 + i * 0.28));
  return { layout: "board", board: el };
}
