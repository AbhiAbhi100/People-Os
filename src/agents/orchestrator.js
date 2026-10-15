// Orchestrator as a LangGraph StateGraph ("supervisor" pattern).
//
//   START → reset → guard ─┬─(jailbreak / sensitive)──────────────┐
//                          └→ router ──Send×N──→ agent (parallel) ─┴→ gate ─┬→ END
//                                                                            └→ human_approval (interrupt) → END
//
// • Parallel fan-out with `Send` (one branch per sub-task).
// • Conversation memory (history, last data query, last agent) lives in graph state and is
//   persisted per thread by a checkpointer, so follow-ups like "now by location" work.
// • Human-in-the-loop with `interrupt()`: the graph pauses on any proposed write and resumes
//   with `Command({ resume: 'approve' | 'reject' })` when the person clicks.
// • Live trace: nodes write trace steps to LangGraph's custom stream (`config.writer`).
import { z } from 'zod';
import { StateGraph, Annotation, Send, Command, interrupt, MemorySaver, START, END } from '@langchain/langgraph';
import { chatJSON, isOffline, withOffline, providerInfo } from '../llm/provider.js';
import { Tracer } from '../lib/trace.js';
import { policyAgent } from './policyAgent.js';
import { dataAgent } from './dataAgent.js';
import { actionAgent, propose, executeApproved } from './actionAgent.js';
import { careerAgent } from './careerAgent.js';
import { handoffAgent, detectSensitive } from './handoffAgent.js';

export const AGENTS = { policy: policyAgent, data: dataAgent, action: actionAgent, career: careerAgent };
const INJECTION = /ignore (all |any |the )?(previous|prior|above) (instructions|rules)|reveal (your|the) (system )?prompt|you are now (?!on leave)|developer mode|jailbreak|act as (an? )?(admin|hr admin|root)/i;

const RULES = {
  action: [/\b(apply|book|take|mark|cancel)\b.*\b(leave|off|chutti)\b|\bleave (tomorrow|today|on|from)\b/, 3,
    /\b(want|need|take|chahiye|leni|lena)\b.{0,25}\b(leave|chutti|chhutti|off)\b|\b(leave|chutti|chhutti)\b.{0,25}\b(chahiye|leni|lena)\b/, 3,
    /\b(raise|open|log|create)\b.*\bticket\b|not working|broken|stopped working|isn'?t working|\bcrash|not received|not credited|not getting|still pending|issue with|problem with/, 3,
    /\b(i am|i'm|im|feeling)\s+(sick|unwell|ill)\b|\bfever\b|\bbimar/, 3,
    /\b(my|leave) balance|leaves? (left|remaining)|how (much|many) (leave|leaves|chutti)\b.*\b(have|had|left|remaining|bachi|baki)\b|leaves? (do )?i have|\bi (had|have|got)\b.{0,12}\bleaves?\b|kitni (leave|chutti)|my tickets|ticket status|my manager|my hrbp|my profile|my team|my reports|who.*on leave/, 3],
  data: [/headcount|attrition|churn|turnover|trend|over time|by (department|location|level|role|month|year|category|gender)|breakdown|split|average|avg|median|percentage|ratio|distribution|chart|plot|graph|analytics|dashboard/, 2,
    /how many (employees|people|joiners|hires|exits|tickets)|hires|hiring|joiners|engagement|tenure|resolution time|open tickets|diversity|women|exits|leaving|salary (by|per|across)/, 2],
  policy: [/policy|policies|allowed|can i|am i eligible|eligib|entitle|how many (days|leaves) (do|can|will)|rule|reimburs|allowance|insurance|maternity|paternity|parental|bereavement|wfh|work from home|hybrid|carry forward|encash|notice period|claim|limit|esop|medical certificate|holiday|learning budget|another city|abroad|grievance|posh|harassment|ethics|counsell?ing|\beap\b|complaint process/, 2],
  career: [/career|automat|\bai\b.*(job|role|task|replace|take over|handle)|my (job|role) (future|safe)|which tasks|upskill|skills? (to|should)|grow|future of work|next role|career path/, 3],
};

function score(text) {
  const t = text.toLowerCase();
  const s = {};
  for (const [agent, pairs] of Object.entries(RULES)) {
    s[agent] = 0;
    for (let i = 0; i < pairs.length; i += 2) if (pairs[i].test(t)) s[agent] += pairs[i + 1];
  }
  // disambiguation: "how many sick leaves do I get" is policy, "how many leaves do I have left" is action
  if (/\b(left|remaining|balance)\b/.test(t)) s.policy -= 2;
  if (/\bpolicy|allowed|eligible\b/.test(t)) s.action -= 1;
  if (/\b(why are people|reason)/.test(t) && s.data) s.data += 1;
  return s;
}
const best = (s) => { const [a, v] = Object.entries(s).sort((x, y) => y[1] - x[1])[0]; return v > 0 ? a : null; };

function routeOffline(message, memory) {
  const pieces = message.split(/\s+(?:and also|and then|also|then|plus)\s+|\?\s+|;\s*|\.\s+(?=[A-Z])|\s+and\s+(?=(?:apply|raise|book|show|what|how|tell|check|can|is|are|do)\b)/i).map((p) => p.trim()).filter(Boolean);
  const tasks = [];
  for (const p of pieces) {
    const agent = best(score(p)) || (tasks.length ? tasks.at(-1).agent : null) ||
      (memory.lastAgent && /^(now|and|what about|how about|same|only|just|by |break|split)/i.test(p) ? memory.lastAgent : null);
    if (!agent) continue;
    if (tasks.length && tasks.at(-1).agent === agent) tasks.at(-1).query += ` and ${p}`;
    else tasks.push({ agent, query: p });
  }
  return tasks;
}

const RouteSchema = z.object({
  tasks: z.array(z.object({
    agent: z.enum(['policy', 'data', 'action', 'career']),
    query: z.string().describe('self-contained sub-question with pronouns resolved'),
  })).describe('ordered sub-tasks; empty for greetings or off-topic messages'),
});

async function routeLLM(message, memory) {
  const hist = memory.history.slice(-4).map((h) => `user: ${h.user}\nassistant(${h.agents}): ${h.summary}`).join('\n');
  const out = await chatJSON({
    system: `You are the router of an enterprise HR copilot. Specialists:
- policy: questions about HR rules/entitlements (leave rules, WFH, reimbursement, insurance, POSH, benefits).
- data: analytics over HR data (headcount, attrition, hiring trends, engagement, tickets, leave usage, diversity, salary). Charts.
- action: do things or fetch the user's own records (leave balance, apply leave, raise/list tickets, my manager, my team).
- career: which tasks of a role AI can automate vs human-led, skills to grow, career paths.
Split multi-part requests into ordered sub-tasks, each self-contained (resolve pronouns using the history).
Return no tasks for greetings or off-topic messages.`,
    messages: [{ role: 'user', content: `${hist ? `Recent conversation:\n${hist}\n\n` : ''}Message: ${message}` }],
    schema: RouteSchema, name: 'route',
  });
  return (out.tasks || []).filter((t) => AGENTS[t.agent]).slice(0, 4);
}

// ---------------- graph state ----------------
const last = (fallback) => Annotation({ reducer: (_, b) => b, default: () => fallback });
const TurnState = Annotation.Root({
  // per turn
  message: Annotation(),
  tasks: last([]),
  results: Annotation({
    // agents append in parallel; `null` clears; `{ replace }` lets the gate rewrite the list
    reducer: (a, b) => (b === null ? [] : b?.replace ? b.replace : a.concat(b)),
    default: () => [],
  }),
  pending: last(null),          // proposed write waiting for a human
  approvalResult: last(null),
  // memory across turns (checkpointed per thread)
  history: Annotation({ reducer: (a, b) => a.concat(b).slice(-10), default: () => [] }),
  lastData: last(null),
  lastAgent: last(null),
});

const tracerOf = (config) => new Tracer((s) => config.writer?.({ ...s, node: config.metadata?.langgraph_node }), config.configurable?.t0);
const ctxOf = (config) => config.configurable.ctx;

async function resetNode(state, config) {
  const { provider, model } = providerInfo();
  const ctx = ctxOf(config);
  tracerOf(config).step('orchestrator', 'start', `${ctx.user.name} (${ctx.access}) · ${provider}/${model} · LangGraph`);
  return { results: null, tasks: [], pending: null, approvalResult: null };
}

async function guardNode(state, config) {
  const tracer = tracerOf(config);
  if (INJECTION.test(state.message)) {
    tracer.step('orchestrator', 'guard', 'prompt-injection pattern detected → refused');
    return { results: [{ _i: 0, agent: 'guard', text: "I can't change my instructions or permissions. Access comes from your employee role, not from the chat. Happy to help with HR questions, data or actions though!" }] };
  }
  if (detectSensitive(state.message)) {
    const r = handoffAgent({ query: state.message, ctx: ctxOf(config), tracer });
    r.pendingAction = propose({ tool: 'raise_ticket', args: r.handoff.suggestTicket }, tracer, 'handoff');
    return { results: [{ ...r, _i: 0 }], tasks: [{ agent: 'handoff', query: state.message }] };
  }
  return {};
}

async function routerNode(state, config) {
  const tracer = tracerOf(config);
  const memory = { history: state.history, lastAgent: state.lastAgent };
  let tasks;
  try {
    tasks = isOffline() ? routeOffline(state.message, memory) : await routeLLM(state.message, memory);
  } catch (e) {
    tracer.step('orchestrator', 'warn', `LLM unavailable (${String(e.message).replace(/\s+/g, ' ').slice(0, 120)}) → rule router`);
    tasks = routeOffline(state.message, memory);
  }
  tracer.step('orchestrator', 'route', tasks.length ? `plan: ${tasks.map((t) => t.agent).join(' + ')}` : 'no specialist matched', tasks.map((t) => `${t.agent} ← "${t.query}"`).join('\n'));
  if (!tasks.length) {
    const name = ctxOf(config).user.name.split(' ')[0];
    const msg = state.message.toLowerCase().trim();
    if (/^(thanks|thank you|thx|ty|ok|okay|cool|great|nice|shukriya|dhanyavaad)\b/.test(msg)) {
      return { tasks, results: [{ _i: 0, agent: 'orchestrator', text: `Happy to help, ${name}! Anything else — leave, policies, people data or your career?` }] };
    }
    const greet = /^(hi|hello|hey|hii+|namaste|good (morning|afternoon|evening))\b/.test(msg);
    return { tasks, results: [{ _i: 0, agent: 'orchestrator', text: `${greet ? `Hi ${name}! I'm PeopleOS.` : "I didn't quite get that."} I can:\n\n• **Answer policy questions** with citations — "How many sick leaves can I take without a certificate?"\n• **Analyse people data** with charts — "Attrition by department", then "now by location"\n• **Take actions** with your approval — "Apply casual leave tomorrow", "My laptop VPN isn't working"\n• **Career insights** — "Which parts of my job can AI automate?"` }] };
  }
  return { tasks };
}

/** One specialist run. Receives a Send payload (not the whole state). */
async function agentNode(payload, config) {
  const { task, i, lastData } = payload;
  const tracer = tracerOf(config);
  const session = { lastData }; // the data agent reads/updates its follow-up context here
  const run = () => AGENTS[task.agent]({ query: task.query, ctx: ctxOf(config), tracer, session });
  let r;
  try {
    r = await tracer.span(task.agent, `${task.agent} agent`, run);
  } catch (e) {
    if (isOffline()) r = { agent: task.agent, confidence: 0, text: `Something went wrong: ${e.message}` };
    else {
      tracer.step(task.agent, 'warn', 'LLM failure → degrading this agent to offline mode');
      r = await withOffline(run).catch((e2) => ({ agent: task.agent, confidence: 0, text: `Something went wrong: ${e2.message}` }));
    }
  }
  return { results: [{ ...r, _i: i }], ...(session.lastData !== lastData ? { lastData: session.lastData } : {}) };
}

/** Join point: order results, confidence gate, pick the one write that needs approval, update memory. */
async function gateNode(state, config) {
  const tracer = tracerOf(config);
  const results = [...state.results].sort((a, b) => a._i - b._i);
  for (const r of results) {
    if ((r.confidence ?? 1) < 0.35 && ['policy', 'data'].includes(r.agent) && !r.blocked && !results.some((x) => x.pendingAction)) {
      tracer.step('orchestrator', 'handoff', `${r.agent} confidence ${r.confidence} < 0.35 → offering human handoff`);
      r.text += '\n\nWant me to send this question to the HR team? They usually reply within 2 working days.';
      r.pendingAction = propose({ tool: 'raise_ticket', args: { category: 'HR Query', description: state.message, priority: 'Low' } }, tracer, 'orchestrator');
    }
  }
  // one approval per turn keeps the UX clear; extra proposals are dropped with a note
  const withPending = results.filter((r) => r.pendingAction);
  for (const r of withPending.slice(1)) { delete r.pendingAction; r.text += '\n\n_(One approval at a time: ask again after you decide on the first one.)_'; }
  tracer.step('orchestrator', 'end', withPending.length ? 'gate → human_approval: graph paused with interrupt()' : `gate → END · ${results.length} result(s)`);
  return {
    results: { replace: results },
    pending: withPending[0]?.pendingAction ?? null,
    history: [{ user: state.message, agents: results.map((r) => r.agent).join('+'), summary: results.map((r) => r.text).join(' ').slice(0, 300) }],
    ...(state.tasks.length ? { lastAgent: state.tasks.at(-1).agent } : {}),
  };
}

/** Human-in-the-loop: the graph pauses here until the person approves or rejects. */
async function humanApprovalNode(state, config) {
  const decision = interrupt({ id: state.pending.id, tool: state.pending.tool, preview: state.pending.preview });
  const result = await executeApproved(state.pending, decision, ctxOf(config), tracerOf(config));
  return { approvalResult: result, pending: null };
}

export const checkpointer = new MemorySaver(); // swap for a Postgres/SQLite saver in production

export const peopleGraph = new StateGraph(TurnState)
  .addNode('reset', resetNode)
  .addNode('guard', guardNode)
  .addNode('router', routerNode)
  .addNode('agent', agentNode)
  .addNode('gate', gateNode)
  .addNode('human_approval', humanApprovalNode)
  .addEdge(START, 'reset')
  .addEdge('reset', 'guard')
  .addConditionalEdges('guard', (s) => (s.results.length ? 'gate' : 'router'), ['gate', 'router'])
  .addConditionalEdges('router', (s) => (s.tasks.length
    ? s.tasks.map((task, i) => new Send('agent', { task, i, lastData: s.lastData }))
    : 'gate'), ['agent', 'gate'])
  .addEdge('agent', 'gate')
  .addConditionalEdges('gate', (s) => (s.pending ? 'human_approval' : END), ['human_approval', END])
  .addEdge('human_approval', END)
  .compile({ checkpointer, name: 'peopleos' });

// ---------------- public API (used by the server, evals) ----------------
async function drive(input, { threadId, ctx, onTrace }) {
  const t0 = Date.now();
  const config = { configurable: { thread_id: threadId, ctx, t0 }, streamMode: ['custom'], recursionLimit: 30 };
  for await (const [, step] of await peopleGraph.stream(input, config)) onTrace?.(step);
  const state = await peopleGraph.getState({ configurable: { thread_id: threadId } });
  return { state, ms: Date.now() - t0 };
}

/** Run one user turn. If a write was proposed, the graph is left paused at human_approval. */
export async function runTurn({ threadId, message, ctx, onTrace }) {
  const { state, ms } = await drive({ message }, { threadId, ctx, onTrace });
  const v = state.values;
  const results = v.results.map(({ _i, ...r }) => r);
  return { route: { tasks: v.tasks }, results, ms, awaitingApproval: state.next.includes('human_approval'), ...providerInfo() };
}

/** Resume a paused graph with the person's decision. Stale or unknown ids are refused. */
export async function resumeTurn({ threadId, id, decision, ctx, onTrace }) {
  const cur = await peopleGraph.getState({ configurable: { thread_id: threadId } });
  if (!cur.next.includes('human_approval') || cur.values.pending?.id !== id) {
    return { route: { tasks: [] }, results: [{ agent: 'action', text: 'That request has expired or was already handled. Ask again if you still need it.' }], ...providerInfo() };
  }
  const { state, ms } = await drive(new Command({ resume: decision === 'approve' ? 'approve' : 'reject' }), { threadId, ctx, onTrace });
  return { route: { tasks: [] }, results: [state.values.approvalResult], ms, ...providerInfo() };
}
