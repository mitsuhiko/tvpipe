/**
 * tvpipe's standard launcher (docs/playshare-design.md §7): "Where should
 * the game show?", then the game's host page. With tvpipe the answers are
 * the TVs as they are found (AirPlay PIN pairing, TV sync, the
 * resolution); on tvpipe.party (web mode, docs/browser-party-design.md,
 * "The launcher") they are this device's screens, one of them, or the way
 * to the tvpipe app. There it is `/games/NAME/launcher/` (Play now on
 * /games/), which puts the game in the tab's session first. A game may bring its own launcher with
 * the same API.
 */

import { displayLag, Flasher, MAX_LAG_MS } from "../flashsync.ts";
import { APP_ROW, appScreenNote, appScreens, appWay, detectDevice, screenOptions, type ScreenOption } from "../launcher-options.ts";
import { isWeb } from "../mode.ts";
import { pairField, pairFieldValue } from "../pair-dialog.ts";
import { LOCAL_PREFIX, SCREEN_WINDOW } from "../screens.ts";
import { writeWebSession } from "../session.ts";
import { GAMES_PAGE, loadWebGames } from "../webhub.ts";
import {
  GAME_PICKER,
  PICKER_MESSAGE,
  Tvpipe,
  TV_DISPLAY_MS,
  TV_RENDER_MS,
  TVSYNC_PAGE,
  type CastStatus,
  type Device,
  type Info,
  type PairStatus,
  type Resolution,
  type Selection,
  type TvpipeError,
} from "../tvpipe.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const KIND: Record<Device["kind"], string> = {
  airplay: "AirPlay",
  cast: "Cast",
  both: "AirPlay · Cast",
  browser: "This computer",
};

/**
 * `?mode=change`: the cast picker (docs/playshare-design.md §7.1), in a
 * dialog over the host page while the game runs: it saves the choice and
 * tells the page, which casts again. Else the start of the game.
 */
const changing = new URLSearchParams(location.search).get("mode") === "change";

const RESOLUTION_LABEL: Record<Resolution, string> = { auto: "Auto", "720p": "720p", "1080p": "1080p", "2160p": "4K" };
const RESOLUTION_NOTE: Partial<Record<Resolution, string>> = {
  auto: "What the TVs take, up to 1080p.",
  "2160p": "4K needs a 4K TV and a fast computer.",
};

const selected = new Set<string>();
/** `null`: the game's picture has a fixed size. */
let resolution: Resolution | null = null;
const pairing = new Map<string, PairStatus>();
let devices: Device[] = [];
let info: Info;
let tvpipe: Tvpipe;
/** The device the PIN dialog is open for. */
let pinFor: string | null = null;
/** Set while the selection is cast and the host page loads. */
let starting: string | null = null;
/** Set when tvpipe is gone or never answered. */
let stopped: string | null = null;

function showError(text: string | null): void {
  const e = $("error");
  e.hidden = !text;
  e.textContent = text ?? "";
  renderState();
}

/** The status column: one state with a dot (grey, accent, pulsing, red). */
function renderState(): void {
  const tvs = devices.filter((d) => d.kind !== "browser").length;
  const busy = [...pairing.values()].find((p) => p.state === "connecting" || p.state === "pin");
  let text: string;
  let cls = "";
  if (stopped) [text, cls] = [stopped, "bad"];
  else if (starting) [text, cls] = [starting, "on"];
  else if (!$("error").hidden) [text, cls] = ["Something failed", "bad"];
  else if (busy) [text, cls] = [busy.state === "pin" ? "Waiting for the code" : "Pairing", "on"];
  else if (!info) text = "Connecting…";
  else if (tvs === 0) [text, cls] = ["Looking for TVs", "on"];
  else [text, cls] = [tvs === 1 ? "1 TV found" : `${tvs} TVs found`, "ok"];
  const st = $("state");
  st.textContent = text;
  st.className = `state ${cls}`;
}

function el(tag: string, cls: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function pairingText(p: PairStatus): [string, string] {
  if (p.state === "done") return ["Paired", "done"];
  if (p.state === "failed") return [`Pairing failed${p.error ? `: ${p.error}` : ""}`, "bad"];
  if (p.state === "pin") return [p.password ? "Type the TV's password" : "Type the code the TV shows", ""];
  return ["Pairing…", ""];
}

function render(): void {
  // A TV for its home's members only cannot be chosen.
  for (const d of devices) if (d.homeOnly) selected.delete(d.name);
  const list = $("devices");
  list.replaceChildren(
    ...devices.map((d) => {
      const li = el("li", `device${selected.has(d.name) ? " selected" : ""}`);
      li.dataset["name"] = d.name;
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = selected.has(d.name);
      box.setAttribute("aria-label", d.name);
      const text = el("div", "grow");
      const browser = d.kind === "browser";
      const local = d.name.startsWith(LOCAL_PREFIX);
      // One line under the name: the model and the sync (rows stay low for many TVs).
      const synced = typeof d.displayMs === "number" ? `Synced with phones: ${d.displayMs} ms of its own` : "";
      const closed = d.homeOnly === true;
      if (closed) box.disabled = true;
      // The wording of tvpipe's `home-only` error (HOME_ACCESS in airplay/access.rs).
      const home = closed
        ? "Only for members of its Apple Home: in the Home app, open Home Settings > Speakers & TV and set Allow Speaker & TV Access to “Anyone On the Same Network” (or “Everyone”), then pair"
        : "";
      const meta = local ? appScreenNote(d.name) : browser ? "Try the game without a TV: the TV picture plays in a tab" : [d.model, synced, home].filter(Boolean).join(" · ");
      text.append(el("div", "name", browser ? (d.title ?? "A browser tab on this computer") : d.name), el("div", "meta", meta));
      const p = pairing.get(d.name);
      if (p) {
        const [t, c] = pairingText(p);
        text.append(el("div", `pairing ${c}`, t));
      }
      const end = el("div", "end");
      end.append(el("span", "tag", KIND[d.kind] ?? d.kind));
      if (!browser && !closed && !(d.needsPairing && pairing.get(d.name)?.state !== "done")) {
        const sync = el("button", "btn small", typeof d.displayMs === "number" ? "Sync again" : "Sync") as HTMLButtonElement;
        sync.title = "Measure how far this TV is behind the phones";
        sync.onclick = (ev) => {
          ev.stopPropagation();
          openSync(d.name);
        };
        end.append(sync);
      }
      if (d.needsPairing && pairing.get(d.name)?.state !== "done") {
        const pair = el("button", "btn small", "Pair") as HTMLButtonElement;
        pair.onclick = (ev) => {
          ev.stopPropagation();
          void startPairing(d.name);
        };
        end.append(pair);
      }
      li.append(box, text, end);
      li.onclick = () => {
        if (closed) return;
        if (selected.has(d.name)) selected.delete(d.name);
        else {
          // One local screen at a time: this window or the one on the cable.
          if (local) for (const n of selected) if (n.startsWith(LOCAL_PREFIX)) selected.delete(n);
          selected.add(d.name);
        }
        render();
      };
      return li;
    }),
  );
  $("searching").hidden = devices.some((d) => d.kind !== "browser");
  // The picker may also take every TV away (the cast stops).
  ($("start") as HTMLButtonElement).disabled = (selected.size === 0 && !changing) || starting !== null || pairingFirst;
  renderState();
}

async function startPairing(device: string): Promise<void> {
  showError(null);
  pairing.set(device, { device, state: "connecting" });
  render();
  try {
    await tvpipe.pair(device);
  } catch (err) {
    pairing.set(device, { device, state: "failed", error: (err as Error).message });
    pairEnded(device, false);
    render();
  }
}

/** Set while Start pairs the chosen TVs. */
let pairingFirst = false;
/** Start waits for these pairings: called with whether the TV paired. */
const pairWaits = new Map<string, (paired: boolean) => void>();

function pairEnded(device: string, paired: boolean): void {
  const w = pairWaits.get(device);
  pairWaits.delete(device);
  w?.(paired);
}

/**
 * Pairs the chosen AirPlay TVs that show a PIN and are not paired yet,
 * one after another (the PIN dialog for each); false when one was not
 * paired (cancelled or failed: its status says why).
 */
async function pairChosen(names: string[]): Promise<boolean> {
  for (const name of names) {
    const d = devices.find((x) => x.name === name);
    if (!d?.needsPairing || pairing.get(name)?.state === "done") continue;
    const paired = new Promise<boolean>((resolve) => pairWaits.set(name, resolve));
    void startPairing(name);
    if (!(await paired)) return false;
  }
  return true;
}

/** The open dialog asks for the TV's password (it shows no code). */
let pinPassword = false;

function openPin(device: string, error?: string, password = pinPassword): void {
  pinFor = device;
  pinPassword = password;
  $("pin-device").textContent = device;
  $("pin-text").textContent = password
    ? "This TV has an AirPlay password: the one set in the Home app under Speakers & TV, or in the TV's AirPlay settings. Type it here."
    : "The TV shows a code. Type it here.";
  pairField($("pin-input") as HTMLInputElement, password, password ? "The TV's password" : "The code on the TV");
  const e = $("pin-error");
  e.hidden = !error;
  e.textContent = error ?? "";
  ($("pin-input") as HTMLInputElement).value = "";
  const dlg = $("pin") as HTMLDialogElement;
  if (!dlg.open) dlg.showModal();
  ($("pin-input") as HTMLInputElement).focus();
}

function closePin(): void {
  pinFor = null;
  const dlg = $("pin") as HTMLDialogElement;
  if (dlg.open) dlg.close();
}

/** The resolution buttons (none when the game's size is fixed). */
function renderResolution(): void {
  const box = $("res");
  const choices = info?.resolutions ?? [];
  box.hidden = choices.length === 0 || resolution === null;
  if (box.hidden) return;
  $("res-options").replaceChildren(
    ...choices.map((r) => {
      const b = el("button", "", RESOLUTION_LABEL[r] ?? r) as HTMLButtonElement;
      b.type = "button";
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(r === resolution));
      b.onclick = () => {
        resolution = r;
        renderResolution();
      };
      return b;
    }),
  );
  $("res-note").textContent = (resolution && RESOLUTION_NOTE[resolution]) ?? "";
}

/** The cast picker's answer to the page it is in (`null`: cancelled). */
function answer(selection: Selection | null): void {
  if (window.parent !== window) {
    window.parent.postMessage({ type: PICKER_MESSAGE, selection }, location.origin);
    return;
  }
  // Opened by itself: nothing to tell.
  starting = selection ? "Saved" : null;
  render();
}

async function start(devicesToUse: string[]): Promise<void> {
  showError(null);
  // A TV that needs pairing is paired first, then the game starts on it.
  pairingFirst = true;
  render();
  const paired = await pairChosen(devicesToUse);
  pairingFirst = false;
  render();
  if (!paired) return;
  if (changing) {
    try {
      answer(await tvpipe.select(devicesToUse, { resolution: resolution ?? undefined }));
    } catch (err) {
      showError((err as Error).message);
    }
    return;
  }
  starting = devicesToUse.some((d) => d !== "browser" && !d.startsWith(LOCAL_PREFIX)) ? "Casting…" : "Starting…";
  render();
  try {
    await tvpipe.select(devicesToUse, { resolution: resolution ?? undefined });
    await tvpipe.watchDevices(false);
    location.assign(info.pages.host);
  } catch (err) {
    starting = null;
    render();
    showError((err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// TV sync: this screen's flashes, moved until they come with the TV's (flashsync.ts)

interface Sync {
  device: string;
  /** How far the TV is behind this screen, ms: the lag this screen's flashes run with. */
  lag?: number;
  /** The playout delay the TV's receiver runs with (from the cast status). */
  delayMs?: number;
}

let sync: Sync | null = null;
/** The latest status of the sync page's cast. */
let syncCast: CastStatus | null = null;
/** In the cast picker: a sync replaced the game's picture, which must come back. */
let recast = false;
let flasher: Flasher | undefined;

function syncTv(): { ready: boolean; error?: string; delayMs?: number } {
  const s = syncCast;
  if (!s || !sync) return { ready: false };
  if (s.state === "failed") return { ready: false, error: s.error ?? "The TV did not start the picture" };
  if (s.state === "stopped") return { ready: false, error: "The picture on the TV stopped" };
  const r = (s.receivers ?? []).find((x) => x.name === sync!.device);
  if (r && (r.state === "failed" || r.state === "gave-up")) return { ready: false, error: r.error ?? "The TV refused the picture" };
  const up = s.state === "streaming" && r && (r.state === "connected" || r.state === "reconnected") && typeof r.delayMs === "number";
  return up ? { ready: true, delayMs: r!.delayMs! } : { ready: false };
}

function openSync(device: string): void {
  showError(null);
  sync = { device };
  syncCast = null;
  if (changing) recast = true;
  tvpipe.cast({ page: TVSYNC_PAGE, to: [device] }).then(
    (st) => {
      syncCast ??= st;
      renderSync();
    },
    (err) => {
      syncCast = { state: "failed", error: (err as Error).message };
      renderSync();
    },
  );
  $("sync-device").textContent = device;
  const dlg = $("sync") as HTMLDialogElement;
  if (!dlg.open) dlg.showModal();
  renderSync();
}

function closeSync(): void {
  flasher?.stop();
  const was = sync;
  sync = null;
  const dlg = $("sync") as HTMLDialogElement;
  if (dlg.open) dlg.close();
  // Before the game the TV goes dark again; in the picker the game's
  // picture comes back when the picker answers.
  if (was && !changing) void tvpipe.stopCast().catch(() => {});
}

/** Moves this screen's flashes (ms behind the clock, as far as the TV is). */
function setLag(ms: number): void {
  if (!sync || sync.lag === undefined) return;
  sync.lag = Math.max(0, Math.min(MAX_LAG_MS, Math.round(ms)));
  renderSync();
}

function renderSync(error?: string): void {
  if (!sync) return;
  const s = sync;
  const tv = syncTv();
  const known = devices.find((d) => d.name === s.device)?.displayMs;
  if (tv.ready) {
    s.delayMs = tv.delayMs;
    // Start where tvpipe thinks the TV is: right already, if it was synced before.
    s.lag ??= Math.min(MAX_LAG_MS, (tv.delayMs ?? 0) + (known ?? TV_RENDER_MS + TV_DISPLAY_MS));
  }
  const ready = tv.ready && s.lag !== undefined;
  flasher ??= new Flasher($("sync-beat"));
  flasher.lag = s.lag ?? 0;
  if (ready) flasher.start();
  else flasher.stop();
  const err = $("sync-error");
  err.hidden = !(error ?? tv.error);
  err.textContent = error ?? tv.error ?? "";
  $("sync-text").textContent = ready
    ? `Watch ${s.device} and this screen together and move the slider until both flash at the same moment with the same number. This one first: move right. The TV first: move left. (Arrow keys, Shift for bigger steps.)`
    : tv.error
      ? `The flashes could not start on ${s.device}.`
      : `Starting the flashes on ${s.device}…`;
  const range = $("sync-lag") as HTMLInputElement;
  range.max = String(MAX_LAG_MS);
  range.value = String(s.lag ?? 0);
  for (const id of ["sync-lag", "sync-less", "sync-more", "sync-go"]) ($(id) as HTMLInputElement | HTMLButtonElement).disabled = !ready;
  const value = $("sync-value");
  if (ready) {
    const delay = s.delayMs ?? 0;
    const own = displayLag(s.lag!, delay);
    value.replaceChildren(
      "The TV is ",
      el("b", "", `${s.lag} ms`),
      s.lag! < delay
        ? ` behind this screen, less than the ${delay} ms the picture waits to stay smooth: it counts as ${delay} ms.`
        : ` behind this screen: ${delay} ms the picture waits to stay smooth, ${own} ms the TV itself.`,
    );
  } else value.textContent = "";
  $("sync-forget").hidden = typeof known !== "number";
}

function setupSync(): void {
  const dlg = $("sync") as HTMLDialogElement;
  const range = $("sync-lag") as HTMLInputElement;
  range.addEventListener("input", () => setLag(Number(range.value)));
  $("sync-less").onclick = () => setLag((sync?.lag ?? 0) - 10);
  $("sync-more").onclick = () => setLag((sync?.lag ?? 0) + 10);
  $("sync-go").onclick = () => {
    if (!sync || sync.lag === undefined) return;
    tvpipe.setDisplayLag(sync.device, displayLag(sync.lag, sync.delayMs ?? 0)).then(closeSync, (err) => renderSync((err as Error).message));
  };
  $("sync-forget").onclick = () => {
    if (!sync) return;
    tvpipe.setDisplayLag(sync.device, null).then(closeSync, (err) => renderSync((err as Error).message));
  };
  $("sync-close").onclick = closeSync;
  dlg.addEventListener("cancel", (ev) => {
    ev.preventDefault();
    closeSync();
  });
  dlg.addEventListener("keydown", (ev) => {
    if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
    if (!sync || sync.lag === undefined) return;
    ev.preventDefault();
    const step = (ev.shiftKey ? 50 : 10) * (ev.key === "ArrowLeft" ? -1 : 1);
    setLag(sync.lag + step);
  });
  tvpipe.on("cast", (st) => {
    if (!sync) return;
    syncCast = st;
    renderSync();
  });
}

/** The cast picker's answer when cancelled: the old choice again if a sync took the TV. */
async function cancelPicker(): Promise<void> {
  if (!recast) return answer(null);
  try {
    answer(await tvpipe.chosen());
  } catch {
    answer(null);
  }
}

// ---------------------------------------------------------------------------
// Web mode: this device's screens, one of them (docs/browser-party-design.md)

/** The web launcher's answers for this device, the best first. */
let options: ScreenOption[] = [];
/** The answer picked (`ScreenOption.id`). */
let webChoice: string | null = null;
const here = detectDevice(navigator, matchMedia("(pointer: coarse)").matches);
/** The tvpipe app's commands, shown in its row when picked (moved there by `renderWeb`). */
const appWayBox = $("app-way");

function radio(name: string, checked: boolean): HTMLInputElement {
  const r = document.createElement("input");
  r.type = "radio";
  r.name = "where";
  r.checked = checked;
  r.setAttribute("aria-label", name);
  return r;
}

function renderWeb(): void {
  options = screenOptions(devices, here);
  // The tvpipe app's row is never the first choice, but stays picked.
  if (webChoice !== APP_ROW.id && !options.some((o) => o.id === webChoice)) webChoice = options[0]?.id ?? null;
  const app: ScreenOption = { ...APP_ROW, device: "" };
  const rows = [...options, app].map((o) => {
    const on = o.id === webChoice;
    const li = el("li", `device radio${on ? " selected" : ""}`);
    li.dataset["name"] = o.id;
    const text = el("div", "grow");
    text.append(el("div", "name", o.label), el("div", "meta", o.note));
    if (on && o.steps) {
      const ol = el("ol", "steps");
      ol.append(...o.steps.map((s) => el("li", "", s)));
      text.append(ol);
    }
    if (on && o.id === APP_ROW.id) text.append(appWayBox);
    if (on && (o.steps || o.id === APP_ROW.id)) li.classList.add("open");
    const end = el("div", "end");
    end.append(el("span", "tag", o.tag));
    li.append(radio(o.label, on), text, end);
    li.onclick = () => {
      // Picked already: a click in its commands (selecting, copying) changes nothing.
      if (starting || webChoice === o.id) return;
      webChoice = o.id;
      renderWeb();
      // The commands may open below the window's edge (under the bar).
      if (o.id === APP_ROW.id) appWayBox.scrollIntoView({ block: "nearest", behavior: "smooth" });
    };
    return li;
  });
  $("devices").replaceChildren(...rows);
  // The tvpipe app: its commands instead of Start.
  const withApp = webChoice === APP_ROW.id;
  appWayBox.hidden = !withApp;
  $("start").hidden = withApp;
  ($("start") as HTMLButtonElement).disabled = webChoice === null || withApp || starting !== null;
  const st = $("state");
  const [t, cls] = stopped ? [stopped, "bad"] : starting ? [starting, "on"] : !$("error").hidden ? ["Something failed", "bad"] : ["Pick one", "ok"];
  st.textContent = t;
  st.className = `state ${cls}`;
}

/**
 * The picture's window (cable, second window), opened on the Start click:
 * a page may open windows only then. The host page's cast takes it by its
 * name; an open one stays as it is (`""` does not navigate it). For the
 * cable, it moves to the other screen (the Window Management prompt
 * comes on this click too).
 */
function openScreenWindow(cable: boolean): Window | null {
  const w = window.open("", SCREEN_WINDOW, "popup,width=960,height=540");
  if (!w) return null;
  try {
    if (w.location.href === "about:blank") {
      // Until the host page shows the TV page in it (`/_tvpipe/screen/`).
      w.document.title = "tvpipe.party";
      w.document.documentElement.style.cssText = "background:#000;color:#E8ECF2;font:18px system-ui,sans-serif;height:100%";
      w.document.body.style.cssText = "margin:0;height:100%;display:grid;place-items:center";
      w.document.body.textContent = "Starting the game…";
    }
  } catch {
    // Already the TV page of another origin: nothing to set.
  }
  const details = (window as { getScreenDetails?: () => Promise<{ screens: ScreenArea[]; currentScreen: ScreenArea }> }).getScreenDetails;
  if (cable && details) {
    details.call(window).then(
      (d) => {
        const other = d.screens.find((s) => s !== d.currentScreen && !s.isPrimary) ?? d.screens.find((s) => s !== d.currentScreen);
        if (!other) return;
        w.moveTo(other.availLeft, other.availTop);
        w.resizeTo(other.availWidth, other.availHeight);
      },
      () => {
        // Refused: the window stays here, to be dragged over.
      },
    );
  }
  return w;
}

interface ScreenArea {
  availLeft: number;
  availTop: number;
  availWidth: number;
  availHeight: number;
  isPrimary?: boolean;
}

/** The commands for the tvpipe app's row, each with a copy button. */
function renderAppWay(game: string): void {
  const way = appWay(here, game);
  const part = (id: string) => appWayBox.querySelector<HTMLElement>(`#${id}`)!;
  part("app-intro").hidden = !way.intro;
  part("app-intro").textContent = way.intro ?? "";
  part("app-note").textContent = way.note;
  part("app-commands").replaceChildren(
    ...way.commands.map((c) => {
      const row = el("div", "cmd");
      if (c.os) row.append(el("span", "lbl", c.os));
      const copy = el("button", "btn small", "Copy") as HTMLButtonElement;
      copy.type = "button";
      copy.setAttribute("aria-label", `Copy ${c.text}`);
      copy.onclick = (ev) => {
        ev.stopPropagation();
        navigator.clipboard?.writeText(c.text).then(
          () => {
            copy.textContent = "Copied";
            setTimeout(() => (copy.textContent = "Copy"), 1500);
          },
          () => {},
        );
      };
      row.append(el("code", "", c.text), copy);
      return row;
    }),
  );
}

/** The game picked on /games/, above the question: its cover, title and players. */
async function renderWebGame(): Promise<void> {
  $("web-game").hidden = false;
  $("web-title").textContent = info.title;
  const { min, max } = info.players;
  $("web-facts").textContent = min === max ? `${min} players` : `${min}–${max} players`;
  const g = (await loadWebGames().catch(() => null))?.games.find((x) => x.name === info.name);
  const img = $("web-cover") as HTMLImageElement;
  if (g?.cover) {
    img.src = g.cover;
    img.hidden = false;
  }
}

function webStart(): void {
  const o = options.find((x) => x.id === webChoice);
  if (!o || starting) return;
  showError(null);
  const win = o.device === "cable" || o.device === "window" ? openScreenWindow(o.device === "cable") : null;
  starting = changing ? "Applying…" : "Starting…";
  renderWeb();
  tvpipe.select([o.device]).then(
    async (sel) => {
      writeWebSession({ screen: o.device as "this" | "cable" | "window" | "none" });
      if (changing) {
        starting = null;
        answer(sel);
        renderWeb();
        return;
      }
      await tvpipe.watchDevices(false).catch(() => []);
      // `?bots` (test players) came from the games list: on to the host page.
      const host = new URL(info.pages.host, location.href);
      if (new URLSearchParams(location.search).has("bots")) host.searchParams.set("bots", "");
      location.assign(host.href);
    },
    (err: Error) => {
      starting = null;
      if (win && !changing) win.close();
      showError(err.message);
      renderWeb();
    },
  );
}

async function webMain(): Promise<void> {
  $("searching").hidden = true;
  // More: Chrome's Cast tab.
  $("more").hidden = !here.chromium;
  $("no-tv").hidden = !changing;
  $("where").textContent = "tvpipe.party";
  if (changing) {
    $("title").textContent = "Where should the game show?";
    $("message").textContent = "The game moves to the screen you pick; the phones stay in.";
  } else {
    $("message").textContent = `Everyone plays ${info.title} on their own phone; pick the screen everyone looks at.`;
    void renderWebGame();
  }
  renderAppWay(info.name);
  const chosen = await tvpipe.chosen().catch(() => ({ devices: [] as string[] }));
  devices = await tvpipe.watchDevices(true);
  const was = chosen.devices[0];
  if (was) webChoice = screenOptions(devices, here).find((o) => o.device === was)?.id ?? null;
  tvpipe.on("devices", (list) => {
    devices = list;
    renderWeb();
  });
  tvpipe.on("close", () => {
    stopped = "Stopped";
    renderWeb();
  });
  renderWeb();
  $("start").onclick = webStart;
  $("other-game").hidden = changing;
  $("other-game").onclick = () => location.assign(GAMES_PAGE);
  if (changing) {
    $("no-tv").onclick = () => answer(null);
    addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") answer(null);
    });
  }
}

/** The light/dark/system switch, shared with tvpipe's other pages. */
function themes(): void {
  const buttons = document.querySelectorAll<HTMLButtonElement>(".theme button");
  const set = (t: string) => {
    document.documentElement.dataset["theme"] = t;
    try {
      localStorage.setItem("tvpipe-theme", t);
    } catch {
      // No storage: the choice lasts for this page.
    }
    buttons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset["t"] === t)));
  };
  set(document.documentElement.dataset["theme"] ?? "auto");
  buttons.forEach((b) => (b.onclick = () => set(b.dataset["t"] ?? "auto")));
}

async function main(): Promise<void> {
  // Back from the host page, the browser may give this page back as it was
  // left (the back/forward cache): Start pressed, the socket to tvpipe
  // closed, the TVs no longer watched. A fresh start instead.
  addEventListener("pageshow", (ev) => {
    if (ev.persisted) location.reload();
  });
  themes();
  // The cast picker (`data-mode="change"` is set by the page's head: no header or footer).
  if (changing) {
    $("title").textContent = "Change the TVs";
    $("message").textContent = "The TVs you pick show the game; they start the picture again.";
    $("start").textContent = "Apply";
    $("no-tv").textContent = "Cancel";
  }
  $("where").textContent = `tvpipe game · ${location.host}`;
  const web = isWeb();
  // Play now on /games/: /games/NAME/launcher/ puts this game in the tab's
  // session (an unknown one, or no game in the path: back to the list).
  const want = /^\/games\/([a-z0-9-]+)\/launcher\/?$/.exec(location.pathname)?.[1] ?? null;
  if (web && want === null && !changing) {
    location.replace(GAMES_PAGE);
    return;
  }
  if (web && want !== null && !changing) {
    let list;
    try {
      list = await loadWebGames();
    } catch (err) {
      stopped = "Not connected";
      showError(`The games did not load: ${(err as Error).message}.`);
      return;
    }
    const g = list.games.find((x) => x.name === want);
    if (!g) {
      location.replace(GAMES_PAGE);
      return;
    }
    writeWebSession({ game: { name: g.name, release: g.release } });
  }
  try {
    tvpipe = await Tvpipe.connect();
  } catch (err) {
    stopped = "Not connected";
    $("title").textContent = "Open the link tvpipe printed";
    $("message").textContent = "This page talks to tvpipe through the link it printed (or the window it opened).";
    showError(`${(err as Error).message}.`);
    return;
  }
  try {
    info = await tvpipe.info();
  } catch (err) {
    // tvpipe.party without a game in this tab: the games list first.
    if (web && (err as TvpipeError).code === "no-game" && !changing) {
      location.replace(GAMES_PAGE);
      return;
    }
    stopped = "Not connected";
    showError(`${(err as Error).message}.`);
    return;
  }
  document.title = `${info.title} · ${web ? "tvpipe.party" : "tvpipe"}`;
  $("game").textContent = info.title;
  $("game").title = info.title;
  const { min, max } = info.players;
  $("players").textContent = min === max ? `${min}` : `${min}–${max}`;
  if (web) return webMain();
  if (!changing) $("message").textContent = `${info.title} shows on the TVs you pick. Everyone plays on their own phone.`;
  const chosen = await tvpipe.chosen();
  for (const name of chosen.devices) selected.add(name);
  resolution = chosen.resolution;
  renderResolution();
  // The app's own screens beside the TVs: this window, the TV on the cable.
  let found: Device[] = [];
  const withLocal = (list: Device[]) => [...list, ...appScreens((screen as { isExtended?: boolean }).isExtended === true)];
  tvpipe.on("devices", (list) => {
    found = list;
    devices = withLocal(list);
    render();
  });
  (screen as unknown as EventTarget).addEventListener?.("change", () => {
    devices = withLocal(found);
    render();
  });
  tvpipe.on("pair", (p) => {
    pairing.set(p.device, p);
    if (p.state === "pin") openPin(p.device, undefined, p.password === true);
    else if (pinFor === p.device && p.state !== "connecting") closePin();
    if (p.state === "done") selected.add(p.device);
    if (p.state === "done" || p.state === "failed") pairEnded(p.device, p.state === "done");
    render();
  });
  tvpipe.on("close", () => {
    stopped = "Stopped";
    showError("tvpipe stopped. Run it again to play.");
  });
  tvpipe.on("closing", () => {
    stopped = "Ending";
    showError("tvpipe is ending.");
  });
  found = await tvpipe.watchDevices(true);
  devices = withLocal(found);
  render();
  setupSync();

  $("start").onclick = () => {
    // The cable's window opens on this click (a page may open windows only then).
    if (selected.has(`${LOCAL_PREFIX}cable`)) openScreenWindow(true);
    void start([...selected]);
  };
  // The games list (a tvpipe that has one gives the room).
  $("other-game").hidden = changing || !info.room;
  $("other-game").onclick = () => location.assign(GAME_PICKER);
  $("no-tv").onclick = () => (changing ? void cancelPicker() : void start([]));
  if (changing) {
    addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && !($("pin") as HTMLDialogElement).open && !($("sync") as HTMLDialogElement).open) void cancelPicker();
    });
  }
  ($("pin-form") as HTMLFormElement).onsubmit = (ev) => {
    ev.preventDefault();
    const pin = pairFieldValue($("pin-input") as HTMLInputElement, pinPassword);
    if (!pinFor || pin === undefined) {
      const e = $("pin-error");
      e.hidden = false;
      e.textContent = pinPassword ? "Type the TV's password." : "The code is the digits the TV shows.";
      return;
    }
    tvpipe.pairPin(pinFor, pin).catch((err) => openPin(pinFor ?? "", (err as Error).message));
  };
  $("pin-cancel").onclick = () => {
    if (pinFor) void tvpipe.pairCancel(pinFor);
    if (pinFor) pairing.delete(pinFor);
    if (pinFor) pairEnded(pinFor, false);
    closePin();
    render();
  };
}

void main();
