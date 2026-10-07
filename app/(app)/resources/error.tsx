"use client";

import { Button } from "@/components/ui/button";
import { useEffect } from "react";

/**
 * Boundary for `/resources`. The page reads the library during rendering, so a
 * database or storage outage lands here rather than as an unhandled rejection;
 * the retry re-runs the server component.
 */
export default function ResourcesError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[resources] page failed:", error);
  }, [error]);

  return (
    <section className="flex flex-col gap-4" role="alert">
      <h1 className="text-2xl font-semibold">Your files could not be loaded</h1>
      <p className="text-sm text-muted-foreground">
        Something went wrong on our side. Nothing was changed — try again in a
        moment.
      </p>
      <div>
        <Button type="button" size="sm" onClick={reset}>
          Try again
        </Button>
      </div>
    </section>
  );
}
