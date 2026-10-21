import { CommunityDetailView } from "@/components/communities/community-detail";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

export const metadata = {
  title: "Community · SdyRoom",
};

// Session-gated page: renders per request instead of a static shell.
export const instant = false;

/**
 * One community. The session gate runs here — the client body fetches the
 * community through the signed-in fetcher, so an anonymous request is sent
 * to log in before any of it renders (private communities never leave the
 * server). The segment config must stay on this server file: Next cannot
 * statically parse route config exported from a "use client" page.
 */
export default async function CommunityPage() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const viewerId = data?.claims?.sub;

  if (!viewerId) {
    redirect("/auth/login");
  }

  return <CommunityDetailView />;
}
