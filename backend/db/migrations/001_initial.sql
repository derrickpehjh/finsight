-- FinSight initial schema
-- Runs automatically via docker-entrypoint-initdb.d on first postgres start

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── Articles: raw ingested news & Reddit posts ────────────────────────────────
CREATE TABLE IF NOT EXISTS articles (
    id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    source       TEXT,
    ticker       TEXT[],                        -- extracted ticker symbols
    headline     TEXT         NOT NULL,
    body         TEXT,
    url          TEXT         UNIQUE,            -- deduplication key
    published_at TIMESTAMPTZ,
    ingested_at  TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_articles_ticker     ON articles USING GIN (ticker);
CREATE INDEX IF NOT EXISTS idx_articles_published  ON articles (published_at DESC);

-- ── Ticker sentiment: FinBERT scores + yfinance market data ──────────────────
CREATE TABLE IF NOT EXISTS ticker_sentiment (
    ticker       TEXT         NOT NULL,
    scored_at    TIMESTAMPTZ  NOT NULL,
    bull_pct     FLOAT        DEFAULT 0,
    bear_pct     FLOAT        DEFAULT 0,
    neutral_pct  FLOAT        DEFAULT 0,
    score        FLOAT        DEFAULT 0,        -- bull_pct − bear_pct ∈ [−1, +1]
    momentum_7d  FLOAT        DEFAULT 0,        -- 7-day price change %
    market_cap   BIGINT       DEFAULT 0,
    sector       TEXT         DEFAULT 'Unknown',
    PRIMARY KEY (ticker, scored_at)
);

CREATE INDEX IF NOT EXISTS idx_sentiment_ticker ON ticker_sentiment (ticker, scored_at DESC);

-- ── Watchlist: user's tracked tickers ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS watchlist (
    user_id   TEXT         NOT NULL,
    ticker    TEXT         NOT NULL,
    added_at  TIMESTAMPTZ  DEFAULT NOW(),
    PRIMARY KEY (user_id, ticker)
);

-- Seed default watchlist
INSERT INTO watchlist (user_id, ticker) VALUES
    ('default', 'NVDA'),
    ('default', 'MSFT'),
    ('default', 'AAPL'),
    ('default', 'TSLA'),
    ('default', 'META'),
    ('default', 'AMZN')
ON CONFLICT DO NOTHING;
