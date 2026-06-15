import type { AlertItem, AlertCategory, ScanResult, AlertLocale } from './schemas.js';

// ── i18n strings (inline — no runtime file I/O) ───────────────────────────────

const STRINGS: Record<AlertLocale, Record<string, string>> = {
  es: {
    title:         'CMDB Enterprise Platform',
    subtitle:      'Informe de Alertas Proactivas',
    generated:     'Generado',
    summary:       'Se han detectado {n} alerta(s) que requieren atención',
    all_clear:     '¡Todo en orden!',
    all_clear_sub: 'No se han detectado alertas activas.',
    automated:     'Este informe ha sido generado automáticamente.',
    category_eol:         'Fin de Vida (EOL)',
    category_eos:         'Fin de Soporte (EOS)',
    category_warranty:    'Garantía',
    category_maintenance: 'Mantenimiento',
    category_contract:    'Contratos',
    category_vulnerability: 'Vulnerabilidades Abiertas',
    category_license:     'Licencias',
    col_name:      'Nombre',
    col_date:      'Fecha',
    col_days:      'Días',
    col_status:    'Estado',
    col_vendor:    'Proveedor',
    col_detail:    'Detalle',
    sev_expired:   'VENCIDO',
    sev_critical:  'CRÍTICO',
    sev_warning:   'PRÓXIMO',
    sev_open:      'ABIERTO',
    from_model:    '(del modelo)',
  },
  en: {
    title:         'CMDB Enterprise Platform',
    subtitle:      'Proactive Alerts Report',
    generated:     'Generated',
    summary:       '{n} alert(s) require attention',
    all_clear:     'All clear!',
    all_clear_sub: 'No active alerts detected.',
    automated:     'This report was generated automatically.',
    category_eol:         'End of Life (EOL)',
    category_eos:         'End of Support (EOS)',
    category_warranty:    'Warranty',
    category_maintenance: 'Maintenance',
    category_contract:    'Contracts',
    category_vulnerability: 'Open Vulnerabilities',
    category_license:     'Licenses',
    col_name:      'Name',
    col_date:      'Date',
    col_days:      'Days',
    col_status:    'Status',
    col_vendor:    'Vendor',
    col_detail:    'Detail',
    sev_expired:   'EXPIRED',
    sev_critical:  'CRITICAL',
    sev_warning:   'UPCOMING',
    sev_open:      'OPEN',
    from_model:    '(from model)',
  },
  de: {
    title:         'CMDB Enterprise Platform',
    subtitle:      'Proaktiver Alarmbericht',
    generated:     'Erstellt',
    summary:       '{n} Alarm/Alarme erfordern Aufmerksamkeit',
    all_clear:     'Alles in Ordnung!',
    all_clear_sub: 'Keine aktiven Alarme erkannt.',
    automated:     'Dieser Bericht wurde automatisch erstellt.',
    category_eol:         'End of Life (EOL)',
    category_eos:         'End of Support (EOS)',
    category_warranty:    'Garantie',
    category_maintenance: 'Wartung',
    category_contract:    'Verträge',
    category_vulnerability: 'Offene Schwachstellen',
    category_license:     'Lizenzen',
    col_name:      'Name',
    col_date:      'Datum',
    col_days:      'Tage',
    col_status:    'Status',
    col_vendor:    'Anbieter',
    col_detail:    'Detail',
    sev_expired:   'ABGELAUFEN',
    sev_critical:  'KRITISCH',
    sev_warning:   'BEVORSTEHEND',
    sev_open:      'OFFEN',
    from_model:    '(vom Modell)',
  },
  pt: {
    title:         'CMDB Enterprise Platform',
    subtitle:      'Relatório de Alertas Proativos',
    generated:     'Gerado',
    summary:       '{n} alerta(s) requerem atenção',
    all_clear:     'Tudo em ordem!',
    all_clear_sub: 'Nenhum alerta ativo detectado.',
    automated:     'Este relatório foi gerado automaticamente.',
    category_eol:         'Fim de Vida (EOL)',
    category_eos:         'Fim de Suporte (EOS)',
    category_warranty:    'Garantia',
    category_maintenance: 'Manutenção',
    category_contract:    'Contratos',
    category_vulnerability: 'Vulnerabilidades Abertas',
    category_license:     'Licenças',
    col_name:      'Nome',
    col_date:      'Data',
    col_days:      'Dias',
    col_status:    'Estado',
    col_vendor:    'Fornecedor',
    col_detail:    'Detalhe',
    sev_expired:   'EXPIRADO',
    sev_critical:  'CRÍTICO',
    sev_warning:   'PRÓXIMO',
    sev_open:      'ABERTO',
    from_model:    '(do modelo)',
  },
  fr: {
    title:         'CMDB Enterprise Platform',
    subtitle:      'Rapport d\'alertes proactives',
    generated:     'Généré',
    summary:       '{n} alerte(s) nécessitent attention',
    all_clear:     'Tout est en ordre !',
    all_clear_sub: 'Aucune alerte active détectée.',
    automated:     'Ce rapport a été généré automatiquement.',
    category_eol:         'Fin de vie (EOL)',
    category_eos:         'Fin de support (EOS)',
    category_warranty:    'Garantie',
    category_maintenance: 'Maintenance',
    category_contract:    'Contrats',
    category_vulnerability: 'Vulnérabilités ouvertes',
    category_license:     'Licences',
    col_name:      'Nom',
    col_date:      'Date',
    col_days:      'Jours',
    col_status:    'Statut',
    col_vendor:    'Fournisseur',
    col_detail:    'Détail',
    sev_expired:   'EXPIRÉ',
    sev_critical:  'CRITIQUE',
    sev_warning:   'PROCHAIN',
    sev_open:      'OUVERT',
    from_model:    '(du modèle)',
  },
  it: {
    title:         'CMDB Enterprise Platform',
    subtitle:      'Report Avvisi Proattivi',
    generated:     'Generato',
    summary:       '{n} avviso/i richiedono attenzione',
    all_clear:     'Tutto in ordine!',
    all_clear_sub: 'Nessun avviso attivo rilevato.',
    automated:     'Questo report è stato generato automaticamente.',
    category_eol:         'Fine vita (EOL)',
    category_eos:         'Fine supporto (EOS)',
    category_warranty:    'Garanzia',
    category_maintenance: 'Manutenzione',
    category_contract:    'Contratti',
    category_vulnerability: 'Vulnerabilità aperte',
    category_license:     'Licenze',
    col_name:      'Nome',
    col_date:      'Data',
    col_days:      'Giorni',
    col_status:    'Stato',
    col_vendor:    'Fornitore',
    col_detail:    'Dettaglio',
    sev_expired:   'SCADUTO',
    sev_critical:  'CRITICO',
    sev_warning:   'IMMINENTE',
    sev_open:      'APERTO',
    from_model:    '(dal modello)',
  },
};

// ── Helpers ────────────────────────────────────────────────────────────────────

function htmlEscape(str: string): string {
  return str
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#39;');
}

function fmtDate(d: Date | null, locale: AlertLocale): string {
  if (!d) return '—';
  const lcMap: Record<AlertLocale, string> = {
    es: 'es-ES', en: 'en-GB', de: 'de-DE', pt: 'pt-PT', fr: 'fr-FR', it: 'it-IT',
  };
  return d.toLocaleDateString(lcMap[locale], { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function severityStyle(sev: string): string {
  const map: Record<string, string> = {
    expired:  'background:#dc2626;color:#fff;',
    critical: 'background:#ea580c;color:#fff;',
    warning:  'background:#d97706;color:#fff;',
    open:     'background:#7c3aed;color:#fff;',
  };
  return map[sev] ?? map['warning'];
}

function severityLabel(sev: string, s: Record<string, string>): string {
  const map: Record<string, string> = {
    expired:  s['sev_expired'],
    critical: s['sev_critical'],
    warning:  s['sev_warning'],
    open:     s['sev_open'],
  };
  return map[sev] ?? sev.toUpperCase();
}

function badge(sev: string, s: Record<string, string>): string {
  return `<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700;${severityStyle(sev)}">${htmlEscape(severityLabel(sev, s))}</span>`;
}

function categoryIcon(cat: AlertCategory): string {
  const icons: Record<AlertCategory, string> = {
    eol: '🗓️', eos: '⏳', warranty: '🛡️', maintenance: '🔧',
    contract: '📄', vulnerability: '⚠️', license: '🔑',
  };
  return icons[cat] ?? '📌';
}

function categoryColor(cat: AlertCategory): string {
  const colors: Record<AlertCategory, string> = {
    eol: '#f59e0b', eos: '#fb923c', warranty: '#10b981', maintenance: '#06b6d4',
    contract: '#3b82f6', vulnerability: '#dc2626', license: '#8b5cf6',
  };
  return colors[cat] ?? '#64748b';
}

// ── Section builder ─────────────────────────────────────────────────────────

function buildSection(
  cat:   AlertCategory,
  items: AlertItem[],
  s:     Record<string, string>,
  locale: AlertLocale,
): string {
  if (items.length === 0) return '';

  const color   = categoryColor(cat);
  const icon    = categoryIcon(cat);
  const catLabel = s[`category_${cat}`] ?? cat;

  const rows = items.map((item, i) => {
    const bg = i % 2 === 0 ? '#ffffff' : '#f8fafc';

    if (cat === 'vulnerability') {
      const parts = item.detail.split(',');
      const crit  = parts.find((p) => p.startsWith('critical:'))?.split(':')[1] ?? '0';
      const high  = parts.find((p) => p.startsWith('high:'))?.split(':')[1] ?? '0';
      return `
      <tr style="background:${bg};">
        <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;font-weight:600;color:#1e293b;">${htmlEscape(item.entityName)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;text-align:center;">
          ${parseInt(crit) > 0 ? `<span style="background:#dc2626;color:#fff;padding:2px 10px;border-radius:12px;font-weight:700;">${htmlEscape(crit)}</span>` : '<span style="color:#94a3b8;">—</span>'}
        </td>
        <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;text-align:center;">
          ${parseInt(high) > 0 ? `<span style="background:#ea580c;color:#fff;padding:2px 10px;border-radius:12px;font-weight:700;">${htmlEscape(high)}</span>` : '<span style="color:#94a3b8;">—</span>'}
        </td>
      </tr>`;
    }

    const dateStr = fmtDate(item.dateValue, locale);
    const daysStr = item.daysLeft !== null
      ? (item.daysLeft <= 0 ? s['sev_expired'] : `${item.daysLeft}d`)
      : '—';
    const daysColor = item.daysLeft !== null && item.daysLeft <= 0 ? '#dc2626'
      : item.daysLeft !== null && item.daysLeft <= 7 ? '#ea580c' : '#d97706';

    const detailCell = cat === 'contract'
      ? `<td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;color:#475569;">${htmlEscape(item.detail)}</td>`
      : (item.detail === 'from_model'
          ? `<td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;"><span style="background:#e2e8f0;color:#64748b;padding:1px 6px;border-radius:4px;font-size:11px;">${htmlEscape(s['from_model'])}</span></td>`
          : '');

    const showDetail = cat === 'contract' || item.detail === 'from_model';

    return `
    <tr style="background:${bg};">
      <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;font-weight:600;color:#1e293b;">${htmlEscape(item.entityName)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;color:#475569;">${htmlEscape(dateStr)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;color:${daysColor};font-weight:700;">${htmlEscape(daysStr)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;">${badge(item.severity, s)}</td>
      ${showDetail ? detailCell : ''}
    </tr>`;
  }).join('');

  const vulnHeader = cat === 'vulnerability' ? `
    <th style="text-align:center;padding:8px 12px;border-bottom:2px solid #e2e8f0;color:#64748b;">🔴 CRITICAL</th>
    <th style="text-align:center;padding:8px 12px;border-bottom:2px solid #e2e8f0;color:#64748b;">🟠 HIGH</th>` : `
    <th style="text-align:left;padding:8px 12px;border-bottom:2px solid #e2e8f0;color:#64748b;">${htmlEscape(s['col_date'])}</th>
    <th style="text-align:left;padding:8px 12px;border-bottom:2px solid #e2e8f0;color:#64748b;">${htmlEscape(s['col_days'])}</th>
    <th style="text-align:left;padding:8px 12px;border-bottom:2px solid #e2e8f0;color:#64748b;">${htmlEscape(s['col_status'])}</th>
    ${cat === 'contract' ? `<th style="text-align:left;padding:8px 12px;border-bottom:2px solid #e2e8f0;color:#64748b;">${htmlEscape(s['col_vendor'])}</th>` : ''}`;

  return `
  <h2 style="color:#1e293b;font-size:16px;border-left:4px solid ${color};padding-left:12px;margin-top:32px;">
    ${icon} ${htmlEscape(catLabel)} (${items.length})
  </h2>
  <table style="width:100%;border-collapse:collapse;font-size:13px;">
    <thead>
      <tr style="background:#f8fafc;">
        <th style="text-align:left;padding:8px 12px;border-bottom:2px solid #e2e8f0;color:#64748b;">${htmlEscape(s['col_name'])}</th>
        ${vulnHeader}
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;
}

// ── Public builder ─────────────────────────────────────────────────────────────

export function buildAlertHtml(result: ScanResult, locale: AlertLocale = 'es'): string {
  const s       = STRINGS[locale] ?? STRINGS['es'];
  const total   = result.items.length;
  const dateStr = result.scannedAt.toLocaleString(
    locale === 'es' ? 'es-ES' : locale === 'en' ? 'en-GB' : `${locale}-${locale.toUpperCase()}`,
    { day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' },
  );

  if (total === 0) {
    return `<!DOCTYPE html><html lang="${locale}"><head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;background:#f1f5f9;padding:32px;margin:0;">
  <div style="max-width:640px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 6px rgba(0,0,0,.1);">
    <div style="background:#16a34a;padding:24px 32px;">
      <h1 style="color:#fff;margin:0;font-size:20px;">✅ ${htmlEscape(s['title'])}</h1>
      <p style="color:#bbf7d0;margin:4px 0 0;font-size:13px;">${htmlEscape(s['subtitle'])} · ${htmlEscape(dateStr)}</p>
    </div>
    <div style="padding:40px 32px;text-align:center;">
      <div style="font-size:56px;margin-bottom:16px;">🎉</div>
      <h2 style="color:#16a34a;font-size:22px;margin-bottom:8px;">${htmlEscape(s['all_clear'])}</h2>
      <p style="color:#475569;">${htmlEscape(s['all_clear_sub'])}</p>
    </div>
    <div style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:16px 32px;text-align:center;">
      <p style="color:#94a3b8;font-size:11px;margin:0;">${htmlEscape(s['automated'])}</p>
    </div>
  </div>
</body></html>`;
  }

  const ORDER: AlertCategory[] = ['vulnerability', 'eol', 'eos', 'contract', 'warranty', 'maintenance', 'license'];
  const byCategory = Object.fromEntries(
    ORDER.map((cat) => [cat, result.items.filter((i) => i.category === cat)]),
  );

  const summaryParts = ORDER
    .filter((cat) => (byCategory[cat]?.length ?? 0) > 0)
    .map((cat) => `${categoryIcon(cat)} ${byCategory[cat].length} ${htmlEscape(s[`category_${cat}`] ?? cat)}`)
    .join(' &nbsp;·&nbsp; ');

  const sections = ORDER.map((cat) =>
    buildSection(cat, byCategory[cat] ?? [], s, locale),
  ).join('');

  return `<!DOCTYPE html>
<html lang="${locale}">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="font-family:Arial,sans-serif;background:#f1f5f9;padding:32px;margin:0;">
  <div style="max-width:720px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,.12);">

    <div style="background:linear-gradient(135deg,#1e3a5f 0%,#2563eb 100%);padding:28px 32px;">
      <table style="width:100%;border-collapse:collapse;"><tr>
        <td>
          <h1 style="color:#fff;margin:0;font-size:20px;font-weight:700;">🛡️ ${htmlEscape(s['title'])}</h1>
          <p style="color:#93c5fd;margin:4px 0 0;font-size:13px;">${htmlEscape(s['subtitle'])}</p>
        </td>
        <td style="text-align:right;white-space:nowrap;">
          <div style="background:rgba(255,255,255,.15);border-radius:8px;padding:10px 16px;display:inline-block;">
            <p style="color:#e0f2fe;margin:0;font-size:11px;text-transform:uppercase;letter-spacing:1px;">${htmlEscape(s['generated'])}</p>
            <p style="color:#fff;margin:2px 0 0;font-size:12px;font-weight:600;">${htmlEscape(dateStr)}</p>
          </div>
        </td>
      </tr></table>
    </div>

    <div style="background:#fef3c7;border-bottom:3px solid #f59e0b;padding:16px 32px;">
      <p style="margin:0;color:#92400e;font-size:14px;font-weight:600;">
        ⚠️ ${htmlEscape(s['summary'].replace('{n}', String(total)))}
        &nbsp;— ${summaryParts}
      </p>
    </div>

    <div style="padding:24px 32px 40px;">${sections}</div>

    <div style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:16px 32px;text-align:center;">
      <p style="color:#94a3b8;font-size:11px;margin:0;">${htmlEscape(s['automated'])}</p>
      <p style="color:#cbd5e1;font-size:10px;margin:4px 0 0;">CMDB Enterprise Platform · ISO 27001</p>
    </div>
  </div>
</body></html>`;
}
