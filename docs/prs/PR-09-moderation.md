# PR 09 — Moderation, reporting and blocking

**Status:** in review — [PR #9](https://github.com/chanukyareddygopala07/sdyroom/pull/9) (`feat/moderation-safety`).
**Owner:** Dev B (Cursor) · **Complexity:** Large · **Migration:** `0009_moderation.sql`
**Depends on:** PR 07 (member roster — you can only moderate people you can see), PR 08 (merged), chat (merged)

---

### Reconciliation (decisions locked before implementation)

| Decision | Chosen | Why |
| --- | --- | --- |
| Report statuses | `pending → reviewing → resolved \| dismissed` (terminal: resolved/dismissed) | The PR brief mandates a four-value controlled enum; no client-supplied values. |
| Report reasons | `spam, harassment, abusive_content, inappropriate_content, impersonation, unsafe_resource, other` | Closed list; stored as CHECK-constrained text, validated by Zod at the edge. |
| Wire identity | **Alias** for every target address (block, remove, mute, appoint, user-subject report); uuids stay server-side | PR 07 established "alias is the display and addressable identity throughout" and no payload has ever carried a user id; alias→uuid resolution happens only inside SECURITY DEFINER RPCs. |
| Report creation | SECURITY DEFINER RPC `create_moderation_report`, **no direct `INSERT` grant** | A definer context is required to resolve a user-subject alias and to prove subject-in-room; also pins `reporter_id = auth.uid()` unforgeably (the `0005 owner_id` trick became unnecessary). |
| Report status change | SECURITY DEFINER RPC `set_moderation_report_status`, **no `UPDATE` grant** | Keeps the "one audit row per mutation, same transaction" guarantee airtight. |
| `moderation_actions` writes | **No `INSERT` grant at all** (stricter than this spec's original grant+policy design) | Prompt §4: ordinary users must never manufacture audit records; only authorized definer RPCs write them. |
| `room_moderators` / `room_mutes` writes | RPC-only (no write grants) | Same audit guarantee; `SELECT` grants remain so members see moderator badges/mute state. |
| `user_blocks` writes | RPC-only (`create_user_block` / `delete_user_block`), `SELECT` grant kept with `blocker_id = auth.uid()` policy | The route receives an alias and cannot resolve it (profiles are RLS own-only); the chat filter reads own blocks directly. |
| Block → chat enforcement | One clause added to `room_messages` **SELECT** policy: `not exists (blocked by auth.uid())` | Realtime delivers `postgres_changes` subject to the subscriber's SELECT RLS (stated in `0004`), so history, direct reads **and** live arrival are all filtered by one server-side rule; the wire shape never changes. |
| Block → invites | `accept_room_invitation` re-created in `0009` with a block check (PR 07 has merged, so the cross-PR touch lands here as this spec allows) | Stated choice: implemented, not deferred. `join_block_check` remains the documented follow-up (v1 block still does not stop joining). |
| Message removal | **None.** Reports + member-level actions only; `room_messages` keeps no `UPDATE`/`DELETE` grant and gains no hidden columns | Prompt §9: do not add soft-hide complexity for a "report only" first release; "a message that was said stays said" stays trivially true. |
| Report endpoint scope | Room-scoped `POST`/`GET /api/rooms/[id]/reports` + id-scoped `PATCH /api/reports/[reportId]` | Membership is provable from the path before any subject lookup; no room id in bodies to spoof. |
| Member-removal endpoint | `DELETE /api/rooms/[id]/members/[alias]` (bodyless) | Prompt's endpoint shape adapted to REST + alias identity; optional free-text reason dropped (audit `reason` stays null — reports carry context). |
| `PATCH /api/reports/[reportId]` unauthorized | **404**, not 403 (report id is opaque; 403 would confirm existence to non-moderators) | Satisfies the spec's own "no existence oracle" rule for id-scoped routes. |
| Global `/moderation` page | **Not built.** The room-scoped moderation inbox (mounted in the room page) is the product contract | Reports are room-scoped and authorization is per-room; a global view would be dead weight. |
| Block → presence | Not filtered in v1 (documented follow-up) | Presence is ephemeral broadcast; v1 block is a chat/invite concept. |

---

### Problem

Public rooms are joinable by any signed-in student and chat is append-only with
no recourse: there is no way to report abuse, no way for a room owner to remove
somebody, no way to silence a disruptive member, and no record of anything a
moderator does. `0004_room_messages.sql` says so plainly: "Anything beyond that
is moderation, which is out of scope here." Opening public rooms to real users
without this would be negligent.

### User story

As a room owner (or a moderator they appointed) I can remove or silence a
disruptive member and review reports about messages, files or people — and as a
student I can report something without the person I reported ever learning who
reported them.

---

### Scope

- **Report** a user, a chat message, or a resource — with a reason from a closed
  list (`spam | harassment | abusive_content | inappropriate_content |
  impersonation | unsafe_resource | other`) plus optional free text (≤500
  chars), status flowing `pending → reviewing → resolved | dismissed`.
- **Block** a user, with deliberately narrow semantics (see "Blocking semantics"
  below — read it, it is a scope decision, not an omission).
- **Remove a member from a room** (owner or moderator; never the owner, never
  yourself).
- **Mute a member in a room** for a duration (`1h | 24h | 7d` or until lifted) —
  a muted member may read but not post.
- **Moderator roles**: the owner appoints/removes `moderator` grants for members
  of their room.
- **Moderation audit records**: every action writes an immutable row.
- **Moderator controls UI**: report button on messages/resources/member rows, a
  room-scoped moderation inbox (owner/moderator only), member actions menu.

**Blocking semantics (decided and shipped):** SdyRoom has no DMs and
`room_messages` is append-only. A "block" that only hides messages client-side
is easy to bypass and does not stop someone following you between rooms.
Therefore v1 block =

- **(a) the blocked user cannot be invited by the blocker** — enforced inside
  `accept_room_invitation`, re-created in `0009` (the cross-PR touch this spec
  allowed; PR 07 has merged). Accepting such an invitation answers `blocked`
  with a neutral message: the blocker is never notified, and the blocked user
  learns only that this invitation is no longer usable.
- **(b) in rooms the blocker is in, the blocked user's messages are invisible to
  the blocker** — old history and live arrival alike, enforced by one clause on
  the `room_messages` SELECT policy (`not exists (select 1 from user_blocks
  where blocker_id = auth.uid() and blocked_id = room_messages.user_id)`).
  RLS applies at realtime delivery, so the server filters without the client
  ever seeing the message.

Answers to the four product questions, explicitly:

| Question | v1 answer |
| --- | --- |
| Can the blocker still see the blocked user's **old** messages? | No — filtered server-side at read time. Nothing is deleted; the rows are simply not visible to the blocker. |
| Can the blocked user **send** new messages? | Yes — they can still post; the blocker just never receives them. Stopping sends would need a membership-level check and is a follow-up. |
| Is **presence** filtered? | No — presence is unchanged in v1 (documented follow-up). |
| Can they **remain in the same room**? | Yes — blocking never changes membership and never notifies. |

- **v1 block does NOT** prevent the blocked user from joining a public room the
  blocker is in. That requires a membership-level check in `join_room` and is
  listed as an explicit follow-up (`join_block_check`), because it changes a
  documented RPC.

### Out of scope

- Editing or deleting other people's chat messages (append-only stays
  append-only; removal from *view* is filtering, not deletion — see below).
- Global/ban lists, cross-room bans, platform-level suspension, any "admin"
  role above room owner.
- Automated content moderation, profanity ML, image scanning.
- Reporter-visible feedback loops ("your report was actioned" emails) — in-app
  status only.
- Private-room presence moderation (nothing to moderate there).
- Notifications of moderation outcomes — PR 11 consumes the `moderation_actions`
  table; do not build delivery here.
- Legal/compliance workflows (appeals, data subject requests).

**Message removal decision (made):** **no soft-hide.** Chat stays fully
append-only — `room_messages` keeps its `SELECT`/`INSERT` grants untouched and
gains no `hidden_at`/`hidden_by` columns. Moderators act at the member level
(remove / mute) and mark reports `resolved`/`dismissed`; the message a student
wrote remains exactly as written for everyone. Rationale: prompt §9 ships
"report only" for the first release rather than layering a soft-delete model
onto an append-only table, and every hidden-message feature afterwards would
inherit this migration's grant surface. The one change to an existing policy is
the **mute clause on the insert policy** (below) — functionally a narrowing.

---

### Frontend work

| File | Change |
| --- | --- |
| `components/chat-panel.tsx` | Overflow/report affordance on each message (own messages excluded), owner/moderator-only "Remove" if that option is chosen. Keep the composer untouched. |
| `components/resources/resource-library.tsx` | Report action on room-scoped rows only (reporting your own personal file is meaningless). |
| `components/room-roster.tsx` (PR 07) | Per-member action menu for owner/moderator: **Remove from room**, **Mute 1h/24h/7d**, **Appoint moderator** / **Revoke moderator**. Non-privileged members see read-only rows. |
| `components/moderation-inbox.tsx` (new) | Room-scoped report list: subject type, reason, created time, status, resolver; actions = **Start review / Resolve / Dismiss** (status transitions only — remove and mute live in the roster menu). Owner/moderator only. |
| `components/report-dialog.tsx` (new) | Reason radio group (closed list) + optional detail, `role="alert"` errors, submit → success state. |
| `app/(app)/rooms/[id]/page.tsx` | Mount the inbox behind an owner/moderator-only disclosure. |

Accessibility: every action has a visible label or `aria-label`; destructive
actions confirm; the report dialog is a real dialog with focus trap (Radix
`dropdown-menu` exists — add `dialog`/`alert-dialog` from shadcn if needed, do
not hand-roll).

### Backend work

| Route | Behavior |
| --- | --- |
| `POST /api/rooms/[id]/reports` | Any member. Body: strict discriminated union — `{ subject_type: 'user', subject_alias }` or `{ subject_type: 'message' \| 'resource', subject_id: uuid }`, plus `reason` (enum) and optional `detail` (≤500). Resolves + validates the subject **inside** `create_moderation_report` (membership first, then subject). → `201 { report: { id, status, created_at } }`. Duplicate open (pending/reviewing) report by the same reporter for the same subject → `200 { report: { id, status }, duplicate: true }` (idempotent, not 409). `self_report` → `409`. |
| `GET /api/rooms/[id]/reports` | Owner/moderator only (`403 not_moderator` for members; `404` for non-members) → `{ reports: [...], count }` — explicit column list, **no `reporter_id` in the payload or the column grant**. |
| `PATCH /api/reports/[reportId]` | Owner/moderator of the report's room. Body `{ status: 'reviewing' \| 'resolved' \| 'dismissed' }`. Unauthorized or missing → **`404 not_found`** (no existence oracle); illegal transition → `409 invalid_transition`. → `200 { report: { id, status } }`. Writes one `moderation_actions` row via `set_moderation_report_status`. |
| `DELETE /api/rooms/[id]/members/[alias]` | Owner/moderator, never the owner, never self. Bodyless → `200 { removed: true, member_count }`. |
| `POST /api/rooms/[id]/members/[alias]/mute` | Owner/moderator. Body `{ duration: '1h' \| '24h' \| '7d' }` → `201 { muted: true, muted_until, duration }`. |
| `DELETE /api/rooms/[id]/members/[alias]/mute` | Owner/moderator lifts → `200 { unmuted: true }`; no active mute → `409 not_muted`. |
| `POST /api/rooms/[id]/members/[alias]/moderator` / `DELETE` | Owner only, bodyless → `200 { role: 'moderator' \| 'student', changed: boolean, granted: boolean }` (`changed: false` is the idempotent repeat). |
| `POST /api/blocks` | Body `{ alias }` → `201 { block: { alias, created_at }, created: true }`; repeat → `200 { block: { alias, created_at }, created: false }`; `409 self_block`. |
| `GET /api/blocks` | Caller's own blocks only → `{ blocks: [{ alias, created_at }], count }` (alias shape, consistent with the rest of the product). |
| `DELETE /api/blocks/[alias]` | Caller's own block only, idempotent → `200 { removed: boolean }`. |

Existing pattern: identity from session, `requireRoomMembership` for room scope,
strict bodies, one error envelope, `404` indistinguishability for room access,
**alias as the only wire identity** (uuids never leave the server for users).

Privesc checks happen **before** any subject lookup, so a non-moderator cannot
use the endpoint as an existence oracle; room-scoped routes answer `404` before
`403` for callers who are not members.

### Database work

`supabase/migrations/0009_moderation.sql` (reconciled):

- `moderation_reports(id, room_id, subject_type, subject_id, subject_user_id,
  reporter_id, reason, detail, status, created_at, resolved_at, resolved_by)`
  — CHECKs on `subject_type` (`user|message|resource`), `reason` (closed enum),
  `status` (`pending|reviewing|resolved|dismissed`), `char_length(detail) <=
  500`; index on `(room_id, status, created_at desc)`; partial unique
  `(reporter_id, subject_type, subject_id) where status in ('pending',
  'reviewing')`.
- `moderation_actions(id, room_id, actor_id, action, subject_user_id,
  subject_ref, reason, created_at)` — CHECK on `action`
  (`member_removed|mute_applied|mute_lifted|moderator_appointed|moderator_revoked|report_reviewed|report_resolved|report_dismissed`);
  append-only: **no `INSERT`, `UPDATE` or `DELETE` grant for anyone** — rows
  exist only because SECURITY DEFINER RPCs write them in the same transaction
  as the mutation they describe.
- `room_moderators(room_id, user_id, granted_by, created_at)` — PK
  `(room_id, user_id)`, `ON DELETE CASCADE`, `SELECT` grant with a
  member-of-room policy (so roster badges are honest), **no write grants**.
- `user_blocks(blocker_id, blocked_id, created_at)` — PK both columns,
  CHECK `blocker_id <> blocked_id`, cascade on auth user delete; `SELECT` grant
  with `blocker_id = auth.uid()` policy only (the chat filter reads it);
  writes go through `create_user_block` / `delete_user_block`.
- `room_mutes(room_id, user_id, muted_until, muted_by, created_at)` — partial
  unique one active mute per `(room_id, user_id) where muted_until > now()`;
  `SELECT` grant with member-of-room policy; writes RPC-only.
- `moderation_reports` grants: **`SELECT` only, and the column list excludes
  `reporter_id`** — no role can read it through PostgREST; the reporter's own
  rows are visible via a `reporter_id = auth.uid()` policy (policies may
  reference columns without granting them — the `study_resources.owner_id`
  precedent). Everything else (`INSERT`/`UPDATE`) is RPC-only.
- **`room_messages` SELECT policy gains a block clause** (the only existing
  policy changed, functionally narrowed):

  ```sql
  and not exists (
    select 1 from public.user_blocks b
    where b.blocker_id = auth.uid()
      and b.blocked_id = room_messages.user_id
  )
  ```

- **`room_messages` INSERT policy gains a mute clause** (the other narrowed
  clause): `and not exists (select 1 from public.room_mutes mu where
  mu.room_id = room_messages.room_id and mu.user_id = auth.uid() and
  mu.muted_until > now())`. Sender pinning (`user_id = auth.uid()`) and the
  membership conjunct stay byte-identical — `room-messages.test.ts` keeps
  passing and gains mute coverage.
- RPCs (SECURITY DEFINER, `search_path = ''`, execute revoked from
  `public`/`anon`):
  - `create_moderation_report(p_room_id uuid, p_subject_type text,
    p_subject_ref text, p_reason text, p_detail text)` — membership first
    (`42501` → route maps to `404`), then subject: user → resolve alias,
    must be a member of the room and not the caller; message/resource → must
    belong to the room and not be the caller's own. Returns
    `{code: created|duplicate|self_report|not_found|invalid_subject, id?,
    status?}`.
  - `set_moderation_report_status(p_report_id uuid, p_status text)` — actor
    must be owner/moderator of the report's room (`not_found` otherwise — no
    oracle), legal transitions only (`pending→reviewing|resolved|dismissed`,
    `reviewing→resolved|dismissed`), one audit row.
  - `remove_room_member(p_room_id uuid, p_member_alias text)` — actor owner or
    in `room_moderators` (`not_moderator`); cannot remove the owner
    (`cannot_remove_owner`); cannot remove self (`cannot_remove_self`);
    target must be a member (`not_found`); deletes the membership row, writes
    one audit row, returns `member_count`.
  - `mute_room_member(p_room_id uuid, p_member_alias text, p_interval
    interval)` — actor gate first (`not_moderator` for plain members), then
    **self first** (`cannot_mute_self` — checked before the owner/moderator
    rules so an owner muting themselves gets the honest refusal rather than
    `cannot_mute_owner`), then the owner (`cannot_mute_owner`) and a
    moderator (`cannot_mute_moderator`); `already_muted` if an active mute
    exists; one audit row; returns `muted_until`.
  - `unmute_room_member(p_room_id uuid, p_member_alias text)` — deletes the
    active mute (`not_muted` if none), one audit row.
  - `set_room_moderator(p_room_id uuid, p_member_alias text, p_on boolean)` —
    **owner only** (`not_owner`); target must be a member, never the owner
    (`cannot_moderate_owner`); no-op returns `changed: false` without an audit
    row; otherwise one audit row. Self-appointment is structurally impossible
    for non-owners (they are not allowed to call it at all), and an owner
    appointing themselves is refused because they are the owner.
  - `create_user_block(p_alias text)` / `delete_user_block(p_alias text)` /
    `list_my_blocks()` — blocker always `auth.uid()`; `self_block` refused;
    create is idempotent; delete is idempotent; only the caller's rows are
    touched.
  - `room_moderation_info(p_room_id uuid)` — member-gated; returns
    `{viewer_can_moderate, moderator_aliases, muted_aliases,
    viewer_is_muted, muted_until}` so the page can gate the inbox, annotate
    the roster and disable the composer (aliases only — no ids on the wire).
  - `accept_room_invitation` re-created with one added check after the expiry
    gate: if `exists (select 1 from user_blocks where blocker_id =
    v_inv.inviter_id and blocked_id = v_user_id)` return
    `{code: 'blocked'}` (invitation left pending; neutral message).

### Storage work

Reporting a resource references `study_resources.id`; no storage operation. If a
reported file must be withdrawn, that is `DELETE /api/resources/[id]` (uploader)
plus a `moderation_actions` row — do not build a moderator file-delete in this
PR (it needs a storage-policy widening; file it as a follow-up).

### Realtime work

None required. Moderation inbox refreshes on `router.refresh()` / manual
refresh; PR 11 can subscribe later.

### AI work

None.

---

### Security requirements

A user must **not** be able to:

1. Perform any moderator action without being the room owner or an appointed
   moderator — checked inside the RPC **and** by the policy (two layers, the
   repo's standard).
2. Appoint themselves moderator, or appoint a moderator in someone else's room.
3. Remove the room owner, remove themselves as an ownership bypass, or remove a
   member of a different room.
4. Learn who reported them: `reporter_id` has **no `SELECT` grant for any
   role** (not even the reporter's — nobody reads it back through PostgREST);
   report listings returned to moderators must **omit `reporter_id` entirely**
   (moderators see subject, reason, detail, time). Verify with a
   response-shape assertion plus a column-grant probe.
5. Read another user's blocks (only your own rows are visible), block
   themselves (`self_block`), or address a target that is not an existing alias.
6. Mute the owner, a moderator, or themselves (refused inside the RPC).
7. Edit or delete a `moderation_actions` row, or insert one directly (no grants
   exist at all — RPCs only).
8. Evade a mute by inserting into `room_messages` directly through PostgREST
   (RLS `with check` enforces it).
9. Forge a report about a subject in a room they are not in (validate
   membership first, then subject).
10. Send as a blocked user to the blocker, or receive the blocker's messages
    differently — the filter is the SELECT policy, one server-side rule.

Positive guarantees:

- Every privileged mutation writes exactly one `moderation_actions` row, in the
  same transaction as the mutation.
- Report reason is a closed enum; free text is length-bounded and rendered as
  text (never HTML).

### API contracts

Shared envelope. Selected shapes:

```jsonc
// POST /api/rooms/[id]/reports   201 (200 + duplicate:true on idempotent repeat)
{ "report": { "id": "…", "status": "pending", "created_at": "…" } }
// GET /api/rooms/[id]/reports    200  (moderator view: NO reporter_id)
{ "reports": [ { "id", "subject_type", "subject_id", "subject_alias",
                 "reason", "detail", "status", "created_at",
                 "resolved_at", "resolved_by" } ], "count": 1 }
// DELETE /api/rooms/[id]/members/[alias]   200
{ "removed": true, "member_count": 3 }
// POST /api/rooms/[id]/members/[alias]/mute   201
{ "muted": true, "muted_until": "…", "duration": "1h" }
// GET /api/blocks   200
{ "blocks": [ { "alias": "…", "created_at": "…" } ], "count": 1 }
```

| Error | Code | When |
| --- | --- | --- |
| 400 | `validation` / `invalid_json` / `invalid_request` | bad body, unknown field, empty body where one is required |
| 401 | `unauthenticated` | no session |
| 403 | `not_moderator` / `not_owner` / `cannot_remove_owner` / `cannot_remove_self` / `cannot_mute_owner` / `cannot_mute_moderator` / `cannot_mute_self` / `cannot_moderate_owner` | privesc or forbidden target (room is known to the caller at this point, so 403 leaks nothing) |
| 404 | `not_found` | room not visible, member/subject not in room, report not visible to a non-moderator |
| 409 | `self_report` / `self_block` / `already_muted` / `not_muted` / `invalid_transition` | state conflicts (duplicate reports answer idempotent `200`, not 409) |
| 429 | `rate_limited` | PR 10 provides the mechanism; leave the mapping documented, do not implement |
| 500 | `report_failed` / `moderation_failed` / `blocks_failed` | hygiene |

### Tests

**Unit**

- Report/act route files: privesc matrix (`403` before any subject lookup),
  body validation, `reporter_id` never accepted from a body, response shapes
  containing no `reporter_id` in moderator views.
- `moderation_actions` helper: exactly one row per action, immutability asserted
  at the grant level.
- Components: report dialog validation and success, roster action menu visibility
  (owner / moderator / student), remove confirmation, mute duration menu,
  moderation inbox rendering.

**Integration (`tests/integration/room-moderation.test.ts`)** — the full
prompt matrix, at minimum:

- Anonymous cannot create a report or a block (401).
- Member reports a message → row exists, `reporter_id = auth.uid()`; forging a
  reporter in a body is structurally impossible (no such field accepted);
  a direct `insert` of a report (if attempted) cannot pin another reporter.
- Reporter privacy: moderator listing contains no `reporter_id` column at all
  (response-shape assertion + column-grant probe); the reported user's own
  reads never surface it.
- A non-member/non-moderator's room-scoped requests → `404`/`403` with zero
  rows touched; `PATCH /reports/[id]` by a non-moderator → `404` (no oracle).
- Remove: owner removes student → membership gone, `member_count` updated,
  exactly one `moderation_actions` row; removing the owner → refused; removing
  self → refused; removing across rooms → refused; non-owner/non-moderator →
  `403`.
- Removed member loses: roster/members (404), message send (404 — the
  membership gate, plus direct PostgREST insert denial), history read,
  private-room resources, presence channel authorization (realtime.messages
  insert denied).
- Mute: muted member's `POST /messages` → denied **and** a direct PostgREST
  insert → `42501`; unmute restores; mute cannot target the owner/moderator/self.
- Moderator appointment: owner appoints → appointee can act; non-owner cannot;
  self-assignment impossible; revoked moderator loses access immediately.
- Audit: `moderation_actions` has no INSERT/UPDATE/DELETE grant (frozen probes),
  exactly one row per action with `actor_id = auth.uid()`.
- Blocks: idempotent repeat; private to the blocker (another user's read sees
  nothing); `self_block` refused; unblock removes only the caller's row; the
  history endpoint **and** a direct `select` of messages filter the blocked
  user's messages for the blocker only; blocked user's invite acceptance →
  `blocked`.
- Cross-room isolation: actions in room A never appear in room B's inbox.
- Existing suites remain green: chat, resources, invitations, focus/goals RLS.

**Control-violation test (prompt §15):** inside a rolled-back transaction,
widen `moderation_actions` (grant `insert` to `authenticated` **and** add a
permissive policy) and show a direct insert then succeeds — proving the test
suite would catch such a weakening — then roll back and re-assert the secure
state (insert denied, zero grants). Nothing weakened is left in the branch.

**E2E (`tests/e2e/moderation.spec.ts`)** — four scenarios, no mocked successes:

- **A — Report:** a member reports a message from the chat affordance, sees
  the confirmation; the owner opens the inbox, resolves it; the reported side
  sees no reporter reference anywhere.
- **B — Block:** one member blocks another from the roster; the blocker no
  longer receives that user's messages (history filtered, new sends invisible
  to the blocker); unblock restores the view.
- **C — Owner moderation:** owner removes a member from the roster menu; that
  member's next navigation to the room 404s, their composer is gone, and their
  direct API attempts fail; owner mutes another member → send fails with a
  surfaced server message → lift → send works.
- **D — Unauthorized moderation:** a normal member attempts owner/moderator
  actions directly against the API (`remove`, `mute`, `moderator`, `PATCH`
  report) — every request rejected; no moderator controls render in their UI.

### Dependencies

- PR 07 (roster) must merge first — **merged** (`b4e1f33`).
- **Small cross-PR touch — choice made:** PR 07 has merged, so `0009`
  re-creates `accept_room_invitation` with the block check inside it (one
  `create or replace function`; the original in `0007` stays untouched on
  disk). Tested in this PR. The `join_block_check` membership follow-up stays
  open, as scoped above.
- Chat (merged). PR 08 (merged).

### Files / modules likely affected

```
supabase/migrations/0009_moderation.sql                  (new)
app/api/rooms/[id]/reports/route.ts                      (new: POST, GET)
app/api/reports/[reportId]/route.ts                      (new: PATCH)
app/api/rooms/[id]/members/[alias]/route.ts              (new: DELETE)
app/api/rooms/[id]/members/[alias]/mute/route.ts         (new: POST, DELETE)
app/api/rooms/[id]/members/[alias]/moderator/route.ts    (new: POST, DELETE)
app/api/blocks/route.ts                                  (new: POST, GET)
app/api/blocks/[alias]/route.ts                          (new: DELETE)
app/api/rooms/[id]/messages/route.ts                     (no route change —
                                                          block filter is RLS;
                                                          mute surfaces a 403)
lib/moderation/{queries,errors}.ts                       (new)
lib/validation/moderation.ts                             (new)
lib/chat/queries.ts                                      (42501 → `muted` 403
                                                          vs lost-seat 404)
lib/invitations/queries.ts                               (`blocked` code on
                                                          invitation accept)
components/report-dialog.tsx, moderation-inbox.tsx,
components/ui/{dialog,alert-dialog,radio-group}.tsx      (new, shadcn-style)
components/chat-panel.tsx, room-roster.tsx, room-chat.tsx,
components/resources/resource-library.tsx                (report affordances,
                                                          mute state)
app/(app)/rooms/[id]/page.tsx                            (inbox + gating mount)
tests/setup.ts                                           (jsdom ResizeObserver
                                                          stub for Radix)
tests/unit/…, tests/integration/room-moderation.test.ts,
tests/integration/room-messages.test.ts (regression watch — unchanged),
tests/e2e/moderation.spec.ts
docs/SECURITY.md, docs/API_CONTRACTS.md, docs/ARCHITECTURE.md,
docs/local-supabase.md, docs/milestones.md, docs/PR_ROADMAP.md, README.md
```

### Acceptance criteria

- [x] Only the owner and appointed moderators can act; every attempt otherwise
      fails with `403` and touches zero rows.
- [x] The reported user can never learn the reporter's identity through any
      endpoint or payload (asserted as a response-shape test).
- [x] Removal and mute take effect immediately for the target user, including
      for direct PostgREST writes.
- [x] Every action produces exactly one immutable `moderation_actions` row.
- [x] Blocks are private to the blocker and filter that user's messages.
- [x] Chat remains append-only for normal members; the chosen message-removal
      semantics (soft-hide vs none) match the migration.
- [x] All three suites + build green locally and in CI. *(local: lint, types,
      710 unit, build, fresh `db reset` + `db lint`, 240 integration, 33 e2e;
      CI: quality 1m13s, integration 3m14s, e2e 8m1s on
      [run 37681784146](https://github.com/chanukyareddygopala07/sdyroom/actions/runs/37681784146))*

### Definition of Done

1. [x] `npx supabase db reset` from scratch; every grant/policy probe passes,
   including the negative ones (no `UPDATE` on `moderation_actions`, no
   `reporter_id` in moderator payloads).
2. [x] The "Blocking semantics" and "Message removal" decisions are stated in the PR
   description with their rationale — not left implicit.
3. [x] CI green on all three jobs.
4. [x] `docs/SECURITY.md` gains a moderation section (reporter privacy is the key
   row); `docs/local-supabase.md` tables/grants/RLS updated;
   `docs/milestones.md` "No presence, typing indicators, chat moderation…"
   bullet narrowed to what is still true.
5. [x] Cross-PR block-invite interaction resolved and tested.
6. [ ] Reviewed by Dev A.

### Owner

**Dev B — Cursor** (backend/security-heavy; the largest single PR in the
roadmap after 18).

### Estimated complexity

**Large.** Six tables or so, five RPCs, a widened `room_messages` policy, an
existing test that must change, and two product decisions that must be made
explicitly (blocking, message removal).

### Risks

| Risk | Mitigation |
| --- | --- |
| Reporter identity leaks through a moderation inbox, a notification, or a log | `reporter_id` gets no grant; inbox shape asserted by test; never log it. |
| Block ends up a no-op checkbox | Make the semantics a decision gate in the PR description; ship report/remove/mute/moderator first if block is not defensible. |
| Mute enforced only in the route → trivially bypassed | Enforce in RLS `with check` **and** the route; test the direct PostgREST path. |
| Widening `room_messages` policy accidentally weakens sender pinning | Keep `user_id = auth.uid()` conjunct intact; regression-test `room-messages.test.ts`. |
| Moderation without appeals feels arbitrary | Owner-visible audit list + explicit out-of-scope note; platform-level appeals are post-launch. |
| Scope explodes (content ML, DMs, bans) | Out-of-scope list is explicit; reject additions in review. |
