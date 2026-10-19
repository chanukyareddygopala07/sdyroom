import { AuthShell } from "@/components/auth/auth-shell";
import { LoginForm } from "@/components/login-form";
import { safeInternalPath } from "@/lib/auth/safe-next";
import { Suspense } from "react";

type LoginPageProps = {
  searchParams: Promise<{ next?: string; error?: string }>;
};

async function LoginCard({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  const next = safeInternalPath(params.next ?? null);
  const oauthError = params.error === "oauth";

  return (
    <div className="w-full">
      <LoginForm next={next} oauthError={oauthError} />
    </div>
  );
}

/**
 * Sign-in page. The OAuth callback bounces back with `?error=oauth` when a
 * provider denies, fails or is not configured, and may carry a `next`
 * resume target — which is validated against the same site-internal
 * allow-list the confirmation route uses before the form ever sees it.
 * The `searchParams` read sits inside `<Suspense>` so the route stays
 * statically exportable (cacheComponents).
 */
export default function Page({ searchParams }: LoginPageProps) {
  return (
    <AuthShell>
      <Suspense fallback={<div className="w-full" />}>
        <LoginCard searchParams={searchParams} />
      </Suspense>
    </AuthShell>
  );
}
