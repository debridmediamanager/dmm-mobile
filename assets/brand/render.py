"""Redraws every app icon, TV image and store graphic from the vector DMM logo (logo.svg, the same drawing as
DMM web's dmm-logo-circle.svg), so none of them is an enlarged bitmap.

    python3 assets/brand/render.py
"""
import pathlib
import re
import subprocess
import tempfile

from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parents[2]
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
TEAL = "#00A0B0"
SVG = (pathlib.Path(__file__).with_name("logo.svg")).read_text()
CIRCLE = re.search(r"<circle[^>]*/>", SVG).group(0)
GLYPH = "".join(re.findall(r"<path[^>]*/>", SVG))  # play triangle, wave and crown, in a 200-unit box centred on (100, 100)
GLYPH_BOX = (60, 65, 140, 151)  # x0, y0, x1, y1 of the glyph without its circle


def glyph(height, cx, cy, circle=False):
    """The logo drawn `height` px tall (glyph only, or the whole circle), centred on (cx, cy)."""
    x0, y0, x1, y1 = (40, 40, 160, 160) if circle else GLYPH_BOX
    s = height / (y1 - y0)
    tx, ty = cx - (x0 + x1) / 2 * s, cy - (y0 + y1) / 2 * s
    return f'<g transform="translate({tx:.2f} {ty:.2f}) scale({s:.4f})">{CIRCLE if circle else ""}{GLYPH}</g>'


def image(w, h, inner, background=TEAL):
    bg = f'<rect width="{w}" height="{h}" fill="{background}"/>' if background else ""
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">{bg}{inner}</svg>'


def banner(w, h):
    """Logo and "DMM Mobile" side by side, centred, as on the TV banners."""
    size, text = h * 0.40, h * 0.17
    text_w = text * 5.6  # "DMM Mobile" in SF Pro Bold is about 5.6 em wide
    gap = h * 0.12
    left = (w - (size * 0.93 + gap + text_w)) / 2
    return image(w, h, glyph(size, left + size * 0.93 / 2, h / 2)
                 + f'<text x="{left + size * 0.93 + gap:.1f}" y="{h / 2 + text * 0.36:.1f}" fill="#fff" '
                   f'font-family="-apple-system, Helvetica Neue, sans-serif" font-weight="700" font-size="{text:.1f}">DMM Mobile</text>')


def outputs():
    yield "assets/icon.png", 1024, 1024, image(1024, 1024, glyph(602, 512, 512 + 4)), False
    # Android's adaptive mask keeps the inner 66/108; the whole circle sits inside it on a teal background layer.
    yield "assets/adaptive-icon.png", 1024, 1024, image(1024, 1024, glyph(1024 * 66 / 108, 512, 512, circle=True), None), True
    for name, w, h in [("icon", 1280, 768), ("icon-small", 400, 240), ("icon-small@2x", 800, 480)]:
        yield f"assets/tv/{name}-back.png", w, h, image(w, h, ""), False
        yield f"assets/tv/{name}-front.png", w, h, image(w, h, glyph(h * 0.46, w / 2, h / 2), None), True
    for name, w, h in [("android-banner", 320, 180), ("top-shelf", 1920, 720), ("top-shelf@2x", 3840, 1440),
                       ("top-shelf-wide", 2320, 720), ("top-shelf-wide@2x", 4640, 1440)]:
        yield f"assets/tv/{name}.png", w, h, banner(w, h), False
    # Android's status bar draws only the alpha of a notification icon: the glyph alone, white, on nothing.
    yield "modules/dmm-alerts/android/src/main/res/drawable-xxxhdpi/dmm_alert_icon.png", 96, 96, image(96, 96, re.sub(r'fill="#[0-9A-Fa-f]+"', 'fill="#FFFFFF"', glyph(80, 48, 48)), None), True
    yield "docs/store/screenshots/play-icon.png", 512, 512, image(512, 512, glyph(301, 256, 258)), False
    yield "docs/store/screenshots/play-tv-banner.png", 1280, 720, banner(1280, 720), False


def render(path, w, h, svg, transparent, tmp):
    page = tmp / "page.html"
    page.write_text(f'<html><body style="margin:0;background:transparent">{svg}</body></html>')
    out = ROOT / path
    args = [CHROME, "--headless=new", "--hide-scrollbars", "--force-device-scale-factor=1", f"--window-size={w},{h}",
            f"--screenshot={out}", page.as_uri()]
    if transparent:
        args.insert(1, "--default-background-color=00000000")
    subprocess.run(args, check=True, capture_output=True)
    if not transparent:  # store icons must not carry an alpha channel
        Image.open(out).convert("RGB").save(out, optimize=True)
    print(path)


if __name__ == "__main__":
    with tempfile.TemporaryDirectory() as t:
        for path, w, h, svg, transparent in outputs():
            render(path, w, h, svg, transparent, pathlib.Path(t))
