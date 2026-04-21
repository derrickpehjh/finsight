"""
Direct Yahoo Finance price fetcher using httpx.
Replaces yfinance to avoid the cookie-auth breakage in yfinance <0.2.43.

Uses the undocumented but stable v8 chart API (no auth required) for prices
and momentum. Uses v10 quoteSummary with crumb auth for market cap + sector.
Crumbs are cached in memory for 1 hour.
"""
import logging
import time
import httpx

logger = logging.getLogger(__name__)

_YF_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://finance.yahoo.com/",
}
_YF_BASE = "https://query1.finance.yahoo.com"
_YF_BASE2 = "https://query2.finance.yahoo.com"  # fallback

# Crumb cache: (crumb_string, cookies_dict, fetched_at_epoch)
_crumb_cache: tuple[str, dict, float] | None = None
_CRUMB_TTL = 3600  # 1 hour


def _get_crumb() -> tuple[str, dict] | None:
    """
    Fetch a Yahoo Finance crumb + session cookies.
    Uses fc.yahoo.com (Fastly CDN) to get cookies without GDPR friction,
    mirroring the approach taken by yfinance >= 0.2.43.
    Returns (crumb, cookies) or None on failure.
    """
    global _crumb_cache
    now = time.time()
    if _crumb_cache and (now - _crumb_cache[2]) < _CRUMB_TTL:
        return _crumb_cache[0], _crumb_cache[1]

    try:
        with httpx.Client(headers=_YF_HEADERS, follow_redirects=True, timeout=15.0) as client:
            # Step 1: fc.yahoo.com sets A1/A3 cookies without consent friction
            r1 = client.get("https://fc.yahoo.com/")
            cookies = dict(client.cookies)  # cookies from all redirects
            if not cookies:
                # Fallback: try finance.yahoo.com
                r1b = client.get("https://finance.yahoo.com/")
                cookies = dict(client.cookies)

            cookie_str = "; ".join(f"{k}={v}" for k, v in cookies.items())

            # Step 2: fetch crumb with the session cookies
            r2 = client.get(
                "https://query2.finance.yahoo.com/v1/test/getcrumb",
                headers={**_YF_HEADERS, "cookie": cookie_str},
            )
            if r2.status_code == 200 and r2.text and len(r2.text.strip()) > 3:
                crumb = r2.text.strip()
                _crumb_cache = (crumb, cookies, now)
                logger.info(f"Yahoo Finance crumb ok: {crumb[:8]}...")
                return crumb, cookies
            else:
                logger.debug(f"Crumb endpoint returned {r2.status_code}: {r2.text[:100]}")
    except Exception as e:
        logger.debug(f"Crumb fetch failed: {e}")
    return None


def _get(url: str, params: dict | None = None) -> dict | None:
    """GET JSON from Yahoo Finance, trying both query1 and query2 hostnames."""
    for base in (_YF_BASE, _YF_BASE2):
        full_url = url.replace(_YF_BASE, base).replace(_YF_BASE2, base)
        try:
            resp = httpx.get(full_url, headers=_YF_HEADERS, params=params, timeout=15.0, follow_redirects=True)
            if resp.status_code == 200:
                data = resp.json()
                return data
        except Exception as e:
            logger.debug(f"YF fetch failed ({base}): {e}")
    return None


def _get_authed(url: str, params: dict | None = None) -> dict | None:
    """GET JSON from Yahoo Finance with crumb auth. Falls back to unauthed on failure."""
    crumb_data = _get_crumb()
    if not crumb_data:
        return _get(url, params)

    crumb, cookies = crumb_data
    auth_params = {**(params or {}), "crumb": crumb}
    cookie_str = "; ".join(f"{k}={v}" for k, v in cookies.items())
    headers = {**_YF_HEADERS, "cookie": cookie_str}

    for base in (_YF_BASE, _YF_BASE2):
        full_url = url.replace(_YF_BASE, base).replace(_YF_BASE2, base)
        try:
            resp = httpx.get(full_url, headers=headers, params=auth_params, timeout=15.0, follow_redirects=True)
            if resp.status_code == 200:
                return resp.json()
            elif resp.status_code == 401:
                # Crumb expired — invalidate cache and retry once
                global _crumb_cache
                _crumb_cache = None
                fresh = _get_crumb()
                if fresh:
                    crumb2, cookies2 = fresh
                    auth_params["crumb"] = crumb2
                    headers["cookie"] = "; ".join(f"{k}={v}" for k, v in cookies2.items())
                    resp2 = httpx.get(full_url, headers=headers, params=auth_params, timeout=15.0, follow_redirects=True)
                    if resp2.status_code == 200:
                        return resp2.json()
        except Exception as e:
            logger.debug(f"YF authed fetch failed ({base}): {e}")
    return None


def get_intraday_price(ticker: str) -> dict:
    """
    Fetch today's open and latest close for the given ticker.
    Returns {'price': float, 'change_pct': float} or empty dict on failure.
    """
    url = f"{_YF_BASE}/v8/finance/chart/{ticker.upper()}"
    data = _get(url, params={"interval": "5m", "range": "1d"})
    if not data:
        return {}
    try:
        result = data["chart"]["result"][0]
        closes = [c for c in (result["indicators"]["quote"][0].get("close") or []) if c is not None]
        opens  = [o for o in (result["indicators"]["quote"][0].get("open")  or []) if o is not None]
        if closes and opens:
            price      = closes[-1]
            open_price = opens[0]
            change_pct = (price - open_price) / open_price * 100 if open_price else 0.0
            return {"price": round(price, 2), "change_pct": round(change_pct, 2)}
    except (KeyError, IndexError, TypeError) as e:
        logger.debug(f"YF intraday parse error for {ticker}: {e}")
    return {}


def get_ticker_meta(ticker: str) -> dict:
    """
    Fetch 14-day momentum %, market cap, and sector.
    Returns safe defaults on failure.
    """
    default = {"momentum_7d": 0.0, "market_cap": 0, "sector": "Unknown"}

    # --- 14-day daily chart for momentum ---
    chart_url = f"{_YF_BASE}/v8/finance/chart/{ticker.upper()}"
    chart_data = _get(chart_url, params={"interval": "1d", "range": "14d"})
    momentum_7d = 0.0
    if chart_data:
        try:
            result = chart_data["chart"]["result"][0]
            closes = [c for c in (result["indicators"]["quote"][0].get("close") or []) if c is not None]
            if len(closes) >= 2:
                momentum_7d = (closes[-1] - closes[0]) / closes[0] * 100
        except (KeyError, IndexError, TypeError) as e:
            logger.debug(f"YF momentum parse error for {ticker}: {e}")

    # --- quoteSummary for market cap + sector (requires crumb auth) ---
    market_cap = 0
    sector = "Unknown"
    summary_url = f"{_YF_BASE}/v10/finance/quoteSummary/{ticker.upper()}"
    summary_data = _get_authed(summary_url, params={"modules": "summaryProfile,price"})
    if summary_data:
        try:
            qs = summary_data.get("quoteSummary", {}).get("result", [{}])[0]
            price_mod = qs.get("price", {})
            profile   = qs.get("summaryProfile", {})
            market_cap = int(price_mod.get("marketCap", {}).get("raw", 0) or 0)
            sector     = profile.get("sector") or price_mod.get("quoteType") or "Unknown"
        except (KeyError, IndexError, TypeError) as e:
            logger.debug(f"YF summary parse error for {ticker}: {e}")

    return {
        "momentum_7d": round(float(momentum_7d), 4),
        "market_cap":  int(market_cap),
        "sector":      sector,
    }


def get_batch_prices(tickers: list[str]) -> dict[str, dict]:
    """
    Fetch intraday prices for a list of tickers.
    Returns {ticker: {'price': float, 'change_pct': float}}.
    Runs sequentially to avoid hammering Yahoo Finance.
    """
    result: dict[str, dict] = {}
    for i, ticker in enumerate(tickers):
        if i > 0:
            time.sleep(0.2)  # 200 ms between requests — polite but fast
        data = get_intraday_price(ticker)
        if data:
            result[ticker] = data
    return result
