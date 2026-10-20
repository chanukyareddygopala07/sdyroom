"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { Track } from "livekit-client";
import {
  useMediaDeviceSelect,
  useTrackToggle,
} from "@livekit/components-react";
import {
  Camera,
  CameraOff,
  Maximize2,
  Mic,
  MicOff,
  Minimize2,
  MonitorUp,
  Settings2,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";

const subscribeNoop = () => () => {};

type DeviceSelect = {
  devices: MediaDeviceInfo[];
  activeDeviceId: string;
  setActiveMediaDevice: (id: string) => Promise<void>;
};

function DeviceGroup({ label, select }: { label: string; select: DeviceSelect }) {
  if (select.devices.length === 0) {
    return null;
  }
  const listId = `meeting-device-${label.toLowerCase().replace(/\s+/g, "-")}`;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={listId} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      <select
        id={listId}
        className="h-11 rounded-md border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        value={select.activeDeviceId}
        disabled={select.devices.length < 2}
        onChange={(event) => {
          void select.setActiveMediaDevice(event.target.value);
        }}
      >
        {select.devices.map((device, index) => (
          <option key={device.deviceId || index} value={device.deviceId}>
            {device.label || `Device ${index + 1}`}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * The meeting's control bar: microphone, camera, screen share, device
 * selection, full screen and leave. Built on the official LiveKit toggles
 * (so all state changes go through the SDK) but styled with SdyRoom tokens.
 *
 * The microphone control is disabled — and says why — when the server issued
 * the token without a microphone grant (an active room mute), rather than
 * letting a click fail silently against the provider.
 */
export function MeetingControls({
  canPublishMic,
  onLeave,
  onDeviceError,
  fullscreenTarget,
}: {
  canPublishMic: boolean;
  onLeave: () => void;
  onDeviceError: (error: Error) => void;
  fullscreenTarget: () => HTMLElement | null;
}) {
  const microphone = useTrackToggle({
    source: Track.Source.Microphone,
    onDeviceError,
  });
  const camera = useTrackToggle({
    source: Track.Source.Camera,
    onDeviceError,
  });
  const screen = useTrackToggle({
    source: Track.Source.ScreenShare,
    onDeviceError,
  });

  // The token response is authoritative: when a room mute silenced the
  // caller, the server dropped the microphone from the token's publish
  // sources, so toggling here would fail silently against LiveKit anyway.
  const microphoneAllowed = canPublishMic;

  const microphoneSelect = useMediaDeviceSelect({ kind: "audioinput" });
  const cameraSelect = useMediaDeviceSelect({ kind: "videoinput" });
  const speakerSelect = useMediaDeviceSelect({ kind: "audiooutput" });

  const [devicesOpen, setDevicesOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // Feature detection through the external-store snapshot (same pattern as
  // theme-switcher): no effect, and no hydration mismatch between the SSR
  // pass (no document) and the client.
  const fullscreenSupported = useSyncExternalStore(
    subscribeNoop,
    () =>
      typeof document !== "undefined" &&
      typeof document.documentElement.requestFullscreen === "function",
    () => false,
  );

  useEffect(() => {
    if (typeof document === "undefined") return;
    const onChange = () => setIsFullscreen(document.fullscreenElement !== null);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleFullscreen = () => {
    const target = fullscreenTarget();
    if (!target) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
      return;
    }
    void target.requestFullscreen().catch(() => undefined);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-center gap-2 sm:justify-between">
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button
            type="button"
            size="sm"
            variant={microphone.enabled ? "secondary" : "destructive"}
            disabled={microphone.pending || !microphoneAllowed}
            title={
              microphoneAllowed
                ? undefined
                : "A room moderator muted your microphone for this meeting."
            }
            onClick={() => void microphone.toggle()}
          >
            {microphone.enabled ? (
              <Mic aria-hidden="true" />
            ) : (
              <MicOff aria-hidden="true" />
            )}
            {microphone.enabled ? "Mute microphone" : "Unmute microphone"}
          </Button>

          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={camera.pending}
            onClick={() => void camera.toggle()}
          >
            {camera.enabled ? (
              <Camera aria-hidden="true" />
            ) : (
              <CameraOff aria-hidden="true" />
            )}
            {camera.enabled ? "Turn camera off" : "Turn camera on"}
          </Button>

          <Button
            type="button"
            size="sm"
            variant={screen.enabled ? "default" : "secondary"}
            disabled={screen.pending}
            onClick={() => void screen.toggle()}
          >
            <MonitorUp aria-hidden="true" />
            {screen.enabled ? "Stop sharing" : "Share screen"}
          </Button>

          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-expanded={devicesOpen}
            aria-controls="meeting-device-panel"
            onClick={() => setDevicesOpen((open) => !open)}
          >
            <Settings2 aria-hidden="true" />
            Devices
          </Button>
        </div>

        <div className="flex items-center justify-center gap-2">
          {fullscreenSupported ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={toggleFullscreen}
            >
              {isFullscreen ? (
                <Minimize2 aria-hidden="true" />
              ) : (
                <Maximize2 aria-hidden="true" />
              )}
              {isFullscreen ? "Exit full screen" : "Full screen"}
            </Button>
          ) : null}

          <Button type="button" size="sm" variant="destructive" onClick={onLeave}>
            <X aria-hidden="true" />
            Leave meeting
          </Button>
        </div>
      </div>

      {microphoneAllowed ? null : (
        <p role="status" className="text-center text-xs text-warning">
          A room moderator muted your microphone — you can still watch, share
          your screen and use chat.
        </p>
      )}

      <div
        id="meeting-device-panel"
        hidden={!devicesOpen}
        className="grid gap-3 rounded-xl border bg-card p-4 sm:grid-cols-3"
      >
        <DeviceGroup label="Microphone" select={microphoneSelect} />
        <DeviceGroup label="Camera" select={cameraSelect} />
        <DeviceGroup label="Speaker" select={speakerSelect} />
        {microphoneSelect.devices.length === 0 &&
        cameraSelect.devices.length === 0 &&
        speakerSelect.devices.length === 0 ? (
          <p className="text-sm text-muted-foreground sm:col-span-3">
            No devices were reported by this browser. You can still watch and
            use chat.
          </p>
        ) : null}
      </div>
    </div>
  );
}
