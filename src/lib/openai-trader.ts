import OpenAI from "openai";
import {
  getAlpacaAccount,
  getAlpacaPositions,
  getLatestStockTrades,
} from "@/lib/alpaca";

export type OpenAITradeRecommendation = {
  action: "BUY" | "SELL" | "HOLD" | "NO_TRADE";
  symbol: "SPY" | "QQQ" | "AAPL" | "MSFT" | "NVDA";
  qty: number;
  confidence: number;
  reason: string;
};

const allowedSymbols = ["SPY", "QQQ", "AAPL", "MSFT", "NVDA"] as const;

export async function getOpenAITradeRecommendation(): Promise<OpenAITradeRecommendation> {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY.");
  }

  const openai = new OpenAI({
    apiKey,
  });

  const [account, positions, latestTrades] = await Promise.all([
    getAlpacaAccount(),
    getAlpacaPositions(),
    getLatestStockTrades([...allowedSymbols]),
  ]);

  const marketSummary = latestTrades
    .map((trade) => {
      return `${trade.symbol}: latest price $${trade.price}, last trade size ${trade.size}, timestamp ${trade.timestamp}`;
    })
    .join("\n");

  const positionsSummary =
    positions.length === 0
      ? "No current positions."
      : positions
          .map((position) => {
            return `${position.symbol}: qty ${position.qty}, avg entry $${position.avgEntryPrice}, current price $${position.currentPrice}, unrealized P/L ${position.unrealizedPl}`;
          })
          .join("\n");

  const response = await openai.responses.create({
    model: "gpt-5.5",
    reasoning: {
      effort: "low",
    },
    input: [
      {
        role: "system",
        content:
          "You are a cautious paper trading analysis assistant. You provide structured recommendations only. You do not guarantee profit.",
      },
      {
        role: "user",
        content: `
You are analyzing a PAPER trading account. This is not real money.

Your job:
Recommend exactly one action from:
BUY, SELL, HOLD, or NO_TRADE.

Allowed symbols:
SPY, QQQ, AAPL, MSFT, NVDA

Current account:
Portfolio value: ${account.portfolioValue}
Buying power: ${account.buyingPower}
Environment: ${account.paper ? "PAPER TRADING" : "LIVE TRADING"}

Current positions:
${positionsSummary}

Latest market data:
${marketSummary}

Strict rules:
- Prefer NO_TRADE when the data is unclear.
- Do not recommend more than 1 share.
- Do not recommend symbols outside the allowed list.
- Do not recommend short selling.
- Do not recommend options.
- Do not recommend margin.
- If selling, only sell a symbol that appears in current positions.
- Keep the reasoning short.
`,
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "trade_recommendation",
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            action: {
              type: "string",
              enum: ["BUY", "SELL", "HOLD", "NO_TRADE"],
            },
            symbol: {
              type: "string",
              enum: ["SPY", "QQQ", "AAPL", "MSFT", "NVDA"],
            },
            qty: {
              type: "number",
              minimum: 1,
              maximum: 1,
            },
            confidence: {
              type: "number",
              minimum: 0,
              maximum: 1,
            },
            reason: {
              type: "string",
            },
          },
          required: ["action", "symbol", "qty", "confidence", "reason"],
        },
        strict: true,
      },
    },
  });

  const text = response.output_text;
  const parsed = JSON.parse(text);

  return {
    action: parsed.action,
    symbol: parsed.symbol,
    qty: Number(parsed.qty),
    confidence: Number(parsed.confidence),
    reason: String(parsed.reason),
  };
}