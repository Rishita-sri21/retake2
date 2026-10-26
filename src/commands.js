// @ts-check
/**
 * The director's vocabulary.
 *
 * While recording, you narrate as normal. Some phrases are directions to the
 * editor rather than narration: "scratch that", "zoom in", "hide that for ten
 * seconds", "pause". This module finds them in the transcript and reads their
 * arguments (how long, how many, where). It is pure (no DOM), so the same
 * code runs live during recording, in the editor, and in the tests.
 *
 * English, romanised Hinglish and Devanagari Hindi are all understood.
 */

/**
 * @typedef {'cut'|'cutSentences'|'cutSeconds'|'cutFrom'|'cutTo'|
 *   'hide'|'unhide'|'hideScreen'|'showScreen'|
 *   'zoomIn'|'zoomOut'|'highlight'|'speedUp'|'normalSpeed'|
 *   'chapter'|'title'|'mark'|
 *   'camBig'|'camSmall'|'camHide'|'camShow'|
 *   'pause'|'resume'|'stop'} CommandType
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
 * @property {boolean} standalone  The phrase is (almost) only the command.
 * @property {number} before       Narration words before the command in the same phrase.
 * @property {string} [label]      Title text for chapter/title.
 * @property {number} [seconds]    "for 10 seconds", "last 5 seconds".
 * @property {number} [count]      "last two sentences".
 * @property {string} [region]     Zoom target: 'center', 'top-left', 'left', …
 * @property {boolean} [more]      "zoom in more".
 * @property {number} [rate]       "speed up 8x".
 * @property {boolean} enabled
 */

/**
 * @typedef {Object} Grammar
 * @property {CommandType} type
 * @property {RegExp[]} patterns   A capture group 1, when present, is the label or number.
 * @property {string} name
 * @property {string} say          Example of what to say.
 * @property {string} group        For the help screen.
 * @property {boolean} [standaloneOnly]  Only counts when said on its own (not inside a sentence).
 */

const NUM = '(\\d+(?:\\.\\d+)?|a couple of|a couple|a few|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|half a|half an)';

/** @type {Grammar[]} */
export const GRAMMAR = [
  // ---------------------------------------------------------------- cutting
  {
    type: 'cutSeconds',
    group: 'Cut',
    name: 'Cut the last few seconds',
    say: 'cut the last 5 seconds',
    patterns: [new RegExp(`\\b(?:cut|remove|delete|drop|trim) (?:out )?(?:the )?(?:last|previous|past) ${NUM} seconds?\\b`, 'u')],
  },
  {
    type: 'cutSentences',
    group: 'Cut',
    name: 'Cut the last sentences',
    say: 'cut the last two sentences',
    patterns: [new RegExp(`\\b(?:cut|remove|delete|drop) (?:out )?(?:the )?(?:last|previous) (?:${NUM} )?(?:sentences?|lines?|bits?)\\b`, 'u')],
  },
  {
    type: 'cutFrom',
    group: 'Cut',
    name: 'Start cutting',
    say: 'cut from here',
    patterns: [/\b(?:cut from here|start (?:the |a )?cut(?:ting)?(?: here)?|begin (?:the )?cut)\b/u, /\byahan se kaato\b/u],
  },
  {
    type: 'cutTo',
    group: 'Cut',
    name: 'Stop cutting',
    say: 'cut till here',
    patterns: [/\b(?:cut (?:until|till|til|to|up to) here|end (?:the )?cut|stop cutting|done cutting)\b/u, /\byahan tak kaato\b/u],
  },
  {
    type: 'cut',
    group: 'Cut',
    name: 'Cut the fumble',
    say: 'scratch that',
    patterns: [
      /\b(?:scratch that|cut that(?: out)?|cut cut|let me redo(?: that)?|redo that|let me (?:try|start|say) (?:that )?(?:again|over)|start (?:that )?over|take two|retake)\b/u,
      /\b(?:kaat do|cut karo|dobara (?:karta|karti|bolta|bolti) hoon)\b/u,
      /(?:काट दो|फिर से बोलता हूँ|दोबारा करता हूँ)/u,
    ],
  },
  // ---------------------------------------------------------------- hiding
  {
    type: 'hideScreen',
    group: 'Hide',
    name: 'Hide the whole screen',
    say: 'hide the screen',
    patterns: [/\b(?:hide|blur) (?:the |my )?(?:whole |entire )?screen\b|\bhide everything\b/u, /\bscreen (?:chhupa|chupa) do\b/u],
  },
  {
    type: 'showScreen',
    group: 'Hide',
    name: 'Show the screen again',
    say: 'show the screen',
    patterns: [/\b(?:show|unhide|unblur) (?:the |my )?(?:whole |entire )?screen\b|\bshow everything\b/u, /\bscreen dikhao\b/u],
  },
  {
    type: 'unhide',
    group: 'Hide',
    name: 'Stop hiding',
    say: 'show it',
    patterns: [/\b(?:show it(?: again)?|show that again|unhide(?: it| that)?|stop hiding|unblur(?: it| that)?)\b/u, /\bab dikhao\b/u],
  },
  {
    type: 'hide',
    group: 'Hide',
    name: 'Hide a secret',
    say: 'hide that',
    patterns: [
      /\b(?:hide|blur|redact|mask) (?:that|this|it)\b/u,
      /\b(?:chhupa|chupa|chhipa) do\b/u,
      /(?:छुपा दो|छिपा दो)/u,
    ],
  },
  // ---------------------------------------------------------------- camera (the virtual one: zoom)
  {
    type: 'zoomIn',
    group: 'Zoom',
    name: 'Zoom in',
    say: 'zoom in',
    patterns: [
      /\bzoom (?:in|into|closer|here|there)\b|\bzoom on\b|\bget closer\b|\benhance\b/u,
      /\bzoom karo\b|\byahan zoom\b/u,
      /(?:ज़ूम करो|जूम करो)/u,
    ],
  },
  {
    type: 'zoomOut',
    group: 'Zoom',
    name: 'Zoom out',
    say: 'zoom out',
    patterns: [/\bzoom (?:out|back)\b|\bwide shot\b|\bpull back\b|\bfull view\b/u, /\bzoom out karo\b/u, /(?:ज़ूम आउट|जूम आउट)/u],
  },
  {
    type: 'highlight',
    group: 'Zoom',
    name: 'Spotlight',
    say: 'look here',
    patterns: [/\b(?:highlight|spotlight|circle) (?:that|this|it|here)\b|\blook here\b|\bright here\b/u, /\byahan dekho\b/u, /(?:यहाँ देखो|यहां देखो)/u],
  },
  // ---------------------------------------------------------------- time
  {
    type: 'speedUp',
    group: 'Time',
    name: 'Fast-forward',
    say: 'speed this up',
    patterns: [/\b(?:speed (?:this |it |things )?up|fast[- ]?forward(?: this)?|skip ahead|time ?lapse)\b/u, /\bfast karo\b|\btez karo\b/u, /(?:तेज़ करो|तेज करो)/u],
  },
  {
    type: 'normalSpeed',
    group: 'Time',
    name: 'Normal speed',
    say: 'normal speed',
    patterns: [/\b(?:normal speed|back to normal(?: speed)?|regular speed|real ?time)\b/u, /\bnormal karo\b/u, /(?:नॉर्मल करो)/u],
  },
  {
    type: 'pause',
    group: 'Recording',
    name: 'Pause recording',
    say: 'pause',
    standaloneOnly: true,
    patterns: [/\b(?:pause(?: (?:the )?recording)?|hold on|hold the recording)\b/u, /\brecording roko\b|\bruko\b/u, /(?:रुको|रिकॉर्डिंग रोको)/u],
  },
  {
    type: 'resume',
    group: 'Recording',
    name: 'Resume recording',
    say: 'resume',
    standaloneOnly: true,
    patterns: [/\b(?:resume(?: (?:the )?recording)?|unpause|continue(?: (?:the )?recording)?|carry on|we're back)\b/u, /\bchalu karo\b|\bphir se shuru\b/u, /(?:चालू करो)/u],
  },
  {
    type: 'stop',
    group: 'Recording',
    name: 'Stop recording',
    say: 'stop recording',
    standaloneOnly: true,
    patterns: [/\b(?:stop (?:the )?recording|end (?:the )?recording|finish (?:the )?recording|that'?s a wrap|and cut|stop)\b/u, /\brecording band karo\b/u, /(?:रिकॉर्डिंग बंद करो)/u],
  },
  // ---------------------------------------------------------------- structure
  {
    type: 'chapter',
    group: 'Structure',
    name: 'New chapter',
    say: 'chapter: setup',
    patterns: [
      /^(?:(?:okay|ok|so|and|now|right|alright)[,]?\s+)*(?:new |next )?chapter[:,.]?\s+(?:(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+)[:,.]?\s+)?(?:is |called )?(.{2,48}?)\s*[.!]?$/u,
      /^(?:अगला\s+)?(?:अध्याय|चैप्टर)[:,]?\s+(.{2,48}?)\s*[।.]?$/u,
    ],
  },
  {
    type: 'title',
    group: 'Structure',
    name: 'Title card',
    say: 'title: my project',
    patterns: [/^(?:the )?title[:,.]?\s+(?:is\s+)?(.{2,60}?)\s*[.!]?$/u, /^(?:टाइटल|शीर्षक)[:,]?\s+(.{2,60}?)\s*[।.]?$/u],
  },
  {
    type: 'mark',
    group: 'Structure',
    name: 'Bookmark',
    say: 'mark that',
    patterns: [/\b(?:mark|bookmark|flag) (?:that|this|it)\b/u],
  },
  // ---------------------------------------------------------------- your camera bubble
  {
    type: 'camBig',
    group: 'You',
    name: 'Big camera',
    say: 'big camera',
    standaloneOnly: true,
    patterns: [
      /\b(?:big|bigger|large|larger|full|full ?screen|pick|bick) ?(?:camera|cam|camra|kamera)\b|\b(?:camera|cam) (?:big|bigger|full ?screen)\b|\b(?:show my face|face to camera|zoom (?:in )?on me)\b/u,
      /\bcamera bada (?:karo|kar do)\b/u,
      /(?:कैमरा बड़ा करो|बड़ा कैमरा)/u,
    ],
  },
  {
    type: 'camSmall',
    group: 'You',
    name: 'Camera back to the corner',
    say: 'small camera',
    standaloneOnly: true,
    patterns: [
      /\b(?:small|smaller|little|mini) ?(?:camera|cam|camra|kamera)\b|\b(?:camera|cam) (?:small|smaller|in (?:the |to the )?corner|to (?:the )?corner)\b|\bback to (?:the )?screen\b/u,
      /\bcamera chhota (?:karo|kar do)\b/u,
      /(?:कैमरा छोटा करो|छोटा कैमरा)/u,
    ],
  },
  {
    type: 'camHide',
    group: 'You',
    name: 'Hide camera',
    say: 'hide camera',
    standaloneOnly: true,
    patterns: [/\b(?:hide (?:the |my )?(?:camera|face)|camera off)\b/u, /\bcamera (?:band|hata) karo\b/u, /(?:कैमरा बंद करो)/u],
  },
  {
    type: 'camShow',
    group: 'You',
    name: 'Show camera',
    say: 'show camera',
    standaloneOnly: true,
    patterns: [/\b(?:show (?:the |my )?camera|camera on|camera back)\b/u, /\bcamera (?:chalu|on) karo\b/u, /(?:कैमरा चालू करो)/u],
  },
];

/** Words that don't count as narration when deciding if a phrase is only a command. */
const FILLER = new Set(
  'ok okay so and now um uh hmm right alright yeah yes no wait sorry oops please let me just actually basically achha accha haan nahi arre the a for seconds second'.split(' '),
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

const NUMBERS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, 'a couple': 2, 'a couple of': 2, 'a few': 3,
  'half a': 0.5, 'half an': 0.5, a: 1, an: 1,
};

/** "five" → 5, "2.5" → 2.5, "a few" → 3. @param {string | undefined} s */
export function toNumber(s) {
  if (!s) return undefined;
  const t = s.trim();
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  return /** @type {Record<string, number>} */ (NUMBERS)[t];
}

/** Sentence case: first letter capital, the rest as spoken. @param {string} s */
function titleCase(s) {
  const t = s.replace(/[.!?।]+$/u, '').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Modifier phrases removed before counting narration words. */
const MODIFIERS = [
  new RegExp(`\\bfor ${NUM} (?:seconds?|minutes?)\\b`, 'gu'),
  /\b(?:on|in|at|to) the (?:top|bottom|upper|lower)?\s*(?:left|right)?\s*(?:corner|side|part|half)?\b/gu,
  /\b(?:top|bottom|upper|lower|left|right|center|centre|middle|corner)\b/gu,
  /\b(?:\d+|two|four|eight|double|triple)\s*(?:x|times)\b/gu,
  /\b(?:more|further|closer|a bit|a little)\b/gu,
  /\buntil i say(?: show it)?\b/gu,
];

/** Read "for 10 seconds", regions, rates and "more" from the whole phrase. */
/** @param {string} text */
function modifiers(text) {
  /** @type {{seconds?: number, region?: string, rate?: number, more?: boolean}} */
  const m = {};
  const forSec = new RegExp(`\\bfor ${NUM} (seconds?|minutes?)\\b`, 'u').exec(text);
  if (forSec) {
    const n = toNumber(forSec[1]);
    if (n !== undefined) m.seconds = forSec[2].startsWith('min') ? n * 60 : n;
  }
  const v = /\b(top|upper|bottom|lower)\b/u.exec(text)?.[1];
  const h = /\b(left|right)\b/u.exec(text)?.[1];
  const c = /\b(center|centre|middle)\b/u.test(text);
  if (v || h) m.region = [v === 'upper' ? 'top' : v === 'lower' ? 'bottom' : v, h].filter(Boolean).join('-');
  else if (c) m.region = 'center';
  const rate = /\b(\d+|two|four|eight|double|triple)\s*(?:x|times)\b/u.exec(text)?.[1];
  if (rate) m.rate = rate === 'double' ? 2 : rate === 'triple' ? 3 : toNumber(rate);
  if (/\b(?:more|further|closer|even closer)\b/u.test(text)) m.more = true;
  return m;
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
    /** @type {[number, number][]} spans already claimed, so "cut the last two sentences" isn't also "cut" */
    const claimed = [];
    for (const g of GRAMMAR) {
      for (const re of g.patterns) {
        const m = re.exec(text);
        if (!m) continue;
        const a = m.index, b = m.index + m[0].length;
        if (claimed.some(([x, y]) => a < y && b > x)) break;
        const beforeText = text.slice(0, a);
        const afterText = text.slice(b);
        const mods = modifiers(text);
        // Modifier words ("for ten seconds", "top left", "8x", "more") aren't narration.
        const strip = (/** @type {string} */ t) => MODIFIERS.reduce((acc, re) => acc.replace(re, ' '), t);
        const narration = [...words(strip(beforeText)), ...words(strip(afterText))].filter((w) => !FILLER.has(w));
        const labelled = g.type === 'chapter' || g.type === 'title';
        const standalone = labelled ? words(beforeText).filter((w) => !FILLER.has(w)).length <= 1 : narration.length <= 2;
        if (g.standaloneOnly && narration.length > 1) break;
        claimed.push([a, b]);
        /** @type {Command} */
        const cmd = {
          id: `${g.type}-${phrase}`,
          type: g.type,
          phrase,
          time: p.end,
          heard: m[0],
          standalone,
          before: words(beforeText).filter((w) => !FILLER.has(w)).length,
          enabled: true,
        };
        if (labelled && m[1]) cmd.label = titleCase(m[1]);
        if (g.type === 'cutSeconds') cmd.seconds = toNumber(m[1]) ?? 5;
        if (g.type === 'cutSentences') cmd.count = toNumber(m[1]) ?? 1;
        if (['hide', 'hideScreen', 'zoomIn', 'speedUp', 'highlight'].includes(g.type) && mods.seconds) cmd.seconds = mods.seconds;
        if (g.type === 'zoomIn') {
          if (mods.region) cmd.region = mods.region;
          if (mods.more) cmd.more = true;
        }
        if (g.type === 'speedUp' && mods.rate) cmd.rate = mods.rate;
        out.push(cmd);
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
    if (g.type === 'chapter' || g.type === 'title' || g.standaloneOnly) continue;
    for (const re of g.patterns) s = s.replace(new RegExp(re.source, 'giu'), '');
  }
  return s.replace(/\s{2,}/g, ' ').replace(/\s+([,.!?])/g, '$1').replace(/^[\s,.]+|[\s,]+$/g, '').trim();
}

/** @param {number | undefined} n */
const secs = (n) => (n === undefined ? '' : `${n % 1 ? n.toFixed(1) : n} second${n === 1 ? '' : 's'}`);

/** Short human description of what a command asks for. @param {Command} c */
export function describe(c) {
  switch (c.type) {
    case 'cut':
      return 'Cut the fumbled sentence';
    case 'cutSentences':
      return `Cut the last ${c.count === 1 ? 'sentence' : `${c.count} sentences`}`;
    case 'cutSeconds':
      return `Cut the last ${secs(c.seconds)}`;
    case 'cutFrom':
      return 'Start of a cut';
    case 'cutTo':
      return 'End of a cut';
    case 'hide':
      return c.seconds ? `Hid what appeared, for ${secs(c.seconds)}` : 'Hid what just appeared on screen';
    case 'unhide':
      return 'Stopped hiding';
    case 'hideScreen':
      return c.seconds ? `Hid the whole screen for ${secs(c.seconds)}` : 'Hid the whole screen';
    case 'showScreen':
      return 'Showed the screen again';
    case 'zoomIn':
      return `Zoomed in${c.more ? ' further' : ''}${c.region && c.region !== 'center' ? ` (${c.region.replace('-', ' ')})` : ''}`;
    case 'zoomOut':
      return 'Zoomed out';
    case 'highlight':
      return 'Spotlit what just changed';
    case 'speedUp':
      return `Fast-forwarded${c.rate ? ` at ${c.rate}×` : ''}`;
    case 'normalSpeed':
      return 'Back to normal speed';
    case 'pause':
      return 'Paused the recording';
    case 'resume':
      return 'Resumed the recording';
    case 'stop':
      return 'Stopped the recording';
    case 'chapter':
      return `Chapter: ${c.label}`;
    case 'title':
      return `Title card: ${c.label}`;
    case 'mark':
      return 'Bookmarked';
    case 'camBig':
      return 'Camera to full size';
    case 'camSmall':
      return 'Camera back to its spot';
    case 'camHide':
      return 'Camera hidden';
    case 'camShow':
      return 'Camera shown';
  }
}
