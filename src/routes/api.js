import express from 'express';
import fs from 'fs/promises';
import multer from 'multer';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { indexPolicyPdf } from '../services/ingest.js';
import { listDocuments, removeDocument } from '../services/documentStore.js';
import { deleteDocumentVectors } from '../services/pinecone.js';
import { addMessage, deleteSession, ensureSession, getSession, listSessions } from '../services/sessionStore.js';
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

// Once login is in place, req.user scopes chat history to its owner.
function owner(req) {
  return { userId: req.user?.id ?? null };
}

apiRouter.post('/session', (req, res) => {
  const sessionId = uuidv4();
  ensureSession(sessionId, owner(req));
  res.json({ sessionId });
});

apiRouter.get('/sessions', (req, res) => {
  res.json({ sessions: listSessions(owner(req)) });
});

apiRouter.get('/session/:sessionId', (req, res) => {
  const data = getSession(req.params.sessionId, owner(req));
  if (!data) return res.status(404).json({ error: 'Session not found.' });
  return res.json(data);
});

apiRouter.delete('/session/:sessionId', (req, res) => {
  if (!deleteSession(req.params.sessionId, owner(req))) {
    return res.status(404).json({ error: 'Session not found.' });
  }
  return res.json({ ok: true, sessionId: req.params.sessionId });
});

// Saves turns that were answered outside /api/chat (Gemini Live voice).
apiRouter.post('/session/:sessionId/messages', (req, res) => {
  const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
  const valid = messages.filter((m) => ['user', 'assistant'].includes(m?.role) && typeof m.text === 'string' && m.text.trim());
  if (!valid.length) return res.status(400).json({ error: 'messages must include at least one user or assistant turn.' });

  const session = ensureSession(req.params.sessionId, owner(req));
  if (!session) return res.status(404).json({ error: 'Session not found.' });

  const saved = valid.map((m) =>
    addMessage(req.params.sessionId, m.role, m.text.trim(), Array.isArray(m.citations) ? m.citations : [])
  );
  return res.json({ ok: true, messages: saved });
});

apiRouter.post('/chat', async (req, res, next) => {
  try {
    const { sessionId, message } = req.body || {};
    if (!sessionId || !message) {
      return res.status(400).json({ error: 'sessionId and message are required.' });
    }

    const session = ensureSession(sessionId, owner(req));
    if (!session) return res.status(404).json({ error: 'Session not found.' });

    const history = session.messages;
    addMessage(sessionId, 'user', message);

    const result = await answerFromHandbook({ message, history });
    const saved = addMessage(sessionId, 'assistant', result.text, result.citations);

    return res.json({ ...result, messageId: saved.id });
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
