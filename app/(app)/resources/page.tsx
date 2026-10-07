import { ResourceLibrary } from "@/components/resources/resource-library";
import { listResources } from "@/lib/resources/queries";
import { createClient } from "@/lib/supabase/server";
import { RESOURCE_PAGE_SIZE_DEFAULT } from "@/lib/validation/resources";
import { redirect } from "next/navigation";

export const metadata = {
  title: "My resources · SdyRoom",
};

// Session-gated page: renders per request instead of a static shell.
export const instant = false;

/**
 * The personal library: only the caller's own private files, never anything
 * shared into a room. The listing runs server-side through RLS and the client
 * component takes the result, so the first paint already shows real rows and
 * every later refresh re-enters the same API path.
 */
export default async function ResourcesPage() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const viewerId = data?.claims?.sub;

  if (!viewerId) {
    redirect("/auth/login");
  }

  const page = await listResources(supabase, {
    viewerId,
    scope: "personal",
    q: "",
    subject: null,
    chapter: null,
    limit: RESOURCE_PAGE_SIZE_DEFAULT,
    offset: 0,
  });

  return (
    <ResourceLibrary
      scope={{ kind: "personal" }}
      initialResources={page.resources}
      idPrefix="personal"
      heading="My resources"
      description="Private study files only you can open. Share one with a room from that room's workspace."
    />
  );
}
