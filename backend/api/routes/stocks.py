import json
import asyncio
import logging
from typing import Any, Optional

import asyncpg
from fastapi import APIRouter, Depends, Query
from redis.asyncio import Redis

from api.deps import get_redis, get_db
from services.price_fetcher import get_batch_prices

logger = logging.getLogger(__name__)
router = APIRouter()

# Core ticker universe always tracked by the scatter plot
TRACKED_TICKERS = [
    "NVDA", "MSFT", "AAPL", "AMD", "AMZN", "GOOGL", "META", "TSLA",
    "JPM", "GS", "BAC", "XOM", "CVX", "NFLX", "CRM", "PLTR",
]

OVERVIEW_CACHE_KEY = "stocks:overview"
OVERVIEW_TTL = 60   # 1 minute — keeps timeframe switches feeling fresh

WATCHLIST_USER = "default"


async def _fetch_prices(tickers: list[str]) -> dict[str, dict]:
    """Fetch live intraday prices via direct Yahoo Finance API (thread pool)."""
    return await asyncio.get_event_loop().run_in_executor(
        None, get_batch_prices, tickers
    )


async def _all_tickers(db: asyncpg.Pool) -> list[str]:
    """
    Return the union of TRACKED_TICKERS and all tickers the user has watchlisted.
    This ensures watchlisted tickers always appear in the scatter plot.
    """
    rows = await db.fetch(
        "SELECT DISTINCT ticker FROM watchlist WHERE user_id = $1",
        WATCHLIST_USER,
    )
    watchlist = {r["ticker"] for r in rows}
    combined = list(set(TRACKED_TICKERS) | watchlist)
    return combined


_TIMEFRAME_INTERVALS: dict[str, str] = {
    "1H": "1 hour",
    "4H": "4 hours",
    "1D": "1 day",
    "1W": "7 days",
}


@router.get("/overview")
async def stocks_overview(
    redis: Redis = Depends(get_redis),
    db: asyncpg.Pool = Depends(get_db),
    timeframe: Optional[str] = Query(default=None, description="1H | 4H | 1D | 1W"),
) -> list[dict]:
    """
    Scatter plot data for all tracked + watchlisted tickers, optionally filtered by time window.
    Shape: [{ticker, sentiment_score, momentum_7d, market_cap, sector, ...}]
    Cached for 1 minute in Redis (per timeframe bucket).
    """
    tf_key = timeframe if timeframe in _TIMEFRAME_INTERVALS else None
    cache_key = f"{OVERVIEW_CACHE_KEY}:{tf_key or 'latest'}"

    cached = await redis.get(cache_key)
    if cached:
        return json.loads(cached)

    # Combine hardcoded tickers + user's watchlist
    tickers = await _all_tickers(db)
    interval = _TIMEFRAME_INTERVALS.get(tf_key or "", "")

    if tf_key and interval:
        # interval is validated against whitelist above — safe to embed in SQL
        # asyncpg doesn't support ::interval casts on parameters, so we embed the
        # literal interval string directly (values come only from _TIMEFRAME_INTERVALS).
        rows_task = db.fetch(f"""
            WITH windowed AS (
                SELECT
                    ticker,
                    AVG(bull_pct)    AS bull_pct,
                    AVG(bear_pct)    AS bear_pct,
                    AVG(neutral_pct) AS neutral_pct,
                    AVG(score)       AS score,
                    MAX(momentum_7d) AS momentum_7d,
                    MAX(market_cap)  AS market_cap,
                    MAX(sector)      AS sector,
                    COUNT(*)         AS window_count
                FROM ticker_sentiment
                WHERE ticker = ANY($1::text[])
                  AND scored_at >= NOW() - INTERVAL '{interval}'
                GROUP BY ticker
            ),
            latest AS (
                SELECT DISTINCT ON (ticker)
                    ticker, bull_pct, bear_pct, neutral_pct, score,
                    momentum_7d, market_cap, sector
                FROM ticker_sentiment
                WHERE ticker = ANY($1::text[])
                ORDER BY ticker, scored_at DESC
            )
            SELECT
                l.ticker,
                COALESCE(w.bull_pct,    l.bull_pct)    AS bull_pct,
                COALESCE(w.bear_pct,    l.bear_pct)    AS bear_pct,
                COALESCE(w.neutral_pct, l.neutral_pct) AS neutral_pct,
                COALESCE(w.score,       l.score)        AS score,
                COALESCE(w.momentum_7d, l.momentum_7d)  AS momentum_7d,
                COALESCE(w.market_cap,  l.market_cap)   AS market_cap,
                COALESCE(w.sector,      l.sector)        AS sector,
                COALESCE(w.window_count, 0)              AS window_count
            FROM latest l
            LEFT JOIN windowed w ON w.ticker = l.ticker
        """, tickers)
    else:
        # Default: latest sentiment row per ticker (window_count = 1 = "latest only")
        rows_task = db.fetch("""
            SELECT DISTINCT ON (ticker)
                ticker, bull_pct, bear_pct, neutral_pct, score,
                momentum_7d, market_cap, sector, 1 AS window_count
            FROM ticker_sentiment
            WHERE ticker = ANY($1::text[])
            ORDER BY ticker, scored_at DESC
        """, tickers)

    prices_task = _fetch_prices(tickers)
    rows, prices = await asyncio.gather(rows_task, prices_task)

    if prices:
        logger.info(f"Live prices fetched for {len(prices)}/{len(tickers)} tickers (timeframe={tf_key})")
    else:
        logger.warning("No live price data fetched — all prices will be 0.0")

    result: list[dict[str, Any]] = []
    tickers_with_data: set[str] = set()

    for row in rows:
        t     = row["ticker"]
        pdata = prices.get(t, {})
        tickers_with_data.add(t)
        result.append({
            "ticker":          t,
            "sentiment_score": round(float(row["score"]       or 0), 4),
            "momentum_7d":     round(float(row["momentum_7d"] or 0), 4),
            "market_cap":      int(row["market_cap"] or 0),
            "sector":          row["sector"] or "Unknown",
            "bull_pct":        round(float(row["bull_pct"]    or 0), 4),
            "bear_pct":        round(float(row["bear_pct"]    or 0), 4),
            "neutral_pct":     round(float(row["neutral_pct"] or 0), 4),
            "price":           round(pdata.get("price",      0.0), 2),
            "change_pct":      round(pdata.get("change_pct", 0.0), 2),
            # How many scored rows were in the selected time window (0 = fell back to latest)
            "window_count":    int(row["window_count"] or 0),
        })

    # Add watchlisted tickers that have no sentiment data yet.
    # Always include them so they appear in the sidebar; price may be 0 if YF has no data.
    for t in tickers:
        if t in tickers_with_data:
            continue
        pdata = prices.get(t, {})
        result.append({
            "ticker":          t,
            "sentiment_score": 0.0,
            "momentum_7d":     round(float(pdata.get("change_pct", 0.0)), 4),
            "market_cap":      int(pdata.get("market_cap", 0)),
            "sector":          pdata.get("sector", "Unknown"),
            "bull_pct":        0.0,
            "bear_pct":        0.0,
            "neutral_pct":     1.0,
            "price":           round(float(pdata.get("price", 0.0)), 2),
            "change_pct":      round(float(pdata.get("change_pct", 0.0)), 2),
            "window_count":    0,
        })
        logger.info(f"Added watchlist ticker {t} to overview (price={pdata.get('price', 0)}, no sentiment yet)")

    await redis.setex(cache_key, OVERVIEW_TTL, json.dumps(result))
    return result


@router.get("/{ticker}")
async def stock_detail(
    ticker: str,
    db: asyncpg.Pool = Depends(get_db),
) -> dict:
    """Detail for a single ticker: sentiment history + recent articles."""
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
    if "scored_at" in latest and latest["scored_at"]:
        latest["scored_at"] = latest["scored_at"].isoformat()

    return {
        "ticker":            ticker,
        "latest_sentiment":  latest,
        "sentiment_history": [
            {**dict(r), "scored_at": r["scored_at"].isoformat() if r["scored_at"] else None}
            for r in sentiment_rows
        ],
        "articles": [
            {**dict(r), "published_at": r["published_at"].isoformat() if r["published_at"] else None}
            for r in article_rows
        ],
    }
