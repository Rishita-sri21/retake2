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

test('zoom eases in, holds and ends at "zoom out"', () => {
  const motion = motionLog(20, [{ t0: 3, t1: 5, x0: 40, x1: 60, y0: 2, y1: 10 }]);
  const plan = buildPlan(take([P('zoom here', 5, 6), P('look at that', 7, 9), P('zoom out', 12, 13)], 20, motion), { trimDeadAir: false });
  const z = plan.zooms[0];
  assert.ok(z.x > 0.6 && z.y < 0.35, 'aimed at the top right');
  assert.ok(Math.abs(z.src1 - 12) < 0.3);
  assert.equal(cameraAt(plan, z.src0).scale, 1);
  assert.equal(cameraAt(plan, (z.src0 + z.src1) / 2).scale, 2);
  assert.ok(z.x <= 0.75 && z.y >= 0.25, 'camera kept inside the frame');
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
  const moving = cameraModeAt(plan, plan.camera[2].src + 0.25);
  assert.deepEqual([moving.from, moving.to], ['big', 'small']);
  assert.ok(moving.k > 0 && moving.k < 1);
  assert.equal(plan.cuts.filter((c) => c.reason === 'command').length, 3, 'camera directions are cut from the video');
});

test('demo mode keeps directions audible and plays would-be cuts fast', () => {
  const t = take(
    [P('Here we open the settings', 1, 4), P('then we click the uh, the thing', 5, 8), P('scratch that', 8.6, 9.6), P('then we click save', 10.2, 12.5)],
    14,
  );
  const final = buildPlan(t, { trimDeadAir: false });
  const demo = buildPlan(t, { trimDeadAir: false, showDirections: true });
  const ghost = demo.segments.find((s) => s.ghost === 'fumble');
  assert.ok(ghost && ghost.rate === 3, 'the fumble plays fast');
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
