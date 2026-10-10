"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

/**
 * Moves keyboard focus (and the screen reader's reading position) to the
 * page's main landmark after a client-side navigation, so a keyboard or
 * screen-reader user is not left at the header link they just activated on
 * every route change.
 *
 * The first render is skipped — a full page load already starts at the top
 * of the document — and the same-path re-render (a `router.refresh()`, a
 * search-parameter change handled by the page itself) does not steal focus
 * mid-interaction.
 */
export function RouteFocus() {
  const pathname = usePathname();
  const previousPathname = useRef<string | null>(null);

  useEffect(() => {
    if (previousPathname.current === null) {
      previousPathname.current = pathname;
      return;
    }
    if (previousPathname.current === pathname) {
      return;
    }
    previousPathname.current = pathname;

    const main = document.getElementById("main");
    if (main instanceof HTMLElement) {
      main.focus({ preventScroll: true });
      window.scrollTo({ top: 0, left: 0 });
    }
  }, [pathname]);

  return null;
}
