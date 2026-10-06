# Milestones

Working log: what has landed, what each milestone still owes.

| Milestone | Commit | State |
| --- | --- | --- |
| B — Supabase Next.js starter, pinned dependencies, quality gates | `d6801ec` | done |
| Stabilize — `eslint-config-next` aligned with Next 16.3.8, Tailwind CSS 4 migration | `9e729a1` | done |
| C — local Supabase stack: `profiles`, `rooms`, `room_members`, RLS, `create_room` | `86a6806` | done |
| D — minimal working application | `b55bff1` | done |
| E — automated integration tests and CI | this change | done |

## Milestone D — task breakdown

- [x] Preflight: clean tree, local `HEAD` matching `origin/main`, local stack running.
- [x] `lib/validation/` — `aliasSchema` / `onboardingSchema` and `createRoomSchema` /
      `roomSearchSchema` mirroring the CHECK constraints in `0001_init.sql`: trim
      before length checks, blank optional fields normalised to `null`, defaults for
      capacity / visibility / status, and deliberately no owner id field.
- [x] `lib/rooms/` — explicit `PUBLIC_ROOM_COLUMNS` and `toPublicRoom()` shaping,
      `listPublicRooms()` (public-only filter, newest first, limit 50, `ilike` search
      with wildcards and filter characters stripped), `createRoom()` through the RPC
      with `RoomError` codes for `22023` → 400, `42501` → 403, `23514` → 500,
      network → 503.
- [x] `lib/profiles/queries.ts` — `getProfile()` / `createProfile()` with
      `alias_taken` (23505 on `profiles_alias_lower_key`), `already_exists`
      (`profiles_pkey`), `forbidden` (RLS) and `query_failed`.
- [x] API — `GET`/`POST /api/rooms` and `POST /api/profile` behind one error envelope
      (`lib/api/responses.ts`), with guard tests covering 401 / 400 / 403 / 409 / 500.
- [x] Pages — landing, `/onboarding`, `/rooms` (streamed results, `error.tsx` and
      search), `/rooms/new`, and a shared `SiteShell` for nav and footer.
- [x] Components — `OnboardingForm`, `RoomSearchForm`, `RoomCreateForm`, `RoomCard`,
      plus `ui/select` and `ui/textarea` primitives; starter cruft removed
      (`app/protected`, `components/tutorial`, hero logos, deploy button).
- [x] Auth adaptation — login and password-update route to `/rooms`; sign-up routes to
      `/onboarding` when Supabase returns a session and to the success page otherwise;
      the confirmation link lands on `/rooms`; `AuthButton` shows the study alias
      instead of the email address.
- [x] Docs — README "Application" section (routes, boundaries, `src/` layout note)
      and this file.
- [x] Gates — `npm run lint`, `npx tsc --noEmit`, `npm test`, `npm run build`, and a
      secret scan over the diff.

## Milestone E — task breakdown

- [x] Preflight — verified the real PostgREST/SQL error shapes before encoding them:
  `anon` → HTTP `401` with body `42501`, `authenticated` `UPDATE`/`DELETE` → `403` +
  `42501`, direct room insert without membership → `400` + `23514` with zero rows
  committed, spoofed `owner_id` → `403` + `42501`, unknown `p_owner_id` argument →
  `404` + `PGRST202`, and the revoked-grant transaction (error `42501`, grant restored
  by rollback, zero rooms).
- [x] `tests/integration/setup-env.ts` — resolves `process.env` then `.env.local`,
  rejects non-loopback URLs, secret/service-role keys and `sb_secret_*` publishable
  keys, polls `/auth/v1/health` with a bounded deadline, and confirms the three tables
  exist. Missing configuration throws with the command to fix it; nothing is skipped.
- [x] Helpers — `env.ts` (validation, readiness), `admin.ts` (`docker exec psql` scoped
  to the container named after `project_id`, exact-id user cleanup, row counts),
  `users.ts` (Supabase Auth sign-up only), `cookie-jar.ts` (shared session seam),
  `api.ts` (real `NextRequest` → production route handler).
- [x] `auth-access.test.ts` — `401` for missing and forged cookies, `200`/`201` for a
  real session, and that a second sign-in does not keep the first user's identity.
- [x] `profiles-and-api-privacy.test.ts` — onboarding `201`/`200`/`409 alias_taken`/
  `400`, `403 onboarding_required`, malformed JSON and field validation, `201` room
  creation, public-only discovery, and no `owner_id`/email/`sb_secret_` in any response.
- [x] `membership-and-rls.test.ts` — `anon` read/update/delete/rpc → `42501` with
  `data: null` (denied, not an empty list), authenticated `UPDATE`/`DELETE` → `42501`,
  spoofed owner and foreign profile insert → `42501`, private room and membership
  visibility, profile update isolation (`1` own row, `0` foreign rows).
- [x] `atomic-room-creation.test.ts` — room + owner membership committed together,
  `23514` rollback for a membership-less room, the single-transaction revoked-grant
  test with the grant restored afterwards, `22023` validation inside the RPC, and
  `PGRST202` proving no owner argument exists to spoof.
- [x] `vitest.integration.config.ts` — points at the new setup file and runs files
  serially (`fileParallelism: false`) so row-count assertions cannot observe another
  file's fixtures; `passWithNoTests` still unset.
- [x] `.github/workflows/ci.yml` — `permissions: contents: read`, `quality` job
  (lint / types / unit / build, no env), `integration` job on the pinned CLI with
  endpoint extraction (publishable key masked), readiness polling, `db reset` from
  scratch, `npm run test:integration`, and `supabase stop --no-backup` under
  `if: always()`. `.nvmrc` pins Node 24 for local and CI.
- [x] Gates — `npm run lint`, `npx tsc --noEmit`, `npm test`, `npm run build`,
  `npm run test:integration` (42 tests), plus a deliberate control violation
  (dropping `rooms_select_public`) proving the suite fails when an authorization
  control is removed, restored with `npx supabase db reset`.

## Not in this milestone

- **Integration coverage is API- and RLS-level.** Pages and the proxy redirect are
  covered by unit tests, not by a browser against a running server; see the coverage
  gaps section of `tests/integration/README.md`.
- **Discovery only.** Joining a room, member lists, invites and any `UPDATE`/`DELETE`
  on rooms are not built — the database exposes no update or delete grants for
  `rooms`/`room_members` yet.
- **No alias editing.** Changing the study alias after onboarding is not built.
- **Capacity is a stored range only.** The database constrains it to 1–100; nothing
  enforces the seat count until a join/booking flow exists.
