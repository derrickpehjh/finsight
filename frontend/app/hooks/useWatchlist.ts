import { useState, useEffect, useCallback } from "react";
import { useSWRConfig } from "swr";
import { fetchWatchlist, addToWatchlist, removeFromWatchlist } from "@/app/lib/api";

export function useWatchlist() {
  const [watchlist, setWatchlist] = useState<Set<string>>(new Set());
  const [loading, setLoading]     = useState(false);
  const { mutate } = useSWRConfig();

  const reload = useCallback(async () => {
    try {
      const rows = await fetchWatchlist();
      setWatchlist(new Set(rows.map(r => r.ticker)));
    } catch {
      // Silently ignore — backend may not have the table yet in dev
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  /** Bust all /stocks/overview SWR cache keys so the new ticker appears immediately. */
  const invalidateOverview = useCallback(() => {
    ["latest", "1H", "4H", "1D", "1W"].forEach(tf =>
      mutate(`/stocks/overview?tf=${tf}`)
    );
  }, [mutate]);

  const add = useCallback(async (ticker: string) => {
    const t = ticker.toUpperCase().trim();
    if (!t) return;
    setLoading(true);
    try {
      await addToWatchlist(t);
      setWatchlist(prev => new Set([...prev, t]));
      // Refresh the scatter plot so the new ticker shows up right away
      invalidateOverview();
    } catch (e) {
      console.error("watchlist add failed:", e);
    } finally {
      setLoading(false);
    }
  }, [invalidateOverview]);

  const remove = useCallback(async (ticker: string) => {
    const t = ticker.toUpperCase().trim();
    setLoading(true);
    try {
      await removeFromWatchlist(t);
      setWatchlist(prev => { const next = new Set(prev); next.delete(t); return next; });
      invalidateOverview();
    } catch (e) {
      console.error("watchlist remove failed:", e);
    } finally {
      setLoading(false);
    }
  }, [invalidateOverview]);

  return { watchlist, loading, add, remove };
}
