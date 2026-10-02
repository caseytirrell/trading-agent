import type {
  AlpacaAccountSummary,
  AlpacaClock,
  AlpacaOrder,
  AlpacaPosition,
} from "@/lib/alpaca";
import { isApprovedSymbol } from "@/lib/trading-universe";

export type TradeSide = "buy" | "sell";

export type TradeRequest = {
  symbol: string;
  qty: number;
  side: TradeSide;
};

export type RiskCheckContext = {
  trade: TradeRequest;
  account: AlpacaAccountSummary;
  positions: AlpacaPosition[];
  recentOrders: AlpacaOrder[];
  marketClock: AlpacaClock;
  /** Present only when the trade came from an AI recommendation. */
  recommendation?: {
    action: string;
    confidence: number;
  };
};

export type RiskCheckResult = {
  approved: boolean;
  reasons: string[];
};

// Fail-closed kill switch: trading is allowed only when the server-side value
// is explicitly set to "true". Missing, malformed, or false values block all
// agent and manual order routes.
function isTradingEnabled(): boolean {
  return process.env.TRADING_ENABLED === "true";
}

const MAX_QTY_PER_TRADE = 1;
const MIN_AI_CONFIDENCE = 0.7;
const MAX_TRADES_PER_DAY = 3;
const DAILY_LOSS_LIMIT_PCT = 0.02;

// Alpaca order statuses that mean the order is still working (not terminal).
// Exported so the market-analysis layer uses the same definition of "open".
export const OPEN_ORDER_STATUSES = [
  "new",
  "accepted",
  "pending_new",
  "accepted_for_bidding",
  "partially_filled",
  "held",
  "pending_replace",
  "pending_cancel",
];

// Statuses that never resulted in (and can no longer result in) a fill, so
// they do not count toward the daily trade limit.
const NON_TRADE_STATUSES = ["canceled", "expired", "rejected", "replaced"];

export function isKillSwitchActive(): boolean {
  const endpoint = process.env.ALPACA_ENDPOINT;
  return !isTradingEnabled() || !endpoint || !endpoint.includes("paper-api");
}

// US equities trade on Eastern Time, so "today" for the daily limit is the
// current calendar day in New York.
function toEasternDateString(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/**
 * MVP risk manager. Every executable trade (AI or manual) must pass this
 * check before an order is placed. Options, margin, and short selling are
 * structurally impossible here: we only ever submit whole-share market
 * equity orders, sells must be covered by a held position, and buys are
 * blocked when the account has no cash.
 */
export function runRiskCheck(context: RiskCheckContext): RiskCheckResult {
  const { trade, account, positions, recentOrders, marketClock, recommendation } =
    context;
  const reasons: string[] = [];

  // 1. Kill switch
  if (!isTradingEnabled()) {
    reasons.push("Trading is disabled (kill switch is active).");
  }

  // 2. Paper trading only
  const endpoint = process.env.ALPACA_ENDPOINT;

  if (!endpoint) {
    reasons.push("ALPACA_ENDPOINT is not configured.");
  } else if (!endpoint.includes("paper-api")) {
    reasons.push("Only paper trading is allowed. Live endpoint blocked.");
  }

  // 3. Approved symbols only
  if (!isApprovedSymbol(trade.symbol)) {
    reasons.push(
      `${trade.symbol || "(empty symbol)"} is not in the approved trading universe.`
    );
  }

  // 4. Whole shares, max 1 per trade
  if (!Number.isFinite(trade.qty) || !Number.isInteger(trade.qty)) {
    reasons.push("Quantity must be a whole number.");
  } else {
    if (trade.qty <= 0) {
      reasons.push("Quantity must be greater than 0.");
    }

    if (trade.qty > MAX_QTY_PER_TRADE) {
      reasons.push(`Quantity cannot be greater than ${MAX_QTY_PER_TRADE}.`);
    }
  }

  // 5. Side must be buy or sell
  if (trade.side !== "buy" && trade.side !== "sell") {
    reasons.push("Trade side must be buy or sell.");
  }

  // 6. Regular market hours only
  if (!marketClock.isOpen) {
    reasons.push(
      `Market is closed. Next open: ${new Date(marketClock.nextOpen).toLocaleString()}.`
    );
  }

  // 7. Minimum confidence for AI-recommended trades
  if (recommendation && recommendation.confidence < MIN_AI_CONFIDENCE) {
    reasons.push(
      `AI confidence ${recommendation.confidence.toFixed(2)} is below the minimum of ${MIN_AI_CONFIDENCE}.`
    );
  }

  // 8. Max trades per day
  const today = toEasternDateString(new Date());
  const tradesToday = recentOrders.filter(
    (order) =>
      !NON_TRADE_STATUSES.includes(order.status) &&
      toEasternDateString(new Date(order.submittedAt)) === today
  ).length;

  if (tradesToday >= MAX_TRADES_PER_DAY) {
    reasons.push(
      `Daily trade limit reached (${tradesToday}/${MAX_TRADES_PER_DAY} trades today).`
    );
  }

  // 9. No duplicate open orders for the same symbol
  const hasOpenOrderForSymbol = recentOrders.some(
    (order) =>
      order.symbol === trade.symbol && OPEN_ORDER_STATUSES.includes(order.status)
  );

  if (hasOpenOrderForSymbol) {
    reasons.push(`There is already an open order for ${trade.symbol}.`);
  }

  // 10. Position rules: no adding to positions, no naked sells (no shorting)
  const position = positions.find((p) => p.symbol === trade.symbol);
  const heldQty = position ? Number(position.qty) : 0;

  if (trade.side === "buy" && heldQty > 0) {
    reasons.push(
      `Already holding ${heldQty} share(s) of ${trade.symbol}. Buying more is not allowed.`
    );
  }

  if (trade.side === "sell" && heldQty < trade.qty) {
    reasons.push(
      `Short selling is not allowed. Holding ${heldQty} share(s) of ${trade.symbol}.`
    );
  }

  // 11. No margin: buys require positive cash
  if (trade.side === "buy" && Number(account.cash) <= 0) {
    reasons.push("Account cash is not positive. Buying on margin is not allowed.");
  }

  // 12. Daily loss limit: 2% of portfolio value
  const equity = Number(account.equity);
  const lastEquity = Number(account.lastEquity);
  const portfolioValue = Number(account.portfolioValue);

  if (lastEquity > 0 && portfolioValue > 0) {
    const dailyLoss = lastEquity - equity;
    const lossLimit = portfolioValue * DAILY_LOSS_LIMIT_PCT;

    if (dailyLoss >= lossLimit) {
      reasons.push(
        `Daily loss limit hit: down $${dailyLoss.toFixed(2)} today (limit $${lossLimit.toFixed(2)}).`
      );
    }
  }

  return {
    approved: reasons.length === 0,
    reasons,
  };
}
