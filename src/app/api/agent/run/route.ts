import { NextResponse } from "next/server";
import { describeRequestedTrade, evaluateAgentTrade } from "@/lib/agent";
import { placePaperMarketOrder } from "@/lib/alpaca";
import { OPENAI_TRADER_MODEL } from "@/lib/openai-trader";
import {
  completeAgentRun,
  markAgentRunFailed,
  recordErrorEvent,
  recordSkippedAgentRun,
  saveAiRecommendation,
  saveAlpacaOrderRef,
  saveMarketAnalysisSummary,
  saveRiskDecision,
  startAgentRun,
} from "@/lib/persistence";
import { isKillSwitchActive } from "@/lib/risk-manager";
import { tryAcquireOrderExecutionLease } from "@/lib/order-execution-guard";

// Never cache: every run must see live account state.
export const dynamic = "force-dynamic";

// Status check for the dashboard. Reads env config only — no Alpaca, OpenAI,
// or database calls, so it is safe to hit on page load.
export async function GET() {
  const endpoint = process.env.ALPACA_ENDPOINT;

  return NextResponse.json({
    killSwitchActive: isKillSwitchActive(),
    paperTrading: Boolean(endpoint && endpoint.includes("paper-api")),
    timestamp: new Date().toISOString(),
  });
}

// Runs the agent once: recommendation -> validation -> risk manager -> paper
// order (only if approved). The AI never places orders itself; this route
// makes the final execution decision.
//
// Persistence (Phase 2) is best-effort audit only: every step is recorded in
// Postgres (agent_runs, market_analyses, ai_recommendations, risk_decisions,
// alpaca_order_refs), but a database outage never changes what this route
// does — the risk manager remains the only execution gate, and Alpaca
// remains the broker source of truth.
export async function POST() {
  const timestamp = new Date().toISOString();
  let agentRunId: string | null = null;
  let releaseOrderExecution: (() => void) | null = null;

  try {
    const endpoint = process.env.ALPACA_ENDPOINT;

    if (!endpoint || !endpoint.includes("paper-api")) {
      const skippedReason =
        "Blocked: ALPACA_ENDPOINT must be the Alpaca paper trading endpoint.";

      const skippedRunId = await recordSkippedAgentRun({
        runType: "agent_trade",
        triggerSource: "api",
        analysisOnly: false,
        skippedReason,
        killSwitchActive: true,
        paperTrading: false,
      });

      return NextResponse.json(
        {
          success: false,
          mode: "paper",
          error: skippedReason,
          killSwitchActive: true,
          agentRunId: skippedRunId,
          timestamp,
        },
        { status: 403 }
      );
    }

    if (isKillSwitchActive()) {
      const skippedReason = "Kill switch is active. Agent run skipped.";

      const skippedRunId = await recordSkippedAgentRun({
        runType: "agent_trade",
        triggerSource: "api",
        analysisOnly: false,
        skippedReason,
        killSwitchActive: true,
        paperTrading: true,
      });

      return NextResponse.json({
        success: true,
        mode: "paper",
        recommendation: null,
        riskCheck: {
          approved: false,
          reasons: ["Kill switch is active. Trading is disabled."],
        },
        order: null,
        skippedReason,
        killSwitchActive: true,
        agentRunId: skippedRunId,
        timestamp,
      });
    }

    const lease = tryAcquireOrderExecutionLease();

    if (!lease) {
      return NextResponse.json(
        {
          success: false,
          mode: "paper",
          error: "Another order-capable request is already running.",
          killSwitchActive: false,
          agentRunId: null,
          timestamp,
        },
        { status: 409 }
      );
    }

    releaseOrderExecution = lease.release;

    agentRunId = await startAgentRun({
      runType: "agent_trade",
      triggerSource: "api",
      analysisOnly: false,
      killSwitchActive: false,
      paperTrading: true,
    });

    const {
      recommendation,
      riskCheck,
      executable,
      trade,
      marketAnalysis,
      context,
    } = await evaluateAgentTrade();

    const [, recommendationId] = await Promise.all([
      saveMarketAnalysisSummary({
        agentRunId,
        analysisKind: "agent_trade",
        summary: marketAnalysis,
      }),
      saveAiRecommendation({
        agentRunId,
        model: OPENAI_TRADER_MODEL,
        recommendation,
      }),
    ]);

    const riskDecisionId = await saveRiskDecision({
      agentRunId,
      recommendationId,
      decisionType: "agent_trade",
      riskCheck,
      trade: describeRequestedTrade(recommendation, trade),
      account: context.account,
      positions: context.positions,
      recentOrders: context.recentOrders,
      marketClock: context.marketClock,
    });

    if (!executable || !trade) {
      const skippedReason =
        recommendation.action === "HOLD" || recommendation.action === "NO_TRADE"
          ? `The AI recommended ${recommendation.action}. No order was submitted.`
          : `Risk manager rejected the ${recommendation.action} recommendation.`;

      await completeAgentRun(agentRunId, {
        ordersSubmittedCount: 0,
        killSwitchActive: false,
        paperTrading: true,
        skippedReason,
        outputSnapshot: { recommendation, riskCheck, skippedReason },
      });

      return NextResponse.json({
        success: true,
        mode: "paper",
        recommendation,
        riskCheck,
        order: null,
        skippedReason,
        marketAnalysis,
        killSwitchActive: false,
        agentRunId,
        timestamp,
      });
    }

    const order = await placePaperMarketOrder(trade);

    await saveAlpacaOrderRef({ agentRunId, riskDecisionId, order });

    await completeAgentRun(agentRunId, {
      ordersSubmittedCount: order.deduplicated ? 0 : 1,
      killSwitchActive: false,
      paperTrading: true,
      outputSnapshot: {
        recommendation,
        riskCheck,
        order: {
          id: order.id,
          symbol: order.symbol,
          qty: order.qty,
          side: order.side,
          status: order.status,
        },
      },
    });

    return NextResponse.json({
      success: true,
      mode: "paper",
      recommendation,
      riskCheck,
      order,
      skippedReason: null,
      marketAnalysis,
      killSwitchActive: false,
      agentRunId,
      timestamp,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";

    await markAgentRunFailed(agentRunId, error);
    await recordErrorEvent({
      agentRunId,
      source: "api/agent/run",
      message,
    });

    return NextResponse.json(
      {
        success: false,
        mode: "paper",
        error: message,
        agentRunId,
        timestamp,
      },
      { status: 500 }
    );
  } finally {
    releaseOrderExecution?.();
  }
}
