-- ---------------------------------------------------------------------------
-- Notification retention scheduler (pg_cron).
--
-- `prune_notifications(before)` (0012) is granted to `service_role` only, so
-- nothing in the request path can run it; retention needs a scheduler. The
-- smallest secure option is pg_cron inside the database itself: no new
-- secret, no workflow holding a service-role key, and no application surface.
--
-- Execution identity: the job runs as the role that schedules it (the role
-- applying this migration — `postgres` locally and on hosted Supabase), which
-- also owns the SECURITY DEFINER function, so it can execute it as function
-- owner. No grant is widened here; the revoke-first grants of 0012 stand.
--
-- Cutoff matches the documented runbook: rows older than 90 days. Daily at
-- 03:17 UTC — off-peak, and off the :00 mark so it never joins a
-- thundering herd.
--
-- Verify after applying (locally or in production):
--   select jobname, schedule, active, username, command from cron.job
--     where jobname = 'prune_notifications';
-- -- one row, '17 3 * * *', active, postgres, and the 90-day cutoff above.
-- Production scheduling is pending until this migration is applied there and
-- that query returns the row.
-- ---------------------------------------------------------------------------

create extension if not exists pg_cron;

select cron.schedule(
  'prune_notifications',
  '17 3 * * *',
  $$select public.prune_notifications(now() - interval '90 days');$$
);
