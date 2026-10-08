# SdyRoom PR roadmap

Working plan: what is already shipped, what is left, and the exact sequence of
pull requests that finishes the product. Every PR below has a PR-ready
implementation specification in [`docs/prs/`](prs/).

> **These are specifications, not GitHub pull requests.** Nothing in
> `docs/prs/` exists as a PR on the repository. As of this writing GitHub shows
> **9 PRs merged (01–09), 1 open (PR #10)**. A spec becomes a PR only when a
> developer creates a branch and opens one.

---

## 1. Audit: what the repository actually contains

Audited at `origin/main = 4880163` (merge of PR #5), working tree clean, no
open PRs, no issues, last CI run green.

### 1.1 Shipped and verified

| Area | Evidence |
| --- | --- |
| Next.js 16.3.8 + React 19 + TypeScript 5.9 + Tailwind CSS 4 (CSS-first config) | `package.json`, `postcss.config.mjs`, no `tailwind.config.*` |
| Supabase local stack, ports 54321/54322, `auto_expose_new_tables = false` | `supabase/config.toml` |
| Auth + anonymous restrictions (`proxy.ts` → `updateSession`) | `lib/supabase/proxy.ts`, `tests/unit/lib/supabase/proxy.test.ts` |
| Alias profiles, one-time onboarding, case-insensitive alias uniqueness | `0001_init.sql`, `app/api/profile/route.ts` |
| Public discovery + `?q=` search, private rooms, atomic `create_room` | `0001`, `app/api/rooms/route.ts` |
| Join / leave / capacity with row-lock seat check, closed-room refusal | `0002_room_membership.sql` |
| RLS on all 7 tables, 20 policies, all `TO authenticated`, column-scoped grants | verified against the live local DB |
| Focus sessions (state machine, owner-only `SECURITY DEFINER` RPCs), realtime delivery | `0003`, `tests/integration/focus-sessions.test.ts` (21) |
| Personal goals, trigger-owned timestamps, partial unique active title | `0003`, `study-goals.test.ts` (16) |
| Room chat, append-only (`SELECT`/`INSERT` only), `seq` cursor pagination | `0004`, `room-messages.test.ts` (18), `chat.spec.ts` |
| **Private notes / PDF sharing** — private bucket, magic-byte sniffing, signed URLs, uploader-only delete | `0005_study_resources.sql`, `app/api/resources/**`, `study-resources.test.ts` (22), `resources.spec.ts` (5) |
| CI: `quality` → `integration` → `e2e`, `permissions: contents: read`, **zero repository secrets**, Node 24 | `.github/workflows/ci.yml` |

**Test totals: 689 executed tests — 521 unit (41 files), 149 integration (10
files), 19 e2e (6 specs).** Migrations: `0001`–`0005`.

### 1.2 Confirmed NOT shipped (verified in code, not just in docs)

| Missing | Verification |
| --- | --- |
| Presence | `ChatParticipant` is a one-field proposal (`lib/chat/types.ts:38`); `room-chat.tsx` never passes `participants`; no `.track()` / presence usage anywhere. The UI section exists and is **hidden**, not built. |
| Invitations / private-room entry | No table, RPC, or route. `docs/milestones.md` "No member lists, invites or private-room joining". |
| Member roster | `room_members` grants `SELECT` + policy `room_members_select_own` only — a student can never see who else is in a room. |
| Room edit / close / delete / capacity change | No `app/api/rooms/[id]/route.ts`; `rooms` has **no UPDATE and no DELETE grant** (`0001_init.sql:124`). |
| Moderation (report / block / mute / remove / moderator) | No tables or routes; `0004` header: "Anything beyond that is moderation, which is out of scope here." |
| Rate limiting | `docs/SECURITY.md` "No rate limiting… adding one only for uploads would be inconsistent." |
| Orphaned-storage cleanup | `study_resources` rows cascade on user/room delete, **storage objects do not**; only the e2e teardown deletes them today. |
| Notifications | Zero matches for `notification` in `app/`, `lib/`, `components/`. |
| AI | No `@ai-sdk` / `openai` / `anthropic` / `replicate` dependency, no `vector` column, no embedding code. |
| Analytics / dashboard / streaks | Only seat-count aggregates exist. |
| Alias editing | `POST /api/profile` only; grants already allow `UPDATE (alias, exam_targets)`. |
| Responsive nav / mobile drawer | `site-shell.tsx` is a single non-wrapping flex row; no Sheet/Drawer/Dialog component in `components/ui/`. |
| Accessibility baseline | Auth-form errors have no `role="alert"` (4 files), auth pages render `CardTitle` (a `<div>`) instead of `<h1>`, `ThemeSwitcher` icon button has no accessible name, no skip link. |
| Coverage measurement | `@vitest/coverage-v8` not installed, no `coverage` script, CI does not gate on coverage. |
| Monitoring, error tracking, backups, load tests | Nothing in the repo. |

Also noted: `profiles.exam_targets` is written by schema and grants but **never
read or written by any TypeScript**; `components/ui/checkbox.tsx` is unused; no
`hooks/` directory despite `components.json` aliasing `@/hooks`; only 4 of the
`(app)` routes have `loading.tsx`/`error.tsx`; `docs/milestones.md` had marked
milestone I "in progress" although PR #5 merged (corrected in this status sync).

---

## 2. Product baseline (as requested, verified)

Every line in the "Completed foundation" list of the brief checks out against
the repository — **including room chat (PR #4, merged) and private notes/PDF
sharing (PR #5, merged)**. Test counts above are current, migration count is 5.

The one correction: *"GitHub Actions CI"* is correct but must be read as
**three serial jobs with no secrets**, which is why the AI PRs (§4) are the
first place a secret enters the project.

---

## 3. PR inventory

12 remaining PRs: 9 of the 13 requested (10–18 — 06, 07, 08 and 09 have
merged) plus 3 discovered during the audit (19–21). Each has a spec in
`docs/prs/`.

| PR | Feature | Spec | Owner | Depends on | Migration | Complexity | Status |
| -- | --- | --- | --- | --- | --- | -- | --- |
| 06 | Realtime room presence | [`PR-06`](prs/PR-06-room-presence.md) | A (OpenCode) | merged main | `0006` | Medium | Merged — [PR #6](https://github.com/chanukyareddygopala07/sdyroom/pull/6) (`91d2bed`) |
| 07 | Private room invitations + roster | [`PR-07`](prs/PR-07-private-invitations.md) | B (Cursor) | 06 | `0007` | Medium–Large | Merged — [PR #7](https://github.com/chanukyareddygopala07/sdyroom/pull/7) (`b4e1f33`) |
| 08 | Room management (edit / close / delete) | [`PR-08`](prs/PR-08-room-management.md) | A | 07 | `0008` | Medium | Merged — [PR #8](https://github.com/chanukyareddygopala07/sdyroom/pull/8) (`61a99a0`) |
| 09 | Moderation, reporting, blocking | [`PR-09`](prs/PR-09-moderation.md) | B | 07, chat | `0009` | Large | Merged — [PR #9](https://github.com/chanukyareddygopala07/sdyroom/pull/9) (`1be4633`) |
| 10 | File & upload security hardening | [`PR-10`](prs/PR-10-resource-security.md) | B | merged main (05) | `0010` | Medium–Large | In review — [PR #10](https://github.com/chanukyareddygopala07/sdyroom/pull/10) (`feat/resource-security`) |
| 11 | Notifications | [`PR-11`](prs/PR-11-notifications.md) | A | 07, 09, 19, 20 | `0011` | Medium | Pending |
| 12 | AI document processing foundation | [`PR-12`](prs/PR-12-ai-document-foundation.md) | B | merged main (05) | `0012` | Large | Pending |
| 13 | Ask My Notes | [`PR-13`](prs/PR-13-ask-my-notes.md) | B | 12 | none | Large | Pending |
| 14 | AI quizzes & flashcards | [`PR-14`](prs/PR-14-ai-quiz-flashcards.md) | A | 12 | `0013` | Large | Pending |
| 15 | AI personal study planner | [`PR-15`](prs/PR-15-ai-study-planner.md) | A | 14, 16 | `0015` | Large | Pending |
| 16 | Study analytics & accountability | [`PR-16`](prs/PR-16-study-analytics.md) | A | 14 | `0014` | Medium | Pending |
| 17 | Advanced public room discovery | [`PR-17`](prs/PR-17-room-discovery.md) | A | 06 | `0016` | Medium | Pending |
| 18 | Production security & reliability hardening | [`PR-18`](prs/PR-18-production-hardening.md) | B | 10, 19, 21 + core | `0017` (if needed) | XL | Pending |
| 19 | Responsive shell, mobile nav & accessibility baseline | [`PR-19`](prs/PR-19-responsive-shell-a11y.md) | A | none | none | Medium | Pending |
| 20 | Profile & settings (alias editing) | [`PR-20`](prs/PR-20-profile-settings.md) | B | none | none | Small | Pending |
| 21 | Quality & coverage baseline | [`PR-21`](prs/PR-21-quality-coverage-baseline.md) | B | none | none | Medium | Pending |

**Numbering note.** 06–18 follow the numbering requested in the brief; 19–21 are
the PRs discovered by the audit. Numbers are an ordering *label*, not an order —
the dependency graph below governs the real sequence.

**Migration-number rule.** Every migration number above is pre-assigned to exactly
one PR, so two developers can never write the same migration file. A migration
must be self-contained with respect to other PRs' migrations; where a real object
dependency exists, the graph already serializes those PRs.

---

## 4. Dependency graph

```
                        ┌─ PR 19 Responsive shell & a11y ────┐
                        ├─ PR 20 Profile & settings ─────────┤   no dependencies,
merged main (PR 01–05) ─┼─ PR 21 Quality & coverage ─────────┤   start immediately
                        │                                    │
                        ├─ PR 06 Presence                    │
                        │      ↓                             │
                        │   PR 07 Invitations + roster       │
                        │      ↓                             │
                        │   PR 08 Room management            │
                        │      ↓                             │
                        │   PR 09 Moderation                 │
                        │      ↓                             │
                        │   PR 11 Notifications  ← 19, 20 ───┤
                        │                                    │
                        ├─ PR 10 Resource hardening ─────────┤   parallel lane
                        │                                    │
                        ├─ PR 12 AI document foundation      │
                        │      ↓                             │
                        │   PR 13 Ask My Notes               │
                        │      ↓                             │
                        │   PR 14 Quizzes & flashcards       │
                        │      ↓                             │
                        │   PR 16 Analytics                  │
                        │      ↓                             │
                        │   PR 15 Study planner              │
                        │                                    │
                        └─ PR 17 Discovery ← 06 ─────────────┘

                    PR 18 Production hardening  (last; needs 10, 19, 21, and
                                                 the core lanes at 08 + 11)
```

### Deviations from the brief's example graph, and why

1. **16 (Analytics) before 15 (Planner).** The planner consumes "how have I been
   doing" aggregates. Building them in the analytics PR gives the planner a single
   shared `lib/analytics/queries.ts` instead of a second, divergent implementation.
2. **07 explicitly after 06.** Not a functional dependency — presence works
   without invitations — but both PRs edit `app/(app)/rooms/[id]/page.tsx` and
   `components/chat-panel.tsx`. Serializing them removes the conflict, and the
   alternation keeps both developers busy.
3. **11 depends on 19 and 20.** The notification bell needs a responsive nav
   (there is none today) and notification preferences need the settings page.
4. **19, 20, 21 added.** Discovered by the audit: the app has no mobile
   navigation and no accessibility baseline on the auth surface; alias editing is
   a documented gap with its grant already in place; and there is no coverage
   measurement anywhere in CI.

### Parallel lanes (two developers, one PR each at a time)

| Lane | Sequence | Owner(s) |
| --- | --- | --- |
| Foundations | 19 → 20 → 21 (any order, all independent) | A, B, B |
| Collaboration | 06 → 07 → 08 → 09 → 11 | A, B, A, B, A |
| Resources | 10 | B |
| AI | 12 → 13 → 14 → 16 → 15 | B, B, A, A, A |
| Discovery | 17 (after 06) | A |
| Launch | 18 | B |

At most two PRs are in flight at once without touching the same migration or
API file: one from the Collaboration lane and one from the Foundations/Resources
lane.

---

## 5. Ownership model

Two developers, **one owner per PR**, no shared files in flight.

- **Dev A — OpenCode** (full-stack, UI-leaning): 19, 06, 08, 11, 14, 16, 15, 17.
- **Dev B — Cursor** (backend/security-leaning): 20, 21, 07, 09, 10, 12, 13, 18.

Rules that make this work:

1. **One PR = one owner.** The other developer reviews; they do not push to the
   branch.
2. **Migration numbers are pre-assigned** (§3), so two branches can never
   propose the same `supabase/migrations/00xx_*.sql`.
3. **API route files are owned by the PR that creates them.** Editing an existing
   route in a PR you do not own means you have the wrong PR.
4. **Shared seams** (`tests/unit/helpers/fake-supabase.ts`,
   `tests/integration/helpers/api.ts`, `components/chat-panel.tsx`) are extended
   in the PR that needs them and never reformatted — the repository's existing
   test helpers rely on their exact shape.
5. **Sequence, not simultaneity, for the Collaboration lane.** If both developers
   would start the same lane, start Foundations + Resources instead.

---

## 6. Completion estimate

Weighted by product area, not by PR count. The weights are a judgement call;
the percentages are honest ranges rounded to 5.

| Product area | Weight | Completed | Remaining | Basis |
| --- | --: | --: | --: | --- |
| **Core platform** (auth, profiles, rooms, membership, focus, goals, chat, resources, CI) | 30% | **85%** | 15% | Everything runs and is tested; missing room lifecycle, alias editing, roster. |
| **Collaboration** (presence, invites, moderation, notifications) | 20% | **65%** | 35% | Presence, invitations and moderation all shipped (06/07/09); notifications are unbuilt. |
| **Resources** (private files, sharing, hardening, AI-readiness) | 15% | **70%** | 30% | Shipped, adversarially tested, and — with PR 10 in review — quota'd, rate-limited and self-cleaning; previews and AI ingestion remain. |
| **AI** | 15% | **0%** | 100% | No dependency, no schema, no endpoint. Specified, not built. |
| **Safety / security** | 10% | **75%** | 25% | RLS/grants/validation are genuinely strong, moderation shipped (PR 09) and rate limiting shipped (PR 10); CSP, backups and monitoring remain (PR 18). |
| **Production readiness** | 10% | **30%** | 70% | 1078 tests and 3 CI jobs; no coverage gate, monitoring, load tests or deployment. |

**Overall: ≈ 60% (roughly 57–62%).**

How to read it: the foundation is unusually solid for its size — the security
model and test discipline are ahead of schedule — but a large slice of what
makes SdyRoom a *product* (notifications, AI, launch readiness, the
mobile/a11y surface) has not started. Counting PRs says "9 of 21 merged";
that ratio mixes deep foundation PRs with shallow ones, so trust the weighted
table over the headcount.

---

## 7. Recommended order and the top 3 to start now

**Start now:**

1. **PR 19 — Responsive shell, mobile nav & a11y baseline** (Dev A).
   Nothing else is usable on a phone until this lands, and it unblocks the
   notification bell. No migration, no API, fast review.
2. **PR 20 / PR 21 — Profile & settings, Quality & coverage baseline** (Dev B,
   either order). Both independent, both small, and 21's coverage gate makes
   every later PR cheaper to trust.
3. **PR 11 — Notifications** (Dev A, after 19 + 20). The Collaboration lane is
   otherwise clear — 06 through 09 have merged — so this is the next
   product-facing PR once the nav it mounts in exists.

**PR 10 is in review** (`feat/resource-security`): rate limiting, quotas and
orphan cleanup close the two limitations the repo used to document about
itself; nothing else waits on it, but PR 12 should not start until it lands.

**Full recommended order:**

```
19 → 20 → 21 (Foundations, parallel with everything below)
11 (Collaboration — 06 → 07 → 08 → 09 already merged)
10 in review (Resources)
12 → 13 → 14 → 16 → 15 (AI)
17 (Discovery, after 06)
18 (Launch, last)
```

---

## 8. Answers to the standing questions

| Question | Answer |
| --- | --- |
| **How many PRs remain?** | **12** (10–21): 10 in review, 11 pending. |
| **Which can run in parallel?** | 19, 20, 21 (all three, any order); 11 follows once 19 + 20 land; 17 runs alongside 10–11 (06 already merged). |
| **Which block AI?** | **12** is the gate for everything AI. 13/14/16/15 sit behind it in order. Nothing in the Collaboration lane blocks AI — the AI track only needs merged `main` (PR 05) plus, for the planner, 14 and 16. |
| **Which block public launch?** | **18** (headers/CSP, monitoring, backups, load tests, a11y), **19** (mobile + a11y), **21** (coverage gate). 10 (rate limiting + orphan cleanup) and 09 (moderation) have landed, so the launch blockers are the PR 18 cluster plus the foundations; 06/07/08/11 are product-complete-ness, not launch-safety; 12–17 are post-launch-eligible. |
| **Missing work found in the audit** | Member roster (folded into 07), responsive navigation + accessibility baseline (19), alias editing (20), coverage & untested auth flows (21), orphaned storage objects on user/room deletion (folded into 10), unused `profiles.exam_targets` column (20), `milestones.md` marking milestone I in progress (housekeeping was assigned to 21; corrected in this status sync). |

---

## 9. How to use this

1. Pick the next PR in your lane.
2. Copy `docs/prs/PR-xx-*.md` into the branch description.
3. Build exactly to the **Scope** and **Out of scope** sections; if something new
   appears, it becomes a new spec, not a scope creep in this one.
4. The PR is mergeable only when every checkbox in its **Definition of Done**
   is ticked and CI is green.
5. Tick the row in §3 of this file to `Merged` and record the merge commit.
