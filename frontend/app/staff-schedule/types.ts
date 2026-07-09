// Shared frontend types for the Staff Schedule module (v3.5.0).
// Mirrors backend/src/modules/staff-schedule/{schemas.ts,service.ts} shapes —
// do not invent fields the server doesn't send.

export const SCHEDULE_STATUS = [
  "PRESENCIAL",
  "TELETRABAJO",
  "VACACIONES",
  "BAJA_MEDICA",
  "BAJA_PATERNIDAD",
  "GUARDIA",
  "INTENSIVO",
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
  startTime: string | null;
  endTime: string | null;
  notes: string | null;
  healthMasked?: boolean;
}

export interface ScheduleRow {
  userId: string;
  username: string;
  entries: Record<string, MaskedEntryFields>;
  summary: {
    weeklyNetHours: number;
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
  startTime?: string | null;
  endTime?: string | null;
  notes?: string | null;
}

export interface SimpleUser {
  id: string;
  username: string;
  email: string;
  role: string;
}
