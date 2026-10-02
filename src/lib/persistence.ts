import "server-only";
import { getDb, isDatabaseConfigured } from "@/lib/db";
import {
  buildEveningCandidateRows,
  clampedConfidence,
  dateOnlyToDate,
  decimalOrNull,
  errorToMessage,
  isoToDate,
  toJsonValue,
  type StoredJson,
} from "@/lib/db-serialization";
import {
  clampReportListLimit,
  DEFAULT_REPORT_LIST_LIMIT,
  easternCalendarDate,
  isUuid,
  mapEveningReportRowToDetailDto,
  mapEveningReportRowToSummaryDto,
  type EveningReportDetailDto,
  type EveningReportSummaryDto,
} from "@/lib/evening-report-history";
import type {
  AlpacaAccountSummary,
  AlpacaClock,
  AlpacaOrder,
  AlpacaOrderResponse,
  AlpacaPosition,
} from "@/lib/alpaca";
import type { EveningAnalysisResult } from "@/lib/evening-analysis";
import type { MarketAnalysisSummary } from "@/lib/market-analysis";
import type { OpenAITradeRecommendation } from "@/lib/openai-trader";
import type { RiskCheckResult, TradeRequest } from "@/lib/risk-manager";

// Persistence layer (Phase 2): best-effort audit/history records in Neon
// Postgres via Prisma.
//
// Safety boundaries (do not change):
// - Persistence is observability, not control flow. Every helper here is
//   best-effort: a database outage logs an error and returns null — it never
//   throws into a trading or analysis flow, never blocks the risk manager,
//   and never changes what the app does.
// - Nothing in this module talks to Alpaca or OpenAI. It cannot place,
//   queue, cancel, or modify orders.
// - Alpaca remains the broker source of truth. alpaca_order_refs rows are
//   local references for history; they are never proof of fills and must be
//   reconciled against Alpaca before being trusted.
// - Server-only: importing this from a client component is a build error.

async function bestEffort<T>(
  operation: string,
  fn: () => Promise<T>
): Promise<T | null> {
  if (!isDatabaseConfigured()) {
    return null;
  }

  try {
    return await fn();
  } catch (error) {
    // Deliberately swallowed: persistence must never break the app flow.
    console.error(`[persistence] ${operation} failed:`, error);
    return null;
  }
}

// ---------------------------------------------------------------------------
// agent_runs
// ---------------------------------------------------------------------------

export type StartAgentRunInput = {
  runType: "agent_trade" | "recommendation" | "evening_analysis";
  triggerSource: string;
  analysisOnly: boolean;
  intendedSessionDate?: string | null;
  killSwitchActive?: boolean;
  paperTrading?: boolean;
  inputSnapshot?: unknown;
};

/** Creates a running agent_runs row; returns its id (null when unavailable). */
export async function startAgentRun(
  input: StartAgentRunInput
): Promise<string | null> {
  return bestEffort("startAgentRun", async () => {
    const row = await getDb().agentRun.create({
      data: {
        runType: input.runType,
        triggerSource: input.triggerSource,
        status: "running",
        analysisOnly: input.analysisOnly,
        intendedSessionDate: dateOnlyToDate(input.intendedSessionDate),
        killSwitchActive: input.killSwitchActive,
        paperTrading: input.paperTrading,
        inputSnapshot: toJsonValue(input.inputSnapshot, {}),
      },
      select: { id: true },
    });

    return row.id;
  });
}

export type CompleteAgentRunInput = {
  ordersSubmittedCount: number;
  ordersQueuedCount?: number;
  killSwitchActive?: boolean;
  paperTrading?: boolean;
  skippedReason?: string | null;
  intendedSessionDate?: string | null;
  outputSnapshot?: unknown;
};

/** Marks an agent run completed (optionally with a skipped reason). */
export async function completeAgentRun(
  agentRunId: string | null,
  input: CompleteAgentRunInput
): Promise<void> {
  if (!agentRunId) {
    return;
  }

  await bestEffort("completeAgentRun", async () => {
    await getDb().agentRun.update({
      where: { id: agentRunId },
      data: {
        status: "completed",
        completedAt: new Date(),
        ordersSubmittedCount: input.ordersSubmittedCount,
        ordersQueuedCount: input.ordersQueuedCount ?? 0,
        killSwitchActive: input.killSwitchActive,
        paperTrading: input.paperTrading,
        skippedReason: input.skippedReason ?? undefined,
        intendedSessionDate:
          dateOnlyToDate(input.intendedSessionDate) ?? undefined,
        outputSnapshot: toJsonValue(input.outputSnapshot, {}),
      },
    });
  });
}

export type SkippedAgentRunInput = {
  runType: StartAgentRunInput["runType"];
  triggerSource: string;
  analysisOnly: boolean;
  skippedReason: string;
  killSwitchActive?: boolean;
  paperTrading?: boolean;
};

/**
 * Records a run that was refused before any evaluation happened (kill switch
 * active, non-paper endpoint) as a single completed "skipped" row.
 */
export async function recordSkippedAgentRun(
  input: SkippedAgentRunInput
): Promise<string | null> {
  return bestEffort("recordSkippedAgentRun", async () => {
    const row = await getDb().agentRun.create({
      data: {
        runType: input.runType,
        triggerSource: input.triggerSource,
        status: "skipped",
        completedAt: new Date(),
        analysisOnly: input.analysisOnly,
        skippedReason: input.skippedReason,
        killSwitchActive: input.killSwitchActive,
        paperTrading: input.paperTrading,
      },
      select: { id: true },
    });

    return row.id;
  });
}

/** Marks a run failed and stores the (truncated) error message. */
export async function markAgentRunFailed(
  agentRunId: string | null,
  error: unknown
): Promise<void> {
  if (!agentRunId) {
    return;
  }

  await bestEffort("markAgentRunFailed", async () => {
    await getDb().agentRun.update({
      where: { id: agentRunId },
      data: {
        status: "failed",
        completedAt: new Date(),
        errorMessage: errorToMessage(error),
      },
    });
  });
}

// ---------------------------------------------------------------------------
// error_events
// ---------------------------------------------------------------------------

export type ErrorEventInput = {
  agentRunId?: string | null;
  scheduledJobRunId?: string | null;
  source: string;
  severity?: "error" | "warning" | "critical";
  message: string;
  details?: unknown;
};

export async function recordErrorEvent(
  input: ErrorEventInput
): Promise<string | null> {
  return bestEffort("recordErrorEvent", async () => {
    const row = await getDb().errorEvent.create({
      data: {
        agentRunId: input.agentRunId ?? undefined,
        scheduledJobRunId: input.scheduledJobRunId ?? undefined,
        source: input.source,
        severity: input.severity ?? "error",
        message: truncatedMessage(input.message),
        details: toJsonValue(input.details, {}),
      },
      select: { id: true },
    });

    return row.id;
  });
}

function truncatedMessage(message: string): string {
  return message.length <= 2000 ? message : `${message.slice(0, 1999)}…`;
}

// ---------------------------------------------------------------------------
// ai_recommendations
// ---------------------------------------------------------------------------

export type SaveAiRecommendationInput = {
  agentRunId?: string | null;
  model?: string | null;
  recommendation: OpenAITradeRecommendation;
  /** Raw provider payload when available; not captured in Phase 2. */
  rawResponse?: unknown;
  validationNotes?: string[];
};

export async function saveAiRecommendation(
  input: SaveAiRecommendationInput
): Promise<string | null> {
  return bestEffort("saveAiRecommendation", async () => {
    const { recommendation } = input;

    const row = await getDb().aiRecommendation.create({
      data: {
        agentRunId: input.agentRunId ?? undefined,
        provider: "openai",
        model: input.model ?? undefined,
        action: recommendation.action,
        symbol: recommendation.symbol,
        qty: decimalOrNull(recommendation.qty),
        confidence: clampedConfidence(recommendation.confidence),
        reason: recommendation.reason,
        rawResponse: toJsonValue(input.rawResponse, {}),
        validatedPayload: toJsonValue(recommendation, {}),
        validationNotes: toJsonValue(input.validationNotes, []),
      },
      select: { id: true },
    });

    return row.id;
  });
}

// ---------------------------------------------------------------------------
// market_analyses
// ---------------------------------------------------------------------------

export type SaveMarketAnalysisInput = {
  agentRunId?: string | null;
  analysisKind: "agent_trade" | "recommendation" | "evening_analysis";
  summary: MarketAnalysisSummary;
};

export async function saveMarketAnalysisSummary(
  input: SaveMarketAnalysisInput
): Promise<string | null> {
  return bestEffort("saveMarketAnalysisSummary", async () => {
    const { summary } = input;

    const row = await getDb().marketAnalysis.create({
      data: {
        agentRunId: input.agentRunId ?? undefined,
        analysisKind: input.analysisKind,
        asOf: isoToDate(summary.asOf) ?? new Date(),
        marketRegime: summary.regime,
        regimeReasons: toJsonValue(summary.regimeReasons, []),
        forceNoTrade: summary.forceNoTrade,
        dataIssues: toJsonValue(summary.dataIssues, []),
        minBuyScore: summary.minBuyScore,
        summary: toJsonValue(summary, {}),
        candidates: toJsonValue(summary.candidates, []),
      },
      select: { id: true },
    });

    return row.id;
  });
}

// ---------------------------------------------------------------------------
// risk_decisions
// ---------------------------------------------------------------------------

export type SaveRiskDecisionInput = {
  agentRunId?: string | null;
  recommendationId?: string | null;
  decisionType: "agent_trade" | "recommendation_preview";
  riskCheck: RiskCheckResult;
  trade?: TradeRequest | null;
  account?: AlpacaAccountSummary;
  positions?: AlpacaPosition[];
  recentOrders?: AlpacaOrder[];
  marketClock?: AlpacaClock;
};

export async function saveRiskDecision(
  input: SaveRiskDecisionInput
): Promise<string | null> {
  return bestEffort("saveRiskDecision", async () => {
    const row = await getDb().riskDecision.create({
      data: {
        agentRunId: input.agentRunId ?? undefined,
        recommendationId: input.recommendationId ?? undefined,
        decisionType: input.decisionType,
        approved: input.riskCheck.approved,
        reasons: toJsonValue(input.riskCheck.reasons, []),
        tradeSymbol: input.trade?.symbol ?? undefined,
        tradeQty: input.trade ? decimalOrNull(input.trade.qty) : undefined,
        tradeSide: input.trade?.side ?? undefined,
        accountSnapshot: toJsonValue(input.account, {}),
        positionsSnapshot: toJsonValue(input.positions, []),
        recentOrdersSnapshot: toJsonValue(input.recentOrders, []),
        marketClockSnapshot: toJsonValue(input.marketClock, {}),
      },
      select: { id: true },
    });

    return row.id;
  });
}

// ---------------------------------------------------------------------------
// evening_analysis_reports + evening_analysis_candidates
// ---------------------------------------------------------------------------

export type SaveEveningReportInput = {
  agentRunId?: string | null;
  marketAnalysisId?: string | null;
  result: EveningAnalysisResult;
};

/**
 * Saves an Evening Analysis report with its candidates in one atomic create.
 * Pure history: the stored rows describe an informational watchlist and are
 * never read back as instructions to trade.
 */
export async function saveEveningAnalysisReport(
  input: SaveEveningReportInput
): Promise<string | null> {
  return bestEffort("saveEveningAnalysisReport", async () => {
    const { result } = input;

    const row = await getDb().eveningAnalysisReport.create({
      data: {
        agentRunId: input.agentRunId ?? undefined,
        marketAnalysisId: input.marketAnalysisId ?? undefined,
        generatedAt: isoToDate(result.generatedAt) ?? new Date(),
        intendedSessionDate: dateOnlyToDate(result.intendedSessionDate),
        status: "active",
        analysisOnly: result.analysisOnly,
        ordersSubmittedCount: result.ordersSubmitted,
        ordersQueuedCount: result.ordersQueued,
        safetyNotice: result.safetyNotice,
        marketStatus: result.marketStatus,
        marketStatusLabel: result.marketStatusLabel,
        marketRegime: result.marketRegime,
        regimeReasons: toJsonValue(result.regimeReasons, []),
        selectionNotice: result.selectionNotice,
        summary: result.summary,
        warnings: toJsonValue(result.warnings, []),
        candidates: { create: buildEveningCandidateRows(result.candidates) },
      },
      select: { id: true },
    });

    return row.id;
  });
}

// ---------------------------------------------------------------------------
// Evening Analysis report history (Phase 3): server-side expiration plus
// read helpers for the read-only history endpoints.
//
// Safety boundaries (do not change):
// - These helpers are READ-ONLY history plus a status-only expiration sweep.
//   They never place, queue, cancel, replace, or modify orders, never call
//   Alpaca or OpenAI, and never delete reports (retention pruning stays a
//   separate, manual concern).
// - Validity is computed here on the server (via evening-report-history
//   helpers) from stored fields. Clients only display it. An expired report
//   is never returned as valid/current, and getLatestValidEveningAnalysis-
//   Report fails closed to null whenever validity cannot be determined.
// - Rows read back here are historical analysis, never trade instructions.
//   Phase 4 (morning revalidation/execution) must start from live Alpaca
//   data and the deterministic risk manager — not from these DTOs.
// ---------------------------------------------------------------------------

/**
 * Marks outdated active reports as expired: status "active" with either a
 * passed expiresAt, or an intendedSessionDate before today's America/New_York
 * calendar date. Reports with a null intendedSessionDate are left untouched
 * (they surface as "never revalidatable" instead). Sets status = "expired"
 * and expiredAt = now; never deletes anything. Called opportunistically from
 * the read helpers — there is deliberately no background scheduling.
 */
export async function expireOutdatedEveningAnalysisReports(
  now: Date = new Date()
): Promise<number | null> {
  return bestEffort("expireOutdatedEveningAnalysisReports", async () => {
    const todayAnchor = dateOnlyToDate(easternCalendarDate(now));

    const result = await getDb().eveningAnalysisReport.updateMany({
      where: {
        status: "active",
        OR: [
          { expiresAt: { lte: now } },
          ...(todayAnchor
            ? [{ intendedSessionDate: { lt: todayAnchor } }]
            : []),
        ],
      },
      data: { status: "expired", expiredAt: now },
    });

    return result.count;
  });
}

export type ListEveningAnalysisReportsResult =
  | { ok: true; reports: EveningReportSummaryDto[] }
  | { ok: false; reason: "not_configured" | "error" };

/**
 * Latest saved Evening Analysis reports (newest generatedAt first) as
 * API-safe summaries with server-computed validity. Read-only dashboard
 * history: failures are reported distinctly from an empty history so the
 * caller never mistakes "unavailable" for "no reports".
 */
export async function listEveningAnalysisReports(
  limit: number = DEFAULT_REPORT_LIST_LIMIT,
  now: Date = new Date()
): Promise<ListEveningAnalysisReportsResult> {
  if (!isDatabaseConfigured()) {
    return { ok: false, reason: "not_configured" };
  }

  try {
    // Opportunistic sweep so stored statuses converge; validity below is
    // recomputed per row regardless, so a failed sweep cannot mislabel.
    await expireOutdatedEveningAnalysisReports(now);

    const rows = await getDb().eveningAnalysisReport.findMany({
      orderBy: { generatedAt: "desc" },
      take: clampReportListLimit(limit),
      select: {
        id: true,
        status: true,
        generatedAt: true,
        intendedSessionDate: true,
        expiresAt: true,
        expiredAt: true,
        analysisOnly: true,
        ordersSubmittedCount: true,
        ordersQueuedCount: true,
        marketStatus: true,
        marketRegime: true,
        summary: true,
        candidates: { select: { action: true } },
      },
    });

    return {
      ok: true,
      reports: rows.map((row) => mapEveningReportRowToSummaryDto(row, now)),
    };
  } catch (error) {
    console.error("[persistence] listEveningAnalysisReports failed:", error);
    return { ok: false, reason: "error" };
  }
}

export type GetEveningAnalysisReportResult =
  | { ok: true; report: EveningReportDetailDto }
  | { ok: false; reason: "invalid_id" | "not_found" | "not_configured" | "error" };

/**
 * One saved report with its candidates and the linked market-analysis data
 * freshness, as an API-safe DTO with server-computed validity. The
 * browser-supplied id is validated before it touches the database. Expired
 * reports ARE returned — clearly flagged — because this feeds the read-only
 * history view; any future revalidation flow must check
 * eligibleForRevalidation instead of assuming a returned report is current.
 */
export async function getEveningAnalysisReport(
  reportId: string,
  now: Date = new Date()
): Promise<GetEveningAnalysisReportResult> {
  if (typeof reportId !== "string" || !isUuid(reportId)) {
    return { ok: false, reason: "invalid_id" };
  }

  if (!isDatabaseConfigured()) {
    return { ok: false, reason: "not_configured" };
  }

  try {
    await expireOutdatedEveningAnalysisReports(now);

    const row = await getDb().eveningAnalysisReport.findUnique({
      where: { id: reportId },
      include: {
        candidates: { orderBy: { rank: "asc" } },
        marketAnalysis: {
          select: {
            asOf: true,
            forceNoTrade: true,
            dataIssues: true,
            candidates: true,
          },
        },
      },
    });

    if (!row) {
      return { ok: false, reason: "not_found" };
    }

    return { ok: true, report: mapEveningReportRowToDetailDto(row, now) };
  } catch (error) {
    console.error("[persistence] getEveningAnalysisReport failed:", error);
    return { ok: false, reason: "error" };
  }
}

/**
 * PHASE 4 PREPARATION ONLY — nothing calls this yet, and nothing may use it
 * to execute trades. Returns the newest report that is affirmatively valid
 * for the current/upcoming America/New_York session (status active, session
 * date today or later, expiresAt not passed), or null.
 *
 * Fail-closed contract (do not weaken):
 * - Database unavailable, query failure, or undeterminable validity → null.
 *   An expired or unverifiable report is NEVER returned as valid.
 * - Validity is recomputed on the returned row (defense in depth on top of
 *   the SQL filter) and the report is returned only when
 *   eligibleForRevalidation is true.
 * - Even a valid report is historical analysis, not trade authority: any
 *   future execution flow must revalidate against live Alpaca data and pass
 *   the deterministic risk manager before anything else happens.
 */
export async function getLatestValidEveningAnalysisReport(
  now: Date = new Date()
): Promise<EveningReportDetailDto | null> {
  if (!isDatabaseConfigured()) {
    return null;
  }

  try {
    await expireOutdatedEveningAnalysisReports(now);

    const todayAnchor = dateOnlyToDate(easternCalendarDate(now));

    if (!todayAnchor) {
      return null;
    }

    const row = await getDb().eveningAnalysisReport.findFirst({
      where: {
        status: "active",
        // gte on a non-null column also excludes null session dates, which
        // are never eligible for revalidation.
        intendedSessionDate: { gte: todayAnchor },
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      orderBy: { generatedAt: "desc" },
      include: {
        candidates: { orderBy: { rank: "asc" } },
        marketAnalysis: {
          select: {
            asOf: true,
            forceNoTrade: true,
            dataIssues: true,
            candidates: true,
          },
        },
      },
    });

    if (!row) {
      return null;
    }

    const report = mapEveningReportRowToDetailDto(row, now);

    if (report.isExpired || !report.eligibleForRevalidation) {
      return null;
    }

    return report;
  } catch (error) {
    console.error(
      "[persistence] getLatestValidEveningAnalysisReport failed:",
      error
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// alpaca_order_refs
// ---------------------------------------------------------------------------

export type SaveAlpacaOrderRefInput = {
  agentRunId?: string | null;
  riskDecisionId?: string | null;
  eveningCandidateId?: string | null;
  order: AlpacaOrderResponse;
};

/**
 * Stores a local reference to an order Alpaca accepted. Reference only:
 * Alpaca is the broker source of truth, and these rows must be reconciled
 * against Alpaca before being treated as fills.
 */
export async function saveAlpacaOrderRef(
  input: SaveAlpacaOrderRefInput
): Promise<string | null> {
  return bestEffort("saveAlpacaOrderRef", async () => {
    const { order } = input;
    const qty = decimalOrNull(order.qty);

    if (qty === null) {
      throw new Error(`Alpaca order ${order.id} has a non-numeric qty.`);
    }

    // Upsert on the unique Alpaca order id so a retried save stays idempotent.
    const row = await getDb().alpacaOrderRef.upsert({
      where: { alpacaOrderId: order.id },
      create: {
        agentRunId: input.agentRunId ?? undefined,
        riskDecisionId: input.riskDecisionId ?? undefined,
        eveningCandidateId: input.eveningCandidateId ?? undefined,
        alpacaOrderId: order.id,
        clientOrderId: order.clientOrderId,
        symbol: order.symbol,
        qty,
        side: order.side,
        orderType: order.type,
        timeInForce: order.timeInForce,
        status: order.status,
        submittedAt: isoToDate(order.submittedAt),
        rawOrder: toJsonValue(order.raw, {}),
      },
      update: {
        status: order.status,
        rawOrder: toJsonValue(order.raw, {}),
      },
      select: { id: true },
    });

    return row.id;
  });
}

// ---------------------------------------------------------------------------
// scheduled_job_runs + notifications (recorded only; nothing schedules or
// sends anything in Phase 2 — these exist for future phases)
// ---------------------------------------------------------------------------

export type CreateScheduledJobRunInput = {
  jobName: string;
  status?: string;
  scheduledFor?: string | null;
  maxAttempts?: number;
  lockKey?: string | null;
  metadata?: unknown;
};

export async function createScheduledJobRun(
  input: CreateScheduledJobRunInput
): Promise<string | null> {
  return bestEffort("createScheduledJobRun", async () => {
    const row = await getDb().scheduledJobRun.create({
      data: {
        jobName: input.jobName,
        status: input.status ?? "running",
        scheduledFor: isoToDate(input.scheduledFor),
        maxAttempts: input.maxAttempts ?? 1,
        lockKey: input.lockKey ?? undefined,
        metadata: toJsonValue(input.metadata, {}),
      },
      select: { id: true },
    });

    return row.id;
  });
}

export type CompleteScheduledJobRunInput = {
  status: "completed" | "failed" | "skipped";
  agentRunId?: string | null;
  errorMessage?: string | null;
};

export async function completeScheduledJobRun(
  scheduledJobRunId: string | null,
  input: CompleteScheduledJobRunInput
): Promise<void> {
  if (!scheduledJobRunId) {
    return;
  }

  await bestEffort("completeScheduledJobRun", async () => {
    await getDb().scheduledJobRun.update({
      where: { id: scheduledJobRunId },
      data: {
        status: input.status,
        completedAt: new Date(),
        agentRunId: input.agentRunId ?? undefined,
        errorMessage: input.errorMessage ?? undefined,
      },
    });
  });
}

export type RecordNotificationInput = {
  notificationType: string;
  channel: string;
  status?: string;
  recipient?: string | null;
  subject?: string | null;
  body?: string | null;
  dedupeKey?: string | null;
  agentRunId?: string | null;
  scheduledJobRunId?: string | null;
  metadata?: unknown;
};

/** Records a notification row. Phase 2 never sends anything anywhere. */
export async function recordNotification(
  input: RecordNotificationInput
): Promise<string | null> {
  return bestEffort("recordNotification", async () => {
    const row = await getDb().notification.create({
      data: {
        notificationType: input.notificationType,
        channel: input.channel,
        status: input.status ?? "pending",
        recipient: input.recipient ?? undefined,
        subject: input.subject ?? undefined,
        body: input.body ?? undefined,
        dedupeKey: input.dedupeKey ?? undefined,
        agentRunId: input.agentRunId ?? undefined,
        scheduledJobRunId: input.scheduledJobRunId ?? undefined,
        metadata: toJsonValue(input.metadata, {}),
      },
      select: { id: true },
    });

    return row.id;
  });
}

// ---------------------------------------------------------------------------
// app_settings + settings_audit_logs
// ---------------------------------------------------------------------------

export async function getAppSetting(key: string): Promise<StoredJson | null> {
  return bestEffort("getAppSetting", async () => {
    const row = await getDb().appSetting.findUnique({ where: { key } });

    if (!row || row.value === null) {
      return null;
    }

    return row.value as StoredJson;
  });
}

export type SetAppSettingInput = {
  key: string;
  value: StoredJson;
  description?: string | null;
  updatedBy?: string | null;
  changeReason?: string | null;
};

/**
 * Upserts a setting and writes the settings_audit_logs entry in the same
 * transaction, so every change is audited or not applied at all.
 */
export async function setAppSetting(
  input: SetAppSettingInput
): Promise<boolean> {
  const result = await bestEffort("setAppSetting", async () => {
    await getDb().$transaction(async (tx) => {
      const existing = await tx.appSetting.findUnique({
        where: { key: input.key },
      });

      await tx.appSetting.upsert({
        where: { key: input.key },
        create: {
          key: input.key,
          value: input.value,
          description: input.description ?? undefined,
          updatedBy: input.updatedBy ?? undefined,
        },
        update: {
          value: input.value,
          description: input.description ?? undefined,
          updatedBy: input.updatedBy ?? undefined,
          updatedAt: new Date(),
        },
      });

      await tx.settingsAuditLog.create({
        data: {
          settingKey: input.key,
          oldValue: existing ? toJsonValue(existing.value, {}) : undefined,
          newValue: input.value,
          changedBy: input.updatedBy ?? undefined,
          changeReason: input.changeReason ?? undefined,
        },
      });
    });

    return true;
  });

  return result === true;
}

// ---------------------------------------------------------------------------
// Retention/cleanup helpers. NOT scheduled anywhere in Phase 2 — call them
// manually (or from a future scheduled phase). Deletes are age-based only.
// ---------------------------------------------------------------------------

function retentionCutoff(olderThanDays: number): Date {
  const days = Math.max(1, Math.floor(olderThanDays));
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

export async function pruneErrorEvents(
  olderThanDays: number
): Promise<number | null> {
  return bestEffort("pruneErrorEvents", async () => {
    const result = await getDb().errorEvent.deleteMany({
      where: { createdAt: { lt: retentionCutoff(olderThanDays) } },
    });

    return result.count;
  });
}

export async function pruneNotifications(
  olderThanDays: number
): Promise<number | null> {
  return bestEffort("pruneNotifications", async () => {
    const result = await getDb().notification.deleteMany({
      where: { createdAt: { lt: retentionCutoff(olderThanDays) } },
    });

    return result.count;
  });
}

export async function pruneScheduledJobRuns(
  olderThanDays: number
): Promise<number | null> {
  return bestEffort("pruneScheduledJobRuns", async () => {
    const result = await getDb().scheduledJobRun.deleteMany({
      where: { createdAt: { lt: retentionCutoff(olderThanDays) } },
    });

    return result.count;
  });
}

/** Deleting a report cascades to its evening_analysis_candidates rows. */
export async function pruneEveningAnalysisReports(
  olderThanDays: number
): Promise<number | null> {
  return bestEffort("pruneEveningAnalysisReports", async () => {
    const result = await getDb().eveningAnalysisReport.deleteMany({
      where: { createdAt: { lt: retentionCutoff(olderThanDays) } },
    });

    return result.count;
  });
}

/**
 * Deletes old agent_runs. Referencing rows (recommendations, analyses, risk
 * decisions, order refs, ...) are kept — their agent_run_id FKs are defined
 * ON DELETE SET NULL in the database.
 */
export async function pruneAgentRuns(
  olderThanDays: number
): Promise<number | null> {
  return bestEffort("pruneAgentRuns", async () => {
    const result = await getDb().agentRun.deleteMany({
      where: { createdAt: { lt: retentionCutoff(olderThanDays) } },
    });

    return result.count;
  });
}
