#!/usr/bin/env python3
"""
Prepare the Inter font family used by the CV (reproducible).

Why: ReportLab names an embedded TrueType subset after the font file's internal
name. Every static instance of Inter carries the *same* internal name
("Inter Regular"), so ReportLab collapsed all weights into one embedded font and
bold/semi-bold text silently rendered as Regular. This script instances the
variable font at the needed weights, gives each instance a unique internal name,
and subsets it to the exact character set the CV uses.

Usage:  python3 prepare_fonts.py            # uses cache in ./.fontcache
Requires: fonttools
"""

from __future__ import annotations

import base64
import json
import os
import sys
import tempfile
import urllib.parse
import urllib.request

from fontTools.subset import Options, Subsetter
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, "fonts")
CACHE_DIR = os.path.join(HERE, ".fontcache")

# Google Fonts upstream variable sources (open source, OFL 1.1)
SOURCES = {
    "roman": ("google/fonts", "ofl/inter/Inter[opsz,wght].ttf", "InterVar.ttf"),
    "italic": (
        "google/fonts",
        "ofl/inter/Inter-Italic[opsz,wght].ttf",
        "InterVar-Italic.ttf",
    ),
}

# output file -> (source, weight, family name, subfamily, full name, ps name)
INSTANCES = {
    "Inter-Regular.ttf": (
        "roman",
        400,
        "Inter CV",
        "Regular",
        "Inter CV Regular",
        "InterCV-Regular",
    ),
    "Inter-Medium.ttf": (
        "roman",
        500,
        "Inter CV Medium",
        "Regular",
        "Inter CV Medium",
        "InterCV-Medium",
    ),
    "Inter-SemiBold.ttf": (
        "roman",
        600,
        "Inter CV SemiBold",
        "Regular",
        "Inter CV SemiBold",
        "InterCV-SemiBold",
    ),
    "Inter-Bold.ttf": (
        "roman",
        700,
        "Inter CV",
        "Bold",
        "Inter CV Bold",
        "InterCV-Bold",
    ),
    "Inter-Italic.ttf": (
        "italic",
        400,
        "Inter CV",
        "Italic",
        "Inter CV Italic",
        "InterCV-Italic",
    ),
}

OPTICAL_SIZE = 14  # print-optimised optical size for body copy

# Exactly what the CV prints (keeps the PDF tiny and the subsetting predictable)
UNICODE_RANGES = [(0x0020, 0x007E)]  # ASCII
UNICODE_SINGLES = [
    0x00A0,
    0x00B7,  # nbsp, middle dot
    0x2013,
    0x2014,  # en dash, em dash
    0x2018,
    0x2019,
    0x201C,
    0x201D,  # curly quotes
    0x2022,
    0x2026,
    0x2192,
    0x00E9,  # bullet, ellipsis, arrow, e-acute
]
UNICODES = [
    u for start, end in UNICODE_RANGES for u in range(start, end + 1)
] + UNICODE_SINGLES


def download(repo: str, path: str, dest: str) -> None:
    url = f"https://api.github.com/repos/{repo}/contents/{urllib.parse.quote(path)}"
    req = urllib.request.Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": "cv-font-prep",
        },
    )
    with urllib.request.urlopen(req, timeout=90) as resp:
        payload = json.load(resp)
    data = base64.b64decode(payload["content"])
    with open(dest, "wb") as fh:
        fh.write(data)
    print(f"  downloaded {path} -> {dest} ({len(data):,} bytes)")


def rename(font: TTFont, family: str, subfamily: str, full: str, ps: str) -> None:
    name = font["name"]
    for rec in list(name.names):
        if rec.nameID in (1, 3, 4, 6):
            name.removeNames(rec.nameID, rec.platformID, rec.platEncID, rec.langID)
    for plat, enc, lang in ((3, 1, 0x409), (1, 0, 0)):
        name.setName(family, 1, plat, enc, lang)
        name.setName(subfamily, 2, plat, enc, lang)
        name.setName(full, 4, plat, enc, lang)
        name.setName(ps, 6, plat, enc, lang)
        name.setName(f"{family}-{subfamily}", 3, plat, enc, lang)
    name.setName("", 16, 3, 1, 0x409)  # clear typographic family/subfamily
    name.setName("", 17, 3, 1, 0x409)


def main() -> int:
    os.makedirs(OUT_DIR, exist_ok=True)
    os.makedirs(CACHE_DIR, exist_ok=True)

    sources = {}
    for key, (repo, path, fname) in SOURCES.items():
        dest = os.path.join(CACHE_DIR, fname)
        if not os.path.exists(dest):
            print(f"fetching variable source: {key}")
            download(repo, path, dest)
        sources[key] = dest

    for out_name, (key, weight, family, subfamily, full, ps) in INSTANCES.items():
        out_path = os.path.join(OUT_DIR, out_name)
        with tempfile.TemporaryDirectory() as tmp:
            static = os.path.join(tmp, "static.ttf")
            instancer.instantiateVariableFont(
                TTFont(sources[key]),
                {"wght": weight, "opsz": OPTICAL_SIZE},
                inplace=False,
                updateFontNames=False,
            ).save(static)

            font = TTFont(static)
            rename(font, family, subfamily, full, ps)

            options = Options()
            options.layout_features = ["kern", "liga", "calt", "ccmp", "locl"]
            options.notdef_outline = True
            options.glyph_names = False
            options.recalc_bounds = True
            options.name_IDs = ["*"]
            subsetter = Subsetter(options=options)
            subsetter.populate(unicodes=UNICODES)
            subsetter.subset(font)
            font.flavor = None
            font.save(out_path)

        size = os.path.getsize(out_path)
        print(f"  {out_name:22s} weight={weight}  {size:,} bytes  ({ps})")

    total = sum(os.path.getsize(os.path.join(OUT_DIR, f)) for f in INSTANCES)
    print(f"done - {len(INSTANCES)} instances, {total:,} bytes total in {OUT_DIR}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
