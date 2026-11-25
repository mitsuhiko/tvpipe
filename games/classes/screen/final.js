// @ts-check
/**
 * The end of the school day: the report cards one by one (from the last
 * place to the first: the name, a grade per subject, the teacher's
 * remarks, the stamp), then all of them on the desk, then the best
 * answers of the day pinned on the cork board; then the desk and the
 * cork board take turns until the next game.
 */

import { pin, star } from "./art.js";
import { h, jitter } from "./dom.js";
import { env, handOf, keepNames, now, person, subj } from "./env.js";
import { sound } from "./sound.js";

/** @typedef {import("./screen.js").Scene} Scene */
/** @typedef {{ id: string, rank: number, total: number, grades: { subject: string, grade: string }[], remarks: string[], stamp: string }} Card */
/** @typedef {{ id: string, text: string, column: string, subject: string, stars: number }} Best */

const ONE = 3.6;
const DESK = 10;
const CORK = 12;

/** The stamp. @param {string} kind @param {string} [cls] */
function stampEl(kind, cls = "") {
  const t = env.t;
  const held = kind === "held";
  return h("div", { class: `stamp ${held ? "held" : "promoted"} ${cls}`, style: { "--r": `${held ? -9 : -14}deg` } }, h("span", { "data-fit": "1" }, held ? t.stamp.held : t.stamp.promoted));
}

/** A report card, big. @param {Card} c @param {number} n */
function bigCard(c, n) {
  const t = env.t;
  const grades = Array.isArray(c.grades) ? c.grades : [];
  const today = new Date(now());
  // The school year starts after the summer.
  const year = today.getFullYear() - (today.getMonth() < 7 ? 1 : 0);
  const remarks = (Array.isArray(c.remarks) ? c.remarks : []).slice(0, 2).map((r) => t.remark(r));
  return h(
    "div",
    { class: "rcard big", style: { "--r": `${(jitter(`card:${c.id}`) * 1.2).toFixed(2)}deg` } },
    h("div", { class: "top" }, h("span", { class: "school", "data-fit": "1" }, t.school), h("span", { class: "year" }, t.year(year))),
    h("h2", {}, t.reportCard),
    h(
      "div",
      { class: "who" },
      h("span", { class: "lbl" }, `${t.name}:`),
      h("span", { class: "nm", "data-fit": "1" }, person(c.id).name),
      h("span", { class: "rank" }, h("b", {}, t.rankOf(c.rank, n)), h("span", {}, t.points(c.total))),
    ),
    h(
      "div",
      { class: `grades${grades.length > 8 ? " many" : ""}` },
      ...grades.map((g) =>
        h(
          "div",
          { class: "g" },
          h("span", { class: `sw s-${subj(g.subject)}` }),
          h("span", { class: "sub", "data-fit": "1" }, t.subject(subj(g.subject))),
          h("span", { class: "dots" }),
          h("span", { class: "word" }, t.gradeWord(String(g.grade))),
          h("b", { class: "gr" }, String(g.grade)),
        ),
      ),
    ),
    h("div", { class: "remarks" }, h("span", { class: "lbl" }, `${t.remarksTitle}:`), h("span", { class: "txt", "data-fit": "2" }, remarks.join(". ") + (remarks.length ? "." : ""))),
    h("div", { class: "sign" }, h("span", { class: "sig" }, t.signature), h("span", { class: "lbl" }, t.teacher)),
    stampEl(c.stamp, "thump"),
  );
}

/** A report card on the desk, small. @param {Card} c @param {number} n @param {number} i */
function smallCard(c, n, i) {
  const t = env.t;
  const grades = Array.isArray(c.grades) ? c.grades : [];
  const remark = (Array.isArray(c.remarks) ? c.remarks : []).slice(0, 1).map((r) => t.remark(r))[0] ?? "";
  return h(
    "div",
    { class: `rcard small${c.rank === 1 ? " first" : ""}`, style: { "--r": `${(jitter(`small:${c.id}`) * 2.5).toFixed(2)}deg`, "--d": `${(i * 0.08).toFixed(2)}s` } },
    h("div", { class: "nm", "data-fit": "1" }, person(c.id).name),
    h("div", { class: "rank", "data-fit": "1" }, `${t.rankOf(c.rank, n)} · ${t.points(c.total)}`),
    h("div", { class: "chips" }, ...grades.map((g) => h("span", { class: `gchip s-${subj(g.subject)}` }, String(g.grade)))),
    h("div", { class: "rm", "data-fit": "box" }, remark),
    stampEl(c.stamp, "mini"),
  );
}

/** An index card with one of the best answers. @param {Best} b @param {number} i */
function indexCard(b, i) {
  const n = Math.max(1, Math.min(5, Number(b.stars) || 1));
  return h(
    "div",
    { class: "icard", style: { "--r": `${(jitter(`best:${i}:${b.text}`) * 3).toFixed(2)}deg`, "--d": `${(0.3 + i * 0.35).toFixed(2)}s` } },
    pin(["#d23b30", "#2f6fd0", "#2f9a4a", "#e0a020", "#8a4fc0", "#e05a8a"][i % 6] ?? "#d23b30"),
    h("div", { class: "col" }, h("span", { class: `sw s-${subj(b.subject)}` }), h("span", { class: "ct", "data-fit": "2" }, ...keepNames(String(b.column ?? "")))),
    h("div", { class: `ans ${handOf(b.id)}`, "data-fit": "box" }, String(b.text ?? "")),
    h("div", { class: "by", "data-fit": "1" }, `– ${person(b.id).name}`),
    h("div", { class: "stars" }, ...Array.from({ length: n }, () => star("star")), Number(b.stars) > 5 ? h("b", {}, `×${b.stars}`) : null),
  );
}

/** @param {Record<string, any>} s @returns {Scene} */
export function finalScene(s) {
  const t = env.t;
  /** @type {Card[]} */
  const cards = Array.isArray(s.cards) ? [...s.cards].sort((a, b) => b.rank - a.rank) : [];
  /** @type {Best[]} */
  const best = Array.isArray(s.best) ? s.best.slice(0, 6) : [];
  const n = cards.length;
  const one = h("div", { class: "scene final one" });
  const rows = n <= 5 ? 1 : 2;
  const desk = h(
    "div",
    { class: "scene final desk" },
    h("div", { class: `cards r${rows}`, style: { "--per": Math.max(1, Math.ceil(n / rows)) } }, ...[...cards].sort((a, b) => a.rank - b.rank).map((c, i) => smallCard(c, n, i))),
  );
  const vip = env.roster.find((r) => r.vip);
  const cork = h(
    "div",
    { class: "scene final cork" },
    h("div", { class: "strip" }, h("span", { "data-fit": "1" }, t.best)),
    h("div", { class: `board n${best.length}` }, ...(best.length ? best.map(indexCard) : [h("div", { class: "icard none" }, h("div", { class: "ans hand0", "data-fit": "box" }, t.noBest))])),
    vip ? h("div", { class: "again", "data-fit": "1" }, t.again(vip.name)) : null,
  );
  const root = h("div", { class: "finalroot" });
  const start = now() - env.ago;
  let shown = "";
  return {
    layout: "final",
    over: root,
    update() {
      const el = (now() - start) / 1000;
      let which = "";
      let idx = -1;
      if (el < n * ONE) {
        idx = Math.floor(el / ONE);
        which = `one:${idx}`;
      } else {
        const loop = (el - n * ONE) % (DESK + CORK);
        which = loop < DESK ? "desk" : "cork";
      }
      if (which === shown) return;
      shown = which;
      if (idx >= 0) {
        const c = /** @type {Card} */ (cards[idx]);
        one.replaceChildren(bigCard(c, n));
        root.replaceChildren(one);
        sound.page();
        sound.stamp(0.9);
      } else if (which === "desk") {
        root.replaceChildren(desk);
        sound.page();
      } else {
        root.replaceChildren(cork);
        best.forEach((_, i) => sound.pin(0.3 + i * 0.35));
      }
    },
  };
}
