import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from api.routes import stocks, news, rag, watchlist
from services.ingester import start_scheduler
from services.processor import start_processor
from services.sentiment import load_finbert
from db.qdrant_client import ensure_collection

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # ── Startup ────────────────────────────────────────
    logger.info("Loading FinBERT model (first run downloads ~440 MB)...")
    load_finbert()

    logger.info("Ensuring Qdrant collection exists...")
    await ensure_collection()

    logger.info("Starting background processor...")
    start_processor()

    logger.info("Starting ingestion scheduler (15-min cycle)...")
    start_scheduler()

    yield
    # ── Shutdown (nothing to clean up — threads are daemon) ──


app = FastAPI(
    title="FinSight API",
    description="Financial news RAG system with real-time sentiment analysis",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Tighten to Vercel domain in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(stocks.router,    prefix="/stocks",    tags=["stocks"])
app.include_router(news.router,      prefix="/news",      tags=["news"])
app.include_router(rag.router,       prefix="/rag",       tags=["rag"])
app.include_router(watchlist.router, prefix="/watchlist", tags=["watchlist"])


@app.get("/health", tags=["health"])
async def health():
    return {"status": "ok", "version": "0.1.0"}


@app.get("/debug/cache-clear", tags=["debug"])
async def cache_clear():
    """Clear the stocks overview Redis cache so fresh price data is fetched."""
    from api.deps import get_redis
    r = await get_redis()
    deleted = await r.delete("stocks:overview")
    return {"cleared": bool(deleted), "keys_deleted": deleted}


@app.get("/debug/refresh-meta", tags=["debug"])
async def refresh_meta():
    """
    Fetch live momentum/market_cap/sector for all tracked tickers and upsert
    into ticker_sentiment. Fixes stale zeros left by broken yfinance calls.
    Runs in a background thread (non-blocking).
    """
    import asyncio
    import threading
    from datetime import datetime, timezone
    import psycopg2
    from api.deps import get_settings
    from services.price_fetcher import get_ticker_meta
    from api.routes.stocks import TRACKED_TICKERS

    def _refresh():
        settings = get_settings()
        conn = psycopg2.connect(settings.database_url)
        cur = conn.cursor()
        for ticker in TRACKED_TICKERS:
            try:
                meta = get_ticker_meta(ticker)
                # Only update existing rows — never insert blanks that wipe sentiment
                cur.execute("""
                    UPDATE ticker_sentiment
                    SET momentum_7d = %s,
                        market_cap  = %s,
                        sector      = %s
                    WHERE scored_at = (
                        SELECT scored_at FROM ticker_sentiment
                        WHERE ticker = %s
                        ORDER BY scored_at DESC
                        LIMIT 1
                    ) AND ticker = %s
                """, (meta["momentum_7d"], meta["market_cap"], meta["sector"], ticker, ticker))
                conn.commit()
                logger.info(f"Refreshed meta for {ticker}: {meta}")
            except Exception as e:
                conn.rollback()
                logger.warning(f"refresh_meta failed for {ticker}: {e}")
        cur.close()
        conn.close()

    t = threading.Thread(target=_refresh, daemon=True, name="meta-refresh")
    t.start()
    return {"status": "refreshing", "tickers": TRACKED_TICKERS}


@app.get("/debug/yf-test/{ticker}", tags=["debug"])
async def yf_test(ticker: str):
    """Test crumb auth + quoteSummary via price_fetcher for a ticker."""
    import asyncio
    from services.price_fetcher import get_ticker_meta, _get_crumb

    def _test():
        crumb_data = _get_crumb()
        meta = get_ticker_meta(ticker)
        return {
            "crumb_ok": crumb_data is not None,
            "crumb_preview": crumb_data[0][:12] + "..." if crumb_data else None,
            "meta": meta,
        }

    return await asyncio.get_event_loop().run_in_executor(None, _test)


@app.get("/debug/reindex-qdrant", tags=["debug"])
async def reindex_qdrant():
    """
    Re-embed all Postgres articles into Qdrant (including text field for LlamaIndex).
    Resets the RAG index cache so the next query rebuilds from updated Qdrant data.
    Runs in background thread.
    """
    import threading
    import services.rag_engine as rag_engine_mod
    from services.processor import _backfill_qdrant

    # Reset the cached RAG index so it rebuilds on next query
    rag_engine_mod._index = None

    t = threading.Thread(target=_backfill_qdrant, daemon=True, name="qdrant-reindex")
    t.start()
    return {"status": "reindexing", "note": "RAG index cache cleared — next query will rebuild"}


@app.get("/debug/cleanup-blank-rows", tags=["debug"])
async def cleanup_blank_rows():
    """Delete ticker_sentiment rows where all sentiment fields are 0 (inserted by broken refresh)."""
    import psycopg2
    from api.deps import get_settings
    settings = get_settings()
    conn = psycopg2.connect(settings.database_url)
    cur = conn.cursor()
    cur.execute("""
        DELETE FROM ticker_sentiment
        WHERE bull_pct = 0 AND bear_pct = 0 AND neutral_pct = 0 AND score = 0
    """)
    deleted = cur.rowcount
    conn.commit()
    cur.close()
    conn.close()
    return {"deleted_blank_rows": deleted}
