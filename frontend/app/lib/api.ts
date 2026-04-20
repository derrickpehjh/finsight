import axios from "axios";
import type { StockOverview, StockDetail, Article } from "./types";

const BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export const api = axios.create({ baseURL: BASE });

export const fetchOverview  = (): Promise<StockOverview[]>  => api.get("/stocks/overview").then(r => r.data);
export const fetchDetail    = (t: string): Promise<StockDetail> => api.get(`/stocks/${t}`).then(r => r.data);
export const fetchNews      = (ticker?: string): Promise<Article[]> =>
  api.get("/news", { params: ticker ? { ticker, limit: 20 } : { limit: 20 } }).then(r => r.data);

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
        const payload = line.slice(6).trim();
        if (payload === "[DONE]" || payload.startsWith("[ERROR]")) return;
        yield payload;
      }
    }
  }
}
