import useSWR from "swr";
import { fetchOverview } from "@/app/lib/api";
import type { StockOverview } from "@/app/lib/types";

export function useStocksOverview() {
  const { data, error, isLoading } = useSWR<StockOverview[]>(
    "/stocks/overview",
    fetchOverview,
    { refreshInterval: 60_000 }   // refresh every 60 s
  );
  return { stocks: data ?? [], error, isLoading };
}
