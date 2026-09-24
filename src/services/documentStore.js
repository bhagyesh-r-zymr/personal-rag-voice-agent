import fs from 'fs/promises';
import path from 'path';
import { config } from '../config.js';

// A small JSON manifest of indexed documents, kept in the uploads volume,
// so the UI can list and remove policies without scanning the vector index.
function manifestPath() {
  return path.join(config.uploadDir, 'documents.json');
}

async function readManifest() {
  try {
    return JSON.parse(await fs.readFile(manifestPath(), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

async function writeManifest(manifest) {
  await fs.mkdir(config.uploadDir, { recursive: true });
  const tmp = `${manifestPath()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(manifest, null, 2));
  await fs.rename(tmp, manifestPath());
}

export async function listDocuments() {
  const manifest = await readManifest();
  return Object.values(manifest).sort((a, b) => b.indexedAt.localeCompare(a.indexedAt));
}

export async function saveDocument(doc) {
  const manifest = await readManifest();
  manifest[doc.docId] = doc;
  await writeManifest(manifest);
}

export async function removeDocument(docId) {
  const manifest = await readManifest();
  if (!manifest[docId]) return false;
  delete manifest[docId];
  await writeManifest(manifest);
  return true;
}
