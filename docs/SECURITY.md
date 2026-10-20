# Security

What this project defends against, how, and — just as important — what it does
not claim to do. `docs/API_CONTRACTS.md` carries the endpoint contracts; this
file carries the model behind them.

## Principles

1. **Identity only from the session.** No endpoint accepts an owner id, a user
   id, a room id "on behalf of", a content type or a storage path from the
   client. Anything the database needs is derived server-side or written by a
   column default (`auth.uid()`).
2. **Deny by default, then narrow.** Every table and the storage bucket start
   revoked; grants and policies are added one column and one verb at a time
   (`supabase/migrations/0001_init.sql`, `0003`, `0004`, `0005`).
3. **Two independent layers for every rule.** The API re-checks what the
   database already enforces, and the database enforces what the API assumes.
   A bug in one leaves the other standing.
4. **No existence oracles.** "Does not exist" and "you may not see it" are the
   same `404 not_found`, byte-identical in message and shape.
5. **No permanent URL for private bytes.** Downloads are short-lived signed
   URLs, re-authorized on every request.

## Threat model

| Adversary | Capability assumed | Defended by |
| --- | --- | --- |
| Anonymous visitor | Unauthenticated requests to pages and `/api/*` | Session check first in every handler; middleware redirects pages to `/auth/login`; API routes answer the documented JSON `401` instead of an HTML redirect |
| Authenticated stranger | A valid session, ids guessed or harvested from elsewhere | RLS read policy on `study_resources` (own rows, plus rows of rooms they are *currently* in); storage `select` policy re-derives the same scope from the object key; `404` for both missing and forbidden |
| Room member | Legitimately reads shared files | Delete/upload are uploader-only: ownership comes from the server-built storage key, and storage's own `delete` policy requires `owner = auth.uid()` |
| Forged request body | Posts `owner_id`, `user_id`, `storage_path`, `content_type`, `size_bytes` | The multipart parser rejects **unknown parts** with `400 invalid_request` (naming them) rather than ignoring them; `owner_id` has no `INSERT` or `SELECT` grant at all, so PostgREST refuses the column on privilege grounds before any policy runs |
| Hand-written PostgREST / Storage call | Bypasses the Next.js app entirely | RLS and storage policies encode the same rules the app encodes; the key layout is checked by a regex `CHECK` on the row and by `storage.foldername()` segment counts on the object |
| Hostile file | Extension spoofing, oversized payloads, path traversal in filenames | Magic-byte sniffing decides the content type, the extension only cross-checks it; 20 MiB ceiling (refused on `content-length` before buffering); filenames without path separators or `..`; storage keys are built from server-generated UUIDs only |
| Storage exhaustion | A student (or a stolen session) uploading until the bucket fills | Byte quotas — 1 GiB per user, 500 MiB per room — checked twice: a fail-open pre-check before the bytes are written, and the `study_resources_quota_guard` BEFORE INSERT trigger, which is the authority (per-user/per-room advisory locks, `409 quota_exceeded`, the just-written object rolled back with the row) |
| Upload / API floods | Scripted repetition of uploads, deletes, downloads, sweeps, reports, mutes, blocks, invitations, message sends, room creations or preference writes | One DB-backed fixed-window limiter (`rate_limits` + atomic `rate_limit_take`), per key and per concern: an overall per-user ceiling plus a per-target ceiling on uploads. Over-limit answers `429` + `Retry-After`; the table has no grants and no policies, so direct PostgREST access to the counter dies on `42501` |
| Orphaned bytes | A crash between the object put and the row insert, or an object removed out of band | The upload route compensates on insert failure (object removed before `500`/`409`), and `POST /api/resources/cleanup` sweeps the caller's own key prefix in both directions — objects with no row, rows with no object — skipping anything younger than a 60 s grace period |
| Leaked URL | A signed URL pasted into a chat | TTL of 300 s (`DOWNLOAD_TTL_SECONDS`), re-issued only after a fresh authorization check; the token carries the expiry inside it |
| Database row tampering | Direct `update`/`delete` through SQL or the API | `update`/`delete` are uploader-only, `owner_id`/`room_id`/`storage_path`/timestamps are outside the `UPDATE` grant, `updated_at` is owned by `study_resources_touch`, and `storage.protect_delete()` blocks a plain `delete from storage.objects` |
| Invitation id guessing | A harvested or enumerated `room_invitations.id`, used against accept/reject/revoke | Every transition is a `SECURITY DEFINER` RPC that re-derives `auth.uid()` and compares it to `invitee_id` (or re-proves the room owner) — the id alone grants nothing; missing, not-yours and revoked are one byte-identical `404` |
| Direct PostgREST write to invitations | Hand-written `POST /rest/v1/room_invitations` | No `INSERT`/`UPDATE`/`DELETE` grant exists, so the write is refused on privilege grounds (`42501`) before any policy or CHECK is consulted — the same shape as `focus_sessions` |
| Expired / revoked / already-used invitation replay | Re-accepting after expiry, after the owner revoked, or a second accept after success | Status gate plus read-time `expires_at > now()` inside one locked transaction: expired → `410` with no write, resolved → `409`, and a repeat accept is an idempotent `200 already_member` that still consumes the invitation |
| Forwarded invitation | The invitee copies their inbox row (or its id) to someone else | There is nothing to forward: invitations are addressed to `invitee_id`, and acceptance binds to `auth.uid()` — a third party acting on the id gets `404`. (Superseded the spec's bearer-link accepted risk: see `docs/prs/PR-07-private-invitations.md`.) |
| Roster probing | A non-member reading `GET /api/rooms/[id]/members` or calling `room_roster` directly | The route proves membership first and the RPC re-proves it inside its own transaction; both a missing room and a forbidden one are the same `404`. The response carries alias/role/joined_at only — no user ids, no emails |
| Invite spam by a room owner | An owner mass-inviting aliases | 10 invitations per hour per (room, inviter) via the shared limiter (`invite:{roomId}:{userId}`, `429` + `Retry-After`), plus the one-pending-per-(room, invitee) partial unique index and 1–168 h TTL bounds |
| Forged reporter identity | A report body carrying `reporter_id` or `actor_id` | No such field exists in the schema (unknown keys are `400 validation`); `create_moderation_report` pins `reporter_id = auth.uid()` inside the definer, and the column has **no `SELECT` grant**, so no read path can return it |
| Audit-trail forgery | Hand-written `INSERT`/`UPDATE` on `moderation_reports`, `moderation_actions` or `room_moderators` | No write grants at all — `42501` on privilege before any policy runs; only the definer RPCs write, one audit row per action, with `actor_id = auth.uid()` |
| Muted member bypassing the mute | `POST /rest/v1/room_messages` straight at PostgREST | The INSERT policy's `with check` requires no active mute → `42501`; the API route maps the same refusal to `403 muted`, and the composer is disabled up front |
| Block discovered by the blocked user | "Did they block me?" probing | `user_blocks` is `SELECT` own-rows only, no endpoint tells the other side, and the invitation refusal (`409 blocked`) is reachable only by the invitee — i.e. only the person who blocked ever sees it |
| Moderator over-reach | A moderator acting outside their room, or a member claiming moderator | Every RPC re-derives `auth.uid()` and re-proves owner-or-`room_moderators` **within that `room_id`**; there is no global admin role, cross-room calls answer `404`/`403`, and a plain member's attempt is `403 not_moderator` with zero rows touched |
| Provider key exfiltration | Reading `AI_API_KEY` from the client bundle, a request/response payload or a log line | `lib/ai/config.ts` is server-side only: the variable is never read as `NEXT_PUBLIC_*`, never serialised, never logged and never echoed in an error or response — it travels only in the `Authorization` header of outbound server-to-server calls. `AI_PROVIDER=auto` resolves to `mock` only when no key is set; a configured provider that fails answers `502 ai_provider_failed` and never falls back to mock (`lib/ai/providers/openai.ts`) |
| AI spend abuse | A tight loop driving `POST /api/ai/ingest/[resourceId]` to burn provider budget | One bounded step per request (≤ ~2 s), fixed windows `ingest:user:{id}` 30/60 s and `sweep:user:{id}` 6/60 s, PR 10's 20 MiB ceiling re-checked inside `ai_resource_for_ingest`, a 16 MiB extracted-text cap, and a 50 MiB/day embedded-bytes cap per scope — pre-checked in the route so no provider call is made at all when the cap is spent, and enforced again inside `ingest_record_chunk` as the race-safe authority. Over-cap is `403 ai_quota_exceeded` |
| Chunk-table poisoning / cross-scope retrieval | Direct `INSERT`/`UPDATE` on `document_chunks`, or `match_document_chunks` called with a crafted embedding for a room the caller is not in | No `INSERT`/`UPDATE`/`DELETE` grant on `study_ai_documents`, `document_chunks` or `ai_usage` (and no `SELECT` grant at all on `document_chunks.embedding`) — every write travels through 0013's SECURITY DEFINER RPCs. `match_document_chunks` is SECURITY DEFINER with the guard inside: a non-member gets zero rows, personal scope pins `owner_id = auth.uid()`, and only `ready` documents match |
| Prompt injection through an uploaded file (PRs 13–16) | A document containing "ignore previous instructions…" that later surfaces in an AI answer | Enforced by PR 13: retrieved chunk text is wrapped as delimited `<source>` data in the **user** message (`lib/ai/prompts/ask.ts`), never in the system prompt, and a `</source>` sequence inside the text is escaped so it cannot close the tag early; the system prompt says explicitly that source text is not instructions. Answer post-processing strips `[n]` markers that do not point at a real citation and builds the `Sources:` line from the retrieval pipeline's citations only. Citations link to app routes (`/resources`, `/rooms/{id}`), never to storage URLs |
| Private-room enumeration through discovery (PR 17) | A signed-in student probing `/rooms`, `GET /api/rooms` or `GET /api/rooms/[id]/preview` for rooms that are not public | `list_public_rooms` hard-codes `visibility = 'public'` (no parameter widens it) and `room_filter_options` only ever sees public rows, so a private room's name, subject or existence cannot surface in a result or a chip; `room_preview` raises the same `P0002` for a private non-member room and a missing room, and the route maps both — plus a malformed id — to the byte-identical `404 not_found`. Filter options, previews and discovery are also asserted in `tests/integration/room-discovery.test.ts` |
| Meeting token abuse (live meetings) | A non-member minting a join token, a member looping mints, a captured token escalating, or the signing secret leaking | The token route reads identity from the session claims only (nothing in the body is trusted), validates the room id, re-proves membership with `requireRoomMembership` on every request (outsider and missing room → the same `404 not_found`) and is windowed at 12 mints per 60 s per (room, member) *after* the config check and *before* any signing work. Grants are join-only: no room-admin / room-create / room-list / room-record / ingress / own-metadata powers ever; an active room mute drops the microphone from `canPublishSources` so a muted student can watch, share screen and use chat but not publish audio until the mute lifts. Identity is the opaque session user id, the LiveKit room name is `sdyroom-<uuid>` (no title, no alias, no PII in provider logs), tokens live 10 minutes, and `LIVEKIT_API_SECRET` is server-only — never `NEXT_PUBLIC_*`, never serialised, never logged (`lib/server/log.ts` redacts `token`/`jwt` keys and JWT-shaped values). The browser learns the provider URL only from the token response. Asserted in `tests/unit/app/api/rooms-meeting-token.test.ts` and `tests/integration/meeting-token.test.ts` |

## Room presence: what it discloses

| Aspect | What it means |
| --- | --- |
| Payload | `{ alias, studying }` and nothing else — the member's chosen study alias (trimmed, ≤ 32 chars, untrusted display data) and whether the room currently has a running or paused shared focus session. **No user id, email, phone number or profile row** appears in any presence frame, and no `is_own` flag is taken from the payload (the client knows itself) |
| Audience | Current members of that room only. The channel topic `room-presence-{roomId}` is gated by `supabase/migrations/0006_realtime_private_channels.sql`: two `TO authenticated` policies on `realtime.messages` that require a current `room_members` row for `auth.uid()` matching the uuid in the topic, extensions `broadcast`/`presence` only. A non-member cannot join, and a private room's existence cannot be confirmed by probing topics (join failure is indistinguishable from a nonexistent room) |
| Durability | Nothing persists. Presence lives in the Realtime service's memory; a socket close removes it (a 60 s heartbeat re-tracks a half-open one). `0006` adds **no** table, column, grant or publication entry, and the authorization probes it relies on roll back in the same transaction |
| `studying` | Room-scoped by construction: `focus_sessions` records no starter column (one active row per room, owner-only control), so the flag reports the room's shared session, not any individual's private activity — a stated reconciliation in PR 06, not a hidden shortcut |
| Spoofing | A member can lie about their own alias and flag. Presence is therefore never used for authorization, never joined to `profiles` server-side, and never overrides the caller's own identity (`is_own` comes from the tracked key, not the payload) |

## Private room invitations: what it defends

| Aspect | What it means |
| --- | --- |
| Addressing | One row is a contract between two users: `inviter_id` (the room's owner) and `invitee_id` (a named student). Only the invitee may read or act on it — policy `room_invitations_select_addressed` is the *read* side, and every write is a `SECURITY DEFINER` RPC that re-derives `auth.uid()`. **No token, hash or invite URL exists**, so there is nothing to leak, forward, brute-force or paste into a referrer |
| Denial surface | The table is `SELECT`-only for clients (the whole-table grant exists because the policy references the id columns; neither id ever leaves the API — responses are shaped from `inviter_alias` / `invitee_alias`). Create, accept, reject and revoke have no grant at all: direct PostgREST writes die on `42501` before policy evaluation |
| State machine | `status ∈ pending, accepted, rejected, revoked` with `pending ⇔ resolved_at IS NULL`; expiry is evaluated at read time (never stored, never a background job), so there is no stale `expired` state to disagree with the clock. Transitions lock the row `for update`, so racing accepts resolve to exactly one winner |
| Entry | Acceptance seats the invitee through `join_room_core` — the *same* row-locked capacity/closed/idempotency implementation `join_room` uses — with the private gate opened only after a pending invitee row is proved. The core itself is executable by no application role, so `p_allow_private` is unreachable from a client |
| Disclosure | Creating discloses to the invitee that a room exists (its name and the inviter's alias) — but only to a person the owner deliberately named, which is the feature. The roster discloses aliases, roles and join dates **to current members of that room only**; it exposes nothing else and is never used for authorization |
| Spoofing | Aliases and room names are denormalised copies written at create time (immutable today — no alias editing or room renaming exists), and a member lying about their presence flag never touches invitations: presence is never an input to any invitation decision |

The spec's bearer-link model and its accepted risk ("a forwarded link lets a
third party in once") are **superseded**, not mitigated — see the
reconciliation in `docs/prs/PR-07-private-invitations.md`.

## Room management: what makes a write "owner only"

Room editing and deletion (`0008`) are the first flows where the product needs
a write the schema never granted, so they state the rule explicitly:

- **No `UPDATE`/`DELETE` grant on `rooms`, ever.** Every mutation travels
  through SECURITY DEFINER RPCs (`update_room`, `delete_room`) whose execute
  privilege is `authenticated`-only. A direct PostgREST write fails with `42501`
  before RLS is even consulted — proven in
  `tests/integration/room-management.test.ts` for both an authenticated owner
  and `anon`, together with the `has_table_privilege` freeze (`f` for both
  roles, both verbs).
- **Ownership is re-proven from `auth.uid()` inside the RPC**, under the same
  room-row lock `join_room` takes — the request body cannot carry an identity,
  and the capacity floor (`capacity >= current members`) is checked in the same
  transaction as the update, so a shrink cannot race a join. The control test
  widens the `UPDATE` grant *in a rolled-back transaction* and still observes
  `update … = 0 rows`: even with layer one removed, RLS (no update policy)
  filters the row — and the script proves the grant returns to `f` afterwards.
- **Three independent refusals for immutable fields.** `owner_id`,
  `visibility`, `id`, `created_at`, `updated_at` are unknown keys to the strict
  Zod schema (`400 validation` naming the key), absent from the RPC's fixed
  `set` whitelist, and ungranted at the column level.
- **`404` parity.** The settings page (`getOwnedRoom`) and both routes answer
  a non-member and a missing room with the identical `404`, so neither the
  page URL nor the API is an existence oracle; a member who is not the owner
  gets `403 not_owner` on the API and the same `404` on the page.
- **Deletion is objects-first.** The route sweeps `rooms/{room}/**` before
  `delete_room` cascades the rows, using the `0008`
  `study_resources_objects_delete_room_owner` storage policy (OR'd with the
  uploader-only policy): the owner can remove member-uploaded objects of a
  room they own, and nobody else gains anything — the integration test has a
  stranger's remove change nothing. Order matters because the storage policies
  authorize *against the rows*: rows-first would strand objects with no
  metadata left to authorize their cleanup. A sweep failure returns
  `500 cleanup_failed` with the room fully intact.

## Moderation: what keeps a reporter private

Member safety (`0009`) is the first surface where one member acts on another,
so each rule is stated rather than implied:

- **`reporter_id` cannot leak because it cannot even be read.** The column has
  no `SELECT` grant for `authenticated` or `anon`, the moderator listing is an
  explicit column projection inside `room_report_list`, and the integration
  suite asserts both the response shape and the grant probe. The reporter is
  pinned to `auth.uid()` inside `create_moderation_report` — no body field
  exists to forge — and no endpoint returns the identity.
- **Audit rows are definer-only.** `moderation_reports`, `moderation_actions`
  and `room_moderators` carry no `INSERT`/`UPDATE`/`DELETE` grant, so ordinary
  users cannot manufacture reports, verdicts or appointments even through
  hand-written PostgREST. Exactly one `moderation_actions` row is written per
  privileged mutation, in the same transaction as it, with
  `actor_id = auth.uid()`; the frozen integration probes pin the empty grant
  surface.
- **No global admin role.** Every right is `room_id`-scoped and re-proven from
  `auth.uid()` inside the RPC (room owner or a `room_moderators` row). Nothing
  in the schema grants power over more than one room, and cross-room calls
  answer the same `404`/`403` as a stranger's.
- **Mute is two layers deep.** The RPC refuses self, owner and moderator
  targets (`cannot_mute_self` first), and the `room_messages` INSERT policy
  re-checks the active mute — a direct PostgREST insert dies with `42501`,
  surfaced to the composer as `403 muted`. Unmute restores both at once.
- **Blocks are invisible to the blocked.** `user_blocks` is `SELECT` own-rows
  only, the API returns the caller's aliases and timestamps alone, and the
  filter is one clause on the `room_messages` SELECT policy — so history,
  direct reads *and* live `postgres_changes` delivery are all filtered by the
  same server-side rule. The blocked user keeps seeing the blocker's messages
  and is never told.
- **`PATCH /api/reports/[id]` answers `404`, not `403`.** The report id is
  opaque and the room never enters the path, so a non-moderator cannot use the
  endpoint as an existence oracle; room-scoped routes answer `404` before `403`
  for callers who are not members.
- **Removal is membership, never message history.** Removing a member deletes
  their `room_members` row; `room_messages` keeps no `UPDATE`/`DELETE` grant
  and no hidden columns — "a message that was said stays said" — while RLS
  cuts the removed member off from roster, history, resources and presence
  immediately.

## Notifications: who may write, who may read, who decides

`0012_notifications.sql` keeps the writer surface as small as the table's:

- **No application role can `INSERT`.** The table grants `authenticated`
  only `SELECT`, `UPDATE (read_at)` and `DELETE`, all under own-row
  policies. Rows appear through exactly two SECURITY DEFINER RPCs —
  `push_notification` (target resolved by alias through the existing
  `moderation_resolve_alias`) and `push_report_notification` (reporter
  identity read from the report row, never a route body — the PR-09 rule
  carried forward) — and a psql probe in the integration suite pins the
  grant matrix, so a widened grant would fail the suite.
- **The producer rule table is closed and enforced in the RPC.**
  `invite_created` requires the caller to own the room; `muted` /
  `member_removed` / `moderation_resolved` require owner or moderator of the
  room; `invite_accepted`, `resource_ready`, `ai_task_complete` and `system`
  are self-only (`p_user_id = auth.uid()`). Room-scoped checks deliberately
  never inspect the recipient's membership — the invitee is not a member yet
  and a removed member no longer is — and a caller aiming a self-scoped type
  at another user is refused `not_authorized`.
- **Prefs are checked at write time, inside the same RPC.** A muted category
  never creates a row (`muted` envelope), so "the feature is off" needs no
  read-side filter to stay true. `mentions_and_invites` means invites-only;
  `system` ignores preferences and always delivers; a missing key falls back
  to `default` → `all`. The prefs column (`profiles.notification_prefs`)
  carries a narrow column-level update grant — nothing else on the profile
  becomes writable through the notification surface.
- **The reader routes are not existence oracles.** A foreign or missing id
  is the same `404` (RLS filters other users' rows exactly like nonexistent
  ones), the unread count goes through an invoker's-rights RPC so it can
  only ever count the caller's own rows, and `read-all` updates exactly the
  rows the same caller could list. `href` is derived at read time from
  `type`/`room_id`, never stored, so no payload can smuggle a link.
- **Live delivery inherits the same scoping.** `postgres_changes` frames are
  filtered by `user_id=eq.<me>` *and* by the subscriber's own SELECT RLS —
  the same server-side rule chat relies on — so a misdelivered frame is the
  same impossibility as reading another user's row over PostgREST. The
  polling fallback only re-reads the caller's own endpoints.
- **Retention is an explicit, service-role-only function.**
  `prune_notifications(before)` is granted to `service_role` alone —
  authenticated cannot execute it (integration probe) — so the request path
  can never trigger a deletion. The scheduler is a pg_cron job booked by
  migration `0024` (daily 03:17 UTC, 90-day cutoff, executes as the migration
  role), and the `cron` catalog is out of reach of application roles
  (integration probe).

## Profile and settings: the session's own row (PR 20)

The settings surface edits exactly one row — the caller's own `profiles`
row — through **id-less routes**: `GET /api/profile` and
`PATCH /api/profile` take no profile id in the path or body, so there is no
foreign id to forge. Identity comes from the session claims; RLS
(`id = auth.uid()`, re-proved inside the query helpers) makes a cross-user
write a zero-row update, which is the same `404 not_found` a session that
never onboarded gets.

| Concern | Surface | Mitigation |
| --- | --- | --- |
| Editing another student's profile | A crafted `PATCH` | Id-less route plus own-row RLS; foreign attempt and missing row are byte-identical `404`s (no existence oracle) |
| Smuggling protected fields | Body carrying `id`, `user_id`, `email`, `created_at`, `updated_at` | Strict zod schema → `400 validation` before any write; and the database floor — the `profiles` column grants name their columns explicitly, so none of those fields has an `update` grant: the integration suite probes PostgREST directly, gets `42501`, and confirms the row is byte-identical |
| Hostile `alias` / `language` content | Free-text values | Shared `aliasSchema` (1–32, trimmed, starts alphanumeric, control characters rejected) and a closed 40-char language list; alias rendering stays escaped everywhere — no `dangerouslySetInnerHTML` for aliases, including chat and roster |
| Profile enumeration | Reading other students | No public profile route exists; `GET /api/profile` returns only the session's own row, and roster/room responses carry alias/role/join date only — never ids or emails |
| Update spam | A client looping `PATCH` | `profile:{userId}` at 30 / 60 s through the shared DB-backed limiter → `429` + `Retry-After` (taken after validation, so a junk body costs the abuser the request) |
| Vocabulary poisoning | `exam_targets: ["anything"]` | Closed enum server-side over `lib/vocab` → `400`, row untouched (three hostile payloads asserted) |
| Notification-pref drift | Settings vs the notification writer | One writer (`PATCH /api/profile/notification-prefs`, PR 11), one reader (this GET): a test sets `invite: none` on settings and the real invite producer creates no row |
| Alias collision confusion | Two students, one alias | `profiles_alias_lower_key` enforces case-insensitive uniqueness → `409 alias_taken`; this PR adopts the schema's reality rather than weakening it — relaxing uniqueness (or reserving names) is a standing product question |

Email stays read-only through the app by construction: `profiles` has no
email column at all (the address is read from session claims for display),
so Supabase Auth owns every change to it — the UI documents that instead of
inventing a flow the environment cannot honestly link to. Avatars remain
out of scope (no storage policy changes in this PR; the avatar question is
a standing one).

## AI document foundation: keys, cost, retrieval, injection (PR 12)

`0013_ai_documents.sql` and `lib/ai/*` state four rules explicitly, because
each is the kind of thing that silently rots:

- **The provider key is server-side only.** `AI_API_KEY` is read in one place,
  `lib/ai/config.ts`, and is never exposed through a `NEXT_PUBLIC_*` variable,
  never serialised into a payload, never logged, and never echoed back in an
  error message or response — the key travels only in the `Authorization`
  header of outbound server-to-server requests. `AI_PROVIDER` resolves `auto`
  by the key-presence rule: a key present → `openai`, absent → `mock` (honest
  demo mode, announced by a banner). `AI_PROVIDER=openai` with **no** key is a
  configuration mistake that fails loudly as `502 ai_provider_failed`; a
  configured provider that errors in production likewise surfaces `502` with
  the row left resumable — there is **no fallback to the mock provider on any
  provider error**, so a broken production key can never masquerade as demo
  mode. `AI_PROVIDER=mock` is an explicit, deliberate choice (tests, demos).
  Embeddings are produced server-side only; the database receives vectors as
  jsonb floats through `ingest_record_chunk`, so no provider key ever touches
  Postgres.
- **Cost and abuse controls are layered, like the storage quota.** The 50 MiB
  embedded-bytes cap per scope (personal per user, room per room) per day is
  accumulated in the `ai_usage` ledger **inside `ingest_record_chunk`**, which
  re-checks it in the same transaction as the write — that is the race-safe
  authority; the ingest route runs a pre-check (`ai_usage_daily`) purely so an
  already-spent budget never reaches the provider at all, answering `403
  ai_quota_exceeded` with zero provider calls made. On top of that: the shared
  fixed-window limiter (`ingest:user:{id}` 30/60 s, `sweep:user:{id}` 6/60 s),
  **one bounded step per request** (no request embeds more than one document's
  worth of work, ≤ ~2 s), PR 10's 20 MiB object ceiling re-checked inside
  `ai_resource_for_ingest` against the stored row — and again against the
  actual downloaded object before extraction — and a 16 MiB cap on extracted
  text (`extracted_too_large`), so a small but highly compressible PDF cannot
  inflate chunk counts. Route-level quota and rate-limit rejections happen
  before any provider call; the RPC-level quota check is the authority that
  runs last.
- **Retrieval authorization lives in the database, not the route.**
  `match_document_chunks` (0013) is SECURITY DEFINER with `set search_path =
  ''` and the guards *inside*: a caller with no session returns nothing, a
  `p_room_id` the caller is not a member of returns zero rows, personal scope
  (`p_room_id IS NULL`) is pinned to `s.owner_id = auth.uid()`, and only
  `status = 'ready'` documents are ever matched — so a non-member gets zero
  rows even with a perfectly crafted query embedding. Writes are RPC-only:
  `study_ai_documents` and `document_chunks` carry no `INSERT`/`UPDATE`/`DELETE`
  grant for any role (execute revoked from `public`/`anon` on the ingest RPCs),
  so a direct PostgREST write dies on `42501` before any policy, and
  `document_chunks.embedding` has no `SELECT` grant at all — raw vectors are
  never exported; retrieval returns scores instead.
- **Retrieved text is data, never instructions (enforced by PR 13).**
  Chunk text originates from user uploads and is therefore untrusted input:
  `lib/ai/prompts/ask.ts` wraps it as delimited `<source>` *data* in the
  user message (a `</source>` sequence inside the text is escaped so it cannot
  close the tag early), never concatenates it into the system prompt, and the
  system prompt states that source text is not instructions. Citations are
  assembled from app routes (`/resources` for personal files,
  `/rooms/{roomId}` for room files) — never storage URLs — so a poisoned
  document cannot smuggle a link either, and `lib/ai/answer.ts` strips any
  `[n]` marker that does not point at a real citation before the answer is
  stored. This posture was written down in PR 12 and is now enforced, with
  unit and integration tests, by the ask pipeline.
- **Chat spend is capped, and history is append-only (PR 13).** Every
  completed answer records its `chat_tokens` (plus the query embedding's
  `embed_tokens`) through `record_qa` — the only insert path into
  `study_qa` (0018). Application roles hold **no** `INSERT`/`UPDATE`/`DELETE`
  grant on the table, `record_qa` pins `user_id = auth.uid()` and re-checks
  room membership, and the per-user daily chat-token cap (100 000) is
  enforced twice: the route pre-checks today's own-row sum (403 before any
  provider call) and `record_qa` re-checks the same set inside the write as
  the race-safe authority. `SELECT` is column-scoped to the history
  contract's columns, so token accounting never leaves the database.
- **A generated artifact's answer key is server-side, and a quiz is scored by
  the database (PR 14).** `study_artifacts.payload` — including every
  `correct_index` — is written only by `complete_artifact`, and application
  roles hold no `INSERT`/`UPDATE`/`DELETE` grant on the table, so a client can
  never write or mutate a payload. The attempt body (`POST …/attempts`) carries
  only the chosen answer indices: `record_attempt` scores them against the
  stored key inside the database, so a forged `score` is ignored because the
  schema never reads one. `prompt_tokens`/`completion_tokens` are ungranted,
  so artifact token accounting never leaves the database either — the same
  column-scoped posture as `study_qa`.
- **Untrusted document excerpts stay out of the system prompt (PR 14).** The
  generation prompt (`lib/ai/prompts/generate.ts`) inherits PR 13's discipline
  verbatim: retrieved chunk text goes in the **user** message inside
  `<source>` tags (a `</source>` sequence is escaped so it cannot close the
  tag early), and the system prompt states that quoted material is data, never
  instructions. The `create_artifact` RPC re-checks that every requested
  `resource_ids` entry is accessible to the caller and `ready`, so a forged id
  can never enter an artifact or leak through retrieval.
- **Flashcard grading is one own-row schedule computed by the database (PR 14).**
  `review_card` (0019) pins `user_id = auth.uid()`, re-checks membership and
  `status = 'ready'`, computes the SM-2-lite schedule itself, and upserts one
  row per `(artifact_id, user_id, card_ordinal)` — so no member can write or
  read another member's spacing state (own-row RLS + no write grant), and
  grading a card twice moves the schedule instead of stacking rows.
- **Plans are personal, and ownership is a database invariant (PR 15).**
  `0020_study_plans.sql` gives `study_plans` and `plan_items` own-row
  RLS and **no `INSERT`/`UPDATE`/`DELETE` grant for any application role** —
  every write goes through a SECURITY DEFINER RPC that pins
  `user_id = auth.uid()` (`create_plan` raises `not_owner` for a forged id),
  re-checks ownership inside the write, and re-validates the payload domain
  (date window, per-day minutes cap, kind set, item count). One `active` and
  one `generating` row per user are partial unique indexes, not UI state, and
  the progress formula lives in `plan_progress` (execute revoked from
  `anon`/`authenticated` — postgres-only), exposed only through `plan_stats`
  (owner-only, `not_found` for a foreign id) — the app never reads progress
  from a client-writable path. `SELECT` on
  `study_plans` is column-scoped to the view contract, so the plan's
  `prompt_tokens`/`completion_tokens` never leave the database (the same
  posture as `study_qa` and `study_artifacts`). A foreign plan id is `404` on
  every route — no existence oracle across users.
- **Plan generation reuses PR 13's prompt discipline, and citations are
  rebuilt server-side (PR 15).** The plan prompt (`lib/ai/prompts/plan.ts`)
  puts retrieved chunk text in the **user** message inside `<source>` tags
  (a `</source>` sequence is escaped so it cannot close the tag early) and
  the system prompt states that quoted material is data, never instructions.
  The provider payload's citations are never trusted: `generate_plan`
  re-derives every `{title, href}` from the pinned `resource_ids` against the
  database, strips a pinned-but-deleted or pinned-but-not-retrieved document,
  and raises `plan_invalid` (→ `failed`, never `active`) for a fabricated id —
  so a poisoned chunk cannot plant a link any more than it can plant a
  prompt. Retrieval is skipped entirely when the plan is topic-only
  (`document_ids` empty), and `create_plan` re-checks every requested id is
  accessible (room-shared in this room, or the caller's own personal file)
  before it can enter the plan at all.
- **Deterministic adjustments never touch the AI (PR 15).** Shift, done,
  complete-day and archive are plain SQL writes against the plan's own rows —
  no provider call, no token spend, no quota. The shift arithmetic lives in
  `lib/planner/shift.ts` and `shift_plan` re-validates every precomputed
  update (ownership, active, forward-only, `<= exam_date`, done items never
  move) inside the write, so a client-forged update list is refused before it
  can touch a row. The daily chat-token cap (100 000, the same set
  `record_qa` sums) is enforced on `create_plan` and `generate_plan` the same
  way as PR 13: the route pre-checks (403 before any provider call) and the
  RPC re-checks inside the write as the race-safe authority.

## Study resources: where the rules live

| Layer | File | Rule |
| --- | --- | --- |
| Schema | `supabase/migrations/0005_study_resources.sql` | Table, CHECKs (incl. key layout and `room_id ⇔ personal/` agreement), column-grant matrix, 4 table policies, private `study-resources` bucket, 3 storage policies, **no `UPDATE` policy on storage** |
| Quota | `supabase/migrations/0010_resource_hardening.sql`, `lib/resources/quota.ts` | 1 GiB/user + 500 MiB/room: fail-open pre-check before the write, BEFORE INSERT trigger as the authority (advisory locks, `409 quota_exceeded`); `resource_quota` renders the "X of Y used" line |
| Rate limits | `lib/rate-limit/{keys,check}.ts` | `rate_limit_take` fixed windows per key; upload/delete/download/sweep/report/block/mute/invite routes plus message sends, room creation and notification-preference writes (PR 21), and meeting-token mints (`meeting_token:{roomId}:{userId}`, 12 per 60 s) take their slots — see "Rate limits" in `docs/API_CONTRACTS.md` |
| Sweep | `app/api/resources/cleanup/route.ts` | `POST /api/resources/cleanup`: caller's own prefix only, both orphan directions, 60 s grace, 5/min, `500 cleanup_failed` on any list failure (a partial view would make "not listed" a lie) |
| Validation | `lib/validation/resources.ts`, `lib/resources/upload.ts` | Metadata schemas, size/filename rules, magic-byte sniffing, UTF-8 checks, unknown-part rejection |
| Storage keys | `lib/resources/storage.ts` | `personal/{owner}/{id}{ext}` / `rooms/{room}/{owner}/{id}{ext}`, `isOwnedBy()` for the delete pre-check, `absoluteUrl()` built from `NEXT_PUBLIC_SUPABASE_URL` |
| Authorization | `lib/resources/queries.ts`, `lib/rooms/access.ts` | Reads and locator lookups run through the user-scoped client (RLS applies); membership is confirmed before a room-scoped list or upload |
| API | `app/api/resources/**` | The sequence, the status codes and the rollback/cleanup order — see `docs/API_CONTRACTS.md` |
| UI | `components/resources/*`, `app/(app)/resources/*` | Never constructs a URL itself; asks the server for one, and treats `401` as "sign in again" |

Two details worth restating because they are easy to lose:

- **`owner_id` and `storage_path` are not response fields.** `owner_id` is not
  even granted for `SELECT`, and `STUDY_RESOURCE_COLUMNS` (`lib/resources/types.ts`)
  excludes `storage_path` — no shaping step has to remember to strip them.
- **Leaving a room revokes read access immediately** through the membership
  subquery in both the table policy and the storage policy. No file row or
  object is moved or deleted, and the uploader keeps reading their own upload.

## Study analytics: aggregates with no identity surface (PR 16)

- **The privilege check lives in the database, and 404 is a single
  indistinguishable answer (PR 16).** `analytics_room` (SECURITY DEFINER,
  `set search_path = ''`) admits only the room's owner or a `room_moderators`
  row; a plain member, a non-member and a missing room all raise the same
  `not_found`, so the URL never confirms a room exists or that someone can
  moderate it. The page mirrors the same rule through `notFound()`, and the
  workspace only offers the entry point to owner/moderators — but neither the
  UI gate nor a future route refactor can open the hole, because the check is
  inside the RPC the route calls.
- **Personal analytics have no usable identity parameter (PR 16).**
  `analytics_me` always aggregates `auth.uid()`; the spec-fixed `p_user_id`
  argument silently behaves as self for a foreign or null value (no route
  passes one, and a probe with an attacker-supplied id proves it never
  widens), the routes ignore `?user_id=` outright (asserted: the spoofed and
  plain responses are equal JSON), and the CSV path is the same handler with
  `format=csv` forced — one session, one series, no export of anyone else.
  Anonymous callers are refused before aggregation (`unauthenticated`,
  errcode 42501, execute revoked from `anon`).
- **Room payloads are counts and minutes — structurally unable to name
  anyone (PR 16).** `analytics_room` returns only aggregates keyed by date;
  no `user_id`, alias or content field exists in the shape, and the
  integration test runs a recursive key scan over the whole payload to prove
  none can appear. `active_members` is a **count** (distinct members with an
  attributable action in the window, plus the owner when ≥1 session ran) —
  never a list — and per-member leaderboards are rejected in the spec's out
  of scope. The spec's risk-row mitigation ("suppress the breakdown under 3
  members") is decided as **no threshold suppression**: there is no
  per-member breakdown to suppress in v1, only totals and one count, which
  is the scope's own answer to small-room re-identification.
- **No privilege widened to add a chart (PR 16).** The migration contains no
  `grant … on <table>` statement at all: both RPCs are revoke-first
  (`public`/`anon` revoked, `authenticated` granted for execute only) and
  read through their definer, so the aggregate reads the same rows RLS would
  allow without adding a single `SELECT` grant. Personal focus attribution
  also stays inside `0003`'s identity-hiding design — `focus_sessions` gains
  no `user_id`; a student's own focus minutes are the sessions of rooms they
  own, and the seam is documented rather than patched with a new column.
- **The test suite pins each claim (PR 16).** Integration: the grant surface
  (`has_function_privilege` probes), anon/foreign-id/validation RPC probes,
  member/outsider/missing `not_found` parity, moderator grant and revoke
  through `room_moderators`, the counts-only payload scan, CSV≡JSON
  row-for-row, and `?user_id=` spoof equality. Browser: owner/moderator-only
  entry, the rendered identical 404 for member and stranger (streaming makes
  the page's HTTP status unreliable — repo convention asserts the rendered
  page, while the API routes' 404s are asserted by status), and the CSV
  download from the real session.

## Room discovery: public without an existence oracle (PR 17)

- **The public filter lives in the database (PR 17).** `list_public_rooms`
  (SECURITY DEFINER, `set search_path = ''`) hard-codes
  `visibility = 'public'`; the route's parameters can filter, sort and page
  but never widen it. `room_filter_options` derives its distinct subjects,
  exam tracks and languages from public rooms only, so a private room's
  metadata cannot leak into a filter chip even indirectly.
- **Preview is one indistinguishable 404 (PR 17).** `room_preview` raises the
  same `P0002` for a private room the caller does not belong to and for a
  room that does not exist; the API route maps both — and a non-UUID id — to
  the byte-identical `404 not_found`. A member previewing their own room
  (public or private) gets `is_member: true` and `viewer_role`
  (`owner`/`member`/`none`); nothing else about membership or roster is
  disclosed, and participant identities never appear in any discovery shape
  (`member_count` is an aggregate).
- **Cursors are opaque and validated before SQL (PR 17).** The keyset cursor
  is base64url JSON the client treats as opaque; the data layer decodes and
  validates it against the requested sort before the RPC is called, so a
  malformed or cross-sort cursor is a `400` and never reaches SQL (and never
  doubles as an injection surface). `relevance` without a query is refused
  (`22023` → `400`) rather than silently degrading to another sort.
- **No privilege widened to add a browse page (PR 17).** The migration
  contains no `grant … on <table>` statement: all three RPCs are revoke-first
  (`public`/`anon` revoked, `authenticated` granted for execute only) and
  read through their definer; the five supporting indexes change no
  privilege. Anonymous callers are refused before any query (`401` at the
  route, errcode 42501 at the function).
- **The test suite pins each claim (PR 17).** Integration: the anon grant
  surface for all three RPCs (`42501`/`PGRST301`), visibility bait (a private
  room invisible in listings, filter options and preview), the
  member/missing/malformed preview `404` parity, cursor and sort rejections,
  and the HTTP contract of both routes. Browser: the invalid-query empty
  state, the private-room preview rendering the same `Page not found` as a
  missing id (streaming makes the page's HTTP status unreliable — repo
  convention), and the discovery card's join/leave reflecting membership
  after the server refresh.

## Structured logging, request ids and redaction (PR 18)

Every `/api/*` handler is wrapped by `withLogging` (`lib/server/with-logging.ts`),
which emits exactly one JSON line per request through `lib/server/log.ts` —
the application's only logger; no route writes to `console` anymore.

**Request id.** The edge middleware (`lib/supabase/proxy.ts`) resolves
`x-request-id` from the caller (accepted only when it matches
`[A-Za-z0-9_-]{8,128}`; anything else is replaced with a minted uuid) and is
the sole writer of `x-user-id` — a client-supplied `x-user-id` is never
trusted. `withLogging` re-resolves the id, echoes it on the response, attaches
it to every log line for that request, and embeds it as `request_id` in the
error envelope (`lib/api/responses.ts`), so a user-visible error is always
correlatable with the server-side line that explains it — and a support
conversation can name one string that is not an identifier.

**Redaction.** Enforced centrally in `lib/server/log.ts`, not trusted to each
call site. Any field whose key normalizes to a known-sensitive name
(`authorization`, `cookie`, `token`/`token_hash`/`refresh_token`, `password`,
`api_key`, `signed_url`, `reporter_id`, `content`, …) is replaced with
`<redacted>` before serialization. Independent of the key, values that look
like credentials are scrubbed: JWT-shaped strings are replaced wholesale,
`Bearer …` tokens are replaced inline (the surrounding context is kept), and
`token=`/`signature=`/`jwt=` query parameters are rewritten to their path so
an operator can still see *which* object was involved without the signature.
The table-driven test in `tests/unit/lib/server/log.test.ts` is the control —
adding a sensitive key is a one-line change that the test picks up
automatically — and `tests/integration/production-hardening.test.ts` proves
end-to-end that a forged `Authorization` header never reaches the log stream.

**What a log line may contain.** Timestamp, level, event name, request id,
route (normalized: uuids and numbers become `:id`), method, status, duration,
nullable user id, and error fields for failures. Never a stack trace in a
response (server-side lines include stacks by design), never a request body,
never a cookie, never a signed URL with its signature.

## Coverage (how it is proven)

| Suite | Command | What it pins down |
| --- | --- | --- |
| Unit | `npm test` | Validators, path building and ownership parsing, query scoping, every route's status/code matrix including the error branches, upload form and library UI behaviour (incl. size/extension preflights, quota-full locking and the friendly 409/429 copy), the invitation validators and all six invitation/roster routes, the room `PATCH`/`DELETE` routes and their owner-gate mapping, the moderation routes (report/PATCH/blocks status matrices, no reporter field accepted) and the report dialog, roster action menu, moderation inbox and muted composer, the settings and delete-danger components, the presence store, the rate-limit checker (atomic take, fail-open, `429` + `Retry-After`), the quota helpers, the cleanup route's full status matrix, and the notification layer (type/href mapping, cursor codec, prefs merge, `notify()` never throwing, the list/read/read-all/prefs routes' status matrices including the both-producer retrofits, and the bell/list/preferences components), plus the PR-14 layer (generate/attempt/review validators, the prompt builder and its `<source>` escaping, the quiz/deck payload validator, server-side scoring, the SM-2-lite schedule table, the deterministic mock provider, and all seven quiz/deck/artifact routes' status-and-code matrix) and the PR-15 planner layer (exam-window/hours/topic validators, the shift formula and its exam-date clamp, progress grouping, the signals seam, the plan prompt builder and its `<source>` escaping, the deterministic mock provider, the prompt-budget source assembly, and all eight plan routes' status-and-code matrix including CSV, quota, and the shift/complete-day/archive idempotence paths) and the PR-16 analytics layer (range parsing and the streak/CSV/query mappers with strict payload validation, the three analytics routes' status matrix including the ignored `?user_id=` spoof, and the summary strip / focus and accuracy charts / goal ring / range switcher components' a11y semantics and honest empty states) and the PR-17 discovery layer (q/sort/cursor/limit validation with the relevance-without-query refusal, the cursor codec and wrong-sort rejection, the discovery-params URL mapping, both rooms routes' status-and-code matrix including the forwarded opaque cursor and the preview 404 parity, and the search / filters / active-chips / results / preview components' a11y semantics, debounce, and refreshed-first-page behaviour) and the PR-20 profile layer (the shared alias/targets/language validators with the vocabulary enums, the `GET`/`PATCH /api/profile` status-and-code matrix including the empty-body, `alias_taken`, rate-limit and 500 branches, the alias / study-preferences / account settings forms' label, alert and status semantics, and the vocab anti-drift equality test between settings and room creation) and the live-meetings layer (the `POST /api/rooms/[id]/meeting/token` status-and-code matrix including the unconfigured `503`, the rate-limited `429` and the mint-failure `500`, `lib/meeting`'s config parsing — partial config, non-`ws(s)` URL, warn-by-name-only — and the join-grant builder's minimal scopes with the muted-member `canPublishSources` mapping, plus the meeting stage and workspace components' join-flow state machine, response narrowing and mode-toggle contract) |
| Integration | `npm run test:integration` | Against the real local stack with real auth users: `tests/integration/study-resources.test.ts` (24) — privacy of columns and rows, anonymous listing, signed-URL reachability with its 300 s TTL and refusal without a signature, cross-user open/delete refusal, member read, non-member 404, **revocation on leaving**, `owner_id` rejection, impersonation of another student's folder (row *and* object), impersonation of the signed path, magic-byte mismatch, bucket privacy, `owner_id` grants, and the key-layout CHECK; `tests/integration/room-invitations.test.ts` (37) — invitation RLS and grant freezes, non-owner create refusal, alias addressing, every transition (accept/reject/revoke/expiry), the accept race against the last seat, roster denial for non-members, and policy/grant checksums; `tests/integration/room-management.test.ts` (22) — owner-gate parity for `PATCH`/`DELETE`, identity-field refusals, the capacity floor incl. a live join race, the open/close lifecycle, direct-write denial for authenticated and `anon`, the grant/function/storage-policy freezes, the in-transaction control that widens the `UPDATE` grant and still gets zero rows, and full cascade + storage-object removal on delete; `tests/integration/room-moderation.test.ts` (25) — anonymous refusals, strict report bodies, the reporter-identity response-shape and column-grant probes, self/foreign-subject refusals, the workflow with its audit rows, the mute lifecycle with a direct-insert denial, moderator appointment, blocks with one-way chat filtering and the blocked-invite round trip, member removal, cross-room isolation, audit/grant freezes, and a rolled-back control that widens a grant and still gets zero rows; `tests/integration/resource-hardening.test.ts` (25) — the `rate_limits` grant/policy/anon-execution freeze with a grant-revoke control proving RLS stands when grants are widened, `rate_limit_take` windows/rollover/oversubscription/invalid args, 413/415 plus the bucket's own oversized-put refusal reached without the app, upload- and delete-`429`s, both orphan-sweep directions scoped to the caller (plus non-member `404` and the sweep `429`), the quota chain end to end (listing matches the database, pre-check boundaries, a two-upload race resolved to exactly one winner, a direct SQL insert refused by the trigger, and freed bytes spendable the moment a delete lands), and the signed-download serve review (attachment disposition with the original name, 300 s expiry on the served response, signature absent from listings); `tests/integration/notifications.test.ts` (25) — the grant freeze (no `INSERT` for any app role, the exact policy set, producer RPC grants, the realtime publication entry), the producer authorization rules in both directions (owner-only invites, owner-or-moderator moderation, self-only system, cross-caller refusals), preferences honored at write time (`muted` envelope, `mentions_and_invites` = invites-only, missing key → `all`), deduplication under a partial unique index (collapse updates `created_at`/`payload`, a read row never blocks), cross-user isolation reached through both the routes and psql, the two real producers end to end through their actual API routes (`invite_created` and `muted`/`member_removed`/`report_resolved` via seeded sessions), the reporter-identity guarantee (the reporter's uuid never appears in any payload and a smuggled `user_id` is refused `invalid_payload`), the retention function's service-role-only grant with an authenticated-execution denial probe, the pg_cron retention job (exactly one active row with the documented schedule, cutoff and execution identity) plus the `cron` catalog's refusal of `authenticated`, and the report-path forgery floor (a stranger driving the report producer gets the same `not_found` the PATCH route gives them); `tests/integration/quiz-artifacts.test.ts` (14) — the artifact store's deny-by-default surface: strict generate bodies, outsider 404 parity, empty-room `no_documents_indexed`, the daily chat-quota 403, forged and mixed `resource_ids` pinned to 409, the full quiz happy path with **server-side scoring** (a perfect 5/5 and a partial score, plus a forged `score` field refused as `400`), attempts scoped to their author, creator-gated step/delete (`403 not_creator`), the idempotent second step (`deduped: true`), the deck review loop freezing the SM-2-lite schedule (`again` → streak 0/interval 0, `got_it` → streak +1) and the live `due_count`, artifact list visibility with the kind filter, creator-only delete, and the 10-per-minute generate window returning `429` + `Retry-After`; `tests/integration/study-planner.test.ts` (24) — the plan store's deny-by-default surface: strict create bodies, outsider 404 parity on every route, `room_not_member` (403) vs `not_found` (404) for a visible-non-member vs an invisible room, the one-active/one-generating partial unique indexes (`23505` and the `deduped: true` adopt), the daily chat-quota 403, forged `resource_ids` and out-of-window item dates refused by `generate_plan`, the full happy path with a **mock-generated plan** (pinned document cited, topic-only fallback note, `plan_stats` authority), the shift formula's exam-date clamp and done-item skip, `complete-day` idempotence, CSV download headers, the 10-per-minute create/step window returning `429` + `Retry-After`, and the direct-write denial for authenticated and `anon` on both tables; `tests/integration/analytics.test.ts` (19) — the analytics RPC grant surface (`has_function_privilege`), fixed-fixture numbers verified against manual SQL (cross-midnight bucketing, accuracy, by-difficulty, cards due, streaks), the 90-day expansion, foreign `p_user_id` coercion, anon permission-denied and `p_days` validation probes, zero-data honesty (`accuracy: null`, no fake zeros), CSV≡JSON row-for-row plus `/me.csv` parity, the room counts-only payload with a recursive no-identity scan, member/outsider/missing `404` parity, moderator grant/revoke through `room_moderators`, and `?user_id=` spoof equality through the routes; `tests/integration/room-discovery.test.ts` (24) — the three RPC grant surfaces (authenticated execute, anon refusal in `42501`/`PGRST301`), visibility bait across listings, filter options and preview, per-user viewer membership (owner/member/outsider), the sort/cursor rejection matrix, preview 404 parity (private-non-member, missing, malformed), and the full HTTP contract of `GET /api/rooms` and `GET /api/rooms/[id]/preview`; `tests/integration/profile-settings.test.ts` (12) — signed-out `401`s, `404 not_found` for a session with no profile row, the documented `GET` shape with no identity leakage, the combined alias/targets/language update with read-back, a hostile body (`email`/`user_id`/`id`/`created_at`) refused `400` with the row byte-identical, the empty-body `400 invalid_request`, the three out-of-vocabulary payloads refused without partial apply, cross-user isolation, the direct PostgREST floor probes (`created_at`/`id`/`email`/`user_id` → `42501`, nothing written), the roster reflecting a changed alias to a room-mate, prefs set here honored by the real invite producer (no row created), and the 30-window `429` + `Retry-After` on `profile:{userId}`; `tests/integration/meeting-token.test.ts` (7) — the join-token route against the live stack: `401` without a session, a member's mint carrying the room-scoped JWT claims (opaque identity, alias display name, join-only grant with no admin powers), outsider/missing-room `404` parity, `400` for a non-UUID id, the honest `503` while unconfigured, a muted member's token dropping the microphone until the mute lifts, and the 12-per-minute per (room, member) `429` with `Retry-After` |
| Browser | `npm run test:e2e` | `tests/e2e/resources.spec.ts` (5) — upload through the real form, private library, room sharing and delete in Chromium; `tests/e2e/invitations.spec.ts` (4) — the invitation lifecycle in two real browsers (invite → inbox → accept, negatives for a stranger, rejection/revocation/expiry, and a full room) plus live presence annotation on the roster; `tests/e2e/room-management.spec.ts` (3) — the owner editing settings a member can see, a non-owner bounced off the settings URL, closing a room so a new student cannot join, and a name-typed delete that 404s the member's stale workspace; `tests/e2e/moderation.spec.ts` (4) — a message report reaching the owner's inbox with no reporter identity shown, one-way block filtering that leaves no trace for the blocked, an owner mute disabling the composer before a confirmed removal, and the documented refusal codes for anonymous, non-member and plain-member direct API attempts; `tests/e2e/resource-hardening.spec.ts` (5) — the oversize and wrong-extension preflights failing in the browser with nothing written, a normal upload tracked by the quota line, a psql-filled library locking the form (with the API still refusing `409` behind it), and a spent upload window answering `429` + `Retry-After` over real HTTP and inside the form; `tests/e2e/notifications.spec.ts` (3) — a live invite raising the invitee's badge in an already-open tab without a reload, the click-through deep-link decrementing it durably, "Mark all read" surviving a fresh document, preferences suppressing a new producer write at the source (no badge, no row), the signed-out visitor never meeting the bell, and the header control staying operable at a phone viewport; `tests/e2e/quiz-flashcards.spec.ts` (4) — a member generating a quiz and taking it to a server-scored result (then retaking), a member generating flashcards and flipping/grading through to a session summary, a room with no indexed document showing the disabled-and-explained generate entry instead of hiding it, and a non-member getting the same `404` for the generate page as for a missing room; `tests/e2e/study-planner.spec.ts` (3) — a topic-only plan generated through the real form (grouped checklist, progress, reload persistence, mark-day-done, the two-step shift with its moved count, and the documented no-documents note), a room-grounded plan citing its pinned document with the CSV attachment and the 409 on a second generate (plus the regenerate loop), and another student's plan id rendering the same `404` a missing id gives while the API answers `404`/`401` (foreign / unauthenticated); `tests/e2e/analytics.spec.ts` (3) — the dashboard starting honestly empty then showing the seeded fixture (strip numbers, streak line, charts with sr-only tables, goal-ring progressbar semantics, plan-vs-actual), the 30d range switch with its URL and 30 rows, the CSV download (filename, header, 31 lines), an unknown page range rendering `Page not found`, the room panel visible to its owner with counts only while a plain member and a stranger get the identical rendered 404 (moderator appointment opens it, revocation closes it again), and the direct `/me.csv` download agreeing with `/me` plus `?user_id=` spoof equality; `tests/e2e/room-discovery.spec.ts` (9) — search, filters and sort through the real form with URL-state restore and removable chips, the relevance default with a query, load-more paging through the cursor without repeats, the invalid-query explained empty state, the empty-state clear/create actions, the private-room preview rendering the same `Page not found` for a stranger while the owner can still open it, and the discovery layout at phone and desktop viewports; `tests/e2e/settings.spec.ts` (4) — the alias change announced and reflected in the header account control without a manual reload and in the room roster after navigation, exam targets and language persisted across a read-back, a notification preference set on settings surviving a reload, an empty and an over-length alias each surfacing an inline `role="alert"` with no success state, and sign-out from the account region landing on `/auth/login` with the settings URL unreachable afterwards; `tests/e2e/meeting.spec.ts` (2) — the meeting view honestly unavailable with no provider configured (Meeting toggle disabled and explained, no Join control), and — auto-skipped without `LIVEKIT_URL` — a member joining through the real token route with the live controls and participant count visible, a second member joining the same call, and leaving returning to the join card with the chat mounted |

CI runs all three (`.github/workflows/ci.yml`) with `permissions: contents: read`
and no repository secrets.

## Not covered, on purpose

These are known limitations, not oversights to be discovered later:

- **Rate limits are per session, not per network.** The limiter (PR 10) keys
  on the caller's user id, so unauthenticated traffic never reaches it — it is
  refused `401` first — and abuse spread across many accounts is bounded per
  account but not in total. There is no per-IP or global budget, no adaptive
  throttling, and a fixed window can be burst twice across its boundary.
- **No malware scanning.** Only signature and encoding validation runs. The
  migration header says this in so many words: format validation is not
  scanning, and nothing in this repository claims otherwise.
- **No `text/html` in the allow list**, so no stored payload can be rendered as
  a page by the browser; objects are also served from the Supabase origin, not
  the app's.
- **A signed URL is bearer for its lifetime.** Anyone holding it may fetch until
  it expires; there is no per-request revocation short of removing the object.
- **No content-security policy beyond Next.js defaults**, no WAF, no dependency
  scanning beyond `npm audit` (see README).
- **The storage origin does not send `X-Content-Type-Options: nosniff`.** The
  app does not control object-fetch response headers, so the served asset leans
  on three other things: content types are sniffed from the bytes before
  storage ever sees them, `text/html` is not in the allow list, and every
  signed URL is issued with `&download=<original name>` so storage answers
  `Content-Disposition: attachment` — the browser downloads instead of
  rendering. (Verified against the local stack in
  `tests/integration/resource-hardening.test.ts`.)
- **No service role at runtime.** No server-side code uses a service-role key;
  every request runs on the cookie-scoped, user-privileged Supabase client.
  (One exception by design: the `prune_notifications` retention function is
  granted to `service_role` only and is not called from any request path —
  nothing in the app can invoke it.)
- **Notification retention's scheduler is configured per environment, and must
  be verified there.** Migration `0024` installs pg_cron and schedules the
  90-day `prune_notifications(before)` job; a fresh local `db reset` shows the
  `cron.job` row (integration probe, including its schedule and execution
  identity). After the migrations reach any hosted project, confirm with
  `select jobname, schedule, active, username, command from cron.job where
  jobname = 'prune_notifications';` — until that query answers in a given
  environment, treat its scheduling as unverified there.

## Reporting

Open an issue (see the README's "Feedback and issues" section). Do not include
signed URLs, session cookies or user ids in a public report.
