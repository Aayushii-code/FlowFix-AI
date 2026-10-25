import type { CreateTestRunRequest } from "@/lib/contracts";
import { backendRequest, convertExecution, errorResponse } from "@/lib/backend-bridge";

export const runtime = "nodejs";

export async function GET() {
  try {
    const response = await backendRequest("/api/executions?limit=50");
    if (!response || typeof response !== "object" || !("executions" in response) ||
        !Array.isArray(response.executions)) {
      throw new Error("Backend execution history is not an array.");
    }
    return Response.json({ runs: response.executions.map(convertExecution) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return Response.json({ error: "Invalid test request." }, { status: 400 });
    }
    const input = body as Partial<CreateTestRunRequest>;
    let url: URL;
    try { url = new URL(input.url || ""); } catch {
      return Response.json({ error: "Enter a valid HTTPS website URL." }, { status: 400 });
    }
    // Initial defense-in-depth. Public deployments also need DNS/IP SSRF controls, auth, and quotas.
    if (url.protocol !== "https:" || !!url.username || !!url.password ||
        ["localhost", "127.0.0.1", "0.0.0.0", "[::1]"].includes(url.hostname) ||
        /^\d{1,3}(?:\.\d{1,3}){3}$|^\[.*\]$/.test(url.hostname) ||
        /\.(local|internal|test)$/i.test(url.hostname)) {
      return Response.json({ error: "Only authorized public HTTPS websites are allowed." }, { status: 400 });
    }
    if (typeof input.requirement !== "string" || input.requirement.trim().length < 12 || input.requirement.trim().length > 5000 ||
        !Array.isArray(input.checks) || input.checks.length < 1 || input.checks.length > 12 ||
        !input.checks.every((c) => c && typeof c.key === "string" &&
          /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(c.key) &&
          typeof c.expected === "string" && c.expected.trim().length > 0 &&
          ["equals", "contains", "not_equals"].includes(c.operator)) ||
        new Set(input.checks.map((c) => c.key)).size !== input.checks.length) {
      return Response.json({ error: "Enter a requirement and 1-12 checks with unique field-name keys (letters, numbers and underscores)." }, { status: 400 });
    }

    const health = await backendRequest("/api/health");
    if (!health || typeof health !== "object" || !("tinyfish_configured" in health) ||
        health.tinyfish_configured !== true) {
      return Response.json({ error: "TinyFish is not configured yet. Add the API key in backend/.env and restart the backend." }, { status: 503 });
    }

    const checks = input.checks.map((c) => ({
      key: c.key.trim(), operator: c.operator, expected: c.expected.trim(),
    }));
    const goal = `${input.requirement.trim()}\nReport the actual observed values for these field names as a JSON object: ${checks.map((c) => c.key).join(", ")}. When a field was not observed, use null. Never invent values.`;
    const raw = await backendRequest("/api/executions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: url.toString(), goal, requirement: input.requirement.trim(),
        expected_outcome: { type: "flowfix_explicit_checks_v1", checks },
        browser_profile: "lite",
        capture_config: { screenshots: true },
      }),
    });
    return Response.json(convertExecution(raw), { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
