# PR 17 — Room discovery improvements

**Status:** specification only — no GitHub PR exists.
**Owner:** Dev A (OpenCode) · **Complexity:** Medium · **Migration:** `0016_discovery_indexes.sql`
**Depends on:** PR 06 (presence/membership context in room cards), soft: PR 08 (`Closed` badge already lands there), PR 09 (only rooms you can be reported in are worth surfacing safely)

---

### Problem

Discovery exists in the narrowest possible form: `GET /api/rooms` lists public
rooms with a `q` name filter and a subject/exam_track filter, and
`app/(app)/rooms/page.tsx` renders them. There is no ordering (results come in
whatever order PostgREST returns), no relevance ranking, no member-count or
activity signal on a card, no pagination contract beyond a `limit`, no
"subjects you follow" personalisation, and no way to see a room's details
before joining. For a student picking a room to study in — the product's core
acquisition moment — the surface gives almost nothing to decide on.

### User story

As a student looking for people to study with, I search or browse public rooms
by subject and exam, see how big and how active each one is, open a preview to
understand its goal and language, and join — while private rooms stay
completely invisible to me.

---

### Scope

- **Ranked listing**: deterministic ordering with relevance — exact/prefix
  name match > shared subject/exam_track > member count > recency of last
  activity. Implemented in SQL (RPC), not JS post-sorting of an unbounded set.
- **Card enrichment**: `member_count`, `last_activity_at` (derived from
  `focus_sessions`/`room_messages` — pick one cheap source and document it),
  `is_member` for the caller, `status` badge.
- **Preview endpoint + page**: `GET /api/rooms/[id]/preview` and a public-ish
  page `/rooms/[id]/preview` (or a dialog from the list — **choose a page**, it
  is linkable and shareable) showing name, visibility, subject, exam_track,
  language, shared_goal, member_count, created_at, and a Join button that
  delegates to the existing `join_room`. For a room the caller already belongs
  to → "Open room".
- **Filters that students actually use**: subject, exam_track, language,
  minimum member count, `sort=recent|active|largest|name`. Filter state lives
  in the URL (searchParams) so results are shareable and back-button safe.
- **Pagination**: stable cursor (created_at + id), `has_more`, and a documented
  `limit` default/max — replacing the ad-hoc `limit`-only behaviour.
- **Search input UX**: debounced query bound to the URL, clear button, result
  count announced (`role="status"`), empty state with suggestions (clear
  filters / create a room).
- **Performance**: indexes for the filter/sort paths (see Database), and a
  bounded page size so a popular subject cannot stream the whole table.

### Out of scope

- **Any exposure of private rooms**: private rooms never appear in lists,
  previews, counts, autocomplete, or any search index. Preview of a private
  room returns the same indistinguishable `404` as the workspace.
- Full-text search beyond name (no `tsvector` over chat/messages — that would
  leak content into search and invite moderation questions; explicit non-goal).
- Typo tolerance / fuzzy matching / stemming (Postgres `trigram` similarity is
  a candidate but adds an extension — see standing question; v1 = `ilike`
  prefix/contains via the RPC).
- Recommendations, ML ranking, "rooms you may like".
- Trending/popular leaderboards, room of the day.
- Geographic/location search, timezone matching.
- Rooms by invite only (that is PR 07's lane), private previews, previews with
  member names (preview shows counts, never identities).
- Modelling new room fields (no new columns on `rooms` — if a sort needs
  `last_activity_at`, derive it or maintain it via trigger; decide in Database).
- Mobile map/list views (PR 19 handles shell responsiveness, not this content).
- Analytics on search queries (no query logging beyond what the platform
  already does — deliberately not added).

---

### Frontend work

| File | Change |
| --- | --- |
| `app/(app)/rooms/page.tsx` | Becomes a filterable, URL-driven browse page: search box, filter controls (selects for subject/exam/language, range for members, sort), result count, grid/list of cards, Load-more (cursor pagination), empty state. Keep `loading.tsx`/`error.tsx`. |
| `components/rooms/room-filters.tsx` (new) | Form controls writing to searchParams (server-action or `router.replace` pattern — follow whatever the repo does for URL state; if none exists, use `router.replace` with `scroll: false`). Fully keyboard operable, labels on every control. |
| `components/rooms/room-search.tsx` (new) | Debounced input + clear button; announces count. |
| `components/room-card.tsx` | Add member count, last-active relative time, `is_member` "Joined" badge, language chip; keep `Closed` badge from PR 08; make the whole card a link with an accessible name (title + subject), no nested interactive elements. |
| `app/(app)/rooms/[id]/preview/page.tsx` (new) | Preview page: full details, Join (delegates to existing join flow) or "Open room", back-to-results preserving filters via `?from=`. `loading.tsx` + `error.tsx`. |
| `components/rooms/room-preview.tsx` (new) | Server-rendered details + join affordance. |

Accessibility: filters are a `<form>`/fieldset with visible labels; cards are a
`role="list"` of links; result count is `role="status"`; empty state offers a
primary action; no colour-only badges (join status has text).

### Backend work

| Route | Behavior |
| --- | --- |
| `GET /api/rooms` | **Extended, not replaced**: keeps existing params (`q`, `subject`, `exam_track`, `limit`) and adds `sort`, `language`, `min_members`, `cursor`. Response: `{ rooms: [EnrichedRoom], has_more, next_cursor, total? }`. **Backward compatibility**: existing clients (tests, PR 06–11 code) must keep working — keep the old field names, add fields, and if `total` is expensive, omit it rather than break. |
| `GET /api/rooms/[room_id]/preview` | **Public-safe read of public rooms only**: no auth required? Decision — **require auth** (the whole app is behind auth; a signed-out preview adds nothing) but no membership required. → `200 { room: { id, name, shared_goal, subject, exam_track, language, visibility, status, member_count, created_at }, is_member }`. Private/missing → identical `404 not_found`. |
| (unchanged) `join_room` | The preview's Join button calls the existing endpoint — no changes. |

Enrichment must be **one query**: RPC returns name/goal/member_count/last
activity/is_member in a single round trip (LATERAL counts or a grouped join).
The route must not N+1.

### Database work

`supabase/migrations/0016_discovery_indexes.sql`:

- RPC `list_public_rooms(p_q text, p_subject text, p_exam_track text,
  p_language text, p_min_members int, p_sort text, p_limit int,
  p_cursor jsonb) returns table(...)` — SECURITY DEFINER with
  `visibility = 'public'` hard-coded in the WHERE clause (never a parameter),
  caller identity used only for `is_member` and never to widen visibility;
  execute revoked from `public`/`anon`, granted to `authenticated`.
  - Sorting: `recent` → `created_at desc, id desc`; `active` →
    `last_activity_at desc nulls last, id desc`; `largest` → `member_count desc,
    id desc`; `name` → `name asc, id asc`; relevance when `p_q` present →
    `case when lower(name) = lower(p_q) then 0 when lower(name) like lower(p_q)
    || '%' then 1 else 2 end, member_count desc, id desc`.
  - Cursor: keyset on the chosen sort's leading columns (encode as jsonb) —
    document that **`sort=name` and relevance sorts need a stable tiebreaker**
    (`id`) in the cursor, or they will skip/duplicate rows.
- RPC `room_preview(p_room_id uuid)` — returns the preview row or raises
  `not_found` when the room is not public (or the caller is a member — a member
  previewing their own private room is allowed and returns it; **decide**:
  allow members to preview their own private room, everyone else 404s. Recommended:
  yes, because the "Open room" path reuses it).
- Indexes (create only if missing; justify each in the migration header):
  - `rooms (visibility, created_at desc, id desc)` for `recent`,
  - `rooms (visibility, subject, created_at desc)` for subject+recent,
  - `rooms (visibility, exam_track, created_at desc)`,
  - `rooms (visibility, language, created_at desc)` if language filtering ships,
  - `room_members (room_id)` already exists for counts (verify),
  - `focus_sessions (room_id, started_at desc)` and/or
    `room_messages (room_id, created_at desc)` for `last_activity_at` (verify
    which exists from `0002`/`0003` before adding duplicates).
- **`last_activity_at` decision** (state it in the PR):
  - *Derived* (recommended for v1): `greatest(max(focus_sessions.started_at),
    max(room_messages.created_at))` per room in the RPC — no schema change, no
    trigger drift, cost bounded by the filtered set.
  - *Maintained*: add `rooms.last_activity_at timestamptz` + trigger on those
    two tables + `grant update`… to nobody (trigger is owner-definer) — more
    moving parts. Prefer derived; measure before choosing maintained.
- **No new grants on `rooms`.** The preview RPC reads under its own rights and
  enforces `visibility = 'public' or caller is member`; the existing `SELECT`
  policy is untouched. If `member_count` needs `room_members` visibility,
  compute it **inside the RPC** (definer rights) rather than widening
  `room_members` — this must not regress PR 07's roster decision.
- No changes to `join_room`, `rooms` columns, or RLS policies.

### Storage work

None (no room avatars in scope).

### Realtime work

None (member counts refresh on navigation; live counts are explicitly not a
goal).

### AI work

None.

---

### Security requirements

A user must **not** be able to:

1. See any private room in any list, sort, filter, count, or preview — the
   `visibility = 'public'` predicate is inside the RPC, not supplied by the
   caller, and a seeded private room must be absent from every listing path
   (integration-asserted for each sort and filter combination, at minimum
   `recent`, `name`, and a `q` that matches the private room's exact name).
2. Use preview or listing as an existence oracle for private rooms: identical
   `404` for "private room exists" and "no such room".
3. Learn member **identities** through preview/listing (counts only).
4. Enumerate the whole table via unbounded pagination (hard `limit` max,
   keyset cursor only — no `offset`).
5. Inject filter values into SQL — RPC parameters are bound, `p_q` is
   parameterised (`ilike` with escaped `%`/`_`), and a `%`-heavy query must not
   scan-pathologically (escape wildcards; document).
6. Bypass membership checks by calling the RPC with a forged cursor (cursor is
   opaque jsonb of sort values, validated; malformed → `400`).

Positive guarantees:

- Results are deterministic and stable across pages (keyset + tiebreaker) —
  tested by paging through a seeded set and asserting no duplicates/gaps.
- `is_member` reflects the caller only; it reveals nothing about others.

### API contracts

```jsonc
// GET /api/rooms?q=neet&subject=Physics&language=hinglish&min_members=2
//    &sort=active&limit=20&cursor=…
{ "rooms": [ { "id", "name", "shared_goal", "subject", "exam_track",
               "language", "visibility": "public", "status", "member_count",
               "last_activity_at", "is_member", "created_at",
               "href": "/rooms/…/preview" } ],
  "has_more": true, "next_cursor": "eyJ…" }
// GET /api/rooms/[id]/preview   200
{ "room": { "id", "name", "shared_goal", "subject", "exam_track", "language",
            "visibility", "status", "member_count", "created_at" },
  "is_member": false, "join_href": "/api/…" }
```

| Error | Code |
| --- | --- |
| 400 | `validation` (bad sort/cursor/limit) |
| 401 | `unauthenticated` |
| 404 | `not_found` (private or missing — identical) |
| 500 | `rooms_list_failed` / `preview_failed` |

Backward compatibility note for the PR: existing `GET /api/rooms` consumers
assert `{ rooms, has_more, total? }` — additive changes only; if `total` was
relied upon and becomes expensive, keep it (compute with the same filtered
count) rather than removing it.

### Tests

**Unit**

- Route files: parameter validation (sort enum, limit cap, cursor parse),
  `400` shapes, N+1 avoidance (assert the RPC is called once — a spy on the
  data layer), error mapping.
- `room-filters` / `room-search`: URL round-trip (filters → searchParams →
  back), debounce, clear, count announcement.
- `room-card`: accessible name, no nested links, badges rendered with text.
- Preview page: join vs open-state rendering, `404` path rendering.
- Cursor encoding/decoding round-trip incl. the `name` sort tiebreaker.

**Integration (`tests/integration/room-discovery.test.ts`)**

- Seed: public rooms across subjects/languages/ages/member counts + **one
  private room named `ZZZ Exact Match Public`**… actually name it so it would
  rank first if leaked (e.g. private room named exactly the search term).
  Assert it never appears for: default list, `q=<exact private name>`,
  `subject` filter, each `sort`, and preview (`404`).
- Ranking: exact match first, then prefix, then member count desc — assert the
  exact order for a fixed seed (determinism).
- Pagination: seed 25 rooms, page with `limit=10` → 10/10/5, no duplicates, no
  gaps, `has_more` false at the end; malformed cursor → `400`.
- `member_count` matches an independent `count(*)` of `room_members`.
- `is_member` true only for the caller's memberships.
- `last_activity_at` (derived) reflects the seeded newer of session/message.
- Private room member previewing their own room (if allowed per decision) →
  `200`; non-member preview of that private room → `404` identical to a random
  uuid → `404` (compare response bodies byte-for-byte).
- Direct PostgREST call to the RPC with `visibility` parameter → no such
  parameter exists / denied.

**E2E (`tests/e2e/room-discovery.spec.ts`)**

- Browse → type a query → URL updates → results filter → reload keeps filters →
  back button restores.
- Sort switch changes order; count announced.
- Open a preview → Join → becomes member → card shows "Joined" → Open room.
- Empty state → clear filters affordance works.
- Member-count and activity visible on cards.

### Dependencies

- PR 06 (file overlap on the room card / panel; logic independent).
- PR 08 (`Closed` badge — reuse rather than duplicate).
- PR 09 soft (moderation makes public rooms safer to surface; not a code
  dependency).
- Should land **before** PR 18 (production hardening benefits from the bounded
  queries and indexes).

### Files / modules likely affected

```
supabase/migrations/0016_discovery_indexes.sql            (new)
app/api/rooms/route.ts                                   (extended params + RPC)
app/api/rooms/[id]/preview/route.ts                      (new)
app/(app)/rooms/page.tsx                                 (browse page)
app/(app)/rooms/[id]/preview/page.tsx                    (new) + loading/error
components/rooms/{room-filters,room-search,room-preview}.tsx (new)
components/room-card.tsx                                 (enrichment + a11y)
lib/rooms/{queries,shape,types}.ts                       (enriched type, cursor)
lib/validation/rooms.ts                                  (query schema)
tests/unit/... (new), tests/integration/room-discovery.test.ts (new),
tests/e2e/room-discovery.spec.ts (new)
docs/API_CONTRACTS.md (GET /api/rooms + preview), docs/SECURITY.md
(private-room invisibility row), docs/local-supabase.md (indexes, RPC),
docs/milestones.md, README.md
```

### Acceptance criteria

- [ ] A seeded private room whose name exactly matches the search term never
      appears in any list/sort/filter and 404s on preview, byte-identical to a
      nonexistent room.
- [ ] Ranking is deterministic and matches the documented precedence; paging a
      25-room set yields every room exactly once.
- [ ] Cards show member count, last activity, join status, and closed status
      with text (not colour-only).
- [ ] Preview gives enough to decide (goal, subject, language, size) and Join
      works via the existing endpoint.
- [ ] Filters live in the URL and survive reload/back.
- [ ] One data round trip per listing (no N+1) — asserted.
- [ ] Existing `GET /api/rooms` consumers still pass unchanged (additive
      contract).
- [ ] All three suites + build green locally and in CI.

### Definition of Done

1. `npx supabase db reset` from scratch; indexes created and justified in the
   migration header; RPC probes pass (private-room invisibility for every sort,
   malformed cursor `400`).
2. CI green on all three jobs.
3. `docs/API_CONTRACTS.md` documents the extended list params, cursor format
   and preview endpoint; `docs/SECURITY.md` gains the "private rooms are
   invisible" row with its test name; `docs/local-supabase.md` indexes/RPC
   tables; `docs/milestones.md` discovery status.
4. The `last_activity_at` choice (derived vs maintained) stated with its
   rationale.
5. `trigram`/fuzzy-search question recorded as a standing question if not
   adopted.
6. Reviewed by Dev B.

### Owner

**Dev A — OpenCode** (full-stack; SQL ranking + the private-room invisibility
proof are the review focus).

### Estimated complexity

**Medium.** One RPC with sorting/cursor logic, an enriched list contract, one
preview page — the risk is concentrated in the invisibility guarantees and keyset
correctness, both of which are testable.

### Risks

| Risk | Mitigation |
| --- | --- |
| Private room leaks through a filter/sort path | Single RPC with hard-coded `visibility`; dedicated test sweeping every sort/filter with a bait private room. |
| Keyset cursor skips rows on non-unique sort keys | Always append `id` tiebreaker; pagination test asserts exact set. |
| Derived `last_activity_at` too expensive | Bound by filtered set; add maintained column only if measured necessary (documented decision). |
| Widening `room_members` visibility for counts | Count computed inside the definer-rights RPC; no grant change; PR 07's assertion re-run. |
| Backward-compat break in `GET /api/rooms` | Additive-only contract; existing tests must pass untouched. |
| Wildcard-heavy `q` degrades | Escape `%`/`_`; document `ilike` limits; fuzzy search deferred. |
