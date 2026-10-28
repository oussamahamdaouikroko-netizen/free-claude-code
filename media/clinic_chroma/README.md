# Chroma-Key Clinic Turn — 3D render pipeline

A 5.00 s vertical (1080 × 1920, 9:16) clip of one complete modern medical
clinic building, spinning exactly 180° on its vertical axis over a perfectly
uniform chroma-key green (#00FF00) background.

Everything here is generated procedurally — no stock footage, no image
generators, no imported assets. The building is real 3D geometry rendered with
Cycles (CPU, path traced, denoised).

## Deliverables (`output/`)

| File | Use |
| --- | --- |
| `clinic_chroma_key_1080x1920.mp4` | **the master** — H.264 High, 4:4:4 full-range, 24 fps, 5.00 s, all-intra (every frame a keyframe) |
| `clinic_chroma_preview_h264_420.mp4` | same clip in 4:2:0 for quick playback on anything |
| `contact_sheet.png` | five evenly spaced frames for a quick check |

`make_video.py` can additionally emit two large masters (`output/*.mov`, ~30 MB
each, intentionally git-ignored to keep the repo small). Run it once after a
render to produce them:

* `clinic_chroma_key_1080x1920.mov` — ProRes 4444, 10-bit 4:4:4 on green
* `clinic_chroma_alpha_matte_1080x1920.mov` — ProRes 4444 with a real 16-bit
  alpha channel, so the clip can be dropped on a timeline with **no keying at
  all** if you ever want that instead of chroma key

## Files

| File | Role |
| --- | --- |
| `build_scene.py` | Builds the entire scene: building, camera, lights, render settings, and bakes the rotation keyframes. Saves `clinic.blend`. |
| `render_final.py` | Opens the .blend and renders frames 1–120 to `frames/` as 16-bit RGBA PNGs with a transparent film (resumable: `use_overwrite = False`). |
| `make_video.py` | Composites every transparent frame over exact #00FF00, then encodes the MP4 and the ProRes MOV and writes the contact sheet. |
| `preview.py`, `prev2.py` | Low-res / single-frame previews used while art-directing. |
| `check_anim.py` | Prints the baked rotation at key frames (verifies the 180° total and the ease-out). |
| `verify.py` | Quality gate: container, key flatness, margins, constant scale, the 180° signature, and that the spin has fully stopped. |
| `frames/` | (generated) the rendered RGBA frames `f0001.png` … `f0120.png`, git-ignored |
| `output/` | Finished video files. |

## How to reproduce

```bash
# 1. scene
python build_scene.py /tmp/clinic.blend

# 2. render 120 frames (about 50 s per frame on 2 CPU cores)
python render_final.py

# 3. key + encode (both files below, ~70 s)
python make_video.py

# 4. check it
python verify.py
```

`verify.py` output on the delivered clip:

```
PASS  120 frames rendered
PASS  clinic_chroma_key_1080x1920.mp4 is 5.00s @1080x1920 24fps
PASS  clinic_chroma_preview_h264_420.mp4 is 5.00s @1080x1920 24fps
PASS  key colour is a single flat value
PASS  generous green margin on every side   min margin px: L163 R239 T735 B676
PASS  constant on-screen size (no zoom)     height 482..507 px
PASS  exactly one half turn                 front 508 px -> diagonal 678 px -> front 507 px
PASS  rotation has fully stopped at the end mean frame-to-frame delta = 0.015/255
PASS  ends on a square-on front elevation
```

`build_scene.py` and the render scripts must be run with a Blender-capable
Python (the `bpy` wheel) and the stub X/GL libraries on `LD_LIBRARY_PATH` in
this sandbox:

```bash
export LD_LIBRARY_PATH=/home/user/stublibs
/home/user/.venv-bpy/bin/python build_scene.py /tmp/clinic.blend
```

## Design decisions

**Why the background is composited rather than rendered green.**
A green shader plane or a green world would still be lit: it would pick up
soft shadows, bounce light, a vertical gradient and visible noise, and a keyer
would fight it. Instead the render is made with `film_transparent = True`, so
the background is genuinely absent (alpha 0, RGB 0), and each frame is
composited over the literal value `(0, 255, 0)`. The resulting green is
bit-exact everywhere: zero gradient, zero texture, zero shadow, zero noise.
It is also perfectly clean in the MP4 because the key colour survives the
H.264 matrix unchanged (0/255/0 → Y=145, U=54, V=34, which round-trips).

**No green spill.** There is no green light and no green surface in the scene,
so nothing can bounce green onto white plaster or into the glass. The tinted
glazing is fully opaque (no transmission, no alpha) — an earlier
semi-transparent version let the key colour show *through* the windows, which
would have been fatal for the matte.

**Constant scale, fixed camera.** The camera object is never animated: it sits
at a fixed position and aims at a static target with a Track-To constraint. The
building is parented to a pivot empty whose Z rotation is the only animated
channel. Because the pivot is centred on the building's axis and the camera
distance never changes, the apparent size is constant for every frame; the
building occupies roughly 18 % of frame height with generous margins on all
four sides.

**Motion.** 180° total, 120 frames at 24 fps (5.00 s). The angle follows
`angle = -180° · (1 - u)^2.2`, u being normalised frame time: it starts fast
(≈4° in the first frame) and decelerates continuously to a full stop
(<0.01° in the last frame), finishing with the front entrance facing the
camera. A 0.5-shutter motion blur is enabled, so the fast opening reads as a
cinematic whip rather than a strobing sequence of poses.

**Delivery.** All-intra H.264 (keyint = 1) so every frame can be scrubbed or
pulled as a clean still. The master is encoded 4:4:4 **full range**: with 4:2:0
the chroma subsampling smears green ~2 px into the building outline on every
silhouette edge, which is exactly the spill a keyer would then have to fight;
4:4:4 full range keeps the key at a bit-exact 0/255/0 and leaves the plaster
clean. (The 4:2:0 preview file is there only for convenience playback.)

## What the building is

A two-storey clinic, ~8.6 × 7.7 m in plan, ~8 m tall:

- travertine-clad plinth and ground floor, with recessed horizontal coursing
- a recessed full-height glazed storefront in dark architectural glazing,
  aluminium mullions and transom, double glass entrance doors with push bars
- a projecting white entrance canopy on two slim posts, with linear recessed
  lighting in the soffit and downlights over the doors
- a cantilevered white upper volume with a shaded ribbon window, vertical
  fins on all four elevations, corner piers and a walnut soffit under the
  cantilever
- flat roof with parapet, aluminium coping, a louvred plant screen and a vent
- a rear elevation with a service door and a louvred plant grille, so the
  half-turn never shows a blank wall

No text, no signage, no logos, no people, no vehicles, no landscaping and no
other buildings appear anywhere in the clip.
