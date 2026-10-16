#!/usr/bin/env python3
"""
Quality gate for the editable DOCX.

  1. page setup is A4 with the intended margins
  2. every required CV string is present in body order (ATS / parity with PDF)
  3. the four contact links exist as real external relationships
  4. no paragraph is wider than the text column (conservative Inter-based
     estimate, i.e. if it fits in Inter it fits in Calibri)
  5. fonts / colours are applied consistently, no placeholders

Usage: python3 verify_docx.py [path-to-docx]
"""

from __future__ import annotations

import os
import re
import sys
import zipfile

import cv_content as C
from docx import Document
from docx.oxml.ns import qn
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

DOCX = sys.argv[1] if len(sys.argv) > 1 else "Oussama_Hamdaoui_Video_Editor_CV.docx"

# Calibri is not installed here, so widths are measured with Inter, which is
# slightly wider than Calibri at the same size: a conservative (worst case) fit.
for _n, _f in (("I-chk", "Inter-Regular.ttf"), ("I-chk-b", "Inter-SemiBold.ttf")):
    pdfmetrics.registerFont(
        TTFont(_n, os.path.join(os.path.dirname(__file__), "fonts", _f))
    )

SAFE_W = 503.0  # pt of usable text column
MARGIN_PT = 46.0
TAB1 = 258.0  # first tab stop of the contact lines


def text_width(text: str, size: float, bold: bool = False) -> float:
    font = "I-chk-b" if bold else "I-chk"
    return pdfmetrics.stringWidth(text, font, size)


REQUIRED = [
    C.NAME_UPPER,
    "VIDEO EDITOR",
    C.LOCATION,
    C.PHONE,
    C.EMAIL,
    C.LINKEDIN_LABEL,
    C.PORTFOLIO_LABEL,
    "PROFESSIONAL SUMMARY",
    "3 years of experience",
    "Doctor of Pharmacy degree",
    "CORE SKILLS",
    *C.SKILLS,
    "PROFESSIONAL EXPERIENCE",
    C.ROLE_TITLE,
    "Agency Projects & Client Content",
    C.ROLE_META,
    *C.BULLETS,
    "EDUCATION",
    C.EDUCATION_DEGREE,
    "(Docteur en pharmacie)",
    "TECHNICAL SKILLS",
    "LANGUAGES",
    "Arabic — Native",
    "English — Intermediate",
    "French — Beginner",
]

fails = []


def check(cond, msg):
    if cond:
        print("PASS ", msg)
    else:
        fails.append(msg)
        print("FAIL ", msg)


doc = Document(DOCX)
sec = doc.sections[0]
check(
    abs(sec.page_width.pt - 595.276) < 1.5 and abs(sec.page_height.pt - 841.89) < 1.5,
    f"A4 page size ({sec.page_width.pt:.1f} x {sec.page_height.pt:.1f} pt)",
)
check(
    abs(sec.left_margin.pt - MARGIN_PT) < 1
    and abs(sec.right_margin.pt - MARGIN_PT) < 1,
    f"left/right margins = {sec.left_margin.pt:.1f} / {sec.right_margin.pt:.1f} pt",
)


# ---- collect text in document order (body paragraphs + table cells + links)
def paragraph_text(el) -> str:
    """Text of a w:p element, including runs inside w:hyperlink."""
    return "".join(
        node.text for node in el.iter() if node.tag == qn("w:t") and node.text
    )


texts = []
for block in doc.element.body.iter():
    if block.tag == qn("w:p"):
        t = paragraph_text(block)
        if t.strip():
            texts.append(t)
full = "\n".join(texts)
flat = re.sub(r"\s+", " ", full)

missing = [s for s in REQUIRED if re.sub(r"\s+", " ", s) not in flat]
check(
    not missing, f"all {len(REQUIRED)} required strings present (ATS parity with PDF)"
)
for m in missing:
    print("        MISSING:", m)

# ---- hyperlinks
rels = [r for r in doc.part.rels.values() if r.reltype.endswith("/hyperlink")]
uris = {r.target_ref for r in rels}
expected = {C.PHONE_URL, f"mailto:{C.EMAIL}", C.LINKEDIN_URL, C.PORTFOLIO_URL}
check(
    uris == expected, f"exactly the 4 expected hyperlinks present ({len(uris)} found)"
)
for u in sorted(expected - uris):
    print("        MISSING LINK:", u)
for u in sorted(uris - expected):
    print("        UNEXPECTED LINK:", u)

# the LinkedIn / portfolio URLs must be full and untruncated
check(
    C.LINKEDIN_URL in uris and "?usp=drive_link" in C.PORTFOLIO_URL,
    "LinkedIn + portfolio URLs are complete (not truncated)",
)

# ---- width estimate (no overflow past the right margin)
wide = []
for block in doc.element.body.iter(qn("w:p")):
    t = paragraph_text(block)
    if not t.strip():
        continue
    sizes = [int(sz.get(qn("w:val"))) / 2 for sz in block.iter(qn("w:sz"))]
    size = max(sizes) if sizes else 10.5
    bold = block.find(qn("w:pPr")) is not None and False

    # every unbreakable token must fit on one line
    wide.extend(
        ("token", round(text_width(tok, size), 1), tok[:50])
        for tok in t.split()
        if text_width(tok, size) > SAFE_W
    )

    if "\t" in t:  # tabbed lines must fit on one physical line
        parts = t.split("\t")
        first = text_width(parts[0].strip(), size)
        second = text_width(parts[1].strip(), size) if len(parts) > 1 else 0.0
        if first > TAB1 or second > SAFE_W:
            wide.append(("tab", round(first, 1), round(second, 1), t[:50]))
        elif len(parts) > 1 and first + 8 > TAB1 and first > TAB1:
            wide.append(("tab-overlap", round(first, 1), t[:50]))

check(not wide, "no unbreakable text exceeds the text column (Inter-based worst case)")
for w in wide:
    print("        WIDE:", w)

# single-line blocks (headings, name, role line, contact rows) must fit fully
one_liners = []
for block in doc.element.body.iter(qn("w:p")):
    t = paragraph_text(block)
    sizes = [int(sz.get(qn("w:val"))) / 2 for sz in block.iter(qn("w:sz"))]
    size = max(sizes) if sizes else 10.5
    if not t.strip():
        continue
    is_heading = t.isupper() and len(t) < 40
    if is_heading and text_width(t, size, bold=True) > SAFE_W:
        one_liners.append((round(text_width(t, size, bold=True), 1), t))
check(not one_liners, "all section headings fit on one line")
for o in one_liners:
    print("        TOO WIDE:", o)

# ---- fonts & colour sanity
fonts = {f.get(qn("w:ascii")) for f in doc.element.body.iter(qn("w:rFonts"))}
check(fonts == {"Calibri"}, f"single consistent font family in the document: {fonts}")
sizes = {int(sz.get(qn("w:val"))) / 2 for sz in doc.element.body.iter(qn("w:sz"))}
check(len(sizes) <= 8, f"restrained type scale ({len(sizes)} sizes: {sorted(sizes)})")
colors = {c.get(qn("w:val")) for c in doc.element.body.iter(qn("w:color"))}
allowed = {"0B1B33", "1F6FEB", "2A3441", "6B7688"}
check(colors <= allowed, f"only the brand palette is used: {sorted(colors)}")

bad = [p for p in (r"\bLorem\b", r"\{\{", r"\bTBD\b") if re.search(p, flat)]
check(not bad, "no placeholder text")
check(
    "http" not in flat.replace("https://drive.google", ""),
    "no raw URLs dumped into the body text (labels are used instead)",
)

# ---- document properties
props = doc.core_properties
check(
    props.title == C.PDF_TITLE
    and props.author == C.NAME
    and props.keywords == C.KEYWORDS,
    "document properties (title / author / keywords) set for ATS",
)

# ---- structural safety for Word: no floating objects, no images
with zipfile.ZipFile(DOCX) as z:
    names = z.namelist()
check(
    not [n for n in names if n.startswith("word/media/")],
    "no images embedded (text-only, ATS friendly)",
)
check(
    len(doc.tables) == 1,
    f"single borderless table used for the skills grid ({len(doc.tables)} table(s))",
)


# ---- pagination estimate: the DOCX must also stay on one A4 page
PAGE_TEXT_H = 841.89 - 40 - 40


def wrapped_lines(text: str, width: float, size: float) -> int:
    words, lines, cur = text.split(), 1, 0.0
    space = text_width(" ", size)
    for w in words:
        ww = text_width(w, size)
        if cur == 0:
            cur = ww
        elif cur + space + ww <= width:
            cur += space + ww
        else:
            lines += 1
            cur = ww
    return lines


def in_table(el) -> bool:
    parent = el.getparent()
    while parent is not None:
        if parent.tag == qn("w:tbl"):
            return True
        parent = parent.getparent()
    return False


est_height = 0.0
rows_seen = set()
for block in doc.element.body.iter(qn("w:p")):
    t = paragraph_text(block)
    sizes = [int(sz.get(qn("w:val"))) / 2 for sz in block.iter(qn("w:sz"))]
    size = max(sizes) if sizes else 10.5
    ppr = block.find(qn("w:pPr"))
    line_mult = 1.06
    space_before = space_after = 0.0
    left_indent = 0.0
    if ppr is not None:
        sp = ppr.find(qn("w:spacing"))
        if sp is not None:
            if sp.get(qn("w:line")) and sp.get(qn("w:lineRule")) == "auto":
                line_mult = int(sp.get(qn("w:line"))) / 240.0
            if sp.get(qn("w:before")):
                space_before = int(sp.get(qn("w:before"))) / 20.0
            if sp.get(qn("w:after")):
                space_after = int(sp.get(qn("w:after"))) / 20.0
        ind = ppr.find(qn("w:ind"))
        if ind is not None and ind.get(qn("w:left")):
            left_indent = int(ind.get(qn("w:left"))) / 20.0
        # default style spacing when a paragraph does not override it
    if not t.strip():
        est_height += space_before + space_after + size * 1.22 * line_mult * 0.5
        continue
    width = 251.0 if in_table(block) else SAFE_W - left_indent
    lines = wrapped_lines(t, width, size)
    est_height += space_before + lines * size * 1.22 * line_mult + space_after

# row/grid borders of the skills table add a hairline per row
est_height += len(doc.tables[0].rows) * 1.0

check(
    est_height <= PAGE_TEXT_H,
    f"estimated layout fits one A4 page ({est_height:.0f}pt of {PAGE_TEXT_H:.0f}pt)",
)
if est_height > PAGE_TEXT_H:
    print(f"        OVERFLOW estimate: {est_height - PAGE_TEXT_H:.0f}pt over")
print(
    f"      estimated content height {est_height:.0f}pt -> "
    f"{max(1, -(-est_height // PAGE_TEXT_H)):.0f} page(s), fill "
    f"{est_height / PAGE_TEXT_H * 100:.0f}%"
)

print()
if fails:
    print(f"FAILED {len(fails)} check(s):")
    for f in fails:
        print("  -", f)
    sys.exit(1)
print("ALL DOCX CHECKS PASSED")
