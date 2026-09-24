import { Pinecone } from '@pinecone-database/pinecone';
import { config } from '../config.js';

const UPSERT_BATCH_SIZE = 100;
const DELETE_BATCH_SIZE = 1000;

let namespace = null;

function getNamespace() {
  if (!namespace) {
    const pc = new Pinecone({ apiKey: config.pineconeApiKey });
    namespace = pc.index(config.pineconeIndex).namespace(config.pineconeNamespace);
  }
  return namespace;
}

export async function upsertVectors(vectors) {
  for (let start = 0; start < vectors.length; start += UPSERT_BATCH_SIZE) {
    await getNamespace().upsert(vectors.slice(start, start + UPSERT_BATCH_SIZE));
  }
}

export async function queryVectors(vector, topK = config.maxContextChunks) {
  const result = await getNamespace().query({
    vector,
    topK,
    includeMetadata: true
  });

  return result.matches || [];
}

async function listIdsWithPrefix(prefix) {
  const ids = [];
  let paginationToken;
  do {
    const page = await getNamespace().listPaginated({ prefix, paginationToken });
    ids.push(...(page.vectors || []).map((v) => v.id));
    paginationToken = page.pagination?.next;
  } while (paginationToken);
  return ids;
}

// Vector ids are "<docId>#p<page>-c<chunk>", so one document's vectors share the "<docId>#" prefix.
export async function deleteDocumentVectors(docId) {
  let ids;
  try {
    ids = await listIdsWithPrefix(`${docId}#`);
  } catch (error) {
    // Pod-based indexes can't list ids; they support deleting by metadata filter instead.
    await getNamespace().deleteMany({ docId: { $eq: docId } });
    return;
  }

  for (let start = 0; start < ids.length; start += DELETE_BATCH_SIZE) {
    await getNamespace().deleteMany(ids.slice(start, start + DELETE_BATCH_SIZE));
  }
}
