//! The share page's WebSocket protocol (docs/share-protocol.md).
//!
//! Binary messages are single SLRW records (docs/slrw.md): `u8 kind |
//! u64le pts_us | u32le len | payload`, with `len` equal to the rest of
//! the message. Text messages are JSON objects with a `type`.

use crate::codec::json::Value;
use crate::error::{Error, Result};
use crate::media::slrw::{self, Kind, Packet};

/// Protocol version (both directions say it in `hello` / `config`).
pub const VERSION: u32 = 1;

/// Largest WebSocket message we take: a keyframe plus the record header.
pub const MAX_MESSAGE: usize = 16 << 20;
/// Largest PCM record (a page sends ~10 ms per record).
const MAX_AUDIO: u32 = 1 << 20;

const HEADER: usize = 13;

/// One binary message as an SLRW record. Only the kinds a page sends are
/// accepted: `audio`, `h264`, `h264-config`, `end`.
pub fn parse_record(msg: &[u8]) -> Result<Packet> {
    if msg.len() < HEADER {
        return Err(Error::malformed(format!(
            "share: binary message of {} bytes is shorter than a record header",
            msg.len()
        )));
    }
    let kind = Kind::from_code(msg[0])
        .ok_or_else(|| Error::malformed(format!("share: unknown record kind {}", msg[0])))?;
    let mut pts = [0u8; 8];
    pts.copy_from_slice(&msg[1..9]);
    let len = u32::from_le_bytes([msg[9], msg[10], msg[11], msg[12]]);
    let payload = &msg[HEADER..];
    if len as usize != payload.len() {
        return Err(Error::malformed(format!(
            "share: record says {len} bytes, message has {}",
            payload.len()
        )));
    }
    let (min, max) = match kind {
        Kind::Audio => (0, MAX_AUDIO),
        Kind::H264 => (1, slrw::MAX_H264_PAYLOAD),
        Kind::H264Config => (1, slrw::MAX_CONFIG_PAYLOAD),
        Kind::End => (0, 0),
        Kind::Video | Kind::Control => {
            return Err(Error::malformed(format!(
                "share: {kind:?} records are not part of the share protocol"
            )))
        }
    };
    if len < min || len > max {
        return Err(Error::malformed(format!(
            "share: {kind:?} record of {len} bytes (allowed {min}..={max})"
        )));
    }
    Ok(Packet {
        kind,
        pts_us: u64::from_le_bytes(pts),
        payload: payload.to_vec(),
    })
}

/// A record as the page builds it (for the tests' fake page).
pub fn record(kind: Kind, pts_us: u64, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(HEADER + payload.len());
    // Writing to a Vec cannot fail.
    let _ = slrw::write_packet(&mut out, kind, pts_us, payload);
    out
}

/// What the page captured (`capture`).
#[derive(Debug, Clone, PartialEq)]
pub struct CaptureInfo {
    pub width: u32,
    pub height: u32,
    /// The track's frame rate, if the browser says.
    pub fps: Option<f64>,
    /// Whether the share includes an audio track.
    pub audio: bool,
    /// `browser`, `window` or `monitor` (displaySurface).
    pub surface: Option<String>,
    pub label: Option<String>,
    /// Set by tvpipe (not the page): the capture came over the tunnel.
    pub remote: Option<Remote>,
}

/// Who shares over the tunnel (`share --tunnel`), for the local
/// confirmation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Remote {
    /// The visitor's address, as the tunnel reports it.
    pub peer: Option<String>,
    /// The page's user agent (from its `hello`; the page says so itself).
    pub agent: String,
}

/// A text message from the page.
#[derive(Debug, Clone, PartialEq)]
pub enum PageMsg {
    Hello {
        version: u32,
        /// The page's media clock (µs) when it sent this.
        clock_us: u64,
        agent: String,
    },
    Capture(CaptureInfo),
    Stats(Value),
    /// The share ended (the user stopped it, the track ended, an error).
    Ended(String),
    Log {
        level: String,
        message: String,
    },
    /// This socket carries the records of the page that was given `key`
    /// (the page's worker sends them without passing the page's thread).
    Media {
        key: String,
    },
    /// A type this version does not know (ignored).
    Unknown(String),
}

fn opt_str(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::to_owned)
}

/// Clamps a JSON number to a non-negative integer.
fn uint(v: &Value, key: &str, max: u64) -> Result<u64> {
    let n = v.require_f64(key)?;
    if !n.is_finite() || n < 0.0 {
        return Err(Error::malformed(format!("share: {key} is not a size")));
    }
    Ok((n as u64).min(max))
}

pub fn parse_page(text: &str) -> Result<PageMsg> {
    let v = Value::parse(text)?;
    let ty = v.require_str("type")?;
    Ok(match ty {
        "hello" => PageMsg::Hello {
            version: v.get("version").and_then(Value::as_u32).unwrap_or(0),
            clock_us: uint(&v, "clock", u64::MAX / 2)?,
            agent: opt_str(&v, "agent").unwrap_or_default(),
        },
        "capture" => {
            let (width, height) = (uint(&v, "width", 16384)?, uint(&v, "height", 16384)?);
            if width < 2 || height < 2 {
                return Err(Error::malformed("share: capture without a size"));
            }
            PageMsg::Capture(CaptureInfo {
                width: width as u32,
                height: height as u32,
                fps: v
                    .get("fps")
                    .and_then(Value::as_f64)
                    .filter(|f| f.is_finite() && *f > 0.0),
                audio: v.get("audio").and_then(Value::as_bool).unwrap_or(false),
                surface: opt_str(&v, "surface"),
                label: opt_str(&v, "label"),
                remote: None,
            })
        }
        "stats" => PageMsg::Stats(v),
        "ended" => PageMsg::Ended(opt_str(&v, "reason").unwrap_or_else(|| "share ended".into())),
        "log" => PageMsg::Log {
            level: opt_str(&v, "level").unwrap_or_else(|| "info".into()),
            message: opt_str(&v, "message").unwrap_or_default(),
        },
        "media" => PageMsg::Media {
            key: v.require_str("key")?.to_owned(),
        },
        other => PageMsg::Unknown(other.to_owned()),
    })
}

/// What the page should ask `getDisplayMedia` for (`config`).
#[derive(Debug, Clone, PartialEq)]
pub struct PageConfig {
    pub fps: f64,
    pub audio: bool,
    pub sample_rate: u32,
    pub channels: u8,
    pub receivers: Vec<String>,
}

impl PageConfig {
    pub fn to_json(&self) -> String {
        Value::object()
            .with("type", "config")
            .with("version", VERSION as i64)
            .with("fps", self.fps)
            .with("audio", self.audio)
            .with("sampleRate", self.sample_rate as i64)
            .with("channels", self.channels as i64)
            .with(
                "receivers",
                Value::array(self.receivers.iter().map(String::as_str)),
            )
            .to_json()
    }
}

/// The encode the page runs (`plan`).
#[derive(Debug, Clone, PartialEq)]
pub struct SharePlan {
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub bitrate_bps: u64,
    /// IDR interval in frames.
    pub key_interval: u32,
    /// PCM rate and channels, or no audio.
    pub audio: Option<(u32, u8)>,
    /// Where the capture goes in the frame (the rest is black).
    pub content: crate::browser::layout::Rect,
}

impl SharePlan {
    pub fn to_json(&self) -> String {
        Value::object()
            .with("type", "plan")
            .with("width", self.width as i64)
            .with("height", self.height as i64)
            .with("fps", self.fps)
            .with("bitrate", self.bitrate_bps as i64)
            .with("keyInterval", self.key_interval as i64)
            .with(
                "audio",
                match self.audio {
                    Some((rate, ch)) => Value::object()
                        .with("sampleRate", rate as i64)
                        .with("channels", ch as i64),
                    None => Value::Null,
                },
            )
            .with(
                "content",
                Value::object()
                    .with("x", self.content.x)
                    .with("y", self.content.y)
                    .with("width", self.content.width)
                    .with("height", self.content.height),
            )
            .to_json()
    }
}

/// `{"type":"status",...}`: what tvpipe is doing, for the page's display.
pub fn status(state: &str, message: &str, receivers: &[String]) -> String {
    Value::object()
        .with("type", "status")
        .with("state", state)
        .with("message", message)
        .with(
            "receivers",
            Value::array(receivers.iter().map(String::as_str)),
        )
        .to_json()
}

pub fn keyframe() -> String {
    Value::object().with("type", "keyframe").to_json()
}

/// The encoder's new target (adaptive bitrate), bit/s.
pub fn bitrate(bps: u64) -> String {
    Value::object()
        .with("type", "bitrate")
        .with("bitrate", bps as i64)
        .to_json()
}

/// The key a page's worker opens its media socket with (`channel`).
pub fn channel(key: &str) -> String {
    Value::object()
        .with("type", "channel")
        .with("key", key)
        .to_json()
}

/// The media socket's key was taken (`media`).
pub fn media_ok() -> String {
    Value::object().with("type", "media").to_json()
}

pub fn busy() -> String {
    Value::object().with("type", "busy").to_json()
}

pub fn end(reason: &str) -> String {
    Value::object()
        .with("type", "end")
        .with("reason", reason)
        .to_json()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records() {
        let r = record(Kind::H264, 0x0102_0304_0506, &[1, 0, 0, 0, 1, 0x65]);
        assert_eq!(
            r,
            [3, 6, 5, 4, 3, 2, 1, 0, 0, 6, 0, 0, 0, 1, 0, 0, 0, 1, 0x65]
        );
        let p = parse_record(&r).unwrap();
        assert_eq!((p.kind, p.pts_us), (Kind::H264, 0x0102_0304_0506));
        assert_eq!(p.payload, &r[13..]);
        assert_eq!(
            parse_record(&record(Kind::End, 5, &[])).unwrap().kind,
            Kind::End
        );
        assert_eq!(
            parse_record(&record(Kind::Audio, 5, &[0; 8]))
                .unwrap()
                .payload
                .len(),
            8
        );
        // Length mismatches, kinds that do not belong, empty payloads.
        let mut bad = r.clone();
        bad.push(0);
        assert!(parse_record(&bad).is_err());
        assert!(parse_record(&r[..12]).is_err());
        assert!(parse_record(&r[..r.len() - 1]).is_err());
        assert!(parse_record(&record(Kind::Video, 0, &[0; 4])).is_err());
        assert!(parse_record(&record(Kind::Control, 0, &[1, 0, 0, 0])).is_err());
        assert!(parse_record(&record(Kind::H264, 0, &[])).is_err());
        assert!(parse_record(&record(Kind::H264Config, 0, &[])).is_err());
        assert!(parse_record(&record(Kind::End, 0, &[1])).is_err());
        let mut unknown = record(Kind::End, 0, &[]);
        unknown[0] = 99;
        assert!(parse_record(&unknown).is_err());
    }

    #[test]
    fn page_messages() {
        assert_eq!(
            parse_page(r#"{"type":"hello","version":1,"clock":1234.5,"agent":"x"}"#).unwrap(),
            PageMsg::Hello {
                version: 1,
                clock_us: 1234,
                agent: "x".into()
            }
        );
        let PageMsg::Capture(c) = parse_page(
            r#"{"type":"capture","width":1920,"height":1080,"fps":30,"audio":true,"surface":"browser"}"#,
        )
        .unwrap() else {
            panic!()
        };
        assert_eq!(
            (c.width, c.height, c.fps, c.audio),
            (1920, 1080, Some(30.0), true)
        );
        assert_eq!(c.surface.as_deref(), Some("browser"));
        assert!(parse_page(r#"{"type":"capture","width":0,"height":10}"#).is_err());
        assert!(parse_page(r#"{"type":"capture","width":-5,"height":10}"#).is_err());
        assert!(parse_page(r#"{"type":"hello"}"#).is_err());
        assert_eq!(
            parse_page(r#"{"type":"ended"}"#).unwrap(),
            PageMsg::Ended("share ended".into())
        );
        assert_eq!(
            parse_page(r#"{"type":"future"}"#).unwrap(),
            PageMsg::Unknown("future".into())
        );
        assert_eq!(
            parse_page(r#"{"type":"media","key":"ab12"}"#).unwrap(),
            PageMsg::Media { key: "ab12".into() }
        );
        assert!(parse_page(r#"{"type":"media"}"#).is_err());
        assert!(parse_page("[1]").is_err());
        assert!(parse_page("not json").is_err());
    }

    #[test]
    fn server_messages() {
        let p = SharePlan {
            width: 1280,
            height: 720,
            fps: 30.0,
            bitrate_bps: 4_000_000,
            key_interval: 15,
            audio: Some((44100, 2)),
            content: crate::browser::layout::Rect {
                x: 160,
                y: 0,
                width: 960,
                height: 720,
            },
        };
        assert_eq!(
            p.to_json(),
            r#"{"type":"plan","width":1280,"height":720,"fps":30.0,"bitrate":4000000,"keyInterval":15,"audio":{"sampleRate":44100,"channels":2},"content":{"x":160,"y":0,"width":960,"height":720}}"#
        );
        let c = PageConfig {
            fps: 30.0,
            audio: false,
            sample_rate: 48000,
            channels: 2,
            receivers: vec!["TV".into()],
        };
        assert_eq!(
            c.to_json(),
            r#"{"type":"config","version":1,"fps":30.0,"audio":false,"sampleRate":48000,"channels":2,"receivers":["TV"]}"#
        );
        assert_eq!(keyframe(), r#"{"type":"keyframe"}"#);
        assert_eq!(channel("ab12"), r#"{"type":"channel","key":"ab12"}"#);
        assert_eq!(media_ok(), r#"{"type":"media"}"#);
    }
}
