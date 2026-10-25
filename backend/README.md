# FlowFix AI — Backend

FlowFix AI transforms natural-language business requirements into autonomous,
evidence-backed browser QA tests. It executes real user journeys with
[TinyFish](https://docs.tinyfish.ai/), captures verifiable evidence, and hands
that evidence to an **independent** verification engine that decides
PASS / FAIL / INCONCLUSIVE.

> **Core rule:** successful browser execution is **not** successful requirement
> verification. A `COMPLETED` execution means TinyFish finished the journey and
> returned output. A verdict exists only when the verification engine (Meenu's
> component) says so. This backend never computes PASS itself and never invents
> observations or evidence.

## Architecture

```
          ┌─────────────────────────────────────────────────────────────┐
          │                      FlowFix AI backend                     │
          │                                                             │
 POST     │  routes ──► execution engine ──► TinyFish Agent API (real)  │
 /api/…   │              │    │    │            │ STARTED/PROGRESS/…   │
          │              │    │    │            ▼                     │
          │              │    │    └──► SSE parser ──► observations &  │
          │              │    │                         evidence with   │
          │              │    │                         provenance      │
          │              │    │                                       │
          │              │    └──► verification adapter ──► Meenu's    │
          │              │            (external, precedence)    engine │
          │              │    └──► local verifier ◄── re-fetched page  │
          │              │         (checks only)      evidence         │
          │              │                                            │
          │              ├──► job queue (in-process ⇄ Redis/BullMQ)    │
          │              └──► SQLite: contracts, run history, audit     │
          │                   + in-memory live runs + SSE fan-out       │
          └─────────────────────────────────────────────────────────────┘
```

- **TinyFish executes.** Real HTTP calls to
  `https://agent.tinyfish.ai/v1/automation/run-sse`, plus `GET /v1/runs/:id`
  (step screenshots / HTML) and `POST /v1/runs/:id/cancel`.
- **Something independent verifies.** With `VERIFICATION_ENGINE_URL` set, the
  backend POSTs normalized observations + evidence to Meenu's engine and
  surfaces its verdict verbatim. Without it, FlowFix's own verifier
  (`src/verification/local-engine.js`) evaluates the requirement's `checks`
  against page content it re-fetches **itself** — the agent's self-report can
  never produce a verdict. Errors/timeouts/invalid verdicts stay `verdict:
  null`.
- **SQLite persists.** Contracts, run history and the audit log live in a
  database file (`DATABASE_PATH`), applied through ordered migrations, behind
  a repository layer (`src/db/repos/`) so PostgreSQL can replace it later.
- **Aman's frontend** consumes the REST + SSE contract documented in
  [`docs/API.md`](docs/API.md).

## Requirements

- Node.js ≥ 20 (developed on Node 24)
- A TinyFish API key — create one at
  [agent.tinyfish.ai/api-keys](https://agent.tinyfish.ai/api-keys)
- *(optional)* Meenu's verification engine URL; without it executions still
  run and produce evidence, but verdicts stay `null` (`UNAVAILABLE`).

## Quick start

```bash
npm install
cp .env.example .env        # then set TINYFISH_API_KEY (and optionally VERIFICATION_ENGINE_URL)
npm start                   # http://localhost:3000
```

Check the wiring:

```bash
curl http://localhost:3000/api/health
curl http://localhost:3000/api/scenarios
curl -X POST http://localhost:3000/api/executions \
  -H "Content-Type: application/json" \
  -d '{"scenario_id":"product-search"}'
```

Watch a run live:

```bash
curl -N http://localhost:3000/api/executions/<execution_id>/events
```

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `TINYFISH_API_KEY` | — | **Required for real runs.** Sent as `X-API-Key` |
| `TINYFISH_BASE_URL` | `https://agent.tinyfish.ai` | Override only for mocks/tests |
| `PORT` | `3000` | HTTP port |
| `EXECUTION_TIMEOUT_MS` | `300000` | Hard watchdog; on expiry the run is cancelled and marked `TIMED_OUT` |
| `MAX_CONCURRENT_EXECUTIONS` | `3` | Reject with `429 CONCURRENCY_LIMIT` beyond this |
| `VERIFICATION_ENGINE_URL` | — | Meenu's engine. When set it **overrides** local verification |
| `VERIFICATION_TIMEOUT_MS` | `20000` | Engine request timeout |
| `LOCAL_VERIFICATION` | `on` | FlowFix's own verifier; `off` ⇒ verdicts stay `null` when no external engine |
| `DATABASE_PATH` | `data/flowfix.db` | SQLite file (contracts, run history, audit log); `:memory:` for throwaway runs |
| `CORS_ORIGINS` | — (dev `*`) | Comma-separated allowlist before exposing the port |

Secrets live only in `.env` (gitignored). `.env.example` documents every key.

## The three scenarios

| id | Requirement under test | Journey (executed by TinyFish) |
|---|---|---|
| `product-search` | Searching the shop for "table" shows matching products | Search `scrapeme.live/shop` and report product names/prices |
| `contact-form` | Submitted contact-form values are echoed back | Fill and submit `httpbin.org/forms/post`, report echoed values |
| `content-freshness` | Landing page shows "Example Domain" and mentions "illustrative" | Read `example.com`, report headline + keyword presence |

Every scenario declares an `expected_outcome` that is forwarded **verbatim** to
the verification engine. The backend never interprets it into a verdict.

## Lifecycle, timeouts, errors

- Execution statuses: `QUEUED → RUNNING → COMPLETED | FAILED | TIMED_OUT |
  CANCELLED` (plus `INCOMPLETE` if the stream dies without a terminal event).
- A watchdog (`EXECUTION_TIMEOUT_MS`) aborts the SSE stream, calls TinyFish's
  cancel endpoint when the `run_id` is known, and settles the record as
  `TIMED_OUT`. Aborted streams release their HTTP connection — no zombie runs.
- Upstream TinyFish errors keep their documented shape: API errors map to
  `TINYFISH_<CODE>` with `retryable` flags; run failures preserve
  `{ code, message, category, retry_after }`.
- Goal-level failures (`COMPLETED` + `result.status = "failure"`) are surfaced
  as-is in observations — the browser ran, but the goal was not achieved. The
  verifier sees that evidence and decides.
- Verification settles **before** the execution is marked terminal, so a
  client observing `COMPLETED` always sees a settled verdict block.

## Evidence model

Every normalized item carries `source` provenance, e.g.
`tinyfish_sse:PROGRESS`, `tinyfish_run_object:steps[].screenshot`,
`tinyfish_sse:COMPLETE.result`. Evidence includes only artifacts TinyFish
actually returned (screenshot URLs, HTML snapshots, streaming URL, recording
URL, the verbatim event log). Missing data stays missing — no placeholders.

## Testing

```bash
npm test               # 80 tests: unit + integration against a faithful TinyFish mock
npm run test:unit
npm run test:integration
```

The integration suite starts:
- a **protocol-faithful TinyFish mock** that emits the documented SSE sequence
  (`STARTED → STREAMING_URL → PROGRESS → HEARTBEAT → COMPLETE`), serves
  `GET /v1/runs/:id` with step screenshots and the cancel endpoint, including
  documented error envelopes (401, 402, 400);
- a **mock verification engine** implementing Meenu's contract.

It exercises every endpoint, all three scenarios, timeout, cancel, upstream
402 failure, goal-level failure, SSE fan-out, run-history search and the
invariant that an execution without a verdict is never reported as PASS.

The mock also serves **fetchable step-HTML artifacts** (like real presigned
links), so the local verifier's independent re-fetch runs end-to-end offline:
`test/unit/local-verification.test.js` pins the verdict matrix — PASS needs
independent evidence, a proven violation is FAIL (with `SILENT_FAILURE` when
the agent claimed success), and missing/unreachable/self-reported-only
evidence is always INCONCLUSIVE.

### Live end-to-end smoke test (real browser)

```bash
TINYFISH_API_KEY=... node scripts/smoke-live.js --scenario product-search
```

This drives a genuine TinyFish browser session on `scrapeme.live/shop`,
prints the live SSE progress, normalizes the returned evidence, and — if
`VERIFICATION_ENGINE_URL` is set — asks the verification engine for an
independent verdict. Without a key it exits with code 2 and tells you so.
Nothing is fabricated: if the journey fails, the script fails.

## API

Full contract for the frontend and the verification engine:
[`docs/API.md`](docs/API.md).

## Scope & limitations

- **Verdicts never come from the browser agent.** An external engine wins when
  configured; otherwise FlowFix's own verifier decides from independently
  fetched evidence. With neither, the verdict stays `null` (`UNAVAILABLE`).
- **Live runs are in memory, history is in SQLite.** SSE subscribers need the
  live object, so active executions stay in process; every transition is also
  written to the database, which is the source of truth for run history and
  survives restarts. The in-memory layer stays bounded: the latest 500
  executions (running ones are never evicted) — evicted runs remain
  retrievable through the API because history is durable.
- **No authentication yet.** The API is open; set `CORS_ORIGINS` and put it
  behind auth before exposing the port beyond localhost.
- The `scrapeme.live` / `httpbin.org` / `example.com` targets are public
  automation-friendly sites used by TinyFish's own docs examples.
- `GET /v1/runs/:id` evidence (screenshots) is fetched after the stream
  completes; if that fetch fails, the record notes it and keeps SSE evidence.
