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
  'e2e+<runId>%'` in one statement; profiles, rooms, memberships, sessions, goals,
  messages and study resources cascade with them. `storage.objects` does **not**
  cascade (no FK to `auth.users`), so the run's own objects are removed first — with
  `set storage.allow_delete_query='true'` in the same `psql` invocation, because
  `storage.protect_delete()` refuses a plain `delete from storage.objects` — and only
  then the users. The count is selected from a CTE (`with removed as (delete …
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
4. **The join waits for registration.** By default the server acks the join before the
   `postgres_changes` filter is registered — up to ~3 s on a freshly started service —
   and a write inside that window is dropped with no replay. `focus-timer` and the
   integration `subscribe()` helper therefore pass
   `config: { postgres_changes_options: { wait: true } }`, which makes the server hold
   the reply until registration confirms (the reply echoes the server-side filter
   ids). `SUBSCRIBED`/`Live` then means frames are deliverable, registration failures
   surface as `CHANNEL_ERROR` instead of silence, and the join timeout is extended
   automatically.

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
- **Controlled inputs filled before hydration get reset.** React controlled inputs
  (onboarding, login, room forms) written with `fill()` before hydration commits are
  wiped back to their initial state when React takes over — the browser then reports
  `Please fill out this field` and the test hangs. `waitForHydration()`
  (helpers/users.ts) waits for the element's `__reactProps$` key before filling; every
  form-fill helper goes through it.

## Files

| File | What it proves |
| --- | --- |
| `student-workflow.spec.ts` | The full flow through real forms: sign-up, onboarding, room creation, a two-context session with pause/resume propagating to the member, personal goals staying private, ending, leaving and the resulting 404 — every wait an assertion on observable UI |
| `private-room.spec.ts` | A private room is invisible to discovery; the owner enters their own workspace while non-members are refused |
| `access-expiry.spec.ts` | Signed-out redirects, indistinguishable 404s, full/closed rooms, owner-only controls, API abort + retry surfacing in the UI, an expired deadline recorded by a read, and session loss clearing access |
| `realtime.spec.ts` | A start reaches the member over WebSocket without a reload (frame + poll-phase proof), a dropped socket reports `Reconnecting…` and recovers, and stale/duplicate injected frames cannot corrupt the view |
| `chat.spec.ts` | Chat history seeded into the workspace, a message sent through the real form appearing for the member over realtime, and the connection badge staying honest offline |
| `presence.spec.ts` | The private-channel roster end to end: two members see each other, a closed tab leaves within the 15 s heartbeat window and a reopened one restores the roster; a signed-in non-member of a private room is indistinguishable from a missing one, with zero presence frames observed; and `studying` badges appear when a session starts and clear when it ends |
| `resources.spec.ts` | A file uploaded through the real form into the personal library, searchable and openable by its owner only, shared into a room and read by a member, refused for a non-member, then deleted — row and object both gone |
| `moderation.spec.ts` | Member safety in the real UI: a message report reaching the owner's moderation inbox and resolving with no reporter identity shown, one-way block filtering that leaves no trace for the blocked user, an owner muting a member (disabled composer) then removing them to a 404, and the documented refusal codes for anonymous, outsider and plain-member direct API attempts |
| `resource-hardening.spec.ts` | Upload abuse protection through the real browser: an oversize file and a `.exe` refused by the form's preflight with the library still empty, a normal upload tracked by the "X of Y used" quota line, a psql-filled library locking the form (and the API behind it still answering `409 quota_exceeded` with zero objects written), and a spent upload window answering `429` + `Retry-After` over real HTTP *and* as friendly copy inside the form |
| `helpers/` | Shared fixtures: users (sign-up/login/API sign-up, `waitForHydration`), rooms (create/join/leave/search, selector anchors, sync status, presence count and participant badges), resources (multipart bytes, row lookups, upload through the form, library anchors), realtime capture/injection (including presence-frame parsing) and workspace-read counting |
| `fixtures/` | Tiny on-disk files the upload tests send: a real `%PDF-` document and an impostor `.pdf` that is plain text |
| `global-setup.ts` / `global-teardown.ts` | Environment guard reuse; per-run user cleanup, after this run's `storage.objects` rows (which have no FK to `auth.users`) |

## CI

The `e2e` job in `.github/workflows/ci.yml` mirrors the `integration` job — checkout,
Node from `.nvmrc`, `npm ci`, local Supabase up, endpoints read and the publishable
key masked, migrations from scratch — then `npx playwright install --with-deps
chromium`, `npm run test:e2e`, the Playwright report and `test-results/` uploaded as
artifacts on failure, and `npx supabase stop --no-backup` in `always()`. The workflow
stays `permissions: contents: read` with no secrets; `NEXT_PUBLIC_*` values come from
the local stack's status file.
