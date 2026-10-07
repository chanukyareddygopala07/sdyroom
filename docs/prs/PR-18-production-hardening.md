# PR 18 — Production hardening and launch readiness

**Status:** specification only — no GitHub PR exists.
**Owner:** Dev B (Cursor) · **Complexity:** XL · **Migration:** `0017_production_hardening.sql` (only if probes require it — see Database)
**Depends on:** PR 10 (rate limits + upload caps), PR 19 (shell/a11y baseline), PR 21 (coverage floor + docs contract); core features 06–09, 12–17 as available — **last in the roadmap by design**
**Sequencing note:** this PR is deliberately numbered 18 but merges last; treat its checklist as the launch gate.

---

### Problem

Everything built so far is feature-complete against its own spec but the
repository has **no production posture**: no structured request logging or
correlation ids, no health endpoint, no uptime/latency signal, no explicit
timeout/retry policy on outbound calls (storage, provider), no documented
rollback or migration-rollback story, no environment matrix, no backup/PITR
verification, no load sanity check, and no launch checklist that ties the
standards in `docs/SECURITY.md` to runnable verification. The CI pipeline
proves code quality, not service readiness. Shipping on day one would mean
discovering all of the above during the first incident.

### User story

As the operator launching SdyRoom, I can deploy with a checklist I have
actually executed — health checks, observability, error budgets I can see,
rollback I have rehearsed, data I have restored once — and when something breaks
at 11pm during exam week I can find out what happened from logs, not from
user reports.

---

### Scope

- **Health & readiness**: `GET /api/health` (liveness: process up, version,
  uptime) and `GET /api/health/ready` (readiness: DB reachable — one lightweight
  query, storage reachable, and `status: 'degraded'` with per-check detail when
  a dependency is down). Public, unauthenticated, **no sensitive detail**
  (no connection strings, no internal hostnames, no stack traces).
- **Structured logging**: a single `lib/server/log.ts` logger (JSON lines to
  stdout) with `request_id` (generated per request, echoed as
  `x-request-id`), route, method, status, duration_ms, user_id (nullable),
  error code. Wire it into every API route via a small wrapper or middleware —
  **choose the mechanism that does not wrap every handler by hand** (a
  `withLogging` helper or middleware-level logging; document the choice).
  Existing `console.*` in `app/api` is replaced (count them first; that count
  goes in the PR description).
- **Redaction rules**: never log bodies of auth routes, tokens, signed URLs,
  `token_hash`, provider keys, report `reporter_id`, or chat message content.
  Implemented as a redaction list in the logger and **unit-tested** (a test
  feeds every sensitive field name through and asserts absence).
- **Outbound resilience**: one helper for storage + AI provider calls with
  explicit timeouts (documented per call), bounded retry with backoff for
  idempotent operations only (never retry a provider completion blindly —
  document which calls are retryable), and a circuit-ish "fail fast after N
  consecutive failures" guard for the provider (simple counter, no library).
- **Request hygiene**: timeout on long routes (ingest/generate/ask already
  bounded — verify and state), `x-request-id` propagation into logs and error
  responses (`{ error: { code, message, request_id } }` — additive field, check
  contract docs), and a global error boundary that logs with the request id and
  returns the standard envelope for API routes / the `error.tsx` surface for
  pages.
- **Observability signal**: a tiny `/api/metrics` (or logs-only decision — see
  Out of scope) exposing **counters already derivable**: request counts by
  route class, error counts by code, p50/p95 duration buckets per route over a
  rolling window (in-memory is fine for a single instance; document the
  single-instance caveat honestly). Prefer **logs-first**: if the metrics
  endpoint cannot be made honest without a metrics backend, ship logs only and
  say so — do not build a fake dashboard.
- **Environment matrix & config audit**: `docs/DEVELOPMENT.md` (from PR 21)
  gains a production env table: every variable, required/optional, default,
  where to obtain it, and what breaks if missing. A CI-time check fails if
  `.env.example` drifts from the set of `process.env.*` reads in the codebase
  (script similar to PR 21's checks).
- **Data safety verification**: documented, executed once and recorded:
  - Supabase PITR/backups enabled (or the free-tier equivalent) — documented
    with where to click;
  - a **restore drill**: restore a backup to a scratch project / use `pg_dump`
    + reload locally, record time and result;
  - migration rollback story: forward-only policy stated, with the concrete
    recovery path (restore from backup / ship a compensating migration), and a
    rule that migrations must be revertible by data loss standards (no `drop
    column` in the same PR that stops using it — expand/contract).
- **Deletion/retention**: implement what the docs already promise —
  `prune_notifications` (from PR 11) runnable, storage orphan sweep documented
  as an operator task (PR 10), and a stated retention policy table.
- **Load sanity check**: a small k6/autocannon script (or `ab` — prefer
  whatever needs no new dependency if reasonable) hitting the read paths
  (`/api/rooms`, room fetch, resource list) for ~60s at a modest concurrency
  (e.g. 25), recording p95 and error rate; run locally against staging, paste
  results into the PR. **Numbers reported, not invented.**
- **Launch checklist**: `docs/RELEASE.md` (or a section in `docs/DEVELOPMENT.md`)
  — a runnable checklist: env set, secrets in place, migrations applied,
  bucket configured (size/type limits from 10), CI green on main, health checks
  wired, backups verified, restore drill done, monitoring/log access confirmed,
  a11y axe gate green (19), coverage floor green (21), smoke test script run,
  rollback rehearsed (revert deploy), on-call/owner named.
- **Smoke test script**: `npm run smoke` hitting a deployed URL's health,
  sign-in-less read paths, and asserting expected status codes — the last gate
  after deploy.

### Out of scope

- **Third-party APM/monitoring SaaS** (Sentry, Datadog, New Relic, Grafana
  Cloud) — requires accounts/secrets the repo does not have; standing question.
  Ship logs + health + local metrics; integration is a follow-up.
- Autoscaling, multi-region, CDN configuration, edge caching strategy (beyond
  noting what the platform already does).
- WAF, DDoS protection, bot management (platform-level, outside the app).
- Canary/blue-green deployment tooling, feature flags infrastructure (no flag
  system exists; do not invent one for this PR).
- CI/CD pipeline changes beyond wiring the new checks (deployment automation
  itself belongs to the platform where the app is hosted — document, don't
  build, if the repo has no deploy pipeline).
- Load testing at production-scale volumes, soak testing, chaos testing.
- Formal SLO/SLI definition with error budgets (state targets as aspirational
  numbers only if measured — otherwise leave a placeholder marked **TBD after
  baseline**, which PR 21's docs discipline would accept).
- Penetration testing, external security audit (note as a pre-launch
  recommendation with a named owner, not something this PR performs).
- Legal/compliance work (privacy policy, terms, age handling, DPDP/GDPR
  assessments) — explicitly a product/legal follow-up; list it.
- Any feature work from 06–17 (this PR must not contain feature code).

---

### Frontend work

- Global `error.tsx` behaviour review: page errors surface a retry affordance
  and a request id the user can report (displayed only in non-production if
  that is the chosen rule — decide and document; showing a request id to users
  is useful and harmless, recommend showing it).
- A minimal **status/offline banner** if readiness is `degraded` (optional —
  only if it can be wired without polling every page; otherwise document that
  users see standard error states).
- Nothing else — no UI redesign.

### Backend work

| Route / piece | Behavior |
| --- | --- |
| `GET /api/health` | `200 { status: 'ok', version, uptime_s }` — no auth, no DB call. |
| `GET /api/health/ready` | `200 { status: 'ok', checks: { db, storage } }` or `503 { status: 'degraded', checks: { db: 'down', storage: 'ok' } }` — one cheap DB statement, storage head/exists on a known object or bucket listing with a short timeout. |
| `lib/server/log.ts` | JSON-line logger with redaction; `request_id` in/out. |
| Middleware or `withLogging` | Per-request timing + access log line; error paths log `code` + stack **server-side only**. |
| `lib/server/http.ts` | `fetchJson`/`fetchWithTimeout` used by storage + AI provider paths: timeouts, bounded retry for idempotent verbs, consecutive-failure guard. |
| Error boundary | API: standard envelope + `request_id`; pages: existing `error.tsx` pattern. |
| `scripts/smoke.ts` (or `.mjs`) | `npm run smoke -- --base=https://…` health + read-path assertions, non-zero exit on failure. |
| `scripts/check-env.ts` | `.env.example` ↔ code `process.env` drift check for CI (extends PR 21's check family). |

Touch points: the storage call sites (resource upload/fetch/delete) and the AI
provider call site (PR 12) move onto the resilient helper — **this is the one
cross-cutting edit**, and it must be behaviour-preserving (same error codes
surfaced). Coordinate with whichever feature PRs are open.

### Database work

`supabase/migrations/0017_production_hardening.sql` — **only if probes demand
it**; expected contents (verify each against the schema first):

- `grant execute on function pg_stat_statements…` — no; **do not** add
  extensions casually. Likely actual needs:
  - Ensure the counters used by health/metrics do not require new privileges
    (prefer app-level in-memory metrics → no migration).
  - Possibly a `request_logs` table is **rejected**: logging to the database
    from every request is a foot-gun; logs go to stdout. No table.
- So: expect **no migration** unless a probe reveals a missing grant needed by
  `health/ready` (e.g. a role that cannot run the chosen check query). If one
  is needed, ship `0017` with revoke-first discipline and justify it.
- **Retention jobs**: `prune_notifications` (PR 11) and any `sweep` RPCs get a
  documented invocation runbook — no cron is added here (no scheduler exists in
  the repo); if the hosting platform offers scheduled functions, document the
  exact wiring as a manual step.

### Storage work

- Verify bucket settings from PR 10 (size cap, MIME allow-list, private
  access) in the **production** project and record the screenshots/steps in the
  launch checklist.
- Confirm signed-URL TTL, and that no route logs a signed URL (grep + the
  logger's redaction test).

### Realtime work

- Verify the `realtime` publication/RLS posture from PRs 06/11 in production
  (channel auth works with the RLS rules as merged); document the check as a
  launch-checklist item with the exact steps (open two browsers, invite, see
  presence/notifications).
- No new channels.

### AI work

- Provider resilience only (timeouts, failure guard, fail-loud behaviour) —
  no new AI features, no model changes.

---

### Security requirements

A user must **not** be able to:

1. Read health endpoints in a way that discloses infrastructure (no hosts,
   versions beyond a public app version, no config values).
2. Forge or read `request_id`-correlated logs containing sensitive material —
   the redaction test is the control: tokens, signed URLs, auth bodies,
   `reporter_id`, chat content, provider keys must all be provably absent.
3. Use `/api/metrics` (if shipped) as an information source for other users'
   traffic — metrics are aggregate counters with no user or room identifiers,
   and the endpoint is either unauthenticated-with-no-detail or
   authenticated-admin (there is no admin role — so: aggregate-only,
   unauthenticated, no route-level cardinality that reveals private room ids).
4. Trigger unbounded outbound work through retries (retry only idempotent
   calls, bounded attempts, backoff).
5. Panic a route into leaking a stack trace to the client (boundary returns
   the envelope; stack is log-side only).

Positive guarantees:

- Every error response carries `request_id` matching a log line (tested by
  grepping captured stdout in an integration test).
- Backup/restore drill executed and recorded (a checklist item with a date,
  not an aspiration).
- The launch checklist is executable end-to-end by someone who did not write
  the code.

### API contracts

```jsonc
// GET /api/health   200
{ "status": "ok", "version": "…", "uptime_s": 1234 }
// GET /api/health/ready   200 | 503
{ "status": "ok" | "degraded",
  "checks": { "db": "ok" | "down", "storage": "ok" | "down" },
  "checked_at": "…" }
// error envelope — additive field
{ "error": { "code": "…", "message": "…", "request_id": "…" } }
// GET /api/metrics (if shipped)   200
{ "requests": { "/api/rooms": { "count": 1204, "p50_ms": 41, "p95_ms": 180,
                                "errors": { "500": 0 } } },
  "window_s": 300, "instance": "single" }
```

Additive changes only — `request_id` is documented in
`docs/API_CONTRACTS.md`; existing clients ignore it (verify no test asserts an
exact error object without the new field — update those assertions if they
exist).

| Error | Code |
| --- | --- |
| 503 | `not_ready` (readiness only) |
| 500 | unchanged codes + `request_id` |

### Tests

**Unit**

- Logger redaction: table-driven test over every sensitive key
  (`authorization`, `token`, `token_hash`, `signed_url`, `refresh_token`,
  `password`, `api_key`, `reporter_id`, chat `content`, auth request bodies) →
  assert rendered line contains `<redacted>` and not the value.
- `request_id` propagation: generated when absent, preserved when supplied
  (and validated — reject absurd lengths), present in error envelope.
- Resilient fetch: timeout fires, retry only on idempotent + retryable status,
  backoff schedule, consecutive-failure guard opens and half-opens.
- Health handlers: `/health` never touches the DB (spy), `/ready` maps
  dependency failure → `503` + `degraded` with per-check detail, no sensitive
  fields in either payload.
- Metrics (if shipped): no user/room identifiers in keys, window expiry works.
- `check-env`: drift in either direction fails.

**Integration (`tests/integration/production-hardening.test.ts`)**

- Health endpoints respond as specified against a live local DB.
- Force a dependency failure (e.g. point storage check at a bad project in the
  test env, or stub the dependency) → `503` with `checks.storage = 'down'`,
  `db = 'ok'`.
- Error responses include `request_id`; a captured log stream for that request
  contains the same id and **no sensitive values** (assert on captured stdout —
  the logger writes to an injectable stream in tests).
- Existing suites unaffected: run the full integration suite (the logger/middleware
  change must not break route tests — this is the highest-risk regression).

**E2E**

- Existing specs unchanged (the access-log middleware must not alter response
  bodies the specs assert — if an assertion needs the new `request_id` field,
  update it in this PR and say so).
- Optional: `npm run smoke` run against the local production build
  (`next build && next start`) in CI or recorded manually — at minimum it is
  executed once and its output pasted in the PR.

**Load sanity (recorded, not gated)**

- Script + results (p50/p95/error rate at 25 concurrent for 60s on read paths)
  pasted into the PR description; any p95 above a self-respectable threshold
  (state the number chosen and why) becomes a follow-up item, not a blocker
  unless catastrophic.

### Dependencies

- PR 10 (rate limits, upload caps — hard), PR 19 (a11y gate must be green
  before launch — hard for the checklist), PR 21 (coverage + docs contract +
  check-script family — hard for extending `check:*` scripts).
- Features 06–09 and 12–17: soft — whatever has merged is hardened; the
  checklist states which features are in the launch scope if some PRs slip.
- Must merge **last**; if the roadmap slips, a reduced launch scope (core +
  this PR's operational baseline) is a legitimate alternative — say so rather
  than skipping this PR.

### Files / modules likely affected

```
app/api/health/route.ts, app/api/health/ready/route.ts     (new)
app/api/metrics/route.ts                                   (new only if kept)
lib/server/{log,http,request-id}.ts                        (new)
middleware.ts (or withLogging applied per route)           (access logging)
app/(pages)/error.tsx or app/error.tsx                     (request_id display, retry)
storage call sites: lib/resources/upload.ts, resource fetch/delete routes
AI provider call site: lib/ai/provider.ts                  (resilient fetch)
scripts/{smoke,check-env}.ts                               (new)
package.json                                               (smoke, check:env scripts)
.github/workflows/ci.yml                                   (check:env step)
docs/RELEASE.md (or docs/DEVELOPMENT.md launch section)    (new)
docs/API_CONTRACTS.md (request_id, health), docs/SECURITY.md (logging redaction,
  health disclosure), docs/DEVELOPMENT.md (env matrix, rollback, retention),
docs/local-supabase.md (only if prod-verification steps belong there)
tests/unit/lib/server/*.test.ts                            (new)
tests/integration/production-hardening.test.ts             (new)
```

### Acceptance criteria

- [ ] `/api/health` and `/api/health/ready` behave as specified, disclose no
      internals, and readiness honestly reports a down dependency as `503`.
- [ ] Every API error response carries `request_id`, and the matching log line
      exists with all sensitive fields redacted (integration-asserted).
- [ ] Zero `console.log` left in `app/api` (count reported; logger used
      instead).
- [ ] Outbound storage/ai calls have explicit timeouts and only bounded,
      idempotent retries; the provider failure guard is tested.
- [ ] `.env.example` ↔ code drift check fails CI when they diverge.
- [ ] Backup/restore drill executed, recorded with a date in the launch
      checklist; production bucket settings verified and recorded.
- [ ] Load sanity numbers measured and reported (no invented figures).
- [ ] `docs/RELEASE.md` (or equivalent) is a complete, executable launch
      checklist; `npm run smoke` exists and passes against a production build.
- [ ] No feature code in the diff; existing suites green with only the
      documented `request_id` assertion updates.

### Definition of Done

1. All suites + build green locally and in CI (three jobs), with the new
   `check:env` (and any other) step passing.
2. Redaction test covers every sensitive field listed in Security §2 and is
   table-driven (adding a field later is a one-line test edit).
3. Rollback rehearsed at least once on a scratch environment (revert deploy →
   app healthy) and recorded in the checklist with the steps.
4. Retention runbook written (`prune_notifications`, orphan sweep) with exact
   commands — executed once locally.
5. Standing questions updated: APM SaaS, legal/compliance, formal SLOs, flag
   system — each either resolved or explicitly punted with an owner.
6. Reviewed by Dev A, plus a second pass by the person who will be on call
   (the checklist's real acceptance test).

### Owner

**Dev B — Cursor** (operations/security-leaning; Dev A reviews the
behaviour-preserving claim on the cross-cutting fetch/logging edits).

### Estimated complexity

**Large.** Small pieces individually, but it touches every route's error
surface (via logging), two call-site families (storage/AI), and requires
operational work outside the codebase (backups, drills, load run) that no test
can verify for you.

### Risks

| Risk | Mitigation |
| --- | --- |
| Logging middleware breaks response-shape assertions across suites | Run full suites before merge; `request_id` documented as additive; assertion updates listed explicitly. |
| Redaction misses a field → secrets in logs | Table-driven test as the gate; grep for known sensitive values in captured logs during the PR. |
| Scope creep into APM/feature flags/canaries | Out-of-scope list explicit; these are named follow-ups, not silent omissions. |
| Load results are misleading (local machine, warm cache) | Report environment honestly (hardware, concurrency, cache state); treat as smoke-level signal. |
| Backup/restore drill skipped under time pressure | It is a checklist blocker with a date field — the on-call reviewer's sign-off depends on it. |
| Retries amplify a provider outage | Retry only idempotent calls, bounded + backoff + failure guard; tested. |
| Feature PRs still open when this merges | Launch scope list states exactly which features are in; reduced scope is a legitimate, documented outcome. |
