// Small helpers shared by every page (no framework).
export const $ = (s, root = document) => root.querySelector(s);
export const $$ = (s, root = document) => [...root.querySelectorAll(s)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };

/** JSON API call. Throws Error(message) with the server's error text. Redirects to login on 401. */
export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, { method, headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
  if (res.status === 401 && !path.startsWith('/api/auth')) { location.href = '/login'; throw new Error('Please log in.'); }
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

let toastTimer;
export function toast(msg, kind = '') {
  document.querySelector('.toast')?.remove();
  const t = el('div', `toast ${kind}`, esc(msg));
  t.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  document.body.append(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), kind === 'error' ? 6000 : 3500);
}

/** Tiny, safe markdown: **bold**, `code`, bullet lists, [source-id] citations. */
export function md(s) {
  const lines = esc(s).split('\n');
  let html = '', list = false;
  for (const raw of lines) {
    const l = raw.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/_\((.+?)\)_/g, '<i>($1)</i>').replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\[([a-z0-9-]+#[a-z0-9-]+)\]/g, '<span class="cite" title="$1">source</span>');
    if (/^\s*[•\-*]\s+/.test(l)) { if (!list) { html += '<ul>'; list = true; } html += `<li>${l.replace(/^\s*[•\-*]\s+/, '')}</li>`; continue; }
    if (list) { html += '</ul>'; list = false; }
    if (l.trim()) html += `<p>${l}</p>`;
  }
  return html + (list ? '</ul>' : '');
}

export const fmtDate = (d) => {
  if (!d) return '—';
  const x = new Date(String(d).length === 10 ? `${d}T00:00:00` : d);
  return Number.isNaN(x.getTime()) ? String(d) : x.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
};

export const LOGO = '<svg viewBox="0 0 32 32" width="26" height="26" aria-hidden="true"><circle cx="11" cy="12" r="5" fill="var(--policy)"/><circle cx="21" cy="12" r="5" fill="var(--data)"/><circle cx="11" cy="22" r="5" fill="var(--action)"/><circle cx="21" cy="22" r="5" fill="var(--career)"/></svg>';

/** Renders the signed-in top bar and returns /api/me. */
export async function topbar(current) {
  const me = await api('/api/me');
  const bar = $('#topbar');
  const links = [['/app', 'Assistant']];
  if (me.access === 'hr') links.push(['/admin', 'HR console']);
  bar.innerHTML = `<a class="logo" href="/">${LOGO}<span>PeopleOS</span></a>
    <span class="company">${esc(me.company.name)}</span>
    <nav>${links.map(([href, label]) => `<a href="${href}" class="${current === href ? 'current' : ''}">${label}</a>`).join('')}
      <span class="me">${esc(me.name)} · ${esc({ hr: 'HR', manager: 'Manager', employee: 'Employee' }[me.access])}</span>
      <button type="button" id="logout">Log out</button></nav>`;
  $('#logout').onclick = async () => { await api('/api/auth/logout', { method: 'POST', body: {} }).catch(() => {}); location.href = '/login'; };
  return me;
}

export async function copyText(text, input) {
  try { await navigator.clipboard.writeText(text); toast('Copied'); }
  catch { input?.select(); toast('Press Ctrl+C to copy'); }
}
