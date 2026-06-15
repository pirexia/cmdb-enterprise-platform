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
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER);
}
