"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const MIN_INTERVAL_MINUTES = 15;
const DEFAULT_INTERVAL_MINUTES = 30;

type AgentRecommendation = {
  action: "BUY" | "SELL" | "HOLD" | "NO_TRADE";
  symbol: string | null;
  qty: number;
  confidence: number;
  reason: string;
};

type AgentRiskCheck = {
  approved: boolean;
  reasons: string[];
};

type AgentOrder = {
  id: string;
  symbol: string;
  qty: string;
  side: string;
  status: string;
  submittedAt: string;
};

type AgentRunResponse = {
  success: boolean;
  mode?: string;
  recommendation?: AgentRecommendation | null;
  riskCheck?: AgentRiskCheck | null;
  order?: AgentOrder | null;
  skippedReason?: string | null;
  killSwitchActive?: boolean;
  error?: string;
  timestamp?: string;
};

type AgentStatusResponse = {
  killSwitchActive: boolean;
  paperTrading: boolean;
};

const actionStyles: Record<AgentRecommendation["action"], string> = {
  BUY: "bg-green-950 text-green-300",
  SELL: "bg-red-950 text-red-300",
  HOLD: "bg-neutral-800 text-neutral-300",
  NO_TRADE: "bg-neutral-800 text-neutral-300",
};

function formatCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export default function AutonomousAgentCard() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<AgentRunResponse | null>(null);
  const [status, setStatus] = useState<AgentStatusResponse | null>(null);
  const [autoMode, setAutoMode] = useState(false);
  const [intervalInput, setIntervalInput] = useState(
    String(DEFAULT_INTERVAL_MINUTES)
  );
  const [nextRunAt, setNextRunAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Prevents overlapping runs when a run takes longer than expected.
  const runningRef = useRef(false);

  // Auto Mode never runs more often than every MIN_INTERVAL_MINUTES.
  const parsedInterval = Number(intervalInput);
  const intervalMinutes =
    Number.isFinite(parsedInterval) && parsedInterval > 0
      ? Math.max(MIN_INTERVAL_MINUTES, Math.floor(parsedInterval))
      : DEFAULT_INTERVAL_MINUTES;

  const killSwitchActive =
    lastRun?.killSwitchActive ?? status?.killSwitchActive ?? false;

  // Load kill switch / paper status on mount. This only reads server env
  // config — it never calls OpenAI or Alpaca.
  useEffect(() => {
    let cancelled = false;

    fetch("/api/agent/run", { cache: "no-store" })
      .then((response) => response.json())
      .then((data: AgentStatusResponse) => {
        if (cancelled) {
          return;
        }

        setStatus(data);

        // Auto Mode must stop whenever the kill switch is active.
        if (data.killSwitchActive) {
          setAutoMode(false);
          setNextRunAt(null);
        }
      })
      .catch(() => {
        // Status stays unknown; runs will still report it.
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const runAgent = useCallback(async () => {
    if (runningRef.current) {
      return;
    }

    runningRef.current = true;
    setLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/agent/run", {
        method: "POST",
      });

      let data: AgentRunResponse;

      try {
        data = await response.json();
      } catch {
        throw new Error("The server returned an invalid response.");
      }

      // Auto Mode must stop whenever the kill switch is active.
      if (data.killSwitchActive) {
        setAutoMode(false);
        setNextRunAt(null);
      }

      if (!response.ok || !data.success) {
        throw new Error(data.error || "Agent run failed. Please try again.");
      }

      setLastRun(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Agent run failed.");
    } finally {
      runningRef.current = false;
      setLoading(false);
    }
  }, []);

  // While Auto Mode is on, tick the countdown once per second and fire the
  // run when it reaches zero. All state updates happen inside the timer
  // callback, and the interval math guarantees runs are never closer
  // together than MIN_INTERVAL_MINUTES.
  useEffect(() => {
    if (!autoMode || nextRunAt === null) {
      return;
    }

    const timer = setInterval(() => {
      setNow(Date.now());

      if (Date.now() >= nextRunAt && !runningRef.current) {
        setNextRunAt(Date.now() + intervalMinutes * 60_000);
        void runAgent();
      }
    }, 1000);

    return () => clearInterval(timer);
  }, [autoMode, nextRunAt, intervalMinutes, runAgent]);

  function toggleAutoMode() {
    if (autoMode) {
      setAutoMode(false);
      setNextRunAt(null);
      return;
    }

    if (killSwitchActive) {
      return;
    }

    setAutoMode(true);
    setNow(Date.now());
    setNextRunAt(Date.now() + intervalMinutes * 60_000);
  }

  function handleIntervalChange(value: string) {
    setIntervalInput(value);

    // Reschedule the pending auto run against the new interval.
    if (autoMode) {
      const parsed = Number(value);
      const minutes =
        Number.isFinite(parsed) && parsed > 0
          ? Math.max(MIN_INTERVAL_MINUTES, Math.floor(parsed))
          : DEFAULT_INTERVAL_MINUTES;

      setNow(Date.now());
      setNextRunAt(Date.now() + minutes * 60_000);
    }
  }

  const recommendation = lastRun?.recommendation;
  const riskCheck = lastRun?.riskCheck;
  const countdownMs = nextRunAt !== null ? nextRunAt - now : null;

  return (
    <section className="rounded-2xl border border-neutral-800 bg-neutral-900 p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-sm uppercase tracking-wide text-purple-400">
            Autonomous Agent
          </p>
          <h2 className="text-2xl font-bold">Controlled Paper Trading Agent</h2>
        </div>

        <button
          type="button"
          onClick={() => void runAgent()}
          disabled={loading}
          className="rounded-xl bg-purple-600 px-5 py-2.5 font-semibold text-white transition hover:bg-purple-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? "Running Agent..." : "Run Agent Once"}
        </button>
      </div>

      {/* Paper trading warning */}
      <div className="rounded-xl border border-yellow-900 bg-yellow-950/40 p-4">
        <p className="text-sm text-yellow-200">
          <strong>Paper trading only.</strong> This agent uses a simulated
          Alpaca paper account — no real money is ever traded. Every trade must
          pass the risk manager, and the AI can only choose from the approved
          symbol list.
        </p>
      </div>

      {/* Kill switch status */}
      <div className="mt-4 flex items-center gap-2 text-sm">
        <span
          className={`inline-block h-2.5 w-2.5 rounded-full ${
            status === null && lastRun === null
              ? "bg-neutral-500"
              : killSwitchActive
                ? "bg-red-500"
                : "bg-green-500"
          }`}
        />
        <span className="text-neutral-300">
          Kill switch:{" "}
          <strong>
            {status === null && lastRun === null
              ? "Checking..."
              : killSwitchActive
                ? "Active — trading blocked"
                : "Inactive — trading allowed"}
          </strong>
        </span>
      </div>

      {/* Auto Mode controls */}
      <div className="mt-4 flex flex-wrap items-center gap-4 rounded-xl border border-neutral-800 bg-neutral-950 p-4">
        <button
          type="button"
          onClick={toggleAutoMode}
          disabled={!autoMode && killSwitchActive}
          className={`rounded-xl px-4 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${
            autoMode
              ? "bg-green-600 text-white hover:bg-green-500"
              : "bg-neutral-800 text-neutral-300 hover:bg-neutral-700"
          }`}
        >
          Auto Mode: {autoMode ? "On" : "Off"}
        </button>

        <label className="flex items-center gap-2 text-sm text-neutral-300">
          Interval (minutes)
          <input
            type="number"
            min={MIN_INTERVAL_MINUTES}
            step={1}
            value={intervalInput}
            onChange={(event) => handleIntervalChange(event.target.value)}
            className="w-20 rounded-lg border border-neutral-700 bg-neutral-900 px-2 py-1 text-white"
          />
        </label>

        <p className="text-sm text-neutral-400">
          {autoMode && countdownMs !== null
            ? `Next auto run in ${formatCountdown(countdownMs)} (every ${intervalMinutes} min).`
            : `Auto Mode is off. Minimum interval is ${MIN_INTERVAL_MINUTES} minutes.`}
        </p>
      </div>

      {error && (
        <div className="mt-6 rounded-xl border border-red-900 bg-red-950/40 p-4">
          <p className="font-semibold text-red-300">Agent run failed</p>
          <p className="mt-1 text-sm text-neutral-300">{error}</p>
        </div>
      )}

      {/* Latest run result */}
      {lastRun && recommendation && (
        <div className="mt-6 max-h-96 overflow-y-auto pr-2">
          <p className="text-sm text-neutral-400">
            Latest run{" "}
            {lastRun.timestamp
              ? `at ${new Date(lastRun.timestamp).toLocaleString()}`
              : ""}
          </p>

          <div className="mt-3 flex flex-wrap items-center gap-3">
            <span
              className={`rounded-full px-4 py-2 text-sm font-semibold ${actionStyles[recommendation.action]}`}
            >
              {recommendation.symbol
                ? `${recommendation.action} ${recommendation.symbol} × ${recommendation.qty}`
                : recommendation.action}
            </span>
            <span className="rounded-full bg-neutral-800 px-4 py-2 text-sm font-semibold text-neutral-300">
              Confidence {Math.round(recommendation.confidence * 100)}%
            </span>
            <span
              className={`rounded-full px-4 py-2 text-sm font-semibold ${
                lastRun.order
                  ? "bg-green-950 text-green-300"
                  : "bg-neutral-800 text-neutral-400"
              }`}
            >
              {lastRun.order ? "Paper order submitted" : "No order submitted"}
            </span>
          </div>

          <p className="mt-4 text-sm text-neutral-400">Reason</p>
          <p className="mt-1 text-neutral-200">{recommendation.reason}</p>

          {lastRun.order && (
            <div className="mt-4 rounded-xl border border-green-900 bg-green-950/40 p-4 text-sm text-neutral-200">
              <p className="font-semibold text-green-300">Order submitted</p>
              <p className="mt-1">
                {lastRun.order.side.toUpperCase()} {lastRun.order.qty}{" "}
                {lastRun.order.symbol} — status {lastRun.order.status} (id{" "}
                {lastRun.order.id})
              </p>
            </div>
          )}

          {lastRun.skippedReason && (
            <div className="mt-4 rounded-xl border border-neutral-700 bg-neutral-950 p-4 text-sm">
              <p className="font-semibold text-neutral-300">Skipped</p>
              <p className="mt-1 text-neutral-400">{lastRun.skippedReason}</p>
            </div>
          )}

          {riskCheck && !riskCheck.approved && riskCheck.reasons.length > 0 && (
            <div className="mt-4 rounded-xl border border-yellow-900 bg-yellow-950/40 p-4">
              <p className="font-semibold text-yellow-300">
                Risk manager result
              </p>
              <ul className="mt-2 list-inside list-disc text-sm text-neutral-300">
                {riskCheck.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* Kill-switch-only run (no recommendation was requested) */}
      {lastRun && !recommendation && lastRun.skippedReason && (
        <div className="mt-6 rounded-xl border border-neutral-700 bg-neutral-950 p-4 text-sm">
          <p className="font-semibold text-neutral-300">Skipped</p>
          <p className="mt-1 text-neutral-400">{lastRun.skippedReason}</p>
        </div>
      )}

      {!lastRun && !error && !loading && (
        <p className="mt-6 text-neutral-500">
          The agent has not run yet. Click “Run Agent Once” or turn on Auto
          Mode.
        </p>
      )}
    </section>
  );
}
