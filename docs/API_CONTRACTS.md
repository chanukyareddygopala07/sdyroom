# API contracts

Every SdyRoom endpoint answers JSON. Success bodies are shaped resources; every
failure uses the single envelope built by `lib/api/responses.ts`:

```json
{ "error": { "code": "…", "message": "…", "request_id": "…", "issues": [{ "path": "…", "message": "…" }] } }
```

`issues` appears whenever the failure can be attributed to a field — a Zod
parse, an unknown multipart part, a rejected filename. `request_id` appears on
error responses produced inside a request (PR 18): the same value is echoed in
the `x-request-id` response header and attached to every log line for that
request, so a user-visible error is always correlatable with the server-side
line that explains it. Callers may supply their own id (`x-request-id` header,
8–128 chars of `[A-Za-z0-9_-]`); anything malformed is replaced with a minted
uuid. Codes are stable machine
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

## Live meetings

| Method | Path | Summary |
| --- | --- | --- |
| `POST` | `/api/rooms/[id]/meeting/token` | Mint a short-lived LiveKit join token for this member and this room |

The route takes an empty JSON body on purpose: nothing in the request is
trusted. Identity comes from the session claims (the token's opaque
participant identity), the room id is validated as a UUID, and membership is
proven with `requireRoomMembership` — a non-member, a removed member and a
missing room all answer the same `404 not_found`. The display name is the
caller's own profile alias, read through RLS.

An active room mute maps into the token grants: the microphone is dropped
from `canPublishSources`, so a muted student joins, watches, shares their
screen and keeps using chat, but cannot publish audio until the mute lifts
and they rejoin. Grants never include room-admin, room-create, room-list,
recording, ingress or own-metadata-update powers. Signing uses
`LIVEKIT_API_SECRET` (server-only, documented in `.env.example`); the
response carries the signed token and never the secret, and nothing in the
token or the logs ever contains the study room's title or any PII beyond the
caller's chosen alias — the LiveKit room name is `sdyroom-<room uuid>`.

Rate limit: `meeting_token:{roomId}:{userId}` — 12 mints per 60 s per
(room, member).

| Status | Body |
| --- | --- |
| 200 | `{ "token": "…", "url": "wss://…", "room": "sdyroom-<uuid>", "identity": "<user id>", "expires_in": 600, "can_publish_mic": true }` |
| 400 | `validation` · `invalid_json` · `invalid_request` (a body that carries fields) |
| 401 | `unauthenticated` |
| 404 | `not_found` — missing room, or you are no longer a member |
| 429 | `rate_limited` — 12 mints per 60 s per (room, member), `Retry-After: 60` |
| 503 | `meeting_unavailable` — no provider configured on this server; checked before the rate limit, so an unconfigured deployment spends no slot |
| 500 | `meeting_token_failed` — signing or the alias lookup failed; no detail leaks |

The `url` is only ever learned from this response: no `NEXT_PUBLIC_*` LiveKit
variable exists, so the browser bundle carries no provider endpoint of its
own. Ten minutes (`expires_in: 600`) covers a join plus immediate retries;
an established LiveKit session stays alive across reconnects, and a dropped
token stays useless for long. The room workspace only offers the meeting
view when the server reports a provider configured (`isMeetingConfigured`),
so the `503` exists for a configuration change between page load and the
request — the honest answer either way.

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
(`push_notification`, `push_report_notification`) in `0012_notifications.sql`,
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
preferences form mounts on the inbox page and, since PR 20, on the settings
page — the same component in both places.

`200 { "prefs": { "default": "all", "invite": "all", "moderation": "all",
"ai": "all", "resource": "all" } }` · `400 validation` / `invalid_json` ·
`401` · `429 rate_limited` (`notification_prefs:{userId}`, 30 / 60 s,
`Retry-After`) · `500 notifications_failed`.

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

## Profile and settings (PR 20)

| Method | Path | Summary |
| --- | --- | --- |
| `GET` | `/api/profile` | The caller's own profile row, shaped for the settings page |
| `PATCH` | `/api/profile` | Partial edit of `alias`, `exam_targets` and/or `language` |

Both routes are id-less: identity comes from the session claims, so there is
no profile id in any URL or body and no foreign id to forge. `GET` answers
`200 { profile: { alias, exam_targets, language, notification_prefs, email,
created_at } }` — `email` comes from the session claims (the `profiles`
table stores none), `created_at` is cut to a date at render time
(`iso.slice(0, 10)`, never a locale-dependent format), and
`notification_prefs` is read back through this response so the settings page
and PR 11's writer share exactly one store. Read-only GETs are unthrottled
(the repo's rule for own-row reads).

`PATCH` takes a strict partial body: unknown keys are `400 validation`
(before any rate-limit take), an empty object is `400 invalid_request` (the
same rule as the goal `PATCH`), an absent key leaves its field alone, and
`language: null` clears the preference. No row is not an error to paper over
— it answers `404 not_found` (the session has not finished onboarding; the
settings page redirects to `/onboarding` instead of calling).

| Error | Code |
| --- | --- |
| 400 | `validation` (unknown fields, out-of-vocabulary `exam_targets`/`language`, alias out of bounds) · `invalid_request` (empty body) |
| 401 | `unauthenticated` |
| 403 | `forbidden` (RLS refused the write) |
| 404 | `not_found` (profile row absent) |
| 409 | `alias_taken` (case-insensitive collision — `profiles_alias_lower_key`) |
| 429 | `rate_limited` (`profile:{userId}`, 30 / 60 s, `Retry-After`) |
| 500 | `profile_read_failed` / `profile_update_failed` |

Field contracts:

- `alias` — 1–32 chars, trimmed, start alphanumeric, no control characters,
  **case-insensitively unique** (shared `aliasSchema`, the `0001` CHECKs and
  the `profiles_alias_lower_key` index are the authority; collisions are
  `409`, and whether duplicates should ever be permitted again is a standing
  product question, not a gap).
- `exam_targets` — 0–3 values from `lib/vocab/exam-tracks.ts` (`NEET`,
  `JEE`, `UPSC`, `SSC`, `CAT`, `GATE`); a hand-crafted value outside the
  list is `400` and the row is untouched.
- `language` — from `lib/vocab/languages.ts` (`English`, `Hindi`,
  `Hinglish`, `Telugu`, `Tamil`) or `null`; the column itself only carries
  the structural 1–40 trimmed checks (`0023`), so widening the list is a
  code change, never a migration.
- `notification_prefs` — never written by this route; it is produced only by
  `PATCH /api/profile/notification-prefs` (PR 11) and consumed here.

Protected fields are rejected by the strict schema (`id`, `user_id`,
`email`, `created_at`, `updated_at` in a body → `400 validation`), and the
database floor agrees: the `profiles` column grants name their columns
explicitly, so none of those fields has an `update` grant at all — the
integration suite probes PostgREST directly, gets `42501`, and confirms the
row is byte-identical. There is no public profile route anywhere:
`GET /api/profile` returns only the session's own row.

---

## AI document foundation (PR 12)

| Method | Path | Summary |
| --- | --- | --- |
| `POST` | `/api/ai/ingest/[resourceId]` | Advance one document's ingest state by exactly one step |
| `POST` | `/api/ai/ingest/sweep` | Pick up stuck ingest rows and advance each by one `auto` step |
| `GET` | `/api/ai/usage?room_id=` | Today's AI spend for one scope |

All three are session-gated, and the database owns every gate: `ingest_begin`
re-checks ownership/membership plus the size and type gates against
`ai_resource_for_ingest` (0013), independently of the route. The routes own
transport only — session → path id → rate limit → body → dispatch → the
documented envelope. The execution model is deliberately client-driven (no
queue, no daemon): each request advances **one bounded step** (≤ ~2 s), so a
tab closed mid-ingest leaves a *resumable* row rather than a broken one, and
`POST /api/ai/ingest/sweep` is the resume aid.

### `POST /api/ai/ingest/[resourceId]`

The body is optional and strict: an absent or empty body means `{}`, which
means `{"step":"auto"}` — the resumable default the client loop and the sweep
both use. An explicit step is `{ "step": "extract" | "chunk" | "embed" |
"auto" }`. Malformed JSON is `400 invalid_json`; an unknown field (a forged
`{ "force": true }`, say) is `400 validation` naming the key, never a field
that is quietly ignored; a path id that is not a UUID is `400 validation`.

**Dispatch matrix** (exactly as `lib/ai/ingest.ts` states it):

| stored status | `auto` | explicit step |
| --- | --- | --- |
| `ready` / `failed` | noop | noop (`step_done` = requested step) |
| `extracting` | extract | extract runs; chunk/embed noop (chunk/embed out-of-order → `step_done: null`) |
| `chunking` | chunk | chunk runs; embed out-of-order → null; extract already done → `step_done: "extract"` |
| `embedding` | embed | embed runs; extract/chunk report as done / out-of-order |

A `pending` row dispatches exactly like `extracting` (`ingest_begin` creates a
new row at `extracting`; `pending` stays a valid stored state for manually
created rows). An explicit step that runs **out of order** is a noop answering
`step_done: null` — nothing is claimed for work that has not happened — while
a step the document is already past reports itself as done. Re-running a
completed step is idempotent, and a `failed` row is never advanced by the
sweep: it waits for an explicit retry (the "Index now" action, which
`ingest_begin` resumes).

**200 response** — `200 { "status", "step_done", "chunks?", "tokens?",
"model?", "provider?", "error_code?" }`:

| Field | Meaning |
| --- | --- |
| `status` | Stored status after the call: `pending` / `extracting` / `chunking` / `embedding` / `ready` / `failed` |
| `step_done` | `extract` / `chunk` / `embed`, or `null` when nothing ran |
| `chunks` / `tokens` / `model` | Present when the document is `ready` or when `step_done` is non-null: chunk count, embedding tokens, embedding model |
| `provider` | Set only when this call actually embedded — the provider used (`openai` or `mock`) |
| `error_code` | Present whenever the document carries a failure code (see the status model below) |

**Document outcomes are `200` states, not HTTP errors.** `200 { "status":
"failed", "step_done": null, "error_code": "no_text_layer" }` (a scanned PDF)
is an honest answer about the document, not a transport failure. HTTP errors
are the published codes:

| Status | Code | Cause |
| --- | --- | --- |
| 400 | `validation` / `invalid_json` | Path id not a UUID, malformed body, or an unknown body field |
| 401 | `unauthenticated` | No session (taken before the rate limit and the body) |
| 403 | `not_resource_owner` / `not_member` / `ai_quota_exceeded` | Personal file you do not own / room file for a room you are not in / the scope's 50 MiB daily embed cap is spent — the route pre-checks the cap and rejects before any provider call, while `ingest_record_chunk` re-checks it inside the write as the race-safe authority |
| 404 | `not_found` | Resource missing or not visible to the caller |
| 413 | `too_large` | Over the 20 MiB ingest ceiling — re-checked against the stored row *and* against the actual downloaded object |
| 415 | `unsupported_media_type` | Content type is not one of the indexable types (unreachable through the routes — `ingest_begin` gates types first; defense in depth) |
| 429 | `rate_limited` | 30 ingest steps per 60 s (`Retry-After: 60`) |
| 502 | `ai_provider_failed` | The provider call failed or returned an incomplete batch — the row is left at `embedding` + `error_code`, resumable, never silently `ready` |
| 500 | `ingest_failed` | Unexpected RPC or state-machine failure; no SQL detail leaks |

### `POST /api/ai/ingest/sweep`

Optional, strict body: `{}`, `{ "room_id" }` or `{ "room_id", "limit" }`.
`limit` is an integer 1–50 (default 10); an unknown field is `400
validation`, malformed JSON `400 invalid_json`. A `room_id` is
membership-proven **before any work runs** — a non-member gets the same
`404 not_found` as a missing room (no existence oracle).

A row is eligible when its `status` is not `ready` or `failed`, its
`error_code` is `NULL`, and its `updated_at` is older than five minutes;
eligible rows are advanced one `auto` step each, oldest first. Only rows the
caller can already read appear (RLS does the scoping), and rows carrying an
`error_code` are excluded on purpose — those wait for a human to press "Index
now", not for a sweep. A row that errors mid-sweep never abandons the rest: it
still appears in the answer with whatever status it now holds.

`200 { "picked": n, "statuses": [{ "resource_id": "…", "status": "…" }] }` ·
`400 validation` / `invalid_json` · `401 unauthenticated` ·
`404 not_found` (a `room_id` the caller is not a member of) · `429
rate_limited` (6 sweeps per 60 s, `Retry-After: 60`) · `500 ingest_failed`.

### `GET /api/ai/usage?room_id=`

The query is optional and strict: `room_id` must be a UUID when present
(a malformed or unknown field is `400 validation`), is membership-proven
(`404 not_found` for a non-member, identical to a missing room), and absent
means the caller's personal scope.

It reads the same `ai_usage_daily` RPC the embed cap enforces, so what this
endpoint reports and what the database refuses can never drift: personal spend
counts per user, room spend counts per room, both against the same **50 MiB
per scope per day** budget.

`200 { "used_bytes": n, "used_tokens": n, "limit_bytes": 52428800, "provider":
"mock" | "openai" }` · `400 validation` · `401 unauthenticated` ·
`404 not_found` · `500 usage_unavailable`.

### Status model and error codes

`pending → extracting → chunking → embedding → ready | failed` — the
`study_ai_documents.status` CHECK from 0013, displayed on each resource row by
`components/ai/ai-status.tsx`:

| Stored state | Chip |
| --- | --- |
| no row / `pending` | `Not indexed` |
| `extracting` | `Indexing… reading` |
| `chunking` | `Indexing… chunking` |
| `embedding` | `Indexing… embedding` |
| `ready` | `Ready for AI` |
| any state carrying an `error_code` | `Failed — <reason>` |

`error_code` wins over `status` for display: an embed failure deliberately
keeps the row at `embedding` (so it stays resumable) but renders as the
failure it is. The closed list, with the chip's wording:

| `error_code` | Meaning | Chip |
| --- | --- | --- |
| `no_text_layer` | PDF has no text layer (scanned/image-only — no OCR in scope) | `Failed — no text layer` |
| `extract_failed` | Extraction threw for this file | `Failed — couldn't read the file` |
| `extracted_too_large` | Extracted text over 16 MiB | `Failed — extracted text too large` |
| `ingest_failed` | Unexpected pipeline or RPC failure | `Failed — indexing failed` |
| `ai_quota_exceeded` | The scope's daily embed cap was reached | `Failed — daily AI limit reached` |
| `ai_provider_failed` | The provider call failed | `Failed — AI service unavailable` |

### Internal contract: `retrieve()` (not a route)

`lib/ai/retrieve.ts` is **the single retrieval entry point PRs 13–16 build
on**: embed the query with the configured provider → `match_document_chunks`
(the only function allowed to read `document_chunks.embedding`) → a light
rerank (score threshold + top-k window) → citation assembly.

```ts
retrieve(client, { roomId, query, topK?, threshold?, resourceIds? })
  → { chunks: Array<{ resourceId, chunkId, text, score, page?, heading,
                      citation: { n, resourceId, title, href, page? } }>,
      citations: Array<{ resourceId, title, href, pages?: number[] }>,
      usage: { embedTokens: number } }
```

| Contract | Rule |
| --- | --- |
| `roomId` | `string \| null` — `null` scopes the search to the caller's personal documents |
| `topK` | default 8, clamped to 1–50 (`RETRIEVAL_MAX_TOP_K`) |
| `threshold` | default 0.2; below it chunks are dropped, so `{ chunks: [], citations: [] }` is an ordinary outcome (a refusal), not an error |
| `resourceIds` | optional narrowing applied **after** the RPC (which already scoped rows to what the caller may read — a filter can only shrink visibility): `undefined`/`null` means no narrowing, an empty array matches nothing, and the top-k window is counted after the filter |
| `usage.embedTokens` | the query embedding's token spend, so ask flows can ledger retrieval honestly (`embed_tokens`) |
| `citation.href` | always a route that exists today: `/resources` for a personal file, `/rooms/{roomId}` for a room file — never a storage URL |
| `citation.n` | 1-based position in `citations`, so a prompt assembler can number sources without rebuilding the map; citations are de-duplicated per resource, best-first, each with its distinct `pages` |
| Authorization | Room scope is enforced **inside** the 0013 `match_document_chunks` SECURITY DEFINER RPC: a non-member gets zero rows even with a perfectly crafted embedding, personal scope pins `owner_id = auth.uid()`, and only `ready` documents are ever matched |
| Untrusted data | Retrieved chunk text is data, never instructions — callers keep it in the user/app part of a prompt, never in the system prompt (see `docs/SECURITY.md`) |
| Failures | Provider errors propagate as `502 ai_provider_failed` (no mock fallback); an RPC outage surfaces to callers as `retrieval_failed` |

Nothing here writes the usage ledger — embed spend is recorded by the ingest
RPCs, and ask/quiz flows record their own (PR 13+).

---

## Ask my notes (PR 13)

| Method | Path | Summary |
| --- | --- | --- |
| `POST` | `/api/rooms/[id]/ask` | One room-scoped RAG question; the answer arrives as an NDJSON stream |
| `GET` | `/api/rooms/[id]/ask/history?limit=&cursor=` | The caller's own Q/A history for the room, newest first |
| `GET` | `/api/rooms/[id]/ask/documents` | The room documents the scope selector shows (`resource_id`, `title`, `status`, `chunks`) |

All three are session-gated and membership-proven (a non-member gets the same
`404` as a missing room — no existence oracle). The pipeline is
`runAsk` (`lib/ai/ask.ts`): indexed-documents gate → double-submit replay →
chat-quota pre-check → `retrieve()` (optionally narrowed by `resource_ids`) →
one completion over the kept excerpts only → answer finalization →
`record_qa`, the history table's **only** insert path.

### `POST /api/rooms/[id]/ask`

Strict body: `{ "question", "resource_ids"?, "conversation_id"? }` — the
question is trimmed to 1–2000 characters; `resource_ids` is at most 25 UUIDs
and only narrows what RLS already allows; `conversation_id` is an optional
client-generated UUID grouping turns (the server invents one when absent and
always echoes it in `done`). Unknown fields are `400 validation`, malformed
JSON `400 invalid_json`.

**200** is an `application/x-ndjson` stream of exactly this shape:

```
{"type":"citations","citations":[{"n":1,"resource_id":"…","title":"…","href":"/rooms/…","pages":[3]}]}
{"type":"delta","text":"…"}
{"type":"done","qa_id":"…","conversation_id":"…","usage":{"prompt_tokens":n,"completion_tokens":n,"retrieval_tokens":n,"retrieved_chunks":n,"chat_used_today":n,"chat_limit":100000}}
```

`citations` is the retrieval pipeline's citations (renumbered after the
context budget keeps its excerpts); the single `delta` carries the finalized
answer — orphan `[n]` markers stripped, an application-built `Sources:` line
appended from those same citations; `done` names the persisted row. The
provider seam is one-shot today, so the stream is citations → one delta →
done, with the contract already shaped for future real streams. Every failure
is decided **before** the first event, so a non-2xx answer is a plain JSON
envelope; a connection that drops mid-stream is finished client-side from the
missing `done` (and a server-side mid-stream failure, should one ever open,
arrives as a terminal `{"type":"error","code"}` line).

**Double-submit:** the same question in the same conversation within 60 s
replays the existing row (same `qa_id`, no second provider call, no second
ledger write) — enforced inside `record_qa`, so two racing submits cannot
double-spend either.

**Refusal path:** when nothing clears the retrieval threshold, the answer is
the canned honest sentence ("I could not find that in your documents."), the
completion is never called, citations are `[]`, and the row still records the
query embedding's tokens with `retrieved_chunks: 0`.

| Status | Code | Cause |
| --- | --- | --- |
| 400 | `validation` / `invalid_json` | Bad room id, bad body field, unknown field, or malformed JSON |
| 401 | `unauthenticated` | No session (taken before the rate limit and the body) |
| 403 | `ai_quota_exceeded` | The per-user daily chat-token cap (100 000) is spent — the route pre-checks today's own-row `chat_tokens` sum and rejects before any provider call; `record_qa` re-checks the same set inside the write as the race-safe authority |
| 404 | `not_found` | Room missing or the caller is not a member |
| 409 | `no_documents_indexed` | No `ready` document in the room (or in the caller's `resource_ids` selection) |
| 429 | `rate_limited` | 20 asks per 60 s per room+user (`Retry-After: 60`) |
| 502 | `ai_provider_failed` | Provider or retrieval failure — no mock fallback when a real provider is configured |
| 500 | `ask_failed` | Unexpected failure; no SQL detail leaks |

### `GET /api/rooms/[id]/ask/history`

`?limit=20&cursor=<opaque>` — the shared opaque `created_at|id` cursor; the
limit is 1–50. Only the caller's own rows come back (0018 policy: own rows
**and** room membership, so history disappears with the seat). Token
accounting never leaves the database: the column-scoped SELECT (0018) grants
only `id, room_id, conversation_id, user_id, question, answer, citations,
created_at` — a wildcard SELECT is `insufficient_privilege`.

`200 { "items": [{ "id", "question", "answer", "citations",
"conversation_id", "created_at" }], "next_cursor": string | null }` ·
`400 validation` (bad limit or cursor) · `401` · `404` ·
`500 conversation_history_failed`.

### `GET /api/rooms/[id]/ask/documents`

`200 { "documents": [{ "resource_id", "title", "status", "chunks" }] }` —
every room document RLS lets the member see, statuses included so the UI can
explain a `pending`/`processing`/`failed` file instead of hiding it; only
`ready` rows are askable. `401` · `404` · `500 documents_failed`.

### Internal contract: `record_qa` (0018)

The table's only insert path (SECURITY DEFINER, execute granted to
`authenticated` only): pins `user_id = auth.uid()`, re-checks membership,
validates the row, deduplicates the 60-second double-submit window, enforces
the daily chat cap, writes the `chat_tokens` (+ optional retrieval
`embed_tokens`) ledger in the same transaction, and returns
`{ qa_id, conversation_id, created_at, deduped, chat_used_today,
chat_limit }`. Application roles hold no `INSERT`/`UPDATE`/`DELETE` grant on
`study_qa` at all.

---

## AI quizzes and flashcards (PR 14)

A member generates a revision quiz or a flashcard deck from the room's (or
their own personal) indexed documents. One artifact row is one generated item;
its answer key lives server-side in the `payload`, the client can never write
it, and a quiz is scored by the database — a forged `score` in a request body
is ignored because the schema does not read one.

| Method | Path | Summary |
| --- | --- | --- |
| `POST` | `/api/rooms/[id]/generate` | Start one quiz or deck build (creates a `generating` artifact) |
| `POST` | `/api/rooms/[id]/generate/[artifactId]/step` | Advance one bounded generation step (retrieve → complete → validate → `complete_artifact`) |
| `GET` | `/api/rooms/[id]/artifacts?kind=` | The room's generated quizzes/decks, newest first |
| `GET` | `/api/rooms/[id]/artifacts/[artifactId]` | One artifact with its full payload |
| `DELETE` | `/api/rooms/[id]/artifacts/[artifactId]` | Creator only; cascades attempts and review rows |
| `POST` | `/api/rooms/[id]/quizzes/[artifactId]/attempts` | Submit one quiz attempt (server-scored) |
| `GET` | `/api/rooms/[id]/quizzes/[artifactId]/attempts` | The caller's own attempts, newest first |
| `POST` | `/api/rooms/[id]/decks/[artifactId]/review` | Grade one flashcard (SM-2-lite schedule) |
| `GET` | `/api/rooms/[id]/decks/[artifactId]/due` | The caller's own review state for every card + `due_count` |

The resumable step model is the one PR 12's ingest established: a build
survives a dropped connection without an in-memory task, and a second step
after `ready`/`failed` is idempotent (`deduped: true`, no second provider
call). All nine routes are session-gated and membership-proven (a non-member
gets the same `404` as a missing room). The step route is additionally
creator-only (a non-creator probing a step gets `403 not_creator` and never
learns the artifact's status). The pipeline is `lib/ai/generate.ts`, over the
same `retrieve()` PR 13 uses; with no `AI_*` key the mock provider emits a
deterministic payload and the UI shows the demo banner.

### `POST /api/rooms/[id]/generate`

Strict body (snake_case, `flashcards` is the user-facing alias of the stored
kind `deck`):

```json
{ "mode": "quiz", "difficulty": "medium", "count": 10, "resource_ids": ["…"], "question_types": ["mcq", "tf"] }
```

`difficulty` (`easy`|`medium`|`hard`) and `count` (quiz: 5/10/15/20, deck:
10/20/40) are required; `resource_ids` (1–25 UUIDs) and `question_types`
(≥1 of `mcq`/`tf`) are optional. Unknown fields are `400 validation`.
A `resource_ids` entry that is forged, foreign or not-ready pins the whole
request to `409 no_documents_indexed` (the app cannot distinguish forged
from unindexed, and a `404` would be an existence oracle) — no artifact row
is written. An empty selection means the whole ready set.

**201** `{ "artifact": { "id", "kind", "status": "generating", "difficulty", "question_count", "card_count", "created_at", "href" } }`.
The client then drives `step` until the artifact is `ready` or `failed`.

| Status | Code | Cause |
| --- | --- | --- |
| 400 | `validation` / `invalid_json` | Bad body field, unknown field, malformed JSON, bad room id |
| 401 | `unauthenticated` | No session (taken before the rate limit and the body) |
| 403 | `ai_quota_exceeded` | Per-user daily chat-token cap (100 000) would be exceeded |
| 404 | `not_found` | Room missing or the caller is not a member |
| 409 | `no_documents_indexed` | A requested resource id is forged/foreign, or has no `ready` document |
| 429 | `rate_limited` | 10 generate+step calls per 60 s per room+user (`Retry-After: 60`) |
| 500 | `generate_failed` | Unexpected failure; no SQL detail leaks |
| 502 | `ai_provider_failed` | Provider or retrieval failure (no mock fallback when a real provider is configured) |

### `POST /api/rooms/[id]/generate/[artifactId]/step`

No body. One bounded step: re-check creator → `retrieve()` over the pinned
resource ids → prompt (untrusted excerpts in the user message only, PR-13
discipline) → provider completion → parse-validate (`lib/ai/quiz/validate.ts`)
→ `complete_artifact`. Malformed model output fails the artifact with
`ai_provider_failed` and answers 502 — never a `ready` row.

**200** `{ "status": "ready" | "failed", "question_count"?, "card_count"?, "model", "provider", "error_code"?, "deduped" }`.
`deduped: true` means the artifact was already terminal and no work ran.

| Status | Code | Cause |
| --- | --- | --- |
| 401 | `unauthenticated` | No session |
| 403 | `not_creator` / `ai_quota_exceeded` | Non-creator probing a step, or the chat cap is spent |
| 404 | `not_found` | Room/artifact missing, or the caller is not a member |
| 409 | `no_documents_indexed` | A pinned document is no longer `ready` |
| 429 | `rate_limited` | Same 10/60 s generate window |
| 500 | `generate_failed` | Unexpected failure |
| 502 | `ai_provider_failed` | Provider or retrieval failure, or malformed model output |

### `GET /api/rooms/[id]/artifacts?kind=`

`?kind=quiz|deck` optional. **200** `{ "artifacts": [{ "id", "kind", "status", "error_code", "difficulty", "question_count", "card_count", "created_at", "href", "is_creator" }], "has_more": false }` —
`is_creator` lets the UI show delete/regenerate affordances only to the
artifact's owner. Reads are deliberately unthrottled (bounded by pagination).
`400 validation` (bad `kind`) · `401` · `404` · `500 artifacts_failed`.

### `GET /api/rooms/[id]/artifacts/[artifactId]`

**200** `{ "artifact": { …summary, "payload", "model", "resource_ids" } }` —
the full payload for a member; other users' attempt results are never
included (attempts are own-row only and this route does not read them).
`401` · `404` · `500 artifacts_failed`.

### `DELETE /api/rooms/[id]/artifacts/[artifactId]`

Creator only. **200** `{ "deleted": true }`; attempts and review rows cascade
inside the database. `401` · `403 not_creator` · `404` ·
`500 artifacts_failed`.

### `POST /api/rooms/[id]/quizzes/[artifactId]/attempts`

Strict body `{ "answers": [0…3 | -1], "duration_ms"? }` — `answers` holds the
chosen option index per question (`-1` = unanswered), length must equal the
stored question count, and `duration_ms` is 0–86 400 000. The body carries no
`score`: scoring is deterministic and server-side (`record_attempt` compares
against the stored answer key); a forged score field is ignored because the
schema does not allow one. Unlimited retakes — every submit is its own
immutable row.

**201** `{ "attempt": { "id", "score", "total", "correct", "results", "duration_ms", "created_at" } }` —
`results` carries each question's `chosen`, `correct_index`, `explanation`
and `citations` from the payload (the client never supplies any of it).

| Status | Code | Cause |
| --- | --- | --- |
| 400 | `validation` / `invalid_json` | Bad answers length/index, bad duration, malformed JSON |
| 401 | `unauthenticated` | No session |
| 404 | `not_found` | Quiz/artifact missing, or the caller is not a member |
| 409 | `artifact_not_ready` | Not a `ready` quiz |
| 500 | `attempts_failed` | Unexpected failure |

### `GET /api/rooms/[id]/quizzes/[artifactId]/attempts`

The caller's own attempts, newest first (own-row RLS — nobody else's results
ever appear). **200** `{ "attempts": [{ "id", "score", "total", "correct", "duration_ms", "created_at" }] }` ·
`401` · `404` · `500 attempts_failed`.

### `POST /api/rooms/[id]/decks/[artifactId]/review`

Strict body `{ "card_ordinal": 0, "grade": "again" | "got_it" }`. The
SM-2-lite schedule is computed inside `review_card` (0019) — the database is
the authority — and one row per (user, card) means grading the same card
again moves the schedule instead of stacking rows.

**200** `{ "next_review_at", "interval_days", "streak", "due_count" }`.
`again` → streak 0, interval 0, next review +10 minutes, ease −0.2 (floor
1.3); `got_it` → streak +1 and interval 1/3/7/14/30 days by streak (capped
at 30), ease unchanged. `due_count` counts never-reviewed **or** overdue
cards, so grading "again" drops the card out of the due set for the next 10
minutes.

| Status | Code | Cause |
| --- | --- | --- |
| 400 | `validation` / `invalid_json` | Bad ordinal (outside `card_count`), bad grade, malformed JSON |
| 401 | `unauthenticated` | No session |
| 404 | `not_found` | Deck/artifact missing, or the caller is not a member |
| 409 | `artifact_not_ready` | Not a `ready` deck |
| 500 | `review_failed` | Unexpected failure |

### `GET /api/rooms/[id]/decks/[artifactId]/due`

The caller's own review state for every card plus how many are due right now
(never reviewed, or `next_review_at` in the past). Own-row RLS: another
member's schedule never appears. Reads are unthrottled.

**200** `{ "cards": [{ "ordinal", "front", "back", "citations", "grade", "streak", "next_review_at", "due" }], "due_count" }` ·
`401` · `404` · `409 artifact_not_ready` · `500 review_failed`.

### Internal contracts: the artifact RPCs (0019)

| RPC | Behaviour |
| --- | --- |
| `create_artifact(room_id, kind, difficulty, count, resource_ids) → jsonb` | The table's only insert path (execute `authenticated` only): pins `creator_id = auth.uid()`, re-checks membership and that every requested resource is accessible (room-shared in this room, or the caller's own personal file) and `ready`, validates the kind/count/difficulty domain, and writes a `generating` row. A forged resource id can never enter an artifact. |
| `complete_artifact(artifact_id, payload, model, prompt_tokens, completion_tokens, retrieval_tokens) → jsonb` | Creator-only, idempotent (`deduped` once `ready`). Validates the payload against the row's declared counts (a ready artifact always matches), enforces the per-user daily chat-token cap (100 000 — the same set `record_qa` sums; a breach flips the row to `failed` with `ai_quota_exceeded`), writes the `chat_tokens` (+ retrieval `embed_tokens`) ledger in the same transaction, then flips to `ready`. A malformed payload raises `validation` and leaves the row `generating` — a half-parsed artifact can never become ready. |
| `fail_artifact(artifact_id, error_code) → jsonb` | Creator-only, idempotent. Honest terminal state for `no_documents_indexed` / `ai_provider_failed` / `ai_quota_exceeded`. |
| `delete_artifact(artifact_id) → jsonb` | Creator-only; invisible (non-member/missing) is indistinguishable from missing (`404`); cascades attempts + reviews. |
| `record_attempt(artifact_id, answers, duration_ms) → jsonb` | The only insert path into `quiz_attempts` (execute `authenticated` only): pins `user_id = auth.uid()`, re-checks membership and `status = 'ready'`, validates the answers array against the stored question count, and scores server-side against the payload's answer key. The response carries the per-question explanations and citations from the payload, so the client never supplies any of it. |
| `review_card(artifact_id, card_ordinal, grade) → jsonb` | The only write path into `flashcard_reviews` (execute `authenticated` only): pins `user_id = auth.uid()`, re-checks membership and `status = 'ready'`, validates ordinal and grade, computes the SM-2-lite schedule above, upserts on `(artifact_id, user_id, card_ordinal)`, and returns the row plus the live `due_count`. |

Application roles hold no `INSERT`/`UPDATE`/`DELETE` grant on any of the three
tables; `SELECT` is column-scoped (the artifact summary plus payload/model —
**`prompt_tokens`/`completion_tokens` are ungranted**, so a wildcard `SELECT`
is `insufficient_privilege`, the same posture as `study_qa`).

---

## AI study planner (PR 15)

Personal route (the room, if any, rides the body): session → strict Zod body
(no identity fields) → per-scope rate limit → `createPlan` service probes (room
access, document accessibility, daily chat quota) → `create_plan`, the table's
only insert path, which re-validates the whole domain in the database. The
returned `href` is `/planner?plan=<id>`; the client drives `POST …/step` to
build it. Plans are RLS-scoped to their owner; a foreign or missing id is
`404` (no existence oracle across users).

| Method | Path | Summary |
| --- | --- | --- |
| `POST` | `/api/plans` | Start (or resume) the caller's plan; `201` with `{ id, status, exam_date, deduped, href }` |
| `GET` | `/api/plans?status=` | The caller's own plans, newest first, optional `active\|generating\|failed\|archived` filter |
| `GET` | `/api/plans/[planId]` | Full detail: plan row, items in schedule order, `plan_stats` progress, `item_count`, `days` |
| `GET` | `/api/plans/[planId]?format=csv` (or `/<uuid>.csv`) | `text/csv` attachment with `date,kind,subject,task,est_minutes,done` |
| `POST` | `/api/plans/[planId]/step` | One bounded generation step (idempotent while `generating`) |
| `POST` | `/api/plans/[planId]/items/[itemId]/done` | Checkbox toggle; `done: boolean` |
| `POST` | `/api/plans/[planId]/shift` | Deterministic shift of undone items from `from_date` forward |
| `POST` | `/api/plans/[planId]/complete-day` | Mark every untouched item on `date` done |
| `POST` | `/api/plans/[planId]/archive` | End the plan (also cancels an in-flight `generating` row) |

### Shift formula (locked revision)

`shift = max(0, diffDays(from_date, today))` applied to every undone item with
`item_date >= from_date`; done items never move; a target past `exam_date` is
clamped to the exam date (`past_exam_date` counts them). A repeat call from the
same `from_date` re-applies the same advance — the UI confirm-guard and this
note are the safety; `from_date >= today` is a no-op ("already on time"). The
UI sends `from_date = min(earliestUndone, yesterday)` so a fresh plan shifts by
one day and a behind plan catches up exactly.

### Status model and error codes

`generating → active | failed → archived` (one `active` and one `generating`
row per user, enforced by partial unique indexes). `failed.error_code` is
`ai_provider_failed` or `ai_quota_exceeded` (CHECK-constrained). Codes:
`plan_already_active` 409 · `plan_not_active` 409 (done/shift/complete-day/step
on a non-active plan) · `not_found` 404 (foreign or missing plan/item — the
spec's `403 not_owner` is unreachable by design) · `room_not_member` 403 ·
`ai_quota_exceeded` 403 · `rate_limited` 429 · `validation`/`invalid_json` 400 ·
`plans_failed` 500. Rate limit: `plan:{roomId|personal}:{userId}` 10 / 60 s on
POST and step only.

### Internal contracts: the plan RPCs (0020)

| RPC | Behaviour |
| --- | --- |
| `create_plan(user_id, exam_date, hours_per_day, topics, room_id, document_ids, regenerate) → jsonb` | The table's only insert path (execute `authenticated` only): pins `user_id = auth.uid()` (a forged id raises `not_owner`), re-probes room membership (visible non-member → `room_not_member`, invisible → `not_found`), validates the exam window (+1..+180 days) and hours (1..12) and topics (≤25 × ≤60 chars, may be empty), checks every `document_ids` entry is accessible (room-shared in this room, or the caller's own personal file), enforces the one-active/one-generating partial unique indexes (`23505` → `plan_already_active`; `regenerate: true` archives the active row first, in the same transaction), and adopts a pending `generating` row when one already exists (`deduped: true`). |
| `generate_plan(plan_id, items jsonb, model, prompt_tokens, completion_tokens, retrieval_tokens) → jsonb` | Owner-only, idempotent. Re-validates the payload against the row's declared window (every `item_date` inside it, ≤180 items, ≤90 distinct dates, per-day total ≤ `floor(hours_per_day × 60) + 15`, kind ∈ {read, practice, review, mock, rest}, field ranges, and a `resource_id` that is not a pinned id raises `plan_invalid`). Writes `plan_items` and the `ai_usage` ledger in the same transaction, then flips to `active`. A malformed payload leaves the row `generating` — a half-parsed plan can never become active. |
| `fail_plan(plan_id, error_code) → jsonb` | Owner-only, idempotent. Honest terminal state for `ai_provider_failed` / `ai_quota_exceeded`. |
| `archive_plan(plan_id) → jsonb` | Owner-only, idempotent. Also cancels a pending `generating` row. |
| `shift_plan(plan_id, from_date, updates jsonb) → jsonb` | Owner-only; the arithmetic lives in `lib/planner/shift.ts` (TypeScript) and this RPC re-validates every precomputed update inside the write: ownership, `status = 'active'`, `v_current >= from_date`, forward-only, `<= exam_date`, skips done items, `v_target = v_current` is a no-op. |
| `mark_plan_item(item_id, done) → jsonb` | Owner-only (the item's plan's owner), idempotent; the first `done_at` timestamp is never rewritten. A foreign item id is `not_found`. |
| `complete_plan_day(plan_id, date) → jsonb` | Owner-only; marks every untouched item on `date` done in one transaction; idempotent. |
| `plan_stats(plan_id) → jsonb` | Owner-only (a foreign id raises `not_found`); the detail route's authority: the plan row's view columns plus `item_count`, `days`, and the `progress` object built by `plan_progress` — a plain SQL helper whose execute grant is revoked from `anon`/`authenticated` (postgres-only; the app never calls it directly). |

Application roles hold no `INSERT`/`UPDATE`/`DELETE` grant on `study_plans` or
`plan_items`; `SELECT` on `study_plans` is column-scoped to the view
contract's columns (**`prompt_tokens`/`completion_tokens` are ungranted** — the
same posture as `study_qa` and `study_artifacts`). Citations are rebuilt
server-side from the pinned ids (`{title, href}`); a pinned-but-deleted or
pinned-but-not-retrieved document is stripped, and a fabricated `resource_id`
in the provider payload raises `plan_invalid`.

### Deviations from the spec (documented)

- **Signals**: the planner consumes the merged tables directly
  (`study_goals`, and `quiz_attempts` with their embedded `study_artifacts`)
  rather than `analytics_me` — PR 16 has landed, and the seam deliberately
  stays table-direct (`focus_minutes` remains `null` in the signals; see the
  documented seam in `lib/planner/signals.ts`), unit-tested against the
  merged view.
- **Shift arithmetic** lives in TypeScript (`lib/planner/shift.ts`) and is
  re-validated inside `shift_plan` — the spec's "all in SQL" wording is
  satisfied by the RPC's re-check, not by a closed-form SQL expression.
- **`403 not_owner`** is unreachable: a foreign plan is `404` on every surface
  (no existence oracle), and `create_plan` raises `not_owner` only when a
  caller forges `user_id` in the RPC body — a path no route exposes.

---

## Study analytics (PR 16)

Personal route: session claims → required `?range=7d|30d|90d` (there is **no
default at the API layer** — a missing or unknown value is `400 validation`)
→ one `analytics_me` round trip → `{ range, days, summary, plan }`. Identity
is never a query parameter: `?user_id=…` is ignored, the session picks the
subject, and the RPC aggregates `auth.uid()` inside the database (a foreign
`p_user_id` behaves as self — no parameter can be pointed at anyone else).
The room route validates the id and range the same way, then calls
`analytics_room`, whose owner-or-moderator check lives in the database — a
plain member, a non-member and a missing room all answer the identical
`404 not_found`, so the URL never reveals which rooms exist or who can
moderate them. The **pages** default an absent `range` to `7d` server-side
and render `notFound()` for an explicit-but-unknown one (the API answers
`400` for the same value — both behaviours asserted in tests; the page's
`notFound()` HTTP status is not asserted because streaming can flush the
shell first — repo convention). Charts are inline SVG (zero dependencies)
with `role="img"` + `<title>`/`<desc>` and an sr-only text table, plus a
collapsed `<details>` copy for sighted readers.

| Method | Path | Summary |
| --- | --- | --- |
| `GET` | `/api/analytics/me?range=7d\|30d\|90d` | The caller's own day series, summary and active-plan window; `?format=csv` swaps the body for the CSV attachment of the same `days` |
| `GET` | `/api/analytics/me.csv?range=…` | The spec's download link: the `/me` handler with `format=csv` forced — one auth/validation/aggregation path, so JSON and CSV cannot drift; `Content-Disposition: attachment; filename="study-analytics-<range>.csv"` |
| `GET` | `/api/analytics/rooms/[id]?range=…` | Owner/moderator aggregates (counts and minutes only); `400` for a non-UUID id, the identical `404` for member, non-member and missing room |

### Payload contracts

- **`days` (personal)**: one row per UTC day, zero-filled across the window
  (7/30/90 rows): `{ date, focus_minutes, goals_completed, quizzes_taken,
  cards_reviewed, uploads }`. Personal focus attribution follows the
  documented `0003` seam: `focus_sessions` carries no `user_id`, so a
  student's focus minutes are the sessions of rooms they **own** — focus
  spent in other people's rooms counts only toward that room's aggregate
  (no identity column is added to fix this; the migration header says so).
- **`summary` (personal)**: the spec's fields — `focus_minutes`,
  `goals_completed`, `goals_created`, `quiz_correct`, `quiz_total`, `accuracy`
  (`null` when no question was answered in the window — never a fake `0`),
  `cards_due` ("never reviewed or due by end of today (UTC)"), `uploads` —
  plus additive fields the strip and charts consume: `goals_active`,
  `quiz_by_difficulty[]` (`{ difficulty, correct, total }`, hardest-first
  label), `previous_focus_minutes` (the equal-length prior window the strip
  compares against), `upload_bytes`, `sessions`, `avg_session_minutes`, and
  `study_days` / `current_streak_days` / `longest_streak_days` (the streaks
  are computed in TypeScript from the RPC's top-level `study_days` UTC-date
  array).
- **`plan`**: the caller's active plan inside the same window —
  `{ planned_minutes, items_total, items_done, items_overdue }` or `null` —
  the source of the additive "Plan vs actual" section. Items are
  window-scoped (only dates `<= today` count), so a tomorrow-dated task never
  inflates today's planned minutes.
- **Room `summary` / `days`**: `{ focus_minutes_total, active_members,
  goals_created, goals_completed, quiz_attempts, quiz_correct, quiz_total,
  uploads }` and per-day `{ date, focus_minutes, active_members,
  quiz_attempts }` — counts and minutes only; a recursive key scan in the
  tests proves no user id or alias can appear. **`active_members`** is the
  count of distinct members with an attributable action in the window (quiz
  attempt, card review, room upload, goal created/completed) plus the room
  owner when ≥1 session ran — not the spec's "≥1 session" wording, which is
  impossible because `focus_sessions` carries no member identity (`0003` by
  design; documented in the `0021` migration header).
- **CSV**: exactly `date,focus_minutes,goals_completed,quizzes_taken,
  cards_reviewed,uploads` plus a trailing newline — row-for-row the same
  `days` the JSON path serves (asserted equal, integration).

### Internal contracts: the analytics RPCs (0021)

| RPC | Behaviour |
| --- | --- |
| `analytics_me(p_user_id, p_days) → jsonb` | SECURITY DEFINER, `set search_path = ''`, execute revoked from `public`/`anon`, granted to `authenticated`. The subject is always `auth.uid()` (anon → `unauthenticated`, errcode 42501); `p_user_id` is kept in the signature the spec fixes but a foreign or null id silently behaves as self. `p_days` ∉ 1–90 → `validation`. Window `[today_utc − (p_days−1), today_utc]` inclusive with an equal-length previous window for the comparison line; every bucket is the UTC calendar date. Returns `{ days, summary, study_days, plan }`. |
| `analytics_room(p_room_id, p_days) → jsonb` | Same hardening and window rule. Authorization inside the database: the caller must own the room or hold a `room_moderators` row, else `not_found` — member, outsider and missing room are indistinguishable. Returns counts and minutes only (never a `user_id`-keyed array). |

No base-table grant changes: both functions only `select` through their
definer (the migration contains no `grant … on <table>` at all — acceptance
"in the diff, by construction"). Read-only GETs are not rate-limited (the
write surfaces carry the limits). Errors: `400 validation` (missing/unknown
range, non-UUID room id) · `401 unauthenticated` · `404 not_found` ·
`500 analytics_failed`.

---

## Room discovery (PR 17)

Browse: session claims → one `room_filter_options` round trip (the distinct
subjects/exam tracks/languages of **public** rooms only) plus one
`list_public_rooms` round trip → `{ rooms, has_more, next_cursor }`. The RPC
hard-codes `visibility = 'public'`, so no parameter can widen it. `q`,
`subject`, `exam_track`, `language` and `min_members` filter; `sort` picks
the keyset (`recent` | `active` | `largest` | `name`, or `relevance` when a
query is present and no sort is given — `relevance` **without** a query is
SQLSTATE `22023`, mapped to `400`); `limit` defaults to 20 and caps at 50;
`cursor` is the opaque base64url keyset of the previous page, validated in
the data layer (`lib/rooms/discovery.ts`) before SQL sees it — a malformed or
wrong-sort cursor is a `400`, never a SQL error. `has_more` comes from
fetching limit+1 rows, so there is **no total count** (a count would need a
second scan and would drift under pagination). Every room carries
`viewer_membership` (the caller's own row only) and `member_count` (an
aggregate — never participant identities); the route adds
`href: /rooms/{id}/preview` on top of the data layer's `RoomSummary`.

Preview: session claims, no membership required — any signed-in student may
preview a **public** room. `room_preview` raises the same `P0002` for a
private room the caller does not belong to and for a room that does not
exist, so both are the identical `404 not_found` (never an existence oracle);
a non-UUID id is the same `404` byte-for-byte. A member previewing their own
room (public or private) gets the row with `is_member: true` and
`viewer_role` (`owner` | `member` | `none`).

| Method | Path | Summary |
| --- | --- | --- |
| `GET` | `/api/rooms?q=&subject=&exam_track=&language=&min_members=&sort=&limit=&cursor=` | Discovery page over public rooms only; `{ rooms, has_more, next_cursor }` |
| `GET` | `/api/rooms/[id]/preview` | Public-safe room detail — `{ room, is_member }`; identical `404` for private-non-member, missing and malformed ids |

Errors: `400 validation` (unknown filter value, `relevance` without a query,
malformed cursor) · `401 unauthenticated` · `404 not_found` (preview) ·
`500 query_failed` / `preview_failed`. The **pages** (`/rooms`,
`/rooms/[id]/preview`) validate with the same Zod schema; an invalid query
renders the explained empty list, and the preview page renders `notFound()`
for every refusal the API gives (repo convention: the streamed page's HTTP
status is not asserted — the rendered "Page not found" heading is).

### Internal contracts: the discovery RPCs (0022)

| RPC | Behaviour |
| --- | --- |
| `list_public_rooms(p_q, p_subject, p_exam_track, p_language, p_min_members, p_sort, p_limit, p_cursor) → setof rooms` | SECURITY DEFINER, `set search_path = ''`, execute revoked from `public`/`anon`, granted to `authenticated`. Hard-codes `visibility = 'public'`; `p_limit` is clamped to 1–50 (default 20); `p_cursor` is a `jsonb` keyset the caller (the data layer) has already validated against `p_sort`; `relevance` without `p_q` raises `22023`. `last_activity_at` is `greatest(max(focus_sessions.started_at), max(room_messages.created_at))`, computed in the same query — no extra round trip, no client clock. |
| `room_preview(p_room_id) → jsonb` | Same hardening. Public rooms are visible to any session; a private room is visible only to its members (`P0002` otherwise — identical to a missing room). Returns the shaped row plus `is_member` and `viewer_role` (`viewer_membership`: owner → `"owner"`, student → `"member"`, null → `"none"`). |
| `room_filter_options() → jsonb` | Same hardening. The distinct non-null `subject`/`exam_track`/`language` values of public rooms only — private rooms never leak into a filter chip. |

Five supporting indexes ride in the same migration — four on `rooms` (the
public `(visibility, created_at desc, id desc)` keyset plus one per
lower-cased filter column: `subject`, `exam_track`, `language`) and
`room_messages (room_id, created_at desc)` for the activity scan — and no
table grant changes: the functions only `select` through their definer.
Read-only GETs are not rate-limited.

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
| `POST /api/ai/ingest/[resourceId]` (PR 12, one bounded step per call) | `ingest:user:{userId}` | 30 / 60 s |
| `POST /api/ai/ingest/sweep` (PR 12, maintenance — one sweep advances many rows) | `sweep:user:{userId}` | 6 / 60 s |
| `POST /api/rooms/[id]/ask` (PR 13, one full RAG pass per question) | `ask:{roomId}:{userId}` | 20 / 60 s |
| `POST /api/rooms/[id]/generate` · `POST …/generate/[artifactId]/step` (PR 14, each one full generation pass) | `generate:{roomId}:{userId}` | 10 / 60 s |
| `POST /api/plans` · `POST /api/plans/[planId]/step` (PR 15, each one full generation pass) | `plan:{roomId\|personal}:{userId}` | 10 / 60 s |
| `PATCH /api/profile` (PR 20, own-row settings edits) | `profile:{userId}` | 30 / 60 s |
| `POST /api/rooms/[id]/messages` (PR 21, chat send) | `message:{roomId}:{userId}` | 30 / 60 s |
| `POST /api/rooms` (PR 21, room creation) | `room_create:user:{userId}` | 5 / 60 s |
| `PATCH /api/profile/notification-prefs` (PR 21, preference writes) | `notification_prefs:{userId}` | 30 / 60 s |

These numbers are part of the contract (`lib/rate-limit/keys.ts` is the
implementation mirror); change both together. The per-user/per-target split on
uploads means one account cannot do unbounded work overall, and cannot
concentrate all of it on one room or library.

---

## Health, readiness and metrics (PR 18)

Three unauthenticated, `cache-control: no-store` endpoints answer operational
questions. None of them touches user data, and none is rate-limited: they are
the endpoints a load balancer, a scheduler or an on-call engineer polls.

| Method | Path | Summary |
| --- | --- | --- |
| `GET` | `/api/health` | Liveness: `200 { status: "ok", version, uptime_s }`. Never contacts the database or storage — a dependency outage must not make a supervisor restart a healthy process. |
| `GET` | `/api/health/ready` | Readiness: probes Supabase REST and Storage in parallel (2 s timeout each). `200 { status: "ok", checks: { db: "ok", storage: "ok" }, checked_at }` when both answer; `503 { status: "degraded", checks: { db: "ok"\|"down", storage: "ok"\|"down" }, checked_at }` otherwise. An HTTP response from the dependency counts as "up"; only a thrown error or timeout marks it "down". Missing configuration answers `degraded` without probing. |
| `GET` | `/api/metrics` | Single-instance aggregate health: `200 { window_s: 300, instance: "single", requests: { "<route>": { count, p50_ms, p95_ms, errors: { "<status>": n } } } }`. Routes are normalized (`/api/rooms/:id/join` — uuids and numbers become `:id`), so no path parameter or identifier can appear in this output. In-memory only: each process answers for itself; a multi-instance deploy needs an external aggregator (named follow-up, not a silent omission). |

All three are wrapped by `withLogging`, so every poll produces one structured
access line (`event: "request"`) with the route, status, duration and — when
the caller sent one — the `x-request-id` echoed back.

---

## Not implemented, on purpose

| Concern | Status |
| --- | --- |
| Rate limiting | **Implemented for the routes listed in "Rate limits"** (PR 10 + PR 12 + PR 13 + PR 14 + PR 15 + PR 20 + PR 21): uploads, deletes, signed-URL issuance, sweeps, reports, blocks, mutes, invitations, the AI ingest/sweep routes, ask, generate/step, plan create/step, profile edits, message sends, room creation, and notification-preference writes. Session-gated pages and paginated reads are deliberately unthrottled (including `GET /api/ai/usage`, artifact/attempt/due listings); PR 11's notification reader routes follow the same rule (own-row reads, no throttle) while its two producer RPCs ride the parent mutation routes' existing windows. |
| Malware scanning | **Not implemented and not claimed.** Only signature/UTF-8 validation runs. |
| Metadata editing (`PATCH`) | Not exposed. The `UPDATE` grant and policy exist and are exercised by the integration suite so the column set is provably narrow; no UI or endpoint needs renaming yet. |
| Public/permanent file URLs | Never. Only short-lived signed URLs. |
| Service-role usage at runtime | None. Every request runs on the cookie-scoped, user-privileged Supabase client. |
| Bearer invite links / `/invite/[token]` | **Superseded, not built.** PR 07's spec called for a single-use token URL; the shipped design addresses invitations to an alias instead (no token exists to leak, forward or enumerate). See the reconciliation in `docs/prs/PR-07-private-invitations.md`. |
| Inviting by email / phone / any contact data | **Never.** The app collects no contact data; delivery is the in-app inbox (PR 11). Notifications stay inside the product — no email, push or SMS was added, and none is planned. |
| Invitations to public rooms | Refused (`409 room_public`): `join_room` already handles public entry. |
| Global `/moderation` dashboard | **Not built.** Reports are room-scoped and authorization is per-room; the moderation inbox mounted in the room workspace is the product contract (PR 09's reconciliation). |
| Message removal / soft-hide | **Never in v1.** `room_messages` keeps no `UPDATE`/`DELETE` grant and no hidden columns — moderators act at the member level (mute/remove) and reports carry the context. |
| AI summaries | Explicitly out of scope for this milestone. |
