import json, os, sys
from playwright.sync_api import sync_playwright
OUT = sys.argv[1]; os.makedirs(OUT, exist_ok=True)
TL = json.load(open('studio_timeline.json'))
# What the stand-in recogniser hears: each line, finalised late. The first Wispr line it mishears.
segs = []
for i, l in enumerate(TL['lines']):
    heard = l['text']
    if l['wispr'] and 'screen' in heard.lower(): heard = 'swish the scream'
    segs.append({"text": heard, "start": l['start'], "end": l['end'], "group": i})
errors = []
with sync_playwright() as p:
    b = p.chromium.launch(args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
        "--use-file-for-fake-audio-capture=" + os.path.abspath('studio_mic.wav'), "--auto-accept-this-tab-capture",
        "--autoplay-policy=no-user-gesture-required"])
    ctx = b.new_context(viewport={"width": 1920, "height": 1080}, permissions=["camera", "microphone"], accept_downloads=True)
    ctx.add_init_script("window.__TIMELINE__ = " + json.dumps({"segments": segs}) + ";\n" + open('fake_sr.js').read())
    pg = ctx.new_page()
    pg.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
    pg.on("console", lambda m: m.type == "error" and "TUNNEL" not in m.text and errors.append(m.text))
    pg.goto("http://localhost:5174/studio.html"); pg.wait_for_timeout(1500)
    pg.click("#btn-record")
    pg.wait_for_function("() => window.__marks.mic && window.__marks.rec", timeout=20000)
    ref = pg.evaluate("window.__marks.mic")
    now = lambda: (pg.evaluate("performance.now()") - ref) / 1000
    events = [(t, 'next', None) for t in TL['beats'][1:]]
    events += [(l['end'] + 0.9, 'wispr', l['text'].rstrip('.')) for l in TL['lines'] if l['wispr']]
    shots = [(TL['beats'][k] + 2.5, 'shot', f'beat{k:02d}') for k in range(len(TL['beats']))]
    for t, kind, arg in sorted(events + shots, key=lambda e: e[0]):
        while now() < t: pg.wait_for_timeout(50)
        if kind == 'next': pg.keyboard.press("ArrowRight")
        elif kind == 'wispr': pg.fill('#ws-input', arg)
        else: pg.screenshot(path=f'{OUT}/{arg}.png')
    pg.wait_for_url("**/?last", timeout=60000)
    pg.wait_for_selector("#edit:not([hidden])", timeout=60000); pg.wait_for_timeout(1500)
    info = pg.evaluate("""() => { const s = window.retake.state, p = s.plan;
      return { duration: s.take.duration, heard: s.take.phrases, commands: p.commands.map(c => ({type: c.type, enabled: c.enabled, heard: c.heard, effect: c.effect, typed: !!s.take.phrases[c.phrase]?.typed})),
        boards: p.boards, camera: p.camera, view: p.view, blurs: p.blurs.map(b => [b.src0, b.src1]), cuts: p.cuts, mutes: p.mutes, title: p.title, chapters: p.chapters,
        captions: p.captions.map(c => [c.out0, c.out1, c.text]), outDuration: p.outDuration, demoDuration: s.demo.outDuration }; }""")
    info['offset'] = pg.evaluate("(window.__marks.rec - window.__marks.mic) / 1000") if pg.evaluate("!!window.__marks") else None
    json.dump(info, open(f'{OUT}/plan.json', 'w'), indent=1)
    for view in ['demo', 'final']:
        pg.click(f"#view-{view}"); pg.wait_for_timeout(300)
        pg.click("#tab-export"); pg.click("#export")
        pg.wait_for_selector("#download-video:not([hidden])", timeout=400000)
        with pg.expect_download() as d: pg.click("#download-video")
        d.value.save_as(f"{OUT}/{view}.mp4")
    b.close()
print("ERRORS:", errors or "none")
