"""
News & Reddit ingester.
Runs on a 15-minute APScheduler cron. Inserts new articles into Postgres
and pushes their IDs to the Redis queue for the processor to score.
"""
import logging
from datetime import datetime, timezone

import psycopg2
import redis as syncredis
from apscheduler.schedulers.background import BackgroundScheduler

from api.deps import get_settings
from services.ner import extract_tickers

logger = logging.getLogger(__name__)

FINANCIAL_KEYWORDS = [
    "earnings", "revenue", "stock market", "shares", "nasdaq",
    "quarterly results", "guidance", "S&P 500", "Federal Reserve",
    "interest rate", "inflation", "IPO",
]

SUBREDDITS = ["wallstreetbets", "stocks", "investing"]

_scheduler: BackgroundScheduler | None = None


def _sync_redis():
    return syncredis.from_url(get_settings().redis_url, decode_responses=True)


def _sync_db():
    return psycopg2.connect(get_settings().database_url)


def _insert_article(cur, conn, r, source, tickers, headline, body, url, published_at) -> bool:
    """Insert article if URL is new. Returns True if inserted."""
    try:
        cur.execute("""
            INSERT INTO articles (source, ticker, headline, body, url, published_at)
            VALUES (%s, %s, %s, %s, %s, %s)
            ON CONFLICT (url) DO NOTHING
            RETURNING id
        """, (source, tickers, headline, body, url, published_at))
        row = cur.fetchone()
        conn.commit()
        if row:
            r.lpush("queue:unprocessed", str(row[0]))
            return True
        return False
    except Exception as e:
        conn.rollback()
        logger.warning(f"Insert failed for {url}: {e}")
        return False


def ingest_cycle() -> None:
    """
    Full ingestion cycle: NewsAPI + Reddit.
    Deduplicates via UNIQUE constraint on articles.url.
    """
    logger.info("── Ingestion cycle starting ──")
    settings = get_settings()
    r = _sync_redis()
    conn = _sync_db()
    cur = conn.cursor()
    count = 0

    # ── NewsAPI ──────────────────────────────────────────────────────────────
    if settings.newsapi_key:
        try:
            from newsapi import NewsApiClient
            client = NewsApiClient(api_key=settings.newsapi_key)
            resp = client.get_everything(
                q=" OR ".join(FINANCIAL_KEYWORDS[:6]),
                language="en",
                page_size=100,
                sort_by="publishedAt",
            )
            for art in resp.get("articles", []):
                url = art.get("url") or ""
                if not url or url == "https://removed.com":
                    continue
                combined = f"{art.get('title', '')} {art.get('description', '')}"
                tickers = extract_tickers(combined)
                if not tickers:
                    continue  # skip non-ticker articles
                inserted = _insert_article(
                    cur, conn, r,
                    source=art.get("source", {}).get("name", "unknown"),
                    tickers=tickers,
                    headline=art.get("title", "")[:500],
                    body=(art.get("description") or "")[:2000],
                    url=url,
                    published_at=art.get("publishedAt"),
                )
                if inserted:
                    count += 1
        except Exception as e:
            logger.error(f"NewsAPI error: {e}")

    # ── Reddit ───────────────────────────────────────────────────────────────
    if settings.reddit_client_id and settings.reddit_client_secret:
        try:
            import praw
            reddit = praw.Reddit(
                client_id=settings.reddit_client_id,
                client_secret=settings.reddit_client_secret,
                user_agent=settings.reddit_user_agent,
            )
            for sub_name in SUBREDDITS:
                try:
                    sub = reddit.subreddit(sub_name)
                    for post in sub.new(limit=50):
                        url = f"https://reddit.com{post.permalink}"
                        combined = f"{post.title} {post.selftext[:500] if post.selftext else ''}"
                        tickers = extract_tickers(combined)
                        if not tickers:
                            continue
                        inserted = _insert_article(
                            cur, conn, r,
                            source=f"reddit/{sub_name}",
                            tickers=tickers,
                            headline=post.title[:500],
                            body=(post.selftext or "")[:2000],
                            url=url,
                            published_at=datetime.fromtimestamp(post.created_utc, tz=timezone.utc),
                        )
                        if inserted:
                            count += 1
                except Exception as e:
                    logger.warning(f"Reddit r/{sub_name} error: {e}")
        except Exception as e:
            logger.error(f"Reddit init error: {e}")

    cur.close()
    conn.close()
    logger.info(f"── Ingestion complete: {count} new articles queued ──")


def start_scheduler() -> None:
    global _scheduler
    if _scheduler is not None:
        return

    _scheduler = BackgroundScheduler(daemon=True)
    _scheduler.add_job(ingest_cycle, "interval", minutes=15, id="ingest")
    _scheduler.start()

    # Run once immediately on startup (don't wait 15 min for first data)
    import threading
    threading.Thread(target=ingest_cycle, daemon=True).start()

    logger.info("Ingestion scheduler started (every 15 min)")
