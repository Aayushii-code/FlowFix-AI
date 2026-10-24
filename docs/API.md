# FlowFix AI — Backend API Contract

Base URL (local): `http://localhost:3000`

All request/response bodies are JSON. Errors use one envelope:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "…", "retryable": false, "details": { } } }
```

**The one rule that matters:** `execution.status` describes the *browser run*.
`verification.verdict` is the *requirement verdict* and is produced **only** by
the independent verification engine (Meenu's component). A `COMPLETED`
execution with `verification.verdict = null` means *the browser ran and we have
evidence, but nobody has verified the requirement yet*. Never render such a run
as PASS or FAIL.

---

## 1. Health

### `GET /api/health`

```json
{
  "status": "ok",
  "service": "flowfix-ai-backend",
  "tinyfish_configured": true,
  "verification_configured": false,
  "running_executions": 1,
  "max_concurrent_executions": 3,
  "time": "2026-10-24T10:00:00.000Z"
}
```

The API boots without keys; `tinyfish_configured: false` means executions will
fail fast with `TINYFISH_NOT_CONFIGURED`.

---

## 2. Scenarios

### `GET /api/scenarios`

Returns the three built-in scenarios. Each binds a natural-language
**requirement** (what must be true) to a browser **journey** (what TinyFish
executes) and an opaque `expected_outcome` forwarded to the verification engine.

```json
{
  "scenarios": [
    {
      "id": "product-search",
      "name": "E-commerce product search",
      "requirement": "When a customer searches the shop for \"table\", the results page must show at least one product matching the search term.",
      "url": "https://scrapeme.live/shop",
      "goal": "Use the shop search to search for \"table\"…",
      "expected_outcome": { "type": "extracted_data_matches", "field": "products", "condition": "…" },
      "browser_profile": "lite"
    }
  ]
}
```

Built-in ids: `product-search`, `contact-form`, `content-freshness`.

---

## 3. Executions

### `POST /api/executions` → `202 Accepted`

Start a journey. Two mutually exclusive forms:

**Built-in scenario**

```json
{ "scenario_id": "product-search" }
```

**Ad-hoc journey** (Aman's UI can send free-form checks)

```json
{
  "url": "https://example.com",
  "goal": "Report the h1 headline",
  "requirement": "Landing page shows the Example Domain headline",
  "expected_outcome": { "type": "text_present", "headline": "Example Domain" },
  "browser_profile": "lite",
  "agent_config": { "max_steps": 20 },
  "capture_config": { "screenshots": true },
  "output_schema": { "type": "object", "properties": { "headline": { "type": "string" } } },
  "execution_timeout_ms": 120000
}
```

| Field | Type | Notes |
|---|---|---|
| `scenario_id` | string | One of the built-in ids |
| `url` | string | Absolute http(s) URL (ad-hoc) |
| `goal` | string | Non-empty natural-language goal (ad-hoc) |
| `requirement` | string? | Business requirement under test (ad-hoc); forwarded to the verifier |
| `expected_outcome` | object? | Opaque expectation; forwarded verbatim to the verifier |
| `browser_profile` | `"lite"` \| `"stealth"`? | |
| `agent_config` | object? | Passed through to TinyFish (`max_steps`, `max_duration_seconds`, `mode`) |
| `capture_config` | object? | `screenshots`, `html`, `recording`, … |
| `output_schema` | object? | JSON-Schema subset for structured results |
| `execution_timeout_ms` | number? | Per-execution watchdog (default `EXECUTION_TIMEOUT_MS`) |

**202 response** — the execution record (see `GET` below), initial status `QUEUED`.

Errors: `400 VALIDATION_ERROR`, `429 CONCURRENCY_LIMIT`, `503 TINYFISH_NOT_CONFIGURED`.

### `GET /api/executions?limit=50`

```json
{ "executions": [ { /* execution view */ } ] }
```
Newest first.

### `GET /api/executions/:id`

```json
{
  "execution_id": "a1b2c3d4-…",
  "scenario_id": "product-search",
  "requirement": "When a customer searches the shop for \"table\"…",
  "url": "https://scrapeme.live/shop",
  "goal": "…",
  "expected_outcome": { "type": "extracted_data_matches" },

  "status": "COMPLETED",
  "created_at": "2026-10-24T10:00:00.000Z",
  "finished_at": "2026-10-24T10:01:12.000Z",
  "timeout_ms": 300000,
  "error": null,

  "record": {
    "execution_status": "COMPLETED",
    "tinyfish_run_id": "run_abc123",
    "started_at": "…",
    "finished_at": "…",
    "step_count": 5,
    "observations": [
      { "kind": "agent_step", "index": 1, "action": "Navigate to shop", "observed_at": "…", "source": "tinyfish_sse:PROGRESS" },
      { "kind": "agent_result", "result": { "format": "object", "value": { "products": [ … ] } }, "source": "tinyfish_sse:COMPLETE.result" }
    ],
    "evidence": [
      { "kind": "step_screenshot", "step_id": "…", "url": "https://…", "captured_at": "…", "action": "…", "source": "tinyfish_run_object:steps[].screenshot" },
      { "kind": "step_html", "step_id": "…", "url": "https://…", "source": "tinyfish_run_object:steps[].html" },
      { "kind": "live_stream", "url": "https://…", "source": "tinyfish_sse:STREAMING_URL" },
      { "kind": "run_recording", "url": "https://…", "source": "tinyfish_run_object:video_url" },
      { "kind": "raw_event_log", "event_count": 12, "events": [ /* verbatim SSE events */ ], "source": "tinyfish_sse:stream" }
    ],
    "upstream_error": null,
    "execution_note": "COMPLETED indicates successful browser execution, not requirement verification. Verdicts come only from the verification engine."
  },

  "verification": {
    "status": "COMPLETED",
    "verdict": "PASS",
    "details": {
      "summary": "…",
      "checks": [ { "id": "c1", "description": "…", "passed": true } ],
      "engine": "http://verifier:8000",
      "verified_at": "…"
    }
  }
}
```

**`status` values** (execution lifecycle):

| Status | Meaning |
|---|---|
| `QUEUED` | Accepted, not started |
| `RUNNING` | TinyFish browser session active |
| `COMPLETED` | Browser finished and returned a result — **not** a verdict |
| `FAILED` | Upstream/API error (see `error`) |
| `TIMED_OUT` | FlowFix watchdog fired; upstream run cancelled |
| `CANCELLED` | Cancelled via API |
| `INCOMPLETE` | Stream ended without a terminal state |

**`verification.status` values:**

| Status | Verdict | Meaning |
|---|---|---|
| `PENDING` | `null` | Not attempted yet (execution still running) |
| `RUNNING` | `null` | Handed to the engine |
| `COMPLETED` | `PASS` \| `FAIL` \| `INCONCLUSIVE` | Engine's independent verdict |
| `UNAVAILABLE` | `null` | Engine not configured — requirement NOT verified |
| `ERROR` | `null` | Engine unreachable / malformed / timeout — NOT a verdict |
| `SKIPPED` | `null` | Execution failed/timed out/cancelled — nothing to verify |

> `COMPLETED` execution + `verification.status = UNAVAILABLE` is a fully
> successful browser run with **no** requirement verification. Render it as
> "Unverified".

### `POST /api/executions/:id/cancel`

```json
{ "execution_id": "…", "status": "CANCELLED", "already_finished": false }
```
Idempotent. Also cancels the upstream TinyFish run when its id is known.

### `GET /api/executions/:id/events` — SSE for the frontend

`text/event-stream`. Frames:

```
event: snapshot
data: { …execution view as of connection… }

event: status
data: { "kind": "status", "status": "RUNNING", "at": "…" }

event: upstream_event
data: { "kind": "upstream_event", "event": { "type": "PROGRESS", "purpose": "…" } }

event: record
data: { "kind": "record", "record": { …observations/evidence… } }

event: verification
data: { "kind": "verification", "verification": { "status": "COMPLETED", "verdict": "PASS", … } }

event: terminal
data: { "kind": "terminal", "status": "COMPLETED" }
```

Heartbeat comment frames (`: heartbeat`) every 15 s. The stream closes after
`terminal`. Reconnecting replays history from the snapshot, so late clients see
the full story.

### `POST /api/executions/:id/verify`

Explicitly (re)run verification on a `COMPLETED` execution — e.g. after the
engine was down. Replaces a prior `ERROR`/`UNAVAILABLE` result. `409
EXECUTION_NOT_COMPLETED` otherwise.

```json
{ "execution_id": "…", "verification": { "status": "COMPLETED", "verdict": "FAIL", … } }
```

### `GET /api/executions/:id/report` — auditable test report

```json
{
  "report_version": "1.0",
  "generated_at": "…",
  "execution": { "execution_id": "…", "requirement": "…", "status": "COMPLETED", "…": "…" },
  "observations": [ … ],
  "evidence": [ { "kind": "step_screenshot", "url": "…" } ],
  "verification": { "status": "COMPLETED", "verdict": "PASS", "details": { … } },
  "verdict": "PASS",
  "verdict_note": "Verdict produced by the independent verification engine."
}
```

The raw event log is summarized (counts) in reports rather than duplicated.

---

## 4. Verification engine contract (Meenu)

When `VERIFICATION_ENGINE_URL` is set, the backend calls:

### `POST {VERIFICATION_ENGINE_URL}/verify`

Request:

```json
{
  "execution_id": "…",
  "scenario_id": "product-search",
  "requirement": "When a customer searches…",
  "url": "https://scrapeme.live/shop",
  "goal": "…",
  "expected_outcome": { "type": "extracted_data_matches", "…": "…" },
  "execution_status": "COMPLETED",
  "observations": [ /* normalized facts with provenance */ ],
  "evidence": [ /* artifacts: screenshots, html, streaming url, raw log */ ]
}
```

Expected response:

```json
{
  "verdict": "PASS",
  "summary": "Search results contained products matching 'table'.",
  "checks": [
    { "id": "c1", "description": "at least one product matching", "passed": true, "observed": "…", "expected": "…" }
  ]
}
```

Rules enforced by the adapter:

- `verdict` must be exactly `PASS`, `FAIL`, or `INCONCLUSIVE` (case-sensitive).
- Any other value, non-JSON body, non-2xx status, or timeout ⇒
  `verification.status = ERROR`, `verdict = null`. **Never coerced.**
- The engine is independent: it receives raw observations/evidence and decides.
  The backend does not pre-evaluate the expectancy.

Timeout: `VERIFICATION_TIMEOUT_MS` (default 20 000 ms).

---

## 5. Error codes

| Code | HTTP | Meaning |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Bad input (details explain) |
| `INVALID_JSON` | 400 | Malformed JSON body |
| `NOT_FOUND` | 404 | Unknown execution |
| `CONCURRENCY_LIMIT` | 429 | Too many running executions (`MAX_CONCURRENT_EXECUTIONS`) |
| `EXECUTION_NOT_COMPLETED` | 409 | Verification requested before a successful execution |
| `EXECUTION_TIMEOUT` | — (record) | Watchdog expired; run cancelled |
| `TINYFISH_NOT_CONFIGURED` | 503 | `TINYFISH_API_KEY` missing |
| `TINYFISH_<UPSTREAM_CODE>` | 400/404/502 | Mapped TinyFish API error (`INVALID_INPUT`, `INSUFFICIENT_CREDITS`, `RATE_LIMIT_EXCEEDED`, …) with `retryable` flag |
| `TINYFISH_NETWORK_ERROR` | 502 | Transport failure to TinyFish |
| `INTERNAL_ERROR` | 500 | Unexpected server error |

TinyFish run-level failures (HTTP 200 + `COMPLETE.status = FAILED`) surface as
`status: "FAILED"` with the upstream `error` object (`code`, `message`,
`category`, `retry_after`) preserved on `record.upstream_error` and `error`.

---

## 6. Frontend state guidance (Aman)

1. `POST /api/executions` → store `execution_id`.
2. Open `GET /api/executions/:id/events` with `EventSource`.
3. Render progress from `upstream_event` (`PROGRESS` → `purpose`), optionally
   embedding the live `streaming_url` from the record/evidence.
4. On `terminal`, fetch the execution/report.
5. Show **two distinct badges**:
   - Execution: Completed / Failed / Timed out / Cancelled.
   - Verification: PASS / FAIL / INCONCLUSIVE / Unverified (never imply PASS
     from execution status alone).
6. Link every claim to `evidence[]` (screenshot URL, HTML snapshot, raw log).
