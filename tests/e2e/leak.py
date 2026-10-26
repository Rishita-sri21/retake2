"""Measures the 3150 Hz command marker and speech level in an exported video."""
import json, subprocess, sys, numpy as np
SR = 48000
def load(path):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-ac', '1', '-ar', str(SR), '-f', 'f32le', '-'], capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.float32)
def frames(x, hop=0.05):
    n = int(hop * SR); w = np.hanning(n)
    out = []
    for i in range(0, len(x) - n, n):
        seg = x[i:i + n] * w
        spec = np.abs(np.fft.rfft(seg)); f = np.fft.rfftfreq(n, 1 / SR)
        band = lambda a, b: spec[(f >= a) & (f < b)].max() if ((f >= a) & (f < b)).any() else 0
        tone = band(3100, 3200); ref = max(band(2700, 3000), band(3300, 3600), 1e-6)
        out.append((i / SR, float(np.sqrt(np.mean(x[i:i + n] ** 2))), tone / ref))
    return out
if __name__ == '__main__':
    for path in sys.argv[1:]:
        fr = frames(load(path))
        marks = [t for t, rms, r in fr if r > 4 and rms > 0.003]
        spans = []
        for t in marks:
            if spans and t - spans[-1][1] <= 0.11: spans[-1][1] = t + 0.05
            else: spans.append([t, t + 0.05])
        voiced = sum(1 for t, rms, r in fr if rms > 0.01) * 0.05
        print(f"{path}: marker (command audio) spans: {[(round(a,2), round(b,2)) for a, b in spans]}  | voiced {voiced:.1f}s of {len(fr)*0.05:.1f}s")
