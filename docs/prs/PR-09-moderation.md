# PR 09 — Moderation, reporting and blocking

**Status:** specification only — no GitHub PR exists.
**Owner:** Dev B (Cursor) · **Complexity:** Large · **Migration:** `0009_moderation.sql`
**Depends on:** PR 07 (member roster — you can only moderate people you can see), chat (merged)

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
  list plus optional free text (≤500 chars).
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

**Blocking semantics (decide up front, document in the PR):** SdyRoom has no DMs
and `room_messages` is append-only. A "block" that only hides messages is easy to
bypass client-side and does not stop someone following you between rooms. Therefore:

- **v1 block =** (a) the blocked user cannot be **invited** by the blocker
  (checked in PR 07's accept RPC — cross-PR touch, see Dependencies), and (b) in
  rooms the blocker is in, the blocked user's messages are **filtered out of the
  history endpoint and dropped on arrival** for the blocker only.
- **v1 block does NOT** prevent the blocked user from joining a public room the
  blocker is in. That requires a membership-level check in `join_room` and is
  listed as an explicit follow-up (`join_block_check`), because it changes a
  documented RPC.

If (b) is judged too weak to ship, the honest alternative is to cut blocking from
this PR and ship report/remove/mute/moderator/audit first. Say which you chose in
the PR description; do not ship a checkbox that does nothing.

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

**Message removal decision (state it in the PR):** a moderator "removing" a
message must not violate "a message that was said stays said". Recommended:
**soft-hide via `room_messages.hidden_at` + `hidden_by`** requires an `UPDATE`
grant on those two columns only — a narrow, defensible widening — **or** keep
messages truly immutable and give moderators only member-level actions
(remove/mute). Choose one; the migration must match.

---

### Frontend work

| File | Change |
| --- | --- |
| `components/chat-panel.tsx` | Overflow/report affordance on each message (own messages excluded), owner/moderator-only "Remove" if that option is chosen. Keep the composer untouched. |
| `components/resources/resource-library.tsx` | Report action on room-scoped rows only (reporting your own personal file is meaningless). |
| `components/room-roster.tsx` (PR 07) | Per-member action menu for owner/moderator: **Remove from room**, **Mute 1h/24h/7d**, **Appoint moderator** / **Revoke moderator**. Non-privileged members see read-only rows. |
| `components/moderation-inbox.tsx` (new) | Room-scoped report list: subject type, reason, room, created time, status; action = remove/mute/mark resolved. Owner/moderator only. |
| `components/report-dialog.tsx` (new) | Reason radio group (closed list) + optional detail, `role="alert"` errors, submit → success state. |
| `app/(app)/rooms/[id]/page.tsx` | Mount the inbox behind an owner/moderator-only disclosure. |

Accessibility: every action has a visible label or `aria-label`; destructive
actions confirm; the report dialog is a real dialog with focus trap (Radix
`dropdown-menu` exists — add `dialog`/`alert-dialog` from shadcn if needed, do
not hand-roll).

### Backend work

| Route | Behavior |
| --- | --- |
| `POST /api/rooms/[id]/reports` | Any member. Body `{ subject_type: 'user'\|'message'\|'resource', subject_id: uuid, reason: enum, detail?: ≤500 }`. Validates the subject is actually in that room. → `201 { report: { id, status } }`. Duplicate open report by the same reporter for the same subject → `200` idempotent. |
| `GET /api/rooms/[id]/reports` | Owner/moderator only → `{ reports: [...] }`. |
| `PATCH /api/reports/[reportId]` | Owner/moderator → `{ status }` (`open → resolved`). |
| `POST /api/rooms/[id]/members/[userId]/remove` | Owner/moderator, never self, never the owner. Body `{ reason? }` → `200 { removed: true, member_count }`. |
| `POST /api/rooms/[id]/members/[userId]/mute` | Owner/moderator. Body `{ duration: '1h'\|'24h'\|'7d' }` → `201 { muted_until }`; `DELETE` on the same path lifts. |
| `POST /api/rooms/[id]/members/[userId]/moderator` / `DELETE` | Owner only → `200 { role }`. |
| `POST /api/blocks` / `DELETE /api/blocks` | Body `{ user_id }` → `201`/`200`; `409 self_block`. |
| `GET /api/blocks` | Caller's own blocks only → `{ user_ids: [...] }` (aliases preferred: `{ blocks: [{ alias }] }` — decide and be consistent). |

Existing pattern: identity from session, `requireRoomMembership` for room scope,
strict bodies, one error envelope, `404` indistinguishability for room access.

Privesc checks happen **before** any subject lookup, so a non-moderator cannot
use the endpoint as an existence oracle.

### Database work

`supabase/migrations/0009_moderation.sql`:

- `moderation_reports(id, room_id, subject_type, subject_id, subject_user_id,
  reporter_id, reason, detail, status, created_at, resolved_at, resolved_by)`
  — index on `(room_id, status, created_at desc)`, and a partial unique
  `(reporter_id, subject_type, subject_id) where status = 'open'`.
- `moderation_actions(id, room_id, actor_id, action, subject_user_id,
  subject_ref, reason, created_at)` — append-only: **no UPDATE/DELETE grant**
  (the audit trail must be uneditable by the app).
- `room_moderators(room_id, user_id, granted_by, created_at)` — PK
  `(room_id, user_id)`, `ON DELETE CASCADE`, owner-only insert policy.
- `user_blocks(blocker_id, blocked_id, created_at)` — PK both columns,
  CHECK `blocker_id <> blocked_id`, cascade on auth user delete.
- `room_mutes(room_id, user_id, muted_until, muted_by, created_at)` — partial
  unique one active mute per `(room_id, user_id) where muted_until > now()`.
- Grants (revoke-first, column-scoped):
  - `moderation_reports`: `SELECT` (reporter sees own reports; moderators see
    room's — policy-based, not grant-based), `INSERT` **excluding**
    `reporter_id` (defaults to `auth.uid()`, same trick as `owner_id` in
    `0005`), `UPDATE (status, resolved_at, resolved_by)` for moderators only.
  - `moderation_actions`: `SELECT` (owner/moderator of that room) + `INSERT`
    (excluding `actor_id`? No — keep `actor_id` granted for INSERT but pinned by
    RLS `with check actor_id = auth.uid()`; the *reporter* field is the one that
    must be hidden, the *actor* is the moderator's own identity).
  - `room_moderators`: `SELECT`/`INSERT`/`DELETE` with owner policies.
  - `user_blocks`: `SELECT`/`INSERT`/`DELETE` with `blocker_id = auth.uid()`
    policies only.
  - `room_mutes`: `SELECT`/`INSERT`/`DELETE` with actor-is-owner-or-moderator
    policies.
- RPCs (SECURITY DEFINER, `search_path = ''`, execute revoked from
  `public`/`anon`):
  - `remove_room_member(p_room_id uuid, p_user_id uuid)` — actor must be room
    owner or in `room_moderators`; cannot remove the owner; cannot remove self;
    writes a `moderation_actions` row; returns member count.
  - `mute_room_member(p_room_id, p_user_id, p_interval interval)`,
    `unmute_room_member(...)`.
  - `set_room_moderator(p_room_id, p_user_id, p_on boolean)` — owner only.
  - `room_can_post(p_room_id uuid) returns boolean` (or a `with check` on the
    `room_messages` insert policy) so a mute is enforced at the database, not
    only in the route.
- **`room_messages` insert policy gains a mute clause**:
  `and not exists (select 1 from room_mutes where room_id = … and user_id =
  auth.uid() and muted_until > now())`. This is the one place an existing policy
  is widened (functionally narrowed) — call it out in the PR description and
  update `room-messages.test.ts`.
- **If soft message hiding is chosen:** `grant update (hidden_at, hidden_by)`,
  a policy `using` owner-or-moderator-of-the-room, and a trigger rejecting
  `hidden_at` once set (un-hiding is allowed; arbitrary edits are not).

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
4. Learn who reported them: `reporter_id` has no `SELECT` grant for anyone
   except the reporter's own rows; report listings returned to moderators must
   **omit `reporter_id` entirely** (moderators see subject, reason, detail,
   time). Verify with a response-shape assertion.
5. Read another user's blocks, or block themselves/UUIDs that are not users.
6. Mute the owner or a moderator (policy/`with check`).
7. Edit or delete a `moderation_actions` row (no grant).
8. Evade a mute by inserting into `room_messages` directly through PostgREST
   (RLS `with check` enforces it).
9. Forge a report about a subject in a room they are not in (validate
   membership first, then subject).

Positive guarantees:

- Every privileged mutation writes exactly one `moderation_actions` row, in the
  same transaction as the mutation.
- Report reason is a closed enum; free text is length-bounded and rendered as
  text (never HTML).

### API contracts

Shared envelope. Selected shapes:

```jsonc
// POST /api/rooms/[id]/reports   201
{ "report": { "id": "…", "status": "open", "subject_type": "message",
              "reason": "harassment", "created_at": "…" } }
// GET /api/rooms/[id]/reports    200  (moderator view: NO reporter_id)
{ "reports": [ { "id", "subject_type", "subject_id", "subject_alias",
                 "reason", "detail", "status", "created_at" } ] }
// POST /api/rooms/[id]/members/[userId]/remove   200
{ "removed": true, "member_count": 3 }
// POST /api/rooms/[id]/members/[userId]/mute     201
{ "muted_until": "…", "member_count": 3 }
```

| Error | Code | When |
| --- | --- | --- |
| 400 | `validation` / `invalid_request` | bad body, unknown field |
| 401 | `unauthenticated` | no session |
| 403 | `not_owner` / `not_moderator` / `cannot_moderate_owner` | privesc |
| 404 | `not_found` | room not visible, or subject not in room |
| 409 | `duplicate_report` (idempotent `200` instead — pick one), `already_muted`, `self_block`, `cannot_remove_owner` | state conflicts |
| 429 | `rate_limited` | PR 10 provides the mechanism; leave the mapping documented, do not implement |
| 500 | `report_failed` / `moderation_failed` | hygiene |

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

**Integration (`tests/integration/room-moderation.test.ts`)**

- Report flow: member reports a message → row exists, reporter defaults to
  `auth.uid()`; forging `reporter_id` → permission denied / policy denial.
- Reporter privacy: moderator listing contains no `reporter_id` column at all;
  the reported user's own reads never surface it.
- Unauthorized moderator request → `403` with zero rows touched.
- Remove: owner removes student → membership gone, `member_count` updated,
  `moderation_actions` row present; removing the owner → refused; removing
  across rooms → refused.
- Mute: muted member's `POST /messages` → denied **and** a direct PostgREST
  insert → `42501`; unmute restores; mute cannot target the owner.
- Moderator appointment: owner appoints → appointee can act; non-owner cannot;
  revoked moderator loses access immediately.
- Audit: `moderation_actions` has no UPDATE/DELETE grant (probe), and one row
  per action with `actor_id = auth.uid()`.
- Blocks: `user_blocks` visible only to the blocker; self-block refused; the
  history endpoint filters a blocked user's messages for the blocker.
- Cross-room isolation: actions in room A never appear in room B's inbox.

**E2E (`tests/e2e/moderation.spec.ts`)**

- Owner removes a member; that member's next navigation to the room 404s and
  their chat composer is gone.
- Owner mutes; muted member cannot send (server message surfaced in the UI);
  owner lifts the mute; member can send again.
- Member files a report from a message; owner sees it in the inbox and resolves
  it; the reported member never sees any report UI reference.
- Non-owner sees none of the moderator controls.

### Dependencies

- PR 07 (roster) must merge first.
- **Small cross-PR touch:** the block-check on invite acceptance belongs in
  PR 07's `accept_room_invite`. Implement it as "if PR 07 has merged, add the
  check in this PR's migration as an `update` to that function" — or land the
  check as a follow-up if the sequencing does not allow editing another PR's
  RPC. State the choice.
- Chat (merged).

### Files / modules likely affected

```
supabase/migrations/0009_moderation.sql                  (new)
app/api/rooms/[id]/reports/route.ts                      (new)
app/api/reports/[reportId]/route.ts                      (new)
app/api/rooms/[id]/members/[userId]/{remove,mute,moderator}/route.ts  (new)
app/api/blocks/route.ts                                  (new)
app/api/rooms/[id]/messages/route.ts                     (block filtering on read)
lib/moderation/{queries,types,errors}.ts                 (new)
lib/validation/moderation.ts                             (new)
components/report-dialog.tsx, moderation-inbox.tsx       (new)
components/chat-panel.tsx, room-roster.tsx,
components/resources/resource-library.tsx                (report/reporter affordances)
app/(app)/rooms/[id]/page.tsx                            (inbox mount)
tests/integration/room-moderation.test.ts                (new)
tests/integration/room-messages.test.ts                  (mute clause update)
tests/e2e/moderation.spec.ts                             (new)
docs/SECURITY.md, docs/API_CONTRACTS.md, docs/local-supabase.md, docs/milestones.md
```

### Acceptance criteria

- [ ] Only the owner and appointed moderators can act; every attempt otherwise
      fails with `403` and touches zero rows.
- [ ] The reported user can never learn the reporter's identity through any
      endpoint or payload (asserted as a response-shape test).
- [ ] Removal and mute take effect immediately for the target user, including
      for direct PostgREST writes.
- [ ] Every action produces exactly one immutable `moderation_actions` row.
- [ ] Blocks are private to the blocker and filter that user's messages.
- [ ] Chat remains append-only for normal members; the chosen message-removal
      semantics (soft-hide vs none) match the migration.
- [ ] All three suites + build green locally and in CI.

### Definition of Done

1. `npx supabase db reset` from scratch; every grant/policy probe passes,
   including the negative ones (no `UPDATE` on `moderation_actions`, no
   `reporter_id` in moderator payloads).
2. The "Blocking semantics" and "Message removal" decisions are stated in the PR
   description with their rationale — not left implicit.
3. CI green on all three jobs.
4. `docs/SECURITY.md` gains a moderation section (reporter privacy is the key
   row); `docs/local-supabase.md` tables/grants/RLS updated;
   `docs/milestones.md` "No presence, typing indicators, chat moderation…"
   bullet narrowed to what is still true.
5. Cross-PR block-invite interaction resolved and tested.
6. Reviewed by Dev A.

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
