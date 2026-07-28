import ExcelJS from 'exceljs';
import type { ScheduleView } from './service.js';

// Both export functions take an ALREADY-MASKED ScheduleView (produced by
// service.buildScheduleView(prisma, id, viewer)). Never pass raw/unmasked
// data here — the whole point of GDPR Art. 9 masking is that it happens once,
// server-side, before any serialization path (view, CSV, XLSX).

function cellText(entry: ScheduleView['rows'][number]['entries'][string] | undefined): string {
  if (!entry) return '';
  const guard = entry.onGuard ? ' [GUARDIA]' : '';
  if (entry.startTime && entry.endTime) return `${entry.status} ${entry.startTime}-${entry.endTime}${guard}`;
  return `${entry.status}${guard}`;
}

function escapeCsv(v: string): string {
  return `"${v.replace(/"/g, '""')}"`;
}

// v3.5.12 (R2) — `summary` is optional on ScheduleView (omitted server-side
// for a viewer unauthorized under canViewSummary). The export must inherit
// that control for free: it operates on an already-masked ScheduleView, so
// when the field is absent it emits empty cells rather than throwing.
function summaryCell(v: number | undefined): string {
  return v === undefined ? '' : String(v);
}

export function exportScheduleCsv(view: ScheduleView): string {
  const header = ['Username', ...view.days, 'WeeklyNetHours', 'TeleworkDaysWeek', 'TeleworkDaysMonth', 'TravelDays', 'GuardDays'];
  const lines = view.rows.map((row) => {
    const cells = [
      row.username,
      ...view.days.map((d) => cellText(row.entries[d])),
      summaryCell(row.summary?.weeklyNetHours),
      summaryCell(row.summary?.teleworkDaysWeek),
      summaryCell(row.summary?.teleworkDaysMonth),
      summaryCell(row.summary?.travelDays),
      summaryCell(row.summary?.guardDays),
    ];
    return cells.map(escapeCsv).join(',');
  });
  return [header.map(escapeCsv).join(','), ...lines].join('\r\n');
}

export async function exportScheduleXlsx(view: ScheduleView): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Schedule');

  ws.columns = [
    { header: 'Username', key: 'username', width: 24 },
    ...view.days.map((d) => ({ header: d, key: d, width: 20 })),
    { header: 'WeeklyNetHours', key: 'weeklyNetHours', width: 16 },
    { header: 'TeleworkDaysWeek', key: 'teleworkDaysWeek', width: 16 },
    { header: 'TeleworkDaysMonth', key: 'teleworkDaysMonth', width: 18 },
    { header: 'TravelDays', key: 'travelDays', width: 12 },
    { header: 'GuardDays', key: 'guardDays', width: 12 },
  ];
  ws.getRow(1).font = { bold: true };

  for (const row of view.rows) {
    const wsRow: Record<string, unknown> = { username: row.username };
    for (const d of view.days) wsRow[d] = cellText(row.entries[d]);
    wsRow.weeklyNetHours = summaryCell(row.summary?.weeklyNetHours);
    wsRow.teleworkDaysWeek = summaryCell(row.summary?.teleworkDaysWeek);
    wsRow.teleworkDaysMonth = summaryCell(row.summary?.teleworkDaysMonth);
    wsRow.travelDays = summaryCell(row.summary?.travelDays);
    wsRow.guardDays = summaryCell(row.summary?.guardDays);
    ws.addRow(wsRow);
  }

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}
