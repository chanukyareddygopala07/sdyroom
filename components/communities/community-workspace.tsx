"use client";

import {
  CATEGORY_LABELS,
  communityApiErrorMessage,
  memberCountLabel,
} from "@/components/communities/_shared";
import { CommunityChannelSidebar } from "@/components/communities/community-channel-sidebar";
import { CommunityComposer } from "@/components/communities/community-composer";
import { CommunityMembersPanel } from "@/components/communities/community-members-panel";
import { CommunityMessageList } from "@/components/communities/community-message-list";
import { CommunitySettingsDialog } from "@/components/communities/community-settings-dialog";
import {
  EncryptionStatus,
  type EncryptionChipState,
} from "@/components/communities/encryption-status";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useCommunityWorkspace } from "@/hooks/use-community-workspace";
import {
  listChannelsClient,
  listMembersClient,
  type MemberRow,
} from "@/lib/communities/api";
import { listGroupDeviceIds } from "@/lib/crypto/mls";
import type {
  CommunityChannelRow,
  CommunityRow,
} from "@/lib/communities/types";
import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * One community's workspace: channel rail, encrypted message history,
 * composer, member roster and settings.
 *
 * The member roster and the channel list are fetched here — before the
 * crypto pipeline mounts — because the bootstrap rule needs the ordered
 * active members on the very first sync, and the pipeline needs a real
 * channel id. Everything below that line is the {@link CommunityChannelView},
 * which owns the MLS workspace for the selected channel.
 */
export function CommunityWorkspace({
  community: initialCommunity,
  membership,
  userId,
}: {
  community: CommunityRow;
  membership: { role: string; status: string; joined_at: string };
  userId: string;
}) {
  const isOwner = membership.role === "owner";
  const isStaff = isOwner || membership.role === "moderator";
  const enabled = membership.status === "active";

  const [community, setCommunity] = useState<CommunityRow>(initialCommunity);
  const [channels, setChannels] = useState<CommunityChannelRow[]>([]);
  const [channelsStatus, setChannelsStatus] = useState<
    "loading" | "ready" | "error"
  >("loading");
  const [channelsError, setChannelsError] = useState<string | null>(null);
  const [activeChannelId, setActiveChannelId] = useState<string | null>(null);
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [membersLoaded, setMembersLoaded] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // The first setState happens only after the fetch resolves, so the effect
  // below can kick this off without a synchronous render cascade.
  const loadChannels = useCallback(async () => {
    try {
      const page = await listChannelsClient(community.id);
      const sorted = [...page.channels].sort(
        (a, b) => a.position - b.position || a.name.localeCompare(b.name),
      );
      setChannels(sorted);
      setChannelsStatus("ready");
      setChannelsError(null);
      setActiveChannelId((current) => current ?? sorted[0]?.id ?? null);
    } catch (caught) {
      setChannelsStatus("error");
      setChannelsError(
        communityApiErrorMessage(caught, "Channels could not be loaded."),
      );
    }
  }, [community.id]);

  useEffect(() => {
    if (!enabled) return;
    // Deferred through a promise callback: the loader must not start
    // synchronously inside the effect body (react-hooks/set-state-in-effect).
    void Promise.resolve().then(() => loadChannels());
  }, [enabled, loadChannels]);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    listMembersClient(community.id).then(
      (page) => {
        if (disposed) return;
        setMembers(page.members);
        setMembersLoaded(true);
      },
      () => {
        // Roster failures degrade to an empty alias map; the members panel
        // reports its own errors when opened.
      },
    );
    return () => {
      disposed = true;
    };
  }, [community.id, enabled]);

  const memberOrder = useMemo(
    () =>
      members
        .filter((member) => member.status === "active")
        .sort(
          (a, b) =>
            a.joined_at.localeCompare(b.joined_at) ||
            a.user_id.localeCompare(b.user_id),
        )
        .map((member) => ({
          userId: member.user_id,
          joinedAt: member.joined_at,
        })),
    [members],
  );

  const aliases = useMemo(
    () =>
      Object.fromEntries(
        members.map((member) => [
          member.user_id,
          member.alias ?? "Unknown member",
        ]),
      ) as Record<string, string>,
    [members],
  );

  const handleChannelCreated = useCallback((channel: CommunityChannelRow) => {
    setChannels((current) =>
      current.some((existing) => existing.id === channel.id)
        ? current
        : [...current, channel].sort(
            (a, b) => a.position - b.position || a.name.localeCompare(b.name),
          ),
    );
    setActiveChannelId(channel.id);
  }, []);

  const ready = activeChannelId !== null && membersLoaded && enabled;
  const activeChannel =
    channels.find((channel) => channel.id === activeChannelId) ?? null;

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-2xl font-semibold">{community.name}</h1>
          <p className="text-sm text-muted-foreground">
            {memberCountLabel(community.member_count)}
            {" · "}
            {CATEGORY_LABELS[community.category] ?? community.category}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setMembersOpen(true)}
          >
            Members
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setSettingsOpen(true)}
          >
            Settings
          </Button>
        </div>
      </header>

      <div className="grid items-start gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
        <CommunityChannelSidebar
          communityId={community.id}
          channels={channels}
          activeChannelId={activeChannelId}
          isStaff={isStaff}
          loading={enabled && channelsStatus === "loading"}
          error={channelsStatus === "error" ? channelsError : null}
          onSelect={setActiveChannelId}
          onCreated={handleChannelCreated}
          onRetry={() => {
            setChannelsStatus("loading");
            setChannelsError(null);
            void loadChannels();
          }}
        />

        {ready ? (
          <CommunityChannelView
            key={activeChannelId}
            community={community}
            channelId={activeChannelId}
            channelName={activeChannel?.name ?? "Channel"}
            userId={userId}
            isOwner={isOwner}
            memberOrder={memberOrder}
            aliases={aliases}
          />
        ) : (
          <section
            className="flex flex-col gap-2 rounded-xl border p-5"
            aria-label="Channel"
          >
            <h2 className="text-lg font-semibold">
              {enabled ? "Opening channel…" : "Community"}
            </h2>
            <p className="text-sm text-muted-foreground">
              {enabled
                ? "Preparing the encrypted workspace for this channel."
                : "Your membership is not active yet, so messages stay closed."}
            </p>
          </section>
        )}
      </div>

      <Sheet open={membersOpen} onOpenChange={setMembersOpen}>
        <SheetContent side="right">
          <SheetHeader>
            <SheetTitle>Community members</SheetTitle>
            <SheetDescription>
              {memberCountLabel(community.member_count)} in this community.
            </SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto">
            <CommunityMembersPanel
              communityId={community.id}
              currentUserId={userId}
              isStaff={isStaff}
              isOwner={isOwner}
            />
          </div>
        </SheetContent>
      </Sheet>

      {/* Mounted only while open: the draft re-seeds from the server's row
          on every open, with no reset effect needed. */}
      {settingsOpen && (
        <CommunitySettingsDialog
          community={community}
          membership={{ role: membership.role, status: membership.status }}
          open
          onOpenChange={setSettingsOpen}
          onUpdated={setCommunity}
        />
      )}
    </div>
  );
}

/**
 * The MLS pipeline for one selected channel. Split out of the parent so the
 * hook can mount only once a real channel id and the ordered member roster
 * exist — the bootstrap decision needs both on the first sync.
 */
function CommunityChannelView({
  community,
  channelId,
  channelName,
  userId,
  isOwner,
  memberOrder,
  aliases,
}: {
  community: CommunityRow;
  channelId: string;
  channelName: string;
  userId: string;
  isOwner: boolean;
  memberOrder: Array<{ userId: string; joinedAt: string }>;
  aliases: Record<string, string>;
}) {
  const workspace = useCommunityWorkspace({
    communityId: community.id,
    channelId,
    userId,
    isOwner,
    memberOrder,
    enabled: true,
  });

  const [hasLocalGroup, setHasLocalGroup] = useState<boolean | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Honest waiting state: no local group AND this client is not the
  // deterministic founder means the channel only opens once someone who can
  // bootstrap it (or send a welcome) arrives.
  useEffect(() => {
    if (workspace.state !== "ready" && workspace.state !== "error") {
      return;
    }
    let disposed = false;
    listGroupDeviceIds(community.id, channelId).then(
      (ids) => {
        if (!disposed) setHasLocalGroup(ids !== null);
      },
      () => {
        if (!disposed) setHasLocalGroup(false);
      },
    );
    return () => {
      disposed = true;
    };
  }, [community.id, channelId, workspace.state]);

  const waiting = !workspace.willBootstrap && hasLocalGroup === false;

  const chipState: EncryptionChipState =
    workspace.state === "error" || (workspace.state === "ready" && waiting)
      ? "error"
      : workspace.state === "ready"
        ? "encrypted"
        : "setting-up";

  const canSend = workspace.canSend && !waiting;

  const handleToggleReaction = (
    targetId: string,
    emoji: string,
    removed: boolean,
  ) => {
    setActionError(null);
    void workspace
      .send({
        v: 1,
        t: "reaction",
        targetId,
        emoji,
        ...(removed ? { removed: true as const } : {}),
      })
      .catch((caught: unknown) => {
        setActionError(
          communityApiErrorMessage(
            caught,
            "That reaction could not be sent.",
          ),
        );
      });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">#{channelName}</h2>
        <EncryptionStatus state={chipState} />
      </div>

      {waiting && (
        <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          Waiting for a community member to set up encryption for this
          channel — it happens automatically when someone opens it.
        </p>
      )}

      {workspace.state === "error" && workspace.error && (
        <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed p-4">
          <p role="alert" className="text-sm text-error">
            {workspace.error}
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void workspace.refresh()}
          >
            Try again
          </Button>
        </div>
      )}

      {actionError && (
        <p role="alert" className="text-sm text-error">
          {actionError}
        </p>
      )}

      <CommunityMessageList
        communityId={community.id}
        messages={workspace.messages}
        hasMore={workspace.hasMore}
        loading={workspace.state === "loading" || workspace.state === "syncing"}
        currentUserId={userId}
        aliases={aliases}
        onLoadOlder={() => void workspace.loadOlder()}
        onToggleReaction={handleToggleReaction}
      />

      <CommunityComposer
        communityId={community.id}
        channelId={channelId}
        canSend={canSend}
        error={workspace.error}
        onSend={workspace.send}
      />
    </div>
  );
}
