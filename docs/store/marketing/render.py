"""Store listing slides for every store and platform, in one look: a big headline over the app's real screen in a
device frame, on a DMM teal gradient. Same six slides, same order, same headlines everywhere.

    python3 docs/store/marketing/render.py                  # every set into docs/store/marketing/<set>/
    python3 docs/store/marketing/render.py iphone android-tv  # some sets
    python3 docs/store/marketing/render.py --video <dir>     # backgrounds, frames and geometry for video.py

Each slide is an HTML page at the store's exact pixel size, screenshotted by headless Chrome. The screens in
screens/ are captures of the release build running the screenshot fixture in docs/features.md (Blender open movies, CC BY):
phone and tablet from a Pixel 6 (tablet = wm size 2560x1600), TV from a Fire TV Cube, iPhone, iPad and Apple TV
from simulators. Inter (OFL) comes from Google Fonts once and is cached in ~/.cache/dmm-store-marketing.
"""
import html
import json
import pathlib
import re
import subprocess
import sys
import tempfile
import urllib.request

from PIL import Image

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[2]
SCREENS = HERE / "screens"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
CACHE = pathlib.Path.home() / ".cache/dmm-store-marketing"
LOGO = (ROOT / "assets/brand/logo.svg").read_text()
GLYPH = "".join(re.findall(r"<path[^>]*/>", LOGO))  # play triangle, wave and crown in a 200-unit box
CIRCLE = re.search(r"<circle[^>]*/>", LOGO).group(0).replace("#00A0B0", "#0b5560")  # darker disc on the teal
WHITE_GLYPH = re.sub(r'fill="#[0-9A-Fa-f]+"', 'fill="#FFFFFF"', GLYPH)

# The six slides. Same wording on every platform; line breaks are for two-line layouts.
SLIDES = [
    ("title", "Your debrid library,<br>ready to watch"),
    ("library", "Every film and show<br>you have, as posters"),
    ("player", "4K, Dolby Vision, TrueHD.<br>It just plays."),
    ("home", "Pick up where you left off,<br>on any device"),
    ("details", "See what’s in<br>every file"),
    ("tv", "Made for<br>your TV too"),
]
PILL = {"home": "Syncs with Trakt and Simkl"}

# One gradient per slide, all DMM teal (#00A0B0) into deep petrol/navy, so every set reads as the same row.
# (angle, top, bottom, glow x %, glow y %). Tops stay at or below #00A0B0's brightness: white text keeps >= 3:1.
BACKGROUNDS = [
    (180, "#00A0B0", "#022A33", 50, 62),
    (160, "#0098A7", "#0A2C40", 30, 58),
    (180, "#00808D", "#01090C", 50, 50),
    (200, "#00A0B0", "#032F3A", 70, 60),
    (160, "#008E9C", "#062338", 40, 64),
    (180, "#00A3B3", "#02262E", 50, 58),
]

# Sets: canvas size, layout ("portrait" phones, "landscape" tablets, "tv"), device kind, screen prefix, TV family.
SETS = {
    "iphone": dict(size=(1320, 2868), layout="portrait", device="phone", screens="iphone", tv="appletv",
                   store="App Store iPhone 6.9-inch"),
    "ipad": dict(size=(2752, 2064), layout="landscape", device="tablet", screens="ipad", tv="appletv",
                 store="App Store iPad 13-inch"),
    "appletv": dict(size=(1920, 1080), layout="tv", device="tv", screens="appletv", tv="appletv", store="App Store Apple TV"),
    "android-phone": dict(size=(1080, 1920), layout="portrait", device="phone", screens="android-phone", tv="android-tv",
                          store="Google Play phone"),
    "android-tablet": dict(size=(1920, 1080), layout="landscape", device="tablet", screens="android-tablet", tv="android-tv",
                           store="Google Play 7- and 10-inch tablet, Amazon Fire tablet"),
    "android-tv": dict(size=(1920, 1080), layout="tv", device="tv", screens="android-tv", tv="android-tv",
                       store="Google Play Android TV, Amazon Fire TV"),
}
# Player close-up for portrait canvases: where the logo, badges, chapter and seek bar sit in each phone capture
# (fractions of the landscape screen), cut at a badge boundary.
ZOOM = {"iphone": (0.075, 0.48, 0.499, 0.81), "android-phone": (0.062, 0.48, 0.484, 0.83)}


def fonts():
    """@font-face rules for Inter 600/800 with the woff2 files cached locally (Chrome renders offline after the first run)."""
    css_file = CACHE / "inter.css"
    if not css_file.exists():
        CACHE.mkdir(parents=True, exist_ok=True)
        req = urllib.request.Request("https://fonts.googleapis.com/css2?family=Inter:wght@600;800&display=block",
                                     headers={"User-Agent": "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120 Safari/537.36"})
        css = urllib.request.urlopen(req, timeout=30).read().decode()
        for i, url in enumerate(sorted(set(re.findall(r"url\((https://[^)]+\.woff2)\)", css)))):
            local = CACHE / f"inter-{i}.woff2"
            local.write_bytes(urllib.request.urlopen(url, timeout=30).read())
            css = css.replace(url, local.as_uri())
        css_file.write_text(css)
    return css_file.read_text()


def size(path):
    with Image.open(path) as im:
        return im.size


def screen(set_name, slot):
    return SCREENS / f"{set_name}-{slot}.webp"


def frame_geometry(kind, aspect, box, valign="center", halign="center", stand_fits=True):
    """Fit a device (screen aspect w/h plus bezel, plus a stand for TVs unless stand_fits is False) into box (x, y, w, h)."""
    bx, by, bw, bh = box
    sw1, sh1 = aspect, 1.0  # screen at height 1
    short = min(sw1, sh1)
    bezel1 = {"phone": 0.034 * short, "tablet": 0.032 * short, "tv": 0.011 * sw1}[kind]
    radius1 = {"phone": 0.125 * short, "tablet": 0.055 * short, "tv": 0.007 * sw1}[kind]
    stand1 = 0.075 * sw1 if kind == "tv" else 0.0
    fw1, fh1 = sw1 + 2 * bezel1, sh1 + 2 * bezel1 + (stand1 if stand_fits else 0)
    s = min(bw / fw1, bh / fh1)
    fw, fh = fw1 * s, fh1 * s
    x = bx + {"center": (bw - fw) / 2, "left": 0, "right": bw - fw}[halign]
    y = by + {"center": (bh - fh) / 2, "top": 0, "bottom": bh - fh}[valign]
    return dict(kind=kind, x=x, y=y, w=fw, h=fh - (stand1 * s if stand_fits else 0), bezel=bezel1 * s, radius=radius1 * s, stand=stand1 * s,
                sx=x + bezel1 * s, sy=y + bezel1 * s, sw=sw1 * s, sh=sh1 * s)


def device_html(g, src=None, z=1):
    """Device frame as a border ring (its middle stays transparent for video), the screen inside; TVs get a stand."""
    out = (f'<div class="dev" style="left:{g["x"]:.1f}px;top:{g["y"]:.1f}px;width:{g["w"]:.1f}px;height:{g["h"]:.1f}px;'
           f'border-width:{g["bezel"]:.1f}px;border-radius:{g["radius"]:.1f}px;z-index:{z}">')
    if src:
        out += f'<img src="{src.as_uri()}" style="border-radius:{max(g["radius"] - g["bezel"], 0):.1f}px">'
    out += "</div>"
    if g["stand"]:
        neck_w, neck_h = g["w"] * 0.05, g["stand"] * 0.62
        foot_w, foot_h = g["w"] * 0.26, g["stand"] * 0.2
        cx, top = g["x"] + g["w"] / 2, g["y"] + g["h"]
        out += (f'<div class="stand" style="left:{cx - neck_w / 2:.1f}px;top:{top:.1f}px;width:{neck_w:.1f}px;height:{neck_h:.1f}px;z-index:{z - 1}"></div>'
                f'<div class="stand foot" style="left:{cx - foot_w / 2:.1f}px;top:{top + neck_h:.1f}px;width:{foot_w:.1f}px;'
                f'height:{foot_h:.1f}px;border-radius:{foot_h / 2:.1f}px;z-index:{z - 1}"></div>')
    return out


_WIDTHS = {}


def line_widths():
    """Width of every headline line (and of each whole headline on one line) in Inter 800 at 100 px, measured by Chrome."""
    if not _WIDTHS:
        lines = sorted({part for _, t in SLIDES for part in t.split("<br>")} | {t.replace("<br>", " ") for _, t in SLIDES})
        spans = "".join(f'<span style="white-space:nowrap">{t}</span><br>' for t in lines)
        doc = (f"<!doctype html><html><head><meta charset=utf-8><style>{fonts()} body{{font:800 100px Inter;letter-spacing:-.025em}}</style>"
               f"</head><body>{spans}<script>document.fonts.ready.then(()=>{{document.body.dataset.w=JSON.stringify("
               f"[...document.querySelectorAll('span')].map(s=>[s.textContent,s.getBoundingClientRect().width]))}})</script></body></html>")
        with tempfile.TemporaryDirectory() as t:
            src = pathlib.Path(t) / "m.html"
            src.write_text(doc)
            dom = run_chrome(["--allow-file-access-from-files", "--virtual-time-budget=6000", "--dump-dom", src.as_uri()], pathlib.Path(t))
        _WIDTHS.update(json.loads(html.unescape(re.search(r'data-w="([^"]+)"', dom).group(1))))
    return _WIDTHS


def headline_metrics(w, h, layout):
    """Font size, top, line count and where the device area starts. One size per set: the longest line of all six
    headlines fits the width. The pill row is reserved on every slide so the device sits in the same place."""
    widths = line_widths()
    if layout != "portrait":  # landscape canvases: one line, so the device gets the height
        longest = max(v for k, v in widths.items() if any(k == t.replace("<br>", " ") for _, t in SLIDES))
    else:
        longest = max(v for k, v in widths.items() if any(k in t.split("<br>") for _, t in SLIDES))
    cap, room = {"portrait": (0.08, 0.9), "landscape": (0.05, 0.88), "tv": (0.036, 0.88)}[layout]
    fs = min(cap * w, room * w * 100 / longest)
    top = {"portrait": 0.05 * h, "landscape": 0.055 * h, "tv": 0.058 * h}[layout]
    lines = 2 if layout == "portrait" else 1
    pill_fs = fs * 0.36
    pill_top = top + lines * fs * 1.06 + fs * 0.32
    device_top = pill_top + pill_fs * 2.1 + fs * 0.42
    return fs, top, lines, pill_fs, pill_top, device_top


def layout(set_name, slot, w=None, h=None, video=False):
    """Everything on one slide: background/headline parameters and device geometries (with their screens)."""
    cfg = SETS[set_name]
    w, h = w or cfg["size"][0], h or cfg["size"][1]
    lay = cfg["layout"]
    fs, top, lines, pill_fs, pill_top, device_top = headline_metrics(w, h, lay)
    mx = {"portrait": 0.06, "landscape": 0.07, "tv": 0.07}[lay] * w
    mb = {"portrait": 0.04, "landscape": 0.025, "tv": 0.035}[lay] * h
    box = (mx, device_top, w - 2 * mx, h - device_top - mb)
    bx, by, bw, bh = box
    devices, extras = [], []
    prefix = cfg["screens"]
    if slot == "tv":
        tv = cfg["tv"]
        rail, sign = screen(tv, "rail"), screen(tv, "signin")
        a = 16 / 9
        bx, by, bw, bh = box
        if lay == "portrait":
            # Two TVs stacked at full width: the slim rail, then sign-in with the phone.
            g1 = frame_geometry("tv", a, (bx - mx * 0.5, by, bw + mx, bh))
            g2 = frame_geometry("tv", a, (bx - mx * 0.5, by, bw + mx, bh))
            gap = bh * 0.035
            group = 2 * (g1["h"] + g1["stand"]) + gap
            for g, dy in ((g1, 0), (g2, g1["h"] + g1["stand"] + gap)):
                g["y"] = by + (bh - group) / 2 + dy
                g["sy"] = g["y"] + g["bezel"]
        else:
            g1 = frame_geometry("tv", a, (bx, by, bw * 0.76, h - by - 0.03 * h), "top", "left", stand_fits=lay != "tv")
            g2 = frame_geometry("tv", a, (bx + bw * 0.5, by + bh * 0.4, bw * 0.5, bh * 0.6), "bottom", "right")
        devices = [(g1, rail), (g2, sign)]
    elif slot == "player" and lay == "portrait":
        src = screen(prefix, "player")
        sw, sh = size(src)
        bx, by, bw, bh = box
        if video:
            devices = [(frame_geometry("phone", sw / sh, (0, by, w, bh)), src)]
        else:
            gx = frame_geometry("phone", sw / sh, (bx - mx * 0.6, by, bw + mx * 1.2, bh * 0.45), "top")
            x0, y0, x1, y1 = ZOOM[prefix]
            cw = bw
            ch = cw * ((y1 - y0) * sh) / ((x1 - x0) * sw)
            gap = bh * 0.05
            shift = (bh - (gx["h"] + gap + ch)) * 0.22  # near the headline, like the other slides
            for k in ("y", "sy"):
                gx[k] += shift
            devices = [(gx, src)]
            cy = gx["y"] + gx["h"] + gap
            extras.append(dict(type="zoom", src=src, crop=(x0, y0, x1, y1), x=bx, y=cy, w=cw, h=ch,
                               mark=(gx["sx"] + x0 * gx["sw"], gx["sy"] + y0 * gx["sh"], (x1 - x0) * gx["sw"], (y1 - y0) * gx["sh"])))
    else:
        src = screen(prefix, slot)
        sw, sh = size(src)
        if lay == "tv":  # the stand may run off the bottom edge: the screen gets the room
            devices = [(frame_geometry("tv", sw / sh, (bx, by, bw, h - by - 0.03 * h), stand_fits=False), src)]
        else:
            devices = [(frame_geometry(cfg["device"], sw / sh, box), src)]
    return dict(w=w, h=h, lay=lay, fs=fs, top=top, lines=lines, pill_fs=pill_fs, pill_top=pill_top, slot=slot,
                index=[s for s, _ in SLIDES].index(slot), devices=devices, extras=extras)


CSS = """
%(fonts)s
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: %(w)dpx; height: %(h)dpx; overflow: hidden; background: %(page)s; }
body { position: relative; font-family: Inter, sans-serif; color: #fff; -webkit-font-smoothing: antialiased; }
.bg { position: absolute; inset: 0; overflow: hidden; }
.glyph { position: absolute; opacity: .07; }
h1 { position: absolute; left: 0; right: 0; text-align: center; white-space: nowrap; font-weight: 800; letter-spacing: -.025em;
  line-height: 1.06; text-shadow: 0 2px 18px rgba(0, 30, 40, .35); }
.pill { position: absolute; left: 50%%; transform: translateX(-50%%); white-space: nowrap; font-weight: 600;
  letter-spacing: -.005em; padding: .42em 1.05em; border-radius: 999px; background: rgba(255, 255, 255, .14);
  border: 1.5px solid rgba(255, 255, 255, .32); }
.dev { position: absolute; border-style: solid; border-color: #0b0e13; background: transparent;
  box-shadow: 0 0 0 1.5px rgba(255, 255, 255, .16), 0 30px 90px rgba(0, 0, 0, .42), 0 8px 24px rgba(0, 0, 0, .3); }
.dev img { display: block; width: 100%%; height: 100%%; }
.stand { position: absolute; background: linear-gradient(180deg, #05080b, #161b22); }
.zoom { position: absolute; overflow: hidden; border: 2px solid rgba(255, 255, 255, .35);
  box-shadow: 0 24px 70px rgba(0, 0, 0, .45); background-repeat: no-repeat; }
.mark { position: absolute; border: 2px solid rgba(255, 255, 255, .85); }
.card { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; }
"""


def background(index, w, h, mark=True):
    """The slide's gradient with a soft glow and, faintly in a corner, the DMM glyph."""
    angle, top, bottom, gx, gy = BACKGROUNDS[index]
    glyph = (f'<svg class="glyph" style="right:{-0.12 * max(w, h):.0f}px;bottom:{-0.1 * max(w, h):.0f}px" '
             f'width="{0.62 * max(w, h):.0f}" height="{0.62 * max(w, h):.0f}" viewBox="55 60 90 95">{WHITE_GLYPH}</svg>') if mark else ""
    return (f'<div class="bg" style="background:radial-gradient(60% 45% at {gx}% {gy}%, rgba(64, 232, 244, .28), transparent 70%),'
            f'linear-gradient({angle}deg, {top} 0%, {bottom} 100%)">{glyph}</div>')


def text_html(L):
    head = SLIDES[L["index"]][1] if L["lines"] == 2 else SLIDES[L["index"]][1].replace("<br>", " ")
    out = f'<h1 style="top:{L["top"]:.1f}px;font-size:{L["fs"]:.1f}px">{head}</h1>'
    if L["slot"] in PILL:
        out += f'<div class="pill" style="top:{L["pill_top"]:.1f}px;font-size:{L["pill_fs"]:.1f}px">{html.escape(PILL[L["slot"]])}</div>'
    return out


def page(L, part="all"):
    """part: all (the slide), bg (background + headline only), frame (device rings only, transparent page)."""
    body = ""
    if part in ("all", "bg"):
        body += background(L["index"], L["w"], L["h"]) + text_html(L)
    if part in ("all", "frame"):
        for i, (g, src) in enumerate(L["devices"]):
            body += device_html(g, src if part == "all" else None, z=2 + i)
    if part == "all":
        for e in L["extras"]:
            x0, y0, x1, y1 = e["crop"]
            fw = e["w"] / (x1 - x0)
            fh = e["h"] / (y1 - y0)
            r = e["w"] * 0.035
            mx, my, mw, mh = e["mark"]
            body += (f'<div class="mark" style="left:{mx:.1f}px;top:{my:.1f}px;width:{mw:.1f}px;height:{mh:.1f}px;border-radius:{r * 0.35:.1f}px;z-index:9"></div>'
                     f'<div class="zoom" style="left:{e["x"]:.1f}px;top:{e["y"]:.1f}px;width:{e["w"]:.1f}px;height:{e["h"]:.1f}px;'
                     f'border-radius:{r:.1f}px;background-image:url({e["src"].as_uri()});background-size:{fw:.1f}px {fh:.1f}px;'
                     f'background-position:{-x0 * fw:.1f}px {-y0 * fh:.1f}px;z-index:9"></div>')
    css = CSS % {"fonts": fonts(), "w": L["w"], "h": L["h"], "page": "transparent" if part == "frame" else "#022a33"}
    return f"<!doctype html><html><head><meta charset=utf-8><style>{css}</style></head><body>{body}</body></html>"


def run_chrome(args, tmp):
    """Headless Chrome with its own profile (a running desktop Chrome is left alone); it fails now and then: retry."""
    for attempt in range(3):
        done = subprocess.run([CHROME, "--headless=new", f"--user-data-dir={tmp / 'profile'}", *args], capture_output=True, text=True)
        if done.returncode == 0:
            return done.stdout
    raise RuntimeError(f"Chrome failed 3 times: {done.stderr[-500:]}")


def chrome(doc, w, h, out, tmp, transparent=False):
    src = tmp / "page.html"
    src.write_text(doc)
    args = ["--hide-scrollbars", "--force-device-scale-factor=1", "--allow-file-access-from-files",
            f"--window-size={w},{h}", f"--screenshot={out}", "--virtual-time-budget=6000", src.as_uri()]
    if transparent:
        args.insert(0, "--default-background-color=00000000")
    run_chrome(args, tmp)


def save_jpeg(png, out, quality=88):
    with Image.open(png) as im:
        im.convert("RGB").save(out, "JPEG", quality=quality, optimize=True, progressive=True, subsampling=0)


def extra_pages():
    """Store graphics in the same look: Play feature graphic (= Amazon promo image) and the Fire TV background."""
    def fg():
        w, h = 1024, 500
        tv = frame_geometry("tv", 16 / 9, (500, 70, 470, 330), "top", "left")
        ph = frame_geometry("phone", 1080 / 2400, (820, 120, 170, 360), "top", "left")
        body = background(0, w, h, mark=False)
        body += (f'<svg style="position:absolute;left:58px;top:126px" width="104" height="104" viewBox="40 40 120 120">'
                 f'{CIRCLE}{GLYPH}</svg>'
                 f'<div style="position:absolute;left:58px;top:250px;font-weight:800;font-size:56px;letter-spacing:-.025em">DMM Mobile</div>'
                 f'<div style="position:absolute;left:60px;top:322px;font-weight:600;font-size:23px;opacity:.92">Your debrid library, ready to watch</div>')
        body += device_html(tv, screen("android-tv", "home"), 2) + device_html(ph, screen("android-phone", "home"), 3)
        return "play-feature-graphic", w, h, body

    def firetv_background():
        # Amazon draws its own text over this: no words or logo, the demo library's posters on the right.
        w, h = 1920, 1080
        lib = screen("android-tv", "library")
        posters = [(113 + 256 * c, 262 + 450 * r) for r in range(2) for c in range(7) if not (r == 1 and c == 6)]
        tiles = ""
        for i in range(18):
            px, py = posters[i % len(posters)]
            col, row = i % 6, i // 6
            x, y = 820 + col * 250 - row * 80, -120 + row * 400
            tiles += (f'<div style="position:absolute;left:{x}px;top:{y}px;width:230px;height:346px;border-radius:14px;'
                      f'background:url({lib.as_uri()}) -{px * 230 / 235:.0f}px -{py * 346 / 352:.0f}px / {1920 * 230 / 235:.0f}px {1080 * 346 / 352:.0f}px;'
                      f'box-shadow:0 18px 50px rgba(0,0,0,.45)"></div>')
        body = background(5, w, h, mark=False)
        body += (f'<div style="position:absolute;inset:0;transform:rotate(-8deg);transform-origin:70% 50%">{tiles}</div>'
                 f'<div style="position:absolute;inset:0;background:linear-gradient(90deg,#02303a 0%,#02303a 34%,rgba(2,48,58,.55) 55%,rgba(2,48,58,0) 80%)"></div>')
        return "amazon-firetv-background", w, h, body

    for make in (fg, firetv_background):
        name, w, h, body = make()
        css = CSS % {"fonts": fonts(), "w": w, "h": h, "page": "#022a33"}
        yield name, w, h, f"<!doctype html><html><head><meta charset=utf-8><style>{css}</style></head><body>{body}</body></html>"


def render_sets(names):
    with tempfile.TemporaryDirectory() as t:
        t = pathlib.Path(t)
        for name in [n for n in names if n in SETS]:
            out_dir = HERE / name
            out_dir.mkdir(exist_ok=True)
            for old in out_dir.glob("*.jpg"):
                old.unlink()
            w, h = SETS[name]["size"]
            for i, (slot, _) in enumerate(SLIDES):
                L = layout(name, slot)
                chrome(page(L), w, h, t / "s.png", t)
                out = out_dir / f"{i + 1}-{slot}.jpg"
                save_jpeg(t / "s.png", out)
                print(out.relative_to(ROOT), f"{w}x{h}", f"{out.stat().st_size // 1024} KB")
        if "extras" in names:
            for name, w, h, doc in extra_pages():
                chrome(doc, w, h, t / "s.png", t)
                out = HERE / f"{name}.jpg"
                save_jpeg(t / "s.png", out, 92)
                print(out.relative_to(ROOT), f"{w}x{h}", f"{out.stat().st_size // 1024} KB")


# Video layouts: (canvas, set whose layout it borrows, segments). video.py composes the recordings into them.
VIDEOS = {
    "iphone-preview": ((886, 1920), "iphone", ["title", "player"]),
    "appletv-preview": ((1920, 1080), "appletv", ["title", "player"]),
    "firetv-landscape": ((1920, 1080), "android-tv", ["title", "player"]),
}


def render_video_assets(out):
    out.mkdir(parents=True, exist_ok=True)
    geo = {}
    with tempfile.TemporaryDirectory() as t:
        t = pathlib.Path(t)
        for vid, ((w, h), set_name, slots) in VIDEOS.items():
            geo[vid] = {"size": [w, h], "segments": {}}
            for slot in slots:
                L = layout(set_name, slot, w, h, video=True)
                bg, fr = out / f"{vid}-{slot}-bg.png", out / f"{vid}-{slot}-frame.png"
                chrome(page(L, "bg"), w, h, bg, t)
                with Image.open(bg) as im:
                    im.convert("RGB").save(bg)
                chrome(page(L, "frame"), w, h, fr, t, transparent=True)
                g = L["devices"][0][0]
                geo[vid]["segments"][slot] = {k: round(g[k]) for k in ("sx", "sy", "sw", "sh")}
            # End card: the logo and the name on the first slide's gradient.
            card = (background(0, w, h) +
                    f'<div class="card"><svg width="{0.3 * min(w, h):.0f}" height="{0.3 * min(w, h):.0f}" viewBox="40 40 120 120">'
                    f'{CIRCLE}{GLYPH}</svg>'
                    f'<div style="font-weight:800;font-size:{0.085 * min(w, h):.0f}px;letter-spacing:-.025em;margin-top:{0.04 * min(w, h):.0f}px">DMM Mobile</div></div>')
            css = CSS % {"fonts": fonts(), "w": w, "h": h, "page": "#022a33"}
            chrome(f"<!doctype html><html><head><meta charset=utf-8><style>{css}</style></head><body>{card}</body></html>", w, h, out / f"{vid}-card.png", t)
    (out / "geometry.json").write_text(json.dumps(geo, indent=1))
    print(out / "geometry.json")


if __name__ == "__main__":
    args = sys.argv[1:]
    if args[:1] == ["--video"]:
        render_video_assets(pathlib.Path(args[1]))
    else:
        render_sets(args or [*SETS, "extras"])
