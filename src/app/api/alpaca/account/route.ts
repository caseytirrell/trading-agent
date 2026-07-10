import { NextResponse } from "next/server";

export async function GET() {
  try {
    const endpoint = process.env.ALPACA_ENDPOINT;
    const apiKey = process.env.ALPACA_API_KEY;
    const secretKey = process.env.ALPACA_SECRET_KEY;

    if (!endpoint || !apiKey || !secretKey) {
      return NextResponse.json(
        {
          error: "Missing Alpaca environment variables.",
          required: [
            "ALPACA_ENDPOINT",
            "ALPACA_API_KEY",
            "ALPACA_SECRET_KEY",
          ],
        },
        { status: 500 }
      );
    }

    const cleanEndpoint = endpoint.replace(/\/$/, "");
    const url = `${cleanEndpoint}/v2/account`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        "APCA-API-KEY-ID": apiKey,
        "APCA-API-SECRET-KEY": secretKey,
        "Content-Type": "application/json",
      },
      cache: "no-store",
    });

    const text = await response.text();

    let data: unknown;

    try {
      data = JSON.parse(text);
    } catch {
      return NextResponse.json(
        {
          error: "Alpaca did not return JSON.",
          status: response.status,
          requestedUrl: url,
          rawResponse: text,
        },
        { status: response.status }
      );
    }

    if (!response.ok) {
      return NextResponse.json(
        {
          error: "Failed to fetch Alpaca account.",
          status: response.status,
          requestedUrl: url,
          data,
        },
        { status: response.status }
      );
    }

    const account = data as {
      account_number?: string;
      status?: string;
      currency?: string;
      buying_power?: string;
      portfolio_value?: string;
    };

    return NextResponse.json({
      accountNumber: account.account_number,
      status: account.status,
      currency: account.currency,
      buyingPower: account.buying_power,
      portfolioValue: account.portfolio_value,
      paper: cleanEndpoint.includes("paper-api"),
      requestedUrl: url,
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
