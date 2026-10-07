# Security

What this project defends against, how, and — just as important — what it does
not claim to do. `docs/API_CONTRACTS.md` carries the endpoint contracts; this
file carries the model behind them.

## Principles

1. **Identity only from the session.** No endpoint accepts an owner id, a user
   id, a room id "on behalf of", a content type or a storage path from the
   client. Anything the database needs is derived server-side or written by a
   column default (`auth.uid()`).
2. **Deny by default, then narrow.** Every table and the storage bucket start
   revoked; grants and policies are added one column and one verb at a time
   (`supabase/migrations/0001_init.sql`, `0003`, `0004`, `0005`).
3. **Two independent layers for every rule.** The API re-checks what the
   database already enforces, and the database enforces what the API assumes.
   A bug in one leaves the other standing.
4. **No existence oracles.** "Does not exist" and "you may not see it" are the
   same `404 not_found`, byte-identical in message and shape.
5. **No permanent URL for private bytes.** Downloads are short-lived signed
   URLs, re-authorized on every request.

## Threat model

| Adversary | Capability assumed | Defended by |
| --- | --- | --- |
| Anonymous visitor | Unauthenticated requests to pages and `/api/*` | Session check first in every handler; middleware redirects pages to `/auth/login`; API routes answer the documented JSON `401` instead of an HTML redirect |
| Authenticated stranger | A valid session, ids guessed or harvested from elsewhere | RLS read policy on `study_resources` (own rows, plus rows of rooms they are *currently* in); storage `select` policy re-derives the same scope from the object key; `404` for both missing and forbidden |
| Room member | Legitimately reads shared files | Delete/upload are uploader-only: ownership comes from the server-built storage key, and storage's own `delete` policy requires `owner = auth.uid()` |
| Forged request body | Posts `owner_id`, `user_id`, `storage_path`, `content_type`, `size_bytes` | The multipart parser rejects **unknown parts** with `400 invalid_request` (naming them) rather than ignoring them; `owner_id` has no `INSERT` or `SELECT` grant at all, so PostgREST refuses the column on privilege grounds before any policy runs |
| Hand-written PostgREST / Storage call | Bypasses the Next.js app entirely | RLS and storage policies encode the same rules the app encodes; the key layout is checked by a regex `CHECK` on the row and by `storage.foldername()` segment counts on the object |
| Hostile file | Extension spoofing, oversized payloads, path traversal in filenames | Magic-byte sniffing decides the content type, the extension only cross-checks it; 20 MiB ceiling (refused on `content-length` before buffering); filenames without path separators or `..`; storage keys are built from server-generated UUIDs only |
| Leaked URL | A signed URL pasted into a chat | TTL of 300 s (`DOWNLOAD_TTL_SECONDS`), re-issued only after a fresh authorization check; the token carries the expiry inside it |
| Database row tampering | Direct `update`/`delete` through SQL or the API | `update`/`delete` are uploader-only, `owner_id`/`room_id`/`storage_path`/timestamps are outside the `UPDATE` grant, `updated_at` is owned by `study_resources_touch`, and `storage.protect_delete()` blocks a plain `delete from storage.objects` |

## Room presence: what it discloses

| Aspect | What it means |
| --- | --- |
| Payload | `{ alias, studying }` and nothing else — the member's chosen study alias (trimmed, ≤ 32 chars, untrusted display data) and whether the room currently has a running or paused shared focus session. **No user id, email, phone number or profile row** appears in any presence frame, and no `is_own` flag is taken from the payload (the client knows itself) |
| Audience | Current members of that room only. The channel topic `room-presence-{roomId}` is gated by `supabase/migrations/0006_realtime_private_channels.sql`: two `TO authenticated` policies on `realtime.messages` that require a current `room_members` row for `auth.uid()` matching the uuid in the topic, extensions `broadcast`/`presence` only. A non-member cannot join, and a private room's existence cannot be confirmed by probing topics (join failure is indistinguishable from a nonexistent room) |
| Durability | Nothing persists. Presence lives in the Realtime service's memory; a socket close removes it (a 60 s heartbeat re-tracks a half-open one). `0006` adds **no** table, column, grant or publication entry, and the authorization probes it relies on roll back in the same transaction |
| `studying` | Room-scoped by construction: `focus_sessions` records no starter column (one active row per room, owner-only control), so the flag reports the room's shared session, not any individual's private activity — a stated reconciliation in PR 06, not a hidden shortcut |
| Spoofing | A member can lie about their own alias and flag. Presence is therefore never used for authorization, never joined to `profiles` server-side, and never overrides the caller's own identity (`is_own` comes from the tracked key, not the payload) |

## Study resources: where the rules live

| Layer | File | Rule |
| --- | --- | --- |
| Schema | `supabase/migrations/0005_study_resources.sql` | Table, CHECKs (incl. key layout and `room_id ⇔ personal/` agreement), column-grant matrix, 4 table policies, private `study-resources` bucket, 3 storage policies, **no `UPDATE` policy on storage** |
| Validation | `lib/validation/resources.ts`, `lib/resources/upload.ts` | Metadata schemas, size/filename rules, magic-byte sniffing, UTF-8 checks, unknown-part rejection |
| Storage keys | `lib/resources/storage.ts` | `personal/{owner}/{id}{ext}` / `rooms/{room}/{owner}/{id}{ext}`, `isOwnedBy()` for the delete pre-check, `absoluteUrl()` built from `NEXT_PUBLIC_SUPABASE_URL` |
| Authorization | `lib/resources/queries.ts`, `lib/rooms/access.ts` | Reads and locator lookups run through the user-scoped client (RLS applies); membership is confirmed before a room-scoped list or upload |
| API | `app/api/resources/**` | The sequence, the status codes and the rollback/cleanup order — see `docs/API_CONTRACTS.md` |
| UI | `components/resources/*`, `app/(app)/resources/*` | Never constructs a URL itself; asks the server for one, and treats `401` as "sign in again" |

Two details worth restating because they are easy to lose:

- **`owner_id` and `storage_path` are not response fields.** `owner_id` is not
  even granted for `SELECT`, and `STUDY_RESOURCE_COLUMNS` (`lib/resources/types.ts`)
  excludes `storage_path` — no shaping step has to remember to strip them.
- **Leaving a room revokes read access immediately** through the membership
  subquery in both the table policy and the storage policy. No file row or
  object is moved or deleted, and the uploader keeps reading their own upload.

## Coverage (how it is proven)

| Suite | Command | What it pins down |
| --- | --- | --- |
| Unit | `npm test` | Validators, path building and ownership parsing, query scoping, every route's status/code matrix including the error branches, upload form and library UI behaviour |
| Integration | `npm run test:integration` | Against the real local stack with real auth users: `tests/integration/study-resources.test.ts` (22) — privacy of columns and rows, anonymous listing, signed-URL reachability with its 300 s TTL and refusal without a signature, cross-user open/delete refusal, member read, non-member 404, **revocation on leaving**, `owner_id` rejection, impersonation of another student's folder (row *and* object), impersonation of the signed path, magic-byte mismatch, bucket privacy, `owner_id` grants, and the key-layout CHECK |
| Browser | `npm run test:e2e` | `tests/e2e/resources.spec.ts` (5) — upload through the real form, private library, room sharing and delete in Chromium |

CI runs all three (`.github/workflows/ci.yml`) with `permissions: contents: read`
and no repository secrets.

## Not covered, on purpose

These are known limitations, not oversights to be discovered later:

- **No rate limiting.** No rate limiter exists anywhere in this application yet;
  adding one only for uploads would be inconsistent with the rest of the app.
- **No malware scanning.** Only signature and encoding validation runs. The
  migration header says this in so many words: format validation is not
  scanning, and nothing in this repository claims otherwise.
- **No `text/html` in the allow list**, so no stored payload can be rendered as
  a page by the browser; objects are also served from the Supabase origin, not
  the app's.
- **A signed URL is bearer for its lifetime.** Anyone holding it may fetch until
  it expires; there is no per-request revocation short of removing the object.
- **No content-security policy beyond Next.js defaults**, no WAF, no dependency
  scanning beyond `npm audit` (see README).
- **No service role at runtime.** No server-side code uses a service-role key;
  every request runs on the cookie-scoped, user-privileged Supabase client.

## Reporting

Open an issue (see the README's "Feedback and issues" section). Do not include
signed URLs, session cookies or user ids in a public report.
