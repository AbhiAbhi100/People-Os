import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { DB_PATH } from './path.js';
export { DB_PATH };

let rw, ro;

async function ensureSeeded() {
  if (!existsSync(DB_PATH)) {
    const { seed } = await import('./seed.js');
    seed(DB_PATH);
  }
}
await ensureSeeded();

/** Read-write handle: only the tool layer (actions) uses this. */
export function db() {
  return (rw ||= new DatabaseSync(DB_PATH));
}

/** Read-only handle: everything LLM-generated (text-to-SQL) runs here, so even a
 *  guard bypass physically cannot write. Defence in depth. */
export function readonlyDb() {
  return (ro ||= new DatabaseSync(DB_PATH, { readOnly: true }));
}

export const SCHEMA = `
employees(employee_id TEXT PK, name TEXT, email TEXT, gender TEXT 'F'|'M', department TEXT, role TEXT,
          level TEXT 'L1'..'L4', location TEXT, manager_id TEXT -> employees.employee_id,
          join_date TEXT 'YYYY-MM-DD', status TEXT 'Active'|'Exited', exit_date TEXT, exit_reason TEXT,
          salary_lpa REAL [SENSITIVE], performance_rating INTEGER 1-5 [SENSITIVE], engagement_score INTEGER 0-100)
leave_balances(employee_id TEXT, leave_type TEXT 'Earned'|'Sick'|'Casual', balance REAL)
leave_requests(request_id INTEGER PK, employee_id TEXT, leave_type TEXT, start_date TEXT, end_date TEXT, days REAL, reason TEXT, status TEXT, created_at TEXT)
tickets(ticket_id INTEGER PK, employee_id TEXT, category TEXT 'IT'|'Payroll'|'Benefits'|'Facilities'|'HR Query'|'Confidential',
        description TEXT, priority TEXT, status TEXT 'Open'|'Resolved', created_at TEXT, resolved_at TEXT)
role_tasks(role TEXT, task TEXT, hours_per_week REAL, repetitive REAL, rules_based REAL, data_heavy REAL, judgment REAL, empathy REAL, skill TEXT)
Departments: Engineering, Product, Data Science, Customer Support, Sales, Compliance, HR, Finance, Marketing.
Locations: Mumbai, Bengaluru, Hyderabad, Noida, Remote. Today is 2026-10-13. Dialect: SQLite.`.trim();

export const PERSONAS = {
  E1001: { id: 'E1001', name: 'Riya Sharma', title: 'Software Engineer', access: 'employee' },
  E1002: { id: 'E1002', name: 'Arjun Mehta', title: 'Engineering Manager', access: 'manager' },
  E1003: { id: 'E1003', name: 'Meera Iyer', title: 'HR Business Partner', access: 'hr' },
  E1004: { id: 'E1004', name: 'Kabir Khan', title: 'Data Analyst', access: 'employee' },
};
