import "server-only";
import { PrismaClient } from "@prisma/client";

// Server-only Prisma client singleton.
//
// Security boundary (do not change): this module must never be imported from
// a client component — the "server-only" import makes that a build error.
// DATABASE_URL / DIRECT_URL are server-side secrets in .env.local and must
// never be exposed with a NEXT_PUBLIC_ prefix or returned in API responses.
//
// The client is created lazily and cached on globalThis so Next.js dev-mode
// hot reloads (and warm serverless instances) reuse one connection pool
// instead of exhausting the Neon free-plan connection limit.

const globalForPrisma = globalThis as unknown as { prismaClient?: PrismaClient };

export function isDatabaseConfigured(): boolean {
  return (
    typeof process.env.DATABASE_URL === "string" &&
    process.env.DATABASE_URL.length > 0
  );
}

export function getDb(): PrismaClient {
  if (!isDatabaseConfigured()) {
    throw new Error("DATABASE_URL is not configured.");
  }

  if (!globalForPrisma.prismaClient) {
    globalForPrisma.prismaClient = new PrismaClient();
  }

  return globalForPrisma.prismaClient;
}
