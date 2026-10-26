// @ts-check
/**
 * Draws one finished frame: the source frame through the virtual camera
 * (zoom), with blurred secrets, spotlights, the camera bubble, title and
 * chapter cards, fast-forward badge, demo-mode labels and captions. Used
 * identically by the preview and by the export, so what you preview is
 * what you get.
 */
import { cameraAt, cameraModeAt, levelAt, segmentAt } from './plan.js';

/** @typedef {import('./plan.js').Plan} Plan */

export const FONT_DISPLAY = '"Fredoka", "Nunito", system-ui, sans-serif';
export const FONT_BODY = '"Nunito", system-ui, -apple-system, "Segoe UI", sans-serif';

/** Colours used inside the video. */
const INK = 'rgba(19, 21, 31, 0.84)';
const HONEY = '#ffc861';
const CORAL = '#ff7b86';

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
 * @property {{x: number, y: number} | null} camPos  Bubble centre (0..1), set by dragging; null = use the corner.
 */

/** @type {Look} */
export const DEFAULT_LOOK = {
  captions: true,
  captionSize: 0.044,
  badge: true,
  watermark: false,
  camera: true,
  camShape: 'circle',
  camCorner: 'br',
  camSize: 0.26,
  camPos: null,
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

  // Secrets: pixelate the region while it is on screen.
  for (const b of plan.blurs) {
    if (src < b.src0 || src > b.src1) continue;
    const sx = b.box.x * source.width, sy = b.box.y * source.height;
    const sw = b.box.w * source.width, sh = b.box.h * source.height;
    const dx = b.box.x * W, dy = b.box.y * H, dw = b.box.w * W, dh = b.box.h * H;
    const cell = Math.max(6, Math.round(H / 60));
    const pw = Math.max(1, Math.round(dw / cell)), ph = Math.max(1, Math.round(dh / cell));
    pix = pix || document.createElement('canvas');
    pix.width = pw;
    pix.height = ph;
    const p = /** @type {CanvasRenderingContext2D} */ (pix.getContext('2d'));
    p.imageSmoothingEnabled = true;
    p.drawImage(source.frame, sx, sy, sw, sh, 0, 0, pw, ph);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(pix, 0, 0, pw, ph, dx, dy, dw, dh);
    ctx.imageSmoothingEnabled = true;
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 2 / s;
    ctx.setLineDash([7 / s, 5 / s]);
    roundRect(ctx, dx, dy, dw, dh, 6 / s);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.restore();

  // Spotlight: dim everything but a soft circle around the target.
  for (const sp of plan.spots) {
    if (src < sp.src0 || src > sp.src1) continue;
    const k = Math.min(1, (src - sp.src0) / 0.35, (sp.src1 - src) / 0.45);
    const px = tx + sp.x * W * s, py = ty + sp.y * H * s;
    const r = H * 0.11 * (1 + 0.04 * Math.sin((src - sp.src0) * 6));
    ctx.save();
    const g = ctx.createRadialGradient(px, py, r * 0.95, px, py, r * 1.25);
    g.addColorStop(0, 'rgba(10,11,18,0)');
    g.addColorStop(1, `rgba(10,11,18,${0.58 * k})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = `rgba(255,200,97,${k})`;
    ctx.lineWidth = Math.max(3, H / 170);
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  // Demo mode: footage that the final cut removes is tinted and labelled.
  if (ghost) {
    ctx.save();
    ctx.fillStyle = 'rgba(255, 92, 110, 0.16)';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = CORAL;
    ctx.lineWidth = Math.max(4, H / 120);
    ctx.strokeRect(ctx.lineWidth / 2, ctx.lineWidth / 2, W - ctx.lineWidth, H - ctx.lineWidth);
    const label = ghost === 'fumble' ? 'Cut from the final video' : 'Dead air · trimmed from the final video';
    pill(ctx, W / 2, H * 0.06, label, `${rate}× ✂`, CORAL, H, 'center');
    ctx.restore();
  } else if (look.badge && rate > 1) {
    // Fast-forward badge.
    pill(ctx, W - H * 0.03, H * 0.035, 'Fast-forward', `${rate}× ▸▸`, HONEY, H, 'right');
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
  if (plan.title && out < 3.4) {
    const k = Math.min(1, out / 0.3, (3.4 - out) / 0.5);
    ctx.save();
    ctx.globalAlpha = k;
    const g = ctx.createLinearGradient(0, H * 0.4, 0, H);
    g.addColorStop(0, 'rgba(15,17,26,0)');
    g.addColorStop(1, 'rgba(15,17,26,0.92)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    const fs = Math.round(H * 0.08);
    ctx.font = `600 ${fs}px ${FONT_DISPLAY}`;
    const lines = wrapLines(ctx, plan.title, W - H * 0.14).slice(0, 3);
    const lh = fs * 1.12;
    const lastY = H * 0.88;
    const firstY = lastY - (lines.length - 1) * lh;
    ctx.fillStyle = HONEY;
    roundRect(ctx, H * 0.07, firstY - fs - H * 0.04, H * 0.1, H * 0.014, H * 0.007);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    lines.forEach((l, i) => ctx.fillText(l, H * 0.07, firstY + i * lh));
    ctx.restore();
  }

  // Chapter card.
  for (const c of plan.chapters) {
    const d = out - c.out;
    if (d < 0 || d > 2.8) continue;
    if (plan.title && c.out < 3.4) continue; // the title card is showing
    const k = Math.min(1, d / 0.35, (2.8 - d) / 0.4);
    const e = 1 - Math.pow(1 - k, 3);
    const fs = Math.round(H * 0.048);
    ctx.save();
    ctx.globalAlpha = Math.min(1, k * 1.5);
    ctx.font = `600 ${fs}px ${FONT_DISPLAY}`;
    const tw = ctx.measureText(c.title).width;
    const w = tw + fs * 1.8, h = fs * 2.15;
    const x = H * 0.05 - (1 - e) * H * 0.06, y = H * 0.07;
    ctx.fillStyle = INK;
    roundRect(ctx, x, y, w, h, h * 0.32);
    ctx.fill();
    ctx.fillStyle = HONEY;
    ctx.beginPath();
    ctx.arc(x + fs * 0.75, y + fs * 0.72, fs * 0.13, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = `700 ${Math.round(fs * 0.4)}px ${FONT_BODY}`;
    ctx.fillStyle = 'rgba(255,255,255,0.72)';
    ctx.fillText(`Chapter ${plan.chapters.indexOf(c) + 1}`, x + fs * 1.05, y + fs * 0.85);
    ctx.font = `600 ${fs}px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#ffffff';
    ctx.fillText(c.title, x + fs * 0.75, y + fs * 1.8);
    ctx.restore();
  }

  // Captions.
  if (look.captions) {
    const cap = plan.captions.find((c) => out >= c.out0 && out < c.out1);
    if (cap) {
      const fs = Math.round(H * look.captionSize);
      ctx.save();
      ctx.font = `700 ${fs}px ${FONT_BODY}`;
      const lines = wrapLines(ctx, cap.text, W * 0.78);
      const lh = fs * 1.32;
      const boxW = Math.max(...lines.map((l) => ctx.measureText(l).width)) + fs * 1.4;
      const boxH = lines.length * lh + fs * 0.7;
      const x = (W - boxW) / 2, y = H - boxH - H * 0.05;
      ctx.fillStyle = INK;
      roundRect(ctx, x, y, boxW, boxH, Math.min(boxH / 2, fs * 0.9));
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      lines.forEach((l, i) => ctx.fillText(l, W / 2, y + fs * 0.35 + lh * (i + 0.78)));
      ctx.restore();
    }
  }

  if (look.watermark) {
    ctx.save();
    ctx.font = `600 ${Math.round(H * 0.026)}px ${FONT_DISPLAY}`;
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.textAlign = 'right';
    ctx.fillText('edited by voice · Retake', W - H * 0.03, H - H * 0.025);
    ctx.restore();
  }
}

/**
 * A rounded label: a coloured lead word and a strong value.
 * @param {CanvasRenderingContext2D} ctx @param {number} x @param {number} y
 * @param {string} label @param {string} value @param {string} color @param {number} H
 * @param {'left'|'center'|'right'} align
 */
function pill(ctx, x, y, label, value, color, H, align) {
  const fs = Math.round(H * 0.03);
  ctx.save();
  ctx.font = `700 ${fs}px ${FONT_BODY}`;
  const lw = ctx.measureText(label).width;
  ctx.font = `800 ${fs}px ${FONT_BODY}`;
  const vw = ctx.measureText(value).width;
  const w = lw + vw + fs * 2.2, h = fs * 2;
  const left = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
  ctx.fillStyle = INK;
  roundRect(ctx, left, y, w, h, h / 2);
  ctx.fill();
  ctx.font = `700 ${fs}px ${FONT_BODY}`;
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.fillText(label, left + fs * 0.8, y + fs * 1.35);
  ctx.font = `800 ${fs}px ${FONT_BODY}`;
  ctx.fillStyle = color;
  ctx.fillText(value, left + fs * 1.4 + lw, y + fs * 1.35);
  ctx.restore();
}

/**
 * Demo-mode card: a microphone dot, what was said, and what happened.
 * @param {CanvasRenderingContext2D} ctx @param {number} W @param {number} H @param {string} heard @param {string} did
 */
function directionCard(ctx, W, H, heard, did) {
  const fs = Math.round(H * 0.046);
  const small = Math.round(fs * 0.6);
  ctx.font = `600 ${fs}px ${FONT_DISPLAY}`;
  const q = `“${heard}”`;
  const qw = ctx.measureText(q).width;
  ctx.font = `700 ${small}px ${FONT_BODY}`;
  const dw = ctx.measureText(did).width;
  const w = Math.max(qw, dw) + fs * 3.6, h = fs * 2.9;
  const x = (W - w) / 2, y = H * 0.025;
  ctx.fillStyle = INK;
  roundRect(ctx, x, y, w, h, h * 0.36);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,200,97,0.55)';
  ctx.lineWidth = 2;
  ctx.stroke();
  // Mic glyph
  const mx = x + fs * 1.1, my = y + h / 2;
  ctx.fillStyle = HONEY;
  ctx.beginPath();
  ctx.arc(mx, my, fs * 0.55, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#1b1608';
  roundRect(ctx, mx - fs * 0.12, my - fs * 0.3, fs * 0.24, fs * 0.42, fs * 0.12);
  ctx.fill();
  ctx.fillRect(mx - fs * 0.02, my + fs * 0.12, fs * 0.04, fs * 0.16);
  ctx.font = `600 ${fs}px ${FONT_DISPLAY}`;
  ctx.fillStyle = '#ffffff';
  ctx.fillText(q, x + fs * 2.2, y + fs * 1.3);
  ctx.font = `700 ${small}px ${FONT_BODY}`;
  ctx.fillStyle = HONEY;
  ctx.fillText(did, x + fs * 2.2, y + fs * 2.25);
}

/**
 * Where the bubble sits for a mode.
 * @param {'small'|'big'|'hidden'} mode @param {number} W @param {number} H @param {Look} look
 */
export function camRect(mode, W, H, look) {
  const d = H * look.camSize;
  const m = H * 0.04;
  let x, y;
  if (look.camPos) {
    x = Math.max(0, Math.min(W - d, look.camPos.x * W - d / 2));
    y = Math.max(0, Math.min(H - d, look.camPos.y * H - d / 2));
  } else {
    const right = look.camCorner.endsWith('r'), bottom = look.camCorner.startsWith('b');
    x = right ? W - d - m : m;
    // Keep clear of captions at the bottom centre and chapter cards at the top left.
    y = bottom ? H - d - m - H * 0.02 : m + H * 0.02;
  }
  if (mode === 'big') {
    const D = H * 0.54;
    return { x: (W - D) / 2, y: H * 0.18, d: D, a: 1 };
  }
  if (mode === 'hidden') return { x: x + d / 2, y: y + d / 2, d: 0, a: 0 };
  return { x, y, d, a: 1 };
}

/**
 * The presenter bubble: your camera, mirrored, cropped to fill, with a ring
 * that lights up while you speak.
 * @param {CanvasRenderingContext2D} ctx @param {number} W @param {number} H
 * @param {{frame: CanvasImageSource, width: number, height: number}} cam
 * @param {Plan} plan @param {number} src @param {Look} look
 */
function drawCamera(ctx, W, H, cam, plan, src, look) {
  const { from, to, k } = cameraModeAt(plan, src);
  const A = camRect(from, W, H, look), B = camRect(to, W, H, look);
  const r = { x: A.x + (B.x - A.x) * k, y: A.y + (B.y - A.y) * k, d: A.d + (B.d - A.d) * k, a: A.a + (B.a - A.a) * k };
  if (r.d < 2 || r.a <= 0.01 || !cam.width) return;

  // Big mode softly dims the screen behind you.
  const bigness = (from === 'big' ? 1 - k : 0) + (to === 'big' ? k : 0);
  if (bigness > 0) {
    ctx.save();
    ctx.fillStyle = `rgba(15,17,26,${0.74 * bigness})`;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  const radius = look.camShape === 'circle' ? r.d / 2 : r.d * 0.22;
  const path = () => {
    ctx.beginPath();
    if (look.camShape === 'circle') ctx.arc(r.x + r.d / 2, r.y + r.d / 2, r.d / 2, 0, Math.PI * 2);
    else roundRect(ctx, r.x, r.y, r.d, r.d, radius);
  };

  ctx.save();
  ctx.globalAlpha = r.a;
  ctx.shadowColor = 'rgba(0,0,0,0.4)';
  ctx.shadowBlur = H * 0.035;
  ctx.shadowOffsetY = H * 0.01;
  path();
  ctx.fillStyle = '#1a1c26';
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

  // Ring: soft white, glowing honey while you talk.
  const talking = levelAt(plan, src) > (plan.levelThreshold || 0.04) * 1.3;
  ctx.save();
  ctx.globalAlpha = r.a;
  path();
  ctx.lineWidth = Math.max(3, r.d * 0.028);
  ctx.strokeStyle = talking ? HONEY : 'rgba(255,255,255,0.88)';
  if (talking) {
    ctx.shadowColor = 'rgba(255,200,97,0.6)';
    ctx.shadowBlur = r.d * 0.08;
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
