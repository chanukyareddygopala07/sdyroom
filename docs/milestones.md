# Milestones

Working log: what has landed, what each milestone still owes.

| Milestone | Commit | State |
| --- | --- | --- |
| B — Supabase Next.js starter, pinned dependencies, quality gates | `d6801ec` | done |
| Stabilize — `eslint-config-next` aligned with Next 16.3.8, Tailwind CSS 4 migration | `9e729a1` | done |
| C — local Supabase stack: `profiles`, `rooms`, `room_members`, RLS, `create_room` | `86a6806` | done |
| D — minimal working application | this change | done |

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

## Not in this milestone

- **Integration tests stay empty on purpose.** `npm run test:integration` still exits
  `1` because `passWithNoTests` is not set in `vitest.integration.config.ts`; real-auth
  and RLS integration tests remain owed and are tracked in
  `tests/integration/README.md`.
- **Discovery only.** Joining a room, member lists, invites and any `UPDATE`/`DELETE`
  on rooms are not built — the database exposes no update or delete grants for
  `rooms`/`room_members` yet.
- **No alias editing.** Changing the study alias after onboarding is not built.
- **Capacity is a stored range only.** The database constrains it to 1–100; nothing
  enforces the seat count until a join/booking flow exists.
