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

## Existing endpoints (unchanged by PR 08)

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

## Room management (PR 08)

| Method | Path | Summary |
| --- | --- | --- |
| `PATCH` | `/api/rooms/[id]` | Owner-only partial edit of the mutable room fields |
| `DELETE` | `/api/rooms/[id]` | Owner-only room deletion — storage objects swept first, then one cascading row delete |

Both routes read identity from the session claims, validate the id with
`roomIdSchema`, and run the owner gate (`requireRoomOwner`) before any write:
a plain member gets `403 not_owner`, a non-member gets `404 not_found` — the
same `404` a missing room produces, so neither route is an existence oracle.
There is no `UPDATE`/`DELETE` grant on `rooms`: every write travels through the
`update_room` / `delete_room` SECURITY DEFINER RPCs from `0008`.

### Editable field contract

| Field | Rules |
| --- | --- |
| `name` | 1–100 chars, trimmed, required when present (blank is a `400`, not a clear) |
| `shared_goal` | `null` or ≤ 500 chars; a blank string is sent as `null` (clear) |
| `exam_track` | `null` or ≤ 80 chars |
| `subject` | `null` or ≤ 80 chars |
| `language` | `null` or ≤ 40 chars |
| `capacity` | integer 1–100, and ≥ the current member count (`409 capacity_below_membership` otherwise) |
| `status` | `open` or `closed` |

Everything else is unaddressable: `owner_id`, `visibility`, `id`,
`created_at` and `updated_at` are refused by the strict schema (unknown key →
`400 validation` naming the key), ignored by the RPC's fixed whitelist, and
denied by the absent column grants — three independent layers. An **empty body
is `400 invalid_request`** (matching the goals `PATCH` rule); an absent key
means "unchanged", which stays distinct from an explicit `null` meaning
"clear".

### `PATCH /api/rooms/[id]`

| Status | Body |
| --- | --- |
| 200 | `{ "room": PublicRoom }` — the row re-read from the database after the update, shaped by `toPublicRoom()` (never the caller's input echoed back; `updated_at` is moved by the `0001` trigger) |
| 400 | `{ "error": { "code": "validation" \| "invalid_json" \| "invalid_request" } }` |
| 401 | `{ "error": { "code": "unauthenticated" } }` |
| 403 | `{ "error": { "code": "not_owner" } }` |
| 404 | `{ "error": { "code": "not_found" } }` — non-member or missing room |
| 409 | `{ "error": { "code": "capacity_below_membership", "message": "…current member count (n)…" } }` — capacity unchanged |
| 500 | `{ "error": { "code": "room_update_failed" } }` — no SQL detail leaks |

Repeated identical submissions are `200` again, not an error.

### `DELETE /api/rooms/[id]`

Order of operations (documented in the route docblock):

1. Owner gate — `401` / `404` / `403` before anything is touched.
2. Sweep `rooms/{roomId}/**` out of the private bucket (`removeRoomStorageObjects`)
   while the `study_resources` rows the storage policies authorize against still
   exist — the `0008` room-owner delete policy lets the owner remove
   member-uploaded objects; a failure here is `500 cleanup_failed` with **every
   row still in place**, so a retry re-runs the same idempotent sweep.
3. `delete_room` — one cascading row delete (`room_members`,
   `focus_sessions`, `study_goals`, `room_messages`, `room_invitations`,
   `study_resources`) under the room row lock.

| Status | Body |
| --- | --- |
| 200 | `{ "deleted": true }` |
| 400 | `{ "error": { "code": "validation" } }` |
| 401 | `{ "error": { "code": "unauthenticated" } }` |
| 403 | `{ "error": { "code": "not_owner" } }` |
| 404 | `{ "error": { "code": "not_found" } }` — non-member, missing, or already deleted (a repeat DELETE lands here because the memberships that authorize the gate are gone) |
| 500 | `{ "error": { "code": "cleanup_failed" \| "delete_failed" } }` — room intact, retry converges |

Storage is not transactional with Postgres, so one interleaving cannot be
closed: an object uploaded *after* the sweep's listing but whose row commits
*before* `delete_room` is left orphaned in a private bucket — unreachable (no
row, no membership, no URL) and bounded by two adjacent calls. Objects-before-
rows was chosen because the inverse would leave rows advertising downloads that
can never succeed.

A closed room stays in public discovery with a `Closed` badge (members keep
chat, files, timers and goals; only `join_room` is refused).

---

## Study resources (PR 05)

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
| `SWEEP_GRACE_MS` | `60_000` — orphans younger than this are never swept |

Storage quotas (constants inside `0010_resource_hardening.sql`, not TS
constants — the database is the single source of truth):

| Quota | Value |
| --- | --- |
| Per user (every file the caller owns, personal and shared) | 1 GiB (`1 073 741 824` bytes) |
| Per room (every file shared with that room) | 500 MiB (`524 288 000` bytes) |

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
| 200 | `{ "resources": [Resource], "quota": {…}, "limit": n, "offset": n, "has_more": bool }` |
| 400 | `{ "error": { "code": "validation" } }` |
| 401 | `{ "error": { "code": "unauthenticated" } }` |
| 404 | `{ "error": { "code": "not_found" } }` — `room_id` names a missing room or one the caller is not a member of (a malformed `room_id` is the `400` above) |
| 500 | `{ "error": { "code": "resources_failed" } }` |

`quota` is the byte budget for the scope being listed:

```json
{
  "scope": "user",
  "used_bytes": 4194304,
  "limit_bytes": 1073741824,
  "user_used_bytes": 4194304,
  "user_limit_bytes": 1073741824
}
```

`scope` is `user` for `scope=personal` and `room` for `room_id=…`;
`used_bytes` / `limit_bytes` describe that scope, and the `user_*` pair always
describes the caller's personal budget (identical to the first pair on a
personal listing, so the UI can render one line either way). Limits come from
migration `0010`: **1 GiB per user, 500 MiB per room**. The API answers `500`
if the quota query fails — never a partial `200`. The library *page* treats
the quota as display-only: it catches the same failure, renders without the
"X of Y used" line and without locking the form, and leaves enforcement to
the upload route and the database trigger.

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

**Server-side sequence** (abuse controls first, in cost order)

1. Authenticate (`401` first, before any validation detail is revealed).
2. Refuse a `content-length` over 20 MiB + 256 KiB of multipart envelope with
   `413`, before the body is buffered.
3. Consume the caller's overall upload slot — `upload:user:{id}`, 20 per
   60 s — and answer `429 rate_limited` (+`Retry-After: 60`) before a single
   byte of multipart is parsed.
4. Parse the multipart body (not multipart at all → `400 invalid_request`).
5. Reject unknown parts, a missing/oversized `file`, and bad metadata with Zod;
   validate size, filename shape and magic bytes; derive `content_type`.
6. Consume the target's slot — `upload:{room|personal}:{id}`, 10 per 60 s —
   now that the body has revealed which library this upload is aimed at.
7. If `room_id` is present, confirm current room membership (`404` otherwise).
8. Quota pre-check (`resource_quota_ok`): an over-limit upload is `409
   quota_exceeded` before anything is written. This check *fails open* — an
   error reading the total is logged and the upload proceeds, because step 10
   is the authority.
9. Generate the resource UUID and a storage path built **only** from trusted
   values: `personal/{owner}/{id}{ext}` or `rooms/{room}/{owner}/{id}{ext}`.
10. Upload to the private `study-resources` bucket.
11. Insert the metadata row with the same id and path. The
    `study_resources_quota_guard` trigger re-decides the quota inside this
    inserting transaction (under per-user and per-room advisory locks), so
    racing uploads resolve to exactly one winner; a refusal raises
    `quota_exceeded`, which the route answers as `409`.
12. If step 11 fails, remove the object from step 10 and answer `500` with a
    safe message (or `409` when the trigger refused — the object is removed in
    either case).

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
| 409 | `quota_exceeded` | The upload would cross the caller's 1 GiB or the room's 500 MiB budget |
| 413 | `file_too_large` | Over 20 MiB |
| 415 | `unsupported_file_type` | Extension/signature not in the allow list |
| 429 | `rate_limited` | The caller's or the target's upload window is spent (`Retry-After: 60`) |
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
| 429 | `{ "error": { "code": "rate_limited" } }` — 120 signed URLs per 60 s (`Retry-After: 60`) |
| 500 | `{ "error": { "code": "download_failed" } }` |

`url` is absolute on the configured Supabase API origin (the origin comes from
`NEXT_PUBLIC_SUPABASE_URL`, never from the request), so the browser can open it
directly. An expired token produces `403` from the storage service at fetch time;
the client is expected to re-request a fresh URL rather than reuse the old one.

The URL carries `&download=<original filename>` (single URL-encoded, appended
after signing — the signature covers the object, not this flag), so the storage
service answers the fetch with
`Content-Disposition: attachment; filename="…"`, `Expires` exactly 300 s after
`Date`, and `X-Robots-Tag: none`. Files in this app are downloaded, never
rendered from the storage origin; that disposition is also why the missing
`X-Content-Type-Options` header (which the storage origin does not send) is
accepted as a documented limitation in `docs/SECURITY.md`. The URL appears only
in this response — listings never embed one.

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
| 429 | `{ "error": { "code": "rate_limited" } }` — 30 deletions per 60 s (`Retry-After: 60`) |
| 500 | `{ "error": { "code": "delete_failed" } }` |
| 500 | `{ "error": { "code": "cleanup_failed" } }` |

---

### `POST /api/resources/cleanup`

Sweeps **the caller's own key prefix** for orphaned bytes, repairing both
failure directions an interrupted upload can leave behind:

- **Object with no row** — a crash between the object put and the row insert.
  Nothing can ever sign a URL for it (the bucket is private and reads are
  row-driven), so it is removed.
- **Row with no object** — the object vanished out of band. The row advertises
  a download that can never succeed, so it is removed.

| Body | Scope |
| --- | --- |
| `{}` (or no body) | `personal/{caller}/**` |
| `{ "room_id": "<uuid>" }` | `rooms/{room}/{caller}/**` — the caller's uploads in that room; membership is proven first |

Everything younger than `SWEEP_GRACE_MS` (60 s) is skipped in both
directions — an upload that is mid-flight (object written, row not yet
inserted) is never mistaken for an orphan. The comparison is restricted to
the caller's own prefix on both sides: `storage_path LIKE 'personal/{id}/%'`
(and the storage DELETE policy's `owner = auth.uid()`) mean a sweep can only
ever touch files the caller uploaded; a member sweeping a room cleans their
own contributions, never anyone else's. The route runs the sweep itself
because SQL cannot call the Storage API. Rate limit: `cleanup:user:{id}`,
5 per 60 s, taken *before* the body is read.

| Status | Body |
| --- | --- |
| 200 | `{ "removed_objects": n, "removed_rows": n, "scope": "personal" \| "room", "room_id": uuid \| null }` |
| 400 | `{ "error": { "code": "invalid_json" \| "invalid_request" \| "validation" } }` |
| 401 | `{ "error": { "code": "unauthenticated" } }` |
| 404 | `{ "error": { "code": "not_found" } }` — `room_id` names a missing room or one the caller is not a member of |
| 429 | `{ "error": { "code": "rate_limited" } }` (`Retry-After: 60`) |
| 500 | `{ "error": { "code": "cleanup_failed" } }` — a listing failure aborts before anything is deleted (an incomplete view of the folder would make "not listed" a lie); rows are deleted in one statement; a retry is safe |

---

## Private room invitations and the member roster (PR 07)

An invitation is **addressed**, not a link: the owner names a student by their
SdyRoom alias, and only that student can see or act on it. There is no token,
no public invite URL and no "whoever holds the link" surface — knowing an
invitation id grants nothing, because every transition re-derives `auth.uid()`
inside the RPC and compares it to `invitee_id`. The recipient's view is the
inbox at `/invitations` (`GET /api/invitations`); the owner's view is the
invite panel inside the private room's workspace.

Invitations exist for **private rooms only** (a public room is joinable by
anyone, so an invitation there is refused with `409 room_public`), and only
the room's owner may create or revoke one.

### Invitation shape

```json
{
  "id": "5f0e4a12-…",
  "room_id": "0a9c3d77-…",
  "room_name": "Physics 101",
  "inviter_alias": "e2e-owner-alias",
  "invitee_alias": "e2e-member-alias",
  "status": "pending",
  "created_at": "2026-10-07T11:04:52.120+00:00",
  "expires_at": "2026-10-14T11:04:52.120+00:00",
  "resolved_at": null,
  "expired": false
}
```

| Field | Rules |
| --- | --- |
| `id` | UUID, generated server-side; possession of it proves nothing on its own |
| `status` | `pending` ⇔ `resolved_at IS NULL`; terminal states `accepted` / `rejected` / `revoked` carry `resolved_at`. There is **no stored `expired` state** |
| `expires_at` | `created_at + ttl_hours`, `ttl_hours` 1–168 (default 168); checked at read time — an expired pending row answers `410 expired` and is never written |
| `expired` | Derived by the reader (`pending` and past `expires_at`), mirroring the database's read-time evaluation |
| `inviter_alias` / `invitee_alias` / `room_name` | Denormalised display copies (the two parties cannot read each other's profile or the private room row) |
| — | Responses never carry `inviter_id`, `invitee_id` or any email; no token field exists |

At most **one pending invitation per (room, invitee)** — a partial unique
index absorbs the create race, and the loser is answered `409
already_invited`. A resolved row never blocks a fresh invite later.

### `POST /api/rooms/[id]/invitations`

Owner only. Body `{ "invitee_alias": string, "ttl_hours"?: 1–168 }`
(`.strict()` — an unknown field such as `invitee_id` is a `400` that names
it). The alias is resolved inside the RPC.

| Status | Code | Cause |
| --- | --- | --- |
| 201 | — | `{ "invitation": Invitation }` |
| 400 | `validation` / `invalid_json` / `invalid_request` | Bad id, bad body, unknown field |
| 401 | `unauthenticated` | No session |
| 403 | `not_owner` | Member of the room, not its owner |
| 404 | `not_found` | Missing room, or private-from-outside (indistinguishable) |
| 404 | `invitee_not_found` | No student with that alias |
| 409 | `room_public` | Invitations are for private rooms only |
| 409 | `self_invite` | The owner invited themselves |
| 409 | `already_member` | The alias already has a seat |
| 409 | `already_invited` | A pending invitation for this (room, invitee) exists |
| 429 | `rate_limited` | 10 invitations per 3600 s per (room, inviter) — `Retry-After: 3600` |
| 500 | `invitation_create_failed` | |

### `GET /api/rooms/[id]/invitations`

Owner only; newest first. RLS narrows rows to the caller's own, and the
owner gate runs first so a plain member gets `403` instead of an empty list.

`200 { "invitations": [Invitation] }` · `401` · `403 not_owner` · `404` ·
`500 invitations_failed`.

### `DELETE /api/rooms/[id]/invitations/[invitationId]`

Owner only → `200 { "revoked": true }`. The RPC re-proves inviter *and*
current owner, locks the row and refuses anything already resolved: an
accepted invitation is no longer an invitation, so it answers `404` — as does
a repeat revoke of the same row, with no way to tell the two apart.

`400` (either id not a UUID) · `401` · `403 not_owner` · `404 not_found` ·
`500 invitation_revoke_failed`.

### `GET /api/invitations`

The caller's inbox (rows where they are the invitee), newest first.
`200 { "invitations": [Invitation] }` · `401` · `500 invitations_failed`.

### `POST /api/invitations/[id]/accept`

Session-only; the body, if any, must be empty (`400 invalid_request` if it
carries fields). Identity comes from the session — the id in the path is the
only argument. One RPC decides everything in one transaction: status gate,
read-time expiry, capacity through the shared join core (the private-room
gate opened only after a pending invitee row is proved), then the flip to
accepted.

| Status | Body |
| --- | --- |
| 201 | `{ "membership": "joined", "room_id", "room_name", "member_count" }` |
| 200 | `{ "membership": "already_member", … }` — idempotent repeat; the invitation is still consumed |
| 400 | `validation` (id not a UUID) / `invalid_request` (non-empty body) |
| 401 | `unauthenticated` |
| 404 | `not_found` — missing, not addressed to the caller, or revoked: all identical |
| 409 | `used` / `rejected` / `revoked` / `room_full` / `room_closed` / `blocked` (the invitee has blocked the inviter — `409`, symmetric with the chat filter) |
| 410 | `expired` — no row is written |
| 500 | `invitation_accept_failed` |

### `POST /api/invitations/[id]/reject`

Same shape; flips a pending row to `rejected` in place (history is kept, the
seat is not taken). `200 { "rejected": true }` · `400` · `401` · `404` ·
`409 used` (already accepted) / `409 rejected` (already rejected) · `410
expired` · `500 invitation_reject_failed`.

### `GET /api/rooms/[id]/members`

Member only — `requireRoomMembership` first, then the `room_roster` RPC
re-checks membership inside its own transaction, so a non-member gets the
same `404` as a missing room. Returns display alias, role and join time
only: **no user ids, no emails, and no live presence** (presence is PR 06's
ephemeral channel; the roster annotates rows client-side from it).

`200 { "members": [{ "alias", "role", "joined_at" }], "count": n }` ·
`400 validation` · `401` · `404 not_found` · `500 members_failed`.

---

## Moderation, reporting and blocking (PR 09)

| Method | Path | Summary |
| --- | --- | --- |
| `POST`/`GET` | `/api/rooms/[id]/reports` | File a report / the moderator inbox listing |
| `PATCH` | `/api/reports/[reportId]` | Advance one report through its status machine |
| `DELETE` | `/api/rooms/[id]/members/[alias]` | Remove a member from the room |
| `POST`/`DELETE` | `/api/rooms/[id]/members/[alias]/mute` | Mute / unmute a member |
| `POST`/`DELETE` | `/api/rooms/[id]/members/[alias]/moderator` | Appoint / revoke a room moderator (owner only) |
| `POST`/`GET` | `/api/blocks` | Block a student / list the caller's own blocks |
| `DELETE` | `/api/blocks/[alias]` | Unblock |

All of it is **room-scoped moderation**: the owner and the aliases in
`room_moderators` can act, and there is no global admin role anywhere in the
schema. Every privileged mutation writes exactly one `moderation_actions` row
in the same transaction as the mutation; those tables carry no `INSERT` grant
at all, so only the SECURITY DEFINER RPCs can write them.

### `POST /api/rooms/[id]/reports`

Membership is proven first (`404 not_found` for a non-member — never a
room-existence oracle), then the strict body union: `{ subject_type: "user",
subject_alias }` or `{ subject_type: "message" | "resource", subject_id }`,
plus `reason` (closed enum) and optional `detail` (≤500 chars). The reporter
identity is **never read from the body** — `create_moderation_report` pins
`reporter_id = auth.uid()` — and no response ever contains it.

`201 { "report": { "id", "status", "created_at" } }` ·
`200 { "report": {…}, "duplicate": true }` (idempotent repeat of an open
report by the same reporter on the same subject) · `400 validation` /
`invalid_json` · `401` · `404 not_found` (non-member or unknown subject) ·
`409 self_report` · `429 rate_limited` (20 reports per 3600 s per reporter,
per room — `Retry-After: 3600`) · `500 report_failed`.

### `GET /api/rooms/[id]/reports`

Owner or moderator only — a plain member gets `403 not_moderator`, a
non-member the usual `404`. Returns the moderator projection (`id`,
`subject_type`, `subject_id`, `subject_alias`, `reason`, `detail`, `status`,
`created_at`, `resolved_at`, `resolved_by`) plus `count`. `reporter_id` has
**no column grant at all**: there is nothing to select and nothing to leak.

`200 { "reports": [...], "count": n }` · `400` (bad room id or `limit`) ·
`401` · `403 not_moderator` · `404` · `500 moderation_failed`.

### `PATCH /api/reports/[reportId]`

Body `{ "status": "reviewing" | "resolved" | "dismissed" }`. The report id
is opaque and the room never enters the path, so a caller who is not a
moderator of the report's room receives **`404 not_found` — the same answer
a missing id gets** (no existence oracle). `pending` cannot be set (`400
validation`) and terminal states never reopen (`409 invalid_transition`).
Each transition writes one `moderation_actions` row (`report_reviewed` /
`report_resolved` / `report_dismissed`).

`200 { "report": { "id", "status" } }` · `400` · `401` · `404` ·
`409 invalid_transition` · `500 report_failed`.

### `DELETE /api/rooms/[id]/members/[alias]`

Bodyless. Owner or moderator; the owner (`403 cannot_remove_owner`) and self
(`403 cannot_remove_self`) are refused, a plain member attempting it gets
`403 not_moderator`, a non-member `404`. Deletes the membership, writes one
`member_removed` audit row and returns the new count. The target loses the
roster, chat history, room resources and presence immediately — every read
is RLS, and the API routes answer `404`.

`200 { "removed": true, "member_count": n }` · `401` · `403` · `404` ·
`500 moderation_failed`.

### `POST` / `DELETE …/members/[alias]/mute`

`POST { "duration": "1h" | "24h" | "7d" }` → `201 { "muted": true,
"muted_until", "duration" }`. The actor gate runs first (`403
not_moderator`), then **self** (`cannot_mute_self` — so an owner cannot mute
themselves), the owner (`cannot_mute_owner`) and other moderators
(`cannot_mute_moderator`); an active mute is `409 already_muted`. `DELETE`
lifts → `200 { "unmuted": true }`, or `409 not_muted`. Both verbs share one
window — 30 changes per 3600 s per (room, moderator) — and answer `429
rate_limited` (`Retry-After: 3600`) when it is spent. The mute is enforced
twice — in the RPC and in the `room_messages` INSERT policy — so a direct
PostgREST insert cannot bypass it; the composer sees `403 muted` and the
muted member's own page disables it up front.

### `POST` / `DELETE …/members/[alias]/moderator`

Owner only (`403 not_owner`), bodyless. `POST` appoints, `DELETE` revokes;
the target must be a member and can never be the owner (`403
cannot_moderate_owner`). `200 { "role": "moderator" | "student", "changed":
bool, "granted": bool }` — `changed: false` is the idempotent repeat and
writes no audit row. Appointment is an alias row in `room_moderators`;
revocation takes effect on the target's next authorization check.

### `POST /api/blocks` · `GET /api/blocks` · `DELETE /api/blocks/[alias]`

Blocks are **private to the blocker**: `GET` only ever returns rows whose
`blocker_id` is the caller, and no payload anywhere says who blocked whom.
`POST { "alias" }` → `201 { "block": { "alias", "created_at" }, "created":
true }`, repeat → `200 { …, "created": false }`, self-block → `409
self_block`, unknown alias → `404`. `DELETE` → `200 { "removed": bool }`
(idempotent). Both verbs share one window — 30 changes per 3600 s per user —
and answer `429 rate_limited` (`Retry-After: 3600`) when it is spent.

Blocking is enforced by one clause on the `room_messages` **SELECT** policy:
the blocker stops receiving the target's messages — history, direct reads
and live arrival alike, since `postgres_changes` is subject to the
subscriber's own RLS — and invitation acceptance between the two is refused
(`409 blocked`) until unblocked. The blocked user keeps seeing the blocker's
messages and is told nothing.

### Moderation error codes

| Status | Code | When |
| --- | --- | --- |
| 400 | `validation` / `invalid_json` / `invalid_request` | bad body, unknown field, malformed id |
| 401 | `unauthenticated` | no session |
| 403 | `not_moderator` / `not_owner` / `cannot_remove_owner` / `cannot_remove_self` / `cannot_mute_owner` / `cannot_mute_moderator` / `cannot_mute_self` / `cannot_moderate_owner` / `muted` (chat send) | privesc or forbidden target; the room is already proven visible, so 403 leaks nothing |
| 404 | `not_found` | room not visible, member or subject not in the room, report not visible to a non-moderator |
| 409 | `self_report` / `self_block` / `already_muted` / `not_muted` / `invalid_transition` / `blocked` (invitation accept) | state conflicts; a duplicate report answers idempotent `200`, not 409 |
| 429 | `rate_limited` | the route's shared window is spent — see "Rate limits" below |
| 500 | `report_failed` / `moderation_failed` / `blocks_failed` | hygiene |

Every throttle in this document is one mechanism — see
**[Rate limits](#rate-limits-pr-10)** for the key naming, the windows and the
fail-open rule.

---

## Notifications (PR 11)

| Method | Path | Summary |
| --- | --- | --- |
| `GET` | `/api/notifications` | The caller's own inbox, newest first |
| `GET` | `/api/notifications/unread-count` | The header badge's cheapest read |
| `POST` | `/api/notifications/[notificationId]/read` | Mark one own notification read |
| `POST` | `/api/notifications/read-all` | Mark every own unread row read |
| `PATCH` | `/api/profile/notification-prefs` | Per-category delivery preferences |

All four reader/writer routes are session-gated and **scoped to the caller's
own rows by RLS** — there is no id that reaches somebody else's notification
(a foreign or missing id is the same `404`, so the endpoints are not
existence oracles). The table carries no `INSERT` grant for any application
role: rows are created only by the two SECURITY DEFINER producer RPCs
(`push_notification`, `push_report_notification`) in `0011_notifications.sql`,
each with a closed producer rule table documented in the migration header
and proven by the integration suite. `href` is **derived at read time** from
the row's `type`/`room_id` (map in `lib/notifications/types.ts`), never
stored, so a route change cannot leave stale links behind. The reader routes
are deliberately unthrottled, matching the repo's rule for own-row paginated
reads (see "Rate limits" below).

### `GET /api/notifications`

Query `?limit=20&cursor=<opaque>&unread=true`. The cursor is the opaque
base64url keyset (`created_at|id`); `unread=true` narrows the page to unread
rows. The unread count rides the same response so neither the inbox page nor
the bell spends a second round trip.

`200 { "notifications": [{ "id", "type", "room_id", "payload": { "title",
"body", "href" }, "read_at", "created_at" }], "has_more", "next_cursor",
"total", "unread_count" }` · `400 validation` · `401` ·
`500 notifications_failed`.

### `GET /api/notifications/unread-count`

One indexed count of the caller's own unread rows through the invoker's-rights
`notifications_unread_count()` RPC. Deliberately separate from the list so the
bell never downloads rows it will not show.

`200 { "unread_count": 3 }` · `401` · `500 notifications_failed`.

### `POST /api/notifications/[notificationId]/read`

Bodyless; identity comes from the session and the row from the path.
Idempotent by contract: an already-read row answers `200 { "read": true,
"unchanged": true }`.

`200 { "read": true, "unchanged": bool }` · `400 validation` /
`invalid_request` (bad id or non-empty body) · `401` · `404 not_found` ·
`500 notifications_failed`.

### `POST /api/notifications/read-all`

Bodyless. One statement under the own-row RLS policy — it updates exactly
the rows the same caller could list. The count returned is rows actually
touched, so a second call reports `{ "updated": 0 }`.

`200 { "updated": 3 }` · `400 invalid_request` (non-empty body) · `401` ·
`500 notifications_failed`.

### `PATCH /api/profile/notification-prefs`

Body `{ "prefs": { "invite": "none", … } }` — every key optional, every value
from the closed enum `all | mentions_and_invites | none`, unknown keys a
`400`. The partial body is merged over the stored record; the writer RPCs
re-read it at **write time**, so a change binds the very next notification
with nothing to cache or invalidate. The category map: `invite` (invitations),
`moderation` (mutes, removals, report outcomes), `resource` (processing
updates), `ai` (task completion), plus a `default` key for anything
unmapped; `system` events ignore preferences and always deliver. The
preferences form currently mounts on the inbox page — PR 20's settings page
will absorb it unchanged.

`200 { "prefs": { "default": "all", "invite": "all", "moderation": "all",
"ai": "all", "resource": "all" } }` · `400 validation` / `invalid_json` ·
`401` · `500 notifications_failed`.

### Producers (the only writers)

Exactly two producer RPCs exist, both SECURITY DEFINER, both returning a
jsonb envelope (`created` / `deduped` / `muted` / `validation` /
`not_authorized` / `not_found` / `invalid_payload`) rather than a bare id —
the repo's envelope convention. Two RPCs, not one, because the reporter's
uuid never travels through a route: `push_report_notification` derives it
from the report row (the PR-09 rule), and `push_notification` takes a
target alias resolved through the existing `moderation_resolve_alias` RPC.

| Type | Producer route (retrofitted in this PR) | Who may produce it |
| --- | --- | --- |
| `invite_created` | `POST /api/rooms/[id]/invitations` | the room's owner (caller must own the room) |
| `muted` | `POST …/members/[alias]/mute` | owner or moderator of the room |
| `member_removed` | `DELETE …/members/[alias]` | owner or moderator of the room |
| `report_resolved` | `PATCH /api/reports/[reportId]` (on `resolved`/`dismissed` only) | a moderator of the report's room — reporter identity read from the row, never the body |
| `invite_accepted`, `resource_ready`, `ai_task_complete`, `system`, `moderation_resolved` | reserved | self only (`p_user_id = auth.uid()`); not yet emitted |

Deduplication: an unread row with the same `dedupe_key` is **collapsed** —
`created_at` and `payload` update, one row survives, the RPC answers
`deduped` — enforced by a partial unique index so two concurrent producers
cannot stack duplicates. A read row never blocks a new one. Rate limiting:
none on the reader routes (own-row reads); the two producer routes inherit
the rate limits their parent mutation routes already carry.

---

## Rate limits (PR 10)

One mechanism serves every throttled route: the `rate_limits` table
(`key`, `window_start`, `count`) and a single SECURITY DEFINER RPC,
`rate_limit_take(key, max, window) returns boolean` — one `INSERT … ON
CONFLICT` statement, so the counter is the database and behaves identically
on one dev machine or many app instances. A route "takes" a slot for its key
and proceeds only while the take returns `true`.

- **Shape.** `429 { "error": { "code": "rate_limited", "message": "…" } }`
  with a `Retry-After` header naming the window in seconds. Messages are
  route-specific ("Too many uploads — wait about a minute and try again.").
- **Fixed window** starting at the first take; the next take after the window
  opens a fresh counter. Keys are opaque strings
  (`route[:scope]:user-id`), so a new route adopts the mechanism without a
  migration.
- **Fails open.** If the limiter itself cannot be consulted the request is
  allowed and the failure is logged: traffic shaping must not turn a database
  hiccup into an outage, and the quota trigger and RLS guard correctness
  regardless. Only an explicit `false` from the RPC refuses.
- **Reads are not throttled.** Page loads and paginated listings stay
  unbounded — their cost is bounded by pagination — while every state-changing
  or storage-touching route above carries a window.
- The table has **no grants and no RLS policies**: direct PostgREST access is
  refused on privilege grounds before policy evaluation, and the app never
  holds a key other than through the RPC.

| Route(s) | Key | Max / window |
| --- | --- | --- |
| `POST /api/resources` (per-user ceiling, taken before the body) | `upload:user:{userId}` | 20 / 60 s |
| `POST /api/resources` (per target, after the body names it) | `upload:{roomId\|personal}:{userId}` | 10 / 60 s |
| `DELETE /api/resources/:id` | `resource_delete:user:{userId}` | 30 / 60 s |
| `GET /api/resources/:id/download` | `download:user:{userId}` | 120 / 60 s |
| `POST /api/resources/cleanup` | `cleanup:user:{userId}` | 5 / 60 s |
| `POST /api/rooms/[id]/reports` | `report:{roomId}:{userId}` | 20 / 3600 s |
| `POST /api/blocks` · `DELETE /api/blocks/[alias]` | `block:user:{userId}` | 30 / 3600 s |
| `POST` / `DELETE` `…/members/[alias]/mute` | `mute:{roomId}:{userId}` | 30 / 3600 s |
| `POST /api/rooms/[id]/invitations` | `invite:{roomId}:{userId}` | 10 / 3600 s |

These numbers are part of the contract (`lib/rate-limit/keys.ts` is the
implementation mirror); change both together. The per-user/per-target split on
uploads means one account cannot do unbounded work overall, and cannot
concentrate all of it on one room or library.

---

## Not implemented, on purpose

| Concern | Status |
| --- | --- |
| Rate limiting | **Implemented for the routes listed in "Rate limits"** (PR 10): uploads, deletes, signed-URL issuance, sweeps, reports, blocks, mutes and invitations. Session-gated pages and paginated reads are deliberately unthrottled; PR 11's notification reader routes follow the same rule (own-row reads, no throttle) while its two producer RPCs ride the parent mutation routes' existing windows. |
| Malware scanning | **Not implemented and not claimed.** Only signature/UTF-8 validation runs. |
| Metadata editing (`PATCH`) | Not exposed. The `UPDATE` grant and policy exist and are exercised by the integration suite so the column set is provably narrow; no UI or endpoint needs renaming yet. |
| Public/permanent file URLs | Never. Only short-lived signed URLs. |
| Service-role usage at runtime | None. Every request runs on the cookie-scoped, user-privileged Supabase client. |
| Bearer invite links / `/invite/[token]` | **Superseded, not built.** PR 07's spec called for a single-use token URL; the shipped design addresses invitations to an alias instead (no token exists to leak, forward or enumerate). See the reconciliation in `docs/prs/PR-07-private-invitations.md`. |
| Inviting by email / phone / any contact data | **Never.** The app collects no contact data; delivery is the in-app inbox (PR 11). Notifications stay inside the product — no email, push or SMS was added, and none is planned. |
| Invitations to public rooms | Refused (`409 room_public`): `join_room` already handles public entry. |
| Global `/moderation` dashboard | **Not built.** Reports are room-scoped and authorization is per-room; the moderation inbox mounted in the room workspace is the product contract (PR 09's reconciliation). |
| Message removal / soft-hide | **Never in v1.** `room_messages` keeps no `UPDATE`/`DELETE` grant and no hidden columns — moderators act at the member level (mute/remove) and reports carry the context. |
| AI summaries / quizzes | Explicitly out of scope for this milestone. |
