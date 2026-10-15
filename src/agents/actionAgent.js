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
import { withModelFallback, isOffline, textOf } from '../llm/provider.js';
import { parseDateRange, iso, TODAY } from '../lib/dates.js';
import { settingsOf } from '../services/company.js';

const ALLOWED = ['get_leave_balance', 'apply_leave', 'cancel_leave', 'raise_ticket', 'get_my_tickets', 'get_profile', 'get_team', 'list_pending_approvals', 'decide_leave'];
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
        const err = await t.validate(args, ctx);
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

function buildReactGraph(bound, lcTools, scratch, tracer) {
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
  const scratch = { proposal: null, cards: [] };
  const lcTools = langchainTools(ctx, tracer, scratch);
  const bound = await withModelFallback((m) => m.bindTools(lcTools)); // main model, backup model if overloaded
  const graph = buildReactGraph(bound, lcTools, scratch, tracer);
  const system = `You are the Action agent of PeopleOS at ${ctx.company.name}, acting for ${ctx.user.name} (${ctx.user.title || 'employee'}, access=${ctx.access}).
Today is ${iso(TODAY())} (${TODAY().toLocaleDateString('en-IN', { weekday: 'long' })}). Leave types at this company: ${Object.keys(settingsOf(ctx.company).leave).join(', ')}.
Leave requests go to the person's manager (or HR) for approval after submission.
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
  [/salary|payslip|pay slip|salary slip|tax|tds|form 16|reimburse|payroll|bonus|arrear/i, 'Payroll'],
  [/insurance|dependent|medical card|mediclaim|esop/i, 'Benefits'],
  [/access card|desk|seat|parking|cafeteria|ac\b/i, 'Facilities'],
];
function offlinePlan(q, ctx) {
  const t = q.toLowerCase();
  const steps = [];
  const types = Object.keys(settingsOf(ctx.company).leave);
  const typeLike = (re) => types.find((x) => re.test(x));
  if (ctx.access !== 'employee') {
    const m = t.match(/\b(approve|reject|decline)\b.*?#?\s*(\d+)/);
    if (m) { steps.push({ tool: 'decide_leave', args: { request_id: +m[2], decision: m[1] === 'approve' ? 'approve' : 'reject' } }); return steps; }
    if (/pending|approvals?|to approve|waiting for (me|my)|requests? (from|of) my team|team requests/.test(t)) steps.push({ tool: 'list_pending_approvals', args: {} });
  }
  const cancel = t.match(/\bcancel\b.*?(?:leave|request)?\s*#?\s*(\d+)/);
  if (cancel) { steps.push({ tool: 'cancel_leave', args: { request_id: +cancel[1] } }); return steps; }
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
    const type = (/sick|fever|unwell|ill\b|doctor|hospital|bimar/.test(t) && typeLike(/sick|medical/i))
      || (/casual/.test(t) && typeLike(/casual/i))
      || (/earned|privilege|annual|vacation|trip|travel|holiday/.test(t) && typeLike(/earned|privilege|annual|paid/i))
      || types.find((x) => t.includes(x.toLowerCase())) || 'auto';
    const reason = (q.match(/\b(?:for|because|as|due to)\s+(?:a |an |my )?([a-z ]{3,40}?)(?:[.,!]|$| from| on| next| tomorrow)/i)?.[1] || '').trim();
    steps.push({ tool: 'apply_leave', args: { leave_type: type, start_date: r.start, end_date: r.end, reason: /^\d|days?$/.test(reason) ? '' : reason } });
  } else if (!steps.length && /ticket|not working|broken|issue|problem|complain|request|stopped|crash|slow|pending|missing|not received|not credited|not getting|wrong|incorrect|mismatch|error in|not updated|need (a |an )?(new )?(laptop|monitor|mouse|access|id card|headset)/.test(t) && !/my tickets|ticket status/.test(t)) {
    const cat = TICKET_RULES.find(([re]) => re.test(t))?.[1] || 'HR Query';
    steps.push({ tool: 'raise_ticket', args: { category: cat, description: q.replace(/^(please |pls |can you |could you )?(raise|create|open|log) (a |an )?(\w+ )?ticket (for|about|that)?\s*/i, '').replace(/^./, (c) => c.toUpperCase()), priority: /urgent|asap|blocked|critical/.test(t) ? 'High' : 'Medium' } });
  }
  return steps;
}

function render(tool, data, ctx) {
  if (tool === 'get_leave_balance') return data.balances.length
    ? `Your leave balance: ${data.balances.map((b) => `**${b.leave_type}** ${b.balance}${b.pending ? ` (${b.pending} pending)` : ''}`).join(' · ')}`
    : 'No leave balances are set up for you yet. Ask HR to add them.';
  if (tool === 'get_my_tickets') return data.length ? `You have ${data.length} ticket(s); ${data.filter((x) => x.status !== 'Resolved').length} still open.` : 'You have no tickets.';
  if (tool === 'get_profile') return `You're **${data.title || '—'}**${data.department ? ` in ${data.department}` : ''}${data.location ? `, ${data.location}` : ''}. Manager: **${data.manager_name || 'not set'}**. HR contact: ${data.hr_contact}.`;
  if (tool === 'get_team') return ctx.access === 'hr' ? `There are **${data.length}** active people in ${ctx.company.name}.` : `You have **${data.length}** active direct reports.`;
  if (tool === 'list_pending_approvals') return data.length
    ? `**${data.length}** leave request(s) waiting for you:\n${data.slice(0, 8).map((r) => `• #${r.request_id} **${r.name}** — ${r.leave_type}, ${r.start_date} → ${r.end_date} (${r.days} day${r.days > 1 ? 's' : ''})${r.reason ? `, "${r.reason}"` : ''}`).join('\n')}\n\nSay "approve #${data[0].request_id}" or "reject #${data[0].request_id}".`
    : 'No leave requests are waiting for you.';
  return '';
}

async function offline({ query, ctx, tracer }) {
  const plan = offlinePlan(query, ctx);
  tracer.step('action', 'plan', plan.length ? `intent parser → ${plan.map((p) => p.tool).join(' → ')}` : 'no actionable intent found');
  if (!plan.length) return { agent: 'action', confidence: 0.25, text: `I can check leave balances, apply for or cancel leave, raise helpdesk tickets, and show your tickets or profile${ctx.access !== 'employee' ? ', your team and pending approvals' : ''}. What would you like to do?` };
  const lines = [], cards = [];
  for (const call of plan) {
    const t = tools[call.tool];
    if (!t.writes) {
      try {
        const obs = await callTool(call.tool, call.args, ctx);
        tracer.step('action', 'tool', `${call.tool}()`, JSON.stringify(obs).slice(0, 600));
        lines.push(render(call.tool, obs, ctx)); cards.push({ tool: call.tool, data: obs });
      } catch (e) { tracer.step('action', 'error', e.message); lines.push(`⚠️ ${e.message}`); }
      continue;
    }
    if (call.tool === 'apply_leave' && call.args.leave_type === 'auto') {
      // pick the best leave type that passes policy validation — the agent adapts instead of failing
      const types = Object.keys(settingsOf(ctx.company).leave);
      const order = [...types.filter((x) => !/sick|medical/i.test(x)), ...types.filter((x) => /sick|medical/i.test(x))];
      for (const type of order) {
        const err = await t.validate({ ...call.args, leave_type: type }, ctx);
        tracer.step('action', 'guard', `try ${type} → ${err || 'valid'}`);
        if (!err) { call.args.leave_type = type; break; }
      }
      if (call.args.leave_type === 'auto') call.args.leave_type = order[0];
    }
    const err = await t.validate(call.args, ctx);
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
    const text = {
      apply_leave: () => res.status === 'Approved'
        ? `✅ Leave request **#${res.request_id}** approved — ${res.days} day(s). Remaining ${p.args.leave_type} balance: **${res.remaining_balance}**.`
        : `✅ Leave request **#${res.request_id}** submitted — ${res.days} day(s), sent to **${res.approver}** for approval. You'll see the decision under My leave.`,
      cancel_leave: () => `✅ Leave request **#${res.request_id}** cancelled.`,
      decide_leave: () => `✅ ${res.status === 'Approved' ? 'Approved' : 'Rejected'} ${res.name}'s leave request **#${res.request_id}**.`,
      raise_ticket: () => `✅ Ticket **#${res.ticket_id}** raised (${res.priority} priority). Expected response: ${res.expected_response}.`,
    }[p.tool]?.() || '✅ Done.';
    return { agent: 'action', text, cards: [{ tool: p.tool, data: res }] };
  } catch (e) {
    tracer.step('action', 'error', e.message);
    return { agent: 'action', text: `⚠️ Couldn't complete it: ${e.message}` };
  }
}
