// @ts-check
/**
 * The sample take: a 72-second screen recording of a developer building a
 * weather dashboard, drawn procedurally so the app can show it anywhere
 * without a video file, with the narration that went with it.
 *
 * It contains everything a real demo goes wrong with: dead air at the start,
 * a 20-second npm install, an API key pasted on screen, a fumbled sentence,
 * and a chart too small to read. The narration directs Retake to fix each one.
 *
 * The screen-motion log is computed from the drawn frames by the same code
 * that analyses a real recording; nothing about the edit is pre-baked.
 */
import { GRID_W, GRID_H, toGrid, diff } from './motion.js';

export const SAMPLE_W = 1280;
export const SAMPLE_H = 720;
export const SAMPLE_DURATION = 72;

/** @type {import('./commands.js').Phrase[]} */
export const SAMPLE_PHRASES = [
  { text: 'Title: a weather dashboard in five minutes', start: 1.8, end: 4.3 },
  { text: 'small camera', start: 4.6, end: 5.3 },
  { text: 'Chapter one, setup', start: 5.7, end: 6.6 },
  { text: 'First we install the dependencies with npm install', start: 7.0, end: 10.6 },
  { text: 'speed this up', start: 11.2, end: 12.4 },
  { text: 'back to normal speed', start: 31.6, end: 32.8 },
  { text: 'Now I paste my weather API key into the env file', start: 33.3, end: 37.0 },
  { text: 'hide that', start: 38.0, end: 39.0 },
  { text: 'Chapter two, the dashboard', start: 40.0, end: 41.4 },
  { text: 'Then we fetch the forecast and draw the uh, the graph thing', start: 42.0, end: 46.0 },
  { text: 'scratch that', start: 46.5, end: 47.5 },
  { text: 'Then we fetch the forecast and draw it as a chart', start: 48.0, end: 52.0 },
  { text: 'zoom here', start: 52.6, end: 53.6 },
  { text: 'The chart updates live when you switch cities', start: 54.0, end: 59.0 },
  { text: 'zoom out', start: 59.6, end: 60.6 },
  { text: "And it's deployed at this address", start: 61.0, end: 63.6 },
  { text: 'look here', start: 64.0, end: 65.0 },
  { text: 'big camera', start: 65.3, end: 65.9 },
  { text: "That's the whole app in under a hundred lines", start: 66.2, end: 69.2 },
];

const C = {
  bg: '#16171c',
  chrome: '#1f2027',
  panel: '#1b1c22',
  line: '#2b2d36',
  text: '#d8dae3',
  dim: '#7c8191',
  key: '#f5a35c',
  str: '#9ad37a',
  fn: '#7cb7ff',
  kw: '#d690ff',
  green: '#5fd38d',
  white: '#f4f5f8',
  page: '#f7f8fb',
  ink: '#1b2030',
  bar: '#3d6bff',
  bar2: '#9bb3ff',
};

const MONO = '"DM Mono", ui-monospace, Menlo, Consolas, monospace';
const SANS = '"Nunito", system-ui, sans-serif';

/** Characters of `s` typed between t0 and t1. @param {string} s @param {number} t @param {number} t0 @param {number} t1 */
function typed(s, t, t0, t1) {
  if (t <= t0) return '';
  if (t >= t1) return s;
  return s.slice(0, Math.floor((s.length * (t - t0)) / (t1 - t0)));
}

const FORECAST = {
  Mumbai: [31, 32, 30, 29, 31, 33, 32],
  Delhi: [24, 27, 29, 30, 28, 26, 25],
  Bengaluru: [26, 25, 27, 28, 27, 26, 24],
};

/**
 * Draw the screen at time t into a W×H context.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} t
 * @param {number} W
 * @param {number} H
 */
export function drawSample(ctx, t, W, H) {
  ctx.save();
  ctx.scale(W / SAMPLE_W, H / SAMPLE_H);
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, SAMPLE_W, SAMPLE_H);

  // Window chrome
  ctx.fillStyle = C.chrome;
  ctx.fillRect(0, 0, SAMPLE_W, 34);
  for (const [i, col] of ['#ff5f57', '#febc2e', '#28c840'].entries()) {
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(20 + i * 20, 17, 6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = C.dim;
  ctx.font = `13px ${SANS}`;
  ctx.fillText('weather-dashboard — Code', 560, 22);

  // ---------------------------------------------------------- editor (left)
  const EX = 0, EY = 34, EW = 660, EH = 430;
  ctx.fillStyle = C.panel;
  ctx.fillRect(EX, EY, EW, EH);
  const envTab = t >= 33 && t < 40.5;
  const tabs = [
    { name: '.env', active: envTab },
    { name: 'app.js', active: !envTab },
  ];
  tabs.forEach((tab, i) => {
    ctx.fillStyle = tab.active ? C.bg : C.chrome;
    ctx.fillRect(EX + i * 120, EY, 118, 32);
    ctx.fillStyle = tab.active ? C.text : C.dim;
    ctx.font = `13px ${SANS}`;
    ctx.fillText(tab.name, EX + 16 + i * 120, EY + 21);
  });

  ctx.font = `15px ${MONO}`;
  const lineH = 24;
  /** @type {[string, string][][]} */
  let code;
  if (envTab) {
    const key = typed('OPENWEATHER_KEY=sk_live_7Hq2xV9dLmR4tWb81ZcNp6', t, 36.0, 36.4);
    code = [
      [['# Weather API', C.dim]],
      [[key.split('=')[0] ?? '', C.key], [key.includes('=') ? `=${key.split('=')[1]}` : '', C.str]],
      [['PORT', C.key], ['=5173', C.str]],
    ];
  } else {
    const wrong = t >= 43 && t < 46.6 ? typed('drawGraphThing(data, ', t, 43, 45.5) : '';
    const right = typed('drawChart(canvas, days);', t, 48.6, 50);
    code = [
      [['import', C.kw], [' { fetchForecast } ', C.text], ['from', C.kw], [" './api.js'", C.str]],
      [['import', C.kw], [' { drawChart } ', C.text], ['from', C.kw], [" './chart.js'", C.str]],
      [['', C.text]],
      [['const', C.kw], [' city = ', C.text], ["'Mumbai'", C.str]],
      [['const', C.kw], [' days = ', C.text], ['await', C.kw], [' fetchForecast', C.fn], ['(city)', C.text]],
      [[wrong || right, wrong ? C.text : C.fn]],
      [['', C.text]],
      [['citySelect', C.text], ['.', C.text], ['onchange', C.fn], [' = ', C.text], ['render', C.fn]],
    ];
  }
  code.forEach((parts, i) => {
    ctx.fillStyle = C.dim;
    ctx.fillText(String(i + 1).padStart(2, ' '), EX + 14, EY + 64 + i * lineH);
    let x = EX + 52;
    for (const [s, col] of parts) {
      ctx.fillStyle = col;
      ctx.fillText(s, x, EY + 64 + i * lineH);
      x += ctx.measureText(s).width;
    }
  });

  // ---------------------------------------------------------- terminal (bottom left)
  const TX = 0, TY = EY + EH, TW = 660, TH = SAMPLE_H - TY;
  ctx.fillStyle = '#121318';
  ctx.fillRect(TX, TY, TW, TH);
  ctx.fillStyle = C.dim;
  ctx.font = `12px ${SANS}`;
  ctx.fillText('TERMINAL', TX + 16, TY + 22);
  ctx.font = `14px ${MONO}`;
  /** @type {[string, string][]} */
  const term = [];
  term.push([`~/weather $ ${typed('npm install', t, 9.0, 10.4)}`, C.text]);
  if (t >= 11) {
    const k = Math.min(1, (t - 11) / 20);
    if (k < 1) {
      const pkgs = ['react', 'vite', 'chart.js', 'date-fns', 'zod', 'esbuild', 'rollup', 'postcss', 'undici'];
      for (let i = 0; i < 4; i++) term.push([`  fetching ${pkgs[(Math.floor((t - 11) * 3) + i) % pkgs.length]}@latest`, C.dim]);
      const n = 34;
      term.push([`  [${'#'.repeat(Math.round(n * k)).padEnd(n, '.')}] ${Math.round(k * 100)}%`, C.green]);
    } else {
      term.push(['added 312 packages in 20s', C.green]);
      term.push([`~/weather $ ${typed('npm run dev', t, 32, 33)}`, C.text]);
      if (t >= 33.6) term.push(['  VITE ready — http://localhost:5173', C.green]);
    }
  }
  term.forEach(([s, col], i) => {
    ctx.fillStyle = col;
    ctx.fillText(s, TX + 16, TY + 50 + i * 22);
  });

  // ---------------------------------------------------------- browser (right)
  const BX = 672, BY = 46, BW = SAMPLE_W - BX - 12, BH = SAMPLE_H - BY - 12;
  ctx.fillStyle = '#2a2c35';
  ctx.fillRect(BX, BY, BW, 36);
  ctx.fillStyle = '#3a3d48';
  ctx.fillRect(BX + 12, BY + 7, BW - 24, 22);
  ctx.fillStyle = C.text;
  ctx.font = `13px ${SANS}`;
  const url = t >= 62 ? `https://${typed('weather-five.vercel.app', t, 62, 63)}` : 'http://localhost:5173';
  ctx.fillText(url, BX + 24, BY + 23);
  ctx.fillStyle = C.page;
  ctx.fillRect(BX, BY + 36, BW, BH - 36);

  if (t >= 33.6) {
    const city = t >= 57.5 ? 'Bengaluru' : t >= 55.5 ? 'Delhi' : 'Mumbai';
    ctx.fillStyle = C.ink;
    ctx.font = `600 26px ${SANS}`;
    ctx.fillText('Weather', BX + 28, BY + 86);
    ctx.font = `15px ${SANS}`;
    ctx.fillStyle = '#5b6275';
    ctx.fillText('7-day forecast', BX + 28, BY + 110);

    // City picker
    ctx.strokeStyle = '#c9cede';
    ctx.lineWidth = 1;
    ctx.strokeRect(BX + 28, BY + 128, 160, 34);
    ctx.fillStyle = C.ink;
    ctx.fillText(`${city}  ▾`, BX + 40, BY + 150);

    // Chart card
    const cx = BX + 28, cy = BY + 186, cw = BW - 56, ch = 300;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(cx, cy, cw, ch);
    ctx.strokeStyle = '#e1e5ef';
    ctx.strokeRect(cx, cy, cw, ch);
    if (t >= 50) {
      const grow = Math.min(1, (t - 50) / 2);
      const temps = FORECAST[city];
      const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
      const bw = (cw - 60) / 7;
      temps.forEach((v, i) => {
        const h = ((v - 15) / 20) * (ch - 70) * grow;
        ctx.fillStyle = i === temps.indexOf(Math.max(...temps)) ? C.bar : C.bar2;
        ctx.fillRect(cx + 30 + i * bw + 8, cy + ch - 36 - h, bw - 16, h);
        ctx.fillStyle = C.ink;
        ctx.font = `13px ${SANS}`;
        if (grow === 1) ctx.fillText(`${v}°`, cx + 30 + i * bw + bw / 2 - 10, cy + ch - 44 - h);
        ctx.fillStyle = '#5b6275';
        ctx.fillText(days[i], cx + 30 + i * bw + bw / 2 - 12, cy + ch - 14);
      });
    } else {
      ctx.fillStyle = '#9aa1b2';
      ctx.font = `14px ${SANS}`;
      ctx.fillText('Loading forecast…', cx + 24, cy + 40);
    }
  }

  // A blinking text cursor in the editor, like a real screen.
  if (Math.floor(t * 2) % 2 === 0) {
    ctx.fillStyle = C.text;
    ctx.fillRect(EX + 52 + 300, EY + 64 + 5 * lineH - 16, 2, 20);
  }
  ctx.restore();
}

/**
 * Build the full sample take: transcript, mic levels, motion log and filmstrip.
 * @returns {import('./plan.js').Take & {width: number, height: number, thumbs: {t: number, url: string}[], kind: 'sample'}}
 */
export function buildSampleTake() {
  const dt = 0.05;
  const values = new Float32Array(Math.ceil(SAMPLE_DURATION / dt));
  for (let i = 0; i < values.length; i++) values[i] = 0.006 + 0.004 * Math.abs(Math.sin(i * 1.7));
  for (const p of SAMPLE_PHRASES) {
    for (let x = p.start; x < p.end - 0.35; x += dt) {
      const i = Math.floor(x / dt);
      values[i] = 0.18 + 0.15 * Math.abs(Math.sin(i * 0.9));
    }
  }

  // Motion: render small frames and diff them, exactly as the recorder does.
  const SW = GRID_W * 5, SH = GRID_H * 5;
  const canvas = document.createElement('canvas');
  canvas.width = SW;
  canvas.height = SH;
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d', { willReadFrequently: true }));
  /** @type {import('./motion.js').MotionSample[]} */
  const motion = [];
  /** @type {Uint8Array | null} */
  let prev = null;
  for (let i = 0; i <= SAMPLE_DURATION * 5; i++) {
    const t = i / 5;
    drawSample(ctx, t, SW, SH);
    const grid = toGrid(ctx.getImageData(0, 0, SW, SH).data, SW, SH);
    if (prev) {
      const d = diff(prev, grid);
      motion.push({ t, changed: d.changed, count: d.count });
    }
    prev = grid;
  }

  const thumbs = [];
  const tc = document.createElement('canvas');
  tc.width = 192;
  tc.height = 108;
  const tctx = /** @type {CanvasRenderingContext2D} */ (tc.getContext('2d'));
  for (let t = 0; t < SAMPLE_DURATION; t += 4) {
    drawSample(tctx, t + 2, 192, 108);
    thumbs.push({ t, url: tc.toDataURL('image/jpeg', 0.6) });
  }

  return {
    kind: 'sample',
    duration: SAMPLE_DURATION,
    width: SAMPLE_W,
    height: SAMPLE_H,
    phrases: SAMPLE_PHRASES.map((p) => ({ ...p })),
    cameraStart: /** @type {const} */ ('big'),
    hasCamera: true,
    levels: { dt, values },
    motion,
    thumbs,
  };
}

/** Is the presenter talking at time t? */
/** @param {number} t */
function talkingAt(t) {
  return SAMPLE_PHRASES.some((p) => t >= p.start && t < p.end - 0.35);
}

/**
 * The sample's presenter, drawn: a friendly illustrated face whose mouth
 * moves while the narration plays, standing in for a webcam.
 * @param {CanvasRenderingContext2D} ctx @param {number} t @param {number} S
 */
export function drawPresenter(ctx, t, S) {
  const g = ctx.createLinearGradient(0, 0, 0, S);
  g.addColorStop(0, '#2d3a55');
  g.addColorStop(1, '#151b29');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  // A bookshelf behind, slightly out of focus.
  for (let i = 0; i < 6; i++) {
    ctx.fillStyle = ['#7b4b3a', '#3f6b5c', '#b58a3c', '#5a4a7a', '#8a3f3f', '#3c5a7a'][i];
    ctx.fillRect(S * (0.06 + i * 0.05), S * 0.12, S * 0.04, S * 0.2);
  }
  ctx.fillStyle = '#4a3a30';
  ctx.fillRect(S * 0.03, S * 0.32, S * 0.36, S * 0.02);

  const bob = Math.sin(t * 1.3) * S * 0.006;
  const cx = S * 0.5, cy = S * 0.44 + bob;
  // Shoulders
  ctx.fillStyle = '#e8c547';
  ctx.beginPath();
  ctx.ellipse(cx, S * 1.02, S * 0.42, S * 0.3, 0, Math.PI, 0);
  ctx.fill();
  ctx.fillStyle = '#c99d6f';
  ctx.fillRect(cx - S * 0.06, cy + S * 0.15, S * 0.12, S * 0.1);
  // Head and hair
  ctx.fillStyle = '#c99d6f';
  ctx.beginPath();
  ctx.ellipse(cx, cy, S * 0.17, S * 0.21, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#1d1512';
  ctx.beginPath();
  ctx.ellipse(cx, cy - S * 0.12, S * 0.18, S * 0.11, 0, Math.PI, 0);
  ctx.fill();
  ctx.fillRect(cx - S * 0.18, cy - S * 0.13, S * 0.36, S * 0.04);
  // Eyes, blinking now and then
  const blink = (t % 4.3) < 0.12;
  ctx.fillStyle = '#1d1512';
  for (const dx of [-0.065, 0.065]) {
    ctx.beginPath();
    ctx.ellipse(cx + S * dx, cy - S * 0.01, S * 0.016, blink ? S * 0.003 : S * 0.019, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // Mouth opens with speech
  const open = talkingAt(t) ? (0.35 + 0.65 * Math.abs(Math.sin(t * 11) * Math.sin(t * 3.7))) : 0;
  ctx.fillStyle = '#5a1f1f';
  ctx.beginPath();
  ctx.ellipse(cx, cy + S * 0.1, S * 0.045, S * (0.006 + 0.03 * open), 0, 0, Math.PI * 2);
  ctx.fill();
}
