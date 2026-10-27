import json, os, sys
from playwright.sync_api import sync_playwright
OUT = sys.argv[1]; os.makedirs(OUT, exist_ok=True)
HARD = '--hard' in sys.argv   # the user's conditions: odd window, merged and misheard commands, a stalled recogniser, Wispr for every command
TL = json.load(open('studio_timeline.json'))
# What the stand-in recogniser hears: each line, finalised late. The first Wispr line it mishears.
segs = []
group = 0
for i, l in enumerate(TL['lines']):
    heard = l['text']
    if l['wispr'] and 'screen' in heard.lower(): heard = 'swish the scream'
    if HARD:
        heard = heard.replace('Hours of cutting', 'I was of cutting').rstrip('.').lower()
        prev = TL['lines'][i - 1]['text'] if i else ''
        # Chrome runs the slide and its points together, and the title into the next sentence.
        if i and (heard.startswith('point') or heard.startswith('end slide') or prev.startswith('Title')): group -= 1
    segs.append({"text": heard, "start": l['start'], "end": l['end'], "group": group})
    group += 1
# merge consecutive same-group segments into one recogniser phrase
merged = []
for sg in segs:
    if merged and merged[-1]['group'] == sg['group']:
        merged[-1]['text'] += ' ' + sg['text']; merged[-1]['end'] = sg['end']
    else: merged.append(dict(sg))
segs = merged
errors = []
with sync_playwright() as p:
    b = p.chromium.launch(args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
        "--use-file-for-fake-audio-capture=" + os.path.abspath('studio_mic.wav'), "--auto-accept-this-tab-capture",
        "--autoplay-policy=no-user-gesture-required"])
    vp = {"width": 1280, "height": 540} if HARD else {"width": 1920, "height": 1080}
    ctx = b.new_context(viewport=vp, device_scale_factor=1.5 if HARD else 1, permissions=["camera", "microphone"], accept_downloads=True)
    stall = [TL['beats'][4] - 6, TL['beats'][4] + 14] if HARD else None
    ctx.add_init_script("window.__TIMELINE__ = " + json.dumps({"segments": segs, "stall": stall}) + ";\n" + open('fake_sr.js').read())
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
    if HARD:  # every other command typed by Wispr into the hidden box
        events += [(l['end'] + 0.9, 'sink', l['text'].rstrip('.')) for l in TL['lines'] if l['command'] and not l['wispr'] and not l['text'].lower().startswith('stop')]
    shots = [(TL['beats'][k] + 2.5, 'shot', f'beat{k:02d}') for k in range(len(TL['beats']))]
    for t, kind, arg in sorted(events + shots, key=lambda e: e[0]):
        while now() < t: pg.wait_for_timeout(50)
        if kind == 'next': pg.keyboard.press("ArrowRight")
        elif kind == 'wispr': pg.fill('#ws-input', arg)
        elif kind == 'sink': pg.evaluate("(t) => { const s = document.getElementById('wispr-sink'); s.focus(); s.value = t; s.dispatchEvent(new Event('input')); }", arg)
        else: pg.screenshot(path=f'{OUT}/{arg}.png')
    pg.wait_for_url("**/?last", timeout=60000)
    pg.wait_for_selector("#edit:not([hidden])", timeout=60000); pg.wait_for_timeout(1500)
    info = pg.evaluate("""() => { const s = window.retake.state, p = s.plan;
      return { duration: s.take.duration, heard: s.take.phrases, levels: { dt: s.take.levels.dt, values: Array.from(s.take.levels.values) }, motionCount: (s.take.motion||[]).map(m => [m.t, m.count]), commands: p.commands.map(c => ({type: c.type, enabled: c.enabled, heard: c.heard, effect: c.effect, typed: !!s.take.phrases[c.phrase]?.typed})),
        boards: p.boards, camera: p.camera, view: p.view, blurs: p.blurs.map(b => [b.src0, b.src1]), cuts: p.cuts, mutes: p.mutes, title: p.title, chapters: p.chapters,
        captions: p.captions.map(c => [c.out0, c.out1, c.text]), outDuration: p.outDuration, demoDuration: s.demo.outDuration }; }""")
    info['offset'] = None
    json.dump(info, open(f'{OUT}/plan.json', 'w'), indent=1)
    for view in ['demo', 'final']:
        pg.click(f"#view-{view}"); pg.wait_for_timeout(300)
        pg.click("#tab-export"); pg.click("#export")
        pg.wait_for_selector("#download-video:not([hidden])", timeout=400000)
        with pg.expect_download() as d: pg.click("#download-video")
        d.value.save_as(f"{OUT}/{view}.mp4")
    b.close()
print("ERRORS:", errors or "none")
