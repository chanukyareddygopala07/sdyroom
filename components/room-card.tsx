import { RoomMembershipButton } from "@/components/room-membership-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { RoomSummary } from "@/lib/rooms/types";
import Link from "next/link";

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
 * Derived activity label for a card (PR 17): newest session or message the
 * discovery RPC reported, rendered as a relative time. Clock-dependent text
 * is marked `suppressHydrationWarning` because the server's "now" and the
 * browser's will differ by seconds — only this span is affected.
 */
function activeLabel(value: string | null): string | null {
  if (!value) return null;
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return null;
  const diffMs = Math.max(0, Date.now() - then);
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "Active just now";
  if (minutes < 60) return `Active ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Active ${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days <= 7) return `Active ${days}d ago`;
  const formatted = formatDate(value);
  return formatted ? `Active on ${formatted}` : null;
}

/**
 * Public summary of a single room (PR 17 enriched). Only ever receives
 * shaped public fields plus the viewer's own membership and the aggregate
 * seat count — never participant identities. The title link carries an
 * overlay (`after:inset-0`) so the whole card is clickable while remaining
 * a single anchor with the room name as its accessible name; every control
 * inside sits above the overlay, so no interactive element nests in another.
 */
export function RoomCard({ room }: { room: RoomSummary }) {
  const created = formatDate(room.created_at);
  const active = activeLabel(room.last_activity_at);
  const isFull = room.member_count >= room.capacity;
  const seatLabel = `${room.member_count} of ${room.capacity} ${
    room.capacity === 1 ? "seat" : "seats"
  } taken`;
  const isMember = room.viewer_membership !== "none";
  const accessibleName = room.subject
    ? `${room.name}, ${room.subject}`
    : room.name;

  return (
    <article className="relative flex h-full flex-col gap-3 rounded-xl border bg-card p-4 transition-colors hover:border-primary/40">
      <div className="flex items-start justify-between gap-3">
        <h2 className="font-semibold leading-snug">
          <Link
            href={`/rooms/${room.id}/preview`}
            aria-label={accessibleName}
            className="focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring after:absolute after:inset-0 after:rounded-xl"
          >
            {room.name}
          </Link>
        </h2>
        <div className="flex shrink-0 items-center gap-1">
          {isMember && <Badge variant="outline">Joined</Badge>}
          <Badge variant={room.status === "open" ? "default" : "secondary"}>
            {room.status === "open" ? "Open" : "Closed"}
          </Badge>
        </div>
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

      <div className="relative z-10 mt-auto flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
          <span>{seatLabel}</span>
          <span className="flex flex-wrap items-center gap-x-2">
            {active && (
              <span suppressHydrationWarning>{active}</span>
            )}
            {created && (
              <time dateTime={room.created_at}>{`Created ${created}`}</time>
            )}
          </span>
        </div>

        {isMember && (
          <Button asChild size="sm" variant="secondary">
            <Link href={`/rooms/${room.id}`}>Enter room</Link>
          </Button>
        )}

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
