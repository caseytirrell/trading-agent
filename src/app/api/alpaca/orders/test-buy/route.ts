import { NextResponse } from "next/server";
import { placePaperMarketOrder } from "@/lib/alpaca";

export async function POST() {
  try {
    const order = await placePaperMarketOrder({
      symbol: "SPY",
      qty: 1,
      side: "buy",
    });

    return NextResponse.json({
      success: true,
      message: "Paper test order submitted.",
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