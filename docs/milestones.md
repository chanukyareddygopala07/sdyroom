# Milestones

Working log: what has landed, what each milestone still owes.

| Milestone | Commit | State |
| --- | --- | --- |
| B — Supabase Next.js starter, pinned dependencies, quality gates | `d6801ec` | done |
| Stabilize — `eslint-config-next` aligned with Next 16.3.8, Tailwind CSS 4 migration | `9e729a1` | done |
| C — local Supabase stack: `profiles`, `rooms`, `room_members`, RLS, `create_room` | `86a6806` | done |
| D — minimal working application | `b55bff1` | done |
| E — automated integration tests and CI | `24ba4c2` | done |
| F — public room joining and capacity enforcement | this change | done |

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

## Milestone F — task breakdown

- [x] Preflight — read-only first: clean tree, `main` equal to `origin/main` at
      `24ba4c2`, healthy local stack (not linked, no remote), one existing migration
      (`0001_init.sql`), and an inventory of the live grants/policies: `room_members`
      is `INSERT`+`SELECT` only with `room_members_select_own` and
      `room_members_insert_owner_self`, `rooms` is `INSERT`+`SELECT`, `anon` holds no
      table grants. That is what makes the direct-write tests meaningful — there is no
      grant to weaken.
- [x] `supabase/migrations/0002_room_membership.sql` — `join_room(uuid)`,
      `leave_room(uuid)` and `public_room_member_counts()`, all `security definer` with
      `set search_path = ''`, schema-qualified references, identity read from
      `auth.uid()` and checked for null, execution revoked from `public`/`anon` and
      granted only to `authenticated`. No table grant or policy is touched, so
      PostgREST writes keep failing exactly as before. The header documents why a
      SECURITY DEFINER function is the only option: an RLS `with check` cannot take a
      row lock (so two students could both pass a capacity count) and cannot insert a
      `student` row, and the owner role cannot be narrowed further without losing the
      ability to write the row the function exists to authorise.
- [x] Membership rules — open public rooms are joinable; a private room answers
      `room_not_found` unless the caller is already in it; an existing member (the
      owner included) gets an idempotent `already_member` with no second row; capacity
      counts every row including the owner and is checked under a `select … for update`
      lock shared with the insert; closed rooms refuse new members; a student may leave
      their own `student` row and rejoin later; the owner gets `owner_cannot_leave`;
      neither function accepts a user id.
- [x] `lib/rooms/membership.ts` — `joinRoom()` / `leaveRoom()` with `MembershipError`
      (`not_found` 404, `room_closed` / `room_full` / `owner_cannot_leave` /
      `not_a_member` 409) mapped from the documented result codes, so database text
      never reaches a response. Unexpected results and transport failures become plain
      errors and are logged server-side as `join_failed` / `leave_failed` (500).
- [x] API — `POST /api/rooms/[id]/join` and `POST /api/rooms/[id]/leave`. Identity
      comes from the session only: an empty or absent body is accepted, any field (a
      forged `user_id`, say) is a `400 invalid_request` rather than being ignored, the
      route param is validated with `z.uuid()` before it reaches the database, and a
      private room is indistinguishable from a missing one. Responses:
      `201 { membership: "joined", member_count }`, `200` for `already_member` /
      `left`, `400` `validation` / `invalid_json` / `invalid_request`, `401`
      `unauthenticated`, `404 not_found`, `409 room_closed` / `room_full` /
      `owner_cannot_leave` / `not_a_member`, `500 join_failed` / `leave_failed`.
- [x] Occupancy — `lib/rooms/queries.ts` gained `roomMemberCounts()` (aggregate
      `room_id`+`member_count` for public rooms only) and `listViewerMemberships()`
      (the caller's own rows only, because that is all RLS returns). `/rooms` merges
      them into `RoomSummary = PublicRoom & { member_count, viewer_membership }`;
      `GET /api/rooms` and `toPublicRoom()` are unchanged, so discovery still leaks
      nothing new.
- [x] UI — `RoomMembershipButton` posts and calls `router.refresh()`, so the rendered
      card always matches the database; it shows "Join room" / "Leave room" with a
      pending state, "Room is full." / "Room is closed." / "You own this room."
      instead of a dead control, redirects to login on `401`, surfaces the server's
      message on `409` and only claims a lost connection when `fetch` itself fails.
      `RoomCard` shows real seat usage (`n of m seats taken`, plus a `Full` badge) —
      no invented counts.
- [x] Tests — 51 new unit tests (membership mapping, the two routes, the button,
      `roomIdSchema`, and the two new queries) taking `npm test` from 85 to 136, plus
      `tests/integration/room-membership.test.ts` (25 tests) covering every rule above,
      the five-way race for three free seats (`3` joined, `2` `room_full`, final count
      exactly `4`), the four direct-write bypass attempts, and the occupancy response
      shape. The integration suite is 42 → 67 tests.
- [x] Gates — `npm run lint`, `npx tsc --noEmit`, `npm test` (136), `npm run build`,
      `npm run test:integration` (67, exit 0), plus a deliberate control violation
      (granting `DELETE` on `room_members` to `authenticated`) that makes the
      direct-write test fail, restored with `npx supabase db reset` and re-verified
      green. Database left with `profiles=0 rooms=0 members=0 users=0`.

## Not in this milestone

- **Integration coverage is API- and RLS-level.** Pages and the proxy redirect are
  covered by unit tests, not by a browser against a running server; see the coverage
  gaps section of `tests/integration/README.md`.
- **No member lists, invites or private-room joining.** Only the caller learns their
  own membership, and a private room stays invisible to the public join endpoint;
  sharing an invite to a private room is not built.
- **No room editing or deletion.** `rooms` has no `UPDATE`/`DELETE` grant, so a room
  can be created, discovered, joined and left — but not renamed, closed from the UI,
  or removed.
- **No alias editing.** Changing the study alias after onboarding is not built.
- **No chat, presence or timers.** Joining establishes the seat only.
