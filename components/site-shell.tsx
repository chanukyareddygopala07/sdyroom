import { AuthButton } from "@/components/auth-button";
import { EnvVarWarning } from "@/components/env-var-warning";
import { ThemeSwitcher } from "@/components/theme-switcher";
import { hasEnvVars } from "@/lib/utils";
import Link from "next/link";
import { Suspense } from "react";

/**
 * Shared chrome for every SdyRoom page: brand, session-aware account controls
 * and footer. Rendered from the landing page and from the authenticated
 * route-group layout so navigation never duplicates.
 */
export function SiteShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen flex-col items-center">
      <div className="flex w-full flex-1 flex-col items-center gap-12">
        <nav className="flex h-16 w-full justify-center border-b border-b-foreground/10">
          <div className="flex w-full max-w-5xl items-center justify-between p-3 px-5 text-sm">
            <div className="flex items-center gap-5 font-semibold">
              <Link href="/">SdyRoom</Link>
              <Link
                href="/rooms"
                className="font-normal text-muted-foreground hover:text-foreground"
              >
                Public rooms
              </Link>
            </div>
            {!hasEnvVars ? (
              <EnvVarWarning />
            ) : (
              <Suspense>
                <AuthButton />
              </Suspense>
            )}
          </div>
        </nav>
        <div className="flex w-full max-w-5xl flex-1 flex-col gap-10 p-5">
          {children}
        </div>
        <footer className="flex w-full items-center justify-center gap-8 border-t py-10 text-center text-xs">
          <p className="text-muted-foreground">
            SdyRoom — capacity-limited study rooms for exam prep.
          </p>
          <ThemeSwitcher />
        </footer>
      </div>
    </main>
  );
}
