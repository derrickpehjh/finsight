"use client";

import { useRef, useEffect, useCallback } from "react";
import type { StockOverview } from "@/app/lib/types";

interface Props {
  stocks: StockOverview[];
  selectedTicker: string | null;
  onSelect: (ticker: string) => void;
}

const SECTOR_COLORS: Record<string, string> = {
  Technology:          "#06b6d4",
  "Communication Services": "#06b6d4",
  "Consumer Cyclical":  "#a78bfa",
  Energy:              "#34d399",
  Finance:             "#fbbf24",
  Financial:           "#fbbf24",
  Healthcare:          "#a78bfa",
  Industrials:         "#94a3b8",
  Unknown:             "#64748b",
};

const PAD = { top: 50, right: 30, bottom: 62, left: 68 };
const XMIN = -1.0, XMAX = 1.0;
const YMIN = -8.0, YMAX = 7.0;

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function bubbleRadius(cap: number): number {
  if (cap <= 0) return 13;
  return Math.max(13, Math.min(38, Math.sqrt(cap / 3e12) * 42));
}

export default function StockScatter({ stocks, selectedTicker, onSelect }: Props) {
  const canvasRef  = useRef<HTMLCanvasElement>(null);
  const frameRef   = useRef<number>(0);
  const hoveredRef = useRef<StockOverview | null>(null);
  const stocksRef  = useRef(stocks);
  const selectedRef = useRef(selectedTicker);

  stocksRef.current  = stocks;
  selectedRef.current = selectedTicker;

  // ── Coordinate transforms ────────────────────────────────────────────────
  const toX = (dataX: number, W: number) =>
    PAD.left + ((dataX - XMIN) / (XMAX - XMIN)) * (W - PAD.left - PAD.right);

  const toY = (dataY: number, H: number) =>
    H - PAD.bottom - ((dataY - YMIN) / (YMAX - YMIN)) * (H - PAD.top - PAD.bottom);

  // ── Draw ────────────────────────────────────────────────────────────────
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const W = canvas.width  / (window.devicePixelRatio || 1);
    const H = canvas.height / (window.devicePixelRatio || 1);
    const pw = W - PAD.left - PAD.right;
    const ph = H - PAD.top - PAD.bottom;
    const cx = toX(0, W);
    const cy = toY(0, H);
    const t  = Date.now() * 0.001;

    ctx.clearRect(0, 0, W * (window.devicePixelRatio || 1), H * (window.devicePixelRatio || 1));
    ctx.save();
    ctx.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1);

    // 1. Quadrant fills
    const fills: Array<[number, number, number, number, string]> = [
      [cx, PAD.top, PAD.left + pw - cx, cy - PAD.top, "rgba(52,211,153,0.045)"],      // BUY ZONE
      [PAD.left, PAD.top, cx - PAD.left, cy - PAD.top, "rgba(251,191,36,0.03)"],       // RECOVERING
      [PAD.left, cy, cx - PAD.left, PAD.top + ph - cy, "rgba(251,113,133,0.055)"],     // AVOID
      [cx, cy, PAD.left + pw - cx, PAD.top + ph - cy, "rgba(6,182,212,0.028)"],        // CORRECTION?
    ];
    fills.forEach(([x, y, w, h, color]) => {
      ctx.fillStyle = color;
      ctx.fillRect(x, y, w, h);
    });

    // 2. Grid
    ctx.strokeStyle = "rgba(255,255,255,0.07)";
    ctx.lineWidth = 1;
    ctx.strokeRect(PAD.left, PAD.top, pw, ph);

    ctx.setLineDash([5, 5]);
    ctx.strokeStyle = "rgba(255,255,255,0.1)";
    ctx.beginPath(); ctx.moveTo(cx, PAD.top); ctx.lineTo(cx, PAD.top + ph); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(PAD.left, cy); ctx.lineTo(PAD.left + pw, cy); ctx.stroke();
    ctx.setLineDash([]);

    ctx.strokeStyle = "rgba(255,255,255,0.04)";
    [-4,-2,2,4].forEach(v => {
      const y = toY(v, H);
      ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(PAD.left + pw, y); ctx.stroke();
    });
    [-0.5, 0.5].forEach(v => {
      const x = toX(v, W);
      ctx.beginPath(); ctx.moveTo(x, PAD.top); ctx.lineTo(x, PAD.top + ph); ctx.stroke();
    });

    // 3. Axis labels
    ctx.font = "500 11px 'Fira Code', monospace";
    ctx.fillStyle = "rgba(251,113,133,0.8)"; ctx.textAlign = "left";
    ctx.fillText("◀ BEARISH", PAD.left + 6, H - 10);
    ctx.fillStyle = "rgba(52,211,153,0.8)"; ctx.textAlign = "right";
    ctx.fillText("BULLISH ▶", PAD.left + pw - 6, H - 10);
    ctx.fillStyle = "rgba(148,163,184,0.5)"; ctx.textAlign = "center";
    ctx.font = "10px 'Fira Code', monospace";
    ctx.fillText("SENTIMENT SCORE", PAD.left + pw / 2, H - 10);

    ctx.fillStyle = "rgba(100,116,139,0.7)"; ctx.textAlign = "right";
    [-4,-2,0,2,4].forEach(v => {
      ctx.fillText((v > 0 ? "+" : "") + v + "%", PAD.left - 8, toY(v, H) + 4);
    });
    ctx.textAlign = "center";
    [-0.5,0,0.5].forEach(v => {
      ctx.fillText(v.toFixed(1), toX(v, W), PAD.top + ph + 14);
    });

    ctx.save();
    ctx.translate(18, PAD.top + 18); ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = "rgba(52,211,153,0.8)"; ctx.font = "500 11px 'Fira Code', monospace";
    ctx.fillText("↑ RISING", 0, 0); ctx.restore();

    ctx.save();
    ctx.translate(18, PAD.top + ph - 18); ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = "rgba(251,113,133,0.8)"; ctx.font = "500 11px 'Fira Code', monospace";
    ctx.fillText("↓ FALLING", 0, 0); ctx.restore();

    // 4. Quadrant labels
    ctx.font = "500 11px 'Fira Code', monospace";
    ctx.fillStyle = "rgba(52,211,153,0.5)";   ctx.textAlign = "right";
    ctx.fillText("● BUY ZONE",    PAD.left + pw - 10, PAD.top + 16);
    ctx.fillStyle = "rgba(251,191,36,0.45)";  ctx.textAlign = "left";
    ctx.fillText("RECOVERING ●",  PAD.left + 10, PAD.top + 16);
    ctx.fillStyle = "rgba(251,113,133,0.5)";  ctx.textAlign = "left";
    ctx.fillText("AVOID ZONE ●",  PAD.left + 10, PAD.top + ph - 8);
    ctx.fillStyle = "rgba(6,182,212,0.45)";   ctx.textAlign = "right";
    ctx.fillText("● CORRECTION?", PAD.left + pw - 10, PAD.top + ph - 8);

    // 5. Bubbles
    const currentStocks  = stocksRef.current;
    const currentSel     = selectedRef.current;
    const currentHovered = hoveredRef.current;

    currentStocks.forEach(stock => {
      const bx    = toX(stock.sentiment_score, W);
      const by    = toY(stock.momentum_7d, H);
      const r     = bubbleRadius(stock.market_cap);
      const color = SECTOR_COLORS[stock.sector] ?? "#64748b";
      const isSel = stock.ticker === currentSel;
      const isHov = currentHovered?.ticker === stock.ticker;

      // Glow
      const grd = ctx.createRadialGradient(bx, by, 0, bx, by, r * 2.5);
      grd.addColorStop(0, hexToRgba(color, isSel ? 0.4 : isHov ? 0.35 : 0.15));
      grd.addColorStop(1, hexToRgba(color, 0));
      ctx.fillStyle = grd;
      ctx.beginPath(); ctx.arc(bx, by, r * 2.5, 0, Math.PI * 2); ctx.fill();

      // Fill
      const brd = ctx.createRadialGradient(bx - r * 0.3, by - r * 0.3, 0, bx, by, r);
      brd.addColorStop(0, hexToRgba(color, isHov ? 0.75 : 0.55));
      brd.addColorStop(1, hexToRgba(color, isHov ? 0.18 : 0.08));
      ctx.fillStyle = brd;
      ctx.beginPath(); ctx.arc(bx, by, r, 0, Math.PI * 2); ctx.fill();

      // Border
      ctx.strokeStyle = hexToRgba(color, isSel ? 0.95 : isHov ? 0.9 : 0.5);
      ctx.lineWidth = isSel ? 2 : 1.5;
      ctx.beginPath(); ctx.arc(bx, by, r, 0, Math.PI * 2); ctx.stroke();

      // Specular
      ctx.fillStyle = "rgba(255,255,255,0.12)";
      ctx.beginPath(); ctx.arc(bx - r * 0.28, by - r * 0.28, r * 0.3, 0, Math.PI * 2); ctx.fill();

      // Selection pulse
      if (isSel) {
        const pulse = (Math.sin(t * 2) + 1) / 2;
        ctx.strokeStyle = hexToRgba(color, 0.25 * (1 - pulse * 0.5));
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(bx, by, r + 8 + pulse * 6, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = hexToRgba(color, 0.12 * (1 - pulse * 0.5));
        ctx.beginPath(); ctx.arc(bx, by, r + 16 + pulse * 6, 0, Math.PI * 2); ctx.stroke();
      }

      // Label
      ctx.fillStyle = "#ffffff"; ctx.textAlign = "center";
      if (r >= 22) {
        const fs = Math.max(9, Math.min(12, r * 0.32));
        ctx.font = `500 ${fs}px 'Fira Code', monospace`;
        ctx.fillText(stock.ticker, bx, by - 2);
        ctx.font = `${Math.max(8, Math.min(10, r * 0.26))}px 'Fira Code', monospace`;
        ctx.fillStyle = stock.momentum_7d >= 0 ? "rgba(52,211,153,0.9)" : "rgba(251,113,133,0.9)";
        ctx.fillText(
          (stock.momentum_7d >= 0 ? "+" : "") + stock.momentum_7d.toFixed(1) + "%",
          bx, by + 11
        );
      } else {
        // Floating label outside
        const lx = bx + r + 6;
        const ly = by + 4;
        ctx.font = "500 10px 'Fira Code', monospace";
        const tw = ctx.measureText(stock.ticker).width + 10;
        ctx.fillStyle = "rgba(0,0,0,0.55)";
        ctx.beginPath();
        (ctx as CanvasRenderingContext2D & { roundRect: Function }).roundRect(lx - 3, ly - 12, tw, 14, 3);
        ctx.fill();
        ctx.fillStyle = hexToRgba(color, 0.9);
        ctx.textAlign = "left";
        ctx.fillText(stock.ticker, lx, ly);
      }
    });

    ctx.restore();
    frameRef.current = requestAnimationFrame(draw);
  }, []);

  // ── Resize observer ──────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (!parent) return;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = parent.clientWidth;
      const h = parent.clientHeight;
      canvas.width  = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width  = w + "px";
      canvas.style.height = h + "px";
    };

    const ro = new ResizeObserver(resize);
    ro.observe(parent);
    resize();
    frameRef.current = requestAnimationFrame(draw);

    return () => {
      ro.disconnect();
      cancelAnimationFrame(frameRef.current);
    };
  }, [draw]);

  // ── Mouse events ─────────────────────────────────────────────────────────
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const W = rect.width;
    const H = rect.height;

    let found: StockOverview | null = null;
    for (const s of stocksRef.current) {
      const bx = toX(s.sentiment_score, W);
      const by = toY(s.momentum_7d, H);
      const r  = bubbleRadius(s.market_cap);
      if (Math.hypot(mx - bx, my - by) <= r + 4) { found = s; break; }
    }
    hoveredRef.current = found;
    canvas.style.cursor = found ? "pointer" : "default";
  }, []);

  const handleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const W = rect.width;
    const H = rect.height;

    for (const s of stocksRef.current) {
      const bx = toX(s.sentiment_score, W);
      const by = toY(s.momentum_7d, H);
      const r  = bubbleRadius(s.market_cap);
      if (Math.hypot(mx - bx, my - by) <= r + 4) {
        onSelect(s.ticker);
        return;
      }
    }
  }, [onSelect]);

  const handleLeave = useCallback(() => { hoveredRef.current = null; }, []);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 w-full h-full"
      onMouseMove={handleMouseMove}
      onClick={handleClick}
      onMouseLeave={handleLeave}
    />
  );
}
