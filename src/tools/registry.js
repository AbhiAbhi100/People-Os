// ONE tool layer, TWO consumers: the in-app agents and the MCP server (src/mcp/server.js).
// Every tool declares its input schema, whether it writes (needs human approval) and enforces
// access control itself — the LLM is never trusted to enforce permissions.
import { z } from 'zod';
import { db, readonlyDb, PERSONAS } from '../db/index.js';
import { guardSql, maskRows } from '../lib/sqlGuard.js';
import { policyIndex } from '../lib/bm25.js';
import { TODAY, iso, parseISO, businessDays } from '../lib/dates.js';

const LEAVE_TYPES = ['Earned', 'Sick', 'Casual'];
const TICKET_CATS = ['IT', 'Payroll', 'Benefits', 'Facilities', 'HR Query', 'Confidential'];
const one = (sql, ...a) => db().prepare(sql).get(...a);
const all = (sql, ...a) => db().prepare(sql).all(...a).map((r) => ({ ...r }));

function canView(ctx, targetId) {
  if (!targetId || targetId === ctx.user.id || ctx.access === 'hr') return true;
  if (ctx.access === 'manager') return !!one('SELECT 1 FROM employees WHERE employee_id=? AND manager_id=?', targetId, ctx.user.id);
  return false;
}
const deny = () => { throw new Error('ACCESS_DENIED: you can only view your own records (managers: their direct reports).'); };

/** Explainable automation score per task. Weights are visible on purpose. */
export const WEIGHTS = { repetitive: 0.35, rules_based: 0.25, data_heavy: 0.15, judgment: -0.15, empathy: -0.10 };
export function scoreTask(t) {
  const contrib = Object.fromEntries(Object.entries(WEIGHTS).map(([k, w]) => [k, +(w * t[k]).toFixed(3)]));
  const raw = Object.values(contrib).reduce((a, b) => a + b, 0); // range ≈ [-0.25, 0.75]
  const score = Math.round(Math.max(0, Math.min(1, (raw + 0.25) / 1.0)) * 100);
  const bucket = score >= 65 ? 'Automate' : score >= 40 ? 'Augment with AI' : 'Human-led';
  const top = Object.entries(contrib).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 2)
    .map(([k, v]) => `${v >= 0 ? 'high' : 'needs'} ${k.replace('_', '-')}`);
  return { score, bucket, why: top.join(', '), contrib };
}

export const tools = {
  search_policies: {
    description: 'Search company HR policies (leave, WFH, reimbursements, POSH/grievance, benefits). Returns the most relevant policy sections with ids for citation.',
    input: { query: z.string().describe('What to look up, in plain English') },
    writes: false,
    run: ({ query }) => policyIndex.search(query, 4).map(({ id, doc, heading, text, score }) => ({ id, doc, heading, text, score })),
  },

  run_sql: {
    description: 'Run a read-only SQLite SELECT on the HR database. Salary/performance columns are HR-only. Results are row-limited and PII-masked for non-HR users.',
    input: { sql: z.string().describe('A single SELECT statement') },
    writes: false,
    run: ({ sql }, ctx) => {
      const safe = guardSql(sql, ctx.access);
      const rows = readonlyDb().prepare(safe).all().map((r) => ({ ...r }));
      return { sql: safe, rows: maskRows(rows, ctx.access) };
    },
  },

  get_leave_balance: {
    description: "Get leave balances (Earned/Sick/Casual) and recent leave requests. Defaults to the current user.",
    input: { employee_id: z.string().optional().describe('Defaults to the current user') },
    writes: false,
    run: ({ employee_id }, ctx) => {
      const id = employee_id || ctx.user.id;
      if (!canView(ctx, id)) deny();
      return {
        employee_id: id,
        balances: all('SELECT leave_type, balance FROM leave_balances WHERE employee_id=? ORDER BY leave_type', id),
        recent_requests: all('SELECT request_id, leave_type, start_date, end_date, days, status FROM leave_requests WHERE employee_id=? ORDER BY start_date DESC LIMIT 5', id),
      };
    },
  },

  apply_leave: {
    description: 'Apply for leave for the current user. Validates balance, overlaps, weekends and notice period per policy. WRITE action: requires human approval.',
    input: {
      leave_type: z.enum(LEAVE_TYPES),
      start_date: z.string().describe('YYYY-MM-DD'),
      end_date: z.string().describe('YYYY-MM-DD'),
      reason: z.string().optional(),
    },
    writes: true,
    validate: ({ leave_type, start_date, end_date }, ctx) => {
      if (!LEAVE_TYPES.includes(leave_type)) return `Unknown leave type "${leave_type}". Use one of ${LEAVE_TYPES.join(', ')}.`;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(start_date) || !/^\d{4}-\d{2}-\d{2}$/.test(end_date || '')) return 'Dates must be YYYY-MM-DD.';
      const s = parseISO(start_date), e = parseISO(end_date), today = TODAY();
      if (e < s) return 'End date is before start date.';
      const days = businessDays(s, e);
      if (days === 0) return 'Those dates fall on a weekend, so no leave is needed.';
      const minStart = new Date(today); minStart.setDate(minStart.getDate() - 2);
      if (leave_type !== 'Sick' && s < today) return 'Only Sick Leave can be applied for past dates.';
      if (leave_type === 'Sick' && s < minStart) return 'Sick Leave can be applied retroactively only within 2 working days (Leave Policy).';
      if (leave_type === 'Earned' && businessDays(new Date(today.getTime() + 864e5), new Date(s.getTime() - 864e5)) < 3)
        return 'Earned Leave needs 3 working days notice (Leave Policy). Try Casual Leave for short notice.';
      const bal = one('SELECT balance FROM leave_balances WHERE employee_id=? AND leave_type=?', ctx.user.id, leave_type)?.balance ?? 0;
      if (bal < days) return `Insufficient ${leave_type} balance: need ${days}, have ${bal}.`;
      const clash = one(`SELECT request_id FROM leave_requests WHERE employee_id=? AND status!='Cancelled' AND NOT (end_date < ? OR start_date > ?)`, ctx.user.id, start_date, end_date);
      if (clash) return `Overlaps with existing leave request #${clash.request_id}.`;
      return null;
    },
    preview: ({ leave_type, start_date, end_date, reason }) => {
      const days = businessDays(parseISO(start_date), parseISO(end_date));
      return `${leave_type} leave · ${start_date} → ${end_date} · ${days} working day${days > 1 ? 's' : ''}${reason ? ` · "${reason}"` : ''}`;
    },
    run: (args, ctx) => {
      const err = tools.apply_leave.validate(args, ctx);
      if (err) throw new Error(err);
      const { leave_type, start_date, end_date, reason = '' } = args;
      const days = businessDays(parseISO(start_date), parseISO(end_date));
      const status = days > 5 ? 'Pending manager approval' : 'Approved';
      db().prepare('UPDATE leave_balances SET balance = balance - ? WHERE employee_id=? AND leave_type=?').run(days, ctx.user.id, leave_type);
      const r = db().prepare('INSERT INTO leave_requests (employee_id, leave_type, start_date, end_date, days, reason, status, created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(ctx.user.id, leave_type, start_date, end_date, days, reason, status, iso(TODAY()));
      const left = one('SELECT balance FROM leave_balances WHERE employee_id=? AND leave_type=?', ctx.user.id, leave_type).balance;
      return { request_id: Number(r.lastInsertRowid), status, days, remaining_balance: left };
    },
  },

  raise_ticket: {
    description: 'Raise a helpdesk ticket (IT, Payroll, Benefits, Facilities, HR Query, Confidential). WRITE action: requires human approval.',
    input: {
      category: z.enum(TICKET_CATS),
      description: z.string(),
      priority: z.enum(['Low', 'Medium', 'High']).optional(),
    },
    writes: true,
    validate: ({ category, description }) =>
      !TICKET_CATS.includes(category) ? `Unknown category. Use one of ${TICKET_CATS.join(', ')}.` : !description?.trim() ? 'Description is required.' : null,
    preview: ({ category, description, priority = 'Medium' }) => `${category} ticket · ${priority} priority · "${description}"`,
    run: (args, ctx) => {
      const err = tools.raise_ticket.validate(args, ctx);
      if (err) throw new Error(err);
      const priority = args.category === 'Confidential' ? 'High' : args.priority || 'Medium';
      const r = db().prepare('INSERT INTO tickets (employee_id, category, description, priority, status, created_at) VALUES (?,?,?,?,?,?)')
        .run(ctx.user.id, args.category, args.description, priority, 'Open', iso(TODAY()));
      const sla = { IT: '1 working day', Payroll: '3 working days', Confidential: 'HR will reach out within 24 hours' }[args.category] || '2 working days';
      return { ticket_id: Number(r.lastInsertRowid), status: 'Open', priority, expected_response: sla };
    },
  },

  get_my_tickets: {
    description: "List the current user's helpdesk tickets.",
    input: { status: z.enum(['Open', 'Resolved']).optional() },
    writes: false,
    run: ({ status }, ctx) => all(`SELECT ticket_id, category, description, priority, status, created_at FROM tickets WHERE employee_id=? ${status ? 'AND status=?' : ''} ORDER BY created_at DESC LIMIT 10`, ...[ctx.user.id, status].filter(Boolean)),
  },

  get_profile: {
    description: 'Get an employee profile: role, department, location, manager and HR Business Partner. Defaults to the current user.',
    input: { employee_id: z.string().optional() },
    writes: false,
    run: ({ employee_id }, ctx) => {
      const id = employee_id || ctx.user.id;
      if (!canView(ctx, id)) deny();
      const p = one(`SELECT e.employee_id, e.name, e.role, e.level, e.department, e.location, e.join_date, m.name AS manager_name
                     FROM employees e LEFT JOIN employees m ON m.employee_id = e.manager_id WHERE e.employee_id=?`, id);
      if (!p) throw new Error(`No employee ${id}`);
      return { ...p, hr_business_partner: `${PERSONAS.E1003.name} (meera.iyer@peopleos.demo)` };
    },
  },

  get_team: {
    description: "Managers only: list direct reports with leave taken this year and open tickets.",
    input: {},
    writes: false,
    run: (_, ctx) => {
      if (ctx.access === 'employee') deny();
      return all(`SELECT e.employee_id, e.name, e.role, e.location,
                    (SELECT COALESCE(SUM(days),0) FROM leave_requests l WHERE l.employee_id=e.employee_id AND l.start_date >= '2026-01-01') AS leave_days_2026,
                    (SELECT COUNT(*) FROM leave_requests l WHERE l.employee_id=e.employee_id AND l.start_date >= ? ) AS upcoming_leaves
                  FROM employees e WHERE e.manager_id=? AND e.status='Active' ORDER BY e.name`, iso(TODAY()), ctx.user.id);
    },
  },

  career_insights: {
    description: 'Explainable analysis of which tasks of a role AI can automate, augment, or should stay human-led, with hours freed, skills to grow and adjacent roles.',
    input: { role: z.string().optional().describe("Defaults to the current user's role") },
    writes: false,
    run: ({ role }, ctx) => {
      const roles = all('SELECT DISTINCT role FROM role_tasks').map((r) => r.role);
      const want = role || one('SELECT role FROM employees WHERE employee_id=?', ctx.user.id).role;
      const match = roles.find((r) => r.toLowerCase() === want.toLowerCase())
        || roles.find((r) => want.toLowerCase().includes(r.toLowerCase()) || r.toLowerCase().includes(want.toLowerCase()));
      if (!match) return { error: `No task model for "${want}" yet.`, available_roles: roles };
      const tasks = all('SELECT * FROM role_tasks WHERE role=?', match).map((t) => ({ task: t.task, hours_per_week: t.hours_per_week, skill: t.skill, ...scoreTask(t) }))
        .sort((a, b) => b.score - a.score);
      const total = tasks.reduce((s, t) => s + t.hours_per_week, 0);
      const freed = tasks.reduce((s, t) => s + t.hours_per_week * (t.bucket === 'Automate' ? 0.7 : t.bucket === 'Augment with AI' ? 0.3 : 0), 0);
      const grow = tasks.filter((t) => t.bucket !== 'Automate').sort((a, b) => a.score - b.score).slice(0, 3).map((t) => t.skill);
      // Adjacent roles: similar task profile (transferable experience) but more human-led work.
      const ATTRS = ['repetitive', 'rules_based', 'data_heavy', 'judgment', 'empathy'];
      const vec = (ts) => ATTRS.map((a) => ts.reduce((s, t) => s + t[a] * t.hours_per_week, 0) / ts.reduce((s, t) => s + t.hours_per_week, 0));
      const cos = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0) / (Math.hypot(...a) * Math.hypot(...b));
      const mine = vec(all('SELECT * FROM role_tasks WHERE role=?', match));
      const adjacent = roles.filter((r) => r !== match).map((r) => {
        const ts = all('SELECT * FROM role_tasks WHERE role=?', r);
        const human = ts.filter((t) => scoreTask(t).bucket === 'Human-led').length / ts.length;
        const similarity = cos(mine, vec(ts));
        return { role: r, similarity: Math.round(similarity * 100), human_led_share: Math.round(human * 100), fit: Math.round((0.5 * similarity + 0.5 * human) * 100) };
      }).sort((a, b) => b.fit - a.fit).slice(0, 3);
      return { role: match, weights: WEIGHTS, total_hours: total, hours_freed_per_week: +freed.toFixed(1), tasks, skills_to_grow: grow, adjacent_roles: adjacent };
    },
  },
};

/** Execute a tool with uniform error shape (used by agents + MCP). */
export async function callTool(name, args, ctx) {
  const t = tools[name];
  if (!t) throw new Error(`Unknown tool ${name}`);
  return t.run(args || {}, ctx);
}

/** Compact tool catalogue for LLM prompts. */
export function toolCatalog(names = Object.keys(tools)) {
  return names.map((n) => {
    const t = tools[n];
    const params = Object.entries(t.input).map(([k, v]) => {
      const opt = v.isOptional?.(); const inner = opt ? v.unwrap() : v;
      const desc = v.description || inner.description || '';
      return `${k}${opt ? '?' : ''}${inner.options ? `: ${inner.options.join('|')}` : ''}${desc ? ` /*${desc}*/` : ''}`;
    }).join(', ');
    return `- ${n}(${params})${t.writes ? ' [WRITE: needs approval]' : ''}: ${t.description}`;
  }).join('\n');
}
