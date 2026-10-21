# Local manual testing

Hands-on pass for SdyRoom running entirely on this Mac: Next.js dev server +
local Supabase in Docker. No cloud, no deploy, no production data. For gates
and scripts see [`docs/DEVELOPMENT.md`](DEVELOPMENT.md); this file is only the
browser checklist.

## Before you start

```bash
npx supabase start      # if the stack is not already up (Docker/OrbStack)
npm run dev             # http://localhost:3000
```

- **Stack**: Studio <http://127.0.0.1:54323> · API <http://127.0.0.1:54321> ·
  local mail UI (Mailpit) <http://127.0.0.1:54324>.
- **Sign-ups are auto-confirmed locally.** `supabase/config.toml` sets
  `enable_confirmations = false`, so sign-up returns a session right away
  and routes to onboarding — there is no confirmation email to open.
  Mailpit (above) still catches the email flows that do send locally, such
  as the password-reset link from `/auth/forgot-password`.
- **AI runs in demo/mock mode** (no `AI_API_KEY`): a banner says so, answers
  are canned, indexing uses local test vectors. That is expected, not a bug.
- **Seed is intentionally empty** — every account and room you see is one you
  created through the UI. Nothing is fabricated behind your back.

## Two-account features

Use two identities at once: a normal browser window for account A and a
private/incognito window (or a second browser profile) for account B. Invite
B to a room by B's study alias, accept from the inbox, and keep both windows
open for chat, presence, moderation and invitation tests.

## Checklist

- [ ] **1. Landing page and navigation** — `/` loads; nav links work; layout
      reflows at a phone viewport (DevTools device toolbar).
- [ ] **2. Sign-up, login, logout, onboarding** — sign up A (auto-confirmed
      locally — no email to open), log out, log back in; onboarding collects
      profile basics.
      Expired/absent session on a protected URL lands on `/auth/login`.
- [ ] **3. Profile and settings** — change alias (check the header updates and
      a room-mate's roster reflects it), language, exam targets; values
      survive a reload.
- [ ] **4. Discovery** — after login, "Public rooms" lists visible rooms;
      search and filters update the URL; a private room never appears for
      someone who is not a member.
- [ ] **5. Rooms: create / join / leave / capacity** — create a room (set
      capacity 2), join with B until it is full, confirm the third account is
      refused with the documented message; leaving removes roster/chat access.
- [ ] **6. Private rooms and invitations** — create a private room, invite B
      by alias, accept from B's inbox; a stranger gets the same "not found"
      as a missing room (never a "forbidden" that confirms existence).
- [ ] **7. Chat and history recovery** — A and B exchange messages live;
      reload mid-conversation (no duplicates, order kept); with B offline,
      A sends several, B reconnects and sees them **without** reloading
      (join-ack reconciliation); the connection badge shows Live /
      Reconnecting honestly.
- [ ] **8. Roster and presence** — both windows show each other; a focus
      session marks members "studying"; removal (by a moderator) drops the
      removed member's roster, chat and presence.
- [ ] **9. Goals, focus, analytics** — set a goal, run a focus session past a
      few minutes, check the analytics dashboard (streaks, accuracy, room
      counts) and a CSV download.
- [ ] **10. Resources** — upload a PDF in a room, see it index (demo-mode
      banner), download via the signed URL; another user's open/delete is
      refused; a non-member cannot fetch it.
- [ ] **11. Notifications** — B's bell lights on an invite without a reload;
      inbox, mark-read, mark-all, and preferences actually suppress the
      producer write (no badge, no row). Retention is scheduled in the
      database (pg_cron, daily 03:17 UTC) — inspect it in Studio if curious;
      do not hand-prune anything you care about.
- [ ] **12. AI features (mock)** — Ask My Notes answers with citations from
      the indexed document; generate a quiz and take it (server-scored);
      generate flashcards and flip through a session; generate a study plan
      (topic-only and document-grounded), tick items, shift days. All canned
      but fully functional — the demo banner stays visible.
- [ ] **13. Moderation** — B reports A's message; A's inbox shows it with no
      reporter identity; A resolves it; B sees the resolution notification.
      Moderator powers (mute, remove) work; a plain member's attempt is
      refused.
- [ ] **14. Accessibility and mobile** — keyboard-only: tab order, focus
      visible, "Skip to main content" works; screens at a phone viewport
      (chat, planner, analytics) remain usable.
- [ ] **15. Error and unauthorized states** — logged-out API calls return the
      documented `{ "error": { code, message, request_id } }` envelope; a
      tampered URL (another user's notification id, a missing room) returns
      `404`, not a leaky `403`; with no AI key the demo banner explains the
      mock provider (the loud `502 ai_provider_failed` path needs a
      misconfigured real provider — that belongs to staging, see
      [`docs/STAGING.md`](STAGING.md)).

## What local cannot verify

| Area | Why | Where it belongs |
| --- | --- | --- |
| Vercel platform behaviour (previews, `VERCEL_URL`, log stream, rollbacks) | Nothing is deployed | Staging/production |
| Hosted Supabase backups, PITR, project pausing | Local Docker has none of these | Staging/production drill |
| Real AI provider keys, quotas, real embedding quality | Mock mode on purpose | Staging, with a server-side key |
| Email deliverability beyond Mailpit | Mailpit is a local sink | Production |
| Platform rate limiting and cold starts | No platform in the loop | Staging |

## After the session

The dev server and the Supabase stack are left running. To restart later:

```bash
npx supabase start     # only if the stack is down
npm run dev            # http://localhost:3000
```
