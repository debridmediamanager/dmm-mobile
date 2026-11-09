"""Renders the App Store marketing screenshots from the app's real screen captures.

    python3 docs/store/marketing/render.py      # writes docs/store/screenshots/appstore-*.png

Each slide is an HTML page sized to Apple's exact pixels and screenshotted by headless Chrome. The phone,
tablet and TV pictures inside are untouched captures of the release build (docs/screenshots, docs/store/screenshots).
"""
import html
import pathlib
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[3]
SHOTS = ROOT / "docs/screenshots"
STORE = ROOT / "docs/store/screenshots"
OUT = STORE
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

# Provider badge colours as the app draws them (src/ui.tsx ProviderBadge).
PROVIDERS = [("RD", "#a3d977", "#10210a"), ("AD", "#f6c344", "#2a1e00"), ("TB", "#5b5bd6", "#fff"),
             ("PM", "#d9302c", "#fff"), ("OC", "#f08a24", "#2a1300"), ("DL", "#38bdf8", "#04202e")]

BASE_CSS = """
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: %(w)dpx; height: %(h)dpx; overflow: hidden; background: #04060c; }
body { font-family: -apple-system, "SF Pro Display", "Helvetica Neue", sans-serif; color: #f4f7fb;
  -webkit-font-smoothing: antialiased; position: relative; }
.bg { position: absolute; inset: 0; overflow: hidden;
  background: radial-gradient(120%% 80%% at 50%% 0%%, #0b1a2e 0%%, #04060c 60%%); }
.blob { position: absolute; border-radius: 50%%; filter: blur(%(blur)dpx); opacity: .75; }
.grid { position: absolute; inset: 0; opacity: .22;
  background-image: linear-gradient(rgba(255,255,255,.06) 1px, transparent 1px),
                    linear-gradient(90deg, rgba(255,255,255,.06) 1px, transparent 1px);
  background-size: %(grid)dpx %(grid)dpx;
  -webkit-mask-image: radial-gradient(70%% 55%% at 50%% 30%%, #000 0%%, transparent 75%%); }
.eyebrow { display: inline-flex; align-items: center; gap: .5em; font-weight: 700; letter-spacing: .14em;
  text-transform: uppercase; color: #8be9f2; padding: .55em 1.1em; border-radius: 999px;
  background: rgba(0,160,176,.14); border: 1.5px solid rgba(139,233,242,.35); }
.eyebrow i { width: .55em; height: .55em; border-radius: 50%%; background: #2ee6f2; box-shadow: 0 0 18px #2ee6f2; }
h1 { font-weight: 800; letter-spacing: -.035em; line-height: 1.02; }
h1 em { font-style: normal; background: linear-gradient(100deg, #5ef0f8 0%%, #7aa8ff 55%%, #b18cff 100%%);
  -webkit-background-clip: text; background-clip: text; color: transparent; }
p.sub { color: #a9b6c8; font-weight: 500; line-height: 1.32; letter-spacing: -.01em; }
.device { position: absolute; background: linear-gradient(150deg, #5b6270 0%%, #1b1f27 22%%, #0d1016 60%%, #3a404c 100%%);
  box-shadow: 0 0 0 2px rgba(255,255,255,.10) inset, 0 0 0 1px rgba(0,0,0,.9),
              0 80px 160px rgba(0,0,0,.65), 0 0 220px rgba(0,180,200,.22); }
.device img { display: block; width: 100%%; height: auto; }
.chips { display: flex; flex-wrap: wrap; gap: .45em; }
.chip { font-weight: 800; letter-spacing: .02em; padding: .28em .62em; border-radius: .34em; }
"""


def blobs(w, h, spots):
    return "".join(
        f'<div class="blob" style="left:{x * w - r * w / 2:.0f}px;top:{y * h - r * w / 2:.0f}px;width:{r * w:.0f}px;'
        f'height:{r * w:.0f}px;background:{c}"></div>' for x, y, r, c in spots)


def chips(size):
    return '<div class="chips" style="font-size:%dpx">%s</div>' % (size, "".join(
        f'<span class="chip" style="background:{bg};color:{fg}">{name}</span>' for name, bg, fg in PROVIDERS))


def page(w, h, body, spots, blur=None, grid=None):
    css = BASE_CSS % {"w": w, "h": h, "blur": blur or w // 7, "grid": grid or w // 12}
    return (f"<!doctype html><html><head><meta charset=utf-8><style>{css}</style></head><body>"
            f'<div class="bg">{blobs(w, h, spots)}<div class="grid"></div></div>{body}</body></html>')


def phone(src, left, top, width, tilt=0, z=1):
    pad, radius = width * 0.028, width * 0.155
    return (f'<div class="device" style="left:{left}px;top:{top}px;width:{width}px;padding:{pad:.0f}px;'
            f'border-radius:{radius:.0f}px;transform:rotate({tilt}deg);z-index:{z}">'
            f'<img src="{src.as_uri()}" style="border-radius:{radius - pad:.0f}px"></div>')


def tablet(src, left, top, width, tilt=0, z=1):
    pad, radius = width * 0.026, width * 0.06
    return (f'<div class="device" style="left:{left}px;top:{top}px;width:{width}px;padding:{pad:.0f}px;'
            f'border-radius:{radius:.0f}px;transform:rotate({tilt}deg);z-index:{z}">'
            f'<img src="{src.as_uri()}" style="border-radius:{radius - pad:.0f}px"></div>')


def screen(src, left, top, width, z=1):
    pad, radius = width * 0.012, width * 0.018
    return (f'<div class="device" style="left:{left}px;top:{top}px;width:{width}px;padding:{pad:.0f}px;'
            f'border-radius:{radius:.0f}px;z-index:{z}"><img src="{src.as_uri()}" style="border-radius:{radius - pad:.0f}px"></div>')


def header(eyebrow, title, sub, size, left, top, width, align="left"):
    return (f'<div style="position:absolute;left:{left}px;top:{top}px;width:{width}px;text-align:{align};z-index:5">'
            f'<div class="eyebrow" style="font-size:{size * .26:.0f}px"><i></i>{html.escape(eyebrow)}</div>'
            f'<h1 style="font-size:{size}px;margin-top:{size * .38:.0f}px">{title}</h1>'
            f'<p class="sub" style="font-size:{size * .36:.0f}px;margin-top:{size * .32:.0f}px">{html.escape(sub)}</p></div>')


AURORA = [(.15, .12, .9, "#007f8c"), (.95, .30, .8, "#3047c9"), (.40, .75, 1.0, "#0f3b7a"), (.95, .95, .7, "#6a2bd6")]
AURORA2 = [(.85, .10, .9, "#00a0b0"), (.05, .40, .8, "#3a2bb8"), (.60, .85, 1.1, "#0b4f8a")]


def iphone_slides():
    w, h, s = 1320, 2868, 118
    X = 110
    yield "appstore-iphone-1-library", w, h, page(w, h, header(
        "Debrid Media Manager", "Your debrid library.<br><em>Everywhere.</em>",
        "Every file from every service you use, in one fast list.", s, X, 190, 1100)
        + f'<div style="position:absolute;left:{X}px;top:800px;z-index:5">{chips(46)}</div>'
        + phone(STORE / "ios-iphone-1-library.png", 170, 1020, 980), AURORA)
    yield "appstore-iphone-2-detail", w, h, page(w, h, header(
        "Play anything", "One tap from<br><em>file to film.</em>",
        "Videos open in the player you choose, subtitles included.", s, X, 190, 1100)
        + phone(STORE / "ios-iphone-2-detail.png", 170, 980, 980), AURORA2)
    yield "appstore-iphone-3-menu", w, h, page(w, h, header(
        "Stay in control", "Tidy up<br><em>in seconds.</em>",
        "Select, reinsert, share or delete, one at a time or in bulk.", s, X, 190, 1100)
        + phone(STORE / "ios-iphone-3-menu.png", 230, 960, 860), AURORA)
    yield "appstore-iphone-4-sign-in", w, h, page(w, h, header(
        "Six services", "Sign in once.<br><em>Done.</em>",
        "Your other logins and settings come back on every device.", s, X, 190, 1100)
        + phone(SHOTS / "iphone-sign-in.png", 170, 980, 980), AURORA2)
    yield "appstore-iphone-5-everywhere", w, h, page(w, h, header(
        "iPhone · iPad · Apple TV", "Phone, tablet<br><em>and the big screen.</em>",
        "Browse with your thumb or your remote. Same library.", s, X, 190, 1100)
        + screen(SHOTS / "appletv-library.png", 110, 860, 1100, z=1)
        + tablet(SHOTS / "ipad-library.png", 110, 1560, 700, z=2)
        + phone(STORE / "ios-iphone-2-detail.png", 850, 1520, 360, z=3), AURORA)


def ipad_slides():
    w, h, s = 2064, 2752, 150
    yield "appstore-ipad-1-library", w, h, page(w, h, header(
        "Debrid Media Manager", "Your whole library,<br><em>at a glance.</em>",
        "Thousands of items, searched, filtered and sorted instantly.", s, 170, 170, 1700)
        + tablet(SHOTS / "ipad-library.png", 232, 1000, 1600), AURORA)
    yield "appstore-ipad-2-everywhere", w, h, page(w, h, header(
        "iPhone · iPad · Apple TV", "Every screen.<br><em>One library.</em>",
        "Sign in once and your services follow you to every device.", s, 170, 170, 1700)
        + screen(SHOTS / "appletv-library.png", 170, 900, 1724, z=1)
        + tablet(SHOTS / "ipad-library.png", 170, 1950, 1080, z=2)
        + phone(STORE / "ios-iphone-2-detail.png", 1340, 1880, 554, z=3), AURORA2)


def tv_slides():
    w, h, s = 3840, 2160, 150
    def slide(name, eyebrow, title, sub, src, spots):
        return name, w, h, page(w, h, header(eyebrow, title, sub, s, 200, 640, 1050)
                                + screen(src, 1400, 400, 2240), spots, blur=420, grid=180)
    yield slide("appstore-appletv-1-library", "Apple TV", "Your library<br>on the<br><em>big screen.</em>",
                "Every file from every service, browsed with the remote.", SHOTS / "appletv-library.png", AURORA)
    yield slide("appstore-appletv-2-select", "Made for the remote", "Select many.<br><em>Act once.</em>",
                "Mark several titles with the remote and handle them together.", SHOTS / "appletv-select.png", AURORA2)
    yield slide("appstore-appletv-3-menu", "Stay in control", "Every action,<br><em>one click away.</em>",
                "Details, selection and cleanup without leaving the couch.", SHOTS / "appletv-menu.png", AURORA)


def render(name, w, h, doc, tmp):
    src = tmp / f"{name}.html"
    src.write_text(doc)
    out = OUT / f"{name}.png"
    subprocess.run([CHROME, "--headless=new", "--hide-scrollbars", "--force-device-scale-factor=1",
                    "--allow-file-access-from-files", f"--window-size={w},{h}", f"--screenshot={out}",
                    "--virtual-time-budget=4000", src.as_uri()], check=True, capture_output=True)
    print(out.relative_to(ROOT))


if __name__ == "__main__":
    with tempfile.TemporaryDirectory() as t:
        for slide in [*iphone_slides(), *ipad_slides(), *tv_slides()]:
            render(*slide, pathlib.Path(t))
