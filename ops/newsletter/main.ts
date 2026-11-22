import nodemailer from 'nodemailer';
import { readFileSync } from 'node:fs';
import { createNewsletterServer } from './server.mjs';
import {
  newsletterDeliveryReady, newsletterRequestSchema, requestNewsletterSubscription,
  confirmNewsletterSubscription, unsubscribeNewsletter, NewsletterConfirmationError,
} from '../../woek-parlament-app/lib/woek-newsletter/subscriptions';

// The established domain mailbox is loaded from a private systemd EnvironmentFile.
// The existing subscription database, templates and consent records stay intact.
let smtpReady = false;
let checking = false;
async function checkSmtp() {
  if (checking) return;
  checking = true;
  const transport = nodemailer.createTransport({
    host: process.env.WOEK_NEWSLETTER_SMTP_HOST,
    port: Number(process.env.WOEK_NEWSLETTER_SMTP_PORT || 587),
    secure: false, requireTLS: true,
    auth: { user: process.env.WOEK_NEWSLETTER_SMTP_USER, pass: process.env.WOEK_NEWSLETTER_SMTP_PASSWORD },
    tls: { minVersion: 'TLSv1.2' },
    connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000,
  });
  try { await transport.verify(); smtpReady = true; }
  catch { smtpReady = false; console.error('newsletter_smtp_auth_failed'); }
  finally { transport.close(); checking = false; }
}
await checkSmtp();
setInterval(checkSmtp, 5 * 60_000).unref();

const server = createNewsletterServer({
  ready: () => smtpReady && newsletterDeliveryReady(),
  parse: (input: unknown) => newsletterRequestSchema.parse(input),
  subscribe: requestNewsletterSubscription,
  confirm: confirmNewsletterSubscription,
  unsubscribe: unsubscribeNewsletter,
  isConfirmationError: (error: unknown) => error instanceof NewsletterConfirmationError,
  onDeliveryFailure: () => { smtpReady = false; void checkSmtp(); },
  client: readFileSync(new URL('./client.js', import.meta.url), 'utf8'),
});
server.listen(Number(process.env.PORT || 8793), '127.0.0.1');
