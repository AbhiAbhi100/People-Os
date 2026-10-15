// ONE tool layer, TWO consumers: the in-app agents and the MCP server (src/mcp/server.js).
// Every tool declares its input schema, whether it writes (needs human approval), and enforces
// tenant + role access itself — the LLM is never trusted to enforce permissions.
// ctx = { user: { id, name, email, title, access, company_id }, access, company: { id, name, settings } }
import { z } from 'zod';
import { one } from '../db/pg.js';
import { guardSql, maskRows } from '../lib/sqlGuard.js';
import { sandboxFor } from '../lib/sandbox.js';
import { policyIndexFor } from '../services/policies.js';
import { settingsOf } from '../services/company.js';
import * as work from '../services/work.js';
import { ROLE_TASKS, ROLES, matchRole } from '../lib/roleLibrary.js';
import { chatJSON, isOffline } from '../llm/provider.js';

const deny = () => { throw new Error('ACCESS_DENIED: you can only view your own records (managers: their direct reports; HR: everyone).'); };

/** Resolves "person" (name or email) inside the caller's company and checks they may see it. */
async function resolvePerson(ctx, person) {
  if (!person) return { id: ctx.user.id, name: ctx.user.name };
  const p = await one(`SELECT id, name, manager_id FROM people WHERE company_id = $1 AND status = 'Active'
                       AND (lower(email) = lower($2) OR lower(name) = lower($2) OR lower(name) LIKE lower($2) || ' %')
                       ORDER BY (lower(email) = lower($2)) DESC LIMIT 1`, [ctx.company.id, String(person).trim()]);
  if (!p) throw new Error(`No active colleague matching "${person}".`);
  if (p.id !== ctx.user.id && ctx.access !== 'hr' && !(ctx.access === 'manager' && p.manager_id === ctx.user.id)) deny();
  return p;
}

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

// Unknown job titles: with an LLM, generate a task breakdown in the same shape as the library.
const TaskList = z.object({
  tasks: z.array(z.object({
    task: z.string(), hours_per_week: z.number(), skill: z.string().describe('human skill that grows in value'),
    repetitive: z.number(), rules_based: z.number(), data_heavy: z.number(), judgment: z.number(), empathy: z.number(),
  })).describe('5-7 main weekly tasks; attribute scores between 0 and 1'),
});
const generated = new Map();
async function tasksForTitle(title) {
  const key = title.toLowerCase().trim();
  if (generated.has(key)) return generated.get(key);
  const out = await chatJSON({
    system: 'You break a job into its main weekly tasks for an explainable AI-automation analysis. Be realistic for Indian companies. Hours should sum to about 40.',
    messages: [{ role: 'user', content: `Job title: ${title}` }], schema: TaskList, name: 'role_tasks',
  });
  const clamp = (n) => Math.max(0, Math.min(1, Number(n) || 0));
  const tasks = out.tasks.slice(0, 8).map((t) => ({ role: title, task: t.task, hours_per_week: Math.max(1, Math.min(40, Number(t.hours_per_week) || 4)), skill: t.skill,
    repetitive: clamp(t.repetitive), rules_based: clamp(t.rules_based), data_heavy: clamp(t.data_heavy), judgment: clamp(t.judgment), empathy: clamp(t.empathy) }));
  generated.set(key, tasks);
  return tasks;
}

export const tools = {
  search_policies: {
    description: "Search this company's HR policy documents. Returns the most relevant sections with ids for citation.",
    input: { query: z.string().describe('What to look up, in plain English') },
    writes: false,
    run: async ({ query }, ctx) => (await policyIndexFor(ctx.company.id)).search(query, 4).map(({ id, doc, heading, text, score }) => ({ id, doc, heading, text, score })),
  },

  run_sql: {
    description: "Run one read-only SQLite SELECT on this company's HR data (a sandboxed copy filtered to what the user may see).",
    input: { sql: z.string().describe('A single SELECT statement') },
    writes: false,
    run: async ({ sql }, ctx) => {
      const safe = guardSql(sql, ctx.access);
      const db = await sandboxFor(ctx);
      const rows = db.prepare(safe).all().map((r) => ({ ...r }));
      return { sql: safe, rows: maskRows(rows, ctx.access) };
    },
  },

  get_leave_balance: {
    description: 'Leave balances (with days already pending approval) and recent leave requests. Defaults to the current user; managers/HR can pass a colleague.',
    input: { person: z.string().optional().describe("Colleague's name or email; omit for yourself") },
    writes: false,
    run: async ({ person }, ctx) => {
      const p = await resolvePerson(ctx, person);
      return { name: p.name, balances: await work.balances(p.id), recent_requests: await work.myLeave(p.id, 5) };
    },
  },

  apply_leave: {
    description: "Request leave for the current user. Checks the company's leave types, balance, notice period, weekends and overlaps. WRITE: needs the user's approval; then it goes to their manager/HR.",
    input: {
      leave_type: z.string().describe("One of the company's leave types, e.g. Casual, Sick, Earned"),
      start_date: z.string().describe('YYYY-MM-DD'),
      end_date: z.string().describe('YYYY-MM-DD'),
      reason: z.string().optional(),
    },
    writes: true,
    validate: (args, ctx) => work.validateLeave(ctx, args),
    preview: (args) => work.leavePreview(args),
    run: (args, ctx) => work.applyLeave(ctx, args),
  },

  cancel_leave: {
    description: 'Cancel one of your own leave requests (pending, or approved and not yet started). WRITE: needs approval.',
    input: { request_id: z.number().describe('Leave request number') },
    writes: true,
    validate: async ({ request_id }, ctx) => (await one("SELECT 1 FROM leave_requests WHERE id = $1 AND person_id = $2 AND status IN ('Pending', 'Approved')", [request_id, ctx.user.id]) ? null : `You have no open leave request #${request_id}.`),
    preview: ({ request_id }) => `Cancel leave request #${request_id}`,
    run: ({ request_id }, ctx) => work.cancelLeave(ctx.user, request_id),
  },

  list_pending_approvals: {
    description: 'Managers/HR: leave requests waiting for your decision.',
    input: {},
    writes: false,
    run: async (_, ctx) => { if (ctx.access === 'employee') deny(); return work.pendingApprovals(ctx.user); },
  },

  decide_leave: {
    description: "Managers/HR: approve or reject a team member's pending leave request. WRITE: needs approval.",
    input: { request_id: z.number(), decision: z.enum(['approve', 'reject']), note: z.string().optional() },
    writes: true,
    validate: async ({ request_id, decision }, ctx) => {
      if (ctx.access === 'employee') return 'Only managers and HR can decide on leave.';
      if (!['approve', 'reject'].includes(decision)) return 'Decision must be approve or reject.';
      const pend = await work.pendingApprovals(ctx.user);
      return pend.some((p) => Number(p.request_id) === Number(request_id)) ? null : `Request #${request_id} is not waiting for your decision.`;
    },
    preview: ({ request_id, decision, note }) => `${decision === 'approve' ? 'Approve' : 'Reject'} leave request #${request_id}${note ? ` · "${note}"` : ''}`,
    run: ({ request_id, decision, note }, ctx) => work.decideLeave(ctx.user, request_id, decision, note),
  },

  raise_ticket: {
    description: 'Raise a helpdesk ticket (IT, Payroll, Benefits, Facilities, HR Query, Confidential). WRITE: needs approval.',
    input: { category: z.enum(work.TICKET_CATEGORIES), description: z.string(), priority: z.enum(['Low', 'Medium', 'High']).optional() },
    writes: true,
    validate: (args) => work.validateTicket(args),
    preview: (args) => work.ticketPreview(args),
    run: (args, ctx) => work.raiseTicket(ctx, args),
  },

  get_my_tickets: {
    description: "List the current user's helpdesk tickets.",
    input: { status: z.enum(['Open', 'In progress', 'Resolved']).optional() },
    writes: false,
    run: ({ status }, ctx) => work.myTickets(ctx.user.id, status),
  },

  get_profile: {
    description: "Profile of the current user (or, for managers/HR, a colleague): title, department, location, manager, HR contact.",
    input: { person: z.string().optional().describe("Colleague's name or email; omit for yourself") },
    writes: false,
    run: async ({ person }, ctx) => {
      const p = await resolvePerson(ctx, person);
      const r = await one(`SELECT e.name, e.email, e.title, e.level, e.department, e.location, e.join_date, m.name AS manager_name
                           FROM people e LEFT JOIN people m ON m.id = e.manager_id WHERE e.id = $1`, [p.id]);
      return { ...r, hr_contact: settingsOf(ctx.company).contacts.hr || 'your HR team' };
    },
  },

  get_team: {
    description: 'Managers: your direct reports with leave taken this year and upcoming leave. HR: everyone.',
    input: {},
    writes: false,
    run: async (_, ctx) => { if (ctx.access === 'employee') deny(); return work.teamOf(ctx.user); },
  },

  career_insights: {
    description: 'Explainable analysis of which tasks of a role AI can automate, augment, or should stay human-led, with hours freed, skills to grow and adjacent roles.',
    input: { role: z.string().optional().describe("Job title; defaults to the current user's title") },
    writes: false,
    run: async ({ role }, ctx) => {
      const want = role || ctx.user.title || '';
      const match = matchRole(want);
      let base;
      if (match) base = ROLE_TASKS.filter((t) => t.role === match);
      else if (want && !isOffline()) base = await tasksForTitle(want);
      else return { error: `I don't have a task model for "${want || 'your role'}" yet.`, available_roles: ROLES };
      const roleName = match || want;
      const tasks = base.map((t) => ({ task: t.task, hours_per_week: t.hours_per_week, skill: t.skill, ...scoreTask(t) })).sort((a, b) => b.score - a.score);
      const total = tasks.reduce((s, t) => s + t.hours_per_week, 0);
      const freed = tasks.reduce((s, t) => s + t.hours_per_week * (t.bucket === 'Automate' ? 0.7 : t.bucket === 'Augment with AI' ? 0.3 : 0), 0);
      const grow = tasks.filter((t) => t.bucket !== 'Automate').sort((a, b) => a.score - b.score).slice(0, 3).map((t) => t.skill);
      // Adjacent roles: similar task profile (transferable experience) but more human-led work.
      const ATTRS = ['repetitive', 'rules_based', 'data_heavy', 'judgment', 'empathy'];
      const vec = (ts) => ATTRS.map((a) => ts.reduce((s, t) => s + t[a] * t.hours_per_week, 0) / ts.reduce((s, t) => s + t.hours_per_week, 0));
      const cos = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0) / (Math.hypot(...a) * Math.hypot(...b));
      const mine = vec(base);
      const adjacent = ROLES.filter((r) => r !== roleName).map((r) => {
        const ts = ROLE_TASKS.filter((t) => t.role === r);
        const human = ts.filter((t) => scoreTask(t).bucket === 'Human-led').length / ts.length;
        const similarity = cos(mine, vec(ts));
        return { role: r, similarity: Math.round(similarity * 100), human_led_share: Math.round(human * 100), fit: Math.round((0.5 * similarity + 0.5 * human) * 100) };
      }).sort((a, b) => b.fit - a.fit).slice(0, 3);
      return { role: roleName, generated: !match, weights: WEIGHTS, total_hours: total, hours_freed_per_week: +freed.toFixed(1), tasks, skills_to_grow: grow, adjacent_roles: adjacent };
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
