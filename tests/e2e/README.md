# End-to-end leak test

Proves that spoken commands never reach the final video, using a real recording.

1. `make_audio.py` synthesises a narrated take (Flite speech synthesis, via `tts.py`). Command words carry a faint 3150 Hz marker tone; narration doesn't. `timeline.json` records exactly when each phrase was spoken.
2. `run.py` starts the app (`npm run dev` with `PORT=5174`) in Chromium with that audio as the microphone and a stand-in for Chrome's speech recogniser (`fake_sr.js`). Like Chrome's, it sends interim results 0.5s in and final results 1.3s after you stop, merging some commands with the next sentence. It records the take, stops, and exports the Final, Demo and Raw versions.
3. `leak.py` scans each export for the marker tone. Raw and Demo should show every command; Final should show none.

```bash
cd tests/e2e
python3 make_audio.py
mkdir -p out && python3 run.py out smart   # or: cut, mute
python3 leak.py out/raw.mp4 out/final.mp4 out/demo.mp4
```

Needs Python 3 with numpy and Playwright, ffmpeg, and the `libflite` libraries.
