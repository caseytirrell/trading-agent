import { NextResponse } from "next/server";
import { runEveningAnalysis } from "@/lib/evening-analysis";
import {
  completeAgentRun,
  markAgentRunFailed,
  recordErrorEvent,
  saveEveningAnalysisReport,
  saveMarketAnalysisSummary,
  startAgentRun,
} from "@/lib/persistence";

// Never cache: every manual run must see live account and market state.
export const dynamic = "force-dynamic";

// Evening Analysis: manual, read-only, next-session watchlist.
//
// Import boundary (do not change): this route must never import
// placePaperMarketOrder or anything from the order-placing routes. It has
// no order path — it cannot place, queue, cancel, replace, or modify an
// order. The explicit ordersSubmitted/ordersQueued fields below are part of
// the API contract.
//
// Persistence (Phase 2): the finished analysis is stored best-effort as
// history (agent_runs, market_analyses, evening_analysis_reports,
// evening_analysis_candidates). These are audit records only — nothing reads
// them back as instructions, nothing is queued, and a database outage does
// not change the response beyond the persisted ids being null.
export async function POST() {
  const timestamp = new Date().toISOString();
  let agentRunId: string | null = null;

  try {
    agentRunId = await startAgentRun({
      runType: "evening_analysis",
      triggerSource: "api",
      analysisOnly: true,
    });

    const result = await runEveningAnalysis();

    const marketAnalysisId = await saveMarketAnalysisSummary({
      agentRunId,
      analysisKind: "evening_analysis",
      summary: result.marketAnalysis,
    });

    const reportId = await saveEveningAnalysisReport({
      agentRunId,
      marketAnalysisId,
      result,
    });

    await completeAgentRun(agentRunId, {
      ordersSubmittedCount: 0,
      ordersQueuedCount: 0,
      paperTrading: true,
      intendedSessionDate: result.intendedSessionDate,
      outputSnapshot: {
        summary: result.summary,
        selectionNotice: result.selectionNotice,
        marketRegime: result.marketRegime,
        candidateCount: result.candidates.length,
        watchCount: result.candidates.filter(
          (candidate) => candidate.action === "WATCH"
        ).length,
      },
    });

    return NextResponse.json({
      success: true,
      analysisOnly: true,
      ordersSubmitted: 0,
      ordersQueued: 0,
      result,
      agentRunId,
      reportId,
      timestamp,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";

    await markAgentRunFailed(agentRunId, error);
    await recordErrorEvent({
      agentRunId,
      source: "api/agent/evening-analysis",
      message,
    });

    return NextResponse.json(
      {
        success: false,
        analysisOnly: true,
        ordersSubmitted: 0,
        ordersQueued: 0,
        error: message,
        agentRunId,
        timestamp,
      },
      { status: 500 }
    );
  }
}
