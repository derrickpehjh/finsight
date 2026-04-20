import useSWR from "swr";
import { fetchDetail } from "@/app/lib/api";
import type { StockDetail } from "@/app/lib/types";

export function useStockDetail(ticker: string | null) {
  const { data, error, isLoading } = useSWR<StockDetail>(
    ticker ? `/stocks/${ticker}` : null,
    () => fetchDetail(ticker!),
    { refreshInterval: 30_000 }
  );
  return { detail: data, error, isLoading };
}
