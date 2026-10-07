import { FocusTimer } from "@/components/focus-timer";
import { GoalsPanel } from "@/components/goals-panel";
import { ModerationInbox } from "@/components/moderation-inbox";
import { ResourceLibrary } from "@/components/resources/resource-library";
import { RoomChat } from "@/components/room-chat";
import { RoomInvitePanel } from "@/components/room-invite-panel";
import { RoomRoster } from "@/components/room-roster";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { listMessages } from "@/lib/chat/queries";
import { FocusSessionError } from "@/lib/focus/sessions";
import { getFocusWorkspace } from "@/lib/focus/workspace";
import { listGoals } from "@/lib/goals/queries";
import {
  listRoomInvitations,
  readRoomVisibility,
  RosterDeniedError,
  roomRoster,
} from "@/lib/invitations/queries";
import { ModerationError } from "@/lib/moderation/errors";
import {
  getRoomModerationInfo,
  listBlocks,
  listReports,
} from "@/lib/moderation/queries";
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
 * chat, and recent sessions for a room — plus the member roster, and the
 * owner's invite panel when this is a private room.
 *
 * Membership is decided by the workspace read itself — a non-member and a
 * missing room both land on the same 404, so the URL never reveals which
 * rooms exist. Goals are read afterwards, through RLS, and are the caller's
 * own only. The roster repeats the membership check inside its own RPC, and
 * the invite panel only renders when the viewer both owns this room and the
 * room is private (007) — every invitation decision itself is re-proven by
 * the API regardless of what this page chose to render.
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

  // Membership is already proven by the workspace read above. The roster
  // re-checks it inside its own SECURITY DEFINER RPC, so the only failure it
  // can report here means the caller lost the seat between the two reads —
  // the same verdict as any other non-member: notFound.
  const [membersOrNull, visibility] = await Promise.all([
    roomRoster(supabase, parsedRoomId.data).catch((error: unknown) => {
      if (error instanceof RosterDeniedError) return null;
      throw error;
    }),
    readRoomVisibility(supabase, parsedRoomId.data),
  ]);
  if (membersOrNull === null) {
    notFound();
  }
  const members = membersOrNull;

  // Moderation surface for this room, read once here and passed down: who
  // may act (the API re-proves it per call), who is muted, the viewer's own
  // block list, and — for owner/moderators — the seeded inbox. Any moderation
  // denial means the seat vanished between the reads above: same verdict as
  // everywhere else on this page, notFound.
  const moderation = await getRoomModerationInfo(
    supabase,
    parsedRoomId.data,
  ).catch((error: unknown) => {
    if (error instanceof ModerationError) {
      notFound();
    }
    throw error;
  });
  const [blockedRows, viewerProfile] = await Promise.all([
    listBlocks(supabase),
    supabase
      .from("profiles")
      .select("alias")
      .eq("id", viewerId)
      .maybeSingle(),
  ]);
  const viewerAlias =
    typeof viewerProfile.data?.alias === "string"
      ? viewerProfile.data.alias
      : "";
  const blockedAliases = blockedRows.map((row) => row.alias);
  const initialReports = moderation.can_moderate
    ? await listReports(supabase, parsedRoomId.data, 50)
    : [];

  // Invitations exist for private rooms only, and only the owner manages
  // them; the owner's pending rows are read through the same RLS that
  // restricts them to the rows this viewer created, and only rows that are
  // actually still pending feed the panel — resolved history lives in the
  // invitee's inbox, not here.
  const showInvitePanel = viewer_role === "owner" && visibility === "private";
  const pendingInvitations = showInvitePanel
    ? (await listRoomInvitations(supabase, parsedRoomId.data)).filter(
        (row) => row.status === "pending",
      )
    : [];

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
              {room.status === "open" ? "Open" : "Closed"}
            </Badge>
            <Badge variant="secondary">
              {member_count} of {room.capacity}{" "}
              {room.capacity === 1 ? "seat" : "seats"} taken
            </Badge>
            <Badge variant="outline">
              {viewer_role === "owner" ? "owner" : "member"}
            </Badge>
            {/* Convenience only — the settings page and both API routes
                re-prove ownership server-side; a member who types the URL
                gets the same 404 as a stranger. */}
            {viewer_role === "owner" && (
              <Button asChild size="sm" variant="outline">
                <Link href={`/rooms/${room.id}/settings`}>Room settings</Link>
              </Button>
            )}
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

      {/* Keyed per room like the chat: a room switch must never show the
          previous room's members or its owner's pending invitations while
          the new room's request is still in flight. */}
      <RoomRoster
        key={`roster-${room.id}`}
        roomId={room.id}
        members={members}
        moderation={moderation}
        viewerAlias={viewerAlias}
        canAppoint={viewer_role === "owner"}
        blockedAliases={blockedAliases}
      />

      {/* Owner/moderator only — the page's `can_moderate` decides whether it
          renders at all, and the inbox's own API calls re-prove moderator
          rights server-side on every transition. */}
      {moderation.can_moderate && (
        <ModerationInbox
          key={`inbox-${room.id}`}
          roomId={room.id}
          initialReports={initialReports}
        />
      )}

      {showInvitePanel && (
        <RoomInvitePanel
          key={`invite-${room.id}`}
          roomId={room.id}
          initialPending={pendingInvitations}
        />
      )}

      {/* Keyed per room like the chat: the timer owns the session
          snapshot and the `studying` flag presence reports, and neither may
          survive a room switch while the new room's request is in flight.
          The key is distinct from its siblings' — two children of the same
          parent sharing a key is unsupported and can duplicate or drop
          subtrees whenever React has to regenerate the tree. */}
      <FocusTimer
        key={`timer-${room.id}`}
        roomId={room.id}
        roomName={room.name}
        initialSession={workspace.session}
        initialHistory={workspace.history}
        initialRole={workspace.viewer_role}
        initialServerNowMs={workspace.server_now_ms}
      />

      <GoalsPanel roomId={room.id} initialGoals={goals} />

      {/* Keyed per room so a room switch cannot show the previous room's
          messages or connection badge while the new channel joins. Distinct
          key prefix for the same reason as the timer above. */}
      <RoomChat
        key={`chat-${room.id}`}
        roomId={room.id}
        initialMessages={messages}
        viewerMuted={moderation.viewer_is_muted}
        mutedUntil={moderation.muted_until}
      />

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
