"use client";

import { Track } from "livekit-client";
import {
  VideoTrack,
  isTrackReference,
  useLocalParticipant,
  useTracks,
  type TrackReferenceOrPlaceholder,
} from "@livekit/components-react";

import { MeetingTile } from "./meeting-tile";

function isLiveShare(trackRef: TrackReferenceOrPlaceholder): boolean {
  return (
    trackRef.source === Track.Source.ScreenShare &&
    isTrackReference(trackRef) &&
    trackRef.publication !== undefined &&
    !trackRef.publication.isMuted
  );
}

/**
 * The meeting stage's video surface. Every tile comes from `useTracks` — the
 * participants LiveKit actually reports for this room. With a screen share in
 * progress the share takes the focus position (Meet-style) and cameras move to
 * a strip below; otherwise cameras fill a responsive grid.
 */
export function MeetingGrid() {
  const tracks = useTracks([
    { source: Track.Source.Camera, withPlaceholder: true },
    { source: Track.Source.ScreenShare, withPlaceholder: false },
  ]);
  const { localParticipant } = useLocalParticipant();

  const share = tracks.find(isLiveShare);
  const cameras = tracks.filter(
    (track) => track.source === Track.Source.Camera,
  );

  const cameraTiles = cameras.map((trackRef) => (
    <MeetingTile
      key={`${trackRef.participant.identity}-camera`}
      trackRef={trackRef}
      isLocal={trackRef.participant.identity === localParticipant.identity}
    />
  ));

  if (share && isTrackReference(share)) {
    const sharingName =
      share.participant.name || share.participant.identity.slice(0, 8);
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3">
        <div
          role="group"
          aria-label={`${sharingName}'s shared screen`}
          className="relative min-h-48 flex-1 overflow-hidden rounded-xl border bg-black"
        >
          <VideoTrack trackRef={share} className="h-full w-full object-contain" />
          <span className="absolute left-3 top-3 rounded bg-black/60 px-2 py-1 text-xs font-medium text-white">
            {sharingName} is sharing their screen
          </span>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
          {cameraTiles}
        </div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {cameraTiles}
    </div>
  );
}
