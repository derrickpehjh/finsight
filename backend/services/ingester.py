"""
News & Reddit ingester.
Runs on a 15-minute APScheduler cron. Inserts new articles into Postgres
and pushes their IDs to the Redis queue for the processor to score.

Sources (all free, no extra API keys beyond optional NewsAPI):
  1. NewsAPI        — requires NEWSAPI_KEY env var (optional)
  2. Yahoo Finance  — per-ticker RSS feeds (no key needed)
  3. Benzinga       — public RSS feed (no key needed)
  4. Reuters        — business/markets RSS (no key needed)
  5. Reddit         — public .json API (no OAuth required)
"""
import logging
import time
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

try:
    import feedparser
    _FEEDPARSER_OK = True
except ImportError:
    _FEEDPARSER_OK = False

import httpx
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

# Tracked tickers — Yahoo Finance will fetch a dedicated RSS feed per ticker
TRACKED_TICKERS = [
    "NVDA", "MSFT", "AAPL", "AMD", "AMZN", "GOOGL", "META", "TSLA",
    "JPM", "GS", "BAC", "XOM", "CVX", "NFLX", "CRM", "PLTR",
]

# Broad financial RSS feeds (no API key needed)
RSS_FEEDS = [
    # Benzinga — live financial news, very ticker-dense
    ("benzinga",  "https://www.benzinga.com/feed/"),
    # Reuters business & markets
    ("reuters",   "https://feeds.reuters.com/reuters/businessNews"),
    # Investopedia
    ("investopedia", "https://www.investopedia.com/feedbuilder/feed/getfeed?feedName=rss_articles"),
]

REDDIT_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "application/json",
    "Accept-Language": "en-US,en;q=0.9",
}
REDDIT_DELAY_SECONDS = 2.0

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


def _parse_rfc2822_date(date_str: str | None) -> datetime:
    """Parse an RFC-2822 date string (used in RSS) to timezone-aware datetime."""
    if not date_str:
        return datetime.now(tz=timezone.utc)
    try:
        return parsedate_to_datetime(date_str).astimezone(timezone.utc)
    except Exception:
        return datetime.now(tz=timezone.utc)


# ── Source: Yahoo Finance per-ticker RSS ─────────────────────────────────────

def _get_all_tickers(cur) -> list[str]:
    """Return TRACKED_TICKERS + any tickers the user has watchlisted."""
    try:
        cur.execute("SELECT DISTINCT ticker FROM watchlist WHERE user_id = 'default'")
        watchlist = {row[0] for row in cur.fetchall()}
    except Exception:
        watchlist = set()
    return list(set(TRACKED_TICKERS) | watchlist)


def ingest_yahoo_rss(cur, conn, r) -> int:
    """
    Fetch Yahoo Finance headline RSS for each tracked + watchlisted ticker.
    URL: https://feeds.finance.yahoo.com/rss/2.0/headline?s=TICKER&region=US&lang=en-US
    No API key required.
    """
    if not _FEEDPARSER_OK:
        logger.warning("feedparser not installed — skipping Yahoo RSS (run: pip install feedparser==6.0.11)")
        return 0
    count = 0
    all_tickers = _get_all_tickers(cur)
    for ticker in all_tickers:
        url = (
            f"https://feeds.finance.yahoo.com/rss/2.0/headline"
            f"?s={ticker}&region=US&lang=en-US"
        )
        try:
            feed = feedparser.parse(url)
            entries = feed.get("entries", [])
            logger.info(f"Yahoo RSS {ticker}: {len(entries)} entries")
            for entry in entries:
                article_url = entry.get("link", "")
                if not article_url:
                    continue
                title   = entry.get("title", "").strip()
                summary = entry.get("summary", "").strip()
                combined = f"{title} {summary}"
                tickers = extract_tickers(combined)
                # Yahoo RSS is ticker-specific — always include the requested ticker
                if ticker not in tickers:
                    tickers = [ticker] + tickers
                pub_date = _parse_rfc2822_date(entry.get("published"))
                inserted = _insert_article(
                    cur, conn, r,
                    source="yahoo_finance",
                    tickers=tickers,
                    headline=title[:500],
                    body=summary[:2000],
                    url=article_url,
                    published_at=pub_date,
                )
                if inserted:
                    count += 1
        except Exception as e:
            logger.warning(f"Yahoo RSS error for {ticker}: {e}")
    return count


# ── Source: Broad financial RSS feeds ────────────────────────────────────────

def ingest_rss_feeds(cur, conn, r) -> int:
    """Ingest Benzinga, Reuters, Investopedia RSS feeds. No API key needed."""
    if not _FEEDPARSER_OK:
        logger.warning("feedparser not installed — skipping broad RSS")
        return 0
    count = 0
    for source_name, feed_url in RSS_FEEDS:
        try:
            feed = feedparser.parse(feed_url)
            entries = feed.get("entries", [])
            logger.info(f"RSS {source_name}: {len(entries)} entries")
            for entry in entries:
                article_url = entry.get("link", "")
                if not article_url:
                    continue
                title   = entry.get("title", "").strip()
                summary = (entry.get("summary") or entry.get("description") or "").strip()
                combined = f"{title} {summary}"
                tickers = extract_tickers(combined)
                if not tickers:
                    continue  # skip non-ticker articles
                pub_date = _parse_rfc2822_date(entry.get("published"))
                inserted = _insert_article(
                    cur, conn, r,
                    source=source_name,
                    tickers=tickers,
                    headline=title[:500],
                    body=summary[:2000],
                    url=article_url,
                    published_at=pub_date,
                )
                if inserted:
                    count += 1
        except Exception as e:
            logger.warning(f"RSS {source_name} error: {e}")
    return count


# ── Source: NewsAPI ───────────────────────────────────────────────────────────

def ingest_newsapi(cur, conn, r, settings) -> int:
    """Ingest from NewsAPI if NEWSAPI_KEY is set."""
    if not settings.newsapi_key:
        return 0
    count = 0
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
                continue
            inserted = _insert_article(
                cur, conn, r,
                source=art.get("source", {}).get("name", "newsapi"),
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
    return count


# ── Source: Reddit public JSON ────────────────────────────────────────────────

def ingest_reddit(cur, conn, r) -> int:
    """Scrape Reddit via public .json API — no OAuth or API key required."""
    count = 0
    try:
        with httpx.Client(
            headers=REDDIT_HEADERS,
            timeout=20,
            follow_redirects=True,
        ) as client:
            for i, sub_name in enumerate(SUBREDDITS):
                if i > 0:
                    time.sleep(REDDIT_DELAY_SECONDS)
                try:
                    endpoint = (
                        f"https://www.reddit.com/r/{sub_name}/new.json"
                        "?limit=50&raw_json=1"
                    )
                    resp = client.get(endpoint)
                    if resp.status_code == 429:
                        logger.warning(f"Reddit rate-limited on r/{sub_name}, skipping")
                        continue
                    resp.raise_for_status()
                    data  = resp.json()
                    posts = data.get("data", {}).get("children", [])
                    logger.info(f"Reddit r/{sub_name}: fetched {len(posts)} posts")

                    for item in posts:
                        post = item.get("data", {})
                        permalink = post.get("permalink", "")
                        if not permalink:
                            continue
                        post_url  = f"https://www.reddit.com{permalink}"
                        title     = post.get("title", "").strip()
                        selftext  = (post.get("selftext") or "").strip()
                        combined  = f"{title} {selftext[:500]}"
                        tickers   = extract_tickers(combined)
                        if not tickers:
                            continue
                        created_utc  = post.get("created_utc") or 0
                        published_at = (
                            datetime.fromtimestamp(created_utc, tz=timezone.utc)
                            if created_utc
                            else datetime.now(tz=timezone.utc)
                        )
                        inserted = _insert_article(
                            cur, conn, r,
                            source=f"reddit/{sub_name}",
                            tickers=tickers,
                            headline=title[:500],
                            body=selftext[:2000],
                            url=post_url,
                            published_at=published_at,
                        )
                        if inserted:
                            count += 1
                except httpx.HTTPStatusError as e:
                    logger.warning(f"Reddit r/{sub_name} HTTP error: {e.response.status_code}")
                except Exception as e:
                    logger.warning(f"Reddit r/{sub_name} scrape error: {e}")
    except Exception as e:
        logger.error(f"Reddit scraper fatal error: {e}")
    return count


# ── Main cycle ────────────────────────────────────────────────────────────────

def ingest_cycle() -> None:
    """
    Full ingestion cycle: Yahoo Finance RSS + broad RSS + NewsAPI + Reddit.
    Deduplicates via UNIQUE constraint on articles.url.
    """
    logger.info("── Ingestion cycle starting ──")
    settings = get_settings()
    r    = _sync_redis()
    conn = _sync_db()
    cur  = conn.cursor()
    total = 0

    total += ingest_yahoo_rss(cur, conn, r)
    logger.info(f"Yahoo RSS: +{total} so far")

    rss_count = ingest_rss_feeds(cur, conn, r)
    total += rss_count
    logger.info(f"Broad RSS (benzinga/reuters/investopedia): +{rss_count}")

    newsapi_count = ingest_newsapi(cur, conn, r, settings)
    total += newsapi_count
    if newsapi_count:
        logger.info(f"NewsAPI: +{newsapi_count}")

    reddit_count = ingest_reddit(cur, conn, r)
    total += reddit_count
    logger.info(f"Reddit: +{reddit_count}")

    cur.close()
    conn.close()
    logger.info(f"── Ingestion complete: {total} new articles queued ──")


def start_scheduler() -> None:
    global _scheduler
    if _scheduler is not None:
        return

    _scheduler = BackgroundScheduler(daemon=True)
    _scheduler.add_job(ingest_cycle, "interval", minutes=15, id="ingest")
    _scheduler.start()

    # Run once immediately on startup
    import threading
    threading.Thread(target=ingest_cycle, daemon=True).start()

    logger.info("Ingestion scheduler started (every 15 min) — sources: Yahoo RSS, Benzinga, Reuters, NewsAPI, Reddit")
