import { FocusTimer } from "@/components/focus-timer";
import { GoalsPanel } from "@/components/goals-panel";
import { ResourceLibrary } from "@/components/resources/resource-library";
import { RoomChat } from "@/components/room-chat";
import { Badge } from "@/components/ui/badge";
import { listMessages } from "@/lib/chat/queries";
import { FocusSessionError } from "@/lib/focus/sessions";
import { getFocusWorkspace } from "@/lib/focus/workspace";
import { listGoals } from "@/lib/goals/queries";
import { listResources } from "@/lib/resources/queries";
import { createClient } from "@/lib/supabase/server";
import { MESSAGE_PAGE_SIZE_DEFAULT } from "@/lib/validation/chat";
import { RESOURCE_PAGE_SIZE_DEFAULT } from "@/lib/validation/resources";
import { roomIdSchema } from "@/lib/validation/rooms";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

export const metadata = {
  title: "Study room · SdyRoom",
};

// Session-gated page: renders per request instead of a static shell.
export const instant = false;

type RoomPageProps = {
  params: Promise<{ id: string }>;
};

/**
 * The shared study workspace: focus timer, the viewer's own goals, the room
 * chat, and recent sessions for a room.
 *
 * Membership is decided by the workspace read itself — a non-member and a
 * missing room both land on the same 404, so the URL never reveals which
 * rooms exist. Goals are read afterwards, through RLS, and are the caller's
 * own only.
 */
export default async function RoomWorkspacePage({ params }: RoomPageProps) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const viewerId = data?.claims?.sub;

  if (!viewerId) {
    redirect("/auth/login");
  }

  const { id } = await params;
  const parsedRoomId = roomIdSchema.safeParse(id);
  if (!parsedRoomId.success) {
    notFound();
  }

  let workspace;
  try {
    workspace = await getFocusWorkspace(supabase, parsedRoomId.data);
  } catch (error) {
    if (error instanceof FocusSessionError && error.status === 404) {
      notFound();
    }
    throw error;
  }

  // Membership is already proven by the workspace read above, so the library
  // query here is simply RLS applying room membership to the same viewer.
  const [goals, { messages }, resources] = await Promise.all([
    listGoals(supabase, parsedRoomId.data),
    listMessages(supabase, {
      roomId: parsedRoomId.data,
      viewerId,
      limit: MESSAGE_PAGE_SIZE_DEFAULT,
    }),
    listResources(supabase, {
      viewerId,
      scope: "room",
      roomId: parsedRoomId.data,
      q: "",
      subject: null,
      chapter: null,
      limit: RESOURCE_PAGE_SIZE_DEFAULT,
      offset: 0,
    }),
  ]);
  const { room, member_count, viewer_role } = workspace;

  return (
    <section className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <Link
          href="/rooms"
          className="text-sm text-muted-foreground hover:underline"
        >
          ← All rooms
        </Link>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold">{room.name}</h1>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={room.status === "open" ? "default" : "secondary"}>
              {room.status}
            </Badge>
            <Badge variant="secondary">
              {member_count} of {room.capacity}{" "}
              {room.capacity === 1 ? "seat" : "seats"} taken
            </Badge>
            <Badge variant="outline">
              {viewer_role === "owner" ? "owner" : "member"}
            </Badge>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {room.exam_track && <Badge variant="outline">{room.exam_track}</Badge>}
          {room.subject && <Badge variant="outline">{room.subject}</Badge>}
          {room.language && <Badge variant="outline">{room.language}</Badge>}
        </div>
        {room.shared_goal && (
          <p className="text-sm text-muted-foreground">{room.shared_goal}</p>
        )}
      </header>

      <FocusTimer
        roomId={room.id}
        roomName={room.name}
        initialSession={workspace.session}
        initialHistory={workspace.history}
        initialRole={workspace.viewer_role}
        initialServerNowMs={workspace.server_now_ms}
      />

      <GoalsPanel roomId={room.id} initialGoals={goals} />

      {/* Keyed per room so a room switch cannot show the previous room's
          messages or connection badge while the new channel joins. */}
      <RoomChat key={room.id} roomId={room.id} initialMessages={messages} />

      {/* Same keying rationale: files from another room must never be listed
          while the new room's request is still in flight. */}
      <ResourceLibrary
        key={`resources-${room.id}`}
        scope={{ kind: "room", roomId: room.id }}
        initialResources={resources.resources}
        idPrefix={`room-${room.id}`}
        level={2}
        heading="Resources"
        description="Files shared with this room. Every member can open them; only the uploader can delete them."
      />
    </section>
  );
}
