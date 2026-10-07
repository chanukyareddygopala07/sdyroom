# PR 06 — Realtime room presence

**Status:** merged — [PR #6](https://github.com/chanukyareddygopala07/sdyroom/pull/6),
merge commit `91d2bed`. All suites and the build were green before the merge
(`lint`, `tsc`, 544 unit, 156 integration, 22 e2e, `build`, `db lint`);
`docs/milestones.md` row flipped to `done` with the merge commit, per DoD 4.
**Owner:** Dev A (OpenCode) · **Complexity:** Medium · **Migration:** `0006_realtime_private_channels.sql`
**Depends on:** merged `main` (PR 01–05)

---

### Problem

A student who opens a study room has no idea whether anyone else is there. The
"study together" premise of SdyRoom has no accountability signal: the focus timer
shows a session, chat shows messages, but neither shows *who is present right
now*. The UI for this already exists and is deliberately hidden — `ChatPanel`
accepts a `participants?: ChatParticipant[]` prop and renders a Participants
section only when it is given one (`components/chat-panel.tsx:149`), and
`room-chat.tsx:40` documents that presence is "deliberately not wired". What is
missing is the contract and the transport, not the pixels.

### User story

As a student who opened a room, I can see which other members are currently in
the room and which of them are actively in a focus session, so I feel like I am
studying *with* people rather than next to an empty page.

---

### Scope

- A **private Realtime presence channel per room**, joined on workspace mount,
  `private: true`, authorized by a `realtime.messages` RLS policy that requires
  current `room_members` membership for the room in the topic.
- Presence payload carries **alias only** plus a `studying: boolean` flag derived
  from an already-readable signal (the viewer may read `focus_sessions` rows for
  rooms they are in — `focus_sessions_select_member` — so `studying` is
  `exists a running/paused session started by that member`).
- **Online/offline**, **studying/away**, and a **participant count**.
- **Stale cleanup**: rely on Supabase Realtime's presence leave-on-disconnect,
  plus a client-side heartbeat re-`track()` every 60 s so a half-open socket does
  not leave a ghost.
- **Reconnect behavior**: rejoin restores full state from the server's presence
  state; the badge must never show a count it has not observed.
- **Wire the existing prop**: extend `ChatParticipant` and pass `participants`
  from `room-chat.tsx`, turning the hidden section on.
- **Participant count in the header** of the chat panel, and a compact alias list.
- **Mobile participant drawer**: a disclosure panel that lists participants on
  narrow viewports. *If PR 19 has not merged yet, ship the inline wrapping list
  only and leave the drawer as a follow-up note in the PR description* — do not
  invent a second navigation system.

### Out of scope

- Member roster / "everyone who belongs to this room" — PR 07.
- Typing indicators, read receipts, "who is viewing this PDF".
- Persisting presence anywhere: **no table, no history, no timestamps of who was
  online when.** Presence is ephemeral by design.
- Any profile data beyond the alias — no email, no avatar, no exam targets, no
  member counts for rooms the caller is not in.
- Push notifications of presence (PR 11).
- Presence for the landing or discovery pages.

---

### Frontend work

| File | Change |
| --- | --- |
| `lib/chat/types.ts` | Extend `ChatParticipant` from `{ alias }` to `{ alias: string; studying: boolean }`; update the header comment ("proposal" → contract). Keep the type in `lib/chat/` — presence is a chat-channel concern, not a new domain. |
| `components/room-chat.tsx` | Own the presence channel alongside the existing `room-messages-${roomId}` channel (separate channel, so a messages-channel error does not blank the roster). Maintain `participants` state; sort own alias first, then case-insensitive; `setAuth()` **before** `subscribe()` (the repo's established rule — see `tests/e2e/README.md` "Auth before join"). Pass `participants` to `ChatPanel`. |
| `components/chat-panel.tsx` | Render the already-written section; add the count ("3 studying · 5 here"); mark up as `<ul aria-label="Participants">` (exists) and give the count `role="status"` so screen readers announce joins without stealing focus. |
| Mobile | Inline wrapping list below `sm:`; disclosure/drawer only if PR 19 landed. |

State rules:

- `participants` is `undefined` until the first presence join reply arrives, so
  the section stays hidden rather than flashing "Nobody here but you".
- On `CHANNEL_ERROR`/`TIMED_OUT`, keep the last observed list and let the
  existing connection badge carry the truth — do not fabricate "0 online".
- The viewer's own alias is always present in their own list.

### Backend work

No REST endpoint. Presence is ephemeral; a `GET` snapshot would be stale by the
time it rendered, and the workspace page already server-renders everything else.
The only server-side change is the authorization policy in the migration.

If a count must exist before the socket connects, render "…" (not `0`) in the
server-rendered shell.

### Database work

`supabase/migrations/0006_realtime_private_channels.sql`:

- Add RLS policies on `realtime.messages` granting `authenticated` **send/Read**
  only for topics of the shape `room-presence:{uuid}` where the caller holds a
  `room_members` row for that uuid (use the same `exists (select 1 from
  room_members …)` shape as the existing policies, matching the topic by
  parsing the uuid out of the topic string without casting attacker input —
  compare text to `room_id::text` like `0005` does).
- No new application table. No new grant on any existing table.
- **Risk:** the exact policy surface Supabase Realtime enforces for private
  channels (which roles/columns on `realtime.messages`, and whether the check is
  per-topic) must be verified against the pinned CLI during implementation. If
  private channels cannot be policy-gated on this CLI version, the fallback is
  to gate on `room_members` membership for **postgres_changes** and accept that
  presence is authenticated-but-not-room-scoped — **that fallback is not
  acceptable for private rooms**; escalate to a design review instead.

### Storage work

None.

### Realtime work

- Second channel `room-presence-{roomId}` (or one channel carrying both
  postgres_changes and presence — prefer **separate**, because their failure
  modes and reconnect costs differ and the existing badge semantics assume one
  topic per concern).
- `channel.track({ alias, studying })` after join ack; `untrack()` on unmount.
- `channel.on('presence', { event: 'sync' }, …)` → read
  `channel.presenceState()` and map to `ChatParticipant[]`.
- `postgres_changes` on `focus_sessions` (already subscribed by `focus-timer`)
  drives the `studying` flag — reuse that subscription rather than opening a
  third one; or derive `studying` from the presence payload of each member if
  the member tracks it themselves. **Choose: each client tracks its own
  `studying` state** (it knows its own session state from `focus-timer`), which
  avoids every client querying every other member's sessions.

### AI work

None.

---

### Security requirements

A user must **not** be able to:

1. Join the presence channel for a room they are not a current member of —
   including private rooms, where the room id itself must not be confirmable
   (a non-member join attempt must fail indistinguishably from a nonexistent room).
2. Observe that a private room exists by probing presence topics.
3. Learn anything but the **alias** — no user id, email, phone number, exam
   targets, or membership rows for other rooms.
4. Spoof another member's alias in presence (the payload is client-supplied, so
   the UI must treat presence aliases as *untrusted display data* — never as
   `is_own` or as authorization).
5. Impose storage or database cost: presence writes **no rows**; a malicious
   client re-tracking in a loop must be bounded by Realtime's own limits, and
   the client must not retry-track faster than once per heartbeat.

Positive guarantees:

- Presence disappears when the socket drops (no persistence to clean up).
- Public-room presence does not expose private-room members: topics are
  per-room, never global.

### API contracts

None (no new REST endpoint). Internal client contract:

```ts
type ChatParticipant = { alias: string; studying: boolean };
// ChatPanel props: participants?: ChatParticipant[]   // undefined = not yet observed
```

Channel: `room-presence-{roomId}` (private), payload
`{ alias: string, studying: boolean }`.

### Tests

**Unit (`npm test`)**

- `tests/unit/components/chat-panel.test.tsx` — extend the existing
  "keeps participant presence hidden" case into: hidden while `undefined`,
  renders aliases, marks studying members, shows count, own alias first,
  empty-state copy, `role="status"` on the count.
- `tests/unit/components/room-chat.test.tsx` — presence channel is joined only
  after `setAuth()`; participants survive a messages-channel error; participants
  reset on room change; `untrack` on unmount; no presence channel when signed
  out.

**Integration (`npm run test:integration`)**

- SQL-level probe of the new `realtime.messages` policy: a member of room X can
  read/send for topic `room-presence-{X}`; a non-member and an `anon` role are
  refused; a member of room X is refused for topic `room-presence-{Y}`. Assert by
  `psql` against the local container (the repo's established pattern for policy
  proofs) — do not attempt to drive the realtime server from this suite.

**E2E (`npm run test:e2e`)**

- Two browser contexts in the same room see each other's aliases within a bound.
- Closing one context removes it from the other's list (stale cleanup).
- Reopening restores it (reconnect).
- A non-member navigating to the room URL gets the existing indistinguishable
  404 and never joins presence.
- Private-room presence: a member of a private room sees members; a signed-in
  non-member sees nothing (no count, no aliases).
- `studying` flips when the owner starts a focus session and clears when it ends.

Reuse `tests/e2e/helpers/realtime.ts` (`captureRealtime`) so presence assertions
are frame-based rather than timing-based, per `tests/e2e/README.md`.

### Dependencies

- Merged `main`. Realtime foundation from milestone H (`setAuth` before
  subscribe, `wait: true` registration) is assumed.
- PR 19 for the mobile drawer (optional — see Scope).
- No dependency on 07; 07 depends on this.

### Files / modules likely affected

```
supabase/migrations/0006_realtime_private_channels.sql   (new)
lib/chat/types.ts
components/room-chat.tsx
components/chat-panel.tsx
tests/unit/components/room-chat.test.tsx
tests/unit/components/chat-panel.test.tsx
tests/integration/presence-policies.test.ts              (new)
tests/e2e/presence.spec.ts                               (new)
tests/e2e/helpers/realtime.ts                            (extended)
docs/local-supabase.md                                   (policy table row)
docs/milestones.md                                       (row + task breakdown)
```

### Acceptance criteria

- [x] A signed-in member opening the workspace sees other current members' aliases
      within 5 s of both clients loading.
- [x] `studying` is true exactly while **the room** has a running or paused focus
      session, and clears on end/expiry — room-scoped rather than per-member; see
      *Implementation reconciliation* below.
- [x] Killing one browser removes that member from the other's list within 15 s.
- [x] Reloading restores an identical list (no duplicates, no ghosts).
- [x] A non-member never joins and cannot distinguish a private room from a
      missing one.
- [x] No response, payload, or log contains a user id, email or phone number.
- [x] No table is created; `supabase_realtime` publication membership is unchanged
      (`focus_sessions`, `room_messages` only).
- [x] `ChatPanel`'s participants section renders in the real app (the existing
      "hidden" unit test is replaced, not deleted).
- [ ] lint 0, tsc 0, `npm test` green, `npm run test:integration` green,
      `npm run test:e2e` green, `npm run build` green — all green locally; the
      CI run on the PR is the remaining tick.

### Implementation reconciliation: `studying` is room-scoped

The original criterion asked for per-member truth ("*that member* has a running or
paused focus session"). The schema cannot express that and this PR does not fake it:
`focus_sessions` (0003) records **no starter column** — one active row per room,
owner-only control — so no client can attribute a session to the member who started
it. Presence therefore reports the room's shared session: `studying = true` for
every tracked member exactly while a running or paused session exists. This matches
what the `focus-timer` UI already shows every member. Per-member truth would need a
schema change (`started_by` on `focus_sessions`), which the "no new table, no new
grant" scope excludes — filed as a follow-up question in the PR, not smuggled in.

### Definition of Done

1. Migration applied from scratch by `npx supabase db reset` on a clean stack,
   and the policy probes above pass against the live local DB.
2. The three suites and the build are green locally **and** in CI (all three
   jobs).
3. `docs/SECURITY.md` gains a "Presence" row in the controls table stating
   exactly what presence discloses; `docs/local-supabase.md` gains the new
   policy row.
4. `docs/milestones.md` row added with the merge commit, state `done`.
5. No scope drift: if a presence table, a roster endpoint or an invite flow
   appeared, it is removed and filed as a separate spec.
6. Reviewed by Dev B.

### Owner

**Dev A — OpenCode** (full-stack; the PR is ~70% realtime/frontend, 30% policy).

### Estimated complexity

**Medium.** Small surface, but the private-channel authorization is the part that
can surprise you — budget the migration verification before writing UI.

### Risks

| Risk | Mitigation |
| --- | --- |
| Private-channel RLS behaves differently on the pinned CLI than assumed | Verify with a 10-line `psql` probe **before** building UI; the migration is first in the PR. |
| Ghost participants from half-open sockets | 60 s heartbeat re-track + presence `leave` handling; assert in e2e. |
| Two channels doubling reconnect cost | Separate channels, both `wait: true`; the badges already handle independent states. |
| `studying` derivable from client state goes stale | Derive from `focus-timer`'s own state (source of truth for *this* client) and let other clients observe it; expiry is persisted by the server on next read, so a stale `studying` self-corrects on the next focus event. |
| Conflict with PR 07 editing the same files | Serialized: 06 merges first. |
