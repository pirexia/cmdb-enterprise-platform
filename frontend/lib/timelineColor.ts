export type ColorBand = 'green' | 'yellow' | 'red' | 'expired' | 'inactive' | 'none';

export interface ColorTokens {
  fill: string;
  stroke: string;
  text: string;
  bg: string;       // Tailwind bg class for badges
  badge: string;    // Tailwind text class for badges
}

const TOKENS: Record<ColorBand, ColorTokens> = {
  green:    { fill: '#16a34a', stroke: '#15803d', text: '#fff', bg: 'bg-emerald-100', badge: 'text-emerald-700' },
  yellow:   { fill: '#ca8a04', stroke: '#a16207', text: '#fff', bg: 'bg-yellow-100',  badge: 'text-yellow-700'  },
  red:      { fill: '#dc2626', stroke: '#b91c1c', text: '#fff', bg: 'bg-red-100',     badge: 'text-red-700'     },
  expired:  { fill: '#475569', stroke: '#334155', text: '#fff', bg: 'bg-slate-200',   badge: 'text-slate-600'   },
  inactive: { fill: '#94a3b8', stroke: '#cbd5e1', text: '#334155', bg: 'bg-slate-100', badge: 'text-slate-400'  },
  none:     { fill: '#3b82f6', stroke: '#2563eb', text: '#fff', bg: 'bg-blue-100',    badge: 'text-blue-700'    },
};

export function getColorBand(
  endDate: string | undefined,
  status?: string | null,
): ColorBand {
  const inactiveStatuses = ['INACTIVO', 'RETIRADO'];
  if (status && inactiveStatuses.includes(status)) return 'inactive';
  if (!endDate) return 'none';
  const msLeft = new Date(endDate).getTime() - Date.now();
  const daysLeft = msLeft / 86_400_000;
  if (daysLeft < 0)  return 'expired';
  if (daysLeft < 15) return 'red';
  if (daysLeft < 30) return 'yellow';
  return 'green';
}

export function getTokens(band: ColorBand): ColorTokens {
  return TOKENS[band];
}

export function getBandFromItem(item: {
  endDate?: string;
  status?: string;
  milestones: { date: string }[];
}): ColorBand {
  // If there's an endDate, use it
  if (item.endDate) return getColorBand(item.endDate, item.status);

  // Otherwise use the nearest future milestone date
  const nearest = item.milestones
    .map(m => m.date)
    .sort()
    .find(d => new Date(d) >= new Date());

  return getColorBand(nearest, item.status);
}
