import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { apiRouter } from './routes/api.js';
import { assertRequiredEnv, config, validateConfig } from './config.js';
import { attachLiveVoiceServer } from './services/liveVoice.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

assertRequiredEnv();
validateConfig();

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use('/api', apiRouter);
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.use((error, req, res, next) => {
  // eslint-disable-next-line no-console
  console.error(error);
  res.status(error.statusCode || error.status || 500).json({
    error: error.message || 'Internal Server Error',
    details: error.details
  });
});

const server = app.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(`Server running on http://localhost:${config.port}`);
});

// Gemini Live voice proxy: WebSocket endpoint at /api/live.
attachLiveVoiceServer(server);
