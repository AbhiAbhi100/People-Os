import express from 'express';
import { fileURLToPath } from 'node:url';
import { runTurn, resumeTurn, peopleGraph } from './agents/orchestrator.js';
import { PERSONAS } from './db/index.js';
import { providerInfo, usage } from './llm/provider.js';

const app = express();
app.use(express.json({ limit: '50kb' }));
app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));
// Serve Chart.js from node_modules so the UI works fully offline (no CDN dependency)
app.get('/vendor/chart.js', (_, res) => res.sendFile(fileURLToPath(new URL('../node_modules/chart.js/dist/chart.umd.min.js', import.meta.url))));

// Conversation memory + paused approvals live in the LangGraph checkpointer, one thread per browser session + persona.
const threadOf = (sid, uid) => `${String(sid).slice(0, 64)}:${uid}`;
const metrics = { requests: 0, totalMs: 0, byAgent: {}, approvals: { approve: 0, reject: 0 }, handoffs: 0, blocked: 0 };

function ctxFor(userId) {
  const user = PERSONAS[userId];
  if (!user) throw Object.assign(new Error('Unknown user'), { status: 400 });
  return { user, access: user.access };
}

// Stream agent trace steps (LangGraph custom stream) live over Server-Sent Events, then the final result.
async function stream(res, work) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  try {
    send('result', await work((step) => send('trace', step)));
  } catch (e) {
    console.error(e);
    send('error', { message: e.message });
  }
  res.end();
}

app.get('/api/config', (_, res) => res.json({ ...providerInfo(), orchestrator: 'LangGraph', personas: Object.values(PERSONAS) }));

// The orchestrator graph itself, as Mermaid (rendered by LangGraph)
app.get('/api/graph', async (_, res) => res.type('text/plain').send((await peopleGraph.getGraphAsync()).drawMermaid()));

app.post('/api/chat', (req, res) => {
  const { sessionId = 'anon', userId, message } = req.body || {};
  if (!message?.trim() || message.length > 2000) return res.status(400).json({ error: 'message must be 1-2000 chars' });
  let ctx;
  try { ctx = ctxFor(userId); } catch (e) { return res.status(400).json({ error: e.message }); }
  stream(res, async (onTrace) => {
    const out = await runTurn({ threadId: threadOf(sessionId, userId), message: message.trim(), ctx, onTrace });
    metrics.requests++; metrics.totalMs += out.ms;
    for (const r of out.results) {
      metrics.byAgent[r.agent] = (metrics.byAgent[r.agent] || 0) + 1;
      if (r.agent === 'handoff' || r.pendingAction?.args?.category === 'HR Query') metrics.handoffs++;
      if (r.blocked || r.agent === 'guard') metrics.blocked++;
    }
    return out;
  });
});

app.post('/api/approve', (req, res) => {
  const { sessionId = 'anon', userId, id, decision } = req.body || {};
  let ctx;
  try { ctx = ctxFor(userId); } catch (e) { return res.status(400).json({ error: e.message }); }
  stream(res, async (onTrace) => {
    metrics.approvals[decision === 'approve' ? 'approve' : 'reject']++;
    return resumeTurn({ threadId: threadOf(sessionId, userId), id, decision, ctx, onTrace });
  });
});

app.get('/api/metrics', (_, res) => res.json({
  ...metrics, avgLatencyMs: metrics.requests ? Math.round(metrics.totalMs / metrics.requests) : 0, llm: { ...providerInfo(), ...usage },
}));

const PORT = +(process.env.PORT || 3000);
app.listen(PORT, () => {
  const { provider, model } = providerInfo();
  console.log(`\n  PeopleOS running → http://localhost:${PORT}`);
  console.log(`  Orchestrator: LangGraph StateGraph · LLM via LangChain: ${provider}${provider === 'offline' ? ' (no API key set — deterministic agents; add a key in .env for full LLM mode)' : ` / ${model}`}\n`);
});
