-- 0009_moderation.sql
-- Reports, blocks, member removal, mutes, moderator roles, audit trail.
--
-- Shape of this migration (reconciled decisions — see
-- docs/prs/PR-09-moderation.md "Reconciliation"):
--
--   1. Alias is the only identity that ever appears in a request or a
--      response. User uuids resolve to aliases (and back) only inside these
--      SECURITY DEFINER functions, because PR 07 established that no payload
--      carries a user id and `profiles` is RLS own-only for direct reads.
--   2. Every privileged mutation writes exactly one `moderation_actions` row
--      in the same transaction as the mutation itself. That guarantee is what
--      forces RPC-only writes: `moderation_actions`, `moderation_reports`,
--      `room_moderators` and (for writes) `room_mutes` carry **no grants at
--      all**, so a direct PostgREST call cannot mutate them — let alone forge
--      an audit row. `reporter_id` therefore has no SELECT grant for any role;
--      the moderator listing is a function that never selects it.
--   3. Two tables are read by OTHER tables' row-level policies, and policy
--      subqueries run with the invoker's privileges (proven: a policy
--      referencing an ungranted table fails with "permission denied"). Those
--      two — `user_blocks` (the chat filter) and `room_mutes` (the send
--      gate) — get narrow SELECT grants plus own-row policies. Everything
--      else is deny-by-default: RLS enabled, zero policies, zero grants.
--   4. Chat stays append-only. There is no soft-hide: `room_messages` keeps
--      exactly its SELECT/INSERT grants from 0004. The only changes here are
--      two functionally-narrowing clauses on its existing policies:
--        * SELECT gains "and not blocked by auth.uid()" — one clause covers
--          history reads, direct selects and realtime delivery (Realtime
--          enforces the subscriber's SELECT RLS, as 0004 already documents).
--        * INSERT gains "and not muted" — a mute is enforced by the database,
--          not by a route that could be skipped.
--   5. Cross-PR touch: `accept_room_invitation` (0007) is re-created here
--      with a block check — a blocker cannot be invited by the person they
--      blocked. The 0007 file stays untouched on disk; PR 07 has merged, so
--      the spec's "if PR 07 has merged, add the check in this PR's migration"
--      sequencing applies.
--
-- Identity is always `auth.uid()`; no actor, reporter or blocker id is ever a
-- parameter. `set search_path = ''` pins the search path and every reference
-- is schema-qualified. Execute is revoked from PUBLIC and anon, granted only
-- to authenticated. `moderation_reports.status` flows
-- pending -> reviewing -> resolved | dismissed; the partial unique index
-- deduplicates a reporter's open reports. `room_mutes` uniqueness is total
-- per (room, user) — a partial index predicate `muted_until > now()` is not
-- immutable, so the RPC sweeps expired rows instead of relying on the index.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- A report is about one subject in one room. subject_id is polymorphic (user
-- uuid | message uuid | resource uuid), so it carries no FK by design; the
-- RPC is what proves the subject existed in that room at report time. If the
-- subject row later disappears (a resource the uploader deleted), the report
-- remains readable with its reason and detail — reports are statements about
-- the past, not live references.
create table public.moderation_reports (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  subject_type text not null
    constraint moderation_reports_subject_type_check
    check (subject_type in ('user', 'message', 'resource')),
  subject_id uuid not null,
  subject_user_id uuid references auth.users (id) on delete set null,
  reporter_id uuid not null references auth.users (id) on delete cascade,
  reason text not null
    constraint moderation_reports_reason_check
    check (reason in (
      'spam', 'harassment', 'abusive_content', 'inappropriate_content',
      'impersonation', 'unsafe_resource', 'other'
    )),
  detail text
    constraint moderation_reports_detail_check
    check (detail is null or char_length(detail) <= 500),
  status text not null default 'pending'
    constraint moderation_reports_status_check
    check (status in ('pending', 'reviewing', 'resolved', 'dismissed')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references auth.users (id) on delete set null
);

create index moderation_reports_room_status_idx
  on public.moderation_reports (room_id, status, created_at desc);

-- One open report per reporter per subject; repeats collapse to an
-- idempotent 200 at the API. Terminal reports do not block re-reporting.
create unique index moderation_reports_active_subject_idx
  on public.moderation_reports (reporter_id, subject_type, subject_id)
  where status in ('pending', 'reviewing');

-- The audit trail. Append-only by grants: there is no INSERT, UPDATE or
-- DELETE for any role — rows appear only because the definer RPCs above
-- write them inside the same transaction as the action they describe.
create table public.moderation_actions (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  actor_id uuid not null references auth.users (id) on delete cascade,
  action text not null
    constraint moderation_actions_action_check
    check (action in (
      'member_removed', 'mute_applied', 'mute_lifted',
      'moderator_appointed', 'moderator_revoked',
      'report_reviewed', 'report_resolved', 'report_dismissed'
    )),
  subject_user_id uuid references auth.users (id) on delete set null,
  subject_ref text,
  reason text
    constraint moderation_actions_reason_check
    check (reason is null or char_length(reason) <= 500),
  created_at timestamptz not null default now()
);

create index moderation_actions_room_created_idx
  on public.moderation_actions (room_id, created_at desc);

-- Owner-appointed, room-scoped moderator grants. Deleted with the room or
-- with the account; the granting owner is recorded for the audit trail.
create table public.room_moderators (
  room_id uuid not null references public.rooms (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  granted_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (room_id, user_id)
);

create index room_moderators_user_idx on public.room_moderators (user_id);

-- One live mute per member per room (total uniqueness — see header). The
-- RPC sweeps expired rows before inserting, so a stale row can never block
-- a new mute. muted_by goes NULL if the moderator's account is deleted; the
-- mute itself persists until lifted or the room disappears.
create table public.room_mutes (
  room_id uuid not null references public.rooms (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  muted_until timestamptz not null,
  muted_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (room_id, user_id)
);

-- One-directional blocks. The blocker's own list only; neither side is
-- notified, and both accounts cascade away cleanly.
create table public.user_blocks (
  blocker_id uuid not null references auth.users (id) on delete cascade,
  blocked_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  constraint user_blocks_not_self check (blocker_id <> blocked_id)
);

create index user_blocks_blocked_idx on public.user_blocks (blocked_id);

-- ---------------------------------------------------------------------------
-- Grants: revoke-first, then only what a policy actually needs to read.
-- ---------------------------------------------------------------------------

revoke all on table public.moderation_reports from public, anon, authenticated, service_role;
revoke all on table public.moderation_actions from public, anon, authenticated, service_role;
revoke all on table public.room_moderators from public, anon, authenticated, service_role;
revoke all on table public.room_mutes from public, anon, authenticated, service_role;
revoke all on table public.user_blocks from public, anon, authenticated, service_role;

-- No grants at all on reports, actions and moderators: every read and write
-- travels through a definer function, so `reporter_id` is structurally
-- unreachable and audit rows are structurally unforgeable.
-- The two policy-referenced tables need SELECT for the invoker:
grant select on table public.room_mutes to authenticated;
grant select on table public.user_blocks to authenticated;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.moderation_reports enable row level security;
alter table public.moderation_actions enable row level security;
alter table public.room_moderators enable row level security;
alter table public.room_mutes enable row level security;
alter table public.user_blocks enable row level security;

-- Deny-by-default: reports/actions/moderators carry zero policies on top of
-- zero grants (two independent layers, the repo's standard).
-- The two readable tables expose exactly the caller's own rows:
create policy "room_mutes_select_own" on public.room_mutes
  for select to authenticated
  using (user_id = auth.uid());

create policy "user_blocks_select_own" on public.user_blocks
  for select to authenticated
  using (blocker_id = auth.uid());

-- ---------------------------------------------------------------------------
-- room_messages: the two narrowed policies (0004 re-created verbatim plus
-- one conjunct each). Sender pinning and the membership conjunct are
-- byte-identical to 0004 — only the added clause restricts further.
-- ---------------------------------------------------------------------------

drop policy if exists "room_messages_select_member" on public.room_messages;
create policy "room_messages_select_member" on public.room_messages
  for select to authenticated
  using (
    exists (
      select 1 from public.room_members m
      where m.room_id = room_messages.room_id and m.user_id = auth.uid()
    )
    -- 0009: the blocker never sees the blocked user's messages. This clause
    -- also governs realtime delivery (RLS at delivery) and covers history
    -- reads, direct selects and live INSERTs with one server-side rule.
    and not exists (
      select 1 from public.user_blocks b
      where b.blocker_id = auth.uid()
        and b.blocked_id = room_messages.user_id
    )
  );

drop policy if exists "room_messages_insert_own_member" on public.room_messages;
create policy "room_messages_insert_own_member" on public.room_messages
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.room_members m
      where m.room_id = room_messages.room_id and m.user_id = auth.uid()
    )
    -- 0009: a mute is enforced by the database. Direct PostgREST inserts
    -- answer 42501 exactly like any other policy denial.
    and not exists (
      select 1 from public.room_mutes mu
      where mu.room_id = room_messages.room_id
        and mu.user_id = auth.uid()
        and mu.muted_until > now()
    )
  );

-- ---------------------------------------------------------------------------
-- Shared helpers, as local functions: authorization for the privileged RPCs
-- is one definition, not five copies. They run inside the definer functions
-- (search_path is pinned; every reference below is schema-qualified by
-- virtue of the pinned empty path plus explicit schema names).
-- ---------------------------------------------------------------------------

create or replace function public.moderation_actor_role(p_room_id uuid)
returns text
language sql
security definer
set search_path = ''
stable
as $$
  select case
    when exists (
      select 1 from public.rooms r
      where r.id = p_room_id and r.owner_id = auth.uid()
    ) then 'owner'
    when exists (
      select 1 from public.room_moderators rm
      where rm.room_id = p_room_id and rm.user_id = auth.uid()
    ) then 'moderator'
    when exists (
      select 1 from public.room_members m
      where m.room_id = p_room_id and m.user_id = auth.uid()
    ) then 'member'
    else 'none'
  end;
$$;

revoke execute on function public.moderation_actor_role(uuid) from public, anon;
grant execute on function public.moderation_actor_role(uuid) to authenticated;

create or replace function public.moderation_resolve_alias(p_alias text)
returns uuid
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  v_id uuid;
begin
  if p_alias is null or btrim(p_alias) = '' then
    return null;
  end if;
  select id into v_id from public.profiles where lower(alias) = lower(btrim(p_alias));
  return v_id;
end;
$$;

revoke execute on function public.moderation_resolve_alias(text) from public, anon;
grant execute on function public.moderation_resolve_alias(text) to authenticated;

-- ---------------------------------------------------------------------------
-- create_moderation_report: membership first, subject second, reporter pinned.
-- The route validates the strict body; the enum, length and self-report rules
-- are re-checked here because this function is reachable by any member.
-- ---------------------------------------------------------------------------

create or replace function public.create_moderation_report(
  p_room_id uuid,
  p_subject_type text,
  p_subject_ref text,
  p_reason text,
  p_detail text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_subject_id uuid;
  v_subject_user uuid;
  v_report public.moderation_reports;
begin
  if v_user_id is null then
    raise exception 'create_moderation_report requires an authenticated user'
      using errcode = '42501';
  end if;

  if p_room_id is null or p_subject_type is null
     or p_subject_ref is null or p_reason is null then
    return jsonb_build_object('code', 'validation');
  end if;

  -- Membership BEFORE any subject lookup: a non-member cannot use subjects
  -- as an existence oracle, and reports about rooms they cannot see are
  -- structurally impossible.
  if not exists (
    select 1 from public.room_members m
    where m.room_id = p_room_id and m.user_id = v_user_id
  ) then
    return jsonb_build_object('code', 'not_found');
  end if;

  if p_subject_type not in ('user', 'message', 'resource')
     or p_reason not in (
       'spam', 'harassment', 'abusive_content', 'inappropriate_content',
       'impersonation', 'unsafe_resource', 'other'
     )
     or (p_detail is not null and char_length(p_detail) > 500)
  then
    return jsonb_build_object('code', 'validation');
  end if;

  if p_subject_type = 'user' then
    v_subject_id := public.moderation_resolve_alias(p_subject_ref);
    if v_subject_id is null then
      return jsonb_build_object('code', 'not_found');
    end if;
    if not exists (
      select 1 from public.room_members m
      where m.room_id = p_room_id and m.user_id = v_subject_id
    ) then
      return jsonb_build_object('code', 'not_found');
    end if;
  elsif p_subject_type = 'message' then
    begin
      v_subject_id := p_subject_ref::uuid;
    exception when invalid_text_representation then
      return jsonb_build_object('code', 'invalid_subject');
    end;
    select user_id into v_subject_user
    from public.room_messages
    where id = v_subject_id and room_id = p_room_id;
    if not found then
      return jsonb_build_object('code', 'not_found');
    end if;
  else
    begin
      v_subject_id := p_subject_ref::uuid;
    exception when invalid_text_representation then
      return jsonb_build_object('code', 'invalid_subject');
    end;
    select owner_id into v_subject_user
    from public.study_resources
    where id = v_subject_id and room_id = p_room_id;
    if not found then
      return jsonb_build_object('code', 'not_found');
    end if;
  end if;

  if p_subject_type = 'user' then
    v_subject_user := v_subject_id;
  end if;

  -- Reporting yourself (your account, your message, your file) is always a
  -- mistake or an attack on your own record; refuse it explicitly.
  if v_subject_user = v_user_id then
    return jsonb_build_object('code', 'self_report');
  end if;

  select * into v_report
  from public.moderation_reports
  where reporter_id = v_user_id
    and subject_type = p_subject_type
    and subject_id = v_subject_id
    and status in ('pending', 'reviewing');

  if found then
    return jsonb_build_object(
      'code', 'duplicate', 'id', v_report.id, 'status', v_report.status
    );
  end if;

  begin
    insert into public.moderation_reports (
      room_id, subject_type, subject_id, subject_user_id,
      reporter_id, reason, detail
    )
    values (
      p_room_id, p_subject_type, v_subject_id, v_subject_user,
      v_user_id, p_reason, nullif(btrim(coalesce(p_detail, '')), '')
    )
    returning id, created_at into v_report.id, v_report.created_at;
  exception
    when unique_violation then
      -- Lost a race with an identical report; collapse to the same answer.
      select * into v_report
      from public.moderation_reports
      where reporter_id = v_user_id
        and subject_type = p_subject_type
        and subject_id = v_subject_id
        and status in ('pending', 'reviewing');
      return jsonb_build_object(
        'code', 'duplicate', 'id', v_report.id, 'status', v_report.status
      );
    when check_violation or not_null_violation then
      return jsonb_build_object('code', 'validation');
  end;

  return jsonb_build_object(
    'code', 'created',
    'id', v_report.id,
    'status', 'pending',
    'created_at', v_report.created_at
  );
end;
$$;

revoke execute on function public.create_moderation_report(uuid, text, text, text, text)
  from public, anon;
grant execute on function public.create_moderation_report(uuid, text, text, text, text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- set_moderation_report_status: moderator-only transition, one audit row.
-- Unauthorized callers receive the same not_found as a missing report — a
-- report id is opaque, so 403 would confirm existence.
-- ---------------------------------------------------------------------------

create or replace function public.set_moderation_report_status(
  p_report_id uuid,
  p_status text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_report public.moderation_reports;
begin
  if v_user_id is null then
    raise exception 'set_moderation_report_status requires an authenticated user'
      using errcode = '42501';
  end if;

  if p_report_id is null or p_status is null then
    return jsonb_build_object('code', 'validation');
  end if;

  select * into v_report from public.moderation_reports where id = p_report_id;
  if not found then
    return jsonb_build_object('code', 'not_found');
  end if;

  -- Authorize against the report's room; not_found for everyone who is not
  -- the owner or an appointed moderator of that exact room.
  if public.moderation_actor_role(v_report.room_id) not in ('owner', 'moderator') then
    return jsonb_build_object('code', 'not_found');
  end if;

  if p_status not in ('reviewing', 'resolved', 'dismissed') then
    return jsonb_build_object('code', 'validation');
  end if;

  if not (
    (v_report.status = 'pending' and p_status in ('reviewing', 'resolved', 'dismissed'))
    or (v_report.status = 'reviewing' and p_status in ('resolved', 'dismissed'))
  ) then
    return jsonb_build_object('code', 'invalid_transition');
  end if;

  update public.moderation_reports
  set status = p_status,
      resolved_at = case
        when p_status in ('resolved', 'dismissed') then now()
        else null
      end,
      resolved_by = case
        when p_status in ('resolved', 'dismissed') then v_user_id
        else null
      end
  where id = p_report_id
  returning * into v_report;

  insert into public.moderation_actions (
    room_id, actor_id, action, subject_user_id, subject_ref, reason
  )
  values (
    v_report.room_id,
    v_user_id,
    case p_status
      when 'resolved' then 'report_resolved'
      when 'dismissed' then 'report_dismissed'
      else 'report_reviewed'
    end,
    v_report.subject_user_id,
    v_report.subject_id::text,
    v_report.reason
  );

  return jsonb_build_object(
    'code', 'updated', 'id', v_report.id, 'status', v_report.status
  );
end;
$$;

revoke execute on function public.set_moderation_report_status(uuid, text)
  from public, anon;
grant execute on function public.set_moderation_report_status(uuid, text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- room_report_list: the moderator inbox. Definer, so it reads tables that
-- carry no grants, resolves subject aliases inside the server, and builds
-- the payload explicitly — reporter_id is never selected, so it cannot leak
-- into a response by accident.
-- ---------------------------------------------------------------------------

create or replace function public.room_report_list(p_room_id uuid, p_limit int default 50)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_limit int;
begin
  if v_user_id is null then
    raise exception 'room_report_list requires an authenticated user'
      using errcode = '42501';
  end if;

  if p_room_id is null then
    return jsonb_build_object('code', 'not_found');
  end if;

  if public.moderation_actor_role(p_room_id) = 'none' then
    return jsonb_build_object('code', 'not_found');
  end if;

  if public.moderation_actor_role(p_room_id) not in ('owner', 'moderator') then
    return jsonb_build_object('code', 'not_moderator');
  end if;

  v_limit := least(greatest(coalesce(p_limit, 50), 1), 100);

  return jsonb_build_object(
    'code', 'ok',
    'reports', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', r.id,
          'subject_type', r.subject_type,
          'subject_id', r.subject_id,
          'subject_alias', (
            select p.alias from public.profiles p where p.id = r.subject_user_id
          ),
          'reason', r.reason,
          'detail', r.detail,
          'status', r.status,
          'created_at', r.created_at,
          'resolved_at', r.resolved_at,
          'resolved_by', (
            select p.alias from public.profiles p where p.id = r.resolved_by
          )
        )
        order by r.created_at desc
      )
      from public.moderation_reports r
      where r.room_id = p_room_id
      limit v_limit
    ), '[]'::jsonb)
  );
end;
$$;

revoke execute on function public.room_report_list(uuid, int) from public, anon;
grant execute on function public.room_report_list(uuid, int) to authenticated;

-- ---------------------------------------------------------------------------
-- remove_room_member: owner or moderator removes a member — never the owner,
-- never themselves. The room row lock serialises with join_room_core (a
-- concurrent join either lands before, and is removed with everyone else's
-- count, or lands after, and sees the room without the removed seat). The
-- member's moderator grant and active mute are swept with the membership:
-- both are room-scoped privileges that mean nothing without membership.
-- ---------------------------------------------------------------------------

create or replace function public.remove_room_member(
  p_room_id uuid,
  p_member_alias text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_room public.rooms;
  v_target uuid;
  v_count bigint;
begin
  if v_user_id is null then
    raise exception 'remove_room_member requires an authenticated user'
      using errcode = '42501';
  end if;

  if p_room_id is null or p_member_alias is null then
    return jsonb_build_object('code', 'validation');
  end if;

  select * into v_room from public.rooms where id = p_room_id for update;
  if not found then
    return jsonb_build_object('code', 'not_found');
  end if;

  -- Actor gate first: non-members answer not_found (identical to a missing
  -- room), members who are neither owner nor moderator answer not_moderator.
  if v_room.owner_id <> v_user_id then
    if not exists (
      select 1 from public.room_members m
      where m.room_id = p_room_id and m.user_id = v_user_id
    ) then
      return jsonb_build_object('code', 'not_found');
    end if;
    if not exists (
      select 1 from public.room_moderators rm
      where rm.room_id = p_room_id and rm.user_id = v_user_id
    ) then
      return jsonb_build_object('code', 'not_moderator');
    end if;
  end if;

  v_target := public.moderation_resolve_alias(p_member_alias);
  if v_target is null then
    return jsonb_build_object('code', 'not_found');
  end if;

  if not exists (
    select 1 from public.room_members m
    where m.room_id = p_room_id and m.user_id = v_target
  ) then
    return jsonb_build_object('code', 'not_found');
  end if;

  if v_target = v_room.owner_id then
    return jsonb_build_object('code', 'cannot_remove_owner');
  end if;

  if v_target = v_user_id then
    return jsonb_build_object('code', 'cannot_remove_self');
  end if;

  delete from public.room_members
  where room_id = p_room_id and user_id = v_target;

  delete from public.room_moderators
  where room_id = p_room_id and user_id = v_target;

  delete from public.room_mutes
  where room_id = p_room_id and user_id = v_target;

  select count(*) into v_count
  from public.room_members
  where room_id = p_room_id;

  insert into public.moderation_actions (
    room_id, actor_id, action, subject_user_id, subject_ref, reason
  )
  values (p_room_id, v_user_id, 'member_removed', v_target, p_member_alias, null);

  return jsonb_build_object('code', 'removed', 'member_count', v_count);
end;
$$;

revoke execute on function public.remove_room_member(uuid, text) from public, anon;
grant execute on function public.remove_room_member(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- mute_room_member / unmute_room_member: bounded durations, refuse privileged
-- targets, one audit row each. The mute bites at the room_messages INSERT
-- policy — this function only records it.
-- ---------------------------------------------------------------------------

create or replace function public.mute_room_member(
  p_room_id uuid,
  p_member_alias text,
  p_interval interval
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_room public.rooms;
  v_target uuid;
  v_until timestamptz;
begin
  if v_user_id is null then
    raise exception 'mute_room_member requires an authenticated user'
      using errcode = '42501';
  end if;

  if p_room_id is null or p_member_alias is null or p_interval is null then
    return jsonb_build_object('code', 'validation');
  end if;

  select * into v_room from public.rooms where id = p_room_id for update;
  if not found then
    return jsonb_build_object('code', 'not_found');
  end if;

  if v_room.owner_id <> v_user_id then
    if not exists (
      select 1 from public.room_members m
      where m.room_id = p_room_id and m.user_id = v_user_id
    ) then
      return jsonb_build_object('code', 'not_found');
    end if;
    if not exists (
      select 1 from public.room_moderators rm
      where rm.room_id = p_room_id and rm.user_id = v_user_id
    ) then
      return jsonb_build_object('code', 'not_moderator');
    end if;
  end if;

  -- The product offers exactly three durations; anything else (including a
  -- hand-crafted interval) is a contract violation, not a feature.
  if p_interval not in (interval '1 hour', interval '24 hours', interval '7 days') then
    return jsonb_build_object('code', 'validation');
  end if;

  v_target := public.moderation_resolve_alias(p_member_alias);
  if v_target is null then
    return jsonb_build_object('code', 'not_found');
  end if;

  if not exists (
    select 1 from public.room_members m
    where m.room_id = p_room_id and m.user_id = v_target
  ) then
    return jsonb_build_object('code', 'not_found');
  end if;

  -- Self is checked first: the actor is by definition an owner or
  -- moderator (the gate above), so a self-target would otherwise always be
  -- caught by the owner/moderator rules below and `cannot_mute_self` could
  -- never fire. The specific refusal for *your own* action comes first.
  if v_target = v_user_id then
    return jsonb_build_object('code', 'cannot_mute_self');
  end if;

  if v_target = v_room.owner_id then
    return jsonb_build_object('code', 'cannot_mute_owner');
  end if;

  if exists (
    select 1 from public.room_moderators rm
    where rm.room_id = p_room_id and rm.user_id = v_target
  ) then
    return jsonb_build_object('code', 'cannot_mute_moderator');
  end if;

  if exists (
    select 1 from public.room_mutes mu
    where mu.room_id = p_room_id and mu.user_id = v_target
      and mu.muted_until > now()
  ) then
    return jsonb_build_object('code', 'already_muted');
  end if;

  -- Sweep any expired row so the total unique index stays honest.
  delete from public.room_mutes
  where room_id = p_room_id and user_id = v_target;

  v_until := now() + p_interval;
  insert into public.room_mutes (room_id, user_id, muted_until, muted_by)
  values (p_room_id, v_target, v_until, v_user_id);

  insert into public.moderation_actions (
    room_id, actor_id, action, subject_user_id, subject_ref, reason
  )
  values (p_room_id, v_user_id, 'mute_applied', v_target, p_member_alias, null);

  return jsonb_build_object('code', 'muted', 'muted_until', v_until);
end;
$$;

revoke execute on function public.mute_room_member(uuid, text, interval) from public, anon;
grant execute on function public.mute_room_member(uuid, text, interval) to authenticated;

create or replace function public.unmute_room_member(
  p_room_id uuid,
  p_member_alias text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_room public.rooms;
  v_target uuid;
begin
  if v_user_id is null then
    raise exception 'unmute_room_member requires an authenticated user'
      using errcode = '42501';
  end if;

  if p_room_id is null or p_member_alias is null then
    return jsonb_build_object('code', 'validation');
  end if;

  select * into v_room from public.rooms where id = p_room_id for update;
  if not found then
    return jsonb_build_object('code', 'not_found');
  end if;

  if v_room.owner_id <> v_user_id then
    if not exists (
      select 1 from public.room_members m
      where m.room_id = p_room_id and m.user_id = v_user_id
    ) then
      return jsonb_build_object('code', 'not_found');
    end if;
    if not exists (
      select 1 from public.room_moderators rm
      where rm.room_id = p_room_id and rm.user_id = v_user_id
    ) then
      return jsonb_build_object('code', 'not_moderator');
    end if;
  end if;

  v_target := public.moderation_resolve_alias(p_member_alias);
  if v_target is null then
    return jsonb_build_object('code', 'not_found');
  end if;

  if not exists (
    select 1 from public.room_mutes mu
    where mu.room_id = p_room_id and mu.user_id = v_target
      and mu.muted_until > now()
  ) then
    return jsonb_build_object('code', 'not_muted');
  end if;

  delete from public.room_mutes
  where room_id = p_room_id and user_id = v_target;

  insert into public.moderation_actions (
    room_id, actor_id, action, subject_user_id, subject_ref, reason
  )
  values (p_room_id, v_user_id, 'mute_lifted', v_target, p_member_alias, null);

  return jsonb_build_object('code', 'unmuted');
end;
$$;

revoke execute on function public.unmute_room_member(uuid, text) from public, anon;
grant execute on function public.unmute_room_member(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- set_room_moderator: owner only. A moderator cannot mint moderators, and an
-- owner appointing themselves is refused because they already are the owner.
-- No-op calls (already in the requested state) answer changed:false and write
-- no audit row — a row means something happened.
-- ---------------------------------------------------------------------------

create or replace function public.set_room_moderator(
  p_room_id uuid,
  p_member_alias text,
  p_on boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_room public.rooms;
  v_target uuid;
begin
  if v_user_id is null then
    raise exception 'set_room_moderator requires an authenticated user'
      using errcode = '42501';
  end if;

  if p_room_id is null or p_member_alias is null or p_on is null then
    return jsonb_build_object('code', 'validation');
  end if;

  select * into v_room from public.rooms where id = p_room_id for update;
  if not found then
    return jsonb_build_object('code', 'not_found');
  end if;

  if v_room.owner_id <> v_user_id then
    if not exists (
      select 1 from public.room_members m
      where m.room_id = p_room_id and m.user_id = v_user_id
    ) then
      return jsonb_build_object('code', 'not_found');
    end if;
    -- Moderators may not appoint moderators; owners may.
    return jsonb_build_object('code', 'not_owner');
  end if;

  v_target := public.moderation_resolve_alias(p_member_alias);
  if v_target is null then
    return jsonb_build_object('code', 'not_found');
  end if;

  if not exists (
    select 1 from public.room_members m
    where m.room_id = p_room_id and m.user_id = v_target
  ) then
    return jsonb_build_object('code', 'not_found');
  end if;

  if v_target = v_room.owner_id then
    return jsonb_build_object('code', 'cannot_moderate_owner');
  end if;

  if p_on then
    if exists (
      select 1 from public.room_moderators rm
      where rm.room_id = p_room_id and rm.user_id = v_target
    ) then
      return jsonb_build_object(
        'code', 'unchanged', 'role', 'moderator', 'changed', false
      );
    end if;

    insert into public.room_moderators (room_id, user_id, granted_by)
    values (p_room_id, v_target, v_user_id);

    insert into public.moderation_actions (
      room_id, actor_id, action, subject_user_id, subject_ref, reason
    )
    values (p_room_id, v_user_id, 'moderator_appointed', v_target, p_member_alias, null);

    return jsonb_build_object(
      'code', 'updated', 'role', 'moderator', 'changed', true
    );
  end if;

  if not exists (
    select 1 from public.room_moderators rm
    where rm.room_id = p_room_id and rm.user_id = v_target
  ) then
    return jsonb_build_object(
      'code', 'unchanged', 'role', 'student', 'changed', false
    );
  end if;

  delete from public.room_moderators
  where room_id = p_room_id and user_id = v_target;

  insert into public.moderation_actions (
    room_id, actor_id, action, subject_user_id, subject_ref, reason
  )
  values (p_room_id, v_user_id, 'moderator_revoked', v_target, p_member_alias, null);

  return jsonb_build_object('code', 'updated', 'role', 'student', 'changed', true);
end;
$$;

revoke execute on function public.set_room_moderator(uuid, text, boolean) from public, anon;
grant execute on function public.set_room_moderator(uuid, text, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- Blocks: caller-anchored, alias-addressed, idempotent. Neither party is
-- notified; the only observable effect is the chat filter and invite refusal.
-- ---------------------------------------------------------------------------

create or replace function public.create_user_block(p_alias text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_target uuid;
  v_stored_alias text;
  v_created timestamptz;
begin
  if v_user_id is null then
    raise exception 'create_user_block requires an authenticated user'
      using errcode = '42501';
  end if;

  if p_alias is null or btrim(p_alias) = '' then
    return jsonb_build_object('code', 'validation');
  end if;

  select id, alias into v_target, v_stored_alias
  from public.profiles
  where lower(alias) = lower(btrim(p_alias));

  if v_target is null then
    return jsonb_build_object('code', 'not_found');
  end if;

  if v_target = v_user_id then
    return jsonb_build_object('code', 'self_block');
  end if;

  insert into public.user_blocks (blocker_id, blocked_id)
  values (v_user_id, v_target)
  on conflict (blocker_id, blocked_id) do nothing
  returning created_at into v_created;

  if v_created is null then
    select created_at into v_created
    from public.user_blocks
    where blocker_id = v_user_id and blocked_id = v_target;
    return jsonb_build_object(
      'code', 'exists', 'alias', v_stored_alias, 'created_at', v_created
    );
  end if;

  return jsonb_build_object(
    'code', 'created', 'alias', v_stored_alias, 'created_at', v_created
  );
end;
$$;

revoke execute on function public.create_user_block(text) from public, anon;
grant execute on function public.create_user_block(text) to authenticated;

create or replace function public.delete_user_block(p_alias text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_target uuid;
  v_removed boolean;
begin
  if v_user_id is null then
    raise exception 'delete_user_block requires an authenticated user'
      using errcode = '42501';
  end if;

  if p_alias is null or btrim(p_alias) = '' then
    return jsonb_build_object('code', 'validation');
  end if;

  v_target := public.moderation_resolve_alias(p_alias);
  if v_target is null then
    return jsonb_build_object('code', 'not_found');
  end if;

  delete from public.user_blocks
  where blocker_id = v_user_id and blocked_id = v_target;

  v_removed := found;
  return jsonb_build_object('code', 'removed', 'removed', v_removed);
end;
$$;

revoke execute on function public.delete_user_block(text) from public, anon;
grant execute on function public.delete_user_block(text) to authenticated;

create or replace function public.list_my_blocks()
returns table (alias text, created_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'list_my_blocks requires an authenticated user'
      using errcode = '42501';
  end if;

  return query
    select p.alias, b.created_at
    from public.user_blocks b
    join public.profiles p on p.id = b.blocked_id
    where b.blocker_id = v_user_id
    order by b.created_at desc;
end;
$$;

revoke execute on function public.list_my_blocks() from public, anon;
grant execute on function public.list_my_blocks() to authenticated;

-- ---------------------------------------------------------------------------
-- room_moderation_info: what the room page needs to gate the inbox and the
-- roster menus, in one definer call — moderator aliases (never ids), mute
-- state, and the caller's own mute flag so the composer can explain itself
-- before the first failed send.
-- ---------------------------------------------------------------------------

create or replace function public.room_moderation_info(p_room_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_role text;
  v_muted_until timestamptz;
begin
  if v_user_id is null then
    raise exception 'room_moderation_info requires an authenticated user'
      using errcode = '42501';
  end if;

  if p_room_id is null then
    raise exception 'permission denied for room moderation'
      using errcode = '42501';
  end if;

  v_role := public.moderation_actor_role(p_room_id);
  if v_role = 'none' then
    raise exception 'permission denied for room moderation'
      using errcode = '42501';
  end if;

  select muted_until into v_muted_until
  from public.room_mutes
  where room_id = p_room_id and user_id = v_user_id
    and muted_until > now();

  return jsonb_build_object(
    'can_moderate', v_role in ('owner', 'moderator'),
    'moderator_aliases', coalesce((
      select jsonb_agg(p.alias order by p.alias)
      from public.room_moderators rm
      join public.profiles p on p.id = rm.user_id
      where rm.room_id = p_room_id
    ), '[]'::jsonb),
    'muted_aliases', case
      when v_role in ('owner', 'moderator') then coalesce((
        select jsonb_agg(p.alias order by p.alias)
        from public.room_mutes mu
        join public.profiles p on p.id = mu.user_id
        where mu.room_id = p_room_id and mu.muted_until > now()
      ), '[]'::jsonb)
      else '[]'::jsonb
    end,
    'viewer_is_muted', v_muted_until is not null,
    'muted_until', v_muted_until
  );
end;
$$;

revoke execute on function public.room_moderation_info(uuid) from public, anon;
grant execute on function public.room_moderation_info(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- accept_room_invitation (0007 re-created): unchanged except the block check
-- after the expiry gate. A blocker cannot be invited by the person they
-- blocked; the invitation stays pending, the blocker is never notified, and
-- the blocked caller only learns that this invitation is not usable. The
-- original file in 0007 stays untouched on disk — this is the cross-PR touch
-- the PR-09 spec explicitly allowed once PR 07 had merged.
-- ---------------------------------------------------------------------------

create or replace function public.accept_room_invitation(p_invitation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_inv public.room_invitations;
  v_join jsonb;
  v_code text;
  v_members bigint;
  v_room_name text;
begin
  if v_user_id is null then
    raise exception 'room invitations require an authenticated user' using errcode = '42501';
  end if;

  if p_invitation_id is null then
    return jsonb_build_object('code', 'not_found');
  end if;

  select * into v_inv
  from public.room_invitations
  where id = p_invitation_id
  for update;

  -- A stranger's invitation and a nonexistent id answer identically.
  if not found or v_inv.invitee_id <> v_user_id then
    return jsonb_build_object('code', 'not_found');
  end if;

  if v_inv.status = 'accepted' then
    return jsonb_build_object('code', 'used');
  elsif v_inv.status = 'rejected' then
    return jsonb_build_object('code', 'rejected');
  elsif v_inv.status = 'revoked' then
    return jsonb_build_object('code', 'revoked');
  end if;

  -- Pending: expiry is evaluated at the moment of use, never stored.
  if v_inv.expires_at <= now() then
    return jsonb_build_object('code', 'expired');
  end if;

  -- 0009: the inviter blocked the invitee — the invitation is not usable.
  -- Deliberately a distinct code with a neutral message: the blocked party
  -- learns only that this invitation failed, never why or by whom.
  if exists (
    select 1 from public.user_blocks b
    where b.blocker_id = v_inv.inviter_id
      and b.blocked_id = v_user_id
  ) then
    return jsonb_build_object('code', 'blocked');
  end if;

  -- Already a member (another invitation for the same room, or the owner
  -- row): consume this invitation and report the idempotent outcome, with
  -- the room identifiers the client needs to land in the workspace.
  if exists (
    select 1 from public.room_members m
    where m.room_id = v_inv.room_id and m.user_id = v_user_id
  ) then
    update public.room_invitations
      set status = 'accepted', resolved_at = now()
      where id = v_inv.id;

    select count(*) into v_members
    from public.room_members where room_id = v_inv.room_id;

    select name into v_room_name from public.rooms where id = v_inv.room_id;

    return jsonb_build_object(
      'code', 'already_member',
      'room_id', v_inv.room_id,
      'room_name', v_room_name,
      'member_count', v_members
    );
  end if;

  -- The one seat implementation, now with the private gate opened because
  -- everything above has proved this caller is addressed a live invitation
  -- for this exact room.
  v_join := public.join_room_core(v_inv.room_id, v_user_id, true);
  v_code := v_join->>'code';

  if v_code = 'joined' then
    update public.room_invitations
      set status = 'accepted', resolved_at = now()
      where id = v_inv.id;

    select name into v_room_name from public.rooms where id = v_inv.room_id;

    return jsonb_build_object(
      'code', 'joined',
      'room_id', v_inv.room_id,
      'room_name', v_room_name,
      'member_count', (v_join->>'member_count')::bigint
    );
  elsif v_code = 'already_member' then
    -- Raced another join between the check above and the core's lock.
    update public.room_invitations
      set status = 'accepted', resolved_at = now()
      where id = v_inv.id;

    select name into v_room_name from public.rooms where id = v_inv.room_id;

    return jsonb_build_object(
      'code', 'already_member',
      'room_id', v_inv.room_id,
      'room_name', v_room_name,
      'member_count', (v_join->>'member_count')::bigint
    );
  elsif v_code = 'room_full' or v_code = 'room_closed' then
    -- The invitation stays pending: a seat may free up, and only the owner
    -- can decide the room is done. The caller keeps a truthful retry path.
    return v_join;
  end if;

  -- room_not_found underneath: the room vanished mid-transaction.
  return jsonb_build_object('code', 'not_found');
end;
$$;

-- Grants already exist from 0007; CREATE OR REPLACE preserves them.
