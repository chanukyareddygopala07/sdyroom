# Browser end-to-end tests (Playwright)

The integration suite exercises the API and RLS directly; this suite drives the real
application in a real Chromium against `next dev` and the same local Supabase stack —
forms, navigation, the shared timer and the realtime socket, with no API-level
shortcuts.

```bash
npm run test:e2e
```

Runs `playwright test`, which only discovers `tests/e2e/**/*.spec.ts`; it is excluded
from `npm test` and `npm run test:integration` by their vitest configs. As with the
other suites, `passWithNoTests` stays unset, so an empty suite exits non-zero.

## Prerequisites

1. Local stack running and migrations applied:

   ```bash
   npx supabase start
   npx supabase db reset
   ```

   Requires Docker. The container's Postgres is on 54322 — never the Homebrew server
   on 5432.
2. Environment (below) exported or present in `.env.local`.
3. The Chromium build for the pinned `@playwright/test`:

   ```bash
   npx playwright install chromium
   ```

The `globalSetup` reuses the integration suite's environment guard
(`tests/integration/helpers/env.ts` + `admin.ts`): loopback-only URL, publishable key
only, no service-role/secret variables, reachable API, migrations applied. One refusal
rule set serves both suites.

## How a run stays isolated

- **Run id.** `playwright.config.ts` generates one fixed-length `E2E_RUN_ID` per
  `playwright test` invocation (unless one is already exported). Every fixture user is
  `e2e+<runId>w<pid>n<seq>-<label>@example.com` with alias `e2e<runId>w<pid>n<seq>` —
  emails and the case-insensitively unique alias can never collide across parallel
  workers or concurrent runs.
- **Teardown.** The global teardown deletes `auth.users where email like
  'e2e+<runId>%'` in one statement; profiles, rooms, memberships, sessions and goals
  cascade with them. The count is selected from a CTE (`with removed as (delete …
  returning 1) select count(*)`) because a plain `delete … returning` makes psql append
  a `DELETE n` status line that corrupts the parse. Run ids are fixed length, so the
  prefix cannot overlap a different run's users.
- **No service-role key** anywhere; admin access is `docker exec … psql` on the local
  container (refused unless the API host is loopback), same as the integration suite.

## Proving realtime instead of guessing

Three techniques make the realtime assertions structural rather than timing-based:

1. **Poll-phase observation.** The workspace re-reads every 20 s (`POLL_INTERVAL_MS`)
   plus on focus/visibility. Before attributing any re-read to an event, a test first
   *observes* a poll (`expect.poll(reads, { timeout: 21_000 })`) while nothing is
   happening. Every subsequent read within a few seconds is then provably event-driven:
   the next scheduled poll is ~20 s away.
2. **Intercepted frames.** `captureRealtime(page)` registers `page.routeWebSocket` on
   `/realtime/v1/websocket`, relays to the real server with `connectToServer()`, and
   records every server→page frame. Attaching `server.onMessage` stops Playwright's
   automatic forwarding, so the helper re-delivers each frame with `socket.send` —
   observation without mutation. A `postgres_changes` frame on that socket can only
   have come from the WebSocket, so its arrival proves realtime delivery, and the raw
   frame is kept for replay: `inject(raw)` pushes a stale or duplicate delivery back
   into the client to assert the re-read keeps the view honest.
   The wire format is the Phoenix tuple
   `[join_ref, ref, topic, event, payload]` (not an object with an `.event` key) —
   `parsePostgresFrame` handles it.
3. **Auth before join.** The channel's join payload is built at `subscribe()` time and
   the server registers the `room_id` filter under the JWT claims it sees there. If
   the join goes out before the session token is on the client, registration happens
   as `anon`, and WALRUS rejects it (`invalid column for filter room_id` — `anon` has
   no column grants). `focus-timer` therefore `await`s
   `supabase.realtime.setAuth()` before subscribing, and the e2e realtime tests fail
   loudly if a join frame ever lacks a JWT.

## App/origin notes that bit us once

- **Hydration:** Playwright navigates to `http://localhost:3000` (`baseURL` in
  `playwright.config.ts`), and `next.config.ts` sets
  `allowedDevOrigins: ["127.0.0.1"]`. Next 16's dev server silently withholds its
  scripts from origins it does not recognise — the page then renders but never
  hydrates, so forms fall back to native submits and every client-side test lies.
  If a form "does nothing", check hydration first.
- **The countdown can lag up to one clock tick** between server reads; the timer
  clamps it to the session's duration, so a fresh 25-minute start reads `25:00`, never
  `25:01`.

## Files

| File | What it proves |
| --- | --- |
| `student-workflow.spec.ts` | The full flow through real forms: sign-up, onboarding, room creation, a two-context session with pause/resume propagating to the member, personal goals staying private, ending, leaving and the resulting 404 — every wait an assertion on observable UI |
| `private-room.spec.ts` | A private room is invisible to discovery; the owner enters their own workspace while non-members are refused |
| `access-expiry.spec.ts` | Signed-out redirects, indistinguishable 404s, full/closed rooms, owner-only controls, API abort + retry surfacing in the UI, an expired deadline recorded by a read, and session loss clearing access |
| `realtime.spec.ts` | A start reaches the member over WebSocket without a reload (frame + poll-phase proof), a dropped socket reports `Reconnecting…` and recovers, and stale/duplicate injected frames cannot corrupt the view |
| `helpers/` | Shared fixtures: users (sign-up/login/API sign-up), rooms (create/join/leave/search, selector anchors, sync status), realtime capture/injection and workspace-read counting |
| `global-setup.ts` / `global-teardown.ts` | Environment guard reuse; per-run user cleanup |

## CI

The `e2e` job in `.github/workflows/ci.yml` mirrors the `integration` job — checkout,
Node from `.nvmrc`, `npm ci`, local Supabase up, endpoints read and the publishable
key masked, migrations from scratch — then `npx playwright install --with-deps
chromium`, `npm run test:e2e`, the Playwright report and `test-results/` uploaded as
artifacts on failure, and `npx supabase stop --no-backup` in `always()`. The workflow
stays `permissions: contents: read` with no secrets; `NEXT_PUBLIC_*` values come from
the local stack's status file.
