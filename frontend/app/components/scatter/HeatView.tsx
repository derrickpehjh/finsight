"use client";

import type { StockOverview } from "@/app/lib/types";

interface Props {
  stocks: StockOverview[];
  selectedTicker: string | null;
  onSelect: (ticker: string) => void;
}

const METRICS = [
  { key: "sentiment_score", label: "Sentiment",  fmt: (v: number) => (v >= 0 ? "+" : "") + v.toFixed(2) },
  { key: "bull_pct",        label: "Bull %",      fmt: (v: number) => (v * 100).toFixed(0) + "%" },
  { key: "bear_pct",        label: "Bear %",      fmt: (v: number) => (v * 100).toFixed(0) + "%" },
  { key: "momentum_7d",     label: "Momentum",    fmt: (v: number) => (v >= 0 ? "+" : "") + v.toFixed(1) + "%" },
  { key: "neutral_pct",     label: "Neutral %",   fmt: (v: number) => (v * 100).toFixed(0) + "%" },
] as const;

function cellColor(key: typeof METRICS[number]["key"], value: number): string {
  if (key === "sentiment_score") {
    const norm = Math.max(-1, Math.min(1, value));
    if (norm > 0) return `rgba(52,211,153,${Math.min(0.8, norm * 0.75)})`;
    return `rgba(251,113,133,${Math.min(0.8, -norm * 0.75)})`;
  }
  if (key === "bull_pct") return `rgba(52,211,153,${Math.min(0.85, value * 1.2)})`;
  if (key === "bear_pct") return `rgba(251,113,133,${Math.min(0.85, value * 1.2)})`;
  if (key === "momentum_7d") {
    const norm = Math.max(-10, Math.min(10, value)) / 10;
    if (norm > 0) return `rgba(52,211,153,${Math.min(0.8, norm * 0.8)})`;
    return `rgba(251,113,133,${Math.min(0.8, -norm * 0.8)})`;
  }
  if (key === "neutral_pct") return `rgba(148,163,184,${Math.min(0.6, value * 0.5)})`;
  return "rgba(148,163,184,0.15)";
}

export default function HeatView({ stocks, selectedTicker, onSelect }: Props) {
  if (!stocks.length) {
    return (
      <div className="absolute inset-0 flex items-center justify-center"
           style={{ color: "var(--c4)", fontFamily: "var(--mono)", fontSize: 13 }}>
        No data — waiting for ingestion cycle...
      </div>
    );
  }

  // Sort by sentiment score descending
  const sorted = [...stocks].sort((a, b) => b.sentiment_score - a.sentiment_score);

  return (
    <div className="absolute inset-0 overflow-auto"
         style={{ padding: "16px 20px 20px", fontFamily: "var(--mono)" }}>
      {/* Title */}
      <div style={{ color: "var(--c4)", fontSize: 11, marginBottom: 16, letterSpacing: "0.05em" }}>
        SENTIMENT HEATMAP  ·  sorted by sentiment score (desc)
      </div>

      {/* Table */}
      <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: "2px 2px" }}>
        <thead>
          <tr>
            <th style={{ width: 70, textAlign: "left", color: "var(--c4)", fontSize: 11, fontWeight: 500, paddingBottom: 8 }}>TICKER</th>
            {METRICS.map(m => (
              <th key={m.key} style={{ color: "var(--c4)", fontSize: 11, fontWeight: 500, paddingBottom: 8, textAlign: "center" }}>
                {m.label.toUpperCase()}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map(stock => {
            const isSel = stock.ticker === selectedTicker;
            return (
              <tr
                key={stock.ticker}
                onClick={() => onSelect(stock.ticker)}
                style={{ cursor: "pointer" }}
              >
                {/* Ticker label */}
                <td style={{
                  padding: "6px 10px 6px 4px",
                  color: isSel ? "#ffffff" : "var(--c2)",
                  fontSize: 13,
                  fontWeight: isSel ? 700 : 500,
                  background: isSel ? "rgba(6,182,212,0.12)" : "transparent",
                  borderRadius: 4,
                  borderLeft: isSel ? "2px solid #06b6d4" : "2px solid transparent",
                }}>
                  {stock.ticker}
                </td>
                {/* Metric cells */}
                {METRICS.map(m => {
                  const val = stock[m.key] as number;
                  const bg  = cellColor(m.key, val);
                  return (
                    <td key={m.key} style={{
                      padding: "6px 8px",
                      background: bg,
                      borderRadius: 4,
                      textAlign: "center",
                      fontSize: 12,
                      color: "#ffffff",
                      fontWeight: 500,
                      letterSpacing: "0.02em",
                      minWidth: 72,
                    }}>
                      {m.fmt(val)}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>

      {/* Legend */}
      <div style={{ marginTop: 20, display: "flex", gap: 20, color: "var(--c4)", fontSize: 11 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <div style={{ width: 14, height: 14, borderRadius: 3, background: "rgba(52,211,153,0.7)" }}/>
          <span>Bullish / Positive momentum</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <div style={{ width: 14, height: 14, borderRadius: 3, background: "rgba(251,113,133,0.7)" }}/>
          <span>Bearish / Negative momentum</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <div style={{ width: 14, height: 14, borderRadius: 3, background: "rgba(148,163,184,0.5)" }}/>
          <span>Neutral</span>
        </div>
      </div>
    </div>
  );
}
