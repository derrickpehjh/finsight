import logging
from pydantic import BaseModel
from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
import asyncpg

from api.deps import get_db
from services.rag_engine import query_rag

logger = logging.getLogger(__name__)
router = APIRouter()


class QueryRequest(BaseModel):
    q: str
    ticker: str | None = None


@router.post("/query")
async def rag_query(req: QueryRequest, db: asyncpg.Pool = Depends(get_db)):
    """
    Stream a RAG-generated analyst answer via Server-Sent Events.
    Frontend consumes: EventSource or fetch with ReadableStream.

    When ticker is provided, we also fetch the latest articles from Postgres
    directly and inject them as hard context. This ensures the LLM always
    has the newest article content even if Qdrant hasn't indexed them yet.

    Response format:
      data: <text chunk>\\n\\n
      ...
      data: [DONE]\\n\\n
    """
    direct_context = ""
    if req.ticker:
        try:
            rows = await db.fetch("""
                SELECT headline, body, source, published_at
                FROM articles
                WHERE $1 = ANY(ticker)
                ORDER BY published_at DESC
                LIMIT 8
            """, req.ticker.upper())

            if rows:
                parts = []
                for r in rows:
                    date = r["published_at"].strftime("%Y-%m-%d") if r["published_at"] else ""
                    body_snippet = (r["body"] or "").strip()[:300]
                    parts.append(
                        f"Source: {r['source']} ({date})\n"
                        f"Headline: {r['headline']}\n"
                        + (f"Summary: {body_snippet}" if body_snippet else "")
                    )
                direct_context = "\n\n---\n\n".join(parts)
                logger.info(f"RAG: injecting {len(rows)} Postgres articles for {req.ticker}")
            else:
                logger.info(f"RAG: no Postgres articles found for {req.ticker} — using Qdrant only")
        except Exception as e:
            logger.warning(f"RAG: failed to fetch Postgres context for {req.ticker}: {e}")

    async def event_stream():
        try:
            async for chunk in query_rag(req.q, req.ticker, direct_context):
                # Escape newlines inside SSE data field
                safe = chunk.replace("\n", " ")
                yield f"data: {safe}\n\n"
        except Exception as e:
            logger.error(f"RAG stream error: {e}")
            yield f"data: [ERROR] {str(e)}\n\n"
        finally:
            yield "data: [DONE]\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",   # disable nginx buffering
        },
    )
