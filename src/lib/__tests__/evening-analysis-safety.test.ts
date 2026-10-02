import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  classifyEveningCandidate,
  mergeWatchlistCandidates,
  type EveningSelectedCandidate,
} from "@/lib/evening-analysis";
import { MIN_BUY_SCORE, type CandidateEvaluation } from "@/lib/market-analysis";

function evaluation(
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

function selected(candidate: CandidateEvaluation): EveningSelectedCandidate {
  return { evaluation: candidate, ...classifyEveningCandidate(candidate) };
}

describe("Evening Analysis safety boundary", () => {
  it("contains no order-placement import and keeps the zero-order response contract", () => {
    const moduleSource = readFileSync(
      new URL("../evening-analysis.ts", import.meta.url),
      "utf8"
    );
    const routeSource = readFileSync(
      new URL("../../app/api/agent/evening-analysis/route.ts", import.meta.url),
      "utf8"
    );

    expect(moduleSource).not.toMatch(/^import .*placePaperMarketOrder/m);
    expect(routeSource).not.toMatch(/^import .*placePaperMarketOrder/m);
    expect(routeSource).toContain("ordersSubmitted: 0");
    expect(routeSource).toContain("ordersQueued: 0");
  });

  it("caps a below-threshold model WATCH at MONITOR and removes entry levels", () => {
    const nearMiss = evaluation({
      scores: { ...evaluation().scores, total: MIN_BUY_SCORE - 1 },
    });

    const [result] = mergeWatchlistCandidates([selected(nearMiss)], [
      {
        symbol: "AAPL",
        action: "WATCH",
        confidence: 0.8,
        thesis: "Monitor the setup.",
        supportingFactors: ["Trend"],
        riskFactors: ["Volatility"],
        invalidationConditions: ["Breaks support"],
        proposedEntryRange: "$99-$100",
        maximumEntryPrice: 100,
      },
    ]);

    expect(result.action).toBe("MONITOR");
    expect(result.status).toBe("monitor");
    expect(result.proposedEntryRange).toBeNull();
    expect(result.maximumEntryPrice).toBeNull();
  });

  it("fails closed when an otherwise strict candidate lacks invalidation rules", () => {
    const strict = evaluation();
    const [result] = mergeWatchlistCandidates([selected(strict)], [
      {
        symbol: "AAPL",
        action: "WATCH",
        confidence: 0.8,
        thesis: "Monitor the setup.",
        supportingFactors: ["Trend"],
        riskFactors: ["Volatility"],
        invalidationConditions: [],
        proposedEntryRange: "$99-$100",
        maximumEntryPrice: 100,
      },
    ]);

    expect(result.action).toBe("NO_TRADE");
    expect(result.status).toBe("rejected");
    expect(result.proposedEntryRange).toBeNull();
    expect(result.maximumEntryPrice).toBeNull();
  });
});
