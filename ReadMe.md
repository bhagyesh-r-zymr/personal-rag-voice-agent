# Handbook RAG Voice Agent (MVP)

Node.js containerized MVP for querying a company handbook PDF using RAG.

## What this includes

- Policy library: upload several policy PDFs (drag and drop), see what is indexed, and remove documents.
- Re-uploading a file with the same name replaces its previous version instead of duplicating it.
- Text chat grounded on policy chunks only. If nothing scores above `MIN_RELEVANCE_SCORE`, the assistant refuses without calling Gemini.
- Answers cite sources inline; the Sources panel shows only the chunks the answer used, with file name, page and relevance.
- Voice: Gemini Live (spoken questions and answers, grounded through a `search_policies` tool on the server) when `GEMINI_API_KEY` is set, falling back to the browser's own speech recognition and synthesis.
- Download the conversation as Markdown.
- Answer feedback: 👍 / 👎 under each typed answer, with an optional note on a 👎. Ratings are stored in SQLite (`DB_PATH`, default `data/app.db`). The **Feedback** button shows ratings per document, questions the policies did not cover, and the latest answers marked not helpful.
- Session memory in memory (Supabase persistence can be added later).

## Confirmed model choices

- Configured Gemini Live model for future experiments: `gemini-3.1-flash-live-preview`
- Embeddings model: `text-embedding-3-small`
- Embedding dimensions: `1024` to match the current Pinecone index

## Prerequisites

- Docker + Docker Compose
- Pinecone index already created (dimension must match `EMBEDDING_DIMENSIONS`; this repo now defaults to `1024`)
- API keys for Gemini + embedding provider + Pinecone

## Environment

1. Copy env file:

```bash
cp .env.example .env
```

2. Fill required variables in `.env`:

- `GEMINI_API_KEY`
- `EMBEDDING_API_KEY`
- `PINECONE_API_KEY`
- `PINECONE_INDEX`

For OpenAI's native API, use the raw embedding model ID in `.env`, for example:

```bash
EMBEDDING_BASE_URL=https://api.openai.com/v1
EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_DIMENSIONS=1024
```

Do not use provider-prefixed values like `openai/text-embedding-3-small` with `api.openai.com`.

## Run locally (Docker)

```bash
docker compose up --build
```

Then open: <http://localhost:3000>

## API surface

- `POST /api/upload-handbook` (multipart, field name `file`; max `MAX_UPLOAD_MB`)
- `GET /api/documents`
- `DELETE /api/documents/:docId`
- `POST /api/session`
- `GET /api/session/:sessionId`
- `POST /api/chat` with `{ sessionId, message }`
- `POST /api/feedback` with `{ sessionId, answerId, rating: "up" | "down" | "none", comment? }`
- `GET /api/feedback/summary` (admin only once login is enabled)
- `GET /api/live-config`
- `GET /api/health`
- WebSocket `/api/live`: Gemini Live voice proxy (protocol documented in `src/services/liveVoice.js`)

## Notes

- The assistant intentionally refuses to free-answer outside retrieved policy context (`HANDBOOK_ONLY=true`).
- The Gemini API key stays on the server; the browser streams mic audio to `/api/live` and the server relays it to Gemini Live.
- Indexed documents are listed from `uploads/documents.json`, which lives in the `uploads` Docker volume.
- Documents indexed before stable ids were introduced have random vector ids; clear the Pinecone namespace once and re-upload them so re-uploads replace cleanly.
