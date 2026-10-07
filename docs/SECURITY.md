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
| Leaked URL | A signed URL pasted into a chat | TTL of 300 s (`DOWNLOAD_TTL_SECONDS`), re-issued only after a fresh authorization check; the token carries the expiry inside it |
| Database row tampering | Direct `update`/`delete` through SQL or the API | `update`/`delete` are uploader-only, `owner_id`/`room_id`/`storage_path`/timestamps are outside the `UPDATE` grant, `updated_at` is owned by `study_resources_touch`, and `storage.protect_delete()` blocks a plain `delete from storage.objects` |
| Invitation id guessing | A harvested or enumerated `room_invitations.id`, used against accept/reject/revoke | Every transition is a `SECURITY DEFINER` RPC that re-derives `auth.uid()` and compares it to `invitee_id` (or re-proves the room owner) — the id alone grants nothing; missing, not-yours and revoked are one byte-identical `404` |
| Direct PostgREST write to invitations | Hand-written `POST /rest/v1/room_invitations` | No `INSERT`/`UPDATE`/`DELETE` grant exists, so the write is refused on privilege grounds (`42501`) before any policy or CHECK is consulted — the same shape as `focus_sessions` |
| Expired / revoked / already-used invitation replay | Re-accepting after expiry, after the owner revoked, or a second accept after success | Status gate plus read-time `expires_at > now()` inside one locked transaction: expired → `410` with no write, resolved → `409`, and a repeat accept is an idempotent `200 already_member` that still consumes the invitation |
| Forwarded invitation | The invitee copies their inbox row (or its id) to someone else | There is nothing to forward: invitations are addressed to `invitee_id`, and acceptance binds to `auth.uid()` — a third party acting on the id gets `404`. (Superseded the spec's bearer-link accepted risk: see `docs/prs/PR-07-private-invitations.md`.) |
| Roster probing | A non-member reading `GET /api/rooms/[id]/members` or calling `room_roster` directly | The route proves membership first and the RPC re-proves it inside its own transaction; both a missing room and a forbidden one are the same `404`. The response carries alias/role/joined_at only — no user ids, no emails |
| Invite spam by a room owner | An owner mass-inviting aliases | Not rate-limited (repo-wide gap, PR 10); bounded today by owner-only creation, the one-pending-per-(room, invitee) partial unique index, and 1–168 h TTL bounds |
| Forged reporter identity | A report body carrying `reporter_id` or `actor_id` | No such field exists in the schema (unknown keys are `400 validation`); `create_moderation_report` pins `reporter_id = auth.uid()` inside the definer, and the column has **no `SELECT` grant**, so no read path can return it |
| Audit-trail forgery | Hand-written `INSERT`/`UPDATE` on `moderation_reports`, `moderation_actions` or `room_moderators` | No write grants at all — `42501` on privilege before any policy runs; only the definer RPCs write, one audit row per action, with `actor_id = auth.uid()` |
| Muted member bypassing the mute | `POST /rest/v1/room_messages` straight at PostgREST | The INSERT policy's `with check` requires no active mute → `42501`; the API route maps the same refusal to `403 muted`, and the composer is disabled up front |
| Block discovered by the blocked user | "Did they block me?" probing | `user_blocks` is `SELECT` own-rows only, no endpoint tells the other side, and the invitation refusal (`409 blocked`) is reachable only by the invitee — i.e. only the person who blocked ever sees it |
| Moderator over-reach | A moderator acting outside their room, or a member claiming moderator | Every RPC re-derives `auth.uid()` and re-proves owner-or-`room_moderators` **within that `room_id`**; there is no global admin role, cross-room calls answer `404`/`403`, and a plain member's attempt is `403 not_moderator` with zero rows touched |

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

## Study resources: where the rules live

| Layer | File | Rule |
| --- | --- | --- |
| Schema | `supabase/migrations/0005_study_resources.sql` | Table, CHECKs (incl. key layout and `room_id ⇔ personal/` agreement), column-grant matrix, 4 table policies, private `study-resources` bucket, 3 storage policies, **no `UPDATE` policy on storage** |
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

## Coverage (how it is proven)

| Suite | Command | What it pins down |
| --- | --- | --- |
| Unit | `npm test` | Validators, path building and ownership parsing, query scoping, every route's status/code matrix including the error branches, upload form and library UI behaviour, the invitation validators and all six invitation/roster routes, the room `PATCH`/`DELETE` routes and their owner-gate mapping, the moderation routes (report/PATCH/blocks status matrices, no reporter field accepted) and the report dialog, roster action menu, moderation inbox and muted composer, the settings and delete-danger components, and the presence store |
| Integration | `npm run test:integration` | Against the real local stack with real auth users: `tests/integration/study-resources.test.ts` (22) — privacy of columns and rows, anonymous listing, signed-URL reachability with its 300 s TTL and refusal without a signature, cross-user open/delete refusal, member read, non-member 404, **revocation on leaving**, `owner_id` rejection, impersonation of another student's folder (row *and* object), impersonation of the signed path, magic-byte mismatch, bucket privacy, `owner_id` grants, and the key-layout CHECK; `tests/integration/room-invitations.test.ts` (37) — invitation RLS and grant freezes, non-owner create refusal, alias addressing, every transition (accept/reject/revoke/expiry), the accept race against the last seat, roster denial for non-members, and policy/grant checksums; `tests/integration/room-management.test.ts` (22) — owner-gate parity for `PATCH`/`DELETE`, identity-field refusals, the capacity floor incl. a live join race, the open/close lifecycle, direct-write denial for authenticated and `anon`, the grant/function/storage-policy freezes, the in-transaction control that widens the `UPDATE` grant and still gets zero rows, and full cascade + storage-object removal on delete; `tests/integration/room-moderation.test.ts` (25) — anonymous refusals, strict report bodies, the reporter-identity response-shape and column-grant probes, self/foreign-subject refusals, the workflow with its audit rows, the mute lifecycle with a direct-insert denial, moderator appointment, blocks with one-way chat filtering and the blocked-invite round trip, member removal, cross-room isolation, audit/grant freezes, and a rolled-back control that widens a grant and still gets zero rows |
| Browser | `npm run test:e2e` | `tests/e2e/resources.spec.ts` (5) — upload through the real form, private library, room sharing and delete in Chromium; `tests/e2e/invitations.spec.ts` (4) — the invitation lifecycle in two real browsers (invite → inbox → accept, negatives for a stranger, rejection/revocation/expiry, and a full room) plus live presence annotation on the roster; `tests/e2e/room-management.spec.ts` (3) — the owner editing settings a member can see, a non-owner bounced off the settings URL, closing a room so a new student cannot join, and a name-typed delete that 404s the member's stale workspace; `tests/e2e/moderation.spec.ts` (4) — a message report reaching the owner's inbox with no reporter identity shown, one-way block filtering that leaves no trace for the blocked, an owner mute disabling the composer before a confirmed removal, and the documented refusal codes for anonymous, non-member and plain-member direct API attempts |

CI runs all three (`.github/workflows/ci.yml`) with `permissions: contents: read`
and no repository secrets.

## Not covered, on purpose

These are known limitations, not oversights to be discovered later:

- **No rate limiting.** No rate limiter exists anywhere in this application yet;
  adding one only for uploads would be inconsistent with the rest of the app.
  The moderation routes (report filing, mute/unmute, block/unblock) are named
  in PR 10's remit for exactly that reason — they are documented, not
  throttled, today.
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
- **No service role at runtime.** No server-side code uses a service-role key;
  every request runs on the cookie-scoped, user-privileged Supabase client.

## Reporting

Open an issue (see the README's "Feedback and issues" section). Do not include
signed URLs, session cookies or user ids in a public report.
