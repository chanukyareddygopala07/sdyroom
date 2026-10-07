/**
 * Settings shell while the room row and roster stream in. The parent
 * workspace's loading state covers this segment too, but settings renders a
 * shorter skeleton of its own so a navigation straight to the URL never
 * flashes workspace-sized placeholders.
 */
export default function RoomSettingsLoading() {
  return (
    <section className="flex flex-col gap-6" aria-hidden="true">
      <div className="flex flex-col gap-2">
        <div className="h-4 w-32 animate-pulse rounded bg-accent" />
        <div className="h-8 w-48 animate-pulse rounded bg-accent" />
      </div>
      <div className="h-72 animate-pulse rounded-xl border bg-accent" />
      <div className="h-40 animate-pulse rounded-xl border bg-accent" />
    </section>
  );
}
