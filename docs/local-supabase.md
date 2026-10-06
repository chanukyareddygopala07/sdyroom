# Local Supabase (database foundation)

Everything here targets the **local** stack only. Nothing in this repo links to a
production Supabase project, and no migration is ever pushed to a remote database.

## Commands

Always go through the pinned CLI (`supabase@2.119.0`, declared in `devDependencies`)
so every teammate runs the same version:

```bash
npx supabase init            # creates supabase/config.toml (done; does not overwrite)
npx supabase start           # starts the local stack
npx supabase status          # or: npx supabase status -o env
npx supabase db lint --local # SQL lint over supabase/migrations
npx supabase db reset        # recreate the local DB from migrations (+ seed)
npx supabase migration list --local
npx supabase stop            # stop the stack (never `docker system prune`)
```

## Ports and isolation

| Service | Host port | Notes |
| --- | --- | --- |
| API (Kong) | 54321 | REST/GraphQL/Auth/Storage endpoint |
| **Postgres** | **54322** | `supabase_db_sdyroom`, container-internal port 5432 |
| Studio | 54323 | no auth in local mode |
| SMTP catcher | 54324 | local email inbox |
| Analytics | 54327 | |
| Edge runtime inspector | 8083 | |
| Shadow DB | 54320 | used by `db diff` |

The **Homebrew PostgreSQL on host port 5432 is a different server** and is never
touched: all psql invocations are guarded to refuse any target other than 127.0.0.1:54322.
Port 8000 is held by an unrelated container and 5000 by macOS ControlCenter; neither is
used by this stack (Storage is served through Kong on 54321).

## Environment variables

`.env.local` is populated from `npx supabase status -o env` and holds only the two
public, browser-safe values the app reads:

```
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<local publishable key>
```

- `.env.local` is ignored by git (`.gitignore` → `.env*.local`); never commit it.
- `.env.example` keeps placeholders only.
- `SECRET_KEY` / `SERVICE_ROLE_KEY` are **never** put in a `NEXT_PUBLIC_` variable,
  never in docs, logs, or reports. The app does not use them at all today.

## Email confirmation

`supabase/config.toml` sets `[auth.email] enable_confirmations = false` **for local
development only**, so signups are auto-confirmed against the local SMTP catcher on
:54324 and no manual click is needed.

**Production requirement:** set `enable_confirmations = true` and configure
`[auth.email.smtp]` with a real provider before any public launch. Email confirmation
must not be disabled outside local development.

## Schema

`supabase/migrations/0001_init.sql` creates three tables, all with RLS enabled.
`supabase/migrations/0002_room_membership.sql` adds only functions — `join_room`,
`leave_room` and `public_room_member_counts` — and changes no table, grant or policy.
`supabase/migrations/0003_focus_sessions_and_goals.sql` adds the shared focus timer
and personal goals: two tables, five RPCs, a trigger and the realtime publication.

| Table | Key columns | Notes |
| --- | --- | --- |
| `profiles` | `id` → `auth.users`, `alias`, `exam_targets`, `created_at` | No email, no auth metadata, no other PII. `alias` 1–32 chars, trimmed, unique on `lower(alias)` (case-insensitive, no `citext`). `exam_targets` is a `jsonb` array, default `'[]'`. |
| `rooms` | `id`, `owner_id` → `auth.users`, `visibility`, `name`, `capacity`, `exam_track`, `subject`, `language`, `status`, `shared_goal`, `created_at`, `updated_at` | `visibility` ∈ `public`/`private`; `status` ∈ `open`/`closed` (default `open`); `capacity` 1–100 (default 4); name 1–100 chars trimmed. Partial index on public rooms by `created_at desc`. |
| `room_members` | PK `(room_id, user_id)`, `role`, `joined_at` | `role` ∈ `owner`/`student` (default `student`). `room_id` and `user_id` both `ON DELETE CASCADE`. Index on `user_id`. |
| `focus_sessions` | `id`, `room_id` → `rooms`, `state`, `duration_seconds`, `started_at`, `ends_at`, `paused_at`, `paused_seconds`, `ended_at` | `state` ∈ `running`/`paused`/`completed`/`expired`. Partial unique index `focus_sessions_one_active (room_id) where state in ('running','paused')` — at most one active session per room, concurrency-safe. CHECKs pair `paused ⇔ paused_at` and `terminal ⇔ ended_at`, and require `ends_at > started_at`. Selected by `authenticated` only; every write goes through the RPCs. |
| `study_goals` | `id`, `user_id` → `auth.users`, `room_id` → `rooms`, `title`, `target_seconds`, `target_count`, `status`, `completed_at`, `created_at`, `updated_at` | Personal rows: `status` ∈ `active`/`completed`, `completed_at` set and cleared by the `study_goals_touch` trigger (never accepted from a client), CHECK `(status = 'completed') = (completed_at is not null)`. Partial unique index on `(user_id, room_id, lower(title)) where status = 'active'` — one active goal per title, reusable once completed. `user_id`/`room_id` cascade on delete. |

No sample rooms and no fabricated auth users are inserted by SQL: `supabase/seed.sql`
is intentionally empty, and local test data is made only through the Auth API and the
`create_room` / `join_room` RPCs.

`focus_sessions` is added to the `supabase_realtime` publication, so members' clients
receive `postgres_changes` events for their room's session and re-read the workspace;
`study_goals` is deliberately not published (goals refetch, they are never pushed).

## Grants

Grants are explicit and column-aware (`auto_expose_new_tables = false` in
`config.toml`, so new tables receive no default API-role grants):

| Grantee | `profiles` | `rooms` | `room_members` | `focus_sessions` | `study_goals` |
| --- | --- | --- | --- | --- | --- |
| `anon` | none | none | none | none | none |
| `authenticated` | `SELECT/INSERT` on `(id, alias, exam_targets, created_at)`, `UPDATE` on `(alias, exam_targets)` | `SELECT`, `INSERT` | `SELECT`, `INSERT` | `SELECT` | `SELECT`, `INSERT`, `DELETE`, `UPDATE (title, target_seconds, target_count, status)` |
| `service_role` | no data privileges | no data privileges | no data privileges | no data privileges | no data privileges |

**No `UPDATE` or `DELETE` on `rooms` / `room_members`** — those flows are deliberately
undeveloped. `authenticated` has no table-level `SELECT` on `profiles` by design: only
the approved columns are granted, so application queries must list columns explicitly
(`select id, alias, ...`); never rely on `SELECT *` for profile responses. When a new
column is added to `profiles`, grant it only after it is approved.

The same shape repeats in `0003`: `focus_sessions` is **read-only** for clients (a
direct `INSERT`/`UPDATE` cannot start a session or rewind a deadline — only the
`SECURITY DEFINER` RPCs write), and `study_goals` gets a **column-scoped** `UPDATE`,
so `user_id`, `room_id`, `completed_at`, `created_at` and `updated_at` are not
addressable at all. The stack also defines a default ACL that would give these roles
`TRUNCATE`/`REFERENCES`/`TRIGGER`/`MAINTAIN` on new public tables, so `0003` starts by
revoking everything from `anon`, `authenticated` and `service_role` before granting.

## Row Level Security

| Table | Policy | Effect |
| --- | --- | --- |
| `profiles` | `profiles_select_own` / `insert_own` / `update_own` | `id = auth.uid()` only |
| `rooms` | `rooms_select_public` | authenticated users read `public` rooms |
| `rooms` | `rooms_select_own` | owner reads own rooms (public *and* private) |
| `rooms` | `rooms_select_member` | members read rooms they belong to |
| `rooms` | `rooms_insert_self_owner` | `owner_id = auth.uid()` — impersonation impossible |
| `room_members` | `room_members_select_own` | `user_id = auth.uid()` — no other member's rows leak |
| `room_members` | `room_members_insert_owner_self` | only the room owner, about themselves, as `owner` |
| `focus_sessions` | `focus_sessions_select_member` | members of the room only; there is no insert/update/delete policy, so RLS denies them even if a grant ever appeared |
| `study_goals` | `study_goals_select_own` / `insert_own` / `update_own` / `delete_own` | `user_id = auth.uid()` only; the insert policy also requires membership of the goal's room, so a goal cannot be attached to a room the writer has not joined |

There are **no policies for `anon` on any table** (verified: 0 policies for roles other
than `authenticated`), and anon holds no table privileges either.

## `create_room` RPC

```sql
create_room(p_name, p_capacity=4, p_visibility='public',
            p_exam_track=null, p_subject=null, p_language=null,
            p_status='open', p_shared_goal=null) returns public.rooms
```

- `SECURITY INVOKER`, `set search_path = ''`, every reference schema-qualified.
- Owner comes from `auth.uid()`; there is **no owner parameter** to spoof.
- Inputs validated (name/capacity/visibility/status/lengths) → `22023` on failure;
  unauthenticated → `42501`.
- Room insert and owner-membership insert run in the same call: a failure in the second
  aborts the first, so no room can exist without its owner membership.
- `EXECUTE` granted to `authenticated` only; revoked from `PUBLIC` and `anon`
  (verified with `has_function_privilege` → anon `f`, authenticated `t`, public `f`).

## How atomic owner membership is enforced

SECURITY INVOKER means table privileges and RLS — not the function — decide what a
caller may do, so the RPC alone cannot be trusted as an invariant: a direct
authenticated `INSERT` into `public.rooms` is otherwise legal (the RPC needs that grant
to work). The safeguard is a **`DEFERRABLE INITIALLY DEFERRED` constraint trigger**:

```sql
create constraint trigger rooms_require_owner_membership
after insert or update on public.rooms
deferrable initially deferred
for each row execute function public.assert_room_has_owner_membership();
```

It runs at `COMMIT` on every row, whatever the write path (RPC, direct PostgREST call,
psql session), and raises `23514` unless a `room_members` row exists with
`room_id = rooms.id`, `user_id = rooms.owner_id`, `role = 'owner'`. The trigger
function is `SECURITY DEFINER` with a pinned empty `search_path` so the check reads
ground truth instead of the caller's RLS-filtered view.

## Membership functions (`0002_room_membership.sql`)

Three functions, all `SECURITY DEFINER` with `set search_path = ''`, every reference
schema-qualified, `auth.uid()` read and null-checked before any write, execution
revoked from `public` and `anon` and granted only to `authenticated`. They are the only
membership path in the product, and they were necessary because the grants above leave
`room_members` with `INSERT`+`SELECT` only:

- an RLS `with check` cannot take a row lock, so two students racing for the last seat
  could each pass a count and then both insert, exceeding `capacity`;
- the single insert policy lets an *owner* add their own row, so no client can write a
  `student` membership at all — and there is no `DELETE` grant for leaving.

| Function | Behaviour |
| --- | --- |
| `join_room(p_room_id uuid) → jsonb` | Locks the room row (`select … for update`), then: missing/private (non-member) → `room_not_found`; existing member, the owner included → `already_member` with no new row; `status <> 'open'` → `room_closed`; `count >= capacity` → `room_full`; otherwise inserts a `student` row and returns `joined`. `member_count` is the aggregate for public rooms and `null` for private ones. |
| `leave_room(p_room_id uuid) → jsonb` | Deletes only the caller's own `role = 'student'` row. Non-member of a public room → `not_a_member`, unknown or private room → `room_not_found`, owner → `owner_cannot_leave`, otherwise `left`. Takes no lock: deleting can only free a seat. |
| `public_room_member_counts() → table(room_id uuid, member_count bigint)` | Aggregate seat usage for `visibility = 'public'` only, so private-room occupancy and every participant identity stay inside the database. |

No table grant or policy changed, so direct PostgREST writes keep failing exactly as
before: `INSERT` hits RLS with `42501`, `DELETE` hits the missing grant with `42501`.

## Focus session and goal functions (`0003_focus_sessions_and_goals.sql`)

Five functions, all `SECURITY DEFINER` with `set search_path = ''`, schema-qualified
references, `auth.uid()` read and null-checked first, execution revoked from `public`
and `anon` and granted only to `authenticated` — the same constraints as `0002`.

| Function | Behaviour |
| --- | --- |
| `focus_room_check(p_room_id uuid, p_require_owner boolean) → text` | The single authorization helper: missing room or non-member → `room_not_found` (so a non-member cannot tell a private room from a missing one), and with `p_require_owner` a student → `not_owner`. Returns a code, never a row, so it cannot leak room data. **Revoked from every app role** — only the other functions may execute it. |
| `expire_focus_sessions_for(p_room_id uuid) → void` | Persists `state = 'expired', ended_at = ends_at` for rows whose deadline passed. Also revoked from every app role; called by the read and the RPCs, never by a client. |
| `focus_session_state(p_room_id uuid) → jsonb` | The read path: membership check, expiry pass, then `{ code: 'ok', session, viewer_role, member_count, server_now_ms }` where `session` is the active row or `null`, `server_now_ms` is the database clock in epoch milliseconds, and `member_count` comes from a definer read so students see seat usage without being able to enumerate `room_members`. |
| `start_focus_session(p_room_id uuid, p_duration_seconds integer) → jsonb` | Owner only. Validates 60–7200 s (`22023` otherwise), expires stale sessions first, then inserts with `started_at`/`ends_at` from `now()`. A concurrent loser blocks on `focus_sessions_one_active`, gets `23505`, and is handed the winning row as `already_active` — never a second row. |
| `pause_focus_session` / `resume_focus_session` / `end_focus_session` | Owner only. Pause records `paused_at` (the deadline does not move); resume credits the paused interval to `ends_at` and accumulates `paused_seconds`; end flips to `completed` with `ended_at = now()`. Each returns the code plus the row, or `no_active_session` / `invalid_state` (409) / `not_owner` (403) / `room_not_found` (404). |

Two deliberate refinements over the original design notes:

- **No `session_expired` result code.** Every read and every control persists expiry
  first, so a passed deadline surfaces as `no_active_session` (409) instead of a
  separate code — one fewer branch for clients to handle, and the state is always
  already written.
- **No `started_by` column.** Column-level `SELECT` grants do not exist in Postgres,
  so any column would be readable through raw PostgREST by anyone who can `SELECT`.
  Exposing "who started" would therefore require a policy that hides it from some
  members but not others; the column was dropped and the API carries no starter
  identity at all.

Goals need no RPC: `study_goals` is written through PostgREST, where the
column-scoped grants and `user_id = auth.uid()` policies are the whole security
model, and the `study_goals_touch` trigger owns `updated_at`/`completed_at` on every
update regardless of the writer.

## Verification performed

All against the local stack. Structural:

```bash
npx supabase db lint --local        # exit 0: "No schema errors found"
npx supabase db reset               # exit 0: applied 0001_init.sql, 0002_room_membership.sql, 0003_focus_sessions_and_goals.sql
npx supabase migration list --local # 0001, 0002 and 0003 present locally
```

Observed from `pg_catalog` / `information_schema` on 127.0.0.1:54322:

- RLS enabled on `profiles`, `rooms`, `room_members` (`relrowsecurity = t`).
- 9 policies, all `TO authenticated`; 0 policies for any other role.
- FKs: `rooms.owner_id`/`room_members.user_id`/`profiles.id` → `auth.users`
  `ON DELETE CASCADE`; `room_members.room_id` → `rooms` `ON DELETE CASCADE`.
- Composite PK `(room_id, user_id)`, unique `profiles_alias_lower_key` on `lower(alias)`.
- `create_room`: `prosecdef = f`, `proconfig = {"search_path=\"\""}`.

Behavioral (29/29 HTTP checks against PostgREST with real local auth users, plus SQL):

| Requirement | Result |
| --- | --- |
| RPC succeeds for an authenticated user | `POST /rest/v1/rpc/create_room` → 200, `owner_id` = caller |
| Owner membership created with the room | 1 row, `role = owner`, `user_id` = caller |
| Membership insert failure rolls back the room | revoked `INSERT` on `room_members` → RPC failed, `rooms` left with 0 rows |
| Direct room INSERT cannot bypass the invariant | `400 / 23514` "…has no owner membership row"; 0 rows committed (API **and** SQL) |
| Owner impersonation impossible | `403 / 42501` "new row violates row-level security policy" |
| Private room visible to owner immediately | owner sees 1 row |
| Another authenticated user cannot read it | other user sees 0 rows, payload free of the id |
| Anonymous cannot read rooms or execute the RPC | `401 / 42501` "permission denied for table rooms" and "…for function create_room" |
| `UPDATE`/`DELETE` unavailable | all three denied (`403`) |
| Memberships private to the caller | own rows only, 0 foreign rows leaked |
| Profile column grants enforced | writing `created_at`/`id` → permission denied |
| Case-insensitive alias uniqueness | `caseprobe` after `CaseProbe` → `23505 profiles_alias_lower_key` |
| Input validation | capacity 0 / blank name / bad visibility → `400 / 22023` |

Membership (`0002_room_membership.sql`), verified against the local stack with real
auth users and covered end to end by `tests/integration/room-membership.test.ts`:

| Requirement | Result |
| --- | --- |
| Grants | `join_room`/`leave_room`/`public_room_member_counts`: anon `f`, authenticated `t`, `search_path = ""`, `prosecdef = t` for the two writes |
| Anonymous execute | all three → HTTP `401` with body `42501` |
| Join as the second student | `joined`, `member_count = 2` (owner counts as a seat) |
| Repeat join | `already_member`, row count unchanged, one row per member |
| Owner joining their own room | `already_member`, no second row |
| Private / missing room | both → `room_not_found`, byte-identical bodies (no existence leak) |
| Closed room | `room_closed`; an existing member still gets `already_member` |
| Capacity | capacity-1 room → `room_full`, count stays 1 |
| Leaving | `left` with the freed count, rejoin succeeds, repeat leave → `not_a_member` |
| Owner leaving | `owner_cannot_leave`, row still present |
| Five concurrent joins for three free seats | 3 `joined`, 2 `room_full`, final row count exactly 4 |
| Direct `INSERT` / `DELETE` on `room_members` | both denied (`42501`) — the grants did not move |
| Occupancy | `room_id` + `member_count` only, public rooms only, private room absent |

Focus sessions and goals (`0003_focus_sessions_and_goals.sql`), verified against the
local stack with a throwaway harness (99 checks: SQL grants/policies plus RPC calls
through real authenticated users) and covered end to end by
`tests/integration/focus-sessions.test.ts` and `tests/integration/study-goals.test.ts`:

| Requirement | Result |
| --- | --- |
| Grants | `focus_sessions`: anon `f`, `authenticated` SELECT only, `service_role` none (default ACL explicitly revoked first). `study_goals`: select/insert/delete + `UPDATE (title, target_seconds, target_count, status)` |
| RPC execution | all five: anon `f`, authenticated `t`, `search_path = ""`, `prosecdef = t`; `focus_room_check` and `expire_focus_sessions_for` not executable by any app role |
| Realtime | `focus_sessions` in `supabase_realtime`; `study_goals` not published |
| Authorization | non-member and missing room → identical `room_not_found`; student control → `not_owner`; member view → `ok` with their own `viewer_role` |
| Start / repeat start | `started` (201) then `already_active` (200), same row, one active row per room |
| Eight concurrent starts | 1 `started`, 7 `already_active`, exactly 1 row (partial unique index) |
| Pause / resume timing | `ends_at` unchanged by pause; resume credits the paused interval (`ends_at` moves forward, `paused_seconds` grows) |
| Early end | `completed` with `ended_at = now()`, history lists it newest-first |
| Expiry with no browser | backdated `ends_at` → next read or start persists `expired` with `ended_at = ends_at`; `pause` answers `no_active_session`; the stale row never blocks a new start |
| Direct writes | authenticated `INSERT`/`UPDATE` on `focus_sessions` → `42501` (SELECT-only grant); members can `SELECT`, non-members see 0 rows |
| Goals privacy | each caller reads only `user_id = auth.uid()` rows — even the room owner sees an empty list for someone else's goals |
| Goals ownership | another member's `PATCH`/`DELETE` → `404`, zero rows touched; forged `user_id` on insert → `42501`; insert into an unjoined room → `42501`; `user_id`/`room_id` updates → `42501` |
| Goals uniqueness | duplicate active title (case-insensitive) → `23505` → `409 duplicate_goal`; after completion the same title is accepted |
| Goals timestamps | completing sets `completed_at`, reopening clears it, direct writes cannot backdate either (`study_goals_touch` trigger) |
| Cleanup | harness leaves `profiles=0 rooms=0 sessions=0 goals=0 users=0` |

## Notes and risks

- Disk is the binding constraint: the local images need several GB. If Docker or the
  image pulls fail, stop — never run `docker system prune` or any container-wide cleanup
  (an unrelated `opportunity-bot` stack shares this daemon and must be preserved).
- `auto_expose_new_tables = false` means future tables are invisible to the API until
  explicitly granted. That is intentional.
- `service_role` has no data privileges; no server-side code uses it.
- Room `status` and `capacity` are now enforced by the join flow, but there is still no
  UI to close or edit a room: `rooms` has no `UPDATE`/`DELETE` grant.
- Authenticated API behaviour is covered by `tests/integration/` (run it with
  `npm run test:integration`); the schema itself is proven by `db lint` and `db reset`.
