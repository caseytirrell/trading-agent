type OrderExecutionState = {
  active: boolean;
};

type OrderExecutionLease = {
  release: () => void;
};

// One shared guard per Node.js process, including across Next.js development
// reloads and warm server instances. Alpaca client_order_id provides the
// second, broker-side duplicate barrier for repeated order intents.
const globalForOrderExecution = globalThis as unknown as {
  paperOrderExecutionState?: OrderExecutionState;
};

function getOrderExecutionState(): OrderExecutionState {
  if (!globalForOrderExecution.paperOrderExecutionState) {
    globalForOrderExecution.paperOrderExecutionState = { active: false };
  }

  return globalForOrderExecution.paperOrderExecutionState;
}

/**
 * Attempts to reserve the single paper-order execution lane for this server
 * process. Callers must release the lease in a finally block.
 */
export function tryAcquireOrderExecutionLease(): OrderExecutionLease | null {
  const state = getOrderExecutionState();

  if (state.active) {
    return null;
  }

  state.active = true;
  let released = false;

  return {
    release() {
      if (released) {
        return;
      }

      released = true;
      state.active = false;
    },
  };
}
