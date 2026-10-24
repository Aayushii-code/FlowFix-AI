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
          │              │            (only source of verdicts)  engine │
          │              │                                            │
          │              └──► in-memory store + SSE fan-out (Aman's UI) │
          └─────────────────────────────────────────────────────────────┘
```

- **TinyFish executes.** Real HTTP calls to
  `https://agent.tinyfish.ai/v1/automation/run-sse`, plus `GET /v1/runs/:id`
  (step screenshots / HTML) and `POST /v1/runs/:id/cancel`.
- **Meenu independently verifies.** The backend POSTs normalized
  observations + evidence to `VERIFICATION_ENGINE_URL/verify` and surfaces the
  engine's verdict verbatim. Errors/timeouts/invalid verdicts stay `verdict:
  null`.
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
| `VERIFICATION_ENGINE_URL` | — | Meenu's engine. Empty ⇒ verdicts stay `null` |
| `VERIFICATION_TIMEOUT_MS` | `20000` | Engine request timeout |

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
npm test               # 55 tests: unit + integration against a faithful TinyFish mock
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
402 failure, goal-level failure, SSE fan-out, and the invariant that an
execution without a verdict is never reported as PASS.

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

- **No frontend, no oracle/verification logic here.** This service executes,
  normalizes evidence, and integrates; verdicts belong to Meenu's engine.
- Executions are stored in process memory (no database) — intentionally, to
  keep this service focused; restarting clears history. The store is bounded:
  it retains the latest 500 executions and evicts the oldest completed ones
  (running executions are never evicted).
- The `scrapeme.live` / `httpbin.org` / `example.com` targets are public
  automation-friendly sites used by TinyFish's own docs examples.
- `GET /v1/runs/:id` evidence (screenshots) is fetched after the stream
  completes; if that fetch fails, the record notes it and keeps SSE evidence.
