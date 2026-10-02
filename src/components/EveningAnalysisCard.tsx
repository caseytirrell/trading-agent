"use client";

import { useState } from "react";
import EveningAnalysisHistory from "@/components/EveningAnalysisHistory";

// Evening Analysis card: manual, informational next-session watchlist.
// This component can never place, queue, cancel, replace, or modify an
// order — it only POSTs to the read-only evening-analysis route on click
// and renders the result. No auto-fetch, no polling, no timers. The server
// stores each run as read-only history (Phase 2); the live result here is
// kept only in React state, and the embedded EveningAnalysisHistory browser
// (Phase 3) reads saved reports back — read-only, clearly labeled active vs
// expired, with no order path.
//
// Candidates come in two flavors and are never mixed up: strict candidates
// (passed every new-buy filter and the score threshold; may be WATCH) and
// informational fallbacks (near misses, held positions, blocked symbols;
// capped at MONITOR and clearly labeled as not eligible for a new buy).

type EveningInclusionTypeDisplay =
  | "STRICT_WATCH"
  | "NEAR_MISS"
  | "HELD_MONITOR"
  | "BLOCKED_MONITOR";

type ScoreComponentsDisplay = {
  trend: number;
  momentum: number;
  relativeStrength: number;
  volume: number;
  risk: number;
  portfolioFit: number;
  total: number;
};

type EveningCandidateDisplay = {
  symbol: string;
  action: "WATCH" | "MONITOR" | "NO_TRADE";
  status: "watch" | "monitor" | "rejected";
  rank: number;
  confidence: number;
  deterministicScore: number;
  scoreComponents: ScoreComponentsDisplay;
  scoreThreshold: number;
  passedScoreThreshold: boolean;
  eligibleForNewBuy: boolean;
  inclusionType: EveningInclusionTypeDisplay;
  inclusionReason: string;
  blockingReasons: string[];
  thesis: string;
  supportingFactors: string[];
  riskFactors: string[];
  invalidationConditions: string[];
  proposedEntryRange: string | null;
  maximumEntryPrice: number | null;
  currentReferencePrice: number | null;
};

type MarketDiagnosticsDisplay = {
  asOf: string;
  regime: string;
  regimeReasons: string[];
  forceNoTrade: boolean;
  dataIssues: string[];
  minBuyScore: number;
  candidates: Array<{
    symbol: string;
    eligible: boolean;
    totalScore: number;
    passedScoreThreshold: boolean;
    rejectionReasons: string[];
    scores: ScoreComponentsDisplay;
    latestPrice: number | null;
    lastBarDate: string | null;
  }>;
};

type EveningResultDisplay = {
  analysisOnly: boolean;
  ordersSubmitted: number;
  ordersQueued: number;
  safetyNotice: string;
  generatedAt: string;
  intendedSessionDate: string | null;
  marketStatus: "open" | "closed";
  marketStatusLabel: string;
  marketRegime: string;
  regimeReasons: string[];
  selectionNotice?: string;
  summary: string;
  warnings: string[];
  candidates: EveningCandidateDisplay[];
  marketAnalysis?: MarketDiagnosticsDisplay;
};

type EveningAnalysisResponse = {
  success: boolean;
  analysisOnly?: boolean;
  ordersSubmitted?: number;
  ordersQueued?: number;
  result?: EveningResultDisplay;
  error?: string;
  timestamp?: string;
};

const actionStyles: Record<EveningCandidateDisplay["action"], string> = {
  WATCH: "bg-amber-950 text-amber-300",
  MONITOR: "bg-sky-950 text-sky-300",
  NO_TRADE: "bg-neutral-800 text-neutral-300",
};

const actionLabels: Record<EveningCandidateDisplay["action"], string> = {
  WATCH: "WATCH",
  MONITOR: "MONITOR",
  NO_TRADE: "NO TRADE",
};

const inclusionBadges: Record<
  EveningInclusionTypeDisplay,
  { label: string; className: string }
> = {
  STRICT_WATCH: {
    label: "Strict candidate",
    className: "bg-green-950 text-green-300",
  },
  NEAR_MISS: {
    label: "Near miss — below buy threshold",
    className: "bg-yellow-950 text-yellow-300",
  },
  HELD_MONITOR: {
    label: "Already held — not eligible to add",
    className: "bg-purple-950 text-purple-300",
  },
  BLOCKED_MONITOR: {
    label: "Blocked from new buy",
    className: "bg-red-950 text-red-300",
  },
};

const regimeLabels: Record<string, string> = {
  bullish: "Bullish",
  neutral: "Neutral",
  bearish_unstable: "Bearish / unstable",
};

function formatPrice(value: number | null): string | null {
  return value === null
    ? null
    : `$${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function formatComponents(scores: ScoreComponentsDisplay): string {
  return `Trend ${scores.trend}/20 · Momentum ${scores.momentum}/20 · Rel. strength ${scores.relativeStrength}/15 · Volume ${scores.volume}/10 · Calmness ${scores.risk}/20 · Portfolio fit ${scores.portfolioFit}/15`;
}

function FactorList({
  title,
  items,
  tone,
}: {
  title: string;
  items: string[];
  tone: string;
}) {
  if (items.length === 0) {
    return null;
  }

  return (
    <div className="mt-3">
      <p className={`text-xs font-semibold uppercase tracking-wide ${tone}`}>
        {title}
      </p>
      <ul className="mt-1 list-inside list-disc text-sm text-neutral-300">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

export default function EveningAnalysisCard() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<EveningResultDisplay | null>(null);

  async function runEveningAnalysis() {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/agent/evening-analysis", {
        method: "POST",
        cache: "no-store",
      });

      let data: EveningAnalysisResponse;

      try {
        data = await response.json();
      } catch {
        throw new Error("The server returned an invalid response.");
      }

      if (!response.ok || !data.success) {
        throw new Error(
          data.error || "The evening analysis request failed. Please try again."
        );
      }

      // Client-side guard: only render payloads that explicitly declare
      // the analysis-only, zero-order contract.
      if (
        !data.result ||
        data.result.analysisOnly !== true ||
        data.result.ordersSubmitted !== 0
      ) {
        throw new Error(
          "The server returned an unexpected evening analysis payload."
        );
      }

      setResult(data.result);
    } catch (err) {
      setResult(null);
      setError(
        err instanceof Error
          ? err.message
          : "Something went wrong running the evening analysis."
      );
    } finally {
      setLoading(false);
    }
  }

  const watchCount =
    result?.candidates.filter((candidate) => candidate.action === "WATCH")
      .length ?? 0;
  const monitorCount =
    result?.candidates.filter((candidate) => candidate.action === "MONITOR")
      .length ?? 0;
  const strictCount =
    result?.candidates.filter(
      (candidate) => candidate.inclusionType === "STRICT_WATCH"
    ).length ?? 0;

  const diagnosticsRows = result?.marketAnalysis
    ? [...result.marketAnalysis.candidates].sort(
        (a, b) => b.totalScore - a.totalScore
      )
    : [];

  return (
    <section className="rounded-2xl border border-neutral-800 bg-neutral-900 p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-sm uppercase tracking-wide text-amber-400">
            Evening Analysis
          </p>
          <h2 className="text-2xl font-bold">Next-Session Watchlist</h2>
        </div>

        <button
          type="button"
          onClick={() => void runEveningAnalysis()}
          disabled={loading}
          className="rounded-xl bg-amber-600 px-5 py-2.5 font-semibold text-white transition hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? "Analyzing..." : "Run Evening Analysis"}
        </button>
      </div>

      {/* Analysis-only notice */}
      <div className="rounded-xl border border-amber-900 bg-amber-950/40 p-4">
        <p className="text-sm text-amber-200">
          <strong>Analysis only.</strong> This card never places, queues, or
          modifies orders — it produces an informational watchlist for the
          next trading session. WATCH marks strict candidates worth
          monitoring; MONITOR marks informational entries that are{" "}
          <em>not</em> eligible for a new buy. Each run is saved to read-only
          run history on the server, but nothing is ever queued or executed
          from it, and any idea must be revalidated against live data before
          execution.
        </p>
      </div>

      {error && (
        <div className="mt-6 rounded-xl border border-red-900 bg-red-950/40 p-4">
          <p className="font-semibold text-red-300">Evening analysis failed</p>
          <p className="mt-1 text-sm text-neutral-300">{error}</p>
        </div>
      )}

      {result && (
        // Preset card height: results scroll inside the card past this.
        <div className="mt-6 max-h-[30rem] overflow-y-auto pr-2">
          {/* Status badges */}
          <div className="flex flex-wrap items-center gap-3">
            <span className="rounded-full bg-amber-950 px-4 py-2 text-sm font-semibold text-amber-300">
              Analysis Only
            </span>
            <span className="rounded-full bg-neutral-800 px-4 py-2 text-sm font-semibold text-neutral-300">
              Market {result.marketStatus === "open" ? "open" : "closed"}
            </span>
            <span className="rounded-full bg-neutral-800 px-4 py-2 text-sm font-semibold text-neutral-300">
              Regime: {regimeLabels[result.marketRegime] ?? result.marketRegime}
            </span>
            <span className="rounded-full bg-neutral-800 px-4 py-2 text-sm font-semibold text-neutral-300">
              {watchCount} WATCH / {monitorCount} MONITOR /{" "}
              {result.candidates.length} shown
            </span>
          </div>

          {/* Run metadata */}
          <div className="mt-4 grid gap-4 md:grid-cols-3">
            <div>
              <p className="text-sm text-neutral-400">Generated</p>
              <p className="mt-1 font-semibold">
                {new Date(result.generatedAt).toLocaleString()}
              </p>
            </div>

            <div>
              <p className="text-sm text-neutral-400">Next trading session</p>
              <p className="mt-1 font-semibold">
                {result.intendedSessionDate ?? "Unknown"}
              </p>
            </div>

            <div>
              <p className="text-sm text-neutral-400">Market status</p>
              <p className="mt-1 text-sm text-neutral-200">
                {result.marketStatusLabel}
              </p>
            </div>
          </div>

          {/* Summary */}
          <div className="mt-6">
            <p className="text-sm text-neutral-400">Summary</p>
            <p className="mt-1 text-neutral-200">{result.summary}</p>
            {result.selectionNotice && (
              <p className="mt-2 rounded-lg border border-sky-900/60 bg-sky-950/30 p-2 text-sm text-sky-200">
                {result.selectionNotice}
              </p>
            )}
            {result.regimeReasons.length > 0 && (
              <p className="mt-2 text-xs text-neutral-500">
                Regime basis: {result.regimeReasons.join(" ")}
              </p>
            )}
          </div>

          {/* Warnings */}
          {result.warnings.length > 0 && (
            <div className="mt-4 rounded-xl border border-yellow-900 bg-yellow-950/40 p-4">
              <p className="font-semibold text-yellow-300">Warnings</p>
              <ul className="mt-2 list-inside list-disc text-sm text-neutral-300">
                {result.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Candidates */}
          {result.candidates.length === 0 ? (
            <p className="mt-6 text-neutral-400">
              No candidates to show for the next session — see the
              approved-universe diagnostics below for every symbol&apos;s
              score and blockers.
            </p>
          ) : (
            <ul className="mt-6 space-y-4">
              {result.candidates.map((candidate) => (
                <li
                  key={candidate.symbol}
                  className="rounded-xl border border-neutral-800 bg-neutral-950/60 p-4"
                >
                  {/* Collapsible details keep the list compact; the badge
                      row, thesis, and inclusion label stay visible when
                      collapsed. */}
                  <details className="group">
                    <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
                      <div className="flex flex-wrap items-center gap-3">
                        <span className="text-sm text-neutral-500">
                          #{candidate.rank}
                        </span>
                        <span className="text-lg font-semibold text-white">
                          {candidate.symbol}
                        </span>
                        <span
                          className={`rounded-full px-3 py-1 text-xs font-semibold ${actionStyles[candidate.action]}`}
                        >
                          {actionLabels[candidate.action]}
                        </span>
                        <span
                          className={`rounded-full px-3 py-1 text-xs font-semibold ${inclusionBadges[candidate.inclusionType]?.className ?? "bg-neutral-800 text-neutral-300"}`}
                        >
                          {inclusionBadges[candidate.inclusionType]?.label ??
                            candidate.inclusionType}
                        </span>
                        <span className="rounded-full bg-neutral-800 px-3 py-1 text-xs font-semibold text-neutral-300">
                          Confidence {Math.round(candidate.confidence * 100)}%
                        </span>
                        <span
                          className={`rounded-full px-3 py-1 text-xs font-semibold ${
                            candidate.passedScoreThreshold
                              ? "bg-green-950 text-green-300"
                              : "bg-neutral-800 text-neutral-400"
                          }`}
                        >
                          Score {candidate.deterministicScore}/100{" "}
                          {candidate.passedScoreThreshold ? "≥" : "<"}{" "}
                          {candidate.scoreThreshold}
                        </span>
                        <span className="ml-auto text-xs text-neutral-500 group-open:hidden">
                          Show details ▸
                        </span>
                        <span className="ml-auto hidden text-xs text-neutral-500 group-open:inline">
                          Hide details ▾
                        </span>
                      </div>

                      <p className="mt-3 text-sm text-neutral-200">
                        {candidate.thesis}
                      </p>

                      <p className="mt-2 text-xs text-neutral-400">
                        {candidate.inclusionReason}
                      </p>
                    </summary>

                    {(candidate.currentReferencePrice !== null ||
                      candidate.proposedEntryRange !== null ||
                      candidate.maximumEntryPrice !== null) && (
                      <p className="mt-2 text-xs text-neutral-400">
                        {candidate.currentReferencePrice !== null && (
                          <>
                            Last close{" "}
                            {formatPrice(candidate.currentReferencePrice)}.{" "}
                          </>
                        )}
                        {candidate.proposedEntryRange !== null && (
                          <>Proposed entry: {candidate.proposedEntryRange}. </>
                        )}
                        {candidate.maximumEntryPrice !== null && (
                          <>
                            Max entry{" "}
                            {formatPrice(candidate.maximumEntryPrice)}.
                          </>
                        )}
                      </p>
                    )}

                    <p className="mt-2 text-xs text-neutral-500">
                      {formatComponents(candidate.scoreComponents)}
                    </p>

                    {candidate.blockingReasons.length > 0 && (
                      <FactorList
                        title="Blocked from a new buy because"
                        items={candidate.blockingReasons}
                        tone="text-red-400"
                      />
                    )}

                    <div className="grid gap-x-4 md:grid-cols-3">
                      <FactorList
                        title="Supporting factors"
                        items={candidate.supportingFactors}
                        tone="text-green-400"
                      />
                      <FactorList
                        title="Risk factors"
                        items={candidate.riskFactors}
                        tone="text-red-400"
                      />
                      <FactorList
                        title="Invalidation conditions"
                        items={candidate.invalidationConditions}
                        tone="text-yellow-400"
                      />
                    </div>
                  </details>
                </li>
              ))}
            </ul>
          )}

          {/* Approved-universe diagnostics: why each symbol passed, nearly
              passed, or is blocked. Opens automatically when no strict
              candidate exists so an empty/informational list is explained. */}
          {result.marketAnalysis &&
            result.marketAnalysis.candidates.length > 0 && (
              <details
                className="mt-6 rounded-xl border border-neutral-800 bg-neutral-950/60 p-4"
                open={strictCount === 0}
              >
                <summary className="cursor-pointer text-sm font-semibold text-neutral-200">
                  Approved-universe diagnostics (
                  {result.marketAnalysis.candidates.length} symbols · buy
                  threshold {result.marketAnalysis.minBuyScore})
                </summary>

                <div className="mt-3 overflow-x-auto">
                  <table className="w-full min-w-[44rem] text-left text-xs">
                    <thead>
                      <tr className="border-b border-neutral-800 text-neutral-500">
                        <th className="py-2 pr-3 font-medium">Symbol</th>
                        <th className="py-2 pr-3 font-medium">Score</th>
                        <th className="py-2 pr-3 font-medium">
                          ≥ {result.marketAnalysis.minBuyScore}
                        </th>
                        <th className="py-2 pr-3 font-medium">Eligible</th>
                        <th className="py-2 pr-3 font-medium">Last close</th>
                        <th className="py-2 pr-3 font-medium">
                          T / M / RS / V / C / F
                        </th>
                        <th className="py-2 font-medium">Blockers</th>
                      </tr>
                    </thead>
                    <tbody>
                      {diagnosticsRows.map((row) => (
                        <tr
                          key={row.symbol}
                          className="border-b border-neutral-900 align-top"
                        >
                          <td className="py-2 pr-3 font-semibold text-neutral-200">
                            {row.symbol}
                          </td>
                          <td className="py-2 pr-3 text-neutral-300">
                            {row.totalScore}
                          </td>
                          <td
                            className={`py-2 pr-3 ${row.passedScoreThreshold ? "text-green-400" : "text-neutral-500"}`}
                          >
                            {row.passedScoreThreshold ? "Yes" : "No"}
                          </td>
                          <td
                            className={`py-2 pr-3 ${row.eligible ? "text-green-400" : "text-neutral-500"}`}
                          >
                            {row.eligible ? "Yes" : "No"}
                          </td>
                          <td className="py-2 pr-3 text-neutral-300">
                            {formatPrice(row.latestPrice) ?? "—"}
                          </td>
                          <td className="py-2 pr-3 text-neutral-400">
                            {row.scores.trend} / {row.scores.momentum} /{" "}
                            {row.scores.relativeStrength} / {row.scores.volume}{" "}
                            / {row.scores.risk} / {row.scores.portfolioFit}
                          </td>
                          <td className="py-2 text-neutral-400">
                            {row.rejectionReasons.length > 0
                              ? row.rejectionReasons.join(" ")
                              : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <p className="mt-2 text-xs text-neutral-500">
                  Components: Trend /20 · Momentum /20 · Rel. strength (RS)
                  /15 · Volume /10 · Calmness (C) /20 · Portfolio fit (F) /15.
                  Data as of{" "}
                  {new Date(result.marketAnalysis.asOf).toLocaleString()}.
                </p>
              </details>
            )}

          {/* Explicit no-order confirmation */}
          <div className="mt-6 rounded-xl border border-green-900 bg-green-950/40 p-4 text-sm">
            <p className="font-semibold text-green-300">
              No order was placed or queued
            </p>
            <p className="mt-1 text-neutral-300">{result.safetyNotice}</p>
          </div>
        </div>
      )}

      {!result && !error && !loading && (
        <p className="mt-6 text-neutral-500">
          No evening analysis run yet. Click the button to build an
          informational watchlist for the next trading session.
        </p>
      )}

      {/* Saved report history (Phase 3): read-only records served from the
          database. Loading or viewing history never re-runs an analysis and
          has no order path. */}
      <EveningAnalysisHistory />
    </section>
  );
}
