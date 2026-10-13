// Generates a realistic, fully synthetic HR dataset (no real people).
// Deterministic RNG so every run (and every eval) sees the same data.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { DB_PATH } from './path.js';

let s = 42;
const rand = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = (a) => a[Math.floor(rand() * a.length)];
const between = (a, b) => a + Math.floor(rand() * (b - a + 1));
const iso = (d) => d.toISOString().slice(0, 10);

const FIRST = ['Aarav','Riya','Arjun','Meera','Kabir','Ananya','Vihaan','Isha','Rohan','Diya','Aditya','Sneha','Karan','Pooja','Yash','Nisha','Rahul','Tanvi','Siddharth','Kavya','Manav','Priya','Dev','Neha','Aman','Shreya','Varun','Aditi','Nikhil','Simran','Harsh','Zoya','Ishaan','Lavanya','Pranav','Ritika','Omkar','Sana','Tushar','Bhavna'];
const LAST = ['Sharma','Verma','Iyer','Nair','Patel','Gupta','Reddy','Singh','Joshi','Mehta','Kulkarni','Das','Bose','Khan','Rao','Pillai','Chopra','Agarwal','Menon','Saxena'];

// department -> roles (role, level band)
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

export function seed(path = DB_PATH) {
  s = 42;
  mkdirSync(new URL('../../data', import.meta.url), { recursive: true });
  if (existsSync(path)) rmSync(path);
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE employees (
      employee_id TEXT PRIMARY KEY, name TEXT, email TEXT, gender TEXT,
      department TEXT, role TEXT, level TEXT, location TEXT, manager_id TEXT,
      join_date TEXT, status TEXT, exit_date TEXT, exit_reason TEXT,
      salary_lpa REAL, performance_rating INTEGER, engagement_score INTEGER
    );
    CREATE TABLE leave_balances (employee_id TEXT, leave_type TEXT, balance REAL, PRIMARY KEY(employee_id, leave_type));
    CREATE TABLE leave_requests (
      request_id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id TEXT, leave_type TEXT,
      start_date TEXT, end_date TEXT, days REAL, reason TEXT, status TEXT, created_at TEXT
    );
    CREATE TABLE tickets (
      ticket_id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id TEXT, category TEXT,
      description TEXT, priority TEXT, status TEXT, created_at TEXT, resolved_at TEXT
    );
    CREATE TABLE role_tasks (
      role TEXT, task TEXT, hours_per_week REAL,
      repetitive REAL, rules_based REAL, data_heavy REAL, judgment REAL, empathy REAL, skill TEXT
    );
  `);

  const insEmp = db.prepare(`INSERT INTO employees VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const people = [];
  const used = new Set();
  const mkName = () => { let n; do n = `${pick(FIRST)} ${pick(LAST)}`; while (used.has(n)); used.add(n); return n; };

  // Fixed demo personas (used by the UI persona switcher)
  const personas = [
    ['E1001', 'Riya Sharma', 'F', 'Engineering', 'Software Engineer', 'Bengaluru', 'E1002', '2023-07-10'],
    ['E1002', 'Arjun Mehta', 'M', 'Engineering', 'Engineering Manager', 'Bengaluru', null, '2019-03-04'],
    ['E1003', 'Meera Iyer', 'F', 'HR', 'HR Business Partner', 'Mumbai', null, '2018-11-19'],
    ['E1004', 'Kabir Khan', 'M', 'Data Science', 'Data Analyst', 'Mumbai', null, '2024-01-15'],
  ];
  for (const [id, name, g, dept, role, loc, mgr, jd] of personas) {
    used.add(name);
    const lvl = LEVEL_OF(role);
    people.push({ id, name, g, dept, role, lvl, loc, mgr, jd, status: 'Active' });
  }

  const deptPool = Object.entries(DEPT_WEIGHT).flatMap(([d, w]) => Array(w).fill(d));
  const managers = {}; // dept -> manager ids
  managers.Engineering = ['E1002']; managers.HR = ['E1003'];
  let n = 1005;
  const today = new Date('2026-10-13');
  const exitReasons = ['Better compensation', 'Career growth', 'Relocation', 'Higher studies', 'Manager relationship', 'Work-life balance'];
  for (let i = 0; i < 520; i++) {
    const dept = pick(deptPool);
    const role = pick(DEPTS[dept]);
    const lvl = LEVEL_OF(role);
    const join = new Date(2018, 0, 1); join.setDate(join.getDate() + between(0, 3150));
    if (join > today) join.setTime(today.getTime() - between(30, 400) * 864e5);
    const id = `E${n++}`;
    const p = { id, name: mkName(), g: rand() < 0.42 ? 'F' : 'M', dept, role, lvl, loc: pick(LOCATIONS), jd: iso(join), status: 'Active' };
    // attrition: support & sales churn more; low engagement churns more
    const churnP = { 'Customer Support': 0.32, Sales: 0.28 }[dept] ?? 0.14;
    if (rand() < churnP) {
      const ex = new Date(join.getTime() + between(120, 1400) * 864e5);
      if (ex < today) { p.status = 'Exited'; p.exit = iso(ex); p.reason = pick(exitReasons); }
    }
    if (lvl === 'L4' && p.status === 'Active') (managers[dept] ||= []).push(id);
    people.push(p);
  }
  for (const p of people) {
    if (p.mgr === undefined) {
      const pool = (managers[p.dept] || []).filter((m) => m !== p.id);
      p.mgr = pool.length ? pick(pool) : null;
    }
    if (p.id === 'E1004') p.mgr = managers['Data Science']?.[0] ?? null;
    const sal = +(BASE_SALARY[p.lvl] * (0.8 + rand() * 0.5) * ({ Engineering: 1.25, 'Data Science': 1.2, Product: 1.2, 'Customer Support': 0.7 }[p.dept] ?? 1)).toFixed(1);
    const perf = Math.min(5, Math.max(1, Math.round(2.4 + rand() * 2.6)));
    let eng = between(45, 95);
    if (p.status === 'Exited') eng = between(30, 70);
    if (p.loc === 'Remote') eng = Math.min(100, eng + 5);
    const [first, last] = p.name.toLowerCase().split(' ');
    insEmp.run(p.id, p.name, `${first}.${last}@peopleos.demo`, p.g, p.dept, p.role, p.lvl, p.loc, p.mgr ?? null,
      p.jd, p.status, p.exit ?? null, p.reason ?? null, sal, perf, eng);
  }

  const insBal = db.prepare(`INSERT INTO leave_balances VALUES (?,?,?)`);
  const insReq = db.prepare(`INSERT INTO leave_requests (employee_id, leave_type, start_date, end_date, days, reason, status, created_at) VALUES (?,?,?,?,?,?,?,?)`);
  for (const p of people.filter((x) => x.status === 'Active')) {
    insBal.run(p.id, 'Earned', between(4, 18));
    insBal.run(p.id, 'Sick', between(2, 8));
    insBal.run(p.id, 'Casual', between(1, 6));
    for (let k = 0; k < between(0, 4); k++) {
      const st = new Date(2026, between(0, 8), between(1, 26));
      const d = between(1, 3);
      const en = new Date(st.getTime() + (d - 1) * 864e5);
      insReq.run(p.id, pick(['Earned', 'Sick', 'Casual']), iso(st), iso(en), d, pick(['Family function', 'Fever', 'Travel', 'Personal work']), 'Approved', iso(st));
    }
  }

  const insT = db.prepare(`INSERT INTO tickets (employee_id, category, description, priority, status, created_at, resolved_at) VALUES (?,?,?,?,?,?,?)`);
  const cats = { IT: ['Laptop running slow', 'VPN not connecting', 'Need software access'], Payroll: ['Salary slip mismatch', 'Tax declaration query', 'Reimbursement pending'], Benefits: ['Insurance card not received', 'Add dependent to insurance'], Facilities: ['Access card not working', 'Desk change request'], 'HR Query': ['Experience letter request', 'Policy clarification'] };
  for (let i = 0; i < 380; i++) {
    const p = pick(people.filter((x) => x.status === 'Active'));
    const cat = pick(Object.keys(cats));
    const c = new Date(2026, between(0, 9), between(1, 28));
    if (c > today) c.setTime(today.getTime() - between(1, 20) * 864e5);
    const open = rand() < 0.22;
    const r = new Date(c.getTime() + between(1, cat === 'Payroll' ? 9 : 5) * 864e5);
    insT.run(p.id, cat, pick(cats[cat]), pick(['Low', 'Medium', 'Medium', 'High']), open ? 'Open' : 'Resolved', iso(c), open ? null : iso(r));
  }

  // Task model for the career/automation engine.
  // attrs: repetitive, rules_based, data_heavy, judgment, empathy (0..1)
  const T = (role, task, h, rep, rule, data, judg, emp, skill) => [role, task, h, rep, rule, data, judg, emp, skill];
  const tasks = [
    T('Software Engineer', 'Write boilerplate/CRUD code', 8, .8, .7, .3, .3, 0, 'System design'),
    T('Software Engineer', 'Write unit tests', 5, .8, .8, .3, .2, 0, 'Test strategy'),
    T('Software Engineer', 'Debug production issues', 6, .3, .3, .6, .8, .1, 'Observability'),
    T('Software Engineer', 'Design new features with PM', 5, .1, .1, .3, .9, .4, 'Product thinking'),
    T('Software Engineer', 'Code reviews', 4, .5, .5, .3, .7, .3, 'Technical leadership'),
    T('Software Engineer', 'Write docs & PR descriptions', 3, .7, .6, .2, .2, .1, 'Technical writing'),
    T('Software Engineer', 'Standups & sprint rituals', 4, .6, .5, .1, .3, .6, 'Communication'),
    T('Engineering Manager', '1:1s and coaching', 8, .2, .1, .1, .8, 1, 'Coaching'),
    T('Engineering Manager', 'Hiring interviews', 5, .4, .4, .3, .9, .6, 'Talent assessment'),
    T('Engineering Manager', 'Status reports for leadership', 4, .9, .7, .7, .2, 0, 'Strategic narrative'),
    T('Engineering Manager', 'Sprint planning & estimation', 5, .5, .4, .6, .7, .3, 'Delivery management'),
    T('Engineering Manager', 'Architecture decisions', 6, .1, .2, .4, 1, .2, 'Architecture'),
    T('Engineering Manager', 'Performance reviews', 3, .3, .3, .5, .9, .9, 'Feedback'),
    T('Data Analyst', 'Write SQL for ad-hoc requests', 10, .8, .7, 1, .3, 0, 'Data modelling'),
    T('Data Analyst', 'Build & refresh dashboards', 8, .9, .8, 1, .2, 0, 'Metric design'),
    T('Data Analyst', 'Clean and validate data', 6, .9, .9, 1, .2, 0, 'Data quality engineering'),
    T('Data Analyst', 'Present insights to stakeholders', 4, .1, .1, .5, .8, .7, 'Storytelling'),
    T('Data Analyst', 'Define business metrics with teams', 4, .2, .2, .6, .9, .5, 'Business acumen'),
    T('Data Analyst', 'Root-cause analysis on metric drops', 5, .3, .3, .9, .9, .1, 'Causal inference'),
    T('Support Associate', 'Answer repetitive customer queries', 18, 1, .9, .3, .2, .5, 'Product expertise'),
    T('Support Associate', 'Update ticket notes & tags', 6, 1, 1, .4, .1, 0, 'Process design'),
    T('Support Associate', 'Handle escalated/angry customers', 8, .3, .2, .2, .7, 1, 'De-escalation'),
    T('Support Associate', 'Identify recurring product bugs', 3, .4, .3, .6, .7, .1, 'Product feedback loops'),
    T('Support Associate', 'KYC document checks', 5, .9, 1, .5, .3, 0, 'Risk & compliance'),
    T('HR Business Partner', 'Answer policy questions', 8, .9, .9, .2, .2, .4, 'Policy design'),
    T('HR Business Partner', 'Employee relations cases', 6, .1, .2, .2, 1, 1, 'Conflict resolution'),
    T('HR Business Partner', 'Attrition & headcount reports', 5, .8, .7, 1, .3, 0, 'People analytics'),
    T('HR Business Partner', 'Org design with leaders', 5, .1, .1, .5, 1, .6, 'Org design'),
    T('HR Business Partner', 'Onboarding coordination', 4, .8, .8, .3, .2, .5, 'Experience design'),
    T('HR Business Partner', 'Performance cycle calibration', 4, .3, .4, .6, .9, .7, 'Talent management'),
    T('Relationship Manager', 'Client portfolio review calls', 10, .3, .3, .5, .7, .9, 'Advisory skills'),
    T('Relationship Manager', 'Prepare client reports', 6, .9, .8, .9, .2, 0, 'Financial analysis'),
    T('Relationship Manager', 'CRM data entry', 5, 1, 1, .4, .1, 0, 'Pipeline strategy'),
    T('Relationship Manager', 'Onboard new clients', 6, .5, .6, .4, .5, .8, 'Consultative selling'),
    T('Compliance Analyst', 'Transaction monitoring alerts', 12, .9, .9, 1, .4, 0, 'Risk modelling'),
    T('Compliance Analyst', 'Regulatory circular review', 6, .3, .5, .4, .9, 0, 'Regulatory interpretation'),
    T('Compliance Analyst', 'Audit evidence preparation', 6, .8, .9, .6, .3, 0, 'Audit strategy'),
    T('Compliance Analyst', 'Advise business on new products', 4, .1, .3, .3, 1, .5, 'Stakeholder advisory'),
  ];
  const insTask = db.prepare(`INSERT INTO role_tasks VALUES (?,?,?,?,?,?,?,?,?)`);
  for (const t of tasks) insTask.run(...t);

  // Every persona gets a non-empty leave record to make demos predictable
  db.prepare(`UPDATE leave_balances SET balance = 12 WHERE employee_id='E1001' AND leave_type='Earned'`).run();
  db.close();
  return { employees: people.length, tasks: tasks.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = seed();
  console.log(`Seeded ${r.employees} employees, ${r.tasks} role tasks → ${DB_PATH}`);
}
