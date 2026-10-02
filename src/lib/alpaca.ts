export type AlpacaAccountSummary = {
  accountNumber: string;
  status: string;
  currency: string;
  buyingPower: string;
  portfolioValue: string;
  cash: string;
  equity: string;
  lastEquity: string;
  paper: boolean;
};

export async function getAlpacaAccount(): Promise<AlpacaAccountSummary> {
  const endpoint = process.env.ALPACA_ENDPOINT;
  const apiKey = process.env.ALPACA_API_KEY;
  const secretKey = process.env.ALPACA_SECRET_KEY;

  if (!endpoint || !apiKey || !secretKey) {
    throw new Error("Missing Alpaca environment variables.");
  }

  const response = await fetch(`${endpoint}/v2/account`, {
    method: "GET",
    headers: {
      "APCA-API-KEY-ID": apiKey,
      "APCA-API-SECRET-KEY": secretKey,
      "Content-Type": "application/json",
    },
    cache: "no-store",
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      `Failed to fetch Alpaca account: ${response.status} ${JSON.stringify(data)}`
    );
  }

  return {
    accountNumber: data.account_number,
    status: data.status,
    currency: data.currency,
    buyingPower: data.buying_power,
    portfolioValue: data.portfolio_value,
    cash: data.cash,
    equity: data.equity,
    lastEquity: data.last_equity,
    paper: endpoint.includes("paper-api"),
  };
}

export type AlpacaClock = {
  timestamp: string;
  isOpen: boolean;
  nextOpen: string;
  nextClose: string;
};

export async function getAlpacaClock(): Promise<AlpacaClock> {
  const endpoint = process.env.ALPACA_ENDPOINT;
  const apiKey = process.env.ALPACA_API_KEY;
  const secretKey = process.env.ALPACA_SECRET_KEY;

  if (!endpoint || !apiKey || !secretKey) {
    throw new Error("Missing Alpaca environment variables.");
  }

  const response = await fetch(`${endpoint}/v2/clock`, {
    method: "GET",
    headers: {
      "APCA-API-KEY-ID": apiKey,
      "APCA-API-SECRET-KEY": secretKey,
      "Content-Type": "application/json",
    },
    cache: "no-store",
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      `Failed to fetch Alpaca clock: ${response.status} ${JSON.stringify(data)}`
    );
  }

  return {
    timestamp: data.timestamp,
    isOpen: data.is_open,
    nextOpen: data.next_open,
    nextClose: data.next_close,
  };
}
export type AlpacaPosition = {
  symbol: string;
  qty: string;
  marketValue: string;
  avgEntryPrice: string;
  currentPrice: string;
  unrealizedPl: string;
  unrealizedPlpc: string;
};

export async function getAlpacaPositions(): Promise<AlpacaPosition[]> {
  const endpoint = process.env.ALPACA_ENDPOINT;
  const apiKey = process.env.ALPACA_API_KEY;
  const secretKey = process.env.ALPACA_SECRET_KEY;

  if (!endpoint || !apiKey || !secretKey) {
    throw new Error("Missing Alpaca environment variables.");
  }

  const response = await fetch(`${endpoint}/v2/positions`, {
    method: "GET",
    headers: {
      "APCA-API-KEY-ID": apiKey,
      "APCA-API-SECRET-KEY": secretKey,
      "Content-Type": "application/json",
    },
    cache: "no-store",
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      `Failed to fetch Alpaca positions: ${response.status} ${JSON.stringify(data)}`
    );
  }

  type RawPosition = {
    symbol: string;
    qty: string;
    market_value: string;
    avg_entry_price: string;
    current_price: string;
    unrealized_pl: string;
    unrealized_plpc: string;
  };

  return (data as RawPosition[]).map((position) => ({
    symbol: position.symbol,
    qty: position.qty,
    marketValue: position.market_value,
    avgEntryPrice: position.avg_entry_price,
    currentPrice: position.current_price,
    unrealizedPl: position.unrealized_pl,
    unrealizedPlpc: position.unrealized_plpc,
  }));
}
export type AlpacaLatestTrade = {
  symbol: string;
  price: number;
  size: number;
  timestamp: string;
};

export async function getLatestStockTrades(
  symbols: string[]
): Promise<AlpacaLatestTrade[]> {
  const apiKey = process.env.ALPACA_API_KEY;
  const secretKey = process.env.ALPACA_SECRET_KEY;

  if (!apiKey || !secretKey) {
    throw new Error("Missing Alpaca environment variables.");
  }

  const symbolsParam = symbols.join(",");

  const response = await fetch(
    `https://data.alpaca.markets/v2/stocks/trades/latest?symbols=${symbolsParam}`,
    {
      method: "GET",
      headers: {
        "APCA-API-KEY-ID": apiKey,
        "APCA-API-SECRET-KEY": secretKey,
        "Content-Type": "application/json",
      },
      cache: "no-store",
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      `Failed to fetch latest trades: ${response.status} ${JSON.stringify(data)}`
    );
  }

  return symbols.map((symbol) => {
    const trade = data.trades?.[symbol];

    return {
      symbol,
      price: trade?.p ?? 0,
      size: trade?.s ?? 0,
      timestamp: trade?.t ?? "",
    };
  });
}
export type AlpacaDailyBar = {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

/**
 * Fetches split-adjusted daily bars for the given symbols, oldest first.
 * Used by the deterministic market-analysis layer (returns, SMAs, ATR).
 */
export async function getDailyBars(
  symbols: string[],
  lookbackDays = 120
): Promise<Record<string, AlpacaDailyBar[]>> {
  const apiKey = process.env.ALPACA_API_KEY;
  const secretKey = process.env.ALPACA_SECRET_KEY;

  if (!apiKey || !secretKey) {
    throw new Error("Missing Alpaca environment variables.");
  }

  const start = new Date(
    Date.now() - lookbackDays * 24 * 60 * 60 * 1000
  ).toISOString();

  const barsBySymbol: Record<string, AlpacaDailyBar[]> = {};

  for (const symbol of symbols) {
    barsBySymbol[symbol] = [];
  }

  type RawBar = { t: string; o: number; h: number; l: number; c: number; v: number };

  let pageToken: string | null = null;

  // ~120 calendar days x 15 symbols fits one 10k-bar page; the page cap
  // just guards against runaway pagination.
  for (let page = 0; page < 5; page++) {
    const params = new URLSearchParams({
      symbols: symbols.join(","),
      timeframe: "1Day",
      start,
      limit: "10000",
      adjustment: "split",
      sort: "asc",
    });

    if (pageToken) {
      params.set("page_token", pageToken);
    }

    const response = await fetch(
      `https://data.alpaca.markets/v2/stocks/bars?${params.toString()}`,
      {
        method: "GET",
        headers: {
          "APCA-API-KEY-ID": apiKey,
          "APCA-API-SECRET-KEY": secretKey,
          "Content-Type": "application/json",
        },
        cache: "no-store",
      }
    );

    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        `Failed to fetch daily bars: ${response.status} ${JSON.stringify(data)}`
      );
    }

    const pageBars = (data.bars ?? {}) as Record<string, RawBar[]>;

    for (const [symbol, rawBars] of Object.entries(pageBars)) {
      if (!barsBySymbol[symbol]) {
        barsBySymbol[symbol] = [];
      }

      for (const bar of rawBars) {
        barsBySymbol[symbol].push({
          timestamp: bar.t,
          open: bar.o,
          high: bar.h,
          low: bar.l,
          close: bar.c,
          volume: bar.v,
        });
      }
    }

    pageToken = data.next_page_token ?? null;

    if (!pageToken) {
      break;
    }
  }

  return barsBySymbol;
}
export type AlpacaOrderResponse = {
  id: string;
  clientOrderId: string | null;
  symbol: string;
  qty: string;
  side: string;
  type: string;
  timeInForce: string;
  status: string;
  submittedAt: string;
  /** True when a retry returned the existing Alpaca order instead of creating another. */
  deduplicated: boolean;
  /** Full order payload as returned by Alpaca, kept for audit storage. */
  raw: Record<string, unknown>;
};

type PaperOrderRequest = {
  symbol: string;
  qty: number;
  side: "buy" | "sell";
};

type RawAlpacaOrder = Record<string, unknown> & {
  id: string;
  client_order_id?: string | null;
  symbol: string;
  qty: string;
  side: string;
  type: string;
  time_in_force: string;
  status: string;
  submitted_at: string;
};

function easternDateStamp(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: "year" | "month" | "day") =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";

  return `${part("year")}${part("month")}${part("day")}`;
}

/**
 * Stable for the same paper-order intent on the same Eastern trading day.
 * Alpaca rejects duplicate client_order_id values, so a network retry or a
 * second server instance cannot create the same order twice.
 */
export function buildPaperOrderClientId(
  trade: PaperOrderRequest,
  now: Date = new Date()
): string {
  const symbol = trade.symbol.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const qty = String(trade.qty).replace("-", "m").replace(".", "p");
  return `cta-${easternDateStamp(now)}-${symbol}-${trade.side}-${qty}`;
}

function mapAlpacaOrderResponse(
  data: RawAlpacaOrder,
  deduplicated: boolean
): AlpacaOrderResponse {
  return {
    id: data.id,
    clientOrderId: data.client_order_id ?? null,
    symbol: data.symbol,
    qty: data.qty,
    side: data.side,
    type: data.type,
    timeInForce: data.time_in_force,
    status: data.status,
    submittedAt: data.submitted_at,
    deduplicated,
    raw: data,
  };
}

async function getPaperOrderByClientId(
  endpoint: string,
  headers: Record<string, string>,
  clientOrderId: string,
  trade: PaperOrderRequest
): Promise<AlpacaOrderResponse | null> {
  const response = await fetch(
    `${endpoint}/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(clientOrderId)}`,
    { method: "GET", headers, cache: "no-store" }
  );

  if (!response.ok) {
    return null;
  }

  const data = (await response.json()) as RawAlpacaOrder;

  if (
    data.symbol !== trade.symbol ||
    data.side !== trade.side ||
    Number(data.qty) !== trade.qty
  ) {
    throw new Error(
      "Blocked: Alpaca client order id resolved to a different trade intent."
    );
  }

  return mapAlpacaOrderResponse(data, true);
}

export async function placePaperMarketOrder(
  trade: PaperOrderRequest
): Promise<AlpacaOrderResponse> {
  const { symbol, qty, side } = trade;
  const endpoint = process.env.ALPACA_ENDPOINT;
  const apiKey = process.env.ALPACA_API_KEY;
  const secretKey = process.env.ALPACA_SECRET_KEY;

  if (!endpoint || !apiKey || !secretKey) {
    throw new Error("Missing Alpaca environment variables.");
  }

  if (!endpoint.includes("paper-api")) {
    throw new Error("Blocked: this app only allows paper trading.");
  }

  const headers = {
    "APCA-API-KEY-ID": apiKey,
    "APCA-API-SECRET-KEY": secretKey,
    "Content-Type": "application/json",
  };
  const clientOrderId = buildPaperOrderClientId(trade);
  let response: Response;

  try {
    response = await fetch(`${endpoint}/v2/orders`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        symbol,
        qty,
        side,
        type: "market",
        time_in_force: "day",
        client_order_id: clientOrderId,
      }),
    });
  } catch (error) {
    const existing = await getPaperOrderByClientId(
      endpoint,
      headers,
      clientOrderId,
      trade
    ).catch(() => null);

    if (existing) {
      return existing;
    }

    throw error;
  }

  const data = (await response.json()) as RawAlpacaOrder;

  if (!response.ok) {
    const existing = await getPaperOrderByClientId(
      endpoint,
      headers,
      clientOrderId,
      trade
    ).catch(() => null);

    if (existing) {
      return existing;
    }

    throw new Error(
      `Failed to place paper order: ${response.status} ${JSON.stringify(data)}`
    );
  }

  return mapAlpacaOrderResponse(data, false);
}
export type AlpacaOrder = {
  id: string;
  symbol: string;
  qty: string;
  side: string;
  type: string;
  timeInForce: string;
  status: string;
  filledQty: string;
  filledAvgPrice: string | null;
  submittedAt: string;
  filledAt: string | null;
  expiredAt: string | null;
  canceledAt: string | null;
  failedAt: string | null;
};

export async function getAlpacaOrders(): Promise<AlpacaOrder[]> {
  const endpoint = process.env.ALPACA_ENDPOINT;
  const apiKey = process.env.ALPACA_API_KEY;
  const secretKey = process.env.ALPACA_SECRET_KEY;

  if (!endpoint || !apiKey || !secretKey) {
    throw new Error("Missing Alpaca environment variables.");
  }

  const response = await fetch(
    `${endpoint}/v2/orders?status=all&limit=50&direction=desc`,
    {
      method: "GET",
      headers: {
        "APCA-API-KEY-ID": apiKey,
        "APCA-API-SECRET-KEY": secretKey,
        "Content-Type": "application/json",
      },
      cache: "no-store",
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      `Failed to fetch Alpaca orders: ${response.status} ${JSON.stringify(data)}`
    );
  }

  type RawOrder = {
    id: string;
    symbol: string;
    qty: string;
    side: string;
    type: string;
    time_in_force: string;
    status: string;
    filled_qty: string;
    filled_avg_price: string | null;
    submitted_at: string;
    filled_at: string | null;
    expired_at: string | null;
    canceled_at: string | null;
    failed_at: string | null;
  };

  return (data as RawOrder[]).map((order) => ({
    id: order.id,
    symbol: order.symbol,
    qty: order.qty,
    side: order.side,
    type: order.type,
    timeInForce: order.time_in_force,
    status: order.status,
    filledQty: order.filled_qty,
    filledAvgPrice: order.filled_avg_price,
    submittedAt: order.submitted_at,
    filledAt: order.filled_at,
    expiredAt: order.expired_at,
    canceledAt: order.canceled_at,
    failedAt: order.failed_at,
  }));
}
