'use strict';
/**
 * Tiny XLSX writer: turns sheets of cells into a real Excel/Google Sheets file.
 *
 * Why not a library? The app is 100% offline and dependency-light: this file is
 * ~200 lines, produces a standards-compliant workbook (inline strings, real date
 * and currency cells, frozen header, auto-filter, column widths) and Google
 * Sheets / Excel / LibreOffice all open it natively.
 *
 * Cell shapes accepted by `sheet()`:
 *   'text'                      → string cell
 *   { text: 'x' }               → string cell (forced)
 *   { number: 1234.5 }          → numeric cell
 *   { money: 1234.5 }           → numeric cell, 2 decimals + currency format
 *   { date: '2026-10-23' }      → real date cell (dd/mm/yyyy)
 *   { text: 'x', style: 'header' | 'title' | 'total' } → styled
 */

const { createZip } = require('./zip');

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

// Cell style indexes (must match STYLES below).
const STYLE = { normal: 0, date: 1, money: 2, header: 3, total: 4, title: 5 };

const STYLES = `${XML_HEADER}
<styleSheet xmlns="${NS}">
  <numFmts count="1">
    <numFmt numFmtId="164" formatCode="dd/mm/yyyy"/>
  </numFmts>
  <fonts count="4">
    <font><sz val="11"/><color theme="1"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><color theme="1"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
    <font><b/><sz val="14"/><color rgb="FF1F6F6B"/><name val="Calibri"/></font>
  </fonts>
  <fills count="4">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF1F6F6B"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFE3F2F0"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border><left/><right/><top/><bottom style="thin"><color rgb="FFD5E3E1"/></bottom><diagonal/></border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="6">
    <!-- 0 normal -->
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <!-- 1 date -->
    <xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
    <!-- 2 money -->
    <xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
    <!-- 3 header -->
    <xf numFmtId="0" fontId="2" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
    <!-- 4 total -->
    <xf numFmtId="4" fontId="1" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>
    <!-- 5 title -->
    <xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

const escapeXml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // Control characters are invalid in XML and make Excel reject the file.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

/** 0-based column index → A, B, … Z, AA, AB … */
function colName(index) {
  let name = '';
  let current = index;
  while (current >= 0) {
    name = String.fromCharCode(65 + (current % 26)) + name;
    current = Math.floor(current / 26) - 1;
  }
  return name;
}

/** Days since 1899-12-30, the epoch Excel and Google Sheets both use. */
function dateSerial(isoDate) {
  const match = String(isoDate).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const utc = Date.UTC(year, month - 1, day);
  return Math.round((utc - Date.UTC(1899, 11, 30)) / 86400000);
}

function cellXml(cell, ref, fallbackStyle) {
  if (cell === null || cell === undefined || cell === '') {
    return fallbackStyle ? `<c r="${ref}" s="${fallbackStyle}"/>` : '';
  }
  const styleName = typeof cell === 'object' && cell.style ? cell.style : null;
  const style = styleName ? (STYLE[styleName] ?? STYLE.normal) : fallbackStyle;

  if (typeof cell === 'object' && cell.date) {
    const serial = dateSerial(cell.date);
    if (serial !== null) return `<c r="${ref}" s="${STYLE.date}"><v>${serial}</v></c>`;
    return `<c r="${ref}" s="${style}"><is><t>${escapeXml(cell.date)}</t></is></c>`;
  }
  const numeric =
    typeof cell === 'number' ? { value: cell, kind: 'number' } : cell?.money !== undefined
      ? { value: Number(cell.money) || 0, kind: 'money' }
      : cell?.number !== undefined
        ? { value: Number(cell.number) || 0, kind: 'number' }
        : null;
  if (numeric) {
    const numStyle = style ?? (numeric.kind === 'money' ? STYLE.money : STYLE.normal);
    return `<c r="${ref}" s="${numStyle}"><v>${numeric.value}</v></c>`;
  }
  const text = typeof cell === 'string' ? cell : (cell.text ?? cell.value ?? '');
  const s = style ? ` s="${style}"` : '';
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`;
}

function sheetXml(sheet) {
  const widths = sheet.widths || [];
  const rows = sheet.rows || [];
  // Widest row wins: an auto-filter must cover every populated column.
  const widest = rows.reduce(
    (max, row) => Math.max(max, (row.cells || row).length),
    sheet.widths?.length || 1,
  );
  const lastCol = colName(Math.max(0, widest - 1));
  const maxRow = rows.length || 1;

  const cols = widths.length
    ? `<cols>${widths
        .map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`)
        .join('')}</cols>`
    : '';

  const body = rows
    .map((row, rowIndex) => {
      const cells = (row.cells || row)
        .map((cell, colIndex) =>
          cellXml(cell, `${colName(colIndex)}${rowIndex + 1}`, row.style ? STYLE[row.style] : null),
        )
        .join('');
      const height = row.height ? ` ht="${row.height}" customHeight="1"` : '';
      return `<row r="${rowIndex + 1}"${height}>${cells}</row>`;
    })
    .join('');

  // Freeze the header row and keep the filter on it: instant usability.
  const freeze = sheet.freezeRow
    ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${sheet.freezeRow}" topLeftCell="A${
        sheet.freezeRow + 1
      }" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
    : '';
  const filter = sheet.filter
    ? `<autoFilter ref="A${sheet.filter.row}:${lastCol}${maxRow}"/>`
    : '';

  return `${XML_HEADER}
<worksheet xmlns="${NS}" xmlns:r="${NS_R}">
  ${freeze}
  <sheetFormatPr defaultRowHeight="15"/>
  ${cols}
  <sheetData>${body}</sheetData>
  ${filter}
  <pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>
</worksheet>`;
}

/**
 * Build an .xlsx buffer.
 * @param {Array<{name: string, rows: Array, widths?: number[], freezeRow?: number,
 *                filter?: {row: number}}>} sheets
 * @param {{creator?: string, title?: string}} [meta]
 */
function buildWorkbook(sheets, meta = {}) {
  if (!Array.isArray(sheets) || sheets.length === 0) throw new Error('A workbook needs one sheet');
  const usedNames = new Set();
  const safeSheets = sheets.map((sheet, index) => {
    // Excel forbids : \ / ? * [ ] in sheet names, caps them at 31 chars and
    // wants them unique; Google Sheets is just as strict when importing.
    let name = String(sheet.name || `Feuille ${index + 1}`)
      .replace(/[:\\/?*[\]]/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^'+|'+$/g, '')
      .trim()
      .slice(0, 31)
      .trim();
    if (!name) name = `Feuille ${index + 1}`;
    let candidate = name;
    let suffix = 2;
    while (usedNames.has(candidate.toLowerCase())) {
      const tail = ` (${suffix})`;
      candidate = `${name.slice(0, 31 - tail.length)}${tail}`;
      suffix += 1;
    }
    usedNames.add(candidate.toLowerCase());
    return { ...sheet, name: candidate };
  });

  const contentTypes = `${XML_HEADER}
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  ${safeSheets
    .map(
      (_sheet, index) =>
        `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    )
    .join('')}
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`;

  const rootRels = `${XML_HEADER}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="${NS_R}/officeDocument" Target="xl/workbook.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`;

  const workbook = `${XML_HEADER}
<workbook xmlns="${NS}" xmlns:r="${NS_R}">
  <sheets>
    ${safeSheets
      .map(
        (sheet, index) =>
          `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`,
      )
      .join('')}
  </sheets>
</workbook>`;

  const workbookRels = `${XML_HEADER}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${safeSheets
    .map(
      (_sheet, index) =>
        `<Relationship Id="rId${index + 1}" Type="${NS_R}/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
    )
    .join('')}
  <Relationship Id="rId${safeSheets.length + 1}" Type="${NS_R}/styles" Target="styles.xml"/>
</Relationships>`;

  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const core = `${XML_HEADER}
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
  xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${escapeXml(meta.title || 'MediRDV')}</dc:title>
  <dc:creator>${escapeXml(meta.creator || 'MediRDV')}</dc:creator>
  <cp:lastModifiedBy>${escapeXml(meta.creator || 'MediRDV')}</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`;

  return createZip([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rootRels },
    { name: 'docProps/core.xml', data: core },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: workbookRels },
    { name: 'xl/styles.xml', data: STYLES },
    ...safeSheets.map((sheet, index) => ({
      name: `xl/worksheets/sheet${index + 1}.xml`,
      data: sheetXml(sheet),
    })),
  ]);
}

module.exports = { buildWorkbook, colName, dateSerial, escapeXml };
