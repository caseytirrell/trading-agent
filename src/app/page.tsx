import {
  getAlpacaAccount,
  getAlpacaPositions,
  getLatestStockTrades,
  getAlpacaOrders,
} from "@/lib/alpaca";
import AiRecommendationCard from "@/components/AiRecommendationCard";
import AutonomousAgentCard from "@/components/AutonomousAgentCard";
import DashboardRefreshButton from "@/components/DashboardRefreshButton";
import EveningAnalysisCard from "@/components/EveningAnalysisCard";
import { APPROVED_SYMBOLS } from "@/lib/trading-universe";

export const dynamic = "force-dynamic";

function formatDateTime(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "N/A";
}

export default async function Home() {
  const [account, positions, latestTrades, orders] = await Promise.all([
    getAlpacaAccount(),
    getAlpacaPositions(),
    getLatestStockTrades([...APPROVED_SYMBOLS]),
    getAlpacaOrders(),
  ]);

  return (
    <main className="min-h-screen bg-neutral-950 p-8 text-white">
      <div className="mx-auto max-w-7xl">
        {/* Header */}
        <div className="mb-8 flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
          <div>
            <p className="mb-2 text-sm uppercase tracking-wide text-green-400">
              Claude Trading Agent
            </p>
            <h1 className="text-4xl font-bold">Paper Trading Dashboard</h1>
          </div>

          <DashboardRefreshButton />
        </div>

        {/* Account summary cards */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
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

        {/* Safety check */}
        <section
          className={`mt-8 rounded-2xl border p-6 ${
            account.paper
              ? "border-green-900 bg-green-950/40"
              : "border-red-900 bg-red-950/40"
          }`}
        >
          <p
            className={`font-semibold ${
              account.paper ? "text-green-300" : "text-red-300"
            }`}
          >
            Safety Check
          </p>
          <p className="mt-2 text-neutral-300">
            This app is currently connected to{" "}
            <strong>{account.paper ? "paper trading" : "live trading"}</strong>.
            The AI only recommends trades. Orders can be submitted only by
            guarded server routes, and every order must pass the local risk
            manager before reaching Alpaca paper trading.
          </p>
        </section>

        {/* Interactive cards — two columns on large screens to cut scrolling.
            Default grid alignment stretches each card to its row's height,
            so side-by-side cards are always equal in length. */}
        <div className="mt-8 grid gap-6 lg:grid-cols-2">
          {/* AI recommendation (client component, only calls OpenAI on click) */}
          <AiRecommendationCard />

          {/* Evening analysis (client component, manual read-only watchlist —
              it can never place or queue orders) */}
          <EveningAnalysisCard />

          {/* Autonomous agent (client component, only calls /api/agent/run) */}
          <AutonomousAgentCard />
        </div>

        {/* Positions and market watch — side by side on large screens,
            stretched to equal height */}
        <div className="mt-8 grid gap-6 lg:grid-cols-2">
          {/* Current positions */}
          <section className="rounded-2xl border border-neutral-800 bg-neutral-900 p-6">
            <h2 className="mb-4 text-2xl font-bold">Current Positions</h2>

            {positions.length === 0 ? (
              <p className="text-neutral-400">No current paper positions yet.</p>
            ) : (
              <div className="max-h-96 overflow-x-auto overflow-y-auto">
                <table className="w-full text-left text-sm">
                  <thead className="sticky top-0 bg-neutral-900 text-neutral-400">
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
                      <tr
                        key={position.symbol}
                        className="border-b border-neutral-800"
                      >
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
          </section>

          {/* Market watch */}
          <section className="rounded-2xl border border-neutral-800 bg-neutral-900 p-6">
            <h2 className="mb-4 text-2xl font-bold">Market Watch</h2>

            <div className="max-h-96 overflow-x-auto overflow-y-auto">
              <table className="w-full text-left text-sm">
                <thead className="sticky top-0 bg-neutral-900 text-neutral-400">
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
                      <td className="py-3">${trade.price.toLocaleString()}</td>
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
          </section>
        </div>

        {/* Recent orders */}
        <section className="mt-8 rounded-2xl border border-neutral-800 bg-neutral-900 p-6">
          <h2 className="mb-4 text-2xl font-bold">Recent Orders</h2>

          {orders.length === 0 ? (
            <p className="text-neutral-400">No recent paper orders yet.</p>
          ) : (
            <div className="max-h-96 overflow-x-auto overflow-y-auto">
              <table className="w-full text-left text-sm">
                <thead className="sticky top-0 bg-neutral-900 text-neutral-400">
                  <tr>
                    <th className="py-3">Symbol</th>
                    <th className="py-3">Side</th>
                    <th className="py-3">Qty</th>
                    <th className="py-3">Status</th>
                    <th className="py-3">Filled Qty</th>
                    <th className="py-3">Filled Price</th>
                    <th className="py-3">Filled At</th>
                    <th className="py-3">Submitted</th>
                    <th className="py-3">Closed Reason</th>
                  </tr>
                </thead>

                <tbody>
                  {orders.map((order) => (
                    <tr key={order.id} className="border-b border-neutral-800">
                      <td className="py-3 font-semibold">{order.symbol}</td>
                      <td className="py-3 uppercase">{order.side}</td>
                      <td className="py-3">{order.qty}</td>
                      <td className="py-3">{order.status}</td>
                      <td className="py-3">{order.filledQty}</td>
                      <td className="py-3">
                        {order.filledAvgPrice
                          ? `$${Number(order.filledAvgPrice).toLocaleString()}`
                          : "Not filled"}
                      </td>
                      <td className="py-3 text-neutral-400">
                        {formatDateTime(order.filledAt)}
                      </td>
                      <td className="py-3 text-neutral-400">
                        {formatDateTime(order.submittedAt)}
                      </td>
                      <td className="py-3 text-neutral-400">
                        {order.expiredAt
                          ? `Expired ${formatDateTime(order.expiredAt)}`
                          : order.canceledAt
                            ? `Canceled ${formatDateTime(order.canceledAt)}`
                            : order.failedAt
                              ? `Failed ${formatDateTime(order.failedAt)}`
                              : "N/A"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
