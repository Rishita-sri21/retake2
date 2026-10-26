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
 * Understood: English (with the everyday ways people actually say these
 * things), romanised Hinglish, Hindi, Spanish, French, German, Portuguese and
 * Italian. Matching is accent-insensitive ("pantalla", "écran" → "ecran") and
 * each command can carry a span, so the editor knows exactly which words to
 * silence.
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
 * @property {[number, number]} span  Word indices [first, last] of the command in the phrase, modifiers included.
 * @property {'before'|'after'} [needsPause]  Said at the edge of a longer phrase: only counts if there's a pause on this side of it.
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
 * @property {RegExp[]} patterns   Capture group 1, when present, is the label or number.
 * @property {RegExp[]} [strong]   Unmistakable forms ("pause the recording") that count even inside a sentence.
 * @property {string} name
 * @property {string} say          Example of what to say.
 * @property {string} group        For the help screen.
 * @property {boolean} [standaloneOnly]  Only counts when said on its own (not inside a sentence).
 * @property {boolean} [hidden]    An extra set of phrasings for a command already listed.
 * @property {boolean} [exact]     Only when nothing but filler is said with it (for everyday words like "again").
 */

/** Numbers as people say them, in every language understood. */
const NUMBERS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, 'a couple of': 2, 'a couple': 2, 'a few': 3,
  'half a': 0.5, 'half an': 0.5,
  // Hinglish
  ek: 1, teen: 3, char: 4, chaar: 4, paanch: 5, panch: 5, das: 10, bees: 20,
  // Spanish / Portuguese / Italian / French / German
  uno: 1, una: 1, dos: 2, dois: 2, duas: 2, due: 2, tres: 3, tre: 3, cuatro: 4, quatro: 4, quattro: 4, cinco: 5, cinque: 5,
  diez: 10, dez: 10, dieci: 10, deux: 2, trois: 3, quatre: 4, cinq: 5, dix: 10, zwei: 2, drei: 3, vier: 4, funf: 5, zehn: 10,
};
const NUM = `(\\d+(?:[.,]\\d+)?|${Object.keys(NUMBERS).sort((a, b) => b.length - a.length).join('|')})`;

/**
 * A pattern bounded by non-letters on both sides. Unlike \b this works for
 * accented and Devanagari words too.
 * @param {string} src
 */
const L = (src) => new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])(?:${src})(?![\\p{L}\\p{M}\\p{N}])`, 'du');

/** @type {Grammar[]} */
export const GRAMMAR = [
  // ---------------------------------------------------------------- cutting
  {
    type: 'cutSeconds',
    group: 'Cut',
    name: 'Cut the last few seconds',
    say: 'cut the last 5 seconds',
    patterns: [
      L(`(?:cut|remove|delete|drop|trim|lose) (?:out )?(?:the )?(?:last|previous|past) ${NUM} (?:seconds?|secs?)`),
      L(`(?:last|pichhle|pichle|pichhe ke) ${NUM} (?:seconds?|secs?) (?:kaat do|cut karo|hata do|delete karo)`),
      L(`(?:corta|borra|quita|elimina) (?:los )?ultimos ${NUM} segundos`),
      L(`(?:coupe|supprime|efface) les ${NUM} dernieres secondes`),
      L(`(?:schneide|losche|entferne) die letzten ${NUM} sekunden`),
      L(`(?:corta|apaga|remove) os ultimos ${NUM} segundos`),
      L(`(?:taglia|cancella|togli) gli ultimi ${NUM} secondi`),
    ],
  },
  {
    type: 'cutSentences',
    group: 'Cut',
    name: 'Cut the last sentences',
    say: 'cut the last two sentences',
    patterns: [
      L(`(?:cut|remove|delete|drop|lose) (?:out )?(?:the |that )?(?:last|previous) (?:${NUM} )?(?:sentences?|lines?|bits?|parts?)`),
      L(`(?:last|pichhli|pichli|pichhle|pichle) (?:${NUM} )?(?:sentences?|lines?|line) (?:kaat do|hata do|cut karo|delete karo)`),
      L(`(?:corta|borra|quita|elimina) (?:la|las) (?:${NUM} )?ultimas? (?:${NUM} )?(?:frases?|oraciones?)`),
      L(`(?:coupe|supprime|efface) (?:la|les) (?:${NUM} )?dernieres? phrases?`),
      L(`(?:schneide|losche|entferne) (?:den|die) letzten (?:${NUM} )?satze?`),
      L(`(?:corta|apaga) (?:a|as) (?:${NUM} )?ultimas? (?:${NUM} )?frases?`),
      L(`(?:taglia|cancella|togli) (?:l'|le )(?:${NUM} )?ultim[ae] (?:${NUM} )?frasi?`),
    ],
  },
  {
    type: 'cutFrom',
    group: 'Cut',
    name: 'Start cutting',
    say: 'cut from here',
    patterns: [
      L(`cut from here|start (?:the |a )?cut(?:ting)?(?: here)?|begin (?:the )?cut`),
      L(`yahan se (?:kaato|kaat do|cut karo)|यहाँ से काटो|यहां से काटो`),
      L(`corta desde aqui|coupe (?:a partir )?d'ici|schneide ab hier|corta a partir daqui|taglia da qui`),
    ],
  },
  {
    type: 'cutTo',
    group: 'Cut',
    name: 'Stop cutting',
    say: 'cut till here',
    patterns: [
      L(`cut (?:until|till|til|to|up to) here|end (?:the )?cut|stop cutting|done cutting`),
      L(`yahan tak (?:kaato|kaat do|cut karo)|यहाँ तक काटो|यहां तक काटो`),
      L(`corta hasta aqui|coupe jusqu'ici|schneide bis hier|corta ate aqui|taglia fino a qui`),
    ],
  },
  {
    type: 'cut',
    group: 'Cut',
    name: 'Cut the fumble',
    say: 'scratch that',
    patterns: [
      L(`scratch that|cut that(?: out)?|cut cut|delete that|remove that|take that out|strike that|let me redo(?: that)?|redo that|let me (?:try|start|say|do) (?:that |it )?(?:again|over)|start (?:that )?over|let me rephrase`),
      L(`kaat do|cut karo|isko hata do|ye hata do|hata do|dobara (?:karta|karti|bolta|bolti) (?:hoon|hun)|phir se (?:bolta|bolti) (?:hoon|hun)`),
      L(`काट दो|हटा दो|फिर से बोलता हूँ|दोबारा करता हूँ|दोबारा बोलता हूँ`),
      L(`corta eso|borra eso|quita eso|elimina eso|coupe (?:ca|cela)|efface (?:ca|cela)|je recommence|on recommence|schneid das (?:raus|weg)|streich das|losch das|corta isso|apaga isso|taglia (?:questo|quello)|cancella (?:questo|quello)|rifaccio`),
    ],
  },
  {
    type: 'cut',
    group: 'Cut',
    name: 'Cut the fumble',
    say: 'oops, let me say that again',
    hidden: true,
    standaloneOnly: true,
    exact: true,
    // Speech recognition's usual spellings of a quick "scratch that" are here too.
    patterns: [L(`oops|my bad|never ?mind|ignore that|undo(?: that)?|one more time|try again|again|do over|phir se|galti ho gayi|फिर से|otra vez|de nuevo|encore une fois|nochmal|noch ?mal|de novo|di nuovo|scratched that|scratches that|scratch it|scratch this|stretch that|scratch dat|scratch|crash that|cross that out|cross that|wrong take|bad take|take two|retake|let'?s retake|retake that`)],
  },
  // ---------------------------------------------------------------- hiding
  {
    type: 'hideScreen',
    group: 'Hide',
    name: 'Hide the whole screen',
    say: 'hide the screen',
    patterns: [
      L(`(?:hide|blur|cover) (?:the |my )?(?:whole |entire )?screen|hide everything|go private`),
      L(`screen (?:chhupa|chupa|chhipa) do|screen (?:chhupao|chupao)|स्क्रीन छुपा दो|स्क्रीन छुपाओ`),
      L(`oculta la pantalla|esconde la pantalla|cache l'ecran|masque l'ecran|versteck(?:e)? den bildschirm|bildschirm ausblenden|esconde a tela|oculta a tela|nascondi lo schermo`),
    ],
  },
  {
    type: 'showScreen',
    group: 'Hide',
    name: 'Show the screen again',
    say: 'show the screen',
    patterns: [
      L(`(?:show|unhide|unblur) (?:the |my )?(?:whole |entire )?screen|show everything`),
      L(`screen dikhao|screen wapas dikhao|स्क्रीन दिखाओ`),
      L(`muestra la pantalla|montre l'ecran|affiche l'ecran|zeig(?:e)? den bildschirm|mostra a tela|mostra lo schermo`),
    ],
  },
  {
    type: 'unhide',
    group: 'Hide',
    name: 'Stop hiding',
    say: 'show it',
    patterns: [
      L(`show it(?: again)?|show that again|unhide(?: it| that)?|stop hiding|unblur(?: it| that)?|you can show it`),
      L(`ab dikhao|wapas dikhao|अब दिखाओ`),
      L(`muestralo|muestra eso|montre-le|montre le|affiche-le|zeig(?:e)? es(?: wieder)?|mostra isso|mostralo`),
    ],
  },
  {
    type: 'hide',
    group: 'Hide',
    name: 'Hide a secret',
    say: 'hide that',
    patterns: [
      L(`(?:hide|blur|redact|mask|censor|cover|pixelate) (?:that|this|it)(?: up)?`),
      L(`(?:chhupa|chupa|chhipa) do|(?:chhupao|chupao)|blur kar do|hide kar do`),
      L(`छुपा दो|छिपा दो|छुपाओ`),
      L(`oculta eso|esconde eso|tapa eso|difumina eso|cache (?:ca|cela)|masque (?:ca|cela)|floute (?:ca|cela)|versteck(?:e)? das|verberge das|blende das aus|esconde isso|oculta isso|esconda isso|nascondi (?:questo|quello)|copri (?:questo|quello)`),
    ],
  },
  {
    type: 'hide',
    group: 'Hide',
    name: 'Hide a secret',
    say: "that's private",
    hidden: true,
    standaloneOnly: true,
    exact: true,
    patterns: [L(`that'?s (?:private|secret|confidential)|don'?t show (?:that|this)|oops,? my (?:key|password)`)],
  },
  // ---------------------------------------------------------------- the virtual camera: zoom
  {
    type: 'zoomIn',
    group: 'Zoom',
    name: 'Zoom in',
    say: 'zoom in',
    patterns: [
      L(`zoom (?:in|into|closer|here|there)|zoom on|zoom it|zoom it in|get closer|enhance|magnify|let'?s zoom`),
      L(`zoom (?:in )?karo|zoom in kar do|yahan zoom|ज़ूम करो|जूम करो|ज़ूम इन`),
      L(`acerca(?:te)?|haz zoom|zoom aqui|amplia|zoome|zoomer|agrandis|rapproche|zoom (?:rein|ran)|reinzoomen|vergro(?:ss|ß)ern|naher ran|aproxima|da zoom|ingrandisci|avvicina|fai zoom`),
    ],
  },
  {
    type: 'zoomIn',
    group: 'Zoom',
    name: 'Zoom in',
    say: 'closer',
    hidden: true,
    standaloneOnly: true,
    exact: true,
    patterns: [L(`closer|bigger|make it bigger|zoom|zoom please`)],
  },
  {
    type: 'zoomOut',
    group: 'Zoom',
    name: 'Zoom out',
    say: 'zoom out',
    patterns: [
      L(`zoom (?:out|back|back out)|wide shot|pull back|full view|go back out|reset (?:the )?zoom|unzoom`),
      L(`zoom out karo|zoom hatao|ज़ूम आउट|जूम आउट|ज़ूम हटाओ`),
      L(`aleja(?:te)?|quita el zoom|dezoome|dezoomer|zoom arriere|zoom raus|rauszoomen|verkleinern|afasta|tira o zoom|rimpicciolisci|allontana|togli lo zoom`),
    ],
  },
  {
    type: 'highlight',
    group: 'Zoom',
    name: 'Spotlight',
    say: 'look here',
    patterns: [
      L(`(?:highlight|spotlight|circle|point at) (?:that|this|it|here)|look here|right here|over here|check this out`),
      L(`yahan dekho|idhar dekho|यहाँ देखो|यहां देखो|इधर देखो`),
      L(`mira aqui|fijate aqui|regarde(?:z)? ici|schau (?:mal )?hier|guck (?:mal )?hier|olha aqui|guarda qui`),
    ],
  },
  // ---------------------------------------------------------------- time
  {
    type: 'speedUp',
    group: 'Time',
    name: 'Fast-forward',
    say: 'speed this up',
    patterns: [
      L(`speed (?:this |it |things )?up|fast[- ]?forward(?: this)?|skip ahead|skip (?:this|this part)|time ?lapse|hurry (?:this )?up`),
      L(`fast karo|tez karo|jaldi karo|fast forward karo|तेज़ करो|तेज करो|जल्दी करो`),
      L(`acelera(?:lo)?|adelanta|mas rapido|accelere|avance rapide|schneller|vorspulen|spul vor|avanca|mais rapido|accelera|avanti veloce|piu veloce`),
    ],
  },
  {
    type: 'normalSpeed',
    group: 'Time',
    name: 'Normal speed',
    say: 'normal speed',
    patterns: [
      L(`normal speed|back to normal(?: speed)?|regular speed|real ?time|slow (?:it |this )?down`),
      L(`normal karo|normal speed karo|नॉर्मल करो`),
      L(`velocidad normal|vitesse normale|normale geschwindigkeit|normales tempo|velocidade normal|velocita normale`),
    ],
  },
  {
    type: 'pause',
    group: 'Recording',
    name: 'Pause recording',
    say: 'pause',
    standaloneOnly: true,
    strong: [L(`pause (?:the |this )?recording|pause recording|let'?s pause (?:here|now|the recording)|recording (?:roko|rok do)`)],
    patterns: [
      L(`pause(?: it| now| please| here| for a (?:sec|second|moment))?|paused|hold on|hold up|wait a (?:sec|second|moment|minute)|one (?:sec|second)|give me a (?:sec|second|moment|minute)|take a break`),
      L(`ruko|ruk jao|ek (?:second|minute|min)|रुको|रुक जाओ|ठहरो|रिकॉर्डिंग रोको`),
      L(`pausa|pausar|en pause|mets en pause|pausieren|metti in pausa`),
    ],
  },
  {
    type: 'pause',
    group: 'Recording',
    name: 'Pause recording',
    say: 'pause',
    hidden: true,
    standaloneOnly: true,
    exact: true,
    // Speech recognition often writes a lone "pause" as one of these.
    patterns: [L(`pose|paws|pours|pawz|paz|porz|pores|pauls?|pas|break|wait|espera|attends|warte|aspetta`)],
  },
  {
    type: 'resume',
    group: 'Recording',
    name: 'Resume recording',
    say: 'resume',
    standaloneOnly: true,
    strong: [L(`resume (?:the )?recording|continue (?:the )?recording|start recording again|unpause`)],
    patterns: [
      L(`resume|carry on|keep going|let'?s (?:continue|go on)|start again|we'?re back|and we'?re back|back again`),
      L(`chalu karo|shuru karo|phir se shuru|चालू करो|शुरू करो`),
      L(`reanuda|reprends|reprendre|on reprend|mach weiter|fortsetzen|retoma|riprendi(?:amo)?`),
    ],
  },
  {
    type: 'resume',
    group: 'Recording',
    name: 'Resume recording',
    say: 'continue',
    hidden: true,
    standaloneOnly: true,
    exact: true,
    patterns: [L(`continue|go on|go|rolling|action|okay go|go ahead|chalo|चलो|आगे बढ़ो|continua(?:r|mos)?|seguimos|weiter|andiamo|vamos|on y va|los`)],
  },
  {
    type: 'stop',
    group: 'Recording',
    name: 'Stop recording',
    say: 'stop recording',
    standaloneOnly: true,
    strong: [L(`(?:stop|end|finish) (?:the )?recording|that'?s a wrap|and that'?s a wrap|recording (?:band karo|band kar do|rok do)`)],
    patterns: [
      L(`stop|and cut|cut and stop|done recording|end it|we'?re done here|the end`),
      L(`रिकॉर्डिंग बंद करो|रिकॉर्डिंग रोक दो`),
      L(`(?:deten|para|termina) la grabacion|corten|arrete l'enregistrement|fin de l'enregistrement|coupez|aufnahme (?:stoppen|beenden)|stopp|(?:para|parar|termina) a gravacao|ferma la registrazione|stop registrazione`),
    ],
  },
  // ---------------------------------------------------------------- structure
  {
    type: 'chapter',
    group: 'Structure',
    name: 'New chapter',
    say: 'chapter: setup',
    patterns: [
      /^(?:(?:okay|ok|so|and|now|right|alright)[,]?\s+)*(?:new |next )?chapter[:,.]?\s+(?:(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+)[:,.]?\s+)?(?:is |called )?(.{2,48}?)\s*[.!]?$/du,
      /^(?:अगला\s+)?(?:अध्याय|चैप्टर)[:,]?\s+(.{2,48}?)\s*[।.]?$/du,
      /^(?:nuevo |novo |nouveau |neues |nuovo )?(?:capitulo|chapitre|kapitel|capitolo)[:,.]?\s+(?:(?:uno|dos|tres|un|deux|trois|eins|zwei|drei|um|dois|tres|due|tre|\d+)[:,.]?\s+)?(.{2,48}?)\s*[.!]?$/du,
    ],
  },
  {
    type: 'title',
    group: 'Structure',
    name: 'Title card',
    say: 'title: my project',
    patterns: [
      /^(?:the )?title[:,.]?\s+(?:is\s+)?(.{2,60}?)\s*[.!]?$/du,
      /^(?:टाइटल|शीर्षक)[:,]?\s+(.{2,60}?)\s*[।.]?$/du,
      /^(?:titulo|titre|titel|titolo)[:,.]?\s+(.{2,60}?)\s*[.!]?$/du,
    ],
  },
  {
    type: 'mark',
    group: 'Structure',
    name: 'Bookmark',
    say: 'mark that',
    patterns: [
      L(`(?:mark|bookmark|flag) (?:that|this|it)|remember this|note this`),
      L(`mark karo|निशान लगाओ`),
      L(`marca (?:esto|eso|isso)|marque ca|markier(?:e)? das|segna questo`),
    ],
  },
  // ---------------------------------------------------------------- your camera bubble
  {
    type: 'camBig',
    group: 'You',
    name: 'Big camera',
    say: 'big camera',
    standaloneOnly: true,
    patterns: [
      L(`(?:big|bigger|large|larger|full|full ?screen|pick|bick) ?(?:camera|cam|camra|kamera)|(?:camera|cam) (?:big|bigger|full ?screen)|show my face|face to camera|zoom (?:in )?on me|face ?cam|me full ?screen`),
      L(`camera bada (?:karo|kar do)|bada camera|कैमरा बड़ा करो|बड़ा कैमरा`),
      L(`camara grande|grande camera|camera en grand|gro(?:ss|ß)e kamera|kamera gro(?:ss|ß)|camera grande|telecamera grande`),
    ],
  },
  {
    type: 'camSmall',
    group: 'You',
    name: 'Camera back to the corner',
    say: 'small camera',
    standaloneOnly: true,
    patterns: [
      L(`(?:small|smaller|little|mini) ?(?:camera|cam|camra|kamera)|(?:camera|cam) (?:small|smaller|in (?:the |to the )?corner|to (?:the )?corner)|(?:go |come |and )?back to (?:the |this |my |your )?(?:screen|screens|scream|screen share|desktop|demo|code)|back to it|back to work|show the screen now|shrink (?:the |my )?camera|face away`),
      L(`camera chhota (?:karo|kar do)|chhota camera|screen pe wapas|कैमरा छोटा करो|छोटा कैमरा`),
      L(`camara pequena|vuelve a la pantalla|petite camera|retour a l'ecran|kleine kamera|zuruck zum bildschirm|camera pequena|volta para a tela|camera piccola|torna allo schermo`),
    ],
  },
  {
    type: 'camHide',
    group: 'You',
    name: 'Hide camera',
    say: 'hide camera',
    standaloneOnly: true,
    patterns: [
      L(`hide (?:the |my )?(?:camera|face)|camera off|no camera`),
      L(`camera (?:band|hata|off) (?:karo|kar do)|कैमरा बंद करो`),
      L(`oculta la camara|cache la camera|kamera (?:aus|verstecken)|esconde a camera|nascondi la (?:tele)?camera`),
    ],
  },
  {
    type: 'camShow',
    group: 'You',
    name: 'Show camera',
    say: 'show camera',
    standaloneOnly: true,
    patterns: [
      L(`show (?:the |my )?camera|camera on|camera back`),
      L(`camera (?:chalu|on) (?:karo|kar do)|कैमरा चालू करो`),
      L(`muestra la camara|montre la camera|kamera an|mostra a camera|mostra la (?:tele)?camera`),
    ],
  },
];

/** Words that don't count as narration when deciding if a phrase is only a command. */
const FILLER = new Set(
  (
    'ok okay so and now um uh umm hmm right alright yeah yes no wait sorry oops please let me just actually basically ' +
    'achha accha acha haan han nahi arre toh to bas ab ji na the a for seconds second ' +
    'vale bueno pues bon alors donc euh also jetzt gut entao bem allora ecco dai'
  ).split(' '),
);

/**
 * Lowercase, tidy quotes and spaces, and drop accents from Latin letters
 * (Devanagari is left alone). One character in, one character out, so match
 * positions line up with the original.
 * @param {string} s
 */
export function normalise(s) {
  return Array.from(
    s
      .normalize('NFC')
      .toLowerCase()
      .replace(/[’‘`]/g, "'")
      .replace(/[“”"«»]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  )
    .map((ch) => {
      const base = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
      return base.length === 1 ? base : ch;
    })
    .join('');
}

/** @param {string} s */
const words = (s) => s.split(/[\s,.!?;:।]+/u).filter(Boolean);

/** "five" → 5, "2.5" → 2.5, "a few" → 3, "cinco" → 5. @param {string | undefined} s */
export function toNumber(s) {
  if (!s) return undefined;
  const t = s.trim().replace(',', '.');
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  return /** @type {Record<string, number>} */ (NUMBERS)[t];
}

/** Sentence case: first letter capital, the rest as spoken. @param {string} s */
function titleCase(s) {
  const t = s.replace(/[.!?।]+$/u, '').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Modifier phrases: not narration, and silenced along with the command. */
const MODIFIERS = [
  new RegExp(`(?:for|durante|pendant|fur|por|per) ${NUM} (?:seconds?|secs?|minutes?|segundos?|secondes?|sekunden|secondi|minutos?|minuten)`, 'gu'),
  new RegExp(`${NUM} (?:seconds?|second|minute) (?:ke liye|tak)`, 'gu'),
  /\b(?:on|in|at|to|onto) (?:the )?(?:top|bottom|upper|lower)?\s*(?:left|right)?\s*(?:corner|side|part|half|bit)?\b/gu,
  /\b(?:top|bottom|upper|lower|left|right|center|centre|middle|corner|side)\b/gu,
  /\b(?:\d+|two|four|eight|double|triple)\s*(?:x|times)\b/gu,
  /\b(?:more|further|closer|a bit|a little|even more)\b/gu,
  /\buntil i say(?: show it)?\b/gu,
  /\b(?:please|now|here|there|again)\b/gu,
];

/** Read "for 10 seconds", regions, rates and "more" from the whole phrase. */
/** @param {string} text */
function modifiers(text) {
  /** @type {{seconds?: number, region?: string, rate?: number, more?: boolean}} */
  const m = {};
  const forSec =
    new RegExp(`(?:for|durante|pendant|fur|por|per) ${NUM} (seconds?|secs?|minutes?|segundos?|secondes?|sekunden|secondi|minutos?|minuten)`, 'u').exec(text) ||
    new RegExp(`${NUM} (seconds?|second|minute) (?:ke liye|tak)`, 'u').exec(text);
  if (forSec) {
    const n = toNumber(forSec[1]);
    if (n !== undefined) m.seconds = forSec[2].startsWith('min') ? n * 60 : n;
  }
  const v = /\b(top|upper|bottom|lower|arriba|abajo|haut|bas|oben|unten|cima|baixo|alto|basso|upar|neeche|niche)\b/u.exec(text)?.[1];
  const h = /\b(left|right|izquierda|derecha|gauche|droite|links|rechts|esquerda|direita|sinistra|destra|baayen|daayen|baaye|daaye)\b/u.exec(text)?.[1];
  const c = /\b(center|centre|middle|centro|milieu|mitte|beech|beech mein)\b/u.test(text);
  const V = { top: 'top', upper: 'top', arriba: 'top', haut: 'top', oben: 'top', cima: 'top', alto: 'top', upar: 'top' };
  const H = { left: 'left', izquierda: 'left', gauche: 'left', links: 'left', esquerda: 'left', sinistra: 'left', baayen: 'left', baaye: 'left' };
  const vv = v ? (/** @type {Record<string, string>} */ (V)[v] ?? 'bottom') : undefined;
  const hh = h ? (/** @type {Record<string, string>} */ (H)[h] ?? 'right') : undefined;
  if (vv || hh) m.region = [vv, hh].filter(Boolean).join('-');
  else if (c) m.region = 'center';
  const rate = /\b(\d+|two|four|eight|double|triple)\s*(?:x|times)\b/u.exec(text)?.[1];
  if (rate) m.rate = rate === 'double' ? 2 : rate === 'triple' ? 3 : toNumber(rate);
  if (/\b(?:more|further|closer|even closer|aur|mas|plus|mehr|mais|piu)\b/u.test(text)) m.more = true;
  return m;
}

/** Word index of each character in a string split on spaces. @param {string} text */
function wordIndexOf(text) {
  const idx = new Int32Array(text.length);
  let w = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === ' ') {
      idx[i] = w;
      w++;
    } else idx[i] = w;
  }
  return idx;
}

/**
 * The words of a command, widened to take in modifiers and filler next to it
 * ("okay zoom in on the top right please"), so they're silenced together.
 * @param {string} text normalised
 * @param {number} a @param {number} b character span of the match
 * @returns {[number, number]}
 */
function commandSpan(text, a, b) {
  const all = text.split(' ');
  const idx = wordIndexOf(text);
  let first = idx[Math.min(a, text.length - 1)];
  let last = idx[Math.max(a, b - 1)];
  const isExtra = (/** @type {string} */ w) => {
    const bare = w.replace(/[,.!?;:।]+/gu, '');
    if (!bare || FILLER.has(bare)) return true;
    return MODIFIERS.some((re) => new RegExp(`^(?:${re.source})$`, 'u').test(bare)) || NUMBERS.hasOwnProperty(bare) || /^\d+(?:\.\d+)?$/.test(bare) || /^(?:the|on|in|at|to|for|of)$/.test(bare);
  };
  // Trailing modifiers: only if everything to the end of the phrase is modifier or filler.
  const tail = all.slice(last + 1);
  const tailText = MODIFIERS.reduce((acc, re) => acc.replace(new RegExp(re.source, 'gu'), ' '), tail.join(' '));
  if (tail.length && words(tailText).every((w) => FILLER.has(w) || isExtra(w))) last = all.length - 1;
  // Leading filler ("okay so zoom in").
  while (first > 0 && isExtra(all[first - 1])) first--;
  return [first, last];
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
    const original = p.text.normalize('NFC').replace(/[’‘`]/g, "'").replace(/[“”"«»]/g, ' ').replace(/\s+/g, ' ').trim();
    /** Every grammar's best match, then the longest win: "zoom out" beats "zoom", "cut the last two sentences" beats "cut". */
    const found = [];
    GRAMMAR.forEach((g, order) => {
      const tries = [...(g.strong || []).map((re) => ({ re, strong: true })), ...g.patterns.map((re) => ({ re, strong: false }))];
      for (const { re, strong } of tries) {
        const m = re.exec(text);
        if (!m) continue;
        const a = m.index, b = m.index + m[0].length;
        const beforeText = text.slice(0, a);
        const afterText = text.slice(b);
        // Modifier words ("for ten seconds", "top left", "8x", "more") aren't narration.
        const strip = (/** @type {string} */ t) => MODIFIERS.reduce((acc, r) => acc.replace(new RegExp(r.source, 'gu'), ' '), t);
        const narration = [...words(strip(beforeText)), ...words(strip(afterText))].filter((w) => !FILLER.has(w));
        /** @type {'before' | 'after' | undefined} */
        let needsPause;
        if (g.standaloneOnly && !strong && narration.length > (g.exact ? 0 : 1)) {
          // Speech recognition often runs a command into the next sentence
          // ("back to the screen so here we have…"). A camera command at the
          // very start or end of a phrase still counts, if the recording shows
          // a pause between it and the rest (checked by the planner), and it
          // isn't part of a noun phrase ("we bought a big camera").
          if (g.exact || !g.type.startsWith('cam')) continue;
          const pre = words(strip(beforeText)).filter((w) => !FILLER.has(w));
          const post = words(strip(afterText)).filter((w) => !FILLER.has(w));
          const lastBefore = words(beforeText).pop() || '';
          if (!pre.length) needsPause = 'after';
          else if (!post.length && !/^(?:a|an|the|my|our|your|his|her|their|this|that|new|old|one|bought|have|has|got|using|use|with)$/.test(lastBefore)) needsPause = 'before';
          else continue;
        }
        found.push({ g, m, a, b, strong, narration, beforeText, order, needsPause });
        break;
      }
    });
    found.sort((x, y) => y.b - y.a - (x.b - x.a) || x.order - y.order);
    /** @type {[number, number][]} */
    const claimed = [];
    const taken = new Set();
    const mods = modifiers(text);
    for (const { g, m, a, b, strong, narration, beforeText, needsPause } of found) {
      if (taken.has(g.type) || claimed.some(([x, y]) => a < y && b > x)) continue;
      claimed.push([a, b]);
      taken.add(g.type);
      const labelled = g.type === 'chapter' || g.type === 'title';
      const standalone = labelled ? words(beforeText).filter((w) => !FILLER.has(w)).length <= 1 : narration.length <= 2;
      /** @type {Command} */
      const cmd = {
        id: `${g.type}-${phrase}`,
        type: g.type,
        phrase,
        time: p.end,
        heard: original.slice(a, b) || m[0],
        standalone: standalone || (strong && narration.length <= 2),
        before: words(beforeText).filter((w) => !FILLER.has(w)).length,
        span: labelled ? [0, text.split(' ').length - 1] : commandSpan(text, a, b),
        enabled: true,
      };
      if (needsPause) cmd.needsPause = needsPause;
      const n = m.slice(1).find((x) => x !== undefined);
      if (labelled && m.indices?.[1]) {
        const [la, lb] = m.indices[1];
        cmd.label = titleCase(original.slice(la, lb) || /** @type {string} */ (m[1]));
      }
      if (g.type === 'cutSeconds') cmd.seconds = toNumber(n) ?? 5;
      if (g.type === 'cutSentences') cmd.count = toNumber(n) ?? 1;
      if (['hide', 'hideScreen', 'zoomIn', 'speedUp', 'highlight'].includes(g.type) && mods.seconds) cmd.seconds = mods.seconds;
      if (g.type === 'zoomIn') {
        if (mods.region) cmd.region = mods.region;
        if (mods.more) cmd.more = true;
      }
      if (g.type === 'speedUp' && mods.rate) cmd.rate = mods.rate;
      out.push(cmd);
    }
  });
  // A chapter phrase like "chapter: zoom in on the chart" is a chapter, not a zoom.
  const chapterPhrases = new Set(out.filter((c) => c.type === 'chapter' || c.type === 'title').map((c) => c.phrase));
  return out
    .filter((c) => c.type === 'chapter' || c.type === 'title' || !chapterPhrases.has(c.phrase))
    .sort((x, y) => x.phrase - y.phrase || x.span[0] - y.span[0]);
}

/**
 * Is this (interim or final) speech only a recording control, said on its own?
 * Used live, so "pause" acts the moment it's heard rather than seconds later.
 * @param {string} text
 * @returns {'pause'|'resume'|'stop'|null}
 */
export function recordingControl(text) {
  const cmds = parseCommands([{ text, start: 0, end: 1 }]);
  const c = cmds.find((x) => x.type === 'pause' || x.type === 'resume' || x.type === 'stop');
  return c ? /** @type {'pause'|'resume'|'stop'} */ (c.type) : null;
}

/**
 * The narration text of a phrase with any command words removed, for captions.
 * @param {string} text
 */
export function stripCommands(text) {
  const cmds = parseCommands([{ text, start: 0, end: 1 }]).filter((c) => c.type !== 'chapter' && c.type !== 'title');
  const w = text.normalize('NFC').replace(/\s+/g, ' ').trim().split(' ');
  const drop = new Set();
  for (const c of cmds) for (let i = c.span[0]; i <= c.span[1]; i++) drop.add(i);
  return w
    .filter((_, i) => !drop.has(i))
    .join(' ')
    .replace(/\s+([,.!?])/g, '$1')
    .replace(/^[\s,.]+|[\s,]+$/g, '')
    .trim();
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
      return `Zoomed in${c.more ? ' further' : ''}${c.region && c.region !== 'center' ? ` (${c.region.replace('-', ' ')})` : ''}${c.seconds ? ` for ${secs(c.seconds)}` : ''}`;
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
