//! AirPlay TXT record parsing for `_airplay._tcp` and `_raop._tcp`
//! (ARCHITECTURE.md, "Discovery").
//!
//! Key names, the feature-string format and the bit meanings follow pyatv
//! (MIT): `pyatv/protocols/airplay/utils.py` (`parse_features`,
//! `AirPlayFlags`, `PIN_REQUIRED`, `PASSWORD_BIT`, `LEGACY_PAIRING_BIT`,
//! `is_password_required`).
//!
//! Parsing is lenient: a malformed value is logged and left unset rather
//! than dropping the whole service.

use crate::airplay::pairing::PinKind;
use crate::error::{Error, Result};

/// Feature bits from the `features` / `ft` TXT key (pyatv `AirPlayFlags`).
pub mod features {
    pub const VIDEO_V1: u64 = 1 << 0;
    pub const PHOTO: u64 = 1 << 1;
    pub const SCREEN: u64 = 1 << 7;
    pub const AUDIO: u64 = 1 << 9;
    pub const AUDIO_REDUNDANT: u64 = 1 << 11;
    /// FairPlay authentication ("Authentication_4").
    pub const FAIRPLAY_AUTH: u64 = 1 << 14;
    /// RSA authentication ("Authentication_1").
    pub const RSA_AUTH: u64 = 1 << 23;
    /// MFi authentication ("Authentication_8").
    pub const MFI_AUTH: u64 = 1 << 26;
    pub const LEGACY_PAIRING: u64 = 1 << 27;
    pub const UNIFIED_ADVERTISER_INFO: u64 = 1 << 30;
    pub const UNIFIED_MEDIA_CONTROL: u64 = 1 << 38;
    pub const BUFFERED_AUDIO: u64 = 1 << 40;
    pub const PTP: u64 = 1 << 41;
    pub const SCREEN_MULTI_CODEC: u64 = 1 << 42;
    pub const SYSTEM_PAIRING: u64 = 1 << 43;
    pub const HK_PAIRING_AND_ACCESS_CONTROL: u64 = 1 << 46;
    pub const COREUTILS_PAIRING_AND_ENCRYPTION: u64 = 1 << 48;
    pub const VIDEO_V2: u64 = 1 << 49;
    pub const UNIFIED_PAIR_SETUP_AND_MFI: u64 = 1 << 51;
}

/// Status flag bits from the `flags` / `sf` TXT key (pyatv).
pub mod status {
    pub const PIN_REQUIRED: u32 = 0x8;
    pub const PASSWORD_REQUIRED: u32 = 0x80;
    pub const LEGACY_PAIRING: u32 = 0x200;
    /// "DeviceWasSetupForHKAccessControl": it is in an Apple Home.
    pub const HOMEKIT_ACCESS_CONTROL: u32 = 0x400;
}

/// Which advertisement the TXT came from; the key names differ.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    /// `_airplay._tcp`: `features`, `flags`, `model`, `srcvers`, `deviceid`.
    AirPlay,
    /// `_raop._tcp`: `ft`, `sf`, `am`, `vs`; the device id is in the
    /// instance name (`AABBCCDDEEFF@Name`).
    Raop,
}

/// What we use from an AirPlay TXT record.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AirPlayTxt {
    pub features: Option<u64>,
    pub flags: Option<u32>,
    pub model: Option<String>,
    pub srcvers: Option<String>,
    /// MAC-like device id, `AA:BB:CC:DD:EE:FF`.
    pub deviceid: Option<String>,
    /// The receiver's Ed25519 public key (32 bytes).
    pub pk: Option<Vec<u8>>,
    /// `pw`: a password is required.
    pub pw: bool,
    /// `pi`: pairing identity (a UUID).
    pub pi: Option<String>,
    /// `act`: access control type ("2" seems to mean "current user").
    pub act: Option<String>,
    /// `acl`: the Apple Home's access level (0 open, 1 members only, 2 admin).
    pub acl: Option<u32>,
    pub osvers: Option<String>,
    pub manufacturer: Option<String>,
}

impl AirPlayTxt {
    pub fn parse(pairs: &[(String, Option<Vec<u8>>)], source: Source) -> AirPlayTxt {
        let get = |key: &str| -> Option<String> {
            pairs
                .iter()
                .find(|(k, _)| k == key)
                .and_then(|(_, v)| v.as_deref())
                .map(|v| String::from_utf8_lossy(v).trim().to_owned())
        };
        let (features_key, flags_key, model_key, vers_key) = match source {
            Source::AirPlay => ("features", "flags", "model", "srcvers"),
            Source::Raop => ("ft", "sf", "am", "vs"),
        };
        let mut txt = AirPlayTxt {
            model: get(model_key).filter(|s| !s.is_empty()),
            srcvers: get(vers_key).filter(|s| !s.is_empty()),
            deviceid: get("deviceid").filter(|s| !s.is_empty()),
            pi: get("pi").filter(|s| !s.is_empty()),
            act: get("act"),
            acl: get("acl").and_then(|v| v.parse().ok()),
            osvers: get("osvers").filter(|s| !s.is_empty()),
            manufacturer: get("manufacturer").filter(|s| !s.is_empty()),
            pw: get("pw").is_some_and(|v| parse_bool(&v)),
            ..AirPlayTxt::default()
        };
        if let Some(v) = get(features_key) {
            match parse_features(&v) {
                Ok(f) => txt.features = Some(f),
                Err(e) => debug!("airplay txt: {e}"),
            }
        }
        if let Some(v) = get(flags_key) {
            match parse_hex_u32(&v) {
                Some(f) => txt.flags = Some(f),
                None => debug!("airplay txt: bad flags {v:?}"),
            }
        }
        if let Some(v) = get("pk") {
            match crate::util::hex::decode(&v) {
                Ok(pk) if pk.len() == 32 => txt.pk = Some(pk),
                _ => debug!("airplay txt: bad pk {v:?}"),
            }
        }
        txt
    }

    pub fn has(&self, feature: u64) -> bool {
        self.features.is_some_and(|f| f & feature == feature)
    }

    /// Advertises screen mirroring (feature bit 7).
    pub fn supports_mirroring(&self) -> bool {
        self.has(features::SCREEN)
    }

    /// A password is required (`pw`, or status bit 0x80).
    pub fn password_required(&self) -> bool {
        self.pw
            || self
                .flags
                .is_some_and(|f| f & status::PASSWORD_REQUIRED != 0)
    }

    /// A shown PIN or its password ([`PinKind::from_status`]).
    pub fn pin_kind(&self) -> PinKind {
        let flags = self.flags.unwrap_or(0)
            | if self.pw {
                status::PASSWORD_REQUIRED
            } else {
                0
            };
        PinKind::from_status(flags, self.features.unwrap_or(0))
    }

    /// Only members of its Apple Home may use it (`acl=1`, §2.1).
    pub fn home_only(&self) -> bool {
        self.acl == Some(1)
    }

    /// A Mac set to "Allow AirPlay for: Current User" (`act=2`).
    pub fn owner_only(&self) -> bool {
        self.act.as_deref() == Some("2")
    }

    /// It is in an Apple Home (status flag 0x400).
    pub fn homekit(&self) -> bool {
        self.flags
            .is_some_and(|f| f & status::HOMEKIT_ACCESS_CONTROL != 0)
    }

    /// PIN pairing is mandatory (status bits 0x8 or 0x200).
    pub fn pin_required(&self) -> bool {
        self.flags
            .is_some_and(|f| f & (status::PIN_REQUIRED | status::LEGACY_PAIRING) != 0)
    }
}

/// Parses `0xLO` or `0xLO,0xHI` (each 1–8 hex digits) into one 64-bit
/// value `HI << 32 | LO`.
pub fn parse_features(s: &str) -> Result<u64> {
    let bad = || Error::malformed(format!("airplay: invalid features string {s:?}"));
    let half = |part: &str| -> Result<u64> {
        let digits = part
            .strip_prefix("0x")
            .or_else(|| part.strip_prefix("0X"))
            .ok_or_else(bad)?;
        if digits.is_empty() || digits.len() > 8 || !digits.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(bad());
        }
        u64::from_str_radix(digits, 16).map_err(|_| bad())
    };
    match s.trim().split_once(',') {
        Some((lo, hi)) => Ok(half(lo.trim())? | half(hi.trim())? << 32),
        None => half(s.trim()),
    }
}

/// Formats features back as `0xLO,0xHI` (upper-case hex, as receivers do).
pub fn format_features(f: u64) -> String {
    format!("0x{:X},0x{:X}", f & 0xffff_ffff, f >> 32)
}

fn parse_hex_u32(s: &str) -> Option<u32> {
    let digits = s
        .strip_prefix("0x")
        .or_else(|| s.strip_prefix("0X"))
        .unwrap_or(s);
    u32::from_str_radix(digits, 16).ok()
}

fn parse_bool(s: &str) -> bool {
    s.eq_ignore_ascii_case("true") || s == "1" || s.eq_ignore_ascii_case("yes")
}

/// Splits a RAOP instance label `AABBCCDDEEFF@Name` into the device id
/// (formatted `AA:BB:CC:DD:EE:FF`) and the name.
pub fn split_raop_name(label: &str) -> (Option<String>, &str) {
    if let Some((id, name)) = label.split_once('@') {
        if id.len() == 12 && id.bytes().all(|b| b.is_ascii_hexdigit()) {
            let mut mac = String::with_capacity(17);
            for (i, c) in id.chars().enumerate() {
                if i > 0 && i % 2 == 0 {
                    mac.push(':');
                }
                mac.push(c.to_ascii_uppercase());
            }
            return (Some(mac), name);
        }
    }
    (None, label)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::dns::txt_pairs;

    fn pairs(strings: &[&str]) -> Vec<(String, Option<Vec<u8>>)> {
        let v: Vec<Vec<u8>> = strings.iter().map(|s| s.as_bytes().to_vec()).collect();
        txt_pairs(&v)
    }

    #[test]
    fn features_formats() {
        assert_eq!(parse_features("0x5A7FFFF7,0x1E").unwrap(), 0x1E_5A7F_FFF7);
        assert_eq!(
            parse_features("0x445F8A00,0x801C340").unwrap(),
            0x0801_C340_445F_8A00
        );
        // A short low half must not be concatenated as a string.
        assert_eq!(parse_features("0x1,0x2").unwrap(), 0x2_0000_0001);
        assert_eq!(parse_features("0x77").unwrap(), 0x77);
        for bad in ["", "0x", "77", "0x123456789", "0x1,", "0x1,0x2,0x3", "0xZZ"] {
            assert!(parse_features(bad).is_err(), "{bad:?}");
        }
        assert_eq!(format_features(0x1E_5A7F_FFF7), "0x5A7FFFF7,0x1E");
    }

    #[test]
    fn airplay_txt() {
        let txt = AirPlayTxt::parse(
            &pairs(&[
                "acl=0",
                "deviceid=AA:BB:CC:00:00:01",
                "features=0x4A7FDFD5,0xBC177FDE",
                "flags=0x244",
                "model=AppleTV11,1",
                "pi=00000000-1111-2222-3333-444444444444",
                "pk=00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
                "srcvers=860.7.1",
                "osvers=26.1",
                "vv=2",
            ]),
            Source::AirPlay,
        );
        assert_eq!(txt.features, Some(0xBC17_7FDE_4A7F_DFD5));
        assert!(txt.supports_mirroring());
        assert!(txt.has(features::PTP));
        assert_eq!(txt.flags, Some(0x244));
        assert!(!txt.password_required());
        assert!(txt.pin_required()); // 0x200 set
        assert_eq!(txt.acl, Some(0));
        assert!(!txt.home_only());
        assert_eq!(txt.model.as_deref(), Some("AppleTV11,1"));
        assert_eq!(txt.srcvers.as_deref(), Some("860.7.1"));
        assert_eq!(txt.deviceid.as_deref(), Some("AA:BB:CC:00:00:01"));
        assert_eq!(txt.pk.as_ref().map(Vec::len), Some(32));
        assert_eq!(txt.osvers.as_deref(), Some("26.1"));
    }

    /// An LG TV in an Apple Home: members only, then anyone with a password.
    #[test]
    fn home_only_txt() {
        let lg = |acl: &str, flags: &str| {
            AirPlayTxt::parse(
                &pairs(&[acl, "features=0x7F8AD0,0x38BCF46", flags, "rsf=0x3"]),
                Source::AirPlay,
            )
        };
        let members = lg("acl=1", "flags=0x644");
        assert!(members.homekit() && !lg("acl=0", "flags=0x244").homekit());
        assert!(members.home_only() && members.pin_required());
        let network = lg("acl=0", "flags=0x4c4");
        assert!(!network.home_only() && network.password_required());
        assert_eq!(
            (network.pin_kind(), members.pin_kind()),
            (PinKind::Password, PinKind::Shown)
        );
        // A password and the one-time pairing flag 0x200: the password.
        assert_eq!(lg("acl=0", "flags=0x6c4").pin_kind(), PinKind::Password);
        // A password and the PIN flag 0x8: the PIN is shown.
        assert_eq!(lg("acl=0", "flags=0x4cc").pin_kind(), PinKind::Shown);
        let digest = AirPlayTxt::parse(
            &pairs(&["features=0x4000080", "flags=0x84"]),
            Source::AirPlay,
        );
        assert!(digest.password_required() && digest.pin_kind() == PinKind::Shown);
        assert!(!lg("acl=x", "flags=0x644").home_only());
    }

    #[test]
    fn raop_txt_and_lenience() {
        let txt = AirPlayTxt::parse(
            &pairs(&[
                "am=Sonos",
                "ft=0x445F8A00,0x1C340",
                "sf=0x4",
                "vs=366.0",
                "pw=true",
                "pk=zz",
            ]),
            Source::Raop,
        );
        assert_eq!(txt.model.as_deref(), Some("Sonos"));
        assert_eq!(txt.features, Some(0x1_C340_445F_8A00));
        assert!(!txt.supports_mirroring());
        assert!(txt.password_required());
        assert_eq!(txt.pk, None);
        let bad = AirPlayTxt::parse(&pairs(&["features=garbage", "flags=0xq"]), Source::AirPlay);
        assert_eq!(bad, AirPlayTxt::default());
    }

    #[test]
    fn raop_names() {
        assert_eq!(
            split_raop_name("aabbcc000001@Living Room"),
            (Some("AA:BB:CC:00:00:01".to_owned()), "Living Room")
        );
        assert_eq!(split_raop_name("Kitchen"), (None, "Kitchen"));
        assert_eq!(split_raop_name("me@home"), (None, "me@home"));
    }
}
