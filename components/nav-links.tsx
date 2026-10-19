import { ActiveNavLink } from "@/components/layout/active-nav-link";
import { createClient } from "@/lib/supabase/server";

/**
 * One class for every header link: comfortable as an inline item from `md:`
 * up, and a full-width touch target inside the mobile sheet. The desktop
 * header and the sheet render the *same* elements, so the link list cannot
 * drift between the two presentations. Active destinations pick up
 * `aria-current="page"` plus a brand-tinted pill from `ActiveNavLink`.
 */
const LINK_CLASS =
  "block rounded-md px-3 py-2.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring md:inline-block md:px-2.5 md:py-1.5 md:hover:bg-transparent";

/** Always available: no session read, so it can render during prerender. */
export function NavLinks() {
  return (
    <ActiveNavLink href="/rooms" className={LINK_CLASS}>
      Public rooms
    </ActiveNavLink>
  );
}

/**
 * The resource library is session-gated and reads the viewer's own rows, so it
 * is only offered once a session actually exists — a signed-out visitor is not
 * pointed at a route that would just bounce them to the login screen. Reading
 * the session touches cookies, which is why callers mount this inside
 * `<Suspense>`; the same pattern the account controls already use.
 */
export async function ResourceNavLink() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();

  if (!data?.claims) {
    return null;
  }

  return (
    <ActiveNavLink href="/resources" className={LINK_CLASS}>
      My resources
    </ActiveNavLink>
  );
}

/**
 * The invitation inbox is session-gated the same way: a signed-out visitor
 * is not pointed at a route that would bounce them to login, and the session
 * read is why callers mount this inside its own `<Suspense>`.
 */
export async function InvitationsNavLink() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();

  if (!data?.claims) {
    return null;
  }

  return (
    <ActiveNavLink href="/invitations" className={LINK_CLASS}>
      Invitations
    </ActiveNavLink>
  );
}

/**
 * Study analytics are the caller's own panel (PR 16), so the link only
 * appears once a session exists — same gate and `<Suspense>` rationale as
 * the two links above.
 */
export async function AnalyticsNavLink() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();

  if (!data?.claims) {
    return null;
  }

  return (
    <ActiveNavLink href="/analytics" className={LINK_CLASS}>
      Analytics
    </ActiveNavLink>
  );
}

/**
 * Settings (PR 20): where the student edits their own profile. Session-gated
 * and `<Suspense>`-mounted like the account-adjacent links above, and placed
 * in this shared list — which renders into both the desktop header and the
 * mobile sheet — so the two presentations cannot drift. PR 19's profile menu
 * will grow its own "Settings" destination when it lands; this link is the
 * hand-off until then.
 */
export async function SettingsNavLink() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();

  if (!data?.claims) {
    return null;
  }

  return (
    <ActiveNavLink href="/settings" className={LINK_CLASS}>
      Settings
    </ActiveNavLink>
  );
}
