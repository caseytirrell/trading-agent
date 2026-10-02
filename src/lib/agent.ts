import {
  getAlpacaAccount,
  getAlpacaClock,
  getAlpacaOrders,
  getAlpacaPositions,
  getDailyBars,
  type AlpacaAccountSummary,
  type AlpacaClock,
  type AlpacaOrder,
  type AlpacaPosition,
} from "@/lib/alpaca";
import {
  analyzeMarket,
  summarizeAnalysis,
  type MarketAnalysisSummary,
} from "@/lib/market-analysis";
import {
  getOpenAITradeRecommendation,
  type OpenAITradeRecommendation,
} from "@/lib/openai-trader";
import {
  runRiskCheck,
  type RiskCheckResult,
  type TradeRequest,
} from "@/lib/risk-manager";
import { APPROVED_SYMBOLS } from "@/lib/trading-universe";

/** Live account/market state the evaluation was based on (for audit records). */
export type AgentEvaluationContext = {
  account: AlpacaAccountSummary;
  positions: AlpacaPosition[];
  recentOrders: AlpacaOrder[];
  marketClock: AlpacaClock;
};

export type AgentEvaluation = {
  recommendation: OpenAITradeRecommendation;
  riskCheck: RiskCheckResult;
  executable: boolean;
  /** The concrete trade to place, only set when executable is true. */
  trade: TradeRequest | null;
  /** Compact view of the deterministic analysis behind the recommendation. */
  marketAnalysis: MarketAnalysisSummary;
  context: AgentEvaluationContext;
};

/**
 * The trade a BUY/SELL recommendation asked for, independent of whether the
 * risk manager approved it — used purely for audit records of rejected
 * decisions. Never feed this to order placement; only the risk-approved
 * `trade` field may be executed.
 */
export function describeRequestedTrade(
  recommendation: OpenAITradeRecommendation,
  approvedTrade: TradeRequest | null
): TradeRequest | null {
  if (approvedTrade) {
    return approvedTrade;
  }

  if (
    (recommendation.action === "BUY" || recommendation.action === "SELL") &&
    recommendation.symbol !== null
  ) {
    return {
      symbol: recommendation.symbol,
      qty: recommendation.qty,
      side: recommendation.action === "BUY" ? "buy" : "sell",
    };
  }

  return null;
}

/**
 * One full agent evaluation: fetch live paper account state, run the
 * deterministic market analysis, ask OpenAI for a recommendation inside
 * that analysis, and run the result through the risk manager. This never
 * places an order — callers decide whether to execute an approved trade.
 */
export async function evaluateAgentTrade(): Promise<AgentEvaluation> {
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

  const recommendation = await getOpenAITradeRecommendation({
    account,
    positions,
    marketClock,
    analysis,
  });

  const marketAnalysis = summarizeAnalysis(analysis);
  const context: AgentEvaluationContext = {
    account,
    positions,
    recentOrders,
    marketClock,
  };

  if (
    recommendation.action === "HOLD" ||
    recommendation.action === "NO_TRADE" ||
    recommendation.symbol === null
  ) {
    return {
      recommendation,
      riskCheck: {
        approved: false,
        reasons: ["The AI recommended no executable trade."],
      },
      executable: false,
      trade: null,
      marketAnalysis,
      context,
    };
  }

  const trade: TradeRequest = {
    symbol: recommendation.symbol,
    qty: recommendation.qty,
    side: recommendation.action === "BUY" ? "buy" : "sell",
  };

  const riskCheck = runRiskCheck({
    trade,
    account,
    positions,
    recentOrders,
    marketClock,
    recommendation: {
      action: recommendation.action,
      confidence: recommendation.confidence,
    },
  });

  return {
    recommendation,
    riskCheck,
    executable: riskCheck.approved,
    trade: riskCheck.approved ? trade : null,
    marketAnalysis,
    context,
  };
}
