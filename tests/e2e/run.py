import json, sys, time
from playwright.sync_api import sync_playwright
OUT = sys.argv[1]; STYLE = sys.argv[2] if len(sys.argv) > 2 else 'smart'
TL = json.load(open('timeline.json'))
BASE = "http://localhost:5174/"
errors = []
with sync_playwright() as p:
    b = p.chromium.launch(args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
        "--use-file-for-fake-audio-capture=" + __import__('os').path.abspath('mic.wav'),
        "--auto-select-desktop-capture-source=Entire screen", "--autoplay-policy=no-user-gesture-required"])
    ctx = b.new_context(viewport={"width": 1440, "height": 900}, permissions=["camera", "microphone"], accept_downloads=True)
    ctx.add_init_script("window.__TIMELINE__ = " + json.dumps(TL) + ";\n" + open('fake_sr.js').read())
    pg = ctx.new_page()
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.on("console", lambda m: m.type == "error" and errors.append(m.text))
    pg.goto(BASE); pg.wait_for_timeout(500)
    pg.click("#record")
    pg.wait_for_function("() => window.__marks.mic && window.__marks.rec", timeout=15000)
    ref = pg.evaluate("window.__marks.mic")
    # Stop after the script has been spoken and its last final result has arrived.
    while pg.evaluate("performance.now()") < ref + (TL['segments'][-1]['end'] + 2.5) * 1000: pg.wait_for_timeout(200)
    pg.click("#stop")
    pg.wait_for_selector("#edit:not([hidden])", timeout=30000)
    pg.wait_for_timeout(1500)
    if STYLE != 'smart': pg.evaluate(f"document.querySelector('#cmd-style [data-style=\"{STYLE}\"], #cmd-style button:nth-child({ {'mute':2,'cut':3}[STYLE] })').click()")
    offset = pg.evaluate("(window.__marks.rec - window.__marks.mic) / 1000")
    info = pg.evaluate("""() => { const s = window.retake.state, p = s.plan;
      return { offset: 0, duration: s.take.duration, heard: s.take.phrases,
        phrases: p.phrases, commands: p.commands.map(c => ({type: c.type, enabled: c.enabled, heard: c.heard, effect: c.effect, standalone: c.standalone})),
        mutes: p.mutes, cuts: p.cuts, camera: p.camera, view: p.view, captions: p.captions.map(c => ({out0: c.out0, out1: c.out1, text: c.text})),
        segments: p.segments.map(g => [g.src0, g.src1, g.rate]), outDuration: p.outDuration,
        demoSegments: s.demo.segments.map(g => [g.src0, g.src1, g.rate, g.ghost || '']), directions: s.demo.directions.map(d => [d.type, d.src0, d.src1, d.heard]) }; }""")
    info['offset'] = offset
    json.dump(info, open(f'{OUT}/plan.json', 'w'), indent=1)
    def export(view):
        pg.click(f"#view-{view}"); pg.wait_for_timeout(300)
        pg.click("#tab-export"); pg.click("#export")
        pg.wait_for_selector("#download-video:not([hidden])", timeout=180000)
        with pg.expect_download() as d: pg.click("#download-video")
        d.value.save_as(f"{OUT}/{view}.mp4")
        # Back to a clean export panel for the next one.
        pg.wait_for_timeout(300)
    for v in ['final', 'demo', 'raw']: export(v)
    b.close()
print("ERRORS:", errors or "none")
