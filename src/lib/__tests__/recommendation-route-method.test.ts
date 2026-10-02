import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("recommendation request semantics", () => {
  it("uses POST on both the route and its dashboard caller", () => {
    const routeSource = readFileSync(
      new URL("../../app/api/openai/recommendation/route.ts", import.meta.url),
      "utf8"
    );
    const componentSource = readFileSync(
      new URL("../../components/AiRecommendationCard.tsx", import.meta.url),
      "utf8"
    );

    expect(routeSource).toContain("export async function POST()");
    expect(routeSource).not.toContain("export async function GET()");
    expect(componentSource).toContain('method: "POST"');
  });
});
