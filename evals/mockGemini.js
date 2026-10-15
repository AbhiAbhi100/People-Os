// A tiny fake Gemini API (generateContent) that returns structured JSON and real functionCall parts,
// so the Gemini path through LangChain can be tested without a key.
import http from 'node:http';

let sqlCalls = 0;
const log = [];
const pick = (props) => (props.tasks ? 'route' : props.answerable ? 'policy_answer' : props.refuse ? 'text_to_sql'
  : props.insight ? 'insight' : props.note ? 'career_note' : props.sql ? 'fixed_sql' : 'unknown');
const H = {
  route: (u) => ({ tasks: /leave tomorrow/.test(u) ? [{ agent: 'action', query: 'apply casual leave tomorrow for family' }]
    : /attrition/.test(u) ? [{ agent: 'data', query: 'attrition by department' }]
    : /automate/.test(u) ? [{ agent: 'career', query: u }]
    : /balance/.test(u) ? [{ agent: 'policy', query: 'can I carry forward leaves' }, { agent: 'action', query: 'what is my leave balance' }]
    : [{ agent: 'policy', query: u }] }),
  policy_answer: (u) => { const id = u.match(/\[([a-z-]+#[a-z-]+)\]/)[1]; return { answer: `Yes, see [${id}].`, answerable: true, used_ids: [id] }; },
  text_to_sql: () => ({ sql: ++sqlCalls === 1 ? 'SELECT departmnt, COUNT(*) FROM employees GROUP BY 1' : 'SELECT department, 1 AS x FROM employees GROUP BY 1', chart: 'bar', title: 'Attrition', refuse: '' }),
  fixed_sql: () => ({ sql: "SELECT department, ROUND(100.0*SUM(status='Exited')/COUNT(*),1) AS attrition_pct FROM employees GROUP BY 1 ORDER BY 2 DESC" }),
  insight: () => ({ insight: '**Customer Support** has the highest attrition.' }),
  career_note: () => ({ note: 'You can hand dashboards to AI and focus on stakeholders.' }),
};
const textOf = (contents) => contents.filter((c) => c.role === 'user').flatMap((c) => c.parts).map((p) => p.text || '').join('\n');

export function startMockGemini(port = 4998) {
  sqlCalls = 0;
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
        const j = JSON.parse(b);
        let parts;
        const schema = j.generationConfig?.responseSchema;
        if (schema) {
          const name = pick(schema.properties || {});
          log.push(`structured:${name}`);
          parts = [{ text: JSON.stringify(H[name](textOf(j.contents).split('Message: ').pop())) }];
        } else if (j.tools?.length) {
          const fnResponses = j.contents.flatMap((c) => c.parts).filter((p) => p.functionResponse);
          const decls = j.tools.flatMap((t) => t.functionDeclarations || []);
          log.push(`react:${fnResponses.length}:${decls.map((d) => d.name).join(',')}`);
          const call = (name, args) => ({ functionCall: { name, args }, thoughtSignature: 'sig-' + name });
          parts = fnResponses.length === 0 ? [{ text: 'Checking your balance first.' }, call('get_leave_balance', {})]
            : fnResponses.length === 1 ? [call('apply_leave', { leave_type: 'Earned', start_date: '2026-10-16', end_date: '2026-10-16', reason: 'family' })]
            : fnResponses.length === 2 ? [call('apply_leave', { leave_type: 'Casual', start_date: '2026-10-16', end_date: '2026-10-16', reason: 'family' })]
            : [{ text: 'I will submit Casual leave for 16 Oct. Please confirm.' }];
        } else parts = [{ text: 'plain' }];
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP', index: 0 }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 } }));
      });
    });
    server.listen(port, () => resolve(server));
  });
}
export { log as mockLog };
