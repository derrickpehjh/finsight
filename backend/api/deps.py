from functools import lru_cache
from pydantic_settings import BaseSettings
import redis.asyncio as aioredis
import asyncpg
from qdrant_client import AsyncQdrantClient


class Settings(BaseSettings):
    database_url: str = "postgresql://finsight:finsight@localhost:5432/finsight"
    qdrant_url: str = "http://localhost:6333"
    redis_url: str = "redis://localhost:6379"
    ollama_url: str = "http://localhost:11434"
    # Optional: NewsAPI key for additional news sources (https://newsapi.org/register — free)
    newsapi_key: str = ""
    # Reddit is scraped via public JSON endpoints — no API key needed

    class Config:
        env_file = ".env"
        extra = "ignore"


@lru_cache
def get_settings() -> Settings:
    return Settings()


# ── Shared async clients (lazy-initialized singletons) ────────────────────────

_redis: aioredis.Redis | None = None
_pool: asyncpg.Pool | None = None
_qdrant: AsyncQdrantClient | None = None


async def get_redis() -> aioredis.Redis:
    global _redis
    if _redis is None:
        _redis = aioredis.from_url(get_settings().redis_url, decode_responses=True)
    return _redis


async def get_db() -> asyncpg.Pool:
    global _pool
    if _pool is None:
        _pool = await asyncpg.create_pool(get_settings().database_url, min_size=2, max_size=10)
    return _pool


async def get_qdrant() -> AsyncQdrantClient:
    global _qdrant
    if _qdrant is None:
        _qdrant = AsyncQdrantClient(url=get_settings().qdrant_url)
    return _qdrant
