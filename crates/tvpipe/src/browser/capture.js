// tvpipe capture script (protocol: docs/share-protocol.md).
//
// Connects to tvpipe's WebSocket, captures a MediaStream (by default with
// getDisplayMedia), encodes the video as H.264 with WebCodecs and turns the
// audio into s16le PCM with an AudioWorklet, and streams both as SLRW
// records. Self-contained (no imports, no external resources), so tvpipe's
// share page uses it as its engine and the headless-browser mode can inject
// it into any page:
//
//   const c = tvpipeCapture.connect('ws://127.0.0.1:PORT/ws?t=TOKEN', opts);
//   c.on('status', s => ...);            // also: config, plan, stats, end, error, close
//   await c.captureDisplay();            // inside a user gesture (or auto-accepted)
//   // or: await c.share(mediaStream);
//   c.stop('reason');
//
// opts: preferCurrentTab, selfBrowserSurface ('exclude' by default),
// localAudio (keep playing captured tab audio locally; default false),
// surface (the picker's preselected kind: 'monitor', 'window', 'browser'),
// windowAudio (a window's sound: 'window' (its app), 'system', 'exclude'),
// profiles (H.264 profile order, e.g. ['42E0', '4D40', '6400']),
// worker (false: keep the video engine on the page).
//
// The video engine (frames -> padding -> VideoEncoder -> records) runs in a
// dedicated worker when the browser can move the video track there (Safari
// 18+, current Chrome): workers are not throttled when the page is a
// background tab, which it is while the user shows another tab of the
// shared window. Otherwise the same engine runs on the page.
(function (global) {
  'use strict';
  if (global.tvpipeCapture) return;

  // Helpers shared by the page and the engine (which may run in a worker:
  // this function's source is copied into it, so it must stay closed).
  function lib() {
    var L = {};
    L.KIND_AUDIO = 2; L.KIND_H264 = 3; L.KIND_CONFIG = 4;
    L.FLAG_KEY = 1; L.FLAG_ANNEXB = 2;
    // [level_idc, MaxFS (macroblocks), MaxMBPS] (H.264 Table A-1).
    var LEVELS = [
      [0x1e, 1620, 40500], [0x1f, 3600, 108000], [0x20, 5120, 216000],
      [0x28, 8192, 245760], [0x2a, 8704, 522240], [0x32, 22080, 589824],
      [0x33, 36864, 983040], [0x34, 36864, 2073600]
    ];
    // The media clock, µs. timeOrigin + now() so a worker and the page
    // (whose performance.now() start at different times) agree.
    L.clock = function () { return Math.round((performance.timeOrigin + performance.now()) * 1000); };
    L.hex2 = function (n) { return (n < 16 ? '0' : '') + n.toString(16).toUpperCase(); };
    L.avcLevel = function (w, h, fps) {
      var fs = Math.ceil(w / 16) * Math.ceil(h / 16), mbps = fs * fps;
      for (var i = 0; i < LEVELS.length; i++) {
        if (fs <= LEVELS[i][1] && mbps <= LEVELS[i][2]) return LEVELS[i][0];
      }
      return 0x34;
    };
    // Where a sw x sh picture goes in a dw x dh frame: as large as fits at
    // its own aspect ratio, centered, even values. Keep in step with
    // `browser::layout::place` (tvpipe sends this for the planned size).
    L.place = function (sw, sh, dw, dh) {
      var even = function (v) { return Math.max(2, v - (v % 2)); };
      sw = Math.max(1, sw); sh = Math.max(1, sh); dw = Math.max(2, dw); dh = Math.max(2, dh);
      var w, h;
      if (sw * dh >= sh * dw) {
        w = dw;
        h = Math.floor((sh * dw + Math.floor(sw / 2)) / sw);
      } else {
        w = Math.floor((sw * dh + Math.floor(sh / 2)) / sh);
        h = dh;
      }
      w = even(Math.min(w, dw));
      h = even(Math.min(h, dh));
      var x = Math.floor((dw - w) / 2), y = Math.floor((dh - h) / 2);
      return { x: x - (x % 2), y: y - (y % 2), width: w, height: h };
    };
    // One SLRW record: u8 kind | u64le pts_us | u32le len | payload parts.
    L.record = function (kind, pts, parts) {
      var len = 0, i;
      for (i = 0; i < parts.length; i++) len += parts[i].byteLength;
      var buf = new Uint8Array(13 + len);
      var dv = new DataView(buf.buffer);
      dv.setUint8(0, kind);
      pts = Math.max(0, Math.round(pts));
      dv.setUint32(1, pts % 4294967296, true);
      dv.setUint32(5, Math.floor(pts / 4294967296), true);
      dv.setUint32(9, len, true);
      var off = 13;
      for (i = 0; i < parts.length; i++) {
        buf.set(parts[i], off);
        off += parts[i].byteLength;
      }
      return buf.buffer;
    };
    // Which captured frames are encoded and their timestamps (µs).
    // Receivers show each frame at its timestamp, so the timestamps keep
    // an even cadence: a frame takes the next slot of a grid one plan
    // interval apart when it was captured up to 0.4 intervals before it
    // or half an interval after it, the slot nearest to it after a gap,
    // and is skipped when it comes earlier (a source faster than the
    // plan: of a source at twice the rate, every other frame, never
    // alternating, which half an interval would). The grid follows the
    // source's phase slowly (an eighth of each frame's offset), so slots
    // stay centered on the capture times and capture jitter never moves
    // a frame to another slot. `force` (keyframes, repeats of a still
    // picture) never skips.
    L.pacer = function (frameUs) {
      var next = null, half = frameUs / 2;
      return function (ts, force) {
        if (next === null) next = ts;
        if (ts < next - 0.4 * frameUs && !force) return null;
        var pts = next;
        if (ts >= next + half) pts = next + Math.round((ts - next) / frameUs) * frameUs;
        var e = Math.max(-half, Math.min(half, ts - pts));
        next = pts + frameUs + e / 8;
        return pts;
      };
    };
    // When a frame was captured, on the media clock (µs): its own
    // timestamp (the browser's capture time, steady even when the thread
    // reading the frames is busy) moved onto the clock by the smallest
    // delay seen between capture and arrival (creeping up 2 µs a frame,
    // for clocks that drift apart). Where the timestamp is of no use
    // (missing, going back, or a second off), the arrival time.
    L.captureClock = function () {
      var offset = null, last = -Infinity;
      return function (ts, now) {
        if (typeof ts !== 'number' || !isFinite(ts) || ts <= last) {
          offset = null;
          last = typeof ts === 'number' && isFinite(ts) ? ts : -Infinity;
          return now;
        }
        last = ts;
        var off = now - ts;
        if (offset === null || off < offset || off - offset > 1e6) offset = off;
        else offset += Math.min(2, off - offset);
        return ts + offset;
      };
    };
    // Audio timestamps (µs) for chunks of `n` samples at `rate` Hz that
    // arrive at `now`: by the sample count, so a late message (the page's
    // thread was busy) keeps its place. The count starts at the first
    // chunk's arrival minus its length, moves earlier when a chunk comes
    // before its counted end, and later when it ends up a second behind
    // (a gap) or every chunk of two seconds came more than 20 ms after
    // its counted end (the clocks drifted, or the start was early).
    L.audioClock = function (rate) {
      var base = null, count = 0, least = Infinity, since = 0;
      return function (n, now) {
        var dur = n / rate * 1e6;
        if (base === null) { base = now - dur; since = now; }
        var pts = base + count / rate * 1e6;
        var delay = now - (pts + dur);
        if (delay < 0 || delay > 1e6) { base += delay; pts += delay; delay = 0; }
        least = Math.min(least, delay);
        if (now - since >= 2e6) {
          if (least > 20000) { base += least; pts += least; }
          least = Infinity;
          since = now;
        }
        count += n;
        return pts;
      };
    };
    L.bytesOf = function (src) {
      if (src instanceof ArrayBuffer) return new Uint8Array(src.slice(0));
      return new Uint8Array(src.buffer.slice(src.byteOffset, src.byteOffset + src.byteLength));
    };
    L.sameBytes = function (a, b) {
      if (!a || !b || a.length !== b.length) return false;
      for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
      return true;
    };
    return L;
  }

  // The video engine. `post(msg, transfer)` reports to the page, `every(ms,
  // fn)` returns a cancel function. Messages in: start, track, frame,
  // keyframe, bitrate, buffered, stop. Out: size, record, keySent, codec, stats, log,
  // fail, ended. Closed over nothing but its arguments (copied into a
  // worker as source).
  function engine(L, post, every) {
    // Bytes waiting in the socket before new frames are dropped (tvpipe is
    // behind; dropping before the encoder keeps the stream decodable).
    var MAX_BUFFERED = 4 << 20;
    // Without new frames (static content), the last one is encoded again
    // this often, so receivers keep getting pictures and keyframes.
    var IDLE_REPEAT_MS = 250;
    var STATS_MS = 2000;
    // Encoder warm-up: keyframes later than this are discarded (and asked
    // for again) until one is on time, for at most WARMUP_MAX_MS.
    var WARMUP_LATE_MS = 150;
    var WARMUP_MAX_MS = 3000;
    // Constrained Baseline first: no B-frames anywhere, every encoder has it.
    var DEFAULT_PROFILES = ['42E0', '4D40', '6400'];

    var plan = null, capture = null, enc = null, encCfg = null, frameUs = 33333;
    var lastFrame = null, lastEncodeAt = -1e15, lastSourceAt = -1e15, needKey = true, sinceKey = 0;
    var pace = null, captured = L.captureClock();
    var lastDesc = null, lastChunkTs = -1, sentKey = false, firstChunkAt = null;
    var buffered = 0, canvas = null, g2d = null, sizeSent = false, stopped = false;
    var timers = [], reader = null, track = null, keyAskedAt = null, warnedOrder = false;
    // The worker's own socket for its records (`media`), when it has one.
    var sock = null;
    var codec = '';
    var stats = fresh();

    function fresh() {
      return {
        since: L.clock(), source: 0, encoded: 0, repeated: 0, dropped: 0, paced: 0, chunks: 0, keys: 0,
        bytes: 0, latencySum: 0, keyRequests: 0, warmup: 0, keyLatencyMs: null
      };
    }
    function log(level, message) { post({ type: 'log', level: level, message: String(message) }); }
    function fail(message) { post({ type: 'fail', message: String(message) }); stop(); }

    function frame(f) {
      if (stopped) { f.close(); return; }
      if (!sizeSent) {
        sizeSent = true;
        post({ type: 'size', width: f.displayWidth, height: f.displayHeight });
      }
      if (lastFrame) lastFrame.close();
      lastFrame = f;
      var now = L.clock();
      var t = captured(f.timestamp, now);
      lastSourceAt = now;
      if (!enc) return;
      stats.source++;
      encode(f, t, false);
    }

    function readTrack(tr) {
      track = tr;
      readFrames(new MediaStreamTrackProcessor({ track: tr }).readable);
    }

    // Frames from a MediaStreamTrackProcessor's readable (made here, or
    // on the page and moved here: Chrome cannot move the track itself).
    function readFrames(readable) {
      var r = readable.getReader();
      reader = r;
      var pump = function () {
        r.read().then(function (x) {
          if (x.done || stopped) {
            if (x.value) x.value.close();
            if (x.done && !stopped) post({ type: 'ended' });
            return;
          }
          frame(x.value);
          pump();
        }, function () { if (!stopped) post({ type: 'ended' }); });
      };
      pump();
    }

    function pickCodec(p, profiles) {
      var lvl = L.hex2(L.avcLevel(p.width, p.height, p.fps));
      var base = {
        width: p.width, height: p.height, bitrate: p.bitrate, framerate: p.fps,
        latencyMode: 'realtime', avc: { format: 'avc' }
      };
      var i = 0;
      var next = function () {
        if (i >= profiles.length) {
          return Promise.reject(new Error('this browser cannot encode H.264 at ' + p.width + 'x' + p.height));
        }
        var cfg = Object.assign({}, base, { codec: 'avc1.' + profiles[i++] + lvl });
        return VideoEncoder.isConfigSupported(cfg).then(function (r) {
          return r && r.supported ? cfg : next();
        }, function () { return next(); });
      };
      return next();
    }

    // A record to tvpipe: over the media socket, else through the page.
    function send(rec) {
      if (sock && sock.readyState === 1) sock.send(rec);
      else post({ type: 'record', data: rec }, [rec]);
    }

    // A worker opens a socket of its own for its records, so they never
    // wait for the page's thread (busy with the page itself). Resolves
    // once tvpipe took the key, or without a socket (no worker, no key,
    // refused, or no answer within a second): then the page sends them.
    function openMedia(media) {
      if (!media || !media.key || typeof WebSocket !== 'function' || typeof window !== 'undefined') {
        return Promise.resolve();
      }
      return new Promise(function (resolve) {
        var ws, done = false;
        var settle = function (ok) {
          if (done) return;
          done = true;
          if (ok && !stopped) {
            sock = ws;
            ws.onclose = function () { sock = null; };
          } else {
            try { ws.close(); } catch (e) { /* closed */ }
          }
          resolve();
        };
        try {
          ws = new WebSocket(media.url);
        } catch (e) {
          resolve();
          return;
        }
        ws.binaryType = 'arraybuffer';
        ws.onopen = function () { ws.send(JSON.stringify({ type: 'media', key: media.key })); };
        ws.onmessage = function (e) {
          var m = null;
          try { m = JSON.parse(e.data); } catch (err) { /* binary or junk */ }
          if (m && m.type === 'media') settle(true);
        };
        ws.onerror = ws.onclose = function () { settle(false); };
        setTimeout(function () { settle(false); }, 1000);
      });
    }

    function start(m) {
      plan = m.plan;
      capture = m.capture;
      frameUs = 1e6 / (plan.fps || 30);
      pace = L.pacer(frameUs);
      Promise.all([pickCodec(plan, m.profiles || DEFAULT_PROFILES), openMedia(m.media)]).then(function (r) {
        var cfg = r[0];
        if (stopped) return;
        codec = cfg.codec;
        enc = new VideoEncoder({
          output: chunk,
          error: function (e) { fail('video encoder: ' + (e && e.message || e)); }
        });
        enc.configure(cfg);
        encCfg = cfg;
        post({ type: 'codec', codec: codec });
        log('info', 'encoding ' + codec + ' ' + plan.width + 'x' + plan.height + '@' + plan.fps + ' ' +
          Math.round(plan.bitrate / 1000) + ' kbit/s');
        timers.push(every(IDLE_REPEAT_MS / 2, idle));
        timers.push(every(STATS_MS, report));
        // A frame that arrived before the plan starts the stream.
        if (lastFrame) encode(lastFrame, L.clock(), true);
      }, function (e) { fail(e && e.message || e); });
    }

    // A still source: the last picture again (not while frames come and
    // are dropped: the encoder or the socket are behind).
    function idle() {
      var t = L.clock(), idleUs = IDLE_REPEAT_MS * 1000;
      if (lastFrame && t - lastEncodeAt >= idleUs && t - lastSourceAt >= idleUs) {
        stats.repeated++;
        encode(lastFrame, t, true);
      }
    }

    function keyframe() {
      needKey = true;
      stats.keyRequests++;
      if (keyAskedAt === null) keyAskedAt = L.clock();
      // The next captured frame becomes the keyframe; static content may
      // send none for a while: then encode the last one again now.
      var t = L.clock();
      if (lastFrame && t - lastSourceAt >= 2 * frameUs && t - lastEncodeAt >= frameUs / 2) {
        encode(lastFrame, t, true);
      }
    }

    // Adaptive bitrate: tvpipe's new target. WebCodecs takes a new bitrate
    // on a configured encoder (same codec and size: no new stream).
    function bitrate(bps) {
      if (!(bps > 0)) return;
      if (plan) plan.bitrate = bps;
      if (!enc || enc.state !== 'configured' || !encCfg) return;
      encCfg = Object.assign({}, encCfg, { bitrate: bps });
      try {
        enc.configure(encCfg);
      } catch (e) {
        log('warn', 'video encoder: cannot change the bitrate: ' + (e && e.message || e));
      }
    }

    // Where a w x h source goes: the plan's rectangle while the capture
    // keeps the size tvpipe planned with, else recomputed (a resized
    // window) the same way.
    function rect(w, h) {
      if (plan.content && capture && w === capture.width && h === capture.height) return plan.content;
      return L.place(w, h, plan.width, plan.height);
    }

    // Draws the source into an output-sized canvas at r, black around it
    // (receivers stretch what they get to their screen, so the frame has
    // the screen's shape). GPU-side.
    function drawn(src, r, t) {
      var W = plan.width, H = plan.height;
      if (!canvas) {
        canvas = new OffscreenCanvas(W, H);
        g2d = canvas.getContext('2d', { alpha: false, desynchronized: true });
        g2d.imageSmoothingEnabled = true;
        g2d.imageSmoothingQuality = 'high';
      }
      if (r.x > 0 || r.y > 0 || r.width < W || r.height < H) {
        g2d.fillStyle = '#000';
        g2d.fillRect(0, 0, W, H);
      }
      g2d.drawImage(src, r.x, r.y, r.width, r.height);
      return new VideoFrame(canvas, { timestamp: t, alpha: 'discard' });
    }

    // Encodes `src` captured at `t` (µs, media clock) if the pacer gives
    // it a slot (`force`: always).
    function encode(src, t, force) {
      if (!enc || enc.state !== 'configured') return;
      var pts = pace(t, force);
      if (pts === null) {
        stats.paced++;
        return;
      }
      if ((sock ? sock.bufferedAmount : buffered) > MAX_BUFFERED || enc.encodeQueueSize > 2) {
        stats.dropped++;
        return;
      }
      t = Math.round(pts);
      var f;
      try {
        var w = src.displayWidth, h = src.displayHeight, r = rect(w, h);
        // Exactly the frame's size and position: no copy.
        f = (r.x === 0 && r.y === 0 && w === plan.width && h === plan.height &&
             r.width === w && r.height === h)
          ? new VideoFrame(src, { timestamp: t })
          : drawn(src, r, t);
      } catch (e) {
        stats.dropped++;
        return;
      }
      var key = needKey || sinceKey + 1 >= (plan.keyInterval || 30);
      try {
        enc.encode(f, { keyFrame: key });
      } finally {
        f.close();
      }
      if (key) { needKey = false; sinceKey = 0; } else { sinceKey++; }
      lastEncodeAt = L.clock();
      stats.encoded++;
    }

    function chunk(c, md) {
      if (stopped) return;
      var cfg = md && md.decoderConfig;
      if (cfg && cfg.description) {
        var desc = L.bytesOf(cfg.description);
        if (!L.sameBytes(desc, lastDesc)) {
          lastDesc = desc;
          var rec = L.record(L.KIND_CONFIG, c.timestamp, [new Uint8Array([0]), desc]);
          send(rec);
        }
      }
      var now = L.clock(), late = (now - c.timestamp) / 1000;
      if (!sentKey) {
        // The first pictures out of a (hardware) encoder can be most of a
        // second old: starting with them would put tvpipe's timeline that
        // far behind (Cast's in-flight window overflows at once). Wait for
        // a keyframe that is on time, unless the encoder never gets there.
        if (firstChunkAt === null) firstChunkAt = now;
        var patient = now - firstChunkAt < WARMUP_MAX_MS * 1000;
        if (c.type !== 'key' || (late > WARMUP_LATE_MS && patient)) {
          if (c.type === 'key') needKey = true;
          stats.warmup++;
          return;
        }
      }
      var data = new Uint8Array(c.byteLength);
      c.copyTo(data);
      var flags = c.type === 'key' ? L.FLAG_KEY : 0;
      // Without an avcC the encoder made Annex B (parameter sets in band).
      if (!lastDesc && data.length > 4 && data[0] === 0 && data[1] === 0 &&
          (data[2] === 1 || (data[2] === 0 && data[3] === 1))) flags |= L.FLAG_ANNEXB;
      if (c.timestamp <= lastChunkTs && !warnedOrder) {
        warnedOrder = true;
        log('warn', 'the encoder reorders frames (B-frames?)');
      }
      lastChunkTs = c.timestamp;
      var buf = L.record(L.KIND_H264, c.timestamp, [new Uint8Array([flags]), data]);
      send(buf);
      if (flags & L.FLAG_KEY) {
        stats.keys++;
        if (keyAskedAt !== null) {
          stats.keyLatencyMs = (now - keyAskedAt) / 1000;
          keyAskedAt = null;
        }
        if (!sentKey) {
          sentKey = true;
          post({ type: 'keySent' });
        }
      }
      stats.bytes += data.length;
      stats.chunks++;
      stats.latencySum += late;
    }

    function report() {
      var s = stats, secs = (L.clock() - s.since) / 1e6;
      if (secs <= 0) return;
      post({
        type: 'stats',
        fps: +(s.chunks / secs).toFixed(1),
        sourceFps: +(s.source / secs).toFixed(1),
        kbps: Math.round(s.bytes * 8 / secs / 1000),
        targetKbps: plan ? Math.round(plan.bitrate / 1000) : 0,
        encodeMs: s.chunks ? +(s.latencySum / s.chunks).toFixed(1) : null,
        dropped: s.dropped, paced: s.paced, repeated: s.repeated, keyRequests: s.keyRequests, keys: s.keys,
        keyLatencyMs: s.keyLatencyMs, warmup: s.warmup,
        queue: enc ? enc.encodeQueueSize : 0, buffered: sock ? sock.bufferedAmount : buffered, codec: codec,
        width: plan ? plan.width : 0, height: plan ? plan.height : 0
      });
      stats = fresh();
    }

    function stop() {
      if (stopped) return;
      stopped = true;
      timers.forEach(function (cancel) { cancel(); });
      timers = [];
      if (reader) reader.cancel().catch(function () {});
      if (track) track.stop();
      if (enc && enc.state !== 'closed') { try { enc.close(); } catch (e) { /* closed */ } }
      if (lastFrame) { lastFrame.close(); lastFrame = null; }
      if (sock) { try { sock.close(); } catch (e) { /* closed */ } sock = null; }
    }

    return function (m) {
      switch (m.type) {
        case 'start': start(m); break;
        case 'track': readTrack(m.track); break;
        case 'readable': readFrames(m.readable); break;
        case 'frame': frame(m.frame); break;
        case 'keyframe': keyframe(); break;
        case 'bitrate': bitrate(m.bitrate); break;
        case 'buffered': buffered = m.bytes; break;
        case 'stop': stop(); break;
      }
    };
  }

  var L = lib();
  var VERSION = 1;
  var STATS_MS = 2000;
  // How long the capture's size may wait for its first frame (a still
  // window may deliver none for a while; then the track settings count).
  var CAPTURE_WAIT_MS = 1500;
  var MAX_BUFFERED = 4 << 20;
  // The engine as a worker: it reports whether it can take the track.
  var WORKER_SOURCE =
    'var L = (' + lib.toString() + ')();\n' +
    'var handle = (' + engine.toString() + ')(L, function (m, t) { postMessage(m, t || []); },\n' +
    '  function (ms, fn) { var id = setInterval(fn, ms); return function () { clearInterval(id); }; });\n' +
    'postMessage({ type: "hello", ok: typeof VideoEncoder === "function" && typeof OffscreenCanvas === "function",\n' +
    '  processor: typeof MediaStreamTrackProcessor === "function" });\n' +
    'onmessage = function (e) { handle(e.data); };\n';

  // Which browser family: what getDisplayMedia can capture differs.
  function family() {
    var ua = navigator.userAgent;
    if (/Firefox\//.test(ua)) return 'firefox';
    if (/Chrome\/|Chromium\/|Edg\//.test(ua)) return 'chromium';
    if (/Version\/[\d.]+.*Safari\//.test(ua)) return 'safari';
    return 'other';
  }

  // What this browser can do. `tabs`: getDisplayMedia offers single tabs;
  // `audio`: it can capture the shared surface's sound (Chromium: tab audio,
  // and system audio on Windows/ChromeOS; Safari and Firefox: none).
  function features() {
    var fam = family();
    return {
      family: fam,
      secure: !!global.isSecureContext,
      displayMedia: !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia),
      webcodecs: typeof global.VideoEncoder === 'function',
      trackProcessor: typeof global.MediaStreamTrackProcessor === 'function',
      audioWorklet: typeof global.AudioWorkletNode === 'function',
      tabs: fam === 'chromium',
      audio: fam === 'chromium'
    };
  }

  // Background tabs throttle timers (to 1/s, later 1/min), and the share
  // page is in the background while another tab is shown. Ticks from a
  // worker arrive as messages, which are not throttled; plain intervals
  // are the fallback (e.g. a page whose CSP forbids blob workers).
  var TICKER = 'var t=null;onmessage=function(e){clearInterval(t);if(e.data>0)t=setInterval(function(){postMessage(0)},e.data)}';
  function every(ms, fn) {
    var w = null, id = null;
    var fallback = function () {
      if (w) { w.terminate(); w = null; }
      if (id === null) id = setInterval(fn, ms);
    };
    try {
      var url = URL.createObjectURL(new Blob([TICKER], { type: 'text/javascript' }));
      w = new Worker(url);
      URL.revokeObjectURL(url);
      w.onmessage = fn;
      w.onerror = fallback;
      w.postMessage(ms);
    } catch (e) {
      fallback();
    }
    return function () {
      if (w) w.terminate();
      if (id !== null) clearInterval(id);
      w = null;
      id = null;
    };
  }

  // Resamples (linearly) to the plan rate, converts to s16le interleaved,
  // and posts ~10 ms chunks. Outputs stay silent.
  var WORKLET = [
    'class TvpipePcm extends AudioWorkletProcessor {',
    '  constructor(o) {',
    '    super();',
    '    var p = o.processorOptions;',
    '    this.ch = p.channels; this.chunk = p.chunk;',
    '    this.step = sampleRate / p.rate; this.t = 0;',
    '    this.prev = new Float32Array(this.ch);',
    '    this.out = new Int16Array(this.chunk * this.ch); this.n = 0;',
    '    this.on = true;',
    '    this.port.onmessage = (e) => { if (e.data === "stop") this.on = false; };',
    '  }',
    '  process(inputs) {',
    '    if (!this.on) return false;',
    '    var inp = inputs[0] || [];',
    '    var frames = inp.length ? inp[0].length : 128;',
    '    var ch = this.ch, prev = this.prev;',
    '    var s = function (c, k) {',
    '      if (!inp.length) return 0;',
    '      return k < 0 ? prev[c] : inp[Math.min(c, inp.length - 1)][k];',
    '    };',
    '    while (this.t < frames - 1) {',
    '      var i = Math.floor(this.t), f = this.t - i;',
    '      for (var c = 0; c < ch; c++) {',
    '        var v = s(c, i) + (s(c, i + 1) - s(c, i)) * f;',
    '        v = v < -1 ? -1 : v > 1 ? 1 : v;',
    '        this.out[this.n * ch + c] = Math.round(v * 32767);',
    '      }',
    '      if (++this.n === this.chunk) {',
    '        this.port.postMessage(this.out.buffer, [this.out.buffer]);',
    '        this.out = new Int16Array(this.chunk * ch); this.n = 0;',
    '      }',
    '      this.t += this.step;',
    '    }',
    '    this.t -= frames;',
    '    for (var c2 = 0; c2 < ch; c2++) prev[c2] = s(c2, frames - 1);',
    '    return true;',
    '  }',
    '}',
    'registerProcessor("tvpipe-pcm", TvpipePcm);'
  ].join('\n');

  function Capture(url, opts) {
    this.url = url;
    this.opts = opts || {};
    this.handlers = {};
    this.config = null;
    this.plan = null;
    this.stream = null;
    this.engine = null;
    this.worker = null;
    this.mode = '';
    this.audioCtx = null;
    this.audioNode = null;
    this.sentKey = false;
    this.timers = [];
    this.stopped = false;
    this.codec = '';
    this.audioBytes = 0;
    this.audioPeak = 0;
    this.audioDropped = 0;
    this.audioSince = L.clock();
    this.ws = new WebSocket(url);
    this.ws.binaryType = 'arraybuffer';
    var self = this;
    this.ws.onopen = function () {
      self._send({
        type: 'hello', version: VERSION, clock: L.clock(), agent: navigator.userAgent,
        features: features()
      });
      self._emit('open');
    };
    this.ws.onmessage = function (e) {
      if (typeof e.data !== 'string') return;
      var m;
      try { m = JSON.parse(e.data); } catch (err) { return; }
      self._message(m);
    };
    this.ws.onclose = function (e) {
      self._teardown();
      self._emit('close', { code: e.code, reason: e.reason });
    };
  }

  Capture.prototype.on = function (ev, fn) {
    (this.handlers[ev] = this.handlers[ev] || []).push(fn);
    return this;
  };

  Capture.prototype._emit = function (ev, data) {
    var hs = this.handlers[ev] || [];
    for (var i = 0; i < hs.length; i++) {
      try { hs[i](data); } catch (e) { /* a UI error must not stop the stream */ }
    }
  };

  Capture.prototype._send = function (obj) {
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  };

  Capture.prototype._log = function (level, message) {
    this._send({ type: 'log', level: level, message: String(message) });
    this._emit('log', { level: level, message: String(message) });
  };

  Capture.prototype._fail = function (message) {
    this._log('error', message);
    this._emit('error', String(message));
    this.stop(String(message));
  };

  Capture.prototype._toEngine = function (m, transfer) {
    if (this.worker) this.worker.postMessage(m, transfer || []);
    else if (this.engine) this.engine(m);
  };

  Capture.prototype._message = function (m) {
    switch (m.type) {
      case 'channel':
        // The key the worker's own socket for records takes (`media`).
        this.mediaKey = m.key;
        break;
      case 'config':
        this.config = m;
        this._emit('config', m);
        break;
      case 'status':
        this._emit('status', m);
        break;
      case 'plan':
        this.plan = m;
        this._emit('plan', m);
        this._start(m);
        break;
      case 'keyframe':
        this._toEngine({ type: 'keyframe' });
        break;
      case 'bitrate':
        this._toEngine({ type: 'bitrate', bitrate: m.bitrate });
        if (this.plan) {
          this.plan.bitrate = m.bitrate;
          this._emit('bitrate', m.bitrate);
        }
        break;
      case 'busy':
        this._emit('error', 'another page is already sharing to tvpipe');
        this._teardown();
        break;
      case 'end':
        this._teardown();
        this._emit('end', m.reason || 'tvpipe stopped');
        break;
    }
  };

  // Creates the AudioContext while the user gesture is still fresh (it
  // may start suspended otherwise). Only where display audio exists.
  Capture.prototype._prepareAudio = function () {
    if (this.audioCtx || !this.config || !this.config.audio) return;
    var Ctx = global.AudioContext || global.webkitAudioContext;
    if (!Ctx) return;
    try {
      this.audioCtx = new Ctx({ sampleRate: this.config.sampleRate, latencyHint: 'interactive' });
    } catch (e) {
      try { this.audioCtx = new Ctx(); } catch (e2) { this.audioCtx = null; }
    }
    if (this.audioCtx && this.audioCtx.state !== 'running') this.audioCtx.resume().catch(function () {});
  };

  // getDisplayMedia with the constraints tvpipe asked for, then share().
  Capture.prototype.captureDisplay = function (extra) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      return Promise.reject(new Error('this browser cannot capture the screen (getDisplayMedia)'));
    }
    var cfg = this.config || { fps: 30, audio: true };
    var o = this.opts, f = features();
    if (o.preferCurrentTab && f.family === 'firefox') return this._captureFirefoxTab(cfg);
    var video = { frameRate: { ideal: cfg.fps, max: cfg.fps } };
    // Safari and Firefox share windows and screens (no tabs) and no
    // sound: suggest a window, and do not ask for audio (a refused
    // constraint could not be retried without a new click).
    if (!f.tabs) video.displaySurface = 'window';
    if (o.surface) video.displaySurface = o.surface;
    var audio = cfg.audio && f.audio ? {
      echoCancellation: false, noiseSuppression: false, autoGainControl: false,
      channelCount: { ideal: 2 },
      suppressLocalAudioPlayback: !o.localAudio
    } : false;
    var c = { video: video, audio: audio };
    if (f.family === 'chromium') {
      c.selfBrowserSurface = o.selfBrowserSurface || 'exclude';
      c.surfaceSwitching = 'include';
      c.systemAudio = 'include';
      if (o.windowAudio) c.windowAudio = o.windowAudio;
      if (o.preferCurrentTab) c.preferCurrentTab = true;
    }
    for (var k in (extra || {})) c[k] = extra[k];
    if (audio) this._prepareAudio();
    var self = this;
    return navigator.mediaDevices.getDisplayMedia(c).then(function (stream) { return self.share(stream); });
  };

  // Firefox has no tab capture in getDisplayMedia (and no preferCurrentTab),
  // but its older getUserMedia sources still capture this tab's viewport
  // ('browser') and the sound this tab plays ('audioCapture'), behind the
  // prefs tvpipe's own Firefox sets (media.getusermedia.browser.enabled,
  // media.getusermedia.audio.capture.enabled; the permission prompt off).
  // Like getDisplayMedia it needs transient activation. (The capture keeps
  // playing the sound locally; tvpipe's Firefox mutes its output instead.)
  Capture.prototype._captureFirefoxTab = function (cfg) {
    var c = {
      video: { mediaSource: 'browser', frameRate: { ideal: cfg.fps, max: cfg.fps } },
      audio: cfg.audio ? { mediaSource: 'audioCapture' } : false
    };
    var self = this;
    return navigator.mediaDevices.getUserMedia(c).then(function (stream) {
      self.surface = 'browser';
      return self.share(stream);
    });
  };

  // Streams `stream` (its first video track and first audio track).
  Capture.prototype.share = function (stream) {
    if (this.stream) return Promise.reject(new Error('already sharing'));
    if (typeof global.VideoEncoder !== 'function') {
      stream.getTracks().forEach(function (t) { t.stop(); });
      return Promise.reject(new Error('this browser has no WebCodecs VideoEncoder'));
    }
    var vt = stream.getVideoTracks()[0];
    if (!vt) return Promise.reject(new Error('the stream has no video'));
    this.stream = stream;
    var self = this;
    var at = stream.getAudioTracks()[0];
    if (at) at.addEventListener('ended', function () { self._log('info', 'the shared audio ended'); });
    vt.addEventListener('ended', function () { self._stoppedInBrowser(); });
    // The size tvpipe plans with is the first real frame's: track
    // settings can report the constraint ceiling (e.g. the screen) rather
    // than what the frames are. The settings are the fallback.
    var s = vt.getSettings ? vt.getSettings() : {};
    this.captureInfo = {
      type: 'capture',
      width: s.width || 0, height: s.height || 0, fps: s.frameRate || null,
      audio: !!at, surface: s.displaySurface || this.surface || null, label: vt.label || null
    };
    this.timers.push(every(CAPTURE_WAIT_MS, function () { self._sendCapture(null); }));
    // Socket backlog for the engine's flow control.
    this.timers.push(every(100, function () {
      self._toEngine({ type: 'buffered', bytes: self.ws.bufferedAmount });
    }));
    return this._startEngine(vt);
  };

  // The engine in a worker when the track can move there (Safari) or a
  // MediaStreamTrackProcessor's readable made here can (Chrome: the
  // frames then reach the worker without passing this page's thread,
  // which the page itself keeps busy), else here.
  Capture.prototype._startEngine = function (vt) {
    var self = this;
    var onEngine = function (m) { self._fromEngine(m); };
    var inPage = function () {
      self.mode = 'page';
      self.engine = engine(L, onEngine, every);
      self._pageSource(vt);
    };
    if (this.opts.worker === false || typeof global.Worker !== 'function') {
      inPage();
      return Promise.resolve();
    }
    return new Promise(function (resolve) {
      var w, url;
      try {
        url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }));
        w = new Worker(url);
        URL.revokeObjectURL(url);
      } catch (e) {
        inPage();
        resolve();
        return;
      }
      var settled = false;
      var settle = function (ok) {
        if (settled) return;
        settled = true;
        if (!ok) { w.terminate(); inPage(); }
        resolve();
      };
      setTimeout(function () { settle(false); }, 2000);
      w.onerror = function () { settle(false); };
      w.onmessage = function (e) {
        var m = e.data;
        if (m.type !== 'hello') { onEngine(m); return; }
        if (!m.ok) { settle(false); return; }
        var moved = false;
        if (m.processor) {
          try {
            w.postMessage({ type: 'track', track: vt }, [vt]);
            moved = true;
          } catch (err) { /* not transferable here */ }
        }
        if (!moved && typeof global.MediaStreamTrackProcessor === 'function') {
          try {
            var readable = new global.MediaStreamTrackProcessor({ track: vt }).readable;
            w.postMessage({ type: 'readable', readable: readable }, [readable]);
            moved = true;
          } catch (err) { /* streams are not transferable here */ }
        }
        if (!moved) { settle(false); return; }
        self.worker = w;
        self.mode = 'worker';
        settle(true);
      };
    });
  };

  // Frames on the page: MediaStreamTrackProcessor where it exists, else a
  // hidden <video> and VideoFrame(video) per new frame (Firefox).
  Capture.prototype._pageSource = function (track) {
    var self = this;
    var feed = function (f) { self._toEngine({ type: 'frame', frame: f }); };
    if (typeof global.MediaStreamTrackProcessor === 'function') {
      var reader = new global.MediaStreamTrackProcessor({ track: track }).readable.getReader();
      this.reader = reader;
      var pump = function () {
        reader.read().then(function (r) {
          if (r.done || self.stopped) { if (r.value) r.value.close(); return; }
          feed(r.value);
          pump();
        }, function () {});
      };
      pump();
      return;
    }
    var v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.autoplay = true;
    v.srcObject = new MediaStream([track]);
    v.style.cssText = 'position:fixed;left:-10px;top:-10px;width:2px;height:2px;opacity:0;pointer-events:none';
    (document.body || document.documentElement).appendChild(v);
    this.videoEl = v;
    var grab = function () {
      if (self.stopped || v.readyState < 2 || !v.videoWidth) return;
      var f;
      try { f = new VideoFrame(v, { timestamp: L.clock() }); } catch (e) { return; }
      feed(f);
    };
    v.play().catch(function () {});
    var fps = (this.config && this.config.fps) || 30;
    var interval = Math.max(5, Math.round(1000 / fps)), lastShown = -1e9;
    if (typeof v.requestVideoFrameCallback === 'function') {
      var cb = function () {
        lastShown = performance.now();
        grab();
        if (!self.stopped) v.requestVideoFrameCallback(cb);
      };
      v.requestVideoFrameCallback(cb);
    }
    // Also on a timer while rVFC is quiet: it stops in background tabs
    // (and copying each picture twice would be wasted).
    this.timers.push(every(interval, function () {
      if (performance.now() - lastShown > 2 * interval) grab();
    }));
  };

  Capture.prototype._fromEngine = function (m) {
    switch (m.type) {
      case 'size': this._sendCapture(m); break;
      case 'record':
        if (!this.stopped && this.ws.readyState === 1) this.ws.send(m.data);
        break;
      case 'keySent': this.sentKey = true; break;
      case 'codec': this.codec = m.codec; break;
      case 'log': this._log(m.level, m.message); break;
      case 'fail': this._fail(m.message); break;
      case 'ended': this._stoppedInBrowser(); break;
      case 'stats': this._stats(m); break;
    }
  };

  // Tells tvpipe what is being captured (once).
  Capture.prototype._sendCapture = function (size) {
    if (this.captureSent || this.stopped || !this.captureInfo) return;
    var c = this.captureInfo;
    if (size) {
      c.width = size.width;
      c.height = size.height;
    }
    if (!c.width || !c.height) return;
    this.captureSent = true;
    this._send(c);
    this._emit('capture', {
      settings: { width: c.width, height: c.height, frameRate: c.fps, displaySurface: c.surface },
      audio: c.audio, mode: this.mode
    });
  };

  Capture.prototype._start = function (plan) {
    if (!this.stream) { this._fail('plan before a capture'); return; }
    var c = this.captureInfo;
    this._toEngine({
      type: 'start', plan: plan, capture: { width: c.width, height: c.height },
      profiles: this.opts.profiles,
      media: this.worker && this.mediaKey ? { url: this.url, key: this.mediaKey } : null
    });
    var self = this;
    this._startAudio(plan).catch(function (e) {
      self._log('warn', 'no audio: ' + (e && e.message || e));
    });
  };

  Capture.prototype._startAudio = function (plan) {
    var track = this.stream.getAudioTracks()[0];
    if (!track || !plan.audio) return Promise.resolve();
    if (typeof global.AudioWorkletNode !== 'function') return Promise.reject(new Error('no AudioWorklet'));
    if (!this.audioCtx) this._prepareAudio();
    if (!this.audioCtx) return Promise.reject(new Error('no AudioContext'));
    var self = this, rate = plan.audio.sampleRate, ch = plan.audio.channels;
    var url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
    var connect = function () {
      var ctx = self.audioCtx;
      var src = ctx.createMediaStreamSource(new MediaStream([track]));
      var node = new AudioWorkletNode(ctx, 'tvpipe-pcm', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
        processorOptions: { rate: rate, channels: ch, chunk: Math.round(rate / 100) }
      });
      var stamp = L.audioClock(rate);
      node.port.onmessage = function (e) {
        // Nothing before the first keyframe went out (tvpipe's timeline
        // starts there).
        if (self.stopped || self.ws.readyState !== 1 || !self.sentKey) return;
        var pcm = new Uint8Array(e.data);
        var pts = stamp(pcm.length / (2 * ch), L.clock());
        // The loudest sample since the last stats (silent system audio is
        // how a missing permission shows on macOS).
        var smp = new Int16Array(e.data), peak = self.audioPeak;
        for (var i = 0; i < smp.length; i++) {
          var a = smp[i] < 0 ? -smp[i] : smp[i];
          if (a > peak) peak = a;
        }
        self.audioPeak = peak;
        if (self.ws.bufferedAmount > MAX_BUFFERED) { self.audioDropped++; return; }
        self.ws.send(L.record(L.KIND_AUDIO, pts, [pcm]));
        self.audioBytes += pcm.length;
      };
      src.connect(node);
      // Firefox captures what this page plays (audioCapture) and would
      // feed the node its own output: a cycle, which its graph silences.
      // Its nodes run unconnected; a stream destination keeps it pulled.
      node.connect(family() === 'firefox' ? ctx.createMediaStreamDestination() : ctx.destination);
      self.audioNode = node;
      self.audioSrc = src;
      if (ctx.state !== 'running') ctx.resume().catch(function () {});
      self._log('info', 'audio: ' + ctx.sampleRate + ' Hz context, sent as ' + rate + ' Hz ' + ch + ' ch');
    };
    // A page with an opaque origin (file://) cannot load a blob: module;
    // a data: URL works there.
    var load = function () {
      var w = self.audioCtx.audioWorklet;
      return w.addModule(url).catch(function () {
        return w.addModule('data:text/javascript;base64,' + btoa(WORKLET));
      });
    };
    return load().then(function () {
      try {
        connect();
      } catch (e) {
        // Some browsers refuse a MediaStream source at a rate other than
        // the track's: use the default rate; the worklet resamples.
        self.audioCtx.close().catch(function () {});
        self.audioCtx = new (global.AudioContext || global.webkitAudioContext)();
        return load().then(connect);
      }
    }).then(function () { URL.revokeObjectURL(url); });
  };

  // The engine's video stats plus the page's audio, to tvpipe and the UI.
  Capture.prototype._stats = function (v) {
    var secs = (L.clock() - this.audioSince) / 1e6;
    v.audioKbps = secs > 0 ? Math.round(this.audioBytes * 8 / secs / 1000) : 0;
    v.audioDropped = this.audioDropped;
    v.audioPeak = Math.round((this.audioPeak || 0) / 32.767) / 1000;
    v.mode = this.mode;
    this.audioPeak = 0;
    this.audioBytes = 0;
    this.audioDropped = 0;
    this.audioSince = L.clock();
    this._send(v);
    this._emit('stats', v);
  };

  // Ends the share: tells tvpipe, stops the capture.
  // The user stopped the capture in the browser (its "Stop sharing" bar,
  // or the captured window closed).
  Capture.prototype._stoppedInBrowser = function () {
    if (!this.stopped) this.stoppedInBrowser = true;
    this.stop('the share was stopped in the browser');
  };

  Capture.prototype.stop = function (reason) {
    if (this.stopped) return;
    this._send({ type: 'ended', reason: reason || 'the page stopped sharing' });
    this._teardown();
    var ws = this.ws;
    setTimeout(function () { try { ws.close(1000, 'ended'); } catch (e) { /* closed */ } }, 100);
    this._emit('end', reason || 'stopped');
  };

  Capture.prototype._teardown = function () {
    if (this.stopped) return;
    this.stopped = true;
    this.timers.forEach(function (cancel) { cancel(); });
    this.timers = [];
    this._toEngine({ type: 'stop' });
    var w = this.worker;
    if (w) setTimeout(function () { w.terminate(); }, 200);
    if (this.reader) this.reader.cancel().catch(function () {});
    if (this.stream) {
      // A track moved to the worker is stopped there; its husk here may
      // throw.
      this.stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) { /* moved */ } });
    }
    if (this.audioNode) { this.audioNode.port.postMessage('stop'); this.audioNode.disconnect(); }
    if (this.audioSrc) this.audioSrc.disconnect();
    if (this.audioCtx) this.audioCtx.close().catch(function () {});
    if (this.videoEl) this.videoEl.remove();
  };

  global.tvpipeCapture = {
    version: VERSION,
    features: features,
    place: L.place,
    pacer: L.pacer,
    captureClock: L.captureClock,
    audioClock: L.audioClock,
    connect: function (url, opts) { return new Capture(url, opts); }
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
