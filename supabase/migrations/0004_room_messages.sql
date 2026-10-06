-- SDYROOM 0004_room_messages: room chat history.
-- Local-only target: `npx supabase db reset` / `npx supabase db push --local`.
-- 0001_init.sql, 0002_room_membership.sql and 0003_focus_sessions_and_goals.sql
-- are already applied and are never edited: this file only adds.
--
-- Design
-- ------
-- room_messages
--   * Append-only history: SELECT for room members, INSERT for the sender as
--     themselves, and deliberately no UPDATE or DELETE grant and no policy —
--     a message that was said stays said. Anything beyond that is moderation,
--     which is out of scope here.
--   * `alias` is the sender's study alias copied at send time, so a message
--     is self-contained: rendering never joins `profiles` (whose RLS is
--     own-row only), and a later rename cannot rewrite the past.
--   * `user_id` is the sender and is pinned to `auth.uid()` by RLS. The API
--     maps it onto the viewer-relative `is_own` flag and never returns the id
--     itself; the raw id does travel in Realtime payloads to members of the
--     room, which is the same audience that can already see the alias.
--   * `seq` is a monotonic insert order (identity column). The history API's
--     `before=<message id>` cursor resolves to a sequence number, giving a
--     total order and stable pagination that `created_at` alone cannot —
--     two messages may share a timestamp.
--   * Body rules mirror the API validation: trimmed, 1–2000 characters.
--
-- Realtime: `room_messages` joins the `supabase_realtime` publication, so a
-- member's connected client receives INSERT events for their room. RLS is
-- applied at delivery, so a subscriber who is not a member receives nothing.
-- The client reduces each raw row to the same view shape the history
-- endpoint returns (alias, is_own, status), and deduplicates by id because a
-- send can be confirmed by both the POST response and its own event.

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------
create table public.room_messages (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  alias text not null,
  body text not null,
  seq bigint generated always as identity,
  created_at timestamptz not null default now(),
  constraint room_messages_body_len check (char_length(btrim(body)) between 1 and 2000),
  constraint room_messages_body_trimmed check (body = btrim(body)),
  constraint room_messages_alias_len check (char_length(alias) between 1 and 32)
);

create index room_messages_room_seq_idx on public.room_messages (room_id, seq desc);

-- ---------------------------------------------------------------------------
-- Grants. Same revoke-first shape as 0003: the stack's default ACL for new
-- tables is removed, then only the two verbs the contract needs are granted.
-- Without an UPDATE or DELETE grant, history cannot be edited through
-- PostgREST even before RLS is considered.
-- ---------------------------------------------------------------------------
revoke all on public.room_messages from anon, authenticated, service_role;

grant select, insert on public.room_messages to authenticated;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.room_messages enable row level security;

-- Any member of the room may read its messages.
create policy "room_messages_select_member" on public.room_messages
  for select to authenticated
  using (exists (
    select 1 from public.room_members m
    where m.room_id = room_messages.room_id and m.user_id = auth.uid()
  ));

-- A sender can only write as themselves and only into a room they belong to.
-- The API never takes a user id from the client; this policy is what makes a
-- forged one impossible even for direct PostgREST inserts.
create policy "room_messages_insert_own_member" on public.room_messages
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.room_members m
      where m.room_id = room_messages.room_id and m.user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- Realtime: members receive their room's INSERT events (RLS applies at
-- delivery). Goals-style private data stays out; only chat history joins.
-- ---------------------------------------------------------------------------
alter publication supabase_realtime add table public.room_messages;
