import useSWR from "swr";
import { fetchNews } from "@/app/lib/api";
import type { Article } from "@/app/lib/types";

export function useTickerNews(ticker: string | null) {
  const { data, error, isLoading } = useSWR<Article[]>(
    ticker ? `/news?ticker=${ticker}` : null,
    () => fetchNews(ticker!),
    { refreshInterval: 60_000 }
  );
  return { articles: data ?? [], error, isLoading };
}
