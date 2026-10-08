# PR 10 — Resource security hardening (size, content checks, quotas, cleanup)

**Status:** in review — [PR #10](https://github.com/chanukyareddygopala07/sdyroom/pull/10) (`feat/resource-security`).
**Owner:** Dev B (Cursor) · **Complexity:** Medium–Large · **Migration:** `0010_resource_hardening.sql`
**Depends on:** nothing (parallel lane — starts any time after `origin/main`)

---

### Reconciliation (decisions locked before implementation)

| Decision | Chosen | Why |
| --- | --- | --- |
| Upload routes | The PR-05 pair `POST`/`GET /api/resources` (scope in the body/query), **not** the per-room `POST /api/rooms/[id]/resources` sketched here | PR 05 shipped one endpoint pair for both scopes; inventing a second route shape would split the quota, rate-limit and validation logic across two controllers for no product gain. |
| Per-file ceiling | **20 MiB**, not the 25 MiB recommended above | The bucket (`file_size_limit = 20971520`), the `study_resources_size` CHECK and the `content-length` guard already enforce 20 MiB end to end; a second, larger number would be the one layer that disagrees. |
| Error codes | Repo codes kept: `413 file_too_large`, `415 unsupported_file_type`, `500 storage_upload_failed`; spec's `payload_too_large` / `unsupported_media_type` / `upload_failed` dropped. New codes per spec: `409 quota_exceeded`, `429 rate_limited` | The error envelope is a published contract across five merged PRs; renaming existing codes to match a draft spec would break clients for aesthetics. |
| Magic-byte sniffing | **No new work — PR 05 already shipped it.** `lib/resources/files.ts` validates extension, declared type, magic bytes and text encoding; `study-resources.test.ts` proves a mismatched file is refused | This spec's Problem §2 predates the PR-05 implementation. Sniffing behaviour is left byte-for-byte untouched. |
| Compensating delete | **No new work — PR 05 already shipped it** (object put → row insert → object deleted on insert failure); verified, no regression, and now wrapped by the rate limiter | Same as above: the write-path guarantee existed; this PR hardens what surrounds it. |
| Orphan sweep endpoint | `POST /api/resources/cleanup` — body `{}` sweeps the caller's personal folder, `{"room_id"}` sweeps one room the caller belongs to — instead of an admin route or a per-room maintenance path | The spec's out-of-scope section forbids an admin role, and "caller sweeps what they can see" was the prescribed shape. Prefix-scoped, membership-gated, rate-limited before the body is even parsed. |
| `sweep_storage_orphans` RPC | **Not shipped as SQL.** The set difference lives in the route (it lists rows *and* bucket objects under the prefix; SQL can neither list objects nor delete them) | The spec itself anticipated this ("the actual storage delete happens in the route"). No RPC, no extra execute grant. |
| Second sweep direction | **Both directions shipped** (object-without-row → delete object; row-without-object → delete row), not the "choose the cheap direction" option | Storage rows are exactly what room deletion forgets; a row without an object advertises a download that can never succeed. Both are scoped to the caller's own prefix and skipped under a 60 s grace period. |
| Body handling | The whole multipart body is buffered, bounded by the 20 MiB ceiling — **not** the streaming ≤16-byte sniff window sketched here | PR 05's parser buffers within the ceiling and the ceiling is small; streaming is an optimization, not a security boundary, at 20 MiB. The memory-blow-up risk the spec guards against is removed by the cap itself. |
| Quota numbers | **1 GiB per user, 500 MiB per room** (the standing questions above, resolved) | Enforced twice: `resource_quota_ok` pre-check in the route (fail-open — a quota outage must not take uploads down) and the `study_resources_quota_guard` BEFORE INSERT trigger as the authority (advisory locks user→room, `P0001` → `409 quota_exceeded`). The pre-check's advisory lock serializes the two racing uploads the integration test drives. |
| Rate-limit windows | Uploads 20/min per user + 10/min per target, delete 30/min, download 120/min, cleanup 5/min, invites 10/h, reports 20/h, blocks 30/h, mutes 30/h — published as a key table in `docs/API_CONTRACTS.md` | The spec's "10 uploads per minute per user per room" became two keys (user + target) so a student cannot be locked out of their own library by flooding one room, and every shared key PRs 07/09/11 were told to reuse is now real and documented. |
| Rate limits for reports/blocks/mutes/invites | **Wired in this PR**, retroactively | The spec assigned key *naming* to 07/09/11; those PRs merged before the limiter existed, so this PR fits the existing routes to the shared mechanism instead of leaving documented-but-unenforced limits. |
| Limiter storage | `rate_limits` table: RLS enabled with **zero policies**, **zero grants** for every role, one `SECURITY DEFINER` RPC `rate_limit_take` (atomic upsert, fixed window, `search_path = ''`, **fail-open** — only an explicit `false` refuses) | "Two closed doors": even a future grant widening leaves RLS with no policy to allow anything; tests widen a grant inside a transaction, observe the freeze, revoke and re-check. |
| Bucket configuration | The migration owns the bucket (`0005`, idempotent upsert); no `config.toml` storage section exists locally; **verified** by a direct oversized put that bypasses the app entirely | Spec risk "storage-layer limits not settable → false confidence": the integration suite now pushes 20 MiB + 1 byte straight at storage and asserts the bucket's own refusal with nothing written. |
| Signed-URL serve review | `Content-Disposition: attachment` **shipped**: every download URL carries `&download=<original filename>` (single-encoded, appended post-signature), and the integration suite asserts the disposition, the 300 s `Expires`/`Date` pair, and that listings embed no signature. `X-Content-Type-Options: nosniff` is **not emitted by the storage origin** and cannot be set from the app — documented as a known limitation in `docs/SECURITY.md`, mitigated by sniffed content types, the closed allow list, and the attachment disposition | The spec's serve-review item asked for attachment "for non-preview types"; this app previews nothing, so attachment applies to every type. Header evidence recorded in `docs/local-supabase.md`. |

---

### Problem

Resource upload today trusts the caller for three things it should not:

1. **Size** — `lib/resources/upload.ts` performs the object put; the
   `content-length` guard described in `docs/API_CONTRACTS.md` lives in the
   upload path but there is **no server-side byte cap in the API contract row**
   and no per-room or per-user storage quota. A client can fill a bucket.
2. **Content** — the stored `mime_type` and `file_extension` come from the
   client-declared values; there is no magic-byte sniff, no extension/`Content-Type`
   agreement check, and the private bucket's signed URLs are served with whatever
   metadata was recorded. Nothing verifies the bytes are a PDF at all.
3. **Orphans** — `study_resources` rows cascade on room delete, but
   `storage.objects` do not, and the upload path has no compensating delete if
   the DB insert fails after the object lands. The only cleanup that exists is
   `tests/e2e/global-teardown.ts`. `docs/API_CONTRACTS.md` documents the
   "create row after object" ordering and its accepted failure mode but no
   sweep. `0005_study_resources.sql:68-70` and `0004` confirm: rows cascade,
   objects do not.

None of this is exploitable to read another user's file (the bucket is private
and RLS scopes the table) — it is exploitable to **waste space, poison metadata,
and leave unreachable bytes behind**.

### User story

As a platform operator I want uploads that are bounded, content-verified,
quotable and self-cleaning; as a student I want a clear "file too large" / "not
a supported file" message instead of a silent `500`.

---

### Scope

- **Hard upload ceiling** enforced server-side: per-file max (recommend
  **25 MiB**), stated in `docs/API_CONTRACTS.md` as a contract row.
- **Content verification**: extension ∈ allow-list; declared `Content-Type`
  must agree with the extension's canonical type; **magic-byte sniff** of the
  first bytes against the allowed set (PDF `%PDF`, images `\xFF\xD8\xFF` /
  `\x89PNG\r\n\x1a\n`, text-ish UTF-8/UTF-16 BOMs, office/zip `PK\x03\x04`);
  stored `mime_type` becomes the **sniffed** type, not the client's claim.
- **Storage quota**: per-user and per-room byte totals with a documented
  default (suggest 500 MiB per room, 1 GiB per user — numbers are standing
  questions), enforced in the same transaction as the row insert.
- **Orphan prevention** (write path): if the DB insert fails after the object
  put, delete the object before answering `500` (compensating delete).
- **Orphan sweep** (read path): a `POST /api/admin/cleanup-orphans` **or** an
  RPC `sweep_storage_orphans()` invoked by the route, matching objects against
  rows, deleting both directions:
  - object with no row → delete object;
  - row with no object → mark or delete the row.
  Gate it: owner of a room for its own paths, plus a documented "operator runs
  this" path (no admin role exists — see "Out of scope").
- **Shared rate-limit mechanism** for upload endpoints (fixed-window counter in
  a small table, per user + per route key), because the roadmap assigns "rate
  limiting" here and PRs 07/09/11 are told to *use* the same key naming. Keep
  the mechanism generic: `rate_limits(key, window_start, count)`.
- **Download/serve review**: signed URL TTL reduced/verified, `Content-Disposition:
  attachment` for non-preview types, `X-Content-Type-Options: nosniff` where
  controllable, and confirmation that a signed URL never appears in a log line.
- Quota + limit errors surfaced as friendly UI messages in the upload flow.

### Out of scope

- Antivirus / malware scanning (needs an external engine or Supabase Edge
  function with a scanner — record as a standing question, do not stub).
- Image transcoding, thumbnails, video/audio handling (unsupported MIME types
  stay unsupported).
- Deduplication / content-addressed storage / checksum matching across users.
- Per-tenant or paid-plan quotas, billing, overage policy.
- An `admin` role or platform-wide dashboard. The sweep endpoint must not be
  world-writable; until an admin concept exists, scope it to "caller sweeps the
  rooms they can see" (RLS-driven) and document that a platform operator runs it
  with the service-role key outside the app.
- CDN, edge caching, bandwidth accounting.
- Changing the public/private bucket model.
- Client-side drag-drop improvements beyond error display.

---

### Frontend work

| File | Change |
| --- | --- |
| `components/resources/resource-upload.tsx` (or equivalent) | Pre-flight client checks mirroring the server: size cap, extension list, declared type agreement; inline error text for `413 payload_too_large`, `415 unsupported_media_type`, `429 rate_limited`, `409 quota_exceeded`, `500 upload_failed`. Keep `role="alert"` on failure, `role="status"` on success. |
| `components/resources/resource-library.tsx` | Show remaining quota if the list response includes `quota: { used_bytes, limit_bytes }`; disable upload when `409 quota_exceeded` is current (do not hide the control — explain it). |
| `lib/resources/upload.ts` | Enforce the same caps client-side before the put (fail fast, no wasted bytes), pass sniff result through. |

No new pages. No new navigation.

### Backend work

| Route | Behavior |
| --- | --- |
| `POST /api/rooms/[id]/resources` | Now: rate-limit check → size check → sniff → quota check → object put → row insert → **on insert failure, object delete, then `500`**. New error codes: `413 payload_too_large`, `415 unsupported_media_type`, `409 quota_exceeded`, `429 rate_limited`. Body/stream handling must not buffer the whole file in memory beyond the sniff window (read the first ≤16 bytes for magic, then stream). |
| `GET /api/rooms/[id]/resources` | Extend the response with `quota` (as above). |
| `POST /api/rooms/[id]/resources/[resourceId]/cleanup` (or `POST /api/rooms/[id]/maintenance/cleanup`) | Sweeps that room's paths vs rows; returns `{ removed_objects, removed_rows }`. Member-gated but effectively an owner action (document). |
| `DELETE /api/resources/[id]` | Unchanged contract, but now also covered by the same rate limiter and guaranteed to be row-first-then-object (already is) — verify no regression. |

Helpers: extend `lib/resources/upload.ts` with `assertUploadSize`,
`sniffMimeType`, `assertTypeAgreement`; new `lib/resources/quota.ts` for byte
totals; `lib/rate-limit/{check,keys}.ts` with stable key names
(`upload:{roomId}:{userId}`, `report:{roomId}:{userId}`, `invite:{roomId}:{userId}`).

### Database work

`supabase/migrations/0010_resource_hardening.sql`:

- `rate_limits(key text primary key, window_start timestamptz not null, count int not null)` —
  no `SELECT` grant for `authenticated` beyond own rows is irrelevant if all
  access is RPC; revoke all and expose **one** RPC:
  `rate_limit_take(p_key text, p_max int, p_window interval) returns boolean`
  (SECURITY DEFINER, `search_path = ''`, `insert … on conflict … returning`,
  atomic). Granted to `authenticated`; execute revoked from `public`/`anon`.
- Optional but recommended: `study_resources.uploaded_by uuid` is already
  present in `0005`; add nothing. Add a **stored byte total** is unnecessary —
  compute with `coalesce(sum(size_bytes),0)` in the quota RPC.
- RPC `resource_quota_ok(p_room_id uuid, p_add_bytes bigint) returns boolean` —
  SECURITY DEFINER, checks room + user totals against the configured limits
  (constants inside the function, documented in the migration header so they can
  be changed by editing one place; env-based config is out of scope).
- RPC `sweep_storage_orphans(p_room_id uuid) returns jsonb` — returns candidate
  paths for objects with no row **inside what SQL can see**; the actual storage
  delete happens in the route (SQL cannot call Storage). Concretely: the RPC
  lists `study_resources.storage_path` per room, the route lists the bucket's
  objects under that room prefix, the route computes the set difference and
  removes. Second direction (row with no object) is a route-level check against
  `storage.objects` metadata… **or** simply let download failures surface —
  choose the cheap direction and say so.
- No `UPDATE` grant widening on `study_resources`. If "mark row broken" is
  chosen instead of deleting the row, add `grant update (broken_at)` plus a
  policy; prefer deleting a row whose object is gone (it is unusable).
- No change to cascade rules in `0005`.

### Storage work

- The bucket's `file_size_limit` / `allowed_mime_types` public settings (set in
  Supabase dashboard or via config) are **set in addition to** app-level checks —
  belt and braces — and documented in `docs/local-supabase.md`. Since local dev
  uses `supabase start`, note the equivalent config file (`config.toml` storage
  section) if present, else document the dashboard step and verify with an
  integration probe that an oversized put is refused by storage too.
- Orphan removal uses the **user-scoped client** with the existing
  `storage.objects` delete policy (`owner = auth.uid()`), which works for the
  uploader's own orphans; for room-wide sweeps the room owner may hit the
  cross-user object problem documented in PR 08 — coordinate: this PR ships the
  per-object compensating delete (always uploader-scoped, always permitted) and
  the row-level sweep; cross-user object cleanup inherits PR 08's decision.
- Verify signed-URL TTL is the minimum useful value and that no route returns an
  absolute signed URL in a list payload (only on explicit fetch) — the
  `docs/API_CONTRACTS.md` "absolute signed URL" note says fetched-on-demand;
  assert it.

### Realtime work

None.

### AI work

None. (This PR is the floor PR 12 stands on: unbounded uploads would make any
RAG ingestion step a DoS vector.)

---

### Security requirements

A user must **not** be able to:

1. Upload a file larger than the documented cap (both at the app and, where
   configured, at the storage layer).
2. Upload bytes whose true type is outside the allow-list while claiming an
   allowed `Content-Type` — sniffing must catch extension/type disagreement,
   and an allowed-looking extension carrying HTML/JS content must be refused or
   stored with a safe disposition.
3. Exhaust the room's or their own quota by repeated uploads.
4. Trigger unbounded work: rate limits apply per user per route; the sweep
   endpoint is room-scoped and membership-gated.
5. Observe another user's quota numbers, or another room's orphan report.
6. Cause a permanent orphan on a failed insert (compensating delete), or leave
   one after a room delete (sweep + PR 08 ordering).
7. Turn the sniff path into a memory blow-up — only the header window is read.

Positive guarantees:

- Stored `mime_type` is derived from bytes, never trusted from the client.
- Every error is one of the documented codes; no stack traces; no internal path
  in messages.

### API contracts

| Endpoint | Success | New/changed errors |
| --- | --- | --- |
| `POST /api/rooms/[id]/resources` | `201 { resource }` (unchanged shape) | **413 `payload_too_large`**, **415 `unsupported_media_type`**, **409 `quota_exceeded`**, **429 `rate_limited`**, 400, 401, 404, 500 `upload_failed` |
| `GET /api/rooms/[id]/resources` | `200 { resources, quota: { used_bytes, limit_bytes } , has_more, total }` | unchanged |
| `POST /api/rooms/[id]/maintenance/cleanup` | `200 { removed_objects: n, removed_rows: m, room_id }` | 400, 401, 404, 500 `cleanup_failed` |

Contract additions to document: **max 25 MiB per file**; **allow-list** (pdf,
txt, md, csv, png, jpg, jpeg, webp, docx, pptx, xlsx — trim to what the
repo already accepts); **quota defaults**; **rate window** (suggest 10 uploads
per minute per user per room; invites 10/hour; reports 20/hour).

### Tests

**Unit**

- `sniffMimeType`: each allowed magic; a PDF renamed `.png`; an HTML file
  renamed `.pdf`; empty file; truncated header; UTF-8/UTF-16 text.
- Size guard boundary: exactly at cap (allowed), one byte over (`413`), declared
  `content-length` lie (actual stream length governs).
- Quota math: partial sums, zero-byte room, limit exactly reached, one over.
- Rate limiter: window rollover, `on conflict` increment, over-limit → false.
- Route files: error-code mapping (413/415/409/429), compensating delete called
  exactly once when the insert throws, and **not** called on success.
- `resource-upload.tsx` error states (`role="alert"`, remaining-quota text).

**Integration (`tests/integration/resource-hardening.test.ts`)**

- Oversized put refused with `413` and **no** `storage.objects` row created.
- Type confusion: bytes are PNG, extension `.pdf` → `415`, no row, no object.
- Quota: fill to limit → next upload `409`; after `DELETE`, space returns.
- Direct PostgREST insert into `rate_limits` → permission denied (no grant).
- Compensating delete: force an insert failure (e.g. transient constraint via a
  test-only path or by mocking) → assert object count unchanged. If forcing the
  failure is impractical in integration, prove the ordering by code-coverage in
  unit tests and say so.
- Sweep: create an object with no row (raw storage put as the uploader) → sweep
  removes it; create a row with no object (delete the object directly) → row
  removed or flagged per the chosen direction.
- Signed URL not present in list payload; present only on explicit fetch; TTL
  ≤ documented value.

**E2E (`tests/e2e/resource-hardening.spec.ts`)**

- Upload an over-limit file from the UI → clear inline message, library
  unchanged.
- Upload a `.exe` (or unsupported) → `415` surfaced as friendly copy, not a raw
  code.
- Normal PDF upload still works end-to-end (no regression of PR 4's flow).
- Quota-reached state renders the explanation.

### Dependencies

- None hard. Should land **before** PR 12 (AI ingestion) and is used by 07/09/11
  for rate-limit keys.
- Touches `POST /api/rooms/[id]/resources` — parallel to PR 17's read-side
  changes; if both are open, coordinate on `app/(app)/rooms/[id]/page.tsx` only
  via the upload component (low conflict risk).

### Files / modules likely affected

```
supabase/migrations/0010_resource_hardening.sql          (new)
lib/resources/upload.ts                                 (size/sniff/type)
lib/resources/quota.ts                                  (new)
lib/rate-limit/check.ts, keys.ts                        (new)
app/api/rooms/[id]/resources/route.ts                   (guards, quota in list)
app/api/rooms/[id]/maintenance/cleanup/route.ts         (new)
app/api/resources/[resourceId]/route.ts                 (rate limit + no regression)
components/resources/resource-upload.tsx                (client caps, errors)
components/resources/resource-library.tsx               (quota display)
tests/unit/lib/resources/upload.test.ts                 (new/extended)
tests/integration/resource-hardening.test.ts            (new)
tests/e2e/resource-hardening.spec.ts                    (new)
docs/API_CONTRACTS.md (limits rows), docs/SECURITY.md (upload threat model),
docs/local-supabase.md (bucket settings), docs/milestones.md
```

### Acceptance criteria

- [x] A file over the cap is refused with `413` and leaves no object behind.
- [x] Type-confused uploads are refused with `415`; stored `mime_type` is
      sniff-derived for accepted uploads (PR 05's sniff, unchanged and
      re-asserted).
- [x] Quota blocks the (limit+1)th byte-set with `409` and frees correctly on
      delete (integration: fill → refuse, delete → the next upload lands).
- [x] A failed row insert never leaves an object (PR 05's compensating delete,
      no regression) and a swept room reports `removed_objects ≥ 1` for a
      seeded orphan.
- [x] Rate limits reject over-limit requests with `429` and the UI says so.
- [x] Signed URLs are not in list payloads and not in logs (payload asserted in
      integration; no console statement in the resource routes or libraries
      emits a URL or token — verified by search).
- [x] The shared rate-limit keys are documented so PRs 07/09/11 use them
      (`docs/API_CONTRACTS.md` → "Rate limits (PR 10)").
- [ ] All three suites + build green locally and in CI. *(local: lint, types,
      778 unit / 265 integration / 38 e2e; CI ticked after the green run — see
      the PR's closing commit.)*

### Definition of Done

1. [x] `npx supabase db reset` from scratch; `rate_limits` and RPC probes pass
   (direct insert denied, `rate_limit_take` atomic under two concurrent calls).
2. [x] Bucket-level limits documented and, where config supports it locally,
   verified to reject an oversized put independently of the app (integration
   test pushes 20 MiB + 1 byte straight at storage — refused by
   `file_size_limit`, nothing written).
3. [ ] CI green on all three jobs.
4. [x] `docs/API_CONTRACTS.md` has explicit limit/quota/rate rows (the upload
   sequence section updated with the compensating-delete step);
   `docs/SECURITY.md` gains an upload abuse row; `docs/local-supabase.md`
   bucket section; `docs/milestones.md` resource rows updated.
5. [x] Rate-limit key naming published for other PRs.
6. [ ] Reviewed by Dev A.

### Owner

**Dev B — Cursor** (backend/storage/security).

### Estimated complexity

**Medium.** No product ambiguity, but byte-level plumbing (streaming sniff,
compensating delete, set-difference sweep) plus a generic rate limiter that
other PRs depend on — get the API of `rate_limit_take` right the first time.

### Risks

| Risk | Mitigation |
| --- | --- |
| Streaming + sniffing accidentally buffers the whole file | Read ≤16 bytes for the sniff, then pass the stream through; unit-test memory-bounded behavior indirectly (large synthetic upload in integration). |
| Storage-layer limits not settable in local config → false confidence | Document the gap; app-level check is the enforced one. |
| Sweep deletes a legitimate object whose row insert is still in flight | Guard with a grace period (`created_at`/object age < 60s → skip) in both directions. |
| Cross-user object cleanup blocked by storage policy | Delegate to PR 08's decision; ship uploader-scoped cleanup first. |
| Rate limiter becomes a shared bottleneck | Table is tiny, RPC is atomic upsert; document the window sizes. |
