import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { chunkText } from '../src/services/chunking.js';
import { buildChunkRecords, indexPolicyPdf, makeDocId } from '../src/services/ingest.js';

function words(n) {
  return Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
}

test('chunkText splits long text into overlapping chunks', () => {
  const chunks = chunkText(words(800), { size: 350, overlap: 60 });
  assert.equal(chunks.length, 3);
  assert.ok(chunks[0].endsWith('w349'));
  assert.ok(chunks[1].startsWith('w290'));
  assert.ok(chunks[2].endsWith('w799'));
});

test('chunkText returns nothing for blank text', () => {
  assert.deepEqual(chunkText('   \n '), []);
});

test('makeDocId gives the same id for the same file name', () => {
  assert.equal(makeDocId('Leave Policy (2026).PDF'), 'leave-policy-2026');
  assert.equal(makeDocId('Leave Policy (2026).PDF'), makeDocId('leave policy (2026).pdf'));
  assert.equal(makeDocId('###.pdf'), 'document');
});

test('buildChunkRecords gives stable ids prefixed by the document id', () => {
  const records = buildChunkRecords(
    [
      { pageNumber: 1, text: 'Annual leave is 20 days.' },
      { pageNumber: 2, text: '' },
      { pageNumber: 3, text: 'Remote work needs manager approval.' }
    ],
    { docId: 'hr-policy', source: 'HR Policy.pdf', allowedRoles: ['admin', 'manager'] }
  );

  assert.deepEqual(
    records.map((r) => r.id),
    ['hr-policy#p1-c1', 'hr-policy#p3-c1']
  );
  assert.deepEqual(records[1].metadata, {
    docId: 'hr-policy',
    source: 'HR Policy.pdf',
    page: 3,
    chunk: 1,
    text: 'Remote work needs manager approval.',
    allowedRoles: ['admin', 'manager']
  });
});

async function tempFile() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ingest-test-'));
  const filePath = path.join(dir, 'upload');
  await fs.writeFile(filePath, 'fake pdf');
  return filePath;
}

test('indexPolicyPdf replaces the old version, batches embeddings and removes the temp file', async () => {
  const filePath = await tempFile();
  const calls = [];
  const deps = {
    extractPdfPages: async () => [
      { pageNumber: 1, text: 'Annual leave is 20 days.' },
      { pageNumber: 2, text: 'Remote work needs manager approval.' }
    ],
    embedTexts: async (texts) => {
      calls.push(['embed', texts.length]);
      return texts.map(() => [0.1, 0.2]);
    },
    deleteDocumentVectors: async (docId) => calls.push(['delete', docId]),
    upsertVectors: async (vectors) => calls.push(['upsert', vectors.map((v) => v.id)]),
    saveDocument: async (doc) => calls.push(['save', doc.docId, doc.name, doc.chunks])
  };

  const doc = await indexPolicyPdf({ filePath, originalName: 'HR Policy.pdf' }, deps);

  assert.equal(doc.docId, 'hr-policy');
  // With no roles given, every role may read the policy.
  assert.deepEqual(doc.allowedRoles, ['admin', 'manager', 'employee']);
  assert.deepEqual(calls, [
    ['embed', 2],
    ['delete', 'hr-policy'],
    ['upsert', ['hr-policy#p1-c1', 'hr-policy#p2-c1']],
    ['save', 'hr-policy', 'HR Policy.pdf', 2]
  ]);
  await assert.rejects(fs.access(filePath));
});

test('indexPolicyPdf keeps the old version when embedding fails, and still removes the temp file', async () => {
  const filePath = await tempFile();
  let deleted = false;
  const deps = {
    extractPdfPages: async () => [{ pageNumber: 1, text: 'Some text' }],
    embedTexts: async () => {
      throw new Error('rate limited');
    },
    deleteDocumentVectors: async () => {
      deleted = true;
    },
    upsertVectors: async () => {},
    saveDocument: async () => {}
  };

  await assert.rejects(indexPolicyPdf({ filePath, originalName: 'a.pdf' }, deps), /rate limited/);
  assert.equal(deleted, false);
  await assert.rejects(fs.access(filePath));
});

test('indexPolicyPdf rejects PDFs with no extractable text', async () => {
  const filePath = await tempFile();
  const deps = {
    extractPdfPages: async () => [{ pageNumber: 1, text: '  ' }],
    embedTexts: async () => [],
    deleteDocumentVectors: async () => {},
    upsertVectors: async () => {},
    saveDocument: async () => {}
  };

  await assert.rejects(indexPolicyPdf({ filePath, originalName: 'scan.pdf' }, deps), (error) => {
    assert.equal(error.statusCode, 422);
    return true;
  });
});
