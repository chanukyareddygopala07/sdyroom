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
| 409 | `used` / `rejected` / `revoked` / `room_full` / `room_closed` |
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

## Not implemented, on purpose

| Concern | Status |
| --- | --- |
| Rate limiting | **Not implemented.** No rate limiter exists anywhere in this app yet; adding one only for uploads would be inconsistent. Listed as a known limitation in `docs/SECURITY.md`. Invitation creation is bounded in the meantime by the one-pending-per-(room, invitee) index and the 1–168 h TTL bounds. |
| Malware scanning | **Not implemented and not claimed.** Only signature/UTF-8 validation runs. |
| Metadata editing (`PATCH`) | Not exposed. The `UPDATE` grant and policy exist and are exercised by the integration suite so the column set is provably narrow; no UI or endpoint needs renaming yet. |
| Public/permanent file URLs | Never. Only short-lived signed URLs. |
| Service-role usage at runtime | None. Every request runs on the cookie-scoped, user-privileged Supabase client. |
| Bearer invite links / `/invite/[token]` | **Superseded, not built.** PR 07's spec called for a single-use token URL; the shipped design addresses invitations to an alias instead (no token exists to leak, forward or enumerate). See the reconciliation in `docs/prs/PR-07-private-invitations.md`. |
| Inviting by email / phone / any contact data | **Never.** The app collects no contact data; delivery is the inbox itself. Revisit with PR 11 if product wants notifications. |
| Invitations to public rooms | Refused (`409 room_public`): `join_room` already handles public entry. |
| AI summaries / quizzes | Explicitly out of scope for this milestone. |
