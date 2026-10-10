import { createClient } from "@/lib/supabase/server";
import Link from "next/link";

/**
 * One class for every header link: comfortable as an inline item from `md:`
 * up, and a full-width touch target inside the mobile sheet. The desktop
 * header and the sheet render the *same* elements, so the link list cannot
 * drift between the two presentations.
 */
const LINK_CLASS =
  "block rounded-md px-3 py-2.5 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring md:inline-block md:px-2 md:py-1.5 md:hover:bg-transparent";

/** Always available: no session read, so it can render during prerender. */
export function NavLinks() {
  return (
    <Link href="/rooms" className={LINK_CLASS}>
      Public rooms
    </Link>
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
    <Link href="/resources" className={LINK_CLASS}>
      My resources
    </Link>
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
    <Link href="/invitations" className={LINK_CLASS}>
      Invitations
    </Link>
  );
}
