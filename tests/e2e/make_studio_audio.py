"""Speaks the Studio script (from src/studio.js) as one narrated take, with a
marker tone on command words, and writes studio_timeline.json."""
import json, re, subprocess, wave, numpy as np
SR = 48000
src = open(__import__('os').path.join(__import__('os').path.dirname(__import__('os').path.abspath(__file__)), '../../src/studio.js')).read()
beats = re.findall(r"\{ title: '([^']*)', scene: '[^']*', say: '((?:[^'\\]|\\.)*)'", src)
LEAD, GAP_LINE, GAP_BEAT = 7.0, 0.7, 1.4
def tts(text):
    subprocess.run(['python3', 'tts.py', text, 'seg.wav'], check=True, capture_output=True)
    with wave.open('seg.wav') as w:
        x = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768; sr = w.getframerate()
    x = np.interp(np.arange(0, len(x) * SR / sr) * sr / SR, np.arange(len(x)), x)
    env = np.convolve(np.abs(x), np.ones(480) / 480, 'same'); on = np.where(env > 0.01)[0]
    return x[on[0]:on[-1]] * 0.9
parts, t, lines, beat_starts = [np.zeros(int(LEAD * SR))], LEAD, [], []
for bi, (title, say) in enumerate(beats):
    say = say.replace("\\'", "'")
    beat_starts.append(round(t - 0.4, 3))
    for li, raw in enumerate(say.split(' // ')):
        wispr = raw.startswith('[Wispr] ')
        line = raw[8:] if wispr else raw
        cmd = line.startswith('**')
        text = re.sub(r'\*\*', '', line)
        x = tts(text.replace(':', ',').replace('…', ',').replace('—', ','))
        if cmd:
            env = np.convolve(np.abs(x), np.ones(960) / 960, 'same')
            x = x + np.sin(2 * np.pi * 3150 * np.arange(len(x)) / SR) * np.clip(env * 0.5, 0, 0.05)
        lines.append({"beat": bi, "text": text.strip(), "command": cmd, "wispr": wispr, "start": round(t, 3), "end": round(t + len(x) / SR, 3)})
        parts += [x, np.zeros(int(GAP_LINE * SR))]
        t += len(x) / SR + GAP_LINE
    parts.append(np.zeros(int((GAP_BEAT - GAP_LINE) * SR))); t += GAP_BEAT - GAP_LINE
parts.append(np.zeros(int(6 * SR)))
y = np.concatenate(parts)
with wave.open('studio_mic.wav', 'wb') as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes((np.clip(y, -1, 1) * 32767).astype(np.int16).tobytes())
json.dump({"duration": len(y) / SR, "beats": beat_starts, "lines": lines}, open('studio_timeline.json', 'w'), indent=1)
print(len(beats), 'beats,', len(lines), 'lines, speech ends at', round(t, 1), 's')
