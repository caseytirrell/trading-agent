import { NextRequest, NextResponse } from "next/server";
import {
  getAlpacaAccount,
  getAlpacaClock,
  getAlpacaOrders,
  getAlpacaPositions,
  placePaperMarketOrder,
} from "@/lib/alpaca";
import { runRiskCheck, type TradeSide } from "@/lib/risk-manager";
import { tryAcquireOrderExecutionLease } from "@/lib/order-execution-guard";

export async function POST(request: NextRequest) {
  let releaseOrderExecution: (() => void) | null = null;

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
      side: side as TradeSide,
    };

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

    releaseOrderExecution = lease.release;

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
      message: order.deduplicated
        ? "Duplicate submission prevented; returning the existing paper order."
        : "Paper order submitted after passing risk check.",
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
    releaseOrderExecution?.();
  }
}
