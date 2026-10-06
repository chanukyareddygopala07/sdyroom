/**
 * Workspace shell while the room, timer and goals stream in. The page is
 * session-gated (`instant = false`), so this is what a signed-in member sees
 * on navigation rather than a static placeholder.
 */
export default function RoomWorkspaceLoading() {
  return (
    <section className="flex flex-col gap-6" aria-hidden="true">
      <div className="flex flex-col gap-2">
        <div className="h-4 w-24 animate-pulse rounded bg-accent" />
        <div className="h-8 w-64 animate-pulse rounded bg-accent" />
        <div className="h-5 w-96 max-w-full animate-pulse rounded bg-accent" />
      </div>
      <div className="h-64 animate-pulse rounded-xl border bg-accent" />
      <div className="h-48 animate-pulse rounded-xl border bg-accent" />
    </section>
  );
}
