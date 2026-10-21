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
  ├─ Realtime: focus/chat/communities postgres_changes,
  │            presence channels                              (delivery)
  └─ Storage: private buckets + per-object policies           (bytes)

Optional externals — server-keyed, honest off-states           (boundaries)
  ├─ AI provider   OpenAI-shaped HTTP; mock pipeline when unkeyed
  ├─ LiveKit       media flows browser ↔ LiveKit; the app only mints join tokens
  └─ GIF provider  Tenor/Giphy behind the community proxy (host allow-list)
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

One payload rule sits beside them: in communities, the database stores
**ciphertext** — message bodies are encrypted and decrypted on devices
(`ts-mls`, MLS), so the server validates envelope structure and membership
and never sees plaintext chat (`docs/SECURITY.md` §Communities).

## Directory map

| Path | Responsibility |
| --- | --- |
| `app/(app)/*` | Signed-in pages (rooms and the workspace, resources, invitations, settings, analytics, planner, onboarding, communities and the community workspace). Pages `export const instant = false` (the app runs with `cacheComponents`) and are session-gated by `lib/supabase/proxy.ts`; most carry `loading.tsx`/`error.tsx` boundaries. `/communities/[id]` splits into a server page (metadata + session gate) and the client `components/communities/community-detail.tsx` because route-segment config may only be exported from a server file. |
| `app/api/*` | Route handlers. Validate with Zod, map domain errors onto the single error envelope, never touch SQL directly. |
| `components/*` | Presentational + client-interactive components. They fetch through `lib/` query modules or the documented `/api/*` endpoints; they never construct storage URLs or identity fields themselves. |
| `lib/validation/*` | Zod schemas mirroring the database CHECK constraints — trim before length, blank → `null`, no identity fields. |
| `lib/<feature>/` | One module per feature: `queries.ts` (reads/writes through the user-scoped client), `types.ts` (response shaping with explicit column lists), errors with stable codes. |
| `lib/rooms/access.ts` | The shared membership/ownership gates (`requireRoomMembership`, `requireRoomOwner`) that give non-members the same `404` as a missing room. |
| `lib/communities/` | The community feature module: `access.ts` (membership/staff/visibility gates with the same `404` parity), `queries.ts` (RPC-backed reads/writes with `CommunityError` codes), `sync.ts` (the MLS sync orchestrator: bootstrap, bounded Adds, Remove decisions), `payload.ts` (the strict envelope shape), `gif.ts` (server-side provider proxy). |
| `lib/crypto/` | Device-side cryptography: `mls.ts` (the `ts-mls` wrapper — group state, commits, welcomes, epoch rules, local-state teardown), `attachment.ts` (AES-256-GCM envelope helpers), `storage.ts` (IndexedDB stores for MLS group state and the own-message plaintext cache). `ts-mls` is **not independently audited**. |
| `lib/meeting/` | The LiveKit feature module: `config.ts` (the three `LIVEKIT_*` keys, read in one place, all-or-nothing) and `token.ts` (join-token grants — microphone dropped while the member is room-muted). Only tokens travel through the app; media flows browser ↔ LiveKit directly. |
| `hooks/` | Client data loops shared by community components (`use-community-workspace`: sync loop, optimistic send, realtime merge, decryption states). |
| `lib/api/responses.ts` | The one error envelope: `{ error: { code, message, issues? } }`. |
| `lib/supabase/` | `proxy.ts` (session refresh + page redirects), `server.ts` (cookie-scoped server client), `client.ts` (browser client). No service-role key exists in the repo. |
| `supabase/migrations/` | The schema, applied only to the local stack (`npx supabase db reset`). `0001`–`0013` and `0018`–`0025` are append-only (`0014`–`0017` never existed); existing files are never edited. |
| `tests/unit` | Vitest, no network: validators, queries against fake builders, every route's status matrix, component behaviour. |
| `tests/integration` | Vitest against the real local stack with real auth users: RLS/grant probes, RPC races, HTTP-level handler tests. Never uses a service-role key (SQL fixtures go through `docker exec psql`). |
| `tests/e2e` | Playwright + Chromium driving the real `next dev` app: two-browser flows, WebSocket frame capture/replay, teardown scoped to a per-run user id. |
| `docs/` | `ARCHITECTURE.md` (this file), `API_CONTRACTS.md`, `SECURITY.md`, `DEVELOPMENT.md`, `local-supabase.md`, `RELEASE.md`, `STAGING.md`, `milestones.md`, `PR_ROADMAP.md`, `prs/*` (per-PR specifications). The operational contract for contributors and agents is `AGENTS.md` at the repository root. |

## Data model

Thirty-two tables, all with RLS enabled, all granted explicitly column by
column (`auto_expose_new_tables = false`):

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
| `notifications` | The in-app inbox rows (`0012`). Own-row RLS, **no `INSERT` grant for any application role** — writes travel through the two SECURITY DEFINER producers; unread counts through the invoker's-rights `notifications_unread_count()`; old rows are pruned by a `pg_cron` schedule created in `0024` — a database-side job whose presence must be verified per environment (`docs/RELEASE.md`). |
| `study_ai_documents` | Per-resource AI ingest state machine (`0013`): `pending → extracting → chunking → embedding → ready \| failed`, provider/model bookkeeping, error codes. |
| `document_chunks` | Chunk rows for pgvector retrieval (`0013`), read only through `match_document_chunks`. |
| `study_qa` | Append-only per-user Q&A history (`0018`), written by `record_qa` when an ask lands. |
| `study_artifacts` | Generated quizzes and flashcard decks (`0019`); the payload holds the answer key server-side and never leaves the room's members. |
| `quiz_attempts` | Server-scored quiz attempts (`0019`); the client's score field is refused — `record_attempt` computes it. |
| `flashcard_reviews` | The SM-2-lite review schedule (`0019`), one row per (user, card). |
| `study_plans` / `plan_items` | Generated study plans (`0020`); one-active and one-generating partial unique indexes, state machine through SECURITY DEFINER RPCs. |
| `ai_usage` | Per-user daily AI token/step accounting (`0018`/`0019`) enforcing the chat quota. |
| `communities` | One discoverable group (`0025`): slug, name, category, visibility, join policy, `member_count ≥ 1`, the `private → request` pairing CHECK; four policies (public-or-member read, owner-self insert, staff update, owner delete). |
| `community_members` | Membership `(community_id, user_id)` with `role ∈ owner/moderator/member`, `status ∈ active/requested/banned` and a partial unique one-owner index. **`SELECT`-alone grants** — create/join/leave/set/kick are SECURITY DEFINER RPCs, so self-promotion and `member_count` drift are structurally unreachable. |
| `community_channels` | Channels per community (slug unique per community, server-booked `position`) — each channel is one MLS group. |
| `community_messages` | The encrypted stream: `kind ∈ application/commit`, base64 `ciphertext` (16–262 144), sender device id, idempotent `unique (channel_id, client_msg_id)`, identity `seq` cursor; append-only, published to Realtime as ciphertext rows. |
| `community_welcomes` | Addressed MLS welcomes carrying ciphertext + the public ratchet tree (RFC 9420 out-of-band distribution); `SELECT` is recipient-or-sender only. |
| `community_devices` | Published MLS key packages (public credential material by design), `unique (user_id, device_id)`, world-readable `SELECT` so peers can run Add commits, writes own-row only. |
| `community_attachments` | Metadata pointers for ciphertext objects in the private `community-attachments` bucket — path (uuids only), size and type; never a file name or plaintext. |
| `community_reports` | Voluntary reports with a nullable ≤2 000-char **decrypted** excerpt — the one deliberate plaintext escape hatch, opt-in per report; no status machine. |

Membership flows (join, leave, invitation acceptance) all funnel through
`SECURITY DEFINER` RPCs because an RLS `WITH CHECK` cannot take the row lock
that makes the capacity check safe. `0007` factored the seat logic into
`join_room_core` so `join_room` and invitation acceptance share one
implementation; the core is executable by no application role. Moderation
follows the same pattern (`0009`): reports, verdicts, mutes, removals,
appointments and blocks are all definer RPCs so identity, subject-in-room and
the audit row are proved in one transaction. Communities extend it (`0025`):
create, join/request, approve, leave, role-set and kick are definer RPCs so
the membership row change and the `member_count` update commit together —
`community_members` itself grants clients only `SELECT`, which is what makes
self-promotion unreachable.

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

**A message send (community, end-to-end encrypted):**

```
device encrypts first — MLS application message (ts-mls) for text/sticker/
  reactions/commits; AES-256-GCM envelope (key inside the E2EE payload) for
  files and GIFs
POST /api/communities/[id]/channels/[channelId]/messages
  → session claims → strict Zod (kind, base64 ceiling, uuid, device id) →
  30/60 s window → membership + channel-in-community re-check (404 parity) →
  INSERT { kind, ciphertext, client_msg_id, seq }     ← plaintext never exists server-side
  → 201 { message } (a repeated clientMsgId returns the existing row)
  → realtime INSERT frame (the ciphertext row) filtered by RLS; receivers
    decrypt on-device or render the honest "can't be decrypted on this
    device yet" state — and the sender's own copy is served from this
    device's local plaintext cache (MLS senders cannot re-decrypt their
    own envelopes; see docs/SECURITY.md §Communities)
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

Five kinds of channels, all gated to current room members, current
community members, or the user themselves:

| Channel | Carries | Gate |
| --- | --- | --- |
| `focus-{roomId}` | `postgres_changes` on `focus_sessions` (`wait: true` so `SUBSCRIBED` implies the filter is registered) | RLS applied at delivery |
| `room-messages-{roomId}` | `postgres_changes` on `room_messages` | RLS applied at delivery |
| `room-presence-{roomId}` | Presence `{ alias, studying }` | `realtime.messages` policies from `0006`: topic uuid must match a current `room_members` row |
| `community-messages-{channelId}` | `postgres_changes` INSERT on `community_messages` (`0025` publication) | `messages_select_member` RLS at delivery — frames are ciphertext rows plus metadata, never plaintext |
| user-scoped notification channel | `postgres_changes` INSERT on `notifications` (`0012` publication) feeding the header bell badge | own-row RLS at delivery; a focus/60 s polling fallback covers missed frames |

Nothing realtime persists: presence lives in Realtime's memory, chat and
session frames are hints that trigger a re-read of the authoritative view.
`components/room-chat.tsx` publishes the observed presence list into
`lib/chat/presence-store.ts`, which the member roster annotates from — one
observation, two readers, no second socket.

## Frontend composition

The room workspace (`/rooms/[id]`) is one server component that seeds the
client panels: `RoomRoster`, the owner's `RoomInvitePanel` (private rooms
only), `FocusTimer`, `GoalsPanel`, `RoomChat`, `ResourceLibrary`,
`ArtifactList` (generated quizzes/decks), and — when
the viewer is the owner or an appointed moderator — `ModerationInbox`. The
same read also fetches the caller's moderation view (`room_moderation_info`:
can-I-moderate, moderator aliases, mute state) and their own block list,
which the roster menus and the chat composer consume. AI entry points
("Ask my notes", "Quizzes & decks") are disabled-and-explained with no
indexed document — never hidden. Each panel is
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

The same workspace carries a **Meeting** toggle (`components/meeting/*`: stage,
grid, tiles, controls, device pickers). Each join re-mints a LiveKit token
through `POST /api/rooms/[id]/meeting/token`, which re-proves membership on
that request; with the three `LIVEKIT_*` keys absent the toggle renders
disabled with an explanation instead of a join button that would fail, and the
token route answers `503 meeting_unavailable`. Media itself never transits
this application — only tokens and room names do.

Invitations surface in two places: the owner's invite panel inside the
workspace, and the invitee's inbox at `/invitations` (nav-linked). There is
no public invite URL — invitations are addressed to an alias and only the
addressee can see or act on them.

Communities surface as `/communities` (discovery + create dialog) and the
per-community workspace (`/communities/[id]`): a channel sidebar, the
message list with per-message decryption states, and a composer with
text/sticker/GIF/file modes — all driven by `hooks/use-community-workspace.ts`
and the shared report dialog for moderation, with the honest waiting and
"can't decrypt yet" states rendered instead of fake plaintext.

## Testing architecture

| Suite | Runs against | Proves |
| --- | --- | --- |
| Unit (`npm test`) | Nothing (fakes) | Validation, shaping, error-code maps, component behaviour — fast enough to run per file in parallel workers. `npm run test:coverage` measures `lib/**` + `app/api/**` and enforces the floors (statements 75% / branches 65%, per `vitest.config.ts`). |
| Integration (`npm run test:integration`) | The real local stack, real signups, `docker exec psql` for fixtures | RLS/grant/policy freezes, RPC races (concurrent joins, accepts, starts), HTTP-level status matrices — serialized per file so row counts are stable. |
| E2E (`npm run test:e2e`) | `next dev` + the local stack, Chromium | Whole product flows through real forms; realtime proven by capturing and replaying WebSocket frames rather than sleeping. The responsive/a11y spec drives axe scans (WCAG 2.1 A/AA) over the public, auth, discovery, settings and workspace surfaces. |

Shared conventions: no service-role key in any test; users scoped to a
per-run id and deleted by teardown; fixtures created through public RPCs or
guarded psql; deliberate control violations (dropping a grant/policy) are
restored with `db reset` and re-verified green.

## CI

`.github/workflows/ci.yml`: `quality` (lint, env contract, types, unit tests
**with coverage floors**, doc-count and doc-link checks, build — no env
secrets; `coverage/lcov.info` uploaded as an artifact) → `integration` and
`e2e` in parallel, each standing up its own local Supabase from scratch; the
integration job also runs the doc-count check against its run's JSON so the
per-file numbers in `docs/SECURITY.md` cannot drift. `permissions: contents:
read`, zero repository secrets.

## Environment variables

`.env.example` is the authoritative list and `npm run check:env` fails when
the code reads a key it does not document. The short version:

| Key | Role |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | The local or hosted project; the publishable key only — no service-role key exists anywhere in the repo. |
| `AI_PROVIDER`, `AI_API_KEY`, `AI_BASE_URL` | Server-side AI credentials; `mock` (or a missing key) runs the demo-mode pipeline with canned answers. |
| `AI_*` model/limit keys | Optional overrides read server-side only (see `.env.example` for the exact names). |
| `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | LiveKit meeting tokens — three keys, all required together, server-side only, never `NEXT_PUBLIC_*`. Unconfigured → the Meeting toggle disables and `POST /api/rooms/[id]/meeting/token` answers `503 meeting_unavailable`. |
| `GIF_PROVIDER` / `GIF_API_KEY` | Server-side GIF provider for the community composer (`tenor` or `giphy`, both required together). Never `NEXT_PUBLIC_*`; with either empty the tab hides and the proxies answer `503 gif_unavailable`. |

## Where decisions live

| Question | Document |
| --- | --- |
| What does this endpoint accept and return? | `docs/API_CONTRACTS.md` |
| What does this defend against, and what is not claimed? | `docs/SECURITY.md` |
| What is in the schema, granted, and policy-frozen? | `docs/local-supabase.md` |
| What shipped, what is next? | `docs/milestones.md`, `docs/PR_ROADMAP.md` |
| Why was this PR built this way? | `docs/prs/PR-*.md` (spec + reconciliation notes) |
