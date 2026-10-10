# PR 19 — Responsive shell, navigation and accessibility baseline

**Status:** implemented on `feat/responsive-accessibility` —
[PR #13](https://github.com/chanukyareddygopala07/sdyroom/pull/13) (`b3acb0f`),
in review.
**Owner:** Dev A (OpenCode) · **Complexity:** Medium · **Migration:** none
**Depends on:** nothing (free start — parallel lane, land early because 11 and 20 place UI inside this shell)

---

### Problem

The app is desktop-only in practice. There is **no mobile navigation**: the
`(app)` shell has a fixed sidebar with no disclosure control, no `Sheet`
component exists in `components/ui/`, and nothing collapses under `sm:` — so on
a phone a student cannot move between Rooms, Library, Planner and Settings at
all. Accessibility is thin in parallel: the auth forms surface errors without
`role="alert"`, several icon-only buttons have no accessible name, focus is not
managed on route change, and there is no skip link. `docs/milestones.md` does
not record either gap, which means the roadmap was about to ship five more
feature PRs on top of a shell that fails on half the devices the product is for
(Indian students on phones).

### User story

As a student on a phone (or a screen reader, or a keyboard), I can open the
app, reach every section through a labelled menu, see content reflow without
horizontal scrolling, get told about errors, and complete sign-in and the core
workflows without ever needing a mouse.

---

### Scope

- **Responsive shell**: sidebar → off-canvas `Sheet` under `md:` with a labelled
  hamburger (`aria-expanded`, `aria-controls`), open/close animation respecting
  `prefers-reduced-motion`, focus trapped while open, Escape closes, focus
  returns to the trigger. Desktop keeps the current sidebar.
- **Bottom/top nav decision**: recommend **Sheet-from-top-or-side** only (one
  mechanism) rather than a separate mobile tab bar — less code, no duplicated
  active states. State the choice in the PR.
- **Header consolidation**: one responsive header slot that hosts — in order —
  page title/breadcrumb, then PR 11's notification bell, then the nav trigger
  on mobile. This PR defines the slot; 11 and 20 drop into it.
- **Content reflow rules**: base single-column under `md:`; grid columns defined
  with a shared breakpoint token (no magic numbers scattered); tables → stacked
  cards or horizontal scroll containers with a labelled scroll region; long
  content (`pre`, code, chat lines) wraps or scrolls inside its own container;
  `min-width: 0` on flex/grid children where overflow currently clips.
- **Touch targets**: ≥44×44px for primary controls; verified on the room
  workspace controls (timer buttons, chat send, resource actions).
- **Accessibility baseline (whole `(app)` tree + auth)**:
  - skip-to-content link as first focusable element;
  - `role="alert"` (or `aria-live="assertive"`) on every form error, including
    sign-in/sign-up/auth forms that today only render visible text;
  - accessible names on all icon-only buttons (bell, menu, send, overflow
    menus, chart controls from later PRs);
  - focus management on client-side route change (move focus to `<h1>`/main) —
    announce route change for screen readers;
  - one `<h1>` per page, heading order not skipped;
  - visible focus ring everywhere (verify no `outline: none` without a
    replacement);
  - form labels associated with inputs (no placeholder-only fields), errors
    linked via `aria-describedby`/`aria-invalid`;
  - modals/menus/drawers follow the existing Radix primitives (repo already
    uses Radix via shadcn) — no hand-rolled focus traps;
  - colour contrast AA on the existing palette (fix any token that fails);
  - images/icons that convey meaning have text or `aria-label`; decorative ones
    are `aria-hidden`.
- **Motion/perf hygiene**: no layout shift from the drawer; `scroll-behavior`
  respects reduced motion; no blocking of the first render by the nav JS.
- **A minimal check** to stop regressions: add `axe` (or
  `@axe-core/playwright`) and run it in e2e on the main routes (sign-in, rooms
  list, room workspace, library, settings) with **zero serious/critical
  violations** as a CI gate.

### Out of scope

- Visual redesign, new brand, dark mode, theme system (existing tokens only;
  a dark-mode PR is separate and not scheduled).
- PWA/service worker/offline support.
- i18n/translation infrastructure (language field is data, not UI
  localisation).
- Print stylesheets.
- Full WCAG audit of every edge route (baseline covers core routes; a
  comprehensive audit is a follow-up once 19 lands).
- Chart accessibility for later analytics (PR 16 owns it — this PR only sets
  the shell/header rules they must fit into).
- Animations library, page transitions, skeleton screens for all routes.
- Changing any API, DB, or business logic (this PR is UI/shell only — a hard
  rule that keeps it reviewable).
- Fixing every `loading.tsx`/`error.tsx` gap (routes lacking them are PR 21's
  inventory; this PR adds the pattern for shell-level failures only).

---

### Frontend work

| File | Change |
| --- | --- |
| `app/(app)/layout.tsx` | Shell restructure: header slot + main landmark (`id="main"`) + skip link + `<div>` sidebar ↔ Sheet swap at `md:`. Preserves existing data fetching (list rooms/current user). |
| `components/layout/sidebar.tsx` (new or refactored) | Shared nav definition (single source of truth for items + active state) rendered both as desktop sidebar and Sheet contents — **one component, two wrappers**, no duplicated link lists. |
| `components/layout/mobile-nav-trigger.tsx` (new) | Hamburger with `aria-expanded`/`aria-controls`/accessible name; hidden at `md:`. |
| `components/layout/header.tsx` (new) | Title slot + right cluster (bell slot, user menu, trigger). Documents the insertion contract PRs 11/20 use. |
| `components/ui/sheet.tsx` (new, shadcn) | Radix Dialog-derived sheet, side variants, matches existing `components/ui/*` conventions. |
| `components/ui/*` audit | Ensure every icon-only `Button` in use has a name; add `aria-label` props where missing (bell placeholder, chat send, resource overflow, timer controls). |
| Auth forms (`app/(auth)/...` or wherever sign-in/sign-up live) | Add `role="alert"` error containers, `aria-invalid` + `aria-describedby` on fields, associate labels. |
| `app/globals.css` (or equivalent) | Breakpoint tokens / `min-width: 0` fixes / `outline` replacement / `prefers-reduced-motion` block; keep changes surgical and commented by intent (not by narration). |
| Focus-on-navigation helper | `lib/a11y/focus-route.ts` — on pathname change, focus the main heading; wired in the shell. |
| e2e: `tests/e2e/a11y.spec.ts` (new) | axe runs on the core routes + a keyboard-only navigation pass + a mobile viewport pass (drawer open/close, Escape, focus return). |

Scope rule for review: **any file outside layout/nav/auth/globals/a11y gets a
one-line justification in the PR description** — if a feature file needs edits
to pass the axe gate, prefer fixing it generically (a shared Button prop) over
editing feature logic.

### Backend work

None. No route handlers, no API changes, no server actions.

### Database work

None.

### Storage work

None.

### Realtime work

None.

### AI work

None.

---

### Security requirements

Accessibility is not a security feature, but this PR has two adjacent rules:

1. **No focus trap that traps indefinitely**: the Sheet must be dismissible by
   keyboard (Escape) and must return focus to its trigger — a trap that cannot
   be exited is a denial of access, and a stuck overlay that blocks the "Log
   out" control is a session-hygiene issue.
2. **No new inline event handlers or `dangerouslySetInnerHTML`** introduced
   while restructuring; the shell refactor must not weaken any existing
   sanitisation.
3. Errors must not disclose more via `aria-live` than they already display
   visually — the alert text equals the visible text (a screen reader must not
   become an oracle for internals: no stack traces, no provider messages,
   exactly the codes/messages already shown).
4. Skip link and landmarks do not alter auth behaviour: `/api/*` and middleware
   guards untouched; a signed-out user still cannot reach `(app)` routes.

Positive guarantees:

- A keyboard-only user can complete: sign in → open nav → enter a room → open
  chat → upload → settings → sign out.
- Zero serious/critical axe violations on the gated routes in CI.

### API contracts

None (no endpoints added or changed). One internal contract worth recording in
the PR for 11/20:

```ts
// components/layout/header.tsx exports slots the shell fills:
//   <Header titleSlot leftSlot rightSlot triggerSlot />
// Notifications (PR 11) mounts in rightSlot; profile menu (PR 20) mounts after it.
// Both must render `hidden md:flex` ordering per the shell's group.
```

### Tests

**Unit**

- `sidebar` nav definition: single source list, active-state derivation for
  nested routes (`/rooms/[id]` marks Rooms active).
- Mobile trigger: `aria-expanded` toggles, `aria-controls` matches the Sheet
  id, accessible name present.
- Sheet open/close: Escape handler, focus return target, reduced-motion
  respects the media query (jsdom lacks it — assert the class/prop wiring and
  leave the visual check to e2e).
- Auth form errors: `role="alert"` container renders when an error exists,
  `aria-invalid`/`aria-describedby` wiring.
- `focus-route` helper: called on pathname change with the right element.

**Integration**

None (no server changes). **Do not add integration tests that assert DOM in
`tests/integration`** — that suite is API/DB; a reviewer should see no new
integration files here.

**E2E (`tests/e2e/a11y.spec.ts` + extensions)**

- axe: zero serious/critical violations on `/sign-in`, `/rooms`,
  `/rooms/[id]`, `/resources`, `/settings` (desktop + mobile viewport).
- Keyboard pass: tab from address bar → skip link visible → activates → focus
  lands in main; then reach nav, open a room, all without a pointer.
- Mobile viewport: hamburger opens the Sheet, tab is trapped while open, Escape
  closes and focus returns to the hamburger, nav links navigate and close the
  sheet.
- Auth: submit an invalid form → error announced (assert `role="alert"` present
  with the message) → correct it → success.
- Regression guard: existing e2e specs (rooms, chat, resources, invitations,
  moderation, notifications, analytics, planner…) still pass **unchanged** —
  their selectors must not be broken by the shell restructure. If a selector
  must change, update that spec in this PR and say so.

### Dependencies

- **None — start immediately.** It is a free lane.
- Land **before** PR 11 and PR 20 (both place UI into the header slot) — they
  are told to coordinate with this PR.
- PR 16's analytics nav entry should also land after this so there is one nav
  list to edit (coordinate: 16 either waits for 19 or adds to the shared nav
  definition only).

### Files / modules likely affected

```
app/(app)/layout.tsx                                    (shell restructure)
app/(auth)/… (sign-in/sign-up forms)                    (role=alert, aria wiring)
app/globals.css                                         (tokens, motion, focus)
components/layout/{sidebar,header,mobile-nav-trigger}.tsx (new/refactored)
components/ui/sheet.tsx                                 (new)
components/ui/button.tsx etc.                           (accessible-name support)
components/{chat-panel,room-chat,timer,resource-*}.tsx  (only if needed for aria labels)
lib/a11y/focus-route.ts, lib/a11y/axe.ts                (new)
tests/e2e/a11y.spec.ts                                  (new)
tests/e2e/*.spec.ts                                     (only if selectors break — stated)
README.md (a11y note), docs/milestones.md               (record the gap now closed)
```

### Acceptance criteria

- [ ] On a phone-width viewport every section of the app is reachable through
      the labelled menu; no horizontal page scrolling on core routes.
- [ ] Keyboard-only completion of sign-in → room → chat → upload → settings →
      sign-out works; skip link is first and functional.
- [ ] Every form error on auth and core forms has `role="alert"` and field
      association.
- [ ] Every icon-only control has an accessible name (asserted in unit tests
      for the shared components).
- [ ] axe reports zero serious/critical violations on the gated routes in CI on
      both viewports.
- [ ] Sheet: focus trap, Escape, focus return, reduced-motion respected.
- [ ] No API/DB/business-logic changes in the diff.
- [ ] Existing e2e specs pass unchanged (or changes are listed and justified).
- [ ] All three suites + build green locally and in CI.

### Definition of Done

1. CI green on all three jobs, with the new axe gate enforced (a violation
   fails the run — verify by temporarily introducing one locally, then
   reverting).
2. The header slot contract documented in the PR description (and a short
   comment at the slot) for PRs 11/20.
3. `docs/milestones.md` gains/updates a row for responsive/a11y; README gains a
   one-line accessibility note (supported viewports, keyboard support).
4. Diff contains no non-UI file changes beyond docs (except a shared UI
   component prop) — stated in the PR description.
5. Reviewed by Dev B (who should verify the diff stayed in scope).

### Owner

**Dev A — OpenCode** (frontend; the whole PR is theirs).

### Estimated complexity

**Medium.** One layout restructure with wide blast radius on selectors, plus a
discipline pass over forms and buttons — mechanically simple, easy to regress,
which is exactly why e2e is the safety net.

### Risks

| Risk | Mitigation |
| --- | --- |
| Shell restructure breaks existing e2e selectors | Run the full e2e suite before merge; changes listed explicitly; prefer additive wrappers over renames. |
| Scope creep into feature logic | Hard rule: UI/shell only; non-UI edits need a one-line justification; Dev B reviews scope. |
| Axe gate blocked by a pre-existing violation in a feature component | Fix generically (shared component) rather than skipping the route; if a fix genuinely belongs to another PR, gate the routes that are clean now and add the rest as the owning PRs land — state this explicitly. |
| Focus-on-route-change fights client libraries | Implement in the shell with the existing router events; test in e2e, not just unit. |
| Performance regression from drawer JS on mobile | Sheet content is the existing nav component (no duplicated trees); measure first paint before/after and note it. |
| Two nav lists drift (desktop vs mobile) | Single nav definition rendered by two wrappers — a unit test asserts one source list. |
