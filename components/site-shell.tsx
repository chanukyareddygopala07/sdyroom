import { AuthButton } from "@/components/auth-button";
import { EnvVarWarning } from "@/components/env-var-warning";
import { MobileNav } from "@/components/layout/mobile-nav";
import { RouteFocus } from "@/components/layout/route-focus";
import { NotificationBellSlot } from "@/components/notifications/notification-bell-slot";
import {
  InvitationsNavLink,
  NavLinks,
  ResourceNavLink,
} from "@/components/nav-links";
import { ThemeSwitcher } from "@/components/theme-switcher";
import { hasEnvVars } from "@/lib/utils";
import Link from "next/link";
import { Suspense } from "react";

/**
 * Shared chrome for every SdyRoom page: brand, session-aware account controls
 * and footer. Rendered from the landing page and from the authenticated
 * route-group layout so navigation never duplicates.
 *
 * Landmarks: the skip link is the first focusable element, the header holds
 * the single `<nav aria-label="Main">` (inline from `md:` up, off-canvas
 * below it), and `#main` is the focus target for both the skip link and the
 * route-change focus helper. The navigation links are rendered once and
 * reused in both presentations, so the two can never drift apart.
 */
export function SiteShell({ children }: { children: React.ReactNode }) {
  const navigation = (
    <>
      <NavLinks />
      {/* Session read: deferred so prerendering the landing page stays
          synchronous with the account controls beside it. */}
      <Suspense fallback={null}>
        <ResourceNavLink />
      </Suspense>
      <Suspense fallback={null}>
        <InvitationsNavLink />
      </Suspense>
    </>
  );

  const accountControls = !hasEnvVars ? (
    <EnvVarWarning />
  ) : (
    <Suspense>
      <AuthButton />
    </Suspense>
  );

  // PR 11: the bell lives in the header itself — visible at every width,
  // beside the account controls on desktop and beside the menu button on
  // mobile — so nothing is buried in the off-canvas sheet. Session-gated
  // like the links, and therefore inside its own Suspense.
  const notificationBell = !hasEnvVars ? null : (
    <Suspense fallback={null}>
      <NotificationBellSlot />
    </Suspense>
  );

  return (
    <div className="flex min-h-screen flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-50 focus:rounded-md focus:bg-background focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:shadow-lg focus:ring-2 focus:ring-ring"
      >
        Skip to main content
      </a>
      <RouteFocus />
      <header className="sticky top-0 z-40 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <nav aria-label="Main" className="flex w-full justify-center">
          <div className="flex w-full max-w-5xl items-center justify-between gap-3 px-4 py-2.5 text-sm">
            <div className="flex min-w-0 items-center gap-1">
              <Link
                href="/"
                className="shrink-0 rounded-md px-1 py-1.5 font-semibold focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
              >
                SdyRoom
              </Link>
              <div className="hidden items-center gap-1 md:flex">
                {navigation}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {notificationBell}
              <div className="hidden md:block">{accountControls}</div>
              <div className="md:hidden">
                <MobileNav account={accountControls}>
                  {navigation}
                </MobileNav>
              </div>
            </div>
          </div>
        </nav>
      </header>
      <main
        id="main"
        tabIndex={-1}
        className="flex w-full flex-1 flex-col items-center focus:outline-none"
      >
        <div className="flex w-full flex-1 flex-col items-center gap-12">
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
    </div>
  );
}
