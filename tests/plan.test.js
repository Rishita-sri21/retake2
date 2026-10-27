import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommands, stripCommands } from '../src/commands.js';
import { GRID_W, GRID_H, secretAt, focusAt, diff, toGrid } from '../src/motion.js';
import { buildPlan, srcToOut, outToSrc, cameraAt, toSrt, youtubeChapters, fmt } from '../src/plan.js';

// ---------------------------------------------------------------- helpers

/** A take where the mic is loud exactly during the phrases. */
function take(phrases, duration, motion = []) {
  const dt = 0.05;
  const values = new Float32Array(Math.ceil(duration / dt));
  for (const p of phrases) for (let t = p.start; t < p.end - 0.4; t += dt) values[Math.floor(t / dt)] = 0.3;
  return { duration, phrases, levels: { dt, values }, motion };
}

/** Motion samples 5 per second; `events` say which grid rectangle changes when. */
function motionLog(duration, events) {
  const log = [];
  for (let t = 0; t <= duration; t += 0.2) {
    const changed = new Uint8Array(GRID_W * GRID_H);
    let count = 0;
    for (const e of events) {
      if (t < e.t0 || t > e.t1) continue;
      for (let y = e.y0; y <= e.y1; y++) for (let x = e.x0; x <= e.x1; x++) {
        if (!changed[y * GRID_W + x]) { changed[y * GRID_W + x] = 1; count++; }
      }
    }
    log.push({ t: Math.round(t * 10) / 10, changed, count });
  }
  return log;
}

const P = (text, start, end) => ({ text, start, end });

// ---------------------------------------------------------------- commands

test('recognises every command in English', () => {
  const said = [
    'scratch that', 'hide that', 'zoom here', 'zoom out', 'look here', 'speed this up',
    'back to normal speed', 'chapter: deploying the app', 'title: weather in five minutes', 'mark that',
  ];
  const types = parseCommands(said.map((s, i) => P(s, i * 3, i * 3 + 2))).map((c) => c.type);
  assert.deepEqual(types, ['cut', 'hide', 'zoomIn', 'zoomOut', 'highlight', 'speedUp', 'normalSpeed', 'chapter', 'title', 'mark']);
});

test('understands Hinglish and Hindi directions', () => {
  const cmds = parseCommands([
    P('ye wala kaat do', 0, 2),
    P('API key chhupa do', 3, 5),
    P('यहाँ ज़ूम करो', 6, 8),
    P('अध्याय: सेटअप', 9, 11),
  ]);
  assert.deepEqual(cmds.map((c) => c.type), ['cut', 'hide', 'zoomIn', 'chapter']);
  assert.equal(cmds[3].label, 'सेटअप');
});

test('chapter and title labels are captured and tidied', () => {
  const [c, t] = parseCommands([P('Chapter one, setting up the project.', 0, 2), P('Title: building a weather app', 3, 5)]);
  assert.equal(c.label, 'Setting up the project');
  assert.equal(t.label, 'Building a weather app');
});

test('a phrase is cut only when it is (almost) just the command', () => {
  const [a, b] = parseCommands([P('okay zoom in here', 0, 2), P('now I will zoom in on the revenue chart to show the spike', 3, 7)]);
  assert.equal(a.standalone, true);
  assert.equal(b.standalone, false);
});

test('ordinary narration is not mistaken for a command', () => {
  const cmds = parseCommands([
    P('this hides the sidebar on mobile', 0, 3),
    P('the cut off date is in March', 4, 6),
    P('we chapter the data by region', 7, 9),
  ]);
  assert.equal(cmds.length, 0);
});

test('captions drop the command words but keep the narration', () => {
  assert.equal(stripCommands('and this is the result, zoom here'), 'and this is the result');
});

// ---------------------------------------------------------------- motion

test('grid conversion and diff', () => {
  const w = GRID_W * 2, h = GRID_H * 2;
  const a = new Uint8ClampedArray(w * h * 4).fill(0);
  const b = a.slice();
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) b.set([255, 255, 255, 255], (y * w + x) * 4);
  const d = diff(toGrid(a, w, h), toGrid(b, w, h));
  assert.equal(d.count, 4); // 4×4 pixels = 2×2 grid cells
});

test('"hide that" finds what appeared and starts the blur when it first appeared', () => {
  const log = motionLog(30, [
    { t0: 5, t1: 6, x0: 2, x1: 4, y0: 30, y1: 31 }, // cursor-sized wiggle earlier
    { t0: 18, t1: 19.4, x0: 10, x1: 40, y0: 12, y1: 14 }, // the API key being pasted
    { t0: 23, t1: 23.4, x0: 60, x1: 61, y0: 2, y1: 2 }, // mouse moved while speaking
  ]);
  const s = secretAt(log, 24);
  assert.ok(s, 'found a secret');
  assert.ok(Math.abs(s.start - 17.75) < 0.3, `blur starts at ${s.start}`);
  assert.ok(s.box.x <= 10 / GRID_W && s.box.x + s.box.w >= 41 / GRID_W, 'box covers the key');
  assert.ok(s.box.y <= 12 / GRID_H && s.box.y + s.box.h >= 15 / GRID_H);
});

test('"zoom here" points at the recently busy region', () => {
  const log = motionLog(10, [{ t0: 7, t1: 9, x0: 48, x1: 60, y0: 20, y1: 30 }]);
  const f = focusAt(log, 9.2);
  assert.ok(f.x > 0.75 && f.x < 0.95, `x=${f.x}`);
  assert.ok(f.y > 0.55 && f.y < 0.85, `y=${f.y}`);
});

// ---------------------------------------------------------------- planning

test('"scratch that" removes the fumbled sentence and the command itself', () => {
  const t = take(
    [
      P('Here we open the settings', 1, 4),
      P('then we click the uh, the thing', 5, 8),
      P('scratch that', 8.6, 9.6),
      P('then we click save', 10.2, 12.5),
    ],
    14,
  );
  const plan = buildPlan(t, { trimDeadAir: false });
  const fumble = plan.cuts.find((c) => c.reason === 'fumble');
  assert.ok(fumble.src0 > 4 && fumble.src0 <= 5, `cut starts ${fumble.src0}`);
  assert.ok(fumble.src1 >= 9.2 && fumble.src1 < 10.2, `cut ends ${fumble.src1}`);
  assert.equal(plan.stats.fumbles, 1);
  assert.ok(!plan.captions.some((c) => /thing|scratch/.test(c.text)));
  assert.ok(plan.captions.some((c) => /click save/.test(c.text)));
});

test('a fumble in the same breath as "scratch that" cuts only that breath', () => {
  const t = take([P('First open the terminal', 0.5, 3), P('then run npm star no wait scratch that', 4, 8), P('then run npm start', 9, 11)], 12);
  const fumble = buildPlan(t, { trimDeadAir: false }).cuts.find((c) => c.reason === 'fumble');
  assert.ok(fumble.src0 > 3 && fumble.src0 <= 4);
});

test('speed ranges, time mapping and output length', () => {
  const t = take([P('speed this up', 2, 3), P('back to normal', 23, 24), P('done', 25, 26)], 27);
  const plan = buildPlan(t, { trimDeadAir: false, speed: 4 });
  const sp = plan.speeds[0];
  assert.ok(sp.src0 >= 2.6 && sp.src0 < 3.4 && Math.abs(sp.src1 - 23) < 0.3);
  // ~20s at 4x = 5s; both command phrases removed (~2s).
  assert.ok(plan.outDuration > 9 && plan.outDuration < 13, `out ${plan.outDuration}`);
  for (const o of [0.5, 4, 7, plan.outDuration - 0.5]) {
    const { src } = outToSrc(plan.segments, o);
    assert.ok(Math.abs(srcToOut(plan.segments, src, plan.outDuration) - o) < 1e-6, `round trip at ${o}`);
  }
});

test('dead air is shortened, but silent typing on screen is kept', () => {
  const phrases = [P('one', 0.5, 1.5), P('two', 6, 7), P('three', 14, 15)];
  const motion = motionLog(16, [{ t0: 8, t1: 13, x0: 5, x1: 20, y0: 5, y1: 8 }]); // typing between two and three
  const plan = buildPlan(take(phrases, 16, motion));
  const dead = plan.cuts.filter((c) => c.reason === 'dead-air');
  assert.equal(dead.length, 1, 'only the static silence is trimmed');
  assert.ok(dead[0].src0 > 1 && dead[0].src1 < 6);
  assert.ok(plan.stats.deadAir > 3);
});

test('zoom goes to the centre, or where you say, and glides back out', () => {
  const plan = buildPlan(
    take([P('zoom in', 5, 6), P('look at that', 7, 9), P('zoom in on the top right', 10, 11.5), P('zoom in more', 13, 14), P('zoom out', 16, 17)], 20),
    { trimDeadAir: false },
  );
  const [, center, topRight, more, out] = plan.view;
  assert.deepEqual([center.scale, center.x, center.y], [2, 0.5, 0.5]);
  assert.equal(topRight.x, 0.75);
  assert.equal(topRight.y, 0.25);
  assert.equal(more.scale, 3);
  assert.equal(out.scale, 1);
});

test('"zoom in for 3 seconds" zooms back out by itself', async () => {
  const { cameraAt } = await import('../src/plan.js');
  const plan = buildPlan(take([P('zoom in for 3 seconds', 2, 3.5)], 12), { trimDeadAir: false });
  assert.equal(plan.view.length, 3);
  assert.equal(cameraAt(plan, 5).scale, 2);
  assert.equal(cameraAt(plan, 9).scale, 1);
});

test('switching a command off undoes its edit', () => {
  const t = take([P('Hello there friends', 1, 3), P('scratch that', 3.5, 4.5), P('Hello everyone', 5, 7)], 8);
  const on = buildPlan(t, { trimDeadAir: false });
  const id = on.commands[0].id;
  const off = buildPlan(t, { trimDeadAir: false, disabled: [id] });
  assert.ok(off.outDuration > on.outDuration + 2);
  assert.equal(off.commands[0].enabled, false);
});

test('chapters map to output time and export for YouTube', () => {
  const t = take(
    [P('Title: weather app', 0.5, 2), P('chapter: setup', 3, 4), P('install things here', 4.5, 16), P('chapter: deploy', 17, 18), P('ship it now please', 18.5, 30)],
    31,
  );
  const plan = buildPlan(t, { trimDeadAir: false });
  assert.equal(plan.title, 'Weather app');
  assert.equal(plan.chapters.length, 2);
  const yt = youtubeChapters(plan);
  assert.match(yt.text, /^00:00 Weather app\n00:0\d Setup\n00:1\d Deploy$/);
  assert.equal(yt.valid, false, 'first chapter is under 10s');
});

test('SRT output', () => {
  const srt = toSrt([{ out0: 1.5, out1: 3.25, text: 'Hello' }, { out0: 61, out1: 62, text: 'World' }]);
  assert.equal(srt, '1\n00:00:01,500 --> 00:00:03,250\nHello\n\n2\n00:01:01,000 --> 00:01:02,000\nWorld\n');
  assert.equal(fmt(3725), '1:02:05');
});

test('the blur ends when the secret leaves the screen', () => {
  const motion = motionLog(30, [
    { t0: 10, t1: 10.4, x0: 4, x1: 30, y0: 6, y1: 7 }, // key pasted
    { t0: 20, t1: 20.2, x0: 0, x1: 40, y0: 2, y1: 20 }, // switched to another file
  ]);
  const plan = buildPlan(take([P('paste the key', 8, 10), P('hide that', 12, 13)], 30, motion), { trimDeadAir: false });
  const b = plan.blurs[0];
  assert.ok(Math.abs(b.src0 - 9.75) < 0.3, `starts ${b.src0}`);
  assert.ok(Math.abs(b.src1 - 20.1) < 0.3, `ends ${b.src1}`);
});

test('camera directions build a timeline with smooth transitions', async () => {
  const { cameraModeAt } = await import('../src/plan.js');
  const t = take([P('big camera', 0.5, 1.5), P('Hello and welcome to the demo', 2, 5), P('back to the screen', 5.5, 6.5), P('hide camera', 10, 11)], 14);
  const plan = buildPlan(t, { trimDeadAir: false });
  assert.deepEqual(plan.camera.map((c) => c.mode), ['small', 'big', 'small', 'hidden']);
  const mid = cameraModeAt(plan, 3);
  assert.equal(mid.to, 'big');
  assert.equal(mid.k, 1);
  // The spoken command is cut, so the glide happens just after the cut, in output time.
  const cutAt = plan.cuts.find((c) => c.src0 <= plan.camera[2].src && c.src1 >= plan.camera[2].src);
  const moving = cameraModeAt(plan, (cutAt ? cutAt.src1 : plan.camera[2].src) + 0.25);
  assert.deepEqual([moving.from, moving.to], ['big', 'small']);
  assert.ok(moving.k > 0 && moving.k < 1);
  assert.equal(plan.cuts.filter((c) => c.reason === 'command').length, 3, 'camera directions are cut from the video');
});

test('demo mode keeps directions and fumbles audible, under a cut overlay', () => {
  const t = take(
    [P('Here we open the settings', 1, 4), P('then we click the uh, the thing', 5, 8), P('scratch that', 8.6, 9.6), P('then we click save', 10.2, 12.5)],
    14,
  );
  const final = buildPlan(t, { trimDeadAir: false });
  const demo = buildPlan(t, { trimDeadAir: false, showDirections: true });
  const ghost = demo.segments.find((s) => s.ghost === 'fumble');
  assert.ok(ghost && ghost.rate >= 1 && ghost.rate <= 1.3, 'the fumble stays audible');
  assert.ok(ghost.src1 <= 8.6, 'the fumble ghost stops where "scratch that" begins');
  const said = demo.segments.find((s) => s.src0 <= 9 && s.src1 > 9);
  assert.equal(said.rate, 1, '"scratch that" is heard at normal speed');
  assert.ok(demo.outDuration > final.outDuration);
  assert.equal(demo.stats.removed, final.stats.removed, 'the summary still describes the final cut');
  assert.equal(demo.directions.length, 1);
  assert.equal(demo.directions[0].heard, 'scratch that');
});

test('camera directions inside a sentence are ignored', () => {
  const plan = buildPlan(take([P('we bought a big camera for the shoot', 1, 4)], 6), { trimDeadAir: false });
  assert.deepEqual(plan.camera.map((c) => c.mode), ['small']);
});

test('"cut the last 5 seconds" and "cut the last two sentences"', () => {
  const t = take([P('first sentence here', 1, 3), P('second sentence here', 4, 6), P('third sentence here', 7, 9), P('cut the last two sentences', 10, 11.5), P('keep this one', 12, 14)], 16);
  const plan = buildPlan(t, { trimDeadAir: false });
  const c = plan.cuts.find((x) => x.reason === 'cut');
  assert.ok(c.src0 > 3 && c.src0 < 4.2, `starts at the second sentence (${c.src0})`);
  assert.ok(c.src1 >= 11.2 && c.src1 < 12);
  const t2 = take([P('talking for a while now', 1, 9), P('cut the last 5 seconds', 10, 11.5)], 13);
  const c2 = buildPlan(t2, { trimDeadAir: false }).cuts.find((x) => x.reason === 'cut');
  assert.ok(Math.abs(c2.src0 - 5) < 0.3, `5s before the command (${c2.src0})`);
});

test('"cut from here" ... "cut till here" removes the stretch between', () => {
  const t = take([P('good part', 1, 3), P('cut from here', 4, 5), P('messy part', 6, 12), P('cut till here', 13, 14), P('good again', 15, 17)], 18);
  const c = buildPlan(t, { trimDeadAir: false }).cuts.find((x) => x.reason === 'cut');
  assert.ok(c.src0 > 3.5 && c.src0 < 4.2);
  assert.ok(c.src1 > 13.6 && c.src1 < 14.6);
});

test('"stop recording" ends the video there', () => {
  const plan = buildPlan(take([P('that is all', 1, 3), P('stop recording', 4, 5)], 8), { trimDeadAir: false });
  assert.ok(plan.finalDuration < 4.2 && plan.finalDuration > 3.5, `ends at ${plan.finalDuration}`);
});

test('hide for N seconds, until "show it", and the whole screen', () => {
  const motion = motionLog(30, [{ t0: 5, t1: 5.4, x0: 4, x1: 30, y0: 6, y1: 7 }]);
  const forTen = buildPlan(take([P('hide that for ten seconds', 6, 8)], 30, motion), { trimDeadAir: false }).blurs[0];
  assert.ok(Math.abs(forTen.src1 - 17.5) < 0.6, `ends ${forTen.src1}`);
  const until = buildPlan(take([P('hide that', 6, 7), P('show it', 20, 21)], 30, motion), { trimDeadAir: false }).blurs[0];
  assert.ok(Math.abs(until.src1 - 20) < 0.4, `ends as you say it: ${until.src1}`);
  const screen = buildPlan(take([P('hide the screen', 3, 4), P('show the screen', 9, 10)], 30), { trimDeadAir: false }).blurs[0];
  assert.equal(screen.full, true);
  assert.deepEqual(screen.box, { x: 0, y: 0, w: 1, h: 1 });
  assert.ok(screen.src1 > 8.5 && screen.src1 < 9.5);
});

test('smart final cut: commands are silenced while the screen moves, cut when it is still', () => {
  const moving = motionLog(12, [{ t0: 0, t1: 12, x0: 10, x1: 20, y0: 10, y1: 20 }]);
  const a = buildPlan(take([P('zoom in', 4, 5)], 12, moving), { trimDeadAir: false });
  assert.equal(a.mutes.length, 1, 'muted, picture kept');
  assert.equal(a.cuts.length, 0);
  const b = buildPlan(take([P('zoom in', 4, 5)], 12), { trimDeadAir: false });
  assert.equal(b.mutes.length, 0);
  assert.equal(b.cuts.filter((c) => c.reason === 'command').length, 1, 'cut, nothing visible jumps');
});

test('phrase timing is re-measured from the voice', async () => {
  const { refinePhrases } = await import('../src/plan.js');
  // Voice from 2.0 to 4.0; recognition reported 2.6 to 5.5 (late on both ends).
  const dt = 0.05, values = new Float32Array(200);
  for (let t = 2; t < 4; t += dt) values[Math.floor(t / dt)] = 0.3;
  const [p] = refinePhrases({ duration: 10, phrases: [P('hello there', 2.6, 5.5)], levels: { dt, values }, motion: [] }, 0.04);
  assert.ok(Math.abs(p.start - 2) < 0.15, `start ${p.start}`);
  assert.ok(Math.abs(p.end - 4.1) < 0.15, `end ${p.end}`);
});

// ---------------------------------------------------------------- round 3: languages, timing, smoothness

test('understands Spanish, French, German, Portuguese and Italian', () => {
  const said = ['corta eso', 'oculta eso', 'acércate', 'dézoome', 'versteck das', 'corta isso', 'nascondi lo schermo', 'Capítulo: instalación', 'borra la última frase', 'pichhle 5 second kaat do'];
  const cmds = parseCommands(said.map((s, i) => P(s, i * 3, i * 3 + 2)));
  assert.deepEqual(cmds.map((c) => c.type), ['cut', 'hide', 'zoomIn', 'zoomOut', 'hide', 'cut', 'hideScreen', 'chapter', 'cutSentences', 'cutSeconds']);
  assert.equal(cmds[7].label, 'Instalación');
  assert.equal(cmds[9].seconds, 5);
});

test('"pause" is understood however the recogniser spells it, and only on its own', () => {
  for (const s of ['pause', 'Pause.', 'pose', 'paws', 'hold on', 'one sec', 'ruko', 'pausa', 'pause the recording']) {
    assert.equal(parseCommands([P(s, 0, 1)])[0]?.type, 'pause', s);
  }
  for (const s of ['we paused for lunch', 'you can pause the video any time', 'wait until it loads', 'take a break from coding and stretch']) {
    assert.ok(!parseCommands([P(s, 0, 1)]).some((c) => c.type === 'pause'), s);
  }
  for (const s of ['resume', 'continue', 'chalu karo']) assert.equal(parseCommands([P(s, 0, 1)])[0]?.type, 'resume', s);
});

test('"pause" only counts where the recording really paused', () => {
  const t = take([P('so this is the app', 0, 3), P('pause', 4, 4.6), P('and we are back', 5, 7)], 8);
  const off = buildPlan(t, { trimDeadAir: false });
  assert.equal(off.commands.find((c) => c.type === 'pause').enabled, false);
  const on = buildPlan({ ...t, joins: [4.8] }, { trimDeadAir: false });
  const pause = on.commands.find((c) => c.type === 'pause');
  assert.equal(pause.enabled, true);
  assert.ok(on.cuts.some((c) => c.by === pause.id && c.src0 <= 4 && c.src1 >= 4.6), 'the word "pause" is cut');
});

test('words are placed where the voice actually is', async () => {
  const { alignWords } = await import('../src/plan.js');
  // "hello" voiced 1.0–1.5, silence, "world" voiced 2.5–3.0.
  const dt = 0.05, values = new Float32Array(80);
  for (let t = 1; t < 1.5; t += dt) values[Math.floor(t / dt)] = 0.3;
  for (let t = 2.5; t < 3; t += dt) values[Math.floor(t / dt)] = 0.3;
  const [a, b] = alignWords('hello world', 0.8, 3.2, { dt, values }, 0.04);
  assert.ok(a.start >= 0.95 && a.end <= 1.65, `hello ${a.start}-${a.end}`);
  assert.ok(b.start >= 2.4 && b.start <= 2.6, `world starts ${b.start}`);
});

test('fast-forward eases in and out, and source↔output time stays exact', () => {
  const t = take([P('speed this up', 2, 3), P('back to normal', 23, 24), P('done', 25, 26)], 27);
  const plan = buildPlan(t, { trimDeadAir: false, speed: 4 });
  const rates = plan.segments.map((s) => s.rate);
  assert.ok(rates.some((r) => r > 1 && r < 4), `has ramp steps: ${rates.map((r) => r.toFixed(2))}`);
  const iMax = rates.indexOf(4);
  for (let i = 1; i <= iMax; i++) assert.ok(rates[i] >= rates[i - 1] - 1e-9, 'rate rises steadily');
  for (let o = 0.1; o < plan.outDuration; o += 0.37) {
    const { src } = outToSrc(plan.segments, o);
    assert.ok(Math.abs(srcToOut(plan.segments, src, plan.outDuration) - o) < 1e-6);
  }
});

test('narration is never fast-forwarded', () => {
  const t = take([P('speed this up', 2, 3), P('this part matters so listen', 10, 13), P('normal speed', 23, 24)], 27);
  const plan = buildPlan(t, { trimDeadAir: false, speed: 4 });
  for (let s = 10; s < 12.6; s += 0.1) { // the voice runs 10 to 12.6 in this take
    const seg = plan.segments.find((g) => s >= g.src0 && s < g.src1);
    assert.ok(seg && seg.rate === 1, `normal speed at ${s.toFixed(1)}`);
  }
  assert.ok(plan.speeds.length >= 2, 'speeds up again after you stop talking');
});

test('the sound is already off when a silenced command starts, and before a cut', async () => {
  const { gainAt } = await import('../src/plan.js');
  const moving = motionLog(12, [{ t0: 0, t1: 12, x0: 10, x1: 20, y0: 10, y1: 20 }]);
  const plan = buildPlan(take([P('look at the chart', 1, 3.5), P('zoom in', 4, 5), P('there it is', 6, 8)], 12, moving), { trimDeadAir: false });
  const m = plan.mutes[0];
  assert.ok(m.src0 <= 4 - 0.1, `mute starts before the voice (${m.src0})`);
  assert.equal(gainAt(plan, m.src0 - 0.03), 0, 'already faded out just before the command');
  assert.equal(gainAt(plan, 7), 1);
  const cutPlan = buildPlan(take([P('hello and uh', 1, 3), P('scratch that', 3.5, 4.5), P('hello', 5, 6)], 8), { trimDeadAir: false });
  const seg = cutPlan.segments[0];
  assert.equal(gainAt(cutPlan, seg.src1 - 0.03), 0, 'faded out before the jump');
});

test('zoom glides never jump, even when "zoom out" interrupts "zoom in"', () => {
  const t = take([P('zoom in', 2, 2.6), P('zoom out', 2.9, 3.4), P('zoom in on the top left', 6, 7), P('zoom in more', 9, 10), P('zoom out', 12, 13)], 16);
  const plan = buildPlan(t, { trimDeadAir: false, commandStyle: 'mute' });
  let prev = cameraAt(plan, 0);
  for (let s = 0.02; s < 16; s += 0.02) {
    const c = cameraAt(plan, s);
    assert.ok(Math.abs(Math.log(c.scale / prev.scale)) < 0.05 && Math.abs(c.x - prev.x) < 0.02 && Math.abs(c.y - prev.y) < 0.02, `jump at ${s.toFixed(2)}`);
    prev = c;
  }
  assert.ok(cameraAt(plan, 15.9).scale < 1.01, 'ends zoomed out');
  assert.ok(cameraAt(plan, 11).scale > 2.5, '"more" went closer');
});

test('captions follow the words, leave out commands, and never overlap', () => {
  const t = take([P('first we open the settings page', 1, 4), P('zoom in', 4.5, 5.2), P('then we change the theme to dark', 6, 9)], 11);
  const plan = buildPlan(t, { trimDeadAir: false });
  const text = plan.captions.map((c) => c.text).join(' ');
  assert.ok(!/zoom/i.test(text), text);
  assert.ok(/settings/.test(text) && /dark/.test(text));
  for (let i = 1; i < plan.captions.length; i++) assert.ok(plan.captions[i].out0 >= plan.captions[i - 1].out1 - 1e-6, 'no overlap');
  for (const c of plan.captions) assert.ok(c.words.every((w, k) => k === 0 || w.out0 >= c.words[k - 1].out0), 'word times rise');
});

test('the demo version never skips over speech', () => {
  const t = take([P('so this is the uh the thing', 1, 4), P('scratch that', 4.5, 5.5), P('this is the dashboard', 6, 8), P('cut the last sentence', 8.5, 10), P('done', 12, 13)], 15);
  const demo = buildPlan(t, { showDirections: true });
  for (const p of t.phrases) for (let s = p.start + 0.1; s < p.end - 0.4; s += 0.1) {
    const seg = demo.segments.find((g) => s >= g.src0 && s < g.src1);
    assert.ok(seg && seg.rate <= 1.3, `audible at ${s.toFixed(1)} ("${p.text}")`);
  }
});

// ---------------------------------------------------------------- round 4: real recogniser timing

/** A take with the voice exactly where given (not tied to the reported phrase times). */
function voiceTake(phrases, voice, duration, motion = []) {
  const dt = 0.05;
  const values = new Float32Array(Math.ceil(duration / dt));
  for (const [a, b] of voice) for (let t = a; t < b; t += dt) values[Math.floor(t / dt + 1e-6)] = 0.3;
  return { duration, phrases, levels: { dt, values }, motion };
}

test('a late final result does not drag a command into the next sentence', async () => {
  const { gainAt } = await import('../src/plan.js');
  const moving = motionLog(12, [{ t0: 0, t1: 12, x0: 10, x1: 20, y0: 10, y1: 20 }]);
  // You said "zoom in" 4.0–4.6, then "so here is the chart we built" 4.9–7.4.
  // The recogniser reported "zoom in" as 4.2–6.5 (finalised while you were already talking).
  const t = voiceTake([P('zoom in', 4.2, 6.5), P('so here is the chart we built', 5.2, 8.6)], [[4, 4.6], [4.9, 7.4]], 12, moving);
  const plan = buildPlan(t, { trimDeadAir: false });
  const m = plan.mutes[0];
  assert.ok(m.src0 <= 3.95 && m.src1 >= 4.6 && m.src1 <= 4.9, `silenced ${m.src0.toFixed(2)}–${m.src1.toFixed(2)}`);
  assert.equal(gainAt(plan, 5.3), 1, 'the next sentence is heard');
  const z = plan.view.find((v) => v.scale > 1);
  assert.ok(z.src < 4.6, `zoom starts as you say it (${z.src.toFixed(2)})`);
  const cap = plan.captions.map((c) => c.text).join(' ');
  assert.ok(/^so here is the chart/.test(cap), cap);
});

test('a camera command run into the next sentence still works, and is silenced', async () => {
  const { cameraModeAt, gainAt } = await import('../src/plan.js');
  const moving = motionLog(12, [{ t0: 0, t1: 12, x0: 10, x1: 20, y0: 10, y1: 20 }]);
  // "back to the screen" 2.0–2.9, pause, "so here we have the chart" 3.2–4.8, all one phrase.
  const t = voiceTake([P('back to the screen so here we have the chart', 2.4, 6.2)], [[2, 2.9], [3.2, 4.8]], 12, moving);
  const plan = buildPlan({ ...t, cameraStart: 'big' }, { trimDeadAir: false });
  const cmd = plan.commands.find((c) => c.type === 'camSmall');
  assert.ok(cmd && cmd.enabled, 'recognised');
  assert.equal(cameraModeAt(plan, 4).to, 'small');
  assert.equal(gainAt(plan, 2.4), 0, 'command silenced');
  assert.equal(gainAt(plan, 3.6), 1, 'narration heard');
});

test('camera words inside a sentence, with no pause, are left alone', () => {
  const said = [P('we bought a big camera', 1, 3)];
  assert.equal(parseCommands(said).length, 0);
  const t = voiceTake([P('and this is how it looks with the big camera', 1, 4)], [[1, 4]], 6);
  const plan = buildPlan(t, { trimDeadAir: false });
  const c = plan.commands.find((x) => x.type === 'camBig');
  assert.ok(!c || !c.enabled, 'not acted on');
});

test('"scratch that" is understood however the recogniser spells it', () => {
  for (const s of ['scratch that', 'Scratched that.', 'stretch that', 'scratch it', 'oops', 'let me say that again']) {
    assert.equal(parseCommands([P(s, 0, 1)])[0]?.type, 'cut', s);
  }
});

test('"scratch that" works however the recogniser groups the words, and the retake survives', () => {
  const voice = [[1, 3.6], [4.1, 4.8], [5.3, 7.5]];
  const groupings = [
    [P('so first we open the uh the setting thingy scratch that first we open the settings', 1.4, 8.6)],
    [P('so first we open the uh the setting thingy', 1.4, 4.6), P('scratch that first we open the settings', 4.3, 8.6)],
    [P('so first we open the uh the setting thingy scratch that', 1.4, 5.6), P('first we open the settings', 5.6, 8.4)],
    [P('so first we open the uh the setting thingy', 1.4, 4.6), P('scratch that', 4.3, 6.0), P('first we open the settings', 5.6, 8.4)],
  ];
  for (const phrases of groupings) {
    const t = voiceTake(phrases, voice, 12);
    const final = buildPlan(t, { trimDeadAir: false });
    const cut = final.cuts.find((c) => c.reason === 'fumble');
    assert.ok(cut.src0 <= 1 && cut.src1 >= 4.8 && cut.src1 <= 5.3, `cut ${cut.src0.toFixed(2)}–${cut.src1.toFixed(2)}`);
    assert.equal(final.captions.map((c) => c.text).join(' '), 'first we open the settings');
    const demo = buildPlan(t, { trimDeadAir: false, showDirections: true });
    const d = demo.directions.find((x) => x.type === 'cut');
    assert.ok(d && Math.abs(d.src0 - 4.1) < 0.25, `card at ${d && d.src0.toFixed(2)}`);
    const seg = demo.segments.find((g) => 4.3 >= g.src0 && 4.3 < g.src1);
    assert.equal(seg.rate, 1, '"scratch that" plays at normal speed in the demo');
  }
});

test('the product name in a sentence is not a command', () => {
  assert.equal(parseCommands([P("hi, I'm going to show you how retake works", 0, 3)]).length, 0);
  assert.equal(parseCommands([P('retake', 0, 1)])[0]?.type, 'cut');
});

// ---------------------------------------------------------------- round 5

test('"hide that" on its own blurs for a few seconds, not to the end', async () => {
  const { HIDE_DEFAULT } = await import('../src/plan.js');
  const motion = motionLog(60, [{ t0: 5, t1: 5.4, x0: 4, x1: 30, y0: 6, y1: 7 }]);
  const b = buildPlan(take([P('hide that', 6, 7), P('much later, show it', 50, 52)], 60, motion), { trimDeadAir: false }).blurs[0];
  assert.ok(b.src1 < 7 + HIDE_DEFAULT + 0.5, `ends ${b.src1}`);
});

test('a late final result cannot stretch "scratch that" over the retake', () => {
  // You stumble 1–3.6, say "scratch that" 4.1–4.8, then the retake 5.0–7.5 with no
  // recogniser hint of when it started (its first result arrived very late).
  const t = voiceTake([P('so first we open the uh the setting thingy', 1.4, 4.0), P('scratch that', 4.4, 7.0), P('first we open the settings', 8.4, 9.5)], [[1, 3.6], [4.1, 4.8], [5.0, 7.5]], 12);
  const plan = buildPlan(t, { trimDeadAir: false });
  const cut = plan.cuts.find((c) => c.reason === 'fumble');
  assert.ok(cut.src1 <= 5.05, `cut ends ${cut.src1.toFixed(2)}, before the retake`);
  assert.ok(cut.src0 <= 1.05, 'the stumble is cut');
});

test('"scratch that" after a long sentence cuts only its last stretch', () => {
  // A 9-second phrase: two good sentences, a pause, then the stumble.
  const t = voiceTake([P('this dashboard shows the forecast for every city and it updates every hour so the uh the thing with the', 1.2, 10.4), P('scratch that', 10.8, 11.8)], [[1, 4.5], [4.8, 7.4], [8.1, 10.2], [10.7, 11.3]], 14);
  const plan = buildPlan(t, { trimDeadAir: false });
  const cut = plan.cuts.find((c) => c.reason === 'fumble');
  assert.ok(cut.src0 > 7.3 && cut.src0 < 8.2, `cut starts ${cut.src0.toFixed(2)}`);
});

test('a command dictated into the command box with Wispr Flow is timed from the voice and wins over the recogniser', async () => {
  const { gainAt } = await import('../src/plan.js');
  const moving = motionLog(12, [{ t0: 0, t1: 12, x0: 10, x1: 20, y0: 10, y1: 20 }]);
  // You said "zoom in on the top right" 4.0–5.2; Wispr typed it at 5.9.
  // Chrome misheard it as "soon in on the top right" and finalised it late.
  const misheard = voiceTake([P('here is the chart', 1, 3.2), P('soon in on the top right', 4.3, 6.8), { text: 'Zoom in on the top right.', start: 5.5, end: 5.9, typed: true }, P('it updates live', 7, 8.6)], [[1, 3], [4, 5.2], [7, 8.4]], 12, moving);
  const a = buildPlan(misheard, { trimDeadAir: false });
  const z = a.view.find((v) => v.scale > 1);
  assert.ok(z && Math.abs(z.src - 4.05) < 0.15, `zoom starts as you said it (${z && z.src.toFixed(2)})`);
  assert.ok(!a.captions.some((c) => /soon/.test(c.text)), 'the misheard words are not captioned');
  assert.equal(gainAt(a, 4.6), 0, 'the dictated command is silenced');
  assert.equal(gainAt(a, 7.6), 1);
  // Both heard it: one zoom, not two.
  const both = voiceTake([P('zoom in', 4.3, 6.0), { text: 'zoom in', start: 5.2, end: 5.6, typed: true }], [[4, 4.8]], 10, moving);
  assert.equal(buildPlan(both, { trimDeadAir: false }).commands.filter((c) => c.type === 'zoomIn').length, 1);
});

test('slides, points and switching the screen', async () => {
  const { cameraModeAt } = await import('../src/plan.js');
  const t = take([P('slide: why editing hurts', 1, 3), P('point: it takes hours', 4, 6), P('point: it needs skills', 7, 9), P('end slide', 10, 11), P('point: free', 13, 14), P('switch the screen', 16, 17), P('switch back', 20, 21)], 40);
  const plan = buildPlan(t, { trimDeadAir: false });
  const [slide, list] = plan.boards;
  assert.equal(slide.full, true);
  assert.equal(slide.title, 'Why editing hurts');
  assert.deepEqual(slide.items.map((i) => i.text), ['It takes hours', 'It needs skills']);
  assert.ok(slide.src1 > 9.5 && slide.src1 < 10.6, `slide ends ${slide.src1}`);
  assert.equal(list.full, false);
  assert.ok(list.src1 > 19.5 && list.src1 < 27, 'a list of points ends with "switch back" (or fades by itself)');
  assert.equal(cameraModeAt(plan, 18.5).to, 'swap');
  assert.equal(cameraModeAt(plan, 22.5).to, 'small');
});

test('a dictated command is matched to its own words even when you have started the next sentence', async () => {
  const { gainAt } = await import('../src/plan.js');
  const moving = motionLog(14, [{ t0: 0, t1: 14, x0: 10, x1: 20, y0: 10, y1: 20 }]);
  // "switch the screen" 4.0–5.0 (heard as "swish the scream"); next sentence from 5.7;
  // Wispr's text arrived at 5.9, while you were already talking.
  const t = voiceTake([P('swish the scream', 4.2, 6.6), { text: 'switch the screen', start: 5.8, end: 6.2, typed: true }, P('I built it the same way', 6.0, 8.5)], [[4, 5], [5.7, 8]], 14, moving);
  const plan = buildPlan({ ...t, cameraStart: 'small' }, { trimDeadAir: false });
  const swap = plan.camera.find((c) => c.mode === 'swap');
  assert.ok(swap && Math.abs(swap.src - 4.05) < 0.15, `switch at ${swap && swap.src.toFixed(2)}`);
  assert.equal(gainAt(plan, 4.5), 0, 'the dictated words are silenced');
  assert.equal(gainAt(plan, 6.4), 1, 'the next sentence is heard');
  assert.ok(!plan.captions.some((c) => /swish/.test(c.text)), 'the misheard words are not captioned');
  assert.ok(plan.captions.some((c) => /^I built/.test(c.text)), 'the next sentence is captioned whole');
});
