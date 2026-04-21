"use client";

import { useRef, useEffect, useCallback, forwardRef, useImperativeHandle } from "react";
import type { StockOverview } from "@/app/lib/types";

export interface NetworkViewHandle {
  zoomIn: () => void;
  zoomOut: () => void;
  resetView: () => void;
}

interface Props {
  stocks: StockOverview[];
  selectedTicker: string | null;
  onSelect: (ticker: string) => void;
}

interface Node {
  ticker: string;
  x: number; y: number;
  vx: number; vy: number;
  r: number;
  sentimentColor: string;
  sectorColor: string;
  score: number;
  bull: number;
  sector: string;
  momentum: number;
}

interface Edge { i: number; j: number; weight: number; }
interface Transform { scale: number; tx: number; ty: number; }

// ── Sector config ──────────────────────────────────────────────────────────────
// Each sector gets a fixed centroid (fraction of W, H) and a color ring
const SECTOR_MAP: Record<string, { cx: number; cy: number; color: string }> = {
  "Technology":              { cx: 0.62, cy: 0.28, color: "#06b6d4" },
  "Communication Services":  { cx: 0.75, cy: 0.38, color: "#06b6d4" },
  "Consumer Cyclical":       { cx: 0.38, cy: 0.70, color: "#a78bfa" },
  "Financial Services":      { cx: 0.22, cy: 0.58, color: "#fbbf24" },
  "Financial":               { cx: 0.22, cy: 0.58, color: "#fbbf24" },
  "Finance":                 { cx: 0.22, cy: 0.58, color: "#fbbf24" },
  "Energy":                  { cx: 0.18, cy: 0.35, color: "#34d399" },
  "Healthcare":              { cx: 0.55, cy: 0.72, color: "#a78bfa" },
  "Industrials":             { cx: 0.70, cy: 0.65, color: "#94a3b8" },
  "default":                 { cx: 0.50, cy: 0.50, color: "#64748b" },
};

// ── Physics ────────────────────────────────────────────────────────────────────
const TOP_K        = 3;     // max edges per node
const REPEL_K      = 2200;
const SPRING_K     = 0.04;  // spring stiffness for top-K edges
const SECTOR_K     = 0.012; // gravity toward sector centroid
const REST_LEN     = 100;
const DAMPING      = 0.78;

// ── Helpers ────────────────────────────────────────────────────────────────────
function sentimentColor(score: number): string {
  if (score > 0.15)  return "#34d399";
  if (score < -0.15) return "#fb7185";
  return "#94a3b8";
}

function sectorInfo(sector: string) {
  return SECTOR_MAP[sector] ?? SECTOR_MAP["default"];
}

/** Combined edge weight: sentiment + momentum similarity, both 0-1 */
function edgeWeight(a: Node, b: Node, maxMom: number): number {
  const sentSim = 1 - Math.abs(a.score - b.score) / 2;
  const momSim  = maxMom > 0 ? 1 - Math.abs(a.momentum - b.momentum) / (maxMom * 2) : 1;
  return 0.6 * sentSim + 0.4 * momSim;
}

/** Build top-K edges per node (K nearest neighbours by combined weight) */
function buildTopKEdges(nodes: Node[]): Edge[] {
  if (nodes.length < 2) return [];
  const maxMom = Math.max(...nodes.map(n => Math.abs(n.momentum)), 1);
  const edgeSet = new Map<string, Edge>();

  for (let i = 0; i < nodes.length; i++) {
    // Compute weights to all other nodes, take top K
    const candidates: { j: number; w: number }[] = [];
    for (let j = 0; j < nodes.length; j++) {
      if (j === i) continue;
      candidates.push({ j, w: edgeWeight(nodes[i], nodes[j], maxMom) });
    }
    candidates.sort((a, b) => b.w - a.w);
    candidates.slice(0, TOP_K).forEach(({ j, w }) => {
      const key = i < j ? `${i}-${j}` : `${j}-${i}`;
      if (!edgeSet.has(key)) edgeSet.set(key, { i: Math.min(i, j), j: Math.max(i, j), weight: w });
    });
  }
  return Array.from(edgeSet.values());
}

const NetworkView = forwardRef<NetworkViewHandle, Props>(function NetworkView(
  { stocks, selectedTicker, onSelect },
  ref,
) {
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const nodesRef     = useRef<Node[]>([]);
  const edgesRef     = useRef<Edge[]>([]);
  const frameRef     = useRef<number>(0);
  const stocksRef    = useRef(stocks);
  const selectedRef  = useRef(selectedTicker);
  const initRef      = useRef(false);
  const transformRef = useRef<Transform>({ scale: 1, tx: 0, ty: 0 });
  const dragRef      = useRef({ active: false, lastX: 0, lastY: 0 });

  stocksRef.current  = stocks;
  selectedRef.current = selectedTicker;

  // ── Zoom / pan ───────────────────────────────────────────────────────────────
  const applyZoom = useCallback((factor: number, cx?: number, cy?: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const W = canvas.offsetWidth  || 800;
    const H = canvas.offsetHeight || 600;
    const ox = cx ?? W / 2, oy = cy ?? H / 2;
    const t = transformRef.current;
    const newScale = Math.max(0.25, Math.min(6, t.scale * factor));
    t.tx = ox - (ox - t.tx) * (newScale / t.scale);
    t.ty = oy - (oy - t.ty) * (newScale / t.scale);
    t.scale = newScale;
  }, []);

  const resetView = useCallback(() => {
    transformRef.current = { scale: 1, tx: 0, ty: 0 };
  }, []);

  // Expose zoom controls to parent via ref
  useImperativeHandle(ref, () => ({
    zoomIn:    () => applyZoom(1.25),
    zoomOut:   () => applyZoom(0.8),
    resetView,
  }), [applyZoom, resetView]);

  // ── Build nodes ──────────────────────────────────────────────────────────────
  const buildNodes = useCallback((W: number, H: number) => {
    const s = stocksRef.current;
    if (!s.length) return;

    nodesRef.current = s.map(stock => {
      const si   = sectorInfo(stock.sector ?? "");
      // Spread nodes around their sector centroid with small jitter
      const tickerHash = stock.ticker.split("").reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 0);
      const jAngle  = (tickerHash % 1000) / 1000 * Math.PI * 2;
      const jRadius = ((tickerHash >> 8) % 100) / 100 * 60 + 20;
      return {
        ticker:        stock.ticker,
        x:             si.cx * W + Math.cos(jAngle) * jRadius,
        y:             si.cy * H + Math.sin(jAngle) * jRadius,
        vx: 0, vy: 0,
        r:             Math.max(18, Math.min(34, 18 + stock.bull_pct * 28)),
        sentimentColor: sentimentColor(stock.sentiment_score),
        sectorColor:   si.color,
        score:         stock.sentiment_score,
        bull:          stock.bull_pct,
        sector:        stock.sector ?? "",
        momentum:      stock.momentum_7d ?? 0,
      };
    });

    edgesRef.current = buildTopKEdges(nodesRef.current);
  }, []);

  // ── Physics ──────────────────────────────────────────────────────────────────
  const simulate = useCallback(() => {
    const nodes  = nodesRef.current;
    const edges  = edgesRef.current;
    const canvas = canvasRef.current;
    if (!canvas || !nodes.length) return;
    const W = canvas.offsetWidth  || 800;
    const H = canvas.offsetHeight || 600;

    const fx = new Float64Array(nodes.length);
    const fy = new Float64Array(nodes.length);

    // Sector centroid gravity — keeps clusters separated
    for (let k = 0; k < nodes.length; k++) {
      const n  = nodes[k];
      const si = sectorInfo(n.sector);
      fx[k] += (si.cx * W - n.x) * SECTOR_K;
      fy[k] += (si.cy * H - n.y) * SECTOR_K;
    }

    // Node–node repulsion
    for (let k = 0; k < nodes.length; k++) {
      for (let l = k + 1; l < nodes.length; l++) {
        const dx = nodes[k].x - nodes[l].x;
        const dy = nodes[k].y - nodes[l].y;
        const d2 = dx * dx + dy * dy || 1;
        const d  = Math.sqrt(d2);
        if (d < 400) {
          const f   = REPEL_K / d2;
          const fxv = (dx / d) * f, fyv = (dy / d) * f;
          fx[k] += fxv; fy[k] += fyv;
          fx[l] -= fxv; fy[l] -= fyv;
        }
      }
    }

    // Spring attraction along top-K edges
    for (const e of edges) {
      const a  = nodes[e.i], b = nodes[e.j];
      const dx = b.x - a.x, dy = b.y - a.y;
      const d  = Math.hypot(dx, dy) || 1;
      const force = (d - REST_LEN) * SPRING_K * e.weight;
      const fxv = (dx / d) * force, fyv = (dy / d) * force;
      fx[e.i] += fxv; fy[e.i] += fyv;
      fx[e.j] -= fxv; fy[e.j] -= fyv;
    }

    for (let k = 0; k < nodes.length; k++) {
      const n = nodes[k];
      n.vx = (n.vx + fx[k]) * DAMPING;
      n.vy = (n.vy + fy[k]) * DAMPING;
      n.x  = Math.max(n.r + 8, Math.min(W - n.r - 8, n.x + n.vx));
      n.y  = Math.max(n.r + 8, Math.min(H - n.r - 8, n.y + n.vy));
    }
  }, []);

  // ── Draw ─────────────────────────────────────────────────────────────────────
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const W   = canvas.width / dpr, H = canvas.height / dpr;
    const { scale, tx, ty } = transformRef.current;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.scale(dpr, dpr);

    // Sector labels (background, fixed — not affected by zoom)
    const rendered = new Set<string>();
    for (const n of nodesRef.current) {
      if (rendered.has(n.sector)) continue;
      rendered.add(n.sector);
      const si = sectorInfo(n.sector);
      ctx.font = "500 10px 'Fira Code', monospace";
      ctx.fillStyle = si.color + "55";
      ctx.textAlign = "center";
      ctx.fillText(n.sector.toUpperCase(), si.cx * W, si.cy * H - 60);
    }

    ctx.save();
    ctx.translate(tx, ty);
    ctx.scale(scale, scale);

    const nodes = nodesRef.current;
    const edges = edgesRef.current;

    // Edges — thicker/brighter for stronger weight
    for (const e of edges) {
      const a = nodes[e.i], b = nodes[e.j];
      const combined = a.score + b.score;
      const rgb = combined > 0.15 ? "52,211,153" : combined < -0.15 ? "251,113,133" : "148,163,184";
      const alpha = 0.12 + e.weight * 0.55;
      const lw    = (0.5 + e.weight * 2.0) / scale;
      ctx.strokeStyle = `rgba(${rgb},${alpha.toFixed(2)})`;
      ctx.lineWidth   = lw;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }

    // Nodes
    for (const n of nodes) {
      const isSel = n.ticker === selectedRef.current;
      const hex = n.sentimentColor;
      const r   = parseInt(hex.slice(1, 3), 16);
      const g   = parseInt(hex.slice(3, 5), 16);
      const b   = parseInt(hex.slice(5, 7), 16);
      const rgba = (a: number) => `rgba(${r},${g},${b},${a})`;

      // Outer glow
      const grd = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, n.r * 2.2);
      grd.addColorStop(0, rgba(isSel ? 0.35 : 0.10));
      grd.addColorStop(1, rgba(0));
      ctx.fillStyle = grd;
      ctx.beginPath(); ctx.arc(n.x, n.y, n.r * 2.2, 0, Math.PI * 2); ctx.fill();

      // Fill
      const frd = ctx.createRadialGradient(n.x - n.r * 0.3, n.y - n.r * 0.3, 0, n.x, n.y, n.r);
      frd.addColorStop(0, rgba(0.55)); frd.addColorStop(1, rgba(0.10));
      ctx.fillStyle = frd;
      ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2); ctx.fill();

      // Sector ring (thin, colored by sector)
      ctx.strokeStyle = n.sectorColor + "99";
      ctx.lineWidth   = (isSel ? 2.5 : 1.5) / scale;
      ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2); ctx.stroke();

      // Selection ring
      if (isSel) {
        const pulse = (Math.sin(Date.now() * 0.002) + 1) / 2;
        ctx.strokeStyle = rgba(0.3 * (1 - pulse * 0.5));
        ctx.lineWidth   = 1 / scale;
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 8 + pulse * 4, 0, Math.PI * 2); ctx.stroke();
      }

      // Ticker label
      ctx.fillStyle = "#ffffff";
      ctx.font      = `500 ${Math.max(9, Math.min(12, n.r * 0.45))}px 'Fira Code', monospace`;
      ctx.textAlign = "center";
      ctx.fillText(n.ticker, n.x, n.y + 4);

      // Sentiment score below
      const scoreSize = 9 / scale;
      if (scoreSize >= 6) {
        ctx.font      = `${scoreSize}px 'Fira Code', monospace`;
        ctx.fillStyle = n.score >= 0 ? "rgba(52,211,153,0.85)" : "rgba(251,113,133,0.85)";
        ctx.fillText((n.score >= 0 ? "+" : "") + n.score.toFixed(2), n.x, n.y + n.r + 14);
      }
    }

    ctx.restore(); // pop zoom/pan

    // Legend (fixed)
    ctx.font      = "500 11px 'Fira Code', monospace";
    ctx.fillStyle = "rgba(148,163,184,0.55)";
    ctx.textAlign = "left";
    ctx.fillText(
      `SENTIMENT NETWORK  ·  node size = bull %  ·  top-${TOP_K} sentiment+momentum edges per stock  ·  ring = sector`,
      16, H - 14,
    );

    ctx.restore(); // pop dpr

    simulate();
    frameRef.current = requestAnimationFrame(draw);
  }, [simulate]);

  // ── Canvas lifecycle ──────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const w   = canvas.offsetWidth  || 800;
      const h   = canvas.offsetHeight || 600;
      canvas.width  = w * dpr;
      canvas.height = h * dpr;
      if (!initRef.current) { buildNodes(w, h); initRef.current = true; }
    };

    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();
    frameRef.current = requestAnimationFrame(draw);
    return () => { ro.disconnect(); cancelAnimationFrame(frameRef.current); };
  }, [draw, buildNodes]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const W = canvas.offsetWidth  || 800;
    const H = canvas.offsetHeight || 600;
    if (W > 0 && H > 0) { buildNodes(W, H); initRef.current = true; }
  }, [stocks, buildNodes]);

  // ── Interaction ───────────────────────────────────────────────────────────────
  const handleWheel = useCallback((e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const rect = canvasRef.current!.getBoundingClientRect();
    applyZoom(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - rect.left, e.clientY - rect.top);
  }, [applyZoom]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    dragRef.current = { active: true, lastX: e.clientX, lastY: e.clientY };
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragRef.current.active) return;
    transformRef.current.tx += e.clientX - dragRef.current.lastX;
    transformRef.current.ty += e.clientY - dragRef.current.lastY;
    dragRef.current.lastX = e.clientX;
    dragRef.current.lastY = e.clientY;
  }, []);

  const handleMouseUp = useCallback(() => { dragRef.current.active = false; }, []);

  const handleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (Math.abs(e.movementX) > 3 || Math.abs(e.movementY) > 3) return;
    const rect = canvasRef.current!.getBoundingClientRect();
    const { scale, tx, ty } = transformRef.current;
    const mx = (e.clientX - rect.left - tx) / scale;
    const my = (e.clientY - rect.top  - ty) / scale;
    for (const n of nodesRef.current) {
      if (Math.hypot(mx - n.x, my - n.y) <= n.r + 4) { onSelect(n.ticker); return; }
    }
  }, [onSelect]);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 w-full h-full"
      onClick={handleClick}
      onWheel={handleWheel}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      style={{ cursor: "grab" }}
    />
  );
});

export default NetworkView;
