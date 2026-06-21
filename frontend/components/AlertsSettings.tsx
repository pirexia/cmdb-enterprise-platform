"use client";

import { useEffect, useState, useCallback } from "react";
import { Bell, Mail, Play, Clock, Globe, RefreshCw, CheckCircle, XCircle, Loader2, Plus, X, MessageSquare } from "lucide-react";
import { apiFetch } from "@/lib/apiFetch";
import { useLanguage } from "@/contexts/LanguageContext";

// ── Types ─────────────────────────────────────────────────────────────────────

interface AlertConfig {
  id:                string;
  enabled:           boolean;
  sendTimeHour:      number;
  sendTimeMinute:    number;
  timezone:          string;
  locale:            string;
  recipients:        string[];
  sendAllClear:      boolean;
  suppressUnchanged: boolean;
  updatedAt:         string;
  smtpConfigured:    boolean;
  smtpHost:          string | null;
  smtpPort:          number | null;
  teamsConfigured?:  boolean;
  slackConfigured?:  boolean;
  slackChannel?:     string | null;
}

interface AlertRule {
  id:         string;
  category:   string;
  enabled:    boolean;
  warnDays:   number;
  recipients: string[];
  updatedAt:  string;
}

interface AlertRun {
  id:          string;
  trigger:     string;
  startedAt:   string;
  finishedAt:  string | null;
  status:      string;
  totalAlerts: number;
  breakdown:   Record<string, number>;
  recipients:  string[];
  messageId:   string | null;
  errorMsg:    string | null;
}

const TIMEZONES = [
  "UTC", "Europe/Madrid", "Europe/London", "Europe/Berlin", "Europe/Paris",
  "Europe/Rome", "Europe/Lisbon", "America/Mexico_City", "America/New_York",
  "America/Chicago", "America/Los_Angeles", "America/Sao_Paulo",
  "Asia/Tokyo", "Asia/Shanghai", "Asia/Dubai", "Asia/Kolkata",
  "Australia/Sydney",
];

const LOCALES = [
  { code: "es", label: "Español" },
  { code: "en", label: "English" },
  { code: "de", label: "Deutsch" },
  { code: "pt", label: "Português" },
  { code: "fr", label: "Français" },
  { code: "it", label: "Italiano" },
];

const CATEGORIES: Record<string, { icon: string; color: string }> = {
  eol:           { icon: "🗓️", color: "text-amber-700" },
  eos:           { icon: "⏳", color: "text-orange-700" },
  warranty:      { icon: "🛡️", color: "text-emerald-700" },
  maintenance:   { icon: "🔧", color: "text-cyan-700" },
  contract:      { icon: "📄", color: "text-blue-700" },
  vulnerability: { icon: "⚠️", color: "text-red-700" },
  license:       { icon: "🔑", color: "text-violet-700" },
};

// ── Status badges ─────────────────────────────────────────────────────────────

function RunStatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    SENT:      "bg-green-100 text-green-700",
    ALL_CLEAR: "bg-blue-100 text-blue-700",
    SKIPPED:   "bg-slate-100 text-slate-600",
    FAILED:    "bg-red-100 text-red-700",
  };
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold ${map[status] ?? "bg-slate-100 text-slate-500"}`}>
      {status}
    </span>
  );
}

// ── Recipients chip editor ─────────────────────────────────────────────────────

function RecipientsEditor({
  value, onChange, disabled,
}: { value: string[]; onChange: (v: string[]) => void; disabled?: boolean }) {
  const [input, setInput] = useState("");

  function add() {
    const v = input.trim().toLowerCase();
    if (v && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && !value.includes(v)) {
      onChange([...value, v]);
    }
    setInput("");
  }

  return (
    <div className="flex flex-wrap gap-1.5 rounded-lg border border-slate-200 bg-slate-50 p-2 min-h-[40px]">
      {value.map((r) => (
        <span key={r} className="inline-flex items-center gap-1 rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-700">
          {r}
          {!disabled && (
            <button onClick={() => onChange(value.filter((x) => x !== r))} className="hover:text-red-600">
              <X className="h-3 w-3" />
            </button>
          )}
        </span>
      ))}
      {!disabled && (
        <input
          type="email"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(); } }}
          onBlur={add}
          placeholder="email@domain.com"
          className="flex-1 min-w-[160px] bg-transparent text-xs text-slate-700 placeholder-slate-400 outline-none"
        />
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function AlertsSettings({ isAdmin }: { isAdmin: boolean }) {
  const { t } = useLanguage();

  const [config,    setConfig]    = useState<AlertConfig | null>(null);
  const [rules,     setRules]     = useState<AlertRule[]>([]);
  const [history,   setHistory]   = useState<AlertRun[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [saving,    setSaving]    = useState(false);
  const [toast,     setToast]     = useState<{ msg: string; ok: boolean } | null>(null);

  // Local draft for config form
  const [draft, setDraft] = useState<Partial<AlertConfig>>({});
  // Local draft for rules (keyed by category)
  const [ruleDrafts, setRuleDrafts] = useState<Record<string, Partial<AlertRule>>>({});
  // Local draft for notification channels (T8). Secrets are write-only: the
  // token/URL inputs start empty and are only sent when the admin types a value.
  const [chDraft, setChDraft] = useState<{ teamsWebhookUrl: string; slackBotToken: string; slackChannel: string }>({
    teamsWebhookUrl: "", slackBotToken: "", slackChannel: "",
  });

  const showToast = (msg: string, ok = true) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 4000);
  };

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [cfg, rls, hist] = await Promise.all([
        apiFetch("/api/alerts/config").then((r) => r.json()),
        apiFetch("/api/alerts/rules").then((r) => r.json()),
        apiFetch("/api/alerts/history").then((r) => r.json()),
      ]);
      setConfig(cfg);
      setDraft(cfg);
      setChDraft({ teamsWebhookUrl: "", slackBotToken: "", slackChannel: cfg.slackChannel ?? "" });
      setRules(rls);
      setRuleDrafts(Object.fromEntries(rls.map((r: AlertRule) => [r.category, r])));
      setHistory(hist);
    } catch {
      showToast(t("settings.alerts.load_error"), false);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { loadAll(); }, [loadAll]);

  async function saveConfig() {
    setSaving(true);
    try {
      const res = await apiFetch("/api/alerts/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled:           draft.enabled,
          sendTimeHour:      draft.sendTimeHour,
          sendTimeMinute:    draft.sendTimeMinute,
          timezone:          draft.timezone,
          locale:            draft.locale,
          recipients:        draft.recipients,
          sendAllClear:      draft.sendAllClear,
          suppressUnchanged: draft.suppressUnchanged,
        }),
      });
      if (!res.ok) throw new Error();
      const updated = await res.json();
      setConfig(updated);
      setDraft(updated);
      showToast(t("settings.alerts.config_saved"));
    } catch {
      showToast(t("settings.alerts.save_error"), false);
    } finally {
      setSaving(false);
    }
  }

  async function saveChannels() {
    setSaving(true);
    try {
      // COALESCE on the backend keeps the existing value when a field is null,
      // so we only send the secrets when the admin actually typed something.
      const body: Record<string, string | null> = { slackChannel: chDraft.slackChannel.trim() || null };
      if (chDraft.teamsWebhookUrl.trim()) body.teamsWebhookUrl = chDraft.teamsWebhookUrl.trim();
      if (chDraft.slackBotToken.trim())   body.slackBotToken   = chDraft.slackBotToken.trim();
      const res = await apiFetch("/api/alerts/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error();
      showToast(t("settings.alerts.channels_saved"));
      setChDraft((d) => ({ ...d, teamsWebhookUrl: "", slackBotToken: "" }));
      loadAll();
    } catch {
      showToast(t("settings.alerts.save_error"), false);
    } finally {
      setSaving(false);
    }
  }

  async function saveRule(category: string) {
    const rd = ruleDrafts[category];
    if (!rd) return;
    try {
      const res = await apiFetch(`/api/alerts/rules/${category}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled:    rd.enabled,
          warnDays:   rd.warnDays,
          recipients: rd.recipients ?? [],
        }),
      });
      if (!res.ok) throw new Error();
      const updated = await res.json();
      setRules((prev) => prev.map((r) => r.category === category ? updated : r));
      setRuleDrafts((prev) => ({ ...prev, [category]: updated }));
      showToast(t("settings.alerts.rule_saved"));
    } catch {
      showToast(t("settings.alerts.save_error"), false);
    }
  }

  async function sendTest() {
    setSaving(true);
    try {
      const res = await apiFetch("/api/alerts/test", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "error");
      showToast(`${t("settings.alerts.test_ok")} ${data.messageId ?? ""}`);
      loadAll();
    } catch (e) {
      showToast(`${t("settings.alerts.test_fail")}: ${e instanceof Error ? e.message : "error"}`, false);
    } finally {
      setSaving(false);
    }
  }

  async function runNow() {
    setSaving(true);
    try {
      const res = await apiFetch("/api/alerts/run-now", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "error");
      showToast(`${t("settings.alerts.run_ok")} (${data.status}, ${data.totalAlerts} alertas)`);
      loadAll();
    } catch (e) {
      showToast(`${t("settings.alerts.run_fail")}: ${e instanceof Error ? e.message : "error"}`, false);
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24 text-slate-400 gap-2">
        <Loader2 className="h-5 w-5 animate-spin" />
        <span className="text-sm">{t("settings.alerts.loading")}</span>
      </div>
    );
  }

  const hours   = Array.from({ length: 24 }, (_, i) => i);
  const minutes = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];

  return (
    <div className="space-y-8">
      {/* Toast */}
      {toast && (
        <div className={`fixed bottom-6 right-6 z-50 flex items-center gap-2 rounded-xl px-4 py-3 text-sm font-medium shadow-lg ${toast.ok ? "bg-green-600 text-white" : "bg-red-600 text-white"}`}>
          {toast.ok ? <CheckCircle className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
          {toast.msg}
        </div>
      )}

      {/* SMTP Status */}
      <section className="rounded-xl border border-slate-200 bg-white p-6">
        <div className="flex items-center gap-3 mb-4">
          <Mail className="h-5 w-5 text-slate-400" />
          <h2 className="text-base font-semibold text-slate-900">{t("settings.alerts.smtp_title")}</h2>
        </div>
        <div className="flex items-center gap-4 flex-wrap">
          {config?.smtpConfigured ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-green-100 px-3 py-1 text-sm font-medium text-green-700">
              <span className="h-2 w-2 rounded-full bg-green-500" />
              {t("settings.alerts.smtp_ok")}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-red-100 px-3 py-1 text-sm font-medium text-red-700">
              <span className="h-2 w-2 rounded-full bg-red-500" />
              {t("settings.alerts.smtp_missing")}
            </span>
          )}
          {config?.smtpHost && (
            <span className="text-sm text-slate-500">{config.smtpHost}:{config.smtpPort ?? "—"}</span>
          )}
          <p className="text-xs text-slate-400 w-full mt-1">{t("settings.alerts.smtp_note")}</p>
        </div>
      </section>

      {/* Global Config */}
      <section className="rounded-xl border border-slate-200 bg-white p-6">
        <div className="flex items-center gap-3 mb-5">
          <Bell className="h-5 w-5 text-slate-400" />
          <h2 className="text-base font-semibold text-slate-900">{t("settings.alerts.config_title")}</h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {/* Enable toggle */}
          <label className="flex items-center justify-between rounded-lg border border-slate-200 px-4 py-3 cursor-pointer hover:bg-slate-50">
            <div>
              <p className="text-sm font-medium text-slate-800">{t("settings.alerts.enabled")}</p>
              <p className="text-xs text-slate-500">{t("settings.alerts.enabled_hint")}</p>
            </div>
            <button
              disabled={!isAdmin}
              onClick={() => setDraft((d) => ({ ...d, enabled: !d.enabled }))}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${draft.enabled ? "bg-indigo-600" : "bg-slate-300"} ${!isAdmin ? "opacity-50 cursor-not-allowed" : ""}`}
            >
              <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${draft.enabled ? "translate-x-6" : "translate-x-1"}`} />
            </button>
          </label>

          {/* Send time */}
          <div className="rounded-lg border border-slate-200 px-4 py-3">
            <div className="flex items-center gap-1 mb-1">
              <Clock className="h-3.5 w-3.5 text-slate-400" />
              <p className="text-sm font-medium text-slate-800">{t("settings.alerts.send_time")}</p>
            </div>
            <div className="flex gap-2">
              <select
                disabled={!isAdmin}
                value={draft.sendTimeHour ?? 8}
                onChange={(e) => setDraft((d) => ({ ...d, sendTimeHour: parseInt(e.target.value, 10) }))}
                className="flex-1 rounded-md border border-slate-200 bg-slate-50 px-2 py-1.5 text-sm text-slate-700 disabled:opacity-50"
              >
                {hours.map((h) => (
                  <option key={h} value={h}>{String(h).padStart(2, "0")}h</option>
                ))}
              </select>
              <select
                disabled={!isAdmin}
                value={draft.sendTimeMinute ?? 30}
                onChange={(e) => setDraft((d) => ({ ...d, sendTimeMinute: parseInt(e.target.value, 10) }))}
                className="flex-1 rounded-md border border-slate-200 bg-slate-50 px-2 py-1.5 text-sm text-slate-700 disabled:opacity-50"
              >
                {minutes.map((m) => (
                  <option key={m} value={m}>{String(m).padStart(2, "0")}m</option>
                ))}
              </select>
            </div>
          </div>

          {/* Timezone */}
          <div className="rounded-lg border border-slate-200 px-4 py-3">
            <div className="flex items-center gap-1 mb-1">
              <Globe className="h-3.5 w-3.5 text-slate-400" />
              <p className="text-sm font-medium text-slate-800">{t("settings.alerts.timezone")}</p>
            </div>
            <select
              disabled={!isAdmin}
              value={draft.timezone ?? "UTC"}
              onChange={(e) => setDraft((d) => ({ ...d, timezone: e.target.value }))}
              className="w-full rounded-md border border-slate-200 bg-slate-50 px-2 py-1.5 text-sm text-slate-700 disabled:opacity-50"
            >
              {TIMEZONES.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
            </select>
          </div>

          {/* Email locale */}
          <div className="rounded-lg border border-slate-200 px-4 py-3">
            <p className="text-sm font-medium text-slate-800 mb-1">{t("settings.alerts.email_locale")}</p>
            <div className="flex flex-wrap gap-2">
              {LOCALES.map((lc) => (
                <button
                  key={lc.code}
                  disabled={!isAdmin}
                  onClick={() => setDraft((d) => ({ ...d, locale: lc.code }))}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium border transition-colors disabled:opacity-50 ${
                    draft.locale === lc.code
                      ? "bg-indigo-600 border-indigo-600 text-white"
                      : "border-slate-200 text-slate-600 hover:border-indigo-400"
                  }`}
                >
                  {lc.label}
                </button>
              ))}
            </div>
          </div>

          {/* sendAllClear toggle */}
          <label className="flex items-center justify-between rounded-lg border border-slate-200 px-4 py-3 cursor-pointer hover:bg-slate-50">
            <div>
              <p className="text-sm font-medium text-slate-800">{t("settings.alerts.send_all_clear")}</p>
              <p className="text-xs text-slate-500">{t("settings.alerts.send_all_clear_hint")}</p>
            </div>
            <button
              disabled={!isAdmin}
              onClick={() => setDraft((d) => ({ ...d, sendAllClear: !d.sendAllClear }))}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${draft.sendAllClear ? "bg-indigo-600" : "bg-slate-300"} ${!isAdmin ? "opacity-50 cursor-not-allowed" : ""}`}
            >
              <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${draft.sendAllClear ? "translate-x-6" : "translate-x-1"}`} />
            </button>
          </label>

          {/* suppressUnchanged toggle */}
          <label className="flex items-center justify-between rounded-lg border border-slate-200 px-4 py-3 cursor-pointer hover:bg-slate-50">
            <div>
              <p className="text-sm font-medium text-slate-800">{t("settings.alerts.suppress_unchanged")}</p>
              <p className="text-xs text-slate-500">{t("settings.alerts.suppress_unchanged_hint")}</p>
            </div>
            <button
              disabled={!isAdmin}
              onClick={() => setDraft((d) => ({ ...d, suppressUnchanged: !d.suppressUnchanged }))}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${draft.suppressUnchanged ? "bg-indigo-600" : "bg-slate-300"} ${!isAdmin ? "opacity-50 cursor-not-allowed" : ""}`}
            >
              <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${draft.suppressUnchanged ? "translate-x-6" : "translate-x-1"}`} />
            </button>
          </label>

          {/* Global recipients */}
          <div className="md:col-span-2 rounded-lg border border-slate-200 px-4 py-3">
            <p className="text-sm font-medium text-slate-800 mb-2">{t("settings.alerts.global_recipients")}</p>
            <RecipientsEditor
              value={draft.recipients ?? []}
              onChange={(v) => setDraft((d) => ({ ...d, recipients: v }))}
              disabled={!isAdmin}
            />
            <p className="text-xs text-slate-400 mt-1">{t("settings.alerts.global_recipients_hint")}</p>
          </div>
        </div>

        {isAdmin && (
          <div className="mt-5 flex justify-end">
            <button
              onClick={saveConfig}
              disabled={saving}
              className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors"
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {t("settings.alerts.save_config")}
            </button>
          </div>
        )}
      </section>

      {/* Notification Channels (Teams / Slack) — T8 */}
      <section className="rounded-xl border border-slate-200 bg-white p-6">
        <div className="flex items-center gap-3 mb-1">
          <MessageSquare className="h-5 w-5 text-slate-400" />
          <h2 className="text-base font-semibold text-slate-900">{t("settings.alerts.channels_title")}</h2>
        </div>
        <p className="text-xs text-slate-400 mb-5">{t("settings.alerts.channels_note")}</p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {/* Teams webhook */}
          <div className="md:col-span-2 rounded-lg border border-slate-200 px-4 py-3">
            <div className="flex items-center justify-between mb-1">
              <p className="text-sm font-medium text-slate-800">{t("settings.alerts.teams_webhook")}</p>
              {config?.teamsConfigured ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-semibold text-green-700">
                  <span className="h-1.5 w-1.5 rounded-full bg-green-500" />{t("settings.alerts.channel_configured")}
                </span>
              ) : (
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-500">{t("settings.alerts.channel_not_configured")}</span>
              )}
            </div>
            <input
              type="url"
              disabled={!isAdmin}
              value={chDraft.teamsWebhookUrl}
              onChange={(e) => setChDraft((d) => ({ ...d, teamsWebhookUrl: e.target.value }))}
              placeholder="https://…webhook.office.com/webhookb2/…"
              className="w-full rounded-md border border-slate-200 bg-slate-50 px-2 py-1.5 text-sm text-slate-700 disabled:opacity-50"
            />
            <p className="text-xs text-slate-400 mt-1">{t("settings.alerts.teams_webhook_hint")}</p>
          </div>

          {/* Slack bot token */}
          <div className="rounded-lg border border-slate-200 px-4 py-3">
            <div className="flex items-center justify-between mb-1">
              <p className="text-sm font-medium text-slate-800">{t("settings.alerts.slack_token")}</p>
              {config?.slackConfigured ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-semibold text-green-700">
                  <span className="h-1.5 w-1.5 rounded-full bg-green-500" />{t("settings.alerts.channel_configured")}
                </span>
              ) : (
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-500">{t("settings.alerts.channel_not_configured")}</span>
              )}
            </div>
            <input
              type="password"
              autoComplete="new-password"
              disabled={!isAdmin}
              value={chDraft.slackBotToken}
              onChange={(e) => setChDraft((d) => ({ ...d, slackBotToken: e.target.value }))}
              placeholder="xoxb-…"
              className="w-full rounded-md border border-slate-200 bg-slate-50 px-2 py-1.5 text-sm text-slate-700 disabled:opacity-50"
            />
            <p className="text-xs text-slate-400 mt-1">{t("settings.alerts.slack_token_hint")}</p>
          </div>

          {/* Slack channel */}
          <div className="rounded-lg border border-slate-200 px-4 py-3">
            <p className="text-sm font-medium text-slate-800 mb-1">{t("settings.alerts.slack_channel")}</p>
            <input
              type="text"
              disabled={!isAdmin}
              value={chDraft.slackChannel}
              onChange={(e) => setChDraft((d) => ({ ...d, slackChannel: e.target.value }))}
              placeholder="#alerts"
              className="w-full rounded-md border border-slate-200 bg-slate-50 px-2 py-1.5 text-sm text-slate-700 disabled:opacity-50"
            />
            <p className="text-xs text-slate-400 mt-1">{t("settings.alerts.slack_channel_hint")}</p>
          </div>
        </div>

        {isAdmin && (
          <div className="mt-5 flex justify-end">
            <button
              onClick={saveChannels}
              disabled={saving}
              className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors"
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {t("settings.alerts.save_channels")}
            </button>
          </div>
        )}
      </section>

      {/* Rules table */}
      <section className="rounded-xl border border-slate-200 bg-white p-6">
        <h2 className="text-base font-semibold text-slate-900 mb-4">{t("settings.alerts.rules_title")}</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100">
                <th className="text-left py-2 px-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">{t("settings.alerts.col_category")}</th>
                <th className="text-center py-2 px-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">{t("settings.alerts.col_enabled")}</th>
                <th className="text-left py-2 px-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">{t("settings.alerts.col_warn_days")}</th>
                <th className="text-left py-2 px-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">{t("settings.alerts.col_recipients")}</th>
                {isAdmin && <th className="py-2 px-3" />}
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => {
                const rd = ruleDrafts[rule.category] ?? rule;
                const meta = CATEGORIES[rule.category] ?? { icon: "📌", color: "text-slate-700" };
                return (
                  <tr key={rule.category} className="border-b border-slate-50 hover:bg-slate-50">
                    <td className="py-3 px-3">
                      <span className={`font-medium ${meta.color}`}>{meta.icon} {rule.category}</span>
                    </td>
                    <td className="py-3 px-3 text-center">
                      <button
                        disabled={!isAdmin}
                        onClick={() => setRuleDrafts((p) => ({ ...p, [rule.category]: { ...rd, enabled: !rd.enabled } }))}
                        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${rd.enabled ? "bg-indigo-600" : "bg-slate-300"} ${!isAdmin ? "opacity-50 cursor-not-allowed" : ""}`}
                      >
                        <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${rd.enabled ? "translate-x-4" : "translate-x-0.5"}`} />
                      </button>
                    </td>
                    <td className="py-3 px-3">
                      {rule.category === "vulnerability" ? (
                        <span className="text-xs text-slate-400">{t("settings.alerts.vuln_no_threshold")}</span>
                      ) : (
                        <input
                          type="number"
                          disabled={!isAdmin}
                          min={0}
                          max={3650}
                          value={rd.warnDays ?? 30}
                          onChange={(e) => setRuleDrafts((p) => ({ ...p, [rule.category]: { ...rd, warnDays: parseInt(e.target.value, 10) || 0 } }))}
                          className="w-20 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-sm text-slate-700 disabled:opacity-50"
                        />
                      )}
                    </td>
                    <td className="py-3 px-3 min-w-[200px]">
                      <RecipientsEditor
                        value={rd.recipients ?? []}
                        onChange={(v) => setRuleDrafts((p) => ({ ...p, [rule.category]: { ...rd, recipients: v } }))}
                        disabled={!isAdmin}
                      />
                    </td>
                    {isAdmin && (
                      <td className="py-3 px-3">
                        <button
                          onClick={() => saveRule(rule.category)}
                          disabled={saving}
                          className="rounded-md bg-indigo-50 px-3 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-100 transition-colors disabled:opacity-50"
                        >
                          {t("settings.alerts.save_rule")}
                        </button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* Actions */}
      {isAdmin && (
        <section className="rounded-xl border border-slate-200 bg-white p-6">
          <h2 className="text-base font-semibold text-slate-900 mb-4">{t("settings.alerts.actions_title")}</h2>
          <div className="flex flex-wrap gap-3">
            <button
              onClick={sendTest}
              disabled={saving || !config?.smtpConfigured}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 transition-colors"
              title={!config?.smtpConfigured ? t("settings.alerts.smtp_missing") : ""}
            >
              <Mail className="h-4 w-4" />
              {t("settings.alerts.test_btn")}
            </button>
            <button
              onClick={runNow}
              disabled={saving}
              className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              {t("settings.alerts.run_now_btn")}
            </button>
            <button
              onClick={loadAll}
              disabled={loading}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 transition-colors"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
              {t("settings.alerts.refresh")}
            </button>
          </div>
        </section>
      )}

      {/* History */}
      <section className="rounded-xl border border-slate-200 bg-white p-6">
        <h2 className="text-base font-semibold text-slate-900 mb-4">{t("settings.alerts.history_title")}</h2>
        {history.length === 0 ? (
          <p className="text-sm text-slate-400 text-center py-8">{t("settings.alerts.history_empty")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100">
                  <th className="text-left py-2 px-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">{t("settings.alerts.col_date")}</th>
                  <th className="text-left py-2 px-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">{t("settings.alerts.col_trigger")}</th>
                  <th className="text-left py-2 px-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">{t("settings.alerts.col_status")}</th>
                  <th className="text-right py-2 px-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">{t("settings.alerts.col_total")}</th>
                  <th className="text-left py-2 px-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">{t("settings.alerts.col_msg_id")}</th>
                </tr>
              </thead>
              <tbody>
                {history.slice(0, 50).map((run) => (
                  <tr key={run.id} className="border-b border-slate-50 hover:bg-slate-50">
                    <td className="py-2 px-3 text-slate-600 whitespace-nowrap">
                      {new Date(run.startedAt).toLocaleString()}
                    </td>
                    <td className="py-2 px-3">
                      <span className={`text-xs font-medium ${run.trigger === "MANUAL" ? "text-indigo-600" : "text-slate-500"}`}>
                        {run.trigger}
                      </span>
                    </td>
                    <td className="py-2 px-3"><RunStatusBadge status={run.status} /></td>
                    <td className="py-2 px-3 text-right font-mono text-slate-700">{run.totalAlerts}</td>
                    <td className="py-2 px-3 text-xs text-slate-400 font-mono truncate max-w-[200px]">
                      {run.errorMsg
                        ? <span className="text-red-500">{run.errorMsg}</span>
                        : (run.messageId ?? "—")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
