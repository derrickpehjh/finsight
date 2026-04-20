import asyncpg
from fastapi import APIRouter, Depends, HTTPException

from api.deps import get_db

router = APIRouter()
DEFAULT_USER = "default"


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
async def add_ticker(ticker: str, db: asyncpg.Pool = Depends(get_db)) -> dict:
    ticker = ticker.upper()
    try:
        await db.execute("""
            INSERT INTO watchlist (user_id, ticker)
            VALUES ($1, $2)
            ON CONFLICT DO NOTHING
        """, DEFAULT_USER, ticker)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"ticker": ticker, "status": "added"}


@router.delete("/{ticker}")
async def remove_ticker(ticker: str, db: asyncpg.Pool = Depends(get_db)) -> dict:
    ticker = ticker.upper()
    await db.execute("""
        DELETE FROM watchlist WHERE user_id = $1 AND ticker = $2
    """, DEFAULT_USER, ticker)
    return {"ticker": ticker, "status": "removed"}
