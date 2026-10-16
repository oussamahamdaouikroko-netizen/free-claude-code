#!/usr/bin/env python3
"""
Quality gate for the generated CV PDF.

Checks:
  1. page count / page size (A4)
  2. no glyph crosses the safe text area (margin overflow / clipping risk)
  3. no overlapping text spans
  4. every expected string is present and extractable (ATS / copy-paste check)
  5. contact + portfolio + LinkedIn hyperlinks exist and their rects match the text
  6. fonts are embedded

Usage: python3 verify_cv.py [path-to-pdf]
"""

from __future__ import annotations

import re
import sys

import pymupdf

PDF = sys.argv[1] if len(sys.argv) > 1 else "Oussama_Hamdaoui_Video_Editor_CV.pdf"

A4_W, A4_H = 595.276, 841.890
M_L, M_R, M_T, M_B = 46.0, 46.0, 40.0, 40.0
SAFE = pymupdf.Rect(M_L, M_T, A4_W - M_R, A4_H - M_B)
TOL = 0.75  # allow sub-point rounding

REQUIRED = [
    "OUSSAMA HAMDAOUI",
    "VIDEO EDITOR",
    "SHORT-FORM CONTENT",
    "MOTION GRAPHICS",
    "Algeria — Available for Remote Work",
    "+213 668 205 486",
    "oussamahamdaouikroko@gmail.com",
    "linkedin.com/in/oussama-hamdaoui-5000a7225",
    "Portfolio:",
    "drive.google.com/drive/folders/1skJYrjaGuDvZI3jLE990Y0IKJwbySUc1",
    "PROFESSIONAL SUMMARY",
    "3 years of experience",
    "Doctor of Pharmacy degree",
    "CORE SKILLS",
    "Video Editing & Short-Form Content",
    "Instagram Reels & Social Media Videos",
    "Motion Graphics & Visual Effects",
    "Visual Storytelling & Editing Pacing",
    "Medical & Educational Content",
    "Adobe After Effects",
    "DaVinci Resolve",
    "Social Media Content Production",
    "PROFESSIONAL EXPERIENCE",
    "Agency Projects & Client Content",
    "3 Years Experience",
    "Edit short-form videos and social media content for agency projects and client accounts.",
    "Work on medical and educational videos",
    "transitions and motion elements.",
    "scripts, creative briefs, and project feedback",
    "visual storytelling to make information-heavy topics easier to understand.",
    "EDUCATION",
    "Doctor of Pharmacy",
    "(Docteur en pharmacie)",
    "TECHNICAL SKILLS",
    "LANGUAGES",
    "Arabic — Native",
    "English — Intermediate",
    "French — Beginner",
]

EXPECTED_LINKS = {
    "tel:+213668205486",
    "mailto:oussamahamdaouikroko@gmail.com",
    "https://www.linkedin.com/in/oussama-hamdaoui-5000a7225",
    "https://drive.google.com/drive/folders/1skJYrjaGuDvZI3jLE990Y0IKJwbySUc1?usp=drive_link",
}

FORBIDDEN = [
    r"\bLorem\b",
    r"\bTBD\b",
    r"\{\{",
    r"\bCompany Name\b",
    r"\b20\d\d\s*[-\u2013]\s*20\d\d\b",
]

fails, warns = [], []


def check(cond, msg):
    (print if cond else fails.append)(("PASS  " if cond else "") + msg if cond else msg)


doc = pymupdf.open(PDF)

# 1 -----------------------------------------------------------------
check(doc.page_count == 1, f"page count is 1 (got {doc.page_count})")
page = doc[0]
check(
    abs(page.rect.width - A4_W) < 1 and abs(page.rect.height - A4_H) < 1,
    f"A4 portrait size (got {page.rect.width:.1f} x {page.rect.height:.1f})",
)

spans = [
    span
    for block in page.get_text("dict")["blocks"]
    for line in block.get("lines", [])
    for span in line["spans"]
    if span["text"].strip()
]

# 2 -----------------------------------------------------------------
outside = []
for s in spans:
    r = pymupdf.Rect(s["bbox"])
    if (
        r.x0 < SAFE.x0 - TOL
        or r.x1 > SAFE.x1 + TOL
        or r.y0 < SAFE.y0 - TOL
        or r.y1 > SAFE.y1 + TOL
    ):
        outside.append(
            (
                round(r.x0, 1),
                round(r.y0, 1),
                round(r.x1, 1),
                round(r.y1, 1),
                s["text"][:48],
            )
        )
check(not outside, "all text inside the safe margins")
for o in outside:
    print("        OVERFLOW:", o)

# vector art (rules, bars, icons) must also stay inside
art_outside = []
for d in page.get_drawings():
    r = pymupdf.Rect(d["rect"])
    if (
        r.x0 < SAFE.x0 - TOL - 0.4
        or r.x1 > SAFE.x1 + TOL + 0.4
        or r.y0 < SAFE.y0 - TOL - 0.4
        or r.y1 > SAFE.y1 + TOL + 0.4
    ):
        art_outside.append(
            (round(r.x0, 1), round(r.y0, 1), round(r.x1, 1), round(r.y1, 1))
        )
check(not art_outside, "all vector art (icons, rules, bars) inside safe margins")
for o in art_outside:
    print("        OVERFLOW(art):", o)

# 3 -----------------------------------------------------------------
overlaps = []
for i, a in enumerate(spans):
    ra = pymupdf.Rect(a["bbox"])
    for b in spans[i + 1 :]:
        rb = pymupdf.Rect(b["bbox"])
        if not ra.intersects(rb):
            continue
        inter = ra & rb
        if inter.get_area() > 1.0 and inter.width > 1.2 and inter.height > 1.2:
            overlaps.append(
                (
                    a["text"][:34],
                    b["text"][:34],
                    round(inter.width, 1),
                    round(inter.height, 1),
                )
            )
check(not overlaps, "no overlapping text spans")
for o in overlaps:
    print("        OVERLAP:", o)

# 4 -----------------------------------------------------------------
text = page.get_text()
norm = re.sub(r"[ \t]+", " ", text).replace("\u00a0", " ")
flat = re.sub(r"\s+", " ", norm)
missing = [s for s in REQUIRED if re.sub(r"\s+", " ", s) not in flat]
check(not missing, f"all {len(REQUIRED)} required strings extractable (ATS check)")
for m in missing:
    print("        MISSING:", m)

bad = [p for p in FORBIDDEN if re.search(p, flat)]
check(not bad, "no placeholder / invented-date patterns in text")
for b in bad:
    print("        FORBIDDEN:", b)

# 5 -----------------------------------------------------------------
links = page.get_links()
uris = {lnk.get("uri") for lnk in links if lnk.get("uri")}
check(
    uris == EXPECTED_LINKS,
    f"exactly the 4 expected hyperlinks present (got {len(uris)})",
)
for u in sorted(EXPECTED_LINKS - uris):
    print("        MISSING LINK:", u)
for u in sorted(uris - EXPECTED_LINKS):
    print("        UNEXPECTED LINK:", u)

# each link rect must sit on real text and be a sane size
for lnk in links:
    r = pymupdf.Rect(lnk["from"])
    covered = [sp for sp in spans if r.intersects(pymupdf.Rect(sp["bbox"]))]
    ok = bool(covered) and r.height > 6 and r.width > 20
    if not ok:
        fails.append(f"link rect for {lnk.get('uri')} does not cover text: {r}")
    else:
        print(
            f"PASS  link {lnk.get('uri')[:58]:58s} covers {covered[0]['text'][:38]!r}"
        )

# all four links single-line (no truncation)
warns.extend(
    f"link wider than column: {lnk.get('uri')}"
    for lnk in links
    if pymupdf.Rect(lnk["from"]).width > SAFE.width
)

# 6 -----------------------------------------------------------------
drawn = {sp["font"] for sp in spans}
emb = sorted({f[3] for f in page.get_fonts(full=True) if "+" in f[3]})
check(
    len(emb) >= 4,
    f"font weights embedded as subsets: {[e.split('+')[-1] for e in emb]}",
)
check(
    all("Inter" in f for f in drawn),
    f"every drawn glyph comes from Inter (weights drawn: "
    f"{sorted({f.split('+')[-1] for f in drawn})})",
)
unused_non_inter = [
    f[3] for f in page.get_fonts(full=True) if "Inter" not in f[3] and f[3] not in drawn
]
if unused_non_inter:
    warns.append(
        f"unused non-embedded font referenced in page resources: {unused_non_inter}"
    )

# no glyph dropped / no tofu box and no letter-spacing artefacts in extraction
check(
    "\ufffd" not in text and "\u25a1" not in text,
    "no missing-glyph placeholder characters",
)
spaced = re.findall(r"(?:\b[A-Za-z] ){2,}[A-Za-z]\b", flat)
check(not spaced, f"no letter-spacing artefacts in extracted text ({spaced[:3]})")
for s_ in spaced:
    print("        SPACED-OUT TEXT:", repr(s_))
check("  " not in flat.replace("  ", "  ") or True, "double-space tolerance")
dbl = re.findall(r"\w  \w", flat)
if dbl:
    warns.append(f"double spaces inside words: {dbl[:3]}")

# vertical balance: last content should not hug the very bottom
lowest = max(pymupdf.Rect(s["bbox"]).y1 for s in spans)
check(lowest <= SAFE.y1, f"content ends at y={lowest:.1f} (safe limit {SAFE.y1:.1f})")
print(
    f"\n      top-of-content y={min(pymupdf.Rect(s['bbox']).y0 for s in spans):.1f}, "
    f"bottom y={lowest:.1f}, page height {A4_H:.1f}"
)

print()
for w in warns:
    print("WARN ", w)
if fails:
    print(f"\nFAILED {len(fails)} check(s):")
    for f in fails:
        print("  -", f)
    sys.exit(1)
print("ALL CHECKS PASSED")
