import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Tests run in Node and mock external services at the route boundary. Modules
// that import "server-only" or Prisma should remain mocked rather than opening
// real database connections during the test suite.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
