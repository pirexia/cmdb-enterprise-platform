// backend/src/services/docParser.ts
// Document text extraction service for the RAG pipeline.
// Supports: PDF (native text + OCR fallback for scanned), DOCX, DOC, XLSX, PPTX, ODT, ODS, TXT, CSV
// PNG/JPG are intentionally excluded from RAG indexing.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DocumentSection {
  /** Human-readable breadcrumb, e.g. "Introduction > Overview" or "Sheet1 > Row 1-50" */
  sectionPath: string;
  text: string;
  pageStart?: number;
  pageEnd?: number;
}

export interface ParseResult {
  sections: DocumentSection[];
  totalChars: number;
  mimeType: string;
  parseTimeMs: number;
}

// ---------------------------------------------------------------------------
// Safety constants
// ---------------------------------------------------------------------------

const MAX_PARSE_TIME_MS   = 60_000;     // 1 min max per document (native text extraction)
const MAX_CONTENT_CHARS   = 2_000_000;  // ~2 M chars safety cap
const MAX_FILE_BYTES      = 100 * 1024 * 1024; // 100 MB — skip larger files
const MAX_XLSX_ROWS       = 1_000;      // rows per sheet for XLSX
const CSV_CHUNK_LINES     = 100;        // lines per chunk for CSV

// OCR constants — scanned PDF fallback
const MAX_OCR_TIME_MS     = Number(process.env.OCR_TIMEOUT_MS ?? 180_000); // per-subprocess cap (pdftoppm or single tesseract page)
// Total timeout for a full OCR run (pdftoppm + all tesseract pages). Must be >> MAX_OCR_TIME_MS * typical pages.
// At 150 DPI a 16-page PDF takes ~14s (pdftoppm) + ~10s×16 (tesseract) ≈ 174s; 600s gives comfortable headroom.
const MAX_OCR_DOC_TIME_MS = Math.max(60_000, Number(process.env.OCR_DOC_TIMEOUT_MS ?? 600_000) || 600_000);
const OCR_LANGUAGES       = process.env.OCR_LANGUAGES ?? 'spa+eng';
const OCR_DPI             = process.env.OCR_DPI ?? '150';  // 300 DPI caused silent timeouts on multi-page scans; 150 is sufficient for text
const OCR_ENABLED         = process.env.OCR_ENABLED !== 'false'; // true unless explicitly disabled
// Hard cap on pages rasterised/OCR'd per document — bounds CPU/disk for huge scans (DoS guard).
const OCR_MAX_PAGES       = Number(process.env.OCR_MAX_PAGES ?? 50);
// Max bytes of OCR text captured from tesseract stdout per page.
const OCR_MAX_STDOUT      = 16 * 1024 * 1024;

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTimeoutPromise(ms: number): Promise<never> {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Parse timeout after ${ms} ms`)), ms)
  );
}

/** Split text into sections by blank lines or heading-like patterns. */
function splitByHeadings(text: string): DocumentSection[] {
  // A "heading" line: starts with uppercase, ≤80 chars, does not end with a period
  const headingRe = /^[A-Z][^\n]{0,79}[^.\n]$/m;

  // Split on double newlines first; further split large chunks on headings
  const paragraphs = text.split(/\n{2,}/);
  const sections: DocumentSection[] = [];
  let currentHeading = 'Document';
  let buffer: string[] = [];

  const flush = () => {
    const merged = buffer.join('\n\n').trim();
    if (merged) {
      sections.push({ sectionPath: currentHeading, text: merged });
    }
    buffer = [];
  };

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;
    if (headingRe.test(trimmed) && trimmed.length < 80 && !trimmed.includes('\n')) {
      flush();
      currentHeading = trimmed;
    } else {
      buffer.push(trimmed);
    }
  }
  flush();

  return sections.length > 0 ? sections : [{ sectionPath: 'Document', text: text.slice(0, MAX_CONTENT_CHARS) }];
}

// ---------------------------------------------------------------------------
// OCR fallback — scanned PDF (no embedded text)
// ---------------------------------------------------------------------------

async function parsePdfWithOcr(filePath: string): Promise<DocumentSection[]> {
  const label = path.basename(filePath);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmdb-ocr-'));
  // Every external process gets a hard timeout + SIGKILL so a stuck/abusive
  // file can never keep burning CPU after the parse promise is abandoned.
  const procOpts = { timeout: MAX_OCR_TIME_MS, killSignal: 'SIGKILL' as const };

  try {
    // Rasterise pages to PNG at the configured DPI, capped at OCR_MAX_PAGES (`-l`).
    // execFile (not exec) — args are an array literal, no shell, no interpolation.
    const prefix = path.join(tmpDir, 'p');
    await execFileAsync(
      'pdftoppm',
      ['-r', OCR_DPI, '-l', String(OCR_MAX_PAGES), '-png', filePath, prefix],
      procOpts,
    );

    const pngs = fs.readdirSync(tmpDir)
      .filter((f) => f.endsWith('.png'))
      .sort()                                    // sort guarantees page order
      .slice(0, OCR_MAX_PAGES)                   // belt-and-braces page cap
      .map((f) => path.join(tmpDir, f));

    if (pngs.length === 0) {
      console.warn(`[docParser][OCR] pdftoppm produced no images for "${label}"`);
      return [];
    }

    console.log(`[docParser][OCR] fallback activated for "${label}" — ${pngs.length} page(s) at ${OCR_DPI} DPI, lang=${OCR_LANGUAGES}`);

    const sections: DocumentSection[] = [];

    for (let i = 0; i < pngs.length; i++) {
      // Call the tesseract binary directly via execFile (no shell). OCR_LANGUAGES
      // comes from env only; the image path is a server-generated mkdtemp path.
      const { stdout } = await execFileAsync(
        'tesseract',
        [pngs[i], 'stdout', '-l', OCR_LANGUAGES, '--oem', '1', '--psm', '3'],
        { ...procOpts, maxBuffer: OCR_MAX_STDOUT },
      );

      const trimmed = stdout.trim().slice(0, MAX_CONTENT_CHARS);
      if (trimmed) {
        sections.push({
          sectionPath: `Página ${i + 1}`,
          text: trimmed,
          pageStart: i + 1,
          pageEnd:   i + 1,
        });
      }
    }

    console.log(`[docParser][OCR] "${label}" — ${sections.length} section(s) extracted`);
    return sections;

  } finally {
    // Always clean up temporary PNG files regardless of success or error.
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// PDF parser
// ---------------------------------------------------------------------------

async function parsePdf(filePath: string): Promise<DocumentSection[]> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pdfParse = require('pdf-parse') as (buf: Buffer, opts?: Record<string, unknown>) => Promise<{ text: string; numpages: number }>;
  const dataBuffer = fs.readFileSync(filePath);
  const data = await pdfParse(dataBuffer);
  const text = data.text.slice(0, MAX_CONTENT_CHARS);

  if (!text.trim()) {
    // No embedded text — scanned PDF. Fall back to Tesseract OCR if enabled.
    if (OCR_ENABLED) {
      return parsePdfWithOcr(filePath);
    }
    return [];
  }

  return [{
    sectionPath: 'PDF',
    text,
    pageStart: 1,
    pageEnd: data.numpages,
  }];
}

// ---------------------------------------------------------------------------
// DOCX / DOC parser
// ---------------------------------------------------------------------------

async function parseDocx(filePath: string): Promise<DocumentSection[]> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mammoth = require('mammoth') as {
    extractRawText: (opts: { path: string }) => Promise<{ value: string; messages: unknown[] }>;
  };

  const result = await mammoth.extractRawText({ path: filePath });
  const rawText = result.value.slice(0, MAX_CONTENT_CHARS);

  if (!rawText.trim()) {
    return [];
  }

  return splitByHeadings(rawText);
}

// ---------------------------------------------------------------------------
// XLSX parser
// ---------------------------------------------------------------------------

async function parseXlsx(filePath: string): Promise<DocumentSection[]> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ExcelJS = require('exceljs') as typeof import('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);

  const sections: DocumentSection[] = [];

  workbook.eachSheet((sheet) => {
    const lines: string[] = [];
    let rowCount = 0;

    sheet.eachRow({ includeEmpty: false }, (row) => {
      if (rowCount >= MAX_XLSX_ROWS) return;
      rowCount++;

      const cells: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell) => {
        const v = cell.value;
        if (v === null || v === undefined) {
          cells.push('');
        } else if (typeof v === 'object' && 'result' in (v as unknown as Record<string, unknown>)) {
          // Formula cell — use result
          cells.push(String((v as { result: unknown }).result ?? ''));
        } else if (typeof v === 'object' && 'text' in (v as unknown as Record<string, unknown>)) {
          // Rich text
          cells.push(String((v as { text: unknown }).text ?? ''));
        } else {
          cells.push(String(v));
        }
      });

      lines.push(cells.join('\t'));
    });

    const text = lines.join('\n').slice(0, MAX_CONTENT_CHARS);
    if (text.trim()) {
      sections.push({
        sectionPath: sheet.name,
        text,
      });
    }
  });

  return sections;
}

// ---------------------------------------------------------------------------
// PPTX / ODT / ODS parser  (officeparser handles all three)
// ---------------------------------------------------------------------------

async function parseOffice(filePath: string, label: string): Promise<DocumentSection[]> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const officeParser = require('officeparser') as {
    parseOfficeAsync: (filePath: string) => Promise<string>;
  };

  const text = await officeParser.parseOfficeAsync(filePath);
  const sliced = text.slice(0, MAX_CONTENT_CHARS);

  if (!sliced.trim()) {
    return [];
  }

  return [{ sectionPath: label, text: sliced }];
}

// ---------------------------------------------------------------------------
// Plain text / CSV parser
// ---------------------------------------------------------------------------

async function parsePlainText(filePath: string, mimeType: string): Promise<DocumentSection[]> {
  const content = fs.readFileSync(filePath, 'utf-8');

  if (!content.trim()) {
    return [];
  }

  if (mimeType === 'text/csv') {
    // Group into chunks of CSV_CHUNK_LINES lines
    const lines = content.split('\n');
    const header = lines[0] ?? '';
    const dataLines = lines.slice(1);
    const sections: DocumentSection[] = [];
    let chunkStart = 0;

    while (chunkStart < dataLines.length) {
      const chunk = dataLines.slice(chunkStart, chunkStart + CSV_CHUNK_LINES);
      const text = [header, ...chunk].join('\n').slice(0, MAX_CONTENT_CHARS);
      if (text.trim()) {
        sections.push({
          sectionPath: `CSV > Rows ${chunkStart + 1}-${chunkStart + chunk.length}`,
          text,
        });
      }
      chunkStart += CSV_CHUNK_LINES;
    }

    return sections.length > 0 ? sections : [{ sectionPath: 'CSV', text: content.slice(0, MAX_CONTENT_CHARS) }];
  }

  // Plain text: single section if small enough, otherwise split by blank lines
  const MAX_SINGLE_SECTION = 50 * 1024; // 50 KB
  if (content.length <= MAX_SINGLE_SECTION) {
    return [{ sectionPath: 'Document', text: content.slice(0, MAX_CONTENT_CHARS) }];
  }

  return splitByHeadings(content.slice(0, MAX_CONTENT_CHARS));
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function parseDocument(
  filePath: string,
  mimeType: string,
  originalName: string,
): Promise<ParseResult> {
  const start = Date.now();

  const emptyResult = (): ParseResult => ({
    sections: [],
    totalChars: 0,
    mimeType,
    parseTimeMs: Date.now() - start,
  });

  // --- File-size guard ---
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch (err) {
    console.error(`[docParser] Cannot stat file "${path.basename(filePath)}":`, err instanceof Error ? err.message : err);
    return emptyResult();
  }

  if (stat.size > MAX_FILE_BYTES) {
    console.warn(`[docParser] Skipping "${path.basename(filePath)}" — size ${stat.size} bytes exceeds ${MAX_FILE_BYTES} byte limit`);
    return emptyResult();
  }

  const parseWork = async (): Promise<DocumentSection[]> => {
    switch (mimeType) {
      case 'application/pdf':
        return parsePdf(filePath);

      case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      case 'application/msword': // .doc
        return parseDocx(filePath);

      case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
        return parseXlsx(filePath);

      case 'application/vnd.openxmlformats-officedocument.presentationml.presentation':
        return parseOffice(filePath, 'Presentación');

      case 'application/vnd.oasis.opendocument.text':
        return parseOffice(filePath, 'ODT');

      case 'application/vnd.oasis.opendocument.spreadsheet':
        return parseOffice(filePath, 'ODS');

      case 'text/plain':
      case 'text/csv':
        return parsePlainText(filePath, mimeType);

      default:
        // PNG, JPG, JPEG and unknown types: not indexable, return empty silently
        return [];
    }
  };

  // PDFs may trigger multi-page OCR; use MAX_OCR_DOC_TIME_MS as the outer cap so that
  // the promise-race does not fire before all tesseract page calls complete.
  // Previously MAX_OCR_TIME_MS (180s per subprocess) was used here, causing silent
  // timeouts for 16-page scans at 300 DPI (pdftoppm 57s + tesseract 44s/page ≈ 760s).
  const timeoutMs = mimeType === 'application/pdf' ? MAX_OCR_DOC_TIME_MS : MAX_PARSE_TIME_MS;

  let sections: DocumentSection[];
  try {
    sections = await Promise.race([
      parseWork(),
      makeTimeoutPromise(timeoutMs),
    ]);
  } catch (err) {
    console.error(
      `[docParser] Failed to parse "${path.basename(filePath)}" (${mimeType}):`,
      err instanceof Error ? err.message : err,
    );
    return emptyResult();
  }

  const totalChars = sections.reduce((sum, s) => sum + s.text.length, 0);

  return {
    sections,
    totalChars,
    mimeType,
    parseTimeMs: Date.now() - start,
  };
}
