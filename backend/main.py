import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from api.routes import stocks, news, rag, watchlist
from services.ingester import start_scheduler
from services.processor import start_processor
from services.sentiment import load_finbert
from db.qdrant_client import ensure_collection

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # ── Startup ────────────────────────────────────────
    logger.info("Loading FinBERT model (first run downloads ~440 MB)...")
    load_finbert()

    logger.info("Ensuring Qdrant collection exists...")
    await ensure_collection()

    logger.info("Starting background processor...")
    start_processor()

    logger.info("Starting ingestion scheduler (15-min cycle)...")
    start_scheduler()

    yield
    # ── Shutdown (nothing to clean up — threads are daemon) ──


app = FastAPI(
    title="FinSight API",
    description="Financial news RAG system with real-time sentiment analysis",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Tighten to Vercel domain in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(stocks.router,    prefix="/stocks",    tags=["stocks"])
app.include_router(news.router,      prefix="/news",      tags=["news"])
app.include_router(rag.router,       prefix="/rag",       tags=["rag"])
app.include_router(watchlist.router, prefix="/watchlist", tags=["watchlist"])


@app.get("/health", tags=["health"])
async def health():
    return {"status": "ok", "version": "0.1.0"}
