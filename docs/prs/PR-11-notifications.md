# PR 11 — Notification foundation (in-app inbox, no email)

**Status:** implemented on `feat/notifications`, in review.
**Owner:** Dev A (OpenCode) · **Complexity:** Medium · **Migration:** `0011_notifications.sql`
**Depends on:** PR 06 (presence events are a notification source), PR 09 (moderation actions are a source), PR 19 (bell placement lives in the responsive shell header), PR 20 (notification preferences belong to profile settings)

---

### Problem

SdyRoom has no notification mechanism at all. `lib/` contains no notifier, no
in-app inbox, no unread tracking; the workspace header has no bell; and the
four actionable product events that already exist — **an invitation was created
for me** (PR 07), **I was muted/removed** (PR 09), **my report was actioned**
(PR 09), **my library file finished processing** (PR 12/13) — all land silently.
`docs/milestones.md` lists "no notification system" among known gaps. For a
student who closes a tab mid-conversation, silence is indistinguishable from
"nothing happened".

### User story

As a student I see, in the app, a chronological list of things that happened to
me or that I was invited to, with unread counts, and I can clear them; and I
choose which of them I actually want to be told about.

---

### Scope

- **`notifications` table** scoped to a user: `type` (closed enum), `payload`
  jsonb, `read_at`, `created_at`, optional `room_id` for deep-linking.
- **Writer API** — one internal helper (`notify(userId, type, payload)`) plus the
  RPCs/route handlers in PRs 07/09/12 calling it. This PR lands the helper and
  migrates **two** producers that already exist or are in-flight: invitation
  created (PR 07's accept/invite path) and moderation actions (PR 09). Producers
  for AI completion (12/13/14/15) and resource processing use the same helper
  with types already reserved in the enum.
- **Reader API**: `GET /api/notifications` (paged), `POST /api/notifications/[id]/read`,
  `POST /api/notifications/read-all`.
- **Unread count** endpoint (cheap, separate: `GET /api/notifications/unread-count`)
  so the header badge does not fetch the whole list.
- **In-app inbox UI**: bell in the header with an unread badge, dropdown panel
  listing recent notifications with relative time and deep links
  (`/rooms/[id]`, `/invite/[token]`, `/resources`, moderation subject), "Mark
  all read", empty state, and `role="status"`/`aria-live="polite"` on new items.
- **Preferences** (per user, per type: `all | mentions_and_invites | none`,
  default `all`): stored on `profiles.notification_prefs jsonb` (or a dedicated
  table — decision in Database work) and editable from PR 20's settings page;
  the writer respects them (preference is checked **at write time**, so a muted
  type never creates a row; simpler and cheaper than filtering on read).
- **Realtime delivery**: subscribe to a private per-user channel
  `notifications:{userId}` so an open tab updates the badge without polling.
  Polling fallback: `router.refresh()` on focus / 60s interval, because
  "unreliable" must degrade, not break.
- Deduplication: same type + same subject + unread → **collapse** (update
  `created_at`, keep one row) rather than stacking.

### Out of scope

- **Email.** Nothing is sent outside the app. `docs/local-supabase.md` and
  Supabase Auth handle auth emails only; application email (SMTP/provider, templates,
  deliverability) is a deliberate non-goal — revisit as a standalone PR after
  launch.
- **Push notifications** (web push, service worker, mobile) — no PWA work here.
- **SMS/WhatsApp** — out of scope entirely for now.
- Involving any third-party analytics or engagement SDK.
- Read receipts for chat, typing indicators (PR 06's lane), presence as a
  notification (presence is its own section, not an inbox row).
- Notification *grouping/batching* UI (weekly digest, "5 messages from X") — the
  dedupe rule above is enough for v1.
- Cross-device conflict resolution beyond "last write wins" on `read_at`.
- Storing notification history indefinitely — a retention policy (see below) is
  in scope as a documented cap, not a background job.

---

### Frontend work

| File | Change |
| --- | --- |
| `app/(app)/layout.tsx` (or wherever the shell header lives) | Mount `NotificationBell` in the header — must be added where PR 19's responsive shell can move it into the mobile menu. Coordinate: this PR adds it, 19 re-places it. |
| `components/notifications/notification-bell.tsx` (new) | Unread badge (aria-labelled count), dropdown panel with the list, "Mark all read", link to a full page if the list overflows the dropdown. `role="status"` region for live arrivals. |
| `components/notifications/notification-list.tsx` (new) | Row component: icon by type, sentence + relative time (`<time dateTime>`), deep link, per-row mark-read on click. |
| `app/(app)/notifications/page.tsx` (new) | Full inbox page (paged beyond the dropdown's recent N), `loading.tsx` + `error.tsx`. |
| `app/(app)/settings/page.tsx` (or PR 20's settings surface) | Notification preference controls: per-type select. If PR 20 has not landed, render the section in a small `components/notifications/preferences-form.tsx` mounted from the existing profile/settings area and note the handoff. |
| `lib/notifications/queries.ts`, `types.ts` (new) | Client-side fetch helpers, types, relative-time formatting. |

Accessibility: badge count has a text alternative ("3 unread notifications");
dropdown is keyboard-navigable (Radix `dropdown-menu` already exists — reuse);
prefers-reduced-motion respected if any transition is added.

### Backend work

| Route | Behavior |
| --- | --- |
| `GET /api/notifications` | Own notifications only. Query `?cursor&limit=20&unread=true`. → `{ notifications: [...], has_more, total, unread_count }`. |
| `GET /api/notifications/unread-count` | → `{ unread_count }`. Cheapest path; used by the bell. |
| `POST /api/notifications/[notificationId]/read` | → `200 { read: true }`; idempotent (already read → `200 { read: true, unchanged: true }`). `404` for someone else's row (indistinguishable from missing). |
| `POST /api/notifications/read-all` | → `{ updated: n }`. |
| `PATCH /api/profile/notification-prefs` (or folded into an existing profile PATCH) | Body `{ prefs: { invite: ..., moderation: ..., ai: ..., resource: ... } }` from a closed enum of values. → `200 { prefs }`. |

Writer side (not a public route): `lib/notifications/write.ts` exporting
`notify({ userId, type, payload, roomId?, dedupeKey })`:

- consults prefs, skips silently when the type is muted;
- inserts via RPC `push_notification(...)` (SECURITY DEFINER so one user can
  notify another without a cross-user `INSERT` grant);
- respects the dedupe rule;
- **never** throws into the caller's happy path — a notification failure must
  not fail an invitation or a moderation action. Log and continue; assert this
  in tests.

Realtime: `lib/notifications/subscribe.ts` — client subscribes to
`notifications:{userId}`; the writer channel-joins and sends a bare payload
(`{ id }`); client invalidates the query. If `realtime.messages` RLS proves to
be a blocker (the PR 06 risk), fall back to polling and document it — the
feature must not depend on an unresolved policy question.

### Database work

`supabase/migrations/0011_notifications.sql`:

- `notifications(id uuid pk, user_id uuid not null references auth.users on
  delete cascade, type text not null check (type in ('invite_created',
  'invite_accepted', 'member_removed', 'muted', 'moderation_resolved',
  'report_resolved', 'resource_ready', 'ai_task_complete', 'system')),
  room_id uuid null references rooms on delete cascade, payload jsonb not null
  default '{}', dedupe_key text null, read_at timestamptz null, created_at
  timestamptz not null default now())`.
- Indexes: `(user_id, created_at desc)`, partial `(user_id) where read_at is null`,
  partial unique `(user_id, dedupe_key) where read_at is null and dedupe_key is
  not null`.
- Retention: document "rows older than 90 days are pruned by an operator-run
  RPC `prune_notifications(p_before timestamptz)`"; grant it to nobody
  application-side (service role only). No cron in this PR — but the RPC exists
  so retention is real, not aspirational.
- Grants (revoke-first): `SELECT` on the caller's own rows (policy), `UPDATE
  (read_at)` own rows, **no `INSERT` grant** for `authenticated` (writes go
  through the SECURITY DEFINER RPC `push_notification`), `DELETE` own rows.
- Policies: `notifications_select_own` / `notifications_update_own` /
  `notifications_delete_own`, all `user_id = auth.uid()`.
- RPC `push_notification(p_user_id uuid, p_type text, p_payload jsonb,
  p_room_id uuid, p_dedupe_key text) returns uuid` — SECURITY DEFINER,
  `search_path = ''`, execute revoked from `public`/`anon`, granted to
  `authenticated`. **Producer authorization is per-caller:** the RPC does not
  let user A invent a `member_removed` about user B unless A is the room owner
  or moderator of `p_room_id` (check when `p_room_id` is present); for
  self-scoped types (`invite_accepted`, `resource_ready`) require
  `p_user_id = auth.uid()` **or** a membership relation. Encode the rule table
  in the function header comment. This is the one place where a global
  "anyone can notify anyone" hole could open — treat it as the review focus.
- RPC `unread_count() returns int`.
- Preferences: **column on `profiles`** — `notification_prefs jsonb not null
  default '{"default": "all"}'::jsonb` with `grant update (notification_prefs)`
  (narrow widening of `0001`'s profiles grant; policies already scope rows to
  self). A separate table would need its own grants/policies for no gain — the
  column keeps PR 20 simple.

### Storage work

None.

### Realtime work

- Per-user channel `notifications:{userId}` (private), sending `{ id }` on
  insert. Join the channel only as the authenticated user; **do not** grant a
  broadcast to arbitrary channel names.
- Reuse the PR 06 learnings about `realtime.messages` RLS: if the policy
  question is unresolved when this PR starts, ship with polling + focus-refresh
  and add the subscription as a fast follow. State which mode shipped.
- Presence is not used here.

### AI work

None (this is the delivery substrate AI work later reuses: `ai_task_complete`).

---

### Security requirements

A user must **not** be able to:

1. Read, mark, or delete another user's notifications (`user_id = auth.uid()`
   everywhere; the `404` on foreign ids must be indistinguishable from missing).
2. Insert notifications directly (no `INSERT` grant) or forge a type via the
   RPC beyond what the per-type producer rule allows.
3. Trigger notifications to arbitrary user ids at volume (the RPC's producer
   rule plus PR 10's shared rate limiter on the routes that can be spammed —
   e.g. an invite flood; apply `invite:{roomId}:{userId}` here).
4. Learn private payload content via the realtime channel of another user
   (channel is per-user, joined only with that user's session).
5. Use `read-all` to mark somebody else's items read.
6. Cause a notification write to roll back a completed business action — the
   writer is best-effort by contract.

Positive guarantees:

- Every payload is data the recipient could already see through an API they are
  authorized for (no "leak via notification" vector): an invite notification
  shows room name only; a moderation notification never contains `reporter_id`
  (PR 09 rule extends here — assert it).
- Preference changes take effect on the next write, immediately.

### API contracts

```jsonc
// GET /api/notifications?limit=20&unread=true
{ "notifications": [
    { "id", "type", "room_id", "payload": { "title", "body", "href" },
      "read_at", "created_at" } ],
  "has_more": true, "total": 12, "unread_count": 3 }
// GET /api/notifications/unread-count  → { "unread_count": 3 }
// POST /api/notifications/[id]/read    → { "read": true, "unchanged": false }
// POST /api/notifications/read-all     → { "updated": 3 }
// PATCH /api/profile/notification-prefs → { "prefs": { "invite": "all", … } }
```

| Error | Code |
| --- | --- |
| 400 | `validation` / `invalid_json` |
| 401 | `unauthenticated` |
| 404 | `not_found` (foreign or missing id — same response) |
| 409 | `invalid_state` (reserved; reads are idempotent so this should not fire) |
| 429 | `rate_limited` (invite/moderation producers, via PR 10 keys) |
| 500 | `notifications_failed` / `notify_failed` (writer only; never surfaces to the triggering action) |

Types reserved in the enum and their payload `href` conventions — document all
of them in `docs/API_CONTRACTS.md` so PRs 12–15 only pick from the list.

### Tests

**Unit**

- `notify()` writer: muted type skips (no insert, no throw); dedupe collapses
  two unread rows of the same `dedupe_key`; a throwing DB never propagates
  (spy on the insert and force a rejection → caller's return value unchanged).
- Route files: own-rows scoping, `404` parity, idempotent read, `read-all`
  count, `unread-count` correctness with mixed read states.
- Preference schema: closed values, unknown type refused, unknown pref key
  refused.
- Components: bell badge rendering (`aria-label` includes the count), list
  relative time, empty state, mark-all, preferences form validation.
- `payload.href` for each type points at a route that exists (a tiny map test —
  cheap insurance against dead links).

**Integration (`tests/integration/notifications.test.ts`)**

- User A's rows are invisible to user B in every operation (select, read,
  read-all); foreign `read` → `404` with zero rows changed.
- Direct PostgREST `insert into notifications` → permission denied (no grant).
- `push_notification` producer rules: user A cannot push
  `member_removed` to user B in a room A does not own; room owner can;
  self-scoped type with `p_user_id <> auth.uid()` refused.
- Preference `none` prevents row creation; flipping back allows it.
- Dedupe: two pushes with the same key → one row, `created_at` updated.
- Retention RPC (invoked with elevated test rights) removes only rows older
  than the cutoff.
- `reporter_id`-sensitive payloads: a moderation notification payload never
  contains the reporter (mirror of PR 09's assertion).

**E2E (`tests/e2e/notifications.spec.ts`)**

- User B is invited by A (or removed by A) while both contexts are open → B's
  bell badge increments without a manual reload (or, in polling mode, within the
  documented interval — assert whichever mode shipped).
- Click a notification → lands on the right deep link; row marks read; badge
  decrements.
- "Mark all read" clears the badge; reload keeps it cleared (persisted).
- Preferences: set invites to `none` → new invite produces no row → badge
  unchanged.
- Non-logged-in visitor never sees a bell (it is behind `(app)` auth).

### Dependencies

- PR 06 (presence as a Realtime warm-up and file overlap in the shell).
- PR 09 (two of the first real producers; its payloads must not leak
  `reporter_id`).
- PR 07 (invite producer; land the writer call in 07 behind a no-op-compatible
  interface so 11 does not block 07 — i.e. 07 calls `notifyIfPresent()` or 11
  retrofits the two call sites; **choose retrofit** to keep 07 small).
- PR 19 (header/mobile placement) and PR 20 (preferences surface) are UI
  dependencies — the DB/API can land first and mount in the current header.

### Files / modules likely affected

```
supabase/migrations/0011_notifications.sql                (new)
lib/notifications/{write,subscribe,queries,types}.ts      (new)
app/api/notifications/route.ts                            (new)
app/api/notifications/unread-count/route.ts               (new)
app/api/notifications/[notificationId]/read/route.ts      (new)
app/api/notifications/read-all/route.ts                   (new)
app/api/profile/notification-prefs/route.ts               (new, or folded)
app/(app)/notifications/page.tsx                          (new) + loading/error
app/(app)/layout.tsx                                      (bell mount)
components/notifications/{notification-bell,notification-list,
  preferences-form}.tsx                                   (new)
supabase/migrations/0007_room_invitations.sql             (retrofit notify call — or the route file)
lib/validation/notifications.ts                           (new)
tests/unit/lib/notifications/*.test.ts, tests/unit/app/api/notifications-*.test.ts (new)
tests/integration/notifications.test.ts                   (new)
tests/e2e/notifications.spec.ts                           (new)
docs/API_CONTRACTS.md, docs/SECURITY.md, docs/local-supabase.md, docs/milestones.md
```

### Acceptance criteria

- [ ] Two live producers (invite, moderation) create rows; the four AI/resource
      types are reserved and documented for PRs 12/13/14/15.
- [ ] A user sees only their own notifications in list, count, read, and
      read-all; foreign ids are `404`.
- [ ] No `INSERT` grant exists; the RPC's per-type producer rule is tested
      positively and negatively.
- [ ] A notification failure never fails the triggering business action.
- [ ] Muting a type prevents row creation; preference persists.
- [ ] Badge updates on open tabs (realtime) **or** within the documented polling
      fallback — whichever shipped is stated in the PR and tested that way.
- [ ] Deep links resolve; no payload leaks `reporter_id` or any data the
      recipient could not otherwise read.
- [ ] All three suites + build green locally and in CI.

### Definition of Done

1. `npx supabase db reset` from scratch; grant probes pass (no `INSERT`,
   `select` limited to own rows), RPC probes pass both directions.
2. The two retrofit call sites (PR 07, PR 09) are in the diff and covered.
3. CI green on all three jobs.
4. `docs/API_CONTRACTS.md` documents all endpoints **and the type/payload/href
   table** other PRs must use; `docs/SECURITY.md` gains a notification row
   (producer forgery, payload minimality); `docs/local-supabase.md` tables +
   the new channel name; `docs/milestones.md` bullet updated.
5. Realtime-vs-polling mode explicitly stated with the reason.
6. Reviewed by Dev B.

### Owner

**Dev A — OpenCode** (full-stack; the writer's producer-authorization rule is
the review focus).

### Estimated complexity

**Medium–Large.** The surface is broad (table, 5 endpoints, 2 RPCs, prefs, UI,
Realtime) but each piece is small; the one place that can go wrong is the
producer-authorization table inside `push_notification`.

### Risks

| Risk | Mitigation |
| --- | --- |
| `push_notification` becomes a spam/forge vector | Per-type producer rules tested negatively; rate limits from PR 10 on the routes that trigger them; no direct `INSERT` grant. |
| Realtime `realtime.messages` RLS blocks the channel (the known PR 06 risk) | Feature must ship with polling fallback; realtime is an enhancement, not the contract. |
| Notification write breaks the action that triggered it | Best-effort contract + forced-failure unit test. |
| Bell collides with PR 19's header rework | Mount point chosen to be a single insertion point; 19 owns final placement; coordinate in both PR descriptions. |
| Preferences land before PR 20's page exists | Ship a standalone preferences form mounted in the existing settings area; 20 absorbs it. |
| Payload drift across 4 later PRs | The type/href table in `API_CONTRACTS.md` is the contract; reject ad-hoc payloads in review. |
