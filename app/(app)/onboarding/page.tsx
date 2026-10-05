import { OnboardingForm } from "@/components/onboarding-form";
import { getProfile } from "@/lib/profiles/queries";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

export const metadata = {
  title: "Choose a study alias · SdyRoom",
};

// Session-gated page: renders per request instead of a static shell.
export const instant = false;

export default async function OnboardingPage() {
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

  // Already onboarded users go straight to room discovery.
  if (onboarded) {
    redirect("/rooms");
  }

  return (
    <section className="flex flex-col items-center gap-6 pt-4">
      <div className="w-full max-w-sm">
        <OnboardingForm />
      </div>
    </section>
  );
}
