-- SDYROOM 0006_realtime_private_channels: authorize the private presence channel.
-- Local-only target: `npx supabase db reset` / `npx supabase db push --local`.
-- 0001_init.sql … 0005_study_resources.sql are already applied and are never
-- edited: this file only adds.
--
-- Design
-- ------
-- Private channel authorization (what Supabase Realtime actually enforces)
--   * A join on a `private: true` channel is refused unless the Realtime
--     service proves, against `realtime.messages`, that the joining role may
--     read a row for that exact topic. The service runs that proof itself:
--     inside one transaction it sets `role`/`request.jwt.claims`/`realtime.topic`
--     from the socket's JWT, inserts a probe row for the topic (extensions
--     `broadcast` and `presence`), selects the probe ids back as the caller,
--     and rolls the transaction back (`ROLLBACK AND CHAIN`) — so the check
--     writes nothing that survives it. A presence `track` additionally runs
--     the same probe as a plain INSERT, which the insert policy must allow.
--   * `realtime.messages` ships with RLS enabled and **zero** policies, so a
--     private join is denied for every role until a policy grants it. Public
--     channels (`private: false`, the default used by the existing focus and
--     messages channels) are not policy-gated at all, which is why 0001–0005
--     never had to mention this table and remain untouched here.
--
-- Scope of the grant
--   * Topic must be `room-presence-<uuid>` — the one channel shape this
--     product opens as private — and the uuid is parsed out of the topic with
--     `substring(topic from '^room-presence-(.+)$')` and compared to
--     `room_id::text`: text against text, exactly the 0005 shape, so no
--     attacker-controlled topic is ever cast to uuid (no 22P02 error to use as
--     an existence oracle; a malformed topic simply matches nothing).
--   * The caller must hold a `room_members` row for that uuid *right now*.
--     The subquery runs as the caller, so `room_members`' own RLS
--     (`room_members_select_own`) applies too — membership is checked twice,
--     by policy shape and by the table it reads.
--   * `extension in ('broadcast', 'presence')`: the only two values the join
--     and track probes use. Rows persisted by a future broadcast-persistence
--     setting (`persistence` extension) stay outside this grant.
--   * `private` is deliberately **not** referenced. Probe rows are written
--     with the column default (`false`) — realtime's changeset sets only
--     `topic` and `extension` — so a policy requiring `private is true`
--     would deny everyone, members included.
--   * Roles: `to authenticated` only. `anon` gets no policy, so an anonymous
--     socket is refused the same way a non-member is; the policy list itself
--     reveals nothing, because both failures answer identically.
--
-- What this does not do
--   * No table, no grant, no publication change: presence state lives in the
--     Realtime service's memory and disappears with the socket. The
--     `supabase_realtime` publication stays `focus_sessions` + `room_messages`.
--   * The policy is topic-scoped, so it can never authorize the focus or
--     messages channels, and a member of room A cannot open room B's topic —
--     proven by `tests/integration/presence-policies.test.ts`.
--
-- Why the wait loop
--   * `npx supabase db reset` recreates the database, which drops realtime's
--     own schema with it; the running service reconnects and re-creates
--     `realtime.messages` on its own (no client connection is needed for
--     that, it is part of the service's tenant bootstrap). This migration may
--     otherwise race that recreation, so it waits — bounded — instead of
--     failing a fresh stack, and then writes the policies. The drop/create
--     pair keeps a second `db reset` idempotent, since realtime's schema
--     survives untouched when the service has already re-created it.

-- ---------------------------------------------------------------------------
-- Policies on realtime.messages (the private-channel gate)
-- ---------------------------------------------------------------------------
do $$
declare
  attempts integer := 0;
begin
  while to_regclass('realtime.messages') is null and attempts < 60 loop
    perform pg_sleep(1);
    attempts := attempts + 1;
  end loop;

  if to_regclass('realtime.messages') is null then
    raise exception
      'realtime.messages still absent after %s: the realtime service did not recreate its schema',
      attempts;
  end if;

  execute 'drop policy if exists room_presence_select_member on realtime.messages';
  execute 'drop policy if exists room_presence_insert_member on realtime.messages';

  execute $policy$
    create policy room_presence_select_member on realtime.messages
      for select to authenticated
      using (
        topic like 'room-presence-%'
        and extension in ('broadcast', 'presence')
        and exists (
          select 1
          from public.room_members m
          where m.room_id::text = substring(topic from '^room-presence-(.+)$')
            and m.user_id = auth.uid()
        )
      )
  $policy$;

  execute $policy$
    create policy room_presence_insert_member on realtime.messages
      for insert to authenticated
      with check (
        topic like 'room-presence-%'
        and extension in ('broadcast', 'presence')
        and exists (
          select 1
          from public.room_members m
          where m.room_id::text = substring(topic from '^room-presence-(.+)$')
            and m.user_id = auth.uid()
        )
      )
  $policy$;
end $$;
