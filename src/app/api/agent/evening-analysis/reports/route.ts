import { type NextRequest, NextResponse } from "next/server";
import { clampReportListLimit } from "@/lib/evening-report-history";
import { listEveningAnalysisReports } from "@/lib/persistence";

// Always serve live history state (and let the opportunistic expiration
// sweep run) — never a cached copy.
export const dynamic = "force-dynamic";

// GET /api/agent/evening-analysis/reports — saved Evening Analysis history.
//
// Read-only boundary (do not change): this route only reads
// evening_analysis_reports rows (plus a status-only expiration sweep). It
// never calls OpenAI or Alpaca, never places, queues, cancels, replaces, or
// modifies orders, never re-runs an analysis, and never exposes secrets.
// Validity (active vs expired vs never-revalidatable) is computed on the
// server; clients only display it.
export async function GET(request: NextRequest) {
  const limit = clampReportListLimit(
    request.nextUrl.searchParams.get("limit")
  );

  const result = await listEveningAnalysisReports(limit);

  if (!result.ok) {
    if (result.reason === "not_configured") {
      // Not an error: history is simply absent without a database.
      return NextResponse.json({
        success: true,
        readOnly: true,
        historyAvailable: false,
        reports: [],
        notice:
          "Database persistence is not configured, so no saved Evening Analysis history is available.",
      });
    }

    return NextResponse.json(
      {
        success: false,
        readOnly: true,
        historyAvailable: false,
        reports: [],
        error: "Saved Evening Analysis history is temporarily unavailable.",
      },
      { status: 503 }
    );
  }

  return NextResponse.json({
    success: true,
    readOnly: true,
    historyAvailable: true,
    reports: result.reports,
  });
}
