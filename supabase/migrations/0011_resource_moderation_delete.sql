-- 0011_resource_moderation_delete.sql
-- Allow room owners/moderators to remove shared resources safely.
--
-- 0001-0010 are intentionally untouched.
--
-- Design:
--   * Personal resources remain uploader-only.
--   * A room owner or appointed room moderator may remove a shared resource.
--   * Authorization is re-checked inside a SECURITY DEFINER RPC.
--   * The metadata delete and moderation audit entry happen in one transaction.
--   * Storage remains private. Its DELETE policy is widened only for the same
--     room-scoped owner/moderator decision.
--   * API deletion still removes the Storage object first, then the metadata
--     row + audit entry. Storage deletion is idempotent, so retries converge.

-- ---------------------------------------------------------------------------
-- Moderation audit action
-- ---------------------------------------------------------------------------

alter table public.moderation_actions
  drop constraint if exists moderation_actions_action_check;

alter table public.moderation_actions
  add constraint moderation_actions_action_check
  check (action in (
    'member_removed',
    'mute_applied',
    'mute_lifted',
    'moderator_appointed',
    'moderator_revoked',
    'report_reviewed',
    'report_resolved',
    'report_dismissed',
    'resource_removed'
  ));

-- ---------------------------------------------------------------------------
-- Moderator/owner resource deletion
-- ---------------------------------------------------------------------------

create or replace function public.delete_moderated_resource(
  p_resource_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_resource public.study_resources;
  v_role text;
begin
  if v_user_id is null then
    raise exception 'delete_moderated_resource requires an authenticated user'
      using errcode = '42501';
  end if;

  if p_resource_id is null then
    return jsonb_build_object('code', 'not_found');
  end if;

  -- Lock the metadata row so the authorization decision and deletion happen
  -- against one stable resource record.
  select *
    into v_resource
    from public.study_resources
   where id = p_resource_id
     and room_id is not null
   for update;

  -- Personal resources are deliberately excluded. Their uploader-only
  -- DELETE path remains the existing rule from 0005.
  if not found then
    return jsonb_build_object('code', 'not_found');
  end if;

  -- Reuse PR 09's single room-scoped authorization helper. Never trust a
  -- role supplied by the API request.
  v_role := public.moderation_actor_role(v_resource.room_id);

  if v_role not in ('owner', 'moderator') then
    -- Same answer as a missing resource so a resource id is never an
    -- authorization oracle.
    return jsonb_build_object('code', 'not_found');
  end if;

  delete from public.study_resources
   where id = v_resource.id;

  if not found then
    return jsonb_build_object('code', 'not_found');
  end if;

  -- The resource owner is recorded as the subject; the authenticated caller
  -- is always the actor. The ids never cross the API boundary.
  insert into public.moderation_actions (
    room_id,
    actor_id,
    action,
    subject_user_id,
    subject_ref,
    reason
  )
  values (
    v_resource.room_id,
    v_user_id,
    'resource_removed',
    v_resource.owner_id,
    v_resource.id::text,
    'shared resource removed by room moderation'
  );

  return jsonb_build_object(
    'code', 'deleted',
    'id', v_resource.id
  );
end;
$$;

revoke execute on function public.delete_moderated_resource(uuid)
  from public, anon;

grant execute on function public.delete_moderated_resource(uuid)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Storage DELETE policy
-- ---------------------------------------------------------------------------
--
-- Personal objects remain uploader-only.
--
-- Room objects may also be deleted by the room owner or an appointed
-- moderator. The room id is taken from the object key and fed into the same
-- SECURITY DEFINER authorization helper used by the metadata RPC.
--
-- The UUID regex is intentionally checked before the cast so a malformed
-- Storage path cannot turn into a database cast-error oracle.


drop policy if exists "study_resources_objects_delete" on storage.objects;

create policy "study_resources_objects_delete"
  on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'study-resources'
    and (
      -- Personal resource: uploader only.
      (
        array_length(storage.foldername(name), 1) = 2
        and (storage.foldername(name))[1] = 'personal'
        and (storage.foldername(name))[2] = auth.uid()::text
        and owner = auth.uid()
      )

      or

      -- Shared resource: uploader, room owner, or moderator.
      (
        array_length(storage.foldername(name), 1) = 3
        and (storage.foldername(name))[1] = 'rooms'
        and (storage.foldername(name))[2] ~
          '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        and (storage.foldername(name))[3] ~
          '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        and (
          owner = auth.uid()
          or public.moderation_actor_role(
            (storage.foldername(name))[2]::uuid
          ) in ('owner', 'moderator')
        )
      )
    )
  );
