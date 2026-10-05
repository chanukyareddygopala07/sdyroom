# Integration tests (Supabase)

Unit tests (`npm test`) never touch Supabase. This suite is the only one that does,
and it is meant to run in CI as a separate job with a live stack.

## Command

```bash
npm run test:integration
```

Runs `vitest run --config vitest.integration.config.ts`, which only discovers
`tests/integration/**/*.test.ts` and is excluded from `npm test`.

**The suite is empty on purpose and the command fails (exit code 1, "No test files
found") until the Supabase/database milestone.** `passWithNoTests` is deliberately
not set in `vitest.integration.config.ts` so a missing integration suite can never
silently pass a gate.

Deferred to that milestone: real-auth and RLS integration tests (schema, migrations,
RLS policies asserted against authenticated users). Do not treat the current failure
as a regression, and do not re-add `passWithNoTests`.

## Prerequisites

1. Local Supabase stack running:

   ```bash
   npx supabase start
   npx supabase status   # note the URL, anon/publishable and service_role keys
   ```

   Requires Docker. Do not use the Homebrew PostgreSQL instance on port 5432.

2. Migrations applied (database milestone):

   ```bash
   npx supabase db reset
   ```

## Environment variables

Export these in the shell that runs `npm run test:integration`. They are read from
`process.env`, so `.env.local` alone is not picked up by Vitest.

| Variable | Purpose | Example (local) |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Data API / auth endpoint | `http://127.0.0.1:54321` |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Client-side key, used by app code under test | from `npx supabase status` |
| `SUPABASE_SECRET_KEY` | Service-role key for admin/RLS setup helpers | from `npx supabase status` |

Test users, passwords and the tables they exercise belong to the database
milestone and will be documented alongside those tests.
