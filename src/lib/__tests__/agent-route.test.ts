import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tryAcquireOrderExecutionLease } from "@/lib/order-execution-guard";

const mocks = vi.hoisted(() => ({
  describeRequestedTrade: vi.fn(),
  evaluateAgentTrade: vi.fn(),
  placePaperMarketOrder: vi.fn(),
  completeAgentRun: vi.fn(),
  markAgentRunFailed: vi.fn(),
  recordErrorEvent: vi.fn(),
  recordSkippedAgentRun: vi.fn(),
  saveAiRecommendation: vi.fn(),
  saveAlpacaOrderRef: vi.fn(),
  saveMarketAnalysisSummary: vi.fn(),
  saveRiskDecision: vi.fn(),
  startAgentRun: vi.fn(),
  isKillSwitchActive: vi.fn(),
}));

vi.mock("@/lib/agent", () => ({
  describeRequestedTrade: mocks.describeRequestedTrade,
  evaluateAgentTrade: mocks.evaluateAgentTrade,
}));

vi.mock("@/lib/alpaca", () => ({
  placePaperMarketOrder: mocks.placePaperMarketOrder,
}));

vi.mock("@/lib/openai-trader", () => ({
  OPENAI_TRADER_MODEL: "test-model",
}));

vi.mock("@/lib/persistence", () => ({
  completeAgentRun: mocks.completeAgentRun,
  markAgentRunFailed: mocks.markAgentRunFailed,
  recordErrorEvent: mocks.recordErrorEvent,
  recordSkippedAgentRun: mocks.recordSkippedAgentRun,
  saveAiRecommendation: mocks.saveAiRecommendation,
  saveAlpacaOrderRef: mocks.saveAlpacaOrderRef,
  saveMarketAnalysisSummary: mocks.saveMarketAnalysisSummary,
  saveRiskDecision: mocks.saveRiskDecision,
  startAgentRun: mocks.startAgentRun,
}));

vi.mock("@/lib/risk-manager", () => ({
  isKillSwitchActive: mocks.isKillSwitchActive,
}));

import { POST } from "@/app/api/agent/run/route";

describe("agent run route safety", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("ALPACA_ENDPOINT", "https://paper-api.alpaca.markets");
    mocks.recordSkippedAgentRun.mockResolvedValue("skipped-run-id");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("skips before evaluation and order placement when the kill switch is active", async () => {
    mocks.isKillSwitchActive.mockReturnValue(true);

    const response = await POST();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.killSwitchActive).toBe(true);
    expect(body.order).toBeNull();
    expect(mocks.evaluateAgentTrade).not.toHaveBeenCalled();
    expect(mocks.placePaperMarketOrder).not.toHaveBeenCalled();
  });

  it("rejects overlap before starting an agent run", async () => {
    mocks.isKillSwitchActive.mockReturnValue(false);
    const lease = tryAcquireOrderExecutionLease();
    expect(lease).not.toBeNull();

    try {
      const response = await POST();

      expect(response.status).toBe(409);
      expect(mocks.startAgentRun).not.toHaveBeenCalled();
      expect(mocks.evaluateAgentTrade).not.toHaveBeenCalled();
      expect(mocks.placePaperMarketOrder).not.toHaveBeenCalled();
    } finally {
      lease?.release();
    }
  });
});
