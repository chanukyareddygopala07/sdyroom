import { RoomDeleteControl } from "@/components/room-delete-control";
import { RoomSettingsForm } from "@/components/room-settings-form";
import { Badge } from "@/components/ui/badge";
import { RosterDeniedError, roomRoster } from "@/lib/invitations/queries";
import { getOwnedRoom } from "@/lib/rooms/queries";
import { createClient } from "@/lib/supabase/server";
import { roomIdSchema } from "@/lib/validation/rooms";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

export const metadata = {
  title: "Room settings · SdyRoom",
};

// Session-gated page: renders per request instead of a static shell.
export const instant = false;

type SettingsPageProps = {
  params: Promise<{ id: string }>;
};

/**
 * Owner-only room settings: edit the mutable fields, change capacity, close
 * or reopen, and the delete danger zone.
 *
 * Authorization is a server decision twice over: `getOwnedRoom` returns a
 * room only when this session's own `room_members` row says `owner` (a
 * non-member and a missing room are the same `null`, and a plain member is
 * the other `null`), and every write below repeats the check inside its own
 * API route / RPC. Hiding the link on the workspace is convenience, not
 * security.
 *
 * The member count seeds the capacity floor hint; a roster hiccup degrades
 * to "no hint" rather than blocking the settings page the caller has already
 * proven they own.
 */
export default async function RoomSettingsPage({ params }: SettingsPageProps) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();

  if (!data?.claims?.sub) {
    redirect("/auth/login");
  }

  const { id } = await params;
  const parsedRoomId = roomIdSchema.safeParse(id);
  if (!parsedRoomId.success) {
    notFound();
  }

  const room = await getOwnedRoom(supabase, parsedRoomId.data);
  if (!room) {
    notFound();
  }

  const memberCount = await roomRoster(supabase, parsedRoomId.data)
    .then((members) => members.length)
    .catch((error: unknown) => {
      if (error instanceof RosterDeniedError) {
        return null;
      }
      throw error;
    });

  return (
    <section className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <Link
          href={`/rooms/${room.id}`}
          className="text-sm text-muted-foreground hover:underline"
        >
          ← Back to the room
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">Room settings</h1>
          <Badge variant={room.status === "open" ? "default" : "secondary"}>
            {room.status === "open" ? "Open" : "Closed"}
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          {room.name} · changes apply to everyone in the room.
        </p>
      </header>

      <RoomSettingsForm
        key={`settings-${room.id}`}
        room={room}
        memberCount={memberCount}
      />

      <RoomDeleteControl
        key={`delete-${room.id}`}
        roomId={room.id}
        roomName={room.name}
      />
    </section>
  );
}
