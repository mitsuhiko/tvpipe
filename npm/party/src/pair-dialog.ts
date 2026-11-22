/**
 * The pairing dialog ({@link Tvpipe.showPairing}): an AirPlay TV that
 * wants a PIN shows one, people type it here (`pair.start`, `pair` events,
 * `pair.pin`). A wrong code or a pairing that failed offers another try
 * (the TV shows a new code). A TV with a password shows no code: its
 * password is typed instead (`password` on the `pair` event).
 */

import type { PairStatus, Tvpipe } from "./tvpipe.ts";

interface Strings {
  title: (device: string) => string;
  body: (device: string) => string;
  connecting: (device: string) => string;
  connectingPassword: (device: string) => string;
  pin: (device: string) => string;
  password: (device: string) => string;
  done: (device: string) => string;
  failed: string;
  digits: string;
  empty: string;
  pair: string;
  again: string;
  cancel: string;
  label: string;
  passwordLabel: string;
}

const STRINGS: Record<string, Strings> = {
  en: {
    title: (d) => `Pair with ${d}`,
    body: (d) => `${d} needs pairing once before it shows the game. tvpipe keeps the pairing.`,
    connecting: (d) => `Asking ${d} for a code…`,
    connectingPassword: (d) => `Connecting to ${d}…`,
    pin: (d) => `Type the code ${d} shows.`,
    password: (d) => `Type the AirPlay password of ${d}: the one set in the Home app under Speakers & TV, in the TV's AirPlay settings, or on a Mac under AirPlay Receiver.`,
    done: (d) => `Paired with ${d}.`,
    failed: "Pairing failed",
    digits: "The code is the digits the TV shows.",
    empty: "Type the TV's password.",
    pair: "Pair",
    again: "Try again",
    cancel: "Cancel",
    label: "Code",
    passwordLabel: "Password",
  },
  de: {
    title: (d) => `Mit ${d} koppeln`,
    body: (d) => `${d} muss einmal gekoppelt werden, bevor es das Spiel zeigt. tvpipe merkt sich die Kopplung.`,
    connecting: (d) => `${d} wird nach einem Code gefragt…`,
    connectingPassword: (d) => `Verbindung mit ${d}…`,
    pin: (d) => `Den Code eingeben, den ${d} zeigt.`,
    password: (d) => `Das AirPlay-Passwort von ${d} eingeben: das in der Home-App unter „Lautsprecher & TV“, in den AirPlay-Einstellungen des Fernsehers oder auf einem Mac unter „AirPlay-Empfänger“ festgelegte.`,
    done: (d) => `Mit ${d} gekoppelt.`,
    failed: "Koppeln fehlgeschlagen",
    digits: "Der Code sind die Ziffern auf dem Fernseher.",
    empty: "Das Passwort des Fernsehers eingeben.",
    pair: "Koppeln",
    again: "Nochmal",
    cancel: "Abbrechen",
    label: "Code",
    passwordLabel: "Passwort",
  },
};

const CSS = `
form { width: 360px; max-width: 100%; box-sizing: border-box; font: 15px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #15161c; display: flex; flex-direction: column; gap: 12px; padding: 24px 26px 20px; margin: 0; }
h2 { margin: 0; font-size: 21px; }
p { margin: 0; color: #4b4d58; }
.state.done { color: #1d7a3c; font-weight: 600; }
.error { color: #b42318; }
input { font: inherit; font-size: 28px; letter-spacing: 0.3em; text-align: center; padding: 8px 10px; border: 1px solid #c9cbd4; border-radius: 9px; font-variant-numeric: tabular-nums; }
input:disabled { background: #f3f4f7; }
input.password { font-size: 20px; letter-spacing: normal; text-align: left; }
.row { display: flex; justify-content: flex-end; gap: 10px; margin-top: 4px; }
button { font: inherit; font-weight: 600; border-radius: 9px; padding: 8px 16px; border: 1px solid #c9cbd4; background: #fff; color: #15161c; cursor: pointer; }
button.primary { background: #15161c; color: #fff; border-color: #15161c; }
button:disabled { opacity: 0.5; cursor: default; }
`;

/** Sets a pairing field up for a TV's code (digits) or, with `password`, its password. */
export function pairField(input: HTMLInputElement, password: boolean, label: string): void {
  input.type = password ? "password" : "text";
  input.inputMode = password ? "text" : "numeric";
  input.autocomplete = password ? "off" : "one-time-code";
  input.maxLength = password ? 128 : 8;
  input.placeholder = password ? "" : "0000";
  if (password) input.removeAttribute("pattern");
  else input.pattern = "[0-9]*";
  input.setAttribute("aria-label", label);
}

/** What was typed, or `undefined` when it is not a code (4–8 digits) or is an empty password. */
export function pairFieldValue(input: HTMLInputElement, password: boolean): string | undefined {
  const typed = password ? input.value : input.value.trim();
  return (password ? typed !== "" : /^\d{4,8}$/.test(typed)) ? typed : undefined;
}

/** Shows the dialog and pairs; resolves `true` once paired, `false` when cancelled. */
export function showPairDialog(tvpipe: Tvpipe, device: string): Promise<boolean> {
  const doc = globalThis.document;
  const lang = (doc.documentElement.lang || "en").slice(0, 2).toLowerCase();
  const t = STRINGS[lang] ?? STRINGS["en"]!;
  return new Promise((resolve) => {
    const dialog = doc.createElement("dialog");
    dialog.className = "tvpipe-pair";
    dialog.style.cssText = "padding:0;border:0;border-radius:16px;background:#fff;box-shadow:0 20px 60px rgb(0 0 0 / 40%);max-width:94vw";
    const root = doc.createElement("div").attachShadow({ mode: "open" });
    const host = root.host as HTMLElement;
    const style = doc.createElement("style");
    style.textContent = CSS;
    const h = <T extends HTMLElement>(tag: string, cls: string, text?: string) => {
      const e = doc.createElement(tag) as T;
      if (cls) e.className = cls;
      if (text !== undefined) e.textContent = text;
      return e;
    };
    const form = h<HTMLFormElement>("form", "");
    const state = h("p", "state");
    const error = h("p", "error");
    const input = h<HTMLInputElement>("input", "");
    pairField(input, false, t.label);
    const ok = h<HTMLButtonElement>("button", "primary", t.pair);
    ok.type = "submit";
    const cancel = h<HTMLButtonElement>("button", "", t.cancel);
    cancel.type = "button";
    const row = h("div", "row");
    row.append(cancel, ok);
    form.append(h("h2", "", t.title(device)), h("p", "", t.body(device)), state, input, error, row);
    root.append(style, form);
    dialog.append(host);

    let step: PairStatus["state"] = "connecting";
    /** The TV shows no code: its password is asked for. */
    let password = false;
    let finished = false;
    const show = (s: PairStatus["state"], err?: string, wantsPassword = false) => {
      step = s;
      if (s === "pin") {
        password = wantsPassword;
        input.className = password ? "password" : "";
        pairField(input, password, password ? t.passwordLabel : t.label);
      }
      state.className = `state ${s}`;
      const ask = password ? t.password(device) : t.pin(device);
      const wait = password ? t.connectingPassword(device) : t.connecting(device);
      state.textContent = s === "pin" ? ask : s === "done" ? t.done(device) : s === "failed" ? t.failed : wait;
      error.hidden = !err;
      error.textContent = err ?? "";
      input.disabled = s !== "pin";
      input.hidden = s === "done" || s === "failed";
      ok.disabled = s === "connecting" || s === "done";
      ok.textContent = s === "failed" ? t.again : t.pair;
      if (s === "pin") {
        input.value = "";
        input.focus();
      }
    };
    const finish = (paired: boolean) => {
      if (finished) return;
      finished = true;
      off();
      if (dialog.open) dialog.close();
      dialog.remove();
      resolve(paired);
    };
    const start = () => {
      show("connecting");
      tvpipe.pair(device).catch((err) => show("failed", (err as Error).message));
    };
    const off = tvpipe.on("pair", (p) => {
      if (p.device !== device || finished) return;
      show(p.state, p.state === "failed" ? p.error : undefined, p.password === true);
      if (p.state === "done") setTimeout(() => finish(true), 700);
    });
    form.onsubmit = (ev) => {
      ev.preventDefault();
      if (step === "failed") return start();
      if (step !== "pin") return;
      const pin = pairFieldValue(input, password);
      if (pin === undefined) {
        error.hidden = false;
        error.textContent = password ? t.empty : t.digits;
        return;
      }
      ok.disabled = true;
      tvpipe.pairPin(device, pin).catch((err) => {
        ok.disabled = false;
        error.hidden = false;
        error.textContent = (err as Error).message;
      });
    };
    const quit = () => {
      if (step !== "done" && step !== "failed") void tvpipe.pairCancel(device).catch(() => {});
      finish(step === "done");
    };
    cancel.onclick = quit;
    dialog.addEventListener("cancel", (ev) => {
      ev.preventDefault();
      quit();
    });
    doc.body.append(dialog);
    dialog.showModal();
    start();
  });
}
