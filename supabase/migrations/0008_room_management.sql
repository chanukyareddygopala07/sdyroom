-- 0008_room_management.sql
-- Room lifecycle management: edit, capacity change, open/close, delete.
--
-- Why SECURITY DEFINER RPCs instead of UPDATE/DELETE grants (the PR-08 spec
-- sketched a narrow column grant plus `rooms_update_own` / `rooms_delete_own`):
--
--   1. `tests/integration/membership-and-rls.test.ts` already freezes the
--      current answer — "is denied updating a room it owns (no UPDATE grant,
--      not zero rows)" and the matching DELETE probe. Existing tests are not
--      weakened to make room for a new design, so the grants stay absent.
--   2. The capacity floor must be checked under the same `select ... for
--      update` lock on the room row that `join_room` / `join_room_core` take.
--      An RLS policy or a raw PostgREST UPDATE cannot take that lock, so a
--      direct column grant would leave a path that regresses seat math under
--      a concurrent join — the one invariant this table exists to keep.
--   3. Room deletion must be sequenced behind storage cleanup in the route
--      (objects first, row last — see the route docblock). A table DELETE
--      grant would let any client delete the row first and orphan the
--      objects. With no grant, the only writer is `delete_room`.
--
-- So: zero new grants on `public.rooms`, zero new policies on it. Ownership,
-- validation and invariants live in the functions below; the column-level
-- refusal of `owner_id` / `visibility` / `id` / timestamps is now absolute
-- (no UPDATE grant at all) rather than relative to a column list.
--
-- The one policy this migration *does* add is on `storage.objects`, and it is
-- additive and narrow: see the storage section at the end.
--
-- Identity is always `auth.uid()`; `owner_id` never appears in any parameter.
-- `set search_path = ''` pins the search path and every reference is
-- schema-qualified. Execute is revoked from PUBLIC and anon, granted only to
-- authenticated. `rooms_set_updated_at` (0001) keeps owning `updated_at` —
-- it is a BEFORE UPDATE trigger and fires for the RPC's UPDATE like any
-- other, so no timestamp is ever accepted from a client.

-- ---------------------------------------------------------------------------
-- update_room: partial edit of the mutable field set under the room row lock.
--
-- p_changes carries only the keys the caller wants to change (the route's
-- strict Zod schema builds it); unknown keys are ignored because the SET list
-- is a fixed whitelist of columns — there is no dynamic SQL here. Capacity is
-- checked against the current membership while the lock is held, which
-- serialises it with join_room: either the join lands first and the floor
-- refuses the shrink, or the shrink lands first and the join sees the new
-- capacity. The membership count can never disagree with the seat limit.
-- ---------------------------------------------------------------------------
create or replace function public.update_room(p_room_id uuid, p_changes jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_room public.rooms;
  v_members bigint;
  v_capacity int;
  v_status text;
begin
  if v_user_id is null then
    raise exception 'update_room requires an authenticated user'
      using errcode = '42501';
  end if;

  if p_room_id is null then
    return jsonb_build_object('code', 'room_not_found');
  end if;

  if p_changes is null
     or jsonb_typeof(p_changes) <> 'object'
     or not (p_changes ?| array[
          'name', 'shared_goal', 'exam_track', 'subject',
          'language', 'capacity', 'status'
        ])
  then
    return jsonb_build_object('code', 'invalid_request');
  end if;

  -- Serialise against join_room / join_room_core / delete_room: every other
  -- membership or lifecycle decision locks this same row.
  select * into v_room from public.rooms where id = p_room_id for update;

  if not found then
    return jsonb_build_object('code', 'room_not_found');
  end if;

  if v_room.owner_id <> v_user_id then
    return jsonb_build_object('code', 'not_owner');
  end if;

  if p_changes ? 'status' then
    v_status := p_changes->>'status';
    if v_status not in ('open', 'closed') then
      return jsonb_build_object('code', 'validation');
    end if;
  end if;

  if p_changes ? 'capacity' then
    begin
      v_capacity := (p_changes->>'capacity')::int;
    exception
      when invalid_text_representation then
        return jsonb_build_object('code', 'validation');
    end;

    if v_capacity is null or v_capacity < 1 or v_capacity > 100 then
      return jsonb_build_object('code', 'validation');
    end if;

    -- Floor: capacity may never drop below the current member count. The
    -- count is taken under the row lock, so no join can slip between the
    -- count and the update.
    select count(*) into v_members
    from public.room_members
    where room_id = p_room_id;

    if v_capacity < v_members then
      return jsonb_build_object(
        'code', 'capacity_below_membership',
        'member_count', v_members
      );
    end if;
  end if;

  -- Fixed whitelist: unknown keys in p_changes are ignored, and the
  -- identity/immutable columns (owner_id, visibility, id, created_at,
  -- updated_at) are simply not in the list. Blank text normalises to NULL,
  -- matching the Zod transforms on the way in.
  begin
    update public.rooms
    set name = case
          when p_changes ? 'name' then p_changes->>'name'
          else name
        end,
        shared_goal = case
          when p_changes ? 'shared_goal'
            then nullif(p_changes->>'shared_goal', '')
          else shared_goal
        end,
        exam_track = case
          when p_changes ? 'exam_track'
            then nullif(p_changes->>'exam_track', '')
          else exam_track
        end,
        subject = case
          when p_changes ? 'subject'
            then nullif(p_changes->>'subject', '')
          else subject
        end,
        language = case
          when p_changes ? 'language'
            then nullif(p_changes->>'language', '')
          else language
        end,
        capacity = case
          when p_changes ? 'capacity'
            then (p_changes->>'capacity')::int
          else capacity
        end,
        status = case
          when p_changes ? 'status' then p_changes->>'status'
          else status
        end
    where id = p_room_id
    returning * into v_room;
  exception
    -- Safety net for anything the explicit checks above did not pre-validate
    -- (name length/trim, text field lengths, NOT NULL). The DB CHECKs are the
    -- authority; they map to the route's 400 vocabulary, and no constraint
    -- name or SQL text leaves this function.
    when check_violation
      or not_null_violation
      or invalid_text_representation then
      return jsonb_build_object('code', 'validation');
  end;

  return jsonb_build_object('code', 'updated') || to_jsonb(v_room);
end;
$$;

revoke execute on function public.update_room(uuid, jsonb) from public, anon;
grant execute on function public.update_room(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- delete_room: owner-only row removal, cascade in one transaction.
--
-- Storage is deliberately NOT touched here: a SQL function cannot call the
-- Storage API, and the route must remove objects *before* this row disappears
-- (object-first — the reverse of the upload path, justified in the route
-- docblock). The `for update` lock closes the deletion window: while it is
-- held, every FK insert into room-scoped tables (messages, sessions, goals,
-- resources, invitations, memberships) blocks on the room row, so no related
-- row can be added behind the cascade, and a blocked writer fails cleanly
-- with a missing room once this commits.
-- ---------------------------------------------------------------------------
create or replace function public.delete_room(p_room_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_room public.rooms;
begin
  if v_user_id is null then
    raise exception 'delete_room requires an authenticated user'
      using errcode = '42501';
  end if;

  if p_room_id is null then
    return jsonb_build_object('code', 'room_not_found');
  end if;

  select * into v_room from public.rooms where id = p_room_id for update;

  if not found then
    return jsonb_build_object('code', 'room_not_found');
  end if;

  if v_room.owner_id <> v_user_id then
    return jsonb_build_object('code', 'not_owner');
  end if;

  -- Cascades room_members, focus_sessions, study_goals, room_messages,
  -- study_resources and room_invitations (every room FK is ON DELETE
  -- CASCADE since 0002–0007): one statement, no partial room.
  delete from public.rooms where id = p_room_id;

  return jsonb_build_object('code', 'deleted');
end;
$$;

revoke execute on function public.delete_room(uuid) from public, anon;
grant execute on function public.delete_room(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Storage: the room owner may remove their own room's objects.
--
-- 0005 restricts DELETE on `storage.objects` to the object's *uploader*
-- (`owner = auth.uid()`), which is right for the file-by-file flow: a member
-- who can read a shared file must never be able to delete somebody else's
-- upload by talking to storage directly. It is wrong for room deletion: the
-- route sweeps `rooms/{roomId}/**` before deleting the rows, and a room where
-- any member uploaded a file would be permanently undeletable, because the
-- deleting owner is not the uploader of those keys.
--
-- This policy is additive (storage policies OR together, so the uploader's
-- right is untouched) and scoped by a join, not by folder shape alone: the
-- object's key must match a `study_resources.storage_path` row in a room
-- whose `owner_id` is the caller. That pins the right to *this room's* files,
-- proven by data, and leaves personal files and every other room exactly as
-- 0005 left them. The alternative — no policy, accept unreachable objects and
-- a permanent `500 cleanup_failed` — was rejected because it makes the
-- product's "delete your room" goal fail whenever a classmate shared notes.
-- ---------------------------------------------------------------------------
drop policy if exists "study_resources_objects_delete_room_owner"
  on storage.objects;
create policy "study_resources_objects_delete_room_owner"
  on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'study-resources'
    and exists (
      select 1
      from public.study_resources sr
      join public.rooms r on r.id = sr.room_id
      where sr.storage_path = storage.objects.name
        and r.owner_id = auth.uid()
    )
  );
