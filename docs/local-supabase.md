# Local Supabase (database foundation)

Everything here targets the **local** stack only. Nothing in this repo links to a
production Supabase project, and no migration is ever pushed to a remote database.

## Commands

Always go through the pinned CLI (`supabase@2.119.0`, declared in `devDependencies`)
so every teammate runs the same version:

```bash
npx supabase init            # creates supabase/config.toml (done; does not overwrite)
npx supabase start           # starts the local stack
npx supabase status          # or: npx supabase status -o env
npx supabase db lint --local # SQL lint over supabase/migrations
npx supabase db reset        # recreate the local DB from migrations (+ seed)
npx supabase migration list --local
npx supabase stop            # stop the stack (never `docker system prune`)
```

## Ports and isolation

| Service | Host port | Notes |
| --- | --- | --- |
| API (Kong) | 54321 | REST/GraphQL/Auth/Storage endpoint |
| **Postgres** | **54322** | `supabase_db_sdyroom`, container-internal port 5432 |
| Studio | 54323 | no auth in local mode |
| SMTP catcher | 54324 | local email inbox |
| Analytics | 54327 | |
| Edge runtime inspector | 8083 | |
| Shadow DB | 54320 | used by `db diff` |

The **Homebrew PostgreSQL on host port 5432 is a different server** and is never
touched: all psql invocations are guarded to refuse any target other than 127.0.0.1:54322.
Port 8000 is held by an unrelated container and 5000 by macOS ControlCenter; neither is
used by this stack (Storage is served through Kong on 54321).

## Environment variables

`.env.local` is populated from `npx supabase status -o env` and holds only the two
public, browser-safe values the app reads:

```
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<local publishable key>
```

- `.env.local` is ignored by git (`.gitignore` → `.env*.local`); never commit it.
- `.env.example` keeps placeholders only.
- `SECRET_KEY` / `SERVICE_ROLE_KEY` are **never** put in a `NEXT_PUBLIC_` variable,
  never in docs, logs, or reports. The app does not use them at all today.

## Email confirmation

`supabase/config.toml` sets `[auth.email] enable_confirmations = false` **for local
development only**, so signups are auto-confirmed against the local SMTP catcher on
:54324 and no manual click is needed.

**Production requirement:** set `enable_confirmations = true` and configure
`[auth.email.smtp]` with a real provider before any public launch. Email confirmation
must not be disabled outside local development.

## Schema

`supabase/migrations/0001_init.sql` creates three tables, all with RLS enabled.
`supabase/migrations/0002_room_membership.sql` adds only functions — `join_room`,
`leave_room` and `public_room_member_counts` — and changes no table, grant or policy.
`supabase/migrations/0003_focus_sessions_and_goals.sql` adds the shared focus timer
and personal goals: two tables, five RPCs, a trigger and the realtime publication.
`supabase/migrations/0004_room_messages.sql` adds append-only room chat (one table,
two policies, realtime). `supabase/migrations/0005_study_resources.sql` adds the
personal/room file library: one table, four table policies, a **private storage
bucket** and three policies on `storage.objects`.
`supabase/migrations/0006_realtime_private_channels.sql` adds no table, column or
grant: two policies on `realtime.messages` that gate private Realtime channels
(`room-presence-{roomId}`) to current members of the room named in the topic.
`supabase/migrations/0007_room_invitations.sql` adds addressed private-room
invitations and the roster read: one table (read-only for clients), one policy,
five `SECURITY DEFINER` RPCs (`create_room_invitation`, `accept_room_invitation`,
`reject_room_invitation`, `revoke_room_invitation`, `room_roster`), and one
`CREATE OR REPLACE` that lifts the 0002 seat logic into an internal
`join_room_core` while keeping `join_room`'s signature, behaviour and grants
identical.
`supabase/migrations/0009_moderation.sql` adds member safety: five tables
(`moderation_reports`, `moderation_actions`, `room_moderators`, `room_mutes`,
`user_blocks`), thirteen new functions (reports and verdicts, the moderator
inbox, removal, mute/unmute, moderator appointment, blocks,
`room_moderation_info`, two small helpers) plus `accept_room_invitation`
re-created with a block check, two
narrow `SELECT` grants, four policies (two new own-row policies plus
`room_messages`' two policies re-created with exactly one added conjunct each),
and **no** table grant at all on reports, actions or moderators. Every
privileged mutation writes one `moderation_actions` audit row in the same
transaction, so the audit trail exists only as a side effect of the action it
describes.
`supabase/migrations/0010_resource_hardening.sql` adds upload abuse protection:
one counter table (`rate_limits`), four functions (`rate_limit_take`,
`resource_quota_ok`, `resource_quota`, `study_resources_quota_guard`), one
BEFORE INSERT trigger on `study_resources`, and execute-grant hygiene — and
**no new policy anywhere** (the limiter's table is closed by grants *and* by
RLS-with-zero-policies instead).
`supabase/migrations/0011_resource_moderation_delete.sql` (merged on `main`
as GitHub #14) allows a room owner or appointed moderator to remove a shared
resource: one SECURITY DEFINER function (`delete_moderated_resource`, granted
to `authenticated` only), a widened re-creation of the room-owner storage
DELETE policy, and a `resource_removed` addition to the `moderation_actions`
action CHECK — no new table, no new public policy.
`supabase/migrations/0012_notifications.sql` adds the in-app notification
foundation: one table (`notifications`), one column on `profiles`
(`notification_prefs jsonb`, default `'{"default": "all"}'`), four functions
(`push_notification` and `push_report_notification` — the only writers, both
SECURITY DEFINER with a closed producer-rule table in the migration header —
plus the invoker's-rights `notifications_unread_count()` and the
service-role-only `prune_notifications(before)`), three own-row policies, a
narrow column-level grant on the new prefs column, and the table's entry in
the `supabase_realtime` publication. Rows can never be `INSERT`ed by any
application role: the exact verbs `authenticated` holds are `SELECT`,
`UPDATE (read_at)` and `DELETE`, all scoped by `user_id = auth.uid()`.
`supabase/migrations/0013_ai_documents.sql` adds the AI document foundation:
the `vector` extension in the `extensions` schema (pgvector), three tables
(`study_ai_documents` with the ingest state machine, `document_chunks` with a
`vector(1536)` embedding and an HNSW index, `ai_usage`), three own/visible-row
select policies with **no write policy anywhere**, and the ingest/retrieval
RPCs (`ingest_begin`, `ingest_record_extraction`, `ingest_record_chunks`,
`ingest_record_chunk`, `ingest_mark_failed`, `match_document_chunks`,
`ai_usage_daily`, plus helpers) — every write to the three tables travels
through those SECURITY DEFINER functions.

`supabase/migrations/0019_quiz_artifacts.sql` adds AI quizzes and flashcards:
three tables (`study_artifacts` with the ready/failed payload CHECKs,
`quiz_attempts` as the immutable score ledger, `flashcard_reviews` as the
per-user SM-2-lite schedule), three own/visible-row select policies with
**no write policy anywhere**, and the six RPCs (`create_artifact`,
`complete_artifact`, `fail_artifact`, `delete_artifact`, `record_attempt`,
`review_card`) — every write to the three tables travels through those
SECURITY DEFINER functions, and `select` on all three is column-scoped so a
wildcard fails on privilege grounds.

`supabase/migrations/0023_profile_language.sql` adds the one column PR 20
needed: `profiles.language` — nullable (no preference is the default, every
existing row stays valid), trimmed, 1–40 chars (`profiles_language_len` and
`profiles_language_trimmed` CHECKs). Structural checks only: the closed
vocabulary lives in `lib/vocab/languages.ts` at the API boundary, so
widening the list never needs a migration. Grants follow the same discipline
as `0001`/`0012` — `revoke all … from anon` re-asserts the floor, then
explicit column privileges `select`/`insert`/`update (language)` to
`authenticated`, additive to the profile grants that already exist.

`supabase/migrations/0025_communities_e2ee.sql` adds the end-to-end-encrypted
communities surface: eight tables (`communities`, `community_members`,
`community_channels`, `community_messages`, `community_welcomes`,
`community_devices`, `community_attachments`, `community_reports`), a
**second private storage bucket** (`community-attachments`) with three
path-derived policies, eight SECURITY DEFINER functions (`create_community`,
`join_community`, `leave_community`, `set_community_member`,
`kick_community_member`, `community_roster`, plus the `is_community_member`
/ `is_community_staff` predicates RLS itself calls), twenty table policies,
and the `community_messages` entry in the `supabase_realtime` publication.
Every one of the eight tables starts revoked from `anon`, `authenticated` and
`service_role` (revoke-first, like `0003`) and receives only the verbs it
needs — `community_members` is `SELECT`-alone, so every membership write
(create/join/leave/set/kick) is RPC-only, and message, commit and welcome
rows hold base64 MLS envelopes only: opaque by design, decrypted on devices
(`docs/SECURITY.md` §Communities).

| Table | Key columns | Notes |
| --- | --- | --- |
| `profiles` | `id` → `auth.users`, `alias`, `exam_targets`, `language`, `notification_prefs`, `created_at` | No email, no auth metadata, no other PII. `alias` 1–32 chars, trimmed, unique on `lower(alias)` (case-insensitive, no `citext`). `exam_targets` is a `jsonb` array, default `'[]'`. `language` (`0023`) is nullable, trimmed, ≤ 40 chars (values from `lib/vocab/languages.ts`, enforced at the API). `notification_prefs` (`0012`) is a `jsonb` object of per-category values from `all`/`mentions_and_invites`/`none` plus a `default` key (default `'{"default": "all"}'`), writable only through a narrow column-level `UPDATE` grant. |
| `rooms` | `id`, `owner_id` → `auth.users`, `visibility`, `name`, `capacity`, `exam_track`, `subject`, `language`, `status`, `shared_goal`, `created_at`, `updated_at` | `visibility` ∈ `public`/`private`; `status` ∈ `open`/`closed` (default `open`); `capacity` 1–100 (default 4); name 1–100 chars trimmed. Partial index on public rooms by `created_at desc`. The discovery keyset and filter columns gained four more public-scoped indexes in `0022` (`rooms_visibility_created_id_idx (visibility, created_at desc, id desc)` plus one per `lower(subject)`/`lower(exam_track)`/`lower(language)`), and `last_activity_at` is derived inside `list_public_rooms` from the two activity sources — no column is stored or maintained. |
| `room_members` | PK `(room_id, user_id)`, `role`, `joined_at` | `role` ∈ `owner`/`student` (default `student`). `room_id` and `user_id` both `ON DELETE CASCADE`. Index on `user_id`. |
| `focus_sessions` | `id`, `room_id` → `rooms`, `state`, `duration_seconds`, `started_at`, `ends_at`, `paused_at`, `paused_seconds`, `ended_at` | `state` ∈ `running`/`paused`/`completed`/`expired`. Partial unique index `focus_sessions_one_active (room_id) where state in ('running','paused')` — at most one active session per room, concurrency-safe. CHECKs pair `paused ⇔ paused_at` and `terminal ⇔ ended_at`, and require `ends_at > started_at`. Selected by `authenticated` only; every write goes through the RPCs. |
| `study_goals` | `id`, `user_id` → `auth.users`, `room_id` → `rooms`, `title`, `target_seconds`, `target_count`, `status`, `completed_at`, `created_at`, `updated_at` | Personal rows: `status` ∈ `active`/`completed`, `completed_at` set and cleared by the `study_goals_touch` trigger (never accepted from a client), CHECK `(status = 'completed') = (completed_at is not null)`. Partial unique index on `(user_id, room_id, lower(title)) where status = 'active'` — one active goal per title, reusable once completed. `study_goals_room_created_idx (room_id, created_at desc)` (`0021`) serves the room aggregate. `user_id`/`room_id` cascade on delete. |
| `room_messages` | `id`, `room_id` → `rooms`, `user_id` → `auth.users`, `alias`, `body`, `seq`, `created_at` | Append-only chat history: `SELECT`+`INSERT` only, no `UPDATE`/`DELETE` grant and no such policy, so a message that was said stays said. `alias` is the sender's study alias copied at send time (rendering never joins `profiles`); `seq` is an identity column giving a total order for `before=` cursor pagination that `created_at` alone cannot. CHECKs: body trimmed, 1–2000 chars; alias ≤ 32. Index `room_messages_room_created_idx (room_id, created_at desc)` (`0022`) serves the discovery activity scan. |
| `study_resources` | `id`, `owner_id` → `auth.users`, `room_id` → `rooms`, `storage_path`, `title`, `original_filename`, `content_type`, `size_bytes`, `subject`, `chapter`, `created_at`, `updated_at` | `room_id IS NULL` = personal (uploader only), otherwise shared with that room's current members. `owner_id` defaults to `auth.uid()` and is granted for **neither** `INSERT` nor `SELECT`, so a browser cannot choose an owner and the column never leaves the database. `storage_path` is server-built and pinned by a regex CHECK to `personal/{owner}/{id}{ext}` or `rooms/{room}/{owner}/{id}{ext}`, with a second CHECK tying the two representations of scope together (`(room_id is null) = (storage_path like 'personal/%')`). `content_type` ∈ the five sniffed types, `size_bytes` 1–20 MiB. Unique on `storage_path`; `updated_at` owned by `study_resources_touch`. |
| `room_invitations` | `id`, `room_id` → `rooms`, `inviter_id` → `auth.users`, `invitee_id` → `auth.users`, `inviter_alias`, `invitee_alias`, `room_name`, `status`, `expires_at`, `created_at`, `resolved_at` | Addressed invitation: the owner names a student by alias; only that student may read or act on it. `status` ∈ `pending`/`accepted`/`rejected`/`revoked` with `pending ⇔ resolved_at is null`; **no stored `expired` state** — `expires_at > created_at` is checked at read time. Partial unique index `room_invitations_one_pending (room_id, invitee_id) where status = 'pending'` (at most one pending invite per room+invitee, absorbs the create race → `23505` → `already_invited`); inbox and owner-list indexes on `invitee_id` / `inviter_id`. Alias and room-name copies are 1–32/1–100 char CHECKs. `SELECT` only for clients — all four writes are `SECURITY DEFINER` RPCs. |
| `moderation_reports` | `id`, `room_id` → `rooms`, `subject_type`, `subject_id`, `subject_user_id`, `reporter_id`, `reason`, `detail`, `status`, `created_at`, `resolved_at`, `resolved_by` | A report about one subject in one room (`0009`). `subject_type` ∈ `user`/`message`/`resource` with a deliberately FK-less `subject_id` — the RPC proves the subject existed at report time, and the report stays readable after the subject disappears. `reason` is a closed 7-value enum (`spam`, `harassment`, `abusive_content`, `inappropriate_content`, `impersonation`, `unsafe_resource`, `other`); `detail` ≤ 500 chars. `status` ∈ `pending`/`reviewing`/`resolved`/`dismissed`; partial unique `moderation_reports_active_subject_idx (reporter_id, subject_type, subject_id) where status in ('pending','reviewing')` collapses an open duplicate to an idempotent `200`. **`reporter_id` has no `SELECT` grant for any role**, and the table has no grant at all: reads and writes are RPC-only. |
| `moderation_actions` | `id`, `room_id` → `rooms`, `actor_id`, `action`, `subject_user_id`, `subject_ref`, `reason`, `created_at` | The audit trail (`0009`): one row per privileged mutation, written inside the same transaction as it. `action` ∈ `member_removed`/`mute_applied`/`mute_lifted`/`moderator_appointed`/`moderator_revoked`/`report_reviewed`/`report_resolved`/`report_dismissed`. **Zero grants for every role** — structurally unforgeable; nothing ever returns the table to a client either. |
| `room_moderators` | `room_id` → `rooms`, `user_id` → `auth.users`, `granted_by`, `created_at`, PK `(room_id, user_id)` | Owner-appointed, room-scoped moderator grants — the *only* moderator concept in the schema (no global role exists). Zero grants; read inside the definer functions, cascade away with the room or the account. |
| `room_mutes` | `room_id`, `user_id`, `muted_until`, `muted_by`, `created_at`, unique `(room_id, user_id)` | One live mute per member per room (`0009`). Uniqueness is **total**, not partial: a `where muted_until > now()` predicate would not be immutable, so the RPC sweeps expired rows before inserting instead. `SELECT` for `authenticated` (the `room_messages` INSERT policy subquery needs it) plus an own-row policy; writes are RPC-only. |
| `user_blocks` | `blocker_id` → `auth.users`, `blocked_id` → `auth.users`, `created_at`, PK `(blocker_id, blocked_id)`, CHECK `blocker_id <> blocked_id` | One-directional blocks (`0009`): visible to the blocker only, neither side notified. `SELECT` for `authenticated` (the `room_messages` SELECT policy filters on it) plus an own-row policy; writes are RPC-only. |
| `rate_limits` | `key` (PK), `window_start`, `count` | Fixed-window counters for the shared limiter (`0010`). **Zero grants and zero policies for every role** — the only writer and reader is the `rate_limit_take` SECURITY DEFINER RPC, so a direct PostgREST access dies on `42501` before RLS is even consulted, and a hypothetical future grant would still be filtered to nothing by the policy-free table. |
| `notifications` | `id`, `user_id` → `auth.users`, `type`, `payload` (jsonb), `read_at`, `created_at`, `room_id` → `rooms`, `dedupe_key` | One row per delivered event (`0012`). `type` is a closed CHECK enum (`invite_created`/`invite_accepted`/`member_removed`/`muted`/`moderation_resolved`/`report_resolved`/`resource_ready`/`ai_task_complete`/`system`); `payload` holds `{title, body, href}` and `href` is derived at read time, never trusted from storage. Partial unique index `(user_id, dedupe_key) where read_at is null and dedupe_key is not null` collapses unread duplicates; `user_id`/`room_id` cascade on delete. `SELECT`/`UPDATE (read_at)`/`DELETE` for `authenticated`, each under its own `user_id = auth.uid()` policy; **no `INSERT` for any role** — the only writers are the two SECURITY DEFINER producer RPCs. |
| `study_artifacts` | `id`, `room_id` → `rooms`, `creator_id` → `auth.users`, `kind`, `status`, `error_code`, `difficulty`, `question_count`, `card_count`, `resource_ids`, `payload` (jsonb), `model`, `prompt_tokens`, `completion_tokens`, `created_at`, `completed_at` | One generated quiz or deck (`0019`). `kind` ∈ `quiz`/`deck`; `status` ∈ `generating`/`ready`/`failed`; `error_code` ∈ `no_documents_indexed`/`ai_provider_failed`/`ai_quota_exceeded`. Two shape CHECKs pair quiz↔`question_count` with deck↔`card_count` so counts and kind cannot drift, and a third ties `payload` presence to `status = 'ready'`; `payload` is null-or-object and, per `ready_payload_check`, present exactly when `status = 'ready'` — it carries the whole quiz/deck **including the answer key**, and `resource_ids` is the 1–25 pinned inputs. `select` is column-scoped (all but `prompt_tokens`/`completion_tokens`), so token accounting never leaves the database; **no write grant for any role** — inserts go through `create_artifact`, the flip to `ready`/`failed` through `complete_artifact`/`fail_artifact`. Indexes on `(room_id, kind, created_at desc)` and `(creator_id, created_at desc)`. |
| `quiz_attempts` | `id`, `artifact_id` → `study_artifacts`, `user_id` → `auth.users`, `answers` (jsonb array), `score`, `total`, `correct` (jsonb array), `duration_ms`, `created_at` | The immutable score ledger (`0019`) — one row per submit, so retakes never overwrite. `answers` is the submitted indices, `correct` the per-question boolean, and `score`/`total` are computed by `record_attempt` against the stored key (a client can never write them). `duration_ms` 0–86 400 000 ms. `select` is column-scoped to the whole surface; **no write grant for any role**. Indexes on `(user_id, created_at desc)` and `(artifact_id, user_id)`, plus `quiz_attempts_artifact_created_idx (artifact_id, created_at desc)` (`0021`) for the room aggregate. |
| `flashcard_reviews` | `id`, `artifact_id` → `study_artifacts`, `user_id` → `auth.users`, `card_ordinal`, `grade`, `streak`, `ease`, `interval_days`, `last_reviewed_at`, `next_review_at` | The per-user SM-2-lite schedule (`0019`): `grade` ∈ `again`/`got_it`, `streak` ≥ 0, `ease` ≥ 1.3, `interval_days` ≥ 0, and `next_review_at` the next time the card is due. `unique (artifact_id, user_id, card_ordinal)` plus the `review_card` upsert means grading a card twice moves the schedule instead of stacking rows. `select` is column-scoped; **no write grant for any role**. Index on `(user_id, next_review_at)` for the due-cards query. |
| `study_plans` | `id`, `user_id` → `auth.users`, `room_id` → `rooms` (nullable), `status`, `error_code`, `exam_date`, `hours_per_day`, `topics` (text[]), `document_ids` (uuid[]), `summary`, `model`, `prompt_tokens`, `completion_tokens`, `generated_at`, `archived_at`, `created_at`, `updated_at` | One personal study plan (`0020`). `status` ∈ `generating`/`active`/`archived`/`failed`; `error_code` ∈ `ai_provider_failed`/`ai_quota_exceeded` (null otherwise); `hours_per_day` 1–12; `topics`/`document_ids` ≤ 25 entries; `study_plans_active_generated_check` requires `generated_at` on `active` rows. **One active and one generating row per user** are partial unique indexes (`study_plans_one_active`, `study_plans_one_generating`), and `regenerate: true` archives the active row in the same transaction as the insert. `select` is column-scoped (all but `prompt_tokens`/`completion_tokens` — the same posture as `study_qa`/`study_artifacts`); **no write grant for any role** — inserts go through `create_plan`, the flip to `active`/`failed` through `generate_plan`/`fail_plan`, the end through `archive_plan`. Index on `(user_id, status, created_at desc)` for the list route. |
| `plan_items` | `id`, `plan_id` → `study_plans`, `ordinal`, `item_date`, `subject`, `task`, `kind`, `estimated_minutes`, `resource_id` → `study_resources` (nullable, `on delete set null`), `citation` (jsonb), `done_at`, `created_at`, `unique (plan_id, ordinal)` | The day-by-day checklist (`0020`). `kind` ∈ `read`/`practice`/`review`/`mock`/`rest`; `estimated_minutes` 1–480; `citation` is null-or-object and **rebuilt server-side** from the pinned `resource_id` (`{title, href}`) — a fabricated id raises `plan_invalid` in `generate_plan` and a deleted document nulls the reference without touching the citation the RPC stored. `done_at` is the first-completion timestamp (`mark_plan_item` never rewrites it). `select` is column-scoped to the whole surface; **no write grant for any role** — inserts go through `generate_plan`, the done flip through `mark_plan_item`/`complete_plan_day`/`shift_plan`. Indexes on `(plan_id, item_date, ordinal)` (the schedule order) and a partial `(plan_id) where done_at is null` (the working set every progress read and shift window filters on). |
| `communities` | `id`, `slug` (unique), `name`, `description`, `category`, `visibility`, `join_policy`, `rules`, `owner_id` → `auth.users`, `member_count`, `created_at`, `updated_at` | One encrypted community (`0025`). CHECKs pin the slug format (`^[a-z0-9][a-z0-9-]{2,38}[a-z0-9]$`), name 3–60 trimmed, description ≤ 1000, rules ≤ 2000, the six-value `category`, `visibility ∈ public/private`, `join_policy ∈ open/request`, the `private → request` pairing (`communities_private_is_request`) and `member_count ≥ 1`. `owner_id` cascades with the account. Discovery index `communities_discovery_idx (visibility, category, created_at desc)`. Grants `SELECT/INSERT/UPDATE/DELETE`, but the four policies make it: visible = public **or** member, insert = owner-self, update = staff, delete = owner. |
| `community_members` | PK `(community_id, user_id)`, `role`, `status`, `joined_at`, `updated_at` | Membership (`0025`). `role ∈ owner/moderator/member`, `status ∈ active/requested/banned`; partial unique index `community_members_one_owner (community_id) where role = 'owner'` pins exactly one owner. Index on `(user_id, status)`. **`SELECT` grant alone** — every membership write is a SECURITY DEFINER RPC, so self-promotion, self-unban, ban bypass and `member_count` drift are unreachable over PostgREST. |
| `community_channels` | `id`, `community_id` → `communities`, `name`, `slug`, `description`, `position`, `created_at` | One channel per MLS group (`0025`). Name 1–40 trimmed, slug `general` or kebab (`unique (community_id, slug)`), description ≤ 200; `position` booked by the staff route as `max + 1`. `SELECT`/`INSERT` only; index on `(community_id, position, created_at)` for the sidebar order. |
| `community_messages` | `id`, `channel_id` → `community_channels`, `community_id`, `sender_id` → `auth.users`, `sender_device_id`, `kind`, `ciphertext`, `client_msg_id`, `seq` (identity), `created_at` | The encrypted stream (`0025`). `kind ∈ application/commit`; `ciphertext` base64, 16–262 144 chars; `sender_device_id` 8–64; `unique (channel_id, client_msg_id)` makes sends idempotent; `seq` gives the `before=` cursor. **Append-only** (`SELECT`/`INSERT` only, like `room_messages`); index on `(channel_id, seq desc)`; published to `supabase_realtime` — frames carry the stored ciphertext row. |
| `community_welcomes` | `id`, `channel_id`, `community_id`, `recipient_user_id` → `auth.users`, `recipient_device_id`, `sender_id`, `ciphertext`, `ratchet_tree`, `client_msg_id`, `seq` (identity), `created_at` | One addressed MLS welcome (`0025`): ciphertext 16–262 144 base64, `ratchet_tree` 16–1 MiB base64 (public leaf nodes only — RFC 9420's out-of-band distribution), recipient device id 8–64, `unique (channel_id, client_msg_id)`. `SELECT` is recipient-or-sender only; `INSERT` sender-plus-member. |
| `community_devices` | PK `(user_id, device_id)`, `key_package`, `signature_public_key`, `created_at`, `refreshed_at` | Published MLS key packages (`0025`) — public credential material by design, never a private key, and registering one joins no community (no community column exists). Device id 8–64, key package base64 64–65 536, signature key 16–256. Own-row `SELECT`/`INSERT`/`UPDATE`/`DELETE`, with a world-readable `SELECT` policy (`devices_select_authenticated`) because peers must fetch packages to run Add commits. |
| `community_attachments` | `id`, `community_id`, `channel_id`, `uploader_id` → `auth.users`, `storage_path` (unique), `ciphertext_size`, `content_type`, `created_at` | The ciphertext pointer (`0025`): bytes live in the `community-attachments` bucket; this row stores size (1–10 485 760), type and path only — never a file name, never plaintext. Path pinned by CHECK to exactly `community-attachments/{cid}/{chan}/{aid}`. `SELECT`/`INSERT`/`DELETE`; select = member, insert = own-plus-member, delete = uploader. |
| `community_reports` | `id`, `community_id`, `reporter_id` → `auth.users`, `target_type`, `target_id`, `reason`, `context_excerpt`, `created_at` | Voluntary reports (`0025`): `target_type ∈ message/member`, reason 1–500 trimmed, `context_excerpt` nullable ≤ 2 000 — the reporter's **deliberate plaintext** slice, because the server cannot scan ciphertext. `SELECT`/`INSERT` only: insert = own-plus-member, select = reporter-or-staff; there is no status machine. |

No sample rooms and no fabricated auth users are inserted by SQL: `supabase/seed.sql`
is intentionally empty, and local test data is made only through the Auth API and the
`create_room` / `join_room` / `create_room_invitation` RPCs.

`focus_sessions` and `room_messages` are added to the `supabase_realtime`
publication, so members' clients receive `postgres_changes` events for their room's
session and chat and re-read the view. Chat delivery is INSERT-only, so a row
committed between the server-rendered history read and the `SUBSCRIBED` ack
(reload race, or a reconnect after the socket drops) would otherwise be missed:
each ack triggers one catch-up read of `GET /api/rooms/[id]/messages`
(newest page, then `before=` cursor until known rows, capped at 10 pages)
that merges additively into the rendered history — a read, not a poll;
`notifications` (`0012`) joins the same
publication so an open tab's badge updates on insert — delivery is still filtered
by the subscriber's own `SELECT` RLS and a `user_id=eq.<me>` frame filter;
`study_goals` and `study_resources` are
deliberately not published (goals refetch, they are never pushed; files are listed
on demand, and a push would carry no bytes — downloads always go through the
signed-URL endpoint);
`community_messages` (`0025`) joins the publication for the encrypted chat
feed — the frame is the stored row (ciphertext plus metadata, never
plaintext), delivery is filtered per subscriber by the `messages_select_member`
policy exactly like `room_messages`, and clients merge inserts additively
behind the same "one catch-up read on ack" discipline.

## Grants

Grants are explicit and column-aware (`auto_expose_new_tables = false` in
`config.toml`, so new tables receive no default API-role grants):

| Grantee | `profiles` | `rooms` | `room_members` | `focus_sessions` | `study_goals` | `room_messages` | `study_resources` | `room_invitations` | `moderation_reports` | `moderation_actions` | `room_moderators` | `room_mutes` | `user_blocks` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `anon` | none | none | none | none | none | none | none | none | none | none | none | none | none |
| `authenticated` | `SELECT/INSERT` on `(id, alias, exam_targets, language, notification_prefs, created_at)`, `UPDATE` on `(alias, exam_targets)` and on `(notification_prefs)` and on `(language)` separately | `SELECT`, `INSERT` | `SELECT`, `INSERT` | `SELECT` | `SELECT`, `INSERT`, `DELETE`, `UPDATE (title, target_seconds, target_count, status)` | `SELECT`, `INSERT` | `SELECT` / `INSERT` / `UPDATE (title, subject, chapter)` / `DELETE`, each on an explicit column list — **never `owner_id`** | `SELECT` (whole table — the policy reads `inviter_id`/`invitee_id`, and Postgres checks privileges on every column a policy touches); **no write verb at all** | **none** | **none** | **none** | `SELECT` | `SELECT` |
| `service_role` | no data privileges | no data privileges | no data privileges | no data privileges | no data privileges | no data privileges | no data privileges | no data privileges | no data privileges | no data privileges | no data privileges | no data privileges | no data privileges |

`rate_limits` (`0010`) is deliberately absent from that table: it holds **no
grant for any role at all**. What it exposes instead is execute privilege on
functions: `rate_limit_take(text, integer, interval)`, `resource_quota_ok` and
`resource_quota` are executable by `authenticated` only (revoked from
`anon`/`public`), and `study_resources_quota_guard()` — the trigger function —
by no application role whatsoever (PostgreSQL fires triggers without an
EXECUTE check, so the quota guard runs for every insert while nothing can call
it directly).

`notifications` (`0012`) is also absent: `authenticated` holds exactly
`SELECT`, `UPDATE (read_at)` and `DELETE` — **no `INSERT` verb exists for any
role**, so the only way a row appears is one of the two SECURITY DEFINER
producer RPCs (`push_notification`, `push_report_notification`), each granted
to `authenticated` only. `notifications_unread_count()` is invoker's-rights
and likewise `authenticated`-only; `prune_notifications(before)` is granted to
`service_role` alone, so no application request can invoke retention. A psql
probe in `tests/integration/notifications.test.ts` freezes this matrix.

`study_ai_documents`, `document_chunks` and `ai_usage` (`0013`) follow the
same shape: absent from the table above, revoke-first, and **read-only for
clients** — `authenticated` holds column-scoped `SELECT` on each (so no
`INSERT`/`UPDATE`/`DELETE` reaches the state machine or the chunk table, and
`document_chunks.embedding` is granted for no verb at all: raw vectors can
never be selected through PostgREST). Every write is one of 0013's SECURITY
DEFINER RPCs. Execute on `ingest_begin`, `ingest_record_extraction`,
`ingest_record_chunks`, `ingest_record_chunk`, `ingest_mark_failed`,
`match_document_chunks`, `ai_usage_daily`, `resource_owner_ids` and
`is_resource_owner` is revoked from `public`/`anon` and granted only to
`authenticated`; the internal helper `ai_resource_for_ingest` and the trigger
function `study_ai_documents_touch()` are executable by **no** application
role at all (only this migration's definer functions and the trigger call
them).

`study_qa` (`0018`) closes the same way: revoke-first, column-scoped
`SELECT` for `authenticated` (id, room, conversation, user, question, answer,
citations, created_at — **no token or model columns**, so a wildcard `SELECT`
fails on privilege grounds), zero write grants for any role, and execute on
`record_qa` revoked from `public`/`anon` and granted only to `authenticated`.
The table's single policy (below) is the second layer.

`study_artifacts`, `quiz_attempts` and `flashcard_reviews` (`0019`) close the
same way: revoke-first, column-scoped `SELECT` for `authenticated`, zero write
grants for any role, and execute on `create_artifact`, `complete_artifact`,
`fail_artifact`, `delete_artifact`, `record_attempt` and `review_card` revoked
from `public`/`anon` and granted only to `authenticated`. The column scoping is
what keeps the answer key's siblings honest: `prompt_tokens` and
`completion_tokens` are granted for no verb, so a wildcard `SELECT` on
`study_artifacts` is `insufficient_privilege` and token accounting never leaves
the database — the same posture `study_qa` takes on its token/model columns.
The three tables' policies (below) are the second layer.

`study_plans` and `plan_items` (`0020`) close the same way: revoke-first,
column-scoped `SELECT` for `authenticated`, zero write grants for any role, and
execute on `create_plan`, `generate_plan`, `fail_plan`, `archive_plan`,
`shift_plan`, `mark_plan_item`, `complete_plan_day` and `plan_stats` revoked
from `public`/`anon` and granted only to `authenticated` — while
`plan_progress` (the progress formula) and `study_plans_touch_updated_at`
(the trigger helper) are revoked from `anon`/`authenticated` as well and
called only from the definer functions or the trigger. The column scoping
keeps the same promise: `prompt_tokens` and `completion_tokens` are granted
for no verb, so a wildcard `SELECT` on `study_plans` is
`insufficient_privilege`. The two tables' policies (below) are the second
layer.

The analytics surface (`0021`) adds **no table grant at all** — the
migration contains no `grant … on <table>` statement (the acceptance criterion
"no new privilege on any base table" holds by construction): `analytics_me`
and `analytics_room` are revoke-first execute grants (`public`/`anon`
revoked, `authenticated` granted) on SECURITY DEFINER readers that `select`
through their definer, and the migration's two supporting indexes
(`study_goals (room_id, created_at desc)`, `quiz_attempts (artifact_id,
created_at desc)`) change no privilege. `tests/integration/analytics.test.ts`
freezes the surface with `has_function_privilege` probes in both directions
plus an anon-execution denial.

The discovery surface (`0022`) closes the same way: `list_public_rooms`,
`room_preview` and `room_filter_options` are revoke-first execute grants on
SECURITY DEFINER readers, the migration contains no `grant … on <table>`
statement, and its five indexes (four on `rooms`, one on `room_messages`)
change no privilege. The visibility filter (`visibility = 'public'`) and the
preview's identical-`P0002` privacy rule live **inside** the functions, so
no route or parameter can widen them.
`tests/integration/room-discovery.test.ts` freezes the surface (authenticated
execute, anon refusal) alongside the privacy bait.

The communities surface (`0025`) repeats the revoke-first shape for eight
tables: `revoke all … from anon, authenticated, service_role` first, then
exactly the verbs the API and policies need —
`communities` gets `SELECT/INSERT/UPDATE/DELETE` (all four policy-gated:
visible, owner-self insert, staff update, owner delete), `community_members`
gets **`SELECT` alone** (every membership write — create/join/leave/set/kick —
is a SECURITY DEFINER RPC, which closes self-promotion, self-unban, ban
bypass and `member_count` drift at the privilege layer, before RLS is even
consulted), `community_channels`/`community_messages`/`community_welcomes`/
`community_reports` get `SELECT/INSERT` (messages are append-only like
`room_messages`), `community_attachments` gets `SELECT/INSERT/DELETE`, and
`community_devices` gets the full own-row `SELECT/INSERT/UPDATE/DELETE` for
its account-level key packages. Execute on all eight `0025` functions is
revoked from `public`/`anon` and granted only to `authenticated`;
`tests/integration/communities.test.ts` freezes the whole matrix
(`has_function_privilege` in both directions with full identity argument
lists, plus the three storage policies).

**No `UPDATE` or `DELETE` grant on `rooms` / `room_members` — and since `0008`
that is a deliberate design, not an undeveloped flow.** Room edits and deletion go
exclusively through the `update_room` / `delete_room` SECURITY DEFINER RPCs
(granted to `authenticated`, revoked from `anon`/`PUBLIC`), so a direct PostgREST
write fails with `42501` before any policy is consulted, while ownership, the
capacity floor and the row lock all live inside one transaction.
`room_members` writes were already RPC-only (`join_room` / `leave_room` /
invitation acceptance). `authenticated` has no table-level `SELECT` on `profiles` by design: only
the approved columns are granted, so application queries must list columns explicitly
(`select id, alias, ...`); never rely on `SELECT *` for profile responses. When a new
column is added to `profiles`, grant it only after it is approved.

The same shape repeats in `0003`: `focus_sessions` is **read-only** for clients (a
direct `INSERT`/`UPDATE` cannot start a session or rewind a deadline — only the
`SECURITY DEFINER` RPCs write), and `study_goals` gets a **column-scoped** `UPDATE`,
so `user_id`, `room_id`, `completed_at`, `created_at` and `updated_at` are not
addressable at all. The stack also defines a default ACL that would give these roles
`TRUNCATE`/`REFERENCES`/`TRIGGER`/`MAINTAIN` on new public tables, so `0003` starts by
revoking everything from `anon`, `authenticated` and `service_role` before granting.

`0004` and `0005` follow the identical revoke-first shape. `room_messages` gets only
`SELECT`/`INSERT` — with no `UPDATE` or `DELETE` grant, history cannot be edited
through PostgREST even before RLS is considered. `study_resources` is the first table
whose grant matrix is per-verb *and* per-column for every verb, and the first where a
column (`owner_id`) appears in none of them: an `INSERT` naming it fails on
privilege grounds, and a `SELECT` never has it to leak. `storage_path` *is* granted
for `SELECT` (the delete path needs to know which object to remove) but is excluded
from `STUDY_RESOURCE_COLUMNS`, so no response ever carries it.

`0007` is the second read-only table (after `focus_sessions`): `room_invitations`
revokes everything and grants `SELECT` only. The grant is whole-table rather than
column-scoped because the RLS policy itself references `inviter_id`/`invitee_id`, and
Postgres checks column privileges on every column a query — including policy
quals — touches; neither id ever leaves the API, which shapes responses from the
alias columns instead. With no write grant, create/accept/reject/revoke cannot be
reached through PostgREST at all (`42501` on privilege grounds), exactly like the
focus RPCs.

`0009` splits the same deny-by-default shape in two. `moderation_reports`,
`moderation_actions` and `room_moderators` get **no grant at all** for `anon`,
`authenticated` or `service_role` (revoked from those three and from `public`
first), so every read and write travels through a definer function:
`reporter_id` has no `SELECT` grant for any role and is structurally
unreachable, and an audit row cannot be manufactured through PostgREST even
before the zero-policy layer is consulted. `room_mutes` and `user_blocks` are
the exception that proves the rule: they receive a bare table-level `SELECT`
because policy subqueries run with the **invoker's** privileges — the
`room_messages` INSERT policy reads `room_mutes`, its SELECT policy reads
`user_blocks`, and a policy referencing an ungranted table fails with
"permission denied" instead of filtering. Each pairs that grant with an
own-row policy, so the direct read still returns nothing but the caller's
rows.

## Row Level Security

| Table | Policy | Effect |
| --- | --- | --- |
| `profiles` | `profiles_select_own` / `insert_own` / `update_own` | `id = auth.uid()` only |
| `rooms` | `rooms_select_public` | authenticated users read `public` rooms |
| `rooms` | `rooms_select_own` | owner reads own rooms (public *and* private) |
| `rooms` | `rooms_select_member` | members read rooms they belong to |
| `rooms` | `rooms_insert_self_owner` | `owner_id = auth.uid()` — impersonation impossible |
| `room_members` | `room_members_select_own` | `user_id = auth.uid()` — no other member's rows leak |
| `room_members` | `room_members_insert_owner_self` | only the room owner, about themselves, as `owner` |
| `focus_sessions` | `focus_sessions_select_member` | members of the room only; there is no insert/update/delete policy, so RLS denies them even if a grant ever appeared |
| `study_goals` | `study_goals_select_own` / `insert_own` / `update_own` / `delete_own` | `user_id = auth.uid()` only; the insert policy also requires membership of the goal's room, so a goal cannot be attached to a room the writer has not joined |
| `room_messages` | `room_messages_select_member` (`0009` re-created) | members of the message's room **and not blocked by the viewer** — one conjunct covers history reads, direct selects and realtime delivery (sender pinning and membership are byte-identical to `0004`) |
| `room_messages` | `room_messages_insert_own_member` (`0009` re-created) | `user_id = auth.uid()` **and** membership **and no active mute** — a direct PostgREST insert while muted answers `42501` exactly like any other policy denial |
| `study_resources` | `study_resources_select_own_or_member` | own rows, plus rows whose `room_id` has a `room_members` row for `auth.uid()` **right now** — leaving a room revokes read access on the next query, with no file moved or deleted |
| `study_resources` | `study_resources_insert_own_member` | `owner_id = auth.uid()`, membership of the target room, and a `storage_path` under the caller's own folder in the matching prefix |
| `study_resources` | `study_resources_update_own` / `delete_own` | `owner_id = auth.uid()` — a room member can read a shared file and still cannot edit or remove it |
| `room_invitations` | `room_invitations_select_addressed` (`0007`) | `invitee_id = auth.uid() or inviter_id = auth.uid()` — a student reads only invitations addressed to them, an owner only the ones they created, and a stranger reads nothing. Every *write* is an RPC, so there is no insert/update/delete policy to widen: the table simply has no write grant |
| `moderation_reports`, `moderation_actions`, `room_moderators` | none (`0009`) | deny-by-default twice: zero policies on top of zero grants. Every read and write is a definer RPC, so there is deliberately nothing for a policy to permit |
| `room_mutes` | `room_mutes_select_own` (`0009`) | `user_id = auth.uid()` only — the table-level `SELECT` exists for the chat policy's subquery, and this policy keeps the direct read scoped to the caller's own mute rows |
| `user_blocks` | `user_blocks_select_own` (`0009`) | `blocker_id = auth.uid()` only — the same reasoning as `room_mutes`; the blocked side never sees the row that names them |
| `rate_limits` | none (`0010`) | RLS enabled with **zero policies**: even if a grant ever appeared, every read and write would be filtered to nothing. `tests/integration/resource-hardening.test.ts` widens the grant inside the test and observes exactly that (`select` → 0 rows, `insert` → row-level security refusal), then revokes and re-checks `has_table_privilege` = `f` |
| `notifications` | `notifications_select_own` / `update_own` / `delete_own` (`0012`) | `user_id = auth.uid()` on all three verbs — a student lists, marks read and deletes only their own rows. There is deliberately no insert policy (and no insert grant), so a hypothetical widened grant would still produce nothing: the same two-layer shape as `rate_limits`, minus the RPC-only reads |
| `study_ai_documents`, `document_chunks` | `study_ai_documents_select_visible` / `document_chunks_select_visible` (`0013`) | the same audience as `study_resources`: your own files, plus files shared into rooms you are a member of right now — `is_resource_owner(...)` (a definer helper, because `study_resources.owner_id` carries no `SELECT` grant) OR a current `room_members` row. No insert/update/delete policy exists **and** no matching grant does either — two independent layers, so the state machine and the chunk table are RPC-only |
| `ai_usage` | `ai_usage_select_own` (`0013`) | `user_id = auth.uid()` — a student reads only their own ledger rows; every insert travels through `ingest_record_chunk` |
| `study_qa` | `study_qa_select_own` (`0018`) | own rows **and** a current `room_members` row for the row's room — a student reads only their own history, and it disappears the moment the seat does. No insert/update/delete policy exists **and** no matching grant does either: the table is RPC-only |
| `study_artifacts` | `study_artifacts_select_member` (`0019`) | room members read the artifacts of their room, payload included (the quiz runner needs it); no insert/update/delete policy exists **and** no matching grant does either — the table is RPC-only |
| `quiz_attempts` | `quiz_attempts_select_own` (`0019`) | own rows **and** a current `room_members` row for the artifact's room — a student reads only their own score rows, and they disappear with the seat. No insert/update/delete policy **and** no matching grant: `record_attempt` is the only writer |
| `flashcard_reviews` | `flashcard_reviews_select_own` (`0019`) | own rows **and** a current `room_members` row for the artifact's room — a student reads only their own spacing state. No insert/update/delete policy **and** no matching grant: `review_card` is the only writer |
| `study_plans` | `study_plans_select_own` (`0020`) | `user_id = auth.uid()` — a student reads only their own plans, and a foreign id is indistinguishable from a missing one (404 parity). No insert/update/delete policy exists **and** no matching grant does either: the table is RPC-only |
| `plan_items` | `plan_items_select_own` (`0020`) | own rows resolved through the owning plan (the subquery itself runs under this role, so `study_plans_select_own` applies there too). No insert/update/delete policy **and** no matching grant: `generate_plan`/`mark_plan_item`/`complete_plan_day`/`shift_plan` are the only writers |
| `communities` | `communities_select_visible` / `insert_self_owner` / `update_staff` / `delete_owner` (`0025`) | read = `visibility = 'public' or is_community_member(id)` (a private row is invisible to a stranger — the `404` parity starts here); insert requires `owner_id = auth.uid()` (the owner membership row only exists inside `create_community`, so a direct write cannot pass); update = `is_community_staff(id)`; delete = an owner row for `auth.uid()` |
| `community_members` | `members_select_own_or_roster` (`0025`) | own rows (`user_id = auth.uid()`) **or** any row while the caller is an active member of that community — co-members can see each other's role/status, a stranger sees nothing. Deliberately **one policy, one verb**: there is no insert/update/delete policy **and no write grant either**, so membership changes are RPC-only (second layer) |
| `community_channels` | `channels_select_member` / `channels_insert_staff` (`0025`) | read = active membership; insert = `is_community_staff(id)` — position booking and channel creation are staff-gated at both layers |
| `community_messages` | `messages_select_member` / `messages_insert_own_member` (`0025`) | read = active membership (this is also what filters realtime delivery); insert = `sender_id = auth.uid()` plus membership of the channel's community. Append-only: no update/delete policy **and** no such grant, so history cannot be edited even before RLS is considered |
| `community_welcomes` | `welcomes_select_recipient_or_sender` / `welcomes_insert_member` (`0025`) | read = the addressed device's user **or** the sender (nobody else — an welcome's ratchet tree must not leak to co-members); insert = sender pin plus membership |
| `community_devices` | `devices_select_authenticated` / `devices_insert_own` / `devices_update_own` / `devices_delete_own` (`0025`) | key packages are public credential material by design — any signed-in user may `SELECT` them (peers must fetch packages to run Add commits) — while every write is `user_id = auth.uid()` on both sides of the statement |
| `community_attachments` | `attachments_select_member` / `attachments_insert_own_member` / `attachments_delete_own` (`0025`) | read = active membership; insert = own row plus membership; delete = uploader only. The bytes are additionally gated by the storage policies below |
| `community_reports` | `reports_insert_own_member` / `reports_select_own_or_staff` (`0025`) | insert = `reporter_id = auth.uid()` plus membership (identity pinned in the row, never taken from a body); read = the reporter's own rows or `is_community_staff(id)` — staff see the inbox, members see only what they filed. No status machine and no update/delete verb |
| `realtime.messages` | `room_presence_select_member` / `room_presence_insert_member` (`0006`) | the whole of the private-channel gate for `room-presence-{uuid}` topics: `authenticated` only, extension must be `broadcast`/`presence`, and the uuid in the topic must match a current `room_members` row for `auth.uid()` — so a non-member (or an anonymous client) cannot join, cannot confirm a private room exists, and cannot read another room's roster. Realtime's authorization probes run as the caller inside a transaction that rolls back, so nothing is ever written |

Storage objects have their own seven policies (next section); they are not listed
above because they live on `storage.objects`, not on a table in `public`. The
`realtime.messages` row **is** listed even though that table lives in the `realtime`
schema: it carries no data of ours — it is Realtime's authorization surface.

There are **no policies for `anon` on any table** (verified: 0 policies for roles other
than `authenticated`), and anon holds no table privileges either.

## Private storage buckets (`0005_study_resources.sql`, `0025_communities_e2ee.sql`)

`storage.buckets` is written by the migrations themselves, so `supabase db reset`
provisions the whole feature — CI and a fresh checkout need nothing beyond the
migrations they already run (`on conflict` keeps it idempotent for a stack that
already has it):

| Bucket | `public` | `file_size_limit` | `allowed_mime_types` |
| --- | --- | --- | --- |
| `study-resources` | **false** | 20 971 520 (20 MiB) | `application/pdf`, `image/png`, `image/jpeg`, `text/plain`, `text/markdown` |
| `community-attachments` (`0025`) | **false** | 10 485 760 (10 MiB) | `application/octet-stream` (the only type storage will accept — clients upload **ciphertext**, so no media type could honestly describe it) |

The `study-resources` bucket's two limits are belt-and-braces under the API's own checks: the
route refuses on `content-length` before the body is buffered and sniffs the
bytes after parsing, and storage independently refuses any put that slips past
either. Per-user and per-room byte budgets are **not** a bucket setting (a
bucket cannot know which student is uploading) — they live in `0010` and are
enforced by the `study_resources_quota_guard` BEFORE INSERT trigger.

There is no code path that produces a permanent URL for these bytes.

**Key layout.** Three shapes, all built from server-generated UUIDs:

```
personal/{owner}/{id}{ext}                          the uploader, and nobody else
rooms/{room}/{owner}/{id}{ext}                      current members of {room}
community-attachments/{community}/{channel}/{id}    active members of {community}
```

`storage.foldername(name)` splits on `/` and returns every segment *except* the
last, so those keys resolve to array lengths **2**, **3** and **3** respectively
(the community shape has no file name at all — the original name travels
inside the E2EE payload). The
policies check `array_length(...) = n` exactly, which is what makes the layout
strict: a key with extra segments lands on a different length and is denied, so
`personal/{owner}/../../x` cannot be made to line up. Indexing past the end
yields `NULL`, which compares to `NULL` and fails closed, and membership is
matched as `m.room_id::text = segment` (or `m.community_id::text = segment`)
— text against text, so no
attacker-controlled segment is ever cast to `uuid` (no cast error to turn into
an oracle).

| Policy | Verb | Effect |
| --- | --- | --- |
| `study_resources_objects_select` | `SELECT` | own `personal/…` key, or any `rooms/{room}/…` key while a `room_members` row exists for `auth.uid()` — the same scope as the table policy, read out of the key |
| `study_resources_objects_insert` | `INSERT` | `owner = auth.uid()` plus the matching layout, so storage's own record of who wrote the object must agree with the path |
| `study_resources_objects_delete` | `DELETE` | `owner = auth.uid()` — one member can never remove another's upload by talking to storage directly, and the API can still clean up after a failed metadata insert |
| `study_resources_objects_delete_room_owner` (`0008`) | `DELETE` | any `rooms/{room}/…` key whose matching `study_resources` row belongs to a room `auth.uid()` **owns** — OR'd with the uploader-only policy above, so the owner can sweep member-uploaded objects when deleting the room, and nothing else. Proven by `tests/integration/room-management.test.ts`: the room owner removes a member's object, a stranger's remove changes nothing, the uploader still can |
| `community_attachments_select_member` (`0025`) | `SELECT` | any `community-attachments/{cid}/…` key while an **active** `community_members` row for `auth.uid()` matches segment 2 (text against text) — leaving, being kicked or banned revokes object reads on the next request, with no object moved |
| `community_attachments_insert_member` (`0025`) | `INSERT` | `owner = auth.uid()` **and** active membership of the community named in the path — the layout check still applies, and the path format is independently pinned by the table's `CHECK` |
| `community_attachments_delete_uploader` (`0025`) | `DELETE` | the matching `community_attachments` row's `uploader_id = auth.uid()` — deletion is keyed off the metadata row, so a member can never remove another's ciphertext by talking to storage directly |
| *(none)* | `UPDATE` | default deny; nothing in the app rewrites an object |

Because the key carries the scope, a hand-written `POST /storage/v1/object/…` is
subject to exactly the same rules as the app. Verified against the local stack:
an upload returns `403` the moment its `INSERT` policy is dropped, and
`createSignedUrl` answers "not found" with no `SELECT` policy. Storage RLS is
enforced for authenticated callers in general (`storage.protect_delete()` also
blocks a plain `delete from storage.objects` unless the session sets
`storage.allow_delete_query = 'true'`, which is what the e2e teardown does).

## `create_room` RPC

```sql
create_room(p_name, p_capacity=4, p_visibility='public',
            p_exam_track=null, p_subject=null, p_language=null,
            p_status='open', p_shared_goal=null) returns public.rooms
```

- `SECURITY INVOKER`, `set search_path = ''`, every reference schema-qualified.
- Owner comes from `auth.uid()`; there is **no owner parameter** to spoof.
- Inputs validated (name/capacity/visibility/status/lengths) → `22023` on failure;
  unauthenticated → `42501`.
- Room insert and owner-membership insert run in the same call: a failure in the second
  aborts the first, so no room can exist without its owner membership.
- `EXECUTE` granted to `authenticated` only; revoked from `PUBLIC` and `anon`
  (verified with `has_function_privilege` → anon `f`, authenticated `t`, public `f`).

## How atomic owner membership is enforced

SECURITY INVOKER means table privileges and RLS — not the function — decide what a
caller may do, so the RPC alone cannot be trusted as an invariant: a direct
authenticated `INSERT` into `public.rooms` is otherwise legal (the RPC needs that grant
to work). The safeguard is a **`DEFERRABLE INITIALLY DEFERRED` constraint trigger**:

```sql
create constraint trigger rooms_require_owner_membership
after insert or update on public.rooms
deferrable initially deferred
for each row execute function public.assert_room_has_owner_membership();
```

It runs at `COMMIT` on every row, whatever the write path (RPC, direct PostgREST call,
psql session), and raises `23514` unless a `room_members` row exists with
`room_id = rooms.id`, `user_id = rooms.owner_id`, `role = 'owner'`. The trigger
function is `SECURITY DEFINER` with a pinned empty `search_path` so the check reads
ground truth instead of the caller's RLS-filtered view.

## Membership functions (`0002_room_membership.sql`)

Three functions, all `SECURITY DEFINER` with `set search_path = ''`, every reference
schema-qualified, `auth.uid()` read and null-checked before any write, execution
revoked from `public` and `anon` and granted only to `authenticated`. They are the only
membership path in the product, and they were necessary because the grants above leave
`room_members` with `INSERT`+`SELECT` only:

- an RLS `with check` cannot take a row lock, so two students racing for the last seat
  could each pass a count and then both insert, exceeding `capacity`;
- the single insert policy lets an *owner* add their own row, so no client can write a
  `student` membership at all — and there is no `DELETE` grant for leaving.

| Function | Behaviour |
| --- | --- |
| `join_room(p_room_id uuid) → jsonb` | Locks the room row (`select … for update`), then: missing/private (non-member) → `room_not_found`; existing member, the owner included → `already_member` with no new row; `status <> 'open'` → `room_closed`; `count >= capacity` → `room_full`; otherwise inserts a `student` row and returns `joined`. `member_count` is the aggregate for public rooms and `null` for private ones. |
| `leave_room(p_room_id uuid) → jsonb` | Deletes only the caller's own `role = 'student'` row. Non-member of a public room → `not_a_member`, unknown or private room → `room_not_found`, owner → `owner_cannot_leave`, otherwise `left`. Takes no lock: deleting can only free a seat. |
| `public_room_member_counts() → table(room_id uuid, member_count bigint)` | Aggregate seat usage for `visibility = 'public'` only, so private-room occupancy and every participant identity stay inside the database. |

No table grant or policy changed, so direct PostgREST writes keep failing exactly as
before: `INSERT` hits RLS with `42501`, `DELETE` hits the missing grant with `42501`.

## Invitation and roster functions (`0007_room_invitations.sql`)

Six functions. Five are `SECURITY DEFINER` with `set search_path = ''`,
schema-qualified references, `auth.uid()` read and null-checked first, execution
revoked from `public`/`anon` and granted only to `authenticated` — the same
constraints as `0002`–`0005`:

| Function | Behaviour |
| --- | --- |
| `create_room_invitation(p_room_id, p_invitee_alias, p_ttl_hours) → jsonb` | Owner only, private rooms only (`room_public` otherwise). Resolves the alias to a user (`invitee_not_found`), refuses `self_invite`, an existing seat (`already_member`) or an existing pending row (`already_invited` — the loser of a create race hits `23505` on `room_invitations_one_pending` and maps to the same code). Copies `inviter_alias` / `invitee_alias` / `room_name` at create time and returns the shaped invitation with `invited`. |
| `accept_room_invitation(p_invitation_id) → jsonb` | The invitee only (the id alone proves nothing — `auth.uid()` must equal `invitee_id`, else `not_found`). Locks the row, then gates: not pending → `used` / `rejected` / `revoked`; `expires_at <= now()` → `expired` (no write). Seats through `join_room_core` with the private gate opened — `room_full` / `room_closed` flow back unchanged — then flips to `accepted` with `resolved_at`. Returns `{code: joined \| already_member, room_id, room_name, member_count}`; a repeat accept is `already_member` and still consumes the invitation. |
| `reject_room_invitation(p_invitation_id) → jsonb` | Same addressing and status gates; flips to `rejected` in place, taking no seat. Success returns `{code: 'ok'}` — deliberately distinct from the `rejected` failure code, so a caller can never mistake a successful rejection for the "already rejected" 409. |
| `revoke_room_invitation(p_room_id, p_invitation_id) → jsonb` | The room's owner *and* the original inviter (re-proved inside the function). Locks the row, refuses anything already resolved (`not_found` — an accepted invitation is no longer an invitation, and a repeat revoke is indistinguishable), flips to `revoked`. |
| `room_roster(p_room_id) → table(alias, role, joined_at)` | Membership re-checked inside the function (missing room and non-member both raise `42501`, which the route maps to the same `404` as anything else invisible). Returns display alias, role and `joined_at` ordered owner-first, then join time, then alias. No user ids — `room_members`' own grants and policies are untouched, so `room_members_select_own` still asserts "memberships private to the caller". |

Plus `join_room_core(p_room_id, p_user_id, p_allow_private)` — the 0002 seat
logic lifted verbatim, parameterised on the caller and the private gate —
and `join_room(p_room_id)` replaced by a one-line wrapper passing
`(p_room_id, auth.uid(), false)`. The `CREATE OR REPLACE` keeps an identical
signature and ACL, so external behaviour and grants are unchanged; the core's
`EXECUTE` is revoked from every application role, which makes
`p_allow_private` unreachable from a client: only the invitation path, after
it has proved a pending invitee row, can open it.

## Focus session and goal functions (`0003_focus_sessions_and_goals.sql`)

Five functions, all `SECURITY DEFINER` with `set search_path = ''`, schema-qualified
references, `auth.uid()` read and null-checked first, execution revoked from `public`
and `anon` and granted only to `authenticated` — the same constraints as `0002`.

| Function | Behaviour |
| --- | --- |
| `focus_room_check(p_room_id uuid, p_require_owner boolean) → text` | The single authorization helper: missing room or non-member → `room_not_found` (so a non-member cannot tell a private room from a missing one), and with `p_require_owner` a student → `not_owner`. Returns a code, never a row, so it cannot leak room data. **Revoked from every app role** — only the other functions may execute it. |
| `expire_focus_sessions_for(p_room_id uuid) → void` | Persists `state = 'expired', ended_at = ends_at` for rows whose deadline passed. Also revoked from every app role; called by the read and the RPCs, never by a client. |
| `focus_session_state(p_room_id uuid) → jsonb` | The read path: membership check, expiry pass, then `{ code: 'ok', session, viewer_role, member_count, server_now_ms }` where `session` is the active row or `null`, `server_now_ms` is the database clock in epoch milliseconds, and `member_count` comes from a definer read so students see seat usage without being able to enumerate `room_members`. |
| `start_focus_session(p_room_id uuid, p_duration_seconds integer) → jsonb` | Owner only. Validates 60–7200 s (`22023` otherwise), expires stale sessions first, then inserts with `started_at`/`ends_at` from `now()`. A concurrent loser blocks on `focus_sessions_one_active`, gets `23505`, and is handed the winning row as `already_active` — never a second row. |
| `pause_focus_session` / `resume_focus_session` / `end_focus_session` | Owner only. Pause records `paused_at` (the deadline does not move); resume credits the paused interval to `ends_at` and accumulates `paused_seconds`; end flips to `completed` with `ended_at = now()`. Each returns the code plus the row, or `no_active_session` / `invalid_state` (409) / `not_owner` (403) / `room_not_found` (404). |

Two deliberate refinements over the original design notes:

- **No `session_expired` result code.** Every read and every control persists expiry
  first, so a passed deadline surfaces as `no_active_session` (409) instead of a
  separate code — one fewer branch for clients to handle, and the state is always
  already written.
- **No `started_by` column.** Column-level `SELECT` grants do not exist in Postgres,
  so any column would be readable through raw PostgREST by anyone who can `SELECT`.
  Exposing "who started" would therefore require a policy that hides it from some
  members but not others; the column was dropped and the API carries no starter
  identity at all.

Goals need no RPC: `study_goals` is written through PostgREST, where the
column-scoped grants and `user_id = auth.uid()` policies are the whole security
model, and the `study_goals_touch` trigger owns `updated_at`/`completed_at` on every
update regardless of the writer.

## Room management functions (`0008_room_management.sql`)

```sql
update_room(p_room_id uuid, p_changes jsonb) returns jsonb
delete_room(p_room_id uuid) returns jsonb
```

- Both `SECURITY DEFINER`, `set search_path = ''`, execute revoked from `PUBLIC`
  and `anon`, granted to `authenticated` only (verified with
  `has_function_privilege`: authenticated `t`, anon `f`).
- `update_room` locks the room row (`select … for update` — the same lock
  `join_room` takes, which is what serializes a capacity shrink against a
  concurrent join), re-proves `owner_id = auth.uid()`, validates `status` and
  `capacity` in SQL as well as in Zod, applies the capacity floor
  (`new capacity >= (select count(*) from room_members …)`, else the
  `capacity_below_membership` envelope with the current count), and builds its
  `set` list from a fixed whitelist — a `p_changes` key that is not on the list
  (`owner_id`, `visibility`, `id`, `created_at`, `updated_at`, or anything
  unknown) is ignored, never applied. `updated_at` stays owned by the
  `rooms_set_updated_at` trigger from `0001`.
- `delete_room` locks the room row, re-proves ownership, and deletes the row so
  the six `on delete cascade` foreign keys (`room_members`, `focus_sessions`,
  `study_goals`, `room_messages`, `room_invitations`, `study_resources`) remove
  every dependent row in one statement. It does not touch storage: the route
  sweeps `rooms/{room}/**` **before** calling it, while the metadata rows the
  storage policies authorize against still exist.
- Envelope codes: `updated` / `deleted` on success; `room_not_found` (404),
  `not_owner` (403), `invalid_request` (400), `validation` (400),
  `capacity_below_membership` (409) on refusal.
- The migration adds **no** table grants and **no** `public.*` policies — the
  only DDL privilege change is the fourth storage policy,
  `study_resources_objects_delete_room_owner`, documented in the section above.

## Moderation functions (`0009_moderation.sql`)

Thirteen new functions plus `accept_room_invitation` re-created — all
`SECURITY DEFINER`, `set search_path = ''`, schema-qualified, `auth.uid()`
null-checked first, execute revoked from `public`/`anon` and granted only to
`authenticated`. Alias is the only identity in any parameter or response; user
uuids are resolved inside the definer only, which is why `reporter_id` can have
no grant and still be written.

| Function | Behaviour |
| --- | --- |
| `moderation_actor_role(p_room_id) → text` | The one authorization helper: `owner` / `moderator` / `member` / `none`, from `rooms.owner_id` and `room_moderators` before falling back to `room_members`. Returns a role, never a row. |
| `moderation_resolve_alias(p_alias) → uuid` | Alias → uuid inside the definer (null for blank or unknown). The uuid is never returned to a payload; `profiles` stays RLS own-only for direct reads. |
| `create_moderation_report(p_room_id, p_subject_type, p_subject_id, p_reason, p_detail) → jsonb` | Membership first, subject second, reporter pinned to `auth.uid()` — no parameter can carry an identity. Re-checks the enum, the 500-char detail and `self_report` in SQL as well as in Zod, proves the subject exists in that room (`invalid_subject`), and collapses an open duplicate to `200 { report, duplicate: true }` via `moderation_reports_active_subject_idx`. Success: `201 { report: { id, status, created_at } }`. |
| `set_moderation_report_status(p_report_id, p_status) → jsonb` | Moderator-only transition; anyone who is not the owner/moderator of the report's room gets the **same `not_found` as a missing id** — an opaque report id must not become an existence oracle. Allowed: `pending → reviewing\|resolved\|dismissed`, `reviewing → resolved\|dismissed` (`invalid_transition` otherwise). Writes exactly one `moderation_actions` row (`report_reviewed` / `report_resolved` / `report_dismissed`) in the same transaction. |
| `room_report_list(p_room_id, p_limit = 50) → jsonb` | The inbox: membership re-checked, returns `{ reports, count }` with subject aliases resolved inside the server. The projection **never selects `reporter_id`**, so it cannot leak by accident. |
| `remove_room_member(p_room_id, p_member_alias) → jsonb` | Owner or moderator removes a member under the room-row lock (`join_room_core` serialises against a concurrent join). Check order: actor gate (`not_found` for a non-member caller — indistinguishable from a missing room — then `not_moderator` for a plain member), target resolution (`not_found` for an unknown alias or a non-member target), then `cannot_remove_owner` and `cannot_remove_self`. Deletes the membership — messages stay (no `UPDATE`/`DELETE` grant on `room_messages`) — and sweeps the target's `room_moderators` row and active `room_mutes` row with it, because both mean nothing without membership. Returns `{ removed, member_count }` + audit row `member_removed`. |
| `mute_room_member(p_room_id, p_member_alias, p_interval) → jsonb` | Owner or moderator. Check order: actor gate (`not_found` for non-members, `not_moderator` for plain members), then **self first** (`cannot_mute_self`), then owner (`cannot_mute_owner`), then moderator (`cannot_mute_moderator`); the interval must be one of the three product durations (`1h`/`24h`/`7d` — re-checked in SQL, not just in Zod) and an overlapping active mute answers `already_muted`. Sweeps expired rows before inserting (total uniqueness on `(room_id, user_id)`). `201 { muted, muted_until }` + audit row `mute_applied`. |
| `unmute_room_member(p_room_id, p_member_alias) → jsonb` | Same gates minus the target rules; `not_muted` when no active row. `{ unmuted: true }` + audit row `mute_lifted`. |
| `set_room_moderator(p_room_id, p_member_alias, p_on) → jsonb` | **Owner only** — a non-member gets `not_found`, a member who is not the owner gets `not_owner` before any target logic runs, so a moderator may not mint moderators. Target rules: unknown alias or non-member target → `not_found`, the owner as target → `cannot_moderate_owner`. Idempotent — an unchanged appointment returns `200 { role, changed: false }`, a real flip `200 { role, changed: true, granted }`. Audit rows: `moderator_appointed` / `moderator_revoked`. |
| `create_user_block(p_alias) → jsonb` | Any signed-in user blocks any other (room membership irrelevant). `self_block` / `validation` refusals; an existing row answers `200 { block, created: false }` (idempotent), a new one `201 { block, created: true }`. The blocked side is never notified. |
| `delete_user_block(p_alias) → jsonb` | Removes the caller's own row; `{ removed }`. Nothing else in the system rewrites it — leaving a room does not unblock. |
| `list_my_blocks() → table(alias, created_at)` | The caller's rows only (`where blocker_id = auth.uid()`), newest first — no uuids, no one else's view. |
| `room_moderation_info(p_room_id) → jsonb` | One definer call for the page: membership required (`42501` → route `404`), returns `{ can_moderate, moderator_aliases, muted_aliases, viewer_is_muted, muted_until }`. Moderator/mute alias lists are visible only to owners and moderators; a plain member gets `muted_aliases: []` but their own `viewer_is_muted` flag (so the composer can explain itself before the first failed send). |
| `accept_room_invitation(p_invitation_id)` (`0007` re-created) | Unchanged from `0007` except one added gate after expiry: if the invitee has blocked the inviter, the invitation fails `blocked` — it stays pending, the blocker is never notified, and only the blocker (who must call accept themselves) ever sees the code. Grants are preserved by `CREATE OR REPLACE`; the `0007` file on disk is untouched. |

Every one of the mutating functions writes its `moderation_actions` row in the
same transaction as the action, so an action without an audit row (or vice
versa) cannot be committed.

## Rate limits, quotas and orphan cleanup (`0010_resource_hardening.sql`)

The three abuse controls PR 10 adds are all table-side, so they behave the
same on one dev machine and on many app instances — the counter *is* the
database.

| Object | Behaviour |
| --- | --- |
| `rate_limits(key, window_start, count)` | Fixed-window counter. **No grant, no policy, RLS on** — closed twice; only `rate_limit_take` touches it. |
| `rate_limit_take(p_key, p_max, p_window) → boolean` | SECURITY DEFINER, `search_path = ''`, execute `authenticated` only. One `INSERT … ON CONFLICT` upsert: atomic across instances, rejects `p_max < 1`/`p_window <= 0` with `22023`, returns `true` while `count <= p_max` and `false` once over — a take at `count = p_max` still allows (the *next* caller is refused), and a stale window restarts at 1. |
| `resource_quota_ok(p_room_id, p_add_bytes) → boolean` | SECURITY DEFINER pre-check the upload route calls *before* the bytes are written; **fails open** (an error is logged and `true` returned) because the trigger below is the authority. |
| `resource_quota(p_room_id) → jsonb` | SECURITY DEFINER display read for `GET /api/resources`: `{ scope, used_bytes, limit_bytes, user_used_bytes, user_limit_bytes }` from `coalesce(sum(size_bytes), 0)` — personal scope sums the caller's rows, room scope sums the room's. |
| `study_resources_quota_guard()` | BEFORE INSERT trigger on `study_resources`, executable by no application role. Re-checks both budgets **inside the inserting transaction** under `hashtextextended` advisory locks (user first, then room — a fixed order, so two racing uploads serialize instead of deadlocking) and raises `P0001` / `quota_exceeded`, which the route maps to `409` and rolls the just-written object back with the row. Limits: 1 GiB per user, 500 MiB per room (`v_user_limit` / `v_room_limit`, the single place to change them). |

Rate windows (published in `docs/API_CONTRACTS.md`, implemented in
`lib/rate-limit/keys.ts`): upload 20/min per user and 10/min per target,
delete 30/min, signed URL 120/min, sweep 5/min; reports 20/hour, blocks and
mutes 30/hour, invitations 10/hour; AI ingest steps 30/min and AI ingest
sweeps 6/min (`0013`/PR 12); asks 20/min per room+user (`0018`/PR 13); generate
and step 10/min per room+user (`0019`/PR 14). The limiter **fails open** by design
(`lib/rate-limit/check.ts`): only an explicit `false` refuses, and a database
hiccup is logged rather than turned into an outage.

The sweep itself is a route, not SQL — `POST /api/resources/cleanup`
(`app/api/resources/cleanup/route.ts`) — because SQL cannot call the Storage
API: the route lists objects under the caller's own prefix, compares them
against rows selected by `storage_path LIKE '<prefix>/%'`, removes orphan
objects first and broken rows second, and skips anything younger than a 60 s
grace period in both directions.

## Notification functions (`0012_notifications.sql`)

| Object | Behaviour |
| --- | --- |
| `notifications` | One row per delivered event. Closed `type` CHECK, `payload` jsonb, `read_at`, optional `room_id`, optional `dedupe_key`. Partial unique `(user_id, dedupe_key) where read_at is null and dedupe_key is not null` collapses unread duplicates. Own-row `SELECT`/`UPDATE (read_at)`/`DELETE`; **no `INSERT` grant for any role**. |
| `push_notification(p_user_id, p_type, p_payload, p_room_id, p_dedupe_key) → jsonb` | SECURITY DEFINER, execute `authenticated` only. Spec-exact signature; the target uuid is resolved in TypeScript through the existing `moderation_resolve_alias` RPC, so a route never hand-writes an id it has not proven. Enforces the closed producer rule table (header of the migration): `invite_created` requires the caller to own the room; `muted`/`member_removed`/`moderation_resolved` require owner or moderator; the self-scoped types require `p_user_id = auth.uid()`. Reads `profiles.notification_prefs` at write time and answers `muted` without a row when the category is off. Dedupe collapses (updates `created_at`/`payload`, answers `deduped`); a unique-violation race retries once. Returns `{ code, id? }` — `created`/`deduped`/`muted`/`validation`/`not_authorized`/`not_found`/`invalid_payload` — the repo's envelope convention, not a bare uuid. |
| `push_report_notification(p_report_id, p_type, p_payload, p_dedupe_key) → jsonb` | SECURITY DEFINER, execute `authenticated` only. Same rule table, but the **reporter's uuid is read from the report row** — it never travels through a route body (the PR-09 rule carried forward). A smuggled `user_id` in the payload is refused `invalid_payload`. |
| `notifications_unread_count() → integer` | Invoker's-rights (not definer) count of the caller's own unread rows — named to avoid public-schema pollution and granted to `authenticated` only. |
| `prune_notifications(p_before) → integer` | SECURITY DEFINER retention, **execute `service_role` only** — no application request can invoke it. Scheduled by pg_cron: migration `0024` installs the extension and books job `prune_notifications` (daily 03:17 UTC, 90-day cutoff, executes as the migration role). Inspect with `select jobname, schedule, active, username, command from cron.job where jobname = 'prune_notifications';`. Runbook below. |
| `profiles.notification_prefs` | jsonb column, default `'{"default": "all"}'`. Values from `all`/`mentions_and_invites`/`none`; `mentions_and_invites` means invites-only; `system` events ignore preferences. Writable through a narrow column-level `UPDATE` grant only. |

### Retention runbook (`prune_notifications`)

Notifications older than 90 days are pruned automatically: migration `0024`
schedules pg_cron job `prune_notifications` (daily 03:17 UTC) to call the
function, and a fresh `db reset` installs it with the rest of the schema. The
job runs as the role that applied the migration — never through the request
path, and the function stays `service_role`-only for direct calls. The
scheduler is verified by the integration probe that reads `cron.job`.

Manual runs remain useful for a one-off or a backfill. Against the local
stack, as superuser:

```sh
# How many rows would a 90-day prune remove?
docker exec -e PGPASSWORD=postgres supabase_db_sdyroom \
  psql -U postgres -d postgres -c \
  "select count(*) from public.notifications where created_at < now() - interval '90 days';"

# Prune them.
docker exec -e PGPASSWORD=postgres supabase_db_sdyroom \
  psql -U postgres -d postgres -c \
  "select public.prune_notifications(now() - interval '90 days');"

# Did the scheduled job run, and did it succeed?
docker exec -e PGPASSWORD=postgres supabase_db_sdyroom \
  psql -U postgres -d postgres -c \
  "select status, return_message, start_time from cron.job_run_details
     order by start_time desc limit 5;"
```

The function returns the number of rows it deleted. On hosted Supabase the
same migration books the same job once the migrations are pushed; verify with
the `cron.job` query in the migration header and in `docs/RELEASE.md`
(checklist item 8), which also records the chosen retention window.

## pgvector and the AI ingest functions (`0013_ai_documents.sql`)

**pgvector** is installed by the migration itself — `create extension if not
exists vector with schema extensions;` (after `create schema if not exists
extensions`), and a stack that already has the extension in another schema is
normalised with `alter extension vector set schema extensions`, failing loudly
if it cannot be moved. `pgvector` ships bundled in the local Supabase image,
so `npx supabase db reset` provisions it with everything else — no extra
startup flag is needed.

The dimension is **fixed at 1536**, matching `text-embedding-3-small`-class
models (the default `AI_EMBED_MODEL`):

- column `document_chunks.embedding extensions.vector(1536) not null` (a
  column CHECK rejects a wrong-width vector even through a definer RPC), with
  an HNSW index (`vector_cosine_ops`, pgvector defaults `m = 16`,
  `ef_construction = 64` for v1);
- RPC signature `match_document_chunks(p_room_id uuid, p_query_embedding
  extensions.vector(1536), p_limit int default 8, p_threshold float8 default
  0.2)`.

Changing the embedding model therefore requires a **new migration** that drops
and recreates the column, the index and every RPC signature, plus a full
re-embed of every ready document — never an edit to `0013` (the migration
header says so, and `tests/integration/ai-ingestion.test.ts` asserts
`vector_dims(embedding) = 1536`).

Verify against the local stack (port 54322):

```sql
\dx                                    -- or: select extname from pg_extension;
                                       --   → 'vector' present
select vector_dims(embedding)          -- after at least one ingest
  from public.document_chunks limit 1; --   → 1536
```

| Object | Behaviour |
| --- | --- |
| `study_ai_documents` | One row per ingested resource (PK = `resource_id`, `ON DELETE CASCADE`). `status` CHECK `pending/extracting/chunking/embedding/ready/failed`; `error_code` CHECK over `no_text_layer`/`extract_failed`/`extracted_too_large`/`ingest_failed`/`ai_quota_exceeded`/`ai_provider_failed`; transient `extracted_text`/`pending_chunks` carry work between one-step-per-request calls and are cleared at `ready`. Select-only for `authenticated` (visible-row policy), no write grant or policy — the `updated_at` trigger doubles as the sweep's stuck-row clock. |
| `document_chunks` | Ordered chunk text + `vector(1536)` embedding, `unique (resource_id, ordinal)` and a deterministic `chunk_hash = sha256(resource_id ‖ ordinal ‖ text)` so re-runs are idempotent. Written only by the ingest RPCs; `SELECT` is column-scoped and **excludes `embedding`** — vectors never leave over PostgREST. HNSW index above. |
| `ai_usage` | Per-call ledger (`embed_bytes`/`embed_tokens`, later `chat_tokens`); daily caps are `sum`s inside the RPCs. Own-row `SELECT`; inserts only through `ingest_record_chunk` (and, for chat, `record_qa`). |
| `study_qa` (`0018`) | Append-only Q/A history: one row per completed ask (`room_id`, client-generated `conversation_id`, `user_id`, question ≤ 2000 chars, answer, `citations` jsonb, token accounting, `created_at`). **No `INSERT`/`UPDATE`/`DELETE` grant for any application role** — every row is written by `record_qa`. `SELECT` is column-scoped (the history contract's columns only; token/model fields are ungranted, so a wildcard `SELECT` is `insufficient_privilege`). |
| `ai_resource_for_ingest(p_resource_id) → study_resources` | The single authorization + gate helper: missing resource → `not_found`, personal-not-yours → `not_resource_owner`, non-member → `not_member`, over 20 MiB → `too_large`, non-indexable type → `unsupported_media_type`, no session → `42501`. **Execute revoked from every application role** — only 0013's definer functions call it. |
| `ingest_begin(p_resource_id) → jsonb` | Authz re-check plus the only upsert of a `study_ai_documents` row: new rows start at `extracting`, an existing `failed` row is explicitly retried (resumes at `chunking` if extracted text survived, else `extracting`), all other states are returned unchanged (idempotent). |
| `ingest_record_extraction(p_resource_id, p_text) → jsonb` | Stores normalized text and moves the row to `chunking`; extracted text over 16 MiB lands `failed` with `extracted_too_large`. |
| `ingest_record_chunks(p_resource_id, p_chunks) → jsonb` | Writes the chunk drafts (no vectors yet), moves the row to `embedding`. |
| `ingest_record_chunk(p_resource_id, p_chunks, p_model, p_tokens) → jsonb` | The embed step's authority: re-checks the 50 MiB/day scope cap, deletes not-ready chunks for a re-run, inserts chunks + embeddings (as jsonb floats — no provider key ever reaches the database), computes `chunk_hash`, sets `ready`, and accumulates the `ai_usage` ledger in the same transaction. |
| `ingest_mark_failed(p_resource_id, p_error_code, p_status)` | Records a failure on `failed` (document outcome) or `embedding` (provider failure — stays resumable). |
| `match_document_chunks(p_room_id, p_query_embedding, p_limit, p_threshold) → table(...)` | SECURITY DEFINER retrieval: membership guard for room scope, `owner_id = auth.uid()` for personal scope, `status = 'ready'` only, cosine score `1 - (embedding <=> query)` above the threshold, `p_limit` clamped 1–50. A non-member gets zero rows; the embedding column itself is never returned. |
| `ai_usage_daily(p_user_id, p_room_id) → jsonb` | Today's `{ scope, used_bytes, used_tokens, limit_bytes (52428800), day_start }` for one scope; `p_user_id` must be the caller and a room scope requires membership (`not_found` otherwise). The same RPC `GET /api/ai/usage` reads and `ingest_record_chunk` enforces. |
| `resource_owner_ids(p_resource_ids) → setof uuid` | The ownership signal pages need for the owner-only "Index now" button — `study_resources.owner_id` has no `SELECT` grant, so this definer helper returns exactly the subset the caller owns. |
| `record_qa(p_room_id, p_conversation_id, p_question, p_answer, p_citations, p_model, p_prompt_tokens, p_completion_tokens, p_retrieval_tokens, p_retrieved_chunks) → jsonb` (`0018`) | The only insert path into `study_qa` (execute `authenticated` only): pins `user_id = auth.uid()`, re-checks room membership (`not_found`), validates the row, deduplicates a same-conversation/same-question row inside a 60-second window (returns the existing `{ qa_id, deduped: true, … }` instead of inserting), enforces the per-user daily chat-token cap (100 000, `ai_quota_exceeded`) against the same own-row `chat_tokens` sum the route pre-checks, and writes the `chat_tokens` (+ optional retrieval `embed_tokens`) ledger in the same transaction. Returns `{ qa_id, conversation_id, created_at, deduped, chat_used_today, chat_limit }`. |
| `create_artifact(p_room_id, p_kind, p_difficulty, p_count, p_resource_ids) → jsonb` (`0019`) | The only insert path into `study_artifacts` (execute `authenticated` only): pins `creator_id = auth.uid()`, re-checks room membership, re-validates the kind/count/difficulty domain, and re-checks that every requested resource is accessible to the caller (room-shared in this room, or the caller's own personal file) and has a `ready` AI document — a forged resource id can never enter an artifact. Writes a `generating` row. Returns `{ id, kind, status, difficulty, question_count, card_count, created_at }`. |
| `complete_artifact(p_artifact_id, p_payload, p_model, p_prompt_tokens, p_completion_tokens, p_retrieval_tokens) → jsonb` (`0019`) | Creator-only (a non-creator raises `not_creator`), idempotent once `ready` (returns `{ …, deduped: true }` with no second provider call). Validates the payload against the row's declared counts (a ready artifact always matches), enforces the per-user daily chat-token cap (100 000 — the same set `record_qa` sums; a breach flips the row to `failed` with `ai_quota_exceeded`), writes the `chat_tokens` (+ retrieval `embed_tokens`) ledger in the same transaction, then flips to `ready`. A malformed payload raises `validation` and leaves the row `generating` so `fail_artifact` (or a retry) decides its fate — a half-parsed artifact can never become ready. |
| `fail_artifact(p_artifact_id, p_error_code) → jsonb` (`0019`) | Creator-only, idempotent. The honest terminal state for `no_documents_indexed` / `ai_provider_failed` / `ai_quota_exceeded`; a second call on a `ready` or already-`failed` row returns `{ …, deduped: true }`. |
| `delete_artifact(p_artifact_id) → jsonb` (`0019`) | Creator-only; invisible (non-member or missing) is indistinguishable from missing (`not_found`), and a non-creator gets `not_creator`. Cascades `quiz_attempts` and `flashcard_reviews` via `ON DELETE CASCADE`. |
| `record_attempt(p_artifact_id, p_answers, p_duration_ms) → jsonb` (`0019`) | The only insert path into `quiz_attempts` (execute `authenticated` only): pins `user_id = auth.uid()`, re-checks membership and `status = 'ready'`, validates the answers array against the stored question count (an out-of-range index is `validation`), and scores server-side against `payload->questions` — the client's answer array is advisory input only, and a tampered score field in a body is ignored because it is never read. Returns `{ id, score, total, correct, results, duration_ms, created_at }`, where `results` carries each question's `chosen`, `correct_index`, `explanation` and `citations` from the payload. |
| `review_card(p_artifact_id, p_card_ordinal, p_grade) → jsonb` (`0019`) | The only write path into `flashcard_reviews` (execute `authenticated` only): pins `user_id = auth.uid()`, re-checks membership and `status = 'ready'`, validates the ordinal against the deck's card count and the grade against `again`/`got_it`, and computes the SM-2-lite schedule (`again` → streak 0, interval 0, next review +10 min, ease −0.2 floor 1.3; `got_it` → streak +1, interval 1/3/7/14/30 days by streak capped at 30, ease unchanged). Upserts on `(artifact_id, user_id, card_ordinal)` so grading again moves the schedule instead of stacking rows, and returns `{ next_review_at, interval_days, streak, due_count }` where `due_count` counts never-reviewed **or** overdue cards. |
| `create_plan(p_user_id, p_room_id, p_exam_date, p_hours_per_day, p_topics, p_document_ids, p_regenerate) → jsonb` (`0020`) | The only insert path into `study_plans` (execute `authenticated` only): pins `user_id = auth.uid()` (a `p_user_id` that differs raises `not_owner` — no route ever passes one), re-probes room membership (visible non-member → `room_not_member`, invisible → `not_found`), validates the exam window (+1..+180 days from `current_date`) and hours (1..12) and topics (≤25 × ≤60 chars, may be empty), checks every `document_ids` entry is accessible (room-shared in this room, or the caller's own personal file) and has a `ready` AI document, enforces the one-active/one-generating partial unique indexes (`23505` → `plan_already_active`; `regenerate: true` archives the active row first, in the same transaction), and adopts a pending `generating` row when one already exists (`deduped: true`). Returns `{ id, status, exam_date, deduped, href }`. |
| `generate_plan(p_plan_id, p_items, p_model, p_prompt_tokens, p_completion_tokens, p_retrieval_tokens) → jsonb` (`0020`) | Owner-only, idempotent. Re-validates the payload against the row's declared window (every `item_date` inside it, ≤180 items, ≤90 distinct dates, per-day total ≤ `floor(hours_per_day × 60) + 15`, kind ∈ `read`/`practice`/`review`/`mock`/`rest`, field ranges, and a `resource_id` that is not one of the pinned ids raises `plan_invalid`). Writes `plan_items` and the `ai_usage` ledger in the same transaction, then flips to `active`. A malformed payload raises `validation` and leaves the row `generating` — a half-parsed plan can never become active. |
| `fail_plan(p_plan_id, p_error_code) → jsonb` (`0020`) | Owner-only, idempotent. The honest terminal state for `ai_provider_failed` / `ai_quota_exceeded`. |
| `archive_plan(p_plan_id) → jsonb` (`0020`) | Owner-only, idempotent. Also cancels a pending `generating` row. |
| `mark_plan_item(p_item_id, p_done) → jsonb` (`0020`) | Owner-only (the item's plan's owner), idempotent; the first `done_at` timestamp is never rewritten. A foreign item id is `not_found`. Returns `{ item: { id, done_at }, plan: { id, status, progress } }`. |
| `complete_plan_day(p_plan_id, p_date) → jsonb` (`0020`) | Owner-only; marks every untouched item on `p_date` done in one transaction; idempotent. Returns `{ completed, progress }`. |
| `shift_plan(p_plan_id, p_from_date, p_updates) → jsonb` (`0020`) | Owner-only; the arithmetic lives in `lib/planner/shift.ts` (TypeScript) and this RPC re-validates every precomputed update inside the write: ownership, `status = 'active'`, `v_current >= p_from_date`, forward-only, `<= exam_date`, skips done items, `v_target = v_current` is a no-op. Returns `{ plan, moved, past_exam_date, skipped_done }`. |
| `plan_stats(p_plan_id) → jsonb` (`0020`) | Owner-only (a foreign id raises `not_found`); the detail route's authority: the plan row's view columns plus `item_count`, `days`, and the `progress` object built by `plan_progress`. |
| `plan_progress(p_plan_id) → jsonb` (`0020`) | Plain SQL helper — the progress formula (done/total, minutes planned/done overall and today), one definition, SQL authority. Execute revoked from `public`/`anon`/`authenticated`; called only by `plan_stats` and the write RPCs. |
| `analytics_me(p_user_id, p_days) → jsonb` (`0021`) | Personal aggregates (execute `authenticated` only, revoke-first): the subject is always `auth.uid()` (anon → `unauthenticated`, errcode `42501`), a foreign or null `p_user_id` silently behaves as self, and `p_days` ∉ 1–90 raises `validation`. Zero-filled UTC day rows over `[today − (p_days−1), today]`, the equal-length previous window for the strip's comparison, the `study_days` streak sources and the caller's window-scoped `plan` object. Returns `{ days, summary, study_days, plan }` — one round trip per panel. |
| `analytics_room(p_room_id, p_days) → jsonb` (`0021`) | Room aggregates with the authorization inside the database: the caller must own the room or hold a `room_moderators` row, else `not_found` — a plain member, an outsider and a missing room are indistinguishable. Returns counts and minutes only (`focus_minutes_total`, `active_members`, goals, quiz attempts, uploads and per-day rows); no `user_id` or alias can appear in the payload (asserted by a recursive key scan). |
| `list_public_rooms(p_q, p_subject, p_exam_track, p_language, p_min_members, p_sort, p_limit, p_cursor) → setof rooms` (`0022`) | Discovery page (execute `authenticated` only, revoke-first): hard-codes `visibility = 'public'`, clamps `p_limit` to 1–50 (default 20), derives `last_activity_at` as `greatest(max(focus_sessions.started_at), max(room_messages.created_at))` in the same query, and raises `22023` for `relevance` without a query. `p_cursor` is a `jsonb` keyset the data layer (`lib/rooms/discovery.ts`) has already validated against the sort. Returns the shaped public columns plus the aggregate `member_count` and the caller's own `viewer_membership` — never participant identities. |
| `room_preview(p_room_id) → jsonb` (`0022`) | Public-safe detail: a public room is visible to any session; a private room is visible only to its members; a private non-member room and a missing room both raise the same `P0002` (the route maps either to the identical `404`). Returns the shaped row plus `is_member` and `viewer_role` (owner → `"owner"`, student → `"member"`, null → `"none"`). |
| `room_filter_options() → jsonb` (`0022`) | The distinct non-null `subject`/`exam_track`/`language` values of public rooms only (≤ 100 each) — a private room's metadata never reaches a filter chip. |

## Community functions (`0025_communities_e2ee.sql`)

All eight are SECURITY DEFINER (`prosecdef = t`, `set search_path = public`),
execute revoked from `public`/`anon` and granted to `authenticated` only:

| Function | Effect |
| --- | --- |
| `create_community(p_name, p_slug, p_description, p_category, p_visibility, p_join_policy, p_rules)` | One transaction: the community row, the caller's `owner` membership row and the default `general` channel at position 0; pins `owner_id = auth.uid()`, floors `member_count` at 1, and maps the unique-slug race to the `slug_taken` refusal the route returns as `409`. |
| `join_community(p_community_id)` | Pins `auth.uid()`; missing community → not-found, banned → refused, already active/requested → idempotent `200`; a private or request-policy community files a `requested` row instead of activating; the open path inserts `active` and increments `member_count` in the same transaction. |
| `leave_community(p_community_id)` | No row → not-found; the owner → `owner_cannot_leave` (`409` on the route — transfer or delete first); otherwise deletes the caller's row and decrements `member_count` only when the row was `active` (floored at 1). This is the same RPC the self-`DELETE …/members/[userId]` path runs. |
| `set_community_member(p_community_id, p_user_id, p_role, p_status)` | Staff-only role/status changes with in-definer guards: `member_not_found` → `404`, `owner_protected` → `409` (the owner never changes), `not_owner` → `403` (only the owner appoints moderators), `not_staff` → `403` (the gate-vs-race defence). Approving `requested` bumps `member_count`; moving to `banned`/`requested` decrements it. Ban/kick also drop the API/RLS gates immediately — the epoch-advancing MLS `Remove` commit is left to a remaining member's next client sync. |
| `kick_community_member(p_community_id, p_user_id)` | Staff-only removal of somebody else (self-removal never reaches here — the route sends the caller's own `DELETE` to `leave_community` instead). Same `member_not_found`/`owner_protected`/`not_staff` guards, honest `member_count` decrement; no `DELETE` grant exists on `community_members`, so this function **is** the only removal path. |
| `community_roster(p_community_id, p_include_requested)` | Returns `(user_id, role, status, joined_at, alias)` — alias resolved with a `left join profiles` because `profiles` is SELECT-own and no FK path reaches it (the `room_roster` reasoning). Raises `42501` for non-members; `p_include_requested` is refused unless the caller is `owner`/`moderator` (so a direct call cannot out-run the route's `403`); ordered `joined_at asc`, `limit 500`. |
| `is_community_member(p_community_id)` / `is_community_staff(p_community_id)` | The two predicates RLS itself calls. SECURITY DEFINER so a policy asking "is the caller an active member?" does not recurse into `community_members`' own policies; they return boolean only (no data leaks), and every caller may already learn their own membership. `tests/integration/communities.test.ts` probes execute privilege and anon refusal for all eight. |

## Verification performed

All against the local stack. Structural:

```bash
npx supabase db lint --local        # exit 0: "No schema errors found"
npx supabase db reset               # exit 0: applied 0001 … 0025 (0014–0017 never existed)
npx supabase migration list --local # 0001 … 0025 present locally
```

Observed from `pg_catalog` / `information_schema` on 127.0.0.1:54322:

- RLS enabled on all thirty-two `public` tables (`relrowsecurity = t`),
  including the three `0019` quiz tables (`study_artifacts`, `quiz_attempts`,
  `flashcard_reviews`), the two `0020` plan tables (`study_plans`,
  `plan_items`) and the eight `0025` community tables (`communities`,
  `community_members`, `community_channels`, `community_messages`,
  `community_welcomes`, `community_devices`, `community_attachments`,
  `community_reports`). `0023` adds no table — only `profiles.language`.
- `profiles.language` (`0023`): nullable `text`, CHECKs `profiles_language_len`
  (1–40) and `profiles_language_trimmed`; column privileges
  `select`/`insert`/`update (language)` for `authenticated`, and `anon`
  holds nothing on `profiles` (the migration's `revoke all` re-asserts it).
- 55 table policies on `public.*`, every one `to authenticated`; the `0019`
  migration adds three select policies (`study_artifacts_select_member`,
  `quiz_attempts_select_own`, `flashcard_reviews_select_own`) and, like `0013`/
  `0018`, **no write policy anywhere**; `0025` adds twenty (four on
  `communities`, one on `community_members`, two each on `community_channels`,
  `community_messages`, `community_welcomes`, `community_reports`, three on
  `community_attachments`, four on `community_devices`). Plus the two `0006`
  policies on `realtime.messages` and the 7 storage policies on
  `storage.objects` (4 for `study-resources`, 3 for `community-attachments`) —
  0 policies for any role other than `authenticated` across all of them.
- 78 SECURITY DEFINER functions on `public`; the six `0019` RPCs
  (`create_artifact`, `complete_artifact`, `fail_artifact`, `delete_artifact`,
  `record_attempt`, `review_card`) are `prosecdef = t` with
  `search_path = ''` and execute revoked from `public`/`anon`. `0025`
  contributes eight more (`create_community`, `join_community`,
  `leave_community`, `set_community_member`, `kick_community_member`,
  `community_roster`, `is_community_member`, `is_community_staff`), each
  `prosecdef = t`, `search_path = public`, execute granted to `authenticated`
  only — probed in both directions by `tests/integration/communities.test.ts`
  with full identity argument lists.
- The five `0009` tables: zero table grants on `moderation_reports`,
  `moderation_actions` and `room_moderators` for every API role (verified:
  the only grants in `information_schema.role_table_grants` belong to
  `postgres`), `SELECT` only for `authenticated` on `room_mutes` and
  `user_blocks`, and no non-`authenticated` grant anywhere.
- FKs: `rooms.owner_id`/`room_members.user_id`/`profiles.id` → `auth.users`
  `ON DELETE CASCADE`; `room_members.room_id` → `rooms` `ON DELETE CASCADE`.
- Composite PK `(room_id, user_id)`, unique `profiles_alias_lower_key` on `lower(alias)`.
- `create_room`: `prosecdef = f`, `proconfig = {"search_path=\"\""}`.

Behavioral (29/29 HTTP checks against PostgREST with real local auth users, plus SQL):

| Requirement | Result |
| --- | --- |
| RPC succeeds for an authenticated user | `POST /rest/v1/rpc/create_room` → 200, `owner_id` = caller |
| Owner membership created with the room | 1 row, `role = owner`, `user_id` = caller |
| Membership insert failure rolls back the room | revoked `INSERT` on `room_members` → RPC failed, `rooms` left with 0 rows |
| Direct room INSERT cannot bypass the invariant | `400 / 23514` "…has no owner membership row"; 0 rows committed (API **and** SQL) |
| Owner impersonation impossible | `403 / 42501` "new row violates row-level security policy" |
| Private room visible to owner immediately | owner sees 1 row |
| Another authenticated user cannot read it | other user sees 0 rows, payload free of the id |
| Anonymous cannot read rooms or execute the RPC | `401 / 42501` "permission denied for table rooms" and "…for function create_room" |
| `UPDATE`/`DELETE` unavailable | all three denied (`403`) |
| Memberships private to the caller | own rows only, 0 foreign rows leaked |
| Profile column grants enforced | writing `created_at`/`id` → permission denied |
| Case-insensitive alias uniqueness | `caseprobe` after `CaseProbe` → `23505 profiles_alias_lower_key` |
| Input validation | capacity 0 / blank name / bad visibility → `400 / 22023` |

Membership (`0002_room_membership.sql`), verified against the local stack with real
auth users and covered end to end by `tests/integration/room-membership.test.ts`:

| Requirement | Result |
| --- | --- |
| Grants | `join_room`/`leave_room`/`public_room_member_counts`: anon `f`, authenticated `t`, `search_path = ""`, `prosecdef = t` for the two writes |
| Anonymous execute | all three → HTTP `401` with body `42501` |
| Join as the second student | `joined`, `member_count = 2` (owner counts as a seat) |
| Repeat join | `already_member`, row count unchanged, one row per member |
| Owner joining their own room | `already_member`, no second row |
| Private / missing room | both → `room_not_found`, byte-identical bodies (no existence leak) |
| Closed room | `room_closed`; an existing member still gets `already_member` |
| Capacity | capacity-1 room → `room_full`, count stays 1 |
| Leaving | `left` with the freed count, rejoin succeeds, repeat leave → `not_a_member` |
| Owner leaving | `owner_cannot_leave`, row still present |
| Five concurrent joins for three free seats | 3 `joined`, 2 `room_full`, final row count exactly 4 |
| Direct `INSERT` / `DELETE` on `room_members` | both denied (`42501`) — the grants did not move |
| Occupancy | `room_id` + `member_count` only, public rooms only, private room absent |

Focus sessions and goals (`0003_focus_sessions_and_goals.sql`), verified against the
local stack with a throwaway harness (99 checks: SQL grants/policies plus RPC calls
through real authenticated users) and covered end to end by
`tests/integration/focus-sessions.test.ts` and `tests/integration/study-goals.test.ts`:

| Requirement | Result |
| --- | --- |
| Grants | `focus_sessions`: anon `f`, `authenticated` SELECT only, `service_role` none (default ACL explicitly revoked first). `study_goals`: select/insert/delete + `UPDATE (title, target_seconds, target_count, status)` |
| RPC execution | all five: anon `f`, authenticated `t`, `search_path = ""`, `prosecdef = t`; `focus_room_check` and `expire_focus_sessions_for` not executable by any app role |
| Realtime | `focus_sessions` in `supabase_realtime`; `study_goals` not published |
| Authorization | non-member and missing room → identical `room_not_found`; student control → `not_owner`; member view → `ok` with their own `viewer_role` |
| Start / repeat start | `started` (201) then `already_active` (200), same row, one active row per room |
| Eight concurrent starts | 1 `started`, 7 `already_active`, exactly 1 row (partial unique index) |
| Pause / resume timing | `ends_at` unchanged by pause; resume credits the paused interval (`ends_at` moves forward, `paused_seconds` grows) |
| Early end | `completed` with `ended_at = now()`, history lists it newest-first |
| Expiry with no browser | backdated `ends_at` → next read or start persists `expired` with `ended_at = ends_at`; `pause` answers `no_active_session`; the stale row never blocks a new start |
| Direct writes | authenticated `INSERT`/`UPDATE` on `focus_sessions` → `42501` (SELECT-only grant); members can `SELECT`, non-members see 0 rows |
| Goals privacy | each caller reads only `user_id = auth.uid()` rows — even the room owner sees an empty list for someone else's goals |
| Goals ownership | another member's `PATCH`/`DELETE` → `404`, zero rows touched; forged `user_id` on insert → `42501`; insert into an unjoined room → `42501`; `user_id`/`room_id` updates → `42501` |
| Goals uniqueness | duplicate active title (case-insensitive) → `23505` → `409 duplicate_goal`; after completion the same title is accepted |
| Goals timestamps | completing sets `completed_at`, reopening clears it, direct writes cannot backdate either (`study_goals_touch` trigger) |
| Cleanup | harness leaves `profiles=0 rooms=0 sessions=0 goals=0 users=0` |

Study resources and the private bucket (`0005_study_resources.sql`), verified
against the local stack and covered end to end by
`tests/integration/study-resources.test.ts`:

| Requirement | Result |
| --- | --- |
| Bucket | `study-resources` exists with `public = false`, `file_size_limit = 20971520` and the five allowed MIME types; a plain `GET` on an object without a signature fails |
| `owner_id` privileges | **no** privilege of any verb for `authenticated` (`INSERT` is refused on privilege grounds before any policy runs; `SELECT` never carries it) |
| `storage_path` privileges | `SELECT` + `INSERT` for `authenticated`; excluded from `STUDY_RESOURCE_COLUMNS`, so no response carries it |
| Table privileges | `DELETE` is the only table-level grant; `SELECT`/`INSERT`/`UPDATE` are column-scoped; `anon` and `service_role` hold none |
| Policies | 4 on `study_resources` + 3 on `storage.objects`, all `to authenticated`, all keyed to `auth.uid()` and current `room_members` rows |
| Personal read isolation | owner sees 1 row, another authenticated student sees 0, anonymous listing is denied |
| Room sharing | members read and open it; a non-member gets the workspace's `404`; **leaving the room revokes it immediately** without moving a file |
| Cross-user writes | another student's `DELETE` → `404`, direct object write into someone else's `personal/{owner}/…` folder → denied, forged `owner_id` field → rejected by the API instead of ignored |
| Key layout | a hand-written row pointing outside `personal/{owner}/{id}{ext}` / `rooms/{room}/{owner}/{id}{ext}` fails `study_resources_storage_path_layout`; `(room_id is null) = (storage_path like 'personal/%')` is enforced separately |
| Upload validation | bytes that do not match the declared type/extension → `400 malformed_file`; the content type comes from sniffing, never from the browser |

Private room invitations and the roster (`0007_room_invitations.sql`), covered
end to end by `tests/integration/room-invitations.test.ts`:

| Requirement | Result |
| --- | --- |
| Grants | `room_invitations`: `authenticated` `SELECT` only, no write verb, `anon`/`service_role` none (default ACL revoked first); the five RPCs: anon `f`, authenticated `t`, `search_path = ""`, `prosecdef = t`; `join_room_core` not executable by any application role |
| Direct writes | authenticated `INSERT`/`UPDATE`/`DELETE` on `room_invitations` → `42501` (no grant) — every transition must be an RPC |
| Read scoping | invitee sees rows addressed to them, owner sees rows they created, a third user sees 0 rows; policy and grant freezes asserted by checksum |
| Addressing | create by alias → `invited`; unknown alias → `invitee_not_found`; self → `self_invite`; existing seat → `already_member`; a second pending row → `23505` → `already_invited`; public room → `room_public`; non-owner → `not_owner`, non-member → `room_not_found` (indistinguishable from missing) |
| Accept | `joined` with a `room_members` `student` row and the invitation consumed; repeat accept → `already_member` (invitation still consumed); not-your-row / missing → identical `not_found` |
| Rejection / revocation / expiry | `rejected` then re-accept → `409 rejected`; owner revoke → `409 revoked` on accept and `404` on a second revoke; backdated `expires_at` **and** `created_at` (the CHECK pairs them) → `410 expired` with the row untouched |
| Capacity on accept | last-seat accept succeeds, the next → `409 room_full`, seat count never exceeds `capacity` |
| Roster | members read alias/role/joined_at for the whole room (no user ids); non-member → `404`; `room_members` grants and policies byte-identical to before |
| `join_room` unchanged | signature, ACL and behaviour identical after the `CREATE OR REPLACE`; private non-member still `room_not_found` |

Member safety (`0009_moderation.sql`), covered end to end by
`tests/integration/room-moderation.test.ts` (25 tests):

| Requirement | Result |
| --- | --- |
| Anonymous refusal | report and block endpoints → `401 unauthenticated` with no row written anywhere |
| Strict bodies | unknown keys (incl. a smuggled `reporter_id`) and out-of-enum reasons → `400 validation`; the RPC re-checks both, so only the route can be bypassed, never the rule |
| Reporter privacy | response contains `id`/`status`/`created_at` only; `room_report_list` never returns `reporter_id`; `has_column_privilege(authenticated, 'moderation_reports', 'reporter_id', 'SELECT')` = `f`, and a direct PostgREST read of the table fails on the missing grant |
| Report addressing | self-report → `409 self_report`; a subject outside the caller's room → `404`/`invalid_subject` with no write; open duplicate → idempotent `200 { report, duplicate: true }` |
| Workflow | `pending → reviewing → resolved`, each transition returning `200` and leaving exactly one `moderation_actions` row stamped with the actor; invalid jumps → `409 invalid_transition`; non-member → `404`, plain member → `403 not_moderator` on the inbox list |
| Mute lifecycle | `201 { muted, muted_until }` + one `mute_applied` audit row; the muted target's API send → `403 muted` and their direct `room_messages` insert is refused by the `with check` policy (`42501`, zero rows written) while their reads keep working; repeat mute → `409 already_muted`; a second member's `room_mutes` read returns only their own row; unmute restores sending (`201`/`{ unmuted: true }`), repeat → `409 not_muted`; owner / moderator / self targets → `403 cannot_mute_owner` / `cannot_mute_moderator` / `cannot_mute_self` with zero rows touched |
| Moderator appointment | owner-only: a moderator's `POST` → `403 not_owner`, non-member → `404`; granting works immediately for the new moderator's inbox and roster actions; the owner as target → `403 cannot_moderate_owner`; revoke restores plain-member refusals in the same request cycle |
| Blocks | `201 { block, created: true }` then `200 created: false` on repeat; self → `409 self_block`; unknown alias → `404`; each caller's `GET` shows only their own rows; the blocker stops seeing the blocked user's messages — pre-block history via the API, the same rows via a direct PostgREST select, and new sends — while the blocked user and every other member still see them, and the blocked user keeps receiving the blocker's messages |
| Blocked invitations | invite → `409 blocked` on accept while the block stands, `201 joined` after unblock; the invitation stays pending in between |
| Member removal | moderator removes a member → `{ removed, member_count }` + one audit row; plain member → `403 not_moderator`, non-member → `404`, owner target → `403 cannot_remove_owner`, self → `403 cannot_remove_self`; the removed member loses roster, history reads, chat sends and presence (channel join refused), and their moderator grant and mute are swept with the membership |
| Cross-room isolation | reports, audit rows and moderator grants of room A never appear in room B's inbox; the same caller acting across rooms gets per-room results only |
| Grant / audit freezes | `moderation_reports`/`moderation_actions`/`room_moderators`: zero grants for `anon`/`authenticated`/`service_role` and zero policies; `room_mutes`/`user_blocks`: `SELECT` only with own-row policies; the eight-value action enum pinned by checksum; exactly one audit row per action |
| Control violation (rolled back) | widening a grant and dropping the policy **inside a transaction** lets a direct insert through, proving both layers are load-bearing — the transaction rolls back and the posture is re-verified `f` immediately after |

Rate limits, quotas and the sweep (`0010_resource_hardening.sql`), verified on
`npx supabase db reset` from scratch and covered end to end by
`tests/integration/resource-hardening.test.ts` (25 tests) and
`tests/e2e/resource-hardening.spec.ts` (5 tests):

| Requirement | Result |
| --- | --- |
| Grants | `rate_limits`: zero for `anon`/`authenticated`/`service_role`; `rate_limit_take` / `resource_quota_ok` / `resource_quota`: anon `f`, authenticated `t`, `search_path = ""`; `study_resources_quota_guard()`: executable by no API role |
| Anonymous execute | `set role anon; select rate_limit_take(...)` → `permission denied` |
| Atomic take | `p_max: 2` → `true, true, false` (count 3); backdating `window_start` restarts at 1; six simultaneous takes for `p_max: 2` land exactly two `true`; `p_max: 0` → `22023` |
| Two closed doors | with `select, insert` granted back inside the test: `select` returns **0 rows** (RLS, no policy) and `insert` is refused "row-level security"; after the revoke, both die on `42501` again |
| Quota trigger | direct `psql` insert sized to cross the limit → `P0001 quota_exceeded`, zero rows committed; two racing API uploads (one byte of headroom) → exactly one `201`, one `409`, one object, one row; deleting a row drops the sum immediately and the next upload succeeds |
| Quota display | `GET /api/resources` `quota` matches `sum(size_bytes)` read straight from the table, for both personal and room scope |
| Sweep | backdated object with no row → removed; fresh object → skipped (60 s grace); foreign user's objects untouched; broken row (object gone) → removed; a live row with its object → kept; non-member room sweep → `404` |
| Upload guards | 20 MiB + 1 byte → `413` with no object and no row; `.exe` → `415`, likewise nothing written; the same 20 MiB + 1 byte pushed **straight at storage** (no app route) → refused by the bucket's `file_size_limit` and nothing written |
| Serve review | the signed download URL carries `&download=<original name>` → the asset answers `200` with `Content-Disposition: attachment; filename="class notes.pdf"` and `Expires` exactly 300 s after `Date`; the listing payload contains neither the URL nor a `token=` |

## Notes and risks

- Disk is the binding constraint: the local images need several GB. If Docker or the
  image pulls fail, stop — never run `docker system prune` or any container-wide cleanup
  (an unrelated `opportunity-bot` stack shares this daemon and must be preserved).
- `auto_expose_new_tables = false` means future tables are invisible to the API until
  explicitly granted. That is intentional.
- `service_role` has no data privileges; no server-side code uses it.
- Room `status` and `capacity` are enforced by the join flow and edited only
  through the owner's settings page — `rooms` still has no `UPDATE`/`DELETE`
  grant, so both flow through the `update_room` / `delete_room` definer RPCs.
- Authenticated API behaviour is covered by `tests/integration/` (run it with
  `npm run test:integration`); the schema itself is proven by `db lint` and `db reset`.
- The `study-resources` bucket is created by `0005` and the
  `community-attachments` bucket by `0025`, so a reset provisions both;
  object access always goes through a short-lived signed URL issued after a
  fresh authorization check. The threat model behind all of this is written down in
  `docs/SECURITY.md`, and the endpoint contracts in `docs/API_CONTRACTS.md`
  (community chat is end-to-end encrypted — the MLS library `ts-mls` behind it
  has **not** had an independent security audit; see `docs/SECURITY.md` §Communities).
