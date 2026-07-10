import {
  getAlpacaAccount,
  getAlpacaPositions,
  getLatestStockTrades,
  getAlpacaOrders,
} from "@/lib/alpaca";
import { getOpenAITradeRecommendation } from "@/lib/openai-trader";
import { runRiskCheck } from "@/lib/risk-manager";

export default async function Home() {
  const [account, positions, latestTrades, orders, recommendation] =
  await Promise.all([
    getAlpacaAccount(),
    getAlpacaPositions(),
    getLatestStockTrades(["SPY", "QQQ", "AAPL", "MSFT", "NVDA"]),
    getAlpacaOrders(),
    getOpenAITradeRecommendation(),
  ]);

const riskCheck =
  recommendation.action === "HOLD" || recommendation.action === "NO_TRADE"
    ? {
        approved: false,
        reasons: ["OpenAI recommended no executable trade."],
      }
    : runRiskCheck({
        symbol: recommendation.symbol,
        qty: recommendation.qty,
        side: recommendation.action === "BUY" ? "buy" : "sell",
      });

  return (
    <main className="min-h-screen bg-neutral-950 p-8 text-white">
      <div className="mx-auto max-w-4xl">
        <p className="mb-2 text-sm uppercase tracking-wide text-green-400">
          Claude Trading Agent
        </p>

        <h1 className="mb-8 text-4xl font-bold">
          Paper Trading Dashboard
        </h1>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-2xl border border-neutral-800 bg-neutral-900 p-6">
            <p className="text-sm text-neutral-400">Account Status</p>
            <p className="mt-2 text-2xl font-semibold">{account.status}</p>
          </div>

          <div className="rounded-2xl border border-neutral-800 bg-neutral-900 p-6">
            <p className="text-sm text-neutral-400">Environment</p>
            <p className="mt-2 text-2xl font-semibold">
              {account.paper ? "Paper Trading" : "Live Trading"}
            </p>
          </div>

          <div className="rounded-2xl border border-neutral-800 bg-neutral-900 p-6">
            <p className="text-sm text-neutral-400">Portfolio Value</p>
            <p className="mt-2 text-2xl font-semibold">
              ${Number(account.portfolioValue).toLocaleString()}
            </p>
          </div>

          <div className="rounded-2xl border border-neutral-800 bg-neutral-900 p-6">
            <p className="text-sm text-neutral-400">Buying Power</p>
            <p className="mt-2 text-2xl font-semibold">
              ${Number(account.buyingPower).toLocaleString()}
            </p>
          </div>
        </div>

        <div className="mt-8 rounded-2xl border border-green-900 bg-green-950/40 p-6">
          <p className="font-semibold text-green-300">
            Safety Check
          </p>
          <div className="mt-8 rounded-2xl border border-neutral-800 bg-neutral-900 p-6">
            <div className="mb-4 flex items-center justify-between gap-4">
              <div>
                <p className="text-sm uppercase tracking-wide text-blue-400">
                  AI Recommendation
                </p>
                <h2 className="text-2xl font-bold">OpenAI Trade Idea</h2>
              </div>

              <span
                className={`rounded-full px-4 py-2 text-sm font-semibold ${
                  recommendation.action === "BUY"
                    ? "bg-green-950 text-green-300"
                    : recommendation.action === "SELL"
                      ? "bg-red-950 text-red-300"
                      : "bg-neutral-800 text-neutral-300"
                }`}
              >
                {recommendation.action}
              </span>
            </div>

            <div className="grid gap-4 md:grid-cols-4">
              <div>
                <p className="text-sm text-neutral-400">Symbol</p>
                <p className="mt-1 text-xl font-semibold">{recommendation.symbol}</p>
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

              <div>
                <p className="text-sm text-neutral-400">Executable</p>
                <p className="mt-1 text-xl font-semibold">
                  {riskCheck.approved ? "Yes" : "No"}
                </p>
              </div>
            </div>

            <div className="mt-6">
              <p className="text-sm text-neutral-400">Reason</p>
              <p className="mt-2 text-neutral-200">{recommendation.reason}</p>
            </div>

            {!riskCheck.approved && (
              <div className="mt-6 rounded-xl border border-yellow-900 bg-yellow-950/40 p-4">
                <p className="font-semibold text-yellow-300">
                  Not executable
                </p>
                <ul className="mt-2 list-inside list-disc text-sm text-neutral-300">
                  {riskCheck.reasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          <div className="mt-8 rounded-2xl border border-neutral-800 bg-neutral-900 p-6">
            <h2 className="mb-4 text-2xl font-bold">Current Positions</h2>

            {positions.length === 0 ? (
              <p className="text-neutral-400">
                No current paper positions yet.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-neutral-800 text-neutral-400">
                    <tr>
                      <th className="py-3">Symbol</th>
                      <th className="py-3">Qty</th>
                      <th className="py-3">Market Value</th>
                      <th className="py-3">Avg Entry</th>
                      <th className="py-3">Current Price</th>
                      <th className="py-3">Unrealized P/L</th>
                    </tr>
                  </thead>

                  <tbody>
                    {positions.map((position) => (
                      <tr key={position.symbol} className="border-b border-neutral-800">
                        <td className="py-3 font-semibold">{position.symbol}</td>
                        <td className="py-3">{position.qty}</td>
                        <td className="py-3">
                          ${Number(position.marketValue).toLocaleString()}
                        </td>
                        <td className="py-3">
                          ${Number(position.avgEntryPrice).toLocaleString()}
                        </td>
                        <td className="py-3">
                          ${Number(position.currentPrice).toLocaleString()}
                        </td>
                        <td className="py-3">
                          ${Number(position.unrealizedPl).toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <div className="mt-8 rounded-2xl border border-neutral-800 bg-neutral-900 p-6">
            <h2 className="mb-4 text-2xl font-bold">Market Watch</h2>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-neutral-800 text-neutral-400">
                  <tr>
                    <th className="py-3">Symbol</th>
                    <th className="py-3">Latest Price</th>
                    <th className="py-3">Last Trade Size</th>
                    <th className="py-3">Timestamp</th>
                  </tr>
                </thead>

                <tbody>
                  {latestTrades.map((trade) => (
                    <tr key={trade.symbol} className="border-b border-neutral-800">
                      <td className="py-3 font-semibold">{trade.symbol}</td>
                      <td className="py-3">
                        ${trade.price.toLocaleString()}
                      </td>
                      <td className="py-3">{trade.size}</td>
                      <td className="py-3 text-neutral-400">
                        {trade.timestamp
                          ? new Date(trade.timestamp).toLocaleString()
                          : "Unavailable"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className="mt-8 rounded-2xl border border-neutral-800 bg-neutral-900 p-6">
            <h2 className="mb-4 text-2xl font-bold">Recent Orders</h2>

            {orders.length === 0 ? (
              <p className="text-neutral-400">No recent paper orders yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-neutral-800 text-neutral-400">
                    <tr>
                      <th className="py-3">Symbol</th>
                      <th className="py-3">Side</th>
                      <th className="py-3">Qty</th>
                      <th className="py-3">Status</th>
                      <th className="py-3">Filled Price</th>
                      <th className="py-3">Submitted</th>
                    </tr>
                  </thead>

                  <tbody>
                    {orders.map((order) => (
                      <tr key={order.id} className="border-b border-neutral-800">
                        <td className="py-3 font-semibold">{order.symbol}</td>
                        <td className="py-3 uppercase">{order.side}</td>
                        <td className="py-3">{order.qty}</td>
                        <td className="py-3">{order.status}</td>
                        <td className="py-3">
                          {order.filledAvgPrice
                            ? `$${Number(order.filledAvgPrice).toLocaleString()}`
                            : "Not filled"}
                        </td>
                        <td className="py-3 text-neutral-400">
                          {new Date(order.submittedAt).toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <p className="mt-2 text-neutral-300">
            This app is currently connected to{" "}
            <strong>
              {account.paper ? "paper trading" : "live trading"}
            </strong>
            .
          </p>
        </div>
      </div>
    </main>
  );
}