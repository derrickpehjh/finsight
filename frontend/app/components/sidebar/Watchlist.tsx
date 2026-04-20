"use client";

import type { StockOverview } from "@/app/lib/types";

interface Props {
  stocks: StockOverview[];
  selectedTicker: string | null;
  onSelect: (ticker: string) => void;
}

const SECTOR_COLORS: Record<string, string> = {
  Technology: "#06b6d4",
  Energy:     "#34d399",
  Finance:    "#fbbf24",
  Healthcare: "#a78bfa",
};

export default function Watchlist({ stocks, selectedTicker, onSelect }: Props) {
  return (
    <aside className="sb">
      <div className="sb-search">
        <input className="search-input" type="text" placeholder="Search tickers…" />
      </div>

      <div className="sb-list">
        <div className="sb-hdr">Watchlist</div>
        {stocks.length === 0 && (
          <div style={{ padding: "12px", color: "var(--c4)", fontSize: 11, fontFamily: "var(--mono)" }}>
            Loading…
          </div>
        )}
        {stocks.map(s => {
          const isUp = s.change_pct >= 0;
          const fillW = Math.min(100, Math.abs(s.sentiment_score) * 100).toFixed(0) + "%";
          const fillClass = s.sentiment_score > 0.1 ? "tf-b" : s.sentiment_score < -0.1 ? "tf-r" : "tf-n";
          return (
            <div
              key={s.ticker}
              className={`t-row ${selectedTicker === s.ticker ? "active" : ""}`}
              onClick={() => onSelect(s.ticker)}
            >
              <span className="t-sym">{s.ticker}</span>
              <div className="t-mid">
                <div className="t-track">
                  <div className={`t-fill ${fillClass}`} style={{ width: fillW }} />
                </div>
              </div>
              <div className="t-right">
                <span className={`t-val ${isUp ? "up" : "dn"}`}>
                  {isUp ? "+" : ""}{s.change_pct.toFixed(1)}%
                </span>
              </div>
            </div>
          );
        })}

        {/* Sector summary */}
        <div className="sb-hdr" style={{ marginTop: 6 }}>Sectors</div>
        {Object.entries(
          stocks.reduce<Record<string, number[]>>((acc, s) => {
            if (!acc[s.sector]) acc[s.sector] = [];
            acc[s.sector].push(s.change_pct);
            return acc;
          }, {})
        ).map(([sector, changes]) => {
          const avg = changes.reduce((a, b) => a + b, 0) / changes.length;
          const color = SECTOR_COLORS[sector] ?? "#64748b";
          const abbr = sector.slice(0, 4).toUpperCase();
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
