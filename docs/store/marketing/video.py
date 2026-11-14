"""Store preview videos from real screen recordings, in the slides' look: the recording inside the device frame on
the slide background with its headline, a cut from browsing to playback, then the logo card. Silent stereo track.

    python3 docs/store/marketing/render.py --video <assets>
    python3 docs/store/marketing/video.py <assets> <recordings> <out>

Recordings (README screenshot fixture, Blender open movies): iphone-rec.mov (`simctl io recordVideo`, iPhone 17 Pro
Max simulator, portrait, so its landscape player is turned back here), atv-rec.mov (Apple TV 4K at 1080p simulator),
ftv-rec.mp4 (Fire TV Cube, `adb shell screenrecord`). The cuts below are seconds into those files.
"""
import json
import pathlib
import subprocess
import sys

# video: (recording, browse segment, playback segment, turn the playback segment back to landscape, lead still).
# The simulator writes a frame only when the screen changes, so the iPhone file starts at the first tap (Library):
# the preview opens on the captured Home screen instead.
CUTS = {
    "iphone-preview": ("iphone-rec.mov", (4.69, 11.25), (14.5, 24.9), True, ("iphone-home.webp", 2.2)),
    "appletv-preview": ("atv-rec.mov", (2.2, 14.1), (16.8, 27.5), False, None),
    "firetv-landscape": ("ftv-rec.mp4", (1.0, 16.1), (21.7, 31.0), False, None),
}
SCREENS = pathlib.Path(__file__).resolve().parent / "screens"
FADE, CARD_FADE, CARD = 0.5, 0.6, 3.2


def even(n):
    return n + (n % 2)


def compose(name, assets, recordings, out):
    geo = json.loads((assets / "geometry.json").read_text())[name]
    w, h = geo["size"]
    rec, (a0, a1), (b0, b1), turn, lead = CUTS[name]
    lead_len = lead[1] if lead else 0
    la, lb = a1 - a0 + lead_len, b1 - b0
    total = la + lb + CARD - FADE - CARD_FADE
    ga, gb = geo["segments"]["title"], geo["segments"]["player"]
    fmt = "settb=AVTB,fps=30,format=yuv420p"
    graph = (
        f"[0:v]split=2[r1][r2];"
        f"[r1]trim={a0}:{a1},setpts=PTS-STARTPTS,fps=30,format=rgb24,scale={even(ga['sw'])}:{even(ga['sh'])},settb=AVTB[a0];"
        + (f"[7:v]fps=30,format=rgb24,scale={even(ga['sw'])}:{even(ga['sh'])},settb=AVTB[l];[l][a0]concat=n=2:v=1[a];" if lead else "[a0]null[a];") +
        f"[1:v][a]overlay={ga['sx']}:{ga['sy']}:shortest=1[a1];[a1][2:v]overlay=0:0,{fmt}[A];"
        f"[r2]trim={b0}:{b1},setpts=PTS-STARTPTS,fps=30,format=rgb24,{'transpose=2,' if turn else ''}"
        f"scale={even(gb['sw'])}:{even(gb['sh'])}[b];"
        f"[3:v][b]overlay={gb['sx']}:{gb['sy']}:shortest=1[b1];[b1][4:v]overlay=0:0,{fmt}[B];"
        f"[5:v]{fmt}[C];"
        f"[A][B]xfade=transition=fade:duration={FADE}:offset={la - FADE:.3f}[AB];"
        f"[AB][C]xfade=transition=fade:duration={CARD_FADE}:offset={la + lb - FADE - CARD_FADE:.3f},format=yuv420p[v]"
    )
    img = lambda path, dur: ["-loop", "1", "-framerate", "30", "-t", f"{dur:.3f}", "-i", str(path)]
    args = ["ffmpeg", "-y", "-v", "error", "-i", str(recordings / rec),
            *img(assets / f"{name}-title-bg.png", la), *img(assets / f"{name}-title-frame.png", la),
            *img(assets / f"{name}-player-bg.png", lb), *img(assets / f"{name}-player-frame.png", lb),
            *img(assets / f"{name}-card.png", CARD),
            "-f", "lavfi", "-t", f"{total:.3f}", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
            *(img(SCREENS / lead[0], lead[1]) if lead else []),
            "-filter_complex", graph, "-map", "[v]", "-map", "6:a",
            "-c:v", "libx264", "-profile:v", "high", "-level:v", "4.0", "-preset", "slow", "-crf", "17",
            "-maxrate", "12M", "-bufsize", "24M", "-r", "30", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "256k", "-ac", "2", "-ar", "48000", "-t", f"{total:.3f}", "-movflags", "+faststart",
            str(out / f"{name}.mp4")]
    subprocess.run(args, check=True)
    print(out / f"{name}.mp4", f"{w}x{h}", f"{total:.1f} s")


if __name__ == "__main__":
    assets, recordings, out = (pathlib.Path(a) for a in sys.argv[1:4])
    out.mkdir(parents=True, exist_ok=True)
    for name in sys.argv[4:] or CUTS:
        compose(name, assets, recordings, out)
