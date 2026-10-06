-- SDYROOM 0002_room_membership: join_room, leave_room and public occupancy.
-- Local-only target: `npx supabase db reset` / `npx supabase db push --local`.
-- 0001_init.sql is already applied and is never edited: this file only adds.
--
-- Membership rules encoded below
-- ------------------------------
--   * any authenticated student may join an open public room;
--   * a private room is reported as missing unless the caller is already in
--     it, so the public join endpoint never reveals that it exists;
--   * the owner is already a member through create_room, so joining again is
--     an idempotent "already_member" and never a duplicate row;
--   * capacity counts the owner, is never exceeded, and the check shares a
--     lock with the insert;
--   * closed rooms accept no new members;
--   * a student may leave their own student membership and rejoin later;
--   * the owner cannot leave while they remain responsible for the room;
--   * neither function accepts a user id: identity always comes from
--     auth.uid().
--
-- Why SECURITY DEFINER (and why the table grants stay as they are)
-- ----------------------------------------------------------------
-- `room_members` is granted INSERT and SELECT only. Its single insert policy,
-- `room_members_insert_owner_self`, lets an owner add their own owner row — so
-- a student still cannot write a membership directly, and there is no DELETE
-- grant at all. Two things that joining needs cannot be expressed that way:
--
--   1. a capacity check that is *atomic* with the insert. An RLS `with check`
--      cannot take a row lock, so two students racing for the last seat could
--      both pass a count and then both insert, exceeding capacity.
--   2. an insert of a `student` row, which the existing policy deliberately
--      forbids for everyone but a room's owner.
--
-- So the operations live in functions that run as their owner, with
-- `search_path` pinned empty and every reference schema-qualified. The
-- constraints on that choice are deliberate:
--
--   * execution is revoked from PUBLIC and anon and granted only to
--     `authenticated`, exactly like create_room;
--   * the body is a fixed plpgsql/SQL block over `public.rooms` and
--     `public.room_members` only — no dynamic SQL, no writes to `auth.users`,
--     no reference to any schema beyond `auth.uid()`;
--   * identity is read from `auth.uid()` and validated as non-null before any
--     write;
--   * no table grant or policy changes, so direct PostgREST writes keep
--     failing: INSERT hits `rooms`/`room_members` RLS with 42501, DELETE hits
--     the missing DELETE grant with 42501. Capacity cannot be bypassed by
--     writing rows, because no client can write them at all;
--   * the owner cannot be reduced to a custom role: any role that is not the
--     table owner is itself subject to RLS and could not make the very insert
--     this function exists to authorise, while BYPASSRLS would be a wider
--     privilege than the current one. The owner is therefore the migration
--     role (the table owner), which is the narrowest role that can work.
--
-- Room rows are locked with `select ... for update` inside join_room, so every
-- concurrent join for the same room serialises on one lock: the count and the
-- insert that follows it happen under that lock, and PostgREST runs each
-- request in its own transaction, so a later waiter re-reads the committed
-- rows before counting. Two students racing for the last slot cannot both
-- succeed. leave_room takes no lock: deleting a row can only free a seat, and
-- inserts are already serialised by the room lock.

create or replace function public.join_room(p_room_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_room public.rooms;
  v_role text;
  v_members bigint;
begin
  if v_user_id is null then
    raise exception 'join_room requires an authenticated user' using errcode = '42501';
  end if;

  if p_room_id is null then
    return jsonb_build_object('code', 'room_not_found', 'member_count', null);
  end if;

  -- Serialise every join for this room. The capacity count and the insert
  -- below both happen while this lock is held.
  select * into v_room from public.rooms where id = p_room_id for update;

  if not found then
    return jsonb_build_object('code', 'room_not_found', 'member_count', null);
  end if;

  select m.role into v_role
  from public.room_members m
  where m.room_id = p_room_id and m.user_id = v_user_id;

  -- A private room is indistinguishable from a missing one unless the caller
  -- is already a member of it (who already knows it exists).
  if v_room.visibility <> 'public' and v_role is null then
    return jsonb_build_object('code', 'room_not_found', 'member_count', null);
  end if;

  -- Idempotent repeat: an existing member — including the owner row written
  -- by create_room — gets 200 with no new row and no capacity consumed.
  if v_role is not null then
    select count(*) into v_members from public.room_members where room_id = p_room_id;
    return jsonb_build_object('code', 'already_member', 'member_count', v_members);
  end if;

  if v_room.status <> 'open' then
    return jsonb_build_object('code', 'room_closed', 'member_count', null);
  end if;

  -- Capacity counts the owner: every row in room_members is a seat.
  select count(*) into v_members from public.room_members where room_id = p_room_id;
  if v_members >= v_room.capacity then
    return jsonb_build_object('code', 'room_full', 'member_count', v_members);
  end if;

  insert into public.room_members (room_id, user_id, role)
  values (p_room_id, v_user_id, 'student');

  return jsonb_build_object('code', 'joined', 'member_count', v_members + 1);
end;
$$;

create or replace function public.leave_room(p_room_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_role text;
  v_visibility text;
  v_members bigint;
begin
  if v_user_id is null then
    raise exception 'leave_room requires an authenticated user' using errcode = '42501';
  end if;

  if p_room_id is null then
    return jsonb_build_object('code', 'room_not_found', 'member_count', null);
  end if;

  select m.role into v_role
  from public.room_members m
  where m.room_id = p_room_id and m.user_id = v_user_id;

  if not found then
    select r.visibility into v_visibility
    from public.rooms r
    where r.id = p_room_id;

    if not found or v_visibility <> 'public' then
      return jsonb_build_object('code', 'room_not_found', 'member_count', null);
    end if;

    return jsonb_build_object('code', 'not_a_member', 'member_count', null);
  end if;

  -- The owner is responsible for the room and may not leave it through this
  -- operation; only a student membership is ever eligible.
  if v_role = 'owner' then
    return jsonb_build_object('code', 'owner_cannot_leave', 'member_count', null);
  end if;

  -- Both predicates name the caller: `v_user_id` comes from auth.uid() and the
  -- role re-check means a student row can never be removed by this function
  -- for anyone else, nor an owner row at all.
  delete from public.room_members
  where room_id = p_room_id and user_id = v_user_id and role = 'student';

  select r.visibility into v_visibility
  from public.rooms r
  where r.id = p_room_id;

  if v_visibility <> 'public' then
    return jsonb_build_object('code', 'left', 'member_count', null);
  end if;

  select count(*) into v_members from public.room_members where room_id = p_room_id;
  return jsonb_build_object('code', 'left', 'member_count', v_members);
end;
$$;

-- Aggregate seat usage for public rooms only. SECURITY DEFINER because the
-- caller's own RLS on room_members (`room_members_select_own`) would otherwise
-- report every other student as absent and make occupancy look like 1. The
-- result is an aggregate over public rooms: no user ids, no emails, and no
-- private-room counts ever leave this function.
create or replace function public.public_room_member_counts()
returns table (room_id uuid, member_count bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select r.id, count(m.user_id)::bigint
  from public.rooms r
  left join public.room_members m on m.room_id = r.id
  where r.visibility = 'public'
  group by r.id
$$;

revoke execute on function public.join_room(uuid) from public, anon;
grant execute on function public.join_room(uuid) to authenticated;

revoke execute on function public.leave_room(uuid) from public, anon;
grant execute on function public.leave_room(uuid) to authenticated;

revoke execute on function public.public_room_member_counts() from public, anon;
grant execute on function public.public_room_member_counts() to authenticated;
