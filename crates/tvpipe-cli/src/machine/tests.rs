use super::*;
use std::sync::atomic::AtomicUsize;
use std::sync::mpsc::Sender;
use std::time::Duration;

/// A pipe: the test writes, the router reads.
struct Pipe(Receiver<Vec<u8>>, Vec<u8>, usize);

impl Read for Pipe {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        while self.2 >= self.1.len() {
            match self.0.recv() {
                Ok(c) => {
                    self.1 = c;
                    self.2 = 0;
                }
                Err(_) => return Ok(0),
            }
        }
        let n = buf.len().min(self.1.len() - self.2);
        buf[..n].copy_from_slice(&self.1[self.2..self.2 + n]);
        self.2 += n;
        Ok(n)
    }
}

struct Fixture {
    router: Router,
    tx: Option<Sender<Vec<u8>>>,
    stops: Arc<AtomicUsize>,
    keyframes: Arc<AtomicUsize>,
}

impl Fixture {
    fn new() -> Fixture {
        let (tx, rx) = mpsc::channel();
        let stops = Arc::new(AtomicUsize::new(0));
        let keyframes = Arc::new(AtomicUsize::new(0));
        let (s, k) = (stops.clone(), keyframes.clone());
        let router = Router::spawn(
            Pipe(rx, Vec::new(), 0),
            Hooks {
                stop: Box::new(move || {
                    s.fetch_add(1, Ordering::SeqCst);
                }),
                keyframe: Box::new(move || {
                    k.fetch_add(1, Ordering::SeqCst);
                }),
            },
        );
        Fixture {
            router,
            tx: Some(tx),
            stops,
            keyframes,
        }
    }

    fn send(&self, bytes: Vec<u8>) {
        self.tx.as_ref().unwrap().send(bytes).unwrap();
    }

    fn record(&self, kind: u8, pts: u64, payload: &[u8]) {
        self.send(record(kind, pts, payload));
    }

    fn command(&self, json: &str) {
        self.record(6, 0, json.as_bytes());
    }

    fn close(&mut self) {
        self.tx = None;
    }

    fn stops(&self) -> usize {
        self.stops.load(Ordering::SeqCst)
    }

    /// Waits until `f` holds (the router runs on its own thread).
    fn until(&self, what: &str, f: impl Fn(&Fixture) -> bool) {
        for _ in 0..500 {
            if f(self) {
                return;
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        panic!("timed out waiting for {what}");
    }
}

fn record(kind: u8, pts: u64, payload: &[u8]) -> Vec<u8> {
    let mut v = vec![kind];
    v.extend_from_slice(&pts.to_le_bytes());
    v.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    v.extend_from_slice(payload);
    v
}

fn read_packets(r: impl Read) -> Vec<slrw::Packet> {
    let mut reader = slrw::SlrwReader::new(r);
    let mut out = Vec::new();
    while let Some(p) = reader.next_packet().unwrap() {
        out.push(p);
    }
    out
}

#[test]
fn eof_without_input_stops() {
    let mut f = Fixture::new();
    f.send(slrw::MAGIC.to_vec());
    f.close();
    f.until("stop", |f| f.stops() == 1);
    // Also without even the magic.
    let mut g = Fixture::new();
    g.close();
    g.until("stop", |g| g.stops() == 1);
}

#[test]
fn stop_command_while_holding() {
    let f = Fixture::new();
    f.send(slrw::MAGIC.to_vec());
    f.record(1, 0, &[0; 64]);
    f.command(r#"{"type":"stop"}"#);
    f.until("stop", |f| f.stops() == 1);
    // Unknown commands and bad JSON are ignored.
    f.command(r#"{"type":"dance"}"#);
    f.command("{not json");
    f.command(r#"{"type":"stop"}"#);
    f.until("second stop", |f| f.stops() == 2);
}

#[test]
fn navigate_hands_the_page_on() {
    let f = Fixture::new();
    f.send(slrw::MAGIC.to_vec());
    // No share URL in this process yet: a warning, nothing else.
    f.command(r#"{"type":"navigate","url":"https://example.com/"}"#);
    let page = tvpipe::__cli::opts::PageControl::default();
    set_page(page.clone());
    // Refused: not a page, Google Meet, no url.
    f.command(r#"{"type":"navigate","url":"ftp://example.com/"}"#);
    f.command(r#"{"type":"navigate","url":"https://meet.google.com/abc"}"#);
    f.command(r#"{"type":"navigate"}"#);
    f.command(r#"{"type":"navigate","url":"example.com/next"}"#);
    f.command(r#"{"type":"stop"}"#);
    f.until("stop", |f| f.stops() == 1);
    assert_eq!(page.take().as_deref(), Some("https://example.com/next"));
    assert_eq!(page.take(), None);
}

#[test]
fn playback_commands() {
    let f = Fixture::new();
    f.send(slrw::MAGIC.to_vec());
    // Before play of a file: warnings.
    f.command(r#"{"type":"pause"}"#);
    let c = tvpipe::__cli::PlaybackControl::new();
    set_playback(c.clone());
    // Not seekable yet: refused.
    f.command(r#"{"type":"seek","position_ms":1000}"#);
    f.command(r#"{"type":"stop"}"#);
    f.until("stop", |f| f.stops() == 1);
    assert_eq!(c.status().position, Duration::ZERO);
    c.enable(Some(Duration::from_secs(60)), false);
    f.command(r#"{"type":"seek","position_ms":30000}"#);
    f.command(r#"{"type":"seek","by_ms":-5000}"#);
    f.command(r#"{"type":"seek"}"#);
    f.command(r#"{"type":"seek","position_ms":-3}"#);
    f.command(r#"{"type":"pause"}"#);
    f.command(r#"{"type":"stop"}"#);
    f.until("stop", |f| f.stops() == 2);
    let st = c.status();
    assert_eq!(st.position, Duration::from_secs(25));
    assert!(st.paused);
    f.command(r#"{"type":"resume"}"#);
    f.command(r#"{"type":"stop"}"#);
    f.until("stop", |f| f.stops() == 3);
    assert!(!c.status().paused);
}

#[test]
fn forwards_after_claim_and_keeps_config() {
    let mut f = Fixture::new();
    f.send(slrw::MAGIC.to_vec());
    // Before the input opens: video dropped, the last config and control kept.
    f.record(4, 0, &[0, 1, 2]);
    f.record(3, 10, &[1, 0xaa]);
    f.record(4, 0, &[0, 9, 9]);
    f.record(5, 0, &1u32.to_le_bytes());
    f.command(r#"{"type":"nothing"}"#);
    // Let the router take them before the claim.
    std::thread::sleep(Duration::from_millis(50));
    let reader = f.router.reader();
    let handle = std::thread::spawn(move || read_packets(reader));
    f.until("keyframe request at the claim", |f| {
        f.keyframes.load(Ordering::SeqCst) == 1
    });
    f.record(3, 20, &[1, 0xbb]);
    // A command in the middle of media does not reach the input.
    f.command(r#"{"type":"pin","pin":"1234"}"#);
    f.record(2, 21, &[1, 2, 3, 4]);
    f.close();
    let packets = handle.join().unwrap();
    let kinds: Vec<(slrw::Kind, u64, Vec<u8>)> = packets
        .into_iter()
        .map(|p| (p.kind, p.pts_us, p.payload))
        .collect();
    assert_eq!(
        kinds,
        vec![
            (slrw::Kind::Control, 0, 1u32.to_le_bytes().to_vec()),
            (slrw::Kind::H264Config, 0, vec![0, 9, 9]),
            (slrw::Kind::H264, 20, vec![1, 0xbb]),
            (slrw::Kind::Audio, 21, vec![1, 2, 3, 4]),
        ]
    );
    assert_eq!(f.router.wait_pin().unwrap(), "1234");
    // EOF with an open input ends the stream; it is no stop request.
    std::thread::sleep(Duration::from_millis(20));
    assert_eq!(f.stops(), 0);
}

#[test]
fn end_record_before_the_input_stops() {
    let f = Fixture::new();
    f.send(slrw::MAGIC.to_vec());
    f.record(0, 0, &[]);
    f.until("stop", |f| f.stops() == 1);
}

#[test]
fn input_gone_keeps_commands_working() {
    let f = Fixture::new();
    f.send(slrw::MAGIC.to_vec());
    let mut reader = f.router.reader();
    let mut magic = [0u8; 4];
    reader.read_exact(&mut magic).unwrap();
    assert_eq!(&magic, slrw::MAGIC);
    drop(reader);
    f.record(1, 0, &[0; 16]);
    f.record(1, 1, &[0; 16]);
    f.command(r#"{"type":"stop"}"#);
    f.until("stop", |f| f.stops() == 1);
}

#[test]
fn malformed_stream_fails_and_stops() {
    let mut f = Fixture::new();
    f.send(b"NOPE".to_vec());
    f.until("stop", |f| f.stops() == 1);
    f.close();
    let msg = f.router.0.failure.lock().unwrap().clone().unwrap();
    assert!(msg.contains("magic"), "{msg}");

    // An unknown kind while the input reads: the input gets the error.
    let mut g = Fixture::new();
    g.send(slrw::MAGIC.to_vec());
    let mut reader = g.router.reader();
    let mut magic = [0u8; 4];
    reader.read_exact(&mut magic).unwrap();
    g.send(record(9, 0, &[]));
    let mut rest = Vec::new();
    let err = reader.read_to_end(&mut rest).unwrap_err();
    assert!(err.to_string().contains("unknown record kind 9"), "{err}");
    g.until("stop", |g| g.stops() == 1);
    g.close();

    // Oversized and truncated records never panic.
    for bytes in [
        record(6, 0, &[b'x'; (MAX_COMMAND + 1) as usize]),
        record(5, 0, &[0; 5]),
        vec![1, 0, 0],
        {
            let mut r = record(1, 0, &[0; 8]);
            r.truncate(15);
            r
        },
    ] {
        let mut h = Fixture::new();
        h.send(slrw::MAGIC.to_vec());
        h.send(bytes);
        h.close();
        h.until("stop", |h| h.stops() == 1);
        assert!(h.router.0.failure.lock().unwrap().is_some());
    }
}

#[test]
fn pin_after_eof_is_an_error() {
    let mut f = Fixture::new();
    f.send(slrw::MAGIC.to_vec());
    f.close();
    let e = f.router.wait_pin().unwrap_err();
    assert_eq!(e.code(), Some("pin-missing"));
}

#[test]
fn keyframe_lines_become_events() {
    // Partial lines are put together; other words are ignored.
    let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let s = seen.clone();
    let mut w = KeyframeEvents::new(Events::to(move |e| s.lock().unwrap().push(e)));
    w.write_all(b"keyf").unwrap();
    w.write_all(b"rame\nkeyframe\nother\n").unwrap();
    assert!(w.line.is_empty());
    assert_eq!(
        *seen.lock().unwrap(),
        vec![Event::Keyframe, Event::Keyframe]
    );
    w.write_all(&[b'x'; 1000]).unwrap();
    assert_eq!(w.line.len(), 256);
}

#[test]
fn event_shapes() {
    let e = Error::auth("TV requires pairing")
        .with_code("pairing-required")
        .with_device("TV");
    assert_eq!(
        error_event(&e).to_json(),
        r#"{"type":"error","kind":"auth","code":"pairing-required","message":"TV requires pairing","device":"TV"}"#
    );
    let e = Error::not_found("x");
    assert_eq!(
        error_event(&e).to_json(),
        r#"{"type":"error","kind":"not-found","message":"x"}"#
    );
    let v = Event::from_json(r#"{"type":"receiver","name":"TV","state":"failed","error":"x"}"#)
        .unwrap();
    assert_eq!(
        v.to_json(),
        r#"{"type":"receiver","name":"TV","state":"failed","error":"x"}"#
    );
}
