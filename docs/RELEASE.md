# Release runbook

Launch checklist, pre-deployment gates, environment matrix, hosting selection,
rollback and recovery procedures, known limitations, evidence tiers, and
backup/restore drills for SdyRoom. Everything here assumes the deploy target is
Vercel + Supabase hosted — that is a **working assumption, not a decision
recorded in this repository** (see "Hosting selection"): the local stack
(`docs/local-supabase.md`) is for development and CI only. Platform
configuration is **not codified in this repository** (there is no `vercel.json`,
Dockerfile or deploy workflow) — record the project settings used for the first
production deploy in the evidence table below rather than assuming they are in
git. The operator runbook for a private staging environment (Vercel preview +
dedicated Supabase project, verification matrix, `cron.job` check) lives in
`docs/STAGING.md`.

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
   Branch protection is not enabled yet; the proposed policy (below,
   "Branch protection") would make this check enforced rather than
   ceremonial — enable it with owner approval before launch.
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
| `LIVEKIT_URL` | no (live meetings off) | LiveKit server endpoint, `ws://` or `wss://`. Server-side only (never `NEXT_PUBLIC_*`); a partial or non-websocket value counts as unconfigured, logged by variable name only. Without all three keys the Meeting view is disabled with an explanation and `POST /api/rooms/[id]/meeting/token` answers `503 meeting_unavailable`. |
| `LIVEKIT_API_KEY` | no (live meetings off) | Token-signing issuer. Server-side only. |
| `LIVEKIT_API_SECRET` | no (live meetings off) | Token-signing secret. Server-side only; never logged, never serialised, never sent to the browser. |
| `VERCEL_URL` | platform | Set by Vercel automatically; used for absolute URL construction. |

Secrets belong in the platform's secret store, never in `.env` files committed
to the repository.

## Hosting selection

**No hosting decision is recorded in this repository.** Evidence, checked
2026-10-19: no `vercel.json`, `netlify.toml`, Dockerfile, `fly.toml,
`render.yaml` or deploy workflow exists; no hosting provider appears in
`package.json`; the README states there is no live public deployment; the
`VERCEL_URL` environment key is a platform convenience, not a choice. The
Vercel + Supabase-hosted assumption this runbook carries is inherited from the
original project brief and has never been exercised.

| Option | Fit | Cost of choosing it |
| --- | --- | --- |
| **Vercel (or comparable Next PaaS) + Supabase hosted** — the working assumption | Zero-config Next 16 builds; the environment matrix and `VERCEL_URL` key are already Vercel-shaped; Supabase is the data layer the app is written against | Record the project settings at first deploy (below); no repo changes required to start |
| **Self-container (Fly/Railway/ECS)** | Full control over the Node runtime and regions | A Dockerfile and deploy workflow must be written and owned; more moving parts before first launch |
| **VPS + process manager** | Cheapest steady-state, simplest mental model | Everything operational — TLS, restarts, log rotation — is manual |

**Recommendation:** stay with the working assumption (a Next-compatible PaaS +
Supabase hosted) until there is a concrete reason not to; it is the smallest
path to a first production evidence row. Nothing here deploys anything: no
platform account was contacted, no paid resource was created, and the decision
remains the owner's. When it is made, capture in the evidence table: provider
and region, Node version (`.nvmrc`), build command (`npm run build`), start
behaviour (`npm run start` or the platform's Next runtime), the environment
matrix keys actually set, and where previews/rollbacks live.

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

**Known recovery gaps** (checked 2026-10-19 — state them before an incident,
not during one):

- **Point-in-time recovery is unconfigured.** No hosted project exists yet, so
  no PITR window has been chosen, paid for or exercised. Until one is, the
  only restore points are the hosted plan's scheduled backups and any manual
  take-an-on-demand backup before a risky migration (drill section below).
  Record the plan's backup cadence and PITR window in the evidence table when
  the hosting decision lands.
- **Storage objects are not in `pg_dump`.** Uploaded PDFs live in the storage
  service; a database restore brings back buckets, policies and metadata but
  zero files. Recovery is re-upload (and re-ingest for AI features) — there is
  no automated object-restore path in this repository, and relying on hosted
  object replication is a bet, not a procedure.
- **Platform configuration lives only in the provider console.** Domain, env
  matrix keys, plan tier and log retention exist nowhere in git; restoring
  into a fresh project means rebuilding them by hand from this runbook.
- **A database restore must re-verify scheduled jobs.** The pg_cron retention
  job (migration `0024`, once merged) is database state: after any restore,
  re-check the `cron.job` row per checklist item 8 — a dump taken before the
  migration, or a restore path that skipped the `cron` schema, silently
  returns the system to unbounded notification growth.

## Known limitations

| Limitation | Impact | Disposition |
| --- | --- | --- |
| Chat history reconciliation now runs once per realtime (re)subscribe: the join ack triggers a catch-up read of `GET /api/rooms/[id]/messages` (newest page first, `before=` cursor until known rows, ≤ 10 pages) that merges additively into the rendered history, closing the reload race and the reconnect gap the 2026-10-19 audit found. There is deliberately still no chat poll. | A gap larger than 10×50 rows (500 messages committed while away) waits for the next reload; the badge still reports "Reconnecting…" while offline. | Fixed with regression coverage: pure merge unit tests, component tests (load gap, reconnect gap, dedupe, ordering, cursor walk, room-switch discard, auth/offline paths), an integration catch-up contract, and an e2e that kills the socket and expects the missed message after reconnect with no reload (red without the fix, green with it). |
| `prune_notifications(before)` is scheduled by pg_cron (migration `0024`), but only a verified `cron.job` row proves the schedule applied in that environment. | Notification rows grow without bound wherever the migration has not been applied or the job was removed (e.g. a restore without the migration history). | Local: verified by reset + integration probe (2026-10-19). Production: checklist item 8 — verify after every deploy and restore. |
| Storage objects (uploaded PDFs) live in the storage service, not in `pg_dump`. | A database restore does not restore uploaded files. | Rely on hosted object replication; noted so it is not discovered during an incident. |
| Platform configuration is not codified (no `vercel.json`/container), and no hosting decision is recorded in the repo. | First deploy settings live outside git; the deploy target is an inherited assumption. | Decision framing and the settings to capture: "Hosting selection" above. Record the outcome in the evidence table at first deploy. |
| Branch protection is not enabled on `main`. | Required checks are advisory; a PR can merge red. | Enable with authorization before/at launch; until then, checklist item 1 confirms runs manually. |
| No down migrations. | Schema rollback is forward-fix only. | By design — see Rollback. |
| `supabase/seed.sql` is intentionally empty. | No demo/seed data ships with the repo. | By design — no seed data can leak into a production database. |
| `npm run smoke` / `npm run load:sanity` are smoke-level, single-machine checks. | They prove the deploy answers correctly, not that it scales. | Pair with platform metrics after launch. |

## Branch protection (proposed — requires owner approval)

`main` currently accepts a direct push and a merge with red checks: GitHub
returns `404` for both branch-protection rules and repository rulesets
(verified 2026-10-19 — nothing is enabled). The policy below is a
**proposal only**; it has not been applied and must not be applied without the
owner's explicit approval. It targets a small team: enough enforcement that
"green on main" means something, without review bottlenecks that invite
rubber-stamping.

| Setting | Proposed value | Why |
| --- | --- | --- |
| Require a pull request before merging | yes, at least 1 approving review | Work lands through a reviewable diff, never as a surprise push |
| Dismiss stale pull request approvals when new commits are pushed | yes | An approval never covers code that has since changed |
| Require review from Code Owners | off for now | No `CODEOWNERS` file exists yet; adding the requirement first would block everything |
| Required status checks | `quality`, `integration`, `e2e` (the three job names in `.github/workflows/ci.yml`), strict branch up-to-date checking | A red gate blocks the merge, and the merge cannot race an out-of-date base |
| Require all conversations to be resolved | yes | Review threads do not linger at merge time |
| Do not allow bypassing the above settings | yes | An admin bypass would make the whole policy advisory again |
| Restrict force-pushes and deletions of `main` | yes | History and the protected checks stay trustworthy |
| Require linear history | **owner's call** | Clean log, but it forbids merge commits — decide the merge style (squash vs merge) first |

Apply only with approval — the settings live under *Settings → Branches /
Rulesets*; the equivalent ruleset can also be expressed as a `ruleset` block
or a `gh api` call, both of which belong in the owner's hands, not in an
agent's unattended run. After enabling, prove it once: open a draft PR, push a
commit that fails a gate, and watch the merge button stay disabled.

Interim posture until then: checklist item 1 confirms every required run by
hand on the release SHA.

## Evidence tiers

Claims about a release must name the tier they were observed at — local and
CI evidence never substitutes for production evidence.

| Tier | What proves it | Status (2026-10-19) |
| --- | --- | --- |
| **Local** (this machine, audit branch) | The full pre-deployment gates table | Green: lint, `tsc`, `check:env` (8 keys), `check:links` (32 files), unit 1614/1614 with coverage 75.6% statements / 66.0% branches (floors 74/64), integration 430/430 against a fresh `db reset` (19 migrations), e2e 81/81, `build`, smoke 5/5, load-sanity 400/400 (p50 13 ms, p95 45 ms), restore drill **pass** (see log below). |
| **Local** (chat reconciliation branch) | The same gates on `fix/chat-history-reconciliation` | Green: unit 1634/1634 (144 files) with coverage 75.8% statements / 66.3% branches, integration 431/431, e2e 82/82, plus lint/`tsc`/env/links/counts/build. The e2e was captured red without the fix (missed message after reconnect) and green with it. |
| **Local** (notification retention branch) | The same gates on `chore/notification-retention-cron` | Green: unit 1614/1614 with coverage 75.6%/66.0%, integration 432/432 (includes the new `cron.job` probes), e2e 81/81, plus lint/`tsc`/env/links/counts/build; fresh `db reset` applied 20 migrations and the scheduled job was observed firing to `succeeded`. |
| **CI** (GitHub Actions, `main`) | Workflow runs on the exact SHA | Green: run `39221176205` on merge commit `70fb971`; earlier `39216646842` (`bde09d1`) and `39214385915` (`facc1b4`). Per-branch runs for the two open PRs are linked from those PRs. |
| **Staging** | A deployed preview with smoke against it | **None — no staging environment exists.** The full setup and verification runbook is `docs/STAGING.md`; create one only with the owner's approval and a chosen host (see Hosting selection). |
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
