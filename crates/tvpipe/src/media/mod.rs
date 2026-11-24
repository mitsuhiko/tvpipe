//! Media pipeline: ffmpeg subprocess, Matroska demux, H.264, raw game
//! input, media clock, fanout.

#[cfg(feature = "aac")]
pub mod aacenc;
#[cfg(not(feature = "aac"))]
#[path = "aacenc_off.rs"]
pub mod aacenc;
pub mod abr;
#[cfg(feature = "h264")]
pub mod builtin;
pub mod clock;
pub mod convert;
#[cfg(feature = "ffmpeg")]
pub mod debug;
pub mod fanout;
#[cfg(feature = "ffmpeg")]
pub mod ffmpeg;
pub mod formats;
pub mod h264;
#[cfg(feature = "h264")]
pub mod h264enc;
#[cfg(feature = "files")]
pub mod h264skip;
pub mod input;
#[cfg(feature = "files")]
pub mod mkv;
#[cfg(feature = "files")]
pub mod mp4;
#[cfg(feature = "files")]
pub mod passthrough;
#[cfg(feature = "ffmpeg")]
pub mod rawin;
#[cfg(feature = "ffmpeg")]
pub mod screencap;
pub mod slrw;
#[cfg(feature = "files")]
pub mod source;
