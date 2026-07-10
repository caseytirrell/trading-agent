import { NextRequest, NextResponse } from "next/server";
import { placePaperMarketOrder } from "@/lib/alpaca";
import { runRiskCheck } from "@/lib/risk-manager";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    const symbol = String(body.symbol || "").toUpperCase();
    const qty = Number(body.qty);
    const side = String(body.side || "").toLowerCase();

    if (side !== "buy" && side !== "sell") {
      return NextResponse.json(
        {
          success: false,
          error: "Invalid side. Must be buy or sell.",
        },
        { status: 400 }
      );
    }

    const tradeRequest = {
      symbol,
      qty,
      side,
    };

    const riskCheck = runRiskCheck(tradeRequest);

    if (!riskCheck.approved) {
      return NextResponse.json(
        {
          success: false,
          error: "Trade rejected by risk manager.",
          reasons: riskCheck.reasons,
          tradeRequest,
        },
        { status: 400 }
      );
    }

    const order = await placePaperMarketOrder(tradeRequest);

    return NextResponse.json({
      success: true,
      message: "Paper order submitted after passing risk check.",
      riskCheck,
      order,
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