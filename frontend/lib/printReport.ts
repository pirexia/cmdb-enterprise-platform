/**
 * Opens a styled HTML report in a new browser window and triggers the print dialog.
 * The HTML must be a complete, self-contained document.
 *
 * @param html  - Complete HTML document string
 */
export function openPrintWindow(html: string): void {
  const win = window.open("", "_blank", "width=1050,height=820,scrollbars=yes,resizable=yes");
  if (!win) {
    alert(
      "El navegador bloqueó la apertura de la ventana emergente.\n" +
      "Por favor, permite ventanas emergentes para este sitio y vuelve a intentarlo."
    );
    return;
  }
  win.document.open();
  win.document.write(html);
  win.document.close();
  // The HTML itself triggers window.print() via its onload script
}

// ─── Shared print CSS ─────────────────────────────────────────────────────────

export const PRINT_CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;
    font-size: 10.5pt;
    color: #1e293b;
    background: #fff;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  @page { size: A4; margin: 12mm 10mm 14mm 10mm; }

  /* ── Report header ── */
  .report-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    padding-bottom: 14px;
    border-bottom: 2.5px solid #4f46e5;
    margin-bottom: 22px;
  }
  .brand { display: flex; align-items: center; gap: 10px; }
  .brand-logo {
    width: 34px; height: 34px;
    background: #4f46e5;
    border-radius: 7px;
    display: flex; align-items: center; justify-content: center;
  }
  .brand-name { font-size: 11pt; font-weight: 800; color: #0f172a; }
  .brand-sub  { font-size: 7.5pt; color: #94a3b8; text-transform: uppercase; letter-spacing: 1px; margin-top: 1px; }
  .report-info { text-align: right; }
  .report-title    { font-size: 14pt; font-weight: 800; color: #1e293b; }
  .report-subtitle { font-size: 9.5pt; color: #4f46e5; font-weight: 600; margin-top: 2px; }
  .report-date     { font-size: 8pt; color: #64748b; margin-top: 4px; }

  /* ── Sections ── */
  section { margin-bottom: 22px; page-break-inside: avoid; }
  .section-title {
    font-size: 10pt; font-weight: 700; color: #1e293b;
    border-left: 3px solid #4f46e5;
    padding-left: 8px;
    margin-bottom: 10px;
  }
  .section-note { font-size: 8pt; color: #64748b; margin-bottom: 8px; }

  /* ── Tables ── */
  table { width: 100%; border-collapse: collapse; font-size: 8.5pt; margin-top: 4px; }
  thead th {
    background: #4f46e5; color: white;
    padding: 7px 10px; text-align: left;
    font-weight: 600; font-size: 8pt;
    text-transform: uppercase; letter-spacing: 0.3px;
  }
  tbody tr:nth-child(even) { background: #f8fafc; }
  tbody td { padding: 6px 10px; border-bottom: 1px solid #e2e8f0; vertical-align: middle; line-height: 1.4; }
  tbody tr:last-child td { border-bottom: none; }
  .empty-cell { text-align: center; color: #94a3b8; font-style: italic; padding: 18px !important; }

  /* ── Row colour coding ── */
  .row-red    td { background: #fff1f2 !important; }
  .row-orange td { background: #fff7ed !important; }
  .row-green  td { background: #f0fdf4 !important; }

  /* ── Dot indicator ── */
  .dot {
    display: inline-block; width: 8px; height: 8px;
    border-radius: 50%; margin-right: 5px; vertical-align: middle; flex-shrink: 0;
  }
  .dot-red    { background: #ef4444; }
  .dot-orange { background: #f97316; }
  .dot-green  { background: #22c55e; }
  .dot-slate  { background: #94a3b8; }

  /* ── Badges ── */
  .badge {
    display: inline-block; padding: 2px 7px; border-radius: 10px;
    font-size: 7.5pt; font-weight: 600; line-height: 1.6;
  }
  .badge-red    { background: #fee2e2; color: #b91c1c; }
  .badge-orange { background: #ffedd5; color: #c2410c; }
  .badge-yellow { background: #fef9c3; color: #854d0e; }
  .badge-green  { background: #dcfce7; color: #166534; }
  .badge-slate  { background: #f1f5f9; color: #475569; }
  .badge-indigo { background: #e0e7ff; color: #3730a3; }
  .badge-violet { background: #f3e8ff; color: #6d28d9; }

  /* ── Metric grid ── */
  .metrics-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
  .metric-card {
    background: #f8fafc; border: 1px solid #e2e8f0;
    border-radius: 8px; padding: 12px 14px;
  }
  .metric-value { font-size: 18pt; font-weight: 800; color: #1e293b; }
  .metric-label { font-size: 7.5pt; color: #64748b; margin-top: 2px; font-weight: 500; }

  /* ── Chart bars ── */
  .chart-container { display: flex; flex-direction: column; gap: 9px; }
  .chart-row { display: flex; align-items: center; gap: 10px; }
  .chart-label { width: 140px; font-size: 8.5pt; color: #475569; font-weight: 500; flex-shrink: 0; }
  .chart-track { flex: 1; height: 14px; background: #f1f5f9; border-radius: 3px; overflow: hidden; }
  .chart-fill  { height: 100%; border-radius: 3px; min-width: 3px; }
  .chart-count { width: 70px; text-align: right; font-size: 8.5pt; font-weight: 600; color: #334155; }
  .chart-pct   { font-weight: 400; color: #94a3b8; }

  /* ── Alert callout ── */
  .alert-box {
    background: #fffbeb; border: 1px solid #fde68a;
    border-left: 3px solid #f59e0b; border-radius: 6px;
    padding: 9px 13px; font-size: 8.5pt; color: #92400e;
    margin-bottom: 12px;
  }

  /* ── Footer ── */
  .report-footer {
    border-top: 1px solid #e2e8f0; padding-top: 10px; margin-top: 20px;
    display: flex; justify-content: space-between;
    font-size: 7.5pt; color: #94a3b8;
  }

  /* ── Print hide ── */
  @media print { .no-print { display: none !important; } }
`;

// ─── HTML skeleton helper ─────────────────────────────────────────────────────

export function buildReportHTML(
  title: string,
  subtitle: string,
  bodyContent: string
): string {
  const now = new Date();
  const dateStr = now.toLocaleString("es-ES", {
    day: "2-digit", month: "long", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });

  const svgServer = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
    <rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/>
    <line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/>
  </svg>`;

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>${title}</title>
  <style>${PRINT_CSS}</style>
</head>
<body>

<div class="report-header">
  <div class="brand">
    <div class="brand-logo">${svgServer}</div>
    <div>
      <div class="brand-name">CMDB</div>
      <div class="brand-sub">Enterprise Platform</div>
    </div>
  </div>
  <div class="report-info">
    <div class="report-title">${title}</div>
    <div class="report-subtitle">${subtitle}</div>
    <div class="report-date">Generado el ${dateStr}</div>
  </div>
</div>

${bodyContent}

<div class="report-footer">
  <span>CMDB Enterprise Platform &mdash; Documento Confidencial</span>
  <span>${title} &bull; ${now.getFullYear()}</span>
</div>

<script>
  (function () {
    function doPrint() { setTimeout(function () { window.print(); }, 280); }
    if (document.readyState === 'complete') { doPrint(); }
    else { window.addEventListener('load', doPrint); }
  })();
</script>
</body>
</html>`;
}
