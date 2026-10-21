"use client";

import { communityApiErrorMessage } from "@/components/communities/_shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  listMembersClient,
  removeMemberClient,
  setMemberClient,
  type MemberRow,
} from "@/lib/communities/api";
import { MoreHorizontal, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

/**
 * The member roster with staff controls. The list is the server's answer to
 * `GET /communities/[id]/members` — staff additionally see join requests and
 * can approve, ban, remove and promote; owners can also change roles. Every
 * mutation re-reads the roster, so what stays on screen is always the
 * server's truth, never an optimistic guess.
 */
export function CommunityMembersPanel({
  communityId,
  currentUserId,
  isStaff,
  isOwner,
}: {
  communityId: string;
  currentUserId: string;
  isStaff: boolean;
  isOwner: boolean;
}) {
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setStatus("loading");
    setLoadError(null);
    try {
      const page = await listMembersClient(communityId, {
        includeRequested: isStaff,
      });
      setMembers(page.members);
      setStatus("ready");
    } catch (caught) {
      setStatus("error");
      setLoadError(
        communityApiErrorMessage(caught, "Members could not be loaded."),
      );
    }
  }, [communityId, isStaff]);

  useEffect(() => {
    let disposed = false;
    // No synchronous setState here (react-hooks/set-state-in-effect): the
    // panel starts in "loading", and only the response moves it.
    listMembersClient(communityId, { includeRequested: isStaff }).then(
      (page) => {
        if (disposed) return;
        setMembers(page.members);
        setStatus("ready");
      },
      (caught: unknown) => {
        if (disposed) return;
        setStatus("error");
        setLoadError(
          communityApiErrorMessage(caught, "Members could not be loaded."),
        );
      },
    );
    return () => {
      disposed = true;
    };
  }, [communityId, isStaff]);

  const act = async (
    userId: string,
    run: () => Promise<unknown>,
    failed: string,
  ) => {
    if (busyId !== null) return;
    setBusyId(userId);
    setActionError(null);
    try {
      await run();
      await load();
    } catch (caught) {
      setActionError(communityApiErrorMessage(caught, failed));
    } finally {
      setBusyId(null);
    }
  };

  const active = members.filter((member) => member.status === "active");
  const requested = members.filter((member) => member.status === "requested");

  const renderRow = (member: MemberRow) => {
    const isSelf = member.user_id === currentUserId;
    const alias = member.alias ?? "Unknown member";
    const controls: Array<{
      key: string;
      label: string;
      run: () => Promise<unknown>;
      failed: string;
      destructive?: boolean;
    }> = [];

    if (isStaff && member.status === "requested") {
      controls.push({
        key: "approve",
        label: "Approve request",
        run: () =>
          setMemberClient(communityId, member.user_id, { status: "active" }),
        failed: "That request could not be approved.",
      });
    }

    if (
      isStaff &&
      member.status === "active" &&
      !isSelf &&
      member.role !== "owner"
    ) {
      controls.push({
        key: "ban",
        label: "Ban member",
        run: () =>
          setMemberClient(communityId, member.user_id, { status: "banned" }),
        failed: "That member could not be banned.",
        destructive: true,
      });
      controls.push({
        key: "remove",
        label: "Remove from community",
        run: () => removeMemberClient(communityId, member.user_id),
        failed: "That member could not be removed.",
        destructive: true,
      });
      if (isOwner) {
        controls.push({
          key: "promote",
          label: "Make moderator",
          run: () =>
            setMemberClient(communityId, member.user_id, {
              role: "moderator",
            }),
          failed: "That member could not be promoted.",
        });
      }
    }

    if (
      isOwner &&
      member.status === "active" &&
      member.role === "moderator" &&
      !isSelf
    ) {
      controls.push({
        key: "demote",
        label: "Remove moderator role",
        run: () =>
          setMemberClient(communityId, member.user_id, { role: "member" }),
        failed: "That moderator role could not be removed.",
      });
    }

    return (
      <li
        key={member.user_id}
        className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2"
      >
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium">{alias}</span>
          {isSelf && <Badge variant="outline">You</Badge>}
          {member.role === "owner" && <Badge>Owner</Badge>}
          {member.role === "moderator" && (
            <Badge variant="secondary">Moderator</Badge>
          )}
          {member.status === "requested" && (
            <Badge variant="outline">Requested</Badge>
          )}
        </span>

        {controls.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 px-2"
                aria-label={`Manage ${alias}`}
                disabled={busyId !== null}
              >
                <MoreHorizontal aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>{alias}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {controls.map((control) => (
                <DropdownMenuItem
                  key={control.key}
                  disabled={busyId !== null}
                  className={control.destructive ? "text-error" : undefined}
                  onSelect={() =>
                    void act(member.user_id, control.run, control.failed)
                  }
                >
                  {control.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </li>
    );
  };

  return (
    <section
      className="flex flex-col gap-4"
      aria-label="Community members"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Members</h2>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="Refresh member list"
          disabled={status === "loading"}
          onClick={() => void load()}
        >
          <RefreshCw aria-hidden="true" />
        </Button>
      </div>

      {status === "loading" && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading members…
        </p>
      )}

      {status === "error" && loadError && (
        <div className="flex flex-col items-start gap-2">
          <p role="alert" className="text-sm text-error">
            {loadError}
          </p>
          <Button type="button" size="sm" variant="outline" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      )}

      {status === "ready" && active.length === 0 && (
        <p className="text-sm text-muted-foreground">No members yet.</p>
      )}

      {active.length > 0 && (
        <ul className="flex flex-col gap-2">{active.map(renderRow)}</ul>
      )}

      {isStaff && requested.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">Join requests</h3>
          <ul className="flex flex-col gap-2">{requested.map(renderRow)}</ul>
        </div>
      )}

      {actionError && (
        <p role="alert" className="text-sm text-error">
          {actionError}
        </p>
      )}
    </section>
  );
}
