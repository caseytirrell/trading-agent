import OpenAI from "openai";
import type {
  AlpacaAccountSummary,
  AlpacaClock,
  AlpacaPosition,
} from "@/lib/alpaca";
import type { EveningSelectedCandidate } from "@/lib/evening-analysis";
import {
  describeCandidatesForModel,
  MIN_BUY_SCORE,
  qualifiesForNewBuy,
  type MarketAnalysis,
} from "@/lib/market-analysis";
import {
  APPROVED_SYMBOLS,
  isApprovedSymbol,
  type ApprovedSymbol,
} from "@/lib/trading-universe";

/** Single source of truth for the OpenAI model this app calls. */
export const OPENAI_TRADER_MODEL = "gpt-5.5";

export type OpenAITradeRecommendation = {
  action: "BUY" | "SELL" | "HOLD" | "NO_TRADE";
  /** Approved symbol for BUY/SELL; null is allowed for HOLD/NO_TRADE. */
  symbol: ApprovedSymbol | null;
  /** Exactly 1 for BUY/SELL, 0 for HOLD/NO_TRADE. */
  qty: number;
  confidence: number;
  reason: string;
};

export type TraderMarketContext = {
  account: AlpacaAccountSummary;
  positions: AlpacaPosition[];
  marketClock: AlpacaClock;
  analysis: MarketAnalysis;
};

/**
 * Asks OpenAI for a single structured trade recommendation. The model is an
 * analyst only: it reads the deterministic analysis computed by the app and
 * must stay inside it — mandatory rejections and the minimum BUY score are
 * re-enforced in code after the model responds. This function never places
 * orders.
 */
export async function getOpenAITradeRecommendation(
  context: TraderMarketContext
): Promise<OpenAITradeRecommendation> {
  const { account, positions, marketClock, analysis } = context;

  // Deterministic guard: bad or stale market data means NO_TRADE, decided
  // by the app without consulting the model.
  if (analysis.forceNoTrade) {
    return {
      action: "NO_TRADE",
      symbol: null,
      qty: 0,
      confidence: 1,
      reason: `Deterministic guard: required market data is missing, stale, or inconsistent. ${analysis.dataIssues
        .slice(0, 3)
        .join(" ")}`.trim(),
    };
  }

  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY.");
  }

  const openai = new OpenAI({
    apiKey,
  });

  const modelContext = {
    environment: account.paper ? "PAPER_TRADING" : "LIVE_TRADING",
    account: {
      portfolioValue: account.portfolioValue,
      buyingPower: account.buyingPower,
      cash: account.cash,
    },
    marketOpen: marketClock.isOpen,
    regime: {
      classification: analysis.regime,
      reasons: analysis.regimeReasons,
    },
    minBuyScore: MIN_BUY_SCORE,
    currentPositions: positions.map((position) => ({
      symbol: position.symbol,
      qty: position.qty,
      avgEntryPrice: position.avgEntryPrice,
      currentPrice: position.currentPrice,
      unrealizedPl: position.unrealizedPl,
    })),
    candidates: describeCandidatesForModel(analysis),
  };

  const response = await openai.responses.create({
    model: OPENAI_TRADER_MODEL,
    reasoning: {
      effort: "low",
    },
    input: [
      {
        role: "system",
        content:
          "You are a cautious paper trading analyst. You only produce one structured JSON recommendation. You never execute trades — the application makes every execution decision.",
      },
      {
        role: "user",
        content: `
You are the analyst for a controlled PAPER trading agent. This is not real money.

The application already computed a deterministic market analysis. It is
binding — you cannot override it:
- BUY is allowed only for candidates where eligible is true AND scores.total >= ${MIN_BUY_SCORE}.
- Candidates with rejectionReasons are excluded this run no matter how attractive they look.
- SELL is allowed only for symbols listed in currentPositions.
- No short selling, no options, no margin, never more than 1 share.
- If nothing qualifies, return HOLD or NO_TRADE. Prefer NO_TRADE when unclear.

Output format:
- BUY or SELL: symbol must be one approved symbol and qty must be 1.
- HOLD or NO_TRADE: symbol must be null and qty must be 0.
- confidence is between 0 and 1.
- reason: at most two short, factual sentences referencing the computed numbers.

Computed context:
${JSON.stringify(modelContext, null, 1)}
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
              anyOf: [
                {
                  type: "string",
                  enum: [...APPROVED_SYMBOLS],
                },
                {
                  type: "null",
                },
              ],
              description:
                "Approved symbol for BUY/SELL; null for HOLD/NO_TRADE.",
            },
            qty: {
              type: "integer",
              enum: [0, 1],
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

  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("OpenAI returned invalid JSON.");
  }

  return validateRecommendation(parsed, analysis, positions);
}

const allowedActions = ["BUY", "SELL", "HOLD", "NO_TRADE"] as const;

/** Replaces a model recommendation that failed a deterministic guard. */
function overrideToNoTrade(reason: string): OpenAITradeRecommendation {
  return {
    action: "NO_TRADE",
    symbol: null,
    qty: 0,
    confidence: 1,
    reason,
  };
}

function validateRecommendation(
  parsed: unknown,
  analysis: MarketAnalysis,
  positions: AlpacaPosition[]
): OpenAITradeRecommendation {
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("OpenAI response was not a JSON object.");
  }

  const candidate = parsed as Record<string, unknown>;
  const action = candidate.action;
  const rawSymbol = candidate.symbol;
  const qty = Number(candidate.qty);
  const confidence = Number(candidate.confidence);
  const reason = candidate.reason;

  if (
    typeof action !== "string" ||
    !allowedActions.includes(action as (typeof allowedActions)[number])
  ) {
    throw new Error("OpenAI returned an invalid action.");
  }

  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error("OpenAI returned an invalid confidence value.");
  }

  if (typeof reason !== "string" || reason.length === 0) {
    throw new Error("OpenAI returned an empty reason.");
  }

  let symbol: ApprovedSymbol | null = null;

  if (rawSymbol !== null && rawSymbol !== undefined) {
    if (typeof rawSymbol !== "string" || !isApprovedSymbol(rawSymbol)) {
      throw new Error("OpenAI returned a symbol outside the approved universe.");
    }

    symbol = rawSymbol;
  }

  // HOLD / NO_TRADE: no executable trade, so symbol may be null and qty is 0.
  if (action === "HOLD" || action === "NO_TRADE") {
    return {
      action: action as "HOLD" | "NO_TRADE",
      symbol,
      qty: 0,
      confidence,
      reason,
    };
  }

  // BUY / SELL below this point.
  if (symbol === null) {
    throw new Error(`OpenAI returned ${action} without a symbol.`);
  }

  if (qty !== 1) {
    throw new Error(`OpenAI returned ${action} with qty ${qty}; expected 1.`);
  }

  // Deterministic guards. The model cannot rescue candidates that failed
  // mandatory filters, and BUYs below the score threshold are refused here
  // even if the model ignored its instructions.
  if (action === "BUY") {
    const evaluated = analysis.candidates.find((c) => c.symbol === symbol);

    if (!evaluated || !evaluated.eligible) {
      const filters = evaluated?.rejectionReasons.join(" ") ?? "Not evaluated.";
      return overrideToNoTrade(
        `Deterministic guard: model recommended BUY ${symbol}, but it failed mandatory filters. ${filters}`
      );
    }

    if (evaluated.scores.total < MIN_BUY_SCORE) {
      return overrideToNoTrade(
        `Deterministic guard: model recommended BUY ${symbol}, but its total score ${evaluated.scores.total} is below the required ${MIN_BUY_SCORE}.`
      );
    }
  }

  if (action === "SELL") {
    const held = positions.some(
      (position) => position.symbol === symbol && Number(position.qty) > 0
    );

    if (!held) {
      return overrideToNoTrade(
        `Deterministic guard: model recommended SELL ${symbol}, but there is no open position in it.`
      );
    }
  }

  return {
    action: action as "BUY" | "SELL",
    symbol,
    qty: 1,
    confidence,
    reason,
  };
}

// ---------------------------------------------------------------------------
// Evening Analysis (Phase 1): informational next-session watchlist
// ---------------------------------------------------------------------------
//
// Everything below is analysis-only. The only actions that exist are WATCH,
// MONITOR, and NO_TRADE, so no output of this flow can ever describe an
// executable order. The deterministic selection built by
// src/lib/evening-analysis.ts is binding: the model may assess, demote, or
// explain selected candidates, but it can never add symbols, and WATCH is
// reserved for candidates that passed the strict new-buy filters —
// informational fallbacks (near misses, held positions, blocked symbols)
// top out at MONITOR and can never be promoted into anything actionable.

export type EveningWatchlistAction = "WATCH" | "MONITOR" | "NO_TRADE";

export type EveningWatchlistModelCandidate = {
  symbol: ApprovedSymbol;
  action: EveningWatchlistAction;
  confidence: number;
  thesis: string;
  supportingFactors: string[];
  riskFactors: string[];
  /** Must be non-empty for WATCH/MONITOR; without them the entry is demoted. */
  invalidationConditions: string[];
  /** Entry levels exist only on WATCH; MONITOR/NO_TRADE always carry null. */
  proposedEntryRange: string | null;
  maximumEntryPrice: number | null;
};

export type OpenAIEveningWatchlist = {
  overallSummary: string;
  candidates: EveningWatchlistModelCandidate[];
  /** Deterministic demotions/corrections applied to the raw model output. */
  validationNotes: string[];
};

export type EveningWatchlistContext = {
  account: AlpacaAccountSummary;
  marketClock: AlpacaClock;
  analysis: MarketAnalysis;
  /** App-selected candidates — the only ones the model may assess. */
  selection: EveningSelectedCandidate[];
  intendedSessionDate: string | null;
};

// Watchlist text may never promise outcomes. Any match demotes to NO_TRADE.
const GUARANTEED_RETURN_PATTERN =
  /\b(guaranteed?|risk[- ]free|no[- ]risk|can(?:no|')t lose|sure thing|certain (?:profit|gain|win)|assured (?:profit|return)|will (?:definitely|certainly|surely))\b/i;

function containsGuaranteeLanguage(texts: Array<string | null>): boolean {
  return texts.some(
    (text) => text !== null && GUARANTEED_RETURN_PATTERN.test(text)
  );
}

function cleanStringArray(value: unknown, maxItems = 6): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(0, maxItems);
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

/** Fail-closed replacement for a model entry that broke a validation rule. */
function demotedWatchlistCandidate(
  symbol: ApprovedSymbol,
  thesis: string
): EveningWatchlistModelCandidate {
  return {
    symbol,
    action: "NO_TRADE",
    confidence: 0,
    thesis,
    supportingFactors: [],
    riskFactors: [],
    invalidationConditions: [],
    proposedEntryRange: null,
    maximumEntryPrice: null,
  };
}

/**
 * Asks OpenAI to assess the app-selected Evening Analysis candidates as a
 * next-session watchlist. Analysis only: the model can only return WATCH,
 * MONITOR, or NO_TRADE for selected symbols — WATCH is capped to strict
 * new-buy candidates — and its output is re-validated by
 * validateEveningWatchlist before anything reaches the caller. This function
 * never places, queues, or modifies orders.
 */
export async function getOpenAIEveningWatchlist(
  context: EveningWatchlistContext
): Promise<OpenAIEveningWatchlist> {
  const { account, marketClock, analysis, selection, intendedSessionDate } =
    context;

  if (selection.length === 0) {
    throw new Error(
      "Evening watchlist requires a non-empty candidate selection."
    );
  }

  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY.");
  }

  const openai = new OpenAI({
    apiKey,
  });

  const selectionSymbols = selection.map(
    (selected) => selected.evaluation.symbol
  );

  const describedCandidates = describeCandidatesForModel({
    ...analysis,
    candidates: selection.map((selected) => selected.evaluation),
  });

  const modelContext = {
    environment: account.paper ? "PAPER_TRADING" : "LIVE_TRADING",
    analysisOnly: true,
    intendedNextSessionDate: intendedSessionDate,
    marketOpenNow: marketClock.isOpen,
    nextMarketOpen: marketClock.nextOpen,
    regime: {
      classification: analysis.regime,
      reasons: analysis.regimeReasons,
    },
    minScoreForWatch: MIN_BUY_SCORE,
    accountCash: account.cash,
    selectedCandidates: describedCandidates.map((described, index) => ({
      ...described,
      maxAllowedAction: selection[index].maxAction,
      inclusionType: selection[index].inclusionType,
      inclusionReason: selection[index].inclusionReason,
      eligibleForNewBuy: selection[index].eligibleForNewBuy,
      passedScoreThreshold: selection[index].passedScoreThreshold,
    })),
  };

  const response = await openai.responses.create({
    model: OPENAI_TRADER_MODEL,
    reasoning: {
      effort: "low",
    },
    input: [
      {
        role: "system",
        content:
          "You are a cautious paper-trading analyst who produces an informational next-session watchlist only. You never execute, queue, or schedule orders, and the application never places orders from this analysis.",
      },
      {
        role: "user",
        content: `
This is ANALYSIS ONLY for the next trading session of a controlled PAPER
trading app. No order is being placed, queued, or scheduled, and the
application will not act on this output.

Binding rules you cannot override:
- Only the supplied selected symbols may appear in your output: ${selectionSymbols.join(", ")}. You cannot add any other symbol.
- The deterministic eligibility, scores, and rejection filters computed by the application are authoritative. You can never make a candidate eligible, change a score, or argue past a blocking reason.
- Actions, weakest to strongest: NO_TRADE (drop it), MONITOR (informational tracking only — explicitly NOT eligible for a new buy), WATCH (a strict new-buy candidate worth monitoring at the next session open; WATCH still is not a buy instruction).
- Each candidate's maxAllowedAction is a hard cap. Candidates capped at MONITOR failed the strict new-buy gate (score below ${MIN_BUY_SCORE}, already held, or blocked by a mandatory filter): you may only return MONITOR or NO_TRADE for them, must never describe them as a buy or entry opportunity, and must set proposedEntryRange and maximumEntryPrice to null for them.
- For MONITOR candidates, the thesis should explain what is worth tracking and acknowledge what currently blocks a new buy (see inclusionReason and rejectionReasons).
- Options, short selling, margin, and leveraged or derivative ideas are prohibited.
- Never promise or imply guaranteed, certain, or risk-free returns.
- Every WATCH or MONITOR requires: at least one supportingFactor grounded in the supplied metrics, at least one riskFactor, and at least one concrete invalidationCondition (a condition under which the idea should be discarded before or at the open).
- Acknowledge uncertainty: prices can gap overnight and the supplied data is as of the last close. Prefer NO_TRADE whenever the picture is unclear.
- proposedEntryRange and maximumEntryPrice are allowed only on WATCH and must be derived from the supplied prices (latestPrice, sma20, atrPct20d, ...). Never invent price levels; use null when you have no defensible level.

Output one entry per selected symbol. overallSummary is two or three factual
sentences covering the regime, how many candidates are strict WATCH
candidates versus informational MONITOR entries, and anything notable.

Computed context:
${JSON.stringify(modelContext, null, 1)}
`,
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "evening_watchlist",
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            overallSummary: {
              type: "string",
            },
            candidates: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  symbol: {
                    type: "string",
                    enum: selectionSymbols,
                  },
                  action: {
                    type: "string",
                    enum: ["WATCH", "MONITOR", "NO_TRADE"],
                  },
                  confidence: {
                    type: "number",
                    minimum: 0,
                    maximum: 1,
                  },
                  thesis: {
                    type: "string",
                  },
                  supportingFactors: {
                    type: "array",
                    items: { type: "string" },
                  },
                  riskFactors: {
                    type: "array",
                    items: { type: "string" },
                  },
                  invalidationConditions: {
                    type: "array",
                    items: { type: "string" },
                  },
                  proposedEntryRange: {
                    anyOf: [{ type: "string" }, { type: "null" }],
                  },
                  maximumEntryPrice: {
                    anyOf: [{ type: "number" }, { type: "null" }],
                  },
                },
                required: [
                  "symbol",
                  "action",
                  "confidence",
                  "thesis",
                  "supportingFactors",
                  "riskFactors",
                  "invalidationConditions",
                  "proposedEntryRange",
                  "maximumEntryPrice",
                ],
              },
            },
          },
          required: ["overallSummary", "candidates"],
        },
        strict: true,
      },
    },
  });

  const text = response.output_text;

  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("OpenAI returned invalid JSON for the evening watchlist.");
  }

  return validateEveningWatchlist(parsed, selection);
}

/**
 * Deterministic validation of the model's watchlist. Fails closed on every
 * rule: response-level malformation throws, and per-candidate violations
 * demote that candidate with a note. The model cannot add symbols, cannot
 * exceed a candidate's action cap (WATCH is re-derived here from the strict
 * new-buy gate as defense in depth — ineligible or below-threshold
 * candidates top out at MONITOR), cannot skip supporting factors or
 * invalidation conditions, cannot use guaranteed-return language, and cannot
 * anchor entry levels away from the supplied reference price. Entry levels
 * only survive on WATCH.
 */
export function validateEveningWatchlist(
  parsed: unknown,
  selection: EveningSelectedCandidate[]
): OpenAIEveningWatchlist {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      "OpenAI evening watchlist response was not a JSON object."
    );
  }

  const raw = parsed as Record<string, unknown>;

  if (!Array.isArray(raw.candidates)) {
    throw new Error(
      "OpenAI evening watchlist response has no candidates array."
    );
  }

  const validationNotes: string[] = [];
  let overallSummary =
    typeof raw.overallSummary === "string" ? raw.overallSummary.trim() : "";

  if (overallSummary.length === 0) {
    overallSummary =
      "The model did not provide a usable summary; treat this watchlist conservatively.";
    validationNotes.push("Model summary was missing or empty; replaced.");
  } else if (GUARANTEED_RETURN_PATTERN.test(overallSummary)) {
    overallSummary =
      "Summary withheld: the model used prohibited guaranteed-return language.";
    validationNotes.push(
      "Model summary contained guaranteed-return language; replaced."
    );
  }

  const selectionBySymbol = new Map(
    selection.map((selected) => [selected.evaluation.symbol, selected])
  );
  const seenSymbols = new Set<string>();
  const candidates: EveningWatchlistModelCandidate[] = [];

  for (const entry of raw.candidates) {
    if (typeof entry !== "object" || entry === null) {
      validationNotes.push("Dropped a non-object candidate entry.");
      continue;
    }

    const record = entry as Record<string, unknown>;
    const rawSymbol = record.symbol;

    // The model can never add symbols: anything outside the approved
    // universe or the app-selected candidate list is dropped entirely.
    if (
      typeof rawSymbol !== "string" ||
      !isApprovedSymbol(rawSymbol) ||
      !selectionBySymbol.has(rawSymbol)
    ) {
      validationNotes.push(
        `Dropped model candidate "${String(rawSymbol).slice(0, 12)}": not on the app-selected candidate list.`
      );
      continue;
    }

    if (seenSymbols.has(rawSymbol)) {
      validationNotes.push(`Dropped duplicate model entry for ${rawSymbol}.`);
      continue;
    }

    seenSymbols.add(rawSymbol);

    const selected = selectionBySymbol.get(rawSymbol);

    if (!selected) {
      continue;
    }

    const deterministic = selected.evaluation;

    const action = record.action;
    const confidence = Number(record.confidence);
    const thesis =
      typeof record.thesis === "string" ? record.thesis.trim() : "";
    const supportingFactors = cleanStringArray(record.supportingFactors);
    const riskFactors = cleanStringArray(record.riskFactors);
    const invalidationConditions = cleanStringArray(
      record.invalidationConditions
    );
    const proposedEntryRange = optionalString(record.proposedEntryRange);
    let maximumEntryPrice =
      typeof record.maximumEntryPrice === "number" &&
      Number.isFinite(record.maximumEntryPrice) &&
      record.maximumEntryPrice > 0
        ? record.maximumEntryPrice
        : null;

    if (action !== "WATCH" && action !== "MONITOR" && action !== "NO_TRADE") {
      validationNotes.push(
        `${rawSymbol}: unsupported action; demoted to NO_TRADE.`
      );
      candidates.push(
        demotedWatchlistCandidate(
          rawSymbol,
          "Demoted to NO_TRADE: the model returned an unsupported action."
        )
      );
      continue;
    }

    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      validationNotes.push(
        `${rawSymbol}: invalid confidence; demoted to NO_TRADE.`
      );
      candidates.push(
        demotedWatchlistCandidate(
          rawSymbol,
          "Demoted to NO_TRADE: the model returned an invalid confidence value."
        )
      );
      continue;
    }

    if (thesis.length === 0) {
      validationNotes.push(`${rawSymbol}: empty thesis; demoted to NO_TRADE.`);
      candidates.push(
        demotedWatchlistCandidate(
          rawSymbol,
          "Demoted to NO_TRADE: the model returned an empty thesis."
        )
      );
      continue;
    }

    if (
      containsGuaranteeLanguage([
        thesis,
        proposedEntryRange,
        ...supportingFactors,
        ...riskFactors,
        ...invalidationConditions,
      ])
    ) {
      validationNotes.push(
        `${rawSymbol}: guaranteed-return language detected; demoted to NO_TRADE.`
      );
      candidates.push(
        demotedWatchlistCandidate(
          rawSymbol,
          "Demoted to NO_TRADE: the model used prohibited guaranteed-return language."
        )
      );
      continue;
    }

    // Entry levels must stay anchored to the supplied reference price.
    const referencePrice = deterministic.metrics?.latestPrice ?? null;

    if (
      maximumEntryPrice !== null &&
      referencePrice !== null &&
      (maximumEntryPrice > referencePrice * 1.1 ||
        maximumEntryPrice < referencePrice * 0.5)
    ) {
      validationNotes.push(
        `${rawSymbol}: discarded maximumEntryPrice ${maximumEntryPrice} — not anchored to the reference price ${referencePrice.toFixed(2)}.`
      );
      maximumEntryPrice = null;
    }

    // Action cap, re-derived from the deterministic evaluation as defense
    // in depth (the selection annotation is never trusted here): WATCH is
    // reserved for candidates that pass the strict new-buy gate; everything
    // else — below threshold, held, or blocked — tops out at MONITOR, which
    // is informational and never actionable.
    let finalAction: EveningWatchlistAction = action;

    if (finalAction === "WATCH" && !qualifiesForNewBuy(deterministic)) {
      validationNotes.push(
        `${rawSymbol}: WATCH is reserved for strict new-buy candidates (eligible with score >= ${MIN_BUY_SCORE}); demoted to MONITOR.`
      );
      finalAction = "MONITOR";
    }

    if (
      finalAction !== "NO_TRADE" &&
      (supportingFactors.length === 0 || invalidationConditions.length === 0)
    ) {
      validationNotes.push(
        `${rawSymbol}: ${finalAction} without required supporting factors/invalidation conditions; demoted to NO_TRADE.`
      );
      finalAction = "NO_TRADE";
    }

    candidates.push({
      symbol: rawSymbol,
      action: finalAction,
      confidence,
      thesis,
      supportingFactors,
      riskFactors,
      invalidationConditions,
      proposedEntryRange: finalAction === "WATCH" ? proposedEntryRange : null,
      maximumEntryPrice: finalAction === "WATCH" ? maximumEntryPrice : null,
    });
  }

  return {
    overallSummary,
    candidates,
    validationNotes,
  };
}
