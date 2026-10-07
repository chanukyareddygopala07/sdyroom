# PR 14 — AI quiz and flashcards from my documents

**Status:** specification only — no GitHub PR exists.
**Owner:** Dev A (OpenCode) · **Complexity:** Large · **Migration:** `0013_quiz_artifacts.sql`
**Depends on:** PR 12 (ingestion), PR 13 (grounded-generation + citation pipeline to reuse)

---

### Problem

The exam-prep core of SdyRoom ("study together for NEET/JEE/UPSC") has no
self-testing mechanism. Students upload notes and chat about them, but nothing
turns those notes into practice. Milestones VII's "AI quiz generation" and
"AI flashcards" are unbuilt: there is no generation endpoint, no artifact
storage, no quiz runner, no spaced-repetition review — `lib/` has no AI code
beyond what PRs 12/13 introduce.

### User story

As a student, I select the documents in my room and generate a quiz or a
flashcard deck from them, take the quiz with instant scoring, review flashcards
with a simple spaced-repetition schedule, and every question is grounded in —
and cites — my own material.

---

### Scope

- **Generation**: `POST /api/rooms/[id]/generate` with `{ mode: 'quiz'|'flashcards', resource_ids, count, difficulty, question_types? }`
  → grounded generation using PR 12's `retrieve()` and PR 13's prompt
  discipline → persisted artifacts.
  - Quiz: 5/10/15/20 questions, MCQ (4 options) + true/false in v1, each with
    an explanation and citations.
  - Flashcards: 10/20/40 cards, front/back, optional `source` citation.
- **Artifacts table** `study_artifacts` (kind `quiz|deck`) with the generated
  payload as jsonb, provenance (model, resource ids, retrieval stats), and
  status.
- **Quiz runner UI**: `/rooms/[id]/quizzes/[artifactId]` — one question at a
  time or all-at-once (pick one; recommend one-at-a-time with progress), instant
  scoring, per-question explanation + citation, final score screen, and a
  **result row** recorded for PR 16's analytics.
- **Flashcard review UI**: `/rooms/[id]/decks/[artifactId]` — flip cards,
  "Got it / Again" grading feeding a **SM-2-lite** schedule (`next_review_at`
  per card, per user), due-today list, deck progress.
- **Artifact library listing**: a "Quizzes & decks" section in the room showing
  generated artifacts with regenerate/delete and status.
- **Generation status**: `pending → generating → ready | failed` with the same
  honest failure copy as PR 12 (`no_documents_indexed`, `ai_provider_failed`,
  `ai_quota_exceeded`, `rate_limited`), resumable/idempotent per PR 12's model
  (client-driven step, no daemon).
- **Rate/cost**: reuse PR 10 rate limits (`generate:{roomId}:{userId}`) and
  PR 12's `ai_usage` (chat tokens counted via the same ledger).
- **Notification**: on `ready`, PR 11's `ai_task_complete` (retrofit the call
  site if 11 has merged; otherwise skip and note it).

### Out of scope

- **Adaptive difficulty, performance-driven question selection, learning-path
  personalisation** — that is PR 16's analytics territory and PR 15's planner
  input; generation here is retrieval-grounded, not learner-model-driven.
- Voice, image, or diagram questions; any multimodal input.
- Hand-written / community-shared quizzes, quiz marketplaces, publishing
  outside the room.
- Timed exams, proctoring, anti-cheating, question ordering randomisation
  beyond a stable shuffle (decide: **shuffle options client-side per attempt**,
  that is in scope; anything more is not).
- Multi-attempt leaderboards, scores visible to other members (v1: results are
  the author's own + PR 16 reads aggregates; room-wide scoreboards are out).
- Import from PDF question banks / OCR.
- LLM-based auto-grading of free-text answers (v1 is MCQ/TF only — scoring is
  deterministic).
- Editing generated questions (a "regenerate" replaces the artifact; in-place
  question editing is a follow-up).
- Spaced-repetition optimisation research (FSRS etc.) — SM-2-lite only.
- Offline/PWA, mobile-native apps.

---

### Frontend work

| File | Change |
| --- | --- |
| `app/(app)/rooms/[id]/generate/page.tsx` (new) (or a dialog from the room page) | Generator form: mode toggle, document scope (default all `ready` docs), count, difficulty (`easy|medium|hard`), generate button with progress state. `loading.tsx` + `error.tsx`. |
| `components/ai/generate-form.tsx` (new) | Validation (count ≤ selected options), disabled reason when zero `ready` docs, error mapping (409/403/429/502) with `role="alert"`. |
| `components/ai/artifact-list.tsx` (new) | "Quizzes & decks" section: kind, question/card count, difficulty, created time, status chip, Open / Regenerate / Delete (owner of the artifact only). |
| `app/(app)/rooms/[id]/quizzes/[artifactId]/page.tsx` (new) | Quiz runner: progress, answer selection (real radio/`role="radiogroup"` or buttons), submit → score + explanations with citations, "Retake". `loading/error`. |
| `components/ai/quiz-runner.tsx` (new) | State machine: unanswered → answered → submitted; keyboard operable; no answer leakage before submit (options shuffled per attempt). |
| `app/(app)/rooms/[id]/decks/[artifactId]/page.tsx` (new) | Flashcard viewer: flip (button, not hover-only), `Got it / Again`, due count, session progress. |
| `components/ai/flashcard-deck.tsx` (new) | Flip state, grading buttons, completion screen. |
| `app/(app)/rooms/[id]/page.tsx` | Link/entry to the generator + artifact list mount. |

Accessibility: quiz options are a proper radiogroup; score announced via
`role="status"`; flashcard flip has a visible button with `aria-pressed`;
progress exposed (`aria-valuenow` on a `progressbar`).

### Backend work

| Route | Behavior |
| --- | --- |
| `POST /api/rooms/[id]/generate` | Member only. Strict body `{ mode, resource_ids?, count, difficulty, question_types? }`. Validates: at least one `ready` doc in scope, count within mode limits, all `resource_ids` belong to accessible docs. → `201 { artifact: { id, kind, status: 'generating' } }` then client drives `POST …/generate/[artifactId]/step` (same resumable pattern as PR 12) **or** generate synchronously if the provider call fits the timeout — **choose the resumable pattern for consistency with 12**; state the choice. Errors: `400 validation`, `401`, `404`, `409 no_documents_indexed`, `403 ai_quota_exceeded`, `429 rate_limited`, `502 ai_provider_failed`, `500 generate_failed`. |
| `POST /api/rooms/[id]/generate/[artifactId]/step` | Advances `generating → ready` (calls provider, validates/parses the JSON answer, persists chunks or the full payload, one bounded call). Idempotent when already `ready`. → `200 { status, question_count?, error_code? }`. |
| `GET /api/rooms/[id]/artifacts?kind=` | Member only → `{ artifacts: [...provenance + counts], has_more }`. |
| `GET /api/rooms/[id]/artifacts/[artifactId]` | Member only → full payload **without other users' attempt results**; `404` parity. |
| `DELETE /api/rooms/[id]/artifacts/[artifactId]` | Creator only → `200 { deleted: true }`; cascades attempts + review rows. |
| `POST /api/rooms/[id]/quizzes/[artifactId]/attempts` | Submit answers → `{ attempt: { id, score, total, correct: [...], results: [...] } }` (deterministic scoring server-side; client answer key is advisory only). `409 already_submitted` if single-attempt mode is chosen (recommend: **one attempt per click, unlimited retakes** — simpler, no 409). |
| `GET /api/rooms/[id]/quizzes/[artifactId]/attempts?user=me` | Own attempts only → `{ attempts: [...] }`. |
| `POST /api/rooms/[id]/decks/[artifactId]/review` | Body `{ card_id, grade: 'again'|'got_it' }` → `{ next_review_at }`; computes SM-2-lite interval. |
| `GET /api/rooms/[id]/decks/[artifactId]/due` | Own due cards → `{ cards: [...], due_count }`. |

Prompt: `lib/ai/prompts/generate.ts` — same untrusted-source wrapping as
PR 13; requires the model to return **strict JSON** (schema-described), with a
parse-and-validate step that rejects malformed output as `502
ai_provider_failed` (never persist a half-parsed artifact as `ready`).

### Database work

`supabase/migrations/0013_quiz_artifacts.sql`:

- `study_artifacts(id uuid pk, room_id uuid not null references rooms on delete
  cascade, creator_id uuid not null references auth.users on delete cascade,
  kind text check in ('quiz','deck'), status text check in ('generating',
  'ready','failed') default 'generating', error_code text, difficulty text,
  question_count int, card_count int, resource_ids uuid[] not null default '{}',
  payload jsonb, model text, prompt_tokens int, completion_tokens int,
  created_at timestamptz default now(), completed_at timestamptz)`.
  Indexes: `(room_id, kind, created_at desc)`, `(creator_id, created_at desc)`.
- `quiz_attempts(id uuid pk, artifact_id uuid references study_artifacts on
  delete cascade, user_id uuid not null references auth.users on delete
  cascade, answers jsonb, score int, total int, correct jsonb,
  duration_ms int, created_at timestamptz default now())` — index
  `(user_id, created_at desc)`, `(artifact_id, user_id)`.
  **This table is PR 16's primary input** — its columns are a contract; get
  `score/total/correct/created_at` right the first time and say so in the PR.
- `flashcard_reviews(id uuid pk, artifact_id uuid references study_artifacts on
  delete cascade, card_ordinal int, user_id uuid not null, grade text check in
  ('again','got_it'), streak int default 0, ease real default 2.5, interval_days
  int default 0, last_reviewed_at timestamptz default now(), next_review_at
  timestamptz not null)` — unique `(artifact_id, user_id, card_ordinal)`;
  index `(user_id, next_review_at)`.
- Grants (revoke-first, all writes via SECURITY DEFINER RPCs, mirrors PR 12):
  - `study_artifacts`: `SELECT` (room members via policy), **no INSERT/UPDATE/
    DELETE grant** → `create_artifact`, `complete_artifact`, `fail_artifact`,
    `delete_artifact` RPCs (creator-or-owner checks inside).
  - `quiz_attempts`: `SELECT` own rows (+ room members may read attempts on
    artifacts they can see **only if** a scoreboard is later added — v1: own
    rows), `INSERT` via `record_attempt` RPC (pins `user_id`, validates
    artifact `ready` and membership, verifies the answer key server-side),
    no `UPDATE`.
  - `flashcard_reviews`: `SELECT`/`UPSERT` own rows — implement upsert as a
    `grant insert/update` pair with `with check (user_id = auth.uid())`
    policies (simplest; SM-2 fields are computed server-side in the RPC, so
    prefer RPC-only writes for consistency: `review_card` RPC).
- Every `record_attempt` writes the PR 16 feed row implicitly (the attempt row
  itself); no extra denormalisation in this PR.

### Storage work

None.

### Realtime work

None (generation status polls like PR 12's ingest).

### AI work

- Quiz/flashcard generation prompts with strict JSON schemas, grounded in
  retrieved chunks, citation fields per item.
- Output validation: count matches, options ≥2 and unique, correct index
  in range, no duplicate question texts, every cited chunk id exists in the
  retrieval result (strip otherwise, mirroring PR 13's citation rule).
- Difficulty token in the prompt (no adaptive model).
- Regenerate = new artifact row (old one stays unless the UI explicitly
  deletes — decide: **regenerate creates a new artifact**; auditable and avoids
  clobbering attempt history).

---

### Security requirements

A user must **not** be able to:

1. Generate from, or open, artifacts in a room they are not a member of
   (`404` parity everywhere, RPC-side membership checks).
2. Read another user's attempt history or review schedule (own-row scoping).
3. Forge a score: the answer key lives in `study_artifacts.payload` server-side;
   the client submits answers only; scoring happens in `record_attempt`.
4. Write or mutate `study_artifacts` directly (no grant; RPC-only).
5. Delete somebody else's artifact (creator-only, RPC-checked).
6. Over-spend: rate limit + `ai_usage` caps; count validation caps `count`.
7. Smuggle instructions through document content into the generation prompt —
   same source-tag discipline as PR 13, injection-seeded test repeated for this
   prompt.
8. Get an unvalidated model JSON persisted as `ready` (parse-validate gate).

Positive guarantees:

- A `ready` artifact always has `payload` matching its declared counts.
- Attempt rows are immutable and attributable (`user_id = auth.uid()` pinned).

### API contracts

```jsonc
// POST /api/rooms/[id]/generate   201
{ "artifact": { "id", "kind": "quiz", "status": "generating", "href":
                "/rooms/…/quizzes/…" } }
// POST /api/rooms/[id]/generate/[artifactId]/step   200
{ "status": "ready", "question_count": 10, "model": "…", "provider": "openai" }
// GET /api/rooms/[id]/artifacts?kind=quiz   200
{ "artifacts": [ { "id", "kind", "status", "difficulty", "question_count",
                   "card_count", "created_at", "href" } ], "has_more": false }
// POST /api/rooms/[id]/quizzes/[artifactId]/attempts   201
{ "attempt": { "id", "score": 7, "total": 10,
               "correct": [true,false,true,…],
               "results": [ { "ordinal", "chosen", "correct_index",
                              "explanation", "citations" } ],
               "duration_ms": 42100 } }
// POST /api/rooms/[id]/decks/[artifactId]/review   200
{ "next_review_at": "…", "interval_days": 3, "streak": 2, "due_count": 5 }
```

| Error | Code |
| --- | --- |
| 400 | `validation` / `invalid_json` |
| 401 | `unauthenticated` |
| 403 | `ai_quota_exceeded`, `not_creator` |
| 404 | `not_found` |
| 409 | `no_documents_indexed`, `artifact_not_ready` |
| 429 | `rate_limited` |
| 502 | `ai_provider_failed` (includes malformed model output) |
| 500 | `generate_failed` / `attempt_failed` / `review_failed` |

### Tests

**Unit**

- Prompt builder: budget, source wrapping, JSON schema instructions, injection
  seed stays untrusted.
- Output validator: wrong count, duplicate questions, out-of-range correct
  index, missing citations stripped, malformed JSON → `502` and `failed` status
  (never `ready`).
- Scoring: deterministic server-side scoring, partial credit absent (all-or-
  nothing per question), empty answers scored as wrong.
- SM-2-lite: `again` resets streak/interval, `got_it` grows interval with the
  documented table, `next_review_at` in the future, cap documented.
- Route files: authz matrix, count limits, creator-only delete, own-attempts
  scoping, artifact-not-ready `409`.
- Components: generate form validation, quiz runner state machine + option
  shuffle determinism (seeded), score announcement, flashcard flip/grade,
  empty states.

**Integration (`tests/integration/quiz-artifacts.test.ts`)**

- Seed `ready` docs → generate quiz → artifact `ready` with payload counts
  matching declared; generate deck likewise.
- Non-member `404` on generate, step, artifacts list, attempts, review.
- Direct PostgREST insert into `study_artifacts` / `quiz_attempts` → denied;
  direct `update study_artifacts set payload` → denied.
- Attempt: correct answers → `score = total`; wrong → lower; second attempt
  allowed (if retakes chosen); `user_id` pinned regardless of body.
- Review: grade twice for one card → single row (unique index), schedule moves.
- Delete artifact cascades attempts + reviews (counts 0).
- Injection seed in a document → generated question does not echo system
  material (mock provider deterministic marker).
- Quota/rate limits: seeded over-cap → `403`/`429` with no provider call.

**E2E (`tests/e2e/quiz-flashcards.spec.ts`)** — mock provider:

- Generate a 5-question quiz from indexed docs → runner opens → answer all →
  score screen with explanations and citations → retake works.
- Generate a deck → flip a card → grade `Got it` → due count decreases on
  reload.
- Non-member hitting the URLs gets `404`.
- Zero-indexed room → generator disabled with the CTA (shared with PR 13's
  empty state).

### Dependencies

- PR 12 (hard), PR 13 (prompt/citation utilities — hard for code reuse, soft
  for schema).
- PR 16 reads `quiz_attempts` — **14 must merge before 16 starts** (the
  roadmap orders 14 → 16 → 15 for this reason).
- PR 11 optional (completion notification).

### Files / modules likely affected

```
supabase/migrations/0013_quiz_artifacts.sql              (new)
app/(app)/rooms/[id]/generate/page.tsx                   (new) + loading/error
app/(app)/rooms/[id]/quizzes/[artifactId]/page.tsx       (new) + loading/error
app/(app)/rooms/[id]/decks/[artifactId]/page.tsx         (new) + loading/error
app/api/rooms/[id]/generate/route.ts                     (new)
app/api/rooms/[id]/generate/[artifactId]/step/route.ts   (new)
app/api/rooms/[id]/artifacts/route.ts, [artifactId]/route.ts (new)
app/api/rooms/[id]/quizzes/[artifactId]/attempts/route.ts (new)
app/api/rooms/[id]/decks/[artifactId]/{review,due}/route.ts (new)
components/ai/{generate-form,artifact-list,quiz-runner,flashcard-deck}.tsx (new)
lib/ai/prompts/generate.ts                               (new)
lib/ai/quiz/{validate,score}.ts                          (new)
lib/ai/srs.ts                                            (new: SM-2-lite)
lib/validation/generate.ts                               (new)
app/(app)/rooms/[id]/page.tsx                            (entry + list mount)
tests/unit/... (new), tests/integration/quiz-artifacts.test.ts (new),
tests/e2e/quiz-flashcards.spec.ts (new)
docs/API_CONTRACTS.md, docs/SECURITY.md, docs/local-supabase.md, docs/milestones.md
```

### Acceptance criteria

- [ ] A member generates a quiz and a deck from indexed docs; payloads validate
      against the declared counts and cite real retrieved chunks.
- [ ] Scoring is server-side and deterministic; tampering with client answers
      cannot raise a score.
- [ ] `quiz_attempts` columns match PR 16's contract (`score`, `total`,
      `correct`, `created_at`, `user_id`) and are documented as such.
- [ ] Flashcard grading persists a single row per user/card with a future
      `next_review_at`; due list works on reload.
- [ ] Non-members get identical `404`s; direct writes to artifacts/attempts are
      denied.
- [ ] Malformed model output → `failed` + `502`, never a `ready` artifact.
- [ ] Injection-seeded document does not leak system prompt material.
- [ ] All three suites + build green locally and in CI.

### Definition of Done

1. `npx supabase db reset` from scratch; grant/RPC probes pass in both
   directions; cascade test proves attempt/review cleanup.
2. Mock path green in CI; real-provider manual run recorded (one quiz, one
   deck) in the PR description.
3. CI green on all three jobs.
4. `docs/API_CONTRACTS.md` generate/attempts/review sections **plus the
   `quiz_attempts` contract note for PR 16**; `docs/SECURITY.md` rows (score
   forgery, injection); `docs/local-supabase.md` table/grants; `docs/milestones.md`
   VII status.
5. Regenerate semantics (new artifact) stated in the UI copy and docs.
6. Reviewed by Dev B.

### Owner

**Dev A — OpenCode** (full-stack; scoring integrity + payload validation are the
review focus).

### Estimated complexity

**Medium–Large.** Two new pages with real interaction, three tables, several
RPCs, and a strict output validator — but no streaming, no realtime, no
migration of existing behaviour.

### Risks

| Risk | Mitigation |
| --- | --- |
| Model returns malformed JSON | Strict parse-validate gate; `failed` + `502`; never partial `ready`. |
| Score forgery via client payload | Server-side key + `record_attempt` RPC; test with tampered body. |
| Attempt schema drifts before PR 16 lands | Contract called out in `API_CONTRACTS.md`; 16 cannot start until 14 merges. |
| Prompt injection through docs | Same discipline as 13 + seeded test. |
| Flashcard SRS complexity creep | SM-2-lite with a fixed table, one unit-testable function. |
| Scope creep into adaptive learning | Explicitly out of scope; routed to 16/15. |
