import asyncpg
from fastapi import APIRouter, Depends, Query

from api.deps import get_db

router = APIRouter()


@router.get("")
async def get_news(
    ticker: str | None = Query(None, description="Filter by ticker symbol"),
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    db: asyncpg.Pool = Depends(get_db),
) -> list[dict]:
    """Paginated article feed, optionally filtered by ticker."""
    if ticker:
        rows = await db.fetch("""
            SELECT id::text, headline, source, published_at, url, ticker
            FROM articles
            WHERE $1 = ANY(ticker)
            ORDER BY published_at DESC
            LIMIT $2 OFFSET $3
        """, ticker.upper(), limit, offset)
    else:
        rows = await db.fetch("""
            SELECT id::text, headline, source, published_at, url, ticker
            FROM articles
            ORDER BY published_at DESC
            LIMIT $1 OFFSET $2
        """, limit, offset)

    return [
        {
            **dict(r),
            "published_at": r["published_at"].isoformat() if r["published_at"] else None,
        }
        for r in rows
    ]
