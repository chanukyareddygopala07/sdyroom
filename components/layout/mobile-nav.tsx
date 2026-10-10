"use client";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Menu } from "lucide-react";
import { useState } from "react";

/** Stable id: the shell renders exactly one nav disclosure per page. */
export const MOBILE_NAV_SHEET_ID = "mobile-navigation-menu";

/**
 * The mobile navigation disclosure: a labelled hamburger plus the off-canvas
 * sheet that hosts the same navigation links and account controls the
 * desktop header shows inline.
 *
 * One navigation mechanism for phones (no second tab bar): under `md:` the
 * inline header links hide and this control takes over, so the link list is
 * rendered by the shell once and reused in both places — the two can never
 * drift. Radix Dialog owns the focus trap, Escape handling and focus return
 * to the trigger; a click on any link inside closes the sheet before the
 * router navigates, so it never stays open over the next page.
 */
export function MobileNav({
  children,
  account,
}: {
  /** The navigation links (server-rendered by the shell). */
  children: React.ReactNode;
  /** The session-aware account controls (server-rendered by the shell). */
  account: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-expanded={open}
          aria-controls={MOBILE_NAV_SHEET_ID}
        >
          <Menu className="size-5" />
          <span className="sr-only">Open navigation menu</span>
        </Button>
      </SheetTrigger>
      <SheetContent
        id={MOBILE_NAV_SHEET_ID}
        side="top"
        aria-label="Navigation menu"
        onClick={(event) => {
          // Navigating from inside the sheet must not leave the drawer open
          // over the next page: any link click closes it first.
          if ((event.target as HTMLElement).closest("a")) {
            setOpen(false);
          }
        }}
      >
        <SheetHeader className="sr-only">
          <SheetTitle>Navigation menu</SheetTitle>
          <SheetDescription>
            Sections of SdyRoom and your account controls.
          </SheetDescription>
        </SheetHeader>
        <nav aria-label="Main" className="flex flex-col gap-1">
          {children}
        </nav>
        <div className="border-t pt-4">{account}</div>
      </SheetContent>
    </Sheet>
  );
}
