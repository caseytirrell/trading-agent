export type TradeSide = "buy" | "sell";

export type TradeRequest = {
  symbol: string;
  qty: number;
  side: TradeSide;
};

export type RiskCheckResult = {
  approved: boolean;
  reasons: string[];
};

const TRADING_ENABLED = true;

const ALLOWED_SYMBOLS = ["SPY", "QQQ", "AAPL", "MSFT", "NVDA"];

const MAX_QTY_PER_TRADE = 1;

export function runRiskCheck(trade: TradeRequest): RiskCheckResult {
  const reasons: string[] = [];

  if (!TRADING_ENABLED) {
    reasons.push("Trading is disabled.");
  }

  if (!ALLOWED_SYMBOLS.includes(trade.symbol)) {
    reasons.push(`${trade.symbol} is not an allowed symbol.`);
  }

  if (trade.qty <= 0) {
    reasons.push("Quantity must be greater than 0.");
  }

  if (trade.qty > MAX_QTY_PER_TRADE) {
    reasons.push(`Quantity cannot be greater than ${MAX_QTY_PER_TRADE}.`);
  }

  if (trade.side !== "buy" && trade.side !== "sell") {
    reasons.push("Trade side must be buy or sell.");
  }

  return {
    approved: reasons.length === 0,
    reasons,
  };
}