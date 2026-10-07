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
| `room-membership.test.ts` | `join_room` / `leave_room` end to end: `401` guards, non-UUID and body-field rejection, `201`/`200` outcomes, private room indistinguishable from a missing one, `409` closed / full / owner-cannot-leave / not-a-member, leave-and-rejoin, a five-way race for three free seats, the four direct-write bypass attempts, and the public-only occupancy payload |
| `focus-sessions.test.ts` | The shared timer end to end: `401`/`404`/`403` guards, `400` duration validation, `201 started` / `200 already_active`, a six-way concurrent start race resolving to one row, direct `INSERT`/`UPDATE` denial with member `SELECT` visibility, pause-credit timing on resume, the control refusal matrix (`no_active_session`, `invalid_state`, field-carrying bodies), early completion into history, history ordering, and expiry persisted by the first reader with no browser open |
| `study-goals.test.ts` | Personal goals end to end: `401`/`404` guards, strict body validation, privacy against the room owner, `409 duplicate_goal` with title reuse after completion, trigger-owned `completed_at`, cross-member `404`s, and the direct-write attempts (forged `user_id`, unjoined room, `user_id`/`room_id` updates, anonymous) |
| `room-messages.test.ts` | Append-only chat end to end: member-only history with a `before=` cursor, `201` send stamped with the caller's own identity, a forged `user_id` refused by RLS, non-member `404`, and no `UPDATE`/`DELETE` path at all |
| `realtime-focus.test.ts` | Live WebSocket delivery of `focus_sessions` inserts to a subscribed member, silence for outsiders in public and private rooms, a late subscriber, and a rejoin without duplicate rows |
| `study-resources.test.ts` | The whole file authorization model: column and row privacy, anonymous listing, signed URL (300 s TTL, unreachable unsigned), cross-user open/delete refusal, member read, non-member `404`, revocation the moment the reader leaves, forged `owner_id`, impersonation of another student's folder (row *and* object) and of a signed path, magic-byte mismatch, bucket privacy, `owner_id` holding no privilege, and the key-layout CHECK |

### How fixtures are made

- Users are created only through **Supabase Auth** (`auth.signUp`), each with its own
  client bound to that user — never a service-role client.
- Rooms are created only through the **production `create_room` RPC**, either via
  `lib/rooms/create.ts` or `POST /api/rooms`. No test inserts a room row directly.
- Focus sessions are created only through `start_focus_session`, invoked via the
  production route handler. The single exception is simulating the passage of time:
  an admin `psql` statement backdates `started_at`/`ends_at` on an existing row to
  prove expiry is persisted by the next reader (no test ever starts a session by
  inserting a row).
- Goals are created only through `POST /api/rooms/[id]/goals`; direct inserts appear
  solely as denial attempts that must fail.
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
`on delete cascade` removes their profiles, rooms, memberships, focus sessions, goals,
messages and study resources and nothing else (each file re-asserts its own residue is
gone).
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
- Realtime delivery is unit-tested with a mocked channel (`tests/unit/components/
  focus-timer.test.tsx`) and covered end to end by `realtime-focus.test.ts` over a real
  WebSocket; the 20-second poll is the covered fallback path.
- Uploaded bytes are stored in the local `study-resources` bucket; objects are asserted
  through the storage API, and there is no malware scanning anywhere to test (see
  `docs/SECURITY.md`).
- There is no load or migration-rollback testing. Seat-capacity contention is covered
  by the five-way race in `room-membership.test.ts`, and the one-active-session rule by
  the six-way race in `focus-sessions.test.ts`, both asserting the final row count.
- `service_role` behaviour is deliberately untested: nothing in the product uses it.
