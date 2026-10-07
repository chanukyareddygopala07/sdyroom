# Milestones

Working log: what has landed, what each milestone still owes.

| Milestone | Commit | State |
| --- | --- | --- |
| B — Supabase Next.js starter, pinned dependencies, quality gates | `d6801ec` | done |
| Stabilize — `eslint-config-next` aligned with Next 16.3.8, Tailwind CSS 4 migration | `9e729a1` | done |
| C — local Supabase stack: `profiles`, `rooms`, `room_members`, RLS, `create_room` | `86a6806` | done |
| D — minimal working application | `b55bff1` | done |
| E — automated integration tests and CI | `24ba4c2` | done |
| F — public room joining and capacity enforcement | `f6c6411` | done |
| G — shared study workspace, synchronized focus timers and personal goals | `1937e16` | done |
| H — browser end-to-end suite and realtime reliability | `9a98a4a`–`ebcc16e` | done |
| Room chat — `0004_room_messages.sql`, messages API, realtime wiring, workspace mount | `e0e4eb2` | done |
| Room presence — `0006_realtime_private_channels.sql`, private-channel policies, roster UI and `studying` flag | `feat/room-presence` | in progress |
| I — private notes and PDF sharing: `0005_study_resources.sql`, private storage bucket, resource APIs, personal/room library | `feat/private-notes-library` | in progress |

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

## Milestone G — task breakdown

- [x] Preflight — clean tree at `f6c6411`, local stack healthy and still unlinked,
      migration list empty apart from `0001`/`0002`, `supabase_realtime` publication
      present but empty, and CI reviewed as the gate the push must survive.
- [x] `supabase/migrations/0003_focus_sessions_and_goals.sql` — `focus_sessions`
      (state machine `running|paused|completed|expired` with CHECKs pairing
      `paused ⇔ paused_at` and `terminal ⇔ ended_at`), the partial unique index
      `focus_sessions_one_active`, `study_goals` (personal, CHECK
      `(status='completed') = (completed_at is not null)`, partial unique active-title
      index on `(user_id, room_id, lower(title))`), the `study_goals_touch` trigger
      (owns `updated_at`/`completed_at`), explicit revokes of the stack's default ACL
      followed by SELECT-only / column-scoped grants, four RLS policies, and five
      `SECURITY DEFINER` RPCs (`focus_room_check`, `expire_focus_sessions_for`,
      `focus_session_state`, `start/pause/resume/end_focus_session`) with execution
      revoked from `public`/`anon` and granted only to `authenticated`.
      `focus_sessions` joins `supabase_realtime`; `started_by` was dropped entirely —
      with no column-level `SELECT` grants, any column would leak through raw
      PostgREST — and `session_expired` was folded into `no_active_session` because
      every path persists expiry before answering. Verified 99/99 with a throwaway
      harness (grants, prosecdef, races, forced expiry, privacy) after `db reset`.
- [x] Lib layer — `lib/focus/` (`readFocusState` / four action RPCs, `FocusSessionError`
      codes `not_found` 404 / `not_owner` 403 / `no_active_session`·`invalid_state` 409
      / `invalid` 400, strict `toFocusSession()` that re-checks the DB invariants and
      copies exactly nine columns) and `getFocusWorkspace()` (state → parallel room and
      history reads); `lib/goals/` (`listGoals`/`createGoal`/`updateGoal`/`deleteGoal`
      with `GoalError` and `duplicate_goal` from `23505`); `lib/rooms/access.ts`
      (`requireRoomMembership` → one 404 for non-member and missing room);
      `lib/validation/focus.ts` and `goals.ts` (`.strict()` bodies, duration 60–7200 s,
      title 1–120 chars trimmed, count 1–10000).
- [x] API — `GET /api/rooms/[id]/workspace`, `POST /api/rooms/[id]/session/{start,pause,
      resume,end}`, `GET`/`POST /api/rooms/[id]/goals`, `PATCH`/`DELETE
      /api/goals/[goalId]`. Identity only ever from the session (`claims.sub` for
      goals), `z.uuid()` route params before any query, empty-body rules enforced
      (`pause`/`resume`/`end` reject a body carrying fields with `400
      invalid_request`, goal `PATCH` rejects an empty one), and one error envelope
      with the documented code map (`201 started`, `200 already_active/paused/resumed/
      completed`, `400 validation|invalid_json|invalid|invalid_request`, `401
      unauthenticated`, `403 not_owner`, `404 not_found`, `409 no_active_session|
      invalid_state|duplicate_goal`, `500 start_/pause_/resume_/end_/workspace_/goals_/
      goal_create_/goal_update_/goal_delete_failed`).
- [x] UI — `/rooms/[id]` workspace page (`instant = false`, auth redirect, `notFound()`
      on 404, `loading.tsx`, `error.tsx`, root `not-found.tsx`); `FocusTimer` client
      component: realtime subscription on `focus_sessions` filtered by room, 20 s poll
      plus focus/visibility re-read as fallback, countdown derived from `server_now_ms`
      (offset kept in a ref, clock read only from effects/handlers), owner-only
      presets (25/45/60 min) with Start/Pause/Resume/End, recent-session history and
      Live/Reconnecting status; `GoalsPanel`: create (minutes → seconds), complete /
      reopen, delete, client-side range validation, server messages in a `role="alert"`.
- [x] Tests — 185 new unit tests taking `npm test` from 136 to **321** (focus session
      mapping/actions/workspace, goals queries, access, both validators, five route
      files, both components — the timer under fake timers so the countdown, the
      paused freeze and the server-clock offset are asserted deterministically),
      plus `tests/integration/focus-sessions.test.ts` (21) and
      `study-goals.test.ts` (16): non-member/missing-room 404 parity, role and seat
      counts, the 6-way concurrent start race (1 `started`, 5 `already_active`, one
      row), pause-credit timing, control refusal matrix, expiry with no browser,
      direct-write denial, history ordering, goal privacy against the owner, forged
      identity/room inserts, trigger-owned timestamps and duplicate titles. The
      integration suite is 67 → **104** tests; `assertSchemaApplied` now also requires
      the two new tables.
- [x] Gates — `npm run lint`, `npx tsc --noEmit`, `npm test` (321), `npm run build`
      (all new routes registered, `/rooms/[id]` as a partial prerender),
      `npm run test:integration` (104, exit 0), plus two deliberate control violations
      (adding `UPDATE` on `focus_sessions`, and widening `study_goals_select_own` to
      `using (true)`) that each make their suite fail, restored byte-for-byte with
      `npx supabase db reset`, re-verified green, and re-checked with the 99-check
      harness. Database left with `profiles=0 rooms=0 members=0 sessions=0 goals=0
      users=0`.

## Milestone H — task breakdown

- [x] Preflight — clean tree at `1937e16`, CI green from the push, local stack
      healthy, and a read-only pass over the spec before writing any code.
- [x] Playwright foundation — `@playwright/test@1.63.0` pinned in devDependencies
      (Chromium only), `playwright.config.ts` (one `E2E_RUN_ID` per invocation,
      `next dev` web server at `http://localhost:3000`, 90 s test / 60 s navigation
      timeouts, `retries: 1` and `workers: 2` in CI, HTML report in CI),
      `global-setup.ts` reusing the integration env guard (loopback-only, publishable
      key only, schema applied) and `global-teardown.ts` deleting `e2e+<runId>%` users
      through a CTE count (psql's `DELETE n` status line broke a plain `returning`
      parse; run ids are fixed length so prefixes cannot overlap).
- [x] App gaps the browser flows exposed — `RoomCard` gained an "Enter room" link for
      the owner/members and `RoomCreateForm` now enters the new workspace on `201`
      (there was no navigation to `/rooms/[id]` anywhere); the countdown is clamped to
      the session duration (the display clock advances once a second, so a fresh start
      could read `25:01`); and the realtime subscription now `await`s
      `supabase.realtime.setAuth()` before `channel().subscribe()` — the join payload
      is built at subscribe time, and without the JWT on the client the server
      registers the `room_id` filter as `anon`, which WALRUS rejects with
      `invalid column for filter room_id`, leaving every browser subscription silently
      dead (the channel still reports `SUBSCRIBED`; only the events never come).
      `next.config.ts` also sets `allowedDevOrigins: ["127.0.0.1"]` — Next 16's dev
      server withholds its scripts from unrecognised origins, which renders the page
      without hydration and makes every client-side test lie.
- [x] E2E specs (12 tests, four files) — `student-workflow.spec.ts` (the whole journey
      through real forms in two independent contexts: registration, onboarding, room
      creation, a running session with pause/resume propagating, personal goals
      staying private on the owner's fresh render, ending, leaving, 404);
      `private-room.spec.ts` (invisible in discovery, owner enters, non-members
      refused); `access-expiry.spec.ts` (signed-out redirects, indistinguishable 404s,
      full/closed rooms, owner-only controls, API abort + retry in the UI, a deadline
      that passed while nobody watched, session loss on the next request);
      `realtime.spec.ts` (a start reaching the member over WebSocket proven by a
      captured `postgres_changes` frame plus the poll-phase observation, a dropped
      socket reporting `Reconnecting…` and recovering, and stale/duplicate injected
      frames failing to corrupt the view). Helpers cover run-scoped users, room
      fixtures/selector anchors, the `routeWebSocket` capture/replay (Phoenix tuple
      wire format, `connectToServer` + re-delivery so observation never mutes the
      socket) and workspace-read counting.
- [x] Realtime integration tests — `tests/integration/realtime-focus.test.ts` (5):
      delivery to a subscribed member, silence for outsiders in public and private
      rooms, a late subscriber, and rejoin without duplicate rows; suite 104 → **109**.
- [x] Tests — unit 321 → **325** (`room-card.test.tsx` for the enter link, the
      focus-timer auth-before-subscribe ordering and the countdown clamp; the
      create-form test now asserts entry into the new workspace); e2e **12**.
- [x] CI — a third `e2e` job mirroring `integration` (own local Supabase, migrations
      from scratch, `npx playwright install --with-deps chromium`, report and traces
      uploaded on failure, `supabase stop --no-backup` in `always()`), workflow still
      `permissions: contents: read` with no secrets.
- [x] Docs — README testing section (three suites, counts, CI shape),
      `tests/e2e/README.md` (isolation scheme, poll-phase technique, capture/replay,
      auth-before-join and hydration notes), this file.
- [x] CI round 1 fixes — the first push failed two jobs, each root-caused against a
      cold stack: the server acks a join *before* registering its `postgres_changes`
      filter (seconds on a freshly started service) and a write inside that window is
      dropped with no replay — `focus-timer` and the integration `subscribe()` now
      pass `postgres_changes_options: { wait: true }`, so the reply is held until
      registration confirms (the reply echoes the server-side filter ids, failures
      surface as `CHANNEL_ERROR`), verified with repeated cold `realtime` restarts;
      and `private-room.spec.ts` asserted an *empty* discovery list, which under
      parallel workers sees other tests' public rooms — it now waits for the list to
      render and asserts only that this private room is absent.
- [x] Gates — `npm run lint`, `npx tsc --noEmit`, `npm test` (325), `npm run build`,
      `npm run test:integration` (109, twice from a cold realtime service),
      `npm run test:e2e` (12 under CI's exact knobs — `CI=true`, 2 workers, retries —
      from a cold realtime service, teardown removing every run user — `auth.users`
      back to 0).

## Milestone I — task breakdown

- [x] Preflight — clean tree at `origin/main` (`511bbeb`), local stack running and
      unlinked, migrations `0001`–`0004` already applied, baseline gates green
      (lint 0, `tsc` 0, 363 unit tests), and a read-only survey of what the storage
      API actually does before encoding it: `storage.foldername()` excludes the
      filename (so the two key layouts resolve to array lengths 2 and 3),
      `storage.protect_delete()` refuses a plain `delete from storage.objects`
      unless the session sets `storage.allow_delete_query = 'true'`, and
      `storage.remove()` reports **no** error when RLS filters every row out — so
      the tests assert object survival, never `remove()`'s return value.
- [x] Design locked — private `study-resources` bucket; key layout
      `personal/{owner}/{id}{ext}` / `rooms/{room}/{owner}/{id}{ext}`; download =
      JSON signed URL with `DOWNLOAD_TTL_SECONDS = 300`; DELETE = ownership
      pre-check → remove object → delete row; and explicitly *out*: rate limiting,
      malware scanning, a `PATCH` endpoint, and any runtime use of a service-role
      key.
- [x] `supabase/migrations/0005_study_resources.sql` — table with CHECKs for title,
      filename, content type and size, the regex key-layout CHECK and a separate
      `room_id ⇔ personal/` agreement CHECK, two scope indexes plus a unique
      `storage_path`, the `study_resources_touch` trigger (`updated_at`), a
      revoke-first grant matrix in which `owner_id` appears in **no** verb (not
      even `SELECT`) and `storage_path` is `SELECT`+`INSERT` only, four table
      policies, the bucket insert (`public = false`, 20 MiB, five allowed MIME
      types, idempotent), and three storage policies keyed off `storage.foldername()`
      segment counts with **no** `UPDATE` policy at all. Applied with
      `npx supabase db reset`; `0001`–`0004` never edited.
- [x] Contract first — `docs/API_CONTRACTS.md`: resource shape, limits, the
      sniffing table, all four endpoints with status/code tables, the server-side
      upload sequence, and a "not implemented, on purpose" table so the gaps are
      documented instead of assumed.
- [x] Lib layer — `lib/validation/resources.ts` (list query, metadata, id) and
      `lib/resources/{types,files,shape,queries,storage,upload}.ts`: an explicit
      response column list, magic-byte/UTF-8 validation, multipart parsing that
      **rejects unknown parts** rather than ignoring them, `has_more` from an
      exact count, server-built keys with `isOwnedBy()`, and absolute URLs taken
      only from `NEXT_PUBLIC_SUPABASE_URL`.
- [x] API — `GET`/`POST /api/resources`, `GET /api/resources/[id]/download`,
      `DELETE /api/resources/[id]`. Session first, then a `content-length` refusal
      over 20 MiB + 256 KiB before the body is buffered, membership confirmed
      before any room-scoped read or write, object written before the row with an
      orphan-object rollback, object removed before the row on delete, and one
      `404` for both "missing" and "not yours".
- [x] Security probe — 28 checks against the real stack with real users (probe
      users and the probe file removed afterwards): cross-user list/download/delete,
      a direct PostgREST insert with a forged `owner_id`, a direct object write
      into another student's folder, an unsigned fetch, a non-member listing, and
      bucket privacy. Every one refused with the documented status.
- [x] UI — `ResourceUploadForm` (XHR with a real progress bar, server messages in
      `role="alert"`), `ResourceLibrary` (draft vs applied filters, a separate
      `loadingMore` state for "Show more", inline delete confirmation, download
      that treats `401` as "sign in again"), `/resources` plus its `error.tsx`,
      `ResourceLibrary` mounted in the room workspace at `level={2}`, and a
      session-aware "My resources" nav link wrapped in `<Suspense>` — without that
      wrapper the `/` landing page fails to prerender.
- [x] Tests — 158 new unit tests taking `npm test` from 363 → **521** across 41
      files (validators, path/ownership, queries, all three routes including every
      error branch, the upload form and the library);
      `tests/integration/study-resources.test.ts` (22) taking the integration suite
      127 → **149**; `tests/e2e/resources.spec.ts` (5) taking e2e 12 → **19**, with
      `tests/e2e/fixtures/` and shared helpers. Shared seams were extended without
      disturbing existing assertions: `createFakeBuilder` gained
      `is`/`ilike`/`range`/`selectOptions` and an optional `count` on `FakeResult`
      (`state.select` stays a `string[]`), `tests/integration/helpers/api.ts` gained
      `FormData`, `assertSchemaApplied` requires `study_resources`, and the e2e
      global teardown deletes this run's `storage.objects` first — with
      `storage.allow_delete_query` set in the same `psql` invocation — because
      `storage.objects` has no FK to `auth.users` while `storage.prefixes` does not
      exist.
- [x] Docs — new `docs/SECURITY.md` (threat model, controls by layer, coverage, and
      the known limitations: rate limiting and malware scanning are explicitly *not*
      implemented); `docs/API_CONTRACTS.md` corrected against the shipped behaviour
      (`has_more` comes from an exact count, the download URL is absolute, the
      upload sequence includes the `content-length` guard); `docs/local-supabase.md`
      (schema, grant and RLS rows for `0004` and `0005`, a private-bucket section,
      refreshed verification counts — 7 tables, 20 policies, `owner_id` holding no
      privilege); `README.md` (routes table, resource and chat paragraphs, testing
      counts); this file.
- [x] Gates — `npm run lint` (0), `npx tsc --noEmit` (0), `npm test` (521 across
      41 files), `npm run test:integration` (149 across 10 files),
      `npm run build` (all four resource routes registered, `/resources` dynamic,
      `/rooms/[id]` still a partial prerender), `npm run test:e2e` (19/19, teardown
      removing 27 run users and this run's storage objects); then committed on
      `feat/private-notes-library` and opened as a PR.

## Not in this milestone

- **Browser coverage arrived in H, API/RLS coverage still leads.** Pages are driven by
  the Chromium suite and the realtime subscription now runs against live sockets, but
  the deepest adversarial coverage (races, grants, privacy) remains at the integration
  level.
- **No member lists, invites or private-room joining.** Only the caller learns their
  own membership, and a private room stays invisible to the public join endpoint;
  sharing an invite to a private room is not built.
- **No room editing or deletion.** `rooms` has no `UPDATE`/`DELETE` grant, so a room
  can be created, discovered, joined and left — but not renamed, closed from the UI,
  or removed.
- **No alias editing.** Changing the study alias after onboarding is not built.
- **No typing indicators, chat moderation or file previews.** Chat is
  append-only history (no edit, delete or react); room presence shows who is
  in the room and whether a shared session is running (alias + flag only, no
  ids); files are downloaded rather than previewed inline, with no versioning,
  no per-room quota UI and no search beyond the title/subject/chapter filters.
