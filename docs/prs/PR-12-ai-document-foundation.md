# PR 12 — AI document foundation (provider abstraction, document ingestion, chunking)

**Status:** specification only — no GitHub PR exists.
**Owner:** Dev B (Cursor) · **Complexity:** Large · **Migration:** `0012_ai_documents.sql`
**Depends on:** PR 10 (upload caps, sniffing, quota — ingestion must not become a DoS vector)
**Gates:** PR 13, 14, 15, 16 (all AI work starts only after this lands)

---

### Problem

SdyRoom has **zero AI code**: no dependency in `package.json`, no provider key
handling, no embeddings, no chunking, no document-aware endpoints. Milestones
V–VII ("Study materials → RAG", "Ask my notes", "AI quiz/flashcards",
"AI planner") are entirely unbuilt, and today's upload flow stores bytes that
nothing can read. `docs/milestones.md` scopes the AI features; the repository
contains no infrastructure to build them on. Without this PR, every subsequent
AI PR would re-invent config, secrets, cost controls and failure handling four
times over.

### User story

As a student, once I upload a PDF to my room it is ready for the AI features:
extraction runs in the background, my document is chunked and embedded with
bounded cost, and by the time I ask "what does chapter 3 say" the answer has
grounding in my own file — with a clear status if it is still processing or if
the AI is unavailable.

---

### Scope

- **Provider abstraction** `lib/ai/provider.ts`: a narrow interface
  (`embed(texts) → vectors`, `complete({messages, maxTokens, temperature}) → text`)
  with **one concrete implementation chosen at runtime from env** (OpenAI-compatible
  or any OpenAI-shaped endpoint — the repo has no provider preference, so the
  abstraction must let ops switch without code change). Plus a deterministic
  **`mock` provider** active when no key is configured: returns fixed-shape
  results so the whole pipeline is testable in CI without secrets or spend.
- **Document ingestion pipeline** for uploaded `study_resources`:
  - text extraction per type: **PDF** (text-layer only), **md/txt/csv** (direct),
    **docx** (unzip + XML text). Scanned/image-only PDFs → explicit
    `extraction_failed: no_text_layer` state (no OCR in scope).
  - chunking: ~800 tokens / 120 overlap, heading-aware for md, page-boundary
    aware for PDF, stable chunk ids (`sha256(resource_id + ordinal + text)`)
    so re-runs are idempotent.
  - embedding via the provider, batched (e.g. 64/chunk-batch), with per-run
    token/byte accounting.
- **Status model** on ingestion: `pending → extracting → chunking → embedding → ready`
  | `failed` (with `error_code`), visible in the UI on the resource row.
- **Vector search**: pgvector `match_document_chunks(p_room_id, p_query_embedding, p_limit, p_filter)`
  RPC restricted to members of the room and to resources the caller may read
  (personal resources only for their owner).
- **Background execution model**: **no queue service**. A client-driven
  `POST /api/ai/ingest/[resourceId]` advances the state machine step-by-step
  (idempotent, resumable, one step per call, ≤ ~2s per call), invoked by the
  resource detail view; plus a `POST /api/ai/ingest/sweep` a member can call to
  pick up stuck `pending/extracting` rows older than N minutes. This matches the
  repo's serverless, no-daemon architecture. Document the trade-off honestly: a
  client that closes the tab mid-ingest leaves the row resumable, not broken.
- **RAG retrieval helper** `lib/ai/retrieve.ts`: embed query → RPC → rerank-lite
  (score threshold + top-k window) → return `{ chunks, citations }`. PRs 13–16
  consume this and nothing else.
- **Config & secrets**: `AI_PROVIDER`, `AI_API_KEY`, `AI_BASE_URL`,
  `AI_EMBED_MODEL`, `AI_CHAT_MODEL`, `AI_MAX_INGEST_BYTES` — read server-side
  only; **never** exposed via `NEXT_PUBLIC_*`; documented in README +
  `docs/SECURITY.md`; missing key → `mock` provider + a UI banner ("AI running
  in demo mode").
- **Cost/abuse controls**: reuse PR 10's `rate_limit_take` for ingest calls;
  cap total embedded bytes per room per day via a small `ai_usage` ledger row
  accumulated during ingest; `403 ai_quota_exceeded` when exceeded.
- **Realtime**: none of its own (ingest status reaches the UI via
  `router.refresh()` on completion, or PR 11's `ai_task_complete`
  notification).

### Out of scope

- OCR for scanned PDFs (documented as `no_text_layer`, feature says so).
- Table/figure understanding, image captioning, multimodal input.
- **Vector database services** (Pinecone/Weaviate/pgvectors.dev) — pgvector in
  the existing Supabase project only; embedding dimension must match the chosen
  model and be fixed in the migration (state it: `1536` for
  `text-embedding-3-small`-class models, or the model actually chosen).
- Fine-tuning, model hosting, prompt caching layers, semantic caching.
- Cross-room or global retrieval — retrieval is room-scoped, always.
- Streaming SSE for completions (PR 13 may add it; not required here).
- Evaluation harnesses / golden datasets (note as a follow-up for 14/15 quality).
- Any UI beyond status display + the demo-mode banner (the chat, quiz, planner
  UIs belong to 13/14/15).
- Automatic re-embedding when a resource is replaced (no replace flow exists).

---

### Frontend work

| File | Change |
| --- | --- |
| `components/resources/resource-library.tsx` / resource row | Status chip per resource: `Not indexed`, `Indexing… (step)`, `Ready for AI`, `Failed — no text layer`. Owner-only "Index now" button when `pending`/`failed`. |
| `components/ai/ai-status.tsx` (new) | Small reusable status + demo-mode banner component used by 13/14/15 later. |
| `app/(app)/layout.tsx` (or settings) | Global demo-mode banner when `provider: 'mock'`. Placement coordinated with PR 11's bell and PR 19's shell. |

No new routes in this PR (the retrieval API exists for 13 to consume; a raw
"search my notes" page is **not** built here — that would duplicate 13).

### Backend work

| Route | Behavior |
| --- | --- |
| `POST /api/ai/ingest/[resourceId]` | Body `{ step?: 'extract'\|'chunk'\|'embed'\|'auto' }` (default `auto` = advance one step). Caller must own the resource (personal) or be a member of its room. Idempotent: re-running a completed step is a no-op `200 { status, step_done }`. → `200 { status, chunks?, tokens?, error_code? }`. Errors: `400 validation`, `401`, `403 `not_resource_owner`/`not_member``, 404 `not_found`, **413 `too_large`**, **415 `unsupported_media_type`**, **403 `ai_quota_exceeded`**, **429 `rate_limited`**, **502 `ai_provider_failed`**, 500 `ingest_failed`. |
| `POST /api/ai/ingest/sweep` | Body `{ room_id?, limit? }`. Picks up ≤`limit` (default 10) stuck rows older than 5 minutes owned by the caller's accessible rooms → `{ picked: n, statuses: [...] }`. |
| `GET /api/ai/usage?room_id=` | `{ used_bytes, used_tokens, limit_bytes, provider }` — for UI + debugging. |
| (internal, not a route) `lib/ai/retrieve.ts` | `retrieve({ roomId, query, topK })` → `{ chunks: [{ resource_id, chunk_id, text, score, citation }], citations }`. Enforced room scope inside the RPC. |

State machine lives in `lib/ai/ingest.ts` (`advanceIngest(resourceId, step)`)
with each step writing `study_ai_documents` status; a failed step writes
`error_code` and does not retry automatically (explicit user retry).

### Database work

`supabase/migrations/0012_ai_documents.sql`:

- `create extension if not exists vector;`
- `study_ai_documents(resource_id uuid pk references study_resources on delete
  cascade, status text not null default 'pending' check (status in ('pending',
  'extracting', 'chunking', 'embedding', 'ready', 'failed')), error_code text,
  chunk_count int default 0, extracted_bytes bigint default 0, embedding_tokens
  bigint default 0, model text, started_at, completed_at, updated_at)` —
  `updated_at` trigger like `rooms`.
- `document_chunks(id uuid pk, resource_id uuid not null references
  study_ai_documents on delete cascade, ordinal int not null, text text not null,
  tokens int, embedding vector({DIM}) not null, page_start int null, heading
  text null, chunk_hash text not null, unique(resource_id, ordinal))` +
  **HNSW or IVFFlat index** on `embedding` (choose HNSW; document build cost and
  that `lists`/`m` params are defaults for v1).
- `ai_usage(id, room_id uuid null, user_id uuid not null, kind text check in
  ('embed_bytes','embed_tokens','chat_tokens'), amount bigint, created_at)` —
  index `(user_id, created_at)`; daily caps computed with `sum`.
- Grants (revoke-first):
  - `study_ai_documents`: `SELECT` (members/owner via policy), `UPDATE (status,
    error_code, chunk_count, extracted_bytes, embedding_tokens, model,
    started_at, completed_at, updated_at)` for resource owner/member,
    `INSERT` for owner — but prefer **all writes via SECURITY DEFINER RPCs**
    (see below) to keep the state machine server-side; then revoke insert/update
    entirely and grant `SELECT` only. **Choose: RPC-only writes.**
  - `document_chunks`: **`SELECT` only** for `authenticated`, policy scoped to
    room membership / resource ownership; **no INSERT/UPDATE/DELETE grant** —
    all writes via RPC.
  - `ai_usage`: `SELECT` own rows; inserts via RPC.
- RPCs (SECURITY DEFINER, `search_path = ''`, execute revoked from
  `public`/`anon`, granted to `authenticated`):
  - `ingest_begin(p_resource_id uuid) returns jsonb` — authz (owner or
    room-member), size/type gate re-check, upsert `study_ai_documents`,
    return current status.
  - `ingest_record_chunk(p_resource_id uuid, p_chunks jsonb, p_model text,
    p_tokens bigint) returns jsonb` — atomic: delete-not-ready chunks for
    re-runs, insert chunks + embeddings, set `ready`, accumulate `ai_usage`.
    Takes embeddings **as jsonb floats** (the route computes them via the
    provider) so no provider key ever touches the database.
  - `ingest_mark_failed(p_resource_id uuid, p_error_code text)`.
  - `match_document_chunks(p_room_id uuid, p_query_embedding vector(DIM),
    p_limit int default 8, p_threshold float default 0.2) returns table(...)` —
    `SECURITY INVOKER` with an explicit `exists (room_members …)` guard **or**
    `SECURITY DEFINER` with the guard inside; either way the caller's room
    membership is checked and personal resources are restricted to
    `resource.user_id = auth.uid()`. Also filter to `status = 'ready'`.
  - `ai_usage_daily(p_user_id uuid, p_room_id uuid) returns jsonb`.
- **Dimension decision:** pick one model, set `{DIM}` to match, and put a header
  comment in the migration: "changing the embedding model requires a new
  migration + full re-embed; do not edit this file." Integration test asserts
  `vector_dims(embedding) = {DIM}`.
- `pgvector` availability: `docs/local-supabase.md` must document the local image
  flag if needed (`supabase start` supports `vector` since v1.x — verify and
  document the exact command; if the local image lacks it, the migration's
  `create extension` will fail loudly and the standing question must be resolved
  **before** this PR is coded).

### Storage work

Reads the existing object through the resource fetch path; no new storage
operations. Ingest must respect PR 10's `AI_MAX_INGEST_BYTES`.

### Realtime work

None required. Optional: status chip refresh on `router.refresh()` after each
step; PR 11's `ai_task_complete` fires on `ready` if 11 has merged (else the
call site is added by 11 later — coordinate, prefer retrofitting in 12 only if
11 is already merged).

### AI work

- Provider interface + mock provider + OpenAI-compatible implementation.
- Extraction (pdf text layer / md / txt / csv / docx).
- Chunking + idempotent hashes.
- Batched embedding with token accounting.
- Query embedding + retrieval helper used by all later AI PRs.
- Prompt handling kept out of this PR: no user-facing completion happens here
  (that is 13). The `complete()` method exists so 13 does not re-plumb it.

---

### Security requirements

A user must **not** be able to:

1. Ingest a resource they do not own and cannot see — authz is re-checked in
   the RPC, independent of the route.
2. Retrieve chunks from another room, another user's personal library, or a
   non-`ready` document.
3. Read the provider API key: server-side env only, no `NEXT_PUBLIC_`, no key
   in any payload, no key in logs (log provider/model/usage, never headers).
4. Exfiltrate arbitrary URLs (no `fetch` of user-supplied URLs anywhere in the
   pipeline — extraction only reads storage objects the caller can access).
5. Bypass PR 10's size/type gates to inflate embedding cost: re-check size and
   sniffed type at `ingest_begin`.
6. Exhaust budget: per-user/day `ai_usage` caps + PR 10 rate limits; over-cap →
   `403 ai_quota_exceeded`, no partial provider call.
7. Poison the chunk table for other members: writes only through the RPCs, no
   direct `INSERT`/`UPDATE` grants on `document_chunks`.
8. Trigger unbounded provider spend from a tight loop: rate limit + per-step
   idempotency + one step per request.

Positive guarantees:

- `match_document_chunks` returns zero rows for a non-member even with a
  perfectly crafted embedding argument.
- Provider failure surfaces as `502 ai_provider_failed` with the row left in a
  resumable state (`embedding` + `error_code`), never silently `ready`.
- Mock provider is selected **only** when no key is present — a configured-but-broken
  key must fail loudly, not silently fall back to mock.

### API contracts

```jsonc
// POST /api/ai/ingest/[resourceId]   200
{ "status": "ready", "step_done": "embed", "chunks": 34, "tokens": 18211,
  "model": "text-embedding-3-small", "provider": "openai" }
// failure
{ "error": { "code": "ai_provider_failed", "message": "…" } }
// POST /api/ai/ingest/sweep   200
{ "picked": 3, "statuses": [ { "resource_id", "status" } ] }
// GET /api/ai/usage?room_id=   200
{ "used_bytes": 1298231, "used_tokens": 40211, "limit_bytes": 52428800,
  "provider": "mock" }
```

Internal contract for 13–16 (documented in `docs/API_CONTRACTS.md` as an
internal section):

```ts
retrieve({ roomId, query, topK?, threshold? })
  → { chunks: Array<{ resourceId, chunkId, text, score, page?, heading?, citation }>,
      citations: Array<{ resourceId, title, href, pages?: number[] }> }
```

`citation.href` must be a route that exists (validated by a unit test, same
pattern as PR 11's href map).

### Tests

**Unit**

- Extraction per type: text-layer PDF fixture, `.md` with headings, `.txt`,
  `.csv`, `.docx` (zip fixture), image-only PDF → `no_text_layer`.
- Chunking: size/overlap invariants, heading and page boundaries preserved,
  idempotent hashes across two runs (same input → same chunk ids).
- `lib/ai/provider.ts`: mock returns fixed vectors of `{DIM}`; configured
  provider constructs requests without ever logging the key; missing key → mock;
  present-but-401 key → `ai_provider_failed` (no mock fallback).
- State machine: each legal transition, illegal transition refused,
  idempotent re-run of a completed step, failure writes `error_code` and stays
  resumable.
- Route files: authz matrix, size/type gates, quota, rate-limit mapping,
  502/500 hygiene, response shapes (no key, no absolute storage URL leakage
  beyond what resource API already allows).
- `retrieve.ts`: threshold filtering, empty-result path, citation assembly,
  href map test.

**Integration (`tests/integration/ai-ingestion.test.ts`)** — run only when
`AI_E2E=1` **or** always with the mock provider (prefer always-with-mock so CI
never skips):

- `create extension vector` present; migration applies from scratch;
  `vector_dims` matches the constant.
- Owner ingests a seeded PDF end-to-end via the RPC chain → `ready`,
  `chunk_count > 0`, `vector_dims(embedding) = DIM`.
- Non-member `ingest_begin` on someone else's personal resource → denied.
- `match_document_chunks`: member gets rows for their room's docs; **non-member
  gets zero rows**; `status <> 'ready'` never returned; personal resource
  invisible to other users.
- Direct `insert into document_chunks` → permission denied.
- Quota: seed `ai_usage` to the cap → ingest → `403 ai_quota_exceeded`, no
  provider call made (assert `ai_usage` unchanged).
- Idempotency: run `ingest_record_chunk` twice with the same payload → same
  `chunk_count`, no duplicates (unique index).
- Re-run after failure resumes to `ready` without duplicate side effects.

**E2E (`tests/e2e/ai-ingest.spec.ts`)** — mock provider path:

- Upload a PDF → status chip moves `Not indexed` → (click Index) → `Ready for AI`.
- An image-only fixture → `Failed — no text layer` with honest copy.
- Demo-mode banner visible when `provider: 'mock'` (assert via a test-only
  `NEXT_PUBLIC_AI_DEMO` flag or the `GET /api/ai/usage` provider field — pick
  one and document it).

### Dependencies

- **PR 10 must merge first** (size/type gates, rate-limit keys, quota
  mechanism). Do not duplicate those protections here.
- pgvector in the local image — verify before coding (standing question).
- PR 11 (optional, for `ai_task_complete` notification retrofit).
- Nothing from 06–09 is required.

### Files / modules likely affected

```
supabase/migrations/0012_ai_documents.sql                (new)
lib/ai/{provider,extract,chunk,ingest,retrieve,usage}.ts (new)
lib/ai/providers/{openai,mock}.ts                        (new)
app/api/ai/ingest/[resourceId]/route.ts                  (new)
app/api/ai/ingest/sweep/route.ts                            (new)
app/api/ai/usage/route.ts                                (new)
lib/resources/{queries,types}.ts                         (status exposure)
components/resources/resource-library.tsx                (status chip + Index now)
components/ai/ai-status.tsx                              (new)
.env.example / README.md                                 (AI_* vars, mock behavior)
package.json                                             (ai sdk / pdf lib — pin exact versions)
tests/unit/lib/ai/*.test.ts                              (new)
tests/integration/ai-ingestion.test.ts                   (new)
tests/e2e/ai-ingest.spec.ts                              (new)
docs/API_CONTRACTS.md (AI internal section), docs/SECURITY.md (key handling, prompt-injection posture),
docs/local-supabase.md (pgvector), docs/milestones.md (V–VII status), README.md
```

### Acceptance criteria

- [ ] With no key configured, the entire pipeline runs on the mock provider and
      a demo-mode indicator is visible; with a key configured, a broken key fails
      loudly (no silent mock).
- [ ] A text PDF uploads → ingests → `ready` with chunk rows carrying valid
      `{DIM}`-dimensional embeddings; a scanned PDF reports `no_text_layer`.
- [ ] A non-member of a room gets zero rows from `match_document_chunks` for
      that room, and a non-owner cannot ingest another's personal file.
- [ ] Direct PostgREST writes to `document_chunks` are denied.
- [ ] Quota and rate limits reject abusive ingest with the documented codes, and
      no provider call is made when rejected.
- [ ] The provider key never appears in a payload, log line, or client bundle
      (grep the built output for the test key).
- [ ] `retrieve()` is documented as the single entry point for PRs 13–16.
- [ ] All three suites + build green locally and in CI (ingestion integration
      tests run in CI on the mock provider).

### Definition of Done

1. `npx supabase db reset` from scratch with pgvector; dimension assertion
   passes; all RPC probes (authz positive/negative, direct-insert denial) pass.
2. Mock-provider path runs in CI **without secrets**; the real-provider path is
   covered by a documented manual run (`AI_E2E=1`) recorded in the PR.
3. CI green on all three jobs.
4. `docs/API_CONTRACTS.md` AI section (route + internal `retrieve()` contract +
   status/error-code table); `docs/SECURITY.md` rows for key handling, cost
   abuse, retrieval authorization, and prompt-injection posture for later PRs
   ("retrieved text is data, never instructions"); `docs/local-supabase.md`
   pgvector setup; `docs/milestones.md` V–VII marked "foundation ready".
5. `AI_*` environment variables documented in README + `.env.example` with the
   "no key → mock" rule stated.
6. Reviewed by Dev A.

### Owner

**Dev B — Cursor** (backend/data/AI-heavy; the migration and provider seams are
the review focus).

### Estimated complexity

**Large.** New extension, five-ish new tables/functions, a provider seam with a
real mock, extraction across four formats, and an idempotent resumable state
machine — but no user-facing AI feature yet, which keeps the review surface
tractable.

### Risks

| Risk | Mitigation |
| --- | --- |
| pgvector missing in the local/CI Supabase image | Standing question resolved **before** coding; migration fails fast if absent. |
| Embedding model mismatch bricks the index | One model, `{DIM}` fixed in migration, header warning, dimension assertion test, re-embed requires a new migration. |
| Provider cost blow-up | Batch caps, per-day `ai_usage` limits, size gates from PR 10, one step per request, rate limits. |
| Extraction complexity explosion (every format) | Support exactly four types; everything else → `unsupported_media_type`, honest UI copy. |
| Client-driven ingest leaves stuck rows | Idempotent resume + `sweep`; status UI explains "resume". |
| Silent mock fallback masks a production key problem | Explicit rule: mock only when key absent; test it. |
| Prompt injection inherited by 13–16 | Written posture in `SECURITY.md`: retrieved chunk text is untrusted data, wrapped as such, never concatenated into system prompts. |
