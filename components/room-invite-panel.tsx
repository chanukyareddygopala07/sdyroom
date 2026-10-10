"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { InvitationView } from "@/lib/invitations/types";
import { INVITEE_ALIAS_MAX } from "@/lib/validation/invitations";
import { useRouter } from "next/navigation";
import { useState } from "react";

type InviteApiResponse = {
  invitation?: InvitationView;
  error?: { code?: string; message?: string };
};

/**
 * Client-side reading of the API's failure vocabulary for the one field on
 * this form. The server already returns a human message per code; these are
 * the aliases' phrasing so the panel reads like an invitation, not an error
 * dump — and any unmapped code falls back to the server's own message.
 */
function friendlyCreateError(code: string | undefined, fallback: string): string {
  switch (code) {
    case "invitee_not_found":
      return "No student studies under that alias.";
    case "already_invited":
      return "That student already has a pending invitation for this room.";
    case "already_member":
      return "That student is already in this room.";
    case "self_invite":
      return "You cannot invite yourself.";
    case "room_public":
      return "Invitations are for private rooms — anyone can join a public room.";
    case "not_owner":
      return "Only the room owner can invite.";
    case "validation":
      return "Check the alias and try again.";
    default:
      return fallback;
  }
}

/**
 * Owner-facing invite control for one private room.
 *
 * The invite field is the invitee's SdyRoom alias — addressed invitations
 * (007) have no email, no phone, and no shareable link, so this form is the
 * entire product surface of "who can get in". Mounted by the workspace page
 * only when the viewer owns a private room; every response status still
 * comes from the API, which re-proves owner and privacy itself. The pending
 * list is the owner's own rows, server-read, with per-row revoke.
 */
export function RoomInvitePanel({
  roomId,
  initialPending,
}: {
  roomId: string;
  initialPending: InvitationView[];
}) {
  const router = useRouter();
  const [alias, setAlias] = useState("");
  const [pending, setPending] = useState<InvitationView[]>(initialPending);
  const [busy, setBusy] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const invite = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const invitee = alias.trim();
    if (invitee === "") {
      setError("Enter the student's study alias.");
      setSuccess(null);
      return;
    }

    setBusy(true);
    setError(null);
    setSuccess(null);

    try {
      const response = await fetch(`/api/rooms/${roomId}/invitations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invitee_alias: invitee }),
      });

      if (response.status === 401) {
        router.push("/auth/login");
        return;
      }

      const body = (await response.json().catch(() => null)) as
        | InviteApiResponse
        | null;

      if (response.status !== 201 || !body?.invitation) {
        setError(
          friendlyCreateError(
            body?.error?.code,
            body?.error?.message ??
              "The invitation could not be created. Please try again.",
          ),
        );
        return;
      }

      setSuccess(`Invitation sent to ${body.invitation.invitee_alias}.`);
      setAlias("");
      setPending((current) => [body.invitation as InvitationView, ...current]);
    } catch {
      setError("Could not reach the server. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (invitationId: string) => {
    setRevokingId(invitationId);
    setError(null);
    setSuccess(null);

    try {
      const response = await fetch(
        `/api/rooms/${roomId}/invitations/${invitationId}`,
        { method: "DELETE" },
      );

      if (response.status === 401) {
        router.push("/auth/login");
        return;
      }

      const body = (await response.json().catch(() => null)) as
        | { error?: { message?: string } }
        | null;

      if (!response.ok) {
        setError(
          body?.error?.message ??
            "The invitation could not be revoked. Please try again.",
        );
        // The row may already be resolved (accepted, expired-then-revoked):
        // re-read the server's list so the panel stops telling a stale story.
        router.refresh();
        return;
      }

      setPending((current) =>
        current.filter((item) => item.id !== invitationId),
      );
    } catch {
      setError("Could not reach the server. Please try again.");
    } finally {
      setRevokingId(null);
    }
  };

  return (
    <section
      aria-labelledby={`invite-${roomId}`}
      className="flex flex-col gap-3"
    >
      <h2 id={`invite-${roomId}`} className="text-lg font-semibold">
        Invite a student
      </h2>
      <p className="text-sm text-muted-foreground">
        Invite by study alias. They accept from their Invitations page — there
        is no link to forward and no email to leak.
      </p>

      <form onSubmit={invite} className="flex flex-wrap items-center gap-2">
        <label htmlFor={`invite-alias-${roomId}`} className="sr-only">
          Student&apos;s study alias
        </label>
        <Input
          id={`invite-alias-${roomId}`}
          name="invitee_alias"
          value={alias}
          onChange={(event) => setAlias(event.target.value)}
          placeholder="Study alias"
          autoComplete="off"
          maxLength={INVITEE_ALIAS_MAX}
          className="w-56"
          disabled={busy}
        />
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? "Sending..." : "Send invitation"}
        </Button>
      </form>

      {success && (
        <p className="text-sm text-foreground" role="status">
          {success}
        </p>
      )}
      {error && (
        <p className="text-sm text-red-500" role="alert">
          {error}
        </p>
      )}

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Pending invitations</h3>
        {pending.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No pending invitations.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {pending.map((invitation) => (
              <li
                key={invitation.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2"
              >
                <div className="flex flex-col">
                  <span className="text-sm font-medium">
                    {invitation.invitee_alias}
                  </span>
                  <time
                    className="text-xs text-muted-foreground"
                    dateTime={invitation.expires_at}
                  >
                    {/* Fixed UTC stamp: server and browser must format the
                        same string or hydration mismatches (resource-library's
                        rule). */}
                    Expires {invitation.expires_at.slice(0, 16).replace("T", " ")} UTC
                  </time>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={revokingId !== null}
                  aria-label={`Revoke invitation for ${invitation.invitee_alias}`}
                  onClick={() => void revoke(invitation.id)}
                >
                  {revokingId === invitation.id ? "Revoking..." : "Revoke"}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
