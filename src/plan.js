// @ts-check
/**
 * Turns a raw take (video + transcript + audio levels + screen-motion log)
 * into an edit decision list: what to cut, what to silence, what to
 * fast-forward, where the virtual camera points, what to blur, where
 * chapters start, and the captions.
 *
 * The timing problem at the heart of it: browser speech recognition tells us
 * *what* was said but only roughly *when* (phrases arrive ~0.5–1.5s late, with
 * no word times). So every phrase is re-measured against the microphone:
 *
 *   1. a voice-activity mask (hysteresis on the loudness, short gaps between
 *      words bridged) finds where speech really starts and stops;
 *   2. each word is placed inside its phrase by spreading the phrase's
 *      syllables over its voiced frames (a light forced alignment);
 *   3. cuts, silenced commands and captions are all cut from those times.
 *
 * Nothing here touches pixels; the renderer reads the plan. The plan is
 * rebuilt from scratch whenever a setting or a command toggle changes, so
 * every edit is non-destructive.
 */
import { parseCommands, LABELLED } from './commands.js';
import { focusAt, secretAt, goneAt, activity } from './motion.js';

/** @typedef {import('./commands.js').Phrase} Phrase */
/** @typedef {import('./commands.js').Command} Command */
/** @typedef {import('./motion.js').MotionSample} MotionSample */
/** @typedef {import('./motion.js').Box} Box */
/** @typedef {'small'|'big'|'hidden'|'swap'} CamMode */
/** @typedef {{src0: number, src1: number, title: string | null, full: boolean, items: {src: number, text: string, by: string}[], by: string}} Board  A slide (full) or a list of points over the screen. */
/** @typedef {{dt: number, values: ArrayLike<number>}} Levels */

/**
 * @typedef {Object} Take
 * @property {number} duration
 * @property {Phrase[]} phrases
 * @property {Levels} levels   Mic loudness (0..1) every dt seconds.
 * @property {MotionSample[]} motion
 * @property {CamMode} [cameraStart]  How the camera bubble starts (default 'small').
 * @property {number[]} [joins]       Where the recording was paused and resumed.
 * @property {{t: number, x: number, y: number}[]} [camPath]  Where the floating bubble was during recording.
 */

/**
 * @typedef {Object} Options
 * @property {boolean} trimDeadAir
 * @property {number} deadAirMin     Silences at least this long (s) are shortened...
 * @property {number} deadAirKeep    ...to this long.
 * @property {number} speed          Default fast-forward factor.
 * @property {number} zoom           Default zoom factor.
 * @property {number} levelThreshold Loudness below this is silence.
 * @property {string[]} disabled     Command ids the user switched off.
 * @property {'smart'|'cut'|'mute'} commandStyle  How spoken commands leave the final video.
 * @property {boolean} showDirections Demo mode: keep spoken commands in, label them, play would-be cuts fast.
 * @property {number} ghostRate       Speed of would-be-cut silence in demo mode.
 * @property {number} fumbleRate      Speed of would-be-cut speech in demo mode (kept audible).
 * @property {CamMode} [cameraStart]
 */

/** @type {Options} */
export const DEFAULTS = {
  trimDeadAir: true,
  deadAirMin: 1.6,
  deadAirKeep: 0.6,
  speed: 4,
  zoom: 2,
  levelThreshold: 0.04,
  disabled: [],
  commandStyle: 'smart',
  showDirections: false,
  ghostRate: 3,
  fumbleRate: 1,
};

/** How long "hide that" blurs when nothing else says when to stop. */
export const HIDE_DEFAULT = 6;
/** Playback faster than this is silent (fast-forward); slower keeps the voice. */
export const AUDIBLE_RATE = 1.3;
/** Output seconds a zoom takes to glide. */
export const ZOOM_GLIDE = 0.9;
/** Output seconds the camera bubble takes to change size. */
export const CAM_GLIDE = 0.7;

/**
 * @typedef {{src0: number, src1: number, rate: number, out0: number, out1: number, ghost?: 'fumble'|'dead-air'|'cut', ramp?: boolean}} Segment
 * @typedef {{src0: number, src1: number, reason: 'fumble'|'command'|'dead-air'|'cut'|'stop', by?: string}} Cut
 * @typedef {{src0: number, src1: number, rate: number, by: string}} Speed
 * @typedef {{src: number, scale: number, x: number, y: number, by?: string}} View
 * @typedef {{src0: number, src1: number, scale: number, by: string}} Zoom
 * @typedef {{src0: number, src1: number, box: Box, by: string, full?: boolean}} Blur
 * @typedef {{src0: number, src1: number, x: number, y: number, by: string}} Spot
 * @typedef {{src: number, out: number, title: string, by: string}} Chapter
 * @typedef {{out0: number, out1: number, text: string, words?: {text: string, out0: number}[]}} Caption
 * @typedef {{text: string, start: number, end: number}} Word
 * @typedef {{
 *   duration: number, outDuration: number, finalDuration: number,
 *   segments: Segment[], cuts: Cut[], mutes: {src0: number, src1: number}[], speeds: Speed[],
 *   view: View[], zooms: Zoom[], blurs: Blur[], spots: Spot[],
 *   chapters: Chapter[], title: string | null, marks: {src: number, out: number, by: string}[],
 *   camera: {src: number, mode: CamMode, by?: string}[], camPath: {t: number, x: number, y: number}[],
 *   joins: number[], directions: {src0: number, src1: number, heard: string, did: string, type: string}[],
 *   showDirections: boolean, levels: Levels, levelThreshold: number,
 *   phrases: Phrase[], words: Word[][], captions: Caption[], commands: (Command & {effect: string})[],
 *   stats: {removed: number, fumbles: number, deadAir: number, hidden: number, zooms: number, chapters: number, sped: number, muted: number}
 * }} Plan
 */

const EPS = 1e-6;

// ---------------------------------------------------------------- voice activity

/** @type {WeakMap<object, Map<number, Uint8Array>>} */
const maskCache = new WeakMap();

/**
 * Where the voice is, frame by frame. Hysteresis (a word starts above the
 * threshold and continues down to half of it, so soft consonants at the edges
 * count), then gaps shorter than 160ms are bridged (the breath between words)
 * and blips shorter than 60ms dropped (a click, a tap on the desk).
 * @param {Levels} levels @param {number} threshold
 */
export function voiceMask(levels, threshold) {
  let byThr = maskCache.get(levels);
  if (!byThr) maskCache.set(levels, (byThr = new Map()));
  const hit = byThr.get(threshold);
  if (hit) return hit;
  const v = levels.values, n = v.length, dt = levels.dt;
  const m = new Uint8Array(n);
  const lo = threshold * 0.5;
  // Forward and backward passes so the soft edges on both sides of a loud core count.
  for (let i = 0, on = false; i < n; i++) {
    on = v[i] >= threshold || (on && v[i] >= lo);
    if (on) m[i] = 1;
  }
  for (let i = n - 1, on = false; i >= 0; i--) {
    on = v[i] >= threshold || (on && v[i] >= lo);
    if (on) m[i] = 1;
  }
  const bridge = Math.round(0.16 / dt), blip = Math.max(1, Math.round(0.06 / dt));
  for (let i = 0; i < n; ) {
    if (m[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && !m[j]) j++;
    if (i > 0 && j < n && j - i <= bridge) m.fill(1, i, j);
    i = j;
  }
  for (let i = 0; i < n; ) {
    if (!m[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && m[j]) j++;
    if (j - i < blip) m.fill(0, i, j);
    i = j;
  }
  byThr.set(threshold, m);
  return m;
}

/** @param {Uint8Array} mask @param {number} dt @param {number} t */
const voiced = (mask, dt, t) => {
  const i = Math.floor(t / dt);
  return i >= 0 && i < mask.length && mask[i] === 1;
};

/**
 * Speech recognition reports a phrase late: its first words ~0.5–1s after they
 * were spoken, its end up to a second or two after. Re-measure each phrase
 * from the microphone: start where the voice actually started, end where it
 * actually stopped. Captions, cuts and silenced commands all depend on this.
 * @param {Take} take @param {number} threshold
 * @returns {Phrase[]}
 */
export function refinePhrases(take, threshold) {
  const lv = take.levels;
  if (!lv.values.length) return take.phrases.map((p) => ({ ...p }));
  const dt = lv.dt;
  const mask = voiceMask(lv, threshold);
  const at = (/** @type {number} */ t) => voiced(mask, dt, t);
  /** @type {Phrase[]} */
  const out = [];
  take.phrases.forEach((p, i) => {
    const floor = i > 0 ? out[i - 1].end + 0.02 : 0;
    let start = Math.max(p.start, floor), end = p.end;
    // End, first guess: walk back from the reported end to the last voiced moment.
    for (let t = p.end; t >= Math.max(start, p.end - 2.5); t -= dt) {
      if (at(t)) {
        end = Math.floor(t / dt) * dt + dt + 0.06;
        break;
      }
    }
    // Start: the reported start is often in the gap after the first word, or
    // after the whole (short) phrase. Look back a little first, then forward.
    if (!at(start)) {
      let found = -1;
      for (let t = start; t >= Math.max(floor, start - 0.7); t -= dt) if (at(t)) {
        found = t;
        break;
      }
      if (found < 0) for (let t = start; t < end; t += dt) if (at(t)) {
        found = t;
        break;
      }
      if (found >= 0) start = found;
    }
    // ...then walk back to where that stretch of voice began.
    for (let t = start; t >= Math.max(floor, start - 2); t -= dt) {
      if (!at(t)) break;
      start = Math.floor(t / dt) * dt;
    }
    start = Math.max(floor, start - 0.04);
    // End, properly: the recogniser finalises a phrase 1–2s late, often after
    // you've started the next sentence, so the walk-back above can land in
    // the next sentence. Instead walk *forward* from the start through the
    // voice, and stop at the pause where this phrase's words have been said:
    // once about as much voice as its syllables need has passed, and the
    // voice that follows is when the recogniser heard the next phrase begin.
    const next = take.phrases[i + 1];
    const nextFrom = next ? next.start - 0.9 : Infinity;
    const syl = sentenceSyllables(p.text);
    const need = 0.8 * Math.max(0.3, syl / 5.5);
    // Even slow speech says this many syllables within maxDur: voice that
    // resumes after that belongs to the next phrase, however late the
    // recogniser reported it.
    const maxDur = syl / 2.6 + 0.5;
    let voicedFor = 0;
    for (let t = start; t < Math.min(end, take.duration); ) {
      if (at(t)) {
        voicedFor += dt;
        t += dt;
        continue;
      }
      const gap = t;
      while (t < end && !at(t)) t += dt;
      if (t >= end) break; // the voice just stopped: the walk-back was right
      if (voicedFor >= need && (t >= nextFrom || t - start > maxDur)) {
        end = gap + 0.06;
        break;
      }
    }
    if (end <= start + 0.2) end = Math.max(p.end, start + 0.4);
    // A short phrase (a command) can't run on for seconds: cap it, ending at
    // the last pause inside the cap if there is one.
    if (syl <= 8 && end - start > maxDur * 1.25) {
      // The quietest moment before the cap (raw loudness: the voice mask
      // bridges short pauses), preferring the latest truly quiet one.
      const cap = start + maxDur * 1.25;
      const vals = lv.values;
      let best = -1, bestV = Infinity;
      for (let i = Math.floor(cap / dt); i * dt > start + 0.3; i--) {
        const x = vals[i] ?? 0;
        if (x < threshold * 0.5) {
          best = i;
          break;
        }
        if (x < bestV) (bestV = x), (best = i);
      }
      end = best >= 0 ? best * dt + 0.02 : cap;
    }
    out.push({ text: p.text, start, end: Math.min(take.duration, end) });
  });
  return out;
}

/**
 * Every phrase with its real timing: speech-recognised phrases refined from
 * the mic, and command-box phrases (typed, or dictated with Wispr Flow) placed
 * on the stretch of voice that ended just before the text arrived. The
 * recogniser's own (often wrong) version of a dictated command is dropped.
 * @param {Take} take @param {number} threshold
 * @returns {Phrase[]}
 */
export function phrasesOf(take, threshold) {
  const speech = take.phrases.filter((p) => !p.typed);
  const box = take.phrases.filter((p) => p.typed);
  if (!box.length) return refinePhrases(take, threshold);
  let refined = refinePhrases({ ...take, phrases: speech }, threshold);
  const lv = take.levels, dt = lv.dt;
  const mask = lv.values.length ? voiceMask(lv, threshold) : null;
  const on = (/** @type {number} */ t) => Boolean(mask && voiced(mask, dt, t));
  const timed = box.map((p) => {
    // Wispr types the words when you let go of its key: the voice ended up to
    // ~2.5s before. Voice still going when the text arrived, or begun only just
    // before, can't be what was dictated: you've moved on to your next sentence.
    let from = p.end + 0.05;
    for (let tries = 0; tries < 4; tries++) {
      let end = -1;
      for (let t = from; t >= Math.max(0, p.end - 3); t -= dt) if (on(t)) {
        end = t + dt;
        break;
      }
      if (end < 0) break;
      let start = end - dt;
      // Back through the words, across the short pauses inside a command, up to 4s.
      for (let t = start; t >= Math.max(0, end - 4); t -= dt) {
        if (on(t)) start = t;
        else {
          let gap = 0;
          while (gap < 0.3 && !on(t - gap) && t - gap > 0) gap += dt;
          if (gap >= 0.3) break;
        }
      }
      // Still talking when the text arrived, or only just started: that's your next sentence.
      if (end >= p.end - 0.02 || start > p.end - 0.35) {
        from = start - dt;
        continue;
      }
      return { ...p, start: Math.max(0, start - 0.04), end: Math.min(end + 0.04, p.end) };
    }
    return { ...p, start: Math.max(0, p.end - 0.3), end: p.end }; // typed by hand: no voice to find
  });
  const overlap = (/** @type {Phrase} */ a, /** @type {Phrase} */ b) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
  refined = refined.filter((sp) => !timed.some((tp) => overlap(sp, tp) > 0.6 * (sp.end - sp.start)));
  return [...refined, ...timed].sort((a, b) => a.start - b.start);
}

/** Syllables in a whole phrase. @param {string} text */
const sentenceSyllables = (text) => text.split(/\s+/).reduce((n, w) => n + syllables(w), 0);

/** Rough syllable count, the unit speech time is spread over. @param {string} w */
function syllables(w) {
  const s = w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  if (!s) return 0.2;
  if (/^\d+$/.test(s)) return s.length * 1.4;
  if (/[ऀ-ॿ]/u.test(s)) return Math.max(1, s.replace(/[ा-्ऀ-ः]/gu, '').length * 0.9);
  const groups = s.match(/[aeiouyàáâãäåèéêëìíîïòóôõöùúûüæœ]+/gu);
  const n = groups ? groups.length - (s.length > 3 && /[^aeiou]e$/.test(s) ? 1 : 0) : Math.ceil(s.length / 2);
  return Math.max(1, n);
}

/**
 * Place each word of a phrase in time: the phrase's syllables are spread over
 * the frames where the voice was actually on, so pauses between words fall
 * between words.
 * @param {string} text @param {number} start @param {number} end
 * @param {Levels} levels @param {number} threshold
 * @returns {Word[]}
 */
export function alignWords(text, start, end, levels, threshold) {
  const ws = text.normalize('NFC').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (!ws.length) return [];
  const weights = ws.map((w) => syllables(w) + 0.3);
  const total = weights.reduce((a, b) => a + b, 0);
  const dt = levels.dt;
  /** @type {number[]} */
  const frames = [];
  if (levels.values.length) {
    const mask = voiceMask(levels, threshold);
    for (let i = Math.max(0, Math.floor(start / dt)); i * dt < end && i < mask.length; i++) if (mask[i]) frames.push(i * dt);
  }
  /** @type {Word[]} */
  const out = [];
  let acc = 0;
  if (frames.length * dt < 0.3 * (end - start) || frames.length < ws.length) {
    // Not enough voice measured: spread evenly by syllables.
    for (let i = 0; i < ws.length; i++) {
      const a = start + ((end - start) * acc) / total;
      acc += weights[i];
      out.push({ text: ws[i], start: a, end: start + ((end - start) * acc) / total });
    }
    return out;
  }
  const V = frames.length;
  const timeAt = (/** @type {number} */ f) => frames[Math.min(V - 1, Math.max(0, Math.floor(f * V)))];
  // Pauses inside the phrase (gaps of 120ms+ between voiced frames), as
  // fractions of the voiced time. A word boundary near one snaps to it, since
  // people pause between words, not inside them.
  /** @type {number[]} */
  const gaps = [];
  for (let k = 1; k < V; k++) if (frames[k] - frames[k - 1] > 0.12) gaps.push(k / V);
  /** @type {number[]} */
  const bounds = [0];
  for (let i = 0; i < ws.length - 1; i++) {
    acc += weights[i];
    let f = acc / total;
    const reach = (0.6 * Math.min(weights[i], weights[i + 1])) / total;
    let best = -1;
    for (const g of gaps) if (Math.abs(g - f) <= reach && g > bounds[bounds.length - 1] && (best < 0 || Math.abs(g - f) < Math.abs(best - f))) best = g;
    if (best >= 0) f = best;
    bounds.push(Math.max(f, bounds[bounds.length - 1]));
  }
  bounds.push(1);
  for (let i = 0; i < ws.length; i++) {
    const a = timeAt(bounds[i]);
    const b = timeAt(bounds[i + 1] - 1e-9) + dt;
    out.push({ text: ws[i], start: a, end: Math.max(a + dt, b) });
  }
  return out;
}

/** @param {{src0: number, src1: number}[]} ranges */
function union(ranges) {
  const sorted = ranges.filter((r) => r.src1 - r.src0 > EPS).sort((a, b) => a.src0 - b.src0);
  /** @type {{src0: number, src1: number}[]} */
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.src0 <= last.src1 + EPS) last.src1 = Math.max(last.src1, r.src1);
    else out.push({ src0: r.src0, src1: r.src1 });
  }
  return out;
}

/**
 * Remove `holes` from `ranges`.
 * @template {{src0: number, src1: number}} T
 * @param {T[]} ranges @param {{src0: number, src1: number}[]} holes
 * @returns {T[]}
 */
function subtract(ranges, holes) {
  /** @type {T[]} */
  let out = ranges.map((r) => ({ ...r }));
  for (const h of holes) {
    /** @type {T[]} */
    const next = [];
    for (const r of out) {
      if (h.src1 <= r.src0 || h.src0 >= r.src1) next.push(r);
      else {
        if (h.src0 > r.src0) next.push({ ...r, src1: h.src0 });
        if (h.src1 < r.src1) next.push({ ...r, src0: h.src1 });
      }
    }
    out = next;
  }
  return out;
}

/**
 * Speed ramps: rather than jumping from 1× to 4×, ease through intermediate
 * rates over ~0.6s of output on each side. Every piece keeps a constant rate,
 * so source↔output time stays exact.
 * @template {{src0: number, src1: number, rate: number}} T
 * @param {T[]} rated
 * @returns {(T & {ramp?: boolean})[]}
 */
function withRamps(rated) {
  /** @type {(T & {ramp?: boolean})[]} */
  const out = [];
  for (const r of rated) {
    const steps = [0.22, 0.5, 0.78].map((f) => 1 + (r.rate - 1) * f);
    const len = steps.reduce((n, s) => n + 0.2 * s, 0);
    if (r.rate < 1.8 || r.src1 - r.src0 < len * 2 + 1) {
      out.push(r);
      continue;
    }
    let t = r.src0;
    for (const s of steps) {
      out.push({ ...r, src0: t, src1: t + 0.2 * s, rate: s, ramp: true });
      t += 0.2 * s;
    }
    const tail = r.src1 - len;
    out.push({ ...r, src0: t, src1: tail });
    t = tail;
    for (const s of [...steps].reverse()) {
      out.push({ ...r, src0: t, src1: t + 0.2 * s, rate: s, ramp: true });
      t += 0.2 * s;
    }
  }
  return out;
}

const REGIONS = {
  center: [0.5, 0.5], 'top-left': [0.25, 0.25], 'top-right': [0.75, 0.25], 'bottom-left': [0.25, 0.75], 'bottom-right': [0.75, 0.75],
  left: [0.25, 0.5], right: [0.75, 0.5], top: [0.5, 0.25], bottom: [0.5, 0.75],
};

/**
 * @param {Take} take
 * @param {Partial<Options>} [options]
 * @returns {Plan}
 */
export function buildPlan(take, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const D = take.duration;
  const clamp = (/** @type {number} */ t) => Math.max(0, Math.min(D, t));
  const disabled = new Set(o.disabled);
  const P = phrasesOf(take, o.levelThreshold);
  const W = P.map((p) => alignWords(p.text, p.start, p.end, take.levels, o.levelThreshold));
  const joins = take.joins || [];
  const hasLevels = take.levels.values.length > 0;
  const mask = hasLevels ? voiceMask(take.levels, o.levelThreshold) : new Uint8Array(0);
  const ldt = take.levels.dt;
  const quietAt = (/** @type {number} */ t) => hasLevels && !voiced(mask, ldt, t);
  /** The nearest pause to t, looking `back` (or forward), within `reach` seconds; else t. */
  const toGap = (/** @type {number} */ t, /** @type {boolean} */ back, reach = 0.35) => {
    if (!hasLevels) return t;
    for (let d = 0; d <= reach; d += ldt) {
      const x = back ? t - d : t + d;
      if (quietAt(x)) return back ? x + ldt : x;
    }
    return t;
  };
  /**
   * When the command's own words start and end. Inside a longer phrase the
   * aligned word times are snapped to the pause around the command, since
   * people nearly always pause, however briefly, before giving a direction.
   */
  const cmdTimes = (/** @type {Command} */ c) => {
    const w = W[c.phrase], p = P[c.phrase];
    if (c.standalone || !w.length) return { start: p.start, end: p.end };
    const a = w[Math.min(c.span[0], w.length - 1)], b = w[Math.min(c.span[1], w.length - 1)];
    // Best: the stretch of voice between two pauses that is about as long as
    // the command and closest to where alignment put it. Speaking rates vary
    // (a fumble is slow), so this beats spreading syllables evenly.
    const isl = islandFor(c, a.start, b.end);
    if (isl) return isl;
    const start = c.span[0] === 0 ? p.start : Math.max(p.start, toGap(a.start + 0.12, true));
    const end = c.span[1] >= w.length - 1 ? p.end : Math.min(p.end, toGap(b.end - 0.12, false));
    return { start, end: Math.max(end, start + 0.2) };
  };
  /** Stretches of voice (between pauses) inside [a, b]. @param {number} a @param {number} b */
  const islandsIn = (a, b) => {
    /** @type {{start: number, end: number}[]} */
    const out = [];
    if (!hasLevels) return out;
    let s0 = -1;
    for (let x = Math.max(0, a); x <= b + ldt; x += ldt) {
      const on = x <= b && !quietAt(x);
      if (on && s0 < 0) s0 = x;
      if (!on && s0 >= 0) out.push({ start: s0, end: x }), (s0 = -1);
    }
    return out;
  };
  /** @param {Command} c @param {number} alignedStart @param {number} alignedEnd */
  const islandFor = (c, alignedStart, alignedEnd) => {
    const p = P[c.phrase];
    const words = p.text.normalize('NFC').replace(/\s+/g, ' ').trim().split(' ').slice(c.span[0], c.span[1] + 1).join(' ');
    const expected = Math.max(0.3, sentenceSyllables(words) / 4.5);
    const isl = islandsIn(p.start - 0.1, p.end + 0.1);
    if (isl.length < 2) return null;
    const mid = (alignedStart + alignedEnd) / 2;
    let best = null, bestScore = Infinity;
    for (let i = 0; i < isl.length; i++) {
      for (let j = i; j < Math.min(isl.length, i + 2); j++) {
        const start = isl[i].start, end = isl[j].end, dur = end - start;
        if (dur < expected * 0.4 || dur > expected * 2.2 + 0.3) continue;
        // A command at the very start or end of the phrase sits in the first or last stretch.
        if (c.span[0] === 0 && i !== 0) continue;
        if (c.span[1] >= W[c.phrase].length - 1 && j !== isl.length - 1) continue;
        const score = Math.abs((start + end) / 2 - mid) + Math.abs(dur - expected) * 0.5;
        if (score < bestScore && Math.abs((start + end) / 2 - mid) < 1.6) (best = { start, end }), (bestScore = score);
      }
    }
    return best;
  };
  /**
   * Where the sentence you just fumbled began, inside a stretch of speech
   * [a, b]: the whole stretch if it's under 4s, otherwise from its last real
   * pause (half a second or more) that leaves at least 1.5s to cut. Speech
   * recognition often hands over several sentences as one phrase, and
   * "scratch that" means the last of them.
   */
  const lastStretch = (/** @type {number} */ a, /** @type {number} */ b) => {
    if (!hasLevels || b - a < 4) return a;
    for (let x = b - 1.5; x > a + 1; x -= ldt) {
      let q = 0;
      while (x - q * ldt > a && !voiced(mask, ldt, x - q * ldt) && take.levels.values[Math.floor((x - q * ldt) / ldt)] < o.levelThreshold * 0.6) q++;
      if (q * ldt >= 0.5) return x;
    }
    return a;
  };
  /** Is there a pause just before (or after) t? */
  const pauseNear = (/** @type {number} */ t, /** @type {'before'|'after'} */ side) => {
    if (!hasLevels) return true;
    const [a, b] = side === 'before' ? [t - 0.5, t + 0.12] : [t - 0.12, t + 0.5];
    for (let x = a; x <= b; x += ldt) if (quietAt(x)) return true;
    return false;
  };
  // A command that came in through the command box (Wispr Flow) wins over
  // the recogniser's version of the same words, said a moment before.
  const parsed = parseCommands(P);
  const fromBox = parsed.filter((c) => P[c.phrase].typed);
  const commands = parsed
    .filter((c) => P[c.phrase].typed || !fromBox.some((d) => d.type === c.type && Math.abs(P[d.phrase].start - P[c.phrase].start) < 3))
    .map((c) => {
    const cmd = { ...c, enabled: !disabled.has(c.id), effect: '' };
    // Switched on by hand in the editor: trust that over any guess below.
    const forced = disabled.has(`on:${c.id}`);
    // "pause"/"resume" only mean something where the recording really paused;
    // anywhere else it was just a word in a sentence.
    const p = P[c.phrase];
    if (!forced && c.type === 'pause' && !joins.some((j) => j >= p.start - 0.5 && j <= p.end + 3)) (cmd.enabled = false), (cmd.effect = 'The recording didn’t pause here');
    if (!forced && c.type === 'resume' && !joins.some((j) => j >= p.start - 4 && j <= p.start + 0.6)) (cmd.enabled = false), (cmd.effect = 'Nothing was paused here');
    // A camera command run into a sentence counts only if you paused around it.
    if (!forced && c.needsPause) {
      const w = W[c.phrase];
      const edgeT = w.length ? (c.needsPause === 'before' ? w[Math.min(c.span[0], w.length - 1)].start : w[Math.min(c.span[1], w.length - 1)].end) : p.start;
      if (!pauseNear(edgeT, c.needsPause)) (cmd.enabled = false), (cmd.effect = 'Sounded like part of a sentence, so it was left alone');
    }
    return cmd;
  });
  // Re-time the words around each command found inside a longer phrase: the
  // narration before it fits between the phrase start and the command, the
  // narration after it between the command and the phrase end. (Spreading the
  // whole phrase evenly would let a slow fumble push words across the command.)
  for (const c of commands) {
    if (c.standalone || !c.enabled || LABELLED.has(c.type)) continue;
    const w = W[c.phrase], p = P[c.phrase];
    if (!w.length) continue;
    const t = cmdTimes(c);
    const words = p.text.normalize('NFC').replace(/\s+/g, ' ').trim().split(' ');
    const a = c.span[0], b = Math.min(c.span[1], words.length - 1);
    W[c.phrase] = [
      ...alignWords(words.slice(0, a).join(' '), p.start, Math.max(p.start, t.start - 0.05), take.levels, o.levelThreshold),
      ...alignWords(words.slice(a, b + 1).join(' '), t.start, t.end, take.levels, o.levelThreshold),
      ...alignWords(words.slice(b + 1).join(' '), Math.min(p.end, t.end + 0.05), p.end, take.levels, o.levelThreshold),
    ];
  }
  const live = commands.filter((c) => c.enabled);
  const nextOf = (/** @type {Command} */ c, /** @type {string[]} */ types) =>
    live.find((d) => d.phrase > c.phrase && types.includes(d.type));
  const isCommandPhrase = (/** @type {number} */ i) => live.some((d) => d.phrase === i && d.standalone);
  /** Narration phrases before index i, newest first. */
  const narrationBefore = (/** @type {number} */ i) => {
    const list = [];
    for (let k = i - 1; k >= 0; k--) if (!isCommandPhrase(k)) list.push(k);
    return list;
  };

  /** @type {Cut[]} */
  const cuts = [];
  /** @type {{src0: number, src1: number, by: string, type: string, edge: boolean}[]} Spoken command ranges: cut or silenced in the final video. */
  const spoken = [];
  /** @type {Speed[]} */
  let speeds = [];
  /** @type {View[]} */
  const view = [{ src: 0, scale: 1, x: 0.5, y: 0.5 }];
  /** @type {Blur[]} */
  const blurs = [];
  /** @type {Spot[]} */
  const spots = [];
  /** @type {{src: number, title: string, by: string}[]} */
  const chapterSrc = [];
  /** @type {{src: number, by: string}[]} */
  const markSrc = [];
  let title = /** @type {string|null} */ (null);
  /** @type {Board[]} */
  const boards = [];
  /** End whatever slide or list of points is showing. @param {number} at @param {boolean} all */
  const closeBoards = (at, _all) => {
    for (const b of boards) if (b.src1 === Infinity) b.src1 = clamp(Math.max(b.src0 + 0.5, at));
  };
  /** @type {{src: number, mode: CamMode, by?: string}[]} */
  const camera = [{ src: 0, mode: o.cameraStart || take.cameraStart || 'small' }];

  for (const c of live) {
    const p = P[c.phrase], words = W[c.phrase];
    // Generous margins: silencing costs nothing (the picture carries on), and
    // speech recognition's timing is never exact.
    if (c.standalone) {
      spoken.push({ src0: clamp(p.start - 0.2), src1: clamp(p.end + 0.16), by: c.id, type: c.type, edge: true });
    } else if (words.length) {
      // Inside a longer phrase: silence just the command's words, wherever they are.
      const t = cmdTimes(c);
      const atStart = c.span[0] === 0, atEnd = c.span[1] >= words.length - 1;
      spoken.push({ src0: clamp((atStart ? p.start : t.start) - 0.14), src1: clamp((atEnd ? p.end : t.end) + 0.12), by: c.id, type: c.type, edge: atEnd && !atStart });
    }
  }

  for (const c of live) {
    const p = P[c.phrase];
    const t = cmdTimes(c);
    const after = clamp(t.end + 0.1);
    switch (c.type) {
      case 'cut': {
        // The fumble is in this breath if you said enough before "scratch that",
        // otherwise it's the sentence before.
        const prev = narrationBefore(c.phrase)[0];
        const sameBreath = c.before >= 3 || prev === undefined;
        const from = sameBreath ? lastStretch(p.start, t.start) : lastStretch(P[prev].start, P[prev].end);
        // Up to the end of "scratch that" itself: a retake said in the same breath stays.
        cuts.push({ src0: clamp(from - 0.06), src1: clamp(t.end + 0.04), reason: 'fumble', by: c.id });
        c.effect = `Removed ${(t.end - from).toFixed(1)}s`;
        break;
      }
      case 'cutSentences': {
        const list = narrationBefore(c.phrase);
        const n = Math.max(1, Math.min(list.length, Math.round(c.count || 1)));
        const from = list.length ? P[list[n - 1]].start : p.start;
        cuts.push({ src0: clamp(from - 0.06), src1: clamp(t.end + 0.04), reason: 'cut', by: c.id });
        c.effect = `Removed ${n} sentence${n > 1 ? 's' : ''} (${(t.end - from).toFixed(1)}s)`;
        break;
      }
      case 'cutSeconds': {
        const from = clamp(t.start - (c.seconds || 5));
        cuts.push({ src0: from, src1: clamp(t.end + 0.04), reason: 'cut', by: c.id });
        c.effect = `Removed ${(t.end - from).toFixed(1)}s`;
        break;
      }
      case 'cutFrom': {
        const to = nextOf(c, ['cutTo', 'stop']);
        const end = to ? clamp(cmdTimes(to).end + 0.1) : D;
        cuts.push({ src0: clamp(t.start - 0.06), src1: end, reason: 'cut', by: c.id });
        c.effect = to ? `Removed ${(end - t.start).toFixed(1)}s, up to “${to.heard}”` : 'Removed everything after this (no “cut till here” was heard)';
        break;
      }
      case 'cutTo':
        c.effect = live.some((d) => d.type === 'cutFrom' && d.phrase < c.phrase) ? 'End of the cut' : 'No “cut from here” before this';
        break;
      case 'stop':
        cuts.push({ src0: clamp(Math.min(p.start, t.start) - 0.25), src1: D, reason: 'stop', by: c.id });
        c.effect = 'The video ends here';
        break;
      case 'pause': {
        // Recording actually paused a moment after you said it: drop that moment too.
        const j = joins.find((x) => x >= p.start - 0.5);
        if (j !== undefined) cuts.push({ src0: clamp(Math.min(p.start, t.start) - 0.1), src1: clamp(Math.max(j, p.end)), reason: 'command', by: c.id });
        c.effect = 'Nothing was recorded until you resumed';
        break;
      }
      case 'resume':
        cuts.push({ src0: clamp(p.start - 0.1), src1: clamp(p.end + 0.06), reason: 'command', by: c.id });
        c.effect = 'Recording picked up again';
        break;
      case 'speedUp': {
        const stop = nextOf(c, ['normalSpeed', 'speedUp']);
        const nextTalk = P.findIndex((q, i) => i > c.phrase && !isCommandPhrase(i));
        const end = c.seconds ? after + c.seconds : stop ? cmdTimes(stop).start - 0.2 : Math.min(nextTalk >= 0 ? P[nextTalk].start - 0.25 : D, after + 90);
        const rate = c.rate || o.speed;
        if (end - after > 0.5) {
          speeds.push({ src0: after, src1: clamp(end), rate, by: c.id });
          c.effect = `${(clamp(end) - after).toFixed(0)}s at ${rate}×`;
        } else c.effect = 'Nothing to speed up';
        break;
      }
      case 'zoomIn': {
        const prev = view[view.length - 1];
        const scale = c.more ? Math.min(4, Math.max(prev.scale, 1) * 1.5) : prev.scale > 1 ? prev.scale : o.zoom;
        const target = c.region ? REGIONS[/** @type {keyof typeof REGIONS} */ (c.region)] ?? REGIONS.center : c.more ? [prev.x, prev.y] : REGIONS.center;
        const half = 0.5 / scale;
        const x = Math.min(1 - half, Math.max(half, target[0]));
        const y = Math.min(1 - half, Math.max(half, target[1]));
        // Start the glide as you say it, so it lands as you finish.
        const at = clamp(t.start + 0.05);
        view.push({ src: at, scale, x, y, by: c.id });
        if (c.seconds) view.push({ src: clamp(at + c.seconds), scale: 1, x: 0.5, y: 0.5 });
        c.effect = `${String(Math.round(scale * 10) / 10)}× on the ${c.region ? c.region.replace('-', ' ') : c.more ? 'same spot' : 'centre'}${c.seconds ? ` for ${c.seconds}s` : ''}`;
        break;
      }
      case 'zoomOut':
        view.push({ src: clamp(t.start + 0.05), scale: 1, x: 0.5, y: 0.5, by: c.id });
        c.effect = 'Back to the full screen';
        break;
      case 'highlight': {
        const f = focusAt(take.motion, p.end, 2.5);
        spots.push({ src0: clamp(t.start + 0.05), src1: clamp(after + (c.seconds || 2.8)), x: f ? f.x : 0.5, y: f ? f.y : 0.5, by: c.id });
        c.effect = f ? 'Spotlight on what just changed' : 'Spotlight on the centre';
        break;
      }
      case 'hide': {
        const secret = secretAt(take.motion, t.start + 0.4);
        if (secret) {
          // Ends, in order of preference: a time you gave, "show it" (said in
          // the next 30s, before any other "hide that"), the moment the
          // secret left the screen (within 30s), else 6 seconds after you asked.
          const nextHide = nextOf(c, ['hide']);
          const un = nextOf(c, ['unhide']);
          const unOk = un && P[un.phrase].start - t.end < 30 && (!nextHide || un.phrase < nextHide.phrase);
          const gone = goneAt(take.motion, secret.box, t.start + 0.4);
          let end = t.end + HIDE_DEFAULT, why = `for ${HIDE_DEFAULT}s (say “show it” to end it sooner, or “hide that for 20 seconds”)`;
          if (c.seconds) [end, why] = [t.end + c.seconds, `for ${c.seconds}s`];
          else if (unOk) [end, why] = [cmdTimes(un).start, `until you said “${un.heard}”`];
          else if (gone !== null && gone - t.end < 30) [end, why] = [Math.max(gone + 0.1, t.end + 1), 'until it left the screen'];
          blurs.push({ src0: secret.start, src1: clamp(end), box: secret.box, by: c.id });
          c.effect = `Blurred from ${fmt(secret.start)} ${why}`;
        } else c.effect = 'Nothing new appeared on screen to hide';
        break;
      }
      case 'unhide':
        c.effect = 'Ends the blur';
        break;
      case 'hideScreen': {
        const show = nextOf(c, ['showScreen']);
        const showOk = show && P[show.phrase].start - t.end < 180;
        const end = c.seconds ? t.end + c.seconds : showOk ? cmdTimes(show).start : t.end + 20;
        blurs.push({ src0: clamp(t.start - 0.1), src1: clamp(end), box: { x: 0, y: 0, w: 1, h: 1 }, full: true, by: c.id });
        c.effect = c.seconds ? `Whole screen hidden for ${c.seconds}s` : showOk ? `Whole screen hidden until “${show.heard}”` : 'Whole screen hidden for 20s (say “show the screen” to end it)';
        break;
      }
      case 'showScreen':
        c.effect = 'Ends the screen blur';
        break;
      case 'chapter':
        closeBoards(t.start, false);
        chapterSrc.push({ src: p.start, title: c.label || 'Chapter', by: c.id });
        c.effect = `Chapter “${c.label}”`;
        break;
      case 'title':
        title = c.label || null;
        c.effect = 'Opening title card';
        break;
      case 'mark':
        markSrc.push({ src: p.start, by: c.id });
        c.effect = 'Bookmark';
        break;
      case 'normalSpeed':
        c.effect = 'Ends the fast-forward';
        break;
      case 'camBig':
      case 'camSmall':
      case 'camShow':
      case 'camSwap':
      case 'camHide': {
        /** @type {CamMode} */
        const mode = c.type === 'camBig' ? 'big' : c.type === 'camHide' ? 'hidden' : c.type === 'camSwap' ? 'swap' : 'small';
        // Start the move while you're still saying it, so it's part of the shot.
        camera.push({ src: clamp(t.start + 0.05), mode, by: c.id });
        c.effect = { big: 'Your face fills the frame', hidden: 'Camera bubble hidden', swap: 'You in front, the screen in the bubble', small: 'Camera bubble back in place' }[mode];
        if (c.type === 'camSmall') closeBoards(t.start, true);
        break;
      }
      case 'slide': {
        closeBoards(t.start, false);
        boards.push({ src0: clamp(t.start + 0.05), src1: Infinity, title: c.label || '', full: true, items: [], by: c.id });
        c.effect = `A slide titled “${c.label}”`;
        break;
      }
      case 'point': {
        let b = boards.find((x) => x.src1 === Infinity);
        if (!b) {
          b = { src0: clamp(t.start + 0.05), src1: Infinity, title: null, full: false, items: [], by: c.id };
          boards.push(b);
        }
        b.items.push({ src: clamp(t.start + 0.2), text: c.label || '', by: c.id });
        c.effect = b.full ? `Bullet ${b.items.length} on the slide` : `Point ${b.items.length} on screen`;
        break;
      }
      case 'endSlide':
        c.effect = boards.some((x) => x.src1 === Infinity) ? 'Slide and points cleared' : 'No slide was showing';
        closeBoards(t.start, true);
        break;
    }
  }
  view.sort((a, b) => a.src - b.src);
  // A slide nobody closed stays up to the end; a list of points fades 12s after its last point.
  for (const b of boards) {
    if (b.src1 !== Infinity) continue;
    const last = b.items.length ? b.items[b.items.length - 1].src : b.src0;
    b.src1 = b.full ? D : clamp(last + 12);
  }

  // Narration is never fast-forwarded: if you talk during a speed-up, it
  // drops back to normal speed for what you say, then picks up again.
  /** @type {{src0: number, src1: number}[]} */
  const talk = [];
  P.forEach((p, i) => {
    if (!isCommandPhrase(i)) talk.push({ src0: p.start - 0.3, src1: p.end + 0.3 });
  });
  speeds = subtract(speeds, talk).filter((s) => s.src1 - s.src0 > 1);

  // Spoken commands. "Smart" silences them while the screen is moving (no jump
  // in the picture) and cuts them where the screen is still (no visible jump).
  /** @type {{src0: number, src1: number}[]} */
  const mutes = [];
  for (const s of spoken) {
    if (['cut', 'cutSentences', 'cutSeconds', 'stop', 'pause', 'resume', 'cutFrom'].includes(s.type)) continue; // already inside a cut
    const still = activity(take.motion, s.src0, s.src1) < 0.004;
    const style = o.commandStyle === 'smart' ? (still && s.edge !== false ? 'cut' : 'mute') : o.commandStyle;
    if (style === 'cut') cuts.push({ src0: s.src0, src1: s.src1, reason: 'command', by: s.by });
    else mutes.push({ src0: s.src0, src1: s.src1 });
  }

  // Dead air: long silences where nothing happens on screen. Anything speech
  // recognition heard is protected, even if the mic level was low.
  let deadAir = 0;
  if (o.trimDeadAir && take.levels.values.length) {
    const { dt, values } = take.levels;
    const mask = voiceMask(take.levels, o.levelThreshold);
    const heard = [...take.phrases, ...P].map((p) => ({ src0: p.start - 0.15, src1: p.end + 0.15 }));
    let runStart = -1;
    for (let i = 0; i <= values.length; i++) {
      const silent = i < values.length && !mask[i];
      if (silent && runStart < 0) runStart = i;
      if (!silent && runStart >= 0) {
        const s0 = runStart * dt, s1 = Math.min(i * dt, D);
        runStart = -1;
        for (const r of subtract([{ src0: s0, src1: s1 }], heard)) {
          if (r.src1 - r.src0 < o.deadAirMin || activity(take.motion, r.src0, r.src1) >= 0.004) continue;
          if (speeds.some((sp) => r.src0 < sp.src1 && r.src1 > sp.src0)) continue;
          // Keep a natural beat: a little more after you stop than before you start.
          const a = r.src0 + o.deadAirKeep * 0.55, b = r.src1 - o.deadAirKeep * 0.45;
          cuts.push({ src0: a, src1: b, reason: 'dead-air' });
          deadAir += b - a;
        }
      }
    }
  }

  const removed = union(cuts);
  /** @type {{src0: number, src1: number}[]} */
  const keep = [];
  let at = 0;
  for (const r of removed) {
    if (r.src0 > at + EPS) keep.push({ src0: at, src1: r.src0 });
    at = Math.max(at, r.src1);
  }
  if (D > at + EPS) keep.push({ src0: at, src1: D });

  /**
   * @param {{src0: number, src1: number}[]} ranges
   * @param {{src0: number, src1: number, rate: number, ghost?: Segment['ghost'], ramp?: boolean}[]} rated
   */
  const segmentsOf = (ranges, rated) => {
    /** @type {Segment[]} */
    const segs = [];
    let out = 0;
    for (const k of ranges) {
      const marks = [k.src0, k.src1];
      for (const s of rated) for (const t of [s.src0, s.src1]) if (t > k.src0 && t < k.src1) marks.push(t);
      marks.sort((a, b) => a - b);
      for (let i = 0; i < marks.length - 1; i++) {
        const a = marks[i], b = marks[i + 1];
        if (b - a < EPS) continue;
        const mid = (a + b) / 2;
        const sp = rated.find((s) => mid >= s.src0 && mid < s.src1);
        const rate = sp ? sp.rate : 1;
        /** @type {Segment} */
        const seg = { src0: a, src1: b, rate, out0: out, out1: out + (b - a) / rate };
        if (sp?.ghost) seg.ghost = sp.ghost;
        if (sp?.ramp) seg.ramp = true;
        segs.push(seg);
        out += (b - a) / rate;
      }
    }
    return { segs, out };
  };

  const finalCut = segmentsOf(keep, withRamps(speeds));
  let segments = finalCut.segs;
  let outDuration = finalCut.out;
  let finalMutes = mutes;

  if (o.showDirections) {
    // Demo mode: nothing is removed. Spoken commands stay audible; what the
    // final cut removes plays under a red overlay instead: silences fast,
    // fumbled speech just a little faster and still audible, so viewers hear
    // the mistake and the command that removed it.
    /** @type {{src0: number, src1: number, rate: number, ghost: NonNullable<Segment['ghost']>}[]} */
    const ghosts = [];
    for (const c of cuts) {
      if (c.reason === 'command') continue;
      // Keep the spoken command that asked for the cut at normal speed.
      const cmdSpoken = spoken.find((s) => s.by === c.by);
      const end = cmdSpoken && cmdSpoken.src0 > c.src0 ? cmdSpoken.src0 : c.src1;
      const kind = c.reason === 'dead-air' ? 'dead-air' : c.reason === 'fumble' ? 'fumble' : 'cut';
      if (end - c.src0 > 0.1) ghosts.push({ src0: c.src0, src1: end, rate: kind === 'dead-air' ? o.ghostRate : o.fumbleRate, ghost: kind });
    }
    // Overlapping ghosts: the speech-bearing kind wins, so no voice is skipped.
    ghosts.sort((a, b) => a.rate - b.rate);
    /** @type {typeof ghosts} */
    let merged = [];
    for (const g of ghosts) merged = [...merged, ...subtract([g], merged)];
    merged.sort((a, b) => a.src0 - b.src0);
    const sp = subtract(speeds, merged);
    const demo = segmentsOf([{ src0: 0, src1: D }], [...withRamps(sp), ...merged]);
    segments = demo.segs;
    outDuration = demo.out;
    finalMutes = [];
  }

  /** @param {number} t */
  const toOut = (t) => srcToOut(segments, t, outDuration);
  /** @param {number} t */
  const playing = (t) => {
    const s = segments.find((g) => t >= g.src0 && t < g.src1);
    return Boolean(s && s.rate <= AUDIBLE_RATE) && !finalMutes.some((m) => t >= m.src0 && t < m.src1);
  };

  // Captions, word by word: the narration that survived, timed from the
  // aligned words, broken at pauses and punctuation into short lines.
  /** @type {Caption[]} */
  const captions = [];
  P.forEach((p, i) => {
    if (isCommandPhrase(i)) return;
    const words = W[i];
    const drop = new Set();
    for (const c of commands) if (c.phrase === i && c.type !== 'chapter' && c.type !== 'title') for (let k = c.span[0]; k <= c.span[1]; k++) drop.add(k);
    if (live.some((c) => c.phrase === i && LABELLED.has(c.type))) return;
    /** @param {Word[]} line */
    const emit = (line) => {
      const out0 = toOut(line[0].start), out1 = toOut(line[line.length - 1].end);
      if (out1 - out0 > 0.12) captions.push({ out0, out1, text: line.map((w) => w.text).join(' '), words: line.map((w) => ({ text: w.text, out0: toOut(w.start) })) });
    };
    // A run is speech without a break (a pause, a full stop, a cut). Each run
    // is split into balanced lines, so a long sentence never leaves one word
    // stranded on a line of its own.
    /** @param {Word[]} run */
    const flushRun = (run) => {
      if (!run.length) return;
      const len = (/** @type {Word[]} */ ws) => ws.reduce((n, x) => n + x.text.length + 1, 0) - 1;
      const n = Math.max(Math.ceil(len(run) / 38), Math.ceil(run.length / 8));
      const target = len(run) / n;
      let line = /** @type {Word[]} */ ([]);
      for (let k = 0; k < run.length; k++) {
        line.push(run[k]);
        const left = run.length - k - 1;
        const here = len(line);
        const comma = /[,;:]$/.test(run[k].text) && here >= target * 0.6;
        if (left >= 2 && (here >= target - 2 || comma)) {
          emit(line);
          line = [];
        }
      }
      if (line.length) emit(line);
    };
    /** @type {Word[]} */
    let run = [];
    const cut = () => {
      flushRun(run);
      run = [];
    };
    words.forEach((w, k) => {
      const mid = (w.start + w.end) / 2;
      if (drop.has(k) || !playing(mid)) return cut();
      const prev = run[run.length - 1];
      if (prev && w.start - prev.end > 0.55) cut();
      run.push(w);
      if (/[.!?।]$/.test(w.text)) cut();
    });
    cut();
  });
  captions.sort((a, b) => a.out0 - b.out0);
  // Show each line a beat before the voice (as subtitles do), never over the previous one.
  for (let i = 0; i < captions.length; i++) {
    const prevEnd = i ? captions[i - 1].out1 : 0;
    captions[i].out0 = Math.max(prevEnd, captions[i].out0 - 0.15, 0);
  }
  // Hold each line a moment after the voice stops, never into the next one.
  for (let i = 0; i < captions.length; i++) {
    const next = captions[i + 1];
    const limit = next ? next.out0 - 0.04 : outDuration;
    captions[i].out1 = Math.max(captions[i].out1, Math.min(limit, Math.max(captions[i].out1 + 0.45, captions[i].out0 + 1.1)));
  }

  const chapters = chapterSrc.map((c) => ({ ...c, out: toOut(c.src) }));

  /** @type {Zoom[]} Zoom ranges, for the timeline. */
  const zooms = [];
  for (let i = 0; i < view.length; i++) {
    if (view[i].scale > 1) zooms.push({ src0: view[i].src, src1: view[i + 1]?.src ?? D, scale: view[i].scale, by: view[i].by || '' });
  }

  const directions = o.showDirections
    ? live.map((c) => {
        const t = cmdTimes(c);
        return { src0: t.start, src1: Math.min(D, t.end + 1.8), heard: c.heard, did: c.effect, type: c.type };
      })
    : [];

  return {
    duration: D,
    outDuration,
    finalDuration: finalCut.out,
    segments,
    cuts: removed.map((r) => {
      const inside = cuts.filter((c) => c.src0 >= r.src0 - EPS && c.src1 <= r.src1 + EPS);
      const why = inside.find((c) => c.reason === 'fumble' || c.reason === 'cut' || c.reason === 'stop') || inside.find((c) => c.reason === 'command') || { reason: /** @type {const} */ ('dead-air') };
      return { src0: r.src0, src1: r.src1, reason: why.reason, by: /** @type {any} */ (why).by };
    }),
    mutes: finalMutes,
    speeds,
    view,
    zooms,
    blurs,
    spots,
    chapters,
    title,
    boards,
    marks: markSrc.map((m) => ({ ...m, out: toOut(m.src) })),
    camera: camera.sort((a, b) => a.src - b.src),
    camPath: take.camPath || [],
    joins,
    directions,
    showDirections: o.showDirections,
    levels: take.levels,
    levelThreshold: o.levelThreshold,
    phrases: P,
    words: W,
    captions,
    commands,
    stats: {
      removed: D - finalCut.out,
      fumbles: live.filter((c) => ['cut', 'cutSentences', 'cutSeconds', 'cutFrom'].includes(c.type)).length,
      deadAir,
      hidden: blurs.length,
      zooms: live.filter((c) => c.type === 'zoomIn').length,
      chapters: chapters.length,
      sped: speeds.reduce((n, s) => n + (s.src1 - s.src0), 0),
      muted: mutes.length,
    },
  };
}

/**
 * Source time → output time. A time inside a cut maps to where the video resumes.
 * @param {Segment[]} segments @param {number} t @param {number} outDuration
 */
export function srcToOut(segments, t, outDuration) {
  // Binary search: this runs several times per frame.
  let lo = 0, hi = segments.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, s = segments[mid];
    if (t < s.src0) hi = mid - 1;
    else if (t >= s.src1) lo = mid + 1;
    else return s.out0 + (t - s.src0) / s.rate;
  }
  return lo < segments.length ? segments[lo].out0 : outDuration;
}

/**
 * Output time → the segment playing and the source time.
 * @param {Segment[]} segments @param {number} o
 * @returns {{seg: Segment, src: number} | null}
 */
export function outToSrc(segments, o) {
  for (const s of segments) {
    if (o < s.out1 || s === segments[segments.length - 1]) {
      const src = s.src0 + Math.max(0, Math.min(o, s.out1) - s.out0) * s.rate;
      return { seg: s, src: Math.min(src, s.src1) };
    }
  }
  return null;
}

/**
 * The segment that contains a source time, or the next one if it is cut.
 * @param {Segment[]} segments @param {number} t
 */
export function segmentAt(segments, t) {
  for (const s of segments) if (t < s.src1 - EPS) return s;
  return null;
}

/** Smooth in and out, with zero acceleration at both ends. @param {number} k */
const smoother = (k) => k * k * k * (k * (k * 6 - 15) + 10);
/** @param {number} k */
const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);

/**
 * Virtual camera at a source time. Glides are timed in *output* time, so a
 * zoom looks the same whether the footage around it is cut, sped up or not.
 * Scale is interpolated logarithmically (equal steps feel equally fast, as
 * with a real lens), and a new glide starts from wherever the last one had
 * got to, so quick "zoom in … zoom out" never jumps.
 * @param {Plan} plan @param {number} t
 * @returns {{scale: number, x: number, y: number}}
 */
export function cameraAt(plan, t) {
  const v = plan.view || [{ src: 0, scale: 1, x: 0.5, y: 0.5 }];
  const segs = plan.segments || [];
  const outOf = (/** @type {number} */ s) => (segs.length ? srcToOut(segs, s, plan.outDuration) : s);
  const now = outOf(t);
  let state = { scale: v[0].scale, x: v[0].x, y: v[0].y };
  for (let i = 1; i < v.length; i++) {
    const k0 = outOf(v[i].src);
    if (k0 > now + EPS || v[i].src > t + EPS) break;
    const next = v[i + 1];
    // Where the glide is when the next one interrupts it (or now).
    const until = next && next.src <= t ? Math.min(now, outOf(next.src)) : now;
    const e = smoother(Math.min(1, Math.max(0, (until - k0) / ZOOM_GLIDE)));
    const ls = Math.log(state.scale) + (Math.log(v[i].scale) - Math.log(state.scale)) * e;
    state = { scale: Math.exp(ls), x: state.x + (v[i].x - state.x) * e, y: state.y + (v[i].y - state.y) * e };
  }
  return state;
}

/**
 * Camera bubble state at a source time, with a short glide between modes.
 * @param {Plan} plan @param {number} t
 * @returns {{from: CamMode, to: CamMode, k: number}}
 */
export function cameraModeAt(plan, t) {
  const list = plan.camera || [{ src: 0, mode: 'small' }];
  let i = 0;
  while (i + 1 < list.length && list[i + 1].src <= t) i++;
  const cur = list[i], prev = list[i - 1];
  if (!prev) return { from: cur.mode, to: cur.mode, k: 1 };
  const segs = plan.segments || [];
  const d = segs.length ? srcToOut(segs, t, plan.outDuration) - srcToOut(segs, cur.src, plan.outDuration) : t - cur.src;
  return { from: prev.mode, to: cur.mode, k: ease(Math.max(0, Math.min(1, d / CAM_GLIDE))) };
}

/** Where the floating bubble was at time t (centre, 0..1), or null. @param {Plan} plan @param {number} t */
export function camPathAt(plan, t) {
  const p = plan.camPath;
  if (!p || p.length < 1) return null;
  let i = 0;
  while (i + 1 < p.length && p[i + 1].t <= t) i++;
  const a = p[i], b = p[i + 1];
  if (!b || t <= a.t) return { x: a.x, y: a.y };
  const k = Math.min(1, (t - a.t) / Math.max(0.01, b.t - a.t));
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
}

/** Is the sound silenced at this source time (a spoken command)? @param {Plan} plan @param {number} t */
export function mutedAt(plan, t) {
  return plan.mutes.some((m) => t >= m.src0 && t < m.src1);
}

/**
 * The volume the final video should have at a source time: silent during a
 * silenced command or a fast-forward, and faded out just before a cut so the
 * jump never chops a sound.
 * @param {Plan} plan @param {number} t @param {number} [lookahead]
 */
export function gainAt(plan, t, lookahead = 0.07) {
  const seg = segmentAt(plan.segments, t);
  if (!seg || seg.rate > AUDIBLE_RATE) return 0;
  if (mutedAt(plan, t) || mutedAt(plan, t + lookahead)) return 0;
  const next = plan.segments[plan.segments.indexOf(seg) + 1];
  const jump = next && next.src0 > seg.src1 + 0.04;
  if ((jump || !next) && t > seg.src1 - lookahead) return 0;
  if (next && next.rate > AUDIBLE_RATE && t > seg.src1 - lookahead) return 0;
  return 1;
}

/** Mic loudness at a source time (0..1). @param {Plan} plan @param {number} t */
export function levelAt(plan, t) {
  const lv = plan.levels;
  if (!lv || !lv.values.length) return 0;
  return lv.values[Math.max(0, Math.min(lv.values.length - 1, Math.floor(t / lv.dt)))] || 0;
}

/** @param {number} s */
export function fmt(s) {
  const t = Math.max(0, Math.floor(s));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
  const mm = String(m).padStart(2, '0'), ss = String(sec).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** @param {number} s */
function srtTime(s) {
  const ms = Math.round(s * 1000);
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), sec = Math.floor((ms % 60000) / 1000), r = ms % 1000;
  const p = (/** @type {number} */ n, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(sec)},${p(r, 3)}`;
}

/** @param {Caption[]} captions */
export function toSrt(captions) {
  return captions.map((c, i) => `${i + 1}\n${srtTime(c.out0)} --> ${srtTime(c.out1)}\n${c.text}\n`).join('\n');
}

/** WebVTT with word timestamps, so players that support it can highlight word by word. @param {Caption[]} captions */
export function toVtt(captions) {
  const ts = (/** @type {number} */ s) => srtTime(s).replace(',', '.');
  const body = (/** @type {Caption} */ c) =>
    c.words && c.words.length > 1 ? c.words.map((w, i) => (i ? `<${ts(Math.max(c.out0, w.out0))}>` : '') + w.text).join(' ') : c.text;
  return `WEBVTT\n\n${captions.map((c) => `${ts(c.out0)} --> ${ts(c.out1)}\n${body(c)}\n`).join('\n')}`;
}

/**
 * YouTube-style chapter list. YouTube needs the first at 00:00, at least three,
 * each at least 10 seconds long.
 * @param {Plan} plan
 */
export function youtubeChapters(plan) {
  const list = plan.chapters.map((c) => ({ out: c.out, title: c.title }));
  if (!list.length) return { text: '', valid: false, reason: 'Say “chapter: …” while recording to add chapters.' };
  if (list[0].out > 0.5) list.unshift({ out: 0, title: plan.title || 'Intro' });
  else list[0].out = 0;
  const text = list.map((c) => `${fmt(c.out)} ${c.title}`).join('\n');
  const tooShort = list.some((c, i) => (list[i + 1]?.out ?? plan.outDuration) - c.out < 10);
  const valid = list.length >= 3 && !tooShort;
  return { text, valid, reason: valid ? '' : 'YouTube shows chapters only with 3 or more, each at least 10 seconds long.' };
}
