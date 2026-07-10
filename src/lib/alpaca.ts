export type AlpacaAccountSummary = {
  accountNumber: string;
  status: string;
  currency: string;
  buyingPower: string;
  portfolioValue: string;
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
    paper: endpoint.includes("paper-api"),
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

  return data.map((position: any) => ({
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
export type AlpacaOrderResponse = {
  id: string;
  symbol: string;
  qty: string;
  side: string;
  type: string;
  status: string;
  submittedAt: string;
};

export async function placePaperMarketOrder({
  symbol,
  qty,
  side,
}: {
  symbol: string;
  qty: number;
  side: "buy" | "sell";
}): Promise<AlpacaOrderResponse> {
  const endpoint = process.env.ALPACA_ENDPOINT;
  const apiKey = process.env.ALPACA_API_KEY;
  const secretKey = process.env.ALPACA_SECRET_KEY;

  if (!endpoint || !apiKey || !secretKey) {
    throw new Error("Missing Alpaca environment variables.");
  }

  if (!endpoint.includes("paper-api")) {
    throw new Error("Blocked: this app only allows paper trading.");
  }

  const response = await fetch(`${endpoint}/v2/orders`, {
    method: "POST",
    headers: {
      "APCA-API-KEY-ID": apiKey,
      "APCA-API-SECRET-KEY": secretKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      symbol,
      qty,
      side,
      type: "market",
      time_in_force: "day",
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      `Failed to place paper order: ${response.status} ${JSON.stringify(data)}`
    );
  }

  return {
    id: data.id,
    symbol: data.symbol,
    qty: data.qty,
    side: data.side,
    type: data.type,
    status: data.status,
    submittedAt: data.submitted_at,
  };
}
export type AlpacaOrder = {
  id: string;
  symbol: string;
  qty: string;
  side: string;
  type: string;
  status: string;
  filledQty: string;
  filledAvgPrice: string | null;
  submittedAt: string;
  filledAt: string | null;
};

export async function getAlpacaOrders(): Promise<AlpacaOrder[]> {
  const endpoint = process.env.ALPACA_ENDPOINT;
  const apiKey = process.env.ALPACA_API_KEY;
  const secretKey = process.env.ALPACA_SECRET_KEY;

  if (!endpoint || !apiKey || !secretKey) {
    throw new Error("Missing Alpaca environment variables.");
  }

  const response = await fetch(`${endpoint}/v2/orders?status=all&limit=10`, {
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
      `Failed to fetch Alpaca orders: ${response.status} ${JSON.stringify(data)}`
    );
  }

  return data.map((order: any) => ({
    id: order.id,
    symbol: order.symbol,
    qty: order.qty,
    side: order.side,
    type: order.type,
    status: order.status,
    filledQty: order.filled_qty,
    filledAvgPrice: order.filled_avg_price,
    submittedAt: order.submitted_at,
    filledAt: order.filled_at,
  }));
}