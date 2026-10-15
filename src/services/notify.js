// Email notifications for invites, password resets, leave and tickets.
// Notifications are best-effort: they run after the change is saved and never fail the request.
import { query, one } from '../db/pg.js';
import { sendMail, render, mailEnabled, appUrl } from '../lib/mailer.js';

const inflight = new Set();
/** Waits for queued notifications (used by tests). */
export async function flushNotifications() { await Promise.allSettled([...inflight]); }

function queue(fn) {
  if (!mailEnabled()) return;
  const p = fn().catch((e) => console.error('[notify]', e.message)).finally(() => inflight.delete(p));
  inflight.add(p);
}

async function companyOf(companyId) {
  const c = await one('SELECT name, settings FROM companies WHERE id = $1', [companyId]);
  return { name: c?.name || 'your company', on: c?.settings?.emailNotifications !== false };
}
const first = (n) => String(n || '').split(' ')[0];
const range = (r) => (fmt(r.start_date) === fmt(r.end_date) ? fmt(r.start_date) : `${fmt(r.start_date)} to ${fmt(r.end_date)}`);
function fmt(d) {
  const x = new Date(`${String(d).slice(0, 10)}T00:00:00Z`);
  return x.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}
async function hrPeople(companyId, exceptId) {
  return query("SELECT name, email FROM people WHERE company_id = $1 AND access = 'hr' AND status = 'Active' AND id <> $2", [companyId, exceptId || '00000000-0000-0000-0000-000000000000']);
}

// ---------- accounts (sent on request, so they return the result) ----------
export async function sendInviteEmail({ person, companyName, link, reset = false }) {
  const { text, html } = reset
    ? render({ heading: `Reset your ${companyName} PeopleOS password`, lines: [`Hi ${first(person.name)},`, 'Use the button below to choose a new password. The link works once.'], button: { label: 'Choose a new password', url: link }, footer: "If you didn't ask for this, you can ignore this email. Your password stays the same." })
    : render({ heading: `You're invited to ${companyName}'s HR assistant`, lines: [`Hi ${first(person.name)},`, `${companyName} uses PeopleOS for leave, HR policies and helpdesk tickets. Ask questions in plain English or Hinglish, request leave and track it in one place.`, 'Set your password to get started. The link works once and expires in 14 days.'], button: { label: 'Set your password', url: link } });
  return sendMail({ to: { email: person.email, name: person.name }, subject: reset ? 'Reset your PeopleOS password' : `Join ${companyName} on PeopleOS`, text, html, fromName: companyName });
}

// ---------- leave ----------
export function leaveRequested(requestId) {
  queue(async () => {
    const r = await one(`SELECT r.*, p.name, p.company_id, p.manager_id, m.name AS m_name, m.email AS m_email, m.status AS m_status
                         FROM leave_requests r JOIN people p ON p.id = r.person_id LEFT JOIN people m ON m.id = p.manager_id WHERE r.id = $1`, [requestId]);
    if (!r || r.status !== 'Pending') return;
    const c = await companyOf(r.company_id);
    if (!c.on) return;
    const to = r.m_email && r.m_status === 'Active' ? [{ email: r.m_email, name: r.m_name }] : await hrPeople(r.company_id, r.person_id);
    const { text, html } = render({
      heading: `${r.name} requested ${r.leave_type.toLowerCase()} leave`,
      lines: [`${r.leave_type} leave · ${range(r)} · ${r.days} working day${r.days > 1 ? 's' : ''}`, r.reason ? `Reason: "${r.reason}"` : null, 'Approve or reject it from PeopleOS.'].filter(Boolean),
      button: { label: 'Review the request', url: `${appUrl()}/app` },
    });
    await sendMail({ to, subject: `Leave request from ${r.name}: ${range(r)}`, text, html, fromName: c.name });
  });
}

export function leaveDecided(requestId) {
  queue(async () => {
    const r = await one(`SELECT r.*, p.name, p.email, p.company_id, d.name AS d_name FROM leave_requests r
                         JOIN people p ON p.id = r.person_id LEFT JOIN people d ON d.id = r.decided_by WHERE r.id = $1`, [requestId]);
    if (!r || !['Approved', 'Rejected'].includes(r.status)) return;
    const c = await companyOf(r.company_id);
    if (!c.on) return;
    const ok = r.status === 'Approved';
    const { text, html } = render({
      heading: `Your leave was ${ok ? 'approved' : 'not approved'}`,
      lines: [`Hi ${first(r.name)},`, `${r.leave_type} leave · ${range(r)} · ${r.days} working day${r.days > 1 ? 's' : ''}`, `${ok ? 'Approved' : 'Rejected'}${r.d_name ? ` by ${r.d_name}` : ''}.`, r.decision_note ? `Note: "${r.decision_note}"` : null].filter(Boolean),
      button: { label: 'Open PeopleOS', url: `${appUrl()}/app` },
    });
    await sendMail({ to: { email: r.email, name: r.name }, subject: `Leave ${ok ? 'approved' : 'rejected'}: ${range(r)}`, text, html, fromName: c.name });
  });
}

// ---------- tickets ----------
export function ticketRaised(ticketId) {
  queue(async () => {
    const t = await one('SELECT t.*, p.name FROM tickets t JOIN people p ON p.id = t.person_id WHERE t.id = $1', [ticketId]);
    if (!t) return;
    const c = await companyOf(t.company_id);
    if (!c.on) return;
    const to = await hrPeople(t.company_id, t.person_id);
    const confidential = t.category === 'Confidential';
    const { text, html } = render({
      heading: confidential ? `Confidential ticket #${t.id} from ${t.name}` : `New ${t.category} ticket #${t.id} from ${t.name}`,
      lines: confidential
        ? ['Someone asked for confidential help. The details are not included in this email. Reach out to them directly and handle it sensitively.']
        : [`"${t.description}"`, `Priority: ${t.priority}`],
      button: { label: 'Open tickets', url: `${appUrl()}/admin#tickets` },
    });
    await sendMail({ to, subject: confidential ? `Confidential ticket #${t.id}` : `Ticket #${t.id} (${t.category}): ${t.description.slice(0, 60)}`, text, html, fromName: c.name });
  });
}

export function ticketUpdated(ticketId) {
  queue(async () => {
    const t = await one('SELECT t.*, p.name, p.email FROM tickets t JOIN people p ON p.id = t.person_id WHERE t.id = $1', [ticketId]);
    if (!t) return;
    const c = await companyOf(t.company_id);
    if (!c.on) return;
    const { text, html } = render({
      heading: `Your ticket #${t.id} is ${t.status.toLowerCase()}`,
      lines: [`Hi ${first(t.name)},`, t.category === 'Confidential' ? 'There is an update on your confidential request.' : `"${t.description}"`, t.resolution ? `HR replied: "${t.resolution}"` : null].filter(Boolean),
      button: { label: 'Open PeopleOS', url: `${appUrl()}/app` },
    });
    await sendMail({ to: { email: t.email, name: t.name }, subject: `Ticket #${t.id}: ${t.status}`, text, html, fromName: c.name });
  });
}
