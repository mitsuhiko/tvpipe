/**
 * tvpipe for Node: stream video and audio to AirPlay and Google Cast
 * receivers and browser tabs. See README.md.
 *
 * @module
 */

export {
  discover,
  pair,
  unpair,
  play,
  testPattern,
  preview,
  share,
  stream,
  version,
  type Device,
  type DiscoverOptions,
  type PairOptions,
  type PairResult,
  type PinCallback,
  type PinRequest,
  type Target,
  type PlayerOptions,
  type CommonOptions,
  type PlayOptions,
  type ShareOptions,
  type StreamOptions,
  type Encoder,
  type Input,
} from "./api.ts";
export { tunnel, qr, QrCode, TunnelSession, type TunnelOptions } from "./tunnel.ts";
export { resolveBinary, platformPackage, PLATFORMS, BINARY_ENV, type Platform, type BinaryOptions } from "./binary.ts";
export type { CanvasLike, Context2DLike, ImageDataLike } from "./canvas.ts";
export { TvpipeError, type TvpipeErrorCode, type TvpipeErrorOptions } from "./errors.ts";
export type * from "./events.ts";
export { PROTOCOL, type ProcessOptions } from "./process.ts";
export { Session, PageSession, PlaySession, type EndInfo, type ReceiverInfo, type SessionEvents, type SessionOptions, type StartedInfo } from "./session.ts";
export {
  StreamSession,
  type AudioSpec,
  type EncodedVideoChunkLike,
  type EncodedVideoChunkMetadataLike,
  type EncodedVideoSpec,
  type PixelFormat,
  type Pts,
  type RawVideoSpec,
  type StreamSessionOptions,
  type VideoSpec,
} from "./stream.ts";
