import fs from 'fs/promises';
import path from 'path';
import pdf from 'pdf-parse';
import { chunkText } from './chunking.js';
import { embedTexts } from './embedding.js';
import { deleteDocumentVectors, upsertVectors } from './pinecone.js';
import { saveDocument } from './documentStore.js';
import { parseAllowedRoles } from './access.js';

export async function extractPdfPages(filePath) {
  const buffer = await fs.readFile(filePath);
  const pages = [];
  let pageNumber = 0;

  await pdf(buffer, {
    pagerender: async (pageData) => {
      pageNumber += 1;
      const textContent = await pageData.getTextContent();
      const text = textContent.items.map((item) => item.str).join(' ');
      pages.push({ pageNumber, text });
      return text;
    }
  });

  return pages;
}

// Same file name -> same docId, so re-uploading a policy replaces its previous version.
export function makeDocId(originalName) {
  const name = String(originalName || '');
  const slug = path
    .basename(name, path.extname(name))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || 'document';
}

export function buildChunkRecords(pages, { docId, source, allowedRoles }) {
  const records = [];
  for (const page of pages) {
    chunkText(page.text).forEach((text, i) => {
      records.push({
        id: `${docId}#p${page.pageNumber}-c${i + 1}`,
        text,
        metadata: { docId, source, page: page.pageNumber, chunk: i + 1, text, allowedRoles }
      });
    });
  }
  return records;
}

const defaultDeps = { extractPdfPages, embedTexts, deleteDocumentVectors, upsertVectors, saveDocument };

export async function indexPolicyPdf(
  { filePath, originalName, allowedRoles = parseAllowedRoles() },
  deps = defaultDeps
) {
  try {
    const docId = makeDocId(originalName);
    const pages = await deps.extractPdfPages(filePath);
    const records = buildChunkRecords(pages, { docId, source: originalName, allowedRoles });

    if (!records.length) {
      const error = new Error('No text could be extracted from this PDF. Scanned PDFs need OCR before upload.');
      error.statusCode = 422;
      throw error;
    }

    const embeddings = await deps.embedTexts(records.map((r) => r.text));
    const vectors = records.map((r, i) => ({ id: r.id, values: embeddings[i], metadata: r.metadata }));

    // Embed first so a failed upload never leaves the old version deleted.
    await deps.deleteDocumentVectors(docId);
    await deps.upsertVectors(vectors);

    const doc = {
      docId,
      name: originalName,
      pages: pages.length,
      chunks: vectors.length,
      allowedRoles,
      indexedAt: new Date().toISOString()
    };
    await deps.saveDocument(doc);
    return doc;
  } finally {
    await fs.rm(filePath, { force: true });
  }
}
