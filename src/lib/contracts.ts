/** FROZEN CONTRACT v1 — any changes require approval from Aman, Aayushi and Meenu. */
export type ComparisonOperator = "equals" | "contains" | "not_equals";

export type VerificationCheck = {
  key: string;
  operator: ComparisonOperator;
  expected: string;
};

export type CreateTestRunRequest = {
  url: string;
  requirement: string;
  checks: VerificationCheck[];
};

export type RunStatus = "queued" | "running" | "completed" | "error";
export type Verdict = "PASS" | "FAIL" | "INCONCLUSIVE";

export type TestRun = {
  id: string;
  providerRunId: string | null;
  url: string;
  requirement: string;
  checks: VerificationCheck[];
  status: RunStatus;
  verdict: Verdict | null;
  observations: Record<string, string> | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
};

export type CreateRunResponse = TestRun;
export type GetRunResponse = TestRun;
export type ListRunsResponse = { runs: TestRun[] };

/** IMPORTANT: TinyFish's execution-completed state is NOT a verification PASS. */
