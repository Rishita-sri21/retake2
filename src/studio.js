// @ts-check
/**
 * Retake Studio: the stage, teleprompter and recorder for Retake's demo video.
 *
 * The presenter reads one beat at a time from a floating teleprompter and
 * presses → for the next. Each beat sets the stage: animated scenes, and a
 * scripted tour of the real Retake app in an iframe. Retake records this very
 * tab with the presenter's camera, and applies their spoken (or Wispr Flow
 * dictated) commands to the take, so the demo is made the way Retake works.
 */
import { Recorder, canRecord } from './recorder.js';
import { describe, parseCommands } from './commands.js';
import { saveTake } from './store.js';
import { fmt } from './plan.js';

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));

/**
 * The script. In `say`, **bold** is a Retake command, " // " a pause (a new
 * line on the teleprompter), and [Wispr] a line to dictate with Wispr Flow.
 * @type {{title: string, scene: string, say: string, note: string, run?: (sig: AbortSignal) => Promise<void>}[]}
 */
const BEATS = [
  { title: 'Cold open', scene: 'hook', say: '**Title: Edit out loud.** // My last demo took four minutes to record… and three hours to edit.', note: 'Your face fills the frame. Two clocks race on screen.' },
  { title: 'The grind', scene: 'nle', say: '**Back to the screen.** // Cutting every stumble. Keyframing every zoom. Blurring a password, frame by frame. Typing every caption.', note: 'A cluttered video editor works itself into a frenzy.' },
  { title: 'The cost', scene: 'nle', say: '**Slide: Editing is a second job.** // **Point: Hours of cutting.** // **Point: Skills and software.** // **Point: It never feels done.** // **End slide.**', note: 'Retake builds the slide from your words. It appears in the video, not here.' },
  { title: 'The turn', scene: 'turn', say: 'So I built Retake. You talk… and it edits.', note: '“Edit out loud.”' },
  { title: 'Meet Retake', scene: 'app', say: 'Everything you can say is right here: cuts, blurs, zooms, chapters, slides, even your camera.', note: 'Scrolls through the real list of commands.' },
  { title: 'Live: scratch that', scene: 'app', say: 'And it works live, in this very take. // The best part is the, uh… the thing that— // **Scratch that.** // The best part: it edits while you talk.', note: 'Pause after the first line. Stumble on purpose, pause, then say “scratch that”.' },
  { title: 'Live: hide that', scene: 'app', say: 'Here’s my API key. // **Hide that.**', note: 'A key types itself into a .env file. Say “hide that” once you see it.' },
  { title: 'The editor', scene: 'app', say: 'When I stop, it’s already edited. This is the final video.', note: 'Opens the sample take and plays it, silently.' },
  { title: 'Three versions', scene: 'app', say: 'The demo version labels every command. And the raw take stays untouched.', note: 'Switches to Demo, then Raw.' },
  { title: 'The timeline', scene: 'app', say: '**Zoom in on the bottom.** // Every edit sits on this timeline. // **Zoom out.**', note: 'The cursor runs along the cuts, fast-forwards and blurs.' },
  { title: 'You stay in control', scene: 'app', say: 'Switch any edit off, restyle the video, and export it with captions and chapters.', note: 'Commands, Style and Export panels.' },
  { title: 'Any language', scene: 'lang', say: 'And it speaks your language. // **Zoom karo.** // Eight languages so far. // **Zoom out karo.**', note: 'The same command flips through eight languages.' },
  { title: 'Wispr Flow', scene: 'wispr', say: 'When a command has to land perfectly, I use Wispr Flow: hold one key, speak, and it types straight into Retake. // [Wispr] **Switch the screen.** // I built Retake the same way, talking instead of typing. // [Wispr] **Switch back.**', note: 'The command box is focused. Hold your Wispr key for the [Wispr] lines, and wait for the ✓ before you go on.' },
  { title: 'Close', scene: 'end', say: '**Big camera.** // I’m Rishita Srivastava, and this is Retake. Stop editing. Start talking. // **Stop recording.**', note: '“Stop recording” ends the take and opens it in Retake.' },
];

// ---------------------------------------------------------------- stage scaling

const stage = $('stage');
function fit() {
  const s = Math.min(innerWidth / 1920, innerHeight / 1080);
  stage.style.transform = `scale(${s})`;
  stage.dataset.scale = String(s);
}
addEventListener('resize', fit);
fit();

/** @param {number} ms @param {AbortSignal} sig */
const wait = (ms, sig) =>
  new Promise((res, rej) => {
    if (sig.aborted) return rej(new DOMException('', 'AbortError'));
    const id = setTimeout(res, ms);
    sig.addEventListener('abort', () => (clearTimeout(id), rej(new DOMException('', 'AbortError'))), { once: true });
  });

/** @param {string} name */
function showScene(name) {
  for (const s of document.querySelectorAll('.scene')) s.classList.toggle('on', /** @type {HTMLElement} */ (s).dataset.scene === name);
}

// ---------------------------------------------------------------- the cursor

const cursor = $('cursor'), ring = $('click-ring');
let cx = 1500, cy = 900;
/** @param {number} x @param {number} y */
function moveTo(x, y) {
  cx = x;
  cy = y;
  cursor.classList.add('on');
  cursor.style.transform = `translate(${x}px, ${y}px)`;
}
function clickFx() {
  ring.style.left = `${cx + 6}px`;
  ring.style.top = `${cy + 4}px`;
  ring.classList.remove('go');
  void ring.offsetWidth;
  ring.classList.add('go');
}
const hideCursor = () => cursor.classList.remove('on');

// ---------------------------------------------------------------- the real app, in an iframe

const frame = /** @type {HTMLIFrameElement} */ ($('app'));
const appWin = () => /** @type {any} */ (frame.contentWindow);
const appDoc = () => /** @type {Document} */ (frame.contentDocument);
/** The app is laid out at 1360px and shown 1.25× larger, so its text reads on video. */
const APP_ZOOM = 1.25;
/** Where an element inside the app sits on the stage. @param {Element} el */
function onStage(el) {
  const s = Number(stage.dataset.scale || 1);
  const f = frame.getBoundingClientRect(), st = stage.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const z = APP_ZOOM;
  return { x: (f.left - st.left) / s + (r.left + r.width / 2) * z, y: (f.top - st.top) / s + (r.top + r.height / 2) * z, w: r.width * z, h: r.height * z };
}
/** Move the cursor to an element in the app and click it. @param {string | Element} target @param {AbortSignal} sig */
async function click(target, sig, { real = true } = {}) {
  const el = typeof target === 'string' ? appDoc().querySelector(target) : target;
  if (!el) return;
  el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  await wait(250, sig);
  const p = onStage(el);
  moveTo(p.x - 4, p.y - 4);
  await wait(750, sig);
  clickFx();
  if (real) /** @type {HTMLElement} */ (el).click();
  await wait(250, sig);
}
/** Hover the cursor over an element. @param {string | Element} target @param {AbortSignal} sig */
async function hover(target, sig, dx = 0) {
  const el = typeof target === 'string' ? appDoc().querySelector(target) : target;
  if (!el) return;
  const p = onStage(el);
  moveTo(p.x + dx, p.y);
  await wait(700, sig);
}
/** Make sure the app shows its home page, scrolled to the top. */
async function appHome(/** @type {AbortSignal} */ sig) {
  const home = appDoc()?.getElementById('home');
  if (!home || home.hidden) {
    frame.src = './?embed';
    await new Promise((r) => frame.addEventListener('load', r, { once: true }));
    await wait(600, sig);
  }
  appWin().scrollTo({ top: 0 });
}
/** Make sure the app shows the sample take in its editor. */
async function appEditor(/** @type {AbortSignal} */ sig) {
  if (appDoc().getElementById('edit')?.hidden === false) return;
  await appHome(sig);
  await click('#try-sample', sig);
  for (let i = 0; i < 40 && appDoc().getElementById('edit')?.hidden !== false; i++) await wait(150, sig);
  appWin().scrollTo({ top: 0 });
  await wait(400, sig);
}
const appPlaying = () => Boolean(appWin().retake?.state?.player?.playing);
async function appPlay(/** @type {boolean} */ on) {
  if (appPlaying() !== on) await appWin().retake.togglePlay();
}

// ---------------------------------------------------------------- scene: hook

/** @param {AbortSignal} sig */
async function runHook(sig) {
  const edit = $('hk-edit'), bRec = $('hk-bar-rec'), bEdit = $('hk-bar-edit');
  const total = 3 * 3600 + 2 * 60 + 17;
  bRec.style.width = '2.2%';
  bEdit.style.width = '0%';
  edit.textContent = '00:00:00';
  await wait(900, sig);
  const t0 = performance.now(), dur = 6000;
  while (!sig.aborted) {
    const k = Math.min(1, (performance.now() - t0) / dur);
    const e = 1 - Math.pow(1 - k, 3);
    const s = Math.round(total * e);
    edit.textContent = `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    bEdit.style.width = `${97.8 * e}%`;
    if (k >= 1) break;
    await wait(40, sig);
  }
}

// ---------------------------------------------------------------- scene: the traditional editor

/** @param {AbortSignal} sig */
async function runNle(sig) {
  const lanes = { v1: $('lane-v1'), v2: $('lane-v2'), a1: $('lane-a1'), cc: $('lane-cc') };
  /** @type {Record<string, {x: number, w: number, el: HTMLElement}[]>} */
  const clips = { v1: [], v2: [], a1: [], cc: [] };
  const W = lanes.v1.getBoundingClientRect().width / Number(stage.dataset.scale || 1) || 1700;
  const make = (/** @type {keyof typeof lanes} */ lane, /** @type {number} */ x, /** @type {number} */ w, cls = '', text = '') => {
    const el = document.createElement('i');
    el.className = `clip ${cls}`;
    el.textContent = text;
    el.style.left = `${x}px`;
    el.style.width = `${w}px`;
    lanes[lane].append(el);
    clips[lane].push({ x, w, el });
  };
  for (const l of Object.values(lanes)) l.replaceChildren();
  for (const k of Object.keys(clips)) clips[k] = [];
  make('v1', 0, W * 0.92, 'v');
  make('v2', W * 0.18, W * 0.2, 'v2');
  make('v2', W * 0.55, W * 0.16, 'v2');
  make('a1', 0, W * 0.92, 'a');
  for (const id of ['fx-scale', 'fx-pos', 'fx-mask', 'fx-op']) $(id).replaceChildren();
  $('fx-cap').textContent = '';
  const stats = { clicks: 1284, undo: 312, keys: 0, tut: 6, time: 2 * 3600 + 51 * 60 + 7 };
  const paint = () => {
    $('st-clicks').textContent = stats.clicks.toLocaleString('en');
    $('st-undo').textContent = String(stats.undo);
    $('st-keys').textContent = String(stats.keys);
    $('st-tut').textContent = String(stats.tut);
    const s = stats.time;
    $('st-time').textContent = `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };
  paint();
  const tl = $('nle-timeline');
  const tlBox = () => {
    const s = Number(stage.dataset.scale || 1), r = tl.getBoundingClientRect(), st = stage.getBoundingClientRect();
    return { x: (r.left - st.left) / s, y: (r.top - st.top) / s, w: r.width / s, h: r.height / s };
  };
  const captions = ['um so first we', 'open the uh', 'the setting thingy', 'sorry, settings', 'then click save', 'and wait for it'];
  let frameNo = 4, cap = 0, step = 0;
  while (!sig.aborted) {
    step++;
    const box = tlBox();
    // A razor cut on V1, and every other one a ripple delete.
    const v1 = clips.v1;
    const target = v1[Math.floor(Math.random() * v1.length)];
    if (target && target.w > 60) {
      const at = target.x + target.w * (0.3 + Math.random() * 0.4);
      moveTo(box.x + 64 + at, box.y + box.h * 0.42);
      $('tl-head').style.left = `${64 + at}px`;
      await wait(260, sig);
      clickFx();
      const razor = document.createElement('i');
      razor.className = 'razor';
      razor.style.left = `${at}px`;
      lanes.v1.append(razor);
      const right = { x: at, w: target.x + target.w - at };
      target.w = at - target.x;
      target.el.style.width = `${target.w}px`;
      make('v1', right.x + 2, right.w - 2, 'v');
      if (step % 2 === 0) {
        const gap = Math.min(70, right.w * 0.3);
        for (const c of v1) if (c.x > at) (c.x -= gap), (c.el.style.left = `${c.x}px`);
        razor.remove();
      }
      stats.clicks += 3 + Math.floor(Math.random() * 6);
      if (Math.random() < 0.35) stats.undo++;
    }
    // A keyframe for the zoom, and the mask nudged one frame.
    const rows = ['fx-scale', 'fx-pos', 'fx-mask', 'fx-op'];
    const row = $(rows[step % rows.length]);
    const k = document.createElement('i');
    k.style.left = `${(row.childElementCount * 34 + 8) % 260}px`;
    row.append(k);
    stats.keys++;
    const mask = $('nle-mask');
    mask.style.transform = `translate(${(Math.random() - 0.5) * 14}px, ${(Math.random() - 0.5) * 8}px)`;
    frameNo++;
    $('nle-frame').textContent = `00:01:12:${String(frameNo % 30).padStart(2, '0')}`;
    // A caption, typed by hand.
    if (step % 3 === 0) {
      const text = captions[cap++ % captions.length];
      const el = $('fx-cap');
      el.textContent = '';
      for (const ch of text) {
        el.textContent += ch;
        await wait(28, sig);
      }
      make('cc', (cap * 150) % (W - 160), 140, 'cc', text);
    }
    if (step % 9 === 0) stats.tut++;
    stats.time += 37;
    paint();
    await wait(420, sig);
  }
}

// ---------------------------------------------------------------- scenes: the real app

/** @param {AbortSignal} sig */
async function runMeet(sig) {
  $('env-card').hidden = true;
  await appHome(sig);
  moveTo(1500, 760);
  await wait(500, sig);
  const head = appDoc().getElementById('vocab-title');
  const win = appWin();
  const top = head ? head.getBoundingClientRect().top + win.scrollY - 40 : 900;
  win.scrollTo({ top, behavior: 'smooth' });
  await wait(1400, sig);
  for (let i = 0; i < 7 && !sig.aborted; i++) {
    win.scrollBy({ top: 420, behavior: 'smooth' });
    const cards = [...appDoc().querySelectorAll('.cmd-card')].filter((c) => {
      const r = c.getBoundingClientRect();
      return r.top > 120 && r.bottom < 860;
    });
    if (cards.length) await hover(cards[Math.floor(Math.random() * cards.length)], sig, -60);
    await wait(900, sig);
  }
}

/** @param {AbortSignal} sig */
async function runScratch(sig) {
  $('env-card').hidden = true;
  await appHome(sig);
  appWin().scrollTo({ top: 0, behavior: 'smooth' });
  hideCursor();
}

/** @param {AbortSignal} sig */
async function runHide(sig) {
  await appHome(sig);
  const card = $('env-card'), key = $('env-key');
  key.textContent = '';
  card.hidden = false;
  await wait(1200, sig);
  for (const ch of 'sk_live_51HxQ9fT3kLmV8pRz2Wd') {
    key.textContent += ch;
    await wait(55, sig);
  }
}

/** @param {AbortSignal} sig */
async function runEditor(sig) {
  $('env-card').hidden = true;
  await appEditor(sig);
  await click('#view-final', sig);
  await click('#big-play', sig);
  if (!appPlaying()) await appPlay(true);
  await hover('#screen', sig, 200);
}

/** @param {AbortSignal} sig */
async function runViews(sig) {
  await appEditor(sig);
  await click('#view-demo', sig);
  await appPlay(true);
  await wait(3600, sig);
  await click('#view-raw', sig);
  await appPlay(true);
  await wait(3000, sig);
  await click('#view-final', sig);
}

/** @param {AbortSignal} sig */
async function runTimeline(sig) {
  await appEditor(sig);
  if (appWin().retake.state.view !== 'final') await click('#view-final', sig);
  await appPlay(false);
  const tl = appDoc().getElementById('timeline');
  if (!tl) return;
  tl.scrollIntoView({ block: 'center', behavior: 'smooth' });
  await wait(700, sig);
  const p = onStage(tl);
  for (let i = 0; i <= 10 && !sig.aborted; i++) {
    moveTo(p.x - p.w / 2 + (p.w * i) / 10, p.y + 6);
    await wait(520, sig);
  }
  await click(tl, sig);
}

/** @param {AbortSignal} sig */
async function runControls(sig) {
  await appEditor(sig);
  if (appWin().retake.state.view !== 'final') await click('#view-final', sig);
  await click('#tab-notes', sig);
  const sw = appDoc().querySelector('.note-item .toggle input');
  if (sw) {
    await click(sw, sig);
    await wait(900, sig);
    await click(sw, sig);
  }
  await click('#tab-look', sig);
  await click('#cmd-style [data-style="mute"]', sig);
  await click('#cmd-style [data-style="smart"]', sig);
  const shape = appDoc().querySelectorAll('#cam-shape button');
  if (shape[1]) await click(shape[1], sig);
  if (shape[0]) await click(shape[0], sig);
  await click('#tab-export', sig);
  await hover('#export', sig);
  await hover('#copy-chapters', sig);
}

// ---------------------------------------------------------------- scene: languages

/** @param {AbortSignal} sig */
async function runLang(sig) {
  const board = $('board');
  const words = ['SCRATCH THAT', 'KAAT DO', 'काट दो', 'CORTA ESO', 'COUPE ÇA', 'SCHNEID DAS', 'CORTA ISSO', 'TAGLIA QUESTO'];
  const seg = 'Segmenter' in Intl ? new /** @type {any} */ (Intl).Segmenter(undefined, { granularity: 'grapheme' }) : null;
  const chars = (/** @type {string} */ w) => (seg ? [...seg.segment(w)].map((x) => x.segment) : [...w]);
  const N = 13;
  board.replaceChildren(...Array.from({ length: N }, () => document.createElement('span')));
  const tiles = /** @type {HTMLElement[]} */ ([...board.children]);
  let i = 0;
  while (!sig.aborted) {
    const c = chars(words[i++ % words.length]);
    const pad = Math.floor((N - c.length) / 2);
    for (let k = 0; k < N; k++) {
      const ch = c[k - pad] ?? '';
      const t = tiles[k];
      t.classList.add('flip');
      setTimeout(() => {
        t.textContent = ch === ' ' ? '' : ch;
        t.classList.toggle('blank', !ch || ch === ' ');
        t.classList.remove('flip');
      }, 90 + k * 22);
    }
    await wait(1500, sig);
  }
}

// ---------------------------------------------------------------- scene: Wispr Flow → Retake

const wsInput = /** @type {HTMLInputElement} */ ($('ws-input'));
let wsTimer = 0, wsFirst = 0;
function wsSend() {
  clearTimeout(wsTimer);
  const text = wsInput.value.trim();
  if (!text) return;
  const age = wsFirst ? (performance.now() - wsFirst) / 1000 : 0;
  wsFirst = 0;
  const cmds = recorder?.typed(text, age) ?? parseCommands([{ text, start: 0, end: 1 }]);
  $('ws-done').textContent = cmds.length ? `✓ ${describe(cmds[0])}` : `Not a command: “${text}”`;
  setTimeout(() => {
    if (wsInput.value.trim() === text) wsInput.value = '';
  }, 1600);
}
wsInput.addEventListener('input', () => {
  if (!wsFirst && wsInput.value) wsFirst = performance.now();
  clearTimeout(wsTimer);
  wsTimer = window.setTimeout(wsSend, 800); // Wispr pastes the phrase at once
});
$('ws-form').addEventListener('submit', (e) => {
  e.preventDefault();
  wsSend();
});

/** @param {AbortSignal} sig */
async function runWispr(sig) {
  hideCursor();
  wsInput.value = '';
  $('ws-done').textContent = '';
  await wait(300, sig);
  wsInput.focus();
}

/** @param {AbortSignal} sig */
async function runEnd(sig) {
  hideCursor();
  $('end-url').textContent = location.host ? `${location.host}${location.pathname.replace(/studio\.html$/, '')}` : 'retake';
  await wait(10, sig);
}

const RUN = /** @type {Record<number, (sig: AbortSignal) => Promise<void>>} */ ({
  0: runHook, 1: runNle, 2: runNle, 4: runMeet, 5: runScratch, 6: runHide, 7: runEditor, 8: runViews, 9: runTimeline, 10: runControls, 11: runLang, 12: runWispr, 13: runEnd,
});

// ---------------------------------------------------------------- beats

let beat = -1;
/** @type {AbortController | null} */
let running = null;
/** @param {number} i */
async function go(i) {
  if (i < 0 || i >= BEATS.length) return;
  const prev = beat;
  beat = i;
  const b = BEATS[i];
  // The editor keeps working itself into a frenzy under the cost slide.
  const continuing = prev >= 0 && BEATS[prev].scene === 'nle' && b.scene === 'nle';
  if (!(prev >= 0 && BEATS[prev].scene === b.scene)) showScene(b.scene);
  if (b.scene !== 'app') hideCursor();
  if (b.scene !== 'wispr' && document.activeElement === wsInput) wsInput.blur();
  renderPrompter();
  if (continuing) return;
  running?.abort();
  const ctl = (running = new AbortController());
  RUN[i]?.(ctl.signal).catch(() => {});
}

addEventListener('keydown', onKey);
frame.addEventListener('load', () => frame.contentWindow?.addEventListener('keydown', onKey));
/** @param {KeyboardEvent} e */
function onKey(e) {
  if (!started) return;
  const typing = e.target === wsInput;
  if (['ArrowRight', 'PageDown'].includes(e.key) || (e.key === ' ' && !typing)) {
    if (typing && wsInput.value.trim()) return; // finish the command first
    e.preventDefault();
    go(beat + 1);
  } else if (['ArrowLeft', 'PageUp'].includes(e.key) && !typing) {
    e.preventDefault();
    go(beat - 1);
  } else if (e.key === 'Escape' && !recorder) {
    stopRehearsal();
  }
}

// ---------------------------------------------------------------- teleprompter

/** @type {Window | null} */
let prompter = null;

/** @param {string} s */
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] || c);
/** Script markup to teleprompter HTML. @param {string} say */
function sayHtml(say) {
  return say
    .split(' // ')
    .map((line) => {
      const wispr = line.startsWith('[Wispr] ');
      const body = esc(wispr ? line.slice(8) : line).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
      return `<p class="${wispr ? 'w' : ''}">${wispr ? '<span class="tag">Wispr</span>' : ''}${body}</p>`;
    })
    .join('');
}

const PROMPTER_CSS = `
  *{box-sizing:border-box} html,body{margin:0;height:100%;background:#0e0e10;color:#f4f1ea;font:16px "Instrument Sans",system-ui,sans-serif}
  body{display:grid;grid-template-rows:auto 1fr auto;padding:14px 18px;gap:8px}
  header{display:flex;justify-content:space-between;align-items:center;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#a8a399}
  header b{color:#e8c9a0;font-weight:500} .rec{color:#e5534b} .rec.off{color:#6f6b64}
  main{overflow:auto} main p{margin:0 0 10px;font-size:25px;line-height:1.35}
  main b{color:#e8c9a0;font-style:italic;font-weight:500}
  main p.w{padding-left:2px} .tag{display:inline-block;margin-right:8px;padding:2px 8px;border-radius:999px;background:#e8c9a0;color:#1d160c;font-size:12px;font-style:normal;letter-spacing:.06em;text-transform:uppercase;vertical-align:4px}
  .note{font-size:13px;color:#a8a399} .next{font-size:13px;color:#6f6b64;margin-top:2px}
  .heard{min-height:18px;font-size:13px;color:#9ec9a9}
  .count{display:grid;place-items:center;height:100%;font:400 120px/1 "Instrument Serif",Georgia,serif;color:#e8c9a0}
  .stop{margin-left:10px;border:1px solid #3a3a42;background:none;color:#f4f1ea;border-radius:999px;padding:3px 10px;font:12px system-ui;cursor:pointer}`;

function prompterDoc() {
  return prompter && !prompter.closed ? prompter.document : null;
}
function renderPrompter() {
  const doc = prompterDoc();
  if (!doc) return;
  const b = BEATS[Math.max(0, beat)];
  const next = BEATS[Math.max(0, beat) + 1];
  const recTime = recorder ? fmt(recorder.now()) : started ? 'Rehearsal' : 'Not recording';
  doc.body.innerHTML = `
    <header><span><b>${Math.max(0, beat) + 1} / ${BEATS.length}</b> · ${esc(b.title)}</span><span><span class="rec ${recorder ? '' : 'off'}">● ${esc(recTime)}</span>${recorder ? '<button class="stop" id="p-stop">Stop</button>' : ''}</span></header>
    <main>${sayHtml(b.say)}<p class="note">${esc(b.note)}</p></main>
    <footer><p class="heard" id="p-heard">${esc(lastHeard)}</p><p class="next">${next ? `Next: ${esc(next.title)} · press → when you finish` : 'Last beat. Say “stop recording”.'}</p></footer>`;
  doc.getElementById('p-stop')?.addEventListener('click', () => finish());
}
let lastHeard = '';

async function openPrompter() {
  const dpip = /** @type {any} */ (window).documentPictureInPicture;
  if (prompter && !prompter.closed) return prompter;
  if (dpip) {
    prompter = await dpip.requestWindow({ width: 560, height: 300 });
  } else {
    prompter = window.open('', 'retake-prompter', 'width=560,height=300');
  }
  if (!prompter) return null;
  const doc = prompter.document;
  doc.title = 'Retake teleprompter';
  const style = doc.createElement('style');
  style.textContent = PROMPTER_CSS;
  doc.head.append(style);
  prompter.addEventListener('keydown', onKey);
  renderPrompter();
  return prompter;
}

// ---------------------------------------------------------------- recording

/** @type {Recorder | null} */
let recorder = null;
let started = false;
let promptTimer = 0;

function hideSetup() {
  $('setup').hidden = true;
  started = true;
  document.body.style.cursor = 'none';
}

async function startRecording() {
  if (!canRecord()) {
    $('setup-note').textContent = 'Recording needs Chrome or Edge on a computer.';
    return;
  }
  if (!prompterDoc()) await openPrompter().catch(() => null);
  const lang = /** @type {HTMLSelectElement} */ ($('lang')).value;
  const r = new Recorder({
    onInterim: (t) => {
      const el = prompterDoc()?.getElementById('p-heard');
      if (el) el.textContent = t ? `… ${t}` : lastHeard;
    },
    onPhrase: () => {},
    onCommand: (c) => {
      lastHeard = `✓ ${describe(c)}`;
      const el = prompterDoc()?.getElementById('p-heard');
      if (el) el.textContent = lastHeard;
    },
    onLevel: () => {},
    onEnded: () => finish(),
    onWarn: (m) => ($('setup-note').textContent = m),
    onPauseChange: () => renderPrompter(),
    onStopRequested: () => finish(),
  });
  try {
    await r.prepare({ lang, systemAudio: false, camera: true, currentTab: true });
  } catch (e) {
    if (/** @type {any} */ (e)?.name !== 'NotAllowedError') $('setup-note').textContent = /** @type {Error} */ (e).message || 'Recording could not start.';
    return;
  }
  hideSetup();
  showScene('hook');
  // 3-2-1 on the teleprompter; Retake is already listening.
  const doc = prompterDoc();
  for (const n of [3, 2, 1]) {
    if (doc) doc.body.innerHTML = `<div class="count">${n}</div>`;
    await new Promise((res) => setTimeout(res, 1000));
  }
  await r.begin();
  recorder = r;
  promptTimer = window.setInterval(() => {
    const el = prompterDoc()?.querySelector('.rec');
    if (el && recorder) el.textContent = `● ${fmt(recorder.now())}`;
  }, 500);
  go(0);
}

let finishing = false;
async function finish() {
  const r = recorder;
  if (!r || finishing) return;
  finishing = true;
  running?.abort();
  clearInterval(promptTimer);
  const doc = prompterDoc();
  if (doc) doc.body.innerHTML = '<div class="count" style="font-size:40px">Putting your take together…</div>';
  const take = await r.stop();
  recorder = null;
  /** @type {any} */ (take).cameraStart = 'big';
  await saveTake(take);
  prompter?.close();
  location.href = './?last';
}

function rehearse() {
  hideSetup();
  openPrompter().catch(() => null);
  go(0);
}
function stopRehearsal() {
  running?.abort();
  started = false;
  beat = -1;
  $('setup').hidden = false;
  document.body.style.cursor = '';
  showScene('hook');
}

$('btn-full').addEventListener('click', () => document.documentElement.requestFullscreen?.().catch(() => {}));
$('btn-prompter').addEventListener('click', () => openPrompter().catch((e) => ($('setup-note').textContent = e.message)));
$('btn-rehearse').addEventListener('click', rehearse);
$('btn-record').addEventListener('click', startRecording);
showScene('hook');

/** For automated checks. */
/** @type {any} */ (window).studio = { BEATS, go, get beat() { return beat; }, rehearse, sayHtml };
