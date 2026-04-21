# FinSight — Setup Guide

FinSight is a local-first financial sentiment dashboard. It ingests news from multiple sources, runs FinBERT sentiment analysis, stores vectors in Qdrant, and serves a real-time Next.js frontend — all running on your machine with your GPU.

---

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Docker Desktop | ≥ 4.25 | With WSL2 backend on Windows |
| NVIDIA GPU | RTX 3070+ recommended | For Ollama (llama3.1:8b) |
| NVIDIA Container Toolkit | latest | Enables GPU passthrough to Docker |
| Node.js | ≥ 20 | Only needed for local dev outside Docker |
| Python | ≥ 3.11 | Only needed for local dev outside Docker |

---

## Quick Start (Docker — recommended)

### 1. Clone and configure

```bash
git clone <repo-url>
cd finsight
cp .env.example .env   # or edit .env directly
```

### 2. Fill in `.env`

```env
# Required for multi-source news ingestion
NEWSAPI_KEY=your_key_here        # Free at https://newsapi.org/register

# Required for public URL (optional — skip if running locally only)
NGROK_AUTHTOKEN=your_token       # https://dashboard.ngrok.com/tunnels/authtokens
NGROK_DOMAIN=your-domain.ngrok-free.dev  # https://dashboard.ngrok.com/domains
```

### 3. Start all services

```bash
# Local access only (http://localhost:3001)
docker compose up --build

# With public URL via ngrok
docker compose up --build frontend ngrok
```

> **First run note:** Ollama pulls `nomic-embed-text` (~300 MB) and `llama3.1:8b` (~4.7 GB) on startup. This takes 5–10 minutes depending on your connection. Subsequent starts are instant.

### 4. Open the app

- **Local:** http://localhost:3001
- **Public:** https://your-domain.ngrok-free.dev (first visit shows a one-time ngrok warning — click "Visit Site")

---

## Services & Ports

| Service | Port | Description |
|---|---|---|
| **Frontend** (Next.js) | 3001 | Dashboard UI — proxies all API calls to backend |
| **Backend** (FastAPI) | 8000 | REST API, background ingestion, RAG queries |
| **Postgres** | 5432 | Article metadata, watchlist, ticker_sentiment |
| **Qdrant** | 6333 | Vector embeddings for semantic RAG search |
| **Redis** | 6379 | API response cache (60s TTL), task queue |
| **Ollama** | 11434 | Local LLM (llama3.1:8b) + embeddings (nomic-embed-text) |
| **ngrok** | 4040 | Tunnel dashboard (optional) |

---

## Architecture Overview

```
News Sources                  Backend Pipeline                  Frontend
────────────                  ────────────────                  ────────
Yahoo Finance RSS  ──┐
Benzinga RSS       ──┤  Ingester  →  Postgres (articles)
Reuters RSS        ──┤  (every       ↓
NewsAPI            ──┤   5 min)   Processor → FinBERT → ticker_sentiment
Reddit (public)    ──┘              ↓
                                 Qdrant (vectors)
                                    ↓
                              FastAPI REST API  ←──  Next.js (port 3001)
                              /stocks/overview       Scatter plot
                              /news?ticker=X         Network graph
                              /rag/query             Heatmap
                              /watchlist             RAG Analyst
                                    ↑
                                 Redis cache
```

---

## Environment Variables Reference

| Variable | Required | Default | Description |
|---|---|---|---|
| `NEWSAPI_KEY` | No | _(blank)_ | NewsAPI.org key — blank skips NewsAPI source |
| `NGROK_AUTHTOKEN` | For public URL | _(blank)_ | ngrok authentication token |
| `NGROK_DOMAIN` | For public URL | _(blank)_ | Static ngrok domain |
| `DATABASE_URL` | Auto | postgres://… | Set by docker-compose |
| `QDRANT_URL` | Auto | http://qdrant:6333 | Set by docker-compose |
| `REDIS_URL` | Auto | redis://redis:6379 | Set by docker-compose |
| `OLLAMA_URL` | Auto | http://ollama:11434 | Set by docker-compose |

---

## Adding Tickers to Your Watchlist

Search for any ticker in the sidebar search box and click `+`. The ingester will start pulling Yahoo Finance RSS for that ticker within the next cycle (~5 min). Sentiment data populates after articles are processed by FinBERT.

---

## Local Development (without Docker)

If you want hot-reload for active development:

### Backend

```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

Requires Postgres, Redis, Qdrant, and Ollama running locally or via Docker:

```bash
docker compose up postgres redis qdrant ollama
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

The frontend uses `.env.local` to point directly at `http://localhost:8000` in dev mode, bypassing the Next.js proxy.

---

## Rebuilding After Code Changes

```bash
# Backend changes (Python) — hot-reload via volume mount, no rebuild needed
# Frontend changes (TypeScript/TSX) — must rebuild:
docker compose up --build frontend ngrok
```

> **Why frontend needs a rebuild:** Next.js bakes route rewrites (including the backend proxy URL) into the build at compile time. Runtime environment variables don't apply to rewrite destinations in standalone mode.

---

## Useful Commands

```bash
# View logs for a specific service
docker compose logs backend --tail 50 -f
docker compose logs frontend --tail 30

# Install a new Python package without full rebuild
docker compose exec backend pip install <package>
docker compose restart backend

# Check which Ollama models are loaded
docker compose exec ollama ollama list

# Flush Redis cache (forces fresh API responses)
docker compose exec redis redis-cli FLUSHDB

# Connect to Postgres
docker compose exec postgres psql -U finsight -d finsight
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Frontend shows no tickers | Backend not ready yet | Wait ~60s for Ollama model load; check `docker compose logs backend` |
| RAG returns "no info" | Qdrant not indexed yet | Articles appear in Summary tab first; RAG fallback uses Postgres directly |
| ngrok tunnel offline | NGROK_AUTHTOKEN/DOMAIN missing | Fill both in `.env`, then `docker compose up ngrok` |
| Port 3000 already in use | Local dev server running | Frontend mapped to 3001 in docker-compose; stop local server or use 3001 |
| GPU not detected by Ollama | NVIDIA Container Toolkit missing | Install from https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html |
| feedparser import error | Not installed in container | `docker compose exec backend pip install feedparser==6.0.11 && docker compose restart backend` |
