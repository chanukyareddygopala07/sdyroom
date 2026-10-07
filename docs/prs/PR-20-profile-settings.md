# PR 20 — Profile and settings (alias, exam targets, language, notification prefs)

**Status:** specification only — no GitHub PR exists.
**Owner:** Dev B (Cursor) · **Complexity:** Small · **Migration:** none (widens nothing; `profiles` grants already exist)
**Depends on:** nothing to start (parallel lane); soft: PR 19 (settings page layout/slot), PR 11 (notification preference schema to surface)

---

### Problem

`profiles` is written at first login (`0001_init.sql`) and then frozen. The
`exam_targets` column exists on the table but **no TypeScript code reads or
writes it**, and nothing in `app/` or `components/` lets a student change
anything: not their study alias, not their exam targets, not their preferred
language — the three pieces of data the product actually uses to shape rooms,
chat defaults and (later) the planner. There is no settings page at all; the
only self-service surface is sign-out. Meanwhile PR 11's notification
preferences need somewhere to live in the UI, and PR 19's shell needs a
profile menu destination.

### User story

As a student, I open Settings to update my study alias (what classmates see in
the roster), my exam targets (NEET/JEE/UPSC…), my preferred language, and my
notification preferences — and I can confirm my account email and sign out from
the same place, with each change persisting and reflecting immediately.

---

### Scope

- **`/settings` page** (`(app)` group, authenticated): sections for Profile,
  Exam targets, Language, Notifications, Account — server-rendered with
  client forms following the repo's existing pattern (client validation → API →
  `router.refresh()` + `role="status"` confirmation).
- **Alias edit**: 1–40 chars, trimmed, same character rules as room names
  (no control chars); uniqueness is **not** enforced (aliases are display
  names; document that two students can share one — the roster shows role and
  join date to disambiguate; a uniqueness feature is a standing question).
- **Exam targets**: multi-select over the closed set used by rooms
  (`exam_track` vocabulary — read it from one shared constant so settings and
  room creation cannot diverge), 0–3 selections.
- **Preferred language**: single select from the shared `language` vocabulary
  (or free text ≤40 matching the room `language` column rules — **choose the
  closed list**, it keeps later filtering coherent).
- **Notification preferences**: the per-type controls PR 11 defines
  (`invite`, `moderation`, `ai`, `resource` → `all | mentions_and_invites |
  none`), submitted through the profile/notification-prefs endpoint 11 shipped;
  if 11 has not merged, this PR lands its own `PATCH` and 11 consumes it —
  **prefer consuming 11's endpoint** and state the choice.
- **Account section**: read-only email (from the session/user record), created
  date, sign-out button (client sign-out + redirect to `/sign-in`), and a link
  to Supabase Auth's own email-change flow if configured (document: we do not
  build email change/password reset ourselves — auth emails are Supabase's).
- **Session read path**: `GET /api/profile` (or reuse an existing session/user
  endpoint if one exists — check first) returning `{ alias, exam_targets,
  language, notification_prefs, email, created_at }`.
- **Immediate reflection**: after save, roster/header display of the alias
  updates without a full reload (`router.refresh()` is enough — no realtime).
- **Empty/saved/error states** on every form; `role="status"` on success,
  `role="alert"` on failure; disabled-while-pending on submit buttons.

### Out of scope

- Avatar/photo upload (touches storage policies and is its own PR — standing
  question).
- Email address change, password change, password reset, account deletion,
  data export (Supabase Auth owns the first three; deletion/export are legal
  features needing their own design — note as follow-ups).
- OAuth/social login management, MFA enrolment UI (Supabase console today).
- Public profile pages, "view other students' profiles" (roster is the only
  identity surface; no profile browsing).
- Forcing alias uniqueness or reserving aliases (see standing question).
- Onboarding flow/wizard for first-time users (settings is the manual
  equivalent; a guided onboarding is a separate product PR).
- Editing rooms' data, or per-room notification overrides.
- Locale formatting (dates/numbers stay in the app's existing format).
- Notification preference **routing** beyond PR 11's types (no per-room
  overrides, no quiet hours).
- Storing anything new in the database beyond the columns already present
  (this PR must not add columns).

---

### Frontend work

| File | Change |
| --- | --- |
| `app/(app)/settings/page.tsx` (new) | Server page, loads profile, renders sections; `loading.tsx` + `error.tsx` (parity rule for `(app)` routes). |
| `components/settings/profile-form.tsx` (new) | Alias text input + exam-target multi-select + language select in one form (single PATCH, one success state) **or** three forms — choose one submit per section for clearer errors; recommended: profile (alias) and preferences (targets+language) as separate forms. |
| `components/settings/notification-form.tsx` (new) | Per-type selects from PR 11's enum; disabled + explanatory text if PR 11 has not merged yet. |
| `components/settings/account-section.tsx` (new) | Read-only email + created date + sign-out + auth-flow note. |
| `components/settings/settings-nav.tsx` (new) | In-page section nav (anchor links with visible focus) — only if the page is long enough to need it; otherwise headings suffice. |
| Header/profile menu | Profile menu (from PR 19's shell) gains a "Settings" item linking here; if 19 has not merged, add the link wherever the current user affordance lives and hand off. |
| Shared constants | `lib/vocab/exam-tracks.ts` + `lib/vocab/languages.ts` (new) — single source used by room creation **and** settings; refactor `room-create-form` to import them (small, justified non-settings edit). |

Accessibility: every field has a `<label for>`; multi-select is a group of
checkboxes with a `<fieldset><legend>` (not a bare multi-select); error/success
announcements wired per PR 19's rules; submit buttons disabled+labelled while
pending.

### Backend work

| Route | Behavior |
| --- | --- |
| `GET /api/profile` | Own profile → `{ profile: { alias, exam_targets, language, notification_prefs, email, created_at } }`. If an equivalent session/user route already exists, extend it instead of adding a second one (check `app/api/` first — the repo may already expose the current user). |
| `PATCH /api/profile` | Strict body, partial: `{ alias?, exam_targets?, language? }`. Unknown fields → `400`. Empty body → `400 invalid_request` (goal-PATCH rule). → `200 { profile }`. Never accepts `id`, `user_id`, `email`, `created_at`, `updated_at`. |
| `PATCH /api/profile/notification-prefs` | Consume PR 11's endpoint if it exists; otherwise define it here with 11's exact body shape and flag the handoff in the PR description. |

Implementation notes:

- Row must exist: upsert-on-first-write is already how `profiles` is created —
  mirror that behaviour (if the row is missing, insert it with defaults rather
  than 500; document which path applies).
- Alias change affects read models immediately via `router.refresh()`; nothing
  denormalises the alias (roster and chat read `profiles.alias` live — verify
  with a test that a changed alias shows in the room roster after refresh).
- Rate limit profile PATCH with PR 10's shared mechanism
  (`profile:{userId}`) — cheap protection against a client loop.
- Validation lives in `lib/validation/profile.ts` (zod), shared between client
  and server, mirroring the repo's existing validation pattern.

### Database work

**No new migration.** The columns exist (`0001_init.sql`: `profiles` with
`exam_targets`; language/alias fields present or equivalent — **verify exact
column names against the schema before coding**, and if `language` is not a
column on `profiles`, that is a standing question to resolve: either reuse an
existing field or raise a tiny migration `0017_profile_fields.sql` **in this
PR** with the usual revoke-first grant discipline. State the outcome in the
PR description; do not silently invent columns).

- Grants/policies: `profiles` already grants `SELECT`/`INSERT`/`UPDATE` with
  `user_id = auth.uid()` policies (verify in `0001`); this PR must **not**
  widen them. Column-level exclusion for `id`/`user_id`/`email` is enforced by
  the strict route schema (and by the DB if the grant already excludes them —
  check and report).
- No new tables, functions, or policies unless the `language` column question
  forces migration `0017`.

### Storage work

None (avatars out of scope).

### Realtime work

None (`router.refresh()` after save).

### AI work

None.

---

### Security requirements

A user must **not** be able to:

1. Modify another user's profile — `user_id = auth.uid()` policy plus route
   scoping; foreign id attempts are indistinguishable `404`s (if the route
   takes no id, this is trivially satisfied — prefer id-less routes).
2. Set `id`, `user_id`, `email`, `created_at`, `updated_at` through `PATCH`
   (strict schema; DB exclusion verified and reported).
3. Store unbounded or hostile content in `alias`/`language` (length caps,
   control-character rejection; rendering remains escaped by default — no
   `dangerouslySetInnerHTML` for aliases anywhere, including chat/roster).
4. Enumerate other users' profiles: no public profile route exists; `GET
   /api/profile` returns only the session's own row.
5. Spam profile updates (rate limit key from PR 10).
6. Set `exam_targets` to values outside the shared vocabulary (closed enum on
   both client and server — a hand-crafted request with `exam_targets:
   ["anything"]` must fail `400`).

Positive guarantees:

- Email is read-only through the app; changing it requires Supabase Auth's
  flow (documented in the UI so a student is not stuck).
- Notification preferences set here are exactly what PR 11's writer consults
  (one source of truth, asserted by a test that sets `none` and sees no row
  created — reuses 11's integration test pattern).

### API contracts

```jsonc
// GET /api/profile   200
{ "profile": { "alias": "Aarav", "exam_targets": ["NEET","JEE"],
               "language": "hinglish",
               "notification_prefs": { "invite": "all", "moderation": "all",
                                       "ai": "all", "resource": "none" },
               "email": "a@b.com", "created_at": "…" } }
// PATCH /api/profile   200
{ "profile": { ...same shape... } }
// PATCH /api/profile/notification-prefs   200   (or PR 11's endpoint)
{ "prefs": { "invite": "none", "moderation": "all", "ai": "all",
             "resource": "all" } }
```

| Error | Code |
| --- | --- |
| 400 | `validation` (incl. unknown fields, empty body, bad enum) |
| 401 | `unauthenticated` |
| 404 | `not_found` (profile row unexpectedly absent **and** foreign id — identical bodies) |
| 429 | `rate_limited` |
| 500 | `profile_update_failed` / `profile_read_failed` |

Field contracts (document in `docs/API_CONTRACTS.md`):
`alias` 1–40 trimmed, no control chars, uniqueness **not** enforced;
`exam_targets` 0–3 from the shared vocabulary; `language` from the shared
vocabulary; `notification_prefs` values from PR 11's enum.

### Tests

**Unit**

- `lib/validation/profile.ts`: alias bounds/trim/control chars, targets count
  and vocabulary, language vocabulary, unknown-field and empty-body rejection.
- `app/api/profile/route.ts`: GET returns own row only; PATCH partial updates;
  protected fields ignored/rejected (assert a body containing `email` or
  `user_id` → `400`, or that the values are provably unchanged — pick the
  stricter one the schema supports); 500 hygiene.
- Notification prefs route: closed values, unknown type/key → `400`.
- Components: profile form prefill + validation + success announcement;
  checkbox group semantics (`fieldset`/`legend`, each label associated);
  pending/disabled state; account section read-only fields; sign-out redirect.
- Vocabulary constants: settings and `room-create-form` import the same arrays
  (assert equality with a small test so they cannot drift).

**Integration (`tests/integration/profile-settings.test.ts`)**

- Update alias/targets/language → row reflects new values; `email`,
  `user_id`, `created_at` unchanged after a hostile PATCH body containing them.
- Second user's profile untouched (and, if any id-taking path exists, foreign
  attempt → `404` with a byte-identical body to a random id).
- Direct PostgREST `update profiles set email = …` → denied if column grant
  excludes it; if it does not exclude it, **that is a finding to record in the
  PR** (and a candidate for the optional `0017` migration to narrow the grant —
  state whether you narrowed it).
- `exam_targets` vocabulary enforced at the API (hand-crafted bad value →
  `400`, row unchanged).
- Alias change visible to a room-mate through the roster read path (after
  refresh — assert at the API level: `GET /api/rooms/[id]/members` shows the
  new alias).
- Notification prefs set to `none` → PR 11's writer creates no row (mirrors
  11's test; if 11 is not merged yet, this assertion is deferred and noted).
- Rate limit: over-limit PATCH → `429`.

**E2E (`tests/e2e/settings.spec.ts`)**

- Sign in → Settings → change alias + targets + language → save → success
  announced → navigate to a room → roster shows the new alias without a manual
  reload.
- Notification preference change persists across reload.
- Invalid alias (empty/too long) → inline `role="alert"` error, no request
  success state.
- Sign out from the account section lands on `/sign-in` and the `(app)` URL is
  unreachable afterwards (middleware guard).
- Mobile viewport (if PR 19 has merged): settings sections reflow and are
  reachable from the nav.

### Dependencies

- None to start (free lane — intended to run alongside 06/19/21).
- PR 19 (layout/slot; soft), PR 11 (prefs schema; soft with a defined
  handoff), PR 10 (rate-limit key; soft — use `profile:{userId}` naming
  regardless so 10 can wrap it).
- Should land **before** PR 18 (production hardening includes "user can
  actually manage their account" checks) and before PR 16's nav entry is
  finalised.

### Files / modules likely affected

```
app/(app)/settings/page.tsx                              (new) + loading/error
app/api/profile/route.ts                                 (new, or extended)
app/api/profile/notification-prefs/route.ts              (new only if 11 absent)
components/settings/{profile-form,notification-form,account-section}.tsx (new)
lib/validation/profile.ts                                (new)
lib/vocab/{exam-tracks,languages}.ts                     (new)
components/rooms/room-create-form.tsx                    (import shared vocab — justified)
components/layout/header.tsx (or current user affordance) (Settings link)
supabase/migrations/0017_profile_fields.sql              (only if the language
                                                          column question requires it)
tests/unit/... (new), tests/integration/profile-settings.test.ts (new),
tests/e2e/settings.spec.ts (new)
docs/API_CONTRACTS.md, docs/SECURITY.md, docs/local-supabase.md (only if 0017),
docs/milestones.md, README.md
```

### Acceptance criteria

- [ ] Alias, exam targets and language are editable and persist; the roster
      reflects an alias change on refresh.
- [ ] Protected fields (`email`, `user_id`, `created_at`) cannot be changed
      through `PATCH` — asserted with a hostile body.
- [ ] Vocabularies are shared constants; a hand-crafted out-of-vocabulary
      value is rejected server-side.
- [ ] Notification preferences set here are the ones PR 11's writer consults
      (or the handoff is explicitly stated if 11 is not merged).
- [ ] Email is read-only with a documented path to change it (Supabase Auth).
- [ ] Sign-out works and the app is unreachable afterwards.
- [ ] Every form has associated labels, `role="alert"` errors and
      `role="status"` success.
- [ ] Rate limit returns `429` under abuse with a friendly message.
- [ ] All three suites + build green locally and in CI.

### Definition of Done

1. No migration (or, if `0017` was required, `npx supabase db reset` passes and
   its grant narrowing is probe-tested) — stated clearly.
2. CI green on all three jobs.
3. `docs/API_CONTRACTS.md` profile sections + field contracts;
   `docs/SECURITY.md` row (protected fields, no public profile);
   `docs/local-supabase.md` only if schema changed; `docs/milestones.md` row;
   README mentions Settings.
4. The alias-uniqueness and avatar questions recorded as standing questions if
   not addressed.
5. Reviewed by Dev A.

### Owner

**Dev B — Cursor** (the strict-schema and vocabulary-consistency parts are the
review focus; UI is straightforward form work).

### Estimated complexity

**Small–Medium.** One page with three or four forms, one or two endpoints, no
design decisions beyond vocabulary sharing — the only trap is discovering that a
`language` column does not exist and needing a migration.

### Risks

| Risk | Mitigation |
| --- | --- |
| `language`/fields missing from `profiles` → surprise migration | Verify schema first; if needed, ship narrow `0017` with revoke-first grants and say so. |
| `profiles.email` (or similar) updatable via PostgREST | Probe it; if updatable, either narrow the grant in `0017` or document as a known accepted risk with rationale. |
| Two sources of vocabulary drift | Shared constants + equality test. |
| Alias collision confuses rosters | Document non-uniqueness in UI copy near the field; uniqueness is a standing question. |
| Sign-out leaves client cache readable | Clear client state on sign-out (follow the repo's existing auth helper) — test the `(app)` URL is guarded. |
| Scope creep (avatars, deletion, onboarding) | Out-of-scope list explicit; each named as its own follow-up. |
