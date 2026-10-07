import { createClient } from "@/lib/supabase/server";
import Link from "next/link";

const LINK_CLASS = "font-normal text-muted-foreground hover:text-foreground";

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
