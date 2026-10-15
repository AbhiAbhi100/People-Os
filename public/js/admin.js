import { $, $$, esc, el, api, toast, topbar, fmtDate, copyText } from './common.js';

let me, people = [];
const dlg = $('#dlg'), body = $('#dlgBody');

// ---------- tabs ----------
const TABS = ['overview', 'people', 'policies', 'leave', 'tickets', 'settings'];
const loaders = {};
function show() {
  const tab = TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'overview';
  for (const t of TABS) $(`#tab-${t}`).hidden = t !== tab;
  $$('.tabs a').forEach((a) => a.classList.toggle('current', a.getAttribute('href') === `#${tab}`));
  loaders[tab]?.();
}
window.addEventListener('hashchange', show);

// ---------- dialog helper ----------
function openDialog(html, onSubmit) {
  body.innerHTML = html;
  body.onsubmit = async (e) => {
    if (e.submitter?.value === 'cancel') return; // closes the dialog
    e.preventDefault();
    const btn = e.submitter; if (btn) btn.disabled = true;
    try { if ((await onSubmit?.()) !== false) dlg.close(); } catch (err) { toast(err.message, 'error'); } finally { if (btn) btn.disabled = false; }
  };
  dlg.showModal();
}
const cancelBtn = '<button class="btn" value="cancel" formnovalidate type="submit">Cancel</button>';

// ---------- overview ----------
loaders.overview = async () => {
  const o = await api('/api/admin/overview');
  $('#dbWarning').hidden = o.dbPersistent;
  const s = [
    ['#people', o.people, 'active people'],
    ['#people', o.not_joined, 'haven\'t set a password', o.not_joined > 0],
    ['#policies', o.policies, 'policy documents', o.policies === 0],
    ['#leave', o.pending_leave, 'leave requests pending', o.pending_leave > 0],
    ['#tickets', o.open_tickets, 'open tickets', o.open_tickets > 0],
    ['/app', o.messages_7d, 'assistant messages, last 7 days'],
  ];
  $('#stats').innerHTML = s.map(([href, n, label, attn]) => `<a class="stat${attn ? ' attn' : ''}" href="${href}"><b>${n}</b><span>${label}</span></a>`).join('');
  $('#leaveCount').textContent = o.pending_leave || '';
  $('#ticketCount').textContent = o.open_tickets || '';
  const settings = await api('/api/admin/settings');
  const steps = [
    [o.policies > 0, 'Upload your HR policies', 'Leave, WFH, reimbursement, POSH… PDF or Word files.', '#policies'],
    [o.people > 1, 'Add your people', 'Import a CSV with names, emails, titles and managers.', '#people'],
    [o.people > 1 && o.not_joined === 0, 'Share invite links', 'Each person sets a password from their link. Send it on email or WhatsApp.', '#people'],
    [!!(settings.contacts.ic || settings.contacts.eap), 'Add contacts for sensitive topics', 'Internal Committee and counselling details, so the assistant can point people to them.', '#settings'],
  ];
  $('#checklist').innerHTML = steps.map(([done, title, hint, href]) => `<li class="${done ? 'done' : ''}"><b><a href="${href}">${title}</a></b><span class="muted">${hint}</span></li>`).join('');
};

// ---------- people ----------
const accessBadge = (a) => `<span class="badge ${a}">${{ hr: 'HR', manager: 'Manager', employee: 'Employee' }[a]}</span>`;
function renderPeople() {
  const q = $('#peopleSearch').value.trim().toLowerCase();
  const list = people.filter((p) => !q || [p.name, p.email, p.title, p.department, p.location].some((v) => v?.toLowerCase().includes(q)));
  $('#peopleRows').innerHTML = list.length ? list.slice(0, 500).map((p) => `<tr>
      <td class="person"><b>${esc(p.name)}</b><span>${esc(p.email)}</span></td>
      <td>${esc(p.title || '—')}</td><td>${esc(p.department || '—')}</td><td>${esc(p.manager_name || '—')}</td>
      <td>${accessBadge(p.access)}</td>
      <td>${p.status === 'Exited' ? '<span class="badge Exited">Exited</span>' : p.joined ? '<span class="badge yes">Joined</span>' : '<span class="badge Pending">Not joined</span>'}</td>
      <td><div class="rowacts">${p.status === 'Active' && !p.joined ? `<button class="btn small" data-invite="${p.id}" type="button">Invite link</button>` : ''}<button class="btn small" data-edit="${p.id}" type="button">Edit</button></div></td></tr>`).join('')
    : `<tr><td colspan="7"><div class="empty-state">${people.length ? 'No one matches that search.' : 'No people yet. Import a CSV or add someone.'}</div></td></tr>`;
}
loaders.people = async () => { people = await api('/api/admin/people'); renderPeople(); };
$('#peopleSearch').addEventListener('input', renderPeople);

const personFields = (p = {}) => `
  <div class="grid2">
    <label class="field">Full name<input type="text" name="name" value="${esc(p.name || '')}" required maxlength="80"></label>
    <label class="field">Work email<input type="email" name="email" value="${esc(p.email || '')}" ${p.id ? 'disabled' : 'required'}></label>
    <label class="field">Job title<input type="text" name="title" value="${esc(p.title || '')}" maxlength="80"></label>
    <label class="field">Team / department<input type="text" name="department" value="${esc(p.department || '')}" maxlength="80"></label>
    <label class="field">Location<input type="text" name="location" value="${esc(p.location || '')}" maxlength="80"></label>
    <label class="field">Manager's email<input type="email" name="manager_email" value="${esc(people.find((x) => x.id === p.manager_id)?.email || '')}"></label>
    <label class="field">Access<select name="access">${['employee', 'manager', 'hr'].map((a) => `<option value="${a}" ${p.access === a ? 'selected' : ''}>${{ employee: 'Employee', manager: 'Manager (approves their team)', hr: 'HR admin (sees everything)' }[a]}</option>`).join('')}</select></label>
    <label class="field">Joining date<input type="date" name="join_date" value="${esc(p.join_date || '')}"></label>
  </div>`;
const formData = () => Object.fromEntries(new FormData(body).entries());

$('#addBtn').onclick = () => openDialog(`<h3>Add a person</h3>${personFields()}
  <div class="row">${cancelBtn}<span class="spacer"></span><button class="btn primary" type="submit">Add person</button></div>`, async () => {
  await api('/api/admin/people', { method: 'POST', body: formData() });
  toast('Person added. Use "Invite link" to let them log in.');
  loaders.people();
});

$('#importBtn').onclick = () => openDialog(`<h3>Import people from CSV</h3>
  <p class="muted small">Columns: <code>name, email</code> (required) and optionally <code>title, department, level, location, manager_email, join_date, access</code>.
  Existing people (same email) are updated. Managers are linked by <code>manager_email</code>. <a href="/api/admin/people/template.csv">Download a template</a>.</p>
  <input type="file" id="csvFile" accept=".csv,text/csv">
  <textarea id="csvText" rows="7" placeholder="…or paste CSV here"></textarea>
  <div id="importResult"></div>
  <div class="row">${cancelBtn}<span class="spacer"></span><button class="btn primary" type="submit">Import</button></div>`, async () => {
  const file = $('#csvFile').files[0];
  const csv = file ? await file.text() : $('#csvText').value;
  if (!csv.trim()) throw new Error('Choose a CSV file or paste CSV text.');
  const r = await api('/api/admin/people/import', { method: 'POST', body: { csv } });
  const issues = r.results.filter((x) => x.status === 'error' || x.warning);
  $('#importResult').innerHTML = `<p><b>${r.added} added, ${r.updated} updated${r.errors.length ? `, ${r.errors.length} skipped` : ''}.</b>${r.ignoredColumns.length ? ` Ignored columns: ${esc(r.ignoredColumns.join(', '))}.` : ''}</p>` +
    (issues.length ? `<ul class="result-list">${issues.map((x) => `<li>Row ${x.row} ${esc(x.email)}: ${esc(x.error || x.warning)}</li>`).join('')}</ul>` : '');
  loaders.people();
  toast(`Imported ${r.added + r.updated} people`);
  return false; // keep the dialog open so the result is visible
});

document.addEventListener('click', async (e) => {
  const inv = e.target.closest('[data-invite]');
  if (inv) {
    const p = people.find((x) => x.id === inv.dataset.invite);
    try {
      const { link } = await api(`/api/admin/people/${p.id}/invite`, { method: 'POST', body: {} });
      const msg = `Hi ${p.name.split(' ')[0]}, you're invited to ${me.company.name}'s HR assistant on PeopleOS. Set your password here (valid 14 days): ${link}`;
      openDialog(`<h3>Invite ${esc(p.name)}</h3>
        <p class="muted small">Send this link to ${esc(p.email)}. It works once and expires in 14 days. Creating a new link cancels the old one.</p>
        <div class="copybox"><input type="text" id="inviteLink" value="${esc(link)}" readonly><button class="btn" type="button" id="copyLink">Copy link</button></div>
        <textarea id="inviteMsg" rows="3" readonly>${esc(msg)}</textarea>
        <div class="row"><button class="btn" type="button" id="copyMsg">Copy message</button><span class="spacer"></span><button class="btn primary" value="cancel" type="submit">Done</button></div>`);
      $('#copyLink').onclick = () => copyText(link, $('#inviteLink'));
      $('#copyMsg').onclick = () => copyText(msg, $('#inviteMsg'));
    } catch (err) { toast(err.message, 'error'); }
  }
  const ed = e.target.closest('[data-edit]');
  if (ed) {
    const p = people.find((x) => x.id === ed.dataset.edit);
    let bal = [];
    try { bal = (await api(`/api/admin/people/${p.id}/leave`)).balances; } catch {}
    openDialog(`<h3>Edit ${esc(p.name)}</h3>${personFields(p)}
      <div class="stack"><b class="small">Leave balance (days left)</b><div class="grid2">${bal.map((b) => `<label class="field">${esc(b.leave_type)}<input type="number" step="0.5" min="0" name="bal:${esc(b.leave_type)}" value="${b.balance}"></label>`).join('') || '<span class="muted small">No leave types set up.</span>'}</div></div>
      <label class="field">Status<select name="status"><option ${p.status === 'Active' ? 'selected' : ''}>Active</option><option value="Exited" ${p.status === 'Exited' ? 'selected' : ''}>Exited (can no longer log in)</option></select></label>
      <div class="row">${cancelBtn}<span class="spacer"></span><button class="btn primary" type="submit">Save</button></div>`, async () => {
      const f = formData();
      const patch = { name: f.name, title: f.title, department: f.department, location: f.location, access: f.access, manager_email: f.manager_email, balances: {} };
      for (const [k, v] of Object.entries(f)) if (k.startsWith('bal:')) patch.balances[k.slice(4)] = v;
      if (f.status !== p.status) patch.status = f.status;
      await api(`/api/admin/people/${p.id}`, { method: 'PATCH', body: patch });
      toast('Saved'); loaders.people();
    });
  }
});

// ---------- policies ----------
loaders.policies = async () => {
  const list = await api('/api/admin/policies');
  $('#policyRows').innerHTML = list.length ? list.map((d) => `<tr>
      <td><b>${esc(d.title)}</b><div class="muted small">${esc(d.filename || 'pasted text')} · ${Math.round(d.chars / 100) / 10}k characters</div></td>
      <td class="num">${d.sections}</td><td>${fmtDate(d.created_at)}${d.uploaded_by ? `<div class="muted small">${esc(d.uploaded_by)}</div>` : ''}</td>
      <td><div class="rowacts"><button class="btn small" data-view="${d.id}" type="button">View sections</button><button class="btn small danger" data-del="${d.id}" data-title="${esc(d.title)}" type="button">Delete</button></div></td></tr>`).join('')
    : '<tr><td colspan="4"><div class="empty-state">No policies yet. Upload your first one above; the assistant can\'t answer policy questions until you do.</div></td></tr>';
};
const toBase64 = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(file); });
$('#uploadForm').onsubmit = async (e) => {
  e.preventDefault();
  const file = $('#policyFile').files[0];
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) return toast('That file is larger than 8 MB.', 'error');
  const btn = e.submitter; btn.disabled = true; btn.textContent = 'Reading…';
  try {
    const r = await api('/api/admin/policies', { method: 'POST', body: { filename: file.name, title: $('#policyTitle').value, contentBase64: await toBase64(file) } });
    toast(`Added "${r.title}" with ${r.sections} sections`);
    e.target.reset(); loaders.policies();
  } catch (err) { toast(err.message, 'error'); }
  btn.disabled = false; btn.textContent = 'Upload';
};
$('#pasteBtn').onclick = async (e) => {
  const text = $('#pasteText').value;
  if (!text.trim()) return toast('Paste some policy text first.', 'error');
  e.target.disabled = true;
  try {
    const r = await api('/api/admin/policies', { method: 'POST', body: { title: $('#pasteTitle').value || 'Policy', text } });
    toast(`Added "${r.title}" with ${r.sections} sections`);
    $('#pasteText').value = ''; $('#pasteTitle').value = ''; loaders.policies();
  } catch (err) { toast(err.message, 'error'); }
  e.target.disabled = false;
};
document.addEventListener('click', async (e) => {
  const v = e.target.closest('[data-view]');
  if (v) {
    const d = await api(`/api/admin/policies/${v.dataset.view}`).catch((err) => toast(err.message, 'error'));
    if (!d) return;
    openDialog(`<h3>${esc(d.title)}</h3><p class="muted small">This is how the assistant sees the document: ${d.sections.length} sections it can quote from.</p>
      <div class="sections">${d.sections.map((s) => `<div><h4>${esc(s.heading)}</h4><p>${esc(s.text)}</p></div>`).join('')}</div>
      <div class="row"><span class="spacer"></span><button class="btn primary" value="cancel" type="submit">Close</button></div>`);
  }
  const del = e.target.closest('[data-del]');
  if (del) {
    openDialog(`<h3>Delete "${esc(del.dataset.title)}"?</h3><p class="muted">The assistant will stop answering from this document. This can't be undone.</p>
      <div class="row">${cancelBtn}<span class="spacer"></span><button class="btn primary" type="submit">Delete policy</button></div>`, async () => {
      await api(`/api/admin/policies/${del.dataset.del}`, { method: 'DELETE', body: {} });
      toast('Policy deleted'); loaders.policies();
    });
  }
});

// ---------- leave ----------
loaders.leave = async () => {
  const list = await api('/api/me/approvals');
  $('#leaveCount').textContent = list.length || '';
  $('#leaveRows').innerHTML = list.length ? list.map((r) => `<tr>
      <td>${r.request_id}</td><td class="person"><b>${esc(r.name)}</b><span>${esc(r.email)}</span></td><td>${esc(r.leave_type)}</td>
      <td>${fmtDate(r.start_date)}${r.end_date !== r.start_date ? ` → ${fmtDate(r.end_date)}` : ''}</td><td class="num">${r.days}</td><td>${esc(r.reason || '—')}</td><td class="num">${r.balance ?? '—'}</td>
      <td><div class="rowacts"><button class="btn small primary" data-decide="approve" data-id="${r.request_id}" type="button">Approve</button><button class="btn small" data-decide="reject" data-id="${r.request_id}" type="button">Reject</button></div></td></tr>`).join('')
    : '<tr><td colspan="8"><div class="empty-state">No leave requests waiting. You\'re all caught up.</div></td></tr>';
};
document.addEventListener('click', async (e) => {
  const d = e.target.closest('[data-decide]');
  if (!d) return;
  const reject = d.dataset.decide === 'reject';
  const run = async (note) => {
    const r = await api(`/api/leave/${d.dataset.id}/decide`, { method: 'POST', body: { decision: d.dataset.decide, note } });
    toast(`${r.status} ${r.name}'s leave`); loaders.leave();
  };
  if (!reject) { d.disabled = true; try { await run(); } catch (err) { toast(err.message, 'error'); d.disabled = false; } return; }
  openDialog(`<h3>Reject leave request #${esc(d.dataset.id)}</h3><label class="field">Reason for the employee <span class="hint">optional</span><input type="text" id="rejNote" maxlength="300"></label>
    <div class="row">${cancelBtn}<span class="spacer"></span><button class="btn primary" type="submit">Reject</button></div>`, () => run($('#rejNote').value));
});

// ---------- tickets ----------
loaders.tickets = async () => {
  const list = await api(`/api/admin/tickets${$('#ticketFilter').value ? `?status=${encodeURIComponent($('#ticketFilter').value)}` : ''}`);
  $('#ticketRows').innerHTML = list.length ? list.map((t) => `<tr>
      <td>${t.ticket_id}</td><td class="person"><b>${esc(t.name)}</b><span>${esc(t.email)}</span></td>
      <td>${esc(t.category)}${t.priority === 'High' ? ' <span class="badge Rejected">High</span>' : ''}</td><td>${esc(t.description)}</td><td>${fmtDate(t.created_at)}</td>
      <td><div class="ticket-edit"><div class="row"><select data-tstatus="${t.ticket_id}" aria-label="Status">${['Open', 'In progress', 'Resolved'].map((s) => `<option ${t.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
        <button class="btn small" data-tsave="${t.ticket_id}" type="button">Save</button></div>
        <input type="text" data-tres="${t.ticket_id}" placeholder="Reply to the employee" value="${esc(t.resolution || '')}" maxlength="1000"></div></td></tr>`).join('')
    : '<tr><td colspan="6"><div class="empty-state">No tickets here.</div></td></tr>';
};
$('#ticketFilter').onchange = () => loaders.tickets();
document.addEventListener('click', async (e) => {
  const s = e.target.closest('[data-tsave]');
  if (!s) return;
  const id = s.dataset.tsave;
  s.disabled = true;
  try {
    await api(`/api/admin/tickets/${id}`, { method: 'PATCH', body: { status: $(`[data-tstatus="${id}"]`).value, resolution: $(`[data-tres="${id}"]`).value } });
    toast(`Ticket #${id} updated`);
  } catch (err) { toast(err.message, 'error'); }
  s.disabled = false;
});

// ---------- settings ----------
const leaveRow = (type = '', days = '') => {
  const r = el('div', 'lt', `<input type="text" placeholder="Leave type, e.g. Casual" value="${esc(type)}" maxlength="30" aria-label="Leave type"><input type="number" min="0" max="365" step="0.5" value="${esc(days)}" aria-label="Days per year"><button class="btn small" type="button">Remove</button>`);
  r.querySelector('button').onclick = () => r.remove();
  return r;
};
loaders.settings = async () => {
  const s = await api('/api/admin/settings');
  $('#setCompany').value = s.companyName;
  $('#leaveTypes').replaceChildren(...Object.entries(s.leave).map(([k, v]) => leaveRow(k, v)));
  $('#setNotice').value = s.earnedNoticeDays; $('#setAuto').value = s.autoApproveUpToDays; $('#setLimit').value = s.dailyMessageLimit;
  $('#cHr').value = s.contacts.hr; $('#cIc').value = s.contacts.ic; $('#cEap').value = s.contacts.eap; $('#cEthics').value = s.contacts.ethics;
};
$('#addLeaveType').onclick = () => $('#leaveTypes').append(leaveRow());
$('#settingsForm').onsubmit = async (e) => {
  e.preventDefault();
  const leave = {};
  for (const r of $$('#leaveTypes .lt')) { const [t, d] = r.querySelectorAll('input'); if (t.value.trim()) leave[t.value.trim()] = Number(d.value || 0); }
  const btn = e.submitter; btn.disabled = true;
  try {
    await api('/api/admin/settings', { method: 'PUT', body: {
      companyName: $('#setCompany').value, leave, earnedNoticeDays: $('#setNotice').value, autoApproveUpToDays: $('#setAuto').value, dailyMessageLimit: $('#setLimit').value,
      contacts: { hr: $('#cHr').value, ic: $('#cIc').value, eap: $('#cEap').value, ethics: $('#cEthics').value },
    } });
    toast('Settings saved');
  } catch (err) { toast(err.message, 'error'); }
  btn.disabled = false;
};

(async () => {
  me = await topbar('/admin');
  show();
})();
