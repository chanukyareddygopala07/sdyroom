"use client";

import { useRef, useState } from "react";
import { DisconnectReason, MediaDeviceFailure } from "livekit-client";
import {
  LiveKitRoom,
  RoomAudioRenderer,
  StartAudio,
  useConnectionState,
  useParticipants,
} from "@livekit/components-react";

import { MeetingControls } from "./meeting-controls";
import { MeetingGrid } from "./meeting-grid";

function deviceFailureMessage(
  failure: MediaDeviceFailure | undefined,
): string {
  switch (failure) {
    case MediaDeviceFailure.PermissionDenied:
      return "Your browser blocked camera or microphone access. Allow it in the address bar, then try again.";
    case MediaDeviceFailure.NotFound:
      return "No camera or microphone was found on this device.";
    case MediaDeviceFailure.DeviceInUse:
      return "Another app is using your camera or microphone.";
    default:
      return "We couldn't start your camera or microphone.";
  }
}

function disconnectMessage(reason: DisconnectReason | undefined): string {
  switch (reason) {
    case DisconnectReason.DUPLICATE_IDENTITY:
      return "You joined this meeting from another tab or device, so this session closed.";
    case DisconnectReason.PARTICIPANT_REMOVED:
      return "A moderator removed you from the meeting.";
    case DisconnectReason.ROOM_DELETED:
    case DisconnectReason.SERVER_SHUTDOWN:
      return "The meeting ended.";
    default:
      return "The meeting ended or your connection dropped. You can rejoin.";
  }
}

function MeetingRoomInner({
  canPublishMic,
  onDeviceError,
  onLeave,
  fullscreenTarget,
}: {
  canPublishMic: boolean;
  onDeviceError: (error: Error) => void;
  onLeave: () => void;
  fullscreenTarget: () => HTMLElement | null;
}) {
  const participants = useParticipants();
  const connection = useConnectionState();

  const statusText =
    connection === "connected"
      ? `${participants.length} in the meeting`
      : connection === "reconnecting" || connection === "signalReconnecting"
        ? "Reconnecting…"
        : "Connecting…";

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Live meeting</h2>
          <p role="status" className="text-xs text-muted-foreground">
            {statusText}
          </p>
        </div>
        {/* Chrome blocks audio until a gesture; this button is rendered by
            LiveKit only while that block is active. */}
        <StartAudio
          label="Allow audio"
          className="h-10 rounded-md border border-input bg-secondary px-3 text-sm font-medium text-secondary-foreground hover:bg-secondary/80 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
        />
      </div>

      <div className="flex min-h-0 flex-1 flex-col justify-center">
        <MeetingGrid />
      </div>

      <MeetingControls
        canPublishMic={canPublishMic}
        onLeave={onLeave}
        onDeviceError={onDeviceError}
        fullscreenTarget={fullscreenTarget}
      />

      <RoomAudioRenderer />
    </>
  );
}

/**
 * The connected meeting surface: a `LiveKitRoom` with SdyRoom-styled tiles
 * and controls. The component owns device-failure notices for the duration
 * of the call; connection-level outcomes are reported back to the stage so
 * the whole view can return to the join card (unexpected disconnects) or
 * show an error (failed connect). Leaving — through the controls or the
 * browser — unmounts this tree, and the SDK stops every local track on its
 * way out, so the camera light goes off with the meeting.
 */
export function MeetingRoomView({
  url,
  token,
  canPublishMic,
  onConnected,
  onDisconnected,
  onError,
  onLeave,
}: {
  url: string;
  token: string;
  canPublishMic: boolean;
  onConnected: () => void;
  onDisconnected: (message: string) => void;
  onError: (message: string) => void;
  onLeave: () => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [deviceNotice, setDeviceNotice] = useState<string | null>(null);

  return (
    <LiveKitRoom
      ref={rootRef}
      serverUrl={url}
      token={token}
      connect
      audio={canPublishMic}
      onConnected={onConnected}
      onDisconnected={(reason) => onDisconnected(disconnectMessage(reason))}
      onError={(error) =>
        onError(`We couldn't connect to the meeting (${error.message}).`)
      }
      onMediaDeviceFailure={(failure) =>
        setDeviceNotice(deviceFailureMessage(failure))
      }
      className="flex min-h-0 flex-1 flex-col gap-4 [&:fullscreen]:h-screen [&:fullscreen]:bg-background [&:fullscreen]:p-6"
    >
      {deviceNotice ? (
        <p
          role="alert"
          className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-foreground"
        >
          {deviceNotice}
        </p>
      ) : null}
      <MeetingRoomInner
        canPublishMic={canPublishMic}
        onDeviceError={(error) =>
          setDeviceNotice(
            `We couldn't switch devices (${error.message}). Check that the device exists and your browser allows access.`,
          )
        }
        onLeave={onLeave}
        fullscreenTarget={() => rootRef.current}
      />
    </LiveKitRoom>
  );
}
