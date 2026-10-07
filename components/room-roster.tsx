"use client";

import { Badge } from "@/components/ui/badge";
import { useRoomPresence } from "@/lib/chat/presence-store";
import type { RoomMemberView } from "@/lib/invitations/types";

/**
 * The room's member roster: everyone with a seat, not everyone online.
 *
 * Membership arrives server-rendered with the workspace page (through the
 * membership-checked `room_roster` RPC), so the list is present on first
 * paint and needs no fetch to fail or flash. Live presence is annotation
 * only, read from the store `RoomChat` publishes — the roster never stores a
 * watcher, never opens its own channel, and shows no annotation until a
 * channel for *this* room has actually synced. Aliases match because both
 * sides read the same `profiles.alias` column.
 */
export function RoomRoster({
  roomId,
  members,
}: {
  roomId: string;
  members: RoomMemberView[];
}) {
  const participants = useRoomPresence(roomId);

  const annotation = (alias: string): React.ReactNode => {
    if (participants === undefined) return null;
    const observed = participants.find(
      (participant) => participant.alias.toLowerCase() === alias.toLowerCase(),
    );
    if (!observed) {
      return (
        <span className="text-xs text-muted-foreground">Offline</span>
      );
    }
    if (observed.studying) {
      return <Badge variant="default">Focusing</Badge>;
    }
    return <Badge variant="secondary">Here</Badge>;
  };

  return (
    <section aria-labelledby={`roster-${roomId}`} className="flex flex-col gap-3">
      <div className="flex items-baseline gap-2">
        <h2 id={`roster-${roomId}`} className="text-lg font-semibold">
          Members
        </h2>
        <span className="text-sm text-muted-foreground">{members.length}</span>
      </div>
      <ul className="flex flex-col gap-2">
        {members.map((member) => (
          <li
            key={member.alias.toLowerCase()}
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2"
          >
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{member.alias}</span>
              {member.role === "owner" && (
                <Badge variant="outline">owner</Badge>
              )}
            </div>
            <div className="flex items-center gap-3">
              <time
                className="text-xs text-muted-foreground"
                dateTime={member.joined_at}
              >
                {/* Fixed UTC date, never toLocaleDateString: the server and
                    the browser must agree or hydration mismatches on every
                    render (the repo's rule in resource-library). */}
                Joined {member.joined_at.slice(0, 10)}
              </time>
              {annotation(member.alias)}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
