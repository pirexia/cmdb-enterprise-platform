import nodemailer from 'nodemailer';

export interface SendResult {
  messageId: string;
  accepted:  string[];
}

export async function sendEmail(
  html:       string,
  subject:    string,
  recipients: string[],
): Promise<SendResult> {
  if (recipients.length === 0) {
    throw new Error('No recipients configured for alert email');
  }

  // Read SMTP config from ENV at call time so hot-config changes take effect
  const host   = process.env.SMTP_HOST   ?? 'smtp.gmail.com';
  const port   = parseInt(process.env.SMTP_PORT ?? '587', 10);
  const secure = process.env.SMTP_SECURE === 'true';
  const user   = process.env.SMTP_USER   ?? '';
  const pass   = process.env.SMTP_PASS   ?? '';

  const transport = nodemailer.createTransport({
    host,
    port,
    secure,
    auth:      user ? { user, pass } : undefined,
    tls:       { rejectUnauthorized: process.env.NODE_ENV === 'production' },
  });

  const info = await transport.sendMail({
    from:    `"CMDB Alerts" <${user || 'cmdb-alerts@noreply.local'}>`,
    to:      recipients.join(', '),
    subject,
    html,
  });

  // Never log SMTP_PASS or the full transport config
  console.log(`[alerts:smtp] sent → msgId=${info.messageId} accepted=${(info.accepted as string[]).join(',')}`);

  return { messageId: info.messageId as string, accepted: info.accepted as string[] };
}

export function smtpConfigured(): boolean {
  // SMTP_HOST is the only hard requirement. SMTP_USER/SMTP_PASS are optional:
  // unauthenticated internal relays (e.g. a corporate mailscan on port 25 with no
  // AUTH) are a valid configuration — sendEmail() already handles an empty user by
  // omitting the auth block. Requiring SMTP_USER here wrongly flagged such relays as
  // "not configured".
  return Boolean(process.env.SMTP_HOST);
}
