// The BM25 policy index exposed as a standard LangChain retriever, so it composes
// with LCEL chains (prompt | model) and could be swapped for a vector store retriever
// (e.g. pgvector / MemoryVectorStore.asRetriever()) without touching the agent.
import { BaseRetriever } from '@langchain/core/retrievers';
import { Document } from '@langchain/core/documents';
import { policyIndexFor } from '../services/policies.js';

export class PolicyRetriever extends BaseRetriever {
  lc_namespace = ['peopleos', 'retrievers'];

  constructor(fields = {}) {
    super(fields);
    this.k = fields.k ?? 4;
    this.companyId = fields.companyId; // each company only ever searches its own documents
  }

  async _getRelevantDocuments(query) {
    const index = await policyIndexFor(this.companyId);
    return index.search(query, this.k).map((h) => new Document({
      pageContent: h.text,
      metadata: { id: h.id, doc: h.doc, heading: h.heading, score: h.score },
    }));
  }
}

export const retrieverFor = (companyId) => new PolicyRetriever({ k: 4, companyId });

/** Formats retrieved documents as the citation-friendly context block the prompt expects. */
export const formatDocs = (docs) => docs.map((d) => `[${d.metadata.id}] (${d.metadata.doc} › ${d.metadata.heading})\n${d.pageContent}`).join('\n\n');
