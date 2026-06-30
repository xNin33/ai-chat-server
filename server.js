// AI Chat — backend server
//
// Design goal: be a *transparent* proxy. The frontend (AI.html) is a pure
// client-side app that fetches an OpenAI-compatible "endpoint" URL directly
// from the browser, with the user's API key in an Authorization header, and
// reads back an SSE stream (`text/event-stream`, `data: {...}\n\n` lines,
// terminated by `data: [DONE]`). It also optionally calls a search endpoint
// (Serper / SearXNG / DuckDuckGo Instant Answer) the same way.
//
// This server does NOT reinterpret or repackage those protocols — it just
// forwards the request body/headers to the upstream URL and pipes the
// response straight back, byte for byte, preserving streaming. That means
// AI.html keeps working unmodified: point `settings.endpoint` (Settings →
// API Endpoint) at `https://your-server/api/chat` instead of
// `https://api.openai.com/v1/chat/completions`, and everything else behaves
// identically — same request shape, same SSE shape, same error shape.
//
// Why proxy at all instead of calling the upstream directly from the
// browser?
//   1. CORS: some upstreams (search providers especially) don't set
//      Access-Control-Allow-Origin, so the browser request fails outright.
//   2. Key handling: lets you set a server-side default API key via env var
//      so end users don't have to paste one into the browser (optional —
//      per-user keys typed into Settings still work and take precedence).
//   3. Single deployable: ships the static HTML + a tiny Node server in one
//      `npm start`, no separate static host needed.
//
// Endpoints exposed:
//   POST /api/chat    → proxies to CHAT_UPSTREAM (any OpenAI-compatible
//                        /v1/chat/completions URL, default: OpenAI itself)
//   POST /api/search  → proxies to SEARCH_UPSTREAM (Serper-style POST JSON)
//   GET  /api/search  → proxies to SEARCH_UPSTREAM (SearXNG/DuckDuckGo-style
//                        GET with querystring)
//   GET  /healthz     → liveness check
//   *    /             → serves AI.html (the frontend) and any static assets
//
// Configuration is via environment variables (see .env.example).

const express = require('express');
const path = require('path');
const fs = require('fs');

// ── Minimal .env loader (no dependency) ─────────────────────────────────────
// Looks for a .env file next to this script and loads KEY=VALUE pairs into
// process.env, without overriding any variables already set by the host
// environment (those always win).
(function loadDotEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    let value = t.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
})();

const app = express();

// ── Config ─────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;

// Default upstream for /api/chat when the frontend doesn't override it via
// a fully-qualified endpoint. Most users will just point Settings → API
// Endpoint at "/api/chat" and let the server fill in the real upstream.
const CHAT_UPSTREAM = process.env.CHAT_UPSTREAM || 'https://api.openai.com/v1/chat/completions';

// Optional server-side API key. If set, used as a fallback when the
// frontend doesn't send an Authorization header (e.g. user left the API Key
// field blank in Settings). A key typed into Settings always wins.
const SERVER_API_KEY = process.env.SERVER_API_KEY || '';

// Default upstream for /api/search.
const SEARCH_UPSTREAM = process.env.SEARCH_UPSTREAM || 'https://api.duckduckgo.com/';
const SEARCH_API_KEY = process.env.SEARCH_API_KEY || '';

// Static frontend file. Looks for AI.html next to this script by default;
// override with FRONTEND_FILE if you renamed it.
const FRONTEND_FILE = process.env.FRONTEND_FILE || path.join(__dirname, 'AI.html');

// Request size limit — generous because base64 image attachments can be large.
const BODY_LIMIT = process.env.BODY_LIMIT || '50mb';

// Simple per-IP rate limit for /api/* (requests per window). Set to 0 to disable.
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || '60', 10);
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10);

// ── Middleware ─────────────────────────────────────────────────────────────

app.disable('x-powered-by');
app.use(express.json({ limit: BODY_LIMIT }));

// Minimal CORS — only matters if the frontend is hosted elsewhere and calls
// this server cross-origin. Same-origin deployments (the common case here,
// since this server also serves AI.html) don't need it, but it's harmless.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-KEY');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Very small fixed-window rate limiter — good enough to stop accidental
// runaway loops or basic abuse; not a substitute for a real gateway if you
// expect serious traffic.
if (RATE_LIMIT_MAX > 0) {
  const hits = new Map(); // ip -> { count, resetAt }
  app.use('/api/', (req, res, next) => {
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    const now = Date.now();
    let entry = hits.get(ip);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
      hits.set(ip, entry);
    }
    entry.count++;
    if (entry.count > RATE_LIMIT_MAX) {
      res.setHeader('Retry-After', Math.ceil((entry.resetAt - now) / 1000));
      return res.status(429).json({ error: { message: 'Rate limit exceeded, please slow down.' } });
    }
    next();
  });
  // Periodic cleanup so the map doesn't grow unbounded
  setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of hits) if (now > entry.resetAt) hits.delete(ip);
  }, RATE_LIMIT_WINDOW_MS).unref();
}

// ── Streaming proxy helper ───────────────────────────────────────────────────
//
// Forwards `req` to `upstreamUrl` and pipes the response back to `res`
// untouched — status code, headers (minus hop-by-hop ones), and body
// (including SSE chunks) all pass through as-is. This is what lets
// AI.html's existing `fetch(...).body.getReader()` SSE-parsing loop work
// without any changes.

const HOP_BY_HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade',
  'content-length', // we don't know the final length when proxying streams
  'content-encoding' // avoid double-encoding mismatches; node's fetch already decodes
]);

async function proxyRequest(req, res, { upstreamUrl, method, headers, body }) {
  let upstreamRes;
  try {
    upstreamRes = await fetch(upstreamUrl, {
      method,
      headers,
      body,
      // Forward client aborts (e.g. user clicks "stop generating") upstream
      signal: req._proxyAbortController?.signal
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      // Client disconnected — nothing more to do.
      return;
    }
    console.error(`[proxy] Failed to reach upstream ${upstreamUrl}:`, err.message);
    if (!res.headersSent) {
      res.status(502).json({ error: { message: `Could not reach upstream: ${err.message}` } });
    }
    return;
  }

  res.status(upstreamRes.status);
  for (const [key, value] of upstreamRes.headers.entries()) {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue;
    try { res.setHeader(key, value); } catch { /* some headers can't be set manually; ignore */ }
  }

  if (!upstreamRes.body) {
    res.end();
    return;
  }

  // Node 18+ fetch returns a web ReadableStream; pipe it through manually so
  // partial SSE chunks are flushed to the client as soon as they arrive
  // instead of being buffered.
  const reader = upstreamRes.body.getReader();
  req.on('close', () => {
    // Client disconnected (e.g. stop button) — cancel the upstream read.
    reader.cancel().catch(() => {});
  });

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } catch (err) {
    console.error('[proxy] Stream error:', err.message);
  } finally {
    res.end();
  }
}

function buildUpstreamHeaders(req, { defaultApiKey, extraKeyHeader }) {
  const headers = { 'Content-Type': 'application/json' };

  // Prefer the Authorization the frontend sent (i.e. the user's own key
  // typed into Settings). Fall back to the server's default key if none
  // was provided, so the app is usable out of the box if the operator
  // configures SERVER_API_KEY.
  const incomingAuth = req.get('authorization');
  if (incomingAuth) {
    headers['Authorization'] = incomingAuth;
  } else if (defaultApiKey) {
    headers['Authorization'] = `Bearer ${defaultApiKey}`;
  }

  // Some search providers (Serper) use a custom header instead of Bearer auth.
  if (extraKeyHeader) {
    const incoming = req.get(extraKeyHeader.name);
    if (incoming) {
      headers[extraKeyHeader.name] = incoming;
    } else if (extraKeyHeader.fallback) {
      headers[extraKeyHeader.name] = extraKeyHeader.fallback;
    }
  }

  return headers;
}

// ── /api/chat — OpenAI-compatible chat completions (streaming or not) ──────
//
// The frontend POSTs the exact body it would send to an OpenAI-compatible
// /v1/chat/completions endpoint (model, messages, stream, temperature,
// max_tokens, reasoning_effort, web_search_options, search_options, ...).
// We forward it verbatim. `settings.endpoint` in the app should be set to
// this server's `/api/chat` URL to use this proxy; it can also still be
// pointed directly at any third-party endpoint if you don't want to proxy.

app.post('/api/chat', async (req, res) => {
  const headers = buildUpstreamHeaders(req, { defaultApiKey: SERVER_API_KEY });
  await proxyRequest(req, res, {
    upstreamUrl: CHAT_UPSTREAM,
    method: 'POST',
    headers,
    body: JSON.stringify(req.body)
  });
});

// Allow overriding the upstream per-request via a query param, e.g.
// /api/chat?upstream=https://api.deepseek.com/v1/chat/completions
// This is opt-in (disabled by default) since allowing arbitrary upstream
// URLs from the client is an SSRF risk; only enable if you trust your users
// or run this behind auth.
if (process.env.ALLOW_CUSTOM_UPSTREAM === 'true') {
  app.post('/api/chat-to', async (req, res) => {
    const upstream = req.query.upstream;
    if (!upstream || !/^https?:\/\//.test(upstream)) {
      return res.status(400).json({ error: { message: 'Missing or invalid ?upstream= URL' } });
    }
    const headers = buildUpstreamHeaders(req, { defaultApiKey: SERVER_API_KEY });
    await proxyRequest(req, res, { upstreamUrl: upstream, method: 'POST', headers, body: JSON.stringify(req.body) });
  });
}

// ── /api/search — search provider proxy ─────────────────────────────────────
//
// AI.html's performSearch() supports three shapes:
//   1. Serper.dev: POST JSON { q, num }, auth via X-API-KEY header
//   2. SearXNG-style: GET ?q=...&format=json
//   3. DuckDuckGo Instant Answer: GET ?q=...&format=json (default, CORS-open
//      already, but proxying keeps things consistent and works if DDG ever
//      restricts CORS)
//
// We mirror whichever method the frontend used.

app.post('/api/search', async (req, res) => {
  const headers = buildUpstreamHeaders(req, {
    defaultApiKey: '',
    extraKeyHeader: { name: 'x-api-key', fallback: SEARCH_API_KEY }
  });
  await proxyRequest(req, res, {
    upstreamUrl: SEARCH_UPSTREAM,
    method: 'POST',
    headers,
    body: JSON.stringify(req.body)
  });
});

app.get('/api/search', async (req, res) => {
  const query = req.query.q || '';
  if (!query) return res.json({ AbstractText: '', RelatedTopics: [] });

  try {
    const normalized = await runNormalizedSearch(query);
    res.json(normalized);
  } catch (err) {
    console.error('[search] Error:', err.message);
    res.json({ AbstractText: '', RelatedTopics: [] });
  }
});

// Calls whichever SEARCH_UPSTREAM is configured (Serper, SearXNG, or
// DuckDuckGo Instant Answer) and normalizes the result into DuckDuckGo
// Instant Answer shape — the format AI.html's fallback search-parsing
// branch understands (`AbstractText` + `RelatedTopics[].Text/FirstURL`).
// This means the *server* handles provider differences, and the frontend
// can always just hit plain `GET /api/search?q=...` regardless of which
// provider is configured server-side.
async function runNormalizedSearch(query) {
  if (SEARCH_UPSTREAM.includes('serper.dev')) {
    const headers = { 'Content-Type': 'application/json' };
    if (SEARCH_API_KEY) headers['X-API-KEY'] = SEARCH_API_KEY;
    const r = await fetch(SEARCH_UPSTREAM, { method: 'POST', headers, body: JSON.stringify({ q: query, num: 10 }) });
    if (!r.ok) throw new Error(`Serper ${r.status}`);
    const data = await r.json();
    const topics = (data.organic || []).slice(0, 8).map(item => ({
      Text: `${item.title || ''} - ${item.snippet || ''}`,
      FirstURL: item.link || ''
    }));
    const kg = data.knowledgeGraph;
    return {
      AbstractText: kg ? `${kg.title || ''} - ${kg.description || ''}` : '',
      AbstractURL: kg?.descriptionLink || '',
      RelatedTopics: topics
    };
  }

  if (SEARCH_UPSTREAM.includes('duckduckgo')) {
    const url = new URL(SEARCH_UPSTREAM);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');
    const r = await fetch(url.toString());
    if (!r.ok) throw new Error(`DuckDuckGo ${r.status}`);
    return r.json(); // already in the shape the frontend expects
  }

  // Assume SearXNG-style: GET ?q=&format=json, response shaped { results: [...] }
  const sep = SEARCH_UPSTREAM.includes('?') ? '&' : '?';
  const url = `${SEARCH_UPSTREAM}${sep}q=${encodeURIComponent(query)}&format=json`;
  const headers = {};
  if (SEARCH_API_KEY) headers['Authorization'] = `Bearer ${SEARCH_API_KEY}`;
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`Search ${r.status}`);
  const data = await r.json();
  const topics = (data.results || []).slice(0, 8).map(item => ({
    Text: `${item.title || ''} - ${item.content || ''}`,
    FirstURL: item.url || ''
  }));
  return { AbstractText: '', RelatedTopics: topics };
}

// ── Health check ─────────────────────────────────────────────────────────────

app.get('/healthz', (req, res) => {
  res.json({ ok: true, chatUpstream: CHAT_UPSTREAM, searchUpstream: SEARCH_UPSTREAM, time: new Date().toISOString() });
});

// ── Static frontend ─────────────────────────────────────────────────────────

if (fs.existsSync(FRONTEND_FILE)) {
  app.use(express.static(path.dirname(FRONTEND_FILE)));
  app.get('/', (req, res) => res.sendFile(FRONTEND_FILE));
  // SPA-style fallback for any other GET route that isn't /api/* or a static file
  app.get(/^\/(?!api\/|healthz).*/, (req, res) => res.sendFile(FRONTEND_FILE));
} else {
  console.warn(`[server] Frontend file not found at ${FRONTEND_FILE} — only /api/* routes will work. Set FRONTEND_FILE env var or place AI.html next to server.js.`);
  app.get('/', (req, res) => {
    res.status(404).send('Frontend file not found. Place AI.html next to server.js or set FRONTEND_FILE.');
  });
}

// ── Error handling ───────────────────────────────────────────────────────────

app.use((err, req, res, next) => {
  console.error('[server] Unhandled error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: { message: 'Internal server error' } });
});

// ── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`AI Chat server listening on port ${PORT}`);
  console.log(`  Frontend:      http://localhost:${PORT}/`);
  console.log(`  Chat proxy:    POST http://localhost:${PORT}/api/chat  →  ${CHAT_UPSTREAM}`);
  console.log(`  Search proxy:  /api/search  →  ${SEARCH_UPSTREAM}`);
  console.log(`  Health check:  GET http://localhost:${PORT}/healthz`);
  if (!SERVER_API_KEY) {
    console.log('  No SERVER_API_KEY set — users must enter their own API key in Settings.');
  }
});
