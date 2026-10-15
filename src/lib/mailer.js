// Outgoing email over an HTTP API (Render's free plan blocks SMTP ports, so no SMTP here).
//   BREVO_API_KEY + MAIL_FROM   → Brevo (free 300 emails/day; MAIL_FROM can be a verified Gmail address)
//   RESEND_API_KEY + MAIL_FROM  → Resend (needs a verified domain to email anyone but yourself)
//   MAIL_TRANSPORT=memory       → kept in `outbox` (tests)
// With none of these, email is off and the app falls back to copyable links.

export const outbox = [];
let rememberedOrigin = null;

export function mailProvider() {
  if (process.env.MAIL_TRANSPORT === 'memory') return 'memory';
  if (!process.env.MAIL_FROM) return null;
  if (process.env.BREVO_API_KEY) return 'brevo';
  if (process.env.RESEND_API_KEY) return 'resend';
  return null;
}
export const mailEnabled = () => !!mailProvider();

/** Base URL for links in emails: PUBLIC_URL, else the first origin the server saw. */
export const appUrl = () => process.env.PUBLIC_URL?.replace(/\/$/, '') || rememberedOrigin || 'http://localhost:3000';
export function rememberOrigin(o) { if (o) rememberedOrigin = o; }

function parseFrom(s) {
  const m = String(s).match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  return m ? { name: m[1].replace(/^"|"$/g, ''), email: m[2] } : { name: 'PeopleOS', email: String(s).trim() };
}

const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** A plain, readable email: a few paragraphs and at most one button. */
export function render({ heading, lines = [], button, footer }) {
  const text = [heading, '', ...lines, ...(button ? ['', `${button.label}: ${button.url}`] : []), ...(footer ? ['', footer] : [])].join('\n');
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f3f5f8;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#18202b">
<div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #e2e6ec;border-radius:12px;padding:28px">
<h1 style="font-size:19px;margin:0 0 14px">${escHtml(heading)}</h1>
${lines.map((l) => `<p style="font-size:15px;line-height:1.55;margin:0 0 10px">${escHtml(l)}</p>`).join('')}
${button ? `<p style="margin:20px 0 6px"><a href="${escHtml(button.url)}" style="display:inline-block;background:#18202b;color:#fff;text-decoration:none;padding:11px 18px;border-radius:8px;font-weight:600;font-size:15px">${escHtml(button.label)}</a></p>
<p style="font-size:12.5px;color:#5b6676;margin:10px 0 0;word-break:break-all">Or open: ${escHtml(button.url)}</p>` : ''}
${footer ? `<p style="font-size:12.5px;color:#5b6676;margin:18px 0 0">${escHtml(footer)}</p>` : ''}
</div><p style="text-align:center;font-size:12px;color:#8a93a0;margin:14px 0 0">Sent by PeopleOS</p></body></html>`;
  return { text, html };
}

/** Sends one email. Never throws: returns { ok, error }. */
export async function sendMail({ to, subject, text, html, fromName, replyTo }) {
  const provider = mailProvider();
  if (!provider) return { ok: false, error: 'Email is not set up on this server.' };
  const recipients = (Array.isArray(to) ? to : [to]).filter((r) => r?.email);
  if (!recipients.length) return { ok: false, error: 'No recipient.' };
  if (provider === 'memory') { outbox.push({ to: recipients.map((r) => r.email), subject, text, html }); return { ok: true }; }

  const from = parseFrom(process.env.MAIL_FROM);
  const name = fromName ? `${fromName} via PeopleOS`.slice(0, 70) : from.name;
  try {
    let r;
    if (provider === 'brevo') {
      r = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': process.env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ sender: { name, email: from.email }, to: recipients.map((x) => ({ email: x.email, name: x.name || undefined })), subject, textContent: text, htmlContent: html, ...(replyTo ? { replyTo: { email: replyTo } } : {}) }),
        signal: AbortSignal.timeout(10_000),
      });
    } else {
      r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from: `${name} <${from.email}>`, to: recipients.map((x) => x.email), subject, text, html, ...(replyTo ? { reply_to: replyTo } : {}) }),
        signal: AbortSignal.timeout(10_000),
      });
    }
    if (!r.ok) {
      const body = (await r.text()).slice(0, 300);
      console.error(`[mail] ${provider} ${r.status}: ${body}`);
      return { ok: false, error: `The email service refused the message (${r.status}).` };
    }
    return { ok: true };
  } catch (e) {
    console.error(`[mail] ${provider}: ${e.message}`);
    return { ok: false, error: 'Could not reach the email service.' };
  }
}
