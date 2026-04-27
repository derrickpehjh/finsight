# Agentic RAG Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace single-shot RAG with a multi-step agent loop: retrieve → reflect → re-retrieve → synthesize, with visible step progress in the UI.

**Architecture:** A new `agentic_rag.py` service runs three tools (vector search, sentiment trend, recent news) in parallel, calls Ollama for a JSON reflection step to evaluate context quality, optionally re-queries with a reformulated search, then synthesizes a structured answer using the existing LlamaIndex query engine. Steps are broadcast to the frontend via SSE events prefixed with `__STEP__`.

**Tech Stack:** Python/FastAPI (backend), asyncio + httpx, Qdrant vector search, asyncpg (Postgres), Ollama JSON mode (reflection), LlamaIndex (synthesis), Next.js/React (frontend), SSE streaming.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `backend/services/agentic_rag.py` | Create | Agent tools, reflection, orchestration loop |
| `backend/api/routes/rag.py` | Modify | Add `POST /rag/agent_query` endpoint |
| `backend/tests/test_agentic_rag.py` | Create | Unit tests for tools + reflection parsing |
| `frontend/app/rag/agent_query/route.ts` | Create | Next.js proxy for agent endpoint |
| `frontend/app/lib/api.ts` | Modify | Add `streamAgentQuery` generator |
| `frontend/app/components/panel/StockPanel.tsx` | Modify | Agent mode toggle + step indicator UI |

---

### Task 1: Agent tool functions

**Files:**
- Create: `backend/services/agentic_rag.py`
- Create: `backend/tests/test_agentic_rag.py`

- [ ] **Step 1: Create the test file with failing tests for `_search_articles`**

```python
# backend/tests/test_agentic_rag.py
from unittest.mock import patch, MagicMock
import pytest

# The module doesn't exist yet — this import fails
from services.agentic_rag import _search_articles


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
```

- [ ] **Step 2: Run test to verify it fails with ImportError**

```bash
cd backend && python -m pytest tests/test_agentic_rag.py -v 2>&1 | head -20
```
Expected: `ModuleNotFoundError: No module named 'services.agentic_rag'`

- [ ] **Step 3: Create `backend/services/agentic_rag.py` with tool functions**

```python
# backend/services/agentic_rag.py
import json
import logging
from typing import AsyncGenerator

import asyncpg
import httpx
from qdrant_client import QdrantClient
from qdrant_client.models import Filter, FieldCondition, MatchAny

from api.deps import get_settings

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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd backend && python -m pytest tests/test_agentic_rag.py -v
```
Expected: `2 passed`

- [ ] **Step 5: Commit**

```bash
git add backend/services/agentic_rag.py backend/tests/test_agentic_rag.py
git commit -m "feat: add agentic RAG tool functions (vector search, sentiment trend, news)"
```

---

### Task 2: Reflection step

**Files:**
- Modify: `backend/services/agentic_rag.py` (append)
- Modify: `backend/tests/test_agentic_rag.py` (append)

- [ ] **Step 1: Add failing tests for `_reflect` and `_format_context`**

Append to `backend/tests/test_agentic_rag.py`:

```python
from services.agentic_rag import _reflect, _format_context


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
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd backend && python -m pytest tests/test_agentic_rag.py::test_reflect_returns_sufficient_when_articles_found tests/test_agentic_rag.py::test_reflect_returns_safe_default_on_llm_failure tests/test_agentic_rag.py::test_format_context_includes_sentiment_and_headlines -v 2>&1 | head -20
```
Expected: `ImportError` or `AttributeError: module has no attribute '_reflect'`

- [ ] **Step 3: Append `_reflect` and `_format_context` to `agentic_rag.py`**

Append to `backend/services/agentic_rag.py`:

```python
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
```

- [ ] **Step 4: Run all tests to verify they pass**

```bash
cd backend && python -m pytest tests/test_agentic_rag.py -v
```
Expected: `5 passed`

- [ ] **Step 5: Commit**

```bash
git add backend/services/agentic_rag.py backend/tests/test_agentic_rag.py
git commit -m "feat: add reflection step and context formatter to agentic RAG"
```

---

### Task 3: Agent loop orchestration

**Files:**
- Modify: `backend/services/agentic_rag.py` (append)
- Modify: `backend/tests/test_agentic_rag.py` (append)

- [ ] **Step 1: Add a failing test for `agent_query_rag`**

Append to `backend/tests/test_agentic_rag.py`:

```python
import asyncio
from services.agentic_rag import agent_query_rag


def test_agent_query_rag_yields_step_and_answer_tokens():
    mock_db = MagicMock()

    async def fake_fetch(*args, **kwargs):
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd backend && python -m pytest tests/test_agentic_rag.py::test_agent_query_rag_yields_step_and_answer_tokens -v 2>&1 | head -20
```
Expected: `AttributeError: module 'services.agentic_rag' has no attribute 'agent_query_rag'`

- [ ] **Step 3: Append `agent_query_rag` to `agentic_rag.py`**

Append to `backend/services/agentic_rag.py`:

```python
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

    from services.rag_engine import _get_index
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
```

- [ ] **Step 4: Run all tests**

```bash
cd backend && python -m pytest tests/test_agentic_rag.py -v
```
Expected: `6 passed`

- [ ] **Step 5: Commit**

```bash
git add backend/services/agentic_rag.py backend/tests/test_agentic_rag.py
git commit -m "feat: implement agentic RAG orchestration loop with reflection and re-retrieval"
```

---

### Task 4: Backend API endpoint

**Files:**
- Modify: `backend/api/routes/rag.py`

- [ ] **Step 1: Add import for `agent_query_rag` at the top of `rag.py`**

In `backend/api/routes/rag.py`, find:

```python
from services.rag_engine import query_rag
```

Replace with:

```python
from services.rag_engine import query_rag
from services.agentic_rag import agent_query_rag
```

- [ ] **Step 2: Append the new endpoint to `rag.py`**

Append to the bottom of `backend/api/routes/rag.py`:

```python
@router.post("/agent_query")
async def rag_agent_query(req: QueryRequest, db: asyncpg.Pool = Depends(get_db)):
    """
    Agentic RAG endpoint. Streams SSE events:
      - __STEP__<id>|<detail>  — progress steps (retrieve, reflect, requery, synthesize)
      - <text token>           — final answer tokens
      - [DONE]                 — end of stream
    """
    async def event_stream():
        try:
            async for chunk in agent_query_rag(req.q, req.ticker, db):
                safe = chunk.replace("\n", " ")
                yield f"data: {safe}\n\n"
        except Exception as e:
            logger.error(f"Agent RAG stream error: {e}")
            yield f"data: [ERROR] {str(e)}\n\n"
        finally:
            yield "data: [DONE]\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )
```

- [ ] **Step 3: Restart backend and verify health**

```bash
docker compose restart backend && sleep 8 && curl -s http://localhost:8000/health
```
Expected: `{"status":"ok","version":"0.1.0"}`

- [ ] **Step 4: Smoke-test the agent endpoint**

```bash
curl -s -N -X POST http://localhost:8000/rag/agent_query \
  -H "Content-Type: application/json" \
  -d '{"q": "What is the outlook for NVDA?", "ticker": "NVDA"}' | head -20
```
Expected: SSE lines `data: __STEP__retrieve|Searching: ...` then `data: __STEP__retrieved|Found N articles` then text tokens then `data: [DONE]`

- [ ] **Step 5: Commit**

```bash
git add backend/api/routes/rag.py
git commit -m "feat: add POST /rag/agent_query streaming endpoint"
```

---

### Task 5: Frontend proxy route and API helper

**Files:**
- Create: `frontend/app/rag/agent_query/route.ts`
- Modify: `frontend/app/lib/api.ts`

- [ ] **Step 1: Create the Next.js proxy route**

```typescript
// frontend/app/rag/agent_query/route.ts
import { NextRequest } from "next/server";

const BACKEND = process.env.BACKEND_URL ?? "http://localhost:8000";

export async function POST(req: NextRequest) {
  const body = await req.text();

  const upstream = await fetch(`${BACKEND}/rag/agent_query`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body,
  });

  if (!upstream.ok) {
    return new Response(upstream.body, { status: upstream.status });
  }

  return new Response(upstream.body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
}
```

- [ ] **Step 2: Append `streamAgentQuery` to `frontend/app/lib/api.ts`**

Append to `frontend/app/lib/api.ts`:

```typescript
export async function* streamAgentQuery(
  question: string,
  ticker?: string
): AsyncGenerator<string> {
  const resp = await fetch(`${BASE}/rag/agent_query`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "ngrok-skip-browser-warning": "1",
    },
    body: JSON.stringify({ q: question, ticker }),
  });

  if (!resp.ok) throw new Error(`Agent RAG request failed (${resp.status})`);
  if (!resp.body) throw new Error("Agent RAG stream unavailable");

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      buffer += decoder.decode();
    } else {
      buffer += decoder.decode(value, { stream: true });
    }

    const parts = buffer.split(/\r?\n\r?\n/);
    if (!done) {
      buffer = parts.pop() ?? "";
    } else {
      buffer = "";
    }

    for (const rawEvent of parts) {
      const dataLines = rawEvent.split(/\r?\n/).filter(l => l.startsWith("data:"));
      if (!dataLines.length) continue;
      const payload = dataLines
        .map(l => { const v = l.slice(5); return v.startsWith(" ") ? v.slice(1) : v; })
        .join("\n");
      if (payload === "[DONE]") return;
      if (payload.startsWith("[ERROR]")) throw new Error(payload.slice(7).trim());
      if (payload) yield payload;
    }

    if (done) return;
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add frontend/app/rag/agent_query/route.ts frontend/app/lib/api.ts
git commit -m "feat: add agent_query proxy route and streamAgentQuery API helper"
```

---

### Task 6: Frontend UI — agent mode toggle and step indicator

**Files:**
- Modify: `frontend/app/components/panel/StockPanel.tsx`

- [ ] **Step 1: Add `streamAgentQuery` to the import**

In `StockPanel.tsx`, find:

```typescript
import { streamRagQuery } from "@/app/lib/api";
```

Replace with:

```typescript
import { streamRagQuery, streamAgentQuery } from "@/app/lib/api";
```

- [ ] **Step 2: Add agent mode and steps state**

Find in `StockPanel.tsx`:

```typescript
  const [ragQuery, setRagQuery] = useState("");
```

Add directly after it:

```typescript
  const [agentMode, setAgentMode] = useState(false);
  const [agentSteps, setAgentSteps] = useState<string[]>([]);
```

- [ ] **Step 3: Reset steps and branch the stream in `runRag`**

Find:

```typescript
    setRagAnswer("");
    setRagError(null);
```

Replace with:

```typescript
    setRagAnswer("");
    setRagError(null);
    setAgentSteps([]);
```

Find the `for await` loop inside `runRag`:

```typescript
      for await (const chunk of streamRagQuery(ragQuery, ticker ?? undefined)) {
        ragBufferRef.current += chunk;
```

Replace with:

```typescript
      const stream = agentMode
        ? streamAgentQuery(ragQuery, ticker ?? undefined)
        : streamRagQuery(ragQuery, ticker ?? undefined);
      for await (const chunk of stream) {
        if (chunk.startsWith("__STEP__")) {
          const detail = chunk.slice(chunk.indexOf("|") + 1).replace(/\n/g, "").trim();
          setAgentSteps(prev => [...prev, detail]);
          continue;
        }
        ragBufferRef.current += chunk;
```

- [ ] **Step 4: Add the mode toggle button in the JSX**

Find the Ask button's closing tag (look for `{ragLoading ? "⏳" : "Ask"}`). Directly after the closing `</button>` of the Ask button, add:

```tsx
                <button
                  onClick={() => setAgentMode(v => !v)}
                  style={{
                    padding: "4px 10px",
                    fontSize: "11px",
                    borderRadius: "6px",
                    border: `1px solid ${agentMode ? "#06b6d4" : "rgba(255,255,255,0.15)"}`,
                    background: agentMode ? "rgba(6,182,212,0.15)" : "transparent",
                    color: agentMode ? "#06b6d4" : "rgba(255,255,255,0.5)",
                    cursor: "pointer",
                    marginLeft: "6px",
                    whiteSpace: "nowrap",
                  }}
                >
                  {agentMode ? "⚡ Agentic" : "◇ Standard"}
                </button>
```

- [ ] **Step 5: Add step chips above the loading skeleton**

Find:

```tsx
            {ragLoading && !ragAnswer && (
```

Directly before that line, insert:

```tsx
            {agentSteps.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginBottom: "8px" }}>
                {agentSteps.map((step, i) => (
                  <span
                    key={i}
                    style={{
                      fontSize: "10px",
                      padding: "2px 8px",
                      borderRadius: "999px",
                      background: "rgba(6,182,212,0.1)",
                      border: "1px solid rgba(6,182,212,0.3)",
                      color: "#67e8f9",
                    }}
                  >
                    {step}
                  </span>
                ))}
              </div>
            )}
```

- [ ] **Step 6: Verify the frontend builds without TypeScript errors**

```bash
cd frontend && npm run build 2>&1 | tail -20
```
Expected: build succeeds with no type errors.

- [ ] **Step 7: Test in browser**
  1. Open `http://localhost:3001`
  2. Click a stock to open StockPanel
  3. Click `◇ Standard` → should toggle to `⚡ Agentic`
  4. Type "What is the outlook for NVDA?" and press Enter
  5. Verify cyan step chips appear: "Searching: ...", "Found N articles", "Context sufficient", "Generating analysis..."
  6. Verify the final answer streams in below the chips
  7. Toggle back to `◇ Standard`, ask a question — verify it works without chips

- [ ] **Step 8: Commit**

```bash
git add frontend/app/components/panel/StockPanel.tsx
git commit -m "feat: add agent mode toggle and step progress chips to StockPanel RAG UI"
```

---

## Self-Review

**Spec coverage:**
- ✅ query → reflect → re-retrieve → synthesize loop (`agent_query_rag`, Task 3)
- ✅ Three tools: vector search, sentiment trend, recent news (Task 1)
- ✅ JSON reflection via Ollama (Task 2)
- ✅ Max 2 re-retrieval iterations (`MAX_ITERATIONS = 2`, Task 3)
- ✅ Streaming SSE with step events (Tasks 4–5)
- ✅ Frontend step indicator (Task 6)
- ✅ Standard mode preserved (toggle, Task 6)

**Placeholder scan:** None found. All steps contain complete code.

**Type consistency:**
- `_search_articles` → `list[dict]` — consumed in `agent_query_rag` (Task 3) ✅
- `_reflect` → `dict` with keys `sufficient`, `gap`, `reformulated_query` — consumed in Task 3 ✅
- `agent_query_rag` → `AsyncGenerator[str, None]` — consumed in Task 4 route ✅
- `streamAgentQuery` → `AsyncGenerator<string>` — consumed in StockPanel (Task 6) ✅
- `__STEP__<id>|<detail>` format — produced in Task 3, parsed in Task 6 ✅
