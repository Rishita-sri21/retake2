// @ts-check
/**
 * Turns a raw take (video + transcript + audio levels + screen-motion log)
 * into an edit decision list: what to cut, what to silence, what to
 * fast-forward, where the virtual camera points, what to blur, where
 * chapters start, and the captions.
 *
 * Nothing here touches pixels; the renderer reads the plan. The plan is
 * rebuilt from scratch whenever a setting or a command toggle changes, so
 * every edit is non-destructive.
 */
import { parseCommands, stripCommands } from './commands.js';
import { focusAt, secretAt, goneAt, activity } from './motion.js';

/** @typedef {import('./commands.js').Phrase} Phrase */
/** @typedef {import('./commands.js').Command} Command */
/** @typedef {import('./motion.js').MotionSample} MotionSample */
/** @typedef {import('./motion.js').Box} Box */
/** @typedef {'small'|'big'|'hidden'} CamMode */

/**
 * @typedef {Object} Take
 * @property {number} duration
 * @property {Phrase[]} phrases
 * @property {{dt: number, values: ArrayLike<number>}} levels   Mic loudness (0..1) every dt seconds.
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
 * @property {number} ghostRate       Speed of would-be-cut footage in demo mode.
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
};

/**
 * @typedef {{src0: number, src1: number, rate: number, out0: number, out1: number, ghost?: 'fumble'|'dead-air'|'cut'}} Segment
 * @typedef {{src0: number, src1: number, reason: 'fumble'|'command'|'dead-air'|'cut'|'stop', by?: string}} Cut
 * @typedef {{src0: number, src1: number, rate: number, by: string}} Speed
 * @typedef {{src: number, scale: number, x: number, y: number, by?: string}} View
 * @typedef {{src0: number, src1: number, scale: number, by: string}} Zoom
 * @typedef {{src0: number, src1: number, box: Box, by: string, full?: boolean}} Blur
 * @typedef {{src0: number, src1: number, x: number, y: number, by: string}} Spot
 * @typedef {{src: number, out: number, title: string, by: string}} Chapter
 * @typedef {{out0: number, out1: number, text: string}} Caption
 * @typedef {{
 *   duration: number, outDuration: number, finalDuration: number,
 *   segments: Segment[], cuts: Cut[], mutes: {src0: number, src1: number}[], speeds: Speed[],
 *   view: View[], zooms: Zoom[], blurs: Blur[], spots: Spot[],
 *   chapters: Chapter[], title: string | null, marks: {src: number, out: number, by: string}[],
 *   camera: {src: number, mode: CamMode, by?: string}[], camPath: {t: number, x: number, y: number}[],
 *   joins: number[], directions: {src0: number, src1: number, heard: string, did: string, type: string}[],
 *   showDirections: boolean, levels: {dt: number, values: ArrayLike<number>}, levelThreshold: number,
 *   phrases: Phrase[], captions: Caption[], commands: (Command & {effect: string})[],
 *   stats: {removed: number, fumbles: number, deadAir: number, hidden: number, zooms: number, chapters: number, sped: number, muted: number}
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
 * Speech recognition reports a phrase late: its first words ~0.5s after they
 * were spoken, its end up to a second or two after. Re-measure each phrase
 * from the microphone: start where the voice actually started, end where it
 * actually stopped. Captions and cuts both depend on this.
 * @param {Take} take @param {number} threshold
 * @returns {Phrase[]}
 */
export function refinePhrases(take, threshold) {
  const lv = take.levels;
  if (!lv.values.length) return take.phrases.map((p) => ({ ...p }));
  const dt = lv.dt;
  /** @type {Phrase[]} */
  const out = [];
  take.phrases.forEach((p, i) => {
    const floor = i > 0 ? out[i - 1].end : 0;
    let start = Math.max(p.start, floor), end = p.end;
    // End: walk back from the reported end to the last loud moment.
    for (let t = p.end; t >= Math.max(start, p.end - 2.5); t -= dt) {
      if (loudAt(lv, t, threshold)) {
        end = t + 0.12;
        break;
      }
    }
    // Start: if we're in a silence, move forward to the voice...
    if (!loudAt(lv, start, threshold)) {
      for (let t = start; t < end; t += dt) {
        if (loudAt(lv, t, threshold)) {
          start = t;
          break;
        }
      }
    }
    // ...then walk back to where that voice began.
    for (let t = start; t >= Math.max(floor, start - 1.2); t -= dt) {
      if (!loudAt(lv, t, threshold)) break;
      start = t;
    }
    start = Math.max(floor, start - 0.06);
    if (end <= start + 0.2) end = Math.max(p.end, start + 0.4);
    out.push({ text: p.text, start, end: Math.min(take.duration, end) });
  });
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
  const P = refinePhrases(take, o.levelThreshold);
  const commands = parseCommands(P).map((c) => ({ ...c, enabled: !disabled.has(c.id), effect: '' }));
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
  /** @type {{src0: number, src1: number, by: string, type: string}[]} Spoken command ranges: cut or silenced in the final video. */
  const spoken = [];
  /** @type {Speed[]} */
  const speeds = [];
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
  /** @type {{src: number, mode: CamMode, by?: string}[]} */
  const camera = [{ src: 0, mode: o.cameraStart || take.cameraStart || 'small' }];

  for (const c of live) {
    if (c.standalone) spoken.push({ src0: clamp(P[c.phrase].start - 0.08), src1: clamp(P[c.phrase].end + 0.1), by: c.id, type: c.type });
  }

  for (const c of live) {
    const p = P[c.phrase];
    const after = clamp(p.end + 0.1);
    switch (c.type) {
      case 'cut': {
        // The fumble is in this breath if you said enough before "scratch that",
        // otherwise it's the sentence before.
        const prev = narrationBefore(c.phrase)[0];
        const from = c.before >= 3 || prev === undefined ? p.start : P[prev].start;
        cuts.push({ src0: clamp(from - 0.05), src1: after, reason: 'fumble', by: c.id });
        c.effect = `Removed ${(after - from).toFixed(1)}s`;
        break;
      }
      case 'cutSentences': {
        const list = narrationBefore(c.phrase);
        const n = Math.max(1, Math.min(list.length, Math.round(c.count || 1)));
        const from = list.length ? P[list[n - 1]].start : p.start;
        cuts.push({ src0: clamp(from - 0.05), src1: after, reason: 'cut', by: c.id });
        c.effect = `Removed ${n} sentence${n > 1 ? 's' : ''} (${(after - from).toFixed(1)}s)`;
        break;
      }
      case 'cutSeconds': {
        const from = clamp(p.start - (c.seconds || 5));
        cuts.push({ src0: from, src1: after, reason: 'cut', by: c.id });
        c.effect = `Removed ${(after - from).toFixed(1)}s`;
        break;
      }
      case 'cutFrom': {
        const to = nextOf(c, ['cutTo', 'stop']);
        const end = to ? clamp(P[to.phrase].end + 0.1) : D;
        cuts.push({ src0: clamp(p.start - 0.05), src1: end, reason: 'cut', by: c.id });
        c.effect = to ? `Removed ${(end - p.start).toFixed(1)}s, up to “${to.heard}”` : 'Removed everything after this (no “cut till here” was heard)';
        break;
      }
      case 'cutTo':
        c.effect = live.some((d) => d.type === 'cutFrom' && d.phrase < c.phrase) ? 'End of the cut' : 'No “cut from here” before this';
        break;
      case 'stop':
        cuts.push({ src0: clamp(p.start - 0.05), src1: D, reason: 'stop', by: c.id });
        c.effect = 'The video ends here';
        break;
      case 'pause': {
        // Recording actually paused a moment after you said it: drop that moment too.
        const j = (take.joins || []).find((x) => x >= p.start - 0.1);
        if (j !== undefined) cuts.push({ src0: clamp(p.start - 0.05), src1: clamp(j), reason: 'command', by: c.id });
        c.effect = 'Nothing was recorded until you resumed';
        break;
      }
      case 'resume':
        c.effect = 'Recording picked up again';
        break;
      case 'speedUp': {
        const stop = nextOf(c, ['normalSpeed', 'speedUp']);
        const nextTalk = P.findIndex((q, i) => i > c.phrase && !isCommandPhrase(i));
        const end = c.seconds ? after + c.seconds : stop ? P[stop.phrase].start : Math.min(nextTalk >= 0 ? P[nextTalk].start : D, after + 90);
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
        view.push({ src: after, scale, x, y, by: c.id });
        if (c.seconds) view.push({ src: clamp(after + c.seconds), scale: 1, x: 0.5, y: 0.5 });
        c.effect = `${String(Math.round(scale * 10) / 10)}× on the ${c.region ? c.region.replace('-', ' ') : c.more ? 'same spot' : 'centre'}${c.seconds ? ` for ${c.seconds}s` : ''}`;
        break;
      }
      case 'zoomOut':
        view.push({ src: after, scale: 1, x: 0.5, y: 0.5, by: c.id });
        c.effect = 'Back to the full screen';
        break;
      case 'highlight': {
        const f = focusAt(take.motion, p.end, 2.5);
        spots.push({ src0: after, src1: clamp(after + (c.seconds || 2.8)), x: f ? f.x : 0.5, y: f ? f.y : 0.5, by: c.id });
        c.effect = f ? 'Spotlight on what just changed' : 'Spotlight on the centre';
        break;
      }
      case 'hide': {
        const secret = secretAt(take.motion, p.start + 0.4);
        if (secret) {
          const un = nextOf(c, ['unhide']);
          const gone = goneAt(take.motion, secret.box, p.start + 0.4);
          let end = D, why = 'to the end';
          if (c.seconds) [end, why] = [p.end + c.seconds, `for ${c.seconds}s`];
          else if (un) [end, why] = [P[un.phrase].end, `until you said “${un.heard}”`];
          else if (gone !== null) [end, why] = [gone + 0.1, 'until it left the screen'];
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
        const end = c.seconds ? p.end + c.seconds : show ? P[show.phrase].start : D;
        blurs.push({ src0: p.start, src1: clamp(end), box: { x: 0, y: 0, w: 1, h: 1 }, full: true, by: c.id });
        c.effect = c.seconds ? `Whole screen hidden for ${c.seconds}s` : show ? `Whole screen hidden until “${show.heard}”` : 'Whole screen hidden to the end';
        break;
      }
      case 'showScreen':
        c.effect = 'Ends the screen blur';
        break;
      case 'chapter':
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
      case 'camHide': {
        const mode = c.type === 'camBig' ? 'big' : c.type === 'camHide' ? 'hidden' : 'small';
        // Start the move while you're still saying it, so it's part of the shot.
        camera.push({ src: clamp(p.start + 0.15), mode, by: c.id });
        c.effect = mode === 'big' ? 'Your face fills the frame' : mode === 'hidden' ? 'Camera bubble hidden' : 'Camera bubble back in place';
        break;
      }
    }
  }
  view.sort((a, b) => a.src - b.src);

  // Spoken commands. "Smart" silences them while the screen is moving (no jump
  // in the picture) and cuts them where the screen is still (no visible jump).
  /** @type {{src0: number, src1: number}[]} */
  const mutes = [];
  for (const s of spoken) {
    if (['cut', 'cutSentences', 'cutSeconds', 'stop', 'pause'].includes(s.type)) continue; // already inside a cut
    const still = activity(take.motion, s.src0, s.src1) < 0.004;
    const style = o.commandStyle === 'smart' ? (still ? 'cut' : 'mute') : o.commandStyle;
    if (style === 'cut') cuts.push({ src0: s.src0, src1: s.src1, reason: 'command', by: s.by });
    else mutes.push({ src0: s.src0, src1: s.src1 });
  }

  // Dead air: long silences where nothing happens on screen.
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
   * @param {{src0: number, src1: number, rate: number, ghost?: Segment['ghost']}[]} rated
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
  let finalMutes = mutes;

  if (o.showDirections) {
    // Demo mode: nothing is removed. Spoken commands stay audible; what the
    // final cut removes plays fast under a red overlay instead.
    /** @type {{src0: number, src1: number, rate: number, ghost: NonNullable<Segment['ghost']>}[]} */
    const ghosts = [];
    for (const c of cuts) {
      if (c.reason === 'command') continue;
      // Keep the spoken command that asked for the cut audible at normal speed.
      const cmdSpoken = spoken.find((s) => s.by === c.by);
      const end = cmdSpoken && cmdSpoken.src0 > c.src0 ? cmdSpoken.src0 : c.src1;
      if (end - c.src0 > 0.1) ghosts.push({ src0: c.src0, src1: end, rate: o.ghostRate, ghost: c.reason === 'dead-air' ? 'dead-air' : c.reason === 'fumble' ? 'fumble' : 'cut' });
    }
    const merged = union(ghosts).map((g) => ({ ...g, rate: o.ghostRate, ghost: ghosts.find((x) => x.src0 < g.src1 && x.src1 > g.src0)?.ghost }));
    const demo = segmentsOf([{ src0: 0, src1: D }], [...speeds.filter((sp) => !merged.some((g) => sp.src0 < g.src1 && sp.src1 > g.src0)), ...merged]);
    segments = demo.segs;
    outDuration = demo.out;
    finalMutes = [];
  }

  /** @param {number} t */
  const toOut = (t) => srcToOut(segments, t, outDuration);

  // Captions from the narration that survived, timed from the measured phrases.
  /** @type {Caption[]} */
  const captions = [];
  P.forEach((p, i) => {
    if (isCommandPhrase(i)) return;
    const text = stripCommands(p.text);
    if (!text) return;
    const w = text.split(/\s+/);
    const per = Math.max(3, Math.ceil(w.length / Math.ceil(w.length / 7)));
    const chunks = [];
    for (let k = 0; k < w.length; k += per) chunks.push(w.slice(k, k + per).join(' '));
    const total = chunks.reduce((n, ch) => n + ch.length + 1, 0);
    let t = p.start;
    for (const ch of chunks) {
      const len = ((p.end - p.start) * (ch.length + 1)) / total;
      const a = t, b = t + len;
      t = b;
      const mid = (a + b) / 2;
      if (!segments.some((s) => mid >= s.src0 && mid < s.src1)) continue; // this bit was cut
      if (finalMutes.some((m) => mid >= m.src0 && mid < m.src1)) continue;
      const out0 = toOut(a), out1 = toOut(b);
      if (out1 - out0 > 0.15) captions.push({ out0, out1, text: ch });
    }
  });
  // Hold each caption a little, until the next one, so they don't flicker.
  for (let i = 0; i < captions.length; i++) {
    const next = captions[i + 1];
    captions[i].out1 = Math.min(next ? next.out0 : outDuration, captions[i].out1 + 0.6);
  }

  const chapters = chapterSrc.map((c) => ({ ...c, out: toOut(c.src) }));

  /** @type {Zoom[]} Zoom ranges, for the timeline. */
  const zooms = [];
  for (let i = 0; i < view.length; i++) {
    if (view[i].scale > 1) zooms.push({ src0: view[i].src, src1: view[i + 1]?.src ?? D, scale: view[i].scale, by: view[i].by || '' });
  }

  const directions = o.showDirections
    ? live.map((c) => {
        const p = P[c.phrase];
        return { src0: p.start, src1: Math.min(D, p.end + 1.8), heard: c.heard, did: c.effect, type: c.type };
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
    marks: markSrc.map((m) => ({ ...m, out: toOut(m.src) })),
    camera: camera.sort((a, b) => a.src - b.src),
    camPath: take.camPath || [],
    joins: take.joins || [],
    directions,
    showDirections: o.showDirections,
    levels: take.levels,
    levelThreshold: o.levelThreshold,
    phrases: P,
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

/** @param {number} k */
const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);

/**
 * Virtual camera at a source time: glides from one view to the next.
 * @param {Plan} plan @param {number} t
 * @returns {{scale: number, x: number, y: number}}
 */
export function cameraAt(plan, t) {
  const v = plan.view || [{ src: 0, scale: 1, x: 0.5, y: 0.5 }];
  let i = 0;
  while (i + 1 < v.length && v[i + 1].src <= t) i++;
  const cur = v[i], prev = v[i - 1];
  if (!prev) return { scale: cur.scale, x: cur.x, y: cur.y };
  const e = ease(Math.min(1, Math.max(0, (t - cur.src) / 0.8)));
  return { scale: prev.scale + (cur.scale - prev.scale) * e, x: prev.x + (cur.x - prev.x) * e, y: prev.y + (cur.y - prev.y) * e };
}

/**
 * Camera bubble state at a source time, with a 0.6s transition between modes.
 * @param {Plan} plan @param {number} t
 * @returns {{from: CamMode, to: CamMode, k: number}}
 */
export function cameraModeAt(plan, t) {
  const list = plan.camera || [{ src: 0, mode: 'small' }];
  let i = 0;
  while (i + 1 < list.length && list[i + 1].src <= t) i++;
  const cur = list[i], prev = list[i - 1];
  const k = prev ? Math.min(1, (t - cur.src) / 0.6) : 1;
  return { from: prev ? prev.mode : cur.mode, to: cur.mode, k: ease(Math.max(0, k)) };
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
  if (!list.length) return { text: '', valid: false, reason: 'Say “chapter: …” while recording to add chapters.' };
  if (list[0].out > 0.5) list.unshift({ out: 0, title: plan.title || 'Intro' });
  else list[0].out = 0;
  const text = list.map((c) => `${fmt(c.out)} ${c.title}`).join('\n');
  const tooShort = list.some((c, i) => (list[i + 1]?.out ?? plan.outDuration) - c.out < 10);
  const valid = list.length >= 3 && !tooShort;
  return { text, valid, reason: valid ? '' : 'YouTube shows chapters only with 3 or more, each at least 10 seconds long.' };
}
