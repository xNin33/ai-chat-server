# AI Chat — Full-Stack AI Chat Application

A complete, self-hostable AI chat application with a rich frontend and a lightweight Node.js backend proxy. Deploy it anywhere, use it with any OpenAI-compatible API, and keep your data private — everything stays in your browser's IndexedDB.

## Features

### Frontend
- **Multi-session management** — create, rename, delete, and organize conversations with automatic date grouping
- **Message editing & branching** — edit any user message and the conversation forks into a new branch; switch between branches freely
- **AI reply versioning** — regenerate responses and toggle between multiple AI reply versions without losing context
- **Streaming responses** — real-time character-by-character output with smooth fade-in animation
- **Thinking/reasoning display** — shows chain-of-thought (when supported by the model) in a collapsible panel
- **Web search integration** — supports both API-native search (OpenAI, DeepSeek) and manual search (Serper, SearXNG, DuckDuckGo)
- **Multi-modal input** — drag & drop, paste, or click to attach images and files; automatic vision capability detection
- **Rich rendering** — Markdown, code highlighting (with copy button), LaTeX/KaTeX math, and image lightbox
- **Dark/light theme** — follows system preference or manual toggle
- **Export conversations** — export any chat as Markdown
- **Fully client-side** — all data stored locally in IndexedDB; no cloud upload

### Backend Proxy
- **Transparent chat proxy** — forwards OpenAI-compatible requests without modification; preserves SSE streaming
- **Flexible upstream** — works with OpenAI, DeepSeek, OpenRouter, Ollama, or any compatible endpoint
- **Search proxy** — normalizes responses from Serper, SearXNG, or DuckDuckGo into a unified format
- **Server-side API key** — optional fallback key so users don't need to enter their own
- **Rate limiting** — per-IP protection against abuse
- **Docker ready** — one-command deployment
- **Zero state** — stateless backend, horizontally scalable

## Quick Start

### Prerequisites
- Node.js 18+
- npm

### Local Development

```bash
# Clone the repository
git clone <your-repo-url>
cd ai-chat

# Start the backend server
cd server
npm install
cp .env.example .env
# Edit .env with your upstream endpoints and API keys
npm start

# Open http://localhost:3000
```

### Docker

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

## Project Structure

```
ai-chat/
├── AI.html              # Frontend entry point (HTML structure)
├── style.css            # Complete styling with dark/light themes
├── script.js            # Frontend application logic (2000+ lines)
├── server/              # Backend proxy server
│   ├── server.js        # Main server (250 lines)
│   ├── package.json     # Dependencies (express only)
│   ├── .env.example     # Configuration template
│   ├── Dockerfile       # Container build
│   ├── docker-compose.yml
│   └── README.md        # Server-specific documentation
└── README.md            # This file
```

## Configuration

### Frontend Settings (in-app)

The frontend has a **Settings** panel where users can configure:

| Setting | Description |
|---------|-------------|
| API Endpoint | OpenAI-compatible chat URL (default: `/api/chat` to use the proxy) |
| API Key | Your API key (optional if `SERVER_API_KEY` is set on the backend) |
| Model | Model name (e.g., `gpt-4o`, `deepseek-chat`, `llama3`) |
| Max Tokens | Response length limit |
| Temperature | Creativity/randomness control (0–2) |
| System Prompt | Custom instructions for the AI |
| Reasoning | Enable chain-of-thought (DeepSeek/OpenAI o1-style) |
| Web Search | Toggle search integration |
| Search Mode | `API Native` (uses upstream's search) or `Manual` (frontend calls search proxy) |

### Backend Environment Variables

Create a `.env` file in the `server/` directory (copy from `.env.example`):

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `CHAT_UPSTREAM` | `https://api.openai.com/v1/chat/completions` | Real chat API endpoint |
| `SERVER_API_KEY` | _(empty)_ | Fallback API key (user-entered key takes priority) |
| `SEARCH_UPSTREAM` | `https://api.duckduckgo.com/` | Search provider (Serper, SearXNG, DuckDuckGo) |
| `SEARCH_API_KEY` | _(empty)_ | API key for search provider (e.g., Serper) |
| `RATE_LIMIT_MAX` | `60` | Requests per IP per minute; `0` to disable |
| `BODY_LIMIT` | `50mb` | Max request size (for image/file uploads) |
| `ALLOW_CUSTOM_UPSTREAM` | `false` | Allow clients to override upstream URL (SSRF risk) |

## Architecture

### Frontend

The frontend is a **single-page application** built with vanilla JavaScript:

- **IndexedDB** for persistent storage (conversations, settings, theme)
- **Streaming SSE parser** for real-time AI responses
- **morphdom** for efficient DOM updates during streaming
- **marked.js** for Markdown rendering
- **KaTeX** for math formula rendering
- **highlight.js** for code syntax highlighting

Key design features:
- **Fork system** — two independent axes: user message edits and AI reply versions
- **Auto-scroll** — intelligently follows streaming output
- **Progress indicators** — message navigation dots and scroll position tracking
- **Responsive** — works on desktop and mobile

### Backend Proxy

The backend is a **transparent proxy** that:

1. Receives requests from the frontend (same JSON shape as OpenAI)
2. Forwards them to the configured upstream
3. Pipes responses back **unchanged** — including SSE streams
4. Normalizes search responses from different providers into a unified format

This design means:
- The frontend doesn't need to know which AI provider is being used
- The backend doesn't need to parse or modify the stream
- Both can be updated independently

```
┌─────────────────────────────────────────────────────────────────┐
│                         Browser                                 │
│  ┌─────────────┐    ┌─────────────┐    ┌──────────────────┐     │
│  │  AI.html    │    │  script.js  │    │  style.css       │     │
│  │  (UI shell) │──> │  (logic)    │──> │  (theming)       │     │
│  └─────────────┘    └───────┬─────┘    └──────────────────┘     │
│                             │                                   │
│                         IndexedDB                               │
│                      (local storage)                            │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              │ POST /api/chat (SSE stream)
                              │ GET  /api/search
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    server.js (Proxy)                            │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  /api/chat  ──>  CHAT_UPSTREAM  (OpenAI/DeepSeek/etc)    │   │
│  │  /api/search ──>  SEARCH_UPSTREAM (Serper/SearXNG/DDG)   │   │
│  │  /           ──>  serves static frontend                 │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

## Security Notes

- **API keys** are stored in the browser's IndexedDB (encrypted only by browser storage). Never commit keys to version control.
- **No user authentication** — the server proxies requests without user management. Put it behind a reverse proxy with basic auth, VPN, or Cloudflare Access if needed.
- **Server-side API key** is optional. If omitted, each user must enter their own key in Settings.
- **Custom upstream** is disabled by default to prevent SSRF attacks. Only enable `ALLOW_CUSTOM_UPSTREAM` if you trust your users or have additional authentication.
- **Rate limiting** is per-IP, in-memory, and suitable for personal/small-team use only.

## Deployment

### Any Node.js Platform

The backend works on Render, Railway, Fly.io, Heroku, or any VPS with Node.js:

```bash
cd server
npm install
npm start
```

### Environment Variables on Deployment Platforms

Most platforms let you set environment variables through their dashboard or CLI. Use the same variables as described in the `.env.example` file.

### Using a Different Frontend Path

If you've renamed or moved `AI.html`, set `FRONTEND_FILE`:

```bash
FRONTEND_FILE=/path/to/your/frontend.html npm start
```

## Usage Guide

1. **Start the server** — `npm start` in the `server/` directory
2. **Open your browser** — navigate to `http://localhost:3000`
3. **Configure settings** — click the Settings button (gear icon in sidebar) to set your API endpoint and key
4. **Start chatting** — type a message and press Enter
5. **Upload files** — drag & drop, paste, or click the attachment button
6. **Edit messages** — hover over a user message and click Edit
7. **Regenerate** — hover over an AI message and click Regenerate
8. **Switch branches** — use the `<` / `>` buttons on edited or regenerated messages
9. **Export** — click Export in the header to save the current conversation as Markdown

## Development

### Frontend Development

The frontend is plain HTML/CSS/JS — no build step required. Edit `AI.html`, `style.css`, or `script.js` and refresh the browser.

### Backend Development

```bash
cd server
npm install
npm run dev  # if you add nodemon, or just npm start
```

### Adding a New Search Provider

Add a new branch to `runNormalizedSearch()` in `server.js` that detects your provider's URL and transforms its response into the DuckDuckGo format (`{ AbstractText, RelatedTopics: [{ Text, FirstURL }] }`).

## Contributing

This project is primarily a personal tool, but contributions are welcome. Please open an issue first to discuss any significant changes.

## License

MIT

---

## Acknowledgments

- Built with [marked.js](https://marked.js.org/), [KaTeX](https://katex.org/), [highlight.js](https://highlightjs.org/), [morphdom](https://github.com/patrick-steele-idem/morphdom)
- Inspired by the need for a private, self-hostable AI chat interface

---

**Author:** Prelude
