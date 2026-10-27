// @ts-check
/**
 * Playback of a take through its plan: skips the cuts, plays fast-forwards
 * at speed, and draws every frame with the renderer. The export is the same
 * loop running onto a recorded canvas.
 */
import { segmentAt, srcToOut, outToSrc, gainAt, AUDIBLE_RATE } from './plan.js';
import { drawFrame } from './render.js';
import { drawSample, drawPresenter, SAMPLE_W, SAMPLE_H, SAMPLE_DURATION } from './sample.js';

/** @typedef {import('./plan.js').Plan} Plan */
/** @typedef {import('./render.js').Look} Look */

/**
 * @typedef {Object} Source
 * @property {number} width
 * @property {number} height
 * @property {number} duration
 * @property {CanvasImageSource} frame
 * @property {() => number} time
 * @property {(rate: number) => Promise<void>|void} play
 * @property {() => void} pause
 * @property {(t: number) => Promise<void>} seek
 * @property {(rate: number) => void} setRate
 * @property {() => void} [tick]
 * @property {HTMLVideoElement} [video]
 * @property {Blob} [blob]                     The recording, for decoding its sound.
 * @property {() => HTMLVideoElement[]} [elements]
 * @property {(t: number) => void} [prime]      Get the standby decoder ready at t.
 * @property {(t: number) => boolean} [canSwap] Is the standby decoder ready at t?
 * @property {(rate: number) => void} [swap]    Cut to the standby decoder instantly.
 * @property {CameraFeed | null} [camera]
 */

/**
 * @typedef {Object} CameraFeed
 * @property {CanvasImageSource} frame
 * @property {number} width
 * @property {number} height
 * @property {(src: number, playing: boolean, rate: number) => void} sync
 */

/** The webcam recording, kept in step with the screen recording. */
export class CameraTrack {
  /** @param {Blob} blob @param {number} offset Seconds the camera started after the screen. @param {number} duration */
  constructor(blob, offset, duration) {
    this.vs = new VideoSource(blob, duration);
    this.vs.video.muted = true;
    this.offset = offset;
    this.frame = this.vs.video;
    this.width = 0;
    this.height = 0;
  }
  async ready() {
    await this.vs.ready();
    this.width = this.vs.width;
    this.height = this.vs.height;
  }
  /** @param {number} src @param {boolean} playing @param {number} rate */
  sync(src, playing, rate) {
    const v = this.vs.video;
    const want = Math.max(0, src - this.offset);
    if (!v.seeking && Math.abs(v.currentTime - want) > (playing ? 0.3 : 0.04)) v.currentTime = want;
    if (v.playbackRate !== rate) v.playbackRate = rate;
    if (playing && v.paused) v.play().catch(() => {});
    if (!playing && !v.paused) v.pause();
  }
}

/**
 * A recorded video file, played through two decoders. While one plays, the
 * other waits, already seeked to where the next cut lands, so a cut is an
 * instant switch rather than a seek (which stalls for 100–500ms on WebM).
 */
export class VideoSource {
  /** @param {Blob} blob @param {number} knownDuration */
  constructor(blob, knownDuration) {
    this.blob = blob;
    this.url = URL.createObjectURL(blob);
    this.video = this.make();
    /** @type {HTMLVideoElement} */
    this.alt = this.make();
    this.frame = this.video;
    this.duration = knownDuration;
    this.width = 1280;
    this.height = 720;
    this.primedAt = -1;
    this.primed = false;
    /** @type {((now: HTMLVideoElement, old: HTMLVideoElement) => void) | undefined} */
    this.onSwap = undefined;
  }

  make() {
    const v = document.createElement('video');
    v.playsInline = true;
    v.preload = 'auto';
    v.src = this.url;
    /** @type {any} */ (v).preservesPitch = true;
    return v;
  }

  elements() {
    return [this.video, this.alt];
  }

  async ready() {
    const v = this.video;
    const meta = (/** @type {HTMLVideoElement} */ el) =>
      new Promise((res, rej) => {
        if (el.readyState >= 1) return res(undefined);
        el.addEventListener('loadedmetadata', () => res(undefined), { once: true });
        el.addEventListener('error', () => rej(new Error('This recording could not be opened.')), { once: true });
      });
    await meta(v);
    this.width = v.videoWidth || 1280;
    this.height = v.videoHeight || 720;
    // MediaRecorder WebM files have no duration until the end has been read.
    if (!Number.isFinite(v.duration)) {
      await new Promise((res) => {
        const done = () => {
          v.removeEventListener('durationchange', done);
          res(undefined);
        };
        v.addEventListener('durationchange', done);
        v.currentTime = 1e101;
        setTimeout(done, 3000);
      });
    }
    if (Number.isFinite(v.duration) && v.duration > 0) this.duration = Math.min(this.duration || Infinity, v.duration);
    await this.seek(0);
    meta(this.alt).catch(() => {});
  }

  time() {
    return this.video.currentTime;
  }
  /** @param {number} rate */
  play(rate) {
    this.video.playbackRate = rate;
    return this.video.play();
  }
  pause() {
    this.video.pause();
    this.alt.pause();
  }
  /** @param {number} rate */
  setRate(rate) {
    if (this.video.playbackRate !== rate) this.video.playbackRate = rate;
  }
  /** @param {number} t */
  seek(t) {
    const v = this.video;
    this.primed = false;
    this.primedAt = -1;
    return new Promise((res) => {
      if (Math.abs(v.currentTime - t) < 0.01) return res(undefined);
      const done = () => {
        v.removeEventListener('seeked', done);
        res(undefined);
      };
      v.addEventListener('seeked', done);
      v.currentTime = t;
      setTimeout(done, 1500);
    });
  }
  /** @param {number} t */
  prime(t) {
    if (Math.abs(this.primedAt - t) < 0.02) return;
    const a = this.alt;
    this.primedAt = t;
    this.primed = false;
    if (a.readyState < 1) return;
    a.pause();
    const done = () => {
      a.removeEventListener('seeked', done);
      if (Math.abs(this.primedAt - t) < 0.02) this.primed = true;
    };
    a.addEventListener('seeked', done);
    a.currentTime = t;
  }
  /** @param {number} t */
  canSwap(t) {
    return this.primed && Math.abs(this.primedAt - t) < 0.05 && !this.alt.seeking && this.alt.readyState >= 2;
  }
  /** @param {number} rate */
  swap(rate) {
    const old = this.video;
    this.video = this.alt;
    this.alt = old;
    this.frame = this.video;
    this.primed = false;
    this.primedAt = -1;
    this.video.playbackRate = rate;
    this.video.play().catch(() => {});
    old.pause();
    this.onSwap?.(this.video, old);
  }
}

/** The procedural sample take. */
export class SampleSource {
  constructor() {
    this.width = SAMPLE_W;
    this.height = SAMPLE_H;
    this.duration = SAMPLE_DURATION;
    this.canvas = document.createElement('canvas');
    this.canvas.width = SAMPLE_W;
    this.canvas.height = SAMPLE_H;
    this.ctx = /** @type {CanvasRenderingContext2D} */ (this.canvas.getContext('2d'));
    this.frame = this.canvas;
    this.t = 0;
    this.rate = 1;
    this.playing = false;
    this.last = 0;
    this.drawnAt = -1;
    this.draw();
    // A drawn presenter stands in for the webcam in the sample.
    const cam = document.createElement('canvas');
    cam.width = cam.height = 480;
    const cctx = /** @type {CanvasRenderingContext2D} */ (cam.getContext('2d'));
    let camAt = -1;
    this.camera = {
      frame: cam,
      width: 480,
      height: 480,
      sync: (/** @type {number} */ src) => {
        if (Math.abs(src - camAt) < 1 / 60) return;
        camAt = src;
        drawPresenter(cctx, src, 480);
      },
    };
  }
  draw() {
    if (this.drawnAt !== this.t) {
      drawSample(this.ctx, this.t, SAMPLE_W, SAMPLE_H);
      this.drawnAt = this.t;
    }
  }
  tick() {
    const now = performance.now();
    if (this.playing) this.t = Math.min(this.duration, this.t + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    this.draw();
  }
  time() {
    return this.t;
  }
  /** @param {number} rate */
  play(rate) {
    this.rate = rate;
    this.playing = true;
    this.last = performance.now();
  }
  pause() {
    this.playing = false;
  }
  /** @param {number} rate */
  setRate(rate) {
    this.rate = rate;
  }
  /** @param {number} t */
  async seek(t) {
    this.t = Math.max(0, Math.min(this.duration, t));
    this.draw();
  }
}

/**
 * Drives a source through a plan and paints a canvas.
 *
 * Sound: the recording's audio is decoded once and played from the Web Audio
 * clock, one buffer source per stretch of the edit, with silenced commands
 * written into its gain envelope. Cuts are therefore sample-accurate: video
 * decoders resume a recorded WebM up to ~0.3s early on a seek, which used to
 * let the end of a cut command slip through. (If decoding fails, the video
 * elements' own sound is used, faded by the plan.)
 *
 * Pictures: the standby decoder is primed a second ahead, so a cut switches
 * decoders instantly and the screen dissolves from the last frame.
 * Fast-forward: frames are blended into a short motion trail so 4× and 8×
 * look smooth rather than strobing.
 */
export class Player {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {Source} source
   * @param {() => Plan} getPlan
   * @param {() => Look} getLook
   */
  constructor(canvas, source, getPlan, getLook) {
    this.canvas = canvas;
    this.ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
    this.source = source;
    this.getPlan = getPlan;
    this.getLook = getLook;
    this.out = 0;
    this.playing = false;
    this.busy = false; // seeking across a cut
    this.rate = 1;
    /** A smoothed copy of the source clock, for drawing glides without jitter. */
    this.clock = 0;
    this.clockAt = 0;
    /** @type {(out: number) => void} */
    this.onTime = () => {};
    /** @type {() => void} */
    this.onEnd = () => {};
    /** @type {((jumping: boolean) => void) | undefined} */
    this.onJump = undefined;
    /** @type {GainNode | null} master volume */
    this.gain = null;
    /** @type {Map<HTMLVideoElement, GainNode>} one per decoder */
    this.elemGains = new Map();
    this.lastGain = -1;
    this.fadeStart = 0;
    /** @type {number | undefined} */
    this.lastSrc = undefined;
    /** @type {AudioBuffer | null} the decoded sound, once ready */
    this.buffer = null;
    /** @type {{node: AudioBufferSourceNode, g: GainNode, src0: number, src1: number, rate: number, when: number} | null} */
    this.voice = null;
    this.raf = 0;
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
    const vs = /** @type {any} */ (source);
    if ('onSwap' in vs) {
      vs.onSwap = (/** @type {HTMLVideoElement} */ now, /** @type {HTMLVideoElement} */ old) => {
        const t = this.actx?.currentTime ?? 0;
        this.elemGains.get(old)?.gain.setTargetAtTime(0, t, 0.01);
        this.elemGains.get(now)?.gain.setTargetAtTime(this.buffer ? 0 : 1, t, 0.01);
      };
    }
    // Start decoding the sound straight away, so it's ready by the first play.
    if (source.blob) this.audio();
  }

  /** Silence everything (used when Retake is shown inside Retake Studio). */
  mute() {
    this.muted = true;
    if (this.gain && this.actx) this.gain.gain.setValueAtTime(0, this.actx.currentTime);
  }

  /** Route the video's sound through Web Audio (needed for export, fades and fast-forward muting). */
  audio() {
    const els = this.source.elements?.() ?? (this.source.video ? [this.source.video] : []);
    if ((!els.length && !this.source.blob) || this.gain) return this.gain;
    const AC = window.AudioContext || /** @type {any} */ (window).webkitAudioContext;
    this.actx = new AC();
    this.gain = this.actx.createGain();
    for (const el of els) {
      const node = this.actx.createMediaElementSource(el);
      const g = this.actx.createGain();
      g.gain.value = el === this.source.video ? 1 : 0;
      node.connect(g).connect(this.gain);
      this.elemGains.set(el, g);
    }
    if (this.muted) this.gain.gain.value = 0;
    this.gain.connect(this.actx.destination);
    this.dest = this.actx.createMediaStreamDestination();
    this.gain.connect(this.dest);
    const blob = this.source.blob;
    if (blob) {
      const actx = this.actx;
      blob
        .arrayBuffer()
        .then((ab) => actx.decodeAudioData(ab))
        .then((buf) => {
          if (!buf || buf.duration < 0.3) return;
          this.buffer = buf;
          // From now on the elements are silent; the buffer carries the sound.
          for (const g of this.elemGains.values()) g.gain.setValueAtTime(0, actx.currentTime);
          this.gain?.gain.setValueAtTime(this.muted ? 0 : 1, actx.currentTime);
          if (this.playing && !this.busy) this.startVoice(this.source.time());
        })
        .catch(() => {});
    }
    return this.gain;
  }

  /**
   * The stretch of the edit around src that plays as one continuous sound:
   * contiguous segments at the same audible speed.
   * @param {number} src
   */
  run(src) {
    const segs = this.getPlan().segments;
    const i = segs.findIndex((g) => src >= g.src0 - 0.001 && src < g.src1);
    if (i < 0 || segs[i].rate > AUDIBLE_RATE) return null;
    const rate = segs[i].rate;
    let a = i, b = i;
    while (a > 0 && segs[a - 1].rate === rate && Math.abs(segs[a - 1].src1 - segs[a].src0) < 0.002) a--;
    while (b + 1 < segs.length && segs[b + 1].rate === rate && Math.abs(segs[b].src1 - segs[b + 1].src0) < 0.002) b++;
    return { src0: segs[a].src0, src1: segs[b].src1, rate };
  }

  /** Play the decoded sound from src to the end of its stretch, on the audio clock. @param {number} src */
  startVoice(src) {
    this.stopVoice();
    const buf = this.buffer, actx = this.actx;
    if (!buf || !actx || !this.gain || !this.playing) return;
    const r = this.run(src);
    if (!r) return;
    const from = Math.max(src, r.src0), to = Math.min(r.src1, buf.duration);
    if (to - from < 0.03) return;
    const node = actx.createBufferSource();
    node.buffer = buf;
    node.playbackRate.value = r.rate;
    const g = actx.createGain();
    node.connect(g).connect(this.gain);
    const when = actx.currentTime + 0.012;
    const at = (/** @type {number} */ t) => when + (t - from) / r.rate;
    const gp = g.gain;
    // Fade in (8ms), then the silenced commands, then fade out at a cut.
    const mutes = this.getPlan()
      .mutes.filter((m) => m.src1 > from && m.src0 < to)
      .sort((x, y) => x.src0 - y.src0);
    const startsMuted = mutes.length && mutes[0].src0 <= from;
    gp.setValueAtTime(0, when);
    if (!startsMuted) gp.linearRampToValueAtTime(1, when + 0.008);
    let last = when + 0.008;
    for (const m of mutes) {
      const a = Math.max(at(Math.max(m.src0, from)), last), b = Math.max(at(Math.min(m.src1, to)), a);
      if (m.src0 > from) {
        gp.setValueAtTime(1, Math.max(last, a - 0.015));
        gp.linearRampToValueAtTime(0, a);
      }
      gp.setValueAtTime(0, b);
      if (m.src1 < to) gp.linearRampToValueAtTime(1, b + 0.02);
      last = b + 0.02;
    }
    const end = at(to);
    if (end - 0.012 > last) {
      gp.setValueAtTime(1, end - 0.012);
      gp.linearRampToValueAtTime(0, end);
    }
    node.start(when, from, to - from);
    this.voice = { node, g, src0: from, src1: to, rate: r.rate, when };
    node.onended = () => {
      if (this.voice && this.voice.node === node) this.voice = null;
    };
  }

  /** Stop the sound with a short fade. */
  stopVoice() {
    const v = this.voice;
    if (!v || !this.actx) return;
    this.voice = null;
    const now = this.actx.currentTime;
    try {
      v.g.gain.cancelScheduledValues(now);
      v.g.gain.setValueAtTime(v.g.gain.value, now);
      v.g.gain.linearRampToValueAtTime(0, now + 0.008);
      v.node.stop(now + 0.012);
    } catch {
      /* already stopped */
    }
  }

  /**
   * Keep the sound with the picture: start it when a new stretch begins, and
   * restart it if the audio clock and the video have drifted apart.
   * @param {number} src the video's own time
   */
  syncVoice(src) {
    if (!this.buffer || !this.actx) return;
    const r = this.run(src);
    const v = this.voice;
    if (!r) return v && this.stopVoice();
    if (!v || src < v.src0 - 0.05 || src >= v.src1 - 0.005) return this.startVoice(src);
    const now = this.actx.currentTime;
    if (now < v.when + 0.25) return;
    const heard = v.src0 + (now - v.when) * v.rate;
    if (heard < v.src1 - 0.05 && Math.abs(heard - src) > 0.07) this.startVoice(src);
  }

  async play() {
    const plan = this.getPlan();
    if (this.out >= plan.outDuration - 0.05) await this.seekOut(0);
    this.audio();
    if (this.actx?.state === 'suspended') await this.actx.resume();
    const at = outToSrc(plan.segments, this.out);
    this.rate = at ? at.seg.rate : 1;
    this.applyRate();
    this.playing = true;
    this.clockAt = 0;
    await this.source.play(this.rate);
    this.startVoice(this.source.time());
  }

  pause() {
    this.playing = false;
    this.stopVoice();
    this.source.pause();
    this.source.camera?.sync(this.source.time(), false, this.rate);
  }

  applyRate() {
    this.source.setRate(this.rate);
    const g = this.wantGain(this.source.time());
    this.ramp(g, 0.03);
    this.lastGain = g;
  }

  /** Volume for this moment, from the plan. @param {number} src */
  wantGain(src) {
    return gainAt(this.getPlan(), src);
  }

  /** @param {number} o */
  async seekOut(o) {
    this.fadeStart = 0;
    this.lastSrc = undefined;
    this.trail = undefined;
    const plan = this.getPlan();
    const at = outToSrc(plan.segments, Math.max(0, Math.min(o, plan.outDuration)));
    if (!at) return;
    this.stopVoice();
    this.busy = true;
    await this.source.seek(at.src);
    this.busy = false;
    if (this.playing) this.startVoice(at.src);
    this.clock = at.src;
    this.clockAt = 0;
    this.out = srcToOut(plan.segments, at.src, plan.outDuration);
    this.rate = at.seg.rate;
    this.applyRate();
    this.paint();
    this.onTime(this.out);
  }

  loop() {
    this.raf = requestAnimationFrame(this.loop);
    this.step();
  }

  /** Advance the smoothed clock towards the source's own. */
  tickClock() {
    const now = performance.now();
    const raw = this.source.time();
    if (this.playing && this.clockAt && !this.source.tick) {
      const pred = this.clock + ((now - this.clockAt) / 1000) * this.rate;
      this.clock = Math.abs(raw - pred) > 0.12 ? raw : pred + (raw - pred) * 0.2;
    } else this.clock = raw;
    this.clockAt = now;
    return raw;
  }

  step() {
    this.source.tick?.();
    if (this.busy) {
      this.source.camera?.sync(this.source.time(), false, this.rate);
      return;
    }
    const plan = this.getPlan();
    if (this.playing) {
      const src = this.tickClock();
      const segs = plan.segments;
      const seg = segmentAt(segs, src);
      if (!seg || src >= this.source.duration - 0.03) {
        this.pause();
        this.out = plan.outDuration;
        this.paint();
        this.onTime(this.out);
        this.onEnd();
        return;
      }
      if (src < seg.src0 - 0.04) {
        // Already past the cut point (a slow frame): jump now.
        this.jumpTo(seg);
        return;
      }
      const next = segs[segs.indexOf(seg) + 1];
      if (next && next.src0 > seg.src1 + 0.04) {
        if (seg.src1 - src < 1.5) this.source.prime?.(next.src0);
        if (src >= seg.src1 - 0.02) {
          this.jumpTo(next);
          return;
        }
      }
      if (seg.rate !== this.rate) {
        this.rate = seg.rate;
        this.source.setRate(this.rate);
      }
      this.syncVoice(src);
      // Fade the sound for silenced commands, fast-forwards and cut edges.
      const g = this.wantGain(src);
      if (g !== this.lastGain) {
        this.ramp(g, g ? 0.04 : 0.02);
        this.lastGain = g;
      }
      // A pause in the recording is a join in the footage: dissolve across it.
      const last = this.lastSrc ?? src;
      if (plan.joins.some((j) => last < j && src >= j)) this.snapshot(), (this.fadeStart = performance.now());
      this.lastSrc = src;
      this.out = srcToOut(segs, src, plan.outDuration);
      this.onTime(this.out);
    }
    this.paint();
  }

  /** Cut to where the next segment starts: switch decoders if one is ready, else seek. @param {import('./plan.js').Segment} seg */
  jumpTo(seg) {
    this.snapshot();
    this.stopVoice();
    this.ramp(0, 0.012);
    this.lastGain = 0;
    const landed = () => {
      this.fadeStart = performance.now();
      this.lastSrc = seg.src0;
      this.clock = seg.src0;
      this.clockAt = 0;
      this.rate = seg.rate;
      this.source.setRate(seg.rate);
      const g = this.wantGain(seg.src0 + 0.01);
      this.ramp(g, 0.04);
      this.lastGain = g;
      this.startVoice(seg.src0);
    };
    if (this.source.canSwap?.(seg.src0) && this.source.swap) {
      this.source.swap(seg.rate);
      landed();
      return;
    }
    this.busy = true;
    this.onJump?.(true);
    this.source.seek(seg.src0).then(() => {
      this.busy = false;
      landed();
      this.onJump?.(false);
    });
  }

  /** Remember the current frame for a crossfade. */
  snapshot() {
    const c = (this.fadeCanvas = this.fadeCanvas || document.createElement('canvas'));
    c.width = this.canvas.width;
    c.height = this.canvas.height;
    /** @type {CanvasRenderingContext2D} */ (c.getContext('2d')).drawImage(this.scene || this.canvas, 0, 0);
    this.fadeStart = 0;
  }

  /** Smoothly move the volume, avoiding clicks. @param {number} to @param {number} tc */
  ramp(to, tc) {
    // With decoded sound the master stays open; each stretch has its own envelope.
    if (!this.gain || !this.actx || this.buffer || this.muted) return;
    const g = this.gain.gain;
    const now = this.actx.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.setTargetAtTime(to, now, tc);
  }

  paint() {
    const plan = this.getPlan();
    const src = this.playing ? this.clock : this.source.time();
    this.source.camera?.sync(this.source.time(), this.playing, this.rate);
    const cam = this.source.camera && this.source.camera.width ? this.source.camera : null;
    const out = srcToOut(plan.segments, src, plan.outDuration);
    drawFrame(this.ctx, this.canvas.width, this.canvas.height, this.source, plan, src, out, this.rate, this.getLook(), cam, (ctx) => this.blendScene(ctx));
  }

  /**
   * Effects on the screen layer only (before the camera bubble, cards and
   * captions are drawn on top): the fast-forward motion trail and the dissolve
   * across a cut. Keeps a copy of the finished screen layer for the next cut.
   * @param {CanvasRenderingContext2D} ctx
   */
  blendScene(ctx) {
    const W = this.canvas.width, H = this.canvas.height;
    const sized = (/** @type {HTMLCanvasElement | undefined} */ c) => {
      const el = c || document.createElement('canvas');
      if (el.width !== W || el.height !== H) (el.width = W), (el.height = H);
      return el;
    };
    // Fast-forward: blend in the last frame for a motion trail.
    if (this.playing && this.rate >= 2) {
      const fresh = !this.trail || this.trail.width !== W || this.trail.height !== H;
      const t = (this.trail = sized(this.trail));
      if (!fresh) {
        ctx.save();
        ctx.globalAlpha = Math.min(0.55, 0.18 * Math.log2(this.rate) + 0.12);
        ctx.drawImage(t, 0, 0);
        ctx.restore();
      }
      /** @type {CanvasRenderingContext2D} */ (t.getContext('2d')).drawImage(this.canvas, 0, 0);
    } else this.trail = undefined;
    // Crossfade from the screen as it was before the cut.
    if (this.fadeStart && this.fadeCanvas) {
      const k = (performance.now() - this.fadeStart) / 420;
      if (k < 1) {
        ctx.save();
        ctx.globalAlpha = 1 - k * k * (3 - 2 * k); // smoothstep dissolve
        ctx.drawImage(this.fadeCanvas, 0, 0);
        ctx.restore();
      } else this.fadeStart = 0;
    }
    this.scene = sized(this.scene);
    /** @type {CanvasRenderingContext2D} */ (this.scene.getContext('2d')).drawImage(this.canvas, 0, 0);
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.pause();
    this.buffer = null;
    this.actx?.close();
  }
}

/** The best format this browser can record a canvas to. */
export function exportFormat() {
  const options = [
    // H.264 MP4 plays everywhere (WhatsApp, QuickTime, LinkedIn); otherwise WebM.
    ['video/mp4;codecs=avc1.42E01F,mp4a.40.2', 'mp4'],
    ['video/mp4;codecs=avc1.42E01F', 'mp4'],
    ['video/webm;codecs=vp9,opus', 'webm'],
    ['video/webm;codecs=vp8,opus', 'webm'],
    ['video/webm', 'webm'],
  ];
  for (const [mime, ext] of options) if (window.MediaRecorder?.isTypeSupported?.(mime)) return { mime, ext };
  return null;
}

/**
 * Render the finished video in real time.
 * @param {Player} player
 * @param {(fraction: number) => void} onProgress
 * @param {{signal?: AbortSignal}} [opts]
 * @returns {Promise<{blob: Blob, ext: string}>}
 */
export async function exportVideo(player, onProgress, opts = {}) {
  const fmt = exportFormat();
  if (!fmt) throw new Error('This browser cannot record video. Use Chrome or Edge on a computer.');
  const plan = player.getPlan();
  const stream = player.canvas.captureStream(30);
  player.audio();
  if (player.actx?.state === 'suspended') await player.actx.resume();
  for (const tr of player.dest?.stream.getAudioTracks() ?? []) stream.addTrack(tr);

  const rec = new MediaRecorder(stream, { mimeType: fmt.mime, videoBitsPerSecond: 8_000_000 });
  /** @type {Blob[]} */
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = new Promise((res) => (rec.onstop = res));

  await player.seekOut(0);
  const prevTime = player.onTime, prevEnd = player.onEnd;
  player.onJump = (jumping) => {
    // Don't record the frozen frame while the video seeks across a cut.
    if (jumping && rec.state === 'recording') rec.pause();
    if (!jumping && rec.state === 'paused') rec.resume();
  };
  const finished = new Promise((res) => {
    player.onEnd = () => res(undefined);
    player.onTime = (o) => {
      prevTime(o);
      onProgress(Math.min(1, o / plan.outDuration));
    };
  });
  rec.start(500);
  await player.play();
  const abort = new Promise((res) => opts.signal?.addEventListener('abort', () => res('abort')));
  const how = await Promise.race([finished, abort]);
  player.pause();
  await new Promise((r) => setTimeout(r, 250));
  rec.stop();
  await stopped;
  player.onTime = prevTime;
  player.onEnd = prevEnd;
  player.onJump = undefined;
  for (const tr of stream.getVideoTracks()) tr.stop();
  if (how === 'abort') throw new DOMException('Export cancelled', 'AbortError');
  return { blob: new Blob(chunks, { type: fmt.mime.split(';')[0] }), ext: fmt.ext };
}
