/**
 * A headless Chrome for live checks (not part of `npm test`): open pages,
 * run script in them, take screenshots, collect their errors, over the
 * DevTools protocol with Node's own WebSocket.
 *
 *   const b = await Browser.launch();
 *   const tab = await b.open("http://…", { width: 390, height: 844, mobile: true });
 *   await tab.eval("document.title");
 *   await tab.screenshot("/tmp/x.png");
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME =
  process.env["CHROME"] ??
  (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "google-chrome");

export class Tab {
  /** Errors the page reported (uncaught exceptions, console.error, failed loads) since `watch()`. */
  readonly errors: string[] = [];
  readonly #ws: WebSocket;
  #id = 0;
  #closed = false;
  readonly #pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

  constructor(ws: WebSocket) {
    this.#ws = ws;
    // Chrome gone (crashed, killed): what waits for it fails instead of hanging.
    ws.onclose = () => {
      if (this.#closed) return;
      for (const p of this.#pending.values()) p.reject(new Error("DevTools connection closed"));
      this.#pending.clear();
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(String(e.data));
      if (msg.method) {
        this.#event(msg.method, msg.params);
        return;
      }
      const p = this.#pending.get(msg.id);
      if (!p) return;
      this.#pending.delete(msg.id);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    };
  }

  #event(method: string, params: any): void {
    if (method === "Runtime.exceptionThrown") {
      const d = params.exceptionDetails;
      this.errors.push(`page error: ${d.exception?.description ?? d.text} (${d.url ?? ""}:${d.lineNumber})`.slice(0, 600));
    } else if (method === "Runtime.consoleAPICalled" && (params.type === "error" || params.type === "assert")) {
      const args = (params.args ?? []).map((a: any) => a.value ?? a.description ?? a.type).join(" ");
      this.errors.push(`console.${params.type}: ${args}`.slice(0, 600));
    } else if (method === "Log.entryAdded" && params.entry.level === "error") {
      this.errors.push(`log (${params.entry.source}): ${params.entry.text} ${params.entry.url ?? ""}`.slice(0, 600));
    }
  }

  /** Collects the page's errors into `errors` (Runtime and Log events), from before it loads. */
  async watch(): Promise<void> {
    await this.send("Runtime.enable");
    await this.send("Log.enable");
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    if (this.#ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error(`${method}: DevTools connection closed`));
    const id = ++this.#id;
    this.#ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }));
  }

  /** Evaluates an expression (awaiting promises) as a user gesture. */
  async eval<T = unknown>(expression: string): Promise<T> {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(`${expression}: ${JSON.stringify(r.exceptionDetails).slice(0, 500)}`);
    return r.result.value as T;
  }

  /** Polls `expression` until it is truthy. */
  async until(expression: string, ms = 15000): Promise<void> {
    const end = Date.now() + ms;
    while (!(await this.eval(expression))) {
      if (Date.now() > end) throw new Error(`timed out: ${expression}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** Changes the viewport (CSS px). */
  async resize(view: { width: number; height: number; mobile?: boolean }): Promise<void> {
    await this.send("Emulation.setDeviceMetricsOverride", { width: view.width, height: view.height, deviceScaleFactor: view.mobile ? 2 : 1, mobile: view.mobile ?? false });
  }

  async screenshot(path: string): Promise<void> {
    writeFileSync(path, await this.capture());
  }

  /**
   * A screenshot in memory: PNG, or WebP or JPEG at `quality`; `clip` (CSS
   * px from the top left, times `scale`) for a picture of a fixed size.
   */
  async capture(o: { format?: "png" | "webp" | "jpeg"; quality?: number; clip?: { width: number; height: number; scale: number } } = {}): Promise<Buffer> {
    await this.send("Page.bringToFront");
    const r = await this.send("Page.captureScreenshot", {
      format: o.format ?? "png",
      ...(o.quality === undefined ? {} : { quality: o.quality }),
      ...(o.clip ? { clip: { x: 0, y: 0, ...o.clip } } : {}),
    });
    return Buffer.from(r.data, "base64");
  }

  /** A pointer drag through the points (CSS px of the viewport). */
  async drag(points: [number, number][]): Promise<void> {
    const [first, ...rest] = points;
    if (!first) return;
    const ev = (type: string, [x, y]: [number, number]) =>
      this.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
    await ev("touchStart", first);
    for (const p of rest) await ev("touchMove", p);
    await ev("touchEnd", rest.at(-1) ?? first);
  }

  close(): void {
    this.#closed = true;
    this.#ws.close();
  }
}

/** The profiles' prefix in the temp directory. */
const PREFIX = "classes-chrome-";

/** The browsers this process started: closed when it exits, whichever way. */
const live = new Set<Browser>();
process.on("exit", () => {
  for (const b of live) b.close();
});

/**
 * Deletes the profiles of browsers that are gone (an earlier run that did
 * not get to close its browser): Chrome's `SingletonLock` names its process.
 */
function sweep(): void {
  const root = tmpdir();
  for (const name of readdirSync(root)) {
    if (!name.startsWith(PREFIX)) continue;
    const dir = join(root, name);
    try {
      let pid = 0;
      try {
        pid = Number(readlinkSync(join(dir, "SingletonLock")).split("-").pop());
      } catch {
        // No lock: a browser still starting, or one that never did.
        if (Date.now() - statSync(dir).mtimeMs < 60_000) continue;
      }
      if (pid > 0 && running(pid)) continue;
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Gone already, or not ours to delete.
    }
  }
}

function remove(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Left for a later run's `sweep`.
  }
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class Browser {
  readonly #proc: ChildProcess;
  #port: number;
  readonly #dir: string;

  private constructor(proc: ChildProcess, port: number, dir: string) {
    this.#proc = proc;
    this.#port = port;
    this.#dir = dir;
  }

  /**
   * Starts a headless Chrome with a fresh profile. It ends with this
   * process however that ends: `close()` on exit, and Chrome quits when its
   * DevTools pipe (fds 3 and 4, otherwise unused) closes, even when this
   * process is killed.
   */
  static async launch(): Promise<Browser> {
    sweep();
    const dir = mkdtempSync(join(tmpdir(), PREFIX));
    const proc = spawn(
      CHROME,
      [
        "--headless=new",
        // Port 0: Chrome picks a free one and writes it to DevToolsActivePort.
        "--remote-debugging-port=0",
        "--remote-debugging-pipe",
        `--user-data-dir=${dir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--autoplay-policy=no-user-gesture-required",
        // Every tab animates as if it were in front (the TV and the phone side by side).
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--disable-backgrounding-occluded-windows",
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] },
    );
    const browser = new Browser(proc, 0, dir);
    live.add(browser);
    const end = Date.now() + 15000;
    for (;;) {
      try {
        const port = Number(readFileSync(join(dir, "DevToolsActivePort"), "utf8").split("\n")[0]);
        if (port > 0) {
          await fetch(`http://127.0.0.1:${port}/json/version`);
          browser.#port = port;
          return browser;
        }
      } catch {
        // Not up yet.
      }
      if (Date.now() > end || proc.exitCode !== null || proc.signalCode !== null) {
        browser.close();
        throw new Error("Chrome did not start");
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** A tab at a viewport; `locale` (`de-DE`) for its language (`navigator.language`, Intl). */
  async open(url: string, view: { width: number; height: number; mobile?: boolean; locale?: string }): Promise<Tab> {
    // A window of its own: headless Chrome renders (and animates) only the front tab of a window.
    const version = (await (await fetch(`http://127.0.0.1:${this.#port}/json/version`)).json()) as { webSocketDebuggerUrl: string };
    const root = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((r, j) => {
      root.onopen = r;
      root.onerror = j;
    });
    const targetId = await new Promise<string>((resolve, reject) => {
      root.onmessage = (e) => {
        const msg = JSON.parse(String(e.data));
        if (msg.id !== 1) return;
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result.targetId);
      };
      root.send(JSON.stringify({ id: 1, method: "Target.createTarget", params: { url: "about:blank", newWindow: true } }));
    });
    root.close();
    const list = (await (await fetch(`http://127.0.0.1:${this.#port}/json/list`)).json()) as { id: string; webSocketDebuggerUrl: string }[];
    const t = list.find((x) => x.id === targetId);
    if (!t) throw new Error("the new window has no target");
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r, j) => {
      ws.onopen = r;
      ws.onerror = j;
    });
    const tab = new Tab(ws);
    await tab.send("Page.enable");
    await tab.watch();
    await tab.send("Emulation.setDeviceMetricsOverride", {
      width: view.width,
      height: view.height,
      deviceScaleFactor: view.mobile ? 2 : 1,
      mobile: view.mobile ?? false,
    });
    if (view.mobile) await tab.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    if (view.locale) {
      const { userAgent } = (await tab.send("Browser.getVersion")) as { userAgent: string };
      await tab.send("Emulation.setUserAgentOverride", { userAgent, acceptLanguage: view.locale });
      await tab.send("Emulation.setLocaleOverride", { locale: view.locale });
    }
    await tab.send("Page.navigate", { url });
    return tab;
  }

  /** Stops Chrome; its profile goes once it has exited (or with a later run's `sweep`). */
  close(): void {
    if (!live.delete(this)) return;
    const dir = this.#dir;
    if (this.#proc.exitCode === null && this.#proc.signalCode === null) {
      this.#proc.once("exit", () => remove(dir));
      this.#proc.kill();
    } else {
      remove(dir);
    }
  }
}
