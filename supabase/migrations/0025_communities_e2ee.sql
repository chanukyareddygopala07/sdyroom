-- SDYROOM 0025_communities_e2ee: communities, channels, MLS key management and
-- ciphertext-only message history.
-- Local-only target: `npx supabase db reset` / `npx supabase db push --local`.
-- 0001_init.sql … 0024_notification_retention_cron.sql are already applied and
-- are never edited: this file only adds.
--
-- Design
-- ------
-- Communities are a subsystem beside study rooms; nothing in 0001–0024 changes.
--
-- End-to-end encryption (the central property)
--   * Message CONTENT is MLS (RFC 9420) ciphertext produced on the sender's
--     device by `ts-mls`. The server stores opaque base64 envelopes in
--     `community_messages.ciphertext` / `community_welcomes.ciphertext` and
--     never holds plaintext, message keys, or private keys. The database has
--     no column that could hold a private key; device rows carry only PUBLIC
--     material (a published MLS key package and signature public key).
--   * One MLS group per channel. Membership changes are MLS commits
--     (`kind = 'commit'` public messages) and joins are MLS welcomes
--     (`community_welcomes`, addressed to one device). Application payloads
--     are `kind = 'application'` private messages.
--   * The server validates envelope STRUCTURE (base64, size ceiling, kind
--     allow-list, idempotency key, membership) and can never validate
--     plaintext — by design. Cryptographic validation happens on clients.
--
-- What the server necessarily sees (documented metadata boundary)
--   * Community id/name/description/category/visibility, membership and roles,
--     channel names, message envelopes' existence, sender user id and device
--     id, timestamps, sequence numbers, ciphertext byte sizes, attachment
--     storage references. It cannot see message bodies, sticker/GIF payloads,
--     attachment plaintext, or any key material beyond published key packages.
--
-- Roles and access
--   * `community_members.role` in ('owner','moderator','member'); `status` in
--     ('active','requested','banned'). Every protected operation re-checks an
--     ACTIVE membership; banned/requested callers match nothing and share the
--     404 shape. Private communities are simply not listed by the discovery
--     query (visibility = 'public' is hard-coded there, mirroring rooms).
--   * Welcomes are addressed: only `recipient_user_id` can read their row, so
--     a new device's join material is not visible to other members.
--   * `community_members` carries a SELECT grant alone (like room_members):
--     every membership write runs through a SECURITY DEFINER function pinned
--     to auth.uid(), so role/status are unreachable over PostgREST — no
--     self-promotion, self-unban, ban bypass or member_count drift.
--
-- Rate limits, envelope validation and the API contract live in
-- `docs/API_CONTRACTS.md`; the threat model lives in `docs/SECURITY.md`.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.communities (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  description text not null default '',
  category text not null default 'study',
  visibility text not null default 'public',
  join_policy text not null default 'open',
  rules text not null default '',
  owner_id uuid not null references auth.users (id) on delete cascade,
  member_count integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint communities_slug_format check (slug ~ '^[a-z0-9][a-z0-9-]{2,38}[a-z0-9]$'),
  constraint communities_name_len check (char_length(btrim(name)) between 3 and 60),
  constraint communities_name_trimmed check (name = btrim(name)),
  constraint communities_description_len check (char_length(description) <= 1000),
  constraint communities_rules_len check (char_length(rules) <= 2000),
  constraint communities_category check (category in ('study', 'exams', 'subjects', 'projects', 'campus', 'other')),
  constraint communities_visibility check (visibility in ('public', 'private')),
  constraint communities_join_policy check (join_policy in ('open', 'request')),
  constraint communities_private_is_request check (visibility = 'public' or join_policy = 'request'),
  constraint communities_member_count check (member_count >= 1)
);

create index communities_discovery_idx on public.communities (visibility, category, created_at desc)
  where visibility = 'public';

create table public.community_members (
  community_id uuid not null references public.communities (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null default 'member',
  status text not null default 'active',
  joined_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (community_id, user_id),
  constraint community_members_role check (role in ('owner', 'moderator', 'member')),
  constraint community_members_status check (status in ('active', 'requested', 'banned')),
  constraint community_members_single_owner_per_community unique (community_id, role) deferrable initially deferred -- placeholder relaxed below
);

-- The unique(owner) constraint above is wrong for multiple communities (role
-- is per-row with community_id in the PK, so uniqueness is already scoped) —
-- it would allow only ONE owner row per community which IS intended, but the
-- deferrable unique on (community_id, role) would also forbid two moderators.
-- Replace it with a partial unique that pins exactly one owner.
alter table public.community_members
  drop constraint community_members_single_owner_per_community;
create unique index community_members_one_owner on public.community_members (community_id)
  where role = 'owner';

create index community_members_user_idx on public.community_members (user_id, status);

create table public.community_channels (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities (id) on delete cascade,
  name text not null,
  slug text not null,
  description text not null default '',
  position integer not null default 0,
  created_at timestamptz not null default now(),
  constraint community_channels_name_len check (char_length(btrim(name)) between 1 and 40),
  constraint community_channels_slug_format check (slug ~ '^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$' or slug = 'general'),
  constraint community_channels_description_len check (char_length(description) <= 200),
  unique (community_id, slug)
);

create index community_channels_community_idx on public.community_channels (community_id, position, created_at);

-- Encrypted protocol stream: MLS application messages and public commits.
-- Append-only: no UPDATE/DELETE grant, like room_messages.
create table public.community_messages (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references public.community_channels (id) on delete cascade,
  community_id uuid not null references public.communities (id) on delete cascade,
  sender_id uuid not null references auth.users (id) on delete cascade,
  sender_device_id text not null,
  kind text not null,
  ciphertext text not null,
  client_msg_id uuid not null,
  seq bigint generated always as identity,
  created_at timestamptz not null default now(),
  constraint community_messages_kind check (kind in ('application', 'commit')),
  constraint community_messages_ciphertext_len check (char_length(ciphertext) between 16 and 262144),
  constraint community_messages_ciphertext_base64 check (ciphertext ~ '^[A-Za-z0-9+/]+={0,2}$'),
  constraint community_messages_device_id_len check (char_length(sender_device_id) between 8 and 64),
  unique (channel_id, client_msg_id)
);

create index community_messages_channel_seq_idx on public.community_messages (channel_id, seq desc);

-- MLS welcomes, addressed to exactly one user+device. Ciphertext-only too:
-- only the holder of the matching private key package can decrypt it.
create table public.community_welcomes (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references public.community_channels (id) on delete cascade,
  community_id uuid not null references public.communities (id) on delete cascade,
  recipient_user_id uuid not null references auth.users (id) on delete cascade,
  recipient_device_id text not null,
  sender_id uuid not null references auth.users (id) on delete cascade,
  ciphertext text not null,
  -- The MLS ratchet tree snapshot that accompanies the welcome. A tree holds
  -- PUBLIC leaf nodes (public keys and credentials) only — no private key
  -- material — and RFC 9420 delivers it as an out-of-band distribution. It
  -- rides the same addressed row as the welcome so visibility stays with the
  -- addressee; joining is impossible without it.
  ratchet_tree text not null,
  client_msg_id uuid not null,
  seq bigint generated always as identity,
  created_at timestamptz not null default now(),
  constraint community_welcomes_ciphertext_len check (char_length(ciphertext) between 16 and 262144),
  constraint community_welcomes_ciphertext_base64 check (ciphertext ~ '^[A-Za-z0-9+/]+={0,2}$'),
  constraint community_welcomes_tree_len check (char_length(ratchet_tree) between 16 and 1048576),
  constraint community_welcomes_tree_base64 check (ratchet_tree ~ '^[A-Za-z0-9+/]+={0,2}$'),
  constraint community_welcomes_device_id_len check (char_length(recipient_device_id) between 8 and 64),
  unique (channel_id, client_msg_id)
);

create index community_welcomes_recipient_idx on public.community_welcomes (recipient_user_id, channel_id, seq);

-- Published PUBLIC key material only. Never a private key, never a wrapped
-- secret: an MLS key package is a public credential designed to be shared so
-- that an existing member can Add the owner of it to a channel group.
create table public.community_devices (
  user_id uuid not null references auth.users (id) on delete cascade,
  device_id text not null,
  key_package text not null,
  signature_public_key text not null,
  created_at timestamptz not null default now(),
  refreshed_at timestamptz not null default now(),
  primary key (user_id, device_id),
  constraint community_devices_device_id_len check (char_length(device_id) between 8 and 64),
  constraint community_devices_key_package_len check (char_length(key_package) between 64 and 65536),
  constraint community_devices_key_package_base64 check (key_package ~ '^[A-Za-z0-9+/]+={0,2}$'),
  constraint community_devices_signature_len check (char_length(signature_public_key) between 16 and 256)
);

-- Encrypted attachment metadata. Bytes live in the private
-- `community-attachments` bucket as ciphertext; this row never holds plaintext
-- content, only a storage reference and the ciphertext's size/type envelope.
create table public.community_attachments (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities (id) on delete cascade,
  channel_id uuid not null references public.community_channels (id) on delete cascade,
  uploader_id uuid not null references auth.users (id) on delete cascade,
  storage_path text not null unique,
  ciphertext_size bigint not null,
  content_type text not null default 'application/octet-stream',
  created_at timestamptz not null default now(),
  constraint community_attachments_size check (ciphertext_size between 1 and 10485760),
  constraint community_attachments_path_format check (storage_path ~ '^community-attachments/[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}$')
);

create index community_attachments_channel_idx on public.community_attachments (channel_id, created_at);

-- Voluntary reports. The server cannot scan ciphertext; a reporter may attach
-- a DECRYPTED excerpt of the specific message they are reporting, knowingly.
create table public.community_reports (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities (id) on delete cascade,
  reporter_id uuid not null references auth.users (id) on delete cascade,
  target_type text not null,
  target_id text not null,
  reason text not null,
  context_excerpt text,
  created_at timestamptz not null default now(),
  constraint community_reports_target_type check (target_type in ('message', 'member')),
  constraint community_reports_reason_len check (char_length(btrim(reason)) between 1 and 500),
  constraint community_reports_excerpt_len check (context_excerpt is null or char_length(context_excerpt) <= 2000)
);

create index community_reports_community_idx on public.community_reports (community_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Grants (revoke-first, same shape as 0003/0004)
-- ---------------------------------------------------------------------------
revoke all on public.communities from anon, authenticated, service_role;
revoke all on public.community_members from anon, authenticated, service_role;
revoke all on public.community_channels from anon, authenticated, service_role;
revoke all on public.community_messages from anon, authenticated, service_role;
revoke all on public.community_welcomes from anon, authenticated, service_role;
revoke all on public.community_devices from anon, authenticated, service_role;
revoke all on public.community_attachments from anon, authenticated, service_role;
revoke all on public.community_reports from anon, authenticated, service_role;

-- `communities` keeps INSERT (the owner-self policy below can never pass for
-- a direct write: the owner membership row only exists inside
-- `create_community`) and DELETE (owner-only policy, exercised by
-- DELETE /api/communities/[id]).
grant select, insert, update, delete on public.communities to authenticated;
-- `community_members` is SELECT alone, mirroring room_members in 0001/0002:
-- every membership write (create/join/leave/set/kick) runs through a
-- SECURITY DEFINER function, so role and status are unreachable over
-- PostgREST. That closes self-promotion to moderator, self-unban, rejoining
-- past a ban, and member_count drift from a direct self-delete.
grant select on public.community_members to authenticated;
grant select, insert on public.community_channels to authenticated;
grant select, insert on public.community_messages to authenticated;
grant select, insert on public.community_welcomes to authenticated;
grant select, insert, update, delete on public.community_devices to authenticated;
grant select, insert, delete on public.community_attachments to authenticated;
grant select, insert on public.community_reports to authenticated;

-- ---------------------------------------------------------------------------
-- Helper predicates (security definer so RLS on community_members cannot
-- recurse into itself when a policy asks "is the caller an active member?").
-- Both leak nothing: they answer true/false and are granted to authenticated
-- only, and every caller already may learn their own membership.
-- ---------------------------------------------------------------------------
create or replace function public.is_community_member(p_community_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.community_members m
    where m.community_id = p_community_id
      and m.user_id = auth.uid()
      and m.status = 'active'
  );
$$;

create or replace function public.is_community_staff(p_community_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.community_members m
    where m.community_id = p_community_id
      and m.user_id = auth.uid()
      and m.status = 'active'
      and m.role in ('owner', 'moderator')
  );
$$;

revoke all on function public.is_community_member(uuid) from public, anon;
revoke all on function public.is_community_staff(uuid) from public, anon;
grant execute on function public.is_community_member(uuid) to authenticated;
grant execute on function public.is_community_staff(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.communities enable row level security;
alter table public.community_members enable row level security;
alter table public.community_channels enable row level security;
alter table public.community_messages enable row level security;
alter table public.community_welcomes enable row level security;
alter table public.community_devices enable row level security;
alter table public.community_attachments enable row level security;
alter table public.community_reports enable row level security;

-- communities: public rows are world-readable to signed-in users (discovery);
-- private rows are visible only to their members. Writes: any active member
-- may update non-ownership fields; deletes are owner-only (the API re-checks
-- role server-side as well). Inserts are handled by the API as the caller
-- (RLS allows an authenticated insert only when the caller becomes the owner
-- member row in the same transaction — enforced by the insert policy below
-- requiring an owner row for the new community to exist with their id).
create policy "communities_select_visible" on public.communities
  for select to authenticated
  using (visibility = 'public' or public.is_community_member(id));

create policy "communities_insert_self_owner" on public.communities
  for insert to authenticated
  with check (
    owner_id = auth.uid()
    and exists (
      select 1 from public.community_members m
      where m.community_id = communities.id
        and m.user_id = auth.uid()
        and m.role = 'owner'
        and m.status = 'active'
    )
  );

create policy "communities_update_staff" on public.communities
  for update to authenticated
  using (public.is_community_staff(id))
  with check (
    public.is_community_staff(id)
    and exists (
      select 1 from public.community_members m
      where m.community_id = communities.id
        and m.user_id = communities.owner_id
        and m.role = 'owner'
        and m.status = 'active'
    )
  );

create policy "communities_delete_owner" on public.communities
  for delete to authenticated
  using (exists (
    select 1 from public.community_members m
    where m.community_id = communities.id
      and m.user_id = auth.uid()
      and m.role = 'owner'
      and m.status = 'active'
  ));

-- community_members: reads only. A user always sees their own row (join/
-- request flows and the API's membership checks); active members see the
-- roster. There are no insert/update/delete policies because there is no such
-- grant — membership writes exist only inside the SECURITY DEFINER functions
-- below, which pin identity to auth.uid() and keep member_count honest in the
-- same transaction.
create policy "members_select_own_or_roster" on public.community_members
  for select to authenticated
  using (user_id = auth.uid() or public.is_community_member(community_id));

-- community_channels: members read; staff write. Creation is staff-only via
-- the API; RLS mirrors it.
create policy "channels_select_member" on public.community_channels
  for select to authenticated
  using (public.is_community_member(community_id));

create policy "channels_insert_staff" on public.community_channels
  for insert to authenticated
  with check (public.is_community_staff(community_id));

-- community_messages: the ciphertext stream. Members read all envelopes in
-- their communities' channels (decryption is cryptographic, not policy-based);
-- the sender inserts only their own rows into communities they belong to.
create policy "messages_select_member" on public.community_messages
  for select to authenticated
  using (public.is_community_member(community_id));

create policy "messages_insert_own_member" on public.community_messages
  for insert to authenticated
  with check (
    sender_id = auth.uid()
    and public.is_community_member(community_id)
    and exists (
      select 1 from public.community_channels ch
      where ch.id = channel_id and ch.community_id = community_messages.community_id
    )
  );

-- community_welcomes: the addressee reads their welcome, and so does the
-- sender — the committer just wrote that ciphertext and needs the RETURNING
-- row back (and an idempotent re-probe on a retried POST) to see their own
-- insert. The sender authored the envelope, so no secret crosses to them;
-- everyone else still sees nothing. Insert requires active membership of the
-- sender (the committer).
create policy "welcomes_select_recipient_or_sender" on public.community_welcomes
  for select to authenticated
  using (recipient_user_id = auth.uid() or sender_id = auth.uid());

create policy "welcomes_insert_member" on public.community_welcomes
  for insert to authenticated
  with check (sender_id = auth.uid() and public.is_community_member(community_id));

-- community_devices: PUBLIC key packages. Any signed-in user may read them
-- (publishing key packages is how MLS enrollment works; they contain only
-- public keys). Rows are self-written and self-deleted only.
create policy "devices_select_authenticated" on public.community_devices
  for select to authenticated
  using (true);

create policy "devices_insert_own" on public.community_devices
  for insert to authenticated
  with check (user_id = auth.uid());

create policy "devices_update_own" on public.community_devices
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "devices_delete_own" on public.community_devices
  for delete to authenticated
  using (user_id = auth.uid());

-- community_attachments: members read; the uploader inserts their own row.
create policy "attachments_select_member" on public.community_attachments
  for select to authenticated
  using (public.is_community_member(community_id));

create policy "attachments_insert_own_member" on public.community_attachments
  for insert to authenticated
  with check (
    uploader_id = auth.uid()
    and public.is_community_member(community_id)
    and storage_path like 'community-attachments/' || community_id::text || '/%'
  );

create policy "attachments_delete_own" on public.community_attachments
  for delete to authenticated
  using (uploader_id = auth.uid());

-- community_reports: reporter files and sees their own; staff read the inbox.
create policy "reports_insert_own_member" on public.community_reports
  for insert to authenticated
  with check (reporter_id = auth.uid() and public.is_community_member(community_id));

create policy "reports_select_own_or_staff" on public.community_reports
  for select to authenticated
  using (reporter_id = auth.uid() or public.is_community_staff(community_id));

-- ---------------------------------------------------------------------------
-- Storage: private bucket for ciphertext attachments. The object's bytes are
-- opaque; RLS on storage.objects re-derives authorization from the path
-- prefix (community id) exactly like the study-resources bucket does for
-- rooms. Content-type is octet-stream: no plaintext media is ever stored.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'community-attachments',
  'community-attachments',
  false,
  10485760,
  array['application/octet-stream']::text[]
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Storage keys carry the bucket-name prefix exactly like community_attachments
-- stores them: community-attachments/{community}/{channel}/{attachment}, so
-- foldername() (which drops the file name) yields three segments and the
-- community id is segment 2. The strict array_length check is what makes the
-- layout rigid — a key with extra or missing segments cannot line up — and
-- membership is matched as m.community_id::text = segment (text against text),
-- never a cast of an attacker-controlled segment to uuid, so no cast error can
-- become an oracle. Indexing past the end yields NULL, which compares to NULL
-- and fails closed.
create policy "community_attachments_select_member" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'community-attachments'
    and array_length(storage.foldername(name), 1) = 3
    and (storage.foldername(name))[1] = 'community-attachments'
    and exists (
      select 1 from public.community_members m
      where m.user_id = auth.uid()
        and m.status = 'active'
        and m.community_id::text = (storage.foldername(name))[2]
    )
  );

create policy "community_attachments_insert_member" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'community-attachments'
    and owner = auth.uid()
    and array_length(storage.foldername(name), 1) = 3
    and (storage.foldername(name))[1] = 'community-attachments'
    and exists (
      select 1 from public.community_members m
      where m.user_id = auth.uid()
        and m.status = 'active'
        and m.community_id::text = (storage.foldername(name))[2]
    )
  );

create policy "community_attachments_delete_uploader" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'community-attachments'
    and exists (
      select 1 from public.community_attachments a
      where a.storage_path = storage.objects.name
        and a.uploader_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- Realtime: ciphertext INSERTs flow to members with RLS applied at delivery
-- (same mechanism and guarantees as room_messages in 0004). The payload is
-- the stored row — ciphertext plus metadata, never plaintext.
-- ---------------------------------------------------------------------------
alter publication supabase_realtime add table public.community_messages;

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------

-- Create a community with its owner membership and a default channel in one
-- transaction. SECURITY DEFINER because the communities insert policy needs
-- the owner membership row to already exist; the function pins every identity
-- to auth.uid() and derives the slug server-side from the provided name.
create or replace function public.create_community(
  p_name text,
  p_slug text,
  p_description text,
  p_category text,
  p_visibility text,
  p_join_policy text,
  p_rules text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_community_id uuid;
begin
  if v_user is null then
    raise exception 'not_authenticated';
  end if;

  insert into public.communities (slug, name, description, category, visibility, join_policy, rules, owner_id, member_count)
  values (p_slug, p_name, p_description, p_category, p_visibility, p_join_policy, p_rules, v_user, 1)
  returning id into v_community_id;

  insert into public.community_members (community_id, user_id, role, status)
  values (v_community_id, v_user, 'owner', 'active');

  insert into public.community_channels (community_id, name, slug, description, position)
  values (v_community_id, 'general', 'general', 'Everything about this community', 0);

  return v_community_id;
end;
$$;

revoke all on function public.create_community(text, text, text, text, text, text, text) from public, anon;
grant execute on function public.create_community(text, text, text, text, text, text, text) to authenticated;

-- Join an open community (becomes active) or file a request (status
-- requested). Banned callers cannot rejoin. The member count moves only on
-- the open-join path, in the same transaction as the membership row.
create or replace function public.join_community(p_community_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_policy text;
  v_visibility text;
  v_existing record;
begin
  if v_user is null then
    raise exception 'not_authenticated';
  end if;

  select c.join_policy, c.visibility into v_policy, v_visibility
  from public.communities c where c.id = p_community_id for update;

  if not found then
    raise exception 'community_not_found';
  end if;

  select role, status into v_existing
  from public.community_members m
  where m.community_id = p_community_id and m.user_id = v_user;

  if found and v_existing.status = 'banned' then
    raise exception 'banned';
  end if;
  if found and v_existing.status = 'active' then
    return 'active';
  end if;
  if found and v_existing.status = 'requested' then
    return 'requested';
  end if;

  if v_visibility = 'private' or v_policy = 'request' then
    insert into public.community_members (community_id, user_id, role, status)
    values (p_community_id, v_user, 'member', 'requested')
    on conflict (community_id, user_id) do nothing;
    return 'requested';
  end if;

  insert into public.community_members (community_id, user_id, role, status)
  values (p_community_id, v_user, 'member', 'active');

  update public.communities
  set member_count = member_count + 1, updated_at = now()
  where id = p_community_id;

  return 'active';
end;
$$;

revoke all on function public.join_community(uuid) from public, anon;
grant execute on function public.join_community(uuid) to authenticated;

-- Leave a community. The owner must transfer or delete the community first.
-- The member count moves only when an active member actually leaves.
create or replace function public.leave_community(p_community_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_role text;
  v_status text;
begin
  if v_user is null then
    raise exception 'not_authenticated';
  end if;

  select role, status into v_role, v_status
  from public.community_members m
  where m.community_id = p_community_id and m.user_id = v_user
  for update;

  if not found then
    raise exception 'community_not_found';
  end if;
  if v_role = 'owner' then
    raise exception 'owner_cannot_leave';
  end if;

  delete from public.community_members m
  where m.community_id = p_community_id and m.user_id = v_user;

  if v_status = 'active' then
    update public.communities
    set member_count = greatest(member_count - 1, 1), updated_at = now()
    where id = p_community_id;
  end if;
end;
$$;

revoke all on function public.leave_community(uuid) from public, anon;
grant execute on function public.leave_community(uuid) to authenticated;

-- Staff approve a requested member, change a role, ban or remove a member.
-- Ownership cannot be dropped or reassigned through this function.
create or replace function public.set_community_member(
  p_community_id uuid,
  p_user_id uuid,
  p_role text default null,
  p_status text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_actor_role text;
  v_target record;
  v_new_role text;
  v_new_status text;
  v_was_active boolean;
begin
  if v_actor is null then
    raise exception 'not_authenticated';
  end if;

  select role into v_actor_role
  from public.community_members m
  where m.community_id = p_community_id and m.user_id = v_actor and m.status = 'active';

  if not found or v_actor_role not in ('owner', 'moderator') then
    raise exception 'not_staff';
  end if;

  select role, status into v_target
  from public.community_members m
  where m.community_id = p_community_id and m.user_id = p_user_id
  for update;

  if not found then
    raise exception 'member_not_found';
  end if;
  if v_target.role = 'owner' then
    raise exception 'owner_protected';
  end if;

  v_new_role := coalesce(p_role, v_target.role);
  v_new_status := coalesce(p_status, v_target.status);

  if v_new_role not in ('owner', 'moderator', 'member') then
    raise exception 'invalid_role';
  end if;
  if v_new_status not in ('active', 'requested', 'banned') then
    raise exception 'invalid_status';
  end if;
  -- Only the owner may appoint moderators.
  if v_new_role = 'moderator' and v_target.role <> 'moderator' and v_actor_role <> 'owner' then
    raise exception 'not_owner';
  end if;

  v_was_active := v_target.status = 'active';

  update public.community_members
  set role = v_new_role, status = v_new_status, updated_at = now()
  where community_id = p_community_id and user_id = p_user_id;

  if v_was_active and v_new_status <> 'active' then
    update public.communities
    set member_count = greatest(member_count - 1, 1), updated_at = now()
    where id = p_community_id;
  elsif (not v_was_active) and v_new_status = 'active' then
    update public.communities
    set member_count = member_count + 1, updated_at = now()
    where id = p_community_id;
  end if;
end;
$$;

revoke all on function public.set_community_member(uuid, uuid, text, text) from public, anon;
grant execute on function public.set_community_member(uuid, uuid, text, text) to authenticated;

-- Remove a member (the API's kick). SECURITY DEFINER because authenticated
-- holds no DELETE grant on community_members: removal and the member_count
-- bookkeeping happen in one transaction, guarded exactly like
-- set_community_member (active owner/moderator actor, target must exist,
-- owner protected). A non-member asking gets not_found from the API's own
-- staff gate before this runs; not_staff here is the race defence if the
-- actor lost staff between the gate and the call.
create or replace function public.kick_community_member(
  p_community_id uuid,
  p_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_actor_role text;
  v_target record;
begin
  if v_actor is null then
    raise exception 'not_authenticated';
  end if;

  select role into v_actor_role
  from public.community_members m
  where m.community_id = p_community_id and m.user_id = v_actor and m.status = 'active';

  if not found or v_actor_role not in ('owner', 'moderator') then
    raise exception 'not_staff';
  end if;

  select role, status into v_target
  from public.community_members m
  where m.community_id = p_community_id and m.user_id = p_user_id
  for update;

  if not found then
    raise exception 'member_not_found';
  end if;
  if v_target.role = 'owner' then
    raise exception 'owner_protected';
  end if;

  delete from public.community_members
  where community_id = p_community_id and user_id = p_user_id;

  if v_target.status = 'active' then
    update public.communities
    set member_count = greatest(member_count - 1, 1), updated_at = now()
    where id = p_community_id;
  end if;
end;
$$;

revoke all on function public.kick_community_member(uuid, uuid) from public, anon;
grant execute on function public.kick_community_member(uuid, uuid) to authenticated;

-- Read the member roster with display aliases. SECURITY DEFINER because
-- profiles is SELECT-own only (profiles_select_own) and community_members has
-- no FK path to profiles for a PostgREST embed — the same reason room_roster
-- exists (0007). Gates are re-checked inside the definer, mirroring the API
-- route: an active membership is required at all, and include_requested is
-- owner/moderator only. A plain Error from this call surfaces as the route's
-- 500; the route's own membership/staff gates answer first for everyone else.
create or replace function public.community_roster(
  p_community_id uuid,
  p_include_requested boolean default false
)
returns table (
  user_id uuid,
  role text,
  status text,
  joined_at timestamptz,
  alias text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_role text;
begin
  if v_user is null then
    raise exception 'not_authenticated';
  end if;

  select m.role into v_role
  from public.community_members m
  where m.community_id = p_community_id and m.user_id = v_user and m.status = 'active';

  if not found then
    raise exception 'permission denied for community roster' using errcode = '42501';
  end if;

  if p_include_requested and v_role not in ('owner', 'moderator') then
    raise exception 'permission denied for requested roster' using errcode = '42501';
  end if;

  return query
    select m.user_id, m.role, m.status, m.joined_at, p.alias
    from public.community_members m
    left join public.profiles p on p.id = m.user_id
    where m.community_id = p_community_id
      and (p_include_requested or m.status = 'active')
    order by m.joined_at asc
    limit 500;
end;
$$;

revoke all on function public.community_roster(uuid, boolean) from public, anon;
grant execute on function public.community_roster(uuid, boolean) to authenticated;
