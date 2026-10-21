"use client";

import {
  COMMUNITY_CATEGORIES,
  CATEGORY_LABELS,
  communityApiErrorMessage,
} from "@/components/communities/_shared";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  deleteCommunityClient,
  leaveCommunityClient,
  updateCommunityClient,
} from "@/lib/communities/api";
import { removeCommunityLocalState } from "@/lib/crypto/mls";
import type { CommunityRow } from "@/lib/communities/types";
import { useRouter } from "next/navigation";
import { useState } from "react";

const NAME_MAX = 60;
const DESCRIPTION_MAX = 1000;
const RULES_MAX = 2000;

type Membership = { role: string; status: string };

type Draft = {
  name: string;
  description: string;
  category: string;
  visibility: "public" | "private";
  joinPolicy: "open" | "request";
  rules: string;
};

function draftFrom(community: CommunityRow): Draft {
  return {
    name: community.name,
    description: community.description,
    category: community.category,
    visibility: community.visibility,
    joinPolicy: community.join_policy,
    rules: community.rules,
  };
}

/**
 * Community settings. Staff edit the public surface (name, description,
 * category, visibility, join policy, rules); the owner alone gets the danger
 * zone that deletes the community. Everyone else sees the same facts
 * read-only plus the leave flow — nobody is ever trapped in a community.
 */
export function CommunitySettingsDialog({
  community,
  membership,
  open,
  onOpenChange,
  onUpdated,
}: {
  community: CommunityRow;
  membership: Membership;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpdated: (community: CommunityRow) => void;
}) {
  const router = useRouter();
  const isStaff =
    membership.role === "owner" || membership.role === "moderator";
  const isOwner = membership.role === "owner";

  const [draft, setDraft] = useState<Draft>(() => draftFrom(community));
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;

    const name = draft.name.trim();
    if (name.length < 3) {
      setFieldError("Community name must be at least 3 characters.");
      return;
    }

    setSaving(true);
    setFormError(null);
    setFieldError(null);
    setNotice(null);
    try {
      const { community: updated } = await updateCommunityClient(community.id, {
        name,
        description: draft.description.trim(),
        category: draft.category,
        visibility: draft.visibility,
        joinPolicy:
          draft.visibility === "private" ? "request" : draft.joinPolicy,
        rules: draft.rules.trim(),
      });
      onUpdated(updated);
      setNotice("Settings saved.");
    } catch (caught) {
      setFormError(
        communityApiErrorMessage(caught, "Settings could not be saved."),
      );
    } finally {
      setSaving(false);
    }
  };

  const handleLeave = async () => {
    if (leaving) return;
    setLeaving(true);
    setLeaveError(null);
    try {
      await leaveCommunityClient(community.id);
      // Server-side access is already revoked; clear this device's local
      // keys and sent-message plaintext for the community. Best-effort: a
      // failure can only leave stale local data, never restore access.
      await removeCommunityLocalState(community.id).catch(() => undefined);
      router.push("/communities");
      router.refresh();
    } catch (caught) {
      setLeaving(false);
      setLeaveError(
        communityApiErrorMessage(caught, "You could not leave right now."),
      );
    }
  };

  const handleDelete = async () => {
    if (deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteCommunityClient(community.id);
      // Same teardown as leaving: the community (and its ciphertext) no
      // longer exist server-side, so this device drops its local copies.
      await removeCommunityLocalState(community.id).catch(() => undefined);
      router.push("/communities");
      router.refresh();
    } catch (caught) {
      setDeleting(false);
      setDeleteError(
        communityApiErrorMessage(
          caught,
          "The community could not be deleted.",
        ),
      );
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Community settings</DialogTitle>
          <DialogDescription>
            {isStaff
              ? "These details are visible to everyone who can find this community."
              : "How this community works, and how to leave it."}
          </DialogDescription>
        </DialogHeader>

        {!isStaff ? (
          <div className="flex flex-col gap-4">
            <dl className="flex flex-col gap-2 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <dt className="font-medium">Name:</dt>
                <dd>{community.name}</dd>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <dt className="font-medium">Category:</dt>
                <dd>
                  <Badge variant="outline">
                    {CATEGORY_LABELS[
                      community.category as keyof typeof CATEGORY_LABELS
                    ] ?? community.category}
                  </Badge>
                </dd>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <dt className="font-medium">Visibility:</dt>
                <dd className="capitalize">{community.visibility}</dd>
              </div>
              {community.description && (
                <div className="flex flex-col gap-1">
                  <dt className="font-medium">Description</dt>
                  <dd className="whitespace-pre-wrap text-muted-foreground">
                    {community.description}
                  </dd>
                </div>
              )}
              <div className="flex flex-col gap-1">
                <dt className="font-medium">Rules</dt>
                <dd className="whitespace-pre-wrap text-muted-foreground">
                  {community.rules || "No rules yet."}
                </dd>
              </div>
            </dl>

            <div className="flex flex-col gap-2 border-t pt-4">
              <h3 className="text-sm font-semibold">Leave this community</h3>
              <p className="text-sm text-muted-foreground">
                You lose access to every channel immediately. You can rejoin
                an open community later.
              </p>
              {leaveError && (
                <p role="alert" className="text-sm text-error">
                  {leaveError}
                </p>
              )}
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button type="button" variant="outline" className="self-start">
                    Leave community
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      Leave {community.name}?
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      You will lose access to every channel in this
                      community. You can rejoin later if it stays open.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Stay</AlertDialogCancel>
                    <AlertDialogAction
                      disabled={leaving}
                      aria-busy={leaving}
                      onClick={(event) => {
                        event.preventDefault();
                        void handleLeave();
                      }}
                    >
                      {leaving ? "Leaving…" : "Leave community"}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col gap-5">
            <div className="grid gap-2">
              <Label htmlFor="community-settings-name">Name</Label>
              <Input
                id="community-settings-name"
                value={draft.name}
                maxLength={NAME_MAX}
                required
                onChange={(event) =>
                  setDraft({ ...draft, name: event.target.value })
                }
                aria-invalid={fieldError ? true : undefined}
                aria-describedby={
                  fieldError ? "community-settings-name-error" : undefined
                }
              />
              {fieldError && (
                <p
                  id="community-settings-name-error"
                  role="alert"
                  className="text-sm text-error"
                >
                  {fieldError}
                </p>
              )}
            </div>

            <div className="grid gap-2">
              <Label htmlFor="community-settings-description">
                Description
              </Label>
              <Textarea
                id="community-settings-description"
                value={draft.description}
                maxLength={DESCRIPTION_MAX}
                className="min-h-20"
                onChange={(event) =>
                  setDraft({ ...draft, description: event.target.value })
                }
              />
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="community-settings-category">Category</Label>
                <Select
                  id="community-settings-category"
                  value={draft.category}
                  onChange={(event) =>
                    setDraft({ ...draft, category: event.target.value })
                  }
                >
                  {COMMUNITY_CATEGORIES.map((category) => (
                    <option key={category} value={category}>
                      {CATEGORY_LABELS[category]}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="community-settings-join-policy">
                  Join policy
                </Label>
                <Select
                  id="community-settings-join-policy"
                  value={
                    draft.visibility === "private" ? "request" : draft.joinPolicy
                  }
                  disabled={draft.visibility === "private"}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      joinPolicy: event.target.value as Draft["joinPolicy"],
                    })
                  }
                >
                  <option value="open">Open — anyone can join</option>
                  <option value="request">Request — staff approve</option>
                </Select>
                {draft.visibility === "private" && (
                  <p className="text-xs text-muted-foreground">
                    Private communities only accept request-based joining.
                  </p>
                )}
              </div>
            </div>

            <fieldset className="flex flex-col gap-2">
              <legend className="text-sm font-medium">Visibility</legend>
              <RadioGroup
                value={draft.visibility}
                onValueChange={(value) =>
                  setDraft({ ...draft, visibility: value as Draft["visibility"] })
                }
                name="community-settings-visibility"
                aria-label="Visibility"
              >
                <Label
                  htmlFor="community-settings-visibility-public"
                  className="flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-2 text-sm font-normal"
                >
                  <RadioGroupItem
                    id="community-settings-visibility-public"
                    value="public"
                  />
                  Public — listed in discovery
                </Label>
                <Label
                  htmlFor="community-settings-visibility-private"
                  className="flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-2 text-sm font-normal"
                >
                  <RadioGroupItem
                    id="community-settings-visibility-private"
                    value="private"
                  />
                  Private — unlisted, join by request
                </Label>
              </RadioGroup>
            </fieldset>

            <div className="grid gap-2">
              <Label htmlFor="community-settings-rules">Rules</Label>
              <Textarea
                id="community-settings-rules"
                value={draft.rules}
                maxLength={RULES_MAX}
                className="min-h-24"
                placeholder="Be kind. Study hard. No spoilers."
                onChange={(event) =>
                  setDraft({ ...draft, rules: event.target.value })
                }
              />
            </div>

            {formError && (
              <p role="alert" className="text-sm text-error">
                {formError}
              </p>
            )}
            {notice && (
              <p role="status" className="text-sm text-muted-foreground">
                {notice}
              </p>
            )}

            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                disabled={saving}
                onClick={() => onOpenChange(false)}
              >
                Close
              </Button>
              <Button type="submit" disabled={saving} aria-busy={saving}>
                {saving ? "Saving…" : "Save changes"}
              </Button>
            </DialogFooter>

            {isOwner && (
              <div className="flex flex-col gap-2 border-t border-destructive/40 pt-4">
                <h3 className="text-sm font-semibold text-destructive">
                  Danger zone
                </h3>
                <p className="text-sm text-muted-foreground">
                  Deleting the community removes every channel, message and
                  membership row. This cannot be undone.
                </p>
                {deleteError && (
                  <p role="alert" className="text-sm text-error">
                    {deleteError}
                  </p>
                )}
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button type="button" variant="destructive" className="self-start">
                      Delete community
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>
                        Delete {community.name}?
                      </AlertDialogTitle>
                      <AlertDialogDescription>
                        Every channel, message and membership row is removed.
                        This cannot be undone.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        disabled={deleting}
                        aria-busy={deleting}
                        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        onClick={(event) => {
                          event.preventDefault();
                          void handleDelete();
                        }}
                      >
                        {deleting ? "Deleting…" : "Delete community"}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            )}
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
