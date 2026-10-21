# Development

Practical day-to-day guide. The database deep-dive lives in
[`docs/local-supabase.md`](local-supabase.md); the operational contract for
agents and reviewers lives in [`AGENTS.md`](../AGENTS.md). Security claims
and API contracts live in [`docs/SECURITY.md`](SECURITY.md) and
[`docs/API_CONTRACTS.md`](API_CONTRACTS.md) — this file does not restate
them.

## First setup

```bash
npm install                 # exact versions from the lockfile; do not bump casually
npx supabase start          # local stack (Docker; see docs/local-supabase.md)
npx supabase db reset       # migrations in order + supabase/seed.sql
cp .env.example .env.local  # then fill the Supabase URL/key from `npx supabase status`
npm run dev                 # http://localhost:3000
```

Sign-up needs email confirmation locally — see the "Email confirmation"
section of `docs/local-supabase.md`. `.env.example` is the authoritative
key list; `npm run check:env` fails when the code reads a key the example
does not document.

## Live meetings (LiveKit)

The room workspace has a second view, **Meeting**: a real audio/video call
with screen sharing, powered by [LiveKit](https://livekit.io) and joined
through `POST /api/rooms/[id]/meeting/token`. It is an optional,
server-side-only feature with the same discipline as the AI provider:

- Three keys, read in exactly one place — `lib/meeting/config.ts`:
  `LIVEKIT_URL` (`ws://`/`wss://`), `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`.
  All three are required together; none of them is ever `NEXT_PUBLIC_*`, so
  the browser bundle carries no provider endpoint and never sees the
  secret. The client learns the URL only from the token response.
- **No provider configured → the feature is honestly off**: the Meeting
  toggle is disabled with an explanation, the join card cannot be reached,
  and the token route answers `503 meeting_unavailable` (checked before the
  rate limit, so nothing is spent). `npm run check:env` covers the keys
  through `.env.example`.
- Local development needs a LiveKit server to actually connect —
  [LiveKit's local deployment](https://docs.livekit.io/home/self-host/local-deployment)
  is one container:

  ```bash
  docker run --rm -p 7880:7880 -p 7881:7881 \
    -e LIVEKIT_KEYS=APIkeyEXAMPLE:secretEXAMPLEvalue1234567890 \
    livekit/livekit-server --dev
  ```

  then set `LIVEKIT_URL=ws://localhost:7880`, `LIVEKIT_API_KEY` and
  `LIVEKIT_API_SECRET` in `.env.local` to match the key above. (A LiveKit
  Cloud project works too — put its URL and keys in the same three
  variables.) Without any of them everything else about the workspace still
  works, and `tests/e2e/meeting.spec.ts` runs only its unconfigured-path
  test.

Code map: `lib/meeting/config.ts` (env + room-name derivation) ·
`lib/meeting/token.ts` (JWT grants: join-only, microphone dropped for a
muted member) · `app/api/rooms/[id]/meeting/token/route.ts` (auth,
membership, rate limit, envelope) · `components/room-workspace.tsx`
(study/meeting toggle, chat mounted in both views) ·
`components/meeting/*` (join-card state machine, `LiveKitRoom` wiring,
tiles, controls, device pickers). Authorization never moves client-side:
every join re-mints the token, and the token route re-proves membership on
that request. Moderation (mute / remove / appoint) keeps using its existing
server-authorized routes — see `docs/API_CONTRACTS.md` (rate limit
`meeting_token:{roomId}:{userId}`, 12 per 60 s per room and member).

## OAuth providers (Google & GitHub)

The sign-in and sign-up screens offer real Supabase OAuth for Google and
GitHub (`components/auth/oauth-buttons.tsx` → `supabase.auth.signInWithOAuth`).
Both return through `app/auth/callback/route.ts`, which exchanges the PKCE
code server-side and only honours site-internal `next` targets
(`lib/auth/safe-next.ts`). **Providers are owner-configured**: until one is
enabled in Supabase, its button shows a friendly "isn't available right
now" alert — never a fake success. No provider secrets live in this
repository or in any `NEXT_PUBLIC_*` variable; local secrets enter through
environment variables referenced from `supabase/config.toml`.

### Hosted (Supabase dashboard)

1. **Google**: enable Google under Authentication → Providers. Create an
   OAuth 2.0 client in Google Cloud Console; set the authorized redirect
   URI to the callback URL the Supabase provider page shows
   (`https://<project-ref>.supabase.co/auth/v1/callback`). Put the client
   ID and secret in the Supabase provider form.
2. **GitHub**: create an OAuth App (Settings → Developer settings → OAuth
   Apps); set the callback URL to the same Supabase-supplied
   `…/auth/v1/callback`. Put the client ID and secret in Supabase's GitHub
   provider form.
3. **Redirect allowlist**: add the application URLs under Authentication →
   URL Configuration — at minimum `https://<your-domain>/**` for hosted
   and `http://127.0.0.1:3000/**` for local. The OAuth return leg is
   `<origin>/auth/callback`, and password-reset emails already point at
   `<origin>/auth/update-password`.

### Local stack

`supabase/config.toml` carries `[auth.external.google]` and
`[auth.external.github]` blocks, both `enabled = false` by default:

1. Create the provider apps as above, but use the **local** callback URL
   the Supabase dashboard shows for the local project (it is also
   `<local-url>/auth/v1/callback` — the distinction from hosted is only
   the host: `127.0.0.1:54321` locally versus your project ref hosted).
2. Set `enabled = true` and `client_id` in the config block; export
   `SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET` /
   `SUPABASE_AUTH_EXTERNAL_GITHUB_SECRET` in the shell that runs
   `npx supabase start` (the config reads them via `env(...)` — never
   write the secret into the file).
3. Restart the stack. Google locally also needs
   `skip_nonce_check = true`, which the shipped block already sets.

Hosted and local are independent: enabling a provider on the dashboard
does not enable it in the local stack, and vice versa.

## GIF search (communities)

The community composer has a GIF tab. Like the AI key and the LiveKit
secrets, the provider credential is **server-side only**:

- Two keys, read together in `lib/communities/gif.ts`: `GIF_PROVIDER`
  (`tenor` or `giphy`) and `GIF_API_KEY`. Both are required together; neither
  is ever `NEXT_PUBLIC_*`. The browser only ever talks to
  `GET /api/communities/gif/search` and `POST /api/communities/gif/fetch` —
  the provider sees this server's request, never the student's session.
- **No provider configured → the feature is honestly off**: the composer
  hides the GIF tab, and both endpoints answer `503 gif_unavailable` (the
  rate-limit window is spent before the config check, as documented in
  `docs/API_CONTRACTS.md`). `npm run check:env` covers both keys through
  `.env.example`.
- Local development: create a free Tenor (Google Cloud) or Giphy
  (developers.giphy.com) key and put both lines in `.env.local`:

  ```bash
  GIF_PROVIDER=tenor
  GIF_API_KEY=…
  ```

  then restart `npm run dev`. Downloads are proxied with a host allow-list
  and a 5 MiB `image/gif`-only cap (see `docs/API_CONTRACTS.md` §gif), and
  fetched GIFs are encrypted like any attachment before they are announced in
  chat — the bucket only ever receives ciphertext.
- The test suites never need a provider key: the GIF unit tests stub the
  provider, and everything else exercises the unconfigured `503` path.

Code map: `lib/communities/gif.ts` (config, search, allow-listed fetch) ·
`app/api/communities/gif/{search,fetch}/route.ts` (session, rate limit,
envelope) · `components/communities/community-composer.tsx` (the tab and its
hidden-when-unavailable behaviour) · `hooks/use-community-workspace.ts`
(encrypts the chosen GIF into an attachment payload before send).

## Running the suites

| Suite | Command | Needs | Notes |
| --- | --- | --- | --- |
| Lint | `npm run lint` | — | Zero errors, zero warnings. Baseline suppressions are listed in `AGENTS.md`; do not add more. |
| Types | `npx tsc --noEmit` | — | |
| Unit | `npm test` | — | vitest, node environment; DOM component tests included via jsdom-style rendering. |
| Unit + coverage | `npm run test:coverage` | — | Measures `lib/**` + `app/api/**` only; floors are statements 75% / branches 65% (`vitest.config.ts`). |
| Integration | `npm run test:integration` | local stack running + `db reset` | Real auth users over HTTP and SQL. No DOM assertions. |
| E2E | `npm run test:e2e` | local stack running + `db reset` | Playwright Chromium; the dev server is started by the Playwright config. |
| Build | `npm run build` | — | Must pass without any Supabase reachable. |
| Smoke | `npm run smoke` | a running production build (`npm run start`) | Probes health, readiness, metrics and the error envelope. |

Doc gates (run when you touch tests or markdown):

```bash
npm run check:counts        # add -- --unit-json=… / --integration-json=… after a run for totals
npm run check:links
```

## Adding a migration

1. Number it as the next file in `supabase/migrations/` (`NNNN_snake_case.sql`).
   **Never edit a migration that has merged** — add a new one that supersedes
   it (expand/contract pattern if a column must go away).
2. Revoke-first: `revoke … from …;` then `grant …`, so privilege widening is
   a visible, deliberate diff.
3. Enable RLS on every new table and write explicit policies; narrow column
   grants to what the routes actually read or write.
4. `SECURITY DEFINER` functions only with a comment justifying the definer
   rights and integration tests that pin the grant surface.
5. Apply with `npx supabase db reset`, then run `npm run test:integration`.
   Update `docs/local-supabase.md`'s schema/grant sections and any
   `docs/SECURITY.md` counts that changed — `check:counts` verifies the
   test-count side.

## Adding an endpoint

1. **Schema first.** zod schema in `lib/validation/**`, `.strict()`, trim
   before length checks, blank optionals normalised to `null`.
2. **Route.** `app/api/**` stays thin: parse → validate → call `lib/**` →
   return the envelope. Read identity from the session claims, never from
   the body.
3. **Rate limit**, if the route writes or spends resources: take a slot from
   `lib/rate-limit/keys.ts` after validation and before the write; document
   the `429` in the route's JSDoc table and in `docs/API_CONTRACTS.md`.
4. **Errors.** Map to the shared envelope (`code` + user-facing English
   message); `404 not_found` for "missing or not yours"; no SQL detail
   leaks. Server logging goes through `lib/server/log.ts`, never `console.*`.
5. **Tests.** Unit: status/code matrix including every error branch
   (`tests/unit/**` with a mocked client). Integration: the real route with
   real users (`tests/integration/**`). E2E only when a user journey
   changes.
6. **Docs.** The route's section in `docs/API_CONTRACTS.md`, any security
   claim in `docs/SECURITY.md`, and the README endpoint table if the route
   is user-facing.

## Style and conventions

- Exact dependency versions in `package.json` (no `^`/`~` ranges).
- Conventional-commit messages; the PR title usually mirrors the branch.
- Dates in prose are ISO (`YYYY-MM-DD`).
- Comments explain *why*, not *what*; route and migration files carry a
  short header doc-comment describing their contract.
- Feature specs and their checkboxes live in `docs/prs/*`; landed history in
  `docs/milestones.md`; remaining work in `docs/PR_ROADMAP.md`.
