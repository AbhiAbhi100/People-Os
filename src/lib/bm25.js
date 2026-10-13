// Tiny BM25 retriever over markdown policies, chunked by "##" section.
// No vector DB needed: for a few hundred chunks BM25 is fast, explainable and strong.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DIR = fileURLToPath(new URL('../../data/policies', import.meta.url));
const STOP = new Set('a an the of to and or for in on at is are be can i my me we our you your it this that with by as from do does how what when which who much many get have has will should without about any there need'.split(' '));
const SYN = { wfh: 'work from home', leaves: 'leave', holiday: 'leave', vacation: 'earned leave', sick: 'sick', maternity: 'parental', paternity: 'parental', harassment: 'posh harassment', claim: 'reimbursement claim', reimburse: 'reimbursement', insurance: 'insurance medical', mediclaim: 'insurance medical', course: 'learning certification', certification: 'learning certification', wifi: 'internet', broadband: 'internet', esop: 'stock options', remote: 'remote home' };

export const tokenize = (t) =>
  t.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .map((w) => w.replace(/(ies)$/, 'y').replace(/(?<=[a-z]{3})s$/, ''))
    .flatMap((w) => (SYN[w] ? SYN[w].split(' ') : [w]))
    .filter((w) => w && !STOP.has(w));

export function loadChunks() {
  const chunks = [];
  for (const file of readdirSync(DIR).filter((f) => f.endsWith('.md'))) {
    const md = readFileSync(`${DIR}/${file}`, 'utf8');
    const doc = md.match(/^# (.+)$/m)?.[1] ?? file;
    for (const part of md.split(/^## /m).slice(1)) {
      const [heading, ...body] = part.split('\n');
      const text = body.join(' ').trim();
      chunks.push({ id: `${file.replace('.md', '')}#${heading.toLowerCase().replace(/\W+/g, '-')}`, doc, heading, text, tokens: tokenize(`${heading} ${heading} ${text}`) });
    }
  }
  return chunks;
}

export class BM25 {
  constructor(chunks, k1 = 1.4, b = 0.75) {
    Object.assign(this, { chunks, k1, b });
    this.avg = chunks.reduce((s, c) => s + c.tokens.length, 0) / chunks.length;
    this.df = new Map();
    for (const c of chunks) for (const t of new Set(c.tokens)) this.df.set(t, (this.df.get(t) || 0) + 1);
  }
  search(query, k = 4) {
    const q = [...new Set(tokenize(query))];
    const N = this.chunks.length;
    return this.chunks.map((c) => {
      let score = 0;
      const tf = new Map();
      for (const t of c.tokens) tf.set(t, (tf.get(t) || 0) + 1);
      for (const t of q) {
        const f = tf.get(t); if (!f) continue;
        const idf = Math.log(1 + (N - this.df.get(t) + 0.5) / (this.df.get(t) + 0.5));
        score += idf * (f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + this.b * c.tokens.length / this.avg));
      }
      return { ...c, score: +score.toFixed(3) };
    }).filter((c) => c.score > 0).sort((a, b) => b.score - a.score).slice(0, k);
  }
}

export const policyIndex = new BM25(loadChunks());
