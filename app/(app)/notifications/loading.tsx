/**
 * Skeleton for the inbox: same vertical rhythm as the page (heading, list
 * block, preferences card) so the layout does not jump when data lands.
 */
export default function NotificationsLoading() {
  return (
    <div className="flex flex-col gap-8 animate-pulse" aria-busy="true" aria-label="Loading notifications">
      <div className="flex flex-col gap-4">
        <div className="h-8 w-48 rounded-md bg-muted" />
        <div className="h-4 w-32 rounded bg-muted" />
        <div className="flex flex-col rounded-lg border">
          {Array.from({ length: 4 }).map((_, index) => (
            <div
              key={index}
              className="flex items-center gap-3 border-b p-4 last:border-b-0"
            >
              <div className="size-8 rounded-full bg-muted" />
              <div className="flex flex-1 flex-col gap-2">
                <div className="h-3 w-1/3 rounded bg-muted" />
                <div className="h-3 w-2/3 rounded bg-muted" />
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="h-64 rounded-lg border bg-muted/40" />
    </div>
  );
}
