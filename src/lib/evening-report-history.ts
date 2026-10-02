import { isoToDate } from "@/lib/db-serialization";

// Evening Analysis report history (Phase 3): pure helpers for the
// server-side expiration rule and for mapping persisted report/candidate
// rows onto API-safe DTOs.
//
// Like db-serialization.ts, this module is deliberately pure: no Prisma, no
// "server-only", no environment access — everything is deterministic data
// transformation, unit-testable without a database.
//
// Safety boundaries (do not change):
// - Saved Evening Analysis reports are read-only HISTORY. The DTOs built
//   here describe what an analysis said at the moment it ran; they are never
//   trade instructions, and nothing downstream may turn one into an order.
// - Validity is computed SERVER-SIDE from stored fields via
//   computeEveningReportValidity. Clients only display the result; they
//   never decide whether a report is still valid.
// - Expired reports must never be presented as valid/current. Every mapper
//   embeds the computed validity in its DTO, and every candidate carries
//   `executable: false` plus the report's expiry so a future phase (e.g.
//   morning revalidation) cannot accidentally treat a stale watchlist as
//   actionable. Anything unparseable fails closed to "expired".

// ---------------------------------------------------------------------------
// America/New_York calendar helpers
// ---------------------------------------------------------------------------

export const EASTERN_TIMEZONE = "America/New_York";

const easternDateFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: EASTERN_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * The calendar date (YYYY-MM-DD) in America/New_York at the given instant.
 * Trading sessions are Eastern-calendar days, so all "is this report still
 * for the current/upcoming session?" comparisons must use this date — never
 * the server's local date and never a raw UTC date.
 */
export function easternCalendarDate(now: Date): string {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error("easternCalendarDate requires a valid Date.");
  }

  const parts = easternDateFormatter.formatToParts(now);
  const part = (type: "year" | "month" | "day") =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";

  return `${part("year")}-${part("month")}-${part("day")}`;
}

/**
 * Normalizes a Postgres `date` column value (Prisma returns a Date anchored
 * to UTC midnight) or a YYYY-MM-DD string to a plain YYYY-MM-DD string.
 * Returns null when the value is missing or unparseable.
 */
export function dateOnlyString(
  value: Date | string | null | undefined
): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? null
      : value.toISOString().slice(0, 10);
  }

  if (typeof value === "string") {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return value;
    }

    const parsed = isoToDate(value);
    return parsed ? parsed.toISOString().slice(0, 10) : null;
  }

  return null;
}

function toDateOrNull(value: Date | string | null | undefined): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  return typeof value === "string" ? isoToDate(value) : null;
}

export function toIsoStringOrNull(
  value: Date | string | null | undefined
): string | null {
  const date = toDateOrNull(value);
  return date ? date.toISOString() : null;
}

// ---------------------------------------------------------------------------
// Small input validators (browser-supplied values are never trusted)
// ---------------------------------------------------------------------------

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validates a browser-supplied report id before it reaches the database. */
export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export const DEFAULT_REPORT_LIST_LIMIT = 20;
export const MAX_REPORT_LIST_LIMIT = 50;

/** Clamps a browser-supplied list limit to [1, MAX_REPORT_LIST_LIMIT]. */
export function clampReportListLimit(
  raw: string | number | null | undefined
): number {
  const parsed =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && raw.trim() !== ""
        ? Number(raw)
        : Number.NaN;

  if (!Number.isFinite(parsed)) {
    return DEFAULT_REPORT_LIST_LIMIT;
  }

  return Math.min(MAX_REPORT_LIST_LIMIT, Math.max(1, Math.floor(parsed)));
}

// ---------------------------------------------------------------------------
// Expiration rule (Phase 3: conservative and simple, no holiday calendar)
// ---------------------------------------------------------------------------

export type EveningReportValidityInput = {
  status: string;
  intendedSessionDate: Date | string | null;
  expiresAt: Date | string | null;
  expiredAt: Date | string | null;
};

export type EveningReportValidity = {
  /** Server-computed. "expired" reports are history only — never current. */
  validity: "active" | "expired";
  isExpired: boolean;
  /**
   * True only when the report is active AND has an intended session date
   * that is today or later in America/New_York. A future revalidation /
   * execution phase must refuse any report where this is false.
   */
  eligibleForRevalidation: boolean;
  /** Human-readable reasons behind the computed validity. */
  validityReasons: string[];
};

/**
 * Phase 3 expiration rule, applied server-side (clients never compute this):
 * - status other than "active" (or expiredAt set) → expired.
 * - expiresAt set and now >= expiresAt → expired.
 * - intendedSessionDate before today in America/New_York → expired (the
 *   report was only ever valid for its intended session).
 * - intendedSessionDate null → NOT eligible for revalidation (kept visible
 *   as history, but no future flow may act on it).
 * - Any unparseable stored value fails closed to expired/not eligible.
 */
export function computeEveningReportValidity(
  input: EveningReportValidityInput,
  now: Date = new Date()
): EveningReportValidity {
  const reasons: string[] = [];
  let expired = false;

  if (input.status === "expired") {
    expired = true;
    reasons.push("The report is marked expired in the database.");
  } else if (input.status !== "active") {
    // Unknown status: fail closed rather than guess it might be current.
    expired = true;
    reasons.push(
      `Unrecognized report status "${input.status}" — treated as expired (fail closed).`
    );
  }

  if (input.expiredAt !== null && input.expiredAt !== undefined) {
    expired = true;
    const expiredAtIso = toIsoStringOrNull(input.expiredAt);
    reasons.push(
      expiredAtIso
        ? `The report was expired at ${expiredAtIso}.`
        : "The report has an expiredAt marker."
    );
  }

  if (input.expiresAt !== null && input.expiresAt !== undefined) {
    const expiresAt = toDateOrNull(input.expiresAt);

    if (expiresAt === null) {
      expired = true;
      reasons.push(
        "The stored expiresAt value is unparseable — treated as expired (fail closed)."
      );
    } else if (now.getTime() >= expiresAt.getTime()) {
      expired = true;
      reasons.push(`The report expired at ${expiresAt.toISOString()}.`);
    }
  }

  const todayEastern = easternCalendarDate(now);
  const sessionDate = dateOnlyString(input.intendedSessionDate);

  if (input.intendedSessionDate === null || input.intendedSessionDate === undefined) {
    reasons.push(
      "No intended session date was recorded, so this report can never be revalidated or acted on."
    );
  } else if (sessionDate === null) {
    expired = true;
    reasons.push(
      "The stored intended session date is unparseable — treated as expired (fail closed)."
    );
  } else if (sessionDate < todayEastern) {
    expired = true;
    reasons.push(
      `The intended session date ${sessionDate} is before the current America/New_York date ${todayEastern}.`
    );
  }

  return {
    validity: expired ? "expired" : "active",
    isExpired: expired,
    eligibleForRevalidation:
      !expired && sessionDate !== null && input.status === "active",
    validityReasons: reasons,
  };
}

// ---------------------------------------------------------------------------
// Row shapes (structural: satisfied by Prisma rows and by plain test
// fixtures — Decimal and Json columns arrive as `unknown` and are coerced
// explicitly so Prisma internals never leak into API responses)
// ---------------------------------------------------------------------------

export type EveningReportSummaryRow = EveningReportValidityInput & {
  id: string;
  generatedAt: Date | string;
  analysisOnly: boolean;
  ordersSubmittedCount: number;
  ordersQueuedCount: number;
  marketStatus: string;
  marketRegime: string;
  summary: string | null;
  candidates: Array<{ action: string }>;
};

export type EveningCandidateRow = {
  id: string;
  symbol: string;
  action: string;
  status: string;
  rank: number;
  confidence: unknown;
  deterministicScore: number;
  scoreComponents: unknown;
  scoreThreshold: number;
  passedScoreThreshold: boolean;
  eligibleForNewBuy: boolean;
  inclusionType: string;
  inclusionReason: string;
  blockingReasons: unknown;
  thesis: string;
  supportingFactors: unknown;
  riskFactors: unknown;
  invalidationConditions: unknown;
  proposedEntryRange: string | null;
  maximumEntryPrice: unknown;
  currentReferencePrice: unknown;
};

export type EveningReportMarketAnalysisRow = {
  asOf: Date | string;
  forceNoTrade: boolean;
  dataIssues: unknown;
  candidates: unknown;
};

export type EveningReportDetailRow = EveningReportValidityInput & {
  id: string;
  generatedAt: Date | string;
  analysisOnly: boolean;
  ordersSubmittedCount: number;
  ordersQueuedCount: number;
  safetyNotice: string;
  marketStatus: string;
  marketStatusLabel: string | null;
  marketRegime: string;
  regimeReasons: unknown;
  selectionNotice: string | null;
  summary: string | null;
  warnings: unknown;
  candidates: EveningCandidateRow[];
  marketAnalysis: EveningReportMarketAnalysisRow | null;
};

// ---------------------------------------------------------------------------
// API-safe DTOs
// ---------------------------------------------------------------------------

export type EveningReportScoreComponentsDto = {
  trend: number;
  momentum: number;
  relativeStrength: number;
  volume: number;
  risk: number;
  portfolioFit: number;
  total: number;
};

export type EveningCandidateAction = "WATCH" | "MONITOR" | "NO_TRADE";
export type EveningCandidateStatus = "watch" | "monitor" | "rejected";

export type EveningReportCandidateDto = {
  id: string;
  symbol: string;
  /** WATCH only for strict candidates; MONITOR is informational only. */
  action: EveningCandidateAction;
  status: EveningCandidateStatus;
  rank: number;
  confidence: number;
  deterministicScore: number;
  scoreComponents: EveningReportScoreComponentsDto;
  scoreThreshold: number;
  passedScoreThreshold: boolean;
  eligibleForNewBuy: boolean;
  inclusionType: string;
  inclusionReason: string;
  blockingReasons: string[];
  thesis: string;
  supportingFactors: string[];
  riskFactors: string[];
  invalidationConditions: string[];
  proposedEntryRange: string | null;
  maximumEntryPrice: number | null;
  currentReferencePrice: number | null;
  /** Latest daily-bar date available when the analysis ran, if recorded. */
  lastBarDate: string | null;
  /** Mirrors the parent report's expiry so a lone candidate stays flagged. */
  reportExpired: boolean;
  /**
   * Structural guarantee: a persisted candidate is a historical record and
   * can never be executed. Phase 4 must build any executable action from
   * live data plus the risk manager — never from this DTO.
   */
  executable: false;
  /** Notes about fail-closed remapping of unrecognized stored values. */
  mappingNotes: string[];
};

export type EveningReportSummaryDto = EveningReportValidity & {
  id: string;
  generatedAt: string;
  intendedSessionDate: string | null;
  status: string;
  analysisOnly: boolean;
  ordersSubmittedCount: number;
  ordersQueuedCount: number;
  marketStatus: string;
  marketRegime: string;
  summary: string | null;
  candidateCount: number;
  watchCount: number;
  monitorCount: number;
  noTradeCount: number;
};

export type EveningReportDataFreshnessDto = {
  /** When the deterministic market analysis snapshot was taken. */
  analysisAsOf: string | null;
  forceNoTrade: boolean | null;
  dataIssues: string[];
  /** Per-symbol latest daily-bar date recorded by the analysis. */
  lastBarDates: Record<string, string | null>;
};

export type EveningReportDetailDto = EveningReportSummaryDto & {
  expiresAt: string | null;
  expiredAt: string | null;
  safetyNotice: string;
  marketStatusLabel: string | null;
  regimeReasons: string[];
  selectionNotice: string | null;
  warnings: string[];
  dataFreshness: EveningReportDataFreshnessDto;
  candidates: EveningReportCandidateDto[];
};

// ---------------------------------------------------------------------------
// Coercers for Decimal/Json column values coming back from the database
// ---------------------------------------------------------------------------

/** Converts a Prisma Decimal / numeric string / number to a finite number. */
export function finiteNumberOrNull(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  if (
    value !== null &&
    typeof value === "object" &&
    "toNumber" in value &&
    typeof (value as { toNumber: unknown }).toNumber === "function"
  ) {
    const parsed = (value as { toNumber: () => number }).toNumber();
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

/** Keeps only string entries of a stored JSON array. */
export function stringArrayFrom(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string");
}

function scoreComponentsFrom(value: unknown): EveningReportScoreComponentsDto {
  const source =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};

  const component = (key: string) => finiteNumberOrNull(source[key]) ?? 0;

  return {
    trend: component("trend"),
    momentum: component("momentum"),
    relativeStrength: component("relativeStrength"),
    volume: component("volume"),
    risk: component("risk"),
    portfolioFit: component("portfolioFit"),
    total: component("total"),
  };
}

// ---------------------------------------------------------------------------
// Data freshness (read from the persisted market_analyses JSON — the
// existing schema already carries everything Phase 3 needs)
// ---------------------------------------------------------------------------

/**
 * Pulls per-symbol lastBarDate values out of the market_analyses.candidates
 * JSON (the persisted MarketAnalysisSummary candidates). Unknown shapes are
 * skipped, never guessed.
 */
export function extractLastBarDates(
  candidatesJson: unknown
): Record<string, string | null> {
  const lastBarDates: Record<string, string | null> = {};

  if (!Array.isArray(candidatesJson)) {
    return lastBarDates;
  }

  for (const entry of candidatesJson) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }

    const record = entry as Record<string, unknown>;

    if (typeof record.symbol !== "string" || record.symbol === "") {
      continue;
    }

    lastBarDates[record.symbol] =
      typeof record.lastBarDate === "string" ? record.lastBarDate : null;
  }

  return lastBarDates;
}

export function extractDataFreshness(
  marketAnalysis: EveningReportMarketAnalysisRow | null
): EveningReportDataFreshnessDto {
  if (!marketAnalysis) {
    return {
      analysisAsOf: null,
      forceNoTrade: null,
      dataIssues: [],
      lastBarDates: {},
    };
  }

  return {
    analysisAsOf: toIsoStringOrNull(marketAnalysis.asOf),
    forceNoTrade: marketAnalysis.forceNoTrade,
    dataIssues: stringArrayFrom(marketAnalysis.dataIssues),
    lastBarDates: extractLastBarDates(marketAnalysis.candidates),
  };
}

// ---------------------------------------------------------------------------
// Row → DTO mapping
// ---------------------------------------------------------------------------

const CANDIDATE_ACTIONS: readonly string[] = ["WATCH", "MONITOR", "NO_TRADE"];
const CANDIDATE_STATUSES: readonly string[] = ["watch", "monitor", "rejected"];

function countCandidateActions(actions: string[]): {
  watchCount: number;
  monitorCount: number;
  noTradeCount: number;
} {
  let watchCount = 0;
  let monitorCount = 0;
  let noTradeCount = 0;

  for (const action of actions) {
    if (action === "WATCH") {
      watchCount += 1;
    } else if (action === "MONITOR") {
      monitorCount += 1;
    } else {
      // NO_TRADE and anything unrecognized both count as not tradable.
      noTradeCount += 1;
    }
  }

  return { watchCount, monitorCount, noTradeCount };
}

export function mapEveningCandidateRowToDto(
  row: EveningCandidateRow,
  context: {
    lastBarDates: Record<string, string | null>;
    reportExpired: boolean;
  }
): EveningReportCandidateDto {
  const mappingNotes: string[] = [];

  let action: EveningCandidateAction;

  if (CANDIDATE_ACTIONS.includes(row.action)) {
    action = row.action as EveningCandidateAction;
  } else {
    action = "NO_TRADE";
    mappingNotes.push(
      `Stored action "${row.action}" is not recognized; displayed fail-closed as NO_TRADE.`
    );
  }

  let status: EveningCandidateStatus;

  if (CANDIDATE_STATUSES.includes(row.status)) {
    status = row.status as EveningCandidateStatus;
  } else {
    status = "rejected";
    mappingNotes.push(
      `Stored status "${row.status}" is not recognized; displayed fail-closed as rejected.`
    );
  }

  return {
    id: row.id,
    symbol: row.symbol,
    action,
    status,
    rank: row.rank,
    confidence: finiteNumberOrNull(row.confidence) ?? 0,
    deterministicScore: row.deterministicScore,
    scoreComponents: scoreComponentsFrom(row.scoreComponents),
    scoreThreshold: row.scoreThreshold,
    passedScoreThreshold: row.passedScoreThreshold,
    eligibleForNewBuy: row.eligibleForNewBuy,
    inclusionType: row.inclusionType,
    inclusionReason: row.inclusionReason,
    blockingReasons: stringArrayFrom(row.blockingReasons),
    thesis: row.thesis,
    supportingFactors: stringArrayFrom(row.supportingFactors),
    riskFactors: stringArrayFrom(row.riskFactors),
    invalidationConditions: stringArrayFrom(row.invalidationConditions),
    proposedEntryRange: row.proposedEntryRange,
    maximumEntryPrice: finiteNumberOrNull(row.maximumEntryPrice),
    currentReferencePrice: finiteNumberOrNull(row.currentReferencePrice),
    lastBarDate: context.lastBarDates[row.symbol] ?? null,
    reportExpired: context.reportExpired,
    executable: false,
    mappingNotes,
  };
}

export function mapEveningReportRowToSummaryDto(
  row: EveningReportSummaryRow,
  now: Date = new Date()
): EveningReportSummaryDto {
  const validity = computeEveningReportValidity(row, now);
  const counts = countCandidateActions(
    row.candidates.map((candidate) => candidate.action)
  );

  return {
    ...validity,
    id: row.id,
    generatedAt: toIsoStringOrNull(row.generatedAt) ?? String(row.generatedAt),
    intendedSessionDate: dateOnlyString(row.intendedSessionDate),
    status: row.status,
    analysisOnly: row.analysisOnly,
    ordersSubmittedCount: row.ordersSubmittedCount,
    ordersQueuedCount: row.ordersQueuedCount,
    marketStatus: row.marketStatus,
    marketRegime: row.marketRegime,
    summary: row.summary,
    candidateCount: row.candidates.length,
    ...counts,
  };
}

export function mapEveningReportRowToDetailDto(
  row: EveningReportDetailRow,
  now: Date = new Date()
): EveningReportDetailDto {
  const validity = computeEveningReportValidity(row, now);
  const dataFreshness = extractDataFreshness(row.marketAnalysis);

  const candidates = row.candidates.map((candidate) =>
    mapEveningCandidateRowToDto(candidate, {
      lastBarDates: dataFreshness.lastBarDates,
      reportExpired: validity.isExpired,
    })
  );

  const counts = countCandidateActions(
    candidates.map((candidate) => candidate.action)
  );

  return {
    ...validity,
    id: row.id,
    generatedAt: toIsoStringOrNull(row.generatedAt) ?? String(row.generatedAt),
    intendedSessionDate: dateOnlyString(row.intendedSessionDate),
    status: row.status,
    analysisOnly: row.analysisOnly,
    ordersSubmittedCount: row.ordersSubmittedCount,
    ordersQueuedCount: row.ordersQueuedCount,
    marketStatus: row.marketStatus,
    marketRegime: row.marketRegime,
    summary: row.summary,
    candidateCount: candidates.length,
    ...counts,
    expiresAt: toIsoStringOrNull(row.expiresAt),
    expiredAt: toIsoStringOrNull(row.expiredAt),
    safetyNotice: row.safetyNotice,
    marketStatusLabel: row.marketStatusLabel,
    regimeReasons: stringArrayFrom(row.regimeReasons),
    selectionNotice: row.selectionNotice,
    warnings: stringArrayFrom(row.warnings),
    dataFreshness,
    candidates,
  };
}
