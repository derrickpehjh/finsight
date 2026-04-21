"use client";

import { useState, useRef } from "react";
import StockScatter from "./components/scatter/StockScatter";
import NetworkView, { type NetworkViewHandle } from "./components/scatter/NetworkView";
import HeatView     from "./components/scatter/HeatView";
import StockPanel   from "./components/panel/StockPanel";
import Watchlist    from "./components/sidebar/Watchlist";
import { useStocksOverview } from "./hooks/useStocksOverview";
import { useWatchlist } from "./hooks/useWatchlist";

type ViewMode = "Scatter" | "Network" | "Heat";

export default function Home() {
  const [activeTime, setActiveTime] = useState("4H");
  const [viewMode, setViewMode] = useState<ViewMode>("Scatter");
  const [selectedTicker, setSelectedTicker] = useState<string | null>(null);
  const [showGuide, setShowGuide] = useState(false);

  const { stocks, isLoading } = useStocksOverview(activeTime);
  const { watchlist, add: addToWatchlist, remove: removeFromWatchlist } = useWatchlist();

  const selectedStock  = stocks.find(s => s.ticker === selectedTicker);
  const networkRef     = useRef<NetworkViewHandle>(null);

  return (
    <div className="app">
      <nav className="nav">
        <div className="brand">
          <div className="brand-icon">FS</div>
          <div className="brand-name">FINSIGHT</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div className="time-filter">
            {(["1H","4H","1D","1W"] as const).map(t => (
              <button
                key={t}
                className={`tf-btn ${activeTime === t ? "on" : ""}`}
                onClick={() => setActiveTime(t)}
              >{t}</button>
            ))}
          </div>
          <div className="mode-group">
            {(["Scatter","Network","Heat"] as const).map(m => (
              <button
                key={m}
                className={`mg-btn ${viewMode === m ? "on" : ""}`}
                onClick={() => setViewMode(m)}
              >⬡ {m}</button>
            ))}
          </div>
        </div>
        <div className="nav-r">
          <div className="live-dot"/>
          <span style={{ color: "var(--bull)", fontWeight: 500 }}>LIVE</span>
          <span style={{ color: "var(--c4)" }}>·</span>
          <span className="num">{stocks.length}</span> tickers
          <span style={{ color: "var(--c4)" }}>·</span>
          <span>{isLoading ? "updating…" : "live"}</span>
        </div>
      </nav>

      <Watchlist
        stocks={stocks}
        selectedTicker={selectedTicker}
        onSelect={setSelectedTicker}
        watchlist={watchlist}
        onAdd={addToWatchlist}
        onRemove={removeFromWatchlist}
      />

      <div className="cv">
        <div className="brk brk-tl"/><div className="brk brk-tr"/>
        <div className="brk brk-bl"/><div className="brk brk-br"/>

        {viewMode === "Scatter" && (
          <StockScatter stocks={stocks} selectedTicker={selectedTicker} onSelect={setSelectedTicker} />
        )}
        {viewMode === "Network" && (
          <NetworkView ref={networkRef} stocks={stocks} selectedTicker={selectedTicker} onSelect={setSelectedTicker} />
        )}
        {viewMode === "Heat" && (
          <HeatView stocks={stocks} selectedTicker={selectedTicker} onSelect={setSelectedTicker} />
        )}

        <button className="guide-btn" onClick={() => setShowGuide(v => !v)}>
          <span style={{ fontFamily: "var(--mono)", fontSize: 11 }}>?</span>
          <span>How to read this chart</span>
        </button>
        {showGuide && (
          <div className="guide-overlay">
            {viewMode === "Scatter" && <>
              <div className="go-title">Reading the Scatter Plot</div>
              <div className="go-row"><div className="go-icon" style={{ color: "#06b6d4" }}>↔</div><div><strong style={{ color: "#f1f5f9" }}>X-axis = Sentiment</strong> — how bullish or bearish recent news is (−1 = very bearish, +1 = very bullish)</div></div>
              <div className="go-row"><div className="go-icon" style={{ color: "#06b6d4" }}>↕</div><div><strong style={{ color: "#f1f5f9" }}>Y-axis = Momentum</strong> — whether the stock price is actually rising or falling over 7 days</div></div>
              <div className="go-row"><div className="go-icon" style={{ color: "#06b6d4" }}>◉</div><div><strong style={{ color: "#f1f5f9" }}>Bubble size</strong> = market cap. <strong style={{ color: "#f1f5f9" }}>Color</strong> = sector</div></div>
              <div className="go-row"><div className="go-icon" style={{ color: "#34d399" }}>↗</div><div><strong style={{ color: "#34d399" }}>Top-right (BUY ZONE)</strong> = good news + rising. <strong style={{ color: "#fb7185" }}>Bottom-left (AVOID)</strong> = bad news + falling.</div></div>
            </>}
            {viewMode === "Network" && <>
              <div className="go-title">Sentiment Network</div>
              <div className="go-row"><div className="go-icon" style={{ color: "#06b6d4" }}>◎</div><div><strong style={{ color: "#f1f5f9" }}>Node size</strong> = bull score. Larger = more bullish news coverage.</div></div>
              <div className="go-row"><div className="go-icon" style={{ color: "#34d399" }}>—</div><div><strong style={{ color: "#f1f5f9" }}>Edges</strong> = tickers mentioned together in the same article (co-occurrence).</div></div>
              <div className="go-row"><div className="go-icon" style={{ color: "#fbbf24" }}>●</div><div><strong style={{ color: "#f1f5f9" }}>Color</strong> = sentiment (green = bullish, red = bearish).</div></div>
            </>}
            {viewMode === "Heat" && <>
              <div className="go-title">Sentiment Heatmap</div>
              <div className="go-row"><div className="go-icon" style={{ color: "#34d399" }}>■</div><div><strong style={{ color: "#f1f5f9" }}>Green cells</strong> = bullish sentiment from recent articles.</div></div>
              <div className="go-row"><div className="go-icon" style={{ color: "#fb7185" }}>■</div><div><strong style={{ color: "#f1f5f9" }}>Red cells</strong> = bearish sentiment. Intensity = strength of signal.</div></div>
              <div className="go-row"><div className="go-icon" style={{ color: "#94a3b8" }}>■</div><div><strong style={{ color: "#f1f5f9" }}>Grey cells</strong> = neutral / low signal.</div></div>
            </>}
          </div>
        )}

        {viewMode === "Scatter" && (
          <div className="sc-legend">
            <div className="sl-h">Sectors</div>
            {Array.from(new Map(stocks.map(s => [s.sector, s])).entries()).map(([sector]) => {
              const COLORS: Record<string, string> = {
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
              const color = COLORS[sector] ?? "#64748b";
              return (
                <div key={sector} className="sl-i">
                  <div className="sl-d" style={{ background: color, boxShadow: `0 0 5px ${color}` }}/>
                  <span style={{ color: "var(--c2)" }}>{sector}</span>
                </div>
              );
            })}
            <div className="sl-sep"/><div className="sl-note">Size = Mkt Cap</div>
          </div>
        )}

        {viewMode === "Network" && (
          <div className="cv-ctrl">
            <button className="cv-btn" onClick={() => networkRef.current?.zoomIn()}>+</button>
            <button className="cv-btn" onClick={() => networkRef.current?.zoomOut()}>−</button>
            <button className="cv-btn" onClick={() => networkRef.current?.resetView()}>⌖</button>
          </div>
        )}
      </div>

      <StockPanel ticker={selectedTicker} overview={selectedStock} />

      <div className="sbar">
        <div className="si"><div className="si-d sd-g"/>Ingester</div>
        <div className="sep"/>
        <div className="si"><div className="si-d sd-c"/>Qdrant</div>
        <div className="sep"/>
        <div className="si"><div className="si-d sd-g"/>llama3.1:8b</div>
        <div className="sep"/>
        <div className="si"><div className="si-d sd-g"/>FinBERT</div>
        <div className="sep"/>
        <div className="si"><div className="si-d sd-g"/>ngrok</div>
        <div className="si si-ml"><div className="si-d sd-g" style={{ marginRight: 5 }}/>FinSight v0.1.0 · Local</div>
      </div>
    </div>
  );
}
