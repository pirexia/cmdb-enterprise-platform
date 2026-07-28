// Shared frontend types for the Staff Schedule module (v3.5.0).
// Mirrors backend/src/modules/staff-schedule/{schemas.ts,service.ts} shapes —
// do not invent fields the server doesn't send.

export const SCHEDULE_STATUS = [
  "PRESENCIAL",
  "TELETRABAJO",
  "VACACIONES",
  "BAJA_MEDICA",
  "BAJA_PATERNIDAD",
  "INTENSIVO",
  "INTENSIVO_TELETRABAJO",
  "VIAJE",
  "AUSENTE",
] as const;
export type ScheduleStatus = (typeof SCHEDULE_STATUS)[number];

export const ALERT_TYPE = [
  "TELEWORK_QUOTA",
  "WEEKLY_HOURS",
  "DAILY_HOURS",
  "PRESENCE_PCT",
  "FLEX_RANGE",
  "GUARDIA_COVERAGE",
  "GUARDIA_UNIQUE",
  "BAJA_CONFLICT",
] as const;
export type AlertType = (typeof ALERT_TYPE)[number];

export type AlertSeverity = "WARNING" | "ERROR";
export type ScheduleState = "DRAFT" | "PUBLISHED";

export interface Department {
  id: string;
  name: string;
  code: string;
  serviceStart: string;
  serviceEnd: string;
  presenceStart: string;
  presenceEnd: string;
  minPresencePct: number;
}

export interface DepartmentScheduleConfig {
  id: string;
  departmentId: string;
  winterDailyNetHours: number;
  winterMaxDailyNetHours: number;
  winterBreakMinutes: number;
  winterFridayNetHours: number;
  summerDailyNetHours: number;
  summerMaxDailyNetHours: number;
  summerBreakMinutes: number;
  summerFridayNetHours: number;
  weeklyTargetNetHours: number;
  monthlyTeleworkCap: number;
  flexEntryStart: string;
  flexEntryEnd: string;
  flexExitStart: string;
  flexExitEnd: string;
}

export interface SummerSchedule {
  id: string;
  year: number;
  startDate: string;
  endDate: string;
}

export interface StaffScheduleListItem {
  id: string;
  departmentId: string;
  weekStart: string;
  weekEnd: string;
  status: ScheduleState;
  year: number;
  isSummerWeek: boolean;
  createdBy: string;
  department: { id: string; name: string };
}

export interface MaskedEntryFields {
  status: ScheduleStatus | string;
  onGuard: boolean;
  startTime: string | null;
  endTime: string | null;
  notes: string | null;
  healthMasked?: boolean;
}

export interface ScheduleRow {
  userId: string;
  username: string;
  displayName: string | null;
  entries: Record<string, MaskedEntryFields>;
  summary: {
    weeklyNetHours: number;
    weeklyTargetHours: number;
    teleworkDaysWeek: number;
    teleworkDaysMonth: number;
    travelDays: number;
    guardDays: number;
  };
}

export interface ScheduleAlertItem {
  id: string;
  type: AlertType | string;
  severity: AlertSeverity;
  message: string;
  userId: string | null;
  date: string | null;
  resolved: boolean;
}

export interface ScheduleView {
  schedule: {
    id: string;
    departmentId: string;
    weekStart: string;
    weekEnd: string;
    status: ScheduleState;
    year: number;
    isSummerWeek: boolean;
  };
  days: string[];
  rows: ScheduleRow[];
  alerts: ScheduleAlertItem[];
  canEdit: boolean;
}

export interface EntryUpdateInput {
  userId: string;
  date: string;
  status: ScheduleStatus;
  onGuard?: boolean;
  startTime?: string | null;
  endTime?: string | null;
  notes?: string | null;
}

export interface SimpleUser {
  id: string;
  username: string;
  displayName?: string | null;
  email: string;
  role: string;
}

// v3.5.10 refinamiento — GET /departments/:id/managers y .../members.
export interface DepartmentManagerInfo {
  id: string;
  username: string;
  displayName: string | null;
  email: string;
}

export interface DepartmentMemberInfo {
  id: string;
  username: string;
  displayName: string | null;
  email: string;
  weeklyTargetHours: number | null;
  // v3.5.11 — override de cuota de teletrabajo (total / días / porcentaje).
  teleworkFull: boolean;
  teleworkQuotaDays: number | null;
  teleworkQuotaPct: number | null;
}

// v3.5.12 (R5/F4) — GET /api/staff-schedule/users?q=. Deliberately no email
// (GDPR Art. 5.1.c minimisation — the search box doesn't need it, D4).
export interface WorkerSearchResult {
  id: string;
  username: string;
  displayName: string | null;
}

// v3.5.12 (R5/F4) — one day of GET /user/:userId/entries?from=&to=. Already
// masked server-side (maskEntryForViewer) before it reaches the client —
// `entry` has the same shape a viewer would get from a ScheduleRow.
// `weeklyTargetHours` is present only when the viewer is authorized to see
// the summary for that day's department (mirrors the R2 omission pattern —
// nothing to hide client-side, the field simply isn't sent).
export interface WorkerEntryItem {
  date: string;
  departmentName: string;
  entry: MaskedEntryFields;
  weeklyTargetHours?: number;
}

// v3.5.12 (R5/F4) — GET /user/:userId/monthly?year=&month= (endpoint already
// live since before this version). `healthLeaveDays` is omitted, not
// zeroed, for viewers who are neither ADMIN nor the user themselves (Art. 9).
export interface WorkerMonthlySummary {
  userId: string;
  year: number;
  month: number;
  netHours: number;
  teleworkDays: number;
  travelDays: number;
  guardDays: number;
  vacationDays: number;
  healthLeaveDays?: number;
}
