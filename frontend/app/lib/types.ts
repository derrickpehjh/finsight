export interface StockOverview {
  ticker: string;
  sentiment_score: number;   // X-axis: -1 (bearish) → +1 (bullish)
  momentum_7d: number;       // Y-axis: % price change over 7 days
  market_cap: number;        // bubble size (log-scale)
  sector: string;            // bubble color
  bull_pct: number;
  bear_pct: number;
  neutral_pct: number;
  price: number;
  change_pct: number;
}

export interface SentimentPoint {
  bull_pct: number;
  bear_pct: number;
  neutral_pct: number;
  score: number;
  momentum_7d: number;
  scored_at: string;
}

export interface Article {
  id: string;
  headline: string;
  source: string;
  published_at: string | null;
  url: string;
  ticker: string[];
}

export interface StockDetail {
  ticker: string;
  latest_sentiment: Partial<SentimentPoint>;
  sentiment_history: SentimentPoint[];
  articles: Article[];
}
