import { InvitationsList } from "@/components/invitations-list";
import { listMyInvitations } from "@/lib/invitations/queries";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

export const metadata = {
  title: "Invitations · SdyRoom",
};

// Session-gated page: renders per request instead of a static shell.
export const instant = false;

/**
 * The invitee's inbox. Addressed invitations only: the query filters
 * `invitee_id` to the caller on top of the RLS policy, so this page can
 * never show the viewer's own outgoing invites or anyone else's rows. The
 * list is server-rendered (no mount-time fetch to flash a spinner) and the
 * client list handles Accept / Reject.
 */
export default async function InvitationsPage() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const viewerId = data?.claims?.sub;

  if (!viewerId) {
    redirect("/auth/login");
  }

  const invitations = await listMyInvitations(supabase, viewerId);

  return (
    <section className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">Invitations</h1>
        <p className="text-sm text-muted-foreground">
          Rooms you were invited to. Accepting gives you a seat; expiring is
          automatic and nothing is ever auto-joined.
        </p>
      </header>

      <InvitationsList initialInvitations={invitations} />
    </section>
  );
}
