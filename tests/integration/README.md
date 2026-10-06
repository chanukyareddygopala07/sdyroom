# Integration tests (Supabase)

Unit tests (`npm test`) never touch Supabase. This suite is the only one that does: it
runs real auth, real RLS policies and the real route handlers against the local stack,
and it runs as a separate CI job.

```bash
npm run test:integration
```

Runs `vitest run --config vitest.integration.config.ts`, which only discovers
`tests/integration/**/*.test.ts` and is excluded from `npm test`.

**`passWithNoTests` stays unset**, so an empty or deleted suite exits non-zero. A
missing integration suite can never silently pass a gate.

## Prerequisites

1. Local stack running and migrations applied:

   ```bash
   npx supabase start
   npx supabase db reset
   ```

   Requires Docker. Never use the Homebrew PostgreSQL instance on port 5432; the
   container's Postgres is on 54322.
2. Environment (see below) either exported or present in `.env.local`.

Setup refuses to start with an actionable error if the URL or key is missing, if the
API never answers `/auth/v1/health`, or if `public.rooms` / `public.room_members` /
`public.profiles` have not been migrated. It polls for readiness — there are no fixed
sleeps.

## Environment variables

| Variable | Purpose | Example (local) |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Data API / auth endpoint, must be loopback | `http://127.0.0.1:54321` |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | The key the application itself uses | from `npx supabase status -o json` |

Both are read from `process.env`, then `.env.local` fills in anything unset — Vitest
does not load `.env.local` on its own.

**No secret or service-role key is used anywhere in this suite**, including setup and
teardown. If `SUPABASE_SECRET_KEY`, `SERVICE_ROLE_KEY` or `SUPABASE_SERVICE_ROLE_KEY`
is set in the environment, the run fails immediately rather than silently leaning on a
bypass role; a publishable key that starts with `sb_secret_` is rejected the same way.
Admin access — deleting the exact users a test created, checking row counts, and the
one revoked-grant transaction — comes from `docker exec … psql` on the local container
(`tests/integration/helpers/admin.ts`), which is refused unless the configured API host
is loopback.

Non-loopback URLs are rejected outright, so this suite can never point itself at a
remote or production project.

## Files

| File | What it proves |
| --- | --- |
| `auth-access.test.ts` | Session handling at the API boundary: `401` for missing and forged cookies, `200`/`201` for a real session |
| `profiles-and-api-privacy.test.ts` | Onboarding (`201`, idempotent `200`, case-insensitive `409 alias_taken`, `400` validation), room creation (`403` before onboarding, `400` invalid JSON/fields, `201`), discovery filtering and that responses carry no `owner_id` or email |
| `membership-and-rls.test.ts` | Grants and policies per role: `anon` and `authenticated` privilege denials, private-room and membership visibility, membership insert rules, profile update isolation |
| `atomic-room-creation.test.ts` | Owner membership committed with the room, `23514` rollback for a room without it, the revoked-grant transaction, `22023` validation inside the RPC, and that no owner argument exists to spoof |

### How fixtures are made

- Users are created only through **Supabase Auth** (`auth.signUp`), each with its own
  client bound to that user — never a service-role client.
- Rooms are created only through the **production `create_room` RPC**, either via
  `lib/rooms/create.ts` or `POST /api/rooms`. No test inserts a room row directly.
- Profiles are created through `lib/profiles/queries.ts`.
- Aliases, emails and room names carry a per-process id, so files cannot collide.

### How the API is exercised

Route handlers are invoked in-process with a real `NextRequest`
(`helpers/api.ts`), so the suite tests the production handler — auth guard, Zod
validation, RPC error mapping and `toPublicRoom()` shaping — rather than a
re-implementation. The only request-scoped dependency, `cookies()` from `next/headers`,
is mocked once in `setup-env.ts` and backed by a shared cookie jar
(`helpers/cookie-jar.ts`) that a real SSR client writes the session into. No dev server
is needed locally or in CI.

### Cleanup

Every test file deletes exactly the auth users it created, by id, in `afterAll`.
`on delete cascade` removes their profiles, rooms and memberships and nothing else.
Files run serially (`fileParallelism: false`) because they share one database: an
assertion about "no rows" must not observe another file's fixtures.

## CI

`.github/workflows/ci.yml` runs a separate `integration` job: `npm ci` (pinning the
CLI from devDependencies), `npx supabase start`, endpoint extraction with the
publishable key masked, a bounded readiness poll, `npx supabase db reset` for
migrations from scratch, `npm run test:integration`, and `npx supabase stop --no-backup`
under `if: always()`. The workflow has `permissions: contents: read` and uses no
repository secrets.

## Coverage gaps

- Pages and the proxy redirect (`lib/supabase/proxy.ts`) are covered by unit tests, not
  by a browser against a running server.
- `GET /api/rooms` search is asserted through the handler; Postgres `ilike` edge cases
  live in `tests/unit/lib/rooms`.
- There is no load, concurrency or migration-rollback testing.
- `service_role` behaviour is deliberately untested: nothing in the product uses it.
