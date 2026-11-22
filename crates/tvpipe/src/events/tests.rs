//! Golden vectors of the machine interface's events
//! (`tests/vectors/machine/events.txt`), the contract with the Node SDK
//! (docs/rust-sdk-design.md §7). `TVPIPE_BLESS=1 cargo test events::`
//! rewrites the file from [`examples`].

use super::*;
use crate::log::{Level, Record};
use crate::net::discover::{AirPlayService, CastService, DeviceInfo, Endpoint};

const FILE: &str = "machine/events.txt";

/// Which vector shows `e`: every variant needs one, so a new variant does
/// not compile until it has an example below.
fn variant(e: &Event) -> &'static str {
    match e {
        Event::Hello(_) => "hello",
        Event::Log(_) => "log",
        Event::Receiver(_) => "receiver",
        Event::Player(_) => "player",
        Event::Viewer(_) => "viewer",
        Event::Tunnel(_) => "tunnel",
        Event::SharePage(_) => "share-page",
        Event::Capture(_) => "capture",
        Event::Connected(_) => "connected",
        Event::Started(_) => "started",
        Event::Keyframe => "keyframe",
        Event::Stats(_) => "stats",
        Event::Devices(_) => "devices",
        Event::PinRequired(_) => "pin-required",
        Event::Paired(_) => "paired",
        Event::Unpaired(_) => "unpaired",
        Event::End(_) => "end",
        Event::Error(_) => "error",
        // Not in the machine protocol: no vector (see `progress_round_trips`).
        Event::Progress(_) => "progress",
    }
}

fn stats(name: &str, n: u64) -> ReceiverStats {
    ReceiverStats {
        name: name.into(),
        pushed: n,
        dropped: 1,
        dropped_full: 2,
        dropped_waiting: 3,
    }
}

fn s(v: &str) -> String {
    v.to_owned()
}

/// The examples, in file order.
fn examples() -> Vec<(&'static str, Event)> {
    let receiver = |state, protocol, error: Option<&str>, code: Option<&str>| {
        Event::Receiver(ReceiverEvent {
            name: s("Living Room"),
            protocol,
            state,
            error: error.map(s),
            code: code.map(s),
            delay_ms: None,
        })
    };
    let device = DeviceInfo {
        name: s("Living Room"),
        addresses: vec!["192.0.2.10".parse().unwrap()],
        model: Some(s("AppleTV14,1")),
        airplay: Some(AirPlayService {
            endpoint: Endpoint {
                instance: s("Living Room"),
                host: s("Living-Room.local"),
                port: 7000,
                address: s("192.0.2.10:7000"),
            },
            model: Some(s("AppleTV14,1")),
            srcvers: Some(s("860.7.1")),
            osvers: Some(s("26.1")),
            deviceid: Some(s("AA:BB:CC:00:00:0A")),
            features: Some(s("0x4A7FDFD5,0x3C177FDE")),
            flags: Some(s("0x644")),
            pk: Some(s("00".repeat(32).as_str())),
            mirroring: true,
            password: false,
            password_pin: false,
            pin: true,
            home_only: false,
            paired: Some(false),
        }),
        raop: None,
        cast: None,
    };
    let speaker = DeviceInfo {
        name: s("Kitchen speaker"),
        addresses: vec!["192.0.2.11".parse().unwrap()],
        model: None,
        airplay: None,
        raop: None,
        cast: Some(CastService {
            endpoint: Endpoint {
                instance: s("Google-Nest-Mini-0123"),
                host: s("0123.local"),
                port: 8009,
                address: s("192.0.2.11:8009"),
            },
            friendly_name: Some(s("Kitchen speaker")),
            model: Some(s("Google Nest Mini")),
            id: Some(s("0123456789abcdef")),
            capabilities: Some(199_172),
            status: None,
            video: false,
            group: false,
        }),
    };
    vec![
        (
            "hello",
            Event::Hello(Hello::new(1, "0.1.2", "test-pattern")),
        ),
        (
            "log",
            Event::Log(Record {
                level: Level::Info,
                module: s("browser::player"),
                message: s("browser: open http://127.0.0.1:8765/?t=… to watch"),
            }),
        ),
        (
            "log at every level",
            Event::Log(Record {
                level: Level::Trace,
                module: s("cast::rtcp"),
                message: s("quoted \"text\" and a tab\t"),
            }),
        ),
        (
            "receiver connected",
            match receiver(
                ReceiverState::Connected,
                Some(Protocol::AirPlay),
                None,
                None,
            ) {
                Event::Receiver(r) => Event::Receiver(r.with_delay(100)),
                e => e,
            },
        ),
        (
            "receiver failed while connecting",
            receiver(
                ReceiverState::Failed,
                Some(Protocol::AirPlay),
                Some("Living Room requires pairing: run `tvpipe pair \"Living Room\"`"),
                Some("pairing-required"),
            ),
        ),
        (
            "receiver lost",
            receiver(
                ReceiverState::Lost,
                None,
                Some("cast: no RTCP for 5 s"),
                None,
            ),
        ),
        (
            "receiver reconnected",
            receiver(ReceiverState::Reconnected, None, None, None),
        ),
        (
            "receiver gave up",
            receiver(
                ReceiverState::GaveUp,
                None,
                Some("gave up reconnecting after 120 s: connect: connection refused"),
                None,
            ),
        ),
        (
            "receiver ended",
            receiver(ReceiverState::Ended, None, None, None),
        ),
        (
            "receiver stopped",
            receiver(ReceiverState::Stopped, None, None, None),
        ),
        (
            "player",
            Event::Player(PlayerEvent {
                name: s("browser"),
                url: s("http://127.0.0.1:8765/?t=0123456789abcdef0123456789abcdef"),
            }),
        ),
        (
            "viewer",
            Event::Viewer(ViewerEvent {
                name: s("browser"),
                tab: 1,
                state: ViewerState::Connected,
                public: false,
                address: None,
                country: None,
                browser: Some(s("Chrome 131 on macOS")),
            }),
        ),
        (
            "viewer over the tunnel leaves",
            Event::Viewer(ViewerEvent {
                name: s("browser"),
                tab: 2,
                state: ViewerState::Disconnected,
                public: true,
                address: Some(s("203.0.113.9")),
                country: Some(s("DE")),
                browser: Some(s("Safari 18 on iPhone")),
            }),
        ),
        (
            "tunnel to the player",
            Event::Tunnel(TunnelEvent {
                page: TunnelPage::Player,
                name: Some(s("browser")),
                provider: s("cloudflare"),
                url: s("https://example.trycloudflare.com/?t=abc&delay=300"),
            }),
        ),
        (
            "tunnel to the share page",
            Event::Tunnel(TunnelEvent {
                page: TunnelPage::Share,
                name: None,
                provider: s("opentunnel"),
                url: s("https://abc.opentunnel.example/?t=def"),
            }),
        ),
        (
            "tunnel to a port",
            Event::Tunnel(TunnelEvent {
                page: TunnelPage::Port,
                name: None,
                provider: s("cloudflare"),
                url: s("https://words-words-words.trycloudflare.com/"),
            }),
        ),
        (
            "share-page",
            Event::SharePage(SharePageEvent {
                url: s("http://127.0.0.1:52345/?t=0123"),
            }),
        ),
        (
            "capture",
            Event::Capture(CaptureEvent {
                surface: Some(s("window")),
                label: Some(s("Slides")),
                width: 1920,
                height: 1080,
                audio: true,
            }),
        ),
        (
            "capture without details",
            Event::Capture(CaptureEvent {
                surface: None,
                label: None,
                width: 640,
                height: 480,
                audio: false,
            }),
        ),
        (
            "connected",
            Event::Connected(ConnectedEvent {
                receivers: vec![s("Living Room"), s("browser")],
            }),
        ),
        (
            "started",
            Event::Started(Started {
                route: Route::Builtin,
                video: VideoStarted {
                    codec: s("h264"),
                    width: 1280,
                    height: 720,
                    fps: 30.0,
                },
                audio: vec![
                    AudioStarted {
                        codec: s("pcm-s16le"),
                        sample_rate: 44_100,
                        channels: 2,
                    },
                    AudioStarted {
                        codec: s("aac-lc"),
                        sample_rate: 48_000,
                        channels: 2,
                    },
                ],
                latency_ms: 300,
            }),
        ),
        (
            "started with a fractional rate and no audio",
            Event::Started(Started {
                route: Route::Passthrough,
                video: VideoStarted {
                    codec: s("h264"),
                    width: 1920,
                    height: 1080,
                    fps: 29.97002997002997,
                },
                audio: vec![],
                latency_ms: 100,
            }),
        ),
        ("keyframe", Event::Keyframe),
        (
            "stats",
            Event::Stats(Stats {
                elapsed_ms: 2005,
                video_frames: 60,
                audio_frames: 273,
                receivers: vec![stats("Living Room", 333)],
                video_bytes: 0,
            }),
        ),
        (
            "devices",
            Event::Devices(DevicesEvent {
                devices: vec![device, speaker],
            }),
        ),
        (
            "pin-required",
            Event::PinRequired(PinRequest {
                name: s("Living Room"),
                address: s("192.0.2.10:7000"),
                password: false,
            }),
        ),
        (
            "paired",
            Event::Paired(Paired {
                name: s("Living Room"),
                model: Some(s("AppleTV14,1")),
                file: Some(s("/home/user/.config/tvpipe/credentials.txt")),
            }),
        ),
        (
            "paired in memory",
            Event::Paired(Paired {
                name: s("Living Room"),
                model: None,
                file: None,
            }),
        ),
        (
            "unpaired",
            Event::Unpaired(Unpaired {
                name: s("Living Room"),
                id: s("5B3C1A0E-0000-4000-8000-000000000001"),
            }),
        ),
        (
            "end of a stream",
            Event::End(EndInfo {
                reason: EndReason::Eof,
                receivers: Some(vec![
                    ReceiverEndInfo {
                        stats: stats("Living Room", 333),
                        end: ReceiverEnd::Stopped,
                        error: None,
                    },
                    ReceiverEndInfo {
                        stats: stats("Office", 12),
                        end: ReceiverEnd::Failed,
                        error: Some(s("cast: control channel ended")),
                    },
                ]),
            }),
        ),
        (
            "end of a command",
            Event::End(EndInfo::new(EndReason::Done)),
        ),
        (
            "end after every receiver left",
            Event::End(EndInfo {
                reason: EndReason::ReceiversGone,
                receivers: Some(vec![ReceiverEndInfo {
                    stats: stats("Living Room", 5),
                    end: ReceiverEnd::Ended,
                    error: None,
                }]),
            }),
        ),
        (
            "error",
            Event::Error(ErrorInfo::from(
                &Error::auth("Living Room requires pairing")
                    .with_code("pairing-required")
                    .with_device("Living Room"),
            )),
        ),
        (
            "error without code",
            Event::Error(ErrorInfo::from(&Error::not_found("no such file"))),
        ),
    ]
}

fn render() -> String {
    let mut out = String::from(
        "# The machine interface's events (docs/machine.md) as tvpipe writes them:\n\
         # one block per event type and interesting case. Generated from\n\
         # crates/tvpipe/src/events/tests.rs (TVPIPE_BLESS=1 cargo test -p tvpipe events::);\n\
         # the Node SDK's tests read it too.\n",
    );
    for (name, e) in examples() {
        out.push_str(&format!(
            "\nname = {name}\ntype = {}\njson = {}\n",
            variant(&e),
            e.to_json()
        ));
    }
    out
}

#[test]
fn golden_vectors() {
    let path = crate::util::vectors::path("tests/vectors").join(FILE);
    let want = render();
    if std::env::var_os("TVPIPE_BLESS").is_some() {
        std::fs::write(&path, &want).unwrap();
    }
    let have = std::fs::read_to_string(&path).unwrap_or_default();
    assert!(
        have == want,
        "{} is out of date: TVPIPE_BLESS=1 cargo test -p tvpipe events::",
        path.display()
    );
}

#[test]
fn every_variant_has_a_vector_and_round_trips() {
    let examples = examples();
    let mut types: Vec<&str> = examples.iter().map(|(_, e)| variant(e)).collect();
    types.dedup();
    assert_eq!(types.len(), 18, "{types:?}");
    for (name, e) in &examples {
        assert_eq!(e.type_name(), variant(e), "{name}");
        let back = Event::from_json(&e.to_json()).unwrap();
        assert_eq!(&back, e, "{name}");
    }
    for b in crate::util::vectors::load(FILE) {
        let e = Event::from_json(b.str("json")).unwrap();
        assert_eq!(e.type_name(), b.str("type"));
    }
}

#[test]
fn progress_round_trips_and_is_not_machine() {
    let steps = [
        Step::Find(s("Living Room")),
        Step::Connect(s("Living Room")),
        Step::Browser,
        Step::Window,
        Step::Tunnel,
        Step::Capture,
        Step::Viewer,
        Step::Discover,
        Step::Download(s("drawbluff.zip")),
    ];
    let mut all: Vec<Progress> = Vec::new();
    for st in steps {
        all.push(Progress::Begin(st.clone()));
        all.push(Progress::Done(st.clone(), Some(s("Chrome 157"))));
        all.push(Progress::Done(st.clone(), None));
        all.push(Progress::Failed(st, s("refused")));
    }
    all.extend([
        Progress::Game {
            title: s("Drawbluff"),
            local: s("http://127.0.0.1:1/"),
            lan: Some(s("http://192.168.1.2:7420/")),
        },
        Progress::GameLink {
            url: s("https://x.example/"),
            provider: s("opentunnel"),
            short: false,
        },
        Progress::GameLink {
            url: s("https://x.example/"),
            provider: s("cloudflare"),
            short: true,
        },
        Progress::ShortLink {
            url: s("https://tvpipe.party/BCDF"),
        },
        Progress::Phones(3),
        Progress::Casting(vec![s("TV"), s("Bedroom")]),
        Progress::CastFailed(s("no")),
        Progress::CastStopped,
        Progress::Download {
            done: 5,
            total: Some(10),
        },
        Progress::Download {
            done: 5,
            total: None,
        },
    ]);
    for p in all {
        let e = Event::Progress(p);
        assert!(!e.is_machine());
        assert_eq!(Event::from_json(&e.to_json()).unwrap(), e);
    }
    assert!(Event::Keyframe.is_machine());
    // Stats' byte count stays off the wire.
    let st = Event::Stats(Stats {
        video_bytes: 5,
        ..Stats::default()
    });
    assert!(!st.to_json().contains("bytes"));
}

#[test]
fn readers_ignore_unknown_fields_and_refuse_unknown_types() {
    let e = Event::from_json(r#"{"type":"keyframe","future":1}"#).unwrap();
    assert_eq!(e, Event::Keyframe);
    assert!(Event::from_json(r#"{"type":"teleport"}"#).is_err());
    assert!(Event::from_json(r#"{"type":"receiver","name":"x","state":"melted"}"#).is_err());
    assert!(Event::from_json("not json").is_err());
}
