// Stand-in for Chrome's speech recognition, driven by the known script timeline.
(() => {
  const TL = window.__TIMELINE__;
  window.__marks = {};
  const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (c) => {
    const s = await gum(c);
    if (c && c.audio && !window.__marks.mic) window.__marks.mic = performance.now();
    return s;
  };
  const recStart = MediaRecorder.prototype.start;
  MediaRecorder.prototype.start = function (...a) {
    if (!window.__marks.rec && this.stream.getVideoTracks().length && this.stream.getAudioTracks().length) window.__marks.rec = performance.now();
    return recStart.apply(this, a);
  };
  class FakeSR {
    constructor() { this.timers = []; this.results = []; }
    start() {
      const ref = window.__marks.mic, now = performance.now();
      const born = (now - ref) / 1000; // wav time this recogniser started
      window.__srStarts = (window.__srStarts || 0) + 1;
      const stall = TL.stall || null;
      const groups = {};
      for (const s of TL.segments) (groups[s.group] ||= []).push(s);
      Object.values(groups).forEach((segs, gi) => {
        const text = segs.map((s) => s.text).join(' ');
        const first = segs[0], last = segs[segs.length - 1];
        const words = text.split(' ');
        const at = (wavT) => ref + wavT * 1000 - now;
        if (last.end < born - 0.2) return; // already over before this recogniser started
        // A wedged recogniser: one started before the stall hears nothing after it begins.
        const dead = (wavT) => stall && born < stall[0] && wavT >= stall[0];
        // Interim results while speaking, growing word by word.
        const dur = last.end - first.start;
        for (let k = 1; k <= words.length; k++) {
          const t = first.start + 0.45 + (dur * k) / words.length;
          if (dead(Math.min(t, last.end + 0.3))) continue;
          this.timers.push(setTimeout(() => this.emit(gi, words.slice(0, k).join(' '), false), Math.max(0, at(Math.min(t, last.end + 0.3)))));
        }
        // Final result, late, as Chrome does.
        if (!dead(last.end + 1.3)) this.timers.push(setTimeout(() => this.emit(gi, text, true), Math.max(0, at(last.end + 1.3))));
      });
    }
    emit(i, text, isFinal) {
      const alt = { transcript: text, confidence: 0.9 };
      const res = Object.assign([alt], { isFinal });
      this.results[i] = res;
      const results = Object.assign([...this.results].map((r) => r || Object.assign([{ transcript: '', confidence: 0 }], { isFinal: true })), {});
      this.onresult?.({ resultIndex: i, results });
    }
    stop() { this.timers.forEach(clearTimeout); setTimeout(() => this.onend?.(), 30); }
    abort() { this.stop(); }
  }
  window.SpeechRecognition = window.webkitSpeechRecognition = FakeSR;
})();
