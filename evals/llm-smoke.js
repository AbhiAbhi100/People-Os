// LLM-mode smoke test: runs the real LangChain/LangGraph code against a fake OpenAI server.
//   npm run test:llm
import assert from 'node:assert/strict';

// npm run test:llm            → OpenAI-compatible path (ChatOpenAI)
// npm run test:llm -- gemini   → Gemini path (ChatGoogleGenerativeAI)
const provider = process.argv[2] === 'gemini' ? 'gemini' : 'openai';
const PORT = provider === 'gemini' ? 4998 : 4999;
Object.assign(process.env, {
  PEOPLEOS_DB: 'memory',
  LLM_PROVIDER: provider, LLM_MODEL: 'mock', PEOPLEOS_TODAY: '2026-10-13',
  ...(provider === 'gemini'
    ? { GEMINI_API_KEY: 'test', GEMINI_BASE_URL: `http://localhost:${PORT}` }
    : { OPENAI_API_KEY: 'test', OPENAI_BASE_URL: `http://localhost:${PORT}/v1` }),
});
const mock = provider === 'gemini' ? await import('./mockGemini.js') : await import('./mockOpenAI.js');
const mockLog = mock.mockLog;
const server = await (provider === 'gemini' ? mock.startMockGemini(PORT) : mock.startMockLLM(PORT));
console.log(`LLM path: ${provider}\n`);
const { seedCompanies, PERSONAS } = await import('./fixtures/seedCompany.js');
await seedCompanies();
const { runTurn, resumeTurn } = await import('../src/agents/orchestrator.js');
const { one } = await import('../src/db/pg.js');
const { usage } = await import('../src/llm/provider.js');
const u = await one(`SELECT p.*, c.name AS company_name, c.settings FROM people p JOIN companies c ON c.id = p.company_id WHERE p.email = $1`, [PERSONAS.E1003]);
const ctx = { user: { id: u.id, name: u.name, email: u.email, title: u.title, access: u.access, company_id: u.company_id }, access: u.access, company: { id: u.company_id, name: u.company_name, settings: u.settings } };

const checks = [];
const check = (name, fn) => checks.push([name, fn]);
let steps = [];
const turn = (message, threadId = 't') => { steps = []; return runTurn({ threadId, message, ctx, onTrace: (s) => steps.push(s) }); };

check('LLM router splits a multi-part message', async () => {
  const r = await turn('Can I carry forward leaves and my balance?', 'a');
  assert.deepEqual(r.route.tasks.map((t) => t.agent), ['policy', 'action']);
  assert.match(r.results[0].text, /\[[0-9a-f]{8}#\d+\]/);
});
check('ReAct subgraph adapts after a validation error, then interrupts for approval', async () => {
  const r = await turn('apply leave tomorrow', 'b');
  assert.ok(steps.some((s) => s.kind === 'guard' && /notice/.test(s.label)), 'expected a validation error first');
  assert.equal(r.awaitingApproval, true);
  const p = r.results.find((x) => x.pendingAction).pendingAction;
  assert.equal(p.args.leave_type, 'Casual');
  const done = await resumeTurn({ threadId: 'b', id: p.id, decision: 'approve', ctx });
  assert.match(done.results[0].text, /submitted/);
});
check('text-to-SQL self-corrects a bad column', async () => {
  const r = await turn('attrition please', 'c');
  assert.ok(steps.some((s) => s.kind === 'error' && /no such column/.test(s.label)));
  assert.equal(r.results[0].chart?.type, 'bar');
});
check('career narrative comes from the model, numbers from the scorer', async () => {
  const r = await turn('what can AI automate in my job', 'd');
  assert.match(r.results[0].text, /hand dashboards to AI/);
  assert.ok(r.results[0].career.tasks.length > 0);
});

if (provider === 'gemini') check('overloaded model (503) falls back to the backup model, not to rules', async () => {
  const saved = { ...process.env };
  Object.assign(process.env, { LLM_MODEL: 'busy-model', LLM_FALLBACK_MODEL: 'mock', LLM_MAX_RETRIES: '0' });
  try {
    const r = await turn('Can I carry forward leaves and my balance?', 'e');
    assert.ok(!steps.some((s) => /rule router/.test(s.label)), 'should not have dropped to the rule router');
    assert.deepEqual(r.route.tasks.map((t) => t.agent), ['policy', 'action']);
    assert.ok(mockLog.includes('503:busy'), 'main model should have been tried first');
  } finally { process.env.LLM_MODEL = saved.LLM_MODEL; delete process.env.LLM_FALLBACK_MODEL; delete process.env.LLM_MAX_RETRIES; }
});

let ok = 0;
for (const [name, fn] of checks) {
  try { await fn(); ok++; console.log(`✓ ${name}`); } catch (e) { console.log(`✗ ${name}\n   ${e.message}`); }
}
console.log(`\n${ok}/${checks.length} passed · ${usage.calls} LangChain model calls · mock saw: ${[...new Set(mockLog.map((l) => l.split(':')[0] + ':' + l.split(':')[1]))].join(', ')}`);
server.close();
process.exit(ok === checks.length ? 0 : 1);
