// @ts-check
/** Line icons (24×24, stroke = currentColor) for each direction and a few controls. */

const P = {
  cut: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.12 15.88M14.47 14.48 20 20M8.12 8.12 12 12"/>',
  hide: '<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.4 10.4 0 0 1 12 5c7 0 10 7 10 7a13.2 13.2 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.5 13.5 0 0 0 2 12s3 7 10 7a9.7 9.7 0 0 0 5.39-1.61"/><path d="m2 2 20 20"/>',
  zoomIn: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3M11 8v6M8 11h6"/>',
  zoomOut: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3M8 11h6"/>',
  highlight: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  speedUp: '<path d="m13 19 9-7-9-7zM2 19l9-7-9-7z"/>',
  normalSpeed: '<path d="m7 4 13 8-13 8z"/>',
  chapter: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1zM4 22v-7"/>',
  title: '<path d="M4 7V4h16v3M9 20h6M12 4v16"/>',
  mark: '<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
  camBig: '<circle cx="12" cy="9" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  camSmall: '<rect x="2" y="4" width="20" height="16" rx="3"/><circle cx="16.5" cy="14.5" r="2.5"/>',
  camHide: '<path d="M10.66 6H14a2 2 0 0 1 2 2v2.34l1 1L22 8v8M16 16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2zM2 2l20 20"/>',
  camShow: '<path d="m22 8-6 4 6 4z"/><rect x="2" y="6" width="14" height="12" rx="2"/>',
  mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v4"/>',
  play: '<path d="m7 4 13 8-13 8z"/>',
  pause: '<path d="M7 4h4v16H7zM13 4h4v16h-4z"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>',
  sparkle: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/>',
};

/**
 * @param {keyof typeof P | string} name
 * @param {string} [cls]
 */
export function icon(name, cls = 'ico') {
  const body = P[/** @type {keyof typeof P} */ (name)] ?? P.sparkle;
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

/** @param {string} name */
export function iconEl(name, cls = 'ico') {
  const t = document.createElement('template');
  t.innerHTML = icon(name, cls);
  return /** @type {SVGElement} */ (t.content.firstElementChild);
}
