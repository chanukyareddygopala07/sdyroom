-- SDYROOM 0001_init: profiles, rooms, room_members + RLS + create_room RPC.
-- Local-only target: `npx supabase db reset` / `npx supabase db push --local`.

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  alias text not null,
  exam_targets jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  constraint profiles_alias_len check (char_length(alias) between 1 and 32),
  constraint profiles_alias_trimmed check (alias = btrim(alias)),
  constraint profiles_exam_targets_is_array check (jsonb_typeof(exam_targets) = 'array')
);

-- Case-insensitive uniqueness without a citext dependency.
create unique index profiles_alias_lower_key on public.profiles (lower(alias));

create table public.rooms (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  visibility text not null default 'public',
  name text not null,
  capacity integer not null default 4,
  exam_track text,
  subject text,
  language text,
  status text not null default 'open',
  shared_goal text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint rooms_name_len check (char_length(btrim(name)) between 1 and 100),
  constraint rooms_name_trimmed check (name = btrim(name)),
  constraint rooms_visibility check (visibility in ('public', 'private')),
  constraint rooms_capacity check (capacity between 1 and 100),
  constraint rooms_status check (status in ('open', 'closed')),
  constraint rooms_exam_track_len check (exam_track is null or char_length(exam_track) <= 80),
  constraint rooms_subject_len check (subject is null or char_length(subject) <= 80),
  constraint rooms_language_len check (language is null or char_length(language) <= 40),
  constraint rooms_shared_goal_len check (shared_goal is null or char_length(shared_goal) <= 500)
);

create index rooms_owner_id_idx on public.rooms (owner_id);
create index rooms_public_created_at_idx on public.rooms (created_at desc)
  where visibility = 'public';

create table public.room_members (
  room_id uuid not null references public.rooms (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null default 'student',
  joined_at timestamptz not null default now(),
  primary key (room_id, user_id),
  constraint room_members_role check (role in ('owner', 'student'))
);

create index room_members_user_id_idx on public.room_members (user_id);

-- ---------------------------------------------------------------------------
-- Invariant: a room must never commit without its owner membership row.
--
-- SECURITY INVOKER on create_room means table privileges (and RLS) decide what
-- a caller can do, so the RPC alone cannot be trusted to keep this invariant:
-- a direct authenticated INSERT into public.rooms would otherwise be able to
-- commit a room with no owner membership. A DEFERRABLE INITIALLY DEFERRED
-- constraint trigger closes that hole for every write path, because it is
-- evaluated at COMMIT for rows written by the RPC, by direct PostgREST calls,
-- or by any other session. SECURITY DEFINER so the check reads ground truth
-- rather than the caller's RLS-filtered view; search_path is pinned empty and
-- every reference is schema-qualified.
-- ---------------------------------------------------------------------------
create or replace function public.assert_room_has_owner_membership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.room_members m
    where m.room_id = new.id
      and m.user_id = new.owner_id
      and m.role = 'owner'
  ) then
    raise exception 'room % has no owner membership row', new.id
      using errcode = '23514';
  end if;
  return null;
end;
$$;

create constraint trigger rooms_require_owner_membership
after insert or update on public.rooms
deferrable initially deferred
for each row
execute function public.assert_room_has_owner_membership();

create or replace function public.rooms_touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger rooms_set_updated_at
before update on public.rooms
for each row
execute function public.rooms_touch_updated_at();

-- ---------------------------------------------------------------------------
-- Grants. Explicit column/table grants only: new tables start with whatever
-- default privileges the stack configured, so everything is revoked first.
-- authenticated: no UPDATE/DELETE on rooms or room_members until those flows
-- are designed. anon: no table privileges at all.
-- ---------------------------------------------------------------------------
revoke all on all tables in schema public from anon, authenticated;

grant select (id, alias, exam_targets, created_at) on public.profiles to authenticated;
grant insert (id, alias, exam_targets) on public.profiles to authenticated;
grant update (alias, exam_targets) on public.profiles to authenticated;

grant select, insert on public.rooms to authenticated;

grant select, insert on public.room_members to authenticated;

revoke execute on function public.assert_room_has_owner_membership() from public, anon, authenticated;
revoke execute on function public.rooms_touch_updated_at() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.rooms enable row level security;
alter table public.room_members enable row level security;

create policy "profiles_select_own" on public.profiles
  for select to authenticated
  using (id = auth.uid());

create policy "profiles_insert_own" on public.profiles
  for insert to authenticated
  with check (id = auth.uid());

create policy "profiles_update_own" on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- Rooms: anon has no policy (and no grant). Authenticated sees public rooms,
-- rooms they own, and private rooms they are a member of.
create policy "rooms_select_public" on public.rooms
  for select to authenticated
  using (visibility = 'public');

create policy "rooms_select_own" on public.rooms
  for select to authenticated
  using (owner_id = auth.uid());

create policy "rooms_select_member" on public.rooms
  for select to authenticated
  using (exists (
    select 1 from public.room_members m
    where m.room_id = id and m.user_id = auth.uid()
  ));

-- Insert only as yourself: an owner_id you do not own is rejected outright.
create policy "rooms_insert_self_owner" on public.rooms
  for insert to authenticated
  with check (owner_id = auth.uid());

-- No update/delete policies on rooms: RLS denies them by default.

create policy "room_members_select_own" on public.room_members
  for select to authenticated
  using (user_id = auth.uid());

-- Only the room owner may add rows, only about themselves, and only as owner.
-- No member may grant themselves or anyone else a role (no join flow yet).
create policy "room_members_insert_owner_self" on public.room_members
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and role = 'owner'
    and exists (
      select 1 from public.rooms r
      where r.id = room_id and r.owner_id = auth.uid()
    )
  );

-- No update/delete policies on room_members.

-- ---------------------------------------------------------------------------
-- create_room: atomic room + owner membership.
-- SECURITY INVOKER, pinned empty search_path, owner derived from auth.uid()
-- (no owner argument exists to spoof), validated inputs, single transaction so
-- a failed membership insert rolls the room insert back.
-- ---------------------------------------------------------------------------
create or replace function public.create_room(
  p_name text,
  p_capacity integer default 4,
  p_visibility text default 'public',
  p_exam_track text default null,
  p_subject text default null,
  p_language text default null,
  p_status text default 'open',
  p_shared_goal text default null
)
returns public.rooms
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_owner_id uuid := auth.uid();
  v_room public.rooms;
begin
  if v_owner_id is null then
    raise exception 'create_room requires an authenticated user'
      using errcode = '42501';
  end if;

  if p_name is null or char_length(btrim(p_name)) not between 1 and 100 then
    raise exception 'invalid room name' using errcode = '22023';
  end if;
  if p_capacity is null or p_capacity not between 1 and 100 then
    raise exception 'capacity must be between 1 and 100' using errcode = '22023';
  end if;
  if p_visibility not in ('public', 'private') then
    raise exception 'invalid visibility' using errcode = '22023';
  end if;
  if p_status not in ('open', 'closed') then
    raise exception 'invalid status' using errcode = '22023';
  end if;
  if p_exam_track is not null and char_length(p_exam_track) > 80 then
    raise exception 'exam_track too long' using errcode = '22023';
  end if;
  if p_subject is not null and char_length(p_subject) > 80 then
    raise exception 'subject too long' using errcode = '22023';
  end if;
  if p_language is not null and char_length(p_language) > 40 then
    raise exception 'language too long' using errcode = '22023';
  end if;
  if p_shared_goal is not null and char_length(p_shared_goal) > 500 then
    raise exception 'shared_goal too long' using errcode = '22023';
  end if;

  insert into public.rooms
    (owner_id, visibility, name, capacity, exam_track, subject, language, status, shared_goal)
  values
    (
      v_owner_id,
      p_visibility,
      btrim(p_name),
      p_capacity,
      nullif(btrim(p_exam_track), ''),
      nullif(btrim(p_subject), ''),
      nullif(btrim(p_language), ''),
      p_status,
      nullif(btrim(p_shared_goal), '')
    )
  returning * into v_room;

  insert into public.room_members (room_id, user_id, role)
  values (v_room.id, v_owner_id, 'owner');

  return v_room;
end;
$$;

revoke execute on function public.create_room(text, integer, text, text, text, text, text, text)
  from public, anon;
grant execute on function public.create_room(text, integer, text, text, text, text, text, text)
  to authenticated;
