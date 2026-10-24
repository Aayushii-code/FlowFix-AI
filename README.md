# FlowFix AI — Aman Frontend/UI Package

**Status: React/Next.js frontend only.** No backend endpoints, TinyFish keys, fake runs, populated test history, screenshots, or simulated PASS/FAIL outcomes are included. Do not present this as a completed end-to-end testing service until Aayushi's backend and Meenu's database are integrated and proven live.

## Team ownership (updated)

- **Aman (@amanchoudhary92):** React UI, responsive design, dashboard, form, status, history, reports
- **Aayushi (@Aayushii-code):** Backend routes, TinyFish agent integration, independent verification
- **Meenu (@engmeenuyadav15-stack):** Supabase persistence, QA, deployment

## Run on Windows / VS Code

1. Install Node.js 22+ and Git.
2. One team member owns the initial project creation. Since GitHub repository was empty at packaging time, it is safe to commit this folder as the initial project **only if it remains empty**. If the repo has since changed, review and merge only owned frontend files—do not overwrite others' work.
3. Clone `https://github.com/Aayushii-code/FlowFix-AI.git`.
4. Copy this package's files into that clone. Keep the shared `src/lib/contracts.ts` and package versions agreed by the whole team.
5. In the clone, run `npm install` (generates `package-lock.json`), then `npm run dev`.
6. Open http://localhost:3000.
7. Run `npm run typecheck`, `npm run lint`, `npm run build` after installing dependencies.
8. Commit both `package.json` and generated `package-lock.json` in the shared initial foundation. Everyone else uses `npm ci` afterward. **Never run `create-next-app` a second time inside this project.**

## HTTP contract — backend must match exactly

`src/lib/contracts.ts` is the authoritative contract. Do not create alternative field names or guess conversions in UI components.

`POST /api/runs` accepts:

```json
{"url":"https://an-authorized-website.example","requirement":"User-provided natural-language test instruction","checks":[{"key":"user_defined_observation_name","operator":"equals","expected":"user-provided expected value"}]}
```

This JSON is **documentation illustrating the request shape only**. It is not embedded or used as production seed data.

`POST /api/runs` returns `TestRun` (201 or 200), `GET /api/runs/{id}` returns `TestRun`, and `GET /api/runs` returns `{ "runs": TestRun[] }`.

Statuses: `queued`, `running`, `completed`, `error`. Verdicts: `PASS`, `FAIL`, `INCONCLUSIVE`, or `null` while pending. Actual observation fields returned as `{ [key]: string }`; the backend must inspect evidence independently of agent success. Use the exact same check keys the user entered. Missing/ambiguous evidence results in `INCONCLUSIVE`, not a fabricated PASS.

For full details see the TypeScript file. `/api/runs` currently does **not** exist. The frontend makes actual requests and will show a clear 'Testing backend is not connected yet' message until the API is implemented. The dashboard and history deliberately show em dashes, not zero, when backend is unavailable.

## Screens

- `/` — Dashboard and real run overview
- `/tests/new` — URL + natural language requirement + dynamic assertion checks; validates client-side; calls real `POST /api/runs`
- `/history` — only actual persisted runs; never seeded
- `/runs/[id]` — actual status polling, observed-vs-expected checks, provider run ID, timestamps
- `/settings` — engineering overview and honest integration status

## API integration guidance for Aayushi

- Implement `POST /api/runs`, `GET /api/runs`, `GET /api/runs/[id]` under `src/app/api/runs/`.
- Keep `TINYFISH_API_KEY` server-side; never expose in `NEXT_PUBLIC_*`.
- Validate URL + authorization, prevent internal/private-host SSRF, rate-limit public requests, and do not allow destructive automated workflows.
- Run async at TinyFish; persist actual `providerRunId`; do not mark PASS just because TinyFish completed.
- No mocked API response or fallback demo data in production UI.

## Database guidance for Meenu

- Store real runs in Supabase; map snake_case database fields into `TestRun` camelCase inside the database adapter on server.
- Schema key names/enum values must match `contracts.ts`; no front-end-specific transformations needed.
- Run validation and security checks before deployment. Authentication or allowlist restrictions are necessary to avoid anonymous users consuming API wallet credits.

## Git, authorship and merge

- Single GitHub repo; use genuine member-owned contributions and verified Git email identities.
- Recommended branches: `feature/frontend-ui` (Aman), `feature/backend-tinyfish` (Aayushi), `feature/database-qa` (Meenu).
- Commit coherent real features incrementally; do not manufacture commit counts.
- Treat `package.json`, `package-lock.json`, `src/lib/contracts.ts` as shared files; changes require agreement.

## Verification limitation

This container does not have access to npm registry, so dependency installation and `next build` could not be executed here. The source is prepared for current Next.js App Router conventions, but installation/build must be verified on a networked developer laptop before claiming it passes. Do not claim backend integration works until tested.
