"use client";

import { ReportDialog } from "@/components/report-dialog";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useRoomPresence } from "@/lib/chat/presence-store";
import type { RoomMemberView } from "@/lib/invitations/types";
import type { RoomModerationInfo } from "@/lib/moderation/queries";
import { cn } from "@/lib/utils";
import { MoreHorizontal } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

type ActionBody =
  | { method: "POST"; path: string; body?: unknown }
  | { method: "DELETE"; path: string };

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
 *
 * The per-member action menu renders only for members other than the
 * viewer — the row can hide what the API would refuse anyway (self-mute,
 * self-remove), while every action still travels to the moderation API,
 * which re-proves owner/moderator rights inside its RPC. Mute and
 * moderator grants are room-scoped facts from `room_moderation_info`;
 * block state is the viewer's own list. Each action finishes with
 * `router.refresh()` so the roster re-renders from server truth instead of
 * trusting a local guess.
 */
export function RoomRoster({
  roomId,
  members,
  moderation,
  viewerAlias,
  canAppoint,
  blockedAliases,
}: {
  roomId: string;
  members: RoomMemberView[];
  moderation: RoomModerationInfo;
  /** The viewer's own alias — hides self-actions the API would refuse. */
  viewerAlias: string;
  /** The viewer owns this room: moderator appointments are owner-only. */
  canAppoint: boolean;
  /** Aliases the viewer has blocked (their own list, server-read). */
  blockedAliases: string[];
}) {
  const router = useRouter();
  const participants = useRoomPresence(roomId);
  const [busyAlias, setBusyAlias] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<RoomMemberView | null>(null);
  const [reportTarget, setReportTarget] = useState<string | null>(null);

  const lower = (value: string): string => value.toLowerCase();
  const isModerator = (alias: string): boolean =>
    moderation.moderator_aliases.some((entry) => lower(entry) === lower(alias));
  const isMuted = (alias: string): boolean =>
    moderation.muted_aliases.some((entry) => lower(entry) === lower(alias));
  const isBlocked = (alias: string): boolean =>
    blockedAliases.some((entry) => lower(entry) === lower(alias));

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

  const run = async (alias: string, action: ActionBody): Promise<boolean> => {
    setBusyAlias(alias);
    setError(null);
    try {
      const response = await fetch(action.path, {
        method: action.method,
        ...("body" in action && action.body !== undefined
          ? {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(action.body),
            }
          : {}),
      });
      if (response.status === 401) {
        router.push("/auth/login");
        return false;
      }
      const payload = (await response.json().catch(() => null)) as
        | { error?: { message?: string } }
        | null;
      if (!response.ok) {
        throw new Error(
          payload?.error?.message ?? "That action could not be completed.",
        );
      }
      router.refresh();
      return true;
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "That action could not be completed.",
      );
      return false;
    } finally {
      setBusyAlias(null);
    }
  };

  const mutePath = (alias: string): string =>
    `/api/rooms/${roomId}/members/${encodeURIComponent(alias)}/mute`;
  const moderatorPath = (alias: string): string =>
    `/api/rooms/${roomId}/members/${encodeURIComponent(alias)}/moderator`;
  const memberPath = (alias: string): string =>
    `/api/rooms/${roomId}/members/${encodeURIComponent(alias)}`;

  const confirmRemove = async () => {
    if (!removeTarget) return;
    await run(removeTarget.alias, {
      method: "DELETE",
      path: memberPath(removeTarget.alias),
    });
    // The dialog always closes once the server has answered; a refusal is
    // surfaced by the roster's alert, which the modal would otherwise hide.
    setRemoveTarget(null);
  };

  const toggleBlock = async (alias: string) => {
    const blocked = isBlocked(alias);
    await run(alias, blocked
      ? { method: "DELETE", path: `/api/blocks/${encodeURIComponent(alias)}` }
      : { method: "POST", path: "/api/blocks", body: { alias } });
  };

  return (
    <section aria-labelledby={`roster-${roomId}`} className="flex flex-col gap-3">
      <div className="flex items-baseline gap-2">
        <h2 id={`roster-${roomId}`} className="text-lg font-semibold">
          Members
        </h2>
        <span className="text-sm text-muted-foreground">{members.length}</span>
      </div>

      {error && (
        <p role="alert" className="text-sm text-error">
          {error}
        </p>
      )}

      <ul className="flex flex-col gap-2">
        {members.map((member) => {
          const isSelf =
            viewerAlias !== "" &&
            lower(member.alias) === lower(viewerAlias);
          const isOwner = member.role === "owner";
          const moderator = isModerator(member.alias);
          const muted = isMuted(member.alias);
          const blocked = isBlocked(member.alias);
          const menuItems: React.ReactNode[] = [];

          if (!isSelf) {
            menuItems.push(
              <DropdownMenuItem
                key="report"
                onSelect={() => setReportTarget(member.alias)}
              >
                Report member…
              </DropdownMenuItem>,
              <DropdownMenuItem key="block" onSelect={() => void toggleBlock(member.alias)}>
                {blocked ? "Unblock" : "Block"}
              </DropdownMenuItem>,
            );
          }

          if (moderation.can_moderate && !isSelf && !isOwner) {
            menuItems.push(
              <DropdownMenuSeparator key="mod-sep" />,
            );
            if (muted) {
              menuItems.push(
                <DropdownMenuItem
                  key="unmute"
                  disabled={busyAlias === member.alias}
                  onSelect={() =>
                    void run(member.alias, { method: "DELETE", path: mutePath(member.alias) })
                  }
                >
                  Unmute
                </DropdownMenuItem>,
              );
            } else if (!moderator) {
              for (const [duration, label] of [
                ["1h", "Mute for 1 hour"],
                ["24h", "Mute for 24 hours"],
                ["7d", "Mute for 7 days"],
              ] as const) {
                menuItems.push(
                  <DropdownMenuItem
                    key={duration}
                    disabled={busyAlias === member.alias}
                    onSelect={() =>
                      void run(member.alias, {
                        method: "POST",
                        path: mutePath(member.alias),
                        body: { duration },
                      })
                    }
                  >
                    {label}
                  </DropdownMenuItem>,
                );
              }
            }
            if (canAppoint) {
              menuItems.push(
                <DropdownMenuItem
                  key="moderator"
                  disabled={busyAlias === member.alias}
                  onSelect={() =>
                    void run(member.alias, moderator
                      ? { method: "DELETE", path: moderatorPath(member.alias) }
                      : { method: "POST", path: moderatorPath(member.alias) })
                  }
                >
                  {moderator ? "Remove moderator" : "Make moderator"}
                </DropdownMenuItem>,
              );
            }
            menuItems.push(
              <DropdownMenuItem
                key="remove"
                className="text-error focus:text-error"
                onSelect={() => setRemoveTarget(member)}
              >
                Remove from room…
              </DropdownMenuItem>,
            );
          }

          return (
            <li
              key={member.alias.toLowerCase()}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{member.alias}</span>
                {isOwner && <Badge variant="outline">owner</Badge>}
                {moderator && <Badge variant="secondary">moderator</Badge>}
                {muted && <Badge variant="outline">muted</Badge>}
              </div>
              <div className="flex flex-wrap items-center gap-3">
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
                {menuItems.length > 0 && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        aria-label={`Actions for ${member.alias}`}
                        disabled={busyAlias === member.alias}
                      >
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {menuItems}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      <AlertDialog
        open={removeTarget !== null}
        onOpenChange={(next) => {
          if (!next) setRemoveTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove {removeTarget?.alias} from this room?
            </AlertDialogTitle>
            <AlertDialogDescription>
              They lose the seat, the chat and this room&apos;s files
              immediately. You can invite them again later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busyAlias !== null}>
              Keep member
            </AlertDialogCancel>
            <AlertDialogAction
              className={cn(
                "bg-red-600 text-white hover:bg-red-600/90",
              )}
              disabled={busyAlias !== null}
              aria-busy={busyAlias !== null}
              onClick={(event) => {
                // Keep the dialog open until the server confirms; a failed
                // removal must not look like it happened.
                event.preventDefault();
                void confirmRemove();
              }}
            >
              {busyAlias !== null ? "Removing…" : "Remove member"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {reportTarget !== null && (
        <ReportDialog
          open
          onOpenChange={(next) => {
            if (!next) setReportTarget(null);
          }}
          roomId={roomId}
          subject={{ type: "user", alias: reportTarget }}
        />
      )}
    </section>
  );
}
