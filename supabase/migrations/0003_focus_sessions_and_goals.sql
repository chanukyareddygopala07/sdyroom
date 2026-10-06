-- SDYROOM 0003_focus_sessions_and_goals: shared focus sessions + personal goals.
-- Local-only target: `npx supabase db reset` / `npx supabase db push --local`.
-- 0001_init.sql and 0002_room_membership.sql are already applied and are never
-- edited: this file only adds.
--
-- Design
-- ------
-- focus_sessions
--   * PostgreSQL owns every timestamp. `started_at` and `ends_at` are written
--     here, never accepted from a client, and a countdown is always derived
--     from them — reconnecting or refreshing cannot restart a timer.
--   * States and legal transitions:
--         (none)  --start-->  running
--         running --pause-->  paused
--         paused  --resume--> running
--         running, paused --end-->  completed   (owner finished early)
--         running --ends_at <= now()--> expired  (deadline passed)
--     `completed` and `expired` are terminal; a new session is a new row.
--   * A session expires because its row says so, not because a browser is
--     open: every read first persists `state = 'expired', ended_at = ends_at`
--     for rows whose deadline has passed, and `start` does the same before it
--     inserts, so a stale session can never block a room forever.
--   * At most one active (running or paused) session per room is enforced by a
--     partial UNIQUE index, which is concurrency-safe: a losing concurrent
--     start blocks on the index and fails with 23505, which the RPC reports as
--     `already_active` instead of a second row.
--   * Pausing freezes the countdown by recording `paused_at`; resuming pushes
--     `ends_at` forward by the paused interval and accumulates
--     `paused_seconds`. Remaining time is therefore always
--     `ends_at - paused_at` (paused) or `ends_at - now()` (running).
--
-- study_goals
--   * Personal, never shared: RLS allows only `user_id = auth.uid()`, so no
--     other member — and not even the room owner — can read someone's goals.
--     This table is unrelated to `rooms.shared_goal`, which is public room
--     metadata.
--   * A goal always belongs to a room the owner is a member of, so goals are
--     discoverable from a workspace but cannot be attached to arbitrary rooms.
--   * `status` flips are made by the owner through an UPDATE grant limited to
--     `(title, target_seconds, target_count, status)`; `completed_at` and
--     `updated_at` are set by trigger, so a browser cannot backdate anything.
--   * Duplicate active titles are rejected by a partial UNIQUE index (23505),
--     which the API reports as `duplicate_goal`. The same title may be reused
--     once the earlier goal is completed.
--
-- Why SECURITY DEFINER for the session RPCs
-- -----------------------------------------
-- Session control must (a) verify room membership, (b) verify the caller is
-- the room owner, and (c) write rows that no authenticated client may write:
-- `focus_sessions` is granted SELECT only, deliberately, so a direct
-- PostgREST INSERT/UPDATE cannot start a session, pause one, or rewind
-- `ends_at`. An RLS policy could not express the state machine or the
-- "one active session" rule, and it could not take the index/lock ordering
-- used here. The constraints on that choice:
--
--   * `security definer` with `set search_path = ''`; every reference is
--     schema-qualified and `auth.uid()` is read and null-checked first;
--   * execution revoked from PUBLIC and anon, granted only to
--     `authenticated` — exactly like `create_room` in 0001;
--   * the body is a fixed plpgsql block over `public.rooms`,
--     `public.room_members` and `public.focus_sessions` only — no dynamic
--     SQL, no writes to `auth.users`, no user id ever accepted as an
--     argument (identity always comes from `auth.uid()`);
--   * shared checks live in one helper, `focus_room_check`, which is revoked
--     from every application role: only these definer functions can call it,
--     so it cannot become an authorization oracle for PostgREST clients.
--
-- Realtime: `focus_sessions` is added to the `supabase_realtime` publication so
-- a connected member receives change events; every event triggers a re-read of
-- `focus_session_state`, and the client also polls, so a missed event can only
-- delay a render, never leave it permanently stale. RLS still applies: a
-- non-member subscriber receives nothing.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
-- Deliberately no "started_by" column: every transition is owner-only anyway,
-- and the design forbids exposing who started a session. Column-level SELECT
-- grants do not exist in Postgres, so a column would be readable through raw
-- PostgREST reads by any member; leaving it out is the only airtight way to
-- keep the identity out of every response.
create table public.focus_sessions (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  state text not null,
  duration_seconds integer not null,
  started_at timestamptz not null default now(),
  ends_at timestamptz not null,
  paused_at timestamptz,
  paused_seconds integer not null default 0,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  constraint focus_sessions_state check (state in ('running', 'paused', 'completed', 'expired')),
  constraint focus_sessions_duration check (duration_seconds between 60 and 7200),
  constraint focus_sessions_paused_seconds check (paused_seconds >= 0),
  constraint focus_sessions_paused_fields check ((state = 'paused') = (paused_at is not null)),
  constraint focus_sessions_finished_fields check ((state in ('completed', 'expired')) = (ended_at is not null)),
  constraint focus_sessions_ends_after_start check (ends_at > started_at),
  constraint focus_sessions_ended_after_start check (ended_at is null or ended_at >= started_at)
);

create index focus_sessions_room_started_idx on public.focus_sessions (room_id, started_at desc);

-- The whole concurrency story for "at most one active session per room".
create unique index focus_sessions_one_active on public.focus_sessions (room_id)
  where state in ('running', 'paused');

create table public.study_goals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  room_id uuid not null references public.rooms (id) on delete cascade,
  title text not null,
  target_seconds integer,
  target_count integer,
  status text not null default 'active',
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint study_goals_title_len check (char_length(btrim(title)) between 1 and 120),
  constraint study_goals_title_trimmed check (title = btrim(title)),
  constraint study_goals_status check (status in ('active', 'completed')),
  constraint study_goals_target_seconds check (target_seconds is null or target_seconds between 60 and 86400),
  constraint study_goals_target_count check (target_count is null or target_count between 1 and 10000),
  constraint study_goals_completed_fields check ((status = 'completed') = (completed_at is not null))
);

-- One active goal per title per room; a completed goal frees the title again.
create unique index study_goals_active_title_key on public.study_goals (user_id, room_id, lower(title))
  where status = 'active';

create index study_goals_user_room_idx on public.study_goals (user_id, room_id, created_at desc);

-- Server-owned bookkeeping: a browser may flip `status`, never the timestamps.
create or replace function public.study_goals_touch()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  if new.status = 'completed' and old.status <> 'completed' then
    new.completed_at := now();
  elsif new.status = 'active' and old.status = 'completed' then
    new.completed_at := null;
  else
    new.completed_at := old.completed_at;
  end if;
  return new;
end;
$$;

create trigger study_goals_set_timestamps
before update on public.study_goals
for each row
execute function public.study_goals_touch();

-- ---------------------------------------------------------------------------
-- Grants. The stack defines a default ACL for new tables in `public`
-- (TRUNCATE/REFERENCES/TRIGGER/MAINTAIN for anon, authenticated and
-- service_role), so both tables start by revoking everything — 0001's own
-- `revoke all on all tables` only reached the tables that existed then. What
-- remains is exactly what the design needs:
--   * focus_sessions: SELECT only. Writes are impossible from PostgREST, which
--     is what forces every state transition through the RPCs.
--   * study_goals: full CRUD, but column-scoped UPDATE that excludes
--     `user_id`, `room_id`, `completed_at`, `created_at` and `updated_at`.
-- ---------------------------------------------------------------------------
revoke all on public.focus_sessions from anon, authenticated, service_role;
revoke all on public.study_goals from anon, authenticated, service_role;

grant select on public.focus_sessions to authenticated;

grant select, insert, delete on public.study_goals to authenticated;
grant update (title, target_seconds, target_count, status) on public.study_goals to authenticated;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.focus_sessions enable row level security;
alter table public.study_goals enable row level security;

-- Any member of the room may read its sessions (viewing is not controlling);
-- there is no insert/update/delete policy, so RLS denies them even if a grant
-- ever appeared.
create policy "focus_sessions_select_member" on public.focus_sessions
  for select to authenticated
  using (exists (
    select 1 from public.room_members m
    where m.room_id = focus_sessions.room_id and m.user_id = auth.uid()
  ));

create policy "study_goals_select_own" on public.study_goals
  for select to authenticated
  using (user_id = auth.uid());

create policy "study_goals_insert_own" on public.study_goals
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.room_members m
      where m.room_id = study_goals.room_id and m.user_id = auth.uid()
    )
  );

-- The column grants pin `user_id` and `room_id` (they are not updatable at
-- all), so a goal can never be moved to another user or room.
create policy "study_goals_update_own" on public.study_goals
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "study_goals_delete_own" on public.study_goals
  for delete to authenticated
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- focus_room_check: the single authorization helper for session control.
-- Returns a code, never a row, so it cannot leak room data; `p_require_owner`
-- separates "may view" (false) from "may drive the shared timer" (true).
-- Revoke below means no application role can execute it directly.
-- ---------------------------------------------------------------------------
create or replace function public.focus_room_check(p_room_id uuid, p_require_owner boolean)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_owner_id uuid;
begin
  if v_user_id is null then
    raise exception 'focus workspace requires an authenticated user' using errcode = '42501';
  end if;

  if p_room_id is null then
    return 'room_not_found';
  end if;

  select r.owner_id into v_owner_id
  from public.rooms r
  where r.id = p_room_id;

  -- Missing room and room you are not a member of are the same answer, so a
  -- workspace URL can never be used to test which rooms exist.
  if not found then
    return 'room_not_found';
  end if;

  if not exists (
    select 1 from public.room_members m
    where m.room_id = p_room_id and m.user_id = v_user_id
  ) then
    return 'room_not_found';
  end if;

  if p_require_owner and v_owner_id <> v_user_id then
    return 'not_owner';
  end if;

  return 'ok';
end;
$$;

-- Persist deadline passage for this room's stale running session, if any.
create or replace function public.expire_focus_sessions_for(p_room_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.focus_sessions
     set state = 'expired', ended_at = ends_at
   where room_id = p_room_id
     and state = 'running'
     and ends_at <= now();
$$;

-- ---------------------------------------------------------------------------
-- focus_session_state: the read path. Members only; persists expiry, then
-- returns the active session, the caller's role and the server clock in epoch
-- milliseconds so a client can derive a countdown without trusting its own
-- clock.
-- ---------------------------------------------------------------------------
create or replace function public.focus_session_state(p_room_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_check text;
  v_session jsonb := null;
  v_role text;
begin
  v_check := public.focus_room_check(p_room_id, false);
  if v_check <> 'ok' then
    return jsonb_build_object('code', v_check);
  end if;

  perform public.expire_focus_sessions_for(p_room_id);

  select to_jsonb(s) into v_session
  from public.focus_sessions s
  where s.room_id = p_room_id and s.state in ('running', 'paused')
  limit 1;

  select m.role into v_role
  from public.room_members m
  where m.room_id = p_room_id and m.user_id = auth.uid();

  return jsonb_build_object(
    'code', 'ok',
    'session', v_session,
    'viewer_role', v_role,
    -- Seat usage for this room only. `public_room_member_counts` refuses
    -- private rooms, and a student may not enumerate `room_members`, so the
    -- definer read is what makes the count available to members of any room.
    'member_count', (select count(*) from public.room_members m where m.room_id = p_room_id),
    'server_now_ms', (extract(epoch from now()) * 1000)::bigint
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- start_focus_session: owner only. Expires a stale session first, then
-- inserts; a concurrent loser hits the partial unique index and is handed the
-- winning session instead of creating a second one.
-- ---------------------------------------------------------------------------
create or replace function public.start_focus_session(p_room_id uuid, p_duration_seconds integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_check text;
  v_session jsonb := null;
begin
  v_check := public.focus_room_check(p_room_id, true);
  if v_check <> 'ok' then
    return jsonb_build_object('code', v_check);
  end if;

  if p_duration_seconds is null or p_duration_seconds not between 60 and 7200 then
    raise exception 'duration must be between 60 and 7200 seconds' using errcode = '22023';
  end if;

  perform public.expire_focus_sessions_for(p_room_id);

  begin
    insert into public.focus_sessions (room_id, state, duration_seconds, started_at, ends_at)
    values (p_room_id, 'running', p_duration_seconds, now(), now() + make_interval(secs => p_duration_seconds))
    returning to_jsonb(focus_sessions.*) into v_session;
  exception when unique_violation then
    select to_jsonb(s) into v_session
    from public.focus_sessions s
    where s.room_id = p_room_id and s.state in ('running', 'paused')
    limit 1;
    return jsonb_build_object('code', 'already_active', 'session', v_session);
  end;

  return jsonb_build_object('code', 'started', 'session', v_session);
end;
$$;

-- ---------------------------------------------------------------------------
-- pause_focus_session: owner only, running -> paused.
-- ---------------------------------------------------------------------------
create or replace function public.pause_focus_session(p_room_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_check text;
  v_session jsonb := null;
begin
  v_check := public.focus_room_check(p_room_id, true);
  if v_check <> 'ok' then
    return jsonb_build_object('code', v_check);
  end if;

  perform public.expire_focus_sessions_for(p_room_id);

  select to_jsonb(s) into v_session
  from public.focus_sessions s
  where s.room_id = p_room_id and s.state in ('running', 'paused')
  limit 1;

  if v_session is null then
    return jsonb_build_object('code', 'no_active_session');
  end if;

  if (v_session ->> 'state') = 'paused' then
    return jsonb_build_object('code', 'invalid_state', 'session', v_session);
  end if;

  update public.focus_sessions
     set state = 'paused', paused_at = now()
   where id = (v_session ->> 'id')::uuid
   returning to_jsonb(focus_sessions.*) into v_session;

  return jsonb_build_object('code', 'paused', 'session', v_session);
end;
$$;

-- ---------------------------------------------------------------------------
-- resume_focus_session: owner only, paused -> running. The paused interval is
-- credited back to `ends_at`, so the countdown resumes where it stopped.
-- ---------------------------------------------------------------------------
create or replace function public.resume_focus_session(p_room_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_check text;
  v_session jsonb := null;
  v_id uuid;
  v_paused timestamptz;
begin
  v_check := public.focus_room_check(p_room_id, true);
  if v_check <> 'ok' then
    return jsonb_build_object('code', v_check);
  end if;

  select to_jsonb(s), (s.id), s.paused_at into v_session, v_id, v_paused
  from public.focus_sessions s
  where s.room_id = p_room_id and s.state in ('running', 'paused')
  limit 1;

  if v_session is null then
    return jsonb_build_object('code', 'no_active_session');
  end if;

  if (v_session ->> 'state') = 'running' then
    return jsonb_build_object('code', 'invalid_state', 'session', v_session);
  end if;

  update public.focus_sessions
     set state = 'running',
         ends_at = ends_at + (now() - v_paused),
         paused_seconds = paused_seconds + (extract(epoch from (now() - v_paused))::integer),
         paused_at = null
   where id = v_id
   returning to_jsonb(focus_sessions.*) into v_session;

  return jsonb_build_object('code', 'resumed', 'session', v_session);
end;
$$;

-- ---------------------------------------------------------------------------
-- end_focus_session: owner only, running or paused -> completed.
-- ---------------------------------------------------------------------------
create or replace function public.end_focus_session(p_room_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_check text;
  v_session jsonb := null;
begin
  v_check := public.focus_room_check(p_room_id, true);
  if v_check <> 'ok' then
    return jsonb_build_object('code', v_check);
  end if;

  perform public.expire_focus_sessions_for(p_room_id);

  select to_jsonb(s) into v_session
  from public.focus_sessions s
  where s.room_id = p_room_id and s.state in ('running', 'paused')
  limit 1;

  if v_session is null then
    return jsonb_build_object('code', 'no_active_session');
  end if;

  update public.focus_sessions
     set state = 'completed', ended_at = now(), paused_at = null
   where id = (v_session ->> 'id')::uuid
   returning to_jsonb(focus_sessions.*) into v_session;

  return jsonb_build_object('code', 'completed', 'session', v_session);
end;
$$;

-- ---------------------------------------------------------------------------
-- Execution grants: mirrors create_room. The helper and the expiry function
-- stay private to the definer functions above.
-- ---------------------------------------------------------------------------
revoke execute on function public.focus_room_check(uuid, boolean) from public, anon, authenticated;
revoke execute on function public.expire_focus_sessions_for(uuid) from public, anon, authenticated;

revoke execute on function public.focus_session_state(uuid) from public, anon;
grant execute on function public.focus_session_state(uuid) to authenticated;

revoke execute on function public.start_focus_session(uuid, integer) from public, anon;
grant execute on function public.start_focus_session(uuid, integer) to authenticated;

revoke execute on function public.pause_focus_session(uuid) from public, anon;
grant execute on function public.pause_focus_session(uuid) to authenticated;

revoke execute on function public.resume_focus_session(uuid) from public, anon;
grant execute on function public.resume_focus_session(uuid) to authenticated;

revoke execute on function public.end_focus_session(uuid) from public, anon;
grant execute on function public.end_focus_session(uuid) to authenticated;

-- The study_goals trigger function is never called by clients either.
revoke execute on function public.study_goals_touch() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Realtime. The publication exists but is empty locally; only the session
-- table joins it, and only members can receive events (RLS applies at
-- delivery). Goals stay out: they are private and refreshed by refetch.
-- ---------------------------------------------------------------------------
alter publication supabase_realtime add table public.focus_sessions;
