import OpenAI from 'openai';
import { config } from '../config.js';

let client = null;

function getClient() {
  if (!client) {
    client = new OpenAI({
      apiKey: config.embeddingApiKey,
      baseURL: config.embeddingBaseUrl
    });
  }
  return client;
}

export async function embedTexts(inputs) {
  if (!inputs.length) return [];

  const embeddings = [];
  for (let start = 0; start < inputs.length; start += config.embeddingBatchSize) {
    const batch = inputs.slice(start, start + config.embeddingBatchSize);
    const response = await getClient().embeddings.create({
      model: config.embeddingModel,
      input: batch,
      dimensions: config.embeddingDimensions
    });

    // The API returns one item per input, tagged with its position in the batch.
    const ordered = [...response.data].sort((a, b) => a.index - b.index);
    embeddings.push(...ordered.map((item) => item.embedding));
  }

  return embeddings;
}

export async function embedText(input) {
  const [embedding] = await embedTexts([input]);
  return embedding;
}
