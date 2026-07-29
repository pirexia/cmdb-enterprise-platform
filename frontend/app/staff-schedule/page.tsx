"use client";

import { useCallback, useMemo, useState } from "react";
import { RefreshCw, AlertTriangle, Settings, Copy, Download, CheckCircle2, Lock, Unlock, FileDown, Users, Trash2 } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { useDepartments, useSchedule, useScheduleExport, useDepartmentConfig, mondayOf, addDaysIso, isoWeekNumber, usePrintPageOrientation } from "./hooks/useStaffSchedule";
import type { EntryUpdateInput } from "./types";
import PeriodSelector from "@/components/staff-schedule/PeriodSelector";
import DepartmentFilter from "@/components/staff-schedule/DepartmentFilter";
import WorkerFilter from "@/components/staff-schedule/WorkerFilter";
import StaffScheduleCalendar from "@/components/staff-schedule/StaffScheduleCalendar";
import AlertPanel from "@/components/staff-schedule/AlertPanel";
import ScheduleConfigPanel from "@/components/staff-schedule/ScheduleConfigPanel";
import WeekTargetPicker from "@/components/staff-schedule/WeekTargetPicker";
import AllDepartmentsView from "@/components/staff-schedule/AllDepartmentsView";
import DepartmentMonthView from "@/components/staff-schedule/DepartmentMonthView";
import WorkerScheduleView from "@/components/staff-schedule/WorkerScheduleView";
import PrintButton from "@/components/staff-schedule/PrintButton";
import PrintHeader from "@/components/staff-schedule/PrintHeader";
import { displayLabel } from "@/lib/displayLabel";

type PeriodMode = "week" | "month";

export default function StaffSchedulePage() {
  const { t } = useLanguage();
  const { isAdmin } = useAuth();

  const [departmentId, setDepartmentId] = useState<string | null>(null);
  const [weekStart, setWeekStart] = useState(() => mondayOf(new Date()));
  const [periodMode, setPeriodMode] = useState<PeriodMode>("week");
  const [monthYear, setMonthYear] = useState(() => new Date().getUTCFullYear());
  const [monthNum, setMonthNum] = useState(() => new Date().getUTCMonth() + 1);
  const [worker, setWorker] = useState<{ userId: string; label: string } | null>(null);
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
    syncMembers,
    deleteSchedule,
  } = useSchedule(departmentId, weekStart);
  const { exportSchedule } = useScheduleExport();

  const usernameByUserId = Object.fromEntries((view?.rows ?? []).map((r) => [r.userId, displayLabel(r)]));

  // v3.5.12 (R5/R6, decision D5) — exactly one view is active at a time.
  // Selecting a worker always wins over the department view, regardless of
  // periodMode; department state (departmentId/periodMode/weekStart) is kept
  // around rather than cleared, so clearing the worker filter returns the
  // user to whatever department context they had before.
  const viewMode: "worker" | "department-month" | "department-week" = worker
    ? "worker"
    : periodMode === "month"
      ? "department-month"
      : "department-week";

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

  // v3.5.10 refinamiento, ampliado en v3.5.13 (D5) — cubre un horario vacío
  // (creado/clonado antes de que el departamento tuviera su membresía final),
  // un trabajador nuevo que se incorpora, y un trabajador retirado del
  // departamento (sus entradas se borran de este DRAFT).
  const [syncResult, setSyncResult] = useState<{ added: number; removed: number } | null>(null);
  const handleSyncMembers = () => runAction(async () => {
    const result = await syncMembers();
    setSyncResult(result);
  });

  const handleDeleteSchedule = () => runAction(async () => {
    if (!window.confirm(t("staffSchedule.confirm.deleteSchedule"))) return;
    await deleteSchedule();
  });

  const canEdit = !!view?.canEdit;
  const status = view?.schedule.status;

  // v3.5.12 (R3) — the alert panel is only useful while the schedule can
  // still change; once PUBLISHED, any remaining WARNINGs are informational
  // about a closed schedule, so the panel is hidden and the calendar takes
  // the full width (the xl:grid-cols split only applies while it's shown).
  const showAlertPanel = !!view && status === "DRAFT";

  const monthValue = `${monthYear}-${String(monthNum).padStart(2, "0")}`;
  const selectedDepartment = useMemo(
    () => departments.find((d) => d.id === departmentId) ?? null,
    [departments, departmentId],
  );

  // One orientation for the whole print job (see usePrintPageOrientation for
  // why mixing two @page sizes is not an option). Portrait for the two
  // reports that stack several narrow tables and want the fewest sheets —
  // "all departments" and the department month view; landscape for the wide
  // single-department week grid and the worker view.
  const printOrientation: "portrait" | "landscape" =
    viewMode === "department-month" || (viewMode === "department-week" && !departmentId)
      ? "portrait"
      : "landscape";
  usePrintPageOrientation(printOrientation);

  const printRangeLabel = periodMode === "month" ? monthValue : `${weekStart} – ${addDaysIso(weekStart, 4)}`;

  // Only a single week has a well-defined week number — the month view
  // shows several weeks, so it's omitted there.
  const printWeekLabel =
    periodMode === "week" ? (() => {
      const { week, year } = isoWeekNumber(weekStart);
      return t("staffSchedule.print.weekLabel", { week, year });
    })() : undefined;

  return (
    <div className="min-h-screen bg-slate-50">
      {/* z-40: must outrank the calendar table's own sticky elements — its
          thead is z-20 and its frozen first column z-30 — or those paint
          OVER this page header while scrolling (they live outside this
          header's stacking context, so the z-indexes compete directly).
          Stays below the module's modals/popovers at z-50. */}
      <header className="sticky top-0 z-40 border-b border-slate-200 bg-white px-8 py-5 no-print">
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div>
            <h1 className="text-xl font-bold text-slate-900">{t("staffSchedule.title")}</h1>
            <p className="text-sm text-slate-500 mt-0.5">{t("staffSchedule.subtitle")}</p>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {viewMode === "department-week" && view && (
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
                {/* v3.5.10 refinamiento — incorpora a un trabajador nuevo a un
                    horario ya planificado, sin tocar las entradas existentes. */}
                {canEdit && status === "DRAFT" && (
                  <button
                    onClick={handleSyncMembers}
                    disabled={busy}
                    title={t("staffSchedule.action.syncMembers")}
                    className="rounded-none border border-slate-300 bg-white px-3 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-50 flex items-center gap-1.5 disabled:opacity-50"
                  >
                    <Users className="h-4 w-4" /> {t("staffSchedule.action.syncMembers")}
                  </button>
                )}
                {canEdit && status === "DRAFT" && (
                  <button
                    onClick={handleDeleteSchedule}
                    disabled={busy}
                    title={t("staffSchedule.action.deleteSchedule")}
                    className="rounded-none border border-red-200 bg-white px-3 py-2.5 text-sm font-medium text-red-600 hover:bg-red-50 flex items-center gap-1.5 disabled:opacity-50"
                  >
                    <Trash2 className="h-4 w-4" />
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
            {/* v3.5.12 (R7) — printing is available in all three views; the
                target/scope/range fed to the audit-print endpoint changes
                with viewMode. */}
            {viewMode === "department-week" && view && (
              <PrintButton
                scope="DEPARTMENT_WEEK"
                targetId={view.schedule.departmentId}
                from={view.schedule.weekStart}
                to={view.schedule.weekEnd}
              />
            )}
            {viewMode === "department-month" && departmentId && (
              <PrintButton scope="DEPARTMENT_MONTH" targetId={departmentId} from={`${monthValue}-01`} to={monthValue} />
            )}
            {viewMode === "worker" && worker && (
              <PrintButton
                scope="WORKER"
                targetId={worker.userId}
                from={periodMode === "month" ? `${monthValue}-01` : weekStart}
                to={periodMode === "month" ? monthValue : weekStart}
              />
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
        <div className="flex items-center justify-between flex-wrap gap-4 bg-white shadow-sm ring-1 ring-slate-200 px-4 py-3 no-print">
          <div className="flex items-center gap-4 flex-wrap">
            <DepartmentFilter departments={departments} value={departmentId} onChange={setDepartmentId} />
            <WorkerFilter
              selectedLabel={worker?.label ?? null}
              onSelect={(userId, label) => setWorker({ userId, label })}
              onClear={() => setWorker(null)}
            />
            <div className="flex items-center gap-1 rounded-none border border-slate-300 overflow-hidden">
              <button
                type="button"
                onClick={() => setPeriodMode("week")}
                className={`px-3 py-2 text-xs font-medium ${periodMode === "week" ? "bg-[var(--accent)] text-white" : "bg-white text-slate-600 hover:bg-slate-50"}`}
              >
                {t("staffSchedule.periodSelector.weekMode")}
              </button>
              <button
                type="button"
                onClick={() => setPeriodMode("month")}
                className={`px-3 py-2 text-xs font-medium ${periodMode === "month" ? "bg-[var(--accent)] text-white" : "bg-white text-slate-600 hover:bg-slate-50"}`}
              >
                {t("staffSchedule.periodSelector.monthMode")}
              </button>
            </div>
          </div>

          {periodMode === "week" ? (
            <PeriodSelector mode="week" weekStart={weekStart} onWeekChange={setWeekStart} />
          ) : (
            <PeriodSelector
              mode="month"
              year={monthYear}
              month={monthNum}
              onMonthChange={(y, m) => {
                setMonthYear(y);
                setMonthNum(m);
              }}
            />
          )}
        </div>

        <PrintHeader
          title={t("staffSchedule.title")}
          weekLabel={printWeekLabel}
          subtitle={worker ? worker.label : selectedDepartment ? selectedDepartment.name : t("staffSchedule.filter.allDepartments")}
          rangeLabel={printRangeLabel}
        />

        {viewMode === "department-week" && status === "DRAFT" && !canEdit && (
          <p className="text-xs text-amber-700 bg-amber-50 border-l-4 border-amber-400 px-3 py-2 no-print">
            {t("staffSchedule.canEdit.readonly")}
          </p>
        )}

        {actionError && (
          <div className="flex items-center gap-2 bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700 no-print">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {actionError.toLowerCase().includes("cannot publish") ? t("staffSchedule.publish.blockedByErrors") : actionError}
          </div>
        )}

        {syncResult && (
          <div className="flex items-center gap-2 bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-700 no-print">
            <Users className="h-4 w-4 shrink-0" />
            {t("staffSchedule.syncMembers.result", { added: syncResult.added, removed: syncResult.removed })}
          </div>
        )}

        {/* v3.5.10 refinamiento — un horario existe (StaffSchedule creado o
            clonado) pero sin entradas: callejón sin salida antes de esto,
            porque el resto de la UI asume que hay filas. */}
        {viewMode === "department-week" && view && view.rows.length === 0 && canEdit && status === "DRAFT" && (
          <div className="flex items-center justify-between gap-3 bg-amber-50 border-l-4 border-amber-400 px-4 py-3 text-sm text-amber-800 no-print">
            <span>{t("staffSchedule.empty.hasNoMembers")}</span>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={handleSyncMembers}
                disabled={busy}
                className="rounded-none bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-white hover:bg-[var(--accent)]/90 shadow-sm disabled:opacity-50"
              >
                {t("staffSchedule.action.syncMembers")}
              </button>
              <button
                onClick={handleDeleteSchedule}
                disabled={busy}
                className="rounded-none border border-red-300 bg-white px-3 py-2 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
              >
                {t("staffSchedule.action.deleteSchedule")}
              </button>
            </div>
          </div>
        )}

        {/* Worker view (R5) — replaces every department-scoped view while a
            worker is selected (D5: exactly one view active at a time). */}
        {viewMode === "worker" && worker && (
          <WorkerScheduleView
            userId={worker.userId}
            workerLabel={worker.label}
            mode={periodMode}
            weekStart={weekStart}
            year={monthYear}
            month={monthNum}
          />
        )}

        {/* Department month view (R6). */}
        {viewMode === "department-month" && (
          departmentId
            ? <DepartmentMonthView departmentId={departmentId} year={monthYear} month={monthNum} />
            : (
              <div className="bg-white shadow-sm ring-1 ring-slate-200 p-8 text-center text-sm text-slate-500">
                {t("staffSchedule.month.selectDepartment")}
              </div>
            )
        )}

        {/* Department week view (existing behavior, unchanged). */}
        {viewMode === "department-week" && !departmentId && (
          <AllDepartmentsView weekStart={weekStart} />
        )}

        {viewMode === "department-week" && departmentId && (loading || deptLoading) && (
          <div className="bg-white shadow-sm ring-1 ring-slate-200 p-8 flex items-center gap-3 text-slate-500 text-sm no-print">
            <RefreshCw className="h-4 w-4 animate-spin" />
            {t("common.loading")}
          </div>
        )}

        {viewMode === "department-week" && departmentId && error && (
          <div className="flex items-center gap-2 bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {t("common.unknown_error")}
          </div>
        )}

        {viewMode === "department-week" && departmentId && !loading && notFound && (
          <div className="bg-white shadow-sm ring-1 ring-slate-200 p-8 text-center space-y-3 no-print">
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

        {viewMode === "department-week" && view && (
          <div className={showAlertPanel ? "staff-schedule-grid grid grid-cols-1 xl:grid-cols-[1fr_20rem] gap-6 items-start" : "w-full"}>
            <StaffScheduleCalendar
              view={view}
              departmentConfig={departmentConfig}
              onSaveEntry={handleSaveEntry}
              onSaveEntries={saveEntries}
            />
            {showAlertPanel && (
              // no-print: alerts never appear on the printed/PDF output,
              // regardless of role, even though they're shown on screen for
              // a DRAFT schedule the viewer can edit.
              <div className="no-print">
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
