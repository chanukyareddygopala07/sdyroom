"use client";

import {
  REACTION_EMOJIS,
  communityApiErrorMessage,
  cssUrl,
  formatMessageTime,
  stickerSvgElement,
  useStickers,
} from "@/components/communities/_shared";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import type { WorkspaceMessage } from "@/hooks/use-community-workspace";
import {
  downloadAttachmentClient,
  reportClient,
} from "@/lib/communities/api";
import type {
  CommunityAttachmentMeta,
  CommunityPayload,
} from "@/lib/communities/payload";
import { decryptAttachment } from "@/lib/crypto/attachment";
import { formatBytes } from "@/lib/resources/files";
import { Download, FileText, MoreHorizontal, Reply, SmilePlus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

/** Reasons community reports reuse from room moderation (free text on the wire). */
const REPORT_REASONS = [
  "spam",
  "harassment",
  "abusive_content",
  "inappropriate_content",
  "impersonation",
  "other",
] as const;

const REASON_LABELS: Record<(typeof REPORT_REASONS)[number], string> = {
  spam: "Spam",
  harassment: "Harassment",
  abusive_content: "Abusive content",
  inappropriate_content: "Inappropriate content",
  impersonation: "Impersonation",
  other: "Something else",
};

const REASON_MAX = 500;
const EXCERPT_MAX = 2000;

/** One aggregated emoji shown under a message. */
type ReactionChip = {
  emoji: string;
  count: number;
  /** The viewer's own live reaction on this emoji. */
  mine: boolean;
};

function aliasFor(
  aliases: Record<string, string>,
  message: WorkspaceMessage,
): string {
  return (
    aliases[message.senderId] ?? (message.isOwn ? "You" : "Unknown member")
  );
}

function snippetOf(message: WorkspaceMessage | undefined): string {
  if (!message || message.undecryptable || !message.payload) {
    return "Original message unavailable";
  }
  const payload: CommunityPayload = message.payload;
  switch (payload.t) {
    case "text":
      return payload.body;
    case "sticker":
      return `Sticker: ${payload.alt}`;
    case "gif":
      return "GIF";
    case "file":
      return payload.attachment.name;
    default:
      return "Original message unavailable";
  }
}

/**
 * TS 5.7+ types Uint8Array's buffer generically; `Blob` wants a plain
 * ArrayBuffer-backed view. All our decrypted views are plain ArrayBuffers
 * at runtime (same cast as lib/crypto/attachment.ts).
 */
function blobPart(bytes: Uint8Array): BlobPart {
  return bytes as unknown as BlobPart;
}

/**
 * Download one attachment's ciphertext, decrypt it with the key and IV that
 * rode inside the message payload, and hand back an object URL. The
 * plaintext only ever exists in this browser.
 */
function decryptAttachmentUrl(
  communityId: string,
  attachment: CommunityAttachmentMeta,
): Promise<string> {
  return downloadAttachmentClient(communityId, attachment.attachmentId).then(
    async (bytes) => {
      const plaintext = await decryptAttachment(
        bytes,
        attachment.keyB64,
        attachment.ivB64,
      );
      return URL.createObjectURL(
        new Blob([blobPart(plaintext)], {
          type: attachment.mime || "application/octet-stream",
        }),
      );
    },
  );
}

function CommunityGifAttachment({
  communityId,
  attachment,
}: {
  communityId: string;
  attachment: CommunityAttachmentMeta;
}) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const urlRef = useRef<string | null>(null);

  // Revoke the plaintext URL when the row goes away.
  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );

  const load = () => {
    setStatus("loading");
    void decryptAttachmentUrl(communityId, attachment)
      .then((url) => {
        urlRef.current = url;
        setObjectUrl(url);
      })
      .catch(() => {
        setStatus("error");
      });
  };

  if (objectUrl) {
    return (
      <div
        role="img"
        aria-label="GIF"
        className="h-48 w-64 max-w-full rounded-md bg-cover bg-center"
        style={{ backgroundImage: cssUrl(objectUrl) }}
      />
    );
  }

  return (
    <div className="flex max-w-64 flex-col gap-1 rounded-md border border-dashed p-3">
      <span className="flex items-center gap-2 text-sm font-medium">
        <FileText aria-hidden="true" className="size-4" />
        {attachment.name || "GIF"}
      </span>
      <span className="text-xs text-muted-foreground">
        {formatBytes(attachment.size)}
      </span>
      {status === "error" ? (
        <span role="alert" className="text-xs text-error">
          That GIF could not be opened. Try again.
        </span>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="self-start"
          disabled={status === "loading"}
          aria-busy={status === "loading"}
          onClick={load}
        >
          {status === "loading" ? "Decrypting…" : "Load GIF"}
        </Button>
      )}
    </div>
  );
}

function CommunityFileAttachment({
  communityId,
  attachment,
}: {
  communityId: string;
  attachment: CommunityAttachmentMeta;
}) {
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");

  const download = () => {
    setStatus("loading");
    void decryptAttachmentUrl(communityId, attachment)
      .then((url) => {
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = attachment.name || "download";
        anchor.click();
        // The anchor has consumed the URL; drop the plaintext soon after.
        window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
        setStatus("idle");
      })
      .catch(() => {
        setStatus("error");
      });
  };

  return (
    <div className="flex max-w-64 flex-col gap-1 rounded-md border p-3">
      <span className="flex items-center gap-2 text-sm font-medium">
        <FileText aria-hidden="true" className="size-4" />
        {attachment.name || "File"}
      </span>
      <span className="text-xs text-muted-foreground">
        {formatBytes(attachment.size)}
      </span>
      {status === "error" && (
        <span role="alert" className="text-xs text-error">
          That file could not be opened. Try again.
        </span>
      )}
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="self-start"
        disabled={status === "loading"}
        aria-busy={status === "loading"}
        onClick={download}
      >
        <Download aria-hidden="true" />
        {status === "loading" ? "Decrypting…" : "Download"}
      </Button>
    </div>
  );
}

/** The per-message report dialog; community staff see the excerpt. */
function CommunityReportDialog({
  communityId,
  message,
  onOpenChange,
}: {
  communityId: string;
  message: WorkspaceMessage;
  onOpenChange: (open: boolean) => void;
}) {
  const [reason, setReason] = useState<string>("");
  const [detail, setDetail] = useState("");
  const [includeText, setIncludeText] = useState(true);
  const [status, setStatus] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);

  const textBody = message.payload?.t === "text" ? message.payload.body : null;

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (status !== "idle" || reason === "") return;
    setStatus("sending");
    setError(null);

    const detailTrimmed = detail.trim();
    const reasonText = (
      detailTrimmed ? `${reason}: ${detailTrimmed}` : reason
    ).slice(0, REASON_MAX);
    const excerpt =
      includeText && textBody !== null ? textBody.slice(0, EXCERPT_MAX) : null;

    try {
      await reportClient(communityId, {
        targetType: "message",
        targetId: message.id,
        reason: reasonText,
        contextExcerpt: excerpt,
      });
      setStatus("sent");
    } catch (caught) {
      setStatus("idle");
      setError(
        communityApiErrorMessage(caught, "The report could not be filed."),
      );
    }
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Report this message</DialogTitle>
          <DialogDescription>
            Community staff review reports privately. The person you report
            never sees who filed it.
          </DialogDescription>
        </DialogHeader>

        {status === "sent" ? (
          <div className="flex flex-col gap-3" role="status">
            <p className="text-sm">
              Thanks — your report was sent to this community&apos;s staff.
            </p>
            <DialogFooter>
              <Button type="button" onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <fieldset className="flex flex-col gap-2">
              <legend className="text-sm font-medium">Reason</legend>
              <RadioGroup
                value={reason}
                onValueChange={setReason}
                name="community-report-reason"
                aria-label="Reason"
                required
              >
                {REPORT_REASONS.map((value) => (
                  <Label
                    key={value}
                    htmlFor={`community-report-reason-${value}`}
                    className="flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-2 text-sm font-normal"
                  >
                    <RadioGroupItem
                      id={`community-report-reason-${value}`}
                      value={value}
                    />
                    {REASON_LABELS[value]}
                  </Label>
                ))}
              </RadioGroup>
            </fieldset>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="community-report-detail">Detail (optional)</Label>
              <Textarea
                id="community-report-detail"
                value={detail}
                onChange={(event) => setDetail(event.target.value)}
                placeholder="Anything staff should know"
                maxLength={REASON_MAX}
                className="min-h-16"
              />
            </div>

            {textBody !== null && (
              <div className="flex items-start gap-2 rounded-md border border-border p-3">
                <Checkbox
                  id="community-report-include-text"
                  checked={includeText}
                  onCheckedChange={(checked) => setIncludeText(checked === true)}
                />
                <div className="flex flex-col gap-1">
                  <Label
                    htmlFor="community-report-include-text"
                    className="font-normal"
                  >
                    Include the message text
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Messages are end-to-end encrypted, so staff can only see
                    the text if you attach it to the report.
                  </p>
                </div>
              </div>
            )}

            {error && (
              <p role="alert" className="text-sm text-error">
                {error}
              </p>
            )}

            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                disabled={status === "sending"}
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={reason === "" || status === "sending"}
                aria-busy={status === "sending"}
              >
                {status === "sending" ? "Sending…" : "Send report"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function AddReactionButton({
  disabled,
  onPick,
}: {
  disabled: boolean;
  onPick: (emoji: string) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs text-muted-foreground"
          aria-label="Add a reaction"
          disabled={disabled}
        >
          <SmilePlus aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <div className="grid grid-cols-4 gap-1 p-1">
          {REACTION_EMOJIS.map((emoji) => (
            <DropdownMenuItem
              key={emoji}
              onSelect={() => onPick(emoji)}
              className="justify-center text-lg"
              aria-label={`React with ${emoji}`}
            >
              <span aria-hidden="true">{emoji}</span>
            </DropdownMenuItem>
          ))}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The channel's message history. Reaction rows are aggregated client-side
 * into per-message emoji chips (a reaction row itself never renders as a
 * bubble), a row this device cannot decrypt says so out loud, and GIFs and
 * files are only decrypted when the reader asks for them.
 */
export function CommunityMessageList({
  communityId,
  messages,
  hasMore,
  loading,
  currentUserId,
  aliases,
  onLoadOlder,
  onToggleReaction,
}: {
  communityId: string;
  messages: WorkspaceMessage[];
  hasMore: boolean;
  loading: boolean;
  currentUserId: string;
  /** user_id → display alias, from the member roster. */
  aliases: Record<string, string>;
  onLoadOlder: () => void;
  onToggleReaction: (targetId: string, emoji: string, removed: boolean) => void;
}) {
  const stickers = useStickers();
  const [reportTarget, setReportTarget] = useState<WorkspaceMessage | null>(
    null,
  );

  const { bubbles, reactionChips, byId } = useMemo(() => {
    const byMessageId = new Map<string, WorkspaceMessage>();
    const perTarget = new Map<
      string,
      Map<string, Map<string, { removed: boolean; seq: number }>>
    >();
    const bubbleRows: WorkspaceMessage[] = [];

    for (const message of messages) {
      const payload = message.payload;
      if (message.undecryptable) {
        byMessageId.set(message.id, message);
        bubbleRows.push(message);
        continue;
      }
      if (!payload) {
        // MLS commit rows carry no user content.
        continue;
      }
      byMessageId.set(message.id, message);
      if (payload.t === "reaction") {
        let perEmoji = perTarget.get(payload.targetId);
        if (!perEmoji) {
          perEmoji = new Map();
          perTarget.set(payload.targetId, perEmoji);
        }
        let perSender = perEmoji.get(payload.emoji);
        if (!perSender) {
          perSender = new Map();
          perEmoji.set(payload.emoji, perSender);
        }
        const previous = perSender.get(message.senderId);
        if (!previous || message.seq >= previous.seq) {
          perSender.set(message.senderId, {
            removed: payload.removed === true,
            seq: message.seq,
          });
        }
        continue;
      }
      bubbleRows.push(message);
    }

    const chips = new Map<string, ReactionChip[]>();
    for (const [targetId, perEmoji] of perTarget) {
      const list: ReactionChip[] = [];
      for (const [emoji, perSender] of perEmoji) {
        let count = 0;
        let mine = false;
        for (const [senderId, state] of perSender) {
          if (state.removed) continue;
          count += 1;
          if (senderId === currentUserId) mine = true;
        }
        if (count > 0) list.push({ emoji, count, mine });
      }
      if (list.length > 0) chips.set(targetId, list);
    }

    return { bubbles: bubbleRows, reactionChips: chips, byId: byMessageId };
  }, [messages, currentUserId]);

  return (
    <section
      className="flex flex-col gap-4 rounded-xl border p-5"
      aria-label="Channel messages"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Messages</h2>
        {hasMore && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onLoadOlder}
            disabled={loading}
          >
            Load older
          </Button>
        )}
      </div>

      {loading && messages.length === 0 ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading messages…
        </p>
      ) : bubbles.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No messages yet. Say hello to your study partners.
        </p>
      ) : (
        <ul aria-label="Messages" className="flex flex-col gap-2">
          {bubbles.map((message) => {
            const payload = message.payload;
            const time = formatMessageTime(message.createdAt);
            const chips = reactionChips.get(message.id) ?? [];
            const replyId =
              payload && "replyTo" in payload ? payload.replyTo : undefined;
            const replySource = replyId ? byId.get(replyId) : undefined;

            let stickerFallback: string | null = null;
            if (payload?.t === "sticker") {
              const entry =
                stickers?.pack === payload.pack
                  ? stickers.stickers.find(
                      (sticker) => sticker.id === payload.id,
                    )
                  : undefined;
              stickerFallback = entry ? null : payload.alt;
            }

            return (
              <li
                key={message.id}
                className={
                  message.isOwn
                    ? "flex max-w-[85%] flex-col gap-1 self-end rounded-lg border bg-accent/60 p-3"
                    : "flex max-w-[85%] flex-col gap-1 self-start rounded-lg border p-3"
                }
              >
                <span className="flex flex-wrap items-baseline gap-2">
                  <span className="text-sm font-medium">
                    {aliasFor(aliases, message)}
                  </span>
                  {time && (
                    <time
                      dateTime={message.createdAt}
                      className="text-xs text-muted-foreground"
                    >
                      {time}
                    </time>
                  )}
                </span>

                {replyId !== undefined && (
                  <span className="flex items-center gap-1.5 border-l-2 pl-2 text-xs text-muted-foreground">
                    <Reply aria-hidden="true" className="size-3 shrink-0" />
                    <span className="line-clamp-2 break-words">
                      {snippetOf(replySource)}
                    </span>
                  </span>
                )}

                {message.undecryptable || !payload ? (
                  <span className="text-sm text-muted-foreground italic">
                    This message can&apos;t be decrypted on this device yet.
                  </span>
                ) : payload.t === "text" ? (
                  <span className="whitespace-pre-wrap break-words text-sm">
                    {payload.body}
                  </span>
                ) : payload.t === "sticker" ? (
                  (() => {
                    const entry =
                      stickers?.pack === payload.pack
                        ? stickers.stickers.find(
                            (sticker) => sticker.id === payload.id,
                          )
                        : undefined;
                    const rendered = entry
                      ? stickerSvgElement(entry.svg)
                      : null;
                    return rendered ? (
                      <span className="flex size-24 items-center justify-center">
                        {rendered}
                      </span>
                    ) : (
                      <span className="text-sm text-muted-foreground">
                        {stickerFallback ?? payload.alt}
                      </span>
                    );
                  })()
                ) : payload.t === "gif" ? (
                  <CommunityGifAttachment
                    communityId={communityId}
                    attachment={payload.attachment}
                  />
                ) : payload.t === "file" ? (
                  <CommunityFileAttachment
                    communityId={communityId}
                    attachment={payload.attachment}
                  />
                ) : null}

                <span className="flex flex-wrap items-center gap-1">
                  {chips.map((chip) => (
                    <Button
                      key={chip.emoji}
                      type="button"
                      size="sm"
                      variant={chip.mine ? "secondary" : "outline"}
                      className="h-7 gap-1 px-2 text-xs"
                      aria-label={`${chip.emoji}, ${chip.count} ${
                        chip.count === 1 ? "reaction" : "reactions"
                      }${chip.mine ? ", including yours" : ""}. ${
                        chip.mine ? "Remove" : "Add"
                      } your reaction`}
                      onClick={() =>
                        onToggleReaction(message.id, chip.emoji, chip.mine)
                      }
                    >
                      <span aria-hidden="true">{chip.emoji}</span>
                      {chip.count}
                    </Button>
                  ))}
                  <AddReactionButton
                    disabled={message.undecryptable}
                    onPick={(emoji) => onToggleReaction(message.id, emoji, false)}
                  />
                </span>

                {!message.isOwn && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-6 self-start px-2 text-xs text-muted-foreground"
                        aria-label="Message actions"
                      >
                        <MoreHorizontal aria-hidden="true" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => setReportTarget(message)}>
                        Report message
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {reportTarget && (
        <CommunityReportDialog
          communityId={communityId}
          message={reportTarget}
          onOpenChange={(open) => {
            if (!open) setReportTarget(null);
          }}
        />
      )}
    </section>
  );
}
