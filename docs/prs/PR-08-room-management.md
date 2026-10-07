# PR 08 — Room management (edit, open/close, capacity, delete)

**Status:** in review — [PR #8](https://github.com/chanukyareddygopala07/sdyroom/pull/8) (`feat/room-management`).
**Owner:** Dev A (OpenCode) · **Complexity:** Medium · **Migration:** `0008_room_management.sql`
**Depends on:** PR 07 (roster gives the capacity floor a real "current members" to compare against; invitations must cascade on delete)

#### Reconciliation (as implemented)

| Spec said | What shipped | Why |
| --- | --- | --- |
| Column-scoped `grant update (name, shared_goal, exam_track, subject, language, capacity, status)` + `grant delete` on `rooms`, with `rooms_update_own` / `rooms_delete_own` policies | **No grants, no policies on `rooms` at all** — writes only via `update_room` / `delete_room` SECURITY DEFINER RPCs | `tests/integration/membership-and-rls.test.ts` freezes "an owner cannot `update`/`delete` their own room (no grant → `42501`, not zero rows)". Grants would have broken a frozen test that this PR is not allowed to weaken; prompt §7 asks for narrowly scoped RPCs instead. The RPCs deliver the same checks *under the room-row lock*, which RLS never could. Defense in depth is proven by the control test: widening the grant in a rolled-back transaction still yields `update … 0 rows` (RLS, no policy). |
| Delete step 3: read `storage_path`s from `study_resources`, remove with `removeResourceObject` | Route calls `removeRoomStorageObjects`: **storage-first folder sweep** (`list rooms/{id}` → each uploader folder → chunked `remove`) *before* `delete_room` | Same ordering the spec demands, but listing the folder is one authoritative query that cannot miss a row whose insert raced the read, and it works only because of the policy below. |
| Risk table: owner cannot delete a student's object → prefer "unreachable object + `cleanup_failed`" over widening the storage policy | **Widened the storage policy narrowly**: 0008 adds `study_resources_objects_delete_room_owner` — `delete` allowed iff the object key matches a `study_resources.storage_path` row in a room `auth.uid()` **owns** (OR'd with the uploader-only `0005` policy) | The fallback would have made *every* room with member uploads undeletable (`500 cleanup_failed` forever), not just dirty. The new policy grants room owners exactly one new verb on exactly the objects of rooms they already own, proven by the integration test: owner removes member's object → gone; stranger's remove → unchanged; uploader still can. |
| `update_room(p_room_id, …editable fields…)` named parameters | `update_room(p_room_id uuid, p_changes jsonb)` with a fixed whitelist `set` list | One signature carries "absent key = unchanged, `null` = clear" faithfully through PostgREST, and unknown keys are structurally ignored rather than rejected per-parameter. Validation still runs in SQL (status/capacity) as well as in Zod. |
| Capacity floor + ownership under one lock | Implemented exactly so: `select … for update` on the room row, owner from `auth.uid()`, floor check against `room_members`, `capacity_below_membership` envelope with the count | The spec's own justification; live race test asserts the XOR outcome (shrink succeeds ⇒ join gets `room_full`, join succeeds ⇒ shrink gets `409`) and the end-state invariant `capacity ≥ members`. |
| Settings page and routes rely on `owner_id = auth.uid()` row comparison | Owner gate via `requireRoomOwner` (403 member / 404 non-member) *and* the RPC re-proving `auth.uid()`, *and* `getOwnedRoom` (role row) for the page | Same semantics, one extra read-layer gate so the page never renders owner controls to a member — the API refusals are the security, the page refusals are honesty. |
| DoD 4: local-supabase "No UPDATE/DELETE on rooms" note removed | Rewritten to state the RPC-only rule and the probes | Done in `docs/local-supabase.md`. |

Known residual (documented in the route docblock and `docs/API_CONTRACTS.md`):
storage is not transactional with Postgres, so an object whose listing the sweep
already passed but whose row commits before `delete_room` is orphaned —
unreachable in a private bucket, bounded by two adjacent calls.

---

### Problem

Rooms are immutable after creation. `rooms` grants `SELECT` and `INSERT` only —
no `UPDATE`, no `DELETE`, and no policy for either — because nothing in the
product ever needed to change a room. In practice that means a typo in a room
name is permanent, a room that finished its exam week stays `open` forever, a
capacity mistake cannot be fixed, and there is no way to remove a room you
created. `docs/milestones.md` records it as a known gap.

### User story

As a room owner I can rename my room, correct its details, close it when the
cohort is done, adjust capacity to reality, and delete it for good — and none of
that is available to anyone else in the room.

---

### Scope

- **Edit** room `name`, `shared_goal` (the room's description/announcement),
  `exam_track`, `subject`, `language`.
- **Capacity change** with a hard floor: `capacity >= current member count`,
  enforced inside a locked RPC (same `select … for update` discipline as
  `join_room`).
- **Open / close** (`status`), which `join_room` already enforces — closing needs
  no join-side change.
- **Delete room**, owner only, explicit two-step confirmation, deleting
  `room_members`, `focus_sessions`, `study_goals`, `room_messages`,
  `room_invitations`, and `study_resources` rows by cascade **plus their storage
  objects** (the cascade does not reach storage — see Database work).
- Owner-only controls rendered in the workspace header ("Room settings").
- Non-owner members see room details read-only (they already do).

### Out of scope

- **Visibility changes** (`public ⇄ private`). A public→private conversion would
  strand members outside the join path, and private→public would silently expose
  a room's chat and files to discovery. Not justified now; requires its own spec
  (member notification, resource implications).
- **Ownership transfer.** Deferred: with no deactivation story and no audit
  trail yet (PR 09), a transfer that fails halfway is worse than no transfer.
  Record as a follow-up in the PR description.
- Editing anyone else's membership, roles, or kicking members (PR 09).
- Editing `owner_id` (not in the grant; impossible by construction).
- Editing `created_at`/`updated_at` (trigger/server owned).
- Bulk/batch operations, room templates, room archiving as a separate state
  beyond `closed`.
- Editing resources or chat (PR 09 covers moderation of messages).

---

### Frontend work

| File | Change |
| --- | --- |
| `app/(app)/rooms/[id]/page.tsx` | Add an owner-only **Room settings** disclosure (or link to `/rooms/[id]/settings`). Keep the workspace header uncluttered: the timer/chat/goals layout must not shift for non-owners. |
| `app/(app)/rooms/[id]/settings/page.tsx` (new) | Server-gated page (`instant = false`, `redirect` to login, `notFound()` for non-owner) hosting the form. Adds a second navigable URL — give it `loading.tsx` + `error.tsx`. |
| `components/room-settings-form.tsx` (new) | Prefilled fields (name, shared goal, exam track, subject, language, capacity number input, status select). Zod client validation mirroring `lib/validation/rooms.ts` limits; server issues mapped to fields (existing pattern: `room-create-form.tsx`). Saves with `PATCH`; success → `router.refresh()` + `role="status"` confirmation. |
| `components/room-delete-control.tsx` (new) | Danger zone at the bottom: type-the-room-name-to-confirm, then `DELETE`. Never a single-click delete. |
| `components/room-card.tsx` | Show `Closed` badge (a `Badge` already exists) so discovery reflects status without opening the room. |

Mobile: the settings form follows PR 19's layout rules (single column under
`sm:`); no new navigation primitives.

### Backend work

| Route | Behavior |
| --- | --- |
| `PATCH /api/rooms/[id]` | Owner only. Strict body, **partial updates allowed** (Zod `.partial()` over the editable field set; an empty body → `400 invalid_request`, matching the goals `PATCH` rule). Never accepts `owner_id`, `visibility`, `created_at`, `updated_at`, `id`. → `200 { room }` shaped by `toPublicRoom()`. |
| `DELETE /api/rooms/[id]` | Owner only. Sequence below → `200 { deleted: true }`. |
| `POST /api/rooms/[id]/close` and `/open` | **Or** fold into `PATCH { status }` — choose `PATCH` for consistency with edit; the join side needs no change. |

Delete sequence (documented in the route docblock, mirrors the resource
delete pattern):

1. Resolve the room under RLS (`rooms_select_own` gives the owner their private
   and public rooms) → `404 not_found` for everyone else, indistinguishable from
   a missing room.
2. Confirm `owner_id = auth.uid()` from the **row**, never the request.
3. Read the room's `storage_path`s from `study_resources` (member-readable;
   the owner is a member of their own room) and **remove those storage
   objects first** via the existing `removeResourceObject` helper.
4. Delete the room row → cascade removes memberships, sessions, goals, messages,
   invitations and resource rows.
5. If step 4 fails after step 3, answer `500 delete_failed`; a retry converges
   (objects are already gone, which is the safe direction: no file is ever
   advertised by a row that cannot be served — the inverse of the resource
   delete reasoning in `docs/API_CONTRACTS.md`, so **state which direction you
   chose and why** in the docblock: here, orphaned *rows* are impossible because
   the row delete is last and cascades, and orphaned *objects* are unreachable
   because the bucket is private).

Helpers to reuse: `requireRoomMembership` (not sufficient for owner checks —
use `toPublicRoom` + explicit owner comparison), `errorResponse`,
`readJsonBody`, `z.uuid()` params.

### Database work

`supabase/migrations/0008_room_management.sql`:

- Revoke-first, then:
  - `grant update (name, shared_goal, exam_track, subject, language, capacity, status) on public.rooms to authenticated;`
    — deliberately **excluding** `owner_id`, `visibility`, `created_at`,
    `updated_at`, `id`.
  - `grant delete on public.rooms to authenticated;`
- Policies:
  - `rooms_update_own` — `using (owner_id = auth.uid())` and
    `with check (owner_id = auth.uid())`.
  - `rooms_delete_own` — `using (owner_id = auth.uid())`.
- RPCs (SECURITY DEFINER, `set search_path = ''`, execute revoked from
  `public`/`anon`, granted to `authenticated`):
  - `update_room(p_room_id uuid, …editable fields…) returns jsonb` — locks the
    room row, verifies `owner_id = auth.uid()`, applies the capacity floor
    (`new capacity >= (select count(*) from room_members where room_id = …)`)
    else raises the documented `capacity_below_membership` code, applies the
    update, returns the row's public shape. Using an RPC rather than raw
    PostgREST `update` keeps the capacity check and the ownership check in one
    transaction under one lock.
  - `delete_room(p_room_id uuid) returns jsonb` — verifies ownership, deletes
    the row (cascade), returns `{code}`. **Does not touch storage** (a SQL
    function cannot call the Storage API with the caller's rights in a way this
    project is willing to depend on); the route deletes objects first.
- Existing `rooms_set_updated_at` trigger continues to own `updated_at`.
- `join_room` in `0002` is untouched and already rejects `room_closed`.

**Interaction with PR 07:** `room_invitations.room_id … on delete cascade`
already covers invites. Confirm it in an integration test rather than assuming.

### Storage work

Room deletion must remove the room's `study_resources` objects. Two acceptable
implementations — pick one and justify it in the PR:

- **(preferred)** Route-level: read paths, `storage.remove([...])`, then delete
  the row. Simple, uses the existing user-scoped client (the owner is a member,
  so the storage `delete` policy — `owner = auth.uid()` — permits it, because
  every room-scoped object was uploaded by its owner, who is the deleting owner
  only if the *uploader* is the room owner… **verify**: if a student uploaded a
  file into the owner's room, the owner's `storage.objects` delete policy will
  refuse to remove the student's object).
- **(correct fallback for the case above)** Delete the room row first, then
  remove objects for rows already gone — but the metadata is cascaded away, so
  the paths must be read *before* the delete and removal attempted afterwards;
  a refusal by the storage policy leaves an unreachable object in a private
  bucket (safe, but dirty). Surface a `500 cleanup_failed` and log the paths.

**This asymmetry is the single trickiest part of the PR.** Resolve it with an
integration test: student uploads into a shared room → owner deletes the room →
assert *both* the row and the object are gone (or, if policy makes that
impossible, that the object is provably unreachable and the API reported it).

### Realtime work

None. Consider (do not block on it) whether a deleted room should notify open
clients — the existing workspace already handles `404` on the next read, which
is sufficient.

### AI work

None.

---

### Security requirements

A user must **not** be able to:

1. Edit or delete a room they do not own — including a room they are a member
   of, and including a room they once owned (ownership does not transfer).
2. Move `owner_id`, `visibility`, `id`, `created_at` or `updated_at` through any
   path — column grant absent, RPC ignores unknown fields.
3. Set `capacity` below the current membership (seat math must never regress).
4. Re-open a room's membership semantics by editing `status` to `open` if that
   would bypass capacity — `join_room` still checks capacity, so it cannot.
5. Delete a room through direct PostgREST in a way that skips object cleanup —
   accepted (rows are gone, objects unreachable), but the *application* path must
   do the cleanup and the PR must test it.
6. Observe a private room's settings through the public `toPublicRoom()` shape —
   the settings page must `notFound()` for non-members exactly as the workspace
   does.
7. Use `PATCH` as an oracle for room existence: a non-owner must receive the
   same `404` whether the room exists or not.

### API contracts

| Endpoint | Success | Errors |
| --- | --- | --- |
| `PATCH /api/rooms/[id]` | `200 { room: PublicRoom }` | 400 `validation`/`invalid_json`/`invalid_request` (empty body), 401, 403 `not_owner`, 404 `not_found`, 409 `capacity_below_membership`, 500 `room_update_failed` |
| `DELETE /api/rooms/[id]` | `200 { deleted: true }` | 400 `validation`, 401, 403 `not_owner`, 404 `not_found`, 500 `delete_failed`/`cleanup_failed` |

Editable field set (the contract, verbatim):
`name` (1–100, trimmed, no control chars), `shared_goal` (≤500 or null),
`exam_track` (≤80 or null), `subject` (≤80 or null), `language` (≤40 or null),
`capacity` (1–100, ≥ current members), `status` (`open|closed`).

### Tests

**Unit**

- `lib/validation/rooms.ts` — new `updateRoomSchema` (partial, strict, limits).
- `app/api/rooms/[id]/route.ts` — owner gate, unknown-field refusal, empty-body
  `400`, capacity floor mapping, `404` parity for missing vs forbidden, delete
  order (objects removed before row), 500 hygiene.
- `components/room-settings-form.tsx` — prefills, field error mapping,
  capacity below members surfaces the server message, no owner/visibility fields
  in the DOM.
- `components/room-delete-control.tsx` — confirm gate requires the exact name,
  network failure keeps the room, success navigates to `/rooms`.
- `components/room-card.tsx` — `Closed` badge.

**Integration (`tests/integration/room-management.test.ts`)**

- Owner renames; row's `updated_at` moved by the trigger; `owner_id` unchanged.
- Non-owner `PATCH`/`DELETE` → `403`/`404` with zero rows touched.
- Direct PostgREST `update rooms set owner_id = …` → `42501` or permission
  denied (column not granted); `update … set visibility = 'private'` → denied.
- Capacity: raise freely; lower to exactly `count` succeeds; below → `409`,
  capacity unchanged.
- Close → `join_room` returns `room_closed`; reopen → join works again; a
  closed room with members still lists them.
- Delete by owner → `room_members`, `focus_sessions`, `study_goals`,
  `room_messages`, `room_invitations`, `study_resources` counts all 0 for that
  room; storage objects gone (or explicitly asserted unreachable per the
  storage decision).
- Delete cascade of invitations: create invite → delete room → invite row gone.
- Grant probes: `update`/`delete` exist for `authenticated` on `rooms`,
  still zero for `anon`.

**E2E (`tests/e2e/room-management.spec.ts`)**

- Owner edits name and shared goal through the form; member sees the change
  after refresh; non-owner never sees the settings link and gets a 404 on the URL.
- Owner closes the room; a second student cannot join; badge shows `Closed`.
- Owner deletes the room after typing the name; both users land on `/rooms`
  with the room gone from discovery; a member's stale workspace URL 404s.

### Dependencies

- PR 07 (roster + invitation cascade).
- Independent of 06 beyond shared files.

### Files / modules likely affected

```
supabase/migrations/0008_room_management.sql            (new)
app/api/rooms/[id]/route.ts                             (new)
app/(app)/rooms/[id]/settings/page.tsx                  (new) + loading/error
components/room-settings-form.tsx                       (new)
components/room-delete-control.tsx                      (new)
components/room-card.tsx                                (Closed badge)
app/(app)/rooms/[id]/page.tsx                           (settings entry point)
lib/validation/rooms.ts                                 (updateRoomSchema)
lib/rooms/{queries,shape,types}.ts                      (update/delete helpers)
tests/unit/...                                          (new + extended)
tests/integration/room-management.test.ts               (new)
tests/e2e/room-management.spec.ts                       (new)
docs/API_CONTRACTS.md, docs/SECURITY.md, docs/local-supabase.md, docs/milestones.md
```

### Acceptance criteria

- [x] Owner can edit every listed field and nothing else; `visibility` and
      `owner_id` are refused by the column grant, not just by validation.
- [x] Capacity cannot be set below the current member count; the error names the
      constraint.
- [x] Closing a room stops new joins without affecting existing members.
- [x] Deleting removes the room **and** every dependent row, and the storage
      decision from "Storage work" is proven by a test.
- [x] Non-owners get identical `404`s for existing and missing rooms on settings
      and `PATCH`/`DELETE`.
- [x] Discovery shows `Closed`.
- [ ] All three suites + build green locally and in CI. *(locally green: lint, types, 665 unit, build, fresh `db reset` + `db lint`, 215 integration, 29 e2e; CI runs on the PR)*

### Definition of Done

1. [x] `npx supabase db reset` from scratch; grant/policy probes pass, including the
   negative probes (`owner_id` and `visibility` not updatable).
2. [x] The storage-cleanup asymmetry is resolved **with a passing test**, not with a
   comment.
3. [ ] CI green on all three jobs.
4. [x] `docs/API_CONTRACTS.md` gains the two endpoints and the editable-field
   contract; `docs/local-supabase.md` grants/RLS tables updated (the "No
   UPDATE/DELETE on rooms" note is removed and replaced with the real rule);
   `docs/milestones.md` "No room editing or deletion" bullet replaced.
5. [x] Ownership transfer and visibility change recorded as explicit follow-ups
   (either a `docs/prs/` stub or a bullet in `docs/milestones.md`).
6. [ ] Reviewed by Dev B.

### Owner

**Dev A — OpenCode** (full-stack; the DB and storage decisions dominate).

### Estimated complexity

**Medium.** CRUD is routine for this codebase; the capacity floor under lock and
the cross-service (DB cascade ↔ storage) deletion are the only genuinely hard
parts.

### Risks

| Risk | Mitigation |
| --- | --- |
| Owner cannot delete a student's storage object (policy is `owner = auth.uid()` of the *uploader*) | Resolve before merge with the dedicated integration test; if unfixable without widening the storage policy, prefer "unreachable object + reported `cleanup_failed`" over widening. |
| Capacity floor races with a concurrent join | Same `select … for update` on the room row as `join_room` inside the RPC. |
| Deleting a room while a member has it open | Existing `404` handling on next read; no realtime event needed. |
| `PATCH` opens a mass-assignment hole | Strict schema + column grant; test both layers. |
| Scope creep into visibility/transfer | Out of scope sections are explicit; reject additions in review. |
