// Companies, people, invites and settings.
import { query, one, tx } from '../db/pg.js';
import { DEFAULT_SETTINGS } from '../db/schema.js';
import { hashPassword, createInvite } from '../auth.js';
import { bump } from '../lib/versions.js';

export class UserError extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const clean = (s, max = 120) => (s == null ? null : String(s).trim().slice(0, max) || null);
const date = (s) => {
  if (!s) return null;
  const v = String(s).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const m = v.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/); // DD/MM/YYYY (Indian format)
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
};

export function settingsOf(company) {
  const s = company?.settings || {};
  // leave types are the company's own list (not merged with defaults, so removed types stay removed)
  return { ...DEFAULT_SETTINGS, ...s, leave: s.leave && Object.keys(s.leave).length ? s.leave : DEFAULT_SETTINGS.leave, contacts: { ...DEFAULT_SETTINGS.contacts, ...(s.contacts || {}) } };
}

/** Self-serve signup: creates the company and its first HR admin. */
export async function createCompany({ companyName, name, email, password, title }) {
  companyName = clean(companyName, 80); name = clean(name, 80); email = clean(email, 160)?.toLowerCase();
  if (!companyName || !name) throw new UserError('Company name and your name are required.');
  if (!email || !EMAIL_RE.test(email)) throw new UserError('Enter a valid work email.');
  if (await one('SELECT 1 FROM people WHERE lower(email) = $1', [email])) throw new UserError('An account with this email already exists. Log in instead.', 409);
  const hash = await hashPassword(password);
  return tx(async (t) => {
    const [c] = await t.query('INSERT INTO companies (name, settings) VALUES ($1, $2) RETURNING id', [companyName, { ...DEFAULT_SETTINGS, contacts: { ...DEFAULT_SETTINGS.contacts, hr: email } }]);
    const [p] = await t.query(`INSERT INTO people (company_id, email, name, access, password_hash, title, department, join_date)
                               VALUES ($1, $2, $3, 'hr', $4, $5, 'HR', CURRENT_DATE) RETURNING id`, [c.id, email, name, hash, clean(title) || 'HR Admin']);
    await grantLeave(t, c.id, p.id, DEFAULT_SETTINGS.leave);
    return { companyId: c.id, personId: p.id };
  });
}

async function grantLeave(t, companyId, personId, leave) {
  for (const [type, days] of Object.entries(leave)) {
    await t.query(`INSERT INTO leave_balances (person_id, company_id, leave_type, balance) VALUES ($1, $2, $3, $4)
                   ON CONFLICT (person_id, leave_type) DO NOTHING`, [personId, companyId, type, days]);
  }
}

export async function getCompany(companyId) {
  return one('SELECT id, name, settings, created_at FROM companies WHERE id = $1', [companyId]);
}

export async function updateSettings(companyId, patch) {
  const c = await getCompany(companyId);
  const cur = settingsOf(c);
  const next = { ...cur };
  if (patch.leave) {
    next.leave = {};
    for (const [k, v] of Object.entries(patch.leave)) {
      const key = clean(k, 30); const n = Number(v);
      if (key && Number.isFinite(n) && n >= 0 && n <= 365) next.leave[key] = n;
    }
    if (!Object.keys(next.leave).length) throw new UserError('Add at least one leave type.');
  }
  for (const k of ['earnedNoticeDays', 'autoApproveUpToDays', 'dailyMessageLimit']) {
    if (patch[k] != null) { const n = Number(patch[k]); if (Number.isFinite(n) && n >= 0 && n <= 100000) next[k] = n; }
  }
  if (patch.contacts) for (const k of Object.keys(DEFAULT_SETTINGS.contacts)) if (patch.contacts[k] != null) next.contacts[k] = clean(patch.contacts[k], 200) || '';
  const name = clean(patch.companyName, 80) || c.name;
  await query('UPDATE companies SET settings = $2, name = $3 WHERE id = $1', [companyId, next, name]);
  // new leave types: give everyone the yearly entitlement for types they don't have yet
  if (patch.leave) {
    const people = await query("SELECT id FROM people WHERE company_id = $1 AND status = 'Active'", [companyId]);
    await tx(async (t) => { for (const p of people) await grantLeave(t, companyId, p.id, next.leave); });
  }
  bump(companyId);
  return next;
}

// ---------------- people ----------------
const PERSON_FIELDS = ['name', 'email', 'title', 'department', 'level', 'location', 'join_date', 'gender', 'access', 'salary_lpa', 'performance_rating', 'engagement_score'];

export async function listPeople(companyId) {
  return query(`SELECT p.id, p.name, p.email, p.title, p.department, p.level, p.location, p.access, p.status, p.join_date,
                       p.manager_id, m.name AS manager_name, (p.password_hash IS NOT NULL) AS joined
                FROM people p LEFT JOIN people m ON m.id = p.manager_id
                WHERE p.company_id = $1 ORDER BY p.status, p.name`, [companyId]);
}

function normalisePerson(input) {
  const p = {};
  p.name = clean(input.name, 80);
  p.email = clean(input.email, 160)?.toLowerCase();
  if (!p.name) throw new UserError('Name is required.');
  if (!p.email || !EMAIL_RE.test(p.email)) throw new UserError(`"${input.email || ''}" is not a valid email.`);
  for (const k of ['title', 'department', 'level', 'location', 'gender']) p[k] = clean(input[k], 80);
  p.join_date = date(input.join_date) || null;
  p.access = ['employee', 'manager', 'hr'].includes(String(input.access || '').toLowerCase()) ? String(input.access).toLowerCase() : 'employee';
  for (const k of ['salary_lpa', 'performance_rating', 'engagement_score']) {
    const n = input[k] === '' || input[k] == null ? null : Number(input[k]);
    p[k] = Number.isFinite(n) ? n : null;
  }
  return p;
}

/**
 * Adds or updates people (by email) and wires managers by manager_email.
 * Returns per-row results so the UI can show exactly what happened.
 */
export async function upsertPeople(companyId, rows) {
  if (!Array.isArray(rows) || !rows.length) throw new UserError('No rows to import.');
  if (rows.length > 2000) throw new UserError('Import at most 2,000 people at a time.');
  const company = await getCompany(companyId);
  const { leave } = settingsOf(company);
  const results = [];
  const managerLinks = [];
  for (const [i, raw] of rows.entries()) {
    try {
      const p = normalisePerson(raw);
      const existing = await one('SELECT id, company_id FROM people WHERE lower(email) = $1', [p.email]);
      if (existing && existing.company_id !== companyId) throw new UserError(`${p.email} already belongs to another company.`);
      let id;
      if (existing) {
        await query(`UPDATE people SET name=$2, title=$3, department=$4, level=$5, location=$6, join_date=COALESCE($7, join_date), gender=$8,
                     access = CASE WHEN access = 'hr' THEN access ELSE $9 END, salary_lpa=$10, performance_rating=$11, engagement_score=$12
                     WHERE id = $1`, [existing.id, p.name, p.title, p.department, p.level, p.location, p.join_date, p.gender, p.access, p.salary_lpa, p.performance_rating, p.engagement_score]);
        id = existing.id;
        results.push({ row: i + 1, email: p.email, status: 'updated' });
      } else {
        const [r] = await query(`INSERT INTO people (company_id, email, name, title, department, level, location, join_date, gender, access, salary_lpa, performance_rating, engagement_score)
                                 VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8::date, CURRENT_DATE),$9,$10,$11,$12,$13) RETURNING id`,
        [companyId, p.email, p.name, p.title, p.department, p.level, p.location, p.join_date, p.gender, p.access, p.salary_lpa, p.performance_rating, p.engagement_score]);
        id = r.id;
        await tx((t) => grantLeave(t, companyId, id, leave));
        results.push({ row: i + 1, email: p.email, status: 'added' });
      }
      const me = clean(raw.manager_email, 160)?.toLowerCase();
      if (me) managerLinks.push({ id, me, row: i + 1 });
    } catch (e) {
      results.push({ row: i + 1, email: raw?.email || '', status: 'error', error: e.message });
    }
  }
  for (const l of managerLinks) {
    const m = await one('SELECT id, access FROM people WHERE company_id = $1 AND lower(email) = $2', [companyId, l.me]);
    if (!m || m.id === l.id) { results[l.row - 1].warning = `manager ${l.me} not found`; continue; }
    await query('UPDATE people SET manager_id = $2 WHERE id = $1', [l.id, m.id]);
    if (m.access === 'employee') await query("UPDATE people SET access = 'manager' WHERE id = $1", [m.id]);
  }
  bump(companyId);
  return { added: results.filter((r) => r.status === 'added').length, updated: results.filter((r) => r.status === 'updated').length, errors: results.filter((r) => r.status === 'error'), results };
}

export async function updatePerson(companyId, personId, patch, actor) {
  const p = await one('SELECT * FROM people WHERE id = $1 AND company_id = $2', [personId, companyId]);
  if (!p) throw new UserError('Person not found.', 404);
  const sets = [], vals = [personId];
  const add = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  for (const k of ['name', 'title', 'department', 'level', 'location', 'gender']) if (k in patch) add(k, clean(patch[k], 80));
  if ('access' in patch) {
    if (!['employee', 'manager', 'hr'].includes(patch.access)) throw new UserError('Invalid access level.');
    if (personId === actor.id && patch.access !== 'hr') throw new UserError("You can't remove your own HR access.");
    add('access', patch.access);
  }
  if ('manager_email' in patch) {
    const me = clean(patch.manager_email, 160)?.toLowerCase();
    const m = me ? await one('SELECT id FROM people WHERE company_id = $1 AND lower(email) = $2', [companyId, me]) : null;
    if (me && !m) throw new UserError(`No one with email ${me} in your company.`);
    if (m?.id === personId) throw new UserError('Someone cannot be their own manager.');
    add('manager_id', m?.id ?? null);
  }
  if ('status' in patch) {
    if (!['Active', 'Exited'].includes(patch.status)) throw new UserError('Invalid status.');
    if (personId === actor.id) throw new UserError("You can't deactivate yourself.");
    add('status', patch.status);
    add('exit_date', patch.status === 'Exited' ? (date(patch.exit_date) || new Date().toISOString().slice(0, 10)) : null);
    add('exit_reason', patch.status === 'Exited' ? clean(patch.exit_reason, 120) : null);
    if (patch.status === 'Exited') await query('DELETE FROM sessions WHERE person_id = $1', [personId]);
  }
  for (const k of ['salary_lpa', 'performance_rating', 'engagement_score']) if (k in patch) {
    const n = patch[k] === '' || patch[k] == null ? null : Number(patch[k]);
    add(k, Number.isFinite(n) ? n : null);
  }
  if ('balances' in patch && patch.balances) {
    for (const [type, v] of Object.entries(patch.balances)) {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 365) throw new UserError(`Invalid ${type} balance.`);
      await query(`INSERT INTO leave_balances (person_id, company_id, leave_type, balance) VALUES ($1,$2,$3,$4)
                   ON CONFLICT (person_id, leave_type) DO UPDATE SET balance = EXCLUDED.balance`, [personId, companyId, type, n]);
    }
  }
  if (sets.length) await query(`UPDATE people SET ${sets.join(', ')} WHERE id = $1`, vals);
  bump(companyId);
  return one('SELECT id, name, email, title, department, access, status FROM people WHERE id = $1', [personId]);
}

export async function inviteLink(companyId, personId, origin) {
  const p = await one("SELECT id, status FROM people WHERE id = $1 AND company_id = $2", [personId, companyId]);
  if (!p) throw new UserError('Person not found.', 404);
  if (p.status !== 'Active') throw new UserError('This person is marked as exited.');
  const t = await createInvite(personId);
  return `${origin}/join?token=${encodeURIComponent(t)}`;
}

export async function audit(companyId, personId, action, detail) {
  await query('INSERT INTO audit_log (company_id, person_id, action, detail) VALUES ($1,$2,$3,$4)', [companyId, personId, action, detail ?? null]).catch(() => {});
}

export async function overview(companyId) {
  const [counts] = await query(`SELECT
      (SELECT count(*) FROM people WHERE company_id = $1 AND status = 'Active')::int AS people,
      (SELECT count(*) FROM people WHERE company_id = $1 AND status = 'Active' AND password_hash IS NULL)::int AS not_joined,
      (SELECT count(*) FROM policy_docs WHERE company_id = $1)::int AS policies,
      (SELECT count(*) FROM leave_requests WHERE company_id = $1 AND status = 'Pending')::int AS pending_leave,
      (SELECT count(*) FROM tickets WHERE company_id = $1 AND status <> 'Resolved')::int AS open_tickets,
      (SELECT COALESCE(sum(messages), 0) FROM usage_daily WHERE company_id = $1 AND day > CURRENT_DATE - 7)::int AS messages_7d`, [companyId]);
  return counts;
}
