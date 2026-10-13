// Natural-language date helpers (used by tools + offline mode).
export const TODAY = () => new Date(process.env.PEOPLEOS_TODAY || '2026-10-13T00:00:00');
export const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export function businessDays(start, end) {
  let n = 0;
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) if (d.getDay() % 6 !== 0) n++;
  return n;
}
export const parseISO = (s) => new Date(`${s}T00:00:00`);

/** Extracts {start, end} from text like "next friday", "tomorrow for 2 days", "20 oct to 22 oct", "2026-11-03". */
export function parseDateRange(text) {
  const t = text.toLowerCase();
  const base = TODAY();
  const found = [];
  for (const m of t.matchAll(/\b(\d{4}-\d{2}-\d{2})\b/g)) found.push(parseISO(m[1]));
  for (const m of t.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/g)) {
    const d = new Date(base.getFullYear(), MONTHS.indexOf(m[2]), +m[1]);
    if (d < base) d.setFullYear(d.getFullYear() + 1);
    found.push(d);
  }
  if (/\bday after tomorrow\b|\bparso\b/.test(t)) found.push(new Date(base.getTime() + 2 * 864e5));
  else if (/\btomorrow\b|\bkal\b/.test(t)) found.push(new Date(base.getTime() + 864e5));
  for (const m of t.matchAll(/\b(next|this|coming)?\s*(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/g)) {
    const target = DAYS.indexOf(m[2]);
    const d = new Date(base);
    // "next friday" = the upcoming friday (how most people use it in Indian English)
    const add = (target - d.getDay() + 7) % 7 || 7;
    d.setDate(d.getDate() + add);
    found.push(d);
  }
  if (!found.length) return null;
  found.sort((a, b) => a - b);
  let start = found[0], end = found[found.length - 1];
  const n = t.match(/\b(\d+)\s*(days?|din)\b/);
  if (n && found.length === 1) {
    end = new Date(start);
    let left = +n[1] - 1;
    while (left > 0) { end.setDate(end.getDate() + 1); if (end.getDay() % 6 !== 0) left--; }
  }
  return { start: iso(start), end: iso(end) };
}
