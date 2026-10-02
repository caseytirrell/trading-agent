import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { tryAcquireOrderExecutionLease } from "@/lib/order-execution-guard";

const mocks = vi.hoisted(() => ({
  getAlpacaAccount: vi.fn(),
  getAlpacaClock: vi.fn(),
  getAlpacaOrders: vi.fn(),
  getAlpacaPositions: vi.fn(),
  placePaperMarketOrder: vi.fn(),
  runRiskCheck: vi.fn(),
}));

vi.mock("@/lib/alpaca", () => ({
  getAlpacaAccount: mocks.getAlpacaAccount,
  getAlpacaClock: mocks.getAlpacaClock,
  getAlpacaOrders: mocks.getAlpacaOrders,
  getAlpacaPositions: mocks.getAlpacaPositions,
  placePaperMarketOrder: mocks.placePaperMarketOrder,
}));

vi.mock("@/lib/risk-manager", () => ({
  runRiskCheck: mocks.runRiskCheck,
}));

import { POST } from "@/app/api/alpaca/orders/place/route";

function request() {
  return new NextRequest("http://localhost/api/alpaca/orders/place", {
    method: "POST",
    body: JSON.stringify({ symbol: "AAPL", qty: 1, side: "buy" }),
    headers: { "Content-Type": "application/json" },
  });
}

describe("manual order route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAlpacaAccount.mockResolvedValue({});
    mocks.getAlpacaClock.mockResolvedValue({});
    mocks.getAlpacaOrders.mockResolvedValue([]);
    mocks.getAlpacaPositions.mockResolvedValue([]);
  });

  it("never calls Alpaca order placement when the risk manager rejects", async () => {
    mocks.runRiskCheck.mockReturnValue({
      approved: false,
      reasons: ["Trading is disabled (kill switch is active)."],
    });

    const response = await POST(request());

    expect(response.status).toBe(400);
    expect(mocks.placePaperMarketOrder).not.toHaveBeenCalled();
  });

  it("rejects overlapping order-capable requests before fetching Alpaca data", async () => {
    const lease = tryAcquireOrderExecutionLease();
    expect(lease).not.toBeNull();

    try {
      const response = await POST(request());

      expect(response.status).toBe(409);
      expect(mocks.getAlpacaAccount).not.toHaveBeenCalled();
      expect(mocks.placePaperMarketOrder).not.toHaveBeenCalled();
    } finally {
      lease?.release();
    }
  });
});
