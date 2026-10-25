import type { TestRun, VerificationCheck, Verdict } from "./contracts";

type JsonObject = Record<string, unknown>;

const objectOf = (value: unknown): JsonObject | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;

export class BackendError extends Error {
  constructor(message: string, public readonly status = 502) {
    super(message);
    this.name = "BackendError";
  }
}

export async function backendRequest(path: string, init: RequestInit = {}): Promise<unknown> {
  // Server-side setting only. Never derive the backend hostname from user input.
  const base = process.env.FLOWFIX_BACKEND_URL || "http://127.0.0.1:3001";
  let url: URL;
  try {
    url = new URL(path, `${base.replace(/\/+$/, "")}/`);
    if (!url.pathname.startsWith("/api/")) throw new Error("Invalid API path");
  } catch {
    throw new BackendError("Invalid FLOWFIX_BACKEND_URL configuration.", 500);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      cache: "no-store",
      signal: AbortSignal.timeout(12000),
    });
  } catch {
    throw new BackendError("FlowFix backend is unavailable. Start the backend on port 3001.", 503);
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new BackendError("Backend returned an invalid JSON response.", 502);
  }

  if (!response.ok) {
    const outer = objectOf(data);
    const details = objectOf(outer?.error);
    const message =
      (typeof outer?.error === "string" && outer.error) ||
      (typeof details?.message === "string" && details.message) ||
      `Backend request failed (${response.status}).`;
    throw new BackendError(message, response.status);
  }
  return data;
}

function isCheck(value: unknown): value is VerificationCheck {
  const check = objectOf(value);
  return !!check && typeof check.key === "string" &&
    typeof check.expected === "string" &&
    (check.operator === "equals" || check.operator === "contains" || check.operator === "not_equals");
}

function observedFields(rawRecord: unknown): Record<string, string> | null {
  const record = objectOf(rawRecord);
  if (!Array.isArray(record?.observations)) return null;
  // Only extract actual TinyFish agent_result fields. No inference or invented observations.
  const resultEntry = record.observations.find((item: unknown) => objectOf(item)?.kind === "agent_result");
  const value = objectOf(objectOf(resultEntry)?.result)?.value;
  const fields = objectOf(value);
  if (!fields) return null;

  const output: Record<string, string> = {};
  for (const [key, item] of Object.entries(fields)) {
    if (item === null || item === undefined) continue;
    if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
      output[key] = String(item);
    } else {
      output[key] = JSON.stringify(item);
    }
  }
  return Object.keys(output).length ? output : null;
}

export function convertExecution(rawValue: unknown): TestRun {
  const value = objectOf(rawValue);
  if (!value || typeof value.execution_id !== "string" || typeof value.url !== "string") {
    throw new BackendError("Backend execution response does not match its documented contract.");
  }
  const expected = objectOf(value.expected_outcome);
  const checks = Array.isArray(expected?.checks) ? expected.checks.filter(isCheck) : [];
  const record = objectOf(value.record);
  const verification = objectOf(value.verification);
  const rawVerdict = verification?.verdict;
  const verdict: Verdict | null =
    rawVerdict === "PASS" || rawVerdict === "FAIL" || rawVerdict === "INCONCLUSIVE"
      ? rawVerdict : null;

  const state = typeof value.status === "string" ? value.status.toUpperCase() : "UNKNOWN";
  const status: TestRun["status"] =
    state === "QUEUED" ? "queued" : state === "RUNNING" ? "running" :
    state === "COMPLETED" ? "completed" : "error";
  const rawError = objectOf(value.error);
  const error = typeof value.error === "string" ? value.error :
    typeof rawError?.message === "string" ? rawError.message :
    status === "error" ? `Browser execution ended with status ${state}.` : null;

  return {
    id: value.execution_id,
    providerRunId: typeof record?.tinyfish_run_id === "string" ? record.tinyfish_run_id : null,
    url: value.url,
    requirement: typeof value.requirement === "string" ? value.requirement : "",
    checks,
    status,
    verdict, // ONLY the independent verifier's verdict; never inferred from COMPLETED.
    observations: observedFields(value.record),
    error,
    createdAt: typeof value.created_at === "string" ? value.created_at : "",
    completedAt: typeof value.finished_at === "string" ? value.finished_at : null,
  };
}

export function errorResponse(error: unknown): Response {
  const status = error instanceof BackendError ? error.status : 500;
  const message = error instanceof Error ? error.message : "Unexpected bridge error.";
  return Response.json({ error: message }, { status });
}
