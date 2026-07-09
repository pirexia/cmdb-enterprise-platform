"use client";

import { useLanguage } from "@/contexts/LanguageContext";
import type { Department } from "@/app/staff-schedule/types";

interface Props {
  departments: Department[];
  value: string | null;
  onChange: (departmentId: string | null) => void;
}

export default function DepartmentFilter({ departments, value, onChange }: Props) {
  const { t } = useLanguage();

  return (
    <div className="flex items-center gap-2">
      <label className="text-xs font-medium text-slate-600">{t("staffSchedule.filter.department")}</label>
      <select
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
        className="rounded-none border border-slate-300 px-2.5 py-2 text-sm min-w-[12rem]"
      >
        <option value="">{t("staffSchedule.filter.allDepartments")}</option>
        {departments.map((d) => (
          <option key={d.id} value={d.id}>
            {d.name}
          </option>
        ))}
      </select>
    </div>
  );
}
