import logging
from pydantic import BaseModel
from fastapi import APIRouter
from fastapi.responses import StreamingResponse

from services.rag_engine import query_rag

logger = logging.getLogger(__name__)
router = APIRouter()


class QueryRequest(BaseModel):
    q: str
    ticker: str | None = None


@router.post("/query")
async def rag_query(req: QueryRequest):
    """
    Stream a RAG-generated analyst answer via Server-Sent Events.
    Frontend consumes: EventSource or fetch with ReadableStream.

    Response format:
      data: <text chunk>\\n\\n
      ...
      data: [DONE]\\n\\n
    """
    async def event_stream():
        try:
            async for chunk in query_rag(req.q, req.ticker):
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
