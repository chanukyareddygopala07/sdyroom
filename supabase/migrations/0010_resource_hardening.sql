-- 0010_resource_hardening.sql
-- Upload abuse protection: rate limits, storage quotas and orphan cleanup.
--
-- Shape of this migration (reconciled decisions — see
-- docs/prs/PR-10-resource-security.md "Reconciliation"):
--
--   1. Rate limiting is one tiny fixed-window counter table plus ONE atomic
--      RPC (`rate_limit_take`). The table carries no grants at all and RLS
--      is enabled with zero policies, so no client can read or write a
--      counter directly — every increment travels through this SECURITY
--      DEFINER function, where the upsert is a single statement and is
--      therefore race-free. Key naming is a published contract (see the
--      "Rate limits" table in docs/API_CONTRACTS.md) so later PRs reuse it
--      instead of inventing parallel keys.
--   2. Quotas are enforced twice, on purpose:
--        * `resource_quota_ok()` is a pre-check the upload route calls
--          BEFORE the bytes are put to storage, so "over quota" becomes a
--          clean 409 without writing anything;
--        * a BEFORE INSERT trigger is the authority. Check-then-insert is
--          not a transaction: two concurrent uploads could both observe the
--          same total and both pass. The trigger serialises per uploader
--          and per room with advisory locks, so the (limit+1)th byte is
--          refused even under concurrency — and a direct PostgREST insert
--          hits it too.
--   3. Quota limits are constants inside the functions: a single place to
--      edit (env/config plumbing is out of scope for this PR).
--        * 1 GiB (1 073 741 824 bytes) per user, across everything they
--          own — personal files and shared uploads alike;
--        * 500 MiB (524 288 000 bytes) per room.
--      Both are documented in docs/API_CONTRACTS.md.
--   4. Orphan cleanup lives in the route, not here: SQL cannot call the
--      Storage API, so `POST /api/resources/cleanup` lists both sides and
--      computes the difference (object with no row -> delete the object
--      through the uploader-scoped storage policy; row with no object ->
--      delete the row). A 60-second grace period protects an upload that is
--      still in flight — object written, row not yet inserted.
--   5. Explicitly out, same as 0005: no malware scanning (format validation
--      is not scanning), no `USING (true)` policy, no widened grants on
--      `study_resources`, no change to cascades, and 0001–0009 are never
--      edited.
--
-- Identity is always `auth.uid()`. `set search_path = ''` pins the search
-- path and every reference is schema-qualified. Execute on the RPCs is
-- revoked from PUBLIC and anon and granted only to authenticated; the
-- trigger function follows 0005's convention (execute revoked from the API
-- roles — a trigger invocation does not consult EXECUTE at fire time).

-- ---------------------------------------------------------------------------
-- Rate limits
-- ---------------------------------------------------------------------------

-- Fixed-window counters. One row per key; the row is reused across windows,
-- so the table stays bounded by (users x rate-limited routes), not by
-- request volume. No INSERT/SELECT/UPDATE/DELETE grant is issued to any API
-- role: `rate_limit_take()` is the only door in, and RLS with zero policies
-- closes the door twice.
create table public.rate_limits (
  key text primary key,
  window_start timestamptz not null,
  count integer not null,
  constraint rate_limits_count_nonnegative check (count >= 0)
);

alter table public.rate_limits enable row level security;

revoke all on table public.rate_limits from public, anon, authenticated, service_role;

-- Atomic fixed-window take. Returns true when the caller may proceed.
--
-- The whole check is one INSERT ... ON CONFLICT DO UPDATE, so two sessions
-- calling it for the same key serialise on the row instead of both reading
-- the old count. On expiry the counter restarts at 1 (the current request
-- is the first of the new window). `least(...)` caps the counter a little
-- above the limit so that a flood inside one window cannot grow `count`
-- without bound — an integer overflow would turn the limiter into a
-- fail-open bug.
create or replace function public.rate_limit_take(
  p_key text,
  p_max integer,
  p_window interval
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_count integer;
begin
  if p_key is null
     or length(p_key) = 0
     or p_max is null
     or p_max < 1
     or p_window is null
     or p_window <= interval '0' then
    raise exception 'invalid rate limit parameters' using errcode = '22023';
  end if;

  insert into public.rate_limits as r (key, window_start, count)
  values (p_key, v_now, 1)
  on conflict (key) do update set
    window_start = case
      when r.window_start + p_window <= v_now then v_now
      else r.window_start
    end,
    count = case
      when r.window_start + p_window <= v_now then 1
      else least(r.count + 1, p_max + 1000)
    end
  returning r.count into v_count;

  return v_count <= p_max;
end;
$$;

revoke execute on function public.rate_limit_take(text, integer, interval)
  from public, anon;
grant execute on function public.rate_limit_take(text, integer, interval)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Quotas
-- ---------------------------------------------------------------------------

-- Pre-check for the upload route: may `p_add_bytes` more be added for the
-- caller right now? Returns false when either the caller's personal total
-- (everything they own) or — when `p_room_id` is given — the room's total
-- would pass its limit. Read-only, so it never blocks; the trigger below is
-- what actually enforces the limit at insert time.
create or replace function public.resource_quota_ok(
  p_room_id uuid,
  p_add_bytes bigint
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_limit constant bigint := 1073741824; -- 1 GiB per user
  v_room_limit constant bigint := 524288000;   -- 500 MiB per room
  v_user_used bigint;
  v_room_used bigint;
begin
  if auth.uid() is null or p_add_bytes is null or p_add_bytes < 0 then
    return false;
  end if;

  select coalesce(sum(r.size_bytes), 0)
    into v_user_used
    from public.study_resources r
   where r.owner_id = auth.uid();

  if v_user_used + p_add_bytes > v_user_limit then
    return false;
  end if;

  if p_room_id is not null then
    select coalesce(sum(r.size_bytes), 0)
      into v_room_used
      from public.study_resources r
     where r.room_id = p_room_id;

    if v_room_used + p_add_bytes > v_room_limit then
      return false;
    end if;
  end if;

  return true;
end;
$$;

revoke execute on function public.resource_quota_ok(uuid, bigint) from public, anon;
grant execute on function public.resource_quota_ok(uuid, bigint) to authenticated;

-- Display numbers for one scope, used by `GET /api/resources`:
--   p_room_id is null -> the caller's personal quota (scope "user")
--   p_room_id given   -> that room's quota (scope "room")
-- The user totals are always included so a room view can still explain an
-- upload that the caller's own limit refused. Nothing here is secret: both
-- numbers describe what the caller could learn by paging through their own
-- rows anyway.
create or replace function public.resource_quota(p_room_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_limit constant bigint := 1073741824; -- 1 GiB per user
  v_room_limit constant bigint := 524288000;   -- 500 MiB per room
  v_user_used bigint;
  v_room_used bigint := null;
begin
  if auth.uid() is not null then
    select coalesce(sum(r.size_bytes), 0)
      into v_user_used
      from public.study_resources r
     where r.owner_id = auth.uid();
  else
    v_user_used := 0;
  end if;

  if p_room_id is not null then
    select coalesce(sum(r.size_bytes), 0)
      into v_room_used
      from public.study_resources r
     where r.room_id = p_room_id;
  end if;

  return jsonb_build_object(
    'scope', case when p_room_id is null then 'user' else 'room' end,
    'used_bytes', case
      when p_room_id is null then v_user_used
      else v_room_used
    end,
    'limit_bytes', case
      when p_room_id is null then v_user_limit
      else v_room_limit
    end,
    'user_used_bytes', v_user_used,
    'user_limit_bytes', v_user_limit
  );
end;
$$;

revoke execute on function public.resource_quota(uuid) from public, anon;
grant execute on function public.resource_quota(uuid) to authenticated;

-- The quota authority. Runs for EVERY insert into study_resources — API,
-- direct PostgREST and psql alike — so the limit cannot be routed around.
--
-- Advisory locks are taken in a fixed order (uploader, then room): that is
-- what makes the check race-free (two uploads cannot observe the same
-- pre-insert total) while making a deadlock between two uploads impossible
-- (nobody ever holds the room lock and then waits for an uploader lock).
-- The lock is released at commit or rollback, so it is held only for the
-- duration of the inserting transaction.
--
-- The raise is `P0001` with the message `quota_exceeded`; the API maps that
-- pair to 409 and rolls the just-written object back.
create or replace function public.study_resources_quota_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_limit constant bigint := 1073741824; -- 1 GiB per user
  v_room_limit constant bigint := 524288000;   -- 500 MiB per room
  v_user_used bigint;
  v_room_used bigint;
begin
  -- A null owner or size cannot happen through the API (both are NOT NULL),
  -- but a future migration or a service-role write could produce one; let
  -- the column constraints reject the row rather than quota-check nonsense.
  if new.owner_id is null or new.size_bytes is null then
    return new;
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('sdyroom:quota:user:' || new.owner_id::text, 0)
  );

  select coalesce(sum(r.size_bytes), 0)
    into v_user_used
    from public.study_resources r
   where r.owner_id = new.owner_id;

  if v_user_used + new.size_bytes > v_user_limit then
    raise exception 'quota_exceeded' using errcode = 'P0001';
  end if;

  if new.room_id is not null then
    perform pg_advisory_xact_lock(
      hashtextextended('sdyroom:quota:room:' || new.room_id::text, 0)
    );

    select coalesce(sum(r.size_bytes), 0)
      into v_room_used
      from public.study_resources r
     where r.room_id = new.room_id;

    if v_room_used + new.size_bytes > v_room_limit then
      raise exception 'quota_exceeded' using errcode = 'P0001';
    end if;
  end if;

  return new;
end;
$$;

revoke execute on function public.study_resources_quota_guard()
  from public, anon, authenticated;

create trigger study_resources_quota_guard
  before insert on public.study_resources
  for each row
  execute function public.study_resources_quota_guard();
