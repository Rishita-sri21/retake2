// @ts-check
/**
 * The director's vocabulary.
 *
 * While recording, you narrate as normal. Some phrases are directions to the
 * editor rather than narration: "scratch that", "zoom here", "hide that".
 * This module finds them in the transcript. It is pure (no DOM), so the same
 * code runs live during recording, in the editor, and in the tests.
 *
 * English, romanised Hinglish and Devanagari Hindi are all understood, because
 * that is how people in India actually talk while demoing.
 */

/**
 * @typedef {'cut'|'zoomIn'|'zoomOut'|'hide'|'highlight'|'speedUp'|'normalSpeed'|'chapter'|'title'|'mark'|'camBig'|'camSmall'|'camHide'|'camShow'} CommandType
 */

/**
 * @typedef {Object} Phrase
 * @property {string} text
 * @property {number} start  Seconds from the start of the recording.
 * @property {number} end
 */

/**
 * @typedef {Object} Command
 * @property {string} id
 * @property {CommandType} type
 * @property {number} phrase       Index of the phrase it was heard in.
 * @property {number} time         When it was said (end of the phrase).
 * @property {string} heard        The exact words that matched.
 * @property {boolean} standalone  The phrase is (almost) only the command, so the phrase is cut from the video.
 * @property {number} before       Number of narration words before the command in the same phrase.
 * @property {string} [label]      Title text for chapter/title/mark.
 * @property {boolean} enabled
 */

/**
 * @typedef {Object} Grammar
 * @property {CommandType} type
 * @property {RegExp[]} patterns   A capture group 1, when present, is the label.
 * @property {string} name         Shown in the UI.
 * @property {string} say          Example of what to say.
 */

/** @type {Grammar[]} */
export const GRAMMAR = [
  {
    type: 'cut',
    name: 'Cut the fumble',
    say: 'scratch that',
    patterns: [
      /\b(?:scratch that|cut that(?: out)?|cut cut|let me redo(?: that)?|redo that|let me (?:try|start|say) (?:that )?(?:again|over)|start (?:that )?over|take two|retake)\b/u,
      /\b(?:kaat do|cut karo|dobara (?:karta|karti|bolta|bolti) hoon)\b/u,
      /(?:काट दो|फिर से बोलता हूँ|दोबारा करता हूँ)/u,
    ],
  },
  {
    type: 'hide',
    name: 'Hide a secret',
    say: 'hide that',
    patterns: [
      /\b(?:hide|blur|redact|mask) (?:that|this|it)\b/u,
      /\b(?:chhupa|chupa|chhipa) do\b/u,
      /(?:छुपा दो|छिपा दो)/u,
    ],
  },
  {
    type: 'zoomIn',
    name: 'Zoom in',
    say: 'zoom here',
    patterns: [
      /\bzoom (?:in )?(?:here|there|on (?:this|that|it))\b|\bzoom in\b|\benhance\b/u,
      /\bzoom karo\b|\byahan zoom\b/u,
      /(?:ज़ूम करो|जूम करो)/u,
    ],
  },
  {
    type: 'zoomOut',
    name: 'Zoom out',
    say: 'zoom out',
    patterns: [/\bzoom (?:out|back)\b|\bwide shot\b|\bpull back\b/u, /\bzoom out karo\b/u, /(?:ज़ूम आउट|जूम आउट)/u],
  },
  {
    type: 'highlight',
    name: 'Spotlight',
    say: 'look here',
    patterns: [/\b(?:highlight|spotlight|circle) (?:that|this|it|here)\b|\blook here\b|\bright here\b/u, /\byahan dekho\b/u, /(?:यहाँ देखो|यहां देखो)/u],
  },
  {
    type: 'speedUp',
    name: 'Fast-forward',
    say: 'speed this up',
    patterns: [/\b(?:speed (?:this |it )?up|fast[- ]?forward(?: this)?|skip ahead|time ?lapse)\b/u, /\bfast karo\b|\btez karo\b/u, /(?:तेज़ करो|तेज करो)/u],
  },
  {
    type: 'normalSpeed',
    name: 'Back to normal speed',
    say: 'normal speed',
    patterns: [/\b(?:normal speed|back to normal(?: speed)?|regular speed|real ?time)\b/u, /\bnormal karo\b/u, /(?:नॉर्मल करो)/u],
  },
  {
    type: 'chapter',
    name: 'New chapter',
    say: 'chapter: setup',
    patterns: [
      /^(?:(?:okay|ok|so|and|now|right|alright)[,]?\s+)*(?:new |next )?chapter[:,.]?\s+(?:(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+)[:,.]?\s+)?(?:is |called )?(.{2,48}?)\s*[.!]?$/u,
      /^(?:अगला\s+)?(?:अध्याय|चैप्टर)[:,]?\s+(.{2,48}?)\s*[।.]?$/u,
    ],
  },
  {
    type: 'title',
    name: 'Title card',
    say: 'title: my project',
    patterns: [/^(?:the )?title[:,.]?\s+(?:is\s+)?(.{2,60}?)\s*[.!]?$/u, /^(?:टाइटल|शीर्षक)[:,]?\s+(.{2,60}?)\s*[।.]?$/u],
  },
  {
    type: 'mark',
    name: 'Bookmark',
    say: 'mark that',
    patterns: [/\b(?:mark|bookmark|flag) (?:that|this|it)\b/u],
  },
  {
    type: 'camBig',
    name: 'Big camera',
    say: 'big camera',
    patterns: [
      /\b(?:big|bigger|large|larger|full|full ?screen|pick|bick) ?(?:camera|cam|camra|kamera)\b|\b(?:camera|cam) (?:big|bigger|full ?screen)\b|\b(?:show my face|face to camera|zoom (?:in )?on me)\b/u,
      /\bcamera bada (?:karo|kar do)\b/u,
      /(?:कैमरा बड़ा करो|बड़ा कैमरा)/u,
    ],
  },
  {
    type: 'camSmall',
    name: 'Camera to the corner',
    say: 'small camera',
    patterns: [
      /\b(?:small|smaller|little|mini) ?(?:camera|cam|camra|kamera)\b|\b(?:camera|cam) (?:small|smaller|in (?:the |to the )?corner|to (?:the )?corner)\b|\bback to (?:the )?screen\b/u,
      /\bcamera chhota (?:karo|kar do)\b/u,
      /(?:कैमरा छोटा करो|छोटा कैमरा)/u,
    ],
  },
  {
    type: 'camHide',
    name: 'Hide camera',
    say: 'hide camera',
    patterns: [/\b(?:hide (?:the |my )?camera|camera off|hide my face)\b/u, /\bcamera (?:band|hata) karo\b/u, /(?:कैमरा बंद करो)/u],
  },
  {
    type: 'camShow',
    name: 'Show camera',
    say: 'show camera',
    patterns: [/\b(?:show (?:the |my )?camera|camera on|camera back)\b/u, /\bcamera (?:chalu|on) karo\b/u, /(?:कैमरा चालू करो)/u],
  },
];

/** Words that don't count as narration when deciding if a phrase is only a command. */
const FILLER = new Set(
  'ok okay so and now um uh hmm right alright yeah yes no wait sorry oops please let me just actually basically achha accha haan nahi arre'.split(' '),
);

/** @param {string} s */
export function normalise(s) {
  return s
    .normalize('NFC')
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/[“”"]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** @param {string} s */
const words = (s) => s.split(/[\s,.!?;:।]+/u).filter(Boolean);

/** Sentence case: first letter capital, the rest as spoken. @param {string} s */
function titleCase(s) {
  const t = s.replace(/[.!?।]+$/u, '').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/**
 * Find the director's commands in a list of transcript phrases.
 * At most one command of each type per phrase.
 * @param {Phrase[]} phrases
 * @returns {Command[]}
 */
export function parseCommands(phrases) {
  /** @type {Command[]} */
  const out = [];
  phrases.forEach((p, phrase) => {
    const text = normalise(p.text);
    for (const g of GRAMMAR) {
      for (const re of g.patterns) {
        const m = re.exec(text);
        if (!m) continue;
        const beforeText = text.slice(0, m.index);
        const afterText = text.slice(m.index + m[0].length);
        const narration = [...words(beforeText), ...words(afterText)].filter((w) => !FILLER.has(w));
        const labelled = g.type === 'chapter' || g.type === 'title';
        out.push({
          id: `${g.type}-${phrase}`,
          type: g.type,
          phrase,
          time: p.end,
          heard: m[0],
          standalone: labelled ? words(beforeText).filter((w) => !FILLER.has(w)).length <= 1 : narration.length <= 2,
          before: words(beforeText).filter((w) => !FILLER.has(w)).length,
          label: m[1] ? titleCase(m[1]) : undefined,
          enabled: true,
        });
        break;
      }
    }
  });
  // A chapter phrase like "chapter: zoom in on the chart" is a chapter, not a zoom.
  const chapterPhrases = new Set(out.filter((c) => c.type === 'chapter' || c.type === 'title').map((c) => c.phrase));
  return out.filter((c) => c.type === 'chapter' || c.type === 'title' || !chapterPhrases.has(c.phrase));
}

/**
 * The narration text of a phrase with any command words removed, for captions.
 * @param {string} text
 */
export function stripCommands(text) {
  let s = text;
  for (const g of GRAMMAR) {
    if (g.type === 'chapter' || g.type === 'title') continue;
    for (const re of g.patterns) s = s.replace(new RegExp(re.source, 'giu'), '');
  }
  return s.replace(/\s{2,}/g, ' ').replace(/\s+([,.!?])/g, '$1').replace(/^[\s,.]+|[\s,]+$/g, '').trim();
}

/** Short human description of what a command did, for the director's notes. */
/** @param {Command} c */
export function describe(c) {
  switch (c.type) {
    case 'cut':
      return 'Cut the fumbled take';
    case 'hide':
      return 'Hid what just appeared on screen';
    case 'zoomIn':
      return 'Zoomed in where the screen changed';
    case 'zoomOut':
      return 'Zoomed back out';
    case 'highlight':
      return 'Spotlit what just changed';
    case 'speedUp':
      return 'Fast-forwarded';
    case 'normalSpeed':
      return 'Back to normal speed';
    case 'chapter':
      return `Chapter: ${c.label}`;
    case 'title':
      return `Title card: ${c.label}`;
    case 'mark':
      return 'Bookmarked';
    case 'camBig':
      return 'Camera to full size';
    case 'camSmall':
      return 'Camera back to the corner';
    case 'camHide':
      return 'Camera hidden';
    case 'camShow':
      return 'Camera shown';
  }
}
