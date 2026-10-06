import { Button } from "@/components/ui/button";
import Link from "next/link";

/**
 * Root 404. Reachable from any URL — including a workspace for a room that
 * does not exist or one the visitor is not a member of, which both land here
 * deliberately so membership cannot be probed.
 */
export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-8 text-center">
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        This page does not exist, or you do not have access to it. If you were
        heading for a study room, the room may have been removed or is not one
        of yours.
      </p>
      <div className="flex gap-2">
        <Button asChild>
          <Link href="/rooms">Back to rooms</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/">Home</Link>
        </Button>
      </div>
    </main>
  );
}
