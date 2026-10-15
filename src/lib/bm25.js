// Tiny BM25 retriever over policy sections (one index per company, see services/policies.js).
// No vector DB needed: for a few hundred chunks BM25 is fast, explainable and strong.
const STOP = new Set('a an the of to and or for in on at is are be can i my me we our you your it this that with by as from do does how what when which who much many get have has will should without about any there need kitne kitni kitna ki ka ke hai hain kya mujhe mera meri mere kaise kab milti milta milegi kar sakta sakti chahiye ho hota hoti se par aur bhi'.split(' '));
const SYN = { din: 'day', chutti: 'leave', chhutti: 'leave', ghar: 'home', wfh: 'work from home', leaves: 'leave', holiday: 'leave', vacation: 'earned leave', sick: 'sick', maternity: 'parental', paternity: 'parental', harassment: 'posh harassment', claim: 'reimbursement claim', reimburse: 'reimbursement', insurance: 'insurance medical', mediclaim: 'insurance medical', course: 'learning certification', certification: 'learning certification', wifi: 'internet', broadband: 'internet', esop: 'stock options', remote: 'remote home', abroad: 'outside india', overseas: 'outside india', international: 'outside india', foreign: 'outside india', dubai: 'outside india', usa: 'outside india', london: 'outside india', singapore: 'outside india' };

export const tokenize = (t) =>
  t.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .map((w) => w.replace(/(ies)$/, 'y').replace(/(?<=[a-z]{3})s$/, ''))
    .flatMap((w) => (SYN[w] ? SYN[w].split(' ') : [w]))
    .filter((w) => w && !STOP.has(w));

export class BM25 {
  constructor(chunks, k1 = 1.4, b = 0.75) {
    Object.assign(this, { chunks, k1, b });
    this.avg = chunks.length ? chunks.reduce((s, c) => s + c.tokens.length, 0) / chunks.length : 1;
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

