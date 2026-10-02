import { NextResponse } from "next/server";

export async function GET() {
  try {
    const endpoint = process.env.ALPACA_ENDPOINT;
    const apiKey = process.env.ALPACA_API_KEY;
    const secretKey = process.env.ALPACA_SECRET_KEY;

    if (!endpoint || !apiKey || !secretKey) {
      return NextResponse.json(
        { error: "Missing Alpaca environment variables." },
        { status: 500 }
      );
    }

    const response = await fetch(
      `${endpoint}/v2/orders?status=all&limit=50&direction=desc`,
      {
        method: "GET",
        headers: {
          "APCA-API-KEY-ID": apiKey,
          "APCA-API-SECRET-KEY": secretKey,
          "Content-Type": "application/json",
        },
        cache: "no-store",
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return NextResponse.json(
        {
          error: "Failed to fetch orders.",
          status: response.status,
          data,
        },
        { status: response.status }
      );
    }

    type RawOrder = {
      id: string;
      symbol: string;
      qty: string;
      side: string;
      type: string;
      time_in_force: string;
      status: string;
      filled_qty: string;
      filled_avg_price: string | null;
      submitted_at: string;
      filled_at: string | null;
      expired_at: string | null;
      canceled_at: string | null;
      failed_at: string | null;
    };

    return NextResponse.json({
      orders: (data as RawOrder[]).map((order) => ({
        id: order.id,
        symbol: order.symbol,
        qty: order.qty,
        side: order.side,
        type: order.type,
        timeInForce: order.time_in_force,
        status: order.status,
        filledQty: order.filled_qty,
        filledAvgPrice: order.filled_avg_price,
        submittedAt: order.submitted_at,
        filledAt: order.filled_at,
        expiredAt: order.expired_at,
        canceledAt: order.canceled_at,
        failedAt: order.failed_at,
      })),
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Unexpected server error.",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
