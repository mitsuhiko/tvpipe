/**
 * Wikipedia lookups (docs/classes-design.md §3.5): an answer (or a
 * searched text) found by its exact title first, redirects followed, then
 * by a full-text search; an article's facts (title, description, lead
 * picture, whether it is a disambiguation page) from the query API and
 * its text from the REST API's Parsoid HTML, made into the reader's
 * blocks by `wikitext.ts`. The host page fetches from
 * `{lang}.wikipedia.org` itself (Austrian rooms read de.wikipedia) (CORS: `origin=*`, the REST API); `fetch`
 * is injectable, so the tests run on recorded responses
 * (test/fixtures/wiki/).
 *
 * Nothing from the network is trusted: every field is checked for its
 * type, made plain text, capped; a picture only from Wikimedia's image
 * hosts over https; the article's text only through the whitelist.
 */

import { baseLang, type Lang } from "./rules.ts";
import { wikiBlocks, type Block } from "./wikitext.ts";

/** What lookups need of `fetch`. */
export type Fetch = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

export interface WikiResult {
  title: string;
  /** The search's snippet, plain text. */
  snippet: string;
}

export interface WikiArticle {
  title: string;
  description?: string | undefined;
  image?: string | undefined;
  url: string;
  blocks: Block[];
  /** The text was cut (the article goes on on Wikipedia). */
  cut?: true | undefined;
  /** A disambiguation page: its list of links is the point. */
  disambiguation?: true | undefined;
  /** A redirect to a section: its heading (the reader starts there). */
  section?: string | undefined;
}

export type WikiError = "none" | "offline";

export interface WikiFound {
  /** `none`: nothing found; `offline`: Wikipedia did not answer. */
  error?: WikiError | undefined;
  /** The search's results (empty when the exact title was found). */
  results: WikiResult[];
  article?: WikiArticle | undefined;
}

/** What the game needs of Wikipedia (the tests give their own). */
export interface WikiSource {
  /** An answer or a search: the exact title (redirects followed), else a search and its first result. */
  find(query: string, lang: Lang): Promise<WikiFound>;
  /** An article by its title (a link, another result), redirects followed. */
  article(title: string, lang: Lang): Promise<WikiArticle | { error: WikiError }>;
}

export const MAX_RESULTS = 5;
export const MAX_QUERY = 200;
const MAX_TITLE = 200;
const MAX_SNIPPET = 300;
const MAX_DESCRIPTION = 300;
/** Image hosts: Wikimedia's uploads and its thumbnails. */
const IMAGE_HOSTS = ["upload.wikimedia.org", "thumb.wikimedia.org"];
/** HTML larger than this is not read (the biggest articles are a few MB; the reader keeps 20,000 characters anyway). */
const MAX_HTML = 4_000_000;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#039": "'" };

/** Plain text from Wikipedia's short texts (a snippet, a description): tags off, entities decoded, control characters off, spaces collapsed. */
export function plainText(s: unknown, max: number): string {
  if (typeof s !== "string") return "";
  let t = s.slice(0, max * 4).replace(/<[^>]*>/g, "");
  t = t.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, e: string) => {
    if (Object.hasOwn(ENTITIES, e.toLowerCase())) return ENTITIES[e.toLowerCase()]!;
    const code = e[0] === "#" ? (e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : NaN;
    return Number.isFinite(code) && code > 31 && code < 0x110000 && !(code >= 0xd800 && code < 0xe000) ? String.fromCodePoint(code) : m;
  });
  t = t
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cutText(t, max);
}

/** At most `max` characters, cut at a sentence's end (or else a word's, with "…"). */
export function cutText(text: string, max: number): string {
  if ([...text].length <= max) return text;
  const head = [...text].slice(0, max).join("");
  let end = -1;
  for (const m of head.matchAll(/[.!?…](?=\s)|\n/g)) end = m.index + (m[0] === "\n" ? 0 : 1);
  if (end > max * 0.4) return head.slice(0, end).trim();
  const space = head.lastIndexOf(" ", max - 1);
  return `${(space > max * 0.4 ? head.slice(0, space) : head.slice(0, max - 1)).trim()}…`;
}

/** A picture URL when it is one of Wikimedia's over https, else undefined. */
export function safeImage(u: unknown): string | undefined {
  if (typeof u !== "string" || u.length > 2000) return undefined;
  try {
    const url = new URL(u);
    return url.protocol === "https:" && IMAGE_HOSTS.includes(url.hostname) && !url.username && !url.password && !url.port ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** A title or query as asked: one line, at most {@link MAX_QUERY} characters; null when empty. */
export function cleanTitle(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const t = s.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
  return t && [...t].length <= MAX_QUERY ? t : null;
}

function obj(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** The article's page on Wikipedia. */
export function articleUrl(title: string, lang: Lang): string {
  return `https://${baseLang(lang)}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
}

class Offline extends Error {}

interface Meta {
  title: string;
  description?: string | undefined;
  image?: string | undefined;
  disambiguation: boolean;
  section?: string | undefined;
}

export class Wikipedia implements WikiSource {
  readonly #fetch: Fetch;
  readonly #timeout: number;

  constructor(fetch: Fetch, o: { timeout?: number } = {}) {
    this.#fetch = fetch;
    this.#timeout = o.timeout ?? 10_000;
  }

  async #get(url: string, as: "json" | "text"): Promise<unknown> {
    let res;
    try {
      res = await this.#fetch(url, { headers: { accept: as === "json" ? "application/json" : "text/html" }, ...(typeof AbortSignal.timeout === "function" ? { signal: AbortSignal.timeout(this.#timeout) } : {}) });
    } catch {
      throw new Offline();
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new Offline();
    try {
      return as === "json" ? await res.json() : await res.text();
    } catch {
      throw new Offline();
    }
  }

  /** The search's results (at most {@link MAX_RESULTS}). */
  async search(query: string, lang: Lang): Promise<WikiResult[]> {
    const q = query.slice(0, MAX_QUERY);
    const data = obj(await this.#get(`https://${baseLang(lang)}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&srlimit=${MAX_RESULTS}&format=json&origin=*`, "json"));
    if (data["error"] !== undefined) throw new Offline();
    const list = obj(data["query"])["search"];
    if (!Array.isArray(list)) return [];
    const out: WikiResult[] = [];
    for (const r of list.slice(0, MAX_RESULTS)) {
      const title = plainText(obj(r)["title"], MAX_TITLE);
      if (title && !out.some((x) => x.title === title)) out.push({ title, snippet: plainText(obj(r)["snippet"], MAX_SNIPPET) });
    }
    return out;
  }

  /** The page with this exact title (redirects followed), or null when there is none. */
  async #meta(title: string, lang: Lang): Promise<Meta | null> {
    const t = title.slice(0, MAX_TITLE);
    const data = obj(
      await this.#get(
        `https://${baseLang(lang)}.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&origin=*&redirects=1&prop=pageprops%7Cdescription%7Cpageimages&piprop=thumbnail&pithumbsize=640&ppprop=disambiguation&titles=${encodeURIComponent(t)}`,
        "json",
      ),
    );
    if (data["error"] !== undefined) throw new Offline();
    const q = obj(data["query"]);
    const pages = q["pages"];
    const page = Array.isArray(pages) ? obj(pages[0]) : {};
    if (page["missing"] !== undefined || page["invalid"] !== undefined || typeof page["title"] !== "string" || page["ns"] !== 0) return null;
    const name = plainText(page["title"], MAX_TITLE);
    if (!name) return null;
    const redirect = Array.isArray(q["redirects"]) ? obj(q["redirects"][0]) : {};
    const section = plainText(redirect["tofragment"], MAX_TITLE);
    const description = plainText(page["description"], MAX_DESCRIPTION);
    const image = safeImage(obj(page["thumbnail"])["source"]);
    return { title: name, ...(description ? { description } : {}), ...(image ? { image } : {}), disambiguation: obj(page["pageprops"])["disambiguation"] !== undefined, ...(section ? { section } : {}) };
  }

  async #page(meta: Meta, lang: Lang): Promise<WikiArticle | null> {
    const html = await this.#get(`https://${baseLang(lang)}.wikipedia.org/api/rest_v1/page/html/${encodeURIComponent(meta.title.replace(/ /g, "_"))}`, "text");
    if (typeof html !== "string") return null;
    const { blocks, cut } = wikiBlocks(html.slice(0, MAX_HTML), { self: meta.title });
    return {
      title: meta.title,
      ...(meta.description ? { description: meta.description } : {}),
      ...(meta.image ? { image: meta.image } : {}),
      url: articleUrl(meta.title, lang),
      blocks,
      ...(cut ? { cut: true as const } : {}),
      ...(meta.disambiguation ? { disambiguation: true as const } : {}),
      ...(meta.section ? { section: meta.section } : {}),
    };
  }

  async article(title: string, lang: Lang): Promise<WikiArticle | { error: WikiError }> {
    try {
      const meta = await this.#meta(title, lang);
      const a = meta && (await this.#page(meta, lang));
      return a ?? { error: "none" };
    } catch (e) {
      if (e instanceof Offline) return { error: "offline" };
      throw e;
    }
  }

  async find(query: string, lang: Lang): Promise<WikiFound> {
    try {
      const meta = await this.#meta(query, lang);
      if (meta) {
        const a = await this.#page(meta, lang);
        if (a) return { results: [], article: a };
      }
      const results = await this.search(query, lang);
      if (results.length === 0) return { error: "none", results: [] };
      const a = await this.article(results[0]!.title, lang);
      return "error" in a ? { error: a.error, results } : { results, article: a };
    } catch (e) {
      if (e instanceof Offline) return { error: "offline", results: [] };
      throw e;
    }
  }
}
