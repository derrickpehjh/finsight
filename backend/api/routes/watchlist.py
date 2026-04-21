import asyncpg
from fastapi import APIRouter, Depends, HTTPException
from redis.asyncio import Redis

from api.deps import get_db, get_redis

router = APIRouter()
DEFAULT_USER = "default"

# Must match the cache keys used in stocks.py
_OVERVIEW_CACHE_PREFIX = "stocks:overview"
_TIMEFRAME_KEYS = ["latest", "1H", "4H", "1D", "1W"]


async def _bust_overview_cache(redis: Redis) -> None:
    """Delete all per-timeframe overview cache entries so the next fetch re-queries the DB."""
    for tf in _TIMEFRAME_KEYS:
        await redis.delete(f"{_OVERVIEW_CACHE_PREFIX}:{tf}")


@router.get("")
async def get_watchlist(db: asyncpg.Pool = Depends(get_db)) -> list[dict]:
    rows = await db.fetch("""
        SELECT ticker, added_at FROM watchlist
        WHERE user_id = $1
        ORDER BY added_at DESC
    """, DEFAULT_USER)
    return [
        {**dict(r), "added_at": r["added_at"].isoformat() if r["added_at"] else None}
        for r in rows
    ]


@router.post("/{ticker}", status_code=201)
async def add_ticker(
    ticker: str,
    db: asyncpg.Pool = Depends(get_db),
    redis: Redis = Depends(get_redis),
) -> dict:
    ticker = ticker.upper()
    try:
        await db.execute("""
            INSERT INTO watchlist (user_id, ticker)
            VALUES ($1, $2)
            ON CONFLICT DO NOTHING
        """, DEFAULT_USER, ticker)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

    # Bust the overview Redis cache so the next SWR refetch includes the new ticker
    await _bust_overview_cache(redis)
    return {"ticker": ticker, "status": "added"}


@router.delete("/{ticker}")
async def remove_ticker(
    ticker: str,
    db: asyncpg.Pool = Depends(get_db),
    redis: Redis = Depends(get_redis),
) -> dict:
    ticker = ticker.upper()
    await db.execute("""
        DELETE FROM watchlist WHERE user_id = $1 AND ticker = $2
    """, DEFAULT_USER, ticker)

    # Bust the overview Redis cache so the removed ticker disappears immediately
    await _bust_overview_cache(redis)
    return {"ticker": ticker, "status": "removed"}
