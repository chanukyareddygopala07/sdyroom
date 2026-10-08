# Architecture

How SdyRoom is put together: the layers, the data flow, and which document
governs which concern. `docs/SECURITY.md` carries the threat model,
`docs/API_CONTRACTS.md` the endpoint contracts, `docs/local-supabase.md` the
schema and grants; this file is the map that connects them.

## Shape of the system

```
Browser
  │  cookie session (supabase-ssr)
  ▼
Next.js App Router (app/)                     — server components render reads;
  │                                              route handlers (app/api/*) write
  │  lib/ modules only — never raw fetch/SQL in components
  ▼
Supabase (local stack, no service role anywhere)
  ├─ Postgres: RLS + column grants + SECURITY DEFINER RPCs   (authority)
  ├─ Auth:    session claims, `auth.uid()`                    (identity)
  ├─ Realtime: focus/chat postgres_changes, presence channels (delivery)
  └─ Storage: private bucket + per-object policies            (bytes)
```

Two rules define the codebase:

1. **The database is the authority; the app is a thin, re-checking layer.**
   Every invariant that matters (capacity, membership, ownership, state
   machines) is enforced in Postgres — grants, RLS, CHECKs, partial unique
   indexes and `SECURITY DEFINER` RPCs — and the API re-checks the same rule
   before it answers. A bug in one layer leaves the other standing
   (`docs/SECURITY.md` §Principles).
2. **Identity is never a parameter.** Handlers read the Supabase session
   claims; RPCs read `auth.uid()`; nothing accepts "on behalf of" input.

## Directory map

| Path | Responsibility |
| --- | --- |
| `app/(app)/*` | Signed-in pages (rooms, workspace, resources, invitations). Pages `export const instant = false` (the app runs with `cacheComponents`) and are session-gated by `lib/supabase/proxy.ts`. |
| `app/api/*` | Route handlers. Validate with Zod, map domain errors onto the single error envelope, never touch SQL directly. |
| `components/*` | Presentational + client-interactive components. They fetch through `lib/` query modules or the documented `/api/*` endpoints; they never construct storage URLs or identity fields themselves. |
| `lib/validation/*` | Zod schemas mirroring the database CHECK constraints — trim before length, blank → `null`, no identity fields. |
| `lib/<feature>/` | One module per feature: `queries.ts` (reads/writes through the user-scoped client), `types.ts` (response shaping with explicit column lists), errors with stable codes. |
| `lib/rooms/access.ts` | The shared membership/ownership gates (`requireRoomMembership`, `requireRoomOwner`) that give non-members the same `404` as a missing room. |
| `lib/api/responses.ts` | The one error envelope: `{ error: { code, message, issues? } }`. |
| `lib/supabase/` | `proxy.ts` (session refresh + page redirects), `server.ts` (cookie-scoped server client), `client.ts` (browser client). No service-role key exists in the repo. |
| `supabase/migrations/` | The schema, applied only to the local stack (`npx supabase db reset`). `0001`–`0010` are append-only; existing files are never edited. |
| `tests/unit` | Vitest, no network: validators, queries against fake builders, every route's status matrix, component behaviour. |
| `tests/integration` | Vitest against the real local stack with real auth users: RLS/grant probes, RPC races, HTTP-level handler tests. Never uses a service-role key (SQL fixtures go through `docker exec psql`). |
| `tests/e2e` | Playwright + Chromium driving the real `next dev` app: two-browser flows, WebSocket frame capture/replay, teardown scoped to a per-run user id. |
| `docs/` | `ARCHITECTURE.md` (this file), `API_CONTRACTS.md`, `SECURITY.md`, `local-supabase.md`, `milestones.md`, `PR_ROADMAP.md`, `prs/*` (per-PR specifications). |

## Data model

Fourteen tables, all with RLS enabled, all granted explicitly column by column
(`auto_expose_new_tables = false`):

| Table | Owns |
| --- | --- |
| `profiles` | The one-time study alias (the app's only identity surface — no email in any response). |
| `rooms` | `public`/`private` visibility, `open`/`closed` status, capacity 1–100. |
| `room_members` | Membership rows `(room_id, user_id, role)`; `role ∈ owner, student`. Read-your-own only — the roster reads through the `room_roster` RPC instead of a wider policy. |
| `focus_sessions` | One active session per room (partial unique index), owner-controlled state machine, read-only grant for clients. |
| `study_goals` | Personal goals, trigger-owned timestamps, partial unique active-title index. |
| `room_messages` | Append-only chat (`SELECT`/`INSERT` only) with a monotonic `seq` cursor; `0009` narrowed both policies — the SELECT policy skips messages from people the viewer blocked, the INSERT policy refuses an actively muted member. |
| `study_resources` | File metadata for the private `study-resources` storage bucket; `owner_id` holds no grant at all. |
| `room_invitations` | Addressed invitations (inviter → invitee by alias), read-only grant for clients; create/accept/reject/revoke are RPCs. Expiry is read-time derived, never a stored state. `0009` re-created acceptance with a block check. |
| `moderation_reports` | Room-scoped reports with a closed reason enum and the `pending → reviewing → resolved\|dismissed` machine. `reporter_id` has no `SELECT` grant; writes are RPC-only. |
| `moderation_actions` | One immutable audit row per privileged moderation mutation (`actor_id = auth.uid()`); no client grants of any kind. |
| `room_mutes` | The active mute per (room, member) with `muted_until`; `SELECT`-only for members, RPC-only writes, and the source of the `room_messages` insert-policy check. |
| `room_moderators` | Aliases appointed by the room owner — the *only* moderator concept; there is no global role. |
| `user_blocks` | The blocker's own rows (`blocker_id = auth.uid()` own-rows policy); RPC-only writes; read by the chat filter and the invitation accept. |
| `rate_limits` | Fixed-window counters for the abuse controls (`0010`). The table carries no grant at all and RLS carries zero policies; the only door in is the `rate_limit_take` RPC (SECURITY DEFINER, executable by `authenticated` only). |

Membership flows (join, leave, invitation acceptance) all funnel through
`SECURITY DEFINER` RPCs because an RLS `WITH CHECK` cannot take the row lock
that makes the capacity check safe. `0007` factored the seat logic into
`join_room_core` so `join_room` and invitation acceptance share one
implementation; the core is executable by no application role. Moderation
follows the same pattern (`0009`): reports, verdicts, mutes, removals,
appointments and blocks are all definer RPCs so identity, subject-in-room and
the audit row are proved in one transaction.

## Read/write flows

**A read (workspace page):**

```
request → proxy (refresh session, redirect if signed out)
        → server component (app/(app)/rooms/[id]/page.tsx)
        → lib/ queries on the cookie-scoped client  ← RLS applies here
        → rendered HTML with server-provided seeds (session, messages, roster)
        → client components hydrate and subscribe for deltas
```

**A write (any `/api/*`):**

```
route handler → session claims → Zod (400) → lib/ query →
  RPC or RLS-filtered write → shaped response / mapped error code
```

There is no third path: pages never write, components never call Postgres
directly, and every failure travels through the single envelope.

**A delete (room removal, the one cross-service write):**

```
DELETE /api/rooms/[id]
  → session claims → requireRoomOwner (404 / 403 before anything is touched)
  → sweep rooms/{id}/** out of the storage bucket   ← storage RLS authorizes against the rows, so this runs first
  → delete_room RPC: lock room row, re-prove auth.uid(), one cascading delete
  → { deleted: true }
```

The two halves cannot share a transaction (Storage is not Postgres), so the
order is chosen so that every *other* failure mode converges on retry: a failed
sweep leaves the room fully intact; a failed row delete has already removed
objects that no row will ever advertise again. `app/(app)/rooms/[id]/settings`
is the only page that exists purely for owner writes, and it re-proves
ownership server-side (`getOwnedRoom`) rather than trusting the workspace's
hidden link.

## Realtime

Three kinds of channels, all gated to current room members:

| Channel | Carries | Gate |
| --- | --- | --- |
| `focus-{roomId}` | `postgres_changes` on `focus_sessions` (`wait: true` so `SUBSCRIBED` implies the filter is registered) | RLS applied at delivery |
| `room-messages-{roomId}` | `postgres_changes` on `room_messages` | RLS applied at delivery |
| `room-presence-{roomId}` | Presence `{ alias, studying }` | `realtime.messages` policies from `0006`: topic uuid must match a current `room_members` row |

Nothing realtime persists: presence lives in Realtime's memory, chat and
session frames are hints that trigger a re-read of the authoritative view.
`components/room-chat.tsx` publishes the observed presence list into
`lib/chat/presence-store.ts`, which the member roster annotates from — one
observation, two readers, no second socket.

## Frontend composition

The room workspace (`/rooms/[id]`) is one server component that seeds the
client panels: `RoomRoster`, the owner's `RoomInvitePanel` (private rooms
only), `FocusTimer`, `GoalsPanel`, `RoomChat`, `ResourceLibrary`, and — when
the viewer is the owner or an appointed moderator — `ModerationInbox`. The
same read also fetches the caller's moderation view (`room_moderation_info`:
can-I-moderate, moderator aliases, mute state) and their own block list,
which the roster menus and the chat composer consume. Each panel is
keyed per room so a room switch can never show the previous room's state
while the new request is in flight. Presence annotations are deliberately
server-free (the roster is a page read; presence is a client store), and
dates are rendered as fixed UTC slices — never `toLocale*` — because the
server and the browser must format identically or hydration breaks.

The report dialog is a single shared component (`components/report-dialog.tsx`)
hosted wherever a report can start — a chat message, the roster's member menu,
a room file — so the reason list, the strict body and the "the reporter is
never shown" guarantee exist in exactly one place. Destructive moderation
actions confirm through Radix `alert-dialog`; everything else answers from
server truth via `router.refresh()` rather than optimistic local state.

Invitations surface in two places: the owner's invite panel inside the
workspace, and the invitee's inbox at `/invitations` (nav-linked). There is
no public invite URL — invitations are addressed to an alias and only the
addressee can see or act on them.

## Testing architecture

| Suite | Runs against | Proves |
| --- | --- | --- |
| Unit (`npm test`) | Nothing (fakes) | Validation, shaping, error-code maps, component behaviour — fast enough to run per file in parallel workers. |
| Integration (`npm run test:integration`) | The real local stack, real signups, `docker exec psql` for fixtures | RLS/grant/policy freezes, RPC races (concurrent joins, accepts, starts), HTTP-level status matrices — serialized per file so row counts are stable. |
| E2E (`npm run test:e2e`) | `next dev` + the local stack, Chromium | Whole product flows through real forms; realtime proven by capturing and replaying WebSocket frames rather than sleeping. |

Shared conventions: no service-role key in any test; users scoped to a
per-run id and deleted by teardown; fixtures created through public RPCs or
guarded psql; deliberate control violations (dropping a grant/policy) are
restored with `db reset` and re-verified green.

## CI

`.github/workflows/ci.yml`: `quality` (lint, types, unit, build — no env) →
`integration` and `e2e` in parallel, each standing up its own local Supabase
from scratch. `permissions: contents: read`, zero repository secrets.

## Where decisions live

| Question | Document |
| --- | --- |
| What does this endpoint accept and return? | `docs/API_CONTRACTS.md` |
| What does this defend against, and what is not claimed? | `docs/SECURITY.md` |
| What is in the schema, granted, and policy-frozen? | `docs/local-supabase.md` |
| What shipped, what is next? | `docs/milestones.md`, `docs/PR_ROADMAP.md` |
| Why was this PR built this way? | `docs/prs/PR-*.md` (spec + reconciliation notes) |
