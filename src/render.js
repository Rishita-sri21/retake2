// @ts-check
/**
 * Draws one finished frame: the source frame through the virtual camera
 * (zoom), with blurred secrets, spotlights, the camera bubble, title and
 * chapter cards, fast-forward badge, demo-mode labels and captions. Used
 * identically by the preview and by the export, so what you preview is
 * what you get.
 */
import { cameraAt, cameraModeAt, camPathAt, levelAt, segmentAt } from './plan.js';

/** @typedef {import('./plan.js').Plan} Plan */

export const FONT_DISPLAY = '"Instrument Serif", "Iowan Old Style", Georgia, serif';
export const FONT_BODY = '"Instrument Sans", system-ui, -apple-system, "Segoe UI", sans-serif';

/** Colours used inside the video. */
const INK = 'rgba(14, 14, 17, 0.8)';
const IVORY = '#f4f1ea';
const CHAMPAGNE = '#e8c9a0';
const ROSE = '#ec8f8f';

/**
 * @typedef {Object} Look
 * @property {boolean} captions
 * @property {number} captionSize   Relative to frame height (0.03–0.06).
 * @property {boolean} badge        Show the fast-forward badge.
 * @property {boolean} watermark
 * @property {boolean} camera       Show the camera bubble (when the take has one).
 * @property {'circle'|'rounded'} camShape
 * @property {'br'|'bl'|'tr'|'tl'} camCorner
 * @property {number} camSize      Bubble diameter relative to frame height.
 * @property {{x: number, y: number} | null} camPos  Bubble centre (0..1), set by dragging in the editor.
 * @property {boolean} followPath  Follow where the floating bubble was moved during recording.
 */

/** @type {Look} */
export const DEFAULT_LOOK = {
  captions: true,
  captionSize: 0.042,
  badge: true,
  watermark: false,
  camera: true,
  camShape: 'circle',
  camCorner: 'br',
  camSize: 0.26,
  camPos: null,
  followPath: true,
};

/** Small canvas reused for pixelation. */
let pix = /** @type {HTMLCanvasElement | null} */ (null);

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} W
 * @param {number} H
 * @param {{frame: CanvasImageSource, width: number, height: number}} source
 * @param {Plan} plan
 * @param {number} src   Source time of this frame.
 * @param {number} out   Output time of this frame.
 * @param {number} rate  Playback rate of the current segment.
 * @param {Look} look
 * @param {{frame: CanvasImageSource, width: number, height: number} | null} [camera]
 */
export function drawFrame(ctx, W, H, source, plan, src, out, rate, look, camera = null) {
  const cam = cameraAt(plan, src);
  const s = cam.scale;
  const tx = Math.min(0, Math.max(W - W * s, W / 2 - cam.x * W * s));
  const ty = Math.min(0, Math.max(H - H * s, H / 2 - cam.y * H * s));
  const seg = segmentAt(plan.segments, src);
  const ghost = seg && src >= seg.src0 ? seg.ghost : undefined;

  ctx.save();
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  ctx.setTransform(s, 0, 0, s, tx, ty);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(source.frame, 0, 0, W, H);

  // Secrets: pixelate the region (or the whole screen) while it's hidden.
  for (const b of plan.blurs) {
    if (src < b.src0 || src > b.src1) continue;
    const fade = Math.min(1, (src - b.src0) / 0.25, (b.src1 - src) / 0.25);
    const sx = b.box.x * source.width, sy = b.box.y * source.height;
    const sw = b.box.w * source.width, sh = b.box.h * source.height;
    const dx = b.box.x * W, dy = b.box.y * H, dw = b.box.w * W, dh = b.box.h * H;
    const cell = b.full ? Math.round(H / 22) : Math.max(6, Math.round(H / 60));
    const pw = Math.max(1, Math.round(dw / cell)), ph = Math.max(1, Math.round(dh / cell));
    pix = pix || document.createElement('canvas');
    pix.width = pw;
    pix.height = ph;
    const p = /** @type {CanvasRenderingContext2D} */ (pix.getContext('2d'));
    p.imageSmoothingEnabled = true;
    p.drawImage(source.frame, sx, sy, sw, sh, 0, 0, pw, ph);
    ctx.save();
    ctx.globalAlpha = b.full ? Math.max(0.001, fade) : 1;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(pix, 0, 0, pw, ph, dx, dy, dw, dh);
    ctx.restore();
    if (!b.full) {
      ctx.strokeStyle = 'rgba(244,241,234,0.55)';
      ctx.lineWidth = 1.5 / s;
      ctx.setLineDash([6 / s, 5 / s]);
      roundRect(ctx, dx, dy, dw, dh, 6 / s);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  ctx.restore();

  // Whole-screen hide: a calm label over the blur.
  for (const b of plan.blurs) {
    if (!b.full || src < b.src0 || src > b.src1) continue;
    const fade = Math.min(1, (src - b.src0) / 0.25, (b.src1 - src) / 0.25);
    ctx.save();
    ctx.globalAlpha = fade;
    ctx.fillStyle = 'rgba(14,14,17,0.35)';
    ctx.fillRect(0, 0, W, H);
    ctx.font = `italic 400 ${Math.round(H * 0.06)}px ${FONT_DISPLAY}`;
    ctx.fillStyle = IVORY;
    ctx.textAlign = 'center';
    ctx.fillText('Hidden for privacy', W / 2, H * 0.5);
    ctx.restore();
  }

  // Spotlight: dim everything but a soft circle around the target.
  for (const sp of plan.spots) {
    if (src < sp.src0 || src > sp.src1) continue;
    const k = Math.min(1, (src - sp.src0) / 0.35, (sp.src1 - src) / 0.45);
    const px = tx + sp.x * W * s, py = ty + sp.y * H * s;
    const r = H * 0.11 * (1 + 0.03 * Math.sin((src - sp.src0) * 5));
    ctx.save();
    const g = ctx.createRadialGradient(px, py, r * 0.95, px, py, r * 1.3);
    g.addColorStop(0, 'rgba(8,8,10,0)');
    g.addColorStop(1, `rgba(8,8,10,${0.6 * k})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = `rgba(232,201,160,${k})`;
    ctx.lineWidth = Math.max(2, H / 260);
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  // Demo mode: footage the final cut removes is tinted and labelled.
  if (ghost) {
    ctx.save();
    ctx.fillStyle = 'rgba(236, 143, 143, 0.14)';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = ROSE;
    ctx.lineWidth = Math.max(3, H / 160);
    ctx.strokeRect(ctx.lineWidth / 2, ctx.lineWidth / 2, W - ctx.lineWidth, H - ctx.lineWidth);
    const label = ghost === 'dead-air' ? 'Dead air, trimmed in the final video' : 'Cut from the final video';
    pill(ctx, W / 2, H * 0.035, label, `${rate}×`, ROSE, H, 'center');
    ctx.restore();
  } else if (look.badge && rate > 1) {
    pill(ctx, W - H * 0.03, H * 0.035, 'Fast-forward', `${rate}×`, CHAMPAGNE, H, 'right');
  }

  if (camera && look.camera) drawCamera(ctx, W, H, camera, plan, src, look);

  // Demo mode: what you said, and what Retake did about it.
  if (plan.showDirections) {
    const d = [...plan.directions].reverse().find((x) => src >= x.src0 && src <= x.src1);
    if (d) {
      const k = Math.min(1, (src - d.src0) / 0.25, (d.src1 - src) / 0.35);
      ctx.save();
      ctx.globalAlpha = Math.max(0, k);
      directionCard(ctx, W, H, d.heard, d.did);
      ctx.restore();
    }
  }

  // Opening title card.
  if (plan.title && out < 3.6) {
    const k = Math.min(1, out / 0.4, (3.6 - out) / 0.6);
    ctx.save();
    ctx.globalAlpha = k;
    const g = ctx.createLinearGradient(0, H * 0.35, 0, H);
    g.addColorStop(0, 'rgba(12,12,14,0)');
    g.addColorStop(1, 'rgba(12,12,14,0.9)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    const fs = Math.round(H * 0.095);
    ctx.font = `400 ${fs}px ${FONT_DISPLAY}`;
    const lines = wrapLines(ctx, plan.title, W - H * 0.16).slice(0, 3);
    const lh = fs * 1.02;
    const lastY = H * 0.87;
    const firstY = lastY - (lines.length - 1) * lh;
    ctx.font = `600 ${Math.round(H * 0.022)}px ${FONT_BODY}`;
    ctx.fillStyle = CHAMPAGNE;
    letterSpaced(ctx, 'A RETAKE FILM', H * 0.08, firstY - fs - H * 0.015, H * 0.004);
    ctx.font = `400 ${fs}px ${FONT_DISPLAY}`;
    ctx.fillStyle = IVORY;
    lines.forEach((l, i) => ctx.fillText(l, H * 0.08, firstY + i * lh));
    ctx.restore();
  }

  // Chapter card.
  for (const c of plan.chapters) {
    const d = out - c.out;
    if (d < 0 || d > 3) continue;
    if (plan.title && c.out < 3.6) continue; // the title card is showing
    const k = Math.min(1, d / 0.4, (3 - d) / 0.5);
    const e = 1 - Math.pow(1 - k, 3);
    const fs = Math.round(H * 0.058);
    ctx.save();
    ctx.globalAlpha = Math.min(1, k * 1.4);
    ctx.font = `italic 400 ${fs}px ${FONT_DISPLAY}`;
    const tw = ctx.measureText(c.title).width;
    const w = tw + fs * 1.4, h = fs * 2.2;
    const x = H * 0.05 - (1 - e) * H * 0.04, y = H * 0.06;
    ctx.fillStyle = INK;
    roundRect(ctx, x, y, w, h, h * 0.18);
    ctx.fill();
    ctx.font = `600 ${Math.round(fs * 0.3)}px ${FONT_BODY}`;
    ctx.fillStyle = CHAMPAGNE;
    letterSpaced(ctx, `CHAPTER ${plan.chapters.indexOf(c) + 1}`, x + fs * 0.7, y + fs * 0.72, fs * 0.05);
    ctx.font = `italic 400 ${fs}px ${FONT_DISPLAY}`;
    ctx.fillStyle = IVORY;
    ctx.fillText(c.title, x + fs * 0.7, y + fs * 1.75);
    ctx.restore();
  }

  // Captions.
  if (look.captions) {
    const cap = plan.captions.find((c) => out >= c.out0 && out < c.out1);
    if (cap) {
      const fs = Math.round(H * look.captionSize);
      const k = Math.min(1, (out - cap.out0) / 0.12, (cap.out1 - out) / 0.12);
      ctx.save();
      ctx.globalAlpha = Math.max(0, k);
      ctx.font = `500 ${fs}px ${FONT_BODY}`;
      const lines = wrapLines(ctx, cap.text, W * 0.74);
      const lh = fs * 1.35;
      const boxW = Math.max(...lines.map((l) => ctx.measureText(l).width)) + fs * 1.5;
      const boxH = lines.length * lh + fs * 0.6;
      const x = (W - boxW) / 2, y = H - boxH - H * 0.055;
      ctx.fillStyle = INK;
      roundRect(ctx, x, y, boxW, boxH, fs * 0.45);
      ctx.fill();
      ctx.fillStyle = IVORY;
      ctx.textAlign = 'center';
      lines.forEach((l, i) => ctx.fillText(l, W / 2, y + fs * 0.3 + lh * (i + 0.76)));
      ctx.restore();
    }
  }

  if (look.watermark) {
    ctx.save();
    ctx.font = `italic 400 ${Math.round(H * 0.03)}px ${FONT_DISPLAY}`;
    ctx.fillStyle = 'rgba(244,241,234,0.6)';
    ctx.textAlign = 'right';
    ctx.fillText('edited by voice with Retake', W - H * 0.03, H - H * 0.025);
    ctx.restore();
  }
}

/** Draw text with tracking (canvas letterSpacing isn't everywhere yet). */
/** @param {CanvasRenderingContext2D} ctx @param {string} text @param {number} x @param {number} y @param {number} gap */
function letterSpaced(ctx, text, x, y, gap) {
  let at = x;
  for (const ch of text) {
    ctx.fillText(ch, at, y);
    at += ctx.measureText(ch).width + gap;
  }
}

/**
 * A rounded label: a quiet lead and a coloured value.
 * @param {CanvasRenderingContext2D} ctx @param {number} x @param {number} y
 * @param {string} label @param {string} value @param {string} color @param {number} H
 * @param {'left'|'center'|'right'} align
 */
function pill(ctx, x, y, label, value, color, H, align) {
  const fs = Math.round(H * 0.026);
  ctx.save();
  ctx.font = `500 ${fs}px ${FONT_BODY}`;
  const lw = ctx.measureText(label).width;
  ctx.font = `600 ${fs}px ${FONT_BODY}`;
  const vw = ctx.measureText(value).width;
  const w = lw + vw + fs * 2.4, h = fs * 2.1;
  const left = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
  ctx.fillStyle = INK;
  roundRect(ctx, left, y, w, h, h / 2);
  ctx.fill();
  ctx.font = `500 ${fs}px ${FONT_BODY}`;
  ctx.fillStyle = 'rgba(244,241,234,0.85)';
  ctx.fillText(label, left + fs * 0.9, y + fs * 1.4);
  ctx.font = `600 ${fs}px ${FONT_BODY}`;
  ctx.fillStyle = color;
  ctx.fillText(value, left + fs * 1.5 + lw, y + fs * 1.4);
  ctx.restore();
}

/**
 * Demo-mode card: what was said (in italics) and what happened.
 * @param {CanvasRenderingContext2D} ctx @param {number} W @param {number} H @param {string} heard @param {string} did
 */
function directionCard(ctx, W, H, heard, did) {
  const fs = Math.round(H * 0.05);
  const small = Math.round(fs * 0.5);
  ctx.font = `italic 400 ${fs}px ${FONT_DISPLAY}`;
  const q = `“${heard}”`;
  const qw = ctx.measureText(q).width;
  ctx.font = `500 ${small}px ${FONT_BODY}`;
  const dw = ctx.measureText(did).width;
  const pad = fs * 0.8;
  const dot = fs * 0.5;
  const w = Math.max(qw, dw) + pad * 2 + dot + fs * 0.4, h = fs * 2.35;
  const x = (W - w) / 2, y = H * 0.03;
  ctx.fillStyle = INK;
  roundRect(ctx, x, y, w, h, h * 0.22);
  ctx.fill();
  ctx.strokeStyle = 'rgba(232,201,160,0.45)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  // A small recording-style dot: "this was spoken".
  ctx.fillStyle = CHAMPAGNE;
  ctx.beginPath();
  ctx.arc(x + pad + dot / 2, y + fs * 1.0, dot / 2, 0, Math.PI * 2);
  ctx.fill();
  const tx = x + pad + dot + fs * 0.4;
  ctx.font = `italic 400 ${fs}px ${FONT_DISPLAY}`;
  ctx.fillStyle = IVORY;
  ctx.fillText(q, tx, y + fs * 1.25);
  ctx.font = `500 ${small}px ${FONT_BODY}`;
  ctx.fillStyle = CHAMPAGNE;
  ctx.fillText(did, tx, y + fs * 1.95);
}

/**
 * Where the bubble sits for a mode.
 * @param {'small'|'big'|'hidden'} mode @param {number} W @param {number} H @param {Look} look
 * @param {{x: number, y: number} | null} [center]  Overrides the corner (dragged, or followed path).
 */
export function camRect(mode, W, H, look, center = null) {
  const d = H * look.camSize;
  const m = H * 0.04;
  let x, y;
  const c = look.camPos || center;
  if (c) {
    x = Math.max(0, Math.min(W - d, c.x * W - d / 2));
    y = Math.max(0, Math.min(H - d, c.y * H - d / 2));
  } else {
    const right = look.camCorner.endsWith('r'), bottom = look.camCorner.startsWith('b');
    x = right ? W - d - m : m;
    y = bottom ? H - d - m - H * 0.02 : m + H * 0.02;
  }
  if (mode === 'big') {
    const D = H * 0.54;
    return { x: (W - D) / 2, y: H * 0.18, d: D, a: 1 };
  }
  if (mode === 'hidden') return { x: x + d / 2, y: y + d / 2, d: 0, a: 0 };
  return { x, y, d, a: 1 };
}

/** The bubble's centre from the recording path, if following it. @param {Plan} plan @param {number} src @param {Look} look */
export function pathCenter(plan, src, look) {
  return look.followPath ? camPathAt(plan, src) : null;
}

/**
 * The presenter bubble: your camera, mirrored, cropped to fill, with a ring
 * that warms while you speak.
 * @param {CanvasRenderingContext2D} ctx @param {number} W @param {number} H
 * @param {{frame: CanvasImageSource, width: number, height: number}} cam
 * @param {Plan} plan @param {number} src @param {Look} look
 */
function drawCamera(ctx, W, H, cam, plan, src, look) {
  const { from, to, k } = cameraModeAt(plan, src);
  const center = pathCenter(plan, src, look);
  const A = camRect(from, W, H, look, center), B = camRect(to, W, H, look, center);
  const r = { x: A.x + (B.x - A.x) * k, y: A.y + (B.y - A.y) * k, d: A.d + (B.d - A.d) * k, a: A.a + (B.a - A.a) * k };
  if (r.d < 2 || r.a <= 0.01 || !cam.width) return;

  // Big mode softly dims the screen behind you.
  const bigness = (from === 'big' ? 1 - k : 0) + (to === 'big' ? k : 0);
  if (bigness > 0) {
    ctx.save();
    ctx.fillStyle = `rgba(12,12,14,${0.76 * bigness})`;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  const radius = look.camShape === 'circle' ? r.d / 2 : r.d * 0.2;
  const path = () => {
    ctx.beginPath();
    if (look.camShape === 'circle') ctx.arc(r.x + r.d / 2, r.y + r.d / 2, r.d / 2, 0, Math.PI * 2);
    else roundRect(ctx, r.x, r.y, r.d, r.d, radius);
  };

  ctx.save();
  ctx.globalAlpha = r.a;
  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = H * 0.04;
  ctx.shadowOffsetY = H * 0.01;
  path();
  ctx.fillStyle = '#17171a';
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.clip();
  // Cover-crop the camera to a square, mirrored like a selfie view.
  const side = Math.min(cam.width, cam.height);
  const sx = (cam.width - side) / 2, sy = (cam.height - side) / 2;
  ctx.translate(r.x + r.d, r.y);
  ctx.scale(-1, 1);
  ctx.drawImage(cam.frame, sx, sy, side, side, 0, 0, r.d, r.d);
  ctx.restore();

  // Ring: soft ivory, warming to champagne while you talk.
  const talking = levelAt(plan, src) > (plan.levelThreshold || 0.04) * 1.3;
  ctx.save();
  ctx.globalAlpha = r.a;
  path();
  ctx.lineWidth = Math.max(2.5, r.d * 0.022);
  ctx.strokeStyle = talking ? CHAMPAGNE : 'rgba(244,241,234,0.85)';
  if (talking) {
    ctx.shadowColor = 'rgba(232,201,160,0.55)';
    ctx.shadowBlur = r.d * 0.07;
  }
  ctx.stroke();
  ctx.restore();
}

/** @param {CanvasRenderingContext2D} ctx @param {number} x @param {number} y @param {number} w @param {number} h @param {number} r */
function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** @param {CanvasRenderingContext2D} ctx @param {string} text @param {number} max */
function wrapLines(ctx, text, max) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > max && line) {
      lines.push(line);
      line = w;
    } else line = test;
  }
  if (line) lines.push(line);
  return lines;
}
