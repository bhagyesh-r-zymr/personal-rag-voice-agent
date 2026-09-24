import express from 'express';
import fs from 'fs/promises';
import multer from 'multer';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { indexPolicyPdf } from '../services/ingest.js';
import { listDocuments, removeDocument } from '../services/documentStore.js';
import { deleteDocumentVectors } from '../services/pinecone.js';
import { addMessage, ensureSession, getSession } from '../services/sessionStore.js';
import { answerFromHandbook } from '../services/chat.js';
import { config } from '../config.js';

const upload = multer({
  dest: config.uploadDir,
  limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1 }
});

function receivePdf(req, res, next) {
  upload.single('file')(req, res, (error) => {
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: `PDFs must be ${config.maxUploadMb} MB or smaller.` });
    }
    return next(error);
  });
}

export const apiRouter = express.Router();

function toApiError(error, fallbackMessage) {
  const status = error?.status || error?.statusCode || 500;
  const message = error?.error?.message || error?.message || fallbackMessage;

  return {
    statusCode: status,
    message,
    details: {
      type: error?.type || error?.error?.type || 'internal_error',
      requestId: error?.request_id || null
    }
  };
}

apiRouter.get('/health', (req, res) => {
  res.json({ ok: true, liveModel: config.liveModel });
});

apiRouter.post('/upload-handbook', receivePdf, async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Please upload a PDF as form field "file".' });
    }

    const ext = path.extname(req.file.originalname).toLowerCase();
    if (ext !== '.pdf') {
      await fs.rm(req.file.path, { force: true });
      return res.status(400).json({ error: 'Only PDF files are supported.' });
    }

    const doc = await indexPolicyPdf({ filePath: req.file.path, originalName: req.file.originalname });
    return res.json({ ok: true, ...doc });
  } catch (error) {
    return next(toApiError(error, 'Failed to index the uploaded PDF.'));
  }
});

apiRouter.get('/documents', async (req, res, next) => {
  try {
    res.json({ documents: await listDocuments() });
  } catch (error) {
    next(toApiError(error, 'Failed to list documents.'));
  }
});

apiRouter.delete('/documents/:docId', async (req, res, next) => {
  try {
    const { docId } = req.params;
    await deleteDocumentVectors(docId);
    const removed = await removeDocument(docId);
    if (!removed) return res.status(404).json({ error: 'Document not found.' });
    return res.json({ ok: true, docId });
  } catch (error) {
    return next(toApiError(error, 'Failed to remove the document.'));
  }
});

apiRouter.post('/session', (req, res) => {
  const sessionId = uuidv4();
  ensureSession(sessionId);
  res.json({ sessionId });
});

apiRouter.get('/session/:sessionId', (req, res) => {
  const data = getSession(req.params.sessionId);
  if (!data) return res.status(404).json({ error: 'Session not found.' });
  return res.json(data);
});

apiRouter.post('/chat', async (req, res, next) => {
  try {
    const { sessionId, message } = req.body || {};
    if (!sessionId || !message) {
      return res.status(400).json({ error: 'sessionId and message are required.' });
    }

    const history = [...ensureSession(sessionId).messages];
    addMessage(sessionId, 'user', message);

    const result = await answerFromHandbook({ message, history });
    addMessage(sessionId, 'assistant', result.text, result.citations);

    return res.json(result);
  } catch (error) {
    return next(toApiError(error, 'Failed to answer from handbook context.'));
  }
});

apiRouter.get('/live-config', (req, res) => {
  res.json({
    model: config.liveModel,
    available: Boolean(config.geminiApiKey),
    wsPath: '/api/live',
    inputSampleRate: 16000,
    outputSampleRate: 24000
  });
});
