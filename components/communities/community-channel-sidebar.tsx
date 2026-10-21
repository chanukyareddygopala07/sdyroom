"use client";

import { communityApiErrorMessage, suggestSlug } from "@/components/communities/_shared";
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
import { Textarea } from "@/components/ui/textarea";
import { createChannelClient } from "@/lib/communities/api";
import type { CommunityChannelRow } from "@/lib/communities/types";
import { Hash, Plus } from "lucide-react";
import { useState } from "react";

const CHANNEL_NAME_MAX = 40;
const CHANNEL_DESCRIPTION_MAX = 200;

function CreateChannelDialog({
  communityId,
  open,
  onOpenChange,
  onCreated,
}: {
  communityId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (channel: CommunityChannelRow) => void;
}) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setName("");
    setSlug("");
    setSlugTouched(false);
    setDescription("");
    setError(null);
    setSaving(false);
  };

  const handleChange = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const { channel } = await createChannelClient(communityId, {
        name: name.trim(),
        slug: slug.trim(),
        description: description.trim(),
      });
      onCreated(channel);
      handleChange(false);
    } catch (caught) {
      setSaving(false);
      setError(
        communityApiErrorMessage(caught, "The channel could not be created."),
      );
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New channel</DialogTitle>
          <DialogDescription>
            Channels get their own encrypted group. The first member to open
            the channel sets it up automatically.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="grid gap-2">
            <Label htmlFor="community-channel-name">Channel name</Label>
            <Input
              id="community-channel-name"
              value={name}
              required
              maxLength={CHANNEL_NAME_MAX}
              placeholder="Homework help"
              onChange={(event) => {
                const next = event.target.value;
                setName(next);
                if (!slugTouched) setSlug(suggestSlug(next));
              }}
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="community-channel-slug">Slug</Label>
            <Input
              id="community-channel-slug"
              value={slug}
              required
              maxLength={CHANNEL_NAME_MAX}
              placeholder="homework-help"
              onChange={(event) => {
                setSlugTouched(true);
                setSlug(event.target.value);
              }}
            />
            <p className="text-xs text-muted-foreground">
              Lowercase letters, numbers and hyphens. The URL segment for this
              channel.
            </p>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="community-channel-description">
              Description (optional)
            </Label>
            <Textarea
              id="community-channel-description"
              value={description}
              maxLength={CHANNEL_DESCRIPTION_MAX}
              className="min-h-16"
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>

          {error && (
            <p role="alert" className="text-sm text-error">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={saving}
              onClick={() => handleChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={saving || name.trim() === "" || slug.trim() === ""}
              aria-busy={saving}
            >
              {saving ? "Creating…" : "Create channel"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The channel rail: the community's channels with the active one marked.
 * Staff get the "+" that opens the create dialog; the created channel is
 * handed straight back so the workspace can select it without a refetch.
 */
export function CommunityChannelSidebar({
  communityId,
  channels,
  activeChannelId,
  isStaff,
  loading = false,
  error = null,
  onSelect,
  onCreated,
  onRetry,
}: {
  communityId: string;
  channels: CommunityChannelRow[];
  activeChannelId: string | null;
  isStaff: boolean;
  loading?: boolean;
  error?: string | null;
  onSelect: (channelId: string) => void;
  onCreated: (channel: CommunityChannelRow) => void;
  onRetry?: () => void;
}) {
  const [creating, setCreating] = useState(false);

  return (
    <nav
      aria-label="Channels"
      className="flex flex-col gap-2 rounded-xl border p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Channels</h2>
        {isStaff && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 px-2"
            aria-label="Create a channel"
            onClick={() => setCreating(true)}
          >
            <Plus aria-hidden="true" />
          </Button>
        )}
      </div>

      {loading && (
        <p role="status" className="text-xs text-muted-foreground">
          Loading channels…
        </p>
      )}

      {error && (
        <div className="flex flex-col items-start gap-1">
          <p role="alert" className="text-xs text-error">
            {error}
          </p>
          {onRetry && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={onRetry}
            >
              Try again
            </Button>
          )}
        </div>
      )}

      {!loading && !error && channels.length === 0 && (
        <p className="text-xs text-muted-foreground">No channels yet.</p>
      )}

      <ul className="flex flex-col gap-1">
        {channels.map((channel) => {
          const active = channel.id === activeChannelId;
          return (
            <li key={channel.id}>
              <Button
                type="button"
                variant={active ? "secondary" : "ghost"}
                size="sm"
                className="w-full justify-start gap-2"
                aria-current={active ? "true" : undefined}
                onClick={() => onSelect(channel.id)}
              >
                <Hash aria-hidden="true" className="size-4" />
                <span className="truncate">{channel.name}</span>
              </Button>
            </li>
          );
        })}
      </ul>

      <CreateChannelDialog
        communityId={communityId}
        open={creating}
        onOpenChange={setCreating}
        onCreated={onCreated}
      />
    </nav>
  );
}
