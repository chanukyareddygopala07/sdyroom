"use client";

import { Button } from "@/components/ui/button";

/**
 * Settings failure boundary. The underlying error stays in the server logs;
 * the visitor only sees a stable message and a retry.
 */
export default function RoomSettingsError({
  reset,
}: {
  reset: () => void;
}) {
  return (
    <section className="flex flex-col items-center gap-4 rounded-lg border border-dashed p-10 text-center">
      <h1 className="text-xl font-semibold">Room settings could not be loaded</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        Something went wrong while opening the settings for this room. Your
        session is fine — try again in a moment.
      </p>
      <Button onClick={reset}>Try again</Button>
    </section>
  );
}
