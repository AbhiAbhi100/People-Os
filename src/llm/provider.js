// LLM layer built on LangChain chat models.
// One factory, three provider families: Anthropic (ChatAnthropic), any OpenAI-compatible API
// (ChatOpenAI → OpenAI, Groq, OpenRouter, Ollama…) and Gemini (ChatGoogleGenerativeAI).
// Every agent asks for *structured output* with a zod schema, so there is no hand-written JSON parsing.
//
// With no key configured the app runs in OFFLINE mode: each agent has a deterministic path,
// and the LangGraph orchestrator still runs exactly the same graph.
import { AsyncLocalStorage } from 'node:async_hooks';
import { SystemMessage, HumanMessage, AIMessage } from '@langchain/core/messages';

const env = process.env;
// Per-request override so an agent can degrade to offline mode if the LLM fails mid-request.
export const llmContext = new AsyncLocalStorage();
export const withOffline = (fn) => llmContext.run({ offline: true }, fn);

export function providerInfo() {
  const p = env.LLM_PROVIDER ||
    (env.ANTHROPIC_API_KEY ? 'anthropic' : env.OPENAI_API_KEY ? 'openai' : env.GEMINI_API_KEY || env.GOOGLE_API_KEY ? 'gemini' : 'offline');
  const defaults = { anthropic: 'claude-haiku-5-5', openai: 'gpt-4o-mini', gemini: 'gemini-3.8-flash', offline: 'rules' };
  return { provider: p, model: env.LLM_MODEL || defaults[p] };
}
export const isOffline = () => llmContext.getStore()?.offline === true || providerInfo().provider === 'offline';

// Token accounting through a LangChain callback handler (works for every provider).
export const usage = { calls: 0, inputTokens: 0, outputTokens: 0 };
const usageHandler = {
  handleLLMStart() { usage.calls++; },
  handleLLMEnd(output) {
    const m = output?.generations?.[0]?.[0]?.message?.usage_metadata;
    const t = output?.llmOutput?.tokenUsage;
    usage.inputTokens += m?.input_tokens ?? t?.promptTokens ?? 0;
    usage.outputTokens += m?.output_tokens ?? t?.completionTokens ?? 0;
  },
};

const TIMEOUT = +(env.LLM_TIMEOUT_MS || 30000);
let cached = null;

/** Returns a LangChain BaseChatModel for the configured provider (null when offline). */
export async function getChatModel() {
  const { provider, model } = providerInfo();
  if (provider === 'offline') return null;
  const key = `${provider}:${model}:${env.OPENAI_BASE_URL || ''}`;
  if (cached?.key === key) return cached.model;
  const common = { model, temperature: 0, maxRetries: 1, callbacks: [usageHandler] };
  let m;
  if (provider === 'anthropic') {
    const { ChatAnthropic } = await import('@langchain/anthropic');
    m = new ChatAnthropic({ ...common, maxTokens: 1024, apiKey: env.ANTHROPIC_API_KEY });
  } else if (provider === 'openai') {
    const { ChatOpenAI } = await import('@langchain/openai');
    m = new ChatOpenAI({ ...common, maxTokens: 1024, timeout: TIMEOUT, apiKey: env.OPENAI_API_KEY,
      configuration: env.OPENAI_BASE_URL ? { baseURL: env.OPENAI_BASE_URL } : undefined });
  } else if (provider === 'gemini') {
    const { ChatGoogleGenerativeAI } = await import('@langchain/google-genai');
    m = new ChatGoogleGenerativeAI({ ...common, maxOutputTokens: 2048, apiKey: env.GEMINI_API_KEY || env.GOOGLE_API_KEY,
      ...(env.GEMINI_BASE_URL ? { baseUrl: env.GEMINI_BASE_URL } : {}) });
  } else {
    throw new Error(`Unknown LLM_PROVIDER "${provider}"`);
  }
  cached = { key, model: m };
  return m;
}

/**
 * Wraps a model with structured output. OpenAI-compatible servers other than OpenAI itself
 * (Groq, Ollama…) are most reliable with function calling, so we pick that method for them.
 */
export async function structuredModel(schema, name = 'output') {
  const model = await getChatModel();
  if (!model) throw new Error('No LLM configured (offline mode)');
  const { provider } = providerInfo();
  const method = env.STRUCTURED_METHOD || (provider === 'openai' && env.OPENAI_BASE_URL ? 'functionCalling' : undefined);
  return model.withStructuredOutput(schema, { name, ...(method ? { method } : {}) });
}

const toMessages = (system, messages) => [
  new SystemMessage(system),
  ...messages.map((m) => (m.role === 'assistant' ? new AIMessage(m.content) : new HumanMessage(m.content))),
];

/** Structured call: returns an object that matches the zod `schema`. */
export async function chatJSON({ system, messages, schema, name }) {
  const runnable = await structuredModel(schema, name);
  return runnable.invoke(toMessages(system, messages), { timeout: TIMEOUT });
}

/** Text content of an AIMessage across providers (string or content blocks). */
export const textOf = (msg) => (typeof msg?.content === 'string' ? msg.content
  : (msg?.content || []).map((b) => (typeof b === 'string' ? b : b.text || '')).join(''));
