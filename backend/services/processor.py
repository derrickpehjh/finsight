"""
Background processor: consumes article IDs from Redis queue,
runs FinBERT sentiment scoring, fetches yfinance momentum/market cap,
and upserts into ticker_sentiment.
"""
import logging
import threading
import time
import asyncio
from datetime import datetime, timezone

import psycopg2
import redis as syncredis
import yfinance as yf

from api.deps import get_settings
from services.sentiment import score_texts, aggregate_sentiment

logger = logging.getLogger(__name__)

_running = False
_thread: threading.Thread | None = None


def _get_yfinance_meta(ticker: str) -> dict:
    """Fetch 7-day momentum % and market cap for a ticker. Returns safe defaults on error."""
    try:
        t = yf.Ticker(ticker)
        hist = t.history(period="7d")
        if len(hist) >= 2:
            momentum_7d = (
                (hist["Close"].iloc[-1] - hist["Close"].iloc[0])
                / hist["Close"].iloc[0]
                * 100
            )
        else:
            momentum_7d = 0.0

        fast_info = t.fast_info
        market_cap = getattr(fast_info, "market_cap", 0) or 0

        # Sector: fast_info doesn't have it, but info dict does (slower call)
        try:
            sector = t.info.get("sector", "Unknown") or "Unknown"
        except Exception:
            sector = "Unknown"

        return {
            "momentum_7d": round(float(momentum_7d), 4),
            "market_cap": int(market_cap),
            "sector": sector,
        }
    except Exception as e:
        logger.debug(f"yfinance meta failed for {ticker}: {e}")
        return {"momentum_7d": 0.0, "market_cap": 0, "sector": "Unknown"}


def _process_one(article_id: str, conn, cur) -> None:
    """Score one article and upsert sentiment rows for each extracted ticker."""
    cur.execute("""
        SELECT ticker, headline, body FROM articles WHERE id = %s
    """, (article_id,))
    row = cur.fetchone()
    if not row:
        return

    tickers, headline, body = row
    if not tickers:
        return

    text = f"{headline} {body or ''}"
    scores = score_texts([text])
    agg = aggregate_sentiment(scores)

    for ticker in tickers:
        meta = _get_yfinance_meta(ticker)
        scored_at = datetime.now(tz=timezone.utc)
        try:
            cur.execute("""
                INSERT INTO ticker_sentiment
                    (ticker, scored_at, bull_pct, bear_pct, neutral_pct,
                     score, momentum_7d, market_cap, sector)
                VALUES
                    (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (ticker, scored_at) DO UPDATE SET
                    bull_pct    = EXCLUDED.bull_pct,
                    bear_pct    = EXCLUDED.bear_pct,
                    neutral_pct = EXCLUDED.neutral_pct,
                    score       = EXCLUDED.score,
                    momentum_7d = EXCLUDED.momentum_7d,
                    market_cap  = EXCLUDED.market_cap,
                    sector      = EXCLUDED.sector
            """, (
                ticker,
                scored_at,
                agg["bull_pct"],
                agg["bear_pct"],
                agg["neutral_pct"],
                agg["score"],
                meta["momentum_7d"],
                meta["market_cap"],
                meta["sector"],
            ))
            conn.commit()
            logger.debug(f"Scored {ticker}: score={agg['score']:.2f}, momentum={meta['momentum_7d']:.2f}%")
        except Exception as e:
            conn.rollback()
            logger.warning(f"Upsert failed for {ticker}: {e}")


def _processor_loop() -> None:
    global _running
    settings = get_settings()
    r = syncredis.from_url(settings.redis_url, decode_responses=True)

    conn = psycopg2.connect(settings.database_url)
    cur = conn.cursor()
    logger.info("Processor loop started — waiting for queue:unprocessed")

    while _running:
        try:
            # Blocking pop: waits up to 2s before looping (allows clean shutdown)
            item = r.brpop("queue:unprocessed", timeout=2)
            if item:
                _, article_id = item
                logger.debug(f"Processing article {article_id}")
                _process_one(article_id, conn, cur)
        except psycopg2.OperationalError:
            # DB connection lost — reconnect
            logger.warning("DB connection lost, reconnecting...")
            try:
                conn.close()
            except Exception:
                pass
            time.sleep(2)
            try:
                conn = psycopg2.connect(settings.database_url)
                cur = conn.cursor()
            except Exception as e:
                logger.error(f"Reconnect failed: {e}")
        except Exception as e:
            logger.error(f"Processor error: {e}")
            time.sleep(1)

    cur.close()
    conn.close()
    logger.info("Processor loop stopped")


def start_processor() -> threading.Thread:
    global _running, _thread
    if _thread is not None and _thread.is_alive():
        return _thread

    _running = True
    _thread = threading.Thread(target=_processor_loop, daemon=True, name="processor")
    _thread.start()
    return _thread
