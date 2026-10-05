<img alt="SdyRoom" src="https://demo-nextjs-with-supabase.vercel.app/opengraph-image.png">
<h1 align="center">SdyRoom</h1>

<p align="center">
 Capacity-limited study rooms for exam prep, built with Next.js and Supabase
</p>

<p align="center">
  <a href="#features"><strong>Features</strong></a> ·
  <a href="#demo"><strong>Demo</strong></a> ·
  <a href="#deploy-to-vercel"><strong>Deploy to Vercel</strong></a> ·
  <a href="#clone-and-run-locally"><strong>Clone and run locally</strong></a> ·
  <a href="#feedback-and-issues"><strong>Feedback and issues</strong></a>
  <a href="#more-supabase-examples"><strong>More Examples</strong></a>
</p>
<br/>

## Pinned dependency versions

All dependencies are pinned to exact versions (no `^`, `~` or `latest`) in `package.json`.

| Package | Version |
| --- | --- |
| next | **16.3.8** |
| react / react-dom | 19.3.0 |
| typescript | 5.9.3 |
| zod | 4.6.5 |
| @supabase/ssr | 0.12.7 |
| @supabase/supabase-js | 2.117.2 |
| supabase (CLI, devDependency) | 2.119.0 |
| tailwindcss | 4.3.3 |
| @tailwindcss/postcss | 4.3.3 |
| eslint-config-next | 16.3.8 |
| vitest | 5.0.3 |
| vite | 8.3.2 |
| jsdom | 30.1.2 |

**Next.js 16.3.8 is an intentional, security-driven deviation from the originally
specified 16.3.4.** 16.3.8 is the patched release on the 16.3.x line and is what the
approved Supabase starter resolves to; keep this pin and do not downgrade to 16.3.4.

`eslint-config-next` is pinned to **16.3.8 to match Next.js 16.3.8** (it must stay on
the same release as `next`). It ships a native flat config, which `eslint.config.mjs`
spreads directly — `FlatCompat`/`@eslint/eslintrc` is no longer used.

## Tailwind CSS 4

Styling runs on **Tailwind CSS 4.3.3** with `@tailwindcss/postcss` (PostCSS plugin).
The migration replaced the v3 trio (`tailwindcss` + `autoprefixer` + `tailwind.config.ts`):

- `postcss.config.mjs` uses `@tailwindcss/postcss` only; `autoprefixer` was removed
  (Tailwind 4 emits vendor prefixes itself).
- `app/globals.css` is CSS-first: `@import "tailwindcss"`, `@plugin "tailwindcss-animate"`,
  `@custom-variant dark` for the class-based dark mode, and `@theme inline` for the
  shadcn colour/radius tokens (the `--radius-*` and `hsl(var(--*))` values match the
  old JS config).
- `tailwind.config.ts` was deleted; source detection is automatic.
- Class renames for v4: `shadow` → `shadow-sm`, `shadow-sm` → `shadow-xs`,
  `outline-none` → `outline-hidden`, `bg-gradient-*` → `bg-linear-*`, and the removed
  `origin-[--var]` shorthand → `origin-[var(--var)]`.

## npm audit

`npm audit --omit=dev` (production dependencies): **0 vulnerabilities**.

`npm audit` (all dependencies): **5 high**, all in the dev toolchain and all one chain
rooted in a single advisory:

| Advisory | Package | Range |
| --- | --- | --- |
| [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) — stack-exhaustion DoS via deeply nested patterns (high) | `braces` | `<=3.0.3` |

Propagation: `braces` ← `micromatch` ← `fast-glob` ← `@next/eslint-plugin-next@16.3.8`
← `eslint-config-next@16.3.8`.

`braces@3.0.3` is the newest release on npm, so **no fixed version exists yet**; npm's
only suggested resolution is a downgrade of `eslint-config-next` to 14.2.35, which is
rejected. Nothing is suppressed and `--force` / `--legacy-peer-deps` are not used.
Re-check `npm audit` on every dependency update: the count fell from 7 to 5 with the
Tailwind CSS 4 migration (removing the `tailwindcss@3` → `chokidar` → `braces` path).

## Testing

- `npm test` (alias `npm run test:unit`) runs `vitest run` over `tests/unit/**` in the
  Node environment. It never contacts Supabase and passes without a local stack running.
  Individual UI test files opt into jsdom with a `@vitest-environment jsdom` docblock.
- `npm run test:integration` runs `vitest run --config vitest.integration.config.ts`
  over `tests/integration/**`. The suite is still empty, so this command exits
  non-zero — that is deliberate, so missing integration tests cannot silently pass.
  See `tests/integration/README.md`.

## Local Supabase

The database foundation runs entirely locally through the pinned CLI
(`npx supabase start`), with Postgres on port **54322** — never the Homebrew server on
5432. See [docs/local-supabase.md](docs/local-supabase.md) for the schema, grants, RLS
policies, the `create_room` RPC, how owner-membership atomicity is enforced, and the
verification commands.

## Application

SdyRoom is a minimal working application on top of this starter: sign up, pick a
unique study alias once, then discover public rooms and create your own.

| Route | Access | What it does |
| --- | --- | --- |
| `/` | public | Landing page with sign-up and browse calls to action |
| `/auth/*` | public | Password auth. Local Supabase has email auto-confirm on, so sign-up returns a session and routes to `/onboarding`; otherwise the success page is shown |
| `/onboarding` | signed in | One-time study alias via `POST /api/profile` |
| `/rooms` | signed in | Public room discovery with a `?q=` search over name, subject and exam track |
| `/rooms/new` | signed in, alias chosen | Create a room via `POST /api/rooms` |
| `GET /api/rooms` | signed in | Shaped public rooms, `401` when unauthenticated |
| `POST /api/profile` | signed in | Creates the profile row, `409 alias_taken` on a case-insensitive collision |
| `POST /api/rooms` | signed in, alias chosen | `401` / `400 validation` / `403 onboarding_required` / `201` |

How the pieces fit together:

- **Session**: `proxy.ts` → `lib/supabase/proxy.ts#updateSession` refreshes cookies
  and sends unauthenticated visitors (everything except `/`, `/auth/*` and `/api/*`)
  to `/auth/login`. API routes are exempt on purpose so a `fetch` client gets the
  documented JSON `401` instead of an HTML redirect. Each session-gated page re-checks the session and, for rooms, the
  profile row; they export `instant = false` because the project runs with
  `cacheComponents` and these routes must render per request.
- **Validation**: `lib/validation/` (Zod) mirrors the CHECK constraints in
  `supabase/migrations/0001_init.sql`, so bad input is rejected in the browser, at
  the API boundary and again in the database.
- **Database access**: `lib/profiles/queries.ts` and `lib/rooms/` — public rooms are
  read with an explicit column list and mapped through `toPublicRoom()`, so
  `owner_id` and any future private column can never reach a response. Rooms are
  only ever created through the `create_room` RPC; the owner is taken from
  `auth.uid()` and never accepted from the client.
- **Errors**: one envelope for every API failure, `{ error: { code, message, issues?
  } }`, built by `lib/api/responses.ts`.

### Layout note

The original brief assumed a `src/` tree (`src/lib/...`). This repository keeps the
starter's root-level `app/`, `lib/` and `components/`, so those modules live at
`lib/validation/`, `lib/rooms/`, `lib/profiles/` and `lib/api/` instead of
`src/lib/...`. Route and test paths are otherwise unchanged.

## Features

- Works across the entire [Next.js](https://nextjs.org) stack
  - App Router
  - Pages Router
  - Proxy
  - Client
  - Server
  - It just works!
- supabase-ssr. A package to configure Supabase Auth to use cookies
- Password-based authentication block installed via the [Supabase UI Library](https://supabase.com/ui/docs/nextjs/password-based-auth)
- Styling with [Tailwind CSS](https://tailwindcss.com)
- Components with [shadcn/ui](https://ui.shadcn.com/)
- Optional deployment with [Supabase Vercel Integration and Vercel deploy](#deploy-your-own)
  - Environment variables automatically assigned to Vercel project

## Demo

You can view a fully working demo at [demo-nextjs-with-supabase.vercel.app](https://demo-nextjs-with-supabase.vercel.app/).

## Deploy to Vercel

Vercel deployment will guide you through creating a Supabase account and project.

After installation of the Supabase integration, all relevant environment variables will be assigned to the project so the deployment is fully functioning.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fvercel%2Fnext.js%2Ftree%2Fcanary%2Fexamples%2Fwith-supabase&project-name=nextjs-with-supabase&repository-name=nextjs-with-supabase&demo-title=nextjs-with-supabase&demo-description=This+starter+configures+Supabase+Auth+to+use+cookies%2C+making+the+user%27s+session+available+throughout+the+entire+Next.js+app+-+Client+Components%2C+Server+Components%2C+Route+Handlers%2C+Server+Actions+and+Middleware.&demo-url=https%3A%2F%2Fdemo-nextjs-with-supabase.vercel.app%2F&external-id=https%3A%2F%2Fgithub.com%2Fvercel%2Fnext.js%2Ftree%2Fcanary%2Fexamples%2Fwith-supabase&demo-image=https%3A%2F%2Fdemo-nextjs-with-supabase.vercel.app%2Fopengraph-image.png)

The above will also clone the Starter kit to your GitHub, you can clone that locally and develop locally.

If you wish to just develop locally and not deploy to Vercel, [follow the steps below](#clone-and-run-locally).

## Clone and run locally

1. You'll first need a Supabase project which can be made [via the Supabase dashboard](https://database.new)

2. Create a Next.js app using the Supabase Starter template npx command

   ```bash
   npx create-next-app --example with-supabase with-supabase-app
   ```

   ```bash
   yarn create next-app --example with-supabase with-supabase-app
   ```

   ```bash
   pnpm create next-app --example with-supabase with-supabase-app
   ```

3. Use `cd` to change into the app's directory

   ```bash
   cd with-supabase-app
   ```

4. Rename `.env.example` to `.env.local` and update the following:

  ```env
  NEXT_PUBLIC_SUPABASE_URL=[INSERT SUPABASE PROJECT URL]
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=[INSERT SUPABASE PROJECT API PUBLISHABLE OR ANON KEY]
  ```
  > [!NOTE]
  > This example uses `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, which refers to Supabase's new **publishable** key format.
  > Both legacy **anon** keys and new **publishable** keys can be used with this variable name during the transition period. Supabase's dashboard may show `NEXT_PUBLIC_SUPABASE_ANON_KEY`; its value can be used in this example.
  > See the [full announcement](https://github.com/orgs/supabase/discussions/29260) for more information.

  Both `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` can be found in [your Supabase project's API settings](https://supabase.com/dashboard/project/_?showConnect=true)

5. You can now run the Next.js local development server:

   ```bash
   npm run dev
   ```

   The starter kit should now be running on [localhost:3000](http://localhost:3000/).

6. This template comes with the default shadcn/ui style initialized. If you instead want other ui.shadcn styles, delete `components.json` and [re-install shadcn/ui](https://ui.shadcn.com/docs/installation/next)

> Check out [the docs for Local Development](https://supabase.com/docs/guides/getting-started/local-development) to also run Supabase locally.

## Feedback and issues

Please file feedback and issues over on the [Supabase GitHub org](https://github.com/supabase/supabase/issues/new/choose).

## More Supabase examples

- [Next.js Subscription Payments Starter](https://github.com/vercel/nextjs-subscription-payments)
- [Cookie-based Auth and the Next.js 13 App Router (free course)](https://youtube.com/playlist?list=PL5S4mPUpp4OtMhpnp93EFSo42iQ40XjbF)
- [Supabase Auth and the Next.js App Router](https://github.com/supabase/supabase/tree/master/examples/auth/nextjs)
