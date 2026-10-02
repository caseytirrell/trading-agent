"use client";

import { useState } from "react";

type Recommendation = {
  action: "BUY" | "SELL" | "HOLD" | "NO_TRADE";
  symbol: string | null;
  qty: number;
  confidence: number;
  reason: string;
};

type RiskCheck = {
  approved: boolean;
  reasons: string[];
};

type RecommendationResponse = {
  success: boolean;
  recommendation?: Recommendation;
  riskCheck?: RiskCheck;
  executable?: boolean;
  error?: string;
};

const actionStyles: Record<Recommendation["action"], string> = {
  BUY: "bg-green-950 text-green-300",
  SELL: "bg-red-950 text-red-300",
  HOLD: "bg-neutral-800 text-neutral-300",
  NO_TRADE: "bg-neutral-800 text-neutral-300",
};

export default function AiRecommendationCard() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RecommendationResponse | null>(null);

  async function askAi() {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/openai/recommendation", {
        method: "POST",
        cache: "no-store",
      });

      let data: RecommendationResponse;

      try {
        data = await response.json();
      } catch {
        throw new Error("The server returned an invalid response.");
      }

      if (!response.ok || !data.success) {
        throw new Error(
          data.error || "The AI recommendation request failed. Please try again."
        );
      }

      if (!data.recommendation || !data.riskCheck) {
        throw new Error("The AI returned an incomplete recommendation.");
      }

      setResult(data);
    } catch (err) {
      setResult(null);
      setError(
        err instanceof Error
          ? err.message
          : "Something went wrong requesting a recommendation."
      );
    } finally {
      setLoading(false);
    }
  }

  const recommendation = result?.recommendation;
  const riskCheck = result?.riskCheck;

  return (
    <section className="rounded-2xl border border-neutral-800 bg-neutral-900 p-6">
      <div className="mb-4 flex items-center justify-between gap-4">
        <div>
          <p className="text-sm uppercase tracking-wide text-blue-400">
            AI Recommendation
          </p>
          <h2 className="text-2xl font-bold">OpenAI Trade Idea</h2>
        </div>

        <button
          type="button"
          onClick={askAi}
          disabled={loading}
          className="rounded-xl bg-blue-600 px-5 py-2.5 font-semibold text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? "Asking AI..." : "Ask AI for Recommendation"}
        </button>
      </div>

      <p className="text-sm text-neutral-400">
        Recommendations are informational only and are never executed
        automatically. Executable trades must pass the risk manager and paper
        trading checks.
      </p>

      {error && (
        <div className="mt-6 rounded-xl border border-red-900 bg-red-950/40 p-4">
          <p className="font-semibold text-red-300">Request failed</p>
          <p className="mt-1 text-sm text-neutral-300">{error}</p>
        </div>
      )}

      {recommendation && riskCheck && (
        <div className="mt-6 max-h-96 overflow-y-auto pr-2">
          <div className="mb-4 flex items-center gap-3">
            <span
              className={`rounded-full px-4 py-2 text-sm font-semibold ${actionStyles[recommendation.action]}`}
            >
              {recommendation.action}
            </span>
            <span
              className={`rounded-full px-4 py-2 text-sm font-semibold ${
                result?.executable
                  ? "bg-green-950 text-green-300"
                  : "bg-neutral-800 text-neutral-400"
              }`}
            >
              {result?.executable ? "Executable" : "Not executable"}
            </span>
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            <div>
              <p className="text-sm text-neutral-400">Symbol</p>
              <p className="mt-1 text-xl font-semibold">
                {recommendation.symbol ?? "—"}
              </p>
            </div>

            <div>
              <p className="text-sm text-neutral-400">Qty</p>
              <p className="mt-1 text-xl font-semibold">{recommendation.qty}</p>
            </div>

            <div>
              <p className="text-sm text-neutral-400">Confidence</p>
              <p className="mt-1 text-xl font-semibold">
                {Math.round(recommendation.confidence * 100)}%
              </p>
            </div>
          </div>

          <div className="mt-6">
            <p className="text-sm text-neutral-400">Reason</p>
            <p className="mt-2 text-neutral-200">{recommendation.reason}</p>
          </div>

          {!riskCheck.approved && (
            <div className="mt-6 rounded-xl border border-yellow-900 bg-yellow-950/40 p-4">
              <p className="font-semibold text-yellow-300">Not executable</p>
              <ul className="mt-2 list-inside list-disc text-sm text-neutral-300">
                {riskCheck.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {!recommendation && !error && !loading && (
        <p className="mt-6 text-neutral-500">
          No recommendation requested yet. Click the button to ask the AI.
        </p>
      )}
    </section>
  );
}
