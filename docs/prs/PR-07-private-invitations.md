# PR 07 — Private room invitations and the member roster

**Status:** specification only — no GitHub PR exists.
**Owner:** Dev B (Cursor) · **Complexity:** Medium–Large · **Migration:** `0007_room_invitations.sql`
**Depends on:** PR 06 (serialized: both edit `app/(app)/rooms/[id]/page.tsx` and `components/chat-panel.tsx`)

---

### Problem

Private rooms are currently unreachable. `join_room` answers `room_not_found` for
any caller who is not already a member, discovery never lists them, and there is
no way to hand somebody a way in. Compounding it, **no one can see who is in a
room**: `room_members` grants `SELECT` with the policy `room_members_select_own`,
so a student's own membership row is the only one they may ever read. The
repository documents both gaps (`docs/milestones.md`, "No member lists, invites
or private-room joining").

### User story

As the owner of a private study room, I can invite specific classmates by link,
see exactly who is in the room, and revoke an invitation I have not used — while
the room stays invisible to everyone I did not invite.

---

### Scope

- **Invitation records**: `room_invitations` with a single-use, hashed, expiring
  bearer token; `pending | accepted | revoked | expired`.
- **Invite lifecycle**: owner creates, invitee accepts or rejects, owner revokes.
  Expiry is derived (`created_at + ttl < now()`), never a background job.
- **Invite link + page**: `/invite/[token]` — a public route that shows a minimal
  room summary to a signed-out visitor (name only, "sign in to accept") and the
  accept/reject controls to a signed-in visitor.
- **Invitation UI in the workspace**: owner-only "Invite" control producing a
  copyable link, a list of that room's pending invitations with revoke, and an
  accepted/declined result state.
- **Member roster**: `GET /api/rooms/[id]/members` returning alias + role +
  `joined_at` for current members, plus a roster list in the workspace (this is
  the missing "who is in this room" and the base PR 09 needs to act on people).
- Room summary for the invite page reads only `name`, `visibility`, `capacity`
  — no member identity leaks to a signed-out visitor.

### Out of scope

- Email delivery. Supabase Auth emails exist for auth flows; **application email
  (invites by email address) is not built** — the link is copied and shared by
  the student (WhatsApp/Telegram is how Indian students actually share links).
  Revisit with PR 11.
- Inviting by email address, phone number, or any contact data — SdyRoom
  deliberately collects neither.
- Private-room *discovery* stays off; accepting an invite never makes the room
  public.
- Transfer of ownership, member removal, kicking (PR 09).
- Per-member permissions beyond `owner | student` (the existing enum).
- Invite to a public room (pointless: `join_room` already works) — the control
  renders for private rooms only.
- Rate limits on invite creation (PR 10 provides the shared mechanism; this PR
  must use the same key naming so 10 can wrap it without touching this code).

---

### Frontend work

| File | Change |
| --- | --- |
| `app/(app)/rooms/[id]/page.tsx` | Render owner-only Invite control + pending-invite list; render roster (members) section. Pass roster into the panel or place it as its own section — keep `ChatPanel`'s participants (PR 06) distinct from the roster (all members vs currently online). |
| `components/room-invite-panel.tsx` (new) | Create link (POST), copy-to-clipboard with an explicit "Copied" state, pending invites with created/expiry and Revoke, accept/decline affordances for the invitee. |
| `components/room-roster.tsx` (new) | Alias + role badge (`Owner`/`Student`) + joined date; `role="list"`; empty state for a solo owner. |
| `app/invite/[token]/page.tsx` (new) | Public page: signed-out → "Sign in to accept" (redirect back to the same token after login, via `?next=`); signed-in → room name, inviter alias, expiry, **Accept** / **Decline**; states for invalid, expired, revoked, already-used, already-a-member. |
| `app/invite/[token]/loading.tsx`, `error.tsx` | Route-level fallbacks, consistent with `app/(app)/rooms/[id]`. |

Accessibility: accept/decline are real `<button>`s inside a form; result status
announced via `role="status"`; copy button has an accessible name (not
icon-only).

### Backend work

| Route | Behavior |
| --- | --- |
| `POST /api/rooms/[id]/invitations` | Owner only. Body `{ ttl_hours?: 1–168 }` (default 168). Returns `{ invitation: { id, token, url, expires_at } }` **once** — the raw token is never readable again. `403 not_owner`, `404 not_found`, `409 room_public` (invites only make sense for private rooms), `429` later via PR 10. |
| `GET /api/rooms/[id]/invitations` | Owner only. Pending + recently resolved invites **without raw tokens**: `{ id, created_at, expires_at, status, inviter_alias }`. |
| `DELETE /api/rooms/[id]/invitations/[invitationId]` | Owner only → `{ revoked: true }`. Idempotent: revoking an already-accepted invite is `404` (it is gone as an invitation). |
| `POST /api/invitations/accept` | Body `{ token }`. Requires session. → `201 { membership, room_id, room_name }` or `200 already_member`. Errors: `400 validation`, `401 unauthenticated`, `404 not_found` (unknown token), `410 expired`, `409 revoked` / `used` / `rejected`. |
| `POST /api/invitations/reject` | Body `{ token }` → `200 { rejected: true }`; same 404/410/409 set. |
| `GET /api/rooms/[id]/members` | Member only (existing `requireRoomMembership`). → `{ members: [{ alias, role, joined_at }], count }`. No user ids, no emails. |
| `GET /api/invitations/[token]` (or the page reads it server-side) | Minimal summary: `{ room_name, inviter_alias, expires_at, status }`; **`404` for a token that does not exist**, `410` for expired. A signed-out caller may call this (it is how the public invite page renders) — it must reveal only those three fields. |

Existing helpers to reuse: `requireRoomMembership`, `errorResponse` /
`validationResponse`, `readJsonBody`, `z.uuid()` route-param validation, the
`404` indistinguishability rule.

### Database work

`supabase/migrations/0007_room_invitations.sql`:

- `room_invitations`:
  - `id uuid pk`, `room_id uuid not null references rooms on delete cascade`,
    `inviter_id uuid not null references auth.users on delete cascade`,
    `token_hash text not null unique`, `status text not null default 'pending'`
    check in (`pending`,`accepted`,`revoked`,`rejected`),
    `expires_at timestamptz not null`, `created_at timestamptz default now()`,
    `resolved_at timestamptz`.
  - Partial index: `create unique index room_invitations_one_pending
    on room_invitations (room_id, token_hash) where status = 'pending';`
    (belt-and-braces beside `token_hash` unique).
- **Grants** (revoke-first, same shape as `0003`–`0005`): `authenticated`
  `SELECT (id, room_id, inviter_id, status, expires_at, created_at, resolved_at)`,
  `INSERT (id, room_id, inviter_id, token_hash, expires_at)` — **no `token_hash`
  in SELECT**, so a listing can never leak a usable token; `UPDATE (status,
  resolved_at)`; `DELETE`.
- **RLS**:
  - `room_invitations_select_owner`: `inviter_id = auth.uid()` (invitations are
    the inviter's; the room owner also sees them — pick one rule and state it:
    **`inviter_id = auth.uid() or exists (owner of room)`** so a future owner can
    clean up. Simpler and stricter: `inviter_id = auth.uid()`, and only the
    creator can list/revoke their own invites. Recommend the strict rule.)
  - `room_invitations_insert_owner`: `inviter_id = auth.uid()` **and**
    `exists (select 1 from room_members where room_id = … and user_id =
    auth.uid() and role = 'owner')` **and** the room is `visibility = 'private'`.
  - `room_invitations_update_own` / `delete_own`: `inviter_id = auth.uid()`.
  - **No policy for the invitee**: an invitee never reads or writes the row
    directly — acceptance goes through an RPC so the `token_hash` and the
    `status` transition stay server-side.
- **RPC `accept_room_invite(p_token text) returns jsonb`** — `SECURITY DEFINER`,
  `set search_path = ''`, execute revoked from `public`/`anon`, granted to
  `authenticated` only. Logic: hash the presented token in SQL (`encode(digest(p_token,'sha256'),'hex')`),
  look up `pending` row with `expires_at > now()`, lock it
  (`select … for update`), flip to `accepted`, insert `room_members(role='student')`
  idempotently (if a membership already exists → return `already_member`), return
  `{code, room_id, room_name, member_count}`. **Never accept a user id** —
  `auth.uid()` only. Race: two concurrent accepts of the same token — the row
  lock makes the second see `accepted` → `used`.
- **RPC `reject_room_invite(p_token text)`** — same shape, sets `rejected`.
- **Roster**: no new grant needed if `GET …/members` uses a new
  `SECURITY DEFINER` function `room_roster(p_room_id uuid)` (member-only check
  inside), **or** add a column-scoped `SELECT` policy on `room_members` limited to
  rows of rooms the caller is in. **Choose the RPC**: adding a broader
  `room_members` SELECT policy weakens a property the integration suite currently
  asserts ("memberships private to the caller"). Note that this deliberately
  *changes* that assertion — update `membership-and-rls.test.ts` explicitly and
  say so in the PR description.
- No change to `rooms`, `join_room` or `leave_room`.

### Storage work

None.

### Realtime work

None required. Optional (do not block on it): a `room_members` insert event is
not in the publication and must not be added here — the roster refreshes on
`router.refresh()` after accept/leave.

### AI work

None.

---

### Security requirements

A user must **not** be able to:

1. Enter a private room by knowing, guessing or enumerating its room id —
   possessing `room_id` grants nothing.
2. Accept an invitation that is expired, revoked, rejected, or already used.
3. Accept somebody else's invitation *on their behalf* — acceptance binds to
   `auth.uid()`, and the token is the only credential (bearer: whoever holds it
   while signed in may accept once; see "accepted risks").
4. Create an invitation for a room they do not own, or for a public room.
5. Read a `token_hash` (no `SELECT` grant on that column), reconstruct the raw
   token from a listing, or list another user's invitations.
6. Distinguish "this token never existed" from "this token was revoked" **more
   finely than the contract says**: unknown → `404 not_found`; expired → `410`;
   revoked/rejected/used → `409`. Do not add a `room_not_found`-style oracle for
   the room itself.
7. Learn a private room's name, member list or existence from a signed-out
   probe of anything other than a valid invite token.
8. Persist invitation contents in logs: log the invitation **id** and room id,
   never the token or its hash.

Accepted risks (state them in the PR):

- A bearer link forwarded to a third party lets that third party in **once**,
  before the intended recipient. Mitigation: short default TTL, owner-visible
  pending list with revoke, and (optional stretch) an `invitee_alias` binding
  field that, when set, requires the accepting user's alias to match.
- The roster discloses study aliases and join dates to fellow members. That is
  the feature; it exposes nothing else, and it is room-scoped.

### API contracts

Shared error envelope as always: `{ error: { code, message, issues? } }`.

| Endpoint | Success | Errors |
| --- | --- | --- |
| `POST /api/rooms/[id]/invitations` | `201 { invitation: { id, token, url, expires_at } }` | 400 `validation`/`invalid_json`, 401, 403 `not_owner`, 404 `not_found`, 409 `room_public`, 500 `invitation_create_failed` |
| `GET /api/rooms/[id]/invitations` | `200 { invitations: [{ id, status, created_at, expires_at, inviter_alias }] }` | 401, 403 `not_owner`, 404, 500 `invitations_failed` |
| `DELETE /api/rooms/[id]/invitations/[invitationId]` | `200 { revoked: true }` | 400, 401, 403, 404, 500 `invitation_revoke_failed` |
| `GET /api/invitations/[token]` | `200 { room_name, inviter_alias, expires_at, status }` | 400 `validation`, 404 `not_found`, 410 `expired` |
| `POST /api/invitations/accept` | `201 { membership, room_id, room_name, member_count }` / `200 { membership: "already_member", … }` | 400, 401, 404, 409 `used`\|`revoked`\|`rejected`, 410 `expired`, 500 `invitation_accept_failed` |
| `POST /api/invitations/reject` | `200 { rejected: true }` | 400, 401, 404, 409, 410, 500 `invitation_reject_failed` |
| `GET /api/rooms/[id]/members` | `200 { members: [{ alias, role, joined_at }], count }` | 400, 401, 404 `not_found`, 500 `members_failed` |

Bodies are strict (`.strict()` / unknown-field rejection) — consistent with the
rest of the API.

### Tests

**Unit**

- Validators: token shape, `ttl_hours` bounds, unknown-field rejection.
- `app/api/rooms/[id]/invitations/route.ts` + `[invitationId]` — owner gate,
  public-room refusal, no `token_hash` in any listing response, 401/400/500 map.
- `app/api/invitations/accept|reject/route.ts` — status map, `auth.uid()` passed
  and no user id accepted from the body.
- `app/api/rooms/[id]/members/route.ts` — non-member `404`, payload contains
  alias/role/joined_at and **no user id or email**.
- Components: `room-invite-panel` (create → copy → revoke → confirm),
  `room-roster` (owner badge, empty state), invite page states
  (signed-out/valid/expired/revoked/used/already-member).

**Integration (`tests/integration/room-invitations.test.ts`)**

- Owner creates; raw token readable **once**, `token_hash` never selectable.
- Invitee accepts → `room_members` row with `role='student'`, `member_count`
  incremented, invite now `accepted`.
- Repeat accept → `409 used`. Concurrent accept race (two parallel requests) →
  exactly one `201`.
- Expired invite → `410`. Revoked invite → `409`. Rejected then re-accepted → `409`.
- Non-owner creating an invite → `403` (and a direct `insert` → `42501`).
- Direct `select token_hash` → permission denied (column grant absent).
- Roster: member sees all members; non-member `404`; **update
  `membership-and-rls.test.ts`** for the deliberately changed roster visibility
  rule and re-run it.
- Private room still absent from `GET /api/rooms` after an accept.

**E2E (`tests/e2e/invitations.spec.ts`)**

- Owner creates a link in the workspace; second context opens it signed-out →
  sign-in prompt → signs in → accepts → lands in the workspace.
- Decline path leaves no membership.
- Non-invitee (no link) still gets the indistinguishable 404 for that room.
- Owner revokes; a fresh browser with the revoked link is refused.
- Roster shows both members with correct roles.

### Dependencies

- PR 06 must merge first (file overlap, not logic).
- Uses `join_room`-equivalent semantics; must not change `join_room`.

### Files / modules likely affected

```
supabase/migrations/0007_room_invitations.sql            (new)
app/api/rooms/[id]/invitations/route.ts                  (new)
app/api/rooms/[id]/invitations/[invitationId]/route.ts   (new)
app/api/invitations/accept/route.ts                      (new)
app/api/invitations/reject/route.ts                      (new)
app/api/invitations/[token]/route.ts                     (new)
app/api/rooms/[id]/members/route.ts                      (new)
app/invite/[token]/page.tsx                              (new) + loading/error
app/(app)/rooms/[id]/page.tsx                            (invite + roster mounts)
components/room-invite-panel.tsx                         (new)
components/room-roster.tsx                               (new)
lib/validation/invitations.ts                            (new)
lib/invitations/{queries,types,errors}.ts                (new)
tests/unit/app/api/invitations-*.test.ts                 (new)
tests/integration/room-invitations.test.ts               (new)
tests/e2e/invitations.spec.ts                            (new)
tests/integration/membership-and-rls.test.ts             (updated roster assertion)
docs/API_CONTRACTS.md, docs/SECURITY.md, docs/local-supabase.md, docs/milestones.md
```

### Acceptance criteria

- [ ] A private room's owner can produce a link, and a signed-in recipient with
      that link becomes a `student` member.
- [ ] The same link, expired or revoked, does not work; the same link used twice
      does not work.
- [ ] A signed-out visitor with a valid link sees only room name + inviter alias.
- [ ] A signed-in user without a link still gets an indistinguishable `404` for
      the private room.
- [ ] `token_hash` is not selectable by any application role; no listing response
      contains a usable token after creation.
- [ ] `GET …/members` works for members, `404`s for non-members, and returns
      alias/role/joined_at only.
- [ ] Direct PostgREST insert of an invitation by a non-owner → `42501`.
- [ ] All three suites + build green locally and in CI.

### Definition of Done

1. `npx supabase db reset` from scratch applies `0007` cleanly; grants/policy
   probes pass (`token_hash` unselectable, non-owner insert denied).
2. Unit, integration and e2e suites green in CI (all three jobs).
3. `docs/API_CONTRACTS.md` gains the invitation + roster sections;
   `docs/SECURITY.md` gains invite threat-model rows (including the bearer-link
   accepted risk); `docs/local-supabase.md` gains table/grants/policy rows.
4. `docs/milestones.md` updated (row + the "No member lists, invites" bullet
   removed and replaced by what is now true).
5. The roster visibility change is called out explicitly in the PR description
   with the updated integration assertion.
6. Reviewed by Dev A.

### Owner

**Dev B — Cursor** (backend/security-leaning; ~65% backend+DB, 35% UI).

### Estimated complexity

**Medium–Large.** The mechanics are familiar (the repo has the RPC, RLS and
route patterns), but there are seven endpoints, two RPCs and a deliberate
test-expectation change.

### Risks

| Risk | Mitigation |
| --- | --- |
| Roster broadens `room_members` visibility, weakening an existing guarantee | Implement as a membership-checked RPC instead of a wide SELECT policy; if a policy is chosen instead, update and re-justify `membership-and-rls.test.ts` in the same PR. |
| Bearer token leakage through logs, referrer headers or the URL itself | Never log tokens; the invite page sets `referrer-policy` friendly markup (no token in `href` of outbound links); token appears only in the address bar of `/invite/{token}`. |
| Two accepts racing | `select … for update` on the invitation row inside the RPC. |
| Owner invites, then leaves the room | Invitation rows cascade with `rooms`; if the *inviter* leaves but the room survives, the invite still works (the room's owner may want to revoke it — allowed only if the owner rule permits; state the rule in the migration header). |
| Scope creep into email delivery | Explicitly out of scope; the invite panel says "share this link". |
