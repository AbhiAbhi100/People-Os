// Policy Agent: grounded Q&A over HR policies (RAG) with citations.
// Retrieval = LangChain retriever (BM25 under the hood). Generation = an LCEL chain:
//   ChatPromptTemplate | chatModel.withStructuredOutput(zod)  → { answer, answerable, used_ids }
// Refuses to guess: if retrieval is weak or the answer isn't in the sources, it says so
// and the orchestrator offers a human handoff.
import { z } from 'zod';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import { retrieverFor, formatDocs } from '../lib/retriever.js';
import { policyIndexFor } from '../services/policies.js';
import { settingsOf } from '../services/company.js';
import { tokenize } from '../lib/bm25.js';
import { isOffline, structuredModel } from '../llm/provider.js';

// BM25 scores shrink when a company has only a few sections, so a fixed cut-off is scaled down for small
// corpora; the answerability check below is what actually stops guessing.
const minScore = (n) => (n < 30 ? 0.5 : 2.5);

const AnswerSchema = z.object({
  answer: z.string().describe('2-5 sentence answer in markdown, with inline citations like [leave-policy#parental-leave]'),
  answerable: z.boolean().describe('false if the sources do not contain the answer'),
  used_ids: z.array(z.string()).describe('ids of the source sections actually used'),
});

const prompt = ChatPromptTemplate.fromMessages([
  ['system', `You are the HR policy assistant for {company}. Answer ONLY from the SOURCES (this company's own policy documents). Be concise and warm.
Cite source ids inline in square brackets, exactly as given. If the sources don't contain the answer, set answerable to false.
Never invent numbers, dates or rules.`],
  ['human', 'SOURCES:\n{context}\n\nQUESTION: {question}'],
]);

let ragChain;
async function getChain() {
  return (ragChain ||= prompt.pipe(await structuredModel(AnswerSchema, 'policy_answer')));
}

const cite = (d) => ({ id: d.metadata.id, title: `${d.metadata.doc} › ${d.metadata.heading}`, snippet: d.pageContent.slice(0, 220) });

/** "leave policy", "wfh policy?" → a short overview of that whole document. */
function overview(query, index) {
  const m = query.toLowerCase().trim().match(/^(?:what(?:'s| is) (?:the |our )?|tell me (?:about )?(?:the )?|explain (?:the )?)?([a-z &/-]{2,30}?)\s+polic(?:y|ies)\??$/);
  if (!m) return null;
  const topic = m[1].replace(/\bwfh\b/, 'work from home').replace(/\bposh\b/, 'harassment');
  const chunks = index.chunks.filter((c) => c.doc.toLowerCase().includes(topic) || topic.split(' ').every((w) => c.doc.toLowerCase().includes(w)));
  if (!chunks.length) return null;
  const doc = chunks[0].doc;
  const text = `**${doc}** covers:\n\n${chunks.filter((c) => c.doc === doc).map((c) => `• **${c.heading}** — ${c.text.split(/(?<=\.)\s/)[0]}`).join('\n')}\n\nAsk me about any of these for the details.`;
  return { agent: 'policy', confidence: 0.9, text, citations: chunks.filter((c) => c.doc === doc).slice(0, 3).map((c) => ({ id: c.id, title: `${c.doc} › ${c.heading}`, snippet: c.text.slice(0, 220) })) };
}

export async function policyAgent({ query, ctx, tracer }) {
  const index = await policyIndexFor(ctx.company.id);
  if (!index.chunks.length) {
    tracer.step('policy', 'tool', 'company has no policy documents yet');
    const hr = settingsOf(ctx.company).contacts.hr;
    return { agent: 'policy', confidence: 0.2, text: `Your HR team hasn't uploaded any policy documents to PeopleOS yet, so I can't answer policy questions reliably.${hr ? ` You can reach HR at **${hr}**.` : ''}` };
  }
  const ov = overview(query, index);
  if (ov) { tracer.step('policy', 'tool', 'overview of the whole policy document'); return ov; }
  const docs = await retrieverFor(ctx.company.id).invoke(query);
  tracer.step('policy', 'tool', `retriever → ${docs.length} sections`, docs.map((d) => `${d.metadata.id} (score ${d.metadata.score})`).join('\n'));

  if (!docs.length || docs[0].metadata.score < minScore(index.chunks.length)) {
    return { agent: 'policy', confidence: 0.2, text: "I couldn't find this in our HR policies, so I won't guess.", citations: [] };
  }

  if (isOffline()) {
    const [top, second] = docs;
    // Answerability check without an LLM: are the specific terms of the question actually in the sources?
    const GENERIC = new Set(['policy', 'leave', 'day', 'take', 'allowed', 'rule', 'company', 'employee', 'work', 'week', 'month', 'year']);
    const terms = [...new Set(tokenize(query))].filter((w) => !GENERIC.has(w) && !/^\d+$/.test(w));
    const covered = new Set(docs.slice(0, 2).flatMap((d) => tokenize(`${d.metadata.doc} ${d.metadata.heading} ${d.pageContent}`)));
    const has = (w) => covered.has(w) || (w.length >= 4 && [...covered].some((c) => c.length >= 4 && (c.startsWith(w.slice(0, 5)) || w.startsWith(c.slice(0, 5)))));
    const missing = terms.filter((w) => !has(w));
    const coverage = terms.length ? 1 - missing.length / terms.length : 1;
    tracer.step('policy', 'check', `answerability: ${Math.round(coverage * 100)}% of key terms found in sources${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`);
    if (coverage <= 0.5) {
      return { agent: 'policy', confidence: 0.25, text: `Our policies don't seem to cover this. The closest section is **${top.metadata.heading}** (${top.metadata.doc}), but it doesn't mention ${missing.map((w) => `"${w}"`).join(', ')}, so I won't guess.`, citations: [cite(top)] };
    }
    const extra = second && second.metadata.score > top.metadata.score * 0.6 ? second : null;
    const text = `**${top.metadata.heading}** — ${top.pageContent}` + (extra ? `\n\n**${extra.metadata.heading}** — ${extra.pageContent}` : '');
    return { agent: 'policy', confidence: +Math.min(0.95, 0.4 + coverage * top.metadata.score / 15).toFixed(2), text, citations: [top, extra].filter(Boolean).map(cite) };
  }

  const chain = await getChain();
  const out = await chain.invoke({ context: formatDocs(docs), question: query, company: ctx.company.name });
  tracer.step('policy', 'llm', `LCEL chain: prompt | model.withStructuredOutput → answerable=${out.answerable}`);
  const used = docs.filter((d) => (out.used_ids || []).includes(d.metadata.id));
  return {
    agent: 'policy',
    confidence: out.answerable ? 0.9 : 0.25,
    text: out.answerable ? out.answer : "Our policies don't cover this clearly, so I'd rather not guess.",
    citations: (used.length ? used : docs.slice(0, 1)).map(cite),
  };
}
