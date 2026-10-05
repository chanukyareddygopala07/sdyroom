import { Badge } from "@/components/ui/badge";
import type { PublicRoom } from "@/lib/rooms/types";

const dateFormat = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

function formatDate(value: string): string | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : dateFormat.format(date);
}

/** Public summary of a single room. Only ever receives shaped public fields. */
export function RoomCard({ room }: { room: PublicRoom }) {
  const created = formatDate(room.created_at);

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
      </div>

      {room.shared_goal && (
        <p className="text-sm text-muted-foreground">{room.shared_goal}</p>
      )}

      <div className="mt-auto flex items-center justify-between text-sm text-muted-foreground">
        <span>
          {room.capacity} {room.capacity === 1 ? "seat" : "seats"}
        </span>
        {created && (
          <time dateTime={room.created_at}>{`Created ${created}`}</time>
        )}
      </div>
    </article>
  );
}
