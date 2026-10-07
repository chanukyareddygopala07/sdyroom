"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { InvitationView } from "@/lib/invitations/types";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

type RespondApiResponse = {
  membership?: "joined" | "already_member";
  room_id?: string;
  error?: { message?: string };
};

function statusBadge(invitation: InvitationView): React.ReactNode {
  if (invitation.status === "pending" && invitation.expired) {
    return <Badge variant="secondary">Expired</Badge>;
  }
  if (invitation.status === "accepted") {
    return <Badge variant="default">Accepted</Badge>;
  }
  if (invitation.status === "rejected") {
    return <Badge variant="secondary">Rejected</Badge>;
  }
  if (invitation.status === "revoked") {
    return <Badge variant="outline">Revoked</Badge>;
  }
  return null;
}

function historyLabel(invitation: InvitationView): string {
  if (invitation.status === "accepted") return "You joined this room.";
  if (invitation.status === "rejected") return "You declined this invitation.";
  if (invitation.status === "revoked") {
    return "The room owner revoked this invitation.";
  }
  if (invitation.expired) return "This invitation expired.";
  return "";
}

/**
 * The invitee's inbox: pending invitations with Accept / Reject, plus the
 * resolved history (nothing is auto-purged). Actions post to the
 * session-only endpoints — the invitation id in the path is the sole
 * argument, and a 404/410 from the server simply updates this row rather
 * than pretending anything succeeded. Accepting lands the student in the
 * workspace the server now knows them as a member of.
 */
export function InvitationsList({
  initialInvitations,
}: {
  initialInvitations: InvitationView[];
}) {
  const router = useRouter();
  const [invitations, setInvitations] =
    useState<InvitationView[]>(initialInvitations);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<
    { id: string; message: string } | null
  >(null);

  const pending = invitations.filter(
    (item) => item.status === "pending" && !item.expired,
  );
  const expired = invitations.filter(
    (item) => item.status === "pending" && item.expired,
  );
  const history = invitations.filter((item) => item.status !== "pending");

  const respond = async (
    invitation: InvitationView,
    action: "accept" | "reject",
  ) => {
    setBusyId(invitation.id);
    setActionError(null);

    try {
      const response = await fetch(
        `/api/invitations/${invitation.id}/${action}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        },
      );

      if (response.status === 401) {
        router.push("/auth/login");
        return;
      }

      const body = (await response.json().catch(() => null)) as
        | RespondApiResponse
        | null;

      if (!response.ok) {
        setActionError({
          id: invitation.id,
          message:
            body?.error?.message ??
            (action === "accept"
              ? "The invitation could not be accepted."
              : "The invitation could not be rejected."),
        });
        // The row may have changed underneath us (revoked, already used):
        // re-read the server's list so the inbox tells the truth.
        router.refresh();
        return;
      }

      if (action === "accept") {
        const roomId = body?.room_id ?? invitation.room_id;
        // Membership now exists server-side; the workspace render is the
        // confirmation. A fresh navigation is also the refresh the inbox
        // needs — this row is spent either way.
        router.push(`/rooms/${roomId}`);
        return;
      }

      setInvitations((current) =>
        current.map((item) =>
          item.id === invitation.id
            ? {
                ...item,
                status: "rejected",
                resolved_at: new Date().toISOString(),
              }
            : item,
        ),
      );
    } catch {
      setActionError({
        id: invitation.id,
        message: "Could not reach the server. Please try again.",
      });
    } finally {
      setBusyId(null);
    }
  };

  const rowActions = (invitation: InvitationView) => (
    <div className="flex items-center gap-2">
      <Button
        type="button"
        size="sm"
        disabled={busyId !== null}
        aria-label={`Accept invitation to ${invitation.room_name}`}
        onClick={() => void respond(invitation, "accept")}
      >
        {busyId === invitation.id ? "Joining..." : "Accept"}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={busyId !== null}
        aria-label={`Reject invitation to ${invitation.room_name}`}
        onClick={() => void respond(invitation, "reject")}
      >
        Reject
      </Button>
    </div>
  );

  const renderPending = (invitation: InvitationView) => (
    <li
      key={invitation.id}
      className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border px-3 py-3"
    >
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{invitation.room_name}</span>
          <Badge variant="outline">private</Badge>
        </div>
        <span className="text-xs text-muted-foreground">
          From {invitation.inviter_alias} · Expires{" "}
          {/* Fixed UTC stamp: server and browser must format the same
              string or hydration mismatches (resource-library's rule). */}
          {invitation.expires_at.slice(0, 16).replace("T", " ")} UTC
        </span>
        {actionError?.id === invitation.id && (
          <span className="text-sm text-red-500" role="alert">
            {actionError.message}
          </span>
        )}
      </div>
      {rowActions(invitation)}
    </li>
  );

  const renderResolved = (invitation: InvitationView) => (
    <li
      key={invitation.id}
      className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border px-3 py-3"
    >
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          {invitation.status === "accepted" ? (
            <Link
              href={`/rooms/${invitation.room_id}`}
              className="text-sm font-medium hover:underline"
            >
              {invitation.room_name}
            </Link>
          ) : (
            <span className="text-sm font-medium">
              {invitation.room_name}
            </span>
          )}
          {statusBadge(invitation)}
        </div>
        <span className="text-xs text-muted-foreground">
          From {invitation.inviter_alias} · {historyLabel(invitation)}
        </span>
      </div>
    </li>
  );

  if (invitations.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No invitations yet — when a room owner invites you by alias, it
        appears here.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="pending-heading" className="flex flex-col gap-3">
        <h2 id="pending-heading" className="text-lg font-semibold">
          Pending
        </h2>
        {pending.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing waiting for you.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">{pending.map(renderPending)}</ul>
        )}
      </section>

      {expired.length > 0 && (
        <section aria-labelledby="expired-heading" className="flex flex-col gap-3">
          <h2 id="expired-heading" className="text-lg font-semibold">
            Expired
          </h2>
          <ul className="flex flex-col gap-2">{expired.map(renderResolved)}</ul>
        </section>
      )}

      {history.length > 0 && (
        <section aria-labelledby="history-heading" className="flex flex-col gap-3">
          <h2 id="history-heading" className="text-lg font-semibold">
            History
          </h2>
          <ul className="flex flex-col gap-2">{history.map(renderResolved)}</ul>
        </section>
      )}
    </div>
  );
}
