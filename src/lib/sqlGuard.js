// Guardrails for LLM-generated SQL. Layers:
// 1) statement allow-list (single SELECT/WITH only)
// 2) role-based column access (salary / ratings only for HR)
// 3) forced row LIMIT
// 4) executed on a read-only connection (see db/index.js)
const BLOCKED = /\b(insert|update|delete|drop|alter|create|replace|attach|detach|pragma|vacuum|reindex|trigger)\b/i;
const SENSITIVE = /\b(salary_lpa|performance_rating)\b/i;

export class GuardError extends Error {
  constructor(msg, code) { super(msg); this.code = code; }
}

export function guardSql(sql, access = 'employee') {
  let q = String(sql || '').trim().replace(/^```(sql)?|```$/gi, '').trim().replace(/;\s*$/, '');
  if (!/^(select|with)\b/i.test(q)) throw new GuardError('Only read-only SELECT queries are allowed.', 'NOT_SELECT');
  if (q.includes(';')) throw new GuardError('Multiple statements are not allowed.', 'MULTI_STATEMENT');
  if (BLOCKED.test(q.replace(/'[^']*'/g, "''"))) throw new GuardError('Query contains a write/admin keyword.', 'BLOCKED_KEYWORD');
  if (access !== 'hr' && SENSITIVE.test(q))
    throw new GuardError('Salary and performance data is restricted to HR. Your access level cannot query it.', 'RBAC_DENIED');
  if (access !== 'hr' && /\bselect\s+\*\s+from\s+employees\b/i.test(q))
    throw new GuardError('Selecting all employee columns is restricted; ask for specific fields or aggregates.', 'RBAC_DENIED');
  if (!/\blimit\s+\d+\s*$/i.test(q)) q += ' LIMIT 200';
  return q;
}

/** Mask emails for non-HR viewers (PII minimisation). */
export function maskRows(rows, access) {
  if (access === 'hr') return rows;
  return rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) =>
    [k, typeof v === 'string' && /@/.test(v) ? v.replace(/^(.).*(@.*)$/, '$1***$2') : v])));
}
