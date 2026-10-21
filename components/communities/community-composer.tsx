"use client";

import {
  COMPOSER_EMOJIS,
  communityApiErrorMessage,
  cssUrl,
  isGifUnavailable,
  stickerSvgElement,
  useStickers,
  type StickerEntry,
} from "@/components/communities/_shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  communityAttachmentPath,
  encryptAttachment,
  readAttachmentFile,
} from "@/lib/crypto/attachment";
import {
  createAttachmentClient,
  gifFetchClient,
  gifSearchClient,
  uploadAttachmentBytes,
  type GifResult,
} from "@/lib/communities/api";
import type { CommunityPayload } from "@/lib/communities/payload";
import { createClient } from "@/lib/supabase/client";
import { Film, Paperclip, Search, Send, Smile, Sticker } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/** Ceiling mirrored from the bucket: 10 MB per attachment. */
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** Client-side cap on a draft; the wire limit is the encrypted envelope. */
const DRAFT_MAX_LENGTH = 4000;

type Panel = "emoji" | "sticker" | "gif" | "file";

const PANEL_BUTTONS: Array<{
  panel: Panel;
  label: string;
  icon: typeof Smile;
}> = [
  { panel: "emoji", label: "Emoji", icon: Smile },
  { panel: "sticker", label: "Stickers", icon: Sticker },
  { panel: "gif", label: "GIFs", icon: Film },
  { panel: "file", label: "Attach a file", icon: Paperclip },
];

/**
 * One availability probe per page session: the GIF tab only exists when the
 * server actually proxies a provider. A `gif_unavailable` answer (no
 * provider configured) hides the tab for good; other failures keep it, since
 * they are transient and the search itself reports them.
 */
let gifAvailability: Promise<boolean> | null = null;

function probeGifAvailability(): Promise<boolean> {
  gifAvailability ??= gifSearchClient("study").then(
    () => true,
    (error: unknown) => !isGifUnavailable(error),
  );
  return gifAvailability;
}

/**
 * The community channel composer: text (Enter sends, Shift+Enter breaks the
 * line), plus emoji, sticker, GIF and file pickers. Everything it emits is
 * already encrypted at the edge: text and stickers travel inside the MLS
 * envelope directly; GIFs and files are encrypted in this browser, uploaded
 * as ciphertext, and referenced by an attachment row whose key and IV ride
 * inside the same envelope.
 *
 * The component owns no message state — `onSend` hands the payload to the
 * workspace pipeline and a refusal surfaces here as inline copy.
 */
export function CommunityComposer({
  communityId,
  channelId,
  canSend,
  error = null,
  onSend,
}: {
  communityId: string;
  channelId: string;
  /** False while the channel is still syncing or a send is in flight. */
  canSend: boolean;
  /** Workspace-level failure (sync/send), rendered inline. */
  error?: string | null;
  onSend: (payload: CommunityPayload) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const [panel, setPanel] = useState<Panel | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [gifEnabled, setGifEnabled] = useState<boolean | null>(null);
  const [gifQuery, setGifQuery] = useState("");
  const [gifStatus, setGifStatus] = useState<
    "idle" | "searching" | "ready" | "error"
  >("idle");
  const [gifResults, setGifResults] = useState<GifResult[]>([]);
  const [gifError, setGifError] = useState<string | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const stickers = useStickers();

  // The tab decision needs one search; it runs once per page session.
  useEffect(() => {
    let disposed = false;
    void probeGifAvailability().then((available) => {
      if (!disposed) setGifEnabled(available);
    });
    return () => {
      disposed = true;
    };
  }, []);

  const disabled = !canSend || busy;

  const togglePanel = (next: Panel) => {
    setActionError(null);
    setPanel((current) => (current === next ? null : next));
  };

  const sendDraft = async () => {
    const body = draft.trim();
    if (body === "" || disabled) return;
    setActionError(null);
    setDraft("");
    try {
      await onSend({ v: 1, t: "text", body });
    } catch (caught) {
      // A refused send hands the text back so nothing typed is lost.
      setActionError(
        communityApiErrorMessage(caught, "That message could not be sent."),
      );
      setDraft((current) => (current === "" ? body : current));
    }
  };

  const insertEmoji = (emoji: string) => {
    const element = textareaRef.current;
    const start = element?.selectionStart ?? draft.length;
    const end = element?.selectionEnd ?? draft.length;
    setDraft(draft.slice(0, start) + emoji + draft.slice(end));
    window.requestAnimationFrame(() => {
      const target = textareaRef.current;
      if (!target) return;
      target.focus();
      const caret = start + emoji.length;
      target.selectionStart = caret;
      target.selectionEnd = caret;
    });
  };

  const sendSticker = (sticker: StickerEntry, pack: string) => {
    if (disabled) return;
    setPanel(null);
    void onSend({
      v: 1,
      t: "sticker",
      pack,
      id: sticker.id,
      alt: sticker.alt,
    }).catch((caught: unknown) => {
      setActionError(
        communityApiErrorMessage(caught, "That sticker could not be sent."),
      );
    });
  };

  const sendAttachment = async (
    bytes: Uint8Array,
    mime: string,
    name: string,
    kind: "gif" | "file",
  ): Promise<void> => {
    setBusy(true);
    setActionError(null);
    try {
      const encrypted = await encryptAttachment(bytes);
      const { storagePath } = communityAttachmentPath(communityId, channelId);
      const supabase = createClient();
      await uploadAttachmentBytes(supabase, storagePath, encrypted.ciphertext);
      const { attachment } = await createAttachmentClient(communityId, {
        channelId,
        storagePath,
        ciphertextSize: encrypted.size,
        contentType: "application/octet-stream",
      });
      await onSend({
        v: 1,
        t: kind,
        attachment: {
          attachmentId: attachment.id,
          keyB64: encrypted.keyB64,
          ivB64: encrypted.ivB64,
          name,
          mime,
          size: encrypted.size,
        },
      });
      setPanel(null);
    } catch (caught) {
      setActionError(
        communityApiErrorMessage(
          caught,
          kind === "gif"
            ? "That GIF could not be sent."
            : "That file could not be sent.",
        ),
      );
    } finally {
      setBusy(false);
    }
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Clearing the input means the same file can be re-selected after a fix.
    event.target.value = "";
    if (!file || disabled) return;
    void readAttachmentFile(file, MAX_ATTACHMENT_BYTES)
      .then((bytes) =>
        sendAttachment(
          bytes,
          file.type || "application/octet-stream",
          file.name,
          "file",
        ),
      )
      .catch((caught: unknown) => {
        setActionError(
          communityApiErrorMessage(caught, "That file could not be read."),
        );
      });
  };

  const runGifSearch = async (query: string) => {
    const trimmed = query.trim();
    if (trimmed === "" || busy) return;
    setGifStatus("searching");
    setGifError(null);
    try {
      const { gifs } = await gifSearchClient(trimmed);
      setGifResults(gifs);
      setGifStatus("ready");
    } catch (caught) {
      if (isGifUnavailable(caught)) {
        setGifEnabled(false);
        setPanel(null);
        return;
      }
      setGifStatus("error");
      setGifError(communityApiErrorMessage(caught, "GIFs could not be loaded."));
    }
  };

  const pickGif = (gif: GifResult) => {
    if (disabled) return;
    setBusy(true);
    setActionError(null);
    gifFetchClient(gif.full_url)
      .then((bytes) => sendAttachment(bytes, "image/gif", "gif", "gif"))
      .catch((caught: unknown) => {
        setBusy(false);
        setActionError(
          communityApiErrorMessage(caught, "That GIF could not be sent."),
        );
      });
  };

  return (
    <section
      className="flex flex-col gap-3 rounded-xl border p-4"
      aria-label="Message composer"
    >
      {error && (
        <p role="alert" className="text-sm text-error">
          {error}
        </p>
      )}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void sendDraft();
        }}
        className="flex flex-col gap-2"
      >
        <div className="flex flex-wrap items-end gap-2">
          <Textarea
            ref={textareaRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key !== "Enter" ||
                event.shiftKey ||
                event.nativeEvent.isComposing
              ) {
                return;
              }
              event.preventDefault();
              void sendDraft();
            }}
            aria-label="Message"
            placeholder={
              canSend
                ? "Message the channel…"
                : "Messages are unavailable right now"
            }
            maxLength={DRAFT_MAX_LENGTH}
            disabled={disabled}
            className="min-h-16 min-w-full flex-1 resize-y sm:min-w-44"
          />
          <Button type="submit" disabled={disabled || draft.trim() === ""}>
            <Send aria-hidden="true" />
            Send
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-1">
          {PANEL_BUTTONS.map(({ panel: value, label, icon: Icon }) => {
            if (value === "gif" && gifEnabled !== true) return null;
            return (
              <Button
                key={value}
                type="button"
                size="sm"
                variant="ghost"
                aria-label={label}
                aria-expanded={panel === value}
                aria-controls="community-composer-panel"
                disabled={busy}
                onClick={() => togglePanel(value)}
              >
                <Icon aria-hidden="true" />
                {label}
              </Button>
            );
          })}
          <span className="ml-auto text-xs text-muted-foreground">
            Enter to send, Shift + Enter for a new line
          </span>
        </div>
      </form>

      <div
        id="community-composer-panel"
        hidden={panel === null}
        className="flex flex-col gap-3 border-t pt-3"
      >
        {panel === "emoji" && (
          <div
            role="group"
            aria-label="Emoji"
            className="grid grid-cols-8 gap-1"
          >
            {COMPOSER_EMOJIS.map((emoji) => (
              <Button
                key={emoji}
                type="button"
                variant="ghost"
                size="sm"
                className="h-9 px-0 text-lg"
                aria-label={`Insert ${emoji}`}
                disabled={disabled}
                onClick={() => insertEmoji(emoji)}
              >
                {emoji}
              </Button>
            ))}
          </div>
        )}

        {panel === "sticker" && (
          <div
            role="group"
            aria-label="Stickers"
            className="grid grid-cols-4 gap-2 sm:grid-cols-8"
          >
            {(stickers?.stickers ?? []).map((sticker) => {
              const rendered = stickerSvgElement(sticker.svg);
              return (
                <Button
                  key={sticker.id}
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-16 flex-col gap-1"
                  aria-label={sticker.alt}
                  disabled={disabled}
                  onClick={() =>
                    sendSticker(sticker, stickers?.pack ?? "sdyroom-basic")
                  }
                >
                  {rendered ?? (
                    <span className="text-xs text-muted-foreground">
                      {sticker.alt}
                    </span>
                  )}
                </Button>
              );
            })}
            {stickers === null && (
              <p className="col-span-full text-sm text-muted-foreground">
                Loading stickers…
              </p>
            )}
          </div>
        )}

        {panel === "gif" && gifEnabled === true && (
          <div className="flex flex-col gap-3">
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void runGifSearch(gifQuery);
              }}
              className="flex flex-wrap items-end gap-2"
            >
              <div className="flex min-w-48 flex-1 flex-col gap-1.5">
                <Label htmlFor="community-gif-search">Search GIFs</Label>
                <Input
                  id="community-gif-search"
                  value={gifQuery}
                  onChange={(event) => setGifQuery(event.target.value)}
                  placeholder="good luck"
                  maxLength={60}
                  disabled={busy}
                />
              </div>
              <Button
                type="submit"
                variant="outline"
                disabled={busy || gifQuery.trim() === ""}
                aria-busy={gifStatus === "searching"}
              >
                <Search aria-hidden="true" />
                {gifStatus === "searching" ? "Searching…" : "Search"}
              </Button>
            </form>

            {gifError && (
              <p role="alert" className="text-sm text-error">
                {gifError}
              </p>
            )}

            {gifStatus === "ready" && gifResults.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No GIFs matched that search.
              </p>
            )}

            {gifResults.length > 0 && (
              <ul
                aria-label="GIF results"
                className="grid max-h-56 grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-4"
              >
                {gifResults.map((gif) => (
                  <li key={gif.id}>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-auto w-full p-1"
                      aria-label="Send this GIF"
                      disabled={disabled}
                      onClick={() => pickGif(gif)}
                    >
                      {/* Rendered as a CSS background, not <img>: the repo's
                          lint gate bans raw <img>, and the proxied preview is
                          decorative — the button carries the accessible
                          name. */}
                      <span
                        aria-hidden="true"
                        className="block h-20 w-full rounded bg-cover bg-center"
                        style={{ backgroundImage: cssUrl(gif.preview_url) }}
                      />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {panel === "file" && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="community-file-input">Attach a file</Label>
            <Input
              id="community-file-input"
              type="file"
              onChange={handleFileChange}
              disabled={disabled}
              aria-describedby="community-file-hint"
            />
            <p
              id="community-file-hint"
              className="text-xs text-muted-foreground"
            >
              Up to 10 MB. The file is encrypted on this device before it is
              uploaded — the server only ever stores ciphertext.
            </p>
          </div>
        )}
      </div>

      {actionError && (
        <p role="alert" className="text-sm text-error">
          {actionError}
        </p>
      )}
    </section>
  );
}
