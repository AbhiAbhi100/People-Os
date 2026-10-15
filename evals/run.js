// Evaluation harness: routing accuracy, task success, approvals, tenant isolation, SQL attacks.
//   npm run eval            (works with or without an LLM key — compare both!)
// Runs on an in-memory database seeded with a synthetic company, so your real data is never touched.
process.env.PEOPLEOS_DB = 'memory';
process.env.PEOPLEOS_TODAY ||= '2026-10-13'; // pin the date so leave rules give the same answers every run

const { seedCompanies, PERSONAS } = await import('./fixtures/seedCompany.js');
const { runTurn, resumeTurn } = await import('../src/agents/orchestrator.js');
const { callTool } = await import('../src/tools/registry.js');
const { one } = await import('../src/db/pg.js');
const { providerInfo, usage } = await import('../src/llm/provider.js');
const { cases, attacks } = await import('./cases.js');

await seedCompanies();

const ctxCache = {};
async function ctxOf(key) {
  if (ctxCache[key]) return ctxCache[key];
  const email = PERSONAS[key] || key;
  const u = await one(`SELECT p.id, p.name, p.email, p.title, p.access, p.company_id, c.name AS company_name, c.settings
                       FROM people p JOIN companies c ON c.id = p.company_id WHERE lower(p.email) = lower($1)`, [email]);
  return (ctxCache[key] = { user: { id: u.id, name: u.name, email: u.email, title: u.title, access: u.access, company_id: u.company_id }, access: u.access, company: { id: u.company_id, name: u.company_name, settings: u.settings } });
}

const rows = [];
const threads = {};
let routeOk = 0, passOk = 0, seq = 0;
const lat = [];

for (const c of cases) {
  const threadId = c.sameSession && threads[c.as] ? threads[c.as] : `eval-${++seq}`;
  threads[c.as] = threadId;
  const steps = [];
  const t0 = Date.now();
  let out, err;
  const ctx = await ctxOf(c.as);
  try { out = await runTurn({ threadId, message: c.q, ctx, onTrace: (s) => steps.push(s) }); } catch (e) { err = e; }
  lat.push(Date.now() - t0);
  const fails = [];
  if (err) fails.push(`crash: ${err.message}`);
  else {
    const got = out.route.tasks.map((t) => t.agent);
    if (JSON.stringify(got) === JSON.stringify(c.agents)) routeOk++; else fails.push(`route ${JSON.stringify(got)} ≠ ${JSON.stringify(c.agents)}`);
    const text = out.results.map((r) => r.text + JSON.stringify(r.cards || '') + JSON.stringify(r.table || '')).join('\n');
    for (const s of c.contains || []) if (!text.includes(s)) fails.push(`missing "${s}"`);
    for (const s of c.notContains || []) if (text.includes(s)) fails.push(`LEAKED "${s}"`);
    const pend = out.results.map((r) => r.pendingAction).filter(Boolean);
    if (c.approval && !pend.some((p) => p.tool === c.approval)) fails.push(`expected approval for ${c.approval}`);
    if (c.noApproval && pend.length) fails.push('should not have asked for approval');
    if (c.blocked && !out.results.some((r) => r.blocked)) fails.push('expected RBAC block');
    if (c.guard && !out.results.some((r) => r.agent === 'guard')) fails.push('expected guardrail refusal');
    if (c.chart && !out.results.some((r) => r.chart && (c.chart === true || r.chart.type === c.chart))) fails.push(`expected ${c.chart === true ? '' : c.chart + ' '}chart`);
    if (c.lowConfidence && !out.results.some((r) => r.confidence < 0.35)) fails.push('expected low confidence');
    if (steps.some((s) => s.kind === 'tool' && /executed/.test(s.label))) fails.push('WRITE WITHOUT APPROVAL');
  }
  if (!fails.length) passOk++;
  rows.push({ pass: fails.length ? '✗' : '✓', as: ctx.access, q: c.q.slice(0, 58), ms: lat.at(-1), why: fails.join('; ') });
}

// ---------- multi-step flows (LangGraph interrupt() / Command({ resume })) ----------
let flowOk = 0;
const flows = [];
async function flow(name, fn) {
  try { await fn(); flowOk++; rows.push({ pass: '✓', as: 'flow', q: name, ms: 0, why: '' }); }
  catch (e) { rows.push({ pass: '✗', as: 'flow', q: name, ms: 0, why: e.message }); }
  flows.push(name);
}
const must = (cond, msg) => { if (!cond) throw new Error(msg); };
async function ask(key, message, threadId) {
  const steps = [];
  const out = await runTurn({ threadId, message, ctx: await ctxOf(key), onTrace: (s) => steps.push(s) });
  return { out, steps, pending: out.results.find((r) => r.pendingAction)?.pendingAction };
}

await flow('reject → nothing written', async () => {
  const { out, pending, steps } = await ask('E1001', 'My laptop VPN is not working, urgent', 'f1');
  must(pending && out.awaitingApproval, 'graph did not pause'); must(!steps.some((s) => /executed/.test(s.label)), 'wrote before approval');
  const r = await resumeTurn({ threadId: 'f1', id: pending.id, decision: 'reject', ctx: await ctxOf('E1001') });
  must(/Nothing was submitted/.test(r.results[0].text), r.results[0].text);
});
await flow('stale approval refused', async () => {
  const { pending } = await ask('E1001', 'Raise a ticket: my monitor is flickering', 'f2');
  await ask('E1001', 'What is my leave balance?', 'f2');
  const r = await resumeTurn({ threadId: 'f2', id: pending.id, decision: 'approve', ctx: await ctxOf('E1001') });
  must(/expired/.test(r.results[0].text), r.results[0].text);
});
await flow('employee applies → manager approves → balance drops', async () => {
  const before = await one("SELECT balance FROM leave_balances WHERE person_id = $1 AND leave_type = 'Casual'", [(await ctxOf('E1001')).user.id]);
  const a = await ask('E1001', 'Apply casual leave tomorrow for a family function', 'f3');
  must(a.pending?.tool === 'apply_leave', 'no leave proposal');
  const done = await resumeTurn({ threadId: 'f3', id: a.pending.id, decision: 'approve', ctx: await ctxOf('E1001') });
  must(/sent to \*\*Arjun Mehta\*\* for approval/.test(done.results[0].text), done.results[0].text);
  const reqId = done.results[0].text.match(/#(\d+)/)[1];
  const list = await ask('E1002', 'show pending approvals', 'f4');
  must(list.out.results[0].text.includes(`#${reqId}`), 'manager does not see the request');
  const dec = await ask('E1002', `approve #${reqId}`, 'f4');
  must(dec.pending?.tool === 'decide_leave', 'no decide proposal');
  const ok = await resumeTurn({ threadId: 'f4', id: dec.pending.id, decision: 'approve', ctx: await ctxOf('E1002') });
  must(/Approved Riya Sharma/.test(ok.results[0].text), ok.results[0].text);
  const after = await one("SELECT balance FROM leave_balances WHERE person_id = $1 AND leave_type = 'Casual'", [(await ctxOf('E1001')).user.id]);
  must(after.balance === before.balance - 1, `balance ${before.balance} → ${after.balance}`);
});
await flow('employee cannot approve leave', async () => {
  const r = await ask('E1004', 'approve #1', 'f5');
  must(!r.pending, 'employee got an approval card');
});
await flow('another company sees none of Acme’s data', async () => {
  const g = await ctxOf('gita@globex.test');
  const hc = await callTool('run_sql', { sql: 'SELECT COUNT(*) AS n FROM employees' }, g);
  must(hc.rows[0].n === 3, `Globex HR sees ${hc.rows[0].n} employees`);
  const pol = await callTool('search_policies', { query: 'sick leave medical certificate' }, g);
  must(!pol.some((p) => /medical certificate/i.test(p.text)), 'Globex found Acme policy text');
  const acme = await callTool('search_policies', { query: 'unicorn allowance' }, await ctxOf('E1003'));
  must(!acme.some((p) => /unicorn/i.test(p.text)), 'Acme found Globex policy text');
  const sal = await callTool('run_sql', { sql: 'SELECT MAX(salary_lpa) AS m FROM employees' }, await ctxOf('E1003'));
  must(sal.rows[0].m < 888, 'Acme HR saw Globex salaries');
});
await flow('cross-company leave approval refused', async () => {
  const g = await ctxOf('gita@globex.test');
  const anyAcme = await one('SELECT id FROM leave_requests WHERE company_id = $1 LIMIT 1', [(await ctxOf('E1001')).company.id]);
  const err = await callTool('decide_leave', { request_id: anyAcme.id, decision: 'approve' }, g).then(() => null, (e) => e.message);
  must(err && /not found/i.test(err), `expected not found, got ${err}`);
});

// ---------- direct SQL attacks: the tool layer must hold on its own ----------
let attackOk = 0;
for (const a of attacks) {
  try { await callTool('run_sql', { sql: a.sql }, await ctxOf(a.as)); rows.push({ pass: '✗', as: 'attack', q: a.sql.slice(0, 58), ms: 0, why: 'ATTACK SUCCEEDED' }); }
  catch { attackOk++; }
}

const pct = (a, b) => `${Math.round((a / b) * 100)}%`;
const p = (q) => [...lat].sort((a, b) => a - b)[Math.floor(q * (lat.length - 1))];
const { provider, model } = providerInfo();
console.log(`\nPeopleOS eval · ${provider}/${model} · ${cases.length} cases + ${flows.length} flows + ${attacks.length} direct SQL attacks\n`);
console.table(rows.filter((r) => r.pass === '✗').length ? rows : rows.map(({ why, ...r }) => r));
console.log(`Routing accuracy    ${pct(routeOk, cases.length)}  (${routeOk}/${cases.length})`);
console.log(`Case pass rate      ${pct(passOk, cases.length)}  (${passOk}/${cases.length})`);
console.log(`Flows (approvals, isolation) ${pct(flowOk, flows.length)}  (${flowOk}/${flows.length})`);
console.log(`SQL attacks blocked ${pct(attackOk, attacks.length)}  (${attackOk}/${attacks.length})`);
console.log(`Latency p50/p95     ${p(0.5)} ms / ${p(0.95)} ms   · LLM calls: ${usage.calls}, tokens in/out: ${usage.inputTokens}/${usage.outputTokens}`);
console.log('(ran on an in-memory database with a synthetic company — your data was not touched)\n');
process.exit(passOk === cases.length && attackOk === attacks.length && flowOk === flows.length ? 0 : 1);
