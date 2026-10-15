// Authentication: scrypt password hashes, opaque session tokens in httpOnly cookies
// (only a SHA-256 of the token is stored), single-use invite links, and role checks.
import { randomBytes, scrypt as _scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { query, one } from './db/pg.js';

const scrypt = promisify(_scrypt);
const SESSION_DAYS = 14;
const INVITE_DAYS = 14;
export const COOKIE = 'peopleos_session';

export async function hashPassword(pw) {
  const salt = randomBytes(16);
  const key = await scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}
export async function verifyPassword(pw, stored) {
  if (!stored?.startsWith('scrypt$')) return false;
  const [, salt, key] = stored.split('$');
  const expected = Buffer.from(key, 'base64');
  const got = await scrypt(pw, Buffer.from(salt, 'base64'), expected.length, { N: 16384, r: 8, p: 1 });
  return timingSafeEqual(expected, got);
}
export function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Password must be at least 8 characters.';
  if (pw.length > 200) return 'Password is too long.';
  return null;
}

const sha = (t) => createHash('sha256').update(t).digest('hex');
const token = () => randomBytes(32).toString('base64url');

export async function createSession(personId) {
  const t = token();
  await query('INSERT INTO sessions (token_hash, person_id, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))', [sha(t), personId, SESSION_DAYS]);
  return t;
}
export async function destroySession(t) {
  if (t) await query('DELETE FROM sessions WHERE token_hash = $1', [sha(t)]);
}

/** Loads the signed-in person + company for a session token (null if missing/expired/exited). */
export async function sessionUser(t) {
  if (!t) return null;
  const row = await one(`
    SELECT p.id, p.name, p.email, p.access, p.title, p.department, p.status, p.company_id,
           c.name AS company_name, c.settings
    FROM sessions s JOIN people p ON p.id = s.person_id JOIN companies c ON c.id = p.company_id
    WHERE s.token_hash = $1 AND s.expires_at > now()`, [sha(t)]);
  if (!row || row.status !== 'Active') return null;
  return row;
}

export async function createInvite(personId) {
  const t = token();
  await query('DELETE FROM invites WHERE person_id = $1 AND used_at IS NULL', [personId]);
  await query('INSERT INTO invites (token_hash, person_id, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))', [sha(t), personId, INVITE_DAYS]);
  return t;
}
export async function findInvite(t) {
  if (!t) return null;
  return one(`SELECT i.person_id, p.name, p.email, c.name AS company_name
              FROM invites i JOIN people p ON p.id = i.person_id JOIN companies c ON c.id = p.company_id
              WHERE i.token_hash = $1 AND i.used_at IS NULL AND i.expires_at > now() AND p.status = 'Active'`, [sha(t)]);
}
export async function consumeInvite(t, password) {
  const inv = await findInvite(t);
  if (!inv) return null;
  await query('UPDATE people SET password_hash = $1 WHERE id = $2', [await hashPassword(password), inv.person_id]);
  await query('UPDATE invites SET used_at = now() WHERE token_hash = $1', [sha(t)]);
  return inv.person_id;
}

// ---------- express helpers ----------
export function readCookie(req, name = COOKIE) {
  const m = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(`${name}=`));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}
export function setSessionCookie(req, res, t) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(t)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`);
}
export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/** Attaches req.user (or null). */
export async function loadUser(req, _res, next) {
  try { req.user = await sessionUser(readCookie(req)); } catch (e) { return next(e); }
  next();
}
export const requireUser = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Please log in.' }));
export const requireAccess = (...allowed) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Please log in.' });
  if (!allowed.includes(req.user.access)) return res.status(403).json({ error: 'You do not have access to this.' });
  next();
};

/** Simple in-memory fixed-window limiter (per key). Good enough for a single instance. */
export function rateLimit({ windowMs, max, key = (req) => req.ip, message = 'Too many requests. Please wait a minute and try again.' }) {
  const hits = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset < now) hits.delete(k); }, windowMs).unref();
  return (req, res, next) => {
    const k = key(req); const now = Date.now();
    let h = hits.get(k);
    if (!h || h.reset < now) { h = { n: 0, reset: now + windowMs }; hits.set(k, h); }
    if (++h.n > max) { res.setHeader('Retry-After', Math.ceil((h.reset - now) / 1000)); return res.status(429).json({ error: message }); }
    next();
  };
}
