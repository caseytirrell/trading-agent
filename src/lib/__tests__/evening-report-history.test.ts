import { describe, expect, it } from "vitest";
import {
  clampReportListLimit,
  computeEveningReportValidity,
  dateOnlyString,
  DEFAULT_REPORT_LIST_LIMIT,
  easternCalendarDate,
  extractDataFreshness,
  extractLastBarDates,
  finiteNumberOrNull,
  isUuid,
  mapEveningCandidateRowToDto,
  mapEveningReportRowToDetailDto,
  mapEveningReportRowToSummaryDto,
  MAX_REPORT_LIST_LIMIT,
  type EveningCandidateRow,
  type EveningReportDetailRow,
} from "@/lib/evening-report-history";

// A Prisma-Decimal-like object (the real class exposes toNumber()).
function decimalLike(value: number): { toNumber: () => number } {
  return { toNumber: () => value };
}

describe("easternCalendarDate", () => {
  it("converts UTC instants to the America/New_York calendar date in summer (EDT, UTC-4)", () => {
    expect(easternCalendarDate(new Date("2026-07-24T03:59:00Z"))).toBe(
      "2026-07-23"
    );
    expect(easternCalendarDate(new Date("2026-07-24T04:00:00Z"))).toBe(
      "2026-07-24"
    );
  });

  it("converts UTC instants to the America/New_York calendar date in winter (EST, UTC-5)", () => {
    expect(easternCalendarDate(new Date("2026-01-15T04:59:00Z"))).toBe(
      "2026-01-14"
    );
    expect(easternCalendarDate(new Date("2026-01-15T05:00:00Z"))).toBe(
      "2026-01-15"
    );
  });

  it("rejects invalid dates instead of returning garbage", () => {
    expect(() => easternCalendarDate(new Date("nope"))).toThrow();
  });
});

describe("dateOnlyString", () => {
  it("keeps YYYY-MM-DD strings and normalizes UTC-midnight Dates (Prisma date columns)", () => {
    expect(dateOnlyString("2026-07-24")).toBe("2026-07-24");
    expect(dateOnlyString(new Date("2026-07-24T00:00:00.000Z"))).toBe(
      "2026-07-24"
    );
  });

  it("returns null for missing or unparseable values", () => {
    expect(dateOnlyString(null)).toBeNull();
    expect(dateOnlyString(undefined)).toBeNull();
    expect(dateOnlyString("garbage")).toBeNull();
    expect(dateOnlyString(new Date("garbage"))).toBeNull();
  });
});

describe("isUuid / clampReportListLimit", () => {
  it("accepts canonical UUIDs and rejects everything else", () => {
    expect(isUuid("123e4567-e89b-12d3-a456-426614174000")).toBe(true);
    expect(isUuid("123E4567-E89B-12D3-A456-426614174000")).toBe(true);
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid("123e4567e89b12d3a456426614174000")).toBe(false);
    expect(isUuid("'; DROP TABLE evening_analysis_reports; --")).toBe(false);
  });

  it("clamps browser-supplied limits into [1, max] with a safe default", () => {
    expect(clampReportListLimit(null)).toBe(DEFAULT_REPORT_LIST_LIMIT);
    expect(clampReportListLimit("abc")).toBe(DEFAULT_REPORT_LIST_LIMIT);
    expect(clampReportListLimit("")).toBe(DEFAULT_REPORT_LIST_LIMIT);
    expect(clampReportListLimit("5")).toBe(5);
    expect(clampReportListLimit("5.9")).toBe(5);
    expect(clampReportListLimit(0)).toBe(1);
    expect(clampReportListLimit(-3)).toBe(1);
    expect(clampReportListLimit(10_000)).toBe(MAX_REPORT_LIST_LIMIT);
  });
});

describe("computeEveningReportValidity (Phase 3 expiration rule)", () => {
  // 2026-07-24T12:00Z is 2026-07-24 08:00 in America/New_York (EDT).
  const now = new Date("2026-07-24T12:00:00Z");

  const activeBase = {
    status: "active",
    intendedSessionDate: "2026-07-24",
    expiresAt: null,
    expiredAt: null,
  };

  it("keeps a report for today's Eastern session active and revalidatable", () => {
    const validity = computeEveningReportValidity(activeBase, now);

    expect(validity.validity).toBe("active");
    expect(validity.isExpired).toBe(false);
    expect(validity.eligibleForRevalidation).toBe(true);
  });

  it("keeps a report for an upcoming session active", () => {
    const validity = computeEveningReportValidity(
      { ...activeBase, intendedSessionDate: "2026-07-27" },
      now
    );

    expect(validity.validity).toBe("active");
    expect(validity.eligibleForRevalidation).toBe(true);
  });

  it("expires a report whose intended session date is before today in America/New_York", () => {
    const validity = computeEveningReportValidity(
      { ...activeBase, intendedSessionDate: "2026-07-23" },
      now
    );

    expect(validity.validity).toBe("expired");
    expect(validity.isExpired).toBe(true);
    expect(validity.eligibleForRevalidation).toBe(false);
    expect(validity.validityReasons.join(" ")).toContain("2026-07-23");
  });

  it("uses the Eastern calendar date, not the UTC date, for the comparison", () => {
    // 2026-07-25T02:00Z is still 2026-07-24 22:00 in New York, so a report
    // for the 2026-07-24 session has not expired yet even though UTC says
    // it is already the 25th.
    const lateEvening = new Date("2026-07-25T02:00:00Z");

    const validity = computeEveningReportValidity(activeBase, lateEvening);

    expect(validity.validity).toBe("active");
    expect(validity.eligibleForRevalidation).toBe(true);
  });

  it("expires a report once now >= expiresAt", () => {
    const validity = computeEveningReportValidity(
      { ...activeBase, expiresAt: "2026-07-24T11:00:00Z" },
      now
    );

    expect(validity.validity).toBe("expired");
    expect(validity.eligibleForRevalidation).toBe(false);
  });

  it("keeps a report active when expiresAt is still in the future", () => {
    const validity = computeEveningReportValidity(
      { ...activeBase, expiresAt: "2026-07-24T20:00:00Z" },
      now
    );

    expect(validity.validity).toBe("active");
  });

  it("treats status=expired and expiredAt markers as expired regardless of dates", () => {
    expect(
      computeEveningReportValidity({ ...activeBase, status: "expired" }, now)
        .isExpired
    ).toBe(true);

    expect(
      computeEveningReportValidity(
        { ...activeBase, expiredAt: "2026-07-23T22:00:00Z" },
        now
      ).isExpired
    ).toBe(true);
  });

  it("marks a report without an intended session date as never revalidatable", () => {
    const validity = computeEveningReportValidity(
      { ...activeBase, intendedSessionDate: null },
      now
    );

    // Still shown as active history, but no future flow may act on it.
    expect(validity.validity).toBe("active");
    expect(validity.eligibleForRevalidation).toBe(false);
    expect(validity.validityReasons.join(" ")).toContain(
      "never be revalidated"
    );
  });

  it("fails closed on unknown status or unparseable stored values", () => {
    expect(
      computeEveningReportValidity({ ...activeBase, status: "draft" }, now)
        .isExpired
    ).toBe(true);

    expect(
      computeEveningReportValidity(
        { ...activeBase, intendedSessionDate: "garbage" },
        now
      ).isExpired
    ).toBe(true);

    expect(
      computeEveningReportValidity(
        { ...activeBase, expiresAt: "garbage" },
        now
      ).isExpired
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Row → DTO mapping
// ---------------------------------------------------------------------------

function candidateRow(overrides: Partial<EveningCandidateRow> = {}): EveningCandidateRow {
  return {
    id: "1a51cbe8-0000-4000-8000-000000000001",
    symbol: "AAPL",
    action: "WATCH",
    status: "watch",
    rank: 1,
    confidence: decimalLike(0.72),
    deterministicScore: 78,
    scoreComponents: {
      trend: 18,
      momentum: 16,
      relativeStrength: 12,
      volume: 8,
      risk: 14,
      portfolioFit: 10,
      total: 78,
    },
    scoreThreshold: 70,
    passedScoreThreshold: true,
    eligibleForNewBuy: true,
    inclusionType: "STRICT_WATCH",
    inclusionReason: "Passed every strict new-buy filter.",
    blockingReasons: [],
    thesis: "Uptrend with steady volume.",
    supportingFactors: ["Above 50-day average"],
    riskFactors: ["Earnings next week"],
    invalidationConditions: ["Close below $200"],
    proposedEntryRange: "$210-$215",
    maximumEntryPrice: decimalLike(216.5),
    currentReferencePrice: decimalLike(212.4),
    ...overrides,
  };
}

function detailRow(
  overrides: Partial<EveningReportDetailRow> = {}
): EveningReportDetailRow {
  return {
    id: "9b51cbe8-0000-4000-8000-00000000000a",
    status: "active",
    generatedAt: new Date("2026-07-23T22:15:00Z"),
    intendedSessionDate: new Date("2026-07-24T00:00:00.000Z"),
    expiresAt: null,
    expiredAt: null,
    analysisOnly: true,
    ordersSubmittedCount: 0,
    ordersQueuedCount: 0,
    safetyNotice: "Analysis only. No order was placed.",
    marketStatus: "closed",
    marketStatusLabel: "Market is closed.",
    marketRegime: "neutral",
    regimeReasons: ["SPY above its 50-day average."],
    selectionNotice: "All shown candidates passed the strict filters.",
    summary: "One strict candidate for tomorrow.",
    warnings: ["Example warning"],
    candidates: [
      candidateRow(),
      candidateRow({
        id: "1a51cbe8-0000-4000-8000-000000000002",
        symbol: "MSFT",
        action: "MONITOR",
        status: "monitor",
        rank: 2,
        eligibleForNewBuy: false,
        inclusionType: "HELD_MONITOR",
        proposedEntryRange: null,
        maximumEntryPrice: null,
      }),
      candidateRow({
        id: "1a51cbe8-0000-4000-8000-000000000003",
        symbol: "SPY",
        action: "NO_TRADE",
        status: "rejected",
        rank: 3,
        eligibleForNewBuy: false,
        inclusionType: "BLOCKED_MONITOR",
        blockingReasons: ["Position already held."],
        proposedEntryRange: null,
        maximumEntryPrice: null,
      }),
    ],
    marketAnalysis: {
      asOf: new Date("2026-07-23T22:14:00Z"),
      forceNoTrade: false,
      dataIssues: ["QQQ bars are one day stale."],
      candidates: [
        { symbol: "AAPL", lastBarDate: "2026-07-23T04:00:00-04:00" },
        { symbol: "MSFT", lastBarDate: "2026-07-23T04:00:00-04:00" },
        { symbol: "SPY", lastBarDate: null },
      ],
    },
    ...overrides,
  };
}

const mappingNow = new Date("2026-07-24T12:00:00Z");

describe("mapEveningCandidateRowToDto", () => {
  it("preserves WATCH/MONITOR/NO_TRADE labels and converts decimals", () => {
    const dto = mapEveningCandidateRowToDto(candidateRow(), {
      lastBarDates: { AAPL: "2026-07-23" },
      reportExpired: false,
    });

    expect(dto.action).toBe("WATCH");
    expect(dto.status).toBe("watch");
    expect(dto.confidence).toBeCloseTo(0.72);
    expect(dto.maximumEntryPrice).toBeCloseTo(216.5);
    expect(dto.currentReferencePrice).toBeCloseTo(212.4);
    expect(dto.scoreComponents.total).toBe(78);
    expect(dto.lastBarDate).toBe("2026-07-23");
    expect(dto.reportExpired).toBe(false);
    expect(dto.executable).toBe(false);
    expect(dto.mappingNotes).toEqual([]);
  });

  it("fails closed to NO_TRADE/rejected on unrecognized stored labels", () => {
    const dto = mapEveningCandidateRowToDto(
      candidateRow({ action: "BUY", status: "queued" }),
      { lastBarDates: {}, reportExpired: false }
    );

    expect(dto.action).toBe("NO_TRADE");
    expect(dto.status).toBe("rejected");
    expect(dto.mappingNotes.length).toBe(2);
  });

  it("flags candidates of an expired report and never marks them executable", () => {
    const dto = mapEveningCandidateRowToDto(candidateRow(), {
      lastBarDates: {},
      reportExpired: true,
    });

    expect(dto.reportExpired).toBe(true);
    expect(dto.executable).toBe(false);
    expect(dto.lastBarDate).toBeNull();
  });
});

describe("mapEveningReportRowToSummaryDto", () => {
  it("maps an active report with per-action counts", () => {
    const summaryRow = {
      id: "9b51cbe8-0000-4000-8000-00000000000a",
      status: "active",
      generatedAt: new Date("2026-07-23T22:15:00Z"),
      intendedSessionDate: new Date("2026-07-24T00:00:00.000Z"),
      expiresAt: null,
      expiredAt: null,
      analysisOnly: true,
      ordersSubmittedCount: 0,
      ordersQueuedCount: 0,
      marketStatus: "closed",
      marketRegime: "neutral",
      summary: "One strict candidate.",
      candidates: [
        { action: "WATCH" },
        { action: "MONITOR" },
        { action: "NO_TRADE" },
        { action: "??" },
      ],
    };

    const dto = mapEveningReportRowToSummaryDto(summaryRow, mappingNow);

    expect(dto.validity).toBe("active");
    expect(dto.eligibleForRevalidation).toBe(true);
    expect(dto.generatedAt).toBe("2026-07-23T22:15:00.000Z");
    expect(dto.intendedSessionDate).toBe("2026-07-24");
    expect(dto.candidateCount).toBe(4);
    expect(dto.watchCount).toBe(1);
    expect(dto.monitorCount).toBe(1);
    // Unrecognized actions are counted with NO_TRADE, never as tradable.
    expect(dto.noTradeCount).toBe(2);
    expect(dto.ordersSubmittedCount).toBe(0);
    expect(dto.ordersQueuedCount).toBe(0);
  });

  it("never returns an out-of-date report as valid/current", () => {
    const dto = mapEveningReportRowToSummaryDto(
      {
        id: "9b51cbe8-0000-4000-8000-00000000000b",
        status: "active",
        generatedAt: new Date("2026-07-20T22:15:00Z"),
        intendedSessionDate: new Date("2026-07-21T00:00:00.000Z"),
        expiresAt: null,
        expiredAt: null,
        analysisOnly: true,
        ordersSubmittedCount: 0,
        ordersQueuedCount: 0,
        marketStatus: "closed",
        marketRegime: "neutral",
        summary: null,
        candidates: [],
      },
      mappingNow
    );

    expect(dto.validity).toBe("expired");
    expect(dto.isExpired).toBe(true);
    expect(dto.eligibleForRevalidation).toBe(false);
  });
});

describe("mapEveningReportRowToDetailDto", () => {
  it("maps the full report with candidates, freshness, and validity", () => {
    const dto = mapEveningReportRowToDetailDto(detailRow(), mappingNow);

    expect(dto.validity).toBe("active");
    expect(dto.eligibleForRevalidation).toBe(true);
    expect(dto.analysisOnly).toBe(true);
    expect(dto.ordersSubmittedCount).toBe(0);
    expect(dto.ordersQueuedCount).toBe(0);
    expect(dto.safetyNotice).toContain("Analysis only");
    expect(dto.warnings).toEqual(["Example warning"]);
    expect(dto.regimeReasons).toEqual(["SPY above its 50-day average."]);

    // WATCH/MONITOR/NO_TRADE survive persistence → readback mapping.
    expect(dto.candidates.map((candidate) => candidate.action)).toEqual([
      "WATCH",
      "MONITOR",
      "NO_TRADE",
    ]);
    expect(dto.watchCount).toBe(1);
    expect(dto.monitorCount).toBe(1);
    expect(dto.noTradeCount).toBe(1);

    // Data freshness comes from the persisted market_analyses JSON.
    expect(dto.dataFreshness.analysisAsOf).toBe("2026-07-23T22:14:00.000Z");
    expect(dto.dataFreshness.forceNoTrade).toBe(false);
    expect(dto.dataFreshness.dataIssues).toEqual([
      "QQQ bars are one day stale.",
    ]);
    expect(dto.candidates[0].lastBarDate).toBe("2026-07-23T04:00:00-04:00");
    expect(dto.candidates[2].lastBarDate).toBeNull();
  });

  it("marks an expired report and every one of its candidates as expired", () => {
    const dto = mapEveningReportRowToDetailDto(
      detailRow({
        status: "expired",
        expiredAt: new Date("2026-07-24T09:00:00Z"),
        intendedSessionDate: new Date("2026-07-23T00:00:00.000Z"),
      }),
      mappingNow
    );

    expect(dto.validity).toBe("expired");
    expect(dto.isExpired).toBe(true);
    expect(dto.eligibleForRevalidation).toBe(false);
    expect(dto.expiredAt).toBe("2026-07-24T09:00:00.000Z");
    expect(dto.candidates.every((candidate) => candidate.reportExpired)).toBe(
      true
    );
    expect(dto.candidates.every((candidate) => !candidate.executable)).toBe(
      true
    );
    // The WATCH label itself is preserved as history even when expired.
    expect(dto.candidates[0].action).toBe("WATCH");
  });

  it("handles a missing market analysis row without inventing freshness data", () => {
    const dto = mapEveningReportRowToDetailDto(
      detailRow({ marketAnalysis: null }),
      mappingNow
    );

    expect(dto.dataFreshness.analysisAsOf).toBeNull();
    expect(dto.dataFreshness.forceNoTrade).toBeNull();
    expect(dto.dataFreshness.dataIssues).toEqual([]);
    expect(dto.candidates[0].lastBarDate).toBeNull();
  });
});

describe("extractLastBarDates / extractDataFreshness / finiteNumberOrNull", () => {
  it("skips malformed candidate entries instead of guessing", () => {
    expect(
      extractLastBarDates([
        { symbol: "AAPL", lastBarDate: "2026-07-23" },
        { symbol: "MSFT" },
        { symbol: "", lastBarDate: "2026-07-23" },
        { lastBarDate: "2026-07-23" },
        "junk",
        null,
        42,
      ])
    ).toEqual({ AAPL: "2026-07-23", MSFT: null });

    expect(extractLastBarDates("not-an-array")).toEqual({});
    expect(extractLastBarDates(null)).toEqual({});
  });

  it("returns null freshness when no market analysis was linked", () => {
    expect(extractDataFreshness(null)).toEqual({
      analysisAsOf: null,
      forceNoTrade: null,
      dataIssues: [],
      lastBarDates: {},
    });
  });

  it("coerces numbers, numeric strings, and Decimal-likes; rejects the rest", () => {
    expect(finiteNumberOrNull(3.5)).toBe(3.5);
    expect(finiteNumberOrNull("212.40")).toBeCloseTo(212.4);
    expect(finiteNumberOrNull(decimalLike(0.72))).toBeCloseTo(0.72);
    expect(finiteNumberOrNull(Number.NaN)).toBeNull();
    expect(finiteNumberOrNull("")).toBeNull();
    expect(finiteNumberOrNull("abc")).toBeNull();
    expect(finiteNumberOrNull(null)).toBeNull();
    expect(finiteNumberOrNull(undefined)).toBeNull();
    expect(finiteNumberOrNull({})).toBeNull();
  });
});
