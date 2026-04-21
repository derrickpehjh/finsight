"""
Background processor: consumes article IDs from Redis queue,
runs FinBERT sentiment scoring, fetches market data (momentum/market cap/sector),
embeds article text into Qdrant for RAG, and upserts into ticker_sentiment.
"""
import logging
import threading
import time
import uuid
from datetime import datetime, timezone

import httpx
import psycopg2
import redis as syncredis
from qdrant_client import QdrantClient
from qdrant_client.models import PointStruct

from api.deps import get_settings
from services.sentiment import score_texts, aggregate_sentiment
from services.price_fetcher import get_ticker_meta

logger = logging.getLogger(__name__)

_running = False
_thread: threading.Thread | None = None

# Qdrant collection written to by the processor
COLLECTION_NAME = "finsight_articles"


def _get_embedding(text: str, ollama_url: str) -> list[float] | None:
    """Get nomic-embed-text embedding from Ollama. Returns None on failure."""
    try:
        resp = httpx.post(
            f"{ollama_url}/api/embeddings",
            json={"model": "nomic-embed-text", "prompt": text[:2000]},
            timeout=30.0,
        )
        resp.raise_for_status()
        return resp.json().get("embedding")
    except Exception as e:
        logger.debug(f"Ollama embedding failed: {e}")
        return None


def _upsert_to_qdrant(
    article_id: str,
    text: str,
    payload: dict,
    ollama_url: str,
    qdrant_url: str,
) -> None:
    """Embed text and upsert a single point into Qdrant. Silently skips on error."""
    embedding = _get_embedding(text, ollama_url)
    if not embedding:
        return
    try:
        client = QdrantClient(url=qdrant_url)
        # Include 'text' in payload so LlamaIndex QdrantVectorStore can reconstruct TextNodes
        full_payload = {"text": text[:4000], **payload}
        # Use article UUID directly as point id (Qdrant accepts UUID strings)
        client.upsert(
            collection_name=COLLECTION_NAME,
            points=[
                PointStruct(
                    id=str(uuid.UUID(article_id)),  # ensure valid UUID format
                    vector=embedding,
                    payload=full_payload,
                )
            ],
        )
        logger.debug(f"Qdrant upsert ok for article {article_id}")
    except Exception as e:
        logger.warning(f"Qdrant upsert failed for {article_id}: {e}")


def _get_ticker_meta(ticker: str) -> dict:
    """Fetch 14-day momentum %, market cap, and sector via direct Yahoo Finance API."""
    try:
        return get_ticker_meta(ticker)
    except Exception as e:
        logger.debug(f"price_fetcher meta failed for {ticker}: {e}")
        return {"momentum_7d": 0.0, "market_cap": 0, "sector": "Unknown"}


def _process_one(article_id: str, conn, cur) -> None:
    """Score one article, embed it into Qdrant, and upsert sentiment rows per ticker."""
    cur.execute("""
        SELECT ticker, headline, body, source, url, published_at FROM articles WHERE id = %s
    """, (article_id,))
    row = cur.fetchone()
    if not row:
        return

    tickers, headline, body, source, url, published_at = row
    if not tickers:
        return

    text = f"{headline} {body or ''}"
    scores = score_texts([text])
    agg = aggregate_sentiment(scores)

    # ── Embed into Qdrant (once per article, not per ticker) ──────────────────
    settings = get_settings()
    _upsert_to_qdrant(
        article_id=article_id,
        text=text,
        payload={
            "headline": headline,
            "source": source,
            "tickers": tickers,
            "url": url,
            "published_at": published_at.isoformat() if published_at else None,
            "bull_pct": agg["bull_pct"],
            "bear_pct": agg["bear_pct"],
            "score": agg["score"],
        },
        ollama_url=settings.ollama_url,
        qdrant_url=settings.qdrant_url,
    )

    for ticker in tickers:
        meta = _get_ticker_meta(ticker)
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


def _backfill_qdrant() -> None:
    """
    On startup, embed any articles already in Postgres that are not yet in Qdrant.
    This repairs the RAG index after the first deployment (or code updates) without
    requiring a full re-ingest.
    """
    settings = get_settings()
    try:
        qdrant = QdrantClient(url=settings.qdrant_url)
        conn = psycopg2.connect(settings.database_url)
        cur = conn.cursor()

        # Count existing points in Qdrant
        try:
            info = qdrant.get_collection(COLLECTION_NAME)
            existing_count = info.points_count
        except Exception:
            existing_count = 0

        # Fetch all articles from Postgres
        cur.execute("""
            SELECT id::text, headline, body, source, url, published_at, ticker
            FROM articles
            ORDER BY published_at DESC
        """)
        rows = cur.fetchall()

        if not rows:
            logger.info("Qdrant backfill: no articles in Postgres to backfill")
            return

        logger.info(f"Qdrant backfill: {len(rows)} articles in Postgres, {existing_count} points in Qdrant — embedding missing ones...")

        embedded = 0
        for article_id, headline, body, source, url, published_at, tickers in rows:
            text = f"{headline} {body or ''}"
            # Quick sentiment for payload
            try:
                scores = score_texts([text])
                agg = aggregate_sentiment(scores)
            except Exception:
                agg = {"bull_pct": 0.0, "bear_pct": 0.0, "score": 0.0}

            _upsert_to_qdrant(
                article_id=article_id,
                text=text,
                payload={
                    "headline": headline,
                    "source": source,
                    "tickers": tickers or [],
                    "url": url,
                    "published_at": published_at.isoformat() if published_at else None,
                    "bull_pct": agg["bull_pct"],
                    "bear_pct": agg["bear_pct"],
                    "score": agg["score"],
                },
                ollama_url=settings.ollama_url,
                qdrant_url=settings.qdrant_url,
            )
            embedded += 1
            if embedded % 10 == 0:
                logger.info(f"Qdrant backfill: {embedded}/{len(rows)} embedded...")

        logger.info(f"Qdrant backfill complete: {embedded} articles embedded")
        cur.close()
        conn.close()
    except Exception as e:
        logger.error(f"Qdrant backfill error: {e}")


def start_processor() -> threading.Thread:
    global _running, _thread
    if _thread is not None and _thread.is_alive():
        return _thread

    _running = True
    _thread = threading.Thread(target=_processor_loop, daemon=True, name="processor")
    _thread.start()

    # Backfill any articles that were ingested before RAG embedding was added
    import threading as _threading
    _threading.Thread(target=_backfill_qdrant, daemon=True, name="qdrant-backfill").start()

    return _thread
