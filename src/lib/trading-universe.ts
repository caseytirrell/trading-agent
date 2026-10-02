// Central approved trading universe.
//
// This is the ONLY place the approved symbol list may be defined. The AI
// prompt, the risk manager, validation schemas, and the dashboard must all
// import from here. The agent may never recommend or trade outside this list.
export const APPROVED_SYMBOLS = [
  "SPY",
  "QQQ",
  "AAPL",
  "MSFT",
  "NVDA",
  "AMZN",
  "GOOGL",
  "META",
  "TSLA",
  "AVGO",
  "AMD",
  "COST",
  "JPM",
  "V",
  "UNH",
] as const;

export type ApprovedSymbol = (typeof APPROVED_SYMBOLS)[number];

export function isApprovedSymbol(symbol: string): symbol is ApprovedSymbol {
  return (APPROVED_SYMBOLS as readonly string[]).includes(symbol);
}
