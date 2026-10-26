// @ts-check
/**
 * Playback of a take through its plan: skips the cuts, plays fast-forwards
 * at speed, and draws every frame with the renderer. The export is the same
 * loop running onto a recorded canvas.
 */
import { segmentAt, srcToOut, outToSrc } from './plan.js';
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

/** A recorded video file. */
export class VideoSource {
  /** @param {Blob} blob @param {number} knownDuration */
  constructor(blob, knownDuration) {
    const v = document.createElement('video');
    v.playsInline = true;
    v.preload = 'auto';
    v.src = URL.createObjectURL(blob);
    /** @type {any} */ (v).preservesPitch = true;
    this.video = v;
    this.frame = v;
    this.duration = knownDuration;
    this.width = 1280;
    this.height = 720;
  }

  async ready() {
    const v = this.video;
    await new Promise((res, rej) => {
      v.onloadedmetadata = () => res(undefined);
      v.onerror = () => rej(new Error('This recording could not be opened.'));
    });
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
  }
  /** @param {number} rate */
  setRate(rate) {
    this.video.playbackRate = rate;
  }
  /** @param {number} t */
  seek(t) {
    const v = this.video;
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
    /** @type {(out: number) => void} */
    this.onTime = () => {};
    /** @type {() => void} */
    this.onEnd = () => {};
    /** @type {GainNode | null} */
    this.gain = null;
    this.raf = 0;
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }

  /** Route the video's sound through Web Audio (needed for export and fast-forward muting). */
  audio() {
    const v = this.source.video;
    if (!v || this.gain) return this.gain;
    const AC = window.AudioContext || /** @type {any} */ (window).webkitAudioContext;
    this.actx = new AC();
    const node = this.actx.createMediaElementSource(v);
    this.gain = this.actx.createGain();
    node.connect(this.gain);
    this.gain.connect(this.actx.destination);
    this.dest = this.actx.createMediaStreamDestination();
    this.gain.connect(this.dest);
    return this.gain;
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
    await this.source.play(this.rate);
  }

  pause() {
    this.playing = false;
    this.source.pause();
    this.source.camera?.sync(this.source.time(), false, this.rate);
  }

  applyRate() {
    this.source.setRate(this.rate);
    this.ramp(this.rate > 1 ? 0 : 1, 0.03);
  }

  /** @param {number} o */
  async seekOut(o) {
    this.fadeStart = 0;
    const plan = this.getPlan();
    const at = outToSrc(plan.segments, Math.max(0, Math.min(o, plan.outDuration)));
    if (!at) return;
    this.busy = true;
    await this.source.seek(at.src);
    this.busy = false;
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

  step() {
    this.source.tick?.();
    if (this.busy) {
      this.source.camera?.sync(this.source.time(), false, this.rate);
      return;
    }
    const plan = this.getPlan();
    if (this.playing) {
      const src = this.source.time();
      const seg = segmentAt(plan.segments, src);
      if (!seg || src >= this.source.duration - 0.03) {
        this.pause();
        this.out = plan.outDuration;
        this.paint();
        this.onTime(this.out);
        this.onEnd();
        return;
      }
      if (src < seg.src0 - 0.04) {
        // We're inside a cut: jump to where the video resumes. Keep the last
        // frame and dissolve from it, and dip the sound, so the cut is smooth.
        this.busy = true;
        this.snapshot();
        this.ramp(0, 0.015);
        this.onJump?.(true);
        this.source.seek(seg.src0).then(() => {
          this.busy = false;
          this.fadeStart = performance.now();
          this.ramp(this.rate > 1 ? 0 : 1, 0.04);
          this.onJump?.(false);
        });
        return;
      }
      if (seg.rate !== this.rate) {
        this.rate = seg.rate;
        this.applyRate();
      }
      this.out = srcToOut(plan.segments, src, plan.outDuration);
      this.onTime(this.out);
    }
    this.paint();
  }

  /** Remember the current frame for a crossfade. */
  snapshot() {
    const c = (this.fadeCanvas = this.fadeCanvas || document.createElement('canvas'));
    c.width = this.canvas.width;
    c.height = this.canvas.height;
    /** @type {CanvasRenderingContext2D} */ (c.getContext('2d')).drawImage(this.canvas, 0, 0);
    this.fadeStart = 0;
  }

  /** Smoothly move the volume, avoiding clicks at cuts. @param {number} to @param {number} tc */
  ramp(to, tc) {
    if (!this.gain || !this.actx) return;
    const g = this.gain.gain;
    g.cancelScheduledValues(this.actx.currentTime);
    g.setTargetAtTime(to, this.actx.currentTime, tc);
  }

  paint() {
    const plan = this.getPlan();
    const src = this.source.time();
    this.source.camera?.sync(src, this.playing, this.rate);
    const cam = this.source.camera && this.source.camera.width ? this.source.camera : null;
    drawFrame(this.ctx, this.canvas.width, this.canvas.height, this.source, plan, src, this.out, this.rate, this.getLook(), cam);
    // Crossfade from the frame before the cut.
    if (this.fadeStart && this.fadeCanvas) {
      const a = 1 - (performance.now() - this.fadeStart) / 320;
      if (a > 0) {
        this.ctx.save();
        this.ctx.globalAlpha = a * a;
        this.ctx.drawImage(this.fadeCanvas, 0, 0);
        this.ctx.restore();
      } else this.fadeStart = 0;
    }
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.pause();
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
