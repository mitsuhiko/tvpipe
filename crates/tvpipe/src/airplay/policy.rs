//! Receiver-dependent choices of a mirroring session: feature bits,
//! timing protocol, audio format, canvas, latency leads and the initial
//! volume (spec §2.3–§2.7, §4.9, §8.9).
//!
//! Sources: docs/airplay-mirroring.md §2.3–§2.7, §4.9, §8.9; vectors
//! tests/vectors/airplay-mirror/appletv-session.txt (`/info` bodies).

use crate::airplay::info::Info;
use crate::airplay::setup::AudioCodecId;
use crate::codec::bplist::{Dict, Plist};
use crate::error::{Error, Result};

/// `/info` feature bit indices (§2.3).
pub mod bit {
    pub const SCREEN_MIRRORING: u32 = 7;
    pub const FAIRPLAY_SAP: u32 = 14;
    pub const AUDIO_PCM: u32 = 18;
    pub const AUDIO_ALAC: u32 = 19;
    pub const AUDIO_AAC_LC: u32 = 20;
    pub const AUDIO_AAC_ELD: u32 = 21;
    pub const THIRD_PARTY_A: u32 = 26;
    pub const SCREEN_1080P: u32 = 28;
    pub const VOLUME_CONTROL: u32 = 32;
    pub const PTP: u32 = 41;
    pub const MULTI_CODEC: u32 = 42;
    pub const THIRD_PARTY_TV: u32 = 49;
    pub const THIRD_PARTY_B: u32 = 51;
    pub const STREAM_CONNECTIONS: u32 = 59;
    pub const MEDIA_DATA_CONTROL: u32 = 60;
    pub const RFC2198: u32 = 61;
}

/// `supportedFormats.screenStream` bits (§2.4).
pub mod format {
    pub const PCM: u64 = 0x800;
    pub const ALAC: u64 = 0x4_0000;
    pub const AAC_LC: u64 = 0x40_0000;
    pub const AAC_ELD: u64 = 0x100_0000;
}

pub fn has(features: u64, bit: u32) -> bool {
    features >> bit & 1 == 1
}

/// `major.minor[.patch]`, numeric; `None` = unparsable ("too old").
pub fn parse_version(s: &str) -> Option<(u64, u64, u64)> {
    let parts: Vec<&str> = s.trim().split('.').collect();
    if !(2..=3).contains(&parts.len()) {
        return None;
    }
    let n = |i: usize| -> Option<u64> {
        match parts.get(i) {
            Some(p) => p.parse().ok(),
            None => Some(0),
        }
    };
    Some((n(0)?, n(1)?, n(2)?))
}

/// `version >= min` (unparsable = false).
pub fn version_at_least(version: Option<&str>, min: (u64, u64, u64)) -> bool {
    version.and_then(parse_version).is_some_and(|v| v >= min)
}

pub const PTP_MIN_VERSION: (u64, u64, u64) = (354, 54, 6);
pub const VOLUME_QUERY_MIN_VERSION: (u64, u64, u64) = (120, 2, 0);

/// `sourceVersion` from `/info`, else the version in `Server: AirTunes/x`.
pub fn source_version(info: &Info, server: Option<&str>) -> Option<String> {
    info.source_version.clone().or_else(|| {
        let s = server?;
        let i = s.find("AirTunes/")? + "AirTunes/".len();
        let v: String = s[i..]
            .chars()
            .take_while(|c| c.is_ascii_digit() || *c == '.')
            .collect();
        (!v.is_empty()).then_some(v)
    })
}

/// PTP iff HAP profile, feature 41 and sourceVersion ≥ 354.54.6 (§2.5).
pub fn use_ptp(hap: bool, features: u64, version: Option<&str>) -> bool {
    hap && has(features, bit::PTP) && version_at_least(version, PTP_MIN_VERSION)
}

/// The screen audio format mask (§2.4).
pub fn audio_mask(info: &Info) -> u64 {
    let sf = info.raw.get("supportedFormats");
    if sf.and_then(Plist::as_dict).is_some() {
        return info.supported_formats.screen_stream.unwrap_or(0);
    }
    let f = info.features;
    [
        (bit::AUDIO_PCM, format::PCM),
        (bit::AUDIO_ALAC, format::ALAC),
        (bit::AUDIO_AAC_LC, format::AAC_LC),
        (bit::AUDIO_AAC_ELD, format::AAC_ELD),
    ]
    .iter()
    .filter(|(b, _)| has(f, *b))
    .fold(0, |m, (_, v)| m | v)
}

/// The audio codec for a mask: ALAC when offered (or the mask is zero =
/// unknown), else AAC-ELD if we can encode it, else an error.
pub fn select_audio(mask: u64, have_aac_eld: bool) -> Result<AudioCodecId> {
    if mask == 0 || mask & format::ALAC != 0 {
        Ok(AudioCodecId::Alac)
    } else if mask & format::AAC_ELD != 0 && have_aac_eld {
        Ok(AudioCodecId::AacEld)
    } else if mask & format::AAC_ELD != 0 {
        Err(Error::unsupported(
            "airplay: receiver only offers AAC-ELD audio (use --no-audio)",
        ))
    } else {
        Err(Error::unsupported(format!(
            "airplay: no supported screen audio format (mask {mask:#x}; use --no-audio)"
        )))
    }
}

/// The receiver's canvas (§2.6).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Canvas {
    pub width: u32,
    pub height: u32,
    /// `maxFPS` of the display, if known.
    pub max_fps: Option<u32>,
    /// The decoder's maximum (`widthPixelsMax`×`heightPixelsMax`, at
    /// least the canvas): what an explicitly chosen resolution may use
    /// (§2.6).
    pub max_width: u32,
    pub max_height: u32,
    /// Whether `displays` was present.
    pub from_display: bool,
}

fn dim(d: &Dict, w: &str, h: &str) -> Option<(u32, u32)> {
    let v = |k: &str| {
        d.get(k)
            .and_then(Plist::as_i128)
            .and_then(|v| u32::try_from(v).ok())
            .filter(|&v| v > 0)
    };
    Some((v(w)?, v(h)?))
}

/// The H.264 canvas from an `/info` dict (§2.6).
pub fn canvas(info: &Plist, features: u64) -> Canvas {
    let display = info
        .get("displays")
        .and_then(Plist::as_array)
        .and_then(|a| a.first())
        .and_then(Plist::as_dict);
    let Some(d) = display else {
        let (width, height) =
            if has(features, bit::SCREEN_MIRRORING) && has(features, bit::SCREEN_1080P) {
                (1920, 1080)
            } else {
                (1280, 720)
            };
        return Canvas {
            width,
            height,
            max_fps: None,
            max_width: width,
            max_height: height,
            from_display: false,
        };
    };
    let nominal = dim(d, "widthPixels", "heightPixels")
        .or_else(|| dim(d, "width", "height"))
        .unwrap_or((1280, 720));
    let max = dim(d, "widthPixelsMax", "heightPixelsMax").unwrap_or(nominal);
    let (w, h) = if max.0 <= 1920 && max.1 <= 1080 {
        (nominal.0.max(max.0), nominal.1.max(max.1))
    } else {
        nominal
    };
    let (w, h) = (w & !1, h & !1);
    Canvas {
        width: w,
        height: h,
        max_width: (max.0 & !1).max(w),
        max_height: (max.1 & !1).max(h),
        max_fps: d
            .get("maxFPS")
            .and_then(Plist::as_i128)
            .and_then(|v| u32::try_from(v).ok())
            .filter(|&v| v > 0),
        from_display: true,
    }
}

/// The playout leads of a session (§2.7).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Leads {
    pub video_ms: u32,
    pub audio_ms: u32,
}

impl Leads {
    pub const NORMAL: Leads = Leads {
        video_ms: 75,
        audio_ms: 85,
    };
    pub const WIRELESS: Leads = Leads {
        video_ms: 100,
        audio_ms: 170,
    };

    /// An explicit user latency (clamped to 5–2000 ms), else the wireless
    /// profile. §2.7 allows either profile without a route query; the
    /// dev Apple TV reported ~1 audio glitch per second with the normal
    /// profile's 85 ms audio lead (its MediaDataControl `rrmt` reports,
    /// `RenderDeadlineMinMs` slightly negative) and none at 170 ms.
    pub fn new(explicit_ms: Option<u32>) -> Leads {
        match explicit_ms {
            Some(l) => {
                let l = l.clamp(5, 2000);
                Leads {
                    video_ms: l,
                    audio_ms: l,
                }
            }
            None => Leads::WIRELESS,
        }
    }

    /// A third-party TV carrying audio (§2.7).
    pub const THIRD_PARTY_TV: Leads = Leads {
        video_ms: 600,
        audio_ms: 600,
    };

    /// [`Leads::new`], or [`Leads::THIRD_PARTY_TV`] for `audio` on one.
    pub fn for_receiver(explicit_ms: Option<u32>, info: &Info, audio: bool) -> Leads {
        match explicit_ms {
            None if audio && third_party_tv(info) => Leads::THIRD_PARTY_TV,
            e => Leads::new(e),
        }
    }

    /// `latencyMax`: the audio lead in 44.1 kHz samples, truncated.
    pub fn audio_samples(&self) -> u32 {
        ms_to_samples(self.audio_ms)
    }
}

pub fn ms_to_samples(ms: u32) -> u32 {
    (ms as u64 * 44_100 / 1000) as u32
}

// ---------------------------------------------------------------------------
// Volume (§8.9)

pub const VOLUME_DEFAULT: f64 = -20.0;
pub const VOLUME_QUIET_TARGET: f64 = -27.0;
pub const VOLUME_MUTE: f64 = -144.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Corrections {
    quiet: bool,
    loud: bool,
    resend: bool,
}

/// Bit 26 or 51, and 49.
pub fn third_party_tv(info: &Info) -> bool {
    (has(info.features, bit::THIRD_PARTY_A) || has(info.features, bit::THIRD_PARTY_B))
        && has(info.features, bit::THIRD_PARTY_TV)
}

fn family(info: &Info) -> Corrections {
    let starts = |v: Option<&str>, p: &str| {
        v.and_then(|s| s.get(..p.len()))
            .is_some_and(|s| s.eq_ignore_ascii_case(p))
    };
    let model = info.model.as_deref();
    let manufacturer = info.raw.get("manufacturer").and_then(Plist::as_str);
    let third_party_tv = third_party_tv(info);
    let quiet_only = starts(model, "AppleTV") || starts(model, "AirPort");
    let invalid_only = starts(model, "AudioAccessory")
        || (!quiet_only && starts(manufacturer, "Apple"))
        || (!quiet_only && third_party_tv);
    if invalid_only && !quiet_only {
        Corrections {
            quiet: false,
            loud: false,
            resend: false,
        }
    } else if quiet_only {
        Corrections {
            quiet: true,
            loud: false,
            resend: false,
        }
    } else {
        Corrections {
            quiet: true,
            loud: true,
            resend: true,
        }
    }
}

/// The receiver's initial volume from `/info`, if it says.
pub fn info_volume(info: &Info) -> Option<f64> {
    info.raw.get("initialVolume").and_then(Plist::as_f64)
}

/// Whether to ask `GET_PARAMETER volume` (§4.9).
pub fn should_query_volume(info: &Info, version: Option<&str>, has_audio: bool) -> bool {
    has_audio
        && info_volume(info).is_none()
        && (has(info.features, bit::VOLUME_CONTROL)
            || version_at_least(version, VOLUME_QUERY_MIN_VERSION))
}

/// Parses a `volume: <float>` line from a `GET_PARAMETER` body.
pub fn parse_volume(body: &[u8]) -> Option<f64> {
    let text = std::str::from_utf8(body).ok()?;
    text.lines().find_map(|l| {
        let (k, v) = l.split_once(':')?;
        if !k.trim().eq_ignore_ascii_case("volume") {
            return None;
        }
        v.trim().parse::<f64>().ok()
    })
}

/// The `SET_PARAMETER` value to send at start, if any (§8.9). `initial`
/// is `/info`'s `initialVolume` (with `isMuted`) or the queried value.
pub fn initial_volume(info: &Info, initial: Option<f64>) -> Option<f64> {
    let fam = family(info);
    let muted_flag = info
        .raw
        .get("isMuted")
        .and_then(Plist::as_bool)
        .unwrap_or(false);
    let initial = if muted_flag {
        Some(VOLUME_MUTE)
    } else {
        initial
    };
    let (value, corrected) = match initial.filter(|v| v.is_finite()) {
        None => (VOLUME_DEFAULT, true),
        Some(v) => {
            let int = v.trunc();
            if int >= 0.0 && fam.loud {
                (VOLUME_DEFAULT, true)
            } else if int <= -30.0 && fam.quiet {
                (VOLUME_QUIET_TARGET, true)
            } else {
                (v, false)
            }
        }
    };
    let muted = !corrected && value == VOLUME_MUTE;
    (corrected || muted || fam.resend).then(|| outgoing_volume(value))
}

/// Clamps an outgoing value: anything but −144 outside −30…0 is −20.
pub fn outgoing_volume(v: f64) -> f64 {
    if v == VOLUME_MUTE || (-30.0..=0.0).contains(&v) {
        v
    } else {
        VOLUME_DEFAULT
    }
}

/// `volume: -20.000000\r\n`.
pub fn volume_body(v: f64) -> Vec<u8> {
    format!("volume: {v:.6}\r\n").into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::vectors;

    fn session_infos() -> Vec<Info> {
        vectors::load("airplay-mirror/appletv-session.txt")
            .iter()
            .filter(|b| b.name() == "Apple TV response to GET /info")
            .map(|b| Info::parse(&b.hex("response_bplist")).unwrap())
            .collect()
    }

    #[test]
    fn versions() {
        assert_eq!(parse_version("354.54.6"), Some((354, 54, 6)));
        assert_eq!(parse_version("220.68"), Some((220, 68, 0)));
        assert_eq!(parse_version("1"), None);
        assert_eq!(parse_version("1.2.3.4"), None);
        assert_eq!(parse_version("1.x"), None);
        assert!(version_at_least(Some("960.13.1"), PTP_MIN_VERSION));
        assert!(version_at_least(Some("354.54.6"), PTP_MIN_VERSION));
        assert!(!version_at_least(Some("354.54"), PTP_MIN_VERSION));
        assert!(version_at_least(Some("377.25.06"), PTP_MIN_VERSION));
        assert!(!version_at_least(None, PTP_MIN_VERSION));
    }

    #[test]
    fn appletv_choices() {
        let infos = session_infos();
        assert_eq!(infos.len(), 2);
        let (before, after) = (&infos[0], &infos[1]);
        assert_eq!(before.features, 0x3c17_7fde_4a7f_dfd5);
        let v = source_version(before, Some("AirTunes/960.13.1"));
        assert!(use_ptp(true, before.features, v.as_deref()));
        assert!(!use_ptp(false, before.features, v.as_deref()));
        assert_eq!(audio_mask(before), 0x144_0800);
        assert_eq!(
            select_audio(audio_mask(before), false).unwrap(),
            AudioCodecId::Alac
        );
        for b in [
            bit::FAIRPLAY_SAP,
            bit::STREAM_CONNECTIONS,
            bit::RFC2198,
            bit::MULTI_CODEC,
        ] {
            assert!(has(before.features, b), "bit {b}");
        }
        // Before a session: no displays, and no feature 28: 720p default.
        let c = canvas(&before.raw, before.features);
        assert!(!c.from_display);
        assert_eq!((c.width, c.height), (1280, 720));
        assert_eq!(
            (canvas(&before.raw, before.features | 1 << bit::SCREEN_1080P)).width,
            1920
        );
        // After SETUP #1: 1280x720 nominal, 4K max, so 1280x720; the
        // decoder's 4K for an explicit choice.
        let c = canvas(&after.raw, after.features);
        assert!(c.from_display);
        assert_eq!((c.width, c.height, c.max_fps), (1280, 720, Some(60)));
        assert_eq!((c.max_width, c.max_height), (3840, 2160));
        // initialVolume 0.0 is "loud", not corrected for Apple TVs: no volume sent.
        assert_eq!(info_volume(before), Some(0.0));
        assert_eq!(initial_volume(before, info_volume(before)), None);
        assert!(!should_query_volume(before, v.as_deref(), true));
    }

    #[test]
    fn server_header_version() {
        let mut info = session_infos().remove(0);
        info.source_version = None;
        assert_eq!(
            source_version(&info, Some("AirTunes/377.25.06")).as_deref(),
            Some("377.25.06")
        );
        assert_eq!(source_version(&info, Some("nginx")), None);
    }

    #[test]
    fn canvas_rules() {
        let disp = |d: Plist| Plist::dict().with("displays", Plist::array([d]));
        let c = canvas(
            &disp(
                Plist::dict()
                    .with("widthPixels", 1280i64)
                    .with("heightPixels", 720i64)
                    .with("widthPixelsMax", 1920i64)
                    .with("heightPixelsMax", 1080i64),
            ),
            0,
        );
        assert_eq!((c.width, c.height), (1920, 1080));
        assert_eq!((c.max_width, c.max_height), (1920, 1080));
        let c = canvas(
            &disp(Plist::dict().with("width", 1001i64).with("height", 701i64)),
            0,
        );
        assert_eq!((c.width, c.height), (1000, 700));
        assert_eq!((c.max_width, c.max_height), (1000, 700));
        let c = canvas(&Plist::dict(), 1 << bit::SCREEN_MIRRORING);
        assert_eq!((c.width, c.height), (1280, 720));
        assert_eq!((c.max_width, c.max_height), (1280, 720));
        // A 4K TV: nominal 3840x2160 is the canvas.
        let c = canvas(
            &disp(
                Plist::dict()
                    .with("widthPixels", 3840i64)
                    .with("heightPixels", 2160i64)
                    .with("widthPixelsMax", 3840i64)
                    .with("heightPixelsMax", 2160i64),
            ),
            0,
        );
        assert_eq!((c.width, c.height, c.max_width), (3840, 2160, 3840));
    }

    #[test]
    fn audio_selection() {
        assert_eq!(select_audio(0, false).unwrap(), AudioCodecId::Alac);
        assert_eq!(
            select_audio(format::ALAC, false).unwrap(),
            AudioCodecId::Alac
        );
        assert_eq!(
            select_audio(format::AAC_ELD, true).unwrap(),
            AudioCodecId::AacEld
        );
        let e = select_audio(format::AAC_ELD, false).unwrap_err();
        assert!(e.to_string().contains("AAC-ELD"), "{e}");
        assert!(select_audio(format::PCM, true).is_err());
    }

    #[test]
    fn leads() {
        assert_eq!(Leads::NORMAL.audio_samples(), 3748);
        assert_eq!(Leads::new(None), Leads::WIRELESS);
        assert_eq!(Leads::WIRELESS.audio_samples(), 7497);
        assert_eq!(ms_to_samples(100), 4410);
        assert_eq!(ms_to_samples(75), 3307);
        assert_eq!(Leads::new(Some(1)).video_ms, 5);
        assert_eq!(Leads::new(Some(5000)).audio_ms, 2000);
        let tv_bits = 1 << bit::THIRD_PARTY_B | 1 << bit::THIRD_PARTY_TV;
        let lg = info_with("55UA84006LB.DFUYLWE", tv_bits, &[]);
        assert_eq!(Leads::for_receiver(None, &lg, true), Leads::THIRD_PARTY_TV);
        assert_eq!(Leads::for_receiver(None, &lg, false), Leads::WIRELESS);
        assert_eq!(Leads::for_receiver(Some(1000), &lg, true).video_ms, 1000);
        let speaker = info_with("Sonos", 1 << bit::THIRD_PARTY_B, &[]);
        assert_eq!(Leads::for_receiver(None, &speaker, true), Leads::WIRELESS);
        let atv = info_with("AppleTV6,2", 0, &[]);
        assert_eq!(Leads::for_receiver(None, &atv, true), Leads::WIRELESS);
    }

    fn info_with(model: &str, features: u64, extra: &[(&str, Plist)]) -> Info {
        let mut d = Plist::dict()
            .with("model", model)
            .with("features", features as i64);
        for (k, v) in extra {
            d = d.with(*k, v.clone());
        }
        Info::from_plist(d).unwrap()
    }

    #[test]
    fn volume_policy() {
        let atv = info_with("AppleTV6,2", 0, &[]);
        assert_eq!(initial_volume(&atv, None), Some(-20.0));
        assert_eq!(initial_volume(&atv, Some(f64::NAN)), Some(-20.0));
        assert_eq!(initial_volume(&atv, Some(-35.0)), Some(-27.0));
        assert_eq!(initial_volume(&atv, Some(-10.0)), None);
        assert_eq!(initial_volume(&atv, Some(0.0)), None);
        let homepod = info_with("AudioAccessory5,1", 0, &[]);
        // Not corrected, so −144 means muted and is sent.
        assert_eq!(initial_volume(&homepod, Some(-144.0)), Some(-144.0));
        let tv_bits = 1 << bit::THIRD_PARTY_A | 1 << bit::THIRD_PARTY_TV;
        let lg = info_with("OLED55", tv_bits, &[]);
        assert_eq!(initial_volume(&lg, Some(-5.0)), None);
        assert_eq!(initial_volume(&lg, None), Some(-20.0));
        let other = info_with("Roku", 0, &[]);
        assert_eq!(initial_volume(&other, Some(-5.0)), Some(-5.0));
        assert_eq!(initial_volume(&other, Some(3.0)), Some(-20.0));
        assert_eq!(initial_volume(&other, Some(-40.0)), Some(-27.0));
        let muted = info_with("Roku", 0, &[("isMuted", Plist::Bool(true))]);
        assert_eq!(initial_volume(&muted, Some(-5.0)), Some(-27.0));
        let apple = info_with("Mac", 0, &[("manufacturer", Plist::from("Apple Inc."))]);
        assert_eq!(initial_volume(&apple, Some(5.0)), None);
        assert_eq!(volume_body(-20.0), b"volume: -20.000000\r\n");
        assert_eq!(parse_volume(b"Volume: -11.5\r\n"), Some(-11.5));
        assert_eq!(parse_volume(b"volume: x\r\n"), None);
        assert_eq!(outgoing_volume(-31.0), -20.0);
        assert!(should_query_volume(&other, Some("120.2"), true));
        assert!(!should_query_volume(&other, Some("120.1"), true));
        assert!(!should_query_volume(&other, Some("120.2"), false));
    }
}
