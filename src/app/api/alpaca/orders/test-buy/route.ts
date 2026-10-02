import { NextResponse } from "next/server";
import {
  getAlpacaAccount,
  getAlpacaClock,
  getAlpacaOrders,
  getAlpacaPositions,
  placePaperMarketOrder,
} from "@/lib/alpaca";
import { runRiskCheck } from "@/lib/risk-manager";
import { tryAcquireOrderExecutionLease } from "@/lib/order-execution-guard";

export async function POST() {
  const lease = tryAcquireOrderExecutionLease();

  if (!lease) {
    return NextResponse.json(
      {
        success: false,
        error: "Another order-capable request is already running.",
      },
      { status: 409 }
    );
  }

  try {
    const tradeRequest = {
      symbol: "SPY",
      qty: 1,
      side: "buy" as const,
    };

    const [account, positions, recentOrders, marketClock] = await Promise.all([
      getAlpacaAccount(),
      getAlpacaPositions(),
      getAlpacaOrders(),
      getAlpacaClock(),
    ]);

    const riskCheck = runRiskCheck({
      trade: tradeRequest,
      account,
      positions,
      recentOrders,
      marketClock,
    });

    if (!riskCheck.approved) {
      return NextResponse.json(
        {
          success: false,
          error: "Test trade rejected by risk manager.",
          reasons: riskCheck.reasons,
        },
        { status: 400 }
      );
    }

    const order = await placePaperMarketOrder(tradeRequest);

    return NextResponse.json({
      success: true,
      message: order.deduplicated
        ? "Duplicate test submission prevented; returning the existing paper order."
        : "Paper test order submitted after passing risk check.",
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
  } finally {
    lease.release();
  }
}
