import { NextResponse } from "next/server";
import { describeRequestedTrade, evaluateAgentTrade } from "@/lib/agent";
import { OPENAI_TRADER_MODEL } from "@/lib/openai-trader";
import {
  completeAgentRun,
  markAgentRunFailed,
  recordErrorEvent,
  saveAiRecommendation,
  saveMarketAnalysisSummary,
  saveRiskDecision,
  startAgentRun,
} from "@/lib/persistence";
import { isKillSwitchActive } from "@/lib/risk-manager";

// Never cache: each click should produce a fresh recommendation.
export const dynamic = "force-dynamic";

// Recommendation only — this route never places orders. AI-recommended
// execution is confined to /api/agent/run and still requires risk approval;
// the separate manual order routes enforce the same local risk gate.
//
// Persistence (Phase 2): the recommendation, deterministic market analysis,
// and a preview risk decision are recorded best-effort for history. Storing
// them changes nothing about execution — decision_type "recommendation_preview"
// rows are never read back as trade instructions.
export async function POST() {
  let agentRunId: string | null = null;

  try {
    agentRunId = await startAgentRun({
      runType: "recommendation",
      triggerSource: "api",
      analysisOnly: true,
      killSwitchActive: isKillSwitchActive(),
    });

    const { recommendation, riskCheck, executable, marketAnalysis, context } =
      await evaluateAgentTrade();

    const [, recommendationId] = await Promise.all([
      saveMarketAnalysisSummary({
        agentRunId,
        analysisKind: "recommendation",
        summary: marketAnalysis,
      }),
      saveAiRecommendation({
        agentRunId,
        model: OPENAI_TRADER_MODEL,
        recommendation,
      }),
    ]);

    await saveRiskDecision({
      agentRunId,
      recommendationId,
      decisionType: "recommendation_preview",
      riskCheck,
      trade: describeRequestedTrade(recommendation, null),
      account: context.account,
      positions: context.positions,
      recentOrders: context.recentOrders,
      marketClock: context.marketClock,
    });

    await completeAgentRun(agentRunId, {
      ordersSubmittedCount: 0,
      paperTrading: context.account.paper,
      outputSnapshot: { recommendation, riskCheck, executable },
    });

    return NextResponse.json({
      success: true,
      recommendation,
      riskCheck,
      executable,
      marketAnalysis,
      agentRunId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";

    await markAgentRunFailed(agentRunId, error);
    await recordErrorEvent({
      agentRunId,
      source: "api/openai/recommendation",
      message,
    });

    return NextResponse.json(
      {
        success: false,
        error: message,
        agentRunId,
      },
      { status: 500 }
    );
  }
}
