import json
import logging
from typing import AsyncGenerator

import asyncpg
import httpx
from qdrant_client import QdrantClient
from qdrant_client.models import Filter, FieldCondition, MatchAny

from api.deps import get_settings
from services.rag_engine import _get_index

logger = logging.getLogger(__name__)

MAX_ITERATIONS = 2


async def _noop() -> list:
    return []


def _search_articles(
    query: str,
    ticker: str | None,
    k: int,
    qdrant_url: str,
    ollama_url: str,
) -> list[dict]:
    try:
        resp = httpx.post(
            f"{ollama_url}/api/embeddings",
            json={"model": "nomic-embed-text", "prompt": query[:2000]},
            timeout=30.0,
        )
        resp.raise_for_status()
        embedding = resp.json().get("embedding")
    except Exception as e:
        logger.warning(f"Embedding failed for agent search: {e}")
        return []

    if not embedding:
        return []

    try:
        client = QdrantClient(url=qdrant_url)
        query_filter = None
        if ticker:
            query_filter = Filter(
                must=[FieldCondition(key="tickers", match=MatchAny(any=[ticker]))]
            )
        results = client.search(
            collection_name="finsight_articles",
            query_vector=embedding,
            query_filter=query_filter,
            limit=k,
            with_payload=True,
        )
        return [
            {
                "headline": r.payload.get("headline", ""),
                "source": r.payload.get("source", ""),
                "published_at": r.payload.get("published_at", ""),
                "bull_pct": r.payload.get("bull_pct", 0),
                "bear_pct": r.payload.get("bear_pct", 0),
                "score": r.payload.get("score", 0),
                "url": r.payload.get("url", ""),
                "text": r.payload.get("text", "")[:500],
                "similarity": r.score,
            }
            for r in results
        ]
    except Exception as e:
        logger.warning(f"Qdrant agent search failed: {e}")
        return []


async def _get_sentiment_trend(ticker: str, days: int, db: asyncpg.Pool) -> list[dict]:
    try:
        rows = await db.fetch("""
            SELECT ticker, scored_at, bull_pct, bear_pct, neutral_pct, score, momentum_7d
            FROM ticker_sentiment
            WHERE ticker = $1
              AND scored_at >= NOW() - ($2 || ' days')::interval
            ORDER BY scored_at DESC
            LIMIT 20
        """, ticker.upper(), str(days))
        return [dict(r) for r in rows]
    except Exception as e:
        logger.warning(f"Sentiment trend query failed: {e}")
        return []


async def _get_recent_news(ticker: str, limit: int, db: asyncpg.Pool) -> list[dict]:
    try:
        rows = await db.fetch("""
            SELECT headline, body, source, published_at, url
            FROM articles
            WHERE $1 = ANY(ticker)
            ORDER BY published_at DESC
            LIMIT $2
        """, ticker.upper(), limit)
        return [dict(r) for r in rows]
    except Exception as e:
        logger.warning(f"Recent news query failed: {e}")
        return []


def _reflect(
    question: str,
    ticker: str | None,
    articles: list[dict],
    sentiment: list[dict],
    ollama_url: str,
) -> dict:
    n = len(articles)
    sentiment_summary = ""
    if sentiment:
        avg_score = sum(r.get("score", 0) for r in sentiment) / len(sentiment)
        sentiment_summary = f"{len(sentiment)} rows, avg score {avg_score:.2f}"

    headlines = "\n".join(f"- {a.get('headline', '')}" for a in articles[:5])

    prompt = (
        f"You are evaluating whether retrieved financial news is sufficient to answer a question.\n\n"
        f"Question: {question}\n"
        f"Ticker: {ticker or 'general'}\n\n"
        f"Retrieved: {n} articles\n"
        f"Sentiment data: {sentiment_summary or 'none'}\n"
        f"Top headlines:\n{headlines or '(none)'}\n\n"
        f"Respond ONLY with JSON (no markdown):\n"
        f'{{"sufficient": true, "gap": "", "reformulated_query": ""}}\n'
        f"OR if context is insufficient:\n"
        f'{{"sufficient": false, "gap": "what is missing", "reformulated_query": "better search query"}}'
    )

    try:
        resp = httpx.post(
            f"{ollama_url}/api/chat",
            json={
                "model": "llama3.1:8b",
                "format": "json",
                "stream": False,
                "messages": [{"role": "user", "content": prompt}],
            },
            timeout=60.0,
        )
        resp.raise_for_status()
        raw = resp.json()["message"]["content"]
        parsed = json.loads(raw)
        return {
            "sufficient": bool(parsed.get("sufficient", True)),
            "gap": str(parsed.get("gap", "")),
            "reformulated_query": str(parsed.get("reformulated_query", "")),
        }
    except Exception as e:
        logger.warning(f"Reflection failed (defaulting to sufficient): {e}")
        return {"sufficient": True, "gap": "", "reformulated_query": ""}


def _format_context(articles: list[dict], sentiment: list[dict], ticker: str | None) -> str:
    parts = []

    if sentiment:
        avg_bull = sum(r.get("bull_pct", 0) for r in sentiment) / len(sentiment)
        avg_bear = sum(r.get("bear_pct", 0) for r in sentiment) / len(sentiment)
        avg_score = sum(r.get("score", 0) for r in sentiment) / len(sentiment)
        parts.append(
            f"[SENTIMENT — {ticker or 'market'} last 7 days]\n"
            f"Avg bull: {avg_bull:.1%}  Avg bear: {avg_bear:.1%}  "
            f"Avg score: {avg_score:+.3f} ({len(sentiment)} data points)"
        )

    if articles:
        parts.append("[NEWS ARTICLES]")
        seen_urls: set[str] = set()
        for a in articles:
            url = str(a.get("url", ""))
            if url in seen_urls:
                continue
            seen_urls.add(url)
            date = str(a.get("published_at", ""))[:10]
            snippet = str(a.get("text", a.get("body", "")) or "")[:300].strip()
            entry = f"Source: {a.get('source', '')} ({date})\nHeadline: {a.get('headline', '')}"
            if snippet:
                entry += f"\n{snippet}"
            parts.append(entry)

    return "\n\n---\n\n".join(parts)


async def agent_query_rag(
    question: str,
    ticker: str | None,
    db: asyncpg.Pool,
) -> AsyncGenerator[str, None]:
    """
    Agentic RAG: retrieve → reflect → re-retrieve (up to MAX_ITERATIONS) → synthesize.
    Yields SSE-ready strings. Step events are prefixed __STEP__<id>|<detail>.
    Text tokens (final answer) are yielded as plain strings.
    """
    import asyncio as _asyncio

    settings = get_settings()
    all_articles: list[dict] = []
    sentiment: list[dict] = []
    current_query = question

    for iteration in range(MAX_ITERATIONS + 1):
        step_label = "Re-searching" if iteration > 0 else "Searching"
        yield f"__STEP__retrieve|{step_label}: \"{current_query[:60]}\"\n\n"

        loop = _asyncio.get_running_loop()
        vector_task = loop.run_in_executor(
            None,
            lambda q=current_query: _search_articles(
                q, ticker, 5, settings.qdrant_url, settings.ollama_url
            ),
        )
        news_task = _get_recent_news(ticker, 8, db) if ticker else _noop()
        sentiment_task = _get_sentiment_trend(ticker, 7, db) if ticker else _noop()

        vector_results, fresh_news, fresh_sentiment = await _asyncio.gather(
            vector_task, news_task, sentiment_task
        )

        seen = {a.get("url") for a in all_articles}
        for a in vector_results:
            if a.get("url") not in seen:
                all_articles.append(a)
                seen.add(a.get("url"))

        if not sentiment:
            sentiment = list(fresh_sentiment)

        for a in fresh_news:
            url = str(a.get("url", ""))
            if url not in seen:
                all_articles.append({
                    "headline": a.get("headline", ""),
                    "source": a.get("source", ""),
                    "published_at": str(a.get("published_at", "")),
                    "text": str(a.get("body") or "")[:500],
                    "url": url,
                })
                seen.add(url)

        yield f"__STEP__retrieved|Found {len(all_articles)} articles\n\n"

        if iteration < MAX_ITERATIONS:
            yield "__STEP__reflect|Evaluating context quality...\n\n"
            reflection = await loop.run_in_executor(
                None,
                lambda: _reflect(question, ticker, all_articles, sentiment, settings.ollama_url),
            )
            if reflection.get("sufficient", True):
                yield "__STEP__reflect_ok|Context sufficient\n\n"
                break
            new_query = reflection.get("reformulated_query", "").strip()
            if not new_query or new_query == current_query:
                break
            gap = reflection.get("gap", "")
            yield f"__STEP__requery|Gap: {gap[:80]}. Retrying: \"{new_query[:60]}\"\n\n"
            current_query = new_query
        else:
            break

    yield "__STEP__synthesize|Generating analysis...\n\n"

    context = _format_context(all_articles, sentiment, ticker)
    if context:
        full_question = (
            f"Financial data for {ticker or 'this topic'}:\n\n"
            f"{context}\n\n"
            f"Question: {question}\n\n"
            "Provide: bull thesis, bear thesis, key recent events, bottom line."
        )
    else:
        full_question = f"[{ticker}] {question}" if ticker else question

    index = _get_index()
    query_engine = index.as_query_engine(streaming=True, similarity_top_k=3)
    try:
        response = query_engine.query(full_question)
        emitted = False
        for token in response.response_gen:
            emitted = True
            yield token
        if not emitted:
            fallback = (getattr(response, "response", "") or "").strip()
            yield fallback or "Unable to generate analysis right now."
    except Exception as e:
        logger.error(f"Agent synthesis error: {e}")
        yield f"Unable to generate analysis: {e}"
