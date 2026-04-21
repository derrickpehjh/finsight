"use client";

import { useState, useCallback, useEffect } from "react";
import type { StockOverview } from "@/app/lib/types";

interface Props {
  stocks: StockOverview[];
  selectedTicker: string | null;
  onSelect: (ticker: string) => void;
  watchlist: Set<string>;
  onAdd: (ticker: string) => void;
  onRemove: (ticker: string) => void;
}

const SECTOR_COLORS: Record<string, string> = {
  Technology:              "#06b6d4",
  "Communication Services":"#06b6d4",
  "Consumer Cyclical":     "#a78bfa",
  Energy:                  "#34d399",
  Finance:                 "#fbbf24",
  Financial:               "#fbbf24",
  "Financial Services":    "#fbbf24",
  Healthcare:              "#a78bfa",
  Industrials:             "#94a3b8",
  Unknown:                 "#64748b",
};

function StockRow({
  s, isSelected, inWatchlist, onSelect, onAdd, onRemove,
}: {
  s: StockOverview; isSelected: boolean; inWatchlist: boolean;
  onSelect: (t: string) => void; onAdd: (t: string) => void; onRemove: (t: string) => void;
}) {
  const isUp      = s.change_pct >= 0;
  const fillW     = Math.min(100, Math.abs(s.sentiment_score) * 100).toFixed(0) + "%";
  const fillClass = s.sentiment_score > 0.1 ? "tf-b" : s.sentiment_score < -0.1 ? "tf-r" : "tf-n";
  return (
    <div
      className={`t-row ${isSelected ? "active" : ""}`}
      onClick={() => onSelect(s.ticker)}
      style={{ position: "relative" }}
    >
      <span className="t-sym">{s.ticker}</span>
      <div className="t-mid">
        <div className="t-track">
          <div className={`t-fill ${fillClass}`} style={{ width: fillW }} />
        </div>
      </div>
      <div className="t-right" style={{ display: "flex", alignItems: "center", gap: 4 }}>
        {s.price === 0
          ? <span style={{ color: "var(--c4)", fontSize: 10, fontFamily: "var(--mono)" }}>loading…</span>
          : <span className={`t-val ${isUp ? "up" : "dn"}`}>
              {isUp ? "+" : ""}{s.change_pct.toFixed(1)}%
            </span>
        }
        <button
          title={inWatchlist ? "Remove from watchlist" : "Add to watchlist"}
          onClick={e => { e.stopPropagation(); inWatchlist ? onRemove(s.ticker) : onAdd(s.ticker); }}
          style={{
            background: "none", border: "none", cursor: "pointer", padding: "0 2px",
            fontSize: 12, lineHeight: 1,
            color: inWatchlist ? "rgba(251,113,133,0.8)" : "rgba(100,116,139,0.6)",
            transition: "color 0.15s", fontFamily: "var(--mono)",
          }}
          onMouseEnter={e => (e.currentTarget.style.color = inWatchlist ? "rgba(251,113,133,1)" : "rgba(52,211,153,0.9)")}
          onMouseLeave={e => (e.currentTarget.style.color = inWatchlist ? "rgba(251,113,133,0.8)" : "rgba(100,116,139,0.6)")}
        >
          {inWatchlist ? "×" : "+"}
        </button>
      </div>
    </div>
  );
}

// Minimal row for tickers saved to watchlist but not in the tracked stocks overview
function WatchlistOnlyRow({
  ticker, isSelected, onSelect, onRemove,
}: {
  ticker: string; isSelected: boolean;
  onSelect: (t: string) => void; onRemove: (t: string) => void;
}) {
  return (
    <div
      className={`t-row ${isSelected ? "active" : ""}`}
      onClick={() => onSelect(ticker)}
      style={{ position: "relative", opacity: 0.75 }}
    >
      <span className="t-sym">{ticker}</span>
      <div className="t-mid">
        <div style={{ fontSize: 10, color: "var(--c4)", fontFamily: "var(--mono)" }}>
          awaiting data…
        </div>
      </div>
      <div className="t-right" style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <button
          title="Remove from watchlist"
          onClick={e => { e.stopPropagation(); onRemove(ticker); }}
          style={{
            background: "none", border: "none", cursor: "pointer", padding: "0 2px",
            fontSize: 12, lineHeight: 1, color: "rgba(251,113,133,0.8)",
            transition: "color 0.15s", fontFamily: "var(--mono)",
          }}
          onMouseEnter={e => (e.currentTarget.style.color = "rgba(251,113,133,1)")}
          onMouseLeave={e => (e.currentTarget.style.color = "rgba(251,113,133,0.8)")}
        >
          ×
        </button>
      </div>
    </div>
  );
}

export default function Watchlist({ stocks, selectedTicker, onSelect, watchlist, onAdd, onRemove }: Props) {
  const [query, setQuery] = useState("");
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(id);
  }, [toast]);

  const handleAdd = useCallback((ticker: string) => {
    const t = ticker.trim().toUpperCase();
    if (!t) return;
    const isTracked = stocks.some(s => s.ticker === t);
    onAdd(t);
    if (!isTracked) setToast(`${t} saved to watchlist`);
    setQuery("");
  }, [stocks, onAdd]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      const t = query.trim().toUpperCase();
      if (t) handleAdd(t);
    } else if (e.key === "Escape") {
      setQuery("");
    }
  }, [query, handleAdd]);

  const stockTickers   = new Set(stocks.map(s => s.ticker));
  // Watchlisted tickers that have full overview data
  const watchlistedStocks = stocks.filter(s => watchlist.has(s.ticker));
  // Watchlisted tickers with no overview data (custom user additions)
  const watchlistOnlyTickers = Array.from(watchlist).filter(t => !stockTickers.has(t));

  // When searching: show all matching stocks
  // When not searching: "All" section only shows non-watchlisted stocks (watchlisted ones are above)
  const filtered = query
    ? stocks.filter(s =>
        s.ticker.includes(query.toUpperCase()) ||
        s.sector.toLowerCase().includes(query.toLowerCase())
      )
    : stocks.filter(s => !watchlist.has(s.ticker));

  return (
    <aside className="sb">
      {toast && (
        <div style={{
          position: "absolute", top: 8, left: 8, right: 8, zIndex: 50,
          background: "rgba(52,211,153,0.15)", border: "1px solid rgba(52,211,153,0.35)",
          borderRadius: 6, padding: "6px 10px",
          color: "#34d399", fontSize: 11, fontFamily: "var(--mono)",
          pointerEvents: "none",
        }}>
          ✓ {toast}
        </div>
      )}
      <div className="sb-search" style={{ marginTop: toast ? 36 : 0, transition: "margin-top 0.2s" }}>
        <input
          className="search-input"
          type="text"
          placeholder="Search or add ticker…"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
        />
      </div>

      <div className="sb-list">

        {/* ── Watchlist section ─────────────────────────────────────── */}
        <div className="sb-hdr">
          Watchlist
          <span style={{ color: "var(--c4)", fontWeight: 400, marginLeft: 4 }}>
            ({watchlist.size})
          </span>
        </div>

        {watchlist.size === 0 && !query && (
          <div style={{ padding: "8px 12px", color: "var(--c4)", fontSize: 11, fontFamily: "var(--mono)" }}>
            Press + on any ticker to watch it
          </div>
        )}

        {watchlistedStocks.map(s => (
          <StockRow
            key={s.ticker} s={s}
            isSelected={selectedTicker === s.ticker}
            inWatchlist
            onSelect={onSelect} onAdd={handleAdd} onRemove={onRemove}
          />
        ))}

        {watchlistOnlyTickers.map(ticker => (
          <WatchlistOnlyRow
            key={ticker} ticker={ticker}
            isSelected={selectedTicker === ticker}
            onSelect={onSelect} onRemove={onRemove}
          />
        ))}

        {/* ── All / search results ──────────────────────────────────── */}
        <div className="sb-hdr" style={{ marginTop: 8 }}>
          {query ? "Search results" : "All Tickers"}
        </div>

        {stocks.length === 0 && (
          <div style={{ padding: "12px", color: "var(--c4)", fontSize: 11, fontFamily: "var(--mono)" }}>
            Loading…
          </div>
        )}

        {filtered.map(s => (
          <StockRow
            key={s.ticker} s={s}
            isSelected={selectedTicker === s.ticker}
            inWatchlist={watchlist.has(s.ticker)}
            onSelect={onSelect} onAdd={handleAdd} onRemove={onRemove}
          />
        ))}

        {query && filtered.length === 0 && (
          <div
            style={{ padding: "8px 12px", color: "var(--c4)", fontSize: 11, fontFamily: "var(--mono)", cursor: "pointer" }}
            onClick={() => handleAdd(query)}
          >
            + Add {query.toUpperCase()} to watchlist
          </div>
        )}

        {/* ── Sector summary ────────────────────────────────────────── */}
        <div className="sb-hdr" style={{ marginTop: 6 }}>Sectors</div>
        {Object.entries(
          stocks.reduce<Record<string, number[]>>((acc, s) => {
            if (!acc[s.sector]) acc[s.sector] = [];
            acc[s.sector].push(s.change_pct);
            return acc;
          }, {})
        ).map(([sector, changes]) => {
          const avg   = changes.reduce((a, b) => a + b, 0) / changes.length;
          const color = SECTOR_COLORS[sector] ?? "#64748b";
          const abbr  = sector.slice(0, 4).toUpperCase();
          return (
            <div key={sector} className="t-row">
              <span className="t-sym" style={{ color: `${color}cc`, fontSize: 11 }}>{abbr}</span>
              <div className="t-mid">
                <div className="t-track">
                  <div className="t-fill" style={{
                    width: `${Math.min(100, Math.abs(avg) * 10 + 30)}%`,
                    background: avg >= 0
                      ? `linear-gradient(90deg, ${color}, ${color}66)`
                      : "linear-gradient(90deg, #fb7185, rgba(251,113,133,0.4))",
                  }}/>
                </div>
              </div>
              <div className="t-right">
                <span className={`t-val ${avg >= 0 ? "up" : "dn"}`}>
                  {avg >= 0 ? "+" : ""}{avg.toFixed(1)}%
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
