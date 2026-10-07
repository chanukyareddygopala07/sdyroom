-- SDYROOM 0005_study_resources: private study files, room sharing and the
-- private storage bucket that holds them.
-- Local-only target: `npx supabase db reset` / `npx supabase db push --local`.
-- 0001_init.sql … 0004_room_messages.sql are already applied and are never
-- edited: this file only adds.
--
-- Design
-- ------
-- study_resources
--   * Two visibility states, decided by one nullable column:
--         room_id IS NULL   personal — only the uploader ever reads it
--         room_id = <room>  shared   — every current member of that room reads it
--     A public room does not widen this: membership is required either way,
--     so a bystander who knows the room id still cannot list or fetch a file.
--   * `owner_id` defaults to `auth.uid()` and is **not granted for INSERT**.
--     A browser therefore cannot choose an owner even if it tried: PostgREST
--     rejects the column on privilege grounds before any policy runs, and the
--     `with check` policy rejects a mismatching value for good measure. Two
--     independent layers, neither of which the client can relax.
--   * `owner_id` is also not granted for SELECT. No response shape needs it —
--     "mine" and "shared with my room" is all the UI can express — so the
--     column simply never leaves the database through the API.
--   * `storage_path` is server-built (`personal/{owner}/{id}{ext}` or
--     `rooms/{room}/{owner}/{id}{ext}`) and is checked by a regex CHECK so a
--     hand-written row can never point at an arbitrary object.
--   * `content_type` comes from signature sniffing in the API, never from the
--     browser; the CHECK list below is the same closed list.
--   * `size_bytes` is bounded to 20 MiB, which the local bucket allows (the
--     stack's own ceiling is 50 MiB). See docs/API_CONTRACTS.md.
--   * Delete is uploader-only. Membership revocation alone already removes
--     read access for everyone else; deleting removes it for the uploader too.
--
-- No malware scanning runs anywhere in this project. The API validates
-- signatures, encodings and lengths — that is format validation, not scanning,
-- and nothing here should be read as claiming otherwise.
--
-- Storage
-- -------
-- The `study-resources` bucket is created here with `public = false`, so a
-- single `supabase db reset` provisions the whole feature: CI and a fresh
-- checkout need nothing beyond the migrations they already run.
--
-- Storage RLS is enforced for authenticated callers (verified against the
-- local stack: an upload returns 403 the moment its INSERT policy is dropped,
-- and `createSignedUrl` answers "not found" with no SELECT policy). The
-- policies below therefore encode the same scope the table policies encode,
-- read out of the object key itself:
--
--     personal/{owner}/{id}{ext}          owner only
--     rooms/{room}/{owner}/{id}{ext}      current members of {room}
--
-- Because the key carries the scope, a hand-written
-- `POST /storage/v1/object/…` is subject to exactly the same rules as the app.
-- `owner = auth.uid()` is checked on INSERT as well, so storage's own record
-- of who wrote the object must agree with the path.
--
-- UPDATE has no policy on storage.objects: nothing in the app rewrites an
-- object, so the default deny stands. DELETE is restricted to the object's
-- owner, which is what lets the API clean up after a failed metadata insert
-- and remove an object on deletion — and stops one member from deleting
-- another's upload by calling storage directly.

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------
create table public.study_resources (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default (auth.uid()) references auth.users (id) on delete cascade,
  room_id uuid references public.rooms (id) on delete cascade,
  storage_path text not null,
  title text not null,
  original_filename text not null,
  content_type text not null,
  size_bytes bigint not null,
  subject text,
  chapter text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint study_resources_title_len check (char_length(btrim(title)) between 1 and 120),
  constraint study_resources_title_trimmed check (title = btrim(title)),
  constraint study_resources_title_no_control check (title !~ '[[:cntrl:]]'),
  constraint study_resources_filename_len check (char_length(original_filename) between 1 and 255),
  constraint study_resources_filename_no_control check (original_filename !~ '[[:cntrl:]]'),
  constraint study_resources_content_type check (
    content_type in ('application/pdf', 'image/png', 'image/jpeg', 'text/plain', 'text/markdown')
  ),
  constraint study_resources_size check (size_bytes between 1 and 20971520),
  constraint study_resources_subject check (
    subject is null or (
      char_length(btrim(subject)) between 1 and 80
      and subject = btrim(subject)
      and subject !~ '[[:cntrl:]]'
    )
  ),
  constraint study_resources_chapter check (
    chapter is null or (
      char_length(btrim(chapter)) between 1 and 80
      and chapter = btrim(chapter)
      and chapter !~ '[[:cntrl:]]'
    )
  ),
  constraint study_resources_storage_path_len check (char_length(storage_path) between 1 and 512),
  -- The only shapes a server-built key may take. A `..`, an absolute path or
  -- an unexpected prefix cannot satisfy this, whatever the API is tricked into
  -- trying.
  constraint study_resources_storage_path_layout check (
    storage_path ~ '^(personal/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|rooms/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]+$'
  ),
  -- A personal row must live under the personal prefix and a shared row under
  -- its own room's prefix: the two representations of scope cannot disagree.
  constraint study_resources_scope_matches_path check (
    (room_id is null) = (storage_path like 'personal/%')
  )
);

create index study_resources_owner_created_idx
  on public.study_resources (owner_id, created_at desc);
create index study_resources_room_created_idx
  on public.study_resources (room_id, created_at desc)
  where room_id is not null;
-- One row per object, so a retried insert cannot duplicate a download.
create unique index study_resources_storage_path_key
  on public.study_resources (storage_path);

-- `updated_at` is server-owned: a client can change the title, never the
-- clock, and no write path exists that could backdate a row.
create or replace function public.study_resources_touch()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger study_resources_set_updated_at
before update on public.study_resources
for each row
execute function public.study_resources_touch();

-- ---------------------------------------------------------------------------
-- Grants. Same revoke-first shape as 0003/0004: the stack's default ACL for
-- new tables is removed, then only the columns each verb needs are granted.
--
-- `owner_id` appears in NO grant. For INSERT that means the column default
-- `auth.uid()` is used and a client-supplied value is rejected outright with
-- "permission denied for column"; for SELECT it means the owner's id is not
-- part of any API payload even before shaping is applied.
-- ---------------------------------------------------------------------------
revoke all on public.study_resources from anon, authenticated, service_role;

grant select (
  id, title, original_filename, content_type, size_bytes, subject, chapter,
  room_id, created_at, updated_at, storage_path
) on public.study_resources to authenticated;

grant insert (
  id, room_id, storage_path, title, original_filename, content_type,
  size_bytes, subject, chapter
) on public.study_resources to authenticated;

grant update (title, subject, chapter) on public.study_resources to authenticated;

grant delete on public.study_resources to authenticated;

revoke execute on function public.study_resources_touch() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.study_resources enable row level security;

-- Read: your own rows, plus rows shared into a room you are a member of right
-- now. Leaving a room removes the second branch immediately, which is how a
-- membership change revokes access without touching a single file.
--
-- The uploader keeps reading their own shared upload after they leave. That is
-- deliberate: it is their file, and the room page they can no longer open is
-- what stops them from seeing it in context.
create policy "study_resources_select_own_or_member"
  on public.study_resources
  for select to authenticated
  using (
    owner_id = auth.uid()
    or (
      room_id is not null
      and exists (
        select 1 from public.room_members m
        where m.room_id = study_resources.room_id
          and m.user_id = auth.uid()
      )
    )
  );

-- Insert: only as yourself, only into a room you belong to, and only into the
-- key layout the storage policies expect. The `storage_path` half is what
-- keeps a metadata row and its object in agreement — a row written by hand
-- through PostgREST cannot claim a key under someone else's folder.
create policy "study_resources_insert_own_member"
  on public.study_resources
  for insert to authenticated
  with check (
    owner_id = auth.uid()
    and (
      (
        room_id is null
        and storage_path like 'personal/' || auth.uid()::text || '/%'
      )
      or (
        room_id is not null
        and storage_path like 'rooms/' || room_id::text || '/' || auth.uid()::text || '/%'
        and exists (
          select 1 from public.room_members m
          where m.room_id = study_resources.room_id
            and m.user_id = auth.uid()
        )
      )
    )
  );

-- Update: the uploader only. The column grant already excludes `owner_id`,
-- `room_id`, `storage_path` and every timestamp, so a title edit can neither
-- move the file to another owner nor to another room.
create policy "study_resources_update_own"
  on public.study_resources
  for update to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

-- Delete: the uploader only. A room member sees the file but cannot remove it.
create policy "study_resources_delete_own"
  on public.study_resources
  for delete to authenticated
  using (owner_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Private bucket. Created by the migration so `supabase db reset` is enough to
-- provision the feature; `on conflict` keeps it idempotent for a stack that
-- already has it. Never public: there is no code path that produces a permanent
-- URL for these bytes.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'study-resources',
  'study-resources',
  false,
  20971520,
  array['application/pdf', 'image/png', 'image/jpeg', 'text/plain', 'text/markdown']::text[]
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------------
-- Storage policies.
--
-- `storage.foldername(path)` splits the key on "/" and returns every segment
-- **except the last** — the file name itself is deliberately dropped, because
-- that is the "folder" of the object. The layouts therefore resolve to:
--
--     personal/{owner}/{id}.pdf   -> {personal, owner}          length 2
--     rooms/{room}/{owner}/{id}.pdf -> {rooms, room, owner}     length 3
--
-- The exact `array_length` check is what makes the layout strict: a key with
-- extra segments lands on a different length and is denied, so
-- `personal/{owner}/../../x` cannot be made to line up.
--
-- Indexing past the end yields NULL, which compares to NULL and fails closed,
-- so a short or malformed key is denied without raising. Membership is matched
-- as `m.room_id::text = segment`, i.e. text against text — no cast of an
-- attacker-controlled segment to uuid, so no cast error can be turned into an
-- oracle.
-- ---------------------------------------------------------------------------
drop policy if exists "study_resources_objects_select" on storage.objects;
create policy "study_resources_objects_select"
  on storage.objects
  for select to authenticated
  using (
    bucket_id = 'study-resources'
    and (
      (
        array_length(storage.foldername(name), 1) = 2
        and (storage.foldername(name))[1] = 'personal'
        and (storage.foldername(name))[2] = auth.uid()::text
      )
      or (
        array_length(storage.foldername(name), 1) = 3
        and (storage.foldername(name))[1] = 'rooms'
        and exists (
          select 1 from public.room_members m
          where m.user_id = auth.uid()
            and m.room_id::text = (storage.foldername(name))[2]
        )
      )
    )
  );

drop policy if exists "study_resources_objects_insert" on storage.objects;
create policy "study_resources_objects_insert"
  on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'study-resources'
    and owner = auth.uid()
    and (
      (
        array_length(storage.foldername(name), 1) = 2
        and (storage.foldername(name))[1] = 'personal'
        and (storage.foldername(name))[2] = auth.uid()::text
      )
      or (
        array_length(storage.foldername(name), 1) = 3
        and (storage.foldername(name))[1] = 'rooms'
        and (storage.foldername(name))[3] = auth.uid()::text
        and exists (
          select 1 from public.room_members m
          where m.user_id = auth.uid()
            and m.room_id::text = (storage.foldername(name))[2]
        )
      )
    )
  );

-- The API is the only legitimate deleter, and it deletes an object it has just
-- proved the caller owns. Restricting DELETE to the object's own owner means a
-- member can never remove somebody else's upload by talking to storage
-- directly, even though they are allowed to read it.
drop policy if exists "study_resources_objects_delete" on storage.objects;
create policy "study_resources_objects_delete"
  on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'study-resources'
    and owner = auth.uid()
  );
