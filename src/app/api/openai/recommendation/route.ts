import { NextResponse } from "next/server";
import { getOpenAITradeRecommendation } from "@/lib/openai-trader";
import { runRiskCheck } from "@/lib/risk-manager";

export async function GET() {
  try {
    const recommendation = await getOpenAITradeRecommendation();

    if (
      recommendation.action === "HOLD" ||
      recommendation.action === "NO_TRADE"
    ) {
      return NextResponse.json({
        success: true,
        recommendation,
        riskCheck: {
          approved: false,
          reasons: ["OpenAI recommended no executable trade."],
        },
        executable: false,
      });
    }

    const riskCheck = runRiskCheck({
      symbol: recommendation.symbol,
      qty: recommendation.qty,
      side: recommendation.action === "BUY" ? "buy" : "sell",
    });

    return NextResponse.json({
      success: true,
      recommendation,
      riskCheck,
      executable: riskCheck.approved,
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}