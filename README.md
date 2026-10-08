<img alt="SdyRoom" src="https://demo-nextjs-with-supabase.vercel.app/opengraph-image.png">
<h1 align="center">SdyRoom</h1>

<p align="center">
 Capacity-limited study rooms for exam prep, built with Next.js and Supabase
</p>

<p align="center">
  <a href="#features"><strong>Features</strong></a> ·
  <a href="#demo"><strong>Demo</strong></a> ·
  <a href="#deploy-to-vercel"><strong>Deploy to Vercel</strong></a> ·
  <a href="#clone-and-run-locally"><strong>Clone and run locally</strong></a> ·
  <a href="#feedback-and-issues"><strong>Feedback and issues</strong></a>
  <a href="#more-supabase-examples"><strong>More Examples</strong></a>
</p>
<br/>

## Pinned dependency versions

All dependencies are pinned to exact versions (no `^`, `~` or `latest`) in `package.json`.

| Package | Version |
| --- | --- |
| next | **16.3.8** |
| react / react-dom | 19.3.0 |
| typescript | 5.9.3 |
| zod | 4.6.5 |
| @supabase/ssr | 0.12.7 |
| @supabase/supabase-js | 2.117.2 |
| supabase (CLI, devDependency) | 2.119.0 |
| tailwindcss | 4.3.3 |
| @tailwindcss/postcss | 4.3.3 |
| eslint-config-next | 16.3.8 |
| vitest | 5.0.3 |
| vite | 8.3.2 |
| jsdom | 30.1.2 |

**Next.js 16.3.8 is an intentional, security-driven deviation from the originally
specified 16.3.4.** 16.3.8 is the patched release on the 16.3.x line and is what the
approved Supabase starter resolves to; keep this pin and do not downgrade to 16.3.4.

`eslint-config-next` is pinned to **16.3.8 to match Next.js 16.3.8** (it must stay on
the same release as `next`). It ships a native flat config, which `eslint.config.mjs`
spreads directly — `FlatCompat`/`@eslint/eslintrc` is no longer used.

## Tailwind CSS 4

Styling runs on **Tailwind CSS 4.3.3** with `@tailwindcss/postcss` (PostCSS plugin).
The migration replaced the v3 trio (`tailwindcss` + `autoprefixer` + `tailwind.config.ts`):

- `postcss.config.mjs` uses `@tailwindcss/postcss` only; `autoprefixer` was removed
  (Tailwind 4 emits vendor prefixes itself).
- `app/globals.css` is CSS-first: `@import "tailwindcss"`, `@plugin "tailwindcss-animate"`,
  `@custom-variant dark` for the class-based dark mode, and `@theme inline` for the
  shadcn colour/radius tokens (the `--radius-*` and `hsl(var(--*))` values match the
  old JS config).
- `tailwind.config.ts` was deleted; source detection is automatic.
- Class renames for v4: `shadow` → `shadow-sm`, `shadow-sm` → `shadow-xs`,
  `outline-none` → `outline-hidden`, `bg-gradient-*` → `bg-linear-*`, and the removed
  `origin-[--var]` shorthand → `origin-[var(--var)]`.

## npm audit

`npm audit --omit=dev` (production dependencies): **0 vulnerabilities**.

`npm audit` (all dependencies): **5 high**, all in the dev toolchain and all one chain
rooted in a single advisory:

| Advisory | Package | Range |
| --- | --- | --- |
| [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) — stack-exhaustion DoS via deeply nested patterns (high) | `braces` | `<=3.0.3` |

Propagation: `braces` ← `micromatch` ← `fast-glob` ← `@next/eslint-plugin-next@16.3.8`
← `eslint-config-next@16.3.8`.

`braces@3.0.3` is the newest release on npm, so **no fixed version exists yet**; npm's
only suggested resolution is a downgrade of `eslint-config-next` to 14.2.35, which is
rejected. Nothing is suppressed and `--force` / `--legacy-peer-deps` are not used.
Re-check `npm audit` on every dependency update: the count fell from 7 to 5 with the
Tailwind CSS 4 migration (removing the `tailwindcss@3` → `chokidar` → `braces` path).

## Testing

- `npm test` (alias `npm run test:unit`) runs `vitest run` over `tests/unit/**` in the
  Node environment. It never contacts Supabase and passes without a local stack running.
  Individual UI test files opt into jsdom with a `@vitest-environment jsdom` docblock.
- `npm run test:integration` runs `vitest run --config vitest.integration.config.ts`
  over `tests/integration/**` — 265 tests covering auth at the API boundary, onboarding
  and response privacy, RLS/grant behaviour per role, `create_room` atomicity
  (including the revoked-grant rollback), joining and capacity races, the shared focus
  timer state machine, personal-goal privacy, append-only room chat, the whole
  study-resource authorization model (private library, room sharing, revocation on
  leaving, signed URLs, impersonation of another student's folder, bucket privacy),
  live Realtime delivery of `focus_sessions` changes over a real WebSocket, the
  addressed-invitation lifecycle (create/accept/reject/revoke/expiry, the last-seat
  accept race, roster denial for non-members, policy and grant freezes), room
  management, member moderation (report workflow with reporter privacy, mute
  lifecycle with the direct-insert control, moderator appointment, one-way block
  filtering, member removal, audit-row and grant probes, cross-room isolation), and
  resource hardening (the `rate_limits` freeze with a grant-revoke control, `413`/`415`,
  the bucket's own oversized-put refusal independent of the app,
  upload/delete/sweep `429`s, both orphan-sweep directions, the quota chain
  including a two-upload race resolved by the database trigger, and the
  signed-download serve review) —
  every suite shares a single control test that widens a grant and rolls it back.
  It needs
  the local stack (`npx supabase start && npx supabase db reset`) and never uses a
  service-role key. `passWithNoTests` stays unset, so a missing suite still exits
  non-zero. See `tests/integration/README.md`.
- `npm run test:e2e` runs `playwright test` over `tests/e2e/**` — 38 Chromium tests
  driving the real app (`next dev`) against the local stack: the full two-student
  workflow through the forms, private-room access, room chat, room presence across
  two browsers, the invitation lifecycle (invite by alias → inbox → accept, stranger
  negatives, reject/revoke/expiry, a full room), the upload → share →
  revoke → delete file lifecycle through the real upload form, room settings →
  close → name-typed delete across two browsers, expiry/failure/recovery
  scenarios, Realtime-vs-polling proven on an intercepted WebSocket (including
  stale and duplicate frame replay), member safety (message report → owner's
  moderation inbox → review → resolve with no reporter identity shown, one-way
  block filtering, owner mute → disabled composer → removal to a 404, and the
  documented refusal codes for anonymous, non-member and plain-member API
  attempts), and resource hardening (oversize/extension preflights failing in the
  browser, the quota line and quota-full locking, and a spent upload window
  answered with `429` + `Retry-After`). Test users are scoped to a per-run id and deleted
  by the global teardown (which also removes this run's storage objects before its
  `auth.users` rows). It needs the local stack plus `npx playwright install chromium`.
  See `tests/e2e/README.md`.
- `.github/workflows/ci.yml` runs all three suites on every push and pull request: a
  `quality` job (lint, types, unit tests, build — no env or secrets) and — each after
  `quality` — an `integration` job and an `e2e` job that stand up their own isolated
  local Supabase, apply migrations from scratch and run their suite (the e2e job also
  installs Chromium and uploads the Playwright report on failure). All jobs use the
  Node version pinned in `.nvmrc`, and the workflow is `permissions: contents: read`
  with no repository secrets.

## Local Supabase

The database foundation runs entirely locally through the pinned CLI
(`npx supabase start`), with Postgres on port **54322** — never the Homebrew server on
5432. See [docs/local-supabase.md](docs/local-supabase.md) for the schema, grants, RLS
policies, the private `study-resources` bucket and its storage policies, the
`create_room` RPC, how owner-membership atomicity is enforced, and the verification
commands.

## Application

SdyRoom is a minimal working application on top of this starter: sign up, pick a
unique study alias once, then discover public rooms and create your own.

| Route | Access | What it does |
| --- | --- | --- |
| `/` | public | Landing page with sign-up and browse calls to action |
| `/auth/*` | public | Password auth. Local Supabase has email auto-confirm on, so sign-up returns a session and routes to `/onboarding`; otherwise the success page is shown |
| `/onboarding` | signed in | One-time study alias via `POST /api/profile` |
| `/rooms` | signed in | Public room discovery with a `?q=` search over name, subject and exam track; rooms you belong to link straight into their workspace |
| `/rooms/new` | signed in, alias chosen | Create a room via `POST /api/rooms` and enter its workspace |
| `/invitations` | signed in | Your invitation inbox: accept or reject invitations addressed to your alias |
| `/rooms/[id]/settings` | room owner | Rename the room, edit its details, adjust capacity, open/close it, and the type-the-name delete danger zone; `notFound()` for anyone who is not the owner |
| `GET /api/rooms` | signed in | Shaped public rooms, `401` when unauthenticated |
| `POST /api/profile` | signed in | Creates the profile row, `409 alias_taken` on a case-insensitive collision |
| `POST /api/rooms` | signed in, alias chosen | `401` / `400 validation` / `403 onboarding_required` / `201` |
| `POST /api/rooms/[id]/join` | signed in | `201 joined` / `200 already_member`; `404 not_found` for a missing or private room, `409 room_closed` / `room_full`, `400` for a non-UUID id or any field in the body |
| `POST /api/rooms/[id]/leave` | signed in | `200 left`; `404 not_found`, `409 owner_cannot_leave` / `not_a_member`, `400` as above |
| `/rooms/[id]` | signed in, member | The study workspace: member roster with the per-member action menu (report / block / mute / remove / appoint), shared focus timer, recent sessions, the caller's own goals, room chat and the files shared into the room; owners of private rooms also get the invite panel, and owners/moderators get the moderation inbox |
| `GET /api/rooms/[id]/workspace` | signed in, member | `{ room, session, viewer_role, server_now_ms, member_count, history }`; `404 not_found` for a non-member *and* a missing room (indistinguishable) |
| `POST /api/rooms/[id]/session/start` | room owner | `201 started` / `200 already_active` (one active session per room, races included); `403 not_owner`, `404 not_found`, `400 validation` for a duration outside 60–7200 s |
| `POST /api/rooms/[id]/session/pause` / `resume` / `end` | room owner | `200 paused` / `resumed` / `completed`; `409 no_active_session` / `invalid_state`, `403 not_owner`, `400 invalid_request` for a body carrying fields |
| `GET /api/rooms/[id]/goals` | signed in, member | The caller's own goals in that room — never another member's; `404 not_found` for a non-member |
| `POST /api/rooms/[id]/goals` | signed in, member | `201 { goal }`; `409 duplicate_goal` while an active goal with the same title exists |
| `PATCH` / `DELETE /api/goals/[goalId]` | goal owner | `200 { goal }` / `200 { deleted: true }`; `404 not_found` for anyone else's goal, `400 invalid_request` for an empty `PATCH` |
| `GET` / `POST /api/rooms/[id]/messages` | signed in, member | Chat history (newest page first, `before=` cursor on the monotonic `seq`) / `201` append; `404 not_found` for a non-member; the sender id always comes from the session |
| `POST` / `GET /api/rooms/[id]/invitations` | room owner | Invite a student **by alias** (`{ invitee_alias, ttl_hours? }`, 1–168 h) → `201`; list the room's invitations → `200`. `403 not_owner`, `404 not_found` / `invitee_not_found`, `409 room_public` / `self_invite` / `already_member` / `already_invited` |
| `DELETE /api/rooms/[id]/invitations/[invitationId]` | room owner | `200 { revoked: true }`; an already-resolved invitation (or a second revoke) is `404 not_found`, indistinguishable |
| `GET /api/invitations` | signed in | The caller's invitation inbox (rows addressed to them), newest first |
| `POST /api/invitations/[id]/accept` | the invitee | Empty body; `201 joined` / `200 already_member` (the invitation is consumed either way); `404` for anything not addressed to you, `409 used` / `rejected` / `revoked` / `room_full` / `room_closed` / `blocked` (you blocked the inviter), `410 expired` |
| `POST /api/invitations/[id]/reject` | the invitee | Empty body → `200 { rejected: true }`; same `404` / `409` / `410` map as accept |
| `GET /api/rooms/[id]/members` | signed in, member | `{ members: [{ alias, role, joined_at }], count }` — the roster; `404 not_found` for a non-member, and no user ids or emails in the payload |
| `POST` / `GET /api/rooms/[id]/reports` | signed in, member / room moderator | File a report on a message, member or file (`201`, idempotent `200` on a duplicate open report; the reporter is pinned server-side and never returned) / the moderation inbox (`403 not_moderator`, no `reporter_id` column exists to leak) |
| `PATCH /api/reports/[reportId]` | report's room owner/moderator | `200 { report }` through `pending → reviewing → resolved\|dismissed`; `404` for anyone else (no existence oracle), `409 invalid_transition`, one audit row per change |
| `DELETE /api/rooms/[id]/members/[alias]` | owner or moderator | `200 { removed, member_count }`; `403 not_owner`… `cannot_remove_owner` / `cannot_remove_self` / `not_moderator`, `404` for a non-member caller — the target loses every room surface immediately |
| `POST` / `DELETE /api/rooms/[id]/members/[alias]/mute` | owner or moderator | `201 { muted, muted_until, duration }` for `1h` / `24h` / `7d` / `200 { unmuted: true }`; `403 not_moderator` / `cannot_mute_self` / `cannot_mute_owner` / `cannot_mute_moderator`, `409 already_muted` / `not_muted`; enforced again in the `room_messages` insert policy |
| `POST` / `DELETE /api/rooms/[id]/members/[alias]/moderator` | room owner | `200 { role, changed, granted }` — appoint or revoke a room moderator; `403 not_owner` / `cannot_moderate_owner`, `404 not_found` |
| `POST` / `GET /api/blocks` | signed in | Block a student by alias (`201` / idempotent `200 { created: false }`, `409 self_block`) / the caller's own blocks only (`{ blocks, count }`) — nobody else can see whom you blocked |
| `DELETE /api/blocks/[alias]` | signed in | `200 { removed }` (idempotent); unblocking restores the filtered chat and re-enables invitations |
| `PATCH /api/rooms/[id]` | room owner | Partial edit of name / shared goal / exam track / subject / language / capacity / status → `200 { room }` (the stored row); `403 not_owner`, `404 not_found` for a non-member *and* a missing room, `409 capacity_below_membership`, `400 invalid_request` for an empty body / `validation` for a bad value or an unknown key such as `owner_id`, `401` |
| `DELETE /api/rooms/[id]` | room owner | Sweeps `rooms/{id}/**` out of the bucket first, then cascades every dependent row → `200 { deleted: true }`; `403 not_owner`, `404 not_found` for a non-member, a missing room, or a repeat delete, `500 cleanup_failed` / `delete_failed` (room intact, retry converges) |
| `/resources` | signed in | The personal library: upload, search and filter your own files, open them through a short-lived signed URL, delete them |
| `GET /api/resources` | signed in | `?scope=personal` (default) or `?room_id=<uuid>`, plus `q` / `subject` / `chapter` / `limit` / `offset`; `400` for both `scope` and `room_id` or a bad value, `404` for a room you have left |
| `POST /api/resources` | signed in | multipart upload → `201`; `400` `validation` / `invalid_request` / `invalid_filename` / `empty_file` / `malformed_file`, `413 file_too_large`, `415 unsupported_file_type`, `404` for a room you are not in, `500` `storage_upload_failed` / `metadata_failed` |
| `GET /api/resources/[id]/download` | signed in, can read it | `200 { url, expires_in: 300, resource_id }` — authorization is re-checked on every call; `404 not_found` for a missing, deleted or foreign file |
| `DELETE /api/resources/[id]` | uploader | `200 { deleted: true }`; object removed before the row; `404 not_found` for anyone else's file, `500 cleanup_failed` / `delete_failed` |

Both membership endpoints take an empty body on purpose: the user is read from the
session, and a body that carries a `user_id` is rejected with `400 invalid_request`
instead of being quietly ignored. Success bodies are
`{ "membership": "...", "member_count": n }`, where `member_count` is the aggregate
seat usage for a public room and `null` for a private one.

Focus sessions and goals follow the same rule. The timer is a state machine owned by
PostgreSQL (`running → paused → running`, ending as `completed` when the owner stops
early or `expired` when the deadline passes — expiry is persisted by the next read or
start, so nobody's browser has to stay open). Every timestamp comes from the database,
the countdown is derived from `server_now_ms`, and `focus_sessions` is `SELECT`-only
for clients: starting, pausing, resuming and ending go through owner-only `SECURITY
DEFINER` RPCs, so a direct `INSERT`/`UPDATE` cannot start a session or rewind a
deadline. Goals are personal — RLS narrows `study_goals` to `user_id = auth.uid()`,
so even the room owner cannot read anyone else's titles, and `completed_at` is written
by a trigger rather than accepted from a client.

Files follow the same rule. A *resource* is a PDF, a scan of handwritten notes
or a plain-text/Markdown note, and it is **private by default**: `room_id IS
NULL` means only the uploader ever reads it, while a non-null `room_id` shares
it with that room's *current* members — leaving the room revokes access on the
next query without a single file being moved. Nothing is ever public: the
`study-resources` bucket is `public = false`, a download is a 300-second signed
URL issued only after the server re-checks ownership or membership, and no
endpoint accepts an owner id, a content type or a storage path from the client
(an `owner_id` in the upload body is a `400 invalid_request`, not a value that
quietly goes nowhere). The content type comes from sniffing the first bytes
server-side, so a file cannot claim to be a PDF it is not, and deletion is the
uploader's alone. `docs/ARCHITECTURE.md` is the map of how the layers fit
together, `docs/API_CONTRACTS.md` holds the endpoint contracts and
`docs/SECURITY.md` the threat model behind them.

How the pieces fit together:

- **Session**: `proxy.ts` → `lib/supabase/proxy.ts#updateSession` refreshes cookies
  and sends unauthenticated visitors (everything except `/`, `/auth/*` and `/api/*`)
  to `/auth/login`. API routes are exempt on purpose so a `fetch` client gets the
  documented JSON `401` instead of an HTML redirect. Each session-gated page re-checks the session and, for rooms, the
  profile row; they export `instant = false` because the project runs with
  `cacheComponents` and these routes must render per request.
- **Validation**: `lib/validation/` (Zod) mirrors the CHECK constraints in
  `supabase/migrations/0001_init.sql`, so bad input is rejected in the browser, at
  the API boundary and again in the database.
- **Database access**: `lib/profiles/queries.ts` and `lib/rooms/` — public rooms are
  read with an explicit column list and mapped through `toPublicRoom()`, so
  `owner_id` and any future private column can never reach a response. Rooms are
  only ever created through the `create_room` RPC, and membership only through
  `join_room` / `leave_room`: the owner (or the caller) is always taken from
  `auth.uid()` and never accepted from the client, and the seat check shares a row
  lock with the insert so racing students cannot exceed `capacity`. Occupancy is an
  aggregate over public rooms only (`public_room_member_counts`), so no participant
  identity or private-room count is ever disclosed.
- **Focus sessions**: `lib/focus/` reads through `focus_session_state` and writes
  through `start` / `pause` / `resume` / `end`, all owner-checked inside the
  database. A partial unique index allows at most one active session per room, so a
  concurrent race resolves to `already_active` instead of a second row, and
  `toFocusSession()` re-validates every payload (paused ⇔ `paused_at`, finished ⇔
  `ended_at`) before it reaches a client. The workspace page subscribes to realtime
  changes on `focus_sessions`, polls as a fallback and re-reads the same
  `getFocusWorkspace` the server rendered with, so a reconnect can never restart or
  rewind a timer.
- **Personal goals**: `lib/goals/` addresses only the caller's own rows; the partial
  unique index on `(user_id, room_id, lower(title)) where status = 'active'` yields
  `409 duplicate_goal`, the title frees up on completion, and a trigger owns
  `completed_at` / `updated_at`.
- **Room chat**: `lib/chat/` seeds history from the workspace page and appends
  through `POST /api/rooms/[id]/messages`; `room_messages` is append-only (only
  `SELECT`/`INSERT` are granted), the sender is pinned to `auth.uid()` by RLS and
  never returned as an id — the API maps it onto the viewer-relative `is_own` — and
  `seq` gives a stable total order for `before=` cursor pagination. Rows reach
  members over `supabase_realtime`, with RLS applied at delivery, and the client
  deduplicates by id because a send can be confirmed by both the POST response and
  its own event.
- **Study resources**: `lib/resources/` validates the file (magic bytes, 20 MiB
  ceiling, filename shape, unknown multipart parts rejected outright), builds the
  storage key from server-generated UUIDs only, and writes the object *before* the
  metadata row — a failed insert rolls the object back, so no orphan is advertised.
  The same scope is enforced twice, independently: table RLS for the metadata and
  storage RLS for the bytes, both derived from `auth.uid()` and current room
  membership, so a direct PostgREST or Storage call obeys exactly what the app
  obeys. `owner_id` holds no grant at all, and `storage_path` is excluded from the
  response column list.
- **Invitations and the roster**: `lib/invitations/` addresses each invitation to
  one student's alias — there is no token, link or invite URL, so nothing can be
  forwarded or enumerated, and every transition re-derives `auth.uid()` inside a
  `SECURITY DEFINER` RPC (`0007`). The table is read-only for clients (no write
  grant), expiry is evaluated at read time (`410`, never a stored state), at most
  one pending invitation per (room, invitee) is allowed by a partial unique index,
  and acceptance seats through the same row-locked capacity code as `join_room`
  with a private gate no client can execute. The roster reads through the
  membership-checked `room_roster` RPC — `room_members` visibility is unchanged —
  and annotates rows with live presence from the PR 06 channel.
- **Member safety**: `lib/moderation/` reports, blocks, mutes, removals and
  room-moderator appointment through alias-addressed SECURITY DEFINER RPCs
  (`0009`) with no `INSERT`/`UPDATE` grant on the audit tables — the reporter is
  pinned to `auth.uid()` inside the RPC and has no column grant, so no payload
  can carry it; blocks are private to the blocker and filter that user's chat
  through one clause on the `room_messages` SELECT policy (history and live
  arrival alike); mutes are re-checked by the insert policy, so a direct
  PostgREST write cannot bypass them. There is no global admin role: every
  right is scoped to one room.
- **Errors**: one envelope for every API failure, `{ error: { code, message, issues?
  } }`, built by `lib/api/responses.ts`.

### Layout note

The original brief assumed a `src/` tree (`src/lib/...`). This repository keeps the
starter's root-level `app/`, `lib/` and `components/`, so those modules live at
`lib/validation/`, `lib/rooms/`, `lib/profiles/` and `lib/api/` instead of
`src/lib/...`. Route and test paths are otherwise unchanged.

## Features

- Works across the entire [Next.js](https://nextjs.org) stack
  - App Router
  - Pages Router
  - Proxy
  - Client
  - Server
  - It just works!
- supabase-ssr. A package to configure Supabase Auth to use cookies
- Password-based authentication block installed via the [Supabase UI Library](https://supabase.com/ui/docs/nextjs/password-based-auth)
- Styling with [Tailwind CSS](https://tailwindcss.com)
- Components with [shadcn/ui](https://ui.shadcn.com/)
- Optional deployment with [Supabase Vercel Integration and Vercel deploy](#deploy-your-own)
  - Environment variables automatically assigned to Vercel project

## Demo

You can view a fully working demo at [demo-nextjs-with-supabase.vercel.app](https://demo-nextjs-with-supabase.vercel.app/).

## Deploy to Vercel

Vercel deployment will guide you through creating a Supabase account and project.

After installation of the Supabase integration, all relevant environment variables will be assigned to the project so the deployment is fully functioning.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fvercel%2Fnext.js%2Ftree%2Fcanary%2Fexamples%2Fwith-supabase&project-name=nextjs-with-supabase&repository-name=nextjs-with-supabase&demo-title=nextjs-with-supabase&demo-description=This+starter+configures+Supabase+Auth+to+use+cookies%2C+making+the+user%27s+session+available+throughout+the+entire+Next.js+app+-+Client+Components%2C+Server+Components%2C+Route+Handlers%2C+Server+Actions+and+Middleware.&demo-url=https%3A%2F%2Fdemo-nextjs-with-supabase.vercel.app%2F&external-id=https%3A%2F%2Fgithub.com%2Fvercel%2Fnext.js%2Ftree%2Fcanary%2Fexamples%2Fwith-supabase&demo-image=https%3A%2F%2Fdemo-nextjs-with-supabase.vercel.app%2Fopengraph-image.png)

The above will also clone the Starter kit to your GitHub, you can clone that locally and develop locally.

If you wish to just develop locally and not deploy to Vercel, [follow the steps below](#clone-and-run-locally).

## Clone and run locally

1. You'll first need a Supabase project which can be made [via the Supabase dashboard](https://database.new)

2. Create a Next.js app using the Supabase Starter template npx command

   ```bash
   npx create-next-app --example with-supabase with-supabase-app
   ```

   ```bash
   yarn create next-app --example with-supabase with-supabase-app
   ```

   ```bash
   pnpm create next-app --example with-supabase with-supabase-app
   ```

3. Use `cd` to change into the app's directory

   ```bash
   cd with-supabase-app
   ```

4. Rename `.env.example` to `.env.local` and update the following:

  ```env
  NEXT_PUBLIC_SUPABASE_URL=[INSERT SUPABASE PROJECT URL]
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=[INSERT SUPABASE PROJECT API PUBLISHABLE OR ANON KEY]
  ```
  > [!NOTE]
  > This example uses `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, which refers to Supabase's new **publishable** key format.
  > Both legacy **anon** keys and new **publishable** keys can be used with this variable name during the transition period. Supabase's dashboard may show `NEXT_PUBLIC_SUPABASE_ANON_KEY`; its value can be used in this example.
  > See the [full announcement](https://github.com/orgs/supabase/discussions/29260) for more information.

  Both `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` can be found in [your Supabase project's API settings](https://supabase.com/dashboard/project/_?showConnect=true)

5. You can now run the Next.js local development server:

   ```bash
   npm run dev
   ```

   The starter kit should now be running on [localhost:3000](http://localhost:3000/).

6. This template comes with the default shadcn/ui style initialized. If you instead want other ui.shadcn styles, delete `components.json` and [re-install shadcn/ui](https://ui.shadcn.com/docs/installation/next)

> Check out [the docs for Local Development](https://supabase.com/docs/guides/getting-started/local-development) to also run Supabase locally.

## Feedback and issues

Please file feedback and issues over on the [Supabase GitHub org](https://github.com/supabase/supabase/issues/new/choose).

## More Supabase examples

- [Next.js Subscription Payments Starter](https://github.com/vercel/nextjs-subscription-payments)
- [Cookie-based Auth and the Next.js 13 App Router (free course)](https://youtube.com/playlist?list=PL5S4mPUpp4OtMhpnp93EFSo42iQ40XjbF)
- [Supabase Auth and the Next.js App Router](https://github.com/supabase/supabase/tree/master/examples/auth/nextjs)
- # SdyRoom

### Study together. Stay accountable. Achieve more.

Privacy-first virtual study rooms for students preparing for
competitive and university examinations.

[![CI](https://github.com/chanukyareddygopala07/sdyroom/actions/workflows/ci.yml/badge.svg)](https://github.com/chanukyareddygopala07/sdyroom/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/chanukyareddygopala07/sdyroom/graph/badge.svg)](https://codecov.io/gh/chanukyareddygopala07/sdyroom)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js)
![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?logo=typescript)
![Supabase](https://img.shields.io/badge/Supabase-PostgreSQL-3FCF8E?logo=supabase)
![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-v4-06B6D4?logo=tailwindcss)


