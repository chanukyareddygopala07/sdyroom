-- 0012_notifications.sql
-- In-app notifications: the `notifications` table, the producer RPCs, the
-- per-user preferences column, unread count and the retention function.
-- Local-only target: `npx supabase db reset` / `npx supabase db push --local`.
-- 0001 … 0010 are already applied and are never edited: this file only adds.
--
-- Shape of this migration (see docs/prs/PR-11-notifications.md):
--
--   1. Alias is the only identity a request ever carries (the 007/009 rule).
--     `profiles` is RLS own-only for direct reads, so the route layer never
--     learns a target's uuid — `push_notification` takes a `p_user_id` the
--     producer route obtains from `moderation_resolve_alias` (0009, already
--     granted to authenticated), and `push_report_notification` derives the
--     reporter from the report row inside the definer body so the uuid of a
--     reporter never travels through a route at all.
--   2. Writes are RPC-only: `notifications` carries SELECT, UPDATE(read_at)
--      and DELETE grants for `authenticated` on their own rows, and **no
--      INSERT grant**, exactly like 0009's audit tables. Rows appear only
--      because the two producer functions above write them, and the producer
--      authorization table below is the one place a global "anyone can notify
--      anyone" hole could open — it is the review focus of this PR.
--   3. Preferences are checked at write time, on the recipient's
--      `profiles.notification_prefs` column (narrow widening of 0001's
--      profiles grants). A muted type never creates a row; there is nothing
--      to filter on read and no way to "lose" a row by flipping a switch.
--   4. Deduplication is the partial unique index
--      `(user_id, dedupe_key) where read_at is null` — same subject + still
--      unread collapses onto one row whose `created_at` is refreshed; once a
--      row is read, a new event on the same subject is a new row. No history
--      is silently rewritten.
--   5. Realtime delivery is postgres_changes on the table itself, the same
--      mechanism 0004/0005 use for `room_messages`: the subscriber's own
--      SELECT RLS is what scopes the frames (no broadcast channel, no
--      per-user topic authorisation to get wrong). `notifications` joins the
--      `supabase_realtime` publication for that.
--   6. Retention is a documented operator RPC (`prune_notifications`),
--      granted to `service_role` only — no cron in this PR, but retention is
--      real, not aspirational.
--
-- Identity is always `auth.uid()`; no recipient id is ever a parameter the
-- caller invents without the matching producer rule. `set search_path = ''`
-- pins the search path and every reference is schema-qualified. Execute is
-- revoked from PUBLIC and anon, granted only to authenticated (except the
-- prune function, which is service_role only).
--
-- Producer rule table for `push_notification` (encoded again in the function
-- header comment; this is the security contract of the whole feature):
--
--   | type               | p_room_id | producer rule                                  |
--   | invite_created     | required  | caller owns the room                           |
--   | invite_accepted    | required  | caller is the recipient (self) — reserved      |
--   | member_removed     | required  | caller is the room's owner or a moderator      |
--   | muted              | required  | caller is the room's owner or a moderator      |
--   | moderation_resolved| required  | caller is the room's owner or a moderator      |
--   | report_resolved    | required  | (report path: push_report_notification)        |
--   | resource_ready     | optional  | caller is the recipient (self) — reserved      |
--   | ai_task_complete   | optional  | caller is the recipient (self) — reserved      |
--   | system             | optional  | caller is the recipient (self) — reserved      |
--
-- The only way one user can notify another is a room-scoped type while
-- holding the owner or moderator role of that room. Everything else —
-- including every type whose producer has not been written yet — collapses
-- to `p_user_id = auth.uid()`.

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  type text not null
    constraint notifications_type_check
    check (type in (
      'invite_created', 'invite_accepted', 'member_removed', 'muted',
      'moderation_resolved', 'report_resolved', 'resource_ready',
      'ai_task_complete', 'system'
    )),
  -- Cascade (per the spec): a deleted room's rows are dead links, and the
  -- deep link is the only reason room_id is here at all.
  room_id uuid references public.rooms (id) on delete cascade,
  payload jsonb not null default '{}'::jsonb
    constraint notifications_payload_is_object
    check (jsonb_typeof(payload) = 'object')
    constraint notifications_payload_bounded
    check (octet_length(payload::text) <= 2000),
  dedupe_key text
    constraint notifications_dedupe_key_len
    check (dedupe_key is null or char_length(dedupe_key) between 1 and 200),
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index notifications_user_created_idx
  on public.notifications (user_id, created_at desc);

-- The badge's count and the inbox's unread filter both land here.
create index notifications_unread_idx
  on public.notifications (user_id)
  where read_at is null;

-- The dedupe rule: one unread row per (user, subject). Read rows are exempt
-- so a later event on the same subject is a fresh notification.
create unique index notifications_unread_dedupe_idx
  on public.notifications (user_id, dedupe_key)
  where read_at is null and dedupe_key is not null;

-- ---------------------------------------------------------------------------
-- Grants and RLS — own rows only, no INSERT for anyone
-- ---------------------------------------------------------------------------

revoke all on public.notifications from anon, authenticated, service_role;

grant select, update (read_at), delete on public.notifications to authenticated;

alter table public.notifications enable row level security;

create policy "notifications_select_own" on public.notifications
  for select to authenticated
  using (user_id = (select auth.uid()));

-- The column grant already forbids touching anything but read_at; the policy
-- keeps even that row-scoped. WITH CHECK pins user_id, so a row cannot be
-- re-homed while it is being marked read.
create policy "notifications_update_own" on public.notifications
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy "notifications_delete_own" on public.notifications
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- Preferences column on profiles (0001's table, widened narrowly)
-- ---------------------------------------------------------------------------

alter table public.profiles
  add column notification_prefs jsonb not null default '{"default": "all"}'::jsonb
  constraint profiles_notification_prefs_is_object
    check (jsonb_typeof(notification_prefs) = 'object');

-- 0001 granted select/update on explicit column lists, so the new column
-- needs its own grants: the PATCH endpoint reads back what it wrote, and the
-- settings form reads the current values — all through the existing
-- profiles_update_own / select-own policies.
grant select (notification_prefs) on public.profiles to authenticated;
grant update (notification_prefs) on public.profiles to authenticated;

-- ---------------------------------------------------------------------------
-- Internal preference resolution: type -> category -> effective value.
-- `mentions_and_invites` means "invites only" in this product (there are no
-- @mentions yet): for every category but 'invite' it suppresses delivery,
-- exactly like 'none'. The 'system' category is not configurable and always
-- delivers. A missing key falls back to the 'default' key, then to 'all'.
-- ---------------------------------------------------------------------------

create or replace function public.notification_category(p_type text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_type
    when 'invite_created' then 'invite'
    when 'invite_accepted' then 'invite'
    when 'member_removed' then 'moderation'
    when 'muted' then 'moderation'
    when 'moderation_resolved' then 'moderation'
    when 'report_resolved' then 'moderation'
    when 'resource_ready' then 'resource'
    when 'ai_task_complete' then 'ai'
    when 'system' then null
  end;
$$;

revoke execute on function public.notification_category(text) from public, anon;
grant execute on function public.notification_category(text) to authenticated;

-- ---------------------------------------------------------------------------
-- push_notification: the writer. Consults the recipient's preferences, folds
-- an unread duplicate onto its existing row, otherwise inserts. Returns a
-- jsonb envelope in the 0009 style — `{code: created | deduped | muted |
-- validation | not_authorized | not_found, id?}` — so the TS writer can log
-- the outcome without parsing errors. The uuid itself travels as `id`.
--
-- Producer rules (the security contract; duplicated from the file header
-- because this is the function a reviewer must read line by line):
--
--   invite_created      p_room_id required; caller must be the room's owner.
--   invite_accepted     p_room_id required; caller must be the recipient.
--   member_removed      p_room_id required; caller owner or moderator.
--   muted               p_room_id required; caller owner or moderator.
--   moderation_resolved p_room_id required; caller owner or moderator.
--   report_resolved     via push_report_notification only (the report id
--                       derives both the room and the reporter inside the
--                       definer body); a direct call with a p_room_id the
--                       caller moderates is allowed but carries no report.
--   resource_ready      caller must be the recipient.
--   ai_task_complete    caller must be the recipient.
--   system              caller must be the recipient (until an operator tool
--                       exists — otherwise this is the forge hole).
--
-- A room-scoped check never looks at the recipient's membership: an invitee
-- is not a member yet, and a removed member is no longer one. What is always
-- checked is the *caller's* relationship to the room named in the call.
-- Payloads are bounded by the table CHECK (2 KB, object) and, on the report
-- path, may not carry the reporter's identity — that is checked below too.
-- ---------------------------------------------------------------------------

create or replace function public.push_notification(
  p_user_id uuid,
  p_type text,
  p_payload jsonb,
  p_room_id uuid,
  p_dedupe_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller uuid := auth.uid();
  v_category text;
  v_prefs jsonb;
  v_pref text;
  v_id uuid;
  v_owner uuid;
begin
  if v_caller is null then
    raise exception 'push_notification requires an authenticated user'
      using errcode = '42501';
  end if;

  if p_user_id is null or p_type is null or p_payload is null then
    return jsonb_build_object('code', 'validation');
  end if;

  if jsonb_typeof(p_payload) <> 'object' or octet_length(p_payload::text) > 2000 then
    return jsonb_build_object('code', 'validation');
  end if;

  if p_dedupe_key is not null
    and not (char_length(p_dedupe_key) between 1 and 200) then
    return jsonb_build_object('code', 'validation');
  end if;

  v_category := public.notification_category(p_type);
  if p_type <> 'system' and v_category is null then
    return jsonb_build_object('code', 'validation');
  end if;

  -- Producer rule: the five room-named types must actually name a room;
  -- every other type is a self-notify where room_id is merely the deep link.
  if p_type in (
    'invite_created', 'invite_accepted', 'member_removed', 'muted',
    'moderation_resolved'
  ) and p_room_id is null then
    return jsonb_build_object('code', 'validation');
  end if;

  if p_type in (
    'invite_created', 'member_removed', 'muted', 'moderation_resolved'
  ) then
    select owner_id into v_owner from public.rooms where id = p_room_id;
    if not found then
      return jsonb_build_object('code', 'not_found');
    end if;

    if p_type = 'invite_created' then
      if v_owner <> v_caller then
        return jsonb_build_object('code', 'not_authorized');
      end if;
    else
      if v_owner <> v_caller and not exists (
        select 1 from public.room_moderators rm
        where rm.room_id = p_room_id and rm.user_id = v_caller
      ) then
        return jsonb_build_object('code', 'not_authorized');
      end if;
    end if;
  elsif p_type = 'invite_accepted' then
    if p_room_id is null then
      return jsonb_build_object('code', 'validation');
    end if;
    if p_user_id <> v_caller then
      return jsonb_build_object('code', 'not_authorized');
    end if;
  elsif p_type = 'report_resolved' then
    -- The dedicated report RPC owns the real path; a bare call here must at
    -- least not become an arbitrary-recipient hole.
    if p_user_id <> v_caller then
      return jsonb_build_object('code', 'not_authorized');
    end if;
  else
    -- resource_ready / ai_task_complete / system: self only.
    if p_user_id <> v_caller then
      return jsonb_build_object('code', 'not_authorized');
    end if;
  end if;

  -- Recipient preferences, checked at write time (single source of truth).
  select notification_prefs into v_prefs
  from public.profiles where id = p_user_id;
  if not found then
    return jsonb_build_object('code', 'not_found');
  end if;

  if v_category is not null then
    v_pref := coalesce(
      v_prefs ->> v_category,
      v_prefs ->> 'default',
      'all'
    );
    if v_pref not in ('all', 'mentions_and_invites', 'none') then
      v_pref := 'all';
    end if;
    if v_pref = 'none'
      or (v_pref = 'mentions_and_invites' and v_category <> 'invite') then
      return jsonb_build_object('code', 'muted');
    end if;
  end if;

  -- Dedupe: fold onto the unread row for the same subject, refreshing its
  -- timestamp and payload so the inbox shows the latest wording once.
  if p_dedupe_key is not null then
    update public.notifications
      set created_at = now(),
          payload = p_payload,
          room_id = coalesce(p_room_id, room_id)
      where user_id = p_user_id
        and dedupe_key = p_dedupe_key
        and read_at is null
      returning id into v_id;

    if v_id is not null then
      return jsonb_build_object('code', 'deduped', 'id', v_id);
    end if;
  end if;

  begin
    insert into public.notifications (user_id, type, room_id, payload, dedupe_key)
    values (p_user_id, p_type, p_room_id, p_payload, p_dedupe_key)
    returning id into v_id;
  exception when unique_violation then
    -- Two producers raced the same unread subject; the index won — fold.
    update public.notifications
      set created_at = now(),
          payload = p_payload,
          room_id = coalesce(p_room_id, room_id)
      where user_id = p_user_id
        and dedupe_key = p_dedupe_key
        and read_at is null
      returning id into v_id;
    if v_id is not null then
      return jsonb_build_object('code', 'deduped', 'id', v_id);
    end if;
    raise;
  end;

  return jsonb_build_object('code', 'created', 'id', v_id);
end;
$$;

revoke execute on function public.push_notification(uuid, text, jsonb, uuid, text)
  from public, anon;
grant execute on function public.push_notification(uuid, text, jsonb, uuid, text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- push_report_notification: the report-status producer. The reporter's uuid
-- has no SELECT grant anywhere (the 0009 rule), so it cannot be a parameter
-- and the route cannot learn it: the definer body reads it from the report
-- row and inserts straight to the reporter's inbox. The caller must be the
-- owner or a moderator of the report's room — the same relation the report
-- PATCH route proves — and a caller without it gets `not_found`, the exact
-- answer a missing report produces, so this is not an existence oracle
-- either. Payloads may not name the reporter (defense in depth on PR 09's
-- "notifications never leak reporter_id" guarantee).
-- ---------------------------------------------------------------------------

create or replace function public.push_report_notification(
  p_report_id uuid,
  p_type text,
  p_payload jsonb,
  p_dedupe_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller uuid := auth.uid();
  v_room uuid;
  v_reporter uuid;
  v_category text;
  v_prefs jsonb;
  v_pref text;
  v_id uuid;
begin
  if v_caller is null then
    raise exception 'push_report_notification requires an authenticated user'
      using errcode = '42501';
  end if;

  if p_report_id is null or p_type is null or p_payload is null then
    return jsonb_build_object('code', 'validation');
  end if;

  -- Only the reporter-facing outcome is wired; the other report-adjacent
  -- types stay reserved until a producer exists for them.
  if p_type <> 'report_resolved' then
    return jsonb_build_object('code', 'validation');
  end if;

  if jsonb_typeof(p_payload) <> 'object' or octet_length(p_payload::text) > 2000 then
    return jsonb_build_object('code', 'validation');
  end if;

  if p_dedupe_key is not null
    and not (char_length(p_dedupe_key) between 1 and 200) then
    return jsonb_build_object('code', 'validation');
  end if;

  if p_payload ? 'reporter_id' or p_payload ? 'reporter_alias' then
    return jsonb_build_object('code', 'invalid_payload');
  end if;

  select room_id, reporter_id into v_room, v_reporter
  from public.moderation_reports where id = p_report_id;
  if not found then
    return jsonb_build_object('code', 'not_found');
  end if;

  if not exists (
    select 1 from public.rooms r
    where r.id = v_room and r.owner_id = v_caller
  ) and not exists (
    select 1 from public.room_moderators rm
    where rm.room_id = v_room and rm.user_id = v_caller
  ) then
    return jsonb_build_object('code', 'not_found');
  end if;

  -- The reporter is told the outcome, never the moderator's identity.
  select notification_prefs into v_prefs
  from public.profiles where id = v_reporter;
  if not found then
    return jsonb_build_object('code', 'not_found');
  end if;

  v_category := 'moderation';
  v_pref := coalesce(v_prefs ->> v_category, v_prefs ->> 'default', 'all');
  if v_pref not in ('all', 'mentions_and_invites', 'none') then
    v_pref := 'all';
  end if;
  if v_pref = 'none' or v_pref = 'mentions_and_invites' then
    return jsonb_build_object('code', 'muted');
  end if;

  if p_dedupe_key is not null then
    update public.notifications
      set created_at = now(),
          payload = p_payload,
          room_id = coalesce(v_room, room_id)
      where user_id = v_reporter
        and dedupe_key = p_dedupe_key
        and read_at is null
      returning id into v_id;

    if v_id is not null then
      return jsonb_build_object('code', 'deduped', 'id', v_id);
    end if;
  end if;

  begin
    insert into public.notifications (user_id, type, room_id, payload, dedupe_key)
    values (v_reporter, p_type, v_room, p_payload, p_dedupe_key)
    returning id into v_id;
  exception when unique_violation then
    update public.notifications
      set created_at = now(),
          payload = p_payload,
          room_id = coalesce(v_room, room_id)
      where user_id = v_reporter
        and dedupe_key = p_dedupe_key
        and read_at is null
      returning id into v_id;
    if v_id is not null then
      return jsonb_build_object('code', 'deduped', 'id', v_id);
    end if;
    raise;
  end;

  return jsonb_build_object('code', 'created', 'id', v_id);
end;
$$;

revoke execute on function public.push_report_notification(uuid, text, jsonb, text)
  from public, anon;
grant execute on function public.push_report_notification(uuid, text, jsonb, text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- notifications_unread_count: the badge's cheap read. Invoker's-rights —
-- RLS narrows the count to the caller's own rows, so there is no definer
-- surface and no way to ask about anyone else. One indexed count over the
-- partial unread index.
-- ---------------------------------------------------------------------------

create or replace function public.notifications_unread_count()
returns integer
language sql
stable
set search_path = ''
as $$
  select count(*)::int
  from public.notifications
  where user_id = (select auth.uid())
    and read_at is null;
$$;

revoke execute on function public.notifications_unread_count() from public, anon;
grant execute on function public.notifications_unread_count() to authenticated;

-- ---------------------------------------------------------------------------
-- prune_notifications: retention, operator-run. "Rows older than 90 days
-- are pruned" is only true if the function that does it exists; there is no
-- cron in this PR, so the function is granted to service_role only and a
-- human or an ops job calls it. Returns the number of rows removed.
-- ---------------------------------------------------------------------------

create or replace function public.prune_notifications(p_before timestamptz)
returns bigint
language sql
security definer
set search_path = ''
as $$
  with deleted as (
    delete from public.notifications
    where created_at < p_before
    returning 1
  )
  select count(*)::bigint from deleted;
$$;

revoke execute on function public.prune_notifications(timestamptz)
  from public, anon, authenticated;
grant execute on function public.prune_notifications(timestamptz) to service_role;

-- ---------------------------------------------------------------------------
-- Realtime: postgres_changes on the table, scoped by the subscriber's own
-- SELECT RLS — the exact mechanism chat uses for `room_messages`. No
-- broadcast channel and no per-user topic authorisation: a frame is only
-- delivered for a row the subscriber could read with a plain SELECT, so
-- learning another user's payload via the socket is the same impossibility
-- as reading it via PostgREST.
-- ---------------------------------------------------------------------------

alter publication supabase_realtime add table public.notifications;
