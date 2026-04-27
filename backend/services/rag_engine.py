"""
LlamaIndex RAG engine backed by Qdrant + Ollama.
Builds the index once at first query; subsequent queries reuse it.

When a ticker is provided, articles fetched directly from Postgres are
injected as hard context so the LLM always has the latest data even if
Qdrant hasn't indexed the articles yet.
"""
import logging
from typing import AsyncGenerator

from llama_index.core import VectorStoreIndex, StorageContext, Settings as LISettings
from llama_index.vector_stores.qdrant import QdrantVectorStore
from llama_index.llms.ollama import Ollama
from llama_index.embeddings.ollama import OllamaEmbedding
from qdrant_client import QdrantClient

from api.deps import get_settings

logger = logging.getLogger(__name__)

_index: VectorStoreIndex | None = None

SYSTEM_PROMPT = (
    "You are a concise financial analyst assistant. "
    "When recent news context is provided, use it to answer questions and cite specific headlines. "
    "When no specific news context is available for a ticker, still provide a helpful response: "
    "briefly describe what you know about the company from your training knowledge, "
    "note that no recent news was retrieved, and suggest what to watch for. "
    "Always mention the primary risk alongside any bullish thesis. "
    "Keep responses under 180 words. "
    "Never say 'I cannot provide information' — always give the best analysis you can."
)


def _build_index() -> VectorStoreIndex:
    settings = get_settings()

    # Configure LlamaIndex globals (called once)
    LISettings.llm = Ollama(
        model="llama3.1:8b",
        base_url=settings.ollama_url,
        system_prompt=SYSTEM_PROMPT,
        request_timeout=120.0,
    )
    LISettings.embed_model = OllamaEmbedding(
        model_name="nomic-embed-text",
        base_url=settings.ollama_url,
    )
    LISettings.chunk_size = 512
    LISettings.chunk_overlap = 64

    client = QdrantClient(url=settings.qdrant_url)
    vector_store = QdrantVectorStore(
        client=client,
        collection_name="finsight_articles",
    )
    storage_context = StorageContext.from_defaults(vector_store=vector_store)

    logger.info("RAG index connected to Qdrant")
    return VectorStoreIndex.from_vector_store(
        vector_store,
        storage_context=storage_context,
    )


def _get_index() -> VectorStoreIndex:
    global _index
    if _index is None:
        _index = _build_index()
    return _index


async def query_rag(
    question: str,
    ticker: str | None = None,
    direct_context: str = "",
) -> AsyncGenerator[str, None]:
    """
    Stream a RAG answer token-by-token.

    direct_context: pre-fetched article text from Postgres, injected as hard
    context at the top of the prompt so the LLM always has the latest data
    even if Qdrant hasn't indexed those articles yet.
    """
    index = _get_index()

    # Build the full question with hard context prepended
    if direct_context:
        full_question = (
            f"Here are recent news articles about {ticker or 'this stock'}:\n\n"
            f"{direct_context}\n\n"
            f"Question: {question}"
        )
    else:
        # Fallback: semantic search only
        full_question = f"[{ticker}] {question}" if ticker else question

    query_engine = index.as_query_engine(
        streaming=True,
        similarity_top_k=5,
    )

    try:
        response = query_engine.query(full_question)
        emitted = False
        for token in response.response_gen:
            emitted = True
            yield token

        # Some providers/proxy paths can occasionally complete the stream with
        # no token events. Fall back to the final response text when available.
        if not emitted:
            fallback = (getattr(response, "response", "") or "").strip()
            if fallback:
                yield fallback
            else:
                yield "Unable to generate analysis right now. Please try again."
    except Exception as e:
        logger.error(f"RAG query error for '{question}' (ticker={ticker}): {e}")
        yield f"Unable to generate analysis: {str(e)}"
