# Retake

**A screen recorder you direct out loud.**

**Edit out loud.** Record your screen and talk as you normally would. Fumble a sentence? Say **"scratch that"** and it's gone. Something too small to read? Say **"zoom in"**. Pasted an API key on screen? Say **"hide that"** and it's blurred from the moment it appeared. Stop recording, and the video is already edited, captioned and split into chapters.

No timeline. No editing session. No upload: everything happens in your browser.

> Built for the WeMakeDevs × Wispr Flow **No Hands** challenge (Builders track).

---

## The problem

Anyone who records screen demos (developers, teachers, founders, support teams) spends longer editing than recording: hunting for the take where they stumbled, cutting dead air while `npm install` runs, zooming in on tiny text, and scrubbing frame by frame to blur a key or an email they showed by accident. Leaked secrets in demo videos are a real security problem.

Existing tools fix this **after** recording: you scrub a timeline, or an AI guesses which take was bad. But at the moment you fumble, you already know. Retake lets you say so.

## What it does

| Say | Retake |
|---|---|
| **"scratch that"** | Cuts the sentence you just fumbled, and what happened on screen while you said it. If you said it mid-sentence, only that breath is cut. |
| **"cut the last two sentences"** / **"cut the last sentence"** | Cuts exactly that many sentences before the command. |
| **"cut the last 5 seconds"** | Cuts exactly that much time before the command. |
| **"cut from here"** … **"cut till here"** | Cuts everything between the two. |
| **"hide that"** | Finds what just appeared on screen and pixelates it **from the moment it first appeared** (before you noticed) **until it leaves the screen**, or until you say **"show it"**. **"hide that for ten seconds"** sets the length. |
| **"hide the screen"** / **"show the screen"** | Blurs the whole screen, e.g. while you open your inbox. |
| **"zoom in"** / **"zoom out"** | Glides to 2× on the centre, and back to the full screen, whatever is on screen. **"zoom in on the top right"** aims at a corner or side, **"zoom in more"** goes closer, **"zoom in for 3 seconds"** zooms back out on its own. |
| **"look here"** | Dims the screen and rings what just changed, for three seconds. |
| **"speed this up"** / **"normal speed"** | Fast-forwards the boring part (installs, builds, uploads). **"speed this up 8x"** sets the rate. |
| **"pause"** / **"resume"** | Pauses the recording; nothing is recorded until you say "resume", and the join dissolves softly. |
| **"stop recording"** | Ends the take and opens the editor. The command itself is left out. |
| **"chapter: setup"** | Adds a chapter card on screen and a YouTube timestamp. |
| **"title: my project"** | Opens the video with a title card. |
| **"mark that"** | Drops a bookmark. |
| **"big camera"** / **"small camera"** | Grows your camera bubble to fill the frame (intros, outros), then sends it back to its corner. |
| **"hide camera"** / **"show camera"** | Gets your face out of the way when it covers something on screen. |

**Eight languages, and the way people actually talk.** English, Hinglish, Hindi, Spanish, French, German, Portuguese and Italian (*kaat do*, *chhupa do*, *corta eso*, *acércate*, *cache ça*, *versteck das*, *Kapitel: …*). Everyday phrasings work too: "oops, let me say that again", "hold on", "one sec", "continue", "that's a wrap", "closer". Speech recognition often writes a lone "pause" as "pose" or "paws", so those count too, but only when said on their own. "Pause" also acts the moment it's heard, not when the recogniser finishes the phrase 1–2 seconds later.

And without being asked:

- **You, in a bubble.** Your webcam is recorded alongside the screen and shown as a circle or rounded square. Drag it anywhere on the preview, snap it to a corner, or resize it, all after recording, because the camera is kept as its own track. Its ring glows while you speak.
- **Dead air is trimmed**, but only where nothing happens on screen. If you're silent because you're typing, it's kept.
- **Word-timed captions.** Each word is placed where your voice actually was (see below), lines break at your pauses and are balanced so no word is left on its own, and each word lights up as you say it. Exported as `.srt` and as `.vtt` with word timestamps.
- **YouTube chapters** are generated, with a warning if they don't meet YouTube's rules.
- **Live slate with your camera:** a 3-2-1 countdown (Retake is already listening, so "big camera" works from the first word), then a slate showing your camera preview, a timer, a mic level, what Retake heard, each command as it lands, and a pause button.
- **Float my camera:** pops just your camera bubble out above every other window, so you can see yourself while you work. If you're recording the whole screen, Retake remembers where you dragged it and the bubble in the video follows.
- **A final cut that doesn't feel cut.** Phrase timing from speech recognition is re-measured against the mic's loudness, so cuts land in real silences. The recording's sound is decoded once and played from the Web Audio clock, so every cut and every silenced command lands on the exact sample (video decoders resume a browser-recorded WebM up to 0.3s early after a seek, which used to let the end of a command slip through). Pictures switch between two pre-seeked video decoders, so cuts are instant; only the screen dissolves, and your camera bubble glides straight through. Spoken commands are **silenced, not cut**, when something is happening on screen (so a zoom or a camera change isn't chopped out), and cut when the screen is still. You can choose Smart, Silence or Cut in Style. Every cut dissolves over 450ms with an eased audio ramp, and camera changes start as you say them.
- **Three versions of every take:** **Final** (what viewers get), **Demo** (your spoken commands stay in, each labelled with what Retake did, and the parts that would be cut play fast under a red overlay, which is ideal for showing Retake off) and **Raw**. Any of them can be exported.
- **Nothing is final:** every direction appears in the Director's notes with a switch to undo it, and a **Raw take** toggle shows the original for comparison.
- **Private:** recording, speech recognition (Chrome's built-in), analysis and rendering all run in the browser. The last take is kept in this browser so a refresh doesn't lose it.

## Try it

- **Sample take, no recording needed:** open the app and tap **Try the sample take** (or go to `/?sample`, or `/?sample&demo` to open it in the Demo version). It's a 72-second recording of a developer building a weather app, complete with dead air, a 20-second `npm install`, a pasted API key, a fumbled sentence and a tiny chart, and narration that directs Retake to fix all of it. Retake turns it into a 38-second video.
- **Your own take:** **Record a take** in Chrome or Edge on a computer, pick a window or tab, and talk.

## How it works

```mermaid
flowchart LR
  subgraph Recording
    S[Screen<br/>getDisplayMedia] --> R[MediaRecorder]
    M[Mic] --> R
    M --> L[Loudness<br/>AudioWorklet, 20×/s]
    M --> SR[Speech recognition<br/>phrase start/end times]
    S --> G[Motion grid<br/>64×36, 5×/s]
  end
  SR --> C[Command parser<br/>EN / Hinglish / Hindi]
  C --> P[Edit planner]
  L --> P
  G --> P
  P --> E[Edit decision list:<br/>cuts, speeds, zooms,<br/>blurs, chapters, captions]
  E --> V[Canvas renderer]
  R --> V
  V --> X[Preview and export<br/>MP4 / WebM]
```

**Three signals, recorded side by side:**

1. **What you said, and when.** Live speech recognition gives phrases with approximate start and end times.
2. **How loud you were.** An AudioWorklet measures mic loudness 20 times a second. Cut boundaries are snapped to real silences, so cuts never clip a word, and dead air is found here. The silence threshold adapts to your room's noise.
3. **Where the screen changed.** Five times a second, the screen is shrunk to a 64×36 grayscale grid and compared with the previous frame. It is read from the video track's frames, so it keeps working while Retake's tab is in the background.

**Timing, the hard part.** Browser speech recognition says *what* you said but only roughly *when*: phrases arrive 0.5–1.5s late, with no word times. So Retake does its own alignment:

1. A voice-activity mask from the mic (hysteresis, so soft consonants at word edges count; 160ms gaps between words bridged; clicks dropped) finds where speech really starts and stops.
2. Each phrase is snapped to that voice.
3. Each word is placed inside its phrase by spreading its syllables over the voiced frames, with word boundaries snapped to the pauses inside the phrase (a light forced alignment).
4. A phrase's end is found by walking *forward* through the voice to the pause where its syllables have been said and the next phrase begins, because the recogniser often finalises a phrase after you've started the next sentence.
5. A command inside a longer phrase is located as the stretch of voice between two pauses whose length fits the command, and the words on either side are re-timed around it. So "scratch that, first we open the settings" cuts the fumble and keeps the retake, and "...and that's it, zoom in" silences exactly "zoom in".
6. Recognition often runs a command into the next sentence ("back to the screen so here we have…"). Camera commands at the start or end of a phrase still count, but only if the recording shows a pause between them and the rest, so "we bought a big camera" never triggers anything.

**Smoothness.** Zooms glide over 1.1s of *output* time with a quintic ease and logarithmic scale (equal steps feel equally fast, as with a real lens), and a new glide starts from wherever the last one got to, so a quick "zoom in … zoom out" never jumps. Fast-forwards ramp up and down through intermediate speeds (still exact source↔output time mapping), drop back to normal speed whenever you talk, and blend a motion trail at 4× and 8×. In the Demo version, a fumble that will be cut plays at 1.25× with its sound, so viewers hear the mistake and the command that removed it.

**The planner** (`src/plan.js`) combines them:

- **"scratch that"** cuts from the start of the fumbled sentence, snapped to the silence before it, to the end of the command.
- **"hide that"** looks back for the most recent burst of screen change. It ignores tiny changes such as a moving mouse or a blinking caret, takes the main region the burst touched, and starts the blur at the moment that region began changing. The blur ends when most of that region changes again (a tab switch, a scroll).
- **"zoom in"** glides to the centre, or to the named region, so it does the same thing every time, whatever is on screen.
- **Spoken commands** become silences or cuts depending on whether the screen was moving while you said them.
- **Dead air** is shortened only when the mic is quiet *and* the screen is static.

The result is a list of segments (with speed), zooms, blurs, spotlights, chapters and captions, plus exact source↔output time mapping.

The plan is rebuilt from scratch whenever you flip a switch or change a setting, so editing is non-destructive. **The renderer** (`src/render.js`) draws each output frame from the plan: the virtual camera with eased zoom, pixelation, spotlight, cards, badge and captions. The preview and the export share it, so what you see is what you get. Export records the canvas in real time with the original audio, pausing the recorder while the video seeks across a cut so no frozen frames get in.

**Type:** Instrument Serif for headlines, quotes and on-video cards, Instrument Sans for everything you operate, Geist Mono for timecodes, on an ink and champagne palette.

**No dependencies.** No frameworks, no build step, no npm packages. The app is plain ES modules; the tests use Node's built-in runner.

## Tests

```bash
npm test
```

44 tests on the command parser, motion analysis and planner, including:

- every direction in English, Hinglish and Devanagari Hindi;
- ordinary narration ("this hides the sidebar", "the cut off date") is not mistaken for a direction;
- "scratch that" cuts the fumbled sentence, or only the fumbled breath when said mid-sentence;
- "hide that" ignores the mouse and the caret, starts the blur when the secret appeared, and ends it when the secret leaves the screen;
- dead air is trimmed but silent typing is kept;
- zoom goes to the centre or the named region, "more" goes closer, "for 3 seconds" zooms back out;
- "cut the last 5 seconds", "cut the last two sentences", "cut from here … cut till here", "stop recording";
- "hide that for N seconds", "hide that … show it", "hide the screen";
- spoken commands are silenced when the screen moves and cut when it's still; phrase times are refined from the mic;
- Spanish, French, German, Portuguese and Italian; "pause" however the recogniser spells it, and only where the recording really paused;
- words land where the voice is; captions follow the words and never overlap; the sound is already off when a silenced command starts;
- fast-forward ramps keep time mapping exact and never speed up narration; zoom glides never jump; the Demo version never skips speech;
- real recogniser timing: a late final result never drags a command into the next sentence; "scratch that" works however the words are grouped, and the retake survives; camera commands run into a sentence work only with a pause; the product's name in a sentence isn't a command;
- switching a direction off restores the footage;
- source↔output time mapping round-trips exactly; SRT and YouTube chapter output;
- camera directions build a timeline with smooth transitions, and are ignored inside ordinary sentences ("we bought a big camera");
- the Demo version keeps commands audible, plays would-be cuts fast, and still reports the final cut's numbers.

**End-to-end leak test.** A narrated take is synthesised with speech synthesis, with a faint 3150 Hz marker tone mixed into the command words only, and fed to Chromium as its microphone. A stand-in for the speech recogniser delivers phrases the way Chrome does (interim results 0.5s in, final results 1.3s after you stop, often merged with the next sentence). The take is recorded, planned and exported, and the exported audio is scanned for the marker: the raw export shows every command; the final export shows none, in both Smart and Cut modes.

The full app was also driven end to end in headless Chromium: the sample take, every effect rendered, undo, Raw/Retake comparison, a complete real-time export (checked with ffprobe), and a real recording using simulated screen, microphone and camera devices.

## Run locally

Node 18 or newer, nothing to install:

```bash
npm run dev     # http://localhost:5173
```

Screen recording needs `localhost` or HTTPS.

## Deploy (free)

**Vercel:** import the GitHub repo. No build settings, no environment variables.
**GitHub Pages:** Settings → Pages → deploy from the `main` branch root.

## Browser support

| | Chrome / Edge (desktop) | Firefox | Safari | Phones |
|---|---|---|---|---|
| Try the sample, edit, export | ✓ | ✓ | ✓ (WebM/MP4 depending on version) | ✓ |
| Record | ✓ | ✓ | ✓ | – (browsers can't capture the screen) |
| Voice directions | ✓ | – | partial | – |
| Floating camera bubble | ✓ (116+) | – | – | – |

## Project layout

```
index.html, styles.css    the app
src/commands.js           the director's vocabulary and parser
src/motion.js             screen-change grid, "where did it change", "what appeared", "when did it leave"
src/plan.js               edit planner, time mapping, SRT/VTT, YouTube chapters
src/render.js             frame renderer: camera, blur, spotlight, cards, captions
src/player.js             preview playback, video and sample sources, export
src/recorder.js           screen + mic + camera capture, speech timing, loudness, motion, filmstrip
src/sample.js             the procedural sample take and its narration
src/store.js              keeps the last take in this browser
src/app.js                screens and wiring
tests/plan.test.js        tests
```

## Limits

- Phrase timing comes from browser speech recognition, which is approximate; cuts are snapped to silences to compensate. Chrome's recognition needs an internet connection.
- "hide that" protects the region that changed. If a secret scrolls or moves, it hides it until it leaves that spot. Check the preview before publishing.
- Export runs in real time, and the tab must stay open.

## How Wispr Flow was used

Retake is a product about not typing, so I built it the same way. Wispr Flow was my keyboard for everything that wasn't a shortcut:

- **Directing the coding agent.** I spoke every round of feedback, bug report and feature request to my AI coding agent through Flow ("the blur stays on after I switch tabs; it should end when the secret leaves the screen", "add my camera in a corner, and let me say 'big camera' for the intro"). Talking through a bug the way I'd explain it to a colleague was faster than typing it, and more precise.
- **Testing by talking.** Retake's directions are spoken, so every test take was me narrating a demo out loud and checking what Retake did with it.
- **Writing.** I dictated the edits to this README, the narration for the demo video and the submission text, and cleaned them up by voice.

Wispr usage card (Insights): _[attach screenshot]_ · Words dictated during the challenge: _[from the card]_


## License

MIT
