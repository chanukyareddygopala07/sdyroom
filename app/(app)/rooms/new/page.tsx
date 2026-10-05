import { RoomCreateForm } from "@/components/room-create-form";
import { getProfile } from "@/lib/profiles/queries";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

export const metadata = {
  title: "Create a room · SdyRoom",
};

// Session-gated page: renders per request instead of a static shell.
export const instant = false;

export default async function NewRoomPage() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();

  if (!data?.claims?.sub) {
    redirect("/auth/login");
  }

  let onboarded = false;
  try {
    onboarded = (await getProfile(supabase, data.claims.sub)) !== null;
  } catch {
    onboarded = false;
  }

  // Room creation requires a profile; the API would reject it with 403 anyway.
  if (!onboarded) {
    redirect("/onboarding");
  }

  return (
    <section className="flex flex-col gap-6">
      <div className="max-w-2xl">
        <h1 className="text-2xl font-semibold">Create a study room</h1>
        <p className="text-sm text-muted-foreground">
          Rooms are created through the create_room database function, so your
          owner membership and seat count are always consistent.
        </p>
      </div>
      <RoomCreateForm />
    </section>
  );
}
