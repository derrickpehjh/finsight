import axios from "axios";
import type { StockOverview, StockDetail, Article } from "./types";

// In production (Docker/ngrok), NEXT_PUBLIC_API_URL is not set → empty string →
// relative URLs → Next.js rewrites proxy them to the backend internally.
// In local dev without Docker, set NEXT_PUBLIC_API_URL=http://localhost:8000 in .env.local.
const BASE = process.env.NEXT_PUBLIC_API_URL ?? "";

export const api = axios.create({ baseURL: BASE });

export const fetchOverview  = (timeframe?: string): Promise<StockOverview[]> =>
  api.get("/stocks/overview", { params: timeframe ? { timeframe } : {} }).then(r => r.data);
export const fetchDetail    = (t: string): Promise<StockDetail> => api.get(`/stocks/${t}`).then(r => r.data);
export const fetchNews      = (ticker?: string): Promise<Article[]> =>
  api.get("/news", { params: ticker ? { ticker, limit: 20 } : { limit: 20 } }).then(r => r.data);

// Watchlist CRUD
export const fetchWatchlist      = (): Promise<{ ticker: string; added_at: string }[]> =>
  api.get("/watchlist").then(r => r.data);
export const addToWatchlist      = (ticker: string): Promise<{ ticker: string; status: string }> =>
  api.post(`/watchlist/${ticker.toUpperCase()}`).then(r => r.data);
export const removeFromWatchlist = (ticker: string): Promise<{ ticker: string; status: string }> =>
  api.delete(`/watchlist/${ticker.toUpperCase()}`).then(r => r.data);

export async function* streamRagQuery(question: string, ticker?: string): AsyncGenerator<string> {
  const resp = await fetch(`${BASE}/rag/query`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "ngrok-skip-browser-warning": "1",
    },
    body: JSON.stringify({ q: question, ticker }),
  });

  if (!resp.ok) {
    throw new Error(`RAG request failed (${resp.status})`);
  }
  if (!resp.body) {
    throw new Error("RAG stream unavailable: empty response body");
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  const isEventStream = (resp.headers.get("content-type") ?? "").includes("text/event-stream");

  // Some proxies can buffer/transform SSE responses. Fall back to plain text
  // streaming so users still see an answer instead of a blank panel.
  if (!isEventStream) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      const chunk = decoder.decode(value, { stream: true });
      if (chunk) yield chunk;
    }
  }

  let buffer = "";

  const parseEvent = (rawEvent: string): string | null => {
    const dataLines = rawEvent
      .split(/\r?\n/)
      .filter(line => line.startsWith("data:"));

    if (!dataLines.length) return null;

    const payload = dataLines
      .map(line => {
        const value = line.slice(5);
        return value.startsWith(" ") ? value.slice(1) : value;
      })
      .join("\n");

    if (payload === "[DONE]") return "[DONE]";
    if (payload.startsWith("[ERROR]")) {
      throw new Error(payload.slice(7).trim() || "RAG streaming error");
    }
    return payload;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      buffer += decoder.decode();
    } else {
      buffer += decoder.decode(value, { stream: true });
    }

    const parts = buffer.split(/\r?\n\r?\n/);
    if (!done) {
      buffer = parts.pop() ?? "";
    } else {
      buffer = "";
    }

    for (const rawEvent of parts) {
      const payload = parseEvent(rawEvent);
      if (payload === "[DONE]") return;
      if (payload) {
        yield payload;
      }
    }

    if (done) return;
  }
}
