//! `tvpipe discover` and `--to NAME` resolution (ARCHITECTURE.md,
//! "Discovery").

use std::net::{IpAddr, Ipv4Addr};
use std::time::Duration;

use super::device::{self, Device};
use super::iface;
use super::mdns::{self, BrowseOptions, Cache};
use crate::airplay::credentials::Store;
use crate::airplay::discovery::format_features;
use crate::codec::json::Value;
use crate::error::Result;
use crate::util::hex;

/// Browses for `timeout` and returns the merged devices.
pub fn discover(timeout: Duration, interfaces: &[Ipv4Addr]) -> Result<Vec<Device>> {
    let cache = browse(timeout, interfaces, |_| false)?;
    Ok(device::devices(&cache))
}

/// Resolves `--to QUERY`. An address is returned without browsing as a
/// bare device-less hint (`Ok(None)`); otherwise browses until a device
/// with exactly that name shows up (or the timeout passes), then applies
/// [`device::select`].
pub fn resolve(query: &str, timeout: Duration, interfaces: &[Ipv4Addr]) -> Result<Option<Device>> {
    if query.parse::<IpAddr>().is_ok() {
        return Ok(None);
    }
    let q = query.to_lowercase();
    let cache = browse(timeout, interfaces, |cache| {
        device::devices(cache)
            .iter()
            .any(|d| d.names().iter().any(|n| n.to_lowercase() == q))
    })?;
    let devices = device::devices(&cache);
    device::select(&devices, query).cloned().map(Some)
}

/// The AirPlay (or RAOP) receiver advertised at `addr`: browses until it shows up.
pub fn at(addr: std::net::SocketAddr, timeout: Duration) -> Result<Option<Device>> {
    let here = |d: &Device| {
        [&d.airplay, &d.raop]
            .into_iter()
            .flatten()
            .any(|a| a.endpoint.port == addr.port() && a.endpoint.addrs.contains(&addr.ip()))
    };
    let cache = browse(timeout, &[], |cache| {
        device::devices(cache).iter().any(here)
    })?;
    Ok(device::devices(&cache).into_iter().find(here))
}

fn browse(
    timeout: Duration,
    interfaces: &[Ipv4Addr],
    done: impl FnMut(&Cache) -> bool,
) -> Result<Cache> {
    let opts = BrowseOptions {
        services: device::services(),
        interfaces: iface::browse_addrs(interfaces),
        timeout,
        target: BrowseOptions::MDNS,
    };
    mdns::browse(&opts, done)
}

fn protocols(d: &Device) -> String {
    let mut p = Vec::new();
    if d.airplay.is_some() {
        p.push(if d.airplay_mirroring() {
            "airplay(mirror)"
        } else {
            "airplay"
        });
    }
    if d.raop.is_some() {
        p.push("raop");
    }
    if d.cast.is_some() {
        p.push(if d.cast_video() {
            "cast(video)"
        } else {
            "cast"
        });
    }
    p.join(",")
}

/// A plain table, one device per line.
pub fn to_table(devices: &[Device]) -> String {
    if devices.is_empty() {
        return "no receivers found\n".to_owned();
    }
    let rows: Vec<[String; 4]> = devices
        .iter()
        .map(|d| {
            [
                d.name.clone(),
                d.addrs().first().map(IpAddr::to_string).unwrap_or_default(),
                protocols(d),
                d.model().unwrap_or("").to_owned(),
            ]
        })
        .collect();
    let header = ["NAME", "ADDRESS", "PROTOCOLS", "MODEL"].map(str::to_owned);
    let mut widths = [0usize; 4];
    for row in std::iter::once(&header).chain(&rows) {
        for (w, cell) in widths.iter_mut().zip(row) {
            *w = (*w).max(cell.chars().count());
        }
    }
    let mut out = String::new();
    for row in std::iter::once(&header).chain(&rows) {
        let mut line = String::new();
        for (i, cell) in row.iter().enumerate() {
            line.push_str(cell);
            if i + 1 < row.len() {
                let pad = widths[i] - cell.chars().count() + 2;
                line.extend(std::iter::repeat_n(' ', pad));
            }
        }
        out.push_str(line.trim_end());
        out.push('\n');
    }
    out
}

/// Machine-readable output: a JSON array of devices.
pub fn to_json(devices: &[Device]) -> String {
    to_json_with(devices, None)
}

/// [`to_json`] with `paired` on AirPlay entries when the store is given.
fn to_json_with(devices: &[Device], store: Option<&Store>) -> String {
    let list = Value::array(devices.iter().map(|d| DeviceInfo::new(d, store).to_value()));
    format!("{list:#}\n")
}

/// The AirPlay pairings, if there are any (discovery never creates the
/// store).
pub(crate) fn stored_pairings(storage: &crate::storage::Storage) -> Option<Store> {
    Store::load(storage)
        .map_err(|e| debug!("discover: {e}"))
        .ok()
        .flatten()
}

/// Whether `store` has a pairing for `d` (by key, device id or name).
fn is_paired(d: &Device, store: &Store) -> bool {
    let txt = d.airplay.as_ref().or(d.raop.as_ref()).map(|a| &a.txt);
    let q = crate::airplay::credentials::Query {
        public_key: txt.and_then(|t| t.pk.as_deref()),
        device_id: txt.and_then(|t| t.deviceid.as_deref()),
        names: d.names(),
        addr: None,
    };
    store.find(&q).is_some()
}

/// A discovered receiver as programs see it (`discover --json`, the
/// `devices` event): its name, addresses, and the services it offers.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct DeviceInfo {
    /// The name it advertises (the Cast friendly name, else the AirPlay name).
    pub name: String,
    /// Its IPv4 addresses.
    pub addresses: Vec<IpAddr>,
    /// Its model (`AppleTV6,2`, `Chromecast`), if it says.
    pub model: Option<String>,
    /// The `_airplay._tcp` service.
    pub airplay: Option<AirPlayService>,
    /// The `_raop._tcp` service (AirPlay audio; older receivers).
    pub raop: Option<AirPlayService>,
    /// The `_googlecast._tcp` service.
    pub cast: Option<CastService>,
}

/// Where a service is reached.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct Endpoint {
    /// The mDNS instance name.
    pub instance: String,
    /// The mDNS host name.
    pub host: String,
    /// The service port.
    pub port: u16,
    /// `ip:port`.
    pub address: String,
}

/// An AirPlay (or RAOP) service and what its TXT record says.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct AirPlayService {
    /// Where it is reached.
    pub endpoint: Endpoint,
    /// The model, from the TXT record.
    pub model: Option<String>,
    /// The AirPlay source version.
    pub srcvers: Option<String>,
    /// The OS version.
    pub osvers: Option<String>,
    /// The device id (a MAC address).
    pub deviceid: Option<String>,
    /// The feature bits, as advertised (`0xLOW,0xHIGH`).
    pub features: Option<String>,
    /// The status flags, as advertised (hex).
    pub flags: Option<String>,
    /// The receiver's public key (hex).
    pub pk: Option<String>,
    /// Supports screen mirroring (video).
    pub mirroring: bool,
    /// Needs a password (the PIN of `pair` with HAP pairing; no HTTP Digest).
    pub password: bool,
    /// Its password is the PIN of `pair`, and no PIN is shown.
    pub password_pin: bool,
    /// Shows a PIN to pair.
    pub pin: bool,
    /// Only members of its Apple Home may use it (`acl=1`).
    pub home_only: bool,
    /// Whether the storage has a pairing for it (when known).
    pub paired: Option<bool>,
}

/// A Google Cast service and what its TXT record says.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct CastService {
    /// Where it is reached.
    pub endpoint: Endpoint,
    /// The name its owner gave it.
    pub friendly_name: Option<String>,
    /// The model name.
    pub model: Option<String>,
    /// The device UUID (hex).
    pub id: Option<String>,
    /// The capability bits.
    pub capabilities: Option<u64>,
    /// The status text of the running app, if any.
    pub status: Option<String>,
    /// Plays video (not an audio-only speaker).
    pub video: bool,
    /// A speaker group.
    pub group: bool,
}

impl DeviceInfo {
    /// From a merged device; `store`, if given, marks paired AirPlay
    /// receivers.
    pub(crate) fn new(d: &Device, store: Option<&Store>) -> DeviceInfo {
        let airplay = |ap: &Option<device::AirPlayEndpoint>| {
            ap.as_ref().map(|ap| {
                let t = &ap.txt;
                AirPlayService {
                    endpoint: Endpoint::new(&ap.endpoint),
                    model: t.model.clone(),
                    srcvers: t.srcvers.clone(),
                    osvers: t.osvers.clone(),
                    deviceid: t.deviceid.clone(),
                    features: t.features.map(format_features),
                    flags: t.flags.map(|f| format!("{f:#x}")),
                    pk: t.pk.as_deref().map(hex::encode),
                    mirroring: t.supports_mirroring(),
                    password: t.password_required(),
                    password_pin: t.pin_kind().is_password(),
                    pin: t.pin_required(),
                    home_only: t.home_only(),
                    paired: store.map(|s| is_paired(d, s)),
                }
            })
        };
        DeviceInfo {
            name: d.name.clone(),
            addresses: d.addrs(),
            model: d.model().map(str::to_owned),
            airplay: airplay(&d.airplay),
            raop: airplay(&d.raop),
            cast: d.cast.as_ref().map(|c| {
                let t = &c.txt;
                CastService {
                    endpoint: Endpoint::new(&c.endpoint),
                    friendly_name: t.friendly_name.clone(),
                    model: t.model.clone(),
                    id: t.id.clone(),
                    capabilities: t.capabilities,
                    status: t.status.clone(),
                    video: d.cast_video(),
                    group: t.is_group(),
                }
            }),
        }
    }

    /// The device as `tvpipe discover --json` prints it.
    pub fn to_json(&self) -> String {
        self.to_value().to_json()
    }

    /// Reads a `tvpipe discover --json` object.
    pub fn from_json(text: &str) -> Result<DeviceInfo> {
        DeviceInfo::from_value(&Value::parse(text)?)
    }

    /// Whether it plays video over AirPlay (screen mirroring) or Cast.
    pub fn plays_video(&self) -> bool {
        self.airplay.as_ref().is_some_and(|a| a.mirroring)
            || self.cast.as_ref().is_some_and(|c| c.video)
    }

    /// Whether the storage has a pairing for it (AirPlay), if known.
    pub fn paired(&self) -> Option<bool> {
        self.airplay
            .as_ref()
            .or(self.raop.as_ref())
            .and_then(|a| a.paired)
    }

    /// The `discover --json` object.
    pub(crate) fn to_value(&self) -> Value {
        let mut v = Value::object()
            .with("name", self.name.as_str())
            .with(
                "addresses",
                Value::array(self.addresses.iter().map(|a| a.to_string())),
            )
            .with_opt("model", self.model.as_deref());
        for (key, ap) in [("airplay", &self.airplay), ("raop", &self.raop)] {
            let Some(ap) = ap else { continue };
            let o = ap
                .endpoint
                .to_value()
                .with_opt("model", ap.model.as_deref())
                .with_opt("srcvers", ap.srcvers.as_deref())
                .with_opt("osvers", ap.osvers.as_deref())
                .with_opt("deviceid", ap.deviceid.as_deref())
                .with_opt("features", ap.features.as_deref())
                .with_opt("flags", ap.flags.as_deref())
                .with_opt("pk", ap.pk.as_deref())
                .with("mirroring", ap.mirroring)
                .with("password", ap.password)
                .with("password_pin", ap.password_pin)
                .with("pin", ap.pin)
                .with("home_only", ap.home_only)
                .with_opt("paired", ap.paired);
            v = v.with(key, o);
        }
        if let Some(c) = &self.cast {
            let o = c
                .endpoint
                .to_value()
                .with_opt("friendly_name", c.friendly_name.as_deref())
                .with_opt("model", c.model.as_deref())
                .with_opt("id", c.id.as_deref())
                .with_opt("capabilities", c.capabilities)
                .with_opt("status", c.status.as_deref())
                .with("video", c.video)
                .with("group", c.group);
            v = v.with("cast", o);
        }
        v
    }

    /// Parses a `discover --json` object.
    pub(crate) fn from_value(v: &Value) -> Result<DeviceInfo> {
        let s = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).map(str::to_owned);
        let flag = |v: &Value, k: &str| v.get(k).and_then(Value::as_bool).unwrap_or(false);
        let airplay = |k: &str| -> Result<Option<AirPlayService>> {
            let Some(a) = v.get(k).filter(|a| !a.is_null()) else {
                return Ok(None);
            };
            Ok(Some(AirPlayService {
                endpoint: Endpoint::from_value(a)?,
                model: s(a, "model"),
                srcvers: s(a, "srcvers"),
                osvers: s(a, "osvers"),
                deviceid: s(a, "deviceid"),
                features: s(a, "features"),
                flags: s(a, "flags"),
                pk: s(a, "pk"),
                mirroring: flag(a, "mirroring"),
                password: flag(a, "password"),
                password_pin: flag(a, "password_pin"),
                pin: flag(a, "pin"),
                home_only: flag(a, "home_only"),
                paired: a.get("paired").and_then(Value::as_bool),
            }))
        };
        let cast = match v.get("cast").filter(|c| !c.is_null()) {
            Some(c) => Some(CastService {
                endpoint: Endpoint::from_value(c)?,
                friendly_name: s(c, "friendly_name"),
                model: s(c, "model"),
                id: s(c, "id"),
                capabilities: c.get("capabilities").and_then(Value::as_u64),
                status: s(c, "status"),
                video: flag(c, "video"),
                group: flag(c, "group"),
            }),
            None => None,
        };
        Ok(DeviceInfo {
            name: v.require_str("name")?.to_owned(),
            addresses: v
                .require_array("addresses")?
                .iter()
                .map(|a| {
                    a.as_str()
                        .and_then(|a| a.parse().ok())
                        .ok_or_else(|| crate::error::Error::malformed("device: bad address"))
                })
                .collect::<Result<_>>()?,
            model: s(v, "model"),
            airplay: airplay("airplay")?,
            raop: airplay("raop")?,
            cast,
        })
    }
}

impl Endpoint {
    fn new(ep: &device::Endpoint) -> Endpoint {
        Endpoint {
            instance: ep.instance.clone(),
            host: ep.host.clone(),
            port: ep.port,
            address: ep.addr().to_string(),
        }
    }

    fn to_value(&self) -> Value {
        Value::object()
            .with("instance", self.instance.as_str())
            .with("host", self.host.as_str())
            .with("port", self.port)
            .with("address", self.address.as_str())
    }

    fn from_value(v: &Value) -> Result<Endpoint> {
        Ok(Endpoint {
            instance: v.require_str("instance")?.to_owned(),
            host: v.require_str("host")?.to_owned(),
            port: u16::try_from(v.require_u32("port")?)
                .map_err(|_| crate::error::Error::malformed("device: bad port"))?,
            address: v.require_str("address")?.to_owned(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codec::json;

    #[test]
    fn empty_outputs() {
        assert_eq!(to_json(&[]), "[]\n");
        assert_eq!(to_table(&[]), "no receivers found\n");
    }

    #[test]
    fn lan_capture_json() {
        let devices = crate::net::device::tests::lan_devices();
        let v = json::parse(&to_json(&devices)).unwrap();
        let list = v.as_array().unwrap();
        assert_eq!(list.len(), 13);
        let tv = list
            .iter()
            .find(|d| d["name"].as_str() == Some("Livingroom (2)"))
            .unwrap();
        assert_eq!(tv["model"].as_str(), Some("AppleTV6,2"));
        assert_eq!(tv["addresses"][0].as_str(), Some("192.168.1.34"));
        let ap = &tv["airplay"];
        assert_eq!(ap["port"].as_u64(), Some(7000));
        assert_eq!(ap["deviceid"].as_str(), Some("AA:BB:CC:00:00:0A"));
        assert_eq!(ap["features"].as_str(), Some("0x4A7FDFD5,0x3C177FDE"));
        assert_eq!(ap["flags"].as_str(), Some("0x644"));
        assert_eq!(ap["mirroring"].as_bool(), Some(true));
        assert_eq!(ap["pk"].as_str().map(str::len), Some(64));
        assert!(tv["raop"]["instance"]
            .as_str()
            .unwrap()
            .ends_with("@Livingroom"));
        assert!(tv["cast"].is_null());
    }
}
