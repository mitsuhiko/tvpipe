// @ts-check
/**
 * Snug's sounds on the TV, all synthesized (no files): a soft pop for a
 * placement, a squeak for a lift, a chime for a ping, a rising pair or
 * an "uh-oh" for a check's answer, a ticking clock,
 * a sparkle and a fanfare for a solved board, a slide whistle at time's
 * up, a bubbly jingle when someone joins. One master gain and a
 * compressor, so overlapping sounds never clip. `?mute=1` (the host
 * page's preview) is silent.
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
      comp.threshold.value = -16;
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
 * A tone gliding from one pitch to another.
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

/** A click of noise. @param {number} freq @param {number} len @param {number} vol @param {number} [delay] */
function click(freq, len, vol, delay = 0) {
  const a = ac();
  if (!a || !master) return;
  const at = a.currentTime + 0.02 + delay;
  const buf = a.createBuffer(1, Math.ceil(a.sampleRate * len), a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length) ** 3;
  const src = a.createBufferSource();
  src.buffer = buf;
  const f = a.createBiquadFilter();
  f.type = "bandpass";
  f.frequency.value = freq;
  f.Q.value = 3;
  const g = a.createGain();
  g.gain.value = vol;
  src.connect(f).connect(g).connect(master);
  src.start(at);
}

export const sfx = {
  /** A piece lands: a soft, rounded pop. */
  pop() {
    tone(520 + Math.random() * 120, 180, 0.13, { vol: 0.22 });
    click(1800, 0.03, 0.15);
  },
  /** A piece lifted: a rising squeak. */
  squeak() {
    tone(500, 1100, 0.12, { type: "triangle", vol: 0.1 });
  },
  /** A ping: a little bell. */
  chime() {
    tone(1568, 1560, 0.5, { vol: 0.07 });
    tone(2349, 2340, 0.35, { vol: 0.04, delay: 0.01 });
  },
  /** A check says it can still work out: a rising pair. */
  yes() {
    tone(784, 784, 0.16, { type: "triangle", vol: 0.1 });
    tone(1175, 1175, 0.28, { type: "triangle", vol: 0.1, delay: 0.12 });
  },
  /** A check says it is stuck: a falling "uh-oh". */
  uhoh() {
    tone(620, 600, 0.18, { type: "triangle", vol: 0.12 });
    tone(440, 400, 0.32, { type: "triangle", vol: 0.12, delay: 0.17 });
  },
  /** The clock under 10 s. @param {boolean} high */
  tick(high) {
    click(high ? 3200 : 2400, 0.025, 0.35);
  },
  /** A board solved: a sparkle and a fanfare. */
  solved() {
    [1047, 1319, 1568, 2093, 2637].forEach((p, i) => tone(p, p, 0.25, { vol: 0.07, delay: i * 0.06 }));
    [523, 659, 784].forEach((p, i) => tone(p, p * 1.003, 0.9, { type: "triangle", vol: 0.1, delay: 0.35 + i * 0.02, attack: 0.02 }));
    tone(1047, 1047, 1.1, { type: "triangle", vol: 0.08, delay: 0.55, attack: 0.02 });
  },
  /** Time's up: a slide whistle down. */
  timesUp() {
    tone(1400, 260, 1.1, { vol: 0.13, attack: 0.05 });
    tone(330, 220, 0.5, { type: "triangle", vol: 0.12, delay: 1.1 });
  },
  /** Someone joined: a bubbly pair. */
  join() {
    tone(660, 990, 0.12, { vol: 0.1 });
    tone(990, 1320, 0.14, { vol: 0.08, delay: 0.09 });
  },
  /** A new board: a soft whoosh up. */
  whoosh() {
    tone(220, 880, 0.35, { type: "triangle", vol: 0.07, attack: 0.08 });
  },
  /** The end: a little tune. */
  tune() {
    [784, 988, 1175, 1568].forEach((p, i) => tone(p, p, 0.3, { type: "triangle", vol: 0.09, delay: i * 0.13 }));
  },
};
