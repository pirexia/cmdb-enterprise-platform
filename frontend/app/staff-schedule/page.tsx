"use client";

import { useCallback, useState } from "react";
import { RefreshCw, AlertTriangle, Settings, Copy, Download, CheckCircle2, Lock, Unlock, FileDown } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { useDepartments, useSchedule, useScheduleExport, useDepartmentConfig, mondayOf } from "./hooks/useStaffSchedule";
import type { EntryUpdateInput } from "./types";
import WeekSelector from "@/components/staff-schedule/WeekSelector";
import DepartmentFilter from "@/components/staff-schedule/DepartmentFilter";
import StaffScheduleCalendar from "@/components/staff-schedule/StaffScheduleCalendar";
import AlertPanel from "@/components/staff-schedule/AlertPanel";
import ScheduleConfigPanel from "@/components/staff-schedule/ScheduleConfigPanel";
import WeekTargetPicker from "@/components/staff-schedule/WeekTargetPicker";
import AllDepartmentsView from "@/components/staff-schedule/AllDepartmentsView";
import { displayLabel } from "@/lib/displayLabel";

export default function StaffSchedulePage() {
  const { t } = useLanguage();
  const { isAdmin } = useAuth();

  const [departmentId, setDepartmentId] = useState<string | null>(null);
  const [weekStart, setWeekStart] = useState(() => mondayOf(new Date()));
  const [showConfig, setShowConfig] = useState(false);
  const [showClonePicker, setShowClonePicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const { departments, loading: deptLoading, refetch: refetchDepartments } = useDepartments();
  const { config: departmentConfig } = useDepartmentConfig(departmentId);
  const {
    view,
    loading,
    error,
    notFound,
    createSchedule,
    saveEntries,
    validate,
    publish,
    unpublish,
    clone,
    importPreviousWeek,
  } = useSchedule(departmentId, weekStart);
  const { exportSchedule } = useScheduleExport();

  const usernameByUserId = Object.fromEntries((view?.rows ?? []).map((r) => [r.userId, displayLabel(r)]));

  const runAction = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "error");
    } finally {
      setBusy(false);
    }
  }, []);

  const handleSaveEntry = async (entry: EntryUpdateInput) => {
    await saveEntries([entry]);
  };

  const handleClone = () => setShowClonePicker(true);

  const handleCloneConfirm = (targetWeekStart: string) => runAction(async () => {
    await clone(targetWeekStart);
  });

  const handleImportPreviousWeek = () => runAction(importPreviousWeek);

  const canEdit = !!view?.canEdit;
  const status = view?.schedule.status;

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white px-8 py-5">
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div>
            <h1 className="text-xl font-bold text-slate-900">{t("staffSchedule.title")}</h1>
            <p className="text-sm text-slate-500 mt-0.5">{t("staffSchedule.subtitle")}</p>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {view && (
              <>
                {canEdit && status === "DRAFT" && (
                  <>
                    <button
                      onClick={() => runAction(validate)}
                      disabled={busy}
                      className="rounded-none border border-slate-300 bg-white px-3 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-50 flex items-center gap-1.5 disabled:opacity-50"
                    >
                      <CheckCircle2 className="h-4 w-4" /> {t("staffSchedule.action.validate")}
                    </button>
                    <button
                      onClick={() => runAction(publish)}
                      disabled={busy}
                      className="rounded-none bg-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[var(--accent)]/90 shadow-sm flex items-center gap-1.5 disabled:opacity-50"
                    >
                      <Lock className="h-4 w-4" /> {t("staffSchedule.action.publish")}
                    </button>
                  </>
                )}
                {isAdmin && status === "PUBLISHED" && (
                  <button
                    onClick={() => runAction(unpublish)}
                    disabled={busy}
                    className="rounded-none border border-slate-300 bg-white px-3 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-50 flex items-center gap-1.5 disabled:opacity-50"
                  >
                    <Unlock className="h-4 w-4" /> {t("staffSchedule.action.unpublish")}
                  </button>
                )}
                {canEdit && (
                  <button
                    onClick={handleClone}
                    disabled={busy}
                    className="rounded-none border border-slate-300 bg-white px-3 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-50 flex items-center gap-1.5 disabled:opacity-50"
                  >
                    <Copy className="h-4 w-4" /> {t("staffSchedule.action.clone")}
                  </button>
                )}
                <div className="relative group">
                  <button className="rounded-none border border-slate-300 bg-white px-3 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-50 flex items-center gap-1.5">
                    <Download className="h-4 w-4" /> {t("staffSchedule.action.export")}
                  </button>
                  <div className="absolute right-0 z-20 hidden group-hover:block bg-white shadow-sm ring-1 ring-slate-200 min-w-[8rem]">
                    <button
                      onClick={() => exportSchedule(view.schedule.id, "csv")}
                      className="block w-full text-left px-3 py-2 text-xs text-slate-600 hover:bg-slate-50"
                    >
                      CSV
                    </button>
                    <button
                      onClick={() => exportSchedule(view.schedule.id, "xlsx")}
                      className="block w-full text-left px-3 py-2 text-xs text-slate-600 hover:bg-slate-50"
                    >
                      XLSX
                    </button>
                  </div>
                </div>
              </>
            )}
            {isAdmin && (
              <button
                onClick={() => setShowConfig(true)}
                className="rounded-none border border-slate-300 bg-white px-3 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-50 flex items-center gap-1.5"
              >
                <Settings className="h-4 w-4" /> {t("staffSchedule.action.configure")}
              </button>
            )}
          </div>
        </div>
      </header>

      <div className="px-8 py-8 space-y-8 w-full">
        <div className="flex items-center justify-between flex-wrap gap-4 bg-white shadow-sm ring-1 ring-slate-200 px-4 py-3">
          <DepartmentFilter departments={departments} value={departmentId} onChange={setDepartmentId} />
          <WeekSelector weekStart={weekStart} onChange={setWeekStart} />
        </div>

        {status === "DRAFT" && !canEdit && (
          <p className="text-xs text-amber-700 bg-amber-50 border-l-4 border-amber-400 px-3 py-2">
            {t("staffSchedule.canEdit.readonly")}
          </p>
        )}

        {actionError && (
          <div className="flex items-center gap-2 bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {actionError.toLowerCase().includes("cannot publish") ? t("staffSchedule.publish.blockedByErrors") : actionError}
          </div>
        )}

        {!departmentId && (
          <AllDepartmentsView weekStart={weekStart} />
        )}

        {departmentId && (loading || deptLoading) && (
          <div className="bg-white shadow-sm ring-1 ring-slate-200 p-8 flex items-center gap-3 text-slate-500 text-sm">
            <RefreshCw className="h-4 w-4 animate-spin" />
            {t("common.loading")}
          </div>
        )}

        {departmentId && error && (
          <div className="flex items-center gap-2 bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {t("common.unknown_error")}
          </div>
        )}

        {departmentId && !loading && notFound && (
          <div className="bg-white shadow-sm ring-1 ring-slate-200 p-8 text-center space-y-3">
            <p className="text-sm text-slate-500">{t("staffSchedule.empty.noSchedule")}</p>
            <div className="flex items-center justify-center gap-2">
              <button
                onClick={() => runAction(createSchedule)}
                disabled={busy}
                className="rounded-none bg-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[var(--accent)]/90 shadow-sm disabled:opacity-50"
              >
                {t("staffSchedule.empty.createSchedule")}
              </button>
              <button
                onClick={handleImportPreviousWeek}
                disabled={busy}
                className="rounded-none border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-50 flex items-center gap-1.5 disabled:opacity-50"
              >
                <FileDown className="h-4 w-4" /> {t("staffSchedule.empty.importPreviousWeek")}
              </button>
            </div>
          </div>
        )}

        {view && (
          <div className="grid grid-cols-1 xl:grid-cols-[1fr_20rem] gap-6 items-start">
            <StaffScheduleCalendar
              view={view}
              departmentConfig={departmentConfig}
              onSaveEntry={handleSaveEntry}
              onSaveEntries={saveEntries}
            />
            <AlertPanel
              alerts={view.alerts}
              canEdit={canEdit && status === "DRAFT"}
              onRevalidate={() => runAction(validate)}
              revalidating={busy}
              usernameByUserId={usernameByUserId}
            />
          </div>
        )}
      </div>

      {showConfig && (
        <ScheduleConfigPanel
          departments={departments}
          onClose={() => setShowConfig(false)}
          onDepartmentsChanged={refetchDepartments}
        />
      )}
      {showClonePicker && (
        <WeekTargetPicker
          onClose={() => setShowClonePicker(false)}
          onConfirm={handleCloneConfirm}
        />
      )}
    </div>
  );
}
