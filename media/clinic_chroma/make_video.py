"""
Turn the rendered RGBA frames into a finished chroma-key clip.

The Blender render uses film_transparent, so every frame arrives as straight
alpha over nothing.  We composite each frame over EXACTLY #00FF00 -- that
guarantees a mathematically uniform, gradient-free key colour (a 3D background
plane could never be that clean: it would carry lighting, shading and bounce).

Outputs:
  clinic_chroma_key_1080x1920.mp4    H.264, yuv420p, 24 fps, 5.00 s
  clinic_chroma_key_1080x1920.mov    ProRes 4444 (all-intra, best for keying)
  contact_sheet.png                  first / middle / final frames
"""
import glob
import os
import subprocess
import sys

import numpy as np
from PIL import Image

import imageio_ffmpeg

HERE = os.path.dirname(os.path.abspath(__file__))
FRAMES = os.path.join(HERE, "frames")
OUTDIR = os.path.join(HERE, "output")
KEYED = os.path.join(HERE, "_keyed_tmp")
GREEN = np.array([0.0, 255.0, 0.0], dtype=np.float32)
FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
FPS = 24


def key_frame(path, out_path):
    im = Image.open(path)
    a = np.asarray(im).astype(np.float32)          # 8-bit RGBA (PIL truncates the 16-bit render)
    alpha = a[..., 3:4] / 255.0
    rgb = a[..., :3]
    # kill denoiser residue in the empty background
    alpha = np.where(alpha < 0.02, 0.0, alpha)   # drop denoiser residue
    alpha = np.where(alpha > 0.996, 1.0, alpha)
    out = rgb * alpha + GREEN * (1.0 - alpha)
    # snap any pixel that is essentially the key colour to EXACT #00FF00 so the
    # background is one single value everywhere (clean, unbanded matte)
    near = np.abs(out - GREEN).sum(axis=2, keepdims=True) < 14.0
    out = np.where(near, GREEN, out)
    # 16-bit straight alpha is already un-premultiplied by Blender's PNG writer
    Image.fromarray(np.clip(out + 0.5, 0, 255).astype(np.uint8), "RGB").save(out_path)
    return float(alpha.max()), int((alpha < 0.004).sum())


def main():
    files = sorted(glob.glob(os.path.join(FRAMES, "*.png")))
    files = [f for f in files if os.path.getsize(f) > 1000]
    if not files:
        sys.exit("no frames rendered yet")
    os.makedirs(OUTDIR, exist_ok=True)
    os.makedirs(KEYED, exist_ok=True)
    print("frames:", len(files))

    for i, f in enumerate(files):
        out = os.path.join(KEYED, "k%04d.png" % i)
        amax, empty = key_frame(f, out)
        if i % 20 == 0:
            print("  keyed %3d/%d  max_alpha=%.2f  bg_px=%d" % (i + 1, len(files), amax, empty))

    # verify the key colour is exact
    chk = np.asarray(Image.open(os.path.join(KEYED, "k0000.png")).convert("RGB"))
    corner = chk[0:40, 0:40].reshape(-1, 3)
    print("background RGB at frame 1 corner:", np.unique(corner, axis=0)[:3],
          "uniform:", len(np.unique(corner, axis=0)) == 1)

    # 4:4:4 full-range H.264: keeps the key colour bit-exact (0/255/0) and stops
    # 4:2:0 chroma subsampling from smearing green 2 px into the building edges.
    mp4 = os.path.join(OUTDIR, "clinic_chroma_key_1080x1920.mp4")
    subprocess.run([
        FFMPEG, "-y", "-framerate", str(FPS), "-i", os.path.join(KEYED, "k%04d.png"),
        "-vf", "scale=out_color_matrix=bt709:out_range=pc,format=yuv444p",
        "-c:v", "libx264", "-preset", "slow", "-crf", "10",
        "-x264-params", "keyint=1", "-pix_fmt", "yuv444p",
        "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
        "-color_range", "pc", "-movflags", "+faststart", mp4,
    ], check=True)
    print("wrote", mp4)

    # same clip as a plain 4:2:0 file for players/NLEs that dislike 4:4:4
    mp4b = os.path.join(OUTDIR, "clinic_chroma_preview_h264_420.mp4")
    subprocess.run([
        FFMPEG, "-y", "-framerate", str(FPS), "-i", os.path.join(KEYED, "k%04d.png"),
        "-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p",
        "-c:v", "libx264", "-preset", "slow", "-crf", "12",
        "-pix_fmt", "yuv420p", "-colorspace", "bt709",
        "-color_primaries", "bt709", "-color_trc", "bt709",
        "-movflags", "+faststart", mp4b,
    ], check=True)
    print("wrote", mp4b)

    mov = os.path.join(OUTDIR, "clinic_chroma_key_1080x1920.mov")
    subprocess.run([
        FFMPEG, "-y", "-framerate", str(FPS), "-i", os.path.join(KEYED, "k%04d.png"),
        "-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuv444p10le",
        "-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuv444p10le",
        "-vendor", "apl0", "-bits_per_mb", "8000", mov,
    ], check=True)
    print("wrote", mov)

    # bonus: the same animation with the true alpha matte baked in, so no keying
    # is needed at all -- drop it straight onto the timeline
    movA = os.path.join(OUTDIR, "clinic_chroma_alpha_matte_1080x1920.mov")
    subprocess.run([
        FFMPEG, "-y", "-framerate", str(FPS), "-i", os.path.join(FRAMES, "f%04d.png"),
        "-vf", "format=argb,scale=out_color_matrix=bt709:out_range=tv",
        "-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le",
        "-alpha_bits", "16", "-vendor", "apl0", movA,
    ], check=True)
    print("wrote", movA)

    # contact sheet for a quick visual check
    picks = [0, len(files) // 4, len(files) // 2, 3 * len(files) // 4, len(files) - 1]
    thumbs = [Image.open(os.path.join(KEYED, "k%04d.png" % p)).convert("RGB").resize((432, 768))
              for p in picks]
    sheet = Image.new("RGB", (432 * len(thumbs), 768))
    for j, t in enumerate(thumbs):
        sheet.paste(t, (432 * j, 0))
    sheet.save(os.path.join(OUTDIR, "contact_sheet.png"))
    print("wrote contact_sheet.png")


if __name__ == "__main__":
    main()
