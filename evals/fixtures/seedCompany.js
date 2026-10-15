// Test fixture: creates a realistic, fully synthetic company ("Acme Fintech", 524 people) in the
// real multi-tenant schema, plus a second small company ("Globex") used to prove tenant isolation.
// Deterministic RNG, so every eval run sees the same numbers. Not used by the app itself.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { query } from '../../src/db/pg.js';
import { createCompany, updateSettings } from '../../src/services/company.js';
import { addPolicy } from '../../src/services/policies.js';
import { hashPassword } from '../../src/auth.js';

let s = 42;
const rand = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = (a) => a[Math.floor(rand() * a.length)];
const between = (a, b) => a + Math.floor(rand() * (b - a + 1));
const iso = (d) => d.toISOString().slice(0, 10);

const FIRST = ['Aarav','Riya','Arjun','Meera','Kabir','Ananya','Vihaan','Isha','Rohan','Diya','Aditya','Sneha','Karan','Pooja','Yash','Nisha','Rahul','Tanvi','Siddharth','Kavya','Manav','Priya','Dev','Neha','Aman','Shreya','Varun','Aditi','Nikhil','Simran','Harsh','Zoya','Ishaan','Lavanya','Pranav','Ritika','Omkar','Sana','Tushar','Bhavna'];
const LAST = ['Sharma','Verma','Iyer','Nair','Patel','Gupta','Reddy','Singh','Joshi','Mehta','Kulkarni','Das','Bose','Khan','Rao','Pillai','Chopra','Agarwal','Menon','Saxena'];
const DEPTS = {
  Engineering: ['Software Engineer','Senior Software Engineer','Engineering Manager','SDET'],
  Product: ['Product Manager','Senior Product Manager','Product Analyst'],
  'Data Science': ['Data Analyst','Data Scientist','ML Engineer','Analytics Manager'],
  'Customer Support': ['Support Associate','Support Team Lead','Quality Analyst'],
  Sales: ['Relationship Manager','Sales Manager','Business Development Executive'],
  Compliance: ['Compliance Analyst','Compliance Manager'],
  HR: ['HR Business Partner','Talent Acquisition Specialist','HR Operations Executive'],
  Finance: ['Financial Analyst','Accounts Executive','Finance Manager'],
  Marketing: ['Growth Marketer','Content Strategist','Marketing Manager'],
};
const DEPT_WEIGHT = { Engineering: 22, Product: 6, 'Data Science': 7, 'Customer Support': 20, Sales: 15, Compliance: 5, HR: 5, Finance: 6, Marketing: 6 };
const LOCATIONS = ['Mumbai','Mumbai','Bengaluru','Bengaluru','Hyderabad','Noida','Remote'];
const LEVEL_OF = (role) => /Manager|Lead/.test(role) ? 'L4' : /Senior/.test(role) ? 'L3' : /Associate|Executive/.test(role) ? 'L1' : 'L2';
const BASE_SALARY = { L1: 4.5, L2: 11, L3: 22, L4: 34 };

export const DOMAIN = 'acme.test';
export const PASSWORD = 'demo-pass-123';
export const PERSONAS = {
  E1001: `riya.sharma@${DOMAIN}`, E1002: `arjun.mehta@${DOMAIN}`, E1003: `meera.iyer@${DOMAIN}`, E1004: `kabir.khan@${DOMAIN}`,
};

async function insertMany(table, cols, rows, chunk = 200) {
  for (let i = 0; i < rows.length; i += chunk) {
    const part = rows.slice(i, i + chunk);
    const params = [];
    const values = part.map((r) => `(${r.map((v) => { params.push(v); return `$${params.length}`; }).join(',')})`).join(',');
    await query(`INSERT INTO ${table} (${cols.join(',')}) VALUES ${values}`, params);
  }
}

/** Builds Acme (big) + Globex (small). Returns company ids and persona emails. */
export async function seedCompanies() {
  s = 42;
  const hash = await hashPassword(PASSWORD);
  // ---- Acme: created through the real signup path, with Meera as the HR admin ----
  const { companyId } = await createCompany({ companyName: 'Acme Fintech', name: 'Meera Iyer', email: PERSONAS.E1003, password: PASSWORD, title: 'HR Business Partner' });
  await updateSettings(companyId, { contacts: { hr: PERSONAS.E1003, ic: `ic@${DOMAIN}`, eap: '1800-000-0000 (24x7, confidential)', ethics: `ethics@${DOMAIN}` } });

  const people = [];
  const used = new Set(['Meera Iyer']);
  const mkName = () => { let n; do n = `${pick(FIRST)} ${pick(LAST)}`; while (used.has(n)); used.add(n); return n; };
  const personas = [
    ['E1001', 'Riya Sharma', 'F', 'Engineering', 'Software Engineer', 'Bengaluru', 'E1002', '2023-07-10'],
    ['E1002', 'Arjun Mehta', 'M', 'Engineering', 'Engineering Manager', 'Bengaluru', null, '2019-03-04'],
    ['E1004', 'Kabir Khan', 'M', 'Data Science', 'Data Analyst', 'Mumbai', null, '2024-01-15'],
  ];
  for (const [key, name, g, dept, role, loc, mgr, jd] of personas) { used.add(name); people.push({ key, name, g, dept, role, lvl: LEVEL_OF(role), loc, mgr, jd, status: 'Active' }); }
  const deptPool = Object.entries(DEPT_WEIGHT).flatMap(([d, w]) => Array(w).fill(d));
  const managers = { Engineering: ['E1002'] };
  let n = 1005;
  const today = new Date('2026-10-13');
  const exitReasons = ['Better compensation', 'Career growth', 'Relocation', 'Higher studies', 'Manager relationship', 'Work-life balance'];
  for (let i = 0; i < 520; i++) {
    const dept = pick(deptPool); const role = pick(DEPTS[dept]); const lvl = LEVEL_OF(role);
    const join = new Date(2018, 0, 1); join.setDate(join.getDate() + between(0, 3150));
    if (join > today) join.setTime(today.getTime() - between(30, 400) * 864e5);
    const p = { key: `E${n++}`, name: mkName(), g: rand() < 0.42 ? 'F' : 'M', dept, role, lvl, loc: pick(LOCATIONS), jd: iso(join), status: 'Active' };
    const churnP = { 'Customer Support': 0.32, Sales: 0.28 }[dept] ?? 0.14;
    if (rand() < churnP) { const ex = new Date(join.getTime() + between(120, 1400) * 864e5); if (ex < today) { p.status = 'Exited'; p.exit = iso(ex); p.reason = pick(exitReasons); } }
    if (lvl === 'L4' && p.status === 'Active') (managers[dept] ||= []).push(p.key);
    people.push(p);
  }
  const email = (p) => PERSONAS[p.key] || `${p.name.toLowerCase().replace(' ', '.')}@${DOMAIN}`;
  const rows = [];
  for (const p of people) {
    if (p.mgr === undefined) { const pool = (managers[p.dept] || []).filter((m) => m !== p.key); p.mgr = pool.length ? pick(pool) : null; }
    if (p.key === 'E1004') p.mgr = managers['Data Science']?.[0] ?? null;
    const sal = +(BASE_SALARY[p.lvl] * (0.8 + rand() * 0.5) * ({ Engineering: 1.25, 'Data Science': 1.2, Product: 1.2, 'Customer Support': 0.7 }[p.dept] ?? 1)).toFixed(1);
    const perf = Math.min(5, Math.max(1, Math.round(2.4 + rand() * 2.6)));
    let eng = between(45, 95); if (p.status === 'Exited') eng = between(30, 70); if (p.loc === 'Remote') eng = Math.min(100, eng + 5);
    const access = p.key === 'E1002' || p.lvl === 'L4' ? 'manager' : 'employee';
    rows.push([companyId, email(p), p.name, access, PERSONAS[p.key] ? hash : null, p.dept, p.role, p.lvl, p.loc, p.jd, p.status, p.exit ?? null, p.reason ?? null, p.g, sal, perf, eng]);
  }
  await insertMany('people', ['company_id', 'email', 'name', 'access', 'password_hash', 'department', 'title', 'level', 'location', 'join_date', 'status', 'exit_date', 'exit_reason', 'gender', 'salary_lpa', 'performance_rating', 'engagement_score'], rows);
  const ids = Object.fromEntries((await query('SELECT id, email FROM people WHERE company_id = $1', [companyId])).map((r) => [r.email, r.id]));
  const idOf = (key) => ids[email(people.find((p) => p.key === key))];
  for (const p of people) if (p.mgr) await query('UPDATE people SET manager_id = $2 WHERE id = $1', [ids[email(p)], idOf(p.mgr)]);
  // Meera (HR admin, created by signup) keeps her own balances; everyone else gets random ones
  const bal = [], reqs = [];
  for (const p of people.filter((x) => x.status === 'Active')) {
    const id = ids[email(p)];
    bal.push([id, companyId, 'Earned', between(4, 18)], [id, companyId, 'Sick', between(2, 8)], [id, companyId, 'Casual', between(1, 6)]);
    for (let k = 0; k < between(0, 4); k++) {
      const st = new Date(2026, between(0, 8), between(1, 26)); const d = between(1, 3); const en = new Date(st.getTime() + (d - 1) * 864e5);
      reqs.push([companyId, id, pick(['Earned', 'Sick', 'Casual']), iso(st), iso(en), d, pick(['Family function', 'Fever', 'Travel', 'Personal work']), 'Approved', iso(st)]);
    }
  }
  await insertMany('leave_balances', ['person_id', 'company_id', 'leave_type', 'balance'], bal);
  await query(`UPDATE leave_balances SET balance = 12 WHERE person_id = $1 AND leave_type = 'Earned'`, [ids[PERSONAS.E1001]]);
  await insertMany('leave_requests', ['company_id', 'person_id', 'leave_type', 'start_date', 'end_date', 'days', 'reason', 'status', 'created_at'], reqs);
  const cats = { IT: ['Laptop running slow', 'VPN not connecting', 'Need software access'], Payroll: ['Salary slip mismatch', 'Tax declaration query', 'Reimbursement pending'], Benefits: ['Insurance card not received', 'Add dependent to insurance'], Facilities: ['Access card not working', 'Desk change request'], 'HR Query': ['Experience letter request', 'Policy clarification'] };
  const active = people.filter((x) => x.status === 'Active');
  const tix = [];
  for (let i = 0; i < 380; i++) {
    const p = pick(active); const cat = pick(Object.keys(cats));
    const c = new Date(2026, between(0, 9), between(1, 28)); if (c > today) c.setTime(today.getTime() - between(1, 20) * 864e5);
    const open = rand() < 0.22; const r = new Date(c.getTime() + between(1, cat === 'Payroll' ? 9 : 5) * 864e5);
    tix.push([companyId, ids[email(p)], cat, pick(cats[cat]), pick(['Low', 'Medium', 'Medium', 'High']), open ? 'Open' : 'Resolved', iso(c), open ? null : iso(r)]);
  }
  await insertMany('tickets', ['company_id', 'person_id', 'category', 'description', 'priority', 'status', 'created_at', 'resolved_at'], tix);
  const dir = fileURLToPath(new URL('./policies', import.meta.url));
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.md'))) {
    const text = readFileSync(`${dir}/${f}`, 'utf8');
    await addPolicy(companyId, ids[PERSONAS.E1003], { title: text.match(/^# (.+)$/m)[1], filename: f, text });
  }

  // ---- Globex: a second tenant with its own secret policy and salaries, to test isolation ----
  const g = await createCompany({ companyName: 'Globex Corp', name: 'Gita Admin', email: 'gita@globex.test', password: PASSWORD });
  await insertMany('people', ['company_id', 'email', 'name', 'access', 'department', 'title', 'salary_lpa', 'join_date'], [
    [g.companyId, 'zed@globex.test', 'Zed Globexman', 'employee', 'Secret Lab', 'Physicist', 999, '2022-01-01'],
    [g.companyId, 'yara@globex.test', 'Yara Globex', 'employee', 'Secret Lab', 'Chemist', 888, '2023-01-01'],
  ]);
  await addPolicy(g.companyId, g.personId, { title: 'Globex Unicorn Policy', filename: 'unicorn.md', text: '# Globex Unicorn Policy\n\n## Unicorn allowance\nEvery Globex employee receives a unicorn allowance of Rs 77,777 per year for pet unicorns.' });

  return { acme: companyId, globex: g.companyId, personas: PERSONAS, password: PASSWORD };
}
