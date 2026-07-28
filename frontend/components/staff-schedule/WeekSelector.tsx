"use client";

import PeriodSelector from "@/components/staff-schedule/PeriodSelector";

interface Props {
  weekStart: string;
  onChange: (weekStart: string) => void;
}

// Thin wrapper kept for existing callers (see page.tsx) — behavior is
// byte-for-byte identical to the pre-F2 implementation, now generalized
// into PeriodSelector's mode="week" branch (R6).
export default function WeekSelector({ weekStart, onChange }: Props) {
  return <PeriodSelector mode="week" weekStart={weekStart} onWeekChange={onChange} />;
}
