"use client";

import { useRef, useState, useEffect } from "react";
import { useStockDetail } from "@/app/hooks/useStockDetail";
import { useTickerNews } from "@/app/hooks/useTickerNews";
import { streamRagQuery, streamAgentQuery } from "@/app/lib/api";
import type { StockOverview } from "@/app/lib/types";

function formatRag(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inList = false;

  for (const raw of lines) {
    const line = raw
      .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.*?)\*/g, "<em>$1</em>");

    // Section headers: ### or ## or lines ending with a colon that are short
    if (/^#{1,3}\s/.test(raw)) {
      if (inList) { out.push("</ul>"); inList = false; }
      out.push(`<p style="margin:10px 0 4px;font-weight:600;color:#e2e8f0;font-size:12px;letter-spacing:0.04em;text-transform:uppercase;">${line.replace(/^#{1,3}\s/, "")}</p>`);
      continue;
    }

    // Bullet points: - or * or • at line start
    if (/^[-*•]\s/.test(raw)) {
      if (!inList) { out.push('<ul style="margin:6px 0;padding-left:16px;list-style:none;">'); inList = true; }
      out.push(`<li style="position:relative;padding-left:12px;margin:3px 0;line-height:1.5;"><span style="position:absolute;left:0;color:#06b6d4;">›</span>${line.replace(/^[-*•]\s/, "")}</li>`);
      continue;
    }

    // Numbered list: 1. 2. etc
    if (/^\d+\.\s/.test(raw)) {
      if (!inList) { out.push('<ul style="margin:6px 0;padding-left:16px;list-style:none;">'); inList = true; }
      const num = raw.match(/^(\d+)\./)?.[1] ?? "";
      out.push(`<li style="position:relative;padding-left:20px;margin:3px 0;line-height:1.5;"><span style="position:absolute;left:0;color:#06b6d4;font-weight:600;">${num}.</span>${line.replace(/^\d+\.\s/, "")}</li>`);
      continue;
    }

    if (inList) { out.push("</ul>"); inList = false; }

    // Blank line → spacing
    if (line.trim() === "") {
      out.push('<div style="height:6px;"/>');
      continue;
    }

    out.push(`<p style="margin:0 0 5px;line-height:1.6;">${line}</p>`);
  }

  if (inList) out.push("</ul>");
  return out.join("");
}


interface Props {
  ticker: string | null;
  overview: StockOverview | undefined;
}

const TABS = ["Summary", "Signal", "Reddit", "Analyst"] as const;
type Tab = typeof TABS[number];

export default function StockPanel({ ticker, overview }: Props) {
  const { detail } = useStockDetail(ticker);
  const { articles: allArticles, isLoading: newsLoading } = useTickerNews(ticker);
  const [activeTab, setActiveTab] = useState<Tab>("Summary");

  // Summary-tab auto-analysis
  const [summaryAnswer, setSummaryAnswer] = useState("");
  const [summaryLoading, setSummaryLoading] = useState(false);
  const summaryBufferRef = useRef("");
  const summaryRafRef = useRef<number | null>(null);

  // Analyst-tab interactive RAG
  const [ragAnswer, setRagAnswer] = useState("");
  const [ragLoading, setRagLoading] = useState(false);
  const [ragError, setRagError] = useState<string | null>(null);
  const [ragQuery, setRagQuery] = useState("");
  const [agentMode, setAgentMode] = useState(false);
  const [agentSteps, setAgentSteps] = useState<string[]>([]);
  const [showRagDebug, setShowRagDebug] = useState(false);
  const [ragDebug, setRagDebug] = useState({
    chunks: 0,
    chars: 0,
    lastChunk: "",
    ended: false,
    error: "",
  });
  const ragBufferRef = useRef("");
  const ragFlushRafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!ticker) return;
    setSummaryAnswer("");
    setSummaryLoading(true);
    summaryBufferRef.current = "";

    const flush = () => {
      if (!summaryBufferRef.current) return;
      const t = summaryBufferRef.current;
      summaryBufferRef.current = "";
      setSummaryAnswer(prev => prev + t);
    };

    let cancelled = false;
    (async () => {
      try {
        for await (const chunk of streamRagQuery(
          `In 3-4 sentences, give a concise bull/bear analysis of ${ticker} based on recent news and sentiment. Mention the key catalyst and main risk.`,
          ticker
        )) {
          if (cancelled) break;
          summaryBufferRef.current += chunk;
          if (summaryRafRef.current === null) {
            summaryRafRef.current = window.requestAnimationFrame(() => {
              summaryRafRef.current = null;
              flush();
            });
          }
        }
        flush();
      } catch {
        // silent — summary is best-effort
      } finally {
        if (!cancelled) setSummaryLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      if (summaryRafRef.current !== null) {
        window.cancelAnimationFrame(summaryRafRef.current);
        summaryRafRef.current = null;
      }
      setSummaryLoading(false);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticker]);

  if (!ticker || !overview) {
    return (
      <aside className="panel-empty">
        <p>Click a bubble to select a stock</p>
      </aside>
    );
  }

  const latest = detail?.latest_sentiment ?? {};
  const bullPct    = Math.round((overview.bull_pct ?? 0) * 100);
  const bearPct    = Math.round((overview.bear_pct ?? 0) * 100);
  const neutralPct = Math.round((overview.neutral_pct ?? 0) * 100);
  const score      = overview.sentiment_score ?? 0;
  const verdict    = score > 0.3 ? "Strong Bullish" : score > 0.1 ? "Mild Bullish"
                   : score < -0.3 ? "Strong Bearish" : score < -0.1 ? "Mild Bearish"
                   : "Neutral";
  const verdictColor = score > 0.1 ? "#34d399" : score < -0.1 ? "#fb7185" : "#94a3b8";
  const scoreRing = Math.round(((score + 1) / 2) * 100);

  // Split articles by source — newsArticles shows in Summary, redditPosts in Reddit tab
  const newsArticles = allArticles.filter(a => !a.source?.startsWith("reddit"));
  const redditPosts  = allArticles.filter(a =>  a.source?.startsWith("reddit"));

  async function executeRag(q: string, useAgent = false) {
    if (!q.trim() || ragLoading) return;
    setRagLoading(true);
    setRagAnswer("");
    setRagError(null);
    setAgentSteps([]);
    setRagDebug({ chunks: 0, chars: 0, lastChunk: "", ended: false, error: "" });
    ragBufferRef.current = "";

    const flushRagBuffer = () => {
      if (!ragBufferRef.current) return;
      const pending = ragBufferRef.current;
      ragBufferRef.current = "";
      setRagAnswer(prev => prev + pending);
    };

    const scheduleFlush = () => {
      if (ragFlushRafRef.current !== null) return;
      ragFlushRafRef.current = window.requestAnimationFrame(() => {
        ragFlushRafRef.current = null;
        flushRagBuffer();
      });
    };

    try {
      const stream = useAgent
        ? streamAgentQuery(q, ticker ?? undefined)
        : streamRagQuery(q, ticker ?? undefined);
      for await (const chunk of stream) {
        if (chunk.startsWith("__STEP__")) {
          const detail = chunk.slice(chunk.indexOf("|") + 1).replace(/\n/g, "").trim();
          setAgentSteps(prev => [...prev, detail]);
          continue;
        }
        ragBufferRef.current += chunk;
        setRagDebug(prev => ({
          ...prev,
          chunks: prev.chunks + 1,
          chars: prev.chars + chunk.length,
          lastChunk: chunk.slice(0, 80),
        }));
        scheduleFlush();
      }
      flushRagBuffer();
      setRagDebug(prev => ({ ...prev, ended: true }));
    } catch (err) {
      flushRagBuffer();
      const message = err instanceof Error ? err.message : "Unable to get AI response right now.";
      setRagError(message);
      setRagDebug(prev => ({ ...prev, error: message, ended: true }));
    } finally {
      if (ragFlushRafRef.current !== null) {
        window.cancelAnimationFrame(ragFlushRafRef.current);
        ragFlushRafRef.current = null;
      }
      setRagLoading(false);
    }
  }

  function runRag() {
    executeRag(ragQuery, agentMode);
  }

  const capStr = overview.market_cap >= 1e12
    ? `$${(overview.market_cap / 1e12).toFixed(1)}T`
    : `$${(overview.market_cap / 1e9).toFixed(0)}B`;

  return (
    <aside className="panel">
      {/* Header */}
      <div className="ph">
        <div className="ph-row1">
          <div className="ph-sym">{ticker}</div>
          <div className="ph-price-block">
            <div className="ph-price">${overview.price.toFixed(2)}</div>
            <div className={`ph-chg ${overview.change_pct >= 0 ? "up" : "dn"}`}>
              {overview.change_pct >= 0 ? "▲" : "▼"} {Math.abs(overview.change_pct).toFixed(2)}%
            </div>
          </div>
        </div>
        <div className="ph-meta">{overview.sector} · {ticker}</div>

        {/* Score ring + verdict */}
        <div className="ph-score-row">
          <div className="score-ring-wrap">
            <svg width="48" height="48" viewBox="0 0 48 48" style={{ transform: "rotate(-90deg)" }}>
              <circle cx="24" cy="24" r="18" fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="2.5"/>
              <circle cx="24" cy="24" r="18" fill="none" stroke={verdictColor} strokeWidth="2.5"
                strokeDasharray="113.1"
                strokeDashoffset={113.1 * (1 - scoreRing / 100)}
                strokeLinecap="round"/>
            </svg>
            <div className="score-ring-num" style={{ color: verdictColor }}>{scoreRing}</div>
          </div>
          <div className="score-text">
            <div className="sc-verdict" style={{ color: verdictColor }}>{verdict}</div>
            <div className="sc-sub">{allArticles.length} sources · {capStr}</div>
          </div>
        </div>

        {/* Sentiment bar */}
        <div className="sent-wrap">
          <div className="sent-hdr"><span>Sentiment Split</span><span>{allArticles.length} sources</span></div>
          <div className="sent-bar">
            <div style={{ width: `${bullPct}%`, background: "linear-gradient(90deg,#34d399,rgba(52,211,153,0.6))" }}/>
            <div style={{ width: `${neutralPct}%`, background: "linear-gradient(90deg,#a78bfa,rgba(167,139,250,0.6))" }}/>
            <div style={{ width: `${bearPct}%`, background: "linear-gradient(90deg,#fb7185,rgba(251,113,133,0.6))" }}/>
          </div>
          <div className="sent-vals">
            <span style={{ color: "#34d399" }}>{bullPct}% bull</span>
            <span style={{ color: "#a78bfa" }}>{neutralPct}%</span>
            <span style={{ color: "#fb7185" }}>{bearPct}% bear</span>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="tabs">
        {TABS.map(t => (
          <button key={t} className={`tab ${activeTab === t ? "on" : ""}`} onClick={() => setActiveTab(t)}>
            {t}
          </button>
        ))}
      </div>

      {/* Body */}
      <div className="pbody">
        <div className="chips">
          <span className="chip ch-g">{verdict.toUpperCase()}</span>
          <span className="chip ch-c">mom {overview.momentum_7d >= 0 ? "+" : ""}{overview.momentum_7d.toFixed(1)}%</span>
          <span className="chip ch-a">{capStr} CAP</span>
          <span className="chip ch-x">{overview.sector}</span>
        </div>

        {activeTab === "Summary" && (
          <>
            <div className="slbl">Recent News</div>
            {newsLoading && <div style={{ color: "var(--c3)", fontSize: 12 }}>Loading…</div>}
            {!newsLoading && allArticles.length === 0 && (
              <div style={{ color: "var(--c4)", fontSize: 11, fontFamily: "var(--mono)", padding: "6px 0" }}>
                No articles yet — ingester will populate shortly.
              </div>
            )}
            {/* Show non-reddit articles first; fall back to reddit posts when none exist */}
            {(newsArticles.length > 0 ? newsArticles : redditPosts).slice(0, 5).map(a => (
              <div key={a.id} className="ni">
                <div className={`ni-dot ${
                  ["reuters","bloomberg","yahoo_finance","benzinga","investopedia"].some(s => (a.source ?? "").includes(s))
                    ? "d-bull" : "d-neut"
                }`}/>
                <div className="ni-body">
                  <a href={a.url} target="_blank" rel="noreferrer" className="ni-txt" style={{ textDecoration: "none" }}>
                    {a.headline}
                  </a>
                  <div className="ni-foot">
                    <span className="ni-src">{a.source}</span>
                    <span className="ni-time">{a.published_at ? a.published_at.slice(0, 10) : ""}</span>
                  </div>
                </div>
              </div>
            ))}

            {/* AI snapshot */}
            <div className="slbl" style={{ marginTop: 12 }}>AI Snapshot</div>
            <div className="ai-card">
              <div className="ai-beam" style={summaryLoading ? { animation: "pulse 1.5s ease-in-out infinite" } : undefined}/>
              <div className="ai-hdr">
                <div className="ai-tag">◈ Quick Analysis</div>
                <div className="ai-model" style={{ color: summaryLoading ? "#06b6d4" : undefined }}>
                  {summaryLoading ? "analysing…" : "llama3.1:8b"}
                </div>
              </div>
              {summaryLoading && !summaryAnswer && (
                <div style={{ display: "flex", gap: 5, padding: "6px 0" }}>
                  {[0, 0.3, 0.6].map((delay, i) => (
                    <div key={i} style={{
                      width: 6, height: 6, borderRadius: "50%",
                      background: "#06b6d4",
                      animation: `pulse 1s ease-in-out ${delay}s infinite`,
                      opacity: 0.8,
                    }}/>
                  ))}
                </div>
              )}
              {summaryAnswer && (
                <div className="ai-txt" style={{ fontSize: 12, lineHeight: 1.6 }} dangerouslySetInnerHTML={{
                  __html: formatRag(summaryAnswer)
                    + (summaryLoading ? '<span style="display:inline-block;width:2px;height:1em;background:#06b6d4;margin-left:2px;vertical-align:middle;animation:pulse 0.8s ease-in-out infinite;">&#8203;</span>' : "")
                }}/>
              )}
            </div>
          </>
        )}

        {activeTab === "Reddit" && (
          <>
            <div className="slbl">Reddit Posts</div>
            {redditPosts.slice(0, 6).map(a => (
              <div key={a.id} className="ni">
                <div className="ni-dot d-neut"/>
                <div className="ni-body">
                  <a href={a.url} target="_blank" rel="noreferrer" className="ni-txt" style={{ textDecoration: "none" }}>
                    {a.headline}
                  </a>
                  <div className="ni-foot">
                    <span className="ni-src">{a.source}</span>
                  </div>
                </div>
              </div>
            ))}
            {redditPosts.length === 0 && <div style={{ color: "var(--c3)", fontSize: 12 }}>No Reddit posts yet</div>}
          </>
        )}

        {activeTab === "Analyst" && (
          <>
            <div className="slbl">Ask the AI</div>
            <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
              <input
                className="search-input"
                style={{ flex: 1 }}
                placeholder={`Why is ${ticker} ${overview.change_pct >= 0 ? "up" : "down"} today?`}
                value={ragQuery}
                onChange={e => setRagQuery(e.target.value)}
                onKeyDown={e => e.key === "Enter" && runRag()}
              />
              <button
                onClick={runRag}
                disabled={ragLoading}
                style={{
                  background: ragLoading ? "rgba(6,182,212,0.06)" : "rgba(6,182,212,0.12)",
                  border: "1px solid rgba(6,182,212,0.3)",
                  borderRadius: 6, padding: "0 12px", color: "#06b6d4",
                  fontFamily: "var(--mono)", fontSize: 11,
                  cursor: ragLoading ? "not-allowed" : "pointer",
                  transition: "background 0.2s",
                  minWidth: 44,
                }}
              >
                {ragLoading ? "⏳" : "Ask"}
              </button>
              <button
                onClick={() => setAgentMode(v => !v)}
                style={{
                  padding: "0 10px",
                  fontSize: 11,
                  borderRadius: 6,
                  border: `1px solid ${agentMode ? "#06b6d4" : "rgba(255,255,255,0.15)"}`,
                  background: agentMode ? "rgba(6,182,212,0.15)" : "transparent",
                  color: agentMode ? "#06b6d4" : "rgba(255,255,255,0.5)",
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                  fontFamily: "var(--mono)",
                }}
              >
                {agentMode ? "⚡ Agentic" : "◇ Standard"}
              </button>
              <button
                onClick={() => setShowRagDebug(v => !v)}
                style={{
                  background: "rgba(148,163,184,0.12)",
                  border: "1px solid rgba(148,163,184,0.35)",
                  borderRadius: 6,
                  padding: "0 10px",
                  color: "#94a3b8",
                  fontFamily: "var(--mono)",
                  fontSize: 11,
                  cursor: "pointer",
                }}
              >
                {showRagDebug ? "Hide dbg" : "Show dbg"}
              </button>
            </div>

            {/* Agent step chips */}
            {agentSteps.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
                {agentSteps.map((step, i) => (
                  <span key={i} style={{
                    fontSize: 10,
                    padding: "2px 8px",
                    borderRadius: 999,
                    background: "rgba(6,182,212,0.1)",
                    border: "1px solid rgba(6,182,212,0.3)",
                    color: "#67e8f9",
                    fontFamily: "var(--mono)",
                  }}>
                    {step}
                  </span>
                ))}
              </div>
            )}

            {/* Thinking indicator — shows between click and first token */}
            {ragLoading && !ragAnswer && (
              <div className="ai-card" style={{ opacity: 0.75 }}>
                <div className="ai-beam" style={{ animation: "pulse 1.5s ease-in-out infinite" }}/>
                <div className="ai-hdr">
                  <div className="ai-tag">◈ RAG Analysis</div>
                  <div className="ai-model" style={{ color: "#06b6d4", animation: "pulse 1.5s ease-in-out infinite" }}>
                    thinking…
                  </div>
                </div>
                <div style={{ display: "flex", gap: 5, padding: "6px 0" }}>
                  {[0, 0.3, 0.6].map((delay, i) => (
                    <div key={i} style={{
                      width: 6, height: 6, borderRadius: "50%",
                      background: "#06b6d4",
                      animation: `pulse 1s ease-in-out ${delay}s infinite`,
                      opacity: 0.8,
                    }}/>
                  ))}
                </div>
              </div>
            )}

            {/* Streaming answer */}
            {ragAnswer && (
              <div className="ai-card">
                <div className="ai-beam"/>
                <div className="ai-hdr">
                  <div className="ai-tag">◈ RAG Analysis</div>
                  <div className="ai-model" style={{ color: ragLoading ? "#06b6d4" : undefined }}>
                    {ragLoading ? "streaming…" : "llama3.1:8b"}
                  </div>
                </div>
                <div className="ai-txt" style={{ fontSize: 12, lineHeight: 1.6 }} dangerouslySetInnerHTML={{
                  __html: formatRag(ragAnswer)
                    + (ragLoading ? '<span style="display:inline-block;width:2px;height:1em;background:#06b6d4;margin-left:2px;vertical-align:middle;animation:pulse 0.8s ease-in-out infinite;">&#8203;</span>' : "")
                }}/>
              </div>
            )}

            {ragError && !ragAnswer && (
              <div className="ai-card" style={{ borderColor: "rgba(251,113,133,0.45)" }}>
                <div className="ai-hdr">
                  <div className="ai-tag">◈ RAG Analysis</div>
                  <div className="ai-model" style={{ color: "#fb7185" }}>error</div>
                </div>
                <div className="ai-txt" style={{ color: "#fecdd3" }}>{ragError}</div>
              </div>
            )}

            {showRagDebug && (
              <div className="ai-card" style={{ borderColor: "rgba(148,163,184,0.35)" }}>
                <div className="ai-hdr">
                  <div className="ai-tag">◈ Stream Debug</div>
                  <div className="ai-model" style={{ color: "#94a3b8" }}>
                    {ragLoading ? "running" : ragDebug.ended ? "ended" : "idle"}
                  </div>
                </div>
                <div className="ai-txt" style={{ fontFamily: "var(--mono)", fontSize: 11, whiteSpace: "pre-wrap" }}>
                  {`chunks=${ragDebug.chunks}\nchars=${ragDebug.chars}\nlastChunk=${ragDebug.lastChunk || "<none>"}\nerror=${ragDebug.error || "<none>"}`}
                </div>
              </div>
            )}
          </>
        )}

        {activeTab === "Signal" && (
          <>
            <div className="slbl">Signal Summary</div>
            <div className="bento">
              <div className="bcard">
                <div className="bc-lbl">Bull Score</div>
                <div className="bc-val" style={{ color: "#34d399" }}>{bullPct}</div>
                <div className="bc-sub">% of sources</div>
              </div>
              <div className="bcard">
                <div className="bc-lbl">Bear Score</div>
                <div className="bc-val" style={{ color: "#fb7185" }}>{bearPct}</div>
                <div className="bc-sub">% of sources</div>
              </div>
              <div className="bcard" style={{ gridColumn: "1 / -1" }}>
                <div className="bc-lbl">7-Day Momentum</div>
                <div className="bc-val" style={{ color: overview.momentum_7d >= 0 ? "#34d399" : "#fb7185" }}>
                  {overview.momentum_7d >= 0 ? "+" : ""}{overview.momentum_7d.toFixed(2)}%
                </div>
              </div>
              <div className="bcard" style={{ gridColumn: "1 / -1" }}>
                <div className="bc-lbl">Window Data Points</div>
                <div className="bc-val" style={{
                  color: (overview.window_count ?? 0) > 1 ? "#06b6d4" : "#94a3b8",
                  fontSize: 22,
                }}>
                  {overview.window_count ?? 0}
                </div>
                <div className="bc-sub" style={{
                  color: (overview.window_count ?? 0) === 0 ? "#fb7185" : "inherit",
                }}>
                  {(overview.window_count ?? 0) === 0
                    ? "no data in window — showing latest"
                    : `scored rows in selected timeframe`}
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
