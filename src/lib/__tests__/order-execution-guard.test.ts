import { describe, expect, it } from "vitest";
import { tryAcquireOrderExecutionLease } from "@/lib/order-execution-guard";

describe("order execution guard", () => {
  it("allows only one order-capable request at a time", () => {
    const first = tryAcquireOrderExecutionLease();

    expect(first).not.toBeNull();
    expect(tryAcquireOrderExecutionLease()).toBeNull();

    first?.release();

    const next = tryAcquireOrderExecutionLease();
    expect(next).not.toBeNull();
    next?.release();
  });

  it("allows a lease to be released more than once safely", () => {
    const lease = tryAcquireOrderExecutionLease();
    expect(lease).not.toBeNull();

    lease?.release();
    lease?.release();

    const next = tryAcquireOrderExecutionLease();
    expect(next).not.toBeNull();
    next?.release();
  });
});
