import asyncio
from unittest.mock import patch, MagicMock
import pytest

from services.agentic_rag import (
    _search_articles,
    _reflect,
    _format_context,
    agent_query_rag,
)


def test_search_articles_returns_list_on_success():
    mock_point = MagicMock()
    mock_point.payload = {
        "headline": "NVDA beats earnings",
        "source": "yahoo_finance",
        "published_at": "2026-04-20T12:00:00",
        "bull_pct": 0.8,
        "bear_pct": 0.1,
        "score": 0.7,
        "url": "https://example.com/nvda",
        "text": "NVDA posted record revenues.",
    }
    mock_point.score = 0.92

    with patch("services.agentic_rag.httpx.post") as mock_http, \
         patch("services.agentic_rag.QdrantClient") as mock_qdrant_cls:
        mock_http.return_value.json.return_value = {"embedding": [0.1] * 768}
        mock_http.return_value.raise_for_status = MagicMock()
        mock_qdrant = MagicMock()
        mock_qdrant_cls.return_value = mock_qdrant
        mock_qdrant.search.return_value = [mock_point]

        results = _search_articles(
            "NVDA earnings", "NVDA", 5,
            "http://localhost:6333", "http://localhost:11434"
        )

    assert isinstance(results, list)
    assert len(results) == 1
    assert results[0]["headline"] == "NVDA beats earnings"
    assert results[0]["similarity"] == 0.92


def test_search_articles_returns_empty_on_embedding_failure():
    with patch("services.agentic_rag.httpx.post") as mock_http:
        mock_http.side_effect = Exception("connection refused")
        results = _search_articles(
            "NVDA earnings", "NVDA", 5,
            "http://localhost:6333", "http://localhost:11434"
        )
    assert results == []


def test_reflect_returns_sufficient_when_articles_found():
    articles = [
        {"headline": "NVDA earnings beat", "url": "https://a.com/1", "score": 0.6},
        {"headline": "NVDA guidance raised", "url": "https://a.com/2", "score": 0.7},
    ]
    sentiment = [{"score": 0.6, "bull_pct": 0.7, "bear_pct": 0.2}]

    with patch("services.agentic_rag.httpx.post") as mock_http:
        mock_http.return_value.json.return_value = {
            "message": {
                "content": '{"sufficient": true, "gap": "", "reformulated_query": ""}'
            }
        }
        mock_http.return_value.raise_for_status = MagicMock()

        result = _reflect(
            "Is NVDA a buy?", "NVDA", articles, sentiment, "http://localhost:11434"
        )

    assert result["sufficient"] is True
    assert result["gap"] == ""


def test_reflect_returns_safe_default_on_llm_failure():
    with patch("services.agentic_rag.httpx.post") as mock_http:
        mock_http.side_effect = Exception("timeout")

        result = _reflect("Is NVDA a buy?", "NVDA", [], [], "http://localhost:11434")

    assert result["sufficient"] is True  # safe default: don't loop forever


def test_format_context_includes_sentiment_and_headlines():
    articles = [{"headline": "NVDA soars", "source": "yahoo", "published_at": "2026-04-20", "url": "u1", "text": ""}]
    sentiment = [{"score": 0.5, "bull_pct": 0.6, "bear_pct": 0.2, "neutral_pct": 0.2}]

    ctx = _format_context(articles, sentiment, "NVDA")

    assert "SENTIMENT" in ctx
    assert "NVDA soars" in ctx


def test_agent_query_rag_yields_step_and_answer_tokens():
    mock_db = MagicMock()

    async def fake_fetch(*_args, **_kwargs):
        return []

    mock_db.fetch = fake_fetch

    with patch("services.agentic_rag._search_articles", return_value=[]), \
         patch("services.agentic_rag._reflect", return_value={
             "sufficient": True, "gap": "", "reformulated_query": ""
         }), \
         patch("services.agentic_rag._get_index") as mock_idx:

        mock_engine = MagicMock()
        mock_response = MagicMock()
        mock_response.response_gen = iter(["NVDA ", "looks ", "bullish."])
        mock_engine.query.return_value = mock_response
        mock_idx.return_value.as_query_engine.return_value = mock_engine

        async def collect():
            chunks = []
            async for chunk in agent_query_rag("Is NVDA a buy?", "NVDA", mock_db):
                chunks.append(chunk)
            return chunks

        chunks = asyncio.run(collect())

    step_chunks = [c for c in chunks if c.startswith("__STEP__")]
    text_chunks = [c for c in chunks if not c.startswith("__STEP__")]

    assert len(step_chunks) >= 2, "Should emit at least retrieve and synthesize steps"
    assert any("NVDA" in c or "bullish" in c for c in text_chunks), "Should stream answer tokens"
