// Leave and helpdesk tickets: the real workflows behind the agent's tools and the HR console.
import { query, one, tx } from '../db/pg.js';
import { TODAY, iso, parseISO, businessDays } from '../lib/dates.js';
import { bump } from '../lib/versions.js';
import { UserError, settingsOf, audit } from './company.js';

export const TICKET_CATEGORIES = ['IT', 'Payroll', 'Benefits', 'Facilities', 'HR Query', 'Confidential'];

// ---------------- leave ----------------
export async function balances(personId) {
  return query(`SELECT b.leave_type, b.balance,
                       COALESCE((SELECT sum(days) FROM leave_requests r WHERE r.person_id = b.person_id AND r.leave_type = b.leave_type AND r.status = 'Pending'), 0) AS pending
                FROM leave_balances b JOIN companies c ON c.id = b.company_id
                WHERE b.person_id = $1 AND c.settings -> 'leave' ? b.leave_type  -- only leave types the company still uses
                ORDER BY b.leave_type`, [personId]);
}

export async function myLeave(personId, limit = 10) {
  return query(`SELECT r.id AS request_id, r.leave_type, r.start_date, r.end_date, r.days, r.reason, r.status, r.decision_note, d.name AS decided_by
                FROM leave_requests r LEFT JOIN people d ON d.id = r.decided_by
                WHERE r.person_id = $1 ORDER BY r.start_date DESC LIMIT $2`, [personId, limit]);
}

/** Policy checks for a leave request. Returns an error string, or null when valid. */
export async function validateLeave(ctx, { leave_type, start_date, end_date }) {
  const s = settingsOf(ctx.company);
  const types = Object.keys(s.leave);
  if (!types.includes(leave_type)) return `Unknown leave type "${leave_type}". Your company has: ${types.join(', ')}.`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start_date || '') || !/^\d{4}-\d{2}-\d{2}$/.test(end_date || '')) return 'Dates must be YYYY-MM-DD.';
  const st = parseISO(start_date), en = parseISO(end_date), today = TODAY();
  if (Number.isNaN(st.getTime()) || Number.isNaN(en.getTime())) return 'Those dates are not valid.';
  if (en < st) return 'End date is before start date.';
  if ((en - st) / 864e5 > 120) return 'A single request can cover at most 120 days.';
  const days = businessDays(st, en);
  if (days === 0) return 'Those dates fall on a weekend, so no leave is needed.';
  const twoDaysAgo = new Date(today); twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
  const isSick = /sick/i.test(leave_type);
  if (!isSick && st < today) return `Only sick leave can be applied for past dates.`;
  if (isSick && st < twoDaysAgo) return 'Sick leave can be applied retroactively only within 2 days.';
  if (/earned|privilege|annual/i.test(leave_type) && s.earnedNoticeDays > 0) {
    const notice = businessDays(new Date(today.getTime() + 864e5), new Date(st.getTime() - 864e5));
    if (notice < s.earnedNoticeDays) return `${leave_type} leave needs ${s.earnedNoticeDays} working days notice. Try Casual leave for short notice.`;
  }
  const b = (await balances(ctx.user.id)).find((x) => x.leave_type === leave_type);
  const available = (b?.balance ?? 0) - (b?.pending ?? 0);
  if (available < days) return `Not enough ${leave_type} balance: need ${days}, have ${available}${b?.pending ? ` (${b.pending} already pending)` : ''}.`;
  const clash = await one(`SELECT id FROM leave_requests WHERE person_id = $1 AND status IN ('Pending', 'Approved')
                           AND NOT (end_date < $2::date OR start_date > $3::date)`, [ctx.user.id, start_date, end_date]);
  if (clash) return `Overlaps with your existing leave request #${clash.id}.`;
  return null;
}

export function leavePreview({ leave_type, start_date, end_date, reason }) {
  const days = businessDays(parseISO(start_date), parseISO(end_date));
  return `${leave_type} leave · ${start_date} → ${end_date} · ${days} working day${days > 1 ? 's' : ''}${reason ? ` · "${reason}"` : ''}`;
}

export async function applyLeave(ctx, args) {
  const err = await validateLeave(ctx, args);
  if (err) throw new UserError(err);
  const { leave_type, start_date, end_date } = args;
  const reason = String(args.reason || '').slice(0, 300);
  const days = businessDays(parseISO(start_date), parseISO(end_date));
  const s = settingsOf(ctx.company);
  const auto = s.autoApproveUpToDays > 0 && days <= s.autoApproveUpToDays;
  const id = await tx(async (t) => {
    const [r] = await t.query(`INSERT INTO leave_requests (company_id, person_id, leave_type, start_date, end_date, days, reason, status, decided_at, decision_note)
                               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [ctx.company.id, ctx.user.id, leave_type, start_date, end_date, days, reason, auto ? 'Approved' : 'Pending', auto ? new Date() : null, auto ? 'Auto-approved by company rule' : null]);
    if (auto) await t.query('UPDATE leave_balances SET balance = balance - $3 WHERE person_id = $1 AND leave_type = $2', [ctx.user.id, leave_type, days]);
    return r.id;
  });
  bump(ctx.company.id);
  const approver = auto ? null : await one(`SELECT m.name FROM people p JOIN people m ON m.id = p.manager_id WHERE p.id = $1`, [ctx.user.id]);
  const left = (await balances(ctx.user.id)).find((b) => b.leave_type === leave_type);
  return { request_id: id, status: auto ? 'Approved' : 'Pending', days, approver: approver?.name || (auto ? null : 'HR'), remaining_balance: left ? left.balance - left.pending : null };
}

/** Requests the actor can decide on: HR sees everyone, managers see their direct reports. */
export async function pendingApprovals(actor) {
  if (actor.access === 'employee') return [];
  return query(`SELECT r.id AS request_id, p.name, p.email, r.leave_type, r.start_date, r.end_date, r.days, r.reason, r.created_at,
                       (SELECT balance FROM leave_balances b WHERE b.person_id = r.person_id AND b.leave_type = r.leave_type) AS balance
                FROM leave_requests r JOIN people p ON p.id = r.person_id
                WHERE r.company_id = $1 AND r.status = 'Pending' AND r.person_id <> $2
                  AND ($3 = 'hr' OR p.manager_id = $2)
                ORDER BY r.start_date`, [actor.company_id, actor.id, actor.access]);
}

export async function decideLeave(actor, requestId, decision, note) {
  if (!['approve', 'reject'].includes(decision)) throw new UserError('Decision must be approve or reject.');
  const r = await one(`SELECT r.*, p.manager_id, p.name FROM leave_requests r JOIN people p ON p.id = r.person_id
                       WHERE r.id = $1 AND r.company_id = $2`, [requestId, actor.company_id]);
  if (!r) throw new UserError(`Leave request #${requestId} not found.`, 404);
  if (r.person_id === actor.id) throw new UserError("You can't approve your own leave.", 403);
  if (actor.access !== 'hr' && r.manager_id !== actor.id) throw new UserError('Only their manager or HR can decide on this request.', 403);
  if (r.status !== 'Pending') throw new UserError(`This request is already ${r.status.toLowerCase()}.`, 409);
  const status = decision === 'approve' ? 'Approved' : 'Rejected';
  await tx(async (t) => {
    if (status === 'Approved') {
      const [b] = await t.query('SELECT balance FROM leave_balances WHERE person_id = $1 AND leave_type = $2', [r.person_id, r.leave_type]);
      if (!b || b.balance < r.days) throw new UserError(`${r.name} no longer has enough ${r.leave_type} balance.`);
      await t.query('UPDATE leave_balances SET balance = balance - $3 WHERE person_id = $1 AND leave_type = $2', [r.person_id, r.leave_type, r.days]);
    }
    await t.query(`UPDATE leave_requests SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4 WHERE id = $1`,
      [requestId, status, actor.id, String(note || '').slice(0, 300) || null]);
  });
  await audit(actor.company_id, actor.id, `leave.${decision}`, { requestId: Number(requestId) });
  bump(actor.company_id);
  return { request_id: Number(requestId), status, name: r.name };
}

export async function cancelLeave(actor, requestId) {
  const r = await one('SELECT * FROM leave_requests WHERE id = $1 AND person_id = $2', [requestId, actor.id]);
  if (!r) throw new UserError('Leave request not found.', 404);
  if (r.status === 'Cancelled' || r.status === 'Rejected') throw new UserError(`This request is already ${r.status.toLowerCase()}.`);
  if (r.status === 'Approved' && parseISO(r.start_date) <= TODAY()) throw new UserError('Leave that has started cannot be cancelled. Ask HR.');
  await tx(async (t) => {
    if (r.status === 'Approved') await t.query('UPDATE leave_balances SET balance = balance + $3 WHERE person_id = $1 AND leave_type = $2', [r.person_id, r.leave_type, r.days]);
    await t.query("UPDATE leave_requests SET status = 'Cancelled' WHERE id = $1", [requestId]);
  });
  bump(actor.company_id);
  return { request_id: Number(requestId), status: 'Cancelled' };
}

export async function teamOf(actor) {
  return query(`SELECT p.id, p.name, p.title, p.location,
                  COALESCE((SELECT sum(days) FROM leave_requests l WHERE l.person_id = p.id AND l.status = 'Approved' AND l.start_date >= date_trunc('year', CURRENT_DATE)), 0) AS leave_days_this_year,
                  (SELECT string_agg(to_char(l.start_date, 'DD Mon'), ', ') FROM leave_requests l WHERE l.person_id = p.id AND l.status IN ('Approved', 'Pending') AND l.end_date >= $3::date) AS upcoming_leave
                FROM people p WHERE p.company_id = $1 AND p.status = 'Active' AND ($2::uuid IS NULL OR p.manager_id = $2::uuid)
                ORDER BY p.name LIMIT 200`, [actor.company_id, actor.access === 'hr' ? null : actor.id, iso(TODAY())]);
}

// ---------------- tickets ----------------
export function ticketPreview({ category, description, priority = 'Medium' }) {
  return `${category} ticket · ${category === 'Confidential' ? 'High' : priority} priority · "${description}"`;
}
export function validateTicket({ category, description }) {
  if (!TICKET_CATEGORIES.includes(category)) return `Unknown category. Use one of ${TICKET_CATEGORIES.join(', ')}.`;
  if (!String(description || '').trim()) return 'Description is required.';
  return null;
}
export async function raiseTicket(ctx, args) {
  const err = validateTicket(args);
  if (err) throw new UserError(err);
  const priority = args.category === 'Confidential' ? 'High' : ['Low', 'Medium', 'High'].includes(args.priority) ? args.priority : 'Medium';
  const [r] = await query(`INSERT INTO tickets (company_id, person_id, category, description, priority) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [ctx.company.id, ctx.user.id, args.category, String(args.description).slice(0, 1000), priority]);
  bump(ctx.company.id);
  const sla = { IT: '1 working day', Payroll: '3 working days', Confidential: 'HR will reach out within 24 hours' }[args.category] || '2 working days';
  return { ticket_id: r.id, status: 'Open', priority, expected_response: sla };
}
export async function myTickets(personId, status) {
  return query(`SELECT id AS ticket_id, category, description, priority, status, resolution, created_at
                FROM tickets WHERE person_id = $1 AND ($2::text IS NULL OR status = $2) ORDER BY created_at DESC LIMIT 20`, [personId, status || null]);
}
export async function companyTickets(companyId, status) {
  return query(`SELECT t.id AS ticket_id, p.name, p.email, t.category, t.description, t.priority, t.status, t.resolution, t.created_at
                FROM tickets t JOIN people p ON p.id = t.person_id
                WHERE t.company_id = $1 AND ($2::text IS NULL OR t.status = $2)
                ORDER BY (t.status = 'Resolved'), t.created_at DESC LIMIT 300`, [companyId, status || null]);
}
export async function updateTicket(actor, ticketId, { status, resolution }) {
  if (!['Open', 'In progress', 'Resolved'].includes(status)) throw new UserError('Invalid status.');
  const r = await query(`UPDATE tickets SET status = $3, resolution = COALESCE($4, resolution), resolved_at = CASE WHEN $3 = 'Resolved' THEN now() ELSE NULL END
                         WHERE id = $1 AND company_id = $2 RETURNING id`, [ticketId, actor.company_id, status, resolution ? String(resolution).slice(0, 1000) : null]);
  if (!r.length) throw new UserError('Ticket not found.', 404);
  await audit(actor.company_id, actor.id, 'ticket.update', { ticketId: Number(ticketId), status });
  bump(actor.company_id);
  return { ticket_id: Number(ticketId), status };
}

// ---------------- usage quota ----------------
/** Counts a chat message against the company's daily limit. Returns false when over the limit. */
export async function countMessage(company) {
  const limit = settingsOf(company).dailyMessageLimit;
  const [r] = await query(`INSERT INTO usage_daily (company_id, day, messages) VALUES ($1, CURRENT_DATE, 1)
                           ON CONFLICT (company_id, day) DO UPDATE SET messages = usage_daily.messages + 1 RETURNING messages`, [company.id]);
  return r.messages <= limit;
}
