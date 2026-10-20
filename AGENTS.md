# AGENTS.md

Operational contract for anyone (human or agent) changing this repository.
Specs live in `docs/PR_ROADMAP.md` and `docs/prs/*`; security and API claims
live in `docs/SECURITY.md` and `docs/API_CONTRACTS.md` — link them, never
restate them here.

## Commands (run all before opening a PR)

| Command | Gate |
| --- | --- |
| `npm run lint` | ESLint, zero errors, zero warnings |
| `npx tsc --noEmit` | TypeScript, no errors |
| `npm test` | Unit suite (vitest, `tests/unit/**`) |
| `npm run test:integration` | Integration suite against the local Supabase stack |
| `npm run test:e2e` | Playwright browser suite |
| `npm run build` | Next.js production build |
| `npm run check:env` | `process.env` reads match `.env.example` |
| `npm run test:coverage` | Unit suite with coverage floors enforced |
| `npm run check:counts` | Documented test counts match reality |
| `npm run check:links` | Relative markdown links resolve |

Local stack: `npx supabase start`, `npx supabase db reset`, `.env.local` per
`docs/DEVELOPMENT.md`. CI (`.github/workflows/ci.yml`) runs the same gates.

## Layering

- `app/api/**` routes are thin: parse → validate (zod, strict) → call
  `lib/**` → shape the response envelope. No business logic in routes and
  none in components.
- `lib/**` owns queries, RPC wrappers, rate limiting, logging, AI providers.
  Server code never reads `process.env` outside the documented patterns
  (`check:env` enforces the docs side).
- `supabase/` owns the data model: RLS first, grants revoke-first, SECURITY
  DEFINER only with an explicit reason in the migration.
- Error envelope everywhere: `{ "error": { "code", "message", … } }` with
  HTTP status mapped per route; `404 not_found` doubles as the
  "does-not-exist / may-not-see" answer so routes are not existence oracles.
- Logs go through `lib/server/log.ts` (`logError` / `errorFields`) in server
  code. `no-console` is an ESLint error in `app/**/page.tsx` and
  `app/api/**` — do not add `console.*` there.

## Validation

- zod schemas in `lib/validation/**`, `.strict()` so unknown keys are a
  `400` naming the key; trim before length checks; blank optional fields
  normalise to `null`.
- Rate limiting: `lib/rate-limit/keys.ts` defines the spec (key + max +
  window); the route takes the slot after validation and before the write,
  and documents the `429` row in its JSDoc table and
  `docs/API_CONTRACTS.md`.

## Test placement

- `tests/unit/**` — vitest, node environment, mock fetch/Supabase; DOM
  component tests included. This is where behaviour assertions live.
- `tests/integration/**` — the real local stack, real auth users. No DOM
  assertions here; probe HTTP and SQL only.
- `tests/e2e/**` — Playwright; user journeys and accessibility scans. Do not
  change selectors casually — many suites share them.
- Counts drift: adding/removing/renaming test files or specs requires
  updating `README.md` ("Current suite"), `tests/integration/README.md`,
  `tests/e2e/README.md`, and any `docs/SECURITY.md` `(N)` that changed —
  `npm run check:counts` fails otherwise. Pass the run's JSON with
  `--unit-json=` / `--integration-json=` to check totals.

## Migrations

- One migration per PR, numbered in sequence, **never edit a merged
  migration** — add the next one.
- Revoke-first: revoke then grant, so widening is always a deliberate diff.
- New tables: RLS enabled with explicit policies; column grants narrowed;
  `SECURITY DEFINER` only when justified in a comment and covered by tests.
- Apply locally with `npx supabase db reset` before running integration.

## Coverage floors

`npm run test:coverage` measures `lib/**` + `app/api/**` (server surface;
UI is asserted by behavioural tests but excluded from the floor). Floors:
**statements 75%, branches 65%** (baseline 2026-10-21 minus 1pp). Ratchet
them upward when coverage improves; lowering a floor requires a written
reason in the PR description. Integration runs are never folded into this
number.

## Lint baseline (no new suppressions)

Exactly four `eslint-disable` comments exist — adding a fifth is a finding,
not a fix:

- `lib/server/with-logging.ts` — `@typescript-eslint/no-explicit-any`
- `lib/supabase/proxy.ts` — `@typescript-eslint/no-explicit-any`
- `components/resources/resource-library.tsx` — `react-hooks/exhaustive-deps`
- `components/rooms/room-search.tsx` — `react-hooks/exhaustive-deps`

Also enforced: `dangerouslySetInnerHTML` is banned in JSX
(`no-restricted-syntax`); render through React children instead.

## Secrets and review

- Secrets live in environment variables only — never in code, docs, tests,
  or commit messages. `.env.example` documents keys; `check:env` keeps it
  honest.
- Every PR needs the suites green and the docs that describe the touched
  behaviour updated (`README.md`, `docs/SECURITY.md`, `docs/API_CONTRACTS.md`
  as applicable).
- Remaining work and owners: `docs/PR_ROADMAP.md`. Landed history:
  `docs/milestones.md`. Release runbook: `docs/RELEASE.md`.
