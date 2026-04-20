# FinSight — Design Spec
**Date:** 2026-04-20  
**Status:** Approved

---

## What We're Building

FinSight is a financial news RAG system that scrapes news and Reddit in real time, scores sentiment with FinBERT, and lets users ask natural-language questions about any stock ("Why is NVDA up today?"). The centerpiece UI is a **2D Sentiment-Momentum Scatter Plot** — every stock is positioned by how bullish its news is (X) and whether its price is actually rising (Y), making the market readable at a glance.

**Audience:** Portfolio project / resume demo. Runs locally, accessible publicly via ngrok + Vercel.

---

## Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| LLM inference | Ollama `llama3.1:8b` | Local GPU (RTX 3080 10 GB VRAM), no API cost |
| Embeddings | Ollama `nomic-embed-text` | Fast, local, same Ollama daemon |
| Sentiment scoring | `ProsusAI/finbert` (HuggingFace) | Finance-specific BERT, 10× faster than LLM for batch |
| Vector DB | Qdrant | Hybrid search, production-ready, better than ChromaDB |
| RAG orchestration | LlamaIndex | Manages VectorStoreIndex + query engine |
| Metadata DB | Supabase (Postgres) | Articles, sentiment scores, watchlist |
| Cache + queue | Redis | TTL cache for `/stocks/overview`; task queue between ingester and processor |
| News sources | NewsAPI + PRAW (Reddit) | Reuters/Bloomberg keywords + WSB/r/stocks/r/investing |
| Market data | yfinance | Live price, momentum, market cap, sector |
| NER | spaCy + regex | Ticker extraction from raw article text |
| Scheduler | APScheduler | 15-minute ingestion cycles |
| API | FastAPI | REST endpoints + CORS for Vercel frontend |
| Frontend | Next.js + react-three-fiber | Scatter plot canvas + shadcn/ui + Aceternity |
| Deployment | Vercel (frontend) + ngrok static domain (backend) | Free, public URL, no domain purchase |
| Orchestration | Docker Compose | 6 local services |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  DATA SOURCES                                                    │
│  NewsAPI (Reuters/Bloomberg) ──┐                                │
│  PRAW (r/WSB, r/stocks)  ──────┤→ Ingester (APScheduler 15min) │
└─────────────────────────────────────────────────────────────────┘
              │
              ▼ article IDs pushed to Redis queue
┌─────────────────────────────────────────────────────────────────┐
│  PROCESSING PIPELINE                                             │
│  spaCy NER → extract tickers                                    │
│  FinBERT → batch sentiment scores                               │
│  LlamaIndex → nomic-embed-text → Qdrant upsert                 │
│  Supabase → store articles + ticker_sentiment                   │
└─────────────────────────────────────────────────────────────────┘
              │
              ▼ on API request
┌─────────────────────────────────────────────────────────────────┐
│  FASTAPI BACKEND                                                 │
│  GET /stocks/overview   → Redis TTL cache (5 min)               │
│  GET /stocks/{ticker}   → sentiment + news + yfinance           │
│  POST /rag/query        → LlamaIndex + Ollama llama3.1:8b       │
│  GET /news              → paginated article feed                │
└─────────────────────────────────────────────────────────────────┘
              │ ngrok static domain tunnel
              ▼
┌─────────────────────────────────────────────────────────────────┐
│  NEXT.JS FRONTEND (Vercel)                                       │
│  Scatter plot (react-three-fiber orthographic camera)           │
│  Right panel — sentiment score ring, news feed, RAG query box   │
│  Left sidebar — watchlist + sector filters                      │
│  Aceternity SparklesCore background + Spotlight cursor          │
└─────────────────────────────────────────────────────────────────┘
```

---

## Visualization: 2D Sentiment-Momentum Scatter Plot

The core UI insight: **position = meaning**. No legend-reading required.

- **X-axis** — Sentiment Score (−1 bearish → +1 bullish): weighted average of FinBERT scores across all news articles for that ticker in the selected time window
- **Y-axis** — 7-day price momentum (%): from yfinance
- **Bubble size** — Market cap (sqrt-proportional, so area encodes value)
- **Bubble color** — Sector (Tech=cyan, Energy=green, Finance=amber, Health=violet)
- **Quadrant zones** (named in chart corners):
  - Top-right: **BUY ZONE** — bullish news + rising price
  - Top-left: **RECOVERING** — bearish news but price rising (contrarian signal)
  - Bottom-right: **CORRECTION?** — bullish news but falling (possible dip-buy)
  - Bottom-left: **AVOID** — bearish news + falling price
- **"How to read" button** — collapsible 4-line guide overlay

---

## Database Schema

```sql
CREATE TABLE articles (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source       TEXT,              -- 'reuters' | 'reddit' | 'wsb'
  ticker       TEXT[],            -- extracted tickers
  headline     TEXT NOT NULL,
  body         TEXT,
  url          TEXT UNIQUE,
  published_at TIMESTAMPTZ,
  ingested_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE ticker_sentiment (
  ticker       TEXT NOT NULL,
  scored_at    TIMESTAMPTZ NOT NULL,
  bull_pct     FLOAT,
  bear_pct     FLOAT,
  neutral_pct  FLOAT,
  score        FLOAT,             -- net: bull_pct − bear_pct
  momentum_7d  FLOAT,             -- from yfinance
  market_cap   BIGINT,
  sector       TEXT,
  PRIMARY KEY (ticker, scored_at)
);

CREATE TABLE watchlist (
  user_id      TEXT NOT NULL,     -- 'default' for MVP
  ticker       TEXT NOT NULL,
  added_at     TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (user_id, ticker)
);
```

---

## API Endpoints

| Method | Path | Response | Notes |
|--------|------|----------|-------|
| GET | `/health` | `{status:"ok"}` | ngrok health check |
| GET | `/stocks/overview` | Array of scatter data | Redis cache 5 min |
| GET | `/stocks/{ticker}` | Detail + news + sentiment history | — |
| POST | `/rag/query` | `{answer, sources[]}` | Streams via SSE |
| GET | `/news` | Paginated articles | `?ticker=&limit=&offset=` |
| GET | `/watchlist` | User's watchlist | — |
| POST | `/watchlist/{ticker}` | Add to watchlist | — |
| DELETE | `/watchlist/{ticker}` | Remove from watchlist | — |

`GET /stocks/overview` response shape (drives scatter plot):
```json
[{
  "ticker": "NVDA",
  "sentiment_score": 0.72,
  "momentum_7d": 3.21,
  "market_cap": 2100000000000,
  "sector": "Technology",
  "bull_pct": 0.68,
  "bear_pct": 0.14,
  "price": 875.40,
  "change_pct": 3.21
}]
```

---

## Docker Compose Services

| Service | Image | Port |
|---------|-------|------|
| `postgres` | supabase/postgres | 5432 |
| `qdrant` | qdrant/qdrant | 6333 |
| `redis` | redis:alpine | 6379 |
| `ollama` | ollama/ollama (GPU) | 11434 |
| `backend` | ./backend | 8000 |
| `ngrok` | ngrok/ngrok | 4040 |

Ollama pulls `nomic-embed-text` and `llama3.1:8b` on first start via entrypoint script.

---

## Frontend Components

```
src/
├── app/
│   ├── layout.tsx          — SparklesCore background, Spotlight cursor
│   └── page.tsx            — root layout: sidebar + scatter + panel
├── components/
│   ├── scatter/
│   │   ├── StockScatter.tsx      — react-three-fiber OrthographicCamera
│   │   ├── StockBubble.tsx       — individual sphere mesh + hover state
│   │   └── QuadrantLabels.tsx    — Html overlay for zone names
│   ├── panel/
│   │   ├── StockPanel.tsx        — right detail panel
│   │   ├── SentimentBar.tsx      — bull/neutral/bear progress bar
│   │   └── NewsFeed.tsx          — article list with source badges
│   └── sidebar/
│       └── Watchlist.tsx         — ticker list + sector filter
├── hooks/
│   ├── useStocksOverview.ts      — SWR, refreshInterval: 60000
│   └── useStockDetail.ts         — single ticker detail + RAG
└── lib/
    ├── api.ts                    — Axios base → NEXT_PUBLIC_API_URL
    └── types.ts                  — StockOverview, StockDetail, Article
```

---

## Deployment

```bash
# Local (everything except frontend)
docker compose up -d

# Frontend → Vercel
# 1. Push frontend/ to GitHub
# 2. Import in Vercel dashboard
# 3. Set env: NEXT_PUBLIC_API_URL=https://<your-ngrok-domain>.ngrok-free.app
# 4. Deploy → finsight.vercel.app
```

ngrok config (in docker-compose.yml):
```yaml
ngrok:
  image: ngrok/ngrok:latest
  command: http --domain=<static-domain>.ngrok-free.app 8000
  environment:
    - NGROK_AUTHTOKEN=${NGROK_AUTHTOKEN}
```

---

## Design System

Carried from approved mockup (`frontend-viz-fix.html`):

| Token | Value | Use |
|-------|-------|-----|
| `--bg` | `#000000` | Page background |
| `--cyan` | `#06b6d4` | Primary accent, Tech sector |
| `--bull` | `#34d399` | Bullish, rising, Energy sector |
| `--bear` | `#fb7185` | Bearish, falling |
| `--amb` | `#fbbf24` | Finance sector |
| `--vio` | `#a78bfa` | Health sector, neutral |
| `--c1` | `#f1f5f9` | Primary text |
| `--c2` | `#cbd5e1` | Secondary text |
| `--c3` | `#94a3b8` | Tertiary text |
| `--c4` | `#475569` | Decorative / disabled |

Fonts: **Orbitron 900** (brand), **Manrope** (body), **Fira Code** (mono/numbers)
