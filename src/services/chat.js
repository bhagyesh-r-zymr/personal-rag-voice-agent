import { GoogleGenAI } from '@google/genai';
import { config } from '../config.js';
import { embedText } from './embedding.js';
import { queryVectors } from './pinecone.js';
import { retrievalFilter } from './access.js';

export const NOT_FOUND_TEXT = "I couldn't find that in the company policies.";

let ai = null;

async function generateText(prompt) {
  if (!ai) ai = new GoogleGenAI({ apiKey: config.geminiApiKey });
  const response = await ai.models.generateContent({ model: config.chatModel, contents: prompt });
  return response.text;
}

// Returns the retrieved chunks worth grounding on, numbered [1..n] in relevance order,
// limited to the policies the asker's role may read.
export async function retrievePolicyContext(
  query,
  { role } = {},
  deps = { embedText, queryVectors },
  settings = config
) {
  if (!role) throw new Error('retrievePolicyContext needs the asker\'s role.');
  const vector = await deps.embedText(query);
  const matches = vector ? await deps.queryVectors(vector, settings.maxContextChunks, retrievalFilter(role)) : [];

  return matches
    .filter((m) => (m.score ?? 0) >= settings.minRelevanceScore && m.metadata?.text)
    .map((m, i) => ({
      id: i + 1,
      docId: m.metadata.docId,
      source: m.metadata.source,
      page: m.metadata.page,
      score: m.score,
      text: m.metadata.text
    }));
}

export function buildPrompt({ message, context, history, handbookOnly }) {
  const contextBlock = context
    .map((c) => `[${c.id}] source="${c.source || 'unknown'}" page=${c.page ?? 'unknown'}\n${c.text}`)
    .join('\n\n');

  const historyBlock = history
    .slice(-8)
    .map((m) => `${m.role.toUpperCase()}: ${m.text}`)
    .join('\n');

  const rules = handbookOnly
    ? `1) Answer ONLY from the provided policy context.
2) If the answer is not in the context, reply exactly: "${NOT_FOUND_TEXT}"`
    : `1) Prefer the provided policy context and cite it.
2) If you add anything not in the context, say clearly that it is general guidance, not company policy.`;

  return `You are an internal company policy assistant.
Rules:
${rules}
3) Keep answers concise and cite the context you used inline, like [1] or [2].

Conversation history:
${historyBlock || 'No previous history.'}

Policy context:
${contextBlock || 'No context available.'}

User question: ${message}`;
}

export function citedIds(text) {
  const ids = new Set();
  for (const [, group] of String(text || '').matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)) {
    group.split(',').forEach((n) => ids.add(Number(n.trim())));
  }
  return ids;
}

const defaultDeps = { retrieve: retrievePolicyContext, generate: generateText };

export async function answerFromHandbook({ message, history = [], role }, deps = defaultDeps, settings = config) {
  const context = await deps.retrieve(message, { role });

  // Nothing relevant was retrieved: refuse without spending a model call on a guess.
  if (!context.length && settings.handbookOnly) {
    return { text: NOT_FOUND_TEXT, citations: [] };
  }

  const prompt = buildPrompt({ message, context, history, handbookOnly: settings.handbookOnly });
  const text = (await deps.generate(prompt))?.trim() || NOT_FOUND_TEXT;

  const cited = citedIds(text);
  const citations = context.filter((c) => cited.has(c.id));

  return { text, citations };
}
