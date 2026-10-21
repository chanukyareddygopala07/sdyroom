import { CommunityDiscovery } from "@/components/communities/community-discovery";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

export const metadata = {
  title: "Communities · SdyRoom",
};

// Session-gated page: renders per request instead of a static shell.
export const instant = false;

/**
 * Community discovery. The listing itself runs in the client component
 * through the signed-in fetcher (private communities never leave the
 * server), while the session gate and the page chrome stay here.
 */
export default async function CommunitiesPage() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const viewerId = data?.claims?.sub;

  if (!viewerId) {
    redirect("/auth/login");
  }

  return <CommunityDiscovery />;
}
