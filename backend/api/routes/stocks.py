import json
import asyncio
import logging
from typing import Any

import asyncpg
import yfinance as yf
from fastapi import APIRouter, Depends
from redis.asyncio import Redis

from api.deps import get_redis, get_db

logger = logging.getLogger(__name__)
router = APIRouter()

# Default ticker universe tracked by the scatter plot
TRACKED_TICKERS = [
    "NVDA", "MSFT", "AAPL", "AMD", "AMZN", "GOOGL", "META", "TSLA",
    "JPM", "GS", "BAC", "XOM", "CVX", "NFLX", "CRM", "PLTR",
]

OVERVIEW_CACHE_KEY = "stocks:overview"
OVERVIEW_TTL = 300  # 5 minutes


async def _fetch_yfinance(tickers: list[str]) -> dict[str, dict]:
    """Run yfinance in thread pool (it's synchronous)."""
    def _sync():
        result: dict[str, dict] = {}
        try:
            data = yf.download(
                " ".join(tickers),
                period="1d",
                interval="5m",
                progress=False,
                group_by="ticker",
                auto_adjust=True,
            )
            for t in tickers:
                try:
                    closes = data[t]["Close"].dropna()
                    opens = data[t]["Open"].dropna()
                    if len(closes) and len(opens):
                        result[t] = {
                            "price": float(closes.iloc[-1]),
                            "change_pct": (float(closes.iloc[-1]) - float(opens.iloc[0])) / float(opens.iloc[0]) * 100,
                        }
                except (KeyError, IndexError):
                    pass
        except Exception as e:
            logger.warning(f"yfinance batch download failed: {e}")
        return result

    return await asyncio.get_event_loop().run_in_executor(None, _sync)


@router.get("/overview")
async def stocks_overview(
    redis: Redis = Depends(get_redis),
    db: asyncpg.Pool = Depends(get_db),
) -> list[dict]:
    """
    Scatter plot data for all tracked tickers.
    Shape: [{ticker, sentiment_score, momentum_7d, market_cap, sector, ...}]
    Cached for 5 minutes in Redis.
    """
    cached = await redis.get(OVERVIEW_CACHE_KEY)
    if cached:
        return json.loads(cached)

    # Latest sentiment row per ticker
    rows = await db.fetch("""
        SELECT DISTINCT ON (ticker)
            ticker, bull_pct, bear_pct, neutral_pct, score,
            momentum_7d, market_cap, sector
        FROM ticker_sentiment
        WHERE ticker = ANY($1::text[])
        ORDER BY ticker, scored_at DESC
    """, TRACKED_TICKERS)

    # Live price from yfinance (parallel to DB query)
    prices = await _fetch_yfinance(TRACKED_TICKERS)

    result: list[dict[str, Any]] = []
    for row in rows:
        t = row["ticker"]
        pdata = prices.get(t, {})
        result.append({
            "ticker":           t,
            "sentiment_score":  round(float(row["score"] or 0), 4),
            "momentum_7d":      round(float(row["momentum_7d"] or 0), 4),
            "market_cap":       int(row["market_cap"] or 0),
            "sector":           row["sector"] or "Unknown",
            "bull_pct":         round(float(row["bull_pct"] or 0), 4),
            "bear_pct":         round(float(row["bear_pct"] or 0), 4),
            "neutral_pct":      round(float(row["neutral_pct"] or 0), 4),
            "price":            round(pdata.get("price", 0.0), 2),
            "change_pct":       round(pdata.get("change_pct", 0.0), 2),
        })

    await redis.setex(OVERVIEW_CACHE_KEY, OVERVIEW_TTL, json.dumps(result))
    return result


@router.get("/{ticker}")
async def stock_detail(
    ticker: str,
    db: asyncpg.Pool = Depends(get_db),
) -> dict:
    """
    Detail for a single ticker: sentiment history + recent articles.
    """
    ticker = ticker.upper()

    sentiment_rows = await db.fetch("""
        SELECT bull_pct, bear_pct, neutral_pct, score, momentum_7d, scored_at
        FROM ticker_sentiment
        WHERE ticker = $1
        ORDER BY scored_at DESC
        LIMIT 48
    """, ticker)

    article_rows = await db.fetch("""
        SELECT id::text, headline, source, published_at, url
        FROM articles
        WHERE $1 = ANY(ticker)
        ORDER BY published_at DESC
        LIMIT 20
    """, ticker)

    latest = dict(sentiment_rows[0]) if sentiment_rows else {}
    # scored_at is datetime — convert to ISO string for JSON
    if "scored_at" in latest and latest["scored_at"]:
        latest["scored_at"] = latest["scored_at"].isoformat()

    return {
        "ticker":             ticker,
        "latest_sentiment":   latest,
        "sentiment_history":  [
            {**dict(r), "scored_at": r["scored_at"].isoformat() if r["scored_at"] else None}
            for r in sentiment_rows
        ],
        "articles": [
            {**dict(r), "published_at": r["published_at"].isoformat() if r["published_at"] else None}
            for r in article_rows
        ],
    }
