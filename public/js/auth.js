import { $, api, esc } from './common.js';

const mode = location.pathname.replace('/', '') || 'login';
const form = $(`#${mode}`);
form.hidden = false;
document.title = { login: 'Log in · PeopleOS', signup: 'Create workspace · PeopleOS', join: 'Join your team · PeopleOS' }[mode];
const err = $('#error');
const showError = (m) => { err.textContent = m; err.hidden = !m; };

async function submit(path, body) {
  const btn = form.querySelector('button[type=submit]');
  btn.disabled = true; showError('');
  try {
    const r = await api(path, { method: 'POST', body });
    location.href = r.redirect || '/app';
  } catch (e) { showError(e.message); btn.disabled = false; }
}

if (mode === 'login') {
  $('#login-email').focus();
  form.onsubmit = (e) => { e.preventDefault(); submit('/api/auth/login', { email: $('#login-email').value, password: $('#login-password').value }); };
}

if (mode === 'signup') {
  $('#su-company').focus();
  form.onsubmit = (e) => {
    e.preventDefault();
    submit('/api/auth/signup', { companyName: $('#su-company').value, name: $('#su-name').value, title: $('#su-title').value, email: $('#su-email').value, password: $('#su-password').value });
  };
}

if (mode === 'join') {
  const token = new URLSearchParams(location.search).get('token') || '';
  api(`/api/join?token=${encodeURIComponent(token)}`).then((inv) => {
    $('#join-title').textContent = `Join ${inv.company} on PeopleOS`;
    $('#join-sub').innerHTML = `Hi ${esc(inv.name.split(' ')[0])}! Choose a password to start using your HR assistant.`;
    $('#join-email').value = inv.email;
    $('#join-fields').hidden = false;
    $('#join-password').focus();
  }).catch((e) => { $('#join-sub').textContent = e.message; });
  form.onsubmit = (e) => { e.preventDefault(); submit('/api/join', { token, password: $('#join-password').value }); };
}
