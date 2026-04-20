"""
Qdrant collection management.
ensure_collection() is called at startup to create the collection if absent.
"""
import logging
from qdrant_client import AsyncQdrantClient
from qdrant_client.models import Distance, VectorParams

from api.deps import get_settings

logger = logging.getLogger(__name__)

COLLECTION_NAME = "finsight_articles"
VECTOR_SIZE = 768  # nomic-embed-text output dimension


async def ensure_collection() -> None:
    """Create the Qdrant collection if it doesn't already exist."""
    settings = get_settings()
    client = AsyncQdrantClient(url=settings.qdrant_url)

    try:
        existing = await client.get_collections()
        names = {c.name for c in existing.collections}

        if COLLECTION_NAME not in names:
            await client.create_collection(
                collection_name=COLLECTION_NAME,
                vectors_config=VectorParams(
                    size=VECTOR_SIZE,
                    distance=Distance.COSINE,
                ),
            )
            logger.info(f"Created Qdrant collection '{COLLECTION_NAME}' (dim={VECTOR_SIZE})")
        else:
            logger.info(f"Qdrant collection '{COLLECTION_NAME}' already exists")
    except Exception as e:
        logger.error(f"Failed to ensure Qdrant collection: {e}")
    finally:
        await client.close()
