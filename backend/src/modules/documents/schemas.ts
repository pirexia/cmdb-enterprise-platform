import { z } from 'zod';
import type { BulkAnalysisRaw } from '../../services/ragService';

// ── File upload allowlist ─────────────────────────────────────────────────────

export const ALLOWED_EXTENSIONS = new Set([
  'pdf', 'docx', 'xlsx', 'pptx', 'doc', 'txt', 'csv', 'png', 'jpg', 'jpeg', 'odt', 'ods',
]);

export const MAGIC_BYTES: Record<string, Array<{ offset: number; hex: string }>> = {
  pdf:  [{ offset: 0, hex: '25504446' }],
  png:  [{ offset: 0, hex: '89504e47' }],
  jpg:  [{ offset: 0, hex: 'ffd8ff' }],
  jpeg: [{ offset: 0, hex: 'ffd8ff' }],
  docx: [{ offset: 0, hex: '504b0304' }],
  xlsx: [{ offset: 0, hex: '504b0304' }],
  pptx: [{ offset: 0, hex: '504b0304' }],
  odt:  [{ offset: 0, hex: '504b0304' }],
  ods:  [{ offset: 0, hex: '504b0304' }],
  doc:  [{ offset: 0, hex: 'd0cf11e0' }],
  txt:  [],
  csv:  [],
};

export function validateMagicBytes(buffer: Buffer, ext: string): boolean {
  const checks = MAGIC_BYTES[ext];
  if (!checks) return false;
  if (checks.length === 0) return true;
  return checks.some(({ offset, hex }) => {
    const slice = buffer.slice(offset, offset + hex.length / 2);
    return slice.toString('hex').startsWith(hex.toLowerCase());
  });
}

// ── Document ACL ──────────────────────────────────────────────────────────────

export function docVisibilityFilter(
  role: string,
): { readAdmin: boolean } | { readAuditor: boolean } | { readViewer: boolean } {
  if (role === 'ADMIN')   return { readAdmin: true };
  if (role === 'AUDITOR') return { readAuditor: true };
  return { readViewer: true };
}

// ── Bulk AI analysis ──────────────────────────────────────────────────────────

export const BulkAnalysisSchema = z.object({
  documentTypeGuess: z.string().max(40).nullable().optional(),
  startDate:         z.string().max(40).nullable().optional(),
  endDate:           z.string().max(40).nullable().optional(),
  vendorName:        z.string().max(255).nullable().optional(),
  entityNumber:      z.string().max(100).nullable().optional(),
  suggestedTarget:   z.enum(['contract', 'addendum', 'license', 'none']).nullable().optional(),
  ciHints:           z.array(z.string().max(255)).max(50).nullable().optional(),
});

export interface NormalizedAnalysis {
  documentTypeGuess: string | null;
  startDate:         string | null;
  endDate:           string | null;
  vendorName:        string | null;
  entityNumber:      string | null;
  suggestedTarget:   'contract' | 'addendum' | 'license' | 'none';
  ciHints:           string[];
}

export function parseIsoDateSafe(s: unknown): string | null {
  if (typeof s !== 'string') return null;
  const m = s.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(`${iso}T00:00:00Z`);
  if (isNaN(d.getTime())) return null;
  if (d.toISOString().slice(0, 10) !== iso) return null;
  return iso;
}

export function normalizeAnalysis(raw: BulkAnalysisRaw): NormalizedAnalysis {
  const parsed = BulkAnalysisSchema.safeParse(raw);
  const d = parsed.success ? parsed.data : {};
  const hints = Array.isArray(d.ciHints)
    ? d.ciHints.filter((h): h is string => typeof h === 'string' && h.trim().length > 0).map((h) => h.trim())
    : [];
  return {
    documentTypeGuess: typeof d.documentTypeGuess === 'string' ? d.documentTypeGuess.slice(0, 40) : null,
    startDate:         parseIsoDateSafe(d.startDate),
    endDate:           parseIsoDateSafe(d.endDate),
    vendorName:        typeof d.vendorName === 'string' ? (d.vendorName.trim().slice(0, 255) || null) : null,
    entityNumber:      typeof d.entityNumber === 'string' ? (d.entityNumber.trim().slice(0, 100) || null) : null,
    suggestedTarget:   d.suggestedTarget ?? 'none',
    ciHints:           hints,
  };
}

export interface CiMatch { ciId: string; name: string; serial: string | null; matchType: 'serial' | 'name'; }

// ── Bulk commit decision ──────────────────────────────────────────────────────

export class BulkValidationError extends Error {}

export const BulkItemDecisionBase = z.object({
  target:           z.enum(['contract', 'addendum', 'license', 'none']),
  documentTypeId:   z.string().uuid(),
  title:            z.string().min(1).max(500),
  description:      z.string().max(2000).nullable().optional(),
  startDate:        z.string().max(40).nullable().optional(),
  endDate:          z.string().max(40).nullable().optional(),
  vendorId:         z.string().uuid().nullable().optional(),
  entityNumber:     z.string().min(1).max(100).nullable().optional(),
  parentContractId: z.string().uuid().nullable().optional(),
  licenseName:      z.string().min(1).max(255).nullable().optional(),
  ciIds:            z.array(z.string().uuid()).max(100).optional(),
});

export const BulkItemDecisionSchema = BulkItemDecisionBase.superRefine((d, ctx) => {
  const reqDate = /^\d{4}-\d{2}-\d{2}/;
  if (d.target === 'contract' || d.target === 'addendum') {
    if (!d.entityNumber) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Número de contrato requerido', path: ['entityNumber'] });
    if (!d.vendorId)     ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Proveedor requerido', path: ['vendorId'] });
    if (!d.startDate)    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Fecha de inicio requerida', path: ['startDate'] });
    if (d.target === 'addendum' && !d.parentContractId) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Contrato padre requerido para una adenda', path: ['parentContractId'] });
  }
  if (d.target === 'license') {
    if (!d.entityNumber) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Número de licencia requerido', path: ['entityNumber'] });
    if (!d.licenseName)  ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Nombre de licencia requerido', path: ['licenseName'] });
    if (!d.startDate)    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Fecha de inicio requerida', path: ['startDate'] });
  }
  for (const f of ['startDate', 'endDate'] as const) {
    const v = d[f];
    if (v && !reqDate.test(v)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Formato de fecha inválido en ${f}`, path: [f] });
  }
});

export type BulkItemDecision = z.infer<typeof BulkItemDecisionSchema>;

export interface BulkItemRow {
  id: string; batch_id: string; staged_file_name: string;
  original_name: string; mime_type: string; file_size: number; status: string;
}
