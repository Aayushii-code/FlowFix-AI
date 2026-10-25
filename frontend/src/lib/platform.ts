export type Check = {
  key: string;
  description?: string | null;
  source?: string;
  operator: string;
  expected: unknown;
  severity?: string;
  required?: boolean;
  path?: string;
  pattern?: string;
  transform?: string;
};
export type Execution = {
  execution_id: string;
  status: string;
  url: string;
  requirement?: string | null;
  goal?: string | null;
  contract_id?: string | null;
  checks?: Check[];
  expected_outcome?: { checks?: Check[] } | null;
  created_at?: string;
  finished_at?: string | null;
  error?: { code?: string; message?: string } | null;
  record?: {
    tinyfish_run_id?: string | null;
    step_count?: number | null;
    observations?: Array<Record<string, unknown>>;
    evidence?: Array<Record<string, unknown>>;
  } | null;
  verification?: {
    status?: string;
    verdict?: string | null;
    details?: { explanation?: string; summary?: string; checks?: Array<Record<string, unknown>>; reason_codes?: string[]; severity?: string; evidence_references?: string[] } | null;
  } | null;
};
export type Contract = {
  id: string;
  name: string;
  requirement: string;
  url: string | null;
  goal: string | null;
  checks: Check[];
  risk_level: string;
  status: string;
  version: number;
  source?: string;
  description?: string | null;
  updated_at?: string;
  created_at?: string;
};
export type CompileResult = { draft: Record<string, unknown> & { checks?: Check[]; name?: string; requirement?: string; goal?: string; url?: string; risk_level?: string }; confidence?: string; ambiguities?: Array<{ field?: string; message: string; suggestion?: string }> };
export type Capabilities = { tinyfish?: { configured: boolean }; verification?: { external_configured: boolean; local_enabled: boolean; engine: string }; persistence?: { kind: string; path: string }; queue?: { driver: string }; connectors?: Record<string, string> };

export function shortId(id?: string | null) { return id ? `${id.slice(0,8)}…` : '—'; }
export function formatDate(iso?: string | null) { return iso ? new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—'; }
export function friendlyError(error: unknown) { return error instanceof Error ? error.message : String(error); }
export function verdictKind(value?: string | null) { const v = (value ?? '').toUpperCase(); return v === 'PASS' ? 'pass' : v === 'FAIL' ? 'fail' : v === 'INCONCLUSIVE' ? 'warn' : 'muted'; }
export function terminal(status?: string) { return ['COMPLETED','FAILED','TIMED_OUT','CANCELLED','INCOMPLETE'].includes(status ?? ''); }

export async function api<T = Record<string, unknown>>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body != null && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(`/api/platform/${path.replace(/^\/+/, '')}`, {
    ...init, headers, cache: 'no-store'
  });
  const json: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const o = json as { error?: string | { message?: string }; message?: string };
    throw new Error(typeof o.error === 'string' ? o.error : o.error?.message ?? o.message ?? `Request failed (${response.status})`);
  }
  return json as T;
}
export function post<T>(path: string, data: unknown): Promise<T> { return api<T>(path, { method: 'POST', body: JSON.stringify(data) }); }
export function put<T>(path: string, data: unknown): Promise<T> { return api<T>(path, { method: 'PUT', body: JSON.stringify(data) }); }
export function del<T>(path: string): Promise<T> { return api<T>(path, { method: 'DELETE' }); }
