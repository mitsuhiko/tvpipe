// @ts-check
/**
 * Classes' sounds on the TV, all made in WebAudio (no files): the
 * classroom. The electric school bell, chalk on the blackboard, the wall
 * clock's tick, the teacher's red pen scratching, a gold star's pling, a
 * rubber stamp on the report card. One master gain and a compressor, so
 * overlapping sounds never clip. `mute=1` in the link (the host page's
 * preview) is silent.
 */

const MUTED = new URLSearchParams(location.hash.slice(1)).get("mute") === "1" || new URLSearchParams(location.search).get("mute") === "1";

/** @type {AudioContext | null} */
let audio = null;
/** @type {GainNode | null} */
let master = null;

function ac() {
  if (MUTED) return null;
  try {
    if (!audio) {
      const a = new AudioContext();
      const comp = a.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.knee.value = 10;
      comp.ratio.value = 4;
      comp.attack.value = 0.003;
      comp.release.value = 0.2;
      const out = a.createGain();
      out.gain.value = 0.8;
      out.connect(comp).connect(a.destination);
      audio = a;
      master = out;
    }
    if (audio.state === "suspended") void audio.resume();
    return audio;
  } catch {
    return null;
  }
}
// A watch page opened by hand gets its sound with the first tap.
addEventListener("pointerdown", () => void ac(), { once: true });

/**
 * A tone gliding from one pitch to another, with a quick attack and an exponential decay.
 * @param {number} from @param {number} to @param {number} len
 * @param {{ type?: OscillatorType, vol?: number, delay?: number, attack?: number }} [o]
 */
function tone(from, to, len, o = {}) {
  const a = ac();
  if (!a || !master) return;
  const at = a.currentTime + 0.02 + (o.delay ?? 0);
  const osc = a.createOscillator();
  const g = a.createGain();
  osc.type = o.type ?? "sine";
  osc.frequency.setValueAtTime(from, at);
  osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), at + len);
  const vol = o.vol ?? 0.15;
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(vol, at + (o.attack ?? 0.008));
  g.gain.exponentialRampToValueAtTime(0.0001, at + len);
  osc.connect(g).connect(master);
  osc.start(at);
  osc.stop(at + len + 0.05);
}

/**
 * A burst of filtered noise; `sweep` glides the filter to another frequency.
 * @param {number} freq @param {number} len @param {number} vol
 * @param {{ delay?: number, type?: BiquadFilterType, q?: number, decay?: number, sweep?: number, rough?: number }} [o]
 */
function noise(freq, len, vol, o = {}) {
  const a = ac();
  if (!a || !master) return;
  const at = a.currentTime + 0.02 + (o.delay ?? 0);
  const buf = a.createBuffer(1, Math.ceil(a.sampleRate * len), a.sampleRate);
  const d = buf.getChannelData(0);
  const decay = o.decay ?? 3;
  const rough = o.rough ?? 0;
  for (let i = 0; i < d.length; i++) {
    // `rough`: the amplitude jumps about (a pen catching on the paper, chalk grains).
    const grain = rough > 0 ? 1 - rough + rough * Math.abs(Math.sin(i * 0.0021) * Math.sin(i * 0.0137)) * 1.6 : 1;
    d[i] = (Math.random() * 2 - 1) * (1 - i / d.length) ** decay * grain;
  }
  const src = a.createBufferSource();
  src.buffer = buf;
  const f = a.createBiquadFilter();
  f.type = o.type ?? "bandpass";
  f.frequency.setValueAtTime(freq, at);
  if (o.sweep) f.frequency.exponentialRampToValueAtTime(o.sweep, at + len);
  f.Q.value = o.q ?? 2;
  const g = a.createGain();
  g.gain.value = vol;
  src.connect(f).connect(g).connect(master);
  src.start(at);
}

export const sound = {
  /**
   * The school bell: an electric bell's hammer (about 24 strikes a second)
   * on a brass gong, its inharmonic partials, for `len` seconds.
   * @param {number} [len] @param {number} [delay]
   */
  bell(len = 2, delay = 0) {
    const a = ac();
    if (!a || !master) return;
    const at = a.currentTime + 0.02 + Math.max(0, delay);
    const out = a.createGain();
    out.gain.setValueAtTime(0.0001, at);
    out.gain.exponentialRampToValueAtTime(0.22, at + 0.03);
    out.gain.setValueAtTime(0.22, at + len);
    out.gain.exponentialRampToValueAtTime(0.0001, at + len + 0.6);
    // The hammer: the gong's loudness pulses with it.
    const am = a.createGain();
    am.gain.value = 0.55;
    const lfo = a.createOscillator();
    lfo.type = "square";
    lfo.frequency.value = 24;
    const depth = a.createGain();
    depth.gain.value = 0.45;
    lfo.connect(depth).connect(am.gain);
    am.connect(out).connect(master);
    for (const [f, v] of /** @type {[number, number][]} */ ([[1046, 0.5], [1062, 0.3], [2890, 0.22], [5630, 0.1], [8120, 0.04]])) {
      const osc = a.createOscillator();
      osc.type = "sine";
      osc.frequency.value = f;
      const g = a.createGain();
      g.gain.value = v;
      osc.connect(g).connect(am);
      osc.start(at);
      osc.stop(at + len + 0.7);
    }
    lfo.start(at);
    lfo.stop(at + len + 0.7);
    // The clatter of the hammer itself.
    for (let t = 0; t < len; t += 1 / 24) noise(3800, 0.012, 0.05, { delay: delay + t, q: 3 });
  },
  /**
   * Chalk on the board: `n` strokes, each a tap and a short gritty drag.
   * @param {number} [n] @param {number} [delay]
   */
  chalk(n = 3, delay = 0) {
    for (let i = 0; i < n; i++) {
      const d = delay + i * (0.09 + Math.random() * 0.05);
      noise(260, 0.03, 0.5, { delay: d, type: "lowpass", q: 0.8, decay: 4 });
      noise(2600 + Math.random() * 1200, 0.06 + Math.random() * 0.06, 0.32, { delay: d + 0.01, q: 1.4, decay: 1.6, rough: 0.6, sweep: 3600 + Math.random() * 1500 });
    }
  },
  /** The big letter chalked on the board: a firm tap, then a long stroke. */
  chalkLetter() {
    noise(220, 0.05, 0.8, { type: "lowpass", q: 0.8, decay: 4 });
    noise(2300, 0.32, 0.4, { delay: 0.03, q: 1.2, decay: 1.2, rough: 0.7, sweep: 3800 });
    noise(2800, 0.24, 0.32, { delay: 0.4, q: 1.2, decay: 1.4, rough: 0.7, sweep: 2200 });
    noise(240, 0.04, 0.5, { delay: 0.66, type: "lowpass", q: 0.8, decay: 4 });
  },
  /** The wall clock in the last seconds: tick and tock. @param {boolean} [tock] */
  tick(tock = false) {
    noise(tock ? 2400 : 3400, 0.018, 0.5, { q: 5 });
    tone(tock ? 900 : 1200, tock ? 880 : 1180, 0.03, { type: "triangle", vol: 0.06 });
  },
  /** The red pen: one quick scratch (a cross, a tick or a circle). @param {number} [delay] */
  scratch(delay = 0) {
    noise(1700, 0.16, 0.28, { delay, q: 1.1, decay: 0.8, rough: 0.8, sweep: 2900 });
    noise(2500, 0.12, 0.2, { delay: delay + 0.17, q: 1.1, decay: 1, rough: 0.8, sweep: 1600 });
  },
  /** A gold star sticks: a bright pling. @param {number} [delay] */
  pling(delay = 0) {
    tone(1568, 1568, 0.7, { type: "sine", vol: 0.12, delay });
    tone(2349, 2349, 0.5, { type: "sine", vol: 0.06, delay: delay + 0.01 });
    tone(3136, 3136, 0.3, { type: "triangle", vol: 0.025, delay: delay + 0.05 });
  },
  /** A rubber stamp on the report card. @param {number} [delay] */
  stamp(delay = 0) {
    noise(170, 0.2, 0.9, { delay, type: "lowpass", q: 0.8, decay: 4 });
    tone(110, 55, 0.18, { type: "sine", vol: 0.35, delay });
    noise(1500, 0.04, 0.2, { delay, q: 1 });
  },
  /** A page turned: the exercise book opens, a report card is laid down. */
  page() {
    noise(2200, 0.28, 0.16, { q: 0.6, decay: 1.2 });
    noise(1300, 0.2, 0.1, { delay: 0.12, q: 0.6, decay: 1.5 });
  },
  /** The running light on the frieze: a soft tick per letter. */
  blip() {
    tone(1400, 1400, 0.025, { type: "triangle", vol: 0.018 });
  },
  /** A pin in the cork board. @param {number} [delay] */
  pin(delay = 0) {
    noise(900, 0.04, 0.35, { delay, q: 1.5, decay: 3 });
    tone(420, 300, 0.06, { type: "triangle", vol: 0.05, delay });
  },
};
