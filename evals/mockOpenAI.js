// A tiny fake OpenAI-compatible server that speaks real tool calls / structured output,
// so the LangChain + LangGraph code paths can be tested in CI without an API key.
import http from 'node:http';
let sqlCalls = 0, n = 0;
const log = [];
const H = {
  route: (u) => ({ tasks: /leave tomorrow/.test(u) ? [{ agent: 'action', query: 'apply casual leave tomorrow for family' }]
    : /attrition/.test(u) ? [{ agent: 'data', query: 'attrition by department' }]
    : /automate/.test(u) ? [{ agent: 'career', query: u }]
    : /balance/.test(u) ? [{ agent: 'policy', query: 'can I carry forward leaves' }, { agent: 'action', query: 'what is my leave balance' }]
    : /hello/.test(u) ? [] : [{ agent: 'policy', query: u }] }),
  policy_answer: (u) => { const id = u.match(/\[([a-z-]+#[a-z-]+)\]/)[1]; return { answer: `Yes, see [${id}].`, answerable: true, used_ids: [id] }; },
  text_to_sql: () => ({ sql: ++sqlCalls === 1 ? 'SELECT departmnt, COUNT(*) FROM employees GROUP BY 1' : "SELECT department, 1 AS x FROM employees GROUP BY 1", chart: 'bar', title: 'Attrition', refuse: '' }),
  fixed_sql: () => ({ sql: "SELECT department, ROUND(100.0*SUM(status='Exited')/COUNT(*),1) AS attrition_pct FROM employees GROUP BY 1 ORDER BY 2 DESC" }),
  insight: () => ({ insight: '**Customer Support** has the highest attrition.' }),
  career_note: () => ({ note: 'You can hand dashboards to AI and focus on stakeholders.' }),
};
const tc = (name, args) => ({ id: 'call_' + (++n), type: 'function', function: { name, arguments: JSON.stringify(args) } });
export function startMockLLM(port = 4999) {
  sqlCalls = 0;
  return new Promise((resolve) => { const server = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    const j = JSON.parse(b);
    const userText = j.messages.filter((m) => m.role === 'user').map((m) => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n');
    let msg;
    const forced = j.tool_choice?.function?.name;
    if (forced) { log.push('structured:' + forced); msg = { role: 'assistant', content: null, tool_calls: [tc(forced, H[forced](userText.split('Message: ').pop()))] }; }
    else if (j.tools?.length) {
      const toolMsgs = j.messages.filter((m) => m.role === 'tool');
      log.push('react:' + toolMsgs.length + ':' + (toolMsgs.at(-1)?.content || '').slice(0, 40));
      msg = toolMsgs.length === 0 ? { role: 'assistant', content: 'Checking your balance first.', tool_calls: [tc('get_leave_balance', {})] }
        : toolMsgs.length === 1 ? { role: 'assistant', content: '', tool_calls: [tc('apply_leave', { leave_type: 'Earned', start_date: '2026-10-16', end_date: '2026-10-16', reason: 'family' })] }
        : toolMsgs.length === 2 ? { role: 'assistant', content: 'Earned needs notice; switching to Casual.', tool_calls: [tc('apply_leave', { leave_type: 'Casual', start_date: '2026-10-16', end_date: '2026-10-16', reason: 'family' })] }
        : { role: 'assistant', content: 'I will submit Casual leave for 16 Oct. Please confirm.' };
    } else msg = { role: 'assistant', content: 'plain' };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'chatcmpl-' + (++n), object: 'chat.completion', created: 1, model: j.model, choices: [{ index: 0, message: msg, finish_reason: msg.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }));
  });
}); server.listen(port, () => resolve(server)); });
}
export { log as mockLog };
