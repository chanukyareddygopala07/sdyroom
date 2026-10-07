-- SDYROOM 0007_room_invitations: addressed invitations + roster read + the
-- shared seat primitive. Local-only target: `npx supabase db reset` /
-- `npx supabase db push --local`. 0001 … 0006 are already applied and are
-- never edited: this file only adds (plus one CREATE OR REPLACE that keeps
-- an identical signature — see "Why join_room is replaced" below).
--
-- Product model: addressed invitations, not bearer links
-- -----------------------------------------------------
-- A private-room owner invites a specific student by their SdyRoom alias.
-- The invitation row is addressed (inviter_id, invitee_id) and only the
-- invitee can inspect or act on it: knowing an invitation id grants nothing,
-- because every transition re-derives auth.uid() and compares it to
-- invitee_id. There is no token, no public invite URL and no
-- "whoever-holds-the-link-accepts-once" surface — the spec's bearer-link
-- design (docs/prs/PR-07) is explicitly superseded by this model.
--
-- Expiry is derived, never stored as a state
-- ------------------------------------------
-- `status` is constrained to pending | accepted | rejected | revoked, and
-- every acceptance/rejection checks `expires_at > now()` at the moment it
-- runs. An expired invitation is still a `pending` row in the past — the API
-- answers 410 expired without writing anything, there is no background job
-- and no "expired" state to fall out of sync (the same read-time evaluation
-- focus sessions apply to their deadlines). `resolved_at` is a single
-- terminal timestamp; `status` says which terminal state it belongs to
-- (constraint: pending ⇔ resolved_at is null), so three parallel
-- *_at columns would only duplicate that.
--
-- Denormalised display fields (inviter_alias, invitee_alias, room_name)
-- ---------------------------------------------------------------------
-- The two parties to an invitation cannot read each other's `profiles` row
-- (`profiles_select_own`) or the private `rooms` row (`rooms_select_*` all
-- require membership), yet both sides must render names: the invitee sees
-- "Alice invited you to Physics 101", the owner lists "Bob, pending".
-- Copying the strings at create time is the pattern `room_messages.alias`
-- already established, and profiles/rooms aliases are immutable today (no
-- alias-editing or room-renaming exists — see docs/milestones.md), so the
-- copies cannot go stale.
--
-- Every write is a SECURITY DEFINER function
-- ------------------------------------------
-- No INSERT/UPDATE/DELETE grant exists, so PostgREST cannot write the table
-- at all (42501 on privilege grounds, exactly like focus_sessions): create,
-- accept, reject and revoke are the only transitions, each implemented once,
-- each deriving identity from auth.uid() and locking the row `for update`
-- before it decides. That is what makes "no invalid state transition"
-- enforceable rather than advisory.
--
-- Why join_room is replaced (CREATE OR REPLACE, same signature)
-- ------------------------------------------------------------
-- Acceptance must reuse the authoritative capacity implementation — the room
-- row lock, the closed check, the owner-counted seat check — not duplicate
-- it. The 0002 body is therefore lifted verbatim into an internal
-- `join_room_core(p_room_id, p_user_id, p_allow_private)` and `join_room`
-- becomes a one-line wrapper passing `(p_room_id, auth.uid(), false)`:
-- identical signature, identical behaviour, identical grants (CREATE OR
-- REPLACE preserves the ACL). `join_room_core` is executed by nobody but the
-- two wrappers (revoke below), so `p_allow_private` can never be called by a
-- client: only the invitation path, after it has proved a pending invitee
-- row, passes true.
--
-- What this does not do
-- ---------------------
-- * No change to rooms, room_members, their grants or their policies: the
--   roster is a SECURITY DEFINER read that re-checks membership itself, so
--   `room_members_select_own` keeps asserting "memberships private to the
--   caller" and no direct PostgREST read gets wider.
-- * No realtime publication change: the roster is a page read; it refreshes
--   through router.refresh() like goals, while live presence keeps riding
--   PR 06's separate presence channel (presence is deliberately not stored
--   on any table).
-- * Invitations exist for private rooms only: join_room already covers
--   public rooms, so an invitation there would be dead weight; the create
--   RPC refuses with `room_public`.
-- * No rate limiting (repo-wide gap, PR 10): abuse is bounded here by the
--   partial unique index — at most one pending invitation per (room,
--   invitee) — plus 1–168 hour TTL bounds and the owner-only gate.

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------
create table public.room_invitations (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  inviter_id uuid not null references auth.users (id) on delete cascade,
  invitee_id uuid not null references auth.users (id) on delete cascade,
  inviter_alias text not null,
  invitee_alias text not null,
  room_name text not null,
  status text not null default 'pending',
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  constraint room_invitations_status
    check (status in ('pending', 'accepted', 'rejected', 'revoked')),
  constraint room_invitations_expiry check (expires_at > created_at),
  constraint room_invitations_resolved
    check ((status = 'pending') = (resolved_at is null)),
  constraint room_invitations_inviter_alias_len
    check (char_length(inviter_alias) between 1 and 32),
  constraint room_invitations_invitee_alias_len
    check (char_length(invitee_alias) between 1 and 32),
  constraint room_invitations_room_name_len
    check (char_length(btrim(room_name)) between 1 and 100)
);

-- At most one *pending* invitation per (room, invitee): a resolved one does
-- not block a fresh invite later, and this index is what absorbs the create
-- race — the loser's insert hits 23505 and is answered `already_invited`.
create unique index room_invitations_one_pending
  on public.room_invitations (room_id, invitee_id)
  where status = 'pending';

-- The two list paths: the invitee's inbox and the owner's per-room list.
create index room_invitations_invitee_idx
  on public.room_invitations (invitee_id, created_at desc);
create index room_invitations_inviter_idx
  on public.room_invitations (inviter_id, created_at desc)
  where status = 'pending';

-- ---------------------------------------------------------------------------
-- Grants: the stack's default ACL for new tables is revoked wholesale, then
-- SELECT only. Writes have no grant at all, so direct PostgREST writes fail
-- on privilege grounds before any policy or constraint is consulted.
-- ---------------------------------------------------------------------------
revoke all on public.room_invitations from anon, authenticated, service_role;

grant select on public.room_invitations to authenticated;

-- ---------------------------------------------------------------------------
-- RLS: one SELECT policy, both directions of "addressed to" / "created by".
-- The policy references inviter_id and invitee_id, and Postgres checks column
-- privileges on every column a query touches (policy quals included), hence
-- the whole-table SELECT grant above. Neither id ever leaves the API: the
-- routes shape responses from the alias columns instead.
-- ---------------------------------------------------------------------------
alter table public.room_invitations enable row level security;

create policy "room_invitations_select_addressed" on public.room_invitations
  for select to authenticated
  using (invitee_id = auth.uid() or inviter_id = auth.uid());

-- ---------------------------------------------------------------------------
-- join_room_core: the 0002 seat logic, lifted verbatim, parameterised on the
-- caller (the wrappers pass auth.uid()) and on the private-room gate. One
-- copy of capacity, closed and idempotency rules for both entry points.
-- Execute is revoked from every application role below; only the definer
-- wrappers reach it, so p_allow_private is unreachable from a client.
-- ---------------------------------------------------------------------------
create or replace function public.join_room_core(
  p_room_id uuid,
  p_user_id uuid,
  p_allow_private boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_room public.rooms;
  v_role text;
  v_members bigint;
begin
  if p_user_id is null then
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
  where m.room_id = p_room_id and m.user_id = p_user_id;

  -- A private room is indistinguishable from a missing one unless the caller
  -- is already a member of it (who already knows it exists) or arrives
  -- through the invitation path, which has already proved a pending row
  -- addressed to this very caller.
  if v_room.visibility <> 'public' and v_role is null and not p_allow_private then
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
  values (p_room_id, p_user_id, 'student');

  return jsonb_build_object('code', 'joined', 'member_count', v_members + 1);
end;
$$;

revoke execute on function public.join_room_core(uuid, uuid, boolean)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- join_room: same signature, same grants (CREATE OR REPLACE keeps the ACL),
-- same external behaviour — it simply delegates to the core with the
-- private gate closed, which is exactly what 0002 did.
-- ---------------------------------------------------------------------------
create or replace function public.join_room(p_room_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  return public.join_room_core(p_room_id, auth.uid(), false);
end;
$$;

-- ---------------------------------------------------------------------------
-- create_room_invitation: owner of a private room invites a student by
-- alias. Identity comes from auth.uid(); the invitee is resolved from
-- profiles by case-insensitive alias (the only lookup the product offers —
-- never email, never phone); both aliases and the room name are copied at
-- create time. Returns codes, not rows.
-- ---------------------------------------------------------------------------
create or replace function public.create_room_invitation(
  p_room_id uuid,
  p_invitee_alias text,
  p_ttl_hours integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_room public.rooms;
  v_role text;
  v_inviter_alias text;
  v_invitee_id uuid;
  v_invitee_alias text;
  v_members bigint;
  v_expires_at timestamptz;
begin
  if v_user_id is null then
    raise exception 'room invitations require an authenticated user' using errcode = '42501';
  end if;

  if p_room_id is null then
    return jsonb_build_object('code', 'room_not_found');
  end if;

  if p_ttl_hours is null or p_ttl_hours < 1 or p_ttl_hours > 168 then
    raise exception 'ttl_hours must be between 1 and 168' using errcode = '22023';
  end if;

  select * into v_room from public.rooms where id = p_room_id;

  -- Missing room, and the answer for anything not yet authorised to know
  -- more, keep the same code the API turns into 404.
  if not found then
    return jsonb_build_object('code', 'room_not_found');
  end if;

  -- Join covers public rooms; an invitation would be dead weight there.
  if v_room.visibility <> 'private' then
    return jsonb_build_object('code', 'room_public');
  end if;

  -- Only the room's owner may invite. The API has already proved
  -- membership (404 for outsiders); this closes the direct-RPC path.
  select m.role into v_role
  from public.room_members m
  where m.room_id = p_room_id and m.user_id = v_user_id;

  if v_role is distinct from 'owner' then
    return jsonb_build_object('code', 'not_owner');
  end if;

  select alias into v_inviter_alias
  from public.profiles where id = v_user_id;

  if v_inviter_alias is null then
    raise exception 'an onboarding profile is required' using errcode = '42501';
  end if;

  select p.id, p.alias into v_invitee_id, v_invitee_alias
  from public.profiles p
  where lower(p.alias) = lower(btrim(coalesce(p_invitee_alias, '')));

  if v_invitee_id is null then
    return jsonb_build_object('code', 'invitee_not_found');
  end if;

  if v_invitee_id = v_user_id then
    return jsonb_build_object('code', 'self_invite');
  end if;

  if exists (
    select 1 from public.room_members m
    where m.room_id = p_room_id and m.user_id = v_invitee_id
  ) then
    return jsonb_build_object('code', 'already_member');
  end if;

  v_expires_at := now() + make_interval(hours => p_ttl_hours);

  begin
    insert into public.room_invitations (
      room_id, inviter_id, invitee_id,
      inviter_alias, invitee_alias, room_name,
      expires_at
    )
    values (
      p_room_id, v_user_id, v_invitee_id,
      v_inviter_alias, v_invitee_alias, v_room.name,
      v_expires_at
    );
  exception when unique_violation then
    -- room_invitations_one_pending: a pending row for this pair exists, or
    -- two creates raced. Either way the caller learns the true state. The
    -- handler runs after the failed insert's subtransaction rolled back, and
    -- the winner is necessarily committed (the index waits otherwise), so
    -- this read sees it.
    return (
      select jsonb_build_object(
        'code', 'already_invited',
        'invitation', jsonb_build_object(
          'id', i.id, 'room_id', i.room_id, 'room_name', i.room_name,
          'inviter_alias', i.inviter_alias, 'invitee_alias', i.invitee_alias,
          'status', i.status, 'created_at', i.created_at,
          'expires_at', i.expires_at, 'resolved_at', i.resolved_at
        )
      )
      from public.room_invitations i
      where i.room_id = p_room_id
        and i.invitee_id = v_invitee_id
        and i.status = 'pending'
    );
  end;

  return (
    select jsonb_build_object(
      'code', 'invited',
      'invitation', jsonb_build_object(
        'id', i.id, 'room_id', i.room_id, 'room_name', i.room_name,
        'inviter_alias', i.inviter_alias, 'invitee_alias', i.invitee_alias,
        'status', i.status, 'created_at', i.created_at,
        'expires_at', i.expires_at, 'resolved_at', i.resolved_at
      )
    )
    from public.room_invitations i
    where i.room_id = p_room_id
      and i.invitee_id = v_invitee_id
      and i.status = 'pending'
  );
end;
$$;

revoke execute on function public.create_room_invitation(uuid, text, integer)
  from public, anon;
grant execute on function public.create_room_invitation(uuid, text, integer)
  to authenticated;

-- ---------------------------------------------------------------------------
-- accept_room_invitation: the atomic accept. Locks the invitation row,
-- proves the caller IS the invitee (anyone else gets the same not_found a
-- missing id gets), refuses every non-pending or past-expiry state, then
-- joins through the core with the private gate opened for this call only.
-- One transaction: either the status flips AND the membership row exists,
-- or neither does.
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

revoke execute on function public.accept_room_invitation(uuid) from public, anon;
grant execute on function public.accept_room_invitation(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- reject_room_invitation: same lock, same invitee proof, same state gate as
-- accept. A rejected row is terminal: re-rejecting answers `rejected`, and
-- accept after reject answers `rejected` too.
-- ---------------------------------------------------------------------------
create or replace function public.reject_room_invitation(p_invitation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_inv public.room_invitations;
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

  if v_inv.expires_at <= now() then
    return jsonb_build_object('code', 'expired');
  end if;

  update public.room_invitations
    set status = 'rejected', resolved_at = now()
    where id = v_inv.id;

  -- 'ok', not 'rejected': the status gate above returns 'rejected' as a
  -- *failure* (409), and a success that shares its code would be
  -- indistinguishable from a repeat — the route could never tell them apart.
  return jsonb_build_object('code', 'ok');
end;
$$;

revoke execute on function public.reject_room_invitation(uuid) from public, anon;
grant execute on function public.reject_room_invitation(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- revoke_room_invitation: owner-side cleanup. The caller must be BOTH the
-- inviter and still the room's owner (today the same person — create
-- enforces owner, owners cannot leave — but both are checked so a future
-- ownership transfer cannot silently widen this). Any pending row may be
-- revoked, expired ones included: revoking is how the owner clears them.
-- Resolved rows are gone as invitations, so they answer not_found — the
-- documented idempotent-revoke behaviour.
-- ---------------------------------------------------------------------------
create or replace function public.revoke_room_invitation(p_invitation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_inv public.room_invitations;
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

  if not found
    or v_inv.inviter_id <> v_user_id
    or not exists (
      select 1 from public.room_members m
      where m.room_id = v_inv.room_id
        and m.user_id = v_user_id
        and m.role = 'owner'
    )
  then
    return jsonb_build_object('code', 'not_found');
  end if;

  if v_inv.status <> 'pending' then
    return jsonb_build_object('code', 'not_found');
  end if;

  update public.room_invitations
    set status = 'revoked', resolved_at = now()
    where id = v_inv.id;

  return jsonb_build_object('code', 'revoked');
end;
$$;

revoke execute on function public.revoke_room_invitation(uuid) from public, anon;
grant execute on function public.revoke_room_invitation(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- room_roster: the only read of other members' identities, and the reason
-- room_members keeps its own narrower policy. Membership is re-checked
-- inside (member-only), and a non-member and a nonexistent room raise the
-- same error, so the function is not an existence oracle. Output is alias +
-- role + joined_at: no user ids, no emails, no contact data — profiles
-- carries none of the latter anyway.
-- ---------------------------------------------------------------------------
create or replace function public.room_roster(p_room_id uuid)
returns table (alias text, role text, joined_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'room roster requires an authenticated user' using errcode = '42501';
  end if;

  if p_room_id is null or not exists (
    select 1 from public.room_members m
    where m.room_id = p_room_id and m.user_id = v_user_id
  ) then
    raise exception 'permission denied for room roster' using errcode = '42501';
  end if;

  return query
    select p.alias, m.role, m.joined_at
    from public.room_members m
    join public.profiles p on p.id = m.user_id
    where m.room_id = p_room_id
    order by (m.role = 'owner') desc, m.joined_at asc, p.alias asc;
end;
$$;

revoke execute on function public.room_roster(uuid) from public, anon;
grant execute on function public.room_roster(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Grants for the two original RPCs are untouched by the REPLACE above, but
-- join_room_core must be unreachable: no application role may execute it.
-- (Re-stated after the create so the intent lives next to the new code.)
-- ---------------------------------------------------------------------------
revoke execute on function public.join_room_core(uuid, uuid, boolean)
  from public, anon, authenticated;
