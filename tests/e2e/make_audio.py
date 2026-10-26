"""Builds the fake microphone: a narrated take with known timings. Command
words carry a faint 3150 Hz marker tone so leaks can be measured in the export."""
import json, subprocess, numpy as np, wave
SR = 48000
SCRIPT = [  # (text, is_command, silence after, recogniser group)
    ("big camera", True, 0.9, 0),
    ("hi, I'm going to show you how retake works", False, 0.9, 1),
    ("back to the screen", True, 0.3, 2),
    ("so first we open the uh, the setting thingy", False, 0.5, 2),
    ("scratch that", True, 0.35, 3),
    ("first we open the settings page", False, 0.9, 3),
    ("zoom in", True, 0.35, 4),
    ("here you can see the theme options", False, 1.0, 5),
    ("zoom out", True, 0.9, 6),
    ("and that is the whole flow", False, 1.2, 7),
]
LEAD, TAIL = 5.0, 4.0
def tts(text):
    subprocess.run(['python3', 'tts.py', text, 'seg.wav'], check=True, capture_output=True)
    with wave.open('seg.wav') as w:
        x = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768
        sr = w.getframerate()
    x = np.interp(np.arange(0, len(x) * SR / sr) * sr / SR, np.arange(len(x)), x)
    env = np.abs(x); k = int(0.01 * SR)
    idx = np.where(np.convolve(env, np.ones(k) / k, 'same') > 0.01)[0]
    return x[idx[0]:idx[-1]] * 0.9
parts, t, timeline = [np.zeros(int(LEAD * SR))], LEAD, []
for text, cmd, gap, group in SCRIPT:
    x = tts(text)
    if cmd:
        k = int(0.02 * SR)
        env = np.convolve(np.abs(x), np.ones(k) / k, 'same')
        tone = np.sin(2 * np.pi * 3150 * np.arange(len(x)) / SR) * np.clip(env * 0.5, 0, 0.05)
        x = x + tone
    timeline.append({"text": text, "command": cmd, "start": round(t, 3), "end": round(t + len(x) / SR, 3), "group": group})
    parts += [x, np.zeros(int(gap * SR))]
    t += len(x) / SR + gap
parts.append(np.zeros(int(TAIL * SR)))
y = np.concatenate(parts)
with wave.open('mic.wav', 'wb') as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes((np.clip(y, -1, 1) * 32767).astype(np.int16).tobytes())
json.dump({"duration": len(y) / SR, "segments": timeline}, open('timeline.json', 'w'), indent=1)
print(json.dumps(timeline, indent=0)); print('total', len(y) / SR)
