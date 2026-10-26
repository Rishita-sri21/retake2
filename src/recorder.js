// @ts-check
/**
 * Records a take: the screen, your voice, what you said (with timing), how
 * loud you were, and where the screen changed. Everything stays in the
 * browser; nothing is uploaded.
 */
import { GRID_W, GRID_H, toGrid, diff } from './motion.js';
import { parseCommands } from './commands.js';

/** @typedef {import('./commands.js').Phrase} Phrase */
/** @typedef {import('./commands.js').Command} Command */
/** @typedef {import('./motion.js').MotionSample} MotionSample */

/**
 * @typedef {Object} RawTake
 * @property {'recording'} kind
 * @property {Blob} blob
 * @property {string} mime
 * @property {number} duration
 * @property {number} width
 * @property {number} height
 * @property {Phrase[]} phrases
 * @property {{dt: number, values: Float32Array}} levels
 * @property {number} levelThreshold
 * @property {MotionSample[]} motion
 * @property {{t: number, url: string}[]} thumbs
 * @property {string} lang
 * @property {string} createdAt
 * @property {Blob | null} camBlob     Webcam recording, if the camera was on.
 * @property {number} camOffset        Seconds the camera started after the screen.
 * @property {boolean} hasCamera
 * @property {number[]} joins
 * @property {{t: number, x: number, y: number}[]} camPath
 */

/**
 * @typedef {Object} RecorderEvents
 * @property {(text: string) => void} [onInterim]
 * @property {(phrase: Phrase) => void} [onPhrase]
 * @property {(cmd: Command) => void} [onCommand]
 * @property {(level: number) => void} [onLevel]
 * @property {() => void} [onEnded]  The user stopped sharing from the browser bar.
 * @property {(msg: string) => void} [onWarn]
 * @property {(paused: boolean) => void} [onPauseChange]  "pause" / "resume" heard.
 * @property {() => void} [onStopRequested]  "stop recording" heard.
 */

const LEVEL_DT = 0.05;
const MOTION_EVERY = 0.2;
const THUMB_EVERY = 4;

const WORKLET = `
class Level extends AudioWorkletProcessor {
  constructor() { super(); this.sum = 0; this.n = 0; this.size = Math.round(sampleRate * ${LEVEL_DT}); }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.sum += ch[i] * ch[i];
        if (++this.n >= this.size) {
          this.port.postMessage({ rms: Math.sqrt(this.sum / this.n), t: currentTime });
          this.sum = 0; this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('retake-level', Level);
`;

/** Which recording format this browser supports. */
function recordingMime() {
  for (const m of ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
}

export function canRecord() {
  return Boolean(navigator.mediaDevices?.getDisplayMedia && window.MediaRecorder);
}

export function canTranscribe() {
  return Boolean(/** @type {any} */ (window).SpeechRecognition || /** @type {any} */ (window).webkitSpeechRecognition);
}

export class Recorder {
  /** @param {RecorderEvents} events */
  constructor(events) {
    this.ev = events;
    /** @type {Phrase[]} */
    this.phrases = [];
    /** @type {number[]} */
    this.levelValues = [];
    /** @type {MotionSample[]} */
    this.motion = [];
    /** @type {{t: number, url: string}[]} */
    this.thumbs = [];
    this.t0 = 0;
    this.running = false;
    this.paused = false;
    this.pauseAt = 0;
    this.pausedTotal = 0;
    /** @type {number[]} where the recording was paused */
    this.joins = [];
    /** @type {{t: number, x: number, y: number}[]} where the floating bubble was */
    this.camPath = [];
    /** @type {MediaStream[]} */
    this.streams = [];
  }

  /** Seconds since recording started. */
  now() {
    if (!this.running) return 0;
    const at = this.paused ? this.pauseAt : performance.now();
    return (at - this.t0 - (this.pausedTotal || 0)) / 1000;
  }

  /** Pause: nothing is recorded until resume(). */
  pause() {
    if (!this.running || this.paused) return;
    this.rec?.pause();
    this.camRec?.pause();
    this.joins.push(this.now());
    this.pauseAt = performance.now();
    this.paused = true;
    this.ev.onPauseChange?.(true);
  }

  resume() {
    if (!this.running || !this.paused) return;
    const gap = performance.now() - this.pauseAt;
    this.pausedTotal = (this.pausedTotal || 0) + gap;
    this.audioT0 += gap / 1000; // the audio clock kept running while paused
    this.rec?.resume();
    this.camRec?.resume();
    this.paused = false;
    this.ev.onPauseChange?.(false);
  }

  /**
   * Ask for the screen, mic and camera, and start listening. Recording itself
   * starts with begin(), after the countdown, so the listener is already warm
   * and your first words ("big camera") are heard.
   * @param {{lang: string, systemAudio: boolean, camera: boolean}} opts
   */
  async prepare(opts) {
    this.lang = opts.lang;
    const display = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30 }, width: { max: 1920 }, height: { max: 1080 } },
      audio: opts.systemAudio,
      // @ts-ignore newer capture hints, ignored where unsupported
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
      systemAudio: opts.systemAudio ? 'include' : 'exclude',
    });
    this.streams.push(display);
    /** @type {MediaStream} */
    let mic;
    try {
      mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      display.getTracks().forEach((t) => t.stop());
      throw new Error('Retake needs your microphone to hear your directions. Allow it and try again.');
    }
    this.streams.push(mic);

    // Optional webcam, recorded separately so the bubble can be moved,
    // resized or hidden in the editor without re-recording.
    /** @type {MediaStream | null} */
    let cam = null;
    if (opts.camera) {
      try {
        cam = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' } });
        this.streams.push(cam);
      } catch {
        this.ev.onWarn?.('Camera not available, so recording without the bubble.');
      }
    }

    const video = display.getVideoTracks()[0];
    video.addEventListener('ended', () => this.ev.onEnded?.());
    const settings = video.getSettings();
    this.width = settings.width || 1280;
    /** 'monitor' when the whole screen is shared: then the floating bubble's position can be tracked. */
    this.surface = /** @type {any} */ (settings).displaySurface || '';
    this.height = settings.height || 720;

    // Mix mic (+ shared tab/system audio) into one track, and meter the mic.
    const actx = new AudioContext();
    this.actx = actx;
    const mix = actx.createMediaStreamDestination();
    const micNode = actx.createMediaStreamSource(mic);
    micNode.connect(mix);
    if (display.getAudioTracks().length) {
      const sys = actx.createMediaStreamSource(new MediaStream(display.getAudioTracks()));
      const g = actx.createGain();
      g.gain.value = 0.8;
      sys.connect(g).connect(mix);
    }
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
    await actx.audioWorklet.addModule(url);
    const meter = new AudioWorkletNode(actx, 'retake-level');
    micNode.connect(meter);
    const sink = actx.createGain();
    sink.gain.value = 0;
    meter.connect(sink).connect(actx.destination);
    meter.port.onmessage = (e) => {
      this.ev.onLevel?.(e.data.rms);
      if (!this.running || this.paused) return;
      const t = e.data.t - this.audioT0;
      const i = Math.floor(t / LEVEL_DT);
      if (i >= 0) this.levelValues[i] = e.data.rms;
    };

    /** Your camera, for the live preview on the slate. */
    this.camStream = cam;
    this.prep = { video, mix, cam, actx };
    this.startSpeech();
  }

  /** Start recording (after the countdown). */
  async begin() {
    const { video, mix, cam, actx } = /** @type {any} */ (this.prep);
    this.mime = recordingMime();
    const stream = new MediaStream([video, ...mix.stream.getAudioTracks()]);
    this.rec = new MediaRecorder(stream, { mimeType: this.mime, videoBitsPerSecond: 6_000_000 });
    /** @type {Blob[]} */
    this.chunks = [];
    this.rec.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    const started = new Promise((res) => (/** @type {MediaRecorder} */ (this.rec).onstart = res));
    /** @type {Promise<unknown> | null} */
    let camStarted = null;
    if (cam) {
      const camMime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'].find((m) => MediaRecorder.isTypeSupported(m)) || '';
      this.camRec = new MediaRecorder(cam, { mimeType: camMime, videoBitsPerSecond: 1_500_000 });
      /** @type {Blob[]} */
      this.camChunks = [];
      this.camRec.ondataavailable = (e) => e.data.size && this.camChunks?.push(e.data);
      camStarted = new Promise((res) => {
        /** @type {MediaRecorder} */ (this.camRec).onstart = () => {
          this.camT0 = performance.now();
          res(undefined);
        };
      });
      this.camRec.start(1000);
    }
    this.rec.start(1000);
    await started;
    if (camStarted) await camStarted;
    this.t0 = performance.now();
    this.audioT0 = actx.currentTime;
    this.running = true;

    this.startMotion(video);
  }

  /** Give up before recording started (the countdown was cancelled). */
  cancel() {
    this.listening = false;
    try {
      this.speech?.stop();
    } catch {
      /* ignore */
    }
    for (const st of this.streams) st.getTracks().forEach((t) => t.stop());
    this.actx?.close();
  }

  /** Sample the screen 5× a second into a tiny grid; keep a filmstrip. */
  startMotion(/** @type {MediaStreamTrack} */ track) {
    const SW = GRID_W * 5, SH = GRID_H * 5;
    const small = document.createElement('canvas');
    small.width = SW;
    small.height = SH;
    const sctx = /** @type {CanvasRenderingContext2D} */ (small.getContext('2d', { willReadFrequently: true }));
    const thumb = document.createElement('canvas');
    thumb.width = 192;
    thumb.height = 108;
    const tctx = /** @type {CanvasRenderingContext2D} */ (thumb.getContext('2d'));
    /** @type {Uint8Array | null} */
    let prev = null;
    let nextSample = 0, nextThumb = 0;

    /** @param {CanvasImageSource} img */
    const sample = (img) => {
      if (this.paused) return;
      const t = this.now();
      if (t >= nextSample) {
        nextSample = t + MOTION_EVERY;
        sctx.drawImage(img, 0, 0, SW, SH);
        const grid = toGrid(sctx.getImageData(0, 0, SW, SH).data, SW, SH);
        if (prev) {
          const d = diff(prev, grid);
          this.motion.push({ t, changed: d.changed, count: d.count });
        }
        prev = grid;
      }
      if (t >= nextThumb) {
        nextThumb = t + THUMB_EVERY;
        tctx.drawImage(img, 0, 0, 192, 108);
        this.thumbs.push({ t, url: thumb.toDataURL('image/jpeg', 0.6) });
      }
    };

    // Frame callbacks keep working when this tab is in the background; timers don't.
    const MSTP = /** @type {any} */ (window).MediaStreamTrackProcessor;
    if (MSTP) {
      const reader = new MSTP({ track: track.clone() }).readable.getReader();
      this.motionReader = reader;
      (async () => {
        while (this.running) {
          const { value: frame, done } = await reader.read();
          if (done) break;
          try {
            sample(frame);
          } finally {
            frame.close();
          }
        }
      })().catch(() => {});
    } else {
      const v = document.createElement('video');
      v.muted = true;
      v.srcObject = new MediaStream([track]);
      v.play().catch(() => {});
      this.motionTimer = setInterval(() => v.readyState >= 2 && sample(v), MOTION_EVERY * 1000);
    }
  }

  /** Live speech recognition with phrase start/end times. */
  startSpeech() {
    const SR = /** @type {any} */ (window).SpeechRecognition || /** @type {any} */ (window).webkitSpeechRecognition;
    if (!SR) {
      this.ev.onWarn?.('This browser has no speech recognition. Use Chrome or Edge to direct by voice.');
      return;
    }
    /** @type {Map<number, number>} first time each result index was heard */
    let firstSeen = new Map();
    this.listening = true;
    const open = () => {
      const r = new SR();
      r.lang = this.lang;
      r.continuous = true;
      r.interimResults = true;
      firstSeen = new Map();
      r.onresult = (/** @type {any} */ e) => {
        const t = this.now();
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          if (!firstSeen.has(i)) firstSeen.set(i, t);
          const res = e.results[i];
          const text = res[0].transcript.trim();
          if (!text) continue;
          if (res.isFinal) {
            // Recognition reports the first words ~0.5s after they were spoken.
            const start = Math.max(0, /** @type {number} */ (firstSeen.get(i)) - 0.6);
            const phrase = { text, start, end: t };
            const cmds = parseCommands([phrase]);
            if (this.paused) {
              // While paused, only listen for "resume" or "stop"; nothing else is kept.
              if (cmds.some((c) => c.type === 'resume')) this.resume();
              if (cmds.some((c) => c.type === 'stop')) this.ev.onStopRequested?.();
              continue;
            }
            this.phrases.push(phrase);
            this.ev.onPhrase?.(phrase);
            for (const c of cmds) this.ev.onCommand?.(c);
            if (cmds.some((c) => c.type === 'pause')) this.pause();
            if (cmds.some((c) => c.type === 'stop')) this.ev.onStopRequested?.();
          } else interim += ` ${text}`;
        }
        this.ev.onInterim?.(interim.trim());
      };
      r.onerror = (/** @type {any} */ e) => {
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
          this.ev.onWarn?.('Speech recognition was blocked, so voice directions won’t work. The video is still recording.');
          this.speechBlocked = true;
        } else if (e.error === 'network') {
          this.ev.onWarn?.('Speech recognition needs an internet connection.');
        }
      };
      r.onend = () => {
        if (this.listening && !this.speechBlocked) setTimeout(open, 100);
      };
      try {
        r.start();
      } catch {
        /* already running */
      }
      this.speech = r;
    };
    open();
  }

  /** @returns {Promise<RawTake>} */
  async stop() {
    if (this.paused) {
      // Stopping while paused: end the video at the pause.
      this.rec?.resume();
      this.camRec?.resume();
    }
    const duration = this.now();
    this.running = false;
    this.listening = false;
    try {
      this.speech?.stop();
    } catch {
      /* ignore */
    }
    if (this.motionTimer) clearInterval(this.motionTimer);
    this.motionReader?.cancel().catch(() => {});
    const rec = /** @type {MediaRecorder} */ (this.rec);
    const done = new Promise((res) => (rec.onstop = res));
    if (rec.state !== 'inactive') rec.stop();
    await done;
    /** @type {Blob | null} */
    let camBlob = null;
    const camRec = this.camRec;
    if (camRec) {
      const camDone = new Promise((res) => (camRec.onstop = res));
      if (camRec.state !== 'inactive') camRec.stop();
      await camDone;
      camBlob = new Blob(/** @type {Blob[]} */ (this.camChunks), { type: (camRec.mimeType || 'video/webm').split(';')[0] });
    }
    for (const s of this.streams) s.getTracks().forEach((t) => t.stop());
    this.actx?.close();

    const n = Math.ceil(duration / LEVEL_DT);
    const values = new Float32Array(n);
    for (let i = 0; i < n; i++) values[i] = this.levelValues[i] ?? 0;

    return {
      kind: 'recording',
      blob: new Blob(/** @type {Blob[]} */ (this.chunks), { type: (this.mime || 'video/webm').split(';')[0] }),
      mime: this.mime || 'video/webm',
      duration,
      width: this.width || 1280,
      height: this.height || 720,
      phrases: this.phrases.sort((a, b) => a.start - b.start),
      levels: { dt: LEVEL_DT, values },
      levelThreshold: speechThreshold(values),
      motion: this.motion,
      thumbs: this.thumbs,
      lang: this.lang || 'en-IN',
      createdAt: new Date().toISOString(),
      camBlob,
      // The screen clock starts when its recorder starts; the camera's may differ slightly.
      camOffset: camBlob && this.camT0 ? (this.camT0 - this.t0) / 1000 : 0,
      hasCamera: Boolean(camBlob),
      joins: this.joins,
      camPath: this.camPath,
    };
  }
}

/**
 * A loudness threshold that separates this speaker's voice from this room's
 * background noise, from the recording's own levels.
 * @param {ArrayLike<number>} values
 */
export function speechThreshold(values) {
  const sorted = Array.from(values).filter((v) => v > 0).sort((a, b) => a - b);
  if (sorted.length < 20) return 0.02;
  const q = (/** @type {number} */ p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  const floor = q(0.15), voice = q(0.9);
  return Math.max(0.004, floor + (voice - floor) * 0.22);
}
