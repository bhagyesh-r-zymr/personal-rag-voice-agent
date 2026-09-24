# Handbook RAG Voice Agent (MVP)

Node.js containerized MVP for querying a company handbook PDF using RAG.

## What this includes

- Policy library: upload several policy PDFs (drag and drop), see what is indexed, and remove documents.
- Re-uploading a file with the same name replaces its previous version instead of duplicating it.
- Text chat grounded on policy chunks only. If nothing scores above `MIN_RELEVANCE_SCORE`, the assistant refuses without calling Gemini.
- Answers cite sources inline; the Sources panel shows only the chunks the answer used, with file name, page and relevance.
- Voice: Gemini Live (spoken questions and answers, grounded through a `search_policies` tool on the server) when `GEMINI_API_KEY` is set, falling back to the browser's own speech recognition and synthesis.
- Download the conversation as Markdown.
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

## Sign-in and roles

Everyone signs in with email and password. Accounts live in a SQLite database at `DB_PATH` (default `data/app.db`); passwords are hashed with scrypt and sessions use an httpOnly cookie.

| Role | Can do |
| --- | --- |
| `employee` | Ask questions (text and voice) about policies shared with employees |
| `manager` | Same, plus policies shared with managers only |
| `admin` | Everything, plus upload/remove policies and manage users |

On first start, set `ADMIN_EMAIL` and `ADMIN_PASSWORD`; that admin is created if no admin exists yet. Admins add other users from the **Users** button in the app.

When uploading a policy, admins choose who can read it (managers, employees, or both). Retrieval for chat and voice is filtered by the asker's role, so answers never quote a policy their role can't read. Policies indexed before roles existed are admin-only until re-uploaded.

## API surface

Every endpoint except `/api/health` and `/api/auth/login` needs a signed-in session.

- `POST /api/auth/login` with `{ email, password }` (sets the session cookie)
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `POST /api/auth/password` with `{ currentPassword, newPassword }`
- `GET /api/users`, `POST /api/users`, `PATCH /api/users/:id`, `DELETE /api/users/:id` (admin)
- `POST /api/upload-handbook` (admin; multipart, field `file`, optional `roles` like `manager,employee`; max `MAX_UPLOAD_MB`)
- `GET /api/documents` (only the policies your role can read)
- `DELETE /api/documents/:docId` (admin)
- `POST /api/session`
- `GET /api/session/:sessionId`
- `POST /api/chat` with `{ sessionId, message }`
- `GET /api/live-config`
- `GET /api/health`
- WebSocket `/api/live`: Gemini Live voice proxy (protocol documented in `src/services/liveVoice.js`); refuses signed-out connections with 401

## Notes

- The assistant intentionally refuses to free-answer outside retrieved policy context (`HANDBOOK_ONLY=true`).
- The Gemini API key stays on the server; the browser streams mic audio to `/api/live` and the server relays it to Gemini Live.
- Indexed documents are listed from `uploads/documents.json`, which lives in the `uploads` Docker volume.
- Documents indexed before stable ids were introduced have random vector ids; clear the Pinecone namespace once and re-upload them so re-uploads replace cleanly.
