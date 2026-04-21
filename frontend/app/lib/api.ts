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
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ q: question, ticker }),
  });
  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        // slice(6) removes "data: " prefix; trimEnd removes trailing CR/LF but
        // NOT leading spaces — leading spaces are word-separator tokens from Ollama
        const payload = line.slice(6).trimEnd();
        if (payload === "[DONE]" || payload.startsWith("[ERROR]")) return;
        yield payload;
      }
    }
  }
}
