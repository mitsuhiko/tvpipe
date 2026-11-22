/**
 * Errors of the SDK. Every failure is a {@link TvpipeError} with a human
 * message and a stable `code` to branch on.
 */

/**
 * Stable error codes. The binary's codes (docs/machine.md) plus the SDK's
 * own; unknown failures use the binary's error kind (`io`, `auth`, …).
 */
export type TvpipeErrorCode =
  // The binary's (docs/machine.md).
  | "pairing-required"
  | "home-only"
  | "forbidden"
  | "password-unsupported"
  | "no-receiver"
  | "input-not-found"
  | "ffmpeg-missing"
  | "pin-missing"
  | "bad-input"
  | "fairplay-required"
  | "feature-disabled"
  // The SDK's.
  | "binary-missing"
  | "unsupported-platform"
  | "protocol-mismatch"
  | "no-receivers"
  | "ambiguous-receiver"
  | "pairing-failed"
  | "aborted"
  | "exited"
  | "invalid-argument"
  | "closed"
  // The binary's error kinds, when there is no more specific code.
  | "io"
  | "malformed"
  | "protocol"
  | "crypto"
  | "auth"
  | "unsupported"
  | "timeout"
  | "not-found"
  | "process"
  | "usage"
  | "unimplemented"
  | (string & {});

export interface TvpipeErrorOptions {
  /** The binary's error kind (`auth`, `not-found`, …), when it reported one. */
  kind?: string;
  /** The receiver the error is about. */
  device?: string;
  /** The process's exit code, when it exited. */
  exitCode?: number | null;
  /** The last log lines and stderr output of the process. */
  log?: string[];
  cause?: unknown;
  /** Extra data, e.g. the receivers found for `ambiguous-receiver`. */
  details?: Record<string, unknown>;
}

export class TvpipeError extends Error {
  override name = "TvpipeError";
  readonly code: TvpipeErrorCode;
  readonly kind: string | undefined;
  readonly device: string | undefined;
  readonly exitCode: number | null | undefined;
  readonly log: string[];
  readonly details: Record<string, unknown>;

  constructor(code: TvpipeErrorCode, message: string, options: TvpipeErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.kind = options.kind;
    this.device = options.device;
    this.exitCode = options.exitCode;
    this.log = options.log ?? [];
    this.details = options.details ?? {};
  }
}
