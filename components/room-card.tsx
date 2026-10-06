import { RoomMembershipButton } from "@/components/room-membership-button";
import { Badge } from "@/components/ui/badge";
import type { RoomSummary } from "@/lib/rooms/types";

const dateFormat = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

function formatDate(value: string): string | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : dateFormat.format(date);
}

/**
 * Public summary of a single room. Only ever receives shaped public fields
 * plus the viewer's own membership and the aggregate seat count.
 */
export function RoomCard({ room }: { room: RoomSummary }) {
  const created = formatDate(room.created_at);
  const isFull = room.member_count >= room.capacity;
  const seatLabel = `${room.member_count} of ${room.capacity} ${
    room.capacity === 1 ? "seat" : "seats"
  } taken`;

  return (
    <article className="flex h-full flex-col gap-3 rounded-lg border p-4">
      <div className="flex items-start justify-between gap-3">
        <h2 className="font-semibold leading-snug">{room.name}</h2>
        <Badge variant={room.status === "open" ? "default" : "secondary"}>
          {room.status}
        </Badge>
      </div>

      <div className="flex flex-wrap gap-2">
        {room.exam_track && <Badge variant="outline">{room.exam_track}</Badge>}
        {room.subject && <Badge variant="outline">{room.subject}</Badge>}
        {room.language && <Badge variant="outline">{room.language}</Badge>}
        {isFull && <Badge variant="secondary">Full</Badge>}
      </div>

      {room.shared_goal && (
        <p className="text-sm text-muted-foreground">{room.shared_goal}</p>
      )}

      <div className="mt-auto flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
          <span>{seatLabel}</span>
          {created && (
            <time dateTime={room.created_at}>{`Created ${created}`}</time>
          )}
        </div>

        <RoomMembershipButton
          roomId={room.id}
          roomName={room.name}
          viewerMembership={room.viewer_membership}
          isFull={isFull}
          isClosed={room.status !== "open"}
        />
      </div>
    </article>
  );
}
