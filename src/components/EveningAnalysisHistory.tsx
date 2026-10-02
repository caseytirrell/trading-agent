"use client";

import { useState } from "react";
import type {
  EveningReportDetailDto,
  EveningReportSummaryDto,
} from "@/lib/evening-report-history";

// Saved Evening Analysis history (Phase 3): a read-only browser over the
// reports the server persisted. Loading or viewing history only issues GET
// requests to the read-only reports endpoints — it never re-runs an
// analysis, never contacts OpenAI or Alpaca, and can never place, queue,
// cancel, replace, or modify an order. Fetches are manual (button clicks):
// no auto-fetch, no polling, no timers.
//
// Validity (active vs expired vs never-revalidatable) is computed by the
// server and only displayed here — this component makes no safety decisions.
// The type-only import above is erased at build time; no database code is
// ever bundled into the client.

type ReportsListResponse = {
  success: boolean;
  readOnly?: boolean;
  historyAvailable?: boolean;
  reports?: EveningReportSummaryDto[];
  notice?: string;
  error?: string;
};

type ReportDetailResponse = {
  success: boolean;
  readOnly?: boolean;
  analysisOnly?: boolean;
  ordersSubmitted?: number;
  ordersQueued?: number;
  report?: EveningReportDetailDto;
  error?: string;
};

const actionStyles: Record<string, string> = {
  WATCH: "bg-amber-950 text-amber-300",
  MONITOR: "bg-sky-950 text-sky-300",
  NO_TRADE: "bg-neutral-800 text-neutral-300",
};

const actionLabels: Record<string, string> = {
  WATCH: "WATCH",
  MONITOR: "MONITOR",
  NO_TRADE: "NO TRADE",
};

const inclusionLabels: Record<string, string> = {
  STRICT_WATCH: "Strict candidate",
  NEAR_MISS: "Near miss — below buy threshold",
  HELD_MONITOR: "Already held — not eligible to add",
  BLOCKED_MONITOR: "Blocked from new buy",
};

const regimeLabels: Record<string, string> = {
  bullish: "Bullish",
  neutral: "Neutral",
  bearish_unstable: "Bearish / unstable",
};

function validityBadge(report: {
  validity: "active" | "expired";
  eligibleForRevalidation: boolean;
}): { label: string; className: string } {
  if (report.validity === "expired") {
    return {
      label: "Expired — history only",
      className: "bg-neutral-800 text-neutral-400",
    };
  }

  if (!report.eligibleForRevalidation) {
    return {
      label: "Active — not revalidatable",
      className: "bg-yellow-950 text-yellow-300",
    };
  }

  return { label: "Active", className: "bg-green-950 text-green-300" };
}

function formatPrice(value: number | null): string | null {
  return value === null
    ? null
    : `$${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function formatDateTime(value: string | null): string {
  if (!value) {
    return "Unknown";
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function formatBarDate(value: string | null): string {
  if (!value) {
    return "unknown";
  }

  // Daily bars carry a session date; the leading YYYY-MM-DD is the part
  // that matters for freshness display.
  return value.length >= 10 ? value.slice(0, 10) : value;
}

function HistoryFactorList({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) {
    return null;
  }

  return (
    <div className="mt-2">
      <p className="text-xs font-semibold uppercase tracking-wide text-neutral-400">
        {title}
      </p>
      <ul className="mt-1 list-inside list-disc text-xs text-neutral-300">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

export default function EveningAnalysisHistory() {
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reports, setReports] = useState<EveningReportSummaryDto[]>([]);
  const [detail, setDetail] = useState<EveningReportDetailDto | null>(null);
  const [detailLoadingId, setDetailLoadingId] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  async function loadHistory() {
    setLoading(true);
    setError(null);
    setNotice(null);

    try {
      const response = await fetch("/api/agent/evening-analysis/reports", {
        method: "GET",
        cache: "no-store",
      });

      let data: ReportsListResponse;

      try {
        data = await response.json();
      } catch {
        throw new Error("The server returned an invalid history response.");
      }

      if (!response.ok || !data.success) {
        throw new Error(
          data.error || "Loading saved reports failed. Please try again."
        );
      }

      setReports(Array.isArray(data.reports) ? data.reports : []);
      setNotice(data.notice ?? null);
      setLoaded(true);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Something went wrong loading saved reports."
      );
    } finally {
      setLoading(false);
    }
  }

  async function viewReport(reportId: string) {
    setDetailLoadingId(reportId);
    setDetailError(null);

    try {
      const response = await fetch(
        `/api/agent/evening-analysis/reports/${encodeURIComponent(reportId)}`,
        { method: "GET", cache: "no-store" }
      );

      let data: ReportDetailResponse;

      try {
        data = await response.json();
      } catch {
        throw new Error("The server returned an invalid report response.");
      }

      if (!response.ok || !data.success) {
        throw new Error(
          data.error || "Loading the saved report failed. Please try again."
        );
      }

      // Client-side guard: only render payloads that explicitly declare the
      // read-only, analysis-only, zero-order history contract.
      if (
        !data.report ||
        data.readOnly !== true ||
        data.analysisOnly !== true ||
        data.ordersSubmitted !== 0
      ) {
        throw new Error("The server returned an unexpected report payload.");
      }

      setDetail(data.report);
    } catch (err) {
      setDetail(null);
      setDetailError(
        err instanceof Error
          ? err.message
          : "Something went wrong loading the saved report."
      );
    } finally {
      setDetailLoadingId(null);
    }
  }

  const detailBadge = detail ? validityBadge(detail) : null;

  return (
    <div className="mt-6 rounded-xl border border-neutral-800 bg-neutral-950/60 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-neutral-200">
            Saved reports
          </p>
          <p className="text-xs text-neutral-500">
            Read-only records of past runs — viewing them never re-runs
            analysis and has no order path.
          </p>
        </div>

        <button
          type="button"
          onClick={() => void loadHistory()}
          disabled={loading}
          className="rounded-lg border border-neutral-700 bg-neutral-900 px-4 py-2 text-sm font-semibold text-neutral-200 transition hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading
            ? "Loading..."
            : loaded
              ? "Refresh saved reports"
              : "Load saved reports"}
        </button>
      </div>

      {error && (
        <div className="mt-4 rounded-lg border border-red-900 bg-red-950/40 p-3">
          <p className="text-sm text-red-300">{error}</p>
        </div>
      )}

      {notice && <p className="mt-4 text-sm text-neutral-400">{notice}</p>}

      {loaded && !error && reports.length === 0 && !notice && (
        <p className="mt-4 text-sm text-neutral-500">
          No saved Evening Analysis reports yet. Run an evening analysis and
          it will be stored here automatically.
        </p>
      )}

      {reports.length > 0 && (
        <ul className="mt-4 max-h-64 space-y-2 overflow-y-auto pr-1">
          {reports.map((report) => {
            const badge = validityBadge(report);
            const isOpen = detail?.id === report.id;

            return (
              <li
                key={report.id}
                className="rounded-lg border border-neutral-800 bg-neutral-900/70 p-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-neutral-100">
                    {report.intendedSessionDate
                      ? `Session ${report.intendedSessionDate}`
                      : "Session unknown"}
                  </span>
                  <span
                    className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${badge.className}`}
                  >
                    {badge.label}
                  </span>
                  <span className="rounded-full bg-neutral-800 px-2.5 py-0.5 text-xs text-neutral-300">
                    {report.watchCount} WATCH · {report.monitorCount} MONITOR ·{" "}
                    {report.noTradeCount} NO TRADE
                  </span>
                  <span className="rounded-full bg-neutral-800 px-2.5 py-0.5 text-xs text-neutral-400">
                    {regimeLabels[report.marketRegime] ?? report.marketRegime}
                  </span>

                  <button
                    type="button"
                    onClick={() =>
                      isOpen ? setDetail(null) : void viewReport(report.id)
                    }
                    disabled={detailLoadingId === report.id}
                    className="ml-auto rounded-lg border border-neutral-700 px-3 py-1 text-xs font-semibold text-neutral-300 transition hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {detailLoadingId === report.id
                      ? "Loading..."
                      : isOpen
                        ? "Hide"
                        : "View"}
                  </button>
                </div>

                <p className="mt-1 text-xs text-neutral-500">
                  Generated {formatDateTime(report.generatedAt)}
                </p>
              </li>
            );
          })}
        </ul>
      )}

      {detailError && (
        <div className="mt-4 rounded-lg border border-red-900 bg-red-950/40 p-3">
          <p className="text-sm text-red-300">{detailError}</p>
        </div>
      )}

      {detail && detailBadge && (
        <div className="mt-4 max-h-[26rem] overflow-y-auto rounded-lg border border-neutral-800 bg-neutral-900/80 p-4 pr-3">
          {/* Read-only record banner */}
          <div className="rounded-lg border border-sky-900/60 bg-sky-950/30 p-3">
            <p className="text-sm font-semibold text-sky-200">
              Read-only historical record
            </p>
            <p className="mt-1 text-xs text-neutral-300">
              This report shows what the analysis said when it was generated.
              Prices, scores, and eligibility were valid only at that moment.
              Nothing can be executed, queued, or revalidated from this view.
            </p>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span
              className={`rounded-full px-3 py-1 text-xs font-semibold ${detailBadge.className}`}
            >
              {detailBadge.label}
            </span>
            <span className="rounded-full bg-amber-950 px-3 py-1 text-xs font-semibold text-amber-300">
              Analysis only
            </span>
            <span className="rounded-full bg-neutral-800 px-3 py-1 text-xs text-neutral-300">
              Orders submitted: {detail.ordersSubmittedCount} · queued:{" "}
              {detail.ordersQueuedCount}
            </span>
            <span className="rounded-full bg-neutral-800 px-3 py-1 text-xs text-neutral-300">
              {regimeLabels[detail.marketRegime] ?? detail.marketRegime}
            </span>
          </div>

          {detail.validityReasons.length > 0 && (
            <ul className="mt-3 list-inside list-disc text-xs text-neutral-400">
              {detail.validityReasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}

          <div className="mt-3 grid gap-3 text-sm md:grid-cols-3">
            <div>
              <p className="text-xs text-neutral-500">Generated</p>
              <p className="mt-0.5 text-neutral-200">
                {formatDateTime(detail.generatedAt)}
              </p>
            </div>
            <div>
              <p className="text-xs text-neutral-500">Intended session</p>
              <p className="mt-0.5 text-neutral-200">
                {detail.intendedSessionDate ?? "Unknown"}
              </p>
            </div>
            <div>
              <p className="text-xs text-neutral-500">Analysis data as of</p>
              <p className="mt-0.5 text-neutral-200">
                {formatDateTime(detail.dataFreshness.analysisAsOf)}
              </p>
            </div>
          </div>

          {detail.summary && (
            <p className="mt-3 text-sm text-neutral-200">{detail.summary}</p>
          )}

          {detail.selectionNotice && (
            <p className="mt-2 text-xs text-neutral-400">
              {detail.selectionNotice}
            </p>
          )}

          {(detail.warnings.length > 0 ||
            detail.dataFreshness.dataIssues.length > 0 ||
            detail.dataFreshness.forceNoTrade === true) && (
            <div className="mt-3 rounded-lg border border-yellow-900 bg-yellow-950/40 p-3">
              <p className="text-xs font-semibold text-yellow-300">
                Warnings and data issues at generation time
              </p>
              <ul className="mt-1 list-inside list-disc text-xs text-neutral-300">
                {detail.dataFreshness.forceNoTrade === true && (
                  <li>
                    The deterministic analysis forced NO TRADE because market
                    data failed validation.
                  </li>
                )}
                {detail.warnings.map((warning) => (
                  <li key={`warning-${warning}`}>{warning}</li>
                ))}
                {detail.dataFreshness.dataIssues.map((issue) => (
                  <li key={`issue-${issue}`}>{issue}</li>
                ))}
              </ul>
            </div>
          )}

          {detail.candidates.length === 0 ? (
            <p className="mt-4 text-sm text-neutral-500">
              This report recorded no candidates.
            </p>
          ) : (
            <ul className="mt-4 space-y-3">
              {detail.candidates.map((candidate) => (
                <li
                  key={candidate.id}
                  className="rounded-lg border border-neutral-800 bg-neutral-950/60 p-3"
                >
                  <details>
                    <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs text-neutral-500">
                          #{candidate.rank}
                        </span>
                        <span className="text-sm font-semibold text-white">
                          {candidate.symbol}
                        </span>
                        <span
                          className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${actionStyles[candidate.action] ?? actionStyles.NO_TRADE}`}
                        >
                          {actionLabels[candidate.action] ?? candidate.action}
                        </span>
                        <span className="rounded-full bg-neutral-800 px-2.5 py-0.5 text-xs text-neutral-300">
                          {inclusionLabels[candidate.inclusionType] ??
                            candidate.inclusionType}
                        </span>
                        <span className="rounded-full bg-neutral-800 px-2.5 py-0.5 text-xs text-neutral-400">
                          Score {candidate.deterministicScore}/100
                        </span>
                        <span className="rounded-full bg-neutral-800 px-2.5 py-0.5 text-xs text-neutral-400">
                          Confidence {Math.round(candidate.confidence * 100)}%
                        </span>
                        {candidate.reportExpired && (
                          <span className="rounded-full bg-neutral-800 px-2.5 py-0.5 text-xs text-neutral-500">
                            Expired record
                          </span>
                        )}
                      </div>

                      <p className="mt-2 text-xs text-neutral-300">
                        {candidate.thesis}
                      </p>

                      <p className="mt-1 text-xs text-neutral-500">
                        Data through {formatBarDate(candidate.lastBarDate)} ·{" "}
                        {candidate.inclusionReason}
                      </p>
                    </summary>

                    {(candidate.currentReferencePrice !== null ||
                      candidate.proposedEntryRange !== null ||
                      candidate.maximumEntryPrice !== null) && (
                      <p className="mt-2 text-xs text-neutral-400">
                        {candidate.currentReferencePrice !== null && (
                          <>
                            Reference price at generation{" "}
                            {formatPrice(candidate.currentReferencePrice)}.{" "}
                          </>
                        )}
                        {candidate.proposedEntryRange !== null && (
                          <>
                            Proposed entry (at generation time):{" "}
                            {candidate.proposedEntryRange}.{" "}
                          </>
                        )}
                        {candidate.maximumEntryPrice !== null && (
                          <>
                            Max entry (at generation time):{" "}
                            {formatPrice(candidate.maximumEntryPrice)}.
                          </>
                        )}
                      </p>
                    )}

                    <HistoryFactorList
                      title="Blocked from a new buy because"
                      items={candidate.blockingReasons}
                    />
                    <HistoryFactorList
                      title="Supporting factors"
                      items={candidate.supportingFactors}
                    />
                    <HistoryFactorList
                      title="Risk factors"
                      items={candidate.riskFactors}
                    />
                    <HistoryFactorList
                      title="Invalidation conditions"
                      items={candidate.invalidationConditions}
                    />
                    <HistoryFactorList
                      title="Mapping notes"
                      items={candidate.mappingNotes}
                    />
                  </details>
                </li>
              ))}
            </ul>
          )}

          <div className="mt-4 rounded-lg border border-green-900 bg-green-950/40 p-3">
            <p className="text-xs font-semibold text-green-300">
              No order was placed or queued by this run
            </p>
            <p className="mt-1 text-xs text-neutral-300">
              {detail.safetyNotice}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
