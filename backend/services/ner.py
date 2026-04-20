"""
Ticker extraction from raw text.
Combines spaCy ORG entity recognition with regex matching against a known ticker set.
"""
import re
import logging
from functools import lru_cache

logger = logging.getLogger(__name__)

# Canonical ticker universe — expand as needed
KNOWN_TICKERS: frozenset[str] = frozenset({
    # Tech
    "NVDA", "MSFT", "AAPL", "AMD", "AMZN", "GOOGL", "GOOG", "META",
    "TSLA", "NFLX", "CRM", "ORCL", "PLTR", "SNOW", "NOW", "UBER",
    "LYFT", "ABNB", "COIN", "RBLX",
    # Finance
    "JPM", "GS", "BAC", "WFC", "C", "MS", "BLK", "BRK", "V", "MA",
    # Energy
    "XOM", "CVX", "COP", "SLB", "BP", "SHEL",
    # Health
    "JNJ", "PFE", "MRNA", "ABBV", "UNH", "LLY", "BMY",
    # Consumer
    "AMZN", "WMT", "TGT", "COST", "HD", "NKE", "MCD", "SBUX",
    # ETFs (often mentioned in sentiment context)
    "SPY", "QQQ", "IWM", "DIA", "VTI",
})

# Regex: 1-5 uppercase ASCII letters surrounded by word boundaries
_TICKER_RE = re.compile(r"\b([A-Z]{1,5})\b")


@lru_cache(maxsize=1)
def _load_nlp():
    """Load spaCy model once (cached). Falls back to None on missing model."""
    try:
        import spacy
        nlp = spacy.load("en_core_web_sm", disable=["parser", "lemmatizer"])
        logger.info("spaCy NER loaded")
        return nlp
    except Exception as e:
        logger.warning(f"spaCy model unavailable ({e}); using regex-only NER")
        return None


def extract_tickers(text: str) -> list[str]:
    """
    Extract known ticker symbols from text.

    Strategy:
    1. spaCy ORG entities → check each against KNOWN_TICKERS
    2. Regex uppercase words → check against KNOWN_TICKERS
    Both results are merged and deduplicated.

    Returns sorted list of unique ticker strings.
    """
    if not text:
        return []

    found: set[str] = set()

    # ── spaCy ORG entity pass ────────────────────────────
    nlp = _load_nlp()
    if nlp is not None:
        doc = nlp(text[:8_000])  # limit to first 8 K chars for speed
        for ent in doc.ents:
            if ent.label_ == "ORG":
                candidate = ent.text.strip().upper()
                if candidate in KNOWN_TICKERS:
                    found.add(candidate)

    # ── Regex pass ───────────────────────────────────────
    for m in _TICKER_RE.finditer(text):
        candidate = m.group(1)
        if candidate in KNOWN_TICKERS:
            found.add(candidate)

    return sorted(found)
