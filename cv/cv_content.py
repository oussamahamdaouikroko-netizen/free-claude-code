#!/usr/bin/env python3
"""
Single source of truth for the CV content.

Both the PDF builder (build_cv.py) and the DOCX builder (build_docx.py) import
these values so the two files can never drift apart. Nothing here may be
invented: every fact comes from the candidate's own information.
"""

from __future__ import annotations

import re

# ---------------------------------------------------------------- identity
NAME = "Oussama Hamdaoui"
NAME_UPPER = "OUSSAMA HAMDAOUI"
JOB_TITLE = "Video Editor | Short-Form Content | Motion Graphics"
JOB_TITLE_DOTS = "Video Editor  \u00b7  Short-Form Content  \u00b7  Motion Graphics"
LOCATION = "Algeria \u2014 Available for Remote Work"

# ---------------------------------------------------------------- contact
EMAIL = "oussamahamdaouikroko@gmail.com"
PHONE = "+213 668 205 486"
PHONE_URL = "tel:+213668205486"
LINKEDIN_URL = "https://www.linkedin.com/in/oussama-hamdaoui-5000a7225"
LINKEDIN_LABEL = "linkedin.com/in/oussama-hamdaoui-5000a7225"
PORTFOLIO_URL = (
    "https://drive.google.com/drive/folders/"
    "1skJYrjaGuDvZI3jLE990Y0IKJwbySUc1?usp=drive_link"
)
PORTFOLIO_LABEL = "drive.google.com/drive/folders/1skJYrjaGuDvZI3jLE990Y0IKJwbySUc1"

# ---------------------------------------------------------------- profile
SUMMARY_HTML = (
    "Video Editor with <b>3 years of experience</b> creating short-form videos, "
    "social media content, and agency projects, including medical and educational "
    "content. Skilled in Adobe After Effects and DaVinci Resolve, with a focus on "
    "visual storytelling, editing pace, transitions, and motion graphics. Holds a "
    "Doctor of Pharmacy degree, providing a relevant background for medical and "
    "health education content. Seeking remote video editing opportunities with "
    "creative agencies, brands, and content creators."
)

# ---------------------------------------------------------------- skills
SKILLS = [
    "Video Editing & Short-Form Content",
    "Instagram Reels & Social Media Videos",
    "Motion Graphics & Visual Effects",
    "Visual Storytelling & Editing Pacing",
    "Medical & Educational Content",
    "Adobe After Effects",
    "DaVinci Resolve",
    "Social Media Content Production",
]

# ---------------------------------------------------------------- experience
ROLE_TITLE = "Video Editor"
ROLE_DESC = "\u2014 Agency Projects & Client Content"
ROLE_META = "3 Years Experience"

BULLETS_HTML = [
    "Edit short-form videos and social media content for agency projects and "
    "client accounts.",
    "Work on medical and educational videos, presenting information in a clear "
    "and engaging format.",
    "Use <b>Adobe After Effects</b> and <b>DaVinci Resolve</b> to create polished "
    "edits with transitions and motion elements.",
    "Work with scripts, creative briefs, and project feedback to prepare content "
    "for social platforms.",
    "Focus on visual storytelling to make information-heavy topics easier to "
    "understand.",
]

# ---------------------------------------------------------------- education
EDUCATION_DEGREE = "Doctor of Pharmacy"
EDUCATION_NATIVE = "(Docteur en pharmacie)"
EDUCATION_NOTE = "Relevant background for medical and health education content."

# ---------------------------------------------------------------- extras
TECH_SKILLS = "Adobe After Effects   \u00b7   DaVinci Resolve"
LANGUAGES_TEXT = (
    "Arabic \u2014 Native   \u00b7   English \u2014 Intermediate   "
    "\u00b7   French \u2014 Beginner"
)
LANGUAGES = [("Arabic", "Native"), ("English", "Intermediate"), ("French", "Beginner")]

# ---------------------------------------------------------------- metadata
PDF_TITLE = (
    "Oussama Hamdaoui \u2014 Video Editor | Short-Form Content | Motion Graphics"
)
PDF_SUBJECT = "Video Editor CV \u2014 short-form content, motion graphics, remote work"
KEYWORDS = (
    "Video Editor, Short-Form Content, Instagram Reels, Motion Graphics, Visual Effects, "
    "Adobe After Effects, DaVinci Resolve, Social Media Videos, Remote, Medical Content, "
    "Educational Content"
)

_TAG = re.compile(r"<[^>]+>")


def plain(html_text: str) -> str:
    """Strip the inline markup used for bold emphasis."""
    return _TAG.sub("", html_text).replace("&amp;", "&").replace("&nbsp;", " ")


SUMMARY = plain(SUMMARY_HTML)
BULLETS = [plain(b) for b in BULLETS_HTML]
