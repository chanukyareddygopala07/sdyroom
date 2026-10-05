import { RoomCard } from "@/components/room-card";
import { RoomSearchForm } from "@/components/room-search-form";
import { Button } from "@/components/ui/button";
import { listPublicRooms } from "@/lib/rooms/queries";
import { createClient } from "@/lib/supabase/server";
import { roomSearchSchema, type RoomSearchInput } from "@/lib/validation/rooms";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";

export const metadata = {
  title: "Public rooms · SdyRoom",
};

// Session-gated page: renders per request instead of a static shell.
export const instant = false;

type RoomsPageProps = {
  searchParams: Promise<{ q?: string }>;
};

function ResultsSkeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-2" aria-hidden="true">
      {Array.from({ length: 4 }).map((_, index) => (
        <div key={index} className="h-40 animate-pulse rounded-lg bg-accent" />
      ))}
    </div>
  );
}

/**
 * Streams the room list. The session and search validation happen in the page
 * above, so a redirect still wins the race against this boundary flushing.
 */
async function RoomsResults({
  search,
  invalidQuery,
}: {
  search: RoomSearchInput;
  invalidQuery: boolean;
}) {
  const supabase = await createClient();
  const rooms = invalidQuery ? [] : await listPublicRooms(supabase, search);

  if (rooms.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
        {invalidQuery
          ? "No rooms were loaded."
          : search.q
            ? "No public rooms match your search."
            : "No public rooms yet. Create the first one."}
      </div>
    );
  }

  return (
    <>
      <p className="text-sm text-muted-foreground" role="status">
        {rooms.length} {rooms.length === 1 ? "room" : "rooms"}
        {search.q ? ` matching “${search.q}”` : ""} — public rooms only.
      </p>
      <ul className="grid gap-4 sm:grid-cols-2">
        {rooms.map((room) => (
          <li key={room.id}>
            <RoomCard room={room} />
          </li>
        ))}
      </ul>
    </>
  );
}

export default async function RoomsPage({ searchParams }: RoomsPageProps) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();

  if (!data?.claims) {
    redirect("/auth/login");
  }

  const parsedSearch = roomSearchSchema.safeParse({
    q: (await searchParams).q,
  });
  const search = parsedSearch.success ? parsedSearch.data : { q: "" };
  const invalidQuery = !parsedSearch.success;
  const searchError = parsedSearch.success
    ? null
    : (parsedSearch.error.issues[0]?.message ?? "Invalid search.");

  return (
    <section className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">Public study rooms</h1>
          <p className="text-sm text-muted-foreground">
            Only public rooms appear here. Private rooms stay unlisted.
          </p>
        </div>
        <Button asChild>
          <Link href="/rooms/new">Create a room</Link>
        </Button>
      </header>

      <Suspense
        fallback={
          <div className="h-16 w-full animate-pulse rounded-md bg-accent" />
        }
      >
        <RoomSearchForm key={search.q} />
      </Suspense>

      {searchError && (
        <p className="text-sm text-red-500" role="alert">
          {searchError}
        </p>
      )}

      <Suspense fallback={<ResultsSkeleton />}>
        <RoomsResults search={search} invalidQuery={invalidQuery} />
      </Suspense>
    </section>
  );
}
