import express from 'express';
import { fileURLToPath } from 'node:url';
import { init, dbKind } from './db/pg.js';
import { runTurn, resumeTurn, peopleGraph } from './agents/orchestrator.js';
import { providerInfo } from './llm/provider.js';
import * as auth from './auth.js';
import * as co from './services/company.js';
import * as pol from './services/policies.js';
import * as work from './services/work.js';
import { csvToPeople, CSV_TEMPLATE } from './lib/csv.js';
import { mailEnabled, mailProvider, rememberOrigin } from './lib/mailer.js';
import { sendInviteEmail } from './services/notify.js';

const app = express();
app.set('trust proxy', 1); // Render / any reverse proxy → correct req.ip and https detection
app.disable('x-powered-by');
const PUBLIC = fileURLToPath(new URL('../public', import.meta.url));
const page = (name) => (_req, res) => res.sendFile(`${PUBLIC}/${name}`);

// ---------- security headers ----------
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  next();
});

// JSON bodies: policy uploads may be large (base64 file), everything else is small.
app.use('/api/admin/policies', express.json({ limit: '12mb' }));
app.use(express.json({ limit: '100kb' }));
// CSRF defence: state-changing API calls must be JSON (a cross-site form can't send that), plus SameSite cookies.
app.use('/api', (req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !req.is('application/json')) return res.status(415).json({ error: 'Send JSON.' });
  next();
});
app.use(auth.loadUser);

// ---------- pages ----------
app.get('/', (req, res) => (req.user ? res.redirect(req.user.access === 'hr' ? '/admin' : '/app') : page('index.html')(req, res)));
app.get(['/login', '/signup', '/join', '/forgot'], (req, res) => (req.user && req.path !== '/join' ? res.redirect('/app') : page('auth.html')(req, res)));
app.get('/app', (req, res) => (req.user ? page('app.html')(req, res) : res.redirect('/login')));
app.get('/admin', (req, res) => (!req.user ? res.redirect('/login') : req.user.access !== 'hr' ? res.redirect('/app') : page('admin.html')(req, res)));
app.get('/vendor/chart.js', (_, res) => res.sendFile(fileURLToPath(new URL('../node_modules/chart.js/dist/chart.umd.min.js', import.meta.url))));
app.use(express.static(PUBLIC, { index: false, extensions: [] }));

// ---------- helpers ----------
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const ctxOf = (u) => ({
  user: { id: u.id, name: u.name, email: u.email, title: u.title, access: u.access, company_id: u.company_id },
  access: u.access,
  company: { id: u.company_id, name: u.company_name, settings: u.settings },
});
const origin = (req) => process.env.PUBLIC_URL?.replace(/\/$/, '') || `${req.protocol}://${req.get('host')}`;
app.use((req, _res, next) => { if (req.user) rememberOrigin(origin(req)); next(); }); // base URL for links in notification emails (signed-in requests only, never health checks)
const loginLimiter = auth.rateLimit({ windowMs: 15 * 60_000, max: 10, key: (req) => `${req.ip}:${String(req.body?.email || '').toLowerCase()}`, message: 'Too many login attempts. Try again in 15 minutes.' });
const forgotLimiter = auth.rateLimit({ windowMs: 60 * 60_000, max: 5, key: (req) => `${req.ip}:forgot`, message: 'Too many reset requests. Try again in an hour.' });
const signupLimiter = auth.rateLimit({ windowMs: 60 * 60_000, max: 5, message: 'Too many sign-ups from this network. Try again later.' });
const chatLimiter = auth.rateLimit({ windowMs: 60_000, max: 20, key: (req) => req.user?.id || req.ip, message: 'You are sending messages too fast. Wait a few seconds.' });

// ---------- auth ----------
app.post('/api/auth/signup', signupLimiter, wrap(async (req, res) => {
  const err = auth.validatePassword(req.body?.password);
  if (err) return res.status(400).json({ error: err });
  const { personId } = await co.createCompany(req.body || {});
  auth.setSessionCookie(req, res, await auth.createSession(personId));
  res.json({ ok: true, redirect: '/admin' });
}));

app.post('/api/auth/login', loginLimiter, wrap(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const { one } = await import('./db/pg.js');
  const p = await one("SELECT id, password_hash, access, status FROM people WHERE lower(email) = $1", [email]);
  const ok = p?.password_hash && p.status === 'Active' && await auth.verifyPassword(String(req.body?.password || ''), p.password_hash);
  if (!ok) return res.status(401).json({ error: p && !p.password_hash ? 'You have not set a password yet. Use the invite link from your HR team.' : 'Wrong email or password.' });
  auth.setSessionCookie(req, res, await auth.createSession(p.id));
  res.json({ ok: true, redirect: p.access === 'hr' ? '/admin' : '/app' });
}));

app.get('/api/auth/options', (_, res) => res.json({ email: mailEnabled() }));

// Forgot password: always answers the same way, so it can't be used to check who has an account.
app.post('/api/auth/forgot', forgotLimiter, wrap(async (req, res) => {
  if (!mailEnabled()) return res.status(400).json({ error: 'Password reset by email is not set up here. Ask your HR team for a reset link.' });
  const email = String(req.body?.email || '').trim().toLowerCase();
  const { one } = await import('./db/pg.js');
  const p = await one(`SELECT p.id, p.name, p.email, c.name AS company_name FROM people p JOIN companies c ON c.id = p.company_id
                       WHERE lower(p.email) = $1 AND p.status = 'Active' AND p.password_hash IS NOT NULL`, [email]);
  if (p) {
    const t = await auth.createInvite(p.id, 2);
    await sendInviteEmail({ person: p, companyName: p.company_name, link: `${origin(req)}/join?token=${encodeURIComponent(t)}`, reset: true });
  }
  res.json({ ok: true, message: 'If that email has an account, a reset link is on its way. It works for 2 hours.' });
}));

app.post('/api/auth/logout', wrap(async (req, res) => {
  await auth.destroySession(auth.readCookie(req));
  auth.clearSessionCookie(res);
  res.json({ ok: true });
}));

app.get('/api/join', wrap(async (req, res) => {
  const inv = await auth.findInvite(String(req.query.token || ''));
  if (!inv) return res.status(404).json({ error: 'This invite link is invalid or has expired. Ask your HR team for a new one.' });
  res.json({ name: inv.name, email: inv.email, company: inv.company_name, reset: inv.joined });
}));
app.post('/api/join', signupLimiter, wrap(async (req, res) => {
  const err = auth.validatePassword(req.body?.password);
  if (err) return res.status(400).json({ error: err });
  const personId = await auth.consumeInvite(String(req.body?.token || ''), req.body.password);
  if (!personId) return res.status(404).json({ error: 'This invite link is invalid or has expired. Ask your HR team for a new one.' });
  auth.setSessionCookie(req, res, await auth.createSession(personId));
  res.json({ ok: true, redirect: '/app' });
}));

app.get('/api/me', auth.requireUser, wrap(async (req, res) => {
  const u = req.user; const s = co.settingsOf({ settings: u.settings });
  res.json({
    id: u.id, name: u.name, email: u.email, title: u.title, access: u.access,
    company: { id: u.company_id, name: u.company_name, leaveTypes: Object.keys(s.leave), contacts: s.contacts },
    llm: providerInfo(), orchestrator: 'LangGraph',
  });
}));

// ---------- employee self-service ----------
app.get('/api/me/leave', auth.requireUser, wrap(async (req, res) => res.json({ balances: await work.balances(req.user.id), requests: await work.myLeave(req.user.id, 20) })));
app.post('/api/me/leave/:id/cancel', auth.requireUser, wrap(async (req, res) => res.json(await work.cancelLeave(req.user, +req.params.id))));
app.get('/api/me/tickets', auth.requireUser, wrap(async (req, res) => res.json(await work.myTickets(req.user.id))));
app.get('/api/me/approvals', auth.requireAccess('manager', 'hr'), wrap(async (req, res) => res.json(await work.pendingApprovals(req.user))));
app.post('/api/leave/:id/decide', auth.requireAccess('manager', 'hr'), wrap(async (req, res) => res.json(await work.decideLeave(req.user, +req.params.id, req.body?.decision, req.body?.note))));

// ---------- the agent ----------
// Agent trace steps (LangGraph custom stream) are streamed live over Server-Sent Events, then the result.
async function stream(res, work) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  try {
    send('result', await work((step) => send('trace', step)));
  } catch (e) {
    console.error(e);
    send('error', { message: e.status ? e.message : 'Something went wrong on our side. Please try again.' });
  }
  res.end();
}
const threadOf = (req) => `${req.user.id}:${String(req.body?.sessionId || 'web').slice(0, 64)}`;

app.post('/api/chat', auth.requireUser, chatLimiter, wrap(async (req, res) => {
  const message = String(req.body?.message || '').trim();
  if (!message || message.length > 2000) return res.status(400).json({ error: 'Message must be 1–2000 characters.' });
  const ctx = ctxOf(req.user);
  if (!(await work.countMessage(ctx.company))) return res.status(429).json({ error: "Your company has used today's message limit. It resets at midnight; HR can raise it in Settings." });
  stream(res, (onTrace) => runTurn({ threadId: threadOf(req), message, ctx, onTrace }));
}));

app.post('/api/approve', auth.requireUser, wrap(async (req, res) => {
  const ctx = ctxOf(req.user);
  stream(res, (onTrace) => resumeTurn({ threadId: threadOf(req), id: String(req.body?.id || ''), decision: req.body?.decision, ctx, onTrace }));
}));

app.get('/api/graph', wrap(async (_, res) => res.type('text/plain').send((await peopleGraph.getGraphAsync()).drawMermaid())));
app.get('/api/health', wrap(async (_, res) => res.json({ ok: true, db: await dbKind(), llm: providerInfo().provider })));

// ---------- HR console ----------
const hr = auth.requireAccess('hr');
app.get('/api/admin/overview', hr, wrap(async (req, res) => res.json({ ...(await co.overview(req.user.company_id)), dbPersistent: (await dbKind()) === 'postgres', mailEnabled: mailEnabled() })));

app.get('/api/admin/people', hr, wrap(async (req, res) => res.json(await co.listPeople(req.user.company_id))));
app.post('/api/admin/people', hr, wrap(async (req, res) => {
  const out = await co.upsertPeople(req.user.company_id, [req.body]);
  if (out.errors.length) return res.status(400).json({ error: out.errors[0].error });
  res.json(out);
}));
app.post('/api/admin/people/import', hr, wrap(async (req, res) => {
  const { people, unknown, error } = csvToPeople(req.body?.csv);
  if (error) return res.status(400).json({ error });
  const out = await co.upsertPeople(req.user.company_id, people);
  await co.audit(req.user.company_id, req.user.id, 'people.import', { added: out.added, updated: out.updated, errors: out.errors.length });
  res.json({ ...out, ignoredColumns: unknown });
}));
app.get('/api/admin/people/template.csv', hr, (_, res) => res.type('text/csv').attachment('peopleos-employees.csv').send(CSV_TEMPLATE));
app.patch('/api/admin/people/:id', hr, wrap(async (req, res) => res.json(await co.updatePerson(req.user.company_id, req.params.id, req.body || {}, req.user))));
app.get('/api/admin/people/:id/leave', hr, wrap(async (req, res) => res.json({ balances: await work.balances(req.params.id), requests: await work.myLeave(req.params.id, 10) })));
app.post('/api/admin/people/:id/invite', hr, wrap(async (req, res) => res.json(await co.inviteLink(req.user.company_id, req.params.id, origin(req), { send: !!req.body?.send }))));
app.post('/api/admin/people/invite-all', hr, wrap(async (req, res) => {
  if (!mailEnabled()) return res.status(400).json({ error: 'Email is not set up on this server.' });
  const out = await co.inviteAllPending(req.user.company_id, origin(req));
  await co.audit(req.user.company_id, req.user.id, 'people.invite_all', out);
  res.json(out);
}));

app.get('/api/admin/policies', hr, wrap(async (req, res) => res.json(await pol.listPolicies(req.user.company_id))));
app.post('/api/admin/policies', hr, wrap(async (req, res) => {
  const b = req.body || {};
  const buffer = b.contentBase64 ? Buffer.from(String(b.contentBase64), 'base64') : null;
  const out = await pol.addPolicy(req.user.company_id, req.user.id, { title: b.title, filename: b.filename, buffer, text: b.text });
  await co.audit(req.user.company_id, req.user.id, 'policy.add', { title: out.title });
  res.json(out);
}));
app.get('/api/admin/policies/:id', hr, wrap(async (req, res) => res.json(await pol.getPolicy(req.user.company_id, req.params.id))));
app.delete('/api/admin/policies/:id', hr, wrap(async (req, res) => { await pol.deletePolicy(req.user.company_id, req.params.id); res.json({ ok: true }); }));

app.get('/api/admin/tickets', hr, wrap(async (req, res) => res.json(await work.companyTickets(req.user.company_id, req.query.status || null))));
app.patch('/api/admin/tickets/:id', hr, wrap(async (req, res) => res.json(await work.updateTicket(req.user, +req.params.id, req.body || {}))));

app.get('/api/admin/settings', hr, wrap(async (req, res) => {
  const c = await co.getCompany(req.user.company_id);
  res.json({ companyName: c.name, ...co.settingsOf(c), mailEnabled: mailEnabled() });
}));
app.put('/api/admin/settings', hr, wrap(async (req, res) => res.json(await co.updateSettings(req.user.company_id, req.body || {}))));

// ---------- errors ----------
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((err, req, res, _next) => {
  if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That file is too large (max 8 MB).' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our side. Please try again.' });
});

const PORT = +(process.env.PORT || 3000);
await init();
app.listen(PORT, async () => {
  const { provider, model } = providerInfo();
  const kind = await dbKind();
  console.log(`\n  PeopleOS running → http://localhost:${PORT}`);
  console.log(`  Database: ${kind}${kind === 'postgres' ? '' : '  (local only — set DATABASE_URL to a Postgres database for production)'}`);
  console.log(`  Email: ${mailProvider() || 'off (set BREVO_API_KEY + MAIL_FROM to send invites and notifications)'}`);
  console.log(`  LLM: ${provider}${provider === 'offline' ? ' (no API key — agents use deterministic planners)' : ` / ${model}`}\n`);
});
