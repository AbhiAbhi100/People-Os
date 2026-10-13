// Data Agent: "talk to your data". Plain English -> SQL -> guarded execution -> chart + insight.
// LLM mode: schema-aware text-to-SQL with a self-correction loop (DB errors are fed back).
// Offline mode: a semantic layer (metrics x dimensions x filters) that composes SQL.
import { z } from 'zod';
import { callTool } from '../tools/registry.js';
import { SCHEMA } from '../db/index.js';
import { chatJSON, isOffline } from '../llm/provider.js';

const ACTIVE = "status='Active'";
const TENURE = "ROUND(AVG((julianday('2026-10-13') - julianday(join_date)) / 365.0), 1)";
// semantic layer: metric -> how to compute it
const METRICS = {
  attrition: { re: /attrition|churn|exits?\b|left|leaving|turnover/, label: 'attrition_pct', expr: "ROUND(100.0 * SUM(status='Exited') / COUNT(*), 1)", from: 'employees', where: null },
  engagement: { re: /engag|happiness|morale|satisf/, label: 'avg_engagement', expr: 'ROUND(AVG(engagement_score), 1)', from: 'employees', where: ACTIVE },
  salary: { re: /salar|pay\b|ctc|compensation|lpa/, label: 'avg_salary_lpa', expr: 'ROUND(AVG(salary_lpa), 1)', from: 'employees', where: ACTIVE },
  performance: { re: /perform|rating/, label: 'avg_rating', expr: 'ROUND(AVG(performance_rating), 2)', from: 'employees', where: ACTIVE },
  tenure: { re: /tenure|how long|experience/, label: 'avg_tenure_years', expr: TENURE, from: 'employees', where: ACTIVE },
  women: { re: /women|female|gender (ratio|diversity|split)|diversity/, label: 'women_pct', expr: "ROUND(100.0 * SUM(gender='F') / COUNT(*), 1)", from: 'employees', where: ACTIVE },
  hires: { re: /hire|hiring|joiner|joined|onboard/, label: 'hires', expr: 'COUNT(*)', from: 'employees', where: null, defaultDim: 'year' },
  resolution: { re: /resolution|resolve|sla|turnaround/, label: 'avg_resolution_days', expr: "ROUND(AVG(julianday(t.resolved_at) - julianday(t.created_at)), 1)", from: 'tickets', where: "t.status='Resolved'", defaultDim: 'category' },
  tickets: { re: /ticket|helpdesk|issues raised/, label: 'tickets', expr: 'COUNT(*)', from: 'tickets', where: null, defaultDim: 'category' },
  leave: { re: /leave|time off|absen/, label: 'leave_days', expr: 'SUM(l.days)', from: 'leave_requests l JOIN employees e USING(employee_id)', where: null, defaultDim: 'month' },
  headcount: { re: /headcount|how many|number of (people|employees)|count|employees|strength/, label: 'headcount', expr: 'COUNT(*)', from: 'employees', where: ACTIVE },
};
const DIMS = {
  department: { re: /department|dept|team|function|by dep/, col: 'department' },
  location: { re: /location|city|cities|office|by loc|site/, col: 'location' },
  level: { re: /level|band|grade|seniority/, col: 'level' },
  gender: { re: /\bgender\b/, col: 'gender' },
  role: { re: /\brole|designation|title/, col: 'role' },
  reason: { re: /reason|why/, col: 'exit_reason' },
  category: { re: /category|type of ticket/, col: 'category' },
  status: { re: /open vs|status/, col: 't.status', alias: 'ticket_status' },
  month: { re: /month|monthly/, col: "substr(@date, 1, 7)", alias: 'month' },
  year: { re: /year|yearly|annual|trend|over time/, col: "substr(@date, 1, 4)", alias: 'year' },
};
const SqlSchema = z.object({
  sql: z.string().describe('one SQLite SELECT statement, or empty string when refusing'),
  chart: z.enum(['bar', 'line', 'doughnut', 'none']).describe('best chart for the result'),
  title: z.string().describe('short chart title'),
  refuse: z.string().describe('empty string, or the reason when the user is not allowed to see this data'),
});
const FixSchema = z.object({ sql: z.string().describe('the corrected SQLite SELECT statement') });
const InsightSchema = z.object({ insight: z.string().describe('2-3 sentence insight with **bold** key numbers') });

const DEPTS = ['Engineering', 'Product', 'Data Science', 'Customer Support', 'Sales', 'Compliance', 'HR', 'Finance', 'Marketing'];
const LOCS = ['Mumbai', 'Bengaluru', 'Hyderabad', 'Noida', 'Remote'];

function compose(q, prev) {
  const t = q.toLowerCase();
  const follow = prev && /^(now|and|also|what about|same|break|split|only|just|instead|by\b|how about)/.test(t.trim());
  let metric = Object.keys(METRICS).find((k) => k !== 'headcount' && METRICS[k].re.test(t))
    || (METRICS.headcount.re.test(t) ? 'headcount' : null) || (follow ? prev.metric : null);
  if (!metric) return null;
  if (metric === 'tickets' && METRICS.resolution.re.test(t)) metric = 'resolution';
  const m = METRICS[metric];
  let dim = Object.keys(DIMS).find((k) => DIMS[k].re.test(t) && !(k === 'reason' && metric !== 'attrition'));
  if (!dim && follow) dim = prev.dim;
  if (!dim && m.defaultDim) dim = m.defaultDim;
  if (!dim && /per|by|across|each|split|breakdown|compare/.test(t)) dim = 'department';
  if (metric === 'tickets' && /open/.test(t) && !dim) dim = 'category';

  const where = [];
  if (m.where) where.push(m.where);
  const ent = m.from.startsWith('tickets') ? 't' : m.from.startsWith('leave') ? 'e' : null;
  const col = (c) => (ent === 't' && ['department', 'location', 'level', 'gender', 'role'].includes(c) ? `e.${c}` : c);
  let from = m.from;
  if (ent === 't') from = 'tickets t JOIN employees e USING(employee_id)';
  const dep = DEPTS.find((d) => t.includes(d.toLowerCase())) || (follow && !/all|overall|company/.test(t) ? prev.dep : null);
  const loc = LOCS.find((l) => t.includes(l.toLowerCase())) || (follow ? prev.loc : null);
  if (dep && dim !== 'department') where.push(`${col('department')} = '${dep}'`);
  if (loc && dim !== 'location') where.push(`${col('location')} = '${loc}'`);
  if (metric === 'tickets' && /\bopen\b/.test(t) && dim !== 'status') where.push("t.status = 'Open'");
  if (/this year|2026/.test(t) && metric === 'leave') where.push("l.start_date >= '2026-01-01'");
  const exitCount = metric === 'attrition' && (dim === 'reason' || dim === 'year' || dim === 'month');
  if (exitCount) where.push("status='Exited'");

  let select, group = '', order = '';
  if (dim) {
    const d = DIMS[dim];
    const dateCol = metric === 'leave' ? 'l.start_date' : ent === 't' ? 't.created_at' : metric === 'attrition' ? 'exit_date' : 'join_date';
    const expr = d.col.replace('@date', dateCol);
    const alias = d.alias || d.col;
    const metricExpr = exitCount ? 'COUNT(*)' : m.expr;
    const label = exitCount ? 'exits' : m.label;
    select = `${col(expr)} AS ${alias}, ${metricExpr} AS ${label}`;
    group = ` GROUP BY 1`;
    order = /month|year/.test(dim) ? ' ORDER BY 1' : ' ORDER BY 2 DESC';
    if (metric === 'hires' && dim === 'year') where.push("join_date >= '2018-01-01'");
  } else {
    select = `${m.expr} AS ${m.label}`;
  }
  const sql = `SELECT ${select} FROM ${from}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}${group}${order}`;
  return { sql, metric, dim, dep, loc };
}

function autoChart(rows, hint) {
  if (!rows.length || rows.length === 1 || Object.keys(rows[0]).length < 2) return null;
  const cols = Object.keys(rows[0]);
  const x = cols.find((c) => typeof rows[0][c] === 'string') || cols[0];
  const y = cols.find((c) => c !== x && typeof rows[0][c] === 'number');
  if (!y) return null;
  const timey = /^(year|month)$|date/.test(x);
  const type = hint && hint !== 'auto' ? hint : timey ? 'line' : /gender|status|reason/.test(x) && !/pct|avg/.test(y) ? 'doughnut' : 'bar';
  return { type, x, y };
}

function describe(rows, chart) {
  if (!rows.length) return 'No rows matched.';
  const cols = Object.keys(rows[0]);
  if (rows.length === 1 && cols.length <= 2) return cols.map((c) => `**${c.replace(/_/g, ' ')}**: ${rows[0][c]}`).join(' · ');
  if (!chart) return `Found ${rows.length} rows.`;
  const { x, y } = chart;
  const s = [...rows].sort((a, b) => b[y] - a[y]);
  const avg = rows.reduce((a, r) => a + (r[y] || 0), 0) / rows.length;
  if (chart.type === 'line') {
    const first = rows[0], last = rows[rows.length - 1];
    const ch = first[y] ? Math.round(((last[y] - first[y]) / first[y]) * 100) : 0;
    return `${y.replace(/_/g, ' ')} went from **${first[y]}** (${first[x]}) to **${last[y]}** (${last[x]}) — ${ch >= 0 ? 'up' : 'down'} ${Math.abs(ch)}%. Peak: ${s[0][x]} (${s[0][y]}).`;
  }
  return `Highest **${y.replace(/_/g, ' ')}** is **${s[0][x]}** (${s[0][y]}), lowest is **${s.at(-1)[x]}** (${s.at(-1)[y]}); average across ${rows.length} groups is ${avg.toFixed(1)}.` +
    (s[0][y] > avg * 1.4 ? ` ${s[0][x]} stands out at ${(s[0][y] / avg).toFixed(1)}× the average — worth a closer look.` : '');
}

export async function dataAgent({ query, ctx, tracer, session }) {
  const prev = session.lastData;
  let sql, chartHint = 'auto', title = query, plan = null;

  if (isOffline()) {
    plan = compose(query, prev);
    if (!plan) return { agent: 'data', confidence: 0.2, text: "I couldn't map that to a metric I know (headcount, attrition, engagement, hires, tenure, tickets, leave, diversity, salary). Try rephrasing, or connect an LLM for free-form questions." };
    sql = plan.sql;
    tracer.step('data', 'plan', `semantic layer → metric=${plan.metric}, by=${plan.dim || '—'}${plan.dep ? `, dept=${plan.dep}` : ''}${plan.loc ? `, loc=${plan.loc}` : ''}`);
  } else {
    const out = await chatJSON({
      system: `You are a senior people-analytics engineer. Convert the question into ONE SQLite SELECT over this schema:\n${SCHEMA}\n
Rules: aggregate where sensible; alias columns in snake_case; ORDER results meaningfully; never use SELECT *; for "current" headcount filter status='Active'.
The user's access level is "${ctx.access}". ${ctx.access === 'hr' ? '' : 'They CANNOT access salary_lpa or performance_rating: if asked, set refuse to the reason and sql to "".'}
Follow-up questions refer to the previous query if given. Leave refuse as "" when answering.`,
      schema: SqlSchema, name: 'text_to_sql',
      messages: [{ role: 'user', content: `${prev ? `Previous question: ${prev.question}\nPrevious SQL: ${prev.sql}\n\n` : ''}Question: ${query}` }],
    });
    if (out.refuse) return { agent: 'data', confidence: 0.9, text: `🔒 ${out.refuse}`, blocked: true };
    ({ sql, chart: chartHint = 'auto', title = query } = out);
  }

  let result, attempts = 0;
  while (true) {
    attempts++;
    tracer.step('data', 'sql', `attempt ${attempts}`, sql);
    try {
      result = await callTool('run_sql', { sql }, ctx);
      break;
    } catch (e) {
      if (e.code) { // guard / RBAC violations are policy, not bugs: don't retry around them
        tracer.step('data', 'guard', `blocked: ${e.code}`, e.message);
        return { agent: 'data', confidence: 0.9, text: `🔒 ${e.message}`, sql, blocked: true };
      }
      tracer.step('data', 'error', `SQL error: ${e.message}`);
      if (isOffline() || attempts >= 3) return { agent: 'data', confidence: 0.2, text: `I couldn't run that query (${e.message}).`, sql };
      const fix = await chatJSON({ // self-correction loop
        system: `Fix this SQLite query so it runs. Schema:\n${SCHEMA}`,
        schema: FixSchema, name: 'fixed_sql',
        messages: [{ role: 'user', content: `Question: ${query}\nSQL: ${sql}\nError: ${e.message}` }],
      });
      sql = fix.sql;
    }
  }
  const rows = result.rows;
  tracer.step('data', 'tool', `run_sql → ${rows.length} rows`);
  const chart = chartHint === 'none' ? null : autoChart(rows, chartHint);

  let text = describe(rows, chart);
  if (!isOffline() && rows.length) {
    try {
      const ins = await chatJSON({
        system: 'You are a people-analytics expert. Given a question and query results, write a 2-3 sentence insight: the headline number, the most notable pattern, and one sensible follow-up question. Use **bold** for key numbers. Do not invent data.',
        schema: InsightSchema, name: 'insight',
        messages: [{ role: 'user', content: `Question: ${query}\nRows (first 40): ${JSON.stringify(rows.slice(0, 40))}` }],
      });
      text = ins.insight;
    } catch (e) { tracer.step('data', 'warn', 'insight LLM failed, using computed summary'); }
  }
  session.lastData = { question: query, sql: result.sql, ...(plan || {}) };
  return {
    agent: 'data', confidence: rows.length ? 0.9 : 0.5, text, sql: result.sql,
    table: { columns: rows.length ? Object.keys(rows[0]) : [], rows: rows.slice(0, 50) },
    chart: chart && { ...chart, title, labels: rows.map((r) => r[chart.x]), values: rows.map((r) => r[chart.y]) },
  };
}
