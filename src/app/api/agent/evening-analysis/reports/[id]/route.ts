import { type NextRequest, NextResponse } from "next/server";
import { getEveningAnalysisReport } from "@/lib/persistence";

// Always serve live history state (and let the opportunistic expiration
// sweep run) — never a cached copy.
export const dynamic = "force-dynamic";

// GET /api/agent/evening-analysis/reports/[id] — one saved report with its
// candidates and data-freshness details.
//
// Read-only boundary (do not change): this route only reads persisted rows.
// It never calls OpenAI or Alpaca, never places, queues, cancels, replaces,
// or modifies orders, never re-runs an analysis, and never exposes secrets.
//
// The browser-supplied id is validated server-side before any lookup.
// Expired reports ARE returned — explicitly flagged via the server-computed
// validity fields — because this endpoint serves the read-only history
// view. It is NOT a revalidation endpoint: any future flow that wants a
// report to act on must use the fail-closed
// getLatestValidEveningAnalysisReport helper, which refuses expired or
// undeterminable reports outright.
export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;

  const result = await getEveningAnalysisReport(id);

  if (!result.ok) {
    if (result.reason === "invalid_id") {
      return NextResponse.json(
        {
          success: false,
          readOnly: true,
          error: "The report id is not a valid report identifier.",
        },
        { status: 400 }
      );
    }

    if (result.reason === "not_found") {
      return NextResponse.json(
        {
          success: false,
          readOnly: true,
          error: "No saved Evening Analysis report exists with this id.",
        },
        { status: 404 }
      );
    }

    return NextResponse.json(
      {
        success: false,
        readOnly: true,
        error: "Saved Evening Analysis history is temporarily unavailable.",
      },
      { status: 503 }
    );
  }

  // The analysis-only trio mirrors the live Evening Analysis contract:
  // nothing served from history is, or can become, an order.
  return NextResponse.json({
    success: true,
    readOnly: true,
    analysisOnly: true,
    ordersSubmitted: 0,
    ordersQueued: 0,
    report: result.report,
  });
}
