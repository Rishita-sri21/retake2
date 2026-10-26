// @ts-check
/**
 * Where on the screen did something just change?
 *
 * While recording, Retake samples the screen a few times a second into a tiny
 * grayscale grid and keeps, for each sample, which cells changed. That cheap
 * log answers the questions the commands need:
 *   - "zoom here" / "look here": where has the screen been changing just now?
 *   - "hide that": what region just appeared, and since when has it been visible?
 *
 * Pure functions over plain arrays, so they run in the browser and in tests.
 */

export const GRID_W = 64;
export const GRID_H = 36;

/**
 * @typedef {Object} MotionSample
 * @property {number} t           Seconds from the start.
 * @property {Uint8Array} changed GRID_W*GRID_H cells, 1 = changed since previous sample.
 * @property {number} count       Number of changed cells.
 */

/**
 * @typedef {Object} Box  Normalised 0..1 screen coordinates.
 * @property {number} x
 * @property {number} y
 * @property {number} w
 * @property {number} h
 */

/**
 * Convert RGBA pixels (any size that is a multiple of the grid) to a grayscale grid.
 * @param {Uint8ClampedArray} rgba
 * @param {number} width
 * @param {number} height
 * @returns {Uint8Array}
 */
export function toGrid(rgba, width, height) {
  const out = new Uint8Array(GRID_W * GRID_H);
  const sums = new Float64Array(GRID_W * GRID_H);
  const counts = new Uint32Array(GRID_W * GRID_H);
  for (let y = 0; y < height; y++) {
    const gy = Math.min(GRID_H - 1, Math.floor((y * GRID_H) / height));
    for (let x = 0; x < width; x++) {
      const gx = Math.min(GRID_W - 1, Math.floor((x * GRID_W) / width));
      const i = (y * width + x) * 4;
      const lum = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
      sums[gy * GRID_W + gx] += lum;
      counts[gy * GRID_W + gx]++;
    }
  }
  for (let k = 0; k < out.length; k++) out[k] = counts[k] ? Math.round(sums[k] / counts[k]) : 0;
  return out;
}

/**
 * @param {Uint8Array} prev
 * @param {Uint8Array} cur
 * @param {number} [threshold] Minimum luminance change (0–255) that counts.
 * @returns {{changed: Uint8Array, count: number}}
 */
export function diff(prev, cur, threshold = 6) {
  const changed = new Uint8Array(cur.length);
  let count = 0;
  for (let i = 0; i < cur.length; i++) {
    if (Math.abs(cur[i] - prev[i]) >= threshold) {
      changed[i] = 1;
      count++;
    }
  }
  return { changed, count };
}

/**
 * Sum the changed cells over samples in [t0, t1].
 * @param {MotionSample[]} log
 * @param {number} t0
 * @param {number} t1
 * @param {(s: MotionSample) => number} [weight]
 */
export function heat(log, t0, t1, weight = () => 1) {
  const h = new Float64Array(GRID_W * GRID_H);
  for (const s of log) {
    if (s.t < t0 || s.t > t1 || !s.count) continue;
    if (s.count > GRID_W * GRID_H * 0.6) continue; // a scene change or scroll, not a target
    const w = weight(s);
    for (let i = 0; i < s.changed.length; i++) if (s.changed[i]) h[i] += w;
  }
  return h;
}

/**
 * Largest connected blob of non-zero cells (8-neighbour), weighted by heat.
 * @param {Float64Array} h
 * @returns {{box: Box, cx: number, cy: number, mass: number, cells: number} | null}
 */
export function hottestBlob(h) {
  const seen = new Uint8Array(h.length);
  /** @type {{box: Box, cx: number, cy: number, mass: number, cells: number} | null} */
  let best = null;
  for (let start = 0; start < h.length; start++) {
    if (!h[start] || seen[start]) continue;
    let minX = GRID_W, minY = GRID_H, maxX = -1, maxY = -1, mass = 0, sx = 0, sy = 0, cells = 0;
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const i = /** @type {number} */ (stack.pop());
      const x = i % GRID_W, y = (i - x) / GRID_W;
      const m = h[i];
      mass += m; sx += (x + 0.5) * m; sy += (y + 0.5) * m; cells++;
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= GRID_W || ny >= GRID_H) continue;
          const j = ny * GRID_W + nx;
          if (h[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
        }
      }
    }
    // Rank by area × intensity, so a blinking caret (tiny area, constant
    // change) loses to the text that was just typed (wider area).
    if (!best || Math.sqrt(cells * mass) > Math.sqrt(best.cells * best.mass)) {
      best = {
        box: { x: minX / GRID_W, y: minY / GRID_H, w: (maxX - minX + 1) / GRID_W, h: (maxY - minY + 1) / GRID_H },
        cx: sx / mass / GRID_W,
        cy: sy / mass / GRID_H,
        mass,
        cells,
      };
    }
  }
  return best;
}

/**
 * Where to point the camera for "zoom here" / "look here" said at time t:
 * the centre of the busiest region in the few seconds before, favouring the most recent.
 * @param {MotionSample[]} log
 * @param {number} t
 * @param {number} [window]
 * @returns {{x: number, y: number, box: Box} | null}
 */
export function focusAt(log, t, window = 3) {
  const h = heat(log, t - window, t, (s) => 0.4 + 0.6 * (1 - (t - s.t) / window));
  const blob = hottestBlob(h);
  if (!blob) return null;
  return { x: blob.cx, y: blob.cy, box: blob.box };
}

/**
 * What to hide for "hide that" said at time t.
 *
 * Looks back for the most recent burst of change (samples no more than `gap`
 * seconds apart), takes the main region it touched, and reports when that
 * burst began, so the blur starts from the moment the secret first appeared,
 * not from when you noticed it.
 *
 * @param {MotionSample[]} log
 * @param {number} t
 * @param {{lookback?: number, gap?: number, ignoreLast?: number, pad?: number, minCells?: number}} [opts]
 * @returns {{box: Box, start: number} | null}
 */
export function secretAt(log, t, opts = {}) {
  const lookback = opts.lookback ?? 15;
  const gap = opts.gap ?? 1.2;
  const ignoreLast = opts.ignoreLast ?? 0.2;
  const pad = opts.pad ?? 1;
  const minCells = opts.minCells ?? 4; // smaller blobs are a moving cursor, not a secret
  const max = GRID_W * GRID_H * 0.6;
  // Tiny changes (a moving mouse, a blinking caret) are ignored entirely, so
  // they neither become the target nor chain separate bursts together.
  const candidates = log.filter((s) => s.t >= t - lookback && s.t <= t - ignoreLast && s.count >= minCells && s.count < max);
  if (!candidates.length) return null;

  // Split into bursts of change, newest first.
  /** @type {MotionSample[][]} */
  const bursts = [];
  for (let i = candidates.length - 1; i >= 0; i--) {
    const cur = bursts[bursts.length - 1];
    if (cur && cur[cur.length - 1].t - candidates[i].t <= gap) cur.push(candidates[i]);
    else bursts.push([candidates[i]]);
  }

  /** @type {MotionSample[]} */
  let burst = [];
  /** @type {ReturnType<typeof hottestBlob>} */
  let blob = null;
  for (const b of bursts) {
    const h = new Float64Array(GRID_W * GRID_H);
    for (const s of b) for (let i = 0; i < s.changed.length; i++) if (s.changed[i]) h[i] += 1;
    const found = hottestBlob(h);
    if (found && found.cells >= minCells) {
      burst = b;
      blob = found;
      break;
    }
  }
  if (!blob) return null;

  const px = pad / GRID_W, py = pad / GRID_H;
  const x = Math.max(0, blob.box.x - px);
  const y = Math.max(0, blob.box.y - py);
  const box = { x, y, w: Math.min(1 - x, blob.box.w + 2 * px), h: Math.min(1 - y, blob.box.h + 2 * py) };

  // The blur starts when this region began changing in this burst.
  const bx0 = Math.floor(blob.box.x * GRID_W), by0 = Math.floor(blob.box.y * GRID_H);
  const bx1 = Math.round((blob.box.x + blob.box.w) * GRID_W), by1 = Math.round((blob.box.y + blob.box.h) * GRID_H);
  const touches = (/** @type {MotionSample} */ s) => {
    for (let yy = by0; yy < by1; yy++) for (let xx = bx0; xx < bx1; xx++) if (s.changed[yy * GRID_W + xx]) return true;
    return false;
  };
  const inRegion = burst.filter(touches); // newest first
  const first = inRegion.length ? inRegion[inRegion.length - 1] : burst[burst.length - 1];
  return { box, start: Math.max(0, first.t - 0.25) };
}

/**
 * When did the hidden content leave the screen? The first moment after `after`
 * that most of the box changed at once (a tab switch, a scroll, a closed file).
 * @param {MotionSample[]} log
 * @param {Box} box
 * @param {number} after
 * @returns {number | null}
 */
export function goneAt(log, box, after) {
  const x0 = Math.floor(box.x * GRID_W), y0 = Math.floor(box.y * GRID_H);
  const x1 = Math.min(GRID_W, Math.ceil((box.x + box.w) * GRID_W)), y1 = Math.min(GRID_H, Math.ceil((box.y + box.h) * GRID_H));
  const area = Math.max(1, (x1 - x0) * (y1 - y0));
  for (const s of log) {
    if (s.t <= after) continue;
    let n = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) n += s.changed[y * GRID_W + x];
    if (n / area >= 0.35) return s.t;
  }
  return null;
}

/**
 * How busy the screen was between t0 and t1, as changed cells per sample (0..1).
 * @param {MotionSample[]} log
 * @param {number} t0
 * @param {number} t1
 */
export function activity(log, t0, t1) {
  let sum = 0, n = 0;
  for (const s of log) {
    if (s.t < t0 || s.t > t1) continue;
    sum += s.count / (GRID_W * GRID_H);
    n++;
  }
  return n ? sum / n : 0;
}
