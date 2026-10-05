import Link from "next/link";
import { Button } from "./ui/button";
import { getProfile } from "@/lib/profiles/queries";
import { createClient } from "@/lib/supabase/server";
import { LogoutButton } from "./logout-button";

/**
 * Session-aware account controls: signed-out visitors get sign in / sign up,
 * signed-in visitors see their study alias (or a prompt to pick one).
 */
export async function AuthButton() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const user = data?.claims;

  if (!user) {
    return (
      <div className="flex gap-2">
        <Button asChild size="sm" variant={"outline"}>
          <Link href="/auth/login">Sign in</Link>
        </Button>
        <Button asChild size="sm" variant={"default"}>
          <Link href="/auth/sign-up">Sign up</Link>
        </Button>
      </div>
    );
  }

  let profile = null;
  try {
    profile = await getProfile(supabase, user.sub);
  } catch {
    profile = null;
  }

  return (
    <div className="flex items-center gap-4">
      {profile ? (
        <span>Hey, {profile.alias}!</span>
      ) : (
        <Link href="/onboarding" className="underline underline-offset-4">
          Choose a study alias
        </Link>
      )}
      <LogoutButton />
    </div>
  );
}
