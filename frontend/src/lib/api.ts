import type { CreateRunResponse, CreateTestRunRequest, GetRunResponse, ListRunsResponse, TestRun } from "./contracts";

export class ApiError extends Error {
  constructor(message: string, public readonly status: number | null = null) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      cache: "no-store",
      ...options,
      headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) },
    });
  } catch {
    throw new ApiError("Backend connection failed. Check your deployment or network connection.");
  }
  if (!response.ok) {
    if (response.status === 404 || response.status === 405 || response.status === 501) {
      throw new ApiError("Testing backend is not connected yet. The frontend is ready for integration.", response.status);
    }
    let detail = "The request failed. Please try again.";
    try { const body: unknown = await response.json(); if (body && typeof body === "object" && "error" in body && typeof body.error === "string") detail = body.error; } catch { /* non-JSON response */ }
    throw new ApiError(detail, response.status);
  }
  try { return await response.json() as T; }
  catch { throw new ApiError("The server returned an invalid JSON response.", response.status); }
}

function validRun(value: unknown): value is TestRun {
  if (!value || typeof value !== "object") return false;
  const run = value as Partial<TestRun>;
  return typeof run.id === "string" && typeof run.url === "string" && typeof run.requirement === "string" &&
    ["queued", "running", "completed", "error"].includes(run.status ?? "") &&
    (run.verdict === null || ["PASS", "FAIL", "INCONCLUSIVE"].includes(run.verdict ?? "")) &&
    Array.isArray(run.checks);
}
export async function createRun(payload: CreateTestRunRequest): Promise<TestRun> {
  const run = await request<CreateRunResponse>("/api/runs", { method: "POST", body: JSON.stringify(payload) });
  if (!validRun(run)) throw new ApiError("Backend response doesn't match the shared TestRun contract.");
  return run;
}
export async function getRun(id: string): Promise<TestRun> {
  const run = await request<GetRunResponse>(`/api/runs/${encodeURIComponent(id)}`);
  if (!validRun(run)) throw new ApiError("Backend response doesn't match the shared TestRun contract.");
  return run;
}
export async function listRuns(): Promise<TestRun[]> {
  const data = await request<ListRunsResponse>("/api/runs");
  if (!data || !Array.isArray(data.runs) || !data.runs.every(validRun)) {
    throw new ApiError("Backend history response doesn't match { runs: TestRun[] }.");
  }
  return data.runs;
}
