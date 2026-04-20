"""
LlamaIndex RAG engine backed by Qdrant + Ollama.
Builds the index once at first query; subsequent queries reuse it.
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
    "You are a concise financial analyst. Answer questions about stocks using "
    "recent news context retrieved for you. Cite specific headlines when relevant. "
    "Always mention the primary risk alongside any bullish thesis. "
    "Keep responses under 150 words."
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


async def query_rag(question: str, ticker: str | None = None) -> AsyncGenerator[str, None]:
    """
    Stream a RAG answer token-by-token.
    Ticker context is prepended to the question for better retrieval filtering.
    """
    index = _get_index()

    # Prepend ticker context so the retriever focuses on relevant docs
    full_question = f"[{ticker}] {question}" if ticker else question

    query_engine = index.as_query_engine(
        streaming=True,
        similarity_top_k=5,
    )

    try:
        response = query_engine.query(full_question)
        for token in response.response_gen:
            yield token
    except Exception as e:
        logger.error(f"RAG query error for '{full_question}': {e}")
        yield f"Unable to generate analysis: {str(e)}"
