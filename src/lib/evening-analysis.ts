import {
  getAlpacaAccount,
  getAlpacaClock,
  getAlpacaOrders,
  getAlpacaPositions,
  getDailyBars,
  type AlpacaClock,
} from "@/lib/alpaca";
import {
  analyzeMarket,
  MIN_BUY_SCORE,
  qualifiesForNewBuy,
  summarizeAnalysis,
  type CandidateEvaluation,
  type CandidateScores,
  type MarketAnalysisSummary,
  type MarketRegime,
} from "@/lib/market-analysis";
import {
  getOpenAIEveningWatchlist,
  type EveningWatchlistModelCandidate,
} from "@/lib/openai-trader";
import { APPROVED_SYMBOLS, isApprovedSymbol, type ApprovedSymbol } from "@/lib/trading-universe";

// Evening Analysis (Phase 1): a manual, read-only, next-session analysis.
//
// Import boundary (do not change): this module must never import
// placePaperMarketOrder, evaluateAgentTrade, runRiskCheck, or any order
// route. It only reads Alpaca account/market data, runs the deterministic
// market analysis, and asks OpenAI to assess the app-selected candidates.
// The only actions that exist here are WATCH, MONITOR, and NO_TRADE — no
// output of this module can describe an executable order. This module itself
// persists nothing; the API route stores the finished result as a read-only
// audit record (Phase 2), which is never read back as a trade instruction.
//
// Selection model: "informational ranking" is deliberately separate from
// "eligible new buy". Strict candidates (every mandatory filter passed AND
// score >= MIN_BUY_SCORE) fill the list first and are the only ones that can
// ever be WATCH. When fewer than MAX_EVENING_WATCHLIST_SIZE strict candidates
// exist, the highest-scoring remaining approved symbols are added as
// informational fallbacks (near misses, held positions, blocked symbols) so
// the analysis stays useful — capped at MONITOR and clearly labeled as not
// eligible for a new buy.

/** Why a candidate was included in the evening selection. */
export type EveningInclusionType =
  | "STRICT_WATCH" // passed every strict new-buy filter, score >= MIN_BUY_SCORE
  | "NEAR_MISS" // eligible for a new buy but scored below MIN_BUY_SCORE
  | "HELD_MONITOR" // ranks highly but the position is already held
  | "BLOCKED_MONITOR"; // ranks highly but a mandatory filter blocks a new buy

/** A deterministic evaluation annotated with its evening selection context. */
export type EveningSelectedCandidate = {
  evaluation: CandidateEvaluation;
  inclusionType: EveningInclusionType;
  /** Plain-English explanation of why this candidate is shown. */
  inclusionReason: string;
  /** True when every mandatory new-buy filter passed (score aside). */
  eligibleForNewBuy: boolean;
  /** True when the total score reached MIN_BUY_SCORE. */
  passedScoreThreshold: boolean;
  /** Binding cap on the model's action: WATCH only for strict candidates. */
  maxAction: "WATCH" | "MONITOR";
};

export type EveningAnalysisCandidate = {
  symbol: ApprovedSymbol;
  /**
   * WATCH = strict new-buy candidate worth monitoring at the next open.
   * MONITOR = informational only — NOT eligible for a new buy right now.
   * NO_TRADE = dropped. Nothing here is ever executable.
   */
  action: "WATCH" | "MONITOR" | "NO_TRADE";
  status: "watch" | "monitor" | "rejected";
  /** 1-based position in the evening selection (strict first, then score). */
  rank: number;
  confidence: number;
  /** Deterministic total score (0-100); the AI can never change it. */
  deterministicScore: number;
  /** Deterministic score components behind deterministicScore. */
  scoreComponents: CandidateScores;
  /** The strict threshold (MIN_BUY_SCORE) the score is compared against. */
  scoreThreshold: number;
  passedScoreThreshold: boolean;
  /** True when every mandatory new-buy filter passed (score aside). */
  eligibleForNewBuy: boolean;
  inclusionType: EveningInclusionType;
  inclusionReason: string;
  /** Deterministic reasons a new buy is blocked; empty when eligible. */
  blockingReasons: string[];
  thesis: string;
  supportingFactors: string[];
  riskFactors: string[];
  invalidationConditions: string[];
  proposedEntryRange: string | null;
  maximumEntryPrice: number | null;
  /** Latest close from the deterministic metrics, for reference display. */
  currentReferencePrice: number | null;
};

export type EveningAnalysisResult = {
  /** Structural guarantee: Phase 1 has no order path at all. */
  analysisOnly: true;
  ordersSubmitted: 0;
  ordersQueued: 0;
  safetyNotice: string;
  generatedAt: string;
  /** Eastern calendar date of the next session open, when determinable. */
  intendedSessionDate: string | null;
  marketStatus: "open" | "closed";
  marketStatusLabel: string;
  marketRegime: MarketRegime;
  regimeReasons: string[];
  /** Deterministic note on the selection composition (strict vs informational). */
  selectionNotice: string;
  summary: string;
  warnings: string[];
  candidates: EveningAnalysisCandidate[];
  /** Compact deterministic analysis view (same shape as the agent routes). */
  marketAnalysis: MarketAnalysisSummary;
};

/** The candidate list is intentionally small; quality over coverage. */
export const MAX_EVENING_WATCHLIST_SIZE = 3;

export const EVENING_ANALYSIS_SAFETY_NOTICE =
  "Analysis only. No order was placed, queued, canceled, or modified. This watchlist is informational, is stored only as read-only run history, and must be revalidated against live data before any trade decision.";

/**
 * Strict deterministic shortlist: approved symbols that passed every
 * mandatory filter and reached MIN_BUY_SCORE, ranked by total score. These
 * are the only candidates that can ever be labeled WATCH. The AI can never
 * add to this list; it can only assess what is on it.
 */
export function buildEveningCandidateShortlist(
  candidates: CandidateEvaluation[],
  maxCandidates: number = MAX_EVENING_WATCHLIST_SIZE
): CandidateEvaluation[] {
  return candidates
    .filter(
      (candidate) =>
        isApprovedSymbol(candidate.symbol) && qualifiesForNewBuy(candidate)
    )
    .sort((a, b) => b.scores.total - a.scores.total)
    .slice(0, Math.max(0, maxCandidates));
}

/** Annotates a selected evaluation with why it is shown and its action cap. */
export function classifyEveningCandidate(
  evaluation: CandidateEvaluation
): Omit<EveningSelectedCandidate, "evaluation"> {
  const total = evaluation.scores.total;
  const eligibleForNewBuy = evaluation.eligible;
  const passedScoreThreshold = total >= MIN_BUY_SCORE;

  if (qualifiesForNewBuy(evaluation)) {
    return {
      inclusionType: "STRICT_WATCH",
      inclusionReason: `Passed every strict new-buy filter with a total score of ${total} (threshold ${MIN_BUY_SCORE}).`,
      eligibleForNewBuy,
      passedScoreThreshold,
      maxAction: "WATCH",
    };
  }

  if (evaluation.rejectionCodes.includes("HELD")) {
    return {
      inclusionType: "HELD_MONITOR",
      inclusionReason: `Ranks among the top approved symbols (score ${total}), but the position is already held — informational only, not eligible for an additional buy.`,
      eligibleForNewBuy,
      passedScoreThreshold,
      maxAction: "MONITOR",
    };
  }

  if (evaluation.rejectionReasons.length > 0) {
    return {
      inclusionType: "BLOCKED_MONITOR",
      inclusionReason: `Ranks among the top approved symbols (score ${total}), but a new buy is blocked: ${evaluation.rejectionReasons.join(" ")}`,
      eligibleForNewBuy,
      passedScoreThreshold,
      maxAction: "MONITOR",
    };
  }

  return {
    inclusionType: "NEAR_MISS",
    inclusionReason: `Eligible for a new buy, but its total score of ${total} is below the required ${MIN_BUY_SCORE} — informational only.`,
    eligibleForNewBuy,
    passedScoreThreshold,
    maxAction: "MONITOR",
  };
}

/**
 * Evening selection: strict candidates first (the only possible WATCHes),
 * then the highest-scoring remaining approved symbols with healthy metrics
 * as informational fallbacks, up to maxCandidates total. Fallbacks keep the
 * analysis useful when nothing passes the strict filters — held positions
 * such as broad indexes stay visible instead of being silently hidden — but
 * they are capped at MONITOR and labeled as not eligible for a new buy.
 */
export function selectEveningCandidates(
  candidates: CandidateEvaluation[],
  maxCandidates: number = MAX_EVENING_WATCHLIST_SIZE
): EveningSelectedCandidate[] {
  const strict = buildEveningCandidateShortlist(candidates, maxCandidates);
  const strictSymbols = new Set(strict.map((candidate) => candidate.symbol));

  const fallback = candidates
    .filter(
      (candidate) =>
        isApprovedSymbol(candidate.symbol) &&
        candidate.metrics !== null &&
        !strictSymbols.has(candidate.symbol)
    )
    .sort((a, b) => b.scores.total - a.scores.total)
    .slice(0, Math.max(0, maxCandidates - strict.length));

  return [...strict, ...fallback].map((evaluation) => ({
    evaluation,
    ...classifyEveningCandidate(evaluation),
  }));
}

/**
 * Eastern calendar date of the next session open. Alpaca reports the clock
 * as Eastern-offset ISO timestamps, so the leading 10 characters are the
 * session's local date.
 */
export function deriveIntendedSessionDate(clock: AlpacaClock): string | null {
  const nextOpen = clock.nextOpen;

  if (typeof nextOpen !== "string" || Number.isNaN(Date.parse(nextOpen))) {
    return null;
  }

  return nextOpen.slice(0, 10);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function referencePriceOf(candidate: CandidateEvaluation): number | null {
  return candidate.metrics ? round2(candidate.metrics.latestPrice) : null;
}

/** Fail-closed candidate used when no validated AI assessment exists. */
function failClosedCandidate(
  selected: EveningSelectedCandidate,
  rank: number,
  thesis: string
): EveningAnalysisCandidate {
  const { evaluation } = selected;

  return {
    symbol: evaluation.symbol,
    action: "NO_TRADE",
    status: "rejected",
    rank,
    confidence: 0,
    deterministicScore: evaluation.scores.total,
    scoreComponents: evaluation.scores,
    scoreThreshold: MIN_BUY_SCORE,
    passedScoreThreshold: selected.passedScoreThreshold,
    eligibleForNewBuy: selected.eligibleForNewBuy,
    inclusionType: selected.inclusionType,
    inclusionReason: selected.inclusionReason,
    blockingReasons: evaluation.rejectionReasons,
    thesis,
    supportingFactors: [],
    riskFactors: [],
    invalidationConditions: [],
    proposedEntryRange: null,
    maximumEntryPrice: null,
    currentReferencePrice: referencePriceOf(evaluation),
  };
}

const ACTION_RANK: Record<EveningAnalysisCandidate["action"], number> = {
  NO_TRADE: 0,
  MONITOR: 1,
  WATCH: 2,
};

/**
 * Merges validated model output onto the deterministic selection. The
 * selection is authoritative: rank, scores, and labels come from the
 * deterministic ordering, selected symbols the model skipped fail closed to
 * NO_TRADE, and symbols outside the selection can never appear (they are
 * never looked up). The action cap is re-checked here as defense in depth
 * even though validateEveningWatchlist already enforced it: WATCH is only
 * possible for strict new-buy candidates, everything else tops out at
 * MONITOR, and entry levels only survive on WATCH.
 */
export function mergeWatchlistCandidates(
  selection: EveningSelectedCandidate[],
  modelCandidates: EveningWatchlistModelCandidate[]
): EveningAnalysisCandidate[] {
  const modelBySymbol = new Map(
    modelCandidates.map((candidate) => [candidate.symbol, candidate])
  );

  return selection.map((selected, index) => {
    const rank = index + 1;
    const { evaluation } = selected;
    const model = modelBySymbol.get(evaluation.symbol);

    if (!model) {
      return failClosedCandidate(
        selected,
        rank,
        "The AI returned no assessment for this selected candidate; failing closed to NO_TRADE."
      );
    }

    const cap: EveningAnalysisCandidate["action"] = qualifiesForNewBuy(
      evaluation
    )
      ? "WATCH"
      : "MONITOR";

    let action: EveningAnalysisCandidate["action"] = model.action;

    if (ACTION_RANK[action] > ACTION_RANK[cap]) {
      action = cap;
    }

    if (
      action !== "NO_TRADE" &&
      (model.supportingFactors.length === 0 ||
        model.invalidationConditions.length === 0)
    ) {
      action = "NO_TRADE";
    }

    const status: EveningAnalysisCandidate["status"] =
      action === "WATCH" ? "watch" : action === "MONITOR" ? "monitor" : "rejected";

    return {
      symbol: evaluation.symbol,
      action,
      status,
      rank,
      confidence: model.confidence,
      deterministicScore: evaluation.scores.total,
      scoreComponents: evaluation.scores,
      scoreThreshold: MIN_BUY_SCORE,
      passedScoreThreshold: selected.passedScoreThreshold,
      eligibleForNewBuy: selected.eligibleForNewBuy,
      inclusionType: selected.inclusionType,
      inclusionReason: selected.inclusionReason,
      blockingReasons: evaluation.rejectionReasons,
      thesis: model.thesis,
      supportingFactors: model.supportingFactors,
      riskFactors: model.riskFactors,
      invalidationConditions: model.invalidationConditions,
      proposedEntryRange: action === "WATCH" ? model.proposedEntryRange : null,
      maximumEntryPrice: action === "WATCH" ? model.maximumEntryPrice : null,
      currentReferencePrice: referencePriceOf(evaluation),
    };
  });
}

/**
 * One full Evening Analysis run: fetch live read-only paper account and
 * market data, run the deterministic market analysis, select strict plus
 * informational candidates, and ask OpenAI to assess them for the next
 * session. Fails closed at every stage (bad data, empty selection, AI
 * failure) and never places, queues, or modifies an order.
 */
export async function runEveningAnalysis(): Promise<EveningAnalysisResult> {
  const [account, positions, recentOrders, marketClock, dailyBars] =
    await Promise.all([
      getAlpacaAccount(),
      getAlpacaPositions(),
      getAlpacaOrders(),
      getAlpacaClock(),
      getDailyBars([...APPROVED_SYMBOLS]),
    ]);

  const analysis = analyzeMarket({
    bars: dailyBars,
    account,
    positions,
    recentOrders,
  });

  const marketStatus: EveningAnalysisResult["marketStatus"] = marketClock.isOpen
    ? "open"
    : "closed";

  const base = {
    analysisOnly: true as const,
    ordersSubmitted: 0 as const,
    ordersQueued: 0 as const,
    safetyNotice: EVENING_ANALYSIS_SAFETY_NOTICE,
    generatedAt: new Date().toISOString(),
    intendedSessionDate: deriveIntendedSessionDate(marketClock),
    marketStatus,
    marketStatusLabel: marketClock.isOpen
      ? "Market is open — this watchlist targets the next session, not the live one."
      : `Market is closed. Next open: ${marketClock.nextOpen}.`,
    marketRegime: analysis.regime,
    regimeReasons: analysis.regimeReasons,
    marketAnalysis: summarizeAnalysis(analysis),
  };

  const warnings: string[] = [];

  // Fail closed without consulting the model when any required market data
  // is missing, stale, or inconsistent.
  if (analysis.forceNoTrade) {
    return {
      ...base,
      selectionNotice:
        "No candidates were selected: required market data failed validation.",
      summary:
        "No watchlist was generated: required market data is missing, stale, or inconsistent, so the analysis fails closed without consulting the AI.",
      warnings: [...analysis.dataIssues, ...warnings],
      candidates: [],
    };
  }

  const selection = selectEveningCandidates(analysis.candidates);

  if (selection.length === 0) {
    // Practically unreachable (missing metrics already force forceNoTrade),
    // but fail closed rather than consult the model with nothing.
    return {
      ...base,
      selectionNotice:
        "No approved symbol had usable market data to analyze.",
      summary:
        "No approved symbol had usable market data to analyze, so the next-session analysis is empty.",
      warnings,
      candidates: [],
    };
  }

  const strictCount = selection.filter(
    (selected) => selected.inclusionType === "STRICT_WATCH"
  ).length;

  const selectionNotice =
    strictCount === 0
      ? `No symbol passed the strict new-buy filters (eligible with a total score of at least ${MIN_BUY_SCORE}). The ${selection.length} highest-scoring approved symbols are shown for information only — none is eligible for a new buy.`
      : strictCount < selection.length
        ? `${strictCount} of ${selection.length} shown candidates passed the strict new-buy filters; the rest are informational only and not eligible for a new buy.`
        : `All ${selection.length} shown candidates passed the strict new-buy filters.`;

  try {
    const watchlist = await getOpenAIEveningWatchlist({
      account,
      marketClock,
      analysis,
      selection,
      intendedSessionDate: base.intendedSessionDate,
    });

    return {
      ...base,
      selectionNotice,
      summary: watchlist.overallSummary,
      warnings: [...warnings, ...watchlist.validationNotes],
      candidates: mergeWatchlistCandidates(selection, watchlist.candidates),
    };
  } catch (error) {
    // The AI adds commentary on top of the deterministic selection; any
    // failure (missing key, provider outage, malformed output) fails closed
    // to NO_TRADE instead of failing the whole analysis.
    const message =
      error instanceof Error ? error.message.slice(0, 300) : "Unknown error.";

    return {
      ...base,
      selectionNotice,
      summary:
        "The deterministic selection was computed, but the AI assessment was unavailable. All candidates fail closed to NO_TRADE.",
      warnings: [...warnings, `AI watchlist unavailable: ${message}`],
      candidates: selection.map((selected, index) =>
        failClosedCandidate(
          selected,
          index + 1,
          "The AI assessment was unavailable; failing closed to NO_TRADE."
        )
      ),
    };
  }
}
