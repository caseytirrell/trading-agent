import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildPaperOrderClientId,
  placePaperMarketOrder,
} from "@/lib/alpaca";

const trade = { symbol: "AAPL", qty: 1, side: "buy" as const };
const rawOrder = {
  id: "order-123",
  client_order_id: "cta-20260928-AAPL-buy-1",
  symbol: "AAPL",
  qty: "1",
  side: "buy",
  type: "market",
  time_in_force: "day",
  status: "accepted",
  submitted_at: "2026-09-28T14:00:00Z",
};

describe("paper order idempotency", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-28T18:00:00Z"));
    vi.stubEnv("ALPACA_ENDPOINT", "https://paper-api.alpaca.markets");
    vi.stubEnv("ALPACA_API_KEY", "paper-key");
    vi.stubEnv("ALPACA_SECRET_KEY", "paper-secret");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("builds a stable id from the Eastern trading date and trade intent", () => {
    const first = buildPaperOrderClientId(
      trade,
      new Date("2026-09-29T01:00:00Z")
    );
    const second = buildPaperOrderClientId(
      trade,
      new Date("2026-09-29T02:00:00Z")
    );

    expect(first).toBe("cta-20260928-AAPL-buy-1");
    expect(second).toBe(first);
  });

  it("does not collapse distinct fractional quantities into the same id", () => {
    const now = new Date("2026-09-28T18:00:00Z");

    expect(buildPaperOrderClientId({ ...trade, qty: 1.5 }, now)).not.toBe(
      buildPaperOrderClientId({ ...trade, qty: 15 }, now)
    );
  });

  it("submits the deterministic client_order_id to Alpaca", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(rawOrder), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await placePaperMarketOrder(trade);
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body));

    expect(body.client_order_id).toMatch(/^cta-\d{8}-AAPL-buy-1$/);
    expect(result.deduplicated).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns the existing order when Alpaca rejects a duplicate id", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "client_order_id must be unique" }), {
          status: 422,
          headers: { "Content-Type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(rawOrder), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await placePaperMarketOrder(trade);

    expect(result.deduplicated).toBe(true);
    expect(result.id).toBe("order-123");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
      "/v2/orders:by_client_order_id?client_order_id="
    );
  });
});
