// Per-tenant, per-role SQL sandbox for LLM-written queries.
//
// Instead of letting model-written SQL touch the real database, we copy ONE company's rows into a
// throwaway in-memory SQLite database, keeping only the columns this user's role may see, then set
// it to query_only. Tenant isolation and column-level access are therefore physical: data the user
// may not see is simply not there. Cached until the company's data changes.
import { DatabaseSync } from 'node:sqlite';
import { query } from '../db/pg.js';
import { version } from './versions.js';
import { TODAY, iso } from './dates.js';

const TTL_MS = 5 * 60 * 1000;
const cache = new Map();

const TABLES = {
  hr: {
    employees: ['employee_id', 'name', 'email', 'gender', 'department', 'role', 'level', 'location', 'manager_id', 'join_date', 'status', 'exit_date', 'exit_reason', 'salary_lpa', 'performance_rating', 'engagement_score'],
    leave_balances: ['employee_id', 'leave_type', 'balance'],
    leave_requests: ['request_id', 'employee_id', 'leave_type', 'start_date', 'end_date', 'days', 'reason', 'status', 'created_at'],
    tickets: ['ticket_id', 'employee_id', 'department', 'category', 'description', 'priority', 'status', 'created_at', 'resolved_at'],
  },
  // managers and employees: no personal/sensitive columns, no confidential tickets
  other: {
    employees: ['employee_id', 'name', 'department', 'role', 'level', 'location', 'manager_id', 'join_date', 'status', 'exit_date'],
    leave_requests: ['request_id', 'employee_id', 'leave_type', 'start_date', 'end_date', 'days', 'status', 'created_at'],
    tickets: ['ticket_id', 'department', 'category', 'priority', 'status', 'created_at', 'resolved_at'],
  },
};
const REAL = new Set(['salary_lpa', 'balance', 'days']);
const INT = new Set(['performance_rating', 'engagement_score', 'request_id', 'ticket_id']);

/** Columns hidden from non-HR users — the guard uses this to give a clear "restricted" message. */
export const HR_ONLY_COLUMNS = ['email', 'gender', 'exit_reason', 'salary_lpa', 'performance_rating', 'engagement_score', 'reason', 'description', 'balance'];

export function schemaFor(access) {
  const t = TABLES[access === 'hr' ? 'hr' : 'other'];
  const notes = {
    employees: "status 'Active'|'Exited'; dates 'YYYY-MM-DD'; manager_id → employees.employee_id; role = job title",
    leave_requests: "status 'Pending'|'Approved'|'Rejected'|'Cancelled'",
    tickets: "status 'Open'|'In progress'|'Resolved'; category 'IT'|'Payroll'|'Benefits'|'Facilities'|'HR Query'|'Confidential'",
    leave_balances: '',
  };
  return Object.entries(t).map(([name, cols]) => `${name}(${cols.join(', ')})${notes[name] ? `  -- ${notes[name]}` : ''}`).join('\n') +
    `\nDialect: SQLite. Today is ${iso(TODAY())}.${access === 'hr' ? '' : ' Salary, ratings, engagement, gender, emails, exit reasons and ticket text are not available to this user.'}`;
}

async function load(companyId, access) {
  const role = access === 'hr' ? 'hr' : 'other';
  const [emps, bal, reqs, tix] = await Promise.all([
    query(`SELECT id AS employee_id, name, email, gender, department, title AS role, level, location, manager_id, join_date, status, exit_date, exit_reason,
                  salary_lpa, performance_rating, engagement_score FROM people WHERE company_id = $1`, [companyId]),
    role === 'hr' ? query('SELECT person_id AS employee_id, leave_type, balance FROM leave_balances WHERE company_id = $1', [companyId]) : [],
    query(`SELECT id AS request_id, person_id AS employee_id, leave_type, start_date, end_date, days, reason, status, to_char(created_at, 'YYYY-MM-DD') AS created_at
           FROM leave_requests WHERE company_id = $1`, [companyId]),
    query(`SELECT t.id AS ticket_id, t.person_id AS employee_id, p.department, t.category, t.description, t.priority, t.status,
                  to_char(t.created_at, 'YYYY-MM-DD') AS created_at, to_char(t.resolved_at, 'YYYY-MM-DD') AS resolved_at
           FROM tickets t JOIN people p ON p.id = t.person_id WHERE t.company_id = $1 ${role === 'hr' ? '' : "AND t.category <> 'Confidential'"}`, [companyId]),
  ]);
  const db = new DatabaseSync(':memory:');
  const rows = { employees: emps, leave_balances: bal, leave_requests: reqs, tickets: tix };
  db.exec('BEGIN');
  for (const [table, cols] of Object.entries(TABLES[role])) {
    db.exec(`CREATE TABLE ${table} (${cols.map((c) => `${c} ${REAL.has(c) ? 'REAL' : INT.has(c) ? 'INTEGER' : 'TEXT'}`).join(', ')})`);
    const ins = db.prepare(`INSERT INTO ${table} VALUES (${cols.map(() => '?').join(', ')})`);
    for (const r of rows[table]) ins.run(...cols.map((c) => (r[c] === undefined ? null : r[c] instanceof Date ? r[c].toISOString().slice(0, 10) : r[c])));
  }
  db.exec('COMMIT');
  db.exec('PRAGMA query_only = ON'); // belt and braces: the copy itself refuses writes
  return db;
}

export async function sandboxFor(ctx) {
  const key = `${ctx.company.id}:${ctx.access === 'hr' ? 'hr' : 'other'}`;
  const v = version(ctx.company.id);
  const hit = cache.get(key);
  if (hit && hit.v === v && Date.now() - hit.at < TTL_MS) return hit.db;
  hit?.db.close();
  const db = await load(ctx.company.id, ctx.access);
  cache.set(key, { db, v, at: Date.now() });
  return db;
}
