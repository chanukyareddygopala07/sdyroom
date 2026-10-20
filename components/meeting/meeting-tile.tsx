"use client";

import { Track } from "livekit-client";
import {
  VideoTrack,
  isTrackReference,
  useConnectionQualityIndicator,
  useIsSpeaking,
  type TrackReferenceOrPlaceholder,
} from "@livekit/components-react";
import { CameraOff, MicOff } from "lucide-react";

import { cn } from "@/lib/utils";

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((part) => part.charAt(0).toUpperCase()).join("") || "?";
}

function qualityLabel(quality: string): string {
  switch (quality) {
    case "excellent":
      return "Excellent connection";
    case "good":
      return "Good connection";
    case "poor":
      return "Poor connection";
    default:
      return "Connection lost";
  }
}

/**
 * One real participant's video tile. Placeholders are shown only for a
 * participant who is actually connected but has their camera off (or has not
 * published one yet) — never for members who are not in the meeting.
 *
 * All hooks take the participant explicitly, so no layout context is needed.
 */
export function MeetingTile({
  trackRef,
  isLocal,
}: {
  trackRef: TrackReferenceOrPlaceholder;
  isLocal: boolean;
}) {
  const participant = trackRef.participant;
  const speaking = useIsSpeaking(participant);
  const { quality } = useConnectionQualityIndicator({ participant });

  const name = participant.name || participant.identity.slice(0, 8);
  const displayName = isLocal ? `${name} (you)` : name;

  const microphone = participant.getTrackPublication(Track.Source.Microphone);
  const micMuted = microphone === undefined || microphone.isMuted;

  // Placeholders (camera never published, or muted) render initials instead
  // of a video element; `VideoTrack` needs a real publication to subscribe.
  const liveCamera =
    isTrackReference(trackRef) && !trackRef.publication.isMuted
      ? trackRef
      : null;
  const cameraOff = liveCamera === null;

  return (
    <div
      role="group"
      aria-label={`${displayName}, ${
        micMuted ? "microphone muted" : "microphone on"
      }, ${cameraOff ? "camera off" : "camera on"}`}
      className={cn(
        "relative aspect-video min-h-32 overflow-hidden rounded-xl border bg-surface-2",
        speaking && "ring-2 ring-primary",
      )}
    >
      {liveCamera ? (
        <VideoTrack
          trackRef={liveCamera}
          className="h-full w-full object-cover"
        />
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-muted-foreground">
          <span
            aria-hidden="true"
            className="flex h-12 w-12 items-center justify-center rounded-full bg-accent text-sm font-semibold text-foreground"
          >
            {initialsOf(participant.name || participant.identity)}
          </span>
          <span className="flex items-center gap-1 text-xs">
            <CameraOff aria-hidden="true" className="size-3.5" />
            Camera off
          </span>
        </div>
      )}

      <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-gradient-to-t from-black/70 to-transparent px-3 py-2">
        <span className="truncate text-xs font-medium text-white">
          {displayName}
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          {micMuted ? (
            <span className="flex items-center gap-1 rounded bg-black/50 px-1.5 py-0.5 text-white">
              <MicOff aria-hidden="true" className="size-3.5" />
              <span className="sr-only">Microphone muted</span>
            </span>
          ) : null}
          <span
            className={cn(
              "size-2 rounded-full",
              quality === "excellent" || quality === "good"
                ? "bg-success"
                : quality === "poor"
                  ? "bg-warning"
                  : "bg-error",
            )}
          >
            <span className="sr-only">{qualityLabel(quality)}</span>
          </span>
        </span>
      </div>
    </div>
  );
}
