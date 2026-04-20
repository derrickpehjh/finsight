"""
FinBERT sentiment scorer.
Loads ProsusAI/finbert once at startup; call score_texts() for batch inference.
"""
import logging
from typing import Optional

import torch
from transformers import AutoTokenizer, AutoModelForSequenceClassification

logger = logging.getLogger(__name__)

# Module-level singletons — loaded once, reused for every request
_tokenizer = None
_model = None
_device: Optional[str] = None


def load_finbert() -> None:
    """Load FinBERT model into memory. Safe to call multiple times."""
    global _tokenizer, _model, _device
    if _tokenizer is not None:
        return

    model_name = "ProsusAI/finbert"
    logger.info(f"Loading {model_name} (first run downloads ~440 MB to HF cache)...")

    _tokenizer = AutoTokenizer.from_pretrained(model_name)
    _model = AutoModelForSequenceClassification.from_pretrained(model_name)
    _device = "cuda" if torch.cuda.is_available() else "cpu"
    _model = _model.to(_device)
    _model.eval()

    logger.info(f"FinBERT ready on {_device}")


def score_texts(texts: list[str], batch_size: int = 16) -> list[dict]:
    """
    Score a list of texts with FinBERT.

    Returns:
        List of {positive, negative, neutral} probability dicts,
        one per input text, in the same order.

    FinBERT label order: 0=positive, 1=negative, 2=neutral.
    """
    if not texts:
        return []
    if _tokenizer is None:
        load_finbert()

    results = []

    for i in range(0, len(texts), batch_size):
        batch = texts[i : i + batch_size]
        # Truncate to 512 tokens — FinBERT's max context
        inputs = _tokenizer(
            batch,
            padding=True,
            truncation=True,
            max_length=512,
            return_tensors="pt",
        ).to(_device)

        with torch.no_grad():
            logits = _model(**inputs).logits
            probs = torch.softmax(logits, dim=-1).cpu().numpy()

        for p in probs:
            results.append({
                "positive": float(p[0]),
                "negative": float(p[1]),
                "neutral":  float(p[2]),
            })

    return results


def aggregate_sentiment(scores: list[dict]) -> dict:
    """
    Average individual article scores into a ticker-level summary.

    Returns:
        {bull_pct, bear_pct, neutral_pct, score}
        where score = bull_pct − bear_pct ∈ [−1, +1]
    """
    if not scores:
        return {"bull_pct": 0.0, "bear_pct": 0.0, "neutral_pct": 0.0, "score": 0.0}

    n = len(scores)
    bull    = sum(s["positive"] for s in scores) / n
    bear    = sum(s["negative"] for s in scores) / n
    neutral = sum(s["neutral"]  for s in scores) / n

    return {
        "bull_pct":    round(bull, 4),
        "bear_pct":    round(bear, 4),
        "neutral_pct": round(neutral, 4),
        "score":       round(bull - bear, 4),
    }
