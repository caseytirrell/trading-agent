import { describe, expect, it } from "vitest";
import {
  buildEveningCandidateRows,
  clampedConfidence,
  dateOnlyToDate,
  decimalOrNull,
  errorToMessage,
  isoToDate,
  toJsonValue,
  truncateText,
} from "@/lib/db-serialization";
import type { EveningAnalysisCandidate } from "@/lib/evening-analysis";

describe("toJsonValue", () => {
  it("passes plain JSON through unchanged", () => {
    expect(toJsonValue({ a: 1, b: ["x", true] }, {})).toEqual({
      a: 1,
      b: ["x", true],
    });
  });

  it("strips undefined properties and converts Dates to ISO strings", () => {
    const value = {
      when: new Date("2026-07-20T00:00:00.000Z"),
      missing: undefined,
    };

    expect(toJsonValue(value, {})).toEqual({
      when: "2026-07-20T00:00:00.000Z",
    });
  });

  it("converts NaN and Infinity to null inside structures", () => {
    expect(toJsonValue({ bad: Number.NaN, worse: Infinity }, {})).toEqual({
      bad: null,
      worse: null,
    });
  });

  it("returns the fallback for undefined, null, and unserializable values", () => {
    expect(toJsonValue(undefined, {})).toEqual({});
    expect(toJsonValue(null, [])).toEqual([]);
    expect(toJsonValue(BigInt(1), {})).toEqual({});

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(toJsonValue(cyclic, {})).toEqual({});
  });
});

describe("isoToDate", () => {
  it("parses a valid ISO timestamp", () => {
    const date = isoToDate("2026-07-20T09:30:00-04:00");
    expect(date?.toISOString()).toBe("2026-07-20T13:30:00.000Z");
  });

  it("returns null for missing or invalid input", () => {
    expect(isoToDate(null)).toBeNull();
    expect(isoToDate(undefined)).toBeNull();
    expect(isoToDate("")).toBeNull();
    expect(isoToDate("not-a-date")).toBeNull();
  });
});

describe("dateOnlyToDate", () => {
  it("anchors a YYYY-MM-DD date to UTC midnight so the stored day never shifts", () => {
    const date = dateOnlyToDate("2026-07-20");
    expect(date?.toISOString()).toBe("2026-07-20T00:00:00.000Z");
  });

  it("rejects non-date strings and partial formats", () => {
    expect(dateOnlyToDate("2026-7-2")).toBeNull();
    expect(dateOnlyToDate("2026-07-20T00:00:00Z")).toBeNull();
    expect(dateOnlyToDate("garbage")).toBeNull();
    expect(dateOnlyToDate(null)).toBeNull();
  });
});

describe("decimalOrNull", () => {
  it("keeps finite numbers and numeric strings (Alpaca sends strings)", () => {
    expect(decimalOrNull(1)).toBe(1);
    expect(decimalOrNull(752.24)).toBe(752.24);
    expect(decimalOrNull("752.24")).toBe("752.24");
  });

  it("rejects non-finite and non-numeric values", () => {
    expect(decimalOrNull(Number.NaN)).toBeNull();
    expect(decimalOrNull(Infinity)).toBeNull();
    expect(decimalOrNull("")).toBeNull();
    expect(decimalOrNull("abc")).toBeNull();
    expect(decimalOrNull(null)).toBeNull();
    expect(decimalOrNull(undefined)).toBeNull();
  });
});

describe("clampedConfidence", () => {
  it("clamps to the numeric(5,4) friendly range [0, 1]", () => {
    expect(clampedConfidence(0.675)).toBe(0.675);
    expect(clampedConfidence(-0.2)).toBe(0);
    expect(clampedConfidence(3)).toBe(1);
    expect(clampedConfidence(Number.NaN)).toBe(0);
  });
});

describe("truncateText / errorToMessage", () => {
  it("bounds long text with an ellipsis", () => {
    const long = "x".repeat(600);
    const truncated = truncateText(long, 500);
    expect(truncated.length).toBe(500);
    expect(truncated.endsWith("…")).toBe(true);
    expect(truncateText("short", 500)).toBe("short");
  });

  it("extracts and bounds error messages", () => {
    expect(errorToMessage(new Error("boom"))).toBe("boom");
    expect(errorToMessage("plain string")).toBe("plain string");
    expect(errorToMessage(new Error("y".repeat(600))).length).toBe(500);
  });
});

describe("buildEveningCandidateRows", () => {
  const candidate: EveningAnalysisCandidate = {
    symbol: "AAPL",
    action: "MONITOR",
    status: "monitor",
    rank: 1,
    confidence: 0.67,
    deterministicScore: 87,
    scoreComponents: {
      trend: 20,
      momentum: 20,
      relativeStrength: 15,
      volume: 6,
      risk: 11,
      portfolioFit: 15,
      total: 87,
    },
    scoreThreshold: 72,
    passedScoreThreshold: true,
    eligibleForNewBuy: false,
    inclusionType: "BLOCKED_MONITOR",
    inclusionReason: "Ranks among the top approved symbols (score 87).",
    blockingReasons: ["Market regime is bearish_unstable; new buys are blocked."],
    thesis: "Worth tracking.",
    supportingFactors: ["Strong trend."],
    riskFactors: ["Regime risk."],
    invalidationConditions: ["Opens below the 20-day SMA."],
    proposedEntryRange: null,
    maximumEntryPrice: null,
    currentReferencePrice: 333.74,
  };

  it("maps every column of an evening_analysis_candidates row", () => {
    const rows = buildEveningCandidateRows([candidate]);

    expect(rows).toEqual([
      {
        symbol: "AAPL",
        action: "MONITOR",
        status: "monitor",
        rank: 1,
        confidence: 0.67,
        deterministicScore: 87,
        scoreComponents: {
          trend: 20,
          momentum: 20,
          relativeStrength: 15,
          volume: 6,
          risk: 11,
          portfolioFit: 15,
          total: 87,
        },
        scoreThreshold: 72,
        passedScoreThreshold: true,
        eligibleForNewBuy: false,
        inclusionType: "BLOCKED_MONITOR",
        inclusionReason: "Ranks among the top approved symbols (score 87).",
        blockingReasons: [
          "Market regime is bearish_unstable; new buys are blocked.",
        ],
        thesis: "Worth tracking.",
        supportingFactors: ["Strong trend."],
        riskFactors: ["Regime risk."],
        invalidationConditions: ["Opens below the 20-day SMA."],
        proposedEntryRange: null,
        maximumEntryPrice: null,
        currentReferencePrice: 333.74,
      },
    ]);
  });

  it("nulls non-finite prices and clamps out-of-range confidence", () => {
    const broken: EveningAnalysisCandidate = {
      ...candidate,
      confidence: 7,
      maximumEntryPrice: Number.NaN,
      currentReferencePrice: Infinity,
    };

    const [row] = buildEveningCandidateRows([broken]);

    expect(row.confidence).toBe(1);
    expect(row.maximumEntryPrice).toBeNull();
    expect(row.currentReferencePrice).toBeNull();
  });

  it("keeps rows aligned with input order (rank comes from the candidate)", () => {
    const second: EveningAnalysisCandidate = {
      ...candidate,
      symbol: "V",
      rank: 2,
    };

    const rows = buildEveningCandidateRows([candidate, second]);
    expect(rows.map((row) => [row.symbol, row.rank])).toEqual([
      ["AAPL", 1],
      ["V", 2],
    ]);
  });
});
