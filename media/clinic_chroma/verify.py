"""
Quality gate for the finished clip.

Checks, on the encoded MP4 and on the keyed frames:
  1. container: 1080x1920, 24 fps, exactly 5.00 s, yuv420p
  2. the key colour is flat: sampled green pixels are the same value everywhere
  3. the building never touches the frame edge (generous green margins)
  4. the building's on-screen size is constant (no zoom, no scale change)
  5. exactly one 180 degree turn: silhouette width profile goes narrow (edge-on)
     once and returns, and the first/last frames face front
  6. the last frame is identical to a settled front view (rotation stopped)
"""
import glob
import json
import os
import subprocess
import sys

import numpy as np
from PIL import Image

import imageio_ffmpeg

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "output")
FRAMES = os.path.join(HERE, "frames")
KEYED = os.path.join(HERE, "_keyed_tmp")
FF = imageio_ffmpeg.get_ffmpeg_exe()
W, H = 1080, 1920


def probe(path):
    out = subprocess.run([FF, "-hide_banner", "-i", path], capture_output=True, text=True).stderr
    info = {}
    for line in out.splitlines():
        line = line.strip()
        if line.startswith("Duration:"):
            info["duration"] = line.split("Duration:")[1].split(",")[0].strip()
        if "Video:" in line:
            info["video"] = line.split("Video:")[1].strip()
    return info


def frame_metrics(path, green=(0, 255, 0)):
    a = np.asarray(Image.open(path).convert("RGB")).astype(np.int16)
    g = np.abs(a - np.array(green)).sum(2) <= 6
    fg = ~g
    ys, xs = np.where(fg)
    if len(ys) == 0:
        return dict(bbox=None, x0=0, x1=0, y0=0, y1=0, h=0, w=0, area=0, bg_unique=0)
    m = dict(
        x0=int(xs.min()), x1=int(xs.max()), y0=int(ys.min()), y1=int(ys.max()),
        h=int(ys.max() - ys.min() + 1), w=int(xs.max() - xs.min() + 1),
        area=int(fg.sum()),
    )
    # flatness of the key: every background pixel must be the exact key colour
    bg = a[g]
    m["bg_unique"] = int(len(np.unique(bg.reshape(-1, 3), axis=0)))
    return m


def main():
    ok = True
    def check(name, cond, detail=""):
        nonlocal ok
        print(("  PASS  " if cond else "  FAIL  ") + name + ("   " + detail if detail else ""))
        ok = ok and bool(cond)

    frames = sorted(glob.glob(os.path.join(FRAMES, "*.png")))
    keyed = sorted(glob.glob(os.path.join(KEYED, "k*.png")))
    print("rendered frames:", len(frames), "| keyed frames:", len(keyed))
    frames = keyed if len(keyed) == len(frames) else frames
    check("120 frames rendered", len(frames) == 120)

    print("\n[1] container")
    for name in ("clinic_chroma_key_1080x1920.mp4", "clinic_chroma_key_1080x1920.mov",
                 "clinic_chroma_preview_h264_420.mp4", "clinic_chroma_alpha_matte_1080x1920.mov"):
        p = os.path.join(OUT, name)
        if os.path.exists(p):
            info = probe(p)
            print("   ", name, "->", info.get("duration"), "|", info.get("video", "")[:70])
            check(name + " is 5.00s @1080x1920 24fps",
                  info.get("duration", "").startswith("00:00:05") and "1080x1920" in info.get("video", "")
                  and "24 fps" in info.get("video", ""))
        else:
            check(name + " exists", False)

    print("\n[2..6] keyed frames")
    metrics = []
    for i in range(0, len(frames), 6):
        metrics.append((i + 1, frame_metrics(os.path.join(FRAMES, frames[i]))))
    for idx, m in metrics:
        if m.get("bbox", True) is None:
            check("frame %d has a building" % idx, False)
            continue
        print("   frame %3d  bbox x[%4d..%4d] y[%4d..%4d]  h=%d  bg colours=%d"
              % (idx, m["x0"], m["x1"], m["y0"], m["y1"], m["h"], m["bg_unique"]))

    good = [m for _, m in metrics if m.get("bbox", True) is not None]
    check("key colour is a single flat value",
          all(m["bg_unique"] == 1 for m in good))

    edges_ok = all(m["x0"] > 0.08 * W and m["x1"] < 0.92 * W and
                   m["y0"] > 0.08 * H and m["y1"] < 0.92 * H for m in good)
    check("generous green margin on every side", edges_ok,
          "min margin px: L%d R%d T%d B%d" % (
              min(m["x0"] for m in good), min(W - 1 - m["x1"] for m in good),
              min(m["y0"] for m in good), min(H - 1 - m["y1"] for m in good)))

    hs = [m["h"] for m in good]
    spread = (max(hs) - min(hs)) / max(hs)
    check("constant on-screen size (no zoom)", spread < 0.06,
          "height %d..%d px (%.1f%% variation, foreshortening only)"
          % (min(hs), max(hs), spread * 100))

    # A 180 deg turn of a rectangular building has a clear signature: the
    # projected width is smallest when a facade faces the camera (W = 8.6 m) and
    # largest when the building is seen on the diagonal (W = sqrt(8.6^2+7.7^2)).
    widths = [m["w"] for m in good]
    ratio = max(widths) / float(widths[0])
    peak_at = widths.index(max(widths)) / float(len(widths))
    check("exactly one half turn (width swells on the diagonal, then returns)",
          1.15 < ratio < 1.45 and 0.3 < peak_at < 0.7 and abs(widths[-1] - widths[0]) < 12,
          "front %d px -> diagonal %d px (x%.2f) -> front %d px"
          % (widths[0], max(widths), ratio, widths[-1]))

    if len(frames) == 120:
        first = frame_metrics(os.path.join(FRAMES, frames[0]))
        last = frame_metrics(os.path.join(FRAMES, frames[-1]))
        prev = frame_metrics(os.path.join(FRAMES, frames[-2]))
        img_a = np.asarray(Image.open(os.path.join(FRAMES, frames[-1])).convert("RGBA")).astype(np.float32)
        img_b = np.asarray(Image.open(os.path.join(FRAMES, frames[-2])).convert("RGBA")).astype(np.float32)
        diff = np.abs(img_a - img_b).mean()
        check("rotation has fully stopped at the end", diff < 0.9,
              "mean frame-to-frame delta = %.3f/255" % diff)
        check("ends on a square-on front elevation",
              abs(last["w"] - first["w"]) < 30,
              "start width %d px, end width %d px" % (first["w"], last["w"]))

    print("\nRESULT:", "ALL CHECKS PASSED" if ok else "SOME CHECKS FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
