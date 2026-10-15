import { $, esc, el, md, api, toast, topbar, fmtDate } from './common.js';

const thread = $('#thread'), steps = $('#steps'), input = $('#input'), send = $('#send');
const LANES = ['orchestrator', 'policy', 'data', 'action', 'career', 'handoff'];
const NAMES = { orchestrator: 'PeopleOS', policy: 'Policy', data: 'Data', action: 'Leave & tickets', career: 'Career', handoff: 'Support', guard: 'Safety' };
const TRACE_NAMES = { ...NAMES, orchestrator: 'Orchestrator', action: 'Action', handoff: 'Handoff', guard: 'Guardrail' };
const color = (a) => `var(--${{ orchestrator: 'orch', guard: 'handoff' }[a] || a})`;
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
let me, sessionId, busy = false;

const SUGGEST = {
  employee: [
    ['action', "What's my leave balance?"],
    ['policy', 'How many sick leaves can I take without a medical certificate?'],
    ['action', 'Apply casual leave tomorrow for a family function'],
    ['action', 'My laptop VPN is not working since morning'],
    ['policy', 'Can I work from home on Fridays?'],
    ['career', 'Which parts of my job can AI automate?'],
  ],
  manager: [
    ['action', 'Show leave requests waiting for my approval'],
    ['action', 'Show my team and who is on leave'],
    ['policy', 'How many days notice is needed for earned leave?'],
    ['data', 'Leave taken by month this year'],
    ['career', 'Which parts of my job can AI automate?'],
  ],
  hr: [
    ['data', 'Attrition by department'],
    ['data', 'Headcount by location'],
    ['data', 'Why are people leaving?'],
    ['action', 'Show leave requests waiting for my approval'],
    ['data', 'Average ticket resolution time by category'],
    ['policy', 'Summarise our leave policy'],
  ],
};

// ---------- trace panel ----------
function addStep(s, first) {
  steps.querySelector('.empty')?.remove();
  const lane = LANES.includes(s.agent) ? s.agent : 'orchestrator';
  const li = el('li', `step k-${s.kind}${first ? ' sep' : ''}`);
  li.style.setProperty('--c', color(s.agent));
  li.innerHTML = `<span class="t">${(s.t / 1000).toFixed(2)}s</span>` +
    LANES.map((a) => `<span class="lane">${a === lane ? `<span class="dot${['done', 'end'].includes(s.kind) ? ' hollow' : ''}"></span>` : ''}</span>`).join('') +
    `<span class="lbl"><b>${TRACE_NAMES[s.agent] || s.agent}</b> ${esc(s.label)}${s.detail ? `<pre>${esc(s.detail)}</pre>` : ''}</span>`;
  steps.append(li);
  steps.scrollTop = steps.scrollHeight;
}
function setTrace(open) {
  $('#shell').classList.toggle('no-trace', !open);
  $('#traceOpen').hidden = open;
  store.set('peopleos-trace', open ? '1' : '0');
}
$('#traceClose').onclick = () => setTrace(false);
$('#traceOpen').onclick = () => setTrace(true);

// ---------- streaming ----------
async function streamPost(url, body, onTrace) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (res.status === 401) { location.href = '/login'; return null; }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Request failed (${res.status})`);
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

// ---------- rendering ----------
function renderChart(box, c) {
  if (!window.Chart) return;
  const css = getComputedStyle(document.documentElement);
  const ink = css.getPropertyValue('--muted').trim(), grid = css.getPropertyValue('--line').trim();
  const palette = ['--data', '--policy', '--action', '--career', '--handoff'].map((v) => css.getPropertyValue(v).trim());
  const bucketColor = { Automate: palette[0], 'Augment with AI': palette[2], 'Human-led': palette[1] };
  const canvas = el('canvas'); box.append(canvas);
  canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', c.title || 'chart');
  const doughnut = c.type === 'doughnut';
  new window.Chart(canvas, {
    type: c.type === 'line' ? 'line' : doughnut ? 'doughnut' : 'bar',
    data: { labels: c.labels, datasets: [{ label: c.y?.replace(/_/g, ' '), data: c.values,
      backgroundColor: c.buckets ? c.buckets.map((b) => bucketColor[b]) : doughnut ? palette : palette[0],
      borderColor: doughnut ? css.getPropertyValue('--panel').trim() : c.type === 'line' ? palette[0] : 'transparent', borderWidth: 2, tension: 0.3, pointRadius: 3, borderRadius: doughnut ? 0 : 4, maxBarThickness: 36 }] },
    options: {
      indexAxis: c.horizontal ? 'y' : 'x', maintainAspectRatio: false, animation: { duration: 400 },
      plugins: { legend: { display: doughnut, position: 'right', labels: { color: ink } } },
      scales: doughnut ? {} : { x: { ticks: { color: ink }, grid: { color: grid, display: !!c.horizontal } }, y: { ticks: { color: ink }, grid: { color: grid, display: !c.horizontal }, beginAtZero: true } },
    },
  });
}

function table(cols, rows, labels = {}) {
  const isNum = (v) => typeof v === 'number';
  return `<div class="tablewrap"><table><thead><tr>${cols.map((c) => `<th>${esc(labels[c] || c.replace(/_/g, ' '))}</th>`).join('')}</tr></thead><tbody>${
    rows.map((r) => `<tr>${cols.map((c) => `<td class="${isNum(r[c]) ? 'num' : ''}">${esc(/date|_at$/.test(c) ? fmtDate(r[c]) : r[c] ?? '—')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function renderCards(wrap, cards = []) {
  for (const c of cards) {
    if (c.tool === 'get_leave_balance' && c.data.balances?.length) {
      wrap.append(el('div', 'tiles', c.data.balances.map((b) => `<div class="tile"><b>${b.balance - b.pending}</b><span>${esc(b.leave_type)} available${b.pending ? ` · ${b.pending} pending` : ''}</span></div>`).join('')));
    } else if (c.tool === 'get_team' && c.data.length) {
      const d = el('details'); d.open = c.data.length <= 15;
      d.innerHTML = `<summary>${me.access === 'hr' ? 'People' : 'Your team'} (${c.data.length})</summary>${table(['name', 'title', 'location', 'leave_days_this_year', 'upcoming_leave'], c.data, { leave_days_this_year: 'leave this year' })}`;
      wrap.append(d);
    } else if (c.tool === 'get_my_tickets' && c.data.length) {
      wrap.append(el('div', '', table(['ticket_id', 'category', 'description', 'status', 'created_at'], c.data, { ticket_id: '#', created_at: 'raised' })));
    }
  }
}

const APPROVE_LABEL = { apply_leave: 'Submit leave', cancel_leave: 'Cancel this leave', decide_leave: 'Confirm', raise_ticket: 'Raise ticket' };
function approvalCard(p, host) {
  const card = el('div', 'approval');
  const label = p.tool === 'raise_ticket' && /^Confidential/.test(p.preview) ? 'Ask HR to reach out' : APPROVE_LABEL[p.tool] || 'Confirm';
  card.innerHTML = `<div class="tool">Needs your confirmation</div><div class="what">${esc(p.preview)}</div>
    <div class="btns"><button class="yes" type="button">${label}</button><button class="no" type="button">Don't submit</button></div>`;
  const decide = async (decision) => {
    card.querySelectorAll('button').forEach((b) => (b.disabled = true));
    try {
      const out = await streamPost('/api/approve', { sessionId, id: p.id, decision }, addStep);
      card.classList.add('done');
      card.querySelector('.btns').remove();
      const r = out.results[0];
      host.append(el('div', 'text', md(r.text)));
      renderCards(host, r.cards);
      loadSide();
    } catch (e) { card.querySelectorAll('button').forEach((b) => (b.disabled = false)); toast(e.message, 'error'); }
    scroll();
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
    const d = el('details');
    d.innerHTML = `<summary>How each task was scored</summary>${table(['task', 'hours_per_week', 'score', 'bucket', 'why'], r.career.tasks, { hours_per_week: 'hrs/week' })}
      <p class="muted small">score = 0.35·repetitive + 0.25·rules-based + 0.15·data-heavy − 0.15·judgment − 0.10·empathy, rescaled to 0–100.${r.career.generated ? ' Tasks for this title were drafted by AI.' : ''}</p>`;
    d.querySelectorAll('td:nth-child(4)').forEach((td) => { const b = td.textContent; td.innerHTML = `<span class="bucket ${b.split(/[ -]/)[0]}">${esc(b)}</span>`; });
    box.append(d);
  }
  renderCards(box, r.cards);
  if (r.table?.rows?.length > 1 || r.sql) {
    const d = el('details');
    d.innerHTML = `<summary>Show the query${r.table?.rows?.length ? ` and ${r.table.rows.length} rows` : ''}</summary>${r.sql ? `<pre class="sql">${esc(r.sql)}</pre>` : ''}${r.table?.rows?.length ? table(r.table.columns, r.table.rows) : ''}`;
    box.append(d);
  }
  if (r.citations?.length) box.append(el('div', 'sources', r.citations.map((c) => `<span class="src" title="${esc(c.snippet)}">${esc(c.title)}</span>`).join('')));
  if (r.pendingAction) box.append(approvalCard(r.pendingAction, box));
  return box;
}

const scroll = () => (thread.scrollTop = thread.scrollHeight);

async function ask(text) {
  text = text.trim();
  if (busy || !text) return;
  busy = true; send.disabled = true;
  thread.querySelector('.welcome')?.remove();
  thread.append(el('div', 'msg user', esc(text)));
  const bot = el('div', 'msg bot'); const wait = el('div', 'thinking', 'Thinking');
  bot.append(wait); thread.append(bot); scroll();
  try {
    const out = await streamPost('/api/chat', { sessionId, message: text }, (s, first) => {
      addStep(s, first);
      if (s.kind === 'route' && /plan:/.test(s.label)) wait.textContent = 'Working on it';
    });
    wait.remove();
    if (!out) return;
    const agents = out.route.tasks.map((t) => t.agent);
    if (agents.length > 1) bot.append(el('div', 'route', `Split into ${agents.length} parts: ${agents.map((a) => `<span class="pill" style="--c:${color(a)}">${NAMES[a]}</span>`).join('')}`));
    for (const r of out.results) bot.append(renderResult(r));
    if (out.results.some((r) => r.cards?.length)) loadSide();
  } catch (e) {
    wait.remove(); bot.append(el('div', 'result', `<div class="text">${md(`⚠️ ${e.message}`)}</div>`));
  } finally {
    busy = false; send.disabled = false; scroll(); input.focus();
  }
}

// ---------- side panel ----------
const statusBadge = (s) => `<span class="badge ${esc(s.replace(' ', ''))}">${esc(s)}</span>`;
async function loadSide() {
  try {
    const [leave, tickets, approvals] = await Promise.all([
      api('/api/me/leave'), api('/api/me/tickets'), me.access === 'employee' ? [] : api('/api/me/approvals'),
    ]);
    $('#balances').innerHTML = leave.balances.length
      ? leave.balances.map((b) => `<div><b>${b.balance - b.pending}</b><span>${esc(b.leave_type)}</span>${b.pending ? `<i>${b.pending} pending</i>` : ''}</div>`).join('')
      : '<p class="empty">No leave balances yet. HR sets these up.</p>';
    const today = new Date().toISOString().slice(0, 10);
    const reqs = leave.requests.slice(0, 6);
    $('#myRequests').innerHTML = reqs.length ? reqs.map((r) => `<li><div class="top"><span>${esc(r.leave_type)} · ${fmtDate(r.start_date)}${r.end_date !== r.start_date ? ` → ${fmtDate(r.end_date)}` : ''}</span>${statusBadge(r.status)}</div>
        <span class="meta">#${r.request_id} · ${r.days} day${r.days > 1 ? 's' : ''}${r.decided_by ? ` · by ${esc(r.decided_by)}` : ''}${r.decision_note ? ` · "${esc(r.decision_note)}"` : ''}</span>
        ${r.status === 'Pending' || (r.status === 'Approved' && r.start_date > today) ? `<div class="acts"><button class="btn small" data-cancel="${r.request_id}" type="button">Cancel</button></div>` : ''}</li>`).join('')
      : '<li class="empty">No leave requests yet.</li>';
    $('#myTickets').innerHTML = tickets.length ? tickets.slice(0, 5).map((t) => `<li><div class="top"><span>#${t.ticket_id} ${esc(t.category)}</span>${statusBadge(t.status)}</div><span class="meta">${esc(t.description.slice(0, 80))}</span>${t.resolution ? `<span class="meta">HR: ${esc(t.resolution)}</span>` : ''}</li>`).join('')
      : '<li class="empty">No tickets. Describe a problem in the chat to raise one.</li>';
    $('#approvalsCard').hidden = me.access === 'employee';
    $('#approvals').innerHTML = approvals.length ? approvals.map((r) => `<li><div class="top"><b>${esc(r.name)}</b><span class="meta">#${r.request_id}</span></div>
        <span class="meta">${esc(r.leave_type)} · ${fmtDate(r.start_date)}${r.end_date !== r.start_date ? ` → ${fmtDate(r.end_date)}` : ''} · ${r.days} day${r.days > 1 ? 's' : ''}${r.reason ? ` · "${esc(r.reason)}"` : ''}</span>
        <div class="acts"><button class="btn small primary" data-decide="approve" data-id="${r.request_id}" type="button">Approve</button><button class="btn small" data-decide="reject" data-id="${r.request_id}" type="button">Reject</button></div></li>`).join('')
      : '<li class="empty">Nothing waiting for you.</li>';
  } catch (e) { toast(e.message, 'error'); }
}

document.addEventListener('click', async (e) => {
  const c = e.target.closest('[data-cancel]');
  if (c) {
    c.disabled = true;
    try { await api(`/api/me/leave/${c.dataset.cancel}/cancel`, { method: 'POST', body: {} }); toast('Leave request cancelled'); } catch (err) { toast(err.message, 'error'); }
    return loadSide();
  }
  const d = e.target.closest('[data-decide]');
  if (d) {
    d.parentElement.querySelectorAll('button').forEach((b) => (b.disabled = true));
    try { const r = await api(`/api/leave/${d.dataset.id}/decide`, { method: 'POST', body: { decision: d.dataset.decide } }); toast(`${r.status} ${r.name}'s leave`); } catch (err) { toast(err.message, 'error'); }
    return loadSide();
  }
});

function welcome() {
  const w = el('div', 'welcome');
  w.innerHTML = `<h1>Hi ${esc(me.name.split(' ')[0])}, how can I help?</h1>
    <p>Ask about ${esc(me.company.name)}'s policies, check or request leave, raise a helpdesk ticket${me.access === 'employee' ? '' : ', approve your team\'s leave'}${me.access === 'hr' ? ' or look at people data' : ''}. You can write in English or Hinglish. I'll always ask before submitting anything.</p>
    <div id="suggestions"></div>`;
  thread.append(w);
  $('#suggestions').replaceChildren(...SUGGEST[me.access].map(([a, q]) => {
    const b = el('button', 'chip', esc(q)); b.type = 'button'; b.style.setProperty('--c', color(a)); b.onclick = () => ask(q); return b;
  }));
  if (me.llm.provider === 'offline') w.append(el('p', 'notice', 'This workspace is running without an AI model, so I understand common phrasings only. Your admin can add an API key to enable free-form questions.'));
}

$('#composer').addEventListener('submit', (e) => { e.preventDefault(); const t = input.value; input.value = ''; input.style.height = ''; ask(t); });
input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#composer').requestSubmit(); } });
input.addEventListener('input', () => { input.style.height = ''; input.style.height = `${input.scrollHeight}px`; });
$('#newLeave').onclick = () => { input.value = 'Apply casual leave from '; input.focus(); input.setSelectionRange(input.value.length, input.value.length); };

(async () => {
  me = await topbar('/app');
  sessionId = store.get(`peopleos-sid-${me.id}`) || Math.random().toString(36).slice(2);
  store.set(`peopleos-sid-${me.id}`, sessionId);
  $('#engine').textContent = `LangGraph orchestrator · ${me.llm.provider === 'offline' ? 'rule-based (no AI key)' : `LangChain · ${me.llm.provider} / ${me.llm.model}`}`;
  setTrace(store.get('peopleos-trace') === '1');
  welcome();
  loadSide();
  input.focus();
})();
