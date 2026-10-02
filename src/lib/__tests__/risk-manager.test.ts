import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AlpacaAccountSummary,
  AlpacaClock,
  AlpacaOrder,
  AlpacaPosition,
} from "@/lib/alpaca";
import {
  isKillSwitchActive,
  runRiskCheck,
  type RiskCheckContext,
  type TradeRequest,
} from "@/lib/risk-manager";

const account: AlpacaAccountSummary = {
  accountNumber: "paper-account",
  status: "ACTIVE",
  currency: "USD",
  buyingPower: "10000",
  portfolioValue: "10000",
  cash: "10000",
  equity: "10000",
  lastEquity: "10000",
  paper: true,
};

const marketClock: AlpacaClock = {
  timestamp: "2026-09-28T14:00:00-04:00",
  isOpen: true,
  nextOpen: "2026-09-29T09:30:00-04:00",
  nextClose: "2026-09-28T16:00:00-04:00",
};

const trade: TradeRequest = { symbol: "AAPL", qty: 1, side: "buy" };

function order(
  overrides: Partial<AlpacaOrder> = {}
): AlpacaOrder {
  return {
    id: crypto.randomUUID(),
    symbol: "MSFT",
    qty: "1",
    side: "buy",
    type: "market",
    timeInForce: "day",
    status: "filled",
    filledQty: "1",
    filledAvgPrice: "100",
    submittedAt: new Date().toISOString(),
    filledAt: new Date().toISOString(),
    expiredAt: null,
    canceledAt: null,
    failedAt: null,
    ...overrides,
  };
}

function context(
  overrides: Partial<RiskCheckContext> = {}
): RiskCheckContext {
  return {
    trade,
    account,
    positions: [],
    recentOrders: [],
    marketClock,
    ...overrides,
  };
}

describe("runRiskCheck", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-28T18:00:00Z"));
    vi.stubEnv("TRADING_ENABLED", "true");
    vi.stubEnv("ALPACA_ENDPOINT", "https://paper-api.alpaca.markets");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("fails closed unless trading is explicitly enabled", () => {
    vi.stubEnv("TRADING_ENABLED", "");

    expect(isKillSwitchActive()).toBe(true);
    expect(runRiskCheck(context())).toMatchObject({
      approved: false,
      reasons: ["Trading is disabled (kill switch is active)."],
    });
  });

  it("approves a valid one-share paper trade", () => {
    expect(runRiskCheck(context())).toEqual({ approved: true, reasons: [] });
  });

  it("blocks live endpoints, invalid symbols, and invalid quantities", () => {
    vi.stubEnv("ALPACA_ENDPOINT", "https://api.alpaca.markets");

    const result = runRiskCheck(
      context({
        trade: { symbol: "BTCUSD", qty: 2.5, side: "buy" },
      })
    );

    expect(result.approved).toBe(false);
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        "Only paper trading is allowed. Live endpoint blocked.",
        "BTCUSD is not in the approved trading universe.",
        "Quantity must be a whole number.",
      ])
    );
  });

  it("blocks closed markets and low-confidence AI trades", () => {
    const result = runRiskCheck(
      context({
        marketClock: { ...marketClock, isOpen: false },
        recommendation: { action: "BUY", confidence: 0.69 },
      })
    );

    expect(result.approved).toBe(false);
    expect(result.reasons.some((reason) => reason.startsWith("Market is closed."))).toBe(true);
    expect(result.reasons).toContain(
      "AI confidence 0.69 is below the minimum of 0.7."
    );
  });

  it("enforces the daily trade limit", () => {
    const result = runRiskCheck(
      context({ recentOrders: [order(), order(), order()] })
    );

    expect(result.approved).toBe(false);
    expect(result.reasons).toContain(
      "Daily trade limit reached (3/3 trades today)."
    );
  });

  it("blocks duplicate open orders and adding to an existing position", () => {
    const positions: AlpacaPosition[] = [
      {
        symbol: "AAPL",
        qty: "1",
        marketValue: "100",
        avgEntryPrice: "90",
        currentPrice: "100",
        unrealizedPl: "10",
        unrealizedPlpc: "0.11",
      },
    ];
    const result = runRiskCheck(
      context({
        positions,
        recentOrders: [order({ symbol: "AAPL", status: "accepted" })],
      })
    );

    expect(result.approved).toBe(false);
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        "There is already an open order for AAPL.",
        "Already holding 1 share(s) of AAPL. Buying more is not allowed.",
      ])
    );
  });

  it("blocks naked sells and buys without positive cash", () => {
    const sellResult = runRiskCheck(
      context({ trade: { symbol: "AAPL", qty: 1, side: "sell" } })
    );
    const buyResult = runRiskCheck(
      context({ account: { ...account, cash: "0" } })
    );

    expect(sellResult.reasons).toContain(
      "Short selling is not allowed. Holding 0 share(s) of AAPL."
    );
    expect(buyResult.reasons).toContain(
      "Account cash is not positive. Buying on margin is not allowed."
    );
  });

  it("blocks trading once the daily loss reaches two percent", () => {
    const result = runRiskCheck(
      context({
        account: {
          ...account,
          equity: "9700",
          lastEquity: "10000",
          portfolioValue: "10000",
        },
      })
    );

    expect(result.approved).toBe(false);
    expect(result.reasons[0]).toMatch(/^Daily loss limit hit:/);
  });
});
