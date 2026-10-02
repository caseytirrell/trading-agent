# Claude Trading Agent

A local-first Next.js dashboard for controlled Alpaca paper trading. OpenAI
provides structured market analysis and trade recommendations, while local
application code validates every executable trade and makes the final decision.

> **Paper trading only.** This project intentionally blocks live-order
> submission. Keep `TRADING_ENABLED=false` unless you are deliberately testing
> an order against an Alpaca paper account.

## Current capabilities

- Displays the Alpaca paper account, positions, market data, and recent orders.
- Generates manual OpenAI trade recommendations without placing an order.
- Runs a controlled autonomous-agent request that may submit one paper order
  only after deterministic validation and risk approval.
- Produces read-only Evening Analysis reports and saved report history with an
  explicit zero-order contract.
- Stores best-effort audit history in Neon Postgres when the database is
  configured.
- Enforces a fail-closed kill switch, approved-symbol list, whole-share limit,
  market-hours check, confidence threshold, daily trade limit, duplicate-order
  protection, position rules, cash check, and daily-loss limit.

Phases 1–3 are implemented. Morning revalidation, scheduling, notifications,
and public deployment protections are future work.

## Requirements

- Node.js 20.19 or newer
- npm
- Alpaca paper-trading credentials
- An OpenAI API key
- Optional: a Neon Postgres database matching `prisma/schema.prisma`

## Local setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create the local environment file:

   ```bash
   cp .env.local.example .env.local
   ```

3. Replace the placeholders in `.env.local` with your own paper-trading,
   OpenAI, and optional Neon credentials. Keep:

   ```bash
   ALPACA_ENDPOINT=https://paper-api.alpaca.markets
   TRADING_ENABLED=false
   ```

4. Start the development server:

   ```bash
   npm run dev
   ```

5. Open [http://localhost:3000](http://localhost:3000).

The tracked `.claude/launch.json` configuration provides the same `npm run
dev` launch command for compatible development tools.

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `ALPACA_ENDPOINT` | Yes | Must use `https://paper-api.alpaca.markets`; live order submission is blocked. |
| `ALPACA_API_KEY` | Yes | Alpaca paper-account API key. |
| `ALPACA_SECRET_KEY` | Yes | Alpaca paper-account secret. |
| `OPENAI_API_KEY` | Yes | Used for recommendation and Evening Analysis requests. |
| `TRADING_ENABLED` | Yes | Fail-closed kill switch. Only the exact value `true` permits paper-order submission. |
| `DATABASE_URL` | Optional | Pooled Neon connection used for best-effort runtime persistence. |
| `DIRECT_URL` | Optional | Direct Neon connection used only by Prisma inspection tooling. |

All credentials are server-side. Never prefix them with `NEXT_PUBLIC_`, and
never commit `.env.local`.

## Safety model

- OpenAI recommends; it never calls Alpaca directly.
- `runRiskCheck` is the final local execution gate.
- Every order-capable route fetches current Alpaca state and must pass the risk
  manager before submitting.
- `/api/agent/run`, `/api/alpaca/orders/place`, and
  `/api/alpaca/orders/test-buy` are the only order-capable routes.
- `/api/openai/recommendation` and `/api/agent/evening-analysis` are
  analysis-only and never place orders.
- Broker-side client order IDs and a process-wide execution lease protect
  against duplicate submissions.
- Database records are audit history, not trade instructions or proof of a
  fill. Alpaca remains the broker source of truth.

This application currently has no authentication or rate limiting. Run it
locally only; do not expose it through a public deployment, tunnel, or port
forward until those protections are added.

## Database rules

The Prisma schema maps an existing, manually managed Neon database. Prisma does
not own the schema.

- Do not run `prisma migrate dev`.
- Do not run `prisma db push`.
- `npm install` runs `prisma generate`; this generates the client without
  changing the database.
- Database persistence is best-effort. Trading and analysis flows continue if
  Neon is unavailable, but their persisted history may contain gaps.

To validate the local schema file without changing the database:

```bash
npx prisma validate
```

To compare it with Neon, provide `DIRECT_URL` in the shell and run the
read-only diff documented in `PROJECT_HANDOFF.md`.

## Verification

Run the complete local gate before committing:

```bash
npm test
npx tsc --noEmit
npm run lint
npm run build
npx prisma validate
npm audit
```

Do not test an order-submission endpoint against a real paper account unless
you intentionally want to create a paper order.

## Project reference

See [`PROJECT_HANDOFF.md`](./PROJECT_HANDOFF.md) for the detailed architecture,
route contracts, database mapping, safety boundaries, current limitations, and
future-phase context.
