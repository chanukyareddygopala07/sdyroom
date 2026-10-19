"use client";

import { cn } from "@/lib/utils";
import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * A header/sheet navigation link that marks itself current with
 * `aria-current="page"` and a brand-tinted active style. The shared class
 * keeps the two presentations (inline desktop row, full-width sheet row)
 * identical apart from the caller's own responsive classes.
 */
export function ActiveNavLink({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const active = pathname === href || pathname.startsWith(`${href}/`);

  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        className,
        active && "bg-accent font-medium text-foreground",
      )}
    >
      {children}
    </Link>
  );
}
