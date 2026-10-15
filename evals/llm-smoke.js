// LLM-mode smoke test: runs the real LangChain/LangGraph code against a fake OpenAI server.
//   npm run test:llm
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const PORT = 4999;
Object.assign(process.env, {
  PEOPLEOS_DB: join(mkdtempSync(join(tmpdir(), 'peopleos-llm-')), 'llm.db'),
  LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'test', OPENAI_BASE_URL: `http://localhost:${PORT}/v1`, LLM_MODEL: 'mock',
});
const { startMockLLM, mockLog } = await import('./mockOpenAI.js');
const server = await startMockLLM(PORT);
const { seed } = await import('../src/db/seed.js');
seed(process.env.PEOPLEOS_DB);
const { runTurn, resumeTurn } = await import('../src/agents/orchestrator.js');
const { PERSONAS } = await import('../src/db/index.js');
const { usage } = await import('../src/llm/provider.js');
const ctx = { user: PERSONAS.E1003, access: 'hr' };

const checks = [];
const check = (name, fn) => checks.push([name, fn]);
let steps = [];
const turn = (message, threadId = 't') => { steps = []; return runTurn({ threadId, message, ctx, onTrace: (s) => steps.push(s) }); };

check('LLM router splits a multi-part message', async () => {
  const r = await turn('Can I carry forward leaves and my balance?', 'a');
  assert.deepEqual(r.route.tasks.map((t) => t.agent), ['policy', 'action']);
  assert.match(r.results[0].text, /\[leave-policy#carry-forward-and-encashment\]/);
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

let ok = 0;
for (const [name, fn] of checks) {
  try { await fn(); ok++; console.log(`✓ ${name}`); } catch (e) { console.log(`✗ ${name}\n   ${e.message}`); }
}
console.log(`\n${ok}/${checks.length} passed · ${usage.calls} LangChain model calls · mock saw: ${[...new Set(mockLog.map((l) => l.split(':')[0] + ':' + l.split(':')[1]))].join(', ')}`);
server.close();
process.exit(ok === checks.length ? 0 : 1);
