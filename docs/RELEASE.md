# Release runbook

Launch checklist, pre-deployment gates, environment matrix, rollback and
recovery procedures, known limitations, evidence tiers, and backup/restore
drills for SdyRoom. Everything here assumes the deploy target is Vercel +
Supabase hosted; the local stack (`docs/local-supabase.md`) is for development
and CI only. Platform configuration is **not codified in this repository**
(there is no `vercel.json`, Dockerfile or deploy workflow) — record the
project settings used for the first production deploy in the evidence table
below rather than assuming they are in git.

## Pre-deployment gates

Every command in this table must be green on the release SHA before a
release is cut. CI (`.github/workflows/ci.yml`) runs the same gates on every
push and pull request, but branch protection is **not enabled** on `main`, so
a green run has to be confirmed rather than assumed (checklist item 1).
Command semantics live in `AGENTS.md`; the integration and e2e gates need the
local Supabase stack (`npx supabase start`, `npx supabase db reset`,
`.env.local` per `docs/DEVELOPMENT.md`).

| Gate | Command | Tier |
| --- | --- | --- |
| Lint (zero errors, zero warnings) | `npm run lint` | local + CI |
| Types | `npx tsc --noEmit` | local + CI |
| Unit tests + coverage floors | `npm test`, `npm run test:coverage` | local + CI |
| Integration tests (real stack) | `npm run test:integration` | local + CI |
| Browser e2e | `npm run test:e2e` | local + CI |
| Production build | `npm run build` | local + CI |
| Env, counts and link consistency | `npm run check:env`, `npm run check:counts`, `npm run check:links` | local + CI |
| HTTP smoke + load sanity | `npm run smoke`, `npm run load:sanity` | local, against the build being released |

## Launch checklist

Work top to bottom; each item names the command or evidence that proves it.

1. **Gates green.** Every command in the table above passes locally, and the
   CI run for the release SHA is green — open the run and confirm all three
   jobs (quality, integration, e2e), not just the workflow's overall icon.
2. **Environment matrix complete.** Every production-required key in the
   matrix below is set in the production project (Vercel → Settings →
   Environment Variables), and `npm run check:env` passes in CI (the
   `quality` job runs it on every push).
3. **Migrations applied.** All files in `supabase/migrations/` applied in
   order via `supabase db push` (or the hosted SQL editor). The sequence is
   `0001`–`0013` and `0018`–`0024` — **20 files**; `0014`–`0017` never
   existed and are not pending. Verify:
   `select count(*) from supabase_migrations.schema_migrations;` equals the
   number of files in `supabase/migrations/` (20 at time of writing).
4. **Health endpoints answer.** After the first production deploy:
   - `GET /api/health` → `200 { status: "ok", version, uptime_s }` — liveness,
     no dependency contact.
   - `GET /api/health/ready` → `200 { status: "ok", checks: { db: "ok",
     storage: "ok" } }` — readiness against the hosted project.
   - `GET /api/metrics` → `200` with `window_s: 300`, `instance: "single"`.
5. **Smoke run against production.** `npm run smoke` with
   `SMOKE_BASE_URL=https://<your-domain>` — all five checks green.
6. **Load sanity.** `npm run load:sanity` with `LOAD_BASE_URL` set; record
   the p50/p95/p99 table in the PR or release notes. This is a smoke-level
   signal on one machine, not a capacity study — say so wherever you paste it.
7. **Backup + restore drill executed and dated.** See the drill section
   below. An undated drill is not a drill.
8. **Retention scheduled.** Migration `0024` installs pg_cron and books the
   daily 03:17 UTC job that calls `prune_notifications(before)` with the
   90-day cutoff. After the migrations are applied to production, verify:
   `select jobname, schedule, active, username, command from cron.job where
   jobname = 'prune_notifications';` must return exactly one active row
   (`'17 3 * * *'`, `postgres`, the 90-day command). Record the retention
   window in the release notes and re-check the row after any database
   restore.
9. **Error correlation verified in production logs.** Trigger one deliberate
   error (e.g. `POST /api/rooms` with an invalid body while unauthenticated);
   confirm the response's `request_id` appears in the platform log stream on
   the matching line, and that no `authorization`/`cookie` value is present
   in any captured line.
10. **Rollback rehearsed.** Read the Rollback section and confirm the
    platform's rollback control is reachable before you need it — there is
    no migration-down path to rehearse (see Rollback).

## Environment matrix

Authoritative list: `.env.example`. `npm run check:env` fails the build on
drift between the codebase's `process.env` reads and this file.

| Key | Required in production | Notes |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | yes | Hosted project URL (https). |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | yes | `sb_publishable_*` / legacy anon key — never a secret key. |
| `AI_PROVIDER` | no (defaults to `auto`) | `auto`, `openai` or `mock`. `auto` resolves to `openai` when `AI_API_KEY` is set and `mock` when it is not; an unknown value is logged (name only) and treated as `auto`. Set `mock` only for tests/demos. |
| `AI_API_KEY` | yes (AI features) | Server-side only; never exposed to the browser. A configured provider that fails surfaces `502 ai_provider_failed` — there is no silent fallback to mock. |
| `AI_BASE_URL` | no | Override for proxies/self-hosted providers. |
| `AI_MAX_INGEST_BYTES` | no | Defaults in code (20 MiB, clamped to the upload ceiling); set to cap ingest size. |
| `AI_EMBED_MODEL` / `AI_CHAT_MODEL` | no | Dynamic — read via `process.env[name]`; defaults `text-embedding-3-small` / `gpt-4o-mini`. |
| `VERCEL_URL` | platform | Set by Vercel automatically; used for absolute URL construction. |

Secrets belong in the platform's secret store, never in `.env` files committed
to the repository.

## Build, start and smoke

The release candidate is the production build, not the dev server:

```sh
npm ci
npm run build          # Next.js production build (also run by CI)
npm run start          # serves the built app on :3000
```

With the server running, from another shell:

```sh
npm run smoke          # 5 checks: health, ready, metrics, request-id envelope
npm run load:sanity    # 400 requests at concurrency 25 by default
```

Both scripts accept `SMOKE_BASE_URL` / `LOAD_BASE_URL` to aim at a deployed
URL. `/api/health` must answer without dependencies; `/api/health/ready`
answers `200` only while the database and storage reachable from the server
are healthy.

## Rollback

**Decision criteria — any one is enough to roll back first and diagnose
afterwards:**

- `/api/health` failing, or `/api/health/ready` degraded after a deploy;
- the smoke checks fail against production post-deploy;
- error-rate spike in the platform logs, or `request_id` correlation shows a
  regression in auth, data access or the error envelope;
- a confirmed security incident (then also rotate keys in the secret store).

**Procedure:**

1. **Code/config:** platform rollback (Vercel → Deployments → previous
   working deployment → promote). Seconds; does not touch the database.
2. **Schema:** there are **no down migrations** in this repository. Schema
   problems are fixed **forward** with a new migration — never edit a merged
   one (migration rules in `AGENTS.md`).
3. **Data:** restore from the hosted backup / point-in-time recovery using
   the drill procedure below. Storage objects are not part of `pg_dump`
   (see Known limitations).
4. **Record:** incident time, trigger, rollback SHA and the `request_id`
   evidence next to the drill log.

## Recovery and incidents

- **Diagnose first:** every error response carries a `request_id`; grep the
  platform log stream for it. `/api/metrics` gives the aggregate 5-minute
  window; `/api/health/ready` reports per-dependency status (`db`,
  `storage`).
- **Log hygiene is a release gate:** captured lines must never contain
  `authorization` or `cookie` values (proven by checklist item 9's
  deliberate-error drill; logging rules in `docs/SECURITY.md`).
- **Data loss or corruption:** take a fresh hosted backup *before* further
  changes, then run the restore drill below against it (PITR window as
  configured on the hosted project).
- **Suspected compromise:** rotate keys in the platform secret store, roll
  back the code, and follow `docs/SECURITY.md` before re-launching.

## Known limitations

| Limitation | Impact | Disposition |
| --- | --- | --- |
| Chat has no history reconciliation on (re)subscribe. A message committed between the server-rendered history read and the realtime subscription (page load, reload, or a reconnect after the socket drops) is not shown until the viewer reloads again; there is deliberately no chat poll, and the badge honestly reports "Reconnecting…" while offline. | A viewer can silently miss a chat message sent during their own reload or an outage window. | Documented (found by the 2026-10-19 release-readiness audit; the e2e moderation test now waits for the send to be server-confirmed before reloading). Proposed follow-up: reconcile once per (re)subscribe via the existing `GET /api/rooms/[id]/messages`. |
| `prune_notifications(before)` is scheduled by pg_cron (migration `0024`), but only a verified `cron.job` row proves the schedule applied in that environment. | Notification rows grow without bound wherever the migration has not been applied or the job was removed (e.g. a restore without the migration history). | Local: verified by reset + integration probe (2026-10-19). Production: checklist item 8 — verify after every deploy and restore. |
| Storage objects (uploaded PDFs) live in the storage service, not in `pg_dump`. | A database restore does not restore uploaded files. | Rely on hosted object replication; noted so it is not discovered during an incident. |
| Platform configuration is not codified (no `vercel.json`/container). | First deploy settings live outside git. | Record them in the evidence table at first deploy. |
| Branch protection is not enabled on `main`. | Required checks are advisory; a PR can merge red. | Enable with authorization before/at launch; until then, checklist item 1 confirms runs manually. |
| No down migrations. | Schema rollback is forward-fix only. | By design — see Rollback. |
| `supabase/seed.sql` is intentionally empty. | No demo/seed data ships with the repo. | By design — no seed data can leak into a production database. |
| `npm run smoke` / `npm run load:sanity` are smoke-level, single-machine checks. | They prove the deploy answers correctly, not that it scales. | Pair with platform metrics after launch. |

## Evidence tiers

Claims about a release must name the tier they were observed at — local and
CI evidence never substitutes for production evidence.

| Tier | What proves it | Status (2026-10-19) |
| --- | --- | --- |
| **Local** (this machine, audit branch) | The full pre-deployment gates table | Green: lint, `tsc`, `check:env` (8 keys), `check:links` (32 files), unit 1614/1614 with coverage 75.6% statements / 66.0% branches (floors 74/64), integration 430/430 against a fresh `db reset` (19 migrations), e2e 81/81, `build`, smoke 5/5, load-sanity 400/400 (p50 13 ms, p95 45 ms), restore drill **pass** (see log below). |
| **CI** (GitHub Actions, `main`) | Workflow runs on the exact SHA | Green: run `39221176205` on merge commit `70fb971`; earlier `39216646842` (`bde09d1`) and `39214385915` (`facc1b4`). |
| **Production** (hosted URL) | Checklist items 4–6 and 9 against the live domain; hosted backup drill | **Pending — nothing is deployed yet.** No production URL, dashboard or log stream exists to evidence. |

## Backup and restore drill

Run the drill **before** launch and repeat it quarterly. Record the date, the
operator and the measured restore duration in the table at the bottom.

### Take a backup (local stack)

```sh
# Full logical dump of the local database (includes storage schema metadata).
docker exec -e PGPASSWORD=postgres supabase_db_sdyroom \
  pg_dump -U postgres -d postgres -Fc \
  -f /tmp/sdyroom-$(date +%Y%m%d).dump

docker cp supabase_db_sdyroom:/tmp/sdyroom-$(date +%Y%m%d).dump ./sdyroom.dump
```

For hosted projects: use the Supabase dashboard's scheduled backups, and take
an on-demand backup before every migration that touches data.

### Restore into a scratch database and verify

A bare `postgres` image is **not** enough: the dump references the Supabase
roles (`anon`, `authenticated`, `service_role`, …) in grants and policies, and
`document_chunks.embedding` needs pgvector. Use the pgvector image with the
same major version as the source, and pre-create the roles:

```sh
# Same major version as the local stack (17.x) with pgvector built in.
docker run -d --name sdyroom-restore-drill -e POSTGRES_PASSWORD=postgres \
  -p 55432:5432 pgvector/pgvector:pg17

# Wait for readiness, then create the roles the dump grants to.
for i in $(seq 1 30); do docker exec sdyroom-restore-drill pg_isready -U postgres && break; sleep 1; done
docker exec -e PGPASSWORD=postgres sdyroom-restore-drill psql -U postgres -d postgres -c \
  "do \$\$ declare r text; begin foreach r in array array['anon','authenticated','service_role','supabase_admin','supabase_auth_admin','supabase_storage_admin','supabase_functions_admin','supabase_realtime_admin','dashboard_user','pgbouncer','pgsodium_keyholder','pgsodium_keyuser'] loop begin execute format('create role %I nologin', r); exception when duplicate_object then null; end; end loop; end \$\$;"

docker exec -i sdyroom-restore-drill pg_restore -U postgres -d postgres < sdyroom.dump
```

`pg_restore` exits non-zero with a small number of errors that are expected
in a scratch container and do not affect the application's schema or data:
grants to the `vault` schema (the `supabase_vault` extension is not
installed) and `ALTER … OWNER TO` on platform event triggers. Anything else
is a drill failure.

Spot-checks — each must equal the source:

```sh
docker exec -e PGPASSWORD=postgres sdyroom-restore-drill psql -U postgres -d postgres -tAc \
  "select (select count(*) from supabase_migrations.schema_migrations),
          (select count(*) from pg_policies where schemaname='public'),
          (select count(*) from information_schema.tables where table_schema='public'),
          (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public');"
```

Storage *objects* (uploaded PDFs) live in the storage service, not
`pg_dump`; for hosted projects rely on Supabase's object replication, and
note that limitation rather than discovering it during an incident.

Tear down the scratch instance when done — the live stack is untouched:

```sh
docker rm -f sdyroom-restore-drill
```

### Drill log

| Date | Operator | Backup source | Restore target | Duration | Result |
| --- | --- | --- | --- | --- | --- |
| 2026-10-18 | Dev B (local stack, post db-reset) | `pg_dump -Fc` of `supabase_db_sdyroom` (18 migrations) | `pgvector/pgvector:pg17` scratch on port 55432 | ~2 min (incl. image pull) | **pass** — migrations 18/18, public policies 35/35, public tables 24/24, public functions 79/79, row counts equal; 14 ignorable platform errors (vault/event-trigger owners) |
| 2026-10-19 | Release-readiness audit (agent session) | `pg_dump -Fc` of `supabase_db_sdyroom` (19 migrations, post e2e cleanup) | `pgvector/pgvector:pg17` scratch on port 55432 (image cached) | ~1 min | **pass** — migrations 19/19, public policies 35/35, public tables 24/24, public functions 79/79, row counts equal (core tables empty after e2e user cleanup); 14 ignorable platform errors (vault ×8, event-trigger owners ×6); scratch torn down, live stack untouched |

## Retention: notifications

`prune_notifications(p_before) → integer` (migration `0012`) deletes each
caller's notifications older than the given timestamp. It is SECURITY
DEFINER and granted to `service_role` only — no application request can
invoke it. The scheduler is pg_cron: migration `0024` installs the extension
and books job `prune_notifications`, daily at 03:17 UTC with the 90-day
cutoff, executing as the role that applied the migration (which owns the
function). Inspect and confirm:

```sh
# The scheduled job (one active row).
docker exec -e PGPASSWORD=postgres supabase_db_sdyroom \
  psql -U postgres -d postgres -c \
  "select jobname, schedule, active, username, command from cron.job
     where jobname = 'prune_notifications';"

# Recent runs (pg_cron keeps a bounded history).
docker exec -e PGPASSWORD=postgres supabase_db_sdyroom \
  psql -U postgres -d postgres -c \
  "select status, return_message, start_time from cron.job_run_details
     order by start_time desc limit 5;"

# Manual run (ad-hoc or backfill), as superuser.
docker exec -e PGPASSWORD=postgres supabase_db_sdyroom \
  psql -U postgres -d postgres -c \
  "select public.prune_notifications(now() - interval '90 days');"
```

On hosted Supabase the same migration books the same job when the migrations
are pushed; checklist item 8 is the production verification. Pick and record
a retention window (90 days is the default suggestion), and revisit it when
users ask "where did my old notifications go?".

## Smoke and load scripts

| Command | Purpose |
| --- | --- |
| `npm run check:env` | Static check: every `process.env` read in `lib/` and `app/` is covered by `.env.example`. Runs in CI. |
| `npm run smoke` | Five HTTP checks against a running server: `/api/health`, `/api/health/ready`, `/api/metrics`, error-envelope `request_id` echo, malformed `x-request-id` replacement. Set `SMOKE_BASE_URL` (default `http://127.0.0.1:3000`). |
| `npm run load:sanity` | Single-process load smoke: configurable `LOAD_TOTAL` (default 400) requests at `LOAD_CONCURRENCY` (default 25); prints p50/p95/p99 and fails if any unexpected status appears or success rate is below 99%. Set `LOAD_BASE_URL`. |

Both HTTP scripts are smoke-level: they prove the deploy answers correctly,
not that it scales. Pair them with the platform's own metrics after launch.
