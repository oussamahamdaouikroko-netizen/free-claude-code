# Oussama Hamdaoui — CV (one-page A4)

Premium, ATS-friendly one-page CV for remote **Video Editor** roles, built from code so
the content and layout stay consistent between the PDF and the editable Word version.

## Deliverables

| File | Purpose |
| --- | --- |
| `Oussama_Hamdaoui_Video_Editor_CV.pdf` | Final resume — A4 portrait, 1 page, selectable text, clickable links |
| `Oussama_Hamdaoui_Video_Editor_CV.docx` | Editable Word version with identical content |

## Design

- **Palette:** dark navy `#0B1B33` headings, charcoal `#2A3441` body, electric blue
  `#1F6FEB` accent, hairline rules `#D8DFEA`.
- **Type:** Inter (open source, OFL 1.1) — instanced variable font, subset per weight and
  embedded in the PDF. The DOCX uses Calibri, which ships with Word, so the file looks
  right without installing anything.
- **Layout:** single-column reading order (safe for every ATS parser), accent-tick section
  headings, two-column skills checklist, small vector icons for contact details only.
- **No** photos, rating bars, progress circles, charts or decorative graphics.

## Content rules applied

Every fact comes from the candidate's own material. Nothing was invented: no company
names, dates, client names or metrics were added. Wording was tightened and re-ordered for
scanability, and relevant keywords (`short-form`, `Instagram Reels`, `motion graphics`,
`After Effects`, `DaVinci Resolve`, `social media content`, `visual storytelling`) appear
naturally so the CV passes keyword screening.

`cv_content.py` is the single source of truth shared by both builders, so the PDF and DOCX
can never drift apart.

## Build

```bash
pip install reportlab python-docx pypdf pymupdf fonttools

python3 prepare_fonts.py     # rebuild the subset Inter instances (needs network, once)
python3 build_cv.py          # -> Oussama_Hamdaoui_Video_Editor_CV.pdf
python3 build_docx.py        # -> Oussama_Hamdaoui_Video_Editor_CV.docx
```

`build_cv.py --measure` reports the fitted content height without writing a file. The
builder auto-distributes the leftover vertical space across the section gaps
(`fit_story()`), so the page fills exactly one sheet.

## Quality gates

```bash
python3 verify_cv.py         # PDF checks
python3 verify_docx.py       # DOCX checks
```

`verify_cv.py` asserts: 1 page, A4 media box, nothing outside the safe margins (text *and*
vector art), no overlapping spans, all 38 expected strings extractable, no
letter-spacing artefacts in extracted text (a `Tc` leak that ReportLab is prone to), no
missing-glyph characters, exactly the 4 expected hyperlinks with rects that cover real
text, all font weights embedded as subsets, and every drawn glyph coming from Inter.

`verify_docx.py` asserts: A4 with matching margins, content parity with the PDF, the 4
external links, no unbreakable text wider than the column measured in the *worst case*
(Inter is wider than Calibri), a restrained type scale, only the brand palette, no images,
and a one-page pagination estimate.

Both scripts exit non-zero on failure.

## Layout guard rails (learned the hard way)

- `ReportLab` names an embedded TTF subset after the font's **internal** name, and every
  static instance of Inter is internally called "Inter Regular". Without
  `prepare_fonts.py` renaming each instance, all weights collapse into Regular and the
  bold/semibold text silently renders at regular weight.
- `setCharSpace` / `drawString` never reset `Tc`, so tracked text (section headings) leaks
  letter-spacing into every later string. All drawing goes through `draw_text()`, which
  emits its own `Tc` per run.
- A custom `Flowable` must set `self.height` inside `wrap()`; returning a height without
  assigning it draws the content below its allocated box.
