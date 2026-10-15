// Policy documents: upload (PDF / DOCX / TXT / MD) → text → sections → BM25 index per company.
import { query, one, tx } from '../db/pg.js';
import { BM25, tokenize } from '../lib/bm25.js';
import { bump, version } from '../lib/versions.js';
import { UserError } from './company.js';

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_CHARS = 400_000;

/** Extracts plain text from an uploaded file. */
export async function extractText(filename, buffer) {
  const ext = (filename.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
  if (buffer.length > MAX_BYTES) throw new UserError('File is larger than 8 MB.');
  if (ext === 'pdf') {
    const { extractText: pdfText, getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const { text } = await pdfText(pdf, { mergePages: false });
    const pages = Array.isArray(text) ? text : [text];
    const joined = pages.join('\n\n');
    if (joined.replace(/\s/g, '').length < 50) throw new UserError('This PDF has no selectable text (it may be a scanned image). Upload a text PDF or DOCX.');
    return joined;
  }
  if (ext === 'docx') {
    const mammoth = (await import('mammoth')).default;
    const { value } = await mammoth.extractRawText({ buffer });
    return value;
  }
  if (['txt', 'md', 'markdown'].includes(ext)) return buffer.toString('utf8');
  throw new UserError('Upload a PDF, DOCX, TXT or MD file.');
}

const isHeading = (line) => {
  const l = line.trim();
  if (!l || l.length > 90) return false;
  if (/^#{1,6}\s+\S/.test(l)) return true;                            // markdown
  if (/^(\d+(\.\d+)*[.)]?|[A-Z][.)]|section \d+|clause \d+)\s+[A-Za-z]/i.test(l) && !/[.:;,]$/.test(l) && l.split(' ').length <= 12) return true; // 1. Leave / 2.3 Sick leave
  if (/^[A-Z0-9 &/,'()-]{4,}$/.test(l) && /[A-Z]{3}/.test(l)) return true; // ALL CAPS
  if (l.split(' ').length <= 8 && !/[.,;:!?]$/.test(l) && /^[A-Z]/.test(l) && l === l.replace(/\s+/g, ' ')) return /\b(policy|leave|benefit|allowance|code|conduct|insurance|holiday|work|travel|reimburse|grievance|harassment|posh|notice|probation|attendance|hours|salary|payroll|bonus|exit|resignation|termination|appraisal|performance|training|expense|security|privacy|overview|introduction|scope|purpose|eligibility|procedure|process)\b/i.test(l);
  return false;
};

/** Splits text into sections (heading + body), then caps section size for retrieval quality. */
export function chunkText(text, title) {
  const lines = text.replace(/\r/g, '').replace(/ /g, ' ').split('\n');
  const sections = [];
  let cur = { heading: title, body: [] };
  for (const line of lines) {
    if (isHeading(line)) {
      if (cur.body.join(' ').trim()) sections.push(cur);
      cur = { heading: line.trim().replace(/^#+\s*/, '').replace(/\s+/g, ' ').slice(0, 90), body: [] };
    } else cur.body.push(line);
  }
  if (cur.body.join(' ').trim()) sections.push(cur);
  const chunks = [];
  for (const s of sections) {
    const body = s.body.join('\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    if (body.length <= 1400) { chunks.push({ heading: s.heading, text: body }); continue; }
    // long section → ~1000-char pieces on paragraph / sentence boundaries
    const parts = body.split(/\n\n+|(?<=[.!?])\s+(?=[A-Z])/);
    let buf = '', n = 1;
    for (const part of parts) {
      if ((buf + ' ' + part).length > 1000 && buf) { chunks.push({ heading: `${s.heading} (part ${n++})`, text: buf.trim() }); buf = ''; }
      buf += (buf ? ' ' : '') + part;
    }
    if (buf.trim()) chunks.push({ heading: n > 1 ? `${s.heading} (part ${n})` : s.heading, text: buf.trim() });
  }
  return chunks.filter((c) => c.text.length >= 20);
}

export async function addPolicy(companyId, personId, { title, filename, buffer, text }) {
  let raw = text;
  if (buffer) raw = await extractText(filename || 'file.txt', buffer);
  raw = String(raw || '').slice(0, MAX_CHARS);
  if (raw.replace(/\s/g, '').length < 30) throw new UserError('The document looks empty.');
  title = String(title || filename?.replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ') || 'Policy').trim().slice(0, 120);
  const chunks = chunkText(raw, title);
  if (!chunks.length) throw new UserError('Could not find any readable sections in this document.');
  const docId = await tx(async (t) => {
    const [d] = await t.query('INSERT INTO policy_docs (company_id, title, filename, chars, uploaded_by) VALUES ($1,$2,$3,$4,$5) RETURNING id', [companyId, title, filename || null, raw.length, personId]);
    for (const [i, c] of chunks.entries()) {
      await t.query('INSERT INTO policy_chunks (doc_id, company_id, ord, heading, text) VALUES ($1,$2,$3,$4,$5)', [d.id, companyId, i, c.heading, c.text]);
    }
    return d.id;
  });
  bump(companyId);
  return { id: docId, title, sections: chunks.length, chars: raw.length };
}

export async function listPolicies(companyId) {
  return query(`SELECT d.id, d.title, d.filename, d.chars, d.created_at, p.name AS uploaded_by,
                       (SELECT count(*) FROM policy_chunks c WHERE c.doc_id = d.id)::int AS sections
                FROM policy_docs d LEFT JOIN people p ON p.id = d.uploaded_by
                WHERE d.company_id = $1 ORDER BY d.created_at DESC`, [companyId]);
}

export async function getPolicy(companyId, docId) {
  const d = await one('SELECT id, title, filename, created_at FROM policy_docs WHERE id = $1 AND company_id = $2', [docId, companyId]);
  if (!d) throw new UserError('Policy not found.', 404);
  d.sections = await query('SELECT ord, heading, text FROM policy_chunks WHERE doc_id = $1 ORDER BY ord', [docId]);
  return d;
}

export async function deletePolicy(companyId, docId) {
  const r = await query('DELETE FROM policy_docs WHERE id = $1 AND company_id = $2 RETURNING id', [docId, companyId]);
  if (!r.length) throw new UserError('Policy not found.', 404);
  bump(companyId);
}

// ---------------- per-company search index (cached until the company's data changes) ----------------
const indexes = new Map();
export async function policyIndexFor(companyId) {
  const v = version(companyId);
  const hit = indexes.get(companyId);
  if (hit && hit.v === v) return hit.index;
  const rows = await query(`SELECT c.doc_id, c.ord, c.heading, c.text, d.title AS doc
                            FROM policy_chunks c JOIN policy_docs d ON d.id = c.doc_id
                            WHERE c.company_id = $1 ORDER BY d.created_at, c.ord`, [companyId]);
  const chunks = rows.map((r) => ({
    id: `${r.doc_id.slice(0, 8)}#${r.ord}`, doc: r.doc, heading: r.heading, text: r.text,
    tokens: tokenize(`${r.doc} ${r.heading} ${r.heading} ${r.text}`),
  }));
  const index = new BM25(chunks);
  indexes.set(companyId, { v, index });
  return index;
}
