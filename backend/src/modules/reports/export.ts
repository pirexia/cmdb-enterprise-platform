import ExcelJS from 'exceljs';
import type { ReportColumn } from './types.js';

type Row = Record<string, unknown>;

function cellValue(row: Row, col: ReportColumn): string {
  const v = row[col.key];
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
}

export function toCSV(columns: ReportColumn[], rows: Row[]): string {
  const header = columns.map((c) => `"${c.key}"`).join(',');
  const lines = rows.map((row) =>
    columns.map((c) => {
      const v = cellValue(row, c);
      return `"${v.replace(/"/g, '""')}"`;
    }).join(','),
  );
  return [header, ...lines].join('\r\n');
}

export async function toXLSX(columns: ReportColumn[], rows: Row[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Report');

  ws.columns = columns.map((c) => ({
    header: c.key,
    key: c.key,
    width: c.width ?? 20,
  }));

  // Bold header row
  ws.getRow(1).font = { bold: true };

  for (const row of rows) {
    const wsRow: Record<string, unknown> = {};
    for (const col of columns) {
      const v = row[col.key];
      if (col.type === 'date' && typeof v === 'string') {
        wsRow[col.key] = v ? new Date(v) : '';
      } else if (col.type === 'number' && typeof v === 'number') {
        wsRow[col.key] = v;
      } else {
        wsRow[col.key] = cellValue(row, col);
      }
    }
    ws.addRow(wsRow);
  }

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}
