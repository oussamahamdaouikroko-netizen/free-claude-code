#!/usr/bin/env python3
"""
Build a premium, ATS-friendly one-page A4 CV for Oussama Hamdaoui
(Video Editor | Short-Form Content | Motion Graphics).

Design: dark navy + charcoal + subtle electric-blue accent, Inter typography,
single-column reading order (ATS-safe), vector icons for contact details only,
real clickable links (URI + mailto + tel annotations).

Run:  python3 build_cv.py
Out:  Oussama_Hamdaoui_Video_Editor_CV.pdf (next to this script)
"""

from __future__ import annotations

import os
import sys

from cv_content import (
    BULLETS_HTML as BULLETS,
)
from cv_content import (
    EDUCATION_DEGREE,
    EDUCATION_NATIVE,
    EDUCATION_NOTE,
    EMAIL,
    LINKEDIN_LABEL,
    LINKEDIN_URL,
    PHONE,
    PHONE_URL,
    PORTFOLIO_LABEL,
    PORTFOLIO_URL,
    ROLE_DESC,
    ROLE_META,
    ROLE_TITLE,
    SKILLS,
)
from cv_content import (
    JOB_TITLE_DOTS as JOB_TITLE,
)
from cv_content import (
    NAME_UPPER as NAME,
)
from cv_content import (
    SUMMARY_HTML as SUMMARY,
)
from reportlab.lib.colors import HexColor
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen.canvas import Canvas
from reportlab.platypus import (
    BaseDocTemplate,
    Flowable,
    Frame,
    PageTemplate,
    Paragraph,
    Spacer,
)

HERE = os.path.dirname(os.path.abspath(__file__))
FONT_DIR = os.path.join(HERE, "fonts")
OUT_PDF = os.path.join(HERE, "Oussama_Hamdaoui_Video_Editor_CV.pdf")

# --------------------------------------------------------------------------
# Palette
# --------------------------------------------------------------------------
NAVY = HexColor("#0B1B33")  # name + section headings
INK = HexColor("#2A3441")  # body copy
MUTED = HexColor("#6B7688")  # secondary / meta text
ACCENT = HexColor("#1F6FEB")  # electric blue accent
ACCENT_SOFT = HexColor("#DCE9FD")
RULE = HexColor("#D8DFEA")  # hairlines
RULE_SOFT = HexColor("#EDF1F7")

# --------------------------------------------------------------------------
# Type scale
# --------------------------------------------------------------------------
NAME_SIZE = 30.5
TITLE_SIZE = 10.3
CONTACT_SIZE = 9.4
BODY_SIZE = 10.7
BODY_LEADING = 16.5
BULLET_SIZE = 10.5
BULLET_LEADING = 16.0
SKILL_SIZE = 10.4
SECTION_SIZE = 10.2

PAGE_W, PAGE_H = A4
M_LEFT = M_RIGHT = 46.0
M_TOP = 40.0
M_BOTTOM = 40.0
CONTENT_W = PAGE_W - M_LEFT - M_RIGHT  # 503.28

# --------------------------------------------------------------------------
# Fonts
# --------------------------------------------------------------------------
FONTS = {
    "Inter": "Inter-Regular.ttf",
    "Inter-Medium": "Inter-Medium.ttf",
    "Inter-SemiBold": "Inter-SemiBold.ttf",
    "Inter-Bold": "Inter-Bold.ttf",
    "Inter-Italic": "Inter-Italic.ttf",
}


def register_fonts() -> None:
    for name, fname in FONTS.items():
        path = os.path.join(FONT_DIR, fname)
        if not os.path.exists(path):
            sys.exit(f"Missing font file: {path}")
        pdfmetrics.registerFont(TTFont(name, path))
    pdfmetrics.registerFontFamily(
        "Inter",
        normal="Inter",
        bold="Inter-Bold",
        italic="Inter-Italic",
        boldItalic="Inter-Bold",
    )


def sw(text: str, font: str, size: float, char_space: float = 0.0) -> float:
    """String width including manual letter-spacing."""
    return pdfmetrics.stringWidth(text, font, size) + char_space * max(len(text) - 1, 0)


def draw_text(c, x, y, text, font, size, color, char_space=0.0, align="left"):
    """
    Draw a single text run with an explicit character-spacing value.

    `Canvas.drawString` / `PDFTextObject` never reset `Tc`, so any tracked text
    (section headings) would leak letter-spacing into every later string on the
    page. Every run here emits its own `Tc`, so spacing can never leak.
    """
    if align == "right":
        x -= sw(text, font, size, char_space)
    elif align == "center":
        x -= sw(text, font, size, char_space) / 2.0
    to = c.beginText(x, y)
    to.setFont(font, size)
    to.setFillColor(color)
    to.setCharSpace(char_space)
    to.textOut(text)
    to.setCharSpace(0)
    c.drawText(to)


# --------------------------------------------------------------------------
# Vector icons (contact details only, drawn at ~9.4pt)
# --------------------------------------------------------------------------
ICON_S = 10.2


def icon_pin(c, x, y, s, color):
    """Location pin."""
    cx = x + s / 2
    cy = y + s * 0.63
    r = s * 0.27
    c.setFillColor(color)
    c.circle(cx, cy, r, stroke=0, fill=1)
    p = c.beginPath()
    p.moveTo(cx - r * 0.92, cy - r * 0.42)
    p.lineTo(cx, y + s * 0.04)
    p.lineTo(cx + r * 0.92, cy - r * 0.42)
    p.close()
    c.drawPath(p, stroke=0, fill=1)
    c.setFillColor(HexColor("#FFFFFF"))
    c.circle(cx, cy + r * 0.12, r * 0.36, stroke=0, fill=1)


def icon_phone(c, x, y, s, color):
    """Mobile phone."""
    c.setStrokeColor(color)
    c.setFillColor(color)
    c.setLineWidth(0.72)
    w = s * 0.46
    c.roundRect(x + (s - w) / 2, y + s * 0.06, w, s * 0.88, s * 0.14, stroke=1, fill=0)
    c.circle(x + s / 2, y + s * 0.19, s * 0.055, stroke=0, fill=1)


def icon_mail(c, x, y, s, color):
    """Envelope."""
    c.setStrokeColor(color)
    c.setLineWidth(0.72)
    top = y + s * 0.83
    c.roundRect(
        x + s * 0.02, y + s * 0.17, s * 0.96, s * 0.66, s * 0.11, stroke=1, fill=0
    )
    p = c.beginPath()
    p.moveTo(x + s * 0.12, top - s * 0.05)
    p.lineTo(x + s * 0.5, y + s * 0.48)
    p.lineTo(x + s * 0.88, top - s * 0.05)
    c.drawPath(p, stroke=1, fill=0)


def icon_link(c, x, y, s, color):
    """Chain link (profile / URL)."""
    c.saveState()
    c.setStrokeColor(color)
    c.setLineWidth(0.72)
    c.translate(x + s / 2, y + s / 2)
    c.rotate(45)
    h = s * 0.30
    c.roundRect(-s * 0.46, -h / 2, s * 0.52, h, h / 2, stroke=1, fill=0)
    c.roundRect(s * (-0.06), -h / 2, s * 0.52, h, h / 2, stroke=1, fill=0)
    c.restoreState()


def icon_play(c, x, y, s, color):
    """Screen + play triangle (portfolio)."""
    c.setStrokeColor(color)
    c.setFillColor(color)
    c.setLineWidth(0.72)
    c.roundRect(
        x + s * 0.04, y + s * 0.20, s * 0.92, s * 0.62, s * 0.13, stroke=1, fill=0
    )
    p = c.beginPath()
    p.moveTo(x + s * 0.40, y + s * 0.65)
    p.lineTo(x + s * 0.66, y + s * 0.51)
    p.lineTo(x + s * 0.40, y + s * 0.37)
    p.close()
    c.drawPath(p, stroke=0, fill=1)


ICONS = {
    "pin": icon_pin,
    "phone": icon_phone,
    "mail": icon_mail,
    "link": icon_link,
    "play": icon_play,
}


# --------------------------------------------------------------------------
# Flowables
# --------------------------------------------------------------------------
class AccentBar(Flowable):
    """Short electric-blue bar used as a header ornament."""

    def __init__(self, w=30.0, h=3.2, color=ACCENT):
        super().__init__()
        self.w, self.h, self.color = w, h, color

    def wrap(self, aw, ah):
        self.width, self.height = self.w, self.h
        return self.width, self.height

    def draw(self):
        c = self.canv
        c.setFillColor(self.color)
        c.roundRect(0, 0, self.w, self.h, self.h / 2, stroke=0, fill=1)


class HairLine(Flowable):
    def __init__(
        self,
        width,
        color=RULE,
        thickness=0.6,
        accent_len=0.0,
        accent_color=ACCENT,
        accent_h=1.6,
    ):
        super().__init__()
        self.width, self.color, self.thickness = width, color, thickness
        self.accent_len, self.accent_color, self.accent_h = (
            accent_len,
            accent_color,
            accent_h,
        )

    def wrap(self, aw, ah):
        self.height = max(self.thickness, self.accent_h)
        return self.width, self.height

    def draw(self):
        c = self.canv
        c.setStrokeColor(self.color)
        c.setLineWidth(self.thickness)
        y = self.height / 2
        c.line(0, y, self.width, y)
        if self.accent_len:
            c.setFillColor(self.accent_color)
            c.roundRect(
                0,
                y - self.accent_h / 2,
                self.accent_len,
                self.accent_h,
                self.accent_h / 2,
                stroke=0,
                fill=1,
            )


class SectionHeading(Flowable):
    """Accent tick + tracked uppercase title + trailing hairline."""

    def __init__(
        self,
        text,
        width,
        size=SECTION_SIZE,
        color=NAVY,
        accent=ACCENT,
        rule=RULE,
        char_space=1.45,
        bar=True,
    ):
        super().__init__()
        self.text = text.upper()
        self.width = width
        self.size = size
        self.color = color
        self.accent = accent
        self.rule = rule
        self.char_space = char_space
        self.bar = bar
        self.text_w = sw(self.text, "Inter-SemiBold", size, char_space)

    def wrap(self, aw, ah):
        self.height = 16.2
        return self.width, self.height

    def draw(self):
        c = self.canv
        bar_w = 3.0 if self.bar else 0.0
        x_text = bar_w + (9.0 if self.bar else 0.0)
        baseline = 4.9
        if self.bar:
            c.setFillColor(self.accent)
            c.roundRect(0, baseline - 2.6, bar_w, 11.4, bar_w / 2, stroke=0, fill=1)
        draw_text(
            c,
            x_text,
            baseline,
            self.text,
            "Inter-SemiBold",
            self.size,
            self.color,
            self.char_space,
        )
        rule_x = x_text + self.text_w + 12.0
        if rule_x < self.width - 20:
            c.setStrokeColor(self.rule)
            c.setLineWidth(0.6)
            c.line(rule_x, baseline + 3.3, self.width, baseline + 3.3)


class ContactGrid(Flowable):
    """
    Two-column contact grid. Items are placed column by column; every item is
    drawn as icon + label + text and linked with a real PDF annotation when a
    URL is supplied. Text stays selectable and machine-readable.
    """

    ROW_H = 17.3
    GAP_ICON = 6.8

    def __init__(self, rows, width, col_widths=(257.0, None)):
        super().__init__()
        self.rows = rows  # list[list[dict]] - 1 or 2 items per row
        self.width = width
        self.col_x = [0.0, col_widths[0]]

    def wrap(self, aw, ah):
        self.height = self.ROW_H * len(self.rows)
        return self.width, self.height

    def _draw_item(self, item, x, baseline):
        c = self.canv
        icon, label, text, url, color = (
            item.get("icon"),
            item.get("label"),
            item["text"],
            item.get("url"),
            item.get("color", INK),
        )
        cx = x
        if icon:
            ICONS[icon](c, cx, baseline - 0.6, ICON_S, ACCENT)
            cx += ICON_S + self.GAP_ICON
        if label:
            draw_text(
                c,
                cx,
                baseline,
                label,
                "Inter-SemiBold",
                CONTACT_SIZE,
                MUTED if item.get("label_muted", True) else INK,
            )
            lw = pdfmetrics.stringWidth(label, "Inter-SemiBold", CONTACT_SIZE)
            cx += lw + 4.4
            x0 = cx - lw - 4.4
        else:
            x0 = cx
        draw_text(c, cx, baseline, text, "Inter-Medium", CONTACT_SIZE, color)
        tw = pdfmetrics.stringWidth(text, "Inter-Medium", CONTACT_SIZE)
        if url:
            rect = (x0, baseline - 2.4, cx + tw + 1.0, baseline + 8.4)
            c.linkURL(url, rect, relative=1, thickness=0, color=None)
        return cx + tw

    def draw(self):
        for r, row in enumerate(self.rows):
            baseline = self.height - (r + 1) * self.ROW_H + 5.6
            for i, item in enumerate(row):
                x = self.col_x[i] if len(row) > 1 else 0.0
                self._draw_item(item, x, baseline)


class RoleLine(Flowable):
    """Bold role title on the left, muted duration on the right."""

    def __init__(self, title, desc, meta, width, size=12.3):
        super().__init__()
        self.title, self.desc, self.meta = title, desc, meta
        self.width, self.size = width, size
        self.meta_font, self.meta_size = "Inter-Medium", 9.5

    def wrap(self, aw, ah):
        self.height = 19.0
        return self.width, self.height

    def draw(self):
        c = self.canv
        baseline = 4.6
        draw_text(c, 0, baseline, self.title, "Inter-Bold", self.size, NAVY)
        x = pdfmetrics.stringWidth(self.title, "Inter-Bold", self.size) + 5.4
        draw_text(c, x, baseline, self.desc, "Inter-Medium", 10.8, MUTED)
        draw_text(
            c,
            self.width,
            baseline + 0.4,
            self.meta,
            self.meta_font,
            self.meta_size,
            MUTED,
            align="right",
        )


class SkillGrid(Flowable):
    """Two-column checklist with small electric-blue square markers."""

    ROW_H = 17.8

    def __init__(self, items, width, col_gap=18.0, size=SKILL_SIZE):
        super().__init__()
        self.items, self.width, self.size = items, width, size
        self.col_w = (width - col_gap) / 2
        self.rows = (len(items) + 1) // 2

    def wrap(self, aw, ah):
        self.height = self.ROW_H * self.rows
        return self.width, self.height

    def draw(self):
        c = self.canv
        for i, text in enumerate(self.items):
            col, row = divmod(i, self.rows)
            x = col * (self.col_w + 18.0)
            baseline = self.height - (row + 1) * self.ROW_H + 5.2
            c.setFillColor(ACCENT)
            c.rect(x + 0.4, baseline + 2.2, 3.1, 3.1, stroke=0, fill=1)
            draw_text(c, x + 11.4, baseline, text, "Inter-Medium", self.size, INK)


class DetailStrip(Flowable):
    """
    Compact two-line footer strip used for the short sections (technical skills,
    languages). Uses the same accent tick as the section headings so the left
    rhythm of the page stays consistent, with the values in a fixed second
    column so the two rows line up.
    """

    ROW_H = 19.4
    LABEL_SIZE = 9.2
    VALUE_X = 172.0
    TRACK = 0.95

    def __init__(self, rows, width, size=SKILL_SIZE):
        super().__init__()
        self.rows = rows  # list[(label, value)]
        self.width, self.size = width, size

    def wrap(self, aw, ah):
        self.height = self.ROW_H * len(self.rows)
        return self.width, self.height

    def draw(self):
        c = self.canv
        for r, (label, value) in enumerate(self.rows):
            baseline = self.height - (r + 1) * self.ROW_H + 6.6
            c.setFillColor(ACCENT)
            c.roundRect(0, baseline - 2.4, 3.0, 11.6, 1.5, stroke=0, fill=1)
            draw_text(
                c,
                12.0,
                baseline,
                label.upper(),
                "Inter-SemiBold",
                self.LABEL_SIZE,
                NAVY,
                self.TRACK,
            )
            draw_text(c, self.VALUE_X, baseline, value, "Inter-Medium", self.size, INK)


class EducationLine(Flowable):
    def __init__(self, degree, native, width, size=11.3):
        super().__init__()
        self.degree, self.native = degree, native
        self.width, self.size = width, size

    def wrap(self, aw, ah):
        return self.width, 17.4

    def draw(self):
        c = self.canv
        baseline = 5.0
        draw_text(c, 0, baseline, self.degree, "Inter-SemiBold", self.size, NAVY)
        x = pdfmetrics.stringWidth(self.degree, "Inter-SemiBold", self.size) + 6.0
        draw_text(c, x, baseline, self.native, "Inter", 10.2, MUTED)


# --------------------------------------------------------------------------
# Text styles
# --------------------------------------------------------------------------
def styles():
    body = ParagraphStyle(
        "body",
        fontName="Inter",
        fontSize=BODY_SIZE,
        leading=BODY_LEADING,
        textColor=INK,
        alignment=TA_LEFT,
    )
    bullet = ParagraphStyle(
        "bullet",
        parent=body,
        fontSize=BULLET_SIZE,
        leading=BULLET_LEADING,
        leftIndent=13.4,
        firstLineIndent=-13.4,
        spaceAfter=3.4,
    )
    note = ParagraphStyle(
        "note", parent=body, fontSize=10.0, leading=14.6, textColor=MUTED
    )
    return body, bullet, note


# --------------------------------------------------------------------------
# Build
# --------------------------------------------------------------------------
def make_story(extra_gap: float = 0.0):
    """
    Build the flowables.

    `extra_gap` is added to every flexible section gap; it is used by
    `fit_story()` to distribute the leftover vertical space evenly so the page
    fills exactly one A4 sheet with balanced breathing room.
    """

    body, bullet, note = styles()

    story = []

    # ---------------- Header ----------------
    story.append(AccentBar(30.0, 3.2))
    story.append(Spacer(1, 11.0))

    name = Paragraph(
        f'<font name="Inter-Bold" size="{NAME_SIZE}">{NAME}</font>',
        ParagraphStyle(
            "name",
            fontName="Inter-Bold",
            fontSize=NAME_SIZE,
            leading=NAME_SIZE * 1.12,
            textColor=NAVY,
        ),
    )
    story.append(name)
    story.append(Spacer(1, 5.0))

    title = Paragraph(
        JOB_TITLE.upper(),
        ParagraphStyle(
            "jobtitle",
            fontName="Inter-SemiBold",
            fontSize=TITLE_SIZE,
            leading=TITLE_SIZE * 1.3,
            textColor=ACCENT,
        ),
    )
    story.append(title)
    story.append(Spacer(1, 13.0))

    contact_rows = [
        [
            {
                "icon": "pin",
                "text": "Algeria \u2014 Available for Remote Work",
                "color": INK,
            },
            {"icon": "phone", "text": PHONE, "url": PHONE_URL, "color": INK},
        ],
        [
            {"icon": "mail", "text": EMAIL, "url": f"mailto:{EMAIL}", "color": INK},
            {
                "icon": "link",
                "text": LINKEDIN_LABEL,
                "url": LINKEDIN_URL,
                "color": ACCENT,
            },
        ],
        [
            {
                "icon": "play",
                "label": "Portfolio:",
                "text": PORTFOLIO_LABEL,
                "url": PORTFOLIO_URL,
                "color": ACCENT,
            },
        ],
    ]
    story.append(ContactGrid(contact_rows, CONTENT_W))
    story.append(Spacer(1, 13.5))
    story.append(HairLine(CONTENT_W, color=RULE, accent_len=34.0))

    # ---------------- Profile ----------------
    story.append(Spacer(1, 24.0 + extra_gap))
    story.append(SectionHeading("Professional Summary", CONTENT_W))
    story.append(Spacer(1, 9.4))
    story.append(Paragraph(SUMMARY, body))

    # ---------------- Core skills ----------------
    story.append(Spacer(1, 24.0 + extra_gap))
    story.append(SectionHeading("Core Skills", CONTENT_W))
    story.append(Spacer(1, 9.8))
    story.append(SkillGrid(SKILLS, CONTENT_W))

    # ---------------- Experience ----------------
    story.append(Spacer(1, 24.0 + extra_gap))
    story.append(SectionHeading("Professional Experience", CONTENT_W))
    story.append(Spacer(1, 9.4))
    story.append(RoleLine(ROLE_TITLE, ROLE_DESC, ROLE_META, CONTENT_W))
    story.append(Spacer(1, 7.6))
    bullet_style = ParagraphStyle(
        "b", parent=bullet, bulletFontName="Inter", bulletFontSize=BULLET_SIZE
    )
    story.extend(
        Paragraph(f'<font color="#1F6FEB">\u2022</font>&nbsp;&nbsp;{b}', bullet_style)
        for b in BULLETS
    )

    # ---------------- Education ----------------
    story.append(Spacer(1, 24.0 + extra_gap))
    story.append(SectionHeading("Education", CONTENT_W))
    story.append(Spacer(1, 9.0))
    story.append(EducationLine(EDUCATION_DEGREE, EDUCATION_NATIVE, CONTENT_W))
    story.append(Paragraph(EDUCATION_NOTE, note))

    # ---------------- Technical skills / Languages ----------------
    story.append(Spacer(1, 22.0 + extra_gap))
    story.append(
        DetailStrip(
            [
                ("Technical Skills", "Adobe After Effects   \u00b7   DaVinci Resolve"),
                (
                    "Languages",
                    "Arabic \u2014 Native   \u00b7   English \u2014 Intermediate   "
                    "\u00b7   French \u2014 Beginner",
                ),
            ],
            CONTENT_W,
        )
    )

    return story


def story_height(story) -> float:
    """True height of the story, including paragraph space before/after."""
    avail = PAGE_H - M_TOP - M_BOTTOM
    total = 0.0
    for f in story:
        _w, h = f.wrap(CONTENT_W, avail)
        total += h + f.getSpaceBefore() + f.getSpaceAfter()
    return total


GAP_SLOTS = 6  # number of flexible section gaps in the story


def fit_story(verbose: bool = True, margin: float = 3.0) -> tuple:
    """Push the flexible gaps as wide as possible while keeping a single page."""
    avail = PAGE_H - M_TOP - M_BOTTOM
    extra = 0.0
    for _ in range(6):
        height = story_height(make_story(extra))
        slack = avail - margin - height
        if slack < 0.6:
            break
        step = slack / GAP_SLOTS
        if step < 0.15:
            break
        extra += step
    height = story_height(make_story(extra))
    if verbose:
        print(
            f"fit: section gap +{extra:.2f}pt -> content {height:.1f}pt / {avail:.1f}pt "
            f"(slack {avail - height:.1f}pt)"
        )
    return extra, height


def build(out_path: str = OUT_PDF, measure_only: bool = False):
    register_fonts()  # fonts must exist before measuring string widths
    extra, height = fit_story()
    if measure_only:
        return height
    story = make_story(extra)

    doc = BaseDocTemplate(
        out_path,
        pagesize=A4,
        leftMargin=M_LEFT,
        rightMargin=M_RIGHT,
        topMargin=M_TOP,
        bottomMargin=M_BOTTOM,
        title="Oussama Hamdaoui \u2014 Video Editor | Short-Form Content | Motion Graphics",
        author="Oussama Hamdaoui",
        subject="Video Editor CV \u2014 short-form content, motion graphics, remote work",
        keywords=(
            "Video Editor, Short-Form Content, Instagram Reels, Motion Graphics, "
            "Visual Effects, Adobe After Effects, DaVinci Resolve, Social Media "
            "Videos, Remote, Medical Content, Educational Content"
        ),
        creator="ReportLab",
    )
    frame = Frame(
        M_LEFT,
        M_BOTTOM,
        CONTENT_W,
        PAGE_H - M_TOP - M_BOTTOM,
        leftPadding=0,
        rightPadding=0,
        topPadding=0,
        bottomPadding=0,
        id="main",
    )
    doc.addPageTemplates([PageTemplate(id="cv", frames=[frame])])

    def canvasmaker(*args, **kwargs):
        # start the canvas on Inter so no unembedded base-14 font is referenced
        kwargs.setdefault("initialFontName", "Inter")
        kwargs.setdefault("initialFontSize", BODY_SIZE)
        return Canvas(*args, **kwargs)

    doc.build(story, canvasmaker=canvasmaker)
    print(f"wrote {out_path}")


if __name__ == "__main__":
    build(measure_only="--measure" in sys.argv)
