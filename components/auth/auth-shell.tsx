import { BrandMark } from "@/components/brand-mark";
import Link from "next/link";

/**
 * Shared backdrop for the authentication screens: the official logo above
 * the form card, a soft brand glow behind it, and a link home. The card
 * itself stays the responsibility of each form component — every page keeps
 * its single `<h1>` inside the card, which the accessibility suite asserts.
 */
export function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex min-h-svh w-full flex-col items-center justify-center bg-glow-brand p-6 md:p-10">
      <div className="flex w-full max-w-sm flex-col items-center gap-6">
        <Link
          href="/"
          className="flex items-center gap-2 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        >
          <BrandMark size={44} alt="SdyRoom logo" />
        </Link>
        {children}
        <p className="text-center text-xs text-muted-foreground">
          <Link
            href="/"
            className="underline underline-offset-4 hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          >
            Back to home
          </Link>
        </p>
      </div>
    </div>
  );
}
