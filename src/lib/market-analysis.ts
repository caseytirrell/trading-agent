import type {
  AlpacaAccountSummary,
  AlpacaDailyBar,
  AlpacaOrder,
  AlpacaPosition,
} from "@/lib/alpaca";
import { OPEN_ORDER_STATUSES } from "@/lib/risk-manager";
import { APPROVED_SYMBOLS, type ApprovedSymbol } from "@/lib/trading-universe";

// Deterministic market-analysis layer. Everything here is computed by the
// app from Alpaca bar data — the AI receives these numbers as read-only
// context and can never override eligibility or scores.

/** A BUY may only be recommended when the candidate's total score reaches this. */
export const MIN_BUY_SCORE = 72;

// 50-day return/SMA need 51 closes.
const MIN_BARS_REQUIRED = 51;
// Latest daily bar older than this (covers weekends + holidays) is stale.
const MAX_BAR_AGE_DAYS = 7;

// Regime thresholds, applied to SPY.
const UNSTABLE_ATR_PCT = 2.5;
const BEARISH_RETURN_20D_PCT = -5;

export type MarketRegime = "bullish" | "neutral" | "bearish_unstable";

export type SymbolMetrics = {
  symbol: string;
  latestPrice: number;
  previousClose: number;
  dailyChangePct: number;
  return5dPct: number;
  return20dPct: number;
  return50dPct: number;
  sma20: number;
  sma50: number;
  avgVolume20d: number;
  latestVolume: number;
  /** 20-day ATR as a percentage of the latest price (volatility proxy). */
  atrPct20d: number;
  /** 20-day return minus SPY's 20-day return, in percentage points. */
  relativeStrengthVsSpy: number;
  lastBarDate: string;
};

export type CandidateScores = {
  trend: number; // 0-20
  momentum: number; // 0-20
  relativeStrength: number; // 0-15
  volume: number; // 0-10
  risk: number; // 0-20, higher = calmer
  portfolioFit: number; // 0-15
  total: number; // 0-100
};

/** Structured counterpart of a rejection reason, for programmatic handling. */
export type RejectionCode = "DATA" | "HELD" | "OPEN_ORDER" | "REGIME" | "CASH";

export type CandidateEvaluation = {
  symbol: ApprovedSymbol;
  /** True only when every mandatory BUY filter passes. */
  eligible: boolean;
  /** Mandatory filters that failed. The AI cannot rescue these. */
  rejectionReasons: string[];
  /** One code per entry in rejectionReasons, in the same order. */
  rejectionCodes: RejectionCode[];
  scores: CandidateScores;
  metrics: SymbolMetrics | null;
};

export type MarketAnalysis = {
  asOf: string;
  regime: MarketRegime;
  regimeReasons: string[];
  /** True when any required market data is missing, stale, or inconsistent. */
  forceNoTrade: boolean;
  dataIssues: string[];
  minBuyScore: number;
  candidates: CandidateEvaluation[];
};

export type MarketAnalysisInput = {
  bars: Record<string, AlpacaDailyBar[]>;
  account: AlpacaAccountSummary;
  positions: AlpacaPosition[];
  recentOrders: AlpacaOrder[];
  now?: Date;
};

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Linearly maps value from [floor, ceiling] onto [0, maxPoints]. */
function linearScore(
  value: number,
  floor: number,
  ceiling: number,
  maxPoints: number
): number {
  return Math.round(clamp01((value - floor) / (ceiling - floor)) * maxPoints);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function computeSymbolMetrics(
  symbol: string,
  bars: AlpacaDailyBar[] | undefined,
  now: Date
): { metrics: SymbolMetrics | null; issues: string[] } {
  if (!bars || bars.length < MIN_BARS_REQUIRED) {
    return {
      metrics: null,
      issues: [
        `${symbol}: insufficient daily bars (${bars?.length ?? 0} of ${MIN_BARS_REQUIRED} required).`,
      ],
    };
  }

  const recent = bars.slice(-MIN_BARS_REQUIRED);
  const lastBar = recent[recent.length - 1];

  const barAgeDays =
    (now.getTime() - new Date(lastBar.timestamp).getTime()) / 86_400_000;

  if (!Number.isFinite(barAgeDays) || barAgeDays > MAX_BAR_AGE_DAYS) {
    return {
      metrics: null,
      issues: [`${symbol}: latest daily bar is stale (${lastBar.timestamp}).`],
    };
  }

  for (const bar of recent) {
    const valuesFinite =
      Number.isFinite(bar.open) &&
      Number.isFinite(bar.high) &&
      Number.isFinite(bar.low) &&
      Number.isFinite(bar.close) &&
      Number.isFinite(bar.volume);

    if (
      !valuesFinite ||
      bar.open <= 0 ||
      bar.high <= 0 ||
      bar.low <= 0 ||
      bar.close <= 0 ||
      bar.volume < 0 ||
      bar.high < bar.low
    ) {
      return {
        metrics: null,
        issues: [`${symbol}: inconsistent bar data on ${bar.timestamp}.`],
      };
    }
  }

  const closes = recent.map((bar) => bar.close);
  const volumes = recent.map((bar) => bar.volume);
  const last = closes.length - 1;

  const pctChange = (later: number, earlier: number) =>
    (later / earlier - 1) * 100;

  const average = (values: number[], length: number) =>
    values.slice(-length).reduce((sum, value) => sum + value, 0) / length;

  // 20-day ATR, each true range measured against the prior close.
  let trueRangeSum = 0;

  for (let i = recent.length - 20; i < recent.length; i++) {
    const bar = recent[i];
    const previousClose = recent[i - 1].close;

    trueRangeSum += Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - previousClose),
      Math.abs(bar.low - previousClose)
    );
  }

  const latestPrice = closes[last];

  return {
    metrics: {
      symbol,
      latestPrice,
      previousClose: closes[last - 1],
      dailyChangePct: pctChange(latestPrice, closes[last - 1]),
      return5dPct: pctChange(latestPrice, closes[last - 5]),
      return20dPct: pctChange(latestPrice, closes[last - 20]),
      return50dPct: pctChange(latestPrice, closes[last - 50]),
      sma20: average(closes, 20),
      sma50: average(closes, 50),
      avgVolume20d: average(volumes, 20),
      latestVolume: volumes[last],
      atrPct20d: (trueRangeSum / 20 / latestPrice) * 100,
      relativeStrengthVsSpy: 0, // filled in by analyzeMarket once SPY is known
      lastBarDate: lastBar.timestamp,
    },
    issues: [],
  };
}

function classifyRegime(
  spy: SymbolMetrics,
  qqq: SymbolMetrics
): { regime: MarketRegime; reasons: string[] } {
  const reasons: string[] = [];

  const spyBelow50 = spy.latestPrice < spy.sma50;
  const qqqBelow50 = qqq.latestPrice < qqq.sma50;
  const unstable = spy.atrPct20d > UNSTABLE_ATR_PCT;
  const sharpDrawdown = spy.return20dPct < BEARISH_RETURN_20D_PCT;

  if ((spyBelow50 && qqqBelow50) || unstable || sharpDrawdown) {
    if (spyBelow50 && qqqBelow50) {
      reasons.push("SPY and QQQ are both below their 50-day SMA.");
    }

    if (unstable) {
      reasons.push(
        `SPY 20-day ATR ${spy.atrPct20d.toFixed(2)}% exceeds ${UNSTABLE_ATR_PCT}% (elevated volatility).`
      );
    }

    if (sharpDrawdown) {
      reasons.push(
        `SPY 20-day return ${spy.return20dPct.toFixed(2)}% is below ${BEARISH_RETURN_20D_PCT}%.`
      );
    }

    return { regime: "bearish_unstable", reasons };
  }

  if (
    !spyBelow50 &&
    !qqqBelow50 &&
    spy.sma20 > spy.sma50 &&
    qqq.sma20 > qqq.sma50
  ) {
    reasons.push(
      "SPY and QQQ are above their 50-day SMAs, and both 20-day SMAs are above the 50-day SMAs."
    );
    return { regime: "bullish", reasons };
  }

  reasons.push("Mixed trend signals between SPY and QQQ.");
  return { regime: "neutral", reasons };
}

function zeroScores(): CandidateScores {
  return {
    trend: 0,
    momentum: 0,
    relativeStrength: 0,
    volume: 0,
    risk: 0,
    portfolioFit: 0,
    total: 0,
  };
}

function scoreCandidate(
  metrics: SymbolMetrics,
  isHeld: boolean,
  hasOpenOrder: boolean,
  cash: number
): CandidateScores {
  const trend =
    (metrics.latestPrice > metrics.sma20 ? 7 : 0) +
    (metrics.latestPrice > metrics.sma50 ? 7 : 0) +
    (metrics.sma20 > metrics.sma50 ? 6 : 0);

  const momentum =
    linearScore(metrics.return20dPct, 0, 10, 12) +
    linearScore(metrics.return5dPct, 0, 5, 8);

  const relativeStrength = linearScore(
    metrics.relativeStrengthVsSpy,
    -5,
    5,
    15
  );

  const volumeRatio =
    metrics.avgVolume20d > 0 ? metrics.latestVolume / metrics.avgVolume20d : 0;
  const volume =
    volumeRatio >= 1.2 ? 10 : volumeRatio >= 0.8 ? 6 : volumeRatio >= 0.5 ? 3 : 0;

  // Calmer symbols score higher: ATR <= 1.5% earns 20, >= 4% earns 0.
  const risk = linearScore(-metrics.atrPct20d, -4, -1.5, 20);

  const portfolioFit =
    isHeld || hasOpenOrder || !(Number.isFinite(cash) && cash >= metrics.latestPrice)
      ? 0
      : 15;

  return {
    trend,
    momentum,
    relativeStrength,
    volume,
    risk,
    portfolioFit,
    total: trend + momentum + relativeStrength + volume + risk + portfolioFit,
  };
}

/**
 * Runs the full deterministic analysis: per-symbol metrics, SPY/QQQ regime
 * classification, and BUY-candidate scoring with mandatory filters. Any
 * missing, stale, or inconsistent data sets forceNoTrade — the model is
 * never consulted in that case.
 */
export function analyzeMarket(input: MarketAnalysisInput): MarketAnalysis {
  const { bars, account, positions, recentOrders } = input;
  const now = input.now ?? new Date();

  const dataIssues: string[] = [];
  const metricsBySymbol = new Map<ApprovedSymbol, SymbolMetrics | null>();

  for (const symbol of APPROVED_SYMBOLS) {
    const { metrics, issues } = computeSymbolMetrics(symbol, bars[symbol], now);
    dataIssues.push(...issues);
    metricsBySymbol.set(symbol, metrics);
  }

  const spy = metricsBySymbol.get("SPY") ?? null;
  const qqq = metricsBySymbol.get("QQQ") ?? null;

  if (spy) {
    for (const metrics of metricsBySymbol.values()) {
      if (metrics) {
        metrics.relativeStrengthVsSpy =
          metrics.return20dPct - spy.return20dPct;
      }
    }
  }

  let regime: MarketRegime;
  let regimeReasons: string[];

  if (spy && qqq) {
    ({ regime, reasons: regimeReasons } = classifyRegime(spy, qqq));
  } else {
    // Fail closed: without healthy SPY/QQQ data there is no regime signal.
    regime = "bearish_unstable";
    regimeReasons = [
      "SPY or QQQ data is unavailable; defaulting to bearish_unstable.",
    ];
  }

  const forceNoTrade = dataIssues.length > 0;

  const heldSymbols = new Set(
    positions.filter((p) => Number(p.qty) > 0).map((p) => p.symbol)
  );
  const openOrderSymbols = new Set(
    recentOrders
      .filter((order) => OPEN_ORDER_STATUSES.includes(order.status))
      .map((order) => order.symbol)
  );
  const cash = Number(account.cash);

  const candidates: CandidateEvaluation[] = APPROVED_SYMBOLS.map((symbol) => {
    const metrics = metricsBySymbol.get(symbol) ?? null;
    const rejections: Array<{ code: RejectionCode; message: string }> = [];

    if (!metrics) {
      rejections.push({
        code: "DATA",
        message: "Market data is missing, stale, or inconsistent for this symbol.",
      });
    }

    if (heldSymbols.has(symbol)) {
      rejections.push({
        code: "HELD",
        message: "Position already held; adding to it is not allowed.",
      });
    }

    if (openOrderSymbols.has(symbol)) {
      rejections.push({
        code: "OPEN_ORDER",
        message: "An open order already exists for this symbol.",
      });
    }

    if (regime === "bearish_unstable") {
      rejections.push({
        code: "REGIME",
        message: "Market regime is bearish_unstable; new buys are blocked.",
      });
    }

    if (metrics && !(Number.isFinite(cash) && cash >= metrics.latestPrice)) {
      rejections.push({
        code: "CASH",
        message: "Insufficient cash to buy 1 share without margin.",
      });
    }

    const scores = metrics
      ? scoreCandidate(
          metrics,
          heldSymbols.has(symbol),
          openOrderSymbols.has(symbol),
          cash
        )
      : zeroScores();

    return {
      symbol,
      eligible: rejections.length === 0,
      rejectionReasons: rejections.map((rejection) => rejection.message),
      rejectionCodes: rejections.map((rejection) => rejection.code),
      scores,
      metrics,
    };
  });

  return {
    asOf: now.toISOString(),
    regime,
    regimeReasons,
    forceNoTrade,
    dataIssues,
    minBuyScore: MIN_BUY_SCORE,
    candidates,
  };
}

/**
 * The strict new-buy gate: every mandatory filter passed AND the total score
 * reached MIN_BUY_SCORE. This is the only state in which a new BUY (or an
 * Evening Analysis WATCH) is permitted; informational displays may rank
 * candidates that fail it, but nothing may present them as actionable.
 */
export function qualifiesForNewBuy(candidate: CandidateEvaluation): boolean {
  return (
    candidate.eligible &&
    candidate.rejectionReasons.length === 0 &&
    candidate.metrics !== null &&
    candidate.scores.total >= MIN_BUY_SCORE
  );
}

/** Compact per-candidate view fed to the model as structured context. */
export function describeCandidatesForModel(analysis: MarketAnalysis) {
  return analysis.candidates.map((candidate) => ({
    symbol: candidate.symbol,
    eligible: candidate.eligible,
    rejectionReasons: candidate.rejectionReasons,
    scores: candidate.scores,
    metrics: candidate.metrics
      ? {
          latestPrice: round2(candidate.metrics.latestPrice),
          previousClose: round2(candidate.metrics.previousClose),
          dailyChangePct: round2(candidate.metrics.dailyChangePct),
          return5dPct: round2(candidate.metrics.return5dPct),
          return20dPct: round2(candidate.metrics.return20dPct),
          return50dPct: round2(candidate.metrics.return50dPct),
          sma20: round2(candidate.metrics.sma20),
          sma50: round2(candidate.metrics.sma50),
          avgVolume20d: Math.round(candidate.metrics.avgVolume20d),
          latestVolume: Math.round(candidate.metrics.latestVolume),
          atrPct20d: round2(candidate.metrics.atrPct20d),
          relativeStrengthVsSpy: round2(candidate.metrics.relativeStrengthVsSpy),
          lastBarDate: candidate.metrics.lastBarDate,
        }
      : null,
  }));
}

export type MarketAnalysisSummary = {
  asOf: string;
  regime: MarketRegime;
  regimeReasons: string[];
  forceNoTrade: boolean;
  dataIssues: string[];
  minBuyScore: number;
  candidates: Array<{
    symbol: string;
    eligible: boolean;
    totalScore: number;
    /** True when totalScore >= minBuyScore (the strict BUY/WATCH threshold). */
    passedScoreThreshold: boolean;
    rejectionReasons: string[];
    /** Full deterministic score components behind totalScore. */
    scores: CandidateScores;
    latestPrice: number | null;
    lastBarDate: string | null;
  }>;
};

/** Compact view of the analysis for API responses and UI logging. */
export function summarizeAnalysis(analysis: MarketAnalysis): MarketAnalysisSummary {
  return {
    asOf: analysis.asOf,
    regime: analysis.regime,
    regimeReasons: analysis.regimeReasons,
    forceNoTrade: analysis.forceNoTrade,
    dataIssues: analysis.dataIssues,
    minBuyScore: analysis.minBuyScore,
    candidates: analysis.candidates.map((candidate) => ({
      symbol: candidate.symbol,
      eligible: candidate.eligible,
      totalScore: candidate.scores.total,
      passedScoreThreshold: candidate.scores.total >= analysis.minBuyScore,
      rejectionReasons: candidate.rejectionReasons,
      scores: candidate.scores,
      latestPrice: candidate.metrics ? round2(candidate.metrics.latestPrice) : null,
      lastBarDate: candidate.metrics?.lastBarDate ?? null,
    })),
  };
}
