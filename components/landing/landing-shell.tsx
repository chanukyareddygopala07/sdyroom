import { AuthButton } from "@/components/auth-button";
import { BrandMark } from "@/components/brand-mark";
import { EnvVarWarning } from "@/components/env-var-warning";
import { MobileNav } from "@/components/layout/mobile-nav";
import { RouteFocus } from "@/components/layout/route-focus";
import { NotificationBellSlot } from "@/components/notifications/notification-bell-slot";
import { NavLinks } from "@/components/nav-links";
import { ThemeSwitcher } from "@/components/theme-switcher";
import { hasEnvVars } from "@/lib/utils";
import Link from "next/link";
import { Suspense } from "react";

/**
 * One class shared by the pill's inline links (from `md:` up) and the
 * off-canvas sheet below it, so the link list renders once and cannot drift
 * between the two presentations — the same contract `SiteShell` keeps.
 */
const LINK_CLASS =
  "block rounded-md px-3 py-2.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring md:inline-block md:px-2.5 md:py-1.5 md:hover:bg-transparent";

/**
 * Marketing chrome for the landing page: a floating, rounded pill navigation
 * (logo + wordmark, two honest destinations, session-aware account controls)
 * over the editorial hero. It reuses the exact accessibility contract of
 * `SiteShell` — skip link first, one `<nav aria-label="Main">`, `RouteFocus`
 * on `#main`, one labelled mobile sheet — but keeps the landing nav compact
 * instead of listing the signed-in app sections; those remain one room away
 * for anyone with a session. `SiteShell` still owns every authenticated
 * route, so nothing else changes.
 */
export function LandingShell({ children }: { children: React.ReactNode }) {
  const links = (
    <>
      <NavLinks />
      <a href="#how-it-works" className={LINK_CLASS}>
        How it works
      </a>
    </>
  );

  const accountControls = !hasEnvVars ? (
    <EnvVarWarning />
  ) : (
    <Suspense>
      <AuthButton />
    </Suspense>
  );

  // Same session-gated bell as the app header: absent when signed out, so
  // the landing page never implies notifications for a visitor with no
  // session (asserted by the notification e2e suite on "/").
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
      <header className="sticky top-0 z-40 w-full px-3 pt-3 sm:px-5">
        <nav
          aria-label="Main"
          className="mx-auto flex w-full max-w-5xl items-center justify-between gap-2 rounded-full border bg-card/90 px-3 py-1.5 shadow-lg shadow-black/10 backdrop-blur supports-[backdrop-filter]:bg-card/75"
        >
          <Link
            href="/"
            className="flex shrink-0 items-center gap-2 rounded-full px-2 py-1 font-semibold focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          >
            <BrandMark size={26} />
            <span>SdyRoom</span>
          </Link>
          <div className="hidden items-center gap-1 md:flex">{links}</div>
          <div className="flex shrink-0 items-center gap-1.5">
            {notificationBell}
            <div className="hidden md:block">{accountControls}</div>
            <div className="md:hidden">
              <MobileNav account={accountControls}>{links}</MobileNav>
            </div>
          </div>
        </nav>
      </header>
      <main
        id="main"
        tabIndex={-1}
        className="flex w-full flex-1 flex-col focus:outline-none"
      >
        <div className="flex w-full flex-1 flex-col gap-14 px-3 pt-4 pb-16 sm:px-5 sm:gap-16">
          {children}
        </div>
        <footer className="flex w-full items-center justify-center gap-4 border-t px-4 py-10 text-center text-xs">
          <div className="flex items-center gap-2">
            <BrandMark size={20} />
            <p className="text-muted-foreground">
              SdyRoom — capacity-limited study rooms for exam prep.
            </p>
          </div>
          <ThemeSwitcher />
        </footer>
      </main>
    </div>
  );
}
