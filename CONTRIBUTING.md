# Contributing to SdyRoom

Thanks for helping improve SdyRoom. This document covers the workflow, the exact
gates CI runs, and the conventions this repository follows.

## Development setup

Prerequisites: **Node.js 24** (see `.nvmrc`), npm, and **Docker** for the local
Supabase stack.

```bash
git clone https://github.com/chanukyareddygopala07/sdyroom.git
cd sdyroom
npm ci
cp .env.example .env.local   # then fill it from `npx supabase status -o env`
npx supabase start
npx supabase db reset
npm run dev                  # http://localhost:3000
```

The two environment variables the app reads are public and browser-safe
(`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`). `.env.local`
is gitignored — never commit it, and never put a service-role or secret key in a
`NEXT_PUBLIC_` variable, a doc, a log or a test.

For e2e tests also install the browser once:

```bash
npx playwright install chromium
```

Full details: [`docs/local-supabase.md`](docs/local-supabase.md).

## Branches and commits

- Branch from `main` with a descriptive name (`feat/…`, `fix/…`, `docs/…`).
- Keep each pull request to one coherent change.
- Commit messages follow the history's style: a short conventional prefix and a
  single summary line, e.g. `feat: room capacity enforcement`,
  `fix: realtime reconnect`, `docs: sync the roadmap`.
- Never commit secrets, `.env.local`, generated reports or editor droppings.

## Before you open a pull request

CI (`.github/workflows/ci.yml`) must be green. Run the same gates locally:

```bash
npm run lint          # ESLint (flat config)
npx tsc --noEmit      # type check (what the CI "types" step runs; there is no typecheck script)
npm test              # unit suite — no network, no stack needed
npm run build         # production build
```

If your change touches anything the slower suites cover, also run them against the
local stack (`npx supabase start && npx supabase db reset` first):

```bash
npm run test:integration
npm run test:e2e
```

Rules of thumb:

- **Tests prove behavior.** Add or strengthen tests for anything you change; never
  weaken, skip or delete a test to get green.
- **The database is the authority.** If you change an API contract, re-check that
  the RLS policy / grant / RPC still enforces it — and that an integration test
  freezes both.
- **Migrations are append-only.** `supabase/migrations/0001` onward are never
  edited after they land; schema changes are a new numbered file. The local stack
  must stay reproducible with `npx supabase db reset`.

## Documentation

Update the docs in the same pull request when applicable:

| You changed… | Update… |
| --- | --- |
| An endpoint's contract or status codes | `docs/API_CONTRACTS.md` |
| Authorization, policies, secrets or abuse controls | `docs/SECURITY.md` |
| Schema, grants or storage setup | `docs/local-supabase.md` |
| Structure, data model or decision map | `docs/ARCHITECTURE.md` |
| What shipped / what is next | `docs/milestones.md`, `docs/PR_ROADMAP.md` |
| Test counts quoted anywhere | `README.md`, both `tests/*/README.md` |

Larger features get a specification under `docs/prs/PR-NN-*.md` describing the
design, acceptance criteria and reconciliation notes.

## Pull request checklist

- [ ] CI is green on your branch (lint, types, unit, build, integration, e2e)
- [ ] New/changed behavior is covered by tests; no test was weakened or skipped
- [ ] Docs updated for contract, security, schema or roadmap changes
- [ ] No secrets, keys, `.env.local` or generated artifacts committed
- [ ] Description explains **what** changed and **how** it was verified

## Reporting bugs and security issues

- Bugs and feature requests: [open an issue](https://github.com/chanukyareddygopala07/sdyroom/issues).
- Security vulnerabilities: follow [`SECURITY.md`](SECURITY.md) — please do not
  open a public issue.
