# PR 16 — Study analytics (personal + room insights)

**Status:** specification only — no GitHub PR exists.
**Owner:** Dev A (OpenCode) · **Complexity:** Medium · **Migration:** `0014_analytics_views.sql`
**Depends on:** PR 14 (`quiz_attempts` is a primary input — hard gate), PR 12 (session/ingest ledgers exist); soft: 15 consumes these aggregates afterwards

---

### Problem

The data that would tell a student whether they are actually studying is
already being written and never read: `focus_sessions` accumulate durations,
`study_goals` accumulate completions, `study_resources` accumulates uploads,
and (after PR 14) `quiz_attempts` accumulates scores — but no endpoint, page,
chart or summary in `app/` or `components/` computes any of it.
`docs/milestones.md` has no analytics milestone at all, which is itself the
finding: **the roadmap does not currently plan the screen that makes all this
tracked data useful**, and PR 15's planner would be flying blind without it.

### User story

As a student I can see, at a glance, my study minutes this week versus last,
my goal completion rate, my quiz accuracy trend and what is due next; as a room
owner I see the same aggregate for my room (never anyone's private chat or
documents) — and I can act on it with one click into the relevant list.

---

### Scope

- **`GET /api/analytics/me`**: time-series + summary for the caller:
  - focus minutes per day for the last 7/30 days (from `focus_sessions`),
  - goals completed vs created (from `study_goals`),
  - quiz accuracy: correct/total per day, best/worst subject-ish proxy via
    artifact difficulty (from `quiz_attempts`),
  - flashcards due today and reviewed today (`flashcard_reviews`),
  - uploads count/bytes (`study_resources`).
  Query params: `?range=7d|30d|90d`.
- **`GET /api/analytics/rooms/[id]`**: room-owner/aggregate view — total
  focus minutes, active members (members with ≥1 session in range), goal
  completion rate, quiz participation, upload counts. **Aggregates only**: no
  per-member breakdown beyond "top N by minutes" (decide: **v1 shows totals +
  active-member count only**; per-member leaderboards are explicitly out of
  scope — see Out of scope).
- **Aggregation in the database**: SQL views or RPCs
  (`analytics_daily_focus(p_user_id, p_days)` etc.), **not** N+1 queries in
  Node. One round trip per panel; views are `security_invoker = true` or RPCs
  are SECURITY DEFINER with the caller's identity — pick RPCs for consistency
  with the repo's direction (and because views' RLS semantics have bitten this
  codebase's reviewers before — state the choice).
- **UI**: `/app/analytics` (personal, `(app)` group) with a summary strip,
  a bar/line chart of daily minutes, goal ring, quiz accuracy trend, due
  cards; and a room-scoped panel mounted at `/rooms/[id]/analytics` (or a tab
  in the room) for owners/moderators.
- **Charts**: no charting dependency currently exists — implement with
  **inline SVG** (accessible, zero deps, matches "no unnecessary dependency"
  posture) or adopt one small library — **decision required, standing question**;
  whichever is chosen must ship with `<title>`/`<desc>` and a text-table
  fallback for screen readers.
- **Empty/honest states**: "No sessions yet — start a focus timer",
  zero-range data, and a visible note that ranges are calendar-day local time
  (document the timezone rule).
- **Export (light)**: `GET /api/analytics/me.csv` — the caller's own daily
  series as CSV. Cheap, useful for students who keep their own trackers.

### Out of scope

- **Per-member leaderboards / "who studied the most" in a room.** Social
  comparison is a product decision with real harm potential (especially for
  minors in shared exam-prep rooms); if pursued later it needs its own PR with
  opt-in. Explicitly rejected here.
- Any breakdown that reveals what a member *said*, *uploaded* or *asked* —
  room analytics never surface content, only counts and minutes.
- Predictions, "expected score", ML on user data.
- Correlation of attendance with exam outcomes (we do not know exam outcomes).
- Real-time/live dashboards, websocket-driven chart updates.
- Admin/platform analytics (no admin role exists).
- Heatmaps, calendars, streak mechanics as a *feature* (a plain
  "days studied in a row" counter is allowed as a stat, not as gamified UI).
- PDF/report generation, scheduled email reports.
- Historical data before this PR ships (no backfill job; ranges simply show
  what exists).
- Cost/revenue/usage dashboards (the `ai_usage` ledger is available but is an
  ops concern, not a student feature).

---

### Frontend work

| File | Change |
| --- | --- |
| `app/(app)/analytics/page.tsx` (new) | Personal analytics; server page with gates; `loading.tsx` + `error.tsx`. |
| `components/analytics/summary-strip.tsx` (new) | 4 stat cards: focus minutes (range), goals completed, quiz accuracy, cards due. |
| `components/analytics/focus-chart.tsx` (new) | SVG bar chart, daily minutes, keyboard-focusable bars with tooltips (`role="img"` + `<title>`/`<desc>`, plus an adjacent visually-hidden table). |
| `components/analytics/accuracy-chart.tsx` (new) | SVG line/bar of daily accuracy with correct/total labels. |
| `components/analytics/goal-ring.tsx` (new) | Completed vs created ratio, accessible progress semantics (`role="progressbar"` with valuemin/max/now). |
| `app/(app)/rooms/[id]/analytics/page.tsx` (new) | Room aggregates; owner/moderator only (`notFound()` for others, same as settings). |
| `components/analytics/room-stats.tsx` (new) | Totals + active members + completion rate + participation. |
| `components/analytics/data-table.tsx` (new) | The text-table fallback rendered alongside every chart (duplicated in a `<details>` so sighted users are not burdened). |
| Nav: shell entry for "Analytics" | Coordinate with PR 19 (mobile nav) and PR 11 (bell) — one insertion point. |
| CSV download button | Plain `<a href="/api/analytics/me.csv" download>` — no JS needed. |

Accessibility (hard requirements): every chart has a title/desc and a
text-table equivalent; colour is never the only encoding; range switcher is a
tablist or select with visible focus; `prefers-reduced-motion` respected if any
transition is used.

### Backend work

| Route | Behavior |
| --- | --- |
| `GET /api/analytics/me?range=7d\|30d\|90d` | Own data only → `{ range, days: [{ date, focus_minutes, goals_completed, quizzes_taken, cards_reviewed, uploads }], summary: {...} }`. |
| `GET /api/analytics/rooms/[id]?range=` | Owner/moderator only (membership check + role) → `{ range, summary: { focus_minutes_total, active_members, goals_created, goals_completed, quiz_attempts, quiz_correct, uploads }, days: [...] }`. **No member-identifying rows.** |
| `GET /api/analytics/me.csv` | Own daily series → `text/csv` with `Content-Disposition: attachment`; rows identical to `/me`'s `days`. |

Implementation rules:

- One RPC per panel; the route composes at most 2–3 calls.
- Ranges map to inclusive day counts computed in SQL with the caller's
  timezone documented (`(now() at time zone 'utc')::date` — pick UTC and say so;
  local-time conversion is a standing question).
- `404` parity on the room route for non-members **and** for non-owners
  (indistinguishable).
- Errors: `400 validation` (bad range), `401`, `404`, `500 analytics_failed`.

### Database work

`supabase/migrations/0014_analytics_views.sql`:

- RPCs (SECURITY DEFINER, `search_path = ''`, execute revoked from
  `public`/`anon`, granted to `authenticated`) — one per panel:
  - `analytics_me(p_user_id uuid, p_days int)` — internally asserts
    `p_user_id = auth.uid()` (so the API cannot be pointed at anyone else even
    by mistake) and returns a single jsonb/record of the daily series.
  - `analytics_room(p_room_id uuid, p_days int)` — asserts the caller is the
    owner or a `room_moderators` row of that room, aggregates from
    `focus_sessions`, `study_goals`, `quiz_attempts` (joined through
    `study_artifacts` for room scope), `flashcard_reviews`, `study_resources`.
    Must **never** return arrays keyed by `user_id`.
- Indexes to support the aggregations (add only if missing — check first):
  - `focus_sessions(user_id, started_at)`, `focus_sessions(room_id, started_at)`,
  - `study_goals(user_id, status, due_date)` (partial index on active if useful),
  - `quiz_attempts(user_id, created_at)`,
  - `flashcard_reviews(user_id, next_review_at)` (from `0013`).
- No new tables. No grants on base tables change — **the RPCs only `select`**,
  so the existing row-level grants are untouched (a deliberate constraint: this
  PR must not widen any privilege to add a chart).
- If views are chosen instead of RPCs: `create view ... with (security_invoker
  = true)` and document that choice in the migration header; note the
  integration test must still assert non-member visibility is zero.

### Storage work

None.

### Realtime work

None — analytics are read-on-load with `router.refresh()` on range change.

### AI work

None. (PR 15 consumes these aggregates; this PR only measures.)

---

### Security requirements

A user must **not** be able to:

1. Read another user's personal series — `analytics_me` asserts
   `p_user_id = auth.uid()` internally; there is no parameter to abuse.
2. Read a room's aggregates without being its owner/moderator — non-members
   and plain members get `404`.
3. Receive per-member rows, content, aliases-with-minutes, or anything that
   re-identifies an individual's behaviour inside a room aggregate (assert the
   response shape in tests: no key contains a user id or alias).
4. Distinguish "room exists but I'm not the owner" from "no such room"
   (indistinguishable `404`).
5. Export another user's CSV.
6. Learn private-room existence through analytics (same 404 rule).

Positive guarantees:

- Room analytics contain counts and minutes only — never chat text, file
  titles, question text, or aliases.
- The CSV contains only the caller's own rows.
- Every privilege check is inside the RPC, not only in the route (so a future
  route refactor cannot open a hole).

### API contracts

```jsonc
// GET /api/analytics/me?range=7d
{ "range": "7d",
  "days": [ { "date": "2026-10-01", "focus_minutes": 45,
              "goals_completed": 2, "quizzes_taken": 1,
              "cards_reviewed": 12, "uploads": 3 } ],
  "summary": { "focus_minutes": 312, "goals_completed": 9, "goals_created": 14,
               "quiz_correct": 38, "quiz_total": 50, "accuracy": 0.76,
               "cards_due": 24, "uploads": 11 } }
// GET /api/analytics/rooms/[id]?range=30d
{ "range": "30d",
  "summary": { "focus_minutes_total": 4210, "active_members": 7,
               "goals_created": 40, "goals_completed": 26,
               "quiz_attempts": 61, "quiz_correct": 44, "uploads": 88 },
  "days": [ { "date", "focus_minutes", "active_members", "quiz_attempts" } ] }
// GET /api/analytics/me.csv   text/csv
// date,focus_minutes,goals_completed,quizzes_taken,cards_reviewed,uploads
```

| Error | Code |
| --- | --- |
| 400 | `validation` (bad/missing `range`) |
| 401 | `unauthenticated` |
| 404 | `not_found` |
| 500 | `analytics_failed` |

### Tests

**Unit**

- Range parsing (7d/30d/90d valid; `1y`, `0`, unknown → `400`).
- Route files: `/me` cannot be pointed at another user (ignored/overridden
  param → own data), room route owner/moderator/member/non-member matrix,
  response shape has no user-identifying keys in the room payload (a small
  recursive key scan), CSV content-type/disposition/row count.
- Chart components: render with empty data, single day, max data; `role="img"`
  + `<title>`/`<desc>` present; text table matches series length; goal ring
  clamps 0–100%.
- Timezone rule unit: a session at 23:30 UTC lands on the documented date.

**Integration (`tests/integration/analytics.test.ts`)**

- Seed sessions/goals/attempts across two users and two rooms →
  `analytics_me` returns only the caller's numbers (numbers match a manual
  SQL count in the test).
- `analytics_me` with another `p_user_id` → behaves as self (asserted), never
  the other user's data.
- `analytics_room`: owner sees aggregates; moderator sees them; plain member →
  denied; non-member → denied; response contains **no** user ids or aliases
  (assert).
- Direct `select from analytics_*` if views are chosen → non-member sees zero
  rows (or `permission denied` for RPC-only design).
- Negative: a user with zero data gets zeros, not `500` (no null derefs).
- CSV export matches `/me` for the same range (row-for-row equality).

**E2E (`tests/e2e/analytics.spec.ts`)**

- User with seeded data (the test seeds via SQL/API) opens `/analytics` →
  summary strip shows non-zero values; chart renders with the text table
  available; range switch to `30d` changes the numbers.
- Empty user → honest empty states, no crash.
- Room owner opens `/rooms/[id]/analytics`; a plain member navigating there
  gets 404.
- CSV link downloads something whose first line is the header.

### Dependencies

- PR 14 (hard — without `quiz_attempts` the accuracy panel is empty and the
  migration would reference nothing).
- PR 19 / PR 11 for nav placement (soft).
- **PR 15 consumes these RPCs** — keep the signatures stable and documented in
  `docs/API_CONTRACTS.md` as an internal contract for the planner.

### Files / modules likely affected

```
supabase/migrations/0014_analytics_views.sql              (new)
app/api/analytics/me/route.ts                            (new)
app/api/analytics/me.csv/route.ts  → app/api/analytics/me/route.ts?format=csv (new)
app/api/analytics/rooms/[id]/route.ts                    (new)
app/(app)/analytics/page.tsx                             (new) + loading/error
app/(app)/rooms/[id]/analytics/page.tsx                  (new) + loading/error
components/analytics/{summary-strip,focus-chart,accuracy-chart,goal-ring,
  room-stats,data-table}.tsx                             (new)
lib/analytics/{queries,range,csv}.ts                     (new)
lib/validation/analytics.ts                              (new)
app/(app)/layout.tsx                                     (nav entry; PR 19 handoff)
tests/unit/..., tests/integration/analytics.test.ts (new), tests/e2e/analytics.spec.ts (new)
docs/API_CONTRACTS.md, docs/SECURITY.md, docs/local-supabase.md,
docs/milestones.md (new milestone — see DoD), README.md
```

### Acceptance criteria

- [ ] Personal analytics show correct numbers for a seeded dataset (verified
      against an independent SQL count in the integration test).
- [ ] Room analytics are aggregates only — no member-identifying data in any
      payload (asserted).
- [ ] Non-owners and non-members get indistinguishable `404`s.
- [ ] `analytics_me` cannot be coerced into returning another user's data
      even with an attacker-supplied `p_user_id`.
- [ ] Every chart ships a text-table equivalent and proper ARIA.
- [ ] CSV export equals the JSON series.
- [ ] No new privileges granted to any base table (diff of grants in the
      migration is empty by construction — verify).
- [ ] All three suites + build green locally and in CI.

### Definition of Done

1. `npx supabase db reset` from scratch; RPC probes pass both directions;
   index additions justified in the migration header.
2. CI green on all three jobs.
3. `docs/API_CONTRACTS.md` analytics sections marked **internal contract for
   PR 15**; `docs/SECURITY.md` row for aggregate privacy; `docs/local-supabase.md`
   tables/indexes; `docs/milestones.md` gains a milestone entry for analytics
   (this is new planning surface, not just a status flip).
4. Charting approach (inline SVG vs library) decided and stated in the PR
   description with the accessibility rationale.
5. Reviewed by Dev B.

### Owner

**Dev A — OpenCode** (full-stack; SQL aggregation + accessibility are the
review focus).

### Estimated complexity

**Medium.** No migrations of existing behaviour, no realtime, no AI — the work
is aggregation SQL, careful authz inside RPCs, and charts that are honest about
accessibility.

### Risks

| Risk | Mitigation |
| --- | --- |
| Aggregations leak identity in a small room (1 member ⇒ trivially de-anonymised) | Totals only, minimum-threshold note in docs (e.g. suppress member-count breakdown under 3 members — decide and document). |
| N+1 queries / heavy scans in the route | All aggregation in SQL RPCs; indexes checked; one round trip per panel. |
| Chart library bloat or inaccessible charts | Prefer inline SVG + text table; require ARIA in review. |
| Timezone confusion (per-day series wrong) | One documented rule (UTC), unit test on the boundary. |
| `p_user_id` trust mistake | RPC asserts self; test with a foreign id. |
| Scope creep into leaderboards | Explicitly rejected in Out of scope; push back in review. |
