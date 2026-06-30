# AI Chat — Backend Server

A minimal Node.js/Express server that makes the single-file `AI.html` frontend
deployable as a normal web app, instead of something you have to open
locally as a raw file. It does two things:

1. **Serves the frontend** (`AI.html`) as static content.
2. **Proxies API calls** (`/api/chat`, `/api/search`) to whatever
   OpenAI-compatible chat endpoint and search provider you configure, so the
   browser never needs CORS access to those upstreams directly, and you can
   optionally keep your API key server-side instead of typing it into every
   browser that uses the app.

The proxy is **transparent** — it forwards the exact request body the
frontend already sends (same JSON shape, same streaming SSE response) to
whatever upstream you configure. The frontend (`AI.html`) doesn't need any
code changes; only its default `Settings → API Endpoint` value was changed
from `https://api.openai.com/v1/chat/completions` to `/api/chat` (a relative
path, which now resolves to this server). Anyone can still point Settings at
a different endpoint (their own, or directly at a third-party API) if they
don't want to use the proxy.

## Quick start

```bash
cd server
npm install
cp .env.example .env
# edit .env: set CHAT_UPSTREAM and optionally SERVER_API_KEY
npm start
```

Then open `http://localhost:3000`.

## Docker

```bash
cd server
docker compose up -d --build
```

Or manually:

```bash
docker build -t ai-chat .
docker run -p 3000:3000 \
  -e CHAT_UPSTREAM=https://api.openai.com/v1/chat/completions \
  -e SERVER_API_KEY=sk-... \
  ai-chat
```

## Configuration

All configuration is via environment variables (or a `.env` file next to
`server.js`). See `.env.example` for the full list with explanations. The
important ones:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | What port the server listens on |
| `CHAT_UPSTREAM` | OpenAI | The real chat completions endpoint `/api/chat` forwards to |
| `SERVER_API_KEY` | _(empty)_ | Fallback API key used when the browser doesn't send one. Leave empty to require every user to enter their own key in Settings. A key typed into Settings always overrides this. |
| `SEARCH_UPSTREAM` | DuckDuckGo | The search provider `/api/search` forwards to (DuckDuckGo, SearXNG, or Serper — auto-detected by URL) |
| `SEARCH_API_KEY` | _(empty)_ | API key for the search provider, if it needs one (e.g. Serper) |
| `RATE_LIMIT_MAX` | `60` | Requests per IP per window on `/api/*`. `0` disables it. |

## How the proxy works

### `/api/chat`

Forwards your POST body and `Authorization` header byte-for-byte to
`CHAT_UPSTREAM`, and pipes the response back — including streamed SSE chunks
— without buffering or re-encoding. This is what lets the existing
`AI.html` streaming-parser code work completely unchanged: from the
browser's point of view, `/api/chat` *is* an OpenAI-compatible endpoint.

Point `CHAT_UPSTREAM` at any OpenAI-compatible API: OpenAI itself, DeepSeek,
a local Ollama instance, OpenRouter, etc. — anything that accepts the
standard `{ model, messages, stream, ... }` body and returns
`text/event-stream` chunks shaped like `data: {"choices":[{"delta":{...}}]}`.

### `/api/search`

The frontend's built-in search code has format-sniffing logic that branches
on the endpoint URL string (`serper.dev`, `duckduckgo`, `searx`, etc). Since
`/api/search` doesn't match any of those, the frontend always calls it as a
plain `GET /api/search?q=...&format=json` — so the **server** is responsible
for talking to whichever provider you configured and translating the
response into the shape the frontend expects (DuckDuckGo Instant Answer
format: `{ AbstractText, RelatedTopics: [{ Text, FirstURL }] }`).

This means you can swap `SEARCH_UPSTREAM` between DuckDuckGo, a self-hosted
SearXNG instance, or Serper.dev, and the frontend doesn't need to know or
care — it always just hits `/api/search?q=...`.

## Security notes

- **No built-in user authentication.** This server proxies requests but
  doesn't gate who can use it. If you set `SERVER_API_KEY`, anyone who can
  reach this server can spend your API quota. Put it behind your own auth
  (a reverse proxy with basic auth, a VPN, Cloudflare Access, etc.) if
  that's a concern, or leave `SERVER_API_KEY` empty so each user must
  supply their own key.
- **Rate limiting is minimal** (in-memory, per-IP, fixed window) — fine for
  personal/small-team use, not a substitute for a real API gateway under
  serious load or behind multiple server instances.
- **`ALLOW_CUSTOM_UPSTREAM`** (off by default) lets a client choose the
  upstream URL via a query parameter. Only enable this if you trust your
  users or have additional auth in front — otherwise it's an SSRF vector
  (a client could ask your server to make requests to internal/private
  URLs).
- Image/file attachments are sent as base64 inside the JSON body, so
  `BODY_LIMIT` (default `50mb`) needs to stay generous enough for your use
  case; lower it if you want to cap attachment size.

## File layout

```
server/
├── server.js          # the whole server (~250 lines, single file, one dependency)
├── package.json
├── .env.example        # copy to .env and fill in
├── Dockerfile
├── docker-compose.yml
├── AI.html              # the frontend, served statically
└── README.md            # this file
```

## Deploying elsewhere

Any platform that can run a Node.js process and exposes environment
variables works: Render, Railway, Fly.io, a plain VPS with `pm2`/`systemd`,
etc. There's no database and no filesystem state beyond serving the static
HTML file, so it scales horizontally with zero coordination — just run
multiple instances behind a load balancer (rate limiting is per-instance,
so the effective limit multiplies with instance count; lower
`RATE_LIMIT_MAX` accordingly if that matters to you).
