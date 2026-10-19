# Staging environment

Operator runbook for a private staging deployment: Vercel (app) + a dedicated
Supabase project (data), kept strictly separate from production. **Status:
not configured** — no Vercel project, no hosted Supabase project and no
deployed URL exist as of 2026-10-19; nothing in this file has been executed
against real accounts. Dashboard steps are the owner's to run (agents never
hold credentials); this file is the deliberate, reviewable recipe.

Merge first, so staging receives the current behaviour and schema:

1. PR #28 — chat history reconciliation (staging's chat checks assume it);
2. PR #29 — migration `0024` (staging's `cron.job` check assumes it);
3. PR #30 — this launch-readiness documentation.

## Design choices (made here, not improvised at the dashboard)

| Choice | Value | Why |
| --- | --- | --- |
| Staging surface | Vercel **Preview** environment, deployed from a dedicated `staging` git branch | Keeps "Production" untouched until launch day; previews of PRs stay ephemeral |
| Production environment | **Deliberately unconfigured** | Separation is the point: no staging traffic can ever resolve to production settings |
| Staging database | A **dedicated** Supabase free project, never the production project, never copied prod data | Staging is allowed to be wiped; production data must never appear in a screenshot, log or URL |
| AI on staging | `AI_API_KEY` unset (`AI_PROVIDER=auto` → mock) | Full pipeline without cost or a real key in a non-production environment; a configured provider that fails answers `502 ai_provider_failed` and never falls back silently |
| URL discipline | Unlisted URL; **test accounts and synthetic data only** until the matrix below passes | No real users, no real documents, no real notifications |

## 1. Supabase staging project

Free-tier caveats (review Supabase's current billing docs before provisioning):
free plans have historically documented a small number of free projects per
organization, a small database/storage/egress quota per project, and
**automatic pausing of inactive projects** — fine for a private early beta,
never a substitute for a tested recovery plan.

1. In the Supabase dashboard, create (or select) a project used **only** for
   staging. Confirm free-project capacity in your organization first.
2. Record the **project ref** and **region** in your private deployment notes
   — never in this repository, never in commit messages.
3. Link the CLI to it and verify the target before anything is written:
   ```sh
   npx supabase login                    # once, interactive, owner's machine
   npx supabase link --project-ref <STAGING_REF>
   npx supabase status                   # confirm the linked project is the staging one
   ```
4. Apply migrations **only after** the linked ref matches your notes:
   ```sh
   npx supabase db push                  # 20 migrations after PR #29 (0014–0017 never existed)
   ```
5. Verify the schema before any application traffic (same spot-checks as the
   restore drill in `docs/RELEASE.md`):
   ```sql
   select count(*) from supabase_migrations.schema_migrations;  -- must equal the file count
   select count(*) from pg_policies where schemaname = 'public';
   select count(*) from information_schema.tables where table_schema = 'public';
   ```
   and, from the repo, a structural diff of the linked project against the
   migration files:
   ```sh
   npx supabase db diff --linked -f staging-after-push
   ```
   An empty diff is the evidence of "no unexpected schema changes".

### Verify the scheduled retention job (migration 0024)

Run in the staging project's SQL editor after the push:

```sql
SELECT jobid, schedule, command, active
FROM cron.job
WHERE jobname = 'prune_notifications';
```

Expect exactly one row: schedule `'17 3 * * *'`, command
`select public.prune_notifications(now() - interval '90 days');`, `active`
true. Then confirm the job actually executed via your pg_cron version's
run-history surface (for pg_cron ≥ 1.4 this is the `cron.job_run_details`
table):

```sql
SELECT status, return_message, start_time
FROM cron.job_run_details
ORDER BY start_time DESC
LIMIT 5;
```

Do **not** hand-run a destructive prune against data you care about just to
see it work; the job itself deletes only rows older than 90 days, and staging
is synthetic — waiting for the first scheduled tick (or the row above) is
enough. If the SQL editor reports that `pg_cron` must be enabled, enable the
extension (it is on Supabase's allowlist) and re-run migration `0024`'s
`schedule` statement — that is a staging-only repair, never an edit to the
merged migration file.

## 2. Vercel staging deployment

Hobby-plan caveat: Vercel's free tier is intended for personal,
non-commercial use — check the current plan policy before relying on it for
anything public or commercial.

1. Import `chanukyareddygopala07/sdyroom` in the Vercel dashboard (no
   framework guesswork needed: Next.js is auto-detected; build command
   `npm run build`, Node version from `.nvmrc`).
2. Create the `staging` branch in GitHub once the three PRs above are merged
   into `main`, and point a Preview-scoped deployment at it. Do **not**
   configure a Production environment yet.
3. Set environment variables **scoped to Preview/`staging` only** — names
   exactly as in `.env.example` and the matrix in `docs/RELEASE.md`:

   | Key | Scope | Staging value |
   | --- | --- | --- |
   | `NEXT_PUBLIC_SUPABASE_URL` | browser (public by definition) | Staging project URL (`https://<ref>.supabase.co`) |
   | `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | browser (public by definition) | Staging publishable/anon key |
   | `AI_PROVIDER` | server-side | leave unset (`auto` → mock without a key) |
   | `AI_API_KEY` | server-side, **secret** | leave unset on staging |
   | `AI_BASE_URL` / `AI_EMBED_MODEL` / `AI_CHAT_MODEL` / `AI_MAX_INGEST_BYTES` | server-side | leave unset (code defaults) |
   | `VERCEL_URL` | platform-set | set automatically by Vercel |

   **Never** prefix a secret with `NEXT_PUBLIC_` — anything so prefixed is
   compiled into the browser bundle. Only the two Supabase values above are
   browser-visible, and the publishable key is designed to be.
4. Deploy the `staging` branch; wait for the build to go green; open the
   Preview URL over **HTTPS**. Before inviting any tester, read the build
   output, runtime logs and usage dashboard once — an unexplained error or a
   runaway function is cheaper to find now.
5. Keep the URL private (do not publish it in the README, issues or demos)
   until the verification matrix below is green.

## 3. Verification matrix

Run against the **staging deployment**, not localhost. The automated e2e
suite is bound to the local stack by design (`playwright.config.ts` starts
its own dev server), so browser rows below are a manual two-account pass —
`tests/e2e/*.spec.ts` is the script of what to reproduce; the HTTP rows are
scriptable from a terminal.

| Area | Evidence to collect |
| --- | --- |
| Deployment | Vercel build green; staging URL loads over HTTPS; `SMOKE_BASE_URL=https://<staging> npm run smoke` — all 5 checks green; `LOAD_BASE_URL=https://<staging> npm run load:sanity` — 400/400, record p50/p95/p99 |
| Database | Migration count matches the file count (20); `supabase db diff --linked` empty; no unexpected tables/policies |
| Authentication | Sign-up, login, logout, session expiry, and an unauthenticated API call returning the documented `401` envelope |
| Rooms | Create, discover, join, leave, private-room visibility, capacity limit refusal |
| Chat | Two accounts: send, reload, send-during-reload (reconcile — PR #28), reconnect after a network drop, no duplicates, no reordering |
| Privacy | A non-member gets the same `404` as a missing room for private messages and resources (never `403`+existence) |
| Resources | Upload, signed-URL download, expiry, cross-user open refused |
| Moderation | Report → owner inbox → resolve; moderator powers; plain-member refusals |
| Notifications | Badge live-updates, inbox, preferences honored at write time; retention: the `cron.job` row plus a successful `job_run_details` entry |
| AI | Mock provider end-to-end with the demo-mode banner (no `AI_API_KEY`); optionally `AI_PROVIDER=openai` with the key **absent** must fail loudly (`502 ai_provider_failed`), never silently |
| Operations | `/api/health`, `/api/health/ready` (db + storage), `/api/metrics`; one deliberate error: its `request_id` appears in Vercel's log stream with no `authorization`/`cookie` value anywhere |
| Recovery | Take a staging backup (`pg_dump` via dashboard/CLI) and restore it into a scratch container using the drill in `docs/RELEASE.md`; re-verify `cron.job` after any restore; storage objects are not in the dump — confirm re-upload is the documented path; free tier has no PITR, so record the backup cadence instead of pretending a window exists |

Use test accounts and synthetic data throughout. Do not invite testers until
authentication, authorization and resource-access rows are green.

## 4. Sign-off and record

When the matrix passes, add a **Staging** row to the evidence table in
`docs/RELEASE.md` (URL host only, date, operator, what was proven) and flip
this file's status line to the date and deployment. Until then, staging
claims in issues and PRs must say "pending".

## 5. Teardown

Staging costs nothing while idle on the free tiers, but paused Supabase
projects and unused Vercel previews still hold your project slots and URLs.
If staging is retired, delete the Vercel project and the Supabase project
deliberately, and strike the row from the evidence table rather than leaving
a dead URL behind.
