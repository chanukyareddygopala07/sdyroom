# PR 15 — AI study planner

**Status:** specification only — no GitHub PR exists.
**Owner:** Dev A (OpenCode) · **Complexity:** Large · **Migration:** `0015_study_plans.sql`
**Depends on:** PR 16 (analytics aggregates are the planner's inputs — hard gate, ordered 16 → 15), PR 14 (weak-area metadata + the pattern this PR copies; roadmap lists 14 and 16), PR 12 (provider + retrieval)

---

### Problem

Students in exam-prep rooms have goals (`study_goals`), sessions
(`focus_sessions`), materials (`study_resources`) and now scores
(`quiz_attempts`) — but nothing turns that into a plan. Milestone's "AI study
planner" is unbuilt: there is no plan schema, no generation endpoint, no
schedule UI, no feedback loop that turns "I did 45 minutes" into "what's
next". The roadmap's own dependency note says the planner consumes analytics
aggregates, so it was deliberately sequenced last in the AI lane.

### User story

As a student, I tell the planner my exam date, daily available hours and
weak subjects; it proposes a day-by-day study plan grounded in my room's
documents and my actual recent performance, shows it as a checklist I can
follow, marks items done, and adjusts when I fall behind or finish early.

---

### Scope

- **Plan inputs**: exam date (`exam_track`-aware prompt text, not calendar
  integration), hours/day, target subjects/topics, preference for which room
  documents to base reading on; plus **measured signals from PR 16**
  (recent focus minutes, goal completion rate, quiz accuracy) and **weak areas
  from PR 14** (lowest-scoring difficulty/artifact metadata — not per-question
  text).
- **Generation**: `POST /api/rooms/[id]/plans` → grounded generation (PR 12
  `retrieve()` + PR 13 prompt discipline) producing a **structured plan**
  validated by a Zod schema: ordered blocks with `date`, `subject`, `task`,
  `estimated_minutes`, `kind` (`read|practice|review|mock|rest`), optional
  `resource_id` citation to an accessible document.
- **Plan storage** `study_plans` + `plan_items` (see Database) with status
  `generating|active|archived|failed` and per-item `done_at`.
- **Planner UI**: `/rooms/[id]/planner` (or personal `/planner` — decision
  below) with:
  - setup form (exam date, hours/day, topics, scope),
  - generated plan grouped by date with checkboxes, estimated minutes per day,
  - "today" focus view, progress (items done / total, minutes planned vs done),
  - **adjust**: "I missed today" (shift remaining), "mark all of today done",
    regenerate (new plan, old archived), archive.
- **Grounding rules in the prompt**: every `read` task must cite a document the
  user can access; the model may not invent resources; if retrieval finds
  nothing, reading tasks fall back to "review your notes on X" without a fake
  citation.
- **Honest failure**: `no_documents_indexed` still allows a plan **without**
  document citations (topic-based only) — decide: **allow, with a UI note**
  ("no indexed documents — tasks are topic-based"). This keeps the planner
  useful on day one; state the choice.
- **Adjustment logic is deterministic, not LLM**: shifting a plan, marking
  done, and recomputing progress are pure functions (`lib/planner/shift.ts`),
  unit-testable; the LLM is only used for initial generation and explicit
  "regenerate with these changes".
- **Cost**: rate limits (`plan:{roomId}:{userId}`) + `ai_usage` caps; one
  generation = one bounded `complete()` call with a token ceiling.

### Out of scope

- Calendar integrations (Google/Apple/Outlook), `.ics` export — note as a
  follow-up; a plain `text/csv` of the plan is allowed if cheap.
- Notifications/reminders for planned tasks (PR 11's `ai_task_complete` only
  on plan-ready; daily reminder scheduling is out — no daemon exists).
- Automatic re-planning by a background job (adjustment is user-driven).
- Multi-week horizon beyond what the schema supports (cap: plan length ≤
  90 days, validate exam date in `[today+1, today+180]`).
- Sharing a plan with the room / room-wide plans (v1 is personal).
- LLM-driven "understanding" of weak areas per topic (we aggregate from
  quiz difficulty/artifact metadata only).
- Video/YouTube recommendations, external content fetching (no URL fetch —
  same rule as PR 12).
- Study streaks as gamification, badges, leaderboards.
- Offline plan editing, CRDTs, multi-device conflict resolution (last write
  wins on `updated_at`).
- Editing arbitrary plan items into free-form text (in-place edit of a task's
  title is allowed; reordering beyond "shift" is out).

**Personal vs room scope decision:** plans are **personal** (a plan belongs to
a user, optionally linked to a room for document grounding). A room-linked plan
still only reads that room's accessible docs and only the creator sees it.
Justify in the PR: a shared room plan would create peer pressure around
personal schedules — out of scope by design.

---

### Frontend work

| File | Change |
| --- | --- |
| `app/(app)/planner/page.tsx` (new) | Personal planner home: current plan or setup form. `loading.tsx` + `error.tsx`. |
| `components/planner/plan-setup-form.tsx` (new) | Exam date (date input, min/max validated), hours/day (number, 1–12), topics (tag input), room scope select (optional), generate button + progress; errors `role="alert"`. |
| `components/planner/plan-view.tsx` (new) | Date-grouped list; per-item checkbox + kind badge + est. minutes + citation link; per-day totals; progress bar (`role="progressbar"`); "Today" section first. |
| `components/planner/plan-actions.tsx` (new) | Mark day done, shift remaining, regenerate, archive — each with confirm for destructive ones; undo affordance where cheap (optimistic + revert on failure). |
| `app/(app)/rooms/[id]/page.tsx` | Entry link "Study plan" for members. |
| `components/ai/ai-status.tsx` | Demo-mode + generating states reused. |

Accessibility: checkboxes are real inputs in a `<fieldset>` per day; day
headings are `<h3>`; progress announced; date groupings semantic; keyboard-only
operation of the whole flow verified.

### Backend work

| Route | Behavior |
| --- | --- |
| `POST /api/plans` | Authenticated (plans are personal; `room_id` optional and membership-checked if present). Body `{ exam_date, hours_per_day, topics[], room_id?, document_ids?, regenerate?: boolean }` → `201 { plan: { id, status: 'generating', href } }`. Errors: `400 validation`, `401`, `403 `room_not_member``, 404 (bad room), **409 `plan_already_active`** (unless `regenerate: true`), **403 `ai_quota_exceeded`**, **429 `rate_limited`**, **502 `ai_provider_failed`**, 500 `plan_failed`. |
| `POST /api/plans/[planId]/step` | Advances `generating → active` (provider call + schema validation + persist), idempotent when `active` → `200 { status, item_count?, error_code? }`. |
| `GET /api/plans?status=active` | Own plans → `{ plans: [...] }` (summary only). |
| `GET /api/plans/[planId]` | Own plan + items → full payload; foreign plan → `404` (indistinguishable). |
| `POST /api/plans/[planId]/items/[itemId]/done` | Body `{ done?: boolean }` (default true) → `{ item: { id, done_at }, plan: { progress } }`; idempotent. |
| `POST /api/plans/[planId]/shift` | Body `{ from_date, mode: 'shift_remaining' }` → `{ plan, moved: n }`; deterministic (no LLM). |
| `POST /api/plans/[planId]/complete-day` | Body `{ date }` → marks all items of that date done. |
| `POST /api/plans/[planId]/archive` | → `200 { archived: true }`. |
| `GET /api/plans/[planId].csv` | Own plan → CSV of date,kind,subject,task,est_minutes,done. |

Prompt/adjustment split is the design centre: see Security and DB notes.

### Database work

`supabase/migrations/0015_study_plans.sql`:

- `study_plans(id uuid pk, user_id uuid not null references auth.users on
  delete cascade, room_id uuid null references rooms on delete set null,
  status text check in ('generating','active','archived','failed') default
  'generating', error_code text, exam_date date not null, hours_per_day real
  not null, topics text[] not null default '{}', document_ids uuid[] not null
  default '{}', summary text, model text, prompt_tokens int,
  completion_tokens int, generated_at timestamptz, archived_at timestamptz,
  created_at timestamptz default now(), updated_at timestamptz not null
  default now())`.
  Partial unique: `create unique index study_plans_one_active on
  study_plans (user_id) where status = 'active';`
  Indexes: `(user_id, status, created_at desc)`.
- `plan_items(id uuid pk, plan_id uuid not null references study_plans on
  delete cascade, ordinal int not null, item_date date not null, subject text,
  task text not null, kind text check in ('read','practice','review','mock',
  'rest') not null, estimated_minutes int not null check (1..480),
  resource_id uuid null references study_resources on delete set null,
  citation jsonb null, done_at timestamptz null, created_at timestamptz default
  now(), unique(plan_id, ordinal))`.
  Indexes: `(plan_id, item_date, ordinal)`, partial `(plan_id) where done_at is null`.
- Grants (revoke-first):
  - `study_plans`: `SELECT`/`UPDATE` own rows with `user_id = auth.uid()`
    policies — **but** status transitions and shift go through RPCs to keep
    the partial-unique invariant intact; simplest coherent rule: grant `SELECT`
    + `UPDATE (done… no)` → **prefer: `SELECT` own, writes via RPC only**
    (consistent with 12/14). Choose RPC-only and document it.
  - `plan_items`: `SELECT` own (via `study_plans` join policy), `UPDATE
    (done_at)` via `mark_plan_item` RPC, `INSERT` via `generate_plan` RPC
    (batch payload), no `DELETE` grant (cascades from plan archive/delete only).
- RPCs (SECURITY DEFINER, `search_path = ''`, execute revoked from
  `public`/`anon`, granted to `authenticated`):
  - `generate_plan(p_user_id …, p_room_id, p_exam_date, p_hours, p_topics,
    p_document_ids, p_summary, p_items jsonb) returns uuid` — asserts
    `p_user_id = auth.uid()` (route never passes a foreign id), enforces the
    one-active-plan invariant (`on conflict` / explicit check → SQLSTATE
    `23505` mapped to `409 plan_already_active`), validates counts/dates
    (items within `[today, exam_date]`, ≤ 90 items… decide cap: **≤ 180 items /
    ≤ 90 days**), inserts plan + items atomically.
  - `mark_plan_item(p_item_id uuid, p_done boolean) returns jsonb` — resolves
    the plan, asserts owner, sets `done_at`, returns progress.
  - `shift_plan(p_plan_id uuid, p_from_date date) returns jsonb` — moves all
    **not-done** items with `item_date >= p_from_date` forward by the number of
    days they are already behind (computed from `today - min(undone date)`,
    floored at 0), clamped so nothing passes `exam_date` (items past exam date
    get flagged in the response rather than silently dropped). Pure SQL, no LLM.
  - `archive_plan(p_plan_id uuid)`.
  - `plan_stats(p_plan_id uuid) returns jsonb` — totals + progress for the UI.
- `updated_at` trigger on `study_plans`.

### Storage work

None.

### Realtime work

None.

### AI work

- Prompt `lib/ai/prompts/plan.ts`: inputs (exam date, hours/day, topics,
  measured signals as compact numbers, weak-area labels, retrieved doc
  summaries) → strict JSON plan schema; untrusted-source wrapping identical to
  PR 13; explicit instruction that `read` tasks reference only provided
  `document_ids`.
- Validation: Zod schema mirror on the server; per-item checks (dates within
  window, minutes ≤ 480 and ≤ hours/day × 60 total per day ± tolerance,
  `kind` enum, `resource_id` ∈ accessible set, citation stripping when the id
  is not in the retrieval set); failure → `502 ai_provider_failed` + status
  `failed`, never a partial `active` plan.
- Signals assembly from PR 16 (`analytics_me`) + PR 14 (weak areas): compact,
  numeric, no raw question text into the prompt (privacy + token cost).
- `complete()` token ceiling documented; on over-budget inputs, drop oldest
  retrieval chunks first and record what was used.

---

### Security requirements

A user must **not** be able to:

1. Generate a plan for another user (RPC asserts `p_user_id = auth.uid()`; the
   route does not accept a user id at all).
2. Read or mutate another user's plan/items (`404` parity; owner checks inside
   every RPC).
3. Reference a `room_id` they are not a member of, or `document_ids` outside
   their accessible set (validated in the route **and** re-checked in
   `generate_plan`).
4. Trigger unlimited generations (one-active invariant + rate limit +
   `ai_usage` cap).
5. Get unvalidated model JSON persisted as `active` (schema gate).
6. Learn another user's schedule through any aggregate or error.
7. Inject instructions via document content — same untrusted-source discipline,
   injection-seeded test (third occurrence of this test across 13/14/15; keep
   them consistent).
8. Mark items of a plan they do not own (RPC owner check; test a foreign
   `item_id`).

Positive guarantees:

- At most one `active` plan per user, enforced by a partial unique index, not
  just application code.
- Plan `read` tasks either cite an accessible document or carry no citation —
  never a fabricated one (validator strips/destroys the plan if violated,
  choosing `failed` over a lying plan).
- Deterministic operations (`shift`, `done`, `complete-day`) do not call the
  provider — assert no provider call in their unit tests.

### API contracts

```jsonc
// POST /api/plans   201
{ "plan": { "id", "status": "generating",
            "href": "/planner?plan=…" } }
// POST /api/plans/[planId]/step   200
{ "status": "active", "item_count": 42, "days": 21,
  "model": "…", "provider": "openai" }
// GET /api/plans/[planId]   200
{ "plan": { "id", "status", "exam_date", "hours_per_day", "topics",
            "summary", "created_at" },
  "items": [ { "id", "ordinal", "date", "subject", "task", "kind",
               "estimated_minutes", "resource_id", "citation",
               "done_at" } ],
  "progress": { "done": 5, "total": 42, "minutes_planned_today": 180,
                "minutes_done_today": 60 } }
// POST /api/plans/[planId]/items/[itemId]/done   200 → { item, progress }
// POST /api/plans/[planId]/shift   200 → { plan, moved: 12, past_exam_date: 0 }
// POST /api/plans/[planId]/complete-day   200 → { completed: 4, progress }
// POST /api/plans/[planId]/archive   200 → { archived: true }
```

| Error | Code |
| --- | --- |
| 400 | `validation` / `invalid_json` |
| 401 | `unauthenticated` |
| 403 | `not_owner`, `room_not_member`, `ai_quota_exceeded` |
| 404 | `not_found` |
| 409 | `plan_already_active` |
| 429 | `rate_limited` |
| 502 | `ai_provider_failed` |
| 500 | `plan_failed` / `item_failed` / `shift_failed` |

### Tests

**Unit**

- Plan schema validation: bad dates (past, beyond 180d), hours out of range,
  items outside window, per-day minutes overflow, unknown `kind`, fabricated
  `resource_id` stripped → `failed`.
- `lib/planner/shift.ts`: shift by 1/3/7 days, already-on-time (no-op),
  clamping at exam date, `past_exam_date` count, idempotence (shifting twice
  from the same date behaves per documented rule).
- Progress math: 0 done, all done, mixed, timezone of `item_date`.
- Route files: authz matrix, `plan_already_active` vs `regenerate`, foreign
  plan `404`, provider never invoked on shift/done/complete-day/archive,
  rate-limit/quota codes.
- Components: setup validation, plan view grouping, checkbox toggling with
  optimistic update + failure revert, empty/failed states, CSV link.
- Injection seed in a document → plan prompt keeps it inside source tags.

**Integration (`tests/integration/study-planner.test.ts`)**

- Generate (mock provider) → plan `active` with items matching counts; second
  generate → `409`; with `regenerate: true` → new plan, old `archived`.
- Direct PostgREST insert into `study_plans`/`plan_items` → permission denied;
  direct `update … set status` → denied.
- Foreign `item_id` mark-done → denied, row unchanged.
- `generate_plan` with another `p_user_id` → behaves as self (asserted) /
  refused — whichever the implementation states; the other user's plans
  unchanged.
- `room_id` of a non-member room → `403` before any provider call.
- Shift across a seeded date window → item dates move, unique/ordinal
  integrity preserved, nothing past exam date.
- Cascade: archive → items remain (archived plan readable); **delete plan**
  (if offered) → items gone. If no delete is offered, assert archive semantics.
- Quota/rate seeded → `403`/`429` with no provider call.

**E2E (`tests/e2e/study-planner.spec.ts`)** — mock provider:

- Setup → generate → plan renders grouped by date with today first → check an
  item → progress updates → reload persists → "mark day done" completes the
  group → "shift remaining" moves undone items and shows the count.
- Second generate without regenerate → clear 409 message.
- Plan with no indexed docs (seeded) → generates with the documented UI note.
- Non-logged-in / non-owner access to another plan id → 404.

### Dependencies

- **PR 16 (hard, per the roadmap's 16 → 15 ordering)** — planner consumes
  `analytics_me` signals. If 16 slips, 15 can start on schema/prompt work but
  must not merge without the signals wired (state in the PR).
- PR 12 (provider/retrieve), PR 13 (prompt discipline), PR 14 (weak-area
  metadata), PR 10 (rate limits/quota), PR 11 (optional `ai_task_complete` on
  plan ready).

### Files / modules likely affected

```
supabase/migrations/0015_study_plans.sql                 (new)
app/(app)/planner/page.tsx                               (new) + loading/error
app/api/plans/route.ts                                   (new)
app/api/plans/[planId]/route.ts                          (new)
app/api/plans/[planId]/step/route.ts                     (new)
app/api/plans/[planId]/items/[itemId]/done/route.ts      (new)
app/api/plans/[planId]/{shift,complete-day,archive}/route.ts (new)
app/api/plans/[planId]/route.ts?format=csv               (CSV variant — decide exact path)
components/planner/{plan-setup-form,plan-view,plan-actions}.tsx (new)
lib/ai/prompts/plan.ts                                  (new)
lib/planner/{shift,progress,validate}.ts                 (new)
lib/validation/planner.ts                                (new)
app/(app)/rooms/[id]/page.tsx                            (entry link)
tests/unit/... (new), tests/integration/study-planner.test.ts (new),
tests/e2e/study-planner.spec.ts (new)
docs/API_CONTRACTS.md, docs/SECURITY.md, docs/local-supabase.md,
docs/milestones.md, README.md
```

### Acceptance criteria

- [ ] A student generates a grounded plan; every `read` task cites an
      accessible document or none at all — fabricated citations impossible.
- [ ] One active plan per user is enforced by the database, not just the UI.
- [ ] Shift/done/complete-day are deterministic, work offline of the provider,
      and persist correctly.
- [ ] Non-owners get `404` on every plan operation; direct writes are denied.
- [ ] Injection-seeded document does not leak system prompt material.
- [ ] Quota/rate limits rejections use the documented codes and never call the
      provider.
- [ ] Plan signals from PR 16 are actually present in the prompt path
      (asserted by a unit test on the assembled prompt).
- [ ] All three suites + build green locally and in CI.

### Definition of Done

1. `npx supabase db reset` from scratch; partial-unique probe (second active
   insert fails with `23505`); RPC authz probes both directions.
2. Mock path green in CI; one real-provider generation recorded in the PR
   description (the plan, verbatim, so reviewers can sanity-check quality).
3. CI green on all three jobs.
4. `docs/API_CONTRACTS.md` planner sections; `docs/SECURITY.md` rows (foreign
   plan access, prompt discipline, fabricated-citation rule);
   `docs/local-supabase.md` tables/grants/RLS; `docs/milestones.md` planner
   status; README feature list.
5. Personal-scope decision and "topic-based fallback when nothing is indexed"
   documented in both UI copy and docs.
6. Reviewed by Dev B.

### Owner

**Dev A — OpenCode** (full-stack; the deterministic-adjustment split and
citation validation are the review focus).

### Estimated complexity

**Medium–Large.** Familiar patterns by this point in the roadmap (provider seam
from 12, prompt discipline from 13, artifact validation from 14, aggregates from
16) — the new hard parts are the one-active invariant, the shift logic, and
keeping deterministic operations provider-free.

### Risks

| Risk | Mitigation |
| --- | --- |
| Plan quality is poor (vague or impossible days) | Record a real generation in the PR; hard-validate per-day minutes; cap horizon; treat quality as a follow-up eval task (noted). |
| LLM output drifts from schema | Zod gate → `failed`, never partial `active`. |
| Shift logic corrupts a plan | Pure function + exhaustive unit tests + integration integrity asserts. |
| Two active plans race | Partial unique index; map `23505` → `409`. |
| Scope creep (calendar sync, notifications) | Out-of-scope list explicit; reject in review. |
| 16 slips and blocks this PR | PR can start schema/prompt work; merge gate stated in the PR description. |
