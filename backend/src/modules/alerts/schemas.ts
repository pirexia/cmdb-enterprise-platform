import { z } from 'zod';

export const ALERT_CATEGORIES = [
  'eol', 'eos', 'warranty', 'maintenance', 'contract', 'vulnerability', 'license',
] as const;
export type AlertCategory = typeof ALERT_CATEGORIES[number];

export const ALERT_LOCALES = ['es', 'en', 'de', 'pt', 'fr', 'it'] as const;
export type AlertLocale = typeof ALERT_LOCALES[number];

const NOTIFY_CHANNELS = ['email', 'teams', 'slack'] as const;

export const AlertConfigUpdateSchema = z.object({
  enabled:           z.boolean().optional(),
  sendTimeHour:      z.number().int().min(0).max(23).optional(),
  sendTimeMinute:    z.number().int().min(0).max(59).optional(),
  timezone:          z.string().min(1).max(64).optional(),
  locale:            z.enum(ALERT_LOCALES).optional(),
  recipients:        z.array(z.string().email()).optional(),
  sendAllClear:      z.boolean().optional(),
  suppressUnchanged: z.boolean().optional(),
  // Notification channels (T8)
  teamsWebhookUrl:   z.string().url().max(2048).nullable().optional(),
  slackBotToken:     z.string().max(512).nullable().optional(),
  slackChannel:      z.string().max(255).nullable().optional(),
});
export type AlertConfigUpdate = z.infer<typeof AlertConfigUpdateSchema>;

export const AlertRuleUpdateSchema = z.object({
  enabled:    z.boolean().optional(),
  warnDays:   z.number().int().min(0).max(3650).optional(),
  recipients: z.array(z.string().email()).optional(),
  channels:   z.array(z.enum(NOTIFY_CHANNELS)).optional(),
});
export type AlertRuleUpdate = z.infer<typeof AlertRuleUpdateSchema>;

export const CategoryParamSchema = z.object({
  category: z.enum(ALERT_CATEGORIES),
});

export interface AlertItem {
  entityId:   string;
  entityName: string;
  category:   AlertCategory;
  dateValue:  Date | null;
  daysLeft:   number | null;
  severity:   'expired' | 'critical' | 'warning' | 'open';
  detail:     string;
}

export interface ScanResult {
  items:       AlertItem[];
  breakdown:   Record<string, number>;
  fingerprint: string;
  scannedAt:   Date;
}
