// Action Agent: does things for the employee.
//   LLM mode     → a LangGraph ReAct subgraph: model.bindTools(tools) ⇄ ToolNode, max 6 hops.
//   Offline mode → deterministic intent parser over the SAME tools.
// Safety model: read tools run freely; WRITE tools are validated and only *proposed*.
// The proposal travels up to the orchestrator graph, which pauses with LangGraph `interrupt()`
// until a human clicks Approve. Nothing is written without that click.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { StateGraph, MessagesAnnotation, START, END } from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { tool } from '@langchain/core/tools';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { tools, callTool } from '../tools/registry.js';
import { getChatModel, isOffline, textOf } from '../llm/provider.js';
import { parseDateRange, iso, TODAY } from '../lib/dates.js';

const ALLOWED = ['get_leave_balance', 'apply_leave', 'raise_ticket', 'get_my_tickets', 'get_profile', 'get_team'];
const MAX_HOPS = 6;

/** A write the agent wants to do. The orchestrator graph interrupts on it for human approval. */
export function propose(call, tracer, agent = 'action') {
  const preview = tools[call.tool].preview(call.args);
  tracer.step(agent, 'approval', `proposed ${call.tool}: waiting for human approval`, preview);
  return { id: randomUUID().slice(0, 8), tool: call.tool, args: call.args, preview };
}

// ---------- LLM mode: LangGraph ReAct subgraph ----------
/** Registry tools as LangChain tools, bound to this user's ctx. Write tools only record a proposal. */
function langchainTools(ctx, tracer, scratch) {
  return ALLOWED.map((name) => {
    const t = tools[name];
    return tool(async (args) => {
      if (t.writes) {
        const err = t.validate(args, ctx);
        if (err) { tracer.step('action', 'guard', `validation: ${err}`); return `VALIDATION_ERROR: ${err}`; }
        scratch.proposal = { tool: name, args };
        return 'PROPOSED. A human must approve this before it is submitted. Stop calling tools.';
      }
      try {
        const obs = await callTool(name, args, ctx);
        tracer.step('action', 'tool', `${name}(${JSON.stringify(args)})`, JSON.stringify(obs).slice(0, 600));
        scratch.cards.push({ tool: name, data: obs });
        return JSON.stringify(obs).slice(0, 3000);
      } catch (e) {
        tracer.step('action', 'error', `${name}: ${e.message}`);
        return `ERROR: ${e.message}`;
      }
    }, { name, description: t.description, schema: z.object(t.input) });
  });
}

function buildReactGraph(model, lcTools, scratch, tracer) {
  const bound = model.bindTools(lcTools);
  return new StateGraph(MessagesAnnotation)
    .addNode('agent', async (s) => {
      const ai = await bound.invoke(s.messages);
      const calls = ai.tool_calls || [];
      tracer.step('action', 'think', calls.length ? `model chose ${calls.map((c) => c.name).join(', ')}` : 'model wrote final answer', textOf(ai).slice(0, 300) || undefined);
      return { messages: [ai] };
    })
    .addNode('tools', new ToolNode(lcTools))
    .addEdge(START, 'agent')
    .addConditionalEdges('agent', (s) => (s.messages.at(-1).tool_calls?.length ? 'tools' : END), ['tools', END])
    // a proposed write ends the loop: the orchestrator takes over with interrupt()
    .addConditionalEdges('tools', () => (scratch.proposal ? END : 'agent'), ['agent', END])
    .compile();
}

async function llmLoop({ query, ctx, tracer }) {
  const model = await getChatModel();
  const scratch = { proposal: null, cards: [] };
  const lcTools = langchainTools(ctx, tracer, scratch);
  const graph = buildReactGraph(model, lcTools, scratch, tracer);
  const system = `You are the Action agent of an HR copilot, acting for ${ctx.user.name} (${ctx.user.id}, access=${ctx.access}).
Today is ${iso(TODAY())} (${TODAY().toLocaleDateString('en-IN', { weekday: 'long' })}).
Check data before acting (e.g. balance before applying). Resolve relative dates yourself to YYYY-MM-DD.
If a write tool returns VALIDATION_ERROR, adapt (e.g. pick another leave type) or explain. After PROPOSED, stop and briefly tell the user what you are about to submit.
Never claim a write happened. Keep answers short and friendly; markdown ok.`;
  const out = await graph.invoke({ messages: [new SystemMessage(system), new HumanMessage(query)] }, { recursionLimit: MAX_HOPS * 2 + 1 });
  const text = textOf(out.messages.at(-1)) || '';
  if (scratch.proposal) {
    return { agent: 'action', confidence: 0.9, text: text && !/^PROPOSED/.test(text) ? text : 'Please review and confirm:', cards: scratch.cards, pendingAction: propose(scratch.proposal, tracer) };
  }
  return { agent: 'action', confidence: 0.85, text: text || 'Done.', cards: scratch.cards };
}

// ---------- Offline mode: intent parser + same tools, same approval gate ----------
const TICKET_RULES = [
  [/laptop|vpn|wifi|software|access to|login|password|monitor|keyboard|email not/i, 'IT'],
  [/salary|payslip|salary slip|tax|form 16|reimburse|payroll/i, 'Payroll'],
  [/insurance|dependent|medical card|mediclaim|esop/i, 'Benefits'],
  [/access card|desk|seat|parking|cafeteria|ac\b/i, 'Facilities'],
];
function offlinePlan(q) {
  const t = q.toLowerCase();
  const steps = [];
  if (/balance|how (many|much) (leave|leaves|chutti)|leaves? (left|remaining)|leaves? (do )?i have|i had|kitni (leave|chutti)|bachi/.test(t)) steps.push({ tool: 'get_leave_balance', args: {} });
  if (/my tickets|ticket status|status of my ticket/.test(t)) steps.push({ tool: 'get_my_tickets', args: {} });
  if (/my manager|who is my|hrbp|hr partner|my profile/.test(t)) steps.push({ tool: 'get_profile', args: {} });
  if (/my team|my reports|team.*leave|who.*(on leave|off)/.test(t)) steps.push({ tool: 'get_team', args: {} });
  const range = parseDateRange(q);
  const sickNow = /\b(i am|i'm|im|feeling)\s+(sick|unwell|ill)\b|\bfever\b|\bbimar/.test(t);
  const askingBalance = /kitni|how (much|many)|bachi|baki|left|remaining|balance/.test(t) && !/apply|book|chahiye|need|want/.test(t);
  const wantsLeave = !askingBalance && (sickNow || (/apply|take|book|need|want|put|mark|chutti|chahiye|leni|leave (on|for|from|tomorrow|today)|off (on|tomorrow)/.test(t) && /leave|off|chutti/.test(t)));
  if (wantsLeave && !range && !sickNow) {
    if (!steps.some((s) => s.tool === 'get_leave_balance')) steps.push({ tool: 'get_leave_balance', args: {} });
    steps.needDates = true;
  } else if (wantsLeave) {
    const r = range || parseDateRange('today');
    const type = /sick|fever|unwell|ill\b|doctor|hospital|bimar/.test(t) ? 'Sick' : /casual/.test(t) ? 'Casual' : /earned|privilege|vacation|trip|travel|holiday/.test(t) ? 'Earned' : 'auto';
    const reason = (q.match(/\b(?:for|because|as|due to)\s+(?:a |an |my )?([a-z ]{3,40}?)(?:[.,!]|$| from| on| next| tomorrow)/i)?.[1] || '').trim();
    steps.push({ tool: 'apply_leave', args: { leave_type: type, start_date: r.start, end_date: r.end, reason: /^\d|days?$/.test(reason) ? '' : reason } });
  } else if (/ticket|not working|broken|issue|problem|complain|request|stopped|crash|slow|pending|missing|not received|not credited|not getting/.test(t) && !/my tickets|ticket status/.test(t)) {
    const cat = TICKET_RULES.find(([re]) => re.test(t))?.[1] || 'HR Query';
    steps.push({ tool: 'raise_ticket', args: { category: cat, description: q.replace(/^(please |pls |can you |could you )?(raise|create|open|log) (a |an )?(\w+ )?ticket (for|about|that)?\s*/i, '').replace(/^./, (c) => c.toUpperCase()), priority: /urgent|asap|blocked|critical/.test(t) ? 'High' : 'Medium' } });
  }
  return steps;
}

function render(tool, data) {
  if (tool === 'get_leave_balance') return `Your leave balance: ${data.balances.map((b) => `**${b.leave_type}** ${b.balance}`).join(' · ')}`;
  if (tool === 'get_my_tickets') return data.length ? `You have ${data.length} ticket(s); ${data.filter((x) => x.status === 'Open').length} open.` : 'You have no tickets.';
  if (tool === 'get_profile') return `You're **${data.role}** (${data.level}) in ${data.department}, ${data.location}. Manager: **${data.manager_name || '—'}**. HRBP: ${data.hr_business_partner}.`;
  if (tool === 'get_team') return `You have **${data.length}** active direct reports.`;
  return '';
}

async function offline({ query, ctx, tracer }) {
  const plan = offlinePlan(query);
  tracer.step('action', 'plan', plan.length ? `intent parser → ${plan.map((p) => p.tool).join(' → ')}` : 'no actionable intent found');
  if (!plan.length) return { agent: 'action', confidence: 0.25, text: "I can check leave balances, apply for leave, raise helpdesk tickets, show your tickets, profile or team. What would you like to do?" };
  const lines = [], cards = [];
  for (const call of plan) {
    const t = tools[call.tool];
    if (!t.writes) {
      try {
        const obs = await callTool(call.tool, call.args, ctx);
        tracer.step('action', 'tool', `${call.tool}()`, JSON.stringify(obs).slice(0, 600));
        lines.push(render(call.tool, obs)); cards.push({ tool: call.tool, data: obs });
      } catch (e) { tracer.step('action', 'error', e.message); lines.push(`⚠️ ${e.message}`); }
      continue;
    }
    if (call.tool === 'apply_leave' && call.args.leave_type === 'auto') {
      // pick the best leave type that passes policy validation — the agent adapts instead of failing
      for (const type of ['Earned', 'Casual', 'Sick']) {
        const err = t.validate({ ...call.args, leave_type: type }, ctx);
        tracer.step('action', 'guard', `try ${type} → ${err || 'valid'}`);
        if (!err) { call.args.leave_type = type; break; }
      }
      if (call.args.leave_type === 'auto') call.args.leave_type = 'Earned';
    }
    const err = t.validate(call.args, ctx);
    if (err) { tracer.step('action', 'guard', `validation: ${err}`); lines.push(`⚠️ I can't submit this: ${err}`); continue; }
    return { agent: 'action', confidence: 0.85, text: [...lines, 'Here is what I will submit — please confirm:'].filter(Boolean).join('\n\n'), cards, pendingAction: propose(call, tracer) };
  }
  if (plan.needDates) lines.push('Sure! Which dates? For example: "casual leave tomorrow", "sick leave today" or "earned leave from 20 oct to 22 oct".');
  return { agent: 'action', confidence: 0.85, text: lines.join('\n\n'), cards };
}

export async function actionAgent(args) {
  return isOffline() ? offline(args) : llmLoop(args);
}

/** Runs after the human decides (called from the orchestrator's human_approval node). */
export async function executeApproved(p, decision, ctx, tracer) {
  if (decision !== 'approve') {
    tracer.step('action', 'approval', 'rejected by user: nothing was written');
    return { agent: 'action', text: 'Cancelled. Nothing was submitted.' };
  }
  tracer.step('action', 'approval', 'approved by user');
  try {
    const res = await callTool(p.tool, p.args, ctx);
    tracer.step('action', 'tool', `${p.tool} executed`, JSON.stringify(res));
    const text = p.tool === 'apply_leave'
      ? `✅ Leave request **#${res.request_id}** submitted — ${res.days} day(s), status **${res.status}**. Remaining ${p.args.leave_type} balance: **${res.remaining_balance}**.`
      : `✅ Ticket **#${res.ticket_id}** raised (${res.priority} priority). Expected response: ${res.expected_response}.`;
    return { agent: 'action', text, cards: [{ tool: p.tool, data: res }] };
  } catch (e) {
    tracer.step('action', 'error', e.message);
    return { agent: 'action', text: `⚠️ Couldn't complete it: ${e.message}` };
  }
}
