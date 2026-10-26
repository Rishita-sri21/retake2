// @ts-check
/**
 * Turns a raw take (video + transcript + audio levels + screen-motion log)
 * into an edit decision list: what to cut, what to fast-forward, where to
 * zoom, what to blur, where chapters start, and the captions.
 *
 * Nothing here touches pixels; the renderer reads the plan. Because the plan
 * is rebuilt from scratch whenever a setting or a command toggle changes,
 * every edit is non-destructive.
 */
import { parseCommands, stripCommands } from './commands.js';
import { focusAt, secretAt, goneAt, activity } from './motion.js';

/** @typedef {import('./commands.js').Phrase} Phrase */
/** @typedef {import('./commands.js').Command} Command */
/** @typedef {import('./motion.js').MotionSample} MotionSample */
/** @typedef {import('./motion.js').Box} Box */

/**
 * @typedef {Object} Take
 * @property {number} duration
 * @property {Phrase[]} phrases
 * @property {{dt: number, values: ArrayLike<number>}} levels   Mic loudness (0..1) every dt seconds.
 * @property {MotionSample[]} motion
 * @property {CamMode} [cameraStart]  How the camera bubble starts (default 'small').
 */

/**
 * @typedef {Object} Options
 * @property {boolean} trimDeadAir
 * @property {number} deadAirMin     Silences at least this long (s) are shortened...
 * @property {number} deadAirKeep    ...to this long.
 * @property {number} speed          Fast-forward factor.
 * @property {number} zoom           Zoom factor.
 * @property {number} levelThreshold Loudness below this is silence.
 * @property {string[]} disabled     Command ids the user switched off.
 * @property {boolean} showDirections Demo mode: keep the spoken directions in the video,
 *                                    label them, and play what would be cut fast under a red overlay.
 * @property {number} ghostRate       Speed of would-be-cut footage in demo mode.
 * @property {'small'|'big'|'hidden'|undefined} [cameraStart]
 */

/** @type {Options} */
export const DEFAULTS = {
  trimDeadAir: true,
  deadAirMin: 1.4,
  deadAirKeep: 0.5,
  speed: 4,
  zoom: 2,
  levelThreshold: 0.04,
  disabled: [],
  showDirections: false,
  ghostRate: 3,
};

/**
 * @typedef {{src0: number, src1: number, rate: number, out0: number, out1: number, ghost?: 'fumble'|'dead-air'}} Segment
 * @typedef {{src0: number, src1: number, reason: 'fumble'|'command'|'dead-air', by?: string}} Cut
 * @typedef {{src0: number, src1: number, rate: number, by: string}} Speed
 * @typedef {{src0: number, src1: number, x: number, y: number, scale: number, by: string}} Zoom
 * @typedef {{src0: number, src1: number, box: Box, by: string}} Blur
 * @typedef {{src0: number, src1: number, x: number, y: number, by: string}} Spot
 * @typedef {{src: number, out: number, title: string, by: string}} Chapter
 * @typedef {{out0: number, out1: number, text: string}} Caption
 * @typedef {'small'|'big'|'hidden'} CamMode
 * @typedef {{
 *   duration: number, outDuration: number,
 *   segments: Segment[], cuts: Cut[], speeds: Speed[], zooms: Zoom[], blurs: Blur[], spots: Spot[],
 *   chapters: Chapter[], title: string | null, marks: {src: number, out: number, by: string}[],
 *   camera: {src: number, mode: CamMode, by?: string}[],
 *   directions: {src0: number, src1: number, heard: string, did: string, type: string}[], showDirections: boolean, finalDuration: number, levels: {dt: number, values: ArrayLike<number>}, levelThreshold: number,
 *   captions: Caption[], commands: (Command & {effect: string})[],
 *   stats: {removed: number, fumbles: number, deadAir: number, hidden: number, zooms: number, chapters: number, sped: number}
 * }} Plan
 */

const EPS = 1e-6;

/**
 * @param {{dt: number, values: ArrayLike<number>}} levels
 * @param {number} t
 * @param {number} threshold
 */
function loudAt(levels, t, threshold) {
  const i = Math.floor(t / levels.dt);
  return i >= 0 && i < levels.values.length && levels.values[i] >= threshold;
}

/**
 * Move a phrase boundary onto the nearest silence so cuts don't clip words.
 * Speech recognition reports phrase ends late, so ends are searched backwards.
 * @param {Take} take @param {Options} o @param {number} t @param {'start'|'end'} edge
 */
function snap(take, o, t, edge) {
  const { levels } = take;
  if (!levels.values.length) return edge === 'start' ? t - 0.2 : t + 0.2;
  const step = levels.dt;
  if (edge === 'start') {
    // Walk back to the first silent sample before the words began.
    for (let x = t; x >= Math.max(0, t - 0.8); x -= step) if (!loudAt(levels, x, o.levelThreshold)) return x;
    return t - 0.8;
  }
  // Walk back from the reported end to the last loud sample, then a little air.
  for (let x = t; x >= Math.max(0, t - 1.5); x -= step) if (loudAt(levels, x, o.levelThreshold)) return x + 0.2;
  return t;
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
 * @param {Take} take
 * @param {Partial<Options>} [options]
 * @returns {Plan}
 */
export function buildPlan(take, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const D = take.duration;
  const clamp = (/** @type {number} */ t) => Math.max(0, Math.min(D, t));
  const disabled = new Set(o.disabled);
  const commands = parseCommands(take.phrases).map((c) => ({ ...c, enabled: !disabled.has(c.id), effect: '' }));
  const live = commands.filter((c) => c.enabled);
  const P = take.phrases;
  const nextOf = (/** @type {Command} */ c, /** @type {string[]} */ types) =>
    live.find((d) => d.phrase > c.phrase && types.includes(d.type));

  /** @type {Cut[]} */
  const cuts = [];
  /** @type {Speed[]} */
  const speeds = [];
  /** @type {Zoom[]} */
  const zooms = [];
  /** @type {Blur[]} */
  const blurs = [];
  /** @type {Spot[]} */
  const spots = [];
  /** @type {{src: number, title: string, by: string}[]} */
  const chapterSrc = [];
  /** @type {{src: number, by: string}[]} */
  const markSrc = [];
  let title = /** @type {string|null} */ (null);
  /** @type {{src: number, mode: CamMode, by?: string}[]} */
  const camera = [{ src: 0, mode: o.cameraStart || take.cameraStart || 'small' }];

  // Phrases that are only a direction to the editor never appear in the video.
  for (const c of live) {
    if (!c.standalone) continue;
    const p = P[c.phrase];
    cuts.push({ src0: clamp(snap(take, o, p.start, 'start')), src1: clamp(snap(take, o, p.end, 'end')), reason: 'command', by: c.id });
  }

  for (const c of live) {
    const p = P[c.phrase];
    const after = clamp(snap(take, o, p.end, 'end'));
    switch (c.type) {
      case 'cut': {
        // The fumble is in this phrase if you said enough before "scratch that",
        // otherwise it is the sentence before.
        const fumble = c.before >= 3 || c.phrase === 0 ? p : P[c.phrase - 1];
        const src0 = clamp(snap(take, o, fumble.start, 'start'));
        cuts.push({ src0, src1: after, reason: 'fumble', by: c.id });
        c.effect = `Removed ${(after - src0).toFixed(1)}s`;
        break;
      }
      case 'speedUp': {
        const stop = nextOf(c, ['normalSpeed', 'speedUp']);
        const nextTalk = P.findIndex((q, i) => i > c.phrase && !live.some((d) => d.phrase === i && d.standalone));
        const end = stop ? P[stop.phrase].start : Math.min(nextTalk >= 0 ? P[nextTalk].start : D, after + 60);
        if (end - after > 0.5) {
          speeds.push({ src0: after, src1: clamp(end), rate: o.speed, by: c.id });
          c.effect = `${(end - after).toFixed(0)}s at ${o.speed}×`;
        } else c.effect = 'Nothing to speed up';
        break;
      }
      case 'zoomIn': {
        const f = focusAt(take.motion, p.end);
        const stop = nextOf(c, ['zoomOut', 'zoomIn', 'chapter']);
        const end = stop ? P[stop.phrase].start : Math.min(D, after + 10);
        const s = o.zoom;
        const half = 0.5 / s;
        const x = Math.min(1 - half, Math.max(half, f ? f.x : 0.5));
        const y = Math.min(1 - half, Math.max(half, f ? f.y : 0.5));
        zooms.push({ src0: after, src1: clamp(end), x, y, scale: s, by: c.id });
        c.effect = f ? `${s}× on the area that just changed` : `${s}× on the centre (no recent change found)`;
        break;
      }
      case 'highlight': {
        const f = focusAt(take.motion, p.end, 2.5);
        spots.push({ src0: after, src1: clamp(after + 2.8), x: f ? f.x : 0.5, y: f ? f.y : 0.5, by: c.id });
        c.effect = f ? 'Spotlight on the area that just changed' : 'Spotlight on the centre';
        break;
      }
      case 'hide': {
        const secret = secretAt(take.motion, p.start + 0.4);
        if (secret) {
          // Keep it hidden for as long as it stays on screen.
          const gone = goneAt(take.motion, secret.box, p.start + 0.4);
          const end = gone === null ? D : gone + 0.1;
          blurs.push({ src0: secret.start, src1: end, box: secret.box, by: c.id });
          c.effect = gone === null ? `Blurred from ${fmt(secret.start)} to the end` : `Blurred from ${fmt(secret.start)} until it left the screen at ${fmt(gone)}`;
        } else c.effect = 'Nothing new appeared on screen to hide';
        break;
      }
      case 'chapter':
        chapterSrc.push({ src: p.start, title: c.label || 'Chapter', by: c.id });
        c.effect = `Chapter "${c.label}"`;
        break;
      case 'title':
        title = c.label || null;
        c.effect = 'Opening title card';
        break;
      case 'mark':
        markSrc.push({ src: p.start, by: c.id });
        c.effect = 'Bookmark';
        break;
      case 'zoomOut':
        c.effect = 'Ends the zoom';
        break;
      case 'normalSpeed':
        c.effect = 'Ends the fast-forward';
        break;
      case 'camBig':
      case 'camSmall':
      case 'camShow':
      case 'camHide': {
        // Camera directions only count when said on their own, so "we bought
        // a big camera" in narration doesn't resize you.
        if (!c.standalone) {
          c.effect = 'Ignored: said as part of a sentence';
          break;
        }
        const mode = c.type === 'camBig' ? 'big' : c.type === 'camHide' ? 'hidden' : 'small';
        camera.push({ src: after, mode, by: c.id });
        c.effect = mode === 'big' ? 'Your face fills the frame' : mode === 'hidden' ? 'Camera bubble hidden' : 'Camera bubble in the corner';
        break;
      }
    }
  }

  // Dead air: long silences where nothing happens on screen. Busy silences
  // (you're typing or something is loading) are kept; say "speed this up" for those.
  let deadAir = 0;
  if (o.trimDeadAir && take.levels.values.length) {
    const { dt, values } = take.levels;
    let runStart = -1;
    const flush = (/** @type {number} */ endIdx) => {
      const s0 = runStart * dt, s1 = endIdx * dt;
      if (s1 - s0 >= o.deadAirMin && activity(take.motion, s0, s1) < 0.004) {
        const inSpeed = speeds.some((r) => s0 < r.src1 && s1 > r.src0);
        if (!inSpeed) {
          const a = s0 + o.deadAirKeep / 2, b = s1 - o.deadAirKeep / 2;
          cuts.push({ src0: a, src1: b, reason: 'dead-air' });
          deadAir += b - a;
        }
      }
    };
    for (let i = 0; i <= values.length; i++) {
      const silent = i < values.length && values[i] < o.levelThreshold;
      if (silent && runStart < 0) runStart = i;
      if (!silent && runStart >= 0) {
        flush(Math.min(i, Math.round(D / dt)));
        runStart = -1;
      }
    }
  }

  // Keep = everything not cut; then split by speed ranges.
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
   * @param {{src0: number, src1: number, rate: number, ghost?: 'fumble'|'dead-air'}[]} rated
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
        segs.push(seg);
        out += (b - a) / rate;
      }
    }
    return { segs, out };
  };

  const finalCut = segmentsOf(keep, speeds);
  let segments = finalCut.segs;
  let outDuration = finalCut.out;

  if (o.showDirections) {
    // Demo mode: nothing is removed. Spoken directions stay audible; the
    // fumbles and dead air play fast under a red "cut" overlay instead.
    /** @type {{src0: number, src1: number, rate: number, ghost: 'fumble'|'dead-air'}[]} */
    const ghosts = [];
    for (const r of removed) {
      const parts = cuts.filter((c) => c.reason !== 'command' && c.src0 < r.src1 - EPS && c.src1 > r.src0 + EPS);
      if (!parts.length) continue;
      const src0 = Math.max(r.src0, Math.min(...parts.map((c) => c.src0)));
      const src1 = Math.min(r.src1, Math.max(...parts.map((c) => c.src1)));
      const kind = parts.some((c) => c.reason === 'fumble') ? 'fumble' : 'dead-air';
      // A fumble cut ends where "scratch that" ends; keep the direction itself at normal speed.
      const cmd = cuts.find((c) => c.reason === 'command' && c.by && parts.some((f) => f.by === c.by));
      const end = kind === 'fumble' && cmd ? Math.max(src0, cmd.src0) : src1;
      if (end - src0 > 0.1) ghosts.push({ src0, src1: end, rate: o.ghostRate, ghost: kind });
    }
    const demo = segmentsOf([{ src0: 0, src1: D }], [...speeds.filter((sp) => !ghosts.some((g) => sp.src0 < g.src1 && sp.src1 > g.src0)), ...ghosts]);
    segments = demo.segs;
    outDuration = demo.out;
  }

  /** @param {number} t */
  const toOut = (t) => srcToOut(segments, t, outDuration);

  // Captions from the narration that survived the cut.
  /** @type {Caption[]} */
  const captions = [];
  P.forEach((p, i) => {
    if (live.some((c) => c.phrase === i && c.standalone)) return;
    const text = stripCommands(p.text);
    if (!text) return;
    const w = text.split(/\s+/);
    const chunks = [];
    for (let k = 0; k < w.length; k += 7) chunks.push(w.slice(k, k + 7).join(' '));
    const total = chunks.reduce((n, ch) => n + ch.length, 0);
    let t = p.start;
    for (const ch of chunks) {
      const len = ((p.end - p.start) * ch.length) / total;
      const a = t, b = t + len;
      t = b;
      const mid = (a + b) / 2;
      if (!segments.some((s) => mid >= s.src0 && mid < s.src1)) continue; // this bit was cut
      const out0 = toOut(a), out1 = toOut(b);
      if (out1 - out0 > 0.15) captions.push({ out0, out1, text: ch });
    }
  });

  const chapters = chapterSrc.map((c) => ({ ...c, out: toOut(c.src) }));

  // Labels shown in demo mode while each direction is spoken.
  const directions = o.showDirections
    ? live.map((c) => {
        const p = P[c.phrase];
        return { src0: p.start, src1: Math.min(D, p.end + 1.6), heard: c.heard, did: c.effect, type: c.type };
      })
    : [];

  return {
    duration: D,
    outDuration,
    segments,
    cuts: removed.map((r) => {
      const why = cuts.find((c) => c.src0 >= r.src0 - EPS && c.src1 <= r.src1 + EPS && c.reason === 'fumble') ||
        cuts.find((c) => c.src0 >= r.src0 - EPS && c.src1 <= r.src1 + EPS && c.reason === 'command') ||
        { reason: /** @type {const} */ ('dead-air') };
      return { src0: r.src0, src1: r.src1, reason: why.reason, by: /** @type {any} */ (why).by };
    }),
    speeds,
    zooms,
    blurs,
    spots,
    chapters,
    title,
    marks: markSrc.map((m) => ({ ...m, out: toOut(m.src) })),
    camera: camera.sort((a, b) => a.src - b.src),
    directions,
    showDirections: o.showDirections,
    finalDuration: finalCut.out,
    levels: take.levels,
    levelThreshold: o.levelThreshold,
    captions,
    commands,
    stats: {
      removed: D - finalCut.out,
      fumbles: live.filter((c) => c.type === 'cut').length,
      deadAir,
      hidden: blurs.length,
      zooms: zooms.length,
      chapters: chapters.length,
      sped: speeds.reduce((n, s) => n + (s.src1 - s.src0), 0),
    },
  };
}

/**
 * Source time → output time. A time inside a cut maps to where the video resumes.
 * @param {Segment[]} segments @param {number} t @param {number} outDuration
 */
export function srcToOut(segments, t, outDuration) {
  for (const s of segments) {
    if (t < s.src0) return s.out0;
    if (t < s.src1) return s.out0 + (t - s.src0) / s.rate;
  }
  return outDuration;
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

/**
 * Camera at a source time: eases in and out of each zoom.
 * @param {Plan} plan @param {number} t
 * @returns {{scale: number, x: number, y: number}}
 */
export function cameraAt(plan, t) {
  const EASE = 0.6;
  for (const z of plan.zooms) {
    if (t < z.src0 || t > z.src1) continue;
    const k = Math.min(1, (t - z.src0) / EASE, (z.src1 - t) / EASE);
    const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2; // easeInOutCubic
    return { scale: 1 + (z.scale - 1) * e, x: 0.5 + (z.x - 0.5) * e, y: 0.5 + (z.y - 0.5) * e };
  }
  return { scale: 1, x: 0.5, y: 0.5 };
}

/**
 * Camera bubble state at a source time, with a 0.5s transition between modes.
 * @param {Plan} plan @param {number} t
 * @returns {{from: CamMode, to: CamMode, k: number}}
 */
export function cameraModeAt(plan, t) {
  const list = plan.camera || [{ src: 0, mode: 'small' }];
  let i = 0;
  while (i + 1 < list.length && list[i + 1].src <= t) i++;
  const cur = list[i], prev = list[i - 1];
  const k = prev ? Math.min(1, (t - cur.src) / 0.5) : 1;
  const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
  return { from: prev ? prev.mode : cur.mode, to: cur.mode, k: e };
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
  const mm = String(m).padStart(h ? 2 : 2, '0'), ss = String(sec).padStart(2, '0');
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

/** @param {Caption[]} captions */
export function toVtt(captions) {
  return `WEBVTT\n\n${captions.map((c) => `${srtTime(c.out0).replace(',', '.')} --> ${srtTime(c.out1).replace(',', '.')}\n${c.text}\n`).join('\n')}`;
}

/**
 * YouTube-style chapter list. YouTube needs the first at 00:00, at least three,
 * each at least 10 seconds long.
 * @param {Plan} plan
 */
export function youtubeChapters(plan) {
  const list = plan.chapters.map((c) => ({ out: c.out, title: c.title }));
  if (!list.length) return { text: '', valid: false, reason: 'Say "chapter: …" while recording to add chapters.' };
  if (list[0].out > 0.5) list.unshift({ out: 0, title: plan.title || 'Intro' });
  else list[0].out = 0;
  const text = list.map((c) => `${fmt(c.out)} ${c.title}`).join('\n');
  const tooShort = list.some((c, i) => (list[i + 1]?.out ?? plan.outDuration) - c.out < 10);
  const valid = list.length >= 3 && !tooShort;
  return { text, valid, reason: valid ? '' : 'YouTube shows chapters only with 3 or more, each at least 10 seconds long.' };
}
