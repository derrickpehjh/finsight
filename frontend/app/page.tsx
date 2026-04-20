"use client";

import { useState } from "react";
import StockScatter from "./components/scatter/StockScatter";
import StockPanel   from "./components/panel/StockPanel";
import Watchlist    from "./components/sidebar/Watchlist";
import { useStocksOverview } from "./hooks/useStocksOverview";

export default function Home() {
  const { stocks, isLoading } = useStocksOverview();
  const [selectedTicker, setSelectedTicker] = useState<string | null>(null);
  const [showGuide, setShowGuide] = useState(false);
  const [activeTime, setActiveTime] = useState("4H");

  const selectedStock = stocks.find(s => s.ticker === selectedTicker);

  return (
    <div className="app">
      <nav className="nav">
        <div className="brand">
          <div className="brand-icon">FS</div>
          <div className="brand-name">FINSIGHT</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div className="time-filter">
            {["1H","4H","1D","1W"].map(t => (
              <button key={t} className={`tf-btn ${activeTime === t ? "on" : ""}`} onClick={() => setActiveTime(t)}>{t}</button>
            ))}
          </div>
          <div className="mode-group">
            <button className="mg-btn on">⬡ Scatter</button>
            <button className="mg-btn">⬡ Network</button>
            <button className="mg-btn">⬡ Heat</button>
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

      <Watchlist stocks={stocks} selectedTicker={selectedTicker} onSelect={setSelectedTicker} />

      <div className="cv">
        <div className="brk brk-tl"/><div className="brk brk-tr"/>
        <div className="brk brk-bl"/><div className="brk brk-br"/>
        <StockScatter stocks={stocks} selectedTicker={selectedTicker} onSelect={setSelectedTicker} />
        <button className="guide-btn" onClick={() => setShowGuide(v => !v)}>
          <span style={{ fontFamily: "var(--mono)", fontSize: 11 }}>?</span>
          <span>How to read this chart</span>
        </button>
        {showGuide && (
          <div className="guide-overlay">
            <div className="go-title">Reading the Scatter Plot</div>
            <div className="go-row"><div className="go-icon" style={{ color: "#06b6d4" }}>↔</div><div><strong style={{ color: "#f1f5f9" }}>X-axis = Sentiment</strong> — how bullish or bearish recent news is (−1 = very bearish, +1 = very bullish)</div></div>
            <div className="go-row"><div className="go-icon" style={{ color: "#06b6d4" }}>↕</div><div><strong style={{ color: "#f1f5f9" }}>Y-axis = Momentum</strong> — whether the stock price is actually rising or falling over 7 days</div></div>
            <div className="go-row"><div className="go-icon" style={{ color: "#06b6d4" }}>◉</div><div><strong style={{ color: "#f1f5f9" }}>Bubble size</strong> = market cap. <strong style={{ color: "#f1f5f9" }}>Color</strong> = sector</div></div>
            <div className="go-row"><div className="go-icon" style={{ color: "#34d399" }}>↗</div><div><strong style={{ color: "#34d399" }}>Top-right (BUY ZONE)</strong> = good news + rising. <strong style={{ color: "#fb7185" }}>Bottom-left (AVOID)</strong> = bad news + falling.</div></div>
          </div>
        )}
        <div className="sc-legend">
          <div className="sl-h">Sectors</div>
          {[["Technology","#06b6d4"],["Energy","#34d399"],["Finance","#fbbf24"],["Healthcare","#a78bfa"]].map(([name, color]) => (
            <div key={name} className="sl-i"><div className="sl-d" style={{ background: color, boxShadow: `0 0 5px ${color}` }}/><span style={{ color: "var(--c2)" }}>{name}</span></div>
          ))}
          <div className="sl-sep"/><div className="sl-note">Size = Mkt Cap</div>
        </div>
        <div className="cv-ctrl">
          <button className="cv-btn">+</button>
          <button className="cv-btn">−</button>
          <button className="cv-btn">⌖</button>
        </div>
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
