"use client";

import { useEffect, useState } from "react";
import { X, Plus, Trash2 } from "lucide-react";
import { apiFetch } from "@/lib/apiFetch";
import { useLanguage } from "@/contexts/LanguageContext";
import {
  useDepartmentConfig,
  useDepartmentManagers,
  useDepartmentMembers,
} from "@/app/staff-schedule/hooks/useStaffSchedule";
import type { Department, DepartmentScheduleConfig, SimpleUser } from "@/app/staff-schedule/types";
import SummerScheduleConfig from "./SummerScheduleConfig";
import { displayLabel } from "@/lib/displayLabel";

interface Props {
  departments: Department[];
  onClose: () => void;
  onDepartmentsChanged: () => void;
}

const emptyDeptForm = {
  name: "",
  code: "",
  serviceStart: "09:00",
  serviceEnd: "19:00",
  presenceStart: "10:00",
  presenceEnd: "14:00",
  minPresencePct: 50,
};

export default function ScheduleConfigPanel({ departments, onClose, onDepartmentsChanged }: Props) {
  const { t } = useLanguage();
  const [selectedDeptId, setSelectedDeptId] = useState<string | null>(departments[0]?.id ?? null);
  const [deptForm, setDeptForm] = useState(emptyDeptForm);
  const [creatingNew, setCreatingNew] = useState(false);
  const [deptSaving, setDeptSaving] = useState(false);
  const [deptError, setDeptError] = useState<string | null>(null);

  const { config, save: saveConfig } = useDepartmentConfig(creatingNew ? null : selectedDeptId);
  const [cfgForm, setCfgForm] = useState<Partial<DepartmentScheduleConfig>>({});
  const [cfgSaving, setCfgSaving] = useState(false);
  const [cfgError, setCfgError] = useState<string | null>(null);

  const { managers: currentManagers, refetch: refetchManagers } = useDepartmentManagers(creatingNew ? null : selectedDeptId);
  const { members: currentMembers, refetch: refetchMembers } = useDepartmentMembers(creatingNew ? null : selectedDeptId);

  const [users, setUsers] = useState<SimpleUser[]>([]);
  const [managerUserId, setManagerUserId] = useState("");
  const [assignUserId, setAssignUserId] = useState("");
  const [assignDeptId, setAssignDeptId] = useState<string>("");
  const [managersError, setManagersError] = useState<string | null>(null);
  const [weeklyHoursUserId, setWeeklyHoursUserId] = useState("");
  const [assignWeeklyHours, setAssignWeeklyHours] = useState("");
  const [weeklyHoursError, setWeeklyHoursError] = useState<string | null>(null);
  const [weeklyHoursSaving, setWeeklyHoursSaving] = useState(false);
  const [weeklyHoursSuccess, setWeeklyHoursSuccess] = useState(false);

  // v3.5.11 — cuota de teletrabajo por trabajador (días/mes / porcentaje/mes /
  // total). v3.5.13 — cuarto método días/semana; los cuatro son EXCLUYENTES
  // (D4): al rellenar uno se limpian los otros tres, tanto en la UI como en el
  // servidor (Zod + CHECK en BD).
  const [teleworkUserId, setTeleworkUserId] = useState("");
  const [teleworkFull, setTeleworkFull] = useState(false);
  const [teleworkDays, setTeleworkDays] = useState("");
  const [teleworkDaysWeek, setTeleworkDaysWeek] = useState("");
  const [teleworkPct, setTeleworkPct] = useState("");
  const [teleworkError, setTeleworkError] = useState<string | null>(null);
  const [teleworkSaving, setTeleworkSaving] = useState(false);
  const [teleworkSuccess, setTeleworkSuccess] = useState(false);

  useEffect(() => {
    apiFetch("/api/users")
      .then((r) => (r.ok ? r.json() : []))
      .then(setUsers)
      .catch(() => setUsers([]));
  }, []);

  useEffect(() => {
    if (config) setCfgForm(config);
  }, [config]);

  // v3.5.10 refinamiento — al elegir un trabajador en el selector de horas
  // semanales, prefija el campo con su valor efectivo actual (o vacío si usa
  // el valor por defecto del departamento).
  useEffect(() => {
    if (!weeklyHoursUserId) { setAssignWeeklyHours(""); return; }
    const member = currentMembers.find((m) => m.id === weeklyHoursUserId);
    setAssignWeeklyHours(member?.weeklyTargetHours != null ? String(member.weeklyTargetHours) : "");
    setWeeklyHoursSuccess(false);
  }, [weeklyHoursUserId, currentMembers]);

  // Prefija los cuatro campos de cuota con los valores actuales del trabajador
  // elegido (vacío/desmarcado = usa el tope del departamento). Solo uno de los
  // cuatro puede venir fijado del servidor (D4), así que como mucho un campo
  // queda relleno.
  useEffect(() => {
    if (!teleworkUserId) {
      setTeleworkFull(false); setTeleworkDays(""); setTeleworkDaysWeek(""); setTeleworkPct("");
      return;
    }
    const member = currentMembers.find((m) => m.id === teleworkUserId);
    setTeleworkFull(member?.teleworkFull ?? false);
    setTeleworkDays(member?.teleworkQuotaDays != null ? String(member.teleworkQuotaDays) : "");
    setTeleworkDaysWeek(member?.teleworkQuotaDaysPerWeek != null ? String(member.teleworkQuotaDaysPerWeek) : "");
    setTeleworkPct(member?.teleworkQuotaPct != null ? String(member.teleworkQuotaPct) : "");
    setTeleworkSuccess(false);
  }, [teleworkUserId, currentMembers]);

  // v3.5.13 (D4) — al fijar un método, se limpian los otros tres para que la
  // exclusividad sea visible en la UI, no solo un 400 sorpresa del servidor.
  const chooseTeleworkFull = (checked: boolean) => {
    setTeleworkFull(checked);
    if (checked) { setTeleworkDays(""); setTeleworkDaysWeek(""); setTeleworkPct(""); }
  };
  const chooseTeleworkDays = (v: string) => {
    setTeleworkDays(v);
    if (v !== "") { setTeleworkFull(false); setTeleworkDaysWeek(""); setTeleworkPct(""); }
  };
  const chooseTeleworkDaysWeek = (v: string) => {
    setTeleworkDaysWeek(v);
    if (v !== "") { setTeleworkFull(false); setTeleworkDays(""); setTeleworkPct(""); }
  };
  const chooseTeleworkPct = (v: string) => {
    setTeleworkPct(v);
    if (v !== "") { setTeleworkFull(false); setTeleworkDays(""); setTeleworkDaysWeek(""); }
  };

  const selectedDept = departments.find((d) => d.id === selectedDeptId) ?? null;

  const startEdit = (d: Department) => {
    setCreatingNew(false);
    setSelectedDeptId(d.id);
    setDeptForm({
      name: d.name,
      code: d.code,
      serviceStart: d.serviceStart,
      serviceEnd: d.serviceEnd,
      presenceStart: d.presenceStart,
      presenceEnd: d.presenceEnd,
      minPresencePct: d.minPresencePct,
    });
  };

  const startCreate = () => {
    setCreatingNew(true);
    setSelectedDeptId(null);
    setDeptForm(emptyDeptForm);
  };

  const handleSaveDept = async () => {
    setDeptSaving(true);
    setDeptError(null);
    try {
      if (creatingNew) {
        const res = await apiFetch("/api/staff-schedule/departments", {
          method: "POST",
          body: JSON.stringify(deptForm),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ? JSON.stringify(body.error) : `Status ${res.status}`);
        }
        const created: Department = await res.json();
        setCreatingNew(false);
        setSelectedDeptId(created.id);
      } else if (selectedDeptId) {
        const res = await apiFetch(`/api/staff-schedule/departments/${selectedDeptId}`, {
          method: "PUT",
          body: JSON.stringify(deptForm),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ? JSON.stringify(body.error) : `Status ${res.status}`);
        }
      }
      onDepartmentsChanged();
    } catch (e) {
      setDeptError(e instanceof Error ? e.message : "error");
    } finally {
      setDeptSaving(false);
    }
  };

  const handleSaveConfig = async () => {
    setCfgSaving(true);
    setCfgError(null);
    try {
      await saveConfig(cfgForm);
    } catch (e) {
      setCfgError(e instanceof Error ? e.message : "error");
    } finally {
      setCfgSaving(false);
    }
  };

  const handleAddManager = async () => {
    if (!selectedDeptId || !managerUserId) return;
    setManagersError(null);
    try {
      const res = await apiFetch(`/api/staff-schedule/departments/${selectedDeptId}/managers`, {
        method: "POST",
        body: JSON.stringify({ userId: managerUserId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Status ${res.status}`);
      }
      setManagerUserId("");
      await refetchManagers();
      onDepartmentsChanged();
    } catch (e) {
      setManagersError(e instanceof Error ? e.message : "error");
    }
  };

  // v3.5.10 refinamiento — antes no había GET de managers, así que quitar
  // solo podía hacerse a ciegas desde el mismo select de añadir. Ahora se
  // quita desde la lista de responsables actuales (ver JSX más abajo).
  const handleRemoveManager = async (userId: string) => {
    if (!selectedDeptId) return;
    setManagersError(null);
    try {
      const res = await apiFetch(`/api/staff-schedule/departments/${selectedDeptId}/managers/${userId}`, {
        method: "DELETE",
      });
      if (!res.ok && res.status !== 204) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Status ${res.status}`);
      }
      await refetchManagers();
      onDepartmentsChanged();
    } catch (e) {
      setManagersError(e instanceof Error ? e.message : "error");
    }
  };

  const handleAssignUserDept = async () => {
    if (!assignUserId) return;
    setManagersError(null);
    try {
      const res = await apiFetch(`/api/staff-schedule/users/${assignUserId}/department`, {
        method: "PUT",
        body: JSON.stringify({ departmentId: assignDeptId || null }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Status ${res.status}`);
      }
      setAssignUserId("");
      setAssignDeptId("");
      await refetchMembers();
      onDepartmentsChanged();
    } catch (e) {
      setManagersError(e instanceof Error ? e.message : "error");
    }
  };

  // v3.5.13 — retirada de un trabajador del departamento. Reutiliza el endpoint
  // de asignacion con departmentId=null (ADMIN, transaccional, auditado como
  // ASSIGN_USER_DEPARTMENT); no hace falta ruta nueva.
  //
  // Se avisa explicitamente del alcance (D5): los horarios ya publicados NO
  // cambian, y los borradores solo se actualizan al pulsar "Sincronizar
  // miembros". Sin ese aviso, el operador esperaria que el calendario se
  // limpiara solo y lo tomaria por un fallo.
  const handleRemoveMember = async (userId: string, label: string) => {
    if (!confirm(t("staffSchedule.members.removeConfirm", { name: label }))) return;
    setManagersError(null);
    try {
      const res = await apiFetch(`/api/staff-schedule/users/${userId}/department`, {
        method: "PUT",
        body: JSON.stringify({ departmentId: null }),
      });
      if (!res.ok) throw new Error(String(res.status));
      await refetchMembers();
      onDepartmentsChanged();
    } catch {
      setManagersError(t("staffSchedule.members.removeError"));
    }
  };

  // v3.5.13 (D3) — marca/desmarca a un trabajador como externo. El
  // enmascarado real ocurre en servidor (maskIdentityForViewer); este toggle
  // solo cambia el dato de partida.
  const handleToggleExternal = async (userId: string, isExternal: boolean) => {
    setManagersError(null);
    try {
      const res = await apiFetch(`/api/staff-schedule/users/${userId}/external`, {
        method: "PUT",
        body: JSON.stringify({ isExternal }),
      });
      if (!res.ok) throw new Error(String(res.status));
      await refetchMembers();
    } catch {
      setManagersError(t("staffSchedule.members.externalError"));
    }
  };

  // v3.5.10 refinamiento — antes dependía de assignUserId (el selector de la
  // sección "asignar departamento" de arriba): sin elegir un trabajador ahí,
  // el botón de esta sección nunca se habilitaba. Ahora tiene su propio
  // selector (weeklyHoursUserId, poblado con los miembros del departamento) y
  // el campo se prefija con las horas actuales del trabajador elegido.
  const handleSetWeeklyHours = async () => {
    if (!weeklyHoursUserId) return;
    setWeeklyHoursError(null);
    setWeeklyHoursSuccess(false);
    setWeeklyHoursSaving(true);
    try {
      const res = await apiFetch(`/api/staff-schedule/users/${weeklyHoursUserId}/weekly-hours`, {
        method: "PUT",
        body: JSON.stringify({ weeklyTargetHours: assignWeeklyHours === "" ? null : Number(assignWeeklyHours) }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Status ${res.status}`);
      }
      setWeeklyHoursSuccess(true);
      await refetchMembers();
    } catch (e) {
      setWeeklyHoursError(e instanceof Error ? e.message : "error");
    } finally {
      setWeeklyHoursSaving(false);
    }
  };

  // v3.5.13 (D4) — los cuatro métodos son excluyentes; el servidor rechaza con
  // 400 si llegara más de uno relleno, pero la UI ya los mantiene mutuamente
  // excluyentes desde que se elige uno (choose* de arriba).
  const handleSetTeleworkQuota = async () => {
    if (!teleworkUserId) return;
    setTeleworkError(null);
    setTeleworkSuccess(false);
    setTeleworkSaving(true);
    try {
      const res = await apiFetch(`/api/staff-schedule/users/${teleworkUserId}/telework-quota`, {
        method: "PUT",
        body: JSON.stringify({
          teleworkFull,
          teleworkQuotaDays: teleworkDays === "" ? null : Number(teleworkDays),
          teleworkQuotaDaysPerWeek: teleworkDaysWeek === "" ? null : Number(teleworkDaysWeek),
          teleworkQuotaPct: teleworkPct === "" ? null : Number(teleworkPct),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ? JSON.stringify(body.error) : `Status ${res.status}`);
      }
      setTeleworkSuccess(true);
      await refetchMembers();
    } catch (e) {
      setTeleworkError(e instanceof Error ? e.message : "error");
    } finally {
      setTeleworkSaving(false);
    }
  };

  const numField = (key: keyof DepartmentScheduleConfig, label: string, step = "0.5") => (
    <div>
      <label className="block text-xs font-medium text-slate-600 mb-1">{label}</label>
      <input
        type="number"
        step={step}
        value={(cfgForm[key] as number) ?? ""}
        onChange={(e) => setCfgForm((f) => ({ ...f, [key]: Number(e.target.value) }))}
        className="w-full rounded-none border border-slate-300 px-2.5 py-2 text-sm"
      />
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 px-4 py-8">
      <div className="w-full max-w-4xl bg-white shadow-sm ring-1 ring-slate-200 rounded-none">
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <h2 className="text-base font-bold text-slate-900">{t("staffSchedule.config.title")}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="px-6 py-5 space-y-8">
          {/* Departments list + form */}
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-900">{t("staffSchedule.department.title")}</h3>
              <button
                type="button"
                onClick={startCreate}
                className="rounded-none border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 flex items-center gap-1"
              >
                <Plus className="h-3.5 w-3.5" /> {t("staffSchedule.config.newDepartment")}
              </button>
            </div>

            <div className="flex flex-wrap gap-2">
              {departments.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => startEdit(d)}
                  className={`rounded-none border px-2.5 py-1.5 text-xs ${selectedDeptId === d.id && !creatingNew ? "border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]" : "border-slate-300 text-slate-600 hover:bg-slate-50"}`}
                >
                  {d.name}
                </button>
              ))}
            </div>

            {(creatingNew || selectedDept) && (
              <div className="grid grid-cols-3 gap-3 bg-slate-50 p-4 ring-1 ring-slate-200">
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">{t("common.name")}</label>
                  <input
                    value={deptForm.name}
                    onChange={(e) => setDeptForm((f) => ({ ...f, name: e.target.value }))}
                    className="w-full rounded-none border border-slate-300 px-2.5 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">{t("staffSchedule.department.code")}</label>
                  <input
                    value={deptForm.code}
                    onChange={(e) => setDeptForm((f) => ({ ...f, code: e.target.value }))}
                    className="w-full rounded-none border border-slate-300 px-2.5 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">{t("staffSchedule.config.minPresencePct")}</label>
                  <input
                    type="number"
                    value={deptForm.minPresencePct}
                    onChange={(e) => setDeptForm((f) => ({ ...f, minPresencePct: Number(e.target.value) }))}
                    className="w-full rounded-none border border-slate-300 px-2.5 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">{t("staffSchedule.department.serviceStart")}</label>
                  <input
                    type="time"
                    value={deptForm.serviceStart}
                    onChange={(e) => setDeptForm((f) => ({ ...f, serviceStart: e.target.value }))}
                    className="w-full rounded-none border border-slate-300 px-2.5 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">{t("staffSchedule.department.serviceEnd")}</label>
                  <input
                    type="time"
                    value={deptForm.serviceEnd}
                    onChange={(e) => setDeptForm((f) => ({ ...f, serviceEnd: e.target.value }))}
                    className="w-full rounded-none border border-slate-300 px-2.5 py-2 text-sm"
                  />
                </div>
                <div />
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">{t("staffSchedule.department.presenceStart")}</label>
                  <input
                    type="time"
                    value={deptForm.presenceStart}
                    onChange={(e) => setDeptForm((f) => ({ ...f, presenceStart: e.target.value }))}
                    className="w-full rounded-none border border-slate-300 px-2.5 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">{t("staffSchedule.department.presenceEnd")}</label>
                  <input
                    type="time"
                    value={deptForm.presenceEnd}
                    onChange={(e) => setDeptForm((f) => ({ ...f, presenceEnd: e.target.value }))}
                    className="w-full rounded-none border border-slate-300 px-2.5 py-2 text-sm"
                  />
                </div>

                <div className="col-span-3 flex items-center gap-2">
                  {deptError && <p className="text-xs text-red-600">{deptError}</p>}
                  <button
                    type="button"
                    onClick={handleSaveDept}
                    disabled={deptSaving}
                    className="ml-auto rounded-none bg-[var(--accent)] px-4 py-2 text-xs font-semibold text-white hover:bg-[var(--accent)]/90 shadow-sm disabled:opacity-50"
                  >
                    {creatingNew ? t("staffSchedule.department.create") : t("staffSchedule.department.edit")}
                  </button>
                </div>
              </div>
            )}
          </section>

          {/* Schedule config for the selected department */}
          {selectedDeptId && !creatingNew && (
            <section className="space-y-3">
              <h3 className="text-sm font-semibold text-slate-900">{t("staffSchedule.config.title")}</h3>
              <div className="grid grid-cols-4 gap-3 bg-slate-50 p-4 ring-1 ring-slate-200">
                {numField("winterDailyNetHours", t("staffSchedule.config.dailyNetHours"))}
                {numField("winterMaxDailyNetHours", t("staffSchedule.config.maxDailyNetHours"))}
                {numField("winterBreakMinutes", t("staffSchedule.config.breakMinutes"), "5")}
                {numField("winterFridayNetHours", t("staffSchedule.config.fridayNetHours"))}
                {numField("summerDailyNetHours", `${t("staffSchedule.config.dailyNetHours")} (${t("staffSchedule.config.summerHours")})`)}
                {numField("summerMaxDailyNetHours", `${t("staffSchedule.config.maxDailyNetHours")} (${t("staffSchedule.config.summerHours")})`)}
                {numField("summerBreakMinutes", t("staffSchedule.config.breakMinutes"), "5")}
                {numField("summerFridayNetHours", t("staffSchedule.config.fridayNetHours"))}
                {numField("weeklyTargetNetHours", t("staffSchedule.summary.weeklyHours"))}
                {numField("monthlyTeleworkCap", t("staffSchedule.config.monthlyTeleworkCap"), "1")}

                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">{t("staffSchedule.config.flexEntryFrom")}</label>
                  <input
                    type="time"
                    value={cfgForm.flexEntryStart ?? ""}
                    onChange={(e) => setCfgForm((f) => ({ ...f, flexEntryStart: e.target.value }))}
                    className="w-full rounded-none border border-slate-300 px-2.5 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">{t("staffSchedule.config.flexEntryTo")}</label>
                  <input
                    type="time"
                    value={cfgForm.flexEntryEnd ?? ""}
                    onChange={(e) => setCfgForm((f) => ({ ...f, flexEntryEnd: e.target.value }))}
                    className="w-full rounded-none border border-slate-300 px-2.5 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">{t("staffSchedule.config.flexExitFrom")}</label>
                  <input
                    type="time"
                    value={cfgForm.flexExitStart ?? ""}
                    onChange={(e) => setCfgForm((f) => ({ ...f, flexExitStart: e.target.value }))}
                    className="w-full rounded-none border border-slate-300 px-2.5 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">{t("staffSchedule.config.flexExitTo")}</label>
                  <input
                    type="time"
                    value={cfgForm.flexExitEnd ?? ""}
                    onChange={(e) => setCfgForm((f) => ({ ...f, flexExitEnd: e.target.value }))}
                    className="w-full rounded-none border border-slate-300 px-2.5 py-2 text-sm"
                  />
                </div>

                <div className="col-span-4 flex items-center gap-2">
                  {cfgError && <p className="text-xs text-red-600">{cfgError}</p>}
                  <button
                    type="button"
                    onClick={handleSaveConfig}
                    disabled={cfgSaving}
                    className="ml-auto rounded-none bg-[var(--accent)] px-4 py-2 text-xs font-semibold text-white hover:bg-[var(--accent)]/90 shadow-sm disabled:opacity-50"
                  >
                    {t("staffSchedule.action.save")}
                  </button>
                </div>
              </div>
            </section>
          )}

          {/* Managers */}
          {selectedDeptId && !creatingNew && (
            <section className="space-y-3">
              <h3 className="text-sm font-semibold text-slate-900">{t("staffSchedule.manager.title")}</h3>

              {/* v3.5.10 refinamiento — responsables actuales, antes invisibles
                  (no existía ningún GET; solo se podía añadir/quitar a ciegas). */}
              {currentManagers.length > 0 ? (
                <ul className="space-y-1">
                  {currentManagers.map((m) => (
                    <li key={m.id} className="flex items-center justify-between bg-slate-50 ring-1 ring-slate-200 px-3 py-1.5 text-xs">
                      <span className="text-slate-700">{displayLabel(m)} <span className="text-slate-400">({m.email})</span></span>
                      <button
                        type="button"
                        onClick={() => handleRemoveManager(m.id)}
                        title={t("staffSchedule.action.removeManager")}
                        className="text-slate-400 hover:text-red-600"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-slate-400">{t("staffSchedule.manager.none")}</p>
              )}

              <div className="flex items-center gap-2">
                <select
                  value={managerUserId}
                  onChange={(e) => setManagerUserId(e.target.value)}
                  className="flex-1 rounded-none border border-slate-300 px-2.5 py-2 text-sm"
                >
                  <option value="">{t("staffSchedule.manager.selectUser")}</option>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {displayLabel(u)} ({u.email})
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={handleAddManager}
                  disabled={!managerUserId}
                  className="rounded-none bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-white hover:bg-[var(--accent)]/90 shadow-sm disabled:opacity-50"
                >
                  {t("staffSchedule.action.addManager")}
                </button>
              </div>
              {managersError && <p className="text-xs text-red-600">{managersError}</p>}
            </section>
          )}

          {/* Members — v3.5.10 refinamiento: lectura, antes invisible */}
          {selectedDeptId && !creatingNew && (
            <section className="space-y-3">
              <h3 className="text-sm font-semibold text-slate-900">{t("staffSchedule.members.title")}</h3>
              {currentMembers.length > 0 ? (
                <ul className="grid grid-cols-1 sm:grid-cols-2 gap-1">
                  {currentMembers.map((m) => (
                    <li key={m.id} className="flex items-center justify-between gap-2 bg-slate-50 ring-1 ring-slate-200 px-3 py-1.5 text-xs">
                      <span className="text-slate-700 truncate">{displayLabel(m)}</span>
                      <span className="flex items-center gap-2 shrink-0">
                        <span className="text-slate-400">
                          {m.weeklyTargetHours != null ? `${m.weeklyTargetHours}h` : "—"}
                          {m.teleworkFull
                            ? ` · ${t("staffSchedule.telework.fullShort")}`
                            : m.teleworkQuotaDays != null
                              ? ` · ${m.teleworkQuotaDays}d/mes`
                              : m.teleworkQuotaDaysPerWeek != null
                                ? ` · ${m.teleworkQuotaDaysPerWeek}d/sem`
                                : m.teleworkQuotaPct != null
                                  ? ` · ${m.teleworkQuotaPct}%`
                                  : ""}
                        </span>
                        <label className="flex items-center gap-1 text-xs text-slate-500" title={t("staffSchedule.members.external")}>
                          <input
                            type="checkbox"
                            checked={m.isExternal}
                            onChange={(e) => handleToggleExternal(m.id, e.target.checked)}
                            className="h-3.5 w-3.5 rounded-none border-slate-300"
                          />
                          {t("staffSchedule.members.externalShort")}
                        </label>
                        <button
                          type="button"
                          onClick={() => handleRemoveMember(m.id, displayLabel(m))}
                          className="rounded-none border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50"
                        >
                          {t("staffSchedule.members.remove")}
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-slate-400">{t("staffSchedule.members.none")}</p>
              )}
            </section>
          )}

          {/* User → department assignment */}
          <section className="space-y-3">
            <h3 className="text-sm font-semibold text-slate-900">{t("staffSchedule.action.assignDepartment")}</h3>
            <div className="flex items-center gap-2">
              <select
                value={assignUserId}
                onChange={(e) => setAssignUserId(e.target.value)}
                className="flex-1 rounded-none border border-slate-300 px-2.5 py-2 text-sm"
              >
                <option value="">{t("staffSchedule.manager.selectUser")}</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {displayLabel(u)} ({u.email})
                  </option>
                ))}
              </select>
              <select
                value={assignDeptId}
                onChange={(e) => setAssignDeptId(e.target.value)}
                className="rounded-none border border-slate-300 px-2.5 py-2 text-sm min-w-[10rem]"
              >
                <option value="">{t("staffSchedule.department.none")}</option>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={handleAssignUserDept}
                disabled={!assignUserId}
                className="rounded-none bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-white hover:bg-[var(--accent)]/90 shadow-sm disabled:opacity-50"
              >
                {t("staffSchedule.action.save")}
              </button>
            </div>
            {managersError && <p className="text-xs text-red-600">{managersError}</p>}

            {/* v3.5.10 refinamiento — selector propio (antes reutilizaba
                assignUserId de la sección de arriba: sin elegir un
                trabajador ahí, este botón nunca se habilitaba). El valor se
                prefija con las horas efectivas actuales del trabajador. */}
            <div className="flex items-center gap-2">
              <label className="text-xs font-medium text-slate-600 min-w-[10rem]">
                {t("staffSchedule.config.weeklyHoursWorker")}
              </label>
              <select
                value={weeklyHoursUserId}
                onChange={(e) => setWeeklyHoursUserId(e.target.value)}
                className="flex-1 rounded-none border border-slate-300 px-2.5 py-2 text-sm"
              >
                <option value="">{t("staffSchedule.manager.selectUser")}</option>
                {(currentMembers.length > 0 ? currentMembers : users).map((u) => (
                  <option key={u.id} value={u.id}>
                    {displayLabel(u)}
                  </option>
                ))}
              </select>
              <input
                type="number"
                min={0}
                max={80}
                step={0.5}
                placeholder={t("staffSchedule.config.weeklyHoursDefault")}
                value={assignWeeklyHours}
                onChange={(e) => setAssignWeeklyHours(e.target.value)}
                className="w-32 rounded-none border border-slate-300 px-2.5 py-2 text-sm"
              />
              <button
                type="button"
                onClick={handleSetWeeklyHours}
                disabled={!weeklyHoursUserId || weeklyHoursSaving}
                className="rounded-none border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              >
                {t("staffSchedule.action.save")}
              </button>
            </div>
            {weeklyHoursSuccess && <p className="text-xs text-green-700">{t("staffSchedule.config.weeklyHoursSaved")}</p>}
            {weeklyHoursError && <p className="text-xs text-red-600">{weeklyHoursError}</p>}

            {/* v3.5.11 — cuota de teletrabajo por trabajador. Deja los tres
                campos vacíos/desmarcados para que use el tope mensual del
                departamento. */}
            <div className="space-y-2 border-t border-slate-200 pt-3">
              <label className="block text-xs font-medium text-slate-600">
                {t("staffSchedule.telework.title")}
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={teleworkUserId}
                  onChange={(e) => setTeleworkUserId(e.target.value)}
                  className="flex-1 min-w-[12rem] rounded-none border border-slate-300 px-2.5 py-2 text-sm"
                >
                  <option value="">{t("staffSchedule.manager.selectUser")}</option>
                  {(currentMembers.length > 0 ? currentMembers : users).map((u) => (
                    <option key={u.id} value={u.id}>
                      {displayLabel(u)}
                    </option>
                  ))}
                </select>
                <label className="flex items-center gap-1.5 text-xs text-slate-600">
                  <input
                    type="checkbox"
                    checked={teleworkFull}
                    onChange={(e) => chooseTeleworkFull(e.target.checked)}
                    className="h-4 w-4 rounded-none border-slate-300"
                  />
                  {t("staffSchedule.telework.full")}
                </label>
                <input
                  type="number"
                  min={0}
                  max={31}
                  step={1}
                  disabled={teleworkFull || teleworkDaysWeek !== "" || teleworkPct !== ""}
                  placeholder={t("staffSchedule.telework.days")}
                  title={t("staffSchedule.telework.days")}
                  value={teleworkDays}
                  onChange={(e) => chooseTeleworkDays(e.target.value)}
                  className="w-24 rounded-none border border-slate-300 px-2.5 py-2 text-sm disabled:bg-slate-50 disabled:text-slate-400"
                />
                <input
                  type="number"
                  min={0}
                  max={7}
                  step={1}
                  disabled={teleworkFull || teleworkDays !== "" || teleworkPct !== ""}
                  placeholder={t("staffSchedule.telework.daysPerWeek")}
                  title={t("staffSchedule.telework.daysPerWeek")}
                  value={teleworkDaysWeek}
                  onChange={(e) => chooseTeleworkDaysWeek(e.target.value)}
                  className="w-24 rounded-none border border-slate-300 px-2.5 py-2 text-sm disabled:bg-slate-50 disabled:text-slate-400"
                />
                <input
                  type="number"
                  min={0}
                  max={100}
                  step={1}
                  disabled={teleworkFull || teleworkDays !== "" || teleworkDaysWeek !== ""}
                  placeholder={t("staffSchedule.telework.pct")}
                  title={t("staffSchedule.telework.pct")}
                  value={teleworkPct}
                  onChange={(e) => chooseTeleworkPct(e.target.value)}
                  className="w-24 rounded-none border border-slate-300 px-2.5 py-2 text-sm disabled:bg-slate-50 disabled:text-slate-400"
                />
                <button
                  type="button"
                  onClick={handleSetTeleworkQuota}
                  disabled={!teleworkUserId || teleworkSaving}
                  className="rounded-none border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                >
                  {t("staffSchedule.action.save")}
                </button>
              </div>
              <p className="text-xs text-slate-400">{t("staffSchedule.telework.hint")}</p>
              <p className="text-xs text-slate-400">{t("staffSchedule.config.teleworkExclusive")}</p>
              {teleworkSuccess && <p className="text-xs text-green-700">{t("staffSchedule.telework.saved")}</p>}
              {teleworkError && <p className="text-xs text-red-600">{teleworkError}</p>}
            </div>
          </section>

          {/* Summer schedule */}
          <SummerScheduleConfig />
        </div>
      </div>
    </div>
  );
}
