# API contracts

Every SdyRoom endpoint answers JSON. Success bodies are shaped resources; every
failure uses the single envelope built by `lib/api/responses.ts`:

```json
{ "error": { "code": "…", "message": "…", "issues": [{ "path": "…", "message": "…" }] } }
```

`issues` appears whenever the failure can be attributed to a field — a Zod
parse, an unknown multipart part, a rejected filename. Codes are stable machine
strings; messages are user-facing English. No endpoint ever returns a stack
trace, a SQL string, a storage path, a bucket name, a signed URL for a resource
the caller may not read, another user's id, or an email address.

Authentication is always read from the Supabase session claims. No endpoint
accepts an owner id, a user id or a storage path from the client.

Shared conventions:

- Session-gated pages export `instant = false` because the app runs with
  `cacheComponents`.
- `/api/*` routes are exempt from the auth redirect in
  `lib/supabase/proxy.ts`, so a fetch client receives the documented JSON
  `401` instead of an HTML redirect.
- `404 not_found` is deliberately the answer for "does not exist" *and*
  "exists but you may not see it", so no endpoint is an existence oracle.

---

## Existing endpoints (unchanged by this milestone)

| Method | Path | Summary |
| --- | --- | --- |
| `GET` | `/api/rooms` | Shaped public rooms |
| `POST` | `/api/rooms` | `create_room` RPC |
| `POST` | `/api/profile` | One-time study alias |
| `GET` | `/api/rooms/[id]/workspace` | Room + focus session + counts |
| `GET`/`POST` | `/api/rooms/[id]/messages` | Chat history page / append |
| `GET`/`POST` | `/api/rooms/[id]/goals` | Caller's own goals in a room |
| `PATCH`/`DELETE` | `/api/goals/[goalId]` | Update / remove one goal |
| `POST` | `/api/rooms/[id]/join` · `/leave` | Membership |
| `POST` | `/api/rooms/[id]/session/start` · `/pause` · `/resume` · `/end` | Focus timer |

See `README.md` for the full table.

---

## Study resources (this milestone)

A *resource* is one uploaded study file: a PDF, a PNG/JPEG scan of handwritten
notes, or a plain-text/Markdown note. Every response is scoped to what the
viewer may already read through RLS.

### Resource shape

```json
{
  "id": "0f1d2c3b-…",
  "title": "Rotational dynamics — class notes",
  "original_filename": "rotation-notes.pdf",
  "content_type": "application/pdf",
  "size_bytes": 184320,
  "subject": "Physics",
  "chapter": "Rotational motion",
  "room_id": null,
  "created_at": "2026-10-07T11:04:52.120+00:00",
  "updated_at": "2026-10-07T11:04:52.120+00:00"
}
```

| Field | Rules |
| --- | --- |
| `id` | UUID, generated server-side |
| `title` | 1–120 chars, trimmed, no control characters |
| `original_filename` | 1–255 chars, no path separators, no `..`, no control characters |
| `content_type` | One of the sniffed allow-list types below — never the browser's claim |
| `size_bytes` | 1 … 20 MiB (20 971 520 bytes) |
| `subject` | `null` or 1–80 chars, trimmed |
| `chapter` | `null` or 1–80 chars, trimmed |
| `room_id` | `null` = personal; a UUID = shared with that room |
| `created_at` / `updated_at` | Written by PostgreSQL |

`owner_id` and `storage_path` are **never** in a response.

### Limits and accepted formats

| Constant | Value |
| --- | --- |
| `MAX_FILE_BYTES` | `20 * 1024 * 1024` (20 MiB) |
| `MAX_TITLE_CHARS` | 120 |
| `MAX_SUBJECT_CHARS` | 80 |
| `MAX_CHAPTER_CHARS` | 80 |
| `MAX_FILENAME_CHARS` | 255 |
| `DOWNLOAD_TTL_SECONDS` | 300 |

| Declared type | Magic bytes checked at offset 0 | Extensions accepted |
| --- | --- | --- |
| `application/pdf` | `%PDF-` | `.pdf` |
| `image/png` | `89 50 4E 47 0D 0A 1A 0A` | `.png` |
| `image/jpeg` | `FF D8 FF` | `.jpg` `.jpeg` |
| `text/plain` | valid UTF-8, no NUL, no binary control bytes | `.txt` |
| `text/markdown` | valid UTF-8, no NUL, no binary control bytes | `.md` `.markdown` |

The **server** decides the content type by sniffing the first bytes of the
payload. The browser-supplied MIME type and the file extension are used only to
cross-check the guess; a mismatch is rejected rather than trusted. This is
*format* validation, not malware scanning — **no malware scanner is configured
in this project, and none is claimed.**

---

### `GET /api/resources`

List the caller's resources. Two mutually exclusive scopes:

| Query | Scope |
| --- | --- |
| `scope=personal` (default) | Only rows with `room_id IS NULL` owned by the caller |
| `room_id=<uuid>` | Rows shared with a room the caller is currently a member of |

Additional filters, all optional and combinable:

| Query | Rule |
| --- | --- |
| `q` | Case-insensitive substring match on `title`, 0–100 chars |
| `subject` | Case-insensitive exact match, ≤ 80 chars |
| `chapter` | Case-insensitive exact match, ≤ 80 chars |
| `limit` | Integer 1–100, default 50 |
| `offset` | Integer ≥ 0, default 0 |

Passing both `scope` and `room_id` is a `400`.

**Responses**

| Status | Body |
| --- | --- |
| 200 | `{ "resources": [Resource], "limit": n, "offset": n, "has_more": bool }` |
| 400 | `{ "error": { "code": "validation" } }` |
| 401 | `{ "error": { "code": "unauthenticated" } }` |
| 404 | `{ "error": { "code": "not_found" } }` — `room_id` names a missing room or one the caller is not a member of (a malformed `room_id` is the `400` above) |
| 500 | `{ "error": { "code": "resources_failed" } }` |

Ordering is `created_at DESC, id DESC`. `has_more` compares `offset +
resources.length` against an exact row count of the whole filtered scope (RLS
applied), so a final page shorter than `limit` still reports `false`.

---

### `POST /api/resources`

`multipart/form-data` upload.

| Part | Required | Rules |
| --- | --- | --- |
| `file` | yes | see limits and formats above |
| `title` | yes | 1–120 chars, trimmed, no control characters |
| `subject` | no | ≤ 80 chars, trimmed, blank → `NULL` |
| `chapter` | no | ≤ 80 chars, trimmed, blank → `NULL` |
| `room_id` | no | UUID; when present the caller must be a current member of that room |

**Unknown parts are rejected, not ignored.** Any extra field — including
`owner_id`, `user_id`, `storage_path`, `content_type` or `size_bytes` — yields
`400 invalid_request` with the offending field names. Identity always comes
from the session, so a forged owner id can never be honoured.

**Server-side sequence**

1. Authenticate (`401` first, before any validation detail is revealed).
2. Refuse a `content-length` over 20 MiB + 256 KiB of multipart envelope with
   `413`, before the body is buffered.
3. Parse the multipart body (not multipart at all → `400 invalid_request`).
4. Reject unknown parts, a missing/oversized `file`, and bad metadata with Zod.
5. Validate size, filename shape and magic bytes; derive `content_type`.
6. If `room_id` is present, confirm current room membership (`404` otherwise).
7. Generate the resource UUID and a storage path built **only** from trusted
   values: `personal/{owner}/{id}{ext}` or `rooms/{room}/{owner}/{id}{ext}`.
8. Upload to the private `study-resources` bucket.
9. Insert the metadata row with the same id and path.
10. If step 9 fails, remove the object from step 8 and answer `500` with a safe
    message.

**Responses**

| Status | Code | Cause |
| --- | --- | --- |
| 201 | — | `{ "resource": Resource }` |
| 400 | `validation` | Zod rejected a metadata field |
| 400 | `invalid_request` | An unknown multipart part was present |
| 400 | `invalid_filename` | Path separators, `..`, control characters, empty or > 255 chars |
| 400 | `empty_file` | Zero bytes |
| 400 | `malformed_file` | Signature does not match the declared type, or text is not valid UTF-8 |
| 401 | `unauthenticated` | No session |
| 404 | `not_found` | `room_id` names a missing room or one the caller has left |
| 413 | `file_too_large` | Over 20 MiB |
| 415 | `unsupported_file_type` | Extension/signature not in the allow list |
| 500 | `storage_upload_failed` | Storage refused the object |
| 500 | `metadata_failed` | Row insert failed after the object was written (object is removed first) |

---

### `GET /api/resources/:id/download`

Re-checks authorization on **every** call and returns a short-lived signed URL.
The signed URL itself is the authorization token for the bytes: anyone holding
it may fetch for `expires_in` seconds, which is why it is never permanent and
never issued to an unauthorized caller.

| Status | Body |
| --- | --- |
| 200 | `{ "url": "…", "expires_in": 300, "resource_id": "…" }` |
| 400 | `{ "error": { "code": "validation" } }` — `:id` is not a UUID |
| 401 | `{ "error": { "code": "unauthenticated" } }` |
| 404 | `{ "error": { "code": "not_found" } }` — missing, deleted, or not visible to the caller |
| 500 | `{ "error": { "code": "download_failed" } }` |

`url` is absolute on the configured Supabase API origin (the origin comes from
`NEXT_PUBLIC_SUPABASE_URL`, never from the request), so the browser can open it
directly. An expired token produces `403` from the storage service at fetch time;
the client is expected to re-request a fresh URL rather than reuse the old one.

---

### `DELETE /api/resources/:id`

Only the uploader may delete a resource — including a resource they shared with
a room. Membership revocation alone already removes read access; deleting
removes it for everyone, including the uploader.

**Order of operations:** resolve the row under RLS, confirm the caller owns it
(a room member may read a shared file and still never reaches the write — the
owner is read back out of the server-built storage key, never from the
request), then the storage object is removed, then the metadata row.

- Object removal is idempotent, so a retry after a partial failure always
  converges.
- If object removal fails, nothing has changed: `500 cleanup_failed` and a
  retry is safe.
- If the row deletion fails after the object is gone, `500 delete_failed` is
  returned and a retry completes the deletion.
- The security-relevant direction (row removed, object left) is the one that is
  *not* chosen: a leftover object in a private bucket is unreachable once its
  row is gone, whereas a row without an object would advertise a download that
  can never succeed.

| Status | Body |
| --- | --- |
| 200 | `{ "deleted": true }` |
| 400 | `{ "error": { "code": "validation" } }` |
| 401 | `{ "error": { "code": "unauthenticated" } }` |
| 404 | `{ "error": { "code": "not_found" } }` — not yours, or already gone |
| 500 | `{ "error": { "code": "delete_failed" } }` |
| 500 | `{ "error": { "code": "cleanup_failed" } }` |

---

## Not implemented, on purpose

| Concern | Status |
| --- | --- |
| Rate limiting | **Not implemented.** No rate limiter exists anywhere in this app yet; adding one only for uploads would be inconsistent. Listed as a known limitation in `docs/SECURITY.md`. |
| Malware scanning | **Not implemented and not claimed.** Only signature/UTF-8 validation runs. |
| Metadata editing (`PATCH`) | Not exposed. The `UPDATE` grant and policy exist and are exercised by the integration suite so the column set is provably narrow; no UI or endpoint needs renaming yet. |
| Public/permanent file URLs | Never. Only short-lived signed URLs. |
| Service-role usage at runtime | None. Every request runs on the cookie-scoped, user-privileged Supabase client. |
| AI summaries / quizzes | Explicitly out of scope for this milestone. |
