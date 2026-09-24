import dotenv from 'dotenv';

dotenv.config();

export const config = {
  port: Number(process.env.PORT || 3000),
  nodeEnv: process.env.NODE_ENV || 'development',
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  liveModel: process.env.LIVE_MODEL || 'gemini-3.1-flash-live-preview',
  chatModel: process.env.CHAT_MODEL || 'gemini-2.5-flash',
  embeddingApiKey: process.env.EMBEDDING_API_KEY || '',
  embeddingBaseUrl: process.env.EMBEDDING_BASE_URL || 'https://api.openai.com/v1',
  embeddingModel: process.env.EMBEDDING_MODEL || 'text-embedding-3-small',
  embeddingDimensions: Number(process.env.EMBEDDING_DIMENSIONS || 1024),
  pineconeApiKey: process.env.PINECONE_API_KEY || '',
  pineconeIndex: process.env.PINECONE_INDEX || 'company-handbook',
  pineconeNamespace: process.env.PINECONE_NAMESPACE || 'default',
  maxContextChunks: Number(process.env.MAX_CONTEXT_CHUNKS || 6),
  minRelevanceScore: Number(process.env.MIN_RELEVANCE_SCORE ?? 0.25),
  handbookOnly: String(process.env.HANDBOOK_ONLY || 'true').toLowerCase() === 'true',
  embeddingBatchSize: Number(process.env.EMBEDDING_BATCH_SIZE || 64),
  uploadDir: process.env.UPLOAD_DIR || 'uploads',
  maxUploadMb: Number(process.env.MAX_UPLOAD_MB || 25)
};

function normalizeBaseUrl(value) {
  return String(value || '').replace(/\/+$/, '').toLowerCase();
}

function isOpenAiEmbeddingsConfig() {
  return normalizeBaseUrl(config.embeddingBaseUrl) === 'https://api.openai.com/v1';
}

export function validateConfig() {
  if (isOpenAiEmbeddingsConfig() && config.embeddingModel.includes('/')) {
    throw new Error(
      `Invalid EMBEDDING_MODEL "${config.embeddingModel}" for OpenAI. Use the raw model ID, for example "text-embedding-3-small", not a provider-prefixed value like "openai/text-embedding-3-small".`
    );
  }

  if (!Number.isInteger(config.embeddingDimensions) || config.embeddingDimensions <= 0) {
    throw new Error('EMBEDDING_DIMENSIONS must be a positive integer.');
  }

  if (!Number.isFinite(config.minRelevanceScore) || config.minRelevanceScore < 0 || config.minRelevanceScore > 1) {
    throw new Error('MIN_RELEVANCE_SCORE must be a number between 0 and 1.');
  }
}

export function assertRequiredEnv() {
  const required = [
    ['GEMINI_API_KEY', config.geminiApiKey],
    ['EMBEDDING_API_KEY', config.embeddingApiKey],
    ['PINECONE_API_KEY', config.pineconeApiKey],
    ['PINECONE_INDEX', config.pineconeIndex]
  ];

  const missing = required.filter(([, value]) => !value).map(([key]) => key);
  if (missing.length) {
    // eslint-disable-next-line no-console
    console.warn(`Missing env vars: ${missing.join(', ')}`);
  }
}
