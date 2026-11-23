/**
 * Ties child processes (the `tvpipe game play` of a live check) to this
 * one: they end when it ends, however it ends. `finally` and exit handlers
 * do not run when the process is killed (a timeout, `kill -9`), and a child
 * outlives its parent by default.
 *
 *   const proc = tie(spawn(binary, args));
 *
 * A watchdog (a second Node, detached so it outlives this process and its
 * process group) reads the children's process ids on a pipe from here and
 * stops them when the pipe closes: when this process is gone.
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { Socket } from "node:net";

/** `+PID` ties, `-PID` unties (it exited: its number may come back). */
const WATCHDOG = `
const pids = new Set();
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  for (let i; (i = buf.indexOf("\\n")) >= 0; buf = buf.slice(i + 1)) {
    const n = Number(buf.slice(1, i));
    if (buf[0] === "+") pids.add(n);
    else pids.delete(n);
  }
});
process.stdin.on("error", () => {});
process.stdin.on("close", () => {
  for (const pid of pids) {
    try {
      process.kill(pid);
    } catch {}
  }
});
`;

let watchdog: ChildProcess | undefined;

function tell(line: string): void {
  if (!watchdog) {
    watchdog = spawn(process.execPath, ["-e", WATCHDOG], { stdio: ["pipe", "ignore", "ignore"], detached: true, windowsHide: true });
    // Neither the watchdog nor its pipe keeps this process alive.
    watchdog.unref();
    (watchdog.stdin as Socket).unref();
    watchdog.stdin!.on("error", () => {});
  }
  watchdog.stdin!.write(line);
}

/** Stops `child` (SIGTERM) when this process ends; `child` for chaining. */
export function tie(child: ChildProcess): ChildProcess {
  const pid = child.pid;
  if (pid === undefined) return child;
  tell(`+${pid}\n`);
  child.once("exit", () => tell(`-${pid}\n`));
  return child;
}
