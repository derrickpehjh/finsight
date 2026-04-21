import useSWR from "swr";
import { fetchOverview } from "@/app/lib/api";
import type { StockOverview } from "@/app/lib/types";

export function useStocksOverview(timeframe?: string) {
  const { data, error, isLoading } = useSWR<StockOverview[]>(
    `/stocks/overview?tf=${timeframe ?? "latest"}`,
    () => fetchOverview(timeframe),
    { refreshInterval: 60_000 }   // refresh every 60 s
  );
  return { stocks: data ?? [], error, isLoading };
}
