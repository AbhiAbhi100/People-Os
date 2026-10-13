const $ = (s) => document.querySelector(s);
const thread = $('#thread'), steps = $('#steps'), input = $('#input'), send = $('#send');
const LANES = ['orchestrator', 'policy', 'data', 'action', 'career', 'handoff'];
const NAMES = { orchestrator: 'Orchestrator', policy: 'Policy', data: 'Data', action: 'Action', career: 'Career', handoff: 'Handoff', guard: 'Guardrail' };
const color = (a) => `var(--${{ orchestrator: 'orch', guard: 'handoff' }[a] || a})`;
let sessionId;
try { sessionId = localStorage.getItem('peopleos-sid'); } catch {}
if (!sessionId) { sessionId = Math.random().toString(36).slice(2); try { localStorage.setItem('peopleos-sid', sessionId); } catch {} }
let userId = 'E1001', busy = false, personas = [];

const SUGGEST = {
  employee: [
    ['policy', 'How many sick leaves can I take without a medical certificate?'],
    ['action', 'Apply casual leave tomorrow for a family function'],
    ['action', 'My laptop VPN is not working since morning, urgent'],
    ['data', 'Average ticket resolution time by category'],
    ['career', 'Which parts of my job can AI automate?'],
    ['policy', 'Can I work from Dubai for 2 weeks? Also what is my leave balance?'],
  ],
  manager: [
    ['action', 'Show my team and who is on leave'],
    ['data', 'Attrition by department'],
    ['data', 'Now break it down by location'],
    ['data', 'Hiring trend over the years'],
    ['career', 'Career insights for an Engineering Manager'],
  ],
  hr: [
    ['data', 'Why are people leaving?'],
    ['data', 'Average salary by level'],
    ['data', 'Engagement in Customer Support by location'],
    ['data', 'Women percentage by department'],
    ['policy', 'What is the policy on pet insurance for dogs?'],
    ['career', 'Which tasks of a Support Associate can AI handle?'],
  ],
};
const ACCESS = { employee: 'Employee access: your own records and company-level aggregates. Salary and ratings are hidden.', manager: 'Manager access: your direct reports plus aggregates. Salary and ratings are hidden.', hr: 'HR access: all people data, including salary and performance.' };

// ---------- tiny, safe markdown ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function md(s) {
  const lines = esc(s).split('\n');
  let html = '', list = false;
  for (const raw of lines) {
    let l = raw.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\[([a-z0-9-]+#[a-z0-9-]+)\]/g, '<span class="cite" title="$1">source</span>');
    if (/^\s*[•\-*]\s+/.test(l)) { if (!list) { html += '<ul>'; list = true; } html += `<li>${l.replace(/^\s*[•\-*]\s+/, '')}</li>`; continue; }
    if (list) { html += '</ul>'; list = false; }
    if (l.trim()) html += `<p>${l}</p>`;
  }
  return html + (list ? '</ul>' : '');
}
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const scroll = () => (thread.scrollTop = thread.scrollHeight);

// ---------- trace panel ----------
function addStep(s, first) {
  steps.querySelector('.empty')?.remove();
  const lane = LANES.includes(s.agent) ? s.agent : s.kind === 'guard' ? 'orchestrator' : 'orchestrator';
  const li = el('li', `step k-${s.kind}${first ? ' sep' : ''}`);
  li.style.setProperty('--c', color(s.agent));
  li.innerHTML = `<span class="t">${(s.t / 1000).toFixed(2)}s</span>` +
    LANES.map((a) => `<span class="lane">${a === lane ? `<span class="dot${['done', 'end'].includes(s.kind) ? ' hollow' : ''}"></span>` : ''}</span>`).join('') +
    `<span class="lbl"><b>${NAMES[s.agent] || s.agent}</b> ${esc(s.label)}${s.detail ? `<pre>${esc(s.detail)}</pre>` : ''}</span>`;
  steps.append(li);
  steps.scrollTop = steps.scrollHeight;
}
async function refreshMetrics() {
  try {
    const m = await (await fetch('/api/metrics')).json();
    $('#metrics').innerHTML = `<span><b>${m.requests}</b> requests</span><span><b>${m.avgLatencyMs}</b> ms avg</span><span><b>${m.blocked}</b> blocked</span><span><b>${m.handoffs}</b> handoffs</span><span><b>${m.llm.calls}</b> LLM calls</span>`;
  } catch {}
}

// ---------- streaming ----------
async function streamPost(url, body, onTrace) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = '', result = null, first = true;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      const ev = chunk.match(/^event: (.+)$/m)?.[1], data = JSON.parse(chunk.match(/^data: (.+)$/m)?.[1] || 'null');
      if (ev === 'trace') { onTrace(data, first); first = false; }
      if (ev === 'result') result = data;
      if (ev === 'error') throw new Error(data.message);
    }
  }
  return result;
}

// ---------- rendering results ----------
function renderChart(box, c) {
  if (!window.Chart) return;
  const css = getComputedStyle(document.documentElement);
  const ink = css.getPropertyValue('--muted').trim(), grid = css.getPropertyValue('--line').trim();
  const palette = ['--data', '--policy', '--action', '--career', '--handoff'].map((v) => css.getPropertyValue(v).trim());
  const bucketColor = { Automate: palette[0], 'Augment with AI': palette[2], 'Human-led': palette[1] };
  const canvas = el('canvas'); box.append(canvas);
  canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', c.title || 'chart');
  const doughnut = c.type === 'doughnut';
  new Chart(canvas, {
    type: c.type === 'line' ? 'line' : doughnut ? 'doughnut' : 'bar',
    data: { labels: c.labels, datasets: [{ label: c.y?.replace(/_/g, ' '), data: c.values,
      backgroundColor: c.buckets ? c.buckets.map((b) => bucketColor[b]) : doughnut ? palette : palette[0],
      borderColor: doughnut ? css.getPropertyValue('--panel').trim() : c.type === 'line' ? palette[0] : 'transparent', borderWidth: 2, tension: 0.3, pointRadius: 3, borderRadius: doughnut ? 0 : 4, maxBarThickness: 36 }] },
    options: {
      indexAxis: c.horizontal ? 'y' : 'x', maintainAspectRatio: false, animation: { duration: 400 },
      plugins: { legend: { display: doughnut, position: 'right', labels: { color: ink } } },
      scales: doughnut ? {} : { x: { ticks: { color: ink }, grid: { color: grid, display: !!c.horizontal } }, y: { ticks: { color: ink }, grid: { color: grid, display: !c.horizontal }, beginAtZero: true, ...(c.buckets ? { } : {}) } },
    },
  });
}

function table(cols, rows) {
  const isNum = (v) => typeof v === 'number';
  return `<div class="tablewrap"><table><thead><tr>${cols.map((c) => `<th>${esc(c.replace(/_/g, ' '))}</th>`).join('')}</tr></thead><tbody>${
    rows.map((r) => `<tr>${cols.map((c) => `<td class="${isNum(r[c]) ? 'num' : ''}">${esc(r[c] ?? '—')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function renderCards(wrap, cards = []) {
  for (const c of cards) {
    if (c.tool === 'get_leave_balance') {
      wrap.append(el('div', 'tiles', c.data.balances.map((b) => `<div class="tile"><b>${b.balance}</b><span>${esc(b.leave_type)} left</span></div>`).join('')));
    } else if (c.tool === 'get_team' && c.data.length) {
      const d = el('details'); d.open = true;
      d.innerHTML = `<summary>Direct reports (${c.data.length})</summary>${table(['name', 'role', 'location', 'leave_days_2026', 'upcoming_leaves'], c.data)}`;
      wrap.append(d);
    } else if (c.tool === 'get_my_tickets' && c.data.length) {
      wrap.append(el('div', '', table(['ticket_id', 'category', 'description', 'status', 'created_at'], c.data)));
    }
  }
}

function approvalCard(p, host) {
  const card = el('div', 'approval');
  card.innerHTML = `<div class="tool">${esc(p.tool)} · needs your approval</div><div class="what">${esc(p.preview)}</div>
    <div class="btns"><button class="yes">${p.tool === 'apply_leave' ? 'Submit leave' : p.args?.category === 'Confidential' ? 'Ask HR to reach out' : 'Raise ticket'}</button><button class="no">Cancel</button></div>`;
  const decide = async (decision) => {
    card.querySelectorAll('button').forEach((b) => (b.disabled = true));
    try {
      const out = await streamPost('/api/approve', { sessionId, userId, id: p.id, decision }, addStep);
      card.classList.add('done');
      card.querySelector('.btns').remove();
      const r = out.results[0];
      const res = el('div', 'text', md(r.text)); host.append(res);
      renderCards(host, r.cards);
    } catch (e) { card.append(el('div', 'text', md(`⚠️ ${e.message}`))); }
    refreshMetrics(); scroll();
  };
  card.querySelector('.yes').onclick = () => decide('approve');
  card.querySelector('.no').onclick = () => decide('reject');
  return card;
}

function renderResult(r) {
  const box = el('div', 'result');
  box.style.setProperty('--c', color(r.agent));
  box.append(el('div', 'who', NAMES[r.agent] || r.agent));
  box.append(el('div', 'text', md(r.text)));
  if (r.chart?.labels?.length) {
    const cb = el('div', `chartbox${r.chart.horizontal ? ' tall' : ''}`); box.append(cb);
    requestAnimationFrame(() => renderChart(cb, r.chart));
    if (r.chart.buckets) box.append(el('div', 'keys', '<span><i style="--c:var(--data)"></i>AI can automate</span><span><i style="--c:var(--action)"></i>AI assists, you decide</span><span><i style="--c:var(--policy)"></i>Stays human-led</span>'));
  }
  if (r.career) {
    const d = el('details'); d.open = !r.chart;
    d.innerHTML = `<summary>How each task was scored</summary>${table(['task', 'hours_per_week', 'score', 'bucket', 'why'], r.career.tasks.map((t) => ({ ...t, bucket: t.bucket })))}
      <p style="color:var(--muted);margin:8px 0 0">score = 0.35·repetitive + 0.25·rules-based + 0.15·data-heavy − 0.15·judgment − 0.10·empathy, rescaled to 0–100.</p>`;
    d.querySelectorAll('td:nth-child(4)').forEach((td) => { const b = td.textContent; td.innerHTML = `<span class="bucket ${b.split(' ')[0]}">${esc(b)}</span>`; });
    box.append(d);
  }
  renderCards(box, r.cards);
  if (r.table?.rows?.length > 1 || r.sql) {
    const d = el('details');
    d.innerHTML = `<summary>Show SQL${r.table?.rows?.length ? ` and ${r.table.rows.length} rows` : ''}</summary>${r.sql ? `<pre class="sql">${esc(r.sql)}</pre>` : ''}${r.table?.rows?.length ? table(r.table.columns, r.table.rows) : ''}`;
    box.append(d);
  }
  if (r.citations?.length) {
    box.append(el('div', 'sources', r.citations.map((c) => `<span class="src" title="${esc(c.snippet)}">${esc(c.title)}</span>`).join('')));
  }
  if (r.pendingAction) box.append(approvalCard(r.pendingAction, box));
  return box;
}

// ---------- chat ----------
async function ask(text) {
  if (busy || !text.trim()) return;
  busy = true; send.disabled = true;
  thread.append(el('div', 'msg user', esc(text)));
  const bot = el('div', 'msg bot'); const wait = el('div', 'thinking', 'Routing to agents');
  bot.append(wait); thread.append(bot); scroll();
  try {
    const out = await streamPost('/api/chat', { sessionId, userId, message: text }, (s, first) => {
      addStep(s, first);
      if (s.kind === 'route') wait.textContent = s.label.replace('plan: ', 'Working: ');
    });
    wait.remove();
    const agents = out.route.tasks.map((t) => t.agent);
    if (agents.length > 1) bot.append(el('div', 'route', `Split into ${agents.length} tasks: ${agents.map((a) => `<span class="pill" style="--c:${color(a)}">${NAMES[a]}</span>`).join('')} · ${out.ms} ms`));
    for (const r of out.results) bot.append(renderResult(r));
  } catch (e) {
    wait.remove(); bot.append(el('div', 'text', md(`⚠️ ${e.message}`)));
  }
  busy = false; send.disabled = false; scroll(); refreshMetrics(); input.focus();
}

function setPersona(id) {
  userId = id;
  const p = personas.find((x) => x.id === id);
  $('#access').textContent = ACCESS[p.access];
  $('#suggestions').replaceChildren(...SUGGEST[p.access].map(([a, q]) => {
    const b = el('button', 'chip', esc(q)); b.type = 'button'; b.style.setProperty('--c', color(a)); b.onclick = () => ask(q); return b;
  }));
  thread.replaceChildren();
  thread.append(el('div', 'msg bot', `<div class="result" style="--c:var(--orch)"><div class="text">${md(`Hi ${p.name.split(' ')[0]} — I'm PeopleOS. Ask me about HR policies, people data, your leave and tickets, or how AI could change your role. I'll ask before I submit anything on your behalf.`)}</div></div>`));
}

$('#composer').addEventListener('submit', (e) => { e.preventDefault(); const t = input.value; input.value = ''; input.style.height = ''; ask(t); });
input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#composer').requestSubmit(); } });
input.addEventListener('input', () => { input.style.height = ''; input.style.height = `${input.scrollHeight}px`; });
$('#persona').addEventListener('change', (e) => setPersona(e.target.value));
$('#traceToggle').addEventListener('click', (e) => {
  const c = $('#tracePanel').classList.toggle('collapsed');
  e.target.textContent = c ? 'Show' : 'Hide'; e.target.setAttribute('aria-expanded', String(!c));
});

(async () => {
  const cfg = await (await fetch('/api/config')).json();
  personas = cfg.personas;
  $('#persona').innerHTML = personas.map((p) => `<option value="${p.id}">${esc(p.name)} — ${esc(p.title)}</option>`).join('');
  $('#mode').innerHTML = cfg.provider === 'offline'
    ? 'LangGraph orchestrator · no LLM key, so agents use deterministic planners. Add a key in <code>.env</code> for LangChain models.'
    : `LangGraph orchestrator · LangChain model: <b>${esc(cfg.provider)}</b> / ${esc(cfg.model)}`;
  setPersona(userId);
  refreshMetrics();
})();
