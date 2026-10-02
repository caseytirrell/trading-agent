import type { EveningAnalysisCandidate } from "@/lib/evening-analysis";

// Pure serialization and row-mapping helpers for the persistence layer.
// No Prisma, server-only, or environment access here: everything is
// deterministic data transformation, unit-testable in isolation.

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** JSON stored into a NOT NULL jsonb column (top-level null is excluded). */
export type StoredJson = Exclude<JsonValue, null>;

/**
 * Deep-converts arbitrary app data into plain JSON: Dates become ISO strings,
 * undefined properties are stripped, NaN/Infinity become null. Returns the
 * fallback when the value is missing, serializes to null/undefined, or cannot
 * be serialized (cycles, BigInt) — the jsonb columns here are NOT NULL.
 */
export function toJsonValue(value: unknown, fallback: StoredJson): StoredJson {
  if (value === undefined || value === null) {
    return fallback;
  }

  try {
    const text = JSON.stringify(value);

    if (text === undefined) {
      return fallback;
    }

    const parsed = JSON.parse(text) as JsonValue;
    return parsed === null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

/** Parses an ISO timestamp into a Date; null when missing or invalid. */
export function isoToDate(value: string | null | undefined): Date | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }

  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms);
}

/**
 * Converts a YYYY-MM-DD calendar date into a Date for a Postgres `date`
 * column. Anchoring to UTC midnight keeps the stored day identical to the
 * string regardless of the server's timezone.
 */
export function dateOnlyToDate(value: string | null | undefined): Date | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }

  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Validates a numeric value destined for a Decimal column. Alpaca reports
 * quantities and prices as strings; passing the validated string through to
 * Prisma preserves the exact decimal representation. Non-finite values
 * become null instead of corrupting the row.
 */
export function decimalOrNull(
  value: string | number | null | undefined
): string | number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (
    typeof value === "string" &&
    value.trim().length > 0 &&
    Number.isFinite(Number(value))
  ) {
    return value;
  }

  return null;
}

/** Clamps an AI confidence to [0, 1] for the numeric(5,4) columns. */
export function clampedConfidence(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.min(1, Math.max(0, value));
}

export function truncateText(value: string, maxLength: number): string {
  return value.length <= maxLength
    ? value
    : `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

/** Compact, length-bounded message for error_message/text columns. */
export function errorToMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return truncateText(message, 500);
}

/**
 * Maps Evening Analysis candidates onto evening_analysis_candidates rows
 * (camelCase Prisma field names; Prisma maps them to snake_case columns).
 * Pure data mapping — persisting these rows never queues or places anything.
 */
export function buildEveningCandidateRows(
  candidates: EveningAnalysisCandidate[]
) {
  return candidates.map((candidate) => ({
    symbol: candidate.symbol,
    action: candidate.action,
    status: candidate.status,
    rank: candidate.rank,
    confidence: clampedConfidence(candidate.confidence),
    deterministicScore: candidate.deterministicScore,
    scoreComponents: toJsonValue(candidate.scoreComponents, {}),
    scoreThreshold: candidate.scoreThreshold,
    passedScoreThreshold: candidate.passedScoreThreshold,
    eligibleForNewBuy: candidate.eligibleForNewBuy,
    inclusionType: candidate.inclusionType,
    inclusionReason: candidate.inclusionReason,
    blockingReasons: toJsonValue(candidate.blockingReasons, []),
    thesis: candidate.thesis,
    supportingFactors: toJsonValue(candidate.supportingFactors, []),
    riskFactors: toJsonValue(candidate.riskFactors, []),
    invalidationConditions: toJsonValue(candidate.invalidationConditions, []),
    proposedEntryRange: candidate.proposedEntryRange,
    maximumEntryPrice: decimalOrNull(candidate.maximumEntryPrice),
    currentReferencePrice: decimalOrNull(candidate.currentReferencePrice),
  }));
}
