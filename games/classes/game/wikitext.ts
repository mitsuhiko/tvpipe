/**
 * Wikipedia's article HTML (Parsoid, from the REST API's `page/html`)
 * turned into the reader's small, safe structure (docs/classes-design.md
 * §3.5, §7.1): blocks (paragraphs, headings, list items, quotes) of
 * inline runs (text, bold, italic, links to other articles). A
 * hand-written HTML tokenizer and a whitelist, no DOMParser: it runs in
 * Node and in the host page alike, and nothing but text and article
 * titles ever leaves it. Known answers on recorded articles in
 * test/wikitext.test.ts.
 */

export type Inline = string | { s: string; b?: true; i?: true; a?: string };
export interface Block {
  t: "p" | "h2" | "h3" | "li" | "quote";
  c: Inline[];
  /** List depth, 1–3. */
  d?: 1 | 2 | 3;
  /** The number of an ordered list's item. */
  n?: number;
}

export interface WikiText {
  blocks: Block[];
  /** The text was cut at {@link MAX_BLOCKS} or {@link MAX_CHARS}. */
  cut: boolean;
}

export const MAX_BLOCKS = 400;
export const MAX_CHARS = 20_000;
/** A link's title at most (longer: plain text). */
const MAX_TITLE = 200;

// ---------------------------------------------------------------------------
// Tokens

export type Token =
  | { k: "open"; name: string; attrs: Record<string, string>; self: boolean }
  | { k: "close"; name: string }
  | { k: "text"; s: string };

/** Elements without content (no end tag). */
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr", "param", "keygen"]);
/** Elements whose content is raw text up to their end tag. */
const RAW = new Set(["script", "style", "textarea", "title", "xmp", "noscript", "template"]);

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", shy: "", ensp: "\u2002", emsp: "\u2003", thinsp: "\u2009",
  ndash: "–", mdash: "—", minus: "−", hellip: "…", middot: "·", bull: "•", times: "×", divide: "÷", deg: "°", plusmn: "±",
  laquo: "«", raquo: "»", lsaquo: "‹", rsaquo: "›", ldquo: "“", rdquo: "”", bdquo: "„", lsquo: "‘", rsquo: "’", sbquo: "‚",
  prime: "′", Prime: "″", sect: "§", para: "¶", copy: "©", reg: "®", trade: "™", euro: "€", pound: "£", yen: "¥", cent: "¢",
  frac12: "½", frac14: "¼", frac34: "¾", sup1: "¹", sup2: "²", sup3: "³", micro: "µ", larr: "←", rarr: "→", harr: "↔",
  auml: "ä", ouml: "ö", uuml: "ü", Auml: "Ä", Ouml: "Ö", Uuml: "Ü", szlig: "ß", eacute: "é", egrave: "è", aacute: "á", agrave: "à",
  oacute: "ó", iacute: "í", uacute: "ú", ccedil: "ç", ntilde: "ñ", zwj: "\u200d", zwnj: "\u200c", lrm: "", rlm: "",
};

/** Character references decoded: the named ones above and numeric ones (never a control character or a surrogate). */
export function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/g, (m, e: string) => {
    if (e[0] !== "#") return Object.hasOwn(NAMED, e) ? NAMED[e]! : m;
    const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    if (!Number.isFinite(code) || code < 32 || (code >= 0x7f && code < 0xa0) || (code >= 0xd800 && code < 0xe000) || code > 0x10ffff) return "";
    return String.fromCodePoint(code);
  });
}

/** The HTML's tokens: tags with their attributes (names lowercased, values decoded), text (decoded); comments and doctypes dropped. */
export function tokenize(html: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const n = html.length;
  const text = (s: string) => {
    if (s) out.push({ k: "text", s: decodeEntities(s) });
  };
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      text(html.slice(i));
      break;
    }
    if (lt > i) text(html.slice(i, lt));
    i = lt;
    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (html[i + 1] === "!" || html[i + 1] === "?") {
      const end = html.indexOf(">", i);
      i = end < 0 ? n : end + 1;
      continue;
    }
    const close = html[i + 1] === "/";
    const m = /^[A-Za-z][A-Za-z0-9:-]*/.exec(html.slice(i + (close ? 2 : 1), i + (close ? 2 : 1) + 64));
    if (!m) {
      // A lone "<": text.
      text("<");
      i++;
      continue;
    }
    const name = m[0].toLowerCase();
    let j = i + (close ? 2 : 1) + m[0].length;
    if (close) {
      const end = html.indexOf(">", j);
      i = end < 0 ? n : end + 1;
      out.push({ k: "close", name });
      continue;
    }
    // Attributes.
    const attrs: Record<string, string> = Object.create(null);
    let self = false;
    for (;;) {
      while (j < n && /\s/.test(html[j]!)) j++;
      if (j >= n) break;
      if (html[j] === ">") {
        j++;
        break;
      }
      if (html[j] === "/" && html[j + 1] === ">") {
        self = true;
        j += 2;
        break;
      }
      const an = /^[^\s/>=]+/.exec(html.slice(j, j + 256));
      if (!an) {
        j++;
        continue;
      }
      const key = an[0].toLowerCase();
      j += an[0].length;
      while (j < n && /\s/.test(html[j]!)) j++;
      let value = "";
      if (html[j] === "=") {
        j++;
        while (j < n && /\s/.test(html[j]!)) j++;
        const q = html[j];
        if (q === '"' || q === "'") {
          const end = html.indexOf(q, j + 1);
          value = html.slice(j + 1, end < 0 ? n : end);
          j = end < 0 ? n : end + 1;
        } else {
          const v = /^[^\s>]*/.exec(html.slice(j))!;
          value = v[0];
          j += v[0].length;
        }
      }
      if (!(key in attrs)) attrs[key] = decodeEntities(value);
    }
    i = j;
    out.push({ k: "open", name, attrs, self: self || VOID.has(name) });
    if (RAW.has(name) && !self) {
      const end = html.toLowerCase().indexOf(`</${name}`, i);
      i = end < 0 ? n : end;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The whitelist

/** Sections dropped whole, by their heading (lowercase). */
const DROP_SECTIONS = new Set([
  "see also", "references", "notes", "further reading", "external links", "bibliography", "sources", "citations", "footnotes", "notes and references", "explanatory notes", "works cited",
  "siehe auch", "literatur", "weblinks", "einzelnachweise", "anmerkungen", "quellen", "belege", "fußnoten", "literatur und weblinks",
]);

/** Classes whose element is dropped with its content. */
const DROP_CLASSES = [
  "infobox", "navbox", "vertical-navbox", "navigation-not-searchable", "hatnote", "dablink", "metadata", "noprint", "mw-empty-elt", "shortdescription",
  "sistersitebox", "ambox", "mbox-small", "thumb", "mw-editsection", "reflist", "references", "mw-references-wrap", "toc", "gallery", "printfooter",
  "reference", "mw-ref", "geo", "coordinates", "sidebar", "portal", "mw-kartographer-container", "noviewer", "taxobox", "sisterproject", "boilerplate",
  "mw-cite-backlink", "error", "mw-indicators", "nomobile",
];
/** `typeof` values (prefixes) dropped with their content. */
const DROP_TYPEOF = ["mw:File", "mw:Extension/ref", "mw:Extension/references", "mw:Extension/gallery", "mw:Extension/graph", "mw:Extension/mapframe", "mw:Extension/maplink", "mw:Extension/score", "mw:Extension/timeline", "mw:Extension/imagemap", "mw:Extension/templatestyles", "mw:Extension/indicator"];
/** Elements dropped with their content. */
const DROP_TAGS = new Set(["head", "style", "script", "template", "noscript", "table", "figure", "figcaption", "img", "audio", "video", "svg", "iframe", "object", "button", "form", "input", "select", "textarea", "caption", "map", "link", "meta", "base", "sup-ref"]);

/** Namespaces that are not articles (lowercase, both languages; "talk" pages too). */
const NAMESPACES = new Set([
  "file", "image", "media", "category", "help", "template", "wikipedia", "wp", "project", "portal", "special", "user", "talk", "module", "draft", "mediawiki", "timedtext", "book", "gadget", "education program",
  "datei", "bild", "medium", "kategorie", "hilfe", "vorlage", "spezial", "benutzer", "benutzerin", "diskussion", "modul", "wikipedia diskussion",
]);

function classes(a: Record<string, string>): string[] {
  return (a["class"] ?? "").split(/\s+/).filter(Boolean);
}

/** Whether an element (and its content) is clutter. */
function dropped(name: string, a: Record<string, string>): boolean {
  if (DROP_TAGS.has(name)) return true;
  const cls = classes(a);
  if (cls.some((c) => DROP_CLASSES.includes(c))) return true;
  const type = a["typeof"] ?? "";
  if (type && DROP_TYPEOF.some((t) => type.split(/\s+/).some((x) => x === t || x.startsWith(`${t}/`)))) return true;
  if (a["role"] === "navigation" || a["role"] === "note") return true;
  if (/display\s*:\s*none/i.test(a["style"] ?? "")) return true;
  if (a["id"] === "coordinates" || a["id"]?.startsWith("Vorlage_Begriffsklärungshinweis")) return true;
  if (name === "sup" && (a["rel"] === "dc:references" || (a["id"] ?? "").startsWith("cite_ref"))) return true;
  return false;
}

/** The article a link goes to, or null (not a link to an article: another namespace, a red link, elsewhere). */
export function linkTarget(a: Record<string, string>): string | null {
  const rel = (a["rel"] ?? "").split(/\s+/);
  if (!rel.includes("mw:WikiLink")) return null;
  const href = a["href"] ?? "";
  if (!href.startsWith("./") || classes(a).includes("new") || /[?&]redlink=1/.test(href)) return null;
  let title = a["title"] ?? "";
  if (!title) {
    try {
      title = decodeURIComponent(href.slice(2).split(/[#?]/)[0]!).replace(/_/g, " ");
    } catch {
      return null;
    }
  }
  title = title.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
  if (!title || title.length > MAX_TITLE || title.startsWith(":")) return null;
  const colon = title.indexOf(":");
  if (colon > 0) {
    const ns = title.slice(0, colon).trim().toLowerCase();
    if (NAMESPACES.has(ns) || ns.endsWith(" talk") || ns.endsWith(" diskussion")) return null;
  }
  return title;
}

/** A formula's readable source: `alttext`, else the TeX of Parsoid's data-mw, without `\displaystyle`. */
function mathText(a: Record<string, string>): string {
  let tex = a["alttext"] ?? "";
  if (!tex) {
    try {
      const mw = JSON.parse(a["data-mw"] ?? "{}") as { body?: { extsrc?: unknown } };
      if (typeof mw.body?.extsrc === "string") tex = mw.body.extsrc;
    } catch {}
  }
  tex = tex.replace(/^\s*\{\\displaystyle\s*([\s\S]*)\}\s*$/, "$1").replace(/\\displaystyle\s*/g, "");
  return tex.replace(/\s+/g, " ").trim().slice(0, 200);
}

// ---------------------------------------------------------------------------
// Blocks

interface Fmt {
  b: boolean;
  i: boolean;
  a: string | null;
}

/** Parsoid HTML as blocks (§3.5): the whitelist, the caps. */
export function wikiBlocks(html: string, o: { maxBlocks?: number; maxChars?: number; self?: string } = {}): WikiText {
  const maxBlocks = o.maxBlocks ?? MAX_BLOCKS;
  const maxChars = o.maxChars ?? MAX_CHARS;
  const tokens = tokenize(html);
  const blocks: Block[] = [];
  let chars = 0;
  let cut = false;
  let done = false;

  // The open elements (names), and for each whether it opened a format, a list, a block.
  const stack: { name: string; fmt?: Partial<Fmt>; list?: { ordered: boolean; n: number }; block?: boolean; section?: boolean }[] = [];
  /** Dropping: the stack depth to return to. */
  let skipTo = -1;
  /** A dropped section: everything until the section at this depth closes. */
  let skipSection = -1;
  let cur: Block | null = null;
  /** A heading being read (to know whether its section is dropped). */
  let heading: { block: Block; depth: number } | null = null;
  let quote = 0;

  const fmt = (): Fmt => {
    const f: Fmt = { b: false, i: false, a: null };
    for (const e of stack) {
      if (e.fmt?.b) f.b = true;
      if (e.fmt?.i) f.i = true;
      if (e.fmt?.a !== undefined) f.a = e.fmt.a;
    }
    return f;
  };
  const lists = () => stack.filter((e) => e.list);
  const finish = () => {
    if (!cur) return;
    const b = cur;
    cur = null;
    // Trim the runs.
    while (b.c.length && runText(b.c[0]!).trim() === "") b.c.shift();
    while (b.c.length && runText(b.c[b.c.length - 1]!).trim() === "") b.c.pop();
    if (b.c.length === 0) return;
    b.c[0] = withText(b.c[0]!, runText(b.c[0]!).replace(/^\s+/, ""));
    b.c[b.c.length - 1] = withText(b.c[b.c.length - 1]!, runText(b.c[b.c.length - 1]!).replace(/\s+$/, ""));
    const len = b.c.reduce((n, r) => n + runText(r).length, 0);
    if (blocks.length >= maxBlocks || chars + len > maxChars) {
      cut = true;
      done = true;
      return;
    }
    chars += len;
    blocks.push(b);
  };
  const start = (t: Block["t"], extra: Partial<Block> = {}) => {
    finish();
    cur = { t, c: [], ...extra };
  };
  const add = (s: string, f: Fmt) => {
    if (done) return;
    if (!cur) {
      if (s.trim() === "") return;
      start(quote > 0 ? "quote" : "p");
    }
    const c = cur!.c;
    const last = c[c.length - 1];
    let t = s.replace(/[\s\u00a0]+/g, (w) => (w.includes("\u00a0") && !/[\t\n\r ]/.test(w) ? "\u00a0" : " "));
    // Collapse a space at a run's border.
    if (last !== undefined && /\s$/.test(runText(last)) && t.startsWith(" ")) t = t.slice(1);
    if (!t) return;
    const plain = !f.b && !f.i && !f.a;
    if (last !== undefined && sameFmt(last, f)) c[c.length - 1] = withText(last, runText(last) + t);
    else c.push(plain ? t : { s: t, ...(f.b ? { b: true as const } : {}), ...(f.i ? { i: true as const } : {}), ...(f.a ? { a: f.a } : {}) });
  };

  for (const tok of tokens) {
    if (done) break;
    if (tok.k === "open") {
      const { name, attrs } = tok;
      if (skipTo >= 0 || skipSection >= 0) {
        if (!tok.self) stack.push({ name });
        continue;
      }
      if (name === "math") {
        const tex = mathText(attrs);
        if (tex) add(` ${tex} `, fmt());
        if (!tok.self) {
          stack.push({ name });
          skipTo = stack.length - 1;
        }
        continue;
      }
      if (dropped(name, attrs)) {
        if (!tok.self) {
          stack.push({ name });
          skipTo = stack.length - 1;
        }
        continue;
      }
      if (tok.self) {
        if (name === "br") add(" ", fmt());
        continue;
      }
      const e: (typeof stack)[number] = { name };
      switch (name) {
        case "section":
          e.section = true;
          break;
        case "p":
        case "dt":
        case "dd":
          if (name === "dt") e.fmt = { b: true };
          // Inside a list item: part of the item.
          if (stack.some((x) => x.name === "li")) break;
          start(quote > 0 ? "quote" : "p");
          e.block = true;
          break;
        case "h1":
        case "h2":
        case "h3":
        case "h4":
        case "h5":
        case "h6":
          start(name === "h1" || name === "h2" ? "h2" : "h3");
          heading = { block: cur!, depth: stack.length };
          e.block = true;
          break;
        case "ul":
        case "ol":
          finish();
          e.list = { ordered: name === "ol", n: Number.parseInt(attrs["start"] ?? "1", 10) || 1 };
          break;
        case "li": {
          const ls = lists();
          const list = ls[ls.length - 1]?.list;
          const d = Math.max(1, Math.min(3, ls.length)) as 1 | 2 | 3;
          start("li", { d, ...(list?.ordered ? { n: list.n++ } : {}) });
          e.block = true;
          break;
        }
        case "blockquote":
          finish();
          quote++;
          break;
        case "b":
        case "strong":
          e.fmt = { b: true };
          break;
        case "i":
        case "em":
        case "cite":
        case "var":
          e.fmt = { i: true };
          break;
        case "a": {
          const t = linkTarget(attrs);
          // A link to the article itself (a section of it) is text.
          e.fmt = { a: t !== null && o.self !== undefined && t.toLowerCase() === o.self.toLowerCase() ? null : t };
          break;
        }
        case "div":
          // A container: what it holds is its own blocks (not inside a list item).
          if (!stack.some((x) => x.name === "li")) {
            finish();
            e.block = true;
          }
          break;
      }
      stack.push(e);
      continue;
    }
    if (tok.k === "close") {
      // Pop to the matching element (Parsoid's HTML is well formed; stray end tags are ignored).
      let k = stack.length - 1;
      while (k >= 0 && stack[k]!.name !== tok.name) k--;
      if (k < 0) continue;
      while (stack.length > k) {
        const e = stack.pop()!;
        const depth = stack.length;
        if (skipTo >= 0) {
          if (depth === skipTo) skipTo = -1;
          continue;
        }
        if (skipSection >= 0) {
          if (depth === skipSection) skipSection = -1;
          continue;
        }
        if (e.name === "blockquote") {
          finish();
          quote = Math.max(0, quote - 1);
        }
        if (e.block) {
          if (heading && heading.depth === depth) {
            const text = heading.block.c.map(runText).join("").replace(/\s+/g, " ").trim().toLowerCase();
            heading = null;
            if (DROP_SECTIONS.has(text)) {
              // Drop the heading and its section (to the end of the enclosing <section>).
              cur = null;
              let s = stack.length - 1;
              while (s >= 0 && !stack[s]!.section) s--;
              if (s >= 0) skipSection = s;
              else done = true;
              continue;
            }
          }
          finish();
        }
        if (e.list) finish();
      }
      continue;
    }
    if (skipTo >= 0 || skipSection >= 0) continue;
    add(tok.s, fmt());
  }
  finish();
  // A heading with nothing after it (its section was all clutter): gone.
  const out = blocks.filter((b, i) => !((b.t === "h2" || b.t === "h3") && (i === blocks.length - 1 || blocks[i + 1]!.t === "h2" || (b.t === "h3" && blocks[i + 1]!.t === "h3"))));
  return { blocks: out, cut };
}

function runText(r: Inline): string {
  return typeof r === "string" ? r : r.s;
}

function withText(r: Inline, s: string): Inline {
  return typeof r === "string" ? s : { ...r, s };
}

function sameFmt(r: Inline, f: Fmt): boolean {
  if (typeof r === "string") return !f.b && !f.i && !f.a;
  return !!r.b === f.b && !!r.i === f.i && (r.a ?? null) === f.a;
}

/** The plain text of blocks (tests, the TV's fitting). */
export function blocksText(blocks: readonly Block[]): string {
  return blocks.map((b) => b.c.map(runText).join("")).join("\n");
}
