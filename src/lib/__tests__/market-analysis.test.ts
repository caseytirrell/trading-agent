import { describe, expect, it } from "vitest";
import type { AlpacaAccountSummary } from "@/lib/alpaca";
import {
  analyzeMarket,
  MIN_BUY_SCORE,
  qualifiesForNewBuy,
  type CandidateEvaluation,
} from "@/lib/market-analysis";

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

function candidate(
  overrides: Partial<CandidateEvaluation> = {}
): CandidateEvaluation {
  return {
    symbol: "AAPL",
    eligible: true,
    rejectionReasons: [],
    rejectionCodes: [],
    scores: {
      trend: 20,
      momentum: 15,
      relativeStrength: 10,
      volume: 8,
      risk: 12,
      portfolioFit: 10,
      total: MIN_BUY_SCORE,
    },
    metrics: {
      symbol: "AAPL",
      latestPrice: 100,
      previousClose: 99,
      dailyChangePct: 1,
      return5dPct: 2,
      return20dPct: 5,
      return50dPct: 10,
      sma20: 95,
      sma50: 90,
      avgVolume20d: 1_000_000,
      latestVolume: 1_100_000,
      atrPct20d: 1.5,
      relativeStrengthVsSpy: 2,
      lastBarDate: "2026-09-28",
    },
    ...overrides,
  };
}

describe("market-analysis safety gates", () => {
  it("forces no-trade when required daily bars are missing", () => {
    const analysis = analyzeMarket({
      bars: {},
      account,
      positions: [],
      recentOrders: [],
      now: new Date("2026-09-28T16:00:00-04:00"),
    });

    expect(analysis.forceNoTrade).toBe(true);
    expect(analysis.dataIssues.length).toBeGreaterThan(0);
    expect(analysis.candidates.every((item) => !item.eligible)).toBe(true);
  });

  it("requires eligibility, healthy metrics, and the score threshold", () => {
    expect(qualifiesForNewBuy(candidate())).toBe(true);
    expect(
      qualifiesForNewBuy(
        candidate({
          scores: { ...candidate().scores, total: MIN_BUY_SCORE - 1 },
        })
      )
    ).toBe(false);
    expect(
      qualifiesForNewBuy(
        candidate({
          eligible: false,
          rejectionReasons: ["Position already held."],
          rejectionCodes: ["HELD"],
        })
      )
    ).toBe(false);
    expect(qualifiesForNewBuy(candidate({ metrics: null }))).toBe(false);
  });
});
