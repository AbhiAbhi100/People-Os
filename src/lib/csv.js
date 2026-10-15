// Minimal RFC-4180 CSV parser (quotes, escaped quotes, commas/newlines inside quotes, BOM).
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  const s = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((v) => v.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((v) => v.trim() !== '')) rows.push(row);
  return rows;
}

const HEADER_ALIASES = {
  name: ['name', 'full name', 'employee name'],
  email: ['email', 'email id', 'work email', 'e-mail', 'mail'],
  title: ['title', 'job title', 'designation', 'role', 'position'],
  department: ['department', 'dept', 'team', 'function'],
  level: ['level', 'grade', 'band'],
  location: ['location', 'city', 'office', 'base location'],
  manager_email: ['manager_email', 'manager email', 'reporting manager email', 'manager'],
  join_date: ['join_date', 'joining date', 'date of joining', 'doj', 'start date'],
  gender: ['gender', 'sex'],
  access: ['access', 'access level', 'permission'],
  salary_lpa: ['salary_lpa', 'salary (lpa)', 'ctc (lpa)', 'ctc lpa', 'salary'],
  performance_rating: ['performance_rating', 'rating', 'performance'],
  engagement_score: ['engagement_score', 'engagement'],
};

/** CSV text → array of person objects keyed by our field names (header names are forgiving). */
export function csvToPeople(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) return { people: [], unknown: [], error: 'The CSV needs a header row and at least one person.' };
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const map = header.map((h) => Object.entries(HEADER_ALIASES).find(([, al]) => al.includes(h))?.[0] ?? null);
  if (!map.includes('name') || !map.includes('email')) return { people: [], unknown: [], error: 'The CSV must have "name" and "email" columns.' };
  const people = rows.slice(1).map((r) => Object.fromEntries(map.map((k, i) => [k, (r[i] ?? '').trim()]).filter(([k]) => k)));
  return { people, unknown: header.filter((_, i) => !map[i]) };
}

export const CSV_TEMPLATE = 'name,email,title,department,level,location,manager_email,join_date,access\n' +
  'Asha Rao,asha@yourcompany.com,Engineering Manager,Engineering,L4,Bengaluru,,2021-04-01,manager\n' +
  'Vikram Singh,vikram@yourcompany.com,Software Engineer,Engineering,L2,Bengaluru,asha@yourcompany.com,2024-07-15,employee\n';
